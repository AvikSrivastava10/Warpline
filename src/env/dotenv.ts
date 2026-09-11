/**
 * Minimal dotenv parser. Written by hand rather than pulled in as a dependency
 * because the format is small and Warpline needs one behaviour the popular
 * parsers do not expose: reporting the *order* and origin of keys so
 * `warpline doctor` can say which file set which variable.
 */

export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line where the key was declared. */
  line: number;
}

export interface DotenvParseResult {
  entries: DotenvEntry[];
  map: Record<string, string>;
}

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::?=)\s*(.*)$/;

export function parseDotenv(text: string): DotenvParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: DotenvEntry[] = [];
  const map: Record<string, string> = {};

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const match = KEY_LINE.exec(raw);
    if (!match) continue;

    const key = match[1];
    let rest = match[2] ?? '';
    if (!key) continue;

    const lineNumber = i + 1;
    let value: string;

    const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : rest.startsWith('`') ? '`' : '';

    if (quote) {
      rest = rest.slice(1);
      let buffer = '';
      let closed = false;

      for (;;) {
        const closeIndex = findClosingQuote(rest, quote);
        if (closeIndex >= 0) {
          buffer += rest.slice(0, closeIndex);
          closed = true;
          break;
        }
        // Unterminated on this line: the value continues onto the next one.
        buffer += rest + '\n';
        i += 1;
        if (i >= lines.length) break;
        rest = lines[i] ?? '';
      }

      value = quote === '"' ? unescapeDoubleQuoted(buffer) : buffer;
      if (!closed) value = value.replace(/\n$/, '');
    } else {
      // Unquoted: strip a trailing inline comment, then trim.
      const hashIndex = findInlineComment(rest);
      value = (hashIndex >= 0 ? rest.slice(0, hashIndex) : rest).trim();
    }

    entries.push({ key, value, line: lineNumber });
    map[key] = value;
  }

  return { entries, map };
}

function findClosingQuote(text: string, quote: string): number {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

/** An inline comment needs whitespace before `#`, so `pass#word` stays intact. */
function findInlineComment(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '#') continue;
    if (i === 0) return 0;
    const previous = text[i - 1];
    if (previous === ' ' || previous === '\t') return i;
  }
  return -1;
}

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([nrtfbv"'`\\$])/g, (_match, char: string) => {
    switch (char) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'f':
        return '\f';
      case 'b':
        return '\b';
      case 'v':
        return '\v';
      default:
        return char;
    }
  });
}

/**
 * Expands `${VAR}`, `${VAR:-default}`, and bare `$VAR` against a lookup,
 * honouring `\$` as an escape. Substitution is applied iteratively so a value
 * can reference another value that itself contains a reference, with a hard
 * depth cap to make circular references terminate instead of hanging.
 */
export function expandValue(value: string, lookup: (name: string) => string | undefined, depth = 0): string {
  if (depth > 8 || !value.includes('$')) return value;

  return value.replace(
    /\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, bracedName: string | undefined, fallback: string | undefined, bareName: string | undefined) => {
      if (match === '\\$') return '$';
      const name = bracedName ?? bareName;
      if (!name) return match;

      // Recursion is applied to substituted text only, never to the string as a
      // whole. Re-scanning the whole string would resurrect a `\$` that this
      // pass had just reduced to a literal `$`, so an escape was silently
      // defeated whenever the same value also held a real reference.
      const resolved = lookup(name);
      if (resolved !== undefined && resolved.length > 0) return expandValue(resolved, lookup, depth + 1);
      if (fallback !== undefined) return expandValue(fallback, lookup, depth + 1);

      // Leave unknown references untouched rather than silently emptying them;
      // `env.require` is the mechanism for turning that into an error.
      return match;
    },
  );
}
