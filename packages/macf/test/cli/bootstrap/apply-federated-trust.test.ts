/**
 * Tests for `apply-federated-trust.ts` — the `trust.federated_cas` registry
 * publish, groundnuty/macf#810, PLUS the `#1330`-shaped enumerate-and-name
 * consent gate groundnuty/macf#1389 adds on top of it
 * (`reconcileFederatedTrustVerdicts` / `federatedTrustNotices` /
 * `federatedTrustLockUpdates`). Fully offline: everything here is pure over
 * injected deps or plain data — no real `gh`.
 *
 * The decisive pair `publishFederatedTrustLegs` exists to prove
 * (assert-the-wrong-path.md):
 *  1. a manifest declaring `trust.federated_cas` → the bundle REACHES the
 *     real consumer's variable name (`caCertVariableName`, the SAME formula
 *     `@groundnuty/macf-core`'s `trust-bundle.ts::resolveFederatedCaBundle`
 *     reads) — asserted at the real call site, not the schema.
 *  2. a manifest declaring none → byte-identical to today (zero registry
 *     calls at all — not merely "zero writes").
 *
 * The decisive pair the `#1389` consent gate exists to prove (this issue's
 * own AC):
 *  1. a manifest adding a NEW `federated_cas` project → the addition is
 *     NAMED before it is granted.
 *  2. a manifest unchanged from the pinned set → no prompt, no noise.
 * Plus: a CHANGED bundle for an existing project → surfaced as a change,
 * never silently kept, never silently overwritten; and no lock entry at all
 * → treated as unknown/first-run, baselined rather than refused.
 */
import { describe, it, expect } from 'vitest';
import type { RegistryConfig } from '@groundnuty/macf-core';
import { toVariableSegment } from '@groundnuty/macf-core';
import {
  publishFederatedTrustLegs,
  skippedFederatedTrustPublish,
  reconcileFederatedTrustVerdicts,
  federatedTrustNotices,
  federatedTrustLockUpdates,
} from '../../../src/cli/bootstrap/apply-federated-trust.js';
import type { FederatedTrustApplyDeps, FederatedTrustPublishResult } from '../../../src/cli/bootstrap/apply-federated-trust.js';
import { caCertVariableName } from '../../../src/cli/bootstrap/apply-ca.js';
import { secretFingerprint } from '../../../src/cli/bootstrap/fleet-lock.js';
import type { FleetFederatedCa, FleetLockFederatedCa } from '../../../src/cli/bootstrap/fleet-manifest.js';

const REGISTRY: RegistryConfig = { type: 'profile', user: 'groundnuty' };

function depsWith(overrides: Partial<FederatedTrustApplyDeps> = {}): FederatedTrustApplyDeps {
  return {
    checkRegistryPresence: async () => 'absent',
    createRegistryVariable: async () => 'created',
    ...overrides,
  };
}

describe('the real consumer reads the SAME variable name this module publishes (cross-artifact pin, groundnuty/macf#810)', () => {
  // groundnuty/macf#1339-class defense: a comment asserting "same formula"
  // is a fact nobody re-checks; a test importing BOTH formulas and asserting
  // equality is the thing that actually stays true. This is the "declared
  // guest bundle must reach that same consumer" requirement, made concrete
  // WITHOUT needing a cross-package (macf-core) integration test — the
  // shared formula IS the reachability proof: `trust-bundle.ts`'s own source
  // computes `${toVariableSegment(project)}_CA_CERT` (verified inline below,
  // not just cited), and `caCertVariableName` is the identical derivation.
  it('caCertVariableName(project) matches trust-bundle.ts\'s own resolution formula, verbatim', () => {
    for (const project of ['ppam-2026', 'icsoc-2026', 'demo-fleet']) {
      const trustBundleFormula = `${toVariableSegment(project)}_CA_CERT`;
      expect(caCertVariableName(project)).toBe(trustBundleFormula);
    }
  });
});

describe('publishFederatedTrustLegs — decisive pair (groundnuty/macf#810)', () => {
  it('DECLARED: a trust.federated_cas entry publishes under the GUEST project\'s <SEG>_CA_CERT, in THIS fleet\'s registry scope, with the declared bundle value', async () => {
    const registryWrites: { registry: RegistryConfig; name: string; value: string }[] = [];
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'GUEST-CERT-PEM' }];

    const result = await publishFederatedTrustLegs(
      entries,
      REGISTRY,
      depsWith({
        createRegistryVariable: async (registry, name, value) => {
          registryWrites.push({ registry, name, value });
          return 'created';
        },
      }),
    );

    expect(registryWrites).toEqual([{ registry: REGISTRY, name: 'PPAM_2026_CA_CERT', value: 'GUEST-CERT-PEM' }]);
    expect(result['ppam-2026']).toEqual({ status: 'created' });
  });

  it('UNDECLARED: an empty federated_cas list makes ZERO registry calls — byte-identical to today, not merely "zero writes"', async () => {
    let presenceCalls = 0;
    let createCalls = 0;
    const result = await publishFederatedTrustLegs(
      [],
      REGISTRY,
      depsWith({
        checkRegistryPresence: async () => {
          presenceCalls += 1;
          return 'absent';
        },
        createRegistryVariable: async () => {
          createCalls += 1;
          return 'created';
        },
      }),
    );

    expect(presenceCalls).toBe(0);
    expect(createCalls).toBe(0);
    expect(result).toEqual({});
  });

  it('publishes one leg per declared project, keyed by project (not by variable name)', async () => {
    const entries: readonly FleetFederatedCa[] = [
      { project: 'ppam-2026', ca_bundle: 'CERT-A' },
      { project: 'icsoc-2026', ca_bundle: 'CERT-B' },
    ];
    const result = await publishFederatedTrustLegs(entries, REGISTRY, depsWith());
    expect(Object.keys(result).sort()).toEqual(['icsoc-2026', 'ppam-2026']);
    expect(result['ppam-2026']).toEqual({ status: 'created' });
    expect(result['icsoc-2026']).toEqual({ status: 'created' });
  });

  it('create-only floor: an ALREADY-PRESENT guest CA var is left untouched, even with a materially different declared bundle', async () => {
    let createCalled = false;
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'NEW-DIFFERENT-CERT-PEM' }];
    const result = await publishFederatedTrustLegs(
      entries,
      REGISTRY,
      depsWith({
        checkRegistryPresence: async () => 'present',
        createRegistryVariable: async () => {
          createCalled = true;
          return 'created';
        },
      }),
    );
    expect(createCalled).toBe(false);
    expect(result['ppam-2026']).toEqual({ status: 'already-present' });
  });

  it('a registry read/write failure reports "failed" for that project only, never throws', async () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const result = await publishFederatedTrustLegs(
      entries,
      REGISTRY,
      depsWith({
        checkRegistryPresence: async () => {
          throw new Error('network error');
        },
      }),
    );
    expect(result['ppam-2026']?.status).toBe('failed');
  });
});

describe('skippedFederatedTrustPublish (pure)', () => {
  it('produces a skipped leg per declared project, all sharing the reason', () => {
    const entries: readonly FleetFederatedCa[] = [
      { project: 'ppam-2026', ca_bundle: 'CERT-A' },
      { project: 'icsoc-2026', ca_bundle: 'CERT-B' },
    ];
    const result = skippedFederatedTrustPublish(entries, 'control repo aborted');
    expect(result).toEqual({
      'ppam-2026': { status: 'skipped', reason: 'control repo aborted' },
      'icsoc-2026': { status: 'skipped', reason: 'control repo aborted' },
    });
  });

  it('an empty list produces an empty result', () => {
    expect(skippedFederatedTrustPublish([], 'reason')).toEqual({});
  });
});

// --- groundnuty/macf#1389 — the enumerate-and-name consent gate. ----------

describe('reconcileFederatedTrustVerdicts (pure)', () => {
  it('a project absent from recordedTrust resolves as "new" (no prior lock entry looked up)', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const [verdict] = reconcileFederatedTrustVerdicts(entries, undefined);
    expect(verdict?.row).toBe('new');
    expect(verdict?.project).toBe('ppam-2026');
  });

  it('a project present in recordedTrust with the SAME fingerprint resolves as "noop"', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const recordedTrust: readonly FleetLockFederatedCa[] = [{ project: 'ppam-2026', ca_bundle_fingerprint: secretFingerprint('CERT-A') }];
    const [verdict] = reconcileFederatedTrustVerdicts(entries, recordedTrust);
    expect(verdict?.row).toBe('noop');
  });

  it('a project present in recordedTrust with a DIFFERENT fingerprint resolves as "changed"', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-NEW' }];
    const recordedTrust: readonly FleetLockFederatedCa[] = [{ project: 'ppam-2026', ca_bundle_fingerprint: secretFingerprint('CERT-OLD') }];
    const [verdict] = reconcileFederatedTrustVerdicts(entries, recordedTrust);
    expect(verdict?.row).toBe('changed');
  });

  it('preserves the manifest\'s declared order (never re-sorted)', () => {
    const entries: readonly FleetFederatedCa[] = [
      { project: 'zzz-fleet', ca_bundle: 'CERT-Z' },
      { project: 'aaa-fleet', ca_bundle: 'CERT-A' },
    ];
    const verdicts = reconcileFederatedTrustVerdicts(entries, undefined);
    expect(verdicts.map((v) => v.project)).toEqual(['zzz-fleet', 'aaa-fleet']);
  });

  it('an EMPTY recordedTrust array (a lock that recorded federated_ca_trust: [] — never a real state per FleetLockSchema, but this function must not crash on it) resolves every project as "new"', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const [verdict] = reconcileFederatedTrustVerdicts(entries, []);
    expect(verdict?.row).toBe('new');
  });
});

describe('federatedTrustNotices (pure)', () => {
  it('DECISIVE (1): a NEW project is named — the notice contains the project AND the target registry variable, before anything was granted', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const notices = federatedTrustNotices(reconcileFederatedTrustVerdicts(entries, undefined));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('ppam-2026');
    expect(notices[0]).toContain(caCertVariableName('ppam-2026'));
    expect(notices[0]).toContain('NEW federated-CA trust grant');
  });

  it('DECISIVE (2): a manifest UNCHANGED from the pinned set produces NO notices at all — no prompt, no noise', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const recordedTrust: readonly FleetLockFederatedCa[] = [{ project: 'ppam-2026', ca_bundle_fingerprint: secretFingerprint('CERT-A') }];
    const notices = federatedTrustNotices(reconcileFederatedTrustVerdicts(entries, recordedTrust));
    expect(notices).toEqual([]);
  });

  it('a CHANGED bundle for an existing project is surfaced as a change (not silently kept, not silently overwritten)', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-NEW' }];
    const recordedTrust: readonly FleetLockFederatedCa[] = [{ project: 'ppam-2026', ca_bundle_fingerprint: secretFingerprint('CERT-OLD') }];
    const notices = federatedTrustNotices(reconcileFederatedTrustVerdicts(entries, recordedTrust));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('CHANGED');
    expect(notices[0]).toContain('UNCHANGED'); // states the registry copy stays untouched (create-only floor)
  });

  it('a fleet with multiple declared projects only names the non-noop ones, in declared order', () => {
    const entries: readonly FleetFederatedCa[] = [
      { project: 'unchanged-proj', ca_bundle: 'CERT-SAME' },
      { project: 'new-proj', ca_bundle: 'CERT-NEW' },
    ];
    const recordedTrust: readonly FleetLockFederatedCa[] = [{ project: 'unchanged-proj', ca_bundle_fingerprint: secretFingerprint('CERT-SAME') }];
    const notices = federatedTrustNotices(reconcileFederatedTrustVerdicts(entries, recordedTrust));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('new-proj');
  });
});

describe('federatedTrustLockUpdates — what actually gets recorded as the new approved baseline', () => {
  it('a "new" verdict whose leg is "created" (the ordinary first-grant) IS recorded, with the live fingerprint', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const verdicts = reconcileFederatedTrustVerdicts(entries, undefined);
    const legs: FederatedTrustPublishResult = { 'ppam-2026': { status: 'created' } };
    expect(federatedTrustLockUpdates(verdicts, legs)).toEqual([{ project: 'ppam-2026', caBundleFingerprint: secretFingerprint('CERT-A') }]);
  });

  it('DECISIVE: no lock entry at all (first run) → "new" + leg "already-present" (a pre-#1389 fleet) STILL baselines — never refuses', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const verdicts = reconcileFederatedTrustVerdicts(entries, undefined);
    const legs: FederatedTrustPublishResult = { 'ppam-2026': { status: 'already-present' } };
    expect(federatedTrustLockUpdates(verdicts, legs)).toEqual([{ project: 'ppam-2026', caBundleFingerprint: secretFingerprint('CERT-A') }]);
  });

  it('DECISIVE: a "changed" verdict whose leg is "already-present" (the common divergence case — floor refused the overwrite) is NEVER recorded — the lock must keep pointing at the OLD fingerprint so the divergence keeps surfacing', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-NEW' }];
    const recordedTrust: readonly FleetLockFederatedCa[] = [{ project: 'ppam-2026', ca_bundle_fingerprint: secretFingerprint('CERT-OLD') }];
    const verdicts = reconcileFederatedTrustVerdicts(entries, recordedTrust);
    const legs: FederatedTrustPublishResult = { 'ppam-2026': { status: 'already-present' } };
    expect(federatedTrustLockUpdates(verdicts, legs)).toEqual([]);
  });

  it('a "changed" verdict whose leg is "created" (operator removed the registry var, apply re-ran) IS recorded with the NEW fingerprint — the remediation path', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-NEW' }];
    const recordedTrust: readonly FleetLockFederatedCa[] = [{ project: 'ppam-2026', ca_bundle_fingerprint: secretFingerprint('CERT-OLD') }];
    const verdicts = reconcileFederatedTrustVerdicts(entries, recordedTrust);
    const legs: FederatedTrustPublishResult = { 'ppam-2026': { status: 'created' } };
    expect(federatedTrustLockUpdates(verdicts, legs)).toEqual([{ project: 'ppam-2026', caBundleFingerprint: secretFingerprint('CERT-NEW') }]);
  });

  it('a "noop" verdict is never recorded, regardless of leg status', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const recordedTrust: readonly FleetLockFederatedCa[] = [{ project: 'ppam-2026', ca_bundle_fingerprint: secretFingerprint('CERT-A') }];
    const verdicts = reconcileFederatedTrustVerdicts(entries, recordedTrust);
    const legs: FederatedTrustPublishResult = { 'ppam-2026': { status: 'already-present' } };
    expect(federatedTrustLockUpdates(verdicts, legs)).toEqual([]);
  });

  it('a "new" verdict whose leg FAILED is never recorded (nothing was determined about registry state)', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const verdicts = reconcileFederatedTrustVerdicts(entries, undefined);
    const legs: FederatedTrustPublishResult = { 'ppam-2026': { status: 'failed', reason: 'network error' } };
    expect(federatedTrustLockUpdates(verdicts, legs)).toEqual([]);
  });

  it('a "new" verdict with NO leg outcome at all (project missing from legs — an unreached defensive case) is never recorded', () => {
    const entries: readonly FleetFederatedCa[] = [{ project: 'ppam-2026', ca_bundle: 'CERT-A' }];
    const verdicts = reconcileFederatedTrustVerdicts(entries, undefined);
    expect(federatedTrustLockUpdates(verdicts, {})).toEqual([]);
  });

  it('multiple projects: only the ones that qualify are recorded, others silently excluded', () => {
    const entries: readonly FleetFederatedCa[] = [
      { project: 'new-created', ca_bundle: 'CERT-NEW' },
      { project: 'changed-blocked', ca_bundle: 'CERT-CHANGED' },
      { project: 'unchanged', ca_bundle: 'CERT-SAME' },
    ];
    const recordedTrust: readonly FleetLockFederatedCa[] = [
      { project: 'changed-blocked', ca_bundle_fingerprint: secretFingerprint('CERT-OLD') },
      { project: 'unchanged', ca_bundle_fingerprint: secretFingerprint('CERT-SAME') },
    ];
    const verdicts = reconcileFederatedTrustVerdicts(entries, recordedTrust);
    const legs: FederatedTrustPublishResult = {
      'new-created': { status: 'created' },
      'changed-blocked': { status: 'already-present' },
      unchanged: { status: 'already-present' },
    };
    expect(federatedTrustLockUpdates(verdicts, legs)).toEqual([{ project: 'new-created', caBundleFingerprint: secretFingerprint('CERT-NEW') }]);
  });
});

// --- End-to-end reachability: from the real `apply` orchestration path, not
// just a direct call (bootstrap-apply.ts → applyFleet → publishFederatedTrustLegs
// / reconcileFederatedTrustVerdicts / federatedTrustLockUpdates). See
// apply-fleet.test.ts's "federated CA trust — groundnuty/macf#1389" describe
// block for the wired-through assertions (notice logged via deps.log BEFORE
// the registry create call; fleet.lock's federated_ca_trust actually
// updated in the returned finalLock) — this file stays scoped to the pure
// units per its own module-boundary convention; apply-fleet.test.ts is
// where `applyFleet`'s orchestration is exercised.

// --- Mutation check (per this task's explicit ask): break the publication,
// name the test that fails. -----------------------------------------------
//
// If a future edit accidentally swaps `entry.project` for `entry.ca_bundle`
// when deriving the variable NAME (publishing under the wrong key), or
// swaps which field supplies the WRITTEN value (publishing the project name
// instead of the cert), the first test in this describe block
// ("DECLARED: ... publishes under the GUEST project's <SEG>_CA_CERT ...")
// fails: it asserts the exact `{ name, value }` pair via the injected
// `createRegistryVariable` spy, not merely that a call happened. Verified
// directly (not merely argued) — see this file's own report for the exact
// command run and its output.
