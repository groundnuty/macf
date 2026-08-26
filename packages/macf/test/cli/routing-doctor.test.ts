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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { caCertFingerprint } from '@groundnuty/macf-core';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import {
  buildAgentRows,
  buildArtifactRows,
  buildRepoRows,
  caCertLine,
  caMismatchCauseLine,
  caMismatchLikelyCause,
  classifyFreshness,
  collectNonFleetRepos,
  collectWarnings,
  computeExpectedPin,
  evaluateCaCert,
  evaluateRoutingArtifact,
  evaluateRoutingClientCertIssuer,
  evaluateSelfSkip,
  evaluateSession,
  formatAgentTable,
  formatArtifactTable,
  formatRepoTable,
  freshnessGlyph,
  gatherRoutingArtifacts,
  gatherRoutingDoctor,
  isFleetMember,
  isStrictBase64,
  normalizeLogin,
  parseRoutingClientCertIssuer,
  pinGlyph,
  routingClientCertGlyph,
  selfSkipGlyph,
  sessionGlyph,
  ROUTING_DOCTOR_JSON_SCHEMA_VERSION,
  routingDoctorToJson,
  routingVerdict,
  runRoutingDoctor,
  summaryLine,
  type CallerPinResult,
  type RoutingArtifactCheck,
  type RoutingConfig,
  type RoutingConfigReadResult,
  type RoutingDoctorDeps,
  type RoutingProbeFn,
} from '../../src/cli/commands/routing-doctor.js';
import { pinCorrectnessLine } from '../../src/cli/commands/routing-doctor-pin-correctness.js';

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

/**
 * A DIFFERENT well-formed PEM cert (macf#873) — same shape as `VALID_PEM`, but
 * its fingerprint differs. Simulates a rotated-out-but-well-formed registry CA:
 * `evaluateCaCert` reports `present:true, valid:true` for this, same as
 * `VALID_PEM` — the #563 parse check alone cannot distinguish them. Only the
 * `matchesCurrentCa` comparison against a machine's actual current CA can.
 */
const ROTATED_PEM = `-----BEGIN CERTIFICATE-----\n${Buffer.from('y'.repeat(120)).toString('base64')}\n-----END CERTIFICATE-----`;

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

describe('evaluateSelfSkip — #538(b) / #566, tri-state (macf#874)', () => {
  it('exact bot-login match passes (normalized, [bot]-tolerant) — a VERIFIED ok', () => {
    expect(evaluateSelfSkip('code-agent', 'macf-code-agent', 'macf-code-agent[bot]')).toEqual({ status: 'ok' });
  });
  it('app_name != bot-login fails when the authoritative login is known', () => {
    const r = evaluateSelfSkip('code-agent', 'something-wrong', 'macf-code-agent[bot]');
    expect(r.status).toBe('not_ok');
    expect(r.reason).toMatch(/!= bot-login/);
  });
  it('heuristic: bare routing label (the #566 bug) fails with no authoritative login', () => {
    const r = evaluateSelfSkip('code-agent', 'code-agent');
    expect(r.status).toBe('not_ok');
    expect(r.reason).toMatch(/bare routing label, not a bot-login/);
  });
  // DECISIVE (macf#874 / assert-the-wrong-path.md): a broken implementation that
  // reports `ok` for ANY non-bare-label value would ALSO pass a bare `status !==
  // 'ok'`-is-false-only check — that's exactly the pre-#874 defect. The property
  // this check can actually establish here is "not the one known-bad shape", NOT
  // "is a correct bot-login" — so the outcome MUST be the specific literal
  // `'unresolvable'`, not `'ok'` and not merely "not not_ok".
  it('heuristic: a bot-login-shaped app_name with NO authoritative login → unresolvable, NOT ok', () => {
    const r = evaluateSelfSkip('code-agent', 'macf-code-agent');
    expect(r.status).toBe('unresolvable');
    expect(r.status).not.toBe('ok');
    expect(r.reason).toMatch(/no authoritative bot-login/);
  });
  it('missing app_name fails', () => {
    expect(evaluateSelfSkip('code-agent', undefined).status).toBe('not_ok');
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

describe('evaluateCaCert — current-CA comparison (macf#873)', () => {
  const VALID_PEM_FP = caCertFingerprint(VALID_PEM);

  it('matching fingerprint → matchesCurrentCa:true, both fingerprints surfaced', () => {
    const r = evaluateCaCert(VALID_PEM, VALID_PEM_FP);
    expect(r).toMatchObject({
      present: true,
      valid: true,
      matchesCurrentCa: true,
      registryCaFingerprint: VALID_PEM_FP,
      currentCaFingerprint: VALID_PEM_FP,
    });
  });

  it('well-formed but DIFFERENT cert → present:true valid:true matchesCurrentCa:false (the #873 gap)', () => {
    const r = evaluateCaCert(ROTATED_PEM, VALID_PEM_FP);
    expect(r.present).toBe(true);
    expect(r.valid).toBe(true); // #563 alone would call this a PASS
    expect(r.matchesCurrentCa).toBe(false); // #873 catches what #563 cannot
    expect(r.registryCaFingerprint).not.toBe(r.currentCaFingerprint);
  });

  it('no currentCaFingerprint given (omitted) → matchesCurrentCa:null, never a silent pass', () => {
    const r = evaluateCaCert(VALID_PEM);
    expect(r.present).toBe(true);
    expect(r.valid).toBe(true);
    expect(r.matchesCurrentCa).toBeNull();
  });

  it('currentCaFingerprint explicitly null (no local CA on this machine) → matchesCurrentCa:null', () => {
    const r = evaluateCaCert(VALID_PEM, null);
    expect(r.matchesCurrentCa).toBeNull();
    expect(r.currentCaFingerprint).toBeNull();
  });

  it('malformed registry cert + a current fingerprint given → matchesCurrentCa:null (nothing to compare)', () => {
    const bad = '-----BEGIN CERTIFICATE-----\nAAAA!notbase64\n-----END CERTIFICATE-----';
    const r = evaluateCaCert(bad, VALID_PEM_FP);
    expect(r.valid).toBe(false);
    expect(r.matchesCurrentCa).toBeNull();
    expect(r.registryCaFingerprint).toBeNull();
  });
});

describe('caCertLine — text render (macf#873)', () => {
  it('absent → plain ✗ absent', () => {
    expect(caCertLine(evaluateCaCert(null))).toBe('MACF_CA_CERT: ✗ absent');
  });
  it('malformed → ✗ + reason, no fingerprint talk', () => {
    const line = caCertLine(evaluateCaCert('not-a-cert!!!'));
    expect(line).toMatch(/^MACF_CA_CERT: ✗/);
  });
  it('matches current CA → ✓ pass, names the fingerprint', () => {
    const fp = caCertFingerprint(VALID_PEM);
    const line = caCertLine(evaluateCaCert(VALID_PEM, fp));
    expect(line).toMatch(/^MACF_CA_CERT: ✓/);
    expect(line).toMatch(/matches current CA/);
  });
  it('definite mismatch → ✗, names macf#873 + both fingerprints, never reads as a pass', () => {
    const fp = caCertFingerprint(VALID_PEM);
    const line = caCertLine(evaluateCaCert(ROTATED_PEM, fp));
    expect(line).toMatch(/^MACF_CA_CERT: ✗/);
    expect(line).toMatch(/does NOT match the current CA/);
    expect(line).toMatch(/does NOT match/);
  });
  it('matchesCurrentCa:null (no local CA) → "— n/a", visually distinct from the ✓-match pass', () => {
    const line = caCertLine(evaluateCaCert(VALID_PEM, null));
    expect(line).toMatch(/^MACF_CA_CERT: ✓/); // still present+valid
    expect(line).toMatch(/n\/a/);
    expect(line).not.toMatch(/matches current CA/); // must NOT read as the full pass
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

// Default baseline (#800 + macf#873): the "current local CA" the fixtures agree
// on is VALID_PEM's OWN fingerprint — so the default `readCaCert: () => VALID_PEM`
// (check 4) AND the default `readRoutingClientCertIssuer` recorded value (check 6)
// both compare EQUAL to `currentCaFingerprint()` out of the box, and neither check
// fails the baseline unless a test deliberately diverges them.
const CURRENT_CA_FINGERPRINT = caCertFingerprint(VALID_PEM);

function deps(over: Partial<RoutingDoctorDeps> = {}): RoutingDoctorDeps {
  return {
    project: 'macf',
    now: Date.parse('2026-06-26T12:00:00Z'),
    listRepos: async () => ['groundnuty/macf', 'groundnuty/macf-science-agent'],
    readCallerPin: ALL_PINNED_V3,
    // Default: no opt-out marker anywhere → every pinned repo is a fleet member (#614).
    readFleetMarker: async () => null,
    readRoutingConfig: async () => HEALTHY_CONFIG,
    // macf#1191 defaults: every visible repo's OWN table names the same two
    // agents as HEALTHY_CONFIG, and both labels exist in every repo — so the
    // baseline fixture is clean for the artifact sweep too, unless a test
    // deliberately diverges one repo's config or labels. macf#1193: the
    // discriminated `present` result, not the bare config.
    readRoutingConfigForRepo: async () => ({ status: 'present', config: HEALTHY_CONFIG }),
    listRepoLabels: async () => ['code-agent', 'science-agent'],
    listRegistry: async () => [
      { name: 'CODE_AGENT', info: info('100.64.0.1', 4100, 'inst-code') },
      { name: 'SCIENCE_AGENT', info: info('100.64.0.2', 4200, 'inst-science') },
    ],
    probe: async (_h, port) => (port === 4100 ? health('inst-code') : health('inst-science')),
    readCaCert: async () => VALID_PEM,
    readRoutingClientCertIssuer: async () =>
      JSON.stringify({ issuer_fingerprint: CURRENT_CA_FINGERPRINT, minted_at: '2026-06-01T00:00:00Z' }),
    currentCaFingerprint: () => CURRENT_CA_FINGERPRINT,
    // macf#874: an authoritative login for BOTH fixture agents, so the "all-green
    // baseline" genuinely VERIFIES self-skip (`ok`) rather than resting on the
    // pre-#874 heuristic-passes-without-confirmation shape. Real production deps
    // only ever populate the RUNNING agent's own label (`resolveDepsFromRegistry`)
    // — a peer is the `unresolvable` case exercised explicitly below.
    botLogins: { 'code-agent': 'macf-code-agent[bot]', 'science-agent': 'macf-science-agent[bot]' },
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
    // macf#874: the baseline's self-skip is a genuine VERIFIED ok (both fixture
    // agents have an authoritative botLogins entry), not the pre-#874 heuristic pass.
    expect(report.agents.every((a) => a.selfSkipStatus === 'ok')).toBe(true);
    expect(report.ca).toMatchObject({ present: true, valid: true });
  });
});

describe('gatherRoutingDoctor — a REJECTED probe degrades ONE agent, never aborts the join (macf#959)', () => {
  it('the other agent still gets a full row when one probe rejects', async () => {
    // Before this fix, `evaluateAgentRow`'s `await deps.probe(...)` had no
    // isolation — a rejected probe (the same transient TOCTOU-style fault
    // `fleet.ts`'s `safeProbe` guards against, macf#609) propagated straight
    // through `gatherRoutingDoctor`'s per-agent loop and out of
    // `runRoutingDoctor` UNCAUGHT (no top-level catch existed at all). That
    // is the exact "Error: fetch failed, no table, no per-agent verdict"
    // symptom macf#959 reported for `macf routing doctor`.
    const rejecting = deps({
      probe: async (_h, port) => {
        if (port === 4200) throw new Error('fetch failed');
        return health('inst-code');
      },
    });
    const report = await gatherRoutingDoctor(rejecting);
    expect(report.agents).toHaveLength(2); // the join still resolves with BOTH agents
    const code = report.agents.find((a) => a.label === 'code-agent');
    const science = report.agents.find((a) => a.label === 'science-agent');
    expect(code?.freshness).toBe('fresh'); // unaffected peer renders normally
    // The rejected peer degrades to the SAME shape a genuine `null` /health
    // produces (classifyFreshness treats null the same way) — never a throw.
    expect(science?.freshness === 'unreachable' || science?.freshness === 'stale').toBe(true);
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

describe('check 1 — pin CORRECTNESS vs the fleet manifest (macf#872): consistency-only reads a uniformly-stale fleet as healthy', () => {
  it('DECISIVE CASE 1 — every repo matches the manifest → consistent-and-correct, HEALTHY, "current" in the rendered line', async () => {
    const report = await gatherRoutingDoctor(deps({ desiredActionsPin: async () => 'v3.3.0' }));
    expect(report.desiredActionsPin).toBe('v3.3.0');
    expect(report.repoPins.every((r) => r.correctness === 'correct')).toBe(true);
    const json = routingDoctorToJson(report) as {
      summary: { pin_state: string; desired_actions_pin: string | null; verdict: string };
    };
    expect(json.summary.pin_state).toBe('consistent-and-correct');
    expect(json.summary.desired_actions_pin).toBe('v3.3.0');
    expect(routingVerdict(report)).toBe('HEALTHY');
    expect(summaryLine(report)).toMatch(/current/);
  });

  it('DECISIVE CASE 2 (the macf#872 bug) — every repo drifted to the SAME wrong pin: a consistency-only check would read this identically to case 1', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        // Every repo agrees with the OTHERS (uniformly v3.4.1) — the pre-existing
        // `consistent` check alone cannot tell this apart from a genuinely healthy fleet.
        readCallerPin: async (repo) => ({ repo, pin: 'v3.4.1', status: 'pinned' }),
        desiredActionsPin: async () => 'v3.4.2', // the manifest's current value
      }),
    );
    expect(report.repoPins.every((r) => r.consistent === true)).toBe(true); // the OLD signal reads "healthy"
    expect(report.repoPins.every((r) => r.correctness === 'incorrect')).toBe(true); // the NEW signal catches it
    const json = routingDoctorToJson(report) as {
      summary: { pin_state: string; verdict: string };
    };
    expect(json.summary.pin_state).toBe('consistent-but-wrong'); // distinct literal from case 1
    expect(json.summary.pin_state).not.toBe('consistent-and-correct');
    // Warn-never-fail: the exit-code-driving verdict is untouched by design.
    expect(routingVerdict(report)).toBe('HEALTHY');
    expect(json.summary.verdict).toBe('HEALTHY');
    // The decisive assertion for the "composite verdict must not overstate" requirement:
    // the rendered line a human reads must NOT still say "pins consistent" bare — it must
    // say STALE, in the SAME clause, not a separate footnote.
    const line = summaryLine(report);
    expect(line).toMatch(/STALE/);
    expect(line).not.toMatch(/pins consistent\)/);
    // And it's loud (non-fatal warning), not silent.
    expect(collectWarnings(report).some((w) => /STALE/.test(w))).toBe(true);
  });

  it('DECISIVE CASE 3 — repos pinned to DIFFERENT versions → inconsistent, distinguishable from case 2, DEGRADED unchanged', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readCallerPin: async (repo) =>
          repo === 'groundnuty/macf-science-agent'
            ? { repo, pin: 'v3.4.1', status: 'pinned' }
            : { repo, pin: 'v3.4.2', status: 'pinned' },
        desiredActionsPin: async () => 'v3.4.2',
      }),
    );
    const json = routingDoctorToJson(report) as { summary: { pin_state: string; verdict: string } };
    expect(json.summary.pin_state).toBe('inconsistent');
    expect(json.summary.pin_state).not.toBe('consistent-but-wrong'); // the two failure modes stay distinguishable
    expect(routingVerdict(report)).toBe('DEGRADED'); // pre-existing behavior, untouched
  });

  it('no manifest reachable this run → unknown, never a pass — the honest floor', async () => {
    const report = await gatherRoutingDoctor(deps()); // no desiredActionsPin dep injected
    expect(report.desiredActionsPin).toBeNull();
    expect(report.repoPins.every((r) => r.correctness === 'unknown')).toBe(true);
    const json = routingDoctorToJson(report) as { summary: { pin_state: string } };
    expect(json.summary.pin_state).toBe('unknown');
    expect(summaryLine(report)).toMatch(/UNKNOWN/);
    expect(pinCorrectnessLine(report)).toMatch(/unknown/i);
    expect(routingVerdict(report)).toBe('HEALTHY'); // consistency alone still governs the untouched verdict
  });

  it('desiredActionsPin omitted from RoutingDoctorDeps entirely (no dep at all) also renders unknown, not a throw', async () => {
    const { desiredActionsPin: _omit, ...withoutDep } = deps();
    const report = await gatherRoutingDoctor(withoutDep as RoutingDoctorDeps);
    expect(report.desiredActionsPin).toBeNull();
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
    expect(code.selfSkipStatus).toBe('not_ok');
    expect(code.selfSkipReason).toMatch(/!= bot-login/);
    expect(routingVerdict(report)).toBe('DEGRADED');
  });

  // DECISIVE (macf#874): a PEER agent — the common real-world case, since
  // `resolveDepsFromRegistry` only ever populates the RUNNING agent's own
  // label in `botLogins`. Before #874 this reported `selfSkipOk: true` (a
  // silent pass on a presumption); it must now report `null` / `unresolvable`
  // and must NOT drive the verdict to DEGRADED on its own.
  it('a peer with no authoritative bot-login known reports unresolvable, NOT a pass, and does NOT degrade the verdict', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        // Only THIS agent's own label is authoritative — science-agent is a peer.
        botLogins: { 'code-agent': 'macf-code-agent[bot]' },
      }),
    );
    const science = report.agents.find((a) => a.label === 'science-agent')!;
    expect(science.selfSkipStatus).toBe('unresolvable');
    expect(science.selfSkipOk).toBeNull(); // never true on an unconfirmed heuristic pass
    expect(science.selfSkipReason).toMatch(/no authoritative bot-login/);
    // Regression guard (real detection unchanged): the OWN-label agent still
    // gets a genuine verified `ok` from the authoritative comparison.
    const code = report.agents.find((a) => a.label === 'code-agent')!;
    expect(code.selfSkipStatus).toBe('ok');
    expect(code.selfSkipOk).toBe(true);
    // `unresolvable` is an honest unknown, not a proven fault — same posture
    // as "no local config" — so it must not degrade the plane on its own.
    expect(routingVerdict(report)).toBe('HEALTHY');
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

describe('check 4 — CA currency: rotated-out-but-well-formed CA (macf#873)', () => {
  // THE MANDATORY SCENARIO: a well-formed but NON-current CA + every agent
  // unreachable + registry keys still present. Pre-#873, `evaluateCaCert` only
  // asserted present+valid (both true for ROTATED_PEM) and `freshnessFails` only
  // fails a definitive `'stale'`, not `'unreachable'` — so NOTHING failed the
  // verdict and this exact scenario read HEALTHY. Asserted through
  // `routingVerdict()`, never by inspecting a value this test just set.
  it('well-formed NON-current CA + all agents unreachable ⇒ DEGRADED, not HEALTHY (#872/#873 outage class)', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        readCaCert: async () => ROTATED_PEM, // well-formed, but NOT the current CA
        probe: async () => null, // every /health probe fails (rotated CA can't handshake)
      }),
    );
    // Registry keys are still present (routable) — the #872 absorption trap.
    expect(report.agents.every((a) => a.routable)).toBe(true);
    expect(report.agents.every((a) => a.freshness === 'unreachable')).toBe(true);
    expect(report.ca).toMatchObject({ present: true, valid: true, matchesCurrentCa: false });
    expect(routingVerdict(report)).toBe('DEGRADED');
  });

  it('matching CA still yields HEALTHY (no regression)', async () => {
    const report = await gatherRoutingDoctor(deps()); // default: readCaCert matches currentCaFingerprint
    expect(report.ca.matchesCurrentCa).toBe(true);
    expect(routingVerdict(report)).toBe('HEALTHY');
  });

  it('matchesCurrentCa:null (no local CA on this machine) does NOT fail the verdict and does NOT render as a pass', async () => {
    const report = await gatherRoutingDoctor(deps({ currentCaFingerprint: () => null }));
    expect(report.ca.matchesCurrentCa).toBeNull();
    expect(routingVerdict(report)).toBe('HEALTHY'); // null must NOT fail
    const line = caCertLine(report.ca);
    expect(line).not.toMatch(/matches current CA/); // must not read as the full pass
    expect(line).toMatch(/n\/a/);
  });
});

describe('caMismatchLikelyCause / caMismatchCauseLine — the absorption fix (macf#873)', () => {
  it('mismatch + ALL agents unreachable → likely cause TRUE, line names both fingerprints', async () => {
    const report = await gatherRoutingDoctor(
      deps({ readCaCert: async () => ROTATED_PEM, probe: async () => null }),
    );
    expect(caMismatchLikelyCause(report)).toBe(true);
    const line = caMismatchCauseLine(report);
    expect(line).toMatch(/likely cause/i);
    expect(line).toMatch(/2\/2 agents unreachable/);
    expect(line).toContain(report.ca.registryCaFingerprint!.slice(0, 8));
    expect(line).toContain(report.ca.currentCaFingerprint!.slice(0, 8));
  });

  it('mismatch + a MAJORITY (not all) unreachable → still TRUE', async () => {
    // 3 agents; 2 unreachable (majority), 1 fresh.
    const report = await gatherRoutingDoctor(
      deps({
        listRegistry: async () => [
          { name: 'CODE_AGENT', info: info('h', 4100, 'inst-code') },
          { name: 'SCIENCE_AGENT', info: info('h', 4200, 'inst-science') },
          { name: 'AUDITOR', info: info('h', 4900, 'inst-aud') },
        ],
        readRoutingConfig: async () => ({
          agents: {
            'code-agent': { app_name: 'macf-code-agent', tmux_session: 'macf@code-agent' },
            'science-agent': { app_name: 'macf-science-agent', tmux_session: 'macf@science-agent' },
          },
        }),
        probe: async (_h, port) => (port === 4900 ? health('inst-aud') : null),
        readCaCert: async () => ROTATED_PEM,
      }),
    );
    expect(report.agents.filter((a) => a.freshness === 'unreachable')).toHaveLength(2);
    expect(caMismatchLikelyCause(report)).toBe(true);
  });

  it('mismatch + a MINORITY unreachable → FALSE (does not over-claim)', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        listRegistry: async () => [
          { name: 'CODE_AGENT', info: info('h', 4100, 'inst-code') },
          { name: 'SCIENCE_AGENT', info: info('h', 4200, 'inst-science') },
          { name: 'AUDITOR', info: info('h', 4900, 'inst-aud') },
        ],
        readRoutingConfig: async () => ({
          agents: {
            'code-agent': { app_name: 'macf-code-agent', tmux_session: 'macf@code-agent' },
            'science-agent': { app_name: 'macf-science-agent', tmux_session: 'macf@science-agent' },
          },
        }),
        probe: async (_h, port) =>
          port === 4100 ? null : port === 4200 ? health('inst-science') : health('inst-aud'),
        readCaCert: async () => ROTATED_PEM,
      }),
    );
    expect(report.agents.filter((a) => a.freshness === 'unreachable')).toHaveLength(1);
    expect(caMismatchLikelyCause(report)).toBe(false);
    expect(caMismatchCauseLine(report)).toBeNull();
  });

  it('broad unreachability WITHOUT a CA mismatch → FALSE (only one of the two holds)', async () => {
    const report = await gatherRoutingDoctor(deps({ probe: async () => null })); // CA still matches (default)
    expect(report.ca.matchesCurrentCa).toBe(true);
    expect(caMismatchLikelyCause(report)).toBe(false);
    expect(caMismatchCauseLine(report)).toBeNull();
  });

  it('CA mismatch WITHOUT broad unreachability → FALSE (only one of the two holds)', async () => {
    const report = await gatherRoutingDoctor(deps({ readCaCert: async () => ROTATED_PEM })); // agents stay fresh
    expect(report.agents.every((a) => a.freshness === 'fresh')).toBe(true);
    expect(caMismatchLikelyCause(report)).toBe(false);
    expect(caMismatchCauseLine(report)).toBeNull();
  });

  it('no agents at all → FALSE (nothing to attribute to)', async () => {
    const report = await gatherRoutingDoctor(
      deps({ readCaCert: async () => ROTATED_PEM, readRoutingConfig: async () => null, listRegistry: async () => [] }),
    );
    expect(report.agents).toHaveLength(0);
    expect(caMismatchLikelyCause(report)).toBe(false);
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
    // No local config at all → `selfSkipStatus` is null too (distinct from `unresolvable`,
    // which requires a local config entry to have been evaluated in the first place).
    expect(report.agents.every((a) => a.selfSkipStatus === null)).toBe(true);
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
  // macf#874: the matching state is `presumed-ok`, not `ok` — the deployed cert
  // is a write-only secret this command cannot read, so a match is a comparison
  // of the one readable proxy, never a verification of the cert itself. Assert
  // the exact literal (not just "not orphaned") and that the reason SAYS so.
  it('matching fingerprints → presumed-ok, with a reason naming the presumption', () => {
    const raw = JSON.stringify({ issuer_fingerprint: 'FP1', minted_at: '2026-07-01T00:00:00Z' });
    const r = evaluateRoutingClientCertIssuer(raw, 'FP1');
    expect(r.state).toBe('presumed-ok');
    expect((r.state as string)).not.toBe('ok');
    expect(r.recordedFingerprint).toBe('FP1');
    expect(r.currentFingerprint).toBe('FP1');
    expect(r.mintedAt).toBe('2026-07-01T00:00:00Z');
    expect(r.reason).toMatch(/PRESUMED/);
  });

  it('mismatched fingerprints → orphaned, with a #800 remediation reason', () => {
    const raw = JSON.stringify({ issuer_fingerprint: 'OLD-FP', minted_at: '2026-06-01T00:00:00Z' });
    const r = evaluateRoutingClientCertIssuer(raw, 'NEW-FP');
    expect(r.state).toBe('orphaned');
    expect(r.recordedFingerprint).toBe('OLD-FP');
    expect(r.currentFingerprint).toBe('NEW-FP');
    expect(r.reason).toMatch(/orphaned/);
    expect(r.reason).toMatch(/macf certs issue-routing-client/);
    expect(r.reason).toMatch(/re-mint via `macf certs issue-routing-client`/);
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

describe('routingClientCertGlyph (#800, macf#874)', () => {
  it('renders the three states — presumed-ok is visually distinct from a plain pass', () => {
    const g = routingClientCertGlyph('presumed-ok');
    expect(g).toContain('✓');
    expect(g).toMatch(/presum/i); // never an unqualified ✓ — the deployed secret was never read
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
    expect(report.routingClientCert.state).toBe('presumed-ok');
    expect(routingVerdict(report)).toBe('DEGRADED'); // caFail still bites
  });
});

// --- check 7 — routing-table artifact checks (macf#1191) ---

describe('evaluateRoutingArtifact — pure per-(repo,agent) evaluator (macf#1191)', () => {
  const LABEL_CHECK: RoutingArtifactCheck = {
    artifact: 'assignment-label',
    fetchRepoState: async () => null, // unused directly by the pure evaluator
    isPresent: (agent, labels) => labels.includes(agent),
  };

  it('present: the label is in the fetched repo state', () => {
    const r = evaluateRoutingArtifact('groundnuty/macf-science-agent', 'devops-agent', LABEL_CHECK, [
      'code-agent',
      'devops-agent',
    ]);
    expect(r).toMatchObject({ status: 'present' });
    expect(r.reason).toBeUndefined();
  });

  it('missing: the repo state was read successfully but does not contain the agent', () => {
    const r = evaluateRoutingArtifact('groundnuty/macf-science-agent', 'devops-agent', LABEL_CHECK, [
      'code-agent',
      'science-agent',
    ]);
    expect(r).toMatchObject({ status: 'missing', repo: 'groundnuty/macf-science-agent', agent: 'devops-agent' });
    expect(r.reason).toMatch(/no matching assignment-label/);
  });

  it('not-visible: the repo-state read itself failed (null) — NEVER reported as missing', () => {
    const r = evaluateRoutingArtifact('groundnuty/macf-science-agent', 'devops-agent', LABEL_CHECK, null);
    expect(r.status).toBe('not-visible');
    expect(r.status).not.toBe('missing'); // DECISIVE: an inconclusive read must not read as a confirmed fault
    expect(r.reason).toBe('not visible to this caller — could be absent, private, or misnamed');
  });
});

describe('gatherRoutingArtifacts — the per-repo sweep (macf#1191)', () => {
  const LABEL_CHECK = (fetchRepoState: (repo: string) => Promise<readonly string[] | null>): RoutingArtifactCheck => ({
    artifact: 'assignment-label',
    fetchRepoState,
    isPresent: (agent, labels) => labels.includes(agent),
  });

  it('a repo with no routing table at all contributes NOTHING (not "missing", not "not-visible")', async () => {
    const results = await gatherRoutingArtifacts(
      ['groundnuty/macf-actions'],
      async () => ({ status: 'absent' }), // no .github/agent-config.json
      [LABEL_CHECK(async () => [])],
    );
    expect(results).toEqual([]);
  });

  it('a repo with an EMPTY agents map contributes nothing (nothing implied, nothing to check)', async () => {
    const results = await gatherRoutingArtifacts(
      ['groundnuty/some-repo'],
      async () => ({ status: 'present', config: { agents: {} } }),
      [LABEL_CHECK(async () => [])],
    );
    expect(results).toEqual([]);
  });

  it('sweeps every repo independently — one repo missing, the other satisfied', async () => {
    const results = await gatherRoutingArtifacts(
      ['groundnuty/macf', 'groundnuty/macf-science-agent'],
      async (repo) => ({
        status: 'present',
        config: {
          agents:
            repo === 'groundnuty/macf'
              ? { 'code-agent': {} }
              : { 'devops-agent': {} }, // the literal macf#1191 shape
        },
      }),
      [
        LABEL_CHECK(async (repo) =>
          repo === 'groundnuty/macf' ? ['code-agent'] : ['code-agent', 'science-agent'], // no devops-agent label
        ),
      ],
    );
    expect(results).toEqual([
      { repo: 'groundnuty/macf', agent: 'code-agent', artifact: 'assignment-label', status: 'present' },
      {
        repo: 'groundnuty/macf-science-agent',
        agent: 'devops-agent',
        artifact: 'assignment-label',
        status: 'missing',
        reason: expect.stringContaining('no matching assignment-label') as unknown as string,
      },
    ]);
  });

  // --- macf#1193: a repo's OWN config can be present-but-broken, or fail to
  // read for a transient reason — both DISTINCT from the absent case above.

  it('a MALFORMED config → one repo-level defect entry, DISTINCT from a per-agent "missing" row', async () => {
    const results = await gatherRoutingArtifacts(
      ['groundnuty/macf-science-agent'],
      async () => ({ status: 'malformed', reason: 'content is not valid JSON' }),
      [LABEL_CHECK(async () => ['code-agent'])],
    );
    expect(results).toEqual([
      expect.objectContaining({
        repo: 'groundnuty/macf-science-agent',
        artifact: 'routing-config',
        status: 'config-malformed',
      }),
    ]);
    // DECISIVE: not the per-agent "missing" literal a broken assignment-label
    // check would use — a consumer switching on `status` must be able to tell
    // "the config itself is broken" apart from "an agent has no label."
    expect(results[0]?.status).not.toBe('missing');
  });

  it('a READ-FAILED config → one repo-level inconclusive entry, DISTINCT from malformed AND from absent', async () => {
    const results = await gatherRoutingArtifacts(
      ['groundnuty/macf-science-agent'],
      async () => ({ status: 'read-failed', reason: 'network, rate-limit, or a transient gh api failure' }),
      [LABEL_CHECK(async () => ['code-agent'])],
    );
    expect(results).toEqual([
      expect.objectContaining({
        repo: 'groundnuty/macf-science-agent',
        artifact: 'routing-config',
        status: 'config-read-failed',
      }),
    ]);
    expect(results[0]?.status).not.toBe('config-malformed');
    expect(results[0]?.status).not.toBe('not-visible');
  });
});

describe('gatherRoutingDoctor — routing-table artifact checks (macf#1191)', () => {
  // --- Decisive pair (assert-the-wrong-path.md): a check that ALWAYS fails
  // would pass case 1 alone; a check that NEVER runs would pass case 2 alone.
  // Both must hold for the sweep to be trusted.

  it('DECISIVE 1/2: a repo names an agent with no matching label → reported by (repo, agent), verdict DEGRADED', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        listRepos: async () => ['groundnuty/macf', 'groundnuty/macf-science-agent'],
        // groundnuty/macf-science-agent's OWN table names devops-agent (the
        // literal macf#1191 incident shape) — but its labels don't include it.
        readRoutingConfigForRepo: async (repo) =>
          repo === 'groundnuty/macf-science-agent'
            ? { status: 'present', config: { agents: { 'devops-agent': { app_name: 'macf-devops-agent' } } } }
            : { status: 'present', config: HEALTHY_CONFIG },
        listRepoLabels: async (repo) =>
          repo === 'groundnuty/macf-science-agent' ? ['code-agent', 'science-agent'] : ['code-agent', 'science-agent'],
      }),
    );
    const missing = report.artifactChecks.filter((r) => r.status === 'missing');
    expect(missing).toEqual([
      expect.objectContaining({
        repo: 'groundnuty/macf-science-agent',
        agent: 'devops-agent',
        artifact: 'assignment-label',
        status: 'missing',
      }),
    ]);
    expect(routingVerdict(report)).toBe('DEGRADED');

    const json = routingDoctorToJson(report) as {
      summary: { routing_artifacts_ok: boolean; routing_artifacts_missing: number };
      routing_artifacts: ReadonlyArray<{ repo: string; agent: string; status: string }>;
    };
    expect(json.summary.routing_artifacts_ok).toBe(false);
    expect(json.summary.routing_artifacts_missing).toBe(1);
    expect(
      json.routing_artifacts.some(
        (r) => r.repo === 'groundnuty/macf-science-agent' && r.agent === 'devops-agent' && r.status === 'missing',
      ),
    ).toBe(true);
  });

  it('DECISIVE 2/2: every entry satisfied → passes AND reports nothing (the sweep actually ran, not vacuously clean)', async () => {
    const report = await gatherRoutingDoctor(deps());
    // Not just "missing is empty" (an implementation that never runs would
    // also report that) — assert the sweep produced REAL entries that are
    // all `present`, per assert-the-wrong-path.md.
    expect(report.artifactChecks.length).toBeGreaterThan(0);
    expect(report.artifactChecks.every((r) => r.status === 'present')).toBe(true);
    expect(routingVerdict(report)).toBe('HEALTHY');

    const json = routingDoctorToJson(report) as {
      summary: {
        routing_artifacts_ok: boolean;
        routing_artifacts_missing: number;
        routing_artifacts_not_visible: number;
        routing_artifacts_repos_visible: number;
        routing_artifacts_fully_covered: boolean;
      };
    };
    expect(json.summary.routing_artifacts_ok).toBe(true);
    expect(json.summary.routing_artifacts_missing).toBe(0);
    expect(json.summary.routing_artifacts_not_visible).toBe(0);
    expect(json.summary.routing_artifacts_fully_covered).toBe(true);
    // The coverage figure is present even on a clean run (macf#1191's coordination
    // correction: "0 missing" must never stand alone without it).
    expect(json.summary.routing_artifacts_repos_visible).toBeGreaterThan(0);
  });

  // --- Third case (coordinator correction): a target this caller cannot see.
  it('THIRD CASE: a repo this caller cannot read → not-visible, NOT missing, and the run is not reported as "all clear"', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        listRepos: async () => ['groundnuty/macf', 'groundnuty/macf-science-agent'],
        readRoutingConfigForRepo: async () => ({ status: 'present', config: HEALTHY_CONFIG }),
        // groundnuty/macf-science-agent's config read succeeded (we KNOW it
        // names code-agent + science-agent) but the label-list read for it
        // failed — indistinguishable from "private", "gone", or "misnamed".
        listRepoLabels: async (repo) => (repo === 'groundnuty/macf-science-agent' ? null : ['code-agent', 'science-agent']),
      }),
    );
    const notVisible = report.artifactChecks.filter((r) => r.status === 'not-visible');
    expect(notVisible.length).toBeGreaterThan(0);
    expect(notVisible.every((r) => r.repo === 'groundnuty/macf-science-agent')).toBe(true);
    // A not-visible repo is never reported as a CONFIRMED missing label.
    expect(report.artifactChecks.some((r) => r.repo === 'groundnuty/macf-science-agent' && r.status === 'missing')).toBe(
      false,
    );
    // Coordinator's lean: not-visible does NOT flip the pass/fail verdict —
    // an App legitimately installed on a subset of repos is normal.
    expect(routingVerdict(report)).toBe('HEALTHY');

    const json = routingDoctorToJson(report) as {
      summary: { routing_artifacts_ok: boolean; routing_artifacts_not_visible: number; routing_artifacts_fully_covered: boolean };
    };
    // But "ok" and "fully covered" are DIFFERENT questions — ok stays true
    // (nothing CONFIRMED broken), while fully_covered must go false so a
    // consumer reading ONLY routing_artifacts_ok cannot mistake this for a
    // complete, full-fleet clean bill.
    expect(json.summary.routing_artifacts_ok).toBe(true);
    expect(json.summary.routing_artifacts_not_visible).toBeGreaterThan(0);
    expect(json.summary.routing_artifacts_fully_covered).toBe(false);

    // And the human-readable line must say so too — never a bare "✓" that
    // reads identically to the fully-covered clean case.
    const line = summaryLine(report);
    expect(line).toMatch(/not visible/);
    expect(line).not.toMatch(/routing-table artifacts ✓/);
  });
});

describe('gatherRoutingDoctor — malformed vs absent vs read-failed routing-config (macf#1193)', () => {
  // Refines macf#1191's `if (!config) continue`, which collapsed THREE
  // distinct read outcomes into the SAME "not a routing participant" free
  // pass. Each case below is asserted on independent coordinates — entry
  // count/shape for that repo, `routing_artifacts_ok`, `fully_covered`, and
  // the verdict — so no two cases can pass the same assertions (a check
  // that only asserted "not skipped" would pass for BOTH malformed and
  // read-failed; a check that only asserted "ok stays true" would pass for
  // BOTH absent and read-failed).

  it('MALFORMED: a confirmed defect on a confirmed participant — FAILS the verdict, but coverage is unaffected (the read succeeded)', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        listRepos: async () => ['groundnuty/macf', 'groundnuty/macf-science-agent'],
        readRoutingConfigForRepo: async (repo) =>
          repo === 'groundnuty/macf-science-agent'
            ? { status: 'malformed', reason: 'content is not valid JSON' }
            : { status: 'present', config: HEALTHY_CONFIG },
      }),
    );
    const configRows = report.artifactChecks.filter((r) => r.artifact === 'routing-config');
    expect(configRows).toEqual([
      expect.objectContaining({ repo: 'groundnuty/macf-science-agent', status: 'config-malformed' }),
    ]);
    expect(routingVerdict(report)).toBe('DEGRADED');

    const json = routingDoctorToJson(report) as {
      summary: {
        routing_artifacts_ok: boolean;
        routing_artifacts_fully_covered: boolean;
        routing_artifacts_config_malformed: number;
      };
    };
    expect(json.summary.routing_artifacts_ok).toBe(false);
    // DECISIVE vs read-failed below: the config READ SUCCEEDED (it's broken,
    // not unreadable) — fully_covered stays true.
    expect(json.summary.routing_artifacts_fully_covered).toBe(true);
    expect(json.summary.routing_artifacts_config_malformed).toBe(1);
  });

  it('ABSENT: a confident 404 on an already-visible repo — silently skipped, verdict AND coverage unaffected', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        listRepos: async () => ['groundnuty/macf', 'groundnuty/macf-science-agent'],
        readRoutingConfigForRepo: async (repo) =>
          repo === 'groundnuty/macf-science-agent'
            ? { status: 'absent' }
            : { status: 'present', config: HEALTHY_CONFIG },
      }),
    );
    // DECISIVE vs the other two: NO entry at all for the absent repo.
    expect(report.artifactChecks.some((r) => r.repo === 'groundnuty/macf-science-agent')).toBe(false);
    // The sweep genuinely ran (not vacuously clean) — the OTHER repo still
    // produced ordinary present entries.
    expect(report.artifactChecks.some((r) => r.repo === 'groundnuty/macf' && r.status === 'present')).toBe(true);
    expect(routingVerdict(report)).toBe('HEALTHY');

    const json = routingDoctorToJson(report) as {
      summary: { routing_artifacts_ok: boolean; routing_artifacts_fully_covered: boolean };
    };
    expect(json.summary.routing_artifacts_ok).toBe(true);
    expect(json.summary.routing_artifacts_fully_covered).toBe(true);
  });

  it('READ-FAILED: network/rate-limit — inconclusive, lowers coverage but does NOT fail the verdict, and is NEVER silently skipped', async () => {
    const report = await gatherRoutingDoctor(
      deps({
        listRepos: async () => ['groundnuty/macf', 'groundnuty/macf-science-agent'],
        readRoutingConfigForRepo: async (repo) =>
          repo === 'groundnuty/macf-science-agent'
            ? { status: 'read-failed', reason: 'network, rate-limit, or a transient gh api failure' }
            : { status: 'present', config: HEALTHY_CONFIG },
      }),
    );
    const configRows = report.artifactChecks.filter((r) => r.artifact === 'routing-config');
    expect(configRows).toEqual([
      expect.objectContaining({ repo: 'groundnuty/macf-science-agent', status: 'config-read-failed' }),
    ]);
    expect(routingVerdict(report)).toBe('HEALTHY');

    const json = routingDoctorToJson(report) as {
      summary: {
        routing_artifacts_ok: boolean;
        routing_artifacts_fully_covered: boolean;
        routing_artifacts_config_read_failed: number;
      };
    };
    expect(json.summary.routing_artifacts_ok).toBe(true);
    // DECISIVE vs malformed above: NOT a confirmed defect, so ok stays true —
    // but fully_covered goes false, unlike the malformed case.
    expect(json.summary.routing_artifacts_fully_covered).toBe(false);
    expect(json.summary.routing_artifacts_config_read_failed).toBe(1);
  });

  it('the negative half: a well-formed config on the SAME fixture produces NO config-level row', async () => {
    const report = await gatherRoutingDoctor(deps());
    expect(report.artifactChecks.some((r) => r.artifact === 'routing-config')).toBe(false);
  });
});

describe('rendering — routing-table artifact table (macf#1191)', () => {
  it('buildArtifactRows only renders non-present rows (present rows are silent, matching collectWarnings shape)', () => {
    const rows = buildArtifactRows([
      { repo: 'groundnuty/macf', agent: 'code-agent', artifact: 'assignment-label', status: 'present' },
      {
        repo: 'groundnuty/macf-science-agent',
        agent: 'devops-agent',
        artifact: 'assignment-label',
        status: 'missing',
        reason: 'no matching assignment-label',
      },
      {
        repo: 'groundnuty/macf-devops-toolkit',
        agent: 'auditor-agent',
        artifact: 'assignment-label',
        status: 'not-visible',
        reason: 'not visible to this caller — could be absent, private, or misnamed',
      },
    ]);
    expect(rows).toHaveLength(2); // the 'present' row is silent
    expect(rows.some((r) => r.includes('✗ missing'))).toBe(true);
    expect(rows.some((r) => r.includes('? not-visible'))).toBe(true);
  });

  it('buildArtifactRows renders config-malformed/config-read-failed with THEIR OWN glyphs, distinct from missing/not-visible (macf#1193)', () => {
    const rows = buildArtifactRows([
      {
        repo: 'groundnuty/macf-science-agent',
        agent: '(config)',
        artifact: 'routing-config',
        status: 'config-malformed',
        reason: 'malformed',
      },
      {
        repo: 'groundnuty/macf-devops-toolkit',
        agent: '(config)',
        artifact: 'routing-config',
        status: 'config-read-failed',
        reason: 'read-failed',
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.includes('✗ malformed'))).toBe(true);
    expect(rows.some((r) => r.includes('? unreadable'))).toBe(true);
    // DECISIVE: must not render as the per-agent literals — a reader must be
    // able to tell "the config is broken" apart from "an agent has no label."
    expect(rows.some((r) => r.includes('✗ missing'))).toBe(false);
    expect(rows.some((r) => r.includes('? not-visible'))).toBe(false);
  });

  it('formatArtifactTable renders a header even with zero non-present rows', () => {
    const table = formatArtifactTable([]);
    expect(table).toMatch(/REPO/);
    expect(table).toMatch(/AGENT/);
  });
});

describe('routing-table artifact checks are READ-ONLY by design (macf#1191 WHY-guard)', () => {
  const cliDir = fileURLToPath(new URL('../../src/cli/commands', import.meta.url));

  it('createRepoLabelLister issues a read-only gh call — no write/mutate flags near the labels endpoint', () => {
    const src = readFileSync(`${cliDir}/routing-doctor-gh.ts`, 'utf-8');
    const start = src.indexOf('createRepoLabelLister');
    expect(start).toBeGreaterThan(-1);
    const fnSource = src.slice(start);
    // A write would need one of these; none may appear anywhere in this
    // function's body (to end-of-file, since it's the last export here).
    expect(fnSource).not.toMatch(/-X\b/);
    expect(fnSource).not.toMatch(/--method/);
    expect(fnSource).not.toMatch(/['"]-f['"]/);
    expect(fnSource).not.toMatch(/['"]-F['"]/);
  });

  it('routing-doctor.ts never invokes a label-creating gh subcommand', () => {
    const src = readFileSync(`${cliDir}/routing-doctor.ts`, 'utf-8');
    expect(src).not.toMatch(/gh\s+label\s+create/);
    expect(src).not.toMatch(/issue\s+edit.*--add-label/);
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
    expect(auditor.selfSkipStatus).toBeNull();
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

  it('--json: registry-only agent carries in_local_config + null repo-scoped fields; schema_version unaffected (additive)', async () => {
    const report = await gatherRoutingDoctor(WITH_AUDITOR());
    const json = routingDoctorToJson(report) as {
      schema_version: number;
      summary: { agents_total: number; agents_routing_ok: number };
      warnings: string[];
      non_fleet_repos: string[];
      caller_pins: ReadonlyArray<Record<string, unknown>>;
      agents: ReadonlyArray<Record<string, unknown>>;
    };
    // #621's own additive fields don't independently bump schema_version; the
    // version is currently 3 for the unrelated macf#874 semantic shift.
    expect(json.schema_version).toBe(ROUTING_DOCTOR_JSON_SCHEMA_VERSION);
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
    expect(auditor.self_skip_status).toBeNull();
    expect(auditor.session_ok).toBeNull();
    expect(auditor.session_status).toBeNull();
    expect(auditor.session_expected).toBeNull();
    // a config agent still carries its repo-scoped fields (regression guard):
    const code = json.agents.find((a) => a.label === 'code-agent')!;
    expect(code.in_local_config).toBe(true);
    expect(code.self_skip_ok).toBe(true);
    expect(code.self_skip_status).toBe('ok');
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
  it('selfSkipGlyph maps each state (macf#874) — unresolvable is distinct from ok', () => {
    expect(selfSkipGlyph('ok')).toBe('✓');
    expect(selfSkipGlyph('not_ok')).toBe('✗');
    const unresolved = selfSkipGlyph('unresolvable');
    expect(unresolved).not.toBe('✓');
    expect(unresolved).toMatch(/unresolved/);
  });
  it('buildRepoRows + formatRepoTable render REPO / CALLER-PIN / CONSISTENT', () => {
    const rows = [
      {
        repo: 'groundnuty/macf',
        pin: 'v3.3.0',
        status: 'pinned' as const,
        fleetMember: true,
        consistent: true,
        correctness: 'unknown' as const,
      },
      {
        repo: 'groundnuty/x',
        pin: 'v1.3.4',
        status: 'pinned' as const,
        fleetMember: true,
        consistent: false,
        correctness: 'unknown' as const,
      },
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
    expect(json.schema_version).toBe(5); // pinned literal: fails loud on an accidental bump (macf#1193)
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

  it('macf#873: ca_cert carries matches_current_ca + both fingerprints + causal fields', async () => {
    const report = await gatherRoutingDoctor(
      deps({ readCaCert: async () => ROTATED_PEM, probe: async () => null }),
    );
    const json = routingDoctorToJson(report) as {
      schema_version: number;
      summary: { verdict: string; ca_ok: boolean };
      ca_cert: {
        matches_current_ca: boolean | null;
        registry_fingerprint: string | null;
        current_fingerprint: string | null;
        likely_cause_of_unreachability: boolean;
        cause_line: string | null;
      };
    };
    expect(json.schema_version).toBe(ROUTING_DOCTOR_JSON_SCHEMA_VERSION);
    expect(json.summary.verdict).toBe('DEGRADED');
    expect(json.summary.ca_ok).toBe(false); // #873 semantic shift: mismatch fails ca_ok too
    expect(json.ca_cert.matches_current_ca).toBe(false);
    expect(json.ca_cert.registry_fingerprint).toBeTruthy();
    expect(json.ca_cert.current_fingerprint).toBeTruthy();
    expect(json.ca_cert.registry_fingerprint).not.toBe(json.ca_cert.current_fingerprint);
    expect(json.ca_cert.likely_cause_of_unreachability).toBe(true);
    expect(json.ca_cert.cause_line).toMatch(/likely cause/i);
  });

  it('macf#873: matching CA → ca_ok true, likely_cause_of_unreachability false, cause_line null', async () => {
    const report = await gatherRoutingDoctor(deps());
    const json = routingDoctorToJson(report) as {
      summary: { ca_ok: boolean };
      ca_cert: {
        matches_current_ca: boolean | null;
        likely_cause_of_unreachability: boolean;
        cause_line: string | null;
      };
    };
    expect(json.summary.ca_ok).toBe(true);
    expect(json.ca_cert.matches_current_ca).toBe(true);
    expect(json.ca_cert.likely_cause_of_unreachability).toBe(false);
    expect(json.ca_cert.cause_line).toBeNull();
  });

  it('macf#873: no local CA (null) → matches_current_ca null, ca_ok stays true (null is not a fail)', async () => {
    const report = await gatherRoutingDoctor(deps({ currentCaFingerprint: () => null }));
    const json = routingDoctorToJson(report) as {
      summary: { verdict: string; ca_ok: boolean };
      ca_cert: { matches_current_ca: boolean | null; current_fingerprint: string | null };
    };
    expect(json.summary.verdict).toBe('HEALTHY');
    expect(json.summary.ca_ok).toBe(true);
    expect(json.ca_cert.matches_current_ca).toBeNull();
    expect(json.ca_cert.current_fingerprint).toBeNull();
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
    expect(json.schema_version).toBe(ROUTING_DOCTOR_JSON_SCHEMA_VERSION); // additive change → no further bump
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

  it('additive (#614): caller_pins carry fleet_member; non_fleet_repos lists opt-outs; schema_version unaffected (additive)', async () => {
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
    expect(json.schema_version).toBe(ROUTING_DOCTOR_JSON_SCHEMA_VERSION); // additive → no further bump
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
    expect(json.schema_version).toBe(ROUTING_DOCTOR_JSON_SCHEMA_VERSION); // additive → no further bump
    expect(json.summary.verdict).toBe('DEGRADED');
    expect(json.summary.routing_client_cert_ok).toBe(false);
    expect(json.routing_client_cert).toMatchObject({
      state: 'orphaned',
      recorded_fingerprint: 'OLD-FP',
      current_fingerprint: 'NEW-FP',
      minted_at: '2026-06-01T00:00:00Z',
    });
    expect(json.routing_client_cert.reason).toMatch(/re-mint via `macf certs issue-routing-client`/);
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

  it('macf#873: prints the causal-attribution line prominently when mismatch + broad unreachability coincide', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      {},
      deps({ readCaCert: async () => ROTATED_PEM, probe: async () => null }),
    );
    expect(code).toBe(1);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toMatch(/CA MISMATCH is the likely cause/);
    expect(out).toContain('routing plane: DEGRADED');
  });

  it('macf#873: does NOT print the causal line when only the CA mismatches (agents stay reachable)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runRoutingDoctor('/unused', {}, deps({ readCaCert: async () => ROTATED_PEM }));
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toMatch(/likely cause/);
    expect(out).toMatch(/does NOT match/); // the plain mismatch line still renders
  });

  it('macf#873: does NOT print the causal line when only agents are broadly unreachable (CA still matches)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runRoutingDoctor('/unused', {}, deps({ probe: async () => null }));
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toMatch(/likely cause/);
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
    expect(parsed.schema_version).toBe(ROUTING_DOCTOR_JSON_SCHEMA_VERSION);
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

describe('runRoutingDoctor — belt-and-braces top-level catch (macf#959, mirrors fleet-doctor.ts macf#830)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => {
    logSpy?.mockRestore();
    errSpy?.mockRestore();
  });

  it('an unexpected throw ANYWHERE in the gather never crashes uncaught — exits 1 with a one-line diagnosis', async () => {
    // Before this fix, `runRoutingDoctor` had NO top-level try/catch at all
    // (unlike `fleet-doctor.ts`'s macf#830 belt-and-braces). ANY unexpected
    // throw — not just a rejected /health probe, which `evaluateAgentRow`'s
    // own isolation now handles — propagated uncaught out of the command.
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      {},
      deps({
        listRepos: async () => {
          throw new Error('unexpected GitHub API failure');
        },
      }),
    );
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('unexpected GitHub API failure');
  });

  it('under --json, the same failure still emits a NON-EMPTY JSON envelope (never empty stdout)', async () => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runRoutingDoctor(
      '/unused',
      { json: true },
      deps({
        listRepos: async () => {
          throw new Error('unexpected GitHub API failure');
        },
      }),
    );
    expect(code).toBe(1);
    const printed = logSpy.mock.calls.flat().join('');
    expect(printed.length).toBeGreaterThan(0); // never empty stdout under --json
    const parsed = JSON.parse(printed);
    expect(parsed.schema_version).toBe(ROUTING_DOCTOR_JSON_SCHEMA_VERSION);
    expect(parsed.error).toContain('unexpected GitHub API failure');
  });
});
