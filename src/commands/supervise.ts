import { parseArgs, flagBool, flagString, flagList, type FlagSpecs } from '../core/args.js';
import { WarplineError } from '../core/errors.js';
import { loadConfigFile } from '../config/load.js';
import { parseEnvOverrides } from '../env/resolve.js';
import { ProcessLogger } from '../proc/logger.js';
import { Supervisor } from '../proc/supervisor.js';
import { clearRuntime } from '../state/runtime.js';

/**
 * Internal entry point for detached mode. Not part of the public CLI surface:
 * `warpline up --detach` spawns this, and it becomes the long-lived owner of the
 * process tree so the launching terminal can go away.
 */
export const superviseFlags: FlagSpecs = {
  name: { type: 'string' },
  config: { type: 'string' },
  process: { type: 'list' },
  env: { type: 'list' },
  'keep-going': { type: 'boolean' },
  open: { type: 'boolean' },
};

export async function runSupervise(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, superviseFlags);

  const name = flagString(parsed, 'name');
  const configFile = flagString(parsed, 'config');
  if (!name || !configFile) {
    throw new WarplineError('__supervise requires --name and --config');
  }

  // Refuse to become a second supervisor for the same project. Two supervisors
  // both writing one state file produce genuinely baffling symptoms: flapping
  // status, phantom restart counts, and port fights between their children.
  // The OS process table is the authority here because it stays correct even if
  // the state file has been deleted or corrupted.
  const { discoverSupervisors } = await import('../proc/discover.js');
  const rivals = (await discoverSupervisors()).filter((entry) => entry.projectName === name);
  if (rivals.length > 0) {
    throw new WarplineError(
      `A supervisor for "${name}" is already running (pid ${rivals.map((r) => r.pid).join(', ')})`,
      { hint: `Stop it with \`warpline down ${name}\`, or \`warpline down --orphans\` if warpline has lost track of it.` },
    );
  }

  const config = loadConfigFile(configFile);
  const requested = new Set(flagList(parsed, 'process'));
  const processes =
    requested.size > 0 ? config.processes.filter((proc) => requested.has(proc.id)) : config.processes;

  if (processes.length === 0) {
    throw new WarplineError('No matching processes to supervise');
  }

  // stdout/stderr are already redirected to the supervisor log file by the
  // launcher, so console output here is durable rather than lost.
  const logger = new ProcessLogger({
    projectName: name,
    toConsole: true,
    prefix: true,
    timestamps: true,
  });

  const supervisor = new Supervisor({
    config,
    projectName: name,
    processes,
    mode: 'detached',
    logger,
    envOverrides: parseEnvOverrides(flagList(parsed, 'env')),
    openBrowser: flagBool(parsed, 'open'),
    keepGoing: flagBool(parsed, 'keep-going'),
  });

  let stopping = false;
  const shutdown = (reason: string) => () => {
    if (stopping) return;
    stopping = true;
    void supervisor.stopAll(reason).then(async () => {
      await logger.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown('SIGTERM received'));
  process.on('SIGINT', shutdown('SIGINT received'));
  if (process.platform === 'win32') process.on('SIGBREAK', shutdown('SIGBREAK received'));

  const outcome = await supervisor.start();

  if (!outcome.ok && !flagBool(parsed, 'keep-going')) {
    await supervisor.stopAll('startup failed');
    await logger.close();
    // State is intentionally left in place so `warpline status` can explain the
    // failure after the fact.
    return 1;
  }

  await supervisor.waitForCompletion();

  if (!supervisor.isShuttingDown) {
    await supervisor.stopAll('all processes exited');
  }
  await logger.close();

  const anyFailed = supervisor.summary().some((entry) => entry.status === 'failed');
  if (!anyFailed) clearRuntime(name);

  return anyFailed ? 1 : 0;
}
