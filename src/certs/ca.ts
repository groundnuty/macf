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

// DR-011 rev2 constants. `iter` lives in the v2 envelope so future
// bumps (e.g. 600k → 1.2M) are iter-only changes without a v-bump.
// v-bumps are reserved for actual wire-format changes (envelope shape,
// algorithm swap). See design/decisions/DR-011-ca-key-backup.md.
export const WIRE_FORMAT_VERSION = 2;
export const V2_PBKDF2_ITERS = 600000;
export const V1_PBKDF2_ITERS = 10000;
// Upper bound on the envelope `iter` field. Without a cap, an
// attacker with registry-write access could store `{"v":2,"iter":
// 2147483647, ...}` and block the Node.js main thread on the next
// decryptCAKey (CPU-DoS via pbkdf2Sync). 10M is already ~16× the
// current 600k policy and well above any plausible future bump —
// any registry-stored value above this is treated as malformed.
// See ultrareview finding C1.
const MAX_ENVELOPE_ITER = 10_000_000;

interface V2Envelope {
  readonly v: 2;
  readonly iter: number;
  readonly payload: string;
}

/**
 * Parse an on-wire value as a v2 JSON envelope, or return null for
 * anything else. Disambiguation is safe by construction: a raw base64
 * `Salted__` blob never starts with `{` (base64 alphabet excludes it),
 * so only v2 envelopes parse as JSON objects with the `v` field.
 */
function parseV2Envelope(value: string): V2Envelope | null {
  // Fast-path: base64 output never starts with `{`, so a non-`{` first
  // char is immediately v1. Skip JSON.parse for the common case.
  if (!value.trimStart().startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec['v'] !== 2) return null;
  if (typeof rec['iter'] !== 'number' || rec['iter'] < 1) return null;
  if (rec['iter'] > MAX_ENVELOPE_ITER) return null;
  if (typeof rec['payload'] !== 'string' || rec['payload'].length === 0) return null;
  return { v: 2, iter: rec['iter'], payload: rec['payload'] };
}

/**
 * Decrypt a raw `Salted__` OpenSSL-compatible blob at a given iter
 * count. Shared by v1 and v2 paths after envelope is unwrapped.
 * Throws CaError on bad shape, padding failure, or non-PEM output.
 */
function decryptSaltedBlob(payloadBase64: string, passphrase: string, iters: number): string {
  const data = Buffer.from(payloadBase64, 'base64');

  const magic = data.subarray(0, 8).toString('utf-8');
  if (magic !== 'Salted__') {
    throw new CaError('Invalid encrypted CA key format (missing Salted__ header)');
  }

  const salt = data.subarray(8, 16);
  const ciphertext = data.subarray(16);

  const keyIv = pbkdf2Sync(passphrase, salt, iters, 48, 'sha256');
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
 * Encrypt CA key using AES-256-CBC + PBKDF2-SHA256 at 600k iters
 * (DR-011 rev2, OWASP 2023 alignment). Output is a versioned JSON
 * envelope wrapping the OpenSSL-compatible `Salted__` blob:
 *
 *   {"v": 2, "iter": 600000, "payload": "<base64 Salted__ ...>"}
 *
 * Manual recovery with openssl CLI (see DR-011-rev2 for full doc):
 *   gh api ... --jq '.value' | jq -r .payload | base64 -d | \
 *     openssl enc -aes-256-cbc -pbkdf2 -md sha256 -iter 600000 -d -out ca-key.pem
 */
export function encryptCAKey(keyPem: string, passphrase: string): string {
  const salt = randomBytes(8);
  const keyIv = pbkdf2Sync(passphrase, salt, V2_PBKDF2_ITERS, 48, 'sha256');
  const key = keyIv.subarray(0, 32);
  const iv = keyIv.subarray(32, 48);

  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(keyPem, 'utf-8'),
    cipher.final(),
  ]);

  // OpenSSL format: "Salted__" + 8-byte salt + ciphertext
  const payload = Buffer.concat([
    Buffer.from('Salted__'),
    salt,
    encrypted,
  ]).toString('base64');

  const envelope: V2Envelope = {
    v: WIRE_FORMAT_VERSION as 2,
    iter: V2_PBKDF2_ITERS,
    payload,
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypt a CA key from the on-wire registry value. Dispatches by
 * wire format:
 *
 * - **v2 (JSON envelope, DR-011 rev2+):** parses `{v, iter, payload}`,
 *   decrypts `payload` at the envelope's iter count.
 * - **v1 (raw base64 `Salted__` blob, legacy pre-2026-04-16):** treats
 *   the value as a raw base64 blob and decrypts at iter=10000 (the
 *   OpenSSL 3.0/3.1 default at the time the blob was written).
 *
 * Both paths share the same PEM-shape check (#94) after AES decryption
 * to catch wrong-passphrase attempts that produce valid PKCS7 padding
 * by chance (~6% of wrong passphrases).
 *
 * Disambiguation is safe by construction — base64 output never starts
 * with `{`, so only v2 JSON envelopes hit the JSON path. See DR-011
 * rev2 \"Wire Format\" section for the full spec.
 *
 * Throws CaError on:
 *   - malformed v2 envelope (missing/invalid v/iter/payload fields)
 *   - missing `Salted__` header inside the payload
 *   - PKCS7 padding failure (wrong passphrase, ~94% of the time)
 *   - decrypted content doesn't look like a PEM private key (wrong
 *     passphrase that happened to produce valid PKCS7 padding)
 */
export function decryptCAKey(encryptedValue: string, passphrase: string): string {
  // If the value looks like JSON (starts with `{`), the caller intends
  // v2. Validate strictly and throw on malformed envelope rather than
  // fall through to v1 — otherwise a typoed envelope would produce a
  // confusing "missing Salted__" error that doesn't point at the real
  // problem.
  if (encryptedValue.trimStart().startsWith('{')) {
    const envelope = parseV2Envelope(encryptedValue);
    if (!envelope) {
      throw new CaError(
        'Invalid v2 CA key envelope (expected {"v":2, "iter":<number>, "payload":"<base64>"})',
      );
    }
    return decryptSaltedBlob(envelope.payload, passphrase, envelope.iter);
  }
  // v1 legacy path — raw base64 Salted__ blob, implicit iter=10000.
  return decryptSaltedBlob(encryptedValue, passphrase, V1_PBKDF2_ITERS);
}

/**
 * Hand-construct a v1-shaped CA key backup (legacy wire format) at
 * 10000 iters. Exported for `test/certs/wire-format-compat.test.ts`
 * regression guard and for any future tooling that needs to produce
 * legacy-shaped backups (none expected). NOT used by `encryptCAKey`
 * itself — `encryptCAKey` always writes v2. (#115)
 */
export function encryptCAKeyV1Legacy(keyPem: string, passphrase: string): string {
  const salt = randomBytes(8);
  const keyIv = pbkdf2Sync(passphrase, salt, V1_PBKDF2_ITERS, 48, 'sha256');
  const key = keyIv.subarray(0, 32);
  const iv = keyIv.subarray(32, 48);

  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(keyPem, 'utf-8'),
    cipher.final(),
  ]);

  return Buffer.concat([
    Buffer.from('Salted__'),
    salt,
    encrypted,
  ]).toString('base64');
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
