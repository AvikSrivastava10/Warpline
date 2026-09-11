import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths, safeSlug, tildify, warplineHome } from '../../src/core/paths.js';
import { createTempDir, removeTempDir, setEnv, type EnvGuard } from '../helpers/tmpdir.js';

let guard: EnvGuard | undefined;

afterEach(() => {
  guard?.restore();
  guard = undefined;
});

describe('warplineHome', () => {
  it('defaults to a dot directory in the user home', () => {
    guard = setEnv({ WARPLINE_HOME: undefined });
    expect(warplineHome()).toBe(path.join(os.homedir(), '.warpline'));
  });

  it('honours the override', () => {
    guard = setEnv({ WARPLINE_HOME: path.join(os.tmpdir(), 'somewhere') });
    expect(warplineHome()).toBe(path.resolve(path.join(os.tmpdir(), 'somewhere')));
  });

  it('ignores a blank override', () => {
    guard = setEnv({ WARPLINE_HOME: '   ' });
    expect(warplineHome()).toBe(path.join(os.homedir(), '.warpline'));
  });

  it('is read on every call, not captured at import', () => {
    // The whole test suite depends on this: it is what allows WARPLINE_HOME to be
    // repointed per test. Caching it would be a small optimisation that makes the
    // filesystem tiers untestable in isolation.
    const first = createTempDir('warpline-paths-a-');
    const second = createTempDir('warpline-paths-b-');
    try {
      guard = setEnv({ WARPLINE_HOME: first });
      expect(warplineHome()).toBe(first);
      guard.restore();

      guard = setEnv({ WARPLINE_HOME: second });
      expect(warplineHome()).toBe(second);
    } finally {
      removeTempDir(first);
      removeTempDir(second);
    }
  });
});

describe('paths layout', () => {
  let home: string;

  beforeEach(() => {
    home = createTempDir('warpline-paths-');
    guard = setEnv({ WARPLINE_HOME: home });
  });

  afterEach(() => {
    removeTempDir(home);
  });

  it('keeps everything under one root, so it is inspectable and deletable', () => {
    const everything = [
      paths.registryFile(),
      paths.settingsFile(),
      paths.stateDir(),
      paths.stateFile('demo'),
      paths.logDir('demo'),
      paths.logFile('demo', 'web'),
      paths.runDir(),
      paths.supervisorLog('demo'),
    ];
    for (const target of everything) {
      expect(target.startsWith(home)).toBe(true);
    }
  });

  it('slugs both the project and the process in a log file path', () => {
    expect(paths.logFile('My App', 'Web Server')).toBe(
      path.join(home, 'logs', safeSlug('My App'), `${safeSlug('Web Server')}.log`),
    );
  });
});

describe('safeSlug', () => {
  it('leaves an already-safe name alone', () => {
    expect(safeSlug('myapp')).toBe('myapp');
    expect(safeSlug('my-app')).toBe('my-app');
    expect(safeSlug('my_app')).toBe('my_app');
    expect(safeSlug('app.v2')).toBe('app.v2');
    expect(safeSlug('web2')).toBe('web2');
  });

  it('is idempotent, because slugs are handed back in as names', () => {
    // listRuntimeNames returns slugs, and callers pass those straight back to
    // inspectRuntime, which slugs again.
    for (const input of ['myapp', 'My App', 'weird/name', 'ALLCAPS', '  spaced  ']) {
      const once = safeSlug(input);
      expect(safeSlug(once)).toBe(once);
    }
  });

  it('produces a filename-safe result for hostile input', () => {
    for (const input of ['My App', 'a/b\\c', 'name:with:colons', '../escape', 'emoji 🎉 name']) {
      const slug = safeSlug(input);
      expect(slug).toMatch(/^[a-z0-9._-]+$/);
      expect(slug).not.toContain('..');
      expect(path.basename(slug)).toBe(slug);
    }
  });

  it('falls back to a placeholder for input with nothing usable', () => {
    expect(safeSlug('')).toBe('unnamed');
    expect(safeSlug('   ')).toBe('unnamed');
  });

  it('keeps names apart that normalisation would otherwise merge', () => {
    // Without this, "MyApp" and "myapp" shared one state file and one log
    // directory, so `status` reported another project's processes and `down`
    // stopped them.
    const collisions = [
      ['MyApp', 'myapp'],
      ['my app', 'my-app'],
      ['My App', 'my app'],
      ['Web/App', 'web-app'],
    ];

    for (const [left, right] of collisions) {
      expect(safeSlug(left as string)).not.toBe(safeSlug(right as string));
    }
  });

  it('is deterministic for the same input', () => {
    expect(safeSlug('My App')).toBe(safeSlug('My App'));
  });

  it('still reads recognisably, keeping the normalised name as a prefix', () => {
    expect(safeSlug('MyApp').startsWith('myapp-')).toBe(true);
  });

  it('bounds the length even for a very long name', () => {
    expect(safeSlug('x'.repeat(500)).length).toBeLessThanOrEqual(110);
  });
});

describe('tildify', () => {
  it('collapses the home prefix', () => {
    expect(tildify(path.join(os.homedir(), 'code', 'demo'))).toBe(path.join('~', 'code', 'demo'));
  });

  it('renders the home directory itself as a bare tilde', () => {
    expect(tildify(os.homedir())).toBe('~');
  });

  it('leaves a path outside home absolute', () => {
    const outside = path.resolve(path.sep, 'opt', 'demo');
    expect(tildify(outside)).toBe(outside);
  });

  it('does not collapse a sibling directory that merely shares the prefix', () => {
    const sibling = os.homedir() + '-backup';
    expect(tildify(sibling)).toBe(path.resolve(sibling));
  });
});
