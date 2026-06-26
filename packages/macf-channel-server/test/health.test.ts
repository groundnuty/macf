import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHealthState, leafCertExpiry } from '../src/health.js';
import { EXPECTED_VERSION } from './version-helper.js';

// A static self-signed leaf cert (CN=macf-test-leaf, notAfter 2126-06-02),
// so cert_expiry assertions are deterministic + never expire in CI.
const STATIC_LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUGpM4TeEnFq6DpkDR5PlzyUfOCkgwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwObWFjZi10ZXN0LWxlYWYwIBcNMjYwNjI2MTMxOTMwWhgP
MjEyNjA2MDIxMzE5MzBaMBkxFzAVBgNVBAMMDm1hY2YtdGVzdC1sZWFmMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoylkdPZje9GWHgtr0kk5/b1obZPE
IixjHkwS+VvfrcJmyG7MRRs3/6JjzycvUJtnjH9rE3zNn/oi5WgC2pgFR9/gCDiz
M6/dQ+CJhtjMUGMlCNcqTqV73UciDS1BJHalZGIgwiWpsE0sRBr2wrNMLwU/eLCL
bIRDuZFhx7ItCKWPlF8L5UAOvAXhG3yC6HTi9VcakjPuWf7Z0vI9ae4+YDhYbMzD
cuKl+B8G++OpV402xtV4cykdu9MZ+kOlKhOE4ASoILKFBLnAwF+ZtFNUQQgTrRgV
tQxPqTlj1vtxKWEJxz8/9+QdyHk1f4eAbL/MAAq+mzfnpwh7IkjkitCvJQIDAQAB
o1MwUTAdBgNVHQ4EFgQURlXbiYo76qp+BQ5D+OaE+IOb2tUwHwYDVR0jBBgwFoAU
RlXbiYo76qp+BQ5D+OaE+IOb2tUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAYR7CvNwkjsfLRk5GeCEGRjVY0pYf8Bi0LqvP3BpjZ5kKEd4tMdH3
Kauod3nFnUcRyYPbRtpx6AKsx+Df+laabBeYRCoppuPDk0exWrmPUqOUDgoe7DJg
QnspkJNmhTob+YpIYzSUg1PTN+ks3/6GF/F1t2JO4UOfeSkOfIxEdY47F72fmxAN
EU7JCHX8Hd4YHVvZFoX9m4irMCFGl+mQT1hCgDtlNRqffQMj8nAmSOb6XoKQBHzQ
Vz0u9zpGXOb3LAFLfQi+GZ1zSz2Kc6rccz+pAeHWd5wWdn1EuXypZhrffWJz7lme
oVT3QKQwXWcWYp1duXCMbjRLFSWrz4iemA==
-----END CERTIFICATE-----
`;
const STATIC_LEAF_CERT_NOT_AFTER = '2126-06-02T13:19:30.000Z';

describe('createHealthState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T18:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns initial health state', () => {
    const state = createHealthState('code-agent', 'permanent');
    const health = state.getHealth();

    expect(health.agent).toBe('code-agent');
    expect(health.status).toBe('online');
    expect(health.type).toBe('permanent');
    expect(health.uptime_seconds).toBe(0);
    expect(health.current_issue).toBeNull();
    expect(health.version).toBe(EXPECTED_VERSION);
    expect(health.last_notification).toBeNull();
    // DR-030 self-report fields default to null when no opts are passed.
    expect(health.instance_id).toBeNull();
    expect(health.cert_expiry).toBeNull();
  });

  it('tracks uptime in seconds', () => {
    const state = createHealthState('code-agent', 'permanent');

    vi.advanceTimersByTime(5000);
    expect(state.getHealth().uptime_seconds).toBe(5);

    vi.advanceTimersByTime(60000);
    expect(state.getHealth().uptime_seconds).toBe(65);
  });

  it('sets and clears current issue', () => {
    const state = createHealthState('code-agent', 'permanent');

    state.setCurrentIssue(42);
    expect(state.getHealth().current_issue).toBe(42);

    state.setCurrentIssue(99);
    expect(state.getHealth().current_issue).toBe(99);

    state.setCurrentIssue(null);
    expect(state.getHealth().current_issue).toBeNull();
  });

  it('records notification timestamp', () => {
    const state = createHealthState('code-agent', 'permanent');
    expect(state.getHealth().last_notification).toBeNull();

    state.recordNotification();
    expect(state.getHealth().last_notification).toBe('2026-03-28T18:00:00.000Z');

    vi.advanceTimersByTime(60000);
    state.recordNotification();
    expect(state.getHealth().last_notification).toBe('2026-03-28T18:01:00.000Z');
  });

  it('handles worker agent type', () => {
    const state = createHealthState('worker-1', 'worker');
    expect(state.getHealth().type).toBe('worker');
    expect(state.getHealth().agent).toBe('worker-1');
  });
});

describe('createHealthState — DR-030 self-report fields', () => {
  it('emits instance_id when provided, null otherwise', () => {
    expect(
      createHealthState('code-agent', 'permanent', { instanceId: 'abc123' }).getHealth().instance_id,
    ).toBe('abc123');
    expect(createHealthState('code-agent', 'permanent').getHealth().instance_id).toBeNull();
  });

  it('emits cert_expiry parsed from the leaf cert at certPath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-health-test-'));
    const certPath = join(dir, 'leaf.pem');
    writeFileSync(certPath, STATIC_LEAF_CERT);
    try {
      expect(
        createHealthState('code-agent', 'permanent', { certPath }).getHealth().cert_expiry,
      ).toBe(STATIC_LEAF_CERT_NOT_AFTER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cert_expiry is null with no certPath or an unreadable file (graceful)', () => {
    expect(createHealthState('code-agent', 'permanent').getHealth().cert_expiry).toBeNull();
    expect(
      createHealthState('code-agent', 'permanent', {
        certPath: join(tmpdir(), 'macf-does-not-exist-leaf.pem'),
      }).getHealth().cert_expiry,
    ).toBeNull();
  });
});

describe('leafCertExpiry', () => {
  it('returns the notAfter as ISO-8601 for a valid leaf cert', () => {
    expect(leafCertExpiry(STATIC_LEAF_CERT)).toBe(STATIC_LEAF_CERT_NOT_AFTER);
  });

  it('returns null for an unparseable PEM', () => {
    expect(leafCertExpiry('not a certificate')).toBeNull();
    expect(leafCertExpiry('')).toBeNull();
  });
});
