/**
 * Tests for `macf fleet deactivate` / `macf fleet archive` — DR-043
 * Amendment G (groundnuty/macf#867). Fully offline: every dep is injected
 * (`FleetTeardownDeps`), no `gh` / network / stdin involved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runFleetArchive,
  runFleetDeactivate,
  reachabilityFor,
  agentStopDepsOverSeams,
  type FleetTeardownDeps,
} from '../../src/cli/commands/fleet-teardown.js';
import type { VmDriverSeams } from '../../src/cli/fleet/vm-driver.js';

const FLEET_YAML = `apiVersion: macf/v0
kind: Fleet
metadata:
  name: demo-fleet
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
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
    repo: groundnuty/demo-code
    deploy_path: /x
trust:
  ca: per-project
  federated_cas: []
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeManifest(body = FLEET_YAML): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-teardown-test-'));
  dirs.push(dir);
  const p = join(dir, 'fleet.yaml');
  writeFileSync(p, body);
  return p;
}

/**
 * Gate allowed (`ours`) by default; every mutating call throws unless a test
 * overrides it — surfaces an unexpected touch immediately.
 *
 * `checkAgentReachability` defaults to `'dead'` (groundnuty/macf#1033) —
 * every `agent_registration` target keeps taking the SAME direct-delete
 * path these pre-#1033 tests already assert on; tests exercising the new
 * stop-then-verify-else-fallback state machine override it explicitly.
 */
function depsFor(overrides: Partial<FleetTeardownDeps> = {}): FleetTeardownDeps {
  return {
    checkMeta: async () => ({ presence: 'present', archived: false }),
    readManifestFile: async () => FLEET_YAML,
    checkRegistryPresence: async () => 'present',
    deleteRegistryVariable: async () => 'deleted',
    archiveRepo: async () => {
      throw new Error('must not be called — this test did not override archiveRepo');
    },
    confirm: async () => true,
    checkAgentReachability: async () => 'dead',
    requestGracefulExit: async () => {
      throw new Error('must not be called — this test did not override requestGracefulExit (default reachability is dead)');
    },
    sleep: async () => {},
    ...overrides,
  };
}

function captureConsole(): { logs: string[]; errs: string[]; restore: () => void } {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  // `runFleetDeactivate`/`runFleetArchive` narrate the plan/gate to
  // `process.stderr.write` directly (same "stdout is data, stderr is
  // narration" split `bootstrap-apply.ts` uses) — captured here too so
  // tests can assert on the refusal reason without caring which stream it
  // landed on.
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(' '));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errs.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    logs,
    errs,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
      process.stderr.write = origStderrWrite;
    },
  };
}

describe('runFleetDeactivate', () => {
  it('manifest not found -> exit 1, never touches deleteRegistryVariable', async () => {
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate({ file: '/definitely/not/a/real/path/fleet.yaml' }, depsFor());
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('manifest invalid -> exit 1', async () => {
    const cap = captureConsole();
    try {
      const file = writeManifest('not: [valid, fleet, yaml');
      const code = await runFleetDeactivate({ file }, depsFor());
      expect(code).toBe(1);
    } finally {
      cap.restore();
    }
  });

  it('gate REFUSED (foreign) -> exit 1, deleteRegistryVariable NEVER called, confirm NEVER asked', async () => {
    const file = writeManifest();
    let deleteCalled = false;
    let confirmCalled = false;
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate(
        { file, yes: true },
        depsFor({
          checkMeta: async () => ({ presence: 'present', archived: false }),
          readManifestFile: async () => FLEET_YAML.replace('name: demo-fleet', 'name: some-other-fleet'),
          deleteRegistryVariable: async () => {
            deleteCalled = true;
            return 'deleted';
          },
          confirm: async () => {
            confirmCalled = true;
            return true;
          },
        }),
      );
      expect(code).toBe(1);
      expect(deleteCalled).toBe(false);
      expect(confirmCalled).toBe(false);
      expect(cap.errs.join('\n') + cap.logs.join('\n')).toMatch(/⚠ REFUSED/);
    } finally {
      cap.restore();
    }
  });

  it('gate allowed + operator DECLINES -> exit 1, nothing deleted', async () => {
    const file = writeManifest();
    let deleteCalled = false;
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate(
        { file },
        depsFor({
          deleteRegistryVariable: async () => {
            deleteCalled = true;
            return 'deleted';
          },
          confirm: async () => false,
        }),
      );
      expect(code).toBe(1);
      expect(deleteCalled).toBe(false);
    } finally {
      cap.restore();
    }
  });

  it('gate allowed + --yes -> deletes every derived target, exit 0', async () => {
    const file = writeManifest();
    const deleted: string[] = [];
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate(
        { file, yes: true },
        depsFor({
          deleteRegistryVariable: async (_registry, name) => {
            deleted.push(name);
            return 'deleted';
          },
        }),
      );
      expect(code).toBe(0);
      // CA registry + 1 agent registration + federated_cas = 3 targets for this 1-agent fleet.
      expect(deleted.sort()).toEqual(['DEMO_FLEET_AGENT_CODE_AGENT', 'DEMO_FLEET_CA_CERT', 'DEMO_FLEET_FEDERATED_CAS'].sort());
    } finally {
      cap.restore();
    }
  });

  it('a delete failure -> exit 1, reported (never exits green)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate(
        { file, yes: true },
        depsFor({
          deleteRegistryVariable: async () => {
            throw new Error('rate limited');
          },
        }),
      );
      expect(code).toBe(1);
      expect(cap.logs.join('\n')).toMatch(/FAILED/);
      expect(cap.logs.join('\n')).toMatch(/rate limited/);
    } finally {
      cap.restore();
    }
  });

  it('already-absent targets do NOT fail the run — deactivate is idempotent-on-rerun (e.g. federated_cas, which nothing writes yet)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate({ file, yes: true }, depsFor({ deleteRegistryVariable: async () => 'already-absent' }));
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
  });

  it('--json emits a valid, non-empty schema-versioned object on both success and refusal', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate({ file, yes: true, json: true }, depsFor());
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.logs.join('\n')) as { schema_version: number; mode: string; fleet: string; outcomes: unknown[] };
      expect(parsed.schema_version).toBe(1);
      expect(parsed.mode).toBe('deactivate');
      expect(parsed.fleet).toBe('demo-fleet');
      expect(parsed.outcomes).toHaveLength(3);
    } finally {
      cap.restore();
    }
  });

  it('--json on a refused gate STILL emits a valid, non-empty object (never empty stdout — macf#830 lesson)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate(
        { file, yes: true, json: true },
        depsFor({ checkMeta: async () => ({ presence: 'absent' }) }),
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.logs.join('\n')) as { schema_version: number; gate: { allowed: boolean } };
      expect(parsed.schema_version).toBe(1);
      expect(parsed.gate.allowed).toBe(false);
    } finally {
      cap.restore();
    }
  });

  // --- groundnuty/macf#1033 — the CLI-layer wiring of the stop-then-verify-else-fallback state machine ---

  it('a LIVE agent -> requestGracefulExit fires, its slot self-clears, deleteRegistryVariable is NEVER called for that role, exit 0', async () => {
    const file = writeManifest();
    const gracefulExitRoles: string[] = [];
    const deletedNames: string[] = [];
    let presencePolls = 0;
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate(
        { file, yes: true },
        depsFor({
          checkAgentReachability: async () => 'alive',
          requestGracefulExit: async (role) => {
            gracefulExitRoles.push(role);
          },
          checkRegistryPresence: async () => {
            presencePolls += 1;
            return presencePolls >= 2 ? 'absent' : 'present';
          },
          deleteRegistryVariable: async (_registry, name) => {
            deletedNames.push(name);
            return 'deleted';
          },
        }),
      );
      expect(code).toBe(0);
      expect(gracefulExitRoles).toEqual(['code-agent']);
      expect(deletedNames).not.toContain('DEMO_FLEET_AGENT_CODE_AGENT');
      expect(cap.logs.join('\n')).toMatch(/SELF-DEREGISTERED/);
      expect(cap.logs.join('\n')).toMatch(/stopped \+ self-deregistered:\s+1/);
    } finally {
      cap.restore();
    }
  });

  it('an UNREACHABLE agent -> reported unknown/unreachable, delete NEVER attempted, exit STAYS 0 (an honest partial view, not a failure)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate(
        { file, yes: true },
        depsFor({
          checkAgentReachability: async () => 'unknown',
          deleteRegistryVariable: async (_registry, name) => {
            if (name === 'DEMO_FLEET_AGENT_CODE_AGENT') throw new Error('must not be called for an unreachable agent');
            return 'deleted';
          },
        }),
      );
      expect(code).toBe(0);
      expect(cap.logs.join('\n')).toMatch(/UNREACHABLE/);
      expect(cap.logs.join('\n')).toMatch(/unreachable \(unknown — never assumed stopped\):\s+1/);
    } finally {
      cap.restore();
    }
  });

  it('a LIVE agent that never confirms self-deregister -> stop-unconfirmed, status FAILED, exit 1, direct-delete still never called', async () => {
    const file = writeManifest();
    const deletedNames: string[] = [];
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate(
        { file, yes: true },
        depsFor({
          checkAgentReachability: async () => 'alive',
          requestGracefulExit: async () => {},
          checkRegistryPresence: async () => 'present', // never confirms
          deleteRegistryVariable: async (_registry, name) => {
            deletedNames.push(name);
            return 'deleted';
          },
        }),
      );
      expect(code).toBe(1);
      expect(deletedNames).not.toContain('DEMO_FLEET_AGENT_CODE_AGENT');
      expect(cap.logs.join('\n')).toMatch(/did not self-deregister/);
    } finally {
      cap.restore();
    }
  });

  it('the reachability preview is rendered BEFORE the confirmation prompt (the operator sees what will be stopped before approving)', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    let confirmCalledAfterPreview = false;
    try {
      await runFleetDeactivate(
        { file },
        depsFor({
          checkAgentReachability: async () => 'alive',
          requestGracefulExit: async () => {},
          checkRegistryPresence: async () => 'absent',
          confirm: async () => {
            // By the time confirm() runs, the reachability preview line must
            // already be in the captured stream.
            confirmCalledAfterPreview = cap.errs.join('\n').includes('Live-agent reachability');
            return false;
          },
        }),
      );
      expect(confirmCalledAfterPreview).toBe(true);
      expect(cap.errs.join('\n')).toMatch(/will be asked to exit gracefully \(\/exit\)/);
    } finally {
      cap.restore();
    }
  });

  it('--json carries agent_stop_summary with all four categories present and summing to the agent count', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetDeactivate(
        { file, yes: true, json: true },
        depsFor({
          checkAgentReachability: async () => 'unknown',
        }),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.logs.join('\n')) as {
        agent_stop_summary: Record<string, number> | null;
      };
      expect(parsed.agent_stop_summary).toEqual({
        'stopped-self-deregistered': 0,
        'deregistered-directly': 0,
        unreachable: 1,
        'stop-unconfirmed': 0,
      });
    } finally {
      cap.restore();
    }
  });
});

describe('runFleetArchive', () => {
  it('gate allowed + --yes -> deletes registry targets AND archives control + agent repos', async () => {
    const file = writeManifest();
    const deleted: string[] = [];
    const archived: string[] = [];
    const cap = captureConsole();
    try {
      const code = await runFleetArchive(
        { file, yes: true },
        depsFor({
          deleteRegistryVariable: async (_registry, name) => {
            deleted.push(name);
            return 'deleted';
          },
          archiveRepo: async (repo) => {
            archived.push(repo);
          },
        }),
      );
      expect(code).toBe(0);
      expect(deleted).toHaveLength(3);
      expect(archived).toEqual(['groundnuty/demo-fleet-control', 'groundnuty/demo-code']);
    } finally {
      cap.restore();
    }
  });

  it('gate REFUSED -> exit 1, NEITHER deleteRegistryVariable NOR archiveRepo is ever called', async () => {
    const file = writeManifest();
    let deleteCalled = false;
    let archiveCalled = false;
    const cap = captureConsole();
    try {
      const code = await runFleetArchive(
        { file, yes: true },
        depsFor({
          checkMeta: async () => ({ presence: 'absent' }),
          readManifestFile: async () => undefined,
          deleteRegistryVariable: async () => {
            deleteCalled = true;
            return 'deleted';
          },
          archiveRepo: async () => {
            archiveCalled = true;
          },
        }),
      );
      expect(code).toBe(1);
      expect(deleteCalled).toBe(false);
      expect(archiveCalled).toBe(false);
    } finally {
      cap.restore();
    }
  });

  it('operator DECLINES -> exit 1, nothing removed or archived', async () => {
    const file = writeManifest();
    let archiveCalled = false;
    const cap = captureConsole();
    try {
      const code = await runFleetArchive(
        { file },
        depsFor({
          archiveRepo: async () => {
            archiveCalled = true;
          },
          confirm: async () => false,
        }),
      );
      expect(code).toBe(1);
      expect(archiveCalled).toBe(false);
    } finally {
      cap.restore();
    }
  });

  it('a repo-archive failure -> exit 1, even though every registry target succeeded', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetArchive(
        { file, yes: true },
        depsFor({
          archiveRepo: async (repo) => {
            if (repo.endsWith('-control')) throw new Error('branch protection blocks archive');
          },
        }),
      );
      expect(code).toBe(1);
      expect(cap.logs.join('\n')).toMatch(/branch protection/);
    } finally {
      cap.restore();
    }
  });

  it('archiving an ALREADY-ARCHIVED fleet (ours-archived) is idempotent — allowed, not refused', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetArchive(
        { file, yes: true },
        depsFor({
          checkMeta: async () => ({ presence: 'present', archived: true }),
          archiveRepo: async () => {},
        }),
      );
      expect(code).toBe(0);
    } finally {
      cap.restore();
    }
  });

  // --- groundnuty/macf#917 — the state-read invariant at the CLI layer: the PATCH seam is never even reached ---

  it('every repo is ALREADY archived (checkMeta confirms it) -> exit 0, repo outcomes report ALREADY-ARCHIVED, and the archiveRepo (PATCH) seam is NEVER called', async () => {
    const file = writeManifest();
    let archiveRepoCalled = false;
    const cap = captureConsole();
    try {
      const code = await runFleetArchive(
        { file, yes: true },
        depsFor({
          checkMeta: async () => ({ presence: 'present', archived: true }),
          archiveRepo: async () => {
            archiveRepoCalled = true;
          },
        }),
      );
      expect(code).toBe(0);
      expect(archiveRepoCalled).toBe(false);
      expect(cap.logs.join('\n')).toMatch(/ALREADY-ARCHIVED/);
    } finally {
      cap.restore();
    }
  });

  it('--json on an already-archived fleet -> repo_outcomes carry status "already-archived" for every repo', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetArchive(
        { file, yes: true, json: true },
        depsFor({ checkMeta: async () => ({ presence: 'present', archived: true }), archiveRepo: async () => {} }),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.logs.join('\n')) as { repo_outcomes: { repo: string; status: string }[] };
      expect(parsed.repo_outcomes).toHaveLength(2);
      expect(parsed.repo_outcomes.every((o) => o.status === 'already-archived')).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('--json emits repo_outcomes alongside the variable outcomes', async () => {
    const file = writeManifest();
    const cap = captureConsole();
    try {
      const code = await runFleetArchive({ file, yes: true, json: true }, depsFor({ archiveRepo: async () => {} }));
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.logs.join('\n')) as { mode: string; repo_outcomes: { repo: string; status: string }[] };
      expect(parsed.mode).toBe('archive');
      expect(parsed.repo_outcomes).toHaveLength(2);
      expect(parsed.repo_outcomes.every((o) => o.status === 'archived')).toBe(true);
    } finally {
      cap.restore();
    }
  });
});

// --- groundnuty/macf#1033 — reachabilityFor / agentStopDepsOverSeams over the
// PRODUCTION seam (VmDriverSeams), not the TeardownAgentDeps fake one level
// removed from it. Every test above this point injects TeardownAgentDeps
// directly, so `resolveTarget`'s role-name-form resolution (fleet.yaml's
// kebab `agents[].role` vs whatever `discoverWorkspaces()` puts in
// `WorkspaceRecord.agent`) is never exercised by the suite otherwise — see
// `assert-the-wrong-path.md` + vm-driver.ts's own macf#708 docblock, which
// documents exactly this class of silent name-form mismatch. ---

/** Every field `reachabilityFor`/`agentStopDepsOverSeams` does NOT read throws if called — surfaces an unexpected touch immediately. */
function minimalSeams(overrides: Partial<VmDriverSeams> = {}): { seams: VmDriverSeams; submits: { session: string; text: string }[] } {
  const submits: { session: string; text: string }[] = [];
  const unexpected = (name: string) => () => {
    throw new Error(`must not be called — reachabilityFor/agentStopDepsOverSeams never reaches '${name}'`);
  };
  const seams: VmDriverSeams = {
    discover: () => [],
    readConfig: () => null,
    hasSession: () => false,
    submit: (session, text) => submits.push({ session, text }),
    listPeers: unexpected('listPeers'),
    probeHealth: unexpected('probeHealth'),
    capturePane: unexpected('capturePane'),
    exec: unexpected('exec'),
    spawnDetached: unexpected('spawnDetached'),
    sleep: unexpected('sleep'),
    isConfigDirty: unexpected('isConfigDirty'),
    listDirtyConfig: unexpected('listDirtyConfig'),
    currentBranch: unexpected('currentBranch'),
    listModifiedFiles: unexpected('listModifiedFiles'),
    readFullConfig: unexpected('readFullConfig'),
    commitCanonicalFiles: unexpected('commitCanonicalFiles'),
    readLaunchPin: unexpected('readLaunchPin'),
    ...overrides,
  };
  return { seams, submits };
}

describe('reachabilityFor — the production seam macf#1033 stops agents through', () => {
  it('discoverable + live tmux session -> alive, session = <project>@<routing-label>', () => {
    const { seams } = minimalSeams({
      discover: () => [{ agent: 'code-agent', workspace: '/w/macf', registry: 'g', project: 'macf', versionPin: null }],
      readConfig: (dir) => (dir === '/w/macf' ? { project: 'macf', routingLabel: 'code-agent' } : null),
      hasSession: (s) => s === 'macf@code-agent',
    });
    expect(reachabilityFor(seams, 'code-agent')).toEqual({ reachability: 'alive', session: 'macf@code-agent' });
  });

  it('discoverable, no live tmux session -> dead, session null', () => {
    const { seams } = minimalSeams({
      discover: () => [{ agent: 'code-agent', workspace: '/w/macf', registry: 'g', project: 'macf', versionPin: null }],
      readConfig: (dir) => (dir === '/w/macf' ? { project: 'macf', routingLabel: 'code-agent' } : null),
      hasSession: () => false,
    });
    expect(reachabilityFor(seams, 'code-agent')).toEqual({ reachability: 'dead', session: null });
  });

  it('NOT discoverable at all (this host has no workspace for the role) -> unknown, never dead', () => {
    const { seams } = minimalSeams({ discover: () => [] });
    expect(reachabilityFor(seams, 'code-agent')).toEqual({ reachability: 'unknown', session: null });
  });

  it('a fleet.yaml role that does not name-form-match discoverWorkspaces() -> unknown (the macf#708 hazard, applied to this seam)', () => {
    // discover() carries a DIFFERENT shape ('CODE_AGENT') than the role this
    // is queried with ('code-agent') — simulates the exact name-form
    // mismatch vm-driver.ts's macf#708 docblock warns about, to pin that
    // THIS function degrades to 'unknown' (never throws, never 'dead') on it.
    const { seams } = minimalSeams({
      discover: () => [{ agent: 'CODE_AGENT', workspace: '/w/macf', registry: 'g', project: 'macf', versionPin: null }],
      hasSession: () => true,
    });
    expect(reachabilityFor(seams, 'code-agent')).toEqual({ reachability: 'unknown', session: null });
  });
});

describe('agentStopDepsOverSeams — the submit contract (groundnuty/macf#1033)', () => {
  it('an alive role -> submit is called with EXACTLY (session, "/exit") — no other payload, no signal seam exists to call', async () => {
    const { seams, submits } = minimalSeams({
      discover: () => [{ agent: 'code-agent', workspace: '/w/macf', registry: 'g', project: 'macf', versionPin: null }],
      readConfig: (dir) => (dir === '/w/macf' ? { project: 'macf', routingLabel: 'code-agent' } : null),
      hasSession: (s) => s === 'macf@code-agent',
    });
    const deps = agentStopDepsOverSeams(seams);
    await deps.requestGracefulExit('code-agent');
    expect(submits).toEqual([{ session: 'macf@code-agent', text: '/exit' }]);
  });

  it('a dead/unreachable role -> submit is NEVER called (nothing to submit into)', async () => {
    const { seams, submits } = minimalSeams({ discover: () => [] });
    const deps = agentStopDepsOverSeams(seams);
    await deps.requestGracefulExit('code-agent');
    expect(submits).toEqual([]);
  });

  it('checkAgentReachability reads through the SAME reachabilityFor this submit contract uses — the two never disagree', async () => {
    const { seams } = minimalSeams({
      discover: () => [{ agent: 'code-agent', workspace: '/w/macf', registry: 'g', project: 'macf', versionPin: null }],
      readConfig: (dir) => (dir === '/w/macf' ? { project: 'macf', routingLabel: 'code-agent' } : null),
      hasSession: (s) => s === 'macf@code-agent',
    });
    const deps = agentStopDepsOverSeams(seams);
    expect(await deps.checkAgentReachability('code-agent')).toBe('alive');
  });
});
