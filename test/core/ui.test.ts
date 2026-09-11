import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  colorForIndex,
  displayWidth,
  formatDuration,
  formatRelative,
  glyph,
  padEndVisible,
  padStartVisible,
  renderTable,
  stripAnsi,
  truncate,
} from '../../src/core/ui.js';

/**
 * The suite runs with NO_COLOR=1 and WARPLINE_ASCII=1 (see vitest.config.ts), so
 * the theme helpers are pass-through and glyphs are in their ASCII fallback form.
 * That is what makes exact string assertions possible here.
 */
const RED = '\u001B[31m';
const RESET = '\u001B[39m';
const COLOURED = `${RED}red${RESET}`;

describe('formatDuration', () => {
  it('rejects a value that is not a usable duration', () => {
    expect(formatDuration(-1)).toBe('-');
    expect(formatDuration(Number.NaN)).toBe('-');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('-');
  });

  it('uses milliseconds below one second', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(740)).toBe('740ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('uses whole seconds below one minute', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('pads the seconds once minutes are involved', () => {
    expect(formatDuration(60_000)).toBe('1m 00s');
    expect(formatDuration(134_000)).toBe('2m 14s');
  });

  it('drops to hours and minutes past an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h 00m');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });

  it('drops to days and hours past a day', () => {
    expect(formatDuration(86_400_000)).toBe('1d 00h');
    expect(formatDuration(90_000_000)).toBe('1d 01h');
  });
});

describe('formatRelative', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a missing timestamp as never', () => {
    expect(formatRelative(undefined)).toBe('never');
    expect(formatRelative(0)).toBe('never');
  });

  it('collapses anything recent into "just now"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const now = Date.now();
    expect(formatRelative(now)).toBe('just now');
    expect(formatRelative(now - 44_000)).toBe('just now');
  });

  it('formats anything older as a duration ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    expect(formatRelative(Date.now() - 120_000)).toBe('2m 00s ago');
    expect(formatRelative(Date.now() - 7_200_000)).toBe('2h 00m ago');
  });
});

describe('stripAnsi and displayWidth', () => {
  it('removes colour escapes', () => {
    expect(stripAnsi(COLOURED)).toBe('red');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('plain')).toBe('plain');
  });

  it('measures the visible width, not the byte length', () => {
    expect(COLOURED.length).toBeGreaterThan(3);
    expect(displayWidth(COLOURED)).toBe(3);
  });
});

describe('padEndVisible and padStartVisible', () => {
  it('pads based on visible width so colour does not break alignment', () => {
    expect(padEndVisible(COLOURED, 5)).toBe(`${COLOURED}  `);
    expect(padStartVisible(COLOURED, 5)).toBe(`  ${COLOURED}`);
  });

  it('pads plain text', () => {
    expect(padEndVisible('ab', 4)).toBe('ab  ');
    expect(padStartVisible('ab', 4)).toBe('  ab');
  });

  it('never truncates text that is already wide enough', () => {
    expect(padEndVisible('abcdef', 3)).toBe('abcdef');
    expect(padStartVisible('abcdef', 3)).toBe('abcdef');
  });
});

describe('truncate', () => {
  it('leaves text that fits', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('shortens and marks the cut with the ASCII fallback', () => {
    expect(truncate('abcdef', 3)).toBe('ab~');
  });

  it('gives up on marking the cut when there is no room for a marker', () => {
    expect(truncate('abcdef', 1)).toBe('a');
    expect(truncate('abcdef', 0)).toBe('');
  });
});

describe('glyph', () => {
  it('falls back to ASCII when WARPLINE_ASCII is set', () => {
    expect(glyph.ok).toBe('OK');
    expect(glyph.fail).toBe('XX');
    expect(glyph.arrow).toBe('->');
    expect(glyph.sep).toBe('|');
  });

  it('offers a spinner frame set', () => {
    expect(glyph.spinner.length).toBeGreaterThan(0);
  });
});

describe('colorForIndex', () => {
  it('returns a usable function for any index', () => {
    expect(typeof colorForIndex(0)).toBe('function');
    expect(colorForIndex(0)('label')).toBe('label');
  });

  it('wraps around rather than running off the end of the palette', () => {
    expect(() => colorForIndex(999)('label')).not.toThrow();
    expect(colorForIndex(999)('label')).toBe('label');
  });
});

describe('renderTable', () => {
  it('uppercases the headers', () => {
    const table = renderTable([{ header: 'process' }, { header: 'status' }], [['web', 'ready']]);
    expect(table.split('\n')[0]).toContain('PROCESS');
    expect(table.split('\n')[0]).toContain('STATUS');
  });

  it('emits one line per row plus a header', () => {
    const table = renderTable([{ header: 'a' }], [['x'], ['y'], ['z']]);
    expect(table.split('\n')).toHaveLength(4);
  });

  it('sizes each column to its widest cell and honours right alignment', () => {
    const table = renderTable(
      [{ header: 'a' }, { header: 'b', align: 'right' }],
      [
        ['x', 'yy'],
        ['zzz', 'w'],
      ],
    );
    expect(table.split('\n')).toEqual([
      `A${' '.repeat(5)}B`,
      `x${' '.repeat(4)}yy`,
      `zzz${' '.repeat(3)}w`,
    ]);
  });

  it('trims trailing whitespace so lines do not carry padding', () => {
    const table = renderTable([{ header: 'a' }, { header: 'b' }], [['xxx', '']]);
    expect(table.split('\n')[1]).toBe('xxx');
  });

  it('treats a missing cell as empty rather than failing', () => {
    const table = renderTable([{ header: 'a' }, { header: 'b' }], [['only']]);
    expect(table.split('\n')[1]).toBe('only');
  });

  it('renders just the header when there are no rows', () => {
    expect(renderTable([{ header: 'a' }, { header: 'b' }], [])).toBe('A  B');
  });

  it('aligns columns by visible width when cells are coloured', () => {
    const table = renderTable([{ header: 'a' }, { header: 'b' }], [[COLOURED, 'x'], ['ab', 'y']]);
    const lines = table.split('\n');
    // Both data rows must put the second column at the same visible offset.
    expect(displayWidth(lines[1] ?? '') - 1).toBe(displayWidth(lines[2] ?? '') - 1);
  });
});
