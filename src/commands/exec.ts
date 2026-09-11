import { flagBool, flagList, flagString, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { WarplineError } from '../core/errors.js';
import { glyph, out, theme } from '../core/ui.js';
import { tildify } from '../core/paths.js';
import { parseEnvOverrides, resolveEnv } from '../env/resolve.js';
import { runToCompletion } from '../proc/spawn.js';
import { resolveProject } from './context.js';

export const execFlags: FlagSpecs = {
  env: { type: 'list', alias: 'e', describe: 'Extra environment values, as KEY=VALUE' },
  in: { type: 'string', describe: 'Run inside a specific process\'s working directory instead of the project root' },
  quiet: { type: 'boolean', alias: 'q', describe: 'Suppress the header line' },
};

export function execHelp(): string {
  return [
    `${theme.bold('warpline exec')} ${theme.dim('[name] -- <command>')}`,
    '',
    'Runs a one-off command with the project\'s working directory and fully',
    'resolved environment. Useful for the things that are not long-running',
    'processes: migrations, a psql shell, a quick script.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(execFlags),
    '',
    theme.dim('Examples:'),
    `  ${theme.code('warpline exec -- npx prisma migrate dev')}`,
    `  ${theme.code('warpline exec myapp -- npm run seed')}`,
    `  ${theme.code('warpline exec --in api -- npm test')}`,
  ].join('\n');
}

export async function runExec(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, execFlags);

  const command = parsed.passthrough.join(' ').trim();
  if (command.length === 0) {
    throw new WarplineError('No command given', {
      hint: 'Put the command after `--`, for example: warpline exec -- npm run seed',
    });
  }

  const project = await resolveProject(parsed.positionals[0]);
  const { config } = project;

  let cwd = config.root;
  const inProcess = flagString(parsed, 'in');
  if (inProcess) {
    const target = config.processes.find((proc) => proc.id === inProcess);
    if (!target) {
      throw new WarplineError(`No process named "${inProcess}" in this project`, {
        hint: `Available: ${config.processes.map((proc) => proc.id).join(', ')}`,
      });
    }
    cwd = target.cwd;
  }

  const resolved = resolveEnv(config, undefined, { overrides: parseEnvOverrides(flagList(parsed, 'env')) });

  if (resolved.missingRequired.length > 0) {
    out.warn(`missing required env: ${resolved.missingRequired.join(', ')}`);
  }

  if (!flagBool(parsed, 'quiet')) {
    out.note(
      `${theme.dim('in')} ${tildify(cwd)}${
        resolved.loadedFiles.length > 0 ? theme.dim(` ${glyph.sep} env: ${resolved.loadedFiles.join(', ')}`) : ''
      }`,
    );
  }

  const result = await runToCompletion({
    command,
    cwd,
    env: resolved.values,
    onOutput: (chunk) => process.stdout.write(chunk),
  });

  if (result.signal) {
    out.error(`command was killed by ${result.signal}`);
    return 1;
  }
  return result.code ?? 1;
}

export const envFlags: FlagSpecs = {
  reveal: { type: 'boolean', describe: 'Show secret-looking values instead of redacting them' },
  format: { type: 'string', choices: ['table', 'dotenv', 'json', 'shell'], default: 'table', describe: 'Output format' },
  origins: { type: 'boolean', default: true, describe: 'Show where each value came from (--no-origins to hide)' },
  process: { type: 'string', alias: 'p', describe: 'Resolve as a specific process would see it' },
  env: { type: 'list', alias: 'e', describe: 'Extra environment values, as KEY=VALUE' },
};

export function envHelp(): string {
  return [
    `${theme.bold('warpline env')} ${theme.dim('[name] [options]')}`,
    '',
    'Shows the environment a process would actually receive, and which layer each',
    'value came from. Values that look like secrets are redacted unless you pass',
    '--reveal.',
    '',
    'Only variables Warpline contributes are listed - the inherited shell environment',
    'is not dumped, since that is rarely what you are debugging.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(envFlags),
  ].join('\n');
}

export async function runEnv(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, envFlags);
  const project = await resolveProject(parsed.positionals[0]);
  const { config } = project;

  const processId = flagString(parsed, 'process');
  const proc = processId ? config.processes.find((candidate) => candidate.id === processId) : undefined;
  if (processId && !proc) {
    throw new WarplineError(`No process named "${processId}" in this project`, {
      hint: `Available: ${config.processes.map((candidate) => candidate.id).join(', ')}`,
    });
  }

  const resolved = resolveEnv(config, proc, { overrides: parseEnvOverrides(flagList(parsed, 'env')) });

  // The inherited shell environment is noise here; what matters is what Warpline
  // added or changed on top of it.
  const contributed = Object.entries(resolved.origins)
    .filter(([, info]) => info.origin !== 'shell' && info.origin !== 'shell (allowlisted)')
    .map(([key]) => key)
    .sort();

  const reveal = flagBool(parsed, 'reveal');
  const format = flagString(parsed, 'format') ?? 'table';

  const valueFor = async (key: string): Promise<string> => {
    const value = resolved.values[key] ?? '';
    if (reveal) return value;
    const { maskValue } = await import('../env/resolve.js');
    return maskValue(key, value);
  };

  if (format === 'json') {
    const payload: Record<string, { value: string; origin: string }> = {};
    for (const key of contributed) {
      payload[key] = {
        value: await valueFor(key),
        origin: resolved.origins[key]?.origin ?? 'unknown',
      };
    }
    out.write(JSON.stringify({ project: project.name, process: processId ?? null, variables: payload }, null, 2));
    return 0;
  }

  if (format === 'dotenv' || format === 'shell') {
    // These formats exist to be sourced or written to a file. Emitting redacted
    // placeholders would produce output that looks usable but silently sets
    // every secret to a mask string, so it is refused outright.
    if (!reveal) {
      throw new WarplineError(`--format ${format} would write real values, so it requires --reveal`, {
        hint: `Run \`warpline env ${project.name} --format ${format} --reveal\` if that is what you want. Be careful where the output goes.`,
      });
    }
    for (const key of contributed) {
      const value = resolved.values[key] ?? '';
      const quoted = `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
      out.write(format === 'shell' ? `export ${key}=${quoted}` : `${key}=${quoted}`);
    }
    return 0;
  }

  const { renderTable } = await import('../core/ui.js');
  const showOrigins = flagBool(parsed, 'origins');

  if (contributed.length === 0) {
    out.note('Warpline does not add any variables for this project.');
    return 0;
  }

  const rows: string[][] = [];
  for (const key of contributed) {
    const row = [theme.bold(key), await valueFor(key)];
    if (showOrigins) row.push(theme.dim(resolved.origins[key]?.origin ?? 'unknown'));
    rows.push(row);
  }

  const columns = showOrigins
    ? [{ header: 'variable' }, { header: 'value' }, { header: 'from' }]
    : [{ header: 'variable' }, { header: 'value' }];

  out.write(renderTable(columns, rows));

  if (resolved.missingFiles.length > 0) {
    out.blank();
    out.warn(`declared but missing: ${resolved.missingFiles.join(', ')}`);
  }
  if (resolved.missingRequired.length > 0) {
    out.error(`required but empty: ${resolved.missingRequired.join(', ')}`);
    return 1;
  }

  return 0;
}
