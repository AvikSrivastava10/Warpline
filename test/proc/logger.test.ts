import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLogTail } from '../../src/proc/logger.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warpline-logger-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeLog(name: string, contents: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

describe('readLogTail', () => {
  it('returns an empty list for a file that does not exist', () => {
    expect(readLogTail(path.join(dir, 'missing.log'), 10)).toEqual([]);
  });

  it('returns an empty list for an empty file', () => {
    expect(readLogTail(writeLog('empty.log', ''), 10)).toEqual([]);
  });

  it('returns every line when the file is shorter than requested', () => {
    expect(readLogTail(writeLog('short.log', 'one\ntwo\nthree\n'), 10)).toEqual(['one', 'two', 'three']);
  });

  it('returns only the last lines when the file is longer', () => {
    const contents = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\n';
    expect(readLogTail(writeLog('long.log', contents), 3)).toEqual(['line 47', 'line 48', 'line 49']);
  });

  it('does not emit a trailing empty line for a file ending in a newline', () => {
    expect(readLogTail(writeLog('trailing.log', 'a\nb\n'), 10)).toEqual(['a', 'b']);
  });

  it('keeps a final line that has no trailing newline', () => {
    expect(readLogTail(writeLog('nonewline.log', 'a\nb'), 10)).toEqual(['a', 'b']);
  });

  it('handles CRLF endings', () => {
    expect(readLogTail(writeLog('crlf.log', 'a\r\nb\r\n'), 10)).toEqual(['a', 'b']);
  });

  it('preserves multi-byte characters that straddle an internal chunk boundary', () => {
    // readLogTail walks backwards in 64KiB chunks. The arithmetic below puts a
    // character across one of those boundaries on purpose:
    //
    //   size          = 1 + (2 * 40000) + 1 = 80002 bytes, so two chunks are read
    //   first split   = 80002 - 65536      = 14466
    //   offset into the two-byte run = 14466 - 1 = 14465, which is odd
    //
    // An odd offset into a run of two-byte characters is necessarily mid-character.
    // Decoding each chunk separately turned that into replacement characters.
    const line = 'a' + 'é'.repeat(40_000);
    const file = writeLog('unicode.log', line + '\n');

    expect(fs.statSync(file).size).toBe(80_002);

    const tail = readLogTail(file, 5);
    expect(tail).toEqual([line]);
    expect(tail.join('')).not.toContain('\uFFFD');
  });
});
