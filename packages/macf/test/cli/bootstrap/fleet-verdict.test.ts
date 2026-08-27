/**
 * Tests for `fleet-verdict.ts` — the fleet-level VERDICT `apply` reports at
 * the end of a run (groundnuty/macf#1184, "a fleet that cannot route is
 * reported as 'provisioned'"). The decisive pair, per the issue's own test
 * requirement:
 *
 *   1. every component confirmed -> reports success
 *   2. ANY component unconfirmed -> does NOT, and names which
 *
 * Plus: `unknown` behaves as (2), never as (1) — the honest-unknown floor.
 * Per `assert-the-wrong-path.md`, (1) alone would be satisfied by a
 * function that ALWAYS claims success — every test below that asserts (1)
 * has a (2)-shaped sibling proving the render can actually say NOT
 * confirmed.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  carveOutCapability,
  determineFleetVerdict,
  fleetVerdictToJson,
  formatFleetVerdictLines,
  MIN_TAILNET_CARVEOUT_ACTIONS_VERSION,
  resolveOrgSecretVisibility,
  ROUTING_VERDICT_PIN_CONTEXT_UNSPECIFIED,
  routingVerdictComponent,
  runnerVerdictComponent,
  unsatisfiedRoutingSecretNames,
  widenRepoRoutingVerdict,
  workspaceVerdictComponent,
} from '../../../src/cli/bootstrap/fleet-verdict.js';
import type { FleetVerdictComponent, OrgSecretsListResult, RoutingVerdictOrgSecretsDeps, RoutingVerdictPinContext } from '../../../src/cli/bootstrap/fleet-verdict.js';
import { ALL_ROUTING_SECRET_NAMES } from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import type { RoutingSecretsPublishResult } from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import type { EnsureVariableOutcome } from '../../../src/cli/bootstrap/ensure-variable.js';
import type { RemainingDeployReport } from '../../../src/cli/bootstrap/remaining-deploy.js';

const CONFIRMED: FleetVerdictComponent = { name: 'x', status: { state: 'confirmed', detail: '' } };
const NOT_CONFIRMED: FleetVerdictComponent = { name: 'y', status: { state: 'not-confirmed', detail: 'y is missing' } };
const UNKNOWN: FleetVerdictComponent = { name: 'z', status: { state: 'unknown', detail: 'z could not be determined' } };

// --- determineFleetVerdict (generic reduction) ---

describe('determineFleetVerdict (pure, generic)', () => {
  it('DECISIVE 1/2: every component confirmed -> confirmed: true, unconfirmed: []', () => {
    const verdict = determineFleetVerdict([CONFIRMED, { ...CONFIRMED, name: 'w' }]);
    expect(verdict.confirmed).toBe(true);
    expect(verdict.unconfirmed).toEqual([]);
  });

  it('DECISIVE 2/2: any component not-confirmed -> confirmed: false, naming which', () => {
    const verdict = determineFleetVerdict([CONFIRMED, NOT_CONFIRMED]);
    expect(verdict.confirmed).toBe(false);
    expect(verdict.unconfirmed).toEqual([NOT_CONFIRMED]);
  });

  it('unknown behaves as (2), never as (1) — an indeterminate claim is never treated as a working one', () => {
    const verdict = determineFleetVerdict([CONFIRMED, UNKNOWN]);
    expect(verdict.confirmed).toBe(false);
    expect(verdict.unconfirmed).toEqual([UNKNOWN]);
  });

  it('an empty component list is vacuously confirmed — nothing to contradict a positive claim', () => {
    expect(determineFleetVerdict([])).toEqual({ confirmed: true, components: [], unconfirmed: [] });
  });

  it('multiple unconfirmed components are ALL named, not just the first', () => {
    const verdict = determineFleetVerdict([NOT_CONFIRMED, UNKNOWN]);
    expect(verdict.unconfirmed).toHaveLength(2);
  });
});

// --- routingVerdictComponent ---

/** Every one of the six legs given `status` for every repo — mirrors `apply-routing-secrets.test.ts`'s own `resultWith` shape, generalized to any single uniform status. */
function routingResultWith(repos: readonly string[], leg: EnsureVariableOutcome): RoutingSecretsPublishResult {
  const result = {} as Record<string, Record<string, EnsureVariableOutcome>>;
  for (const name of ALL_ROUTING_SECRET_NAMES) {
    result[name] = Object.fromEntries(repos.map((r) => [r, leg]));
  }
  return result as RoutingSecretsPublishResult;
}

describe('routingVerdictComponent', () => {
  it('zero router-carrying repos observed -> unknown (honest-unknown floor, never confirmed)', () => {
    const empty = {} as Record<string, Record<string, EnsureVariableOutcome>>;
    for (const name of ALL_ROUTING_SECRET_NAMES) empty[name] = {};
    const c = routingVerdictComponent(empty as RoutingSecretsPublishResult);
    expect(c.status.state).toBe('unknown');
  });

  it('every repo has every leg created/already-present -> confirmed', () => {
    const c = routingVerdictComponent(routingResultWith(['o/a', 'o/b'], { status: 'already-present' }));
    expect(c.status.state).toBe('confirmed');
  });

  it('groundnuty/macf#1184 regression: a whole-bag SKIPPED leg (the macf-trial signature) -> NOT confirmed, not silently "confirmed"', () => {
    const c = routingVerdictComponent(routingResultWith(['o/a', 'o/b', 'o/c'], { status: 'skipped', reason: 'batched vault write not yet landed' }));
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('batched vault write not yet landed');
    expect(c.status.detail).toContain('3 of 3');
  });

  it('a genuine FAILED leg -> not-confirmed, naming the reason', () => {
    const c = routingVerdictComponent(routingResultWith(['o/a'], { status: 'failed', reason: 'router App identity unresolved' }));
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('router App identity unresolved');
  });
});

// --- Org-inherited routing-secret widening (groundnuty/macf#1241) ---
//
// Live false negative this section closes: `macf-trial`'s TS_OAUTH pair
// moved to an org secret (`visibility: all`), so every repo's REPO-level
// leg reads absent ('skipped') even though the org-level secret is visible
// to every repo and routing genuinely works. The decisive pair, per the
// issue's own requirement (assert-the-wrong-path.md: (1) alone is
// satisfied by a widening that counts EVERYTHING as present):
//
//   1. absent repo-level, present org-level with covering visibility -> present, verdict confirms
//   2. absent at BOTH levels -> missing, named per repo per secret
//
// Plus: org-listing call unavailable/failing -> unknown, distinct from
// both, never "missing" from a call that could not have shown it.

/** One repo's six legs: TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET 'skipped' (not-required-and-absent, the #1184 widened-skip shape), the other four 'created' — the exact live `macf-trial` signature the issue reports. */
function tsOauthSkippedResult(repo: string): RoutingSecretsPublishResult {
  const result = {} as Record<string, Record<string, EnsureVariableOutcome>>;
  for (const name of ALL_ROUTING_SECRET_NAMES) {
    result[name] = {
      [repo]:
        name === 'TS_OAUTH_CLIENT_ID' || name === 'TS_OAUTH_SECRET' ? { status: 'skipped', reason: 'transport.tailscale_oauth_required not declared' } : { status: 'created' },
    };
  }
  return result as RoutingSecretsPublishResult;
}

describe('routingVerdictComponent — org-inherited secret widening (groundnuty/macf#1241)', () => {
  it('DECISIVE 1/2: absent repo-level, present org-level with covering visibility -> CONFIRMED (the macf-trial false negative)', () => {
    const secrets = tsOauthSkippedResult('org/repo-a');
    const orgSecretVisibility: Readonly<Record<string, OrgSecretsListResult>> = {
      'org/repo-a': { status: 'ok', names: ['TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'] },
    };
    const c = routingVerdictComponent(secrets, orgSecretVisibility);
    expect(c.status.state).toBe('confirmed');
  });

  it('DECISIVE 2/2: absent at BOTH levels -> NOT confirmed, naming the repo AND the secret (never a bare count)', () => {
    const secrets = tsOauthSkippedResult('org/repo-a');
    const orgSecretVisibility: Readonly<Record<string, OrgSecretsListResult>> = {
      // Org listing succeeded but does not carry either name — genuinely absent at both levels.
      'org/repo-a': { status: 'ok', names: ['SOME_OTHER_ORG_SECRET'] },
    };
    const c = routingVerdictComponent(secrets, orgSecretVisibility);
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('org/repo-a');
    expect(c.status.detail).toContain('TS_OAUTH_CLIENT_ID');
    expect(c.status.detail).toContain('TS_OAUTH_SECRET');
  });

  it('org-listing call unavailable/failing -> UNKNOWN, distinct from both, never "missing"', () => {
    const secrets = tsOauthSkippedResult('org/repo-a');
    const orgSecretVisibility: Readonly<Record<string, OrgSecretsListResult>> = {
      'org/repo-a': { status: 'unknown', reason: 'gh api repos/org/repo-a/actions/organization-secrets failed: HTTP 403' },
    };
    const c = routingVerdictComponent(secrets, orgSecretVisibility);
    expect(c.status.state).toBe('unknown');
    expect(c.status.state).not.toBe('not-confirmed');
    expect(c.status.detail).toContain('org/repo-a');
    expect(c.status.detail).toContain('TS_OAUTH_CLIENT_ID');
    expect(c.status.detail).toContain('TS_OAUTH_SECRET');
    expect(c.status.detail).not.toMatch(/missing at least one required routing secret/);
  });

  it('omitting the org-visibility parameter entirely preserves the pre-#1241 NOT-confirmed outcome (byte-identical-when-omitted contract)', () => {
    const secrets = tsOauthSkippedResult('org/repo-a');
    const withoutOrgData = routingVerdictComponent(secrets);
    expect(withoutOrgData.status.state).toBe('not-confirmed');
  });

  it('a repo with NOTHING unsatisfied is confirmed regardless of what the org map says (widening never re-litigates an already-satisfied repo)', () => {
    const secrets = routingResultWith(['org/repo-a'], { status: 'created' });
    const c = routingVerdictComponent(secrets, { 'org/repo-a': { status: 'unknown', reason: 'irrelevant — never even needed to be checked' } });
    expect(c.status.state).toBe('confirmed');
  });

  it('a mix: one repo satisfied by org-widening, one repo still missing -> overall NOT confirmed, only the failing repo named as missing', () => {
    const a = tsOauthSkippedResult('org/repo-a');
    const b = tsOauthSkippedResult('org/repo-b');
    const secrets = {} as Record<string, Record<string, EnsureVariableOutcome>>;
    for (const name of ALL_ROUTING_SECRET_NAMES) secrets[name] = { ...a[name], ...b[name] };
    const orgSecretVisibility: Readonly<Record<string, OrgSecretsListResult>> = {
      'org/repo-a': { status: 'ok', names: ['TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'] },
      'org/repo-b': { status: 'ok', names: [] },
    };
    const c = routingVerdictComponent(secrets as RoutingSecretsPublishResult, orgSecretVisibility);
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('org/repo-b');
    expect(c.status.detail).not.toContain('org/repo-a:');
  });
});

// --- TAILNET_NEEDED carve-out (groundnuty/macf#1239) ---
//
// macf-actions#75 (merged) makes TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET
// non-required for a self-hosted-runner fleet once its PINNED router
// version carries the carve-out (MIN_TAILNET_CARVEOUT_ACTIONS_VERSION). Per
// the issue's own decisive pair (assert-the-wrong-path.md: (1) alone is
// satisfied by never requiring TS_OAUTH at all):
//
//   1. self-hosted fleet, carve-out-carrying pin, four secrets present, no
//      TS_OAUTH -> routing CONFIRMED
//   2. same fleet, pre-carve-out pin, no TS_OAUTH -> NOT confirmed (today's
//      behavior preserved)
//
// Plus: hosted-touching fleet on a carve-out pin without TS_OAUTH -> NOT
// confirmed; pin undeterminable -> unknown, distinct from both; the other
// four stay required even under the carve-out.

describe('carveOutCapability (pure)', () => {
  it(`carries at exactly the threshold (${MIN_TAILNET_CARVEOUT_ACTIONS_VERSION})`, () => {
    expect(carveOutCapability(MIN_TAILNET_CARVEOUT_ACTIONS_VERSION)).toBe('carries');
  });

  it('carries above the threshold (same major, higher minor)', () => {
    expect(carveOutCapability('v3.6.0')).toBe('carries');
  });

  it('carries above the threshold (higher major)', () => {
    expect(carveOutCapability('v4.0.0')).toBe('carries');
  });

  it('predates the threshold (same major, lower minor)', () => {
    expect(carveOutCapability('v3.4.9')).toBe('predates');
  });

  it('predates the threshold (lower major)', () => {
    expect(carveOutCapability('v2.9.9')).toBe('predates');
  });

  it('"main" always carries — the dev branch is always current', () => {
    expect(carveOutCapability('main')).toBe('carries');
  });

  it('a bare floating major ref (e.g. "v3") is INDETERMINATE — never trusted forward', () => {
    // Deliberately the INVERSE of fleet-manifest.ts::isSelfHostedCapableActionsVersion's
    // bare-vMAJOR-trusted-forward convention — see carveOutCapability's own
    // doc for why: `@v3` is a moving tag that resolves at workflow-run time,
    // and at the time this was written no released macf-actions tag carries
    // the carve-out yet, so the bare string "v3" cannot decide the question
    // either way. A false "carries" here would silently mark a fleet that
    // genuinely still needs all six secrets as CONFIRMED.
    expect(carveOutCapability('v3')).toBe('indeterminate');
  });

  it('an unparseable ref is indeterminate, never assumed either way', () => {
    expect(carveOutCapability('some-branch-name')).toBe('indeterminate');
    expect(carveOutCapability('')).toBe('indeterminate');
  });
});

describe('routingVerdictComponent — TAILNET_NEEDED carve-out (groundnuty/macf#1239)', () => {
  /** Self-hosted fleet's `pinContext` for a given `versions.actions` pin. */
  function selfHosted(actionsVersion: string | undefined): RoutingVerdictPinContext {
    return { actionsVersion, selfHostedRunner: true };
  }

  it('DECISIVE 1/2: self-hosted fleet, carve-out-carrying pin, four secrets present, no TS_OAUTH -> routing CONFIRMED', () => {
    const secrets = tsOauthSkippedResult('org/self-hosted-repo');
    const c = routingVerdictComponent(secrets, {}, selfHosted(MIN_TAILNET_CARVEOUT_ACTIONS_VERSION));
    expect(c.status.state).toBe('confirmed');
  });

  it("DECISIVE 2/2: same fleet, pre-carve-out pin, no TS_OAUTH -> NOT confirmed (today's behavior preserved)", () => {
    const secrets = tsOauthSkippedResult('org/self-hosted-repo');
    const c = routingVerdictComponent(secrets, {}, selfHosted('v3.4.0'));
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('TS_OAUTH_CLIENT_ID');
    expect(c.status.detail).toContain('TS_OAUTH_SECRET');
  });

  it('hosted-touching fleet on a carve-out pin without TS_OAUTH -> NOT confirmed (the carve-out never applies off self-hosted)', () => {
    const secrets = tsOauthSkippedResult('org/hosted-repo');
    const c = routingVerdictComponent(secrets, {}, { actionsVersion: MIN_TAILNET_CARVEOUT_ACTIONS_VERSION, selfHostedRunner: false });
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('TS_OAUTH_CLIENT_ID');
  });

  it('pin undeterminable (versions.actions never declared) -> UNKNOWN, distinct from both confirmed and not-confirmed', () => {
    const secrets = tsOauthSkippedResult('org/self-hosted-repo');
    const c = routingVerdictComponent(secrets, {}, selfHosted(undefined));
    expect(c.status.state).toBe('unknown');
    expect(c.status.state).not.toBe('confirmed');
    expect(c.status.state).not.toBe('not-confirmed');
    expect(c.status.detail).toContain('TS_OAUTH_CLIENT_ID');
  });

  it('a bare floating "v3" pin also resolves to UNKNOWN (never assumed capable — see carveOutCapability)', () => {
    const secrets = tsOauthSkippedResult('org/self-hosted-repo');
    const c = routingVerdictComponent(secrets, {}, selfHosted('v3'));
    expect(c.status.state).toBe('unknown');
  });

  it('GUARD: the other four routing secrets stay required even under a carve-out-carrying self-hosted pin — a genuinely missing non-Tailscale secret still fails the run', () => {
    const secrets = tsOauthSkippedResult('org/self-hosted-repo');
    // Additionally fail a non-Tailscale secret — the carve-out must never
    // widen to cover it.
    const withExtraGap = {
      ...secrets,
      ROUTING_CLIENT_CERT: { 'org/self-hosted-repo': { status: 'failed' as const, reason: 'router App identity unresolved' } },
    } as RoutingSecretsPublishResult;
    const c = routingVerdictComponent(withExtraGap, {}, selfHosted(MIN_TAILNET_CARVEOUT_ACTIONS_VERSION));
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('ROUTING_CLIENT_CERT');
    // TS_OAUTH_* was carved out — must NOT be named as a cause of the failure.
    expect(c.status.detail).not.toContain('TS_OAUTH_CLIENT_ID');
    expect(c.status.detail).not.toContain('TS_OAUTH_SECRET');
  });

  it('omitting pinContext entirely preserves the pre-#1239 NOT-confirmed outcome (byte-identical-when-omitted contract)', () => {
    const secrets = tsOauthSkippedResult('org/self-hosted-repo');
    const withDefault = routingVerdictComponent(secrets);
    const withExplicitDefault = routingVerdictComponent(secrets, {}, ROUTING_VERDICT_PIN_CONTEXT_UNSPECIFIED);
    expect(withDefault.status.state).toBe('not-confirmed');
    expect(withDefault).toEqual(withExplicitDefault);
  });

  it('the aggregate detail states WHICH requirement set applied and why, not just the bare secret names', () => {
    const secrets = tsOauthSkippedResult('org/self-hosted-repo');
    const carriesMsg = routingVerdictComponent(secrets, {}, selfHosted(MIN_TAILNET_CARVEOUT_ACTIONS_VERSION));
    const predatesMsg = routingVerdictComponent(secrets, {}, selfHosted('v3.4.0'));
    // The carve-out-carrying pin never even reaches "not-confirmed" for a
    // TS_OAUTH-only gap (see DECISIVE 1/2) — force a companion gap so both
    // branches produce non-empty detail to compare.
    const withExtraGap = {
      ...secrets,
      ROUTING_CLIENT_CERT: { 'org/self-hosted-repo': { status: 'failed' as const, reason: 'router App identity unresolved' } },
    } as RoutingSecretsPublishResult;
    const carriesDetail = routingVerdictComponent(withExtraGap, {}, selfHosted(MIN_TAILNET_CARVEOUT_ACTIONS_VERSION)).status.detail;
    expect(carriesDetail).toContain(MIN_TAILNET_CARVEOUT_ACTIONS_VERSION);
    expect(carriesDetail.toLowerCase()).toContain('carve-out');
    expect(predatesMsg.status.detail.toLowerCase()).toContain('carve-out');
    // The rendered detail is the verdict's own output — no internal
    // issue/PR reference leaks into it (this file's citation-guard convention).
    expect(carriesDetail).not.toMatch(/#\d+/);
  });
});

describe('unsatisfiedRoutingSecretNames (pure)', () => {
  it('every leg satisfied -> empty', () => {
    expect(unsatisfiedRoutingSecretNames(routingResultWith(['o/a'], { status: 'already-present' }), 'o/a')).toEqual([]);
  });

  it('names exactly the failed/skipped legs, never the satisfied ones', () => {
    const secrets = tsOauthSkippedResult('o/a');
    expect(unsatisfiedRoutingSecretNames(secrets, 'o/a').sort()).toEqual(['TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'].sort());
  });
});

describe('widenRepoRoutingVerdict (pure)', () => {
  const secrets = tsOauthSkippedResult('o/a');

  it('no org listing attempted (undefined) -> missing, unchanged from pre-widening', () => {
    const r = widenRepoRoutingVerdict(secrets, 'o/a', undefined);
    expect(r.state).toBe('not-confirmed');
    expect(r.missing.sort()).toEqual(['TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'].sort());
    expect(r.unknownOrgSecrets).toEqual([]);
  });

  it('org listing ok, covers everything unsatisfied -> confirmed', () => {
    const r = widenRepoRoutingVerdict(secrets, 'o/a', { status: 'ok', names: ['TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'] });
    expect(r.state).toBe('confirmed');
    expect(r.missing).toEqual([]);
  });

  it('org listing ok, covers ONE of two -> still not-confirmed, naming only the uncovered one', () => {
    const r = widenRepoRoutingVerdict(secrets, 'o/a', { status: 'ok', names: ['TS_OAUTH_CLIENT_ID'] });
    expect(r.state).toBe('not-confirmed');
    expect(r.missing).toEqual(['TS_OAUTH_SECRET']);
  });

  it('org listing unknown -> unknown, every unsatisfied name honest-unknown, none in `missing`', () => {
    const r = widenRepoRoutingVerdict(secrets, 'o/a', { status: 'unknown', reason: 'auth failure' });
    expect(r.state).toBe('unknown');
    expect(r.missing).toEqual([]);
    expect(r.unknownOrgSecrets.sort()).toEqual(['TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'].sort());
  });

  it('nothing unsatisfied -> confirmed regardless of orgListing', () => {
    const clean = routingResultWith(['o/b'], { status: 'created' });
    expect(widenRepoRoutingVerdict(clean, 'o/b', { status: 'unknown', reason: 'irrelevant' }).state).toBe('confirmed');
  });
});

describe('resolveOrgSecretVisibility (I/O boundary, dependency-injected)', () => {
  it('cost optimization: a repo with zero unsatisfied secrets is NEVER probed', async () => {
    const listOrgSecretsVisibleToRepo = vi.fn<RoutingVerdictOrgSecretsDeps['listOrgSecretsVisibleToRepo']>();
    const secrets = routingResultWith(['o/clean'], { status: 'already-present' });
    const result = await resolveOrgSecretVisibility(secrets, ['o/clean'], { listOrgSecretsVisibleToRepo });
    expect(listOrgSecretsVisibleToRepo).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('a repo with an unsatisfied secret IS probed exactly once, and its result is carried through', async () => {
    const listOrgSecretsVisibleToRepo = vi
      .fn<RoutingVerdictOrgSecretsDeps['listOrgSecretsVisibleToRepo']>()
      .mockResolvedValue({ status: 'ok', names: ['TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'] });
    const secrets = tsOauthSkippedResult('o/needs-check');
    const result = await resolveOrgSecretVisibility(secrets, ['o/needs-check'], { listOrgSecretsVisibleToRepo });
    expect(listOrgSecretsVisibleToRepo).toHaveBeenCalledExactlyOnceWith('o/needs-check');
    expect(result).toEqual({ 'o/needs-check': { status: 'ok', names: ['TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'] } });
  });
});

// --- runnerVerdictComponent ---

describe('runnerVerdictComponent', () => {
  it('empty routing map (self-hosted runner not declared) -> undefined (N/A, excluded from the verdict)', () => {
    expect(runnerVerdictComponent({})).toBeUndefined();
  });

  it('every repo "created" (a live check confirmed a usable runner THIS run) -> confirmed', () => {
    const c = runnerVerdictComponent({ 'o/a': { status: 'created' }, 'o/b': { status: 'created' } });
    expect(c?.status.state).toBe('confirmed');
  });

  it('reviewer-flagged regression guard: every repo "already-present" -> UNKNOWN, never "confirmed" — an inherited-from-an-earlier-run write proves nothing about THIS run', () => {
    const c = runnerVerdictComponent({ 'o/a': { status: 'already-present' }, 'o/b': { status: 'already-present' } });
    expect(c?.status.state).toBe('unknown');
    expect(c?.status.state).not.toBe('confirmed');
    expect(c?.status.detail).toContain('not re-checked this run');
  });

  it('the exact macf-trial signature — every repo failed/skipped, zero runners registered -> not-confirmed, naming the gap explicitly (never rendered identically to "cannot see runners")', () => {
    const c = runnerVerdictComponent({
      'o/a': { status: 'failed', reason: 'no usable runner registered' },
      'o/b': { status: 'skipped', reason: 'no runner token this run' },
    });
    expect(c?.status.state).toBe('not-confirmed');
    expect(c?.status.detail).toContain('NO confirmed self-hosted runner');
  });

  it('groundnuty/macf#1212: a "pending" leg is named explicitly as pending, never folded silently into "failed"', () => {
    const c = runnerVerdictComponent({ 'o/a': { status: 'pending', reason: 'still within the bounded wait' } });
    expect(c?.status.state).toBe('not-confirmed');
    expect(c?.status.detail).toContain('pending');
    expect(c?.status.detail).not.toContain('NO confirmed'); // the failed/skipped wording must not also fire
  });
});

// --- workspaceVerdictComponent ---

describe('workspaceVerdictComponent', () => {
  it('empty steps (every declared agent already deployed, or none declared) -> confirmed', () => {
    expect(workspaceVerdictComponent({ steps: [] }).status.state).toBe('confirmed');
  });

  it('a "not-deployed" step -> not-confirmed, naming the role', () => {
    const report: RemainingDeployReport = {
      steps: [{ role: 'code-agent', deployPath: '/x/code-agent', presence: 'not-deployed', command: 'macf fleet deploy --agent code-agent' }],
    };
    const c = workspaceVerdictComponent(report);
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('code-agent');
  });

  it('only "unknown" steps (multi-host, unverifiable from here) -> unknown, not not-confirmed', () => {
    const report: RemainingDeployReport = {
      steps: [{ role: 'code-agent', deployPath: '/x/code-agent', presence: 'unknown', reason: 'parent dir absent', command: 'macf fleet deploy --agent code-agent' }],
    };
    expect(workspaceVerdictComponent(report).status.state).toBe('unknown');
  });

  it('a confidently-not-deployed step OUTRANKS an unrelated unknown one — weakest-claim rule', () => {
    const report: RemainingDeployReport = {
      steps: [
        { role: 'code-agent', deployPath: '/x/code-agent', presence: 'not-deployed', command: 'cmd-1' },
        { role: 'science-agent', deployPath: '/x/science-agent', presence: 'unknown', reason: 'parent dir absent', command: 'cmd-2' },
      ],
    };
    expect(workspaceVerdictComponent(report).status.state).toBe('not-confirmed');
  });
});

// --- formatFleetVerdictLines + fleetVerdictToJson (render, decisive pair through the SAME computation) ---

describe('formatFleetVerdictLines / fleetVerdictToJson', () => {
  it('DECISIVE 1/2: every component confirmed -> a success line, mentioning every checked area', () => {
    const verdict = determineFleetVerdict([{ ...CONFIRMED, name: 'routing' }, { ...CONFIRMED, name: 'workspaces' }]);
    const lines = formatFleetVerdictLines(verdict);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('confirmed');
    expect(lines[0]).toContain('routing');
    expect(lines[0]).toContain('workspaces');
    expect(lines[0]).not.toContain('NOT confirmed');

    const json = fleetVerdictToJson(verdict) as { confirmed: boolean; components: readonly unknown[] };
    expect(json.confirmed).toBe(true);
  });

  it('DECISIVE 2/2: any component unconfirmed -> NOT a success line, naming which component(s) and why', () => {
    const verdict = determineFleetVerdict([
      { ...CONFIRMED, name: 'workspaces' },
      { name: 'routing', status: { state: 'not-confirmed', detail: 'zero routing secrets on any repo' } },
    ]);
    const lines = formatFleetVerdictLines(verdict);
    const joined = lines.join('\n');
    expect(joined).toContain('NOT confirmed');
    expect(joined).toContain('routing');
    expect(joined).toContain('zero routing secrets on any repo');
    // The word "provisioned" as a POSITIVE claim must never appear in the
    // verdict render — groundnuty/macf#1184's core ask.
    expect(joined).not.toMatch(/\bis provisioned\b/);

    const json = fleetVerdictToJson(verdict) as { confirmed: boolean; components: readonly { name: string; state: string }[] };
    expect(json.confirmed).toBe(false);
    expect(json.components.find((c) => c.name === 'routing')?.state).toBe('not-confirmed');
  });

  it('unknown behaves as (2) at the render layer too — UNKNOWN is tagged distinctly from NOT CONFIRMED', () => {
    const verdict = determineFleetVerdict([{ ...CONFIRMED, name: 'workspaces' }, { name: 'routing', status: { state: 'unknown', detail: 'no repos observed' } }]);
    const lines = formatFleetVerdictLines(verdict);
    const joined = lines.join('\n');
    expect(joined).toContain('NOT confirmed working'); // the headline still fires
    expect(joined).toContain('UNKNOWN');
    expect(joined).not.toContain('routing: NOT CONFIRMED'); // tagged UNKNOWN, not the stronger NOT CONFIRMED tag
  });

  it('nothing checked at all (empty components) -> no lines, no key — never a content-free banner', () => {
    const verdict = determineFleetVerdict([]);
    expect(formatFleetVerdictLines(verdict)).toEqual([]);
    expect(fleetVerdictToJson(verdict)).toBeUndefined();
  });

  it('citation-guard: no internal issue/DR references leak into the rendered lines — comments may cite them, output may not', () => {
    const verdicts = [
      determineFleetVerdict([{ ...CONFIRMED, name: 'routing' }]),
      determineFleetVerdict([{ name: 'routing', status: { state: 'not-confirmed', detail: 'zero routing secrets on any repo' } }]),
      determineFleetVerdict([{ name: 'runners', status: { state: 'unknown', detail: 'no repos observed' } }]),
    ];
    const issueRefPattern = /#\d+|DR-\d+/i;
    for (const v of verdicts) {
      expect(formatFleetVerdictLines(v).join('\n')).not.toMatch(issueRefPattern);
    }
  });
});

// --- The exact macf-trial scenario end to end, through the public API surface ---

describe('the macf-trial scenario (groundnuty/macf#1184\'s own reproduction)', () => {
  it('all six routing legs whole-bag-skipped + zero runners registered + no local workspace -> the verdict names all three, and is never "confirmed"', () => {
    const routingSecrets = routingResultWith(
      ['groundnuty/macf-trial-code-agent', 'groundnuty/macf-trial-science-agent'],
      { status: 'skipped', reason: 'router App/routing-client cert freshly minted this run; vault write not yet confirmed' },
    );
    const routing: Readonly<Record<string, EnsureVariableOutcome>> = {
      'groundnuty/macf-trial-code-agent': { status: 'failed', reason: 'no usable runner registered' },
      'groundnuty/macf-trial-science-agent': { status: 'failed', reason: 'no usable runner registered' },
    };
    const remainingDeploy: RemainingDeployReport = {
      steps: [
        { role: 'code-agent', deployPath: '/x/code-agent', presence: 'not-deployed', command: 'macf fleet deploy --agent code-agent' },
        { role: 'science-agent', deployPath: '/x/science-agent', presence: 'not-deployed', command: 'macf fleet deploy --agent science-agent' },
      ],
    };

    const runnerComponent = runnerVerdictComponent(routing);
    const verdict = determineFleetVerdict([routingVerdictComponent(routingSecrets), ...(runnerComponent !== undefined ? [runnerComponent] : []), workspaceVerdictComponent(remainingDeploy)]);

    expect(verdict.confirmed).toBe(false);
    expect(verdict.unconfirmed.map((c) => c.name).sort()).toEqual(['routing', 'runners', 'workspaces']);
    const rendered = formatFleetVerdictLines(verdict).join('\n');
    expect(rendered).not.toMatch(/\bis provisioned\b/);
    expect(rendered).toContain('routing');
    expect(rendered).toContain('runners');
    expect(rendered).toContain('workspaces');
  });

  it('the positive twin: every leg created, every runner confirmed, every workspace present -> confirmed, no missing-piece line', () => {
    const routingSecrets = routingResultWith(['groundnuty/macf-trial-code-agent'], { status: 'created' });
    const routing: Readonly<Record<string, EnsureVariableOutcome>> = { 'groundnuty/macf-trial-code-agent': { status: 'created' } };
    const remainingDeploy: RemainingDeployReport = { steps: [] };

    const runnerComponent = runnerVerdictComponent(routing);
    const verdict = determineFleetVerdict([routingVerdictComponent(routingSecrets), ...(runnerComponent !== undefined ? [runnerComponent] : []), workspaceVerdictComponent(remainingDeploy)]);

    expect(verdict.confirmed).toBe(true);
    expect(verdict.unconfirmed).toEqual([]);
    expect(formatFleetVerdictLines(verdict).join('\n')).not.toContain('NOT confirmed');
  });
});
