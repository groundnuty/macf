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
import { realUnarchiveRepo } from '../../../src/cli/bootstrap/repo-archive.js';
import { realCreateRegistryVariable, realCreateRepoVariable, realMintCa } from '../../../src/cli/bootstrap/apply-ca.js';
import { checkRegistryVariablePresence, checkRepoVariablePresence, readRegistryVariable } from '../../../src/cli/bootstrap/observer.js';

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

  // --- DR-043 Amendment G (macf#867) — the revival wiring ---
  //
  // Same "defined, tested, never called" shape: `provisionControlRepo`'s
  // `ours-archived` handling could ship correct and unit-tested while
  // `resolveMutateDeps` left `unarchiveRepo` unwired (a runtime crash on the
  // very first real revival) OR left `confirmUnarchive` unset/false (a
  // silent-forever refusal — the ladder's "free revival" promise unreachable
  // through the CLI even though every underlying primitive works).

  it('wires the control-repo revival primitive to the real unarchive (repo-archive.ts)', () => {
    expect(deps.controlRepoDeps.unarchiveRepo).toBe(realUnarchiveRepo);
  });

  it('sets controlRepoOptions.confirmUnarchive: true — reaching applyFleet already means the operator approved the plan', () => {
    expect(deps.controlRepoOptions?.confirmUnarchive).toBe(true);
  });

  // --- DR-043 Amendment D phase 2 (macf#838) — the CA/routing trustDeps wiring ---
  //
  // Same "defined, tested, never called" shape this file exists to catch
  // (see the module doc) — `apply-ca.ts`'s create-only write primitives
  // could ship correct and unit-tested while `resolveMutateDeps` still wired
  // some OTHER (e.g. upsert) function into production. Pin every field by
  // identity so that class of regression fails HERE, not in the field.

  it('wires the CA registry presence-check to the SAME read plan-time uses (plan and apply agree on "present")', () => {
    expect(deps.trustDeps.checkRegistryPresence).toBe(checkRegistryVariablePresence);
  });

  it('wires the CA registry value-read to observer.ts (never a bot-token upsert client)', () => {
    expect(deps.trustDeps.readRegistryVariable).toBe(readRegistryVariable);
  });

  it('wires the CA registry CREATE to the create-only primitive', () => {
    expect(deps.trustDeps.createRegistryVariable).toBe(realCreateRegistryVariable);
  });

  it('wires the CA/routing repo presence-check to the SAME read plan-time uses', () => {
    expect(deps.trustDeps.checkRepoPresence).toBe(checkRepoVariablePresence);
  });

  it('wires the CA/routing repo CREATE to the create-only primitive', () => {
    expect(deps.trustDeps.createRepoVariable).toBe(realCreateRepoVariable);
  });

  it('wires the CA mint to the real createCA-backed primitive', () => {
    expect(deps.trustDeps.mintCa).toBe(realMintCa);
  });
});
