import fs from 'node:fs';
import { isPortListening } from './ports.js';
import type { ReadyProbe } from '../config/types.js';

export interface ReadyOutcome {
  ready: boolean;
  /** Why the probe concluded what it did, for logs and failure messages. */
  reason: string;
  elapsedMs: number;
}

export interface ReadinessWaiter {
  /** Feed child output in so a `log` probe can match against it. */
  onOutput(text: string): void;
  /**
   * Resolves once the probe is satisfied, the deadline passes, or `exited`
   * settles first (a process that died can never become ready).
   */
  wait(input: { exited: Promise<{ code: number | null; signal: string | null }>; aborted: AbortSignal }): Promise<ReadyOutcome>;
  describe(): string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface CancellableTimeout<T> {
  promise: Promise<T>;
  cancel(): void;
}

/**
 * A timeout that can be cancelled once it loses a race.
 *
 * `Promise.race` settles on the first result but never cancels the losers, so a
 * bare `setTimeout` for a 90-second probe budget keeps its timer armed even
 * after the process it was watching has already exited. Node then refuses to
 * exit until that timer fires, which turns an instant failure into a 90-second
 * hang. Every long timeout in this module is cancelled explicitly.
 */
function createTimeout<T>(ms: number, value: T): CancellableTimeout<T> {
  let handle: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((resolve) => {
    handle = setTimeout(() => resolve(value), ms);
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/**
 * Turns a declared probe into something the supervisor can await.
 *
 * Readiness is the feature that makes dependency ordering real. Without it,
 * `needs: [api]` can only mean "the api process was spawned", which is almost
 * never what the author intended -- a migration that runs the instant Postgres'
 * PID exists still fails. With it, `needs` means "the dependency is actually
 * answering", and the arbitrary `sleep` calls disappear.
 */
export function createReadinessWaiter(probe: ReadyProbe): ReadinessWaiter {
  const logHit = deferred<void>();
  const pattern = probe.logPattern ? new RegExp(probe.logPattern, 'i') : undefined;
  let matched = false;
  let buffer = '';

  const describe = (): string => {
    switch (probe.kind) {
      case 'port':
        return `port ${probe.host ?? '127.0.0.1'}:${probe.port}`;
      case 'http':
        return `HTTP ${probe.url}`;
      case 'log':
        return `log match /${probe.logPattern}/i`;
      case 'file':
        return `file ${probe.file}`;
      case 'exit':
        return 'must exit 0';
      case 'settle':
        return `stays alive ${probe.settleMs ?? 400}ms`;
      default:
        return 'no readiness check';
    }
  };

  return {
    describe,

    onOutput(text: string): void {
      if (!pattern || matched) return;
      // Keep a small trailing window so a pattern split across two chunks
      // still matches, without retaining the entire output history.
      buffer += text;
      if (pattern.test(buffer)) {
        matched = true;
        logHit.resolve();
      }
      buffer = buffer.slice(-8192);
    },

    async wait({ exited, aborted }): Promise<ReadyOutcome> {
      const startedAt = Date.now();
      const elapsed = (): number => Date.now() - startedAt;

      if (aborted.aborted) {
        return { ready: false, reason: 'startup aborted', elapsedMs: elapsed() };
      }

      if (probe.kind === 'none') {
        return { ready: true, reason: 'no readiness check declared', elapsedMs: 0 };
      }

      // A process that exits can only be "ready" if exiting was the goal.
      const exitRace = exited.then((result) => ({ kind: 'exit' as const, result }));

      if (probe.kind === 'exit') {
        const timeout = createTimeout(probe.timeoutMs, { kind: 'timeout' as const });
        try {
          const outcome = await raceWithAbort([exitRace, timeout.promise], aborted);
          if (outcome.kind === 'aborted') {
            return { ready: false, reason: 'startup aborted', elapsedMs: elapsed() };
          }
          if (outcome.kind === 'timeout') {
            return { ready: false, reason: `did not finish within ${probe.timeoutMs}ms`, elapsedMs: elapsed() };
          }
          const { code, signal } = outcome.result;
          if (code === 0) return { ready: true, reason: 'completed successfully', elapsedMs: elapsed() };
          return {
            ready: false,
            reason: signal ? `killed by ${signal}` : `exited with code ${code ?? 'unknown'}`,
            elapsedMs: elapsed(),
          };
        } finally {
          timeout.cancel();
        }
      }

      if (probe.kind === 'settle') {
        const settleMs = probe.settleMs ?? 400;
        const settle = createTimeout(settleMs, { kind: 'settled' as const });
        try {
          const outcome = await raceWithAbort([exitRace, settle.promise], aborted);
          if (outcome.kind === 'aborted') {
            return { ready: false, reason: 'startup aborted', elapsedMs: elapsed() };
          }
          if (outcome.kind === 'exit') {
            const { code, signal } = outcome.result;
            return {
              ready: false,
              reason: signal
                ? `exited immediately (${signal})`
                : `exited immediately with code ${code ?? 'unknown'}`,
              elapsedMs: elapsed(),
            };
          }
          return { ready: true, reason: `stayed alive for ${settleMs}ms`, elapsedMs: elapsed() };
        } finally {
          settle.cancel();
        }
      }

      if (probe.kind === 'log') {
        const timeout = createTimeout(probe.timeoutMs, { kind: 'timeout' as const });
        try {
          const hit = logHit.promise.then(() => ({ kind: 'hit' as const }));
          const outcome = await raceWithAbort([exitRace, hit, timeout.promise], aborted);
          if (outcome.kind === 'aborted') {
            return { ready: false, reason: 'startup aborted', elapsedMs: elapsed() };
          }
          if (outcome.kind === 'hit') {
            return { ready: true, reason: `matched /${probe.logPattern}/i`, elapsedMs: elapsed() };
          }
          if (outcome.kind === 'exit') {
            const { code, signal } = outcome.result;
            return {
              ready: false,
              reason: signal
                ? `exited (${signal}) before logging readiness`
                : `exited with code ${code ?? 'unknown'} before logging readiness`,
              elapsedMs: elapsed(),
            };
          }
          return {
            ready: false,
            reason: `no log line matched /${probe.logPattern}/i within ${probe.timeoutMs}ms`,
            elapsedMs: elapsed(),
          };
        } finally {
          timeout.cancel();
        }
      }

      // Polling probes: port, http, file.
      const controller = new AbortController();
      const cancel = () => controller.abort();
      aborted.addEventListener('abort', cancel, { once: true });
      const timeout = createTimeout(probe.timeoutMs, { kind: 'timeout' as const });
      const polling = async (): Promise<{ kind: 'ready' | 'aborted' }> => {
        for (;;) {
          if (controller.signal.aborted) return { kind: 'aborted' };
          if (await pollOnce(probe, controller.signal)) return { kind: 'ready' };
          if (controller.signal.aborted) return { kind: 'aborted' };
          const pause = createTimeout(probe.intervalMs, undefined);
          try {
            await raceWithAbort([pause.promise], controller.signal);
          } finally {
            pause.cancel();
          }
        }
      };
      try {
        const outcome = await raceWithAbort([exitRace, timeout.promise, polling()], aborted);
        if (outcome.kind === 'aborted') {
          return { ready: false, reason: 'startup aborted', elapsedMs: elapsed() };
        }
        if (outcome.kind === 'ready') {
          return { ready: true, reason: `${describe()} responded`, elapsedMs: elapsed() };
        }
        if (outcome.kind === 'exit') {
          const { code, signal } = outcome.result;
          return { ready: false, reason: signal
            ? `exited (${signal}) before ${describe()} responded`
            : `exited with code ${code ?? 'unknown'} before ${describe()} responded`, elapsedMs: elapsed() };
        }
        return { ready: false, reason: `${describe()} did not respond within ${probe.timeoutMs}ms`, elapsedMs: elapsed() };
      } finally {
        timeout.cancel();
        controller.abort();
        aborted.removeEventListener('abort', cancel);
      }

    },
  };
}

async function pollOnce(probe: ReadyProbe, signal: AbortSignal): Promise<boolean> {
  switch (probe.kind) {
    case 'port':
      return probe.port === undefined ? true : isPortListening(probe.port, probe.host ?? '127.0.0.1', 400, signal);
    case 'file':
      if (!probe.file) return true;
      try {
        return fs.existsSync(probe.file);
      } catch {
        return false;
      }
    case 'http':
      return probeHttp(probe, signal);
    default:
      return true;
  }
}

async function probeHttp(probe: ReadyProbe, signal: AbortSignal): Promise<boolean> {
  if (!probe.url) return true;
  const maxStatus = probe.maxStatus ?? 499;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => controller.abort(), Math.min(probe.intervalMs * 8, 5000));

  try {
    const response = await fetch(probe.url, {
      signal: controller.signal,
      redirect: 'manual',
      // A dev server answering 404 is still "up", so the default ceiling is
      // deliberately generous; tighten it with `ready.status`.
      headers: { 'user-agent': 'warpline-readiness' },
    });

    // The body is never wanted, only the status. Undici holds the connection open
    // until the body is read or cancelled, and this runs on a poll loop, so
    // leaving it dangling leaks a socket per attempt for the whole probe budget.
    try {
      await response.body?.cancel();
    } catch {
      /* already closed or errored; nothing to release */
    }

    return response.status <= maxStatus;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

/** Remove the listener even when exit or readiness wins the race. */
async function raceWithAbort<T extends readonly unknown[]>(promises: T, signal: AbortSignal): Promise<Awaited<T[number]> | { kind: 'aborted' }> {
  let onAbort!: () => void;
  const cancellation = new Promise<{ kind: 'aborted' }>((resolve) => {
    onAbort = () => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([...promises, cancellation]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
