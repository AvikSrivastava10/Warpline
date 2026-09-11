import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates a scratch directory, resolved through `realpathSync`.
 *
 * The realpath matters on Windows, where `os.tmpdir()` often returns a short 8.3
 * path (`C:\Users\AVIKSR~1\AppData\Local\Temp`) while the code under test resolves
 * the long form. Comparing the two fails in a way that reads like a bug in the
 * code rather than in the test.
 */
export function createTempDir(prefix: string): string {
  const base = fs.realpathSync(os.tmpdir());
  return fs.realpathSync(fs.mkdtempSync(path.join(base, prefix)));
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Writes a whole fixture tree from `relative/path` -> contents, creating parent
 * directories as needed. Keys always use forward slashes, whatever the platform.
 */
export function writeTree(root: string, files: Record<string, string>): string {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
  }
  return root;
}

export interface EnvGuard {
  restore(): void;
}

/**
 * Sets environment variables and returns a restorer.
 *
 * Safe because the suite runs single-worker and without file parallelism, so no
 * two tests are mutating `process.env` at once. `core/paths.ts` reads
 * `WARPLINE_HOME` on every call rather than caching it at import, which is what
 * makes pointing it at a temp directory per test work at all.
 */
export function setEnv(values: Record<string, string | undefined>): EnvGuard {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return {
    restore() {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** A PID that cannot be alive, for exercising liveness reconciliation. */
export const DEAD_PID = 2 ** 31 - 1;
