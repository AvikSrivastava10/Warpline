import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_VERSION, normalizeConfig } from '../../src/config/schema.js';
import { ConfigError } from '../../src/core/errors.js';
import type { ProcessConfig, WarplineConfig } from '../../src/config/types.js';
import { TEST_CONFIG_FILE, TEST_ROOT } from '../helpers/factories.js';

const FALLBACK_NAME = 'folder-name';

function normalize(raw: unknown): WarplineConfig {
  return normalizeConfig(raw, TEST_CONFIG_FILE, FALLBACK_NAME);
}

/** One process, so the common case does not repeat the boilerplate. */
function firstProcess(raw: Record<string, unknown>): ProcessConfig {
  const config = normalize({ processes: { web: 'npm run dev' }, ...raw });
  return config.processes[0] as ProcessConfig;
}

function processFrom(definition: unknown): ProcessConfig {
  return normalize({ processes: { web: definition } }).processes[0] as ProcessConfig;
}

/** Every problem found, so tests can assert the whole report at once. */
function problemsOf(raw: unknown): string[] {
  try {
    normalize(raw);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('Expected a ConfigError to be thrown, but the config validated');
}

describe('normalizeConfig', () => {
  it('rejects a top level that is not a mapping', () => {
    expect(problemsOf('just a string')).toEqual(['the config file must contain a mapping at the top level']);
  });

  it('records where the config came from', () => {
    const config = normalize({ processes: { web: 'npm run dev' } });
    expect(config.configFile).toBe(TEST_CONFIG_FILE);
    expect(config.root).toBe(TEST_ROOT);
  });

  describe('name', () => {
    it('falls back to the supplied default', () => {
      expect(normalize({ processes: { web: 'x' } }).name).toBe(FALLBACK_NAME);
    });

    it('prefers the declared name, trimmed', () => {
      expect(firstProcess({ name: '  myapp  ' }) && normalize({ name: '  myapp  ', processes: { web: 'x' } }).name).toBe(
        'myapp',
      );
    });

    it('rejects an empty name', () => {
      expect(problemsOf({ name: '   ', processes: { web: 'x' } })).toContain('name must be a non-empty string');
    });
  });

  describe('note', () => {
    it('trims the text', () => {
      expect(normalize({ note: '  migrate first  ', processes: { web: 'x' } }).note).toBe('migrate first');
    });

    it('treats a blank note as absent', () => {
      expect(normalize({ note: '   ', processes: { web: 'x' } }).note).toBeUndefined();
    });

    it('rejects a non-string note', () => {
      expect(problemsOf({ note: 42, processes: { web: 'x' } })).toContain('note must be a string');
    });
  });

  describe('top level keys', () => {
    it('rejects an unrecognised key', () => {
      expect(problemsOf({ processes: { web: 'x' }, prcesses: {} }).join('\n')).toContain(
        'unknown top-level key "prcesses"',
      );
    });

    it('permits $schema so editors can be pointed at a schema', () => {
      expect(() => normalize({ $schema: './warpline.schema.json', processes: { web: 'x' } })).not.toThrow();
    });

    it('does not advertise $schema in the list of expected keys', () => {
      expect(problemsOf({ processes: { web: 'x' }, nope: 1 }).join('\n')).not.toContain('$schema');
    });
  });

  describe('version', () => {
    it('defaults to the current version', () => {
      expect(normalize({ processes: { web: 'x' } }).version).toBe(CONFIG_VERSION);
    });

    it('rejects a version this build cannot understand', () => {
      expect(problemsOf({ version: CONFIG_VERSION + 1, processes: { web: 'x' } }).join('\n')).toContain(
        'upgrade warpline',
      );
    });

    it('rejects a non-positive version', () => {
      expect(problemsOf({ version: 0, processes: { web: 'x' } })).toContain('version must be a positive integer');
    });
  });

  describe('processes', () => {
    it('requires the block', () => {
      expect(problemsOf({ name: 'myapp' })).toContain('processes is required and must define at least one process');
    });

    it('requires at least one entry', () => {
      expect(problemsOf({ processes: {} })).toContain('processes must define at least one process');
    });

    it('accepts the bare command shorthand', () => {
      const proc = processFrom('npm run dev');
      expect(proc.command).toBe('npm run dev');
      expect(proc.id).toBe('web');
    });

    it('accepts cmd and run as aliases for command', () => {
      expect(processFrom({ cmd: 'a' }).command).toBe('a');
      expect(processFrom({ run: 'b' }).command).toBe('b');
    });

    it('requires a command', () => {
      expect(problemsOf({ processes: { web: {} } })).toContain(
        'processes.web.command is required and must be a non-empty string',
      );
    });

    it('rejects an id that does not start alphanumeric', () => {
      expect(problemsOf({ processes: { '-web': 'x' } }).join('\n')).toContain('process id must start alphanumeric');
    });

    it('accepts the list form with an explicit name', () => {
      const config = normalize({ processes: [{ name: 'web', command: 'npm run dev' }] });
      expect(config.processes.map((proc) => proc.id)).toEqual(['web']);
    });

    it('requires a name in the list form', () => {
      expect(problemsOf({ processes: [{ command: 'x' }] })).toContain('processes[0] needs a "name"');
    });

    it('rejects a duplicate id in the list form', () => {
      expect(
        problemsOf({
          processes: [
            { name: 'web', command: 'a' },
            { name: 'web', command: 'b' },
          ],
        }),
      ).toContain('processes.web is declared more than once');
    });

    it('defaults the label to the id', () => {
      expect(processFrom('x').label).toBe('web');
    });

    it('uses an explicit label', () => {
      expect(processFrom({ command: 'x', label: 'Web UI' }).label).toBe('Web UI');
    });
  });

  describe('needs', () => {
    it('accepts after and depends_on as aliases', () => {
      const config = normalize({ processes: { db: 'a', api: { command: 'b', after: ['db'] } } });
      expect(config.processes.find((proc) => proc.id === 'api')?.needs).toEqual(['db']);

      const other = normalize({ processes: { db: 'a', api: { command: 'b', depends_on: ['db'] } } });
      expect(other.processes.find((proc) => proc.id === 'api')?.needs).toEqual(['db']);
    });

    it('rejects a dependency on an unknown process', () => {
      expect(problemsOf({ processes: { web: { command: 'x', needs: ['ghost'] } } })).toContain(
        'processes.web.needs references unknown process "ghost"',
      );
    });

    it('rejects a self-dependency', () => {
      expect(problemsOf({ processes: { web: { command: 'x', needs: ['web'] } } })).toContain(
        'processes.web.needs cannot reference itself',
      );
    });
  });

  describe('cwd', () => {
    it('resolves against the project root', () => {
      expect(processFrom({ command: 'x', cwd: 'services/api' }).cwd).toBe(path.join(TEST_ROOT, 'services', 'api'));
    });

    it('defaults to the project root', () => {
      expect(processFrom('x').cwd).toBe(TEST_ROOT);
    });

    it('refuses to escape the project root', () => {
      // A warpline.yml arrives with a cloned repo, so `cwd: ../..` must not work.
      expect(problemsOf({ processes: { web: { command: 'x', cwd: '../outside' } } }).join('\n')).toContain(
        'must stay inside the project root',
      );
    });
  });

  describe('kind', () => {
    it('defaults to service', () => {
      expect(processFrom('x').kind).toBe('service');
    });

    it('accepts task, and type as an alias', () => {
      expect(processFrom({ command: 'x', kind: 'task' }).kind).toBe('task');
      expect(processFrom({ command: 'x', type: 'task' }).kind).toBe('task');
    });

    it('accepts oneshot as a way to declare a task', () => {
      expect(processFrom({ command: 'x', oneshot: true }).kind).toBe('task');
    });

    it('rejects an unknown kind', () => {
      expect(problemsOf({ processes: { web: { command: 'x', kind: 'daemon' } } })).toContain(
        'processes.web.kind must be "service" or "task"',
      );
    });
  });

  describe('readiness', () => {
    it('defaults a service to a settle probe', () => {
      expect(processFrom('x').ready).toMatchObject({ kind: 'settle', settleMs: 400, timeoutMs: 90_000, intervalMs: 250 });
    });

    it('forces a task to an exit-code probe regardless of what it declares', () => {
      // A task's contract is "runs to completion", so a port probe is meaningless.
      const proc = processFrom({ command: 'x', kind: 'task', ready: { port: 3000 } });
      expect(proc.ready.kind).toBe('exit');
    });

    it('lets a task set its own timeout', () => {
      expect(processFrom({ command: 'x', kind: 'task', ready: { timeout: 5000 } }).ready.timeoutMs).toBe(5000);
    });

    it('reads a bare number as a port', () => {
      expect(processFrom({ command: 'x', ready: 3000 }).ready).toMatchObject({ kind: 'port', port: 3000 });
    });

    it('reads a numeric string as a port', () => {
      expect(processFrom({ command: 'x', ready: '3000' }).ready).toMatchObject({ kind: 'port', port: 3000 });
    });

    it('reads a bare URL as an HTTP probe', () => {
      expect(processFrom({ command: 'x', ready: 'http://localhost:3000/health' }).ready).toMatchObject({
        kind: 'http',
        url: 'http://localhost:3000/health',
      });
    });

    it('treats false and "none" as opting out', () => {
      expect(processFrom({ command: 'x', ready: false }).ready.kind).toBe('none');
      expect(processFrom({ command: 'x', ready: 'none' }).ready.kind).toBe('none');
    });

    it('rejects a bare string that is neither a port nor a URL', () => {
      expect(problemsOf({ processes: { web: { command: 'x', ready: 'whenever' } } }).join('\n')).toContain(
        'must be a port number or an http(s) URL',
      );
    });

    it('accepts a host alongside a port', () => {
      expect(processFrom({ command: 'x', ready: { port: 5432, host: '0.0.0.0' } }).ready).toMatchObject({
        kind: 'port',
        port: 5432,
        host: '0.0.0.0',
      });
    });

    it('accepts a status ceiling alongside an HTTP probe', () => {
      expect(processFrom({ command: 'x', ready: { http: 'http://x/health', status: 299 } }).ready).toMatchObject({
        kind: 'http',
        maxStatus: 299,
      });
    });

    it('rejects an HTTP probe that is not a URL', () => {
      expect(problemsOf({ processes: { web: { command: 'x', ready: { http: 'localhost' } } } })).toContain(
        'processes.web.ready.http must be an http(s) URL',
      );
    });

    it('accepts a log pattern', () => {
      expect(processFrom({ command: 'x', ready: { log: 'ready in' } }).ready).toMatchObject({
        kind: 'log',
        logPattern: 'ready in',
      });
    });

    it('rejects a log pattern that is not a valid regular expression', () => {
      expect(problemsOf({ processes: { web: { command: 'x', ready: { log: '([' } } } }).join('\n')).toContain(
        'is not a valid regular expression',
      );
    });

    it('resolves a file probe against the process working directory', () => {
      const proc = processFrom({ command: 'x', cwd: 'services/api', ready: { file: 'build/done' } });
      expect(proc.ready.file).toBe(path.join(TEST_ROOT, 'services', 'api', 'build', 'done'));
    });

    it('accepts delay, and settle as an alias', () => {
      expect(processFrom({ command: 'x', ready: { delay: 2000 } }).ready).toMatchObject({
        kind: 'settle',
        settleMs: 2000,
      });
      expect(processFrom({ command: 'x', ready: { settle: 1500 } }).ready.settleMs).toBe(1500);
    });

    it('overrides timeout and interval', () => {
      expect(processFrom({ command: 'x', ready: { port: 3000, timeout: 5000, interval: 100 } }).ready).toMatchObject({
        timeoutMs: 5000,
        intervalMs: 100,
      });
    });

    it('rejects more than one signal', () => {
      expect(
        problemsOf({ processes: { web: { command: 'x', ready: { port: 3000, http: 'http://x' } } } }).join('\n'),
      ).toContain('declares multiple signals');
    });

    it('rejects a port outside the valid range', () => {
      expect(problemsOf({ processes: { web: { command: 'x', ready: { port: 70_000 } } } }).join('\n')).toContain(
        'must be a valid port (1-65535)',
      );
    });
  });

  describe('ports', () => {
    it('records a single declared port as the one to inject as PORT', () => {
      const proc = processFrom({ command: 'x', port: 3000 });
      expect(proc.ports).toEqual([3000]);
      expect(proc.declaredPort).toBe(3000);
    });

    it('does not treat a list of ports as the injectable one', () => {
      const proc = processFrom({ command: 'x', ports: [3000, 3001] });
      expect(proc.ports).toEqual([3000, 3001]);
      expect(proc.declaredPort).toBeUndefined();
    });

    it('folds a probed port into the pre-flight list', () => {
      // Pre-flight needs to know about it even though it was never declared.
      expect(processFrom({ command: 'x', ready: { port: 5432 } }).ports).toEqual([5432]);
    });

    it('does not duplicate a port that is both declared and probed', () => {
      expect(processFrom({ command: 'x', port: 3000, ready: { port: 3000 } }).ports).toEqual([3000]);
    });

    it('rejects a ports value that is not a list', () => {
      expect(problemsOf({ processes: { web: { command: 'x', ports: 3000 } } })).toContain(
        'processes.web.ports must be a list of port numbers',
      );
    });
  });

  describe('restart', () => {
    it('defaults a service to on-failure and a task to no', () => {
      expect(processFrom('x').restart).toBe('on-failure');
      expect(processFrom({ command: 'x', kind: 'task' }).restart).toBe('no');
    });

    it('reads true as always and false as no', () => {
      expect(processFrom({ command: 'x', restart: true }).restart).toBe('always');
      expect(processFrom({ command: 'x', restart: false }).restart).toBe('no');
    });

    it('rejects an unknown policy', () => {
      expect(problemsOf({ processes: { web: { command: 'x', restart: 'sometimes' } } }).join('\n')).toContain(
        'must be one of: no, on-failure, always',
      );
    });

    it('defaults the backoff and attempt cap', () => {
      const proc = processFrom('x');
      expect(proc.maxRestarts).toBe(3);
      expect(proc.backoffMs).toBe(500);
    });

    it('accepts the snake_case alias for maxRestarts', () => {
      expect(processFrom({ command: 'x', max_restarts: 7 }).maxRestarts).toBe(7);
    });
  });

  describe('open', () => {
    it('derives a localhost URL from the declared port', () => {
      expect(processFrom({ command: 'x', port: 3000, open: true }).open).toBe('http://localhost:3000');
    });

    it('rejects open: true with no port to open', () => {
      expect(problemsOf({ processes: { web: { command: 'x', open: true } } }).join('\n')).toContain(
        'needs a port or an explicit URL',
      );
    });

    it('accepts an explicit URL', () => {
      expect(processFrom({ command: 'x', open: 'http://localhost:8080/admin' }).open).toBe(
        'http://localhost:8080/admin',
      );
    });

    it('accepts https', () => {
      expect(processFrom({ command: 'x', open: 'https://example.test/admin' }).open).toBe(
        'https://example.test/admin',
      );
    });

    it('treats false as not opening anything', () => {
      expect(processFrom({ command: 'x', open: false }).open).toBeUndefined();
    });

    // `open` reaches the platform's URL handler, and a warpline.yml arrives with
    // any cloned repository, so the accepted set is narrowed to http(s).
    it('rejects a file: URL', () => {
      expect(problemsOf({ processes: { web: { command: 'x', open: 'file:///etc/passwd' } } }).join('\n')).toContain(
        'must be an http(s) URL',
      );
    });

    it('rejects a javascript: URL', () => {
      expect(problemsOf({ processes: { web: { command: 'x', open: 'javascript:alert(1)' } } }).join('\n')).toContain(
        'must be an http(s) URL',
      );
    });

    it('rejects a custom protocol handler', () => {
      expect(problemsOf({ processes: { web: { command: 'x', open: 'ms-msdt:/id' } } }).join('\n')).toContain(
        'must be an http(s) URL',
      );
    });

    it('rejects a string that is not a URL at all', () => {
      expect(problemsOf({ processes: { web: { command: 'x', open: 'open the app' } } }).join('\n')).toContain(
        'must be an http(s) URL',
      );
    });

    it('still accepts an http URL containing shell metacharacters, which openUrl neutralises', () => {
      // `&` is legal in a query string, so the schema cannot reject it without
      // rejecting ordinary URLs. Keeping it away from a shell is openUrl's job;
      // this test records where the boundary sits so neither layer is mistaken
      // for the whole defence.
      expect(processFrom({ command: 'x', open: 'http://localhost:3000/?a=1&b=2' }).open).toBe(
        'http://localhost:3000/?a=1&b=2',
      );
    });
  });

  describe('stopTimeout and shell', () => {
    it('defaults the grace period', () => {
      expect(processFrom('x').stopTimeoutMs).toBe(8000);
    });

    it('accepts stop_timeout as an alias', () => {
      expect(processFrom({ command: 'x', stop_timeout: 2000 }).stopTimeoutMs).toBe(2000);
    });

    it('accepts a shell override', () => {
      expect(processFrom({ command: 'x', shell: '/bin/bash' }).shell).toBe('/bin/bash');
    });

    it('rejects a non-string shell', () => {
      expect(problemsOf({ processes: { web: { command: 'x', shell: true } } })).toContain(
        'processes.web.shell must be a path to a shell executable',
      );
    });
  });

  describe('env', () => {
    it('defaults to an empty block', () => {
      expect(normalize({ processes: { web: 'x' } }).env).toEqual({
        files: [],
        requireFiles: [],
        vars: {},
        passthrough: [],
        require: [],
        isolate: false,
      });
    });

    it('treats a block with no reserved keys as literal variables', () => {
      const env = normalize({ env: { NODE_ENV: 'development' }, processes: { web: 'x' } }).env;
      expect(env.vars).toEqual({ NODE_ENV: 'development' });
      expect(env.files).toEqual([]);
    });

    it('reads the long form', () => {
      const env = normalize({
        env: { files: ['.env', '.env.local'], require: ['DATABASE_URL'], isolate: true },
        processes: { web: 'x' },
      }).env;
      expect(env.files).toEqual(['.env', '.env.local']);
      expect(env.require).toEqual(['DATABASE_URL']);
      expect(env.isolate).toBe(true);
    });

    it('accepts a single file as a string', () => {
      expect(normalize({ env: { files: '.env' }, processes: { web: 'x' } }).env.files).toEqual(['.env']);
    });

    it('adds a required file to the load list automatically', () => {
      const env = normalize({ env: { requireFiles: ['.env'] }, processes: { web: 'x' } }).env;
      expect(env.files).toEqual(['.env']);
      expect(env.requireFiles).toEqual(['.env']);
    });

    it('accepts require_files as an alias', () => {
      expect(normalize({ env: { require_files: ['.env'] }, processes: { web: 'x' } }).env.requireFiles).toEqual([
        '.env',
      ]);
    });

    it('stringifies numeric and boolean values', () => {
      const vars = normalize({ env: { vars: { PORT: 3000, DEBUG: true } }, processes: { web: 'x' } }).env.vars;
      expect(vars).toEqual({ PORT: '3000', DEBUG: 'true' });
    });

    it('reads a null value as an empty string', () => {
      expect(normalize({ env: { vars: { EMPTY: null } }, processes: { web: 'x' } }).env.vars).toEqual({ EMPTY: '' });
    });

    it('rejects an invalid variable name', () => {
      expect(problemsOf({ env: { vars: { '1BAD': 'x' } }, processes: { web: 'x' } }).join('\n')).toContain(
        'is not a valid environment variable name',
      );
    });

    it('allows * in passthrough but rejects a malformed name', () => {
      expect(() => normalize({ env: { passthrough: ['*'] }, processes: { web: 'x' } })).not.toThrow();
      expect(problemsOf({ env: { passthrough: ['1BAD'] }, processes: { web: 'x' } }).join('\n')).toContain(
        'env.passthrough contains an invalid variable name',
      );
    });

    it('rejects a malformed name in require', () => {
      expect(problemsOf({ env: { require: ['not-valid'] }, processes: { web: 'x' } }).join('\n')).toContain(
        'env.require contains an invalid variable name',
      );
    });

    it('rejects an env block that is not a mapping', () => {
      expect(problemsOf({ env: ['.env'], processes: { web: 'x' } })).toContain('env must be a mapping');
    });

    it('rejects a variable placed alongside long-form keys instead of dropping it', () => {
      // Mixing the forms used to silently discard the variable: the block took the
      // long-form branch and NODE_ENV was never read.
      const problems = problemsOf({
        env: { files: ['.env'], NODE_ENV: 'development' },
        processes: { web: 'x' },
      }).join('\n');
      expect(problems).toContain('unknown key "env.NODE_ENV"');
      expect(problems).toContain('env.vars');
    });

    it('still accepts a pure shorthand block', () => {
      expect(normalize({ env: { NODE_ENV: 'development' }, processes: { web: 'x' } }).env.vars).toEqual({
        NODE_ENV: 'development',
      });
    });

    it('keeps per-process variables separate from project ones', () => {
      const proc = processFrom({ command: 'x', env: { API_URL: 'http://localhost:4000' } });
      expect(proc.env).toEqual({ API_URL: 'http://localhost:4000' });
    });
  });

  describe('hooks', () => {
    it('defaults to empty lists', () => {
      expect(normalize({ processes: { web: 'x' } }).hooks).toEqual({ before: [], after: [], cleanup: [] });
    });

    it('accepts a single command as a string', () => {
      expect(normalize({ hooks: { before: 'docker compose up -d' }, processes: { web: 'x' } }).hooks.before).toEqual([
        'docker compose up -d',
      ]);
    });

    it('accepts a list', () => {
      const hooks = normalize({ hooks: { cleanup: ['a', 'b'] }, processes: { web: 'x' } }).hooks;
      expect(hooks.cleanup).toEqual(['a', 'b']);
    });

    it('rejects a hooks block that is not a mapping', () => {
      expect(problemsOf({ hooks: 'docker compose up', processes: { web: 'x' } })).toContain(
        'hooks must be a mapping with before/after/cleanup',
      );
    });
  });

  it('reports every problem at once rather than stopping at the first', () => {
    // One round of errors beats one error per run.
    const problems = problemsOf({
      nope: true,
      note: 42,
      env: { vars: { '1BAD': 'x' } },
      processes: { web: { cmmand: 'typo' }, '-bad': 'x' },
    });
    expect(problems.length).toBeGreaterThanOrEqual(4);
    expect(problems.join('\n')).toContain('unknown top-level key "nope"');
    expect(problems.join('\n')).toContain('note must be a string');
    expect(problems.join('\n')).toContain('processes.web.command is required');
  });

  it('mentions the config path in the thrown error', () => {
    expect(() => normalize({ processes: {} })).toThrowError(new RegExp(TEST_CONFIG_FILE.replace(/\\/g, '\\\\')));
  });
});
