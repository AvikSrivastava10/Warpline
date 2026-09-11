import fs from 'node:fs';
import { paths } from '../core/paths.js';
import { readJsonSafe, writeJsonAtomic } from '../core/fsx.js';

export const STATE_VERSION = 1;

export type ProcessStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'ready'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'skipped';

export interface ProcessRuntime {
  id: string;
  label: string;
  command: string;
  cwd: string;
  kind: 'service' | 'task';
  pid: number | undefined;
  status: ProcessStatus;
  startedAt: number | undefined;
  readyAt: number | undefined;
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  restarts: number;
  ports: number[];
  logFile: string;
  /** Populated when a process fails, for `warpline status` to explain why. */
  message: string | undefined;
}

export interface ProjectRuntime {
  version: number;
  name: string;
  root: string;
  configFile: string;
  mode: 'foreground' | 'detached';
  startedAt: number;
  /** PID of the warpline process supervising these children. */
  supervisorPid: number;
  processes: Record<string, ProcessRuntime>;
}

/**
 * Signal 0 performs permission and existence checks without delivering a
 * signal, which is the portable way to ask "is this PID alive?". EPERM means
 * the process exists but belongs to another user, which still counts as alive.
 */
export function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readRuntime(name: string): ProjectRuntime | undefined {
  const file = paths.stateFile(name);
  if (!fs.existsSync(file)) return undefined;
  const state = readJsonSafe<ProjectRuntime | null>(file, null);
  if (!state || typeof state.processes !== 'object' || state.processes === null) return undefined;
  return state;
}

export function writeRuntime(state: ProjectRuntime): void {
  writeJsonAtomic(paths.stateFile(state.name), { ...state, version: STATE_VERSION });
}

export function clearRuntime(name: string): void {
  try {
    fs.rmSync(paths.stateFile(name), { force: true });
  } catch {
    /* best effort */
  }
}

export interface LiveRuntime {
  state: ProjectRuntime;
  /** Processes whose recorded PID is still alive. */
  live: ProcessRuntime[];
  /** Recorded as running but the PID is gone; the state file is stale. */
  vanished: ProcessRuntime[];
  supervisorAlive: boolean;
}

const ACTIVE_STATUSES: ReadonlySet<ProcessStatus> = new Set(['starting', 'running', 'ready']);

/**
 * Reconciles the recorded state against reality. This is what makes `up`
 * idempotent: a project whose processes are already alive is adopted and
 * reported rather than started a second time, which is the difference between
 * a useful `resume` and a wall of EADDRINUSE.
 */
export function inspectRuntime(name: string): LiveRuntime | undefined {
  const state = readRuntime(name);
  if (!state) return undefined;

  const live: ProcessRuntime[] = [];
  const vanished: ProcessRuntime[] = [];

  for (const proc of Object.values(state.processes)) {
    if (!ACTIVE_STATUSES.has(proc.status)) continue;
    if (isPidAlive(proc.pid)) live.push(proc);
    else vanished.push(proc);
  }

  return {
    state,
    live,
    vanished,
    supervisorAlive: isPidAlive(state.supervisorPid),
  };
}

/** True when anything belonging to this project is currently alive. */
export function isProjectRunning(name: string): boolean {
  const info = inspectRuntime(name);
  return Boolean(info && info.live.length > 0);
}

/**
 * Rewrites a stale state file so statuses reflect reality. Called before
 * starting anything, so `status` never shows phantom processes after a reboot.
 */
export function reconcileRuntime(name: string): LiveRuntime | undefined {
  const info = inspectRuntime(name);
  if (!info) return undefined;
  if (info.vanished.length === 0) return info;

  for (const proc of info.vanished) {
    const entry = info.state.processes[proc.id];
    if (!entry) continue;
    entry.status = 'stopped';
    entry.pid = undefined;
    entry.message = entry.message ?? 'process is gone (machine restarted, or it was killed outside warpline)';
  }
  writeRuntime(info.state);

  return { ...info, vanished: [], live: info.live };
}

export function createRuntime(input: {
  name: string;
  root: string;
  configFile: string;
  mode: 'foreground' | 'detached';
}): ProjectRuntime {
  return {
    version: STATE_VERSION,
    name: input.name,
    root: input.root,
    configFile: input.configFile,
    mode: input.mode,
    startedAt: Date.now(),
    supervisorPid: process.pid,
    processes: {},
  };
}

/** Every project with a state file on disk, live or stale. */
export function listRuntimeNames(): string[] {
  try {
    return fs
      .readdirSync(paths.stateDir())
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}


