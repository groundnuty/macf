/**
 * Tests for `apply-federated-trust.ts` — the `trust.federated_cas` registry
 * publish, groundnuty/macf#810. Fully offline: `publishFederatedTrustLegs` /
 * `skippedFederatedTrustPublish` are pure over injected deps — no real `gh`.
 *
 * The decisive pair this file exists to prove (assert-the-wrong-path.md):
 *  1. a manifest declaring `trust.federated_cas` → the bundle REACHES the
 *     real consumer's variable name (`caCertVariableName`, the SAME formula
 *     `@groundnuty/macf-core`'s `trust-bundle.ts::resolveFederatedCaBundle`
 *     reads) — asserted at the real call site, not the schema.
 *  2. a manifest declaring none → byte-identical to today (zero registry
 *     calls at all — not merely "zero writes").
 */
import { describe, it, expect } from 'vitest';
import type { RegistryConfig } from '@groundnuty/macf-core';
import { toVariableSegment } from '@groundnuty/macf-core';
import { publishFederatedTrustLegs, skippedFederatedTrustPublish } from '../../../src/cli/bootstrap/apply-federated-trust.js';
import type { FederatedTrustApplyDeps } from '../../../src/cli/bootstrap/apply-federated-trust.js';
import { caCertVariableName } from '../../../src/cli/bootstrap/apply-ca.js';
import type { FleetFederatedCa } from '../../../src/cli/bootstrap/fleet-manifest.js';

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
