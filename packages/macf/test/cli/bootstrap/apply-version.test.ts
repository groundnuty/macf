/**
 * Tests for `runApplyVersionPhase`'s outcome discriminator (groundnuty/macf#1053)
 * — the fields the summary render (`commands/bootstrap-apply.ts`'s
 * `formatVersionReconcileLine`, covered in `bootstrap-apply.test.ts`) reads to
 * distinguish "rolled N agents" / "had nothing to roll" / "could not attempt".
 * This file covers the COMPUTATION (this module reading `FleetUpgradeReport`
 * via the REAL `upgradeFleets`/`rollFleet` decision layer, golden-path per
 * DR-043 Amendment L2 / macf#1000 — never a re-implementation); the render is
 * a separate concern tested against hand-built `ApplyVersionPhaseResult`
 * fixtures.
 */
import { describe, it, expect } from 'vitest';
import { upgradeFleets, type FleetDriver, type FleetState, type HealthResponse, type WorkspaceRecord } from '@groundnuty/macf-core';
import { runApplyVersionPhase, versionRollSkipBreakdown, type ApplyVersionPhaseDeps } from '../../../src/cli/bootstrap/apply-version.js';
import { parseFleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';

const FLEET_NAME = 'demo-fleet';

const MANIFEST_WITH_VERSIONS = parseFleetManifest(`apiVersion: macf/v0
kind: Fleet
metadata:
  name: ${FLEET_NAME}
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
network:
  advertise_host: example.ts.net
transport:
  age_recipients: [age1qtestrecipientxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
versions:
  macf: "0.2.57"
  actions: v3.4.1
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/demo-code
    deploy_path: /home/ubuntu/repos/demo-code
`);

const MANIFEST_NO_VERSIONS = parseFleetManifest(`apiVersion: macf/v0
kind: Fleet
metadata:
  name: ${FLEET_NAME}
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
network:
  advertise_host: example.ts.net
transport:
  age_recipients: [age1qtestrecipientxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/demo-code
    deploy_path: /home/ubuntu/repos/demo-code
`);

function mkHealth(version: string): HealthResponse {
  return { agent: 'a', status: 'online', type: 'permanent', uptime_seconds: 5, current_issue: null, version, last_notification: null };
}

function mkWs(agent: string, pin: string | null): WorkspaceRecord {
  return { agent, workspace: `/w/${agent}`, registry: FLEET_NAME, project: FLEET_NAME, versionPin: pin };
}

/**
 * `fetchLatest` THROWS if called — `MANIFEST_WITH_VERSIONS` always declares
 * `versions.macf`, so Amendment L3's manifest-authoritative branch must never
 * reach it (`assert-the-wrong-path.md`; the SAME guard `bootstrap-apply.test.ts`'s
 * `fakeVersionDeps()` uses — this is the #1049 behaviour-unchanged proof: every
 * test below that doesn't override `fetchLatest` implicitly asserts it).
 */
function baseDeps(overrides: Partial<ApplyVersionPhaseDeps> = {}): ApplyVersionPhaseDeps {
  return {
    discover: () => [],
    resolveDriver: async () => null,
    fetchLatest: async () => {
      throw new Error('fetchLatest must not be called — versions.macf is declared (DR-043 Amendment L3, macf#1049)');
    },
    sleep: async () => {},
    now: () => 0,
    log: () => {},
    runUpgradeFleetsFn: upgradeFleets,
    ...overrides,
  };
}

/**
 * A single-agent driver that flips `code-agent`'s reported version to
 * `target` the instant `restart` is called (models a clean roll — no real
 * sleep needed for verify-green to see green on the first poll).
 * `busy`/`configDirty` let individual tests model a pre-flight skip without
 * touching the roll's own state-machine internals.
 */
function makeSingleAgentDriver(opts: {
  base: string;
  target: string;
  busy?: boolean;
  configDirty?: boolean;
}): FleetDriver {
  const restarted = new Set<string>();
  const probe = async (): Promise<FleetState> => {
    const version = restarted.has('code-agent') ? opts.target : opts.base;
    return { agents: [{ name: 'code-agent', host: 'h', port: 1, online: true, version, health: mkHealth(version) }] };
  };
  return {
    probe,
    discoverWorkspaces: () => [mkWs('code-agent', opts.base)],
    isBusy: async () => opts.busy ?? false,
    isConfigDirty: async () => opts.configDirty ?? false,
    listDirtyConfig: async () => (opts.configDirty ? ['claude.sh'] : []),
    currentBranch: async () => 'main',
    canonicalBranch: async () => 'main',
    classifyDirtyConfig: async () => (opts.configDirty ? { alreadyCanonical: [], genuineDelta: ['claude.sh'] } : { alreadyCanonical: [], genuineDelta: [] }),
    autoResolveCanonical: async () => {},
    capturePane: async () => null,
    upgrade: async () => {},
    restart: async (agent) => {
      restarted.add(agent);
    },
    inject: async () => {},
    launch: async () => {},
    listModifiedFiles: async () => [],
    readVersionPin: async () => null,
    acquireLock: async () => {},
    releaseLock: async () => {},
    startHeartbeat: () => () => {},
  };
}

describe('runApplyVersionPhase — outcome discriminator (groundnuty/macf#1053)', () => {
  it('manifest.versions absent: attempted:false, unchanged by #1053 (Amendment L2.4)', async () => {
    const result = await runApplyVersionPhase(MANIFEST_NO_VERSIONS, baseDeps());
    expect(result).toEqual({ attempted: false });
  });

  it('driver-unresolved (no local workspace for this fleet on this host): unreachable:true, rolled nothing', async () => {
    const result = await runApplyVersionPhase(MANIFEST_WITH_VERSIONS, baseDeps({ resolveDriver: async () => null }));
    expect(result.attempted).toBe(true);
    expect(result.target).toBe('0.2.57');
    expect(result.halted).toBe(false);
    expect(result.unreachable).toBe(true);
    expect(result.rolledAgents).toEqual([]);
    expect(result.totalMembers).toBe(0);
    expect(result.skipBreakdown).toEqual([]);
  });

  it('a genuine roll: rolledAgents names the agent, unreachable:false, matches the real upgradeFleets report', async () => {
    const driver = makeSingleAgentDriver({ base: '0.2.50', target: '0.2.57' });
    const result = await runApplyVersionPhase(MANIFEST_WITH_VERSIONS, baseDeps({ resolveDriver: async () => driver }));
    expect(result.unreachable).toBe(false);
    expect(result.totalMembers).toBe(1);
    // Decisive per `assert-the-wrong-path.md`: this must be a NON-EMPTY,
    // NAMED list, not merely "the phase attempted" — the rolled/no-op
    // distinction lives entirely in this field.
    expect(result.rolledAgents).toEqual(['code-agent']);
    expect(result.skipBreakdown).toEqual([]);
  });

  it('examined the member but it was BUSY: rolled nothing, breakdown names it, distinct from unreachable', async () => {
    const driver = makeSingleAgentDriver({ base: '0.2.50', target: '0.2.57', busy: true });
    const result = await runApplyVersionPhase(MANIFEST_WITH_VERSIONS, baseDeps({ resolveDriver: async () => driver }));
    expect(result.unreachable).toBe(false);
    expect(result.totalMembers).toBe(1);
    expect(result.rolledAgents).toEqual([]);
    expect(result.skipBreakdown).toEqual(['1 busy']);
  });

  it('examined the member but its config surface was dirty: breakdown names config-dirty, not busy', async () => {
    const driver = makeSingleAgentDriver({ base: '0.2.50', target: '0.2.57', configDirty: true });
    const result = await runApplyVersionPhase(MANIFEST_WITH_VERSIONS, baseDeps({ resolveDriver: async () => driver }));
    expect(result.rolledAgents).toEqual([]);
    expect(result.skipBreakdown).toEqual(['1 config-dirty']);
  });

  it('member already AT target: not behind, so never entered the roll — zero breakdown, not a false busy/config-dirty count', async () => {
    // base === target: `planFleetUpgrade` classifies this as 'at-target', so
    // `rollFleet` never even looks at busy/config-dirty for it (the `continue`
    // on `disposition !== 'behind'`) — totalMembers counts it, but it
    // contributes to NEITHER rolledAgents NOR skipBreakdown.
    const driver = makeSingleAgentDriver({ base: '0.2.57', target: '0.2.57' });
    const result = await runApplyVersionPhase(MANIFEST_WITH_VERSIONS, baseDeps({ resolveDriver: async () => driver }));
    expect(result.totalMembers).toBe(1);
    expect(result.rolledAgents).toEqual([]);
    expect(result.skipBreakdown).toEqual([]);
  });

  it('the roll behaviour itself is unchanged (macf#1049): target is manifest-authoritative, fetchLatest never called', async () => {
    // `baseDeps()`'s `fetchLatest` throws if invoked — if this test completes
    // without throwing, the manifest-authoritative branch was taken, exactly
    // as macf#1049 established. Asserted explicitly (not just "didn't throw")
    // per `assert-the-wrong-path.md`: the target must be the MANIFEST value.
    const result = await runApplyVersionPhase(MANIFEST_WITH_VERSIONS, baseDeps());
    expect(result.target).toBe('0.2.57');
  });
});

describe('versionRollSkipBreakdown (pure) — groundnuty/macf#1053', () => {
  const ZERO = { results: [], halted: false, upgraded: 0, busySkipped: 0, configDirtySkipped: 0, configAutoResolved: 0, branchSkipped: 0, stalePinSkipped: 0 };

  it('empty when nothing was skipped', () => {
    expect(versionRollSkipBreakdown(ZERO)).toEqual([]);
  });

  it('names each non-zero category, in branch → config-dirty → busy → stale-pin order', () => {
    expect(versionRollSkipBreakdown({ ...ZERO, branchSkipped: 1, configDirtySkipped: 2, busySkipped: 3, stalePinSkipped: 4 })).toEqual([
      '1 off-canonical-branch',
      '2 config-dirty',
      '3 busy',
      '4 stale-pin',
    ]);
  });

  it('omits zero-count categories entirely — never a "0 busy" clause', () => {
    expect(versionRollSkipBreakdown({ ...ZERO, busySkipped: 2 })).toEqual(['2 busy']);
  });
});
