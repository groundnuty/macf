/**
 * Tests for `apply-fleet.ts` — the fleet-level `macf bootstrap apply` driver
 * (DR-043 §D5, Slice 2b increment 5a, groundnuty/macf#838). Fully offline:
 * `applyAgentIdentity` and `applyRepoInitForAgent` are stubbed via injected
 * `AgentApplyDeps`/`RepoInitStepDeps`; `writeVault`'s `age` call is faked;
 * only `fleet.lock` (a small local JSON file) touches real fs.
 *
 * **Exception (macf#852):** the trailing "REAL age binary" test below
 * deliberately leaves `vaultDeps.encrypt` unset so
 * `writeVault`/`writeAgentRecoveryArtifact` fall through to the real
 * `ageEncryptToFile` — the one place in this file that touches the real
 * `age` binary, gated `skipIf(!HAS_AGE)` per `vault-write.test.ts`'s
 * "never fake a passing test" convention.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFleet, type FleetApplyDeps } from '../../../src/cli/bootstrap/apply-fleet.js';
import type { FleetAgent, FleetLock, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { parseFleetLock, parseFleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { AgentApplyDeps } from '../../../src/cli/bootstrap/apply-agent.js';
import type { AgentRepoDeps, RepoInitStepDeps } from '../../../src/cli/bootstrap/apply-repo-init.js';
import type { ControlRepoDeps } from '../../../src/cli/bootstrap/control-repo.js';
import type { AppCredentials } from '../../../src/cli/bootstrap/manifest-exchange.js';

// Default mirrors the §D5 multi-recipient shape (operator key + VM key,
// macf#852) — two entries is the realistic steady-state, not a single
// string. Tests exercising the "no recipients configured" pre-flight pass
// `[]` explicitly.
function manifestWith(agents: readonly FleetAgent[], ageRecipients: readonly string[] = ['age1operator', 'age1vm']): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'demo-fleet' },
    // Immutable full tag so a NOOP_REPO_INIT-driven repoInit() call never
    // makes a real network call resolving a floating ref (macf#797).
    versions: { macf: '0.2.56', actions: 'v3.4.1' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ageRecipients },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents,
    trust: { ca: 'per-project', federated_cas: [] },
  };
}

// --- DR-043 Amendment F (macf#857) — control-repo / agent-repo fakes ---
//
// `provisionControlRepo`'s `makeScratchDir` (threaded via
// `FleetApplyDeps.controlRepoOptions`) is pointed at the SAME temp dir
// `manifestPathIn()` already created + tracks for cleanup — this is what
// keeps every EXISTING path-based assertion in this file (`result.lockPath`,
// the hand-built `secrets/recovery/<role>.age` paths) valid unchanged: the
// control-repo "checkout" IS `dirname(manifestPath)` in every test below,
// exactly matching this file's pre-Amendment-F behavior. A `checkMeta` that
// always reports `'absent'` means every test run takes the CREATE path
// (no real `gh`/`git` — `createRepo`/`cloneRepo`/`commitAndPush` are no-ops).
function controlRepoDepsFor(): ControlRepoDeps {
  return {
    checkMeta: async () => ({ presence: 'absent' }),
    readManifestFile: async () => undefined,
    createRepo: async () => {},
    cloneRepo: async () => {},
    commitAndPush: async () => 'pushed',
  };
}

/** Every agent's repo reports `'absent'` -> `ensureAgentRepo` "creates" it (no-op `createRepo`). */
function agentRepoDepsFor(): AgentRepoDeps {
  return { checkExists: async () => 'absent', createRepo: async () => {} };
}

const CODE_AGENT: FleetAgent = { role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/x' };
const SCI_AGENT: FleetAgent = { role: 'science-agent', profile: 'research', repo: 'groundnuty/demo-science', deploy_path: '/y' };

function creds(seed: string): AppCredentials {
  return {
    appId: `app-${seed}`,
    name: `demo-fleet-${seed}`,
    slug: `demo-fleet-${seed}`,
    clientId: `client-${seed}`,
    clientSecret: `SENTINEL-SECRET-${seed}`,
    webhookSecret: `SENTINEL-HOOK-${seed}`,
    pem: `SENTINEL-PEM-${seed}`,
  };
}

// apply-fleet.ts imports `applyAgentIdentity` directly from apply-agent.ts —
// it is not deps-injected at the apply-fleet level (that indirection lives
// one layer down, in apply-agent.ts's OWN test suite). To drive apply-fleet
// deterministically we script the underlying `AgentApplyDeps` primitives so
// `applyAgentIdentity` itself produces the outcome we want, without
// re-testing gate mechanics here (already covered by apply-agent.test.ts).
function agentDepsFor(role: string, outcome: 'reused' | 'resumed-install' | 'created' | 'skipped-unverified' | 'drift' | 'failed', appId: string, installId: string): AgentApplyDeps {
  const base: AgentApplyDeps = {
    startManifestFlow: async () => ({
      startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {},
    }),
    exchangeManifestCode: async () => creds(role),
    waitForAppInstallation: async () => ({ appId, installId, appSlug: `demo-fleet-${role}`, accountLogin: 'groundnuty' }),
    confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
    openUrl: async () => {},
    log: () => {},
    // applyFleet ALWAYS overrides this field with its own real recovery-
    // artifact writer (see apply-fleet.ts's `buildAgentDepsWithRecovery`) —
    // present here only to satisfy `AgentApplyDeps`'s type; its behavior is
    // exercised via `vaultDeps.encrypt` in the tests below, not via this stub.
    writeRecoveryArtifact: async () => {},
  };
  switch (outcome) {
    case 'reused':
      return {
        ...base,
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async () => ({ status: 'confirmed', install: { appId, installId, appSlug: `demo-fleet-${role}`, accountLogin: 'groundnuty' } }),
      };
    case 'resumed-install':
      return {
        ...base,
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      };
    case 'created':
      return base; // no prior entry -> guard authorizes create -> gate1+gate2 via base
    case 'skipped-unverified':
      return base; // relies on caller passing a PRIOR lock entry with no resolveKeyPath
    case 'drift':
      return {
        ...base,
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async () => ({ status: 'installed-unexpected-target', installs: [{ appId, installId: 'other', appSlug: `demo-fleet-${role}`, accountLogin: 'someone-else' }] }),
      };
    case 'failed':
      return { ...base, exchangeManifestCode: async () => { throw new Error('boom'); } };
  }
}

const NOOP_REPO_INIT: RepoInitStepDeps = { cloneRepo: async () => {}, commitAndPush: async () => 'pushed' };

// --- Real `age` binary support (macf#852 — see the trailing test below) ---
//
// Everything else in this file stubs `vaultDeps.encrypt`, proving the
// ORCHESTRATION (ordering, lock-write gating, artifact lifecycle) but never
// the property this issue is actually about: that `transport.age_recipients`
// being a LIST means `vault.age` decrypts under EITHER key independently,
// not one shared key copied to two machines. `haveAgeBinaries`/`HAS_AGE`
// gate the one test that drives `parseFleetManifest` → `applyFleet` → the
// real `age` binary (no `vaultDeps.encrypt` override — falls through to
// `writeVault`'s own `ageEncryptToFile` default). Skipped, never faked, when
// `age`/`age-keygen` are absent from PATH — same convention as
// `vault-write.test.ts`'s `HAS_AGE`.
function haveAgeBinaries(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' }).status === 0;
}
const HAS_AGE = haveAgeBinaries('age') && haveAgeBinaries('age-keygen');

function mintAgeKey(dir: string, name: string): { keyPath: string; publicKey: string } {
  const keyPath = join(dir, name);
  const r = spawnSync('age-keygen', ['-o', keyPath], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
  const content = readFileSync(keyPath, 'utf-8');
  const match = /age1[0-9a-z]+/.exec(content);
  expect(match).not.toBeNull();
  return { keyPath, publicKey: match?.[0] ?? '' };
}

describe('applyFleet', () => {
  const dirs: string[] = [];
  // See apply-repo-init.test.ts's identical guard: neutralize ambient
  // GH_TOKEN/APP_ID/etc so the REAL repoInit() (run via NOOP_REPO_INIT's
  // real repoInit default) degrades label-creation deterministically
  // instead of attempting a real GitHub API call.
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['GH_TOKEN', 'APP_ID', 'INSTALL_ID', 'KEY_PATH']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const k of ['GH_TOKEN', 'APP_ID', 'INSTALL_ID', 'KEY_PATH']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function manifestPathIn(): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-test-'));
    dirs.push(dir);
    return join(dir, 'fleet.yaml');
  }

  /**
   * `manifestPath` is now REQUIRED (macf#857) — `controlRepoOptions.makeScratchDir`
   * is pinned to `dirname(manifestPath)` so the control-repo "checkout" IS
   * the same temp dir every OTHER path in this file already assumes (see
   * this file's top-of-file `controlRepoDepsFor` doc). Every EXISTING
   * `result.lockPath` / hand-built `secrets/...` assertion in this file
   * keeps working unchanged.
   */
  function baseDeps(agentDeps: AgentApplyDeps, manifestPath: string, repoInitDeps: RepoInitStepDeps = NOOP_REPO_INIT): FleetApplyDeps {
    return {
      buildAgentDeps: () => agentDeps,
      repoInitDeps,
      vaultDeps: { exists: () => false, encrypt: async () => {} },
      controlRepoDeps: controlRepoDepsFor(),
      agentRepoDeps: agentRepoDepsFor(),
      controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      log: () => {},
    };
  }

  it('a freshly-created agent: lock is written ONLY after the vault write succeeds, with fingerprints', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    let repoInitCalled = false;
    const repoInitDeps: RepoInitStepDeps = { cloneRepo: async () => { repoInitCalled = true; }, commitAndPush: async () => 'pushed' };
    const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath, repoInitDeps);

    const result = await applyFleet(manifest, manifestPath, null, deps);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.identity.status).toBe('created');
    expect(result.vault.status).toBe('written');
    expect(repoInitCalled).toBe(true);
    expect(result.agents[0]?.repoInit?.status).toBe('applied');

    expect(existsSync(result.lockPath)).toBe(true);
    const lock: FleetLock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
    expect(lock.agents).toEqual([{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1', fingerprints: expect.any(Object) }]);
    expect(Object.keys(lock.agents[0]?.fingerprints ?? {}).sort()).toEqual(['app_private_key', 'client_secret', 'webhook_secret']);
  });

  it('no age_recipients configured: the DR-043 §D5 pre-flight refuses gate 1 ENTIRELY — no App is ever created, no lock entry, no repo-init', async () => {
    // Before the §D5 review fix, this scenario ran BOTH consent gates to
    // completion and only failed at the very end (the batched vault write)
    // — meaning a REAL, irreversible GitHub App got created with an
    // unrecoverable credential. `applyFleet`'s pre-flight (module doc:
    // `wouldCreateWithNoRecipient` / `noRecipientPreflightFailure`) now
    // proves this role would hit that dead end BEFORE calling
    // `applyAgentIdentity` at all — gate 1 (`startManifestFlow` /
    // `exchangeManifestCode`) is never even attempted, not just gate 2.
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT], /* ageRecipients */ []);
    let gate1Called = false;
    let gate2Called = false;
    const agentDeps = agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1');
    const deps = baseDeps({
      ...agentDeps,
      startManifestFlow: async (opts) => {
        gate1Called = true;
        return agentDeps.startManifestFlow(opts);
      },
      waitForAppInstallation: async (opts) => {
        gate2Called = true;
        return agentDeps.waitForAppInstallation(opts);
      },
    }, manifestPath);

    const result = await applyFleet(manifest, manifestPath, null, deps);

    expect(gate1Called).toBe(false);
    expect(gate2Called).toBe(false);
    expect(result.agents[0]?.identity.status).toBe('failed');
    if (result.agents[0]?.identity.status === 'failed') {
      // Plural specifically — a message that regressed to the old singular
      // field name would still satisfy a bare /age_recipient/ substring
      // match, so this asserts the actual list-shape wording (macf#852).
      expect(result.agents[0].identity.reason).toMatch(/age_recipients|age recipients/);
      expect(result.agents[0].identity.reason).toMatch(/CREATE path/);
    }
    // No 'created' outcome this run -> nothing pending -> vault is 'skipped', not 'failed':
    expect(result.vault.status).toBe('skipped');
    // No lock write for a 'failed' identity, and repo-init never ran (it only runs for reused/resumed-install/created):
    expect(result.agents[0]?.repoInit).toBeUndefined();
    expect(existsSync(result.lockPath)).toBe(false);
    expect(result.finalLock).toBeNull();
  });

  it('no age_recipients configured, but the role HAS a prior lock entry: pre-flight does NOT block it (reuse/resume never mints a fresh credential)', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT], /* ageRecipients */ []);
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    };
    const deps = baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath);

    const result = await applyFleet(manifest, manifestPath, priorLock, deps);

    // Reused proceeds normally — the pre-flight only fires for a role that
    // would take the CREATE path (no prior entry):
    expect(result.agents[0]?.identity.status).toBe('reused');
    expect(existsSync(result.lockPath)).toBe(true);
  });

  it('reused / resumed-install: lock is written IMMEDIATELY, no vault write attempted for them', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
      ],
    };

    // Two distinct AgentApplyDeps per role: applyFleet builds ONE via
    // buildAgentDeps(log), so we discriminate on `agent.role` isn't
    // possible through buildAgentDeps alone — dispatch via confirmAppInstallation
    // keyed on the appId being confirmed.
    const agentDeps: AgentApplyDeps = {
      startManifestFlow: async () => { throw new Error('must not be called — both roles have prior entries'); },
      exchangeManifestCode: async () => { throw new Error('must not be called'); },
      resolveKeyPath: () => '/fake.pem',
      confirmAppInstallation: async (appId) =>
        appId === 'app-code-agent'
          ? { status: 'confirmed', install: { appId, installId: 'install-1', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' } }
          : { status: 'app-no-install' },
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: 'install-2-resumed', appSlug: 'demo-fleet-science-agent', accountLogin: 'groundnuty' }),
      openUrl: async () => {},
      log: () => {},
      writeRecoveryArtifact: async () => {}, // overridden by applyFleet regardless — see agentDepsFor's comment
    };

    const result = await applyFleet(manifest, manifestPath, priorLock, baseDeps(agentDeps, manifestPath));

    expect(result.agents.map((r) => r.identity.status)).toEqual(['reused', 'resumed-install']);
    expect(result.vault.status).toBe('skipped'); // nothing NEW to persist
    const lock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
    expect(lock.agents.find((a) => a.role === 'code-agent')).toEqual({ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' });
    expect(lock.agents.find((a) => a.role === 'science-agent')).toEqual({ role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2-resumed' });
  });

  it('skipped-unverified / drift: no lock write, no repo-init', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    };
    // No resolveKeyPath -> guard resolves skip-unverified.
    const deps = baseDeps(agentDepsFor('code-agent', 'skipped-unverified', 'x', 'y'), manifestPath);
    const result = await applyFleet(manifest, manifestPath, priorLock, deps);
    expect(result.agents[0]?.identity.status).toBe('skipped-unverified');
    expect(result.agents[0]?.repoInit).toBeUndefined();
    expect(result.vault.status).toBe('skipped');
    // Untouched-this-run entries are NOT rewritten (composeFleetLock is never
    // called for a skip), so no fleet.lock file is produced at all here.
    expect(existsSync(result.lockPath)).toBe(false);
  });

  it('identity DRIFT is surfaced via identityChanges — a re-confirmed app_id differing from the prior lock', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'OLD-app-id', install_id: 'OLD-install-id' }],
    };
    const agentDeps: AgentApplyDeps = {
      startManifestFlow: async () => { throw new Error('must not be called'); },
      exchangeManifestCode: async () => { throw new Error('must not be called'); },
      resolveKeyPath: () => '/fake.pem',
      confirmAppInstallation: async () => ({
        status: 'confirmed',
        install: { appId: 'NEW-app-id', installId: 'NEW-install-id', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' },
      }),
      waitForAppInstallation: async () => { throw new Error('must not be called'); },
      openUrl: async () => {},
      log: () => {},
      writeRecoveryArtifact: async () => {}, // overridden by applyFleet regardless — see agentDepsFor's comment
    };
    const result = await applyFleet(manifest, manifestPath, priorLock, baseDeps(agentDeps, manifestPath));
    expect(result.identityChanges).toEqual(
      expect.arrayContaining([
        { role: 'code-agent', field: 'app_id', previous: 'OLD-app-id', next: 'NEW-app-id' },
        { role: 'code-agent', field: 'install_id', previous: 'OLD-install-id', next: 'NEW-install-id' },
      ]),
    );
  });

  it('a mix of created + already-present agents in one run: vault carries ONLY the created one, both get lock entries', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' }],
    };
    const encryptCalls: { plaintext: string; outPath: string }[] = [];
    const agentDeps: AgentApplyDeps = {
      startManifestFlow: async () => ({ startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} }),
      exchangeManifestCode: async () => creds('code-agent'),
      resolveKeyPath: () => '/fake.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: { appId: 'app-science-agent', installId: 'install-2', appSlug: 'demo-fleet-science-agent', accountLogin: 'groundnuty' } }),
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: 'install-1', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' }),
      openUrl: async () => {},
      log: () => {},
      writeRecoveryArtifact: async () => {}, // overridden by applyFleet regardless — see agentDepsFor's comment
    };
    const deps: FleetApplyDeps = {
      ...baseDeps(agentDeps, manifestPath),
      vaultDeps: {
        exists: () => false,
        encrypt: async (plaintext, _recipients, outPath) => {
          encryptCalls.push({ plaintext, outPath });
        },
      },
    };

    const result = await applyFleet(manifest, manifestPath, priorLock, deps);

    expect(result.vault.status).toBe('written');
    // TWO encrypt calls now: the pre-gate-2 recovery artifact (DR-043 §D5
    // durable-before-gate-2) fires first, THEN the batched final vault —
    // asserted by ORDER, not just presence, so this doesn't just infer the
    // sequencing from the loop structure.
    expect(encryptCalls).toHaveLength(2);
    expect(encryptCalls.map((c) => c.outPath.includes('recovery'))).toEqual([true, false]);
    const recoveryCall = encryptCalls.find((c) => c.outPath.includes('recovery'));
    const finalVaultCall = encryptCalls.find((c) => !c.outPath.includes('recovery'));
    expect(recoveryCall?.outPath).toMatch(/secrets[/\\]recovery[/\\]code-agent\.age$/);
    expect(recoveryCall?.plaintext).toContain('MACF_RECOVERY_CODE_AGENT_APP_ID');
    expect(finalVaultCall?.plaintext).toContain('CODE_AGENT'); // the freshly-created agent's segment
    expect(finalVaultCall?.plaintext).not.toContain('SCIENCE_AGENT_CLIENT_SECRET'); // reused agent contributes NO fresh secret

    const lock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
    expect(lock.agents.map((a) => a.role).sort()).toEqual(['code-agent', 'science-agent']);
  });

  it('NEVER logs a secret value across the whole fleet run (create + failure paths)', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const logs: string[] = [];
    const deps: FleetApplyDeps = {
      ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
      buildAgentDeps: (log) => {
        const wrapped: AgentApplyDeps = { ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), log };
        return wrapped;
      },
      log: (l) => logs.push(l),
    };
    await applyFleet(manifest, manifestPath, null, deps);
    const joined = logs.join('\n');
    expect(joined).not.toContain('SENTINEL-SECRET-code-agent');
    expect(joined).not.toContain('SENTINEL-HOOK-code-agent');
    expect(joined).not.toContain('SENTINEL-PEM-code-agent');
  });

  // --- Recovery-artifact lifecycle (DR-043 §D5 "durable before gate 2") ---

  it('recovery artifact: written before gate 2, then REMOVED once the final compose SUCCEEDS', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath);
    // A real fake `age`: actually writes a stub file so the artifact's
    // presence/absence on disk is observable (the `encrypt` seam this
    // reuses — task requirement: no separate seam, no real `age` binary).
    const realDeps: FleetApplyDeps = {
      ...deps,
      vaultDeps: {
        exists: () => false,
        encrypt: async (plaintext, _recipients, outPath) => {
          writeFileSync(outPath, `FAKE-AGE-CIPHERTEXT\n${plaintext.length.toString()}`);
        },
      },
    };

    const recoveryPath = join(join(manifestPath, '..'), 'secrets', 'recovery', 'code-agent.age');
    const result = await applyFleet(manifest, manifestPath, null, realDeps);

    expect(result.agents[0]?.identity.status).toBe('created');
    // Insurance copy is gone — the credential now lives durably in the FINAL vault:
    expect(existsSync(recoveryPath)).toBe(false);
    if (result.vault.status === 'written') {
      expect(existsSync(result.vault.path)).toBe(true);
    } else {
      expect.fail(`expected vault.status 'written', got ${JSON.stringify(result.vault)}`);
    }
  });

  it('recovery artifact: RETAINED when the final compose FAILS (write-only insurance stays until it is actually redundant)', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath);
    const realDeps: FleetApplyDeps = {
      ...deps,
      vaultDeps: {
        exists: () => false,
        encrypt: async (plaintext, _recipients, outPath) => {
          if (outPath.includes('recovery')) {
            writeFileSync(outPath, `FAKE-AGE-CIPHERTEXT\n${plaintext.length.toString()}`);
            return;
          }
          // Simulate the FINAL vault's own `age` invocation failing (disk
          // full, age crashed, etc.) — independent of the recovery write,
          // which already succeeded.
          throw new Error('simulated final-vault encrypt failure');
        },
      },
    };

    const recoveryPath = join(join(manifestPath, '..'), 'secrets', 'recovery', 'code-agent.age');
    const result = await applyFleet(manifest, manifestPath, null, realDeps);

    expect(result.vault.status).toBe('failed');
    expect(result.agents[0]?.identity.status).toBe('created'); // gate 1 + gate 2 both succeeded — only the batched compose failed
    // The recovery artifact is the ONLY durable copy of this credential
    // right now — it MUST still be on disk:
    expect(existsSync(recoveryPath)).toBe(true);
    // No lock entry either (the vault-before-lock invariant — see module doc):
    expect(existsSync(result.lockPath)).toBe(false);
  });

  it('recovery artifact: the PATH is logged on success — an operator reading the transcript can find it after a crash', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const logs: string[] = [];
    const deps: FleetApplyDeps = {
      ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
      buildAgentDeps: (log) => ({ ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), log }),
      log: (l) => logs.push(l),
    };

    await applyFleet(manifest, manifestPath, null, deps);

    const recoveryPath = join(join(manifestPath, '..'), 'secrets', 'recovery', 'code-agent.age');
    expect(logs.some((l) => l.includes(recoveryPath))).toBe(true);
  });

  it('recovery artifact: a write FAILURE surfaces the attempted PATH in AgentApplyOutcome.reason (findable even from --json output alone)', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath);
    const realDeps: FleetApplyDeps = {
      ...deps,
      vaultDeps: {
        exists: () => false,
        encrypt: async () => {
          throw new Error('disk full');
        },
      },
    };

    const result = await applyFleet(manifest, manifestPath, null, realDeps);

    const recoveryPath = join(join(manifestPath, '..'), 'secrets', 'recovery', 'code-agent.age');
    expect(result.agents[0]?.identity.status).toBe('failed');
    if (result.agents[0]?.identity.status === 'failed') {
      expect(result.agents[0].identity.reason).toContain('disk full');
      expect(result.agents[0].identity.reason).toContain(recoveryPath);
    }
  });

  it.skipIf(!HAS_AGE)(
    'REAL age binary: transport.age_recipients: [operatorKey, vmKey] parses through the schema and produces ' +
      'a vault.age that EACH key decrypts independently — the property this issue exists for',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-real-age-test-'));
      dirs.push(dir);
      const operatorKey = mintAgeKey(dir, 'operator-key.txt');
      const vmKey = mintAgeKey(dir, 'vm-key.txt');
      const manifestPath = join(dir, 'fleet.yaml');

      // Round-trips the two REAL public keys through the actual Zod schema
      // (not a hand-built FleetManifest object) — proves the schema layer
      // itself, not just the apply-fleet plumbing below it.
      const fleetYaml = `
apiVersion: macf/v0
kind: Fleet
metadata:
  name: demo-fleet
versions:
  macf: 0.2.56
  actions: v3.4.1
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
network:
  advertise_host: example.ts.net
transport:
  age_recipients: [${operatorKey.publicKey}, ${vmKey.publicKey}]
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
      const manifest = parseFleetManifest(fleetYaml);
      expect(manifest.transport.age_recipients).toEqual([operatorKey.publicKey, vmKey.publicKey]);

      const deps: FleetApplyDeps = {
        buildAgentDeps: () => agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
        repoInitDeps: NOOP_REPO_INIT,
        vaultDeps: { exists: () => false }, // no `encrypt` override — real `age` runs
        controlRepoDeps: controlRepoDepsFor(),
        agentRepoDeps: agentRepoDepsFor(),
        controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
        now: () => new Date('2026-08-11T00:00:00.000Z'),
        log: () => {},
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.vault.status).toBe('written');
      if (result.vault.status !== 'written') return; // narrows for TS below
      expect(existsSync(result.vault.path)).toBe(true);

      // The whole point: BOTH keys decrypt the SAME ciphertext independently
      // — no shared single key copied between the operator's Mac and the VM.
      const decryptOperator = spawnSync('age', ['-d', '-i', operatorKey.keyPath, result.vault.path], { encoding: 'utf-8' });
      expect(decryptOperator.status, decryptOperator.stderr).toBe(0);
      expect(decryptOperator.stdout).toContain("MACF_AGENT_DEMO_FLEET_CODE_AGENT_APP_ID='app-code-agent'");

      const decryptVm = spawnSync('age', ['-d', '-i', vmKey.keyPath, result.vault.path], { encoding: 'utf-8' });
      expect(decryptVm.status, decryptVm.stderr).toBe(0);
      expect(decryptVm.stdout).toBe(decryptOperator.stdout);

      // A third, unrelated key must NOT decrypt it — proves this isn't
      // accidentally permissive (e.g. no-op encryption).
      const strangerKey = mintAgeKey(dir, 'stranger-key.txt');
      const decryptStranger = spawnSync('age', ['-d', '-i', strangerKey.keyPath, result.vault.path], { encoding: 'utf-8' });
      expect(decryptStranger.status).not.toBe(0);
    },
  );

  // --- DR-043 Amendment F (macf#857): control-repo step 0 + ordering ---

  /**
   * Discriminates a single SHARED `AgentApplyDeps` object (`buildAgentDeps`
   * is called ONCE per `applyFleet` run, not per-agent — see the "reused /
   * resumed-install" test above's identical comment) by role, threading the
   * role through the opaque `code` string `waitForCode`/`exchangeManifestCode`
   * pass between them, and through `waitForAppInstallation`'s
   * `opts.expected.appSlug` (== `deriveAppHandle(fleet, role)`).
   */
  function roleTrackingAgentDeps(fleetName: string, calls: string[]): AgentApplyDeps {
    return {
      startManifestFlow: async (opts) => {
        const role = opts.buildManifest('http://x/callback').name.replace(`${fleetName}-`, '');
        calls.push(`gate1:${role}`);
        return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => `code-for-${role}`, close: async () => {} };
      },
      exchangeManifestCode: async (code) => creds(code.replace('code-for-', '')),
      waitForAppInstallation: async (opts) => {
        const role = (opts.expected.appSlug ?? '').replace(`${fleetName}-`, '');
        calls.push(`gate2:${role}`);
        return { appId: opts.appId, installId: `install-${role}`, appSlug: opts.expected.appSlug ?? '', accountLogin: 'groundnuty' };
      },
      confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
      openUrl: async () => {},
      log: () => {},
      writeRecoveryArtifact: async () => {}, // overridden by applyFleet regardless — see agentDepsFor's comment
    };
  }

  it('exact ordering: control repo (once, before ANY agent) -> per agent: ensure-repo -> gate 1 -> gate 2, one agent fully before the next starts', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
    const calls: string[] = [];

    const controlRepoDeps: ControlRepoDeps = {
      checkMeta: async () => {
        calls.push('control:checkMeta');
        return { presence: 'absent' };
      },
      readManifestFile: async () => undefined,
      createRepo: async () => {
        calls.push('control:create');
      },
      cloneRepo: async () => {
        calls.push('control:clone');
      },
      commitAndPush: async () => {
        calls.push('control:commitAndPush');
        return 'pushed';
      },
    };
    const agentRepoDeps: AgentRepoDeps = {
      checkExists: async (repo) => {
        calls.push(`repo:checkExists:${repo}`);
        return 'absent';
      },
      createRepo: async (repo) => {
        calls.push(`repo:create:${repo}`);
      },
    };
    const deps: FleetApplyDeps = {
      buildAgentDeps: () => roleTrackingAgentDeps('demo-fleet', calls),
      repoInitDeps: { cloneRepo: async () => {}, commitAndPush: async () => 'pushed' },
      vaultDeps: { exists: () => false, encrypt: async () => {} },
      controlRepoDeps,
      agentRepoDeps,
      controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      log: () => {},
    };

    const result = await applyFleet(manifest, manifestPath, null, deps);

    expect(result.agents.map((r) => r.identity.status)).toEqual(['created', 'created']);

    // The full sequence, quoted verbatim in this test file so it's citable
    // directly (see the report requirement to quote ordering from code):
    //   control:checkMeta -> control:create -> control:clone -> control:commitAndPush
    //   -> repo:checkExists:<code-repo> -> repo:create:<code-repo> -> gate1:code-agent -> gate2:code-agent
    //   -> repo:checkExists:<sci-repo>  -> repo:create:<sci-repo>  -> gate1:science-agent -> gate2:science-agent
    //   -> control:commitAndPush (final sync)
    const controlCreateIdx = calls.indexOf('control:create');
    const repoCreateCodeIdx = calls.indexOf('repo:create:groundnuty/demo-code');
    const gate1CodeIdx = calls.indexOf('gate1:code-agent');
    const gate2CodeIdx = calls.indexOf('gate2:code-agent');
    const repoCreateSciIdx = calls.indexOf('repo:create:groundnuty/demo-science');
    const gate1SciIdx = calls.indexOf('gate1:science-agent');
    const gate2SciIdx = calls.indexOf('gate2:science-agent');

    // Control repo is step 0 — before EITHER agent's repo-ensure.
    expect(controlCreateIdx).toBeGreaterThanOrEqual(0);
    expect(controlCreateIdx).toBeLessThan(repoCreateCodeIdx);
    expect(controlCreateIdx).toBeLessThan(repoCreateSciIdx);
    // code-agent: repo BEFORE gate 1 BEFORE gate 2.
    expect(repoCreateCodeIdx).toBeLessThan(gate1CodeIdx);
    expect(gate1CodeIdx).toBeLessThan(gate2CodeIdx);
    // science-agent: same shape.
    expect(repoCreateSciIdx).toBeLessThan(gate1SciIdx);
    expect(gate1SciIdx).toBeLessThan(gate2SciIdx);
    // One agent fully completes (both gates) before the next agent's
    // repo-ensure even starts — agents are processed one at a time.
    expect(gate2CodeIdx).toBeLessThan(repoCreateSciIdx);
    // The control repo's SECOND commitAndPush (the final sync) is the very
    // LAST call of the whole run.
    const commitAndPushCalls = calls.filter((c) => c === 'control:commitAndPush');
    expect(commitAndPushCalls).toHaveLength(2); // step-0's first-commit + the final sync
    expect(calls.at(-1)).toBe('control:commitAndPush');
    expect(calls.indexOf('control:commitAndPush')).toBeLessThan(gate1CodeIdx); // the FIRST one is step 0, before gate 1
  });

  it('vault + lock paths derive from the control-repo CHECKOUT, not dirname(manifestPath), when they differ', async () => {
    const manifestPath = manifestPathIn(); // dirname(manifestPath) is a DIFFERENT dir than the control checkout below
    const manifest = manifestWith([CODE_AGENT]);
    const controlDir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-control-checkout-'));
    dirs.push(controlDir);
    const deps: FleetApplyDeps = {
      ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
      controlRepoOptions: { makeScratchDir: () => controlDir },
    };

    const result = await applyFleet(manifest, manifestPath, null, deps);

    expect(result.controlRepo.status).toBe('created');
    if (result.controlRepo.status === 'created' || result.controlRepo.status === 'reused') {
      expect(result.controlRepo.localDir).toBe(controlDir);
    }
    expect(result.lockPath).toBe(join(controlDir, 'fleet.lock'));
    expect(result.lockPath).not.toBe(join(join(manifestPath, '..'), 'fleet.lock'));
    expect(existsSync(result.lockPath)).toBe(true);
    if (result.vault.status === 'written') {
      expect(result.vault.path.startsWith(controlDir)).toBe(true);
    } else {
      expect.fail(`expected vault.status 'written', got ${JSON.stringify(result.vault)}`);
    }
    // Nothing was ever written under dirname(manifestPath) — the actual
    // structural fix for the #854 "wrote vault.age/fleet.lock to /tmp" bug.
    expect(existsSync(join(join(manifestPath, '..'), 'fleet.lock'))).toBe(false);
  });

  it('control repo FOREIGN -> aborts the ENTIRE run: no agent repo, App, or install is ever touched', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
    const agentRepoDeps: AgentRepoDeps = { checkExists: vi.fn(), createRepo: vi.fn() };
    const deps: FleetApplyDeps = {
      buildAgentDeps: () => {
        throw new Error('must not be called — control repo aborted before any agent processing');
      },
      repoInitDeps: { cloneRepo: async () => {}, commitAndPush: async () => 'pushed' },
      vaultDeps: { exists: () => false, encrypt: async () => {} },
      controlRepoDeps: {
        checkMeta: async () => ({ presence: 'present', archived: true }),
        readManifestFile: async () => undefined,
        createRepo: async () => {
          throw new Error('must not be called — foreign repo, never created');
        },
        cloneRepo: async () => {
          throw new Error('must not be called — foreign repo, never cloned');
        },
        commitAndPush: async () => {
          throw new Error('must not be called');
        },
      },
      agentRepoDeps,
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      log: () => {},
    };

    const result = await applyFleet(manifest, manifestPath, null, deps);

    expect(result.controlRepo.status).toBe('foreign');
    expect(result.controlRepoSync).toEqual({ status: 'skipped' });
    expect(result.agents).toEqual([]);
    expect(result.vault).toEqual({ status: 'skipped' });
    expect(result.identityChanges).toEqual([]);
    expect(agentRepoDeps.checkExists).not.toHaveBeenCalled();
  });

  it('control repo existence UNCONFIRMABLE ("unknown") -> aborts the ENTIRE run as "failed", not silently treated as absent or ours', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const deps: FleetApplyDeps = {
      buildAgentDeps: () => {
        throw new Error('must not be called');
      },
      repoInitDeps: { cloneRepo: async () => {}, commitAndPush: async () => 'pushed' },
      vaultDeps: { exists: () => false, encrypt: async () => {} },
      controlRepoDeps: {
        checkMeta: async () => ({ presence: 'unknown' }),
        readManifestFile: async () => undefined,
        createRepo: vi.fn(),
        cloneRepo: vi.fn(),
        commitAndPush: vi.fn(),
      },
      agentRepoDeps: agentRepoDepsFor(),
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      log: () => {},
    };

    const result = await applyFleet(manifest, manifestPath, null, deps);

    expect(result.controlRepo.status).toBe('failed');
    expect(result.agents).toEqual([]);
  });

  it('self-heal: a REUSE clone bringing back a committed fleet.lock is preferred over a null/stale caller-supplied priorLock', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const controlDir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-reuse-checkout-'));
    dirs.push(controlDir);
    const priorLockFromControlRepo: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    };
    const deps: FleetApplyDeps = {
      // 'reused' outcome needs confirmAppInstallation to confirm live —
      // resolveKeyPath present is what routes the guard there.
      buildAgentDeps: () => agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'),
      repoInitDeps: { cloneRepo: async () => {}, commitAndPush: async () => 'pushed' },
      vaultDeps: { exists: () => false, encrypt: async () => {} },
      controlRepoDeps: {
        checkMeta: async () => ({ presence: 'present', archived: false }),
        // A FULL, schema-valid fleet.yaml with a MATCHING metadata.name —
        // classifyControlRepoOwnership parses this for real (parseFleetManifest),
        // so a truncated fixture would fail validation and misclassify as
        // 'foreign' rather than 'ours' (caught empirically: see the earlier
        // failing run of this exact test before this fixture was filled out).
        readManifestFile: async () =>
          [
            'apiVersion: macf/v0',
            'kind: Fleet',
            'metadata:',
            '  name: demo-fleet',
            'owner:',
            '  account: groundnuty',
            '  type: user',
            '  registry: { type: profile, user: groundnuty }',
            'network:',
            '  advertise_host: example.ts.net',
            'transport:',
            '  age_recipients: []',
            'defaults:',
            '  role_template: groundnuty/agentic-repo-template',
            '  app_manifest: dr-019',
            'agents:',
            '  - role: code-agent',
            '    profile: code',
            '    repo: groundnuty/demo-code',
            '    deploy_path: /x',
          ].join('\n'),
        createRepo: async () => {
          throw new Error('must not be called — reuse never creates');
        },
        // The REAL clone would bring back whatever the control repo already
        // has committed — simulate that by writing fleet.lock into destDir.
        cloneRepo: async (_url, destDir) => {
          writeFileSync(join(destDir, 'fleet.lock'), JSON.stringify(priorLockFromControlRepo), 'utf-8');
        },
        commitAndPush: async () => 'nothing-to-commit',
      },
      agentRepoDeps: agentRepoDepsFor(),
      controlRepoOptions: { makeScratchDir: () => controlDir },
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      log: () => {},
    };

    // Caller passes `null` — as it would on a fresh CLI invocation that
    // never found anything at dirname(manifestPath) (the pre-Amendment-F
    // read path — see bootstrap-apply.ts's `readPriorLock` residual note).
    const result = await applyFleet(manifest, manifestPath, null, deps);

    // 'reused' (not 'created') PROVES the checkout's fleet.lock was used as
    // the prior — the confirm-before-create guard only reaches 'reused' when
    // `prior !== undefined` for this role.
    expect(result.agents[0]?.identity.status).toBe('reused');
  });
});
