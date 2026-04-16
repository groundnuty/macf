import {
  createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
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

// Tight perms on the leaf so the CA private key's parent dir isn't
// world-traversable even when this path is hit outside `certs init`
// (e.g. recoverCAKey in a fresh env). mkdirSync's `mode` is ANDed
// with the process umask, so follow up with chmodSync to guarantee
// 0o700 regardless of umask. Intermediate dirs keep umask defaults —
// they're usually ~/.macf/ or similar and not key-adjacent. (#107)
function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
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
 *
 * Throws on:
 *   - missing `Salted__` header (ciphertext not in our expected format)
 *   - PKCS7 padding failure (wrong passphrase, ~94% of the time)
 *   - decrypted content doesn't look like a PEM private key (wrong
 *     passphrase that happened to produce valid PKCS7 padding by
 *     chance — ~6% of the time; see #94). Without the shape check,
 *     `recoverCAKey` would write garbage to disk as the CA key,
 *     producing confusing failures further down the TLS path.
 *
 * The PEM-shape check is a semantic verification, not cryptographic
 * authentication — AES-CBC has no built-in integrity. Adding HMAC would
 * break OpenSSL CLI interop (DR-011). The shape check catches the
 * observable failure mode without changing the on-wire format.
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
  let decryptedBuf: Buffer;
  try {
    decryptedBuf = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } catch {
    // AES-CBC padding failure — most wrong-passphrase attempts hit
    // this path. Generic error so callers can re-prompt.
    throw new CaError('Decryption failed (wrong passphrase or corrupted ciphertext)');
  }

  const decrypted = decryptedBuf.toString('utf-8');
  if (!isLikelyPemPrivateKey(decrypted)) {
    // Passphrase happened to produce valid PKCS7 padding by chance but
    // the plaintext is random garbage. See #94.
    throw new CaError('Decryption failed (wrong passphrase or corrupted ciphertext)');
  }

  return decrypted;
}

/**
 * Cheap semantic check: does this look like a PEM-encoded private key?
 * Exported for unit tests. Doesn't validate DER content — only the
 * PEM envelope.
 *
 * Random bytes faking BOTH the 28-char BEGIN and 26-char END markers
 * simultaneously is ~2^-432 per decrypted buffer — effectively
 * impossible. No minimum body length is needed; the markers alone are
 * the distinguisher.
 */
export function isLikelyPemPrivateKey(text: string): boolean {
  // PKCS#8 ("-----BEGIN PRIVATE KEY-----") or legacy RSA/EC variants.
  const beginIdx = text.search(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  if (beginIdx < 0) return false;
  const endIdx = text.search(/-----END [A-Z ]*PRIVATE KEY-----/);
  if (endIdx <= beginIdx) return false;
  return true;
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
