/**
 * Tests for `fleet-deploy.ts` — the `macf fleet deploy` per-agent
 * orchestration (materializes a running-agent workspace from an
 * already-provisioned fleet's vault).
 *
 * Everything except the trailing "REAL age binary" block is offline: `readVault`
 * / `cloneRepo` / `initAgent` are all injected fakes. The real-age block
 * mints a SYNTHETIC key via `age-keygen` and round-trips a real
 * `writeVault` → `readVault` — a faked seam cannot verify the decrypt
 * contract (per this codebase's own "test that constructs the seam it
 * should observe" lesson), so that one test deliberately uses the real
 * `readVault` from `vault-read.ts`, gated `skipIf(!HAS_AGE)` per
 * `vault-read.test.ts`'s own convention.
 *
 * **Never touches a real operator path.** Every test that reaches
 * `deployAgent` supplies `keyPathFor` pointed at a `mkdtempSync` scratch
 * dir — the production default (`defaultAgentKeyPath`) resolves under the
 * REAL operator's `~/.macf/keys/`, which may hold a live fleet's key; a
 * test that omitted this seam could read a real key as "already present" or
 * (worse) overwrite one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FleetDeployError,
  deployAgent,
  ensureAgentWorkspaceCloned,
  extractAgentVaultCredentials,
  initRegistryOptionsFor,
  writeAgentKeyAtomic0600,
  type FleetDeployDeps,
} from '../../../src/cli/bootstrap/fleet-deploy.js';
import type { FleetAgent, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { deriveAppHandle } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { readVault } from '../../../src/cli/bootstrap/vault-read.js';
import { VaultError, buildVaultPlaintext, writeVault, type VaultAgentSecrets, type VaultPayload } from '../../../src/cli/bootstrap/vault-write.js';
import { secretFingerprint } from '../../../src/cli/bootstrap/fleet-lock.js';
import type { InitOptions } from '../../../src/cli/commands/init.js';

function have(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).status === 0;
}
const HAS_AGE = have('age') && have('age-keygen');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratchDir(prefix = 'macf-fleet-deploy-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const FLEET = 'demo-fleet';
const ROLE = 'code-agent';
const AGENT: FleetAgent = { role: ROLE, profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/unused-in-tests' };
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nSYNTH-PEM-BYTES-FOR-FLEET-DEPLOY-TEST\n-----END RSA PRIVATE KEY-----\n';

function manifestWith(registry: FleetManifest['owner']['registry'] = { type: 'profile', user: 'groundnuty' }): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: FLEET },
    versions: { macf: '0.2.56', actions: 'v3.4.1' },
    owner: { account: 'groundnuty', type: 'user', registry },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [AGENT],
    trust: { ca: 'per-project', federated_cas: [] },
  };
}

function vaultRawFor(appId: string, installId: string, pem: string): Readonly<Record<string, string>> {
  const seg = deriveAppHandle(FLEET, ROLE).toUpperCase().replace(/-/g, '_');
  return {
    [`MACF_AGENT_${seg}_APP_ID`]: appId,
    [`MACF_AGENT_${seg}_INSTALL_ID`]: installId,
    [`MACF_AGENT_${seg}_CLIENT_ID`]: 'Iv1.abc',
    [`MACF_AGENT_${seg}_CLIENT_SECRET`]: 'SYNTH-CLIENT-SECRET',
    [`MACF_AGENT_${seg}_WEBHOOK_SECRET`]: 'SYNTH-WEBHOOK-SECRET',
    [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from(pem, 'utf-8').toString('base64'),
  };
}

// --- extractAgentVaultCredentials ---

describe('extractAgentVaultCredentials', () => {
  it('decodes app_id/install_id/private-key (base64 -> raw PEM) for a fully-provisioned role', () => {
    const raw = vaultRawFor('111', '222', PEM);
    const creds = extractAgentVaultCredentials(raw, FLEET, ROLE);
    expect(creds.appId).toBe('111');
    expect(creds.installId).toBe('222');
    expect(creds.privateKeyPem).toBe(PEM);
  });

  it('refuses with vault_entry_missing_for_role when the role has NO vault entry at all — names the fields, never a value', () => {
    const raw = vaultRawFor('111', '222', PEM); // provisioned for ROLE, not for the role queried below
    try {
      extractAgentVaultCredentials(raw, FLEET, 'never-provisioned-role');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FleetDeployError);
      expect((e as FleetDeployError).code).toBe('vault_entry_missing_for_role');
      expect((e as FleetDeployError).message).toContain('app_id');
      expect((e as FleetDeployError).message).toContain('install_id');
      expect((e as FleetDeployError).message).toContain('private_key');
      expect((e as FleetDeployError).message).not.toContain(PEM);
    }
  });

  it('refuses when the role has a PARTIAL entry (e.g. app_id present, private key missing) — never proceeds with a partial credential', () => {
    const seg = deriveAppHandle(FLEET, ROLE).toUpperCase().replace(/-/g, '_');
    const raw = { [`MACF_AGENT_${seg}_APP_ID`]: '111', [`MACF_AGENT_${seg}_INSTALL_ID`]: '222' };
    try {
      extractAgentVaultCredentials(raw, FLEET, ROLE);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as FleetDeployError).code).toBe('vault_entry_missing_for_role');
      expect((e as FleetDeployError).message).toContain('private_key');
      expect((e as FleetDeployError).message).not.toContain('app_id');
      expect((e as FleetDeployError).message).not.toContain('install_id');
    }
  });
});

// --- writeAgentKeyAtomic0600 ---

describe('writeAgentKeyAtomic0600', () => {
  it('writes the exact PEM bytes at 0600, and cleans up its scratch dir', () => {
    const dir = scratchDir();
    const dest = join(dir, 'nested', 'agent.pem');
    writeAgentKeyAtomic0600(dest, PEM);

    expect(readFileSync(dest, 'utf-8')).toBe(PEM);
    const mode = statSync(dest).mode & 0o777;
    expect(mode).toBe(0o600);

    // No leftover `.macf-key-*` scratch dirs beside the destination.
    const siblings = readdirSync(join(dir, 'nested'));
    expect(siblings.filter((n) => n.startsWith('.macf-key-'))).toEqual([]);
  });

  it('creates the destination parent directory if absent', () => {
    const dir = scratchDir();
    const dest = join(dir, 'a', 'b', 'c', 'agent.pem');
    expect(existsSync(join(dir, 'a'))).toBe(false);
    writeAgentKeyAtomic0600(dest, PEM);
    expect(existsSync(dest)).toBe(true);
  });
});

// --- ensureAgentWorkspaceCloned ---

describe('ensureAgentWorkspaceCloned', () => {
  it('clones when the destination is absent', async () => {
    const dir = scratchDir();
    const dest = join(dir, 'workspace');
    let cloneArgs: { url: string; dest: string } | undefined;
    const outcome = await ensureAgentWorkspaceCloned('groundnuty/demo-code', dest, async (url, d) => {
      cloneArgs = { url, dest: d };
      mkdirSync(d, { recursive: true });
    });
    expect(outcome).toBe('cloned');
    expect(cloneArgs).toEqual({ url: 'https://github.com/groundnuty/demo-code.git', dest });
  });

  it('clones when the destination exists but is EMPTY', async () => {
    const dir = scratchDir();
    const dest = join(dir, 'workspace');
    mkdirSync(dest, { recursive: true });
    let cloned = false;
    const outcome = await ensureAgentWorkspaceCloned('groundnuty/demo-code', dest, async () => {
      cloned = true;
    });
    expect(outcome).toBe('cloned');
    expect(cloned).toBe(true);
  });

  it('SKIPS + never calls cloneRepo when the destination already has content — idempotent, does not clobber', async () => {
    const dir = scratchDir();
    const dest = join(dir, 'workspace');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'operator-modified.txt'), 'do not touch me');
    const outcome = await ensureAgentWorkspaceCloned('groundnuty/demo-code', dest, async () => {
      throw new Error('must not be called — destination is already populated');
    });
    expect(outcome).toBe('skipped-existing');
    expect(readFileSync(join(dest, 'operator-modified.txt'), 'utf-8')).toBe('do not touch me');
  });
});

// --- initRegistryOptionsFor ---

describe('initRegistryOptionsFor', () => {
  it('maps org', () => {
    expect(initRegistryOptionsFor({ type: 'org', org: 'groundnuty' })).toEqual({ registryType: 'org', registryOrg: 'groundnuty' });
  });
  it('maps profile', () => {
    expect(initRegistryOptionsFor({ type: 'profile', user: 'groundnuty' })).toEqual({ registryType: 'profile', registryUser: 'groundnuty' });
  });
  it('maps repo to a single owner/repo registryRepo string', () => {
    expect(initRegistryOptionsFor({ type: 'repo', owner: 'groundnuty', repo: 'demo-control' })).toEqual({
      registryType: 'repo',
      registryRepo: 'groundnuty/demo-control',
    });
  });
  it('refuses local — a bootstrap-provisioned fleet has no local-mode App/vault to deploy from', () => {
    expect(() => initRegistryOptionsFor({ type: 'local', path: '/x' })).toThrow(FleetDeployError);
    try {
      initRegistryOptionsFor({ type: 'local', path: '/x' });
    } catch (e) {
      expect((e as FleetDeployError).code).toBe('registry_local_unsupported');
    }
  });
});

// --- deployAgent (offline, injected deps) ---

function fakeInitAgent(calls: { dir: string; opts: InitOptions }[]): FleetDeployDeps['initAgent'] {
  return async (dir, opts) => {
    calls.push({ dir, opts });
  };
}

describe('deployAgent — offline (injected readVault/cloneRepo/initAgent)', () => {
  it('happy path: workspace cloned, key written at 0600, initAgent called with the EXACT ids/paths (not just "was called")', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);

    const initCalls: { dir: string; opts: InitOptions }[] = [];
    let cloned: { url: string; dest: string } | undefined;

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async (url, d) => {
          cloned = { url, dest: d };
          mkdirSync(d, { recursive: true });
        },
        initAgent: fakeInitAgent(initCalls),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');
    expect(outcome.appId).toBe('111');
    expect(outcome.installId).toBe('222');
    expect(outcome.workspace).toBe('cloned');
    expect(outcome.keyPath).toBe(keyPath);
    expect(outcome.keyWrite).toBe('written');
    expect(outcome.keyFingerprint).toBe(secretFingerprint(PEM));

    expect(cloned).toEqual({ url: 'https://github.com/groundnuty/demo-code.git', dest: destDir });

    // Key materialized for real, at 0600, with the exact PEM.
    expect(readFileSync(keyPath, 'utf-8')).toBe(PEM);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    // initAgent got the RIGHT args — asserted field by field, not just "called once".
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0]?.dir).toBe(destDir);
    expect(initCalls[0]?.opts).toMatchObject({
      project: FLEET,
      role: ROLE,
      appId: '111',
      installId: '222',
      keyPath,
      advertiseHost: 'example.ts.net',
      cliVersion: '0.2.56',
      actionsVersion: 'v3.4.1',
      registryType: 'profile',
      registryUser: 'groundnuty',
    });
  });

  it('IDEMPOTENT key write: a pre-existing key file at the destination is left byte-for-byte untouched on re-run', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    // Non-empty so the workspace-materialize step ALSO skips (this test
    // isolates the key-write idempotency; workspace idempotency has its own
    // dedicated test below).
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'already-here.txt'), 'x');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    writeFileSync(keyPath, 'OPERATOR-ROTATED-KEY-SENTINEL', { mode: 0o600 });

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async () => {
          throw new Error('must not be called — workspace already has content');
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');
    expect(outcome.keyWrite).toBe('skipped-existing');
    // The sentinel content proves this is the SAME file, never clobbered by the vault's (different) PEM.
    expect(readFileSync(keyPath, 'utf-8')).toBe('OPERATOR-ROTATED-KEY-SENTINEL');
  });

  it('IDEMPOTENT workspace: a pre-existing populated destDir is left untouched (operator-modified file survives)', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'operator-modified.txt'), 'survive me');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async () => {
          throw new Error('must not be called');
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');
    expect(outcome.workspace).toBe('skipped-existing');
    expect(readFileSync(join(destDir, 'operator-modified.txt'), 'utf-8')).toBe('survive me');
  });

  it('vault missing entry for the role -> status "failed", reason names the missing fields, no secret anywhere', async () => {
    const dir = scratchDir();
    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      join(dir, 'workspace'),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => ({}), // empty vault — nothing provisioned for ANY role
        cloneRepo: async () => {
          throw new Error('must not be called — refused before touching the workspace');
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => join(scratchDir(), `${ROLE}.pem`),
      },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.reason).toContain('app_id');
    expect(outcome.reason).not.toContain(PEM);
  });

  it('unreadable identity (readVault throws) -> status "failed", message is specific, no secret leaks', async () => {
    const dir = scratchDir();
    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      join(dir, 'workspace'),
      { vaultPath: '/fake/vault.age', identityPath: '/nonexistent/key.txt' },
      {
        readVault: async () => {
          throw new VaultError('vault_identity_unreadable', 'age identity key not found or not readable at "/nonexistent/key.txt"');
        },
        cloneRepo: async () => {
          throw new Error('must not be called');
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => join(scratchDir(), `${ROLE}.pem`),
      },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.reason).toContain('/nonexistent/key.txt');
    expect(outcome.reason).not.toContain(PEM);
  });

  it('registry.type "local" -> status "failed" (refused, never guessed at a routing shape)', async () => {
    const dir = scratchDir();
    const outcome = await deployAgent(
      AGENT,
      manifestWith({ type: 'local', path: '/x' }),
      join(dir, 'workspace'),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async () => {
          throw new Error('must not be called');
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => join(scratchDir(), `${ROLE}.pem`),
      },
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.reason).toContain('local');
  });

  it('NEVER carries the secret value anywhere in the outcome — the redaction seam (mirrors vault-read.test.ts\'s serialization-leak test)', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    const keyPath = join(scratchDir(), `${ROLE}.pem`);
    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(PEM);
    expect(serialized).not.toContain('SYNTH-PEM-BYTES');
    expect(serialized).not.toContain(Buffer.from(PEM, 'utf-8').toString('base64'));
  });
});

// --- REAL age binary: the decrypt contract cannot be verified by a fake ---

describe('deployAgent — REAL age round-trip (a faked seam cannot verify the decrypt contract)', () => {
  function mintAgeKey(dir: string, name: string): { keyPath: string; publicKey: string } {
    const keyPath = join(dir, name);
    const r = spawnSync('age-keygen', ['-o', keyPath], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    const content = readFileSync(keyPath, 'utf-8');
    const match = /age1[0-9a-z]+/.exec(content);
    expect(match).not.toBeNull();
    return { keyPath, publicKey: match?.[0] ?? '' };
  }

  it.skipIf(!HAS_AGE)(
    'FULL ROUND-TRIP: buildVaultPlaintext -> writeVault (real age -e) -> deployAgent w/ REAL readVault (real age -d) ' +
      '-> the atomically-written key file matches the ORIGINAL PEM byte-for-byte, at 0600',
    async () => {
      const dir = scratchDir();
      const key = mintAgeKey(dir, 'operator-key.txt');
      const vaultPath = join(dir, 'vault.age');

      const agentSecrets: VaultAgentSecrets = {
        appHandle: deriveAppHandle(FLEET, ROLE),
        appId: '333',
        installId: '444',
        clientId: 'Iv1.real',
        clientSecret: 'REAL-CLIENT-SECRET',
        webhookSecret: 'REAL-WEBHOOK-SECRET',
        pem: PEM,
      };
      const payload: VaultPayload = { agents: [agentSecrets] };
      await writeVault(buildVaultPlaintext(payload), { outPath: vaultPath, recipients: [key.publicKey] });

      const destDir = join(dir, 'workspace');
      const keyPath = join(scratchDir(), `${ROLE}.pem`);
      const initCalls: { dir: string; opts: InitOptions }[] = [];

      const outcome = await deployAgent(
        AGENT,
        manifestWith(),
        destDir,
        { vaultPath, identityPath: key.keyPath },
        {
          readVault, // the REAL primitive — actually shells out to `age -d`
          cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
          initAgent: fakeInitAgent(initCalls),
          keyPathFor: () => keyPath,
        },
      );

      expect(outcome.status).toBe('deployed');
      if (outcome.status !== 'deployed') throw new Error('unreachable');
      expect(outcome.appId).toBe('333');
      expect(outcome.installId).toBe('444');
      expect(outcome.keyFingerprint).toBe(secretFingerprint(PEM));

      // The key that landed on disk is EXACTLY the PEM that was encrypted —
      // proves the full encrypt -> decrypt -> base64-decode -> atomic-write
      // chain reproduces the original bytes, not a faked stand-in.
      expect(readFileSync(keyPath, 'utf-8')).toBe(PEM);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);

      expect(initCalls[0]?.opts.appId).toBe('333');
      expect(initCalls[0]?.opts.installId).toBe('444');
      expect(initCalls[0]?.opts.keyPath).toBe(keyPath);

      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(PEM);
      expect(serialized).not.toContain('REAL-CLIENT-SECRET');
      expect(serialized).not.toContain('REAL-WEBHOOK-SECRET');
    },
  );

  it.skipIf(!HAS_AGE)(
    'MISSING IDENTITY (real vault, identity path does not exist): fails loud + specific, no secret anywhere in the reason',
    async () => {
      const dir = scratchDir();
      const key = mintAgeKey(dir, 'operator-key.txt');
      const vaultPath = join(dir, 'vault.age');
      const agentSecrets: VaultAgentSecrets = {
        appHandle: deriveAppHandle(FLEET, ROLE),
        appId: '333',
        installId: '444',
        clientId: 'Iv1.real',
        clientSecret: 'REAL-CLIENT-SECRET',
        webhookSecret: 'REAL-WEBHOOK-SECRET',
        pem: PEM,
      };
      await writeVault(buildVaultPlaintext({ agents: [agentSecrets] }), { outPath: vaultPath, recipients: [key.publicKey] });

      const missingIdentity = join(dir, 'no-such-identity.txt');
      const outcome = await deployAgent(
        AGENT,
        manifestWith(),
        join(dir, 'workspace'),
        { vaultPath, identityPath: missingIdentity },
        {
          readVault,
          cloneRepo: async () => {
            throw new Error('must not be called');
          },
          initAgent: fakeInitAgent([]),
          keyPathFor: () => join(scratchDir(), `${ROLE}.pem`),
        },
      );

      expect(outcome.status).toBe('failed');
      if (outcome.status !== 'failed') throw new Error('unreachable');
      expect(outcome.reason).toContain('no-such-identity.txt');
      expect(outcome.reason).not.toContain(PEM);
      expect(outcome.reason).not.toContain('REAL-CLIENT-SECRET');
    },
  );
});
