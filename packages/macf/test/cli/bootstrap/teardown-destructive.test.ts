/**
 * Tests for `teardown-destructive.ts` — DR-043 Amendment G, the fleet
 * teardown ladder's IRREVERSIBLE `delete-apps` / `destroy` rungs
 * (groundnuty/macf#867). Fully offline: every dep is injected, no
 * `gh`/network involved.
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { TeardownControlRepoDeps, TeardownVariableDeps } from '../../../src/cli/bootstrap/teardown.js';
import {
  buildDeleteAppsPlan,
  buildDestroyPlan,
  evaluateDestroyAcknowledgments,
  evaluateShredRequest,
  executeDeleteApps,
  executeDestroy,
  executeDestroyRepos,
} from '../../../src/cli/bootstrap/teardown-destructive.js';

const MANIFEST: FleetManifest = {
  apiVersion: 'macf/v0',
  kind: 'Fleet',
  metadata: { name: 'macf-experiment' },
  owner: { account: 'groundnuty', type: 'org', registry: { type: 'org', org: 'macf-experiment' } },
  network: { advertise_host: 'example.ts.net' },
  transport: { age_recipients: ['age1operator'] },
  defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
  agents: [
    { role: 'code-agent', profile: 'code', repo: 'groundnuty/macf-experiment-code', deploy_path: '/x' },
    { role: 'science-agent', profile: 'research', repo: 'groundnuty/macf-experiment-science', deploy_path: '/y' },
  ],
  trust: { ca: 'per-project', federated_cas: [] },
};

const SAME_FLEET_YAML = `apiVersion: macf/v0
kind: Fleet
metadata:
  name: macf-experiment
owner:
  account: groundnuty
  type: org
  registry: { type: org, org: macf-experiment }
network:
  advertise_host: example.ts.net
transport:
  age_recipients: []
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/macf-experiment-code
    deploy_path: /x
  - role: science-agent
    profile: research
    repo: groundnuty/macf-experiment-science
    deploy_path: /y
trust:
  ca: per-project
  federated_cas: []
`;

function ownDeps(overrides: Partial<TeardownControlRepoDeps & Pick<TeardownVariableDeps, 'checkRegistryPresence'>> = {}) {
  return {
    checkMeta: async () => ({ presence: 'present' as const, archived: false }),
    readManifestFile: async () => SAME_FLEET_YAML,
    checkRegistryPresence: async () => 'present' as const,
    ...overrides,
  };
}

// --- buildDeleteAppsPlan / buildDestroyPlan — SAME derivation ---

describe('buildDeleteAppsPlan / buildDestroyPlan', () => {
  it('both derive the IDENTICAL target SETS for the same manifest (destroy never re-derives independently) — registryTargets/appTargets share ORDER too; repoTargets share only the SET (destroy deliberately reorders, see next test)', async () => {
    const deps = ownDeps();
    const deleteAppsPlan = await buildDeleteAppsPlan(MANIFEST, deps);
    const destroyPlan = await buildDestroyPlan(MANIFEST, deps);
    expect(destroyPlan.registryTargets).toEqual(deleteAppsPlan.registryTargets);
    expect(destroyPlan.appTargets).toEqual(deleteAppsPlan.appTargets);
    expect([...destroyPlan.repoTargets].sort()).toEqual([...deleteAppsPlan.repoTargets].sort());
  });

  it('destroy REORDERS repoTargets so the control repo is LAST (delete-apps/archive keep control FIRST — order-independent for archiving, load-bearing for deletion; see buildDestroyPlan\'s doc)', async () => {
    const deps = ownDeps();
    const deleteAppsPlan = await buildDeleteAppsPlan(MANIFEST, deps);
    const destroyPlan = await buildDestroyPlan(MANIFEST, deps);
    expect(deleteAppsPlan.repoTargets[0]).toBe('groundnuty/macf-experiment-control');
    expect(destroyPlan.repoTargets[destroyPlan.repoTargets.length - 1]).toBe('groundnuty/macf-experiment-control');
    expect(destroyPlan.repoTargets).toEqual(['groundnuty/macf-experiment-code', 'groundnuty/macf-experiment-science', 'groundnuty/macf-experiment-control']);
  });

  it('gate allowed -> registryTargets (4), repoTargets (3: control+2 agents), appTargets (2)', async () => {
    const plan = await buildDeleteAppsPlan(MANIFEST, ownDeps());
    expect(plan.gate.allowed).toBe(true);
    expect(plan.registryTargets).toHaveLength(4);
    expect(plan.repoTargets).toEqual(['groundnuty/macf-experiment-control', 'groundnuty/macf-experiment-code', 'groundnuty/macf-experiment-science']);
    expect(plan.appTargets.map((t) => t.role)).toEqual(['code-agent', 'science-agent']);
  });

  it('gate REFUSED (foreign) -> every target array is EMPTY, no presence check attempted', async () => {
    let checkCalled = false;
    const deps = ownDeps({
      readManifestFile: async () => SAME_FLEET_YAML.replace('name: macf-experiment', 'name: some-other-fleet'),
      checkRegistryPresence: async () => {
        checkCalled = true;
        return 'unknown';
      },
    });
    const plan = await buildDestroyPlan(MANIFEST, deps);
    expect(plan.gate.allowed).toBe(false);
    expect(plan.registryTargets).toHaveLength(4); // pure derivation still runs (never gated)
    expect(plan.registryInventory).toEqual([]);
    expect(plan.repoTargets).toEqual([]);
    expect(plan.appTargets).toEqual([]);
    expect(checkCalled).toBe(false);
  });

  it('ours-archived -> allowed (order-independent, same as the reversible half)', async () => {
    const plan = await buildDestroyPlan(MANIFEST, ownDeps({ checkMeta: async () => ({ presence: 'present', archived: true }) }));
    expect(plan.gate.allowed).toBe(true);
    expect(plan.gate.ownership).toEqual({ kind: 'ours-archived' });
  });
});

// --- fleet.lock App-ID enrichment (advisor-flagged: derived slug is a prediction, fleet.lock's app_id is the authority) ---

describe('buildDeleteAppsPlan / buildDestroyPlan — readFleetLock enrichment', () => {
  const LOCK_YAML = `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
  - role: science-agent
    app_id: "555222"
    install_id: "999333"
`;

  it('readFleetLock OMITTED entirely -> appTargets carry NO appId (backward compatible, never a new precondition)', async () => {
    const plan = await buildDeleteAppsPlan(MANIFEST, ownDeps());
    expect(plan.appTargets.every((t) => t.appId === undefined)).toBe(true);
  });

  it('readFleetLock provided + resolves a matching fleet.lock -> appTargets carry the recorded appId per role', async () => {
    let calledWith: string | undefined;
    const plan = await buildDeleteAppsPlan(MANIFEST, {
      ...ownDeps(),
      readFleetLock: async (repo) => {
        calledWith = repo;
        return LOCK_YAML;
      },
    });
    expect(calledWith).toBe('groundnuty/macf-experiment-control');
    expect(plan.appTargets.find((t) => t.role === 'code-agent')?.appId).toBe('555111');
    expect(plan.appTargets.find((t) => t.role === 'science-agent')?.appId).toBe('555222');
  });

  it('readFleetLock resolves undefined (no lock committed yet) -> degrades gracefully, appTargets unchanged, never throws', async () => {
    const plan = await buildDestroyPlan(MANIFEST, { ...ownDeps(), readFleetLock: async () => undefined });
    expect(plan.appTargets.every((t) => t.appId === undefined)).toBe(true);
  });

  it('gate REFUSED -> readFleetLock is NEVER called (no point enriching targets that are already empty)', async () => {
    let called = false;
    const plan = await buildDestroyPlan(MANIFEST, {
      ...ownDeps({ checkMeta: async () => ({ presence: 'absent' }) }),
      readFleetLock: async () => {
        called = true;
        return undefined;
      },
    });
    expect(plan.gate.allowed).toBe(false);
    expect(called).toBe(false);
  });

  it('delete-apps and destroy enrich IDENTICALLY (same call, same result modulo repo-target order)', async () => {
    const deps = { ...ownDeps(), readFleetLock: async () => LOCK_YAML };
    const deleteAppsPlan = await buildDeleteAppsPlan(MANIFEST, deps);
    const destroyPlan = await buildDestroyPlan(MANIFEST, deps);
    expect(destroyPlan.appTargets).toEqual(deleteAppsPlan.appTargets);
  });
});

// --- executeDeleteApps ---

describe('executeDeleteApps', () => {
  it('deletes EXACTLY the registry targets, ARCHIVES (never deletes) EXACTLY the repo targets, and reports EVERY App target as manual-action-required', async () => {
    const plan = await buildDeleteAppsPlan(MANIFEST, ownDeps());
    const deletedNames: string[] = [];
    const archivedRepos: string[] = [];
    const logs: string[] = [];
    const result = await executeDeleteApps(MANIFEST, plan, (l) => logs.push(l), {
      deleteRegistryVariable: async (_r, name) => {
        deletedNames.push(name);
        return 'deleted';
      },
      checkMeta: async () => ({ presence: 'present', archived: false }),
      archiveRepo: async (repo) => {
        archivedRepos.push(repo);
      },
    });
    expect(deletedNames.sort()).toEqual(plan.registryTargets.map((t) => t.name).sort());
    expect(archivedRepos).toEqual(plan.repoTargets);
    expect(result.appOutcomes).toHaveLength(2);
    expect(result.appOutcomes.every((o) => o.status === 'manual-action-required')).toBe(true);
  });

  it('never calls a repo-DELETE primitive — delete-apps only archives', async () => {
    const plan = await buildDeleteAppsPlan(MANIFEST, ownDeps());
    // deps for executeDeleteApps has no deleteRepo field at all — if the
    // implementation ever reached for one, this would be a TYPE error, not
    // just a runtime one. This test documents that structural guarantee.
    const result = await executeDeleteApps(MANIFEST, plan, () => {}, {
      deleteRegistryVariable: async () => 'deleted',
      checkMeta: async () => ({ presence: 'present', archived: false }),
      archiveRepo: async () => {},
    });
    expect(result.repoOutcomes.every((o) => o.status === 'archived')).toBe(true);
  });
});

// --- evaluateDestroyAcknowledgments — the friction ladder ---

describe('evaluateDestroyAcknowledgments (pure)', () => {
  const ALL_GOOD = { destroyRepositoriesFlag: true, envAck: true, typedFleetName: 'macf-experiment' };

  it('all three present + typed name matches EXACTLY -> allowed', () => {
    expect(evaluateDestroyAcknowledgments('macf-experiment', ALL_GOOD)).toEqual({ allowed: true, missing: [] });
  });

  it('flag missing -> refused, cites the flag, EVEN THOUGH env + typed name are correct', () => {
    const result = evaluateDestroyAcknowledgments('macf-experiment', { ...ALL_GOOD, destroyRepositoriesFlag: false });
    expect(result.allowed).toBe(false);
    expect(result.missing.some((m) => m.includes('--destroy-repositories'))).toBe(true);
  });

  it('env ack missing -> refused, cites the env var, EVEN THOUGH flag + typed name are correct', () => {
    const result = evaluateDestroyAcknowledgments('macf-experiment', { ...ALL_GOOD, envAck: false });
    expect(result.allowed).toBe(false);
    expect(result.missing.some((m) => m.includes('MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES'))).toBe(true);
  });

  it('typed name WRONG -> refused, cites the mismatch, EVEN THOUGH flag + env are correct', () => {
    const result = evaluateDestroyAcknowledgments('macf-experiment', { ...ALL_GOOD, typedFleetName: 'macf-experimant' });
    expect(result.allowed).toBe(false);
    expect(result.missing.some((m) => m.includes('did not exactly match'))).toBe(true);
  });

  it('typed name EMPTY (never prompted) -> refused', () => {
    const result = evaluateDestroyAcknowledgments('macf-experiment', { ...ALL_GOOD, typedFleetName: '' });
    expect(result.allowed).toBe(false);
  });

  it('ALL THREE missing at once -> refused with THREE distinct reasons — aggregate, not stop-at-first', () => {
    const result = evaluateDestroyAcknowledgments('macf-experiment', { destroyRepositoriesFlag: false, envAck: false, typedFleetName: '' });
    expect(result.allowed).toBe(false);
    expect(result.missing).toHaveLength(3);
  });

  it('a partial-string match (case/substring) does NOT satisfy the typed-name gate — exact match only', () => {
    const result = evaluateDestroyAcknowledgments('macf-experiment', { ...ALL_GOOD, typedFleetName: 'MACF-EXPERIMENT' });
    expect(result.allowed).toBe(false);
  });
});

// --- evaluateShredRequest — opt-in, never implied ---

describe('evaluateShredRequest (pure)', () => {
  it('not requested -> proceed: false, no reason (silent no-op is correct when never asked)', () => {
    expect(evaluateShredRequest({ shredRequested: false, identityPath: undefined })).toEqual({ proceed: false });
  });

  it('requested WITHOUT an identity path -> refuses, does NOT guess a location', () => {
    const decision = evaluateShredRequest({ shredRequested: true, identityPath: undefined });
    expect(decision.proceed).toBe(false);
    expect(decision.reason).toMatch(/--age-identity/);
  });

  it('requested with an EMPTY-STRING identity path -> refuses (empty is not a path)', () => {
    const decision = evaluateShredRequest({ shredRequested: true, identityPath: '' });
    expect(decision.proceed).toBe(false);
  });

  it('requested WITH a path -> proceeds, only THEN', () => {
    expect(evaluateShredRequest({ shredRequested: true, identityPath: '/home/op/.age/identity.txt' })).toEqual({ proceed: true });
  });

  it('never implied by other destroy flags — `--destroy-repositories` alone gives shredRequested: false', () => {
    // This is really documentation-as-test: the CALLER controls
    // `shredRequested`, sourced ONLY from a dedicated --shred-age-key flag
    // (see fleet-teardown-destructive.ts), never derived from
    // destroyRepositoriesFlag/envAck. Nothing in this pure function could
    // accidentally flip proceed:true from unrelated inputs.
    expect(evaluateShredRequest({ shredRequested: false, identityPath: '/home/op/.age/identity.txt' })).toEqual({ proceed: false });
  });
});

// --- executeDestroyRepos — the irreversible action itself ---

describe('executeDestroyRepos', () => {
  it('deletes every repo in order, all succeeding', async () => {
    const repos = ['groundnuty/macf-experiment-control', 'groundnuty/macf-experiment-code'];
    const deleted: string[] = [];
    const outcomes = await executeDestroyRepos(repos, { deleteRepo: async (r) => { deleted.push(r); return 'deleted'; } });
    expect(outcomes.every((o) => o.status === 'deleted')).toBe(true);
    expect(deleted).toEqual(repos);
  });

  it('one repo failing does NOT abort the rest — every repo attempted, failures isolated per-repo', async () => {
    const repos = ['groundnuty/macf-experiment-control', 'groundnuty/macf-experiment-code', 'groundnuty/macf-experiment-science'];
    const outcomes = await executeDestroyRepos(repos, {
      deleteRepo: async (r) => {
        if (r === repos[1]) throw new Error('branch protection blocks delete');
        return 'deleted';
      },
    });
    expect(outcomes.filter((o) => o.status === 'deleted')).toHaveLength(2);
    const failed = outcomes.filter((o) => o.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.repo).toBe(repos[1]);
    expect(failed[0]?.reason).toMatch(/branch protection/);
  });

  it('ADVERSARIAL: a sibling fleet\'s SAME-PREFIXED repo name is never targeted — the destroy target set is exact-derived, not a pattern sweep', async () => {
    const plan = await buildDestroyPlan(MANIFEST, ownDeps());
    const foreignRepos = ['groundnuty/macf-experiment-two-control', 'groundnuty/macf-experiment-legacy-code'];
    for (const f of foreignRepos) expect(plan.repoTargets).not.toContain(f);

    const touched: string[] = [];
    await executeDestroyRepos(plan.repoTargets, { deleteRepo: async (r) => { touched.push(r); return 'deleted'; } });
    for (const f of foreignRepos) expect(touched).not.toContain(f);
    expect(touched).toHaveLength(3);
    expect(touched.sort()).toEqual([...plan.repoTargets].sort());
  });

  // --- groundnuty/macf#917 — destroy's idempotency ruling: DELETE-404 is benign success ---

  it('already-absent (404 on delete) is reported faithfully, NOT as a failure — destroy is idempotent-on-rerun, same shape as deactivate', async () => {
    const repos = ['groundnuty/macf-experiment-control', 'groundnuty/macf-experiment-code'];
    const outcomes = await executeDestroyRepos(repos, { deleteRepo: async () => 'already-absent' });
    expect(outcomes.every((o) => o.status === 'already-absent')).toBe(true);
  });

  it('the idempotency ruling is scoped to a PARTIAL-failure re-run — once the control repo is genuinely gone (a fully successful destroy), the OWNERSHIP GATE refuses the next run with "nothing to tear down," this function is never reached at all', async () => {
    // checkMeta now reads 'absent' for the control repo — the honest state
    // AFTER a fully successful destroy, not a partial one.
    const plan = await buildDestroyPlan(MANIFEST, ownDeps({ checkMeta: async () => ({ presence: 'absent' }) }));
    expect(plan.gate.allowed).toBe(false);
    expect(plan.gate.reason).toMatch(/nothing to tear down/);
    expect(plan.repoTargets).toEqual([]); // no targets derived past a refused gate — executeDestroyRepos is never called
  });
});

// --- executeDestroy — the full mutating composition ---

describe('executeDestroy', () => {
  it('registry deletion + App report + repo DELETION, all against the exact derived plan', async () => {
    const plan = await buildDestroyPlan(MANIFEST, ownDeps());
    const deletedVars: string[] = [];
    const deletedRepos: string[] = [];
    const result = await executeDestroy(MANIFEST, plan, () => {}, {
      deleteRegistryVariable: async (_r, name) => {
        deletedVars.push(name);
        return 'deleted';
      },
      deleteRepo: async (repo) => {
        deletedRepos.push(repo);
        return 'deleted';
      },
    });
    expect(deletedVars.sort()).toEqual(plan.registryTargets.map((t) => t.name).sort());
    expect(deletedRepos).toEqual(plan.repoTargets);
    expect(result.repoOutcomes.every((o) => o.status === 'deleted')).toBe(true);
    expect(result.appOutcomes).toHaveLength(2);
    expect(result.appOutcomes.every((o) => o.status === 'manual-action-required')).toBe(true);
  });
});
