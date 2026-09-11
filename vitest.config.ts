import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    /**
     * Warpline decides colour support and glyph fallbacks once, at module load,
     * from the environment. Pinning both here keeps rendered output stable and
     * diffable instead of varying with whatever terminal ran the suite.
     */
    env: {
      NO_COLOR: '1',
      WARPLINE_ASCII: '1',
    },
    clearMocks: true,
    restoreMocks: true,
    /**
     * One forked child, deliberately.
     *
     * The default is a worker thread per core, and each new V8 isolate reserves
     * a multi-gigabyte heap up front. On a machine or CI container that is short
     * on commit charge rather than on RAM, sixteen of those fail to initialise
     * and V8 reports a fatal out-of-memory while the heap is still under 10MB,
     * which is a thoroughly misleading way to learn about it.
     *
     * These are pure-function tests measured in milliseconds, so parallelism
     * buys nothing here anyway: process startup dominates the run either way.
     * Revisit when the integration tier lands and wall time actually matters.
     *
     * Vitest 4 removed `poolOptions`, so the old `poolOptions.forks.singleFork`
     * is expressed as top-level `maxWorkers`. Worth knowing that the removed
     * form fails silently: it warns, ignores the setting, and reverts to a
     * worker per core.
     */
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
  },
});
