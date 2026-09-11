import { describe, expect, it } from 'vitest';
import { parseDotenv, expandValue } from '../../src/env/dotenv.js';

/** Builds a lookup over a plain object, matching how resolveEnv supplies one. */
function lookupFrom(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => values[name];
}

describe('parseDotenv', () => {
  it('parses a plain assignment', () => {
    const { map, entries } = parseDotenv('FOO=bar\n');
    expect(map).toEqual({ FOO: 'bar' });
    expect(entries).toEqual([{ key: 'FOO', value: 'bar', line: 1 }]);
  });

  it('strips an export prefix', () => {
    expect(parseDotenv('export FOO=bar').map).toEqual({ FOO: 'bar' });
  });

  it('accepts the colon-equals form', () => {
    expect(parseDotenv('FOO:=bar').map).toEqual({ FOO: 'bar' });
  });

  it('tolerates whitespace around the separator', () => {
    expect(parseDotenv('  FOO   =   bar').map).toEqual({ FOO: 'bar' });
  });

  it('reads an empty value as an empty string', () => {
    expect(parseDotenv('FOO=').map).toEqual({ FOO: '' });
  });

  it('reports line numbers from the original file, not the parsed entries', () => {
    const text = ['# a comment', '', 'FIRST=1', '', '# another', 'SECOND=2'].join('\n');
    expect(parseDotenv(text).entries).toEqual([
      { key: 'FIRST', value: '1', line: 3 },
      { key: 'SECOND', value: '2', line: 6 },
    ]);
  });

  it('skips lines that are not assignments', () => {
    const text = ['this is prose', '1INVALID=x', 'FOO:bar', 'GOOD=yes'].join('\n');
    expect(parseDotenv(text).map).toEqual({ GOOD: 'yes' });
  });

  it('lets a later duplicate win in the map while keeping both entries', () => {
    const { map, entries } = parseDotenv('FOO=first\nFOO=second');
    expect(map).toEqual({ FOO: 'second' });
    expect(entries.map((entry) => entry.value)).toEqual(['first', 'second']);
  });

  it('strips a BOM before the first key', () => {
    expect(parseDotenv('\uFEFFFOO=bar').map).toEqual({ FOO: 'bar' });
  });

  it('handles CRLF line endings', () => {
    expect(parseDotenv('FOO=bar\r\nBAZ=qux\r\n').map).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  describe('inline comments', () => {
    it('strips a comment preceded by whitespace', () => {
      expect(parseDotenv('FOO=bar # trailing note').map).toEqual({ FOO: 'bar' });
    });

    it('keeps a hash that is part of the value', () => {
      expect(parseDotenv('PASSWORD=pa#ss').map).toEqual({ PASSWORD: 'pa#ss' });
    });

    it('treats a value that starts with a hash as empty', () => {
      expect(parseDotenv('FOO=#not-a-value').map).toEqual({ FOO: '' });
    });
  });

  describe('quoting', () => {
    it('processes escapes inside double quotes', () => {
      expect(parseDotenv('FOO="a\\nb\\tc"').map).toEqual({ FOO: 'a\nb\tc' });
    });

    it('leaves escapes literal inside single quotes', () => {
      expect(parseDotenv("FOO='a\\nb'").map).toEqual({ FOO: 'a\\nb' });
    });

    it('supports backtick quoting without escape processing', () => {
      expect(parseDotenv('FOO=`a\\nb`').map).toEqual({ FOO: 'a\\nb' });
    });

    it('unescapes an embedded double quote', () => {
      expect(parseDotenv('FOO="say \\"hi\\""').map).toEqual({ FOO: 'say "hi"' });
    });

    it('discards anything after the closing quote', () => {
      expect(parseDotenv('FOO="bar" # trailing note').map).toEqual({ FOO: 'bar' });
    });

    it('keeps a hash inside quotes', () => {
      expect(parseDotenv('FOO="pa#ss"').map).toEqual({ FOO: 'pa#ss' });
    });

    it('reads a value spanning several lines', () => {
      const text = ['KEY="line one', 'line two', 'line three"', 'AFTER=yes'].join('\n');
      const { map } = parseDotenv(text);
      expect(map.KEY).toBe('line one\nline two\nline three');
      expect(map.AFTER).toBe('yes');
    });

    it('attributes a multi-line value to the line its key is on', () => {
      const text = ['KEY="one', 'two"'].join('\n');
      expect(parseDotenv(text).entries[0]?.line).toBe(1);
    });

    it('does not leave a trailing newline on an unterminated value', () => {
      expect(parseDotenv('KEY="never closed').map).toEqual({ KEY: 'never closed' });
    });
  });
});

describe('expandValue', () => {
  it('returns a value with no reference untouched', () => {
    expect(expandValue('plain text', lookupFrom({}))).toBe('plain text');
  });

  it('expands a braced reference', () => {
    expect(expandValue('${HOST}:5432', lookupFrom({ HOST: 'localhost' }))).toBe('localhost:5432');
  });

  it('expands a bare reference', () => {
    expect(expandValue('$HOST/db', lookupFrom({ HOST: 'localhost' }))).toBe('localhost/db');
  });

  it('expands several references in one value', () => {
    const lookup = lookupFrom({ HOST: 'localhost', PORT: '5432' });
    expect(expandValue('postgres://${HOST}:${PORT}/app', lookup)).toBe('postgres://localhost:5432/app');
  });

  it('uses the :- default when the name is unset', () => {
    expect(expandValue('${PORT:-3000}', lookupFrom({}))).toBe('3000');
  });

  it('uses the bare - default when the name is unset', () => {
    expect(expandValue('${PORT-3000}', lookupFrom({}))).toBe('3000');
  });

  it('falls back to the default when the name is set but empty', () => {
    expect(expandValue('${PORT:-3000}', lookupFrom({ PORT: '' }))).toBe('3000');
  });

  it('prefers a set value over the default', () => {
    expect(expandValue('${PORT:-3000}', lookupFrom({ PORT: '4000' }))).toBe('4000');
  });

  it('leaves an unknown reference in place rather than emptying it', () => {
    expect(expandValue('${NOPE}', lookupFrom({}))).toBe('${NOPE}');
    expect(expandValue('$NOPE', lookupFrom({}))).toBe('$NOPE');
  });

  it('expands a reference held inside another value', () => {
    const lookup = lookupFrom({ OUTER: '${INNER}', INNER: 'resolved' });
    expect(expandValue('$OUTER', lookup)).toBe('resolved');
  });

  it('terminates on a circular reference instead of hanging', () => {
    const lookup = lookupFrom({ A: '$B', B: '$A' });
    // The exact residue does not matter; not hanging and not throwing does.
    expect(() => expandValue('$A', lookup)).not.toThrow();
    expect(expandValue('$A', lookup)).toContain('$');
  });

  it('treats a backslash-dollar as a literal dollar', () => {
    expect(expandValue('\\$NOT_A_REF', lookupFrom({ NOT_A_REF: 'oops' }))).toBe('$NOT_A_REF');
  });

  it('keeps an escaped dollar literal even when the same value expands something else', () => {
    const lookup = lookupFrom({ LITERAL: 'oops', REAL: 'yes' });
    expect(expandValue('\\$LITERAL and ${REAL}', lookup)).toBe('$LITERAL and yes');
  });
});
