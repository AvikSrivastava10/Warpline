import pc from 'picocolors';

/** Palette used for per-process log prefixes; ordered for adjacent contrast. */
const PREFIX_COLORS = [
  pc.cyan,
  pc.magenta,
  pc.yellow,
  pc.green,
  pc.blue,
  pc.red,
  (s: string) => pc.bold(pc.cyan(s)),
  (s: string) => pc.bold(pc.magenta(s)),
  (s: string) => pc.bold(pc.yellow(s)),
  (s: string) => pc.bold(pc.green(s)),
] as const;

export function colorForIndex(index: number): (s: string) => string {
  const fn = PREFIX_COLORS[index % PREFIX_COLORS.length];
  return fn ?? ((s: string) => s);
}

export const theme = {
  dim: (s: string) => pc.dim(s),
  bold: (s: string) => pc.bold(s),
  ok: (s: string) => pc.green(s),
  warn: (s: string) => pc.yellow(s),
  err: (s: string) => pc.red(s),
  info: (s: string) => pc.cyan(s),
  accent: (s: string) => pc.magenta(s),
  code: (s: string) => pc.cyan(s),
};

/**
 * Status glyphs degrade to ASCII when the terminal is unlikely to render
 * Unicode (notably Windows consoles still using a legacy code page).
 */
const unicodeOk = (() => {
  if (process.env.WARPLINE_ASCII === '1') return false;
  if (process.platform !== 'win32') return true;
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.WSLENV);
})();

export const glyph = {
  ok: unicodeOk ? '✔' : 'OK',
  fail: unicodeOk ? '✖' : 'XX',
  warn: unicodeOk ? '▲' : '!!',
  dot: unicodeOk ? '•' : '*',
  arrow: unicodeOk ? '→' : '->',
  sep: unicodeOk ? '·' : '|',
  running: unicodeOk ? '●' : '>',
  stopped: unicodeOk ? '○' : '.',
  spinner: unicodeOk ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'],
};

export const out = {
  /** Human-facing output. Goes to stdout. */
  write(line: string): void {
    process.stdout.write(line + '\n');
  },
  blank(): void {
    process.stdout.write('\n');
  },
  /**
   * Diagnostics go to stderr so `warpline cd`, `warpline exec --print-env`, and
   * friends stay pipe-safe: stdout carries only machine-consumable payload.
   */
  note(line: string): void {
    process.stderr.write(theme.dim(line) + '\n');
  },
  step(line: string): void {
    process.stderr.write(`${theme.dim(glyph.arrow)} ${line}\n`);
  },
  success(line: string): void {
    process.stderr.write(`${theme.ok(glyph.ok)} ${line}\n`);
  },
  warn(line: string): void {
    process.stderr.write(`${theme.warn(glyph.warn)} ${line}\n`);
  },
  error(line: string): void {
    process.stderr.write(`${theme.err(glyph.fail)} ${line}\n`);
  },
};

/** Visible width, ignoring ANSI escapes so alignment survives coloring. */
export function displayWidth(text: string): number {
  return stripAnsi(text).length;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

export function padEndVisible(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

export function padStartVisible(text: string, width: number): string {
  const diff = width - displayWidth(text);
  return diff > 0 ? ' '.repeat(diff) + text : text;
}

export interface Column {
  header: string;
  align?: 'left' | 'right';
}

/** Minimal fixed-width table. Enough for `list`/`status`, no dep required. */
export function renderTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) => {
    const cellWidths = rows.map((row) => displayWidth(row[i] ?? ''));
    return Math.max(displayWidth(col.header), ...(cellWidths.length > 0 ? cellWidths : [0]));
  });

  const lines: string[] = [];
  lines.push(
    columns
      .map((col, i) => {
        const w = widths[i] ?? 0;
        const header = theme.dim(col.header.toUpperCase());
        return col.align === 'right' ? padStartVisible(header, w) : padEndVisible(header, w);
      })
      .join('  ')
      .trimEnd(),
  );

  for (const row of rows) {
    lines.push(
      columns
        .map((col, i) => {
          const w = widths[i] ?? 0;
          const cell = row[i] ?? '';
          return col.align === 'right' ? padStartVisible(cell, w) : padEndVisible(cell, w);
        })
        .join('  ')
        .trimEnd(),
    );
  }

  return lines.join('\n');
}

/** `2m 14s`, `3h 02m`, `740ms` - short enough for a table cell. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);

  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (totalHours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (totalMinutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function formatRelative(timestamp: number | undefined): string {
  if (!timestamp) return 'never';
  const delta = Date.now() - timestamp;
  if (delta < 45_000) return 'just now';
  return `${formatDuration(delta)} ago`;
}

/** Truncate with an ellipsis, respecting a minimum useful width. */
export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  if (displayWidth(text) <= max) return text;
  return text.slice(0, max - 1) + (unicodeOk ? '…' : '~');
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY) && process.env.CI !== 'true';
}
