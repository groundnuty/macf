import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Live-smoke config — runs `test/live-smoke/**` only (groundnuty/macf#869).
 *
 * Separate from the default vitest run (which excludes `test/live-smoke/**`
 * in `vitest.config.ts`) because this suite hits the real GitHub API and
 * needs operator-supplied credentials (`MACF_LIVE_SMOKE_*` env vars — see
 * `test/live-smoke/provisioning-live-smoke.test.ts`'s module doc). Every
 * test in the suite is independently `it.skipIf`-gated and skips cleanly
 * (never fails) when its required env vars are absent, so running this
 * command with zero configuration is safe — it just reports all-skipped
 * with a stderr explanation.
 *
 * Used by `npm run test:live-smoke` / `make -f dev.mk test-live-smoke`.
 * Mirrors macf-channel-server's `vitest.integration.config.ts` shape.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@groundnuty/macf-core': resolve(__dirname, '../macf-core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['test/live-smoke/**/*.test.ts'],
    // Network calls to the real GitHub API — generous relative to the
    // default suite's budget, but still bounded so a hung check fails the
    // run instead of hanging CI indefinitely.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
