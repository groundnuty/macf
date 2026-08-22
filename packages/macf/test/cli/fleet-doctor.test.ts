/**
 * Tests for `macf fleet doctor` — NON-invasive mesh interconnect test
 * (DR-030 phase-1 increment 1d, macf#568).
 *
 * Offline + deterministic: the registry peer-list, the mTLS `/health` probe, and
 * the diagnostic `/notify` POST are ALL injected (no network). The load-bearing
 * cases are (a) an agent reachable + accepting (both ✓), (b) one reachable but
 * NOT accepting — including the token-echo MISMATCH (a coincidental 200 must be
 * treated as ✗), and (c) one offline (Reachable ✗ → Accepted —, the ladder
 * stops at tier 1 and never POSTs).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInfo } from '@groundnuty/macf-core';
import {
  acceptFailureReason,
  acceptedGlyph,
  buildDoctorRows,
  defaultRunId,
  fleetDoctorFailureToJson,
  fleetDoctorToJson,
  FLEET_DOCTOR_JSON_SCHEMA_VERSION,
  formatDoctorTable,
  gatherFleetDoctor,
  injectableCount,
  injectSummaryLine,
  isAccepted,
  meshVerdict,
  processedGlyph,
  reachableGlyph,
  resolveFleetDoctorProjectDir,
  runFleetDoctor,
  runProcessedInject,
  sanitizeMarkerAgent,
  summaryLine,
  type DiagnosticAck,
  type FleetDiagnosticFn,
  type FleetDoctorDeps,
  type FleetDoctorFailure,
  type FleetDoctorResult,
  type FleetInjectConfig,
  type FleetProbeFn,
  type RoutingLabelDriftCheck,
} from '../../src/cli/commands/fleet-doctor.js';

function info(host: string, port: number): AgentInfo {
  return {
    host,
    port,
    type: 'permanent',
    instance_id: `${host}-${port}`,
    started: '2026-06-26T00:00:00Z',
  };
}

/** A minimal online `/health` body — only reachability matters here. */
const ONLINE = { agent: 'x', status: 'online', type: 'permanent', uptime_seconds: 1 } as never;

/** A clean ACK that echoes back the token it received (the accepting case). */
const echoingDiagnostic: FleetDiagnosticFn = async (_h, _p, token) => ({
  status: 200,
  body: { ack: true, agent: 'CODE_AGENT', instance_id: 'inst-aaaa', correlation_token: token },
});

describe('isAccepted — 200 + ack + token-echo match', () => {
  const tok = 'tok-123';
  it('green only when all three hold', () => {
    expect(isAccepted(tok, { status: 200, body: { ack: true, correlation_token: tok } })).toBe(true);
  });
  it('rejects a token-echo MISMATCH even on HTTP 200 + ack (no coincidental 200)', () => {
    expect(isAccepted(tok, { status: 200, body: { ack: true, correlation_token: 'other' } })).toBe(false);
  });
  it('rejects ack:false', () => {
    expect(isAccepted(tok, { status: 200, body: { ack: false, correlation_token: tok } })).toBe(false);
  });
  it('rejects a non-200 status', () => {
    expect(isAccepted(tok, { status: 500, body: { ack: true, correlation_token: tok } })).toBe(false);
  });
  it('rejects a missing body / no response', () => {
    expect(isAccepted(tok, { status: null, body: null, error: 'timeout' })).toBe(false);
  });
});

describe('acceptFailureReason', () => {
  const tok = 'tok-123';
  it('surfaces a transport error verbatim', () => {
    expect(acceptFailureReason(tok, { status: null, body: null, error: 'timeout' })).toBe('timeout');
  });
  it('names a no-response, an http error, an ack-false, and a token mismatch', () => {
    expect(acceptFailureReason(tok, { status: null, body: null })).toBe('no response');
    expect(acceptFailureReason(tok, { status: 503, body: {} })).toBe('http 503');
    expect(acceptFailureReason(tok, { status: 200, body: { ack: false, correlation_token: tok } })).toBe(
      'ack not true',
    );
    expect(
      acceptFailureReason(tok, { status: 200, body: { ack: true, correlation_token: 'nope' } }),
    ).toBe('correlation_token mismatch');
  });
});

describe('glyphs', () => {
  it('reachable ✓/✗', () => {
    expect(reachableGlyph(true)).toBe('✓');
    expect(reachableGlyph(false)).toBe('✗');
  });
  it('accepted ✓/✗/— (null = not attempted)', () => {
    expect(acceptedGlyph(true)).toBe('✓');
    expect(acceptedGlyph(false)).toBe('✗');
    expect(acceptedGlyph(null)).toBe('—');
  });
});

describe('gatherFleetDoctor — two-tier ladder', () => {
  const peers = [
    { name: 'CODE_AGENT', info: info('127.0.0.1', 4100) }, // reachable + accepting
    { name: 'SCIENCE_AGENT', info: info('100.64.0.2', 4200) }, // reachable, ACK mismatch
    { name: 'DEVOPS_AGENT', info: info('100.64.0.3', 4300) }, // offline
  ];
  const probe: FleetProbeFn = async (_h, port) => (port === 4300 ? null : ONLINE);
  // Port 4200 echoes back a WRONG token → not accepted; 4100 echoes correctly.
  const diagnose: FleetDiagnosticFn = async (_h, port, token) =>
    port === 4200
      ? { status: 200, body: { ack: true, correlation_token: 'WRONG' } }
      : { status: 200, body: { ack: true, agent: 'CODE_AGENT', instance_id: 'inst-aaaa', correlation_token: token } };

  it('marks reachable+accepting, reachable-not-accepting, and offline', async () => {
    const results = await gatherFleetDoctor(peers, probe, diagnose);
    expect(results).toHaveLength(3);

    expect(results[0]).toMatchObject({
      name: 'CODE_AGENT',
      reachable: true,
      accepted: true,
      ackAgent: 'CODE_AGENT',
      instanceId: 'inst-aaaa',
    });

    expect(results[1]).toMatchObject({
      name: 'SCIENCE_AGENT',
      reachable: true,
      accepted: false,
      acceptError: 'correlation_token mismatch',
    });

    expect(results[2]).toMatchObject({
      name: 'DEVOPS_AGENT',
      reachable: false,
      accepted: null,
    });
  });

  it('NEVER POSTs the diagnostic to an unreachable agent (ladder stops at tier 1)', async () => {
    const diagnoseSpy = vi.fn(diagnose);
    await gatherFleetDoctor(
      [{ name: 'DEVOPS_AGENT', info: info('100.64.0.3', 4300) }],
      probe,
      diagnoseSpy,
    );
    expect(diagnoseSpy).not.toHaveBeenCalled();
  });

  it('treats a timed-out / refused diagnostic as NOT accepted', async () => {
    const timeoutDiagnose: FleetDiagnosticFn = async () => ({ status: null, body: null, error: 'timeout' });
    const results = await gatherFleetDoctor(
      [{ name: 'CODE_AGENT', info: info('127.0.0.1', 4100) }],
      async () => ONLINE,
      timeoutDiagnose,
    );
    expect(results[0]).toMatchObject({ reachable: true, accepted: false, acceptError: 'timeout' });
  });

  it('degrades a peer whose probe REJECTS instead of aborting the whole join (macf#959, mirrors fleet.ts #609)', async () => {
    // Before the fix, `gatherFleetDoctor`'s per-peer loop called `await
    // probe(...)` with NO try/catch — a rejected probe (the same transient
    // TOCTOU-style fault `fleet.ts`'s `safeProbe` guards against) propagated
    // all the way out, through `runFleetDoctor`'s command-level catch, losing
    // the per-agent table entirely. This is the exact "Error: fetch failed,
    // no table" symptom macf#959 reported for `macf fleet doctor`.
    const rejecting: FleetProbeFn = async (_h, port) => {
      if (port === 4200) throw new Error('fetch failed');
      return port === 4100 ? ONLINE : null;
    };
    const results = await gatherFleetDoctor(peers, rejecting, diagnose);
    expect(results).toHaveLength(3); // the join still resolves with ALL THREE peers
    expect(results[0]).toMatchObject({ name: 'CODE_AGENT', reachable: true });
    // The peer whose probe rejected degrades to unreachable, same shape as a
    // genuine Tier-1 `null` — never propagated as a throw.
    expect(results[1]).toMatchObject({ name: 'SCIENCE_AGENT', reachable: false, accepted: null });
    expect(results[2]).toMatchObject({ name: 'DEVOPS_AGENT', reachable: false, accepted: null });
  });

  it('a REJECTED diagnose after a successful probe stays "reachable: true" — only Accepted degrades', async () => {
    // A peer that DID answer /health must never misreport as unreachable
    // just because a LATER tier threw (its own small silent-fallback shape).
    const rejectingDiagnose: FleetDiagnosticFn = async () => {
      throw new Error('connection reset');
    };
    const results = await gatherFleetDoctor(
      [{ name: 'CODE_AGENT', info: info('127.0.0.1', 4100) }],
      async () => ONLINE,
      rejectingDiagnose,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'CODE_AGENT',
      reachable: true, // Tier 1 held
      accepted: false,
      acceptError: 'connection reset',
    });
  });
});

describe('buildDoctorRows / formatDoctorTable', () => {
  const results: readonly FleetDoctorResult[] = [
    { name: 'CODE_AGENT', host: '127.0.0.1', port: 4100, reachable: true, accepted: true },
    { name: 'SCIENCE_AGENT', host: '100.64.0.2', port: 4200, reachable: true, accepted: false },
    { name: 'DEVOPS_AGENT', host: '100.64.0.3', port: 4300, reachable: false, accepted: null },
  ];

  it('renders ✓ / ✗ / — per the ladder state', () => {
    expect(buildDoctorRows(results)).toEqual([
      ['CODE_AGENT', '127.0.0.1:4100', '✓', '✓'],
      ['SCIENCE_AGENT', '100.64.0.2:4200', '✓', '✗'],
      ['DEVOPS_AGENT', '100.64.0.3:4300', '✗', '—'],
    ]);
  });

  it('produces an aligned table with a header + separator', () => {
    const out = formatDoctorTable(results);
    const lines = out.split('\n');
    expect(lines[0]).toContain('NAME');
    expect(lines[0]).toContain('REACHABLE');
    expect(lines[0]).toContain('ACCEPTED');
    expect(lines).toHaveLength(5); // header + separator + 3 rows
  });
});

describe('meshVerdict / summaryLine', () => {
  const ok = (n: string, p: number): FleetDoctorResult => ({
    name: n,
    host: 'h',
    port: p,
    reachable: true,
    accepted: true,
  });
  it('HEALTHY when all green', () => {
    const r = [ok('A', 1), ok('B', 2)];
    expect(meshVerdict(r)).toBe('HEALTHY');
    expect(summaryLine(r)).toBe('2/2 agents reachable + accepting; mesh interconnect: HEALTHY');
  });
  it('DEGRADED when any fail', () => {
    const r = [ok('A', 1), { name: 'B', host: 'h', port: 2, reachable: false, accepted: null }];
    expect(meshVerdict(r)).toBe('DEGRADED');
    expect(summaryLine(r)).toBe('1/2 agents reachable + accepting; mesh interconnect: DEGRADED');
  });
  it('EMPTY when no agents', () => {
    expect(meshVerdict([])).toBe('EMPTY');
  });
});

describe('fleetDoctorToJson — DR-031 watchdog contract', () => {
  it('carries summary verdict + tri-state accepted + disclaimer', () => {
    const results: readonly FleetDoctorResult[] = [
      { name: 'CODE_AGENT', host: '127.0.0.1', port: 4100, reachable: true, accepted: true, ackAgent: 'CODE_AGENT', instanceId: 'inst-aaaa' },
      { name: 'SCIENCE_AGENT', host: '100.64.0.2', port: 4200, reachable: true, accepted: false, acceptError: 'correlation_token mismatch' },
      { name: 'DEVOPS_AGENT', host: '100.64.0.3', port: 4300, reachable: false, accepted: null },
    ];
    const json = fleetDoctorToJson(results, 'macf') as {
      schema_version: number;
      project: string;
      summary: { total: number; reachable: number; accepting: number; verdict: string };
      agents: ReadonlyArray<Record<string, unknown>>;
      disclaimer: string;
    };

    // DR-006 watchdog hard-version contract (macf-devops-toolkit#115): the
    // consumer asserts schema_version === <known> and refuses an unknown, so a
    // breaking change fails LOUD rather than silently misreading.
    expect(json.schema_version).toBe(FLEET_DOCTOR_JSON_SCHEMA_VERSION);
    expect(json.project).toBe('macf');
    expect(json.summary).toEqual({ total: 3, reachable: 2, accepting: 1, verdict: 'DEGRADED' });
    expect(json.agents).toHaveLength(3);
    expect(json.agents[0]).toMatchObject({
      name: 'CODE_AGENT',
      reachable: true,
      accepted: true,
      ack_agent: 'CODE_AGENT',
      instance_id: 'inst-aaaa',
      accept_error: null,
    });
    expect(json.agents[1]).toMatchObject({ accepted: false, accept_error: 'correlation_token mismatch' });
    expect(json.agents[2]).toMatchObject({ reachable: false, accepted: null, ack_agent: null });
    expect(json.disclaimer).toMatch(/protocol-to-server/);
  });
});

describe('runFleetDoctor (injected deps)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    logSpy?.mockRestore();
  });

  const deps = (
    peers: readonly { name: string; info: AgentInfo }[],
    probe: FleetProbeFn,
    diagnose: FleetDiagnosticFn,
  ): FleetDoctorDeps => ({ project: 'macf', listPeers: async () => peers, probe, diagnose });

  it('prints the ladder table + summary + honesty legend; exits non-zero when DEGRADED', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const peers = [
      { name: 'CODE_AGENT', info: info('127.0.0.1', 4100) },
      { name: 'DEVOPS_AGENT', info: info('100.64.0.3', 4300) },
    ];
    const probe: FleetProbeFn = async (_h, port) => (port === 4300 ? null : ONLINE);

    const code = await runFleetDoctor('/unused', {}, deps(peers, probe, echoingDiagnostic));
    expect(code).toBe(1); // DEGRADED → non-zero
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('macf fleet doctor — macf');
    expect(out).toContain('CODE_AGENT');
    expect(out).toContain('REACHABLE');
    expect(out).toContain('mesh interconnect: DEGRADED');
    // Honesty legend rendered LOUDLY.
    expect(out).toContain('non-invasive checks');
    expect(out).toContain('prove the protocol REACHES THE SERVER');
    expect(out).toContain('--inject');
  });

  it('exits 0 when the whole mesh is HEALTHY', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const peers = [{ name: 'CODE_AGENT', info: info('127.0.0.1', 4100) }];
    const code = await runFleetDoctor('/unused', {}, deps(peers, async () => ONLINE, echoingDiagnostic));
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('mesh interconnect: HEALTHY');
  });

  it('emits JSON under --json (stable watchdog contract)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const peers = [
      { name: 'CODE_AGENT', info: info('127.0.0.1', 4100) },
      { name: 'DEVOPS_AGENT', info: info('100.64.0.3', 4300) },
    ];
    const probe: FleetProbeFn = async (_h, port) => (port === 4300 ? null : ONLINE);

    const code = await runFleetDoctor('/unused', { json: true }, deps(peers, probe, echoingDiagnostic));
    expect(code).toBe(1); // DEGRADED still surfaces via exit code
    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed.summary.verdict).toBe('DEGRADED');
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.agents[0]).toMatchObject({ name: 'CODE_AGENT', reachable: true, accepted: true });
    expect(parsed.agents[1]).toMatchObject({ name: 'DEVOPS_AGENT', reachable: false, accepted: null });
  });

  it('reports an empty registry cleanly (exit 0)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runFleetDoctor('/unused', {}, deps([], async () => null, echoingDiagnostic));
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/No agents registered/);
  });
});

// --- --manifest routing-label-drift check (groundnuty/macf#1059) ---
//
// `runFleetDoctor`'s own drift check reads a real `fleet.yaml` + scans the
// real filesystem (`detectRoutingLabelDriftFromManifestFile`, already
// covered end-to-end by `test/cli/bootstrap/routing-label-drift.test.ts`).
// Here the injected `routingLabelDriftCheck` seam on `FleetDoctorDeps`
// exercises ONLY the wiring — option threading, JSON rendering, exit-code
// folding, text-mode section — without touching a real fs.
describe('runFleetDoctor --manifest (routing-label drift wiring, macf#1059)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    logSpy?.mockRestore();
  });

  const healthyMeshDeps = (
    routingLabelDriftCheck: (manifestPath: string | undefined) => RoutingLabelDriftCheck | undefined,
  ): FleetDoctorDeps => ({
    project: 'icsoc-2026',
    listPeers: async () => [{ name: 'SCIENCE_AGENT', info: info('127.0.0.1', 4100) }],
    probe: async () => ONLINE,
    diagnose: echoingDiagnostic,
    routingLabelDriftCheck,
  });

  it('is never invoked with a manifest path, and contributes nothing, when --manifest is omitted', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = vi.fn((manifestPath: string | undefined) => {
      expect(manifestPath).toBeUndefined();
      return undefined;
    });
    const code = await runFleetDoctor('/unused', {}, healthyMeshDeps(check));
    expect(code).toBe(0);
    expect(check).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Routing-label drift');
  });

  it('DECISIVE: a drift entry names BOTH the declared role and the recorded label in text output, and flips exit to non-zero', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = (manifestPath: string | undefined): RoutingLabelDriftCheck => {
      expect(manifestPath).toBe('fleet.yaml');
      return {
        ok: true,
        manifestPath: 'fleet.yaml',
        entries: [
          {
            role: 'science-agent',
            manifestSource: 'fleet.yaml',
            status: 'drift',
            recordedLabel: 'sci',
            configSource: '/ws/science-agent',
            reason: 'role "science-agent" declared in fleet.yaml vs routing label "sci" recorded in /ws/science-agent',
          },
        ],
      };
    };

    const code = await runFleetDoctor('/unused', { manifest: 'fleet.yaml' }, healthyMeshDeps(check));

    expect(code).toBe(1); // mesh itself is healthy — drift alone flips the exit code
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('role "science-agent"');
    expect(out).toContain('routing label "sci"');
  });

  it('a fully clean drift report does not affect exit code, and renders per-role clean markers', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = (): RoutingLabelDriftCheck => ({
      ok: true,
      manifestPath: 'fleet.yaml',
      entries: [
        {
          role: 'science-agent',
          manifestSource: 'fleet.yaml',
          status: 'clean',
          recordedLabel: 'science-agent',
          configSource: '/ws/science-agent',
        },
      ],
    });

    const code = await runFleetDoctor('/unused', { manifest: 'fleet.yaml' }, healthyMeshDeps(check));

    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('science-agent');
  });

  it('a check that FAILED to load the manifest also flips exit to non-zero and surfaces the error', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = (): RoutingLabelDriftCheck => ({
      ok: false,
      manifestPath: 'bad.yaml',
      error: 'ENOENT: no such file',
    });

    const code = await runFleetDoctor('/unused', { manifest: 'bad.yaml' }, healthyMeshDeps(check));

    expect(code).toBe(1);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('FAILED');
  });

  it('under --json, adds the additive routing_label_drift field without touching schema_version', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = (): RoutingLabelDriftCheck => ({
      ok: true,
      manifestPath: 'fleet.yaml',
      entries: [
        {
          role: 'science-agent',
          manifestSource: 'fleet.yaml',
          status: 'unknown',
          recordedLabel: null,
          configSource: null,
          reason: 'no locally discovered workspace',
        },
      ],
    });

    const code = await runFleetDoctor('/unused', { json: true, manifest: 'fleet.yaml' }, healthyMeshDeps(check));

    expect(code).toBe(0); // unknown is neither clean nor drift — does not flip the exit code
    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed.schema_version).toBe(FLEET_DOCTOR_JSON_SCHEMA_VERSION);
    expect(parsed.routing_label_drift).toMatchObject({
      manifest: 'fleet.yaml',
      agents: [{ role: 'science-agent', status: 'unknown', recorded_label: null }],
    });
  });

  it('omits routing_label_drift entirely under --json when --manifest was not given (no schema shift)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runFleetDoctor(
      '/unused',
      { json: true },
      healthyMeshDeps(() => undefined),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed.routing_label_drift).toBeUndefined();
  });
});

// --- DR-030 §3 Processed-now `--inject` tier (macf#568 final increment) ---

describe('sanitizeMarkerAgent / defaultRunId — marker-regex legality', () => {
  it('lowercases + maps out-of-class chars to `-` (emit-turn-receipt grep is [a-z0-9-])', () => {
    // An UNsanitized `MACF_Science_Agent` would break the whole-marker grep
    // → no receipt → false UNCONFIRMED. Sanitize keeps the marker matchable.
    expect(sanitizeMarkerAgent('MACF_Science_Agent')).toBe('macf-science-agent');
    expect(sanitizeMarkerAgent('code-agent')).toBe('code-agent');
    expect(sanitizeMarkerAgent('___')).toBe('agent'); // empty after strip → fallback
  });
  it('defaultRunId is DIGITS-ONLY (marker run_id is [0-9]+)', () => {
    expect(defaultRunId()).toMatch(/^[0-9]+$/);
  });
});

describe('processedGlyph — ✓ / ? / —', () => {
  it('✓ processed, ? unconfirmed (NOT ✗), — not-attempted', () => {
    expect(processedGlyph(true)).toBe('✓');
    expect(processedGlyph(false)).toBe('?');
    expect(processedGlyph(null)).toBe('—');
    expect(processedGlyph(undefined)).toBe('—');
  });
});

describe('runProcessedInject — POST a marker probe, poll /health for the run_id', () => {
  const peer = { name: 'code-agent', info: info('127.0.0.1', 4100) };

  it('GREEN: run_id echoes back via /health.last_processed within the window', async () => {
    let polls = 0;
    const inject: FleetInjectConfig = {
      post: async () => ({ delivered: true }),
      poll: async () => { polls++; return polls >= 2 ? '777' : null; }, // appears on 2nd poll
      genRunId: () => '777',
      maxPolls: 4,
      pollIntervalMs: 1,
      sleep: async () => {}, // no real waits
    };
    const r = await runProcessedInject(peer, 'code-agent', inject);
    expect(r).toMatchObject({ processedInject: true, injectRunId: '777' });
    expect(r.injectError).toBeUndefined();
  });

  it('UNCONFIRMED: delivered but never echoes within the poll window', async () => {
    const inject: FleetInjectConfig = {
      post: async () => ({ delivered: true }),
      poll: async () => null,
      genRunId: () => '777',
      maxPolls: 3,
      pollIntervalMs: 1,
      sleep: async () => {},
    };
    const r = await runProcessedInject(peer, 'code-agent', inject);
    expect(r.processedInject).toBe(false);
    expect(r.injectError).toMatch(/unconfirmed/);
  });

  it('POST not delivered → false, and NEVER polls', async () => {
    const pollSpy = vi.fn(async () => '777');
    const inject: FleetInjectConfig = {
      post: async () => ({ delivered: false, error: 'http 502' }),
      poll: pollSpy,
      genRunId: () => '777',
      sleep: async () => {},
    };
    const r = await runProcessedInject(peer, 'code-agent', inject);
    expect(r).toMatchObject({ processedInject: false, injectError: 'http 502' });
    expect(pollSpy).not.toHaveBeenCalled();
  });

  it('routes the SANITIZED marker agent + the generated run_id', async () => {
    const postSpy = vi.fn(async () => ({ delivered: true }));
    const inject: FleetInjectConfig = {
      post: postSpy,
      poll: async () => '777',
      genRunId: () => '777',
      maxPolls: 1,
      sleep: async () => {},
    };
    await runProcessedInject(peer, 'MACF_Science_Agent', inject);
    expect(postSpy).toHaveBeenCalledWith('127.0.0.1', 4100, '777', 'macf-science-agent');
  });
});

describe('gatherFleetDoctor — Processed inject tier', () => {
  const peers = [
    { name: 'code-agent', info: info('127.0.0.1', 4100) }, // reachable + processed
    { name: 'science-agent', info: info('100.64.0.2', 4200) }, // reachable, unconfirmed
    { name: 'devops-agent', info: info('100.64.0.3', 4300) }, // offline
  ];
  const probe: FleetProbeFn = async (_h, port) => (port === 4300 ? null : ONLINE);
  const inject = (): FleetInjectConfig => ({
    post: async () => ({ delivered: true }),
    poll: async (_h, port) => (port === 4100 ? '777' : null), // only code-agent echoes
    genRunId: () => '777',
    maxPolls: 2,
    pollIntervalMs: 1,
    sleep: async () => {},
  });

  it('marks processed ✓ / unconfirmed / not-attempted(null)', async () => {
    const results = await gatherFleetDoctor(peers, probe, echoingDiagnostic, undefined, inject());
    expect(results[0]).toMatchObject({ reachable: true, processedInject: true, injectRunId: '777' });
    expect(results[1]).toMatchObject({ reachable: true, processedInject: false });
    expect(results[1]!.injectError).toMatch(/unconfirmed/);
    expect(results[2]).toMatchObject({ reachable: false, processedInject: null });
  });

  it('back-compat: no inject config → processedInject undefined (existing two-tier behavior)', async () => {
    const results = await gatherFleetDoctor(peers, probe, echoingDiagnostic);
    expect(results[0]!.processedInject).toBeUndefined();
    expect(results[2]).toMatchObject({ reachable: false, accepted: null });
  });

  it('NEVER injects to an unreachable agent (ladder stops at tier 1)', async () => {
    const postSpy = vi.fn(async () => ({ delivered: true }));
    await gatherFleetDoctor(
      [{ name: 'devops-agent', info: info('100.64.0.3', 4300) }],
      probe,
      echoingDiagnostic,
      undefined,
      { ...inject(), post: postSpy },
    );
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('inject rendering — table column + JSON + summaries', () => {
  const results: readonly FleetDoctorResult[] = [
    { name: 'code-agent', host: 'h', port: 1, reachable: true, accepted: true, processedInject: true, injectRunId: '777' },
    { name: 'science-agent', host: 'h', port: 2, reachable: true, accepted: true, processedInject: false, injectError: 'processing unconfirmed within ~4s' },
    { name: 'devops-agent', host: 'h', port: 3, reachable: false, accepted: null, processedInject: null },
  ];

  it('buildDoctorRows appends the PROCESSED glyph column only under inject', () => {
    expect(buildDoctorRows(results, true)).toEqual([
      ['code-agent', 'h:1', '✓', '✓', '✓'],
      ['science-agent', 'h:2', '✓', '✓', '?'],
      ['devops-agent', 'h:3', '✗', '—', '—'],
    ]);
    // default (no inject) → 4 columns, no PROCESSED
    expect(buildDoctorRows(results)[0]).toHaveLength(4);
  });

  it('formatDoctorTable shows the PROCESSED header only under inject', () => {
    expect(formatDoctorTable(results, true).split('\n')[0]).toContain('PROCESSED');
    expect(formatDoctorTable(results).split('\n')[0]).not.toContain('PROCESSED');
  });

  it('injectSummaryLine + injectableCount count reachable attempts honestly', () => {
    expect(injectableCount(results)).toBe(2); // 2 reachable agents woken
    expect(injectSummaryLine(results)).toBe(
      '1/2 reachable agents processed an injected probe (1 unconfirmed — possibly busy, NOT necessarily a gap)',
    );
  });

  it('fleetDoctorToJson under inject: additive processed_inject + inject block, schema_version STAYS 1', () => {
    const json = fleetDoctorToJson(results, 'macf', { inject: true }) as {
      schema_version: number;
      inject: { invasive: boolean; woke: number; processed: number };
      agents: ReadonlyArray<Record<string, unknown>>;
    };
    expect(json.schema_version).toBe(FLEET_DOCTOR_JSON_SCHEMA_VERSION); // additive-optional → no bump
    expect(json.schema_version).toBe(1);
    expect(json.inject).toMatchObject({ invasive: true, woke: 2, processed: 1 });
    expect(json.agents[0]).toMatchObject({ processed_inject: true, inject_run_id: '777' });
    expect(json.agents[1]).toMatchObject({ processed_inject: false });
    expect(json.agents[2]).toMatchObject({ processed_inject: null });
  });

  it('fleetDoctorToJson WITHOUT inject omits processed_inject entirely (mode-off ≠ 0-processed)', () => {
    const json = fleetDoctorToJson(results, 'macf') as {
      schema_version: number;
      agents: ReadonlyArray<Record<string, unknown>>;
    };
    expect(json.schema_version).toBe(1);
    expect(json).not.toHaveProperty('inject');
    expect(json.agents[0]).not.toHaveProperty('processed_inject');
  });
});

describe('runFleetDoctor --inject (injected deps)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    logSpy?.mockRestore();
    errSpy?.mockRestore();
  });

  const injectDeps = (
    peers: readonly { name: string; info: AgentInfo }[],
    probe: FleetProbeFn,
    processedPort: number,
  ): FleetDoctorDeps => ({
    project: 'macf',
    listPeers: async () => peers,
    probe,
    diagnose: echoingDiagnostic,
    injectPost: async () => ({ delivered: true }),
    injectPoll: async (_h, port) => (port === processedPort ? '777' : null),
    injectGenRunId: () => '777',
    injectSleep: async () => {}, // no real waits
  });

  it('prints PROCESSED column + LOUD invasive warning (stderr) + processed summary + inject legend', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const peers = [
      { name: 'code-agent', info: info('127.0.0.1', 4100) }, // processed ✓
      { name: 'science-agent', info: info('100.64.0.2', 4200) }, // unconfirmed ?
    ];
    await runFleetDoctor('/unused', { inject: true, injectTimeoutSec: 1 }, injectDeps(peers, async () => ONLINE, 4100));

    const out = logSpy.mock.calls.flat().join('\n');
    const err = errSpy.mock.calls.flat().join('\n');
    expect(out).toContain('PROCESSED');
    expect(err).toMatch(/INVASIVE/); // loud up-front warning to stderr
    expect(err).toMatch(/WAKING/);
    expect(out).toMatch(/routed a REAL probe to 2 reachable agent\(s\), waking each/);
    expect(out).toMatch(/processed an injected probe/);
    expect(out).toContain('IDLE-agent fallback'); // INJECT_LEGEND rendered
  });

  it('--json includes processed_inject + the inject block; schema_version stays 1', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const peers = [{ name: 'code-agent', info: info('127.0.0.1', 4100) }];
    await runFleetDoctor('/unused', { json: true, inject: true }, injectDeps(peers, async () => ONLINE, 4100));

    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.inject).toMatchObject({ invasive: true, woke: 1, processed: 1 });
    expect(parsed.agents[0]).toMatchObject({ name: 'code-agent', processed_inject: true });
  });

  it('does NOT print the invasive warning when --inject is off', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const peers = [{ name: 'code-agent', info: info('127.0.0.1', 4100) }];
    await runFleetDoctor('/unused', {}, injectDeps(peers, async () => ONLINE, 4100));
    expect(errSpy.mock.calls.flat().join('\n')).not.toMatch(/INVASIVE/);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('PROCESSED');
  });
});

// --- macf#830: scheduler-safety — cwd-independence + never-empty-stdout-on-failure ---

/** A temp dir that IS a valid MACF project shell (`.macf/macf-agent.json` present). */
function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-doctor-test-'));
  mkdirSync(join(dir, '.macf'), { recursive: true });
  writeFileSync(join(dir, '.macf', 'macf-agent.json'), '{}\n');
  return dir;
}

/** A temp dir that is NOT a MACF project (no `.macf/` at all). */
function makeNonProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'macf-fleet-doctor-test-nonproj-'));
}

describe('resolveFleetDoctorProjectDir — cwd-independent project resolution (macf#830)', () => {
  it('explicit --dir resolves regardless of cwd, even when cwd is NOT a project', () => {
    const projectDir = makeProjectDir();
    const bogusCwd = makeNonProjectDir();
    try {
      const r = resolveFleetDoctorProjectDir(projectDir, bogusCwd);
      expect(r).toMatchObject({ ok: true, dir: projectDir });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(bogusCwd, { recursive: true, force: true });
    }
  });

  it('explicit --dir pointing at a non-project dir fails with a structured, non-crashing error', () => {
    const badDir = makeNonProjectDir();
    try {
      const r = resolveFleetDoctorProjectDir(badDir, badDir);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.code).toBe('not_a_macf_project');
        expect(r.failure.message).toContain('Not a MACF project');
        expect(r.failure.message).toContain(badDir);
      }
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('no --dir: walks up from cwd exactly like the interactive default (unchanged behavior)', () => {
    const projectDir = makeProjectDir();
    const nested = join(projectDir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    try {
      const r = resolveFleetDoctorProjectDir(undefined, nested);
      expect(r).toMatchObject({ ok: true, dir: projectDir });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('no --dir + cwd is NOT in a project: structured failure, never throws/exits', () => {
    const nonProjectCwd = makeNonProjectDir();
    try {
      const r = resolveFleetDoctorProjectDir(undefined, nonProjectCwd);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure.code).toBe('not_in_macf_project');
        expect(r.failure.message).toContain('Not in a MACF project');
        expect(r.failure.message).toContain('--dir');
      }
    } finally {
      rmSync(nonProjectCwd, { recursive: true, force: true });
    }
  });
});

describe('fleetDoctorFailureToJson — the --json failure envelope (macf#830)', () => {
  it('carries the SAME schema_version as the success shape + the structured error (additive field)', () => {
    const failure: FleetDoctorFailure = { code: 'not_in_macf_project', message: 'boom' };
    const json = fleetDoctorFailureToJson(failure) as { schema_version: number; error: FleetDoctorFailure };
    expect(json.schema_version).toBe(FLEET_DOCTOR_JSON_SCHEMA_VERSION);
    expect(json.error).toEqual(failure);
  });
});

describe('runFleetDoctor — scheduler-safe JSON failures (macf#830)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    logSpy?.mockRestore();
    errSpy?.mockRestore();
  });

  it('--json + unresolvable project dir (--dir given, not a project): non-empty JSON {error} on stdout, nonzero exit', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badDir = makeNonProjectDir();
    try {
      const code = await runFleetDoctor(badDir, { json: true });
      expect(code).not.toBe(0);
      const printed = logSpy.mock.calls.flat().join('');
      expect(printed.length).toBeGreaterThan(0); // never empty stdout
      const parsed = JSON.parse(printed); // must be jq-parseable
      expect(parsed.schema_version).toBe(FLEET_DOCTOR_JSON_SCHEMA_VERSION);
      expect(parsed.error.code).toBe('not_a_macf_project');
      expect(parsed.error.message).toContain('Not a MACF project');
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('--json + no --dir + cwd not a project: non-empty JSON {error} on stdout, nonzero exit', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const nonProjectCwd = makeNonProjectDir();
    const originalCwd = process.cwd();
    process.chdir(nonProjectCwd);
    try {
      const code = await runFleetDoctor(undefined, { json: true });
      expect(code).not.toBe(0);
      const printed = logSpy.mock.calls.flat().join('');
      expect(printed.length).toBeGreaterThan(0); // the exact cwd-sensitivity bug this issue fixes
      const parsed = JSON.parse(printed);
      expect(parsed.schema_version).toBe(FLEET_DOCTOR_JSON_SCHEMA_VERSION);
      expect(parsed.error.code).toBe('not_in_macf_project');
    } finally {
      process.chdir(originalCwd);
      rmSync(nonProjectCwd, { recursive: true, force: true });
    }
  });

  it('the abort message reflected in --json matches the stderr explanation (AC3)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badDir = makeNonProjectDir();
    try {
      await runFleetDoctor(badDir, { json: true });
      const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
      const stderrText = errSpy.mock.calls.flat().join('\n');
      expect(stderrText).toContain(parsed.error.message);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('plain-text mode (no --json): failure stays stderr-only — stdout unchanged from pre-#830 behavior', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badDir = makeNonProjectDir();
    try {
      const code = await runFleetDoctor(badDir, {});
      expect(code).not.toBe(0);
      expect(logSpy).not.toHaveBeenCalled(); // no stdout noise in plain-text mode
      expect(errSpy.mock.calls.flat().join('\n')).toContain('Not a MACF project');
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it('success path from a NON-project cwd via injected deps + explicit --dir threading: valid JSON, exit 0', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const projectDir = makeProjectDir();
    const nonProjectCwd = makeNonProjectDir();
    const originalCwd = process.cwd();
    process.chdir(nonProjectCwd);
    try {
      const deps: FleetDoctorDeps = {
        project: 'macf',
        listPeers: async () => [{ name: 'CODE_AGENT', info: info('127.0.0.1', 4100) }],
        probe: async () => ONLINE,
        diagnose: echoingDiagnostic,
      };
      // deps supplied → resolveFleetDoctorProjectDir is bypassed entirely, but this
      // pins that the command as a whole is safely callable while cwd is a non-project
      // dir and --dir is threaded through unused — the production (non-deps) path's
      // cwd-independence is covered directly above via resolveFleetDoctorProjectDir.
      const code = await runFleetDoctor(projectDir, { json: true }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
      expect(parsed.summary.verdict).toBe('HEALTHY');
    } finally {
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(nonProjectCwd, { recursive: true, force: true });
    }
  });
});
