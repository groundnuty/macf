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
  skippedRoutingClientPublish,
} from '../../../src/cli/bootstrap/apply-routing-client.js';
import type { RoutingClientMintDeps, RoutingClientPublishDeps } from '../../../src/cli/bootstrap/apply-routing-client.js';

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

  it('deps.mint throwing -> SKIPS with the error in the reason, never throws out of mintRoutingClient itself', async () => {
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
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') expect(outcome.reason).toMatch(/x509 generation failed/);
  });

  it('NEVER logs or returns a raw credential value in the skipped-path reason strings', async () => {
    const outcomes = await Promise.all([
      mintRoutingClient('CA-CERT-PEM', 'CA-KEY-PEM', true, true, mintDepsWith()),
      mintRoutingClient('CA-CERT-PEM', undefined, false, false, mintDepsWith()),
    ]);
    for (const o of outcomes) {
      if (o.status === 'skipped') {
        expect(o.reason).not.toContain('CA-KEY-PEM');
      }
    }
  });
});

describe('publishRoutingClientSecrets — create-only per-repo deploy', () => {
  const SECRETS = { certPem: 'CERT-PEM-VALUE', keyPem: 'KEY-PEM-VALUE' };

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
