import { describe, expect, it } from 'vitest';
import { wantsHelp } from '../src/cli.js';

describe('wantsHelp', () => {
  it('is false with no arguments', () => {
    expect(wantsHelp([])).toBe(false);
  });

  it('recognises a help request', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['-h'])).toBe(true);
  });

  it('recognises it after a project name or other flags', () => {
    expect(wantsHelp(['myapp', '--help'])).toBe(true);
    expect(wantsHelp(['--detach', '-h'])).toBe(true);
  });

  it('ignores ordinary arguments', () => {
    expect(wantsHelp(['myapp', '--detach', '--only', 'web'])).toBe(false);
  });

  describe('the passthrough boundary', () => {
    it('does not claim a child process’s --help', () => {
      // `warpline exec -- npm --help` has to run npm's help. Before the boundary
      // existed, warpline printed its own and never ran anything, so no flag named
      // --help or -h could be passed through to any child at all.
      expect(wantsHelp(['--', 'npm', '--help'])).toBe(false);
      expect(wantsHelp(['--', 'node', '-h'])).toBe(false);
    });

    it('still honours a help request made before the boundary', () => {
      expect(wantsHelp(['--help', '--', 'npm', 'run', 'dev'])).toBe(true);
      expect(wantsHelp(['-h', '--'])).toBe(true);
    });

    it('treats only a bare -- as the boundary', () => {
      // `--help` itself starts with dashes but is not the separator.
      expect(wantsHelp(['--only', 'web', '--help'])).toBe(true);
    });

    it('stops at the first boundary, not the last', () => {
      expect(wantsHelp(['--', 'sh', '-c', '--', '--help'])).toBe(false);
    });
  });
});
