import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectNodeVersionPin,
  detectPackageManager,
  detectWorkspaces,
  findComposeFile,
  readPackageJson,
  runScriptCommand,
  scanEnvFiles,
} from '../../src/detect/project.js';
import { createTempDir, removeTempDir, writeTree } from '../helpers/tmpdir.js';

let root: string;

beforeEach(() => {
  root = createTempDir('warpline-detect-project-');
});

afterEach(() => {
  removeTempDir(root);
});

const pkg = (value: Record<string, unknown>): string => JSON.stringify(value, null, 2);

describe('readPackageJson', () => {
  it('reads a manifest', () => {
    writeTree(root, { 'package.json': pkg({ name: 'demo', scripts: { dev: 'vite' } }) });
    expect(readPackageJson(root)?.name).toBe('demo');
  });

  it('returns undefined when absent', () => {
    expect(readPackageJson(root)).toBeUndefined();
  });

  it('returns undefined for invalid JSON rather than throwing', () => {
    // Detection runs against arbitrary repositories, so a broken manifest must
    // degrade instead of taking the command down.
    writeTree(root, { 'package.json': '{ not json' });
    expect(readPackageJson(root)).toBeUndefined();
  });
});

describe('detectPackageManager', () => {
  it('returns undefined for a directory with nothing in it', () => {
    expect(detectPackageManager(root)).toBeUndefined();
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['deno.lock', 'deno'],
  ])('infers %s as %s', (lockfile, expected) => {
    writeTree(root, { 'package.json': pkg({ name: 'demo' }), [lockfile]: '' });
    expect(detectPackageManager(root)).toBe(expected);
  });

  it('trusts the lockfile over a stale packageManager field', () => {
    // The lockfile is what the repository actually installed with; a stale
    // packageManager string is a common source of "works on my machine".
    writeTree(root, {
      'package.json': pkg({ name: 'demo', packageManager: 'yarn@4.0.0' }),
      'pnpm-lock.yaml': '',
    });
    expect(detectPackageManager(root)).toBe('pnpm');
  });

  it('falls back to the packageManager field with no lockfile', () => {
    writeTree(root, { 'package.json': pkg({ name: 'demo', packageManager: 'pnpm@9.0.0' }) });
    expect(detectPackageManager(root)).toBe('pnpm');
  });

  it('recognises deno without a package.json', () => {
    writeTree(root, { 'deno.json': '{}' });
    expect(detectPackageManager(root)).toBe('deno');
  });

  it('defaults to npm when only a package.json is present', () => {
    writeTree(root, { 'package.json': pkg({ name: 'demo' }) });
    expect(detectPackageManager(root)).toBe('npm');
  });
});

describe('runScriptCommand', () => {
  it('uses each manager’s own invocation', () => {
    expect(runScriptCommand('npm', 'dev')).toBe('npm run dev');
    expect(runScriptCommand('pnpm', 'dev')).toBe('pnpm run dev');
    expect(runScriptCommand('bun', 'dev')).toBe('bun run dev');
    expect(runScriptCommand('deno', 'dev')).toBe('deno task dev');
  });

  it('omits run for yarn, which does not take it', () => {
    expect(runScriptCommand('yarn', 'dev')).toBe('yarn dev');
  });

  it('falls back to npm when the manager is unknown', () => {
    expect(runScriptCommand(undefined, 'dev')).toBe('npm run dev');
  });
});

describe('scanEnvFiles', () => {
  it('finds nothing in an empty directory', () => {
    expect(scanEnvFiles(root)).toEqual({ present: [], templates: [], templateKeys: [] });
  });

  it('lists present files in load order, not discovery order', () => {
    writeTree(root, { '.env.local': '', '.env': '', '.env.development': '' });
    expect(scanEnvFiles(root).present).toEqual(['.env', '.env.development', '.env.local']);
  });

  it('collects keys from a template', () => {
    writeTree(root, {
      '.env.example': ['# comment', 'DATABASE_URL=', 'export STRIPE_KEY=', 'API_URL=http://x', 'invalid line'].join(
        '\n',
      ),
    });
    const scan = scanEnvFiles(root);
    expect(scan.templates).toEqual(['.env.example']);
    expect(scan.templateKeys).toEqual(['API_URL', 'DATABASE_URL', 'STRIPE_KEY']);
  });

  it('recognises the other template names', () => {
    writeTree(root, { '.env.sample': 'A=\n', 'env.example': 'B=\n' });
    expect(scanEnvFiles(root).templates.sort()).toEqual(['.env.sample', 'env.example']);
  });
});

describe('detectNodeVersionPin', () => {
  it('returns undefined when the project pins nothing', () => {
    expect(detectNodeVersionPin(root)).toBeUndefined();
  });

  it('prefers .nvmrc', () => {
    writeTree(root, {
      '.nvmrc': '20.11.0\n',
      '.tool-versions': 'nodejs 18.19.0\n',
      'package.json': pkg({ engines: { node: '>=16' } }),
    });
    expect(detectNodeVersionPin(root)).toEqual({ source: '.nvmrc', range: '20.11.0' });
  });

  it('reads the nodejs line out of .tool-versions', () => {
    writeTree(root, { '.tool-versions': 'python 3.12.0\nnodejs 18.19.0\n' });
    expect(detectNodeVersionPin(root)).toEqual({ source: '.tool-versions', range: '18.19.0' });
  });

  it('falls back to engines.node', () => {
    writeTree(root, { 'package.json': pkg({ engines: { node: '>=18.17.0' } }) });
    expect(detectNodeVersionPin(root)).toEqual({
      source: 'package.json engines.node',
      range: '>=18.17.0',
    });
  });
});

describe('findComposeFile', () => {
  it('returns undefined when there is none', () => {
    expect(findComposeFile(root)).toBeUndefined();
  });

  it('prefers the modern compose.yaml name', () => {
    writeTree(root, { 'compose.yaml': '', 'docker-compose.yml': '' });
    expect(findComposeFile(root)).toBe('compose.yaml');
  });

  it('still finds the legacy name', () => {
    writeTree(root, { 'docker-compose.yml': '' });
    expect(findComposeFile(root)).toBe('docker-compose.yml');
  });
});

describe('detectWorkspaces', () => {
  it('finds nothing without a workspace declaration', () => {
    writeTree(root, { 'package.json': pkg({ name: 'demo' }) });
    expect(detectWorkspaces(root)).toEqual([]);
  });

  it('expands a single-level glob from package.json', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo', workspaces: ['packages/*'] }),
      'packages/one/package.json': pkg({ name: '@demo/one' }),
      'packages/two/package.json': pkg({ name: '@demo/two' }),
    });
    expect(detectWorkspaces(root).map((w) => w.relativeDir)).toEqual(['packages/one', 'packages/two']);
  });

  it('reads the object form of workspaces', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo', workspaces: { packages: ['apps/*'] } }),
      'apps/web/package.json': pkg({ name: 'web' }),
    });
    expect(detectWorkspaces(root).map((w) => w.name)).toEqual(['web']);
  });

  it('reads pnpm-workspace.yaml', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo' }),
      'pnpm-workspace.yaml': 'packages:\n  - "services/*"\n',
      'services/api/package.json': pkg({ name: 'api' }),
    });
    expect(detectWorkspaces(root).map((w) => w.relativeDir)).toEqual(['services/api']);
  });

  it('accepts a literal directory with no glob', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo', workspaces: ['apps/web'] }),
      'apps/web/package.json': pkg({ name: 'web' }),
    });
    expect(detectWorkspaces(root).map((w) => w.relativeDir)).toEqual(['apps/web']);
  });

  it('skips node_modules and dotted directories', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo', workspaces: ['packages/*'] }),
      'packages/real/package.json': pkg({ name: 'real' }),
      'packages/node_modules/package.json': pkg({ name: 'nope' }),
      'packages/.hidden/package.json': pkg({ name: 'nope' }),
    });
    expect(detectWorkspaces(root).map((w) => w.name)).toEqual(['real']);
  });

  it('ignores a directory with no package.json', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo', workspaces: ['packages/*'] }),
      'packages/real/package.json': pkg({ name: 'real' }),
      'packages/not-a-package/readme.md': '',
    });
    expect(detectWorkspaces(root).map((w) => w.name)).toEqual(['real']);
  });

  it('searches deeper only for a ** glob', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo', workspaces: ['packages/**'] }),
      'packages/group/nested/package.json': pkg({ name: 'nested' }),
    });
    expect(detectWorkspaces(root).map((w) => w.name)).toEqual(['nested']);
  });

  it('does not descend for a single-level glob', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo', workspaces: ['packages/*'] }),
      'packages/group/nested/package.json': pkg({ name: 'nested' }),
    });
    expect(detectWorkspaces(root)).toEqual([]);
  });

  it('ignores a negated pattern', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo', workspaces: ['!packages/*'] }),
      'packages/one/package.json': pkg({ name: 'one' }),
    });
    expect(detectWorkspaces(root)).toEqual([]);
  });

  it('survives a malformed pnpm-workspace.yaml', () => {
    writeTree(root, {
      'package.json': pkg({ name: 'demo', workspaces: ['apps/*'] }),
      'pnpm-workspace.yaml': 'packages: [unclosed\n',
      'apps/web/package.json': pkg({ name: 'web' }),
    });
    // A broken workspace file must not block detection of the rest.
    expect(detectWorkspaces(root).map((w) => w.name)).toEqual(['web']);
  });
});
