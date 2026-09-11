import path from 'node:path';
import type { ProcessConfig, ReadyProbe } from '../../src/config/types.js';

/**
 * Test fixtures for the fully-normalised shapes that `config/schema.ts` produces.
 * Building these by hand in every test would bury the one field under test in
 * twenty defaults, so the factories default everything and take an override.
 */

export const TEST_ROOT = path.resolve(path.sep, 'warpline-test-project');
export const TEST_CONFIG_FILE = path.join(TEST_ROOT, 'warpline.yml');

export function readyProbe(overrides: Partial<ReadyProbe> = {}): ReadyProbe {
  return {
    kind: 'settle',
    port: undefined,
    host: undefined,
    url: undefined,
    maxStatus: undefined,
    logPattern: undefined,
    file: undefined,
    settleMs: 400,
    timeoutMs: 90_000,
    intervalMs: 250,
    ...overrides,
  };
}

export function processConfig(id: string, overrides: Partial<ProcessConfig> = {}): ProcessConfig {
  return {
    id,
    command: `run-${id}`,
    cwd: TEST_ROOT,
    kind: 'service',
    needs: [],
    ready: readyProbe(),
    ports: [],
    declaredPort: undefined,
    env: {},
    restart: 'on-failure',
    maxRestarts: 3,
    backoffMs: 500,
    open: undefined,
    optional: false,
    label: id,
    stopTimeoutMs: 8000,
    shell: undefined,
    ...overrides,
  };
}

/**
 * Builds a process list from a compact `id -> dependencies` description, so a
 * test can state a graph shape in one line.
 */
export function graphOf(shape: Record<string, string[]>): ProcessConfig[] {
  return Object.entries(shape).map(([id, needs]) => processConfig(id, { needs }));
}
