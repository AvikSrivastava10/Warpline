#!/usr/bin/env node
import { runCli, reportError } from './cli.js';

/**
 * Thin entry point. Everything interesting lives in `cli.ts` so it stays
 * importable and testable without the process-level concerns handled here.
 */
async function main(): Promise<void> {
  // EPIPE is expected whenever output is piped into something that exits early,
  // such as `warpline logs | head`. It is not an error worth reporting.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
  });

  try {
    const code = await runCli(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    process.exitCode = reportError(error);
  }
}

process.on('unhandledRejection', (reason) => {
  process.exitCode = reportError(reason);
});

void main();
