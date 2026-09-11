import { flagBool, flagList, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { formatDuration, formatRelative, glyph, out, renderTable, theme, truncate } from '../core/ui.js';
import { tildify } from '../core/paths.js';
import { isPortListening } from '../proc/ports.js';
import {
  inspectRuntime,
  listRuntimeNames,
  reconcileRuntime,
  type ProcessRuntime,
  type ProcessStatus,
} from '../state/runtime.js';
import { listProjects } from '../state/registry.js';
import { resolveProjectLoosely } from './context.js';

export const statusFlags: FlagSpecs = {
  all: { type: 'boolean', alias: 'a', describe: 'Show every project with recorded state' },
  json: { type: 'boolean', describe: 'Emit machine-readable JSON on stdout' },
  ports: { type: 'boolean', default: true, describe: 'Probe declared ports to confirm they answer (--no-ports to skip)' },
  only: { type: 'list', alias: 'o', describe: 'Limit output to these processes' },
};

export function statusHelp(): string {
  return [
    `${theme.bold('warpline status')} ${theme.dim('[name] [options]')}`,
    '',
    'Shows what is actually running right now: PIDs verified against the OS,',
    'uptime, restart counts, and whether each declared port is answering.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(statusFlags),
  ].join('\n');
}

function colorStatus(status: ProcessStatus): string {
  switch (status) {
    case 'ready':
      return theme.ok('ready');
    case 'done':
      return theme.ok('done');
    case 'running':
      return theme.info('running');
    case 'starting':
      return theme.info('starting');
    case 'failed':
      return theme.err('failed');
    case 'skipped':
      return theme.warn('skipped');
    case 'stopped':
      return theme.dim('stopped');
    default:
      return theme.dim(status);
  }
}

interface PortProbe {
  port: number;
  answering: boolean;
}

async function probePorts(processes: ProcessRuntime[]): Promise<Map<number, boolean>> {
  const ports = [...new Set(processes.flatMap((proc) => proc.ports))];
  const results = await Promise.all(
    ports.map(async (port): Promise<PortProbe> => ({ port, answering: await isPortListening(port) })),
  );
  return new Map(results.map((result) => [result.port, result.answering]));
}

async function printProject(name: string, options: { probe: boolean; only: string[] }): Promise<boolean> {
  const info = reconcileRuntime(name) ?? inspectRuntime(name);

  if (!info) {
    out.write(`${theme.bold(theme.accent(name))} ${theme.dim('- not running')}`);
    return false;
  }

  const wanted = new Set(options.only);
  const processes = Object.values(info.state.processes).filter(
    (proc) => wanted.size === 0 || wanted.has(proc.id),
  );

  const running = info.live.length > 0;
  const header = running
    ? `${theme.ok(glyph.running)} ${theme.bold(theme.accent(name))}`
    : `${theme.dim(glyph.stopped)} ${theme.bold(name)}`;

  const mode = info.state.mode === 'detached' ? theme.dim('detached') : theme.dim('foreground');
  const uptime = running ? theme.dim(`up ${formatDuration(Date.now() - info.state.startedAt)}`) : theme.dim('stopped');

  out.write(`${header}  ${uptime}  ${mode}  ${theme.dim(tildify(info.state.root))}`);

  if (running && info.state.mode === 'detached' && !info.supervisorAlive) {
    out.warn('  the supervisor is gone but child processes are still alive; `warpline down` will clean them up');
  }

  const portStatus = options.probe && running ? await probePorts(processes) : new Map<number, boolean>();

  const rows = processes.map((proc) => {
    const ports =
      proc.ports.length === 0
        ? theme.dim('-')
        : proc.ports
            .map((port) => {
              if (!options.probe || !running) return String(port);
              const answering = portStatus.get(port);
              if (answering === undefined) return String(port);
              return answering ? theme.ok(String(port)) : theme.err(`${port} ${glyph.fail}`);
            })
            .join(', ');

    const uptimeCell =
      proc.status === 'ready' || proc.status === 'running'
        ? proc.startedAt
          ? formatDuration(Date.now() - proc.startedAt)
          : '-'
        : theme.dim('-');

    return [
      theme.bold(proc.label),
      colorStatus(proc.status),
      proc.pid ? String(proc.pid) : theme.dim('-'),
      ports,
      uptimeCell,
      proc.restarts > 0 ? theme.warn(String(proc.restarts)) : theme.dim('0'),
      proc.message ? theme.dim(truncate(proc.message, 44)) : '',
    ];
  });

  out.write(
    renderTable(
      [
        { header: 'process' },
        { header: 'status' },
        { header: 'pid', align: 'right' },
        { header: 'ports' },
        { header: 'uptime', align: 'right' },
        { header: 'restarts', align: 'right' },
        { header: 'detail' },
      ],
      rows,
    ),
  );

  return running;
}

export async function runStatus(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, statusFlags);
  const probe = flagBool(parsed, 'ports');
  const only = flagList(parsed, 'only');

  if (flagBool(parsed, 'json')) {
    const names = flagBool(parsed, 'all')
      ? listRuntimeNames()
      : [(await resolveProjectLoosely(parsed.positionals[0])).name];

    const payload = names.map((name) => {
      const info = inspectRuntime(name);
      return {
        name,
        running: Boolean(info && info.live.length > 0),
        mode: info?.state.mode ?? null,
        root: info?.state.root ?? null,
        startedAt: info?.state.startedAt ?? null,
        supervisorAlive: info?.supervisorAlive ?? false,
        processes: info
          ? Object.values(info.state.processes).map((proc) => ({
              id: proc.id,
              status: proc.status,
              pid: proc.pid ?? null,
              ports: proc.ports,
              restarts: proc.restarts,
              startedAt: proc.startedAt ?? null,
              readyAt: proc.readyAt ?? null,
              exitCode: proc.exitCode ?? null,
              message: proc.message ?? null,
              logFile: proc.logFile,
            }))
          : [],
      };
    });

    out.write(JSON.stringify(flagBool(parsed, 'all') ? payload : payload[0], null, 2));
    return 0;
  }

  if (flagBool(parsed, 'all')) {
    const names = listRuntimeNames();
    if (names.length === 0) {
      out.note('No project has been started yet.');
      const saved = listProjects();
      if (saved.length > 0) {
        out.note(`Saved projects: ${saved.map((entry) => entry.name).join(', ')}`);
      }
      return 0;
    }

    let anyRunning = false;
    for (const [index, name] of names.entries()) {
      if (index > 0) out.blank();
      const running = await printProject(name, { probe, only });
      anyRunning = anyRunning || running;
    }

    if (!anyRunning) {
      out.blank();
      out.note('Nothing is currently running.');
    }
    return 0;
  }

  const project = await resolveProjectLoosely(parsed.positionals[0]);
  const running = await printProject(project.name, { probe, only });

  if (!running) {
    const entry = listProjects().find((candidate) => candidate.name === project.name);
    if (entry) {
      out.blank();
      out.note(
        `last started ${formatRelative(entry.lastUsedAt)} ${glyph.sep} ${theme.code(`warpline up ${project.name}`)} to start it`,
      );
    }
  }

  return 0;
}
