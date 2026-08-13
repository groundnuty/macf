/**
 * Tests for `fleet-lock-recorder.ts` — the DR-043 §D6 write-back
 * (groundnuty/macf#907). Fully offline: `RecordDeployedVersionDeps` fakes
 * `checkMeta` / `readManifestFile` / `cloneRepo` / `commitAndPush` (the
 * network/git surface), but every `fleet.lock` read/write/compose goes
 * through the REAL `fleet-lock.ts` functions against a real temp directory —
 * this is deliberate (see `reference_test_that_constructs_the_seam_it_should_observe`):
 * the risk this suite guards against is "the recorder writes a shape
 * `readFleetLockFile` can't parse back," which a hand-typed `ObservedState`
 * fixture would never catch.
 *
 * The final `describe` block closes DR-043 §D6's loop end-to-end (the
 * issue's requirement 4): recorder writes → REAL `readFleetLock` (the same
 * function `githubRegistryObserver` calls) parses it back → `computePlan`
 * shows the drift cleared. `version-steering.test.ts`'s step-4 test covers
 * the SAME contract with a hand-built `ObservedState` (cheaper, still
 * useful for the `computePlan` verb logic alone); this suite is the one
 * that proves the WRITE reaches a shape the REAL reader accepts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordDeployedVersionCore,
  buildRecordDeployedVersion,
  RecordDeployedVersionError,
  type RecordDeployedVersionDeps,
} from '../../../src/cli/bootstrap/fleet-lock-recorder.js';
import type { FleetManifest, FleetLock } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { parseFleetLock } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { writeFleetLock } from '../../../src/cli/bootstrap/fleet-lock.js';
import { readFleetLock } from '../../../src/cli/bootstrap/observer.js';
import { computePlan, type ObservedState } from '../../../src/cli/bootstrap/plan.js';

const FLEET_NAME = 'demo-fleet';

const MANIFEST: FleetManifest = {
  apiVersion: 'macf/v0',
  kind: 'Fleet',
  metadata: { name: FLEET_NAME },
  owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
  network: { advertise_host: 'example.ts.net' },
  transport: { age_recipients: ['age1operator'] },
  defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
  agents: [
    { role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/x' },
    { role: 'science-agent', profile: 'research', repo: 'groundnuty/demo-science', deploy_path: '/y' },
  ],
  trust: { ca: 'per-project', federated_cas: [] },
};

const SAME_FLEET_YAML = `apiVersion: macf/v0
kind: Fleet
metadata:
  name: ${FLEET_NAME}
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
  - role: science-agent
    profile: research
    repo: groundnuty/demo-science
    deploy_path: /y
trust:
  ca: per-project
  federated_cas: []
`;

const PRIOR_LOCK: FleetLock = {
  schema_version: 1,
  fleet: FLEET_NAME,
  agents: [
    { role: 'code-agent', app_id: 'app-code', install_id: 'install-code', fingerprints: { client_secret: 'sha256:abc' } },
    { role: 'science-agent', app_id: 'app-sci', install_id: 'install-sci' },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * A fake `cloneRepo` that "clones" by writing `PRIOR_LOCK` (or a caller-
 * supplied lock, or none at all) into the destination dir — models what a
 * real `git clone` of a previously-`apply`d control repo would bring back.
 */
function fakeCloneWriting(lock: FleetLock | null): (url: string, destDir: string) => Promise<void> {
  return async (_url, destDir) => {
    if (lock) writeFleetLock(join(destDir, 'fleet.lock'), lock);
  };
}

interface DepsCalls {
  checkMeta: string[];
  readManifestFile: string[];
  cloneRepo: { url: string; destDir: string }[];
  commitAndPush: { dir: string; message: string }[];
}

function baseDeps(overrides: Partial<RecordDeployedVersionDeps> = {}): { deps: RecordDeployedVersionDeps; calls: DepsCalls } {
  const calls: DepsCalls = { checkMeta: [], readManifestFile: [], cloneRepo: [], commitAndPush: [] };
  const scratchDir = freshDir('macf-lock-recorder-test-');
  const deps: RecordDeployedVersionDeps = {
    checkMeta: async (repo) => {
      calls.checkMeta.push(repo);
      return { presence: 'present', archived: false };
    },
    readManifestFile: async (repo) => {
      calls.readManifestFile.push(repo);
      return SAME_FLEET_YAML;
    },
    cloneRepo: async (url, destDir) => {
      calls.cloneRepo.push({ url, destDir });
      await fakeCloneWriting(PRIOR_LOCK)(url, destDir);
    },
    commitAndPush: async (dir, message) => {
      calls.commitAndPush.push({ dir, message });
      return 'pushed';
    },
    makeScratchDir: () => scratchDir,
    ...overrides,
  };
  return { deps, calls };
}

describe('recordDeployedVersionCore — the happy path (ownership "ours", prior entry exists)', () => {
  it('clones, composes over the prior lock, writes ONLY the touched role\'s deployed_version, and commits+pushes', async () => {
    const { deps, calls } = baseDeps();
    await recordDeployedVersionCore(MANIFEST, 'code-agent', FLEET_NAME, '0.2.60', deps);

    expect(calls.checkMeta).toEqual(['groundnuty/demo-fleet-control']);
    expect(calls.cloneRepo).toHaveLength(1);
    expect(calls.cloneRepo[0]!.url).toBe('https://github.com/groundnuty/demo-fleet-control.git');
    expect(calls.commitAndPush).toHaveLength(1);
    expect(calls.commitAndPush[0]!.message).toContain('0.2.60');
    expect(calls.commitAndPush[0]!.message).toContain('code-agent');

    const localDir = calls.cloneRepo[0]!.destDir;
    const written = parseFleetLock(readFileSync(join(localDir, 'fleet.lock'), 'utf-8'));
    const codeEntry = written.agents.find((a) => a.role === 'code-agent');
    const sciEntry = written.agents.find((a) => a.role === 'science-agent');
    expect(codeEntry?.deployed_version).toBe('0.2.60');
    // Identity + fingerprints carried forward verbatim (composeFleetLock's
    // no-prune / carry-forward contract, exercised through this writer).
    expect(codeEntry?.app_id).toBe('app-code');
    expect(codeEntry?.fingerprints).toEqual({ client_secret: 'sha256:abc' });
    // The UNTOUCHED role (science-agent) is carried forward with NO
    // deployed_version invented for it.
    expect(sciEntry?.deployed_version).toBeUndefined();
    expect(sciEntry?.app_id).toBe('app-sci');
  });

  it('a SECOND call for the other role preserves the first role\'s already-written deployed_version', async () => {
    // Models two agents in the same fleet going green in sequence within one
    // roll — each call clones fresh (a real `git clone` always starts from
    // the control repo's current HEAD, which includes the PRIOR call's
    // push), so the fake's `cloneRepo` here returns the lock as it stood
    // after the first write.
    let currentLock: FleetLock = PRIOR_LOCK;
    const calls: DepsCalls = { checkMeta: [], readManifestFile: [], cloneRepo: [], commitAndPush: [] };
    const deps: RecordDeployedVersionDeps = {
      checkMeta: async (repo) => { calls.checkMeta.push(repo); return { presence: 'present', archived: false }; },
      readManifestFile: async (repo) => { calls.readManifestFile.push(repo); return SAME_FLEET_YAML; },
      cloneRepo: async (url, destDir) => {
        calls.cloneRepo.push({ url, destDir });
        writeFleetLock(join(destDir, 'fleet.lock'), currentLock);
      },
      commitAndPush: async (dir, message) => {
        calls.commitAndPush.push({ dir, message });
        currentLock = parseFleetLock(readFileSync(join(dir, 'fleet.lock'), 'utf-8'));
        return 'pushed';
      },
      makeScratchDir: () => freshDir('macf-lock-recorder-test-'),
    };

    await recordDeployedVersionCore(MANIFEST, 'code-agent', FLEET_NAME, '0.2.60', deps);
    await recordDeployedVersionCore(MANIFEST, 'science-agent', FLEET_NAME, '0.2.60', deps);

    const codeEntry = currentLock.agents.find((a) => a.role === 'code-agent');
    const sciEntry = currentLock.agents.find((a) => a.role === 'science-agent');
    expect(codeEntry?.deployed_version).toBe('0.2.60');
    expect(sciEntry?.deployed_version).toBe('0.2.60');
  });
});

describe('recordDeployedVersionCore — ownership gate (never create / adopt / un-archive)', () => {
  it('"absent" (no control repo yet) → throws, never clones or commits', async () => {
    const { deps, calls } = baseDeps({
      checkMeta: async () => ({ presence: 'absent' }),
      readManifestFile: async () => { throw new Error('must not be called — presence is absent'); },
    });
    await expect(recordDeployedVersionCore(MANIFEST, 'code-agent', FLEET_NAME, '0.2.60', deps)).rejects.toThrow(RecordDeployedVersionError);
    expect(calls.cloneRepo).toEqual([]);
    expect(calls.commitAndPush).toEqual([]);
  });

  it('"foreign" (fleet.yaml name-mismatched) → throws, never clones or commits', async () => {
    const { deps, calls } = baseDeps({
      readManifestFile: async () => SAME_FLEET_YAML.replace(`name: ${FLEET_NAME}`, 'name: someone-elses-fleet'),
    });
    await expect(recordDeployedVersionCore(MANIFEST, 'code-agent', FLEET_NAME, '0.2.60', deps)).rejects.toThrow(RecordDeployedVersionError);
    expect(calls.cloneRepo).toEqual([]);
    expect(calls.commitAndPush).toEqual([]);
  });

  it('"unknown" (checkMeta cannot confirm existence) → throws, never clones or commits', async () => {
    const { deps, calls } = baseDeps({ checkMeta: async () => ({ presence: 'unknown' }) });
    await expect(recordDeployedVersionCore(MANIFEST, 'code-agent', FLEET_NAME, '0.2.60', deps)).rejects.toThrow(RecordDeployedVersionError);
    expect(calls.cloneRepo).toEqual([]);
    expect(calls.commitAndPush).toEqual([]);
  });

  it('"ours-archived" → throws, NEVER un-archives (this writer has no unarchive verb at all)', async () => {
    const { deps, calls } = baseDeps({ checkMeta: async () => ({ presence: 'present', archived: true }) });
    await expect(recordDeployedVersionCore(MANIFEST, 'code-agent', FLEET_NAME, '0.2.60', deps)).rejects.toThrow(/ours-archived/);
    expect(calls.cloneRepo).toEqual([]);
    expect(calls.commitAndPush).toEqual([]);
  });
});

describe('recordDeployedVersionCore — fail-loud refusals', () => {
  it('fleet name mismatch (the --file manifest is for a DIFFERENT fleet than this roll) → throws BEFORE any I/O', async () => {
    const { deps, calls } = baseDeps();
    await expect(recordDeployedVersionCore(MANIFEST, 'code-agent', 'a-different-fleet', '0.2.60', deps)).rejects.toThrow(RecordDeployedVersionError);
    expect(calls.checkMeta).toEqual([]);
    expect(calls.cloneRepo).toEqual([]);
  });

  it('no prior lock entry for the role → throws (never invents an app_id/install_id)', async () => {
    // cloneRepo writes NOTHING into the checkout — models a first-ever apply
    // that never touched this role (no fleet.lock entry to compose over).
    const { deps, calls } = baseDeps({ cloneRepo: async () => {} });
    await expect(recordDeployedVersionCore(MANIFEST, 'code-agent', FLEET_NAME, '0.2.60', deps)).rejects.toThrow(/no prior entry/);
    expect(calls.commitAndPush).toEqual([]);
  });
});

describe('buildRecordDeployedVersion — the -f, --file CLI entry point', () => {
  it('reads + parses a real fleet.yaml from disk, and the returned closure performs a real write', async () => {
    const dir = freshDir('macf-lock-recorder-manifest-');
    const manifestPath = join(dir, 'fleet.yaml');
    writeFileSync(manifestPath, SAME_FLEET_YAML, 'utf-8');
    const { deps, calls } = baseDeps();

    const recorder = buildRecordDeployedVersion(manifestPath, deps);
    await recorder('code-agent', FLEET_NAME, '0.2.61');

    expect(calls.commitAndPush).toHaveLength(1);
    const localDir = calls.cloneRepo[0]!.destDir;
    const written = parseFleetLock(readFileSync(join(localDir, 'fleet.lock'), 'utf-8'));
    expect(written.agents.find((a) => a.role === 'code-agent')?.deployed_version).toBe('0.2.61');
  });

  it('an unreadable/invalid manifest path throws SYNCHRONOUSLY at build time — never mid-roll', () => {
    expect(() => buildRecordDeployedVersion('/does/not/exist/fleet.yaml')).toThrow();
  });
});

// --- DR-043 §D6 loop-closing — write → REAL read → computePlan drift clears ---

describe('the loop closes: recordDeployedVersionCore\'s write survives a REAL readFleetLock + computePlan round trip', () => {
  it('before the write: plan shows drift (update, confirm_required). After: plan shows noop for the rolled agent only', async () => {
    const dir = freshDir('macf-lock-recorder-loop-');
    const manifestPath = join(dir, 'fleet.yaml');
    writeFileSync(manifestPath, SAME_FLEET_YAML, 'utf-8');

    const manifestWithVersions: FleetManifest = { ...MANIFEST, versions: { macf: '0.2.61', actions: 'v3.4.1' } };

    function planFor(lock: ReturnType<typeof readFleetLock>): ReturnType<typeof computePlan> {
      const observed: ObservedState = {
        lock,
        agents: {
          'code-agent': {
            app: lock?.agents.some((a) => a.role === 'code-agent') ? 'present' : 'unknown',
            install: 'present',
            repo: 'present',
            fingerprints: {},
            deployedVersion: lock?.agents.find((a) => a.role === 'code-agent')?.deployed_version,
            actionsPin: 'v3.4.1',
          },
          'science-agent': {
            app: 'present',
            install: 'present',
            repo: 'present',
            fingerprints: {},
            deployedVersion: lock?.agents.find((a) => a.role === 'science-agent')?.deployed_version,
            actionsPin: 'v3.4.1',
          },
        },
        caRegistry: 'present',
        caRepos: { 'groundnuty/demo-code': 'present', 'groundnuty/demo-science': 'present' },
      };
      return computePlan(manifestWithVersions, observed);
    }

    // BEFORE: the control repo's fleet.lock has identities but no
    // deployed_version yet (mirrors a fresh `apply`, never rolled).
    writeFleetLock(join(dir, 'fleet.lock'), PRIOR_LOCK);
    const before = planFor(readFleetLock(manifestPath));
    const codeItemBefore = before.items.find((i) => i.kind === 'version' && i.target === 'agent:code-agent:version:macf');
    expect(codeItemBefore?.verb).toBe('create'); // unknown -> low-confidence create, per Amendment A's honest-unknown floor
    const sciItemBefore = before.items.find((i) => i.kind === 'version' && i.target === 'agent:science-agent:version:macf');
    expect(sciItemBefore?.verb).toBe('create');

    // ACT: recordDeployedVersionCore rolls code-agent to the target — clone
    // reads the SAME on-disk `dir` (models a checkout whose remote IS this
    // dir, so the write + a subsequent read observe the same content), and
    // commitAndPush is a no-op push (the write already landed in `dir`
    // itself since makeScratchDir points there — see this test's deps).
    const { deps } = baseDeps({
      cloneRepo: async () => {}, // no-op: the "clone" IS `dir` (makeScratchDir below)
      makeScratchDir: () => dir,
    });
    await recordDeployedVersionCore(manifestWithVersions, 'code-agent', FLEET_NAME, '0.2.61', deps);

    // AFTER: re-read via the REAL production reader (`observer.ts::readFleetLock`,
    // the same function `githubRegistryObserver` calls) — not a hand-typed
    // fixture — then recompute the plan.
    const after = planFor(readFleetLock(manifestPath));
    const codeItemAfter = after.items.find((i) => i.kind === 'version' && i.target === 'agent:code-agent:version:macf');
    expect(codeItemAfter?.verb).toBe('noop'); // drift CLEARED for the rolled agent
    expect(codeItemAfter?.confirm_required).toBe(false);
    expect(codeItemAfter?.reason).toContain('already "0.2.61"');

    // The UNTOUCHED agent (science-agent) is unaffected — still unknown/create,
    // never silently marked as matching just because a sibling rolled.
    const sciItemAfter = after.items.find((i) => i.kind === 'version' && i.target === 'agent:science-agent:version:macf');
    expect(sciItemAfter?.verb).toBe('create');
  });
});
