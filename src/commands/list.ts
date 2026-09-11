import { flagBool, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { formatRelative, glyph, out, renderTable, theme, truncate } from '../core/ui.js';
import { tildify } from '../core/paths.js';
import { configExistsIn } from '../config/load.js';
import { listProjects } from '../state/registry.js';
import { inspectRuntime } from '../state/runtime.js';

export const listFlags: FlagSpecs = {
  json: { type: 'boolean', describe: 'Emit machine-readable JSON on stdout' },
  paths: { type: 'boolean', alias: 'p', describe: 'Print only project roots, one per line' },
  names: { type: 'boolean', alias: 'n', describe: 'Print only project names, one per line (for scripts and completions)' },
};

export function listHelp(): string {
  return [
    `${theme.bold('warpline list')} ${theme.dim('[options]')}`,
    '',
    'Lists saved projects, most recently used first, with a marker for the ones',
    'currently running.',
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(listFlags),
  ].join('\n');
}

export async function runList(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, listFlags);
  const projects = listProjects();

  // Bare name/path output goes to stdout unadorned so it pipes cleanly into
  // shell completions, fzf, and scripts.
  if (flagBool(parsed, 'names')) {
    for (const entry of projects) out.write(entry.name);
    return 0;
  }
  if (flagBool(parsed, 'paths')) {
    for (const entry of projects) out.write(entry.root);
    return 0;
  }

  if (flagBool(parsed, 'json')) {
    out.write(
      JSON.stringify(
        projects.map((entry) => {
          const info = inspectRuntime(entry.name);
          return {
            name: entry.name,
            root: entry.root,
            running: Boolean(info && info.live.length > 0),
            configPresent: Boolean(configExistsIn(entry.root)),
            lastUsedAt: entry.lastUsedAt ?? null,
            useCount: entry.useCount,
          };
        }),
        null,
        2,
      ),
    );
    return 0;
  }

  if (projects.length === 0) {
    out.note('No saved projects yet.');
    out.blank();
    out.note(`Run ${theme.code('warpline init')} inside a project to save it.`);
    return 0;
  }

  const rows = projects.map((entry) => {
    const info = inspectRuntime(entry.name);
    const running = Boolean(info && info.live.length > 0);
    const configMissing = !configExistsIn(entry.root);

    const marker = running ? theme.ok(glyph.running) : theme.dim(glyph.stopped);
    const processCount = info ? Object.keys(info.state.processes).length : 0;

    const state = running
      ? theme.ok(`${info?.live.length ?? 0}/${processCount} up`)
      : configMissing
        ? theme.err('config missing')
        : theme.dim('stopped');

    return [
      `${marker} ${theme.bold(entry.name)}`,
      state,
      theme.dim(truncate(tildify(entry.root), 46)),
      theme.dim(formatRelative(entry.lastUsedAt)),
    ];
  });

  out.write(
    renderTable(
      [{ header: 'project' }, { header: 'state' }, { header: 'path' }, { header: 'last used' }],
      rows,
    ),
  );

  const broken = projects.filter((entry) => !configExistsIn(entry.root));
  if (broken.length > 0) {
    out.blank();
    out.warn(
      `${broken.length} project${broken.length === 1 ? '' : 's'} point at a folder with no warpline.yml: ${broken
        .map((entry) => entry.name)
        .join(', ')}`,
    );
    out.note(`Fix with ${theme.code('warpline link <name>')} from the new location, or ${theme.code('warpline remove <name>')}.`);
  }

  return 0;
}
