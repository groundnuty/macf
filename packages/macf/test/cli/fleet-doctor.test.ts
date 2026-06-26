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
import type { AgentInfo } from '@groundnuty/macf-core';
import {
  acceptFailureReason,
  acceptedGlyph,
  buildDoctorRows,
  defaultRunId,
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
  runFleetDoctor,
  runProcessedInject,
  sanitizeMarkerAgent,
  summaryLine,
  type DiagnosticAck,
  type FleetDiagnosticFn,
  type FleetDoctorDeps,
  type FleetDoctorResult,
  type FleetInjectConfig,
  type FleetProbeFn,
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
