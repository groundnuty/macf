/**
 * The full DR-043 Amendment G teardown ladder, `deactivate` → `archive` →
 * `delete-apps`, driven END TO END against ONE shared, STATEFUL fake
 * backend (groundnuty/macf#917).
 *
 * **Why this file exists — separate from `teardown.test.ts` /
 * `teardown-destructive.test.ts`.** Both of those files test each rung in
 * ISOLATION: every `executeArchiveRepos` test constructs a FRESH fake
 * backend for that one call, so a bug that only appears when the SAME
 * repo is targeted a SECOND time by a LATER rung — after the FIRST rung
 * already mutated it — is invisible to a per-rung test suite no matter how
 * thorough. That is exactly the shape of the bug groundnuty/macf#917 fixes:
 * a real teardown run walked `deactivate` (ok) → `archive` (ok, repos now
 * archived) → `delete-apps` (FAILED — its own internal repo-archiving step
 * re-targeted the SAME now-already-archived repos and got a 403,
 * "Repository was archived so is read-only"). Amendment G's own module doc
 * frames the ladder as CUMULATIVE — `delete-apps` re-runs `archive`'s own
 * work internally — so a regression here is specifically a
 * re-run-after-a-prior-rung-already-mutated-state bug, which only a
 * SHARED-state, multi-rung test can catch.
 *
 * The fake backend below is intentionally adversarial about it: its
 * `archiveRepo` THROWS the real, observed error text
 * ("Repository was archived so is read-only (HTTP 403)") if it is EVER
 * called a second time on a repo it already archived — mirroring GitHub's
 * actual behavior byte-for-byte rather than a lenient stub that would let a
 * regression slip through unnoticed.
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { ControlRepoMeta } from '../../../src/cli/bootstrap/control-repo.js';
import {
  buildArchivePlan,
  buildDeactivatePlan,
  executeArchiveRepos,
  executeDeactivate,
} from '../../../src/cli/bootstrap/teardown.js';
import { buildDeleteAppsPlan, executeDeleteApps } from '../../../src/cli/bootstrap/teardown-destructive.js';

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
`;

/**
 * A minimal, STATEFUL fake of the real GitHub surface this ladder touches —
 * shared across all three rungs in the test below (never reset mid-test).
 * `archiveRepo` reproduces the ACTUAL live failure mode: a same-value PATCH
 * against an already-archived repo 403s, verbatim, rather than silently
 * succeeding — so this fake can only pass if the code under test genuinely
 * reads state before writing, not because the fake is lenient.
 */
function makeStatefulFakeBackend() {
  const registryVars = new Set(['MACF_EXPERIMENT_CA_CERT', 'MACF_EXPERIMENT_AGENT_CODE_AGENT', 'MACF_EXPERIMENT_AGENT_SCIENCE_AGENT', 'MACF_EXPERIMENT_FEDERATED_CAS']);
  const repoArchived = new Map<string, boolean>([
    ['groundnuty/macf-experiment-control', false],
    ['groundnuty/macf-experiment-code', false],
    ['groundnuty/macf-experiment-science', false],
  ]);

  const checkMeta = async (repo: string): Promise<ControlRepoMeta> => {
    if (!repoArchived.has(repo)) return { presence: 'absent' };
    return { presence: 'present', archived: repoArchived.get(repo) };
  };

  const archiveRepo = async (repo: string): Promise<void> => {
    if (repoArchived.get(repo) === true) {
      // The EXACT failure observed on a live teardown (groundnuty/macf#917) —
      // GitHub 403s a same-value PATCH against an already-archived repo.
      throw new Error(`gh api archive-repo failed for "${repo}": HTTP 403: Repository was archived so is read-only.`);
    }
    repoArchived.set(repo, true);
  };

  const deleteRegistryVariable = async (_registry: unknown, name: string): Promise<'deregistered' | 'absent'> => {
    if (registryVars.has(name)) {
      registryVars.delete(name);
      return 'deregistered';
    }
    return 'absent';
  };

  // groundnuty/macf#1033 — this ladder test predates the graceful-stop state
  // machine and is about REGISTRY/REPO re-run idempotency across the three
  // rungs, not agent liveness; every agent classifies 'dead' so every
  // agent_registration target keeps taking the SAME direct-delete path this
  // file's assertions already depend on.
  const checkRegistryPresence = async (_registry: unknown, name: string) => (registryVars.has(name) ? ('present' as const) : ('absent' as const));
  const checkAgentReachability = async () => 'dead' as const;
  const requestGracefulExit = async (): Promise<void> => {};
  const sleep = async (): Promise<void> => {};

  return { checkMeta, archiveRepo, deleteRegistryVariable, checkRegistryPresence, checkAgentReachability, requestGracefulExit, sleep, registryVars, repoArchived };
}

describe('the full ladder — deactivate -> archive -> delete-apps — runs clean end to end on one fleet (groundnuty/macf#917)', () => {
  it('walks all three rungs against ONE shared stateful backend without any rung failing on state a PRIOR rung already produced', async () => {
    const backend = makeStatefulFakeBackend();
    const controlRepoDeps = { checkMeta: backend.checkMeta, readManifestFile: async () => SAME_FLEET_YAML };

    // --- Rung 1: deactivate ---
    const deactivatePlan = await buildDeactivatePlan(MANIFEST, { ...controlRepoDeps, checkRegistryPresence: async () => 'present' });
    expect(deactivatePlan.gate.allowed).toBe(true);
    const deactivateOutcomes = await executeDeactivate(MANIFEST, deactivatePlan.targets, backend);
    expect(deactivateOutcomes.every((o) => o.status === 'deregistered')).toBe(true);
    expect(backend.registryVars.size).toBe(0); // every registry key genuinely gone now

    // --- Rung 2: archive (re-runs deactivate's registry deletion internally, per the CLI layer, PLUS archives repos) ---
    const archivePlan = await buildArchivePlan(MANIFEST, { ...controlRepoDeps, checkRegistryPresence: async () => 'absent' });
    expect(archivePlan.gate.allowed).toBe(true);
    const archiveRegistryOutcomes = await executeDeactivate(MANIFEST, archivePlan.targets, backend);
    // Registry keys are ALREADY gone from rung 1 — re-running must be a
    // faithful no-op, not a failure (the deactivate idempotency this ladder
    // also depends on).
    expect(archiveRegistryOutcomes.every((o) => o.status === 'absent')).toBe(true);
    const archiveRepoOutcomes = await executeArchiveRepos(archivePlan.repoTargets, backend);
    expect(archiveRepoOutcomes.every((o) => o.status === 'archived')).toBe(true);
    expect([...backend.repoArchived.values()].every((v) => v === true)).toBe(true); // every repo genuinely archived now

    // --- Rung 3: delete-apps (re-runs BOTH deactivate's registry deletion AND archive's repo-archiving internally) ---
    const deleteAppsPlan = await buildDeleteAppsPlan(MANIFEST, { ...controlRepoDeps, checkRegistryPresence: async () => 'absent' });
    expect(deleteAppsPlan.gate.allowed).toBe(true);
    const logs: string[] = [];
    const deleteAppsResult = await executeDeleteApps(MANIFEST, deleteAppsPlan, (l) => logs.push(l), backend);

    // THE regression assertion: every repo target — freshly re-derived,
    // already archived by rung 2 — comes back 'already-archived', NEVER
    // 'failed'. Before this fix, `backend.archiveRepo` above would have
    // thrown its simulated 403 for EVERY repo here, and this assertion
    // would have failed exactly like the live run did.
    expect(deleteAppsResult.repoOutcomes.every((o) => o.status === 'already-archived')).toBe(true);
    expect(deleteAppsResult.repoOutcomes.some((o) => o.status === 'failed')).toBe(false);

    // The registry re-run inside delete-apps is ALSO idempotent (rung 1 + 2
    // already cleared everything).
    expect(deleteAppsResult.registryOutcomes.every((o) => o.status === 'absent')).toBe(true);

    // The App-identity rung is unaffected by any of the above — it always
    // reports (no live check wired in this test), never claims deletion.
    expect(deleteAppsResult.appOutcomes).toHaveLength(2);
    expect(deleteAppsResult.appOutcomes.every((o) => o.status === 'manual-action-required')).toBe(true);
  });

  it('re-running EACH rung a second time in isolation is ALSO a no-op (per-rung idempotency, not just the cross-rung ladder walk)', async () => {
    const backend = makeStatefulFakeBackend();
    const controlRepoDeps = { checkMeta: backend.checkMeta, readManifestFile: async () => SAME_FLEET_YAML };

    const deactivatePlan = await buildDeactivatePlan(MANIFEST, { ...controlRepoDeps, checkRegistryPresence: async () => 'present' });
    await executeDeactivate(MANIFEST, deactivatePlan.targets, backend);
    const secondDeactivate = await executeDeactivate(MANIFEST, deactivatePlan.targets, backend);
    expect(secondDeactivate.every((o) => o.status === 'absent')).toBe(true);

    const archivePlan = await buildArchivePlan(MANIFEST, { ...controlRepoDeps, checkRegistryPresence: async () => 'absent' });
    await executeArchiveRepos(archivePlan.repoTargets, backend);
    const secondArchive = await executeArchiveRepos(archivePlan.repoTargets, backend);
    expect(secondArchive.every((o) => o.status === 'already-archived')).toBe(true);

    // executeDeleteApps is itself a composition (registry delete + repo
    // archive + App report) — re-run IT twice too, not just its two
    // sub-primitives in isolation above.
    const deleteAppsPlan = await buildDeleteAppsPlan(MANIFEST, { ...controlRepoDeps, checkRegistryPresence: async () => 'absent' });
    await executeDeleteApps(MANIFEST, deleteAppsPlan, () => {}, backend);
    const secondDeleteApps = await executeDeleteApps(MANIFEST, deleteAppsPlan, () => {}, backend);
    expect(secondDeleteApps.registryOutcomes.every((o) => o.status === 'absent')).toBe(true);
    expect(secondDeleteApps.repoOutcomes.every((o) => o.status === 'already-archived')).toBe(true);
  });
});
