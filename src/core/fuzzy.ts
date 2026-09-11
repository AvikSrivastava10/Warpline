/**
 * Name matching for `warpline up myproj` -> `myproject`. Ranked rather than
 * boolean so callers can auto-accept a single confident match and prompt when
 * the result is genuinely ambiguous.
 */

export type MatchKind = 'exact' | 'exact-ci' | 'prefix' | 'substring' | 'subsequence' | 'typo';

export interface Match<T> {
  item: T;
  name: string;
  kind: MatchKind;
  /** Lower is better. */
  distance: number;
}

const KIND_RANK: Record<MatchKind, number> = {
  exact: 0,
  'exact-ci': 1,
  prefix: 2,
  substring: 3,
  subsequence: 4,
  typo: 5,
};

/** Are all of `query`'s characters present in `text`, in order? */
function isSubsequence(query: string, text: string): boolean {
  let index = 0;
  for (const char of text) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return query.length === 0;
}

/** Levenshtein with a cutoff, using a single rolling row. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0] as number;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    // Every remaining path can only grow, so bail once the whole row exceeds max.
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j] as number;
  }

  return previous[b.length] as number;
}

export function matchName<T>(query: string, items: T[], nameOf: (item: T) => string): Match<T>[] {
  const needle = query.trim();
  const lowerNeedle = needle.toLowerCase();
  const matches: Match<T>[] = [];

  for (const item of items) {
    const name = nameOf(item);
    const lowerName = name.toLowerCase();

    let kind: MatchKind | undefined;
    let distance = 0;

    if (name === needle) {
      kind = 'exact';
    } else if (lowerName === lowerNeedle) {
      kind = 'exact-ci';
    } else if (lowerName.startsWith(lowerNeedle)) {
      kind = 'prefix';
      distance = lowerName.length - lowerNeedle.length;
    } else if (lowerName.includes(lowerNeedle)) {
      kind = 'substring';
      distance = lowerName.length - lowerNeedle.length;
    } else if (lowerNeedle.length >= 2 && isSubsequence(lowerNeedle, lowerName)) {
      kind = 'subsequence';
      distance = lowerName.length - lowerNeedle.length;
    } else {
      // Only treat as a typo when the query is long enough that a small edit
      // distance is meaningful; short strings collide far too easily.
      const maxEdits = lowerNeedle.length >= 5 ? 2 : 1;
      const edits = editDistance(lowerNeedle, lowerName, maxEdits);
      if (edits <= maxEdits) {
        kind = 'typo';
        distance = edits;
      }
    }

    if (kind) matches.push({ item, name, kind, distance });
  }

  matches.sort((a, b) => {
    const rankDiff = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (rankDiff !== 0) return rankDiff;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.name.localeCompare(b.name);
  });

  return matches;
}

/**
 * True when the best match is decisively better than the runner-up, which is
 * the condition for silently accepting a fuzzy match instead of asking.
 */
export function isUnambiguous<T>(matches: Match<T>[]): boolean {
  const best = matches[0];
  if (!best) return false;
  if (matches.length === 1) return true;
  if (best.kind === 'exact' || best.kind === 'exact-ci') return true;
  const second = matches[1];
  if (!second) return true;
  return KIND_RANK[best.kind] < KIND_RANK[second.kind];
}
