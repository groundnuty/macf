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
 *
 * **`PEM` / `OTHER_PEM` are REAL RSA keys (macf#975), not opaque strings.**
 * The macf#975 fingerprint-mismatch check parses whatever is on disk with
 * `node:crypto` (`publicKeyFingerprint` — see that function's own doc) —
 * a non-PEM sentinel string like the fixtures this file used to write would
 * throw at parse time instead of exercising the mismatch branch this file
 * means to test (this codebase's own "a test that constructs the seam it
 * should observe" lesson, applied to fixture DATA rather than a mocked
 * dependency). Generated ONCE at module scope (real RSA keygen has a real,
 * non-trivial cost) and reused across every test — including the ones that
 * don't touch the new mismatch logic at all, so there is exactly one
 * "the vault's key" concept in this file, not a fake one for old tests and
 * a real one for new tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
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
  authenticatedCloneUrl,
  parseAuthenticatedUrl,
  cloneArgsFor,
  realAuthenticatedCloneRepo,
  cloneViaInsteadOf,
  publicKeyFingerprint,
  type FleetDeployDeps,
} from '../../../src/cli/bootstrap/fleet-deploy.js';
import type { FleetAgent, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { deriveAppHandle } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { readVault } from '../../../src/cli/bootstrap/vault-read.js';
import { VaultError, buildVaultPlaintext, writeVault, type VaultAgentSecrets, type VaultPayload } from '../../../src/cli/bootstrap/vault-write.js';
import { secretFingerprint } from '../../../src/cli/bootstrap/fleet-lock.js';
import type { InitOptions } from '../../../src/cli/commands/init.js';
import { resolveAgeGate } from './age-binary-gate.js';

const HAS_AGE = resolveAgeGate('fleet-deploy.test.ts', 2);

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

/** One real RSA keypair's PKCS1 PEM (`-----BEGIN RSA PRIVATE KEY-----`) — GitHub's own App-key download format. */
function genRsaPemPkcs1(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

/** "The vault's" key throughout this file — unchanged usage for every pre-existing test (still just a secret-shaped string to them), but now a REAL key so the macf#975 mismatch-detection tests below can exercise real parsing. */
const PEM = genRsaPemPkcs1();
/** A genuinely DIFFERENT RSA key — stands in for "a previous, now-destroyed fleet's App key" in the mismatch tests. */
const OTHER_PEM = genRsaPemPkcs1();
/**
 * The SAME cryptographic key as {@link PEM}, re-encoded as PKCS8
 * (`-----BEGIN PRIVATE KEY-----`) instead of PKCS1 — the discriminating
 * fixture for macf#975's "encoding-invariant" requirement: a byte-hash
 * comparison would treat this as a DIFFERENT key than `PEM` (different
 * bytes); {@link publicKeyFingerprint} must treat it as the SAME key
 * (same underlying RSA key material, different serialization).
 */
const PEM_PKCS8_SAME_KEY = createPrivateKey(PEM).export({ type: 'pkcs8', format: 'pem' }) as string;

/** A recognizable fake token — never a real secret, just a sentinel this file's tests assert on/for (macf#968). */
const FAKE_TOKEN = 'FAKE-MINTED-CLONE-TOKEN-968';

/** `mintCloneToken` fake for tests whose `deployAgent` call must NEVER reach the clone step (workspace already populated, or an earlier refusal) — throwing here turns "clone was skipped as expected" into a hard assertion rather than a silent no-op. */
function mintCloneTokenMustNotBeCalled(): FleetDeployDeps['mintCloneToken'] {
  return async () => {
    throw new Error('must not be called — mintCloneToken is lazy and this test never reaches the clone step');
  };
}

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
        mintCloneToken: async () => FAKE_TOKEN,
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

    // THE DECISIVE ASSERTION (macf#968): the URL passed to the clone seam is
    // the AUTHENTICATED form, not the anonymous `https://github.com/...`
    // shape that shipped the bug. A test asserting only "cloneRepo was
    // called" would have passed against the broken code too.
    expect(cloned).toEqual({ url: authenticatedCloneUrl('groundnuty/demo-code', FAKE_TOKEN), dest: destDir });
    expect(cloned?.url).toBe('https://x-access-token:FAKE-MINTED-CLONE-TOKEN-968@github.com/groundnuty/demo-code.git');

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

  it('IDEMPOTENT key write: a pre-existing key file that MATCHES the vault is left byte-for-byte untouched on re-run', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    // Non-empty so the workspace-materialize step ALSO skips (this test
    // isolates the key-write idempotency; workspace idempotency has its own
    // dedicated test below).
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'already-here.txt'), 'x');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    // Same content the vault holds (byte-for-byte) — a prior deploy run's
    // own atomic write would look exactly like this.
    writeFileSync(keyPath, PEM, { mode: 0o600 });

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
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');
    expect(outcome.keyWrite).toBe('skipped-existing');
    expect(outcome.keyFingerprint).toBe(secretFingerprint(PEM));
    // Same content, never rewritten.
    expect(readFileSync(keyPath, 'utf-8')).toBe(PEM);
  });

  it('on-disk key MATCHES the vault -> skipped-existing, deploy proceeds normally (mint IS attempted — no refusal)', async () => {
    const dir = scratchDir();
    // Deliberately FRESH (not pre-populated) so the clone — and therefore the
    // lazy mint — actually runs; this is what proves the matching-fingerprint
    // path does not block the rest of the deploy (macf#975 AC).
    const destDir = join(dir, 'workspace');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    writeFileSync(keyPath, PEM, { mode: 0o600 });
    let mintCalled = false;

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
        mintCloneToken: async () => {
          mintCalled = true;
          return FAKE_TOKEN;
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');
    expect(outcome.keyWrite).toBe('skipped-existing');
    expect(mintCalled).toBe(true);
    expect(readFileSync(keyPath, 'utf-8')).toBe(PEM);
  });

  it('on-disk key does NOT match the vault -> refuses BEFORE the mint (the decisive assertion: mint seam never called — a post-mint refusal would still 401 first)', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    // A genuinely DIFFERENT (but still validly-parseable) RSA key — stands
    // in for "a previous, destroyed fleet's App key" left on disk.
    writeFileSync(keyPath, OTHER_PEM, { mode: 0o600 });

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async () => {
          throw new Error('must not be called — refused before touching the workspace');
        },
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.reason).toContain('does not match');
    expect(outcome.reason).toContain(publicKeyFingerprint(OTHER_PEM));
    expect(outcome.reason).toContain(publicKeyFingerprint(PEM));
    // The stale key is NEVER silently overwritten by the refusal path either.
    expect(readFileSync(keyPath, 'utf-8')).toBe(OTHER_PEM);
  });

  it('the SAME key re-encoded (PKCS8 vs PKCS1) is NOT a mismatch — the identity check is encoding-invariant, unlike a raw-PEM byte-hash', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    // Different BYTES than the vault's PKCS1 `PEM` (different armor, different
    // DER encoding) but the SAME underlying RSA key — a byte-hash comparison
    // would wrongly refuse this; publicKeyFingerprint must not.
    writeFileSync(keyPath, PEM_PKCS8_SAME_KEY, { mode: 0o600 });
    let mintCalled = false;

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
        mintCloneToken: async () => {
          mintCalled = true;
          return FAKE_TOKEN;
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');
    expect(outcome.keyWrite).toBe('skipped-existing');
    expect(mintCalled).toBe(true);
    // Untouched — still the PKCS8 encoding, never rewritten to the vault's PKCS1 form.
    expect(readFileSync(keyPath, 'utf-8')).toBe(PEM_PKCS8_SAME_KEY);
  });

  it('the refusal names BOTH fingerprints and BOTH remedies, and --force-key, but never the raw key material', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    writeFileSync(keyPath, OTHER_PEM, { mode: 0o600 });

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
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    const onDiskFp = publicKeyFingerprint(OTHER_PEM);
    const vaultFp = publicKeyFingerprint(PEM);
    // Both (public-key) fingerprints, named.
    expect(outcome.reason).toContain(onDiskFp);
    expect(outcome.reason).toContain(vaultFp);
    // Both remedies, named (remove/rename OR reconcile-and-re-run).
    expect(outcome.reason.toLowerCase()).toContain('remove or rename');
    expect(outcome.reason.toLowerCase()).toContain('reconcile');
    // The opt-in overwrite flag.
    expect(outcome.reason).toContain('--force-key');
    // Never the raw key material — neither PEM, in either private-key encoding.
    expect(outcome.reason).not.toContain(OTHER_PEM);
    expect(outcome.reason).not.toContain(PEM);
  });

  it('--force-key (deps.forceKey) re-materializes the on-disk key from the vault on mismatch instead of refusing', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    writeFileSync(keyPath, OTHER_PEM, { mode: 0o600 });
    const initCalls: { dir: string; opts: InitOptions }[] = [];

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
        mintCloneToken: async () => FAKE_TOKEN,
        initAgent: fakeInitAgent(initCalls),
        keyPathFor: () => keyPath,
        forceKey: true,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');
    expect(outcome.keyWrite).toBe('written');
    expect(outcome.keyFingerprint).toBe(secretFingerprint(PEM));
    // Overwritten with the vault's key — the stale sentinel is gone.
    expect(readFileSync(keyPath, 'utf-8')).toBe(PEM);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(initCalls).toHaveLength(1);
  });

  it('--force-key has NO effect when the on-disk key already matches the vault (still skipped-existing, no rewrite)', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'already-here.txt'), 'x');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    writeFileSync(keyPath, PEM, { mode: 0o600 });

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
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
        forceKey: true,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');
    expect(outcome.keyWrite).toBe('skipped-existing');
    expect(readFileSync(keyPath, 'utf-8')).toBe(PEM);
  });

  it('COMPOSITION (macf#975): destroy -> rebuild -> deploy on the same host — a key materialized against vault A, then a deploy against REBUILT vault B (different key, same role) refuses; a single-deploy test would pass either way', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    // Two GENUINELY DIFFERENT real RSA keys — vault A is the original
    // fleet's App key, vault B is what a destroy+rebuild produces (a
    // brand-new App, therefore a brand-new key, for the SAME role).
    const PEM_A = PEM;
    const PEM_B = OTHER_PEM;

    // Cycle N: deploy against the ORIGINAL fleet's vault -> the key materializes fresh.
    const first = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault-a.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM_A),
        cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
        mintCloneToken: async () => FAKE_TOKEN,
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );
    expect(first.status).toBe('deployed');
    if (first.status !== 'deployed') throw new Error('unreachable');
    expect(first.keyWrite).toBe('written');
    expect(readFileSync(keyPath, 'utf-8')).toBe(PEM_A);

    // destroy + rebuild: the App is destroyed and GitHub gives us a NEW one —
    // a fresh vault (fresh app_id/install_id/key) for the SAME role. The
    // on-disk key from cycle N is untouched on the host — exactly #970's
    // flagged risk. Cycle N+1: deploy against the REBUILT fleet's vault.
    const second = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault-b.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('999', '888', PEM_B),
        cloneRepo: async () => {
          throw new Error('must not be called — refused before the clone');
        },
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(second.status).toBe('failed');
    if (second.status !== 'failed') throw new Error('unreachable');
    expect(second.reason).toContain(publicKeyFingerprint(PEM_A));
    expect(second.reason).toContain(publicKeyFingerprint(PEM_B));
    // The cycle-N key is STILL on disk, untouched — never silently overwritten.
    expect(readFileSync(keyPath, 'utf-8')).toBe(PEM_A);
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
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
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
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
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
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
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
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
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
        mintCloneToken: async () => FAKE_TOKEN,
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(PEM);
    expect(serialized).not.toContain(Buffer.from(PEM, 'utf-8').toString('base64'));
    // The clone-auth token is equally secret-shaped — it must not leak into the outcome either.
    expect(serialized).not.toContain(FAKE_TOKEN);
  });

  it('an unparseable on-disk key file REFUSES cleanly (agent_key_unparseable), never a raw OpenSSL error, and never attempts a mint', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    const keyDir = scratchDir();
    const keyPath = join(keyDir, `${ROLE}.pem`);
    writeFileSync(keyPath, 'THIS IS NOT A PEM FILE AT ALL', { mode: 0o600 });

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
        mintCloneToken: mintCloneTokenMustNotBeCalled(),
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.reason).toContain('not a readable RSA private key');
    expect(outcome.reason).toContain(keyPath);
    expect(outcome.reason).not.toContain(PEM);
    // Never overwritten by the refusal path.
    expect(readFileSync(keyPath, 'utf-8')).toBe('THIS IS NOT A PEM FILE AT ALL');
  });

  it('mintCloneToken is called with the EXACT vault-derived appId/installId + the resolved keyPath (not just "was called")', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    const keyPath = join(scratchDir(), `${ROLE}.pem`);
    const mintCalls: { appId: string; installId: string; keyPath: string }[] = [];

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('333', '444', PEM),
        cloneRepo: async (_url, d) => mkdirSync(d, { recursive: true }),
        mintCloneToken: async (source) => {
          mintCalls.push(source);
          return FAKE_TOKEN;
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => keyPath,
      },
    );

    expect(outcome.status).toBe('deployed');
    expect(mintCalls).toEqual([{ appId: '333', installId: '444', keyPath }]);
    // The key was on disk (written by THIS run, before the mint) at the time mintCloneToken ran.
    expect(readFileSync(keyPath, 'utf-8')).toBe(PEM);
  });

  it('mintCloneToken failure -> status "failed", cloneRepo never called, reason is specific, no secret leaks (never a silent anonymous fallback)', async () => {
    const dir = scratchDir();
    let cloneCalled = false;

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      join(dir, 'workspace'),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async () => {
          cloneCalled = true;
        },
        mintCloneToken: async () => {
          throw new Error('gh token generate failed: simulated — clock drift or bad key');
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => join(scratchDir(), `${ROLE}.pem`),
      },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.reason).toContain('gh token generate failed');
    expect(outcome.reason).not.toContain(PEM);
    expect(cloneCalled).toBe(false);
  });

  it('re-running against an ALREADY-cloned workspace never mints a token (lazy — zero-network no-op on idempotent re-run)', async () => {
    const dir = scratchDir();
    const destDir = join(dir, 'workspace');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'already-here.txt'), 'x');
    let mintCalled = false;

    const outcome = await deployAgent(
      AGENT,
      manifestWith(),
      destDir,
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor('111', '222', PEM),
        cloneRepo: async () => {
          throw new Error('must not be called — workspace already populated');
        },
        mintCloneToken: async () => {
          mintCalled = true;
          return FAKE_TOKEN;
        },
        initAgent: fakeInitAgent([]),
        keyPathFor: () => join(scratchDir(), `${ROLE}.pem`),
      },
    );

    expect(outcome.status).toBe('deployed');
    expect(mintCalled).toBe(false);
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
          mintCloneToken: async () => FAKE_TOKEN,
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
          mintCloneToken: mintCloneTokenMustNotBeCalled(),
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

// --- authenticatedCloneUrl / parseAuthenticatedUrl — pure string logic (macf#968) ---

describe('authenticatedCloneUrl / parseAuthenticatedUrl', () => {
  it('authenticatedCloneUrl embeds the token as the x-access-token username', () => {
    expect(authenticatedCloneUrl('groundnuty/demo-code', 'TOK123')).toBe(
      'https://x-access-token:TOK123@github.com/groundnuty/demo-code.git',
    );
  });

  it('parseAuthenticatedUrl round-trips authenticatedCloneUrl exactly', () => {
    const url = authenticatedCloneUrl('owner/repo', 'SOME-TOKEN');
    expect(parseAuthenticatedUrl(url)).toEqual({ token: 'SOME-TOKEN', cleanUrl: 'https://github.com/owner/repo.git' });
  });

  it('parseAuthenticatedUrl works for a non-github host too (this file\'s own hermetic tests below rely on that)', () => {
    expect(parseAuthenticatedUrl('https://x-access-token:T@example.invalid/o/r.git')).toEqual({
      token: 'T',
      cleanUrl: 'https://example.invalid/o/r.git',
    });
  });

  it('parseAuthenticatedUrl returns undefined for a plain anonymous url — the "no credential" signal', () => {
    expect(parseAuthenticatedUrl('https://github.com/groundnuty/demo-code.git')).toBeUndefined();
  });

  it('parseAuthenticatedUrl returns undefined for an unrelated scheme/shape (ssh, empty, no @)', () => {
    expect(parseAuthenticatedUrl('git@github.com:groundnuty/demo-code.git')).toBeUndefined();
    expect(parseAuthenticatedUrl('')).toBeUndefined();
    expect(parseAuthenticatedUrl('https://x-access-tokenNOTHING')).toBeUndefined();
  });

  it('authenticatedCloneUrl REFUSES a token shape that would silently break the insteadOf rewrite (an embedded "=" truncates a -c key=value parse) — never in the error message', () => {
    expect(() => authenticatedCloneUrl('owner/repo', 'has=an=equals')).toThrow(FleetDeployError);
    try {
      authenticatedCloneUrl('owner/repo', 'has=an=equals');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as FleetDeployError).code).toBe('clone_token_unsafe_shape');
      expect((e as FleetDeployError).message).not.toContain('has=an=equals');
    }
  });

  it('authenticatedCloneUrl REFUSES an empty token (parseAuthenticatedUrl could never recognize it as authenticated -> silent anonymous fallback)', () => {
    expect(() => authenticatedCloneUrl('owner/repo', '')).toThrow(FleetDeployError);
  });

  it('authenticatedCloneUrl accepts the real installation-token alphabet (base64url, unpadded — this file\'s MEMORY.md-documented v3 shape)', () => {
    expect(() => authenticatedCloneUrl('owner/repo', 'ghs_abc123_XYZ.789-DEF~ghi')).not.toThrow();
  });
});

// --- cloneArgsFor — THE decisive, hermetic assertion surface (pure argv, no subprocess) ---

describe('cloneArgsFor (macf#968 — pins the argument ORDER, not just "a token appears somewhere")', () => {
  it('authenticated url: the -c flag carries the token, but the clone-target arg and destDir do NOT (assert the exact array, not a substring search)', () => {
    const url = authenticatedCloneUrl('groundnuty/demo-code', FAKE_TOKEN);
    const destDir = '/scratch/workspace';
    const args = cloneArgsFor(url, destDir);

    expect(args).toEqual([
      '-c',
      `url.${url}.insteadOf=https://github.com/groundnuty/demo-code.git`,
      'clone',
      '--depth',
      '1',
      'https://github.com/groundnuty/demo-code.git',
      destDir,
    ]);

    // The two argv positions that would land in .git/config or on-disk
    // paths — a swapped-argument regression (cleanUrl/connectUrl inverted)
    // would put the token in exactly one of these and this assertion would
    // catch it, unlike a substring search over the whole array.
    expect(args.at(-2)).not.toContain(FAKE_TOKEN);
    expect(args.at(-1)).not.toContain(FAKE_TOKEN);
    // The token appears in EXACTLY one element (the -c value) — not zero
    // (would mean the auth was dropped) and not more than one (would mean
    // it leaked somewhere unexpected).
    expect(args.filter((a) => a.includes(FAKE_TOKEN))).toHaveLength(1);
  });

  it('anonymous url: no -c flag at all, clone target is the url verbatim', () => {
    const url = 'https://github.com/groundnuty/demo-code.git';
    const args = cloneArgsFor(url, '/scratch/workspace');
    expect(args).toEqual(['clone', '--depth', '1', url, '/scratch/workspace']);
  });
});

// --- cloneViaInsteadOf — the REAL mechanism, hermetic (file:// fixtures only, no network) ---

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A real, local bare git repo with one empty commit — the fixture every test below clones from. */
function seedBareRepo(root: string): string {
  const seed = join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'test@example.invalid');
  git(seed, 'config', 'user.name', 'Test');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'seed');
  const bare = join(root, 'upstream.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, bare], { stdio: 'ignore' });
  return bare;
}

describe('cloneViaInsteadOf (real git, no network — the mechanism realAuthenticatedCloneRepo relies on)', () => {
  it('clones successfully via the CONNECT url while the recorded remote is the CLEAN url, verbatim (assert the remote, not just the clone call — macf#968)', async () => {
    const root = scratchDir();
    const bare = seedBareRepo(root);
    const dest = join(root, 'dest');
    // cleanUrl is a github-shaped address that is NOT reachable on its own —
    // proves the clone only succeeded because of the insteadOf redirect to
    // the local bare repo, not because cleanUrl happened to resolve.
    const cleanUrl = 'https://github.com/fake-owner-macf-968/fake-repo.git';
    const connectUrl = `file://${bare}`;

    await cloneViaInsteadOf(cleanUrl, connectUrl, dest);

    expect(git(dest, 'remote', 'get-url', 'origin')).toBe(cleanUrl);
    expect(git(dest, 'log', '-1', '--pretty=%s')).toBe('seed');
    // The connect (local) path never lands in the recorded config either.
    const rawConfig = readFileSync(join(dest, '.git', 'config'), 'utf-8');
    expect(rawConfig).not.toContain(bare);
  });

  it('when cloneUrl === connectUrl (no credential), clones directly with no -c flag at all', async () => {
    const root = scratchDir();
    const bare = seedBareRepo(root);
    const dest = join(root, 'dest');
    const url = `file://${bare}`;

    await cloneViaInsteadOf(url, url, dest);

    expect(git(dest, 'remote', 'get-url', 'origin')).toBe(url);
  });
});

// --- realAuthenticatedCloneRepo — the production seam end to end ---

describe('realAuthenticatedCloneRepo (macf#968)', () => {
  it('ANONYMOUS fallback still works: a plain (non-x-access-token) url clones for real, no auth machinery invoked', async () => {
    const root = scratchDir();
    const bare = seedBareRepo(root);
    const dest = join(root, 'dest');
    const url = `file://${bare}`;

    await realAuthenticatedCloneRepo(url, dest);

    expect(git(dest, 'remote', 'get-url', 'origin')).toBe(url);
    expect(git(dest, 'log', '-1', '--pretty=%s')).toBe('seed');
  });

  it('a clone failure with an authenticated url never contains the token in the thrown message (macf#968 point 3 — the exact leak the reported bug demonstrated) — hermetic, no network', async () => {
    // `git clone` refuses a non-empty destination BEFORE any network I/O
    // (verified: ~6ms, no connection attempted) — a real, deterministic,
    // instant failure that still exercises the actual production function
    // (parse -> cloneArgsFor -> execFile -> catch -> scrub), unlike a
    // network-dependent .invalid-host attempt which could hang or flake on
    // a host with a slow/black-holing resolver.
    const dest = join(scratchDir(), 'dest-already-occupied');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'marker.txt'), 'occupied');

    const url = authenticatedCloneUrl('owner/repo', 'SUPER-SECRET-TEST-TOKEN-968');

    let threw = false;
    try {
      await realAuthenticatedCloneRepo(url, dest);
    } catch (err) {
      threw = true;
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain('SUPER-SECRET-TEST-TOKEN-968');
      expect(message).toContain('<redacted>');
      expect(message).toContain('already exists'); // proves it's the real git error, not a swallowed no-op
    }
    expect(threw).toBe(true);
  });
});
