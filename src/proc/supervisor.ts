import type { ChildProcess } from 'node:child_process';
import { sleep } from '../core/fsx.js';
import { theme, glyph, formatDuration } from '../core/ui.js';
import { resolveEnv, getEnvVar, setEnvVar } from '../env/resolve.js';
import type { ProcessConfig, WarplineConfig } from '../config/types.js';
import {
  createRuntime,
  writeRuntime,
  type ProcessRuntime,
  type ProjectRuntime,
  type ProcessStatus,
} from '../state/runtime.js';
import type { ProcessLogger } from './logger.js';
import { createReadinessWaiter, type ReadinessWaiter } from './readiness.js';
import { openUrl, runToCompletion, spawnShellCommand, terminateTree } from './spawn.js';
import { shutdownOrder } from './graph.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  const box: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value: T) => {
      if (box.settled) return;
      box.settled = true;
      resolve(value);
    },
  };
  return box;
}

interface ExitInfo {
  code: number | null;
  signal: string | null;
}

interface Managed {
  config: ProcessConfig;
  runtime: ProcessRuntime;
  env: Record<string, string>;
  ready: Deferred<boolean>;
  child: ChildProcess | undefined;
  waiter: ReadinessWaiter | undefined;
  attempt: number;
  /** Set while Warpline is deliberately stopping this process. */
  stopping: boolean;
}

export interface SupervisorOptions {
  config: WarplineConfig;
  projectName: string;
  processes: ProcessConfig[];
  mode: 'foreground' | 'detached';
  logger: ProcessLogger;
  envOverrides?: Record<string, string>;
  /** Open configured URLs once their process is ready. */
  openBrowser?: boolean;
  /** Continue after a process fails instead of tearing everything down. */
  keepGoing?: boolean;
  /** Suppress progress chatter (used by the detached supervisor). */
  quiet?: boolean;
}

export interface StartOutcome {
  ok: boolean;
  failures: Array<{ id: string; reason: string }>;
  readyCount: number;
  elapsedMs: number;
}

/**
 * Owns the lifecycle of every process in a project: start ordering, readiness
 * gating, restart-with-backoff, and ordered shutdown.
 *
 * Dependencies are awaited per-process rather than in strict waves, so
 * independent branches of the graph start concurrently. A three-service project
 * where `web` and `worker` both need `db` starts both the moment `db` answers,
 * instead of serialising them.
 */
export class Supervisor {
  readonly runtime: ProjectRuntime;
  private readonly managed = new Map<string, Managed>();
  private readonly options: SupervisorOptions;
  private readonly abort = new AbortController();
  private shuttingDown = false;
  private persistScheduled = false;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.runtime = createRuntime({
      name: options.projectName,
      root: options.config.root,
      configFile: options.config.configFile,
      mode: options.mode,
    });

    options.processes.forEach((proc, index) => {
      const logFile = options.logger.register(proc.id, proc.label, index);
      const resolved = resolveEnv(options.config, proc, { overrides: options.envOverrides ?? {} });

      // Frameworks overwhelmingly read PORT. Injecting only the explicitly
      // declared port keeps this predictable: a port that Warpline merely probes
      // never silently rewrites the process environment.
      if (proc.declaredPort !== undefined && getEnvVar(resolved.values, 'PORT') === undefined) {
        setEnvVar(resolved.values, 'PORT', String(proc.declaredPort));
      }

      const runtime: ProcessRuntime = {
        id: proc.id,
        label: proc.label,
        command: proc.command,
        cwd: proc.cwd,
        kind: proc.kind,
        pid: undefined,
        status: 'pending',
        startedAt: undefined,
        readyAt: undefined,
        exitCode: undefined,
        signal: undefined,
        restarts: 0,
        ports: proc.ports,
        logFile,
        message: undefined,
      };

      this.runtime.processes[proc.id] = runtime;
      this.managed.set(proc.id, {
        config: proc,
        runtime,
        env: resolved.values,
        ready: deferred<boolean>(),
        child: undefined,
        waiter: undefined,
        attempt: 0,
        stopping: false,
      });
    });
  }

  private log(line: string): void {
    if (!this.options.quiet) process.stderr.write(line + '\n');
  }

  /** Coalesces state writes so a burst of status changes costs one write. */
  private persist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    setImmediate(() => {
      this.persistScheduled = false;
      try {
        writeRuntime(this.runtime);
      } catch {
        /* state is a convenience, never a hard requirement */
      }
    });
  }

  private setStatus(id: string, status: ProcessStatus, message?: string): void {
    const managed = this.managed.get(id);
    if (!managed) return;
    managed.runtime.status = status;
    if (message !== undefined) managed.runtime.message = message;
    this.persist();
  }

  /** Runs `hooks.before` / `hooks.after` / `hooks.cleanup` commands in order. */
  private async runHooks(phase: 'before' | 'after' | 'cleanup'): Promise<boolean> {
    const commands = this.options.config.hooks[phase];
    if (commands.length === 0) return true;

    const env = resolveEnv(this.options.config, undefined, { overrides: this.options.envOverrides ?? {} }).values;

    for (const command of commands) {
      this.log(`${theme.dim(glyph.arrow)} ${theme.dim(`hook:${phase}`)} ${command}`);
      const result = await runToCompletion({
        command,
        cwd: this.options.config.root,
        env,
        timeoutMs: 300_000,
        onOutput: (chunk) => {
          if (!this.options.quiet) process.stderr.write(chunk);
        },
      });

      if (result.code !== 0) {
        // A failed `before` hook means the environment is not prepared, so
        // starting anyway would just produce a more confusing failure later.
        if (phase === 'before') {
          this.log(theme.err(`${glyph.fail} hook:before failed (exit ${result.code ?? 'signal'}): ${command}`));
          return false;
        }
        this.log(theme.warn(`${glyph.warn} hook:${phase} exited ${result.code ?? 'with a signal'}: ${command}`));
      }
    }
    return true;
  }

  /** Starts everything and resolves once each process is ready or has failed. */
  async start(): Promise<StartOutcome> {
    const startedAt = Date.now();

    if (!(await this.runHooks('before'))) {
      return {
        ok: false,
        failures: [{ id: 'hooks.before', reason: 'a before hook failed' }],
        readyCount: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }

    this.persist();

    const runs = [...this.managed.values()].map((managed) => this.supervise(managed));
    const results = await Promise.all(runs.map((run) => run.startupSettled));

    const failures = results
      .filter((result): result is { id: string; ok: false; reason: string } => !result.ok)
      .map((result) => ({ id: result.id, reason: result.reason }));

    const readyCount = results.filter((result) => result.ok).length;
    const ok = failures.length === 0;

    // Track the long-running halves so `waitForCompletion` can await them.
    this.lifetimes = runs.map((run) => run.lifetime);

    if (ok) {
      await this.runHooks('after');
      if (this.options.openBrowser) await this.openReadyUrls();
    }

    return { ok, failures, readyCount, elapsedMs: Date.now() - startedAt };
  }

  private lifetimes: Array<Promise<void>> = [];

  /** Resolves when every process has terminally settled. */
  async waitForCompletion(): Promise<void> {
    await Promise.all(this.lifetimes);
  }

  private async openReadyUrls(): Promise<void> {
    for (const managed of this.managed.values()) {
      if (managed.config.open && managed.runtime.status === 'ready') {
        await openUrl(managed.config.open);
      }
    }
  }

  /**
   * Drives one process through dependency gating, startup, readiness, and any
   * restarts. Returns two promises: one that settles when startup is decided
   * (so `up` can report success), and one that settles when the process is gone
   * for good (so foreground mode knows when to exit).
   */
  private supervise(managed: Managed): {
    startupSettled: Promise<{ id: string; ok: true } | { id: string; ok: false; reason: string }>;
    lifetime: Promise<void>;
  } {
    const startup = deferred<{ id: string; ok: true } | { id: string; ok: false; reason: string }>();

    const lifetime = (async () => {
      const { config } = managed;

      // Gate on dependencies.
      if (config.needs.length > 0) {
        this.setStatus(config.id, 'pending', `waiting for ${config.needs.join(', ')}`);
        const depResults = await Promise.all(
          config.needs.map((need) => this.managed.get(need)?.ready.promise ?? Promise.resolve(true)),
        );
        if (!depResults.every(Boolean)) {
          const failedDeps = config.needs.filter((_, i) => !depResults[i]);
          const reason = `dependency failed: ${failedDeps.join(', ')}`;
          this.setStatus(config.id, 'skipped', reason);
          managed.ready.resolve(false);
          startup.resolve({ id: config.id, ok: false, reason });
          return;
        }
      }

      if (this.shuttingDown) {
        this.setStatus(config.id, 'skipped', 'shutdown started before this process launched');
        managed.ready.resolve(false);
        startup.resolve({ id: config.id, ok: false, reason: 'shutdown started first' });
        return;
      }

      for (;;) {
        const attemptResult = await this.runAttempt(managed, startup);
        if (attemptResult === 'done') return;
        if (attemptResult === 'retry') continue;
        return;
      }
    })();

    return { startupSettled: startup.promise, lifetime };
  }

  private async runAttempt(
    managed: Managed,
    startup: Deferred<{ id: string; ok: true } | { id: string; ok: false; reason: string }>,
  ): Promise<'done' | 'retry'> {
    const { config } = managed;
    const exit = deferred<ExitInfo>();
    const waiter = createReadinessWaiter(config.ready);
    managed.waiter = waiter;
    managed.stopping = false;

    this.setStatus(config.id, 'starting', undefined);
    managed.runtime.startedAt = Date.now();
    managed.runtime.exitCode = undefined;
    managed.runtime.signal = undefined;

    let spawned: { child: ChildProcess; pid: number | undefined };
    try {
      spawned = spawnShellCommand({
        command: config.command,
        cwd: config.cwd,
        env: managed.env,
        shell: config.shell,
      });
    } catch (error) {
      const reason = `could not start: ${(error as Error).message}`;
      this.setStatus(config.id, 'failed', reason);
      managed.ready.resolve(false);
      startup.resolve({ id: config.id, ok: false, reason });
      return 'done';
    }

    managed.child = spawned.child;
    managed.runtime.pid = spawned.pid;
    this.persist();

    const label = config.label;
    this.log(
      `${theme.dim(glyph.arrow)} ${theme.bold(label)} ${theme.dim(config.command)}${
        config.ready.kind !== 'none' ? theme.dim(`  [${waiter.describe()}]`) : ''
      }`,
    );

    spawned.child.stdout?.setEncoding('utf8');
    spawned.child.stderr?.setEncoding('utf8');

    const handleOutput = (chunk: string): void => {
      this.options.logger.write(config.id, chunk);
      waiter.onOutput(chunk);
    };
    spawned.child.stdout?.on('data', handleOutput);
    spawned.child.stderr?.on('data', handleOutput);

    spawned.child.once('error', (error) => {
      this.options.logger.note(config.id, `spawn error: ${error.message}`);
      exit.resolve({ code: null, signal: null });
    });
    spawned.child.once('close', (code, signal) => {
      managed.runtime.exitCode = code;
      managed.runtime.signal = signal;
      managed.runtime.pid = undefined;
      exit.resolve({ code, signal });
    });

    if (config.kind === 'service') this.setStatus(config.id, 'running');

    const outcome = await waiter.wait({ exited: exit.promise, aborted: this.abort.signal });

    // Shutdown owns termination and final statuses. A cancelled readiness wait
    // must not race it with a second kill or overwrite stopped with failed.
    if (this.shuttingDown || managed.stopping) {
      managed.ready.resolve(false);
      startup.resolve({ id: config.id, ok: false, reason: 'startup aborted' });
      return 'done';
    }

    if (outcome.ready) {
      managed.runtime.readyAt = Date.now();
      const terminal = config.kind === 'task' ? 'done' : 'ready';
      this.setStatus(config.id, terminal, outcome.reason);

      const timing = theme.dim(`(${formatDuration(outcome.elapsedMs)})`);
      this.log(`${theme.ok(glyph.ok)} ${theme.bold(label)} ${config.kind === 'task' ? 'completed' : 'ready'} ${timing}`);

      managed.ready.resolve(true);
      startup.resolve({ id: config.id, ok: true });

      if (config.kind === 'task') return 'done';

      if (config.open && this.options.openBrowser) {
        void openUrl(config.open);
      }

      // Ready: now just watch for an unexpected exit.
      const info = await exit.promise;

      if (this.shuttingDown || managed.stopping) {
        this.setStatus(config.id, 'stopped', 'stopped by warpline');
        return 'done';
      }

      const crashed = info.code !== 0;
      const willRestart = this.shouldRestart(managed, crashed);
      const how = info.signal ? `signal ${info.signal}` : `exit code ${info.code ?? 'unknown'}`;

      if (willRestart) {
        managed.attempt += 1;
        managed.runtime.restarts += 1;
        const delay = this.backoffFor(managed);
        this.log(
          theme.warn(
            `${glyph.warn} ${theme.bold(label)} exited (${how}); restarting in ${formatDuration(delay)} (attempt ${managed.attempt}/${config.maxRestarts})`,
          ),
        );
        this.options.logger.note(config.id, `exited with ${how}; restarting`);
        this.setStatus(config.id, 'starting', `restarting after ${how}`);
        await sleep(delay);
        if (this.shuttingDown) {
          this.setStatus(config.id, 'stopped', 'shutdown during restart backoff');
          return 'done';
        }
        return 'retry';
      }

      const status: ProcessStatus = crashed ? 'failed' : 'stopped';
      this.setStatus(config.id, status, `exited with ${how}`);
      this.log(
        crashed
          ? theme.err(`${glyph.fail} ${theme.bold(label)} exited (${how})`)
          : theme.dim(`${glyph.dot} ${label} exited cleanly`),
      );

      if (crashed && !this.options.keepGoing && !this.shuttingDown) {
        // A crashed service after startup should not leave a half-dead project
        // sitting there pretending to work.
        void this.stopAll('a process crashed');
      }
      return 'done';
    }

    // Not ready. Decide between retrying and giving up.
    const stillAlive = managed.runtime.pid !== undefined;
    if (stillAlive) {
      // A readiness timeout on a live process is almost always a config or app
      // problem, so it is not retried: retrying would just wait twice as long
      // for the same failure.
      this.options.logger.note(config.id, `readiness failed: ${outcome.reason}; stopping`);
      managed.stopping = true;
      await terminateTree(managed.runtime.pid, { graceMs: config.stopTimeoutMs });
    }

    const exitedNonZero = !stillAlive;
    if (exitedNonZero && this.shouldRestart(managed, true) && !this.shuttingDown) {
      managed.attempt += 1;
      managed.runtime.restarts += 1;
      const delay = this.backoffFor(managed);
      this.log(
        theme.warn(
          `${glyph.warn} ${theme.bold(label)} failed to start (${outcome.reason}); retrying in ${formatDuration(delay)} (attempt ${managed.attempt}/${config.maxRestarts})`,
        ),
      );
      await sleep(delay);
      if (!this.shuttingDown) return 'retry';
    }

    this.setStatus(config.id, 'failed', outcome.reason);
    this.log(`${theme.err(glyph.fail)} ${theme.bold(label)} ${theme.err('failed')} ${theme.dim(`- ${outcome.reason}`)}`);

    const tail = this.options.logger.tail(config.id, 12);
    if (tail.length > 0 && !this.options.quiet) {
      process.stderr.write(theme.dim(`  last output from ${label}:\n`));
      for (const line of tail) process.stderr.write(theme.dim(`    ${line}\n`));
    }

    managed.ready.resolve(false);
    startup.resolve({ id: config.id, ok: false, reason: outcome.reason });
    return 'done';
  }

  private shouldRestart(managed: Managed, crashed: boolean): boolean {
    const { restart, maxRestarts } = managed.config;
    if (this.shuttingDown) return false;
    if (managed.attempt >= maxRestarts) return false;
    if (restart === 'always') return true;
    if (restart === 'on-failure') return crashed;
    return false;
  }

  /** Exponential backoff, capped so a persistently failing process is not hammered. */
  private backoffFor(managed: Managed): number {
    const base = managed.config.backoffMs;
    return Math.min(base * 2 ** Math.max(0, managed.attempt - 1), 30_000);
  }

  /**
   * Stops everything in reverse dependency order, so a service is never left
   * talking to a database that has already gone away.
   */
  async stopAll(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.abort.abort();

    this.log('');
    this.log(theme.dim(`${glyph.arrow} stopping (${reason})`));

    const order = shutdownOrder(this.options.processes);

    for (const config of order) {
      const managed = this.managed.get(config.id);
      if (!managed) continue;
      const pid = managed.runtime.pid;

      // Unblock anything still waiting on this process so its supervise() loop
      // can observe the shutdown instead of hanging.
      managed.ready.resolve(false);

      if (pid === undefined) {
        if (managed.runtime.status === 'pending' || managed.runtime.status === 'starting') {
          this.setStatus(config.id, 'stopped', `never started (${reason})`);
        }
        continue;
      }

      managed.stopping = true;
      const result = await terminateTree(pid, { graceMs: config.stopTimeoutMs });
      this.setStatus(config.id, 'stopped', result.forced ? 'force killed after grace period' : 'stopped');
      this.log(
        result.forced
          ? theme.warn(`  ${glyph.warn} ${config.label} force killed`)
          : theme.dim(`  ${glyph.dot} ${config.label} stopped`),
      );
    }

    await this.runHooks('cleanup');
    writeRuntime(this.runtime);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Snapshot used for the post-start summary. */
  summary(): Array<{ id: string; label: string; status: ProcessStatus; ports: number[]; pid: number | undefined }> {
    return [...this.managed.values()].map((managed) => ({
      id: managed.config.id,
      label: managed.config.label,
      status: managed.runtime.status,
      ports: managed.runtime.ports,
      pid: managed.runtime.pid,
    }));
  }
}
