import path from 'node:path';
import YAML from 'yaml';
import { ConfigError, WarplineError } from '../core/errors.js';
import { fileExists, readTextOrNull, writeFileAtomic } from '../core/fsx.js';
import { normalizeConfig } from './schema.js';
import type { WarplineConfig } from './types.js';

/** Checked in order, so `warpline.yml` wins over `warpline.json` if both exist. */
export const CONFIG_FILENAMES = ['warpline.yml', 'warpline.yaml', 'warpline.json'] as const;

export const PRIMARY_CONFIG_FILENAME = 'warpline.yml';

/**
 * Walks up from `startDir` looking for a config file, the same way git finds
 * `.git`. This means `warpline up` works from anywhere inside a repo, not just
 * the root.
 */
export function findConfigFile(startDir: string): string | undefined {
  let current = path.resolve(startDir);

  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(current, filename);
      if (fileExists(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function parseConfigText(text: string, file: string): unknown {
  const isJson = file.toLowerCase().endsWith('.json');
  try {
    if (isJson) return JSON.parse(text);
    return YAML.parse(text, { prettyErrors: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(file, [`could not be parsed: ${message}`]);
  }
}

/** Loads and validates the config at an explicit path. */
export function loadConfigFile(file: string): WarplineConfig {
  const absolute = path.resolve(file);
  const text = readTextOrNull(absolute);
  if (text === null) {
    throw new WarplineError(`No Warpline config found at ${absolute}`, {
      hint: 'Run `warpline init` in your project to create one.',
    });
  }

  const raw = parseConfigText(text, absolute);
  // An empty file parses to null, which is a much more common mistake than a
  // malformed one and deserves a clearer message.
  if (raw === null || raw === undefined) {
    throw new ConfigError(absolute, ['the file is empty']);
  }

  const fallbackName = path.basename(path.dirname(absolute));
  return normalizeConfig(raw, absolute, fallbackName);
}

/** Finds the nearest config by walking up from `startDir`, then loads it. */
export function loadConfigFrom(startDir: string): WarplineConfig {
  const file = findConfigFile(startDir);
  if (!file) {
    throw new WarplineError(`No ${PRIMARY_CONFIG_FILENAME} found in ${path.resolve(startDir)} or any parent directory`, {
      hint: 'Run `warpline init` here to detect your dev processes and create one.',
    });
  }
  return loadConfigFile(file);
}

/**
 * Edits a YAML config in place through the document API so comments,
 * key order, and formatting survive. Config files are repo-committed and
 * hand-maintained; rewriting them from a parsed object would destroy the
 * author's comments, which is unacceptable for a file people review in PRs.
 */
export function updateConfigDocument(file: string, mutate: (doc: YAML.Document.Parsed) => void): void {
  const absolute = path.resolve(file);
  const text = readTextOrNull(absolute);
  if (text === null) {
    throw new WarplineError(`No Warpline config found at ${absolute}`);
  }

  if (absolute.toLowerCase().endsWith('.json')) {
    // JSON has no comments to preserve, so a parse/mutate/stringify round trip is safe.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const doc = new YAML.Document(parsed) as YAML.Document.Parsed;
    mutate(doc);
    writeFileAtomic(absolute, JSON.stringify(doc.toJSON(), null, 2) + '\n');
    return;
  }

  const doc = YAML.parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new ConfigError(
      absolute,
      doc.errors.map((error) => error.message),
    );
  }
  mutate(doc);
  writeFileAtomic(absolute, doc.toString({ lineWidth: 100 }));
}

export function configExistsIn(dir: string): string | undefined {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(dir, filename);
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}


