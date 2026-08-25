import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // #1140: package-level default, not a per-test inline override — the
    // real production-shaped PBKDF2 round-trip tests in test/certs/ca.test.ts
    // each pay one or two synchronous 600_000-iteration `pbkdf2Sync` calls.
    // Measured COMPLETION time (not a timeout-kill artifact) under real
    // full-suite contention (`vitest run` across all 686 macf-core tests,
    // 2 runs): the 4 affected tests landed at 2.8-5.0s, worst observed
    // 4962ms — at vitest's 5000ms default that one was a coin flip (it did
    // time out in an earlier, more-loaded run) and the rest sat at a bare
    // ~1.1-1.8x margin. Per `test-timeout-discriminator.md`'s corollary,
    // adding four more per-test `{ timeout }` overrides would grow the
    // exact hazard class #1133 closed (inline overrides silently defeat
    // `--testTimeout` from the CLI); a package-level default doesn't have
    // that problem — verified directly: `--testTimeout=1000` on the CLI
    // correctly overrides this 20000 and fails the 4 slow tests, so the
    // CLI flag still wins over this default as documented. 20000ms gives
    // the worst measured completion (4962ms) a ~4.0x margin. Tests whose
    // own cost is the point (the round-trips exercising the REAL 600k-iter
    // production path on purpose) get real headroom here instead of inline
    // overrides; the one test whose cost was incidental (wrong-passphrase
    // throw-rate loop) had its PBKDF2 cost removed at the source instead —
    // see that test's own comment in ca.test.ts. Tradeoff accepted: this
    // also raises the ceiling for a genuinely hung test in this package
    // from 5s to 20s before it fails.
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
