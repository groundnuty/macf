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
import {
  realControlRepoCommitAndPush,
  checkControlRepoMeta,
  realReadControlFleetLockFile,
  realReadControlManifestFile,
} from '../../../src/cli/bootstrap/control-repo.js';
import { realCommitAndPush } from '../../../src/cli/bootstrap/apply-repo-init.js';
import { realArchiveRepo, realUnarchiveRepo } from '../../../src/cli/bootstrap/repo-archive.js';
import { realDeleteRepo } from '../../../src/cli/bootstrap/repo-destroy.js';
import { realShredAgeIdentity } from '../../../src/cli/bootstrap/age-key-shred.js';
import { realCreateRegistryVariable, realCreateRepoVariable, realMintCa } from '../../../src/cli/bootstrap/apply-ca.js';
import { realDeleteRegistryVariable } from '../../../src/cli/bootstrap/variable-write.js';
import {
  checkRegistryVariablePresence,
  checkRepoSecretPresence,
  checkRepoVariablePresence,
  checkRunnerUsableByRepo,
  readRegistryVariable,
} from '../../../src/cli/bootstrap/observer.js';
import { realMintRoutingClient, realSetRepoSecret } from '../../../src/cli/bootstrap/apply-routing-client.js';
import { resolveDeleteAppsDeps, resolveDestroyDeps } from '../../../src/cli/commands/fleet-teardown-destructive.js';
import { checkAppSlugPresence } from '../../../src/cli/bootstrap/app-identity-removal.js';

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

  // macf#922 — the register-before-route gate: `apply-routing.ts`'s
  // `publishTrustedActors` was defined + unit-tested against a fake, and
  // could ship with `resolveMutateDeps` never wiring the REAL live check in
  // at all (the exact "defined, tested, never called" shape this file
  // exists to catch — see the module doc). macf#924 renamed the wired
  // function from `checkRunnerRegistered` to `checkRunnerUsableByRepo`
  // (org-scope-corrected) — this identity assertion pins the NEW name.
  it('wires the runner-usability check to observer.ts\'s real live gh-api read (register-before-route, macf#922/#924)', () => {
    expect(deps.trustDeps.checkRunnerUsableByRepo).toBe(checkRunnerUsableByRepo);
  });

  // --- groundnuty/macf#920 gap 2 — the routing-client re-mint wiring ---
  //
  // The EXACT "defined, tested, never called" shape this file exists to
  // catch: `apply-routing-client.ts`'s mint/publish primitives shipped
  // correct and unit-tested while `resolveMutateDeps` never wired
  // `routingClientDeps` in at all — the bug this issue fixes. Pin every
  // field by identity so a FUTURE regression of the same class (a primitive
  // defined-but-never-wired) fails HERE, not on a live provision.

  it('wires the routing-client mint to certs.ts::mintRoutingClientCert (reused, never a second issuer)', () => {
    expect(deps.routingClientDeps.mint).toBe(realMintRoutingClient);
  });

  it('wires the routing-client secret presence-check to observer.ts (the SAME read apply\'s publish step + a future plan-time observer would use)', () => {
    expect(deps.routingClientDeps.checkRepoSecretPresence).toBe(checkRepoSecretPresence);
  });

  it('wires the routing-client secret CREATE to the real gh-secret-set-via-stdin primitive', () => {
    expect(deps.routingClientDeps.setRepoSecret).toBe(realSetRepoSecret);
  });

  // --- groundnuty/macf#920 gap 1 — repo-init's tokenSource wiring exists (no npm dep added; asserted for completeness) ---

  it('gap 1: repoInitDeps carries no fake/override repoInit — the REAL commands/repo-init.ts::repoInit runs in production (tokenSource threading is per-agent, at the apply-fleet.ts call site, not a fixed dep here)', () => {
    expect(deps.repoInitDeps.repoInit).toBeUndefined();
  });
});

// --- DR-043 Amendment G, IRREVERSIBLE rungs (macf#867) — delete-apps / destroy wiring ---
//
// Same "defined, tested, never called" shape this file exists to catch (see
// the module doc) — `teardown-destructive.ts`'s primitives could ship
// correct and unit-tested while the command layer's real-deps resolver
// wired the WRONG function (e.g. `realArchiveRepo` where `destroy` needs
// `realDeleteRepo` — a one-word typo away from silently archiving instead
// of deleting, or vice versa, which is exactly the "different blast radii
// must not be one typo apart" hazard Amendment G's own design principle
// names). Pin every field by identity so that class of regression fails
// HERE, not in the field.

describe('fleet delete-apps / destroy real-deps wiring (DR-043 Amendment G, macf#867)', () => {
  const deleteAppsDeps = resolveDeleteAppsDeps();
  const destroyDeps = resolveDestroyDeps();

  it('delete-apps: wires ownership reads to the SAME primitives the reversible rungs + apply use', () => {
    expect(deleteAppsDeps.checkMeta).toBe(checkControlRepoMeta);
    expect(deleteAppsDeps.readManifestFile).toBe(realReadControlManifestFile);
    expect(deleteAppsDeps.checkRegistryPresence).toBe(checkRegistryVariablePresence);
  });

  it('delete-apps: wires the fleet.lock App-ID enrichment read to the real control-repo primitive', () => {
    expect(deleteAppsDeps.readFleetLock).toBe(realReadControlFleetLockFile);
  });

  it('delete-apps: wires registry DELETE to the delete-only primitive (never a create/upsert)', () => {
    expect(deleteAppsDeps.deleteRegistryVariable).toBe(realDeleteRegistryVariable);
  });

  it('delete-apps: wires the repo action to ARCHIVE — never delete (this rung never deletes repos)', () => {
    expect(deleteAppsDeps.archiveRepo).toBe(realArchiveRepo);
  });

  it('delete-apps: wires the App-already-gone presence read to the real live check (groundnuty/macf#917)', () => {
    expect(deleteAppsDeps.checkAppPresence).toBe(checkAppSlugPresence);
  });

  it('destroy: wires ownership reads to the SAME primitives every other rung uses', () => {
    expect(destroyDeps.checkMeta).toBe(checkControlRepoMeta);
    expect(destroyDeps.readManifestFile).toBe(realReadControlManifestFile);
    expect(destroyDeps.checkRegistryPresence).toBe(checkRegistryVariablePresence);
  });

  it('destroy: wires registry DELETE to the delete-only primitive', () => {
    expect(destroyDeps.deleteRegistryVariable).toBe(realDeleteRegistryVariable);
  });

  it('destroy: wires the repo action to DELETE — never archive (the one field a typo could silently downgrade to `delete-apps`\' behavior)', () => {
    expect(destroyDeps.deleteRepo).toBe(realDeleteRepo);
  });

  it('destroy: wires the age-key shred to the REAL shred primitive (called only behind evaluateShredRequest\'s opt-in gate — see teardown-destructive.ts)', () => {
    expect(destroyDeps.shredAgeIdentity).toBe(realShredAgeIdentity);
  });

  it('destroy: wires the fleet.lock App-ID enrichment read to the real control-repo primitive', () => {
    expect(destroyDeps.readFleetLock).toBe(realReadControlFleetLockFile);
  });

  it('destroy: wires the App-already-gone presence read to the real live check (groundnuty/macf#917)', () => {
    expect(destroyDeps.checkAppPresence).toBe(checkAppSlugPresence);
  });
});
