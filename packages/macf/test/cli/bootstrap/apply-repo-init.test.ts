/**
 * Tests for `apply-repo-init.ts` — the `macf bootstrap apply` repo-init step
 * (DR-043 §D2/§D4, Slice 2b increment 5a, groundnuty/macf#838). `cloneRepo`
 * and `commitAndPush` are injected fakes throughout (no real git/network);
 * the REAL `repoInit()` (`commands/repo-init.ts`) runs for real against a
 * local scratch directory the fake `cloneRepo` creates — so the orchestration
 * (scratch-dir lifecycle, cleanup, option-mapping, error handling) is
 * exercised end to end with zero real I/O beyond local temp-file writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyRepoInitForAgent,
  ensureAgentRepo,
  repoInitRegistryOptions,
  resolveActionsPinReconcile,
  RepoInitStepError,
  type AgentRepoDeps,
  type RepoInitStepDeps,
} from '../../../src/cli/bootstrap/apply-repo-init.js';
import type { FleetAgent, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { RegistryConfig } from '@groundnuty/macf-core';

const MANIFEST: FleetManifest = {
  apiVersion: 'macf/v0',
  kind: 'Fleet',
  metadata: { name: 'demo-fleet' },
  // Immutable full tag (macf#797's `isImmutableActionsTag`) so `repoInit`'s
  // version-resolution never makes a real network call in tests.
  versions: { macf: '0.2.56', actions: 'v3.4.1' },
  owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
  network: { advertise_host: 'example.ts.net' },
  transport: { age_recipients: ['age1operator'] },
  defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
  agents: [{ role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/x' }],
};
const AGENT: FleetAgent = MANIFEST.agents[0]!;

describe('repoInitRegistryOptions', () => {
  it('maps org', () => {
    expect(repoInitRegistryOptions({ type: 'org', org: 'acme' } as RegistryConfig)).toEqual({
      registryType: 'org',
      registryOrg: 'acme',
    });
  });
  it('maps profile', () => {
    expect(repoInitRegistryOptions({ type: 'profile', user: 'groundnuty' } as RegistryConfig)).toEqual({
      registryType: 'profile',
      registryUser: 'groundnuty',
    });
  });
  it('maps repo (no owner/repo needed — repoInit derives it from --repo itself)', () => {
    expect(repoInitRegistryOptions({ type: 'repo', owner: 'x', repo: 'y' } as RegistryConfig)).toEqual({
      registryType: 'repo',
    });
  });
  it('rejects local — no GitHub-Actions routing path', () => {
    expect(() => repoInitRegistryOptions({ type: 'local', path: '/x' } as RegistryConfig)).toThrow(RepoInitStepError);
  });
});

describe('applyRepoInitForAgent', () => {
  const createdDirs: string[] = [];
  // The real `repoInit()` attempts label creation via `generateToken()` +
  // a real GitHub API `fetch`. In production (this step runs Mac-side, no
  // agent identity in env) that call throws immediately and `repoInit`
  // degrades gracefully (warns, skips labels, still writes the routing
  // files — see `repo-init.ts`). Neutralize any ambient GH_TOKEN/APP_ID/etc
  // here so tests exercise that SAME degrade path deterministically, rather
  // than making a real (and possibly slow/flaky) network call against
  // whatever token happens to be in this shell's environment.
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['GH_TOKEN', 'APP_ID', 'INSTALL_ID', 'KEY_PATH']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    createdDirs.length = 0;
    for (const k of ['GH_TOKEN', 'APP_ID', 'INSTALL_ID', 'KEY_PATH']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /** Fake `cloneRepo` that just materializes the scratch dir as an empty "checkout" — no real git. */
  function fakeCloneRepo(): (url: string, destDir: string) => Promise<void> {
    return async (_url, destDir) => {
      createdDirs.push(destDir);
      mkdirSync(destDir, { recursive: true });
    };
  }

  it('happy path: clones, runs the REAL repoInit, commits+pushes — pushed: true', async () => {
    const commits: { dir: string; message: string }[] = [];
    const deps: RepoInitStepDeps = {
      cloneRepo: fakeCloneRepo(),
      commitAndPush: async (dir, message) => {
        commits.push({ dir, message });
        // Assert the REAL repoInit already wrote the routing files before commit.
        expect(existsSync(join(dir, '.github', 'workflows', 'agent-router.yml'))).toBe(true);
        expect(existsSync(join(dir, '.github', 'agent-config.json'))).toBe(true);
        const cfg = JSON.parse(readFileSync(join(dir, '.github', 'agent-config.json'), 'utf-8'));
        expect(cfg.agents['code-agent']).toBeDefined();
        return 'pushed';
      },
    };
    const outcome = await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    // No `tokenSource` given (this describe block's beforeEach also strips
    // ambient GH_TOKEN/APP_ID/etc), so `repoInit`'s own `generateToken()`
    // degrades to `labels: {status:'skipped'}` — the PRE-EXISTING,
    // acknowledged gap for the `reused`/`resumed-install` paths this
    // increment does NOT close (groundnuty/macf#920's "Thread the
    // freshly-created credentials" scope is `created` only — see
    // `applyRepoInitForCreatedAgent`'s doc in `apply-fleet.ts`). Leniently
    // scored `'applied'` — see `labelsAreGoodEnough`'s doc.
    expect(outcome).toEqual({
      repo: 'groundnuty/demo-code',
      role: 'code-agent',
      status: 'applied',
      pushed: true,
      labels: { status: 'skipped', reason: expect.stringContaining('APP_ID') },
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.message).toMatch(/repo-init/);
  });

  it('nothing-to-commit (idempotent re-run) -> pushed: false, still status applied', async () => {
    const deps: RepoInitStepDeps = {
      cloneRepo: fakeCloneRepo(),
      commitAndPush: async () => 'nothing-to-commit',
    };
    const outcome = await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    expect(outcome).toEqual({
      repo: 'groundnuty/demo-code',
      role: 'code-agent',
      status: 'applied',
      pushed: false,
      labels: { status: 'skipped', reason: expect.stringContaining('APP_ID') },
    });
  });

  it('local registry -> failed BEFORE any clone attempt', async () => {
    const cloneRepo = vi.fn();
    const localManifest: FleetManifest = {
      ...MANIFEST,
      owner: { ...MANIFEST.owner, registry: { type: 'local', path: '/x' } as RegistryConfig },
    };
    const deps: RepoInitStepDeps = { cloneRepo, commitAndPush: vi.fn() };
    const outcome = await applyRepoInitForAgent(AGENT, localManifest, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/local registry/);
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it('clone failure (repo does not exist yet — out of scope for this increment, see module doc) -> status failed, loud reason', async () => {
    const deps: RepoInitStepDeps = {
      cloneRepo: async () => {
        throw new Error('repository not found');
      },
      commitAndPush: vi.fn(),
    };
    const outcome = await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/repository not found/);
  });

  it('commitAndPush failure -> status failed, carries the underlying reason', async () => {
    const deps: RepoInitStepDeps = {
      cloneRepo: fakeCloneRepo(),
      commitAndPush: async () => {
        throw new Error('remote rejected push (non-fast-forward)');
      },
    };
    const outcome = await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/non-fast-forward/);
  });

  it('scratch dir is removed after a SUCCESSFUL run', async () => {
    let capturedDir = '';
    const deps: RepoInitStepDeps = {
      cloneRepo: async (_url, destDir) => {
        capturedDir = destDir;
        mkdirSync(destDir, { recursive: true });
      },
      commitAndPush: async () => 'pushed',
    };
    await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    expect(capturedDir).not.toBe('');
    expect(existsSync(capturedDir)).toBe(false);
  });

  it('scratch dir is removed even after a FAILED run', async () => {
    let capturedDir = '';
    const deps: RepoInitStepDeps = {
      cloneRepo: async (_url, destDir) => {
        capturedDir = destDir;
        mkdirSync(destDir, { recursive: true });
      },
      commitAndPush: async () => {
        throw new Error('boom');
      },
    };
    await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    expect(existsSync(capturedDir)).toBe(false);
  });

  it('the default cloneUrl passed to cloneRepo is the real GitHub HTTPS URL, unless overridden', async () => {
    const seenUrls: string[] = [];
    const deps: RepoInitStepDeps = {
      cloneRepo: async (url, destDir) => {
        seenUrls.push(url);
        mkdirSync(destDir, { recursive: true });
      },
      commitAndPush: async () => 'nothing-to-commit',
    };
    await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    expect(seenUrls).toEqual(['https://github.com/groundnuty/demo-code.git']);

    seenUrls.length = 0;
    await applyRepoInitForAgent(AGENT, MANIFEST, deps, { cloneUrl: (repo) => `file:///local-bare/${repo}.git` });
    expect(seenUrls).toEqual(['file:///local-bare/groundnuty/demo-code.git']);
  });

  it('force is always false — repo-init never clobbers an existing agent-router.yml on a re-run', async () => {
    let seenOpts: unknown;
    const fakeRepoInit = vi.fn(async (_dir: string, opts: unknown) => {
      seenOpts = opts;
      return { workflow: 'created' as const, config: 'updated' as const, labels: { status: 'ok' as const, created: [], existed: [] } };
    });
    const deps: RepoInitStepDeps = {
      cloneRepo: fakeCloneRepo(),
      commitAndPush: async () => 'nothing-to-commit',
      repoInit: fakeRepoInit as never,
    };
    await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    expect(seenOpts).toMatchObject({ repo: 'groundnuty/demo-code', agents: 'code-agent', force: false, project: 'demo-fleet' });
  });

  // --- groundnuty/macf#920 gap 1 — tokenSource threading ---

  it('opts.tokenSource is threaded verbatim into repoInit\'s own tokenSource option', async () => {
    let seenOpts: unknown;
    const fakeRepoInit = vi.fn(async (_dir: string, opts: unknown) => {
      seenOpts = opts;
      return { workflow: 'created' as const, config: 'updated' as const, labels: { status: 'ok' as const, created: ['code-agent'], existed: [] } };
    });
    const deps: RepoInitStepDeps = { cloneRepo: fakeCloneRepo(), commitAndPush: async () => 'pushed', repoInit: fakeRepoInit as never };
    const tokenSource = { appId: 'app-1', installId: 'install-1', keyPath: '/scratch/key.pem' };
    const outcome = await applyRepoInitForAgent(AGENT, MANIFEST, deps, { tokenSource });
    expect(seenOpts).toMatchObject({ tokenSource });
    expect(outcome).toEqual({
      repo: 'groundnuty/demo-code',
      role: 'code-agent',
      status: 'applied',
      pushed: true,
      labels: { status: 'ok', created: ['code-agent'], existed: [] },
    });
  });

  it('tokenSource given + labels partial-failure -> status FAILED (a fleet missing labels cannot route), workflow/config STILL pushed', async () => {
    const commits: { dir: string }[] = [];
    const fakeRepoInit = vi.fn(
      async () =>
        ({
          workflow: 'created' as const,
          config: 'updated' as const,
          labels: { status: 'partial-failure' as const, created: [], existed: ['in-progress'], failed: ['code-agent'] },
        }) as never,
    );
    const deps: RepoInitStepDeps = {
      cloneRepo: fakeCloneRepo(),
      commitAndPush: async (dir) => {
        commits.push({ dir });
        return 'pushed';
      },
      repoInit: fakeRepoInit as never,
    };
    const tokenSource = { appId: 'app-1', installId: 'install-1', keyPath: '/scratch/key.pem' };
    const outcome = await applyRepoInitForAgent(AGENT, MANIFEST, deps, { tokenSource });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toMatch(/label creation failed/);
      expect(outcome.reason).toMatch(/code-agent/);
      expect(outcome.reason).toMatch(/pushed/);
      expect(outcome.reason).toMatch(/a fleet missing its role\/status labels cannot route/);
    }
    // The routing config STILL landed — a label failure doesn't withhold the
    // workflow/config commit, only the overall step outcome.
    expect(commits).toHaveLength(1);
  });

  it('tokenSource given + labels skipped (token mint itself failed even with credentials) -> status FAILED', async () => {
    const fakeRepoInit = vi.fn(
      async () => ({ workflow: 'created' as const, config: 'updated' as const, labels: { status: 'skipped' as const, reason: 'gh not on PATH' } }) as never,
    );
    const deps: RepoInitStepDeps = { cloneRepo: fakeCloneRepo(), commitAndPush: async () => 'pushed', repoInit: fakeRepoInit as never };
    const tokenSource = { appId: 'app-1', installId: 'install-1', keyPath: '/scratch/key.pem' };
    const outcome = await applyRepoInitForAgent(AGENT, MANIFEST, deps, { tokenSource });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/label creation was skipped/);
  });

  // --- groundnuty/macf#1072 (DR-043 Amendment L extended to
  // `versions.actions`) — force-rewrite, end to end through the REAL
  // `repoInit()`, with the network structurally unreachable. ---

  it('DECISIVE — manifest declares v3.4.2 against a repo pinned v3.4.1: the force-rewrite lands @v3.4.2 in agent-router.yml, and fetch is NEVER called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch must not be called — the manifest declares an immutable pin AND opts.force/opts.actionsVersion already carry the resolved decision (groundnuty/macf#1072)');
    });
    try {
      let written = '';
      const deps: RepoInitStepDeps = {
        cloneRepo: fakeCloneRepo(),
        // Read the ACTUAL written file back HERE — inside the commit step,
        // before `applyRepoInitForAgent`'s `finally` deletes the scratch
        // dir. "What lands" is the acceptance criterion, not just the
        // argument `repoInit` was called with.
        commitAndPush: async (dir) => {
          written = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
          return 'pushed';
        },
      };
      // Mirrors exactly what `apply-fleet.ts`'s call site computes via
      // `resolveActionsPinReconcile(manifest.versions?.actions, observedPin)`
      // for a repo observed at the STALE pin `v3.4.1` while the manifest
      // now declares `v3.4.2` — the live bug this issue reports.
      const { actionsVersion, force } = resolveActionsPinReconcile('v3.4.2', 'v3.4.1');
      expect(force).toBe(true);
      expect(actionsVersion).toBe('v3.4.2');

      const outcome = await applyRepoInitForAgent(AGENT, MANIFEST, deps, { actionsVersion, force });

      expect(outcome.status).toBe('applied');
      if (outcome.status === 'applied') expect(outcome.pushed).toBe(true);
      expect(written).toContain('uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.4.2');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('already-current (observed already matches declared): resolveActionsPinReconcile keeps force false, so a caller following its decision never rewrites an up-to-date file', async () => {
    const { actionsVersion, force } = resolveActionsPinReconcile('v3.4.1', 'v3.4.1');
    expect(force).toBe(false);
    expect(actionsVersion).toBe('v3.4.1');

    let repoInitCalls = 0;
    const fakeRepoInit = vi.fn(async () => {
      repoInitCalls += 1;
      return { workflow: 'created' as const, config: 'updated' as const, labels: { status: 'skipped' as const, reason: 'no token' } };
    });
    const deps: RepoInitStepDeps = { cloneRepo: fakeCloneRepo(), commitAndPush: async () => 'nothing-to-commit', repoInit: fakeRepoInit as never };
    await applyRepoInitForAgent(AGENT, MANIFEST, deps, { actionsVersion, force });
    // The caller (apply-fleet.ts) still runs the general identity-sync
    // repoInit call regardless of `force` (labels/config-merge are
    // independent concerns — see this module's doc); what THIS assertion
    // proves is that the `force` flag itself carried through unchanged.
    expect(repoInitCalls).toBe(1);
    const seenOpts = fakeRepoInit.mock.calls[0]?.[1] as { force?: boolean; actionsVersion?: string };
    expect(seenOpts.force).toBe(false);
    expect(seenOpts.actionsVersion).toBe('v3.4.1');
  });
});

// --- resolveActionsPinReconcile (groundnuty/macf#1072, DR-043 Amendment L
// extended to `versions.actions`) — pure decision point, zero I/O. ---

describe('resolveActionsPinReconcile', () => {
  it('absent versions.actions (declaredActions undefined) + an observed pin present: force stays false, actionsVersion is the OBSERVED pin — never the floating DEFAULT_ACTIONS_VERSION', () => {
    const r = resolveActionsPinReconcile(undefined, 'v3.4.1');
    expect(r).toEqual({ actionsVersion: 'v3.4.1', force: false });
  });

  it('absent versions.actions AND no observed pin at all: falls back to the DEFAULT_ACTIONS_VERSION bootstrap default (the brand-new-repo case), force stays false', () => {
    const r = resolveActionsPinReconcile(undefined, undefined);
    expect(r).toEqual({ actionsVersion: 'v3', force: false });
  });

  it('declared and matches observed: force stays false (nothing to reconcile)', () => {
    const r = resolveActionsPinReconcile('v3.4.2', 'v3.4.2');
    expect(r).toEqual({ actionsVersion: 'v3.4.2', force: false });
  });

  it('declared and diverges from observed: force true, actionsVersion is the DECLARED value verbatim — never a function of what was observed', () => {
    const r = resolveActionsPinReconcile('v3.4.2', 'v3.4.1');
    expect(r).toEqual({ actionsVersion: 'v3.4.2', force: true });
  });

  it('declared but the observed pin is unreadable (undefined): force true, same treatment as drift — mirrors version(macf)\'s create+update symmetry, never silently treated as already-current', () => {
    const r = resolveActionsPinReconcile('v3.4.2', undefined);
    expect(r).toEqual({ actionsVersion: 'v3.4.2', force: true });
  });
});

// --- ensureAgentRepo (macf#857, DR-043 Amendment F / #854 §2;
// + revival, DR-043 Amendment G correction, groundnuty/macf#1034) ---

describe('ensureAgentRepo', () => {
  it('absent + provenance template (default) -> creates FROM defaults.role_template', async () => {
    const calls: { repo: string; opts: unknown }[] = [];
    const deps: AgentRepoDeps = {
      checkMeta: async () => ({ presence: 'absent' }),
      createRepo: async (repo, opts) => {
        calls.push({ repo, opts });
      },
      unarchiveRepo: vi.fn(),
    };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps);
    expect(outcome).toEqual({ repo: 'groundnuty/demo-code', role: 'code-agent', status: 'created' });
    expect(calls).toEqual([{ repo: 'groundnuty/demo-code', opts: { template: 'groundnuty/agentic-repo-template' } }]);
  });

  it('absent + provenance mirror -> creates BLANK (no template)', async () => {
    const mirrorAgent: FleetAgent = { ...AGENT, provenance: 'mirror' };
    const calls: { repo: string; opts: unknown }[] = [];
    const deps: AgentRepoDeps = {
      checkMeta: async () => ({ presence: 'absent' }),
      createRepo: async (repo, opts) => {
        calls.push({ repo, opts });
      },
      unarchiveRepo: vi.fn(),
    };
    const outcome = await ensureAgentRepo(mirrorAgent, MANIFEST, deps);
    expect(outcome.status).toBe('created');
    expect(calls).toEqual([{ repo: 'groundnuty/demo-code', opts: undefined }]);
  });

  it('already present, not archived -> left untouched, status "present", createRepo/unarchiveRepo never called', async () => {
    const createRepo = vi.fn();
    const unarchiveRepo = vi.fn();
    const deps: AgentRepoDeps = { checkMeta: async () => ({ presence: 'present', archived: false }), createRepo, unarchiveRepo };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps);
    expect(outcome).toEqual({ repo: 'groundnuty/demo-code', role: 'code-agent', status: 'present' });
    expect(createRepo).not.toHaveBeenCalled();
    expect(unarchiveRepo).not.toHaveBeenCalled();
  });

  it('existence unconfirmable ("unknown") -> status "unknown", refuses to guess, createRepo never called', async () => {
    const createRepo = vi.fn();
    const deps: AgentRepoDeps = { checkMeta: async () => ({ presence: 'unknown' }), createRepo, unarchiveRepo: vi.fn() };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps);
    expect(outcome.status).toBe('unknown');
    if (outcome.status === 'unknown') expect(outcome.reason).toMatch(/could not confirm/);
    expect(createRepo).not.toHaveBeenCalled();
  });

  it('present but the archived bit itself is unreadable -> status "unknown" (Amendment A: never falls through to "present")', async () => {
    const createRepo = vi.fn();
    const unarchiveRepo = vi.fn();
    // `archived: undefined` while `presence: 'present'` — the read succeeded
    // (existence confirmed) but the response didn't carry a boolean
    // `archived` field. Requirement 4 (macf#1034): unreadable -> 'unknown',
    // never silently folded into 'present'.
    const deps: AgentRepoDeps = { checkMeta: async () => ({ presence: 'present' }), createRepo, unarchiveRepo };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps);
    expect(outcome.status).toBe('unknown');
    if (outcome.status === 'unknown') expect(outcome.reason).toMatch(/archived state could not be confirmed/);
    expect(createRepo).not.toHaveBeenCalled();
    expect(unarchiveRepo).not.toHaveBeenCalled();
  });

  it('createRepo throwing -> status failed, carries the underlying reason', async () => {
    const deps: AgentRepoDeps = {
      checkMeta: async () => ({ presence: 'absent' }),
      createRepo: async () => {
        throw new Error('name already exists on this account');
      },
      unarchiveRepo: vi.fn(),
    };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/already exists/);
  });

  it('NEVER throws, even when checkMeta itself throws', async () => {
    const createRepo = vi.fn();
    const deps: AgentRepoDeps = {
      checkMeta: async () => {
        throw new Error('network down');
      },
      createRepo,
      unarchiveRepo: vi.fn(),
    };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/network down/);
    expect(createRepo).not.toHaveBeenCalled();
  });

  // --- Revival (DR-043 Amendment G correction, groundnuty/macf#1034) ---

  it('archived + confirmUnarchive true -> unarchiveRepo called, status "revived", createRepo never called', async () => {
    const createRepo = vi.fn();
    const unarchiveRepo = vi.fn(async () => {});
    const deps: AgentRepoDeps = { checkMeta: async () => ({ presence: 'present', archived: true }), createRepo, unarchiveRepo };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps, { confirmUnarchive: true });
    expect(outcome).toEqual({ repo: 'groundnuty/demo-code', role: 'code-agent', status: 'revived' });
    expect(unarchiveRepo).toHaveBeenCalledWith('groundnuty/demo-code');
    expect(unarchiveRepo).toHaveBeenCalledTimes(1);
    expect(createRepo).not.toHaveBeenCalled();
  });

  it('archived + confirmUnarchive NOT true (absent opts) -> status "archived", unarchiveRepo NEVER called — never silent', async () => {
    const unarchiveRepo = vi.fn();
    const deps: AgentRepoDeps = { checkMeta: async () => ({ presence: 'present', archived: true }), createRepo: vi.fn(), unarchiveRepo };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps);
    expect(outcome.status).toBe('archived');
    if (outcome.status === 'archived') expect(outcome.reason).toMatch(/ARCHIVED/);
    expect(unarchiveRepo).not.toHaveBeenCalled();
  });

  it('archived + confirmUnarchive explicitly false -> status "archived", unarchiveRepo NEVER called', async () => {
    const unarchiveRepo = vi.fn();
    const deps: AgentRepoDeps = { checkMeta: async () => ({ presence: 'present', archived: true }), createRepo: vi.fn(), unarchiveRepo };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps, { confirmUnarchive: false });
    expect(outcome.status).toBe('archived');
    expect(unarchiveRepo).not.toHaveBeenCalled();
  });

  it('unarchiveRepo throwing -> status failed, carries the underlying reason', async () => {
    const deps: AgentRepoDeps = {
      checkMeta: async () => ({ presence: 'present', archived: true }),
      createRepo: vi.fn(),
      unarchiveRepo: async () => {
        throw new Error('403: insufficient permission');
      },
    };
    const outcome = await ensureAgentRepo(AGENT, MANIFEST, deps, { confirmUnarchive: true });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/insufficient permission/);
  });
});
