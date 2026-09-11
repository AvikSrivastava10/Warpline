import { flagBool, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { out, theme } from '../core/ui.js';
import { tildify } from '../core/paths.js';
import { touchProject } from '../state/registry.js';
import { resolveProjectLoosely } from './context.js';

export const cdFlags: FlagSpecs = {
  quiet: { type: 'boolean', alias: 'q', describe: 'Do not print the shell-integration hint' },
};

export function cdHelp(): string {
  return [
    `${theme.bold('warpline cd')} ${theme.dim('<name>')}`,
    '',
    'Prints a project\'s root directory on stdout.',
    '',
    'A child process cannot change its parent shell\'s working directory, so this',
    'command is designed to be wrapped by a shell function. Install it once with:',
    '',
    `  ${theme.code('warpline shell-init')}`,
    '',
    'After that, `warpline cd myproject` changes directory for real. Without the',
    'integration you can still use it directly:',
    '',
    `  ${theme.code('cd "$(warpline cd myproject)"')}`,
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(cdFlags),
  ].join('\n');
}

/**
 * Emits the project root and nothing else on stdout, so the shell wrapper can
 * consume it directly. All human-facing text goes to stderr.
 */
export async function runCd(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, cdFlags);
  const project = await resolveProjectLoosely(parsed.positionals[0]);

  if (!project.root) {
    out.error(`Could not determine a directory for "${project.name}"`);
    return 1;
  }

  out.write(project.root);
  await touchProject(project.name);

  // WARPLINE_SHELL_INTEGRATION is exported by the generated shell function, so its
  // absence is a reliable signal that the user is calling this raw.
  if (!flagBool(parsed, 'quiet') && !process.env.WARPLINE_SHELL_INTEGRATION && process.stderr.isTTY) {
    out.note(`(this only prints the path; run \`warpline shell-init\` to make \`warpline cd\` actually change directory)`);
    out.note(tildify(project.root));
  }

  return 0;
}
