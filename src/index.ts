/**
 * Programmatic entry point. Warpline is primarily a CLI, but the pieces are
 * exported so they can be embedded in other tooling or tested directly.
 */
export { runCli, reportError } from './cli.js';
export { getVersion } from './version.js';

export type {
  WarplineConfig,
  ProcessConfig,
  EnvConfig,
  HooksConfig,
  ReadyProbe,
  RestartPolicy,
  ProcessKind,
} from './config/types.js';

export { loadConfigFile, loadConfigFrom, findConfigFile } from './config/load.js';
export { normalizeConfig, CONFIG_VERSION } from './config/schema.js';

export { detectProject } from './detect/candidates.js';
export type { DetectionResult, ProcessCandidate } from './detect/candidates.js';

export { resolveEnv, maskValue, looksSecret } from './env/resolve.js';
export { parseDotenv, expandValue } from './env/dotenv.js';

export { Supervisor } from './proc/supervisor.js';
export type { SupervisorOptions, StartOutcome } from './proc/supervisor.js';
export { ProcessLogger } from './proc/logger.js';
export { selectProcesses, startWaves, shutdownOrder, findDependencyCycle } from './proc/graph.js';
export { checkPortConflicts, findPortOwner, isPortListening } from './proc/ports.js';
export { terminateTree, spawnShellCommand } from './proc/spawn.js';

export { listProjects, getProject, upsertProject, removeProject } from './state/registry.js';
export { inspectRuntime, isProjectRunning, listRuntimeNames } from './state/runtime.js';

export { WarplineError, ConfigError } from './core/errors.js';
