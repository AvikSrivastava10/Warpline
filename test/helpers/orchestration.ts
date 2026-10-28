import net from 'node:net';
import path from 'node:path';
import { loadConfigFile } from '../../src/config/load.js';
import { sleep } from '../../src/core/fsx.js';
import { ProcessLogger } from '../../src/proc/logger.js';
import { Supervisor, type StartOutcome } from '../../src/proc/supervisor.js';
import { buildShellCommand } from '../../src/proc/spawn.js';
import { readRuntime, type ProjectRuntime } from '../../src/state/runtime.js';
import type { WarplineConfig } from '../../src/config/types.js';
import { writeTree } from './tmpdir.js';

/**
 * Helpers for driving a real Supervisor against real child processes.
 *
 * Child scripts are written as `.cjs` files rather than passed with `node -e`.
 * That sidesteps both the shell quoting and the module-type ambiguity of `-e`,
 * and it keeps the fixture commands readable in a failure message.
 */

/** Child scripts every orchestration fixture gets. */
export const CHILD_SCRIPTS: Record<string, string> = {
  // Prints one line, then stays up until it is stopped.
  'stay.cjs': [
    "console.log(process.env.MARKER || 'listening on stdout');",
    'setInterval(() => {}, 1000);',
  ].join('\n'),

  // An HTTP server, so a port probe has something real to connect to.
  'serve.cjs': [
    "const http = require('node:http');",
    'const port = Number(process.env.PORT);',
    "const delay = Number(process.env.LISTEN_DELAY || '0');",
    'setTimeout(() => {',
    "  http.createServer((_q, s) => s.end('ok')).listen(port, '127.0.0.1', () => {",
    "    console.log('listening on ' + port);",
    '  });',
    '}, delay);',
  ].join('\n'),

  // Runs to completion successfully.
  'exit0.cjs': ["console.log('task finished');", 'process.exit(0);'].join('\n'),

  // Runs to completion and fails.
  'exit1.cjs': ["console.error('task failed');", 'process.exit(1);'].join('\n'),

  // Starts, then dies, for restart-policy coverage.
  'crash.cjs': ["console.log('about to crash');", 'process.exit(3);'].join('\n'),

  // Reports selected environment values so injection can be observed.
  'dumpenv.cjs': [
    "const keys = ['PORT', 'WARPLINE', 'WARPLINE_PROJECT', 'WARPLINE_PROCESS', 'FROM_FILE'];",
    "console.log(keys.map((k) => k + '=' + (process.env[k] ?? '')).join(' '));",
    'setInterval(() => {}, 1000);',
  ].join('\n'),
};

/** Command string for one of the child scripts above. */
export function childCommand(script: string): string {
  return buildShellCommand([process.execPath, script]);
}

/**
 * The same command, quoted for embedding in a YAML fixture.
 *
 * Needed because `process.execPath` on Windows is
 * `C:\Program Files\nodejs\node.exe` — a space, so the shell quoting wraps it in
 * double quotes, and the backslashes and quotes together are not a valid bare
 * YAML scalar. Single-quoted YAML takes both literally; the only escape it needs
 * is a doubled single quote.
 */
export function yamlChildCommand(script: string): string {
  return `'${childCommand(script).replace(/'/g, "''")}'`;
}

/** An unused TCP port, so port probes do not collide with anything real. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('could not find a free port'))));
    });
  });
}

/** Writes the child scripts plus a warpline.yml, and loads the config. */
export function fixtureConfig(root: string, warplineYml: string): WarplineConfig {
  writeTree(root, { ...CHILD_SCRIPTS, 'warpline.yml': warplineYml });
  return loadConfigFile(path.join(root, 'warpline.yml'));
}

export interface RunResult {
  outcome: StartOutcome;
  supervisor: Supervisor;
}

/**
 * Starts every process in a config, hands the result to the caller, and always
 * shuts down afterwards.
 *
 * The teardown is not optional: a leaked child holding a port makes every later
 * test fail in a way that looks unrelated to the test that leaked it.
 */
export async function withSupervisor(
  config: WarplineConfig,
  body: (result: RunResult) => Promise<void> | void,
  options: { projectName?: string; keepGoing?: boolean } = {},
): Promise<void> {
  const projectName = options.projectName ?? config.name;
  const logger = new ProcessLogger({
    projectName,
    toConsole: false,
    prefix: false,
  });

  const supervisor = new Supervisor({
    config,
    projectName,
    processes: config.processes,
    mode: 'foreground',
    logger,
    quiet: true,
    ...(options.keepGoing === undefined ? {} : { keepGoing: options.keepGoing }),
  });

  try {
    const outcome = await supervisor.start();
    await body({ outcome, supervisor });
  } finally {
    await supervisor.stopAll('test teardown');
    await logger.close();
  }
}

/**
 * Waits until the state file reflects a condition.
 *
 * The supervisor coalesces state writes through `setImmediate`, so the file lags
 * the in-memory runtime by up to one macrotask. Awaiting a promise is only a
 * microtask, which means a test can observe `start()` as resolved while the write
 * has not landed yet. The in-memory runtime is authoritative; the file catches up.
 *
 * Not a defect: `up --detach` polls this file on a 250ms interval and `stopAll`
 * flushes synchronously, so nothing user-facing races it.
 */
export async function waitForState(
  name: string,
  predicate: (state: ProjectRuntime) => boolean,
  timeoutMs = 3000,
): Promise<ProjectRuntime> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const state = readRuntime(name);
    if (state && predicate(state)) return state;
    if (Date.now() >= deadline) {
      throw new Error(
        `state for "${name}" did not satisfy the condition within ${timeoutMs}ms (last seen: ${JSON.stringify(
          state?.processes ?? null,
        )})`,
      );
    }
    await sleep(25);
  }
}

/** Status of every process, keyed by id, for compact assertions. */
export function statuses(supervisor: Supervisor): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of Object.values(supervisor.runtime.processes)) {
    result[entry.id] = entry.status;
  }
  return result;
}
