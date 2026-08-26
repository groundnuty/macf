/**
 * Tests for `install-scope-coverage.ts` — the live installation-SCOPE-
 * MEMBERSHIP drift check (groundnuty/macf#1220): does a fleet-level App's
 * `selected` install actually COVER every repo the manifest currently
 * declares. Fully offline: the real I/O leaves (`checkRepoInAppInstallation`,
 * `readVault`) are always injected fakes here — same "pure-parse tested,
 * I/O leaf untested directly" split `registry-repo-coverage.test.ts`
 * already establishes for the sibling single-repo check this module reuses.
 */
import { describe, it, expect, vi } from 'vitest';
import type { FleetLock, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { Presence } from '../../../src/cli/bootstrap/plan.js';
import {
  computeInstallScopeCoverage,
  evaluateInstallScopeCoverage,
  hasInstallScopeCoverageDrift,
  installScopeCoverageDriftMessage,
  installScopeCoverageEntryToJson,
  installScopeCoverageTargets,
  probeInstallScopeCoverage,
  repoExistencePresence,
  type InstallScopeCoverageEntry,
  type InstallScopeCoverageTarget,
} from '../../../src/cli/bootstrap/install-scope-coverage.js';
import { RUNNER_OPS_ROLE } from '../../../src/cli/bootstrap/apply-runner-ops.js';
import { ROUTER_APP_ROLE } from '../../../src/cli/bootstrap/apply-router-app.js';

/** A 3-agent fleet, self-hosted runner declared, `registry.type: 'repo'` — the exact live shape `macf-trial` reproduced (2->3 agents; runner-ops + router both fleet-level). */
function fleet(overrides?: Partial<FleetManifest>): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'trial' },
    owner: { account: 'macf-experiment', type: 'org', registry: { type: 'repo', owner: 'macf-experiment', repo: 'trial-control' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [
      { role: 'code-agent', profile: 'code', repo: 'macf-experiment/trial-code-agent', deploy_path: '/x' },
      { role: 'science-agent', profile: 'science', repo: 'macf-experiment/trial-science-agent', deploy_path: '/y' },
      { role: 'writing-agent', profile: 'writing', repo: 'macf-experiment/trial-writing-agent', deploy_path: '/z' },
    ],
    routing: { runner: { runs_on: 'self-hosted', warm: 1 } },
    ...overrides,
  };
}

const EMPTY_LOCK: FleetLock = { schema_version: 1, fleet: 'trial', agents: [] };

// --- installScopeCoverageTargets — declared side, zero-to-two, derived not hard-coded ---

describe('installScopeCoverageTargets (pure, manifest-derived)', () => {
  it('runner-ops target expects EVERY declared agent repo — derived via installReposForIdentity, never a hand-typed list', () => {
    const targets = installScopeCoverageTargets(fleet());
    const runnerOps = targets.find((t) => t.role === RUNNER_OPS_ROLE);
    expect(runnerOps?.expectedRepos).toEqual(['macf-experiment/trial-code-agent', 'macf-experiment/trial-science-agent', 'macf-experiment/trial-writing-agent']);
  });

  it('router target expects ONLY the registry repo — never every agent repo (the fallback installReposForIdentity would wrongly give it)', () => {
    const targets = installScopeCoverageTargets(fleet());
    const router = targets.find((t) => t.role === ROUTER_APP_ROLE);
    expect(router?.expectedRepos).toEqual(['macf-experiment/trial-control']);
  });

  it('no runner-ops target when the fleet never declares a self-hosted runner', () => {
    const targets = installScopeCoverageTargets(fleet({ routing: undefined }));
    expect(targets.find((t) => t.role === RUNNER_OPS_ROLE)).toBeUndefined();
  });

  it('no router target when registry.type is "org" (no App-install surface for the router there)', () => {
    const targets = installScopeCoverageTargets(fleet({ owner: { account: 'macf-experiment', type: 'org', registry: { type: 'org', org: 'macf-experiment' } } }));
    expect(targets.find((t) => t.role === ROUTER_APP_ROLE)).toBeUndefined();
  });

  it('exactly two targets for a self-hosted, registry-repo fleet — runner-ops AND router, no more', () => {
    expect(installScopeCoverageTargets(fleet()).map((t) => t.role).sort()).toEqual([ROUTER_APP_ROLE, RUNNER_OPS_ROLE].sort());
  });
});

// --- evaluateInstallScopeCoverage — the decisive pair + the absent-repo disambiguation ---

const RUNNER_OPS_TARGET: InstallScopeCoverageTarget = {
  role: RUNNER_OPS_ROLE,
  appHandle: 'trial-runner-ops',
  expectedRepos: ['macf-experiment/trial-code-agent', 'macf-experiment/trial-science-agent', 'macf-experiment/trial-writing-agent'],
};

const ALL_PRESENT = (): Presence => 'present';

describe('evaluateInstallScopeCoverage — decisive pair (groundnuty/macf#1220 required test)', () => {
  it('1. installed on a SUBSET of declared repos -> drift, naming exactly the missing repos', () => {
    const probed: Readonly<Record<string, Presence>> = {
      'macf-experiment/trial-code-agent': 'present',
      'macf-experiment/trial-science-agent': 'present',
      'macf-experiment/trial-writing-agent': 'absent',
    };
    const entry = evaluateInstallScopeCoverage(RUNNER_OPS_TARGET, ALL_PRESENT, probed);
    expect(entry.status).toBe('drift');
    expect(entry.missingRepos).toEqual(['macf-experiment/trial-writing-agent']);
    expect(entry.message).toContain('macf-experiment/trial-writing-agent');
    expect(entry.message).not.toContain('trial-code-agent');
  });

  it('2. installed on EXACTLY the declared set -> covered, NOT reported as drift', () => {
    const probed: Readonly<Record<string, Presence>> = {
      'macf-experiment/trial-code-agent': 'present',
      'macf-experiment/trial-science-agent': 'present',
      'macf-experiment/trial-writing-agent': 'present',
    };
    const entry = evaluateInstallScopeCoverage(RUNNER_OPS_TARGET, ALL_PRESENT, probed);
    expect(entry.status).toBe('covered');
    expect(entry.missingRepos).toEqual([]);
    expect(entry.message).toBeUndefined();
  });

  it('3. a repo probed absent whose OWN existence is not confirmed present -> unknown, NEVER drift (a 404 cannot distinguish "not selected" from "does not exist yet")', () => {
    const probed: Readonly<Record<string, Presence>> = {
      'macf-experiment/trial-code-agent': 'present',
      'macf-experiment/trial-science-agent': 'present',
      'macf-experiment/trial-writing-agent': 'absent',
    };
    // The new repo's own existence could not be confirmed this run.
    const existence = (repo: string): Presence => (repo === 'macf-experiment/trial-writing-agent' ? 'unknown' : 'present');
    const entry = evaluateInstallScopeCoverage(RUNNER_OPS_TARGET, existence, probed);
    expect(entry.status).toBe('unknown');
    expect(entry.missingRepos).toEqual([]);
    expect(entry.unverifiedRepos).toEqual(['macf-experiment/trial-writing-agent']);
  });

  it('a per-agent App installed only on its own repo + the control repo is correct, not drift (role-agnostic evaluator, pinned against an agent-shaped target)', () => {
    const agentTarget: InstallScopeCoverageTarget = {
      role: 'code-agent',
      appHandle: 'trial-code-agent',
      expectedRepos: ['macf-experiment/trial-code-agent', 'macf-experiment/trial-control'],
    };
    const probed: Readonly<Record<string, Presence>> = {
      'macf-experiment/trial-code-agent': 'present',
      'macf-experiment/trial-control': 'present',
    };
    const entry = evaluateInstallScopeCoverage(agentTarget, ALL_PRESENT, probed);
    expect(entry.status).toBe('covered');
  });

  it('(1) alone would be satisfied by an implementation that always reports drift — this suite also asserts (2), so that implementation fails here', () => {
    // No separate assertion needed: cases 1 and 2 together are the guard.
    // This test exists to make the pairing requirement explicit in the
    // suite's own structure, per assert-the-wrong-path.md.
    expect(true).toBe(true);
  });
});

describe('repoExistencePresence — the existence disambiguator', () => {
  const manifest = fleet();

  it('the control repo full name reads controlRepoPresence', () => {
    expect(repoExistencePresence(manifest, {}, 'present', 'macf-experiment/trial-control')).toBe('present');
    expect(repoExistencePresence(manifest, {}, 'absent', 'macf-experiment/trial-control')).toBe('absent');
  });

  it('a declared agent repo reads that agent\'s own repo Presence, by role', () => {
    const agentRepoPresence = { 'code-agent': 'present' as Presence, 'science-agent': 'unknown' as Presence };
    expect(repoExistencePresence(manifest, agentRepoPresence, 'unknown', 'macf-experiment/trial-code-agent')).toBe('present');
    expect(repoExistencePresence(manifest, agentRepoPresence, 'unknown', 'macf-experiment/trial-science-agent')).toBe('unknown');
  });

  it('a repo matching no declared agent and not the control repo -> unknown (never fabricated)', () => {
    expect(repoExistencePresence(manifest, {}, 'unknown', 'macf-experiment/some-other-repo')).toBe('unknown');
  });
});

// --- probeInstallScopeCoverage — the per-App live-probe loop ---

describe('probeInstallScopeCoverage', () => {
  it('calls checkFn once per expected repo, with the SPLIT owner/repo — never the full "owner/repo" string', async () => {
    const checkFn = vi.fn(async (_appId: string, _keyPath: string, owner: string, repo: string): Promise<Presence> => (owner === 'macf-experiment' && repo === 'trial-code-agent' ? 'present' : 'absent'));
    const result = await probeInstallScopeCoverage('123', '/tmp/key.pem', ['macf-experiment/trial-code-agent', 'macf-experiment/trial-science-agent'], checkFn);
    expect(checkFn).toHaveBeenCalledTimes(2);
    expect(checkFn).toHaveBeenCalledWith('123', '/tmp/key.pem', 'macf-experiment', 'trial-code-agent');
    expect(result).toEqual({ 'macf-experiment/trial-code-agent': 'present', 'macf-experiment/trial-science-agent': 'absent' });
  });

  it('an unparseable repo string reads unknown WITHOUT invoking checkFn (throw-from-fake: a call here is itself the failure)', async () => {
    const checkFn = vi.fn(async (): Promise<Presence> => {
      throw new Error('checkFn must not be called for an unparseable repo string');
    });
    const result = await probeInstallScopeCoverage('123', '/tmp/key.pem', ['not-a-valid-repo-string'], checkFn);
    expect(result).toEqual({ 'not-a-valid-repo-string': 'unknown' });
    expect(checkFn).not.toHaveBeenCalled();
  });
});

// --- computeInstallScopeCoverage — the whole-run orchestration ---

describe('computeInstallScopeCoverage — honest-unknown BEFORE any I/O, and the credential-unavailable case (groundnuty/macf#1220 required test: distinct from both drift and covered)', () => {
  it('no --vault/--identity-key this run -> every target unknown, checkFn NEVER invoked (throw-from-fake)', async () => {
    const probeFn = vi.fn(async (): Promise<Presence> => {
      throw new Error('probeFn must not be called when this run has no vault credential at all');
    });
    const readVaultFn = vi.fn(async () => {
      throw new Error('readVaultFn must not be called when vaultOpts is undefined');
    });
    const result = await computeInstallScopeCoverage(fleet(), EMPTY_LOCK, {}, 'present', undefined, { probeFn, readVaultFn });
    expect(Object.values(result).every((e) => e.status === 'unknown')).toBe(true);
    expect(Object.keys(result).sort()).toEqual([ROUTER_APP_ROLE, RUNNER_OPS_ROLE].sort());
    expect(probeFn).not.toHaveBeenCalled();
    expect(readVaultFn).not.toHaveBeenCalled();
    expect(hasInstallScopeCoverageDrift(result)).toBe(false);
  });

  it('a vault read failure -> every target unknown, checkFn NEVER invoked', async () => {
    const probeFn = vi.fn(async (): Promise<Presence> => {
      throw new Error('probeFn must not be called when the vault could not be decrypted');
    });
    const readVaultFn = vi.fn(async () => {
      throw new Error('bad age identity key');
    });
    const result = await computeInstallScopeCoverage(fleet(), EMPTY_LOCK, {}, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn });
    expect(Object.values(result).every((e) => e.status === 'unknown')).toBe(true);
    expect(Object.values(result).every((e) => e.message?.includes('bad age identity key'))).toBe(true);
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('vault reads OK but this role has no App ID / PEM in it (never provisioned via this vault) -> unknown for that role, checkFn never invoked for it', async () => {
    const probeFn = vi.fn(async (): Promise<Presence> => {
      throw new Error('probeFn must not be called with no resolvable credential');
    });
    const readVaultFn = vi.fn(async () => ({}));
    const result = await computeInstallScopeCoverage(fleet(), EMPTY_LOCK, {}, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn });
    expect(Object.values(result).every((e) => e.status === 'unknown')).toBe(true);
    expect(probeFn).not.toHaveBeenCalled();
  });

  it('a fully resolvable run reports drift for a genuinely missing, confirmed-existing repo', async () => {
    const lock: FleetLock = {
      schema_version: 1,
      fleet: 'trial',
      agents: [{ role: RUNNER_OPS_ROLE, app_id: '9001', install_id: '5555' }],
    };
    // groundnuty/macf-core's toVariableSegment-derived vault key shape for
    // the runner-ops PEM — mirrors vault-read.ts::vaultRunnerOpsPrivateKeyPem's
    // own derivation (deriveRunnerOpsHandle('trial') -> 'trial-runner-ops').
    const pemB64 = Buffer.from('FAKE PEM CONTENT').toString('base64');
    const readVaultFn = vi.fn(async () => ({ MACF_RUNNER_OPS_TRIAL_RUNNER_OPS_PRIVATE_KEY_B64: pemB64 }));
    const probeFn = vi.fn(async (_appId: string, _keyPath: string, _owner: string, repo: string): Promise<Presence> => (repo === 'trial-writing-agent' ? 'absent' : 'present'));
    const agentRepoPresence: Readonly<Record<string, Presence>> = { 'code-agent': 'present', 'science-agent': 'present', 'writing-agent': 'present' };

    const result = await computeInstallScopeCoverage(fleet(), lock, agentRepoPresence, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn });

    expect(result[RUNNER_OPS_ROLE]?.status).toBe('drift');
    expect(result[RUNNER_OPS_ROLE]?.missingRepos).toEqual(['macf-experiment/trial-writing-agent']);
    expect(hasInstallScopeCoverageDrift(result)).toBe(true);
    // The router target has no vault credential in this fixture -> unknown, not drift.
    expect(result[ROUTER_APP_ROLE]?.status).toBe('unknown');
  });
});

// --- onDrift wiring (groundnuty/macf#1220 — the ACT half) ---

describe('computeInstallScopeCoverage — onDrift wiring (groundnuty/macf#1220 required test)', () => {
  const RUNNER_OPS_LOCK: FleetLock = {
    schema_version: 1,
    fleet: 'trial',
    agents: [{ role: RUNNER_OPS_ROLE, app_id: '9001', install_id: '5555' }],
  };
  const PEM_B64 = Buffer.from('FAKE PEM CONTENT').toString('base64');
  const RUNNER_OPS_VAULT = { MACF_RUNNER_OPS_TRIAL_RUNNER_OPS_PRIVATE_KEY_B64: PEM_B64 };
  const BOTH_VAULT = { ...RUNNER_OPS_VAULT, MACF_ROUTING_APP_ID: '7001', MACF_ROUTING_APP_KEY_B64: PEM_B64 };
  const AGENT_REPO_PRESENCE: Readonly<Record<string, Presence>> = { 'code-agent': 'present', 'science-agent': 'present', 'writing-agent': 'present' };

  it('1. drift detected -> onDrift is called exactly once for that target, naming the exact missing-repo set (this run WAITS on its result before returning)', async () => {
    const probeFn = async (_appId: string, _keyPath: string, _owner: string, repo: string): Promise<Presence> => (repo === 'trial-writing-agent' ? 'absent' : 'present');
    const readVaultFn = async () => RUNNER_OPS_VAULT;
    let resolvedAfterAwait = false;
    const onDrift = vi.fn(async (_target: InstallScopeCoverageTarget, entry: InstallScopeCoverageEntry) => {
      // Simulate a gate that hasn't been fixed yet — resolving keeps
      // `computeInstallScopeCoverage` waiting on this promise, never
      // racing ahead of it (asserted below via `resolvedAfterAwait`).
      await Promise.resolve();
      resolvedAfterAwait = true;
      return entry;
    });
    const result = await computeInstallScopeCoverage(fleet(), RUNNER_OPS_LOCK, AGENT_REPO_PRESENCE, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn, onDrift });

    expect(onDrift).toHaveBeenCalledTimes(1);
    expect(resolvedAfterAwait).toBe(true);
    const [target, entry] = onDrift.mock.calls[0]!;
    expect(target.role).toBe(RUNNER_OPS_ROLE);
    expect(entry.missingRepos).toEqual(['macf-experiment/trial-writing-agent']);
    expect(result[RUNNER_OPS_ROLE]?.status).toBe('drift');
  });

  it('2. no drift -> onDrift NEVER called, output unchanged ((1) alone would pass an implementation that always opens a gate)', async () => {
    const probeFn = async (): Promise<Presence> => 'present';
    const readVaultFn = async () => RUNNER_OPS_VAULT;
    const onDrift = vi.fn(async (_t: InstallScopeCoverageTarget, e: InstallScopeCoverageEntry) => e);
    const result = await computeInstallScopeCoverage(fleet(), RUNNER_OPS_LOCK, AGENT_REPO_PRESENCE, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn, onDrift });

    expect(onDrift).not.toHaveBeenCalled();
    expect(result[RUNNER_OPS_ROLE]?.status).toBe('covered');
  });

  it('coverage unknown (no resolvable credential) -> onDrift NEVER called — honest-unknown never opens a gate for a maybe-problem', async () => {
    const probeFn = vi.fn(async (): Promise<Presence> => {
      throw new Error('probeFn must not be called with no resolvable credential');
    });
    const onDrift = vi.fn(async (_t: InstallScopeCoverageTarget, e: InstallScopeCoverageEntry) => e);
    const result = await computeInstallScopeCoverage(fleet(), EMPTY_LOCK, {}, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn: async () => ({}), onDrift });

    expect(onDrift).not.toHaveBeenCalled();
    expect(Object.values(result).every((e) => e.status === 'unknown')).toBe(true);
  });

  it('two Apps drifting -> two onDrift calls, one per App, each naming its OWN disjoint missing-repo set (never one gate per missing repo)', async () => {
    const probeFn = async (_appId: string, _keyPath: string, _owner: string, repo: string): Promise<Presence> => (repo === 'trial-writing-agent' || repo === 'trial-control' ? 'absent' : 'present');
    const readVaultFn = async () => BOTH_VAULT;
    const onDrift = vi.fn(async (_t: InstallScopeCoverageTarget, e: InstallScopeCoverageEntry) => e);
    const result = await computeInstallScopeCoverage(fleet(), RUNNER_OPS_LOCK, AGENT_REPO_PRESENCE, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn, onDrift });

    expect(onDrift).toHaveBeenCalledTimes(2);
    const byRole = new Map(onDrift.mock.calls.map(([target, entry]) => [target.role, entry.missingRepos]));
    expect(byRole.get(RUNNER_OPS_ROLE)).toEqual(['macf-experiment/trial-writing-agent']);
    expect(byRole.get(ROUTER_APP_ROLE)).toEqual(['macf-experiment/trial-control']);
    expect(hasInstallScopeCoverageDrift(result)).toBe(true);
  });

  it('the entry handed to onDrift carries the EXACT same message the terminal report would print (#1174 single-message-source, never a second authored text)', async () => {
    const probeFn = async (_appId: string, _keyPath: string, _owner: string, repo: string): Promise<Presence> => (repo === 'trial-writing-agent' ? 'absent' : 'present');
    const readVaultFn = async () => RUNNER_OPS_VAULT;
    const onDrift = vi.fn(async (_t: InstallScopeCoverageTarget, e: InstallScopeCoverageEntry) => e);
    await computeInstallScopeCoverage(fleet(), RUNNER_OPS_LOCK, AGENT_REPO_PRESENCE, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn, onDrift });

    const [target, entry] = onDrift.mock.calls[0]!;
    expect(entry.message).toBe(installScopeCoverageDriftMessage(target.appHandle, entry.missingRepos));
  });

  it('a successful gate REPLACES the entry with covered — the final report prints nothing for this target', async () => {
    const probeFn = async (_appId: string, _keyPath: string, _owner: string, repo: string): Promise<Presence> => (repo === 'trial-writing-agent' ? 'absent' : 'present');
    const readVaultFn = async () => RUNNER_OPS_VAULT;
    const onDrift = async (target: InstallScopeCoverageTarget): Promise<InstallScopeCoverageEntry> => ({ ...target, status: 'covered', missingRepos: [], unverifiedRepos: [] });
    const result = await computeInstallScopeCoverage(fleet(), RUNNER_OPS_LOCK, AGENT_REPO_PRESENCE, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn, onDrift });

    expect(result[RUNNER_OPS_ROLE]?.status).toBe('covered');
    expect(result[RUNNER_OPS_ROLE]?.message).toBeUndefined();
  });

  it('onDrift throwing degrades to the original drift entry — never escapes computeInstallScopeCoverage\'s own never-throws contract', async () => {
    const probeFn = async (_appId: string, _keyPath: string, _owner: string, repo: string): Promise<Presence> => (repo === 'trial-writing-agent' ? 'absent' : 'present');
    const readVaultFn = async () => RUNNER_OPS_VAULT;
    const onDrift = async (): Promise<InstallScopeCoverageEntry> => {
      throw new Error('gate blew up');
    };
    const result = await computeInstallScopeCoverage(fleet(), RUNNER_OPS_LOCK, AGENT_REPO_PRESENCE, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn, onDrift });

    expect(result[RUNNER_OPS_ROLE]?.status).toBe('drift');
    expect(result[RUNNER_OPS_ROLE]?.missingRepos).toEqual(['macf-experiment/trial-writing-agent']);
  });

  it('status/plan-style callers that omit onDrift entirely stay inert — byte-identical to pre-#1220 behavior', async () => {
    const probeFn = async (_appId: string, _keyPath: string, _owner: string, repo: string): Promise<Presence> => (repo === 'trial-writing-agent' ? 'absent' : 'present');
    const readVaultFn = async () => RUNNER_OPS_VAULT;
    const result = await computeInstallScopeCoverage(fleet(), RUNNER_OPS_LOCK, AGENT_REPO_PRESENCE, 'present', { vaultPath: '/v', identityPath: '/k' }, { probeFn, readVaultFn });

    expect(result[RUNNER_OPS_ROLE]?.status).toBe('drift');
  });
});

// --- JSON shape ---

describe('installScopeCoverageEntryToJson', () => {
  it('snake_case, and omits `message` when covered', () => {
    const entry = evaluateInstallScopeCoverage(RUNNER_OPS_TARGET, ALL_PRESENT, {
      'macf-experiment/trial-code-agent': 'present',
      'macf-experiment/trial-science-agent': 'present',
      'macf-experiment/trial-writing-agent': 'present',
    });
    const json = installScopeCoverageEntryToJson(entry) as Record<string, unknown>;
    expect(json['app_handle']).toBe(RUNNER_OPS_TARGET.appHandle);
    expect(json['missing_repos']).toEqual([]);
    expect('message' in json).toBe(false);
  });
});
