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
  bootstrapStatusToJson,
  buildProvisioningRows,
  buildRuntimeRows,
  computeBootstrapStatus,
  formatBootstrapStatusText,
} from '../../../src/cli/bootstrap/status.js';

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
    trust: { ca: 'per-project', federated_cas: [] },
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

  it('the PROVISIONING row embeds the reason inline — "unknown (...)" not a bare "unknown" — in all three affected cells', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const codeRow = buildProvisioningRows(view.agents).find((r) => r[0] === 'code-agent');
    expect(codeRow).toBeDefined();
    // REPO, CA(repo), ROUTING-CLIENT are columns 3, 4, 5 (0-indexed) per
    // PROVISIONING_HEADERS — see buildProvisioningRows.
    expect(codeRow?.[3]).toContain('unknown (');
    expect(codeRow?.[3]).toContain('groundnuty/exp-code-agent');
    expect(codeRow?.[4]).toContain('unknown (');
    expect(codeRow?.[5]).toContain('unknown (');
    const text = formatBootstrapStatusText(view);
    expect(text).toContain('this token cannot see');
    expect(text).toContain('404');
  });

  it('the JSON render carries repoVisibilityReason as a fact, not a summary — same posture as every other AgentStatusView field', () => {
    const view = computeBootstrapStatus(manifest, OBSERVED_WITH_INVISIBLE_REPO, {});
    const json = bootstrapStatusToJson(view) as { agents: ReadonlyArray<{ role: string; repoVisibilityReason?: string }> };
    const code = json.agents.find((a) => a.role === 'code-agent');
    expect(code?.repoVisibilityReason).toBe(REASON);
    const sci = json.agents.find((a) => a.role === 'science-agent');
    expect(sci?.repoVisibilityReason).toBeUndefined();
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
    expect(view.extraLockAgents).toEqual([{ role: 'retired-agent', appId: '999', installId: '888', deployedVersion: '0.2.50' }]);
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
