import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { sleep } from '../core/fsx.js';
import { isPidAlive } from '../state/runtime.js';

const isWindows = process.platform === 'win32';

export interface SpawnCommandOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** Overrides the interpreting shell. Defaults to sh on POSIX, cmd on Windows. */
  shell?: string | undefined;
}

export interface SpawnedProcess {
  child: ChildProcess;
  pid: number | undefined;
  /** True when the child leads its own process group, so signals can target the tree. */
  leadsProcessGroup: boolean;
}

/**
 * Spawns a shell command with its output piped back to Warpline.
 *
 * `detached` is set on POSIX only, and that asymmetry is deliberate.
 *
 * On POSIX it puts the child in its own process group. That matters more than it
 * looks: `npm run dev` is a shell that spawns npm that spawns node, so
 * signalling just the shell leaves the real dev server orphaned and still
 * holding port 3000. A process group lets one signal reach the whole tree. It
 * also shields children from the terminal's Ctrl-C so Warpline can run an ordered
 * shutdown rather than having everything die at once.
 *
 * On Windows, `detached` gives the child its own console, and anything it writes
 * goes to that console instead of our pipe -- output capture silently returns
 * nothing. Windows therefore stays attached and relies on `taskkill /T` to walk
 * the process tree, which it does natively.
 */
export function spawnShellCommand(options: SpawnCommandOptions): SpawnedProcess {
  const child = spawn(options.command, {
    cwd: options.cwd,
    env: options.env,
    // `shell: true` lets Node apply the platform's own quoting rules
    // (`cmd /d /s /c "..."` on Windows, `sh -c ...` elsewhere), which is far
    // less error-prone than assembling the argv by hand.
    shell: options.shell ?? true,
    detached: !isWindows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    child,
    pid: child.pid,
    leadsProcessGroup: !isWindows && child.pid !== undefined,
  };
}

function execQuiet(command: string, args: string[], timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Signals a PID and, where supported, everything in its process group. */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (isWindows) return; // Windows has no signals; handled by taskkill.
  try {
    // Negative PID targets the whole process group.
    process.kill(-pid, signal);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(50);
  }
  return !isPidAlive(pid);
}

export interface TerminateResult {
  exited: boolean;
  /** True when a hard kill was required. */
  forced: boolean;
}

/**
 * Stops a process tree, escalating only if it refuses to leave.
 *
 * Dev servers routinely need the grace period: Vite and Next flush caches on
 * SIGTERM, and databases in particular can corrupt state if hard-killed, so
 * SIGKILL is a last resort rather than the default.
 */
export async function terminateTree(
  pid: number | undefined,
  options: { graceMs?: number } = {},
): Promise<TerminateResult> {
  if (pid === undefined || !isPidAlive(pid)) return { exited: true, forced: false };
  const graceMs = options.graceMs ?? 8000;

  if (isWindows) {
    // Without /F, taskkill sends a close request that GUI apps and cmd.exe
    // honour but console programs like node generally ignore. Waiting the full
    // grace period for a reply that will not come would add seconds to every
    // `warpline down`, so the polite phase gets a short window and then escalates.
    const politeMs = Math.min(graceMs, 1500);
    await execQuiet('taskkill', ['/PID', String(pid), '/T']);
    if (politeMs > 0 && (await waitForExit(pid, politeMs))) {
      return { exited: true, forced: false };
    }

    await execQuiet('taskkill', ['/PID', String(pid), '/T', '/F']);
    const exited = await waitForExit(pid, 3000);
    return { exited, forced: true };
  }

  signalTree(pid, 'SIGTERM');
  if (await waitForExit(pid, graceMs)) return { exited: true, forced: false };

  signalTree(pid, 'SIGKILL');
  const exited = await waitForExit(pid, 3000);
  return { exited, forced: true };
}

/**
 * Runs a command to completion, capturing output. Used for lifecycle hooks,
 * where the caller needs the exit code and the combined log rather than a
 * streaming handle.
 */
export function runToCompletion(
  options: SpawnCommandOptions & { timeoutMs?: number; onOutput?: (chunk: string) => void },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? true,
      detached: !isWindows,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;

    const collect = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      output += text;
      options.onOutput?.(text);
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = options.timeoutMs
      ? setTimeout(() => {
          void terminateTree(child.pid, { graceMs: 2000 });
          if (!settled) {
            settled = true;
            resolve({ code: null, signal: 'SIGTERM', output: output + '\n[warpline] timed out' });
          }
        }, options.timeoutMs)
      : undefined;

    if (timer && typeof timer.unref === 'function') timer.unref();

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, output: `${output}\n${(error as Error).message}` });
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

/** Opens a URL in the platform's default browser, best effort. */
export async function openUrl(url: string): Promise<void> {
  if (isWindows) {
    // `start` is a cmd builtin; the empty title argument guards against URLs
    // containing characters cmd would otherwise read as a window title.
    await execQuiet('cmd', ['/d', '/s', '/c', 'start', '', url]);
    return;
  }
  if (process.platform === 'darwin') {
    await execQuiet('open', [url]);
    return;
  }
  await execQuiet('xdg-open', [url]);
}
