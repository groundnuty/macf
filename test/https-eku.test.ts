/**
 * Tests for the EKU verification predicate at /notify / /health / /sign
 * (#121, step 3 of the DR-004 v2 EKU rollout).
 *
 * Unit-level only — the full TLS handshake + HTTP path is exercised
 * by test/e2e/https.test.ts (requires real certs). Here we just pin
 * the predicate's behavior on synthetic peer-cert objects so future
 * refactors can't accidentally admit non-EKU certs.
 */
import { describe, it, expect } from 'vitest';
import { peerCertHasClientAuthEKU, CLIENT_AUTH_EKU_OID } from '../src/https.js';

describe('peerCertHasClientAuthEKU (#121)', () => {
  it('accepts a cert whose ext_key_usage contains clientAuth', () => {
    expect(peerCertHasClientAuthEKU({
      ext_key_usage: ['1.3.6.1.5.5.7.3.2'],
    })).toBe(true);
  });

  it('accepts a cert that has clientAuth alongside other OIDs', () => {
    // Not the shape our minter emits (see #125 pin — exactly
    // clientAuth, nothing else) but the server-side predicate
    // should admit as long as clientAuth is present.
    expect(peerCertHasClientAuthEKU({
      ext_key_usage: ['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2'],
    })).toBe(true);
  });

  it('rejects a cert with no ext_key_usage field (pre-#125 peer cert)', () => {
    // This is the primary case the EKU check exists to catch:
    // peers that haven't rotated via `macf certs rotate` after #125.
    expect(peerCertHasClientAuthEKU({})).toBe(false);
  });

  it('rejects a cert with an empty ext_key_usage array', () => {
    expect(peerCertHasClientAuthEKU({ ext_key_usage: [] })).toBe(false);
  });

  it('rejects a cert whose ext_key_usage lacks clientAuth (e.g. serverAuth only)', () => {
    // serverAuth OID is 1.3.6.1.5.5.7.3.1 — clientAuth is .3.2.
    expect(peerCertHasClientAuthEKU({
      ext_key_usage: ['1.3.6.1.5.5.7.3.1'],
    })).toBe(false);
  });

  it('rejects a cert with non-array ext_key_usage (shape defense)', () => {
    // Node's TLS API consistently returns an array, but a wrong
    // shape from a future library swap shouldn't silently admit.
    expect(peerCertHasClientAuthEKU(
      { ext_key_usage: 'clientAuth' as unknown as readonly string[] },
    )).toBe(false);
  });

  it('CLIENT_AUTH_EKU_OID constant is the RFC 5280 clientAuth OID', () => {
    expect(CLIENT_AUTH_EKU_OID).toBe('1.3.6.1.5.5.7.3.2');
  });
});
