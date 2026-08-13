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
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractActionsPin, readFleetLock, vaultAwareObserver } from '../../../src/cli/bootstrap/observer.js';
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
