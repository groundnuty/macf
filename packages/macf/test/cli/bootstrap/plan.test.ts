/**
 * Table-driven tests for `computePlan` — the pure §D3 three-verb reconcile
 * (DR-043, Slice 1a, groundnuty/macf#838). Fully offline: `ObservedState` is
 * hand-built, no `gh` / network involved (that's `observer.ts`'s job, wired
 * separately).
 */
import { describe, it, expect } from 'vitest';
import type { FleetLock, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import {
  APPLY_UNIMPLEMENTED_REASONS,
  computePlan,
  controlRepoRouterCoverageNotices,
  countAppsToCreate,
  fleetPlanToJson,
  formatControlRepoRouterCoverageLines,
  formatInstallScopeDriftLines,
  formatOperatorInteractionLine,
  formatOrphanLines,
  formatPlanText,
  formatRegistryScopeLines,
  formatRoutingSecretAsymmetryLines,
  formatScopeCredentialLines,
  formatSkippedLines,
  formatUnimplementedLines,
  operatorInteractionBudget,
  operatorInteractionToJson,
  orphanResourceUrl,
  planItemApplyCoverage,
  scopeCredentialNotice,
  SKIPPED_SECTION_REASONS,
  summarizePlan,
  UNKNOWN_REASONS,
  type ControlRepoRouterCoverage,
  type InstallScopeDrift,
  type ObservedAgentState,
  type ObservedState,
  type PlanItem,
  type PlanItemKind,
  type PlanVerb,
  type Presence,
} from '../../../src/cli/bootstrap/plan.js';
import { RUNNER_TOKEN_ENV_VAR, RUNNER_TOKEN_FLAG } from '../../../src/cli/bootstrap/apply-routing.js';
import {
  TS_OAUTH_CLIENT_ID_FLAG,
  TS_OAUTH_CLIENT_ID_SECRET_NAME,
  TS_OAUTH_SECRET_FLAG,
  TS_OAUTH_SECRET_SECRET_NAME,
} from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import { REGISTRY_SCOPE_UNSATISFIABLE_CODE } from '../../../src/cli/bootstrap/registry-scope-preflight.js';
import { validateInstallRepositoryScope } from '../../../src/cli/bootstrap/install-scope.js';
import type { RunnerPlatformEndpointSource } from '../../../src/cli/bootstrap/runner-platform.js';
import { installScopeCoverageDriftMessage, type InstallScopeCoverageEntry } from '../../../src/cli/bootstrap/install-scope-coverage.js';
import { RUNNER_OPS_ROLE } from '../../../src/cli/bootstrap/apply-runner-ops.js';
import { ROUTER_APP_ROLE } from '../../../src/cli/bootstrap/apply-router-app.js';
import { ROUTING_CLIENT_CERT_SECRET_NAME } from '../../../src/cli/bootstrap/apply-routing-client.js';
import type { RepoSecretNamesObservation } from '../../../src/cli/bootstrap/observer.js';

/** A minimal, valid, 2-agent manifest — no optional sections. */
function baseManifest(overrides: Partial<FleetManifest> = {}): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'icsoc-2026' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: [] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [
      {
        role: 'science-agent',
        profile: 'research',
        repo: 'groundnuty/icsoc-2026-science-agent',
        deploy_path: '/home/ubuntu/repos/agh/icsoc-2026-science-agent',
      },
      {
        role: 'code-agent',
        profile: 'code',
        repo: 'groundnuty/icsoc-2026-experiment',
        deploy_path: '/home/ubuntu/repos/agh/icsoc-2026-experiment',
      },
    ],
    ...overrides,
  };
}

/** Empty observed state — nothing provisioned yet. `controlRepoPresence: 'absent'` — no control repo yet, so `controlRepoItem` never fires (see the dedicated `control_repo` plan-item describe block below for the archived case). */
const EMPTY_OBSERVED: ObservedState = { lock: null, agents: {}, caRegistry: 'unknown', caRepos: {}, controlRepoPresence: 'absent' };

function itemFor(items: readonly PlanItem[], kind: PlanItem['kind'], target: string): PlanItem | undefined {
  return items.find((i) => i.kind === kind && i.target === target);
}

describe('computePlan — all-missing manifest (fresh fleet) → all creates', () => {
  it('emits a create item for every per-agent resource, low-confidence-worded for unknown', () => {
    const manifest = baseManifest();
    const plan = computePlan(manifest, EMPTY_OBSERVED);

    // 5 items per agent (app, repo, install, secret_fingerprint, labels) × 2
    // agents + caRegistry (1) + one caRepo per agent (2) + one routing_client
    // per agent-repo (2) — CA/labels/routing_client items are unconditional
    // (never gated on `trust:` being declared — macf#839 review nit 5 for
    // CA; groundnuty/macf#920 for labels/routing_client). NO runner_ops item
    // — `baseManifest()` declares no `routing:` at all, so this fleet needs
    // no runner-ops App (groundnuty/macf#1083; see the dedicated describe
    // block for the conditional-creation behavior itself). +1 `router_app`
    // item — UNCONDITIONAL regardless of `routing:` (groundnuty/macf#1105;
    // see the dedicated describe block below). +1 `ts_oauth` item — ALSO
    // UNCONDITIONAL (groundnuty/macf#1109); no `observed.vaultTsOauth` this
    // run degrades to the low-confidence 'create' branch, same as every
    // other unknown-presence item here.
    expect(plan.items).toHaveLength(17);
    for (const item of plan.items) {
      // `labels` is `'write-always'`, not `'create'` (groundnuty/macf#926) —
      // `labelsItem` has no observed-state input, so it can never carry the
      // "checked, and it's missing" claim `'create'` implies. See
      // `plan-item-write-always.test.ts` for the dedicated coverage proof.
      if (item.kind === 'labels') {
        expect(item.verb).toBe('write-always');
      } else {
        expect(item.verb).toBe('create');
      }
      expect(item.confirm_required).toBe(false);
    }
  });

  it('always emits CA items (registry + one per agent repo) — unconditional, macf#839 review nit 5', () => {
    // computePlan never consulted `manifest.trust` — there is no such field
    // any more (removed, groundnuty/macf#1201, since nothing ever read it).
    // The CA items are unconditional on fleet identity + agent repos alone,
    // with or without a `trust:` section ever having existed; this test
    // covers the plan-level consequence.
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const caItems = plan.items.filter((i) => i.kind === 'ca');
    expect(caItems.map((i) => i.target)).toEqual([
      'ca:registry:ICSOC_2026_CA_CERT',
      'ca:repo:groundnuty/icsoc-2026-science-agent:ICSOC_2026_CA_CERT',
      'ca:repo:groundnuty/icsoc-2026-experiment:ICSOC_2026_CA_CERT',
    ]);
    for (const item of caItems) {
      expect(item.verb).toBe('create');
      // CA items are `variable` reads (a registry/repo var fetch, not the
      // identity plane) — the reason must come from UNKNOWN_REASONS.variable,
      // never UNKNOWN_REASONS.identity's JWT framing (macf#842 review: naming
      // the wrong cause is a misleading diagnostic on CA/routing rows).
      expect(item.reason).toContain(UNKNOWN_REASONS.variable);
      expect(item.reason).not.toMatch(/JWT/i);
    }
  });

  // macf#913 — UNKNOWN_REASONS.identity previously claimed "a vault-aware
  // confirm runs during apply" UNCONDITIONALLY, which was false: `apply` had
  // no `--vault`/`--identity-key` flags at all until this change (only
  // `plan` did). The message must never promise an automatic confirm; it
  // must condition the promise on the operator actually supplying BOTH flags
  // to `apply`.
  it('the identity unknown-reason does NOT unconditionally promise a confirm during apply — it conditions on --vault/--identity-key', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const appItem = itemFor(plan.items, 'app', 'agent:science-agent:app:icsoc-2026-science-agent');
    expect(appItem?.reason).toContain(UNKNOWN_REASONS.identity);
    expect(UNKNOWN_REASONS.identity).not.toMatch(/^not confirmable at plan time \(no App JWT — the PEM lives in the vault; a vault-aware confirm runs during apply/);
    expect(UNKNOWN_REASONS.identity).toMatch(/--vault/);
    expect(UNKNOWN_REASONS.identity).toMatch(/--identity-key/);
    expect(UNKNOWN_REASONS.identity).toMatch(/ONLY when invoked with BOTH/);
  });

  it('never emits a routing item when `routing:` is not declared', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.items.some((i) => i.kind === 'routing')).toBe(false);
  });
});

describe('computePlan — per-repo CA drift (macf#806 reproduction, macf#839 review [BLOCKING] 3)', () => {
  it('registry + repo-A present, repo-B absent → noop for registry + repo-A, create for repo-B', () => {
    const manifest = baseManifest(); // agents: science-agent (repo A), code-agent (repo B)
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      caRegistry: 'present',
      caRepos: {
        'groundnuty/icsoc-2026-science-agent': 'present', // repo-A
        'groundnuty/icsoc-2026-experiment': 'absent', // repo-B
      },
    };

    const plan = computePlan(manifest, observed);
    const caItems = plan.items.filter((i) => i.kind === 'ca');
    expect(caItems).toEqual([
      expect.objectContaining({
        target: 'ca:registry:ICSOC_2026_CA_CERT',
        verb: 'noop',
      }),
      expect.objectContaining({
        target: 'ca:repo:groundnuty/icsoc-2026-science-agent:ICSOC_2026_CA_CERT',
        verb: 'noop',
      }),
      expect.objectContaining({
        target: 'ca:repo:groundnuty/icsoc-2026-experiment:ICSOC_2026_CA_CERT',
        verb: 'create',
      }),
    ]);
    // A single fleet-level representative-repo read (the pre-macf#839 shape)
    // would have collapsed this to a uniform noop/create — this per-repo
    // split is exactly what lets the plan reproduce the #806 drift class.
  });
});

describe('computePlan — all-match observed state → all noops', () => {
  it('every per-agent resource + CA (registry + per-repo) + routing is noop when fully observed-matching', () => {
    const manifest = baseManifest({
      routing: { runner: { runs_on: 'self-hosted', warm: 1 } },
    });
    const observed: ObservedState = {
      lock: null,
      agents: {
        'science-agent': {
          app: 'present',
          appId: '111111',
          install: 'present',
          installId: '22222222',
          repo: 'present',
          fingerprints: { app_private_key: 'sha256:aaa' },
        },
        'code-agent': {
          app: 'present',
          appId: '333333',
          install: 'present',
          installId: '44444444',
          repo: 'present',
          fingerprints: { app_private_key: 'sha256:bbb' },
        },
      },
      caRegistry: 'present',
      caRepos: {
        'groundnuty/icsoc-2026-science-agent': 'present',
        'groundnuty/icsoc-2026-experiment': 'present',
      },
      // Must equal buildTrustedActorsValue('icsoc-2026', manifest.agents) —
      // agents[] order is science-agent then code-agent per `baseManifest()`.
      routingTrustedActors: 'icsoc-2026-science-agent[bot] icsoc-2026-code-agent[bot]',
      routingRunnerRegistered: 'present',
      routingClientRepos: {
        'groundnuty/icsoc-2026-science-agent': 'present',
        'groundnuty/icsoc-2026-experiment': 'present',
      },
      controlRepoPresence: 'present',
      controlRepoArchived: false,
    };

    const plan = computePlan(manifest, observed);
    // 5 × 2 agents (app/repo/install/secret_fingerprint/labels) + caRegistry +
    // 2 caRepo + routing + runner_warm (macf#942) + runner_platform
    // (groundnuty/macf#1211 — runs_on is self-hosted here) + 2 routing_client
    // + the fleet-level runner_ops item (groundnuty/macf#943; control_repo
    // item absent — not archived) + the fleet-level router_app item
    // (groundnuty/macf#1105, UNCONDITIONAL) + the fleet-level ts_oauth item
    // (groundnuty/macf#1109, UNCONDITIONAL).
    expect(plan.items).toHaveLength(21);
    for (const item of plan.items) {
      // `labels`/`runner_warm` are `'write-always'` (groundnuty/macf#926,
      // was `'create'`): they have NO plan-time observed read at all (see
      // `labelsItem`'s/`runnerWarmItem`'s docs), so they can NEVER carry the
      // "checked, and it's missing" claim `'create'` implies — not even
      // here, where every OTHER kind genuinely observed-matches. This is
      // the exact property `plan-item-write-always.test.ts` proves
      // exhaustively: these two kinds are IMPOSSIBLE to make quiet by any
      // fixture, which is what earns them the distinct verb rather than a
      // "low confidence create."
      //
      // `runner_ops`/`router_app`/`ts_oauth` are a DIFFERENT shape — they
      // DO branch on real observed state (a `fleet.lock` entry / vault
      // confirmation), they just can't reach `noop` from THIS PARTICULAR
      // fixture: `observed.lock` is `null` (never simulated) and
      // `vaultRouterApp`/`vaultTsOauth` are unset, so their presence
      // degrades to `unknown` → `create` here. See the dedicated describe
      // blocks below (and `plan-item-write-always.test.ts`) for fixtures
      // that DO drive them to `noop`.
      if (item.kind === 'labels' || item.kind === 'runner_warm' || item.kind === 'runner_platform') {
        expect(item.verb).toBe('write-always');
      } else if (item.kind === 'runner_ops' || item.kind === 'router_app' || item.kind === 'ts_oauth') {
        expect(item.verb).toBe('create');
      } else {
        expect(item.verb).toBe('noop');
      }
      expect(item.confirm_required).toBe(false);
    }
  });
});

describe('computePlan — a version/config mismatch → update + confirm_required', () => {
  it('flags a MACF_TRUSTED_ACTORS drift as update, confirm-required, naming the runner class', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted', routingRunnerRegistered: 'present' };

    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.verb).toBe('update');
    expect(routing?.confirm_required).toBe(true);
    expect(routing?.reason).toMatch(
      /observed "github-hosted" but the fleet's current agents derive "icsoc-2026-science-agent\[bot\] icsoc-2026-code-agent\[bot\]"/,
    );
    expect(routing?.reason).toMatch(/Runner class: self-hosted/);
  });

  it('does not flag update when the observed value already matches', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingTrustedActors: 'icsoc-2026-science-agent[bot] icsoc-2026-code-agent[bot]',
    };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.verb).toBe('noop');
    expect(routing?.confirm_required).toBe(false);
  });

  // --- macf#922 — runs_on other than "self-hosted" needs no write at all ---

  it('a declared runs_on OTHER than "self-hosted" is a noop — no MACF_TRUSTED_ACTORS write is ever candidate', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'ubuntu-latest', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.verb).toBe('noop');
    expect(routing?.confirm_required).toBe(false);
    expect(routing?.reason).toMatch(/github-hosted/);
    expect(routing?.reason).toMatch(/runs_on "ubuntu-latest" is not "self-hosted"/);
  });

  // --- macf#922 requirement 4 — plan must name the runner CLASS (billing consequence) ---

  it('names "self-hosted" when a runner is confirmed registered', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunnerRegistered: 'present' };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).toMatch(/Runner class: self-hosted/);
    expect(routing?.reason).not.toMatch(/billed on private repos/);
  });

  it('names "github-hosted (billed on private repos)" when no runner is confirmed registered — even though runs_on declares self-hosted', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunnerRegistered: 'absent' };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).toMatch(/Runner class: github-hosted \(billed on private repos\)/);
    expect(routing?.reason).toMatch(/no self-hosted runner is confirmed registered/);
  });

  it('names "github-hosted (billed on private repos)" when registration is UNKNOWN — never overclaims confidence', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunnerRegistered: 'unknown' };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).toMatch(/Runner class: github-hosted \(billed on private repos\)/);
    expect(routing?.reason).toMatch(/could not be confirmed/);
  });

  it('names "github-hosted (billed on private repos)" when registration was never checked (undefined) — the pre-macf#922 default', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).toMatch(/Runner class: github-hosted \(billed on private repos\)/);
  });

  // --- macf#924 — org-admin handover surfaces in the plan's runner-class line ---

  it('appends the org-admin handover to the runner-class reason when an org runner exists but excludes the repo', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingRunnerRegistered: 'absent',
      routingRunnerHandover:
        'An org-level self-hosted runner IS registered in "groundnuty", but its runner group\'s repository-access ' +
        'list excludes "groundnuty/icsoc-2026-science-agent" — an org admin must add this repo at: ' +
        'https://github.com/organizations/groundnuty/settings/actions/runner-groups/7. This tool cannot perform ' +
        'that step itself (org-admin action; macf#924).',
    };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    // Original wording is preserved verbatim (strict extension, not a rewrite).
    expect(routing?.reason).toMatch(/Runner class: github-hosted \(billed on private repos\)/);
    expect(routing?.reason).toMatch(/no self-hosted runner is confirmed registered/);
    // The handover is appended.
    expect(routing?.reason).toContain('an org admin must add this repo at');
    expect(routing?.reason).toContain('runner-groups/7');
  });

  it('never appends a handover when none was observed (the common absent/unknown case)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunnerRegistered: 'absent' };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).not.toMatch(/org admin/);
  });

  // --- macf#932 — plan surfaces the --runner-token requirement too, so it's
  // visible before approval rather than only discovered at apply time. Never
  // a "missing" claim, always a "required" one — but conditional on
  // registration status as of groundnuty/macf#1195: a runner already
  // confirmed present needs no token, so the note is no longer
  // unconditional (see `plan.ts::RUNNER_TOKEN_PLAN_NOTE`'s doc).

  it('names the flag + env var when self-hosted is declared and NO usable runner is confirmed', () => {
    for (const registered of ['absent', 'unknown', undefined] as const) {
      const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
      const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunnerRegistered: registered };
      const plan = computePlan(manifest, observed);
      const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
      expect(routing?.reason).toContain(RUNNER_TOKEN_FLAG);
      expect(routing?.reason).toContain(RUNNER_TOKEN_ENV_VAR);
    }
  });

  it('groundnuty/macf#1195 — does NOT name the flag/env var when a usable runner IS already confirmed present — no token is needed to USE it', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunnerRegistered: 'present' };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).toMatch(/Runner class: self-hosted/);
    expect(routing?.reason).not.toContain(RUNNER_TOKEN_FLAG);
    expect(routing?.reason).not.toContain(RUNNER_TOKEN_ENV_VAR);
    // The macf#993 "apply FAILS without a confirmed runner" note is still
    // unconditional — a runner present NOW can still go offline before
    // `apply` runs.
    expect(routing?.reason).toMatch(/A declared routing\.runner is REQUIRED/);
  });

  it('also names the flag + env var on the observed-value-matches noop path (routingTrustedActors already correct) — registration is NOT observed here, so the non-present branch applies', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingTrustedActors: 'icsoc-2026-science-agent[bot] icsoc-2026-code-agent[bot]',
    };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.verb).toBe('noop');
    expect(routing?.reason).toContain(RUNNER_TOKEN_FLAG);
  });

  it('does NOT name the flag + env var on the drifting-value update path when a runner IS confirmed present (groundnuty/macf#1195)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted', routingRunnerRegistered: 'present' };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.verb).toBe('update');
    expect(routing?.reason).not.toContain(RUNNER_TOKEN_FLAG);
  });

  it('never appears when runs_on is declared but is NOT "self-hosted" — no write is ever a candidate, so nothing to require', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'ubuntu-latest', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).not.toContain(RUNNER_TOKEN_FLAG);
  });

  it('never appears when routing.runner is not declared at all (no routing item emitted)', () => {
    const manifest = baseManifest();
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing).toBeUndefined();
  });

  // --- groundnuty/macf#993 — plan states plainly, BEFORE approval, that a
  // declared runner is REQUIRED and `apply` will FAIL without one. Same
  // "unconditional note" shape as the macf#932 suite immediately above
  // (plan cannot know the LIVE outcome `apply` will observe, so it names the
  // REQUIREMENT, not a "missing" claim).

  it('states plainly that apply will FAIL without a confirmed runner — regardless of registration status observed at plan time', () => {
    for (const registered of ['present', 'absent', 'unknown', undefined] as const) {
      const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
      const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunnerRegistered: registered };
      const plan = computePlan(manifest, observed);
      const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
      expect(routing?.reason).toContain('REQUIRED');
      expect(routing?.reason).toMatch(/`apply` FAILS/);
      expect(routing?.reason).toContain('rather than silently falling back to a metered hosted runner');
    }
  });

  it('never appears when runs_on is declared but is NOT "self-hosted" — nothing to fail on', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'ubuntu-latest', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).not.toContain('groundnuty/macf#993');
  });

  // The "routing.runner not declared at all -> no routing item emitted"
  // regression guard is already covered above (line ~386-391) — not
  // duplicated here.

  // --- macf#934 — capability detail surfaces in the plan's runner-class line, same resolution as the live gate ---

  it('appends the macf#934 capability detail (found-but-mislabeled) to the runner-class reason, without dropping the original wording', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingRunnerRegistered: 'absent',
      routingRunnerDetail:
        'a runner registered for "groundnuty/icsoc-2026-science-agent" is online but not carrying required ' +
        'label(s) "macf-vm" (carries: self-hosted).',
    };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    // Original wording is preserved verbatim (strict extension, not a rewrite).
    expect(routing?.reason).toMatch(/Runner class: github-hosted \(billed on private repos\)/);
    expect(routing?.reason).toMatch(/no self-hosted runner is confirmed registered/);
    // The detail is appended, naming the missing label and what was found.
    expect(routing?.reason).toContain('not carrying required label(s) "macf-vm"');
    expect(routing?.reason).toContain('carries: self-hosted');
  });

  it('appends BOTH the detail and the handover when both are observed (found-but-excluded org runner, macf#934 + macf#924 together)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingRunnerRegistered: 'absent',
      routingRunnerDetail: 'a runner registered for "x" carries the required labels but is offline (status="offline").',
      routingRunnerHandover: 'An org admin must add this repo at https://example.invalid/.',
    };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).toContain('is offline (status="offline")');
    expect(routing?.reason).toContain('An org admin must add this repo at');
  });

  it('never appends a detail when none was observed (the common zero-runners absent/unknown case)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunnerRegistered: 'absent' };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.reason).not.toMatch(/carries|offline|missing/);
  });
});

// --- DR-043 Amendment I / groundnuty/macf#942 — the runner_warm plan item ---

describe('computePlan — runner_warm item (DR-043 Amendment I, groundnuty/macf#942)', () => {
  function warmItem(items: readonly PlanItem[]): PlanItem | undefined {
    return itemFor(items, 'runner_warm', 'routing:icsoc-2026:runner:warm');
  }

  it('is ABSENT entirely when routing.runner is not declared — same "nothing was promised" gate as routingItem', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(warmItem(plan.items)).toBeUndefined();
  });

  it('is present as a write-always item (groundnuty/macf#926, was create), naming the declared default (1), when routing.runner is declared', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const item = warmItem(plan.items);
    expect(item?.verb).toBe('write-always');
    expect(item?.confirm_required).toBe(false);
    expect(item?.reason).toContain('warm: 1');
    // groundnuty/macf#943 — apply now calls the runner-provisioning contract
    // with this value; "not yet observable" still holds (no live warm/dormant
    // signal to compare against), "not yet enforced" no longer does.
    expect(item?.reason).toContain('not yet observable');
    expect(item?.reason).toContain('apply sends it on every runner-provisioning-contract call');
  });

  it('DECISIVE (corrected by groundnuty/macf#943): warm: 0 (a dormant fleet) still emits the item, naming the dormant state in the reason, and NO LONGER surfaces in unimplementedByApply — apply wires the contract call now', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 0 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const item = warmItem(plan.items);
    expect(item?.verb).toBe('write-always');
    expect(item?.reason).toContain('warm: 0');
    expect(item?.reason).toContain('this fleet is declared dormant');
    // groundnuty/macf#943 — `runner_warm` joined the always-`'implemented'`
    // group (planItemApplyCoverage); it must NOT appear in
    // unimplementedByApply anymore, matching 'version'/'actions_pin''s own
    // history (see APPLY_UNIMPLEMENTED_REASONS's doc, "ALSO GONE").
    const unimplemented = plan.unimplementedByApply.find((i) => i.kind === 'runner_warm');
    expect(unimplemented).toBeUndefined();
  });

  it('is now IMPLEMENTED by apply for every verb it can emit (groundnuty/macf#943 — apply calls the runner-provisioning contract)', () => {
    expect(planItemApplyCoverage(fakeItem('runner_warm', 'create'))).toBe('implemented');
    expect(planItemApplyCoverage(fakeItem('runner_warm', 'update'))).toBe('implemented');
    // groundnuty/macf#926 — the verb `runnerWarmItem` ACTUALLY emits.
    expect(planItemApplyCoverage(fakeItem('runner_warm', 'write-always'))).toBe('implemented');
  });

  it('noop/report-extra are still trivially implemented for runner_warm — nothing calls for action', () => {
    expect(planItemApplyCoverage(fakeItem('runner_warm', 'noop'))).toBe('implemented');
    expect(planItemApplyCoverage(fakeItem('runner_warm', 'report-extra'))).toBe('implemented');
  });

  it('APPLY_UNIMPLEMENTED_REASONS no longer carries a runnerWarm entry (groundnuty/macf#943 — the gap it described is closed)', () => {
    // groundnuty/macf#1229 / DR-043 Amendment P3 row 4 — `rowFourDelete`
    // joined this constant as the ONE shared reason for every kind that can
    // now carry a `delete` verb (see `unimplementedReasonFor`'s doc: a
    // verb-level fact, checked before the per-kind switch this test's own
    // describe block otherwise exercises).
    expect(Object.keys(APPLY_UNIMPLEMENTED_REASONS)).toEqual(['routing', 'rowFourDelete']);
  });

  it('is present in EVERY plan that declares routing.runner — a fleet-level item, not per-agent', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 5 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const items = plan.items.filter((i) => i.kind === 'runner_warm');
    expect(items).toHaveLength(1); // exactly ONE, not one per agent
    expect(items[0]?.reason).toContain('warm: 5');
  });
});

describe('computePlan — runner_platform item (groundnuty/macf#1211)', () => {
  function platformItem(items: readonly PlanItem[]): PlanItem | undefined {
    return itemFor(items, 'runner_platform', 'routing:icsoc-2026:runner:platform_endpoint');
  }

  it('is ABSENT entirely when routing.runner is not declared — same "nothing was promised" gate as routingItem/runnerWarmItem', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(platformItem(plan.items)).toBeUndefined();
  });

  it('is ABSENT when routing.runner IS declared but runs_on is NOT self-hosted — narrower gate than runnerWarmItem, matching apply-fleet.ts\'s own condition for attempting the provisioning call', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'ubuntu-latest', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(platformItem(plan.items)).toBeUndefined();
    // Sanity: the SIBLING item (runnerWarmItem) is NOT gated this narrowly —
    // it still fires, proving the two items' gates are genuinely different,
    // not an accidental byproduct of a shared condition.
    expect(itemFor(plan.items, 'runner_warm', 'routing:icsoc-2026:runner:warm')).toBeDefined();
  });

  // --- Decisive pair (assert-the-wrong-path.md — two triggers) ---

  it('DECISIVE 1/2: routing.runner declared + self-hosted + nothing resolves -> plan states runner provisioning will be SKIPPED, non-fatal', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED); // no runnerPlatformEndpoint set
    const item = platformItem(plan.items);
    expect(item?.verb).toBe('write-always');
    expect(item?.confirm_required).toBe(false);
    expect(item?.reason).toMatch(/not resolved/i);
    expect(item?.reason).toMatch(/skipped/i);
    expect(item?.reason).toMatch(/non-fatal/i);
  });

  it('DECISIVE 2/2: routing.runner declared + self-hosted + endpoint resolves -> NO skip notice — proves the notice is conditional, not unconditional', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, runnerPlatformEndpoint: { value: 'http://runner-platform.example.ts.net:8088', source: 'scope' } };
    const plan = computePlan(manifest, observed);
    const item = platformItem(plan.items);
    expect(item?.verb).toBe('write-always');
    expect(item?.reason).toMatch(/resolved via/i);
    expect(item?.reason).not.toMatch(/skipped/i);
  });

  // --- Provenance — "plan names which source supplied it" ---

  it.each<[RunnerPlatformEndpointSource, RegExp]>([
    ['flag', /explicit override/i],
    ['env', /MACF_RUNNER_PLATFORM_ENDPOINT/],
    ['scope', /scope/i],
    ['manifest', /transport\.runner_platform_endpoint/],
  ])('names the "%s" source distinctly in the reason text', (source, expectedPattern) => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, runnerPlatformEndpoint: { value: 'http://x:8088', source } };
    const plan = computePlan(manifest, observed);
    expect(platformItem(plan.items)?.reason).toMatch(expectedPattern);
  });

  it('DECISIVE — the resolved endpoint is a URL, never a secret: it appears VERBATIM in the plan reason, never masked', () => {
    const sentinel = 'http://orzech-dev-agents-monitoring.tail491af.ts.net:8088';
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, runnerPlatformEndpoint: { value: sentinel, source: 'scope' } };
    const plan = computePlan(manifest, observed);
    const reason = platformItem(plan.items)?.reason ?? '';
    expect(reason).toContain(sentinel);
    expect(reason).not.toMatch(/\*{3,}|REDACTED|\[hidden\]/i);
    // The whole PLAN — not just this one item — must never redact it either;
    // formatPlanText / fleetPlanToJson both pass PlanItem.reason straight
    // through with no scrubbing step (there is none to scrub a variable).
    expect(formatPlanText(plan)).toContain(sentinel);
  });

  it('is exactly ONE item per fleet, not one per agent', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.items.filter((i) => i.kind === 'runner_platform')).toHaveLength(1);
  });

  it('is IMPLEMENTED by apply for the only verb it can emit (write-always) — apply genuinely resolves + uses this value', () => {
    expect(planItemApplyCoverage(fakeItem('runner_platform', 'write-always'))).toBe('implemented');
  });

  it('is never present in unimplementedByApply', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.unimplementedByApply.find((i) => i.kind === 'runner_platform')).toBeUndefined();
  });
});

describe('computePlan — an observed extra agent NOT in fleet.lock → report-extra, NEVER delete/orphan (row 5 of the matrix; row 4 has its own describe block below)', () => {
  it('emits a report-extra item for an agent in observed but not in the manifest', () => {
    const manifest = baseManifest(); // science-agent + code-agent only
    const observed: ObservedState = {
      lock: null,
      agents: {
        'writer-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
      },
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };

    const plan = computePlan(manifest, observed);
    const extra = plan.items.find((i) => i.kind === 'agent');
    expect(extra?.verb).toBe('report-extra');
    expect(extra?.target).toBe('agent:writer-agent');
    expect(extra?.confirm_required).toBe(false);
  });

  // groundnuty/macf#1229 / DR-043 Amendment P3 — decisive pair, HALF 2:
  // "undeclared + present + NOT in the lock → report-extra, and NOTHING
  // ELSE." Retitled from the pre-#1229 claim ("no verb in the whole
  // PlanVerb union is delete") which is now false AT THE TYPE LEVEL —
  // `PlanVerb` DOES include `'delete'`/`'orphan'` since this change. What
  // stays true, and is what this test actually pins, is narrower and
  // still load-bearing: THIS fixture (`lock: null`) never produces either
  // verb, because the role isn't recorded as ours. `'prune'` was never a
  // real member of the union — that assertion stays meaningful as a
  // "this string never sneaks in under a different name" guard.
  it('an extra role with NO fleet.lock produces report-extra and NOTHING else — no delete, no orphan, no prune', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: null,
      agents: { 'orphan-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: { app_private_key: 'sha256:x' } } },
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    const verbsSeen = new Set(plan.items.map((i) => i.verb));
    for (const v of verbsSeen) {
      expect(['create', 'update', 'noop', 'report-extra', 'write-always']).toContain(v);
    }
    // The decisive assertion: not just "no item happens to be delete", but
    // ZERO delete/orphan items exist anywhere in this plan — asserting on
    // `verb === 'report-extra'` alone (as the pre-#1229 version of this
    // test did) would still pass if a mutated row-4 gate added orphan/delete
    // items ALONGSIDE the report-extra one; this is the assertion the
    // mutation check below actually depends on.
    expect(plan.items.filter((i) => i.verb === 'delete' || i.verb === 'orphan')).toEqual([]);
    expect(plan.items.some((i) => (i.verb as string) === 'prune')).toBe(false);
  });

  it('report-extra items are sorted by role for deterministic ordering', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: null,
      agents: {
        'zzz-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
        'aaa-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
      },
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    const extras = plan.items.filter((i) => i.kind === 'agent').map((i) => i.target);
    expect(extras).toEqual(['agent:aaa-agent', 'agent:zzz-agent']);
  });
});

// --- Row 4 (DR-043 Amendment P3, groundnuty/macf#1229) — negative diff for
// undeclared-but-locked resources -------------------------------------------

/** A role observed present with App/repo/one secret — the shared shape row-4 fixtures below vary `lock` against. */
function extraRoleObserved(role: string): Readonly<Record<string, ObservedAgentState>> {
  return { [role]: { app: 'present', install: 'present', repo: 'present', fingerprints: { app_private_key: 'sha256:x' } } };
}

/**
 * `repo` omitted by default — the pre-groundnuty/macf#1296 shape every
 * existing test in this file (predating that issue) exercises unchanged.
 * Callers that need the "lock records the repo" half pass it explicitly.
 */
function lockWithRole(role: string, repo?: string): FleetLock {
  return { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role, app_id: 'a', install_id: 'i', ...(repo !== undefined ? { repo } : {}) }] };
}

describe('computePlan — row 4 (DR-043 Amendment P3, groundnuty/macf#1229): negative diff for undeclared-but-locked resources', () => {
  // groundnuty/macf#1229 — decisive pair, HALF 1: "undeclared + present + IN
  // the lock → delete/orphan per class, naming the resource." (HALF 2 —
  // "NOT in the lock → report-extra, and nothing else" — is the retitled
  // test in the describe block immediately above this one.)
  it('an extra role recorded in fleet.lock decomposes into per-class orphan/delete items, each naming the resource', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('dropped-agent'),
      agents: extraRoleObserved('dropped-agent'),
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);

    // No coarse whole-agent 'agent'/'report-extra' item — it decomposed.
    expect(plan.items.find((i) => i.kind === 'agent' && i.target === 'agent:dropped-agent')).toBeUndefined();

    const appItem = plan.items.find((i) => i.kind === 'app' && i.target === 'agent:dropped-agent:app');
    expect(appItem?.verb).toBe('orphan');
    expect(appItem?.reason).toContain('dropped-agent');
    expect(appItem?.confirm_required).toBe(false);

    const repoItem = plan.items.find((i) => i.kind === 'repo' && i.target === 'agent:dropped-agent:repo');
    expect(repoItem?.verb).toBe('orphan');
    expect(repoItem?.reason).toContain('dropped-agent');

    const secretItem = plan.items.find((i) => i.kind === 'secret_fingerprint' && i.target === 'agent:dropped-agent:secret_fingerprint:app_private_key');
    expect(secretItem?.verb).toBe('delete');
    expect(secretItem?.reason).toContain('app_private_key');
    expect(secretItem?.confirm_required).toBe(true);
  });

  // Table-driven: each resource class maps to its Amendment-G-revival-cost
  // ratified verb (Amendment P3's table). Isolates ONE class at a time by
  // only marking that ONE observed field 'present'.
  it.each<{ label: string; obs: Partial<{ app: Presence; repo: Presence }>; fingerprints?: Readonly<Record<string, string>>; kind: string; verb: 'delete' | 'orphan' }>([
    { label: 'App (identity)', obs: { app: 'present' }, kind: 'app', verb: 'orphan' },
    { label: 'repo', obs: { repo: 'present' }, kind: 'repo', verb: 'orphan' },
    { label: 'secret (fingerprint)', obs: {}, fingerprints: { webhook_secret: 'sha256:y' }, kind: 'secret_fingerprint', verb: 'delete' },
  ])('$label maps to verb "$verb"', ({ obs, fingerprints, kind, verb }) => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('classy-agent'),
      agents: {
        'classy-agent': { app: 'absent', install: 'unknown', repo: 'absent', fingerprints: fingerprints ?? {}, ...obs },
      },
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    const matches = plan.items.filter((i) => i.kind === kind && i.target.startsWith('agent:classy-agent:'));
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) expect(m.verb).toBe(verb);
  });

  it('live presence unconfirmable ("unknown") on a lock that RECORDS the repo name → neither delete nor orphan for either class — the honest-unknown floor (Amendment A)', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('unsure-agent', 'groundnuty/icsoc-2026-unsure-agent'),
      agents: { 'unsure-agent': { app: 'unknown', install: 'unknown', repo: 'unknown', fingerprints: {} } },
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    expect(plan.items.some((i) => i.target.startsWith('agent:unsure-agent:'))).toBe(false);
  });

  // groundnuty/macf#1313 — the App class stays silent on its own "unknown"
  // (unchanged, asserted above); the repo class does NOT get that same
  // silence when the repo NAME is unrecorded (pre-#1296 lock) — there is no
  // live check this tool can even attempt without a name, so `obs?.repo`
  // being 'unknown' can never distinguish "genuinely can't confirm" from
  // "this branch never had anything to confirm in the first place". Per
  // science's ruling: the row still names the ROLE (the one thing this tool
  // DOES know) rather than staying silent about the costlier-to-lose
  // resource class (Amendment G).
  it('groundnuty/macf#1313 — a repo-name-UNRECORDED role still orphans the repo, naming the ROLE, even when app/install/repo are ALL "unknown"', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('unnamed-repo-agent'), // no `repo` key — the pre-#1296 shape
      agents: { 'unnamed-repo-agent': { app: 'unknown', install: 'unknown', repo: 'unknown', fingerprints: {} } },
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    // App/install stay silent — Amendment A's floor is untouched for that class.
    expect(plan.items.some((i) => i.kind === 'app' && i.target === 'agent:unnamed-repo-agent:app')).toBe(false);
    // The repo class fires anyway, naming the role, never the repo.
    const repoItem = plan.items.find((i) => i.kind === 'repo' && i.target === 'agent:unnamed-repo-agent:repo');
    expect(repoItem?.verb).toBe('orphan');
    expect(repoItem?.reason).toContain('unnamed-repo-agent');
    expect(repoItem?.reason).toContain('unrecorded');
    expect(repoItem?.reason).not.toMatch(/https:\/\/github\.com\/\S+\/settings/);
  });

  it('a declared resource is untouched by row 4 — the extraRoles computation only ever considers roles NOT in the manifest', () => {
    const manifest = baseManifest(); // declares 'science-agent' + 'code-agent'
    const observed: ObservedState = {
      // 'science-agent' recorded in the lock — if row 4 mistakenly ran
      // against DECLARED roles too, this would misfire an orphan/delete for
      // an agent the manifest still wants.
      lock: lockWithRole('science-agent'),
      agents: {
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: { app_private_key: 'sha256:x' } },
        'code-agent': { app: 'absent', install: 'absent', repo: 'absent', fingerprints: {} },
      },
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    expect(plan.items.some((i) => i.verb === 'delete' || i.verb === 'orphan')).toBe(false);
  });

  // groundnuty/macf#1229 — fleet-level pseudo-roles (`runner-ops`/`router`)
  // live in `fleet.lock.agents` by design (their own dedicated plan items,
  // `runnerOpsItem`/`routerAppItem`, check lock membership the SAME way).
  // They must never be treated as "extra agent" roles even when a caller's
  // `observed.agents` map (hypothetically, since the real observer never
  // does this) happens to carry a matching key.
  it.each([RUNNER_OPS_ROLE, ROUTER_APP_ROLE])('fleet-level pseudo-role "%s" is excluded from row 4 even when locked and observed', (role) => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole(role),
      agents: extraRoleObserved(role),
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    expect(plan.items.some((i) => i.target.startsWith(`agent:${role}:`))).toBe(false);
    expect(plan.items.some((i) => i.kind === 'agent' && i.target === `agent:${role}`)).toBe(false);
  });

  // --- Mutation check: break the lock-membership gate, name what fails ---
  //
  // The property under test: an extra role with NO `fleet.lock` entry never
  // decomposes into orphan/delete items, however present it is observed.
  // Empirically verified (not merely asserted) by mutating `plan.ts`'s
  // `const lockRoles = new Set((observed.lock?.agents ?? []).map((a) =>
  // a.role));` to `const lockRoles = new Set(Object.keys(observed.agents));`
  // — the UNSAFE direction: membership always reads true for every extra
  // role, regardless of what `fleet.lock` actually records — then running
  // this suite. Result: 5 tests fail, most decisively THIS test (the
  // `delete`/`orphan` assertion below flips from `false` to `true` — an
  // orphan/delete item genuinely leaked in for an UNRECORDED role) and "an
  // extra role with NO fleet.lock produces report-extra and NOTHING else"
  // in the describe block above (its `toContain('orphan')` assertion is
  // exactly what catches the leak there too). The other 3 failures
  // (`emits a report-extra item…`, `report-extra items are sorted by
  // role…`, the `plan-item-write-always.test.ts` `agent (report-extra)`
  // case) are a SIDE EFFECT of the same mutation removing the coarse
  // fallback item, not independent proof — this test and its sibling above
  // are the ones that directly assert the safety property itself. The
  // mutation was reverted after confirming the failures; this test is the
  // durable regression guard for that same property going forward.
  it('an extra role with NO fleet.lock entry never decomposes into orphan/delete, however present it is observed', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: null,
      agents: extraRoleObserved('unrecorded-agent'),
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    expect(plan.items.some((i) => i.verb === 'delete' || i.verb === 'orphan')).toBe(false);
    expect(plan.items.find((i) => i.kind === 'agent' && i.target === 'agent:unrecorded-agent')?.verb).toBe('report-extra');
  });

  it('orphan is ALWAYS planItemApplyCoverage "implemented" — apply correctly does nothing, never a reported gap', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('gone-agent'),
      agents: extraRoleObserved('gone-agent'),
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    const orphanItems = plan.items.filter((i) => i.verb === 'orphan');
    expect(orphanItems.length).toBeGreaterThan(0);
    for (const item of orphanItems) {
      expect(planItemApplyCoverage(item)).toBe('implemented');
    }
    // And 'delete' items DO surface as not_implemented — the deliberate
    // "computation only, apply is unwired" contract for THIS change.
    const deleteItems = plan.items.filter((i) => i.verb === 'delete');
    expect(deleteItems.length).toBeGreaterThan(0);
    for (const item of deleteItems) {
      expect(planItemApplyCoverage(item)).toBe('not_implemented');
    }
    expect(plan.unimplementedByApply.some((i) => i.verb === 'delete')).toBe(true);
    expect(plan.unimplementedByApply.some((i) => i.verb === 'orphan')).toBe(false);
  });
});

// groundnuty/macf#1229 — `routingDroppedItem` carries its OWN copy of the
// row-4 lock-membership safety property (`ownedByThisTool`), independent of
// the `extraRoles` loop's `lockRoles` gate above (different resource,
// different code path — the routing variable is fleet-level, not per-role).
// Empirically mutation-verified the SAME way: mutating `routingDroppedItem`'s
// `const ownedByThisTool = representativeRole !== undefined && (lock?.agents
// .some(...) ?? false);` to `const ownedByThisTool = true;` and running just
// this describe block fails EXACTLY "emits NOTHING when the representative
// role is NOT recorded in fleet.lock" (1 of 3) — "emits NOTHING when the
// variable presence is unconfirmed" still PASSES under that mutation,
// confirming the two early-returns (`observedTrustedActors === undefined`
// vs. `!ownedByThisTool`) are genuinely independent checks, not one guard
// doing double duty. Mutation reverted after confirming.
describe('computePlan — row 4, the MACF_TRUSTED_ACTORS worked example (groundnuty/macf#1229 original motivating case): routing.runner DROPPED from the manifest', () => {
  it('emits a delete item when the variable is observed present AND the representative role is recorded in fleet.lock', () => {
    const manifest = baseManifest(); // routing.runner NOT declared
    const observed: ObservedState = {
      lock: lockWithRole('science-agent'), // manifest.agents[0].role
      agents: {},
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
      routingTrustedActors: 'icsoc-2026-science-agent[bot],icsoc-2026-code-agent[bot]',
    };
    const plan = computePlan(manifest, observed);
    const item = plan.items.find((i) => i.kind === 'routing');
    expect(item?.verb).toBe('delete');
    expect(item?.confirm_required).toBe(true);
    expect(item?.reason).toContain('MACF_TRUSTED_ACTORS');
  });

  it('emits NOTHING when the representative role is NOT recorded in fleet.lock — not ours to judge (the same row-4 safety property)', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: null,
      agents: {},
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
      routingTrustedActors: 'icsoc-2026-science-agent[bot],icsoc-2026-code-agent[bot]',
    };
    const plan = computePlan(manifest, observed);
    expect(plan.items.some((i) => i.kind === 'routing')).toBe(false);
  });

  it('emits NOTHING when the variable presence is unconfirmed ("undefined") — honest-unknown floor, even with a matching lock entry', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('science-agent'),
      agents: {},
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
      // routingTrustedActors deliberately omitted — undefined.
    };
    const plan = computePlan(manifest, observed);
    expect(plan.items.some((i) => i.kind === 'routing')).toBe(false);
  });
});

// --- groundnuty/macf#1281 — an orphan row says explicitly that nothing was
// deleted, and carries a link to delete it by hand -------------------------

describe('orphanResourceUrl (groundnuty/macf#1281) — the pure URL a row-4 orphan item points the operator at', () => {
  it('app orphan, user(personal)-owned fleet → the personal-account Advanced-tab URL', () => {
    const owner: FleetManifest['owner'] = { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } };
    expect(orphanResourceUrl('app', 'icsoc-2026', 'dropped-agent', owner)).toBe('https://github.com/settings/apps/icsoc-2026-dropped-agent/advanced');
  });

  it('app orphan, org-owned fleet → the ORG Advanced-tab URL — a DIFFERENT path from the personal-account one', () => {
    const owner: FleetManifest['owner'] = { account: 'demo-org', type: 'org', registry: { type: 'org', org: 'demo-org' } };
    expect(orphanResourceUrl('app', 'icsoc-2026', 'dropped-agent', owner)).toBe(
      'https://github.com/organizations/demo-org/settings/apps/icsoc-2026-dropped-agent/advanced',
    );
  });

  it('repo orphan, NO lockedRepo given → "unknown", never a guessed link, regardless of owner type', () => {
    const userOwner: FleetManifest['owner'] = { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } };
    const orgOwner: FleetManifest['owner'] = { account: 'demo-org', type: 'org', registry: { type: 'org', org: 'demo-org' } };
    // groundnuty/macf#1281's own AC text asks for a real `https://github.com/
    // <owner>/<repo>/settings` link here — and groundnuty/macf#1296 makes
    // that possible ONCE `fleet.lock.agents[].repo` is recorded. This test
    // pins the OTHER half: a lock written before #1296 (or a role whose
    // update never carried a repo) has no `lockedRepo` to pass, and this
    // function must still refuse to guess — never a filled-in URL built from
    // `role`/`fleetName` alone (that WAS the #1281-era gap; see
    // `orphanResourceUrl`'s own doc for why guessing stays unacceptable even
    // now that a real value CAN exist).
    expect(orphanResourceUrl('repo', 'icsoc-2026', 'dropped-agent', userOwner)).toBe('unknown');
    expect(orphanResourceUrl('repo', 'icsoc-2026', 'dropped-agent', orgOwner)).toBe('unknown');
  });

  // groundnuty/macf#1296 — the "records" half: once `fleet.lock` carries
  // `repo`, the orphan URL resolves to a real, class-correct settings page —
  // built from the recorded value VERBATIM, never re-derived from role/owner
  // (a `deriveAppHandle`-style re-derivation would be exactly the guess this
  // function's own doc forbids).
  it('repo orphan, lockedRepo given → a real settings URL, verbatim from the recorded value', () => {
    const owner: FleetManifest['owner'] = { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } };
    expect(orphanResourceUrl('repo', 'icsoc-2026', 'dropped-agent', owner, 'groundnuty/icsoc-2026-dropped-agent')).toBe(
      'https://github.com/groundnuty/icsoc-2026-dropped-agent/settings',
    );
  });
});

describe('orphan rows say "not deleted" + carry a link, on BOTH the plan and apply surfaces (groundnuty/macf#1281)', () => {
  it('DECISIVE (1): a plan with an orphan item says nothing was deleted, and carries a class-correct URL', () => {
    const manifest = baseManifest({ owner: { account: 'demo-org', type: 'org', registry: { type: 'org', org: 'demo-org' } } });
    const observed: ObservedState = {
      lock: lockWithRole('dropped-agent'),
      agents: extraRoleObserved('dropped-agent'),
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    const text = formatPlanText(plan);
    expect(text).toMatch(/NOTHING (WAS|IS) DELETED/);
    expect(text).toContain('https://github.com/organizations/demo-org/settings/apps/icsoc-2026-dropped-agent/advanced');
  });

  it('DECISIVE (2): a plan with NO orphan items renders no orphan notice at all — no noise', () => {
    const manifest = baseManifest();
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.items.some((i) => i.verb === 'orphan')).toBe(false);
    expect(formatOrphanLines(plan.items)).toEqual([]);
    expect(formatPlanText(plan)).not.toMatch(/ORPHAN/);
  });

  it('a repo orphan and an App orphan get class-correct treatment in the RENDERED plan reason — repo names the ROLE with no link, App is a real, resolvable link', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('dropped-agent'),
      agents: extraRoleObserved('dropped-agent'),
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    const appItem = plan.items.find((i) => i.kind === 'app' && i.verb === 'orphan');
    const repoItem = plan.items.find((i) => i.kind === 'repo' && i.verb === 'orphan');
    expect(appItem?.reason).toContain('https://github.com/settings/apps/icsoc-2026-dropped-agent/advanced');
    expect(repoItem?.reason).toContain('unrecorded');
    expect(repoItem?.reason).toContain('dropped-agent');
    // Never a guessed repo-settings link — a wrong link is worse than none.
    expect(repoItem?.reason).not.toMatch(/https:\/\/github\.com\/\S+\/settings/);
  });

  // groundnuty/macf#1296 — the decisive pair the issue's own "Tests" section
  // asks for, on the row-4 repo-orphan RENDERED reason specifically. (1)
  // alone (assert a real URL when the lock records the repo) would be
  // satisfied by an implementation that ALWAYS fabricates a URL from
  // role/fleetName — (2) is what proves it's reading the recorded value,
  // not guessing: a lock predating the field must still refuse.
  it('DECISIVE (1/2): a lock that RECORDS the repo → the orphan row carries the real settings URL', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('dropped-agent', 'groundnuty/icsoc-2026-dropped-agent'),
      agents: extraRoleObserved('dropped-agent'),
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    const repoItem = plan.items.find((i) => i.kind === 'repo' && i.verb === 'orphan');
    expect(repoItem?.reason).toContain('https://github.com/groundnuty/icsoc-2026-dropped-agent/settings');
    expect(repoItem?.reason).not.toContain('unknown');
    // Same assertion on the rendered plan TEXT, not just the raw item — the
    // operator-facing surface, per `formatPlanText`.
    expect(formatPlanText(plan)).toContain('https://github.com/groundnuty/icsoc-2026-dropped-agent/settings');
  });

  // groundnuty/macf#1313 — per science's ruling, this row NAMES THE ROLE
  // (the one thing this tool knows) rather than staying silent or
  // fabricating a link. It states the name is unrecorded (not absent),
  // explains WHY in plain language (no internal citation — macf#1061's
  // "explain, don't cite" rule for user-facing output), carries the same
  // search hint #1281 already writes for the analogous unresolvable-App-URL
  // case, and states the self-limiting scope PRECISELY: verified against
  // `composeFleetLock` (fleet-lock.ts) — an already-undeclared role's lock
  // entry is carried forward untouched by every future apply (nothing ever
  // recomputes its `repo`), so THIS row can never gain a name. What is
  // self-limiting is the CLASS: a role still declared today already has
  // its repo recorded, so a FUTURE removal names it exactly. The row must
  // not claim this instance will resolve itself — that would be a false
  // promise the operator could catch out on the very next apply.
  it('DECISIVE (2/2): a lock that PREDATES the field (no repo key at all) → the orphan row names the ROLE, explains why, and scopes "self-limiting" to the CLASS, never promising this row resolves — no fabricated link', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('dropped-agent'), // no repo — the pre-#1296 shape
      agents: extraRoleObserved('dropped-agent'),
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    const repoItem = plan.items.find((i) => i.kind === 'repo' && i.verb === 'orphan');
    // Names the role.
    expect(repoItem?.reason).toContain('dropped-agent');
    // States the name is unrecorded — explicitly NOT "absent" (science's
    // own contrast: "unrecorded, not absent") — and explains why, in plain
    // language, never an internal issue-number citation (macf#1061).
    expect(repoItem?.reason).toContain('unrecorded');
    expect(repoItem?.reason).toContain('not absent');
    expect(repoItem?.reason).toMatch(/predates this tool recording repo names/i);
    expect(repoItem?.reason).not.toMatch(/\bmacf#\d+\b|\bgroundnuty\/macf#\d+\b/);
    // Carries the #1281-style search hint.
    expect(repoItem?.reason).toMatch(/search your github/i);
    // States the gap is self-limiting AS A CLASS ("still declared today"
    // roles are covered going forward) — but does NOT promise THIS row
    // (an already-undeclared role) will ever resolve on its own.
    expect(repoItem?.reason.toLowerCase()).toContain('self-limiting');
    expect(repoItem?.reason).toMatch(/never recover/i);
    expect(repoItem?.reason).toMatch(/still declared today/i);
    // Never a fabricated/derived link.
    expect(repoItem?.reason).not.toMatch(/https:\/\/github\.com\/\S+\/settings/);
  });

  it('org-owned vs user-owned App orphan resolves to a DIFFERENT, class-correct path each time, in the RENDERED reason', () => {
    const observed: ObservedState = {
      lock: lockWithRole('dropped-agent'),
      agents: extraRoleObserved('dropped-agent'),
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const userPlan = computePlan(baseManifest(), observed);
    const orgPlan = computePlan(baseManifest({ owner: { account: 'demo-org', type: 'org', registry: { type: 'org', org: 'demo-org' } } }), observed);
    const userAppReason = userPlan.items.find((i) => i.kind === 'app' && i.verb === 'orphan')?.reason ?? '';
    const orgAppReason = orgPlan.items.find((i) => i.kind === 'app' && i.verb === 'orphan')?.reason ?? '';
    expect(userAppReason).toContain('https://github.com/settings/apps/icsoc-2026-dropped-agent/advanced');
    expect(userAppReason).not.toContain('/organizations/');
    expect(orgAppReason).toContain('https://github.com/organizations/demo-org/settings/apps/icsoc-2026-dropped-agent/advanced');
  });

  it('a `delete` item never renders orphan language — the two verbs must not blur, since one removes and the other does not', () => {
    // Same fixture the routingDroppedItem describe block above uses: a
    // DECLARED role's routing var observed present + no longer wanted →
    // exactly ONE 'routing'-kind delete item, no app/repo orphan items in
    // the same plan (row 4's per-role loop never even runs — `agents: {}`).
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: lockWithRole('science-agent'), // manifest.agents[0].role
      agents: {},
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
      routingTrustedActors: 'icsoc-2026-science-agent[bot],icsoc-2026-code-agent[bot]',
    };
    const plan = computePlan(manifest, observed);
    const deleteItems = plan.items.filter((i) => i.verb === 'delete');
    expect(deleteItems.length).toBeGreaterThan(0);
    for (const item of deleteItems) {
      expect(item.reason.toLowerCase()).not.toContain('orphan');
    }
    expect(formatOrphanLines(plan.items)).toEqual([]);
    expect(formatPlanText(plan)).not.toMatch(/ORPHAN/);
  });
});

describe('computePlan — deterministic ordering', () => {
  it('orders per-agent items in manifest agents[] order, each agent app→repo→install→secret_fingerprint→labels', () => {
    // groundnuty/macf#1083 — self-hosted DECLARED so the runner_ops item is
    // actually emitted; this test's purpose is the ORDERING once it's
    // present, not the presence/absence gate itself (covered in the
    // dedicated #1083 describe block above).
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const kinds = plan.items.map((i) => i.kind);
    // groundnuty/macf#943 — the fleet-level `runner_ops` item comes
    // FIRST (right after the control-repo item, when present; absent here —
    // `EMPTY_OBSERVED.controlRepoPresence` is `'absent'`), then the
    // fleet-level `router_app` item (groundnuty/macf#1105, UNCONDITIONAL),
    // then the fleet-level `ts_oauth` item (groundnuty/macf#1109,
    // UNCONDITIONAL), before any per-agent item.
    expect(kinds.slice(0, 13)).toEqual([
      'runner_ops',
      'router_app',
      'ts_oauth',
      'app', 'repo', 'install', 'secret_fingerprint', 'labels', // science-agent
      'app', 'repo', 'install', 'secret_fingerprint', 'labels', // code-agent
    ]);
  });

  it('CA items (registry, then one per agent repo in manifest order), then routing_client per agent repo, precede routing, then runner_warm, all after per-agent items', () => {
    const manifest = baseManifest({
      routing: { runner: { runs_on: 'self-hosted', warm: 1 } },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const kinds = plan.items.map((i) => i.kind);
    // 10 per-agent items, then 3 CA items (registry + 2 agent repos), then
    // 2 routing_client items (one per agent repo), then routing, then
    // runner_warm (macf#942 — pushed right after routingItem), then
    // runner_platform (groundnuty/macf#1211 — pushed right after runner_warm,
    // gated on runs_on === 'self-hosted', true for this fixture).
    expect(kinds.slice(-8)).toEqual(['ca', 'ca', 'ca', 'routing_client', 'routing_client', 'routing', 'runner_warm', 'runner_platform']);
    const caTargets = plan.items.filter((i) => i.kind === 'ca').map((i) => i.target);
    expect(caTargets).toEqual([
      'ca:registry:ICSOC_2026_CA_CERT',
      'ca:repo:groundnuty/icsoc-2026-science-agent:ICSOC_2026_CA_CERT',
      'ca:repo:groundnuty/icsoc-2026-experiment:ICSOC_2026_CA_CERT',
    ]);
    const routingClientTargets = plan.items.filter((i) => i.kind === 'routing_client').map((i) => i.target);
    expect(routingClientTargets).toEqual([
      'routing_client:repo:groundnuty/icsoc-2026-science-agent:ROUTING_CLIENT_CERT',
      'routing_client:repo:groundnuty/icsoc-2026-experiment:ROUTING_CLIENT_CERT',
    ]);
  });

  it('is stable across repeated calls with the same input', () => {
    const manifest = baseManifest();
    const a = computePlan(manifest, EMPTY_OBSERVED);
    const b = computePlan(manifest, EMPTY_OBSERVED);
    expect(a.items).toEqual(b.items);
  });
});

describe('computePlan — skippedSections (declared-but-deferred sections, no silent caps)', () => {
  it('is empty when collaborators/shared are not declared', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.skippedSections).toEqual([]);
  });

  it('surfaces collaborators as SKIPPED when declared + non-empty', () => {
    const manifest = baseManifest({
      collaborators: [
        { project: 'ppam-2026', registry: { type: 'profile', user: 'groundnuty' }, ca_bundle: 'bundles/ppam.pem' },
      ],
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.skippedSections).toEqual([
      { section: 'collaborators', reason: 'reconcile not implemented in v1' },
    ]);
  });

  it('stays SILENT for an explicitly-empty collaborators array (nothing declared to skip)', () => {
    const manifest = baseManifest({ collaborators: [] });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.skippedSections).toEqual([]);
  });

  // `versions` is DELIBERATELY ABSENT from this describe block as of DR-043
  // §D6 being wired — declaring `versions:` no longer produces a
  // skippedSections entry (it produces real `version` / `actions_pin` plan
  // items instead; see version-steering.test.ts). This is the direct,
  // load-bearing regression-guard for that transition: a `versions:`-bearing
  // manifest staying OUT of `skippedSections` is exactly what "D6 is wired,
  // not deferred" means.
  it('does NOT surface versions as SKIPPED anymore — it produces real plan items instead', () => {
    const manifest = baseManifest({ versions: { macf: '0.2.44', actions: 'v3.4.1' } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.skippedSections).toEqual([]);
    expect(plan.items.some((i) => i.kind === 'version')).toBe(true);
    expect(plan.items.some((i) => i.kind === 'actions_pin')).toBe(true);
  });

  it('formatSkippedLines renders the exact loud-line shape (collaborators only)', () => {
    const manifest = baseManifest({
      versions: { macf: '0.2.44', actions: 'v3.4.1' },
      collaborators: [
        { project: 'ppam-2026', registry: { type: 'profile', user: 'groundnuty' }, ca_bundle: 'bundles/ppam.pem' },
      ],
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const lines = formatSkippedLines(plan.skippedSections);
    expect(lines).toEqual(['collaborators: SKIPPED (reconcile not implemented in v1)']);
  });

  // groundnuty/macf#1355 — `shared:` is the second PRESENCE-GATED section
  // (same optional-section shape `collaborators` already established). This
  // is the issue's decisive test pair AND its own closing criterion: a
  // manifest DECLARING `shared.ts_oauth` names it, verbatim, in the
  // RENDERED plan text; a manifest OMITTING `shared` entirely produces no
  // line, no noise for that section — byte-identical to a manifest that
  // never mentions it (`plan.skippedSections` stays `[]`, not merely
  // "shared absent from a longer array").
  describe('shared (groundnuty/macf#1355)', () => {
    it('names shared.routing_app / shared.ts_oauth in the rendered plan text when the section is declared', () => {
      const manifest = baseManifest({ shared: { routing_app: 'acme-routing', ts_oauth: 'acme-ts-oauth' } });
      const plan = computePlan(manifest, EMPTY_OBSERVED);
      expect(plan.skippedSections).toEqual([{ section: 'shared', reason: SKIPPED_SECTION_REASONS.shared }]);

      const rendered = formatPlanText(plan);
      expect(rendered).toContain('shared: SKIPPED');
      expect(rendered).toContain('shared.routing_app');
      expect(rendered).toContain('shared.ts_oauth');
      expect(rendered).toContain('#1161');
    });

    it('produces no line, no noise in the rendered plan when shared is omitted entirely — byte-identical to today', () => {
      const withShared = computePlan(baseManifest({ shared: { routing_app: 'x', ts_oauth: 'y' } }), EMPTY_OBSERVED);
      const withoutShared = computePlan(baseManifest(), EMPTY_OBSERVED);

      expect(formatPlanText(withShared)).toContain('shared: SKIPPED');
      expect(formatPlanText(withoutShared)).not.toContain('shared:');
      expect(withoutShared.skippedSections).toEqual([]);
    });
  });

  // groundnuty/macf#1355 — `defaults.app_manifest` / `agents[].profile` are
  // DELIBERATELY NOT disclosed via this mechanism (see `plan.ts`'s
  // `SKIPPED_SECTION_REASONS` doc for why: both are REQUIRED fields, so an
  // unconditional entry would violate the SAME "byte-identical when
  // declaring none" contract the `shared` tests above pin). This is a
  // regression guard against silently re-adding them the way an earlier
  // draft of this change did.
  it('does NOT surface defaults.app_manifest / agents[].profile — both are mandatory-and-inert, a schema-level gap, not a per-run disclosure', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const rendered = formatPlanText(plan);
    expect(rendered).not.toContain('defaults.app_manifest');
    expect(rendered).not.toContain('agents[].profile');
    expect(plan.skippedSections.some((s) => s.section === 'defaults.app_manifest')).toBe(false);
    expect(plan.skippedSections.some((s) => s.section === 'agents[].profile')).toBe(false);
  });
});

describe('summarizePlan', () => {
  it('counts each verb independently', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    const summary = summarizePlan(plan.items);
    // 8 per-agent creates (app/repo/install/secret_fingerprint × 2) + 3 CA
    // creates (registry + 2 agent repos) + 2 routing_client creates + 1
    // runner_ops create (groundnuty/macf#943) + 1 router_app create
    // (groundnuty/macf#1105, UNCONDITIONAL) + 1 ts_oauth create
    // (groundnuty/macf#1109, UNCONDITIONAL) = 16 creates. + 1 routing
    // update. `labels` (× 2 agents) + `runner_warm` (macf#942) + `runner_platform`
    // (groundnuty/macf#1211 — runs_on is self-hosted here) are
    // `'write-always'`, NOT `'create'` (groundnuty/macf#926 — see
    // `plan-item-write-always.test.ts`), so they count separately: 4.
    // `deletes`/`orphans` (groundnuty/macf#1229, DR-043 Amendment P3 row 4)
    // are 0 here — this fixture declares no `fleet.lock` at all
    // (`EMPTY_OBSERVED.lock` is `null`), so row 4 never fires (the whole
    // safety property: not-in-the-lock stays untouched).
    expect(summary).toEqual({ creates: 16, updates: 1, noops: 0, extras: 0, writeAlways: 4, deletes: 0, orphans: 0 });
  });
});

// --- planItemApplyCoverage / unimplementedByApply (groundnuty/macf#854) ---
//
// #854: `macf bootstrap plan` emitted 7 create items; `apply` delivered 3,
// failed 1 loudly, and SILENTLY skipped the other 3 (the two CA legs +
// routing). These tests pin `planItemApplyCoverage` — the single source of
// truth for "does apply actually do this" — against EVERY `PlanItemKind`,
// and pin that `computePlan` surfaces the gap via `unimplementedByApply`
// rather than silently dropping it.
//
// macf#838 Amendment D phase 2 retired the CA leg of this gap entirely (`ca`
// joined the always-implemented group, same shape `repo` did in macf#857)
// and PARTIALLY retired the routing leg: `create` is now implemented
// (apply writes MACF_TRUSTED_ACTORS when absent — macf#922 corrected the
// target from MACF_ROUTING_RUNS_ON); `update` is NOT (apply's create-only
// posture never overwrites a diverging value) — see
// `plan.ts::planItemApplyCoverage`'s routing case.

function fakeItem(kind: PlanItemKind, verb: PlanVerb): PlanItem {
  return { kind, target: `${kind}:x`, verb, reason: 'fake', confirm_required: false };
}

describe('planItemApplyCoverage — the single source of truth for what apply can/cannot action (macf#854, macf#857, macf#838 Amendment D phase 2)', () => {
  it.each<[PlanItemKind, PlanVerb]>([
    ['app', 'create'],
    ['install', 'create'],
    ['secret_fingerprint', 'create'],
    ['repo', 'noop'],
    // macf#857 (DR-043 Amendment F): apply-fleet.ts now calls
    // ensureAgentRepo for every agent before either consent gate, so
    // repo:create IS actioned — it joined the implemented group.
    ['repo', 'create'],
    // macf#838 Amendment D phase 2: apply-fleet.ts now runs the CA ceremony
    // (mint-or-reuse + two-place publish) for every fleet — `ca` items only
    // ever carry `create`/`noop` (a pure existence check, presenceVerb), so
    // the kind joined the always-implemented group entirely.
    ['ca', 'create'],
    // routing's `create` verb IS actioned (apply writes the var when
    // absent) — only `update` (a diverging value) stays not_implemented,
    // see the table below.
    ['routing', 'create'],
    // groundnuty/macf#943 — apply-fleet.ts drives the runner-ops
    // through the exact same applyIdentity gate1/gate2 primitive as an
    // 'app'/'install' item; a pure presence check (presenceVerb) so only
    // create/noop are reachable, same shape as 'ca'.
    ['runner_ops', 'create'],
  ])('%s/%s is implemented', (kind, verb) => {
    expect(planItemApplyCoverage(fakeItem(kind, verb))).toBe('implemented');
  });

  it.each<[PlanItemKind, PlanVerb]>([['routing', 'update']])('%s/%s is not_implemented', (kind, verb) => {
    expect(planItemApplyCoverage(fakeItem(kind, verb))).toBe('not_implemented');
  });

  it('noop and report-extra are ALWAYS implemented, for EVERY PlanItemKind — nothing calls for action', () => {
    const allKinds: readonly PlanItemKind[] = ['app', 'repo', 'install', 'secret_fingerprint', 'ca', 'routing', 'agent'];
    for (const kind of allKinds) {
      expect(planItemApplyCoverage(fakeItem(kind, 'noop'))).toBe('implemented');
    }
    expect(planItemApplyCoverage(fakeItem('agent', 'report-extra'))).toBe('implemented');
  });

  it('every PlanItemKind is exercised by the two tables above + the noop sweep (exhaustiveness self-check)', () => {
    const exercised = new Set<PlanItemKind>(['app', 'install', 'secret_fingerprint', 'repo', 'ca', 'routing', 'agent']);
    const allKinds: readonly PlanItemKind[] = ['app', 'repo', 'install', 'secret_fingerprint', 'ca', 'routing', 'agent'];
    for (const kind of allKinds) expect(exercised.has(kind)).toBe(true);
  });
});

describe('computePlan — unimplementedByApply (plan must not overstate what apply will do, macf#854, macf#857, macf#838 Amendment D phase 2)', () => {
  it('is EMPTY on a fresh fleet with no routing declared — CA is fully implemented now (macf#838 Amendment D phase 2), repo since macf#857', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.unimplementedByApply).toEqual([]);
  });

  it('flags a diverging routing value (update) — CA never appears, and runner_warm no longer appears either (groundnuty/macf#943 — apply now calls the runner-provisioning contract)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    expect(plan.unimplementedByApply.map((i) => i.kind)).toEqual(['routing']);
    expect(plan.unimplementedByApply[0]?.verb).toBe('update');
    for (const item of plan.unimplementedByApply) {
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.reason).not.toBe(plan.items.find((p) => p.target === item.target)?.reason);
    }
    // groundnuty/macf#1229 / DR-043 Amendment P3 — `unimplementedReasonFor`
    // now checks `item.verb === 'delete'` BEFORE its per-kind switch (see
    // that function's own doc); this pins that a `routing`/`update` item
    // still resolves through the UNCHANGED per-kind switch to its
    // pre-existing reason, not accidentally to `rowFourDelete` (verb here is
    // `'update'`, not `'delete'` — the two checks are disjoint by verb, but
    // worth asserting the VALUE, not just the shape).
    expect(plan.unimplementedByApply[0]?.reason).toBe(APPLY_UNIMPLEMENTED_REASONS.routing);
  });

  it('does NOT flag routing when it matches (noop) or is absent (create) — runner_warm no longer appears either way (groundnuty/macf#943)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const matching: ObservedState = {
      ...EMPTY_OBSERVED,
      routingTrustedActors: 'icsoc-2026-science-agent[bot] icsoc-2026-code-agent[bot]',
    };
    expect(computePlan(manifest, matching).unimplementedByApply.map((i) => i.kind)).toEqual([]);
    const absent: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: undefined };
    expect(computePlan(manifest, absent).unimplementedByApply.map((i) => i.kind)).toEqual([]);
  });

  it('NEVER flags repo — neither repo:create nor repo:noop (macf#857: ensureAgentRepo actions it)', () => {
    const manifest = baseManifest();
    const freshPlan = computePlan(manifest, EMPTY_OBSERVED);
    expect(freshPlan.unimplementedByApply.some((i) => i.kind === 'repo')).toBe(false);

    const observedRepoPresent: ObservedState = {
      lock: null,
      agents: {
        'science-agent': { app: 'unknown', install: 'unknown', repo: 'present', fingerprints: {} },
        'code-agent': { app: 'unknown', install: 'unknown', repo: 'present', fingerprints: {} },
      },
      caRegistry: 'present',
      caRepos: {
        'groundnuty/icsoc-2026-science-agent': 'present',
        'groundnuty/icsoc-2026-experiment': 'present',
      },
      controlRepoPresence: 'absent',
    };
    const noopRepoPlan = computePlan(manifest, observedRepoPresent);
    expect(noopRepoPlan.unimplementedByApply.some((i) => i.kind === 'repo')).toBe(false);
    // CA is fully present here too — nothing at all should be unimplemented.
    expect(noopRepoPlan.unimplementedByApply).toEqual([]);
  });

  it('NEVER flags ca — regardless of create or noop (macf#838 Amendment D phase 2)', () => {
    const freshPlan = computePlan(baseManifest(), EMPTY_OBSERVED); // ca items are 'create' here
    expect(freshPlan.unimplementedByApply.some((i) => i.kind === 'ca')).toBe(false);
    const observedCaPresent: ObservedState = { ...EMPTY_OBSERVED, caRegistry: 'present' }; // ca registry item is 'noop' here
    expect(computePlan(baseManifest(), observedCaPresent).unimplementedByApply.some((i) => i.kind === 'ca')).toBe(false);
  });

  it('is EMPTY on a fully-provisioned self-hosted fleet (routing matches, runner_warm implemented since groundnuty/macf#943) — every item is noop/report-extra/implemented', () => {
    const manifest = baseManifest({
      routing: { runner: { runs_on: 'self-hosted', warm: 1 } },
    });
    const observed: ObservedState = {
      lock: null,
      agents: {
        'science-agent': {
          app: 'present',
          appId: '111111',
          install: 'present',
          installId: '22222222',
          repo: 'present',
          fingerprints: { app_private_key: 'sha256:aaa' },
        },
        'code-agent': {
          app: 'present',
          appId: '333333',
          install: 'present',
          installId: '44444444',
          repo: 'present',
          fingerprints: { app_private_key: 'sha256:bbb' },
        },
      },
      caRegistry: 'present',
      caRepos: {
        'groundnuty/icsoc-2026-science-agent': 'present',
        'groundnuty/icsoc-2026-experiment': 'present',
      },
      routingTrustedActors: 'icsoc-2026-science-agent[bot] icsoc-2026-code-agent[bot]',
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    // groundnuty/macf#943 — `runner_warm` joined the always-`'implemented'`
    // group (planItemApplyCoverage), so a fully-provisioned self-hosted
    // fleet's unimplementedByApply is now EMPTY, matching the no-routing
    // fresh-fleet case above.
    expect(plan.unimplementedByApply).toEqual([]);
  });

  it('formatUnimplementedLines renders the exact loud-line shape, distinct wording from SKIPPED', () => {
    // macf#838 Amendment D phase 2 + macf#943: CA and runner_warm are both
    // fully implemented now — the remaining unimplemented case is a
    // diverging routing value.
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    const lines = formatUnimplementedLines(plan.unimplementedByApply);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^routing:.* \(update\) — NOT IMPLEMENTED BY APPLY \(.+\)$/);
    for (const line of lines) {
      expect(line).not.toContain('SKIPPED');
    }
  });

  it('formatPlanText includes the ⚠ NOT IMPLEMENTED block when unimplementedByApply is non-empty', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    const text = formatPlanText(plan);
    expect(text).toMatch(/NOT IMPLEMENTED BY APPLY/);
    expect(text).toMatch(/routing:icsoc-2026:runner/);
  });

  it('formatPlanText OMITS the NOT IMPLEMENTED block entirely when unimplementedByApply is empty', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: null,
      agents: {
        'science-agent': { app: 'unknown', install: 'unknown', repo: 'present', fingerprints: {} },
        'code-agent': { app: 'unknown', install: 'unknown', repo: 'present', fingerprints: {} },
      },
      caRegistry: 'present',
      caRepos: {
        'groundnuty/icsoc-2026-science-agent': 'present',
        'groundnuty/icsoc-2026-experiment': 'present',
      },
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    expect(plan.unimplementedByApply).toEqual([]);
    expect(formatPlanText(plan)).not.toMatch(/NOT IMPLEMENTED/);
  });
});

describe('vault-derived facts (DR-043 Amendment D phase 3) — purely additive over the vault-free reason text', () => {
  function agentItem(items: readonly PlanItem[], role: string): PlanItem | undefined {
    return itemFor(items, 'secret_fingerprint', `agent:${role}:secrets`);
  }
  function caItem(items: readonly PlanItem[]): PlanItem | undefined {
    return itemFor(items, 'ca', 'ca:registry:ICSOC_2026_CA_CERT');
  }

  it('an observation WITHOUT `vault`/`vaultCa` set (every pre-existing fixture) renders byte-identical reason text — zero regression', () => {
    const manifest = baseManifest();
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(agentItem(plan.items, 'code-agent')?.reason).toBe(
      'no fingerprints recorded in fleet.lock — agent has not been provisioned yet',
    );
    expect(caItem(plan.items)?.reason).toBe(
      'registry CA var "ICSOC_2026_CA_CERT" could not be read (auth / network / insufficient scope) — existence ' +
        'unconfirmed — treated as a create-candidate, LOW CONFIDENCE',
    );
  });

  it('a CONFIRMED vault observation appends a "present/total" suffix to the secret_fingerprint reason, WITHOUT changing the verb', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'code-agent': {
          app: 'unknown',
          install: 'unknown',
          repo: 'unknown',
          fingerprints: {},
          vault: {
            status: 'confirmed',
            presence: {
              appId: { present: true, fingerprint: 'sha256:a' },
              installId: { present: true, fingerprint: 'sha256:b' },
              clientId: { present: true, fingerprint: 'sha256:c' },
              clientSecret: { present: true, fingerprint: 'sha256:d' },
              webhookSecret: { present: false },
              privateKey: { present: false },
            },
          },
        },
      },
    };
    const plan = computePlan(manifest, observed);
    const item = agentItem(plan.items, 'code-agent');
    expect(item?.verb).toBe('create'); // lock has no fingerprints — verb is UNCHANGED by the vault fact
    expect(item?.reason).toContain('no fingerprints recorded in fleet.lock');
    expect(item?.reason).toContain('[vault: 4/6 secret fields present]');
  });

  it('an UNKNOWN vault observation appends "[vault: unknown — <reason>]", never claims presence', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'code-agent': {
          app: 'unknown',
          install: 'unknown',
          repo: 'unknown',
          fingerprints: {},
          vault: { status: 'unknown', reason: 'vault file not found at "/fake/secrets/vault.age"' },
        },
      },
    };
    const plan = computePlan(manifest, observed);
    const item = agentItem(plan.items, 'code-agent');
    expect(item?.reason).toContain('[vault: unknown — vault file not found at "/fake/secrets/vault.age"]');
  });

  it('a CONFIRMED vaultCa observation appends a suffix to the registry CA item, without changing its verb', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      caRegistry: 'present',
      vaultCa: {
        status: 'confirmed',
        presence: { caKey: { present: true, fingerprint: 'sha256:e' }, caCert: { present: true, fingerprint: 'sha256:f' } },
      },
    };
    const plan = computePlan(manifest, observed);
    const item = caItem(plan.items);
    expect(item?.verb).toBe('noop'); // caRegistry Presence still governs the verb
    expect(item?.reason).toContain('already present');
    expect(item?.reason).toContain('[vault: 2/2 CA fields present]');
  });

  it('an UNKNOWN vaultCa observation appends its reason verbatim, never a false "absent"', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      vaultCa: { status: 'unknown', reason: 'age identity key not found or not readable at "/fake/key.txt"' },
    };
    const plan = computePlan(manifest, observed);
    const item = caItem(plan.items);
    expect(item?.reason).toContain('[vault: unknown — age identity key not found or not readable at "/fake/key.txt"]');
  });

  it('vault-derived text flows through --json (fleetPlanToJson) unchanged, since it lives in PlanItem.reason', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'code-agent': {
          app: 'unknown',
          install: 'unknown',
          repo: 'unknown',
          fingerprints: {},
          vault: { status: 'unknown', reason: 'vault file not found' },
        },
      },
    };
    const plan = computePlan(manifest, observed);
    const json = fleetPlanToJson(plan) as { plan: ReadonlyArray<{ kind: string; target: string; reason: string }> };
    const item = json.plan.find((i) => i.kind === 'secret_fingerprint' && i.target === 'agent:code-agent:secrets');
    expect(item?.reason).toContain('[vault: unknown — vault file not found]');
  });
});

// --- groundnuty/macf#1310 — lock-vs-vault provisioning contradiction ---
//
// #1310's live incident: `secret_fingerprint` reported "no fingerprints
// recorded in fleet.lock — agent has not been provisioned yet" in the SAME
// sentence as "[vault: 6/6 secret fields present]" — its own refutation,
// unnoticed because the message was ASSEMBLED from two independently-honest
// probes that nothing ever checked against each other. The fix is a
// message-builder assertion (science-agent's ruling), not a new lookup —
// the lookup itself (`obs?.fingerprints`, per-agent) was already correct;
// the actual root cause of the ORIGINAL live incident was #1309's lock
// control-repo fallback, separately fixed. This describes the residual,
// general defense: whenever the two probes flatly disagree, say so as the
// HEADLINE, whatever caused it.
describe('computePlan — secret_fingerprint lock-vs-vault contradiction (groundnuty/macf#1310)', () => {
  function agentItem(items: readonly PlanItem[], role: string): PlanItem | undefined {
    return itemFor(items, 'secret_fingerprint', `agent:${role}:secrets`);
  }

  const fullVaultPresence = {
    appId: { present: true, fingerprint: 'sha256:1' },
    installId: { present: true, fingerprint: 'sha256:2' },
    clientId: { present: true, fingerprint: 'sha256:3' },
    clientSecret: { present: true, fingerprint: 'sha256:4' },
    webhookSecret: { present: true, fingerprint: 'sha256:5' },
    privateKey: { present: true, fingerprint: 'sha256:6' },
  };
  const emptyVaultPresence = {
    appId: { present: false },
    installId: { present: false },
    clientId: { present: false },
    clientSecret: { present: false },
    webhookSecret: { present: false },
    privateKey: { present: false },
  };

  // Decisive pair item 3: contradictory inputs (lock says un-provisioned,
  // vault says 6/6) → flagged, and the reason does NOT emit the
  // pre-#1310 self-refuting concatenation.
  it('DECISIVE (3a): lock says un-provisioned (0 fingerprints) + vault reports 6/6 present → flags the disagreement as the headline, confirm_required, never the self-refuting sentence', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'code-agent': {
          app: 'unknown',
          install: 'unknown',
          repo: 'unknown',
          fingerprints: {},
          vault: { status: 'confirmed', presence: fullVaultPresence },
        },
      },
    };
    const plan = computePlan(manifest, observed);
    const item = agentItem(plan.items, 'code-agent');
    expect(item?.confirm_required).toBe(true);
    expect(item?.reason).toMatch(/^fleet\.lock and the vault DISAGREE/);
    expect(item?.reason).not.toContain('agent has not been provisioned yet');
  });

  // Mirror direction — lock says provisioned, vault says nothing is there.
  it('DECISIVE (3b): lock records fingerprints + vault reports 0/6 present → ALSO flagged (mirror direction)', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'code-agent': {
          app: 'unknown',
          install: 'unknown',
          repo: 'unknown',
          fingerprints: { client_secret: 'sha256:aa' },
          vault: { status: 'confirmed', presence: emptyVaultPresence },
        },
      },
    };
    const plan = computePlan(manifest, observed);
    const item = agentItem(plan.items, 'code-agent');
    expect(item?.confirm_required).toBe(true);
    expect(item?.reason).toMatch(/^fleet\.lock and the vault DISAGREE/);
  });

  // Decisive pair item 4: consistent inputs → emits normally, unflagged —
  // pins that the new check does not fire on the ordinary, honest cases.
  it('DECISIVE (4a): consistent inputs — lock un-provisioned + vault ALSO reports 0/6 — emits the ordinary reason, NOT flagged', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'code-agent': {
          app: 'unknown',
          install: 'unknown',
          repo: 'unknown',
          fingerprints: {},
          vault: { status: 'confirmed', presence: emptyVaultPresence },
        },
      },
    };
    const plan = computePlan(manifest, observed);
    const item = agentItem(plan.items, 'code-agent');
    expect(item?.confirm_required).toBe(false);
    expect(item?.reason).toContain('no fingerprints recorded in fleet.lock — agent has not been provisioned yet');
    expect(item?.reason).toContain('[vault: 0/6 secret fields present]');
  });

  it('DECISIVE (4b): consistent inputs — lock provisioned + vault ALSO reports 6/6 — emits the ordinary noop reason, NOT flagged', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'code-agent': {
          app: 'unknown',
          install: 'unknown',
          repo: 'unknown',
          fingerprints: { client_secret: 'sha256:aa', webhook_secret: 'sha256:bb', app_private_key: 'sha256:cc' },
          vault: { status: 'confirmed', presence: fullVaultPresence },
        },
      },
    };
    const plan = computePlan(manifest, observed);
    const item = agentItem(plan.items, 'code-agent');
    expect(item?.confirm_required).toBe(false);
    expect(item?.verb).toBe('noop');
    expect(item?.reason).toContain('fingerprint(s) recorded in fleet.lock');
  });

  // Not a contradiction — a PARTIAL vault presence is genuinely ambiguous
  // (mid-provisioning, or a lock simply not yet caught up) and must NOT be
  // flagged; this is the pre-existing regression test in the "vault-derived
  // facts" block above (4/6 partial), restated here as an explicit pin
  // against over-eager flagging.
  it('a PARTIAL vault presence (neither 0 nor total) is NOT flagged as a contradiction, even against a 0-count lock', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'code-agent': {
          app: 'unknown',
          install: 'unknown',
          repo: 'unknown',
          fingerprints: {},
          vault: {
            status: 'confirmed',
            presence: { ...emptyVaultPresence, appId: { present: true, fingerprint: 'sha256:1' } },
          },
        },
      },
    };
    const plan = computePlan(manifest, observed);
    const item = agentItem(plan.items, 'code-agent');
    expect(item?.confirm_required).toBe(false);
  });

  it('an UNKNOWN vault status is never treated as a contradiction — there is nothing confirmed to disagree with', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'code-agent': {
          app: 'unknown',
          install: 'unknown',
          repo: 'unknown',
          fingerprints: {},
          vault: { status: 'unknown', reason: 'vault file not found' },
        },
      },
    };
    const plan = computePlan(manifest, observed);
    const item = agentItem(plan.items, 'code-agent');
    expect(item?.confirm_required).toBe(false);
  });

  it('no vault observation at all is never treated as a contradiction (vault-free plan run, phase-2 default)', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: { 'code-agent': { app: 'unknown', install: 'unknown', repo: 'unknown', fingerprints: {} } },
    };
    const plan = computePlan(manifest, observed);
    const item = agentItem(plan.items, 'code-agent');
    expect(item?.confirm_required).toBe(false);
  });
});

// --- DR-043 §D5 recipient-set reconciliation (groundnuty/macf#957) ---

describe('computePlan — vault_recipients item (DR-043 §D5 recipient reconciliation, macf#957)', () => {
  function recipientsItem(items: readonly PlanItem[]): PlanItem | undefined {
    return itemFor(items, 'vault_recipients', 'vault:recipients');
  }

  it('is ABSENT entirely on a vault-free run (observed.vaultRecipients undefined) — no permanent "not observed" noise line', () => {
    const manifest = baseManifest({ transport: { age_recipients: ['age1a', 'age1b'] } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(recipientsItem(plan.items)).toBeUndefined();
  });

  it('"no-vault": noop — nothing to reconcile against a vault that does not exist yet', () => {
    const manifest = baseManifest({ transport: { age_recipients: ['age1a'] } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultRecipients: { status: 'no-vault' } };
    const plan = computePlan(manifest, observed);
    const item = recipientsItem(plan.items);
    expect(item?.verb).toBe('noop');
    expect(item?.reason).toContain('no vault.age exists yet');
  });

  it('"unknown": noop, never a false match — the reason is the scrubbed VaultError message verbatim', () => {
    const manifest = baseManifest({ transport: { age_recipients: ['age1a'] } });
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      vaultRecipients: { status: 'unknown', reason: 'no "---" header-MAC line found within the first 65536 bytes' },
    };
    const plan = computePlan(manifest, observed);
    const item = recipientsItem(plan.items);
    expect(item?.verb).toBe('noop');
    expect(item?.reason).toContain('no "---" header-MAC line found within the first 65536 bytes');
    expect(item?.reason).toContain('cannot confirm'); // never claims a match it can't establish — an honest hedge, not a positive claim
  });

  it('equal counts: noop, worded as a COUNT-ONLY match — never claims a confirmed cryptographic identity match', () => {
    const manifest = baseManifest({ transport: { age_recipients: ['age1a', 'age1b'] } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultRecipients: { status: 'confirmed', stanzaCount: 2 } };
    const plan = computePlan(manifest, observed);
    const item = recipientsItem(plan.items);
    expect(item?.verb).toBe('noop');
    expect(item?.reason).toContain('count-only match');
    expect(item?.confirm_required).toBe(false);
  });

  it('a manifest declaring a recipient the vault lacks (fewer stanzas than declared): update + confirm_required — the exact AC this issue names', () => {
    const manifest = baseManifest({ transport: { age_recipients: ['age1operator', 'age1vm'] } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultRecipients: { status: 'confirmed', stanzaCount: 1 } };
    const plan = computePlan(manifest, observed);
    const item = recipientsItem(plan.items);
    expect(item?.verb).toBe('update');
    expect(item?.confirm_required).toBe(true);
    expect(item?.reason).toContain('DEFINITELY fewer');
    expect(item?.reason).toContain('--vault <path> --identity-key <path>'); // names an invocation that actually works
  });

  it('more stanzas than declared (a possible manifest shrink): update + confirm_required, but the reason explicitly warns against auto-shrinking', () => {
    const manifest = baseManifest({ transport: { age_recipients: ['age1operator'] } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultRecipients: { status: 'confirmed', stanzaCount: 2 } };
    const plan = computePlan(manifest, observed);
    const item = recipientsItem(plan.items);
    expect(item?.verb).toBe('update');
    expect(item?.confirm_required).toBe(true);
    expect(item?.reason).toContain('MORE');
    expect(item?.reason).toContain('does NOT auto-shrink');
    expect(item?.reason).toContain('REVOKE');
  });

  it('apply implements this kind — planItemApplyCoverage never flags a vault_recipients update as NOT IMPLEMENTED', () => {
    const manifest = baseManifest({ transport: { age_recipients: ['age1operator', 'age1vm'] } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultRecipients: { status: 'confirmed', stanzaCount: 1 } };
    const plan = computePlan(manifest, observed);
    const item = recipientsItem(plan.items);
    expect(item).toBeDefined();
    if (item !== undefined) {
      expect(planItemApplyCoverage(item)).toBe('implemented');
    }
    expect(plan.unimplementedByApply.some((u) => u.kind === 'vault_recipients')).toBe(false);
  });
});

// --- DR-043 Amendment G (groundnuty/macf#867) — the control-repo-archived plan item ---

describe('computePlan — control-repo-archived item (DR-043 Amendment G)', () => {
  it('is ABSENT when the control repo is not present at all', () => {
    const plan = computePlan(baseManifest(), { ...EMPTY_OBSERVED, controlRepoPresence: 'absent' });
    expect(plan.items.some((i) => i.kind === 'control_repo')).toBe(false);
  });

  it('is ABSENT when the control repo is present but NOT archived — reads as ordinary, not drift', () => {
    const plan = computePlan(baseManifest(), { ...EMPTY_OBSERVED, controlRepoPresence: 'present', controlRepoArchived: false });
    expect(plan.items.some((i) => i.kind === 'control_repo')).toBe(false);
  });

  it('is ABSENT when the archived bit could not be confirmed (present but archived undefined) — honest-unknown, never assumed archived', () => {
    const plan = computePlan(baseManifest(), { ...EMPTY_OBSERVED, controlRepoPresence: 'present' });
    expect(plan.items.some((i) => i.kind === 'control_repo')).toBe(false);
  });

  it('fires as update + confirm_required: true when present AND archived — a DELIBERATE state, not drift', () => {
    const plan = computePlan(baseManifest(), { ...EMPTY_OBSERVED, controlRepoPresence: 'present', controlRepoArchived: true });
    const item = plan.items.find((i) => i.kind === 'control_repo');
    expect(item).toBeDefined();
    expect(item?.verb).toBe('update');
    expect(item?.confirm_required).toBe(true);
    // Must read as a DELIBERATE state, never as a value mismatch — the
    // wording is the load-bearing distinction DR-043 Amendment G asks for.
    expect(item?.reason).toMatch(/ARCHIVED/);
    expect(item?.reason).toMatch(/DELIBERATE/);
    expect(item?.reason).not.toMatch(/observed .* but manifest declares/);
  });

  it('is the FIRST item in the plan — mirrors apply-fleet.ts\'s "control repo is step 0" ordering', () => {
    const plan = computePlan(baseManifest(), { ...EMPTY_OBSERVED, controlRepoPresence: 'present', controlRepoArchived: true });
    expect(plan.items[0]?.kind).toBe('control_repo');
  });

  it('planItemApplyCoverage reports IMPLEMENTED — apply DOES un-archive on approval, this must never render "NOT IMPLEMENTED BY APPLY"', () => {
    const plan = computePlan(baseManifest(), { ...EMPTY_OBSERVED, controlRepoPresence: 'present', controlRepoArchived: true });
    const item = plan.items.find((i) => i.kind === 'control_repo');
    expect(item).toBeDefined();
    if (item) expect(planItemApplyCoverage(item)).toBe('implemented');
    expect(plan.unimplementedByApply.some((i) => i.kind === 'control_repo')).toBe(false);
  });
});

// --- The runner-ops App plan item (groundnuty/macf#943) ---

// groundnuty/macf#1083 — runner-ops is now CONDITIONAL on `routing.runner.
// runs_on: self-hosted` (see the DEDICATED describe block below for that
// conditional-creation behavior itself). Every test in THIS block is about
// the identity's presence/reuse MECHANICS once it IS needed, so each one
// declares self-hosted routing explicitly — same "always needed" precondition
// `baseManifest()` used to provide for free before #1083.
function selfHostedManifest(overrides: Partial<FleetManifest> = {}): FleetManifest {
  return baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } }, ...overrides });
}

describe('computePlan — runner_ops item (groundnuty/macf#943)', () => {
  it('is present in EVERY plan where it is needed — a fleet-level item, not per-agent, never declared in fleet.yaml agents[]', () => {
    const plan = computePlan(selfHostedManifest(), EMPTY_OBSERVED);
    const items = plan.items.filter((i) => i.kind === 'runner_ops');
    expect(items).toHaveLength(1); // exactly ONE, not one per agent
  });

  it('target names the derived handle, distinct from any per-agent app item', () => {
    const plan = computePlan(selfHostedManifest(), EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item?.target).toBe('runner_ops:app:icsoc-2026-runner-ops');
  });

  it('reads UNCONFIRMABLE (no fleet.lock entry) as honest "unknown" -> LOW-CONFIDENCE create, NEVER "absent" (Amendment A4)', () => {
    const plan = computePlan(selfHostedManifest(), { ...EMPTY_OBSERVED, lock: null });
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item?.verb).toBe('create');
    expect(item?.reason).toContain(UNKNOWN_REASONS.identity);
    expect(item?.reason).not.toMatch(/\babsent\b/);
  });

  it('reads NOOP when fleet.lock already records an entry for role "runner-ops"', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role: 'runner-ops', app_id: '1', install_id: '2' }] },
    };
    const plan = computePlan(selfHostedManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item?.verb).toBe('noop');
  });

  it('a fleet.lock with entries for declared AGENTS but not the runner-ops credential still reads the runner-ops credential as create (independent presence signal)', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: {
        schema_version: 1,
        fleet: 'icsoc-2026',
        agents: [
          { role: 'science-agent', app_id: '1', install_id: '2' },
          { role: 'code-agent', app_id: '3', install_id: '4' },
        ],
      },
    };
    const plan = computePlan(selfHostedManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item?.verb).toBe('create');
  });

  it('does NOT leak into the report-extra "agent" items — a lock-only runner-ops role is never mistaken for an observed-but-undeclared coordination agent', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role: 'runner-ops', app_id: '1', install_id: '2' }] },
    };
    const plan = computePlan(selfHostedManifest(), observed);
    const extraAgentItems = plan.items.filter((i) => i.kind === 'agent' && i.verb === 'report-extra');
    expect(extraAgentItems.map((i) => i.target)).not.toContain('agent:runner-ops');
  });

  it('the reason text names the exact permission set + the DR-019 non-widening rationale, so the operator sees WHY a second App exists', () => {
    const plan = computePlan(selfHostedManifest(), EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item?.reason).toMatch(/administration:write/);
    expect(item?.reason).toMatch(/actions:read/);
    expect(item?.reason).toMatch(/metadata:read/);
    expect(item?.reason).toMatch(/administration rights/);
  });

  it('confirm_required is always false (a pure presence check — never the confirm-then-update path)', () => {
    const plan = computePlan(selfHostedManifest(), EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item?.confirm_required).toBe(false);
  });

  it('planItemApplyCoverage reports IMPLEMENTED — apply DOES drive this identity through gate1/gate2, never renders "NOT IMPLEMENTED BY APPLY"', () => {
    const plan = computePlan(selfHostedManifest(), EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item).toBeDefined();
    if (item) expect(planItemApplyCoverage(item)).toBe('implemented');
    expect(plan.unimplementedByApply.some((i) => i.kind === 'runner_ops')).toBe(false);
  });
});

// --- groundnuty/macf#1083 — runner-ops is CONDITIONAL on self-hosted ---
//
// The defect: `runnerOpsItem` used to be emitted UNCONDITIONALLY, minting an
// `administration:write` App (DR-019 quarantines that permission from every
// agent App) — plus 2 operator consent-gate clicks — for a fleet that never
// declares `routing.runner.runs_on: self-hosted`. These tests pin the fix at
// the PLAN level (see `apply-fleet.test.ts` for the APPLY-level mirror).
describe('computePlan — runner_ops is CONDITIONAL on self-hosted (groundnuty/macf#1083)', () => {
  it('DECISIVE — a hosted-runner manifest (baseManifest, no routing: block) produces a plan whose App-creation SET does NOT contain runner-ops (set membership, not a count)', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const appCreationSet = new Set(plan.items.filter((i) => (i.kind === 'app' || i.kind === 'runner_ops') && i.verb === 'create').map((i) => i.target));
    // Per `assert-the-wrong-path.md`: a bare length/count assertion cannot
    // say WHICH item is missing, and would pass even if a DIFFERENT
    // create-candidate had vanished by accident. Assert on the actual
    // target string instead.
    for (const target of appCreationSet) expect(target).not.toMatch(/^runner_ops:/);
    expect([...appCreationSet].some((t) => t.startsWith('runner_ops:'))).toBe(false);
    // And no `runner_ops`-kind item exists AT ALL (not even a noop/unknown
    // one) — a hosted fleet with no prior lock entry gets total silence on
    // this identity, matching the "nothing was promised" convention
    // `routing`/`runner_warm` already use for an undeclared `routing:`.
    expect(plan.items.some((i) => i.kind === 'runner_ops')).toBe(false);
  });

  it('DECISIVE non-regression — the SAME manifest, but SELF-HOSTED declared, still creates it', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const appCreationSet = new Set(plan.items.filter((i) => (i.kind === 'app' || i.kind === 'runner_ops') && i.verb === 'create').map((i) => i.target));
    expect([...appCreationSet].some((t) => t.startsWith('runner_ops:'))).toBe(true);
    expect(plan.items.find((i) => i.kind === 'runner_ops')?.target).toBe('runner_ops:app:icsoc-2026-runner-ops');
  });

  it('no `routing:` block at all behaves exactly like an explicitly hosted `runs_on` — same "no item" outcome', () => {
    const noRoutingDeclared = computePlan(baseManifest(), EMPTY_OBSERVED);
    const explicitlyHosted = computePlan(baseManifest({ routing: { runner: { runs_on: 'ubuntu-latest', warm: 1 } } }), EMPTY_OBSERVED);
    expect(noRoutingDeclared.items.some((i) => i.kind === 'runner_ops')).toBe(false);
    expect(explicitlyHosted.items.some((i) => i.kind === 'runner_ops')).toBe(false);
  });

  it('the click-ceiling TEXT differs between a hosted and a self-hosted manifest — not just an internal count', () => {
    const hostedPlan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const selfHostedPlan = computePlan(baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } }), EMPTY_OBSERVED);
    const hostedLine = formatOperatorInteractionLine(operatorInteractionBudget(countAppsToCreate(hostedPlan.items)));
    const selfHostedLine = formatOperatorInteractionLine(operatorInteractionBudget(countAppsToCreate(selfHostedPlan.items)));
    expect(hostedLine).not.toBe(selfHostedLine);
    // 2 agent Apps + 1 router_app (groundnuty/macf#1105, UNCONDITIONAL) = 3;
    // self-hosted adds runner-ops on top = 4.
    expect(hostedLine).toContain('3 Apps to create');
    expect(selfHostedLine).toContain('4 Apps to create');
  });

  it('later declaring self-hosted on a PREVIOUSLY-hosted fleet reads as a plain create — the SAME reuse-or-create path, no second mechanism', () => {
    // No prior lock entry for runner-ops (this fleet never created one while
    // hosted) — flipping `runs_on` to self-hosted on the next `plan`/`apply`
    // must create it THEN, via the identical `runnerOpsItem`/`applyIdentity`
    // machinery every other role uses — never a bespoke "first self-hosted
    // declaration" code path.
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item?.verb).toBe('create');
  });

  it('an ORPHAN — a prior fleet.lock entry exists but self-hosted is no longer declared — is reported explicitly, NEVER silently dropped from the plan', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-1' }] },
    };
    const plan = computePlan(baseManifest(), observed); // no routing: declared
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item).toBeDefined();
    // Reported, not deleted — apply never destroys an App (§D3 Design
    // invariant 4); a `noop` verb here means "nothing for apply to DO,"
    // never "nothing to SAY."
    expect(item?.verb).toBe('noop');
    expect(item?.reason).toMatch(/ORPHAN/);
    expect(item?.reason).toContain('icsoc-2026-runner-ops');
    expect(item?.reason).not.toMatch(/see controlRepo above/); // not an abort — a real orphan report
    // Never counted as an app-creation — an orphan costs zero clicks. 2
    // agent Apps + 1 router_app (groundnuty/macf#1105, UNCONDITIONAL,
    // `lock` here has no 'router' entry) = 3; the runner-ops orphan itself
    // contributes 0.
    expect(countAppsToCreate(plan.items)).toBe(3);
  });

  it('an orphan does NOT resurrect as a report-extra "agent" item either — same non-leak guarantee the needed-case test above already covers', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-1' }] },
    };
    const plan = computePlan(baseManifest(), observed);
    const extraAgentItems = plan.items.filter((i) => i.kind === 'agent' && i.verb === 'report-extra');
    expect(extraAgentItems.map((i) => i.target)).not.toContain('agent:runner-ops');
  });

  it('planItemApplyCoverage reports IMPLEMENTED for the orphan noop too — never renders "NOT IMPLEMENTED BY APPLY" for a status apply intentionally does not act on', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-1' }] },
    };
    const plan = computePlan(baseManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'runner_ops');
    expect(item).toBeDefined();
    if (item) expect(planItemApplyCoverage(item)).toBe('implemented');
    expect(plan.unimplementedByApply.some((i) => i.kind === 'runner_ops')).toBe(false);
  });
});

// --- groundnuty/macf#1105 — `apply` never planned the routing App, so the
// routing plane shipped unable to route. `apply-fleet.ts` reaches the router
// App's ceremony UNCONDITIONALLY (`routerAppScope === 'shared'` is the schema
// default), but `plan.ts` never rendered it — the operator's click-ceiling
// read one consent gate short of what `apply` actually opens. These tests
// pin the fix: `routerAppItem`'s presence resolution (lock then vault, per
// that function's doc) and the ceiling recompute in `countAppsToCreate`.
describe('computePlan — router App item (groundnuty/macf#1105)', () => {
  // Decisive pair (per the issue's own requirement 5: assert BOTH, because
  // either alone passes a broken implementation — a count-only assertion
  // passes if the item is mis-modelled; an item-only assertion passes if the
  // ceiling is not recomputed).
  it('DECISIVE 1/2 — a fleet with NO router App (no lock entry, no vault) yields a plan whose App-creation SET CONTAINS a router-App create item (set membership, not a count)', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    // Per `assert-the-wrong-path.md`: assert the ACTUAL target string, not
    // merely that "some item somewhere" is a create — a bare count would
    // pass even if a DIFFERENT create-candidate happened to make the
    // arithmetic work.
    const createTargets = new Set(plan.items.filter((i) => i.kind === 'router_app' && i.verb === 'create').map((i) => i.target));
    expect(createTargets.has('router_app:app:groundnuty-router')).toBe(true);
  });

  it('DECISIVE 2/2 — that SAME plan\'s click ceiling is exactly ONE HIGHER than the agent-App-alone count', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const agentAppCreateCount = plan.items.filter((i) => i.kind === 'app' && i.verb === 'create').length;
    expect(agentAppCreateCount).toBe(2); // baseManifest() declares exactly 2 agents
    expect(countAppsToCreate(plan.items)).toBe(agentAppCreateCount + 1);
  });

  it('a fleet whose VAULT carries the router App (MACF_ROUTING_APP_ID present, no lock entry) yields noop (reuse) and NO ceiling bump', () => {
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultRouterApp: { status: 'confirmed', present: true } };
    const plan = computePlan(baseManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'router_app');
    expect(item?.verb).toBe('noop');
    const agentAppCreateCount = plan.items.filter((i) => i.kind === 'app' && i.verb === 'create').length;
    expect(countAppsToCreate(plan.items)).toBe(agentAppCreateCount); // no bump — router_app contributed 0
  });

  it('a fleet.lock entry for role "router" ALSO reads present (this fleet\'s own prior create/reuse) — noop, no ceiling bump', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role: 'router', app_id: 'app-router', install_id: 'install-router' }] },
    };
    const plan = computePlan(baseManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'router_app');
    expect(item?.verb).toBe('noop');
    const agentAppCreateCount = plan.items.filter((i) => i.kind === 'app' && i.verb === 'create').length;
    expect(countAppsToCreate(plan.items)).toBe(agentAppCreateCount);
  });

  it('lock wins over a vault-confirmed-ABSENT — a lock entry is the STRONGER fact (this run\'s own prior apply already confirmed it live)', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role: 'router', app_id: 'app-router', install_id: 'install-router' }] },
      vaultRouterApp: { status: 'confirmed', present: false },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.items.find((i) => i.kind === 'router_app')?.verb).toBe('noop');
  });

  it('a vault CONFIRMED-decrypted-but-absent (no MACF_ROUTING_APP_ID) is a genuine, FULL-CONFIDENCE create — never the LOW-CONFIDENCE wording (Amendment A4: a decrypted vault is definitive, unlike an unconfirmable App JWT)', () => {
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultRouterApp: { status: 'confirmed', present: false } };
    const plan = computePlan(baseManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'router_app');
    expect(item?.verb).toBe('create');
    expect(item?.reason).toContain('missing');
    expect(item?.reason).not.toMatch(/LOW CONFIDENCE/);
  });

  it('a vault status of "unknown" (vault unreadable this run) degrades to the SAME LOW-CONFIDENCE create-candidate every other identity item uses — never a false "absent"', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      vaultRouterApp: { status: 'unknown', reason: 'vault file not found' },
    };
    const plan = computePlan(baseManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'router_app');
    expect(item?.verb).toBe('create');
    expect(item?.reason).toMatch(/LOW CONFIDENCE/);
    expect(item?.reason).not.toMatch(/\bmissing\b/);
  });

  it('router_app_scope: per-fleet still models its OWN item — fleet-name-keyed handle, distinct wording, never the owner-keyed shared one', () => {
    const manifest = baseManifest({ transport: { age_recipients: [], router_app_scope: 'per-fleet' } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'router_app');
    expect(item?.target).toBe('router_app:app:icsoc-2026-router');
    expect(item?.reason).toContain('per-fleet');
    expect(item?.reason).not.toContain('SHARED App reused');
  });

  it('router_app_scope: shared (the default, undeclared) keys the handle on OWNER account, never the fleet name — groundnuty/macf#1088', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'router_app');
    // Fleet is "icsoc-2026", owner is "groundnuty" — the handle must be
    // owner-keyed ("groundnuty-router"), NEVER fleet-keyed
    // ("icsoc-2026-router", which is what per-fleet scope derives).
    expect(item?.target).toBe('router_app:app:groundnuty-router');
    expect(item?.reason).toContain('SHARED App reused across every fleet owned by "groundnuty"');
  });

  it('is UNCONDITIONAL — present regardless of routing:/versions: declarations, unlike the CONDITIONAL runner_ops (the contrast the issue itself draws)', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED); // no routing: declared at all
    expect(plan.items.some((i) => i.kind === 'router_app')).toBe(true);
    expect(plan.items.some((i) => i.kind === 'runner_ops')).toBe(false);
  });

  it('planItemApplyCoverage reports IMPLEMENTED — this is a DISCLOSURE fix only; apply already creates this identity through the ordinary gates, unchanged', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'router_app');
    expect(item).toBeDefined();
    if (item) expect(planItemApplyCoverage(item)).toBe('implemented');
    expect(plan.unimplementedByApply.some((i) => i.kind === 'router_app')).toBe(false);
  });

  it('confirm_required is always false — a pure presence check, never the confirm-then-update path', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.items.find((i) => i.kind === 'router_app')?.confirm_required).toBe(false);
  });

  it('the existing agent-App and runner_ops items are UNCHANGED by the router-App addition (regression guard)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const appTargets = plan.items.filter((i) => i.kind === 'app').map((i) => i.target);
    expect(appTargets).toEqual([
      'agent:science-agent:app:icsoc-2026-science-agent',
      'agent:code-agent:app:icsoc-2026-code-agent',
    ]);
    const runnerOpsItem = plan.items.find((i) => i.kind === 'runner_ops');
    expect(runnerOpsItem?.target).toBe('runner_ops:app:icsoc-2026-runner-ops');
    expect(runnerOpsItem?.verb).toBe('create');
  });

  it('does NOT leak into the report-extra "agent" items — the router role is never mistaken for an observed-but-undeclared coordination agent', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role: 'router', app_id: 'app-router', install_id: 'install-router' }] },
    };
    const plan = computePlan(baseManifest(), observed);
    const extraAgentItems = plan.items.filter((i) => i.kind === 'agent' && i.verb === 'report-extra');
    expect(extraAgentItems.map((i) => i.target)).not.toContain('agent:router');
  });
});

// --- groundnuty/macf#1109 — `apply` silently asked the operator to
// hand-type TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET even when its OWN vault
// already carried them, because the read was gated on
// `transport.tailscale_oauth_required`. This item discloses the vault state
// at PLAN time so the gap is visible before approval, not from a trailing
// note. These tests pin `tsOauthItem`'s presence resolution + the "vault
// presence is checked regardless of the declared flag" invariant the
// `apply-fleet.ts` fix shares.
describe('computePlan — Tailscale OAuth item (groundnuty/macf#1109)', () => {
  it('is UNCONDITIONAL — present regardless of transport.tailscale_oauth_required, same as router_app', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED); // tailscale_oauth_required not declared
    expect(plan.items.some((i) => i.kind === 'ts_oauth')).toBe(true);
  });

  it('no vault access this run (vaultTsOauth undefined) -> LOW-CONFIDENCE create, same floor every other identity item uses', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'ts_oauth');
    expect(item?.verb).toBe('create');
    expect(item?.reason).toContain('could not be confirmed');
  });

  it('vault CONFIRMED present (both fields) -> create, states apply WILL publish, regardless of the undeclared flag', () => {
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultTsOauth: { status: 'confirmed', present: true } };
    const plan = computePlan(baseManifest(), observed); // tailscale_oauth_required NOT declared
    const item = plan.items.find((i) => i.kind === 'ts_oauth');
    expect(item?.verb).toBe('create');
    expect(item?.reason).toContain('WILL publish');
    expect(item?.reason).toContain('NOT declared'); // names the flag mismatch honestly
  });

  it('vault CONFIRMED absent + tailscale_oauth_required NOT declared -> noop, but the reason states the real routing consequence, not a bland tidy-up note', () => {
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultTsOauth: { status: 'confirmed', present: false } };
    const plan = computePlan(baseManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'ts_oauth');
    expect(item?.verb).toBe('noop');
    expect(item?.reason).toMatch(/routing will not function/i);
  });

  it('vault CONFIRMED absent + tailscale_oauth_required DECLARED true -> noop (apply writes nothing this run), reason names the refuse-before-gate-1 consequence', () => {
    const manifest = baseManifest({ transport: { age_recipients: [], tailscale_oauth_required: true } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultTsOauth: { status: 'confirmed', present: false } };
    const plan = computePlan(manifest, observed);
    const item = plan.items.find((i) => i.kind === 'ts_oauth');
    expect(item?.verb).toBe('noop');
    expect(item?.reason).toMatch(/REFUSE THE ENTIRE RUN/);
  });

  it('vault status "unknown" (unreadable this run) degrades to the SAME low-confidence create — never a false "absent"', () => {
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultTsOauth: { status: 'unknown', reason: 'vault file not found' } };
    const plan = computePlan(baseManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'ts_oauth');
    expect(item?.verb).toBe('create');
    expect(item?.reason).toContain('vault file not found');
  });

  it('planItemApplyCoverage reports IMPLEMENTED for every verb this item can emit — apply always has a code path (publish, or an honest skip/refuse)', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const item = plan.items.find((i) => i.kind === 'ts_oauth');
    expect(item).toBeDefined();
    if (item) expect(planItemApplyCoverage(item)).toBe('implemented');
    expect(plan.unimplementedByApply.some((i) => i.kind === 'ts_oauth')).toBe(false);
  });

  it('confirm_required is always false — a pure disclosure item, never the confirm-then-update path', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.items.find((i) => i.kind === 'ts_oauth')?.confirm_required).toBe(false);
  });
});

// --- groundnuty/macf#1186 — the decisive cold-start-vs-warm-scope pair.
//
// A fresh org has NO vault to read TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET from
// at all (nothing in this codebase ever WRITES the pair into one) — the
// COLD-START half below proves `plan` names the flag/env alternative before
// any gate opens. But an implementation that appends that note to EVERY
// branch unconditionally would pass the cold-start assertion too (it always
// lists everything) while training the operator to ignore the note once a
// fleet's vault genuinely already has the pair — the exact
// `assert-the-wrong-path.md` "always listing everything" trap the task
// calls out. The WARM-SCOPE half is what gives the cold-start assertion
// meaning: it proves the note is CONDITIONAL on absence, not decoration
// present regardless of outcome.
describe('computePlan — Tailscale OAuth cold-start flag/env note (groundnuty/macf#1186)', () => {
  it('cold start (no --vault/--identity-key given this run) — the ts_oauth item names the flag/env alternative BEFORE any gate opens', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED); // vaultTsOauth undefined — no vault flags given
    const item = plan.items.find((i) => i.kind === 'ts_oauth');
    expect(item?.reason).toContain(TS_OAUTH_CLIENT_ID_FLAG);
    expect(item?.reason).toContain(TS_OAUTH_SECRET_FLAG);
  });

  it('cold start, declared required — still names the flag/env alternative (the refuse-before-gate-1 case is exactly where an operator needs the escape named)', () => {
    const manifest = baseManifest({ transport: { age_recipients: [], tailscale_oauth_required: true } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultTsOauth: { status: 'confirmed', present: false } };
    const plan = computePlan(manifest, observed);
    const item = plan.items.find((i) => i.kind === 'ts_oauth');
    expect(item?.reason).toContain(TS_OAUTH_CLIENT_ID_FLAG);
  });

  it('warm scope (vault CONFIRMED present) — the note is ABSENT, not merely unread: the credential is already satisfied and has nothing left to name', () => {
    const observed: ObservedState = { ...EMPTY_OBSERVED, vaultTsOauth: { status: 'confirmed', present: true } };
    const plan = computePlan(baseManifest(), observed);
    const item = plan.items.find((i) => i.kind === 'ts_oauth');
    expect(item?.reason).not.toContain(TS_OAUTH_CLIENT_ID_FLAG);
    expect(item?.reason).not.toContain(TS_OAUTH_SECRET_FLAG);
  });
});

// groundnuty/macf#999 — `registry: { type: org }` is unsatisfiable with
// this tool's current provisioning (see `registry-scope-preflight.ts`'s
// doc). `plan` never refuses for it (read-only end to end); it states the
// fact as a loud banner instead (requirement 3). `type: profile` — every
// OTHER describe block in this file — must stay completely unaffected.
describe('computePlan — registryScopeIssues (macf#999 requirement 3: "plan states it")', () => {
  it('is empty for the type: profile default (baseManifest) — the load-bearing profile-fleet-unaffected case', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.registryScopeIssues).toEqual([]);
  });

  it('formatRegistryScopeLines([]) renders nothing', () => {
    expect(formatRegistryScopeLines([])).toEqual([]);
  });

  it('formatPlanText for a profile fleet carries NO registry banner text at all', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(formatPlanText(plan)).not.toContain('registry: UNSATISFIABLE');
  });

  it('fleetPlanToJson for a profile fleet OMITS the registry_scope_issues key entirely (not merely an empty array) — the mechanism that keeps --json byte-identical to pre-#999 output', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('registry_scope_issues' in json).toBe(false);
    // Every other key is exactly what pre-#999 `fleetPlanToJson` produced,
    // PLUS `control_repo_router_coverage` (groundnuty/macf#1348) — that
    // notice is a standing, unconditional-for-any-valid-manifest disclosure
    // (see `controlRepoRouterCoverageNotices`'s doc), so unlike every other
    // omit-when-empty key here it is NOT absent even for this minimal
    // baseManifest()/EMPTY_OBSERVED fixture. Pinned individually rather than
    // via one giant frozen full-object literal, so an unrelated future
    // change to plan-item reason text doesn't turn this into a brittle
    // snapshot test.
    expect(Object.keys(json).sort()).toEqual(
      ['control_repo_router_coverage', 'fleet', 'plan', 'schema_version', 'skipped_sections', 'summary', 'unimplemented_by_apply'].sort(),
    );
  });

  it('surfaces exactly one conflict for registry: { type: org }, naming profile scope as the working alternative and leaving the resolution open', () => {
    const manifest = baseManifest({
      owner: { account: 'demo-org', type: 'org', registry: { type: 'org', org: 'demo-org' } },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.registryScopeIssues).toHaveLength(1);
    expect(plan.registryScopeIssues[0]?.code).toBe(REGISTRY_SCOPE_UNSATISFIABLE_CODE);
    const message = plan.registryScopeIssues[0]?.message ?? '';
    expect(message).toContain('registry: { type: org, org: "demo-org" }');
    expect(message).toContain('type: profile');
    expect(message).toContain('is not yet decided');
    // groundnuty/macf#1012 requirement 4 (from the issue's original ACs,
    // carried into this codification): the org-scope refusal now ALSO
    // points at `type: repo` as a supported org-owned-fleet shape.
    expect(message).toContain('type: repo');
    expect(message).toContain('is ALSO supported today');
    // Deliberately does NOT decide #999 requirement 2 — no assertion that
    // any specific resolution ("unsupported" / "repo-scoped" / a wider
    // permission set) is the chosen fix; only that ONE exists and is named
    // as open.
  });

  it('formatRegistryScopeLines states plainly that apply WILL refuse — an exit-0 plan render must not read as "this will provision fine"', () => {
    const manifest = baseManifest({
      owner: { account: 'demo-org', type: 'org', registry: { type: 'org', org: 'demo-org' } },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const lines = formatRegistryScopeLines(plan.registryScopeIssues);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/registry: UNSATISFIABLE/);
    expect(lines[0]).toMatch(/`macf bootstrap apply` will refuse before any consent gate/);
  });

  it('formatPlanText for an org fleet carries the banner; fleetPlanToJson carries the registry_scope_issues key', () => {
    const manifest = baseManifest({
      owner: { account: 'demo-org', type: 'org', registry: { type: 'org', org: 'demo-org' } },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(formatPlanText(plan)).toContain('registry: UNSATISFIABLE');
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('registry_scope_issues' in json).toBe(true);
    expect(Array.isArray(json.registry_scope_issues)).toBe(true);
    expect((json.registry_scope_issues as unknown[]).length).toBe(1);
  });

  // groundnuty/macf#1012 requirement 4 — `type: repo` is SATISFIABLE (unlike
  // `type: org` above), so `plan` never refuses for it; it states, from the
  // manifest alone, that `apply` will verify install coverage live.
  it('is empty for the type: profile default — the load-bearing profile-fleet-unaffected case', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.registryRepoScopeNotices).toEqual([]);
  });

  it('surfaces exactly one notice for registry: { type: repo }, naming the owner/repo and that apply verifies+refuses live', () => {
    const manifest = baseManifest({
      owner: { account: 'demo-org', type: 'org', registry: { type: 'repo', owner: 'demo-org', repo: 'demo-org-registry' } },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.registryRepoScopeNotices).toHaveLength(1);
    const message = plan.registryRepoScopeNotices[0]?.message ?? '';
    expect(message).toContain('registry: { type: repo, owner: "demo-org", repo: "demo-org-registry" }');
    expect(message).toContain('demo-org/demo-org-registry');
    expect(message).toContain('and refuses, naming the App and the repo');
  });

  it('formatPlanText for a repo-scoped fleet carries a NOTICE line (never "UNSATISFIABLE" — type: repo works)', () => {
    const manifest = baseManifest({
      owner: { account: 'demo-org', type: 'org', registry: { type: 'repo', owner: 'demo-org', repo: 'demo-org-registry' } },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const text = formatPlanText(plan);
    expect(text).toContain('registry: NOTICE');
    expect(text).not.toContain('registry: UNSATISFIABLE');
  });

  it('fleetPlanToJson for a profile fleet OMITS the registry_repo_scope_notice key entirely — byte-identical to pre-#1012 output for every OTHER registry type', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('registry_repo_scope_notice' in json).toBe(false);
  });

  it('fleetPlanToJson for a repo-scoped fleet carries the registry_repo_scope_notice key', () => {
    const manifest = baseManifest({
      owner: { account: 'demo-org', type: 'org', registry: { type: 'repo', owner: 'demo-org', repo: 'demo-org-registry' } },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('registry_repo_scope_notice' in json).toBe(true);
    expect(Array.isArray(json.registry_repo_scope_notice)).toBe(true);
    expect((json.registry_repo_scope_notice as unknown[]).length).toBe(1);
  });

  it('an org-scoped fleet carries the org UNSATISFIABLE banner and NOT the repo-scope notice (the two are mutually exclusive per fleet)', () => {
    const manifest = baseManifest({
      owner: { account: 'demo-org', type: 'org', registry: { type: 'org', org: 'demo-org' } },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.registryRepoScopeNotices).toEqual([]);
  });
});

// --- groundnuty/macf#1128 — already-provisioned-fleet install-scope drift ---
//
// `ObservedAgentState.installRepositorySelection` is populated ONLY by a
// LIVE org-installations read (`observer.ts::listOrgInstallRepositorySelections`);
// these tests hand-build it directly (offline, no `gh` — same convention
// every other `computePlan` test in this file uses).
describe('computePlan installScopeDrift — already-provisioned-fleet repository_selection drift (groundnuty/macf#1128)', () => {
  it('is empty when no agent has an observed installRepositorySelection at all (org-listing unavailable, or a personal-account-owned fleet)', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.installScopeDrift).toEqual([]);
  });

  it('is empty when the observed value is "selected" — no drift, nothing to report', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, installRepositorySelection: 'selected' },
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, installRepositorySelection: 'selected' },
      },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.installScopeDrift).toEqual([]);
  });

  it('THE DECISIVE CASE: reports drift for an agent observed as "all"-scoped, naming the App handle, the observed value, and the exact remediation', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, installRepositorySelection: 'all' },
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, installRepositorySelection: 'selected' },
      },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.installScopeDrift).toHaveLength(1);
    const drift = plan.installScopeDrift[0];
    expect(drift?.role).toBe('science-agent');
    expect(drift?.appHandle).toBe('icsoc-2026-science-agent');
    expect(drift?.observed).toBe('all');
    expect(drift?.message).toContain('icsoc-2026-science-agent');
    expect(drift?.message).toMatch(/repository_selection must be "selected"/);
    expect(drift?.message).toMatch(/"all"/);
    expect(drift?.message).toMatch(/open the install page/);
    expect(drift?.message).toMatch(/Only select repositories/);
  });

  it('reports MULTIPLE drift entries — one per mis-scoped agent, not capped at one like registryScopeIssues/registryRepoScopeNotices', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, installRepositorySelection: 'all' },
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, installRepositorySelection: 'all' },
      },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.installScopeDrift).toHaveLength(2);
    expect(plan.installScopeDrift.map((d) => d.role).sort()).toEqual(['code-agent', 'science-agent']);
  });

  it('uses the SAME message-building function apply\'s post-gate-2 refusal uses (install-scope.ts::validateInstallRepositoryScope) — never a second copy', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: { 'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, installRepositorySelection: 'all' } },
    };
    const plan = computePlan({ ...baseManifest(), agents: [baseManifest().agents[0]!] }, observed);
    expect(plan.installScopeDrift[0]?.message).toBe(validateInstallRepositoryScope('all', 'icsoc-2026-science-agent'));
  });

  it('formatPlanText carries an install-scope WARNING line (not NOTICE — this is a live observed fact about an EXISTING install)', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: { 'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, installRepositorySelection: 'all' } },
    };
    const plan = computePlan(baseManifest(), observed);
    const text = formatPlanText(plan);
    expect(text).toContain('install-scope: WARNING');
    expect(text).toMatch(/repository_selection must be "selected"/);
  });

  it('formatInstallScopeDriftLines — one line per entry, "install-scope: WARNING — <message>"', () => {
    const drift: readonly InstallScopeDrift[] = [{ role: 'science-agent', appHandle: 'icsoc-2026-science-agent', observed: 'all', message: 'the refusal text' }];
    expect(formatInstallScopeDriftLines(drift)).toEqual(['install-scope: WARNING — the refusal text']);
  });

  it('fleetPlanToJson OMITS install_scope_drift entirely when empty — byte-identical to pre-#1128 output', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('install_scope_drift' in json).toBe(false);
  });

  it('fleetPlanToJson carries the install_scope_drift key when non-empty', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: { 'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, installRepositorySelection: 'all' } },
    };
    const plan = computePlan(baseManifest(), observed);
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('install_scope_drift' in json).toBe(true);
    expect(Array.isArray(json.install_scope_drift)).toBe(true);
    expect((json.install_scope_drift as unknown[]).length).toBe(1);
  });
});

// --- groundnuty/macf#1335 — plan surfaces a runner-declaration mismatch
// WITHOUT being asked. `ObservedAgentState.actionsPin`/`.routerWithKeys` are
// hand-built here (offline, no `gh` — same convention every other
// `computePlan` test in this file uses); the LIVE observer wiring that
// actually populates `routerWithKeys` from a single `gh api` read is
// exercised separately in `observer-runner-declaration.test.ts`.
describe('computePlan runnerDeclarationMismatches — self-hosted declared but the installed router cannot convey it (groundnuty/macf#1335)', () => {
  const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });

  // --- Decisive pair (assert-the-wrong-path.md — (1) alone is satisfied by
  // always emitting a row regardless of the declaration) ---

  it('1. DECISIVE: self-hosted declared + installed router with: keys cannot convey it -> a plan row names the repo and the reason, WITHOUT any --runs-on-shaped input', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, actionsPin: 'v3.4.2', routerWithKeys: ['project', 'registry-api-path'] },
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, actionsPin: 'v3.4.2', routerWithKeys: ['project', 'registry-api-path'] },
      },
    };
    const plan = computePlan(manifest, observed);
    expect(plan.runnerDeclarationMismatches).toHaveLength(2);
    const finding = plan.runnerDeclarationMismatches.find((f) => f.repo === 'groundnuty/icsoc-2026-science-agent');
    expect(finding?.verdict).toBe('not-honoured');
    expect(finding?.message).toContain('groundnuty/icsoc-2026-science-agent');
    expect(finding?.message).toContain('MACF_TRUSTED_ACTORS');

    // The RENDERED plan text — not just the array — carries the mismatch.
    const text = formatPlanText(plan);
    expect(text).toContain('runner_declaration: NOT HONOURED');
    expect(text).toContain('groundnuty/icsoc-2026-science-agent');
    expect(text).toContain('groundnuty/icsoc-2026-experiment');
  });

  it('2. DECISIVE: hosted declared -> NO row, no noise, even with observed with: keys present', () => {
    const hostedManifest = baseManifest({ routing: { runner: { runs_on: 'ubuntu-latest', warm: 1 } } });
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, actionsPin: 'v3.4.2', routerWithKeys: ['project'] },
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, actionsPin: 'v3.4.2', routerWithKeys: ['project'] },
      },
    };
    const plan = computePlan(hostedManifest, observed);
    expect(plan.runnerDeclarationMismatches).toEqual([]);
    expect(formatPlanText(plan)).not.toContain('runner_declaration');
  });

  it('routing.runner not declared at all -> no row, no noise (same as hosted)', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.runnerDeclarationMismatches).toEqual([]);
  });

  it('workflow unreadable (routerWithKeys undefined) -> an UNKNOWN row, never silence and never "consistent"', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
      },
    };
    const plan = computePlan(manifest, observed);
    expect(plan.runnerDeclarationMismatches).toHaveLength(2);
    expect(plan.runnerDeclarationMismatches.every((f) => f.verdict === 'unknown')).toBe(true);
    const text = formatPlanText(plan);
    expect(text).toContain('runner_declaration: UNKNOWN');
  });

  it('a fleet whose runner is ALREADY live and registered is STILL reported here — a live observation does not suppress this manifest-level fact, and this fact never fails the run', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: {
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, routerWithKeys: ['project'] },
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, routerWithKeys: ['project'] },
      },
      routingRunnerRegistered: 'present',
    };
    const plan = computePlan(manifest, observed);
    expect(plan.runnerDeclarationMismatches).toHaveLength(2);
    // The registration-live fact and the router-mismatch fact coexist —
    // neither item construction throws, and nothing about `computePlan`'s
    // return value signals failure (no exception, no error field).
    expect(() => formatPlanText(plan)).not.toThrow();
  });

  it('fleetPlanToJson OMITS runner_declaration_mismatches entirely when empty — byte-identical to pre-#1335 output', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('runner_declaration_mismatches' in json).toBe(false);
  });

  it('fleetPlanToJson carries the runner_declaration_mismatches key when non-empty', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: { 'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, actionsPin: 'v3.4.2', routerWithKeys: [] } },
    };
    const plan = computePlan({ ...manifest, agents: [manifest.agents[0]!] }, observed);
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('runner_declaration_mismatches' in json).toBe(true);
    expect((json.runner_declaration_mismatches as unknown[]).length).toBe(1);
  });
});

// --- groundnuty/macf#1220 / #1129 / #1229 / DR-043 Amendment P2 — row 3 of
// the reconciler verb matrix: `update` computed for a REUSED fleet-level App
// whose `selected` install set no longer covers the manifest's declared
// repos. DECISIVE PAIR (per assert-the-wrong-path.md — (1) alone is
// satisfied by emitting `update` for every entry regardless of status):
//   1. declared + present + DIFFERS (status 'drift') → PlanItem, verb
//      'update', naming the difference.
//   2. declared + present + MATCHES (status 'covered') → PlanItem, verb
//      'noop' — NOT omitted (unlike `status: 'unknown'` below), because the
//      coverage check DID run and DID confirm a match; the operator should
//      see that confirmation, not silence.
// Plus the honest-unknown floor: `status: 'unknown'` produces NO
// `'install_scope'` item at all — neither 'update' (would claim a
// confirmed diff that was never observed) nor 'noop' (would claim a
// confirmed match that was never observed). ---
describe('computePlan installScopeCoverage — row 3, update computed for a REUSED App whose install set no longer covers the manifest (groundnuty/macf#1220 / #1129 / #1229 / DR-043 Amendment P2)', () => {
  const DRIFT_ENTRY: InstallScopeCoverageEntry = {
    role: 'runner-ops',
    appHandle: 'icsoc-2026-runner-ops',
    expectedRepos: ['groundnuty/icsoc-2026-science-agent', 'groundnuty/icsoc-2026-experiment'],
    status: 'drift',
    missingRepos: ['groundnuty/icsoc-2026-experiment'],
    unverifiedRepos: [],
    message: installScopeCoverageDriftMessage('icsoc-2026-runner-ops', ['groundnuty/icsoc-2026-experiment']),
  };

  const COVERED_ENTRY: InstallScopeCoverageEntry = {
    role: 'runner-ops',
    appHandle: 'icsoc-2026-runner-ops',
    expectedRepos: ['groundnuty/icsoc-2026-science-agent', 'groundnuty/icsoc-2026-experiment'],
    status: 'covered',
    missingRepos: [],
    unverifiedRepos: [],
  };

  const UNKNOWN_ENTRY: InstallScopeCoverageEntry = {
    role: 'router',
    appHandle: 'icsoc-2026-router',
    expectedRepos: ['groundnuty/icsoc-2026-science-agent'],
    status: 'unknown',
    missingRepos: [],
    unverifiedRepos: ['groundnuty/icsoc-2026-science-agent'],
    message: 'could not confirm',
  };

  it('is empty when no coverage entries are passed (the common, vault-free `plan` run — the 3rd param defaults to [])', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.items.filter((i) => i.kind === 'install_scope')).toEqual([]);
  });

  it("THE DECISIVE CASE — status 'drift' produces a PlanItem with verb 'update', naming the difference, confirm_required true", () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED, [DRIFT_ENTRY]);
    const items = plan.items.filter((i) => i.kind === 'install_scope');
    expect(items).toHaveLength(1);
    expect(items[0]?.verb).toBe('update');
    expect(items[0]?.confirm_required).toBe(true);
    expect(items[0]?.reason).toBe(DRIFT_ENTRY.message);
    expect(items[0]?.reason).toContain('icsoc-2026-experiment');
  });

  it("status 'covered' produces a PlanItem with verb 'noop' — the check ran and confirmed a match, so it is NOT omitted", () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED, [COVERED_ENTRY]);
    const items = plan.items.filter((i) => i.kind === 'install_scope');
    expect(items).toHaveLength(1);
    expect(items[0]?.verb).toBe('noop');
    expect(items[0]?.confirm_required).toBe(false);
  });

  it("honest-unknown floor — status 'unknown' produces NO 'install_scope' item at all (neither 'update' nor 'noop')", () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED, [UNKNOWN_ENTRY]);
    const items = plan.items.filter((i) => i.kind === 'install_scope');
    expect(items).toEqual([]);
  });

  it('a resource created THIS run (an ordinary "app"/"install" item) keeps its own verb — install_scope items are additive, never replace the existence items', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED, [DRIFT_ENTRY]);
    // The existence-only items (kind 'app'/'install') are computed from
    // ObservedState exactly as before — completely independent of the new
    // 3rd parameter.
    const appItems = plan.items.filter((i) => i.kind === 'app');
    expect(appItems.length).toBeGreaterThan(0);
    for (const item of appItems) expect(item.verb).toBe('create');
    const installScopeItems = plan.items.filter((i) => i.kind === 'install_scope');
    expect(installScopeItems).toHaveLength(1);
    expect(installScopeItems[0]?.verb).toBe('update');
  });

  it('multiple entries (runner-ops drifted, router covered) — one item per entry, independently verbed', () => {
    const routerCovered: InstallScopeCoverageEntry = { ...COVERED_ENTRY, role: 'router', appHandle: 'icsoc-2026-router' };
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED, [DRIFT_ENTRY, routerCovered, UNKNOWN_ENTRY]);
    const items = plan.items.filter((i) => i.kind === 'install_scope');
    // DRIFT_ENTRY (runner-ops) -> update, routerCovered -> noop,
    // UNKNOWN_ENTRY (also role 'router', but this fixture never mixes it
    // with routerCovered in the same call) -> omitted.
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.verb).sort()).toEqual(['noop', 'update']);
  });

  it('countAppsToCreate is unaffected by install_scope items — they never carry kind app/runner_ops/router_app nor verb create', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED, [DRIFT_ENTRY]);
    const withoutCoverage = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(countAppsToCreate(plan.items)).toBe(countAppsToCreate(withoutCoverage.items));
  });

  it("planItemApplyCoverage — 'install_scope' is ALWAYS 'implemented' (the widen-gate #1232/#1233 IS apply's code path for this verb)", () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED, [DRIFT_ENTRY, COVERED_ENTRY]);
    const items = plan.items.filter((i) => i.kind === 'install_scope');
    for (const item of items) expect(planItemApplyCoverage(item)).toBe('implemented');
    expect(plan.unimplementedByApply.filter((i) => i.kind === 'install_scope')).toEqual([]);
  });

  it('fleetPlanToJson carries install_scope items generically inside `plan[]` — no special-casing needed', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED, [DRIFT_ENTRY]);
    const json = fleetPlanToJson(plan) as { plan: readonly PlanItem[] };
    const items = json.plan.filter((i) => i.kind === 'install_scope');
    expect(items).toHaveLength(1);
    expect(items[0]?.verb).toBe('update');
  });

  it('summarizePlan counts a drift item toward `updates` and a covered item toward `noops`', () => {
    const driftPlan = computePlan(baseManifest(), EMPTY_OBSERVED, [DRIFT_ENTRY]);
    const coveredPlan = computePlan(baseManifest(), EMPTY_OBSERVED, [COVERED_ENTRY]);
    const baseline = summarizePlan(computePlan(baseManifest(), EMPTY_OBSERVED).items);
    expect(summarizePlan(driftPlan.items).updates).toBe(baseline.updates + 1);
    expect(summarizePlan(coveredPlan.items).noops).toBe(baseline.noops + 1);
  });
});

// --- groundnuty/macf#1162 — the scope-credential provenance notice, the
// DECISIVE PAIR: a fleet holding a scope-level (cross-fleet-copied) router
// credential gets a standing notice naming its origin; a fleet whose router
// it genuinely owns gets NONE — otherwise the notice means nothing (per
// assert-the-wrong-path.md, the negative half is what gives the positive
// half meaning). ---
describe('computePlan scopeCredentials — router App scope-level provenance notice (groundnuty/macf#1162)', () => {
  it('is empty (and the key omitted from --json) when nothing is declared and fleet.lock carries no marker', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.scopeCredentials).toEqual([]);
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('scope_credentials' in json).toBe(false);
    expect(formatPlanText(plan)).not.toContain('scope_credential:');
  });

  it('DECISIVE 1/2: transport.router_app_origin_fleet DECLARED (no apply run yet — lock is null) -> the notice still appears, naming the origin', () => {
    const manifest = baseManifest({ transport: { age_recipients: [], router_app_origin_fleet: 'macf-fresh-1' } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.scopeCredentials).toEqual([
      { role: 'router', originFleet: 'macf-fresh-1', message: expect.stringContaining('macf-fresh-1') as unknown as string },
    ]);
    expect(plan.scopeCredentials[0]?.message).toContain('scope-level');
    expect(plan.scopeCredentials[0]?.message).toContain('held LOCALLY');
    const text = formatPlanText(plan);
    expect(text).toContain('scope_credential: NOTICE');
    expect(text).toContain('macf-fresh-1');
  });

  it('the marker in fleet.lock (declared origin at apply time) ALSO surfaces, even without a manifest declaration THIS run', () => {
    const lock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      scope_credentials: [{ role: 'router', scope: 'scope-level', held: 'locally', origin_fleet: 'macf-fresh-1', pending: 'scope-store' }],
    };
    const observed: ObservedState = { ...EMPTY_OBSERVED, lock };
    // No transport.router_app_origin_fleet declared THIS run — the lock
    // marker is the ONLY source, and it must still surface (union, not
    // lock-alone would ALSO pass this, but lock-alone alone must too).
    const plan = computePlan(baseManifest(), observed);
    expect(plan.scopeCredentials).toEqual([{ role: 'router', originFleet: 'macf-fresh-1', message: expect.any(String) as unknown as string }]);
  });

  it('undeclared origin (neither manifest nor lock names one) still renders — never silently indistinguishable from ownership', () => {
    const lock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      scope_credentials: [{ role: 'router', scope: 'scope-level', held: 'locally', pending: 'scope-store' }],
    };
    const observed: ObservedState = { ...EMPTY_OBSERVED, lock };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.scopeCredentials).toHaveLength(1);
    expect(plan.scopeCredentials[0]?.originFleet).toBeUndefined();
    expect(plan.scopeCredentials[0]?.message).toMatch(/undeclared origin fleet/);
  });

  it('DECISIVE 2/2: router_app_scope: per-fleet (genuine ownership) -> NO notice, even if router_app_origin_fleet is stray-declared', () => {
    const manifest = baseManifest({
      transport: { age_recipients: [], router_app_scope: 'per-fleet', router_app_origin_fleet: 'macf-fresh-1' },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.scopeCredentials).toEqual([]);
    expect(formatPlanText(plan)).not.toContain('scope_credential:');
  });

  it('formatScopeCredentialLines — one line per entry, "scope_credential: NOTICE — <message>"', () => {
    expect(formatScopeCredentialLines([{ role: 'router', originFleet: 'x', message: 'the provenance text' }])).toEqual(['scope_credential: NOTICE — the provenance text']);
  });

  it('scopeCredentialNotice — declared origin vs undeclared render DIFFERENT wording, not the same fallback text', () => {
    const declared = scopeCredentialNotice('router', 'origin-fleet');
    const undeclared = scopeCredentialNotice('router', undefined);
    expect(declared.message).not.toBe(undeclared.message);
    expect(declared.originFleet).toBe('origin-fleet');
    expect(undeclared.originFleet).toBeUndefined();
  });
});

// --- groundnuty/macf#1336 — per-repo routing-secret asymmetry: a fleet-level
// NOOP (`tsOauthItem`) hides a repo-level split. The DECISIVE PAIR here is
// asserted against `formatPlanText`'s RENDERED output (not just
// `plan.routingSecretAsymmetries`'s return value) — per `assert-the-wrong-path.md`,
// the mutation test that matters is one that fails when the wiring from
// `observed.routingSecretRepos` through `computePlan` through `formatPlanText`
// breaks, not merely when the underlying pure function's own logic breaks
// (that's `routing-secret-parity.test.ts`'s job). `baseManifest()`'s two
// agent repos are the "some repos" / "all repos" fixture throughout. ---
describe('computePlan routingSecretAsymmetries — per-repo routing-secret split (groundnuty/macf#1336)', () => {
  const [SCIENCE_REPO, CODE_REPO] = baseManifest().agents.map((a) => a.repo) as [string, string];

  function confirmed(...names: readonly string[]): RepoSecretNamesObservation {
    return { status: 'confirmed', names: new Set(names) };
  }

  it('is empty (and the key omitted from --json, and no line in the rendered text) when nothing was observed', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.routingSecretAsymmetries).toEqual([]);
    const json = fleetPlanToJson(plan) as Record<string, unknown>;
    expect('routing_secret_asymmetries' in json).toBe(false);
    expect(formatPlanText(plan)).not.toContain('routing_secret:');
  });

  it('DECISIVE 1/2: TS_OAUTH present on SOME repos -> the RENDERED plan text names which repo lacks it', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingSecretRepos: {
        [SCIENCE_REPO]: confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME),
        [CODE_REPO]: confirmed(), // the newer/colder repo — neither secret
      },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.routingSecretAsymmetries).toHaveLength(2); // both TS_OAUTH_CLIENT_ID and TS_OAUTH_SECRET split the same way
    const text = formatPlanText(plan);
    expect(text).toContain('routing_secret: WARNING');
    expect(text).toContain(TS_OAUTH_CLIENT_ID_SECRET_NAME);
    expect(text).toContain(CODE_REPO); // the ABSENT repo is named
    const json = fleetPlanToJson(plan) as { routing_secret_asymmetries: readonly { secretName: string; absentRepos: readonly string[] }[] };
    expect(json.routing_secret_asymmetries.find((f) => f.secretName === TS_OAUTH_CLIENT_ID_SECRET_NAME)?.absentRepos).toEqual([CODE_REPO]);
  });

  it('DECISIVE 2/2: TS_OAUTH present on ALL repos -> the rendered plan text carries NO asymmetry line — uniform is the satisfied state', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingSecretRepos: {
        [SCIENCE_REPO]: confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME),
        [CODE_REPO]: confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME),
      },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.routingSecretAsymmetries).toEqual([]);
    expect(formatPlanText(plan)).not.toContain('routing_secret:');
  });

  it('DECISIVE 2/2 (sibling): TS_OAUTH present on NONE of the repos -> NO asymmetry line — uniform absence is undeclared, not a drift, and must not render identically to a genuine split', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingSecretRepos: {
        [SCIENCE_REPO]: confirmed(),
        [CODE_REPO]: confirmed(),
      },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.routingSecretAsymmetries).toEqual([]);
    expect(formatPlanText(plan)).not.toContain('routing_secret:');
  });

  it('a repo whose secret list could not be read renders `unknown` (via the finding\'s unknownRepos) — never silently "consistent" with the confirmed repos', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingSecretRepos: {
        [SCIENCE_REPO]: confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME),
        [CODE_REPO]: { status: 'unknown', reason: 'this token cannot see "groundnuty/icsoc-2026-experiment" (HTTP 404)' },
      },
    };
    const plan = computePlan(baseManifest(), observed);
    // Only ONE confirmed repo (present) — nothing to compare against, so no
    // split is reported. But the unreadable repo must not be silently
    // absorbed as "confirmed absent" or "confirmed present" either — assert
    // that directly against the underlying observation the render is built
    // from, not just the (empty, in this branch) findings array.
    expect(plan.routingSecretAsymmetries).toEqual([]);
    expect(observed.routingSecretRepos?.[CODE_REPO]?.status).toBe('unknown');
  });

  it('ROUTING_CLIENT_CERT gets the SAME per-repo asymmetry treatment as TS_OAUTH — this is not a TS_OAUTH-only check', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingSecretRepos: {
        [SCIENCE_REPO]: confirmed(ROUTING_CLIENT_CERT_SECRET_NAME),
        [CODE_REPO]: confirmed(),
      },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.routingSecretAsymmetries.map((f) => f.secretName)).toContain(ROUTING_CLIENT_CERT_SECRET_NAME);
    expect(formatPlanText(plan)).toContain(ROUTING_CLIENT_CERT_SECRET_NAME);
  });

  it('a repo the fleet does not own is not consulted — an unrelated repo present in `routingSecretRepos` but absent from the manifest never surfaces', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingSecretRepos: {
        [SCIENCE_REPO]: confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME),
        [CODE_REPO]: confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME),
        'groundnuty/some-other-fleet-repo': confirmed(), // not one of this fleet's declared agents
      },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.routingSecretAsymmetries).toEqual([]); // both DECLARED repos are uniform; the extra repo must never be consulted
  });

  it('the rendered output never contains a secret VALUE — only names and repo identifiers', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingSecretRepos: {
        [SCIENCE_REPO]: confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME),
        [CODE_REPO]: confirmed(),
      },
    };
    const plan = computePlan(baseManifest(), observed);
    const text = formatPlanText(plan);
    expect(text).not.toMatch(/ghs_|ghp_|gho_|ghu_|-----BEGIN/);
  });

  it('formatRoutingSecretAsymmetryLines — one line per entry, "routing_secret: WARNING — <message>"', () => {
    expect(
      formatRoutingSecretAsymmetryLines([
        { secretName: TS_OAUTH_CLIENT_ID_SECRET_NAME, presentRepos: ['a'], absentRepos: ['b'], unknownRepos: [], message: 'the split text' },
      ]),
    ).toEqual(['routing_secret: WARNING — the split text']);
  });

  it('the CONTROL repo (router-carrying since #1070, not a declared agent) is consulted too — a split there is not invisible to the sweep', () => {
    const CONTROL_REPO = 'groundnuty/icsoc-2026-control';
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      routingSecretRepos: {
        [SCIENCE_REPO]: confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME),
        [CODE_REPO]: confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME),
        [CONTROL_REPO]: confirmed(), // the control repo lacks the pair — both agent repos have it
      },
    };
    const plan = computePlan(baseManifest(), observed);
    const finding = plan.routingSecretAsymmetries.find((f) => f.secretName === TS_OAUTH_CLIENT_ID_SECRET_NAME);
    expect(finding?.absentRepos).toEqual([CONTROL_REPO]);
    expect(formatPlanText(plan)).toContain(CONTROL_REPO);
  });
});

describe('computePlan controlRepoRouterCoverage — the control repo is a possible CA-cert/routing-client write target plan cannot resolve (groundnuty/macf#1348)', () => {
  const CONTROL_REPO = 'groundnuty/icsoc-2026-control';

  it('THE DECISIVE CASE: names the control repo and states the reason — a live apply-run outcome, not something plan can determine', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.controlRepoRouterCoverage).toHaveLength(1);
    const notice = plan.controlRepoRouterCoverage[0];
    expect(notice?.repo).toBe(CONTROL_REPO);
    expect(notice?.message).toContain(CONTROL_REPO);
    expect(notice?.message).toMatch(/CA cert/);
    expect(notice?.message).toMatch(/routing-client secret/);
    expect(notice?.message).toMatch(/apply-run outcome/);
  });

  it('never claims apply WILL write there — "may", never "will receive"/"will be written"/"will get"', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const notice = plan.controlRepoRouterCoverage[0];
    expect(notice?.message).toMatch(/\bmay\b/);
    expect(notice?.message).not.toMatch(/\bwill (also )?(receive|be written|get)\b/);
  });

  it('is unaffected by observed state — this is a manifest-derived possibility, not a live drift finding', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      controlRepoPresence: 'present',
      caRepos: { 'groundnuty/icsoc-2026-science-agent': 'present', 'groundnuty/icsoc-2026-experiment': 'present' },
    };
    const plan = computePlan(baseManifest(), observed);
    expect(plan.controlRepoRouterCoverage).toHaveLength(1);
    expect(plan.controlRepoRouterCoverage[0]?.repo).toBe(CONTROL_REPO);
  });

  it('formatPlanText carries a control_repo_coverage NOTICE line (not WARNING — manifest-derived heads-up, not a live observed fact)', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const text = formatPlanText(plan);
    expect(text).toContain('control_repo_coverage: NOTICE');
    expect(text).toContain(CONTROL_REPO);
  });

  it('fleetPlanToJson includes control_repo_router_coverage with the same repo/message shape', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    const json = fleetPlanToJson(plan) as { control_repo_router_coverage?: readonly ControlRepoRouterCoverage[] };
    expect(json.control_repo_router_coverage).toEqual(plan.controlRepoRouterCoverage.map((i) => ({ ...i })));
  });

  it('controlRepoRouterCoverageNotices(undefined) → [] — the decisive-pair "no control repo" arm; a hardcoded builder that ignores its argument fails this', () => {
    expect(controlRepoRouterCoverageNotices(undefined)).toEqual([]);
  });

  it('formatControlRepoRouterCoverageLines([]) → [] — no line, no noise', () => {
    expect(formatControlRepoRouterCoverageLines([])).toEqual([]);
  });

  it('formatControlRepoRouterCoverageLines — one line per entry, "control_repo_coverage: NOTICE — <message>"', () => {
    expect(formatControlRepoRouterCoverageLines([{ repo: CONTROL_REPO, message: 'the coverage text' }])).toEqual([
      'control_repo_coverage: NOTICE — the coverage text',
    ]);
  });
});

// --- Operator interaction budget (groundnuty/macf#880, DR-044 Decision 6) ---
//
// `countAppsToCreate` is a pure projection over `PlanItem[]` — these are the
// arithmetic-decisive cases: the exact numbers an operator plans a
// provisioning session around. `install`-kind items are DELIBERATELY not
// counted (gate 2 rides the same per-identity flow gate 1 opens — see
// `plan.ts`'s "Operator interaction budget" section doc) — a test below
// pins that a manifest with a declared `routing.runner` (which adds
// `routing`/`runner_warm` items, NOT app/runner_ops items) doesn't move the
// count, guarding against counting the wrong kinds.
describe('countAppsToCreate / operatorInteractionBudget (groundnuty/macf#880)', () => {
  it('DECISIVE — a fresh 2-agent HOSTED-runner fleet (baseManifest declares no routing:, EMPTY_OBSERVED): the 2 agent Apps + the UNCONDITIONAL router_app (groundnuty/macf#1105), NO runner-ops (groundnuty/macf#1083) = 3 to create', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    // Set-membership, not merely a count — proves it's specifically
    // runner-ops that's absent, not some other create-candidate that
    // happened to make the arithmetic work (see the dedicated #1083
    // describe block below for the full set-membership assertion).
    expect(plan.items.some((i) => i.kind === 'runner_ops')).toBe(false);
    expect(countAppsToCreate(plan.items)).toBe(3);
    const budget = operatorInteractionBudget(countAppsToCreate(plan.items));
    expect(budget).toEqual({ gate1Clicks: 3, gate2Flows: 3, bound: 'maximum' });
    expect(operatorInteractionToJson(budget)).toEqual({ gate1_clicks: 3, gate2_flows: 3, bound: 'maximum' });
  });

  it('DECISIVE non-regression — the SAME fresh 2-agent fleet, but SELF-HOSTED declared: 2 agent Apps + router_app + runner-ops = 4 to create (groundnuty/macf#1083 must not weaken the self-hosted path)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.items.some((i) => i.kind === 'runner_ops' && i.verb === 'create')).toBe(true);
    expect(countAppsToCreate(plan.items)).toBe(4);
    const budget = operatorInteractionBudget(countAppsToCreate(plan.items));
    expect(budget).toEqual({ gate1Clicks: 4, gate2Flows: 4, bound: 'maximum' });
    expect(operatorInteractionToJson(budget)).toEqual({ gate1_clicks: 4, gate2_flows: 4, bound: 'maximum' });
  });

  it('DECISIVE — adding one agent to an already-provisioned fleet (2 existing agents + runner-ops confirmed present, 1 new agent, no router-App lock entry): the new agent + the UNCONDITIONAL router_app (groundnuty/macf#1105) = 2 to create', () => {
    const manifest = baseManifest({
      agents: [
        // science-agent + code-agent mirror baseManifest()'s own two, kept
        // byte-identical so their `observed.agents` entries below are
        // unambiguous; new-agent is the ONE role with no observation at all.
        {
          role: 'science-agent',
          profile: 'research',
          repo: 'groundnuty/icsoc-2026-science-agent',
          deploy_path: '/home/ubuntu/repos/agh/icsoc-2026-science-agent',
        },
        {
          role: 'code-agent',
          profile: 'code',
          repo: 'groundnuty/icsoc-2026-experiment',
          deploy_path: '/home/ubuntu/repos/agh/icsoc-2026-experiment',
        },
        {
          role: 'new-agent',
          profile: 'code',
          repo: 'groundnuty/icsoc-2026-new-agent',
          deploy_path: '/home/ubuntu/repos/agh/icsoc-2026-new-agent',
        },
      ],
    });
    const observed: ObservedState = {
      lock: {
        schema_version: 1,
        fleet: 'icsoc-2026',
        agents: [
          { role: 'science-agent', app_id: 'a1', install_id: 'i1' },
          { role: 'code-agent', app_id: 'a2', install_id: 'i2' },
          { role: 'runner-ops', app_id: 'a3', install_id: 'i3' },
        ],
      },
      agents: {
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
        // 'new-agent' deliberately absent — no observation exists for it yet.
      },
      caRegistry: 'present',
      caRepos: { 'groundnuty/icsoc-2026-science-agent': 'present', 'groundnuty/icsoc-2026-experiment': 'present' },
      controlRepoPresence: 'present',
    };
    const plan = computePlan(manifest, observed);
    expect(countAppsToCreate(plan.items)).toBe(2);
    expect(operatorInteractionBudget(countAppsToCreate(plan.items))).toEqual({ gate1Clicks: 2, gate2Flows: 2, bound: 'maximum' });
  });

  it('a declared routing.runner adds exactly ONE countable create (the now-needed runner-ops, groundnuty/macf#1083) — the routing/runner_warm item KINDS themselves are never counted', () => {
    const withRouting = computePlan(baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } }), EMPTY_OBSERVED);
    const withoutRouting = computePlan(baseManifest(), EMPTY_OBSERVED);
    // Confirms the routing/runner_warm items are actually present in
    // `withRouting` (so this test would catch a regression that silently
    // dropped them), yet the count difference below is attributable
    // SOLELY to runner-ops becoming needed — never to `routing`/
    // `runner_warm` themselves being miscounted as app-creates.
    expect(withRouting.items.some((i) => i.kind === 'routing')).toBe(true);
    expect(withRouting.items.some((i) => i.kind === 'runner_warm')).toBe(true);
    expect(countAppsToCreate(withRouting.items)).toBe(countAppsToCreate(withoutRouting.items) + 1);
  });

  it('operatorInteractionBudget(0): bound "exact" — the only case with nothing left to overstate', () => {
    expect(operatorInteractionBudget(0)).toEqual({ gate1Clicks: 0, gate2Flows: 0, bound: 'exact' });
  });

  it('operatorInteractionBudget: gate2Flows defaults to gate1Clicks — the common shape every plan-only caller has (it cannot see resume-install decisions)', () => {
    expect(operatorInteractionBudget(5)).toEqual({ gate1Clicks: 5, gate2Flows: 5, bound: 'maximum' });
  });

  it('operatorInteractionBudget: a DIVERGENT pair (gate1 < gate2, e.g. a resume-install-only role) is bound "maximum" too, and NOT "exact" even if gate1 is 0', () => {
    // gate1=0 alone must NOT read as "exact" — only BOTH counts at 0 do
    // (groundnuty/macf#880: a resume-install role still needs its gate-2
    // install flow, so a fleet with only such roles is NOT zero-click).
    expect(operatorInteractionBudget(0, 1)).toEqual({ gate1Clicks: 0, gate2Flows: 1, bound: 'maximum' });
  });

  it('operatorInteractionBudget(N>0): always bound "maximum" — a counted create-candidate is never proven absent (Amendment A floor)', () => {
    expect(operatorInteractionBudget(1).bound).toBe('maximum');
    expect(operatorInteractionBudget(6).bound).toBe('maximum');
  });

  it('formatOperatorInteractionLine(0): states zero explicitly, never silence — Amendment G revival-cost property surfaced', () => {
    expect(formatOperatorInteractionLine(operatorInteractionBudget(0))).toBe('Operator interaction: none — no consent gates this run.');
  });

  it('formatOperatorInteractionLine(N>0, gate1===gate2): "up to N Apps to create", correct click/flow counts, singular for N=1, plural for N>1', () => {
    const one = formatOperatorInteractionLine(operatorInteractionBudget(1));
    expect(one).toContain('up to 1 App to create');
    expect(one).toContain('1 "Create GitHub App" click ');
    expect(one).toContain('1 install flow (');
    expect(one).not.toContain('Apps');
    expect(one).not.toContain('clicks');

    const six = formatOperatorInteractionLine(operatorInteractionBudget(6));
    expect(six).toContain('up to 6 Apps to create');
    expect(six).toContain('6 "Create GitHub App" clicks');
    expect(six).toContain('6 install flows');
    expect(six).toContain('macf bootstrap apply --vault');
    expect(six).toContain('may confirm some of these already exist and skip their gates');
  });

  // groundnuty/macf#880 — a role whose vault-aware preview decision is
  // `'resume-install'` (App exists, ZERO installs) is dropped from gate 1
  // but still costs a gate-2 install flow
  // (`apply-agent.ts::runGate2WithInterstitial`'s doc). The "N Apps to
  // create" framing above would misdescribe this — the App already exists —
  // so a DIVERGENT budget gets its own wording naming both counts directly.
  it('formatOperatorInteractionLine(gate1 !== gate2): names both counts directly, never "Apps to create" — the resume-install shape', () => {
    const line = formatOperatorInteractionLine(operatorInteractionBudget(2, 3));
    expect(line).toContain('up to 2 "Create GitHub App" clicks');
    expect(line).toContain('up to 3 install flows');
    expect(line).toContain('1 already-created App still needs its install flow');
    expect(line).not.toContain('Apps to create');
  });

  it('formatOperatorInteractionLine(gate1=0, gate2>0): still non-empty — a fleet with ONLY resume-install-shaped roles is NOT "none"', () => {
    const line = formatOperatorInteractionLine(operatorInteractionBudget(0, 1));
    expect(line).not.toBe('Operator interaction: none — no consent gates this run.');
    expect(line).toContain('0 "Create GitHub App" clicks');
    expect(line).toContain('1 install flow');
  });

  it('operatorInteractionToJson: gate1_clicks and gate2_flows are named SEPARATELY (not one field doubled) — they can diverge', () => {
    expect(operatorInteractionToJson(operatorInteractionBudget(4))).toEqual({
      gate1_clicks: 4,
      gate2_flows: 4,
      bound: 'maximum',
    });
    expect(operatorInteractionToJson(operatorInteractionBudget(2, 3))).toEqual({
      gate1_clicks: 2,
      gate2_flows: 3,
      bound: 'maximum',
    });
  });
});
