import path from 'node:path';
import { readTextOrNull } from '../core/fsx.js';
import { WarplineError } from '../core/errors.js';
import { expandValue, parseDotenv } from './dotenv.js';
import type { ProcessConfig, WarplineConfig } from '../config/types.js';

/**
 * Variables a child process needs to function at all. Used when
 * `env.isolate: true` strips the inherited environment.
 */
const BASELINE_POSIX = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TERM_PROGRAM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TZ',
  'SSH_AUTH_SOCK',
  'DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_HOME',
  'COLORTERM',
];

const BASELINE_WINDOWS = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'SESSIONNAME',
  'WT_SESSION',
  'PSMODULEPATH',
];

const isWindows = process.platform === 'win32';

/**
 * Windows treats environment variable names case-insensitively, so a map
 * containing both `Path` and `PATH` produces undefined behaviour in the child.
 * All writes funnel through here to keep exactly one casing per logical name.
 */
export function setEnvVar(target: Record<string, string>, key: string, value: string): void {
  if (isWindows) {
    const upper = key.toUpperCase();
    for (const existing of Object.keys(target)) {
      if (existing !== key && existing.toUpperCase() === upper) delete target[existing];
    }
  }
  target[key] = value;
}

export function getEnvVar(source: Record<string, string | undefined>, key: string): string | undefined {
  const direct = source[key];
  if (direct !== undefined) return direct;
  if (!isWindows) return undefined;
  const upper = key.toUpperCase();
  for (const [existing, value] of Object.entries(source)) {
    if (existing.toUpperCase() === upper) return value;
  }
  return undefined;
}

export interface EnvSourceInfo {
  /** Where the value came from: `shell`, a file path, `warpline.yml env.vars`, etc. */
  origin: string;
}

export interface ResolvedEnv {
  /** Final environment handed to the child process. */
  values: Record<string, string>;
  /** Per-key provenance, used by `warpline doctor` and `--print-env`. */
  origins: Record<string, EnvSourceInfo>;
  /** Declared env files that were not found on disk. */
  missingFiles: string[];
  /** `env.require` names that ended up empty. */
  missingRequired: string[];
  /** Files that were loaded, in order. */
  loadedFiles: string[];
}

export interface ResolveEnvOptions {
  /** Extra variables applied last, e.g. from `--env KEY=VALUE`. */
  overrides?: Record<string, string>;
  /** Injected so processes can discover their own identity. */
  processId?: string;
}

/**
 * Builds the environment for a process by layering, lowest precedence first:
 *
 *   1. the inherited shell environment (or a minimal baseline when isolated)
 *   2. `env.files` in declaration order
 *   3. `env.vars` from the config
 *   4. per-process `env`
 *   5. explicit CLI overrides
 *
 * Values are expanded against the accumulated result, so `DATABASE_URL` in a
 * later file can reference `POSTGRES_PORT` from an earlier one.
 */
export function resolveEnv(
  config: WarplineConfig,
  proc: ProcessConfig | undefined,
  options: ResolveEnvOptions = {},
): ResolvedEnv {
  const values: Record<string, string> = {};
  const origins: Record<string, EnvSourceInfo> = {};
  const missingFiles: string[] = [];
  const loadedFiles: string[] = [];

  const record = (key: string, value: string, origin: string): void => {
    setEnvVar(values, key, value);
    origins[key] = { origin };
  };

  // Layer 1: inherited environment.
  if (config.env.isolate) {
    const baseline = isWindows ? BASELINE_WINDOWS : BASELINE_POSIX;
    const allowed = new Set([...baseline, ...config.env.passthrough.map((n) => n.toUpperCase())]);
    const passAll = config.env.passthrough.includes('*');
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (passAll || allowed.has(key.toUpperCase())) record(key, value, 'shell (allowlisted)');
    }
  } else {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      record(key, value, 'shell');
    }
  }

  // Warpline's own plumbing must never leak into child processes: a dev server
  // inheriting WARPLINE_HOME or an internal supervisor flag is confusing at best.
  for (const key of Object.keys(values)) {
    if (key.toUpperCase().startsWith('WARPLINE_')) {
      delete values[key];
      delete origins[key];
    }
  }

  const lookup = (name: string): string | undefined => getEnvVar(values, name);

  // Layer 2: env files.
  for (const relative of config.env.files) {
    const absolute = path.resolve(config.root, relative);
    const text = readTextOrNull(absolute);
    if (text === null) {
      missingFiles.push(relative);
      continue;
    }
    loadedFiles.push(relative);
    const parsed = parseDotenv(text);
    for (const entry of parsed.entries) {
      record(entry.key, expandValue(entry.value, lookup), relative);
    }
  }

  const requiredMissingFiles = config.env.requireFiles.filter((file) => missingFiles.includes(file));
  if (requiredMissingFiles.length > 0) {
    throw new WarplineError(
      `Required env file(s) missing: ${requiredMissingFiles.join(', ')}`,
      {
        hint:
          config.env.files.length > 0
            ? 'Copy the matching example file (for example `cp .env.example .env`) and fill it in.'
            : undefined,
      },
    );
  }

  // Layer 3: config-level literal vars.
  for (const [key, value] of Object.entries(config.env.vars)) {
    record(key, expandValue(value, lookup), 'warpline.yml env.vars');
  }

  // Layer 4: per-process vars.
  if (proc) {
    for (const [key, value] of Object.entries(proc.env)) {
      record(key, expandValue(value, lookup), `warpline.yml processes.${proc.id}.env`);
    }
  }

  // Layer 5: CLI overrides.
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    record(key, expandValue(value, lookup), '--env');
  }

  // Ambient context. FORCE_COLOR keeps child tooling colourised even though
  // its stdout is a pipe into Warpline's log multiplexer rather than a TTY.
  record('WARPLINE', '1', 'warpline');
  record('WARPLINE_PROJECT', config.name, 'warpline');
  if (proc ?? options.processId) {
    record('WARPLINE_PROCESS', proc?.id ?? options.processId ?? '', 'warpline');
  }
  if (getEnvVar(values, 'FORCE_COLOR') === undefined && process.stderr.isTTY) {
    record('FORCE_COLOR', '1', 'warpline');
  }

  const missingRequired = config.env.require.filter((name) => {
    const value = getEnvVar(values, name);
    return value === undefined || value.length === 0;
  });

  return { values, origins, missingFiles, missingRequired, loadedFiles };
}

const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|PRIVATE|SESSION|COOKIE|SALT|SIGNATURE|DSN|CONNECTION_STRING|ACCESS|REFRESH)/i;

export function looksSecret(key: string): boolean {
  return SECRETISH.test(key);
}

/**
 * Renders a value for display. Secret-looking keys are always redacted to a
 * length hint, because the whole point of the reference-based env model is that
 * Warpline never puts secrets somewhere they can be copied out of.
 */
export function maskValue(key: string, value: string): string {
  if (looksSecret(key)) {
    if (value.length === 0) return '(empty)';
    return `${'*'.repeat(Math.min(8, Math.max(3, value.length)))} (${value.length} chars)`;
  }
  if (value.length > 60) return `${value.slice(0, 57)}...`;
  return value;
}

/** Parses `KEY=VALUE` pairs from repeated `--env` flags. */
export function parseEnvOverrides(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new WarplineError(`Invalid --env value "${pair}"`, { hint: 'Use --env KEY=VALUE' });
    }
    const key = pair.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new WarplineError(`Invalid environment variable name "${key}"`);
    }
    result[key] = pair.slice(eq + 1);
  }
  return result;
}
