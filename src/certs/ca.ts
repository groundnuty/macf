import {
  createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  x509, webcrypto, RSA_ALGORITHM, CA_CERT_VALIDITY_YEARS,
} from './crypto-provider.js';
import type { GitHubVariablesClient } from '../registry/types.js';
import { toVariableSegment } from '../registry/variable-name.js';
import { MacfError } from '../errors.js';

export class CaError extends MacfError {
  constructor(message: string) {
    super('CA_ERROR', message);
    this.name = 'CaError';
  }
}

export interface CaKeyPair {
  readonly certPem: string;
  readonly keyPem: string;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function exportKeyToPem(exported: ArrayBuffer): string {
  const b64 = Buffer.from(exported).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Create a new CA certificate and key pair.
 * Saves to disk and optionally uploads cert to registry.
 */
export async function createCA(config: {
  readonly project: string;
  readonly certPath: string;
  readonly keyPath: string;
  readonly client?: GitHubVariablesClient;
}): Promise<CaKeyPair> {
  const { project, certPath, keyPath, client } = config;

  const keys = await webcrypto.subtle.generateKey(
    RSA_ALGORITHM,
    true,
    ['sign', 'verify'],
  );

  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + CA_CERT_VALIDITY_YEARS);

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(8).toString('hex'),
    name: `CN=${project}-ca`,
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALGORITHM,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 2, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });

  const certPem = cert.toString('pem');
  const exported = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const keyPem = exportKeyToPem(exported);

  // Save to disk
  ensureDir(certPath);
  writeFileSync(certPath, certPem, { mode: 0o644 });
  ensureDir(keyPath);
  writeFileSync(keyPath, keyPem, { mode: 0o600 });

  // Upload CA cert to registry (plaintext PEM)
  if (client) {
    await client.writeVariable(`${toVariableSegment(project)}_CA_CERT`, certPem);
  }

  return { certPem, keyPem };
}

/**
 * Backup CA key to registry, encrypted with AES-256-CBC + PBKDF2.
 * Format is interoperable with openssl enc -aes-256-cbc -pbkdf2.
 */
export async function backupCAKey(config: {
  readonly project: string;
  readonly keyPem: string;
  readonly passphrase: string;
  readonly client: GitHubVariablesClient;
}): Promise<void> {
  const encrypted = encryptCAKey(config.keyPem, config.passphrase);
  const varName = `${toVariableSegment(config.project)}_CA_KEY_ENCRYPTED`;
  await config.client.writeVariable(varName, encrypted);
}

/**
 * Recover CA key from registry.
 */
export async function recoverCAKey(config: {
  readonly project: string;
  readonly passphrase: string;
  readonly keyPath: string;
  readonly client: GitHubVariablesClient;
}): Promise<string> {
  const varName = `${toVariableSegment(config.project)}_CA_KEY_ENCRYPTED`;
  const encrypted = await config.client.readVariable(varName);
  if (encrypted === null) {
    throw new CaError('No encrypted CA key found in registry');
  }

  const keyPem = decryptCAKey(encrypted, config.passphrase);

  ensureDir(config.keyPath);
  writeFileSync(config.keyPath, keyPem, { mode: 0o600 });

  return keyPem;
}

/**
 * Encrypt CA key using AES-256-CBC + PBKDF2, interoperable with openssl enc.
 * Format: "Salted__" + 8-byte salt + ciphertext, then base64.
 *
 * Manual recovery with openssl CLI:
 *   base64 -d < encrypted.txt | openssl enc -aes-256-cbc -pbkdf2 -md sha256 -iter 10000 -d -out ca-key.pem
 */
export function encryptCAKey(keyPem: string, passphrase: string): string {
  const salt = randomBytes(8);
  const keyIv = pbkdf2Sync(passphrase, salt, 10000, 48, 'sha256');
  const key = keyIv.subarray(0, 32);
  const iv = keyIv.subarray(32, 48);

  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(keyPem, 'utf-8'),
    cipher.final(),
  ]);

  // OpenSSL format: "Salted__" + 8-byte salt + ciphertext
  const result = Buffer.concat([
    Buffer.from('Salted__'),
    salt,
    encrypted,
  ]);

  return result.toString('base64');
}

/**
 * Decrypt CA key encrypted with encryptCAKey.
 * Interoperable with: openssl enc -aes-256-cbc -pbkdf2 -md sha256 -iter 10000 -d
 */
export function decryptCAKey(encryptedBase64: string, passphrase: string): string {
  const data = Buffer.from(encryptedBase64, 'base64');

  const magic = data.subarray(0, 8).toString('utf-8');
  if (magic !== 'Salted__') {
    throw new CaError('Invalid encrypted CA key format (missing Salted__ header)');
  }

  const salt = data.subarray(8, 16);
  const ciphertext = data.subarray(16);

  const keyIv = pbkdf2Sync(passphrase, salt, 10000, 48, 'sha256');
  const key = keyIv.subarray(0, 32);
  const iv = keyIv.subarray(32, 48);

  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

/**
 * Load CA cert and key from disk.
 */
export function loadCA(certPath: string, keyPath: string): CaKeyPair {
  if (!existsSync(certPath)) {
    throw new CaError(`CA certificate not found: ${certPath}`);
  }
  if (!existsSync(keyPath)) {
    throw new CaError(`CA key not found: ${keyPath}`);
  }

  return {
    certPem: readFileSync(certPath, 'utf-8'),
    keyPem: readFileSync(keyPath, 'utf-8'),
  };
}
