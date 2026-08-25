import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // #1140: package-level default, not a per-test inline override — the
    // real production-shaped PBKDF2 round-trip tests in test/certs/ca.test.ts
    // each pay one or two synchronous 600_000-iteration `pbkdf2Sync` calls
    // (~1.4-3.5s each, measured; this box's load makes a single op swing
    // 2x between runs). At vitest's 5000ms default, four of those tests
    // measured 4.6-6.0s — under budget or timing out outright depending on
    // load. Per `test-timeout-discriminator.md`'s corollary, adding five
    // more per-test `{ timeout }` overrides would grow the exact hazard
    // class #1133 closed (inline overrides silently defeat `--testTimeout`
    // from the CLI); a package-level default doesn't have that problem and
    // `--testTimeout` on the CLI still wins over it. 20000ms gives the
    // worst measured case (~6.0s) a ~3.3x margin. Tests whose own cost is
    // the point (the round-trips exercising the REAL 600k-iter production
    // path on purpose) get real headroom here instead of inline overrides;
    // the one test whose cost was incidental (wrong-passphrase throw-rate
    // loop) had its PBKDF2 cost removed at the source instead — see that
    // test's own comment in ca.test.ts.
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
