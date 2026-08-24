/**
 * Coverage-completeness proof for `PlanItemKind` verb-reachability
 * (groundnuty/macf#926 — the post-provision verification catalog).
 *
 * Motivation (a live fault-injection sweep against a real fleet, 2026-08):
 * `plan` correctly caught a deleted `MACF_TRUSTED_ACTORS` var (`routing`:
 * `noop` -> `update`) and a downgraded router pin (`actions_pin`: `noop` ->
 * `update`) as drift. It MISSED a deleted repo label entirely — because
 * `labelsItem` emitted `verb: 'create'` UNCONDITIONALLY, so a `plan` run
 * against a repo with the label already deleted read identically to one
 * against a repo that never had it. The class-level lesson:
 *
 *   A plan-item kind whose verb is invariant over reality is not a check —
 *   it presents as covered while carrying zero information.
 *
 * This file does NOT re-test `computePlan`'s per-kind reason text or
 * ordering (that's `plan.test.ts`'s job, exhaustively, per kind). It tests
 * exactly ONE cross-cutting property, for EVERY `PlanItemKind`:
 *
 *   - kinds classified `'write-always'` (the sole two: `labels`,
 *     `runner_warm`) must be PROVEN incapable of reaching a quiet state —
 *     under a fixture where every OTHER kind reads quiet, these two still
 *     don't, and swapping in an "everything is missing" fixture doesn't
 *     change their verb either. The verb is FIXED, not merely "happened to
 *     be create in the fixtures we tried."
 *   - every OTHER kind must be PROVEN able to reach BOTH a quiet state
 *     (`'noop'`, or the item omitted entirely when omission is itself
 *     driven by the SAME observed-state input the active fixture flips —
 *     see `QUIET.control_repo`/`agent_repo_archived`/`agent` below) AND a
 *     non-quiet state (`'create'` or `'update'`) — via a REAL fixture, not
 *     an assertion about the source code's shape. "No fixture can produce
 *     a noop for this kind" is the property under test; for the two
 *     write-always kinds, the impossibility itself is the proof they
 *     belong in that set.
 *
 * `WRITE_ALWAYS_KINDS` below is an exhaustive `Record<PlanItemKind, ...>`
 * (via `classifyPlanItemKind`'s switch, no `default` case) — the SAME
 * no-default-case idiom `plan.ts::unimplementedReasonFor` already
 * establishes for this exact union (see that function's own comment: "a
 * NEW PlanItemKind added later is a compile error here, not a silent
 * pass"). A kind added to the union without being classified here fails
 * `make -f dev.mk typecheck`, not silently at runtime — the honest-unknown
 * floor applied to this check's OWN completeness, not just to what it
 * checks.
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { computePlan, type ObservedState, type PlanItem, type PlanItemKind, type PlanVerb } from '../../../src/cli/bootstrap/plan.js';

// --- Minimal, self-contained fixtures ---
//
// Deliberately NOT imported from `plan.test.ts` — this file's completeness
// claim must stand on its own, independently reviewable and immune to an
// unrelated edit drifting `plan.test.ts`'s shared `baseManifest()`/
// `EMPTY_OBSERVED` out from under it. The manifest/observed SHAPES mirror
// `plan.test.ts`'s (same schema, same `computePlan` contract) — only the
// concrete values are re-derived here, minimally, for this file's own
// per-kind proof pairs.

const FLEET = 'coverage-fleet';
const REPO = 'groundnuty/coverage-fleet-code-agent';

function manifest(overrides: Partial<FleetManifest> = {}): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: FLEET },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: [] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [{ role: 'code-agent', profile: 'code', repo: REPO, deploy_path: '/home/ubuntu/repos/agh/coverage-fleet-code-agent' }],
    trust: { ca: 'per-project', federated_cas: [] },
    ...overrides,
  };
}

/** Nothing provisioned yet — the universal "active" (non-quiet) baseline for the pure-presence kinds. */
const EMPTY: ObservedState = { lock: null, agents: {}, caRegistry: 'unknown', caRepos: {}, controlRepoPresence: 'absent' };

function itemsOf(items: readonly PlanItem[], kind: PlanItemKind): readonly PlanItem[] {
  return items.filter((i) => i.kind === kind);
}

/** True iff EVERY item of `kind` in `plan` (there may be zero) reads `'noop'` — the "quiet" predicate this file tests each checkable kind against. Zero items counts as quiet ONLY for the conditionally-emitted kinds (`control_repo`/`agent_repo_archived`/`agent`), verified per-kind below by ALSO asserting the active fixture makes the kind non-empty. */
function isQuiet(plan: ReturnType<typeof computePlan>, kind: PlanItemKind): boolean {
  const items = itemsOf(plan.items, kind);
  return items.every((i) => i.verb === 'noop');
}

/** True iff AT LEAST ONE item of `kind` calls for real action (`'create'` or `'update'`). */
function isActive(plan: ReturnType<typeof computePlan>, kind: PlanItemKind): boolean {
  return itemsOf(plan.items, kind).some((i) => i.verb === 'create' || i.verb === 'update');
}

// --- Exhaustive classification (compile-time enforced) ---

type Classification = 'write-always' | 'checkable';

/**
 * NO `default` case — mirrors `plan.ts::unimplementedReasonFor`'s own
 * exhaustiveness idiom for this exact union. Adding a new `PlanItemKind`
 * without adding a case here is a `tsc` error, not a silently-passing test.
 */
function classifyPlanItemKind(kind: PlanItemKind): Classification {
  switch (kind) {
    case 'labels':
    case 'runner_warm':
      return 'write-always';
    case 'app':
    case 'repo':
    case 'install':
    case 'secret_fingerprint':
    case 'ca':
    case 'routing':
    case 'agent':
    case 'control_repo':
    case 'agent_repo_archived':
    case 'version':
    case 'actions_pin':
    case 'routing_client':
    case 'runner_ops':
    case 'vault_recipients':
    case 'router_app':
    case 'ts_oauth':
      return 'checkable';
  }
}

const ALL_KINDS: readonly PlanItemKind[] = [
  'app',
  'repo',
  'install',
  'secret_fingerprint',
  'ca',
  'routing',
  'runner_warm',
  'agent',
  'control_repo',
  'agent_repo_archived',
  'version',
  'actions_pin',
  'labels',
  'routing_client',
  'runner_ops',
  'vault_recipients',
  'router_app',
  'ts_oauth',
];

describe('PlanItemKind coverage — every kind is classified exactly once (groundnuty/macf#926)', () => {
  it('ALL_KINDS matches classifyPlanItemKind\'s switch domain 1:1 — this list is the runtime witness for the compile-time exhaustiveness', () => {
    // `classifyPlanItemKind` throws nothing and returns a value for every
    // entry — if a NEW PlanItemKind were added to the union without a case,
    // this file would fail `tsc -b` before this test ever ran.
    for (const kind of ALL_KINDS) {
      expect(['write-always', 'checkable']).toContain(classifyPlanItemKind(kind));
    }
    // 18 kinds as of groundnuty/macf#926 (2 write-always + 16 checkable) —
    // pins the count so a kind added to ALL_KINDS-but-not-the-switch (or
    // vice versa) is caught here even though both are hand-maintained lists
    // (the switch is compile-checked against the TYPE; this asserts the
    // array is compile-checked against the SWITCH's own domain by literally
    // exercising every member).
    expect(ALL_KINDS).toHaveLength(18);
  });
});

// --- Part 1: the two write-always kinds — prove the IMPOSSIBILITY of quiet ---

describe('write-always kinds NEVER reach noop, under ANY fixture (groundnuty/macf#926)', () => {
  it('labels: verb is write-always under the EMPTIEST fixture (nothing provisioned)', () => {
    const plan = computePlan(manifest(), EMPTY);
    const items = itemsOf(plan.items, 'labels');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.verb).toBe('write-always');
  });

  it('labels: verb is STILL write-always under a fixture where EVERY OTHER kind reads noop — the decisive case', () => {
    const m = manifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = {
      lock: { schema_version: 1, fleet: FLEET, agents: [{ role: 'runner-ops', app_id: 'a', install_id: 'i' }] },
      agents: {
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: { app_private_key: 'sha256:x' } },
      },
      caRegistry: 'present',
      caRepos: { [REPO]: 'present' },
      routingClientRepos: { [REPO]: 'present' },
      routingTrustedActors: `${FLEET}-code-agent[bot]`,
      routingRunnerRegistered: 'present',
      controlRepoPresence: 'present',
      controlRepoArchived: false,
      vaultRouterApp: { status: 'confirmed', present: true },
      vaultTsOauth: { status: 'confirmed', present: false },
    };
    const plan = computePlan(m, observed);
    // Sanity: this fixture genuinely drives every OTHER checkable kind
    // quiet — otherwise "labels didn't go quiet either" would be
    // unsurprising rather than decisive.
    for (const kind of ALL_KINDS) {
      if (kind === 'labels' || kind === 'runner_warm') continue;
      expect(isQuiet(plan, kind)).toBe(true);
    }
    const items = itemsOf(plan.items, 'labels');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.verb).toBe('write-always');
  });

  it('runner_warm: verb is write-always under the emptiest fixture AND under the all-else-quiet fixture', () => {
    const emptyPlan = computePlan(manifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } }), EMPTY);
    expect(itemsOf(emptyPlan.items, 'runner_warm').map((i) => i.verb)).toEqual(['write-always']);

    const m = manifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = {
      lock: { schema_version: 1, fleet: FLEET, agents: [{ role: 'runner-ops', app_id: 'a', install_id: 'i' }] },
      agents: {
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: { app_private_key: 'sha256:x' } },
      },
      caRegistry: 'present',
      caRepos: { [REPO]: 'present' },
      routingClientRepos: { [REPO]: 'present' },
      routingTrustedActors: `${FLEET}-code-agent[bot]`,
      routingRunnerRegistered: 'present',
      controlRepoPresence: 'present',
      controlRepoArchived: false,
      vaultRouterApp: { status: 'confirmed', present: true },
      vaultTsOauth: { status: 'confirmed', present: false },
    };
    const quietPlan = computePlan(m, observed);
    expect(itemsOf(quietPlan.items, 'runner_warm').map((i) => i.verb)).toEqual(['write-always']);
  });
});

// --- Part 2: every checkable kind reaches BOTH noop/omitted AND create/update ---
//
// One `it.each` row per checkable kind. `quiet` and `active` are each a
// `(manifest, observed)` pair PROVEN (by the assertion body) to drive that
// ONE kind to the claimed state — not asserted about the source, driven
// through `computePlan` for real.

interface CoverageCase {
  readonly kind: PlanItemKind;
  readonly quiet: () => ReturnType<typeof computePlan>;
  readonly active: () => ReturnType<typeof computePlan>;
}

function presenceQuietManifest(): FleetManifest {
  return manifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
}

const PRESENCE_QUIET_OBSERVED: ObservedState = {
  lock: { schema_version: 1, fleet: FLEET, agents: [{ role: 'runner-ops', app_id: 'a', install_id: 'i' }] },
  agents: {
    'code-agent': {
      app: 'present',
      install: 'present',
      repo: 'present',
      fingerprints: { app_private_key: 'sha256:x' },
    },
  },
  caRegistry: 'present',
  caRepos: { [REPO]: 'present' },
  routingClientRepos: { [REPO]: 'present' },
  vaultRouterApp: { status: 'confirmed', present: true },
};

const PRESENCE_ACTIVE_MANIFEST = presenceQuietManifest();

const COVERAGE_CASES: readonly CoverageCase[] = [
  {
    kind: 'app',
    quiet: () => computePlan(presenceQuietManifest(), PRESENCE_QUIET_OBSERVED),
    active: () => computePlan(PRESENCE_ACTIVE_MANIFEST, EMPTY),
  },
  {
    kind: 'repo',
    quiet: () => computePlan(presenceQuietManifest(), PRESENCE_QUIET_OBSERVED),
    active: () => computePlan(PRESENCE_ACTIVE_MANIFEST, EMPTY),
  },
  {
    kind: 'install',
    quiet: () => computePlan(presenceQuietManifest(), PRESENCE_QUIET_OBSERVED),
    active: () => computePlan(PRESENCE_ACTIVE_MANIFEST, EMPTY),
  },
  {
    kind: 'secret_fingerprint',
    quiet: () => computePlan(presenceQuietManifest(), PRESENCE_QUIET_OBSERVED),
    active: () => computePlan(PRESENCE_ACTIVE_MANIFEST, EMPTY),
  },
  {
    kind: 'ca',
    quiet: () => computePlan(presenceQuietManifest(), PRESENCE_QUIET_OBSERVED),
    active: () => computePlan(PRESENCE_ACTIVE_MANIFEST, EMPTY),
  },
  {
    kind: 'routing_client',
    quiet: () => computePlan(presenceQuietManifest(), PRESENCE_QUIET_OBSERVED),
    active: () => computePlan(PRESENCE_ACTIVE_MANIFEST, EMPTY),
  },
  {
    kind: 'runner_ops',
    quiet: () => computePlan(presenceQuietManifest(), PRESENCE_QUIET_OBSERVED),
    active: () => computePlan(PRESENCE_ACTIVE_MANIFEST, EMPTY),
  },
  {
    kind: 'router_app',
    // router_app is UNCONDITIONAL — no routing: needed for it to appear.
    quiet: () => computePlan(manifest(), { ...EMPTY, vaultRouterApp: { status: 'confirmed', present: true } }),
    active: () => computePlan(manifest(), { ...EMPTY, vaultRouterApp: { status: 'confirmed', present: false } }),
  },
  {
    kind: 'ts_oauth',
    // Inverted semantics (tsOauthItem's own doc): 'noop' means the vault
    // confirms the pair is ABSENT (apply writes nothing this run); 'create'
    // means the vault confirms it PRESENT (apply WILL publish). Both are
    // real observed-state branches — this is what makes ts_oauth
    // "checkable" rather than write-always, despite the create verb never
    // meaning "verified missing" here.
    quiet: () => computePlan(manifest(), { ...EMPTY, vaultTsOauth: { status: 'confirmed', present: false } }),
    active: () => computePlan(manifest(), { ...EMPTY, vaultTsOauth: { status: 'confirmed', present: true } }),
  },
  {
    kind: 'routing',
    quiet: () =>
      computePlan(manifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } }), {
        ...EMPTY,
        routingTrustedActors: `${FLEET}-code-agent[bot]`,
      }),
    active: () =>
      computePlan(manifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } }), {
        ...EMPTY,
        routingTrustedActors: 'stale-value-that-does-not-match',
      }),
  },
  {
    kind: 'vault_recipients',
    quiet: () =>
      computePlan(manifest({ transport: { age_recipients: ['age1a', 'age1b'] } }), {
        ...EMPTY,
        vaultRecipients: { status: 'confirmed', stanzaCount: 2 },
      }),
    active: () =>
      computePlan(manifest({ transport: { age_recipients: ['age1a', 'age1b'] } }), {
        ...EMPTY,
        vaultRecipients: { status: 'confirmed', stanzaCount: 1 },
      }),
  },
  {
    kind: 'control_repo',
    // Conditionally emitted — quiet is 0 items (not archived); active is 1
    // item, verb 'update'. `isQuiet`'s `.every(...)` over an empty array is
    // vacuously true, which is exactly the "nothing to report" state this
    // kind uses omission to express (see `controlRepoItem`'s own doc:
    // "silent unless there's something to say").
    quiet: () => computePlan(manifest(), { ...EMPTY, controlRepoPresence: 'present', controlRepoArchived: false }),
    active: () => computePlan(manifest(), { ...EMPTY, controlRepoPresence: 'present', controlRepoArchived: true }),
  },
  {
    kind: 'agent_repo_archived',
    quiet: () =>
      computePlan(manifest(), {
        ...EMPTY,
        agents: { 'code-agent': { app: 'unknown', install: 'unknown', repo: 'present', fingerprints: {}, archived: false } },
      }),
    active: () =>
      computePlan(manifest(), {
        ...EMPTY,
        agents: { 'code-agent': { app: 'unknown', install: 'unknown', repo: 'present', fingerprints: {}, archived: true } },
      }),
  },
  {
    kind: 'agent',
    // report-extra — quiet is 0 items (no extra observed role); active is
    // 1 item, verb 'report-extra'. `isActive` doesn't cover report-extra
    // (by design — see its own doc), so this row's active assertion is
    // customized below rather than routed through the shared `it.each`.
    quiet: () => computePlan(manifest(), EMPTY),
    active: () => computePlan(manifest(), { ...EMPTY, agents: { 'extra-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} } } }),
  },
  {
    kind: 'version',
    quiet: () =>
      computePlan(manifest({ versions: { macf: '0.3.0', actions: 'v3.5.0' } }), {
        ...EMPTY,
        agents: { 'code-agent': { app: 'unknown', install: 'unknown', repo: 'unknown', fingerprints: {}, deployedVersion: '0.3.0' } },
      }),
    active: () =>
      computePlan(manifest({ versions: { macf: '0.3.0', actions: 'v3.5.0' } }), {
        ...EMPTY,
        agents: { 'code-agent': { app: 'unknown', install: 'unknown', repo: 'unknown', fingerprints: {}, deployedVersion: '0.1.0' } },
      }),
  },
  {
    kind: 'actions_pin',
    // `actionsVersionItem` fires TWICE per plan (once per agent repo, once
    // for the control repo — `routerCarryingRepos` always appends it,
    // unconditionally). `controlRepoActionsPin` must ALSO match here, or
    // the control-repo item alone (undefined -> 'create') breaks quiet.
    quiet: () =>
      computePlan(manifest({ versions: { macf: '0.3.0', actions: 'v3.5.0' } }), {
        ...EMPTY,
        agents: { 'code-agent': { app: 'unknown', install: 'unknown', repo: 'unknown', fingerprints: {}, actionsPin: 'v3.5.0' } },
        controlRepoActionsPin: 'v3.5.0',
      }),
    active: () =>
      computePlan(manifest({ versions: { macf: '0.3.0', actions: 'v3.5.0' } }), {
        ...EMPTY,
        agents: { 'code-agent': { app: 'unknown', install: 'unknown', repo: 'unknown', fingerprints: {}, actionsPin: 'v1.0.0' } },
      }),
  },
];

describe('checkable kinds reach BOTH noop/omitted and create/update, via a real fixture each (groundnuty/macf#926)', () => {
  it.each(COVERAGE_CASES.map((c) => [c.kind, c] as const))('%s: quiet fixture -> noop/omitted, active fixture -> create/update', (kind, testCase) => {
    if (kind === 'agent') {
      // report-extra is not a create/update action verb (see COVERAGE_CASES doc) — checked separately below.
      return;
    }
    const quietPlan = testCase.quiet();
    const activePlan = testCase.active();
    expect(isQuiet(quietPlan, kind)).toBe(true);
    expect(isActive(activePlan, kind)).toBe(true);
    // The active fixture must not have been quiet ALREADY for an unrelated
    // reason (the decisive-pair discipline: assert the SPECIFIC thing
    // changed, not merely "some item somewhere differs").
    expect(isQuiet(activePlan, kind)).toBe(false);
  });

  it('agent (report-extra): omitted when observed matches the manifest, present as report-extra when an extra role is observed', () => {
    const quietPlan = computePlan(manifest(), EMPTY);
    expect(itemsOf(quietPlan.items, 'agent')).toHaveLength(0);
    const activePlan = computePlan(manifest(), {
      ...EMPTY,
      agents: { 'extra-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} } },
    });
    const extraItems = itemsOf(activePlan.items, 'agent');
    expect(extraItems).toHaveLength(1);
    expect(extraItems[0]?.verb).toBe('report-extra');
  });
});

// --- Part 3: the honest-unknown floor applied to THIS check ---

describe('this check itself never silently passes an unclassified kind (groundnuty/macf#926)', () => {
  it('every checkable kind in ALL_KINDS (except the special-cased "agent") has a COVERAGE_CASES row — a kind with neither write-always classification nor a coverage row would be untested by BOTH describe blocks above', () => {
    const coveredKinds = new Set(COVERAGE_CASES.map((c) => c.kind));
    for (const kind of ALL_KINDS) {
      const classification = classifyPlanItemKind(kind);
      if (classification === 'write-always') continue; // proven impossible-to-quiet above instead
      expect(coveredKinds.has(kind)).toBe(true);
    }
  });

  /**
   * The reciprocal hazard (advisor-flagged): a kind falsely marked
   * `'write-always'` when it CAN actually reach `noop` would silently
   * escape BOTH checks above — Part 1 only exercises the two kinds it
   * names explicitly, and the row-presence check just skipped, doesn't
   * exercise `'write-always'`-classified kinds at all. Pinning the exact
   * SET here means adding a THIRD kind to `classifyPlanItemKind`'s
   * write-always case fails this test immediately — it does not need a
   * fixture to be caught. Demonstrated live: reclassifying `'repo'` (which
   * genuinely reaches `noop` via `presenceVerb('present')`, per the `repo`
   * row in `COVERAGE_CASES` above) as `'write-always'` in this file's own
   * switch flips this assertion to fail — the set literal below is what
   * makes that a hard failure rather than a silently-widened exemption.
   */
  it('the write-always set is EXACTLY {labels, runner_warm} — no more, no fewer', () => {
    const writeAlwaysKinds = ALL_KINDS.filter((k) => classifyPlanItemKind(k) === 'write-always');
    expect(new Set(writeAlwaysKinds)).toEqual(new Set<PlanItemKind>(['labels', 'runner_warm']));
  });

  it('mutual exclusivity: no kind is classified write-always AND ALSO carries a COVERAGE_CASES row — the two describe blocks above must partition ALL_KINDS, not overlap', () => {
    const coveredKinds = new Set(COVERAGE_CASES.map((c) => c.kind));
    for (const kind of ALL_KINDS) {
      if (classifyPlanItemKind(kind) === 'write-always') {
        expect(coveredKinds.has(kind)).toBe(false);
      }
    }
  });
});
