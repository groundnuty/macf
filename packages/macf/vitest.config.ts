import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Redirect `import ... from '@groundnuty/macf-core'` to the sibling workspace's
  // source entry during tests. Without this the resolver would find
  // `dist/index.js` via the workspace symlink, requiring a pre-test
  // build — fragile in watch mode and CI. Runtime (built CLI / server
  // binary) still resolves via normal node_modules workspace linkage
  // to the package's `main` → `dist/index.js`.
  resolve: {
    alias: {
      '@groundnuty/macf-core': resolve(__dirname, '../macf-core/src/index.ts'),
    },
  },
  test: {
    // WHY (groundnuty/macf#1133 class, at the package level): vitest's 5000ms
    // default sits below what several suites here need under parallel load —
    // measured worst case ~2s standalone, but CI runs 191 files concurrently and
    // `make check` passes no --testTimeout, so main itself went red at the default.
    // A package-level default keeps the CLI flag able to override it, unlike the
    // inline `{ timeout: N }` form that #1133 found silently outranks the flag.
    testTimeout: 20000,
    globals: true,
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // `test/live-smoke/**` (groundnuty/macf#869) needs live GitHub
    // credentials + mutates real (throwaway) state — opt-in via
    // `npm run test:live-smoke` / `make -f dev.mk test-live-smoke`, same
    // shape as macf-channel-server's `test/integration/**` exclusion.
    exclude: ['test/e2e/**', 'test/live-smoke/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
