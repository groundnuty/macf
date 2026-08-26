/**
 * Tests for `status.ts` — the pure `macf bootstrap status` render
 * (groundnuty/macf#1017). Fully offline: `ObservedState` + the registry
 * observation map are hand-built, same "no `gh` / network in this file"
 * posture `plan.test.ts` already establishes for `computePlan`.
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { ObservedState } from '../../../src/cli/bootstrap/plan.js';
import type { AgentRegistryObservation } from '../../../src/cli/bootstrap/observer.js';
import {
  BOOTSTRAP_STATUS_JSON_SCHEMA_VERSION,
  PROVISIONING_HEADERS,
  RUNTIME_HEADERS,
  bootstrapStatusToJson,
  buildProvisioningRows,
  buildRuntimeRows,
  computeBootstrapStatus,
  formatBootstrapStatusText,
} from '../../../src/cli/bootstrap/status.js';

/**
 * Mirrors `formatTable`'s own per-column width formula
 * (`commands/ps.ts::formatTable`) — the widest of the header or any row's
 * cell, per column, maxed across all columns. This is "the rendered
 * table's maximum column width" groundnuty/macf#1030 requires a decisive
 * assertion on: computed directly from the same row/header data
 * `formatTable` renders from, not by re-parsing rendered text.
 */
function maxColumnWidth(headers: readonly string[], rows: readonly (readonly string[])[]): number {
  return Math.max(...headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))));
}

/**
 * groundnuty/macf#1030 — a generous but bounded terminal-reasonable column
 * width. The pre-fix defect produced ~500-1400-char single columns (the
 * full repo-visibility reason inlined, then tripled across REPO/CA(repo)/
 * ROUTING-CLIENT), so 200 is decisively smaller than the regression while
 * leaving headroom over static explanatory text already in the table
 * (e.g. `RUNTIME_UNOBSERVABLE_NOTE`, ~114 chars) so an unrelated future
 * wording tweak doesn't flake this test.
 */
const MAX_TERMINAL_REASONABLE_COLUMN_WIDTH = 200;

/** Same 2-agent shape `plan.test.ts::baseManifest` uses, for cross-file familiarity. */
function baseManifest(overrides: Partial<FleetManifest> = {}): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'icsoc-2026' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator', 'age1vm'] },
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

const EMPTY_OBSERVED: ObservedState = { lock: null, agents: {}, caRegistry: 'unknown', caRepos: {}, controlRepoPresence: 'unknown' };

const AGENT_INFO_SCIENCE = {
  host: '100.64.0.1',
  port: 8443,
  type: 'permanent' as const,
  instance_id: 'sci-instance-1',
  started: '2026-08-10T00:00:00.000Z',
  last_heartbeat: '2026-08-19T12:00:00.000Z',
};

const FULLY_PROVISIONED_OBSERVED: ObservedState = {
  lock: {
    schema_version: 1,
    fleet: 'icsoc-2026',
    agents: [
      { role: 'science-agent', app_id: '111', install_id: '222', fingerprints: { app_private_key: 'fp1' }, deployed_version: '0.2.60' },
      { role: 'code-agent', app_id: '333', install_id: '444', fingerprints: { app_private_key: 'fp2' }, deployed_version: '0.2.60' },
      { role: 'runner-ops', app_id: '555', install_id: '666' },
    ],
  },
  agents: {
    'science-agent': {
      app: 'present',
      appId: '111',
      install: 'present',
      installId: '222',
      repo: 'present',
      fingerprints: { app_private_key: 'fp1' },
      deployedVersion: '0.2.60',
      actionsPin: 'v3.4.1',
    },
    'code-agent': {
      app: 'present',
      appId: '333',
      install: 'present',
      installId: '444',
      repo: 'present',
      fingerprints: { app_private_key: 'fp2' },
      deployedVersion: '0.2.60',
      actionsPin: 'v3.4.1',
    },
  },
  caRegistry: 'present',
  caRepos: { 'groundnuty/icsoc-2026-science-agent': 'present', 'groundnuty/icsoc-2026-experiment': 'present' },
  routingClientRepos: { 'groundnuty/icsoc-2026-science-agent': 'present', 'groundnuty/icsoc-2026-experiment': 'present' },
  controlRepoPresence: 'present',
  controlRepoArchived: false,
};

const FULLY_PROVISIONED_REGISTRY: Readonly<Record<string, AgentRegistryObservation>> = {
  'science-agent': { status: 'confirmed', presence: 'present', info: AGENT_INFO_SCIENCE },
  'code-agent': { status: 'confirmed', presence: 'present', info: { ...AGENT_INFO_SCIENCE, host: '100.64.0.2', instance_id: 'code-instance-1' } },
};

describe('computeBootstrapStatus — fully-provisioned fleet', () => {
  const view = computeBootstrapStatus(baseManifest(), FULLY_PROVISIONED_OBSERVED, FULLY_PROVISIONED_REGISTRY);

  it('renders every declared agent present with identifying detail (app id, install id, host:port, instance id)', () => {
    expect(view.agents).toHaveLength(2);
    const sci = view.agents.find((a) => a.role === 'science-agent');
    expect(sci?.app).toBe('present');
    expect(sci?.appId).toBe('111');
    expect(sci?.install).toBe('present');
    expect(sci?.installId).toBe('222');
    expect(sci?.repoPresence).toBe('present');
    expect(sci?.caRepo).toBe('present');
    expect(sci?.routingClientRepo).toBe('present');
    expect(sci?.fingerprintCount).toBe(1);
    expect(sci?.deployedVersion).toBe('0.2.60');
    expect(sci?.actionsPin).toBe('v3.4.1');
    expect(sci?.registry).toEqual({ status: 'confirmed', presence: 'present', info: AGENT_INFO_SCIENCE });
  });

  it('renders the control repo, CA registry, and runner-ops as present with derived identifiers', () => {
    expect(view.controlRepo).toEqual({ repo: 'groundnuty/icsoc-2026-control', presence: 'present', archived: false });
    expect(view.ca.registryPresence).toBe('present');
    expect(view.ca.varName).toBe('ICSOC_2026_CA_CERT');
    expect(view.runnerOps).toEqual({ appHandle: 'icsoc-2026-runner-ops', presence: 'present', appId: '555', installId: '666' });
    expect(view.lockPresent).toBe(true);
  });

  it('reports zero extra lock agents when every lock entry is declared (or is runner-ops, handled separately)', () => {
    expect(view.extraLockAgents).toEqual([]);
  });

  it('the text render contains identifying detail for both agents + the fleet-level facts', () => {
    const text = formatBootstrapStatusText(view);
    expect(text).toContain('macf bootstrap status — icsoc-2026');
    expect(text).toContain('present (111)');
    expect(text).toContain('present (222)');
    expect(text).toContain('groundnuty/icsoc-2026-control');
    expect(text).toContain('runner-ops App: icsoc-2026-runner-ops — present (app_id=555)');
    expect(text).toContain('100.64.0.1:8443');
    expect(text).toContain('sci-instance-1');
  });

  it('the JSON render carries a schema_version and the SAME facts (not a summary)', () => {
    const json = bootstrapStatusToJson(view) as { schema_version: number; fleet: string; agents: readonly { role: string; appId?: string }[] };
    expect(json.schema_version).toBe(BOOTSTRAP_STATUS_JSON_SCHEMA_VERSION);
    expect(json.fleet).toBe('icsoc-2026');
    expect(json.agents.find((a) => a.role === 'science-agent')?.appId).toBe('111');
  });
});

describe('computeBootstrapStatus — VERSION column disclosure (groundnuty/macf#1202)', () => {
  // DECISIVE PAIR (per assert-the-wrong-path.md — trigger 1: "never show a
  // version at all" would trivially satisfy the not-presented-as-observed
  // half on its own, so the observed-case-still-renders half must ALSO be
  // asserted with the SAME mechanism, not a separate one). `deployedVersion`
  // (VERSION column) is lock-derived — this plane has no live route to it,
  // ever. `actionsPin` (ACTIONS-PIN column) IS genuinely live-observed every
  // run (`observer.ts::readCallerActionsPin`). Both are real fields on the
  // SAME fixture, rendered by the SAME `buildProvisioningRows` call — so the
  // contrast proves the mechanism actually discriminates by provenance
  // rather than uniformly relabeling (or uniformly hiding) every version.
  const view = computeBootstrapStatus(baseManifest(), FULLY_PROVISIONED_OBSERVED, FULLY_PROVISIONED_REGISTRY);
  const row = buildProvisioningRows(view.agents).find((r) => r[0] === 'science-agent');

  it('DECISIVE (1/2) — a lock-derived version (never read live this run) does NOT render as a bare observation', () => {
    // VERSION is column index 7 per PROVISIONING_HEADERS.
    expect(row?.[7]).toBe('0.2.60 (from lock)');
    expect(row?.[7]).not.toBe('0.2.60');
  });

  it('DECISIVE (2/2) — a genuinely live-observed value (read fresh this run) STILL renders as a plain observation, unlabeled', () => {
    // ACTIONS-PIN is column index 8. Proves the fix doesn't just blank/hide
    // every version-shaped field — it discriminates on real provenance.
    expect(row?.[8]).toBe('v3.4.1');
  });

  it('the view + JSON carry the provenance discriminator structurally, not just in rendered prose', () => {
    const sci = view.agents.find((a) => a.role === 'science-agent');
    expect(sci?.deployedVersionSource).toBe('lock');
    expect(sci?.actionsPinSource).toBe('live');

    const json = bootstrapStatusToJson(view) as {
      agents: ReadonlyArray<{ role: string; deployedVersionSource?: string; actionsPinSource?: string }>;
    };
    const jsonSci = json.agents.find((a) => a.role === 'science-agent');
    expect(jsonSci?.deployedVersionSource).toBe('lock');
    expect(jsonSci?.actionsPinSource).toBe('live');
  });

  it('an agent with NO recorded version renders "unknown", never a source label on nothing', () => {
    const empty = computeBootstrapStatus(baseManifest(), EMPTY_OBSERVED, {});
    const emptyRow = buildProvisioningRows(empty.agents).find((r) => r[0] === 'science-agent');
    expect(emptyRow?.[7]).toBe('unknown');
    expect(emptyRow?.[8]).toBe('unknown');
    const sci = empty.agents.find((a) => a.role === 'science-agent');
    expect(sci?.deployedVersionSource).toBeUndefined();
    expect(sci?.actionsPinSource).toBeUndefined();
  });

  describe('one-directional-convergence ruling: a host NEWER than declared is DRIFT, not "at target" (pinned)', () => {
    const manifestWithVersions = baseManifest({ versions: { macf: '0.2.60', actions: 'v3.4.1' } });

    it('PINNED — observed macf version NEWER than declared renders DRIFT, not silently accepted', () => {
      const observed: ObservedState = {
        ...FULLY_PROVISIONED_OBSERVED,
        agents: {
          ...FULLY_PROVISIONED_OBSERVED.agents,
          'science-agent': { ...FULLY_PROVISIONED_OBSERVED.agents['science-agent']!, deployedVersion: '0.3.0' },
        },
      };
      const v = computeBootstrapStatus(manifestWithVersions, observed, FULLY_PROVISIONED_REGISTRY);
      const r = buildProvisioningRows(v.agents, undefined, v.declaredVersions).find((row) => row[0] === 'science-agent');
      expect(r?.[7]).toBe('0.3.0 (from lock), declared 0.2.60 — DRIFT');
    });

    it('the SAME ruling applies to versions.actions (no asymmetry between the two version fields)', () => {
      const observed: ObservedState = {
        ...FULLY_PROVISIONED_OBSERVED,
        agents: {
          ...FULLY_PROVISIONED_OBSERVED.agents,
          'science-agent': { ...FULLY_PROVISIONED_OBSERVED.agents['science-agent']!, actionsPin: 'v3.5.0' },
        },
      };
      const v = computeBootstrapStatus(manifestWithVersions, observed, FULLY_PROVISIONED_REGISTRY);
      const r = buildProvisioningRows(v.agents, undefined, v.declaredVersions).find((row) => row[0] === 'science-agent');
      expect(r?.[8]).toBe('v3.5.0, declared v3.4.1 — DRIFT');
    });

    it('a host OLDER than declared ALSO renders DRIFT (symmetric — the ruling is not direction-sensitive)', () => {
      const observed: ObservedState = {
        ...FULLY_PROVISIONED_OBSERVED,
        agents: {
          ...FULLY_PROVISIONED_OBSERVED.agents,
          'science-agent': { ...FULLY_PROVISIONED_OBSERVED.agents['science-agent']!, deployedVersion: '0.2.50' },
        },
      };
      const v = computeBootstrapStatus(manifestWithVersions, observed, FULLY_PROVISIONED_REGISTRY);
      const r = buildProvisioningRows(v.agents, undefined, v.declaredVersions).find((row) => row[0] === 'science-agent');
      expect(r?.[7]).toBe('0.2.50 (from lock), declared 0.2.60 — DRIFT');
    });

    it('an EXACT match renders no DRIFT note', () => {
      const v = computeBootstrapStatus(manifestWithVersions, FULLY_PROVISIONED_OBSERVED, FULLY_PROVISIONED_REGISTRY);
      const r = buildProvisioningRows(v.agents, undefined, v.declaredVersions).find((row) => row[0] === 'science-agent');
      expect(r?.[7]).toBe('0.2.60 (from lock)');
      expect(r?.[7]).not.toContain('DRIFT');
      expect(r?.[8]).toBe('v3.4.1');
      expect(r?.[8]).not.toContain('DRIFT');
    });

    it('with no manifest.versions declared, no DRIFT comparison is attempted (nothing to compare against)', () => {
      const v = computeBootstrapStatus(baseManifest(), FULLY_PROVISIONED_OBSERVED, FULLY_PROVISIONED_REGISTRY);
      expect(v.declaredVersions).toBeUndefined();
      const r = buildProvisioningRows(v.agents, undefined, v.declaredVersions).find((row) => row[0] === 'science-agent');
      expect(r?.[7]).toBe('0.2.60 (from lock)');
      expect(r?.[7]).not.toContain('DRIFT');
    });

    it('the full text render surfaces the DRIFT note (not just the pure row-builder)', () => {
      const observed: ObservedState = {
        ...FULLY_PROVISIONED_OBSERVED,
        agents: {
          ...FULLY_PROVISIONED_OBSERVED.agents,
          'science-agent': { ...FULLY_PROVISIONED_OBSERVED.agents['science-agent']!, deployedVersion: '0.3.0' },
        },
      };
      const v = computeBootstrapStatus(manifestWithVersions, observed, FULLY_PROVISIONED_REGISTRY);
      const text = formatBootstrapStatusText(v);
      expect(text).toContain('0.3.0 (from lock), declared 0.2.60 — DRIFT');
    });

    it('--json carries the declared_versions block the text render\'s DRIFT note is computed against', () => {
      const v = computeBootstrapStatus(manifestWithVersions, FULLY_PROVISIONED_OBSERVED, FULLY_PROVISIONED_REGISTRY);
      const json = bootstrapStatusToJson(v) as { declared_versions?: { macf: string; actions: string } };
      expect(json.declared_versions).toEqual({ macf: '0.2.60', actions: 'v3.4.1' });
    });
  });

  it('an offline/retired agent\'s stale EXTRA lock entry is not presented as current — labeled "(from lock)" same as a declared agent', () => {
    // groundnuty/macf#1202 requirement 3: an agent no longer touched by any
    // roll (dropped from the manifest, or perpetually offline so `macf
    // fleet upgrade` skips it — `fleet-upgrade.ts::planFleetUpgrade`'s
    // 'offline' disposition) must not have its recorded version presented
    // as if it were current. The EXTRA-lock-agents view is the sharpest
    // case: by definition nothing in THIS run touched it.
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: {
        schema_version: 1,
        fleet: 'icsoc-2026',
        agents: [{ role: 'long-offline-agent', app_id: '777', install_id: '888', deployed_version: '0.1.0' }],
      },
    };
    const view2 = computeBootstrapStatus(baseManifest(), observed, {});
    const extra = view2.extraLockAgents.find((e) => e.role === 'long-offline-agent');
    expect(extra?.deployedVersionSource).toBe('lock');
    const text = formatBootstrapStatusText(view2);
    expect(text).toContain('deployed_version=0.1.0 (from lock)');
    expect(text).not.toContain('deployed_version=0.1.0)');
  });
});

describe('computeBootstrapStatus — partially-provisioned fleet (decisive case)', () => {
  // science-agent fully provisioned; code-agent has NOTHING observed at all
  // (no lock entry, no ObservedState.agents entry, no registry entry) —
  // exactly the shape a fresh `bootstrap plan`+`apply` in progress produces.
  const PARTIAL_OBSERVED: ObservedState = {
    lock: {
      schema_version: 1,
      fleet: 'icsoc-2026',
      agents: [{ role: 'science-agent', app_id: '111', install_id: '222', deployed_version: '0.2.60' }],
    },
    agents: {
      'science-agent': { app: 'present', appId: '111', install: 'present', installId: '222', repo: 'present', fingerprints: {}, deployedVersion: '0.2.60' },
    },
    caRegistry: 'present',
    caRepos: { 'groundnuty/icsoc-2026-science-agent': 'present' },
    controlRepoPresence: 'absent',
  };
  const PARTIAL_REGISTRY: Readonly<Record<string, AgentRegistryObservation>> = {
    'science-agent': { status: 'confirmed', presence: 'present', info: AGENT_INFO_SCIENCE },
    // code-agent deliberately omitted — simulates the caller never having
    // attempted (or having failed) that read.
  };

  it('renders without throwing and names code-agent as missing rather than crashing or silently dropping it', () => {
    const view = computeBootstrapStatus(baseManifest(), PARTIAL_OBSERVED, PARTIAL_REGISTRY);
    expect(view.agents).toHaveLength(2);
    const code = view.agents.find((a) => a.role === 'code-agent');
    expect(code?.app).toBe('unknown');
    expect(code?.appId).toBeUndefined();
    expect(code?.install).toBe('unknown');
    expect(code?.repoPresence).toBe('unknown');
    expect(code?.caRepo).toBe('unknown');
    expect(code?.registry).toEqual({ status: 'unknown', reason: 'registry not queried this run' });

    const sci = view.agents.find((a) => a.role === 'science-agent');
    expect(sci?.app).toBe('present');

    expect(view.controlRepo.presence).toBe('absent');
    expect(view.runnerOps.presence).toBe('unknown');
  });

  it('the text render includes BOTH the present science-agent and the named-missing code-agent, never crashing', () => {
    const view = computeBootstrapStatus(baseManifest(), PARTIAL_OBSERVED, PARTIAL_REGISTRY);
    const text = formatBootstrapStatusText(view);
    expect(text).toContain('science-agent');
    expect(text).toContain('code-agent');
    // code-agent's row must show 'unknown', not silently omit the role.
    const codeRow = buildProvisioningRows(view.agents).find((r) => r[0] === 'code-agent');
    expect(codeRow).toBeDefined();
    expect(codeRow).toContain('unknown');
  });
});

describe('computeBootstrapStatus — 404-ambiguous repo visibility (groundnuty/macf#1026, the live symptom)', () => {
  // The exact live shape: `macf bootstrap status` run with science-agent's
  // installation token. code-agent's repo/CA-var/routing-client-secret are
  // ALL fully present on GitHub — but invisible to THIS token, so
  // `observer.ts::resolveAgentRepoState` downgrades all three to `'unknown'`
  // with a diagnostic reason, never the raw `'absent'` the old code produced.
  const REASON = 'this token cannot see "groundnuty/exp-code-agent" (HTTP 404 reading the repo itself; not installed on it? ...)';
  const OBSERVED_WITH_INVISIBLE_REPO: ObservedState = {
    lock: null,
    agents: {
      'science-agent': { app: 'unknown', install: 'unknown', repo: 'present', fingerprints: {} },
      'code-agent': { app: 'unknown', install: 'unknown', repo: 'unknown', repoVisibilityReason: REASON, fingerprints: {} },
    },
    caRegistry: 'unknown',
    caRepos: { 'groundnuty/exp-science-agent': 'present', 'groundnuty/exp-code-agent': 'unknown' },
    routingClientRepos: { 'groundnuty/exp-science-agent': 'unknown', 'groundnuty/exp-code-agent': 'unknown' },
    controlRepoPresence: 'unknown',
  };
  const manifest = baseManifest({
    agents: [
      { role: 'science-agent', profile: 'research', repo: 'groundnuty/exp-science-agent', deploy_path: '/deploy/science-agent' },
      { role: 'code-agent', profile: 'code', repo: 'groundnuty/exp-code-agent', deploy_path: '/deploy/code-agent' },
    ],
  });

  it('DECISIVE — code-agent renders repo/CA(repo)/ROUTING-CLIENT all "unknown", never "absent" — the exact regression this issue fixes', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const code = view.agents.find((a) => a.role === 'code-agent');
    expect(code?.repoPresence).toBe('unknown');
    expect(code?.caRepo).toBe('unknown');
    expect(code?.routingClientRepo).toBe('unknown');
    expect(code?.repoPresence).not.toBe('absent');
    expect(code?.caRepo).not.toBe('absent');
    expect(code?.routingClientRepo).not.toBe('absent');
  });

  it('groundnuty/macf#1030 — the PROVISIONING row carries a SHORT marker, "unknown[1]" not the inlined reason, in all three affected cells', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const codeRow = buildProvisioningRows(view.agents).find((r) => r[0] === 'code-agent');
    expect(codeRow).toBeDefined();
    // REPO, CA(repo), ROUTING-CLIENT are columns 3, 4, 5 (0-indexed) per
    // PROVISIONING_HEADERS — see buildProvisioningRows. All three cite the
    // SAME underlying reason (one repoVisibilityReason for the whole
    // agent), so all three carry the SAME marker.
    expect(codeRow?.[3]).toBe('unknown[1]');
    expect(codeRow?.[4]).toBe('unknown[1]');
    expect(codeRow?.[5]).toBe('unknown[1]');
    // The full explanation is NOT in any cell — moved to a footnote below
    // the table (this is the substance of the #1030 fix).
    expect(codeRow?.[3]).not.toContain('groundnuty/exp-code-agent');
    expect(codeRow?.[3]).not.toContain('this token cannot see');
  });

  it('groundnuty/macf#1030 — the full reason survives, unshortened, as a footnote below the PROVISIONING table', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const text = formatBootstrapStatusText(view);
    expect(text).toContain('this token cannot see');
    expect(text).toContain('404');
    expect(text).toContain(`[1] ${REASON}`);
  });

  it('groundnuty/macf#1030 DECISIVE — the full reason appears EXACTLY ONCE in the rendered text, not once per cell', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const text = formatBootstrapStatusText(view);
    const occurrences = text.split(REASON).length - 1;
    expect(occurrences).toBe(1);
  });

  it('groundnuty/macf#1030 — the marker in each cell maps unambiguously to its footnote', () => {
    // Registry supplied as CONFIRMED (not the `{}` default-unknown fallback
    // used by the other tests in this block) so the RUNTIME table's OWN,
    // independently-numbered footnote registry stays empty — isolating
    // this assertion to PROVISIONING's `[1]` so a coincidental `[1]` in a
    // DIFFERENT table's footnote section can't produce a false ambiguity.
    const registry: Readonly<Record<string, AgentRegistryObservation>> = {
      'science-agent': { status: 'confirmed', presence: 'absent' },
      'code-agent': { status: 'confirmed', presence: 'absent' },
    };
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, registry);
    const codeRow = buildProvisioningRows(view.agents).find((r) => r[0] === 'code-agent');
    const marker = codeRow?.[3]; // 'unknown[1]'
    const match = /\[(\d+)\]$/.exec(marker ?? '');
    expect(match).not.toBeNull();
    const footnoteNumber = match?.[1];
    const text = formatBootstrapStatusText(view);
    // Exactly one footnote line begins with this exact marker number.
    const footnoteLines = text.split('\n').filter((line) => line.startsWith(`[${String(footnoteNumber)}] `));
    expect(footnoteLines).toHaveLength(1);
    expect(footnoteLines[0]).toContain(REASON);
  });

  it('the JSON render carries the FULL, untouched repoVisibilityReason — a fact, not a summary, and never footnote-shortened (--json unaffected by #1030)', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const json = bootstrapStatusToJson(view) as { agents: ReadonlyArray<{ role: string; repoVisibilityReason?: string }> };
    const code = json.agents.find((a) => a.role === 'code-agent');
    expect(code?.repoVisibilityReason).toBe(REASON);
    const sci = json.agents.find((a) => a.role === 'science-agent');
    expect(sci?.repoVisibilityReason).toBeUndefined();
    // The JSON reads straight off AgentStatusView fields — never through the
    // table-cell/footnote-marker rendering path — so no `[N]` marker syntax
    // leaks into it.
    expect(JSON.stringify(json)).not.toMatch(/unknown\[\d+\]/);
  });

  it('MUST-NOT-REGRESS — science-agent (visible to this token) renders its present repo cleanly, no reason text leaking in', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const sci = view.agents.find((a) => a.role === 'science-agent');
    expect(sci?.repoPresence).toBe('present');
    expect(sci?.repoVisibilityReason).toBeUndefined();
    const sciRow = buildProvisioningRows(view.agents).find((r) => r[0] === 'science-agent');
    expect(sciRow?.[3]).toBe('present');
  });

  it('never renders raw credential material (no PEM/token-shaped strings anywhere in text or JSON)', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const text = formatBootstrapStatusText(view);
    const json = JSON.stringify(bootstrapStatusToJson(view));
    expect(text).not.toContain('-----BEGIN');
    expect(json).not.toContain('-----BEGIN');
    expect(text).not.toMatch(/ghs_|ghp_/);
    expect(json).not.toMatch(/ghs_|ghp_/);
  });

  it('groundnuty/macf#1030 DECISIVE — no PROVISIONING or RUNTIME column exceeds a terminal-reasonable width, even with a long repo-visibility reason', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const provisioningWidth = maxColumnWidth(PROVISIONING_HEADERS, buildProvisioningRows(view.agents));
    const runtimeWidth = maxColumnWidth(RUNTIME_HEADERS, buildRuntimeRows(view.agents));
    // Pre-fix, this same fixture produced a ~508-char REPO/CA(repo)/
    // ROUTING-CLIENT column (the reason inlined three times) — comfortably
    // over any terminal-reasonable bound. Post-fix, cells carry only a
    // short `unknown[N]` marker.
    expect(provisioningWidth).toBeLessThanOrEqual(MAX_TERMINAL_REASONABLE_COLUMN_WIDTH);
    expect(runtimeWidth).toBeLessThanOrEqual(MAX_TERMINAL_REASONABLE_COLUMN_WIDTH);
  });
});

describe('computeBootstrapStatus — footnote dedup + no-footnote-when-clean (groundnuty/macf#1030)', () => {
  it('two agents that hit the SAME cause share ONE footnote, not two identical ones', () => {
    // Both agents' registry read fails for the identical generic reason —
    // the realistic shape of "same cause affecting two agents" (e.g. one
    // shared network/auth failure), same fixture shape already used above
    // in the "honest unknown" describe block, but now asserting the
    // footnote-dedup behavior specifically.
    const SHARED_REASON = 'registry variable could not be read (network/auth/gh failure)';
    const registry: Readonly<Record<string, AgentRegistryObservation>> = {
      'science-agent': { status: 'unknown', reason: SHARED_REASON },
      'code-agent': { status: 'unknown', reason: SHARED_REASON },
    };
    const view = computeBootstrapStatus(baseManifest(), EMPTY_OBSERVED, registry);
    const rows = buildRuntimeRows(view.agents);
    expect(rows.every((r) => r[1] === 'unknown[1]')).toBe(true);

    const text = formatBootstrapStatusText(view);
    // The reason text appears exactly once...
    expect(text.split(SHARED_REASON).length - 1).toBe(1);
    // ...as exactly one footnote line, numbered [1].
    const footnoteLines = text.split('\n').filter((line) => line.startsWith('[1] '));
    expect(footnoteLines).toHaveLength(1);
    expect(footnoteLines[0]).toBe(`[1] ${SHARED_REASON}`);
    // No second footnote was allocated for the duplicate cause.
    expect(text).not.toContain('[2]');
  });

  it('a fleet with no unknowns renders no footnote section at all', () => {
    const view = computeBootstrapStatus(baseManifest(), FULLY_PROVISIONED_OBSERVED, FULLY_PROVISIONED_REGISTRY);
    const text = formatBootstrapStatusText(view);
    // No footnote-marker syntax anywhere (cells) and no footnote-list line
    // (a line starting with `[<digit>] `) anywhere in the render.
    expect(text).not.toMatch(/\[\d+\]/);
    expect(text.split('\n').some((line) => /^\[\d+\] /.test(line))).toBe(false);
  });
});

describe('computeBootstrapStatus — honest unknown, never absent, on unreadable resources', () => {
  it('an unread CA registry var + unread agent fields render "unknown", never "absent"', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      caRegistry: 'unknown',
      agents: { 'science-agent': { app: 'unknown', install: 'unknown', repo: 'unknown', fingerprints: {} } },
    };
    const view = computeBootstrapStatus(baseManifest(), observed, {});
    expect(view.ca.registryPresence).toBe('unknown');
    const sci = view.agents.find((a) => a.role === 'science-agent');
    expect(sci?.app).toBe('unknown');
    expect(sci?.app).not.toBe('absent');
  });

  it('a registry read that came back "unknown" (network/auth failure) never renders as absent', () => {
    const registry: Readonly<Record<string, AgentRegistryObservation>> = {
      'science-agent': { status: 'unknown', reason: 'registry variable could not be read (network/auth/gh failure)' },
      'code-agent': { status: 'unknown', reason: 'registry variable could not be read (network/auth/gh failure)' },
    };
    const view = computeBootstrapStatus(baseManifest(), EMPTY_OBSERVED, registry);
    for (const a of view.agents) {
      expect(a.registry.status).toBe('unknown');
    }
    const rows = buildRuntimeRows(view.agents);
    for (const row of rows) {
      expect(row.join(' ')).toContain('unknown');
      expect(row.join(' ')).not.toContain('absent');
    }
  });

  it('a CONFIRMED-absent registry entry (live 404) is distinguished from unknown — presence: absent, status: confirmed', () => {
    const registry: Readonly<Record<string, AgentRegistryObservation>> = {
      'science-agent': { status: 'confirmed', presence: 'absent' },
    };
    const view = computeBootstrapStatus(baseManifest({ agents: [baseManifest().agents[0]!] }), EMPTY_OBSERVED, registry);
    const row = buildRuntimeRows(view.agents)[0]!;
    expect(row[1]).toContain('absent');
    // Liveness column must STILL read unknown — confirmed-absent registration
    // is not evidence about liveness (there is nothing registered to probe).
    expect(row[row.length - 1]).toContain('unknown');
  });
});

describe('computeBootstrapStatus — vault-free run (no --vault/--identity-key)', () => {
  it('vault-dependent rows render "not read this run"; every other field still renders', () => {
    const view = computeBootstrapStatus(baseManifest(), FULLY_PROVISIONED_OBSERVED, FULLY_PROVISIONED_REGISTRY);
    // FULLY_PROVISIONED_OBSERVED never sets vaultCa/vaultRecipients/agent.vault
    // — the vault-free default.
    expect(view.ca.vault).toBeUndefined();
    expect(view.vaultRecipients.observation).toBeUndefined();
    for (const a of view.agents) expect(a.vault).toBeUndefined();

    const text = formatBootstrapStatusText(view);
    expect(text).toContain('not read this run');
    // Non-vault facts are untouched by the vault-free default.
    expect(text).toContain('present (111)');
    expect(text).toContain('100.64.0.1:8443');
  });
});

describe('computeBootstrapStatus — routing block', () => {
  it('omitted entirely when routing.runner is not declared', () => {
    const view = computeBootstrapStatus(baseManifest(), EMPTY_OBSERVED, {});
    expect(view.routing).toBeUndefined();
    // "ROUTING-CLIENT" is an unrelated PROVISIONING column header (always
    // present) — assert against the routing BLOCK's distinctive heading
    // text, not the bare substring "ROUTING".
    expect(formatBootstrapStatusText(view)).not.toContain('ROUTING (declared');
  });

  it('rendered with observed trust/runner facts when declared', () => {
    const manifest = baseManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const observed: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'icsoc-2026-code-agent[bot]', routingRunnerRegistered: 'present' };
    const view = computeBootstrapStatus(manifest, observed, {});
    expect(view.routing).toEqual({
      runsOn: 'self-hosted',
      warm: 1,
      trustedActors: 'icsoc-2026-code-agent[bot]',
      runnerRegistered: 'present',
      runnerHandover: undefined,
      runnerDetail: undefined,
    });
    expect(formatBootstrapStatusText(view)).toContain('ROUTING (declared runs_on=self-hosted, warm=1)');
  });
});

describe('computeBootstrapStatus — extra lock agents (§D3 no-prune, rendering flavor)', () => {
  it('an agent fleet.lock remembers that fleet.yaml no longer declares is reported, not dropped', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: {
        schema_version: 1,
        fleet: 'icsoc-2026',
        agents: [{ role: 'retired-agent', app_id: '999', install_id: '888', deployed_version: '0.2.50' }],
      },
    };
    const view = computeBootstrapStatus(baseManifest(), observed, {});
    expect(view.extraLockAgents).toEqual([
      { role: 'retired-agent', appId: '999', installId: '888', deployedVersion: '0.2.50', deployedVersionSource: 'lock' },
    ]);
    expect(formatBootstrapStatusText(view)).toContain('retired-agent');
  });

  it('runner-ops is excluded from extraLockAgents (it has its own dedicated view)', () => {
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      lock: { schema_version: 1, fleet: 'icsoc-2026', agents: [{ role: 'runner-ops', app_id: '1', install_id: '2' }] },
    };
    const view = computeBootstrapStatus(baseManifest(), observed, {});
    expect(view.extraLockAgents).toEqual([]);
    expect(view.runnerOps.presence).toBe('present');
  });
});
