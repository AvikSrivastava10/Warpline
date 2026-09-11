import { WarplineError } from './errors.js';

export interface FlagSpec {
  type: 'boolean' | 'string' | 'number' | 'list';
  alias?: string;
  /** Shown in `--help`. */
  describe?: string;
  default?: boolean | string | number | string[];
  /** Restrict a string flag to a fixed set, validated at parse time. */
  choices?: readonly string[];
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, boolean | string | number | string[] | undefined>;
  /** Everything after a bare `--`, passed through verbatim. */
  passthrough: string[];
}

/**
 * Zero-dependency argv parser. Deliberately small, but it does handle the
 * cases that actually show up: `--flag`, `--no-flag`, `--key=value`,
 * `--key value`, short aliases, bundled shorts (`-fd`), repeated list flags,
 * and a `--` passthrough boundary for `warpline exec`.
 */
export function parseArgs(argv: string[], specs: FlagSpecs): ParsedArgs {
  const aliasMap = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias) aliasMap.set(spec.alias, name);
  }

  const flags: Record<string, boolean | string | number | string[] | undefined> = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.default !== undefined) flags[name] = spec.default;
    else if (spec.type === 'boolean') flags[name] = false;
    else if (spec.type === 'list') flags[name] = [];
  }

  const positionals: string[] = [];
  const passthrough: string[] = [];
  let sawSeparator = false;

  const resolve = (token: string): { name: string; spec: FlagSpec } => {
    const name = aliasMap.get(token) ?? token;
    const spec = specs[name];
    if (!spec) {
      throw new WarplineError(`Unknown option: ${token.length === 1 ? '-' : '--'}${token}`, {
        hint: 'Run the command with --help to see supported options.',
      });
    }
    return { name, spec };
  };

  const assign = (name: string, spec: FlagSpec, rawValue: string | undefined, token: string): boolean => {
    // returns true when it consumed the next argv entry
    if (spec.type === 'boolean') {
      if (rawValue !== undefined) {
        flags[name] = rawValue !== 'false' && rawValue !== '0';
      } else {
        flags[name] = true;
      }
      return false;
    }

    let value = rawValue;
    let consumed = false;
    if (value === undefined) {
      value = pending.shift();
      consumed = true;
    }
    if (value === undefined) {
      throw new WarplineError(`Option --${name} needs a value`, {
        hint: `Example: --${name} <value>`,
      });
    }

    if (spec.choices && !spec.choices.includes(value)) {
      throw new WarplineError(`Invalid value "${value}" for --${name}`, {
        hint: `Allowed: ${spec.choices.join(', ')}`,
      });
    }

    if (spec.type === 'number') {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        throw new WarplineError(`Option --${name} expects a number, got "${value}"`);
      }
      flags[name] = num;
    } else if (spec.type === 'list') {
      // Repeatable and comma-splittable: --only api --only web  ==  --only api,web
      const current = Array.isArray(flags[name]) ? (flags[name] as string[]) : [];
      const additions = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      flags[name] = [...current, ...additions];
    } else {
      flags[name] = value;
    }

    void token;
    return consumed;
  };

  const pending = [...argv];

  while (pending.length > 0) {
    const arg = pending.shift() as string;

    if (sawSeparator) {
      passthrough.push(arg);
      continue;
    }

    if (arg === '--') {
      sawSeparator = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const rawName = eq >= 0 ? body.slice(0, eq) : body;
      const rawValue = eq >= 0 ? body.slice(eq + 1) : undefined;

      // `--no-color` style negation for booleans.
      if (rawValue === undefined && rawName.startsWith('no-')) {
        const positive = rawName.slice(3);
        const candidate = specs[aliasMap.get(positive) ?? positive];
        if (candidate && candidate.type === 'boolean') {
          flags[aliasMap.get(positive) ?? positive] = false;
          continue;
        }
      }

      const { name, spec } = resolve(rawName);
      assign(name, spec, rawValue, rawName);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const body = arg.slice(1);
      const eq = body.indexOf('=');

      if (eq >= 0) {
        const { name, spec } = resolve(body.slice(0, eq));
        assign(name, spec, body.slice(eq + 1), body.slice(0, eq));
        continue;
      }

      // Bundled shorts: every char is a boolean except optionally the last.
      for (let i = 0; i < body.length; i += 1) {
        const char = body[i] as string;
        const { name, spec } = resolve(char);
        if (spec.type === 'boolean') {
          assign(name, spec, undefined, char);
          continue;
        }
        const remainder = body.slice(i + 1);
        assign(name, spec, remainder.length > 0 ? remainder : undefined, char);
        break;
      }
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, flags, passthrough };
}

export function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function flagBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

export function flagNumber(parsed: ParsedArgs, name: string): number | undefined {
  const value = parsed.flags[name];
  return typeof value === 'number' ? value : undefined;
}

export function flagList(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags[name];
  return Array.isArray(value) ? value : [];
}

/** Renders a spec map into aligned `--flag, -f  description` help lines. */
export function renderFlagHelp(specs: FlagSpecs): string[] {
  const entries = Object.entries(specs).filter(([, spec]) => spec.describe);
  const left = entries.map(([name, spec]) => {
    const alias = spec.alias ? `-${spec.alias}, ` : '    ';
    const value =
      spec.type === 'boolean' ? '' : spec.type === 'list' ? ' <a,b>' : spec.type === 'number' ? ' <n>' : ' <value>';
    return `${alias}--${name}${value}`;
  });
  const width = Math.max(0, ...left.map((l) => l.length));
  return entries.map(([, spec], i) => `  ${(left[i] ?? '').padEnd(width)}  ${spec.describe ?? ''}`);
}
