import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createCA, encryptCAKey, decryptCAKey, loadCA, backupCAKey, recoverCAKey,
  isLikelyPemPrivateKey, encryptCAKeyV1Legacy,
  WIRE_FORMAT_VERSION, V2_PBKDF2_ITERS, V1_PBKDF2_ITERS,
  CaError,
} from '../../src/certs/ca.js';
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

    it('writes v2 JSON envelope with iter=600000 and base64 Salted__ payload (#115)', () => {
      const encrypted = encryptCAKey('test-key', 'pass');
      // v2 output is JSON, not raw base64 (DR-011 rev2).
      const envelope = JSON.parse(encrypted) as { v: number; iter: number; payload: string };
      expect(envelope.v).toBe(WIRE_FORMAT_VERSION);
      expect(envelope.v).toBe(2);
      expect(envelope.iter).toBe(V2_PBKDF2_ITERS);
      expect(envelope.iter).toBe(600000);
      // Payload is the OpenSSL-compatible base64 Salted__ blob.
      const decoded = Buffer.from(envelope.payload, 'base64');
      expect(decoded.subarray(0, 8).toString('utf-8')).toBe('Salted__');
    });

    it('fails with wrong passphrase — PEM-shape check catches 100% of attempts (#94 / #115)', () => {
      // Pre-#99: AES-CBC + PKCS7 produced valid-padding garbage on ~6% of
      // wrong passphrases, leading to confusing downstream failures.
      // #99 added a PEM-shape check that closes the gap: wrong-passphrase
      // output never has both BEGIN+END markers, so throw rate is 100%.
      //
      // At the post-#115 600k iter count, each PBKDF2 run is ~100× slower
      // than the old 10k pre-#115 baseline; we use N=10 here (was 100 in
      // the #99 test). The point is "all N throw", not "100 specifically."
      // 10 iterations gives ~10^-12 confidence the gap hasn't reopened.
      const pem =
        '-----BEGIN PRIVATE KEY-----\n' +
        'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ' +
        'C7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV\n' +
        '-----END PRIVATE KEY-----\n';
      const encrypted = encryptCAKey(pem, 'correct-password');
      for (let i = 0; i < 10; i++) {
        expect(() => decryptCAKey(encrypted, `wrong-${i}`)).toThrow(CaError);
      }
    }, 30000);

    it('fails with wrong passphrase on v1-shaped legacy input (#115 — dual-read)', () => {
      // Same property on the v1 code path (fast: 10k iter) so we can
      // run more iterations cheaply without the PBKDF2 cost of v2.
      const pem =
        '-----BEGIN PRIVATE KEY-----\n' +
        'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ' +
        'C7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV\n' +
        '-----END PRIVATE KEY-----\n';
      const v1Blob = encryptCAKeyV1Legacy(pem, 'correct-password');
      for (let i = 0; i < 100; i++) {
        expect(() => decryptCAKey(v1Blob, `wrong-${i}`)).toThrow(CaError);
      }
    });

    it('decrypts a v1-shaped (legacy, iter=10000) blob — dual-read (#115)', () => {
      // Read-compat for workspaces that haven't yet run `macf update`
      // after DR-011 rev2.
      const pem =
        '-----BEGIN PRIVATE KEY-----\n' +
        'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ' +
        'C7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV\n' +
        '-----END PRIVATE KEY-----\n';
      const v1Blob = encryptCAKeyV1Legacy(pem, 'legacy-pass');
      // v1 blob is raw base64 — never parses as JSON (base64 alphabet
      // excludes `{`), so decryptCAKey dispatches to v1 path.
      expect(v1Blob.startsWith('{')).toBe(false);
      const decrypted = decryptCAKey(v1Blob, 'legacy-pass');
      expect(decrypted).toBe(pem);
    });

    it('V1_PBKDF2_ITERS and V2_PBKDF2_ITERS constants match DR-011 rev2', () => {
      expect(V1_PBKDF2_ITERS).toBe(10000);
      expect(V2_PBKDF2_ITERS).toBe(600000);
    });

    it('fails with invalid format', () => {
      const badData = Buffer.from('not-salted-data').toString('base64');
      expect(() => decryptCAKey(badData, 'pass')).toThrow(CaError);
      expect(() => decryptCAKey(badData, 'pass')).toThrow('Salted__');
    });

    it('fails with corrupted ciphertext (bit-flip) — #94 complement, v2 envelope (#115)', () => {
      const pem =
        '-----BEGIN PRIVATE KEY-----\n' +
        'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ' +
        'C7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV\n' +
        '-----END PRIVATE KEY-----\n';
      const encrypted = encryptCAKey(pem, 'pass');
      // Post-#115: output is JSON envelope. Flip a bit inside the
      // base64 payload, re-wrap, and expect decrypt to fail.
      const envelope = JSON.parse(encrypted) as { v: number; iter: number; payload: string };
      const bytes = Buffer.from(envelope.payload, 'base64');
      bytes[20] ^= 0x01; // After Salted__ + 8-byte salt → inside ciphertext.
      const corrupted = JSON.stringify({
        v: envelope.v,
        iter: envelope.iter,
        payload: bytes.toString('base64'),
      });
      expect(() => decryptCAKey(corrupted, 'pass')).toThrow(CaError);
    }, 15000);

    it('rejects malformed v2 envelope (#115)', () => {
      // v2 JSON shape but missing required fields — must throw, not
      // silently fall through to v1 path.
      expect(() => decryptCAKey('{"v":2}', 'pass')).toThrow(CaError);
      expect(() => decryptCAKey('{"v":2,"iter":600000}', 'pass')).toThrow(CaError);
      expect(() => decryptCAKey('{"v":2,"payload":"abc"}', 'pass')).toThrow(CaError);
      expect(() => decryptCAKey('{"v":3,"iter":1,"payload":"abc"}', 'pass')).toThrow(CaError);
      expect(() => decryptCAKey('{"v":2,"iter":-1,"payload":"abc"}', 'pass')).toThrow(CaError);
    });

    it('rejects envelope with iter above MAX_ENVELOPE_ITER (ultrareview C1 — CPU-DoS guard)', () => {
      // Attacker with registry-write access could store an envelope
      // with `iter: 2^31 - 1` and block the Node main thread on
      // pbkdf2Sync for effectively unbounded time. The parseV2Envelope
      // validator now rejects iter above 10_000_000 — already ~16× the
      // current 600k policy, well above any plausible future bump.
      //
      // The rejection path doesn't run PBKDF2 at all (parse returns
      // null → decryptCAKey throws 'Invalid v2 envelope' before
      // reaching the KDF), so tests run fast regardless of iter value.
      const attackerIter = '{"v":2,"iter":2147483647,"payload":"UwBBQUFBQUFBQQ=="}';
      expect(() => decryptCAKey(attackerIter, 'pass')).toThrow(CaError);
      expect(() => decryptCAKey(attackerIter, 'pass')).toThrow(/Invalid v2/);

      // Just-over the cap: same rejection path, doesn't run PBKDF2.
      const justOver = '{"v":2,"iter":10000001,"payload":"UwBBQUFBQUFBQQ=="}';
      expect(() => decryptCAKey(justOver, 'pass')).toThrow(CaError);
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
