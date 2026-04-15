import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createCA, encryptCAKey, decryptCAKey, loadCA, backupCAKey, recoverCAKey, CaError } from '../../src/certs/ca.js';
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

    it('fails with wrong passphrase', () => {
      const encrypted = encryptCAKey('secret-key', 'correct-password');
      expect(() => decryptCAKey(encrypted, 'wrong-password')).toThrow();
    });

    it('fails with invalid format', () => {
      const badData = Buffer.from('not-salted-data').toString('base64');
      expect(() => decryptCAKey(badData, 'pass')).toThrow(CaError);
      expect(() => decryptCAKey(badData, 'pass')).toThrow('Salted__');
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
