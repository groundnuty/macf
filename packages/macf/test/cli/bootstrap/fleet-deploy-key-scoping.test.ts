/**
 * macf#1157 — the on-disk App-key path (`~/.macf/keys/...`) is FLEET-scoped.
 *
 * Before this fix, `deployAgent`'s DEFAULT key-path resolution
 * (`defaultAgentKeyPath(role)`) used the bare role only. Two fleets sharing
 * a role name (e.g. `code-agent`) on the same host collided on ONE on-disk
 * key: the second fleet's deploy either overwrote the first fleet's key, or
 * (with the macf#975 fingerprint guard in place) refused loud, since the
 * on-disk key's identity never matches the second fleet's vault entry —
 * exactly the live incident macf#1157 reports.
 *
 * **This file is dedicated to the two scenarios the fix must get right**,
 * kept SEPARATE from the large `fleet-deploy.test.ts` files (both the
 * top-level one and this directory's) to keep this diff narrow and avoid
 * touching either — this fix and macf#1156 both touch `src/cli/bootstrap/**`
 * concurrently.
 *
 * **Never touches the REAL `~/.macf/keys/` — stronger than this directory's
 * usual `keyPathFor`-scratch-dir convention.** These two tests are
 * SPECIFICALLY about the DEFAULT (no `keyPathFor` override) resolution
 * path — the one thing `keyPathFor`-overridden tests structurally cannot
 * exercise. Instead of writing under a randomized-but-real fleet name below
 * the real `~/.macf/keys/` (this codebase's OWN established fallback
 * convention for the "no path-override seam" case — see
 * `fleet-deploy.test.ts`'s "REAL `initAgent`" block), this file mocks
 * `node:os`'s `homedir` to a `mkdtempSync` scratch directory for its entire
 * run. That is STRICTLY safer here: a live operator e2e session may have
 * real fleet keys under the real `~/.macf/keys/` at the moment this suite
 * runs, and `defaultAgentKeyPath`/`legacyAgentKeyPath` (and therefore
 * `resolveDefaultKeyPath`) call `homedir()` FRESH on every invocation
 * (never a module-scope cached const — unlike `config.ts`'s
 * `MACF_GLOBAL_DIR`, which is why `vi.stubEnv('HOME', …)` doesn't work for
 * that one), so mocking `node:os` intercepts every real call transparently
 * while still exercising the REAL, unmocked production functions.
 *
 * Per `assert-the-wrong-path.md`'s trigger 1 (circularity): expected paths
 * below are LITERAL strings built with `join(...)` directly, never via
 * `defaultAgentKeyPath`/`legacyAgentKeyPath` themselves — building the
 * expectation with the same helper that produces the value under test
 * would make the assertion unable to fail.
 *
 * **macf#1214 update: an `<owner>` segment now sits ABOVE the fleet segment**
 * (`~/.macf/keys/<owner>/<fleet>/<role>.pem`) — a fleet's `<fleet>/<role>`
 * identity alone is not globally unique, since one host commonly serves
 * fleets from different GitHub owners. `manifestFor` below fixes
 * `owner.account` at `'groundnuty'`, so every literal expected path here
 * gained that one extra segment; the FLEET-scoping behavior these four
 * tests exist to pin is otherwise unchanged (still exercised one level
 * further down the tree). The one test whose SEMANTICS — not just its
 * literal path — changed is "a fingerprint mismatch AT the conventional
 * path still refuses loud": the location it used to call "conventional"
 * (`~/.macf/keys/<fleet>/<role>.pem`, no owner) is now merely the pre-#1214
 * LEGACY tier, so a stale/mismatching file sitting there is no longer this
 * fleet's problem to refuse over — it's ignored exactly like any other
 * non-matching legacy candidate, and the fleet materializes fresh at its
 * OWN owner-scoped path instead. The refusal-on-mismatch guarantee still
 * holds, just at the location that is now actually conventional; the test
 * was re-targeted accordingly rather than dropped. See
 * `fleet-deploy-owner-scoping.test.ts` (macf#1214) for the sibling file
 * dedicated to the owner-scoping decisive pair itself.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mocked BEFORE any other import in this file (vi.mock is hoisted above
// imports by vitest's transform) — every module this file transitively
// pulls in (fleet-deploy.ts, init.ts, config.ts) resolves `homedir()`
// through this same fake for the lifetime of the whole file. `tmpdir` and
// everything else from `node:os` pass through untouched.
//
// `vi.hoisted` (same pattern `fleet-deploy.test.ts` already uses for its
// own `certCallState`) is required, not optional: `vi.mock`'s factory is
// hoisted ABOVE ordinary top-level `const`s too, so a plain
// `const FAKE_HOME = …` above the `vi.mock` call would still be
// TDZ-uninitialized the moment `config.ts`'s module-scope
// `MACF_GLOBAL_DIR = join(homedir(), '.macf')` evaluates during import.
// Built from `process.env`/JS-global primitives only (no `node:fs`/`node:os`
// import reachable from inside the hoisted callback) — the directory is
// created for real a few lines below, once this file's own `node:fs`
// import has actually run.
const FAKE_HOME = vi.hoisted(() => {
  const base = (process.env['TMPDIR'] ?? process.env['TEMP'] ?? '/tmp').replace(/\/+$/, '');
  return `${base}/macf-1157-fake-home-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
function scratchDir(prefix = 'macf-1157-scratch-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** One real RSA keypair's PKCS1 PEM — real key material so `detectKeyStatus`'s fingerprint parse actually exercises real parsing rather than throwing on an opaque sentinel string (this codebase's own "test that constructs the seam it should observe" lesson, applied to fixture data). */
function genRsaPemPkcs1(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

/**
 * Exactly TWO real RSA keys, generated ONCE and reused across every test
 * below (same frugality convention `fleet-deploy.test.ts` already
 * establishes with its own module-scope `PEM`/`OTHER_PEM`) — a fresh
 * RSA-2048 keygen per test scenario (this file originally generated 7)
 * measurably adds to CPU contention when the whole package's test suite
 * runs in parallel, which was observed to intermittently perturb an
 * unrelated real-wall-clock-budget test elsewhere in the suite
 * (`macf-startup-pickup.test.ts`, a ~1s polling window). Distinctness is
 * only ever needed WITHIN one test (fleet A's key differs from fleet B's),
 * never across tests, so two keys are sufficient for the whole file.
 */
const PEM_1 = genRsaPemPkcs1();
const PEM_2 = genRsaPemPkcs1();

const ROLE = 'code-agent';
const AGENT: FleetAgent = { role: ROLE, profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/unused-in-tests' };
// The owner account every `manifestFor` fixture below fixes (macf#1214) —
// pulled out as a named constant so the literal expected paths read as
// "owner segment, then fleet segment" rather than a bare repeated string.
const OWNER = 'groundnuty';

function manifestFor(fleetName: string): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: fleetName },
    versions: { macf: '0.2.56', actions: 'v3.4.1' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [AGENT],
  };
}

/** A vault raw-map for ONE role — deliberately carries NO CA fields, so `detectCaStatus` short-circuits `'vault-absent'` and never touches `caCertPathFor`/`caKeyPathFor` (real, homedir-rooted defaults, unoverridden here — safe only because this vault fixture never gives the CA step a reason to read them). */
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

/** A `deps.initAgent` fake that does nothing — CA is vault-absent in every fixture here, so `deployAgent`'s own cert-issuance bookkeeping (`certIssue`) resolves to `'not-attempted'` regardless of what a fake `initAgent` does or doesn't write. */
async function noopInitAgent(_dir: string, _opts: InitOptions): Promise<void> {}

describe('macf#1157 — deployAgent default key-path resolution is fleet-scoped', () => {
  it('two fleets declaring the SAME role each resolve to their OWN key path — neither reads the other\'s', async () => {
    const fleetA = `fleet-a-${Date.now()}`;
    const fleetB = `fleet-b-${Date.now()}`;
    const pemA = PEM_1;
    const pemB = PEM_2;

    const outcomeA = await deployAgent(AGENT, manifestFor(fleetA), scratchDir(), { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' }, {
      readVault: async () => vaultRawFor(fleetA, ROLE, '111', '222', pemA),
      cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
      mintCloneToken: async () => 'FAKE-TOKEN-A',
      initAgent: noopInitAgent,
      // Deliberately NO keyPathFor — this is exactly the default-resolution path under test.
    });
    const outcomeB = await deployAgent(AGENT, manifestFor(fleetB), scratchDir(), { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' }, {
      readVault: async () => vaultRawFor(fleetB, ROLE, '333', '444', pemB),
      cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
      mintCloneToken: async () => 'FAKE-TOKEN-B',
      initAgent: noopInitAgent,
    });

    expect(outcomeA.status).toBe('deployed');
    expect(outcomeB.status).toBe('deployed');
    if (outcomeA.status !== 'deployed' || outcomeB.status !== 'deployed') throw new Error('unreachable');

    // Literal expected paths (assert-the-wrong-path.md trigger 1: never
    // built via defaultAgentKeyPath itself, or this assertion could not
    // fail against the pre-fix bare-role implementation).
    const expectedPathA = join(FAKE_HOME, '.macf', 'keys', OWNER, fleetA, `${ROLE}.pem`);
    const expectedPathB = join(FAKE_HOME, '.macf', 'keys', OWNER, fleetB, `${ROLE}.pem`);
    expect(outcomeA.keyPath).toBe(expectedPathA);
    expect(outcomeB.keyPath).toBe(expectedPathB);
    expect(outcomeA.keyPath).not.toBe(outcomeB.keyPath);

    // "Neither reads the other's" — content isolation, not just path
    // isolation: fleet A's on-disk key is fleet A's PEM, never fleet B's.
    expect(readFileSync(outcomeA.keyPath, 'utf-8')).toBe(pemA);
    expect(readFileSync(outcomeB.keyPath, 'utf-8')).toBe(pemB);
    expect(readFileSync(outcomeA.keyPath, 'utf-8')).not.toBe(pemB);
    expect(readFileSync(outcomeB.keyPath, 'utf-8')).not.toBe(pemA);
  });

  it('an existing OLD-LAYOUT (pre-#1157, unscoped) key still resolves — read-old-write-new back-compat', async () => {
    const fleetC = `fleet-c-${Date.now()}`;
    const legacyRole = `legacy-role-${Date.now()}`; // unique per-run role, never collides across test runs
    const pemLegacy = PEM_1;
    const legacyAgent: FleetAgent = { role: legacyRole, profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/unused-in-tests' };

    // Pre-seed the LEGACY flat path (no fleet segment) — simulates an
    // operator's pre-#1157 single-fleet key already on disk.
    const legacyPath = join(FAKE_HOME, '.macf', 'keys', `${legacyRole}.pem`);
    mkdirSync(join(FAKE_HOME, '.macf', 'keys'), { recursive: true });
    writeFileSync(legacyPath, pemLegacy, { mode: 0o600 });

    const outcome = await deployAgent(legacyAgent, manifestFor(fleetC), scratchDir(), { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' }, {
      readVault: async () => vaultRawFor(fleetC, legacyRole, '555', '666', pemLegacy),
      cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
      mintCloneToken: async () => 'FAKE-TOKEN-C',
      initAgent: noopInitAgent,
    });

    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');

    // Literal legacy path — resolved IN PLACE, never migrated/copied to the
    // fleet-scoped path.
    expect(outcome.keyPath).toBe(legacyPath);
    expect(outcome.keyWrite).toBe('skipped-existing');
    expect(readFileSync(legacyPath, 'utf-8')).toBe(pemLegacy);

    // The owner+fleet-scoped conventional path was never even created —
    // "read old" does not imply "also write new."
    const conventionalPath = join(FAKE_HOME, '.macf', 'keys', OWNER, fleetC, `${legacyRole}.pem`);
    expect(existsSync(conventionalPath)).toBe(false);
  });

  it('a legacy key that does NOT match this fleet\'s vault is ignored — materializes fresh at the fleet-scoped path instead (no false-positive reuse, no refusal)', async () => {
    const fleetD = `fleet-d-${Date.now()}`;
    const sharedRole = `shared-role-${Date.now()}`; // simulates a role name reused across fleets
    const pemOtherFleet = PEM_1; // "some OTHER fleet's" key, sitting at the flat legacy path
    const pemThisFleet = PEM_2; // fleet D's REAL vault key — deliberately different

    const legacyPath = join(FAKE_HOME, '.macf', 'keys', `${sharedRole}.pem`);
    mkdirSync(join(FAKE_HOME, '.macf', 'keys'), { recursive: true });
    writeFileSync(legacyPath, pemOtherFleet, { mode: 0o600 });

    const sharedAgent: FleetAgent = { role: sharedRole, profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/unused-in-tests' };
    const outcome = await deployAgent(sharedAgent, manifestFor(fleetD), scratchDir(), { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' }, {
      readVault: async () => vaultRawFor(fleetD, sharedRole, '777', '888', pemThisFleet),
      cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
      mintCloneToken: async () => 'FAKE-TOKEN-D',
      initAgent: noopInitAgent,
    });

    // No refusal — the mismatching legacy file belongs to nobody THIS
    // fleet knows about, so it's simply irrelevant, not a mismatch to
    // refuse over (the mismatch refusal is reserved for the FLEET-SCOPED
    // path's own on-disk-vs-vault comparison).
    expect(outcome.status).toBe('deployed');
    if (outcome.status !== 'deployed') throw new Error('unreachable');

    const conventionalPath = join(FAKE_HOME, '.macf', 'keys', OWNER, fleetD, `${sharedRole}.pem`);
    expect(outcome.keyPath).toBe(conventionalPath);
    expect(outcome.keyWrite).toBe('written');
    expect(readFileSync(conventionalPath, 'utf-8')).toBe(pemThisFleet);
    // The legacy file is untouched — never overwritten, never deleted.
    expect(readFileSync(legacyPath, 'utf-8')).toBe(pemOtherFleet);
  });

  it('a fingerprint mismatch AT the owner+fleet-scoped conventional path still refuses loud — fingerprints named, no key material leaked, unchanged strength', async () => {
    const fleetE = `fleet-e-${Date.now()}`;
    const pemStale = PEM_1; // e.g. left over from a destroyed-and-rebuilt fleet of the SAME name
    const pemVault = PEM_2; // the CURRENT vault's real key — deliberately different

    // macf#1214: seeded at the TRUE conventional path (owner+fleet+role).
    // Seeding at the pre-#1214 fleet-only path here would exercise the
    // legacy-tier "ignored, not refused" branch instead (see
    // `fleet-deploy-owner-scoping.test.ts` for that scenario) — this test
    // is specifically about a mismatch AT the CURRENT conventional path.
    const conventionalPath = join(FAKE_HOME, '.macf', 'keys', OWNER, fleetE, `${ROLE}.pem`);
    mkdirSync(join(FAKE_HOME, '.macf', 'keys', OWNER, fleetE), { recursive: true });
    writeFileSync(conventionalPath, pemStale, { mode: 0o600 });

    const outcome = await deployAgent(AGENT, manifestFor(fleetE), scratchDir(), { vaultPath: '/fake/vault.age', identityPath: '/fake/key.txt' }, {
      readVault: async () => vaultRawFor(fleetE, ROLE, '999', '888', pemVault),
      cloneRepo: async (_url, dest) => mkdirSync(dest, { recursive: true }),
      mintCloneToken: async () => {
        throw new Error('must not be called — a fingerprint mismatch refuses BEFORE any clone-auth mint is attempted');
      },
      initAgent: noopInitAgent,
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    // Both fingerprints named (the operator-actionable diagnostic)...
    expect(outcome.reason).toContain(publicKeyFingerprint(pemStale));
    expect(outcome.reason).toContain(publicKeyFingerprint(pemVault));
    // ...but never the raw key material itself, on either side.
    expect(outcome.reason).not.toContain(pemStale);
    expect(outcome.reason).not.toContain(pemVault);
    // The on-disk file is untouched — a refusal never overwrites (that's
    // what --force-key is for, not exercised here).
    expect(readFileSync(conventionalPath, 'utf-8')).toBe(pemStale);
  });
});
