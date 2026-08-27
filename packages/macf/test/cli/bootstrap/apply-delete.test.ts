/**
 * Tests for `apply-delete.ts` (groundnuty/macf#1272, DR-043 Amendment P3
 * execution wiring). Two concerns: (1) `planDeletionActions` resolves EXACTLY
 * `'routing'`-kind delete items to a real repo/variable, never guesses a
 * repo for anything else; (2) `runDeletionPhase` executes only the
 * resolvable actions and reports the rest as skipped, never silently
 * dropped. A third block is a static source-shape guard mirroring
 * `row4-apply-untouched-source-shape.test.ts`'s own precedent: no file in
 * apply's execution surface may even IMPORT a repo-deletion or App-deletion
 * primitive — the operator's ruling ("no it cannot remove repositories...")
 * is enforced at the import graph, not just at runtime.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { PlanItem } from '../../../src/cli/bootstrap/plan.js';
import {
  planDeletionActions,
  runDeletionPhase,
  realDeleteRepoVariable,
  REAL_APPLY_DELETE_DEPS,
  type ApplyDeleteDeps,
  type DeletionAction,
} from '../../../src/cli/bootstrap/apply-delete.js';
import { TRUSTED_ACTORS_VAR } from '../../../src/cli/bootstrap/apply-routing.js';

function manifestWithAgentRepos(repos: readonly string[]): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'icsoc-2026' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: [] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: repos.map((repo, i) => ({ role: `agent-${String(i)}`, profile: 'code', repo, deploy_path: `/tmp/${String(i)}` })),
  };
}

const ROUTING_DELETE_ITEM: PlanItem = {
  kind: 'routing',
  target: 'routing:icsoc-2026:runner',
  verb: 'delete',
  reason: 'MACF_TRUSTED_ACTORS is observed present but routing.runner is no longer declared — removing it.',
  confirm_required: true,
};

function secretFingerprintDeleteItem(role = 'dropped-agent', name = 'app_private_key'): PlanItem {
  return {
    kind: 'secret_fingerprint',
    target: `agent:${role}:secret_fingerprint:${name}`,
    verb: 'delete',
    reason: `Secret "${name}" for "${role}" was provisioned by this tool but "${role}" is no longer declared.`,
    confirm_required: true,
  };
}

describe('planDeletionActions', () => {
  it('a "routing" delete item resolves to an executable action against manifest.agents[0].repo, naming MACF_TRUSTED_ACTORS', () => {
    const manifest = manifestWithAgentRepos(['groundnuty/demo-code', 'groundnuty/demo-science']);
    const [action] = planDeletionActions(manifest, [ROUTING_DELETE_ITEM]);
    expect(action?.executable).toBe(true);
    if (action?.executable !== true) throw new Error('unreachable');
    expect(action.repo).toBe('groundnuty/demo-code');
    expect(action.variableName).toBe(TRUSTED_ACTORS_VAR);
    expect(action.item).toBe(ROUTING_DELETE_ITEM);
  });

  it('a "routing" delete item with NO declared agents is honestly unresolvable, not a guessed repo', () => {
    const manifest = manifestWithAgentRepos([]);
    const [action] = planDeletionActions(manifest, [ROUTING_DELETE_ITEM]);
    expect(action?.executable).toBe(false);
    if (action?.executable !== false) throw new Error('unreachable');
    expect(action.reason).toContain('no agent repos are declared');
  });

  it('a "secret_fingerprint" delete item is ALWAYS skipped this increment — no repo is recoverable for an orphaned role', () => {
    const manifest = manifestWithAgentRepos(['groundnuty/demo-code']);
    const item = secretFingerprintDeleteItem();
    const [action] = planDeletionActions(manifest, [item]);
    expect(action?.executable).toBe(false);
    if (action?.executable !== false) throw new Error('unreachable');
    expect(action.reason).toContain('fleet.lock does not carry a role→repo mapping');
    expect(action.item).toBe(item);
  });

  it('empty input -> empty output', () => {
    const manifest = manifestWithAgentRepos(['groundnuty/demo-code']);
    expect(planDeletionActions(manifest, [])).toEqual([]);
  });

  it('mixed input preserves order and resolves each item independently', () => {
    const manifest = manifestWithAgentRepos(['groundnuty/demo-code']);
    const secretItem = secretFingerprintDeleteItem();
    const actions = planDeletionActions(manifest, [secretItem, ROUTING_DELETE_ITEM]);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.executable).toBe(false);
    expect(actions[1]?.executable).toBe(true);
  });
});

describe('runDeletionPhase', () => {
  function fakeDeps(overrides: Partial<ApplyDeleteDeps> = {}): ApplyDeleteDeps {
    return { deleteRepoVariable: vi.fn(async () => 'deregistered' as const), ...overrides };
  }

  it('executes an executable action and classifies "deregistered" as "deleted"', async () => {
    const deleteRepoVariable = vi.fn(async () => 'deregistered' as const);
    const action: DeletionAction = { item: ROUTING_DELETE_ITEM, executable: true, repo: 'groundnuty/demo-code', variableName: TRUSTED_ACTORS_VAR };
    const results = await runDeletionPhase([action], { deleteRepoVariable });
    expect(deleteRepoVariable).toHaveBeenCalledExactlyOnceWith('groundnuty/demo-code', TRUSTED_ACTORS_VAR);
    expect(results).toEqual([{ kind: 'routing', target: ROUTING_DELETE_ITEM.target, status: 'deleted' }]);
  });

  it.each([
    ['deregistered', 'deleted'],
    ['absent', 'already-absent'],
    ['unknown', 'unknown'],
  ] as const)('classifies DeleteVariableResult "%s" as status "%s"', async (raw, status) => {
    const action: DeletionAction = { item: ROUTING_DELETE_ITEM, executable: true, repo: 'groundnuty/demo-code', variableName: TRUSTED_ACTORS_VAR };
    const results = await runDeletionPhase([action], fakeDeps({ deleteRepoVariable: async () => raw }));
    expect(results[0]?.status).toBe(status);
  });

  it('a non-executable action is reported "skipped" with its reason, and deps is NEVER called for it', async () => {
    const deleteRepoVariable = vi.fn(async () => 'deregistered' as const);
    const item = secretFingerprintDeleteItem();
    const action: DeletionAction = { item, executable: false, reason: 'repo unknown — refusing to guess.' };
    const results = await runDeletionPhase([action], { deleteRepoVariable });
    expect(deleteRepoVariable).not.toHaveBeenCalled();
    expect(results).toEqual([{ kind: 'secret_fingerprint', target: item.target, status: 'skipped', reason: 'repo unknown — refusing to guess.' }]);
  });

  it('mixed executable + non-executable: only the executable one invokes deps, both appear in results in order', async () => {
    const deleteRepoVariable = vi.fn(async () => 'deregistered' as const);
    const secretItem = secretFingerprintDeleteItem();
    const actions: DeletionAction[] = [
      { item: secretItem, executable: false, reason: 'unresolvable' },
      { item: ROUTING_DELETE_ITEM, executable: true, repo: 'groundnuty/demo-code', variableName: TRUSTED_ACTORS_VAR },
    ];
    const results = await runDeletionPhase(actions, { deleteRepoVariable });
    expect(deleteRepoVariable).toHaveBeenCalledExactlyOnceWith('groundnuty/demo-code', TRUSTED_ACTORS_VAR);
    expect(results.map((r) => r.status)).toEqual(['skipped', 'deleted']);
  });

  it('empty actions -> empty results, deps never called', async () => {
    const deleteRepoVariable = vi.fn(async () => 'deregistered' as const);
    expect(await runDeletionPhase([], { deleteRepoVariable })).toEqual([]);
    expect(deleteRepoVariable).not.toHaveBeenCalled();
  });
});

describe('realDeleteRepoVariable / REAL_APPLY_DELETE_DEPS wiring', () => {
  it('realDeleteRepoVariable delegates to variable-write.ts::realDeleteVariable against "repos/<owner>/<repo>"', async () => {
    const mod = await import('../../../src/cli/bootstrap/variable-write.js');
    const spy = vi.spyOn(mod, 'realDeleteVariable').mockResolvedValue('deregistered');
    try {
      const result = await realDeleteRepoVariable('groundnuty/demo-code', 'MACF_TRUSTED_ACTORS');
      expect(spy).toHaveBeenCalledExactlyOnceWith('repos/groundnuty/demo-code', 'MACF_TRUSTED_ACTORS');
      expect(result).toBe('deregistered');
    } finally {
      spy.mockRestore();
    }
  });

  it('REAL_APPLY_DELETE_DEPS.deleteRepoVariable IS realDeleteRepoVariable — the production default is genuinely wired, not a stub', () => {
    expect(REAL_APPLY_DELETE_DEPS.deleteRepoVariable).toBe(realDeleteRepoVariable);
  });
});

// --- Static source-shape guard: repo/App deletion is unreachable from the
// apply execution surface, by import graph, not just by convention. Mirrors
// `row4-apply-untouched-source-shape.test.ts`'s precedent exactly (same file
// listing, same "FIRES on injected occurrence" decisive-check shape). ---

/** Names whose presence in an apply-file's import specifiers would mean a repo- or App-deletion primitive is reachable from the apply path. */
const FORBIDDEN_DELETION_IMPORTS = ['realDeleteRepo', 'DeleteRepoFn', 'realDeleteApp', 'deleteApp'] as const;

function scanForForbiddenImports(source: string): string[] {
  return FORBIDDEN_DELETION_IMPORTS.filter((name) => new RegExp(`\\b${name}\\b`).test(source));
}

const bootstrapDir = fileURLToPath(new URL('../../../src/cli/bootstrap', import.meta.url));
const commandsDir = fileURLToPath(new URL('../../../src/cli/commands', import.meta.url));

function listApplyFiles(): readonly string[] {
  const bootstrapFiles = readdirSync(bootstrapDir)
    .filter((f) => f.startsWith('apply-') && f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(bootstrapDir, f));
  return [...bootstrapFiles, join(commandsDir, 'bootstrap-apply.ts')];
}

describe('repo/App deletion is structurally unreachable from apply (groundnuty/macf#1272 operator ruling)', () => {
  it('DECISIVE: the scanner FIRES on a deliberately injected forbidden import', () => {
    const bad = "import { realDeleteRepo } from './repo-destroy.js';";
    expect(scanForForbiddenImports(bad)).toEqual(['realDeleteRepo']);
  });

  it('does NOT fire on the unrelated realDeleteVariable/realDeleteRepoVariable this file legitimately uses', () => {
    const ok = "import { realDeleteVariable } from './variable-write.js';\nexport function realDeleteRepoVariable() {}";
    expect(scanForForbiddenImports(ok)).toEqual([]);
  });

  it('no apply-*.ts file (nor bootstrap-apply.ts) imports a repo- or App-deletion primitive', () => {
    const files = listApplyFiles();
    expect(files.length).toBeGreaterThanOrEqual(12);
    const violators = files.flatMap((f) => {
      const hits = scanForForbiddenImports(readFileSync(f, 'utf-8'));
      return hits.length > 0 ? [{ file: f, hits }] : [];
    });
    expect(violators).toEqual([]);
  });

  it('sanity: apply-delete.ts itself is scanned (not an accidental exclusion)', () => {
    const files = listApplyFiles();
    expect(files.some((f) => f.endsWith('apply-delete.ts'))).toBe(true);
  });
});
