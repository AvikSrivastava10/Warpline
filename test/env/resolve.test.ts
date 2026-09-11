import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import {
  getEnvVar,
  looksSecret,
  maskValue,
  parseEnvOverrides,
  resolveEnv,
  setEnvVar,
} from '../../src/env/resolve.js';
import type { WarplineConfig } from '../../src/config/types.js';
import { createTempDir, removeTempDir, setEnv, writeTree, type EnvGuard } from '../helpers/tmpdir.js';

const isWindows = process.platform === 'win32';

let root: string;
let guards: EnvGuard[] = [];

beforeEach(() => {
  root = createTempDir('warpline-resolve-');
  guards = [];
});

afterEach(() => {
  for (const guard of guards.reverse()) guard.restore();
  removeTempDir(root);
});

function withEnv(values: Record<string, string | undefined>): void {
  guards.push(setEnv(values));
}

/** Writes a fixture and loads it, so resolution runs against a real config. */
function configFrom(files: Record<string, string>): WarplineConfig {
  writeTree(root, files);
  return loadConfigFile(path.join(root, 'warpline.yml'));
}

describe('layer precedence', () => {
  it('applies shell, then files, then vars, then per-process, then overrides', () => {
    withEnv({ LAYERED: 'from-shell' });

    const config = configFrom({
      '.env': 'LAYERED=from-file\n',
      'warpline.yml': [
        'name: demo',
        'env:',
        '  files: [.env]',
        '  vars:',
        '    LAYERED: from-vars',
        'processes:',
        '  web:',
        '    command: x',
        '    env:',
        '      LAYERED: from-process',
      ].join('\n'),
    });

    const web = config.processes[0];

    expect(resolveEnv(config, undefined).values.LAYERED).toBe('from-vars');
    expect(resolveEnv(config, web).values.LAYERED).toBe('from-process');
    expect(resolveEnv(config, web, { overrides: { LAYERED: 'from-cli' } }).values.LAYERED).toBe('from-cli');
  });

  it('lets a later env file win over an earlier one', () => {
    const config = configFrom({
      '.env': 'SHARED=first\nONLY_FIRST=yes\n',
      '.env.local': 'SHARED=second\n',
      'warpline.yml': 'name: demo\nenv:\n  files: [.env, .env.local]\nprocesses:\n  web: x\n',
    });

    const resolved = resolveEnv(config, undefined);
    expect(resolved.values.SHARED).toBe('second');
    expect(resolved.values.ONLY_FIRST).toBe('yes');
    expect(resolved.loadedFiles).toEqual(['.env', '.env.local']);
  });

  it('inherits the shell environment when nothing overrides it', () => {
    withEnv({ WARPLINE_TEST_INHERITED: 'yes' });
    const config = configFrom({ 'warpline.yml': 'name: demo\nprocesses:\n  web: x\n' });
    // Not WARPLINE_-prefixed in a way that survives; see the stripping test below.
    expect(resolveEnv(config, undefined).values.PATH).toBeDefined();
  });
});

describe('expansion', () => {
  it('expands a reference to a value set in an earlier layer', () => {
    const config = configFrom({
      '.env': 'PG_PORT=5432\nDATABASE_URL=postgres://localhost:${PG_PORT}/app\n',
      'warpline.yml': 'name: demo\nenv:\n  files: [.env]\nprocesses:\n  web: x\n',
    });
    expect(resolveEnv(config, undefined).values.DATABASE_URL).toBe('postgres://localhost:5432/app');
  });

  it('expands across files, in declaration order', () => {
    const config = configFrom({
      '.env': 'HOST=localhost\n',
      '.env.local': 'API=http://${HOST}:4000\n',
      'warpline.yml': 'name: demo\nenv:\n  files: [.env, .env.local]\nprocesses:\n  web: x\n',
    });
    expect(resolveEnv(config, undefined).values.API).toBe('http://localhost:4000');
  });

  it('expands inside env.vars against files already loaded', () => {
    const config = configFrom({
      '.env': 'PORT_NUMBER=4000\n',
      'warpline.yml': [
        'name: demo',
        'env:',
        '  files: [.env]',
        '  vars:',
        '    API_URL: http://localhost:${PORT_NUMBER}',
        'processes:',
        '  web: x',
      ].join('\n'),
    });
    expect(resolveEnv(config, undefined).values.API_URL).toBe('http://localhost:4000');
  });
});

describe('env files that are missing', () => {
  it('skips a missing optional file and reports it', () => {
    const config = configFrom({
      'warpline.yml': 'name: demo\nenv:\n  files: [.env, .env.local]\nprocesses:\n  web: x\n',
    });
    const resolved = resolveEnv(config, undefined);
    expect(resolved.missingFiles).toEqual(['.env', '.env.local']);
    expect(resolved.loadedFiles).toEqual([]);
  });

  it('throws when a required file is absent', () => {
    const config = configFrom({
      'warpline.yml': 'name: demo\nenv:\n  requireFiles: [.env]\nprocesses:\n  web: x\n',
    });
    expect(() => resolveEnv(config, undefined)).toThrow(/Required env file\(s\) missing: \.env/);
  });

  it('is satisfied once the required file exists', () => {
    const config = configFrom({
      '.env': 'OK=1\n',
      'warpline.yml': 'name: demo\nenv:\n  requireFiles: [.env]\nprocesses:\n  web: x\n',
    });
    expect(resolveEnv(config, undefined).values.OK).toBe('1');
  });
});

describe('required variables', () => {
  it('reports a variable that resolves to nothing', () => {
    const config = configFrom({
      '.env': 'PRESENT=yes\nEMPTY=\n',
      'warpline.yml': [
        'name: demo',
        'env:',
        '  files: [.env]',
        '  require: [PRESENT, EMPTY, ABSENT]',
        'processes:',
        '  web: x',
      ].join('\n'),
    });
    expect(resolveEnv(config, undefined).missingRequired).toEqual(['EMPTY', 'ABSENT']);
  });
});

describe('warpline own variables', () => {
  it('strips inherited WARPLINE_ variables so they never reach a child', () => {
    // A dev server inheriting WARPLINE_HOME or an internal flag is confusing at
    // best, so the plumbing is removed before the ambient context is added back.
    withEnv({ WARPLINE_HOME: root, WARPLINE_DEBUG: '1' });
    const config = configFrom({ 'warpline.yml': 'name: demo\nprocesses:\n  web: x\n' });

    const resolved = resolveEnv(config, undefined);
    expect(resolved.values.WARPLINE_HOME).toBeUndefined();
    expect(resolved.values.WARPLINE_DEBUG).toBeUndefined();
  });

  it('injects the project identity', () => {
    const config = configFrom({ 'warpline.yml': 'name: demo\nprocesses:\n  web: x\n' });

    const forProject = resolveEnv(config, undefined);
    expect(forProject.values.WARPLINE).toBe('1');
    expect(forProject.values.WARPLINE_PROJECT).toBe('demo');
    expect(forProject.values.WARPLINE_PROCESS).toBeUndefined();

    const forProcess = resolveEnv(config, config.processes[0]);
    expect(forProcess.values.WARPLINE_PROCESS).toBe('web');
  });
});

describe('isolate', () => {
  it('drops everything except the platform baseline', () => {
    withEnv({ SOME_UNRELATED_VARIABLE: 'present' });
    const config = configFrom({
      'warpline.yml': 'name: demo\nenv:\n  isolate: true\nprocesses:\n  web: x\n',
    });

    const resolved = resolveEnv(config, undefined);
    expect(resolved.values.SOME_UNRELATED_VARIABLE).toBeUndefined();
    // A child still needs to be able to find executables.
    expect(getEnvVar(resolved.values, 'PATH')).toBeDefined();
  });

  it('lets an explicit allowlist back through', () => {
    withEnv({ SOME_UNRELATED_VARIABLE: 'present' });
    const config = configFrom({
      'warpline.yml': [
        'name: demo',
        'env:',
        '  isolate: true',
        '  passthrough: [SOME_UNRELATED_VARIABLE]',
        'processes:',
        '  web: x',
      ].join('\n'),
    });
    expect(resolveEnv(config, undefined).values.SOME_UNRELATED_VARIABLE).toBe('present');
  });

  it('passes everything through for a wildcard', () => {
    withEnv({ SOME_UNRELATED_VARIABLE: 'present' });
    const config = configFrom({
      'warpline.yml': 'name: demo\nenv:\n  isolate: true\n  passthrough: ["*"]\nprocesses:\n  web: x\n',
    });
    expect(resolveEnv(config, undefined).values.SOME_UNRELATED_VARIABLE).toBe('present');
  });
});

describe('provenance', () => {
  it('attributes each value to the layer that set it', () => {
    const config = configFrom({
      '.env': 'FROM_FILE=1\n',
      'warpline.yml': [
        'name: demo',
        'env:',
        '  files: [.env]',
        '  vars:',
        '    FROM_VARS: 1',
        'processes:',
        '  web:',
        '    command: x',
        '    env:',
        '      FROM_PROCESS: 1',
      ].join('\n'),
    });

    const resolved = resolveEnv(config, config.processes[0], { overrides: { FROM_CLI: '1' } });

    expect(resolved.origins.FROM_FILE?.origin).toBe('.env');
    expect(resolved.origins.FROM_VARS?.origin).toBe('warpline.yml env.vars');
    expect(resolved.origins.FROM_PROCESS?.origin).toBe('warpline.yml processes.web.env');
    expect(resolved.origins.FROM_CLI?.origin).toBe('--env');
    expect(resolved.origins.PATH?.origin).toBe('shell');
  });
});

describe('setEnvVar and getEnvVar', () => {
  it('reads back what was written', () => {
    const target: Record<string, string> = {};
    setEnvVar(target, 'EXAMPLE', 'value');
    expect(getEnvVar(target, 'EXAMPLE')).toBe('value');
  });

  it('returns undefined for an absent name', () => {
    expect(getEnvVar({}, 'NOPE')).toBeUndefined();
  });

  it.runIf(isWindows)('folds case on Windows, where the OS does', () => {
    // A map holding both Path and PATH gives the child undefined behaviour, so
    // exactly one casing per logical name is kept.
    const target: Record<string, string> = { Path: 'first' };
    setEnvVar(target, 'PATH', 'second');
    expect(Object.keys(target)).toEqual(['PATH']);
    expect(getEnvVar(target, 'path')).toBe('second');
  });

  it.runIf(!isWindows)('treats casing as distinct on POSIX, where the OS does', () => {
    const target: Record<string, string> = { Path: 'first' };
    setEnvVar(target, 'PATH', 'second');
    expect(Object.keys(target).sort()).toEqual(['PATH', 'Path']);
    expect(getEnvVar(target, 'path')).toBeUndefined();
  });
});

describe('looksSecret and maskValue', () => {
  it('recognises the usual secret-ish names', () => {
    for (const key of ['API_KEY', 'GITHUB_TOKEN', 'MY_SECRET', 'DB_PASSWORD', 'AWS_ACCESS_KEY_ID']) {
      expect(looksSecret(key)).toBe(true);
    }
  });

  it('leaves ordinary names alone', () => {
    for (const key of ['NODE_ENV', 'PORT', 'HOST', 'DATABASE_URL']) {
      expect(looksSecret(key)).toBe(false);
    }
  });

  it('errs towards masking, which produces some false positives', () => {
    // "MONKEY" contains "KEY". Redacting something harmless is the cheaper mistake.
    expect(looksSecret('MONKEY')).toBe(true);
  });

  it('replaces a secret with a length hint rather than the value', () => {
    const masked = maskValue('API_KEY', 'abc123def456');
    expect(masked).not.toContain('abc123');
    expect(masked).toContain('12 chars');
  });

  it('marks an empty secret as empty', () => {
    expect(maskValue('API_KEY', '')).toBe('(empty)');
  });

  it('shows a non-secret value as-is', () => {
    expect(maskValue('NODE_ENV', 'development')).toBe('development');
  });

  it('shortens a very long non-secret value', () => {
    const masked = maskValue('SOME_LIST', 'x'.repeat(100));
    expect(masked.endsWith('...')).toBe(true);
    expect(masked.length).toBeLessThan(100);
  });
});

describe('parseEnvOverrides', () => {
  it('parses KEY=VALUE pairs', () => {
    expect(parseEnvOverrides(['A=1', 'B=two'])).toEqual({ A: '1', B: 'two' });
  });

  it('keeps everything after the first equals sign', () => {
    expect(parseEnvOverrides(['URL=http://x/?a=1&b=2'])).toEqual({ URL: 'http://x/?a=1&b=2' });
  });

  it('allows an empty value', () => {
    expect(parseEnvOverrides(['EMPTY='])).toEqual({ EMPTY: '' });
  });

  it('rejects a pair with no equals sign', () => {
    expect(() => parseEnvOverrides(['JUSTAKEY'])).toThrow(/Invalid --env value/);
  });

  it('rejects an invalid variable name', () => {
    expect(() => parseEnvOverrides(['not-valid=1'])).toThrow(/Invalid environment variable name/);
  });
});
