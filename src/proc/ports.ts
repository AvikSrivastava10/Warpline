import net from 'node:net';
import { execFile } from 'node:child_process';
import { sleep } from '../core/fsx.js';

const DEFAULT_HOST = '127.0.0.1';

/**
 * "Is something listening here?" A connect attempt is the right test rather
 * than a bind attempt: bind results vary with the interface a server chooses
 * (0.0.0.0 vs 127.0.0.1 vs ::1), whereas a successful connect is unambiguous
 * evidence that the port is taken.
 */
export function isPortListening(port: number, host = DEFAULT_HOST, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

export interface PortWaitOptions {
  host?: string;
  timeoutMs: number;
  intervalMs: number;
  /** Aborts the wait early, e.g. because the process died. */
  signal?: AbortSignal;
}

export async function waitForPort(port: number, options: PortWaitOptions): Promise<boolean> {
  const host = options.host ?? DEFAULT_HOST;
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    if (options.signal?.aborted) return false;
    if (await isPortListening(port, host)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(options.intervalMs);
  }
}

function run(command: string, args: string[], timeoutMs = 2500): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          // Non-zero exit is normal here (`lsof` exits 1 when nothing matches).
          if (error && !stdout) resolve(undefined);
          else resolve(stdout);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

export interface PortOwner {
  port: number;
  pid: number | undefined;
  processName: string | undefined;
  /** True when the owner is a process Warpline itself started. */
  ownedByWarpline: boolean;
}

async function findOwnerWindows(port: number): Promise<{ pid: number; name: string | undefined } | undefined> {
  const stdout = await run('netstat', ['-ano', '-p', 'TCP']);
  if (!stdout) return undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    // Columns: Proto  Local Address  Foreign Address  State  PID
    const columns = line.trim().split(/\s+/);
    const local = columns[1];
    const pidText = columns[columns.length - 1];
    if (!local || !pidText) continue;

    // Match the port at the end of the local address, IPv4 or bracketed IPv6.
    const portMatch = /:(\d+)$/.exec(local);
    if (!portMatch || Number.parseInt(portMatch[1] as string, 10) !== port) continue;

    const pid = Number.parseInt(pidText, 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;

    const tasklist = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    let name: string | undefined;
    if (tasklist) {
      const nameMatch = /^"([^"]+)"/.exec(tasklist.trim());
      if (nameMatch?.[1]) name = nameMatch[1];
    }
    return { pid, name };
  }
  return undefined;
}

async function findOwnerPosix(port: number): Promise<{ pid: number; name: string | undefined } | undefined> {
  // `lsof -F` emits one field per line prefixed by a type character, which is
  // far more robust to parse than the default columnar output.
  const lsof = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  if (lsof) {
    let pid: number | undefined;
    let name: string | undefined;
    for (const line of lsof.split(/\r?\n/)) {
      if (line.startsWith('p')) {
        const parsed = Number.parseInt(line.slice(1), 10);
        if (Number.isFinite(parsed)) pid = parsed;
      } else if (line.startsWith('c')) {
        name = line.slice(1);
      }
      if (pid !== undefined && name !== undefined) break;
    }
    if (pid !== undefined) return { pid, name };
  }

  // Fallback for minimal Linux images without lsof.
  const ss = await run('ss', ['-H', '-ltnp']);
  if (ss) {
    for (const line of ss.split(/\r?\n/)) {
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      const match = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
      if (match?.[2]) {
        return { pid: Number.parseInt(match[2], 10), name: match[1] };
      }
    }
  }

  return undefined;
}

/**
 * Identifies which process holds a port. Best-effort by design: the tools it
 * shells out to are not guaranteed to exist, and a missing answer degrades to
 * "port is busy, owner unknown" rather than failing the command.
 */
export async function findPortOwner(port: number): Promise<PortOwner | undefined> {
  const listening = await isPortListening(port);
  if (!listening) return undefined;

  const owner = process.platform === 'win32' ? await findOwnerWindows(port) : await findOwnerPosix(port);

  return {
    port,
    pid: owner?.pid,
    processName: owner?.name,
    ownedByWarpline: false,
  };
}

export interface PortConflict extends PortOwner {
  /** The process id in warpline.yml that wanted this port. */
  processId: string;
  /** Set when the port is held by another warpline-managed project. */
  heldByProject: string | undefined;
}

/**
 * Checks every declared port before starting anything, in parallel. Running
 * this up front converts a confusing mid-startup crash into one actionable
 * message that names the offending process.
 */
export async function checkPortConflicts(
  declared: ReadonlyArray<{ processId: string; ports: number[] }>,
): Promise<PortConflict[]> {
  const checks: Array<Promise<PortConflict | undefined>> = [];

  for (const entry of declared) {
    for (const port of entry.ports) {
      checks.push(
        findPortOwner(port).then((owner) =>
          owner
            ? {
                ...owner,
                processId: entry.processId,
                heldByProject: undefined,
              }
            : undefined,
        ),
      );
    }
  }

  const results = await Promise.all(checks);
  return results.filter((entry): entry is PortConflict => entry !== undefined);
}

/** Finds an unused port at or above `start`, for `--auto-port`. */
export async function findFreePort(start: number, attempts = 50): Promise<number | undefined> {
  for (let port = start; port < start + attempts && port <= 65535; port += 1) {
    if (!(await isPortListening(port))) return port;
  }
  return undefined;
}
