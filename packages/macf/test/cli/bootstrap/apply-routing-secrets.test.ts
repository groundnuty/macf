/**
 * Tests for `apply-routing-secrets.ts` — the unified six-secret routing
 * publish (groundnuty/macf#1074). Ported + generalized from the retired
 * `apply-routing-client.test.ts::publishRoutingClientSecrets` suite (2
 * secret names -> 6) plus new coverage decisive to THIS issue: the exact
 * six-name set lands (never a silent subset), and the per-field encoding
 * fix (`toBase64ForSecret`).
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_ROUTING_SECRET_NAMES,
  ROUTING_APP_ID_SECRET_NAME,
  ROUTING_APP_KEY_SECRET_NAME,
  ROUTING_BUNDLE_SECRET_NAME,
  TAILSCALE_OAUTH_MISSING_CODE,
  TS_OAUTH_CLIENT_ID_SECRET_NAME,
  TS_OAUTH_SECRET_SECRET_NAME,
  checkTailscaleOauthPreflight,
  packRoutingBundle,
  publishRoutingBundle,
  publishRoutingSecrets,
  skippedRoutingBundlePublish,
  skippedRoutingSecretsPublish,
  toBase64ForSecret,
  unpackRoutingBundle,
} from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import type { RoutingSecretsForPublish, RoutingSecretsPublishDeps } from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import { ROUTING_CLIENT_CERT_SECRET_NAME, ROUTING_CLIENT_KEY_SECRET_NAME } from '../../../src/cli/bootstrap/apply-routing-client.js';

function depsWith(overrides: Partial<RoutingSecretsPublishDeps> = {}): RoutingSecretsPublishDeps {
  return {
    checkRepoSecretPresence: async () => 'absent',
    setRepoSecret: async () => {},
    ...overrides,
  };
}

/** All six available, distinct sentinel values per name (so a mixed-up-field bug shows up as a wrong-value assertion failure, not a coincidental pass). */
const ALL_AVAILABLE: RoutingSecretsForPublish = {
  [ROUTING_APP_ID_SECRET_NAME]: { status: 'available', value: 'APP-ID-VALUE' },
  [ROUTING_APP_KEY_SECRET_NAME]: { status: 'available', value: 'APP-KEY-PEM-VALUE' },
  [ROUTING_CLIENT_CERT_SECRET_NAME]: { status: 'available', value: 'CLIENT-CERT-B64-VALUE' },
  [ROUTING_CLIENT_KEY_SECRET_NAME]: { status: 'available', value: 'CLIENT-KEY-B64-VALUE' },
  [TS_OAUTH_CLIENT_ID_SECRET_NAME]: { status: 'available', value: 'TS-CLIENT-ID-VALUE' },
  [TS_OAUTH_SECRET_SECRET_NAME]: { status: 'available', value: 'TS-SECRET-VALUE' },
};

const ALL_UNAVAILABLE: RoutingSecretsForPublish = Object.fromEntries(
  ALL_ROUTING_SECRET_NAMES.map((name) => [name, { status: 'unavailable', reason: `${name}: no vault, no fresh mint` }]),
) as RoutingSecretsForPublish;

describe('ALL_ROUTING_SECRET_NAMES — the exact six names agent-router.yml declares as required workflow_call secrets', () => {
  it('is exactly these six, no more, no fewer', () => {
    expect(ALL_ROUTING_SECRET_NAMES).toEqual(['MACF_ROUTING_APP_ID', 'MACF_ROUTING_APP_KEY', 'ROUTING_CLIENT_CERT', 'ROUTING_CLIENT_KEY', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET']);
    expect(ALL_ROUTING_SECRET_NAMES).toHaveLength(6);
  });
});

describe('publishRoutingSecrets — THE DECISIVE TEST: the exact 6-name set lands on every repo, never a silent subset', () => {
  it('publishes ALL SIX secrets to every given repo, using the correct names and values — asserts the KEYS of the result, not merely that "publish ran"', async () => {
    const calls: { repo: string; name: string; value: string }[] = [];
    const result = await publishRoutingSecrets(
      ALL_AVAILABLE,
      ['o/repo-a', 'o/repo-b'],
      depsWith({ setRepoSecret: async (repo, name, value) => { calls.push({ repo, name, value }); } }),
    );

    // Decisive: the result carries EXACTLY these six top-level keys — a
    // publisher that silently dropped back to two (the exact bug #1074
    // reports) would fail THIS assertion even if every individual leg it
    // did emit looked correct in isolation.
    expect(Object.keys(result).sort()).toEqual([...ALL_ROUTING_SECRET_NAMES].sort());

    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(result[name]['o/repo-a']).toEqual({ status: 'created' });
      expect(result[name]['o/repo-b']).toEqual({ status: 'created' });
    }

    // Every repo received all six — asserts VALUE per name too (not just
    // that setRepoSecret was called six times per repo with SOME value).
    for (const repo of ['o/repo-a', 'o/repo-b']) {
      expect(calls).toContainEqual({ repo, name: ROUTING_APP_ID_SECRET_NAME, value: 'APP-ID-VALUE' });
      expect(calls).toContainEqual({ repo, name: ROUTING_APP_KEY_SECRET_NAME, value: 'APP-KEY-PEM-VALUE' });
      expect(calls).toContainEqual({ repo, name: ROUTING_CLIENT_CERT_SECRET_NAME, value: 'CLIENT-CERT-B64-VALUE' });
      expect(calls).toContainEqual({ repo, name: ROUTING_CLIENT_KEY_SECRET_NAME, value: 'CLIENT-KEY-B64-VALUE' });
      expect(calls).toContainEqual({ repo, name: TS_OAUTH_CLIENT_ID_SECRET_NAME, value: 'TS-CLIENT-ID-VALUE' });
      expect(calls).toContainEqual({ repo, name: TS_OAUTH_SECRET_SECRET_NAME, value: 'TS-SECRET-VALUE' });
    }
    // Exactly 12 calls (6 names x 2 repos) — never 4 (the two-of-six bug).
    expect(calls).toHaveLength(12);
  });

  it('a REAL fleet with only two of six resolved (the exact #1074 bug shape) reports the OTHER four as failed, never silently omits them from the result', async () => {
    const twoOfSix: RoutingSecretsForPublish = {
      ...ALL_UNAVAILABLE,
      [ROUTING_CLIENT_CERT_SECRET_NAME]: { status: 'available', value: 'CERT-B64' },
      [ROUTING_CLIENT_KEY_SECRET_NAME]: { status: 'available', value: 'KEY-B64' },
    };
    const result = await publishRoutingSecrets(twoOfSix, ['o/repo'], depsWith());

    // The two resolved ones succeed:
    expect(result[ROUTING_CLIENT_CERT_SECRET_NAME]['o/repo']).toEqual({ status: 'created' });
    expect(result[ROUTING_CLIENT_KEY_SECRET_NAME]['o/repo']).toEqual({ status: 'created' });
    // The other FOUR are present in the result (never dropped) and LOUD-failed:
    for (const name of [ROUTING_APP_ID_SECRET_NAME, ROUTING_APP_KEY_SECRET_NAME, TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME]) {
      expect(result[name]['o/repo']?.status).toBe('failed');
    }
    expect(Object.keys(result)).toHaveLength(6);
  });

  it('create-only: a repo where a secret is ALREADY PRESENT is left untouched — setRepoSecret is NEVER called for it', async () => {
    const calls: { repo: string; name: string }[] = [];
    const result = await publishRoutingSecrets(
      ALL_AVAILABLE,
      ['o/already-has-it'],
      depsWith({
        checkRepoSecretPresence: async () => 'present',
        setRepoSecret: async (repo, name) => { calls.push({ repo, name }); },
      }),
    );
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(result[name]['o/already-has-it']).toEqual({ status: 'already-present' });
    }
    expect(calls).toEqual([]);
  });

  it('a setRepoSecret failure resolves that ONE leg to failed, never throws, never blocks the other legs/repos', async () => {
    const result = await publishRoutingSecrets(
      ALL_AVAILABLE,
      ['o/repo'],
      depsWith({
        setRepoSecret: async (_repo, name) => {
          if (name === TS_OAUTH_SECRET_SECRET_NAME) throw new Error('permission denied');
        },
      }),
    );
    expect(result[TS_OAUTH_SECRET_SECRET_NAME]['o/repo']?.status).toBe('failed');
    // Every OTHER leg is unaffected:
    expect(result[ROUTING_APP_ID_SECRET_NAME]['o/repo']).toEqual({ status: 'created' });
    expect(result[ROUTING_CLIENT_CERT_SECRET_NAME]['o/repo']).toEqual({ status: 'created' });
  });

  it('NEVER includes a raw secret value anywhere in the result — only status/reason strings', async () => {
    const result = await publishRoutingSecrets(ALL_AVAILABLE, ['o/repo'], depsWith());
    const serialized = JSON.stringify(result);
    for (const value of ['APP-ID-VALUE', 'APP-KEY-PEM-VALUE', 'CLIENT-CERT-B64-VALUE', 'CLIENT-KEY-B64-VALUE', 'TS-CLIENT-ID-VALUE', 'TS-SECRET-VALUE']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('empty repo list -> every name maps to empty legs, no calls', async () => {
    let called = false;
    const result = await publishRoutingSecrets(ALL_AVAILABLE, [], depsWith({ setRepoSecret: async () => { called = true; } }));
    for (const name of ALL_ROUTING_SECRET_NAMES) expect(result[name]).toEqual({});
    expect(called).toBe(false);
  });

  // --- groundnuty/macf#986's "never blanket-skip" discipline, generalized to all six ---

  it('ALL SIX unavailable + repo already has them -> already-present for every name, setRepoSecret NEVER called (idempotent presence check runs independent of availability)', async () => {
    const calls: { repo: string; name: string }[] = [];
    const result = await publishRoutingSecrets(
      ALL_UNAVAILABLE,
      ['o/already-has-it'],
      depsWith({
        checkRepoSecretPresence: async () => 'present',
        setRepoSecret: async (repo, name) => { calls.push({ repo, name }); },
      }),
    );
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(result[name]['o/already-has-it']).toEqual({ status: 'already-present' });
    }
    expect(calls).toEqual([]);
  });

  it('ALL SIX unavailable + repo is MISSING them -> a LOUD "failed" leg per name carrying the reason, never a silent "skipped"', async () => {
    const result = await publishRoutingSecrets(ALL_UNAVAILABLE, ['o/missing-it'], depsWith());
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(result[name]['o/missing-it']?.status).toBe('failed');
      const leg = result[name]['o/missing-it'];
      if (leg?.status === 'failed') expect(leg.reason).toContain('no vault, no fresh mint');
    }
  });

  it('mixed repos -> already-present for the one that has it, failed for the one that does not — never a blanket outcome', async () => {
    const result = await publishRoutingSecrets(
      ALL_UNAVAILABLE,
      ['o/has-it', 'o/missing-it'],
      depsWith({ checkRepoSecretPresence: async (repo) => (repo === 'o/has-it' ? 'present' : 'absent') }),
    );
    expect(result[ROUTING_APP_ID_SECRET_NAME]['o/has-it']).toEqual({ status: 'already-present' });
    expect(result[ROUTING_APP_ID_SECRET_NAME]['o/missing-it']?.status).toBe('failed');
  });

  it('presence UNKNOWN (unconfirmable, e.g. rate-limited) -> "failed", same as "absent" — the Amendment A4 choice, generalized to all six', async () => {
    const result = await publishRoutingSecrets(ALL_UNAVAILABLE, ['o/unconfirmable'], depsWith({ checkRepoSecretPresence: async () => 'unknown' }));
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(result[name]['o/unconfirmable']?.status).toBe('failed');
    }
  });
});

describe('publishRoutingSecrets — "not-required" is DISTINCT from "unavailable" (groundnuty/macf#1074)', () => {
  const NOT_REQUIRED_REASON = 'transport.tailscale_oauth_required is not declared in fleet.yaml — Tailscale OAuth was never requested for this fleet.';
  const NOT_REQUIRED_SECRETS: RoutingSecretsForPublish = {
    ...ALL_AVAILABLE,
    [TS_OAUTH_CLIENT_ID_SECRET_NAME]: { status: 'not-required', reason: NOT_REQUIRED_REASON },
    [TS_OAUTH_SECRET_SECRET_NAME]: { status: 'not-required', reason: NOT_REQUIRED_REASON },
  };

  it('a repo MISSING a not-required secret -> "skipped", never "failed" — the exact bug this state fixes (an undeclared fleet must never fail apply)', async () => {
    const result = await publishRoutingSecrets(NOT_REQUIRED_SECRETS, ['o/repo'], depsWith({ checkRepoSecretPresence: async () => 'absent' }));
    expect(result[TS_OAUTH_CLIENT_ID_SECRET_NAME]['o/repo']).toEqual({ status: 'skipped', reason: NOT_REQUIRED_REASON });
    expect(result[TS_OAUTH_SECRET_SECRET_NAME]['o/repo']).toEqual({ status: 'skipped', reason: NOT_REQUIRED_REASON });
    // Every OTHER (available) secret is unaffected:
    expect(result[ROUTING_APP_ID_SECRET_NAME]['o/repo']).toEqual({ status: 'created' });
  });

  it('never calls setRepoSecret for a not-required secret, even on an absent repo (create() is never reached)', async () => {
    const calls: string[] = [];
    await publishRoutingSecrets(
      NOT_REQUIRED_SECRETS,
      ['o/repo'],
      depsWith({ checkRepoSecretPresence: async () => 'absent', setRepoSecret: async (_repo, name) => { calls.push(name); } }),
    );
    expect(calls).not.toContain(TS_OAUTH_CLIENT_ID_SECRET_NAME);
    expect(calls).not.toContain(TS_OAUTH_SECRET_SECRET_NAME);
  });

  it('a repo that ALREADY HAS a not-required secret still reports "already-present" — the #986 discipline applies regardless of need', async () => {
    const result = await publishRoutingSecrets(NOT_REQUIRED_SECRETS, ['o/already-has-it'], depsWith({ checkRepoSecretPresence: async () => 'present' }));
    expect(result[TS_OAUTH_CLIENT_ID_SECRET_NAME]['o/already-has-it']).toEqual({ status: 'already-present' });
  });

  it('presence UNKNOWN for a not-required secret -> "skipped" (never escalated to "failed" the way UNAVAILABLE does)', async () => {
    const result = await publishRoutingSecrets(NOT_REQUIRED_SECRETS, ['o/unconfirmable'], depsWith({ checkRepoSecretPresence: async () => 'unknown' }));
    expect(result[TS_OAUTH_CLIENT_ID_SECRET_NAME]['o/unconfirmable']?.status).toBe('skipped');
  });

  it('the exit-code-decisive contrast: "unavailable" on an absent repo IS failed, "not-required" on an absent repo is NOT — same absent repo, different resolution status', async () => {
    const mixed: RoutingSecretsForPublish = {
      ...ALL_UNAVAILABLE,
      [TS_OAUTH_CLIENT_ID_SECRET_NAME]: { status: 'not-required', reason: NOT_REQUIRED_REASON },
    };
    const result = await publishRoutingSecrets(mixed, ['o/repo'], depsWith());
    expect(result[TS_OAUTH_CLIENT_ID_SECRET_NAME]['o/repo']?.status).toBe('skipped');
    expect(result[ROUTING_APP_ID_SECRET_NAME]['o/repo']?.status).toBe('failed'); // unavailable, not not-required
  });
});

describe('skippedRoutingSecretsPublish (pure)', () => {
  it('produces a uniform skipped leg for every repo, EVERY of the six names, carrying the given reason', () => {
    const result = skippedRoutingSecretsPublish(['o/a', 'o/b'], 'router App was freshly created this run but the vault write did not succeed');
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(result[name]).toEqual({
        'o/a': { status: 'skipped', reason: 'router App was freshly created this run but the vault write did not succeed' },
        'o/b': { status: 'skipped', reason: 'router App was freshly created this run but the vault write did not succeed' },
      });
    }
    expect(Object.keys(result)).toHaveLength(6);
  });

  it('empty repo list -> every name maps to empty legs', () => {
    const result = skippedRoutingSecretsPublish([], 'x');
    for (const name of ALL_ROUTING_SECRET_NAMES) expect(result[name]).toEqual({});
  });
});

describe('toBase64ForSecret — the fix for the live encoding bug #1074 found', () => {
  it('base64-encodes UTF-8 text, matching Buffer.from(...).toString("base64")', () => {
    expect(toBase64ForSecret('hello')).toBe(Buffer.from('hello', 'utf-8').toString('base64'));
  });

  it('round-trips a PEM-shaped value the way agent-router.yml\'s `base64 -d` expects to decode it', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB...FAKE...\n-----END CERTIFICATE-----\n';
    const encoded = toBase64ForSecret(pem);
    expect(Buffer.from(encoded, 'base64').toString('utf-8')).toBe(pem);
    // Decisive: the encoded form contains NONE of PEM's non-base64-alphabet
    // characters (the `-----BEGIN...-----` delimiters use `-`, which is
    // NOT in the standard base64 alphabet) — this is exactly what made the
    // pre-fix raw-PEM-as-secret-value shape fail `base64 -d` under the
    // router job's `set -euo pipefail`.
    expect(encoded).not.toContain('-----');
  });
});

describe('checkTailscaleOauthPreflight — refuse before gate 1 when declared-and-absent (groundnuty/macf#1074)', () => {
  it('NOT declared -> undefined (proceed), regardless of vault flags', async () => {
    const result = await checkTailscaleOauthPreflight(false, undefined, undefined, {
      readVault: async () => { throw new Error('must not be called — not declared'); },
    });
    expect(result).toBeUndefined();
  });

  it('declared, but --vault/--identity-key NOT both supplied -> REFUSES (cannot verify presence without decrypting)', async () => {
    const result = await checkTailscaleOauthPreflight(true, undefined, undefined, {
      readVault: async () => { throw new Error('must not be called — no vault path supplied'); },
    });
    expect(result).toBeDefined();
    expect(result?.code).toBe(TAILSCALE_OAUTH_MISSING_CODE);
    expect(result?.message).toMatch(/--vault\/--identity-key/);
  });

  it('declared, only ONE of --vault/--identity-key supplied -> STILL refuses (both-or-neither, same as every other vault-restore closure)', async () => {
    const onlyVault = await checkTailscaleOauthPreflight(true, '/fake/vault.age', undefined, { readVault: async () => { throw new Error('must not be called'); } });
    expect(onlyVault?.code).toBe(TAILSCALE_OAUTH_MISSING_CODE);
    const onlyIdentity = await checkTailscaleOauthPreflight(true, undefined, '/fake/identity.txt', { readVault: async () => { throw new Error('must not be called'); } });
    expect(onlyIdentity?.code).toBe(TAILSCALE_OAUTH_MISSING_CODE);
  });

  it('declared, both supplied, vault yields BOTH values -> undefined (proceed)', async () => {
    const result = await checkTailscaleOauthPreflight(true, '/fake/vault.age', '/fake/identity.txt', {
      readVault: async () => ({ [TS_OAUTH_CLIENT_ID_SECRET_NAME]: 'ts-client-id', [TS_OAUTH_SECRET_SECRET_NAME]: 'ts-secret' }),
    });
    expect(result).toBeUndefined();
  });

  it('declared, both supplied, vault yields NEITHER value -> REFUSES', async () => {
    const result = await checkTailscaleOauthPreflight(true, '/fake/vault.age', '/fake/identity.txt', { readVault: async () => ({}) });
    expect(result?.code).toBe(TAILSCALE_OAUTH_MISSING_CODE);
  });

  it('declared, both supplied, vault yields only ONE of the two values -> STILL refuses (both-or-nothing)', async () => {
    const onlyClientId = await checkTailscaleOauthPreflight(true, '/fake/vault.age', '/fake/identity.txt', {
      readVault: async () => ({ [TS_OAUTH_CLIENT_ID_SECRET_NAME]: 'ts-client-id' }),
    });
    expect(onlyClientId?.code).toBe(TAILSCALE_OAUTH_MISSING_CODE);
    const onlySecret = await checkTailscaleOauthPreflight(true, '/fake/vault.age', '/fake/identity.txt', {
      readVault: async () => ({ [TS_OAUTH_SECRET_SECRET_NAME]: 'ts-secret' }),
    });
    expect(onlySecret?.code).toBe(TAILSCALE_OAUTH_MISSING_CODE);
  });

  it('a decrypt failure (bad --identity-key) folds into the SAME refusal, never throws, never propagates a secret', async () => {
    const result = await checkTailscaleOauthPreflight(true, '/fake/vault.age', '/fake/identity.txt', {
      readVault: async () => { throw new Error('age: error: no identity matched any of the recipients'); },
    });
    expect(result?.code).toBe(TAILSCALE_OAUTH_MISSING_CODE);
    expect(result?.message).not.toContain('ts-secret');
  });

  it('NEVER includes a secret value in the refusal message, even when the vault partially yields one', async () => {
    const result = await checkTailscaleOauthPreflight(true, '/fake/vault.age', '/fake/identity.txt', {
      readVault: async () => ({ [TS_OAUTH_CLIENT_ID_SECRET_NAME]: 'ts-client-id', [TS_OAUTH_SECRET_SECRET_NAME]: '' }),
    });
    expect(result?.code).toBe(TAILSCALE_OAUTH_MISSING_CODE);
    expect(result?.message).not.toContain('ts-client-id');
  });
});

// --- groundnuty/macf#1112: the single bundled routing secret ---

const BUNDLE_VALUES: Readonly<Record<(typeof ALL_ROUTING_SECRET_NAMES)[number], string>> = {
  [ROUTING_APP_ID_SECRET_NAME]: 'APP-ID-VALUE',
  [ROUTING_APP_KEY_SECRET_NAME]: '-----BEGIN PRIVATE KEY-----\nMULTILINE\nPEM\n-----END PRIVATE KEY-----\n',
  [ROUTING_CLIENT_CERT_SECRET_NAME]: 'CLIENT-CERT-B64-VALUE',
  [ROUTING_CLIENT_KEY_SECRET_NAME]: 'CLIENT-KEY-B64-VALUE',
  [TS_OAUTH_CLIENT_ID_SECRET_NAME]: 'TS-CLIENT-ID-VALUE',
  [TS_OAUTH_SECRET_SECRET_NAME]: 'TS-SECRET-VALUE',
};

describe('packRoutingBundle / unpackRoutingBundle — the bundle wire-format round-trip (groundnuty/macf#1112)', () => {
  it('DECISIVE: pack six, unpack six, all values recovered byte-for-byte — including a multi-line PEM', () => {
    const bundle = packRoutingBundle(BUNDLE_VALUES);
    const unpacked = unpackRoutingBundle(bundle);
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(unpacked[name]).toBe(BUNDLE_VALUES[name]);
    }
    expect(Object.keys(unpacked).sort()).toEqual([...ALL_ROUTING_SECRET_NAMES].sort());
  });

  it('the wire form is single-line base64 of JSON — opaque, shell-safe, no embedded newlines', () => {
    const bundle = packRoutingBundle(BUNDLE_VALUES);
    expect(bundle).not.toContain('\n');
    // Standard base64 alphabet only (+/=A-Za-z0-9) — safe inside a GitHub
    // Actions secret value and a shell `${{ }}`/env-var context.
    expect(bundle).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const decodedJson = Buffer.from(bundle, 'base64').toString('utf-8');
    expect(() => JSON.parse(decodedJson)).not.toThrow();
  });

  it('unpack THROWS naming the missing key(s) when the bundle is missing one', () => {
    const partial = { ...BUNDLE_VALUES };
    // @ts-expect-error deliberately building a malformed bundle for the test
    delete partial[TS_OAUTH_SECRET_SECRET_NAME];
    const json = JSON.stringify(partial);
    const bundle = Buffer.from(json, 'utf-8').toString('base64');
    expect(() => unpackRoutingBundle(bundle)).toThrow(/missing required key\(s\).*TS_OAUTH_SECRET/);
  });

  it('unpack THROWS naming ALL SIX when given an empty JSON object', () => {
    const bundle = Buffer.from('{}', 'utf-8').toString('base64');
    let thrown: unknown;
    try {
      unpackRoutingBundle(bundle);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect((thrown as Error).message).toContain(name);
    }
  });

  it('unpack THROWS on malformed base64, never silently returns a partial/garbage result', () => {
    expect(() => unpackRoutingBundle('not-valid-base64-!!!' + ' ')).toThrow();
  });

  it('unpack THROWS on base64 that decodes to non-JSON', () => {
    const bundle = Buffer.from('this is not json', 'utf-8').toString('base64');
    expect(() => unpackRoutingBundle(bundle)).toThrow(/not valid JSON/);
  });

  it('unpack THROWS when a key holds an empty string (empty is treated the same as missing)', () => {
    const withEmpty = { ...BUNDLE_VALUES, [TS_OAUTH_CLIENT_ID_SECRET_NAME]: '' };
    const bundle = Buffer.from(JSON.stringify(withEmpty), 'utf-8').toString('base64');
    expect(() => unpackRoutingBundle(bundle)).toThrow(/TS_OAUTH_CLIENT_ID/);
  });
});

describe('publishRoutingBundle — additive alongside the six individual secrets (groundnuty/macf#1112)', () => {
  it('all six available -> composes + publishes MACF_ROUTING_BUNDLE, and it round-trips to the SAME six values publishRoutingSecrets would have used', async () => {
    const calls: { repo: string; name: string; value: string }[] = [];
    const result = await publishRoutingBundle(
      ALL_AVAILABLE,
      ['o/repo-a', 'o/repo-b'],
      depsWith({ setRepoSecret: async (repo, name, value) => { calls.push({ repo, name, value }); } }),
    );
    expect(result['o/repo-a']).toEqual({ status: 'created' });
    expect(result['o/repo-b']).toEqual({ status: 'created' });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.name).toBe(ROUTING_BUNDLE_SECRET_NAME);
      const unpacked = unpackRoutingBundle(call.value);
      expect(unpacked[ROUTING_APP_ID_SECRET_NAME]).toBe('APP-ID-VALUE');
      expect(unpacked[ROUTING_CLIENT_CERT_SECRET_NAME]).toBe('CLIENT-CERT-B64-VALUE');
      expect(unpacked[TS_OAUTH_SECRET_SECRET_NAME]).toBe('TS-SECRET-VALUE');
    }
  });

  it('create-only: a repo that already has MACF_ROUTING_BUNDLE is left untouched', async () => {
    const calls: string[] = [];
    const result = await publishRoutingBundle(
      ALL_AVAILABLE,
      ['o/already-has-it'],
      depsWith({ checkRepoSecretPresence: async () => 'present', setRepoSecret: async (_r, name) => { calls.push(name); } }),
    );
    expect(result['o/already-has-it']).toEqual({ status: 'already-present' });
    expect(calls).toEqual([]);
  });

  it('ANY leg unavailable -> the WHOLE bundle is "failed" for every repo (never a partial/broken bundle written)', async () => {
    const oneMissing: RoutingSecretsForPublish = {
      ...ALL_AVAILABLE,
      [TS_OAUTH_SECRET_SECRET_NAME]: { status: 'unavailable', reason: 'vault restore came up empty' },
    };
    const calls: string[] = [];
    const result = await publishRoutingBundle(
      oneMissing,
      ['o/repo-a', 'o/repo-b'],
      depsWith({ setRepoSecret: async (_r, name) => { calls.push(name); } }),
    );
    expect(result['o/repo-a']?.status).toBe('failed');
    expect(result['o/repo-b']?.status).toBe('failed');
    if (result['o/repo-a']?.status === 'failed') {
      expect(result['o/repo-a'].reason).toContain('TS_OAUTH_SECRET');
      expect(result['o/repo-a'].reason).toContain('vault restore came up empty');
    }
    // Never attempts a partial write:
    expect(calls).toEqual([]);
  });

  it('ANY leg not-required (and none unavailable) -> "skipped" for every repo, never attempts a write', async () => {
    const notRequired: RoutingSecretsForPublish = {
      ...ALL_AVAILABLE,
      [TS_OAUTH_CLIENT_ID_SECRET_NAME]: { status: 'not-required', reason: 'Tailscale not declared for this fleet yet' },
    };
    const calls: string[] = [];
    const result = await publishRoutingBundle(
      notRequired,
      ['o/repo'],
      depsWith({ setRepoSecret: async (_r, name) => { calls.push(name); } }),
    );
    expect(result['o/repo']?.status).toBe('skipped');
    if (result['o/repo']?.status === 'skipped') {
      expect(result['o/repo'].reason).toContain('TS_OAUTH_CLIENT_ID');
    }
    expect(calls).toEqual([]);
  });

  it('presence-check-first, EVEN when not composable this run: a repo that already has the bundle is "already-present", never "failed"/"skipped" (the #986 discipline, lifted to the aggregate)', async () => {
    // Decisive regression case: an early version of this function checked
    // "is every leg available?" BEFORE ever calling checkRepoSecretPresence,
    // so a repo that already held the bundle from an EARLIER run (when the
    // routing-client cert genuinely wasn't minted this run — a normal,
    // frequent shape per `apply-routing-client.ts`'s reuse path) got a
    // spurious 'failed', flipping `applyExitCode` to 1 on an otherwise
    // healthy, idempotent re-run.
    const oneUnavailable: RoutingSecretsForPublish = {
      ...ALL_AVAILABLE,
      [TS_OAUTH_SECRET_SECRET_NAME]: { status: 'unavailable', reason: 'not minted this run' },
    };
    const calls: string[] = [];
    const result = await publishRoutingBundle(
      oneUnavailable,
      ['o/already-has-it'],
      depsWith({ checkRepoSecretPresence: async () => 'present', setRepoSecret: async (_r, name) => { calls.push(name); } }),
    );
    expect(result['o/already-has-it']).toEqual({ status: 'already-present' });
    expect(calls).toEqual([]);

    // Same proof for the not-required shape:
    const oneNotRequired: RoutingSecretsForPublish = {
      ...ALL_AVAILABLE,
      [TS_OAUTH_CLIENT_ID_SECRET_NAME]: { status: 'not-required', reason: 'Tailscale not declared yet' },
    };
    const result2 = await publishRoutingBundle(
      oneNotRequired,
      ['o/already-has-it'],
      depsWith({ checkRepoSecretPresence: async () => 'present' }),
    );
    expect(result2['o/already-has-it']).toEqual({ status: 'already-present' });
  });

  it('NEVER includes a raw secret value anywhere in the result — only status/reason strings (the base64 bundle itself never appears in the RESULT, only via setRepoSecret)', async () => {
    const result = await publishRoutingBundle(ALL_AVAILABLE, ['o/repo'], depsWith());
    const serialized = JSON.stringify(result);
    for (const value of ['APP-ID-VALUE', 'APP-KEY-PEM-VALUE', 'CLIENT-CERT-B64-VALUE', 'CLIENT-KEY-B64-VALUE', 'TS-CLIENT-ID-VALUE', 'TS-SECRET-VALUE']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('empty repo list -> empty result, no calls', async () => {
    let called = false;
    const result = await publishRoutingBundle(ALL_AVAILABLE, [], depsWith({ setRepoSecret: async () => { called = true; } }));
    expect(result).toEqual({});
    expect(called).toBe(false);
  });
});

describe('skippedRoutingBundlePublish (pure)', () => {
  it('produces a uniform skipped leg for every given repo, carrying the given reason', () => {
    const result = skippedRoutingBundlePublish(['o/a', 'o/b'], 'control repo aborted before step 0.5');
    expect(result).toEqual({
      'o/a': { status: 'skipped', reason: 'control repo aborted before step 0.5' },
      'o/b': { status: 'skipped', reason: 'control repo aborted before step 0.5' },
    });
  });

  it('empty repo list -> empty result', () => {
    expect(skippedRoutingBundlePublish([], 'x')).toEqual({});
  });
});

describe('legacy six-secret path still works — additive proof (groundnuty/macf#1112)', () => {
  it('publishRoutingSecrets (the six-secret publisher) is UNCHANGED by the bundle addition: same result shape, same six keys, for a caller still on secrets: inherit / explicit-six', async () => {
    const result = await publishRoutingSecrets(ALL_AVAILABLE, ['o/repo'], depsWith());
    expect(Object.keys(result).sort()).toEqual([...ALL_ROUTING_SECRET_NAMES].sort());
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(result[name]['o/repo']).toEqual({ status: 'created' });
    }
  });

  it('a fleet that publishes BOTH the six AND the bundle in the same run gets consistent values in both forms', async () => {
    const sixCalls: { name: string; value: string }[] = [];
    const bundleCalls: { name: string; value: string }[] = [];
    await publishRoutingSecrets(ALL_AVAILABLE, ['o/repo'], depsWith({ setRepoSecret: async (_r, name, value) => { sixCalls.push({ name, value }); } }));
    await publishRoutingBundle(ALL_AVAILABLE, ['o/repo'], depsWith({ setRepoSecret: async (_r, name, value) => { bundleCalls.push({ name, value }); } }));

    const sixByName = Object.fromEntries(sixCalls.map((c) => [c.name, c.value]));
    const bundleValue = bundleCalls.find((c) => c.name === ROUTING_BUNDLE_SECRET_NAME)?.value;
    expect(bundleValue).toBeDefined();
    const unpacked = unpackRoutingBundle(bundleValue!);
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(unpacked[name]).toBe(sixByName[name]);
    }
  });
});
