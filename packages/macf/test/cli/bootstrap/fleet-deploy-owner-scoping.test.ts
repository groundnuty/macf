/**
 * macf#1214 — the on-disk App-key path (`~/.macf/keys/...`) is OWNER-scoped,
 * one level above the macf#1157 fleet-scoping.
 *
 * macf#1157 fixed two fleets sharing a role name colliding on ONE on-disk
 * key by nesting the path under `<fleet>`: `~/.macf/keys/<fleet>/<role>.pem`.
 * But `<fleet>/<role>` alone is STILL not globally unique — one host
 * commonly provisions fleets from DIFFERENT GitHub owners (orgs/users), and
 * two owners can each run a fleet of the SAME name with the SAME role set
 * (e.g. two `macf-trial` fleets, one per owner, both with a `code-agent`).
 * The live incident macf#1214 reports is exactly this, one level up from
 * #1157's: `macf fleet deploy` for `macf-trial/code-agent` found a key on
 * disk belonging to a DIFFERENT fleet of the same name under a different
 * owner. The fix nests one level deeper: `~/.macf/keys/<owner>/<fleet>/<role>.pem`.
 *
 * **This file is dedicated to the owner-scoping decisive pair + the
 * boundary case the fix must get right**, kept SEPARATE from
 * `fleet-deploy-key-scoping.test.ts` (macf#1157, updated in the same PR to
 * account for the new owner segment on top) and the large
 * `fleet-deploy.test.ts` files, to keep each diff narrow.
 *
 * **Never touches the REAL `~/.macf/keys/`** — same `node:os` homedir mock
 * as `fleet-deploy-key-scoping.test.ts`; see that file's own doc for why
 * this is stronger than the `keyPathFor`-scratch-dir convention the rest of
 * this directory uses, and why it's necessary specifically for testing the
 * DEFAULT (no `keyPathFor` override) resolution path.
 *
 * Per `assert-the-wrong-path.md`'s trigger 1 (circularity): expected paths
 * below are LITERAL strings built with `join(...)` directly, never via
 * `defaultAgentKeyPath`/`legacyProjectAgentKeyPath`/`legacyAgentKeyPath`
 * themselves.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mocked BEFORE any other import in this file — see
// `fleet-deploy-key-scoping.test.ts`'s identical block for the full
// rationale (vi.hoisted required, homedir() resolved fresh per call, etc).
const FAKE_HOME = vi.hoisted(() => {
  const base = (process.env['TMPDIR'] ?? process.env['TEMP'] ?? '/tmp').replace(/\/+$/, '');
  return `${base}/macf-1214-fake-home-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { deployAgent, publicKeyFingerprint } from '../../../src/cli/bootstrap/fleet-deploy.js';
import type { FleetAgent, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { deriveAppHandle } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { InitOptions } from '../../../src/cli/commands/init.js';

mkdirSync(FAKE_HOME, { recursive: true });
afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratchDir(prefix = 'macf-1214-scratch-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** One real RSA keypair's PKCS1 PEM — see `fleet-deploy-key-scoping.test.ts`'s identical helper doc. */
function genRsaPemPkcs1(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

/** Two real RSA keys, generated once and reused — same frugality rationale as `fleet-deploy-key-scoping.test.ts`. */
const PEM_1 = genRsaPemPkcs1();
const PEM_2 = genRsaPemPkcs1();

const ROLE = 'code-agent';
const AGENT: FleetAgent = { role: ROLE, profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/unused-in-tests' };

/** Distinguishes fixtures below ONLY by `owner.account` + `fleetName` — the exact two axes macf#1214 is about. */
function manifestFor(owner: string, fleetName: string): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: fleetName },
    versions: { macf: '0.2.56', actions: 'v3.4.1' },
    owner: { account: owner, type: 'user', registry: { type: 'profile', user: owner } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [AGENT],
  };
}

/** A vault raw-map for ONE role — see `fleet-deploy-key-scoping.test.ts`'s identical helper doc (CA fields deliberately omitted). */
function vaultRawFor(fleetName: string, role: string, appId: string, installId: string, pem: string): Readonly<Record<string, string>> {
  const seg = deriveAppHandle(fleetName, role).toUpperCase().replace(/-/g, '_');
  return {
    [`MACF_AGENT_${seg}_APP_ID`]: appId,
    [`MACF_AGENT_${seg}_INSTALL_ID`]: installId,
    [`MACF_AGENT_${seg}_CLIENT_ID`]: 'Iv1.abc',
    [`MACF_AGENT_${seg}_CLIENT_SECRET`]: 'SYNTH-CLIENT-SECRET',
    [`MACF_AGENT_${seg}_WEBHOOK_SECRET`]: 'SYNTH-WEBHOOK-SECRET',
    [`MACF_AGENT_${seg}_PRIVATE_KEY_B64`]: Buffer.from(pem, 'utf-8').toString('base64'),
  };
}

async function noopInitAgent(_dir: string, _opts: InitOptions): Promise<void> {}

describe('macf#1214 — deployAgent default key-path resolution is OWNER-scoped', () => {
  it('DECISIVE PAIR (1): two fleets with the SAME NAME under DIFFERENT owners resolve to distinct key paths — no collision', async () => {
    const sharedFleetName = `shared-fleet-${Date.now()}`;
    const ownerX = `owner-x-${Date.now()}`;
    const ownerY = `owner-y-${Date.now()}`;
    const pemX = PEM_1;
    const pemY = PEM_2;

    const outcomeX = await deployAgent(
      AGENT,
      manifestFor(ownerX, sharedFleetName),
      scratchDir(),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor(sharedFleetName, ROLE, '111', '222', pemX),
        cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
        mintCloneToken: async () => 'FAKE-TOKEN-X',
        initAgent: noopInitAgent,
        // Deliberately NO keyPathFor — this is exactly the default-resolution path under test.
      },
    );
    const outcomeY = await deployAgent(
      AGENT,
      manifestFor(ownerY, sharedFleetName),
      scratchDir(),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor(sharedFleetName, ROLE, '333', '444', pemY),
        cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
        mintCloneToken: async () => 'FAKE-TOKEN-Y',
        initAgent: noopInitAgent,
      },
    );

    expect(outcomeX.status).toBe('deployed');
    expect(outcomeY.status).toBe('deployed');
    if (outcomeX.status !== 'deployed' || outcomeY.status !== 'deployed') throw new Error('unreachable');

    const expectedPathX = join(FAKE_HOME, '.macf', 'keys', ownerX, sharedFleetName, `${ROLE}.pem`);
    const expectedPathY = join(FAKE_HOME, '.macf', 'keys', ownerY, sharedFleetName, `${ROLE}.pem`);
    expect(outcomeX.keyPath).toBe(expectedPathX);
    expect(outcomeY.keyPath).toBe(expectedPathY);
    expect(outcomeX.keyPath).not.toBe(outcomeY.keyPath);

    // Content isolation, not just path isolation.
    expect(readFileSync(outcomeX.keyPath, 'utf-8')).toBe(pemX);
    expect(readFileSync(outcomeY.keyPath, 'utf-8')).toBe(pemY);
    expect(readFileSync(outcomeX.keyPath, 'utf-8')).not.toBe(pemY);
  });

  it('DECISIVE PAIR (2): an existing pre-#1214 (project-scoped, owner-less) key with a MATCHING fingerprint still resolves — no regeneration', async () => {
    const owner = `owner-${Date.now()}`;
    const fleetName = `fleet-preexisting-${Date.now()}`;
    const pemExisting = PEM_1;

    // Pre-seed the macf#1157 shape (fleet-scoped, no owner segment) —
    // simulates `macf-trial`'s CURRENT on-disk layout on the live VM,
    // which this fix must keep resolving with zero operator action.
    const legacyProjectPath = join(FAKE_HOME, '.macf', 'keys', fleetName, `${ROLE}.pem`);
    mkdirSync(join(FAKE_HOME, '.macf', 'keys', fleetName), { recursive: true });
    writeFileSync(legacyProjectPath, pemExisting, { mode: 0o600 });

    const outcome = await deployAgent(
      AGENT,
      manifestFor(owner, fleetName),
      scratchDir(),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor(fleetName, ROLE, '555', '666', pemExisting),
        cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
        mintCloneToken: async () => 'FAKE-TOKEN-EXISTING',
        initAgent: noopInitAgent,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');

    // Resolved IN PLACE at the pre-#1214 path — never migrated/copied to
    // the new owner-scoped path. No regeneration: the SAME bytes on disk.
    expect(outcome.keyPath).toBe(legacyProjectPath);
    expect(outcome.keyWrite).toBe('skipped-existing');
    expect(readFileSync(legacyProjectPath, 'utf-8')).toBe(pemExisting);

    // The new owner-scoped conventional path was never even created.
    const conventionalPath = join(FAKE_HOME, '.macf', 'keys', owner, fleetName, `${ROLE}.pem`);
    expect(existsSync(conventionalPath)).toBe(false);
  });

  it('a single owner, nothing pre-existing, materializes fresh FROM THE VAULT at the owner-scoped path — unchanged for a single-owner host', async () => {
    const owner = `solo-owner-${Date.now()}`;
    const fleetName = `solo-fleet-${Date.now()}`;
    const pemVault = PEM_2;

    const outcome = await deployAgent(
      AGENT,
      manifestFor(owner, fleetName),
      scratchDir(),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor(fleetName, ROLE, '777', '888', pemVault),
        cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
        mintCloneToken: async () => 'FAKE-TOKEN-SOLO',
        initAgent: noopInitAgent,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');

    const expectedPath = join(FAKE_HOME, '.macf', 'keys', owner, fleetName, `${ROLE}.pem`);
    expect(outcome.keyPath).toBe(expectedPath);
    expect(outcome.keyWrite).toBe('written');
    // Materialized FROM THE VAULT — the vault's own credential, never a
    // freshly-minted/fabricated keypair (no silent key regeneration).
    expect(readFileSync(expectedPath, 'utf-8')).toBe(pemVault);
  });

  it('the reported macf#1214 collision: a DIFFERENT owner\'s stale key at the pre-#1214 shared path is ignored — materializes fresh at THIS owner\'s path instead (no false reuse, no false refusal)', async () => {
    const sameFleetName = `macf-trial-${Date.now()}`; // the exact fleet name from the reported incident
    const otherOwner = `other-owner-${Date.now()}`; // a DIFFERENT owner's fleet parked its key at the shared pre-#1214 path
    const thisOwner = `this-owner-${Date.now()}`;
    const pemOtherOwnersFleet = PEM_1;
    const pemThisFleet = PEM_2; // deliberately different — this owner's REAL vault key

    // Simulates the live incident: some OTHER owner's fleet of the SAME
    // name previously deployed under the pre-#1214 (owner-less) layout,
    // leaving its key at the path this fix now treats as a legacy tier.
    const legacyProjectPath = join(FAKE_HOME, '.macf', 'keys', sameFleetName, `${ROLE}.pem`);
    mkdirSync(join(FAKE_HOME, '.macf', 'keys', sameFleetName), { recursive: true });
    writeFileSync(legacyProjectPath, pemOtherOwnersFleet, { mode: 0o600 });

    const outcome = await deployAgent(
      AGENT,
      manifestFor(thisOwner, sameFleetName),
      scratchDir(),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor(sameFleetName, ROLE, '999', '000', pemThisFleet),
        cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
        mintCloneToken: async () => 'FAKE-TOKEN-THIS-OWNER',
        initAgent: noopInitAgent,
      },
    );

    // No refusal — the other owner's key is simply irrelevant to THIS
    // owner's fleet (fingerprint mismatch at a LEGACY tier is ignored, not
    // refused; refusal is reserved for a mismatch AT the current
    // conventional path — see `fleet-deploy-key-scoping.test.ts`).
    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');

    const conventionalPath = join(FAKE_HOME, '.macf', 'keys', thisOwner, sameFleetName, `${ROLE}.pem`);
    expect(outcome.keyPath).toBe(conventionalPath);
    expect(outcome.keyWrite).toBe('written');
    expect(readFileSync(conventionalPath, 'utf-8')).toBe(pemThisFleet);
    // The other owner's key is untouched — never overwritten, never deleted.
    expect(readFileSync(legacyProjectPath, 'utf-8')).toBe(pemOtherOwnersFleet);
  });

  it('a mismatching pre-#1157 FLAT key (bare role, no owner, no fleet segment) is anchored-checked and ignored, not globbed-in — the attribution-trap-with-a-key shape', async () => {
    // The concern this test pins: the fallback chain must be ANCHORED (one
    // exact predicted path per tier), never a directory scan — otherwise a
    // lookup for one owner's fleet could silently authenticate as a
    // DIFFERENT identity's key (e.g. a substrate agent's own flat-shaped
    // key) sitting at the shared bare-role path. A unique role name (like
    // the #1157 file's own `sharedRole`/`legacyRole` convention) — NOT the
    // module-level `ROLE` — because the flat tier has no owner OR fleet
    // segment to isolate it from other tests in this same file/run.
    const owner = `flat-owner-${Date.now()}`;
    const fleetName = `flat-fleet-${Date.now()}`;
    const flatRole = `flat-role-${Date.now()}`;
    const flatAgent: FleetAgent = { role: flatRole, profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/unused-in-tests' };
    const someOtherIdentitysPem = PEM_1; // e.g. a substrate agent's OWN key, unrelated to this fleet
    const pemThisFleet = PEM_2;

    const flatPath = join(FAKE_HOME, '.macf', 'keys', `${flatRole}.pem`);
    mkdirSync(join(FAKE_HOME, '.macf', 'keys'), { recursive: true });
    writeFileSync(flatPath, someOtherIdentitysPem, { mode: 0o600 });

    const outcome = await deployAgent(
      flatAgent,
      manifestFor(owner, fleetName),
      scratchDir(),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor(fleetName, flatRole, '123', '456', pemThisFleet),
        cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
        mintCloneToken: async () => 'FAKE-TOKEN-FLAT',
        initAgent: noopInitAgent,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');

    const conventionalPath = join(FAKE_HOME, '.macf', 'keys', owner, fleetName, `${flatRole}.pem`);
    // The mismatching flat key was NEVER trusted or reused as this fleet's
    // identity — this fleet's OWN vault-sourced key materializes fresh.
    expect(outcome.keyPath).toBe(conventionalPath);
    expect(readFileSync(conventionalPath, 'utf-8')).toBe(pemThisFleet);
    expect(readFileSync(conventionalPath, 'utf-8')).not.toBe(someOtherIdentitysPem);
    // The unrelated identity's key is left completely untouched.
    expect(readFileSync(flatPath, 'utf-8')).toBe(someOtherIdentitysPem);
  });

  it('no key at ANY tier (new, pre-#1214, pre-#1157) → materializes fresh FROM THE VAULT — never a loud refusal for mere absence, never a fabricated replacement', async () => {
    const owner = `absent-owner-${Date.now()}`;
    const fleetName = `absent-fleet-${Date.now()}`;
    // Unique role — the flat (bare-role) tier has no owner/fleet segment,
    // so a role shared with another test in this file/run could pick up a
    // leftover file (a real cross-test hazard: reusing the module-level
    // `ROLE` here previously flaked to 'skipped-existing' because the
    // attribution-trap test above had already written a flat file for that
    // same role name).
    const absentRole = `absent-role-${Date.now()}`;
    const absentAgent: FleetAgent = { role: absentRole, profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/unused-in-tests' };
    const pemVault = PEM_1;

    const outcome = await deployAgent(
      absentAgent,
      manifestFor(owner, fleetName),
      scratchDir(),
      { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' },
      {
        readVault: async () => vaultRawFor(fleetName, absentRole, '246', '135', pemVault),
        cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
        mintCloneToken: async () => 'FAKE-TOKEN-ABSENT',
        initAgent: noopInitAgent,
      },
    );

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');
    expect(outcome.keyWrite).toBe('written');
    // The bytes written are the VAULT's own PEM — a cache of the existing
    // identity, never a freshly-generated (different) keypair.
    expect(readFileSync(outcome.keyPath, 'utf-8')).toBe(pemVault);
    expect(publicKeyFingerprint(readFileSync(outcome.keyPath, 'utf-8'))).toBe(publicKeyFingerprint(pemVault));
  });
});
