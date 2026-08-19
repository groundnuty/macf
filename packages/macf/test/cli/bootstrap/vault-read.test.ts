/**
 * Tests for `vault-read.ts` — the `vault.age` READ/decrypt primitive + the
 * presence/derivation queries built on it (DR-043 Amendment D phase 3,
 * groundnuty/macf#838/#854).
 *
 * `parseVaultPlaintext` / the presence-query functions / `readVault`'s own
 * orchestration are pure or injected-deps and fully exercised offline.
 * `ageDecryptFile` is the one real I/O leaf — exercised for real against the
 * actual `age`/`age-keygen` binaries where available (same `resolveAgeGate`
 * gate `vault-write.test.ts` already uses, `./age-binary-gate.js`), SKIPPED
 * (not faked) elsewhere, per the "never fake a passing test" instruction and
 * the "a test that constructs the seam it should observe" lesson: a faked
 * `age` cannot prove the real encrypt→decrypt round-trip actually works. See
 * `age-binary-gate.ts` for why an absent binary WARNS locally and FAILS in
 * CI (groundnuty/macf#963).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toVariableSegment } from '@groundnuty/macf-core';
import {
  ageDecryptFile,
  assertNoDroppedVaultKeys,
  composeAndWriteVault,
  countVaultAgentPresence,
  countVaultCaPresence,
  countVaultRecipientStanzas,
  countVaultRoutingPresence,
  countVaultRunnerOpsPresence,
  parseVaultPlaintext,
  queryVaultAgentPresence,
  queryVaultCaPresence,
  queryVaultRoutingPresence,
  queryVaultRunnerOpsPresence,
  readVault,
  readVaultRecipientCount,
  reencryptVault,
  vaultAgentPrivateKeyPem,
  vaultCaCertPem,
  parseRecoveryArtifactPlaintext,
  readRecoveryArtifact,
  vaultRoutingClientCertPem,
  vaultRoutingClientKeyPem,
  vaultRunnerOpsPrivateKeyPem,
  type VaultAgentObservation,
  type VaultCaObservation,
} from '../../../src/cli/bootstrap/vault-read.js';
import {
  VaultError,
  buildVaultPlaintext,
  writeAgentRecoveryArtifact,
  writeVault,
  type VaultAgentSecrets,
  type VaultPayload,
  type VaultRunnerOpsSecrets,
} from '../../../src/cli/bootstrap/vault-write.js';
import type { AppCredentials } from '../../../src/cli/bootstrap/manifest-exchange.js';
import { deriveAppHandle } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { deriveRunnerOpsHandle } from '../../../src/cli/bootstrap/apply-runner-ops.js';
import { secretFingerprint } from '../../../src/cli/bootstrap/fleet-lock.js';
import { resolveAgeGate } from './age-binary-gate.js';

const HAS_AGE = resolveAgeGate('vault-read.test.ts', 9);

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

// groundnuty/macf#954 — the runner-ops App's fixtures, kept SEPARATE from
// `PAYLOAD`/`AGENT` above (a dedicated payload, not a mutation of the shared
// one) so the new runner-ops tests can't perturb any pre-existing assertion
// in this file that counts fields/keys off `PAYLOAD`.
const RUNNER_OPS: VaultRunnerOpsSecrets = {
  appHandle: deriveRunnerOpsHandle(FLEET),
  appId: '777',
  installId: '778',
  clientId: 'Iv1.runner-ops',
  clientSecret: 'SYNTH-RUNNER-OPS-CLIENT-SECRET',
  webhookSecret: 'SYNTH-RUNNER-OPS-WEBHOOK-SECRET',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nSYNTH-RUNNER-OPS-PEM-BYTES\n-----END RSA PRIVATE KEY-----\n',
};
const PAYLOAD_WITH_RUNNER_OPS: VaultPayload = { ...PAYLOAD, runnerOps: RUNNER_OPS };

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

// --- macf#988, DR-043 Amendment B consume side ---

const RECOVERY_CREDS: AppCredentials = {
  appId: '9001',
  name: 'demo-fleet-code-agent',
  slug: 'demo-fleet-code-agent',
  clientId: 'Iv1.recovery',
  clientSecret: 'SYNTH-RECOVERY-CLIENT-SECRET',
  webhookSecret: 'SYNTH-RECOVERY-WEBHOOK-SECRET',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nSYNTH-RECOVERY-PEM-BYTES\n-----END RSA PRIVATE KEY-----\n',
};

describe('parseRecoveryArtifactPlaintext — pure, offline', () => {
  it('round-trips a well-formed recovery-artifact plaintext back into AppCredentials', () => {
    const plaintext = [
      "MACF_RECOVERY_CODE_AGENT_APP_ID='9001'",
      "MACF_RECOVERY_CODE_AGENT_APP_NAME='demo-fleet-code-agent'",
      "MACF_RECOVERY_CODE_AGENT_APP_SLUG='demo-fleet-code-agent'",
      "MACF_RECOVERY_CODE_AGENT_CLIENT_ID='Iv1.recovery'",
      "MACF_RECOVERY_CODE_AGENT_CLIENT_SECRET='SYNTH-RECOVERY-CLIENT-SECRET'",
      "MACF_RECOVERY_CODE_AGENT_WEBHOOK_SECRET='SYNTH-RECOVERY-WEBHOOK-SECRET'",
      `MACF_RECOVERY_CODE_AGENT_PRIVATE_KEY_B64='${Buffer.from(RECOVERY_CREDS.pem, 'utf-8').toString('base64')}'`,
      '',
    ].join('\n');
    expect(parseRecoveryArtifactPlaintext(plaintext, 'code-agent')).toEqual(RECOVERY_CREDS);
  });

  it('throws recovery_artifact_malformed when a required field is missing (e.g. wrong role)', () => {
    const plaintext = "MACF_RECOVERY_SCIENCE_AGENT_APP_ID='9001'\n";
    try {
      parseRecoveryArtifactPlaintext(plaintext, 'code-agent');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as VaultError).code).toBe('recovery_artifact_malformed');
      expect((e as VaultError).message).toContain('MACF_RECOVERY_CODE_AGENT_APP_ID');
      // Never leaks a value in the thrown message:
      expect((e as VaultError).message).not.toContain('9001');
    }
  });
});

describe('readRecoveryArtifact — orchestration (injected deps, no real age)', () => {
  it('returns undefined (never throws) when nothing exists at artifactPath — the ordinary "no crash happened" case', async () => {
    const result = await readRecoveryArtifact('/fake/recovery-root/demo-fleet/code-agent.age', '/fake/key.txt', 'code-agent', {
      exists: () => false,
      decrypt: async () => {
        throw new Error('must not be called — exists() already said absent');
      },
    });
    expect(result).toBeUndefined();
  });

  it('decrypts + parses when the artifact exists', async () => {
    const plaintext = [
      "MACF_RECOVERY_CODE_AGENT_APP_ID='9001'",
      "MACF_RECOVERY_CODE_AGENT_APP_NAME='demo-fleet-code-agent'",
      "MACF_RECOVERY_CODE_AGENT_APP_SLUG='demo-fleet-code-agent'",
      "MACF_RECOVERY_CODE_AGENT_CLIENT_ID='Iv1.recovery'",
      "MACF_RECOVERY_CODE_AGENT_CLIENT_SECRET='SYNTH-RECOVERY-CLIENT-SECRET'",
      "MACF_RECOVERY_CODE_AGENT_WEBHOOK_SECRET='SYNTH-RECOVERY-WEBHOOK-SECRET'",
      `MACF_RECOVERY_CODE_AGENT_PRIVATE_KEY_B64='${Buffer.from(RECOVERY_CREDS.pem, 'utf-8').toString('base64')}'`,
      '',
    ].join('\n');
    const seenArgs: { path: string; identity: string }[] = [];
    const result = await readRecoveryArtifact('/fake/recovery-root/demo-fleet/code-agent.age', '/fake/key.txt', 'code-agent', {
      exists: () => true,
      decrypt: async (p, ip) => {
        seenArgs.push({ path: p, identity: ip });
        return plaintext;
      },
    });
    expect(result).toEqual(RECOVERY_CREDS);
    expect(seenArgs).toEqual([{ path: '/fake/recovery-root/demo-fleet/code-agent.age', identity: '/fake/key.txt' }]);
  });

  it('a decrypt failure (wrong identity / corrupt file) REJECTS — never silently returns undefined', async () => {
    await expect(
      readRecoveryArtifact('/fake/recovery-root/demo-fleet/code-agent.age', '/fake/key.txt', 'code-agent', {
        exists: () => true,
        decrypt: async () => {
          throw new VaultError('vault_decrypt_failed', 'age -d exited 1: wrong identity');
        },
      }),
    ).rejects.toThrow(/wrong identity/);
  });

  it.skipIf(!HAS_AGE)(
    'REAL age binary FULL ROUND-TRIP (the decisive crash-recovery proof): writeAgentRecoveryArtifact (real age -e) → ' +
      'readRecoveryArtifact (real age -d) reproduces the EXACT AppCredentials — the same shape a fresh gate-1 exchange would produce',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-vault-read-recovery-test-'));
      try {
        const keyPath = join(dir, 'operator-key.txt');
        const r = spawnSync('age-keygen', ['-o', keyPath], { encoding: 'utf-8' });
        expect(r.status, r.stderr).toBe(0);
        const publicKey = /age1[0-9a-z]+/.exec(readFileSync(keyPath, 'utf-8'))?.[0] ?? '';

        const artifactPath = join(dir, 'demo-fleet', 'code-agent.age');
        await writeAgentRecoveryArtifact('code-agent', RECOVERY_CREDS, [publicKey], artifactPath);

        const recovered = await readRecoveryArtifact(artifactPath, keyPath, 'code-agent');
        expect(recovered).toEqual(RECOVERY_CREDS);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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

describe('vaultCaCertPem — the CA-cert revive query (groundnuty/macf#978)', () => {
  const raw = parseVaultPlaintext(buildVaultPlaintext(PAYLOAD));

  it('returns the exact original CA cert PEM — round-trips through the base64 storage form', () => {
    expect(vaultCaCertPem(raw, FLEET)).toBe(PAYLOAD.ca?.caCertPem);
  });

  it('never returns the CA KEY — only the cert field is decoded', () => {
    expect(vaultCaCertPem(raw, FLEET)).not.toBe(PAYLOAD.ca?.caKeyPem);
  });

  it('returns undefined for a DIFFERENT fleet name — derived forward from `project`, never a bare lookup', () => {
    expect(vaultCaCertPem(raw, 'some-other-fleet')).toBeUndefined();
  });

  it('returns undefined against an empty vault map — never fabricates a cert', () => {
    expect(vaultCaCertPem({}, FLEET)).toBeUndefined();
  });
});

describe('vaultRoutingClientCertPem / vaultRoutingClientKeyPem — the routing-client publish-restore query (groundnuty/macf#986)', () => {
  const raw = parseVaultPlaintext(buildVaultPlaintext(PAYLOAD));

  it('returns the exact original routing-client CERT PEM — round-trips through the base64 storage form', () => {
    expect(vaultRoutingClientCertPem(raw)).toBe(PAYLOAD.routing?.clientCertPem);
  });

  it('returns the exact original routing-client KEY PEM', () => {
    expect(vaultRoutingClientKeyPem(raw)).toBe(PAYLOAD.routing?.clientKeyPem);
  });

  it('the cert query never returns the key, and vice versa', () => {
    expect(vaultRoutingClientCertPem(raw)).not.toBe(PAYLOAD.routing?.clientKeyPem);
    expect(vaultRoutingClientKeyPem(raw)).not.toBe(PAYLOAD.routing?.clientCertPem);
  });

  it('fleet-level, not per-project — unlike vaultCaCertPem there is no fleetName parameter to key on', () => {
    // Same `raw` map, no second argument — the routing-client cert is ONE
    // fleet-wide credential (CN=routing-action), never per-project.
    expect(vaultRoutingClientCertPem(raw)).toBeDefined();
  });

  it('returns undefined against an empty vault map — never fabricates a cert/key', () => {
    expect(vaultRoutingClientCertPem({})).toBeUndefined();
    expect(vaultRoutingClientKeyPem({})).toBeUndefined();
  });

  it('returns undefined when only the OTHER routing field is present (partial vault content)', () => {
    const partial = { ROUTING_CLIENT_CERT_B64: Buffer.from('CERT-ONLY', 'utf-8').toString('base64') };
    expect(vaultRoutingClientCertPem(partial)).toBe('CERT-ONLY');
    expect(vaultRoutingClientKeyPem(partial)).toBeUndefined();
  });
});

describe('vaultAgentPrivateKeyPem — the ONE raw-secret-returning query (macf#913)', () => {
  const raw = parseVaultPlaintext(buildVaultPlaintext(PAYLOAD));

  it('returns the exact original PEM for a fully-provisioned role — round-trips through the base64 storage form', () => {
    expect(vaultAgentPrivateKeyPem(raw, FLEET, ROLE)).toBe(AGENT.pem);
  });

  it('returns undefined for an unprovisioned role — never fabricates a PEM', () => {
    expect(vaultAgentPrivateKeyPem(raw, FLEET, 'never-provisioned-role')).toBeUndefined();
  });

  it('returns undefined for a DIFFERENT fleet name — the key is derived forward from (fleetName, role), never a bare role lookup', () => {
    expect(vaultAgentPrivateKeyPem(raw, 'some-other-fleet', ROLE)).toBeUndefined();
  });

  it('returns undefined against an empty vault map', () => {
    expect(vaultAgentPrivateKeyPem({}, FLEET, ROLE)).toBeUndefined();
  });
});

// --- groundnuty/macf#954 — the runner-ops App's presence query + PEM
// accessor, the fifth `queryVault*`/`vault*PrivateKeyPem` sibling. Same
// shapes as the four pre-existing ones: presence-only for
// `queryVaultRunnerOpsPresence` (mirrors `queryVaultAgentPresence` /
// `queryVaultCaPresence` / `queryVaultRoutingPresence`), the ONE raw-secret
// return for `vaultRunnerOpsPrivateKeyPem` (mirrors `vaultAgentPrivateKeyPem`
// — macf#913's precedent).

describe('queryVaultRunnerOpsPresence (macf#954)', () => {
  const raw = parseVaultPlaintext(buildVaultPlaintext(PAYLOAD_WITH_RUNNER_OPS));

  it('every field of a fully-provisioned runner-ops App reads present with a fingerprint', () => {
    const presence = queryVaultRunnerOpsPresence(raw, FLEET);
    expect(presence.appId.present).toBe(true);
    expect(presence.installId.present).toBe(true);
    expect(presence.clientId.present).toBe(true);
    expect(presence.clientSecret.present).toBe(true);
    expect(presence.webhookSecret.present).toBe(true);
    expect(presence.privateKey.present).toBe(true);
    expect(presence.clientSecret.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the clientSecret/webhookSecret fingerprints match fleet-lock.ts\'s secretFingerprint over the SAME raw value (drift-comparable, mirrors queryVaultAgentPresence\'s own test)', () => {
    const presence = queryVaultRunnerOpsPresence(raw, FLEET);
    expect(presence.clientSecret.fingerprint).toBe(secretFingerprint(RUNNER_OPS.clientSecret));
    expect(presence.webhookSecret.fingerprint).toBe(secretFingerprint(RUNNER_OPS.webhookSecret));
  });

  it('the privateKey fingerprint is computed over the base64-DECODED bytes, not the base64 text stored in the vault', () => {
    const presence = queryVaultRunnerOpsPresence(raw, FLEET);
    expect(presence.privateKey.fingerprint).toBe(secretFingerprint(RUNNER_OPS.pem));
    expect(presence.privateKey.fingerprint).not.toBe(secretFingerprint(Buffer.from(RUNNER_OPS.pem, 'utf-8').toString('base64')));
  });

  it('a vault with NO runner-ops entry at all (a plain agent-only vault) reads entirely absent, not an error', () => {
    const agentOnlyRaw = parseVaultPlaintext(buildVaultPlaintext(PAYLOAD)); // PAYLOAD has NO runnerOps field
    const presence = queryVaultRunnerOpsPresence(agentOnlyRaw, FLEET);
    expect(presence.appId.present).toBe(false);
    expect(presence.appId.fingerprint).toBeUndefined();
    expect(presence.privateKey.present).toBe(false);
  });

  it('a DIFFERENT fleet name (not this vault\'s) reads entirely absent — never cross-fleet-misattributed', () => {
    const presence = queryVaultRunnerOpsPresence(raw, 'some-other-fleet');
    expect(presence.appId.present).toBe(false);
    expect(presence.privateKey.present).toBe(false);
  });

  it('countVaultRunnerOpsPresence tallies present/total correctly, mirroring the other count helpers', () => {
    expect(countVaultRunnerOpsPresence(queryVaultRunnerOpsPresence(raw, FLEET))).toEqual({ present: 6, total: 6 });
    expect(countVaultRunnerOpsPresence(queryVaultRunnerOpsPresence(raw, 'nope'))).toEqual({ present: 0, total: 6 });
  });

  it('presence objects NEVER carry the raw secret value anywhere — the same redaction seam every other presence query in this module upholds', () => {
    const presence = queryVaultRunnerOpsPresence(raw, FLEET);
    const serialized = JSON.stringify(presence);
    expect(serialized).not.toContain(RUNNER_OPS.clientSecret);
    expect(serialized).not.toContain(RUNNER_OPS.webhookSecret);
    expect(serialized).not.toContain('SYNTH-RUNNER-OPS-PEM-BYTES');
    expect(serialized).not.toContain(Buffer.from(RUNNER_OPS.pem, 'utf-8').toString('base64'));
  });

  it('does NOT read an agent\'s MACF_AGENT_* fields as if they were runner-ops fields — the vault namespaces stay distinct', () => {
    // PAYLOAD_WITH_RUNNER_OPS also carries AGENT (a `MACF_AGENT_*` entry) —
    // querying runner-ops presence for a role-shaped fleet segment that only
    // exists in the AGENT namespace must not spuriously read as present.
    const presence = queryVaultRunnerOpsPresence(raw, FLEET);
    // Sanity: the agent's OWN presence (different namespace/prefix) is
    // unaffected by/independent of this query.
    expect(queryVaultAgentPresence(raw, FLEET, ROLE).appId.present).toBe(true);
    expect(presence.appId.fingerprint).not.toBe(queryVaultAgentPresence(raw, FLEET, ROLE).appId.fingerprint);
  });
});

describe('vaultRunnerOpsPrivateKeyPem — the runner-ops sibling of vaultAgentPrivateKeyPem (macf#954)', () => {
  const raw = parseVaultPlaintext(buildVaultPlaintext(PAYLOAD_WITH_RUNNER_OPS));

  it('returns the exact original PEM for a fully-provisioned runner-ops App — round-trips through the base64 storage form', () => {
    expect(vaultRunnerOpsPrivateKeyPem(raw, FLEET)).toBe(RUNNER_OPS.pem);
  });

  it('returns undefined when the vault carries no runner-ops entry at all — never fabricates a PEM', () => {
    const agentOnlyRaw = parseVaultPlaintext(buildVaultPlaintext(PAYLOAD));
    expect(vaultRunnerOpsPrivateKeyPem(agentOnlyRaw, FLEET)).toBeUndefined();
  });

  it('returns undefined for a DIFFERENT fleet name — derived forward from fleetName, never a bare lookup', () => {
    expect(vaultRunnerOpsPrivateKeyPem(raw, 'some-other-fleet')).toBeUndefined();
  });

  it('returns undefined against an empty vault map', () => {
    expect(vaultRunnerOpsPrivateKeyPem({}, FLEET)).toBeUndefined();
  });

  it('never returns an AGENT\'s PEM when asked for runner-ops — the two credential classes stay structurally separate', () => {
    expect(vaultRunnerOpsPrivateKeyPem(raw, FLEET)).not.toBe(AGENT.pem);
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

// --- countVaultRecipientStanzas / readVaultRecipientCount / reencryptVault (groundnuty/macf#957) ---

describe('countVaultRecipientStanzas — pure header parse, no age binary needed', () => {
  it('throws vault_header_malformed when the file does not start with the age magic line', () => {
    try {
      countVaultRecipientStanzas(Buffer.from('not-an-age-file\n-> X25519 abc\nbody\n---\n'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_header_malformed');
    }
  });

  it('throws vault_header_malformed when no "---" MAC line is ever found', () => {
    try {
      countVaultRecipientStanzas(Buffer.from('age-encryption.org/v1\n-> X25519 abc\nbody\n'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_header_malformed');
    }
  });

  it('counts one stanza for a single-recipient header', () => {
    const bytes = Buffer.from('age-encryption.org/v1\n-> X25519 ephemeral-pubkey-b64\nwrapped-file-key-b64\n--- header-mac-b64\nBINARY-CIPHERTEXT');
    expect(countVaultRecipientStanzas(bytes)).toBe(1);
  });

  it('counts two stanzas for a two-recipient header (never confuses a stanza body line with a stanza)', () => {
    const bytes = Buffer.from(
      'age-encryption.org/v1\n-> X25519 pub1\nbody1\n-> X25519 pub2\nbody2\n--- mac\nBINARY-CIPHERTEXT',
    );
    expect(countVaultRecipientStanzas(bytes)).toBe(2);
  });

  it('never includes any of the fixed literal ciphertext in the thrown message (no content beyond the module\'s own fixed strings)', () => {
    try {
      countVaultRecipientStanzas(Buffer.from('SECRET-LOOKING-GARBAGE-BYTES'));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as VaultError).message).not.toContain('SECRET-LOOKING-GARBAGE-BYTES');
    }
  });
});

describe('readVaultRecipientCount — orchestration (injected deps, no real age)', () => {
  it('returns {status:"absent"} when the file does not exist — NOT an error (a not-yet-provisioned fleet has no vault yet)', () => {
    const result = readVaultRecipientCount('/fake/secrets/vault.age', { exists: () => false });
    expect(result).toEqual({ status: 'absent' });
  });

  it('returns {status:"counted", count} for an existing, well-formed header', () => {
    const bytes = Buffer.from('age-encryption.org/v1\n-> X25519 pub1\nbody1\n--- mac\nBINARY');
    const result = readVaultRecipientCount('/fake/secrets/vault.age', { exists: () => true, readFile: () => bytes });
    expect(result).toEqual({ status: 'counted', count: 1 });
  });

  it('propagates a malformed-header VaultError for a file that EXISTS but does not parse', () => {
    const bytes = Buffer.from('not-an-age-file');
    expect(() => readVaultRecipientCount('/fake/secrets/vault.age', { exists: () => true, readFile: () => bytes })).toThrow(VaultError);
  });
});

describe('reencryptVault — orchestration + real age binary (groundnuty/macf#957)', () => {
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

  it('refuses with vault_no_age_recipient when newRecipients is empty — no decrypt/encrypt seam is ever invoked', async () => {
    let decryptCalled = false;
    let encryptCalled = false;
    try {
      await reencryptVault('/fake/vault.age', '/fake/identity.txt', [], {
        decrypt: async () => {
          decryptCalled = true;
          return '';
        },
        encrypt: async () => {
          encryptCalled = true;
        },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_no_age_recipient');
    }
    expect(decryptCalled).toBe(false);
    expect(encryptCalled).toBe(false);
  });

  it('refuses a decrypted payload that does not parse as a vault — never attempts to encrypt garbage', async () => {
    let encryptCalled = false;
    await expect(
      reencryptVault('/fake/vault.age', '/fake/identity.txt', ['age1fake'], {
        decrypt: async () => 'this-is-not-a-vault-no-equals-sign',
        encrypt: async () => {
          encryptCalled = true;
        },
      }),
    ).rejects.toThrow(VaultError);
    expect(encryptCalled).toBe(false);
  });

  it('propagates an encrypt failure and cleans up the temp file (never leaves a partial file, never touches vaultPath)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-reencrypt-test-'));
    dirs.push(dir);
    const vaultPath = join(dir, 'vault.age');
    writeFileSync(vaultPath, 'ORIGINAL-CIPHERTEXT-UNCHANGED');
    const unlinkedPaths: string[] = [];
    await expect(
      reencryptVault(vaultPath, '/fake/identity.txt', ['age1fake'], {
        decrypt: async () => "MACF_AGENT_X_APP_ID='111'\n",
        encrypt: async () => {
          throw new Error('simulated age encrypt failure');
        },
        unlink: (p) => unlinkedPaths.push(p),
      }),
    ).rejects.toThrow(/simulated age encrypt failure/);
    // The original file is untouched — a failed re-encrypt never clobbers the live vault:
    expect(readFileSync(vaultPath, 'utf-8')).toBe('ORIGINAL-CIPHERTEXT-UNCHANGED');
    expect(unlinkedPaths).toHaveLength(1);
    expect(unlinkedPaths[0]).toMatch(/vault\.age\.reencrypt-.*\.tmp$/);
  });

  it('propagates a rename failure (temp encrypted successfully, but the atomic swap itself failed) and cleans up the temp file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-reencrypt-test-'));
    dirs.push(dir);
    const vaultPath = join(dir, 'vault.age');
    writeFileSync(vaultPath, 'ORIGINAL-CIPHERTEXT-UNCHANGED');
    const unlinkedPaths: string[] = [];
    try {
      await reencryptVault(vaultPath, '/fake/identity.txt', ['age1fake'], {
        decrypt: async () => "MACF_AGENT_X_APP_ID='111'\n",
        encrypt: async () => {
          /* pretend the temp file was written */
        },
        rename: () => {
          throw new Error('simulated rename failure');
        },
        unlink: (p) => unlinkedPaths.push(p),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_reencrypt_rename_failed');
    }
    expect(readFileSync(vaultPath, 'utf-8')).toBe('ORIGINAL-CIPHERTEXT-UNCHANGED');
    expect(unlinkedPaths).toHaveLength(1);
  });

  it.skipIf(!HAS_AGE)(
    'REAL age binary — Amendment D proof: decrypt-then-whole-rewrite reencrypts BYTE-FOR-BYTE identical plaintext ' +
      'to a new recipient set; the new recipient can decrypt afterward; a third, unrelated key still cannot',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-reencrypt-real-age-test-'));
      dirs.push(dir);
      const opKey = mintAgeKey(dir, 'operator-key.txt');
      const vmKey = mintAgeKey(dir, 'vm-key.txt');
      const strangerKey = mintAgeKey(dir, 'stranger-key.txt');
      const vaultPath = join(dir, 'vault.age');

      const plaintext = buildVaultPlaintext(PAYLOAD);
      await writeVault(plaintext, { outPath: vaultPath, recipients: [opKey.publicKey] });

      // Before: only the operator's key decrypts it; the stanza count is 1.
      const beforeStanzas = countVaultRecipientStanzas(readFileSync(vaultPath));
      expect(beforeStanzas).toBe(1);
      const beforePlaintext = spawnSync('age', ['-d', '-i', opKey.keyPath, vaultPath], { encoding: 'utf-8' });
      expect(beforePlaintext.status, beforePlaintext.stderr).toBe(0);

      await reencryptVault(vaultPath, opKey.keyPath, [opKey.publicKey, vmKey.publicKey]);

      // After: the stanza count reflects the NEW recipient set.
      const afterStanzas = countVaultRecipientStanzas(readFileSync(vaultPath));
      expect(afterStanzas).toBe(2);

      // The operator's key STILL decrypts it, to the EXACT SAME bytes as
      // before (Amendment D: never a read-modify-write — the payload is
      // byte-for-byte unchanged, only the recipient set differs):
      const afterViaOperator = spawnSync('age', ['-d', '-i', opKey.keyPath, vaultPath], { encoding: 'utf-8' });
      expect(afterViaOperator.status, afterViaOperator.stderr).toBe(0);
      expect(afterViaOperator.stdout).toBe(beforePlaintext.stdout);
      expect(afterViaOperator.stdout).toBe(plaintext);

      // The NEW recipient (the VM's key) can now decrypt it too, to the SAME bytes:
      const afterViaVm = spawnSync('age', ['-d', '-i', vmKey.keyPath, vaultPath], { encoding: 'utf-8' });
      expect(afterViaVm.status, afterViaVm.stderr).toBe(0);
      expect(afterViaVm.stdout).toBe(beforePlaintext.stdout);

      // A third, unrelated key must NOT decrypt it — proves this isn't accidentally permissive:
      const decryptStranger = spawnSync('age', ['-d', '-i', strangerKey.keyPath, vaultPath], { encoding: 'utf-8' });
      expect(decryptStranger.status).not.toBe(0);
    },
  );

  it.skipIf(!HAS_AGE)(
    'REAL age binary — a WRONG identity (cannot decrypt the CURRENT vault) fails loud and leaves the original vault untouched',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-reencrypt-real-age-test-'));
      dirs.push(dir);
      const rightKey = mintAgeKey(dir, 'right-key.txt');
      const wrongKey = mintAgeKey(dir, 'wrong-key.txt');
      const vmKey = mintAgeKey(dir, 'vm-key.txt');
      const vaultPath = join(dir, 'vault.age');
      await writeVault(buildVaultPlaintext(PAYLOAD), { outPath: vaultPath, recipients: [rightKey.publicKey] });
      const before = readFileSync(vaultPath);

      try {
        await reencryptVault(vaultPath, wrongKey.keyPath, [rightKey.publicKey, vmKey.publicKey]);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(VaultError);
        expect((e as VaultError).code).toBe('vault_decrypt_failed');
      }
      // Original vault is byte-for-byte untouched — still decryptable by the RIGHT key, still 1 recipient:
      expect(readFileSync(vaultPath)).toEqual(before);
      expect(countVaultRecipientStanzas(readFileSync(vaultPath))).toBe(1);
      const stillDecrypts = spawnSync('age', ['-d', '-i', rightKey.keyPath, vaultPath], { encoding: 'utf-8' });
      expect(stillDecrypts.status, stillDecrypts.stderr).toBe(0);
      // No temp file left behind either:
      expect(existsSync(`${vaultPath}.reencrypt-`)).toBe(false);
    },
  );

  it.skipIf(!HAS_AGE)(
    'REAL age binary — a DUPLICATE recipient in the list produces a MATCHING duplicate stanza count (age does not dedupe) — ' +
      'confirms stanzaCount === recipients.length exactly at write time',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-reencrypt-real-age-test-'));
      dirs.push(dir);
      const key = mintAgeKey(dir, 'key.txt');
      const vaultPath = join(dir, 'vault.age');
      await writeVault(buildVaultPlaintext(PAYLOAD), { outPath: vaultPath, recipients: [key.publicKey, key.publicKey] });
      expect(countVaultRecipientStanzas(readFileSync(vaultPath))).toBe(2);
      const result = readVaultRecipientCount(vaultPath);
      expect(result).toEqual({ status: 'counted', count: 2 });
    },
  );
});

describe('assertNoDroppedVaultKeys — the provenance guard (DR-043 Amendment D, groundnuty/macf#989)', () => {
  it('does not throw when the composed map is a superset of the existing map (the ordinary compose shape)', () => {
    const existing = { A: '1', B: '2' };
    const composed = { A: '1', B: '2', C: '3' };
    expect(() => assertNoDroppedVaultKeys(existing, composed)).not.toThrow();
  });

  it('does not throw when a shared key\'s VALUE changed (an overwrite is not a drop)', () => {
    const existing = { A: '1' };
    const composed = { A: 'CHANGED' };
    expect(() => assertNoDroppedVaultKeys(existing, composed)).not.toThrow();
  });

  it('throws vault_would_drop_keys when the composed map is missing a key the existing map had — the decisive safety property', () => {
    const existing = { A: '1', B: '2', C: '3' };
    const composed = { A: '1', C: '3' }; // B silently dropped
    try {
      assertNoDroppedVaultKeys(existing, composed);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_would_drop_keys');
      expect((e as VaultError).message).toContain('B');
      // Key NAMES are fine to surface (never secret); values never appear:
      expect((e as VaultError).message).not.toContain('2');
    }
  });

  it('lists every dropped key, not just the first', () => {
    const existing = { A: '1', B: '2', C: '3' };
    const composed = {}; // everything dropped
    try {
      assertNoDroppedVaultKeys(existing, composed);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as VaultError).message).toContain('A');
      expect((e as VaultError).message).toContain('B');
      expect((e as VaultError).message).toContain('C');
      expect((e as VaultError).message).toContain('3 key');
    }
  });
});

describe('composeAndWriteVault — orchestration (injected deps, no real age, groundnuty/macf#989)', () => {
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

  it('refuses with vault_no_recipients when recipients is empty — no decrypt/encrypt seam is ever invoked', async () => {
    let decryptCalled = false;
    let encryptCalled = false;
    try {
      await composeAndWriteVault('/fake/vault.age', '/fake/identity.txt', "MACF_X_APP_ID='1'\n", [], {
        decrypt: async () => {
          decryptCalled = true;
          return '';
        },
        encrypt: async () => {
          encryptCalled = true;
        },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_no_recipients');
    }
    expect(decryptCalled).toBe(false);
    expect(encryptCalled).toBe(false);
  });

  it('merges the decrypted CURRENT vault with the new receipts and encrypts the composed plaintext — prior keys AND new keys both present', async () => {
    let encryptedPlaintext: string | undefined;
    const result = await composeAndWriteVault(
      '/fake/vault.age',
      '/fake/identity.txt',
      "MACF_AGENT_CODE_AGENT_APP_ID='new-app-id'\n",
      ['age1fake'],
      {
        exists: () => true,
        assertIdentityReadable: () => {},
        decrypt: async () => "MACF_AGENT_SCIENCE_AGENT_APP_ID='old-app-id'\nMACF_AGENT_SCIENCE_AGENT_CLIENT_SECRET='OLD-SECRET'\n",
        encrypt: async (plaintext) => {
          encryptedPlaintext = plaintext;
        },
        rename: () => {}, // no real temp file was written — the fake encrypt above is a no-op
        unlink: () => {},
      },
    );
    expect(result).toEqual({ path: '/fake/vault.age', versioned: false });
    expect(encryptedPlaintext).toContain("MACF_AGENT_SCIENCE_AGENT_APP_ID='old-app-id'");
    expect(encryptedPlaintext).toContain("MACF_AGENT_SCIENCE_AGENT_CLIENT_SECRET='OLD-SECRET'");
    expect(encryptedPlaintext).toContain("MACF_AGENT_CODE_AGENT_APP_ID='new-app-id'");
  });

  it('a shared key is won by the NEW receipt (this run\'s fresher value supersedes the vault\'s prior one)', async () => {
    let encryptedPlaintext: string | undefined;
    await composeAndWriteVault('/fake/vault.age', '/fake/identity.txt', "MACF_AGENT_X_APP_ID='NEW'\n", ['age1fake'], {
      exists: () => true,
      assertIdentityReadable: () => {},
      decrypt: async () => "MACF_AGENT_X_APP_ID='OLD'\n",
      encrypt: async (plaintext) => {
        encryptedPlaintext = plaintext;
      },
      rename: () => {},
      unlink: () => {},
    });
    expect(encryptedPlaintext).toBe("MACF_AGENT_X_APP_ID='NEW'\n");
  });

  it('propagates a readVault failure (e.g. wrong identity) — never attempts to encrypt', async () => {
    let encryptCalled = false;
    await expect(
      composeAndWriteVault('/fake/vault.age', '/fake/identity.txt', "MACF_X_APP_ID='1'\n", ['age1fake'], {
        exists: () => true,
        assertIdentityReadable: () => {},
        decrypt: async () => {
          throw new VaultError('vault_decrypt_failed', 'simulated wrong identity');
        },
        encrypt: async () => {
          encryptCalled = true;
        },
      }),
    ).rejects.toThrow(/simulated wrong identity/);
    expect(encryptCalled).toBe(false);
  });

  it('propagates an encrypt failure and cleans up the temp file (never leaves a partial file, never touches vaultPath)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-compose-test-'));
    dirs.push(dir);
    const vaultPath = join(dir, 'vault.age');
    writeFileSync(vaultPath, 'ORIGINAL-CIPHERTEXT-UNCHANGED');
    const unlinkedPaths: string[] = [];
    await expect(
      composeAndWriteVault(vaultPath, '/fake/identity.txt', "MACF_AGENT_X_APP_ID='1'\n", ['age1fake'], {
        exists: () => true,
        assertIdentityReadable: () => {},
        decrypt: async () => "MACF_AGENT_Y_APP_ID='2'\n",
        encrypt: async () => {
          throw new Error('simulated age encrypt failure');
        },
        unlink: (p) => unlinkedPaths.push(p),
      }),
    ).rejects.toThrow(/simulated age encrypt failure/);
    expect(readFileSync(vaultPath, 'utf-8')).toBe('ORIGINAL-CIPHERTEXT-UNCHANGED');
    expect(unlinkedPaths).toHaveLength(1);
    expect(unlinkedPaths[0]).toMatch(/vault\.age\.compose-.*\.tmp$/);
  });

  it('propagates a rename failure (temp encrypted successfully, but the atomic swap itself failed) and cleans up the temp file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-compose-test-'));
    dirs.push(dir);
    const vaultPath = join(dir, 'vault.age');
    writeFileSync(vaultPath, 'ORIGINAL-CIPHERTEXT-UNCHANGED');
    const unlinkedPaths: string[] = [];
    try {
      await composeAndWriteVault(vaultPath, '/fake/identity.txt', "MACF_AGENT_X_APP_ID='1'\n", ['age1fake'], {
        exists: () => true,
        assertIdentityReadable: () => {},
        decrypt: async () => "MACF_AGENT_Y_APP_ID='2'\n",
        encrypt: async () => {
          /* pretend the temp file was written */
        },
        rename: () => {
          throw new Error('simulated rename failure');
        },
        unlink: (p) => unlinkedPaths.push(p),
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_compose_rename_failed');
    }
    expect(readFileSync(vaultPath, 'utf-8')).toBe('ORIGINAL-CIPHERTEXT-UNCHANGED');
    expect(unlinkedPaths).toHaveLength(1);
  });

  it.skipIf(!HAS_AGE)(
    'REAL age binary — the decisive property: composing a SECOND agent into an already-provisioned vault leaves the ' +
      'FIRST agent\'s secret decryptable, byte-for-byte, alongside the new one (DR-043 Amendment D, groundnuty/macf#989)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-compose-real-age-test-'));
      dirs.push(dir);
      const opKey = mintAgeKey(dir, 'operator-key.txt');
      const vaultPath = join(dir, 'vault.age');

      // Seed: ONE agent already provisioned (mirrors a real first apply).
      const scienceAgent: VaultAgentSecrets = {
        appHandle: deriveAppHandle(FLEET, 'science-agent'),
        appId: 'app-science-agent',
        installId: 'install-science-agent',
        clientId: 'Iv1.science',
        clientSecret: 'SENTINEL-SCIENCE-CLIENT-SECRET',
        webhookSecret: 'SENTINEL-SCIENCE-WEBHOOK-SECRET',
        pem: '-----BEGIN RSA PRIVATE KEY-----\nSCIENCE-PEM-BYTES\n-----END RSA PRIVATE KEY-----\n',
      };
      const seedPlaintext = buildVaultPlaintext({ agents: [scienceAgent] });
      await writeVault(seedPlaintext, { outPath: vaultPath, recipients: [opKey.publicKey] });
      const seedRaw = parseVaultPlaintext(seedPlaintext);

      // The second agent's fresh receipt — exactly what `applyFleet`'s
      // `settleVault` would hand to `composeAndWriteVault` this run.
      const codeAgent: VaultAgentSecrets = {
        appHandle: deriveAppHandle(FLEET, 'code-agent'),
        appId: 'app-code-agent',
        installId: 'install-code-agent',
        clientId: 'Iv1.code',
        clientSecret: 'SENTINEL-CODE-CLIENT-SECRET',
        webhookSecret: 'SENTINEL-CODE-WEBHOOK-SECRET',
        pem: '-----BEGIN RSA PRIVATE KEY-----\nCODE-PEM-BYTES\n-----END RSA PRIVATE KEY-----\n',
      };
      const newPlaintext = buildVaultPlaintext({ agents: [codeAgent] });

      const result = await composeAndWriteVault(vaultPath, opKey.keyPath, newPlaintext, [opKey.publicKey]);
      expect(result).toEqual({ path: vaultPath, versioned: false });

      // Decrypt the FINAL vault and assert BOTH agents' credentials are present:
      const afterPlaintext = spawnSync('age', ['-d', '-i', opKey.keyPath, vaultPath], { encoding: 'utf-8' });
      expect(afterPlaintext.status, afterPlaintext.stderr).toBe(0);
      const afterRaw = parseVaultPlaintext(afterPlaintext.stdout);

      // The decisive assertion — every prior key survives with its EXACT
      // prior VALUE (per-key comparison, not whole-plaintext equality —
      // `serializeVaultRawMap`'s sorted-key output is not byte-identical to
      // `buildVaultPlaintext`'s insertion-order output even when every value
      // is unchanged):
      for (const [key, value] of Object.entries(seedRaw)) {
        expect(afterRaw[key]).toBe(value);
      }
      // The new agent's keys are ALSO present, with THEIR values:
      const newRaw = parseVaultPlaintext(newPlaintext);
      for (const [key, value] of Object.entries(newRaw)) {
        expect(afterRaw[key]).toBe(value);
      }
      // Total key count is the sum — nothing extra, nothing missing:
      expect(Object.keys(afterRaw).sort()).toEqual([...Object.keys(seedRaw), ...Object.keys(newRaw)].sort());
    },
  );

  it.skipIf(!HAS_AGE)(
    'REAL age binary — a WRONG identity (cannot decrypt the CURRENT vault) fails loud and leaves the original vault untouched',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-compose-real-age-test-'));
      dirs.push(dir);
      const rightKey = mintAgeKey(dir, 'right-key.txt');
      const wrongKey = mintAgeKey(dir, 'wrong-key.txt');
      const vaultPath = join(dir, 'vault.age');
      await writeVault(buildVaultPlaintext(PAYLOAD), { outPath: vaultPath, recipients: [rightKey.publicKey] });
      const before = readFileSync(vaultPath);

      try {
        await composeAndWriteVault(vaultPath, wrongKey.keyPath, "MACF_AGENT_X_APP_ID='1'\n", [rightKey.publicKey]);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(VaultError);
        expect((e as VaultError).code).toBe('vault_decrypt_failed');
      }
      // Original vault is byte-for-byte untouched:
      expect(readFileSync(vaultPath)).toEqual(before);
      const stillDecrypts = spawnSync('age', ['-d', '-i', rightKey.keyPath, vaultPath], { encoding: 'utf-8' });
      expect(stillDecrypts.status, stillDecrypts.stderr).toBe(0);
    },
  );
});
