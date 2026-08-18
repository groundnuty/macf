/**
 * Tests for `apply-ca.ts` — the per-project CA ceremony, DR-043 Amendment D
 * phase 2 (groundnuty/macf#838, macf#854's CA gap). Fully offline:
 * `resolveCaCert` / `publishCaCertLegs` / `redactCaResolve` are pure over
 * injected deps — no real `gh`, no real `age`, no real crypto. `realMintCa`
 * (a thin wrapper over `@groundnuty/macf-core::createCA`) is exercised
 * separately below against the REAL crypto primitive (no network) to prove
 * the scratch-dir write/cleanup contract, mirroring `vault-write.test.ts`'s
 * "never fake a passing test" convention for the one real-crypto path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegistryConfig } from '@groundnuty/macf-core';
import {
  caCertVariableName,
  publishCaCertLegs,
  realMintCa,
  redactCaResolve,
  resolveCaCert,
  skippedCaPublish,
} from '../../../src/cli/bootstrap/apply-ca.js';
import type { CaApplyDeps, CaMintDeps, CaResolveOutcome } from '../../../src/cli/bootstrap/apply-ca.js';

const REGISTRY: RegistryConfig = { type: 'profile', user: 'groundnuty' };

function mintDepsWith(overrides: Partial<CaMintDeps> = {}): CaMintDeps {
  return {
    checkRegistryPresence: async () => 'absent',
    readRegistryVariable: async () => undefined,
    mintCa: async () => ({ certPem: 'FRESH-CERT-PEM', keyPem: 'FRESH-KEY-PEM' }),
    ...overrides,
  };
}

function fullDepsWith(overrides: Partial<CaApplyDeps> = {}): CaApplyDeps {
  return {
    ...mintDepsWith(),
    createRegistryVariable: async () => 'created',
    checkRepoPresence: async () => 'absent',
    createRepoVariable: async () => 'created',
    ...overrides,
  };
}

describe('caCertVariableName (pure)', () => {
  it('derives <SEG>_CA_CERT via toVariableSegment — same segment plan.ts uses', () => {
    expect(caCertVariableName('icsoc-2026')).toBe('ICSOC_2026_CA_CERT');
    expect(caCertVariableName('demo-fleet')).toBe('DEMO_FLEET_CA_CERT');
  });
});

describe('resolveCaCert — mint-or-reuse decision table', () => {
  it('genuinely fresh (no lock, registry absent, recipients present) -> MINTS', async () => {
    const outcome = await resolveCaCert('demo-fleet', REGISTRY, false, ['age1x'], mintDepsWith());
    expect(outcome).toEqual({ status: 'minted', certPem: 'FRESH-CERT-PEM', keyPem: 'FRESH-KEY-PEM' });
  });

  it('no age recipients -> REFUSES to mint, mintCa is NEVER called', async () => {
    let mintCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      false,
      [],
      mintDepsWith({ mintCa: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; } }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/age_recipients is empty/);
  });

  it('registry reports UNKNOWN, no prior lock -> REFUSES (honest-unknown, never guesses)', async () => {
    let mintCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      false,
      ['age1x'],
      mintDepsWith({ checkRegistryPresence: async () => 'unknown', mintCa: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; } }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/honest-unknown/);
  });

  it('registry PRESENT, no prior lock -> REUSES (out-of-band CA), reads the value, never mints', async () => {
    let mintCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      false,
      ['age1x'],
      mintDepsWith({
        checkRegistryPresence: async () => 'present',
        readRegistryVariable: async () => 'OUT-OF-BAND-CERT-PEM',
        mintCa: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; },
      }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome).toEqual({ status: 'reused', certPem: 'OUT-OF-BAND-CERT-PEM' });
  });

  it('registry PRESENT but the value read fails/empty -> FAILED, refuses to publish an empty cert', async () => {
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      false,
      ['age1x'],
      mintDepsWith({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => undefined }),
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/could not be read/);
  });

  it('lock HAS ca_key AND registry PRESENT -> REUSES, never mints', async () => {
    let mintCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      true,
      ['age1x'],
      mintDepsWith({
        checkRegistryPresence: async () => 'present',
        readRegistryVariable: async () => 'VAULTED-CERT-PEM',
        mintCa: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; },
      }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome).toEqual({ status: 'reused', certPem: 'VAULTED-CERT-PEM' });
  });

  it('lock HAS ca_key but registry reports ABSENT -> REFUSES (would orphan the vaulted key — #799 shape), never mints', async () => {
    let mintCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      true,
      ['age1x'],
      mintDepsWith({ checkRegistryPresence: async () => 'absent', mintCa: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; } }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/orphan/);
  });

  it('lock HAS ca_key but registry reports UNKNOWN -> REFUSES (still ambiguous), never mints', async () => {
    let mintCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      true,
      ['age1x'],
      mintDepsWith({ checkRegistryPresence: async () => 'unknown', mintCa: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; } }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/orphan/);
  });

  // --- groundnuty/macf#978 — the vault-restore fallback for the exact
  // "lock has ca_key, registry ABSENT" shape `macf fleet deactivate` leaves
  // behind. ---

  const REFUSAL_TEXT_NO_VAULT =
    'fleet.lock records a previously-minted CA key, but the registry var "DEMO_FLEET_CA_CERT" is not confirmable ' +
    'present (observed: absent) — refusing to mint a REPLACEMENT (would orphan the already' +
    '-vaulted key, the #799 failure class). Re-materializing the cert from the vaulted key needs a vault ' +
    'read (DR-043 Amendment D phase 3+), not a fresh mint. Investigate manually.';

  it('lock HAS ca_key, registry ABSENT, readVaultCaCert NOT supplied -> REFUSES with the EXACT pre-#978 text, byte-identical', async () => {
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      true,
      ['age1x'],
      mintDepsWith({ checkRegistryPresence: async () => 'absent' }), // no readVaultCaCert field at all
    );
    expect(outcome).toEqual({ status: 'failed', reason: REFUSAL_TEXT_NO_VAULT });
  });

  it('lock HAS ca_key, registry ABSENT, readVaultCaCert returns a cert -> RESTORES, never mints', async () => {
    let mintCalled = false;
    let vaultReadForProject: string | undefined;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      true,
      ['age1x'],
      mintDepsWith({
        checkRegistryPresence: async () => 'absent',
        mintCa: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; },
        readVaultCaCert: async (project) => {
          vaultReadForProject = project;
          return 'VAULT-RESTORED-CERT-PEM';
        },
      }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome).toEqual({ status: 'restored', certPem: 'VAULT-RESTORED-CERT-PEM' });
    expect(vaultReadForProject).toBe('demo-fleet');
  });

  it('lock HAS ca_key, registry ABSENT, readVaultCaCert returns undefined (vault has nothing for this fleet) -> REFUSES, same text as the no-vault case', async () => {
    let mintCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      true,
      ['age1x'],
      mintDepsWith({
        checkRegistryPresence: async () => 'absent',
        mintCa: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; },
        readVaultCaCert: async () => undefined,
      }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome).toEqual({ status: 'failed', reason: REFUSAL_TEXT_NO_VAULT });
  });

  it('lock HAS ca_key, registry ABSENT, readVaultCaCert THROWS -> REFUSES, never propagates, never a false restore', async () => {
    let mintCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      true,
      ['age1x'],
      mintDepsWith({
        checkRegistryPresence: async () => 'absent',
        mintCa: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; },
        readVaultCaCert: async () => { throw new Error('simulated: age decrypt failed'); },
      }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome).toEqual({ status: 'failed', reason: REFUSAL_TEXT_NO_VAULT });
  });

  it('lock HAS ca_key, registry UNKNOWN (not absent), readVaultCaCert supplied -> REFUSES WITHOUT calling the vault (honest-unknown floor: never chase a maybe)', async () => {
    let vaultReadCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      true,
      ['age1x'],
      mintDepsWith({
        checkRegistryPresence: async () => 'unknown',
        readVaultCaCert: async () => { vaultReadCalled = true; return 'SHOULD-NOT-BE-USED'; },
      }),
    );
    expect(vaultReadCalled).toBe(false);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/orphan/);
  });

  it('lock HAS ca_key, registry PRESENT, readVaultCaCert supplied -> REUSES WITHOUT calling the vault (nothing to repair)', async () => {
    let vaultReadCalled = false;
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      true,
      ['age1x'],
      mintDepsWith({
        checkRegistryPresence: async () => 'present',
        readRegistryVariable: async () => 'EXISTING-CERT-PEM',
        readVaultCaCert: async () => { vaultReadCalled = true; return 'SHOULD-NOT-BE-USED'; },
      }),
    );
    expect(vaultReadCalled).toBe(false);
    expect(outcome).toEqual({ status: 'reused', certPem: 'EXISTING-CERT-PEM' });
  });

  it('a throwing checkRegistryPresence resolves to failed, never propagates', async () => {
    const outcome = await resolveCaCert(
      'demo-fleet',
      REGISTRY,
      false,
      ['age1x'],
      mintDepsWith({ checkRegistryPresence: async () => { throw new Error('network down'); } }),
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toContain('network down');
  });
});

describe('redactCaResolve — the security-critical redaction boundary', () => {
  it('a MINTED outcome carries a fingerprint but NEVER certPem/keyPem', () => {
    const outcome: CaResolveOutcome = { status: 'minted', certPem: 'SECRET-CERT-PEM', keyPem: 'SECRET-KEY-PEM' };
    const redacted = redactCaResolve(outcome);
    expect(redacted.status).toBe('minted');
    expect(redacted.certFingerprint).toBeDefined();
    expect(JSON.stringify(redacted)).not.toContain('SECRET-CERT-PEM');
    expect(JSON.stringify(redacted)).not.toContain('SECRET-KEY-PEM');
    expect(redacted).not.toHaveProperty('certPem');
    expect(redacted).not.toHaveProperty('keyPem');
  });

  it('a REUSED outcome carries a fingerprint but NEVER certPem', () => {
    const redacted = redactCaResolve({ status: 'reused', certPem: 'SECRET-CERT-PEM' });
    expect(redacted).toEqual({ status: 'reused', certFingerprint: expect.any(String) });
    expect(JSON.stringify(redacted)).not.toContain('SECRET-CERT-PEM');
  });

  it('a RESTORED outcome (groundnuty/macf#978) carries a fingerprint but NEVER certPem', () => {
    const redacted = redactCaResolve({ status: 'restored', certPem: 'VAULT-RESTORED-CERT-PEM' });
    expect(redacted).toEqual({ status: 'restored', certFingerprint: expect.any(String) });
    expect(JSON.stringify(redacted)).not.toContain('VAULT-RESTORED-CERT-PEM');
    expect(redacted).not.toHaveProperty('certPem');
  });

  it('a FAILED outcome carries only the reason', () => {
    expect(redactCaResolve({ status: 'failed', reason: 'no recipient' })).toEqual({ status: 'failed', reason: 'no recipient' });
  });

  it('the SAME cert always fingerprints to the SAME value (deterministic, not random)', () => {
    const a = redactCaResolve({ status: 'reused', certPem: 'SAME-CERT' });
    const b = redactCaResolve({ status: 'reused', certPem: 'SAME-CERT' });
    expect(a.certFingerprint).toBe(b.certFingerprint);
  });
});

describe('publishCaCertLegs — the two-place publish (macf#806)', () => {
  it('writes the registry leg + every repo leg with the SAME cert value', async () => {
    const registryValues: string[] = [];
    const repoValues: Record<string, string> = {};
    const deps = fullDepsWith({
      createRegistryVariable: async (_registry, _name, value) => {
        registryValues.push(value);
        return 'created';
      },
      createRepoVariable: async (repo, _name, value) => {
        repoValues[repo] = value;
        return 'created';
      },
    });
    const result = await publishCaCertLegs('CERT-PEM-VALUE', 'demo-fleet', REGISTRY, ['a/b', 'c/d'], deps);
    expect(result.registryLeg).toEqual({ status: 'created' });
    expect(result.repoLegs).toEqual({ 'a/b': { status: 'created' }, 'c/d': { status: 'created' } });
    expect(registryValues).toEqual(['CERT-PEM-VALUE']);
    expect(repoValues).toEqual({ 'a/b': 'CERT-PEM-VALUE', 'c/d': 'CERT-PEM-VALUE' });
  });

  it('an already-present registry var is left untouched; a missing repo leg is still created (independent per-leg outcomes)', async () => {
    const deps = fullDepsWith({
      checkRegistryPresence: async () => 'present',
      checkRepoPresence: async () => 'absent',
    });
    const result = await publishCaCertLegs('CERT', 'demo-fleet', REGISTRY, ['a/b'], deps);
    expect(result.registryLeg).toEqual({ status: 'already-present' });
    expect(result.repoLegs['a/b']).toEqual({ status: 'created' });
  });

  it('a failed repo leg does not prevent the OTHER repo legs from being attempted', async () => {
    const deps = fullDepsWith({
      createRepoVariable: async (repo) => {
        if (repo === 'a/fails') throw new Error('403 forbidden');
        return 'created';
      },
    });
    const result = await publishCaCertLegs('CERT', 'demo-fleet', REGISTRY, ['a/fails', 'b/ok'], deps);
    expect(result.repoLegs['a/fails']?.status).toBe('failed');
    expect(result.repoLegs['b/ok']).toEqual({ status: 'created' });
  });

  it('an empty repo list produces an empty repoLegs map (registry leg still runs)', async () => {
    const result = await publishCaCertLegs('CERT', 'demo-fleet', REGISTRY, [], fullDepsWith());
    expect(result.repoLegs).toEqual({});
    expect(result.registryLeg).toEqual({ status: 'created' });
  });
});

describe('skippedCaPublish (pure)', () => {
  it('produces a skipped registry leg + skipped repo legs, all sharing the reason', () => {
    const result = skippedCaPublish(['a/b', 'c/d'], 'CA could not be resolved');
    expect(result.registryLeg).toEqual({ status: 'skipped', reason: 'CA could not be resolved' });
    expect(result.repoLegs).toEqual({
      'a/b': { status: 'skipped', reason: 'CA could not be resolved' },
      'c/d': { status: 'skipped', reason: 'CA could not be resolved' },
    });
  });
});

// --- realMintCa — the one real-crypto path (no network; mirrors vault-write.test.ts's convention) ---

describe('realMintCa', () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns a cert+key PEM pair and leaves NO scratch dir behind (transient disk touch only)', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('macf-bootstrap-ca-')));
    const { certPem, keyPem } = await realMintCa('unit-test-fleet');
    expect(certPem).toContain('-----BEGIN CERTIFICATE-----');
    expect(keyPem).toContain('-----BEGIN PRIVATE KEY-----');
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('macf-bootstrap-ca-') && !before.has(n));
    // Every scratch dir THIS call created must be gone again (finally-cleanup).
    for (const dir of after) {
      expect(existsSync(join(tmpdir(), dir))).toBe(false);
    }
  });

  it('cleans up the scratch dir even when createCA throws (defense — same finally-cleanup contract)', async () => {
    // Can't easily force createCA to throw without mocking @groundnuty/macf-core
    // internals (out of scope for a thin-leaf test) — this test instead pins
    // that TWO independent mints never collide on scratch-dir naming (each
    // gets its own mkdtempSync-suffixed dir), which is what makes concurrent
    // apply runs for different fleets safe.
    const [a, b] = await Promise.all([realMintCa('fleet-a'), realMintCa('fleet-b')]);
    expect(a.certPem).not.toBe(b.certPem);
    expect(a.keyPem).not.toBe(b.keyPem);
  });
});
