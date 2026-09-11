/**
 * The resolved, fully-defaulted shape of a `warpline.yml`. Everything in here is
 * safe to commit to a repo: env *values* are never stored, only references to
 * env files plus an allowlist of names to inherit from the shell.
 */
export interface WarplineConfig {
  /** Default name used when registering the project in the global index. */
  name: string;
  /** Free-text reminder surfaced on every `warpline up`. */
  note: string | undefined;
  env: EnvConfig;
  hooks: HooksConfig;
  processes: ProcessConfig[];
  /** Absolute path to the directory containing the config file. */
  root: string;
  /** Absolute path to the config file itself. */
  configFile: string;
  /** Schema version, reserved for future migrations. */
  version: number;
}

export interface EnvConfig {
  /**
   * Dotenv-style files, resolved relative to the project root and applied in
   * order (later files win). Missing files are skipped unless listed in
   * `requireFiles`.
   */
  files: string[];
  /** Files whose absence is an error rather than a silent skip. */
  requireFiles: string[];
  /** Literal key/values. Intended for non-secret config like NODE_ENV. */
  vars: Record<string, string>;
  /**
   * Names inherited from the invoking shell. Warpline passes through a safe
   * platform baseline (PATH, HOME, etc.) plus anything listed here.
   */
  passthrough: string[];
  /** Variables that must be non-empty after resolution, or `up` refuses to start. */
  require: string[];
  /** When true, only the platform baseline plus explicit config reaches children. */
  isolate: boolean;
}

export interface HooksConfig {
  /** Runs once, to completion, before any process starts. */
  before: string[];
  /** Runs once after every process has reached ready. */
  after: string[];
  /** Runs once during shutdown, after processes are stopped. */
  cleanup: string[];
}

export type RestartPolicy = 'no' | 'on-failure' | 'always';

/** `service` stays up; `task` is expected to exit 0 and gates its dependents. */
export type ProcessKind = 'service' | 'task';

export interface ProcessConfig {
  id: string;
  command: string;
  /** Absolute, already resolved against the project root. */
  cwd: string;
  kind: ProcessKind;
  /** Process ids that must be ready before this one starts. */
  needs: string[];
  ready: ReadyProbe;
  /** Ports this process is expected to bind, used for pre-flight conflict checks. */
  ports: number[];
  /**
   * The port the author wrote in `port:`, as opposed to one inferred from a
   * readiness probe. Only this one is injected as `PORT`, so Warpline never
   * rewrites the environment of a process that merely happens to be probed.
   */
  declaredPort: number | undefined;
  env: Record<string, string>;
  restart: RestartPolicy;
  maxRestarts: number;
  /** Base delay for exponential restart backoff. */
  backoffMs: number;
  /** URL opened in the browser once the process reports ready. */
  open: string | undefined;
  /** Excluded from a bare `warpline up`; must be requested with `--only`. */
  optional: boolean;
  /** Label used in log prefixes, defaults to the id. */
  label: string;
  /** Milliseconds to wait for a graceful exit before escalating to a hard kill. */
  stopTimeoutMs: number;
  /** Overrides the default shell used to interpret `command`. */
  shell: string | undefined;
}

/**
 * How Warpline decides a process is usable by its dependents. Exactly one signal
 * is meaningful, checked in the order below; `settle` is the fallback when
 * nothing more specific is declared.
 */
export interface ReadyProbe {
  kind: 'settle' | 'port' | 'http' | 'log' | 'file' | 'exit' | 'none';
  /** TCP port for `kind: 'port'`. */
  port: number | undefined;
  /** Host for the TCP probe. Defaults to 127.0.0.1. */
  host: string | undefined;
  /** URL for `kind: 'http'`. */
  url: string | undefined;
  /** Highest HTTP status still considered ready. Defaults to 499. */
  maxStatus: number | undefined;
  /** Regex source matched against combined stdout/stderr for `kind: 'log'`. */
  logPattern: string | undefined;
  /** Absolute path awaited for `kind: 'file'`. */
  file: string | undefined;
  /** Quiet period the process must survive for `kind: 'settle'`. */
  settleMs: number | undefined;
  /** Overall probe budget before the process is declared failed. */
  timeoutMs: number;
  /** Poll interval for port/http/file probes. */
  intervalMs: number;
}

/** Narrow view of a config used by commands that only need identity + paths. */
export interface ProjectRef {
  name: string;
  root: string;
}
