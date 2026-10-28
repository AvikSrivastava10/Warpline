import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir, writeTree } from './helpers/tmpdir.js';
import { yamlChildCommand } from './helpers/orchestration.js';

const bin = path.resolve('dist/bin.js');
// Exercise the shipped JavaScript entry point, not a mocked command dispatcher.
let root: string;
let home: string;
beforeEach(() => {
  root = createTempDir('warpline-cli-'); home = createTempDir('warpline-cli-home-');
  writeTree(root, {
    'job.cjs': "console.log('TASK_OUTPUT'); process.exit(Number(process.env.EXIT_CODE || 0));",
    'args.cjs': 'console.log(JSON.stringify(process.argv.slice(2)));',
    'warpline.yml': ['name: integration', 'processes:', '  job:',
      '    command: ' + yamlChildCommand('job.cjs'), '    kind: task'].join('\n'),
  });
});
afterEach(() => { removeTempDir(root); removeTempDir(home); });
function cli(args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WARPLINE_HOME: home, NO_COLOR: '1', WARPLINE_ASCII: '1', EXIT_CODE: '0' } });
}
describe('compiled CLI', () => {
  it('prints the startup plan without executing children', () => {
    const result = cli(['up', '--dry-run']);
    expect(result.status).toBe(0); expect(result.stdout).toContain('job');
    expect(result.stdout).not.toContain('TASK_OUTPUT');
  });
  it('runs a task and retrieves its persisted logs by process name', () => {
    const result = cli(['up']);
    expect(result.status, result.stderr).toBe(0);
    const logs = cli(['logs', '--only', 'job']);
    expect(logs.status, logs.stderr).toBe(0); expect(logs.stdout).toContain('TASK_OUTPUT');
  });
  it('preserves exec argument boundaries and child help flags', () => {
    const result = cli(['exec', '--quiet', '--', process.execPath, 'args.cjs', 'two words', '--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(['two words', '--help']);
  });
  it('returns the child exit code', () => {
    const result = cli(['exec', '--quiet', '--env', 'EXIT_CODE=7', '--', process.execPath, 'job.cjs']);
    expect(result.status).toBe(7);
  });
  it('rejects invalid process selection', () => {
    expect(cli(['up', '--only', 'missing']).status).not.toBe(0);
  });
});
