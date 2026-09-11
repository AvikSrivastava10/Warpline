import { describe, expect, it } from 'vitest';
import {
  assertAcyclic,
  findDependencyCycle,
  selectProcesses,
  shutdownOrder,
  startWaves,
  withDependencies,
} from '../../src/proc/graph.js';
import { graphOf, processConfig } from '../helpers/factories.js';
import { captureWarplineError } from '../helpers/errors.js';

/** Collapses waves to ids so expectations read as the shape being asserted. */
function waveIds(processes: Parameters<typeof startWaves>[0]): string[][] {
  return startWaves(processes).map((wave) => wave.map((proc) => proc.id));
}

describe('findDependencyCycle', () => {
  it('returns undefined for an acyclic graph', () => {
    expect(findDependencyCycle(graphOf({ db: [], api: ['db'], web: ['api'] }))).toBeUndefined();
  });

  it('reports the path of a multi-step cycle, closing the loop', () => {
    const cycle = findDependencyCycle(graphOf({ a: ['c'], b: ['a'], c: ['b'] }));
    expect(cycle).toBeDefined();
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('reports a two-node cycle', () => {
    const cycle = findDependencyCycle(graphOf({ api: ['worker'], worker: ['api'] }));
    expect(cycle).toEqual(['api', 'worker', 'api']);
  });

  it('ignores dependencies on ids that are not in the graph', () => {
    expect(findDependencyCycle(graphOf({ web: ['nonexistent'] }))).toBeUndefined();
  });

  it('does not mistake a shared dependency for a cycle', () => {
    // A diamond visits `db` twice, which a naive marker would flag.
    expect(findDependencyCycle(graphOf({ db: [], api: ['db'], worker: ['db'], web: ['api', 'worker'] })))
      .toBeUndefined();
  });
});

describe('assertAcyclic', () => {
  it('passes an acyclic graph', () => {
    expect(() => assertAcyclic(graphOf({ db: [], api: ['db'] }))).not.toThrow();
  });

  it('throws with the cycle path in the message', () => {
    expect(() => assertAcyclic(graphOf({ api: ['worker'], worker: ['api'] }))).toThrowError(
      /Circular dependency: api -> worker -> api/,
    );
  });
});

describe('startWaves', () => {
  it('puts a linear chain in one wave per step', () => {
    expect(waveIds(graphOf({ db: [], api: ['db'], web: ['api'] }))).toEqual([['db'], ['api'], ['web']]);
  });

  it('groups independent processes into a single wave', () => {
    expect(waveIds(graphOf({ api: [], web: [], worker: [] }))).toEqual([['api', 'web', 'worker']]);
  });

  it('starts both branches of a diamond together', () => {
    expect(waveIds(graphOf({ db: [], api: ['db'], worker: ['db'], web: ['api', 'worker'] }))).toEqual([
      ['db'],
      ['api', 'worker'],
      ['web'],
    ]);
  });

  it('places a process whose dependency is absent in the first wave', () => {
    expect(waveIds(graphOf({ web: ['missing'] }))).toEqual([['web']]);
  });

  it('refuses a cyclic graph', () => {
    expect(() => startWaves(graphOf({ a: ['b'], b: ['a'] }))).toThrowError(/Circular dependency/);
  });
});

describe('shutdownOrder', () => {
  it('reverses the start order so dependents stop first', () => {
    const order = shutdownOrder(graphOf({ db: [], api: ['db'], web: ['api'] }));
    expect(order.map((proc) => proc.id)).toEqual(['web', 'api', 'db']);
  });

  it('includes every process exactly once', () => {
    const graph = graphOf({ db: [], api: ['db'], worker: ['db'], web: ['api', 'worker'] });
    expect(shutdownOrder(graph)).toHaveLength(4);
  });
});

describe('withDependencies', () => {
  it('pulls in dependencies transitively', () => {
    const graph = graphOf({ db: [], api: ['db'], web: ['api'] });
    expect(withDependencies(graph, ['web'])).toEqual(new Set(['web', 'api', 'db']));
  });

  it('returns just the process when it depends on nothing', () => {
    expect(withDependencies(graphOf({ db: [], api: ['db'] }), ['db'])).toEqual(new Set(['db']));
  });

  it('ignores an unknown id', () => {
    expect(withDependencies(graphOf({ db: [] }), ['nope'])).toEqual(new Set());
  });

  it('terminates even if the graph is cyclic', () => {
    expect(withDependencies(graphOf({ a: ['b'], b: ['a'] }), ['a'])).toEqual(new Set(['a', 'b']));
  });
});

describe('selectProcesses', () => {
  const base = { only: [], except: [], includeOptional: false };
  const graph = [
    processConfig('db'),
    processConfig('api', { needs: ['db'] }),
    processConfig('web', { needs: ['api'] }),
    processConfig('mailhog', { optional: true }),
  ];

  it('takes everything except optional processes by default', () => {
    expect(selectProcesses(graph, base).map((proc) => proc.id)).toEqual(['db', 'api', 'web']);
  });

  it('includes optional processes when asked', () => {
    expect(selectProcesses(graph, { ...base, includeOptional: true }).map((proc) => proc.id)).toEqual([
      'db',
      'api',
      'web',
      'mailhog',
    ]);
  });

  it('preserves declaration order rather than selection order', () => {
    expect(selectProcesses(graph, { ...base, only: ['web', 'db'] }).map((proc) => proc.id)).toEqual([
      'db',
      'api',
      'web',
    ]);
  });

  it('pulls dependencies in behind --only', () => {
    expect(selectProcesses(graph, { ...base, only: ['web'] }).map((proc) => proc.id)).toEqual([
      'db',
      'api',
      'web',
    ]);
  });

  it('honours --only for an optional process without needing --optional', () => {
    expect(selectProcesses(graph, { ...base, only: ['mailhog'] }).map((proc) => proc.id)).toEqual(['mailhog']);
  });

  it('removes a leaf named in --except', () => {
    expect(selectProcesses(graph, { ...base, except: ['web'] }).map((proc) => proc.id)).toEqual(['db', 'api']);
  });

  it('refuses to strand a dependent by excluding what it needs', () => {
    // Silently starting `web` without `api` would hang on a readiness signal
    // that can never arrive.
    expect(() => selectProcesses(graph, { ...base, except: ['api'] })).toThrowError(
      /"web" needs "api", which is not part of this run/,
    );
  });

  it('points at --except in the hint when that is what removed the dependency', () => {
    const error = captureWarplineError(() => selectProcesses(graph, { ...base, except: ['api'] }));
    expect(error.hint).toContain('--except');
  });

  it('applies --except even to something --only pulled in', () => {
    expect(() => selectProcesses(graph, { ...base, only: ['web'], except: ['db'] })).toThrowError(
      /"api" needs "db"/,
    );
  });

  it('blames the optional flag, not --except, when a required process needs an optional one', () => {
    const withOptionalDep = [
      processConfig('mailhog', { optional: true }),
      processConfig('web', { needs: ['mailhog'] }),
    ];
    // --except was never passed here, so blaming it would send the user hunting
    // for a flag they did not use.
    const error = captureWarplineError(() => selectProcesses(withOptionalDep, base));
    expect(error.hint).toContain('marked optional');
    expect(error.hint).not.toContain('--except');
  });

  it('rejects an unknown name', () => {
    expect(() => selectProcesses(graph, { ...base, only: ['nope'] })).toThrowError(
      /Unknown process name\(s\): nope/,
    );
  });

  it('lists the available names in the hint', () => {
    const error = captureWarplineError(() => selectProcesses(graph, { ...base, only: ['nope'] }));
    expect(error.hint).toContain('Available: db, api, web, mailhog');
  });

  it('rejects an unknown name in --except too', () => {
    expect(() => selectProcesses(graph, { ...base, except: ['nope'] })).toThrowError(
      /Unknown process name\(s\): nope/,
    );
  });

  it('refuses a selection that leaves nothing to start', () => {
    expect(() => selectProcesses([processConfig('web')], { ...base, except: ['web'] })).toThrowError(
      /No processes left to start/,
    );
  });
});
