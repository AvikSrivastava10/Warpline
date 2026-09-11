import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findProjectsByRoot,
  getProject,
  listProjects,
  removeProject,
  renameProject,
  resolveProjectName,
  touchProject,
  upsertProject,
} from '../../src/state/registry.js';
import { paths } from '../../src/core/paths.js';
import { createTempDir, removeTempDir, setEnv, type EnvGuard } from '../helpers/tmpdir.js';

let home: string;
let guard: EnvGuard;

beforeEach(() => {
  home = createTempDir('warpline-registry-');
  guard = setEnv({ WARPLINE_HOME: home });
});

afterEach(() => {
  guard.restore();
  removeTempDir(home);
});

describe('the registry is isolated from real user state', () => {
  it('writes under WARPLINE_HOME rather than the home directory', async () => {
    await upsertProject('demo', '/somewhere');
    expect(paths.registryFile().startsWith(home)).toBe(true);
    expect(fs.existsSync(path.join(home, 'registry.json'))).toBe(true);
  });
});

describe('listProjects', () => {
  it('is empty before anything is registered', () => {
    expect(listProjects()).toEqual([]);
  });

  it('orders by most recently used, then by name', async () => {
    await upsertProject('never-used', home);
    await upsertProject('older', home);
    await upsertProject('newer', home);
    await upsertProject('also-never', home);

    await touchProject('older');
    await touchProject('newer');

    const names = listProjects().map((entry) => entry.name);
    // Used entries come first, most recent first; unused ones fall back to name order.
    expect(names.slice(0, 2)).toEqual(['newer', 'older']);
    expect(names.slice(2)).toEqual(['also-never', 'never-used']);
  });
});

describe('upsertProject', () => {
  it('stores an absolute root', async () => {
    await upsertProject('demo', '.');
    expect(getProject('demo')?.root).toBe(path.resolve('.'));
  });

  it('starts a new entry with no usage recorded', async () => {
    await upsertProject('demo', home);
    const entry = getProject('demo');
    expect(entry?.useCount).toBe(0);
    expect(entry?.lastUsedAt).toBeUndefined();
    expect(entry?.createdAt).toBeGreaterThan(0);
  });

  it('repoints an existing name while preserving its history', async () => {
    await upsertProject('demo', home);
    await touchProject('demo');
    const before = getProject('demo');

    const moved = path.join(home, 'moved');
    fs.mkdirSync(moved);
    await upsertProject('demo', moved);

    const after = getProject('demo');
    expect(after?.root).toBe(moved);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.useCount).toBe(before?.useCount);
    expect(after?.lastUsedAt).toBe(before?.lastUsedAt);
  });
});

describe('touchProject', () => {
  it('records the use and increments the count', async () => {
    await upsertProject('demo', home);
    await touchProject('demo');
    await touchProject('demo');

    const entry = getProject('demo');
    expect(entry?.useCount).toBe(2);
    expect(entry?.lastUsedAt).toBeGreaterThan(0);
  });

  it('does nothing for a name that is not registered', async () => {
    await expect(touchProject('ghost')).resolves.toBeUndefined();
    expect(listProjects()).toEqual([]);
  });
});

describe('removeProject', () => {
  it('reports whether anything was removed', async () => {
    await upsertProject('demo', home);
    await expect(removeProject('demo')).resolves.toBe(true);
    await expect(removeProject('demo')).resolves.toBe(false);
    expect(getProject('demo')).toBeUndefined();
  });

  it('leaves other entries alone', async () => {
    await upsertProject('keep', home);
    await upsertProject('drop', home);
    await removeProject('drop');
    expect(listProjects().map((entry) => entry.name)).toEqual(['keep']);
  });
});

describe('renameProject', () => {
  it('moves the entry and keeps its history', async () => {
    await upsertProject('old', home);
    await touchProject('old');
    const before = getProject('old');

    await renameProject('old', 'new');

    expect(getProject('old')).toBeUndefined();
    const after = getProject('new');
    expect(after?.root).toBe(before?.root);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.useCount).toBe(before?.useCount);
  });

  it('refuses an unknown source name', async () => {
    await expect(renameProject('ghost', 'new')).rejects.toThrow(/No saved project named "ghost"/);
  });

  it('refuses to overwrite an existing name', async () => {
    await upsertProject('a', home);
    await upsertProject('b', home);
    await expect(renameProject('a', 'b')).rejects.toThrow(/already exists/);
  });

  it('leaves the registry untouched when it refuses', async () => {
    await upsertProject('a', home);
    await upsertProject('b', home);
    await expect(renameProject('a', 'b')).rejects.toThrow();
    // The write happens after the mutation callback, so a throw must not persist.
    expect(listProjects().map((entry) => entry.name).sort()).toEqual(['a', 'b']);
  });
});

describe('findProjectsByRoot', () => {
  it('finds every name pointing at a directory', async () => {
    await upsertProject('primary', home);
    await upsertProject('alias', home);
    await upsertProject('elsewhere', path.join(home, 'other'));

    const names = findProjectsByRoot(home).map((entry) => entry.name).sort();
    expect(names).toEqual(['alias', 'primary']);
  });

  it('compares resolved paths rather than strings', async () => {
    await upsertProject('demo', home);
    expect(findProjectsByRoot(path.join(home, 'sub', '..')).map((e) => e.name)).toEqual(['demo']);
  });
});

describe('resolveProjectName', () => {
  beforeEach(async () => {
    await upsertProject('myproject', home);
    await upsertProject('api-server', home);
  });

  it('takes an exact name directly', () => {
    const result = resolveProjectName('myproject');
    expect(result.entry?.name).toBe('myproject');
    expect(result.fuzzy).toBe(false);
  });

  it('accepts an unambiguous abbreviation and flags it as fuzzy', () => {
    const result = resolveProjectName('myproj');
    expect(result.entry?.name).toBe('myproject');
    expect(result.fuzzy).toBe(true);
  });

  it('returns candidates without choosing when two match the same way', async () => {
    // Ambiguity requires an equally good runner-up. A better *kind* of match still
    // wins outright, so "myproject-" resolves to a prefix match over a typo match.
    await upsertProject('mysite', home);
    const result = resolveProjectName('my');
    expect(result.entry).toBeUndefined();
    expect(result.matches.map((match) => match.kind)).toEqual(['prefix', 'prefix']);
    expect(result.matches.length).toBe(2);
  });

  it('still decides when one candidate matches better than the other', async () => {
    await upsertProject('myproject-two', home);
    const result = resolveProjectName('myproject-');
    // Prefix on "myproject-two" beats a one-edit typo on "myproject".
    expect(result.entry?.name).toBe('myproject-two');
  });

  it('returns nothing at all when there is no plausible match', () => {
    const result = resolveProjectName('zzzzzzzz');
    expect(result.entry).toBeUndefined();
    expect(result.matches).toEqual([]);
  });
});

describe('resilience', () => {
  it('treats a corrupt registry as empty rather than failing every command', async () => {
    // readJsonSafe's fallback path, which nothing exercised before.
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(paths.registryFile(), '{ this is not json', 'utf8');

    expect(listProjects()).toEqual([]);

    // And it must be recoverable by simply writing again.
    await upsertProject('demo', home);
    expect(getProject('demo')?.name).toBe('demo');
  });

  it('treats a registry whose projects key is the wrong type as empty', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(paths.registryFile(), JSON.stringify({ version: 1, projects: 'nope' }), 'utf8');
    expect(listProjects()).toEqual([]);
  });

  it('releases the lock so consecutive writes both land', async () => {
    await upsertProject('one', home);
    await upsertProject('two', home);
    await upsertProject('three', home);
    expect(listProjects()).toHaveLength(3);
    expect(fs.existsSync(path.join(home, 'registry.lock'))).toBe(false);
  });
});
