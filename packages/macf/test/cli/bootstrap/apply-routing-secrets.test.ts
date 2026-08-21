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
  TS_OAUTH_CLIENT_ID_SECRET_NAME,
  TS_OAUTH_SECRET_SECRET_NAME,
  publishRoutingSecrets,
  skippedRoutingSecretsPublish,
  toBase64ForSecret,
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
