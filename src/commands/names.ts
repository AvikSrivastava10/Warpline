/**
 * The canonical command list. Kept in its own module so both the CLI router and
 * the generated shell completions can read it without importing each other.
 */
export const COMMAND_NAMES = [
  'init',
  'up',
  'down',
  'restart',
  'status',
  'list',
  'logs',
  'exec',
  'env',
  'cd',
  'link',
  'remove',
  'rename',
  'note',
  'doctor',
  'prune',
  'shell-init',
  'help',
  'version',
] as const;

/** Commands whose first positional argument is a saved project name. */
export const PROJECT_ARG_COMMANDS = [
  'up',
  'down',
  'restart',
  'status',
  'logs',
  'exec',
  'env',
  'cd',
  'remove',
  'rename',
  'note',
  'doctor',
] as const;

export const COMMAND_ALIASES: Record<string, string> = {
  ls: 'list',
  resume: 'up',
  start: 'up',
  stop: 'down',
  kill: 'down',
  ps: 'status',
  log: 'logs',
  rm: 'remove',
  forget: 'remove',
  save: 'init',
  run: 'exec',
  mv: 'rename',
  info: 'status',
  check: 'doctor',
  '--version': 'version',
  '-v': 'version',
  '--help': 'help',
  '-h': 'help',
};
