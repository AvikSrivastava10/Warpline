import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * All Warpline global state lives under a single root so it is trivially
 * inspectable and deletable. `WARPLINE_HOME` exists so tests (and users with
 * unusual setups) can relocate it without touching real state.
 */
export function warplineHome(): string {
  const override = process.env.WARPLINE_HOME;
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(os.homedir(), '.warpline');
}

export const paths = {
  home: warplineHome,

  /** Global index mapping a memorable name -> project root on disk. */
  registryFile: () => path.join(warplineHome(), 'registry.json'),

  /** User-level preferences (log caps, default mode, etc). */
  settingsFile: () => path.join(warplineHome(), 'settings.json'),

  /** Runtime state: which PIDs are live for a project right now. */
  stateDir: () => path.join(warplineHome(), 'state'),
  stateFile: (name: string) => path.join(warplineHome(), 'state', `${safeSlug(name)}.json`),

  /** Captured stdout/stderr, one file per process. */
  logDir: (name: string) => path.join(warplineHome(), 'logs', safeSlug(name)),
  logFile: (name: string, proc: string) =>
    path.join(warplineHome(), 'logs', safeSlug(name), `${safeSlug(proc)}.log`),

  /** Supervisor bookkeeping for detached runs. */
  runDir: () => path.join(warplineHome(), 'run'),
  supervisorLog: (name: string) => path.join(warplineHome(), 'run', `${safeSlug(name)}.supervisor.log`),
};

/**
 * Project names double as filenames, so anything path-hostile is folded to a
 * dash. Kept deliberately aggressive: correctness over prettiness.
 */
export function safeSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
  return slug.length > 0 ? slug : 'unnamed';
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Collapse the home prefix so printed paths stay readable in narrow terminals. */
export function tildify(target: string): string {
  const home = os.homedir();
  const resolved = path.resolve(target);
  if (resolved === home) return '~';
  if (resolved.startsWith(home + path.sep)) {
    return '~' + path.sep + path.relative(home, resolved);
  }
  return resolved;
}
