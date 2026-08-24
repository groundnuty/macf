/**
 * Table-driven tests for `computePlan` — the pure §D3 three-verb reconcile
 * (DR-043, Slice 1a, groundnuty/macf#838). Fully offline: `ObservedState` is
 * hand-built, no `gh` / network involved (that's `observer.ts`'s job, wired
 * separately).
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import {
  APPLY_UNIMPLEMENTED_REASONS,
  computePlan,
  countAppsToCreate,
  fleetPlanToJson,
  formatInstallScopeDriftLines,
  formatOperatorInteractionLine,
  formatPlanText,
  formatRegistryScopeLines,
  formatSkippedLines,
  formatUnimplementedLines,
  operatorInteractionBudget,
  operatorInteractionToJson,
  planItemApplyCoverage,
  summarizePlan,
  UNKNOWN_REASONS,
  type InstallScopeDrift,
  type ObservedState,
  type PlanItem,
  type PlanItemKind,
  type PlanVerb,
} from '../../../src/cli/bootstrap/plan.js';
import { RUNNER_TOKEN_ENV_VAR, RUNNER_TOKEN_FLAG } from '../../../src/cli/bootstrap/apply-routing.js';
import { REGISTRY_SCOPE_UNSATISFIABLE_CODE } from '../../../src/cli/bootstrap/registry-scope-preflight.js';
import { validateInstallRepositoryScope } from '../../../src/cli/bootstrap/install-scope.js';

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
    // `trust` is required in the `FleetManifest` type (optional-with-default
    // at the schema level, macf#839 review nit 5) — a hand-built fixture
    // needs to supply it explicitly, unlike a `parseFleetManifest`-derived
    // one where the schema default fills it in.
    trust: { ca: 'per-project', federated_cas: [] },
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
      expect(item.verb).toBe('create');
      expect(item.confirm_required).toBe(false);
    }
  });

  it('always emits CA items (registry + one per agent repo) — unconditional, macf#839 review nit 5', () => {
    // computePlan never consults `manifest.trust`'s VALUE (there is only one
    // v0 enum member) — the CA items are unconditional on fleet identity +
    // agent repos alone. The "omitted `trust:` still gets a CA" guarantee is
    // schema-level and covered in fleet-manifest.test.ts ("trust is
    // optional-with-default"); this test covers the plan-level consequence.
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
      trust: { ca: 'per-project', federated_cas: [] },
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
    // 2 caRepo + routing + runner_warm (macf#942) + 2 routing_client + the
    // fleet-level runner_ops item (groundnuty/macf#943; control_repo item
    // absent — not archived) + the fleet-level router_app item
    // (groundnuty/macf#1105, UNCONDITIONAL) + the fleet-level ts_oauth item
    // (groundnuty/macf#1109, UNCONDITIONAL).
    expect(plan.items).toHaveLength(20);
    for (const item of plan.items) {
      // `labels` is a structural exception: it has NO plan-time observed
      // read at all (see `labelsItem`'s doc — a per-label API read is out of
      // scope), so it ALWAYS degrades to a LOW-CONFIDENCE `create`-candidate
      // regardless of how "matched" everything else is. `runner_ops`/
      // `router_app`/`ts_oauth` are the SAME shape here (groundnuty/macf#943,
      // groundnuty/macf#1105, groundnuty/macf#1109) — this test's
      // `observed.lock` is `null` (never simulated) and `vaultRouterApp`/
      // `vaultTsOauth` are unset, so their presence can only degrade to
      // `unknown` → `create`, same as `labels`. `runner_warm` (macf#942) is
      // ALWAYS `create` too — there is no live-observable "already at this
      // warm posture" signal to compare against (see `runnerWarmItem`'s
      // doc). Every other kind genuinely observed-matches here.
      if (item.kind === 'labels' || item.kind === 'runner_ops' || item.kind === 'runner_warm' || item.kind === 'router_app' || item.kind === 'ts_oauth') {
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
  // visible before approval rather than only discovered at apply time. This
  // is an UNCONDITIONAL note (plan takes no --runner-token flag of its own
  // and cannot know whether the operator already has one ready for a future
  // `apply` invocation) — never a "missing" claim, always a "required" one.

  it('always names the flag + env var when self-hosted is declared, regardless of registration status', () => {
    for (const registered of ['present', 'absent', 'unknown', undefined] as const) {
      const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
      const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunnerRegistered: registered };
      const plan = computePlan(manifest, observed);
      const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
      expect(routing?.reason).toContain(RUNNER_TOKEN_FLAG);
      expect(routing?.reason).toContain(RUNNER_TOKEN_ENV_VAR);
    }
  });

  it('also names the flag + env var on the observed-value-matches noop path (routingTrustedActors already correct)', () => {
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

  it('also names the flag + env var on the drifting-value update path', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted', routingRunnerRegistered: 'present' };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.verb).toBe('update');
    expect(routing?.reason).toContain(RUNNER_TOKEN_FLAG);
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

  it('is present as a create item, naming the declared default (1), when routing.runner is declared', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const item = warmItem(plan.items);
    expect(item?.verb).toBe('create');
    expect(item?.confirm_required).toBe(false);
    expect(item?.reason).toContain('warm: 1');
    expect(item?.reason).toContain('not yet observable or enforced by apply');
  });

  // groundnuty/macf#942 §"The decisive test" — a manifest declaring
  // `warm: 0` (a fleet explicitly declared dormant) must produce a plan
  // whose un-actioned surface says so. This is the load-bearing case: apply
  // does NOT yet enforce warm regardless of value, so a dormant fleet's
  // runner stays warm until #943 wires the contract call — the plan must
  // name that gap explicitly, not just parse the value silently.
  it('DECISIVE: warm: 0 (a dormant fleet) still emits the item, naming the dormant state in the reason, AND surfaces in unimplementedByApply', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 0 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const item = warmItem(plan.items);
    expect(item?.verb).toBe('create');
    expect(item?.reason).toContain('warm: 0');
    expect(item?.reason).toContain('this fleet is declared dormant');
    const unimplemented = plan.unimplementedByApply.find((i) => i.kind === 'runner_warm');
    expect(unimplemented).toBeDefined();
    expect(unimplemented?.target).toBe('routing:icsoc-2026:runner:warm');
    expect(unimplemented?.verb).toBe('create');
    expect(unimplemented?.reason).toBe(APPLY_UNIMPLEMENTED_REASONS.runnerWarm);
    expect(unimplemented?.reason).toContain('until that contract call is wired');
  });

  it('is NEVER implemented by apply — planItemApplyCoverage always returns not_implemented, regardless of verb (whole-kind gap, same shape as version/actions_pin)', () => {
    expect(planItemApplyCoverage(fakeItem('runner_warm', 'create'))).toBe('not_implemented');
    expect(planItemApplyCoverage(fakeItem('runner_warm', 'update'))).toBe('not_implemented');
  });

  it('noop/report-extra are still trivially implemented for runner_warm — nothing calls for action', () => {
    expect(planItemApplyCoverage(fakeItem('runner_warm', 'noop'))).toBe('implemented');
    expect(planItemApplyCoverage(fakeItem('runner_warm', 'report-extra'))).toBe('implemented');
  });

  it('the un-actioned reason names #943 as what will wire it, and never claims anything above was changed', () => {
    expect(APPLY_UNIMPLEMENTED_REASONS.runnerWarm).toContain('until that contract call is wired');
    expect(APPLY_UNIMPLEMENTED_REASONS.runnerWarm).toContain('nothing above was changed');
  });

  it('is present in EVERY plan that declares routing.runner — a fleet-level item, not per-agent', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 5 } } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const items = plan.items.filter((i) => i.kind === 'runner_warm');
    expect(items).toHaveLength(1); // exactly ONE, not one per agent
    expect(items[0]?.reason).toContain('warm: 5');
  });
});

describe('computePlan — an observed extra agent → report-extra, NEVER delete', () => {
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

  it('NO verb in the whole PlanVerb union is "delete" or "prune" — the type + every emitted item enforce it', () => {
    const manifest = baseManifest();
    const observed: ObservedState = {
      lock: null,
      agents: { 'orphan-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} } },
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    const verbsSeen = new Set(plan.items.map((i) => i.verb));
    for (const v of verbsSeen) {
      expect(['create', 'update', 'noop', 'report-extra']).toContain(v);
    }
    expect(plan.items.some((i) => (i.verb as string) === 'delete')).toBe(false);
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
      trust: { ca: 'per-project', federated_cas: [] },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const kinds = plan.items.map((i) => i.kind);
    // 10 per-agent items, then 3 CA items (registry + 2 agent repos), then
    // 2 routing_client items (one per agent repo), then routing, then
    // runner_warm (macf#942 — pushed right after routingItem).
    expect(kinds.slice(-7)).toEqual(['ca', 'ca', 'ca', 'routing_client', 'routing_client', 'routing', 'runner_warm']);
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
  it('is empty when collaborators is not declared', () => {
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
});

describe('summarizePlan', () => {
  it('counts each verb independently', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    const summary = summarizePlan(plan.items);
    // 10 per-agent creates (app/repo/install/secret_fingerprint/labels × 2) +
    // 3 CA creates (registry + 2 agent repos) + 2 routing_client creates +
    // 1 runner_ops create (groundnuty/macf#943) + 1 router_app create
    // (groundnuty/macf#1105, UNCONDITIONAL) + 1 ts_oauth create
    // (groundnuty/macf#1109, UNCONDITIONAL) + 1 runner_warm create
    // (macf#942) + 1 routing update.
    expect(summary).toEqual({ creates: 19, updates: 1, noops: 0, extras: 0 });
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

  it('flags a diverging routing value (update) AND the runner_warm posture (create, macf#942) — CA never appears', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    expect(plan.unimplementedByApply.map((i) => i.kind)).toEqual(['routing', 'runner_warm']);
    expect(plan.unimplementedByApply[0]?.verb).toBe('update');
    expect(plan.unimplementedByApply[1]?.verb).toBe('create');
    for (const item of plan.unimplementedByApply) {
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.reason).not.toBe(plan.items.find((p) => p.target === item.target)?.reason);
    }
  });

  it('does NOT flag routing when it matches (noop) or is absent (create) — runner_warm still appears regardless (macf#942: no enforcement path yet, independent of routing drift)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const matching: ObservedState = {
      ...EMPTY_OBSERVED,
      routingTrustedActors: 'icsoc-2026-science-agent[bot] icsoc-2026-code-agent[bot]',
    };
    expect(computePlan(manifest, matching).unimplementedByApply.map((i) => i.kind)).toEqual(['runner_warm']);
    const absent: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: undefined };
    expect(computePlan(manifest, absent).unimplementedByApply.map((i) => i.kind)).toEqual(['runner_warm']);
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

  it('ONLY carries runner_warm (macf#942, no enforcement path yet) when every OTHER item is noop/report-extra (fully-provisioned fleet, incl. routing)', () => {
    const manifest = baseManifest({
      routing: { runner: { runs_on: 'self-hosted', warm: 1 } },
      trust: { ca: 'per-project', federated_cas: [] },
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
    // macf#942 (DR-043 Amendment I) — runner_warm is a whole-kind gap
    // (planItemApplyCoverage's 'runner_warm' case), so it stays un-actioned
    // even when routing itself fully matches (noop) — every OTHER kind here
    // is genuinely implemented-or-noop.
    expect(plan.unimplementedByApply.map((i) => i.kind)).toEqual(['runner_warm']);
  });

  it('formatUnimplementedLines renders the exact loud-line shape, distinct wording from SKIPPED', () => {
    // macf#838 Amendment D phase 2 + macf#942: CA is fully implemented now —
    // the two remaining unimplemented cases are a diverging routing value and
    // the not-yet-enforced runner_warm posture.
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    const lines = formatUnimplementedLines(plan.unimplementedByApply);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^routing:.* \(update\) — NOT IMPLEMENTED BY APPLY \(.+\)$/);
    expect(lines[1]).toMatch(/^runner_warm:.* \(create\) — NOT IMPLEMENTED BY APPLY \(.+\)$/);
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
    // Every other key is exactly what pre-#999 `fleetPlanToJson` produced —
    // pinned individually rather than via one giant frozen full-object
    // literal, so an unrelated future change to plan-item reason text
    // doesn't turn this into a brittle snapshot test.
    expect(Object.keys(json).sort()).toEqual(
      ['fleet', 'plan', 'schema_version', 'skipped_sections', 'summary', 'unimplemented_by_apply'].sort(),
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
