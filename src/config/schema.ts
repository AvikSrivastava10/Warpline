import path from 'node:path';
import { ConfigError } from '../core/errors.js';
import type {
  EnvConfig,
  HooksConfig,
  ProcessConfig,
  ProcessKind,
  ReadyProbe,
  RestartPolicy,
  WarplineConfig,
} from './types.js';

export const CONFIG_VERSION = 1;

const PROCESS_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RESTART_POLICIES: readonly RestartPolicy[] = ['no', 'on-failure', 'always'];
const RESERVED_ENV_KEYS = new Set(['files', 'requireFiles', 'require_files', 'vars', 'passthrough', 'require', 'isolate']);

/** Collects every problem so the user fixes one round of errors, not one per run. */
class Problems {
  readonly items: string[] = [];

  add(message: string): void {
    this.items.push(message);
  }

  get ok(): boolean {
    return this.items.length === 0;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringList(value: unknown, where: string, problems: Problems): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) {
    const result: string[] = [];
    value.forEach((entry, i) => {
      if (typeof entry === 'string' && entry.trim().length > 0) result.push(entry.trim());
      else problems.add(`${where}[${i}] must be a non-empty string`);
    });
    return result;
  }
  problems.add(`${where} must be a string or a list of strings`);
  return [];
}

function asVarMap(value: unknown, where: string, problems: Problems): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    problems.add(`${where} must be a mapping of NAME: value`);
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!ENV_NAME_PATTERN.test(key)) {
      problems.add(`${where}.${key} is not a valid environment variable name`);
      continue;
    }
    if (raw === null || raw === undefined) {
      result[key] = '';
    } else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      result[key] = String(raw);
    } else {
      problems.add(`${where}.${key} must be a string, number, or boolean`);
    }
  }
  return result;
}

function asPositiveInt(value: unknown, where: string, problems: Problems): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    problems.add(`${where} must be a positive integer`);
    return undefined;
  }
  return num;
}

function asPort(value: unknown, where: string, problems: Problems): number | undefined {
  const num = asPositiveInt(value, where, problems);
  if (num === undefined) return undefined;
  if (num > 65535) {
    problems.add(`${where} must be a valid port (1-65535)`);
    return undefined;
  }
  return num;
}

/**
 * True for an absolute http(s) URL.
 *
 * Note what this cannot do: `&` is legal in both a host and a query string, so a
 * value crafted to break out of a shell can still be a valid http URL. Keeping
 * the URL away from a shell is `proc/spawn.ts::openUrl`'s job. This check exists
 * to rule out the other schemes -- `file:`, `javascript:`, and custom protocol
 * handlers -- and plain non-URL junk.
 */
function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function asBool(value: unknown, where: string, problems: Problems, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  problems.add(`${where} must be true or false`);
  return fallback;
}

/**
 * Resolves a config-relative path and refuses to escape the project root.
 * A `warpline.yml` is repo-committed and therefore attacker-adjacent on a
 * cloned repo, so `cwd: ../../etc` should not silently work.
 */
function resolveInsideRoot(
  raw: string,
  root: string,
  where: string,
  problems: Problems,
): string | undefined {
  const resolved = path.resolve(root, raw);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    problems.add(`${where} must stay inside the project root (got "${raw}")`);
    return undefined;
  }
  return resolved;
}

function parseEnv(raw: unknown, problems: Problems): EnvConfig {
  const empty: EnvConfig = {
    files: [],
    requireFiles: [],
    vars: {},
    passthrough: [],
    require: [],
    isolate: false,
  };

  if (raw === undefined || raw === null) return empty;
  if (!isPlainObject(raw)) {
    problems.add('env must be a mapping');
    return empty;
  }

  // Ergonomic shorthand: an `env` block with no reserved keys is treated as a
  // plain literal var map, so `env: { NODE_ENV: development }` just works.
  const keys = Object.keys(raw);
  const usesLongForm = keys.some((key) => RESERVED_ENV_KEYS.has(key));
  if (!usesLongForm && keys.length > 0) {
    return { ...empty, vars: asVarMap(raw, 'env', problems) };
  }

  const requireFilesRaw = raw.requireFiles ?? raw.require_files;
  const files = asStringList(raw.files, 'env.files', problems);
  const requireFiles = asStringList(requireFilesRaw, 'env.requireFiles', problems);

  for (const required of requireFiles) {
    if (!files.includes(required)) files.push(required);
  }

  const passthrough = asStringList(raw.passthrough, 'env.passthrough', problems);
  for (const name of passthrough) {
    if (!ENV_NAME_PATTERN.test(name) && name !== '*') {
      problems.add(`env.passthrough contains an invalid variable name: "${name}"`);
    }
  }

  const require = asStringList(raw.require, 'env.require', problems);
  for (const name of require) {
    if (!ENV_NAME_PATTERN.test(name)) {
      problems.add(`env.require contains an invalid variable name: "${name}"`);
    }
  }

  return {
    files,
    requireFiles,
    vars: asVarMap(raw.vars, 'env.vars', problems),
    passthrough,
    require,
    isolate: asBool(raw.isolate, 'env.isolate', problems, false),
  };
}

function parseHooks(raw: unknown, problems: Problems): HooksConfig {
  const empty: HooksConfig = { before: [], after: [], cleanup: [] };
  if (raw === undefined || raw === null) return empty;
  if (!isPlainObject(raw)) {
    problems.add('hooks must be a mapping with before/after/cleanup');
    return empty;
  }
  return {
    before: asStringList(raw.before, 'hooks.before', problems),
    after: asStringList(raw.after, 'hooks.after', problems),
    cleanup: asStringList(raw.cleanup, 'hooks.cleanup', problems),
  };
}

const DEFAULT_PROBE_TIMEOUT_MS = 90_000;
const DEFAULT_PROBE_INTERVAL_MS = 250;
const DEFAULT_SETTLE_MS = 400;

function emptyProbe(kind: ReadyProbe['kind']): ReadyProbe {
  return {
    kind,
    port: undefined,
    host: undefined,
    url: undefined,
    maxStatus: undefined,
    logPattern: undefined,
    file: undefined,
    settleMs: undefined,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    intervalMs: DEFAULT_PROBE_INTERVAL_MS,
  };
}

function parseReady(
  raw: unknown,
  kind: ProcessKind,
  root: string,
  processCwd: string,
  where: string,
  problems: Problems,
): ReadyProbe {
  // A task's contract is "runs to completion", so its readiness is its exit code.
  if (kind === 'task') {
    const probe = emptyProbe('exit');
    if (isPlainObject(raw)) {
      probe.timeoutMs = asPositiveInt(raw.timeout, `${where}.timeout`, problems) ?? DEFAULT_PROBE_TIMEOUT_MS;
    }
    return probe;
  }

  if (raw === undefined || raw === null) {
    const probe = emptyProbe('settle');
    probe.settleMs = DEFAULT_SETTLE_MS;
    return probe;
  }

  // `ready: false` opts out of gating entirely; dependents start immediately.
  if (raw === false || raw === 'none') return emptyProbe('none');

  // `ready: 3000` is the common case and worth a shorthand.
  if (typeof raw === 'number') {
    const probe = emptyProbe('port');
    probe.port = asPort(raw, where, problems);
    return probe;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const probe = emptyProbe('port');
      probe.port = asPort(Number(trimmed), where, problems);
      return probe;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      const probe = emptyProbe('http');
      probe.url = trimmed;
      return probe;
    }
    problems.add(`${where} as a bare string must be a port number or an http(s) URL`);
    return emptyProbe('none');
  }

  if (!isPlainObject(raw)) {
    problems.add(`${where} must be a port, a URL, false, or a mapping`);
    return emptyProbe('none');
  }

  const timeoutMs = asPositiveInt(raw.timeout, `${where}.timeout`, problems) ?? DEFAULT_PROBE_TIMEOUT_MS;
  const intervalMs = asPositiveInt(raw.interval, `${where}.interval`, problems) ?? DEFAULT_PROBE_INTERVAL_MS;

  const declared = ['port', 'http', 'log', 'file', 'delay', 'settle'].filter((key) => raw[key] !== undefined);
  if (declared.length > 1) {
    problems.add(`${where} declares multiple signals (${declared.join(', ')}); pick one`);
  }

  const finish = (probe: ReadyProbe): ReadyProbe => {
    probe.timeoutMs = timeoutMs;
    probe.intervalMs = intervalMs;
    return probe;
  };

  if (raw.port !== undefined) {
    const probe = emptyProbe('port');
    probe.port = asPort(raw.port, `${where}.port`, problems);
    if (typeof raw.host === 'string' && raw.host.trim().length > 0) probe.host = raw.host.trim();
    return finish(probe);
  }

  if (raw.http !== undefined) {
    const probe = emptyProbe('http');
    if (typeof raw.http !== 'string' || !/^https?:\/\//i.test(raw.http)) {
      problems.add(`${where}.http must be an http(s) URL`);
    } else {
      probe.url = raw.http;
    }
    probe.maxStatus = asPositiveInt(raw.status, `${where}.status`, problems);
    return finish(probe);
  }

  if (raw.log !== undefined) {
    const probe = emptyProbe('log');
    if (typeof raw.log !== 'string' || raw.log.length === 0) {
      problems.add(`${where}.log must be a non-empty regular expression`);
    } else {
      try {
        new RegExp(raw.log, 'i');
        probe.logPattern = raw.log;
      } catch (error) {
        problems.add(`${where}.log is not a valid regular expression: ${(error as Error).message}`);
      }
    }
    return finish(probe);
  }

  if (raw.file !== undefined) {
    const probe = emptyProbe('file');
    if (typeof raw.file !== 'string' || raw.file.trim().length === 0) {
      problems.add(`${where}.file must be a path`);
    } else {
      probe.file = path.resolve(processCwd, raw.file.trim());
      void root;
    }
    return finish(probe);
  }

  const delay = raw.delay ?? raw.settle;
  if (delay !== undefined) {
    const probe = emptyProbe('settle');
    probe.settleMs = asPositiveInt(delay, `${where}.delay`, problems) ?? DEFAULT_SETTLE_MS;
    return finish(probe);
  }

  const probe = emptyProbe('settle');
  probe.settleMs = DEFAULT_SETTLE_MS;
  return finish(probe);
}

function parseProcess(
  id: string,
  raw: unknown,
  root: string,
  problems: Problems,
): ProcessConfig | undefined {
  const where = `processes.${id}`;

  if (!PROCESS_ID_PATTERN.test(id)) {
    problems.add(`${where}: process id must start alphanumeric and contain only letters, digits, . _ -`);
    return undefined;
  }

  // Shorthand: `web: npm run dev`
  const object: Record<string, unknown> = typeof raw === 'string' ? { command: raw } : isPlainObject(raw) ? raw : {};
  if (typeof raw !== 'string' && !isPlainObject(raw)) {
    problems.add(`${where} must be a command string or a mapping`);
    return undefined;
  }

  const command = object.command ?? object.cmd ?? object.run;
  if (typeof command !== 'string' || command.trim().length === 0) {
    problems.add(`${where}.command is required and must be a non-empty string`);
    return undefined;
  }

  let cwd = root;
  if (object.cwd !== undefined) {
    if (typeof object.cwd !== 'string' || object.cwd.trim().length === 0) {
      problems.add(`${where}.cwd must be a path relative to the project root`);
    } else {
      cwd = resolveInsideRoot(object.cwd.trim(), root, `${where}.cwd`, problems) ?? root;
    }
  }

  let kind: ProcessKind = 'service';
  const rawKind = object.kind ?? object.type;
  if (rawKind !== undefined) {
    if (rawKind === 'service' || rawKind === 'task') kind = rawKind;
    else problems.add(`${where}.kind must be "service" or "task"`);
  } else if (asBool(object.oneshot, `${where}.oneshot`, problems, false)) {
    kind = 'task';
  }

  const needs = asStringList(object.needs ?? object.after ?? object.depends_on, `${where}.needs`, problems);

  const ports: number[] = [];
  let declaredPort: number | undefined;
  if (object.port !== undefined) {
    const port = asPort(object.port, `${where}.port`, problems);
    if (port !== undefined) {
      ports.push(port);
      declaredPort = port;
    }
  }
  if (object.ports !== undefined) {
    if (!Array.isArray(object.ports)) {
      problems.add(`${where}.ports must be a list of port numbers`);
    } else {
      object.ports.forEach((entry, i) => {
        const port = asPort(entry, `${where}.ports[${i}]`, problems);
        if (port !== undefined) ports.push(port);
      });
    }
  }

  const ready = parseReady(object.ready, kind, root, cwd, `${where}.ready`, problems);
  // A declared port probe is also a port this process owns, which feeds pre-flight.
  if (ready.kind === 'port' && ready.port !== undefined && !ports.includes(ready.port)) {
    ports.push(ready.port);
  }

  let restart: RestartPolicy = kind === 'task' ? 'no' : 'on-failure';
  if (object.restart !== undefined) {
    const value = object.restart === true ? 'always' : object.restart === false ? 'no' : object.restart;
    if (typeof value === 'string' && (RESTART_POLICIES as readonly string[]).includes(value)) {
      restart = value as RestartPolicy;
    } else {
      problems.add(`${where}.restart must be one of: ${RESTART_POLICIES.join(', ')}`);
    }
  }

  let open: string | undefined;
  if (object.open !== undefined && object.open !== false) {
    if (object.open === true) {
      const port = ports[0];
      if (port === undefined) {
        problems.add(`${where}.open: true needs a port or an explicit URL to open`);
      } else {
        open = `http://localhost:${port}`;
      }
    } else if (typeof object.open === 'string' && object.open.trim().length > 0) {
      // Restricted to http(s) deliberately. This value is handed to the
      // platform's URL handler, and a warpline.yml travels with any repository
      // a user clones, so an unrestricted string would let a custom protocol
      // handler or a `file:` read ride along.
      const candidate = object.open.trim();
      if (isHttpUrl(candidate)) {
        open = candidate;
      } else {
        problems.add(`${where}.open must be an http(s) URL (got "${candidate}")`);
      }
    } else {
      problems.add(`${where}.open must be true or a URL string`);
    }
  }

  let shell: string | undefined;
  if (object.shell !== undefined) {
    if (typeof object.shell === 'string' && object.shell.trim().length > 0) shell = object.shell.trim();
    else problems.add(`${where}.shell must be a path to a shell executable`);
  }

  const label = typeof object.label === 'string' && object.label.trim().length > 0 ? object.label.trim() : id;

  return {
    id,
    command: command.trim(),
    cwd,
    kind,
    needs,
    ready,
    ports,
    declaredPort,
    env: asVarMap(object.env, `${where}.env`, problems),
    restart,
    maxRestarts: asPositiveInt(object.maxRestarts ?? object.max_restarts, `${where}.maxRestarts`, problems) ?? 3,
    backoffMs: asPositiveInt(object.backoff, `${where}.backoff`, problems) ?? 500,
    open,
    optional: asBool(object.optional, `${where}.optional`, problems, false),
    label,
    stopTimeoutMs: asPositiveInt(object.stopTimeout ?? object.stop_timeout, `${where}.stopTimeout`, problems) ?? 8000,
    shell,
  };
}

function parseProcesses(raw: unknown, root: string, problems: Problems): ProcessConfig[] {
  const result: ProcessConfig[] = [];

  if (raw === undefined || raw === null) {
    problems.add('processes is required and must define at least one process');
    return result;
  }

  if (Array.isArray(raw)) {
    // List form, where each entry carries its own id/name.
    raw.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        problems.add(`processes[${index}] must be a mapping with a name`);
        return;
      }
      const id = entry.id ?? entry.name;
      if (typeof id !== 'string' || id.trim().length === 0) {
        problems.add(`processes[${index}] needs a "name"`);
        return;
      }
      const parsed = parseProcess(id.trim(), entry, root, problems);
      if (parsed) result.push(parsed);
    });
  } else if (isPlainObject(raw)) {
    for (const [id, entry] of Object.entries(raw)) {
      const parsed = parseProcess(id, entry, root, problems);
      if (parsed) result.push(parsed);
    }
  } else {
    problems.add('processes must be a mapping of name -> command, or a list');
    return result;
  }

  const seen = new Set<string>();
  for (const proc of result) {
    if (seen.has(proc.id)) problems.add(`processes.${proc.id} is declared more than once`);
    seen.add(proc.id);
  }

  // `needs` must point at something real, and nothing may depend on itself.
  for (const proc of result) {
    for (const need of proc.needs) {
      if (need === proc.id) {
        problems.add(`processes.${proc.id}.needs cannot reference itself`);
      } else if (!seen.has(need)) {
        problems.add(`processes.${proc.id}.needs references unknown process "${need}"`);
      }
    }
  }

  if (result.length === 0 && problems.ok) {
    problems.add('processes must define at least one process');
  }

  return result;
}

/**
 * Validates and normalizes raw config data into a fully-defaulted
 * `WarplineConfig`. Throws `ConfigError` carrying every problem found.
 */
export function normalizeConfig(raw: unknown, configFile: string, fallbackName: string): WarplineConfig {
  const problems = new Problems();
  const root = path.dirname(configFile);

  if (!isPlainObject(raw)) {
    throw new ConfigError(configFile, ['the config file must contain a mapping at the top level']);
  }

  const knownKeys = new Set([
    'name',
    'note',
    'env',
    'hooks',
    'processes',
    'version',
    '$schema',
  ]);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      problems.add(`unknown top-level key "${key}" (expected: ${[...knownKeys].filter((k) => k !== '$schema').join(', ')})`);
    }
  }

  let name = fallbackName;
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
      problems.add('name must be a non-empty string');
    } else {
      name = raw.name.trim();
    }
  }

  let note: string | undefined;
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== 'string') problems.add('note must be a string');
    else if (raw.note.trim().length > 0) note = raw.note.trim();
  }

  let version = CONFIG_VERSION;
  if (raw.version !== undefined) {
    const parsed = asPositiveInt(raw.version, 'version', problems);
    if (parsed !== undefined) {
      if (parsed > CONFIG_VERSION) {
        problems.add(`version ${parsed} is newer than this Warpline understands (max ${CONFIG_VERSION}); upgrade warpline`);
      }
      version = parsed;
    }
  }

  const config: WarplineConfig = {
    name,
    note,
    env: parseEnv(raw.env, problems),
    hooks: parseHooks(raw.hooks, problems),
    processes: parseProcesses(raw.processes, root, problems),
    root,
    configFile,
    version,
  };

  if (!problems.ok) throw new ConfigError(configFile, problems.items);
  return config;
}
