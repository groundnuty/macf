import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHealthState,
  leafCertExpiry,
  mapTurnStateMarker,
  computeOtelEndpointInfo,
  parseEndpointHostPort,
  createOtelReachabilityProbe,
  HEALTH_SCHEMA_VERSION,
} from '../src/health.js';
import { receiptSinkPathFromLog, type ProcessedReceipt } from '../src/comms-ledger.js';
import { EXPECTED_VERSION } from './version-helper.js';

/** Minimal turn-receipt factory for the DR-030 last_processed wiring tests. */
function receipt(ts: string, over: Partial<ProcessedReceipt> = {}): ProcessedReceipt {
  return {
    ts: Date.parse(ts),
    run_id: '27123456',
    agent: 'code-agent',
    ...over,
  };
}

// Env hygiene: clear the DR-030 self-report env so ambient OTEL_*/MACF_* in the
// CI shell can't make createHealthState read a real marker file or fire a real
// TCP probe. Each test sets exactly what it needs; the originals are restored.
const ENV_KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'MACF_OTEL_ENDPOINT', 'MACF_WORKSPACE_DIR'];
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

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
    // DR-006 watchdog hard-version contract (macf-devops-toolkit#115): always
    // emitted so a consumer can assert it + refuse an unknown version.
    expect(health.health_schema_version).toBe(HEALTH_SCHEMA_VERSION);
    expect(health.last_notification).toBeNull();
    // DR-030 self-report fields default to null when no opts are passed.
    expect(health.instance_id).toBeNull();
    expect(health.cert_expiry).toBeNull();
    expect(health.last_processed).toBeNull();
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

// --- DR-030 phase-1 increment B: turn-state ('state') ---

describe('mapTurnStateMarker', () => {
  const NOW = 1_000_000;

  it('maps a busy marker, computing elapsed_ms = now − started_at', () => {
    expect(
      mapTurnStateMarker(
        {
          turn_number: 7,
          status: 'busy',
          started_at: NOW - 5000,
          ended_at: null,
          phase: 'tool',
          current_tool: 'Bash',
          current_command: 'make build',
          tool_started_at: NOW - 4000,
          last_turn_duration_ms: 43000,
          tool_use_count: 12,
          output_tokens: 2048,
        },
        NOW,
      ),
    ).toEqual({
      status: 'busy',
      turn_number: 7,
      elapsed_ms: 5000,
      phase: 'tool',
      current_tool: 'Bash',
      current_command: 'make build',
      last_turn_duration_ms: 43000,
      tool_use_count: 12,
      output_tokens: 2048,
    });
  });

  it('maps an idle marker with elapsed_ms = 0', () => {
    expect(
      mapTurnStateMarker(
        { turn_number: 8, status: 'idle', started_at: NOW - 99999, phase: null, last_turn_duration_ms: 12000 },
        NOW,
      ),
    ).toEqual({
      status: 'idle',
      turn_number: 8,
      elapsed_ms: 0,
      phase: null,
      current_tool: null,
      current_command: null,
      last_turn_duration_ms: 12000,
      tool_use_count: null,
      output_tokens: null,
    });
  });

  it('clamps elapsed_ms to 0 on backwards clock skew', () => {
    expect(
      mapTurnStateMarker({ turn_number: 1, status: 'busy', started_at: NOW + 5000 }, NOW)?.elapsed_ms,
    ).toBe(0);
  });

  it('returns null for non-objects and markers missing required shape', () => {
    expect(mapTurnStateMarker(null, NOW)).toBeNull();
    expect(mapTurnStateMarker('nope', NOW)).toBeNull();
    expect(mapTurnStateMarker({}, NOW)).toBeNull();
    expect(mapTurnStateMarker({ status: 'busy' }, NOW)).toBeNull(); // no turn_number
    expect(mapTurnStateMarker({ status: 'weird', turn_number: 1 }, NOW)).toBeNull();
    expect(mapTurnStateMarker({ status: 'idle', turn_number: -1 }, NOW)).toBeNull();
  });

  it('coerces wrong-typed optional fields to null (lenient pass-through)', () => {
    expect(
      mapTurnStateMarker(
        { turn_number: 2, status: 'busy', started_at: NOW, phase: 'bogus', current_tool: 5, tool_use_count: 'x' },
        NOW,
      ),
    ).toMatchObject({ phase: null, current_tool: null, tool_use_count: null });
  });
});

describe('createHealthState — DR-030 state (turn-state marker)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T18:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the marker at turnStatePath and recomputes elapsed_ms each call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-turnstate-'));
    const p = join(dir, 'turn-state.json');
    const startedAt = Date.now() - 5000; // 5s before the fake clock
    writeFileSync(
      p,
      JSON.stringify({
        turn_number: 7,
        status: 'busy',
        started_at: startedAt,
        ended_at: null,
        phase: 'tool',
        current_tool: 'Bash',
        current_command: 'make build',
        tool_started_at: startedAt + 1000,
        last_turn_duration_ms: 43000,
        tool_use_count: 12,
        output_tokens: 2048,
      }),
    );
    try {
      const state = createHealthState('code-agent', 'permanent', {
        turnStatePath: p,
        otelProbe: async () => false,
      });
      expect(state.getHealth().state).toEqual({
        status: 'busy',
        turn_number: 7,
        elapsed_ms: 5000,
        phase: 'tool',
        current_tool: 'Bash',
        current_command: 'make build',
        last_turn_duration_ms: 43000,
        tool_use_count: 12,
        output_tokens: 2048,
      });
      // elapsed_ms grows live through a (simulated) 60s wait — fresh per call.
      vi.advanceTimersByTime(60_000);
      expect(state.getHealth().state?.elapsed_ms).toBe(65_000);
      state.dispose?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('state is null when the marker file is missing', () => {
    const state = createHealthState('code-agent', 'permanent', {
      turnStatePath: join(tmpdir(), 'macf-no-such-turn-state.json'),
      otelProbe: async () => false,
    });
    expect(state.getHealth().state).toBeNull();
    state.dispose?.();
  });

  it('state is null when the marker file is garbage (graceful, never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-turnstate-'));
    const p = join(dir, 'turn-state.json');
    writeFileSync(p, 'not json at all {{{');
    try {
      const state = createHealthState('code-agent', 'permanent', {
        turnStatePath: p,
        otelProbe: async () => false,
      });
      expect(state.getHealth().state).toBeNull();
      state.dispose?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- DR-030 phase-1 increment B: OTLP self-report ('otel') ---

describe('computeOtelEndpointInfo', () => {
  it('endpoint null + not canonical when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
    expect(computeOtelEndpointInfo({})).toEqual({ endpoint: null, endpoint_is_canonical: false });
  });

  it('canonical when endpoint equals MACF_OTEL_ENDPOINT', () => {
    expect(
      computeOtelEndpointInfo({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://mon:4318',
        MACF_OTEL_ENDPOINT: 'http://mon:4318',
      }),
    ).toEqual({ endpoint: 'http://mon:4318', endpoint_is_canonical: true });
  });

  it('not canonical when endpoint differs from MACF_OTEL_ENDPOINT', () => {
    expect(
      computeOtelEndpointInfo({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:4318',
        MACF_OTEL_ENDPOINT: 'http://b:4318',
      }).endpoint_is_canonical,
    ).toBe(false);
  });

  it('not canonical when MACF_OTEL_ENDPOINT is unset even if an endpoint is set', () => {
    expect(
      computeOtelEndpointInfo({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:4318' }),
    ).toEqual({ endpoint: 'http://a:4318', endpoint_is_canonical: false });
  });
});

describe('parseEndpointHostPort', () => {
  it('parses host + explicit port', () => {
    expect(parseEndpointHostPort('http://host.example:4318')).toEqual({
      host: 'host.example',
      port: 4318,
    });
  });

  it('defaults the port by scheme when absent', () => {
    expect(parseEndpointHostPort('https://h.example')).toEqual({ host: 'h.example', port: 443 });
    expect(parseEndpointHostPort('http://h.example')).toEqual({ host: 'h.example', port: 80 });
  });

  it('ignores the path component', () => {
    expect(parseEndpointHostPort('http://h.example:4318/v1/traces')).toEqual({
      host: 'h.example',
      port: 4318,
    });
  });

  it('returns null for an unparseable endpoint', () => {
    expect(parseEndpointHostPort('not a url')).toBeNull();
    expect(parseEndpointHostPort('')).toBeNull();
  });
});

describe('createOtelReachabilityProbe', () => {
  it('defaults to false, then caches true after a successful probe', async () => {
    const probe = createOtelReachabilityProbe('http://h:4318', { probe: async () => true });
    expect(probe.get()).toBe(false); // before the first probe completes
    await probe.runOnce();
    expect(probe.get()).toBe(true);
    probe.stop();
  });

  it('caches false on probe failure', async () => {
    const probe = createOtelReachabilityProbe('http://h:4318', { probe: async () => false });
    await probe.runOnce();
    expect(probe.get()).toBe(false);
    probe.stop();
  });

  it('treats a throwing probe as unreachable (graceful)', async () => {
    const probe = createOtelReachabilityProbe('http://h:4318', {
      probe: () => Promise.reject(new Error('boom')),
    });
    await probe.runOnce();
    expect(probe.get()).toBe(false);
    probe.stop();
  });

  it('is always false with no endpoint; start() is a no-op (probe never called)', async () => {
    const probe = vi.fn(async () => true);
    const r = createOtelReachabilityProbe(null, { probe });
    r.start();
    await r.runOnce();
    expect(r.get()).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    r.stop();
  });
});

describe('createHealthState — DR-030 otel self-report', () => {
  it('emits endpoint + canonical from env; reachable is the cached default (false)', () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://mon.example:4318';
    process.env['MACF_OTEL_ENDPOINT'] = 'http://mon.example:4318';
    // Inject a probe so no real network is touched; reachable stays the cached
    // default (false) because the async probe hasn't resolved at this sync read.
    const state = createHealthState('code-agent', 'permanent', { otelProbe: async () => true });
    expect(state.getHealth().otel).toEqual({
      endpoint: 'http://mon.example:4318',
      endpoint_is_canonical: true,
      endpoint_reachable: false,
    });
    state.dispose?.();
  });

  it('emits endpoint:null + reachable:false when OTLP endpoint is unset', () => {
    const state = createHealthState('code-agent', 'permanent');
    expect(state.getHealth().otel).toEqual({
      endpoint: null,
      endpoint_is_canonical: false,
      endpoint_reachable: false,
    });
    state.dispose?.();
  });
});

// --- DR-030 phase-1 (groundnuty/macf#568): last_processed (passive-receipt self-report) ---

describe('createHealthState — DR-030 last_processed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 5s after the newest test receipt below, so age_ms is a round 2000.
    vi.setSystemTime(new Date('2026-06-08T00:00:05.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the most-recent receipt (run_id→correlation_token), age_ms fresh per call', () => {
    const receipts = [
      receipt('2026-06-08T00:00:01.000Z', { run_id: '41' }),
      receipt('2026-06-08T00:00:03.000Z', { run_id: '42' }),
      receipt('2026-06-08T00:00:02.000Z', { run_id: '40' }),
    ];
    const state = createHealthState('code-agent', 'permanent', {
      processedReader: () => receipts,
      otelProbe: async () => false,
    });
    expect(state.getHealth().last_processed).toEqual({
      at: '2026-06-08T00:00:03.000Z',
      anchor: null,
      age_ms: 2000,
      correlation_token: '42',
    });
    // age_ms grows live through a (simulated) 60s wait — recomputed per call.
    vi.advanceTimersByTime(60_000);
    expect(state.getHealth().last_processed?.age_ms).toBe(62_000);
    state.dispose?.();
  });

  it('last_processed is null with no receipt source (no logPath, no reader)', () => {
    const state = createHealthState('code-agent', 'permanent', { otelProbe: async () => false });
    expect(state.getHealth().last_processed).toBeNull();
    state.dispose?.();
  });

  it('last_processed is null when the reader yields no receipts', () => {
    const state = createHealthState('code-agent', 'permanent', {
      processedReader: () => [],
      otelProbe: async () => false,
    });
    expect(state.getHealth().last_processed).toBeNull();
    state.dispose?.();
  });

  it('reads from a real receipt sink at logPath (sibling processed-receipts.jsonl)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-lp-'));
    const logPath = join(dir, 'logs', 'channel.log');
    const sink = receiptSinkPathFromLog(logPath)!;
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(
      sink,
      [
        JSON.stringify(receipt('2026-06-08T00:00:02.000Z', { run_id: '6' })),
        JSON.stringify(receipt('2026-06-08T00:00:03.000Z', { run_id: '7' })),
      ].join('\n') + '\n',
    );
    try {
      const state = createHealthState('code-agent', 'permanent', { logPath, otelProbe: async () => false });
      expect(state.getHealth().last_processed).toEqual({
        at: '2026-06-08T00:00:03.000Z',
        anchor: null,
        age_ms: 2000,
        correlation_token: '7',
      });
      state.dispose?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
