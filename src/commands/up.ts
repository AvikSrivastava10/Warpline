import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { WarplineError } from '../core/errors.js';
import { ensureDir, paths, tildify } from '../core/paths.js';
import { sleep } from '../core/fsx.js';
import { formatDuration, glyph, out, renderTable, theme } from '../core/ui.js';
import { isInteractive, promptConfirm } from '../core/prompt.js';
import { flagBool, flagList, flagNumber, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { parseEnvOverrides, resolveEnv } from '../env/resolve.js';
import { selectProcesses, startWaves } from '../proc/graph.js';
import { checkPortConflicts, isPortListening } from '../proc/ports.js';
import { terminateTree } from '../proc/spawn.js';
import { ProcessLogger } from '../proc/logger.js';
import { Supervisor } from '../proc/supervisor.js';
import { inspectRuntime, reconcileRuntime, clearRuntime, isPidAlive, type ProcessRuntime } from '../state/runtime.js';
import { touchProject, upsertProject } from '../state/registry.js';
import { resolveProject } from './context.js';
import type { ProcessConfig, WarplineConfig } from '../config/types.js';

export const upFlags: FlagSpecs = {
  only: { type: 'list', alias: 'o', describe: 'Start only these processes (dependencies are pulled in automatically)' },
  except: { type: 'list', alias: 'x', describe: 'Start everything except these processes' },
  detach: { type: 'boolean', alias: 'd', describe: 'Run in the background and return once everything is ready' },
  'dry-run': { type: 'boolean', describe: 'Show the start plan without running anything' },
  restart: { type: 'boolean', alias: 'r', describe: 'Stop the project first if it is already running' },
  force: { type: 'boolean', alias: 'f', describe: 'Start even if a declared port is already in use' },
  'kill-port': { type: 'boolean', describe: 'Terminate whatever already holds a declared port (asks first)' },
  'keep-going': { type: 'boolean', alias: 'k', describe: 'Keep running the rest when one process fails' },
  open: { type: 'boolean', describe: 'Open configured URLs once their process is ready' },
  optional: { type: 'boolean', describe: 'Also start processes marked optional' },
  env: { type: 'list', alias: 'e', describe: 'Extra environment values, as KEY=VALUE' },
  prefix: { type: 'boolean', default: true, describe: 'Prefix log lines with the process name (--no-prefix to disable)' },
  timestamps: { type: 'boolean', alias: 'T', describe: 'Prefix log lines with a timestamp' },
  timeout: { type: 'number', describe: 'Seconds to wait for readiness in --detach mode (default 120)' },
};

export function upHelp(): string {
  return [
    `${theme.bold('warpline up')} ${theme.dim('[name] [options]')}`,
    '',
    'Starts a saved project: every process in dependency order, with readiness',
    'gating, its env files loaded, and logs multiplexed into one stream.',
    '',
    'With no name, the nearest warpline.yml at or above the current directory is used.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(upFlags),
    '',
    theme.dim('Examples:'),
    `  ${theme.code('warpline up')}                    start the project in this folder`,
    `  ${theme.code('warpline up api-server -d')}      start in the background, return when ready`,
    `  ${theme.code('warpline up --only web')}         start just web, plus whatever it needs`,
    `  ${theme.code('warpline up --dry-run')}          show the plan and exit`,
  ].join('\n');
}

/** Renders the planned start order for `--dry-run`. */
function printPlan(config: WarplineConfig, processes: ProcessConfig[]): void {
  const waves = startWaves(processes);
  out.write(theme.bold('Start plan'));

  waves.forEach((wave, index) => {
    out.write(`${theme.dim(`wave ${index + 1}`)}${wave.length > 1 ? theme.dim(' (in parallel)') : ''}`);
    for (const proc of wave) {
      const bits: string[] = [];
      if (proc.kind === 'task') bits.push('task');
      if (proc.ports.length > 0) bits.push(`port ${proc.ports.join(', ')}`);
      if (proc.needs.length > 0) bits.push(`needs ${proc.needs.join(', ')}`);
      if (proc.restart !== 'no') bits.push(`restart ${proc.restart}`);
      const meta = bits.length > 0 ? theme.dim(`  [${bits.join(` ${glyph.sep} `)}]`) : '';
      out.write(`  ${theme.bold(proc.label)}  ${theme.dim(proc.command)}${meta}`);
      if (proc.cwd !== config.root) {
        out.write(`    ${theme.dim(`in ${tildify(proc.cwd)}`)}`);
      }
    }
  });

  const env = resolveEnv(config, undefined);
  if (env.loadedFiles.length > 0) {
    out.write('');
    out.write(`${theme.dim('env files')}  ${env.loadedFiles.join(', ')}`);
  }
  if (env.missingFiles.length > 0) {
    out.write(`${theme.dim('missing env files')}  ${theme.warn(env.missingFiles.join(', '))}`);
  }
}

/** Blocks startup when a declared port is already taken by something else. */
async function preflightPorts(
  processes: ProcessConfig[],
  options: { force: boolean; killPort: boolean },
): Promise<void> {
  const declared = processes
    .filter((proc) => proc.ports.length > 0)
    .map((proc) => ({ processId: proc.id, ports: proc.ports }));

  if (declared.length === 0) return;

  const conflicts = await checkPortConflicts(declared);
  if (conflicts.length === 0) return;

  for (const conflict of conflicts) {
    const owner = conflict.processName
      ? `${conflict.processName}${conflict.pid ? ` (pid ${conflict.pid})` : ''}`
      : conflict.pid
        ? `pid ${conflict.pid}`
        : 'an unknown process';
    out.warn(`port ${theme.bold(String(conflict.port))} (needed by ${conflict.processId}) is already held by ${owner}`);
  }

  if (options.killPort) {
    const targets = conflicts.filter((conflict) => conflict.pid !== undefined);
    if (targets.length === 0) {
      throw new WarplineError('Could not identify which process holds the port, so --kill-port cannot help', {
        hint: 'Stop it manually, or pass --force to start anyway.',
      });
    }

    // Killing an unrelated process is destructive and easy to regret, so it is
    // confirmed even though the flag was passed explicitly.
    if (isInteractive()) {
      const list = targets.map((t) => `${t.processName ?? 'process'} (pid ${t.pid}) on :${t.port}`).join(', ');
      const confirmed = await promptConfirm(`Terminate ${list}?`, false);
      if (!confirmed) throw new WarplineError('Cancelled');
    }

    for (const target of targets) {
      const result = await terminateTree(target.pid, { graceMs: 5000 });
      if (!result.exited) {
        out.warn(`could not stop the process on port ${target.port}`);
        continue;
      }

      // A dead process does not mean a free socket: the kernel can hold the
      // port briefly after the owner exits. Starting immediately here is how you
      // get an EADDRINUSE crash loop moments after "freed port 3000".
      const released = await waitForPortRelease(target.port, 5000);
      if (released) out.success(`freed port ${target.port}`);
      else out.warn(`port ${target.port} is still held; the new process may fail to bind`);
    }
    return;
  }

  if (!options.force) {
    throw new WarplineError(`Port${conflicts.length > 1 ? 's' : ''} already in use: ${conflicts.map((c) => c.port).join(', ')}`, {
      hint: 'Stop the other process, or use --kill-port to free it, or --force to start anyway.',
    });
  }

  out.warn('starting anyway because --force was passed');
}

/** Polls until nothing is listening on a port, or the budget runs out. */
async function waitForPortRelease(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isPortListening(port))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

/** Bails out early when a required variable resolves to nothing. */
function preflightEnv(config: WarplineConfig, overrides: Record<string, string>): void {
  const resolved = resolveEnv(config, undefined, { overrides });
  if (resolved.missingRequired.length === 0) return;

  const templateHint = config.env.files.length > 0 ? ` Checked: ${config.env.files.join(', ')}.` : '';
  throw new WarplineError(`Required environment variable(s) missing: ${resolved.missingRequired.join(', ')}`, {
    hint: `Set them in an env file or pass --env KEY=VALUE.${templateHint}`,
  });
}

function describeRunning(processes: ProcessRuntime[]): void {
  const rows = processes.map((proc) => [
    theme.bold(proc.label),
    proc.status === 'ready' ? theme.ok(proc.status) : proc.status,
    proc.pid ? String(proc.pid) : '-',
    proc.ports.length > 0 ? proc.ports.join(', ') : '-',
    proc.startedAt ? formatDuration(Date.now() - proc.startedAt) : '-',
  ]);

  out.write(
    renderTable(
      [{ header: 'process' }, { header: 'status' }, { header: 'pid', align: 'right' }, { header: 'ports' }, { header: 'uptime', align: 'right' }],
      rows,
    ),
  );
}

/** Prints the "everything is up" summary with the URLs worth clicking. */
function printReadySummary(name: string, processes: ProcessConfig[], elapsedMs: number): void {
  out.blank();
  out.write(`${theme.ok(glyph.ok)} ${theme.bold(theme.accent(name))} is up ${theme.dim(`in ${formatDuration(elapsedMs)}`)}`);

  const urls = processes
    .filter((proc) => proc.ports.length > 0 || proc.open)
    .map((proc) => ({
      label: proc.label,
      url: proc.open ?? `http://localhost:${proc.ports[0]}`,
    }));

  if (urls.length > 0) {
    for (const entry of urls) {
      out.write(`  ${theme.dim(glyph.dot)} ${entry.label.padEnd(12)} ${theme.info(entry.url)}`);
    }
  }
}

export async function runUp(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, upFlags);
  const project = await resolveProject(parsed.positionals[0]);
  const { config, name } = project;

  const overrides = parseEnvOverrides(flagList(parsed, 'env'));
  const processes = selectProcesses(config.processes, {
    only: flagList(parsed, 'only'),
    except: flagList(parsed, 'except'),
    includeOptional: flagBool(parsed, 'optional'),
  });

  if (flagBool(parsed, 'dry-run')) {
    printPlan(config, processes);
    return 0;
  }

  // Reconcile before deciding anything: a state file left behind by a reboot
  // must not be mistaken for a live project.
  const existing = reconcileRuntime(name);
  if (existing && existing.live.length > 0) {
    if (flagBool(parsed, 'restart')) {
      out.step(`stopping ${theme.bold(name)} before restarting`);
      await stopLiveProcesses(existing.live);
      clearRuntime(name);
    } else {
      out.warn(`${theme.bold(theme.accent(name))} is already running`);
      out.blank();
      describeRunning(existing.live);
      out.blank();
      out.note(
        `${theme.code(`warpline logs ${name}`)} to follow output ${glyph.sep} ${theme.code(`warpline restart ${name}`)} to restart ${glyph.sep} ${theme.code(`warpline down ${name}`)} to stop`,
      );
      return 0;
    }
  }

  preflightEnv(config, overrides);
  await preflightPorts(processes, {
    force: flagBool(parsed, 'force'),
    killPort: flagBool(parsed, 'kill-port'),
  });

  // Keep the index in sync so `warpline list` knows about a project started
  // straight from its directory without an explicit `link`.
  await upsertProject(name, config.root);
  await touchProject(name);

  if (config.note) {
    out.blank();
    out.write(`${theme.warn(glyph.warn)} ${theme.bold('note')} ${config.note}`);
  }

  if (flagBool(parsed, 'detach')) {
    return startDetached(name, config, parsed, overrides, processes);
  }

  return startForeground(name, config, parsed, overrides, processes);
}

async function stopLiveProcesses(live: ProcessRuntime[]): Promise<void> {
  // Reverse recorded order approximates reverse dependency order well enough
  // for a stop-before-restart, and does not require the config to be loadable.
  for (const proc of [...live].reverse()) {
    await terminateTree(proc.pid, { graceMs: 8000 });
  }
}

async function startForeground(
  name: string,
  config: WarplineConfig,
  parsed: ReturnType<typeof parseArgs>,
  overrides: Record<string, string>,
  processes: ProcessConfig[],
): Promise<number> {
  const logger = new ProcessLogger({
    projectName: name,
    toConsole: true,
    prefix: flagBool(parsed, 'prefix'),
    timestamps: flagBool(parsed, 'timestamps'),
  });

  const supervisor = new Supervisor({
    config,
    projectName: name,
    processes,
    mode: 'foreground',
    logger,
    envOverrides: overrides,
    openBrowser: flagBool(parsed, 'open'),
    keepGoing: flagBool(parsed, 'keep-going'),
  });

  let interrupted = false;
  let forceExits = 0;

  const onSignal = (): void => {
    forceExits += 1;
    if (forceExits > 1) {
      // Second Ctrl-C means the user is done waiting for a graceful stop.
      out.blank();
      out.warn('forcing exit; some child processes may survive');
      process.exit(130);
    }
    interrupted = true;
    void supervisor.stopAll('interrupted');
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  if (process.platform === 'win32') process.on('SIGBREAK', onSignal);

  try {
    const outcome = await supervisor.start();

    if (!outcome.ok) {
      out.blank();
      for (const failure of outcome.failures) {
        out.error(`${theme.bold(failure.id)}: ${failure.reason}`);
      }

      if (!flagBool(parsed, 'keep-going')) {
        await supervisor.stopAll('startup failed');
        await logger.close();
        out.blank();
        out.note(`Full logs: ${theme.code(`warpline logs ${name}`)}`);
        return 1;
      }
    }

    if (outcome.ok) {
      printReadySummary(name, processes, outcome.elapsedMs);
      const services = processes.filter((proc) => proc.kind === 'service');
      if (services.length > 0) {
        out.blank();
        out.note(`Ctrl-C to stop everything ${glyph.sep} logs are also at ${tildify(paths.logDir(name))}`);
        out.blank();
      }
    }

    // Hold the terminal until every service is gone (or the user interrupts).
    await supervisor.waitForCompletion();

    if (!supervisor.isShuttingDown) await supervisor.stopAll('all processes exited');
    await logger.close();

    if (interrupted) {
      out.success(`${theme.bold(name)} stopped`);
      return 0;
    }

    const failed = supervisor.summary().some((entry) => entry.status === 'failed');
    return failed ? 1 : 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (process.platform === 'win32') process.off('SIGBREAK', onSignal);
  }
}

/**
 * Detached mode re-invokes this same binary as a supervisor child, then waits
 * on the state file until everything is ready.
 *
 * A separate supervisor process is what allows `up -d` to survive the terminal
 * closing while still keeping a single owner for the process tree, so
 * `warpline down` and `warpline status` continue to work against it.
 */
async function startDetached(
  name: string,
  config: WarplineConfig,
  parsed: ReturnType<typeof parseArgs>,
  overrides: Record<string, string>,
  processes: ProcessConfig[],
): Promise<number> {
  // Drop any state from a previous session before the supervisor starts.
  // Without this, the poll below can read the last run's results, see everything
  // already "settled", and report success before the new supervisor has done
  // anything at all.
  clearRuntime(name);

  ensureDir(paths.runDir());
  const supervisorLog = paths.supervisorLog(name);
  // Separate descriptors for stdout and stderr: sharing one fd across both
  // stdio slots is not reliable across platforms.
  const outFd = fs.openSync(supervisorLog, 'a');
  const errFd = fs.openSync(supervisorLog, 'a');

  const binPath = fileURLToPath(new URL('../bin.js', import.meta.url));
  const args = [
    binPath,
    '__supervise',
    '--name',
    name,
    '--config',
    config.configFile,
    ...processes.flatMap((proc) => ['--process', proc.id]),
    ...Object.entries(overrides).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
  ];
  if (flagBool(parsed, 'keep-going')) args.push('--keep-going');
  if (flagBool(parsed, 'open')) args.push('--open');

  // The supervisor itself must outlive this launcher, so it is detached even on
  // Windows. Its stdio goes to real files rather than pipes, so the Windows
  // "own console" behaviour does not cost us any output.
  const launchedAt = Date.now();
  const child = spawn(process.execPath, args, {
    cwd: config.root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
  });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  if (child.pid === undefined) {
    throw new WarplineError('Could not start the background supervisor');
  }

  out.step(`supervisor started ${theme.dim(`(pid ${child.pid})`)}`);

  const timeoutMs = (flagNumber(parsed, 'timeout') ?? 120) * 1000;
  const deadline = Date.now() + timeoutMs;
  const expected = new Set(processes.map((proc) => proc.id));

  // Poll the state file the supervisor writes. Polling rather than IPC keeps
  // the supervisor independent of its launcher: it behaves identically whether
  // it was started by `up -d` or is being inspected later by `status`.
  const settledStatuses = new Set(['ready', 'done', 'failed', 'stopped', 'skipped']);

  for (;;) {
    await sleep(250);
    const info = inspectRuntime(name);

    if (info) {
      const entries = Object.values(info.state.processes).filter((proc) => expected.has(proc.id));
      const settled = entries.filter((proc) => settledStatuses.has(proc.status));

      if (entries.length > 0 && settled.length === entries.length) {
        const failures = entries.filter((proc) => proc.status === 'failed' || proc.status === 'skipped');

        if (failures.length === 0) {
          out.blank();
          // Measured from launch rather than from state, so the number cannot be
          // skewed by whatever the state file happened to contain.
          printReadySummary(name, processes, Date.now() - launchedAt);
          out.blank();
          out.note(
            `${theme.code(`warpline logs ${name} -f`)} to follow ${glyph.sep} ${theme.code(`warpline down ${name}`)} to stop`,
          );
          return 0;
        }

        out.blank();
        for (const failure of failures) {
          out.error(`${theme.bold(failure.label)}: ${failure.message ?? failure.status}`);
        }
        out.blank();
        out.note(`Logs: ${theme.code(`warpline logs ${name}`)}`);
        return 1;
      }
    }

    // The supervisor dying without ever writing state means it failed during
    // startup, before it could report anything useful.
    if (!info && !isPidAlive(child.pid)) {
      throw new WarplineError('The background supervisor exited before reporting any state', {
        hint: `Check ${tildify(supervisorLog)} for details.`,
      });
    }

    if (Date.now() > deadline) {
      out.warn(`still not ready after ${formatDuration(timeoutMs)}; leaving it running in the background`);
      out.note(`Check with ${theme.code(`warpline status ${name}`)}`);
      return 0;
    }
  }
}
