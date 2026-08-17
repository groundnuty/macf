/**
 * Tests for `readFleetLock` — the one pure(-ish), no-network piece of the
 * `observer.ts` I/O leaf (DR-043 Slice 1a, groundnuty/macf#838). The `gh`-
 * shelling functions (`checkRepoExists` / `readRepoVariable` /
 * `githubRegistryObserver`) are NOT unit-tested here — same posture as
 * `fleet-doctor-inject.ts`'s network fns (see that file's test-file doc
 * comment): they are thin `execFile('gh', ...)` wrappers, exercised through
 * `computePlan`'s injected-fake orchestration in `plan.test.ts` /
 * `bootstrap.test.ts`, not re-mocked here.
 *
 * `vaultAwareObserver` (DR-043 Amendment D phase 3, groundnuty/macf#838/#854)
 * is DIFFERENT from those `gh`-shelling fns — it's a pure COMPOSITION over
 * two injected functions (`observe` + `readVault`), same testable shape as
 * `apply-ca.ts`'s `resolveCaCert`. Tested below with both deps faked; the one
 * real `age` I/O leaf it calls through (`vault-read.ts::readVault` /
 * `ageDecryptFile`) is exercised for real in `vault-read.test.ts` instead.
 *
 * `extractActionsPin` (DR-043 §D6, `versions.actions` observed-state source)
 * is the OTHER exception: it was deliberately split out of
 * `readCallerActionsPin`'s `gh` shell-out as a pure regex-extraction
 * function specifically so it stays independently testable without
 * mocking `node:child_process` — see its own doc comment. Tested below,
 * same "pure(-ish), no-network" bar as `readFleetLock`.
 *
 * `checkRunnerUsableByRepo` (macf#924 — correcting the org-runner-blind cost
 * regression in macf#922/#923) is a THIRD exception, for the same reason as
 * `vaultAwareObserver`: it's a pure COMPOSITION over an injected
 * `RunnerUsabilityDeps` seam (repo-scope / org-groups-visible-to-repo /
 * org-runner-group-ids), not a bare `execFile` wrapper — the required test
 * matrix (repo-level / org `all` / org `selected`-excluded /
 * `selected`-included / absent / unreadable) needs per-scenario control over
 * 3 independent reads that a single `execFile` mock can't cleanly express.
 * Tested below with `RunnerUsabilityDeps` faked, no real `gh`/network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRunnerUsableByRepo, extractActionsPin, isRunnerCapable, readFleetLock, vaultAwareObserver } from '../../../src/cli/bootstrap/observer.js';
import type { OrgRunnerRecord, RunnerCapability, RunnerUsabilityDeps } from '../../../src/cli/bootstrap/observer.js';
import { ROUTER_EMITTED_LABELS } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { ObservedState } from '../../../src/cli/bootstrap/plan.js';
import { VaultError } from '../../../src/cli/bootstrap/vault-write.js';

describe('readFleetLock', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'macf-bootstrap-observer-test-'));
    dirs.push(d);
    return d;
  }

  it('returns null when fleet.lock is absent next to the manifest (the common not-yet-provisioned case)', () => {
    const dir = tempDir();
    const manifestPath = join(dir, 'fleet.yaml');
    writeFileSync(manifestPath, 'apiVersion: macf/v0\n');
    expect(readFleetLock(manifestPath)).toBeNull();
  });

  it('parses a valid co-located fleet.lock', () => {
    const dir = tempDir();
    const manifestPath = join(dir, 'fleet.yaml');
    writeFileSync(manifestPath, 'apiVersion: macf/v0\n');
    writeFileSync(
      join(dir, 'fleet.lock'),
      'schema_version: 1\nfleet: icsoc-2026\nagents:\n  - role: code-agent\n    app_id: "1"\n    install_id: "2"\n',
    );
    const lock = readFleetLock(manifestPath);
    expect(lock?.fleet).toBe('icsoc-2026');
    expect(lock?.agents).toHaveLength(1);
  });

  it('returns null (never throws) on a malformed fleet.lock', () => {
    const dir = tempDir();
    const manifestPath = join(dir, 'fleet.yaml');
    writeFileSync(manifestPath, 'apiVersion: macf/v0\n');
    writeFileSync(join(dir, 'fleet.lock'), 'schema_version: 999\nfleet: bad\nagents: []\n');
    expect(readFleetLock(manifestPath)).toBeNull();
  });

  it('resolves fleet.lock relative to the manifest\'s DIRECTORY, not cwd', () => {
    const dir = tempDir();
    const nested = join(dir, 'nested');
    mkdirSync(nested, { recursive: true });
    const manifestPath = join(nested, 'fleet.yaml');
    writeFileSync(manifestPath, 'apiVersion: macf/v0\n');
    writeFileSync(
      join(nested, 'fleet.lock'),
      'schema_version: 1\nfleet: nested-fleet\nagents: []\n',
    );
    // A fleet.lock at the temp root (NOT next to the manifest) must be ignored.
    writeFileSync(join(dir, 'fleet.lock'), 'schema_version: 1\nfleet: wrong-one\nagents: []\n');
    expect(readFleetLock(manifestPath)?.fleet).toBe('nested-fleet');
  });
});

function baseManifest(): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'demo-fleet' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: [] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [
      { role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-fleet-experiment', deploy_path: '/deploy/code-agent' },
    ],
    trust: { ca: 'per-project', federated_cas: [] },
  };
}

const EMPTY_AGENT_OBS = { app: 'unknown', install: 'unknown', repo: 'unknown', fingerprints: {} } as const;
const BASE_OBSERVED: ObservedState = {
  lock: null,
  agents: { 'code-agent': EMPTY_AGENT_OBS },
  caRegistry: 'unknown',
  caRepos: {},
};

describe('vaultAwareObserver — DR-043 Amendment D phase 3 (injected deps, no real gh/age)', () => {
  const manifest = baseManifest();

  it('a SUCCESSFUL vault read decorates every agent + the fleet with a `confirmed` vault observation, carrying the BASE observation through unchanged', async () => {
    const raw = { MACF_AGENT_DEMO_FLEET_CODE_AGENT_CLIENT_SECRET: 'x', MACF_DEMO_FLEET_CA_KEY_B64: Buffer.from('k').toString('base64') };
    const observed = await vaultAwareObserver(
      manifest,
      '/fake/fleet.yaml',
      { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
      { observe: async () => BASE_OBSERVED, readVault: async () => raw },
    );
    expect(observed.lock).toBe(BASE_OBSERVED.lock);
    expect(observed.caRegistry).toBe(BASE_OBSERVED.caRegistry);
    expect(observed.agents['code-agent']?.app).toBe('unknown'); // base field untouched
    expect(observed.agents['code-agent']?.vault?.status).toBe('confirmed');
    if (observed.agents['code-agent']?.vault?.status === 'confirmed') {
      expect(observed.agents['code-agent'].vault.presence.clientSecret.present).toBe(true);
    }
    expect(observed.vaultCa?.status).toBe('confirmed');
    if (observed.vaultCa?.status === 'confirmed') {
      expect(observed.vaultCa.presence.caKey.present).toBe(true);
    }
  });

  it('a FAILED vault read (e.g. missing vault) degrades EVERY agent + the fleet to `unknown` — NEVER `absent` (Amendment A4 floor)', async () => {
    const observed = await vaultAwareObserver(
      manifest,
      '/fake/fleet.yaml',
      { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
      {
        observe: async () => BASE_OBSERVED,
        readVault: async () => {
          throw new VaultError('vault_not_found', 'vault file not found at "/fake/secrets/vault.age" — nothing to decrypt.');
        },
      },
    );
    expect(observed.agents['code-agent']?.vault?.status).toBe('unknown');
    if (observed.agents['code-agent']?.vault?.status === 'unknown') {
      expect(observed.agents['code-agent'].vault.reason).toContain('vault file not found');
    }
    expect(observed.vaultCa?.status).toBe('unknown');
    if (observed.vaultCa?.status === 'unknown') {
      expect(observed.vaultCa.reason).toContain('vault file not found');
    }
  });

  it('a missing/unreadable identity key degrades to `unknown` with an actionable reason, not `absent` — "an absent identity key is not evidence of an empty vault"', async () => {
    const observed = await vaultAwareObserver(
      manifest,
      '/fake/fleet.yaml',
      { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/missing-key.txt' },
      {
        observe: async () => BASE_OBSERVED,
        readVault: async () => {
          throw new VaultError(
            'vault_identity_unreadable',
            'age identity key not found or not readable at "/fake/missing-key.txt" — supply the path to the ' +
              "operator's (or the VM's) age private-key file.",
          );
        },
      },
    );
    expect(observed.agents['code-agent']?.vault?.status).toBe('unknown');
    expect(observed.vaultCa?.status).toBe('unknown');
    if (observed.vaultCa?.status === 'unknown') {
      expect(observed.vaultCa.reason).toContain('missing-key.txt');
      expect(observed.vaultCa.reason).not.toBe('absent');
    }
  });

  it('the `unknown` reason NEVER leaks secret material — it is always the scrubbed VaultError message, never a raw value', async () => {
    const observed = await vaultAwareObserver(
      manifest,
      '/fake/fleet.yaml',
      { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
      {
        observe: async () => BASE_OBSERVED,
        readVault: async () => {
          throw new VaultError('vault_decrypt_failed', 'age -d exited 1 decrypting "/fake/secrets/vault.age" — wrong identity key.');
        },
      },
    );
    const serialized = JSON.stringify(observed);
    expect(serialized).toContain('wrong identity key');
    // Structural check: nothing PEM/secret-shaped could have entered this
    // path at all (readVault threw before returning anything), but assert
    // the shape explicitly so a future refactor can't silently start
    // stuffing the raw map into the observation on a failure path.
    expect(serialized).not.toContain('-----BEGIN');
  });

  it('does NOT re-derive agents from the manifest — decorates exactly the roles the BASE observer already returned', async () => {
    const observed = await vaultAwareObserver(
      manifest,
      '/fake/fleet.yaml',
      { vaultPath: '/fake/secrets/vault.age', identityPath: '/fake/key.txt' },
      { observe: async () => ({ ...BASE_OBSERVED, agents: {} }), readVault: async () => ({}) },
    );
    expect(Object.keys(observed.agents)).toEqual([]);
  });
});

describe('extractActionsPin (DR-043 §D6 — versions.actions observed-state source)', () => {
  it('extracts the pin from a real agent-router.yml `uses:` line', () => {
    const content = [
      'name: Agent Router',
      'on:',
      '  issues:',
      '    types: [opened]',
      'jobs:',
      '  route:',
      '    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.4.1',
      '    secrets: inherit',
    ].join('\n');
    expect(extractActionsPin(content)).toBe('v3.4.1');
  });

  it('extracts a legacy v1.x pin (still a valid — if deferred — router)', () => {
    const content = '    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v1.3.3\n';
    expect(extractActionsPin(content)).toBe('v1.3.3');
  });

  it('returns undefined when the workflow has no macf-actions `uses:` line', () => {
    const content = 'name: Some Other Workflow\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
    expect(extractActionsPin(content)).toBeUndefined();
  });

  it('returns undefined for empty content', () => {
    expect(extractActionsPin('')).toBeUndefined();
  });
});

// --- isRunnerCapable — macf#934: the capability predicate, tested standalone (pure) ---

/** A runner carrying online status + exactly the router's required labels — the baseline every fixture below overrides from. */
function capableRunner(overrides: Partial<RunnerCapability> = {}): RunnerCapability {
  return { status: 'online', busy: false, labels: new Set(ROUTER_EMITTED_LABELS), ...overrides };
}

describe('isRunnerCapable (macf#934 — the missing half of register-before-route: CAN this runner claim a routed job)', () => {
  it('online + exact label match -> capable', () => {
    expect(isRunnerCapable(capableRunner(), ROUTER_EMITTED_LABELS)).toBe(true);
  });

  it('the busy trap — BUSY + online + label-matching (our own live runner\'s actual shape) -> STILL capable; busy is never consulted', () => {
    // Verified live shape (issue brief): status=online busy=true
    // labels=[self-hosted,Linux,X64,macf-vm] — extra GitHub-assigned OS/arch
    // labels PLUS busy:true. A naive `online && !busy` predicate would score
    // this healthy, job-claiming runner as unusable.
    const runner = capableRunner({ busy: true, labels: new Set(['self-hosted', 'Linux', 'X64', 'macf-vm']) });
    expect(isRunnerCapable(runner, ROUTER_EMITTED_LABELS)).toBe(true);
  });

  it('online but missing a required label -> NOT capable', () => {
    const runner = capableRunner({ labels: new Set(['self-hosted']) }); // missing "macf-vm"
    expect(isRunnerCapable(runner, ROUTER_EMITTED_LABELS)).toBe(false);
  });

  it('carries every required label but is OFFLINE -> NOT capable', () => {
    const runner = capableRunner({ status: 'offline' });
    expect(isRunnerCapable(runner, ROUTER_EMITTED_LABELS)).toBe(false);
  });

  it('an unrecognized/future status value (not "online") -> NOT capable — exact equality, never a looser check', () => {
    const runner = capableRunner({ status: 'idle' });
    expect(isRunnerCapable(runner, ROUTER_EMITTED_LABELS)).toBe(false);
  });

  it('extra labels beyond the required set do not disqualify — superset, not equality', () => {
    const runner = capableRunner({ labels: new Set(['self-hosted', 'macf-vm', 'gpu', 'Linux']) });
    expect(isRunnerCapable(runner, ROUTER_EMITTED_LABELS)).toBe(true);
  });
});

// --- checkRunnerUsableByRepo — macf#924 org-scope correction, macf#934 capability gate ---

/** An org-level runner fixture, capable by default (online + required labels), in group 1. */
function orgRunner(overrides: Partial<OrgRunnerRecord> = {}): OrgRunnerRecord {
  return { status: 'online', busy: false, labels: new Set(ROUTER_EMITTED_LABELS), runnerGroupId: 1, ...overrides };
}

/**
 * A deps fixture with a confirmed-EMPTY repo scope and NO org runner group/
 * runner — the "nothing anywhere" baseline every scenario below overrides
 * from.
 */
function depsWith(overrides: Partial<RunnerUsabilityDeps> = {}): RunnerUsabilityDeps {
  return {
    listRepoScopedRunners: async () => ({ kind: 'ok', runners: [] }),
    listRunnerGroupsVisibleToRepo: async () => [],
    listOrgRunners: async () => [],
    ...overrides,
  };
}

describe('checkRunnerUsableByRepo (macf#924 org-scope correction; macf#934 capability gate)', () => {
  it('repo-level CAPABLE runner present -> present (org scope never even consulted)', async () => {
    let orgCallMade = false;
    const deps = depsWith({
      listRepoScopedRunners: async () => ({ kind: 'ok', runners: [capableRunner()] }),
      listRunnerGroupsVisibleToRepo: async () => {
        orgCallMade = true;
        return [];
      },
      listOrgRunners: async () => {
        orgCallMade = true;
        return [];
      },
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability).toEqual({ presence: 'present' });
    expect(orgCallMade).toBe(false);
  });

  it('online but missing a required label -> NOT present; detail names the missing label AND the runner found', async () => {
    const deps = depsWith({
      listRepoScopedRunners: async () => ({ kind: 'ok', runners: [capableRunner({ labels: new Set(['self-hosted']) })] }),
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).toBe('absent');
    expect(usability.detail).toBeDefined();
    expect(usability.detail).toContain('macf-vm'); // the missing label, named
    expect(usability.detail).toMatch(/online/);
    expect(usability.detail).toContain('self-hosted'); // what WAS found, so the operator isn't sent looking blind
  });

  it('label-match but OFFLINE -> NOT present; detail says offline, not mislabeled', async () => {
    const deps = depsWith({
      listRepoScopedRunners: async () => ({ kind: 'ok', runners: [capableRunner({ status: 'offline' })] }),
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).toBe('absent');
    expect(usability.detail).toBeDefined();
    expect(usability.detail).toMatch(/offline/);
    expect(usability.detail).not.toMatch(/missing/);
  });

  it('the busy trap end-to-end — BUSY + online + label-matching -> present (our own live runner would fail a wrong online&&!busy implementation)', async () => {
    const deps = depsWith({
      listRepoScopedRunners: async () => ({
        kind: 'ok',
        runners: [capableRunner({ busy: true, labels: new Set(['self-hosted', 'Linux', 'X64', 'macf-vm']) })],
      }),
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability).toEqual({ presence: 'present' });
  });

  it('a confirmed HTTP 403 on the repo-scoped leg -> unknown with a permission-specific detail, when the org leg ALSO cannot confirm', async () => {
    const deps = depsWith({
      listRepoScopedRunners: async () => ({ kind: 'forbidden' }),
      listRunnerGroupsVisibleToRepo: async () => 'unknown',
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).toBe('unknown');
    expect(usability.detail).toBeDefined();
    expect(usability.detail).toMatch(/insufficient permission/);
    expect(usability.detail).toContain('403');
    expect(usability.detail).toContain('administration: read');
  });

  it('a confirmed HTTP 403 on the repo-scoped leg does NOT short-circuit — a CAPABLE org runner still resolves present (macf#924 regression guard)', async () => {
    const deps = depsWith({
      listRepoScopedRunners: async () => ({ kind: 'forbidden' }),
      listRunnerGroupsVisibleToRepo: async () => [{ id: 1, name: 'Default' }],
      listOrgRunners: async () => [orgRunner()],
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability).toEqual({ presence: 'present' });
  });

  it('macf#924 REGRESSION — an org-level CAPABLE runner in an "all"-visibility group -> present (repo-scope alone read this as absent and skipped the write)', async () => {
    const deps = depsWith({
      // "all"-visibility means GitHub's own `visible_to_repository` resolution
      // returns this group for EVERY repo in the org — group id 1 (the
      // typical "Default" group id) shows up here without any repo-specific
      // allowlisting.
      listRunnerGroupsVisibleToRepo: async () => [{ id: 1, name: 'Default' }],
      listOrgRunners: async () => [orgRunner({ runnerGroupId: 1 })],
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).toBe('present');
    expect(usability.handover).toBeUndefined();
  });

  it('an org runner in a "selected"-visibility group that EXCLUDES this repo -> NOT present, org-admin handover reported', async () => {
    const deps = depsWith({
      // group 7 has a registered runner (see listOrgRunners) but is NOT in
      // the visible-to-this-repo list — excluded by selection.
      listRunnerGroupsVisibleToRepo: async () => [],
      listOrgRunners: async () => [orgRunner({ runnerGroupId: 7 })],
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).not.toBe('present');
    expect(usability.presence).toBe('absent');
    expect(usability.handover).toBeDefined();
    expect(usability.handover).toContain('groundnuty');
    expect(usability.handover).toContain('groundnuty/x');
    expect(usability.handover).toContain('https://github.com/organizations/groundnuty/settings/actions/runner-groups/7');
    expect(usability.handover).toMatch(/org admin/);
    expect(usability.handover).toMatch(/cannot perform that step itself/);
  });

  it('an org runner in a "selected"-visibility group that INCLUDES this repo and IS capable -> present', async () => {
    const deps = depsWith({
      listRunnerGroupsVisibleToRepo: async () => [{ id: 7, name: 'ci-runner' }],
      listOrgRunners: async () => [orgRunner({ runnerGroupId: 7 })],
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability).toEqual({ presence: 'present' });
  });

  it('an org runner visible to this repo but NOT capable (offline) -> NOT present, no handover (visibility was never the problem)', async () => {
    const deps = depsWith({
      listRunnerGroupsVisibleToRepo: async () => [{ id: 7, name: 'ci-runner' }],
      listOrgRunners: async () => [orgRunner({ runnerGroupId: 7, status: 'offline' })],
    });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).toBe('absent');
    expect(usability.handover).toBeUndefined();
    expect(usability.detail).toMatch(/offline/);
  });

  it('no runners anywhere (repo scope AND org scope both confidently empty) -> absent, nothing to hand over, nothing to detail', async () => {
    const usability = await checkRunnerUsableByRepo('groundnuty/x', depsWith());
    expect(usability).toEqual({ presence: 'absent' });
  });

  it('a repo-scoped leg with zero runners (confirmed absent) never produces "found runners" detail wording, even via a 404-folded read', async () => {
    const deps = depsWith({ listRepoScopedRunners: async () => ({ kind: 'ok', runners: [] }) });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).toBe('absent');
    expect(usability.detail).toBeUndefined();
  });

  it('an unreadable repo-scoped leg -> falls through to org scope; unknown, NEVER absent, when the org leg is confirmed empty', async () => {
    const deps = depsWith({ listRepoScopedRunners: async () => ({ kind: 'unknown' }) });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).toBe('unknown');
    expect(usability.presence).not.toBe('absent');
  });

  it('an unreadable org-groups-visible-to-repo leg (e.g. 403 for missing admin:org) -> unknown, NEVER absent', async () => {
    const deps = depsWith({ listRunnerGroupsVisibleToRepo: async () => 'unknown' });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).toBe('unknown');
    expect(usability.presence).not.toBe('absent');
    expect(usability.handover).toBeUndefined();
  });

  it('an unreadable listOrgRunners leg -> unknown, NEVER absent', async () => {
    const deps = depsWith({ listOrgRunners: async () => 'unknown' });
    const usability = await checkRunnerUsableByRepo('groundnuty/x', deps);
    expect(usability.presence).toBe('unknown');
    expect(usability.presence).not.toBe('absent');
  });

  it('a malformed repo string (no "owner/name" shape) degrades to unknown rather than throwing', async () => {
    const usability = await checkRunnerUsableByRepo('not-a-valid-repo-shape', depsWith());
    expect(usability.presence).toBe('unknown');
  });

  it('org-scope resolution derives owner/name from the FULL "owner/repo" string passed to org-scope reads', async () => {
    let seenOrg: string | undefined;
    let seenRepoName: string | undefined;
    const deps = depsWith({
      listRunnerGroupsVisibleToRepo: async (org, repoName) => {
        seenOrg = org;
        seenRepoName = repoName;
        return [];
      },
    });
    await checkRunnerUsableByRepo('groundnuty/demo-fleet-code-agent', deps);
    expect(seenOrg).toBe('groundnuty');
    expect(seenRepoName).toBe('demo-fleet-code-agent');
  });
});
