import fs from 'node:fs';
import path from 'node:path';
import { flagBool, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { glyph, out, theme, truncate } from '../core/ui.js';
import { tildify } from '../core/paths.js';
import { dirExists, fileExists, readTextOrNull } from '../core/fsx.js';
import { resolveEnv, getEnvVar } from '../env/resolve.js';
import { parseDotenv } from '../env/dotenv.js';
import { findDependencyCycle } from '../proc/graph.js';
import { checkPortConflicts } from '../proc/ports.js';
import { detectNodeVersionPin, readPackageJson, scanEnvFiles } from '../detect/project.js';
import { getProject } from '../state/registry.js';
import { inspectRuntime } from '../state/runtime.js';
import { resolveProject } from './context.js';
import type { WarplineConfig } from '../config/types.js';

export const doctorFlags: FlagSpecs = {
  ports: { type: 'boolean', default: true, describe: 'Check whether declared ports are already in use (--no-ports to skip)' },
  strict: { type: 'boolean', alias: 's', describe: 'Treat warnings as failures' },
};

export function doctorHelp(): string {
  return [
    `${theme.bold('warpline doctor')} ${theme.dim('[name] [options]')}`,
    '',
    'Checks everything that commonly breaks a project start: missing directories,',
    'scripts that no longer exist, absent env files and empty required variables,',
    'stale dependencies, a Node version that does not match the project pin, and',
    'ports already in use.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(doctorFlags),
  ].join('\n');
}

type Level = 'ok' | 'warn' | 'fail';

interface Finding {
  level: Level;
  label: string;
  detail: string | undefined;
  hint: string | undefined;
}

class Report {
  readonly findings: Finding[] = [];

  ok(label: string, detail?: string): void {
    this.findings.push({ level: 'ok', label, detail, hint: undefined });
  }
  warn(label: string, detail?: string, hint?: string): void {
    this.findings.push({ level: 'warn', label, detail, hint });
  }
  fail(label: string, detail?: string, hint?: string): void {
    this.findings.push({ level: 'fail', label, detail, hint });
  }

  count(level: Level): number {
    return this.findings.filter((finding) => finding.level === level).length;
  }
}

/** PATH lookup, honouring PATHEXT on Windows. */
function resolveExecutable(name: string, env: Record<string, string>): string | undefined {
  if (name.includes('/') || name.includes('\\')) {
    return fileExists(name) ? name : undefined;
  }

  const pathValue = getEnvVar(env, 'PATH') ?? '';
  const dirs = pathValue.split(path.delimiter).filter((dir) => dir.length > 0);
  const extensions =
    process.platform === 'win32'
      ? (getEnvVar(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (fileExists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Splits `pnpm run dev --flag` into a leading binary and a script name. */
function parseCommandHead(command: string): { binary: string; script: string | undefined } {
  const tokens = command.trim().split(/\s+/);
  const binary = (tokens[0] ?? '').replace(/^["']|["']$/g, '');

  const managers = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno']);
  if (!managers.has(binary)) return { binary, script: undefined };

  // `npm run x` / `pnpm run x` / `yarn x` / `bun run x` / `deno task x`
  let index = 1;
  if (tokens[1] === 'run' || tokens[1] === 'task') index = 2;
  const script = tokens[index];
  if (!script || script.startsWith('-')) return { binary, script: undefined };
  return { binary, script };
}

function checkProcesses(config: WarplineConfig, report: Report, env: Record<string, string>): void {
  for (const proc of config.processes) {
    const where = `processes.${proc.id}`;

    if (!dirExists(proc.cwd)) {
      report.fail(`${where}.cwd`, `${tildify(proc.cwd)} does not exist`, 'Fix the `cwd` value or create the directory.');
      continue;
    }

    const { binary, script } = parseCommandHead(proc.command);

    if (binary.length > 0 && !resolveExecutable(binary, env)) {
      report.warn(
        `${where}.command`,
        `"${binary}" was not found on PATH`,
        binary === 'docker'
          ? 'Install Docker, or start it if it is not running.'
          : `Install ${binary}, or change the command.`,
      );
    }

    if (script) {
      // Package scripts drift constantly. A renamed script is one of the most
      // common reasons a saved config silently stops working.
      const pkg = readPackageJson(proc.cwd) ?? readPackageJson(config.root);
      const scripts = pkg?.scripts ?? {};
      if (pkg && !(script in scripts)) {
        const available = Object.keys(scripts).slice(0, 8).join(', ');
        report.fail(
          `${where}.command`,
          `package script "${script}" no longer exists`,
          available.length > 0 ? `Available scripts: ${available}` : undefined,
        );
      }
    }

    if (proc.ready.kind === 'file' && proc.ready.file) {
      const dir = path.dirname(proc.ready.file);
      if (!dirExists(dir)) {
        report.warn(`${where}.ready.file`, `the parent directory ${tildify(dir)} does not exist yet`);
      }
    }
  }

  const cycle = findDependencyCycle(config.processes);
  if (cycle) {
    report.fail('processes.needs', `circular dependency: ${cycle.join(' -> ')}`, 'Break the cycle by removing one `needs` entry.');
  } else {
    report.ok('dependency graph', `${config.processes.length} process${config.processes.length === 1 ? '' : 'es'}, no cycles`);
  }
}

function checkEnv(config: WarplineConfig, report: Report): void {
  const resolved = resolveEnv(config, undefined);
  const scan = scanEnvFiles(config.root);

  for (const missing of resolved.missingFiles) {
    const template = scan.templates[0];
    report.warn(
      'env.files',
      `${missing} is declared but not present`,
      template ? `Create it, for example: cp ${template} ${missing}` : 'Create it or remove it from env.files.',
    );
  }

  if (resolved.loadedFiles.length > 0) {
    report.ok('env.files', `loaded ${resolved.loadedFiles.join(', ')}`);
  }

  if (resolved.missingRequired.length > 0) {
    report.fail(
      'env.require',
      `empty or unset: ${resolved.missingRequired.join(', ')}`,
      'Set these in an env file before starting.',
    );
  } else if (config.env.require.length > 0) {
    report.ok('env.require', `all ${config.env.require.length} required variables are set`);
  }

  // Template drift: a teammate pulling new required keys is a classic
  // "works on my machine" failure, and it is cheap to detect.
  for (const template of scan.templates) {
    const templateText = readTextOrNull(path.join(config.root, template));
    if (templateText === null) continue;
    const templateKeys = Object.keys(parseDotenv(templateText).map);

    const missing = templateKeys.filter((key) => {
      const value = getEnvVar(resolved.values, key);
      return value === undefined || value.length === 0;
    });

    if (missing.length > 0) {
      report.warn(
        `env (${template})`,
        `${missing.length} key${missing.length === 1 ? '' : 's'} in the template are unset: ${truncate(missing.join(', '), 60)}`,
        'Some may be optional; check the template comments.',
      );
    } else if (templateKeys.length > 0) {
      report.ok(`env (${template})`, `all ${templateKeys.length} template keys are set`);
    }
  }
}

function checkDependencies(config: WarplineConfig, report: Report): void {
  const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock'];
  const roots = new Set([config.root, ...config.processes.map((proc) => proc.cwd)]);

  for (const root of roots) {
    if (!fileExists(path.join(root, 'package.json'))) continue;

    const nodeModules = path.join(root, 'node_modules');
    const relative = path.relative(config.root, root) || '.';

    if (!dirExists(nodeModules)) {
      report.fail(`dependencies (${relative})`, 'node_modules is missing', 'Install dependencies before starting.');
      continue;
    }

    const lockfile = lockfiles.map((file) => path.join(root, file)).find((file) => fileExists(file));
    if (!lockfile) {
      report.ok(`dependencies (${relative})`, 'node_modules present');
      continue;
    }

    try {
      const lockTime = fs.statSync(lockfile).mtimeMs;
      // The install marker inside node_modules is a far better reference point
      // than the directory mtime, which changes for unrelated reasons.
      const markers = ['.package-lock.json', '.modules.yaml', '.yarn-state.yml'].map((file) =>
        path.join(nodeModules, file),
      );
      const marker = markers.find((file) => fileExists(file));
      const installTime = marker ? fs.statSync(marker).mtimeMs : fs.statSync(nodeModules).mtimeMs;

      if (lockTime > installTime + 1000) {
        report.warn(
          `dependencies (${relative})`,
          `${path.basename(lockfile)} is newer than the last install`,
          'Run your package manager\'s install command.',
        );
      } else {
        report.ok(`dependencies (${relative})`, 'up to date with the lockfile');
      }
    } catch {
      report.ok(`dependencies (${relative})`, 'node_modules present');
    }
  }
}

function checkNodeVersion(config: WarplineConfig, report: Report): void {
  const pin = detectNodeVersionPin(config.root);
  if (!pin) return;

  const current = process.versions.node;
  const wantedMajor = /(\d+)/.exec(pin.range)?.[1];
  const currentMajor = current.split('.')[0];

  if (wantedMajor && currentMajor && wantedMajor !== currentMajor) {
    report.warn(
      'node version',
      `${pin.source} asks for ${pin.range}, running ${current}`,
      'Switch with your version manager (nvm/fnm/volta) before starting.',
    );
  } else {
    report.ok('node version', `${current} satisfies ${pin.source} (${pin.range})`);
  }
}

async function checkPorts(config: WarplineConfig, report: Report, projectName: string): Promise<void> {
  const declared = config.processes
    .filter((proc) => proc.ports.length > 0)
    .map((proc) => ({ processId: proc.id, ports: proc.ports }));

  if (declared.length === 0) return;

  // Ports held by this project's own running processes are expected, not a problem.
  const info = inspectRuntime(projectName);
  const ownPids = new Set(info?.live.map((proc) => proc.pid).filter((pid): pid is number => pid !== undefined) ?? []);

  const conflicts = await checkPortConflicts(declared);
  const external = conflicts.filter((conflict) => conflict.pid === undefined || !ownPids.has(conflict.pid));

  if (external.length === 0) {
    const total = declared.reduce((sum, entry) => sum + entry.ports.length, 0);
    report.ok('ports', `${total} declared port${total === 1 ? '' : 's'} available`);
    return;
  }

  for (const conflict of external) {
    const owner = conflict.processName
      ? `${conflict.processName}${conflict.pid ? ` (pid ${conflict.pid})` : ''}`
      : conflict.pid
        ? `pid ${conflict.pid}`
        : 'an unidentified process';
    report.fail(
      `port ${conflict.port}`,
      `needed by ${conflict.processId}, currently held by ${owner}`,
      'Stop it, or start with `warpline up --kill-port`.',
    );
  }
}

function checkRegistration(config: WarplineConfig, projectName: string, report: Report): void {
  const entry = getProject(projectName);
  if (!entry) {
    report.warn(
      'index',
      `"${projectName}" is not in the global index`,
      'Run `warpline link` here so you can start it by name from anywhere.',
    );
    return;
  }
  if (path.resolve(entry.root) !== config.root) {
    report.fail(
      'index',
      `"${projectName}" points at ${tildify(entry.root)} but the config is at ${tildify(config.root)}`,
      `Repair it with \`warpline link ${projectName} --force\`.`,
    );
    return;
  }
  report.ok('index', `"${projectName}" ${glyph.arrow} ${tildify(entry.root)}`);
}

export async function runDoctor(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, doctorFlags);
  const project = await resolveProject(parsed.positionals[0]);
  const { config } = project;

  out.write(`${theme.bold(theme.accent(project.name))} ${theme.dim(tildify(config.configFile))}`);
  out.blank();

  const report = new Report();
  report.ok('config', 'parsed and valid');

  checkRegistration(config, project.name, report);
  const env = resolveEnv(config, undefined).values;
  checkProcesses(config, report, env);
  checkEnv(config, report);
  checkDependencies(config, report);
  checkNodeVersion(config, report);
  if (flagBool(parsed, 'ports')) await checkPorts(config, report, project.name);

  const order: Level[] = ['fail', 'warn', 'ok'];
  for (const level of order) {
    const findings = report.findings.filter((finding) => finding.level === level);
    if (findings.length === 0) continue;

    for (const finding of findings) {
      const marker =
        level === 'ok' ? theme.ok(glyph.ok) : level === 'warn' ? theme.warn(glyph.warn) : theme.err(glyph.fail);
      const detail = finding.detail ? ` ${theme.dim(finding.detail)}` : '';
      out.write(`${marker} ${finding.label}${detail}`);
      if (finding.hint) out.write(`  ${theme.dim(glyph.arrow)} ${theme.dim(finding.hint)}`);
    }
  }

  const fails = report.count('fail');
  const warns = report.count('warn');

  out.blank();
  if (fails === 0 && warns === 0) {
    out.write(`${theme.ok(glyph.ok)} everything looks good - ${theme.code(`warpline up ${project.name}`)}`);
    return 0;
  }

  const parts: string[] = [];
  if (fails > 0) parts.push(theme.err(`${fails} problem${fails === 1 ? '' : 's'}`));
  if (warns > 0) parts.push(theme.warn(`${warns} warning${warns === 1 ? '' : 's'}`));
  out.write(parts.join(theme.dim(` ${glyph.sep} `)));

  if (fails > 0) return 1;
  return flagBool(parsed, 'strict') ? 1 : 0;
}
