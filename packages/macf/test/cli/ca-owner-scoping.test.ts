/**
 * macf#1277 — the on-disk per-project CA path (`~/.macf/certs/...`) is now
 * OWNER-scoped, one level above the pre-#1277 project-scoped shape — the
 * CA analog of macf#1214's App-key owner-scoping
 * (`fleet-deploy-owner-scoping.test.ts`, whose structure this file mirrors).
 *
 * Three layers, each with its own decisive coverage:
 *
 *  1. `config.ts::resolveExistingCaPaths` — the existence-only "read-old"
 *     resolver every operator-facing consumer (`certs.ts`, `init.ts`,
 *     `routing-doctor.ts`) shares.
 *  2. `bootstrap/fleet-deploy.ts::materializeProjectCa` — the
 *     fingerprint-gated owner+legacy resolution `deployAgent` uses when
 *     `caCertPathFor`/`caKeyPathFor` are left at their real default
 *     (`allowLegacyFallback: true`), mirroring `resolveDefaultKeyPath`'s
 *     discipline for the App key one layer up.
 *  3. `env-files.ts::generateEnvCerts` / `claude-sh.ts::caPathLines` — the
 *     GENERATED LAUNCHER's own runtime shell fallback. This is the
 *     "outer" half per `assert-the-wrong-path.md` / the macf#1129 mutation
 *     habit: a path-helper unit test proves the Node-side logic is right;
 *     these tests ACTUALLY EXECUTE the generated shell fragment (via
 *     `sh -c`) against real files on a fake `$HOME`, so a break in the
 *     generated STRING (not just the helper) fails here.
 *
 * **Never touches the REAL `~/.macf/certs/`** — same `node:os` homedir
 * mock as `fleet-deploy-owner-scoping.test.ts`; see that file's own doc
 * for why this is necessary specifically for testing the DEFAULT
 * (un-overridden) resolution path. The shell-execution tests use their
 * OWN separate scratch `$HOME` per test (passed directly as the spawned
 * process's env), independent of the Node-side mock.
 *
 * Per `assert-the-wrong-path.md`'s trigger 1 (circularity): expected
 * paths below are LITERAL strings built with `join(...)`/template
 * literals directly, never via `caCertPath`/`resolveExistingCaPaths`
 * themselves.
 */
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mocked BEFORE any other import in this file — see
// `fleet-deploy-owner-scoping.test.ts`'s identical block for the full
// rationale (vi.hoisted required, homedir() resolved fresh per call, etc).
const FAKE_HOME = vi.hoisted(() => {
  const base = (process.env['TMPDIR'] ?? process.env['TEMP'] ?? '/tmp').replace(/\/+$/, '');
  return `${base}/macf-1277-fake-home-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME };
});

import { createCA, caCertFingerprint, toVariableSegment } from '@groundnuty/macf-core';
import { caCertPath, caKeyPath, resolveExistingCaPaths } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';
import { materializeProjectCa } from '../../src/cli/bootstrap/fleet-deploy.js';
import { generateEnvCerts } from '../../src/cli/env-files.js';
import { caPathLines } from '../../src/cli/claude-sh.js';

mkdirSync(FAKE_HOME, { recursive: true });
afterAll(() => rmSync(FAKE_HOME, { recursive: true, force: true }));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratchDir(prefix = 'macf-1277-scratch-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Mints a REAL, valid CA keypair — never a synthetic PEM sentinel, matching `bootstrap/fleet-deploy.test.ts`'s own `mintTestCa` convention. */
async function mintTestCa(label: string): Promise<{ readonly certPem: string; readonly keyPem: string }> {
  const dir = scratchDir();
  return createCA({ project: `ca-mint-${label}`, certPath: join(dir, 'ca-cert.pem'), keyPath: join(dir, 'ca-key.pem') });
}

/** Fleet-level (not per-agent) CA vault fields, matching `vault-write.ts::buildVaultPlaintext`'s key shape. */
function vaultRawWithCa(fleetName: string, ca: { readonly certPem: string; readonly keyPem: string }): Record<string, string> {
  const seg = toVariableSegment(fleetName);
  return {
    [`MACF_${seg}_CA_KEY_B64`]: Buffer.from(ca.keyPem, 'utf-8').toString('base64'),
    [`MACF_${seg}_CA_CERT_B64`]: Buffer.from(ca.certPem, 'utf-8').toString('base64'),
  };
}

// ---------------------------------------------------------------------------
// Layer 1 — config.ts::resolveExistingCaPaths (existence-only)
// ---------------------------------------------------------------------------

describe('macf#1277 — config.ts::resolveExistingCaPaths', () => {
  it('DECISIVE PAIR: two fleets with the SAME NAME under DIFFERENT owners resolve to distinct CA paths — no collision', () => {
    const fleet = `shared-${Date.now()}`;
    const a = resolveExistingCaPaths('owner-a', fleet);
    const b = resolveExistingCaPaths('owner-b', fleet);
    expect(a.certPath).toBe(join(FAKE_HOME, '.macf', 'certs', 'owner-a', fleet, 'ca-cert.pem'));
    expect(b.certPath).toBe(join(FAKE_HOME, '.macf', 'certs', 'owner-b', fleet, 'ca-cert.pem'));
    expect(a.certPath).not.toBe(b.certPath);
    expect(a.keyPath).not.toBe(b.keyPath);
  });

  it('an EXISTING (pre-#1277) fleet whose CA lives ONLY at the legacy project-scoped path still resolves — no regeneration', () => {
    const fleet = `legacy-${Date.now()}`;
    const legacyDir = join(FAKE_HOME, '.macf', 'certs', fleet);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'ca-cert.pem'), 'LEGACY-CERT-SENTINEL');
    writeFileSync(join(legacyDir, 'ca-key.pem'), 'LEGACY-KEY-SENTINEL');
    try {
      const resolved = resolveExistingCaPaths('some-owner', fleet);
      expect(resolved.certPath).toBe(join(legacyDir, 'ca-cert.pem'));
      expect(resolved.keyPath).toBe(join(legacyDir, 'ca-key.pem'));
      // Never a directory scan — the conventional owner-scoped tier is
      // still just a location, untouched by this read.
      expect(existsSync(join(FAKE_HOME, '.macf', 'certs', 'some-owner'))).toBe(false);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('the owner-scoped conventional path wins when BOTH tiers have a file', () => {
    const fleet = `both-${Date.now()}`;
    const owner = `owner-${Date.now()}`;
    const legacyDir = join(FAKE_HOME, '.macf', 'certs', fleet);
    const conventionalDir = join(FAKE_HOME, '.macf', 'certs', owner, fleet);
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(conventionalDir, { recursive: true });
    writeFileSync(join(legacyDir, 'ca-cert.pem'), 'LEGACY');
    writeFileSync(join(conventionalDir, 'ca-cert.pem'), 'CONVENTIONAL');
    try {
      const resolved = resolveExistingCaPaths(owner, fleet);
      expect(resolved.certPath).toBe(join(conventionalDir, 'ca-cert.pem'));
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
      rmSync(conventionalDir, { recursive: true, force: true });
    }
  });

  it('absent at BOTH tiers resolves to the (nonexistent) conventional path — a location, never a fabricated file', () => {
    const fleet = `absent-${Date.now()}`;
    const resolved = resolveExistingCaPaths('owner-z', fleet);
    expect(resolved.certPath).toBe(join(FAKE_HOME, '.macf', 'certs', 'owner-z', fleet, 'ca-cert.pem'));
    expect(existsSync(resolved.certPath)).toBe(false);
  });

  it('a single-owner fleet (no cross-owner collision in play) resolves exactly as before, just with the owner segment', () => {
    expect(caCertPath('solo-owner', 'solo-fleet')).toBe(
      join(FAKE_HOME, '.macf', 'certs', 'solo-owner', 'solo-fleet', 'ca-cert.pem'),
    );
    expect(caKeyPath('solo-owner', 'solo-fleet')).toBe(
      join(FAKE_HOME, '.macf', 'certs', 'solo-owner', 'solo-fleet', 'ca-key.pem'),
    );
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — bootstrap/fleet-deploy.ts::materializeProjectCa
// ---------------------------------------------------------------------------

describe('macf#1277 — fleet-deploy.ts materializeProjectCa: owner-scoped default + fingerprint-gated legacy fallback', () => {
  it('DECISIVE PAIR: two fleets, SAME NAME, DIFFERENT owners -> distinct on-disk CA files, no fingerprint conflict', async () => {
    const fleet = `shared-fleet-${Date.now()}`;
    const ownerX = `owner-x-${Date.now()}`;
    const ownerY = `owner-y-${Date.now()}`;
    const caX = await mintTestCa('ownerx');
    const caY = await mintTestCa('ownery');
    try {
      const outcomeX = await materializeProjectCa(
        vaultRawWithCa(fleet, caX), ownerX, fleet,
        { caCertPathFor: caCertPath, caKeyPathFor: caKeyPath },
        false, true,
      );
      const outcomeY = await materializeProjectCa(
        vaultRawWithCa(fleet, caY), ownerY, fleet,
        { caCertPathFor: caCertPath, caKeyPathFor: caKeyPath },
        false, true,
      );

      expect(outcomeX).toEqual({ status: 'materialized', certFingerprint: caCertFingerprint(caX.certPem) });
      expect(outcomeY).toEqual({ status: 'materialized', certFingerprint: caCertFingerprint(caY.certPem) });

      const pathX = join(FAKE_HOME, '.macf', 'certs', ownerX, fleet, 'ca-cert.pem');
      const pathY = join(FAKE_HOME, '.macf', 'certs', ownerY, fleet, 'ca-cert.pem');
      expect(pathX).not.toBe(pathY);
      expect(readFileSync(pathX, 'utf-8')).toBe(caX.certPem);
      expect(readFileSync(pathY, 'utf-8')).toBe(caY.certPem);
    } finally {
      rmSync(join(FAKE_HOME, '.macf', 'certs', ownerX), { recursive: true, force: true });
      rmSync(join(FAKE_HOME, '.macf', 'certs', ownerY), { recursive: true, force: true });
    }
  });

  it('an existing fleet whose CA lives at the legacy path (fingerprint MATCHES the vault) is REUSED — zero writes, no regeneration', async () => {
    const fleet = `legacy-match-${Date.now()}`;
    const owner = `owner-${Date.now()}`;
    const ca = await mintTestCa('legacymatch');
    const legacyDir = join(FAKE_HOME, '.macf', 'certs', fleet);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'ca-cert.pem'), ca.certPem, { mode: 0o644 });
    writeFileSync(join(legacyDir, 'ca-key.pem'), ca.keyPem, { mode: 0o600 });
    const mtimeBefore = statSync(join(legacyDir, 'ca-cert.pem')).mtimeMs;
    try {
      const outcome = await materializeProjectCa(
        vaultRawWithCa(fleet, ca), owner, fleet,
        { caCertPathFor: caCertPath, caKeyPathFor: caKeyPath },
        false, true,
      );

      expect(outcome).toEqual({ status: 'already-current', certFingerprint: caCertFingerprint(ca.certPem) });
      // Zero-effect assertion (per assert-the-wrong-path.md): the
      // conventional tier was NEVER created...
      expect(existsSync(join(FAKE_HOME, '.macf', 'certs', owner))).toBe(false);
      // ...and the legacy file's mtime is byte-for-byte untouched (no churn).
      expect(statSync(join(legacyDir, 'ca-cert.pem')).mtimeMs).toBe(mtimeBefore);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('a legacy CA that does NOT match the vault (a different fleet/owner\'s stale file) is IGNORED — fresh materializes at the conventional path, legacy left untouched', async () => {
    const fleet = `legacy-mismatch-${Date.now()}`;
    const owner = `owner-${Date.now()}`;
    const staleCa = await mintTestCa('stale');
    const freshCa = await mintTestCa('fresh-after-mismatch');
    const legacyDir = join(FAKE_HOME, '.macf', 'certs', fleet);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'ca-cert.pem'), staleCa.certPem);
    writeFileSync(join(legacyDir, 'ca-key.pem'), staleCa.keyPem);
    try {
      const outcome = await materializeProjectCa(
        vaultRawWithCa(fleet, freshCa), owner, fleet,
        { caCertPathFor: caCertPath, caKeyPathFor: caKeyPath },
        false, true,
      );

      expect(outcome).toEqual({ status: 'materialized', certFingerprint: caCertFingerprint(freshCa.certPem) });
      const conventionalCert = join(FAKE_HOME, '.macf', 'certs', owner, fleet, 'ca-cert.pem');
      expect(readFileSync(conventionalCert, 'utf-8')).toBe(freshCa.certPem);
      // The stale legacy file was never adopted, never rewritten.
      expect(readFileSync(join(legacyDir, 'ca-cert.pem'), 'utf-8')).toBe(staleCa.certPem);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
      rmSync(join(FAKE_HOME, '.macf', 'certs', owner), { recursive: true, force: true });
    }
  });

  it('absent at BOTH tiers: mints fresh at the conventional path, the legacy tier is NEVER created', async () => {
    const fleet = `absent-both-${Date.now()}`;
    const owner = `owner-${Date.now()}`;
    const ca = await mintTestCa('freshboth');
    try {
      const outcome = await materializeProjectCa(
        vaultRawWithCa(fleet, ca), owner, fleet,
        { caCertPathFor: caCertPath, caKeyPathFor: caKeyPath },
        false, true,
      );
      expect(outcome).toEqual({ status: 'materialized', certFingerprint: caCertFingerprint(ca.certPem) });
      expect(existsSync(join(FAKE_HOME, '.macf', 'certs', owner, fleet, 'ca-cert.pem'))).toBe(true);
      expect(existsSync(join(FAKE_HOME, '.macf', 'certs', fleet))).toBe(false); // legacy tier never materialized
    } finally {
      rmSync(join(FAKE_HOME, '.macf', 'certs', owner), { recursive: true, force: true });
    }
  });

  it('allowLegacyFallback OMITTED (default false): a MATCHING legacy CA is never even consulted — override/default-without-opt-in fully owns resolution', async () => {
    const fleet = `no-fallback-${Date.now()}`;
    const owner = `owner-${Date.now()}`;
    const ca = await mintTestCa('nofallback');
    const legacyDir = join(FAKE_HOME, '.macf', 'certs', fleet);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'ca-cert.pem'), ca.certPem);
    writeFileSync(join(legacyDir, 'ca-key.pem'), ca.keyPem);
    try {
      const outcome = await materializeProjectCa(
        vaultRawWithCa(fleet, ca), owner, fleet,
        { caCertPathFor: caCertPath, caKeyPathFor: caKeyPath },
        // forceCa + allowLegacyFallback both omitted -> both default false.
      );

      // DECISIVE: 'materialized' (a WRITE happened) proves the legacy tier
      // was never even looked at — a 'already-current' outcome here would
      // mean the legacy match got (wrongly) reused despite no opt-in.
      expect(outcome).toEqual({ status: 'materialized', certFingerprint: caCertFingerprint(ca.certPem) });
      expect(existsSync(join(FAKE_HOME, '.macf', 'certs', owner, fleet, 'ca-cert.pem'))).toBe(true);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
      rmSync(join(FAKE_HOME, '.macf', 'certs', owner), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — the GENERATED LAUNCHER (env-files.ts / claude-sh.ts)
//
// "Walking outward" per macf#1129 / assert-the-wrong-path.md: layers 1-2
// above prove the Node-side HELPER logic. These tests instead EXECUTE the
// generated shell text via `sh -c` against real files, so a defect in the
// generated STRING itself (not just the helper functions) fails here too.
// ---------------------------------------------------------------------------

function ghConfig(owner: string, project: string): MacfAgentConfig {
  return {
    project,
    agent_name: 'code-agent',
    agent_role: 'code-agent',
    agent_type: 'permanent',
    registry: { type: 'profile', user: owner },
    github_app: { app_id: '1', install_id: '2', key_path: 'k.pem' },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
  };
}

/** Runs a generated `env.certs`-shaped shell fragment under a real `sh`, against a scratch `$HOME`, and returns the resolved MACF_CA_CERT/MACF_CA_KEY. */
function runCaFragment(shellHome: string, script: string): { readonly cert: string; readonly key: string } {
  const full = `${script}\nprintf '%s|%s' "$MACF_CA_CERT" "$MACF_CA_KEY"`;
  const r = spawnSync('sh', ['-c', full], {
    env: { HOME: shellHome, PATH: process.env['PATH'] ?? '' },
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    throw new Error(`generated CA shell fragment exited ${String(r.status)}: ${r.stderr}`);
  }
  const [cert, key] = r.stdout.split('|');
  return { cert: cert ?? '', key: key ?? '' };
}

describe('macf#1277 — generated env.certs: runtime shell resolution (executed, not just inspected)', () => {
  it('literal shape: the owner-scoped conventional path is checked FIRST, the legacy path SECOND (elif)', () => {
    const out = generateEnvCerts(ghConfig('acme', 'demo'));
    const ifIdx = out.indexOf('if [ -f "$HOME/.macf/certs/acme/demo/ca-cert.pem" ]; then');
    const elifIdx = out.indexOf('elif [ -f "$HOME/.macf/certs/demo/ca-cert.pem" ]; then');
    expect(ifIdx).toBeGreaterThanOrEqual(0);
    expect(elifIdx).toBeGreaterThan(ifIdx);
  });

  it('EXECUTED: a CA at the owner-scoped conventional path resolves MACF_CA_CERT/KEY there', () => {
    const shellHome = scratchDir('macf-1277-shellhome-');
    const owner = 'acme';
    const project = 'demo-conv';
    const dir = join(shellHome, '.macf', 'certs', owner, project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ca-cert.pem'), 'CONVENTIONAL-CERT');
    writeFileSync(join(dir, 'ca-key.pem'), 'CONVENTIONAL-KEY');

    const { cert, key } = runCaFragment(shellHome, generateEnvCerts(ghConfig(owner, project)));
    expect(cert).toBe(join(dir, 'ca-cert.pem'));
    expect(key).toBe(join(dir, 'ca-key.pem'));
  });

  it('EXECUTED — THE DECISIVE TEST: an EXISTING fleet whose CA lives ONLY at the pre-#1277 legacy path keeps resolving in the GENERATED launcher, without any re-deploy or migration', () => {
    const shellHome = scratchDir('macf-1277-shellhome-');
    const owner = 'acme';
    const project = 'demo-legacy';
    // ONLY the legacy path has a file — simulates an already-deployed
    // fleet (e.g. macf-trial at the time #1277 was filed) whose CA was
    // materialized before owner-scoping existed. The owner-scoped
    // conventional directory does not exist at all.
    const legacyDir = join(shellHome, '.macf', 'certs', project);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'ca-cert.pem'), 'LEGACY-CERT');
    writeFileSync(join(legacyDir, 'ca-key.pem'), 'LEGACY-KEY');
    expect(existsSync(join(shellHome, '.macf', 'certs', owner))).toBe(false);

    const { cert, key } = runCaFragment(shellHome, generateEnvCerts(ghConfig(owner, project)));

    expect(cert).toBe(join(legacyDir, 'ca-cert.pem'));
    expect(key).toBe(join(legacyDir, 'ca-key.pem'));
    // The AC's own bar: "its generated MACF_CA_CERT still points at a
    // file that exists" — not merely a plausible-looking path.
    expect(existsSync(cert)).toBe(true);
    expect(readFileSync(cert, 'utf-8')).toBe('LEGACY-CERT');
  });

  it('EXECUTED: absent at BOTH tiers resolves to the (nonexistent) conventional path — never a lie, never a silent mint', () => {
    const shellHome = scratchDir('macf-1277-shellhome-');
    const owner = 'acme';
    const project = 'demo-absent';

    const { cert } = runCaFragment(shellHome, generateEnvCerts(ghConfig(owner, project)));

    expect(cert).toBe(join(shellHome, '.macf', 'certs', owner, project, 'ca-cert.pem'));
    expect(existsSync(cert)).toBe(false); // this shell fragment never mints anything
  });

  it('EXECUTED: the owner-scoped conventional path wins when BOTH tiers have a file', () => {
    const shellHome = scratchDir('macf-1277-shellhome-');
    const owner = 'acme';
    const project = 'demo-both';
    const conventionalDir = join(shellHome, '.macf', 'certs', owner, project);
    const legacyDir = join(shellHome, '.macf', 'certs', project);
    mkdirSync(conventionalDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(conventionalDir, 'ca-cert.pem'), 'CONVENTIONAL');
    writeFileSync(join(legacyDir, 'ca-cert.pem'), 'LEGACY');

    const { cert } = runCaFragment(shellHome, generateEnvCerts(ghConfig(owner, project)));
    expect(cert).toBe(join(conventionalDir, 'ca-cert.pem'));
  });

  it('claude-sh.ts::caPathLines emits the SAME 3-tier literal paths as env-files.ts::generateEnvCerts (kept in lockstep per its own doc)', () => {
    const cfg = ghConfig('acme', 'demo-lockstep');
    const envScript = generateEnvCerts(cfg);
    const claudeShScript = caPathLines(cfg).join('\n');
    for (const frag of [
      'if [ -f "$HOME/.macf/certs/acme/demo-lockstep/ca-cert.pem" ]; then',
      'elif [ -f "$HOME/.macf/certs/demo-lockstep/ca-cert.pem" ]; then',
      '$HOME/.macf/certs/acme/demo-lockstep/ca-key.pem',
      '$HOME/.macf/certs/demo-lockstep/ca-key.pem',
    ]) {
      expect(envScript).toContain(frag);
      expect(claudeShScript).toContain(frag);
    }
  });
});
