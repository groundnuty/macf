/**
 * Tests for `vault-read.ts` — the `vault.age` READ/decrypt primitive + the
 * presence/derivation queries built on it (DR-043 Amendment D phase 3,
 * groundnuty/macf#838/#854).
 *
 * `parseVaultPlaintext` / the presence-query functions / `readVault`'s own
 * orchestration are pure or injected-deps and fully exercised offline.
 * `ageDecryptFile` is the one real I/O leaf — exercised for real against the
 * actual `age`/`age-keygen` binaries where available (same `have()` gate
 * `vault-write.test.ts` already uses), SKIPPED (not faked) elsewhere, per
 * the "never fake a passing test" instruction and the "a test that
 * constructs the seam it should observe" lesson: a faked `age` cannot prove
 * the real encrypt→decrypt round-trip actually works.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toVariableSegment } from '@groundnuty/macf-core';
import {
  ageDecryptFile,
  countVaultAgentPresence,
  countVaultCaPresence,
  countVaultRoutingPresence,
  parseVaultPlaintext,
  queryVaultAgentPresence,
  queryVaultCaPresence,
  queryVaultRoutingPresence,
  readVault,
  type VaultAgentObservation,
  type VaultCaObservation,
} from '../../../src/cli/bootstrap/vault-read.js';
import { VaultError, buildVaultPlaintext, writeVault, type VaultAgentSecrets, type VaultPayload } from '../../../src/cli/bootstrap/vault-write.js';
import { deriveAppHandle } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { secretFingerprint } from '../../../src/cli/bootstrap/fleet-lock.js';

function have(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).status === 0;
}
const HAS_AGE = have('age') && have('age-keygen');

const FLEET = 'demo-fleet';
const ROLE = 'code-agent';
const AGENT: VaultAgentSecrets = {
  appHandle: deriveAppHandle(FLEET, ROLE),
  appId: '111',
  installId: '222',
  clientId: 'Iv1.abc',
  clientSecret: 'SYNTH-CLIENT-SECRET',
  webhookSecret: 'SYNTH-WEBHOOK-SECRET',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nSYNTH-PEM-BYTES\n-----END RSA PRIVATE KEY-----\n',
};
const PAYLOAD: VaultPayload = {
  agents: [AGENT],
  routing: {
    appId: '999',
    appKeyPem: 'SYNTH-ROUTING-PEM',
    clientCertPem: 'SYNTH-CLIENT-CERT-PEM',
    clientKeyPem: 'SYNTH-CLIENT-KEY-PEM',
    tsOauthClientId: 'ts-client-id',
    tsOauthSecret: 'SYNTH-TS-OAUTH-SECRET',
  },
  ca: { project: FLEET, caKeyPem: 'SYNTH-CA-KEY-PEM', caCertPem: 'SYNTH-CA-CERT-PEM' },
};

describe('parseVaultPlaintext', () => {
  it('parses single-quoted KEY=\'value\' lines (buildVaultPlaintext\'s current emission)', () => {
    const raw = parseVaultPlaintext("MACF_AGENT_X_APP_ID='111'\nMACF_AGENT_X_CLIENT_ID='Iv1.abc'\n");
    expect(raw).toEqual({ MACF_AGENT_X_APP_ID: '111', MACF_AGENT_X_CLIENT_ID: 'Iv1.abc' });
  });

  it('parses double-quoted KEY="value" lines (macf#848 compat — a real vault written before that fix uses this form)', () => {
    const raw = parseVaultPlaintext('MACF_AGENT_X_APP_ID="111"\n');
    expect(raw).toEqual({ MACF_AGENT_X_APP_ID: '111' });
  });

  it('passes an unquoted KEY=value through unchanged (harmless permissiveness per vault.sh\'s own _vault_unquote contract)', () => {
    const raw = parseVaultPlaintext('MACF_AGENT_X_APP_ID=111\n');
    expect(raw).toEqual({ MACF_AGENT_X_APP_ID: '111' });
  });

  it('skips blank lines and #-comment lines (vault.template.txt\'s documented shape)', () => {
    const raw = parseVaultPlaintext("# a header comment\n\nMACF_AGENT_X_APP_ID='111'\n\n# trailing comment\n");
    expect(raw).toEqual({ MACF_AGENT_X_APP_ID: '111' });
  });

  it('strips exactly ONE layer of matching quotes (a value that is itself quote-shaped keeps its inner quotes)', () => {
    const raw = parseVaultPlaintext(`MACF_AGENT_X_APP_ID='"nested"'\n`);
    expect(raw.MACF_AGENT_X_APP_ID).toBe('"nested"');
  });

  it('throws VaultError(vault_malformed_plaintext) on a content line with no "="', () => {
    try {
      parseVaultPlaintext("MACF_AGENT_X_APP_ID='111'\nNOT_A_KV_LINE\n");
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_malformed_plaintext');
      expect((e as VaultError).message).not.toContain('NOT_A_KV_LINE');
    }
  });

  it('throws VaultError(vault_malformed_plaintext) on an invalid key (not a shell identifier) — the offending KEY IS named (never secret)', () => {
    try {
      parseVaultPlaintext("1BAD-KEY='v'\n");
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_malformed_plaintext');
      expect((e as VaultError).message).toContain('1BAD-KEY');
    }
  });

  it('throws VaultError(vault_malformed_plaintext) on an entirely empty payload', () => {
    try {
      parseVaultPlaintext('');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_malformed_plaintext');
    }
  });

  it('throws VaultError(vault_malformed_plaintext) on a payload with only blank/comment lines', () => {
    expect(() => parseVaultPlaintext('# just a comment\n\n\n')).toThrow(VaultError);
  });

  it('never leaks the secret VALUE into the thrown malformed-plaintext message', () => {
    try {
      parseVaultPlaintext("MACF_AGENT_X_APP_ID='111'\nBOGUS-LEAKED-SECRET-VALUE-NO-EQUALS\n");
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as VaultError).message).not.toContain('BOGUS-LEAKED-SECRET-VALUE');
    }
  });
});

describe('readVault — orchestration (injected deps, no real age)', () => {
  it('throws VaultError(vault_not_found) when the vault file does not exist', async () => {
    await expect(
      readVault(
        { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
        { exists: () => false, assertIdentityReadable: () => {} },
      ),
    ).rejects.toThrow(VaultError);
    try {
      await readVault(
        { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
        { exists: () => false, assertIdentityReadable: () => {} },
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as VaultError).code).toBe('vault_not_found');
    }
  });

  it('checks vault existence BEFORE the identity — never attempts decrypt on a missing vault', async () => {
    let identityChecked = false;
    let decryptCalled = false;
    await expect(
      readVault(
        { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
        {
          exists: () => false,
          assertIdentityReadable: () => {
            identityChecked = true;
          },
          decrypt: async () => {
            decryptCalled = true;
            return '';
          },
        },
      ),
    ).rejects.toThrow(VaultError);
    expect(identityChecked).toBe(false);
    expect(decryptCalled).toBe(false);
  });

  it('propagates the identity-readable guard\'s VaultError without attempting decrypt', async () => {
    let decryptCalled = false;
    await expect(
      readVault(
        { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
        {
          exists: () => true,
          assertIdentityReadable: () => {
            throw new VaultError('vault_identity_unreadable', 'no key here');
          },
          decrypt: async () => {
            decryptCalled = true;
            return '';
          },
        },
      ),
    ).rejects.toThrow(/no key here/);
    expect(decryptCalled).toBe(false);
  });

  it('propagates a decrypt failure (e.g. wrong key) as-is', async () => {
    await expect(
      readVault(
        { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
        {
          exists: () => true,
          assertIdentityReadable: () => {},
          decrypt: async () => {
            throw new VaultError('vault_decrypt_failed', 'age -d exited 1: wrong key');
          },
        },
      ),
    ).rejects.toThrow(/wrong key/);
  });

  it('parses the decrypted plaintext on success', async () => {
    const raw = await readVault(
      { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
      { exists: () => true, assertIdentityReadable: () => {}, decrypt: async () => "MACF_AGENT_X_APP_ID='111'\n" },
    );
    expect(raw).toEqual({ MACF_AGENT_X_APP_ID: '111' });
  });

  it('a malformed decrypted payload surfaces as vault_malformed_plaintext through readVault too', async () => {
    try {
      await readVault(
        { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
        { exists: () => true, assertIdentityReadable: () => {}, decrypt: async () => 'garbage-no-equals' },
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as VaultError).code).toBe('vault_malformed_plaintext');
    }
  });
});

describe('presence/derivation queries — non-secret shapes only', () => {
  const raw = parseVaultPlaintext(buildVaultPlaintext(PAYLOAD));

  it('queryVaultAgentPresence: every field of a fully-provisioned agent reads present with a fingerprint', () => {
    const presence = queryVaultAgentPresence(raw, FLEET, ROLE);
    expect(presence.appId.present).toBe(true);
    expect(presence.installId.present).toBe(true);
    expect(presence.clientId.present).toBe(true);
    expect(presence.clientSecret.present).toBe(true);
    expect(presence.webhookSecret.present).toBe(true);
    expect(presence.privateKey.present).toBe(true);
    // Fingerprints are `sha256:<hex>` shaped, never the value:
    expect(presence.clientSecret.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the clientSecret/webhookSecret fingerprints match fleet-lock.ts\'s secretFingerprint over the SAME raw value (drift-comparable)', () => {
    const presence = queryVaultAgentPresence(raw, FLEET, ROLE);
    expect(presence.clientSecret.fingerprint).toBe(secretFingerprint(AGENT.clientSecret));
    expect(presence.webhookSecret.fingerprint).toBe(secretFingerprint(AGENT.webhookSecret));
  });

  it('the privateKey fingerprint is computed over the base64-DECODED bytes — matches fingerprinting the ORIGINAL raw PEM, not the base64 text stored in the vault', () => {
    const presence = queryVaultAgentPresence(raw, FLEET, ROLE);
    expect(presence.privateKey.fingerprint).toBe(secretFingerprint(AGENT.pem));
    // NOT the base64 form's own fingerprint — proves the decode actually happened:
    expect(presence.privateKey.fingerprint).not.toBe(secretFingerprint(Buffer.from(AGENT.pem, 'utf-8').toString('base64')));
  });

  it('queryVaultAgentPresence: an UNPROVISIONED role reads entirely absent, not an error', () => {
    const presence = queryVaultAgentPresence(raw, FLEET, 'never-provisioned-role');
    expect(presence.appId.present).toBe(false);
    expect(presence.appId.fingerprint).toBeUndefined();
    expect(presence.privateKey.present).toBe(false);
  });

  it('queryVaultCaPresence: the per-project CA key/cert both read present', () => {
    const presence = queryVaultCaPresence(raw, FLEET);
    expect(presence.caKey.present).toBe(true);
    expect(presence.caCert.present).toBe(true);
    expect(presence.caKey.fingerprint).toBe(secretFingerprint(PAYLOAD.ca?.caKeyPem ?? ''));
  });

  it('queryVaultCaPresence: a DIFFERENT project (not in this vault) reads entirely absent', () => {
    const presence = queryVaultCaPresence(raw, 'some-other-fleet');
    expect(presence.caKey.present).toBe(false);
    expect(presence.caCert.present).toBe(false);
  });

  it('queryVaultRoutingPresence: all 6 routing fields read present', () => {
    const presence = queryVaultRoutingPresence(raw);
    expect(presence.appId.present).toBe(true);
    expect(presence.appKey.present).toBe(true);
    expect(presence.clientCert.present).toBe(true);
    expect(presence.clientKey.present).toBe(true);
    expect(presence.tsOauthClientId.present).toBe(true);
    expect(presence.tsOauthSecret.present).toBe(true);
  });

  it('queryVaultRoutingPresence: an empty vault reads every field absent', () => {
    const presence = queryVaultRoutingPresence({});
    expect(presence.appId.present).toBe(false);
    expect(presence.tsOauthSecret.present).toBe(false);
  });

  it('count helpers tally present/total correctly', () => {
    expect(countVaultAgentPresence(queryVaultAgentPresence(raw, FLEET, ROLE))).toEqual({ present: 6, total: 6 });
    expect(countVaultAgentPresence(queryVaultAgentPresence(raw, FLEET, 'nope'))).toEqual({ present: 0, total: 6 });
    expect(countVaultCaPresence(queryVaultCaPresence(raw, FLEET))).toEqual({ present: 2, total: 2 });
    expect(countVaultRoutingPresence(queryVaultRoutingPresence(raw))).toEqual({ present: 6, total: 6 });
  });

  it('presence objects NEVER carry the raw secret value anywhere — the redaction seam (mirrors apply-ca.ts\'s redactCaResolve test)', () => {
    const agentPresence = queryVaultAgentPresence(raw, FLEET, ROLE);
    const caPresence = queryVaultCaPresence(raw, FLEET);
    const routingPresence = queryVaultRoutingPresence(raw);
    const serialized = JSON.stringify({ agentPresence, caPresence, routingPresence });
    expect(serialized).not.toContain(AGENT.clientSecret);
    expect(serialized).not.toContain(AGENT.webhookSecret);
    expect(serialized).not.toContain('SYNTH-PEM-BYTES');
    expect(serialized).not.toContain(PAYLOAD.ca?.caKeyPem);
    expect(serialized).not.toContain(PAYLOAD.routing?.tsOauthSecret);
    // Every raw value's base64 form is ALSO absent (proves we never echoed the encoded field either):
    expect(serialized).not.toContain(Buffer.from(AGENT.pem, 'utf-8').toString('base64'));
  });

  it('a VaultAgentObservation / VaultCaObservation built from these presence objects also never carries a raw value — the actual shape threaded onto ObservedState/--json', () => {
    const agentObs: VaultAgentObservation = { status: 'confirmed', presence: queryVaultAgentPresence(raw, FLEET, ROLE) };
    const caObs: VaultCaObservation = { status: 'confirmed', presence: queryVaultCaPresence(raw, FLEET) };
    const serialized = JSON.stringify({ agentObs, caObs });
    expect(serialized).not.toContain(AGENT.clientSecret);
    expect(serialized).not.toContain(PAYLOAD.ca?.caCertPem);
  });
});

describe('ageDecryptFile / readVault (real age binary)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function mintAgeKey(dir: string, name: string): { keyPath: string; publicKey: string } {
    const keyPath = join(dir, name);
    const r = spawnSync('age-keygen', ['-o', keyPath], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    const content = readFileSync(keyPath, 'utf-8');
    const match = /age1[0-9a-z]+/.exec(content);
    expect(match).not.toBeNull();
    return { keyPath, publicKey: match?.[0] ?? '' };
  }

  it.skipIf(!HAS_AGE)(
    'FULL ROUND-TRIP: buildVaultPlaintext → writeVault (real age -e) → readVault (real age -d) → parseVaultPlaintext ' +
      'reproduces the exact plaintext KEY/VALUE map, and presence queries confirm every field',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-vault-read-test-'));
      dirs.push(dir);
      const key = mintAgeKey(dir, 'operator-key.txt');
      const vaultPath = join(dir, 'vault.age');

      const plaintext = buildVaultPlaintext(PAYLOAD);
      await writeVault(plaintext, { outPath: vaultPath, recipients: [key.publicKey] });

      const raw = await readVault({ vaultPath, identityPath: key.keyPath });

      const seg = toVariableSegment(deriveAppHandle(FLEET, ROLE));
      expect(raw[`MACF_AGENT_${seg}_APP_ID`]).toBe(AGENT.appId);
      expect(raw[`MACF_AGENT_${seg}_CLIENT_SECRET`]).toBe(AGENT.clientSecret);
      expect(raw[`MACF_AGENT_${seg}_WEBHOOK_SECRET`]).toBe(AGENT.webhookSecret);
      expect(Buffer.from(raw[`MACF_AGENT_${seg}_PRIVATE_KEY_B64`] ?? '', 'base64').toString('utf-8')).toBe(AGENT.pem);

      const presence = queryVaultAgentPresence(raw, FLEET, ROLE);
      expect(countVaultAgentPresence(presence)).toEqual({ present: 6, total: 6 });
      expect(presence.clientSecret.fingerprint).toBe(secretFingerprint(AGENT.clientSecret));

      const caPresence = queryVaultCaPresence(raw, FLEET);
      expect(countVaultCaPresence(caPresence)).toEqual({ present: 2, total: 2 });
    },
  );

  it.skipIf(!HAS_AGE)(
    'WRONG KEY: decrypting with a DIFFERENT identity than the vault was encrypted to fails with a distinct, ' +
      'non-leaking VaultError(vault_decrypt_failed)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-vault-read-test-'));
      dirs.push(dir);
      const rightKey = mintAgeKey(dir, 'right-key.txt');
      const wrongKey = mintAgeKey(dir, 'wrong-key.txt');
      const vaultPath = join(dir, 'vault.age');
      const plaintext = buildVaultPlaintext(PAYLOAD);
      await writeVault(plaintext, { outPath: vaultPath, recipients: [rightKey.publicKey] });

      try {
        await readVault({ vaultPath, identityPath: wrongKey.keyPath });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(VaultError);
        expect((e as VaultError).code).toBe('vault_decrypt_failed');
        // No plaintext/secret bytes anywhere in the failure message:
        expect((e as VaultError).message).not.toContain(AGENT.clientSecret);
        expect((e as VaultError).message).not.toContain(AGENT.webhookSecret);
        expect((e as VaultError).message).not.toContain('SYNTH-PEM-BYTES');
        expect((e as VaultError).message).not.toContain(plaintext);
      }
    },
  );

  it.skipIf(!HAS_AGE)('MISSING VAULT FILE: readVault fails loud with vault_not_found before ever invoking age', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-vault-read-test-'));
    dirs.push(dir);
    const key = mintAgeKey(dir, 'k.txt');
    try {
      await readVault({ vaultPath: join(dir, 'does-not-exist.age'), identityPath: key.keyPath });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_not_found');
    }
  });

  it.skipIf(!HAS_AGE)(
    'MISSING IDENTITY: readVault fails loud with vault_identity_unreadable (real vault present, identity absent) — an actionable message, distinct from a decrypt failure',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-vault-read-test-'));
      dirs.push(dir);
      const key = mintAgeKey(dir, 'operator-key.txt');
      const vaultPath = join(dir, 'vault.age');
      await writeVault(buildVaultPlaintext(PAYLOAD), { outPath: vaultPath, recipients: [key.publicKey] });

      try {
        await readVault({ vaultPath, identityPath: join(dir, 'no-such-identity.txt') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(VaultError);
        expect((e as VaultError).code).toBe('vault_identity_unreadable');
        expect((e as VaultError).message).toContain('no-such-identity.txt');
      }
    },
  );

  it.skipIf(!HAS_AGE)('a MULTI-RECIPIENT vault (operator + VM key) is readable by EITHER identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-vault-read-test-'));
    dirs.push(dir);
    const opKey = mintAgeKey(dir, 'operator-key.txt');
    const vmKey = mintAgeKey(dir, 'vm-key.txt');
    const vaultPath = join(dir, 'vault.age');
    await writeVault(buildVaultPlaintext(PAYLOAD), { outPath: vaultPath, recipients: [opKey.publicKey, vmKey.publicKey] });

    const rawViaOperator = await readVault({ vaultPath, identityPath: opKey.keyPath });
    const rawViaVm = await readVault({ vaultPath, identityPath: vmKey.keyPath });
    expect(rawViaOperator).toEqual(rawViaVm);
  });

  it('rejects with VaultError(vault_read_spawn_failed) — never crashes the process — when `age` cannot be spawned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-vault-read-test-'));
    dirs.push(dir);
    const fakeVault = join(dir, 'vault.age');
    writeFileSync(fakeVault, 'irrelevant-ciphertext-bytes');
    const fakeIdentity = join(dir, 'identity.txt');
    writeFileSync(fakeIdentity, 'AGE-SECRET-KEY-FAKE');
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '';
      await expect(ageDecryptFile(fakeVault, fakeIdentity)).rejects.toThrow(VaultError);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
