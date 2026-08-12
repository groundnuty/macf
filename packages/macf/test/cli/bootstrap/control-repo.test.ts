/**
 * Tests for `control-repo.ts` — the per-fleet control-plane repo
 * (DR-043 Amendment F, groundnuty/macf#857). Fully offline: `ControlRepoDeps`
 * is injected throughout; the only real fs touch is writing `fleet.yaml`
 * into a scratch dir (a plain local temp dir, not a real clone).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyControlRepoOwnership,
  controlRepoFullName,
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
  trust: { ca: 'per-project', federated_cas: [] },
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
trust:
  ca: per-project
  federated_cas: []
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

  it('present + archived -> foreign, UNCONDITIONALLY (retired-fleet-leftover case), even with a matching fleet.yaml', () => {
    const meta: ControlRepoMeta = { presence: 'present', archived: true };
    const result = classifyControlRepoOwnership(meta, SAME_FLEET_YAML, MANIFEST);
    expect(result.kind).toBe('foreign');
    if (result.kind === 'foreign') expect(result.reason).toMatch(/ARCHIVED/);
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

  it('present, archived undefined (could not be read) -> treated as NOT-archived, falls through to content-match', () => {
    // meta.archived is `undefined` when the archived bit itself couldn't be
    // parsed off the `gh api` response — distinct from a confident `false`.
    // The classifier's `!== true` check treats both the same way (proceeds
    // to the content read) rather than refusing outright — the CONTENT
    // check is still the deciding factor either way.
    const meta: ControlRepoMeta = { presence: 'present' };
    expect(classifyControlRepoOwnership(meta, SAME_FLEET_YAML, MANIFEST)).toEqual({ kind: 'ours' });
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
  });

  it('foreign (archived) -> ABORTS: no create, no clone, no commit', async () => {
    const manifestPath = manifestPathIn();
    let cloneCalled = false;
    const deps = baseDeps({
      checkMeta: async () => ({ presence: 'present', archived: true }),
      readManifestFile: async () => SAME_FLEET_YAML,
      cloneRepo: async () => {
        cloneCalled = true;
      },
    });
    const outcome = await provisionControlRepo(MANIFEST, manifestPath, deps);
    expect(outcome.status).toBe('foreign');
    if (outcome.status === 'foreign') expect(outcome.reason).toMatch(/ARCHIVED/);
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
