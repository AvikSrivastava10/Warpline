import { flagBool, flagList, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { glyph, out, theme } from '../core/ui.js';
import { terminateTree } from '../proc/spawn.js';
import { shutdownOrder } from '../proc/graph.js';
import {
  clearRuntime,
  inspectRuntime,
  isPidAlive,
  writeRuntime,
  type ProcessRuntime,
} from '../state/runtime.js';
import { resolveProjectLoosely } from './context.js';

export const downFlags: FlagSpecs = {
  only: { type: 'list', alias: 'o', describe: 'Stop only these processes' },
  all: { type: 'boolean', alias: 'a', describe: 'Stop every running warpline project' },
  force: { type: 'boolean', alias: 'f', describe: 'Skip the grace period and kill immediately' },
  orphans: { type: 'boolean', describe: 'Find and stop supervisors warpline has lost track of' },
};

export function downHelp(): string {
  return [
    `${theme.bold('warpline down')} ${theme.dim('[name] [options]')}`,
    '',
    'Stops a running project. Processes are stopped in reverse dependency order,',
    'so nothing is left talking to a service that has already gone away.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(downFlags),
  ].join('\n');
}

/**
 * Stops recorded processes. Works from the state file alone, so a project whose
 * `warpline.yml` was deleted or broken since it started can still be shut down.
 */
async function stopProject(
  name: string,
  options: { only: string[]; force: boolean; orderedIds: string[] | undefined },
): Promise<{ stopped: number; forced: number }> {
  const info = inspectRuntime(name);
  if (!info) {
    out.note(`${theme.bold(name)} is not running`);
    return { stopped: 0, forced: 0 };
  }

  const wanted = new Set(options.only);
  const candidates = Object.values(info.state.processes).filter(
    (proc) => (wanted.size === 0 || wanted.has(proc.id)) && isPidAlive(proc.pid),
  );

  if (candidates.length === 0) {
    out.note(`${theme.bold(name)} has nothing running`);
    if (wanted.size === 0) clearRuntime(name);
    return { stopped: 0, forced: 0 };
  }

  // Prefer the config's reverse dependency order; fall back to reverse start
  // order when the config is unavailable.
  const order = options.orderedIds
    ? [...candidates].sort(
        (a, b) => (options.orderedIds as string[]).indexOf(a.id) - (options.orderedIds as string[]).indexOf(b.id),
      )
    : [...candidates].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  let stopped = 0;
  let forced = 0;

  for (const proc of order) {
    const result = await terminateTree(proc.pid, { graceMs: options.force ? 0 : 8000 });
    const entry = info.state.processes[proc.id];
    if (entry) {
      entry.status = 'stopped';
      entry.pid = undefined;
      entry.message = result.forced ? 'force killed' : 'stopped by warpline down';
    }
    if (result.exited) stopped += 1;
    if (result.forced) forced += 1;
    out.write(
      result.forced
        ? `${theme.warn(glyph.warn)} ${proc.label} ${theme.dim('force killed')}`
        : `${theme.ok(glyph.ok)} ${proc.label} ${theme.dim('stopped')}`,
    );
  }

  const stillAlive = Object.values(info.state.processes).some((proc) => isPidAlive(proc.pid));

  // A detached supervisor with no children left should not linger.
  if (!stillAlive && isPidAlive(info.state.supervisorPid) && info.state.supervisorPid !== process.pid) {
    await terminateTree(info.state.supervisorPid, { graceMs: 3000 });
  }

  if (stillAlive) writeRuntime(info.state);
  else clearRuntime(name);

  return { stopped, forced };
}

/**
 * Stops supervisors discovered from the OS process table rather than from state.
 * The recovery path for when the two have diverged.
 */
async function stopOrphans(force: boolean): Promise<number> {
  const { discoverSupervisors } = await import('../proc/discover.js');
  const supervisors = await discoverSupervisors();

  if (supervisors.length === 0) {
    out.success('no orphaned supervisors found');
    return 0;
  }

  const orphans = supervisors.filter((entry) => {
    const info = inspectRuntime(entry.projectName);
    // An orphan is a live supervisor that state either does not know about, or
    // records under a different PID.
    return !info || info.state.supervisorPid !== entry.pid;
  });

  if (orphans.length === 0) {
    out.success(`${supervisors.length} supervisor${supervisors.length === 1 ? '' : 's'} running, all accounted for`);
    out.note(`Use ${theme.code('warpline down --all')} to stop them.`);
    return 0;
  }

  for (const orphan of orphans) {
    out.write(
      `${theme.warn(glyph.warn)} orphaned supervisor for ${theme.bold(orphan.projectName)} ${theme.dim(`(pid ${orphan.pid})`)}`,
    );
    const result = await terminateTree(orphan.pid, { graceMs: force ? 0 : 5000 });
    if (result.exited) {
      out.write(`${theme.ok(glyph.ok)} stopped ${theme.dim(`pid ${orphan.pid}`)}`);
      clearRuntime(orphan.projectName);
    } else {
      out.write(`${theme.err(glyph.fail)} could not stop pid ${orphan.pid}`);
    }
  }

  return 0;
}

export async function runDown(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, downFlags);
  const force = flagBool(parsed, 'force');
  const only = flagList(parsed, 'only');

  if (flagBool(parsed, 'orphans')) {
    return stopOrphans(force);
  }

  if (flagBool(parsed, 'all')) {
    const { listRuntimeNames } = await import('../state/runtime.js');
    const names = listRuntimeNames().filter((name) => {
      const info = inspectRuntime(name);
      return Boolean(info && info.live.length > 0);
    });

    if (names.length === 0) {
      out.note('Nothing is running');
      return 0;
    }

    for (const name of names) {
      out.write(theme.bold(theme.accent(name)));
      await stopProject(name, { only: [], force, orderedIds: undefined });
    }
    return 0;
  }

  const project = await resolveProjectLoosely(parsed.positionals[0]);
  const orderedIds = project.config ? shutdownOrder(project.config.processes).map((proc) => proc.id) : undefined;

  const result = await stopProject(project.name, { only, force, orderedIds });

  if (result.stopped > 0) {
    out.blank();
    out.success(
      `${theme.bold(theme.accent(project.name))} stopped${result.forced > 0 ? theme.dim(` (${result.forced} force killed)`) : ''}`,
    );
  }
  return 0;
}

export const restartFlags: FlagSpecs = {
  only: { type: 'list', alias: 'o', describe: 'Restart only these processes' },
  detach: { type: 'boolean', alias: 'd', describe: 'Restart in the background' },
};

export function restartHelp(): string {
  return [
    `${theme.bold('warpline restart')} ${theme.dim('[name] [options]')}`,
    '',
    'Stops the project if it is running, then starts it again.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(restartFlags),
  ].join('\n');
}

export async function runRestart(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, restartFlags);
  const project = await resolveProjectLoosely(parsed.positionals[0]);

  const info = inspectRuntime(project.name);
  if (info && info.live.length > 0) {
    const orderedIds = project.config ? shutdownOrder(project.config.processes).map((proc) => proc.id) : undefined;
    await stopProject(project.name, { only: flagList(parsed, 'only'), force: false, orderedIds });
    out.blank();
  }

  // Delegate to `up` so restart inherits every preflight check rather than
  // duplicating a second, subtly different startup path.
  const { runUp } = await import('./up.js');
  const forwarded = [project.name];
  for (const id of flagList(parsed, 'only')) forwarded.push('--only', id);
  if (flagBool(parsed, 'detach')) forwarded.push('--detach');

  return runUp(forwarded);
}

/** Exposed for `up --restart`. */
export async function stopRecorded(name: string, live: ProcessRuntime[]): Promise<void> {
  for (const proc of [...live].reverse()) {
    await terminateTree(proc.pid, { graceMs: 8000 });
  }
  clearRuntime(name);
}
