import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createCA, encryptCAKey, decryptCAKey, loadCA, backupCAKey, recoverCAKey, isLikelyPemPrivateKey, CaError } from '../../src/certs/ca.js';
import type { GitHubVariablesClient } from '../../src/registry/types.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-ca-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockClient(): GitHubVariablesClient {
  return {
    writeVariable: vi.fn().mockResolvedValue(undefined),
    readVariable: vi.fn().mockResolvedValue(null),
    listVariables: vi.fn().mockResolvedValue([]),
    deleteVariable: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CA management', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('createCA', () => {
    it('generates valid CA cert and key PEM files', async () => {
      const certPath = join(dir, 'ca-cert.pem');
      const keyPath = join(dir, 'ca-key.pem');

      const result = await createCA({
        project: 'MACF',
        certPath,
        keyPath,
      });

      expect(result.certPem).toContain('-----BEGIN CERTIFICATE-----');
      expect(result.keyPem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(existsSync(certPath)).toBe(true);
      expect(existsSync(keyPath)).toBe(true);
    });

    it('uploads CA cert to registry when client provided', async () => {
      const client = mockClient();
      const result = await createCA({
        project: 'MACF',
        certPath: join(dir, 'ca-cert.pem'),
        keyPath: join(dir, 'ca-key.pem'),
        client,
      });

      expect(client.writeVariable).toHaveBeenCalledWith(
        'MACF_CA_CERT',
        expect.stringContaining('-----BEGIN CERTIFICATE-----'),
      );
    });

    it('sanitizes hyphens in project name (issue #46)', async () => {
      const client = mockClient();
      await createCA({
        project: 'academic-resume',
        certPath: join(dir, 'ca-cert.pem'),
        keyPath: join(dir, 'ca-key.pem'),
        client,
      });

      // Before the fix this was ACADEMIC-RESUME_CA_CERT which GitHub rejects.
      expect(client.writeVariable).toHaveBeenCalledWith(
        'ACADEMIC_RESUME_CA_CERT',
        expect.stringContaining('-----BEGIN CERTIFICATE-----'),
      );
    });

    it('creates nested directories for cert paths', async () => {
      const certPath = join(dir, 'nested', 'deep', 'ca-cert.pem');
      const keyPath = join(dir, 'nested', 'deep', 'ca-key.pem');

      await createCA({ project: 'TEST', certPath, keyPath });

      expect(existsSync(certPath)).toBe(true);
      expect(existsSync(keyPath)).toBe(true);
    });

    it('creates CA parent dir with 0o700 mode (#107)', async () => {
      // Defense-in-depth: ensureDir should use 0o700 on the leaf so
      // the CA private key's parent dir isn't world-traversable even
      // when the caller didn't pre-create it with tight mode.
      const certPath = join(dir, 'ca-subdir', 'ca-cert.pem');
      const keyPath = join(dir, 'ca-subdir', 'ca-key.pem');

      await createCA({ project: 'TEST', certPath, keyPath });

      const mode = statSync(join(dir, 'ca-subdir')).mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });

  describe('encryptCAKey / decryptCAKey', () => {
    it('round-trips encryption correctly', () => {
      const original = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBg...\n-----END PRIVATE KEY-----\n';
      const passphrase = 'test-passphrase-123';

      const encrypted = encryptCAKey(original, passphrase);
      expect(encrypted).not.toContain('PRIVATE KEY');

      const decrypted = decryptCAKey(encrypted, passphrase);
      expect(decrypted).toBe(original);
    });

    it('produces base64 output with Salted__ header', () => {
      const encrypted = encryptCAKey('test-key', 'pass');
      const decoded = Buffer.from(encrypted, 'base64');
      expect(decoded.subarray(0, 8).toString('utf-8')).toBe('Salted__');
    });

    it('fails with wrong passphrase (#94 — 100 iterations must all throw)', () => {
      // Previously flaky at ~6% per attempt because AES-CBC + PKCS7
      // sometimes produces valid-padding garbage without throwing. The
      // decryptCAKey semantic check (isLikelyPemPrivateKey) closes the
      // gap: wrong-passphrase output never has both PEM markers, so the
      // throw rate is now 100%. 100 iterations provides >99.999% confidence
      // (prior flake probability 0.06^100 ≈ 10^-122).
      const pem =
        '-----BEGIN PRIVATE KEY-----\n' +
        'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ' +
        'C7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV\n' +
        '-----END PRIVATE KEY-----\n';
      const encrypted = encryptCAKey(pem, 'correct-password');
      for (let i = 0; i < 100; i++) {
        expect(() => decryptCAKey(encrypted, `wrong-${i}`)).toThrow(CaError);
      }
    });

    it('fails with invalid format', () => {
      const badData = Buffer.from('not-salted-data').toString('base64');
      expect(() => decryptCAKey(badData, 'pass')).toThrow(CaError);
      expect(() => decryptCAKey(badData, 'pass')).toThrow('Salted__');
    });

    it('fails with corrupted ciphertext (bit-flip) — #94 complement', () => {
      const pem =
        '-----BEGIN PRIVATE KEY-----\n' +
        'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ' +
        'C7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV\n' +
        '-----END PRIVATE KEY-----\n';
      const encrypted = encryptCAKey(pem, 'pass');
      const bytes = Buffer.from(encrypted, 'base64');
      // Flip one bit in the ciphertext portion (after Salted__ + 8-byte salt)
      bytes[20] ^= 0x01;
      const corrupted = bytes.toString('base64');
      expect(() => decryptCAKey(corrupted, 'pass')).toThrow(CaError);
    });

    it('round-trips a realistic PEM body through encrypt/decrypt', () => {
      const pem =
        '-----BEGIN PRIVATE KEY-----\n' +
        'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ' +
        'C7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV\n' +
        '-----END PRIVATE KEY-----\n';
      const encrypted = encryptCAKey(pem, 'my-passphrase');
      const decrypted = decryptCAKey(encrypted, 'my-passphrase');
      expect(decrypted).toBe(pem);
    });
  });

  describe('isLikelyPemPrivateKey (#94 semantic check)', () => {
    it('accepts PKCS#8 PEM', () => {
      expect(isLikelyPemPrivateKey(
        '-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----\n',
      )).toBe(true);
    });

    it('accepts legacy RSA PEM', () => {
      expect(isLikelyPemPrivateKey(
        '-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----\n',
      )).toBe(true);
    });

    it('accepts EC PEM', () => {
      expect(isLikelyPemPrivateKey(
        '-----BEGIN EC PRIVATE KEY-----\nbody\n-----END EC PRIVATE KEY-----\n',
      )).toBe(true);
    });

    it('rejects plain garbage', () => {
      expect(isLikelyPemPrivateKey('random garbage bytes')).toBe(false);
      expect(isLikelyPemPrivateKey('')).toBe(false);
      expect(isLikelyPemPrivateKey('\x00\x01\x02\x03')).toBe(false);
    });

    it('rejects PEM with only BEGIN marker', () => {
      expect(isLikelyPemPrivateKey('-----BEGIN PRIVATE KEY-----\nbody')).toBe(false);
    });

    it('rejects PEM with only END marker', () => {
      expect(isLikelyPemPrivateKey('body\n-----END PRIVATE KEY-----')).toBe(false);
    });

    it('rejects END-before-BEGIN ordering', () => {
      expect(isLikelyPemPrivateKey(
        '-----END PRIVATE KEY-----\nfoo\n-----BEGIN PRIVATE KEY-----',
      )).toBe(false);
    });

    it('rejects non-private-key PEM (certificate)', () => {
      expect(isLikelyPemPrivateKey(
        '-----BEGIN CERTIFICATE-----\nbody\n-----END CERTIFICATE-----\n',
      )).toBe(false);
    });
  });

  describe('backupCAKey / recoverCAKey', () => {
    it('round-trips via registry', async () => {
      const client = mockClient();
      const keyPem = '-----BEGIN PRIVATE KEY-----\ntest-key-data\n-----END PRIVATE KEY-----\n';
      const passphrase = 'backup-pass';

      await backupCAKey({
        project: 'MACF',
        keyPem,
        passphrase,
        client,
      });

      expect(client.writeVariable).toHaveBeenCalledWith(
        'MACF_CA_KEY_ENCRYPTED',
        expect.any(String),
      );

      // Get what was written and use it to mock the read
      const encryptedValue = vi.mocked(client.writeVariable).mock.calls[0]![1];
      vi.mocked(client.readVariable).mockResolvedValueOnce(encryptedValue);

      const keyPath = join(dir, 'recovered-key.pem');
      const recovered = await recoverCAKey({
        project: 'MACF',
        passphrase,
        keyPath,
        client,
      });

      expect(recovered).toBe(keyPem);
      expect(existsSync(keyPath)).toBe(true);
    });

    it('recoverCAKey creates key parent dir with 0o700 mode (#107)', async () => {
      const client = mockClient();
      const keyPem = '-----BEGIN PRIVATE KEY-----\ntest-key-data\n-----END PRIVATE KEY-----\n';
      const passphrase = 'backup-pass';

      await backupCAKey({ project: 'MACF', keyPem, passphrase, client });
      const encryptedValue = vi.mocked(client.writeVariable).mock.calls[0]![1];
      vi.mocked(client.readVariable).mockResolvedValueOnce(encryptedValue);

      const keyPath = join(dir, 'recover-subdir', 'ca-key.pem');
      await recoverCAKey({ project: 'MACF', passphrase, keyPath, client });

      const mode = statSync(join(dir, 'recover-subdir')).mode & 0o777;
      expect(mode).toBe(0o700);
    });

    it('throws when no encrypted key in registry', async () => {
      const client = mockClient();

      await expect(recoverCAKey({
        project: 'MACF',
        passphrase: 'pass',
        keyPath: join(dir, 'key.pem'),
        client,
      })).rejects.toThrow(CaError);
    });
  });

  describe('loadCA', () => {
    it('loads existing cert and key', async () => {
      const certPath = join(dir, 'ca-cert.pem');
      const keyPath = join(dir, 'ca-key.pem');

      const created = await createCA({ project: 'TEST', certPath, keyPath });
      const loaded = loadCA(certPath, keyPath);

      expect(loaded.certPem).toBe(created.certPem);
      expect(loaded.keyPem).toBe(created.keyPem);
    });

    it('throws when cert not found', () => {
      expect(() => loadCA('/nonexistent/cert.pem', '/nonexistent/key.pem')).toThrow(CaError);
    });
  });
});
