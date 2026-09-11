import { describe, expect, it } from 'vitest';
import { editDistance, isUnambiguous, matchName, type Match } from '../../src/core/fuzzy.js';

/** matchName is generic over items; project names are the real use case. */
function match(query: string, names: string[]): Match<string>[] {
  return matchName(query, names, (name) => name);
}

function kindOf(query: string, names: string[]): string | undefined {
  return match(query, names)[0]?.kind;
}

describe('matchName', () => {
  it('finds nothing when no candidate is close', () => {
    expect(match('zzzzz', ['myproject', 'api-server'])).toEqual([]);
  });

  describe('match kinds', () => {
    it('classifies an exact match', () => {
      expect(kindOf('myproject', ['myproject'])).toBe('exact');
    });

    it('classifies a case-insensitive exact match', () => {
      expect(kindOf('MyProject', ['myproject'])).toBe('exact-ci');
    });

    it('classifies a prefix', () => {
      expect(kindOf('mypro', ['myproject'])).toBe('prefix');
    });

    it('classifies a substring', () => {
      expect(kindOf('project', ['myproject'])).toBe('substring');
    });

    it('classifies a subsequence', () => {
      expect(kindOf('mpj', ['myproject'])).toBe('subsequence');
    });

    it('classifies a typo by edit distance', () => {
      // A substituted character breaks subsequence order, so this is the first
      // shape that actually reaches the edit-distance branch.
      expect(kindOf('projact', ['project'])).toBe('typo');
    });

    it('classifies a transposition as a typo', () => {
      expect(kindOf('stauts', ['status'])).toBe('typo');
    });

    it('classifies a dropped character as a subsequence, not a typo', () => {
      // Worth pinning: a deletion is always a subsequence of the original, and
      // subsequence is tested first, so `projct` never reaches the typo branch.
      expect(kindOf('projct', ['project'])).toBe('subsequence');
    });
  });

  it('matches the abbreviation from the README', () => {
    const best = match('myproj', ['myproject'])[0];
    expect(best?.name).toBe('myproject');
    expect(best?.kind).toBe('prefix');
  });

  it('matches the abbreviations the docs promise, as subsequences', () => {
    expect(kindOf('fixtre', ['fixture'])).toBe('subsequence');
    expect(kindOf('brokn', ['brokenproject'])).toBe('subsequence');
  });

  describe('the typo guard for short queries', () => {
    it('allows two edits once the query is five characters or more', () => {
      // Two substitutions, so neither prefix, substring, nor subsequence applies.
      expect(kindOf('stobus', ['status'])).toBe('typo');
      expect(match('stobus', ['status'])[0]?.distance).toBe(2);
    });

    it('allows only one edit on a short query', () => {
      expect(kindOf('abc', ['abd'])).toBe('typo');
    });

    it('rejects two edits on a short query', () => {
      expect(match('abc', ['axy'])).toEqual([]);
    });

    it('rejects three edits even on a long query', () => {
      expect(match('statistic', ['status'])).toEqual([]);
    });
  });

  it('treats a single character as a substring rather than a subsequence', () => {
    expect(kindOf('x', ['axbxc'])).toBe('substring');
  });

  describe('ranking', () => {
    it('puts a better kind first regardless of input order', () => {
      const ranked = match('project', ['myproject', 'project']);
      expect(ranked.map((entry) => entry.name)).toEqual(['project', 'myproject']);
    });

    it('breaks a kind tie by how much longer the name is', () => {
      const ranked = match('a', ['abc', 'ab']);
      expect(ranked.map((entry) => entry.name)).toEqual(['ab', 'abc']);
    });

    it('breaks a remaining tie alphabetically', () => {
      const ranked = match('a', ['ac', 'ab']);
      expect(ranked.map((entry) => entry.name)).toEqual(['ab', 'ac']);
    });

    it('records the length gap as the distance for a prefix', () => {
      expect(match('my', ['myproject'])[0]?.distance).toBe('myproject'.length - 'my'.length);
    });

    it('records the number of edits as the distance for a typo', () => {
      expect(match('projact', ['project'])[0]?.distance).toBe(1);
    });
  });
});

describe('isUnambiguous', () => {
  it('is false with nothing to choose from', () => {
    expect(isUnambiguous([])).toBe(false);
  });

  it('is true with a single candidate', () => {
    expect(isUnambiguous(match('mypro', ['myproject']))).toBe(true);
  });

  it('is true when the winner is exact, even against other candidates', () => {
    expect(isUnambiguous(match('project', ['project', 'myproject']))).toBe(true);
  });

  it('is true when the winner has a strictly better kind than the runner-up', () => {
    // "appserver" is a prefix, "myapp" only a substring.
    const matches = match('app', ['appserver', 'myapp']);
    expect(matches[0]?.kind).toBe('prefix');
    expect(matches[1]?.kind).toBe('substring');
    expect(isUnambiguous(matches)).toBe(true);
  });

  it('is false when the two best candidates match the same way', () => {
    const matches = match('my', ['myapp', 'mysite']);
    expect(matches.map((entry) => entry.kind)).toEqual(['prefix', 'prefix']);
    expect(isUnambiguous(matches)).toBe(false);
  });
});

describe('editDistance', () => {
  it('is zero for identical strings', () => {
    expect(editDistance('project', 'project')).toBe(0);
  });

  it('counts a single substitution', () => {
    expect(editDistance('abc', 'abd')).toBe(1);
  });

  it('counts a single deletion', () => {
    expect(editDistance('projct', 'project')).toBe(1);
  });

  it('exceeds the cutoff rather than computing a large distance', () => {
    expect(editDistance('abc', 'xyz', 1)).toBeGreaterThan(1);
  });

  it('short-circuits on a length gap wider than the cutoff', () => {
    expect(editDistance('a', 'abcdefghij', 3)).toBeGreaterThan(3);
  });
});
