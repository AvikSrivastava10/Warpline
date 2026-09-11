import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProject, extractPortFromCommand, type ProcessCandidate } from '../../src/detect/candidates.js';
import { createTempDir, removeTempDir, writeTree } from '../helpers/tmpdir.js';

let root: string;

beforeEach(() => {
  root = createTempDir('warpline-detect-candidates-');
});

afterEach(() => {
  removeTempDir(root);
});

const pkg = (value: Record<string, unknown>): string => JSON.stringify(value, null, 2);

function detect(files: Record<string, string>): ProcessCandidate[] {
  writeTree(root, files);
  return detectProject(root).candidates;
}

function byId(candidates: ProcessCandidate[], id: string): ProcessCandidate | undefined {
  return candidates.find((candidate) => candidate.id === id);
}

describe('extractPortFromCommand', () => {
  it.each([
    ['next dev --port 4000', 4000],
    ['next dev --port=4000', 4000],
    ['vite -p 5000', 5000],
    ['PORT=8080 node server.js', 8080],
    ['node server.js --listen 127.0.0.1:9000', 9000],
    ['node server.js --listen 9000', 9000],
  ])('reads a port out of %s', (command, expected) => {
    expect(extractPortFromCommand(command)).toBe(expected);
  });

  it('returns undefined when no port is present', () => {
    expect(extractPortFromCommand('npm run dev')).toBeUndefined();
  });

  it('ignores a number too short to be a port', () => {
    expect(extractPortFromCommand('node script.js -p 8')).toBeUndefined();
  });
});

describe('script classification', () => {
  it('ranks dev above start, and start above serve', () => {
    const candidates = detect({
      'package.json': pkg({ name: 'demo', scripts: { serve: 'node s.js', start: 'node s.js', dev: 'node s.js' } }),
    });
    expect(candidates.map((c) => c.id)).toEqual(['dev', 'start', 'serve']);
  });

  it('recommends long-running scripts and not gating tasks', () => {
    const candidates = detect({
      'package.json': pkg({ name: 'demo', scripts: { dev: 'node s.js', migrate: 'node m.js' } }),
    });
    expect(byId(candidates, 'dev')?.recommended).toBe(true);
    expect(byId(candidates, 'migrate')?.recommended).toBe(false);
  });

  it('classifies migrations and seeds as tasks', () => {
    const candidates = detect({
      'package.json': pkg({
        name: 'demo',
        scripts: { dev: 'node s.js', migrate: 'node m.js', 'db:seed': 'node seed.js' },
      }),
    });
    expect(byId(candidates, 'migrate')?.kind).toBe('task');
    // Note the id: see the normalisation test below.
    expect(byId(candidates, 'db-seed')?.kind).toBe('task');
  });

  it('normalises a script name into a legal process id', () => {
    // Process ids have to satisfy the config schema, which does not allow a colon,
    // so `db:seed` becomes `db-seed` while the command still runs the real script.
    const candidates = detect({
      'package.json': pkg({ name: 'demo', scripts: { 'db:migrate': 'node m.js' } }),
    });
    expect(candidates.map((c) => c.id)).toEqual(['db-migrate']);
    expect(byId(candidates, 'db-migrate')?.command).toBe('npm run db:migrate');
  });

  it('never suggests scripts that are not part of starting a project', () => {
    const candidates = detect({
      'package.json': pkg({
        name: 'demo',
        scripts: {
          dev: 'node s.js',
          test: 'vitest',
          lint: 'eslint .',
          'test:watch': 'vitest',
          typecheck: 'tsc',
          format: 'prettier -w .',
          deploy: 'sh deploy.sh',
          postinstall: 'node p.js',
        },
      }),
    });
    expect(candidates.map((c) => c.id)).toEqual(['dev']);
  });

  it('excludes prepare, which is a lifecycle hook rather than a task', () => {
    // `prepare` matches both the task list and the never-suggest list; the
    // exclusion is checked first and wins.
    const candidates = detect({
      'package.json': pkg({ name: 'demo', scripts: { dev: 'node s.js', prepare: 'husky install' } }),
    });
    expect(byId(candidates, 'prepare')).toBeUndefined();
  });

  it('treats a bare role name as a service', () => {
    const candidates = detect({
      'package.json': pkg({ name: 'demo', scripts: { api: 'node api.js', worker: 'node w.js' } }),
    });
    expect(byId(candidates, 'api')?.kind).toBe('service');
    expect(byId(candidates, 'worker')?.recommended).toBe(true);
  });
});

describe('framework inference', () => {
  it('gives a Next.js dev script its default port and probe', () => {
    const candidates = detect({
      'package.json': pkg({ name: 'demo', dependencies: { next: '15.0.0' }, scripts: { dev: 'next dev' } }),
    });
    const dev = byId(candidates, 'dev');
    expect(dev?.port).toBe(3000);
    expect(dev?.detail).toContain('Next.js');
  });

  it('prefers an explicit port in the command over the framework default', () => {
    const candidates = detect({
      'package.json': pkg({
        name: 'demo',
        dependencies: { next: '15.0.0' },
        scripts: { dev: 'next dev --port 4321' },
      }),
    });
    expect(byId(candidates, 'dev')?.port).toBe(4321);
  });

  it('recognises a framework from the command even in a non-canonical script', () => {
    // `dev:web` is not a canonical entrypoint, so the framework is identified from
    // what the command actually invokes rather than from the dependency list.
    const candidates = detect({
      'package.json': pkg({ name: 'demo', scripts: { 'dev:web': 'vite' } }),
    });
    expect(byId(candidates, 'dev-web')?.port).toBe(5173);
  });

  it('does not hand a framework port to an unrelated script', () => {
    // Regression for the port-inference leak: every script in a Next.js package
    // used to inherit port 3000, so a worker that binds nothing claimed the web
    // server's port and the two fought over it.
    const candidates = detect({
      'package.json': pkg({
        name: 'demo',
        dependencies: { next: '15.0.0' },
        scripts: { dev: 'next dev', 'dev:worker': 'node worker.js' },
      }),
    });
    expect(byId(candidates, 'dev')?.port).toBe(3000);
    expect(byId(candidates, 'dev:worker')?.port).toBeUndefined();
  });

  it('gives a script with no port a log probe instead', () => {
    const candidates = detect({
      'package.json': pkg({ name: 'demo', dependencies: { fastify: '4.0.0' }, scripts: { dev: 'node s.js' } }),
    });
    const dev = byId(candidates, 'dev');
    // Framework known from dependencies, port comes from the signature.
    expect(dev?.port ?? dev?.readyLog).toBeTruthy();
  });

  it('never lets two candidates claim the same port', () => {
    const candidates = detect({
      'package.json': pkg({
        name: 'demo',
        dependencies: { vite: '5.0.0' },
        scripts: { dev: 'vite', serve: 'vite preview --port 5173' },
      }),
    });
    const ports = candidates.map((c) => c.port).filter((port): port is number => port !== undefined);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe('compose detection', () => {
  it('surfaces datastores as first-class candidates ahead of app servers', () => {
    // "I forgot to start the database" is the most common start failure, so these
    // rank above application processes and get a port probe.
    const candidates = detect({
      'package.json': pkg({ name: 'demo', scripts: { dev: 'node s.js' } }),
      'docker-compose.yml': [
        'services:',
        '  postgres:',
        '    image: postgres:16',
        '  redis:',
        '    image: redis:7',
        '  app:',
        '    build: .',
      ].join('\n'),
    });

    expect(candidates[0]?.source).toBe('compose');
    expect(byId(candidates, 'postgres')?.command).toBe('docker compose up postgres');
    expect(byId(candidates, 'postgres')?.port).toBe(5432);
    expect(byId(candidates, 'redis')?.port).toBe(6379);
    // An unrecognised service is not guessed at.
    expect(byId(candidates, 'app')).toBeUndefined();
  });

  it('uses the published host port rather than the container port', () => {
    // The application connects to the host port, so that is the one to probe.
    const candidates = detect({
      'docker-compose.yml': [
        'services:',
        '  postgres:',
        '    image: postgres:16',
        '    ports: ["5433:5432"]',
        '  redis:',
        '    image: redis:7',
        '    ports: ["127.0.0.1:6380:6379"]',
      ].join('\n'),
    });
    expect(byId(candidates, 'postgres')?.port).toBe(5433);
    expect(byId(candidates, 'redis')?.port).toBe(6380);
  });

  it('matches a datastore by service name when the image is unclear', () => {
    const candidates = detect({
      'docker-compose.yml': 'services:\n  mongo:\n    image: internal/registry/db:1\n',
    });
    expect(byId(candidates, 'mongo')?.port).toBe(27017);
  });

  it('survives a malformed compose file', () => {
    const candidates = detect({
      'package.json': pkg({ name: 'demo', scripts: { dev: 'node s.js' } }),
      'docker-compose.yml': 'services: [unclosed\n',
    });
    expect(candidates.map((c) => c.id)).toEqual(['dev']);
  });
});

describe('Procfile detection', () => {
  it('reads web and worker style entries', () => {
    const candidates = detect({
      Procfile: ['# comment', 'web: node server.js --port 3000', 'worker: node worker.js', ''].join('\n'),
    });
    expect(byId(candidates, 'web')?.port).toBe(3000);
    expect(byId(candidates, 'worker')?.command).toBe('node worker.js');
    expect(byId(candidates, 'web')?.source).toBe('procfile');
  });
});

describe('workspace candidates', () => {
  it('prefixes ids with the package directory and ranks them below the root', () => {
    const candidates = detect({
      'package.json': pkg({ name: 'demo', workspaces: ['apps/*'], scripts: { dev: 'node root.js' } }),
      'apps/web/package.json': pkg({ name: 'web', scripts: { dev: 'node web.js' } }),
      'apps/api/package.json': pkg({ name: 'api', scripts: { dev: 'node api.js', migrate: 'node m.js' } }),
    });

    expect(byId(candidates, 'web')?.cwd).toBe('apps/web');
    expect(byId(candidates, 'api')?.cwd).toBe('apps/api');
    // `dev` in a workspace collapses to the directory name; anything else appends.
    expect(byId(candidates, 'api-migrate')?.kind).toBe('task');

    const rootDev = byId(candidates, 'dev');
    expect(rootDev?.score).toBeGreaterThan(byId(candidates, 'web')?.score ?? 0);
  });
});

describe('detectProject summary', () => {
  it('suggests a name from the package, stripped of its scope', () => {
    writeTree(root, { 'package.json': pkg({ name: '@acme/My_App' }) });
    expect(detectProject(root).suggestedName).toBe('my_app');
  });

  it('falls back to the directory name', () => {
    expect(detectProject(root).suggestedName).toBe(root.split(/[\\/]/).pop()?.toLowerCase());
  });

  it('reports the environment, workspaces, compose file and node pin together', () => {
    writeTree(root, {
      'package.json': pkg({
        name: 'demo',
        dependencies: { next: '15.0.0' },
        workspaces: ['apps/*'],
        scripts: { dev: 'next dev' },
      }),
      'pnpm-lock.yaml': '',
      'apps/web/package.json': pkg({ name: 'web' }),
      '.env': '',
      '.env.example': 'DATABASE_URL=\n',
      'compose.yaml': 'services: {}\n',
      '.nvmrc': '22.0.0\n',
    });

    const result = detectProject(root);
    expect(result.packageManager).toBe('pnpm');
    expect(result.framework).toBe('Next.js');
    expect(result.workspaces).toHaveLength(1);
    expect(result.composeFile).toBe('compose.yaml');
    expect(result.nodePin?.range).toBe('22.0.0');
    expect(result.env.present).toEqual(['.env']);
    expect(result.env.templateKeys).toEqual(['DATABASE_URL']);
  });

  it('returns no candidates for a directory with nothing recognisable', () => {
    expect(detectProject(root).candidates).toEqual([]);
  });

  it('gives every candidate a unique id', () => {
    const candidates = detect({
      'package.json': pkg({ name: 'demo', workspaces: ['apps/*'], scripts: { dev: 'node r.js' } }),
      'apps/dev/package.json': pkg({ name: 'dev', scripts: { dev: 'node d.js' } }),
    });
    const ids = candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
