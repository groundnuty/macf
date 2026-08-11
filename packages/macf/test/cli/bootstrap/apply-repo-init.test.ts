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
  repoInitRegistryOptions,
  RepoInitStepError,
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
  transport: { vault_repo: 'groundnuty/demo-science', age_recipient: 'age1operator' },
  defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
  agents: [{ role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/x' }],
  trust: { ca: 'per-project', federated_cas: [] },
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
    expect(outcome).toEqual({ repo: 'groundnuty/demo-code', role: 'code-agent', status: 'applied', pushed: true });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.message).toMatch(/repo-init/);
  });

  it('nothing-to-commit (idempotent re-run) -> pushed: false, still status applied', async () => {
    const deps: RepoInitStepDeps = {
      cloneRepo: fakeCloneRepo(),
      commitAndPush: async () => 'nothing-to-commit',
    };
    const outcome = await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    expect(outcome).toEqual({ repo: 'groundnuty/demo-code', role: 'code-agent', status: 'applied', pushed: false });
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
    });
    const deps: RepoInitStepDeps = {
      cloneRepo: fakeCloneRepo(),
      commitAndPush: async () => 'nothing-to-commit',
      repoInit: fakeRepoInit as never,
    };
    await applyRepoInitForAgent(AGENT, MANIFEST, deps);
    expect(seenOpts).toMatchObject({ repo: 'groundnuty/demo-code', agents: 'code-agent', force: false, project: 'demo-fleet' });
  });
});
