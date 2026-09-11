import path from 'node:path';
import fs from 'node:fs';
import { flagBool, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { WarplineError } from '../core/errors.js';
import { glyph, out, theme } from '../core/ui.js';
import { paths, tildify } from '../core/paths.js';
import { isInteractive, promptConfirm } from '../core/prompt.js';
import { configExistsIn, findConfigFile, loadConfigFile, updateConfigDocument } from '../config/load.js';
import { getProject, listProjects, removeProject, renameProject, upsertProject } from '../state/registry.js';
import { clearRuntime, inspectRuntime } from '../state/runtime.js';
import { resolveProject, resolveProjectLoosely } from './context.js';

export const linkFlags: FlagSpecs = {
  force: { type: 'boolean', alias: 'f', describe: 'Overwrite an existing entry with the same name' },
};

export function linkHelp(): string {
  return [
    `${theme.bold('warpline link')} ${theme.dim('[name]')}`,
    '',
    'Registers the current directory in the global index under a memorable name,',
    'so you can run `warpline up <name>` from anywhere. Also the way to repair an',
    'entry after moving a project on disk.',
    '',
    'The name defaults to whatever `name:` is set to in warpline.yml.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(linkFlags),
  ].join('\n');
}

export async function runLink(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, linkFlags);
  const cwd = process.cwd();

  const configFile = findConfigFile(cwd);
  if (!configFile) {
    throw new WarplineError(`No warpline.yml found in ${tildify(cwd)} or any parent directory`, {
      hint: 'Run `warpline init` here first.',
    });
  }

  const config = loadConfigFile(configFile);
  const name = parsed.positionals[0]?.trim() ?? config.name;

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new WarplineError(`"${name}" is not a valid project name`, {
      hint: 'Use letters, digits, dots, dashes, and underscores; start with a letter or digit.',
    });
  }

  const existing = getProject(name);
  if (existing && path.resolve(existing.root) !== config.root && !flagBool(parsed, 'force')) {
    throw new WarplineError(`"${name}" already points at ${tildify(existing.root)}`, {
      hint: 'Pass --force to repoint it here, or choose a different name.',
    });
  }

  await upsertProject(name, config.root);
  out.success(`${theme.bold(theme.accent(name))} ${theme.dim(glyph.arrow)} ${theme.dim(tildify(config.root))}`);

  if (name !== config.name) {
    out.note(`warpline.yml says name: ${config.name}; the index entry is "${name}". Both work.`);
  }

  return 0;
}

export const removeFlags: FlagSpecs = {
  yes: { type: 'boolean', alias: 'y', describe: 'Skip the confirmation prompt' },
  logs: { type: 'boolean', describe: 'Also delete captured log files' },
};

export function removeHelp(): string {
  return [
    `${theme.bold('warpline remove')} ${theme.dim('<name> [options]')}`,
    '',
    'Removes a project from the global index. This never touches your repository',
    'or its warpline.yml - only the saved name is forgotten.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(removeFlags),
  ].join('\n');
}

export async function runRemove(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, removeFlags);
  const query = parsed.positionals[0];

  if (!query) {
    throw new WarplineError('Which project should be removed?', {
      hint: `Saved projects: ${listProjects().map((entry) => entry.name).join(', ') || '(none)'}`,
    });
  }

  const project = await resolveProjectLoosely(query);

  const info = inspectRuntime(project.name);
  if (info && info.live.length > 0) {
    throw new WarplineError(`"${project.name}" is still running`, {
      hint: `Stop it first with \`warpline down ${project.name}\`.`,
    });
  }

  if (!flagBool(parsed, 'yes') && isInteractive()) {
    const confirmed = await promptConfirm(
      `Forget "${project.name}"? ${theme.dim('(the project files are left untouched)')}`,
      true,
    );
    if (!confirmed) {
      out.note('Cancelled');
      return 0;
    }
  }

  const removed = await removeProject(project.name);
  if (!removed) {
    out.warn(`"${project.name}" was not in the index`);
  } else {
    out.success(`forgot ${theme.bold(project.name)}`);
  }

  clearRuntime(project.name);

  if (flagBool(parsed, 'logs')) {
    const dir = paths.logDir(project.name);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      out.success(`deleted logs in ${tildify(dir)}`);
    } catch (error) {
      out.warn(`could not delete logs: ${(error as Error).message}`);
    }
  }

  if (project.root && configExistsIn(project.root)) {
    out.note(`warpline.yml is still at ${tildify(project.root)} - re-register it any time with \`warpline link\`.`);
  }

  return 0;
}

export const renameFlags: FlagSpecs = {};

export function renameHelp(): string {
  return [
    `${theme.bold('warpline rename')} ${theme.dim('<old> <new>')}`,
    '',
    'Renames a saved project in the global index.',
  ].join('\n');
}

export async function runRename(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, renameFlags);
  const [from, to] = parsed.positionals;

  if (!from || !to) {
    throw new WarplineError('Usage: warpline rename <old-name> <new-name>');
  }

  const project = await resolveProjectLoosely(from);
  const info = inspectRuntime(project.name);
  if (info && info.live.length > 0) {
    throw new WarplineError(`"${project.name}" is running; stop it before renaming`, {
      hint: `warpline down ${project.name}`,
    });
  }

  await renameProject(project.name, to.trim());
  clearRuntime(project.name);
  out.success(`renamed ${theme.dim(project.name)} ${glyph.arrow} ${theme.bold(theme.accent(to.trim()))}`);
  return 0;
}

export const noteFlags: FlagSpecs = {
  clear: { type: 'boolean', alias: 'c', describe: 'Remove the note' },
};

export function noteHelp(): string {
  return [
    `${theme.bold('warpline note')} ${theme.dim('[name] ["text"] [options]')}`,
    '',
    'Attaches a reminder to a project, shown every time it starts. Stored in',
    'warpline.yml, so it is shared with everyone who clones the repo.',
    '',
    'With no text, prints the current note.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(noteFlags),
    '',
    theme.dim('Examples:'),
    `  ${theme.code('warpline note "run pnpm db:migrate after pulling"')}`,
    `  ${theme.code('warpline note myapp --clear')}`,
  ].join('\n');
}

export async function runNote(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, noteFlags);

  // Disambiguate `warpline note <name> <text>` from `warpline note <text>`: a first
  // positional only counts as a project name if it actually resolves to one.
  let nameArg: string | undefined;
  let textParts = [...parsed.positionals];
  const first = parsed.positionals[0];
  if (first && getProject(first)) {
    nameArg = first;
    textParts = parsed.positionals.slice(1);
  }

  const project = await resolveProject(nameArg);
  const text = textParts.join(' ').trim();
  const clear = flagBool(parsed, 'clear');

  if (!clear && text.length === 0) {
    if (project.config.note) {
      out.write(project.config.note);
    } else {
      out.note(`no note set for ${theme.bold(project.name)}`);
    }
    return 0;
  }

  updateConfigDocument(project.config.configFile, (doc) => {
    if (clear) doc.delete('note');
    else doc.set('note', text);
  });

  if (clear) out.success(`cleared the note on ${theme.bold(project.name)}`);
  else out.success(`note saved on ${theme.bold(project.name)}`);

  return 0;
}

export const prunedFlags: FlagSpecs = {
  yes: { type: 'boolean', alias: 'y', describe: 'Skip the confirmation prompt' },
};

export function pruneHelp(): string {
  return [
    `${theme.bold('warpline prune')} ${theme.dim('[options]')}`,
    '',
    'Removes index entries whose folder or warpline.yml no longer exists, and clears',
    'stale runtime state left behind by reboots.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(prunedFlags),
  ].join('\n');
}

export async function runPrune(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, prunedFlags);
  const projects = listProjects();

  const broken = projects.filter((entry) => !configExistsIn(entry.root));
  const staleState: string[] = [];

  const { listRuntimeNames } = await import('../state/runtime.js');
  for (const name of listRuntimeNames()) {
    const info = inspectRuntime(name);
    if (!info || info.live.length === 0) staleState.push(name);
  }

  if (broken.length === 0 && staleState.length === 0) {
    out.success('nothing to prune');
    return 0;
  }

  if (broken.length > 0) {
    out.write(theme.bold('Index entries with no warpline.yml:'));
    for (const entry of broken) {
      out.write(`  ${theme.dim(glyph.dot)} ${entry.name} ${theme.dim(tildify(entry.root))}`);
    }
  }
  if (staleState.length > 0) {
    out.write(theme.bold('Stale runtime state:'));
    for (const name of staleState) out.write(`  ${theme.dim(glyph.dot)} ${name}`);
  }

  if (!flagBool(parsed, 'yes') && isInteractive()) {
    out.blank();
    const confirmed = await promptConfirm('Remove these?', true);
    if (!confirmed) {
      out.note('Cancelled');
      return 0;
    }
  }

  for (const entry of broken) await removeProject(entry.name);
  for (const name of staleState) clearRuntime(name);

  out.success(`pruned ${broken.length} index entr${broken.length === 1 ? 'y' : 'ies'} and ${staleState.length} state file${staleState.length === 1 ? '' : 's'}`);
  return 0;
}


