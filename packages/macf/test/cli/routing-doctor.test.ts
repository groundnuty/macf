/**
 * Tests for `macf routing doctor` — ROUTING-INFRA-layer interconnect checks
 * (DR-030 phase-2, macf#568).
 *
 * Fully offline + deterministic: the App install-set, the caller-pin reads, the
 * routing config, the registry list, the mTLS `/health` probe, and the CA-var
 * read are ALL injected (no `gh`, no network). The load-bearing cases mirror the
 * 2026-06-26 outage's root causes: (a) a DIVERGENT caller-pin is flagged, (b) a
 * missing `MACF_AGENT_<LABEL>` key fails routability, (c) an `app_name` != the
 * bot-login fails self-skip WHILE routability stays green (they're independent),
 * (d) a malformed `MACF_CA_CERT` fails, plus session-drift + instance_id-stale.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import {
  buildAgentRows,
  buildRepoRows,
  classifyFreshness,
  collectNonFleetRepos,
  collectWarnings,
  computeExpectedPin,
  evaluateCaCert,
  evaluateRoutingClientCertIssuer,
  evaluateSelfSkip,
  evaluateSession,
  formatAgentTable,
  formatRepoTable,
  freshnessGlyph,
  gatherRoutingDoctor,
  isFleetMember,
  isStrictBase64,
  normalizeLogin,
  parseRoutingClientCertIssuer,
  pinGlyph,
  routingClientCertGlyph,
  sessionGlyph,
  ROUTING_DOCTOR_JSON_SCHEMA_VERSION,
  routingDoctorToJson,
  routingVerdict,
  runRoutingDoctor,
  summaryLine,
  type CallerPinResult,
  type RoutingConfig,
  type RoutingDoctorDeps,
  type RoutingProbeFn,
} from '../../src/cli/commands/routing-doctor.js';

function info(host: string, port: number, instanceId: string): AgentInfo {
  return { host, port, type: 'permanent', instance_id: instanceId, started: '2026-06-26T00:00:00Z' };
}

/** A minimal `/health` body echoing a given instance_id (freshness join). */
function health(instanceId: string | null): HealthResponse {
  return {
    agent: 'x',
    status: 'online',
    type: 'permanent',
    uptime_seconds: 1,
    current_issue: null,
    version: '0.2.38',
    last_notification: null,
    instance_id: instanceId,
  } as HealthResponse;
}

/** A valid PEM cert (the body is real base64 → strict-base64-legal). */
const VALID_PEM = `-----BEGIN CERTIFICATE-----\n${Buffer.from('x'.repeat(120)).toString('base64')}\n-----END CERTIFICATE-----`;

// --- Pure primitives ---

describe('normalizeLogin', () => {
  it('strips app/ prefix + [bot] suffix, lowercases', () => {
    expect(normalizeLogin('app/macf-code-agent[bot]')).toBe('macf-code-agent');
    expect(normalizeLogin('MACF-Code-Agent')).toBe('macf-code-agent');
    expect(normalizeLogin('macf-code-agent[bot]')).toBe('macf-code-agent');
  });
});

describe('computeExpectedPin — modal / override', () => {
  it('picks the modal pin', () => {
    expect(computeExpectedPin(['v3.3.0', 'v3.3.0', 'v1.3.4'])).toBe('v3.3.0');
  });
  it('honors an explicit override', () => {
    expect(computeExpectedPin(['v1.3.4', 'v1.3.4'], 'v3.3.0')).toBe('v3.3.0');
  });
  it('null when nothing is pinned', () => {
    expect(computeExpectedPin([])).toBeNull();
  });
});

describe('isFleetMember — opt-out semantics (#614)', () => {
  it('absent marker → member (the safe default)', () => {
    expect(isFleetMember(null)).toBe(true);
    expect(isFleetMember(undefined)).toBe(true);
  });
  it('routing_fleet:false → NOT a member (the deliberate opt-out)', () => {
    expect(isFleetMember({ routing_fleet: false })).toBe(false);
  });
  it('routing_fleet:true → member', () => {
    expect(isFleetMember({ routing_fleet: true })).toBe(true);
  });
  it('key absent in an existing marker → member (fail toward over-checking)', () => {
    expect(isFleetMember({})).toBe(true);
  });
});

describe('evaluateSelfSkip — #538(b) / #566', () => {
  it('exact bot-login match passes (normalized, [bot]-tolerant)', () => {
    expect(evaluateSelfSkip('code-agent', 'macf-code-agent', 'macf-code-agent[bot]')).toEqual({ ok: true });
  });
  it('app_name != bot-login fails when the authoritative login is known', () => {
    const r = evaluateSelfSkip('code-agent', 'something-wrong', 'macf-code-agent[bot]');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/!= bot-login/);
  });
  it('heuristic: bare routing label (the #566 bug) fails with no authoritative login', () => {
    const r = evaluateSelfSkip('code-agent', 'code-agent');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/#566/);
  });
  it('heuristic: a bot-login-shaped app_name passes', () => {
    expect(evaluateSelfSkip('code-agent', 'macf-code-agent')).toEqual({ ok: true });
  });
  it('missing app_name fails', () => {
    expect(evaluateSelfSkip('code-agent', undefined).ok).toBe(false);
  });
});

describe('evaluateSession — <project>@<routing-label> convention, tri-state (DR-032 #610)', () => {
  it('passes the canonical form → ok', () => {
    expect(evaluateSession('code-agent', 'macf@code-agent', 'macf')).toEqual({
      status: 'ok',
      expected: 'macf@code-agent',
    });
  });
  it('present-but-stale → warn (NOT fail), with expected + a WARN-not-FAIL reason', () => {
    const r = evaluateSession('code-agent', 'code-agent', 'macf');
    expect(r.status).toBe('warn');
    expect(r.expected).toBe('macf@code-agent');
    expect(r.reason).toMatch(/convention/);
    expect(r.reason).toMatch(/WARN-not-FAIL/);
  });
  it('absent tmux_session → absent (assert-if-present PASS, vestigial on v3)', () => {
    expect(evaluateSession('code-agent', undefined, 'macf')).toEqual({
      status: 'absent',
      expected: 'macf@code-agent',
    });
  });
  it('keys the expected session on the ROUTING LABEL, not the OTEL agent-name (macf#678)', () => {
    // science: routing_label=science-agent (the doctor's `label`), agent_name=
    // macf-science-agent. The live session claude.sh self-wraps is macf@science-agent
    // (routing-label), so that is `ok`; the old agent-name-keyed form is drift.
    expect(evaluateSession('science-agent', 'macf@science-agent', 'macf').status).toBe('ok');
    const drift = evaluateSession('science-agent', 'macf@macf-science-agent', 'macf');
    expect(drift.status).toBe('warn');
    expect(drift.expected).toBe('macf@science-agent');
  });
});

describe('isStrictBase64 / evaluateCaCert — #563 malformed catch', () => {
  it('strict base64 only', () => {
    expect(isStrictBase64(Buffer.from('hello').toString('base64'))).toBe(true);
    expect(isStrictBase64('AAAA!BBB')).toBe(false); // illegal char
    expect(isStrictBase64('AAA')).toBe(false); // not a multiple of 4
  });
  it('a valid PEM cert passes', () => {
    expect(evaluateCaCert(VALID_PEM)).toMatchObject({ present: true, valid: true });
  });
  it('a base64-of-PEM blob passes (the #563 storage form)', () => {
    const b64 = Buffer.from(VALID_PEM).toString('base64');
    expect(evaluateCaCert(b64)).toMatchObject({ present: true, valid: true });
  });
  it('absent → present:false, valid:false', () => {
    expect(evaluateCaCert(null)).toMatchObject({ present: false, valid: false });
    expect(evaluateCaCert('  ')).toMatchObject({ present: false, valid: false });
  });
  it('present-but-malformed (garbled base64 body) → present:true, valid:false (#563)', () => {
    const bad = '-----BEGIN CERTIFICATE-----\nAAAA!notbase64\n-----END CERTIFICATE-----';
    const r = evaluateCaCert(bad);
    expect(r).toMatchObject({ present: true, valid: false });
    expect(r.reason).toMatch(/base64/);
  });
  it('present-but-not-a-cert (random non-base64 string) → invalid', () => {
    expect(evaluateCaCert('this is not a cert!!!')).toMatchObject({ present: true, valid: false });
  });
});

describe('classifyFreshness — registry vs live /health instance_id', () => {
  const now = Date.parse('2026-06-26T12:00:00Z');
  const ttl = 900_000;
  it('fresh when instance_id matches', () => {
    expect(classifyFreshness(info('h', 1, 'inst-a'), health('inst-a'), now, ttl)).toBe('fresh');
  });
  it('stale when instance_id mismatches (a newer instance answered)', () => {
    expect(classifyFreshness(info('h', 1, 'inst-OLD'), health('inst-NEW'), now, ttl)).toBe('stale');
  });
  it('unknown when /health omits instance_id (older cs)', () => {
    expect(classifyFreshness(info('h', 1, 'inst-a'), health(null), now, ttl)).toBe('unknown');
  });
  it('unreachable when /health is null + no aged heartbeat', () => {
    expect(classifyFreshness(info('h', 1, 'inst-a'), null, now, ttl)).toBe('unreachable');
  });
  it('stale when /health is null AND heartbeat aged past TTL (DR-031)', () => {
    const aged: AgentInfo = { ...info('h', 1, 'inst-a'), last_heartbeat: '2026-06-26T00:00:00Z' };
    expect(classifyFreshness(aged, null, now, ttl)).toBe('stale');
  });
});

// --- Deps factory for the orchestration / command tests ---

const ALL_PINNED_V3: (repo: string) => Promise<CallerPinResult> = async (repo) => ({
  repo,
  pin: 'v3.3.0',
  status: 'pinned',
});

const HEALTHY_CONFIG: RoutingConfig = {
  agents: {
    'code-agent': { app_name: 'macf-code-agent', tmux_session: 'macf@code-agent' },
    'science-agent': { app_name: 'macf-science-agent', tmux_session: 'macf@science-agent' },
  },
};

// #800 default baseline: recorded issuer matches the current CA → `ok`, never
// verdict-failing unless a test deliberately diverges them.
const ROUTING_CLIENT_CERT_FINGERPRINT = 'a'.repeat(64);

function deps(over: Partial<RoutingDoctorDeps> = {}): RoutingDoctorDeps {
  return {
    project: 'macf',
    now: Date.parse('2026-06-26T12:00:00Z'),
    listRepos: async () => ['groundnuty/macf', 'groundnuty/macf-science-agent'],
    readCallerPin: ALL_PINNED_V3,
    // Default: no opt-out marker anywhere → every pinned repo is a fleet member (#614).
    readFleetMarker: async () => null,
    readRoutingConfig: async () => HEALTHY_CONFIG,
    listRegistry: async () => [
      { name: 'CODE_AGENT', info: info('100.64.0.1', 4100, 'inst-code') },
      { name: 'SCIENCE_AGENT', info: info('100.64.0.2', 4200, 'inst-science') },
    ],
    probe: async (_h, port) => (port === 4100 ? health('inst-code') : health('inst-science')),
    readCaCert: async () => VALID_PEM,
    readRoutingClientCertIssuer: async () =>
      JSON.stringify({ issuer_fingerprint: ROUTING_CLIENT_CERT_FINGERPRINT, minted_at: '2026-06-01T00:00:00Z' }),
    currentCaFingerprint: () => ROUTING_CLIENT_CERT_FINGERPRINT,
    ...over,
  };
}

describe('gatherRoutingDoctor — the all-green baseline', () => {
  it('every check passes → HEALTHY', async () => {
    const report = await gatherRoutingDoctor(deps());
    expect(routingVerdict(report)).toBe('HEALTHY');
    expect(report.expectedPin).toBe('v3.3.0');
    expect(report.repoPins.every((r) => r.consistent === true)).toBe(true);
    expect(report.agents).toHaveLength(2);
    expect(report.agents.every((a) => a.routable && a.selfSkipOk && a.sessionOk && a.freshness === 'fresh')).toBe(
      true,
    );
    expect(report.ca).toMatchObject({ present: true, valid: true });
  });
});

describe('check 1 — divergent caller-pin is flagged', () => {
  it('one repo on v1.3.4 while the rest are v3.3.0 → DEGRADED + that repo inconsistent', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readCallerPin: async (repo) =>
          repo === 'groundnuty/macf-science-agent'
            ? { repo, pin: 'v1.3.4', status: 'pinned' }
            : { repo, pin: 'v3.3.0', status: 'pinned' },
      }),
    );
    expect(report.expectedPin).toBe('v3.3.0'); // modal
    const diverged = report.repoPins.find((r) => r.repo === 'groundnuty/macf-science-agent');
    expect(diverged).toMatchObject({ pin: 'v1.3.4', consistent: false });
    expect(routingVerdict(report)).toBe('DEGRADED');
  });

  it('a non-caller repo (no agent-router.yml) does NOT count as divergence', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        listRepos: async () => ['groundnuty/macf', 'groundnuty/groundnuty'],
        readCallerPin: async (repo) =>
          repo === 'groundnuty/groundnuty'
            ? { repo, pin: null, status: 'no-workflow' }
            : { repo, pin: 'v3.3.0', status: 'pinned' },
      }),
    );
    const owner = report.repoPins.find((r) => r.repo === 'groundnuty/groundnuty');
    expect(owner).toMatchObject({ consistent: null }); // excluded from verdict
    expect(routingVerdict(report)).toBe('HEALTHY');
  });
});

describe('check 1 (#614) — opt-out fleet membership scopes pins_consistent', () => {
  // The literal #614 scenario: the substrate is on v3.3.0, but the testbed harness is
  // an intentional-Stage-2 caller pinned @v1.3.3 and should NOT flip pins_consistent.
  const SUBSTRATE_PLUS_TESTBED = (over: Partial<RoutingDoctorDeps> = {}): RoutingDoctorDeps =>
    deps({
      listRepos: async () => [
        'groundnuty/macf',
        'groundnuty/macf-science-agent',
        'groundnuty/macf-testbed',
      ],
      readCallerPin: async (repo) =>
        repo === 'groundnuty/macf-testbed'
          ? { repo, pin: 'v1.3.3', status: 'pinned' }
          : { repo, pin: 'v3.3.0', status: 'pinned' },
      readFleetMarker: async (repo) =>
        repo === 'groundnuty/macf-testbed' ? { routing_fleet: false } : null,
      ...over,
    });

  it('an opted-out repo with a divergent pin does NOT flip pins_consistent (members all v3.3.0)', async () => {
    const report = await gatherRoutingDoctor(SUBSTRATE_PLUS_TESTBED());
    expect(report.expectedPin).toBe('v3.3.0'); // modal over MEMBERS only — testbed didn't pull it
    const testbed = report.repoPins.find((r) => r.repo === 'groundnuty/macf-testbed')!;
    expect(testbed.fleetMember).toBe(false);
    expect(testbed.consistent).toBeNull(); // excluded from the verdict
    const macf = report.repoPins.find((r) => r.repo === 'groundnuty/macf')!;
    expect(macf.fleetMember).toBe(true);
    expect(macf.consistent).toBe(true);
    expect(routingVerdict(report)).toBe('HEALTHY'); // the whole point of #614
    expect(collectNonFleetRepos(report)).toEqual(['groundnuty/macf-testbed']); // reported
  });

  it('a GENUINE member pin divergence STILL flips pins_consistent → DEGRADED (no over-suppression)', async () => {
    const report = await gatherRoutingDoctor(
      SUBSTRATE_PLUS_TESTBED({
        // science is a fleet member (no opt-out) AND it diverges → must still degrade.
        readCallerPin: async (repo) =>
          repo === 'groundnuty/macf-testbed'
            ? { repo, pin: 'v1.3.3', status: 'pinned' }
            : repo === 'groundnuty/macf-science-agent'
              ? { repo, pin: 'v1.3.4', status: 'pinned' }
              : { repo, pin: 'v3.3.0', status: 'pinned' },
      }),
    );
    const science = report.repoPins.find((r) => r.repo === 'groundnuty/macf-science-agent')!;
    expect(science.fleetMember).toBe(true);
    expect(science.consistent).toBe(false);
    expect(routingVerdict(report)).toBe('DEGRADED');
    // testbed still excluded even while a real member fault degrades the plane
    expect(collectNonFleetRepos(report)).toEqual(['groundnuty/macf-testbed']);
  });

  it('marker absent → member (participates) — the safe opt-out default', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        // No readFleetMarker override → factory default returns null (absent) for all.
        readCallerPin: async (repo) =>
          repo === 'groundnuty/macf-science-agent'
            ? { repo, pin: 'v1.3.4', status: 'pinned' }
            : { repo, pin: 'v3.3.0', status: 'pinned' },
      }),
    );
    expect(report.repoPins.every((r) => r.fleetMember)).toBe(true); // all members by default
    expect(routingVerdict(report)).toBe('DEGRADED'); // a real divergence among members
    expect(collectNonFleetRepos(report)).toEqual([]);
  });

  it('routing_fleet:true (explicit) keeps the repo a member', async () => {
    const report = await gatherRoutingDoctor(deps({ readFleetMarker: async () => ({ routing_fleet: true }) }));
    expect(report.repoPins.filter((r) => r.status === 'pinned').every((r) => r.fleetMember)).toBe(true);
    expect(collectNonFleetRepos(report)).toEqual([]);
  });
});

describe('check 2a — routability (missing MACF_AGENT_<LABEL>)', () => {
  it('a label with no registry key fails routability → DEGRADED', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        // SCIENCE_AGENT is missing from the registry entirely.
        listRegistry: async () => [{ name: 'CODE_AGENT', info: info('100.64.0.1', 4100, 'inst-code') }],
      }),
    );
    const science = report.agents.find((a) => a.label === 'science-agent')!;
    expect(science.routable).toBe(false);
    expect(science.freshness).toBe('unregistered'); // no probe attempted
    expect(routingVerdict(report)).toBe('DEGRADED');
  });
});

describe('check 2b — self-skip independent of routability', () => {
  it('app_name != bot-login fails self-skip BUT routability stays green', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        // The authoritative bot-login for code-agent is macf-code-agent; the
        // config has the WRONG value, but the registry key still exists.
        botLogins: { 'code-agent': 'macf-code-agent[bot]' },
        readRoutingConfig: async () => ({
          agents: {
            'code-agent': { app_name: 'code-agent', tmux_session: 'macf@code-agent' }, // bare label (#566)
            'science-agent': { app_name: 'macf-science-agent', tmux_session: 'macf@science-agent' },
          },
        }),
      }),
    );
    const code = report.agents.find((a) => a.label === 'code-agent')!;
    expect(code.routable).toBe(true); // STILL routes — resolution never touches app_name
    expect(code.selfSkipOk).toBe(false);
    expect(code.selfSkipReason).toMatch(/!= bot-login/);
    expect(routingVerdict(report)).toBe('DEGRADED');
  });
});

describe('check 3 — registration freshness (instance_id stale)', () => {
  it('registry instance_id != live /health instance_id → stale → DEGRADED', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        // /health for code-agent reports a DIFFERENT instance_id than the registry.
        probe: async (_h, port) => (port === 4100 ? health('inst-NEWER') : health('inst-science')),
      }),
    );
    const code = report.agents.find((a) => a.label === 'code-agent')!;
    expect(code.freshness).toBe('stale');
    expect(code.registryInstanceId).toBe('inst-code');
    expect(code.healthInstanceId).toBe('inst-NEWER');
    expect(routingVerdict(report)).toBe('DEGRADED');
  });

  it('unreachable freshness does NOT fail the verdict (liveness is fleet-doctor’s job)', async () => {
    const report = await gatherRoutingDoctor(deps({ probe: async () => null }));
    expect(report.agents.every((a) => a.freshness === 'unreachable')).toBe(true);
    expect(routingVerdict(report)).toBe('HEALTHY');
  });
});

describe('check 4 — CA material malformed', () => {
  it('a malformed MACF_CA_CERT → DEGRADED', async () => {
    const report = await gatherRoutingDoctor(
      deps({ readCaCert: async () => '-----BEGIN CERTIFICATE-----\nAAAA!bad\n-----END CERTIFICATE-----' }),
    );
    expect(report.ca).toMatchObject({ present: true, valid: false });
    expect(routingVerdict(report)).toBe('DEGRADED');
  });
});

describe('check 5 — session-name drift is WARN-not-FAIL (DR-032 #610)', () => {
  it('a stale bare-label tmux_session warns but does NOT drive DEGRADED', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readRoutingConfig: async () => ({
          agents: {
            'code-agent': { app_name: 'macf-code-agent', tmux_session: 'code-agent' }, // stale drift
            'science-agent': { app_name: 'macf-science-agent', tmux_session: 'macf@science-agent' },
          },
        }),
      }),
    );
    const code = report.agents.find((a) => a.label === 'code-agent')!;
    expect(code.sessionStatus).toBe('warn');
    expect(code.sessionOk).toBe(false); // back-compat field preserved
    expect(code.sessionExpected).toBe('macf@code-agent');
    // The drift no longer flips the verdict — it's the known-pending rename.
    expect(routingVerdict(report)).toBe('HEALTHY');
    // ...but it stays VISIBLE in the warnings channel.
    expect(collectWarnings(report)).toEqual([expect.stringMatching(/code-agent.*WARN-not-FAIL/)]);
  });

  it('an absent agent-config.json (vestigial on v3) does NOT degrade — registry agents still checked (#621)', async () => {
    const report = await gatherRoutingDoctor(deps({ readRoutingConfig: async () => null }));
    expect(report.hasRoutingConfig).toBe(false);
    // #621: with no local config, the registry-registered fleet agents are STILL checked
    // (fleet-scoped) — they are no longer silently skipped. Repo-scoped fields null out.
    expect(report.agents).toHaveLength(2);
    expect(report.agents.every((a) => a.inLocalConfig === false)).toBe(true);
    expect(report.agents.every((a) => a.routable && a.freshness === 'fresh')).toBe(true);
    expect(report.agents.every((a) => a.selfSkipOk === null && a.sessionStatus === null)).toBe(true);
    expect(routingVerdict(report)).toBe('HEALTHY'); // all fresh → no fleet-scoped fault
    expect(collectWarnings(report)).toEqual([]); // null session → no warn
  });

  it('an agent entry with NO tmux_session is assert-if-present PASS (absent), not warn/fail', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readRoutingConfig: async () => ({
          agents: {
            'code-agent': { app_name: 'macf-code-agent' }, // no tmux_session at all
            'science-agent': { app_name: 'macf-science-agent', tmux_session: 'macf@science-agent' },
          },
        }),
      }),
    );
    const code = report.agents.find((a) => a.label === 'code-agent')!;
    expect(code.sessionStatus).toBe('absent');
    expect(code.sessionOk).toBe(true); // assert-if-present PASS
    expect(routingVerdict(report)).toBe('HEALTHY');
    expect(collectWarnings(report)).toEqual([]);
  });

  it('a session warn does NOT mask a genuine routing fault (still DEGRADED)', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        // science-agent is unroutable (missing registry key) AND code-agent's session is stale.
        listRegistry: async () => [{ name: 'CODE_AGENT', info: info('100.64.0.1', 4100, 'inst-code') }],
        readRoutingConfig: async () => ({
          agents: {
            'code-agent': { app_name: 'macf-code-agent', tmux_session: 'code-agent' }, // session warn
            'science-agent': { app_name: 'macf-science-agent', tmux_session: 'macf@science-agent' },
          },
        }),
      }),
    );
    expect(routingVerdict(report)).toBe('DEGRADED'); // the genuine fault (unroutable) still bites
    expect(collectWarnings(report)).toEqual([expect.stringMatching(/code-agent/)]); // warn still surfaced
  });
});

describe('parseRoutingClientCertIssuer (#800)', () => {
  it('parses a well-formed envelope', () => {
    const raw = JSON.stringify({ issuer_fingerprint: 'abc123', minted_at: '2026-07-01T00:00:00Z' });
    expect(parseRoutingClientCertIssuer(raw)).toEqual({ fingerprint: 'abc123', mintedAt: '2026-07-01T00:00:00Z' });
  });
  it('null/undefined/empty → null', () => {
    expect(parseRoutingClientCertIssuer(null)).toBeNull();
    expect(parseRoutingClientCertIssuer(undefined)).toBeNull();
    expect(parseRoutingClientCertIssuer('')).toBeNull();
    expect(parseRoutingClientCertIssuer('   ')).toBeNull();
  });
  it('malformed JSON → null (never throws)', () => {
    expect(parseRoutingClientCertIssuer('{not json')).toBeNull();
  });
  it('valid JSON but not an object (e.g. a bare string/number) → null', () => {
    expect(parseRoutingClientCertIssuer('"just-a-string"')).toBeNull();
    expect(parseRoutingClientCertIssuer('42')).toBeNull();
    expect(parseRoutingClientCertIssuer('null')).toBeNull();
  });
  it('missing/empty issuer_fingerprint → null', () => {
    expect(parseRoutingClientCertIssuer(JSON.stringify({ minted_at: 'x' }))).toBeNull();
    expect(parseRoutingClientCertIssuer(JSON.stringify({ issuer_fingerprint: '' }))).toBeNull();
    expect(parseRoutingClientCertIssuer(JSON.stringify({ issuer_fingerprint: '  ' }))).toBeNull();
  });
  it('missing minted_at → mintedAt is null, fingerprint still parsed', () => {
    expect(parseRoutingClientCertIssuer(JSON.stringify({ issuer_fingerprint: 'abc' }))).toEqual({
      fingerprint: 'abc',
      mintedAt: null,
    });
  });
});

describe('evaluateRoutingClientCertIssuer — orphan detection (#800)', () => {
  it('matching fingerprints → ok', () => {
    const raw = JSON.stringify({ issuer_fingerprint: 'FP1', minted_at: '2026-07-01T00:00:00Z' });
    expect(evaluateRoutingClientCertIssuer(raw, 'FP1')).toEqual({
      state: 'ok',
      recordedFingerprint: 'FP1',
      currentFingerprint: 'FP1',
      mintedAt: '2026-07-01T00:00:00Z',
    });
  });

  it('mismatched fingerprints → orphaned, with a #800 remediation reason', () => {
    const raw = JSON.stringify({ issuer_fingerprint: 'OLD-FP', minted_at: '2026-06-01T00:00:00Z' });
    const r = evaluateRoutingClientCertIssuer(raw, 'NEW-FP');
    expect(r.state).toBe('orphaned');
    expect(r.recordedFingerprint).toBe('OLD-FP');
    expect(r.currentFingerprint).toBe('NEW-FP');
    expect(r.reason).toMatch(/orphaned/);
    expect(r.reason).toMatch(/macf certs issue-routing-client/);
    expect(r.reason).toMatch(/#800/);
  });

  it('never recorded (never minted / pre-#800 workspace) → absent, informational only', () => {
    const r = evaluateRoutingClientCertIssuer(null, 'CURRENT-FP');
    expect(r.state).toBe('absent');
    expect(r.recordedFingerprint).toBeNull();
    expect(r.reason).toMatch(/never minted|pre-#800/);
  });

  it('malformed recorded value → absent (never a parse failure)', () => {
    const r = evaluateRoutingClientCertIssuer('{not json', 'CURRENT-FP');
    expect(r.state).toBe('absent');
  });

  it('recorded exists but no local CA to compare against → absent (no false positive)', () => {
    const raw = JSON.stringify({ issuer_fingerprint: 'FP1' });
    const r = evaluateRoutingClientCertIssuer(raw, null);
    expect(r.state).toBe('absent');
    expect(r.recordedFingerprint).toBe('FP1');
    expect(r.reason).toMatch(/no local CA cert/);
  });
});

describe('routingClientCertGlyph (#800)', () => {
  it('renders the three states', () => {
    expect(routingClientCertGlyph('ok')).toBe('✓');
    expect(routingClientCertGlyph('orphaned')).toMatch(/orphaned/);
    expect(routingClientCertGlyph('absent')).toMatch(/n\/a/);
  });
});

describe('check 6 — routing-client cert orphaned after a CA rotation (#800)', () => {
  it('an orphaned routing-client cert (issuer != current CA) → DEGRADED', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readRoutingClientCertIssuer: async () =>
          JSON.stringify({ issuer_fingerprint: 'OLD-CA-FP', minted_at: '2026-06-01T00:00:00Z' }),
        currentCaFingerprint: () => 'NEW-CA-FP', // CA rotated since the cert was minted
      }),
    );
    expect(report.routingClientCert.state).toBe('orphaned');
    expect(routingVerdict(report)).toBe('DEGRADED');
  });

  it('never-minted routing-client cert (absent) does NOT fail the verdict — informational only', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readRoutingClientCertIssuer: async () => null,
      }),
    );
    expect(report.routingClientCert.state).toBe('absent');
    expect(routingVerdict(report)).toBe('HEALTHY'); // nothing else is broken in the baseline
  });

  it('matching issuer does not mask a genuine OTHER routing fault (still DEGRADED)', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        // Everything routing-client-cert-related is fine...
        readRoutingClientCertIssuer: async () =>
          JSON.stringify({ issuer_fingerprint: 'FP1', minted_at: '2026-06-01T00:00:00Z' }),
        currentCaFingerprint: () => 'FP1',
        // ...but the CA material check is broken.
        readCaCert: async () => 'not-a-cert!!!',
      }),
    );
    expect(report.routingClientCert.state).toBe('ok');
    expect(routingVerdict(report)).toBe('DEGRADED'); // caFail still bites
  });
});

describe('#621 — per-agent set is registry ∪ config (registry-only agents fleet-scoped-checked)', () => {
  // A registry that carries an AUDITOR not in HEALTHY_CONFIG — the literal #621 case:
  // the auditor is registered fleet-wide but groundnuty/macf does not route to it, so the
  // OLD config-only loop never checked it. fromVariableSegment('AUDITOR') → 'auditor'.
  const WITH_AUDITOR = (over: Partial<RoutingDoctorDeps> = {}): RoutingDoctorDeps =>
    deps({
      listRegistry: async () => [
        { name: 'CODE_AGENT', info: info('100.64.0.1', 4100, 'inst-code') },
        { name: 'SCIENCE_AGENT', info: info('100.64.0.2', 4200, 'inst-science') },
        { name: 'AUDITOR', info: info('100.64.0.9', 4900, 'inst-aud') },
      ],
      probe: async (_h, port) =>
        port === 4100 ? health('inst-code') : port === 4200 ? health('inst-science') : health('inst-aud'),
      ...over,
    });

  it('a registry agent NOT in local config (the auditor) is checked fleet-scoped, repo-scoped null', async () => {
    const report = await gatherRoutingDoctor(WITH_AUDITOR());
    const auditor = report.agents.find((a) => a.label === 'auditor')!;
    expect(auditor).toBeDefined();
    expect(auditor.inLocalConfig).toBe(false); // provenance: registry-only
    // FLEET-scoped checks DID run:
    expect(auditor.routable).toBe(true);
    expect(auditor.freshness).toBe('fresh');
    expect(auditor.registryInstanceId).toBe('inst-aud');
    expect(auditor.healthInstanceId).toBe('inst-aud');
    // REPO-scoped checks are NULL (no local config to assert — honest-not-asserted):
    expect(auditor.selfSkipOk).toBeNull();
    expect(auditor.sessionOk).toBeNull();
    expect(auditor.sessionStatus).toBeNull();
    expect(auditor.sessionExpected).toBeNull();
    expect(auditor.appName).toBeNull();
    expect(auditor.tmuxSession).toBeNull();
    // Fresh auditor → no fleet-scoped fault → still HEALTHY.
    expect(routingVerdict(report)).toBe('HEALTHY');
  });

  it('a config agent present in the registry is FULLY checked as today (in_local_config:true)', async () => {
    const report = await gatherRoutingDoctor(WITH_AUDITOR());
    const code = report.agents.find((a) => a.label === 'code-agent')!;
    expect(code.inLocalConfig).toBe(true);
    expect(code.routable).toBe(true);
    expect(code.freshness).toBe('fresh');
    expect(code.selfSkipOk).toBe(true); // repo-scoped check ran
    expect(code.sessionStatus).toBe('ok');
    expect(code.sessionExpected).toBe('macf@code-agent');
  });

  it('a config agent NOT in the registry → routable:false (as today), still repo-scoped-checked', async () => {
    const report = await gatherRoutingDoctor(
      WITH_AUDITOR({
        // science-agent is in HEALTHY_CONFIG but dropped from the registry.
        listRegistry: async () => [
          { name: 'CODE_AGENT', info: info('100.64.0.1', 4100, 'inst-code') },
          { name: 'AUDITOR', info: info('100.64.0.9', 4900, 'inst-aud') },
        ],
      }),
    );
    const science = report.agents.find((a) => a.label === 'science-agent')!;
    expect(science.inLocalConfig).toBe(true); // it IS in local config
    expect(science.routable).toBe(false); // but missing the registry key
    expect(science.freshness).toBe('unregistered'); // no probe attempted
    expect(science.selfSkipOk).toBe(true); // repo-scoped check still ran (config present)
    expect(routingVerdict(report)).toBe('DEGRADED'); // unroutable config target degrades
  });

  it('a registry-only agent that is STALE drives DEGRADED (fleet-scoped verdict covers it)', async () => {
    const report = await gatherRoutingDoctor(
      WITH_AUDITOR({
        // The auditor's live /health reports a NEWER instance_id than the registry → stale.
        probe: async (_h, port) =>
          port === 4100 ? health('inst-code') : port === 4200 ? health('inst-science') : health('inst-NEWER-aud'),
      }),
    );
    const auditor = report.agents.find((a) => a.label === 'auditor')!;
    expect(auditor.inLocalConfig).toBe(false);
    expect(auditor.freshness).toBe('stale');
    expect(auditor.selfSkipOk).toBeNull(); // repo-scoped null does NOT mask the fleet fault
    expect(routingVerdict(report)).toBe('DEGRADED'); // a registry-only stale agent still degrades
  });

  it('union de-dupes by label + keeps registry order first; auditor renders — n/a repo-scoped columns', async () => {
    const report = await gatherRoutingDoctor(WITH_AUDITOR());
    expect(report.agents.map((a) => a.label)).toEqual(['code-agent', 'science-agent', 'auditor']);
    const rows = buildAgentRows(report.agents);
    // auditor row: AGENT, ROUTABLE ✓, SELF-SKIP — n/a, SESSION — n/a, FRESH ✓
    expect(rows[2]).toEqual(['auditor', '✓', '— n/a', '— n/a', '✓']);
  });

  it('--json: registry-only agent carries in_local_config + null repo-scoped fields; schema_version stays 1', async () => {
    const report = await gatherRoutingDoctor(WITH_AUDITOR());
    const json = routingDoctorToJson(report) as {
      schema_version: number;
      summary: { agents_total: number; agents_routing_ok: number };
      warnings: string[];
      non_fleet_repos: string[];
      caller_pins: ReadonlyArray<Record<string, unknown>>;
      agents: ReadonlyArray<Record<string, unknown>>;
    };
    expect(json.schema_version).toBe(1); // additive → NO bump
    expect(json.summary.agents_total).toBe(3); // registry-only auditor now counted
    expect(json.summary.agents_routing_ok).toBe(3); // all fresh + routable
    // existing additive channels preserved:
    expect(Array.isArray(json.warnings)).toBe(true);
    expect(Array.isArray(json.non_fleet_repos)).toBe(true);
    expect(json.caller_pins[0]).toHaveProperty('fleet_member'); // #614 field preserved
    const auditor = json.agents.find((a) => a.label === 'auditor')!;
    expect(auditor.in_local_config).toBe(false); // new additive provenance flag
    expect(auditor.routable).toBe(true);
    expect(auditor.freshness).toBe('fresh');
    expect(auditor.self_skip_ok).toBeNull();
    expect(auditor.session_ok).toBeNull();
    expect(auditor.session_status).toBeNull();
    expect(auditor.session_expected).toBeNull();
    // a config agent still carries its repo-scoped fields (regression guard):
    const code = json.agents.find((a) => a.label === 'code-agent')!;
    expect(code.in_local_config).toBe(true);
    expect(code.self_skip_ok).toBe(true);
    expect(code.session_status).toBe('ok');
  });
});

describe('routingVerdict — EMPTY', () => {
  it('no repos + no agents → EMPTY', async () => {
    const report = await gatherRoutingDoctor(
      deps({ listRepos: async () => [], readRoutingConfig: async () => null, listRegistry: async () => [] }),
    );
    expect(routingVerdict(report)).toBe('EMPTY');
  });
});

// --- Rendering ---

describe('rendering — tables + glyphs', () => {
  it('pinGlyph ✓ / ✗ / — n/a', () => {
    expect(pinGlyph(true)).toBe('✓');
    expect(pinGlyph(false)).toBe('✗');
    expect(pinGlyph(null)).toBe('— n/a');
  });
  it('freshnessGlyph maps each state', () => {
    expect(freshnessGlyph('fresh')).toBe('✓');
    expect(freshnessGlyph('stale')).toBe('✗ stale');
    expect(freshnessGlyph('unreachable')).toBe('? unreach');
    expect(freshnessGlyph('unknown')).toBe('? unkn');
    expect(freshnessGlyph('unregistered')).toBe('—');
  });
  it('sessionGlyph maps each state (DR-032 #610)', () => {
    expect(sessionGlyph('ok')).toBe('✓');
    expect(sessionGlyph('warn')).toBe('⚠ warn');
    expect(sessionGlyph('absent')).toBe('—');
  });
  it('buildRepoRows + formatRepoTable render REPO / CALLER-PIN / CONSISTENT', () => {
    const rows = [
      { repo: 'groundnuty/macf', pin: 'v3.3.0', status: 'pinned' as const, fleetMember: true, consistent: true },
      { repo: 'groundnuty/x', pin: 'v1.3.4', status: 'pinned' as const, fleetMember: true, consistent: false },
    ];
    expect(buildRepoRows(rows)).toEqual([
      ['groundnuty/macf', 'v3.3.0', '✓'],
      ['groundnuty/x', 'v1.3.4', '✗'],
    ]);
    expect(formatRepoTable(rows).split('\n')[0]).toContain('CALLER-PIN');
  });
  it('buildAgentRows + formatAgentTable render the five-check row', async () => {
    const report = await gatherRoutingDoctor(deps());
    const rows = buildAgentRows(report.agents);
    expect(rows[0]).toEqual(['code-agent', '✓', '✓', '✓', '✓']);
    expect(formatAgentTable(report.agents).split('\n')[0]).toContain('SELF-SKIP');
  });
});

describe('summaryLine', () => {
  it('reads HEALTHY for the baseline', async () => {
    const report = await gatherRoutingDoctor(deps());
    expect(summaryLine(report)).toMatch(/routing plane: HEALTHY/);
    expect(summaryLine(report)).toMatch(/pins consistent/);
  });

  it('carries the routing-client cert clause (#800)', async () => {
    const report = await gatherRoutingDoctor(deps());
    expect(summaryLine(report)).toMatch(/routing-client cert ✓/);
  });
});

// --- JSON contract ---

describe('routingDoctorToJson — DR-031 watchdog contract', () => {
  it('carries schema_version + summary verdict + per-check detail + disclaimer', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readCallerPin: async (repo) =>
          repo === 'groundnuty/macf-science-agent'
            ? { repo, pin: 'v1.3.4', status: 'pinned' }
            : { repo, pin: 'v3.3.0', status: 'pinned' },
      }),
    );
    const json = routingDoctorToJson(report) as {
      schema_version: number;
      project: string;
      summary: { verdict: string; routing_repos: number; pins_consistent: boolean; ca_ok: boolean; agents_total: number };
      caller_pins: ReadonlyArray<Record<string, unknown>>;
      agents: ReadonlyArray<Record<string, unknown>>;
      ca_cert: Record<string, unknown>;
      disclaimer: string;
    };
    expect(json.schema_version).toBe(ROUTING_DOCTOR_JSON_SCHEMA_VERSION);
    expect(json.schema_version).toBe(1);
    expect(json.project).toBe('macf');
    expect(json.summary.verdict).toBe('DEGRADED');
    expect(json.summary.pins_consistent).toBe(false);
    expect(json.summary.ca_ok).toBe(true);
    expect(json.summary.agents_total).toBe(2);
    expect(json.caller_pins).toHaveLength(2);
    expect(json.agents[0]).toMatchObject({ label: 'code-agent', routable: true, self_skip_ok: true });
    expect(json.ca_cert).toMatchObject({ present: true, valid: true });
    expect(json.disclaimer).toMatch(/Static GitHub-plane/);
  });

  it('additive: keeps session_ok, adds session_status + warnings[]; drift does NOT degrade (#610)', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readRoutingConfig: async () => ({
          agents: {
            'code-agent': { app_name: 'macf-code-agent', tmux_session: 'code-agent' }, // stale drift
            'science-agent': { app_name: 'macf-science-agent', tmux_session: 'macf@science-agent' },
          },
        }),
      }),
    );
    const json = routingDoctorToJson(report) as {
      schema_version: number;
      summary: { verdict: string; agents_routing_ok: number };
      warnings: string[];
      agents: ReadonlyArray<Record<string, unknown>>;
    };
    expect(json.schema_version).toBe(1); // additive change → NO bump
    expect(json.summary.verdict).toBe('HEALTHY'); // session drift no longer degrades
    expect(json.summary.agents_routing_ok).toBe(2); // both agents still routing-OK
    const code = json.agents.find((a) => a.label === 'code-agent')!;
    expect(code.session_ok).toBe(false); // back-compat field PRESERVED
    expect(code.session_status).toBe('warn'); // additive tri-state
    expect(code.session_expected).toBe('macf@code-agent'); // PRESERVED
    expect(code.session_reason).toMatch(/WARN-not-FAIL/); // PRESERVED + informative
    expect(json.warnings).toEqual([expect.stringMatching(/code-agent/)]); // visible, additive
  });

  it('additive: an all-green report carries an empty warnings[] (absent session = no warn)', async () => {
    const json = routingDoctorToJson(
      await gatherRoutingDoctor(deps({ readRoutingConfig: async () => null })),
    ) as { warnings: string[]; summary: { verdict: string } };
    expect(json.warnings).toEqual([]);
    expect(json.summary.verdict).not.toBe('DEGRADED');
  });

  it('additive (#614): caller_pins carry fleet_member; non_fleet_repos lists opt-outs; schema_version stays 1', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        listRepos: async () => ['groundnuty/macf', 'groundnuty/macf-testbed'],
        readCallerPin: async (repo) =>
          repo === 'groundnuty/macf-testbed'
            ? { repo, pin: 'v1.3.3', status: 'pinned' }
            : { repo, pin: 'v3.3.0', status: 'pinned' },
        readFleetMarker: async (repo) =>
          repo === 'groundnuty/macf-testbed' ? { routing_fleet: false } : null,
      }),
    );
    const json = routingDoctorToJson(report) as {
      schema_version: number;
      summary: { verdict: string; pins_consistent: boolean; routing_repos: number };
      non_fleet_repos: string[];
      caller_pins: ReadonlyArray<Record<string, unknown>>;
    };
    expect(json.schema_version).toBe(1); // additive → NO bump
    expect(json.summary.pins_consistent).toBe(true); // testbed excluded → the member is consistent
    expect(json.summary.routing_repos).toBe(1); // only the member participates
    expect(json.non_fleet_repos).toEqual(['groundnuty/macf-testbed']);
    const testbed = json.caller_pins.find((p) => p.repo === 'groundnuty/macf-testbed')!;
    expect(testbed.fleet_member).toBe(false);
    expect(testbed.consistent).toBeNull();
    const macf = json.caller_pins.find((p) => p.repo === 'groundnuty/macf')!;
    expect(macf.fleet_member).toBe(true);
    expect(macf.consistent).toBe(true);
  });

  it('additive (#800): routing_client_cert + summary.routing_client_cert_ok; orphaned → DEGRADED', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readRoutingClientCertIssuer: async () =>
          JSON.stringify({ issuer_fingerprint: 'OLD-FP', minted_at: '2026-06-01T00:00:00Z' }),
        currentCaFingerprint: () => 'NEW-FP',
      }),
    );
    const json = routingDoctorToJson(report) as {
      schema_version: number;
      summary: { verdict: string; routing_client_cert_ok: boolean };
      routing_client_cert: { state: string; recorded_fingerprint: string | null; current_fingerprint: string | null; minted_at: string | null; reason: string | null };
    };
    expect(json.schema_version).toBe(1); // additive → NO bump
    expect(json.summary.verdict).toBe('DEGRADED');
    expect(json.summary.routing_client_cert_ok).toBe(false);
    expect(json.routing_client_cert).toMatchObject({
      state: 'orphaned',
      recorded_fingerprint: 'OLD-FP',
      current_fingerprint: 'NEW-FP',
      minted_at: '2026-06-01T00:00:00Z',
    });
    expect(json.routing_client_cert.reason).toMatch(/#800/);
  });

  it('additive (#800): an absent (never-minted) routing-client cert reports routing_client_cert_ok:true', async () => {
    const report = await gatherRoutingDoctor(deps({ readRoutingClientCertIssuer: async () => null }));
    const json = routingDoctorToJson(report) as {
      summary: { routing_client_cert_ok: boolean };
      routing_client_cert: { state: string };
    };
    expect(json.routing_client_cert.state).toBe('absent');
    expect(json.summary.routing_client_cert_ok).toBe(true); // absent is NOT a fault
  });
});

// --- Command entry point ---

describe('runRoutingDoctor (injected deps)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => logSpy?.mockRestore());

  it('prints both tables + CA line + summary + honesty legend; exits non-zero on DEGRADED', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      {},
      deps({
        readCallerPin: async (repo) =>
          repo === 'groundnuty/macf-science-agent'
            ? { repo, pin: 'v1.3.4', status: 'pinned' }
            : { repo, pin: 'v3.3.0', status: 'pinned' },
      }),
    );
    expect(code).toBe(1);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('macf routing doctor — macf');
    expect(out).toContain('CALLER-PIN');
    expect(out).toContain('SELF-SKIP');
    expect(out).toContain('MACF_CA_CERT:');
    expect(out).toContain('routing plane: DEGRADED');
    expect(out).toContain('STATIC GitHub-plane checks'); // honesty legend
    expect(out).toContain('--e2e');
  });

  it('exits 0 when HEALTHY', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor('/unused', {}, deps());
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('routing plane: HEALTHY');
  });

  it('prints the ROUTING-CLIENT CERT ISSUER line + exits 1 (DEGRADED) when orphaned (#800)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      {},
      deps({
        readRoutingClientCertIssuer: async () =>
          JSON.stringify({ issuer_fingerprint: 'OLD-FP', minted_at: '2026-06-01T00:00:00Z' }),
        currentCaFingerprint: () => 'NEW-FP',
      }),
    );
    expect(code).toBe(1);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('ROUTING-CLIENT CERT ISSUER');
    expect(out).toMatch(/orphaned/);
    expect(out).toContain('routing plane: DEGRADED');
  });

  it('never-minted routing-client cert prints "— n/a" and stays exit 0 (HEALTHY) (#800)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor('/unused', {}, deps({ readRoutingClientCertIssuer: async () => null }));
    expect(code).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('ROUTING-CLIENT CERT ISSUER');
    expect(out).toMatch(/n\/a/);
    expect(out).toContain('routing plane: HEALTHY');
  });

  it('prints the warnings block + exits 0 (HEALTHY) on a stale session (DR-032 #610)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      {},
      deps({
        readRoutingConfig: async () => ({
          agents: {
            'code-agent': { app_name: 'macf-code-agent', tmux_session: 'code-agent' }, // stale drift
            'science-agent': { app_name: 'macf-science-agent', tmux_session: 'macf@science-agent' },
          },
        }),
      }),
    );
    expect(code).toBe(0); // WARN-not-FAIL → not DEGRADED
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('routing plane: HEALTHY');
    expect(out).toContain('Warnings');
    expect(out).toMatch(/code-agent/);
  });

  it('emits the stable JSON contract under --json (exit code still reflects verdict)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      { json: true },
      deps({ readCaCert: async () => 'not-a-cert!!!' }), // malformed CA → DEGRADED
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.summary.verdict).toBe('DEGRADED');
    expect(parsed.ca_cert).toMatchObject({ present: true, valid: false });
  });

  it('prints the non-fleet opt-out note + exits 0 (HEALTHY) when an outlier opted out (#614)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      {},
      deps({
        listRepos: async () => ['groundnuty/macf', 'groundnuty/macf-testbed'],
        readCallerPin: async (repo) =>
          repo === 'groundnuty/macf-testbed'
            ? { repo, pin: 'v1.3.3', status: 'pinned' }
            : { repo, pin: 'v3.3.0', status: 'pinned' },
        readFleetMarker: async (repo) =>
          repo === 'groundnuty/macf-testbed' ? { routing_fleet: false } : null,
      }),
    );
    expect(code).toBe(0); // the opt-out clears the false pins_consistent:false
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('routing plane: HEALTHY');
    expect(out).toContain('Non-fleet (opt-out via .github/macf-fleet.json');
    expect(out).toContain('groundnuty/macf-testbed');
  });

  it('reports EMPTY cleanly (exit 0) when nothing is discovered', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      {},
      deps({ listRepos: async () => [], readRoutingConfig: async () => null, listRegistry: async () => [], readCaCert: async () => VALID_PEM }),
    );
    expect(code).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/Nothing to check/);
  });

  it('honors --expected-pin (flags repos off the explicitly-expected pin)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      { json: true, expectedPin: 'v3.3.0' },
      deps({ readCallerPin: async (repo) => ({ repo, pin: 'v1.3.4', status: 'pinned' }) }),
    );
    expect(code).toBe(1); // all repos diverge from the expected v3.3.0
    const parsed = JSON.parse(logSpy.mock.calls.flat().join(''));
    expect(parsed.summary.expected_pin).toBe('v3.3.0');
    expect(parsed.summary.pins_consistent).toBe(false);
  });
});
