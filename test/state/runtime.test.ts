import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRuntime,
  createRuntime,
  inspectRuntime,
  isPidAlive,
  isProjectRunning,
  listRuntimeNames,
  readRuntime,
  reconcileRuntime,
  writeRuntime,
  type ProcessRuntime,
  type ProcessStatus,
  type ProjectRuntime,
} from '../../src/state/runtime.js';
import { paths } from '../../src/core/paths.js';
import { createTempDir, DEAD_PID, removeTempDir, setEnv, type EnvGuard } from '../helpers/tmpdir.js';

let home: string;
let guard: EnvGuard;

beforeEach(() => {
  home = createTempDir('warpline-runtime-');
  guard = setEnv({ WARPLINE_HOME: home });
});

afterEach(() => {
  guard.restore();
  removeTempDir(home);
});

function processRuntime(id: string, overrides: Partial<ProcessRuntime> = {}): ProcessRuntime {
  return {
    id,
    label: id,
    command: `run-${id}`,
    cwd: home,
    kind: 'service',
    pid: undefined,
    status: 'ready',
    startedAt: Date.now(),
    readyAt: Date.now(),
    exitCode: undefined,
    signal: undefined,
    restarts: 0,
    ports: [],
    logFile: 'ignored.log',
    message: undefined,
    ...overrides,
  };
}

function stateWith(processes: ProcessRuntime[], supervisorPid = process.pid): ProjectRuntime {
  const state = createRuntime({
    name: 'demo',
    root: home,
    configFile: `${home}/warpline.yml`,
    mode: 'detached',
  });
  state.supervisorPid = supervisorPid;
  for (const proc of processes) state.processes[proc.id] = proc;
  return state;
}

describe('isPidAlive', () => {
  it('recognises this process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('rejects a pid that cannot exist', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });

  it('rejects values that are not usable pids', () => {
    expect(isPidAlive(undefined)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

describe('reading and writing state', () => {
  it('round trips', () => {
    writeRuntime(stateWith([processRuntime('web', { pid: process.pid })]));
    const read = readRuntime('demo');
    expect(read?.name).toBe('demo');
    expect(read?.processes.web?.pid).toBe(process.pid);
  });

  it('stamps the state version on write', () => {
    writeRuntime(stateWith([]));
    expect(readRuntime('demo')?.version).toBe(1);
  });

  it('returns undefined for a project with no state file', () => {
    expect(readRuntime('never-started')).toBeUndefined();
  });

  it('returns undefined for a corrupt state file rather than throwing', () => {
    fs.mkdirSync(paths.stateDir(), { recursive: true });
    fs.writeFileSync(paths.stateFile('demo'), 'not json at all', 'utf8');
    expect(readRuntime('demo')).toBeUndefined();
  });

  it('returns undefined when the processes key is missing', () => {
    fs.mkdirSync(paths.stateDir(), { recursive: true });
    fs.writeFileSync(paths.stateFile('demo'), JSON.stringify({ name: 'demo' }), 'utf8');
    expect(readRuntime('demo')).toBeUndefined();
  });

  it('clears state, and clearing something absent is not an error', () => {
    writeRuntime(stateWith([]));
    expect(readRuntime('demo')).toBeDefined();
    clearRuntime('demo');
    expect(readRuntime('demo')).toBeUndefined();
    expect(() => clearRuntime('demo')).not.toThrow();
  });

  it('names state files by slug, so a name with path characters is still safe', () => {
    const state = stateWith([]);
    state.name = 'My App/v2';
    writeRuntime(state);

    expect(fs.existsSync(paths.stateFile('My App/v2'))).toBe(true);

    const [listed] = listRuntimeNames();
    // A digest is appended whenever normalisation changed the name, so distinct
    // names cannot collapse onto one state file.
    expect(listed).toMatch(/^my-app-v2-[0-9a-f]{8}$/);

    // Slugs are handed back in as names, so the slug must resolve to the same
    // file and the real name must still be recoverable from it.
    expect(readRuntime(listed as string)?.name).toBe('My App/v2');
  });

  it('keeps two names that differ only in case in separate state files', () => {
    const upper = stateWith([]);
    upper.name = 'MyApp';
    writeRuntime(upper);

    const lower = stateWith([]);
    lower.name = 'myapp';
    lower.root = `${home}/other`;
    writeRuntime(lower);

    // Sharing a file meant `status` reported the other project's processes and
    // `down` stopped them.
    expect(listRuntimeNames()).toHaveLength(2);
    expect(readRuntime('MyApp')?.root).toBe(home);
    expect(readRuntime('myapp')?.root).toBe(`${home}/other`);
  });
});

describe('inspectRuntime', () => {
  it('returns undefined when there is no state', () => {
    expect(inspectRuntime('demo')).toBeUndefined();
  });

  it('separates processes that are still alive from ones that are gone', () => {
    writeRuntime(
      stateWith([
        processRuntime('alive', { pid: process.pid, status: 'ready' }),
        processRuntime('gone', { pid: DEAD_PID, status: 'running' }),
      ]),
    );

    const info = inspectRuntime('demo');
    expect(info?.live.map((p) => p.id)).toEqual(['alive']);
    expect(info?.vanished.map((p) => p.id)).toEqual(['gone']);
  });

  it('only considers processes in an active status', () => {
    // A finished task or a stopped service is neither alive nor vanished; it is
    // simply done, and must not be reported as a stale entry.
    const inactive: ProcessStatus[] = ['pending', 'done', 'failed', 'stopped', 'skipped'];
    writeRuntime(
      stateWith(inactive.map((status, i) => processRuntime(`p${i}`, { status, pid: DEAD_PID }))),
    );

    const info = inspectRuntime('demo');
    expect(info?.live).toEqual([]);
    expect(info?.vanished).toEqual([]);
  });

  it('reports whether the supervisor is still alive', () => {
    writeRuntime(stateWith([], process.pid));
    expect(inspectRuntime('demo')?.supervisorAlive).toBe(true);

    writeRuntime(stateWith([], DEAD_PID));
    expect(inspectRuntime('demo')?.supervisorAlive).toBe(false);
  });
});

describe('isProjectRunning', () => {
  it('is true only while something is actually alive', () => {
    writeRuntime(stateWith([processRuntime('web', { pid: process.pid, status: 'ready' })]));
    expect(isProjectRunning('demo')).toBe(true);

    writeRuntime(stateWith([processRuntime('web', { pid: DEAD_PID, status: 'ready' })]));
    expect(isProjectRunning('demo')).toBe(false);
  });

  it('is false for a project that was never started', () => {
    expect(isProjectRunning('demo')).toBe(false);
  });
});

describe('reconcileRuntime', () => {
  it('rewrites processes whose pid is gone, and persists the correction', () => {
    // This is what stops `status` showing phantom processes after a reboot.
    writeRuntime(
      stateWith([
        processRuntime('alive', { pid: process.pid, status: 'ready' }),
        processRuntime('gone', { pid: DEAD_PID, status: 'running' }),
      ]),
    );

    const info = reconcileRuntime('demo');
    expect(info?.vanished).toEqual([]);
    expect(info?.live.map((p) => p.id)).toEqual(['alive']);

    const persisted = readRuntime('demo');
    expect(persisted?.processes.gone?.status).toBe('stopped');
    expect(persisted?.processes.gone?.pid).toBeUndefined();
    expect(persisted?.processes.gone?.message).toMatch(/gone/);
    expect(persisted?.processes.alive?.status).toBe('ready');
  });

  it('leaves a healthy state file untouched', () => {
    writeRuntime(stateWith([processRuntime('web', { pid: process.pid, status: 'ready' })]));
    const before = fs.readFileSync(paths.stateFile('demo'), 'utf8');

    reconcileRuntime('demo');

    expect(fs.readFileSync(paths.stateFile('demo'), 'utf8')).toBe(before);
  });

  it('keeps an existing failure message rather than overwriting it', () => {
    writeRuntime(
      stateWith([processRuntime('gone', { pid: DEAD_PID, status: 'running', message: 'exited with code 1' })]),
    );
    reconcileRuntime('demo');
    expect(readRuntime('demo')?.processes.gone?.message).toBe('exited with code 1');
  });

  it('returns undefined when there is nothing to reconcile', () => {
    expect(reconcileRuntime('demo')).toBeUndefined();
  });
});

describe('listRuntimeNames', () => {
  it('is empty when nothing has run', () => {
    expect(listRuntimeNames()).toEqual([]);
  });

  it('lists every project with a state file, live or stale', () => {
    for (const name of ['alpha', 'beta']) {
      const state = stateWith([]);
      state.name = name;
      writeRuntime(state);
    }
    expect(listRuntimeNames().sort()).toEqual(['alpha', 'beta']);
  });

  it('ignores files that are not state files', () => {
    writeRuntime(stateWith([]));
    fs.writeFileSync(`${paths.stateDir()}/notes.txt`, 'ignore me', 'utf8');
    expect(listRuntimeNames()).toEqual(['demo']);
  });
});
