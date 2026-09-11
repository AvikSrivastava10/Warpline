import fs from 'node:fs';
import { flagBool, flagList, flagNumber, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { colorForIndex, out, padEndVisible, theme } from '../core/ui.js';
import { paths, tildify } from '../core/paths.js';
import { sleep } from '../core/fsx.js';
import { WarplineError } from '../core/errors.js';
import { readLogTail } from '../proc/logger.js';
import { inspectRuntime } from '../state/runtime.js';
import { resolveProjectLoosely } from './context.js';

export const logsFlags: FlagSpecs = {
  follow: { type: 'boolean', alias: 'f', describe: 'Keep streaming new output as it arrives' },
  lines: { type: 'number', alias: 'n', default: 40, describe: 'Lines of history to show per process (default 40)' },
  only: { type: 'list', alias: 'o', describe: 'Show only these processes' },
  prefix: { type: 'boolean', default: true, describe: 'Prefix lines with the process name (--no-prefix to disable)' },
  files: { type: 'boolean', describe: 'Print the log file paths and exit' },
};

export function logsHelp(): string {
  return [
    `${theme.bold('warpline logs')} ${theme.dim('[name] [options]')}`,
    '',
    'Shows captured output. Works whether the project is running or not, since',
    'logs are written to disk as well as to the terminal.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(logsFlags),
    '',
    theme.dim('Examples:'),
    `  ${theme.code('warpline logs -f')}               follow everything`,
    `  ${theme.code('warpline logs api -n 200')}       last 200 lines of the api process`,
  ].join('\n');
}

interface LogSource {
  id: string;
  label: string;
  file: string;
  colorize: (s: string) => string;
  position: number;
  partial: string;
}

function discoverSources(name: string, only: string[]): LogSource[] {
  const wanted = new Set(only);
  const info = inspectRuntime(name);
  const sources: Array<{ id: string; label: string; file: string }> = [];

  if (info) {
    for (const proc of Object.values(info.state.processes)) {
      if (wanted.size > 0 && !wanted.has(proc.id)) continue;
      sources.push({ id: proc.id, label: proc.label, file: proc.logFile });
    }
  }

  // Fall back to whatever is on disk: logs outlive state, so `warpline logs`
  // still works after a project has been stopped and its state cleared.
  if (sources.length === 0) {
    const dir = paths.logDir(name);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((file) => file.endsWith('.log'));
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const id = entry.slice(0, -'.log'.length);
      if (wanted.size > 0 && !wanted.has(id)) continue;
      sources.push({ id, label: id, file: `${dir}/${entry}` });
    }
  }

  return sources
    .filter((source) => fs.existsSync(source.file))
    .map((source, index) => ({
      ...source,
      colorize: colorForIndex(index),
      position: 0,
      partial: '',
    }));
}

export async function runLogs(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, logsFlags);
  const project = await resolveProjectLoosely(parsed.positionals[0]);
  const only = flagList(parsed, 'only');

  // A trailing positional can name a process instead of using --only, since
  // `warpline logs myapp api` reads more naturally than the flag.
  const extraPositional = parsed.positionals[1];
  if (extraPositional) only.push(extraPositional);

  const sources = discoverSources(project.name, only);

  if (sources.length === 0) {
    throw new WarplineError(`No logs found for "${project.name}"`, {
      hint: `Start it first with \`warpline up ${project.name}\`.`,
    });
  }

  if (flagBool(parsed, 'files')) {
    for (const source of sources) out.write(source.file);
    return 0;
  }

  const width = Math.max(...sources.map((source) => source.label.length));
  const usePrefix = flagBool(parsed, 'prefix') && sources.length > 1;

  const render = (source: LogSource, line: string): string => {
    if (!usePrefix) return line;
    return `${source.colorize(padEndVisible(source.label, width))} ${theme.dim('|')} ${line}`;
  };

  const historyLines = flagNumber(parsed, 'lines') ?? 40;

  // History is printed per-source rather than merged: the log files carry no
  // shared timestamps, so interleaving them would imply an ordering that is not
  // actually known.
  for (const source of sources) {
    const tail = readLogTail(source.file, historyLines);
    for (const line of tail) out.write(render(source, line));
    try {
      source.position = fs.statSync(source.file).size;
    } catch {
      source.position = 0;
    }
  }

  if (!flagBool(parsed, 'follow')) {
    out.note('');
    out.note(`${sources.length} log file${sources.length === 1 ? '' : 's'} in ${tildify(paths.logDir(project.name))}`);
    return 0;
  }

  out.note(theme.dim('following - Ctrl-C to stop'));

  let following = true;
  const stop = (): void => {
    following = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    // Polling rather than fs.watch: watch semantics differ meaningfully across
    // platforms (and are unreliable on network drives), while a 250ms poll is
    // both portable and imperceptible for log tailing.
    while (following) {
      for (const source of sources) {
        let size: number;
        try {
          size = fs.statSync(source.file).size;
        } catch {
          continue;
        }

        // Rotation truncates the file; restart from the beginning.
        if (size < source.position) source.position = 0;
        if (size === source.position) continue;

        const length = size - source.position;
        const buffer = Buffer.alloc(length);
        let handle: number | undefined;
        try {
          handle = fs.openSync(source.file, 'r');
          fs.readSync(handle, buffer, 0, length, source.position);
        } catch {
          continue;
        } finally {
          if (handle !== undefined) {
            try {
              fs.closeSync(handle);
            } catch {
              /* ignore */
            }
          }
        }
        source.position = size;

        const text = source.partial + buffer.toString('utf8');
        const segments = text.split(/\r?\n/);
        source.partial = segments.pop() ?? '';
        for (const line of segments) out.write(render(source, line));
      }

      await sleep(250);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }

  return 0;
}
