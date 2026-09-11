import path from 'node:path';
import { paths } from '../core/paths.js';
import { readJsonSafe, withLock, writeJsonAtomic } from '../core/fsx.js';
import { WarplineError } from '../core/errors.js';
import { isUnambiguous, matchName, type Match } from '../core/fuzzy.js';

export const REGISTRY_VERSION = 1;

export interface RegistryEntry {
  name: string;
  /** Absolute path to the project root (the directory holding warpline.yml). */
  root: string;
  createdAt: number;
  lastUsedAt: number | undefined;
  useCount: number;
}

interface RegistryFile {
  version: number;
  projects: Record<string, Omit<RegistryEntry, 'name'>>;
}

/**
 * The global index is intentionally thin: it maps a memorable name to a
 * directory and nothing else. All behaviour lives in the project's own
 * `warpline.yml` so it travels with the repo, gets code-reviewed, and works for
 * teammates who never ran `warpline init`.
 */
function emptyRegistry(): RegistryFile {
  return { version: REGISTRY_VERSION, projects: {} };
}

function readRegistry(): RegistryFile {
  const data = readJsonSafe<RegistryFile>(paths.registryFile(), emptyRegistry());
  if (typeof data.projects !== 'object' || data.projects === null) return emptyRegistry();
  return { version: data.version ?? REGISTRY_VERSION, projects: data.projects };
}

export function listProjects(): RegistryEntry[] {
  const registry = readRegistry();
  return Object.entries(registry.projects)
    .map(([name, entry]) => ({
      name,
      root: entry.root,
      createdAt: entry.createdAt ?? 0,
      lastUsedAt: entry.lastUsedAt,
      useCount: entry.useCount ?? 0,
    }))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name));
}

export function getProject(name: string): RegistryEntry | undefined {
  return listProjects().find((entry) => entry.name === name);
}

function lockPath(): string {
  return path.join(paths.home(), 'registry.lock');
}

async function mutate(fn: (registry: RegistryFile) => void): Promise<void> {
  await withLock(lockPath(), () => {
    const registry = readRegistry();
    fn(registry);
    registry.version = REGISTRY_VERSION;
    writeJsonAtomic(paths.registryFile(), registry);
  });
}

export async function upsertProject(name: string, root: string): Promise<void> {
  const absoluteRoot = path.resolve(root);
  await mutate((registry) => {
    const existing = registry.projects[name];
    registry.projects[name] = {
      root: absoluteRoot,
      createdAt: existing?.createdAt ?? Date.now(),
      lastUsedAt: existing?.lastUsedAt,
      useCount: existing?.useCount ?? 0,
    };
  });
}

export async function touchProject(name: string): Promise<void> {
  await mutate((registry) => {
    const existing = registry.projects[name];
    if (!existing) return;
    existing.lastUsedAt = Date.now();
    existing.useCount = (existing.useCount ?? 0) + 1;
  });
}

export async function removeProject(name: string): Promise<boolean> {
  let removed = false;
  await mutate((registry) => {
    if (registry.projects[name]) {
      delete registry.projects[name];
      removed = true;
    }
  });
  return removed;
}

export async function renameProject(from: string, to: string): Promise<void> {
  await mutate((registry) => {
    const entry = registry.projects[from];
    if (!entry) throw new WarplineError(`No saved project named "${from}"`);
    if (registry.projects[to]) throw new WarplineError(`A project named "${to}" already exists`);
    registry.projects[to] = entry;
    delete registry.projects[from];
  });
}

/** Every registered name whose root is the given directory. */
export function findProjectsByRoot(root: string): RegistryEntry[] {
  const absolute = path.resolve(root);
  return listProjects().filter((entry) => path.resolve(entry.root) === absolute);
}

export interface ResolveResult {
  entry: RegistryEntry | undefined;
  matches: Match<RegistryEntry>[];
  /** True when the name was matched loosely rather than exactly. */
  fuzzy: boolean;
}

/**
 * Resolves a user-supplied name against the registry, tolerating typos and
 * abbreviations. Returns all candidates so the caller can prompt when the
 * intent is genuinely ambiguous rather than guessing.
 */
export function resolveProjectName(query: string): ResolveResult {
  const projects = listProjects();
  const exact = projects.find((entry) => entry.name === query);
  if (exact) return { entry: exact, matches: [], fuzzy: false };

  const matches = matchName(query, projects, (entry) => entry.name);
  const best = matches[0];

  if (best && isUnambiguous(matches)) {
    return { entry: best.item, matches, fuzzy: best.kind !== 'exact' };
  }

  return { entry: undefined, matches, fuzzy: true };
}
