import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from '../../src/core/paths.js';
import { readLogTail } from '../../src/proc/logger.js';
import { readRuntime } from '../../src/state/runtime.js';
import { createTempDir, removeTempDir, setEnv, type EnvGuard } from '../helpers/tmpdir.js';
import {
  fixtureConfig,
  freePort,
  statuses,
  waitForState,
  withSupervisor,
  yamlChildCommand,
} from '../helpers/orchestration.js';

/**
 * Tier 3: the orchestrator driven against real child processes.
 *
 * This is the layer that held every severe bug in the build log, and all of them
 * were about process behaviour and timing rather than logic that reads wrongly.
 * These tests spawn actual processes for that reason.
 */

let root: string;
let home: string;
let guard: EnvGuard;

beforeEach(() => {
  root = createTempDir('warpline-orch-');
  home = createTempDir('warpline-orch-home-');
  guard = setEnv({ WARPLINE_HOME: home, MARKER: undefined, LISTEN_DELAY: undefined });
});

afterEach(() => {
  guard.restore();
  removeTempDir(root);
  removeTempDir(home);
});

// Already YAML-quoted, so these interpolate straight into a fixture.
const stay = yamlChildCommand('stay.cjs');
const serve = yamlChildCommand('serve.cjs');
const exit0 = yamlChildCommand('exit0.cjs');
const exit1 = yamlChildCommand('exit1.cjs');
const crash = yamlChildCommand('crash.cjs');
const dumpenv = yamlChildCommand('dumpenv.cjs');

describe('readiness gating', () => {
  it('holds a dependent until a task has actually finished', async () => {
    const config = fixtureConfig(
      root,
      [
        'name: gating',
        'processes:',
        '  migrate:',
        `    command: ${exit0}`,
        '    kind: task',
        '  web:',
        `    command: ${stay}`,
        '    needs: [migrate]',
        '    ready: { delay: 50 }',
      ].join('\n'),
    );

    await withSupervisor(config, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(true);
      expect(statuses(supervisor)).toEqual({ migrate: 'done', web: 'ready' });

      // `needs` has to mean "the dependency finished", not "it was spawned".
      const migrate = supervisor.runtime.processes.migrate;
      const web = supervisor.runtime.processes.web;
      expect(web?.startedAt).toBeGreaterThanOrEqual(migrate?.readyAt as number);
    });
  }, 30_000);

  it('holds a dependent until a port actually answers', async () => {
    const port = await freePort();
    const config = fixtureConfig(
      root,
      [
        'name: portgate',
        'env:',
        '  vars:',
        '    LISTEN_DELAY: "300"',
        'processes:',
        '  api:',
        `    command: ${serve}`,
        `    port: ${port}`,
        `    ready: { port: ${port}, interval: 50, timeout: 8000 }`,
        '  web:',
        `    command: ${stay}`,
        '    needs: [api]',
        '    ready: { delay: 50 }',
      ].join('\n'),
    );

    await withSupervisor(config, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(true);

      const api = supervisor.runtime.processes.api;
      const web = supervisor.runtime.processes.web;

      // The server sleeps 300ms before listening, so a probe that merely checked
      // for a live PID would have released `web` immediately.
      expect((api?.readyAt as number) - (api?.startedAt as number)).toBeGreaterThanOrEqual(250);
      expect(web?.startedAt).toBeGreaterThanOrEqual(api?.readyAt as number);
    });
  }, 30_000);

  it('matches a log pattern from the child’s captured stdout', async () => {
    // Also the regression test for output capture: on Windows, spawning with
    // `detached: true` gives the child its own console and the pipe receives
    // nothing, so a log probe can never fire. If this passes, capture works.
    const config = fixtureConfig(
      root,
      [
        'name: logprobe',
        'env:',
        '  vars:',
        '    MARKER: "the server is up"',
        'processes:',
        '  web:',
        `    command: ${stay}`,
        '    ready: { log: "server is up", timeout: 8000 }',
      ].join('\n'),
    );

    await withSupervisor(config, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(true);
      expect(supervisor.runtime.processes.web?.status).toBe('ready');
      expect(supervisor.runtime.processes.web?.message).toMatch(/matched/);
    });
  }, 30_000);

  it('reports a readiness timeout without waiting for it twice', async () => {
    const port = await freePort();
    const config = fixtureConfig(
      root,
      [
        'name: neverready',
        'processes:',
        '  web:',
        `    command: ${stay}`,
        `    ready: { port: ${port}, interval: 50, timeout: 700 }`,
      ].join('\n'),
    );

    const startedAt = Date.now();
    await withSupervisor(config, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(false);
      expect(supervisor.runtime.processes.web?.status).toBe('failed');
      expect(outcome.failures[0]?.reason).toMatch(/did not respond/);
    });

    // A live process that never becomes ready is not retried, because retrying
    // would just wait the same budget again for the same failure.
    expect(Date.now() - startedAt).toBeLessThan(6000);
  }, 30_000);
});

describe('failure propagation', () => {
  it('marks dependents of a failed task as skipped rather than starting them', async () => {
    const config = fixtureConfig(
      root,
      [
        'name: failfast',
        'processes:',
        '  migrate:',
        `    command: ${exit1}`,
        '    kind: task',
        '  web:',
        `    command: ${stay}`,
        '    needs: [migrate]',
        '    ready: { delay: 50 }',
      ].join('\n'),
    );

    await withSupervisor(config, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(false);
      expect(statuses(supervisor)).toMatchObject({ migrate: 'failed', web: 'skipped' });
      expect(supervisor.runtime.processes.web?.message).toMatch(/dependency failed/);
      // The dependent must never have been spawned at all.
      expect(supervisor.runtime.processes.web?.startedAt).toBeUndefined();
    });
  }, 30_000);

  it('leaves an independent process running when another fails', async () => {
    const config = fixtureConfig(
      root,
      [
        'name: independent',
        'processes:',
        '  broken:',
        `    command: ${exit1}`,
        '    kind: task',
        '  healthy:',
        `    command: ${stay}`,
        '    ready: { delay: 50 }',
      ].join('\n'),
    );

    await withSupervisor(
      config,
      ({ outcome, supervisor }) => {
        expect(outcome.ok).toBe(false);
        expect(statuses(supervisor)).toMatchObject({ broken: 'failed', healthy: 'ready' });
      },
      { keepGoing: true },
    );
  }, 30_000);

  it('fails a task that exits non-zero, and completes one that exits zero', async () => {
    const good = fixtureConfig(
      root,
      ['name: taskok', 'processes:', '  job:', `    command: ${exit0}`, '    kind: task'].join('\n'),
    );
    await withSupervisor(good, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(true);
      expect(supervisor.runtime.processes.job?.status).toBe('done');
    });

    const bad = fixtureConfig(
      root,
      ['name: taskbad', 'processes:', '  job:', `    command: ${exit1}`, '    kind: task'].join('\n'),
    );
    await withSupervisor(bad, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(false);
      expect(supervisor.runtime.processes.job?.status).toBe('failed');
      expect(outcome.failures[0]?.reason).toMatch(/exited with code 1/);
    });
  }, 40_000);
});

describe('restart policy', () => {
  it('retries a crashing service up to the cap, then gives up', async () => {
    const config = fixtureConfig(
      root,
      [
        'name: flapping',
        'processes:',
        '  web:',
        `    command: ${crash}`,
        '    restart: on-failure',
        '    maxRestarts: 2',
        '    backoff: 50',
        '    ready: { delay: 400 }',
      ].join('\n'),
    );

    await withSupervisor(config, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(false);
      const web = supervisor.runtime.processes.web;
      expect(web?.status).toBe('failed');
      // One initial attempt plus maxRestarts retries.
      expect(web?.restarts).toBe(2);
    });
  }, 40_000);

  it('does not retry when the policy says no', async () => {
    const config = fixtureConfig(
      root,
      [
        'name: noretry',
        'processes:',
        '  web:',
        `    command: ${crash}`,
        '    restart: no',
        '    ready: { delay: 400 }',
      ].join('\n'),
    );

    await withSupervisor(config, ({ supervisor }) => {
      expect(supervisor.runtime.processes.web?.restarts).toBe(0);
    });
  }, 30_000);
});

describe('hooks', () => {
  it('starts successfully with a successful before hook', async () => {
    const config = fixtureConfig(
      root,
      [
        'name: hooked',
        'hooks:',
        `  before: ${exit0}`,
        'processes:',
        '  web:',
        `    command: ${stay}`,
        '    ready: { delay: 50 }',
      ].join('\n'),
    );

    await withSupervisor(config, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(true);
      expect(supervisor.runtime.processes.web?.status).toBe('ready');
    });
  }, 30_000);

  it('abandons startup when a before hook fails', async () => {
    // A failed `before` means the environment is not prepared, so starting anyway
    // would only produce a more confusing failure later.
    const config = fixtureConfig(
      root,
      [
        'name: hookfail',
        'hooks:',
        `  before: ${exit1}`,
        'processes:',
        '  web:',
        `    command: ${stay}`,
        '    ready: { delay: 50 }',
      ].join('\n'),
    );

    await withSupervisor(config, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(false);
      expect(outcome.failures[0]?.id).toBe('hooks.before');
      expect(supervisor.runtime.processes.web?.status).toBe('pending');
      expect(supervisor.runtime.processes.web?.startedAt).toBeUndefined();
    });
  }, 30_000);
});

describe('what the child process actually receives', () => {
  it('injects the declared port and the project identity', async () => {
    const port = await freePort();
    const config = fixtureConfig(
      root,
      [
        'name: envcheck',
        'env:',
        '  files: [.env]',
        'processes:',
        '  web:',
        `    command: ${dumpenv}`,
        `    port: ${port}`,
        '    ready: { log: "WARPLINE_PROCESS=web", timeout: 8000 }',
      ].join('\n'),
    );
    fs.writeFileSync(`${root}/.env`, 'FROM_FILE=from-the-env-file\n', 'utf8');

    await withSupervisor(config, ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(true);

      const logFile = supervisor.runtime.processes.web?.logFile as string;
      const output = readLogTail(logFile, 40).join('\n');

      expect(output).toContain(`PORT=${port}`);
      expect(output).toContain('WARPLINE=1');
      expect(output).toContain('WARPLINE_PROJECT=envcheck');
      expect(output).toContain('WARPLINE_PROCESS=web');
      expect(output).toContain('FROM_FILE=from-the-env-file');
    });
  }, 30_000);

  it('writes captured output to a log file that outlives the run', async () => {
    const config = fixtureConfig(
      root,
      [
        'name: logged',
        'env:',
        '  vars:',
        '    MARKER: "durable output"',
        'processes:',
        '  web:',
        `    command: ${stay}`,
        '    ready: { log: "durable output", timeout: 8000 }',
      ].join('\n'),
    );

    let logFile = '';
    await withSupervisor(config, ({ supervisor }) => {
      logFile = supervisor.runtime.processes.web?.logFile as string;
    });

    // `warpline logs` depends on this still being readable after shutdown.
    expect(fs.existsSync(logFile)).toBe(true);
    expect(readLogTail(logFile, 40).join('\n')).toContain('durable output');
    expect(logFile.startsWith(home)).toBe(true);
  }, 30_000);
});

describe('shutdown', () => {
  it('stops every process in a dependency chain and clears its PID', async () => {
    const config = fixtureConfig(
      root,
      [
        'name: ordered',
        'processes:',
        '  db:',
        `    command: ${stay}`,
        '    ready: { delay: 50 }',
        '  api:',
        `    command: ${stay}`,
        '    needs: [db]',
        '    ready: { delay: 50 }',
        '  web:',
        `    command: ${stay}`,
        '    needs: [api]',
        '    ready: { delay: 50 }',
      ].join('\n'),
    );

    await withSupervisor(config, async ({ outcome, supervisor }) => {
      expect(outcome.ok).toBe(true);

      await supervisor.stopAll('ordered shutdown check');

      // Nothing may be left holding a PID after a clean stop.
      for (const entry of Object.values(supervisor.runtime.processes)) {
        expect(entry.status).toBe('stopped');
        expect(entry.pid).toBeUndefined();
      }
      expect(supervisor.isShuttingDown).toBe(true);
    });
  }, 40_000);

  it('is safe to call twice', async () => {
    const config = fixtureConfig(
      root,
      ['name: doublestop', 'processes:', '  web:', `    command: ${stay}`, '    ready: { delay: 50 }'].join('\n'),
    );

    await withSupervisor(config, async ({ supervisor }) => {
      await supervisor.stopAll('first');
      await expect(supervisor.stopAll('second')).resolves.toBeUndefined();
    });
  }, 30_000);
});

describe('state on disk', () => {
  it('records the run where status and logs can find it', async () => {
    const config = fixtureConfig(
      root,
      [
        'name: persisted',
        'processes:',
        '  job:',
        `    command: ${exit0}`,
        '    kind: task',
        '  web:',
        `    command: ${stay}`,
        '    needs: [job]',
        '    ready: { delay: 50 }',
      ].join('\n'),
    );

    await withSupervisor(config, async ({ supervisor }) => {
      // In-memory status is authoritative and immediate.
      expect(supervisor.runtime.processes.web?.status).toBe('ready');

      // The file is written through a coalescing setImmediate, so it can lag by a
      // macrotask; `up --detach` polls it on a 250ms interval for that reason.
      const state = await waitForState('persisted', (s) => s.processes.web?.status === 'ready');

      expect(state.name).toBe('persisted');
      expect(state.root).toBe(root);
      expect(state.mode).toBe('foreground');
      expect(state.supervisorPid).toBe(process.pid);
      expect(Object.keys(state.processes).sort()).toEqual(['job', 'web']);
      expect(state.processes.job?.status).toBe('done');
      expect(fs.existsSync(paths.stateFile('persisted'))).toBe(true);
    });
  }, 30_000);

  it('flushes final statuses synchronously on shutdown', async () => {
    const config = fixtureConfig(
      root,
      ['name: flushed', 'processes:', '  web:', `    command: ${stay}`, '    ready: { delay: 50 }'].join('\n'),
    );

    await withSupervisor(config, async ({ supervisor }) => {
      await supervisor.stopAll('flush check');
      // stopAll writes directly rather than through the coalescer, so no wait.
      expect(readRuntime('flushed')?.processes.web?.status).toBe('stopped');
    });
  }, 30_000);
});
