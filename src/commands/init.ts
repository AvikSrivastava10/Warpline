import path from 'node:path';
import { WarplineError } from '../core/errors.js';
import { writeFileAtomic } from '../core/fsx.js';
import { out, theme, glyph } from '../core/ui.js';
import { tildify } from '../core/paths.js';
import { isInteractive, promptConfirm, promptMultiSelect, promptText } from '../core/prompt.js';
import { flagBool, flagString, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { configExistsIn, PRIMARY_CONFIG_FILENAME } from '../config/load.js';
import { detectProject, type ProcessCandidate } from '../detect/candidates.js';
import { upsertProject } from '../state/registry.js';

export const initFlags: FlagSpecs = {
  name: { type: 'string', alias: 'n', describe: 'Project name to register (defaults to the folder or package name)' },
  yes: { type: 'boolean', alias: 'y', describe: 'Accept detected defaults without prompting' },
  force: { type: 'boolean', alias: 'f', describe: 'Overwrite an existing warpline.yml' },
  print: { type: 'boolean', describe: 'Print the generated config to stdout instead of writing it' },
  all: { type: 'boolean', alias: 'a', describe: 'Include every detected candidate, not just the recommended ones' },
};

export function initHelp(): string {
  return [
    `${theme.bold('warpline init')} ${theme.dim('[options]')}`,
    '',
    'Inspects the current directory and writes a warpline.yml describing how to',
    'start it: dev processes, ports, readiness checks, and env files.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(initFlags),
  ].join('\n');
}

/** Quotes a scalar only when YAML would otherwise misread it. */
function yamlScalar(value: string): string {
  const needsQuotes =
    value.length === 0 ||
    /^[\s]|[\s]$/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s|\s#/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[\d.+-]+$/.test(value);

  if (!needsQuotes) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderProcess(candidate: ProcessCandidate, needs: string[]): string[] {
  const lines: string[] = [`  ${candidate.id}:`];
  lines.push(`    command: ${yamlScalar(candidate.command)}`);

  if (candidate.cwd) lines.push(`    cwd: ${yamlScalar(candidate.cwd)}`);
  if (candidate.kind === 'task') lines.push('    kind: task');
  if (needs.length > 0) lines.push(`    needs: [${needs.join(', ')}]`);

  if (candidate.port !== undefined) {
    lines.push(`    port: ${candidate.port}`);
    lines.push(`    ready: { port: ${candidate.port} }`);
  } else if (candidate.readyLog) {
    lines.push(`    ready: { log: ${yamlScalar(candidate.readyLog)} }`);
  }

  return lines;
}

function buildConfigText(input: {
  name: string;
  selected: ProcessCandidate[];
  envFiles: string[];
  requiredKeys: string[];
  detectedFramework: string | undefined;
}): string {
  const { name, selected, envFiles, requiredKeys } = input;

  // Datastores must be up before anything that talks to them. Compose-sourced
  // candidates are the datastores, so everything else gets wired to depend on
  // them: this is the ordering people otherwise hand-roll with sleeps.
  const datastoreIds = selected.filter((candidate) => candidate.source === 'compose').map((c) => c.id);

  const lines: string[] = [
    '# warpline.yml - how to start this project.',
    '# Commit this file: it travels with the repo so teammates get the same setup.',
    '# Docs: https://github.com/warpline-dev/warpline#configuration',
    '',
    `name: ${yamlScalar(name)}`,
  ];

  if (input.detectedFramework) {
    lines.push('');
    lines.push(`# Detected: ${input.detectedFramework}`);
  }

  if (envFiles.length > 0 || requiredKeys.length > 0) {
    lines.push('');
    lines.push('env:');
    if (envFiles.length > 0) {
      lines.push('  # Loaded in order, later files win. Values are never copied into');
      lines.push('  # warpline state - only these paths are remembered.');
      lines.push(`  files: [${envFiles.map(yamlScalar).join(', ')}]`);
    }
    if (requiredKeys.length > 0) {
      lines.push('  # From .env.example. `warpline up` refuses to start if any are empty.');
      lines.push('  require:');
      for (const key of requiredKeys) lines.push(`    - ${key}`);
    }
  }

  lines.push('');
  lines.push('processes:');

  if (selected.length === 0) {
    lines.push('  # Nothing was detected automatically. Describe your dev processes here:');
    lines.push('  # web:');
    lines.push('  #   command: npm run dev');
    lines.push('  #   port: 3000');
    lines.push('  #   ready: { port: 3000 }');
  }

  for (const candidate of selected) {
    const needs = candidate.source === 'compose' ? [] : datastoreIds.filter((id) => id !== candidate.id);
    lines.push(...renderProcess(candidate, needs));
    lines.push('');
  }

  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

export async function runInit(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, initFlags);
  const cwd = process.cwd();
  const nonInteractive = flagBool(parsed, 'yes') || !isInteractive();

  const existing = configExistsIn(cwd);
  if (existing && !flagBool(parsed, 'force') && !flagBool(parsed, 'print')) {
    throw new WarplineError(`${path.basename(existing)} already exists in this directory`, {
      hint: 'Edit it directly, or pass --force to regenerate it.',
    });
  }

  out.note(`${theme.dim('scanning')} ${tildify(cwd)}`);
  const detection = detectProject(cwd);

  const summaryBits: string[] = [];
  if (detection.packageManager) summaryBits.push(detection.packageManager);
  if (detection.framework) summaryBits.push(detection.framework);
  if (detection.workspaces.length > 0) summaryBits.push(`${detection.workspaces.length} workspace packages`);
  if (detection.composeFile) summaryBits.push(detection.composeFile);
  if (summaryBits.length > 0) {
    out.note(`${theme.dim('detected')} ${summaryBits.join(theme.dim(` ${glyph.sep} `))}`);
  }

  const name = flagString(parsed, 'name') ?? (nonInteractive
    ? detection.suggestedName
    : await promptText('Project name', detection.suggestedName));

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new WarplineError(`"${name}" is not a valid project name`, {
      hint: 'Use letters, digits, dots, dashes, and underscores; start with a letter or digit.',
    });
  }

  let selected: ProcessCandidate[];
  const candidates = detection.candidates;

  if (candidates.length === 0) {
    out.warn('No dev processes detected. Writing a starter config for you to fill in.');
    selected = [];
  } else if (nonInteractive || flagBool(parsed, 'all')) {
    selected = flagBool(parsed, 'all') ? candidates : candidates.filter((candidate) => candidate.recommended);
    if (selected.length === 0) selected = candidates.slice(0, 1);
  } else {
    const defaults = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.recommended)
      .map(({ index }) => index);

    selected = await promptMultiSelect(
      'Which processes should `warpline up` start?',
      candidates.map((candidate) => ({
        label: `${theme.bold(candidate.id)} ${theme.dim(candidate.command)}`,
        value: candidate,
        hint: candidate.detail,
      })),
      defaults.length > 0 ? defaults : [0],
    );
  }

  const text = buildConfigText({
    name,
    selected,
    envFiles: detection.env.present,
    requiredKeys: detection.env.templateKeys,
    detectedFramework: detection.framework,
  });

  if (flagBool(parsed, 'print')) {
    out.write(text);
    return 0;
  }

  const target = path.join(cwd, PRIMARY_CONFIG_FILENAME);
  writeFileAtomic(target, text);
  out.success(`wrote ${PRIMARY_CONFIG_FILENAME} ${theme.dim(`(${selected.length} process${selected.length === 1 ? '' : 'es'})`)}`);

  await upsertProject(name, cwd);
  out.success(`registered ${theme.bold(theme.accent(name))} ${theme.dim(glyph.arrow)} ${theme.dim(tildify(cwd))}`);

  if (detection.env.templates.length > 0 && detection.env.present.length === 0) {
    out.warn(
      `found ${detection.env.templates[0]} but no .env - copy it before starting (\`cp ${detection.env.templates[0]} .env\`)`,
    );
  }

  out.blank();
  out.note(`Next: ${theme.code(`warpline up ${name}`)}   ${theme.dim(`(or just \`warpline up\` from this folder)`)}`);

  if (!nonInteractive && detection.env.present.length === 0 && detection.env.templates.length === 0) {
    const wantsReview = await promptConfirm('Open the config to review it now?', false);
    if (wantsReview) out.note(`Config is at ${tildify(target)}`);
  }

  return 0;
}
