/**
 * Tests for `apply-routing-client.ts` — the routing-client mTLS identity
 * ceremony, DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920 gap 2).
 * Fully offline: `mintRoutingClient` / `publishRoutingClientSecrets` /
 * `skippedRoutingClientPublish` are pure over injected deps — no real `gh`,
 * no real crypto. `buildSetSecretArgs` is pinned as a literal argv array
 * (mirrors `variable-write.test.ts`'s `buildCreateVariableArgs` convention)
 * so the "the value never touches argv" property is verifiable without
 * spawning a real `gh` process — `realSetRepoSecret` itself is a thin
 * `spawn` I/O leaf, untested directly (same posture as `vault-write.ts`'s
 * `ageEncryptToFile`).
 */
import { describe, it, expect } from 'vitest';
import {
  ROUTING_CLIENT_CERT_SECRET_NAME,
  ROUTING_CLIENT_KEY_SECRET_NAME,
  buildSetSecretArgs,
  mintRoutingClient,
  publishRoutingClientSecrets,
  resolveRoutingClientSecretsForPublish,
  skippedRoutingClientPublish,
} from '../../../src/cli/bootstrap/apply-routing-client.js';
import type {
  RoutingClientMintDeps,
  RoutingClientMintOutcome,
  RoutingClientPublishDeps,
  RoutingClientSecretsForPublish,
  RoutingClientVaultRestoreDeps,
} from '../../../src/cli/bootstrap/apply-routing-client.js';

function mintDepsWith(overrides: Partial<RoutingClientMintDeps> = {}): RoutingClientMintDeps {
  return {
    mint: async () => ({ certPem: 'FRESH-ROUTING-CLIENT-CERT-PEM', keyPem: 'FRESH-ROUTING-CLIENT-KEY-PEM' }),
    ...overrides,
  };
}

function publishDepsWith(overrides: Partial<RoutingClientPublishDeps> = {}): RoutingClientPublishDeps {
  return {
    checkRepoSecretPresence: async () => 'absent',
    setRepoSecret: async () => {},
    ...overrides,
  };
}

describe('buildSetSecretArgs (pure)', () => {
  it('never carries the secret VALUE — only argv naming the secret + target repo', () => {
    const args = buildSetSecretArgs('groundnuty/demo', 'ROUTING_CLIENT_KEY');
    expect(args).toEqual(['secret', 'set', 'ROUTING_CLIENT_KEY', '--repo', 'groundnuty/demo']);
    // Defense against a future edit accidentally threading a `value` param in:
    expect(args.join(' ')).not.toMatch(/PEM|-----BEGIN/);
  });

  it('works for both cert and key secret names', () => {
    expect(buildSetSecretArgs('o/r', ROUTING_CLIENT_CERT_SECRET_NAME)).toEqual(['secret', 'set', 'ROUTING_CLIENT_CERT', '--repo', 'o/r']);
    expect(buildSetSecretArgs('o/r', ROUTING_CLIENT_KEY_SECRET_NAME)).toEqual(['secret', 'set', 'ROUTING_CLIENT_KEY', '--repo', 'o/r']);
  });
});

describe('mintRoutingClient — mint-or-skip decision table', () => {
  it('CA freshly minted THIS run, no prior routing-client key -> MINTS, passing the CA cert/key straight through', async () => {
    let seenArgs: { caCertPem: string; caKeyPem: string } | undefined;
    const outcome = await mintRoutingClient(
      'CA-CERT-PEM',
      'CA-KEY-PEM',
      false,
      true,
      mintDepsWith({
        mint: async (caCertPem, caKeyPem) => {
          seenArgs = { caCertPem, caKeyPem };
          return { certPem: 'X-CERT', keyPem: 'X-KEY' };
        },
      }),
    );
    expect(outcome).toEqual({ status: 'minted', certPem: 'X-CERT', keyPem: 'X-KEY' });
    expect(seenArgs).toEqual({ caCertPem: 'CA-CERT-PEM', caKeyPem: 'CA-KEY-PEM' });
  });

  it('a routing-client key is ALREADY vaulted (prior apply run) -> SKIPS, deps.mint is NEVER called (never re-mints)', async () => {
    let mintCalled = false;
    const outcome = await mintRoutingClient('CA-CERT-PEM', 'CA-KEY-PEM', true, true, mintDepsWith({ mint: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; } }));
    expect(mintCalled).toBe(false);
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') expect(outcome.reason).toMatch(/already minted/);
  });

  it('CA was REUSED this run (not minted) -> SKIPS — no CA private key in memory to sign with, deps.mint NEVER called', async () => {
    let mintCalled = false;
    const outcome = await mintRoutingClient(
      'CA-CERT-PEM', // resolveCaCert's 'reused' outcome DOES carry the public cert...
      undefined, // ...but never the key — see apply-fleet.ts's call site.
      false,
      false, // caMintedThisRun: false
      mintDepsWith({ mint: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; } }),
    );
    expect(mintCalled).toBe(false);
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') expect(outcome.reason).toMatch(/not freshly minted/);
  });

  it('CA resolve FAILED this run (no cert/key at all) -> SKIPS, never throws', async () => {
    const outcome = await mintRoutingClient(undefined, undefined, false, false, mintDepsWith());
    expect(outcome.status).toBe('skipped');
  });

  it('lockHasRoutingClientKey takes priority over caMintedThisRun (never re-mints even when a fresh CA key IS in memory)', async () => {
    let mintCalled = false;
    const outcome = await mintRoutingClient('CA-CERT-PEM', 'CA-KEY-PEM', true, true, mintDepsWith({ mint: async () => { mintCalled = true; return { certPem: 'x', keyPem: 'y' }; } }));
    expect(mintCalled).toBe(false);
    expect(outcome.status).toBe('skipped');
  });

  // groundnuty/macf#954 — `deps.mint` throwing (a crypto/tmpdir/disk
  // exception) is a DISTINCT `'failed'` status, never folded into the two
  // benign 'skipped' causes above. `applyExitCode`
  // (`commands/bootstrap-apply.ts`) reads THIS status to decide the exit
  // code, so the discrimination has to happen right here — see this test's
  // sibling `applyExitCode` assertions in `bootstrap-apply.test.ts`.
  it('deps.mint throwing -> FAILS (status "failed", DISTINCT from "skipped") with the error in the reason, never throws out of mintRoutingClient itself (macf#954)', async () => {
    const outcome = await mintRoutingClient(
      'CA-CERT-PEM',
      'CA-KEY-PEM',
      false,
      true,
      mintDepsWith({
        mint: async () => {
          throw new Error('x509 generation failed');
        },
      }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.status).not.toBe('skipped');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/x509 generation failed/);
  });

  it('the two BENIGN skip causes (already-vaulted from a prior run; CA reused not minted this run) stay "skipped", never "failed" — only a genuine mint EXCEPTION is "failed" (macf#954)', async () => {
    const alreadyVaulted = await mintRoutingClient('CA-CERT-PEM', 'CA-KEY-PEM', true, true, mintDepsWith());
    const caReused = await mintRoutingClient('CA-CERT-PEM', undefined, false, false, mintDepsWith());
    expect(alreadyVaulted.status).toBe('skipped');
    expect(caReused.status).toBe('skipped');
  });

  it('NEVER logs or returns a raw credential value in the skipped-path OR the failed-path reason strings (macf#954 extends this to "failed")', async () => {
    const outcomes = await Promise.all([
      mintRoutingClient('CA-CERT-PEM', 'CA-KEY-PEM', true, true, mintDepsWith()),
      mintRoutingClient('CA-CERT-PEM', undefined, false, false, mintDepsWith()),
      mintRoutingClient(
        'CA-CERT-PEM',
        'CA-KEY-PEM',
        false,
        true,
        mintDepsWith({
          mint: async () => {
            // The exception's own message never mentions the key — proves
            // `mintRoutingClient` doesn't independently EMBED its `caKeyPem`
            // argument into the 'failed' reason; it only ever forwards
            // `err.message` verbatim (a caller/dependency-controlled string,
            // scrubbed at ITS OWN source, not this function's job to scrub).
            throw new Error('x509 generation failed');
          },
        }),
      ),
    ]);
    for (const o of outcomes) {
      if (o.status === 'skipped' || o.status === 'failed') {
        expect(o.reason).not.toContain('CA-KEY-PEM');
      }
    }
    // The third outcome above IS the 'failed' path — assert it was actually exercised.
    expect(outcomes[2]?.status).toBe('failed');
  });
});

describe('publishRoutingClientSecrets — create-only per-repo deploy', () => {
  const SECRETS: RoutingClientSecretsForPublish = { status: 'available', certPem: 'CERT-PEM-VALUE', keyPem: 'KEY-PEM-VALUE' };

  it('publishes BOTH cert and key to every given repo, using the correct secret names', async () => {
    const calls: { repo: string; name: string; value: string }[] = [];
    const result = await publishRoutingClientSecrets(SECRETS, ['o/repo-a', 'o/repo-b'], publishDepsWith({ setRepoSecret: async (repo, name, value) => { calls.push({ repo, name, value }); } }));

    expect(result.certLegs).toEqual({ 'o/repo-a': { status: 'created' }, 'o/repo-b': { status: 'created' } });
    expect(result.keyLegs).toEqual({ 'o/repo-a': { status: 'created' }, 'o/repo-b': { status: 'created' } });
    expect(calls).toContainEqual({ repo: 'o/repo-a', name: 'ROUTING_CLIENT_CERT', value: 'CERT-PEM-VALUE' });
    expect(calls).toContainEqual({ repo: 'o/repo-a', name: 'ROUTING_CLIENT_KEY', value: 'KEY-PEM-VALUE' });
    expect(calls).toContainEqual({ repo: 'o/repo-b', name: 'ROUTING_CLIENT_CERT', value: 'CERT-PEM-VALUE' });
    expect(calls).toContainEqual({ repo: 'o/repo-b', name: 'ROUTING_CLIENT_KEY', value: 'KEY-PEM-VALUE' });
  });

  it('create-only: a repo where the secret is ALREADY PRESENT is left untouched — setRepoSecret is NEVER called for it', async () => {
    const calls: { repo: string; name: string }[] = [];
    const result = await publishRoutingClientSecrets(
      SECRETS,
      ['o/already-has-it'],
      publishDepsWith({
        checkRepoSecretPresence: async () => 'present',
        setRepoSecret: async (repo, name) => {
          calls.push({ repo, name });
        },
      }),
    );
    expect(result.certLegs['o/already-has-it']).toEqual({ status: 'already-present' });
    expect(result.keyLegs['o/already-has-it']).toEqual({ status: 'already-present' });
    expect(calls).toEqual([]);
  });

  it('a setRepoSecret failure resolves that ONE leg to failed, never throws, never blocks the other leg/repo', async () => {
    const result = await publishRoutingClientSecrets(
      SECRETS,
      ['o/repo'],
      publishDepsWith({
        setRepoSecret: async (_repo, name) => {
          if (name === ROUTING_CLIENT_KEY_SECRET_NAME) throw new Error('permission denied');
        },
      }),
    );
    expect(result.certLegs['o/repo']).toEqual({ status: 'created' });
    expect(result.keyLegs['o/repo']?.status).toBe('failed');
  });

  it('NEVER includes the raw cert/key value anywhere in the result — only status/reason strings', async () => {
    const result = await publishRoutingClientSecrets(SECRETS, ['o/repo'], publishDepsWith());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('CERT-PEM-VALUE');
    expect(serialized).not.toContain('KEY-PEM-VALUE');
  });

  it('empty repo list -> empty legs, no calls', async () => {
    let called = false;
    const result = await publishRoutingClientSecrets(SECRETS, [], publishDepsWith({ setRepoSecret: async () => { called = true; } }));
    expect(result).toEqual({ certLegs: {}, keyLegs: {} });
    expect(called).toBe(false);
  });

  // --- groundnuty/macf#986 — the loop runs REGARDLESS of secrets.status ---

  const UNAVAILABLE: RoutingClientSecretsForPublish = { status: 'unavailable', reason: 'no vault, no fresh mint' };

  it('secrets UNAVAILABLE + repo already has it -> already-present, setRepoSecret NEVER called (idempotent presence check runs independent of secret availability)', async () => {
    const calls: { repo: string; name: string }[] = [];
    const result = await publishRoutingClientSecrets(
      UNAVAILABLE,
      ['o/already-has-it'],
      publishDepsWith({
        checkRepoSecretPresence: async () => 'present',
        setRepoSecret: async (repo, name) => {
          calls.push({ repo, name });
        },
      }),
    );
    expect(result.certLegs['o/already-has-it']).toEqual({ status: 'already-present' });
    expect(result.keyLegs['o/already-has-it']).toEqual({ status: 'already-present' });
    expect(calls).toEqual([]);
  });

  it('secrets UNAVAILABLE + repo is MISSING it -> a LOUD "failed" leg carrying the reason, never a silent "skipped"', async () => {
    const result = await publishRoutingClientSecrets(UNAVAILABLE, ['o/missing-it'], publishDepsWith());
    expect(result.certLegs['o/missing-it']?.status).toBe('failed');
    expect(result.keyLegs['o/missing-it']?.status).toBe('failed');
    if (result.certLegs['o/missing-it']?.status === 'failed') expect(result.certLegs['o/missing-it'].reason).toContain('no vault, no fresh mint');
    if (result.keyLegs['o/missing-it']?.status === 'failed') expect(result.keyLegs['o/missing-it'].reason).toContain('no vault, no fresh mint');
  });

  it('secrets UNAVAILABLE, mixed repos -> already-present for the one that has it, failed for the one that does not — never a blanket outcome', async () => {
    const result = await publishRoutingClientSecrets(
      UNAVAILABLE,
      ['o/has-it', 'o/missing-it'],
      publishDepsWith({ checkRepoSecretPresence: async (repo) => (repo === 'o/has-it' ? 'present' : 'absent') }),
    );
    expect(result.certLegs['o/has-it']).toEqual({ status: 'already-present' });
    expect(result.certLegs['o/missing-it']?.status).toBe('failed');
    if (result.certLegs['o/missing-it']?.status === 'failed') expect(result.certLegs['o/missing-it'].reason).toContain('no vault, no fresh mint');
  });
});

describe('resolveRoutingClientSecretsForPublish (groundnuty/macf#986)', () => {
  const SKIPPED_PRIOR_MINT: Extract<RoutingClientMintOutcome, { status: 'skipped' }> = {
    status: 'skipped',
    reason: 'a routing-client cert was already minted for this fleet in a PRIOR apply run',
  };
  const SKIPPED_NEVER_MINTED: Extract<RoutingClientMintOutcome, { status: 'skipped' }> = {
    status: 'skipped',
    reason: 'CA was not freshly minted this run',
  };
  const FAILED_MINT: Extract<RoutingClientMintOutcome, { status: 'failed' }> = {
    status: 'failed',
    reason: 'routing-client cert mint failed: x509 generation failed',
  };

  it('prior mint (lockHasRoutingClientKey) + vault WIRED + vault HAS it -> available, deps.mint is not part of this seam at all', async () => {
    const deps: RoutingClientVaultRestoreDeps = {
      readVaultRoutingClient: async () => ({ certPem: 'VAULT-CERT', keyPem: 'VAULT-KEY' }),
    };
    const result = await resolveRoutingClientSecretsForPublish(SKIPPED_PRIOR_MINT, true, deps);
    expect(result).toEqual({ status: 'available', certPem: 'VAULT-CERT', keyPem: 'VAULT-KEY' });
  });

  it('prior mint + vault NOT wired (no --vault/--identity-key) -> unavailable, reason hints at supplying both flags', async () => {
    const result = await resolveRoutingClientSecretsForPublish(SKIPPED_PRIOR_MINT, true, {});
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/already minted/);
      expect(result.reason).toMatch(/--vault/);
      expect(result.reason).toMatch(/--identity-key/);
    }
  });

  it('prior mint + vault WIRED but returns undefined (vault read failed / field absent) -> unavailable, DIFFERENT reason (does not tell an operator who already supplied the flags to supply them)', async () => {
    const deps: RoutingClientVaultRestoreDeps = { readVaultRoutingClient: async () => undefined };
    const result = await resolveRoutingClientSecretsForPublish(SKIPPED_PRIOR_MINT, true, deps);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason).toMatch(/vault-restore was attempted/);
    }
  });

  it('prior mint + vault WIRED but throws -> degrades to unavailable, NEVER throws out of this function (contract violation defense-in-depth)', async () => {
    const deps: RoutingClientVaultRestoreDeps = {
      readVaultRoutingClient: async () => {
        throw new Error('age -d exploded');
      },
    };
    await expect(resolveRoutingClientSecretsForPublish(SKIPPED_PRIOR_MINT, true, deps)).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('NEVER minted at all (lockHasRoutingClientKey false) -> unavailable, vault is not even attempted (nothing to restore) even if a readVaultRoutingClient dep IS wired', async () => {
    let vaultCalled = false;
    const deps: RoutingClientVaultRestoreDeps = {
      readVaultRoutingClient: async () => {
        vaultCalled = true;
        return { certPem: 'x', keyPem: 'y' };
      },
    };
    const result = await resolveRoutingClientSecretsForPublish(SKIPPED_NEVER_MINTED, false, deps);
    expect(vaultCalled).toBe(false);
    expect(result).toEqual({ status: 'unavailable', reason: SKIPPED_NEVER_MINTED.reason });
  });

  it('a genuine mint FAILURE (crypto exception) -> unavailable, carrying the mint failure reason (lockHasRoutingClientKey is always false on this path, so vault is never attempted)', async () => {
    const result = await resolveRoutingClientSecretsForPublish(FAILED_MINT, false, {});
    expect(result).toEqual({ status: 'unavailable', reason: FAILED_MINT.reason });
  });

  it('NEVER includes raw cert/key material in an "unavailable" reason string', async () => {
    const deps: RoutingClientVaultRestoreDeps = { readVaultRoutingClient: async () => undefined };
    const result = await resolveRoutingClientSecretsForPublish(SKIPPED_PRIOR_MINT, true, deps);
    if (result.status === 'unavailable') {
      expect(result.reason).not.toMatch(/-----BEGIN/);
    }
  });
});

describe('skippedRoutingClientPublish (pure)', () => {
  it('produces a uniform skipped leg for every repo, both cert and key, carrying the given reason', () => {
    const result = skippedRoutingClientPublish(['o/a', 'o/b'], 'CA was reused; no key in memory');
    expect(result).toEqual({
      certLegs: { 'o/a': { status: 'skipped', reason: 'CA was reused; no key in memory' }, 'o/b': { status: 'skipped', reason: 'CA was reused; no key in memory' } },
      keyLegs: { 'o/a': { status: 'skipped', reason: 'CA was reused; no key in memory' }, 'o/b': { status: 'skipped', reason: 'CA was reused; no key in memory' } },
    });
  });

  it('empty repo list -> empty legs', () => {
    expect(skippedRoutingClientPublish([], 'x')).toEqual({ certLegs: {}, keyLegs: {} });
  });
});
