/**
 * Wiring-seam assertions for `apply`'s REAL production deps (macf#857 review).
 *
 * **Why this file exists.** The control repo must be committed by the
 * explicit-allowlist primitive (`realControlRepoCommitAndPush`) and NEVER by
 * `git add -A`, because DR-043 Amendment F requires committed control-repo
 * content to be sealed-or-public only — and phase 3 (the vault-read increment)
 * would otherwise auto-commit any decrypted file that landed in that working
 * tree.
 *
 * That fix shipped once already in a broken state: commit `2bbc4c3` added
 * `realControlRepoCommitAndPush` **and its unit tests**, but left
 * `resolveMutateDeps` still wiring the control repo to the `-A` primitive. The
 * security fix was therefore *defined, tested, and never called* — production
 * would have kept using `-A` while every test passed green. A unit test that
 * exercises a primitive against itself structurally cannot catch that; only an
 * assertion through the seam that decides whether it runs can.
 *
 * So these tests assert **identity at the wiring site**, not behaviour of the
 * functions themselves (that is covered by `control-repo-commit.test.ts` and
 * `apply-repo-init-commit.test.ts`). Same family as the repo's other
 * source-shape regression pins (cf. the macf#347 commander-default test).
 */
import { describe, it, expect } from 'vitest';
import { resolveMutateDeps } from '../../../src/cli/commands/bootstrap-apply.js';
import { realControlRepoCommitAndPush } from '../../../src/cli/bootstrap/control-repo.js';
import { realCommitAndPush } from '../../../src/cli/bootstrap/apply-repo-init.js';

describe('apply real-deps wiring (macf#857 — the seam a unit test cannot see)', () => {
  const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml');

  it('wires the CONTROL repo to the explicit-allowlist commit', () => {
    expect(deps.controlRepoDeps.commitAndPush).toBe(realControlRepoCommitAndPush);
  });

  it('does NOT wire the control repo to the `git add -A` commit (the shipped-inert bug)', () => {
    // The literal regression: `2bbc4c3` had this pointing at `realCommitAndPush`.
    expect(deps.controlRepoDeps.commitAndPush).not.toBe(realCommitAndPush);
  });

  it('leaves AGENT repo-init on `git add -A`, which is correct there', () => {
    // Agent repos must stage whatever `repoInit()` generated (agent-config.json,
    // workflows, labels) — the two checkouts have different content invariants,
    // which is why they get two primitives rather than one shared one.
    expect(deps.repoInitDeps.commitAndPush).toBe(realCommitAndPush);
  });

  it('resolveMutateDeps performs no I/O for a nonexistent manifest path', () => {
    // Pins the property that makes calling it in a test safe: it assembles a
    // plain object; nothing runs until a field is invoked.
    expect(() => resolveMutateDeps('/definitely/not/a/real/path/fleet.yaml')).not.toThrow();
  });
});
