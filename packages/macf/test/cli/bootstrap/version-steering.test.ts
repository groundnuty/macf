/**
 * DR-043 §D6 — GitOps `versions:` steering, end to end at the `computePlan`
 * level (Fully offline — `ObservedState` is hand-built, same posture as
 * `plan.test.ts`; no `gh` / network involved, that's `observer.ts`'s job).
 *
 * This is the operator's ask made concrete: "a tested end-to-end mechanism
 * of running the apply, and with the change version, and the upgrade,
 * against the testing fleet." The loop below drives exactly that shape —
 * observe → plan (no drift) → declare a new target → plan (drift, named
 * remedy) → one agent goes unobservable (honest-unknown, not drift) →
 * simulate the roll landing → plan (drift clears) — plus the apply-coverage
 * assertion that `apply` never performs the roll itself (§D4: that is
 * `macf fleet upgrade`'s job, a different tool, a different privilege
 * plane).
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import {
  computePlan,
  computeUnimplementedByApply,
  formatUnimplementedLines,
  planItemApplyCoverage,
  UNKNOWN_REASONS,
  type ObservedAgentState,
  type ObservedState,
  type PlanItem,
} from '../../../src/cli/bootstrap/plan.js';

/** Same 2-agent shape as `plan.test.ts`'s `baseManifest` — no `versions:` by default. */
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
    trust: { ca: 'per-project', federated_cas: [] },
    ...overrides,
  };
}

const AGENT_A = 'science-agent';
const AGENT_B = 'code-agent';
const REPO_A = 'groundnuty/icsoc-2026-science-agent';
const REPO_B = 'groundnuty/icsoc-2026-experiment';

const VERSION_X = '0.2.44';
const VERSION_Y = '0.2.60';
const ACTIONS_PIN = 'v3.4.1'; // held constant — this loop is about `versions.macf`, not `versions.actions`.

/** Build a fully-provisioned `ObservedAgentState` (app/install/repo all present) at a given deployed version. */
function provisionedAt(deployedVersion: string | undefined, actionsPin: string | undefined = ACTIONS_PIN): ObservedAgentState {
  return { app: 'present', install: 'present', repo: 'present', fingerprints: {}, deployedVersion, actionsPin };
}

function observedBothAt(version: string | undefined): ObservedState {
  return {
    lock: null,
    agents: { [AGENT_A]: provisionedAt(version), [AGENT_B]: provisionedAt(version) },
    caRegistry: 'present',
    caRepos: { [REPO_A]: 'present', [REPO_B]: 'present' },
  };
}

function versionItemFor(items: readonly PlanItem[], role: string): PlanItem | undefined {
  return items.find((i) => i.kind === 'version' && i.target === `agent:${role}:version:macf`);
}

describe('DR-043 §D6 — versions.macf steering, the whole loop', () => {
  it('step 1 — a fleet at version X, versions.macf: X declared → NO version drift (noop for every agent)', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_X, actions: ACTIONS_PIN } });
    const observed = observedBothAt(VERSION_X);

    const plan = computePlan(manifest, observed);
    const versionItems = plan.items.filter((i) => i.kind === 'version');

    expect(versionItems).toHaveLength(2);
    for (const item of versionItems) {
      expect(item.verb).toBe('noop');
      expect(item.confirm_required).toBe(false);
      expect(item.reason).toContain(`already "${VERSION_X}"`);
    }
    // A clean plan must never claim "not implemented" for something that's
    // already converged — noop items are trivially 'implemented'
    // (planItemApplyCoverage: nothing to action).
    expect(plan.unimplementedByApply.some((i) => i.kind === 'version')).toBe(false);
  });

  it('step 2 — change the manifest to versions.macf: Y (agents still observed at X) → drift for EVERY agent, naming desired vs observed AND the fleet-upgrade remedy', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_Y, actions: ACTIONS_PIN } });
    const observed = observedBothAt(VERSION_X); // unchanged from step 1 — nothing has rolled yet

    const plan = computePlan(manifest, observed);
    const versionItems = plan.items.filter((i) => i.kind === 'version');

    expect(versionItems).toHaveLength(2);
    for (const item of versionItems) {
      expect(item.verb).toBe('update');
      expect(item.confirm_required).toBe(true); // §D3: update is ALWAYS confirm_required
      // Names BOTH the observed and the desired value — an operator reading
      // this must not have to cross-reference fleet.yaml to know what
      // changed.
      expect(item.reason).toContain(`observed "${VERSION_X}"`);
      expect(item.reason).toContain(`manifest declares "${VERSION_Y}"`);
      // Wires the disposition — apply cannot perform the roll, so the
      // reason NAMES the command that can (§D4's operational plane).
      expect(item.reason).toMatch(/macf fleet upgrade/);
      expect(item.reason).not.toMatch(/macf repo-init/); // wrong remedy — that's the actions_pin kind's, not this one's
    }
  });

  it('step 3 — one agent unobservable (version could not be read) → that agent reads UNKNOWN (create, LOW CONFIDENCE), never noop and never update; the other agent still correctly reports drift', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_Y, actions: ACTIONS_PIN } });
    const observed: ObservedState = {
      lock: null,
      agents: {
        [AGENT_A]: provisionedAt(undefined), // unreachable / no health / registry silent — genuinely unobservable
        [AGENT_B]: provisionedAt(VERSION_X), // observable, still behind
      },
      caRegistry: 'present',
      caRepos: { [REPO_A]: 'present', [REPO_B]: 'present' },
    };

    const plan = computePlan(manifest, observed);

    const unknownItem = versionItemFor(plan.items, AGENT_A);
    expect(unknownItem?.verb).toBe('create'); // NOT noop, NOT update — the only verb left once both are excluded
    expect(unknownItem?.confirm_required).toBe(false);
    expect(unknownItem?.reason).not.toContain('but manifest declares'); // never phrased as drift
    expect(unknownItem?.reason).not.toContain('already'); // never phrased as a match
    expect(unknownItem?.reason).toMatch(/not drift, not a match/);
    expect(unknownItem?.reason).toContain(UNKNOWN_REASONS.deployedVersion);

    const driftItem = versionItemFor(plan.items, AGENT_B);
    expect(driftItem?.verb).toBe('update');
    expect(driftItem?.reason).toContain(`observed "${VERSION_X}"`);
    expect(driftItem?.reason).toContain(`manifest declares "${VERSION_Y}"`);
  });

  it('step 4 — after the (simulated) roll, both agents observed at Y → drift clears (noop again)', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_Y, actions: ACTIONS_PIN } });
    // Simulates re-running `macf bootstrap plan` after an operator ran
    // `macf fleet upgrade -f fleet.yaml` and DR-037's verify-green gate
    // confirmed both agents landed on Y — i.e. a FRESH observation, not a
    // mutation of any artifact THIS tool (`bootstrap plan`) wrote itself
    // (`plan` is read-only; the write-back is `fleet upgrade`'s job as of
    // macf#907 — see `fleet-lock-recorder.test.ts` for the write→read round
    // trip THROUGH the real `composeFleetLock`/`readFleetLock` path this
    // hand-built `ObservedState` fixture deliberately bypasses here).
    const observed = observedBothAt(VERSION_Y);

    const plan = computePlan(manifest, observed);
    const versionItems = plan.items.filter((i) => i.kind === 'version');

    expect(versionItems).toHaveLength(2);
    for (const item of versionItems) {
      expect(item.verb).toBe('noop');
      expect(item.reason).toContain(`already "${VERSION_Y}"`);
    }
  });

  it('step 5 — planItemApplyCoverage reports the version kind as NOT actionable by apply, for both the drift (update) and the unknown-degrade (create) shape', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_Y, actions: ACTIONS_PIN } });
    const observed: ObservedState = {
      lock: null,
      agents: { [AGENT_A]: provisionedAt(undefined), [AGENT_B]: provisionedAt(VERSION_X) },
      caRegistry: 'present',
      caRepos: { [REPO_A]: 'present', [REPO_B]: 'present' },
    };

    const plan = computePlan(manifest, observed);
    const versionItems = plan.items.filter((i) => i.kind === 'version');
    expect(versionItems).toHaveLength(2);

    for (const item of versionItems) {
      // Direct call — the single source of truth every renderer derives from.
      expect(planItemApplyCoverage(item)).toBe('not_implemented');
    }

    // computeUnimplementedByApply / plan.unimplementedByApply are the SAME
    // computation `computePlan` already ran — assert both agree, and that
    // the reason surfaced points at the real remedy, not a generic "TODO".
    expect(computeUnimplementedByApply(plan.items)).toEqual(plan.unimplementedByApply);
    const unimplementedVersionItems = plan.unimplementedByApply.filter((i) => i.kind === 'version');
    expect(unimplementedVersionItems).toHaveLength(2);
    for (const item of unimplementedVersionItems) {
      expect(item.reason).toMatch(/macf fleet upgrade/);
    }

    // The rendered "not implemented" block — the text an operator running
    // --yes actually sees (mirrors bootstrap-apply.test.ts's CLI-level
    // assertion of the same contract via the full command).
    const lines = formatUnimplementedLines(plan.unimplementedByApply);
    expect(lines.some((l) => l.startsWith('version:') && l.includes('NOT IMPLEMENTED BY APPLY'))).toBe(true);
  });

  it('a noop-clean fleet (step 1 restated) never reports the version kind as unimplemented — "nothing to do" is not "apply won\'t do this"', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_X, actions: ACTIONS_PIN } });
    const plan = computePlan(manifest, observedBothAt(VERSION_X));
    expect(plan.unimplementedByApply).toEqual([]);
  });
});

describe('DR-043 §D6 — versions.actions steering (the caller-repos\' router pin, per repo)', () => {
  it('matches on every caller repo → noop, apply-implemented (nothing to do)', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_X, actions: ACTIONS_PIN } });
    const plan = computePlan(manifest, observedBothAt(VERSION_X));
    const pinItems = plan.items.filter((i) => i.kind === 'actions_pin');
    expect(pinItems).toHaveLength(2);
    for (const item of pinItems) {
      expect(item.verb).toBe('noop');
    }
  });

  it('diverges on ONE repo (per-repo drift, macf#806-class) → update for that repo only, naming the repo-init remedy — NOT the fleet-upgrade one', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_X, actions: 'v3.5.0' } });
    const observed: ObservedState = {
      lock: null,
      agents: {
        [AGENT_A]: provisionedAt(VERSION_X, 'v3.4.1'), // stale pin
        [AGENT_B]: provisionedAt(VERSION_X, 'v3.5.0'), // already current
      },
      caRegistry: 'present',
      caRepos: { [REPO_A]: 'present', [REPO_B]: 'present' },
    };

    const plan = computePlan(manifest, observed);
    const staleItem = plan.items.find((i) => i.kind === 'actions_pin' && i.target === `repo:${REPO_A}:version:actions`);
    const currentItem = plan.items.find((i) => i.kind === 'actions_pin' && i.target === `repo:${REPO_B}:version:actions`);

    expect(staleItem?.verb).toBe('update');
    expect(staleItem?.confirm_required).toBe(true);
    expect(staleItem?.reason).toMatch(/macf repo-init --actions-version v3\.5\.0 --force/);
    expect(staleItem?.reason).not.toMatch(/macf fleet upgrade/); // wrong remedy for this kind

    expect(currentItem?.verb).toBe('noop');

    // apply cannot rewrite agent-router.yml either — same whole-kind gap as `version`.
    expect(planItemApplyCoverage(staleItem!)).toBe('not_implemented');
  });

  it('unreadable pin (repo unreachable / no macf-actions uses: line) → unknown (create), never drift', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_X, actions: ACTIONS_PIN } });
    const observed: ObservedState = {
      lock: null,
      agents: {
        // NOTE: explicitly omitting `actionsPin` here (not passing
        // `undefined` through `provisionedAt`'s default param — a default
        // param triggers on an explicit `undefined` argument too, so
        // `provisionedAt(VERSION_X, undefined)` would silently fall back
        // to `ACTIONS_PIN` instead of staying unset).
        [AGENT_A]: { app: 'present', install: 'present', repo: 'present', fingerprints: {}, deployedVersion: VERSION_X },
        [AGENT_B]: provisionedAt(VERSION_X),
      },
      caRegistry: 'present',
      caRepos: { [REPO_A]: 'present', [REPO_B]: 'present' },
    };
    const plan = computePlan(manifest, observed);
    const item = plan.items.find((i) => i.kind === 'actions_pin' && i.target === `repo:${REPO_A}:version:actions`);
    expect(item?.verb).toBe('create');
    expect(item?.reason).toMatch(/not drift, not a match/);
    expect(item?.reason).toContain(UNKNOWN_REASONS.actionsPin);
  });
});

describe('DR-043 §D6 — versions: section gating (no silent auto-inclusion)', () => {
  it('omitting versions: entirely emits NO version / actions_pin items at all', () => {
    const manifest = baseManifest(); // no `versions:`
    const plan = computePlan(manifest, observedBothAt(VERSION_X));
    expect(plan.items.some((i) => i.kind === 'version')).toBe(false);
    expect(plan.items.some((i) => i.kind === 'actions_pin')).toBe(false);
    // And — the pre-existing contract this change must not regress —
    // `versions:` no longer appears in skippedSections when it IS declared
    // elsewhere; when it's ABSENT there is nothing to skip either way.
    expect(plan.skippedSections).toEqual([]);
  });

  it('declaring versions: emits exactly 2 items per agent (one version, one actions_pin), in manifest agent order', () => {
    const manifest = baseManifest({ versions: { macf: VERSION_X, actions: ACTIONS_PIN } });
    const plan = computePlan(manifest, observedBothAt(VERSION_X));
    const versionAndPinItems = plan.items.filter((i) => i.kind === 'version' || i.kind === 'actions_pin');
    expect(versionAndPinItems).toHaveLength(4);
    expect(versionAndPinItems.map((i) => i.target)).toEqual([
      `agent:${AGENT_A}:version:macf`,
      `repo:${REPO_A}:version:actions`,
      `agent:${AGENT_B}:version:macf`,
      `repo:${REPO_B}:version:actions`,
    ]);
  });
});
