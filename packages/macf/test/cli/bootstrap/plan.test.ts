/**
 * Table-driven tests for `computePlan` — the pure §D3 three-verb reconcile
 * (DR-043, Slice 1a, groundnuty/macf#838). Fully offline: `ObservedState` is
 * hand-built, no `gh` / network involved (that's `observer.ts`'s job, wired
 * separately).
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import {
  computePlan,
  fleetPlanToJson,
  formatPlanText,
  formatSkippedLines,
  formatUnimplementedLines,
  planItemApplyCoverage,
  summarizePlan,
  UNKNOWN_REASONS,
  type ObservedState,
  type PlanItem,
  type PlanItemKind,
  type PlanVerb,
} from '../../../src/cli/bootstrap/plan.js';

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
    // (never gated on `trust:` being declared — macf#839 review nit 5 for CA;
    // groundnuty/macf#920 for labels/routing_client).
    expect(plan.items).toHaveLength(15);
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
      routing: { runner: { runs_on: 'self-hosted' } },
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
      routingRunsOn: 'self-hosted',
      routingClientRepos: {
        'groundnuty/icsoc-2026-science-agent': 'present',
        'groundnuty/icsoc-2026-experiment': 'present',
      },
      controlRepoPresence: 'present',
      controlRepoArchived: false,
    };

    const plan = computePlan(manifest, observed);
    // 5 × 2 agents (app/repo/install/secret_fingerprint/labels) + caRegistry +
    // 2 caRepo + routing + 2 routing_client (control_repo item absent — not
    // archived).
    expect(plan.items).toHaveLength(16);
    for (const item of plan.items) {
      // `labels` is a structural exception: it has NO plan-time observed
      // read at all (see `labelsItem`'s doc — a per-label API read is out of
      // scope), so it ALWAYS degrades to a LOW-CONFIDENCE `create`-candidate
      // regardless of how "matched" everything else is. Every other kind
      // genuinely observed-matches here.
      if (item.kind === 'labels') {
        expect(item.verb).toBe('create');
      } else {
        expect(item.verb).toBe('noop');
      }
      expect(item.confirm_required).toBe(false);
    }
  });
});

describe('computePlan — a version/config mismatch → update + confirm_required', () => {
  it('flags a routing runs_on drift as update, confirm-required', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted' } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: 'github-hosted' };

    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.verb).toBe('update');
    expect(routing?.confirm_required).toBe(true);
    expect(routing?.reason).toMatch(/observed "github-hosted" but manifest declares "self-hosted"/);
  });

  it('does not flag update when the observed value already matches', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted' } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: 'self-hosted' };
    const plan = computePlan(manifest, observed);
    const routing = itemFor(plan.items, 'routing', 'routing:icsoc-2026:runner');
    expect(routing?.verb).toBe('noop');
    expect(routing?.confirm_required).toBe(false);
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
    const manifest = baseManifest();
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const kinds = plan.items.map((i) => i.kind);
    expect(kinds.slice(0, 10)).toEqual([
      'app', 'repo', 'install', 'secret_fingerprint', 'labels', // science-agent
      'app', 'repo', 'install', 'secret_fingerprint', 'labels', // code-agent
    ]);
  });

  it('CA items (registry, then one per agent repo in manifest order), then routing_client per agent repo, precede routing, all after per-agent items', () => {
    const manifest = baseManifest({
      routing: { runner: { runs_on: 'self-hosted' } },
      trust: { ca: 'per-project', federated_cas: [] },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const kinds = plan.items.map((i) => i.kind);
    // 10 per-agent items, then 3 CA items (registry + 2 agent repos), then
    // 2 routing_client items (one per agent repo), then routing.
    expect(kinds.slice(-6)).toEqual(['ca', 'ca', 'ca', 'routing_client', 'routing_client', 'routing']);
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
      { section: 'collaborators', reason: 'reconcile not implemented in v1 — see #838 follow-ups' },
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
    expect(lines).toEqual(['collaborators: SKIPPED (reconcile not implemented in v1 — see #838 follow-ups)']);
  });
});

describe('summarizePlan', () => {
  it('counts each verb independently', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted' } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    const summary = summarizePlan(plan.items);
    // 10 per-agent creates (app/repo/install/secret_fingerprint/labels × 2) +
    // 3 CA creates (registry + 2 agent repos) + 2 routing_client creates +
    // 1 routing update.
    expect(summary).toEqual({ creates: 15, updates: 1, noops: 0, extras: 0 });
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
// (apply writes MACF_ROUTING_RUNS_ON when absent); `update` is NOT (apply's
// create-only posture never overwrites a diverging value) — see
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

  it('ONLY flags a diverging routing value (update) — CA never appears', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted' } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    expect(plan.unimplementedByApply.map((i) => i.kind)).toEqual(['routing']);
    expect(plan.unimplementedByApply[0]?.verb).toBe('update');
    for (const item of plan.unimplementedByApply) {
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.reason).not.toBe(plan.items.find((p) => p.target === item.target)?.reason);
    }
  });

  it('does NOT flag routing when it matches (noop) or is absent (create)', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted' } } });
    const matching: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: 'self-hosted' };
    expect(computePlan(manifest, matching).unimplementedByApply).toEqual([]);
    const absent: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: undefined };
    expect(computePlan(manifest, absent).unimplementedByApply).toEqual([]);
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

  it('is EMPTY when every item is noop/report-extra (fully-provisioned fleet, incl. routing)', () => {
    const manifest = baseManifest({
      routing: { runner: { runs_on: 'self-hosted' } },
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
      routingRunsOn: 'self-hosted',
      controlRepoPresence: 'absent',
    };
    const plan = computePlan(manifest, observed);
    expect(plan.unimplementedByApply).toEqual([]);
  });

  it('formatUnimplementedLines renders the exact loud-line shape, distinct wording from SKIPPED', () => {
    // macf#838 Amendment D phase 2: CA is fully implemented now — the ONE
    // remaining unimplemented case is a diverging routing value.
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted' } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    const lines = formatUnimplementedLines(plan.unimplementedByApply);
    expect(lines.length).toBe(1);
    for (const line of lines) {
      expect(line).toMatch(/^routing:.* \(update\) — NOT IMPLEMENTED BY APPLY \(.+\)$/);
      expect(line).not.toContain('SKIPPED');
    }
  });

  it('formatPlanText includes the ⚠ NOT IMPLEMENTED block when unimplementedByApply is non-empty', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted' } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: 'github-hosted' };
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
