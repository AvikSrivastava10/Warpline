import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReadinessWaiter } from '../../src/proc/readiness.js';
import type { ReadyProbe } from '../../src/config/types.js';

const pending = new Promise<{ code: number | null; signal: string | null }>(() => {});
function probe(kind: ReadyProbe['kind']): ReadyProbe {
  return { kind, port: undefined, host: undefined, url: undefined, maxStatus: undefined,
    logPattern: 'READY', file: undefined, settleMs: 90000, timeoutMs: 90000, intervalMs: 250 };
}
afterEach(() => vi.useRealTimers());
describe('readiness cancellation and output', () => {
  it.each(['exit', 'settle', 'log'] as const)('cancels a pending %s probe and clears its timer', async (kind) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = createReadinessWaiter(probe(kind)).wait({ exited: pending, aborted: controller.signal });
    controller.abort();
    await expect(result).resolves.toMatchObject({ ready: false, reason: 'startup aborted' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['exit', 'settle', 'log', 'none', 'file'] as const)('rejects an already aborted %s probe', async (kind) => {
    const controller = new AbortController(); controller.abort();
    await expect(createReadinessWaiter(probe(kind)).wait({ exited: pending, aborted: controller.signal }))
      .resolves.toMatchObject({ ready: false, reason: 'startup aborted' });
  });
  it('checks the beginning of a large output chunk before retaining only its tail', async () => {
    const waiter = createReadinessWaiter(probe('log'));
    waiter.onOutput('READY\n' + 'x'.repeat(10000));
    await expect(waiter.wait({ exited: pending, aborted: new AbortController().signal }))
      .resolves.toMatchObject({ ready: true });
  });
  it('matches a marker split across chunks', async () => {
    const waiter = createReadinessWaiter(probe('log'));
    waiter.onOutput('REA'); waiter.onOutput('DY');
    await expect(waiter.wait({ exited: pending, aborted: new AbortController().signal }))
      .resolves.toMatchObject({ ready: true });
  });
});
