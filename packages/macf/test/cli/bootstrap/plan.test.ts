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
  formatSkippedLines,
  summarizePlan,
  type ObservedState,
  type PlanItem,
} from '../../../src/cli/bootstrap/plan.js';

/** A minimal, valid, 2-agent manifest — no optional sections. */
function baseManifest(overrides: Partial<FleetManifest> = {}): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'icsoc-2026' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { vault_repo: 'groundnuty/icsoc-2026-science-agent', age_recipient: null },
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

/** Empty observed state — nothing provisioned yet. */
const EMPTY_OBSERVED: ObservedState = { lock: null, agents: {}, ca: 'unknown' };

function itemFor(items: readonly PlanItem[], kind: PlanItem['kind'], target: string): PlanItem | undefined {
  return items.find((i) => i.kind === kind && i.target === target);
}

describe('computePlan — all-missing manifest (fresh fleet) → all creates', () => {
  it('emits a create item for every per-agent resource, low-confidence-worded for unknown', () => {
    const manifest = baseManifest();
    const plan = computePlan(manifest, EMPTY_OBSERVED);

    // 4 items per agent (app, repo, install, secret_fingerprint) × 2 agents.
    expect(plan.items).toHaveLength(8);
    for (const item of plan.items) {
      expect(item.verb).toBe('create');
      expect(item.confirm_required).toBe(false);
    }
  });

  it('never emits a CA or routing item when neither `trust:` nor `routing:` is declared', () => {
    const plan = computePlan(baseManifest(), EMPTY_OBSERVED);
    expect(plan.items.some((i) => i.kind === 'ca')).toBe(false);
    expect(plan.items.some((i) => i.kind === 'routing')).toBe(false);
  });

  it('emits a CA create item when `trust:` IS declared but unobserved', () => {
    const manifest = baseManifest({ trust: { ca: 'per-project', federated_cas: [] } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const ca = itemFor(plan.items, 'ca', 'ca:icsoc-2026');
    expect(ca?.verb).toBe('create');
    expect(ca?.reason).toMatch(/not observable at plan time/);
  });
});

describe('computePlan — all-match observed state → all noops', () => {
  it('every per-agent resource + CA + routing is noop when fully observed-matching', () => {
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
      ca: 'present',
      routingRunsOn: 'self-hosted',
    };

    const plan = computePlan(manifest, observed);
    expect(plan.items).toHaveLength(10); // 4 × 2 agents + ca + routing
    for (const item of plan.items) {
      expect(item.verb).toBe('noop');
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
      ca: 'unknown',
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
      ca: 'unknown',
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
      ca: 'unknown',
    };
    const plan = computePlan(manifest, observed);
    const extras = plan.items.filter((i) => i.kind === 'agent').map((i) => i.target);
    expect(extras).toEqual(['agent:aaa-agent', 'agent:zzz-agent']);
  });
});

describe('computePlan — deterministic ordering', () => {
  it('orders per-agent items in manifest agents[] order, each agent app→repo→install→secret_fingerprint', () => {
    const manifest = baseManifest();
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const kinds = plan.items.map((i) => i.kind);
    expect(kinds).toEqual([
      'app', 'repo', 'install', 'secret_fingerprint', // science-agent
      'app', 'repo', 'install', 'secret_fingerprint', // code-agent
    ]);
  });

  it('CA precedes routing, both after all per-agent items', () => {
    const manifest = baseManifest({
      routing: { runner: { runs_on: 'self-hosted' } },
      trust: { ca: 'per-project', federated_cas: [] },
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const kinds = plan.items.map((i) => i.kind);
    expect(kinds.slice(-2)).toEqual(['ca', 'routing']);
  });

  it('is stable across repeated calls with the same input', () => {
    const manifest = baseManifest();
    const a = computePlan(manifest, EMPTY_OBSERVED);
    const b = computePlan(manifest, EMPTY_OBSERVED);
    expect(a.items).toEqual(b.items);
  });
});

describe('computePlan — skippedSections (declared-but-deferred sections, no silent caps)', () => {
  it('is empty when neither collaborators nor versions is declared', () => {
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

  it('surfaces versions as SKIPPED whenever declared (object section — declared = key present)', () => {
    const manifest = baseManifest({ versions: { macf: '0.2.44', actions: 'v3.4.1' } });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.skippedSections).toEqual([
      { section: 'versions', reason: 'fleet-upgrade steering is day-2 — see #838' },
    ]);
  });

  it('surfaces BOTH when both are declared, collaborators first', () => {
    const manifest = baseManifest({
      versions: { macf: '0.2.44', actions: 'v3.4.1' },
      collaborators: [
        { project: 'ppam-2026', registry: { type: 'profile', user: 'groundnuty' }, ca_bundle: 'bundles/ppam.pem' },
      ],
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    expect(plan.skippedSections.map((s) => s.section)).toEqual(['collaborators', 'versions']);
  });

  it('formatSkippedLines renders the exact loud-line shape', () => {
    const manifest = baseManifest({
      versions: { macf: '0.2.44', actions: 'v3.4.1' },
      collaborators: [
        { project: 'ppam-2026', registry: { type: 'profile', user: 'groundnuty' }, ca_bundle: 'bundles/ppam.pem' },
      ],
    });
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const lines = formatSkippedLines(plan.skippedSections);
    expect(lines).toEqual([
      'collaborators: SKIPPED (reconcile not implemented in v1 — see #838 follow-ups)',
      'versions: SKIPPED (fleet-upgrade steering is day-2 — see #838)',
    ]);
  });
});

describe('summarizePlan', () => {
  it('counts each verb independently', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted' } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: 'github-hosted' };
    const plan = computePlan(manifest, observed);
    const summary = summarizePlan(plan.items);
    // 8 per-agent creates + 1 routing update.
    expect(summary).toEqual({ creates: 8, updates: 1, noops: 0, extras: 0 });
  });
});
