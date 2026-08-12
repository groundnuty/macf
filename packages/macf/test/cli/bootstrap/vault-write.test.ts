/**
 * Tests for `vault-write.ts` — the `vault.age` write-through (DR-043 §D5,
 * Slice 2b increment 4, groundnuty/macf#838 / macf#846 review).
 *
 * `buildVaultPlaintext` / `vaultAgentSecretsForFingerprint` /
 * `vaultFleetSecretsForFingerprint` / `writeVault`'s orchestration are pure
 * or injected-deps and fully exercised offline. `ageEncryptToFile` is the
 * one real I/O leaf — exercised for real against the actual `age` binary
 * where available (verified present on this host's PATH via `have('age')`
 * below); the suite SKIPS (not fakes) those cases when `age`/`age-keygen`
 * are absent, per the "never fake a passing test" instruction.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ageEncryptToFile,
  agentRecoveryArtifactPath,
  buildVaultPlaintext,
  removeAgentRecoveryArtifact,
  VaultError,
  vaultAgentSecretsForFingerprint,
  vaultFleetSecretsForFingerprint,
  writeAgentRecoveryArtifact,
  writeVault,
  type VaultAgentSecrets,
  type VaultPayload,
} from '../../../src/cli/bootstrap/vault-write.js';
import type { AppCredentials } from '../../../src/cli/bootstrap/manifest-exchange.js';

function have(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).status === 0;
}
const HAS_AGE = have('age') && have('age-keygen');

const AGENT: VaultAgentSecrets = {
  appHandle: 'demo-fleet-code-agent',
  appId: '111',
  installId: '222',
  clientId: 'Iv1.abc',
  clientSecret: 'client-secret-value',
  webhookSecret: 'webhook-secret-value',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n',
};

describe('buildVaultPlaintext', () => {
  it('emits MACF_AGENT_<HANDLE-SEGMENT>_* lines using the FULL derived handle, not the bare role', () => {
    const out = buildVaultPlaintext({ agents: [AGENT] });
    expect(out).toContain("MACF_AGENT_DEMO_FLEET_CODE_AGENT_APP_ID='111'");
    expect(out).toContain("MACF_AGENT_DEMO_FLEET_CODE_AGENT_INSTALL_ID='222'");
    expect(out).toContain("MACF_AGENT_DEMO_FLEET_CODE_AGENT_CLIENT_ID='Iv1.abc'");
    expect(out).toContain("MACF_AGENT_DEMO_FLEET_CODE_AGENT_CLIENT_SECRET='client-secret-value'");
    expect(out).toContain("MACF_AGENT_DEMO_FLEET_CODE_AGENT_WEBHOOK_SECRET='webhook-secret-value'");
  });

  it('base64-encodes the PEM (single-line, source-safe) and it round-trips back to the original', () => {
    const out = buildVaultPlaintext({ agents: [AGENT] });
    const match = out.match(/MACF_AGENT_DEMO_FLEET_CODE_AGENT_PRIVATE_KEY_B64='([^']*)'/);
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toContain('\n');
    expect(Buffer.from(match?.[1] ?? '', 'base64').toString('utf-8')).toBe(AGENT.pem);
  });

  it('ends with exactly one trailing newline', () => {
    const out = buildVaultPlaintext({ agents: [AGENT] });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('includes the routing block when given, matching vault.template.txt\'s 6-secret shape', () => {
    const out = buildVaultPlaintext({
      agents: [],
      routing: {
        appId: '999',
        appKeyPem: 'ROUTING-PEM',
        clientCertPem: 'CERT-PEM',
        clientKeyPem: 'KEY-PEM',
        tsOauthClientId: 'ts-client-id',
        tsOauthSecret: 'ts-secret',
      },
    });
    expect(out).toContain("MACF_ROUTING_APP_ID='999'");
    expect(out).toContain("TS_OAUTH_CLIENT_ID='ts-client-id'");
    expect(out).toContain("TS_OAUTH_SECRET='ts-secret'");
    expect(out).toContain(`ROUTING_CLIENT_CERT_B64='${Buffer.from('CERT-PEM', 'utf-8').toString('base64')}'`);
    expect(out).toContain(`ROUTING_CLIENT_KEY_B64='${Buffer.from('KEY-PEM', 'utf-8').toString('base64')}'`);
  });

  it('includes the CA block under MACF_<PROJECT>_CA_{KEY,CERT}_B64 when given', () => {
    const out = buildVaultPlaintext({
      agents: [],
      ca: { project: 'demo-fleet', caKeyPem: 'CA-KEY', caCertPem: 'CA-CERT' },
    });
    expect(out).toContain(`MACF_DEMO_FLEET_CA_KEY_B64='${Buffer.from('CA-KEY', 'utf-8').toString('base64')}'`);
    expect(out).toContain(`MACF_DEMO_FLEET_CA_CERT_B64='${Buffer.from('CA-CERT', 'utf-8').toString('base64')}'`);
  });

  it('throws VaultError(vault_empty_payload) on an entirely empty payload', () => {
    expect(() => buildVaultPlaintext({ agents: [] })).toThrow(VaultError);
    try {
      buildVaultPlaintext({ agents: [] });
    } catch (e) {
      expect((e as VaultError).code).toBe('vault_empty_payload');
    }
  });

  it('throws VaultError(vault_empty_value) on an empty raw secret value', () => {
    expect(() => buildVaultPlaintext({ agents: [{ ...AGENT, clientSecret: '' }] })).toThrow(VaultError);
  });

  it.each(["'", '\r', '\n'])(
    'throws VaultError(vault_unsafe_value) on a raw value containing %j (unrepresentable/format-breaking under vault.sh\'s single-quoted KEY=\'value\' lines, macf#848)',
    (ch) => {
      try {
        buildVaultPlaintext({ agents: [{ ...AGENT, clientSecret: `bad${ch}value` }] });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(VaultError);
        expect((e as VaultError).code).toBe('vault_unsafe_value');
      }
    },
  );

  it.each(['"', '$', '`', '\\'])(
    'ALLOWS a raw value containing %j (macf#848: inert under single-quote output + vault.sh\'s no-eval parser — ' +
      'these were guarded ONLY back when vault.sh used eval + double-quoted output)',
    (ch) => {
      expect(() => buildVaultPlaintext({ agents: [{ ...AGENT, clientSecret: `ok${ch}value` }] })).not.toThrow();
      const out = buildVaultPlaintext({ agents: [{ ...AGENT, clientSecret: `ok${ch}value` }] });
      expect(out).toContain(`MACF_AGENT_DEMO_FLEET_CODE_AGENT_CLIENT_SECRET='ok${ch}value'`);
    },
  );

  it('never leaks the secret VALUE into the thrown error message (never log/print a secret)', () => {
    try {
      buildVaultPlaintext({ agents: [{ ...AGENT, clientSecret: "bad'value" }] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as VaultError).message).not.toContain("bad'value");
    }
  });

  it('a base64-derived field (the PEM) is NEVER subject to the raw-value guard even if the raw PEM contains every guarded byte', () => {
    const withQuote: VaultAgentSecrets = {
      ...AGENT,
      pem: 'contains "quotes" and $vars and `backticks` and \\backslashes and \'single quotes\'',
    };
    expect(() => buildVaultPlaintext({ agents: [withQuote] })).not.toThrow();
  });

  it('an EMPTY appHandle is rejected rather than silently emitting a well-formed-but-wrong ' +
    'MACF_AGENT__APP_ID (double-underscore) key vault.sh could never map back to a real key file', () => {
    try {
      buildVaultPlaintext({ agents: [{ ...AGENT, appHandle: '' }] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_empty_segment_source');
    }
  });

  it('an EMPTY ca.project is likewise rejected (same silently-wrong-segment hazard)', () => {
    try {
      buildVaultPlaintext({ agents: [], ca: { project: '', caKeyPem: 'k', caCertPem: 'c' } });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe('vault_empty_segment_source');
    }
  });
});

describe('vaultAgentSecretsForFingerprint / vaultFleetSecretsForFingerprint', () => {
  it('maps exactly the 3 per-agent secret fields buildVaultPlaintext writes', () => {
    expect(vaultAgentSecretsForFingerprint(AGENT)).toEqual({
      client_secret: 'client-secret-value',
      webhook_secret: 'webhook-secret-value',
      app_private_key: AGENT.pem,
    });
  });

  it('maps fleet-level routing + CA secrets, omitting public identifiers (app id / oauth client id)', () => {
    const payload: VaultPayload = {
      agents: [],
      routing: {
        appId: '999',
        appKeyPem: 'ROUTING-PEM',
        clientCertPem: 'CERT-PEM',
        clientKeyPem: 'KEY-PEM',
        tsOauthClientId: 'ts-client-id',
        tsOauthSecret: 'ts-secret',
      },
      ca: { project: 'demo-fleet', caKeyPem: 'CA-KEY', caCertPem: 'CA-CERT' },
    };
    expect(vaultFleetSecretsForFingerprint(payload)).toEqual({
      routing_app_key: 'ROUTING-PEM',
      routing_client_cert: 'CERT-PEM',
      routing_client_key: 'KEY-PEM',
      ts_oauth_secret: 'ts-secret',
      ca_key: 'CA-KEY',
    });
  });

  it('returns {} when routing/ca are both absent', () => {
    expect(vaultFleetSecretsForFingerprint({ agents: [] })).toEqual({});
  });
});

describe('writeVault — orchestration (injected deps, no real age)', () => {
  it('throws VaultError(vault_empty_plaintext) on empty/whitespace-only plaintext', async () => {
    await expect(
      writeVault('   ', { outPath: '/tmp/x/vault.age', recipients: ['age1abc'] }),
    ).rejects.toThrow(VaultError);
  });

  it('throws VaultError(vault_no_recipients) with zero recipients', async () => {
    await expect(writeVault('KEY="v"\n', { outPath: '/tmp/x/vault.age', recipients: [] })).rejects.toThrow(
      VaultError,
    );
  });

  it('calls encrypt with the outPath unchanged + ALL recipients when nothing exists there yet', async () => {
    const calls: { plaintext: string; recipients: readonly string[]; outPath: string }[] = [];
    const result = await writeVault(
      'KEY="v"\n',
      { outPath: '/fake/secrets/vault.age', recipients: ['age1operator', 'age1vm'] },
      {
        exists: () => false,
        encrypt: async (plaintext, recipients, outPath) => {
          calls.push({ plaintext, recipients, outPath });
        },
      },
    );
    expect(result).toEqual({ path: '/fake/secrets/vault.age', versioned: false });
    expect(calls).toEqual([{ plaintext: 'KEY="v"\n', recipients: ['age1operator', 'age1vm'], outPath: '/fake/secrets/vault.age' }]);
  });

  it('refuses to clobber an existing vault by default (never calls encrypt)', async () => {
    let encryptCalled = false;
    await expect(
      writeVault(
        'KEY="v"\n',
        { outPath: '/fake/secrets/vault.age', recipients: ['age1operator'] },
        {
          exists: () => true,
          encrypt: async () => {
            encryptCalled = true;
          },
        },
      ),
    ).rejects.toThrow(/already exists — refusing to overwrite/);
    expect(encryptCalled).toBe(false);
  });

  it('the clobber error carries code vault_exists', async () => {
    try {
      await writeVault(
        'KEY="v"\n',
        { outPath: '/fake/secrets/vault.age', recipients: ['age1operator'] },
        { exists: () => true },
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as VaultError).code).toBe('vault_exists');
    }
  });

  it('allowVersion: true writes a timestamped sibling path instead of the original, using the injected clock', async () => {
    const calls: { outPath: string }[] = [];
    const fixedNow = new Date('2026-08-11T12:34:56.789Z');
    const result = await writeVault(
      'KEY="v"\n',
      { outPath: '/fake/secrets/vault.age', recipients: ['age1operator'], allowVersion: true, now: () => fixedNow },
      {
        exists: () => true,
        encrypt: async (_p, _r, outPath) => {
          calls.push({ outPath });
        },
      },
    );
    expect(result).toEqual({ path: '/fake/secrets/vault.20260811T123456Z.age', versioned: true });
    expect(calls).toEqual([{ outPath: '/fake/secrets/vault.20260811T123456Z.age' }]);
  });

  it('versioned sibling path for a no-extension outPath appends rather than inserting mid-name', async () => {
    const result = await writeVault(
      'KEY="v"\n',
      {
        outPath: '/fake/secrets/vault-noext',
        recipients: ['age1operator'],
        allowVersion: true,
        now: () => new Date('2026-08-11T00:00:00.000Z'),
      },
      { exists: () => true, encrypt: async () => {} },
    );
    expect(result.path).toBe('/fake/secrets/vault-noext.20260811T000000Z');
  });
});

describe('agentRecoveryArtifactPath / writeAgentRecoveryArtifact / removeAgentRecoveryArtifact — §D5 durable-before-gate-2', () => {
  const CREDS: AppCredentials = {
    appId: '111',
    name: 'demo-fleet-code-agent',
    slug: 'demo-fleet-code-agent',
    clientId: 'Iv1.abc',
    clientSecret: 'SENTINEL-CLIENT-SECRET',
    webhookSecret: 'SENTINEL-WEBHOOK-SECRET',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL-PEM\n-----END RSA PRIVATE KEY-----\n',
  };

  it('agentRecoveryArtifactPath: own path under <secretsDir>/recovery/, distinct from vault.age', () => {
    expect(agentRecoveryArtifactPath('/fake/secrets', 'code-agent')).toBe('/fake/secrets/recovery/code-agent.age');
  });

  it('writeAgentRecoveryArtifact throws VaultError(vault_no_age_recipient) with zero recipients — never calls encrypt', async () => {
    let encryptCalled = false;
    await expect(
      writeAgentRecoveryArtifact('code-agent', CREDS, [], '/fake/secrets/recovery/code-agent.age', async () => {
        encryptCalled = true;
      }),
    ).rejects.toThrow(VaultError);
    expect(encryptCalled).toBe(false);
  });

  it('writeAgentRecoveryArtifact creates the recovery dir for real, then encrypts a role-scoped plaintext to the exact outPath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-recovery-artifact-test-'));
    try {
      const outPath = join(dir, 'secrets', 'recovery', 'code-agent.age');
      const calls: { plaintext: string; recipients: readonly string[]; outPath: string }[] = [];
      await writeAgentRecoveryArtifact('code-agent', CREDS, ['age1operator', 'age1vm'], outPath, async (plaintext, recipients, path) => {
        calls.push({ plaintext, recipients, outPath: path });
      });
      expect(existsSync(join(dir, 'secrets', 'recovery'))).toBe(true); // mkdir -p happened for real
      expect(calls).toHaveLength(1);
      expect(calls[0]?.outPath).toBe(outPath);
      expect(calls[0]?.recipients).toEqual(['age1operator', 'age1vm']);
      expect(calls[0]?.plaintext).toContain("MACF_RECOVERY_CODE_AGENT_APP_ID='111'");
      expect(calls[0]?.plaintext).toContain("MACF_RECOVERY_CODE_AGENT_APP_SLUG='demo-fleet-code-agent'");
      expect(calls[0]?.plaintext).toContain("MACF_RECOVERY_CODE_AGENT_CLIENT_SECRET='SENTINEL-CLIENT-SECRET'");
      expect(calls[0]?.plaintext).toContain("MACF_RECOVERY_CODE_AGENT_WEBHOOK_SECRET='SENTINEL-WEBHOOK-SECRET'");
      // PEM is base64-encoded, never raw, in the plaintext:
      expect(calls[0]?.plaintext).not.toContain('SENTINEL-PEM');
      expect(calls[0]?.plaintext).toContain("MACF_RECOVERY_CODE_AGENT_PRIVATE_KEY_B64='");
      // No installId anywhere — gate 2 hasn't happened yet at write time:
      expect(calls[0]?.plaintext).not.toContain('INSTALL_ID');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a rejected encrypt (e.g. age failure) propagates — no swallowed failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-recovery-artifact-test-'));
    try {
      const outPath = join(dir, 'secrets', 'recovery', 'code-agent.age');
      await expect(
        writeAgentRecoveryArtifact('code-agent', CREDS, ['age1operator'], outPath, async () => {
          throw new Error('age exited 1: boom');
        }),
      ).rejects.toThrow(/age exited 1: boom/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removeAgentRecoveryArtifact deletes a real file for real', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-recovery-artifact-test-'));
    try {
      const outPath = join(dir, 'code-agent.age');
      writeFileSync(outPath, 'FAKE-CIPHERTEXT');
      expect(existsSync(outPath)).toBe(true);
      removeAgentRecoveryArtifact(outPath);
      expect(existsSync(outPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removeAgentRecoveryArtifact is a silent no-op (never throws) when the file is already gone', () => {
    expect(() => removeAgentRecoveryArtifact('/definitely/does/not/exist/code-agent.age')).not.toThrow();
  });
});

describe('ageEncryptToFile (real age binary)', () => {
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
    'encrypts to MULTIPLE recipients — EACH key independently decrypts the SAME plaintext — ' +
      'and no plaintext file is ever written alongside the output (D5 load-bearing property)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-vault-write-test-'));
      dirs.push(dir);
      const key1 = mintAgeKey(dir, 'operator-key.txt');
      const key2 = mintAgeKey(dir, 'vm-key.txt');

      const plaintext = 'MACF_AGENT_DEMO_CODE_AGENT_APP_ID="111"\n';
      const outPath = join(dir, 'vault.age');
      await ageEncryptToFile(plaintext, [key1.publicKey, key2.publicKey], outPath);

      // Only the two key files + the encrypted output exist — no vault.plain
      // or any other sibling ever landed on disk.
      expect(readdirSync(dir).sort()).toEqual(['operator-key.txt', 'vault.age', 'vm-key.txt'].sort());

      const d1 = spawnSync('age', ['-d', '-i', key1.keyPath, outPath], { encoding: 'utf-8' });
      expect(d1.status, d1.stderr).toBe(0);
      expect(d1.stdout).toBe(plaintext);

      const d2 = spawnSync('age', ['-d', '-i', key2.keyPath, outPath], { encoding: 'utf-8' });
      expect(d2.status, d2.stderr).toBe(0);
      expect(d2.stdout).toBe(plaintext);
    },
  );

  it.skipIf(!HAS_AGE)('a single recipient still works (v1-shape vault)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-vault-write-test-'));
    dirs.push(dir);
    const key = mintAgeKey(dir, 'k.txt');
    const outPath = join(dir, 'vault.age');
    await ageEncryptToFile('KEY="v"\n', [key.publicKey], outPath);
    const d = spawnSync('age', ['-d', '-i', key.keyPath, outPath], { encoding: 'utf-8' });
    expect(d.status, d.stderr).toBe(0);
    expect(d.stdout).toBe('KEY="v"\n');
  });

  it('rejects with VaultError(vault_encrypt_spawn_failed) — never crashes the process — when the binary cannot be spawned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-vault-write-test-'));
    dirs.push(dir);
    const savedPath = process.env.PATH;
    try {
      // Force ENOENT: no directory on PATH can resolve "age".
      process.env.PATH = '';
      await expect(ageEncryptToFile('KEY="v"\n', ['age1fake'], join(dir, 'vault.age'))).rejects.toThrow(VaultError);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('spawn-failed leaves no file at outPath (nothing was ever created — unlink is a no-op ENOENT)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-vault-write-test-'));
    dirs.push(dir);
    const outPath = join(dir, 'vault.age');
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = '';
      await expect(ageEncryptToFile('KEY="v"\n', ['age1fake'], outPath)).rejects.toThrow(VaultError);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(existsSync(outPath)).toBe(false);
  });

  // macf#847 review nit 1: `age` opens `-o outPath` before draining a large
  // STDIN, so a SIGKILL-on-timeout partway through leaves a REAL, truncated
  // file at outPath — verified empirically against the live `age` binary
  // before writing this test. Without the unlink-on-failure fix, that
  // truncated file trips `writeVault`'s clobber guard on the NEXT run,
  // trapping the operator into a manual `rm` to make a failed apply
  // re-runnable. Uses a short injected `timeoutMs` + a large plaintext so the
  // kill reliably lands mid-write without waiting out the real 30s budget.
  it.skipIf(!HAS_AGE)(
    'timeout (SIGKILL mid-write) leaves NO truncated file behind — unlink-on-failure (macf#847 nit 1)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-vault-write-test-'));
      dirs.push(dir);
      const key = mintAgeKey(dir, 'k.txt');
      const outPath = join(dir, 'vault.age');
      // 200MB — large enough that `age` has opened + started writing outPath
      // well before it can drain STDIN within the 20ms timeout below.
      const bigPlaintext = 'A'.repeat(200_000_000);

      await expect(ageEncryptToFile(bigPlaintext, [key.publicKey], outPath, 20)).rejects.toThrow(
        /did not exit within/,
      );

      expect(existsSync(outPath)).toBe(false);
    },
    15_000,
  );

  it.skipIf(!HAS_AGE)(
    'a re-run after a timeout-truncated failure succeeds (the clobber guard does not falsely trip on the cleaned-up path)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-vault-write-test-'));
      dirs.push(dir);
      const key = mintAgeKey(dir, 'k.txt');
      const outPath = join(dir, 'vault.age');
      const bigPlaintext = 'A'.repeat(200_000_000);

      await expect(ageEncryptToFile(bigPlaintext, [key.publicKey], outPath, 20)).rejects.toThrow();
      expect(existsSync(outPath)).toBe(false);

      // writeVault's default (allowVersion: false) clobber guard would reject
      // this if the truncated file had survived — it succeeding is the proof
      // the cleanup landed.
      const result = await writeVault('KEY="v"\n', { outPath, recipients: [key.publicKey] });
      expect(result).toEqual({ path: outPath, versioned: false });
      const d = spawnSync('age', ['-d', '-i', key.keyPath, outPath], { encoding: 'utf-8' });
      expect(d.status, d.stderr).toBe(0);
      expect(d.stdout).toBe('KEY="v"\n');
    },
    15_000,
  );
});
