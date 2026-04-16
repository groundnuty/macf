/**
 * Wire-format compatibility regression guard (#115 per #112 review).
 *
 * Pins the invariant that BOTH DR-011 wire formats decrypt to the
 * same plaintext. This catches any future wire-format change that
 * accidentally breaks v1 read-compat — without this test, a refactor
 * that silently dropped the v1 path would pass all other tests
 * (they use encryptCAKey, which writes v2).
 *
 * Structure:
 *   1. Generate a PEM.
 *   2. Encrypt it via encryptCAKey (→ v2 JSON envelope at 600k).
 *   3. Hand-construct an equivalent v1 blob via encryptCAKeyV1Legacy
 *      (→ raw base64 Salted__ at 10k) with the SAME plaintext + passphrase.
 *   4. Assert both decrypt back to the original PEM.
 */
import { describe, it, expect } from 'vitest';
import {
  encryptCAKey, encryptCAKeyV1Legacy, decryptCAKey,
  V1_PBKDF2_ITERS, V2_PBKDF2_ITERS, WIRE_FORMAT_VERSION,
} from '../../src/certs/ca.js';

const SAMPLE_PEM =
  '-----BEGIN PRIVATE KEY-----\n' +
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ' +
  'C7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV\n' +
  '-----END PRIVATE KEY-----\n';

describe('wire-format compatibility (#115)', () => {
  it('v2 (current) decrypts to original plaintext', () => {
    const encrypted = encryptCAKey(SAMPLE_PEM, 'same-pass');
    const decrypted = decryptCAKey(encrypted, 'same-pass');
    expect(decrypted).toBe(SAMPLE_PEM);
  });

  it('v1 (legacy) decrypts to original plaintext', () => {
    const v1Blob = encryptCAKeyV1Legacy(SAMPLE_PEM, 'same-pass');
    const decrypted = decryptCAKey(v1Blob, 'same-pass');
    expect(decrypted).toBe(SAMPLE_PEM);
  });

  it('v1 and v2 round-trip the same plaintext', () => {
    const v2 = encryptCAKey(SAMPLE_PEM, 'same-pass');
    const v1 = encryptCAKeyV1Legacy(SAMPLE_PEM, 'same-pass');

    expect(decryptCAKey(v2, 'same-pass')).toBe(SAMPLE_PEM);
    expect(decryptCAKey(v1, 'same-pass')).toBe(SAMPLE_PEM);
    expect(decryptCAKey(v2, 'same-pass')).toBe(decryptCAKey(v1, 'same-pass'));
  });

  it('v1 blob does NOT parse as a v2 JSON envelope (dispatch safety)', () => {
    const v1 = encryptCAKeyV1Legacy(SAMPLE_PEM, 'p');
    // base64 alphabet doesn't include `{` — safe-by-construction
    // dispatch guarantee that v1 can never be mistaken for v2.
    expect(v1.startsWith('{')).toBe(false);
  });

  it('v2 envelope has the exact shape DR-011 rev2 specifies', () => {
    const v2 = encryptCAKey(SAMPLE_PEM, 'p');
    const envelope = JSON.parse(v2) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(['iter', 'payload', 'v']);
    expect(envelope['v']).toBe(WIRE_FORMAT_VERSION);
    expect(envelope['iter']).toBe(V2_PBKDF2_ITERS);
    expect(typeof envelope['payload']).toBe('string');
    // Payload itself is a base64 Salted__ blob.
    const decoded = Buffer.from(envelope['payload'] as string, 'base64');
    expect(decoded.subarray(0, 8).toString('utf-8')).toBe('Salted__');
  });

  it('iter constants are the documented values', () => {
    // DR-011 rev2 doctrine: v2 uses 600000, v1 uses 10000 (implicit).
    expect(V2_PBKDF2_ITERS).toBe(600000);
    expect(V1_PBKDF2_ITERS).toBe(10000);
  });
});
