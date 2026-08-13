/**
 * Tests for `teardown.ts` — DR-043 Amendment G, the fleet teardown ladder's
 * `deactivate` / `archive` reversible rungs (groundnuty/macf#867). Fully
 * offline: every dep is injected, no `gh` / network involved.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '@groundnuty/macf-core';
import type { GitHubVariablesClient } from '@groundnuty/macf-core';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import {
  buildArchivePlan,
  buildDeactivatePlan,
  computeArchiveRepoTargets,
  computeDeactivateInventory,
  computeDeactivateTargets,
  evaluateTeardownGate,
  executeArchiveRepos,
  executeDeactivate,
  resolveControlRepoOwnership,
  type DeactivateTarget,
  type TeardownControlRepoDeps,
  type TeardownRepoArchiveDeps,
  type TeardownVariableDeps,
} from '../../../src/cli/bootstrap/teardown.js';

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

// --- computeDeactivateTargets ---

describe('computeDeactivateTargets (pure)', () => {
  it('derives EXACTLY 4 targets for a 2-agent fleet: CA registry, one per agent, federated_cas', () => {
    const targets = computeDeactivateTargets(MANIFEST);
    expect(targets).toHaveLength(4);
    expect(targets.map((t) => t.kind)).toEqual(['ca_registry', 'agent_registration', 'agent_registration', 'federated_cas']);
  });

  it('the CA registry target is <SEG>_CA_CERT — same derivation apply-ca.ts::caCertVariableName uses', () => {
    const targets = computeDeactivateTargets(MANIFEST);
    expect(targets[0]).toEqual({ kind: 'ca_registry', name: 'MACF_EXPERIMENT_CA_CERT' });
  });

  it('the federated_cas target is <SEG>_FEDERATED_CAS', () => {
    const targets = computeDeactivateTargets(MANIFEST);
    expect(targets[3]).toEqual({ kind: 'federated_cas', name: 'MACF_EXPERIMENT_FEDERATED_CAS' });
  });

  it('one agent_registration target per manifest agent, in manifest order, each carrying its role', () => {
    const targets = computeDeactivateTargets(MANIFEST);
    const agentTargets = targets.filter((t) => t.kind === 'agent_registration');
    expect(agentTargets.map((t) => t.role)).toEqual(['code-agent', 'science-agent']);
  });

  // --- The highest-stakes pin in this file: the REAL registry-key formula ---
  //
  // Per this module's doc: the DR's own prose shorthand
  // (`MACF_<PROJECT>_AGENT_<NAME>`) reads differently from the ACTUAL
  // formula (`@groundnuty/macf-core`'s `registry.ts::createRegistry`) for
  // any project whose name isn't literally "macf". If `deactivate` had
  // hand-derived the target from that prose instead, it would compute a
  // name NO agent was ever actually registered under — the delete would
  // 404 ("already-absent") on every real key while reporting a clean run,
  // the exact silent-teardown shape the exact-key rail exists to prevent.
  // This test settles it against the REAL writer, not against prose.

  it('the agent_registration key EXACTLY matches what @groundnuty/macf-core::createRegistry actually deletes for that role', async () => {
    const deletedNames: string[] = [];
    const fakeClient: GitHubVariablesClient = {
      writeVariable: async () => {},
      readVariable: async () => null,
      listVariables: async () => [],
      deleteVariable: async (name) => {
        deletedNames.push(name);
      },
    };
    const registry = createRegistry(fakeClient, MANIFEST.metadata.name);

    for (const agent of MANIFEST.agents) {
      await registry.remove(agent.role);
    }

    const derivedNames = computeDeactivateTargets(MANIFEST)
      .filter((t): t is DeactivateTarget & { role: string } => t.kind === 'agent_registration')
      .map((t) => t.name);

    expect(derivedNames).toEqual(deletedNames);
    // Spelled out so a future reader sees the ACTUAL shape without cross-
    // referencing macf-core: no separate "MACF_" prefix — the fleet name's
    // OWN toVariableSegment IS the prefix.
    expect(deletedNames).toEqual(['MACF_EXPERIMENT_AGENT_CODE_AGENT', 'MACF_EXPERIMENT_AGENT_SCIENCE_AGENT']);
  });

  it('for the substrate project literally named "macf", the DR prose shorthand and the real formula happen to coincide (why the DR reads the way it does)', () => {
    const substrateManifest: FleetManifest = { ...MANIFEST, metadata: { name: 'macf' } };
    const targets = computeDeactivateTargets(substrateManifest);
    const codeAgentTarget = targets.find((t) => t.kind === 'agent_registration' && t.role === 'code-agent');
    expect(codeAgentTarget?.name).toBe('MACF_AGENT_CODE_AGENT');
  });
});

// --- computeArchiveRepoTargets ---

describe('computeArchiveRepoTargets (pure)', () => {
  it('is the control repo FIRST, then every agent repo in manifest order', () => {
    expect(computeArchiveRepoTargets(MANIFEST)).toEqual([
      'groundnuty/macf-experiment-control',
      'groundnuty/macf-experiment-code',
      'groundnuty/macf-experiment-science',
    ]);
  });
});

// --- evaluateTeardownGate ---

describe('evaluateTeardownGate (pure)', () => {
  it('ours -> allowed', () => {
    expect(evaluateTeardownGate(MANIFEST, { kind: 'ours' })).toEqual({ allowed: true, ownership: { kind: 'ours' } });
  });

  it('ours-archived -> allowed (order-independent on the teardown path — never folded into the refusal)', () => {
    expect(evaluateTeardownGate(MANIFEST, { kind: 'ours-archived' })).toEqual({ allowed: true, ownership: { kind: 'ours-archived' } });
  });

  it('absent -> refused, "nothing to tear down"', () => {
    const gate = evaluateTeardownGate(MANIFEST, { kind: 'absent' });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/nothing to tear down/);
  });

  it('foreign -> refused, cites the ownership reason', () => {
    const gate = evaluateTeardownGate(MANIFEST, { kind: 'foreign', reason: 'declares a different fleet' });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/declares a different fleet/);
  });

  it('unknown -> refused, "could not confirm"', () => {
    const gate = evaluateTeardownGate(MANIFEST, { kind: 'unknown' });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/could not confirm/);
  });
});

// --- resolveControlRepoOwnership ---

describe('resolveControlRepoOwnership', () => {
  function depsFor(overrides: Partial<TeardownControlRepoDeps> = {}): TeardownControlRepoDeps {
    return {
      checkMeta: async () => ({ presence: 'absent' }),
      readManifestFile: async () => undefined,
      ...overrides,
    };
  }

  it('present + matching fleet.yaml -> ours', async () => {
    const deps = depsFor({ checkMeta: async () => ({ presence: 'present', archived: false }), readManifestFile: async () => SAME_FLEET_YAML });
    expect(await resolveControlRepoOwnership(MANIFEST, deps)).toEqual({ kind: 'ours' });
  });

  it('present + archived + matching fleet.yaml -> ours-archived', async () => {
    const deps = depsFor({ checkMeta: async () => ({ presence: 'present', archived: true }), readManifestFile: async () => SAME_FLEET_YAML });
    expect(await resolveControlRepoOwnership(MANIFEST, deps)).toEqual({ kind: 'ours-archived' });
  });

  it('absent -> readManifestFile is NEVER called (nothing to read)', async () => {
    let readCalled = false;
    const deps = depsFor({ readManifestFile: async () => { readCalled = true; return undefined; } });
    const ownership = await resolveControlRepoOwnership(MANIFEST, deps);
    expect(ownership).toEqual({ kind: 'absent' });
    expect(readCalled).toBe(false);
  });
});

// --- computeDeactivateInventory ---

describe('computeDeactivateInventory', () => {
  it('checks presence per target against manifest.owner.registry, preserving target order', async () => {
    const targets = computeDeactivateTargets(MANIFEST);
    const seen: { registry: unknown; name: string }[] = [];
    const deps: Pick<TeardownVariableDeps, 'checkRegistryPresence'> = {
      checkRegistryPresence: async (registry, name) => {
        seen.push({ registry, name });
        return name === targets[0]?.name ? 'present' : 'absent';
      },
    };
    const inventory = await computeDeactivateInventory(MANIFEST, targets, deps);
    expect(inventory.map((e) => e.target.name)).toEqual(targets.map((t) => t.name));
    expect(inventory[0]?.presence).toBe('present');
    expect(inventory.slice(1).every((e) => e.presence === 'absent')).toBe(true);
    // Every check ran against the SAME registry object — never a repo path
    // (the interface has no repo-scope variant to accidentally reach).
    expect(seen.every((s) => s.registry === MANIFEST.owner.registry)).toBe(true);
  });
});

// --- buildDeactivatePlan / buildArchivePlan ---

describe('buildDeactivatePlan', () => {
  it('gate refused (foreign) -> inventory is EMPTY, no presence check attempted', async () => {
    let checkCalled = false;
    const deps: TeardownControlRepoDeps & Pick<TeardownVariableDeps, 'checkRegistryPresence'> = {
      checkMeta: async () => ({ presence: 'present', archived: false }),
      readManifestFile: async () => SAME_FLEET_YAML.replace('name: macf-experiment', 'name: some-other-fleet'),
      checkRegistryPresence: async () => {
        checkCalled = true;
        return 'unknown';
      },
    };
    const plan = await buildDeactivatePlan(MANIFEST, deps);
    expect(plan.gate.allowed).toBe(false);
    expect(plan.inventory).toEqual([]);
    expect(checkCalled).toBe(false);
  });

  it('gate allowed -> targets + inventory both populated', async () => {
    const deps: TeardownControlRepoDeps & Pick<TeardownVariableDeps, 'checkRegistryPresence'> = {
      checkMeta: async () => ({ presence: 'present', archived: false }),
      readManifestFile: async () => SAME_FLEET_YAML,
      checkRegistryPresence: async () => 'present',
    };
    const plan = await buildDeactivatePlan(MANIFEST, deps);
    expect(plan.gate.allowed).toBe(true);
    expect(plan.targets).toHaveLength(4);
    expect(plan.inventory).toHaveLength(4);
    expect(plan.fleet).toBe('macf-experiment');
  });
});

describe('buildArchivePlan', () => {
  it('includes buildDeactivatePlan\'s work PLUS repoTargets when the gate allows', async () => {
    const deps: TeardownControlRepoDeps & Pick<TeardownVariableDeps, 'checkRegistryPresence'> = {
      checkMeta: async () => ({ presence: 'present', archived: false }),
      readManifestFile: async () => SAME_FLEET_YAML,
      checkRegistryPresence: async () => 'absent',
    };
    const plan = await buildArchivePlan(MANIFEST, deps);
    expect(plan.gate.allowed).toBe(true);
    expect(plan.repoTargets).toEqual([
      'groundnuty/macf-experiment-control',
      'groundnuty/macf-experiment-code',
      'groundnuty/macf-experiment-science',
    ]);
  });

  it('gate refused -> repoTargets is EMPTY too', async () => {
    const deps: TeardownControlRepoDeps & Pick<TeardownVariableDeps, 'checkRegistryPresence'> = {
      checkMeta: async () => ({ presence: 'absent' }),
      readManifestFile: async () => undefined,
      checkRegistryPresence: async () => 'absent',
    };
    const plan = await buildArchivePlan(MANIFEST, deps);
    expect(plan.gate.allowed).toBe(false);
    expect(plan.repoTargets).toEqual([]);
  });
});

// --- executeDeactivate — the exact-key targeting rail ---

describe('executeDeactivate', () => {
  it('deletes EXACTLY the derived target set — deep-equal on the full sorted set, not membership (catches under-deletion, not just over-deletion)', async () => {
    const targets = computeDeactivateTargets(MANIFEST);
    const calls: { registry: unknown; name: string }[] = [];
    const deps: Pick<TeardownVariableDeps, 'deleteRegistryVariable'> = {
      deleteRegistryVariable: async (registry, name) => {
        calls.push({ registry, name });
        return 'deleted';
      },
    };
    const outcomes = await executeDeactivate(MANIFEST, targets, deps);
    expect(outcomes.every((o) => o.status === 'deleted')).toBe(true);
    expect(calls.map((c) => c.name).sort()).toEqual(targets.map((t) => t.name).sort());
  });

  it('ADVERSARIAL: a sibling fleet\'s SAME-PREFIXED registry key is never targeted — proves exact-key, not a prefix sweep', async () => {
    // macf-experiment-two's own agent registration + an unrelated CA cert
    // that a naive `MACF_EXPERIMENT`-prefix sweep WOULD catch (the second
    // one is a SUBSTRING match, not even a sibling fleet — a stress case
    // for "exact key" meaning exact, not "starts with our segment").
    const foreignKeys = ['MACF_EXPERIMENT_TWO_AGENT_CODE_AGENT', 'MACF_EXPERIMENT_LEGACY_CA_CERT'];
    const targets = computeDeactivateTargets(MANIFEST);
    const targetNames = new Set(targets.map((t) => t.name));
    // Sanity: none of our derived targets accidentally collide with the
    // foreign keys (would make this test meaningless).
    for (const k of foreignKeys) expect(targetNames.has(k)).toBe(false);

    const touchedNames: string[] = [];
    const deps: Pick<TeardownVariableDeps, 'deleteRegistryVariable'> = {
      deleteRegistryVariable: async (_registry, name) => {
        touchedNames.push(name);
        return 'deleted';
      },
    };
    await executeDeactivate(MANIFEST, targets, deps);

    for (const foreign of foreignKeys) {
      expect(touchedNames).not.toContain(foreign);
    }
    // And nothing beyond the derived 4 was ever touched, at all.
    expect(touchedNames).toHaveLength(4);
  });

  it('already-absent (404) is reported faithfully, NOT as a failure — deactivate is idempotent-on-rerun', async () => {
    const targets = computeDeactivateTargets(MANIFEST);
    const deps: Pick<TeardownVariableDeps, 'deleteRegistryVariable'> = {
      deleteRegistryVariable: async () => 'already-absent',
    };
    const outcomes = await executeDeactivate(MANIFEST, targets, deps);
    expect(outcomes.every((o) => o.status === 'already-absent')).toBe(true);
  });

  it('one target failing does NOT abort the rest — every target is attempted, failures isolated per-target', async () => {
    const targets = computeDeactivateTargets(MANIFEST);
    let calls = 0;
    const deps: Pick<TeardownVariableDeps, 'deleteRegistryVariable'> = {
      deleteRegistryVariable: async (_registry, name) => {
        calls += 1;
        if (name === targets[1]?.name) throw new Error('rate limited');
        return 'deleted';
      },
    };
    const outcomes = await executeDeactivate(MANIFEST, targets, deps);
    expect(calls).toBe(targets.length); // every target was attempted
    const failed = outcomes.filter((o) => o.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toMatch(/rate limited/);
    expect(outcomes.filter((o) => o.status === 'deleted')).toHaveLength(targets.length - 1);
  });

  it('every deleteRegistryVariable call carries manifest.owner.registry — structurally, this module cannot reach a repo-scoped path (no repo parameter exists on the interface)', async () => {
    const targets = computeDeactivateTargets(MANIFEST);
    const registriesSeen: unknown[] = [];
    const deps: Pick<TeardownVariableDeps, 'deleteRegistryVariable'> = {
      deleteRegistryVariable: async (registry) => {
        registriesSeen.push(registry);
        return 'deleted';
      },
    };
    await executeDeactivate(MANIFEST, targets, deps);
    expect(registriesSeen.every((r) => r === MANIFEST.owner.registry)).toBe(true);
  });
});

// --- executeArchiveRepos ---

describe('executeArchiveRepos', () => {
  it('archives every repo in the given order, all succeeding', async () => {
    const repos = computeArchiveRepoTargets(MANIFEST);
    const archived: string[] = [];
    const deps: TeardownRepoArchiveDeps = { archiveRepo: async (repo) => { archived.push(repo); } };
    const outcomes = await executeArchiveRepos(repos, deps);
    expect(outcomes.every((o) => o.status === 'archived')).toBe(true);
    expect(archived).toEqual(repos);
  });

  it('one repo failing does NOT abort the rest — every repo is attempted, failures isolated per-repo', async () => {
    const repos = computeArchiveRepoTargets(MANIFEST);
    const deps: TeardownRepoArchiveDeps = {
      archiveRepo: async (repo) => {
        if (repo === repos[1]) throw new Error('branch protection blocks archive');
      },
    };
    const outcomes = await executeArchiveRepos(repos, deps);
    expect(outcomes.filter((o) => o.status === 'archived')).toHaveLength(repos.length - 1);
    const failed = outcomes.filter((o) => o.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.repo).toBe(repos[1]);
    expect(failed[0]?.reason).toMatch(/branch protection/);
  });
});
