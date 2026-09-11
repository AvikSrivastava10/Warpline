import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configExistsIn,
  findConfigFile,
  loadConfigFile,
  loadConfigFrom,
  updateConfigDocument,
} from '../../src/config/load.js';
import { ConfigError } from '../../src/core/errors.js';
import { createTempDir, removeTempDir, writeTree } from '../helpers/tmpdir.js';

let root: string;

beforeEach(() => {
  root = createTempDir('warpline-load-');
});

afterEach(() => {
  removeTempDir(root);
});

const MINIMAL = 'name: demo\nprocesses:\n  web: npm run dev\n';

describe('findConfigFile', () => {
  it('finds a config in the directory itself', () => {
    writeTree(root, { 'warpline.yml': MINIMAL });
    expect(findConfigFile(root)).toBe(path.join(root, 'warpline.yml'));
  });

  it('walks upwards, so it works from anywhere inside a repository', () => {
    writeTree(root, { 'warpline.yml': MINIMAL, 'services/api/src/keep.txt': '' });
    expect(findConfigFile(path.join(root, 'services', 'api', 'src'))).toBe(path.join(root, 'warpline.yml'));
  });

  it('returns undefined when there is no config anywhere above', () => {
    expect(findConfigFile(root)).toBeUndefined();
  });

  it('prefers .yml over .yaml over .json in the same directory', () => {
    writeTree(root, {
      'warpline.json': JSON.stringify({ name: 'from-json', processes: { web: 'x' } }),
      'warpline.yaml': 'name: from-yaml\nprocesses:\n  web: x\n',
      'warpline.yml': 'name: from-yml\nprocesses:\n  web: x\n',
    });
    expect(loadConfigFile(findConfigFile(root) as string).name).toBe('from-yml');

    fs.rmSync(path.join(root, 'warpline.yml'));
    expect(loadConfigFile(findConfigFile(root) as string).name).toBe('from-yaml');

    fs.rmSync(path.join(root, 'warpline.yaml'));
    expect(loadConfigFile(findConfigFile(root) as string).name).toBe('from-json');
  });

  it('stops at the nearest config rather than the outermost one', () => {
    writeTree(root, {
      'warpline.yml': 'name: outer\nprocesses:\n  web: x\n',
      'packages/inner/warpline.yml': 'name: inner\nprocesses:\n  web: x\n',
    });
    const found = findConfigFile(path.join(root, 'packages', 'inner'));
    expect(loadConfigFile(found as string).name).toBe('inner');
  });
});

describe('loadConfigFile', () => {
  it('parses YAML', () => {
    writeTree(root, { 'warpline.yml': MINIMAL });
    const config = loadConfigFile(path.join(root, 'warpline.yml'));
    expect(config.name).toBe('demo');
    expect(config.root).toBe(root);
    expect(config.processes).toHaveLength(1);
  });

  it('parses JSON', () => {
    writeTree(root, {
      'warpline.json': JSON.stringify({ name: 'demo', processes: { web: 'npm run dev' } }),
    });
    expect(loadConfigFile(path.join(root, 'warpline.json')).processes[0]?.command).toBe('npm run dev');
  });

  it('falls back to the directory name when the config has none', () => {
    writeTree(root, { 'warpline.yml': 'processes:\n  web: x\n' });
    expect(loadConfigFile(path.join(root, 'warpline.yml')).name).toBe(path.basename(root));
  });

  it('reports a missing file as a plain error, not a config error', () => {
    expect(() => loadConfigFile(path.join(root, 'warpline.yml'))).toThrow(/No Warpline config found/);
  });

  it('calls an empty file empty, rather than reporting a type error', () => {
    // An empty file parses to null, and is a far more common mistake than a
    // malformed one, so it earns its own message.
    writeTree(root, { 'warpline.yml': '' });
    expect(() => loadConfigFile(path.join(root, 'warpline.yml'))).toThrow(/the file is empty/);
  });

  it('reports a YAML syntax error as a config error with the parser detail', () => {
    writeTree(root, { 'warpline.yml': 'processes:\n  web: node -e "console.log(1: 2)"\n' });
    let caught: unknown;
    try {
      loadConfigFile(path.join(root, 'warpline.yml'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).problems.join('\n')).toMatch(/could not be parsed/);
  });
});

describe('loadConfigFrom', () => {
  it('discovers and loads in one step', () => {
    writeTree(root, { 'warpline.yml': MINIMAL, 'deep/deeper/keep.txt': '' });
    expect(loadConfigFrom(path.join(root, 'deep', 'deeper')).name).toBe('demo');
  });

  it('explains what to do when nothing is found', () => {
    expect(() => loadConfigFrom(root)).toThrow(/No warpline\.yml found/);
  });
});

describe('configExistsIn', () => {
  it('returns the path when a config is present', () => {
    writeTree(root, { 'warpline.yml': MINIMAL });
    expect(configExistsIn(root)).toBe(path.join(root, 'warpline.yml'));
  });

  it('returns undefined otherwise, and does not search upwards', () => {
    writeTree(root, { 'warpline.yml': MINIMAL, 'sub/keep.txt': '' });
    expect(configExistsIn(path.join(root, 'sub'))).toBeUndefined();
  });
});

describe('updateConfigDocument', () => {
  const COMMENTED = [
    '# warpline.yml - how this project starts.',
    '# Committed on purpose: it travels with the repo.',
    '',
    'name: demo',
    '',
    'env:',
    '  # Loaded in order, later files win.',
    '  files: [.env, .env.local]',
    '',
    'processes:',
    '  web:',
    '    command: npm run dev # the dev server',
    '    port: 3000',
    '',
  ].join('\n');

  it('preserves comments, key order and inline notes across an edit', () => {
    // The reason the YAML document API is used instead of parse-and-restringify:
    // this file is committed and reviewed, so destroying its comments would be
    // unacceptable.
    const file = path.join(writeTree(root, { 'warpline.yml': COMMENTED }), 'warpline.yml');

    updateConfigDocument(file, (doc) => doc.set('note', 'run migrations after pulling'));

    const updated = fs.readFileSync(file, 'utf8');
    expect(updated).toContain('# warpline.yml - how this project starts.');
    expect(updated).toContain('# Committed on purpose: it travels with the repo.');
    expect(updated).toContain('# Loaded in order, later files win.');
    expect(updated).toContain('# the dev server');
    expect(updated).toContain('note: run migrations after pulling');

    // Key order must survive too.
    expect(updated.indexOf('name:')).toBeLessThan(updated.indexOf('env:'));
    expect(updated.indexOf('env:')).toBeLessThan(updated.indexOf('processes:'));

    // And it must still be loadable.
    expect(loadConfigFile(file).note).toBe('run migrations after pulling');
  });

  it('round trips a set and delete without losing comments', () => {
    const file = path.join(writeTree(root, { 'warpline.yml': COMMENTED }), 'warpline.yml');

    updateConfigDocument(file, (doc) => doc.set('note', 'temporary'));
    updateConfigDocument(file, (doc) => doc.delete('note'));

    const updated = fs.readFileSync(file, 'utf8');
    expect(updated).toContain('# Loaded in order, later files win.');
    expect(updated).not.toContain('note:');
    expect(loadConfigFile(file).note).toBeUndefined();
  });

  it('edits a JSON config through a plain round trip', () => {
    const file = path.join(
      writeTree(root, {
        'warpline.json': JSON.stringify({ name: 'demo', processes: { web: 'npm run dev' } }, null, 2),
      }),
      'warpline.json',
    );

    updateConfigDocument(file, (doc) => doc.set('note', 'from json'));

    expect(JSON.parse(fs.readFileSync(file, 'utf8')).note).toBe('from json');
    expect(loadConfigFile(file).note).toBe('from json');
  });

  it('refuses to edit a file it cannot parse', () => {
    const file = path.join(writeTree(root, { 'warpline.yml': 'processes:\n  - [unclosed\n' }), 'warpline.yml');
    expect(() => updateConfigDocument(file, (doc) => doc.set('note', 'x'))).toThrow(ConfigError);
  });

  it('reports a missing file', () => {
    expect(() => updateConfigDocument(path.join(root, 'nope.yml'), () => undefined)).toThrow(
      /No Warpline config found/,
    );
  });
});
