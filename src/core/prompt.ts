import readline from 'node:readline';
import { theme, glyph, isInteractive } from './ui.js';

// Re-exported so callers can import prompting and its precondition together.
export { isInteractive } from './ui.js';

/**
 * Prompts read from stdin and write to stderr, keeping stdout clean for
 * piped output. Every prompt takes a default so non-interactive runs
 * (CI, `--yes`) can proceed without blocking.
 */
async function ask(question: string, fallback: string): Promise<string> {
  if (!isInteractive()) return fallback;

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function promptText(label: string, defaultValue = ''): Promise<string> {
  const suffix = defaultValue ? theme.dim(` (${defaultValue})`) : '';
  const answer = await ask(`${theme.info('?')} ${label}${suffix}: `, '');
  return answer.length > 0 ? answer : defaultValue;
}

export async function promptConfirm(label: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await ask(`${theme.info('?')} ${label} ${theme.dim(`(${hint})`)} `, '')).toLowerCase();
  if (answer.length === 0) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

/**
 * Numbered single-select. A numbered list beats arrow-key navigation here
 * because it works identically in every terminal, including Windows consoles
 * and non-TTY-ish environments, with no raw-mode handling.
 */
export async function promptSelect<T>(label: string, choices: Choice<T>[], defaultIndex = 0): Promise<T> {
  const first = choices[0];
  if (choices.length === 0) throw new Error('promptSelect requires at least one choice');
  if (choices.length === 1 || !isInteractive()) {
    const fallback = choices[defaultIndex] ?? first;
    return (fallback as Choice<T>).value;
  }

  process.stderr.write(`${theme.info('?')} ${label}\n`);
  choices.forEach((choice, i) => {
    const marker = i === defaultIndex ? theme.info(glyph.dot) : ' ';
    const hint = choice.hint ? theme.dim(`  ${choice.hint}`) : '';
    process.stderr.write(`  ${marker} ${theme.bold(String(i + 1))}. ${choice.label}${hint}\n`);
  });

  const answer = await ask(theme.dim(`  choose 1-${choices.length} (${defaultIndex + 1}): `), '');
  const index = Number.parseInt(answer, 10);
  if (Number.isFinite(index) && index >= 1 && index <= choices.length) {
    return (choices[index - 1] as Choice<T>).value;
  }
  return (choices[defaultIndex] ?? (first as Choice<T>)).value;
}

/** Numbered multi-select. Blank input keeps the pre-selected defaults. */
export async function promptMultiSelect<T>(
  label: string,
  choices: Choice<T>[],
  defaultSelected: number[] = [],
): Promise<T[]> {
  if (choices.length === 0) return [];
  const preselected = new Set(defaultSelected);

  if (!isInteractive()) {
    return choices.filter((_, i) => preselected.has(i)).map((c) => c.value);
  }

  process.stderr.write(`${theme.info('?')} ${label} ${theme.dim('(comma-separated numbers, blank = keep marked)')}\n`);
  choices.forEach((choice, i) => {
    const marker = preselected.has(i) ? theme.ok(glyph.ok) : theme.dim(glyph.stopped);
    const hint = choice.hint ? theme.dim(`  ${choice.hint}`) : '';
    process.stderr.write(`  ${marker} ${theme.bold(String(i + 1))}. ${choice.label}${hint}\n`);
  });

  const answer = await ask(theme.dim('  select: '), '');
  if (answer.trim().length === 0) {
    return choices.filter((_, i) => preselected.has(i)).map((c) => c.value);
  }

  const picked = new Set<number>();
  for (const part of answer.split(',')) {
    const index = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(index) && index >= 1 && index <= choices.length) picked.add(index - 1);
  }
  return choices.filter((_, i) => picked.has(i)).map((c) => c.value);
}
