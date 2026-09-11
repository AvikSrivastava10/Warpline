import path from 'node:path';
import fs from 'node:fs';
import YAML from 'yaml';
import { dirExists, fileExists, readTextOrNull } from '../core/fsx.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno';

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  engines?: Record<string, string>;
}

export interface WorkspacePackage {
  /** Path relative to the project root, POSIX-style for config readability. */
  relativeDir: string;
  absoluteDir: string;
  name: string;
  pkg: PackageJson;
}

const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
  { file: 'deno.lock', manager: 'deno' },
];

export function readPackageJson(dir: string): PackageJson | undefined {
  const text = readTextOrNull(path.join(dir, 'package.json'));
  if (text === null) return undefined;
  try {
    const parsed = JSON.parse(text) as PackageJson;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lockfile presence beats the `packageManager` field because the lockfile is
 * what the repo actually installed with; a stale `packageManager` string is a
 * common source of "works on my machine".
 */
export function detectPackageManager(root: string): PackageManager | undefined {
  for (const entry of LOCKFILES) {
    if (fileExists(path.join(root, entry.file))) return entry.manager;
  }

  const pkg = readPackageJson(root);
  const declared = pkg?.packageManager;
  if (typeof declared === 'string') {
    const name = declared.split('@')[0]?.trim();
    if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name;
  }

  if (fileExists(path.join(root, 'deno.json')) || fileExists(path.join(root, 'deno.jsonc'))) return 'deno';
  if (pkg) return 'npm';
  return undefined;
}

/** The command prefix used to invoke a package script. */
export function runScriptCommand(manager: PackageManager | undefined, script: string): string {
  switch (manager) {
    case 'pnpm':
      return `pnpm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    case 'deno':
      return `deno task ${script}`;
    default:
      return `npm run ${script}`;
  }
}

/**
 * Expands workspace globs. Only the trailing `*` and `**` forms are handled,
 * which covers essentially every real-world workspace declaration
 * (`packages/*`, `apps/*`) without pulling in a glob dependency.
 */
function expandWorkspaceGlob(root: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.startsWith('!')) return [];

  const starIndex = normalized.indexOf('*');
  if (starIndex === -1) {
    const dir = path.join(root, normalized);
    return dirExists(dir) ? [normalized] : [];
  }

  const prefix = normalized.slice(0, starIndex).replace(/\/+$/, '');
  const baseDir = prefix.length > 0 ? path.join(root, prefix) : root;
  if (!dirExists(baseDir)) return [];

  const results: string[] = [];
  const walk = (dir: string, relative: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const childRelative = relative.length > 0 ? `${relative}/${entry.name}` : entry.name;
      if (fileExists(path.join(dir, entry.name, 'package.json'))) {
        results.push(childRelative);
      } else if (depth > 0) {
        walk(path.join(dir, entry.name), childRelative, depth - 1);
      }
    }
  };

  // `**` means "search deeper"; a single `*` means one level only.
  walk(baseDir, prefix, normalized.includes('**') ? 3 : 0);
  return results;
}

export function detectWorkspaces(root: string): WorkspacePackage[] {
  const patterns: string[] = [];

  const pnpmText = readTextOrNull(path.join(root, 'pnpm-workspace.yaml'));
  if (pnpmText !== null) {
    try {
      const parsed = YAML.parse(pnpmText) as { packages?: unknown };
      if (Array.isArray(parsed?.packages)) {
        for (const entry of parsed.packages) if (typeof entry === 'string') patterns.push(entry);
      }
    } catch {
      /* a broken workspace file should not block detection */
    }
  }

  const pkg = readPackageJson(root);
  const declared = Array.isArray(pkg?.workspaces) ? pkg?.workspaces : pkg?.workspaces?.packages;
  if (Array.isArray(declared)) {
    for (const entry of declared) if (typeof entry === 'string') patterns.push(entry);
  }

  const seen = new Set<string>();
  const packages: WorkspacePackage[] = [];
  for (const pattern of patterns) {
    for (const relativeDir of expandWorkspaceGlob(root, pattern)) {
      if (seen.has(relativeDir)) continue;
      seen.add(relativeDir);
      const absoluteDir = path.join(root, relativeDir);
      const childPkg = readPackageJson(absoluteDir);
      if (!childPkg) continue;
      packages.push({
        relativeDir,
        absoluteDir,
        name: childPkg.name ?? path.basename(absoluteDir),
        pkg: childPkg,
      });
    }
  }

  return packages.sort((a, b) => a.relativeDir.localeCompare(b.relativeDir));
}

export function allDependencies(pkg: PackageJson | undefined): Record<string, string> {
  if (!pkg) return {};
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
}

export interface EnvFileScan {
  /** Real env files present, ordered so more specific ones load later. */
  present: string[];
  /** Template files (`.env.example`) used to derive required keys. */
  templates: string[];
  /** Keys declared in the templates. */
  templateKeys: string[];
}

const ENV_FILE_ORDER = ['.env', '.env.development', '.env.dev', '.env.local', '.env.development.local'];
const ENV_TEMPLATE_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'env.example'];

export function scanEnvFiles(dir: string): EnvFileScan {
  const present = ENV_FILE_ORDER.filter((file) => fileExists(path.join(dir, file)));
  const templates = ENV_TEMPLATE_FILES.filter((file) => fileExists(path.join(dir, file)));

  const keys = new Set<string>();
  for (const template of templates) {
    const text = readTextOrNull(path.join(dir, template));
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (match?.[1]) keys.add(match[1]);
    }
  }

  return { present, templates, templateKeys: [...keys].sort() };
}

/** Node version pin, checked in the order a version manager would. */
export function detectNodeVersionPin(root: string): { source: string; range: string } | undefined {
  const nvmrc = readTextOrNull(path.join(root, '.nvmrc'));
  if (nvmrc !== null && nvmrc.trim().length > 0) {
    return { source: '.nvmrc', range: nvmrc.trim().split(/\s+/)[0] ?? nvmrc.trim() };
  }

  const toolVersions = readTextOrNull(path.join(root, '.tool-versions'));
  if (toolVersions !== null) {
    for (const line of toolVersions.split(/\r?\n/)) {
      const match = /^\s*nodejs\s+(\S+)/.exec(line);
      if (match?.[1]) return { source: '.tool-versions', range: match[1] };
    }
  }

  const pkg = readPackageJson(root);
  const engines = pkg?.engines?.node;
  if (typeof engines === 'string' && engines.trim().length > 0) {
    return { source: 'package.json engines.node', range: engines.trim() };
  }

  return undefined;
}

export function findComposeFile(root: string): string | undefined {
  const candidates = [
    'compose.yaml',
    'compose.yml',
    'docker-compose.yml',
    'docker-compose.yaml',
  ];
  for (const candidate of candidates) {
    if (fileExists(path.join(root, candidate))) return candidate;
  }
  return undefined;
}
