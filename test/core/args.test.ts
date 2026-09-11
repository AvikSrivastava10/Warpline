import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  flagBool,
  flagList,
  flagNumber,
  flagString,
  renderFlagHelp,
  type FlagSpecs,
} from '../../src/core/args.js';
import { captureWarplineError } from '../helpers/errors.js';

const specs: FlagSpecs = {
  detach: { type: 'boolean', alias: 'd', describe: 'Run in the background' },
  force: { type: 'boolean', alias: 'f', describe: 'Start anyway' },
  prefix: { type: 'boolean', default: true, describe: 'Prefix log lines' },
  name: { type: 'string', alias: 'n', describe: 'Project name' },
  lines: { type: 'number', alias: 'l', describe: 'How many lines' },
  only: { type: 'list', alias: 'o', describe: 'Limit to these processes' },
  format: { type: 'string', choices: ['table', 'json'], default: 'table', describe: 'Output format' },
  undocumented: { type: 'boolean' },
};

describe('parseArgs', () => {
  it('collects positionals in order', () => {
    const parsed = parseArgs(['myapp', 'api'], specs);
    expect(parsed.positionals).toEqual(['myapp', 'api']);
  });

  it('applies declared defaults when a flag is absent', () => {
    const parsed = parseArgs([], specs);
    expect(parsed.flags).toMatchObject({ prefix: true, format: 'table' });
  });

  it('defaults a boolean without an explicit default to false', () => {
    expect(flagBool(parseArgs([], specs), 'detach')).toBe(false);
  });

  it('defaults a list without an explicit default to empty', () => {
    expect(flagList(parseArgs([], specs), 'only')).toEqual([]);
  });

  it('leaves a valueless string flag undefined', () => {
    expect(flagString(parseArgs([], specs), 'name')).toBeUndefined();
  });

  describe('booleans', () => {
    it('sets a bare long flag', () => {
      expect(flagBool(parseArgs(['--detach'], specs), 'detach')).toBe(true);
    });

    it('turns a defaulted-true flag off with --no-', () => {
      expect(flagBool(parseArgs(['--no-prefix'], specs), 'prefix')).toBe(false);
    });

    it('accepts an explicit false value', () => {
      expect(flagBool(parseArgs(['--prefix=false'], specs), 'prefix')).toBe(false);
      expect(flagBool(parseArgs(['--prefix=0'], specs), 'prefix')).toBe(false);
    });

    it('treats any other explicit value as true', () => {
      expect(flagBool(parseArgs(['--detach=yes'], specs), 'detach')).toBe(true);
    });

    it('rejects --no- against a non-boolean flag', () => {
      expect(() => parseArgs(['--no-name'], specs)).toThrowError(/Unknown option: --no-name/);
    });
  });

  describe('values', () => {
    it('reads --key=value', () => {
      expect(flagString(parseArgs(['--name=myapp'], specs), 'name')).toBe('myapp');
    });

    it('reads --key value', () => {
      expect(flagString(parseArgs(['--name', 'myapp'], specs), 'name')).toBe('myapp');
    });

    it('does not swallow a positional as a value it already has', () => {
      const parsed = parseArgs(['--name=myapp', 'extra'], specs);
      expect(flagString(parsed, 'name')).toBe('myapp');
      expect(parsed.positionals).toEqual(['extra']);
    });

    it('parses a number', () => {
      expect(flagNumber(parseArgs(['--lines', '200'], specs), 'lines')).toBe(200);
    });

    it('rejects a non-numeric number', () => {
      expect(() => parseArgs(['--lines', 'lots'], specs)).toThrowError(/expects a number/);
    });

    it('throws when a value-taking flag has no value', () => {
      expect(() => parseArgs(['--name'], specs)).toThrowError(/Option --name needs a value/);
    });

    it('treats an empty --key= as an empty string, which flagString reports as absent', () => {
      const parsed = parseArgs(['--name='], specs);
      expect(parsed.flags.name).toBe('');
      expect(flagString(parsed, 'name')).toBeUndefined();
    });
  });

  describe('choices', () => {
    it('accepts an allowed value', () => {
      expect(flagString(parseArgs(['--format', 'json'], specs), 'format')).toBe('json');
    });

    it('rejects a value outside the set', () => {
      expect(() => parseArgs(['--format', 'yaml'], specs)).toThrowError(/Invalid value "yaml" for --format/);
    });

    it('lists the allowed values in the hint', () => {
      const error = captureWarplineError(() => parseArgs(['--format', 'yaml'], specs));
      expect(error.hint).toContain('Allowed: table, json');
    });
  });

  describe('lists', () => {
    it('accumulates a repeated flag', () => {
      expect(flagList(parseArgs(['--only', 'api', '--only', 'web'], specs), 'only')).toEqual(['api', 'web']);
    });

    it('splits a comma-separated value', () => {
      expect(flagList(parseArgs(['--only', 'api,web'], specs), 'only')).toEqual(['api', 'web']);
    });

    it('trims entries and drops empties', () => {
      expect(flagList(parseArgs(['--only', ' api , , web '], specs), 'only')).toEqual(['api', 'web']);
    });

    it('combines repetition with comma splitting', () => {
      expect(flagList(parseArgs(['-o', 'api,web', '-o', 'worker'], specs), 'only')).toEqual([
        'api',
        'web',
        'worker',
      ]);
    });
  });

  describe('short flags', () => {
    it('resolves an alias', () => {
      expect(flagBool(parseArgs(['-d'], specs), 'detach')).toBe(true);
    });

    it('unbundles several booleans', () => {
      const parsed = parseArgs(['-df'], specs);
      expect(flagBool(parsed, 'detach')).toBe(true);
      expect(flagBool(parsed, 'force')).toBe(true);
    });

    it('reads an attached value on the last of a bundle', () => {
      const parsed = parseArgs(['-dn', 'myapp'], specs);
      expect(flagBool(parsed, 'detach')).toBe(true);
      expect(flagString(parsed, 'name')).toBe('myapp');
    });

    it('reads a value fused to the flag', () => {
      expect(flagNumber(parseArgs(['-l200'], specs), 'lines')).toBe(200);
    });

    it('reads a value after an equals sign', () => {
      expect(flagNumber(parseArgs(['-l=200'], specs), 'lines')).toBe(200);
    });

    it('reports an unknown short flag with a single dash', () => {
      expect(() => parseArgs(['-z'], specs)).toThrowError(/Unknown option: -z/);
    });
  });

  describe('passthrough', () => {
    it('captures everything after a bare -- verbatim', () => {
      const parsed = parseArgs(['myapp', '--', 'npm', 'run', 'seed', '--silent'], specs);
      expect(parsed.positionals).toEqual(['myapp']);
      expect(parsed.passthrough).toEqual(['npm', 'run', 'seed', '--silent']);
    });

    it('does not validate flags inside the passthrough', () => {
      expect(() => parseArgs(['--', '--not-a-warpline-flag'], specs)).not.toThrow();
    });

    it('keeps a second -- as passthrough content', () => {
      expect(parseArgs(['--', 'a', '--', 'b'], specs).passthrough).toEqual(['a', '--', 'b']);
    });
  });

  it('treats a negative number as a positional rather than a flag', () => {
    expect(parseArgs(['-5'], specs).positionals).toEqual(['-5']);
  });

  it('reports an unknown long flag', () => {
    expect(() => parseArgs(['--nope'], specs)).toThrowError(/Unknown option: --nope/);
  });
});

describe('flag accessors', () => {
  it('flagBool is strict about the value being boolean true', () => {
    const parsed = parseArgs(['--name=true'], specs);
    expect(flagBool(parsed, 'name')).toBe(false);
  });

  it('flagNumber ignores a non-number', () => {
    expect(flagNumber(parseArgs(['--name=5'], specs), 'name')).toBeUndefined();
  });

  it('flagList ignores a non-list', () => {
    expect(flagList(parseArgs(['--name=x'], specs), 'name')).toEqual([]);
  });
});

describe('renderFlagHelp', () => {
  it('documents only flags that carry a description', () => {
    const help = renderFlagHelp(specs).join('\n');
    expect(help).toContain('--detach');
    expect(help).not.toContain('--undocumented');
  });

  it('shows the alias and a value placeholder appropriate to the type', () => {
    const lines = renderFlagHelp(specs);
    expect(lines.find((line) => line.includes('--name'))).toContain('-n, --name <value>');
    expect(lines.find((line) => line.includes('--lines'))).toContain('-l, --lines <n>');
    expect(lines.find((line) => line.includes('--only'))).toContain('-o, --only <a,b>');
    // Booleans take no value, so they get no placeholder.
    expect(lines.find((line) => line.includes('--detach'))).toContain('-d, --detach ');
  });

  it('aligns the descriptions into a column', () => {
    // renderFlagHelp keeps declaration order for the described flags, so line i
    // documents described[i].
    const described = Object.values(specs).filter((spec) => spec.describe);
    const lines = renderFlagHelp(specs);
    expect(lines).toHaveLength(described.length);

    const starts = lines.map((line, i) => line.indexOf(described[i]?.describe as string));
    expect(starts.every((start) => start === starts[0])).toBe(true);
    expect(starts[0]).toBeGreaterThan(0);
  });
});
