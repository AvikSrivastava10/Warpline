import { describe, expect, it } from 'vitest';
import { buildShellCommand, quoteForShell, runToCompletion } from '../../src/proc/spawn.js';

const isWindows = process.platform === 'win32';

/**
 * Quoting is inherently platform-specific, so most assertions here are about the
 * invariant rather than the exact escape syntax. The round trip at the bottom is
 * what actually proves it: it runs a real process and inspects the argv it got.
 */
describe('quoteForShell', () => {
  it('leaves an ordinary token alone', () => {
    expect(quoteForShell('npm')).toBe('npm');
    expect(quoteForShell('run')).toBe('run');
    expect(quoteForShell('--silent')).toBe('--silent');
  });

  it('quotes a token containing a space', () => {
    const quoted = quoteForShell('my script');
    expect(quoted).not.toBe('my script');
    expect(quoted.length).toBeGreaterThan('my script'.length);
  });

  it('quotes an empty token so it survives as an argument', () => {
    expect(quoteForShell('').length).toBeGreaterThan(0);
  });

  it('quotes shell metacharacters instead of letting them through bare', () => {
    for (const token of ['a&b', 'a|b', 'a>b', 'a<b', 'a;b']) {
      expect(quoteForShell(token)).not.toBe(token);
    }
  });

  it('handles the platform quote character appearing in the value', () => {
    const token = isWindows ? 'say "hi"' : "it's";
    expect(() => quoteForShell(token)).not.toThrow();
    expect(quoteForShell(token)).not.toBe(token);
  });
});

describe('buildShellCommand', () => {
  it('joins simple arguments with spaces', () => {
    expect(buildShellCommand(['npm', 'run', 'dev'])).toBe('npm run dev');
  });

  it('returns an empty string for no arguments', () => {
    expect(buildShellCommand([])).toBe('');
  });

  it('keeps an argument with a space as one unit', () => {
    const command = buildShellCommand(['npm', 'run', 'my script']);
    // The bug this replaced produced exactly `npm run my script`.
    expect(command).not.toBe('npm run my script');
    expect(command.startsWith('npm run ')).toBe(true);
  });
});

describe('argv survives the round trip through a real shell', () => {
  it('delivers each argument to the child exactly as given', async () => {
    // The only assertion that genuinely proves the quoting: a real process
    // reports the argv it received.
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const args = ['plain', 'with space', 'sym&bol'];

    const command = buildShellCommand([process.execPath, '-e', script, ...args]);
    const result = await runToCompletion({
      command,
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 30_000,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.output.trim())).toEqual(args);
  }, 40_000);
});
