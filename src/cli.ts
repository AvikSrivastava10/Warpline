import { WarplineError } from './core/errors.js';
import { out, theme, glyph } from './core/ui.js';
import { getVersion } from './version.js';
import { COMMAND_ALIASES } from './commands/names.js';

type Runner = (argv: string[]) => Promise<number>;

interface CommandSpec {
  summary: string;
  /** Lazily imported so `warpline list` never loads the supervisor. */
  load: () => Promise<{ run: Runner; help: () => string }>;
  hidden?: boolean;
  group: 'project' | 'lifecycle' | 'inspect' | 'setup';
}

/**
 * Command modules are imported on demand. It keeps startup fast (a bare
 * `warpline list` touches only the registry) and means a syntax error in one
 * command cannot stop the whole CLI from running.
 */
const COMMANDS: Record<string, CommandSpec> = {
  init: {
    summary: 'Detect this project and write a warpline.yml',
    group: 'setup',
    load: async () => {
      const mod = await import('./commands/init.js');
      return { run: mod.runInit, help: mod.initHelp };
    },
  },
  up: {
    summary: 'Start a project: all processes, in order, with env loaded',
    group: 'lifecycle',
    load: async () => {
      const mod = await import('./commands/up.js');
      return { run: mod.runUp, help: mod.upHelp };
    },
  },
  down: {
    summary: 'Stop a running project',
    group: 'lifecycle',
    load: async () => {
      const mod = await import('./commands/down.js');
      return { run: mod.runDown, help: mod.downHelp };
    },
  },
  restart: {
    summary: 'Stop and start again',
    group: 'lifecycle',
    load: async () => {
      const mod = await import('./commands/down.js');
      return { run: mod.runRestart, help: mod.restartHelp };
    },
  },
  status: {
    summary: 'Show what is running right now',
    group: 'inspect',
    load: async () => {
      const mod = await import('./commands/status.js');
      return { run: mod.runStatus, help: mod.statusHelp };
    },
  },
  list: {
    summary: 'List saved projects',
    group: 'inspect',
    load: async () => {
      const mod = await import('./commands/list.js');
      return { run: mod.runList, help: mod.listHelp };
    },
  },
  logs: {
    summary: 'Show or follow captured output',
    group: 'inspect',
    load: async () => {
      const mod = await import('./commands/logs.js');
      return { run: mod.runLogs, help: mod.logsHelp };
    },
  },
  exec: {
    summary: 'Run a one-off command with the project cwd and env',
    group: 'project',
    load: async () => {
      const mod = await import('./commands/exec.js');
      return { run: mod.runExec, help: mod.execHelp };
    },
  },
  env: {
    summary: 'Show the resolved environment and where each value came from',
    group: 'inspect',
    load: async () => {
      const mod = await import('./commands/exec.js');
      return { run: mod.runEnv, help: mod.envHelp };
    },
  },
  cd: {
    summary: "Print a project's directory (wrapped by shell-init to actually cd)",
    group: 'project',
    load: async () => {
      const mod = await import('./commands/navigate.js');
      return { run: mod.runCd, help: mod.cdHelp };
    },
  },
  link: {
    summary: 'Register the current directory under a name',
    group: 'setup',
    load: async () => {
      const mod = await import('./commands/manage.js');
      return { run: mod.runLink, help: mod.linkHelp };
    },
  },
  remove: {
    summary: 'Forget a saved project (files are left alone)',
    group: 'setup',
    load: async () => {
      const mod = await import('./commands/manage.js');
      return { run: mod.runRemove, help: mod.removeHelp };
    },
  },
  rename: {
    summary: 'Rename a saved project',
    group: 'setup',
    load: async () => {
      const mod = await import('./commands/manage.js');
      return { run: mod.runRename, help: mod.renameHelp };
    },
  },
  note: {
    summary: 'Attach a reminder shown on every start',
    group: 'project',
    load: async () => {
      const mod = await import('./commands/manage.js');
      return { run: mod.runNote, help: mod.noteHelp };
    },
  },
  doctor: {
    summary: 'Check everything that commonly breaks a start',
    group: 'inspect',
    load: async () => {
      const mod = await import('./commands/doctor.js');
      return { run: mod.runDoctor, help: mod.doctorHelp };
    },
  },
  prune: {
    summary: 'Clean up dead index entries and stale state',
    group: 'setup',
    load: async () => {
      const mod = await import('./commands/manage.js');
      return { run: mod.runPrune, help: mod.pruneHelp };
    },
  },
  'shell-init': {
    summary: 'Emit shell integration so `warpline cd` works, plus completions',
    group: 'setup',
    load: async () => {
      const mod = await import('./commands/shellInit.js');
      return { run: mod.runShellInit, help: mod.shellInitHelp };
    },
  },
  __supervise: {
    summary: 'Internal: background supervisor process',
    group: 'lifecycle',
    hidden: true,
    load: async () => {
      const mod = await import('./commands/supervise.js');
      return { run: mod.runSupervise, help: () => 'Internal command.' };
    },
  },
};

const GROUP_TITLES: Record<CommandSpec['group'], string> = {
  lifecycle: 'Start and stop',
  inspect: 'Inspect',
  project: 'Work inside a project',
  setup: 'Set up and manage',
};

function renderHelp(): string {
  const lines: string[] = [
    `${theme.bold(theme.accent('warpline'))} ${theme.dim(getVersion())}  ${theme.dim('- save and restore your whole project context under one name')}`,
    '',
    `${theme.dim('Usage:')} warpline <command> [name] [options]`,
    '',
  ];

  const groups: Array<CommandSpec['group']> = ['lifecycle', 'inspect', 'project', 'setup'];
  const width = Math.max(...Object.keys(COMMANDS).filter((name) => !COMMANDS[name]?.hidden).map((name) => name.length));

  for (const group of groups) {
    const entries = Object.entries(COMMANDS).filter(([, spec]) => spec.group === group && !spec.hidden);
    if (entries.length === 0) continue;

    lines.push(theme.dim(GROUP_TITLES[group]));
    for (const [name, spec] of entries) {
      lines.push(`  ${theme.bold(name.padEnd(width))}  ${spec.summary}`);
    }
    lines.push('');
  }

  lines.push(
    theme.dim('Getting started'),
    `  ${theme.code('warpline init')}          in a project, to describe how it starts`,
    `  ${theme.code('warpline up')}            start it (or ${theme.code('warpline up <name>')} from anywhere)`,
    `  ${theme.code('warpline status --all')}  see everything running`,
    '',
    `${theme.dim('Any command:')} warpline <command> --help`,
  );

  return lines.join('\n');
}

function resolveCommandName(input: string): string | undefined {
  if (COMMANDS[input]) return input;
  const alias = COMMAND_ALIASES[input];
  if (alias && COMMANDS[alias]) return alias;
  return undefined;
}

/**
 * Suggests commands when the user mistypes one. Returns several candidates
 * rather than insisting on a single winner: `stauts` is two edits from both
 * `status` and `start`, and offering both beats offering nothing.
 */
async function suggestCommands(input: string): Promise<string[]> {
  const { matchName } = await import('./core/fuzzy.js');
  const names = [...Object.keys(COMMANDS).filter((name) => !COMMANDS[name]?.hidden), ...Object.keys(COMMAND_ALIASES)];
  const matches = matchName(input, names, (name) => name);

  // On an equally good match, a real command name beats an alias: someone who
  // typed `stauts` more likely meant `status` than `start`.
  const ranked = matches
    .map((match, index) => ({ match, index, isAlias: COMMAND_ALIASES[match.name] !== undefined }))
    .sort((a, b) => Number(a.isAlias) - Number(b.isAlias) || a.index - b.index);

  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const { match } of ranked) {
    // Collapse aliases onto the command they resolve to.
    const canonical = COMMAND_ALIASES[match.name] ?? match.name;
    if (!COMMANDS[canonical] || seen.has(canonical)) continue;
    seen.add(canonical);
    suggestions.push(canonical);
    if (suggestions.length === 3) break;
  }
  return suggestions;
}

export async function runCli(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;

  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    // `warpline help up` should show the help for `up`, not the global help.
    const topic = rest[0] ? resolveCommandName(rest[0]) : undefined;
    if (topic) {
      const { help } = await (COMMANDS[topic] as CommandSpec).load();
      out.write(help());
      return 0;
    }
    out.write(renderHelp());
    return 0;
  }

  if (first === 'version' || first === '--version' || first === '-v') {
    out.write(getVersion());
    return 0;
  }

  const name = resolveCommandName(first);
  if (!name) {
    const suggestions = await suggestCommands(first);
    const hint =
      suggestions.length === 1
        ? `Did you mean \`warpline ${suggestions[0]}\`?`
        : suggestions.length > 1
          ? `Did you mean: ${suggestions.join(', ')}?`
          : 'Run `warpline help` to see the available commands.';

    throw new WarplineError(`Unknown command: ${first}`, { hint, exitCode: 2 });
  }

  const spec = COMMANDS[name] as CommandSpec;
  const { run, help } = await spec.load();

  if (rest.includes('--help') || rest.includes('-h')) {
    out.write(help());
    return 0;
  }

  return run(rest);
}

/** Prints a WarplineError the way a CLI should: message, then what to do about it. */
export function reportError(error: unknown): number {
  if (error instanceof WarplineError) {
    out.error(error.message);
    if (error.hint) out.note(`  ${glyph.arrow} ${error.hint}`);
    return error.exitCode;
  }

  const err = error as Error;
  out.error(err?.message ?? String(error));
  if (err?.stack && process.env.WARPLINE_DEBUG === '1') {
    process.stderr.write(theme.dim(err.stack) + '\n');
  } else {
    out.note('  Set WARPLINE_DEBUG=1 for a stack trace.');
  }
  return 1;
}
