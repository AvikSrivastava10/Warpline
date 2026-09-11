import { WarplineError } from '../../src/core/errors.js';

/**
 * Captures a thrown WarplineError so a test can assert on its hint as well as
 * its message.
 *
 * vitest's `toThrowError` only inspects `message`, but Warpline deliberately
 * splits "what went wrong" from "what to do about it" — `cli.ts` prints them as
 * separate lines. Asserting only on the message would leave every remediation
 * hint untested, and those are the part users actually act on.
 */
export function captureWarplineError(fn: () => unknown): WarplineError {
  try {
    fn();
  } catch (error) {
    if (error instanceof WarplineError) return error;
    throw error;
  }
  throw new Error('Expected a WarplineError to be thrown, but the call returned normally');
}
