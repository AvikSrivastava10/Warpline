import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './paths.js';
import { WarplineError } from './errors.js';

/**
 * Write-to-temp-then-rename. Two reasons this matters here: a Ctrl-C midway
 * through writing state must not leave a truncated JSON file that bricks every
 * later command, and two `warpline up` calls racing on the registry must not
 * interleave partial writes.
 */
export function writeFileAtomic(file: string, contents: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Reads JSON, returning the fallback for both "missing" and "corrupt". A
 * corrupt state file should never be fatal: the worst case is that Warpline
 * forgets what was running, which is recoverable, whereas hard-failing every
 * command until the user hand-edits JSON is not.
 */
export function readJsonSafe<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as T;
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

export function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function fileExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

export function dirExists(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Directory-based mutex. `mkdir` is atomic on every platform we target, which
 * makes it a more reliable lock primitive than an exclusive file open across
 * Windows and POSIX. Stale locks are reclaimed by age so a crashed process
 * cannot wedge the CLI permanently.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  ensureDir(path.dirname(lockPath));

  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // lock vanished between calls; retry immediately
      }

      if (ageMs > staleMs) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {
          /* another process may have won the cleanup race */
        }
        continue;
      }

      if (Date.now() > deadline) {
        throw new WarplineError(`Timed out waiting for lock at ${lockPath}`, {
          hint: 'Another warpline process may be mid-write. Retry, or delete the lock directory if nothing else is running.',
        });
      }

      await sleep(25);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * A pending sleep deliberately keeps the event loop alive. Warpline waits on
 * sleeps in places where nothing else holds the process open -- polling for a
 * detached supervisor's state, for instance -- so an unref'd timer here would
 * let the CLI exit mid-wait and silently skip the rest of its work.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
