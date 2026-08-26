/**
 * Tests for `control-repo.ts` — the per-fleet control-plane repo
 * (DR-043 Amendment F, groundnuty/macf#857). Fully offline: `ControlRepoDeps`
 * is injected throughout; the only real fs touches are writing `fleet.yaml`
 * / `.gitignore` into a scratch dir (a plain local temp dir, not a real
 * clone) and `ensureControlRepoGitignore`'s own read/write. The REAL git I/O
 * leaf (`realControlRepoCommitAndPush`) is exercised against a real local
 * git repo in `control-repo-commit.test.ts` (mirrors `self-update.test.ts`'s
 * bare-upstream harness) — kept in a separate file so this one stays
 * offline-only per its existing convention.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyControlRepoOwnership,
  controlRepoFullName,
  CONTROL_REPO_COMMIT_ALLOWLIST,
  CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY,
  ensureControlRepoGitignore,
  provisionControlRepo,
  type ControlRepoDeps,
  type ControlRepoMeta,
} from '../../../src/cli/bootstrap/control-repo.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';

const MANIFEST: FleetManifest = {
  apiVersion: 'macf/v0',
  kind: 'Fleet',
  metadata: { name: 'demo-fleet' },
  owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
  network: { advertise_host: 'example.ts.net' },
  transport: { age_recipients: ['age1operator'] },
  defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
  agents: [{ role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/x' }],
};

const SAME_FLEET_YAML = `apiVersion: macf/v0
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
`;

describe('controlRepoFullName', () => {
  it('is owner/<fleet>-control', () => {
    expect(controlRepoFullName(MANIFEST)).toBe('groundnuty/demo-fleet-control');
  });
});

describe('classifyControlRepoOwnership (pure)', () => {
  it('absent -> absent', () => {
    expect(classifyControlRepoOwnership({ presence: 'absent' }, undefined, MANIFEST)).toEqual({ kind: 'absent' });
  });

  it('existence unconfirmable -> unknown', () => {
    expect(classifyControlRepoOwnership({ presence: 'unknown' }, undefined, MANIFEST)).toEqual({ kind: 'unknown' });
  });

  // DR-043 Amendment G (groundnuty/macf#867) amends the PRE-Amendment-G rule
  // this described ("present + archived -> foreign, UNCONDITIONALLY") —
  // archived-ness alone is no longer a valid "retired leftover" signal once
  // `archive` makes it a reversible state of a LIVE fleet. Discriminate on
  // NAME-MATCH instead — see the four cases below.

  it('present + archived + fleet.yaml MATCHES our fleet name -> ours-archived (revivable, DR-043 Amendment G)', () => {
    const meta: ControlRepoMeta = { presence: 'present', archived: true };
    expect(classifyControlRepoOwnership(meta, SAME_FLEET_YAML, MANIFEST)).toEqual({ kind: 'ours-archived' });
  });

  it('present + archived + fleet.yaml declares a DIFFERENT fleet -> foreign (the case the original rule actually protects, preserved)', () => {
    const otherFleetYaml = SAME_FLEET_YAML.replace('name: demo-fleet', 'name: other-fleet');
    const meta: ControlRepoMeta = { presence: 'present', archived: true };
    const result = classifyControlRepoOwnership(meta, otherFleetYaml, MANIFEST);
    expect(result.kind).toBe('foreign');
    if (result.kind === 'foreign') expect(result.reason).toMatch(/other-fleet/);
  });

  it('present + archived + fleet.yaml missing/unreadable -> foreign', () => {
    const meta: ControlRepoMeta = { presence: 'present', archived: true };
    const result = classifyControlRepoOwnership(meta, undefined, MANIFEST);
    expect(result.kind).toBe('foreign');
    if (result.kind === 'foreign') expect(result.reason).toMatch(/could not be read/);
  });

  it('present + archived + fleet.yaml unparseable -> foreign', () => {
    const meta: ControlRepoMeta = { presence: 'present', archived: true };
    const result = classifyControlRepoOwnership(meta, 'not: [valid, fleet, yaml', MANIFEST);
    expect(result.kind).toBe('foreign');
    if (result.kind === 'foreign') expect(result.reason).toMatch(/schema validation/);
  });

  it('present, not archived, fleet.yaml unreadable -> foreign', () => {
    const meta: ControlRepoMeta = { presence: 'present', archived: false };
    const result = classifyControlRepoOwnership(meta, undefined, MANIFEST);
    expect(result.kind).toBe('foreign');
    if (result.kind === 'foreign') expect(result.reason).toMatch(/could not be read/);
  });

  it('present, not archived, fleet.yaml unparseable -> foreign', () => {
    const meta: ControlRepoMeta = { presence: 'present', archived: false };
    const result = classifyControlRepoOwnership(meta, 'not: [valid, fleet, yaml', MANIFEST);
    expect(result.kind).toBe('foreign');
    if (result.kind === 'foreign') expect(result.reason).toMatch(/schema validation/);
  });

  it('present, not archived, fleet.yaml declares a DIFFERENT fleet name -> foreign', () => {
    const otherFleetYaml = SAME_FLEET_YAML.replace('name: demo-fleet', 'name: other-fleet');
    const meta: ControlRepoMeta = { presence: 'present', archived: false };
    const result = classifyControlRepoOwnership(meta, otherFleetYaml, MANIFEST);
    expect(result.kind).toBe('foreign');
    if (result.kind === 'foreign') expect(result.reason).toMatch(/other-fleet/);
  });

  it('present, not archived, fleet.yaml matches OUR fleet name -> ours', () => {
    const meta: ControlRepoMeta = { presence: 'present', archived: false };
    expect(classifyControlRepoOwnership(meta, SAME_FLEET_YAML, MANIFEST)).toEqual({ kind: 'ours' });
  });

  it('present, archived undefined (could not be read) -> treated as NOT-archived (ours, not ours-archived) once a name-match is confirmed', () => {
    // meta.archived is `undefined` when the archived bit itself couldn't be
    // parsed off the `gh api` response — distinct from a confident `true`.
    // The classifier's final `archived === true ? 'ours-archived' : 'ours'`
    // check treats `undefined` the same as `false` (ordinary `ours`) —
    // only a CONFIRMED `true` produces `ours-archived`.
    const meta: ControlRepoMeta = { presence: 'present' };
    expect(classifyControlRepoOwnership(meta, SAME_FLEET_YAML, MANIFEST)).toEqual({ kind: 'ours' });
  });
});

describe('CONTROL_REPO_COMMIT_ALLOWLIST', () => {
  it('is exactly fleet.yaml, fleet.lock, secrets/vault.age, .gitignore — and NEVER secrets/recovery', () => {
    expect(CONTROL_REPO_COMMIT_ALLOWLIST).toEqual(['fleet.yaml', 'fleet.lock', 'secrets/vault.age', '.gitignore', '.github/workflows/agent-router.yml', '.github/agent-config.json']);
    expect(CONTROL_REPO_COMMIT_ALLOWLIST.some((p) => p.startsWith('secrets/recovery'))).toBe(false);
  });
});

describe('ensureControlRepoGitignore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratchDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'macf-control-gitignore-test-'));
    dirs.push(d);
    return d;
  }

  it('no existing .gitignore -> creates one containing the recovery-exclusion entry', () => {
    const dir = scratchDir();
    ensureControlRepoGitignore(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toBe(`${CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY}\n`);
  });

  it('existing .gitignore WITHOUT the entry -> appends, preserves prior content', () => {
    const dir = scratchDir();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n', 'utf-8');
    ensureControlRepoGitignore(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toBe(`node_modules/\n${CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY}\n`);
  });

  it('existing .gitignore missing a trailing newline -> inserts a separator before appending', () => {
    const dir = scratchDir();
    writeFileSync(join(dir, '.gitignore'), 'node_modules/', 'utf-8');
    ensureControlRepoGitignore(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toBe(`node_modules/\n${CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY}\n`);
  });

  it('existing .gitignore ALREADY containing the entry -> no-op, does not duplicate', () => {
    const dir = scratchDir();
    const already = `node_modules/\n${CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY}\n`;
    writeFileSync(join(dir, '.gitignore'), already, 'utf-8');
    ensureControlRepoGitignore(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toBe(already);
    expect(content.split(CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY)).toHaveLength(2); // exactly one occurrence
  });

  it('is idempotent across repeated calls', () => {
    const dir = scratchDir();
    ensureControlRepoGitignore(dir);
    ensureControlRepoGitignore(dir);
    ensureControlRepoGitignore(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(content).toBe(`${CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY}\n`);
  });
});

describe('provisionControlRepo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function scratchDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'macf-control-repo-test-'));
    dirs.push(d);
    return d;
  }

  function manifestPathIn(): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-control-repo-manifest-'));
    dirs.push(dir);
    return join(dir, 'fleet.yaml');
  }

  function baseDeps(overrides: Partial<ControlRepoDeps> = {}): ControlRepoDeps {
    return {
      checkMeta: async () => ({ presence: 'absent' }),
      readManifestFile: async () => undefined,
      createRepo: async () => {},
      unarchiveRepo: async () => {
        throw new Error('must not be called — no test in this describe block confirms revival unless it overrides this');
      },
      cloneRepo: async () => {},
      commitAndPush: async () => 'pushed',
      ...overrides,
    };
  }

  it('absent -> creates (no template), clones, WRITES fleet.yaml as the first commit, commits+pushes -> status "created"', async () => {
    const manifestPath = manifestPathIn();
    writeFileSync(manifestPath, SAME_FLEET_YAML, 'utf-8');
    const dir = scratchDir();
    const createCalls: { repo: string; opts: unknown }[] = [];
    const commitCalls: { dir: string; message: string }[] = [];
    const deps = baseDeps({
      createRepo: async (repo, opts) => {
        createCalls.push({ repo, opts });
      },
      commitAndPush: async (d, message) => {
        commitCalls.push({ dir: d, message });
        return 'pushed';
      },
    });

    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps, { makeScratchDir: () => dir });

    expect(outcome).toEqual({ status: 'created', repo: 'groundnuty/demo-fleet-control', localDir: dir });
    // NO template — control repo holds only GitOps state (repo-create.ts's doc).
    expect(createCalls).toEqual([{ repo: 'groundnuty/demo-fleet-control', opts: undefined }]);
    expect(readFileSync(join(dir, 'fleet.yaml'), 'utf-8')).toBe(SAME_FLEET_YAML);
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0]?.dir).toBe(dir);
    expect(commitCalls[0]?.message).toMatch(/fleet\.yaml/);
    // Belt-and-suspenders .gitignore (#857 review) — written before the
    // first commit so it's staged alongside fleet.yaml by the allowlist.
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(`${CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY}\n`);
  });

  it('absent + manifestPath not readable on disk (synthetic in-memory manifest, e.g. a test) -> falls back to a re-serialized fleet.yaml, still commits', async () => {
    const dir = scratchDir();
    const deps = baseDeps();
    // manifestPath deliberately points at a file that was never written.
    const outcome = await provisionControlRepo(MANIFEST, join(dir, '..', 'never-written-fleet.yaml'), deps, {
      makeScratchDir: () => dir,
    });
    expect(outcome.status).toBe('created');
    const written = readFileSync(join(dir, 'fleet.yaml'), 'utf-8');
    expect(written).toContain('demo-fleet');
    expect(written).toContain('demo-code');
  });

  it('ours (present, not archived, matching fleet.yaml) -> clones the EXISTING repo, does NOT create, does NOT re-commit -> status "reused"', async () => {
    const manifestPath = manifestPathIn();
    const dir = scratchDir();
    const createRepo = () => {
      throw new Error('must not be called — repo already exists');
    };
    const commitAndPush = () => {
      throw new Error('must not be called — reuse does not re-commit');
    };
    const deps = baseDeps({
      checkMeta: async () => ({ presence: 'present', archived: false }),
      readManifestFile: async () => SAME_FLEET_YAML,
      createRepo,
      commitAndPush,
    });

    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps, { makeScratchDir: () => dir });
    expect(outcome).toEqual({ status: 'reused', repo: 'groundnuty/demo-fleet-control', localDir: dir });
    // Self-heal (#857 review) — a REUSED checkout also gets .gitignore
    // patched, even though this function doesn't commit it itself (the
    // final sync in apply-fleet.ts's syncControlRepo picks it up later).
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(`${CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY}\n`);
  });

  it('foreign (archived + fleet.yaml declares a DIFFERENT fleet) -> ABORTS: no create, no clone, no commit, no unarchiveRepo', async () => {
    const manifestPath = manifestPathIn();
    const otherFleetYaml = SAME_FLEET_YAML.replace('name: demo-fleet', 'name: other-fleet');
    let cloneCalled = false;
    const deps = baseDeps({
      checkMeta: async () => ({ presence: 'present', archived: true }),
      readManifestFile: async () => otherFleetYaml,
      cloneRepo: async () => {
        cloneCalled = true;
      },
    });
    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps);
    expect(outcome.status).toBe('foreign');
    expect(cloneCalled).toBe(false);
  });

  // --- DR-043 Amendment G (groundnuty/macf#867) — ours-archived / revival ---

  it('ours-archived + confirmUnarchive NOT set (default) -> ABORTS status "archived": no unarchiveRepo, no clone, no commit', async () => {
    const manifestPath = manifestPathIn();
    let unarchiveCalled = false;
    let cloneCalled = false;
    const deps = baseDeps({
      checkMeta: async () => ({ presence: 'present', archived: true }),
      readManifestFile: async () => SAME_FLEET_YAML,
      unarchiveRepo: async () => {
        unarchiveCalled = true;
      },
      cloneRepo: async () => {
        cloneCalled = true;
      },
    });

    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps);

    expect(outcome.status).toBe('archived');
    if (outcome.status === 'archived') expect(outcome.reason).toMatch(/ARCHIVED/);
    expect(unarchiveCalled).toBe(false);
    expect(cloneCalled).toBe(false);
  });

  it('ours-archived + confirmUnarchive: false explicitly -> STILL aborts status "archived" (never inferred true)', async () => {
    const manifestPath = manifestPathIn();
    const deps = baseDeps({
      checkMeta: async () => ({ presence: 'present', archived: true }),
      readManifestFile: async () => SAME_FLEET_YAML,
    });

    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps, { confirmUnarchive: false });

    expect(outcome.status).toBe('archived');
  });

  it('ours-archived + confirmUnarchive: true -> unarchiveRepo called BEFORE cloneRepo, then proceeds like reuse -> status "revived"', async () => {
    const manifestPath = manifestPathIn();
    const dir = scratchDir();
    const callOrder: string[] = [];
    const deps = baseDeps({
      checkMeta: async () => ({ presence: 'present', archived: true }),
      readManifestFile: async () => SAME_FLEET_YAML,
      unarchiveRepo: async (repo) => {
        expect(repo).toBe('groundnuty/demo-fleet-control');
        callOrder.push('unarchive');
      },
      cloneRepo: async () => {
        callOrder.push('clone');
      },
      commitAndPush: () => {
        throw new Error('must not be called — revival does not re-commit fleet.yaml, same as an ordinary reuse');
      },
    });

    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps, { confirmUnarchive: true, makeScratchDir: () => dir });

    expect(outcome).toEqual({ status: 'revived', repo: 'groundnuty/demo-fleet-control', localDir: dir });
    expect(callOrder).toEqual(['unarchive', 'clone']);
    // Belt-and-suspenders .gitignore still applies on a revived checkout.
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(`${CONTROL_REPO_RECOVERY_GITIGNORE_ENTRY}\n`);
  });

  it('ours-archived + confirmUnarchive: true, unarchiveRepo throws -> status "failed", cloneRepo never called', async () => {
    const manifestPath = manifestPathIn();
    let cloneCalled = false;
    const deps = baseDeps({
      checkMeta: async () => ({ presence: 'present', archived: true }),
      readManifestFile: async () => SAME_FLEET_YAML,
      unarchiveRepo: async () => {
        throw new Error('GitHub API rejected the un-archive');
      },
      cloneRepo: async () => {
        cloneCalled = true;
      },
    });

    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps, { confirmUnarchive: true });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/rejected the un-archive/);
    expect(cloneCalled).toBe(false);
  });

  it('foreign (different fleet\'s fleet.yaml) -> ABORTS', async () => {
    const manifestPath = manifestPathIn();
    const otherFleetYaml = SAME_FLEET_YAML.replace('name: demo-fleet', 'name: some-other-fleet');
    const deps = baseDeps({
      checkMeta: async () => ({ presence: 'present', archived: false }),
      readManifestFile: async () => otherFleetYaml,
    });
    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps);
    expect(outcome.status).toBe('foreign');
  });

  it('existence unconfirmable ("unknown") -> failed, refuses to guess (neither create nor reuse)', async () => {
    const manifestPath = manifestPathIn();
    const deps = baseDeps({ checkMeta: async () => ({ presence: 'unknown' }) });
    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/could not confirm/);
  });

  it('createRepo throwing -> status failed, carries the underlying reason', async () => {
    const manifestPath = manifestPathIn();
    const dir = scratchDir();
    const deps = baseDeps({
      createRepo: async () => {
        throw new Error('name already exists on this account');
      },
    });
    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps, { makeScratchDir: () => dir });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/already exists/);
  });

  it('NEVER throws, even when checkMeta itself throws', async () => {
    const manifestPath = manifestPathIn();
    const deps = baseDeps({
      checkMeta: async () => {
        throw new Error('network down');
      },
    });
    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/network down/);
  });

  it('the checkout dir exists on disk after a successful create (mkdirSync defense for a fake makeScratchDir that returns a not-yet-existing path)', async () => {
    const manifestPath = manifestPathIn();
    writeFileSync(manifestPath, SAME_FLEET_YAML, 'utf-8');
    const notYetCreated = join(mkdtempSync(join(tmpdir(), 'macf-control-repo-parent-')), 'fresh-checkout');
    dirs.push(join(notYetCreated, '..'));
    expect(existsSync(notYetCreated)).toBe(false);
    const deps = baseDeps();

    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps, { makeScratchDir: () => notYetCreated });

    expect(outcome.status).toBe('created');
    expect(existsSync(notYetCreated)).toBe(true);
  });
});
