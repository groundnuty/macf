/**
 * Shared local/CI gating for tests that require the real `age` / `age-keygen`
 * binaries — the vault custody assertions (DR-043 §D, groundnuty/macf#963).
 *
 * These tests are gated `it.skipIf(!HAS_AGE)` rather than faked, per the
 * "never fake a passing test" convention (macf#852): a mocked `age` would
 * pass whether or not the vault was actually rewritten, so the property
 * these tests exist to prove — most critically, that re-encryption does
 * not silently widen the recipient set (macf#958's three-keypair
 * recipient-reconciliation test) — has to run against the real binary or
 * not run at all.
 *
 * A skipped test and a passing test are indistinguishable in the run
 * summary line, which is itself the defect #963 exists to close: `age` was
 * absent from `devbox.json`, so every gated test silently skipped in CI
 * while reporting green. This module makes that impossible to miss going
 * forward:
 *
 *   - **Locally**, absence of `age` WARNS loudly, naming exactly how many
 *     decisive tests the calling file is about to skip. This writes
 *     directly via `process.stderr.write` rather than `console.warn`
 *     DELIBERATELY: Vitest's default reporter captures + suppresses
 *     `console.*` output for a passing test file (verified empirically —
 *     a bare module-scope `console.warn` never reached the terminal
 *     without `--reporter=verbose`), which would silently recreate the
 *     exact defect this module exists to close. A direct stderr write
 *     bypasses that capture and is visible under every reporter,
 *     including the plain `make -f dev.mk test` / `npm test` invocation
 *     a developer actually runs.
 *   - **In CI** (`process.env.CI` set to anything other than `'false'`/`'0'`
 *     — see `isCi()` below), absence of `age` THROWS at module-evaluation
 *     time — the whole file fails loud instead of quietly shedding its
 *     most load-bearing assertions. `age` now ships via `devbox.json`, so
 *     this should never actually fire in CI; it exists as a
 *     defense-in-depth catch for devbox drift (a package silently dropped
 *     from `devbox.json` in a future edit).
 *
 * Callers compute `HAS_AGE` once at module scope, immediately after
 * counting how many `it.skipIf(!HAS_AGE)` sites the file declares:
 *
 * ```ts
 * import { resolveAgeGate } from './age-binary-gate.js';
 * const HAS_AGE = resolveAgeGate('vault-write.test.ts', 4);
 * ```
 */
import { spawnSync } from 'node:child_process';

function commandExists(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).status === 0;
}

// `process.env.CI` is a string, so a bare truthiness check would treat an
// explicit `CI=false` (a real convention some tools honor) as CI — the
// opposite of the caller's intent. Only 'false'/'0' opt back out.
function isCi(): boolean {
  const ci = process.env.CI;
  return !!ci && ci !== 'false' && ci !== '0';
}

/**
 * Resolve whether the real `age` + `age-keygen` binaries are on PATH,
 * enforcing the loud-skip (local) / fail-loud (CI) contract described in
 * this module's header.
 *
 * @param sourceFile - the calling test file's own name, for the diagnostic
 * @param decisiveTestCount - how many `it.skipIf(!HAS_AGE)` tests that file
 *   is about to skip if this resolves to `false`
 * @returns `true` when both binaries are present; `false` when absent and
 *   running outside CI (never returns `false` inside CI — it throws instead)
 */
export function resolveAgeGate(sourceFile: string, decisiveTestCount: number): boolean {
  const hasAge = commandExists('age') && commandExists('age-keygen');
  if (hasAge) return true;

  const detail =
    `${sourceFile}: 'age'/'age-keygen' not found on PATH — ${decisiveTestCount} decisive ` +
    `real-age test(s) will be SKIPPED. These assert the vault custody boundary ` +
    `(groundnuty/macf#963); a skip here is invisible in a passing summary line.`;

  if (isCi()) {
    throw new Error(
      `[age-binary-gate] ${detail} In CI this is a build failure, not a developer ` +
        `convenience — 'age' ships via devbox.json; check the devbox install step.`,
    );
  }

  // Deliberately process.stderr.write, NOT console.warn — see the module
  // header for why: Vitest's default reporter swallows console output for
  // a file whose tests all pass (skip counts as non-failure), which would
  // make this warning as invisible as the bug it exists to surface.
  process.stderr.write(`[age-binary-gate] ${detail}\n`);
  return false;
}
