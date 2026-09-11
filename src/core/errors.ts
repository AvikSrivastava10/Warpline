/**
 * A failure we anticipated and can explain in one line, optionally with a
 * concrete next step. These print as a clean message; anything else prints a
 * stack trace because it means Warpline has a bug.
 */
export class WarplineError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(message: string, options: { hint?: string; exitCode?: number; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'WarplineError';
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

/** Config file exists but is structurally wrong. Carries every problem at once. */
export class ConfigError extends WarplineError {
  readonly problems: string[];

  constructor(file: string, problems: string[]) {
    const list = problems.map((p) => `  - ${p}`).join('\n');
    super(`Invalid Warpline config at ${file}:\n${list}`, {
      hint: 'Run `warpline doctor` for a full check, or see the config reference in the README.',
    });
    this.name = 'ConfigError';
    this.problems = problems;
  }
}


