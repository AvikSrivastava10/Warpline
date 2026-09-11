import path from 'node:path';
import { WarplineError } from '../core/errors.js';
import { theme, out, glyph } from '../core/ui.js';
import { tildify } from '../core/paths.js';
import { isInteractive, promptSelect } from '../core/prompt.js';
import { loadConfigFile, loadConfigFrom, findConfigFile, configExistsIn } from '../config/load.js';
import type { WarplineConfig } from '../config/types.js';
import { findProjectsByRoot, listProjects, resolveProjectName, type RegistryEntry } from '../state/registry.js';

export interface ResolvedProject {
  /** The name Warpline uses for state, logs, and the registry. */
  name: string;
  config: WarplineConfig;
  /** Present when the project came from the global index. */
  entry: RegistryEntry | undefined;
  /** True when the name was reached through fuzzy matching. */
  matchedFuzzily: boolean;
}

/**
 * Resolves the project a command should act on.
 *
 * Two entry points converge here: an explicit name looked up in the global
 * index, or the current directory walked upward for a `warpline.yml`. The
 * directory path exists so a teammate who cloned the repo can run `warpline up`
 * immediately, before ever registering a name.
 */
export async function resolveProject(nameArg: string | undefined, cwd = process.cwd()): Promise<ResolvedProject> {
  if (nameArg === undefined || nameArg.trim().length === 0) {
    return resolveFromDirectory(cwd);
  }

  const query = nameArg.trim();
  const resolution = resolveProjectName(query);

  if (resolution.entry) {
    return buildFromEntry(resolution.entry, resolution.fuzzy);
  }

  // Nothing in the index matched. If the current directory's own config carries
  // that name, honour it: an unregistered project is still a real project.
  const localConfigFile = findConfigFile(cwd);
  if (localConfigFile) {
    const config = loadConfigFile(localConfigFile);
    if (config.name === query) {
      return { name: config.name, config, entry: undefined, matchedFuzzily: false };
    }
  }

  // Several candidates were plausible. Ask rather than guess.
  if (resolution.matches.length > 0) {
    if (isInteractive() && resolution.matches.length > 1) {
      const picked = await promptSelect(
        `"${query}" matches several saved projects. Which one?`,
        resolution.matches.slice(0, 8).map((match) => ({
          label: match.name,
          value: match.item,
          hint: tildify(match.item.root),
        })),
      );
      return buildFromEntry(picked, true);
    }

    throw new WarplineError(`No saved project named "${query}"`, {
      hint: `Did you mean: ${resolution.matches
        .slice(0, 5)
        .map((match) => match.name)
        .join(', ')}?`,
    });
  }

  const known = listProjects();
  throw new WarplineError(`No saved project named "${query}"`, {
    hint:
      known.length > 0
        ? `Saved projects: ${known.map((entry) => entry.name).join(', ')}`
        : 'Run `warpline init` in a project directory to create your first one.',
  });
}

function buildFromEntry(entry: RegistryEntry, matchedFuzzily: boolean): ResolvedProject {
  const configFile = configExistsIn(entry.root);
  if (!configFile) {
    throw new WarplineError(`"${entry.name}" points at ${tildify(entry.root)}, but there is no warpline.yml there`, {
      hint: `The project may have moved. Re-register it with \`warpline link ${entry.name}\` from its new location, or drop it with \`warpline remove ${entry.name}\`.`,
    });
  }

  const config = loadConfigFile(configFile);
  if (matchedFuzzily) {
    out.note(`${glyph.arrow} matched "${entry.name}"`);
  }

  // Identity comes from the config, not the index entry. Index names are
  // aliases, so `warpline up myalias` and `warpline up` from inside the folder must
  // resolve to the same state, logs, and running processes.
  return { name: config.name, config, entry, matchedFuzzily };
}

function resolveFromDirectory(cwd: string): ResolvedProject {
  const config = loadConfigFrom(cwd);
  const registered = findProjectsByRoot(config.root);
  const preferred = registered.find((entry) => entry.name === config.name) ?? registered[0];

  return {
    name: config.name,
    config,
    entry: preferred,
    matchedFuzzily: false,
  };
}

/**
 * Resolves a project without requiring its config to be loadable. Used by
 * commands that must still work when the config is missing or broken, such as
 * `down` (stop what is running) and `remove` (clean up a dead entry).
 */
export async function resolveProjectLoosely(
  nameArg: string | undefined,
  cwd = process.cwd(),
): Promise<{ name: string; root: string | undefined; config: WarplineConfig | undefined }> {
  if (nameArg === undefined || nameArg.trim().length === 0) {
    const configFile = findConfigFile(cwd);
    if (!configFile) {
      throw new WarplineError(`No warpline.yml found in ${tildify(path.resolve(cwd))} or any parent directory`, {
        hint: 'Pass a project name, or run this from inside a project.',
      });
    }
    const config = loadConfigFile(configFile);
    return { name: config.name, root: config.root, config };
  }

  const query = nameArg.trim();
  const resolution = resolveProjectName(query);
  const entry = resolution.entry;

  if (!entry) {
    const known = listProjects();
    throw new WarplineError(`No saved project named "${query}"`, {
      hint:
        resolution.matches.length > 0
          ? `Did you mean: ${resolution.matches.slice(0, 5).map((m) => m.name).join(', ')}?`
          : known.length > 0
            ? `Saved projects: ${known.map((e) => e.name).join(', ')}`
            : undefined,
    });
  }

  const configFile = configExistsIn(entry.root);
  let config: WarplineConfig | undefined;
  if (configFile) {
    try {
      config = loadConfigFile(configFile);
    } catch {
      // Deliberately swallowed: a broken config must not block stopping or
      // removing a project.
      config = undefined;
    }
  }

  // Prefer the config's identity for the same reason as `buildFromEntry`, and
  // fall back to the alias when the config cannot be read at all.
  return { name: config?.name ?? entry.name, root: entry.root, config };
}

/** Shared header shown by the commands that act on one project. */
export function printProjectHeader(name: string, root: string, extra?: string): void {
  const suffix = extra ? ` ${theme.dim(extra)}` : '';
  out.note(`${theme.bold(theme.accent(name))} ${theme.dim(tildify(root))}${suffix}`);
}
