import { WarplineError } from '../core/errors.js';
import type { ProcessConfig } from '../config/types.js';

/**
 * Depth-first cycle detection. Reported as the actual path
 * (`api -> worker -> api`) because "there is a cycle" without the path is
 * useless in a config with a dozen processes.
 */
export function findDependencyCycle(processes: ProcessConfig[]): string[] | undefined {
  const byId = new Map(processes.map((proc) => [proc.id, proc]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const walk = (id: string): string[] | undefined => {
    if (visited.has(id)) return undefined;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start >= 0 ? start : 0), id];
    }

    visiting.add(id);
    stack.push(id);

    for (const need of byId.get(id)?.needs ?? []) {
      if (!byId.has(need)) continue;
      const cycle = walk(need);
      if (cycle) return cycle;
    }

    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };

  for (const proc of processes) {
    const cycle = walk(proc.id);
    if (cycle) return cycle;
  }
  return undefined;
}

export function assertAcyclic(processes: ProcessConfig[]): void {
  const cycle = findDependencyCycle(processes);
  if (cycle) {
    throw new WarplineError(`Circular dependency: ${cycle.join(' -> ')}`, {
      hint: 'Remove one of the `needs` entries in that chain.',
    });
  }
}

/**
 * Expands a selection to include every dependency it needs, transitively.
 * `warpline up --only web` has to bring the database with it or the selection is
 * a trap rather than a shortcut.
 */
export function withDependencies(processes: ProcessConfig[], selectedIds: Iterable<string>): Set<string> {
  const byId = new Map(processes.map((proc) => [proc.id, proc]));
  const result = new Set<string>();

  const visit = (id: string): void => {
    if (result.has(id)) return;
    const proc = byId.get(id);
    if (!proc) return;
    result.add(id);
    for (const need of proc.needs) visit(need);
  };

  for (const id of selectedIds) visit(id);
  return result;
}

/**
 * Groups processes into start waves. The supervisor does not need this to run
 * (it awaits dependencies individually for maximum parallelism), but it makes
 * the planned start order printable, which matters for `warpline up --dry-run`.
 */
export function startWaves(processes: ProcessConfig[]): ProcessConfig[][] {
  assertAcyclic(processes);

  const remaining = new Map(processes.map((proc) => [proc.id, proc]));
  const done = new Set<string>();
  const waves: ProcessConfig[][] = [];

  while (remaining.size > 0) {
    const wave = [...remaining.values()].filter((proc) =>
      proc.needs.every((need) => done.has(need) || !remaining.has(need)),
    );

    // Guarded by assertAcyclic above, but a defensive break beats a hang.
    if (wave.length === 0) {
      waves.push([...remaining.values()]);
      break;
    }

    for (const proc of wave) {
      remaining.delete(proc.id);
    }
    for (const proc of wave) {
      done.add(proc.id);
    }
    waves.push(wave);
  }

  return waves;
}

/** Reverse start order, so dependents shut down before what they depend on. */
export function shutdownOrder(processes: ProcessConfig[]): ProcessConfig[] {
  return startWaves(processes).reverse().flat();
}

export interface SelectionOptions {
  only: string[];
  except: string[];
  /** Include processes marked `optional: true`. */
  includeOptional: boolean;
}

/**
 * Resolves `--only` / `--except` into a concrete process list, validating names
 * so a typo produces an error instead of silently starting nothing.
 */
export function selectProcesses(all: ProcessConfig[], options: SelectionOptions): ProcessConfig[] {
  const byId = new Map(all.map((proc) => [proc.id, proc]));

  const unknown = [...options.only, ...options.except].filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new WarplineError(`Unknown process name(s): ${unknown.join(', ')}`, {
      hint: `Available: ${all.map((proc) => proc.id).join(', ')}`,
    });
  }

  let selected: Set<string>;
  if (options.only.length > 0) {
    // An explicit --only implies the user wants those processes even if optional.
    selected = withDependencies(all, options.only);
  } else {
    selected = new Set(
      all.filter((proc) => options.includeOptional || !proc.optional).map((proc) => proc.id),
    );
  }

  for (const id of options.except) selected.delete(id);

  const result = all.filter((proc) => selected.has(proc.id));

  if (result.length === 0) {
    throw new WarplineError('No processes left to start after applying --only/--except', {
      hint: `Available: ${all.map((proc) => proc.id).join(', ')}`,
    });
  }

  // Starting a process without a dependency it needs would make it hang forever
  // waiting on a readiness signal that never arrives. Two different mistakes end
  // up here, and naming the wrong one sends the user looking for a flag they did
  // not use, so the hint distinguishes them.
  for (const proc of result) {
    for (const need of proc.needs) {
      if (selected.has(need)) continue;

      const removedByExcept = options.except.includes(need);
      throw new WarplineError(`"${proc.id}" needs "${need}", which is not part of this run`, {
        hint: removedByExcept
          ? `Drop "${need}" from --except, or add it to --only.`
          : `"${need}" is marked optional, so a plain start skips it. Add --only ${need}, or remove \`optional: true\` from it.`,
      });
    }
  }

  return result;
}
