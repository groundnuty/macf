/**
 * Tests for `apply-fleet.ts` — the fleet-level `macf bootstrap apply` driver
 * (DR-043 §D5, Slice 2b increment 5a, groundnuty/macf#838). Fully offline:
 * `applyAgentIdentity` and `applyRepoInitForAgent` are stubbed via injected
 * `AgentApplyDeps`/`RepoInitStepDeps`; `writeVault`'s `age` call is faked;
 * only `fleet.lock` (a small local JSON file) touches real fs.
 *
 * **Exception (macf#852):** the trailing "REAL age binary" tests below
 * deliberately leave `vaultDeps.encrypt` unset so
 * `writeVault`/`writeAgentRecoveryArtifact` fall through to the real
 * `ageEncryptToFile` — the one place in this file that touches the real
 * `age` binary, gated `skipIf(!HAS_AGE)` (`resolveAgeGate`, see
 * `./age-binary-gate.js`) per `vault-write.test.ts`'s "never fake a passing
 * test" convention. See `age-binary-gate.ts` for why an absent binary WARNS
 * locally and FAILS in CI (groundnuty/macf#963).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFleet, shouldWriteBatchedFleetLock, type FleetApplyDeps, type VaultApplyOutcome } from '../../../src/cli/bootstrap/apply-fleet.js';
import type { FleetAgent, FleetLock, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { parseFleetLock, parseFleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { AgentApplyDeps } from '../../../src/cli/bootstrap/apply-agent.js';
import type { AgentRepoDeps, RepoInitStepDeps } from '../../../src/cli/bootstrap/apply-repo-init.js';
import { repoInit as realRepoInit } from '../../../src/cli/commands/repo-init.js';
import type { RepoInitOptions } from '../../../src/cli/commands/repo-init.js';
import type { ControlRepoDeps } from '../../../src/cli/bootstrap/control-repo.js';
import type { AppCredentials } from '../../../src/cli/bootstrap/manifest-exchange.js';
import type { CaApplyDeps } from '../../../src/cli/bootstrap/apply-ca.js';
import type { RoutingClientApplyDeps } from '../../../src/cli/bootstrap/apply-routing-client.js';
import type { RoutingSecretsPublishDeps } from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import { toBase64ForSecret, ALL_ROUTING_SECRET_NAMES, unpackRoutingBundle } from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import type { RouterAppVaultRestoreDeps } from '../../../src/cli/bootstrap/apply-router-app.js';
import { deriveRouterAppHandle } from '../../../src/cli/bootstrap/apply-router-app.js';
import type { RunnerRegistrationDeps } from '../../../src/cli/bootstrap/apply-routing.js';
import { operatorRecoveryArtifactPath, writeAgentRecoveryArtifact, writeVault } from '../../../src/cli/bootstrap/vault-write.js';
import { parseVaultPlaintext } from '../../../src/cli/bootstrap/vault-read.js';
import { applyExitCode, fleetApplyResultToJson, formatApplyResult } from '../../../src/cli/commands/bootstrap-apply.js';
import { computeArchiveRepoTargets } from '../../../src/cli/bootstrap/teardown.js';
import { resolveAgeGate } from './age-binary-gate.js';

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
    // groundnuty/macf#1082 — `router_app_scope: 'per-fleet'` pins EVERY
    // test in this file to #1074's original ceremony (unchanged handle,
    // unchanged confirm-before-create/create behavior) so this file's ~30
    // existing router-App scenarios stay byte-identical under the new
    // 'shared' default. The dedicated `router-app-scope.test.ts` covers
    // 'shared' scope (the default) on its own manifests.
    transport: { age_recipients: ageRecipients, router_app_scope: 'per-fleet' },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents,
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
    unarchiveRepo: async () => {
      throw new Error('must not be called — this file\'s default control repo is always absent, never ours-archived');
    },
    cloneRepo: async () => {},
    commitAndPush: async () => 'pushed',
  };
}

/**
 * macf#992 — a `commitAndPush` fake that succeeds its FIRST call (step 0's
 * own commit, made by `provisionControlRepo` inside `applyFleet` BEFORE the
 * per-agent loop even starts — see `control-repo.ts::provisionControlRepo`)
 * and throws on every call after that (the FINAL sync at the very end of
 * `applyFleet`, `syncControlRepo`'s call site). Isolates "the push this
 * test is actually about" (the final sync) from step 0's unrelated,
 * always-succeeding commit — a bare always-throwing fake would abort the
 * ENTIRE run at step 0 (`provisionControlRepo` returns `'failed'`) before
 * ever reaching the per-agent loop, which is a different bug shape
 * entirely (see `abortedFleetApplyResult`) from the one macf#992 is about.
 */
function pushSucceedsOnceThenFails(): ControlRepoDeps['commitAndPush'] {
  let calls = 0;
  return async (dir: string, message: string): Promise<'pushed' | 'nothing-to-commit'> => {
    calls += 1;
    if (calls === 1) return controlRepoDepsFor().commitAndPush(dir, message);
    throw new Error('git push rejected — stale token (simulated)');
  };
}

/** Every agent's repo reports `'absent'` -> `ensureAgentRepo` "creates" it (no-op `createRepo`). */
function agentRepoDepsFor(): AgentRepoDeps {
  return { checkMeta: async () => ({ presence: 'absent' }), createRepo: async () => {}, unarchiveRepo: async () => {} };
}

/**
 * DR-043 Amendment D phase 2 (macf#838) — the CA-ceremony + routing-var
 * deps. Default: everything reports `'absent'` (no PRIOR CA / routing var,
 * matching this file's `priorLock: null` / empty-fleet.lock default), so
 * `resolveCaCert` takes the MINT path and every publish leg succeeds — a
 * "happy path" default individual tests override to exercise reuse/failure.
 * `mintCa` returns SENTINEL PEM strings (never real crypto — this file's own
 * "never touch the real filesystem/network beyond fleet.lock" posture, see
 * the module doc) distinct from `creds()`'s agent-credential sentinels so a
 * leak test can tell CA-key leakage apart from agent-credential leakage.
 */
const SENTINEL_CA_KEY_PEM = 'SENTINEL-CA-KEY-PEM';
const SENTINEL_CA_CERT_PEM = 'SENTINEL-CA-CERT-PEM';
/**
 * macf#929 — `baseDeps`'s default `runnerToken`. `trustDepsFor()`'s own
 * default already reports `checkRunnerUsableByRepo` as `'present'`, so a
 * write would succeed with or without this sentinel post-groundnuty/macf#1195
 * (a token no longer gates USE, only WAITING — see `apply-routing.ts`'s
 * top-level #1195 paragraph). Kept as the default anyway so every
 * pre-existing "routing var gets written" fixture in this file stays
 * unambiguous about which code path it exercises (token-supplied poll path,
 * not the separate no-token single-check path) without needing to reason
 * about the newer branch. The dedicated no-token tests below override this
 * to `undefined` explicitly.
 */
const SENTINEL_RUNNER_TOKEN = 'SENTINEL-RUNNER-TOKEN';
/**
 * `checkRunnerUsableByRepo` defaults to `{ presence: 'present' }` (macf#922,
 * org-scope-corrected by macf#924) — every PRE-EXISTING fixture in this file
 * that relies on `trustDepsFor()`'s default to exercise the routing-var
 * WRITE path (not the register-before-route gate specifically) keeps doing
 * so unchanged; the dedicated register-before-route tests below override it
 * explicitly.
 */
function trustDepsFor(overrides: Partial<CaApplyDeps & RunnerRegistrationDeps> = {}): CaApplyDeps & RunnerRegistrationDeps {
  return {
    checkRegistryPresence: async () => 'absent',
    readRegistryVariable: async () => undefined,
    createRegistryVariable: async () => 'created',
    checkRepoPresence: async () => 'absent',
    createRepoVariable: async () => 'created',
    mintCa: async () => ({ certPem: SENTINEL_CA_CERT_PEM, keyPem: SENTINEL_CA_KEY_PEM }),
    checkRunnerUsableByRepo: async () => ({ presence: 'present' }),
    ...overrides,
  };
}

const CODE_AGENT: FleetAgent = { role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/x' };
const SCI_AGENT: FleetAgent = { role: 'science-agent', profile: 'research', repo: 'groundnuty/demo-science', deploy_path: '/y' };
/** groundnuty/macf#1057 — a third agent, used only by the control-repo-init tests (a 2-agent manifest can't distinguish "all declared agents" from "the first N-1"). */
const WRITING_AGENT: FleetAgent = { role: 'writing-agent', profile: 'writing', repo: 'groundnuty/demo-writing', deploy_path: '/z' };

/**
 * groundnuty/macf#1012 — repo-scoped registry install-coverage. A manifest
 * whose `owner.registry.type === 'repo'`; `deriveAppHandle('demo-fleet',
 * 'code-agent')` === 'demo-fleet-code-agent' throughout. Module-scoped (used
 * by BOTH the #1012 describe block and #1016's sibling describe block).
 */
function repoScopedManifest(agents: readonly FleetAgent[] = [CODE_AGENT]): FleetManifest {
  return {
    ...manifestWith(agents),
    owner: { account: 'demo-org', type: 'org', registry: { type: 'repo', owner: 'demo-org', repo: 'demo-org-registry' } },
  };
}

/**
 * groundnuty/macf#1173 — `InstallInterstitialOptions` no longer carries a
 * separate `repos` field; the ONLY repo list an operator ever sees is
 * whatever `messageLines` line starts with `select exactly: ` (or the
 * honest-empty "(no repos declared...)" text — see
 * `apply-agent.ts::gate2DefaultInstructionLines`). Parses that SAME line
 * back into a `readonly string[]` so the #1156 decisive tests below can go
 * on asserting "the repo list the operator was shown" against the live
 * coverage check, reading it from the actual served content instead of an
 * internal field.
 */
function parseSelectExactlyRepos(messageLines: readonly string[]): readonly string[] {
  const line = messageLines.find((l) => l.startsWith('select exactly: '));
  if (line === undefined) return [];
  const rest = line.slice('select exactly: '.length);
  return rest.startsWith('(') ? [] : rest.split(', ');
}

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
    // groundnuty/macf#952 — consent gate 2's own locally-served interstitial.
    startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
    exchangeManifestCode: async () => creds(role),
    // groundnuty/macf#1128 — `repositorySelection: 'selected'` is the
    // well-behaved-operator default this fixture represents: EVERY App
    // type's install now runs through the shared `install-scope.ts` guard
    // (`validateInstall`) — agent Apps, the router App, and runner-ops
    // alike — so a fixture that omitted this field would fail that check
    // for every identity that reaches consent gate 2 through it, not just
    // the one role this call names.
    //
    // Deliberately UNCONDITIONAL (tried, then reverted, a role-scoped
    // variant keyed on `opts.expected.appSlug`): on the CREATE path,
    // `apply-agent.ts::finishGate2FromCredentials` builds `gate2Expected`
    // from the JUST-EXCHANGED credential's OWN `.slug` — and THIS fixture's
    // `exchangeManifestCode` returns `creds(role)` using the role captured
    // in THIS closure regardless of which identity (agent, router,
    // runner-ops) is actually calling it (`FleetApplyDeps.buildAgentDeps`
    // hands every identity the IDENTICAL `AgentApplyDeps` object — see
    // `baseDeps`'s doc). So `opts.expected.appSlug` is `demo-fleet-${role}`
    // for EVERY identity's CREATE poll through this fixture, not just the
    // named role — there is no signal inside `waitForAppInstallation`'s
    // inputs that reliably discriminates "the role under test" from
    // "the router/runner-ops App riding along on the same fixture." A
    // role-scoped condition therefore either fires for every identity
    // (as observed) or none — never selectively. Given that, this fixture
    // now genuinely represents a fleet where EVERY App's install is
    // correctly scoped — which also means the router App's + (when
    // declared) runner-ops's OWN create-or-reuse ceremony now completes
    // successfully through this SAME shared fixture where it used to fail
    // silently (masked by nothing but this same missing field). Tests
    // whose assertions assumed router/runner-ops failed silently were
    // updated to account for their now-real success; tests that want the
    // "all"-scoped refusal override `waitForAppInstallation` explicitly.
    waitForAppInstallation: async () => ({ appId, installId, appSlug: `demo-fleet-${role}`, accountLogin: 'groundnuty', repositorySelection: 'selected' }),
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

/**
 * groundnuty/macf#1221 — a repoInitDeps fixture for tests whose FOCUS is
 * something other than control-repo label creation (CA ceremony,
 * routing-client publish, the six-secret publish) but that use a
 * `reusedAgentDeps()`/`reusedIdentityDeps()`-shaped fixture with a
 * `resolveKeyPath: () => '/fake.pem'` that ALSO happens to satisfy
 * `resolveControlRepoLabelTokenSource`'s role-matching (a prior lock entry
 * for a role the manifest declares). Before #1221 that fixture's fake
 * keyPath was inert for THIS concern (nothing ever tried to mint from it
 * for the control repo); after #1221 it would reach a REAL `repoInit()`
 * label-creation attempt via the resolved (but nonexistent-on-disk, so
 * filtered by `resolveControlRepoLabelTokenSource`'s `exists` guard)
 * tokenSource, landing `labels: {status:'skipped'}` and flipping
 * `applyExitCode` to `2` for tests that never cared about labels at all —
 * exactly the SAME "keep an unrelated concern out of the way" pattern this
 * file already uses for `routingSecretsDepsFor({checkRepoSecretPresence:
 * async () => 'present'})` on the CA-focused test above. Reports every
 * label as already `'ok'` unconditionally, for every repo (agent or
 * control) — a plain, doesn't-care neutral default, never a per-repo
 * discriminator these tests don't need.
 */
const OK_LABELS_REPO_INIT: RepoInitStepDeps = {
  cloneRepo: async () => {},
  commitAndPush: async () => 'pushed',
  repoInit: async () => ({ workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } }),
};

/**
 * DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920 gap 2) fakes.
 * `mint` returns SENTINEL cert/key PEM strings (distinct from
 * `SENTINEL_CA_*`/`creds()`'s sentinels so a leak test can tell them apart);
 * `checkRepoSecretPresence` defaults every repo to `'absent'` (matches
 * `trustDepsFor()`'s CA default — every fresh test run's "steady state" is
 * everything missing, so a MINT this file's default `trustDepsFor` already
 * takes gets a real routing-client mint + publish attempt too, not silently
 * skipped for want of a dep).
 */
const SENTINEL_ROUTING_CLIENT_CERT_PEM = 'SENTINEL-ROUTING-CLIENT-CERT-PEM';
const SENTINEL_ROUTING_CLIENT_KEY_PEM = 'SENTINEL-ROUTING-CLIENT-KEY-PEM';
function routingClientDepsFor(overrides: Partial<RoutingClientApplyDeps> = {}): RoutingClientApplyDeps {
  return {
    mint: async () => ({ certPem: SENTINEL_ROUTING_CLIENT_CERT_PEM, keyPem: SENTINEL_ROUTING_CLIENT_KEY_PEM }),
    ...overrides,
  };
}
const NOOP_ROUTING_CLIENT_DEPS: RoutingClientApplyDeps = routingClientDepsFor();

// groundnuty/macf#1074 — the unified six-secret publish deps (the SAME
// checkRepoSecretPresence/setRepoSecret shape `routingClientDepsFor` used to
// carry, now on its own bag since publish moved out of `RoutingClientApplyDeps`).
function routingSecretsDepsFor(
  overrides: Partial<RoutingSecretsPublishDeps & { readVaultTsOauth?: () => Promise<{ readonly clientId: string; readonly secret: string } | undefined> }> = {},
): RoutingSecretsPublishDeps & { readVaultTsOauth?: () => Promise<{ readonly clientId: string; readonly secret: string } | undefined> } {
  return {
    checkRepoSecretPresence: async () => 'absent',
    setRepoSecret: async () => {},
    ...overrides,
  };
}
const NOOP_ROUTING_SECRETS_DEPS = routingSecretsDepsFor();
const NOOP_ROUTER_APP_VAULT_DEPS: RouterAppVaultRestoreDeps = {};

// --- Real `age` binary support (macf#852 — see the trailing test below) ---
//
// Everything else in this file stubs `vaultDeps.encrypt`, proving the
// ORCHESTRATION (ordering, lock-write gating, artifact lifecycle) but never
// the property this issue is actually about: that `transport.age_recipients`
// being a LIST means `vault.age` decrypts under EITHER key independently,
// not one shared key copied to two machines. `resolveAgeGate`/`HAS_AGE`
// (`./age-binary-gate.js`) gate the two tests that drive `parseFleetManifest`
// → `applyFleet` → the real `age` binary (no `vaultDeps.encrypt` override —
// falls through to `writeVault`'s own `ageEncryptToFile` default). Skipped,
// never faked, when `age`/`age-keygen` are absent from PATH — same
// convention as `vault-write.test.ts`'s `HAS_AGE`; see `age-binary-gate.ts`
// for why an absent binary WARNS locally and FAILS in CI (macf#963).
const HAS_AGE = resolveAgeGate('apply-fleet.test.ts', 3);

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
    // macf#988 belt-and-suspenders (see `vault-write.ts::defaultOperatorRecoveryRootDir`'s
    // doc): `baseDeps` below ALWAYS sets `FleetApplyDeps.recoveryRootDir`
    // explicitly, but a test literal that constructs `FleetApplyDeps` by
    // hand (not spreading `baseDeps`) could forget to. This env override
    // means even THAT test still cannot reach the real operator's
    // `~/.config/macf/recovery` — `applyFleet` never creates or touches
    // anything outside a tracked, per-test tmpdir. `dirs.push` below is the
    // SAME cleanup array every other tmpdir in this file already uses.
    savedEnv['MACF_RECOVERY_DIR'] = process.env['MACF_RECOVERY_DIR'];
    const recoverySafetyDir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-recovery-safety-'));
    dirs.push(recoverySafetyDir);
    process.env['MACF_RECOVERY_DIR'] = recoverySafetyDir;
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const k of ['GH_TOKEN', 'APP_ID', 'INSTALL_ID', 'KEY_PATH', 'MACF_RECOVERY_DIR']) {
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
   *
   * `recoveryRootDir` (macf#988) is ALSO pinned to `dirname(manifestPath)` —
   * the SAME tracked/cleaned-up tmpdir, just no longer nested under
   * `secrets/recovery/` (that nesting was the control-repo-checkout
   * derivation this fix removes). This is the PRIMARY test-safety seam (see
   * the top-of-file `beforeEach`'s `MACF_RECOVERY_DIR` env override for the
   * belt-and-suspenders backstop covering test literals that don't call
   * this helper).
   */
  function baseDeps(agentDeps: AgentApplyDeps, manifestPath: string, repoInitDeps: RepoInitStepDeps = NOOP_REPO_INIT): FleetApplyDeps {
    return {
      buildAgentDeps: () => agentDeps,
      repoInitDeps,
      // macf#988 — `encrypt` MUST create a real file at the path it's given:
      // `writeAgentRecoveryArtifact`'s new atomic-write tail (temp file →
      // chmod 0600 → rename into place) needs something to chmod/rename, the
      // same way a REAL `age -o <path>` invocation always would. A pure
      // no-op (the pre-#988 default here) now throws inside `chmodSync`
      // (ENOENT) for any test that reaches the CREATE path.
      vaultDeps: { exists: () => false, encrypt: async (_plaintext, _recipients, outPath) => writeFileSync(outPath, 'FAKE-CIPHERTEXT') },
      controlRepoDeps: controlRepoDepsFor(),
      agentRepoDeps: agentRepoDepsFor(),
      trustDeps: trustDepsFor(),
      routingClientDeps: NOOP_ROUTING_CLIENT_DEPS,
      routingSecretsDeps: NOOP_ROUTING_SECRETS_DEPS,
      routerAppVaultDeps: NOOP_ROUTER_APP_VAULT_DEPS,
      controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
      recoveryRootDir: join(manifestPath, '..'),
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      log: () => {},
      runnerToken: SENTINEL_RUNNER_TOKEN,
    };
  }

  it('a freshly-created agent: lock is written ONLY after the vault write succeeds, with fingerprints', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    let repoInitCalled = false;
    // groundnuty/macf#920 — the `created` path now threads a `tokenSource`
    // built from `creds()`'s SENTINEL (non-parseable) pem into the REAL
    // `repoInit()`, so `gh token generate` genuinely fails and labels
    // correctly score `status:'failed'` (see `apply-repo-init.test.ts`'s
    // dedicated tokenSource-threading tests for that behavior). THIS test is
    // about lock/vault ordering, not label wiring — fake `repoInit` itself so
    // it doesn't need a real, parseable PEM.
    const repoInitDeps: RepoInitStepDeps = {
      cloneRepo: async () => {
        repoInitCalled = true;
      },
      commitAndPush: async () => 'pushed',
      repoInit: (async () => ({
        workflow: 'created',
        config: 'created',
        labels: { status: 'ok', created: ['code-agent'], existed: [] },
      })) as never,
    };
    const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath, repoInitDeps);

    const result = await applyFleet(manifest, manifestPath, null, deps);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.identity.status).toBe('created');
    expect(result.vault.status).toBe('written');
    expect(repoInitCalled).toBe(true);
    expect(result.agents[0]?.repoInit?.status).toBe('applied');

    expect(existsSync(result.lockPath)).toBe(true);
    const lock: FleetLock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
    // groundnuty/macf#1128 — the router App's create-or-reuse ceremony is
    // UNCONDITIONAL every run (apply-fleet.ts's own doc); it now ALSO
    // succeeds through this shared fixture (repository_selection is
    // satisfied for every App type, not just 'code-agent') and gets its
    // OWN lock entry alongside 'code-agent' — find the entry under test
    // rather than asserting the whole array, so this test stays about
    // ordering/fingerprints for the code-agent, not an incidental census
    // of every identity a real `apply` run also provisions.
    const codeAgentEntry = lock.agents.find((a) => a.role === 'code-agent');
    // groundnuty/macf#1296 — `repo` is now recorded on every `created` role
    // too (`agent.repo`, this run's manifest-declared value), same as the
    // reused/resumed-install path exercised elsewhere in this file.
    expect(codeAgentEntry).toEqual({
      role: 'code-agent',
      app_id: 'app-code-agent',
      install_id: 'install-1',
      repo: 'groundnuty/demo-code',
      fingerprints: expect.any(Object),
    });
    expect(Object.keys(codeAgentEntry?.fingerprints ?? {}).sort()).toEqual(['app_private_key', 'client_secret', 'webhook_secret']);
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

  it('groundnuty/macf#1230 — the checkout-derived lock (not the caller-supplied priorLock) is what the narrowing refusal fires on: a stale/absent priorLock does NOT bypass it', async () => {
    // `commands/bootstrap-apply.ts`'s CLI-level preflight is a FAST PATH: it
    // reads `fleet.lock` from the OPERATOR's local manifest directory, which
    // only reflects the control repo's true state once that local checkout
    // has been `git pull`ed (`observer.ts::readFleetLock`'s own doc). This
    // test simulates the fast path MISSING a narrowing — `priorLock` (what
    // the CLI-level read would have supplied) is `null` — while the control
    // repo's OWN checkout (what `provisionControlRepo`'s clone brings back,
    // written here directly at `dirname(manifestPath)` per this file's
    // `controlRepoOptions.makeScratchDir` convention) still records the
    // wider, TRUE set. `applyFleet`'s own re-derived check (mirrors
    // `checkAppNameLengths`'s existing two-tier shape) must catch this
    // regardless — proving the refusal doesn't depend on the caller having
    // supplied an up-to-date `priorLock`.
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT], ['age1operator']); // declares ONLY age1operator
    const controlRepoLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      age_recipients: ['age1operator', 'age1vm'], // the checkout's TRUE recorded set — age1vm is about to be dropped
    };
    writeFileSync(join(manifestPath, '..', 'fleet.lock'), JSON.stringify(controlRepoLock), 'utf-8');

    let gate1Called = false;
    const agentDeps = agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1');
    const deps = baseDeps(
      {
        ...agentDeps,
        startManifestFlow: async (opts) => {
          gate1Called = true;
          return agentDeps.startManifestFlow(opts);
        },
      },
      manifestPath,
    );

    const result = await applyFleet(manifest, manifestPath, /* priorLock */ null, deps);

    expect(gate1Called).toBe(false);
    expect(result.vault.status).toBe('skipped');
    expect(result.agents).toEqual([]);
    // The control repo itself was successfully provisioned before the
    // abort — distinguishing this from the control-repo-failure abort
    // branch immediately above it in `applyFleet`.
    expect(result.controlRepo.status).toBe('created');
    // The PRE-EXISTING checkout lock is untouched, not rewritten — this run
    // never reached the batched write.
    const onDisk = parseFleetLock(readFileSync(join(manifestPath, '..', 'fleet.lock'), 'utf-8'));
    expect(onDisk.age_recipients).toEqual(['age1operator', 'age1vm']);
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
      startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
      exchangeManifestCode: async () => { throw new Error('must not be called'); },
      resolveKeyPath: () => '/fake.pem',
      confirmAppInstallation: async (appId) =>
        appId === 'app-code-agent'
          ? { status: 'confirmed', install: { appId, installId: 'install-1', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' } }
          : { status: 'app-no-install' },
      // groundnuty/macf#1128 — `repositorySelection: 'selected'`: this
      // agent's own resumed-install now runs through the shared
      // `install-scope.ts` guard too.
      waitForAppInstallation: async (opts) => ({
        appId: opts.appId,
        installId: 'install-2-resumed',
        appSlug: 'demo-fleet-science-agent',
        accountLogin: 'groundnuty',
        repositorySelection: 'selected',
      }),
      openUrl: async () => {},
      log: () => {},
      writeRecoveryArtifact: async () => {}, // overridden by applyFleet regardless — see agentDepsFor's comment
    };

    // CA reported ALREADY PRESENT (reuse path, macf#838 Amendment D phase
    // 2) — this test is about AGENT lock-write timing, not the CA ceremony,
    // so it keeps `vault.status` at 'skipped' the way it did before the CA
    // wiring landed (a fresh mint would otherwise stage vault content even
    // though NO agent needs anything new persisted).
    const deps: FleetApplyDeps = {
      ...baseDeps(agentDeps, manifestPath),
      trustDeps: trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' }),
    };
    const result = await applyFleet(manifest, manifestPath, priorLock, deps);

    expect(result.agents.map((r) => r.identity.status)).toEqual(['reused', 'resumed-install']);
    expect(result.vault.status).toBe('skipped'); // nothing NEW to persist
    expect(result.ca.resolve.status).toBe('reused');
    const lock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
    // groundnuty/macf#1296 STEADY-STATE fixture: NOTHING is minted this run
    // (both roles reused/resumed-install, `vault.status === 'skipped'`) —
    // this is exactly the "a fleet that mints nothing" shape macf#1269's own
    // lesson warns a lock write can be silently gated on. `repo` is recorded
    // here regardless, because `writeIncrementalLock` fires unconditionally
    // on the reused/resumed-install branch (apply-fleet.ts), never gated on
    // `shouldWriteBatchedFleetLock`'s "something new" predicate.
    expect(lock.agents.find((a) => a.role === 'code-agent')).toEqual({
      role: 'code-agent',
      app_id: 'app-code-agent',
      install_id: 'install-1',
      repo: 'groundnuty/demo-code',
    });
    expect(lock.agents.find((a) => a.role === 'science-agent')).toEqual({
      role: 'science-agent',
      app_id: 'app-science-agent',
      install_id: 'install-2-resumed',
      repo: 'groundnuty/demo-science',
    });
  });

  // --- DR-043 §D6 write-back anti-regression (macf#907) ----------------------
  //
  // `apply` NEVER writes `deployed_version` (that's `macf fleet upgrade`'s
  // job — `fleet-lock-recorder.ts` — on a CONFIRMED verify-green). Equally
  // load-bearing: `apply` must never DROP a `deployed_version` a prior
  // `fleet upgrade` roll already recorded — `fleet-lock.ts`'s
  // `composeFleetLock` carry-forward (`?? prev?.deployed_version`) is what
  // protects that; this pins the contract end-to-end THROUGH `applyFleet`,
  // not just at `composeFleetLock`'s own unit level (`fleet-lock.test.ts`).

  it('apply NEVER writes deployed_version: a priorLock with none stays without one after a "reused" run', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    };
    const deps = baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath);

    const result = await applyFleet(manifest, manifestPath, priorLock, deps);

    expect(result.agents[0]?.identity.status).toBe('reused');
    const lock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
    expect(lock.agents.find((a) => a.role === 'code-agent')?.deployed_version).toBeUndefined();
  });

  it('apply NEVER drops a deployed_version a prior `fleet upgrade` roll recorded: preserved verbatim through a "reused" run', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1', deployed_version: '0.2.56' }],
    };
    const deps = baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath);

    const result = await applyFleet(manifest, manifestPath, priorLock, deps);

    expect(result.agents[0]?.identity.status).toBe('reused');
    const lock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
    // Carried forward VERBATIM — `applyFleet` never touches `deployed_version`
    // in either direction; a future author "fixing" apply must not silently
    // clobber what `fleet upgrade` already recorded.
    expect(lock.agents.find((a) => a.role === 'code-agent')?.deployed_version).toBe('0.2.56');
  });

  it('tags each agent\'s log lines with "[agent N/M]" progress context on a multi-agent fleet (consent-gate UX fix)', async () => {
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
    const agentDeps: AgentApplyDeps = {
      startManifestFlow: async () => { throw new Error('must not be called — both roles have prior entries'); },
      startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
      exchangeManifestCode: async () => { throw new Error('must not be called'); },
      resolveKeyPath: () => '/fake.pem',
      confirmAppInstallation: async (appId) =>
        appId === 'app-code-agent'
          ? { status: 'confirmed', install: { appId, installId: 'install-1', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' } }
          : { status: 'app-no-install' },
      // groundnuty/macf#1128 — `repositorySelection: 'selected'`.
      waitForAppInstallation: async (opts) => ({
        appId: opts.appId,
        installId: 'install-2-resumed',
        appSlug: 'demo-fleet-science-agent',
        accountLogin: 'groundnuty',
        repositorySelection: 'selected',
      }),
      openUrl: async () => {},
      log: () => {},
      writeRecoveryArtifact: async () => {},
    };
    const logs: string[] = [];
    const deps: FleetApplyDeps = {
      ...baseDeps(agentDeps, manifestPath),
      trustDeps: trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' }),
      log: (l) => logs.push(l),
    };
    const result = await applyFleet(manifest, manifestPath, priorLock, deps);
    expect(result.agents.map((r) => r.identity.status)).toEqual(['reused', 'resumed-install']);

    // "Role \"code-agent\": ..." lines come from BOTH this module's own
    // per-agent log calls AND applyAgentIdentity's (via agentDeps.log,
    // wired through the SAME wrapped log per macf's consent-gate UX fix).
    const codeLines = logs.filter((l) => l.includes('"code-agent"'));
    const sciLines = logs.filter((l) => l.includes('"science-agent"'));
    expect(codeLines.length).toBeGreaterThan(0);
    expect(sciLines.length).toBeGreaterThan(0);
    expect(codeLines.every((l) => l.startsWith('[agent 1/2] '))).toBe(true);
    expect(sciLines.every((l) => l.startsWith('[agent 2/2] '))).toBe(true);
  });

  it('does NOT tag log lines with progress context on a single-agent fleet (no ambiguity to resolve)', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const logs: string[] = [];
    const deps: FleetApplyDeps = {
      ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
      log: (l) => logs.push(l),
    };
    await applyFleet(manifest, manifestPath, null, deps);
    expect(logs.some((l) => l.startsWith('[agent'))).toBe(false);
  });

  it('skipped-unverified / drift: no lock write, no repo-init', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    // groundnuty/macf#1128 — a 'router' entry too (see `REUSE_PRIOR_LOCK`'s
    // doc, same reasoning): without it, the router's OWN unconditional
    // create-or-reuse ceremony reaches CREATE (no prior entry) and now
    // genuinely succeeds through this shared fixture, minting something new
    // and breaking this test's "vault stays skipped" claim.
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'router', app_id: 'app-router', install_id: 'install-r' },
      ],
    };
    // No resolveKeyPath -> guard resolves skip-unverified. CA reported
    // ALREADY PRESENT (reuse path) for the same reason as the test above —
    // this test is about the AGENT skip path, not the CA ceremony.
    const deps: FleetApplyDeps = {
      ...baseDeps(agentDepsFor('code-agent', 'skipped-unverified', 'x', 'y'), manifestPath),
      trustDeps: trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' }),
    };
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
      startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
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
    // groundnuty/macf#1083 — self-hosted DECLARED so the runner-ops App is
    // still needed and this test keeps exercising its recovery-artifact
    // ordering alongside the router App's, per the comment on the
    // `encryptCalls` assertion below.
    const manifest: FleetManifest = { ...manifestWith([CODE_AGENT, SCI_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' }],
    };
    const encryptCalls: { plaintext: string; outPath: string }[] = [];
    // groundnuty/macf#1128 — `exchangeManifestCode` here is role-blind
    // (always `creds('code-agent')`, like every hand-rolled fixture in this
    // file — see `agentDepsFor`'s doc for why), so `waitForAppInstallation`
    // cannot discriminate "which identity is this poll for" from `opts`
    // alone: `opts.expected.appSlug` is `demo-fleet-code-agent` for EVERY
    // identity that reaches CREATE through this fixture (code-agent,
    // runner-ops, router — apply-fleet.ts processes them in that fixed
    // order). A CALL COUNTER is the only reliable discriminator available:
    // the FIRST call is code-agent's own poll (must succeed, this test's
    // whole point); the SECOND and THIRD are runner-ops's and the router
    // App's (must still fail, so this test keeps exercising the
    // recovery-artifact-on-gate-2-rejection path the comment below
    // documents — the exact reason this fixture predates #1128 at all).
    let installPollCount = 0;
    const agentDeps: AgentApplyDeps = {
      startManifestFlow: async () => ({ startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} }),
      startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
      exchangeManifestCode: async () => creds('code-agent'),
      resolveKeyPath: () => '/fake.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: { appId: 'app-science-agent', installId: 'install-2', appSlug: 'demo-fleet-science-agent', accountLogin: 'groundnuty' } }),
      waitForAppInstallation: async (opts) => {
        installPollCount += 1;
        return {
          appId: opts.appId,
          installId: 'install-1',
          appSlug: 'demo-fleet-code-agent',
          accountLogin: 'groundnuty',
          ...(installPollCount === 1 ? { repositorySelection: 'selected' } : {}),
        };
      },
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
          // macf#988 — must create a real file: `writeAgentRecoveryArtifact`'s
          // atomic-write tail chmods + renames whatever `encrypt` wrote.
          writeFileSync(outPath, 'FAKE-CIPHERTEXT');
        },
      },
    };

    const result = await applyFleet(manifest, manifestPath, priorLock, deps);

    expect(result.vault.status).toBe('written');
    // FOUR encrypt calls now (groundnuty/macf#943 added the third, #1074
    // added the fourth): the pre-gate-2 recovery artifact for 'code-agent'
    // (DR-043 §D5 durable-before-gate-2) fires first (inside the per-agent
    // loop), THEN the runner-ops's OWN recovery artifact (it also takes the
    // no-prior-lock-entry CREATE path via this same shared `agentDeps`
    // fixture — see `apply-fleet.ts`'s "runner-ops" step, which runs
    // right after the per-agent loop), THEN the router App's OWN recovery
    // artifact (SAME shared fixture, SAME CREATE path, runs right after
    // runner-ops), THEN the batched final vault — asserted by ORDER, not
    // just presence, so this doesn't just infer the sequencing from the
    // loop structure. Both the runner-ops's AND the router App's OWN
    // identities end up 'failed' (`waitForAppInstallation` above only
    // returns `repositorySelection: 'selected'` on its FIRST call —
    // code-agent's own poll; the shared `install-scope.ts` guard rejects
    // the second and third, groundnuty/macf#1128), so NEITHER contributes a
    // lock/vault entry — only their recovery artifacts, exactly like a
    // `created`-then-gate-2-failed agent would (see `apply-agent.ts`'s
    // "gate 1→2 window" doc).
    expect(encryptCalls).toHaveLength(4);
    // macf#988: `encrypt` is called with a TEMP sibling for a recovery
    // write (atomic-write tail — see `writeAgentRecoveryArtifact`'s doc),
    // never for the final vault write — `.tmp-` is now the discriminator
    // (recovery paths no longer contain the literal word "recovery"; see
    // `operatorRecoveryArtifactPath`'s new `<recoveryRootDir>/<fleet>/<role>.age` shape).
    expect(encryptCalls.map((c) => c.outPath.includes('.tmp-'))).toEqual([true, true, true, false]);
    const recoveryCalls = encryptCalls.filter((c) => c.outPath.includes('.tmp-'));
    const finalVaultCall = encryptCalls.find((c) => !c.outPath.includes('.tmp-'));
    const codeAgentRecoveryCall = recoveryCalls.find((c) => c.outPath.includes('code-agent'));
    const runnerOpsRecoveryCall = recoveryCalls.find((c) => c.outPath.includes('runner-ops'));
    const routerRecoveryCall = recoveryCalls.find((c) => c.outPath.includes('.router.age'));
    expect(codeAgentRecoveryCall?.outPath).toMatch(/demo-fleet[/\\]\.code-agent\.age\.tmp-/);
    expect(codeAgentRecoveryCall?.plaintext).toContain('MACF_RECOVERY_CODE_AGENT_APP_ID');
    expect(runnerOpsRecoveryCall?.outPath).toMatch(/demo-fleet[/\\]\.runner-ops\.age\.tmp-/);
    expect(routerRecoveryCall?.outPath).toMatch(/demo-fleet[/\\]\.router\.age\.tmp-/);
    expect(finalVaultCall?.plaintext).toContain('CODE_AGENT'); // the freshly-created agent's segment
    expect(finalVaultCall?.plaintext).not.toContain('SCIENCE_AGENT_CLIENT_SECRET'); // reused agent contributes NO fresh secret
    expect(finalVaultCall?.plaintext).not.toContain('MACF_RUNNER_OPS_'); // failed gate-2 -> never folded into the final vault
    expect(finalVaultCall?.plaintext).not.toContain('MACF_ROUTING_APP_'); // failed gate-2 -> never folded into the final vault

    const lock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
    // The runner-ops's FAILED identity never gets a lock entry (only
    // `created`/`reused`/`resumed-install` do) — `lock.agents` stays exactly
    // the two coordination agents, unchanged by groundnuty/macf#943.
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

    // macf#988 — <recoveryRootDir>/<fleet>/<role>.age, NOT under `secrets/recovery/`
    // (that nesting was the per-run control-repo-checkout derivation this
    // fix removes — see `baseDeps`'s doc for why `recoveryRootDir` here is
    // the SAME `dirname(manifestPath)` this file's OTHER paths already use).
    const recoveryPath = join(join(manifestPath, '..'), 'demo-fleet', 'code-agent.age');
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
          // macf#988 — a recovery write always goes through a TEMP sibling
          // (`writeAgentRecoveryArtifact`'s atomic-write tail); `.tmp-` is
          // now the discriminator (the temp path no longer contains the
          // literal word "recovery" — see `operatorRecoveryArtifactPath`'s
          // new `<recoveryRootDir>/<fleet>/<role>.age` shape).
          if (outPath.includes('.tmp-')) {
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

    // macf#988 — <recoveryRootDir>/<fleet>/<role>.age, NOT under `secrets/recovery/`
    // (that nesting was the per-run control-repo-checkout derivation this
    // fix removes — see `baseDeps`'s doc for why `recoveryRootDir` here is
    // the SAME `dirname(manifestPath)` this file's OTHER paths already use).
    const recoveryPath = join(join(manifestPath, '..'), 'demo-fleet', 'code-agent.age');
    const result = await applyFleet(manifest, manifestPath, null, realDeps);

    expect(result.vault.status).toBe('failed');
    expect(result.agents[0]?.identity.status).toBe('created'); // gate 1 + gate 2 both succeeded — only the batched compose failed
    // The recovery artifact is the ONLY durable copy of this credential
    // right now — it MUST still be on disk:
    expect(existsSync(recoveryPath)).toBe(true);
    // No lock entry either (the vault-before-lock invariant — see module doc):
    expect(existsSync(result.lockPath)).toBe(false);
  });

  // --- macf#992 — delete-timing fix: the artifact must survive a PUSH
  // failure, not just a COMPOSE failure (the case above). The batched vault
  // compose can succeed entirely LOCALLY (inside this run's per-process
  // `mkdtemp` checkout) while the subsequent `syncControlRepo` push fails
  // for an entirely ordinary reason (expired 1-hour bot token, network
  // blip, branch-protection rejection, a concurrent push). Pre-#992, the
  // delete fired the moment the LOCAL compose succeeded — before the push
  // was even attempted — so this exact window silently destroyed the
  // artifact while the vault it insured was durable nowhere but the
  // about-to-be-discarded checkout.

  it('THE DECISIVE macf#992 TEST: vault compose succeeds LOCALLY but the control-repo PUSH fails — the recovery artifact is RETAINED (not deleted), its path is named LOUDLY in the log, and the run reports a non-zero exit code', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);
    const logs: string[] = [];
    const deps: FleetApplyDeps = {
      ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
      vaultDeps: {
        exists: () => false,
        encrypt: async (plaintext, _recipients, outPath) => writeFileSync(outPath, `FAKE-AGE-CIPHERTEXT\n${plaintext.length.toString()}`),
      },
      controlRepoDeps: {
        ...controlRepoDepsFor(),
        // A boring, realistic push failure — NOT a crash, NOT a corrupted
        // checkout. The task brief is explicit that this is the likelier
        // trigger than an exotic process kill. `provisionControlRepo` (step
        // 0) makes its OWN `commitAndPush` call for the initial
        // `fleet.yaml` commit BEFORE the per-agent loop even starts — that
        // first call must keep succeeding (this test is about the FINAL
        // sync at the end of the run, not step 0), so only the SECOND call
        // onward fails.
        commitAndPush: pushSucceedsOnceThenFails(),
      },
      buildAgentDeps: (log) => ({ ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), log }),
      log: (l) => logs.push(l),
    };

    const recoveryPath = operatorRecoveryArtifactPath(join(manifestPath, '..'), 'demo-fleet', 'code-agent');
    const result = await applyFleet(manifest, manifestPath, null, deps);

    // The local compose DID succeed — this is exactly the state the bug
    // fired from pre-#992 (deletion used to happen right here, before any
    // push was even attempted).
    expect(result.vault.status).toBe('written');
    expect(result.agents[0]?.identity.status).toBe('created');

    // The push itself failed — LOUD, not silent. `applyExitCode` /
    // `formatControlRepoSyncLine` already carry this contract from #857;
    // this pins that #992 doesn't regress it (task requirement 3: "a push
    // failure must be loud and non-zero-exit, the same standard #990 set
    // for a vault-write failure").
    expect(result.controlRepoSync.status).toBe('failed');
    if (result.controlRepoSync.status === 'failed') {
      expect(result.controlRepoSync.reason).toContain('git push rejected');
    }
    expect(applyExitCode(result)).toBe(1);

    // THE DECISIVE ASSERTION — the artifact SURVIVES a push failure that
    // arrives AFTER a successful local compose. A happy-path test proves
    // nothing about this: delete-timing IS the entire property.
    expect(existsSync(recoveryPath)).toBe(true);

    // Retention is LOUD, not silent (task requirement 2) — an operator
    // reading the transcript finds the exact path and is told a re-run
    // recovers automatically, without needing to decrypt anything first.
    const retentionLine = logs.find((l) => l.includes('RETAINED') && l.includes(recoveryPath));
    expect(retentionLine).toBeDefined();
    expect(retentionLine).toMatch(/re-run/i);

    // No credential value anywhere in the transcript — retention logging
    // must never leak what it's protecting.
    const joined = logs.join('\n');
    expect(joined).not.toContain('SENTINEL-SECRET-code-agent');
    expect(joined).not.toContain('SENTINEL-HOOK-code-agent');
    expect(joined).not.toContain('SENTINEL-PEM-code-agent');
  });

  it('a recovery artifact retained after a push failure is CONSUMED by the NEXT apply — no new App is created, gate 1 is never re-attempted for that role (macf#992 closes the loop macf#991 opened)', async () => {
    const manifestPath = manifestPathIn();
    const manifest = manifestWith([CODE_AGENT]);

    // Operator-scoped recovery root — STABLE across runs (production shape:
    // `~/.config/macf/recovery/<fleet>/`), independent of either run's OWN
    // per-process control-repo checkout below.
    const recoveryRootDir = mkdtempSync(join(tmpdir(), 'macf-992-recovery-root-'));
    dirs.push(recoveryRootDir);

    // Fake `age` as an IDENTITY transform (write plaintext verbatim, read it
    // back verbatim) — this test's property is ORCHESTRATION (does a SECOND
    // run find + consume a retained artifact, skip gate 1, mint no new App),
    // not the cryptographic round-trip — that property is already proven
    // with the REAL `age` binary by "THE DECISIVE CRASH-RECOVERY TEST" below
    // (macf#988). Per the task brief, real `age` is reserved for tests whose
    // property IS cryptographic; this one is not.
    const identityKeyPath = '/fake-identity-key';
    const fakeVaultDeps: FleetApplyDeps['vaultDeps'] = {
      exists: () => false,
      encrypt: async (plaintext, _recipients, outPath) => writeFileSync(outPath, plaintext),
    };

    // --- Run 1: gate 1 + gate 2 both succeed for 'code-agent', the batched
    // vault compose succeeds LOCALLY, but the control-repo PUSH fails —
    // exactly the state the decisive test above establishes in isolation. ---
    const checkoutDir1 = mkdtempSync(join(tmpdir(), 'macf-992-checkout1-'));
    dirs.push(checkoutDir1);
    const run1Deps: FleetApplyDeps = {
      ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
      vaultDeps: fakeVaultDeps,
      controlRepoOptions: { makeScratchDir: () => checkoutDir1 },
      recoveryRootDir,
      // Same "step-0 commit succeeds, FINAL sync fails" shape as the
      // decisive test above — `provisionControlRepo` makes its own
      // `commitAndPush` call before the per-agent loop even starts.
      controlRepoDeps: { ...controlRepoDepsFor(), commitAndPush: pushSucceedsOnceThenFails() },
    };
    const result1 = await applyFleet(manifest, manifestPath, null, run1Deps);
    expect(result1.controlRepoSync.status).toBe('failed');
    const recoveryPath = operatorRecoveryArtifactPath(recoveryRootDir, 'demo-fleet', 'code-agent');
    expect(existsSync(recoveryPath)).toBe(true); // retained — re-verifies run 1 alone reaches the same state as the decisive test above

    // --- Run 2: a FRESH apply — a NEW checkout (simulating a fresh clone of
    // `<fleet>-control`, which never received run 1's failed push, so it
    // carries NO entry for 'code-agent'), `priorLock: null` (the exact
    // "post-push-failure" starting state a real re-run would have). ---
    const checkoutDir2 = mkdtempSync(join(tmpdir(), 'macf-992-checkout2-'));
    dirs.push(checkoutDir2);
    let gate1Called = false;
    const collisionCalls: string[] = [];
    const agentDeps: AgentApplyDeps = {
      startManifestFlow: async () => {
        gate1Called = true;
        throw new Error('must not be called — a found + decrypted recovery artifact resumes straight at gate 2');
      },
      startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
      exchangeManifestCode: async () => {
        throw new Error('must not be called — no fresh App exchange for a recovered role');
      },
      waitForAppInstallation: async (opts) => ({
        appId: opts.appId,
        installId: 'install-recovered',
        appSlug: opts.expected.appSlug ?? '',
        accountLogin: 'groundnuty',
        repositorySelection: 'selected',
      }),
      confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
      // Would REFUSE 'code-agent' before gate 1 if the collision pre-flight
      // were ever reached — proves the recovery-consume check runs BEFORE
      // it, not just before gate 1 itself (same shape as macf#988's own
      // decisive test below).
      checkAppNameCollision: async (_owner, appSlug) => {
        collisionCalls.push(appSlug);
        return 'present';
      },
      openUrl: async () => {},
      log: () => {},
      writeRecoveryArtifact: async () => {}, // overridden by applyFleet regardless
    };
    const run2Deps: FleetApplyDeps = {
      ...baseDeps(agentDeps, manifestPath),
      vaultDeps: fakeVaultDeps,
      controlRepoOptions: { makeScratchDir: () => checkoutDir2 },
      recoveryRootDir,
      // macf#991's consume path (`readRecoveryArtifact`) — `decrypt` reads
      // back the SAME plaintext `fakeVaultDeps.encrypt` wrote verbatim above.
      recoveryReadDeps: { decrypt: async (path: string) => readFileSync(path, 'utf-8') },
      identityKeyPath,
    };

    const result2 = await applyFleet(manifest, manifestPath, null, run2Deps);

    // gate 1 (and the collision pre-flight it would otherwise hit) NEVER
    // fired for the recovered role.
    expect(gate1Called).toBe(false);
    expect(collisionCalls).not.toContain('demo-fleet-code-agent');

    // The RECOVERED credential (run 1's `app-code-agent`, not a freshly
    // minted one) reached the vault — proves the artifact retained by the
    // push failure still satisfies macf#991's consume path end to end.
    const rec = result2.agents.find((a) => a.role === 'code-agent');
    expect(rec?.identity.status).toBe('created');
    if (rec?.identity.status === 'created') {
      expect(rec.identity.appId).toBe('app-code-agent');
    }
    expect(result2.vault.status).toBe('written');

    // Run 2 uses `baseDeps`'s default `commitAndPush` ('pushed' — a normal,
    // successful re-run), so the now-redundant insurance copy is deleted —
    // closing the full lifecycle in one test: retained-across-a-failed-push
    // → consumed-on-retry → durable-in-the-vault → deleted (never
    // accumulates on disk across repeated retries).
    expect(result2.controlRepoSync.status).toBe('pushed');
    expect(existsSync(recoveryPath)).toBe(false);
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

    // macf#988 — <recoveryRootDir>/<fleet>/<role>.age, NOT under `secrets/recovery/`
    // (that nesting was the per-run control-repo-checkout derivation this
    // fix removes — see `baseDeps`'s doc for why `recoveryRootDir` here is
    // the SAME `dirname(manifestPath)` this file's OTHER paths already use).
    const recoveryPath = join(join(manifestPath, '..'), 'demo-fleet', 'code-agent.age');
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

    // macf#988 — <recoveryRootDir>/<fleet>/<role>.age, NOT under `secrets/recovery/`
    // (that nesting was the per-run control-repo-checkout derivation this
    // fix removes — see `baseDeps`'s doc for why `recoveryRootDir` here is
    // the SAME `dirname(manifestPath)` this file's OTHER paths already use).
    const recoveryPath = join(join(manifestPath, '..'), 'demo-fleet', 'code-agent.age');
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
`;
      const manifest = parseFleetManifest(fleetYaml);
      expect(manifest.transport.age_recipients).toEqual([operatorKey.publicKey, vmKey.publicKey]);

      const deps: FleetApplyDeps = {
        buildAgentDeps: () => agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
        repoInitDeps: NOOP_REPO_INIT,
        vaultDeps: { exists: () => false }, // no `encrypt` override — real `age` runs
        controlRepoDeps: controlRepoDepsFor(),
        agentRepoDeps: agentRepoDepsFor(),
        trustDeps: trustDepsFor(),
        routingClientDeps: NOOP_ROUTING_CLIENT_DEPS,
        routingSecretsDeps: NOOP_ROUTING_SECRETS_DEPS,
        routerAppVaultDeps: NOOP_ROUTER_APP_VAULT_DEPS,
        controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
        // macf#988 — this test reaches `status: 'created'` with NO
        // `recoveryRootDir` override would default to the REAL operator's
        // `~/.config/macf/recovery` (this test's `deps` is hand-built, not
        // spread from `baseDeps`) — pin it to the SAME tracked tmpdir every
        // other path in this test already uses.
        recoveryRootDir: join(manifestPath, '..'),
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

  // --- macf#988 — THE DECISIVE crash-recovery test (DR-043 Amendment B) ---

  it.skipIf(!HAS_AGE)(
    'THE DECISIVE CRASH-RECOVERY TEST: a recovery artifact staged by an ABANDONED prior run (killed between App ' +
      'creation and vault compose) is found + consumed by a FRESH apply — the credential reaches the vault WITHOUT ' +
      "gate 1 (or the collision-refusal it would otherwise hit) EVER firing again for that role — and no NEW App is created",
    async () => {
      const manifestPath = manifestPathIn();
      // Deliberately a SEPARATE tmpdir from the control-repo checkout
      // (`dirname(manifestPath)`) — the whole point of macf#988 is that the
      // recovery artifact survives OUTSIDE whatever directory a run's own
      // checkout happens to be, so this test proves the CONSUME side reads
      // from a genuinely independent, durable location.
      const recoveryRootDir = mkdtempSync(join(tmpdir(), 'macf-crash-recovery-root-'));
      dirs.push(recoveryRootDir);
      const operatorKey = mintAgeKey(recoveryRootDir, 'operator-key.txt');
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT], [operatorKey.publicKey]);

      // --- Step 1: simulate the ABANDONED prior run ---
      // Gate 1 succeeded for 'code-agent' — a REAL App was created on
      // GitHub, its credential durably recorded (DR-043 Amendment B,
      // "durable before gate 2") — then the PROCESS ITSELF was lost before
      // the batched vault compose ever ran (so NO fleet.lock entry exists
      // for this role — a lock entry requires a successful compose). There
      // is no clean way to simulate a SIGKILL through async/await; calling
      // `writeAgentRecoveryArtifact` directly — the exact primitive
      // `apply-agent.ts` invokes right after gate 1 — stages the ONE
      // observable trace a real crash leaves behind: the artifact's
      // presence on disk. This deliberately does NOT go through
      // `applyFleet` at all for "run 1".
      const ABANDONED_CREDS: AppCredentials = {
        appId: 'abandoned-app-id',
        name: 'demo-fleet-code-agent',
        slug: 'demo-fleet-code-agent',
        clientId: 'Iv1.abandoned',
        clientSecret: 'SENTINEL-ABANDONED-CLIENT-SECRET',
        webhookSecret: 'SENTINEL-ABANDONED-WEBHOOK-SECRET',
        pem: '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL-ABANDONED-PEM\n-----END RSA PRIVATE KEY-----\n',
      };
      const artifactPath = operatorRecoveryArtifactPath(recoveryRootDir, 'demo-fleet', 'code-agent');
      await writeAgentRecoveryArtifact('code-agent', ABANDONED_CREDS, [operatorKey.publicKey], artifactPath);
      expect(existsSync(artifactPath)).toBe(true);
      // 0600 + genuinely encrypted (age magic bytes) — proof this "abandoned
      // run" artifact is exactly as durable/secure as a live one.
      const artifactBytes = readFileSync(artifactPath);
      expect(artifactBytes.toString('utf-8').startsWith('age-encryption.org/v1')).toBe(true);

      // --- Step 2: a FRESH apply, priorLock === null (no fleet.lock entry
      // exists ANYWHERE for either role — exactly the post-crash state). ---
      const gate1Calls: string[] = [];
      const collisionCalls: string[] = [];
      const agentDeps: AgentApplyDeps = {
        startManifestFlow: async (opts) => {
          gate1Calls.push(opts.buildManifest('http://x/callback').name);
          return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} };
        },
        startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
        exchangeManifestCode: async () => creds('science-agent'), // only a role WITHOUT a recovery artifact ever reaches this
        waitForAppInstallation: async (opts) => ({
          appId: opts.appId,
          installId: 'install-x',
          appSlug: opts.expected.appSlug ?? '',
          accountLogin: 'groundnuty',
          repositorySelection: 'selected',
        }),
        confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
        // Would REFUSE code-agent before gate 1 if ever reached — the exact
        // macf#988 reproduction shape ("REFUSED before consent gate 1 —
        // already exists but is not in this fleet's vault"). Proves the
        // recovery-consume check runs BEFORE this pre-flight, not just
        // before gate 1 itself.
        checkAppNameCollision: async (_owner, appSlug) => {
          collisionCalls.push(appSlug);
          return 'present';
        },
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {}, // overridden by applyFleet regardless — see agentDepsFor's comment
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDeps, manifestPath),
        // No `encrypt` override — the FINAL vault is REAL `age`-encrypted
        // (unlike `baseDeps`'s own fake) so this test can decrypt it with
        // the operator's REAL key below and prove the recovered credential
        // genuinely round-tripped, not merely that orchestration ran.
        vaultDeps: { exists: () => false },
        recoveryRootDir,
        identityKeyPath: operatorKey.keyPath,
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      // THE DECISIVE ASSERTION — code-agent's gate 1 (and the collision
      // pre-flight that would otherwise refuse it) were NEVER invoked.
      // (science-agent legitimately DOES reach both — it has no staged
      // recovery artifact — so this checks the ABSENCE of one specific
      // name, not "neither seam fired at all this run.")
      expect(gate1Calls).not.toContain('demo-fleet-code-agent');
      expect(collisionCalls).not.toContain('demo-fleet-code-agent');

      // The RECOVERED credential (not a freshly-minted one) reached the vault.
      const codeAgentRecord = result.agents.find((a) => a.role === 'code-agent');
      expect(codeAgentRecord?.identity.status).toBe('created');
      if (codeAgentRecord?.identity.status === 'created') {
        expect(codeAgentRecord.identity.appId).toBe(ABANDONED_CREDS.appId);
      }
      expect(result.vault.status).toBe('written');
      if (result.vault.status === 'written') {
        const d = spawnSync('age', ['-d', '-i', operatorKey.keyPath, result.vault.path], { encoding: 'utf-8' });
        expect(d.status, d.stderr).toBe(0);
        expect(d.stdout).toContain("MACF_AGENT_DEMO_FLEET_CODE_AGENT_APP_ID='abandoned-app-id'");
        expect(d.stdout).toContain('MACF_AGENT_DEMO_FLEET_CODE_AGENT_PRIVATE_KEY_B64=');
      }

      // fleet.lock now carries a REAL entry for the recovered role.
      const lock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
      expect(lock.agents.find((a) => a.role === 'code-agent')?.app_id).toBe('abandoned-app-id');

      // Successful compose deletes the now-redundant recovery artifact —
      // its credential has a durable home in the vault of record now.
      expect(existsSync(artifactPath)).toBe(false);
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
      startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
      exchangeManifestCode: async (code) => creds(code.replace('code-for-', '')),
      waitForAppInstallation: async (opts) => {
        const role = (opts.expected.appSlug ?? '').replace(`${fleetName}-`, '');
        calls.push(`gate2:${role}`);
        // groundnuty/macf#1128 — `repositorySelection: 'selected'`: unlike
        // `agentDepsFor`'s shared fixture (see its doc), THIS fixture is
        // genuinely role-aware (`opts.expected.appSlug` is the REAL
        // per-identity handle, not a role-blind shared credential), so an
        // unconditional 'selected' here is correct for every identity that
        // reaches gate 2 through it — agents, router, runner-ops alike.
        return { appId: opts.appId, installId: `install-${role}`, appSlug: opts.expected.appSlug ?? '', accountLogin: 'groundnuty', repositorySelection: 'selected' };
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
      unarchiveRepo: async () => {
        throw new Error('must not be called — this test\'s control repo is always absent, never ours-archived');
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
      checkMeta: async (repo) => {
        calls.push(`repo:checkExists:${repo}`);
        return { presence: 'absent' };
      },
      createRepo: async (repo) => {
        calls.push(`repo:create:${repo}`);
      },
      unarchiveRepo: async () => {},
    };
    const trustDeps: CaApplyDeps & RunnerRegistrationDeps = {
      ...trustDepsFor(),
      checkRegistryPresence: async () => {
        calls.push('ca:checkRegistryPresence');
        return 'absent';
      },
      createRegistryVariable: async () => {
        calls.push('ca:createRegistryVariable');
        return 'created';
      },
      checkRepoPresence: async (repo) => {
        calls.push(`repoVar:checkPresence:${repo}`);
        return 'absent';
      },
      createRepoVariable: async (repo) => {
        calls.push(`repoVar:create:${repo}`);
        return 'created';
      },
    };
    const deps: FleetApplyDeps = {
      buildAgentDeps: () => roleTrackingAgentDeps('demo-fleet', calls),
      repoInitDeps: { cloneRepo: async () => {}, commitAndPush: async () => 'pushed' },
      // macf#988 — must write a real file (see `baseDeps`'s identical comment).
      vaultDeps: { exists: () => false, encrypt: async (_plaintext, _recipients, outPath) => writeFileSync(outPath, 'FAKE-CIPHERTEXT') },
      controlRepoDeps,
      agentRepoDeps,
      trustDeps,
      routingClientDeps: NOOP_ROUTING_CLIENT_DEPS,
      routingSecretsDeps: NOOP_ROUTING_SECRETS_DEPS,
      routerAppVaultDeps: NOOP_ROUTER_APP_VAULT_DEPS,
      controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
      // macf#988 — see the "REAL age binary" test's identical comment above.
      recoveryRootDir: join(manifestPath, '..'),
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      log: () => {},
    };

    const result = await applyFleet(manifest, manifestPath, null, deps);

    expect(result.agents.map((r) => r.identity.status)).toEqual(['created', 'created']);

    // DR-043 Amendment D phase 2 (macf#838) — the CA/routing sweep runs
    // AFTER both agents are FULLY processed (both repos ensured, both
    // gate 1 + gate 2 complete) and BEFORE the final control-repo sync — the
    // ordering rule that keeps a fresh mint's PUBLIC cert from publishing
    // before its key is durable (see `apply-fleet.ts`'s doc). This manifest
    // declares no `routing:`, so only the CA legs fire here.
    const gate2SciIdxForCa = calls.indexOf('gate2:science-agent');
    const caRegistryCreateIdx = calls.indexOf('ca:createRegistryVariable');
    const caRepoCreateCodeIdx = calls.indexOf('repoVar:create:groundnuty/demo-code');
    const caRepoCreateSciIdx = calls.indexOf('repoVar:create:groundnuty/demo-science');
    const finalCommitAndPushIdx = calls.lastIndexOf('control:commitAndPush');
    expect(caRegistryCreateIdx).toBeGreaterThan(gate2SciIdxForCa);
    expect(caRepoCreateCodeIdx).toBeGreaterThan(gate2SciIdxForCa);
    expect(caRepoCreateSciIdx).toBeGreaterThan(gate2SciIdxForCa);
    expect(caRegistryCreateIdx).toBeLessThan(finalCommitAndPushIdx);

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
    const agentRepoDeps: AgentRepoDeps = { checkMeta: vi.fn(), createRepo: vi.fn(), unarchiveRepo: vi.fn() };
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
      trustDeps: {
        checkRegistryPresence: async () => {
          throw new Error('must not be called — control repo aborted before the CA ceremony');
        },
        readRegistryVariable: async () => {
          throw new Error('must not be called');
        },
        createRegistryVariable: async () => {
          throw new Error('must not be called');
        },
        checkRepoPresence: async () => {
          throw new Error('must not be called');
        },
        createRepoVariable: async () => {
          throw new Error('must not be called');
        },
        mintCa: async () => {
          throw new Error('must not be called — foreign control repo, CA is never minted');
        },
        checkRunnerUsableByRepo: async () => {
          throw new Error('must not be called');
        },
      },
      routingClientDeps: {
        mint: async () => {
          throw new Error('must not be called — foreign control repo, routing-client is never minted');
        },
      },
      routingSecretsDeps: {
        checkRepoSecretPresence: async () => {
          throw new Error('must not be called');
        },
        setRepoSecret: async () => {
          throw new Error('must not be called');
        },
      },
      routerAppVaultDeps: {},
      now: () => new Date('2026-08-11T00:00:00.000Z'),
      log: () => {},
    };

    const result = await applyFleet(manifest, manifestPath, null, deps);

    expect(result.controlRepo.status).toBe('foreign');
    expect(result.controlRepoSync).toEqual({ status: 'skipped' });
    // groundnuty/macf#1057 — control-repo repo-init (labels + router
    // workflow) never runs either: it needs the SAME `controlDir` a foreign
    // control repo never clones.
    expect(result.controlRepoInit).toEqual({ status: 'skipped' });
    expect(result.agents).toEqual([]);
    expect(result.vault).toEqual({ status: 'skipped' });
    expect(result.identityChanges).toEqual([]);
    expect(agentRepoDeps.checkMeta).not.toHaveBeenCalled();
    // groundnuty/macf#1034 — a foreign control repo must abort BEFORE any
    // agent repo is even checked, let alone un-archived: the whole point of
    // "ownership established once, fleet-level" is that a foreign fleet
    // never reaches the per-agent loop at all.
    expect(agentRepoDeps.unarchiveRepo).not.toHaveBeenCalled();
    // DR-043 Amendment D phase 2 (macf#838) — the CA ceremony never ran
    // either (every `trustDeps` fn above throws if invoked).
    expect(result.ca.resolve.status).toBe('failed');
    expect(result.routing).toEqual({});
    // groundnuty/macf#920 gap 2 — the routing-client ceremony never ran
    // either (every `routingClientDeps` fn above throws if invoked).
    expect(result.routingClient.mint.status).toBe('skipped');
    expect(result.routingClient.certLegs).toEqual({});
    expect(result.routingClient.keyLegs).toEqual({});
  });

  describe('control-repo repo-init wiring (groundnuty/macf#1057)', () => {
    /** Role-dispatching `AgentApplyDeps` for a 3-agent "every role already reused" run — same `confirmAppInstallation`-keyed-on-appId shape the file's other multi-agent reused fixtures already use (see the archive/revive describe block above). */
    function reusedThreeAgentDeps(): AgentApplyDeps {
      return {
        startManifestFlow: async () => {
          throw new Error('must not be called — all three roles have prior lock entries');
        },
        startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
        exchangeManifestCode: async () => {
          throw new Error('must not be called');
        },
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async (appId) => ({
          status: 'confirmed',
          install: { appId, installId: `install-${appId}`, appSlug: `demo-fleet-${appId}`, accountLogin: 'groundnuty' },
        }),
        waitForAppInstallation: async () => {
          throw new Error('must not be called — reused path');
        },
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {},
      };
    }

    const PRIOR_LOCK_THREE_AGENTS: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
        { role: 'writing-agent', app_id: 'app-writing-agent', install_id: 'install-3' },
      ],
    };

    it('DECISIVE — control repo repo-init receives ALL three declared agents; each agent repo still receives only its OWN role (private-queue separation preserved)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT, WRITING_AGENT]);
      const repoInitCalls: { repo: string | undefined; agents: string | undefined }[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          repoInitCalls.push({ repo: opts.repo, agents: opts.agents });
          return { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } };
        },
      };
      const deps = baseDeps(reusedThreeAgentDeps(), manifestPath, repoInitDeps);

      const result = await applyFleet(manifest, manifestPath, PRIOR_LOCK_THREE_AGENTS, deps);

      expect(result.agents.map((a) => a.identity.status)).toEqual(['reused', 'reused', 'reused']);

      // The control repo's OWN repo-init call carries ALL THREE roles,
      // comma-joined — not just one, and not derived from a subset (per
      // assert-the-wrong-path.md: a call-count assertion alone can't tell
      // "1 agent" from "3 agents").
      const controlCall = repoInitCalls.find((c) => c.repo === 'groundnuty/demo-fleet-control');
      expect(controlCall?.agents).toBe('code-agent,science-agent,writing-agent');
      expect(result.controlRepoInit.status).toBe('written');
      if (result.controlRepoInit.status === 'written') {
        expect(result.controlRepoInit.agents).toEqual(['code-agent', 'science-agent', 'writing-agent']);
        expect(result.controlRepoInit.repo).toBe('groundnuty/demo-fleet-control');
      }

      // Each AGENT repo's own repo-init call still carries ONLY its own
      // role — the private-queue separation #1057's design explicitly
      // preserves is unaffected by the new control-repo call.
      expect(repoInitCalls.find((c) => c.repo === 'groundnuty/demo-code')?.agents).toBe('code-agent');
      expect(repoInitCalls.find((c) => c.repo === 'groundnuty/demo-science')?.agents).toBe('science-agent');
      expect(repoInitCalls.find((c) => c.repo === 'groundnuty/demo-writing')?.agents).toBe('writing-agent');

      // Exactly 4 repoInit calls total: 1 control repo + 3 agent repos — no
      // extra, no missing.
      expect(repoInitCalls).toHaveLength(4);
    });

    it('does not touch any App-installation seam — every identity/install dep is the SAME "reused, prior-confirmed" fixture already used for the private-queue test above', async () => {
      // No new call to `waitForAppInstallation` (gate 2 / App install) is
      // introduced by the control-repo-init step — it throws if called, and
      // this run completes successfully, proving it never fires. This is
      // the executable half of the "no App installation is modified" claim
      // (the structural half — `ControlRepoInitDeps` has no install-capable
      // field at all — is documented in apply-control-repo-init.test.ts).
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT, WRITING_AGENT]);
      const deps = baseDeps(reusedThreeAgentDeps(), manifestPath, {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async () => ({ workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } }),
      });

      const result = await applyFleet(manifest, manifestPath, PRIOR_LOCK_THREE_AGENTS, deps);

      expect(result.agents.map((a) => a.identity.status)).toEqual(['reused', 'reused', 'reused']);
      expect(result.controlRepoInit.status).toBe('written');
    });

    it('DECISIVE (real GitHub label API) — the control repo receives a label POST for all three agents + the 5 status labels; idempotent re-run reports "existed", never a duplicate "created", and does not rewrite the workflow file', async () => {
      // Same shape as "the decisive routability test" above (macf#920) —
      // real repoInit()'s createLabel() hits a stubbed `fetch`, so this
      // observes the ACTUAL label POSTs the control repo receives, not a
      // proxy for them (assert-the-wrong-path.md: the agents-string and
      // agent-config.json assertions in apply-control-repo-init.test.ts are
      // strong proxies, but this is the only place in the suite that
      // watches the real GitHub label API surface for the CONTROL repo
      // specifically, and does so for a 3-agent manifest — the #920 test's
      // fetch stub only ever exercises a 1-agent manifest).
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT, WRITING_AGENT]);
      const originalFetch = globalThis.fetch;
      const originalGhToken = process.env['GH_TOKEN'];
      process.env['GH_TOKEN'] = 'ghs_control-repo-labels-test-token';
      const controlLabelPosts: { name: string; auth: unknown }[] = [];
      let runNumber = 1;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        if (String(url) === 'https://api.github.com/repos/groundnuty/demo-fleet-control/labels' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { name: string };
          controlLabelPosts.push({ name: body.name, auth: (init.headers as Record<string, string>)?.['Authorization'] });
          // Run 1: every label is newly created (201). Run 2 (the
          // idempotent re-run): every label already exists (422) —
          // `createLabel()` maps 422 to 'exists', proving the re-run
          // reports existed, never a silently-duplicated created.
          return { status: runNumber === 1 ? 201 : 422 } as Response;
        }
        // Every OTHER repo's label POST (each agent's own — this test's
        // assertions are scoped to the control repo) + any other call —
        // inert 200.
        return { status: 200, ok: true, json: async () => [] } as unknown as Response;
      }) as typeof fetch;
      try {
        const deps = baseDeps(reusedThreeAgentDeps(), manifestPath);
        const workflowPath = join(manifestPath, '..', '.github', 'workflows', 'agent-router.yml');

        const first = await applyFleet(manifest, manifestPath, PRIOR_LOCK_THREE_AGENTS, deps);
        expect(first.controlRepoInit.status).toBe('written');
        if (first.controlRepoInit.status === 'written') {
          expect(first.controlRepoInit.labels).toEqual({
            status: 'ok',
            created: expect.arrayContaining(['in-progress', 'in-review', 'blocked', 'agent-offline', 'code-agent', 'science-agent', 'writing-agent']),
            existed: [],
          });
        }
        expect(controlLabelPosts.map((p) => p.name).sort()).toEqual([
          'agent-offline', 'backlog', 'blocked', 'code-agent', 'in-progress', 'in-review', 'science-agent', 'writing-agent',
        ]);
        for (const post of controlLabelPosts) expect(post.auth).toBe('Bearer ghs_control-repo-labels-test-token');
        const workflowAfterFirst = readFileSync(workflowPath, 'utf-8');

        controlLabelPosts.length = 0;
        runNumber = 2;
        const second = await applyFleet(manifest, manifestPath, PRIOR_LOCK_THREE_AGENTS, deps);
        expect(second.controlRepoInit.status).toBe('written');
        if (second.controlRepoInit.status === 'written') {
          expect(second.controlRepoInit.labels).toEqual({
            status: 'ok',
            created: [],
            existed: expect.arrayContaining(['in-progress', 'in-review', 'blocked', 'agent-offline', 'code-agent', 'science-agent', 'writing-agent']),
          });
        }
        // Every label is POSTed again (repoInit doesn't cache — it always
        // attempts the create call), but every one now maps to 'existed',
        // never a second 'created' — the idempotency guarantee.
        expect(controlLabelPosts.map((p) => p.name).sort()).toEqual([
          'agent-offline', 'backlog', 'blocked', 'code-agent', 'in-progress', 'in-review', 'science-agent', 'writing-agent',
        ]);
        // The workflow file itself is untouched byte-for-byte on the
        // re-run — writeFileSafe skips an existing file without --force
        // (visible as "Skipping existing file" in stdout); this asserts
        // the outcome, not just the log line.
        expect(readFileSync(workflowPath, 'utf-8')).toBe(workflowAfterFirst);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalGhToken === undefined) delete process.env['GH_TOKEN'];
        else process.env['GH_TOKEN'] = originalGhToken;
      }
    });
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
      trustDeps: trustDepsFor(),
      routingClientDeps: NOOP_ROUTING_CLIENT_DEPS,
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
      trustDeps: trustDepsFor(),
      routingClientDeps: NOOP_ROUTING_CLIENT_DEPS,
      routingSecretsDeps: NOOP_ROUTING_SECRETS_DEPS,
      routerAppVaultDeps: NOOP_ROUTER_APP_VAULT_DEPS,
      controlRepoOptions: { makeScratchDir: () => controlDir },
      // macf#988 — defense-in-depth (this test's empty `age_recipients: []`
      // fixture means no recovery write is actually reachable here, but see
      // the "REAL age binary" test's identical comment for why every
      // hand-built `FleetApplyDeps` in this file pins this anyway).
      recoveryRootDir: controlDir,
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

  // groundnuty/macf#1249 — apply OWNS the committed fleet.yaml on EVERY run,
  // not just first-creation. `provisionControlRepo`'s own `ours` branch
  // never re-commits (see `control-repo.ts`'s doc); the fix lives at THIS
  // call site — `applyFleet` refreshes `controlDir/fleet.yaml` from the
  // local manifest right before the final sync commit. These two tests are
  // the write-path half of the decisive pair (`control-repo-manifest-drift.test.ts`
  // covers the READ/report half).
  describe('control-repo manifest sync on a reused checkout (groundnuty/macf#1249)', () => {
    const STALE_COMMITTED_YAML = [
      'apiVersion: macf/v0',
      'kind: Fleet',
      'metadata:',
      '  name: demo-fleet',
      'owner:',
      '  account: groundnuty',
      '  type: user',
      '  registry: { type: profile, user: groundnuty }',
      'network:',
      '  advertise_host: STALE.ts.net',
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
    ].join('\n');

    function reuseControlRepoDeps(committedYaml: string, commitAndPushCalls: string[]): ControlRepoDeps {
      return {
        checkMeta: async () => ({ presence: 'present', archived: false }),
        readManifestFile: async () => committedYaml,
        createRepo: async () => {
          throw new Error('must not be called — reuse never creates');
        },
        unarchiveRepo: async () => {
          throw new Error('must not be called — this fixture is never ours-archived');
        },
        // The REAL clone would bring back whatever the control repo already
        // has committed — simulate that by writing the SAME committed
        // fleet.yaml into destDir (matching what `readManifestFile` above
        // says is on the default branch).
        cloneRepo: async (_url, destDir) => {
          writeFileSync(join(destDir, 'fleet.yaml'), committedYaml, 'utf-8');
        },
        // Capture fleet.yaml's content at EVERY commitAndPush call — a
        // 'reused' outcome never calls this from `provisionControlRepo`
        // itself (see that function's doc), so the ONLY call this fixture
        // ever sees is the final sync, at the very end of `applyFleet`.
        commitAndPush: async (dir) => {
          commitAndPushCalls.push(readFileSync(join(dir, 'fleet.yaml'), 'utf-8'));
          return 'pushed';
        },
      };
    }

    it('a local manifest that DRIFTED from the committed one: the final sync commits THIS run\'s local bytes', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const localManifestYaml = [
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
        '  age_recipients: [age1operator, age1vm]',
        '  router_app_scope: per-fleet',
        'defaults:',
        '  role_template: groundnuty/agentic-repo-template',
        '  app_manifest: dr-019',
        'agents:',
        '  - role: code-agent',
        '    profile: code',
        '    repo: groundnuty/demo-code',
        '    deploy_path: /x',
      ].join('\n');
      writeFileSync(manifestPath, localManifestYaml, 'utf-8');

      const controlDir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-manifest-sync-'));
      dirs.push(controlDir);
      const commitAndPushCalls: string[] = [];

      const deps: FleetApplyDeps = {
        buildAgentDeps: () => agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'),
        repoInitDeps: { cloneRepo: async () => {}, commitAndPush: async () => 'pushed' },
        vaultDeps: { exists: () => false, encrypt: async () => {} },
        controlRepoDeps: reuseControlRepoDeps(STALE_COMMITTED_YAML, commitAndPushCalls),
        agentRepoDeps: agentRepoDepsFor(),
        trustDeps: trustDepsFor(),
        routingClientDeps: NOOP_ROUTING_CLIENT_DEPS,
        routingSecretsDeps: NOOP_ROUTING_SECRETS_DEPS,
        routerAppVaultDeps: NOOP_ROUTER_APP_VAULT_DEPS,
        controlRepoOptions: { makeScratchDir: () => controlDir },
        recoveryRootDir: controlDir,
        now: () => new Date('2026-08-11T00:00:00.000Z'),
        log: () => {},
      };

      await applyFleet(manifest, manifestPath, null, deps);

      // Exactly ONE commitAndPush call for a 'reused' outcome (the final
      // sync) — `provisionControlRepo` itself never calls it on reuse. If a
      // future change makes 'reused' ALSO commit inside `provisionControlRepo`,
      // this assertion (not just the content check below) would catch it.
      expect(commitAndPushCalls).toHaveLength(1);
      expect(commitAndPushCalls[0]).toBe(localManifestYaml);
      expect(commitAndPushCalls[0]).not.toBe(STALE_COMMITTED_YAML);
    });

    it('an UNCHANGED local manifest (byte-identical to the committed one, comment and all): written byte-for-byte, never re-serialized through the parsed object', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      // The comment is the discriminator: `yaml.stringify(manifest)` (the
      // in-memory-fallback re-serialization path) can NEVER reproduce it —
      // an implementation that always re-serializes instead of reading the
      // local file's raw bytes would silently strip it (and reformat
      // everything else) on every single apply run.
      const unchangedYaml = `${STALE_COMMITTED_YAML.replace('STALE.ts.net', 'example.ts.net')} # pinned — must survive a re-commit verbatim`;
      writeFileSync(manifestPath, unchangedYaml, 'utf-8');

      const controlDir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-manifest-sync-unchanged-'));
      dirs.push(controlDir);
      const commitAndPushCalls: string[] = [];

      const deps: FleetApplyDeps = {
        buildAgentDeps: () => agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'),
        repoInitDeps: { cloneRepo: async () => {}, commitAndPush: async () => 'pushed' },
        vaultDeps: { exists: () => false, encrypt: async () => {} },
        controlRepoDeps: reuseControlRepoDeps(unchangedYaml, commitAndPushCalls),
        agentRepoDeps: agentRepoDepsFor(),
        trustDeps: trustDepsFor(),
        routingClientDeps: NOOP_ROUTING_CLIENT_DEPS,
        routingSecretsDeps: NOOP_ROUTING_SECRETS_DEPS,
        routerAppVaultDeps: NOOP_ROUTER_APP_VAULT_DEPS,
        controlRepoOptions: { makeScratchDir: () => controlDir },
        recoveryRootDir: controlDir,
        now: () => new Date('2026-08-11T00:00:00.000Z'),
        log: () => {},
      };

      await applyFleet(manifest, manifestPath, null, deps);

      expect(commitAndPushCalls).toHaveLength(1);
      expect(commitAndPushCalls[0]).toBe(unchangedYaml);
      expect(commitAndPushCalls[0]).toContain('# pinned — must survive a re-commit verbatim');
    });
  });

  /**
   * groundnuty/macf#1221 (the "still broken after #1224" follow-up) — #1224
   * threaded `resolveControlRepoLabelTokenSource` into Step 0.5, but that
   * resolver ONLY ever looks at `priorLock` + a wired `resolveKeyPath`
   * (`--vault`/`--identity-key`) — both are ABSENT on a genuinely first-ever
   * fleet provision, which is exactly what a `'created'` identity means.
   * Before this fix, that exact scenario reproduced the pre-#1224 warning
   * byte-for-byte (verified live on `macf-trial`, macf#1221's comment
   * thread). These tests assert at the SAME call site #1224's own
   * `apply-control-repo-init.test.ts` tests already asserted at (the
   * options object the injected `repoInit` fake receives) — but for the
   * NEW retry call this fix adds, not the threading `applyControlRepoInit`
   * already had covered.
   */
  describe('control-repo label retry with a JUST-CREATED agent credential (groundnuty/macf#1221 follow-up)', () => {
    it('DECISIVE (1/2) — no priorLock, no vault: control-repo labels still land OK via a retry using the freshly-created agent\'s own credential', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const controlRepoCalls: { tokenSource: RepoInitOptions['tokenSource']; keyContentAtCallTime?: string }[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          if (opts.repo !== 'groundnuty/demo-fleet-control') {
            // the agent's own repo — not this test's concern; succeed plainly.
            return { workflow: 'created', config: 'created', labels: { status: 'ok', created: ['code-agent'], existed: [] } };
          }
          // Read the tokenSource's keyPath NOW, inside the call — the retry
          // caller cleans its scratch PEM up in a `finally` right after this
          // call returns, so reading it later (after `applyFleet` resolves)
          // would see a deleted file.
          controlRepoCalls.push({
            tokenSource: opts.tokenSource,
            keyContentAtCallTime: opts.tokenSource ? readFileSync(opts.tokenSource.keyPath, 'utf-8') : undefined,
          });
          return opts.tokenSource === undefined
            ? { workflow: 'created', config: 'created', labels: { status: 'skipped', reason: 'No GH_TOKEN, no TokenSource provided, and missing APP_ID/INSTALL_ID/KEY_PATH env vars' } }
            : { workflow: 'created', config: 'created', labels: { status: 'ok', created: ['code-agent'], existed: [] } };
        },
      };
      const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath, repoInitDeps);

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('created');

      // Step 0.5 attempted with no credential, THEN a retry with one — never
      // just one call (either the retry never fires, or it silently
      // replaced the first attempt instead of following it).
      expect(controlRepoCalls).toHaveLength(2);
      expect(controlRepoCalls[0]?.tokenSource).toBeUndefined();
      expect(controlRepoCalls[1]?.tokenSource).toEqual({ appId: 'app-code-agent', installId: 'install-1', keyPath: expect.any(String) });
      // The retry's scratch key carried the SAME PEM the per-agent loop just
      // exchanged for this role (`creds('code-agent').pem`) — proves the
      // retry used the freshly-minted in-process credential, not an
      // arbitrary placeholder.
      expect(controlRepoCalls[1]?.keyContentAtCallTime).toBe('SENTINEL-PEM-code-agent');

      expect(result.controlRepoInit.status).toBe('written');
      if (result.controlRepoInit.status === 'written') {
        expect(result.controlRepoInit.labels).toEqual({ status: 'ok', created: ['code-agent'], existed: [] });
        expect(result.controlRepoInit.labelsGoodEnough).toBe(true);
      }
      expect(applyExitCode(result)).toBe(0);
    });

    it('DECISIVE (2/2) — no created agent this run (all reused, no working vault key): control-repo labels stay unattempted and the run reports incomplete (exit 2), never 0', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      const controlRepoCalls: RepoInitOptions[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          if (opts.repo === 'groundnuty/demo-fleet-control') controlRepoCalls.push(opts);
          return opts.tokenSource === undefined
            ? { workflow: 'created', config: 'created', labels: { status: 'skipped', reason: 'No GH_TOKEN, no TokenSource provided, and missing APP_ID/INSTALL_ID/KEY_PATH env vars' } }
            : { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: ['code-agent'] } };
        },
      };
      // 'reused' fixture's `resolveKeyPath` points at '/fake.pem', which does
      // NOT exist on disk — #1224's own keyPath-is-not-a-credential guard
      // filters it, so `resolveControlRepoLabelTokenSource` still returns
      // `undefined` even though a `priorLock` entry + a wired `resolveKeyPath`
      // both exist. No agent is CREATED this run for the retry to use either.
      const deps = baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath, repoInitDeps);

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents[0]?.identity.status).toBe('reused');
      // Exactly ONE control-repo repoInit call — Step 0.5's own attempt,
      // never retried (nothing new became available to retry with).
      expect(controlRepoCalls).toHaveLength(1);
      expect(controlRepoCalls[0]?.tokenSource).toBeUndefined();

      expect(result.controlRepoInit.status).toBe('written');
      if (result.controlRepoInit.status === 'written') {
        expect(result.controlRepoInit.labels.status).toBe('skipped');
        // Honest "nothing to try" — not a hard failure — but per the
        // issue's own Required list ("either it succeeds, or the run
        // reports the fleet as incomplete"), this must NOT read as exit 0.
        expect(result.controlRepoInit.labelsGoodEnough).toBe(true);
      }
      expect(applyExitCode(result)).toBe(2);
    });

    it('REGRESSION — the retry does not fire when Step 0.5 already landed labels OK, even with a created agent available (no wasted extra repoInit call)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const controlRepoCalls: RepoInitOptions[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          if (opts.repo === 'groundnuty/demo-fleet-control') controlRepoCalls.push(opts);
          // Always 'ok', regardless of tokenSource — Step 0.5 itself
          // already succeeds (a resolvable priorLock+vault credential, or a
          // local-registry mode that never needed one — this fixture
          // doesn't care which; the point is `labels.status === 'ok'` on
          // the FIRST call).
          return { workflow: 'created', config: 'created', labels: { status: 'ok', created: ['code-agent'], existed: [] } };
        },
      };
      const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath, repoInitDeps);

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('created');
      // Exactly one control-repo call — the retry-guard's `labels.status
      // !== 'ok'` check short-circuits before ever looking for a created
      // agent to retry with.
      expect(controlRepoCalls).toHaveLength(1);
      expect(result.controlRepoInit.status).toBe('written');
      if (result.controlRepoInit.status === 'written') expect(result.controlRepoInit.labels.status).toBe('ok');
    });
  });

  /**
   * groundnuty/macf#1221 — THIRD attempt. #1224 threaded a `tokenSource`
   * into Step 0.5 but resolved it against the raw, caller-supplied
   * `priorLock` — which `resolveMutateDeps`'s own doc says reads from the
   * OPERATOR's LOCAL manifest directory, never the control repo. #1234
   * added a retry using a JUST-CREATED agent's credential, but that only
   * fires when THIS run created an agent. Neither covers the actual live
   * failure: a re-run of an ALREADY-ESTABLISHED fleet (macf-trial) from a
   * scratch/tmp directory — `priorLock` is `null` (nothing local) AND no
   * agent is created this run (everything reused) — even though the
   * JUST-CLONED control-repo checkout already carries every agent's
   * app_id/install_id from its own last successful apply. This fix moves
   * the existing self-heal read (macf#857 — `currentLock = readFleetLockFile
   * (lockPath) ?? priorLock`) earlier so Step 0.5 can see it too. These
   * tests assert at the same call site #1224's own tests did (the options
   * object the injected `repoInit` fake receives for the control repo), for
   * the self-healed-lock path specifically.
   */
  describe('control-repo label token resolves against the self-healed control-repo lock (groundnuty/macf#1221 third attempt)', () => {
    it('DECISIVE — all agents reused, no local fleet.lock, a vault-backed credential supplied: control-repo labels land OK via Step 0.5 itself (not the created-agent retry)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);

      // A REAL PEM file on disk — resolveControlRepoLabelTokenSource's
      // exists() guard (macf#1224) rejects a resolved-but-absent path, so a
      // fixture using a placeholder like '/fake.pem' (as `agentDepsFor`'s
      // 'reused' shape does) would not actually prove this fix; the vault
      // key has to be readable for real.
      const vaultKeyDir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-selfheal-vaultkey-'));
      dirs.push(vaultKeyDir);
      const vaultKeyPath = join(vaultKeyDir, 'code-agent.pem');
      writeFileSync(vaultKeyPath, 'SENTINEL-VAULT-PEM-code-agent', { mode: 0o600 });

      // What the control repo's LAST successful apply already committed —
      // a REUSE clone brings this back.
      const priorLockFromControlRepo: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };

      const controlRepoCalls: RepoInitOptions[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          if (opts.repo !== 'groundnuty/demo-fleet-control') {
            // the agent's own repo — not this test's concern.
            return { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: ['code-agent'] } };
          }
          controlRepoCalls.push(opts);
          return opts.tokenSource === undefined
            ? { workflow: 'created', config: 'created', labels: { status: 'skipped', reason: 'No GH_TOKEN, no TokenSource provided, and missing APP_ID/INSTALL_ID/KEY_PATH env vars' } }
            : { workflow: 'created', config: 'created', labels: { status: 'ok', created: ['code-agent'], existed: [] } };
        },
      };

      // The vault-backed key resolver — same shape `resolveMutateDeps` wires
      // under --vault/--identity-key, pointed at the REAL file above
      // instead of the file's usual '/fake.pem' placeholder.
      const agentDeps: AgentApplyDeps = { ...agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), resolveKeyPath: () => vaultKeyPath };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDeps, manifestPath, repoInitDeps),
        controlRepoDeps: {
          ...controlRepoDepsFor(),
          // A REUSE clone brings back whatever the control repo already has
          // committed — the exact mechanism this fix wires into Step 0.5.
          cloneRepo: async (_url, destDir) => {
            writeFileSync(join(destDir, 'fleet.lock'), JSON.stringify(priorLockFromControlRepo), 'utf-8');
          },
        },
      };

      // The caller supplies NO prior lock — the exact shape of a Mac apply
      // run from a scratch/tmp directory that never held a prior run's
      // manifest (the live macf-trial repro, macf#1221's comment thread).
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('reused');

      // Exactly ONE control-repo repoInit call — Step 0.5 itself resolved
      // the credential; the created-agent retry (nothing was created this
      // run) never needed to fire.
      expect(controlRepoCalls).toHaveLength(1);
      expect(controlRepoCalls[0]?.tokenSource).toEqual({ appId: 'app-code-agent', installId: 'install-1', keyPath: vaultKeyPath });

      expect(result.controlRepoInit.status).toBe('written');
      if (result.controlRepoInit.status === 'written') {
        expect(result.controlRepoInit.labels).toEqual({ status: 'ok', created: ['code-agent'], existed: [] });
        expect(result.controlRepoInit.labelsGoodEnough).toBe(true);
      }
      expect(applyExitCode(result)).toBe(0);
    });

    it('self-healed lock resolves the agent as reused, but no WORKING vault key is available: control-repo labels stay UNCONFIRMED and the run reports incomplete (exit 2), never 0', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLockFromControlRepo: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      const controlRepoCalls: RepoInitOptions[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          if (opts.repo === 'groundnuty/demo-fleet-control') controlRepoCalls.push(opts);
          return opts.tokenSource === undefined
            ? { workflow: 'created', config: 'created', labels: { status: 'skipped', reason: 'No GH_TOKEN, no TokenSource provided, and missing APP_ID/INSTALL_ID/KEY_PATH env vars' } }
            : { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: ['code-agent'] } };
        },
      };
      // 'reused' fixture's `resolveKeyPath` points at '/fake.pem', which does
      // NOT exist on disk — #1224's own keyPath-is-not-a-credential guard
      // filters it, so `resolveControlRepoLabelTokenSource` still returns
      // `undefined` even though the SELF-HEALED `currentLock` (not a caller
      // `priorLock` — that is `null` here) resolves this role. No agent is
      // CREATED this run for the retry either.
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath, repoInitDeps),
        controlRepoDeps: {
          ...controlRepoDepsFor(),
          cloneRepo: async (_url, destDir) => {
            writeFileSync(join(destDir, 'fleet.lock'), JSON.stringify(priorLockFromControlRepo), 'utf-8');
          },
        },
      };

      // The caller supplies NO prior lock at all — only the checkout's own
      // self-healed lock resolves this run's per-agent identity.
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('reused');
      // Exactly ONE control-repo repoInit call — Step 0.5's own attempt,
      // never retried (nothing new became available to retry with).
      expect(controlRepoCalls).toHaveLength(1);
      expect(controlRepoCalls[0]?.tokenSource).toBeUndefined();

      expect(result.controlRepoInit.status).toBe('written');
      if (result.controlRepoInit.status === 'written') {
        expect(result.controlRepoInit.labels.status).toBe('skipped');
        // Honest "nothing to try" — not a hard failure — but per the
        // issue's own Required list, this must NOT read as exit 0.
        expect(result.controlRepoInit.labelsGoodEnough).toBe(true);
      }
      expect(applyExitCode(result)).toBe(2);
    });

    it('REGRESSION — a caller-supplied priorLock alone (checkout brings back nothing of its own) still resolves a legitimate token, unchanged from before this fix', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const vaultKeyDir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-priorlock-vaultkey-'));
      dirs.push(vaultKeyDir);
      const vaultKeyPath = join(vaultKeyDir, 'code-agent.pem');
      writeFileSync(vaultKeyPath, 'SENTINEL-VAULT-PEM-code-agent', { mode: 0o600 });

      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };

      const controlRepoCalls: RepoInitOptions[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          if (opts.repo === 'groundnuty/demo-fleet-control') controlRepoCalls.push(opts);
          return opts.tokenSource === undefined
            ? { workflow: 'created', config: 'created', labels: { status: 'skipped', reason: 'No GH_TOKEN, no TokenSource provided, and missing APP_ID/INSTALL_ID/KEY_PATH env vars' } }
            : { workflow: 'created', config: 'created', labels: { status: 'ok', created: ['code-agent'], existed: [] } };
        },
      };

      const agentDeps: AgentApplyDeps = { ...agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), resolveKeyPath: () => vaultKeyPath };
      // The DEFAULT `controlRepoDepsFor()` — a no-op clone that brings
      // NOTHING back of its own, so `currentLock`'s self-heal has nothing
      // to prefer and degrades to the caller-supplied `priorLock`, exactly
      // as it did before this fix.
      const deps = baseDeps(agentDeps, manifestPath, repoInitDeps);

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents[0]?.identity.status).toBe('reused');
      expect(controlRepoCalls).toHaveLength(1);
      expect(controlRepoCalls[0]?.tokenSource).toEqual({ appId: 'app-code-agent', installId: 'install-1', keyPath: vaultKeyPath });
      expect(result.controlRepoInit.status).toBe('written');
      if (result.controlRepoInit.status === 'written') {
        expect(result.controlRepoInit.labels).toEqual({ status: 'ok', created: ['code-agent'], existed: [] });
      }
      expect(applyExitCode(result)).toBe(0);
    });
  });

  /**
   * groundnuty/macf#1240 — the residual `#1221` split out so that issue did
   * not stretch a fourth time. `#1237` (the describe block right above)
   * fixed the CONTROL repo's own label-creation token resolution; the
   * PER-AGENT repo-init call (an agent's OWN repo) still ran with NO
   * `tokenSource` at all for `reused`/`resumed-install` identities,
   * unconditionally degrading to the ambient-env fallback — verified live on
   * the SAME run that closed `#1221` (CLI at `4ba3596`): the control repo's
   * labels landed via `#1237`, but every agent repo still printed "could not
   * generate token... Skipping label creation." These tests assert at the
   * SAME call site `#1237`'s own tests assert at (the options object the
   * injected `repoInit` fake receives) but for the agent's OWN repo, never
   * the control repo — a fixture-level `if (opts.repo === ...control)`
   * branch keeps the two concerns from being conflated in one assertion.
   */
  describe('per-agent repo-init resolves its OWN vault-backed token (groundnuty/macf#1240)', () => {
    it('DECISIVE (1/2) — reused agent, no local lock, a vault-backed credential supplied: agent-repo labels land via the per-agent repoInit call', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);

      // A REAL PEM file on disk — `resolveAgentRepoInitTokenSource`'s
      // `exists()` guard rejects a resolved-but-absent path, so a fixture
      // using a placeholder like '/fake.pem' (as `agentDepsFor`'s 'reused'
      // shape does) would not actually prove this fix.
      const vaultKeyDir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-agentrepo-vaultkey-'));
      dirs.push(vaultKeyDir);
      const vaultKeyPath = join(vaultKeyDir, 'code-agent.pem');
      writeFileSync(vaultKeyPath, 'SENTINEL-VAULT-PEM-code-agent', { mode: 0o600 });

      // No LOCAL lock — this run's ONLY source for the reused decision is
      // the caller-supplied `priorLock` below (kept simple; #1237's own
      // self-heal path is orthogonal to this fix and already covered).
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };

      const agentRepoCalls: RepoInitOptions[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          if (opts.repo === 'groundnuty/demo-fleet-control') {
            // the control repo — #1237's own concern, not this test's.
            return { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } };
          }
          agentRepoCalls.push(opts);
          return opts.tokenSource === undefined
            ? { workflow: 'created', config: 'created', labels: { status: 'skipped', reason: 'No GH_TOKEN, no TokenSource provided, and missing APP_ID/INSTALL_ID/KEY_PATH env vars' } }
            : { workflow: 'created', config: 'created', labels: { status: 'ok', created: ['code-agent'], existed: [] } };
        },
      };

      // The vault-backed key resolver — same shape `resolveMutateDeps` wires
      // under --vault/--identity-key, pointed at the REAL file above instead
      // of the fixture's usual '/fake.pem' placeholder.
      const agentDeps: AgentApplyDeps = { ...agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), resolveKeyPath: () => vaultKeyPath };
      const deps = baseDeps(agentDeps, manifestPath, repoInitDeps);

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents[0]?.identity.status).toBe('reused');

      // Exactly ONE agent-repo repoInit call, carrying the resolved
      // tokenSource — never the credential-less shape this issue reports.
      expect(agentRepoCalls).toHaveLength(1);
      expect(agentRepoCalls[0]?.tokenSource).toEqual({ appId: 'app-code-agent', installId: 'install-1', keyPath: vaultKeyPath });

      expect(result.agents[0]?.repoInit?.status).toBe('applied');
      if (result.agents[0]?.repoInit?.status === 'applied') {
        expect(result.agents[0].repoInit.labels).toEqual({ status: 'ok', created: ['code-agent'], existed: [] });
      }
      expect(applyExitCode(result)).toBe(0);
    });

    it('DECISIVE (2/2) — no credential anywhere for this role: tokenSource stays honestly omitted (never a fabricated/nonexistent one), and this agent-repo gap alone does not fail the run', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };

      const agentRepoCalls: RepoInitOptions[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          if (opts.repo === 'groundnuty/demo-fleet-control') {
            return opts.tokenSource === undefined
              ? { workflow: 'created', config: 'created', labels: { status: 'skipped', reason: 'No GH_TOKEN, no TokenSource provided, and missing APP_ID/INSTALL_ID/KEY_PATH env vars' } }
              : { workflow: 'created', config: 'created', labels: { status: 'ok', created: ['code-agent'], existed: [] } };
          }
          agentRepoCalls.push(opts);
          return opts.tokenSource === undefined
            ? { workflow: 'created', config: 'created', labels: { status: 'skipped', reason: 'No GH_TOKEN, no TokenSource provided, and missing APP_ID/INSTALL_ID/KEY_PATH env vars' } }
            : { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: ['code-agent'] } };
        },
      };

      // 'reused' fixture's `resolveKeyPath` points at '/fake.pem', which
      // does NOT exist on disk — `resolveAgentRepoInitTokenSource`'s
      // keyPath-is-not-a-credential guard filters it, so this run has NO
      // credential anywhere for this role (and, by the SAME fixture, none
      // for the control repo either).
      const deps = baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath, repoInitDeps);

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents[0]?.identity.status).toBe('reused');
      expect(agentRepoCalls).toHaveLength(1);
      // The honest "nothing to try" — never a garbage/nonexistent-path
      // tokenSource fabricated from the unresolved '/fake.pem'.
      expect(agentRepoCalls[0]?.tokenSource).toBeUndefined();

      // Not a hard failure on the AGENT-repo side — must not fail unrelated
      // legs (groundnuty/macf#1210). `applyRepoInitForAgent`'s own
      // `labelsAreGoodEnough` scores a credential-less 'skipped' outcome as
      // 'applied', unchanged by this fix.
      expect(result.agents[0]?.repoInit?.status).toBe('applied');
      // The run as a WHOLE still reports incomplete (exit 2, never 0) — but
      // that comes from the CONTROL repo's own pre-existing #1237 signal
      // (`controlRepoLabelsPending`), which this fixture's identical
      // no-working-vault-key shape ALSO leaves unconfirmed. This fix must
      // not weaken that signal (per the issue's own "do not weaken #1237"
      // requirement) — it is asserted here, unchanged, alongside the new
      // agent-repo behavior above.
      expect(result.controlRepoInit.status).toBe('written');
      if (result.controlRepoInit.status === 'written') {
        expect(result.controlRepoInit.labels.status).toBe('skipped');
        expect(result.controlRepoInit.labelsGoodEnough).toBe(true);
      }
      expect(applyExitCode(result)).toBe(2);
    });

    it('a resolved credential + a genuine mint failure: NOW a hard failure (exit 1) — the newly-reachable escalation this fix introduces, distinct from the honest no-credential case above', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);

      const vaultKeyDir = mkdtempSync(join(tmpdir(), 'macf-apply-fleet-agentrepo-badmint-'));
      dirs.push(vaultKeyDir);
      const vaultKeyPath = join(vaultKeyDir, 'code-agent.pem');
      writeFileSync(vaultKeyPath, 'SENTINEL-VAULT-PEM-code-agent', { mode: 0o600 });

      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };

      const agentRepoCalls: RepoInitOptions[] = [];
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async (_dir, opts) => {
          if (opts.repo === 'groundnuty/demo-fleet-control') {
            return { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } };
          }
          agentRepoCalls.push(opts);
          // A resolvable credential WAS supplied (`opts.tokenSource` is
          // defined below) but the mint itself genuinely failed — a revoked
          // key, a stale vault PEM, a transient 401. `labelsAreGoodEnough`
          // now scores this as a HARD failure, same bar the `created` path
          // already had (groundnuty/macf#920) — before this fix, the
          // `reused`/`resumed-install` branch never supplied a tokenSource
          // at all, so this exact shape could never even be reached for it.
          return { workflow: 'created', config: 'created', labels: { status: 'partial-failure', created: [], existed: [], failed: ['in-progress'] } };
        },
      };

      const agentDeps: AgentApplyDeps = { ...agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), resolveKeyPath: () => vaultKeyPath };
      const deps = baseDeps(agentDeps, manifestPath, repoInitDeps);

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents[0]?.identity.status).toBe('reused');
      expect(agentRepoCalls).toHaveLength(1);
      expect(agentRepoCalls[0]?.tokenSource).toEqual({ appId: 'app-code-agent', installId: 'install-1', keyPath: vaultKeyPath });

      expect(result.agents[0]?.repoInit?.status).toBe('failed');
      expect(applyExitCode(result)).toBe(1);
    });
  });

  // --- DR-043 Amendment D phase 2 (macf#838, macf#854's CA/routing gap) ---

  describe('CA ceremony + two-place publish + MACF_TRUSTED_ACTORS (macf#922 — was MACF_ROUTING_RUNS_ON)', () => {
    it('fresh mint: publishes to the registry + BOTH agent repos AND the control repo (groundnuty/macf#1345 — router-carrying, not agent-repos-only), stages the key for the vault, never a raw key value on any leg outcome', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const logs: string[] = [];
      const deps: FleetApplyDeps = { ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath), log: (l) => logs.push(l) };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.ca.resolve.status).toBe('minted');
      expect(result.ca.resolve).not.toHaveProperty('certPem');
      expect(result.ca.resolve).not.toHaveProperty('keyPem');
      expect(result.ca.registryLeg).toEqual({ status: 'created' });
      // groundnuty/macf#1345 — the control repo (which this fixture's
      // default `NOOP_REPO_INIT`-driven REAL `repoInit()` writes the
      // router workflow into, allowlisted by default — see
      // `apply-control-repo-init.ts::controlRepoCarriesRouter`) is now
      // IN the CA-cert target set, alongside both agent repos. Pre-fix,
      // this leg published against `confirmedRepos` (agent repos only)
      // and the control repo was silently never covered.
      expect(result.ca.repoLegs).toEqual({
        'groundnuty/demo-code': { status: 'created' },
        'groundnuty/demo-science': { status: 'created' },
        'groundnuty/demo-fleet-control': { status: 'created' },
      });
      expect(JSON.stringify(result)).not.toContain('SENTINEL-CA-KEY-PEM');

      // The operator-facing denominator — same "name the population
      // covered" discipline #1341 established for routing secrets,
      // generalized here (groundnuty/macf#1345): 3 router-carrying repos
      // (2 agent + 1 control), all created, zero unknown.
      expect(logs).toContain('CA cert legs: 3 created, 0 already-present of 3 router-carrying repo(s).');
    });

    it('DECISIVE PAIR (2/2) — control-repo init did NOT succeed this run -> the control repo is EXCLUDED from the CA-cert target set, and the denominator report says so (groundnuty/macf#1345)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const logs: string[] = [];
      // A `repoInit` that throws -> `applyControlRepoInit` returns
      // `status: 'failed'` -> `controlRepoCarriesRouter` is false (the gate
      // `deriveRouterCarryingRepos` already encodes) -> the control repo
      // must NOT appear anywhere in the CA-cert population or its legs.
      const failingRepoInit: RepoInitStepDeps = {
        cloneRepo: async () => {},
        commitAndPush: async () => 'pushed',
        repoInit: async () => {
          throw new Error('simulated control-repo-init failure (groundnuty/macf#1345 decisive pair 2/2)');
        },
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath, failingRepoInit),
        log: (l) => logs.push(l),
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.ca.resolve.status).toBe('minted');
      // Only the two agent repos — the control repo (repo-init failed) is
      // excluded, not merely omitted-and-unmentioned.
      expect(result.ca.repoLegs).toEqual({
        'groundnuty/demo-code': { status: 'created' },
        'groundnuty/demo-science': { status: 'created' },
      });
      expect(result.ca.repoLegs).not.toHaveProperty('groundnuty/demo-fleet-control');

      // The denominator report reflects the SMALLER population — 2, not 3
      // — and zero unknown (the exclusion is a deliberate gate, not an
      // enumeration failure).
      expect(logs).toContain('CA cert legs: 2 created, 0 already-present of 2 router-carrying repo(s).');
      // And the control-repo-init failure itself is reported (pre-existing
      // behavior — this pair adds the CA-leg consequence, not the failure
      // report itself).
      expect(logs.some((l) => l.includes('Control repo "groundnuty/demo-fleet-control" repo-init: FAILED'))).toBe(true);
    });

    it('reuse: fleet.lock already records ca_key AND registry reports present -> REUSES (never re-mints), backfills a repo leg the registry has but a repo is missing (#806 drift), and the vault stays skipped (no NEW agent OR CA secret this run)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [
          { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
          { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
        ],
        fingerprints: { ca_key: 'sha256:deadbeef' },
      };
      // BOTH agents already confirmed live (reused) — no fresh credential
      // for either, so the ONLY thing that could put the vault in
      // 'written' this run is a fresh CA secret, which reuse must not stage.
      const agentDeps: AgentApplyDeps = {
        startManifestFlow: async () => { throw new Error('must not be called — both roles have prior entries'); },
        startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
        exchangeManifestCode: async () => { throw new Error('must not be called'); },
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async (appId) => ({
          status: 'confirmed',
          install: { appId, installId: appId === 'app-code-agent' ? 'install-1' : 'install-2', appSlug: `demo-fleet-${appId}`, accountLogin: 'groundnuty' },
        }),
        waitForAppInstallation: async () => { throw new Error('must not be called'); },
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {},
      };
      let mintCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDeps, manifestPath),
        trustDeps: trustDepsFor({
          checkRegistryPresence: async () => 'present',
          readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM',
          // One repo leg reports the #806 drift class — present on the
          // registry, absent on THIS one repo.
          checkRepoPresence: async (repo) => (repo === 'groundnuty/demo-code' ? 'present' : 'absent'),
          mintCa: async () => {
            mintCalled = true;
            throw new Error('must not be called — a CA already exists');
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents.map((a) => a.identity.status)).toEqual(['reused', 'reused']);
      expect(mintCalled).toBe(false);
      expect(result.ca.resolve.status).toBe('reused');
      expect(result.ca.repoLegs['groundnuty/demo-code']).toEqual({ status: 'already-present' });
      expect(result.ca.repoLegs['groundnuty/demo-science']).toEqual({ status: 'created' }); // backfilled
      expect(result.vault.status).toBe('skipped'); // no NEW agent OR CA secret to persist on a reuse
    });

    it('ambiguous: fleet.lock records ca_key but the registry cert is NOT confirmable present -> REFUSES to mint (would orphan the vaulted key) — nothing published', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = { schema_version: 1, fleet: 'demo-fleet', agents: [], fingerprints: { ca_key: 'sha256:deadbeef' } };
      let mintCalled = false;
      let createRegistryCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRegistryPresence: async () => 'absent', // the ambiguous/dangerous combination
          mintCa: async () => {
            mintCalled = true;
            throw new Error('must not be called');
          },
          createRegistryVariable: async () => {
            createRegistryCalled = true;
            throw new Error('must not be called — nothing to publish');
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(mintCalled).toBe(false);
      expect(createRegistryCalled).toBe(false);
      expect(result.ca.resolve.status).toBe('failed');
      expect(result.ca.resolve.reason).toMatch(/orphan/);
      expect(result.ca.registryLeg.status).toBe('skipped');
    });

    // --- groundnuty/macf#978 — the deactivate-then-apply revive path ---
    //
    // `macf fleet deactivate` deletes exactly the `<SEG>_CA_CERT` registry
    // leg (never `fleet.lock`), producing the SAME "ambiguous" shape the
    // test directly above refuses on. These tests exercise the THIRD option
    // (`deps.readVaultCaCert`) that shape now has.

    it('deactivate-shaped state: lock has ca_key, registry ABSENT, vault has the cert -> RESTORES end-to-end (registry leg actually gets recreated, not just "vault was read"), never mints', async () => {
      const manifestPath = manifestPathIn();
      // groundnuty/macf#1083 — self-hosted DECLARED so the runner-ops App
      // stays a needed identity and takes the REUSED path below like the
      // other two; without this the prior lock entry would be reported as
      // an orphan ('not-needed'), which is correct #1083 behavior but
      // irrelevant noise for a test whose focus is the CA machinery.
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      // The agent, the fleet-level runner-ops App, AND the router App
      // (groundnuty/macf#1074 — a third always-resolved identity on every
      // apply run) all get a PRIOR lock entry so all three take the REUSED
      // path and this test exercises ONLY the CA machinery — no
      // gate-1/gate-2/repo-init/label-creation noise that a fresh CREATE
      // would pull in and that has nothing to do with #978. Mirrors the
      // dispatch-by-appId shape the pre-existing "reuse: fleet.lock already
      // records ca_key AND registry reports present" test above already uses.
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [
          { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
          { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-runner-ops' },
          { role: 'router', app_id: 'app-router', install_id: 'install-router' },
        ],
        fingerprints: { ca_key: 'sha256:deadbeef' },
      };
      const INSTALL_IDS: Record<string, string> = {
        'app-code-agent': 'install-1',
        'app-runner-ops': 'install-runner-ops',
        'app-router': 'install-router',
      };
      const agentDeps: AgentApplyDeps = {
        startManifestFlow: async () => { throw new Error('must not be called — all roles have prior entries'); },
        startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
        exchangeManifestCode: async () => { throw new Error('must not be called'); },
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async (appId) => ({
          status: 'confirmed',
          install: { appId, installId: INSTALL_IDS[appId] ?? 'install-unexpected', appSlug: `demo-fleet-${appId}`, accountLogin: 'groundnuty' },
        }),
        waitForAppInstallation: async () => { throw new Error('must not be called'); },
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {},
      };
      let mintCalled = false;
      const registryWrites: string[] = [];
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDeps, manifestPath, OK_LABELS_REPO_INIT),
        trustDeps: trustDepsFor({
          checkRegistryPresence: async () => 'absent', // exactly what `deactivate` leaves behind
          readVaultCaCert: async () => 'VAULT-RESTORED-CA-CERT-PEM',
          mintCa: async () => {
            mintCalled = true;
            throw new Error('must not be called — a vault-restored cert exists, minting would orphan it');
          },
          createRegistryVariable: async (_registry, _name, value) => {
            registryWrites.push(value);
            return 'created';
          },
        }),
        // groundnuty/macf#1074 — this test's focus is the CA restore, not
        // the routing-client cert (genuinely never minted for this fleet —
        // no `routing_client_key` fingerprint). Report every routing
        // secret as already-present so the unified publisher's now-ALWAYS
        // presence check (never a blanket skip — see the "never-minted-at-
        // all fleets" test) doesn't produce an UNRELATED 'failed' leg that
        // would contaminate this test's `applyExitCode` assertion below.
        routingSecretsDeps: routingSecretsDepsFor({ checkRepoSecretPresence: async () => 'present' }),
      };
      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      // The decisive assertion: the registry leg is ACTUALLY BACK, not merely
      // "the resolve step said restored." A test that only checked
      // `result.ca.resolve.status` would pass even if `publishCaCertLegs`
      // were never reached.
      expect(result.ca.resolve.status).toBe('restored');
      expect(result.ca.registryLeg).toEqual({ status: 'created' });
      expect(result.ca.repoLegs['groundnuty/demo-code']).toEqual({ status: 'created' });
      expect(registryWrites).toEqual(['VAULT-RESTORED-CA-CERT-PEM']);
      expect(result.agents[0]?.identity.status).toBe('reused');
      expect(result.runnerOps.status).toBe('reused');
      expect(result.routerApp.status).toBe('reused');
      // `applyExitCode` gates on `ca.resolve.status === 'failed'` (an
      // explicit equality check, not a closed allowlist of "good" statuses)
      // — a successful restore must NOT make the run exit non-zero. Asserted
      // directly rather than inferred: the issue's own symptom report is
      // that `applyExitCode` correctly returned 1 on the UNFIXED refusal
      // path, so this is the fix's mirror-image proof for the FIXED path.
      expect(applyExitCode(result)).toBe(0);
      // The never-mints property, asserted directly (not merely implied by
      // `mintCa` throwing above — that only proves it WOULD have failed if
      // called; this proves it was never called at all):
      expect(mintCalled).toBe(false);
      // No CA material (restored cert OR the sentinel mint key/cert this
      // file's `trustDepsFor` default would otherwise produce) anywhere in
      // the rendered result:
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('SENTINEL-CA-KEY-PEM');
      expect(serialized).not.toContain('SENTINEL-CA-CERT-PEM');
      expect(result.ca.resolve).not.toHaveProperty('certPem');
      expect(result.ca.resolve).not.toHaveProperty('keyPem');
    });

    it('deactivate-shaped state: vault reachable but has NOTHING for this fleet -> REFUSES exactly like the no-vault case, never mints', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = { schema_version: 1, fleet: 'demo-fleet', agents: [], fingerprints: { ca_key: 'sha256:deadbeef' } };
      let mintCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRegistryPresence: async () => 'absent',
          readVaultCaCert: async () => undefined, // vault decrypted fine, but has no CA entry for THIS fleet
          mintCa: async () => {
            mintCalled = true;
            throw new Error('must not be called');
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(mintCalled).toBe(false);
      expect(result.ca.resolve.status).toBe('failed');
      // Byte-identical to the no-vault refusal text (requirement: "keep
      // today's refusal, unchanged" — see apply-ca.test.ts's dedicated
      // exact-text pin for the full string).
      expect(result.ca.resolve.reason).toMatch(/orphan/);
      expect(result.ca.registryLeg.status).toBe('skipped');
    });

    it('deactivate-shaped state: vault decrypt THROWS -> REFUSES, never propagates, never a false restore', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = { schema_version: 1, fleet: 'demo-fleet', agents: [], fingerprints: { ca_key: 'sha256:deadbeef' } };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRegistryPresence: async () => 'absent',
          readVaultCaCert: async () => {
            throw new Error('simulated: wrong age identity');
          },
        }),
      };
      // Must not reject the whole applyFleet call — resolveCaCert's own
      // "NEVER throws" contract holds even when its injected dep breaks it.
      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.ca.resolve.status).toBe('failed');
      expect(result.ca.resolve.reason).toMatch(/orphan/);
    });

    it('unknown registry presence does NOT attempt a vault read at all -> stays on the honest-unknown refusal, never chases a maybe', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = { schema_version: 1, fleet: 'demo-fleet', agents: [], fingerprints: { ca_key: 'sha256:deadbeef' } };
      let vaultReadCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRegistryPresence: async () => 'unknown',
          readVaultCaCert: async () => {
            vaultReadCalled = true;
            return 'SHOULD-NOT-BE-USED-PEM';
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(vaultReadCalled).toBe(false);
      expect(result.ca.resolve.status).toBe('failed');
      expect(result.ca.resolve.reason).toMatch(/orphan/);
    });

    it('registry already PRESENT (no repair needed) does NOT attempt a vault read at all -> plain reuse, unaffected by #978', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = { schema_version: 1, fleet: 'demo-fleet', agents: [], fingerprints: { ca_key: 'sha256:deadbeef' } };
      let vaultReadCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRegistryPresence: async () => 'present',
          readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM',
          readVaultCaCert: async () => {
            vaultReadCalled = true;
            return 'SHOULD-NOT-BE-USED-PEM';
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(vaultReadCalled).toBe(false);
      // `result.ca.resolve` is the REDACTED `CaApplyOutcome` (fingerprint
      // only, never a raw cert) — see `redactCaResolve`'s own dedicated
      // tests in apply-ca.test.ts for the redaction-boundary assertion.
      expect(result.ca.resolve.status).toBe('reused');
    });

    it('unknown registry presence with no prior lock -> REFUSES to mint (honest-unknown, never guesses)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      let mintCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRegistryPresence: async () => 'unknown',
          mintCa: async () => {
            mintCalled = true;
            throw new Error('must not be called');
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(mintCalled).toBe(false);
      expect(result.ca.resolve.status).toBe('failed');
      expect(result.ca.resolve.reason).toMatch(/never treated as confirmed-present/);
    });

    it('no age recipients -> the CA mint is refused BEFORE it ever runs (mirrors the per-agent §D5 pre-flight)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([], []); // no agents needed — isolates the CA-level refusal
      let mintCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'x', 'y'), manifestPath),
        trustDeps: trustDepsFor({
          mintCa: async () => {
            mintCalled = true;
            throw new Error('must not be called');
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(mintCalled).toBe(false);
      expect(result.ca.resolve.status).toBe('failed');
      expect(result.ca.resolve.reason).toMatch(/age_recipients is empty/);
    });

    it('a fresh mint whose vault write FAILS -> NOTHING is published — every leg reads skipped, the CA key never appears in the registry or any repo', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      let createRegistryCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        vaultDeps: { exists: () => false, encrypt: async () => { throw new Error('simulated disk-full'); } },
        trustDeps: trustDepsFor({
          createRegistryVariable: async () => {
            createRegistryCalled = true;
            return 'created';
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.vault.status).toBe('failed');
      expect(result.ca.resolve.status).toBe('minted'); // the mint itself succeeded — only the vault write failed
      expect(createRegistryCalled).toBe(false); // publish never attempted
      expect(result.ca.registryLeg.status).toBe('skipped');
      expect(result.ca.registryLeg).toMatchObject({ reason: expect.stringContaining('vault write did not succeed') });
      expect(result.ca.repoLegs['groundnuty/demo-code']).toEqual({ status: 'skipped', reason: expect.any(String) });
    });

    it('create-only: a live presence check reporting "already exists" on a create attempt (absent-then-race) is FAILED, never silently accepted', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({ createRegistryVariable: async () => 'exists' }), // presence said 'absent' (default) but create hits a duplicate
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.ca.registryLeg.status).toBe('failed');
      expect(result.ca.registryLeg).toMatchObject({ reason: expect.stringContaining('race') });
    });

    it('routing.runner declared self-hosted -> writes MACF_TRUSTED_ACTORS to every confirmed agent repo, never the control repo', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT, SCI_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath);
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routing).toEqual({
        'groundnuty/demo-code': { status: 'created' },
        'groundnuty/demo-science': { status: 'created' },
      });
    });

    it('routing.runner NOT declared -> the routing map is empty, nothing attempted', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      let createRepoVarCalled = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          createRepoVariable: async (_repo, name) => {
            // Only the CA leg should ever call this — routing must never
            // fire when `routing.runner` isn't declared.
            expect(name).not.toBe('MACF_TRUSTED_ACTORS');
            createRepoVarCalled += 1;
            return 'created';
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routing).toEqual({});
      expect(createRepoVarCalled).toBeGreaterThan(0); // the CA leg DID fire — proves the fake wasn't just unreachable
    });

    // macf#922 — a declared runs_on other than "self-hosted" needs no write
    // at all (matches plan.ts::routingItem's own noop branch).
    it('routing.runner declared with runs_on OTHER than "self-hosted" -> the routing map is empty, nothing attempted', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'ubuntu-latest', warm: 1 } } };
      let createRepoVarCalled = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          createRepoVariable: async (_repo, name) => {
            expect(name).not.toBe('MACF_TRUSTED_ACTORS');
            createRepoVarCalled += 1;
            return 'created';
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routing).toEqual({});
      expect(createRepoVarCalled).toBeGreaterThan(0); // the CA leg DID fire
    });

    it('routing: a repo where the var is ALREADY PRESENT is left untouched (create-only)', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRepoPresence: async (_repo, name) => (name === 'MACF_TRUSTED_ACTORS' ? 'present' : 'absent'),
        }),
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routing['groundnuty/demo-code']).toEqual({ status: 'already-present' });
    });

    // --- groundnuty/macf#1319 — reconcile a PRESENT-but-diverging
    // MACF_TRUSTED_ACTORS, end-to-end through applyFleet. The two-agent
    // manifest here mirrors the live `macf-trial` symptom: adding an agent
    // scales the desired value, but a PRE-EXISTING repo's Actions variable
    // still carries the OLD (narrower) actor list until reconciled. ---
    describe('routing reconciliation (groundnuty/macf#1319 — DR-043 Amendment P row 3 applied to MACF_TRUSTED_ACTORS)', () => {
      it('DECISIVE case 1: a diverging value is reconciled after confirmation, and the outcome names BOTH the observed and declared values', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT, SCI_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        const updateCalls: Array<{ repo: string; name: string; value: string }> = [];
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: {
            ...trustDepsFor({ checkRepoPresence: async (_repo, name) => (name === 'MACF_TRUSTED_ACTORS' ? 'present' : 'absent') }),
            readRepoVariableValue: async () => 'stale-only-code-agent[bot]',
            updateRepoVariable: async (repo, name, value) => {
              updateCalls.push({ repo, name, value });
              return 'updated';
            },
            confirmReconciliation: async () => true,
          },
        };
        const result = await applyFleet(manifest, manifestPath, null, deps);

        // Both agent repos diverge (both start from the same stale fixture
        // value) and both get reconciled to the SAME manifest-derived value.
        expect(updateCalls).toHaveLength(2);
        for (const call of updateCalls) {
          expect(call.name).toBe('MACF_TRUSTED_ACTORS');
          // The mutation-decisive assertion: the WRITTEN value is the
          // DESIRED (manifest-derived) one, never the stale observed one.
          expect(call.value).not.toBe('stale-only-code-agent[bot]');
        }
        expect(result.routing['groundnuty/demo-code']?.status).toBe('updated');
        expect(result.routing['groundnuty/demo-science']?.status).toBe('updated');
        const reason = result.routing['groundnuty/demo-code'] && 'reason' in result.routing['groundnuty/demo-code'] ? result.routing['groundnuty/demo-code'].reason : undefined;
        // The log/reason names BOTH values — an operator reading it can see
        // what changed, not just that "something" changed.
        expect(reason).toContain('stale-only-code-agent[bot]');
        expect(reason).toContain(updateCalls[0]?.value);
      });

      it('DECISIVE case 2: a value that already MATCHES the declared set is untouched — no write, no churn, not even a confirmation call', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        let updateCalled = false;
        let confirmCalled = false;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: {
            ...trustDepsFor({ checkRepoPresence: async (_repo, name) => (name === 'MACF_TRUSTED_ACTORS' ? 'present' : 'absent') }),
            // Must equal buildTrustedActorsValue's actual output for this
            // one-agent manifest — same value the create path would have
            // written, proving "matches" is compared against the REAL
            // desired value, not a placeholder.
            readRepoVariableValue: async () => 'demo-fleet-code-agent[bot]',
            updateRepoVariable: async () => {
              updateCalled = true;
              return 'updated';
            },
            confirmReconciliation: async () => {
              confirmCalled = true;
              return true;
            },
          },
        };
        const result = await applyFleet(manifest, manifestPath, null, deps);

        expect(result.routing['groundnuty/demo-code']).toEqual({ status: 'already-present' });
        expect(updateCalled).toBe(false);
        expect(confirmCalled).toBe(false);
      });

      it('honest-unknown: a value that cannot be re-read is reported (never overwritten, never assumed current)', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        let updateCalled = false;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: {
            ...trustDepsFor({ checkRepoPresence: async (_repo, name) => (name === 'MACF_TRUSTED_ACTORS' ? 'present' : 'absent') }),
            readRepoVariableValue: async () => undefined,
            updateRepoVariable: async () => {
              updateCalled = true;
              return 'updated';
            },
            confirmReconciliation: async () => true,
          },
        };
        const result = await applyFleet(manifest, manifestPath, null, deps);

        expect(result.routing['groundnuty/demo-code']?.status).toBe('skipped');
        expect(updateCalled).toBe(false);
      });

      it('declined confirmation writes nothing', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        let updateCalled = false;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: {
            ...trustDepsFor({ checkRepoPresence: async (_repo, name) => (name === 'MACF_TRUSTED_ACTORS' ? 'present' : 'absent') }),
            readRepoVariableValue: async () => 'stale[bot]',
            updateRepoVariable: async () => {
              updateCalled = true;
              return 'updated';
            },
            confirmReconciliation: async () => false,
          },
        };
        const result = await applyFleet(manifest, manifestPath, null, deps);

        expect(result.routing['groundnuty/demo-code']?.status).toBe('declined');
        expect(updateCalled).toBe(false);
      });

      it('regression: absent -> create is UNAFFECTED by reconciliation (the two paths are independent)', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        let updateCalled = false;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: {
            ...trustDepsFor(), // default: checkRepoPresence -> 'absent' for every var
            readRepoVariableValue: async () => 'should-never-be-read[bot]',
            updateRepoVariable: async () => {
              updateCalled = true;
              return 'updated';
            },
            confirmReconciliation: async () => true,
          },
        };
        const result = await applyFleet(manifest, manifestPath, null, deps);

        expect(result.routing['groundnuty/demo-code']).toEqual({ status: 'created' });
        expect(updateCalled).toBe(false);
      });

      it('every reconciliation dep OMITTED degrades to exactly today\'s create-only behavior (no crash, no change)', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: trustDepsFor({ checkRepoPresence: async (_repo, name) => (name === 'MACF_TRUSTED_ACTORS' ? 'present' : 'absent') }),
        };
        const result = await applyFleet(manifest, manifestPath, null, deps);

        expect(result.routing['groundnuty/demo-code']).toEqual({ status: 'already-present' });
      });
    });

    // --- macf#922 requirement 3 — register-before-route gate ---

    it('groundnuty/macf#993: token supplied, runner never appears within the poll window -> MACF_TRUSTED_ACTORS is NOT written for that repo; the gap is reported as "failed" (not "skipped") with a reason, never silent (macf#929: timeoutMs 0 makes the poll a single check — no real wall-clock wait)', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
        runnerTokenPollOptions: { timeoutMs: 0 },
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      // DECISIVE (groundnuty/macf#993): 'failed', not 'skipped' — a declared
      // runner is REQUIRED, so this leg must fail the whole run via
      // applyExitCode's existing routingBad check.
      expect(result.routing['groundnuty/demo-code']?.status).toBe('failed');
      const leg = result.routing['groundnuty/demo-code'];
      expect(leg && 'reason' in leg ? leg.reason : undefined).toMatch(/MACF_TRUSTED_ACTORS was NOT written/);
    });

    it('runner registration UNKNOWN -> ALSO refuses the write (honest-unknown, never treated as present)', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'unknown' }) }),
        runnerTokenPollOptions: { timeoutMs: 0 },
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routing['groundnuty/demo-code']?.status).toBe('failed'); // groundnuty/macf#993 — was 'skipped'
    });

    it('this gap surfaces through formatApplyResult\'s routing summary as FAILED (groundnuty/macf#993) — visible even under --yes, which skips the pre-approval plan render', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
        runnerTokenPollOptions: { timeoutMs: 0 },
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);
      const rendered = formatApplyResult(result);

      expect(rendered).toContain('groundnuty/demo-code: FAILED —');
      expect(rendered).not.toContain('groundnuty/demo-code: SKIPPED');
      expect(rendered).toContain('MACF_TRUSTED_ACTORS was NOT written');
    });

    // --- macf#924 — the org-admin handover survives end-to-end into the rendered report ---

    it('an org-admin handover (macf#924 — org runner exists, group excludes the repo) renders through formatApplyResult, not just the raw outcome map', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRunnerUsableByRepo: async () => ({
            presence: 'absent',
            handover:
              'An org-level self-hosted runner IS registered in "groundnuty", but its runner group\'s repository-access ' +
              'list excludes "groundnuty/demo-code" — an org admin must add this repo at: ' +
              'https://github.com/organizations/groundnuty/settings/actions/runner-groups/7. This tool cannot perform ' +
              'that step itself (org-admin action; macf#924).',
          }),
        }),
        runnerTokenPollOptions: { timeoutMs: 0 },
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);
      const rendered = formatApplyResult(result);

      expect(rendered).toContain('groundnuty/demo-code: FAILED —'); // groundnuty/macf#993 — was SKIPPED
      expect(rendered).toContain('MACF_TRUSTED_ACTORS was NOT written');
      expect(rendered).toContain('an org admin must add this repo at');
      expect(rendered).toContain('runner-groups/7');
    });

    // --- groundnuty/macf#943 (DR-043 Amendment I2) — the runner-provisioning
    // contract call. The decisive pair `assert-the-wrong-path.md` requires:
    // (1) the call fails -> apply continues AND the call was actually made
    // (not merely "apply survived", which a version that never calls the
    // contract would ALSO satisfy); (2) the call succeeds -> the gate can
    // proceed, and the request carries the shape the contract documents.

    describe('runner-provisioning contract (groundnuty/macf#943)', () => {
      it('DECISIVE 1/2: the contract is UNREACHABLE -> apply CONTINUES (does not throw, returns a full result) AND the call was genuinely attempted — asserted via the captured request, not merely "apply survived"', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        const calls: { url: string; method: string | undefined }[] = [];
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
          runnerTokenPollOptions: { timeoutMs: 0 },
          runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
          runnerPlatformFetch: (async (url: string | URL, init?: RequestInit) => {
            calls.push({ url: String(url), method: init?.method });
            throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
          }) as typeof fetch,
        };

        const result = await applyFleet(manifest, manifestPath, null, deps);

        // The call was ACTUALLY made — this is the assertion a version that
        // never calls the contract at all would fail (assert-the-wrong-path.md:
        // "apply survived" alone is satisfied by never calling it).
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe('POST');
        expect(calls[0]?.url).toBe('http://fake-runner-platform:8088/runners');
        // Non-fatal: apply completed the WHOLE run (control repo synced,
        // vault written) despite the contract being unreachable.
        expect(result.controlRepoSync.status).toBe('pushed');
        expect(result.vault.status).toBe('written');
        // Reported, honestly, as unreachable — never silently "no runners
        // needed" and never conflated with "ok".
        expect(result.runnerProvision['groundnuty/demo-code']).toEqual({
          status: 'unreachable',
          reason: expect.stringContaining('ECONNREFUSED') as unknown as string,
        });
      });

      it('DECISIVE 2/2: the contract SUCCEEDS -> reported ok, the request carries repo/labels-default/warm/fleet, AND includes this run\'s freshly-minted runner-ops credential', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        let capturedBody: unknown;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'present' }) }),
          runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
          runnerPlatformFetch: (async (_url: string | URL, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ ok: true, applied: ['RunnerDeployment'] }), { status: 200 });
          }) as typeof fetch,
        };

        const result = await applyFleet(manifest, manifestPath, null, deps);

        expect(result.runnerProvision['groundnuty/demo-code']).toEqual({ status: 'ok', applied: ['RunnerDeployment'] });
        // No `labels` declared on this fixture's routing.runner -> omitted
        // from the body entirely (the contract applies its own default,
        // which matches ROUTER_EMITTED_LABELS — see runner-platform.ts's doc).
        expect(capturedBody).toEqual({
          repo: 'groundnuty/demo-code',
          warm: 1,
          fleet: 'demo-fleet',
          // agentDepsFor('code-agent', 'created', ...) makes the runner-ops
          // App's OWN create-or-reuse ceremony ALSO resolve 'created' this
          // run (same shared AgentApplyDeps fixture — see baseDeps's doc),
          // so its freshly-exchanged credential is in memory and gets sent.
          credentials: { app_id: 'app-code-agent', installation_id: 'install-1', private_key: 'SENTINEL-PEM-code-agent' },
        });
        // 200 is NOT "usable" on its own (Amendment I2) — the SEPARATE
        // register-before-route gate (deps.trustDeps.checkRunnerUsableByRepo,
        // faked 'present' above) is still what decides the routing write.
        expect(result.routing['groundnuty/demo-code']?.status).toBe('created');
      });

      it('DECISIVE run-2: a REUSED runner-ops outcome still POSTs WITH credentials, sourced from the vault-backed resolveKeyPath fallback (groundnuty/macf#943 follow-up — the run-2 credential-less-POST regression)', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        // Every identity apply-fleet.ts always resolves (agent, runner-ops,
        // router — groundnuty/macf#1074) gets a PRIOR lock entry, so ALL
        // THREE take the REUSED path — this test is about the runner-ops
        // credential fallback specifically, not gate-1/gate-2 noise from an
        // unrelated identity. Mirrors the "deactivate-shaped state" test's
        // dispatch-by-appId shape above.
        const priorLock: FleetLock = {
          schema_version: 1,
          fleet: 'demo-fleet',
          agents: [
            { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
            { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-runner-ops' },
            { role: 'router', app_id: 'app-router', install_id: 'install-router' },
          ],
          fingerprints: { ca_key: 'sha256:deadbeef' },
        };
        const INSTALL_IDS: Record<string, string> = {
          'app-code-agent': 'install-1',
          'app-runner-ops': 'install-runner-ops',
          'app-router': 'install-router',
        };
        // The vault-backed key: a REAL file on disk (not the '/fake.pem'
        // sentinel other REUSED fixtures in this file use), because THIS
        // test asserts the fix actually READS it and threads its content
        // into the request body — a fixture that never wrote a real file
        // would pass even if `readFileSync` were never called.
        const pemDir = mkdtempSync(join(tmpdir(), 'macf-runner-ops-vault-pem-'));
        dirs.push(pemDir);
        const vaultPemPath = join(pemDir, 'runner-ops.pem');
        writeFileSync(vaultPemPath, 'SENTINEL-VAULT-RUNNER-OPS-PEM', 'utf-8');
        const agentDeps: AgentApplyDeps = {
          startManifestFlow: async () => {
            throw new Error('must not be called — every role has a prior entry');
          },
          startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
          exchangeManifestCode: async () => {
            throw new Error('must not be called');
          },
          // Every role's resolveKeyPath resolves to the SAME vault file in
          // this fixture (only runner-ops's content is asserted below) —
          // mirrors `agentDepsFor`'s reused-path convention of one shared
          // resolver across every identity riding the same fixture.
          resolveKeyPath: () => vaultPemPath,
          confirmAppInstallation: async (appId) => ({
            status: 'confirmed',
            install: { appId, installId: INSTALL_IDS[appId] ?? 'install-unexpected', appSlug: `demo-fleet-${appId}`, accountLogin: 'groundnuty' },
          }),
          waitForAppInstallation: async () => {
            throw new Error('must not be called');
          },
          openUrl: async () => {},
          log: () => {},
          writeRecoveryArtifact: async () => {},
        };
        let capturedBody: unknown;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDeps, manifestPath),
          trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'present' }) }),
          runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
          runnerPlatformFetch: (async (_url: string | URL, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }) as typeof fetch,
        };

        const result = await applyFleet(manifest, manifestPath, priorLock, deps);

        expect(result.runnerOps.status).toBe('reused');
        expect(result.runnerProvision['groundnuty/demo-code']).toEqual({ status: 'ok' });
        // The decisive assertion: the BODY actually sent carries credentials
        // sourced from the vault-resolved PEM — not merely "the call
        // happened" (a version that still omits credentials on reuse would
        // ALSO satisfy that weaker assertion).
        expect(capturedBody).toEqual({
          repo: 'groundnuty/demo-code',
          warm: 1,
          fleet: 'demo-fleet',
          credentials: { app_id: 'app-runner-ops', installation_id: 'install-runner-ops', private_key: 'SENTINEL-VAULT-RUNNER-OPS-PEM' },
        });
      });

      it('run-2, resolveKeyPath resolves to an unreadable path: credentials stay honestly omitted, never a thrown error (readFileSync-throws branch)', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        const priorLock: FleetLock = {
          schema_version: 1,
          fleet: 'demo-fleet',
          agents: [
            { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
            { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-runner-ops' },
          ],
          fingerprints: { ca_key: 'sha256:deadbeef' },
        };
        // `agentDepsFor('reused', ...)` sets `resolveKeyPath: () => '/fake.pem'`
        // — this run DOES have a resolveKeyPath (unlike a run with no
        // --vault/--identity-key at all, where the closure is unset entirely
        // — see `runner-platform.test.ts` for that shape at the pure-function
        // level), but the path it resolves to does not exist, exercising the
        // `readFileSync`-throws branch specifically.
        let capturedBody: unknown;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('runner-ops', 'reused', 'app-runner-ops', 'install-runner-ops'), manifestPath),
          trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'present' }) }),
          runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
          runnerPlatformFetch: (async (_url: string | URL, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }) as typeof fetch,
        };

        const result = await applyFleet(manifest, manifestPath, priorLock, deps);

        expect(result.runnerOps.status).toBe('reused');
        expect(result.runnerProvision['groundnuty/demo-code']).toEqual({ status: 'ok' });
        expect(capturedBody).toEqual({ repo: 'groundnuty/demo-code', warm: 1, fleet: 'demo-fleet' }); // no `credentials` key at all
      });

      it('the vault-derived runner-ops PEM is NEVER logged, across the whole run-2 provisioning flow', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        const priorLock: FleetLock = {
          schema_version: 1,
          fleet: 'demo-fleet',
          agents: [
            { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
            { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-runner-ops' },
            { role: 'router', app_id: 'app-router', install_id: 'install-router' },
          ],
          fingerprints: { ca_key: 'sha256:deadbeef' },
        };
        const INSTALL_IDS: Record<string, string> = {
          'app-code-agent': 'install-1',
          'app-runner-ops': 'install-runner-ops',
          'app-router': 'install-router',
        };
        const pemDir = mkdtempSync(join(tmpdir(), 'macf-runner-ops-vault-pem-log-'));
        dirs.push(pemDir);
        const vaultPemPath = join(pemDir, 'runner-ops.pem');
        const SENTINEL_SECRET = 'SENTINEL-VAULT-RUNNER-OPS-PEM-NEVER-LOGGED';
        writeFileSync(vaultPemPath, SENTINEL_SECRET, 'utf-8');
        const logs: string[] = [];
        const agentDeps: AgentApplyDeps = {
          startManifestFlow: async () => {
            throw new Error('must not be called — every role has a prior entry');
          },
          startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
          exchangeManifestCode: async () => {
            throw new Error('must not be called');
          },
          resolveKeyPath: () => vaultPemPath,
          confirmAppInstallation: async (appId) => ({
            status: 'confirmed',
            install: { appId, installId: INSTALL_IDS[appId] ?? 'install-unexpected', appSlug: `demo-fleet-${appId}`, accountLogin: 'groundnuty' },
          }),
          waitForAppInstallation: async () => {
            throw new Error('must not be called');
          },
          openUrl: async () => {},
          log: () => {},
          writeRecoveryArtifact: async () => {},
        };
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDeps, manifestPath),
          buildAgentDeps: (log) => ({ ...agentDeps, log }),
          trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'present' }) }),
          runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
          runnerPlatformFetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
          log: (l) => logs.push(l),
        };

        const result = await applyFleet(manifest, manifestPath, priorLock, deps);

        expect(result.runnerOps.status).toBe('reused');
        expect(result.runnerProvision['groundnuty/demo-code']).toEqual({ status: 'ok' });
        expect(logs.join('\n')).not.toContain(SENTINEL_SECRET);
      });

      it('the call is attempted regardless of whether --runner-token was supplied, AND — groundnuty/macf#1212 — a repo THIS run successfully provisioned waits unconditionally, reporting PENDING (never failed) on the bounded wait\'s timeout, with no --runner-token involved at all', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        let fetchCalled = false;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          runnerToken: undefined,
          // Decoupled from the mocked provisioning-ok fetch below —
          // demonstrates the routing outcome is governed by ITS OWN
          // observation (checkRunnerUsableByRepo), never by whether
          // provisioning happened to report 'ok' this run.
          trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
          runnerTokenPollOptions: { timeoutMs: 0 },
          runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
          runnerPlatformFetch: (async () => {
            fetchCalled = true;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }) as typeof fetch,
        };

        const result = await applyFleet(manifest, manifestPath, null, deps);

        expect(fetchCalled).toBe(true); // provisioning still attempted, no token needed for that either
        expect(result.runnerProvision['groundnuty/demo-code']?.status).toBe('ok');
        // groundnuty/macf#1212 (operator ruling, overriding #929/#1195's
        // token-licenses-waiting split for exactly this case): apply itself
        // requested this runner, so it waits regardless of --runner-token —
        // here the wait's own budget (timeoutMs: 0, via
        // runnerTokenPollOptions above) is exhausted before GitHub confirms
        // it, which is an honest 'pending', NEVER 'failed'. No --runner-token
        // wording appears anywhere in the reason, because none was consulted.
        expect(result.routing['groundnuty/demo-code']?.status).toBe('pending');
        const reason = (result.routing['groundnuty/demo-code'] as { reason: string }).reason;
        expect(reason).not.toContain('--runner-token');
        expect(reason).toContain('0s'); // the elapsed/budget the ruling requires stating
      });

      describe('groundnuty/macf#1212 — the unconditional provisioned-runner wait, end-to-end through applyFleet', () => {
        it('DECISIVE (the resume case): a repo THIS run provisioned, whose runner is ALREADY usable on entry, writes MACF_TRUSTED_ACTORS with NO wait at all — indistinguishable from a fresh run, no --runner-token needed', async () => {
          const manifestPath = manifestPathIn();
          const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
          let usabilityCalls = 0;
          const deps: FleetApplyDeps = {
            ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
            runnerToken: undefined,
            trustDeps: trustDepsFor({
              checkRunnerUsableByRepo: async () => {
                usabilityCalls += 1;
                return { presence: 'present' };
              },
            }),
            runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
            // Serves BOTH the POST /runners provisioning call and (were it
            // ever consulted) a GET /runners/{owner}/{repo} status read
            // identically — it never needs to be, since
            // checkRunnerUsableByRepo already reports 'present' on the
            // FIRST check, so the wait resolves before the advisory
            // platform-status read is ever reached.
            runnerPlatformFetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
          };

          const result = await applyFleet(manifest, manifestPath, null, deps);

          expect(result.runnerProvision['groundnuty/demo-code']?.status).toBe('ok');
          expect(result.routing['groundnuty/demo-code']).toEqual({ status: 'created' });
          expect(usabilityCalls).toBe(1); // one live check, no retry loop entered
        });

        it('a terminal runner-platform failure (FailedUpdateRegistrationToken) surfaces as a genuine FAILED routing leg, not pending, and not polled through', async () => {
          const manifestPath = manifestPathIn();
          const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
          const deps: FleetApplyDeps = {
            ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
            runnerToken: undefined,
            trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
            runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
            runnerPlatformFetch: (async (_url: string | URL, init?: RequestInit) => {
              // POST /runners (the provisioning call) always succeeds; the
              // LATER GET /runners/{owner}/{repo} (the status read the wait
              // consults) is what reports the terminal failure — mirrors the
              // real contract, where a controller-side credential gap lets
              // the POST accept the object but the runner never registers.
              if (init?.method === 'GET' || init === undefined) {
                return new Response(
                  JSON.stringify({
                    ok: false,
                    repo: 'groundnuty/demo-code',
                    available: 0,
                    note: 'NOT starting: FailedUpdateRegistrationToken. This is not a startup delay — polling will not clear it.',
                    failure: { reason: 'FailedUpdateRegistrationToken', message: 'Updating registration token failed' },
                  }),
                  { status: 404 },
                );
              }
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }) as typeof fetch,
          };

          const result = await applyFleet(manifest, manifestPath, null, deps);

          expect(result.runnerProvision['groundnuty/demo-code']?.status).toBe('ok');
          expect(result.routing['groundnuty/demo-code']?.status).toBe('failed');
          const reason = (result.routing['groundnuty/demo-code'] as { reason: string }).reason;
          expect(reason).toContain('FailedUpdateRegistrationToken');
          expect(reason).toContain('not a startup delay');
        });

        it('a repo NOT provisioned this run (POST unreachable) keeps the pre-#1212 #1195 single-check path UNCHANGED — no token, one check, refuses honestly, never enters the new wait', async () => {
          const manifestPath = manifestPathIn();
          const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
          let usabilityCalls = 0;
          const deps: FleetApplyDeps = {
            ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
            runnerToken: undefined,
            trustDeps: trustDepsFor({
              checkRunnerUsableByRepo: async () => {
                usabilityCalls += 1;
                return { presence: 'absent' };
              },
            }),
            runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
            runnerPlatformFetch: (async () => {
              throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
            }) as typeof fetch,
          };

          const result = await applyFleet(manifest, manifestPath, null, deps);

          // Provisioning itself failed (unreachable) -> this repo never
          // enters provisionedNowRepos -> the ORIGINAL #1195 no-token,
          // single-check path handles it, byte-unchanged.
          expect(result.runnerProvision['groundnuty/demo-code']?.status).toBe('unreachable');
          expect(result.routing['groundnuty/demo-code']?.status).toBe('failed');
          const reason = (result.routing['groundnuty/demo-code'] as { reason: string }).reason;
          expect(reason).toContain('--runner-token'); // the #1195 no-token wording, NOT the #1212 pending wording
          expect(usabilityCalls).toBe(1); // exactly one check — never a retry loop
        });
      });

      it('routing.runner NOT declared (hosted-runner fleet) -> the contract is NEVER called, and runnerProvision is empty', async () => {
        const manifestPath = manifestPathIn();
        const manifest = manifestWith([CODE_AGENT]); // no routing: section at all
        let fetchCalled = false;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          runnerPlatformEndpoint: 'http://fake-runner-platform:8088',
          runnerPlatformFetch: (async () => {
            fetchCalled = true;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }) as typeof fetch,
        };

        const result = await applyFleet(manifest, manifestPath, null, deps);

        expect(fetchCalled).toBe(false);
        expect(result.runnerProvision).toEqual({});
      });

      it('endpoint NOT configured (production default) -> not-configured, non-fatal, apply still completes', async () => {
        const manifestPath = manifestPathIn();
        const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
          runnerTokenPollOptions: { timeoutMs: 0 },
          // runnerPlatformEndpoint / runnerPlatformFetch deliberately unset —
          // this test asserts the honest production default (no env var set
          // in this process either, per the top-of-file GH_TOKEN-class env
          // neutralization — MACF_RUNNER_PLATFORM_ENDPOINT is never touched
          // by that guard, so assert it is genuinely unset first).
        };
        expect(process.env['MACF_RUNNER_PLATFORM_ENDPOINT']).toBeUndefined();

        const result = await applyFleet(manifest, manifestPath, null, deps);

        expect(result.runnerProvision['groundnuty/demo-code']?.status).toBe('not-configured');
        expect(result.controlRepoSync.status).toBe('pushed'); // non-fatal — the whole run still completed
      });

      describe('endpoint resolution precedence (groundnuty/macf#1211)', () => {
        it('scope tier (observedRunnerPlatformEndpointScope) is honored when flag/env are absent, and provenance is logged', async () => {
          const manifestPath = manifestPathIn();
          const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
          const logs: string[] = [];
          // groundnuty/macf#1212 — a successful POST now triggers an
          // unconditional wait that ALSO calls through `runnerPlatformFetch`
          // (checkRunnerPlatformStatus's GET) — capture every call rather
          // than a single mutable `capturedUrl`, so this test asserts on the
          // PROVISIONING call specifically, not whichever call happened last.
          const calls: { url: string; method: string | undefined }[] = [];
          const deps: FleetApplyDeps = {
            ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
            trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
            runnerTokenPollOptions: { timeoutMs: 0 },
            log: (l) => logs.push(l),
            // flag/env deliberately unset — this is the scope-only case.
            observedRunnerPlatformEndpointScope: 'http://scope-runner-platform:8088',
            runnerPlatformFetch: (async (url: string | URL, init?: RequestInit) => {
              calls.push({ url: String(url), method: init?.method });
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }) as typeof fetch,
          };
          expect(process.env['MACF_RUNNER_PLATFORM_ENDPOINT']).toBeUndefined();

          const result = await applyFleet(manifest, manifestPath, null, deps);

          const provisionCall = calls.find((c) => c.method === 'POST');
          expect(provisionCall?.url).toBe('http://scope-runner-platform:8088/runners');
          expect(result.runnerProvision['groundnuty/demo-code']?.status).toBe('ok');
          const provenanceLine = logs.find((l) => l.includes('Runner platform endpoint:'));
          expect(provenanceLine).toMatch(/scope/i);
          expect(provenanceLine).toContain('http://scope-runner-platform:8088');
        });

        it('manifest tier (transport.runner_platform_endpoint) is honored when flag/env/scope are ALL absent — the last resort before none', async () => {
          const manifestPath = manifestPathIn();
          const base = manifestWith([CODE_AGENT]);
          const manifest: FleetManifest = {
            ...base,
            transport: { ...base.transport, runner_platform_endpoint: 'http://manifest-runner-platform:8088' },
            routing: { runner: { runs_on: 'self-hosted', warm: 1 } },
          };
          const logs: string[] = [];
          // groundnuty/macf#1212 — see the scope-tier test's own comment
          // immediately above for why every call is captured, not just the
          // last one.
          const calls: { url: string; method: string | undefined }[] = [];
          const deps: FleetApplyDeps = {
            ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
            trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
            runnerTokenPollOptions: { timeoutMs: 0 },
            log: (l) => logs.push(l),
            // flag/env/scope deliberately unset.
            runnerPlatformFetch: (async (url: string | URL, init?: RequestInit) => {
              calls.push({ url: String(url), method: init?.method });
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }) as typeof fetch,
          };
          expect(process.env['MACF_RUNNER_PLATFORM_ENDPOINT']).toBeUndefined();

          const result = await applyFleet(manifest, manifestPath, null, deps);

          const provisionCall = calls.find((c) => c.method === 'POST');
          expect(provisionCall?.url).toBe('http://manifest-runner-platform:8088/runners');
          expect(result.runnerProvision['groundnuty/demo-code']?.status).toBe('ok');
          const provenanceLine = logs.find((l) => l.includes('Runner platform endpoint:'));
          expect(provenanceLine).toContain('transport.runner_platform_endpoint');
        });

        it('DECISIVE: flag (deps.runnerPlatformEndpoint) wins over BOTH scope and manifest when all three are supplied — most-explicit-wins', async () => {
          const manifestPath = manifestPathIn();
          const base = manifestWith([CODE_AGENT]);
          const manifest: FleetManifest = {
            ...base,
            transport: { ...base.transport, runner_platform_endpoint: 'http://manifest-runner-platform:8088' },
            routing: { runner: { runs_on: 'self-hosted', warm: 1 } },
          };
          // groundnuty/macf#1212 — see the scope-tier test's own comment
          // above for why every call is captured, not just the last one.
          const calls: { url: string; method: string | undefined }[] = [];
          const deps: FleetApplyDeps = {
            ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
            trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
            runnerTokenPollOptions: { timeoutMs: 0 },
            runnerPlatformEndpoint: 'http://flag-runner-platform:8088',
            observedRunnerPlatformEndpointScope: 'http://scope-runner-platform:8088',
            runnerPlatformFetch: (async (url: string | URL, init?: RequestInit) => {
              calls.push({ url: String(url), method: init?.method });
              return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }) as typeof fetch,
          };

          await applyFleet(manifest, manifestPath, null, deps);

          const provisionCall = calls.find((c) => c.method === 'POST');
          expect(provisionCall?.url).toBe('http://flag-runner-platform:8088/runners');
        });

        it("the resolved endpoint is never masked in apply's own log line — it is a variable, not a secret", async () => {
          const manifestPath = manifestPathIn();
          const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
          const logs: string[] = [];
          const deps: FleetApplyDeps = {
            ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
            trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
            runnerTokenPollOptions: { timeoutMs: 0 },
            log: (l) => logs.push(l),
            observedRunnerPlatformEndpointScope: 'http://orzech-dev-agents-monitoring.tail491af.ts.net:8088',
            runnerPlatformFetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
          };

          await applyFleet(manifest, manifestPath, null, deps);

          const joined = logs.join('\n');
          expect(joined).toContain('http://orzech-dev-agents-monitoring.tail491af.ts.net:8088');
          expect(joined).not.toMatch(/\*{3,}|REDACTED|\[hidden\]/i);
        });
      });
    });

    it('CA + routing legs are skipped for an agent whose repo-ensure FAILED this run — nothing is written to a repo that does not exist', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT, SCI_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const agentRepoDeps: AgentRepoDeps = {
        checkMeta: async (repo) => (repo === 'groundnuty/demo-code' ? { presence: 'unknown' } : { presence: 'absent' }), // code-agent's repo-ensure fails
        createRepo: async () => {},
        unarchiveRepo: async () => {},
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        agentRepoDeps,
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents.find((a) => a.role === 'code-agent')?.identity.status).toBe('failed');
      expect(result.ca.repoLegs['groundnuty/demo-code']).toBeUndefined();
      expect(result.routing['groundnuty/demo-code']).toBeUndefined();
      // science-agent's repo WAS ensured — its legs still ran.
      expect(result.ca.repoLegs['groundnuty/demo-science']).toEqual({ status: 'created' });
      expect(result.routing['groundnuty/demo-science']).toEqual({ status: 'created' });
    });

    // --- macf#929 — the runner-token gate itself, wired end-to-end through applyFleet ---

    it('groundnuty/macf#1195 DECISIVE: no runner-token supplied but a runner IS confirmed usable -> proceeds and WRITES MACF_TRUSTED_ACTORS for every confirmed repo', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT, SCI_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      let checkRunnerCalled = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRunnerUsableByRepo: async () => {
            checkRunnerCalled += 1;
            return { presence: 'present' };
          },
        }),
        runnerToken: undefined,
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      // This is the case the OLD flag-only refusal got wrong: a live,
      // confirmed-usable runner, no token supplied — a token is for
      // REGISTERING a runner, never for USING one that already exists.
      expect(result.routing['groundnuty/demo-code']).toEqual({ status: 'created' });
      expect(result.routing['groundnuty/demo-science']).toEqual({ status: 'created' });
      // Consults the EXISTING observation seam once per repo — never zero
      // (the old, now-corrected shape), never a poll (nothing licenses
      // waiting without a token).
      expect(checkRunnerCalled).toBe(2);
    });

    it('macf#929: no runner-token supplied AND no runner confirmed usable -> refuses EVERY confirmed repo ("failed", not "skipped"), naming --runner-token, ONLY AFTER a live check', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT, SCI_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      let checkRunnerCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRunnerUsableByRepo: async () => {
            checkRunnerCalled = true;
            return { presence: 'absent' };
          },
        }),
        runnerToken: undefined,
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routing['groundnuty/demo-code']?.status).toBe('failed');
      expect(result.routing['groundnuty/demo-science']?.status).toBe('failed');
      const leg = result.routing['groundnuty/demo-code'];
      const reason = leg && 'reason' in leg ? leg.reason : undefined;
      expect(reason).toContain('--runner-token');
      expect(reason).toContain('MACF_BOOTSTRAP_RUNNER_TOKEN');
      expect(reason).toContain('gh api -X POST /orgs/<org>/actions/runners/registration-token --jq .token');
      // groundnuty/macf#1195 — the check IS attempted (that is the fix); the
      // refusal is now EVIDENCED by a live read, never assumed from the
      // flag alone.
      expect(checkRunnerCalled).toBe(true);
    });

    it('macf#929: token supplied but the runner never appears within the poll window -> a SEPARATE, more specific reason than the no-token refusal, and the write seam is never invoked', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      let createRepoVarCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRunnerUsableByRepo: async () => ({ presence: 'absent' }),
          createRepoVariable: async (_repo, name) => {
            if (name === 'MACF_TRUSTED_ACTORS') createRepoVarCalled = true;
            return 'created';
          },
        }),
        runnerTokenPollOptions: { timeoutMs: 0 },
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      // groundnuty/macf#993 — 'failed', not 'skipped'.
      expect(result.routing['groundnuty/demo-code']).toEqual({
        status: 'failed',
        reason: expect.stringContaining('a runner registration token was supplied'),
      });
      expect(createRepoVarCalled).toBe(false);
    });

    it('macf#929: token supplied AND the runner appears MID-WINDOW (absent, then present) -> the poll succeeds and the var is written — no real wall-clock wait (pollIntervalMs 0)', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      let checkCalls = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        // macf#972 — a repo CREATED this run skips the retry-with-sleep poll
        // entirely (nothing provisions a runner in-band yet; see
        // `apply-routing.ts::publishTrustedActorsGated`'s `justCreatedRepos`
        // doc), so a genuine "appears mid-window" recovery is only exercised
        // for a repo that PRE-EXISTED the run — a runner may legitimately be
        // registering to it already. Mark the repo present-before-this-run.
        agentRepoDeps: { checkMeta: async () => ({ presence: 'present', archived: false }), createRepo: async () => {}, unarchiveRepo: async () => {} },
        trustDeps: trustDepsFor({
          checkRunnerUsableByRepo: async () => {
            checkCalls += 1;
            return checkCalls < 3 ? { presence: 'absent' } : { presence: 'present' };
          },
        }),
        runnerTokenPollOptions: { timeoutMs: 60_000, pollIntervalMs: 0 },
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routing['groundnuty/demo-code']).toEqual({ status: 'created' });
      expect(checkCalls).toBe(3);
    });

    it('macf#972: token supplied, repo CREATED THIS RUN, no runner -> immediate skip with ZERO poll iterations (checkRunnerUsableByRepo called exactly once, never retried) — the decisive test', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      let checkCalls = 0;
      const deps: FleetApplyDeps = {
        // agentRepoDepsFor() default (via baseDeps) reports every repo
        // 'absent' -> ensureAgentRepo CREATES it this run.
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRunnerUsableByRepo: async () => {
            checkCalls += 1;
            return { presence: 'absent' };
          },
        }),
        // A real 10-minute default budget (`runnerTokenPollOptions` left
        // UNSET, same as production) — if the fast path fell through to a
        // real poll, this test would hang for 10 real minutes. It resolves
        // instantly, proving no poll loop was entered.
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      // groundnuty/macf#993 — 'failed', not 'skipped'.
      expect(result.routing['groundnuty/demo-code']?.status).toBe('failed');
      const leg = result.routing['groundnuty/demo-code'];
      expect(leg && 'reason' in leg ? leg.reason : undefined).toMatch(/MACF_TRUSTED_ACTORS was NOT written/);
      // The decisive assertion: exactly ONE call, not the ~200 a 600s/3s poll
      // would produce, and not zero (a single LIVE check still runs — it's
      // the RETRY LOOP that's skipped, never the one-shot presence read; see
      // the sibling "usable runner present" test below for why that matters).
      expect(checkCalls).toBe(1);
    });

    it('macf#972: token supplied, repo CREATED THIS RUN, but a runner IS already usable at t=0 -> still writes MACF_TRUSTED_ACTORS exactly as today', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      let checkCalls = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor({
          checkRunnerUsableByRepo: async () => {
            checkCalls += 1;
            // e.g. an org-wide "All repositories" runner group, registered
            // before this run — already usable for a brand-new repo at t=0.
            return { presence: 'present' };
          },
        }),
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routing['groundnuty/demo-code']).toEqual({ status: 'created' });
      expect(checkCalls).toBe(1);
    });

    it('macf#972: a poll longer than ~30s emits at least one progress line naming elapsed/total on the log stream — never on stdout/--json', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const lines: string[] = [];
      let clock = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        // Pre-existing repo -> the real poll loop runs (see the mid-window
        // test above for why a just-created repo never reaches it).
        agentRepoDeps: { checkMeta: async () => ({ presence: 'present', archived: false }), createRepo: async () => {}, unarchiveRepo: async () => {} },
        trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
        log: (line) => lines.push(line),
        runnerTokenPollOptions: {
          timeoutMs: 90_000,
          pollIntervalMs: 10_000,
          progressIntervalMs: 30_000,
          now: () => clock,
          sleepFn: async (ms) => {
            clock += ms;
          },
        },
      };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routing['groundnuty/demo-code']?.status).toBe('failed'); // groundnuty/macf#993 — was 'skipped'
      const progressLines = lines.filter((l) => l.includes('waiting for a usable self-hosted runner'));
      expect(progressLines.length).toBeGreaterThan(0);
      expect(progressLines[0]).toMatch(/\d+s\/90s elapsed; nothing for you to do/);
    });

    it('macf#929: the token itself never appears in the JSON-renderable result, the fleet.lock written to disk, or the fleet.yaml committed to the control repo — refused, poll-exhausted, AND written paths all checked', async () => {
      const SECRET = 'ghr-SENTINEL-929-TOKEN-MUST-NEVER-LEAK';
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };

      // Path 1: poll-exhausted (token supplied, never confirmed usable) — the
      // token licenses the ATTEMPT, but its VALUE must never appear anywhere,
      // only the flag/env-var NAMES (see noRunnerTokenReason's doc).
      const exhaustedManifestPath = manifestPathIn();
      const exhausted = await applyFleet(manifest, exhaustedManifestPath, null, {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), exhaustedManifestPath),
        trustDeps: trustDepsFor({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
        runnerToken: SECRET,
        runnerTokenPollOptions: { timeoutMs: 0 },
      });
      expect(exhausted.routing['groundnuty/demo-code']?.status).toBe('failed'); // groundnuty/macf#993 — was 'skipped'
      expect(JSON.stringify(exhausted)).not.toContain(SECRET);
      expect(readFileSync(exhausted.lockPath, 'utf-8')).not.toContain(SECRET);
      // `manifestPath` IS the committed fleet.yaml's path here — `baseDeps`
      // pins `controlRepoOptions.makeScratchDir` to `dirname(manifestPath)`,
      // and `provisionControlRepo`'s CREATE path writes `fleet.yaml` into
      // that SAME dir (see control-repo.ts's `readManifestSourceOrFallback` +
      // its CREATE branch) — reading it back proves the ACTUAL committed
      // bytes, not just an inspection of the code that produces them.
      expect(readFileSync(exhaustedManifestPath, 'utf-8')).not.toContain(SECRET);

      // Path 2: token supplied, runner confirmed usable, write SUCCEEDS — the
      // happy path must ALSO never leak the token (the write's `value` arg is
      // `buildTrustedActorsValue(...)`, never the token — this pins that by
      // observation, not by reading the source).
      const writtenManifestPath = manifestPathIn();
      const written = await applyFleet(manifest, writtenManifestPath, null, {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), writtenManifestPath),
        runnerToken: SECRET,
      });
      expect(written.routing['groundnuty/demo-code']).toEqual({ status: 'created' });
      expect(JSON.stringify(written)).not.toContain(SECRET);
      expect(readFileSync(written.lockPath, 'utf-8')).not.toContain(SECRET);
      expect(readFileSync(writtenManifestPath, 'utf-8')).not.toContain(SECRET);
    });
  });

  // --- groundnuty/macf#920 — THE DECISIVE TEST: is the resulting fleet ROUTABLE? ---
  //
  // Per-primitive tests (repo-init's `tokenSource` threading, the
  // routing-client mint/publish ceremony) can't catch this bug's actual
  // shape — BOTH primitives already worked in isolation and were simply
  // never invoked from `apply` (macf#862/macf#913's class). Only an
  // end-to-end assertion that the SAME fleet a real operator would run
  // through `apply` ends up with (a) the label set `route-by-label` +
  // `route-by-pr-review-state` dispatch on and (b) a routing-client identity
  // the router can present, proves the wiring, not just the primitives.
  //
  // Deliberately does NOT fake `deps.repoInitDeps.repoInit` — the REAL
  // `repoInit()` (`commands/repo-init.ts`) runs, for real, against a scratch
  // clone; only `globalThis.fetch` (the GitHub REST leaf `createLabel` calls)
  // is intercepted, and `GH_TOKEN` is set ambient so `generateToken` (real,
  // from `@groundnuty/macf-core`) resolves a token WITHOUT needing a real
  // `gh token generate` subprocess/network call — the exact same technique
  // `repo-init.test.ts`'s own "repoInit integration" happy-path tests use.
  // This is stabilizing an INPUT to the real seam, not swapping out the
  // function under test (a fake `repoInit` would be — see this project's
  // own `reference_test_that_constructs_the_seam_it_should_observe` lesson).
  describe('the decisive routability test (groundnuty/macf#920)', () => {
    const originalFetch = globalThis.fetch;
    const originalGhToken = process.env['GH_TOKEN'];

    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (originalGhToken === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = originalGhToken;
    });

    it('after a freshly-CREATED agent, the resulting fleet has BOTH the router label set AND a routing-client identity — a green exit actually means routable', async () => {
      process.env['GH_TOKEN'] = 'ghs_e2e-decisive-test-token';

      const labelPosts: { url: string; body: unknown; auth: unknown }[] = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        if (String(url).includes('/labels')) {
          labelPosts.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>)?.['Authorization'] });
          return { status: 201, ok: true } as Response;
        }
        // Any other call (e.g. macf-actions tag resolution) — inert 200.
        return { status: 200, ok: true, json: async () => [] } as unknown as Response;
      }) as typeof fetch;

      const routingClientCalls: { repo: string; name: string; value: string }[] = [];
      const mintCalls: { caCertPem: string; caKeyPem: string }[] = [];
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      // groundnuty/macf#943 — this test's own focus is agent routability, not
      // the runner-ops. `manifestWith([CODE_AGENT])` declares no self-hosted
      // routing, so as of groundnuty/macf#1083 the runner-ops App is
      // `'not-needed'` and never even reaches gate 2 with this fixture — one
      // fewer unrelated identity that could spuriously flip THIS test's
      // "green exit ⇒ routable" assertion below. `repositorySelection:
      // 'selected'` on `waitForAppInstallation` remains here for the
      // code-agent's OWN gate 2.
      const codeAgentDeps: AgentApplyDeps = {
        ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
        waitForAppInstallation: async (opts) => ({
          appId: opts.appId,
          installId: 'install-1',
          appSlug: opts.expected.appSlug ?? 'demo-fleet-code-agent',
          accountLogin: 'groundnuty',
          repositorySelection: 'selected',
        }),
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(codeAgentDeps, manifestPath),
        routingClientDeps: {
          mint: async (caCertPem, caKeyPem) => {
            mintCalls.push({ caCertPem, caKeyPem });
            return { certPem: 'E2E-ROUTING-CLIENT-CERT-PEM', keyPem: 'E2E-ROUTING-CLIENT-KEY-PEM' };
          },
        },
        routingSecretsDeps: routingSecretsDepsFor({
          checkRepoSecretPresence: async () => 'absent',
          setRepoSecret: async (repo, name, value) => {
            routingClientCalls.push({ repo, name, value });
          },
        }),
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      // --- Gap 1: the fleet's repo can be DISPATCHED to (labels exist) ---
      expect(result.agents[0]?.identity.status).toBe('created');
      expect(result.agents[0]?.repoInit?.status).toBe('applied');
      if (result.agents[0]?.repoInit?.status === 'applied') {
        expect(result.agents[0].repoInit.labels).toEqual({
          status: 'ok',
          created: expect.arrayContaining(['code-agent', 'in-progress', 'in-review', 'blocked', 'agent-offline']),
          existed: [],
        });
      }
      // groundnuty/macf#1057 — the control-repo repo-init step now ALSO
      // posts labels for this run's declared agents (here, the SAME single
      // `code-agent` — a 1-agent manifest can't tell the two repos' posts
      // apart by label NAME, only by which repo's `/labels` URL received
      // them). Filter to the AGENT repo's own URL to preserve this test's
      // original intent (the agent's OWN repo-init posted its full label
      // set), then separately confirm the control repo's posts landed too.
      const agentLabelPosts = labelPosts.filter((p) => p.url.includes('/repos/groundnuty/demo-code/'));
      const controlLabelPosts = labelPosts.filter((p) => p.url.includes('/repos/groundnuty/demo-fleet-control/'));
      const postedLabelNames = agentLabelPosts.map((p) => (p.body as { name: string }).name).sort();
      expect(postedLabelNames).toEqual(['agent-offline', 'backlog', 'blocked', 'code-agent', 'in-progress', 'in-review']);
      const controlLabelNames = controlLabelPosts.map((p) => (p.body as { name: string }).name).sort();
      expect(controlLabelNames).toEqual(['agent-offline', 'backlog', 'blocked', 'code-agent', 'in-progress', 'in-review']);
      expect(result.controlRepoInit.status).toBe('written');
      if (result.controlRepoInit.status === 'written') expect(result.controlRepoInit.labels.status).toBe('ok');
      // Every label POST (agent AND control repo) authenticated with the
      // SAME minted token — not a silently-empty/fallback one (the
      // attribution-trap shape).
      for (const post of labelPosts) expect(post.auth).toBe('Bearer ghs_e2e-decisive-test-token');

      // --- Gap 2: the fleet's repo can AUTHENTICATE as the router (routing-client identity exists) ---
      expect(mintCalls).toHaveLength(1);
      expect(mintCalls[0]?.caCertPem).toBe(SENTINEL_CA_CERT_PEM); // the SAME CA this run minted — never a stale/foreign one
      expect(result.routingClient.mint.status).toBe('minted');
      expect(result.routingClient.certLegs['groundnuty/demo-code']).toEqual({ status: 'created' });
      expect(result.routingClient.keyLegs['groundnuty/demo-code']).toEqual({ status: 'created' });
      expect(routingClientCalls).toContainEqual({ repo: 'groundnuty/demo-code', name: 'ROUTING_CLIENT_CERT', value: toBase64ForSecret('E2E-ROUTING-CLIENT-CERT-PEM') });
      expect(routingClientCalls).toContainEqual({ repo: 'groundnuty/demo-code', name: 'ROUTING_CLIENT_KEY', value: toBase64ForSecret('E2E-ROUTING-CLIENT-KEY-PEM') });

      // --- Gap 3 (groundnuty/macf#1071): the CONTROL repo — which carries the
      // SAME router workflow (Gap 1's controlLabelPosts assertion above
      // already proves `controlRepoInit.status === 'written'`) — is ALSO in
      // the routing-client publish TARGET SET, not just the agent repo. Per
      // `assert-the-wrong-path.md`: this checks TARGET-SET MEMBERSHIP (a key
      // present in `certLegs`/`keyLegs`, an actual `setRepoSecret` call for
      // THIS repo) — not merely that `publishRoutingClientSecrets` ran (it
      // already ran for the agent repo above; that alone can't distinguish
      // "control repo also targeted" from "control repo silently excluded,"
      // which is exactly the shape #1071 reports broken.
      expect(result.routingClient.certLegs['groundnuty/demo-fleet-control']).toEqual({ status: 'created' });
      expect(result.routingClient.keyLegs['groundnuty/demo-fleet-control']).toEqual({ status: 'created' });
      expect(routingClientCalls).toContainEqual({ repo: 'groundnuty/demo-fleet-control', name: 'ROUTING_CLIENT_CERT', value: toBase64ForSecret('E2E-ROUTING-CLIENT-CERT-PEM') });
      expect(routingClientCalls).toContainEqual({ repo: 'groundnuty/demo-fleet-control', name: 'ROUTING_CLIENT_KEY', value: toBase64ForSecret('E2E-ROUTING-CLIENT-KEY-PEM') });
      // Exactly TWO repos got legs — the agent repo AND the control repo,
      // never a THIRD stray target and never just one.
      expect(Object.keys(result.routingClient.certLegs).sort()).toEqual(['groundnuty/demo-code', 'groundnuty/demo-fleet-control']);
      expect(Object.keys(result.routingClient.keyLegs).sort()).toEqual(['groundnuty/demo-code', 'groundnuty/demo-fleet-control']);

      // --- The actual acceptance criterion: green exit ⇒ routable, never the reverse ---
      expect(applyExitCode(result)).toBe(0);

      // --- The secret key NEVER appears anywhere a human/log/--json would read it ---
      const rendered = JSON.stringify(fleetApplyResultToJson(result, []));
      expect(rendered).not.toContain('E2E-ROUTING-CLIENT-KEY-PEM');
      expect(rendered).not.toContain('E2E-ROUTING-CLIENT-CERT-PEM'); // not secret, but still never rendered raw — only status/fingerprint-shaped fields
      const humanText = formatApplyResult(result, []);
      expect(humanText).not.toContain('E2E-ROUTING-CLIENT-KEY-PEM');
    });

    it('groundnuty/macf#1071 — when the control repo does NOT carry the router (its repo-init failed this run), it does NOT get routing-client secrets published to it', async () => {
      process.env['GH_TOKEN'] = 'ghs_e2e-decisive-test-token';
      globalThis.fetch = (async () => ({ status: 201, ok: true, json: async () => [] }) as unknown as Response) as typeof fetch;

      const routingClientCalls: { repo: string; name: string; value: string }[] = [];
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const codeAgentDeps: AgentApplyDeps = {
        ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
        waitForAppInstallation: async (opts) => ({
          appId: opts.appId,
          installId: 'install-1',
          appSlug: opts.expected.appSlug ?? 'demo-fleet-code-agent',
          accountLogin: 'groundnuty',
          repositorySelection: 'selected',
        }),
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(codeAgentDeps, manifestPath, {
          cloneRepo: async () => {},
          commitAndPush: async () => 'pushed',
          // Discriminates by target repo — the AGENT repo's own repo-init
          // succeeds normally (real repoInit, since this returns undefined
          // is NOT an option here; call the real one only for the agent
          // repo, and fail ONLY for the control repo) so this test isolates
          // the ONE fact under test: a control repo whose OWN repo-init
          // failed must not become a publish target, while the agent repo
          // (unaffected) still does.
          repoInit: async (dir, opts) => {
            if (opts.repo === 'groundnuty/demo-fleet-control') throw new Error('simulated control-repo repo-init failure');
            return realRepoInit(dir, opts);
          },
        }),
        routingClientDeps: {
          mint: async () => ({ certPem: 'E2E-ROUTING-CLIENT-CERT-PEM', keyPem: 'E2E-ROUTING-CLIENT-KEY-PEM' }),
        },
        routingSecretsDeps: routingSecretsDepsFor({
          checkRepoSecretPresence: async () => 'absent',
          setRepoSecret: async (repo, name, value) => {
            routingClientCalls.push({ repo, name, value });
          },
        }),
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      // Precondition: the control repo's OWN repo-init genuinely failed this run.
      expect(result.controlRepoInit.status).toBe('failed');

      // The agent repo (unaffected by the injected failure) IS still a target.
      expect(result.routingClient.certLegs['groundnuty/demo-code']).toEqual({ status: 'created' });
      expect(routingClientCalls).toContainEqual({ repo: 'groundnuty/demo-code', name: 'ROUTING_CLIENT_CERT', value: toBase64ForSecret('E2E-ROUTING-CLIENT-CERT-PEM') });

      // The control repo is NOT a target — no leg AT ALL (not even a
      // 'skipped'/'failed' one — see `deriveRouterCarryingRepos`'s doc: a
      // repo excluded from the target set never reaches the per-repo loop),
      // and no `setRepoSecret` call for it.
      expect(result.routingClient.certLegs['groundnuty/demo-fleet-control']).toBeUndefined();
      expect(result.routingClient.keyLegs['groundnuty/demo-fleet-control']).toBeUndefined();
      expect(routingClientCalls.some((c) => c.repo === 'groundnuty/demo-fleet-control')).toBe(false);
    });

    it('when label creation genuinely fails (no usable credentials threaded), the run is NOT reported as a clean success', async () => {
      // No GH_TOKEN, no ambient credentials — repoInit's own generateToken()
      // degrades to labels:{status:'skipped'}, and since apply DID thread a
      // tokenSource (the `created` path always does), that is scored a
      // HARD FAILURE — see `apply-repo-init.ts::labelsAreGoodEnough`'s doc.
      delete process.env['GH_TOKEN'];
      globalThis.fetch = (async () => ({ status: 201, ok: true }) as Response) as typeof fetch;

      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath);

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.repoInit?.status).toBe('failed');
      expect(applyExitCode(result)).toBe(1); // NEVER green when the fleet cannot route
    });
  });

  // --- groundnuty/macf#986 — minting is fleet-scoped, publishing is per-repo ---
  //
  // Reproduces the reported live symptom: a working single-agent fleet
  // extended to a SECOND agent. `fleet.lock` already records
  // `routing_client_key` (a PRIOR apply run minted+published it for the
  // FIRST agent's repo); the SECOND agent's repo is CONFIRMED this run but
  // was never a publish target before. `mintRoutingClient` correctly SKIPS
  // (never re-mints — that part always worked); the bug was that the
  // publish loop was skipped ENTIRELY alongside it, so the second repo
  // silently never got the secret even though `apply` exited 0.
  describe('routing-client publish for a repo added AFTER the fleet-level mint (groundnuty/macf#986)', () => {
    const PRIOR_LOCK_TWO_AGENTS: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
        { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-runner-ops' },
        // groundnuty/macf#1074 — the router App gets the SAME REUSED
        // treatment as runner-ops immediately above.
        { role: 'router', app_id: 'app-router', install_id: 'install-router' },
      ],
      fingerprints: { ca_key: 'sha256:deadbeef', routing_client_key: 'sha256:cafef00d' },
    };

    /** Every agent (both roles + runner-ops + router) takes the REUSED path — dispatch by appId, same technique as the "reused / resumed-install" test above. */
    function reusedAgentDeps(): AgentApplyDeps {
      return {
        startManifestFlow: async () => { throw new Error('must not be called — every role has a prior lock entry'); },
        startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
        exchangeManifestCode: async () => { throw new Error('must not be called'); },
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async (appId) => {
          const installId =
            appId === 'app-code-agent' ? 'install-1' : appId === 'app-science-agent' ? 'install-2' : appId === 'app-runner-ops' ? 'install-runner-ops' : 'install-router';
          return { status: 'confirmed', install: { appId, installId, appSlug: `demo-fleet-${appId}`, accountLogin: 'groundnuty' } };
        },
        waitForAppInstallation: async () => { throw new Error('must not be called'); },
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {},
      };
    }

    /** CA already present in the registry -> `resolveCaCert` REUSES (never mints this run) -> `caMintedThisRun === false`, matching the reported live state. */
    function reuseCaTrustDeps(): CaApplyDeps & RunnerRegistrationDeps {
      return trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' });
    }

    it('THE DECISIVE TEST: with --vault/--identity-key wired, the NEW repo gets the secret CREATED and the mint seam (deps.mint) is NEVER called', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      let mintCalled = false;
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      const logs: string[] = [];
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedAgentDeps(), manifestPath, OK_LABELS_REPO_INIT),
        trustDeps: reuseCaTrustDeps(),
        log: (l) => logs.push(l),
        routingClientDeps: {
          mint: async () => {
            mintCalled = true;
            throw new Error('must not be called — a routing_client_key fingerprint is already recorded');
          },
          readVaultRoutingClient: async () => ({ certPem: 'VAULT-RESTORED-CERT-PEM', keyPem: 'VAULT-RESTORED-KEY-PEM' }),
        },
        routingSecretsDeps: routingSecretsDepsFor({
          // code-agent's repo already has it (from the ORIGINAL apply run);
          // science-agent's repo is the one just added — missing it. This
          // test's FOCUS is ROUTING_CLIENT_CERT/KEY specifically, so the
          // router App's OWN two secrets are kept out of the way via
          // `routerAppVaultDeps` below (vault-restored, always available)
          // rather than via this presence stub.
          checkRepoSecretPresence: async (repo) => (repo === 'groundnuty/demo-code' ? 'present' : 'absent'),
          setRepoSecret: async (repo, name, value) => {
            setSecretCalls.push({ repo, name, value });
          },
        }),
        // groundnuty/macf#1074 — the router App is REUSED (PRIOR_LOCK_TWO_AGENTS
        // has a `router` entry); its MACF_ROUTING_APP_ID/KEY publish must not
        // contaminate THIS test's routing-CLIENT-focused assertions below.
        routerAppVaultDeps: { readVaultRouterApp: async () => ({ appId: '997', appKeyPem: 'ROUTER-APP-VAULT-PEM' }) },
      };

      const result = await applyFleet(manifest, manifestPath, PRIOR_LOCK_TWO_AGENTS, deps);

      // Mint decision unchanged — this always worked; asserted as the
      // precondition the rest of this test depends on.
      expect(result.routingClient.mint.status).toBe('skipped');
      // THE decisive assertion: the crypto mint seam was NEVER invoked on
      // the publish-to-new-repo path — the fix reads the vault, it never
      // re-mints.
      expect(mintCalled).toBe(false);

      // Repo already holding it: untouched, reports already-present.
      expect(result.routingClient.certLegs['groundnuty/demo-code']).toEqual({ status: 'already-present' });
      expect(result.routingClient.keyLegs['groundnuty/demo-code']).toEqual({ status: 'already-present' });

      // The NEW repo: actually gets the secret, sourced from the vault-restore.
      expect(result.routingClient.certLegs['groundnuty/demo-science']).toEqual({ status: 'created' });
      expect(result.routingClient.keyLegs['groundnuty/demo-science']).toEqual({ status: 'created' });
      expect(setSecretCalls).toContainEqual({ repo: 'groundnuty/demo-science', name: 'ROUTING_CLIENT_CERT', value: toBase64ForSecret('VAULT-RESTORED-CERT-PEM') });
      expect(setSecretCalls).toContainEqual({ repo: 'groundnuty/demo-science', name: 'ROUTING_CLIENT_KEY', value: toBase64ForSecret('VAULT-RESTORED-KEY-PEM') });
      // The already-provisioned repo is NEVER re-written (create-only, no churn):
      expect(setSecretCalls.some((c) => c.repo === 'groundnuty/demo-code')).toBe(false);

      // A fully-covered fleet is a GREEN exit — the actual acceptance bar
      // (this is the fix's positive mirror of the "no vault" test below,
      // which asserts the run correctly goes RED instead).
      expect(applyExitCode(result)).toBe(0);

      // The vault-restored material NEVER reaches a human/log/--json
      // surface — this is the ONE test in the file where vault-restored
      // (not freshly-minted) key material flows through `applyFleet`, so
      // it needs its OWN leak check; the #920 decisive test above only
      // proves this for a freshly-minted secret.
      const rendered = JSON.stringify(fleetApplyResultToJson(result, []));
      expect(rendered).not.toContain('VAULT-RESTORED-KEY-PEM');
      expect(rendered).not.toContain('VAULT-RESTORED-CERT-PEM');
      const humanText = formatApplyResult(result, []);
      expect(humanText).not.toContain('VAULT-RESTORED-KEY-PEM');
      expect(humanText).not.toContain('VAULT-RESTORED-CERT-PEM');
      const logged = logs.join('\n');
      expect(logged).not.toContain('VAULT-RESTORED-KEY-PEM');
      expect(logged).not.toContain('VAULT-RESTORED-CERT-PEM');
    });

    it('prior mint + new repo + NO vault/--identity-key -> the new repo leg is a LOUD "failed", never a silent "skipped" — and it fails the run', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedAgentDeps(), manifestPath),
        trustDeps: reuseCaTrustDeps(),
        routingClientDeps: {
          mint: async () => { throw new Error('must not be called'); },
          // readVaultRoutingClient deliberately OMITTED — no --vault/--identity-key this run.
        },
        routingSecretsDeps: routingSecretsDepsFor({
          checkRepoSecretPresence: async (repo) => (repo === 'groundnuty/demo-code' ? 'present' : 'absent'),
          setRepoSecret: async () => { throw new Error('must not be called — no material to publish'); },
        }),
      };

      const result = await applyFleet(manifest, manifestPath, PRIOR_LOCK_TWO_AGENTS, deps);

      expect(result.routingClient.mint.status).toBe('skipped');
      // The repo that already has it is unaffected by the missing vault:
      expect(result.routingClient.certLegs['groundnuty/demo-code']).toEqual({ status: 'already-present' });
      // The new repo: LOUD failure, never the old blanket 'skipped':
      expect(result.routingClient.certLegs['groundnuty/demo-science']?.status).toBe('failed');
      expect(result.routingClient.certLegs['groundnuty/demo-science']?.status).not.toBe('skipped');
      if (result.routingClient.certLegs['groundnuty/demo-science']?.status === 'failed') {
        // The DISTINCTIVE hint phrase `resolveRoutingClientSecretsForPublish`
        // appends (not just a loose "mentions --vault somewhere" match,
        // which `mintRoutingClient`'s OWN skip reason would also satisfy —
        // see that function's "already minted" text — and would pass even
        // if this hint were deleted).
        expect(result.routingClient.certLegs['groundnuty/demo-science'].reason).toMatch(
          /Supply both --vault and --identity-key/,
        );
      }
      // Never a silent green exit while a confirmed repo is unroutable:
      expect(applyExitCode(result)).toBe(1);
    });

    // --- groundnuty/macf#1162 — the fleet-level aggregate fact, exercised
    // through the REAL publish pipeline (not hand-built results) — this is
    // what actually proves the `ensureVariableCreated` label-stripping fix
    // (`apply-routing-secrets.ts::stripRepoLegLabel`) works end to end, not
    // just at the pure-function level: every repo's failure reason for the
    // SAME cause is prefixed with THAT repo's own name by
    // `ensureVariableCreated`'s label, and only the strip lets the
    // aggregator see through that to the shared root cause. ---
    it('DECISIVE: every router-carrying repo fails for the SAME underlying cause -> ONE "Fleet-level: ... CANNOT route" log line, additive to (not instead of) the per-repo detail', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const logs: string[] = [];
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedAgentDeps(), manifestPath),
        trustDeps: reuseCaTrustDeps(),
        log: (l) => logs.push(l),
        routingClientDeps: {
          mint: async () => { throw new Error('must not be called — a routing_client_key fingerprint is already recorded'); },
          readVaultRoutingClient: async () => ({ certPem: 'CERT-PEM', keyPem: 'KEY-PEM' }),
        },
        routerAppVaultDeps: { readVaultRouterApp: async () => ({ appId: '997', appKeyPem: 'ROUTER-APP-VAULT-PEM' }) },
        routingSecretsDeps: routingSecretsDepsFor({
          checkRepoSecretPresence: async () => 'absent',
          setRepoSecret: async () => { throw new Error('simulated total routing outage'); },
        }),
      };

      await applyFleet(manifest, manifestPath, PRIOR_LOCK_TWO_AGENTS, deps);

      const fleetLines = logs.filter((l) => l.startsWith('Fleet-level:'));
      expect(fleetLines).toHaveLength(1);
      expect(fleetLines[0]).toContain('CANNOT route');
      // Names the ONE shared cause, not a per-repo-mangled variant of it —
      // proves the label-stripping fix, not just that SOME line fired.
      expect(fleetLines[0]).toContain('simulated total routing outage');
      // Additive, not a replacement — the per-repo detail is STILL there:
      const detailLines = logs.filter((l) => l.includes('" leg (') && l.includes('failed'));
      expect(detailLines.length).toBeGreaterThan(0);
    });

    it('one router-carrying repo already has every secret (untouched); another genuinely fails -> NO "Fleet-level:" line — the negative half that gives the positive half meaning', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const logs: string[] = [];
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedAgentDeps(), manifestPath),
        trustDeps: reuseCaTrustDeps(),
        log: (l) => logs.push(l),
        routingClientDeps: {
          mint: async () => { throw new Error('must not be called — a routing_client_key fingerprint is already recorded'); },
          readVaultRoutingClient: async () => ({ certPem: 'CERT-PEM', keyPem: 'KEY-PEM' }),
        },
        routerAppVaultDeps: { readVaultRouterApp: async () => ({ appId: '997', appKeyPem: 'ROUTER-APP-VAULT-PEM' }) },
        routingSecretsDeps: routingSecretsDepsFor({
          // groundnuty/demo-code ALREADY has every secret (present, no
          // create attempt, no failure); groundnuty/demo-science is absent
          // and genuinely fails to create — a MIXED result, not uniform.
          checkRepoSecretPresence: async (repo) => (repo === 'groundnuty/demo-code' ? 'present' : 'absent'),
          setRepoSecret: async () => { throw new Error('simulated partial outage'); },
        }),
      };

      await applyFleet(manifest, manifestPath, PRIOR_LOCK_TWO_AGENTS, deps);

      // THE assertion this test exists for: no false "always emit" pass —
      // a mixed result must NOT read as a fleet-level fact.
      expect(logs.some((l) => l.startsWith('Fleet-level:'))).toBe(false);
      // "No fleet claim" does not mean "no detail" — the failing repo's
      // OWN row is still reported (per-agent detail stays, per the issue's
      // own requirement).
      expect(logs.some((l) => l.includes('groundnuty/demo-science') && l.includes('failed'))).toBe(true);
    });

    it('groundnuty/macf#1071 — idempotent re-run: a control repo that ALREADY holds the routing-client secrets reports "already-present" for both, never re-minted, never re-written', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLockAlreadyMinted: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [
          { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
          { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-runner-ops' },
          // groundnuty/macf#1074 — the router App gets the SAME REUSED
          // treatment as runner-ops immediately above.
          { role: 'router', app_id: 'app-router', install_id: 'install-router' },
        ],
        fingerprints: { routing_client_key: 'sha256:cafef00d' },
      };
      let mintCalled = false;
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedAgentDeps(), manifestPath, OK_LABELS_REPO_INIT),
        trustDeps: reuseCaTrustDeps(),
        routingClientDeps: {
          mint: async () => {
            mintCalled = true;
            throw new Error('must not be called — a routing_client_key fingerprint is already recorded');
          },
          // readVaultRoutingClient deliberately OMITTED — nothing needs
          // restoring; every repo already has the secret, so `create` is
          // never even reached (`publishRoutingSecrets`'s doc: the
          // presence check runs BEFORE `create` would need material).
        },
        routingSecretsDeps: routingSecretsDepsFor({
          // Every secret, on every repo (the agent repo AND the control
          // repo), already exists — the steady state on a SECOND `apply`
          // run against an otherwise-unchanged fleet.
          checkRepoSecretPresence: async () => 'present',
          setRepoSecret: async (repo, name, value) => {
            setSecretCalls.push({ repo, name, value });
          },
        }),
      };

      const result = await applyFleet(manifest, manifestPath, priorLockAlreadyMinted, deps);

      expect(result.routingClient.mint.status).toBe('skipped');
      expect(mintCalled).toBe(false);

      // Every repo in the target set — the agent repo AND the control
      // repo — reports 'already-present', not re-created and not silently
      // absent from the result at all.
      expect(result.routingClient.certLegs['groundnuty/demo-code']).toEqual({ status: 'already-present' });
      expect(result.routingClient.keyLegs['groundnuty/demo-code']).toEqual({ status: 'already-present' });
      expect(result.routingClient.certLegs['groundnuty/demo-fleet-control']).toEqual({ status: 'already-present' });
      expect(result.routingClient.keyLegs['groundnuty/demo-fleet-control']).toEqual({ status: 'already-present' });

      // THE decisive idempotence proof: never re-minted (asserted above via
      // `mintCalled`), and never re-WRITTEN either — zero `setRepoSecret`
      // calls for ANY repo, agent or control.
      expect(setSecretCalls).toHaveLength(0);
      expect(applyExitCode(result)).toBe(0);
    });

    it('groundnuty/macf#1074 — never-minted-at-all fleets now get a LOUD per-repo presence check too, never the OLD blanket "skipped, exit 0"; a repo genuinely missing the secret fails the run (the exact "green check, dead fleet" gap #1074 closes)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLockNoRoutingClient: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [
          { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
          { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-runner-ops' },
        ],
        // NO fingerprints.routing_client_key — nothing has EVER been minted.
      };
      let presenceChecked = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedAgentDeps(), manifestPath),
        trustDeps: reuseCaTrustDeps(),
        routingClientDeps: {
          mint: async () => { throw new Error('must not be called — CA was reused, not minted, this run'); },
        },
        routingSecretsDeps: routingSecretsDepsFor({
          checkRepoSecretPresence: async () => {
            presenceChecked = true;
            return 'absent';
          },
          setRepoSecret: async () => { throw new Error('must not be called — no material to publish'); },
        }),
      };

      const result = await applyFleet(manifest, manifestPath, priorLockNoRoutingClient, deps);

      expect(result.routingClient.mint.status).toBe('skipped');
      // groundnuty/macf#1074: the unified six-secret publisher ALWAYS checks
      // presence per (repo, name) — "unavailable" only forecloses the
      // create branch, it never skips the check itself (the SAME "never
      // blanket-skip" lesson #986 already established for the
      // prior-mint-exists case, now applied uniformly to EVERY case,
      // including this one). A repo genuinely missing
      // ROUTING_CLIENT_CERT/KEY is unroutable regardless of WHY the value
      // is unavailable this run — reporting it as a benign 'skipped' would
      // be exactly the "green check, dead fleet" gap this issue closes.
      expect(presenceChecked).toBe(true);
      expect(result.routingClient.certLegs['groundnuty/demo-code']?.status).toBe('failed');
      if (result.routingClient.certLegs['groundnuty/demo-code']?.status === 'failed') {
        // `mintRoutingClient`'s exact "no CA minted this run" skip text,
        // now surfacing as the FAILURE reason rather than a skip reason.
        expect(result.routingClient.certLegs['groundnuty/demo-code'].reason).toMatch(/was not freshly minted/);
      }
      // A repo confirmed to lack a secret its router requires is a FAILING
      // run — never a silent green exit (groundnuty/macf#1074's core
      // requirement).
      expect(applyExitCode(result)).toBe(1);
    });
  });

  // --- groundnuty/macf#1109 — the decisive set-membership proof. `apply`
  // published 4 of the 6 router secrets and asked the operator to hand-type
  // TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET even though its OWN vault already
  // carried them — the read was gated on `transport.tailscale_oauth_required`,
  // so a vault that genuinely had the pair was never even consulted when the
  // manifest left that flag undeclared (the common case: an operator setting
  // up a fleet for the first time has no reason to know this flag exists).
  //
  // Per the issue's own decisive-test requirement: assert by SET MEMBERSHIP
  // of the PUBLISHED name set (`created`/`already-present`), never by a
  // count and never by "the publisher was called" — a count of six passes
  // even if the wrong pair got published twice; a call-happened assertion
  // passes even if only four of the six actually landed.
  describe('the unified six-secret publish — decisive set-membership proof (groundnuty/macf#1109)', () => {
    /** code-agent + the router App both take the REUSED path (prior lock entries) — same dispatch-by-appId technique the #986 describe block above uses, trimmed to the two roles this single-agent fixture needs. */
    function reusedIdentityDeps(): AgentApplyDeps {
      return {
        startManifestFlow: async () => { throw new Error('must not be called — every role has a prior lock entry'); },
        startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
        exchangeManifestCode: async () => { throw new Error('must not be called'); },
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async (appId) => {
          const installId = appId === 'app-code-agent' ? 'install-1' : 'install-router';
          return { status: 'confirmed', install: { appId, installId, appSlug: `demo-fleet-${appId}`, accountLogin: 'groundnuty' } };
        },
        waitForAppInstallation: async () => { throw new Error('must not be called'); },
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {},
      };
    }

    it('a vault carrying the Tailscale pair, with transport.tailscale_oauth_required left UNDECLARED (the exact live-defect shape) — yields all SIX secret names PUBLISHED on every router-carrying repo, and TS_OAUTH is not a second path', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]); // tailscale_oauth_required NOT declared — matches the reported live run
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [
          { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
          { role: 'router', app_id: 'app-router', install_id: 'install-router' },
        ],
        fingerprints: { routing_client_key: 'sha256:cafef00d' },
      };
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      let readVaultTsOauthCalls = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedIdentityDeps(), manifestPath, OK_LABELS_REPO_INIT),
        trustDeps: trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' }),
        routingClientDeps: {
          mint: async () => { throw new Error('must not be called — a routing_client_key fingerprint is already recorded'); },
          readVaultRoutingClient: async () => ({ certPem: 'VAULT-CLIENT-CERT-PEM', keyPem: 'VAULT-CLIENT-KEY-PEM' }),
        },
        routerAppVaultDeps: { readVaultRouterApp: async () => ({ appId: '997', appKeyPem: 'ROUTER-APP-VAULT-PEM' }) },
        routingSecretsDeps: {
          // Steady empty state — every repo genuinely lacks every secret —
          // the cleanest possible decisive assertion: every one of the six
          // legs on every repo must show 'created', nothing pre-seeded.
          checkRepoSecretPresence: async () => 'absent',
          setRepoSecret: async (repo, name, value) => {
            setSecretCalls.push({ repo, name, value });
          },
          readVaultTsOauth: async () => {
            readVaultTsOauthCalls += 1;
            return { clientId: 'ts-client-id', secret: 'ts-secret' };
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      // The vault WAS actually consulted — this is the exact defect: the
      // OLD gate never even called `readVaultTsOauth` when the flag was
      // undeclared.
      expect(readVaultTsOauthCalls).toBeGreaterThan(0);

      const routerCarryingRepos = ['groundnuty/demo-code', 'groundnuty/demo-fleet-control'];
      for (const repo of routerCarryingRepos) {
        const publishedNames = new Set(
          (Object.entries(result.routingSecrets) as [string, Record<string, { readonly status: string }>][])
            .filter(([, legs]) => legs[repo]?.status === 'created' || legs[repo]?.status === 'already-present')
            .map(([name]) => name),
        );
        expect(publishedNames).toEqual(new Set(ALL_ROUTING_SECRET_NAMES));
      }

      // Never a second publisher: every `setRepoSecret` call is accounted
      // for by the SAME per-(repo,name) legs asserted above — no stray call
      // for a name outside the six, and TS_OAUTH's two calls are ordinary
      // entries in that one list, not a side channel.
      expect(setSecretCalls.filter((c) => c.name === 'TS_OAUTH_CLIENT_ID' && c.value === 'ts-client-id')).toHaveLength(routerCarryingRepos.length);
      expect(setSecretCalls.filter((c) => c.name === 'TS_OAUTH_SECRET' && c.value === 'ts-secret')).toHaveLength(routerCarryingRepos.length);

      // groundnuty/macf#1112 — the single bundled secret is published
      // ALONGSIDE the six above (never instead of), and unpacks to the
      // SAME six values `setSecretCalls` recorded for the individual form.
      for (const repo of routerCarryingRepos) {
        expect(result.routingBundle[repo]?.status).toBe('created');
      }
      const bundleCall = setSecretCalls.find((c) => c.name === 'MACF_ROUTING_BUNDLE');
      expect(bundleCall).toBeDefined();
      const unpackedBundle = unpackRoutingBundle(bundleCall!.value);
      for (const name of ALL_ROUTING_SECRET_NAMES) {
        const individualCall = setSecretCalls.find((c) => c.repo === bundleCall!.repo && c.name === name);
        expect(individualCall).toBeDefined();
        expect(unpackedBundle[name]).toBe(individualCall!.value);
      }

      // A fully-routable fleet is a green exit.
      expect(applyExitCode(result)).toBe(0);

      // No secret VALUE ever reaches a human/log/--json render surface.
      const rendered = JSON.stringify(fleetApplyResultToJson(result, []));
      expect(rendered).not.toContain('ts-client-id');
      expect(rendered).not.toContain('ts-secret');
      const humanText = formatApplyResult(result, []);
      expect(humanText).not.toContain('ts-client-id');
      expect(humanText).not.toContain('ts-secret');
    });

    it('a vault WITHOUT the Tailscale pair publishes only the other four, and the TS_OAUTH reason states the routing consequence rather than reading as a tidy-up item', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]); // tailscale_oauth_required NOT declared
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [
          { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
          { role: 'router', app_id: 'app-router', install_id: 'install-router' },
        ],
        fingerprints: { routing_client_key: 'sha256:cafef00d' },
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedIdentityDeps(), manifestPath, OK_LABELS_REPO_INIT),
        trustDeps: trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' }),
        routingClientDeps: {
          mint: async () => { throw new Error('must not be called — a routing_client_key fingerprint is already recorded'); },
          readVaultRoutingClient: async () => ({ certPem: 'VAULT-CLIENT-CERT-PEM', keyPem: 'VAULT-CLIENT-KEY-PEM' }),
        },
        routerAppVaultDeps: { readVaultRouterApp: async () => ({ appId: '997', appKeyPem: 'ROUTER-APP-VAULT-PEM' }) },
        routingSecretsDeps: {
          checkRepoSecretPresence: async () => 'absent',
          setRepoSecret: async () => {},
          readVaultTsOauth: async () => undefined, // vault genuinely doesn't have it
        },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      for (const repo of ['groundnuty/demo-code', 'groundnuty/demo-fleet-control']) {
        expect(result.routingSecrets['TS_OAUTH_CLIENT_ID']?.[repo]?.status).toBe('skipped');
        expect(result.routingSecrets['TS_OAUTH_SECRET']?.[repo]?.status).toBe('skipped');
        // The other four ARE published — the absent pair never blocks them.
        expect(result.routingSecrets['MACF_ROUTING_APP_ID']?.[repo]?.status).toBe('created');
        expect(result.routingSecrets['ROUTING_CLIENT_CERT']?.[repo]?.status).toBe('created');
      }
      const clientIdLeg = result.routingSecrets['TS_OAUTH_CLIENT_ID']?.['groundnuty/demo-code'];
      expect(clientIdLeg?.status).toBe('skipped');
      if (clientIdLeg?.status === 'skipped') {
        expect(clientIdLeg.reason).toMatch(/routing will not function/i);
      }
      // groundnuty/macf#1112 — the bundle can't be composed while one of
      // the six is `'not-required'` (never all-six-available this run) —
      // an honest `'skipped'`, same bar the individual TS_OAUTH pair uses,
      // NOT a partial/broken bundle written with a hole in it.
      for (const repo of ['groundnuty/demo-code', 'groundnuty/demo-fleet-control']) {
        expect(result.routingBundle[repo]?.status).toBe('skipped');
      }
      // An undeclared-and-absent pair is an honest skip, never a run-failing gap.
      expect(applyExitCode(result)).toBe(0);
    });

    // --- groundnuty/macf#1186 — CONVERGENCE: an already-provisioned fleet
    // (every identity reused, vault genuinely lacks TS_OAUTH) supplies the
    // pair via `deps.resolvedTsOauth` (the `--ts-oauth-client-id`/
    // `--ts-oauth-secret` flag/env pair) and gets it published to every
    // agent repo — Amendment L's convergence property (`apply` reconciles
    // TOWARD the manifest) applied to a credential the vault never had.
    // Reuses the EXACT `reusedIdentityDeps()`/`priorLock`/mint-throws-if-
    // called harness the sibling tests above already use for "every
    // identity reused" — the decisive negative half here is that NOTHING
    // about that harness needs to change: no new App, no re-minted CA, no
    // vault write, just the routing-secret publish picking up a value from
    // a different source than usual.
    it('CONVERGENCE — resolvedTsOauth (flag/env) supplies the pair for an already-provisioned fleet whose vault lacks it: published to every repo, nothing else touched', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [
          { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
          { role: 'router', app_id: 'app-router', install_id: 'install-router' },
        ],
        fingerprints: { routing_client_key: 'sha256:cafef00d' },
      };
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      let readVaultTsOauthCalls = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedIdentityDeps(), manifestPath, OK_LABELS_REPO_INIT),
        trustDeps: trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' }),
        routingClientDeps: {
          mint: async () => {
            throw new Error('must not be called — a routing_client_key fingerprint is already recorded (no new mint on convergence)');
          },
          readVaultRoutingClient: async () => ({ certPem: 'VAULT-CLIENT-CERT-PEM', keyPem: 'VAULT-CLIENT-KEY-PEM' }),
        },
        routerAppVaultDeps: { readVaultRouterApp: async () => ({ appId: '997', appKeyPem: 'ROUTER-APP-VAULT-PEM' }) },
        // The macf-trial shape: identities + CA + routing-client already
        // provisioned, but the vault genuinely has no TS_OAUTH entry (it
        // was never written there — #1109's dead `payload.routing` field).
        routingSecretsDeps: {
          checkRepoSecretPresence: async () => 'absent',
          setRepoSecret: async (repo, name, value) => {
            setSecretCalls.push({ repo, name, value });
          },
          readVaultTsOauth: async () => {
            readVaultTsOauthCalls += 1;
            return undefined;
          },
        },
        // The flag/env-resolved pair — the ONLY source this run has for it.
        resolvedTsOauth: { clientId: 'flag-client-id', secret: 'flag-secret' },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      // The vault WAS still consulted (each concern gets its own decrypt —
      // this is not a shortcut around the existing read), but came up empty;
      // `resolvedTsOauth` is what actually supplied the value.
      expect(readVaultTsOauthCalls).toBeGreaterThan(0);

      const routerCarryingRepos = ['groundnuty/demo-code', 'groundnuty/demo-fleet-control'];
      expect(setSecretCalls.filter((c) => c.name === 'TS_OAUTH_CLIENT_ID' && c.value === 'flag-client-id')).toHaveLength(routerCarryingRepos.length);
      expect(setSecretCalls.filter((c) => c.name === 'TS_OAUTH_SECRET' && c.value === 'flag-secret')).toHaveLength(routerCarryingRepos.length);
      for (const repo of routerCarryingRepos) {
        expect(result.routingSecrets['TS_OAUTH_CLIENT_ID']?.[repo]?.status).toBe('created');
        expect(result.routingSecrets['TS_OAUTH_SECRET']?.[repo]?.status).toBe('created');
      }

      // The decisive negative half: NOTHING else changed. No new vault
      // write (every identity was reused; `mint`/`startManifestFlow`
      // throwing above already proves no fresh App/routing-client — this
      // additionally proves the vault-write step itself never fires for
      // this run, not merely that its inputs happened to be empty).
      expect(result.vault.status).toBe('skipped');

      expect(applyExitCode(result)).toBe(0);

      // The flag-supplied secret value never reaches a render surface.
      const rendered = JSON.stringify(fleetApplyResultToJson(result, []));
      expect(rendered).not.toContain('flag-client-id');
      expect(rendered).not.toContain('flag-secret');
      const humanText = formatApplyResult(result, []);
      expect(humanText).not.toContain('flag-client-id');
      expect(humanText).not.toContain('flag-secret');
    });
  });

  // --- The runner-ops App (groundnuty/macf#943) ---

  describe('the runner-ops App (groundnuty/macf#943)', () => {
    it('creates it with EXACTLY the three permissions (asserts the manifest actually SENT, not just that a call happened)', async () => {
      const manifestPath = manifestPathIn();
      // groundnuty/macf#1083 — runner-ops is CONDITIONAL as of this issue;
      // every test in this describe block that exercises its create-or-reuse
      // ceremony must declare self-hosted routing so `runnerOpsNeeded` holds.
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const capturedManifests: { name: string; permissions: Record<string, string>; events: readonly string[] }[] = [];
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: (log) => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          log,
          // `buildManifest` is called with the REAL redirect URL at exchange
          // time — capture what it actually produces (the EXACT document
          // this run would submit to GitHub), not a hand-rolled copy.
          startManifestFlow: async (opts) => {
            const built = opts.buildManifest('http://127.0.0.1:9/callback');
            capturedManifests.push({ name: built.name, permissions: built.default_permissions, events: built.default_events });
            return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} };
          },
          waitForAppInstallation: async (opts) => ({
            appId: opts.appId,
            installId: 'install-x',
            appSlug: opts.expected.appSlug ?? '',
            accountLogin: 'groundnuty',
            repositorySelection: 'selected',
          }),
        }),
      };

      await applyFleet(manifest, manifestPath, null, deps);

      const rrManifest = capturedManifests.find((m) => m.name === 'demo-fleet-runner-ops');
      expect(rrManifest).toBeDefined();
      // The exact three permissions — no more, no fewer.
      expect(rrManifest?.permissions).toEqual({ administration: 'write', actions: 'read', metadata: 'read' });
      expect(Object.keys(rrManifest?.permissions ?? {})).toHaveLength(3);
      expect(rrManifest?.events).toEqual([]);
      // The agent's OWN manifest, sent through the SAME path, still gets the
      // DR-019 set — proves the override is per-identity, not global.
      const agentManifest = capturedManifests.find((m) => m.name === 'demo-fleet-code-agent');
      expect(agentManifest?.permissions['administration']).toBeUndefined();
    });

    it('repository_selection scoped to fleet repos — an "all"-scoped install is REFUSED, never silently accepted', async () => {
      const manifestPath = manifestPathIn();
      // groundnuty/macf#1083 — declare self-hosted so runner-ops is needed.
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      // groundnuty/macf#1128 — a CALL COUNTER, not `opts.expected.appSlug`:
      // this fixture's `exchangeManifestCode` (inherited from
      // `agentDepsFor('code-agent', ...)`'s base) always returns
      // `creds('code-agent')` regardless of which identity is actually
      // creating (see that fixture's own doc) — so
      // `finishGate2FromCredentials`'s `gate2Expected.appSlug` (derived
      // from the JUST-EXCHANGED credential's OWN `.slug`, not the caller's
      // derived handle) is `demo-fleet-code-agent` for code-agent AND
      // runner-ops AND the router App alike. `apply-fleet.ts` processes
      // them in that fixed order (per-agent loop, then runner-ops, then
      // router), so a call counter is the reliable way to give ONLY
      // runner-ops's OWN poll (the 2nd) `repositorySelection: 'all'` —
      // the code-agent's (1st) and the router's (3rd, unasserted here)
      // both get 'selected'. Before #1128 generalized the shared
      // repository_selection guard to every App type, a flat 'all' for
      // EVERY caller still isolated the failure to runner-ops, because
      // ordinary agent Apps had NO check at all — that is the exact gap
      // this issue closes, so the fixture must now discriminate to keep
      // testing runner-ops's OWN refusal in isolation from the agent's.
      let installPollCount = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: (log) => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          log,
          waitForAppInstallation: async (opts) => {
            installPollCount += 1;
            return {
              appId: opts.appId,
              installId: 'install-x',
              appSlug: opts.expected.appSlug ?? '',
              accountLogin: 'groundnuty',
              repositorySelection: installPollCount === 2 ? 'all' : 'selected', // the hazard the task brief names, scoped to runner-ops's OWN (2nd) poll
            };
          },
        }),
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.runnerOps.status).toBe('failed');
      if (result.runnerOps.status === 'failed') {
        expect(result.runnerOps.reason).toMatch(/repository_selection must be "selected"/);
        expect(result.runnerOps.reason).toMatch(/"all"/);
      }
      // The failure is scoped to the runner-ops credential — the CODE-AGENT
      // still succeeds (its OWN poll gets `repositorySelection: 'selected'`
      // from the fixture above; a SEPARATE decisive test —
      // `install-scope.test.ts` / the "agent App repository_selection"
      // describe block below — covers the agent's OWN "all"-scoped
      // refusal).
      expect(result.agents[0]?.identity.status).toBe('created');
    });

    it('existing App (prior fleet.lock entry) → reused, NOT recreated — the create-gate (startManifestFlow) is NEVER invoked', async () => {
      const manifestPath = manifestPathIn();
      // groundnuty/macf#1083 — declare self-hosted so runner-ops is needed.
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-rr' }],
      };
      let startManifestFlowCalledForRunnerOps = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: (log) => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          log,
          startManifestFlow: async (opts) => {
            const built = opts.buildManifest('http://x/callback');
            if (built.name === 'demo-fleet-runner-ops') startManifestFlowCalledForRunnerOps = true;
            return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} };
          },
        }),
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      // No `resolveKeyPath` wired in this fixture (production default, per
      // `apply-agent.ts::confirmBeforeCreateGuard`'s doc — no vault-decrypt
      // seam in this increment) — a role WITH a prior lock entry degrades to
      // `skip-unverified`, NOT a live re-confirm. The load-bearing assertion
      // either way: gate 1 is NEVER opened a second time for an App that
      // already has a recorded identity.
      expect(result.runnerOps.status).toBe('skipped-unverified');
      expect(startManifestFlowCalledForRunnerOps).toBe(false);
      if (result.runnerOps.status === 'skipped-unverified') {
        expect(result.runnerOps.appId).toBe('app-runner-ops');
      }
    });

    it('the private key NEVER appears in captured log lines, formatApplyResult text, or fleetApplyResultToJson output', async () => {
      const manifestPath = manifestPathIn();
      // groundnuty/macf#1083 — declare self-hosted so runner-ops is needed.
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const logs: string[] = [];
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: (log) => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          log: (line) => {
            logs.push(line);
            log(line);
          },
          waitForAppInstallation: async (opts) => ({
            appId: opts.appId,
            installId: 'install-x',
            appSlug: opts.expected.appSlug ?? '',
            accountLogin: 'groundnuty',
            repositorySelection: 'selected',
          }),
        }),
        log: (l) => logs.push(l),
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.runnerOps.status).toBe('created');
      // `agentDepsFor('code-agent', 'created', ...)`'s shared `exchangeManifestCode`
      // is role-agnostic (returns `creds('code-agent')` for ANY caller,
      // including the runner-ops step) — so the credential the
      // runner-ops credential receives in THIS fixture carries the code-agent sentinel.
      // What matters for this test is that whichever sentinel it carries
      // never leaks, regardless of which one it is.
      const runnerOpsPemSentinel = 'SENTINEL-PEM-code-agent';
      // The credential DOES flow through `result.runnerOps.credentials`
      // in-process (needed for the vault fold) — the property under test is
      // that it NEVER reaches a rendered/logged surface.
      if (result.runnerOps.status === 'created') {
        expect(result.runnerOps.credentials.pem).toBe(runnerOpsPemSentinel);
      }
      const joinedLogs = logs.join('\n');
      expect(joinedLogs).not.toContain(runnerOpsPemSentinel);
      expect(joinedLogs).not.toContain('SENTINEL-SECRET-code-agent');
      expect(joinedLogs).not.toContain('SENTINEL-HOOK-code-agent');
      const humanText = formatApplyResult(result, []);
      expect(humanText).not.toContain(runnerOpsPemSentinel);
      const jsonText = JSON.stringify(fleetApplyResultToJson(result, []));
      expect(jsonText).not.toContain(runnerOpsPemSentinel);
      expect(jsonText).not.toContain('SENTINEL-SECRET-code-agent');
      expect(jsonText).not.toContain('SENTINEL-HOOK-code-agent');
    });

    it('durable-before-gate-2 ordering preserved: its OWN recovery artifact is written BEFORE gate 2, deleted only after the batched vault write succeeds', async () => {
      const manifestPath = manifestPathIn();
      // groundnuty/macf#1083 — declare self-hosted so runner-ops is needed.
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const events: string[] = [];
      // `agentDepsFor`'s shared `exchangeManifestCode` returns FIXED creds
      // regardless of caller — override it to return DIFFERENT creds per
      // role, keyed off what gate 1's OWN `buildManifest` actually named
      // (the one place the caller's role is genuinely observable), so gate
      // 2's `appId` differs between the agent and the runner-ops credential and this
      // test can tell their events apart.
      let lastGate1Name = '';
      const agentDeps: AgentApplyDeps = {
        ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
        startManifestFlow: async (opts) => {
          lastGate1Name = opts.buildManifest('http://x/callback').name;
          return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} };
        },
        exchangeManifestCode: async () => creds(lastGate1Name === 'demo-fleet-runner-ops' ? 'runner-ops' : 'code-agent'),
        waitForAppInstallation: async (opts) => {
          events.push(`gate2:${opts.appId}`);
          return { appId: opts.appId, installId: 'install-x', appSlug: opts.expected.appSlug ?? '', accountLogin: 'groundnuty', repositorySelection: 'selected' };
        },
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDeps, manifestPath),
        buildAgentDeps: (log) => ({ ...agentDeps, log }),
        vaultDeps: {
          exists: () => false,
          // macf#988 — `.tmp-` (not "recovery") is now the discriminator;
          // see the earlier recovery-lifecycle tests' identical comment.
          encrypt: async (plaintext, _recipients, outPath) => {
            events.push(outPath.includes('.tmp-') ? `recovery-write:${outPath}` : 'final-vault-write');
            writeFileSync(outPath, `FAKE-AGE-CIPHERTEXT\n${plaintext.length.toString()}`);
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);
      expect(result.runnerOps.status).toBe('created');

      const rrRecoveryIdx = events.findIndex((e) => e.startsWith('recovery-write:') && e.includes('runner-ops'));
      const rrGate2Idx = events.findIndex((e) => e === 'gate2:app-runner-ops');
      const finalVaultIdx = events.findIndex((e) => e === 'final-vault-write');
      expect(rrRecoveryIdx).toBeGreaterThanOrEqual(0);
      expect(rrGate2Idx).toBeGreaterThanOrEqual(0);
      expect(finalVaultIdx).toBeGreaterThanOrEqual(0);
      // DR-043 §D5: the recovery artifact is durable BEFORE gate 2 opens —
      // never the other way around.
      expect(rrRecoveryIdx).toBeLessThan(rrGate2Idx);
      // Its OWN artifact is deleted only AFTER the batched final vault
      // write — the recovery artifact PATH is what's asserted (this is not
      // testing deletion order among peers, just "insurance outlives the
      // gate it was insuring against").
      expect(rrRecoveryIdx).toBeLessThan(finalVaultIdx);
      // macf#988 — see the earlier recovery-lifecycle tests' identical comment.
      const rrRecoveryPath = join(join(manifestPath, '..'), 'demo-fleet', 'runner-ops.age');
      expect(existsSync(rrRecoveryPath)).toBe(false); // removed post-successful-compose
    });

    it('a name exceeding 34 chars refuses BEFORE consent gate 1 — the gate seam is NEVER called', async () => {
      const manifestPath = manifestPathIn();
      // Fleet name chosen so `<fleet>-runner-ops` exceeds 34 chars —
      // `checkAppNameLengths` is the pure function under test elsewhere;
      // THIS test proves `applyFleet` itself refuses at its own first
      // statement, before control-repo provisioning or ANY gate.
      const longFleetManifest: FleetManifest = {
        ...manifestWith([CODE_AGENT]),
        metadata: { name: 'this-is-a-very-long-fleet-name-indeed' },
      };
      let anyGateSeamCalled = false;
      const deps: FleetApplyDeps = {
        buildAgentDeps: () => {
          throw new Error('must not be called — name-length pre-flight must abort before any identity work');
        },
        repoInitDeps: {
          cloneRepo: async () => {
            throw new Error('must not be called');
          },
          commitAndPush: async () => 'pushed',
        },
        vaultDeps: { exists: () => false, encrypt: async () => {} },
        controlRepoDeps: {
          checkMeta: async () => {
            anyGateSeamCalled = true;
            throw new Error('must not be called — the pre-flight is checked BEFORE step 0 (the control repo)');
          },
          readManifestFile: async () => undefined,
          createRepo: async () => {
            throw new Error('must not be called');
          },
          unarchiveRepo: async () => {
            throw new Error('must not be called');
          },
          cloneRepo: async () => {
            throw new Error('must not be called');
          },
          commitAndPush: async () => {
            throw new Error('must not be called');
          },
        },
        agentRepoDeps: {
          checkMeta: async () => {
            throw new Error('must not be called');
          },
          createRepo: async () => {
            throw new Error('must not be called');
          },
          unarchiveRepo: async () => {
            throw new Error('must not be called');
          },
        },
        trustDeps: {
          checkRegistryPresence: async () => {
            throw new Error('must not be called');
          },
          readRegistryVariable: async () => {
            throw new Error('must not be called');
          },
          createRegistryVariable: async () => {
            throw new Error('must not be called');
          },
          checkRepoPresence: async () => {
            throw new Error('must not be called');
          },
          createRepoVariable: async () => {
            throw new Error('must not be called');
          },
          mintCa: async () => {
            throw new Error('must not be called');
          },
          checkRunnerUsableByRepo: async () => {
            throw new Error('must not be called');
          },
        },
        routingClientDeps: {
          mint: async () => {
            throw new Error('must not be called');
          },
        },
        routingSecretsDeps: {
          checkRepoSecretPresence: async () => {
            throw new Error('must not be called');
          },
          setRepoSecret: async () => {
            throw new Error('must not be called');
          },
        },
        routerAppVaultDeps: {},
        now: () => new Date('2026-08-11T00:00:00.000Z'),
        log: () => {},
      };

      const result = await applyFleet(longFleetManifest, manifestPath, null, deps);

      expect(anyGateSeamCalled).toBe(false);
      expect(result.controlRepo.status).toBe('failed');
      // The DETAILED "which name(s), by how much" message lives on
      // `controlRepo.reason` (the field this abort's `reason` param feeds
      // directly) — every other field (`runnerOps`, `ca.resolve`,
      // `routingClient.mint`) points back at it rather than repeating the
      // detail, same convention the pre-existing control-repo-abort branch
      // already establishes for its own secondary fields.
      expect(result.controlRepo.reason).toMatch(/exceed the 34-char/);
      expect(result.controlRepo.reason).toContain('this-is-a-very-long-fleet-name-indeed-runner-ops');
      expect(result.runnerOps.status).toBe('failed');
      if (result.runnerOps.status === 'failed') {
        expect(result.runnerOps.reason).toMatch(/see controlRepo above/);
      }
      expect(applyExitCode(result)).toBe(1);
    });

    it('unconfirmable identity → honest "unknown" at plan time, never a false "absent" (Amendment A4)', async () => {
      // Structural proof (not just the plan.test.ts unit test): applyFleet's
      // own confirm-before-create guard, with NO resolveKeyPath wired (the
      // production default — no vault-decrypt seam in this increment),
      // NEVER attempts to distinguish "confirmed absent" from "unconfirmed"
      // for a role with no prior lock entry — it just authorizes create,
      // the honest-unknown-over-false-absent posture Amendment A4 requires.
      const manifestPath = manifestPathIn();
      // groundnuty/macf#1083 — declare self-hosted so runner-ops is needed.
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: (log) => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          log,
          confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
          waitForAppInstallation: async (opts) => ({
            appId: opts.appId,
            installId: 'install-x',
            appSlug: opts.expected.appSlug ?? '',
            accountLogin: 'groundnuty',
            repositorySelection: 'selected',
          }),
        }),
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);
      // `confirmAppInstallation` reporting 'unconfirmable' is NEVER read as
      // "the App doesn't exist" — with no prior lock entry, the guard takes
      // the CREATE path regardless (it never even calls confirmAppInstallation
      // for a role with no prior — see confirmBeforeCreateGuard's doc), and
      // create SUCCEEDS here (gate 2 confirms via waitForAppInstallation,
      // a SEPARATE seam from the guard's own confirm).
      expect(result.runnerOps.status).toBe('created');
    });
  });

  // --- DR-043 §D5 recipient-set reconciliation (groundnuty/macf#957) ---
  //
  // The bug: an operator adds a recipient to transport.age_recipients with
  // NO new agent/CA/routing-client secret this run — settleVault's early
  // `{status:'skipped'}` used to leave the vault silently stale. Every test
  // below drives `applyFleet` through a REUSED-everything run (mirrors the
  // existing "reuse: ... vault stays skipped" CA test above) so
  // settleVault's early-return branch is the ONLY branch reachable —
  // exactly the scenario this issue exists for.
  describe('vault recipient-set reconciliation (DR-043 §D5, groundnuty/macf#957)', () => {
    /** Every test's "nothing new to mint" precondition: CA already present (reuse, no fresh key) -> mintRoutingClient sees caMintedThisRun===false -> 'skipped' automatically; the agent itself is 'reused'. */
    function reuseTrustDeps(): CaApplyDeps & RunnerRegistrationDeps {
      return trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' });
    }
    const REUSE_PRIOR_LOCK: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      // groundnuty/macf#1128 — a 'router' entry keeps the router App on the
      // SAME reuse-confirmed path as 'code-agent' (this shared fixture's
      // `confirmAppInstallation`/`resolveKeyPath` are role-blind — see
      // `agentDepsFor`'s doc — so a prior lock entry existing at all is what
      // routes ANY role through 'reuse-confirmed', never CREATE). Without
      // it, the router (never in the prior lock, and its own create-or-
      // reuse ceremony is UNCONDITIONAL every run — `apply-fleet.ts`'s own
      // doc) now genuinely succeeds a fresh CREATE through this fixture
      // (`install-scope.ts`'s guard is satisfied), which mints something
      // new and breaks EVERY test below's "NOTHING NEW is minted this run"
      // precondition — not a repository_selection regression, a knock-on
      // of the SAME fixture now working correctly for every App type.
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'router', app_id: 'app-code-agent', install_id: 'install-1' },
      ],
    };

    it.skipIf(!HAS_AGE)(
      'REAL age binary — apply reconciles a recipient-set change even when NOTHING NEW is minted this run: ' +
        'decrypt-then-whole-rewrite (Amendment D — byte-for-byte identical plaintext), the NEWLY-ADDED identity ' +
        'can decrypt afterward, a stranger cannot, fleet.lock is untouched, and no secret reaches log/--json output',
      async () => {
        const manifestPath = manifestPathIn();
        const dir = join(manifestPath, '..');
        const opKey = mintAgeKey(dir, 'operator-key.txt');
        const vmKey = mintAgeKey(dir, 'vm-key.txt');
        const strangerKey = mintAgeKey(dir, 'stranger-key.txt');

        // Seed the "already-provisioned" state: a real vault.age encrypted
        // to ONLY the operator's key — the manifest below declares TWO.
        const secretsDir = join(dir, 'secrets');
        mkdirSync(secretsDir, { recursive: true });
        const vaultPath = join(secretsDir, 'vault.age');
        const seedPlaintext = "MACF_AGENT_DEMO_FLEET_CODE_AGENT_APP_ID='app-code-agent'\nMACF_AGENT_DEMO_FLEET_CODE_AGENT_CLIENT_SECRET='SENTINEL-SEEDED-SECRET'\n";
        await writeVault(seedPlaintext, { outPath: vaultPath, recipients: [opKey.publicKey] });
        const beforeBytes = readFileSync(vaultPath);

        const manifest = manifestWith([CODE_AGENT], [opKey.publicKey, vmKey.publicKey]);
        const logs: string[] = [];
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: reuseTrustDeps(),
          identityKeyPath: opKey.keyPath,
          log: (l) => logs.push(l),
        };

        const result = await applyFleet(manifest, manifestPath, REUSE_PRIOR_LOCK, deps);

        // Reconciled — NOT silently skipped, and no full mint was needed:
        expect(result.agents.map((a) => a.identity.status)).toEqual(['reused']);
        expect(result.ca.resolve.status).toBe('reused');
        expect(result.vault.status).toBe('written');
        if (result.vault.status !== 'written') return; // narrows for TS below
        expect(result.vault.path).toBe(vaultPath);
        expect(result.vault.versioned).toBe(false); // in-place atomic swap, not a timestamped sibling

        // Amendment D proof: the PAYLOAD is byte-for-byte UNCHANGED — only
        // the recipient set differs. Decrypting via the operator's
        // (unchanged) identity reproduces the EXACT seeded plaintext.
        const afterOperator = spawnSync('age', ['-d', '-i', opKey.keyPath, vaultPath], { encoding: 'utf-8' });
        expect(afterOperator.status, afterOperator.stderr).toBe(0);
        expect(afterOperator.stdout).toBe(seedPlaintext);

        // The NEWLY-ADDED identity (the VM's key) can now decrypt it too, to the SAME bytes:
        const afterVm = spawnSync('age', ['-d', '-i', vmKey.keyPath, vaultPath], { encoding: 'utf-8' });
        expect(afterVm.status, afterVm.stderr).toBe(0);
        expect(afterVm.stdout).toBe(seedPlaintext);

        // A third, unrelated key still cannot — not accidentally permissive:
        const afterStranger = spawnSync('age', ['-d', '-i', strangerKey.keyPath, vaultPath], { encoding: 'utf-8' });
        expect(afterStranger.status).not.toBe(0);

        // The ciphertext bytes DID change (new recipient stanza) — but that
        // is the only allowed shape of "changed" (proven by the identity
        // checks above, not by raw-byte comparison, since age's ephemeral
        // per-recipient keys make ciphertext bytes differ on every encrypt
        // regardless of recipient set).
        expect(readFileSync(vaultPath)).not.toEqual(beforeBytes);

        // fleet.lock is UNAFFECTED — no NEW secret was minted this run, so
        // the batched-lock-write guard (apply-fleet.ts's
        // `pendingCreatedUpdates`/caSecrets/routingClientSecrets check) must
        // NOT have fired even though `vault.status === 'written'`.
        const lockAfter = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
        // groundnuty/macf#1128 — `REUSE_PRIOR_LOCK` now carries a 'router'
        // entry too (see that constant's doc); it survives untouched
        // alongside 'code-agent', same "no NEW secret was minted" claim.
        // groundnuty/macf#1296 — 'code-agent' now also carries `repo`
        // (written on every reuse-touch, per `writeIncrementalLock`'s
        // steady-state path); 'router' has none — a fleet-level pseudo-role
        // update never passes `repo` (it has no per-manifest-agent repo).
        expect(lockAfter.agents).toEqual([
          { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1', repo: 'groundnuty/demo-code' },
          { role: 'router', app_id: 'app-code-agent', install_id: 'install-1' },
        ]);
        expect(lockAfter.fingerprints?.['ca_key']).toBeUndefined();
        expect(lockAfter.fingerprints?.['routing_client_key']).toBeUndefined();

        // No secret ever reaches log output or the --json render:
        const jsonOutput = JSON.stringify(fleetApplyResultToJson(result));
        const combined = `${logs.join('\n')}\n${jsonOutput}`;
        expect(combined).not.toContain(seedPlaintext);
        expect(combined).not.toContain('SENTINEL-SEEDED-SECRET');
        expect(combined).not.toContain('EXISTING-CA-CERT-PEM');
        expect(combined).not.toContain(readFileSync(opKey.keyPath, 'utf-8'));
        expect(combined).not.toContain(readFileSync(vmKey.keyPath, 'utf-8'));
      },
    );

    it('refuses loudly (never silently skips) when a recipient shortfall is detected but --identity-key was NOT supplied', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT], ['age1operator', 'age1vm']); // 2 declared
      let reencryptCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: reuseTrustDeps(),
        // identityKeyPath deliberately OMITTED
        vaultRecipientDeps: {
          readRecipientCount: () => ({ status: 'counted', count: 1 }), // vault currently has 1
          reencrypt: async () => {
            reencryptCalled = true;
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, REUSE_PRIOR_LOCK, deps);

      expect(result.vault.status).toBe('failed');
      if (result.vault.status === 'failed') {
        expect(result.vault.reason).toContain('--identity-key');
        expect(result.vault.reason).toContain('fewer');
      }
      expect(reencryptCalled).toBe(false);
      expect(applyExitCode(result)).toBe(1);
    });

    it('NEVER auto-shrinks: MORE stanzas than declared refuses even WITH --identity-key (re-encrypting to fewer keys would revoke one)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT], ['age1operator']); // 1 declared
      let reencryptCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: reuseTrustDeps(),
        identityKeyPath: '/fake/operator-key.txt',
        vaultRecipientDeps: {
          readRecipientCount: () => ({ status: 'counted', count: 2 }), // vault currently has 2
          reencrypt: async () => {
            reencryptCalled = true;
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, REUSE_PRIOR_LOCK, deps);

      expect(result.vault.status).toBe('failed');
      if (result.vault.status === 'failed') {
        expect(result.vault.reason).toContain('does NOT auto-shrink');
        expect(result.vault.reason).toContain('REVOKE');
      }
      expect(reencryptCalled).toBe(false);
      expect(applyExitCode(result)).toBe(1);
    });

    it('unchanged recipient set: no churn — reencrypt is never invoked and the run reports "skipped" (no spurious rewrite on every ordinary apply)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT], ['age1operator', 'age1vm']); // 2 declared
      let reencryptCalled = false;
      let readCount = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: reuseTrustDeps(),
        identityKeyPath: '/fake/operator-key.txt',
        vaultRecipientDeps: {
          readRecipientCount: () => {
            readCount++;
            return { status: 'counted', count: 2 }; // already matches
          },
          reencrypt: async () => {
            reencryptCalled = true;
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, REUSE_PRIOR_LOCK, deps);

      expect(result.vault.status).toBe('skipped');
      expect(reencryptCalled).toBe(false);
      // Detection DID run (every apply checks, regardless of --identity-key) — it just found nothing to do:
      expect(readCount).toBe(1);
    });

    it('no vault provisioned yet (a brand-new, never-applied fleet): reads "absent", reports "skipped" — no drift is possible against a vault that does not exist', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT], ['age1operator', 'age1vm']);
      let reencryptCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: reuseTrustDeps(),
        identityKeyPath: '/fake/operator-key.txt',
        vaultRecipientDeps: {
          readRecipientCount: () => ({ status: 'absent' }),
          reencrypt: async () => {
            reencryptCalled = true;
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, REUSE_PRIOR_LOCK, deps);

      expect(result.vault.status).toBe('skipped');
      expect(reencryptCalled).toBe(false);
    });

    it('an unreadable/malformed vault header at apply time reports "failed" honestly — never a silent skip, never a false match', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT], ['age1operator', 'age1vm']);
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: reuseTrustDeps(),
        identityKeyPath: '/fake/operator-key.txt',
        vaultRecipientDeps: {
          readRecipientCount: () => {
            throw new Error('no "---" header-MAC line found within the first 65536 bytes');
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, REUSE_PRIOR_LOCK, deps);

      expect(result.vault.status).toBe('failed');
      if (result.vault.status === 'failed') {
        expect(result.vault.reason).toContain('header-MAC line');
      }
      expect(applyExitCode(result)).toBe(1);
    });

    it('a run that DOES mint something new (e.g. a fresh CA) takes the ORDINARY vault-write path, unaffected by the recipient-reconcile branch', async () => {
      // Guards against a regression where reconcileVaultRecipients's early
      // return accidentally swallows the pre-existing "something new to
      // mint" path — this mirrors the very first test in this file
      // (freshly-created agent) but re-asserted here, in this describe
      // block, as an explicit non-regression pin.
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath);

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('created');
      expect(result.vault.status).toBe('written');
    });

    // --- groundnuty/macf#1269 — the recipient record can never be created
    // on a steady-state fleet ---
    //
    // Every test ABOVE in this describe block that reaches settleVault's
    // "nothing new to mint" branch (the ONLY branch reachable on a
    // steady-state fleet) asserts `result.vault.status` and `reencryptCalled`
    // — never whether `fleet.lock`'s `age_recipients` field actually got
    // written. `REUSE_PRIOR_LOCK` (this block's shared prior-lock fixture)
    // has never carried an `age_recipients` field, so EVERY test above has
    // silently been running against the exact population #1269 reports:
    // "the population under test excludes the failing case by construction"
    // (assert-the-wrong-path.md trigger 3) — a steady-state run whose fixture
    // mints nothing was exercised by every test here, but none of them
    // looked at the one field that #1269 says can never get recorded.
    describe('groundnuty/macf#1269 — the record must be creatable on a run that mints nothing', () => {
      it('DECISIVE (1/2): a steady-state fleet — this run mints NOTHING, lock has no age_recipients recorded — still gets the record created', async () => {
        const manifestPath = manifestPathIn();
        const manifest = manifestWith([CODE_AGENT], ['age1operator', 'age1vm']); // 2 declared
        let reencryptCalled = false;
        const deps: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
          trustDeps: reuseTrustDeps(),
          identityKeyPath: '/fake/operator-key.txt',
          vaultRecipientDeps: {
            readRecipientCount: () => ({ status: 'counted', count: 2 }), // vault EXISTS and already matches
            reencrypt: async () => {
              reencryptCalled = true;
            },
          },
        };

        const result = await applyFleet(manifest, manifestPath, REUSE_PRIOR_LOCK, deps);

        // Same precondition the #957 "unchanged recipient set: no churn"
        // test pins: nothing minted this run, nothing needed re-encrypting.
        expect(result.vault.status).toBe('skipped');
        expect(reencryptCalled).toBe(false);

        // THE decisive assertion: `age_recipients` now exists in the
        // written lock, despite `settleVault` never having reported
        // `'written'` this run — the exact record #1269 says can never get
        // created.
        expect(existsSync(result.lockPath)).toBe(true);
        const lock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
        expect(lock.age_recipients).toEqual(['age1operator', 'age1vm']);
      });

      // Per assert-the-wrong-path.md: (1) alone is satisfiable by a broken
      // "fix" that just writes fleet.lock unconditionally every run,
      // regardless of whether anything actually changed — the record would
      // still get created, and (1) would still pass. Once the recorded set
      // already matches the declared set, a CORRECT skip and an
      // INCORRECT-but-content-identical rewrite produce byte-identical
      // files, so this pair is asserted directly against the extracted
      // `shouldWriteBatchedFleetLock` predicate (groundnuty/macf#957's
      // no-churn contract, restated at the decision-point that actually
      // implements it) rather than through a second `applyFleet` run.
      it('DECISIVE (2/2): a steady-state fleet whose lock ALREADY records the same set — the batched-write predicate does NOT fire (groundnuty/macf#957 no-churn contract)', () => {
        const confirmedCurrent: VaultApplyOutcome = { status: 'skipped', recipientsConfirmedCurrent: true };
        // Nothing minted, recipients unchanged -> no write, no churn:
        expect(shouldWriteBatchedFleetLock(confirmedCurrent, false, false, false)).toBe(false);
        // Same vault evidence, but the lock's recorded set genuinely
        // differs -> the write DOES fire (what test (1) exercises above
        // through the full `applyFleet` pipeline):
        expect(shouldWriteBatchedFleetLock(confirmedCurrent, false, false, true)).toBe(true);
      });

      it('a "nothing confirmed" skip (no vault exists yet) never fires the write on its own, even when recipientsChanged is true — there is nothing to have confirmed the record against', () => {
        const noVaultYet: VaultApplyOutcome = { status: 'skipped' }; // recipientsConfirmedCurrent omitted
        expect(shouldWriteBatchedFleetLock(noVaultYet, false, false, true)).toBe(false);

        const failed: VaultApplyOutcome = { status: 'failed', reason: 'boom' };
        expect(shouldWriteBatchedFleetLock(failed, false, false, true)).toBe(false);
      });
    });
  });

  // --- Adding an agent to an ALREADY-VAULTED fleet (DR-043 Amendment D,
  // groundnuty/macf#989) — the vault-exists compose path. Before this fix,
  // `settleVault` unconditionally called `writeVault`, which REFUSES to
  // overwrite an existing `vault.age` — so a run that opened + spent BOTH
  // consent gates for a genuinely new agent reported that agent `CREATED`
  // while its just-minted credential was discarded (never durably
  // recorded anywhere reachable). See the issue for the full incident.
  describe('vault-exists compose path (DR-043 Amendment D, groundnuty/macf#989)', () => {
    /** Mirrors the recipient-reconciliation describe block's own helper — CA registry already has a cert, so `resolveCaCert` REUSES rather than mints (keeps a test's "nothing pending" precondition free of CA noise). */
    function reuseTrustDeps(): CaApplyDeps & RunnerRegistrationDeps {
      return trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' });
    }

    it('vault already exists, no --identity-key supplied: the pre-flight refuses gate 1 ENTIRELY for a role with no prior lock entry — no App is ever created, zero gate invocations', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      let gate1Called = false;
      let gate2Called = false;
      const agentDeps = agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1');
      const deps: FleetApplyDeps = {
        ...baseDeps(
          {
            ...agentDeps,
            startManifestFlow: async (opts) => {
              gate1Called = true;
              return agentDeps.startManifestFlow(opts);
            },
            waitForAppInstallation: async (opts) => {
              gate2Called = true;
              return agentDeps.waitForAppInstallation(opts);
            },
          },
          manifestPath,
        ),
        trustDeps: reuseTrustDeps(), // keep the CA out of the "pending" set — this test is about the AGENT's pre-flight only
        vaultDeps: { exists: () => true }, // the vault ALREADY exists in this checkout
        // identityKeyPath deliberately OMITTED
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(gate1Called).toBe(false);
      expect(gate2Called).toBe(false);
      expect(result.agents[0]?.identity.status).toBe('failed');
      if (result.agents[0]?.identity.status === 'failed') {
        expect(result.agents[0].identity.reason).toContain('--identity-key');
        expect(result.agents[0].identity.reason).toContain('CREATE path');
        expect(result.agents[0].identity.reason).toContain('never read-modify-written');
      }
      // Nothing else pending this run (CA reused, agent refused pre-gate,
      // runner-ops equally refused by the SAME pre-flight) -> settleVault
      // never even reaches the compose branch:
      expect(result.vault.status).toBe('skipped');
      expect(existsSync(result.lockPath)).toBe(false);
      expect(applyExitCode(result)).toBe(1);
    });

    it('same pre-flight applies to the runner-ops App (no prior lock entry, vault exists, no --identity-key)', async () => {
      const manifestPath = manifestPathIn();
      // No coordination agents at all — isolates the runner-ops's OWN pre-flight.
      // groundnuty/macf#1083 — self-hosted DECLARED so runner-ops is needed
      // and this pre-flight path is actually reached (an undeclared/hosted
      // manifest would short-circuit to 'not-needed' before this pre-flight
      // ever runs — see the dedicated #1083 describe block below for that).
      const manifest: FleetManifest = { ...manifestWith([]), routing: { runner: { runs_on: 'self-hosted', warm: 1 } } };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('runner-ops', 'created', 'app-runner-ops', 'install-1'), manifestPath),
        trustDeps: reuseTrustDeps(),
        vaultDeps: { exists: () => true },
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.runnerOps.status).toBe('failed');
      if (result.runnerOps.status === 'failed') {
        expect(result.runnerOps.reason).toContain('--identity-key');
        expect(result.runnerOps.reason).toContain('never read-modify-written');
      }
      expect(result.vault.status).toBe('skipped');
    });

    it('vault exists + --identity-key supplied, but no prior lock entry for a REUSED-CA-only run: reachable defense-in-depth throw is ACTIONABLE (tells the operator to supply --identity-key, never "file a bug")', async () => {
      // A fresh CA mint opens NO consent gate (no App, no operator click) —
      // so the per-agent/runner-ops pre-flight (gated on a role taking the
      // CREATE path) does not cover this case. If every agent REUSES but
      // the CA mints fresh this run (the groundnuty/macf#978 deactivate-
      // then-apply shape) and the vault already exists with no
      // --identity-key, settleVault's OWN defense-in-depth throw is what
      // fires — genuinely reachable, not dead code (macf#989 review).
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: trustDepsFor(), // default: registry absent -> CA MINTS fresh this run
        // `encrypt` faked too — this fixture's runner-ops ALSO takes the
        // CREATE path (no prior lock entry for it), so its OWN pre-gate-2
        // recovery artifact write must succeed cleanly; the scenario this
        // test isolates is specifically "CA pending, no --identity-key",
        // not an incidental runner-ops recovery-write failure.
        // macf#988 made the recovery-artifact write ATOMIC (encrypt -> tmp,
        // chmod, rename). A no-op `encrypt` leaves no tmp file for the rename,
        // so the artifact write — and therefore the identity — would fail for
        // a reason this test is not about. Materialize the file the real
        // rename expects; the FINAL compose is still the thing made to fail.
        vaultDeps: { exists: () => true, encrypt: async (_pt, _r, outPath) => { writeFileSync(outPath, 'fake-encrypted'); } },
        // identityKeyPath deliberately OMITTED
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents[0]?.identity.status).toBe('reused'); // no gate ever opened for it — unaffected
      expect(result.ca.resolve.status).toBe('minted');
      expect(result.vault.status).toBe('failed');
      if (result.vault.status === 'failed') {
        expect(result.vault.reason).toContain('--identity-key');
        expect(result.vault.reason).not.toMatch(/file a bug/i);
      }
      expect(applyExitCode(result)).toBe(1);
    });

    it('a vault-write failure on the compose path is non-zero exit and is NEVER reported as a success alongside the agent\'s CREATED status (macf#989 Required #3)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: reuseTrustDeps(),
        // `encrypt` faked (not just `exists`) — the pre-gate-2 RECOVERY
        // artifact write (a separate seam, `vaultDeps.encrypt`) must succeed
        // so gate 1 + gate 2 resolve to 'created' cleanly; only the FINAL
        // batched compose (`vaultComposeDeps`, below) is meant to fail here.
        // macf#988 made the recovery-artifact write ATOMIC (encrypt -> tmp,
        // chmod, rename). A no-op `encrypt` leaves no tmp file for the rename,
        // so the artifact write — and therefore the identity — would fail for
        // a reason this test is not about. Materialize the file the real
        // rename expects; the FINAL compose is still the thing made to fail.
        vaultDeps: { exists: () => true, encrypt: async (_pt, _r, outPath) => { writeFileSync(outPath, 'fake-encrypted'); } },
        identityKeyPath: '/fake/operator-key.txt', // supplied -> gate 1/2 proceed, compose IS attempted
        vaultComposeDeps: {
          exists: () => true, // composeAndWriteVault's OWN readVault pre-flight also needs to see "the vault exists"
          assertIdentityReadable: () => {}, // and skip the real fs.accessSync check on the fake identity path
          decrypt: async () => {
            throw new Error('simulated wrong identity key');
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      // Gate 1 + gate 2 both succeeded (this fixture's `agentDepsFor('created', ...)`
      // never fails them) — the credential WAS minted; only the batched
      // compose failed:
      expect(result.agents[0]?.identity.status).toBe('created');
      expect(result.vault.status).toBe('failed');
      if (result.vault.status === 'failed') {
        expect(result.vault.reason).toContain('simulated wrong identity key');
      }
      // The decisive requirement: this is NEVER a success-shaped exit —
      // never conflate "the agent shows CREATED" with "the run succeeded":
      expect(applyExitCode(result)).toBe(1);
      // No lock entry either — the vault-before-lock invariant this module
      // already upholds for the ordinary first-write failure path:
      expect(existsSync(result.lockPath)).toBe(false);
    });

    it('never auto-shrinks the recipient set while composing new secrets in (DR-043 §D3 invariant 4, same rule reconcileVaultRecipients already enforces)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT], ['age1operator']); // 1 declared
      let composeCalled = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        trustDeps: reuseTrustDeps(),
        // macf#988 made the recovery-artifact write ATOMIC (encrypt -> tmp,
        // chmod, rename). A no-op `encrypt` leaves no tmp file for the rename,
        // so the artifact write — and therefore the identity — would fail for
        // a reason this test is not about. Materialize the file the real
        // rename expects; the FINAL compose is still the thing made to fail.
        vaultDeps: { exists: () => true, encrypt: async (_pt, _r, outPath) => { writeFileSync(outPath, 'fake-encrypted'); } }, // see the sibling test's comment on why `encrypt` (not just `exists`) is faked
        identityKeyPath: '/fake/operator-key.txt',
        vaultRecipientDeps: {
          readRecipientCount: () => ({ status: 'counted', count: 2 }), // vault currently has 2 — MORE than declared
        },
        vaultComposeDeps: {
          decrypt: async () => {
            composeCalled = true;
            return "MACF_AGENT_X_APP_ID='1'\n";
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.vault.status).toBe('failed');
      if (result.vault.status === 'failed') {
        expect(result.vault.reason).toContain('does NOT auto-shrink');
        expect(result.vault.reason).toContain('REVOKE');
      }
      expect(composeCalled).toBe(false); // refused BEFORE any decrypt was ever attempted
      expect(applyExitCode(result)).toBe(1);
    });

    it('never logs or --json-renders decrypted vault material from the compose path', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const logs: string[] = [];
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: (log) => ({ ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), log }),
        trustDeps: reuseTrustDeps(),
        // macf#988 made the recovery-artifact write ATOMIC (encrypt -> tmp,
        // chmod, rename). A no-op `encrypt` leaves no tmp file for the rename,
        // so the artifact write — and therefore the identity — would fail for
        // a reason this test is not about. Materialize the file the real
        // rename expects; the FINAL compose is still the thing made to fail.
        vaultDeps: { exists: () => true, encrypt: async (_pt, _r, outPath) => { writeFileSync(outPath, 'fake-encrypted'); } }, // fakes the pre-gate-2 recovery-artifact encrypt too
        identityKeyPath: '/fake/operator-key.txt',
        vaultComposeDeps: {
          exists: () => true, // composeAndWriteVault's OWN readVault pre-flight also needs to see "the vault exists"
          assertIdentityReadable: () => {}, // and skip the real fs.accessSync check on the fake identity path
          decrypt: async () => "MACF_AGENT_SCIENCE_AGENT_CLIENT_SECRET='SENTINEL-DECRYPTED-SECRET'\n",
          encrypt: async () => {},
          rename: () => {}, // no real temp file was written — the fake encrypt above is a no-op
          unlink: () => {},
        },
        log: (l) => logs.push(l),
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.vault.status).toBe('written');
      const jsonOutput = JSON.stringify(fleetApplyResultToJson(result));
      const combined = `${logs.join('\n')}\n${jsonOutput}`;
      expect(combined).not.toContain('SENTINEL-DECRYPTED-SECRET');
      expect(combined).not.toContain('SENTINEL-SECRET-code-agent');
    });

    it.skipIf(!HAS_AGE)(
      'REAL age binary — THE DECISIVE TEST (groundnuty/macf#989): provision one agent, then apply again adding a ' +
        'second agent to the SAME already-vaulted fleet — BOTH agents\' credentials decrypt from the resulting ' +
        'vault; the FIRST agent\'s prior entries survive PER-KEY unchanged; a first-provision test alone could not ' +
        'have caught this (it never re-applies against an existing vault)',
      async () => {
        const manifestPath = manifestPathIn();
        const dir = join(manifestPath, '..');
        const opKey = mintAgeKey(dir, 'operator-key.txt');

        // --- Step 1: provision science-agent alone (an ordinary first apply). ---
        const manifest1 = manifestWith([SCI_AGENT], [opKey.publicKey]);
        const deps1: FleetApplyDeps = {
          ...baseDeps(agentDepsFor('science-agent', 'created', 'app-science-agent', 'install-science-agent'), manifestPath),
          vaultDeps: { exists: () => false }, // no `encrypt` override — real `age` runs
        };
        const result1 = await applyFleet(manifest1, manifestPath, null, deps1);
        expect(result1.agents[0]?.identity.status).toBe('created');
        expect(result1.vault.status).toBe('written');
        if (result1.vault.status !== 'written') return; // narrows for TS below
        const vaultPath = result1.vault.path;
        expect(existsSync(vaultPath)).toBe(true);

        const beforeDecrypt = spawnSync('age', ['-d', '-i', opKey.keyPath, vaultPath], { encoding: 'utf-8' });
        expect(beforeDecrypt.status, beforeDecrypt.stderr).toBe(0);
        const seedRaw = parseVaultPlaintext(beforeDecrypt.stdout);
        expect(seedRaw['MACF_AGENT_DEMO_FLEET_SCIENCE_AGENT_APP_ID']).toBe('app-science-agent');

        // --- Step 2: add code-agent to the SAME fleet. The vault at
        // `vaultPath` ALREADY has science-agent's content — the exact
        // scenario the issue reports as discarding the new credential.
        // Deliberately does NOT use `baseDeps` (which stubs
        // `vaultDeps.exists: () => false` unconditionally) and does NOT
        // override `vaultDeps.exists` here at all — the REAL `existsSync`
        // must see the REAL file step 1 just wrote, or this test would
        // pass regardless of whether the fix works (the exact "test that
        // constructs the seam it should observe" trap).
        const manifest2 = manifestWith([SCI_AGENT, CODE_AGENT], [opKey.publicKey]);
        const agentDeps2: AgentApplyDeps = {
          startManifestFlow: async () => ({ startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} }),
          startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
          exchangeManifestCode: async () => creds('code-agent'),
          resolveKeyPath: () => '/fake.pem',
          confirmAppInstallation: async () => ({
            status: 'confirmed',
            install: { appId: 'app-science-agent', installId: 'install-science-agent', appSlug: 'demo-fleet-science-agent', accountLogin: 'groundnuty' },
          }),
          // groundnuty/macf#1128 — `repositorySelection: 'selected'`.
          waitForAppInstallation: async (opts) => ({
            appId: opts.appId,
            installId: 'install-code-agent',
            appSlug: 'demo-fleet-code-agent',
            accountLogin: 'groundnuty',
            repositorySelection: 'selected',
          }),
          openUrl: async () => {},
          log: () => {},
          writeRecoveryArtifact: async () => {},
        };
        const deps2: FleetApplyDeps = {
          buildAgentDeps: () => agentDeps2,
          repoInitDeps: NOOP_REPO_INIT,
          vaultDeps: {}, // real `exists` AND real `encrypt` — must see + extend the REAL file on disk
          controlRepoDeps: controlRepoDepsFor(),
          agentRepoDeps: agentRepoDepsFor(),
          trustDeps: reuseTrustDeps(), // CA already minted in step 1 -> reused here, keeps the vault diff isolated to the agents
          routingClientDeps: NOOP_ROUTING_CLIENT_DEPS,
          routingSecretsDeps: NOOP_ROUTING_SECRETS_DEPS,
          routerAppVaultDeps: NOOP_ROUTER_APP_VAULT_DEPS,
          controlRepoOptions: { makeScratchDir: () => dir }, // SAME checkout dir as step 1
          now: () => new Date('2026-08-11T00:00:00.000Z'),
          log: () => {},
          identityKeyPath: opKey.keyPath, // THE fix's precondition — decrypt-and-fold is now possible
        };

        const result2 = await applyFleet(manifest2, manifestPath, null, deps2);

        expect(result2.agents.find((a) => a.role === 'code-agent')?.identity.status).toBe('created');
        expect(result2.vault.status).toBe('written');
        if (result2.vault.status !== 'written') return; // narrows for TS below
        expect(result2.vault.path).toBe(vaultPath); // the SAME canonical path — never a versioned sibling nothing reads

        // THE decisive assertion — decrypt the FINAL vault and confirm BOTH
        // agents' credentials are present:
        const afterDecrypt = spawnSync('age', ['-d', '-i', opKey.keyPath, vaultPath], { encoding: 'utf-8' });
        expect(afterDecrypt.status, afterDecrypt.stderr).toBe(0);
        const afterRaw = parseVaultPlaintext(afterDecrypt.stdout);

        // Every key science-agent had BEFORE step 2 survives with the EXACT
        // SAME value (per-key comparison — `composeAndWriteVault`'s
        // sorted-key serialization is not byte-identical to the ORIGINAL
        // insertion-order plaintext even when every value is unchanged, so
        // this is the correct notion of "byte-identical" here: the VALUES,
        // not the file text):
        for (const [key, value] of Object.entries(seedRaw)) {
          expect(afterRaw[key]).toBe(value);
        }
        // code-agent's fresh credentials are ALSO present:
        expect(afterRaw['MACF_AGENT_DEMO_FLEET_CODE_AGENT_APP_ID']).toBe('app-code-agent');
        expect(afterRaw['MACF_AGENT_DEMO_FLEET_CODE_AGENT_CLIENT_SECRET']).toBe('SENTINEL-SECRET-code-agent');
        expect(afterRaw['MACF_AGENT_DEMO_FLEET_CODE_AGENT_INSTALL_ID']).toBe('install-code-agent');

        // No secret ever reaches --json output:
        const jsonOutput = JSON.stringify(fleetApplyResultToJson(result2));
        expect(jsonOutput).not.toContain('SENTINEL-SECRET-code-agent');
        expect(jsonOutput).not.toContain(readFileSync(opKey.keyPath, 'utf-8'));
      },
    );
  });

  // groundnuty/macf#1012 — repo-scoped registry install-coverage. A manifest
  // whose `owner.registry.type === 'repo'`; `deriveAppHandle('demo-fleet',
  // 'code-agent')` === 'demo-fleet-code-agent' throughout. Module-scoped
  // (not local to this describe) — groundnuty/macf#1016's sibling describe
  // block below needs the SAME repo-scoped manifest shape.
  describe('groundnuty/macf#1012 — registry-repo installation-coverage', () => {
    it('DECISIVE: an App whose install lacks the registry repo -> REFUSES, the failure reason names the App and the repo, and the overall apply outcome is non-zero', async () => {
      const manifestPath = manifestPathIn();
      const manifest = repoScopedManifest();
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        checkRegistryRepoCoverage: async () => 'absent',
        // groundnuty/macf#1178 — an 'absent' presence now ALSO triggers the
        // independent existence probe; inject a fake so this test never
        // makes a real unauthenticated `fetch` call. 'unknown' preserves
        // this test's pre-#1178 assertions (cause (b) not ruled out).
        checkRegistryRepoExists: async () => 'unknown',
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('failed');
      const identity = result.agents[0]?.identity;
      const reason = identity && identity.status === 'failed' ? identity.reason : '';
      expect(reason).toContain('demo-fleet-code-agent'); // deriveAppHandle('demo-fleet', 'code-agent') — WHICH App
      expect(reason).toContain('demo-org/demo-org-registry'); // WHICH repo
      // The overall apply outcome reaches a non-zero exit — a refusal here
      // must not be swallowed into a green run (mirrors this file's own
      // "applyExitCode gates on ... an explicit equality check" convention
      // used elsewhere in this describe block).
      expect(applyExitCode(result)).not.toBe(0);
    });

    it('every App includes the registry repo ("present") -> proceeds, no churn (an already-reused role stays reused)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = repoScopedManifest();
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      let checkCalls = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        checkRegistryRepoCoverage: async () => {
          checkCalls += 1;
          return 'present';
        },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      // `applyExitCode` is deliberately not asserted here — see the
      // load-bearing assertion note below. `manifest` declares no self-hosted
      // routing, so as of groundnuty/macf#1083 the runner-ops App is
      // `'not-needed'` and never even reaches `waitForAppInstallation`/
      // `validateRunnerOpsInstall` with this fixture's shared
      // `agentDepsFor('code-agent', ...)` object. The load-bearing assertion
      // for THIS test is `identity.status`.
      expect(result.agents[0]?.identity.status).toBe('reused');
      // Verified on the REUSE path too (groundnuty/macf#1012's headline
      // gap — an already-provisioned role re-confirmed on a re-run): the
      // check actually ran, it just didn't reject.
      expect(checkCalls).toBeGreaterThan(0);
    });

    it('the repo list is unreadable -> UNKNOWN, never "missing" — does not block, but the run reports it', async () => {
      const manifestPath = manifestPathIn();
      const manifest = repoScopedManifest();
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      const logs: string[] = [];
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        log: (line: string) => logs.push(line),
        checkRegistryRepoCoverage: async () => 'unknown',
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      // Honest-unknown never blocks (DR-043 Amendment A) — the role is
      // still reused. (`applyExitCode` not asserted — see the sibling
      // "present" test above; no self-hosted routing declared, so the
      // runner-ops App is `'not-needed'`, per groundnuty/macf#1083.)
      expect(result.agents[0]?.identity.status).toBe('reused');
      // But the run REPORTS it — a warning naming the App + repo reaches
      // the operator-visible log, not silently dropped:
      const joined = logs.join('\n');
      expect(joined).toContain('demo-fleet-code-agent');
      expect(joined).toContain('demo-org/demo-org-registry');
      expect(joined).toMatch(/UNKNOWN/);
    });

    it('profile scope (registry.type !== "repo") is byte-identical: checkRegistryRepoCoverage is NEVER invoked', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]); // default owner.registry.type === 'profile'
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        checkRegistryRepoCoverage: async () => {
          throw new Error('must not be called — registry.type is "profile", not "repo"');
        },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      // `applyExitCode` not asserted — see the "present" test above; no
      // self-hosted routing declared, so the runner-ops App is
      // `'not-needed'`, per groundnuty/macf#1083.
      expect(result.agents[0]?.identity.status).toBe('reused');
    });

    // groundnuty/macf#950/#951's "never All repositories" runner-ops refusal
    // is verified UNCHANGED by this file's PRE-EXISTING test
    // ('repository_selection scoped to fleet repos — an "all"-scoped install
    // is REFUSED, never silently accepted', in the CA/routing-client
    // describe block above) remaining green after this describe block's
    // changes — `validateReuse` (macf#1012's new hook) is deliberately NEVER
    // wired for the runner-ops (`runnerOpsDeps` only sets `validateInstall:
    // validateRunnerOpsInstall`, unchanged), so its reuse path is not newly
    // re-validated. No additional test is needed here; a redundant one would
    // just re-assert what that test already covers.
  });

  // groundnuty/macf#1156 — the gate-2 instruction an operator reads and the
  // live coverage check that verifies what they did with it must derive
  // from the SAME runtime value. Before this fix, `installReposForIdentity`
  // (which drives the interstitial/terminal instruction AND the `--dry-run`
  // preview) never consulted `registry` at all — an operator who followed
  // the instruction exactly (select exactly the ONE repo named) produced an
  // install `registry-repo-coverage.ts`'s live check then correctly
  // REFUSED, because the instruction never named the control repo the check
  // requires. See `apply-agent.ts::installReposForIdentity` + this issue's
  // own body for the live `macf-fresh-science-agent` incident this closes.
  describe('groundnuty/macf#1156 — the gate-2 instruction and its coverage check must not independently drift', () => {
    it('DECISIVE: the interstitial repo list and the coverage check\'s owner/repo are asserted against EACH OTHER — neither side against a hand-typed literal', async () => {
      const manifestPath = manifestPathIn();
      const manifest = repoScopedManifest();
      // Both values below are captured from the REAL runtime call — never
      // recomputed by re-invoking `installReposForIdentity` or
      // `requiredRegistryRepoCoverage` a second time inside this test. A
      // test that rebuilt "the expected repo" by calling the SAME helper
      // the production code calls would pass even if some OTHER caller
      // bypassed that helper entirely (assert-the-wrong-path.md trigger 1)
      // — the only assertion that actually exercises the #1156 hazard is
      // "what the interstitial showed" vs. "what the check verified",
      // cross-referenced against each other.
      let seenInstructionRepos: readonly string[] | undefined;
      const agentDeps: AgentApplyDeps = {
        ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
        startInstallInterstitial: async (opts) => {
          // Filtered to the agent under test — this fixture's fleet ALSO
          // creates the router App through the same shared `AgentApplyDeps`
          // object (`baseDeps`'s own doc), and the router App's install
          // target is the registry alone (`routerAppInstallRepos`), a
          // different — and separately correct — list this test isn't
          // about.
          if (opts.role === 'code-agent') seenInstructionRepos = parseSelectExactlyRepos(opts.messageLines);
          return { startUrl: 'http://x/install', close: async () => {} };
        },
      };
      let seenCheckOwner: string | undefined;
      let seenCheckRepo: string | undefined;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDeps, manifestPath),
        checkRegistryRepoCoverage: async (_appId, _keyPath, owner, repo) => {
          seenCheckOwner = owner;
          seenCheckRepo = repo;
          return 'present';
        },
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('created');
      expect(seenCheckOwner).toBeDefined();
      expect(seenCheckRepo).toBeDefined();
      expect(seenInstructionRepos).toBeDefined();
      // THE decisive assertion: the repo the live check verified is a
      // member of the list the instruction told the operator to select —
      // both sides read from the actual apply run, not from a literal
      // either side of this test typed out by hand.
      expect(seenInstructionRepos).toContain(`${seenCheckOwner}/${seenCheckRepo}`);
      // And the agent's own home repo is STILL there — #1156 folds the
      // control repo IN, it does not replace the agent's own repo.
      expect(seenInstructionRepos).toContain('groundnuty/demo-code');
    });

    it('a non-repo-scoped registry (profile scope): the instruction lists the agent repo ONLY — no spurious control-repo entry', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]); // default owner.registry.type === 'profile'
      let seenInstructionRepos: readonly string[] | undefined;
      const agentDeps: AgentApplyDeps = {
        ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
        startInstallInterstitial: async (opts) => {
          if (opts.role === 'code-agent') seenInstructionRepos = parseSelectExactlyRepos(opts.messageLines);
          return { startUrl: 'http://x/install', close: async () => {} };
        },
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDeps, manifestPath),
        checkRegistryRepoCoverage: async () => {
          throw new Error('must not be called — registry.type is "profile", not "repo"');
        },
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('created');
      expect(seenInstructionRepos).toEqual(['groundnuty/demo-code']);
    });
  });

  // groundnuty/macf#1016 — #1012/#1015's registry-repo coverage check can
  // only fire once `confirmBeforeCreateGuard` reaches `reuse-confirmed`/
  // `resume-install`, which needs `AgentApplyDeps.resolveKeyPath` wired
  // (vault-aware). A FLAGLESS re-run against an already-provisioned
  // repo-scoped role lands on `skip-unverified` instead — silently, unless
  // the reason names the gap explicitly. See `registry-repo-coverage.ts`'s
  // "The gap THAT coverage scope leaves open" doc section.
  describe('groundnuty/macf#1016 — skip-unverified states coverage was not verified', () => {
    it('DECISIVE: a flagless apply on a repo-scoped fleet with TWO already-provisioned roles states, per role, that coverage was NOT verified — naming EACH role\'s own App handle, not one fleet-wide note', async () => {
      const manifestPath = manifestPathIn();
      const manifest = repoScopedManifest([CODE_AGENT, SCI_AGENT]);
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [
          { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
          { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
        ],
      };
      // No resolveKeyPath anywhere in this run's deps -> confirmBeforeCreateGuard
      // resolves skip-unverified for BOTH roles WITHOUT ever calling
      // checkRegistryRepoCoverage — the throwing stub below asserts that.
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'skipped-unverified', 'x', 'y'), manifestPath),
        trustDeps: trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' }),
        checkRegistryRepoCoverage: async () => {
          throw new Error('must not be called — skip-unverified never reaches the live coverage check');
        },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents.map((a) => a.identity.status)).toEqual(['skipped-unverified', 'skipped-unverified']);

      const codeIdentity = result.agents.find((a) => a.role === 'code-agent')?.identity;
      const sciIdentity = result.agents.find((a) => a.role === 'science-agent')?.identity;
      const codeReason = codeIdentity?.status === 'skipped-unverified' ? codeIdentity.reason : '';
      const sciReason = sciIdentity?.status === 'skipped-unverified' ? sciIdentity.reason : '';

      // Each role's OWN reason names coverage as unverified, its OWN App
      // handle, the registry repo, AND how to verify it (macf#1016's own
      // two acceptance criteria: states it + says how to verify) — never a
      // fleet-wide note shared across roles. Per-role scoping is the whole
      // point (`assert-the-wrong-path.md`) — a single-agent fleet couldn't
      // distinguish "per role" from "per fleet."
      expect(codeReason).toContain('was ALSO not verified this run');
      expect(codeReason).toContain('demo-fleet-code-agent');
      expect(codeReason).toContain('demo-org/demo-org-registry');
      expect(codeReason).toContain('--vault');
      expect(codeReason).toContain('--identity-key');
      expect(sciReason).toContain('demo-fleet-science-agent');
      expect(sciReason).toContain('demo-org/demo-org-registry');
      // No cross-role bleed — code-agent's note never names science-agent's
      // handle and vice versa.
      expect(sciReason).not.toContain('demo-fleet-code-agent');
      expect(codeReason).not.toContain('demo-fleet-science-agent');

      // Already non-green BEFORE this fix — `skip-unverified` sits at the
      // same "requires operator attention" bar as `failed`/`drift`
      // (`applyExitCode`'s own doc). This fix adds a coverage-SPECIFIC
      // statement to an ALREADY-attention-flagged run; it does not turn a
      // green run non-green (the run was never green).
      expect(applyExitCode(result)).not.toBe(0);

      // AC: "--json carries the unverified state" — asserted against the
      // ACTUAL serialized render, not inferred from reading `redactIdentity`.
      const json = JSON.stringify(fleetApplyResultToJson(result));
      expect(json).toContain('was ALSO not verified this run');
      expect(json).toContain('demo-fleet-code-agent');
      expect(json).toContain('demo-fleet-science-agent');
    });

    it('a vault-aware run that still lands on skip-unverified for an UNRELATED reason (confirmAppInstallation unconfirmable) is UNCHANGED — no coverage note, since re-running with the same flags would not fix it', async () => {
      const manifestPath = manifestPathIn();
      const manifest = repoScopedManifest();
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      // resolveKeyPath IS wired (this run had --vault/--identity-key) but
      // the live re-confirm itself couldn't complete — a DIFFERENT failure
      // shape than #1016's flagless gap; re-running with the SAME flags
      // would not fix it, so the coverage-not-verified note must NOT appear.
      const vaultAwareUnconfirmableDeps: AgentApplyDeps = {
        startManifestFlow: async () => {
          throw new Error('must not be called — a prior lock entry never reaches the create path');
        },
        startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
        exchangeManifestCode: async () => {
          throw new Error('must not be called');
        },
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
        waitForAppInstallation: async () => {
          throw new Error('must not be called');
        },
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {},
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(vaultAwareUnconfirmableDeps, manifestPath),
        checkRegistryRepoCoverage: async () => {
          throw new Error('must not be called — skip-unverified never reaches the live coverage check');
        },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents[0]?.identity.status).toBe('skipped-unverified');
      const identity = result.agents[0]?.identity;
      const reason = identity?.status === 'skipped-unverified' ? identity.reason : '';
      // The ORIGINAL, unextended `confirmBeforeCreateGuard` text — proves
      // this run is byte-identical to pre-#1016 (requirement 3).
      expect(reason).toContain('Could not confirm the existing App');
      expect(reason).not.toContain('groundnuty/macf#1016');
      expect(reason).not.toContain('Registry-repo coverage');
    });

    it('registry.type !== "repo" (profile scope): a flagless skip-unverified run emits NOTHING new — byte-identical to pre-#1016', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]); // default owner.registry.type === 'profile'
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'skipped-unverified', 'x', 'y'), manifestPath),
        trustDeps: trustDepsFor({ checkRegistryPresence: async () => 'present', readRegistryVariable: async () => 'EXISTING-CA-CERT-PEM' }),
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      const identity = result.agents[0]?.identity;
      const reason = identity?.status === 'skipped-unverified' ? identity.reason : '';
      expect(reason).not.toContain('groundnuty/macf#1016');
      expect(reason).not.toContain('Registry-repo coverage');
    });
  });

  // --- DR-043 Amendment G correction (groundnuty/macf#1034) — revival
  // covers every declared repo, not the control repo alone ---
  describe('agent-repo revival (macf#1034 — corrects Amendment G\'s control-repo-only revival)', () => {
    // Same shape as `control-repo.test.ts`'s `SAME_FLEET_YAML` — only
    // `metadata.name` is compared by `classifyControlRepoOwnership`
    // (`control-repo.ts`'s doc), so a MINIMAL single-agent manifest body
    // satisfies the name-match check regardless of this file's own
    // `manifestWith([CODE_AGENT, SCI_AGENT])` having two.
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
`;

    /**
     * BOTH agents already confirmed live via `priorLock` — the `reused`
     * path (`agentDepsFor`-equivalent, keyed by `appId` like the existing
     * "reuse: fleet.lock already records..." test above) — so this test is
     * about repo REVIVAL, not identity provisioning.
     */
    function reusedTwoAgentDeps(): AgentApplyDeps {
      return {
        startManifestFlow: async () => {
          throw new Error('must not be called — both roles have prior entries');
        },
        startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
        exchangeManifestCode: async () => {
          throw new Error('must not be called');
        },
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async (appId) => ({
          status: 'confirmed',
          install: { appId, installId: appId === 'app-code-agent' ? 'install-1' : 'install-2', appSlug: `demo-fleet-${appId}`, accountLogin: 'groundnuty' },
        }),
        waitForAppInstallation: async () => {
          throw new Error('must not be called');
        },
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {},
      };
    }

    const PRIOR_LOCK: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
      ],
    };

    it('THE DECISIVE TEST — archive then apply leaves EVERY declared repo (control + every agent) revived, matching computeArchiveRepoTargets exactly', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const revivedRepos: string[] = [];

      const controlRepoDeps: ControlRepoDeps = {
        ...controlRepoDepsFor(),
        checkMeta: async () => ({ presence: 'present', archived: true }),
        readManifestFile: async () => SAME_FLEET_YAML,
        unarchiveRepo: async (repo) => {
          revivedRepos.push(repo);
        },
      };
      const agentRepoDeps: AgentRepoDeps = {
        // EVERY declared agent repo reports archived — the exact `archive`
        // then `apply` scenario from the issue.
        checkMeta: async () => ({ presence: 'present', archived: true }),
        createRepo: async () => {
          throw new Error('must not be called — every agent repo is present, not absent');
        },
        unarchiveRepo: async (repo) => {
          revivedRepos.push(repo);
        },
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedTwoAgentDeps(), manifestPath),
        controlRepoDeps,
        agentRepoDeps,
        // Mirrors `bootstrap-apply.ts`'s `resolveMutateDeps` production
        // wiring EXACTLY — the SAME single plan-approve-once "yes" licenses
        // both (see `FleetApplyDeps.agentRepoOptions`'s doc).
        controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..'), confirmUnarchive: true },
        agentRepoOptions: { confirmUnarchive: true },
      };

      const result = await applyFleet(manifest, manifestPath, PRIOR_LOCK, deps);

      expect(result.controlRepo.status).toBe('revived');
      expect(result.agents.map((a) => a.identity.status)).toEqual(['reused', 'reused']);

      // The decisive assertion (macf#1034 requirement 1): the SET of repos
      // this run revived is EXACTLY the SET `archive` would have targeted —
      // `computeArchiveRepoTargets` (`teardown.ts`), the same target-set
      // function the teardown direction already uses. Order-independent
      // (both sides sorted) — what matters is set equality, not sequence.
      expect([...revivedRepos].sort()).toEqual([...computeArchiveRepoTargets(manifest)].sort());
      expect(revivedRepos).toContain('groundnuty/demo-fleet-control');
      expect(revivedRepos).toContain('groundnuty/demo-code');
      expect(revivedRepos).toContain('groundnuty/demo-science');

      // "one approval covers the set" (macf#1034 requirement 2): every
      // repo's revival fires from the SAME single `confirmUnarchive: true`
      // — there is no per-repo confirm callback in `FleetApplyDeps` at all,
      // so a second/duplicate revival attempt per repo would be the only
      // way this count could exceed 1-per-repo. Exactly 3 calls for 3
      // archived repos, never more.
      expect(revivedRepos).toHaveLength(3);
    });

    it('control repo FOREIGN -> no agent repo is ever checked for archived state, let alone revived (a repo archived by someone else stays untouched)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const agentCheckMeta = vi.fn();
      const agentUnarchive = vi.fn();
      const controlRepoDeps: ControlRepoDeps = {
        ...controlRepoDepsFor(),
        checkMeta: async () => ({ presence: 'present', archived: true }),
        // A DIFFERENT fleet's fleet.yaml — name-mismatch -> 'foreign'
        // (`classifyControlRepoOwnership`'s doc). The whole run aborts
        // before the per-agent loop; no agent repo is even READ, let alone
        // un-archived.
        readManifestFile: async () => SAME_FLEET_YAML.replace('name: demo-fleet', 'name: someone-elses-fleet'),
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedTwoAgentDeps(), manifestPath),
        controlRepoDeps,
        agentRepoDeps: { checkMeta: agentCheckMeta, createRepo: vi.fn(), unarchiveRepo: agentUnarchive },
        agentRepoOptions: { confirmUnarchive: true },
      };

      const result = await applyFleet(manifest, manifestPath, PRIOR_LOCK, deps);

      expect(result.controlRepo.status).toBe('foreign');
      expect(result.agents).toEqual([]);
      expect(agentCheckMeta).not.toHaveBeenCalled();
      expect(agentUnarchive).not.toHaveBeenCalled();
    });

    it('already-active repos report as such with NO archived-state mutation attempted — unarchiveRepo never called for a non-archived repo', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const unarchiveRepo = vi.fn();
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedTwoAgentDeps(), manifestPath),
        // Control repo is a normal, ALREADY-created `'ours'` repo (never
        // archived this run) — `controlRepoDepsFor()`'s default `'absent'`
        // would instead exercise the CREATE path, which is a different
        // scenario; force `'ours'` explicitly here.
        controlRepoDeps: {
          ...controlRepoDepsFor(),
          checkMeta: async () => ({ presence: 'present', archived: false }),
          readManifestFile: async () => SAME_FLEET_YAML,
        },
        agentRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: false }),
          createRepo: async () => {
            throw new Error('must not be called — every repo is already present');
          },
          unarchiveRepo,
        },
        agentRepoOptions: { confirmUnarchive: true },
      };

      const result = await applyFleet(manifest, manifestPath, PRIOR_LOCK, deps);

      expect(result.controlRepo.status).toBe('reused');
      expect(result.agents.map((a) => a.identity.status)).toEqual(['reused', 'reused']);
      expect(unarchiveRepo).not.toHaveBeenCalled();
    });

    it('unreachable archived-state read on an agent repo -> "unknown", reported (not silently skipped), unarchiveRepo never called for that repo', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const unarchiveRepo = vi.fn();
      const deps: FleetApplyDeps = {
        ...baseDeps(reusedTwoAgentDeps(), manifestPath),
        controlRepoDeps: {
          ...controlRepoDepsFor(),
          checkMeta: async () => ({ presence: 'present', archived: false }),
          readManifestFile: async () => SAME_FLEET_YAML,
        },
        agentRepoDeps: {
          checkMeta: async (repo) => (repo === 'groundnuty/demo-code' ? { presence: 'unknown' } : { presence: 'present', archived: false }),
          createRepo: async () => {},
          unarchiveRepo,
        },
        agentRepoOptions: { confirmUnarchive: true },
      };

      const result = await applyFleet(manifest, manifestPath, PRIOR_LOCK, deps);

      expect(result.agents.find((a) => a.role === 'code-agent')?.identity.status).toBe('failed');
      expect(result.agents.find((a) => a.role === 'code-agent')?.identity.status === 'failed' && result.agents.find((a) => a.role === 'code-agent')?.identity).toMatchObject({
        reason: expect.stringContaining('could not be ensured before consent gate 1'),
      });
      // science-agent's repo WAS confirmed non-archived -> proceeds normally.
      expect(result.agents.find((a) => a.role === 'science-agent')?.identity.status).toBe('reused');
      expect(unarchiveRepo).not.toHaveBeenCalled();
    });
  });

  // --- groundnuty/macf#1072 (DR-043 Amendment L extended to
  // `versions.actions`) — the actions-pin reconcile, end to end through
  // `applyFleet`. ---
  describe('actions-pin reconcile (groundnuty/macf#1072)', () => {
    it('DECISIVE — a stale agent pin RECONCILES, an already-matching control-repo pin reports already-current, and the two statuses are TEXTUALLY DISTINCT (never inferable from one summary line)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        // manifest declares 'v3.4.1' (see manifestWith); the agent repo was
        // observed at the STALE 'v3.4.0', the control repo already matches.
        observedActionsPins: { agents: { 'code-agent': 'v3.4.0' }, controlRepo: 'v3.4.1' },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.actionsPin.attempted).toBe(true);
      expect(result.actionsPin.target).toBe('v3.4.1');
      const agentResult = result.actionsPin.results.find((r) => r.repo === 'groundnuty/demo-code');
      const controlResult = result.actionsPin.results.find((r) => r.repo === 'groundnuty/demo-fleet-control');
      expect(agentResult?.status).toBe('reconciled');
      expect(controlResult?.status).toBe('already-current');
      // Textually distinct — not two phrasings of one line (assert-the-wrong-path.md).
      expect(agentResult?.status).not.toBe(controlResult?.status);
      expect(['reconciled', 'already-current', 'could-not-attempt']).toContain(agentResult?.status);
      expect(['reconciled', 'already-current', 'could-not-attempt']).toContain(controlResult?.status);
    });

    it('an agent whose identity is unresolved this run (failed) reports could-not-attempt — TEXTUALLY DISTINCT from both reconciled and already-current, never silently folded into either', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
        // science-agent has NO prior entry -> takes the CREATE path, and its
        // identity deps (below) fail during that path -> status 'failed'.
      };
      // ONE shared AgentApplyDeps, dispatched per-role by `applyIdentity`
      // itself based on prior-lock presence (mirrors this file's own
      // `reusedTwoAgentDeps` pattern above) — code-agent HAS a prior entry
      // so it takes the `confirmAppInstallation` (reused) path and never
      // reaches `exchangeManifestCode`; science-agent has none, so it takes
      // the CREATE path via `exchangeManifestCode`, which throws here.
      const sharedAgentDeps: AgentApplyDeps = {
        startManifestFlow: async () => ({
          startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {},
        }),
        startInstallInterstitial: async () => ({ startUrl: 'http://x/install', close: async () => {} }),
        exchangeManifestCode: async () => {
          throw new Error('boom — science-agent identity unresolved this run');
        },
        resolveKeyPath: () => '/fake.pem',
        confirmAppInstallation: async () => ({
          status: 'confirmed',
          install: { appId: 'app-code-agent', installId: 'install-1', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' },
        }),
        waitForAppInstallation: async () => {
          throw new Error('must not be called — no role reaches gate 2 in this scenario');
        },
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {},
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(sharedAgentDeps, manifestPath),
        buildAgentDeps: () => sharedAgentDeps,
        observedActionsPins: { agents: { 'code-agent': 'v3.4.1' }, controlRepo: 'v3.4.1' },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.agents.find((a) => a.role === 'science-agent')?.identity.status).toBe('failed');
      const sciResult = result.actionsPin.results.find((r) => r.repo === 'groundnuty/demo-science');
      expect(sciResult?.status).toBe('could-not-attempt');
      expect(sciResult?.reason).toMatch(/identity is unresolved/);
      // The reused agent's own pin already matched -> distinct status, not swept into the same bucket.
      const codeResult = result.actionsPin.results.find((r) => r.repo === 'groundnuty/demo-code');
      expect(codeResult?.status).toBe('already-current');
      expect(codeResult?.status).not.toBe(sciResult?.status);
    });

    it('absent versions.actions (versions: not declared at all): NO action is recorded — attempted:false, results empty — the same no-opinion gate the version(macf) phase already uses', async () => {
      const manifestPath = manifestPathIn();
      const manifest: FleetManifest = { ...manifestWith([CODE_AGENT]), versions: undefined };
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'reused', 'app-code-agent', 'install-1'), manifestPath),
        observedActionsPins: { agents: { 'code-agent': 'v9.9.9' }, controlRepo: 'v9.9.9' },
      };

      const result = await applyFleet(manifest, manifestPath, priorLock, deps);

      expect(result.actionsPin).toEqual({ attempted: false, results: [] });
    });
  });

  // --- groundnuty/macf#1082 — the router App's SHARED-scope reuse, through
  // applyFleet itself (the orchestrator where the mint seam actually lives —
  // a unit test of resolveSharedRouterAppReuse alone cannot prove the
  // CALLER honors the decision). ---
  describe('router App — SHARED scope (groundnuty/macf#1082 default)', () => {
    /** `manifestWith(...)` now pins EVERY OTHER test in this file to `'per-fleet'` — these tests need the real (shared) default, so they override it back explicitly. */
    function sharedScopeManifest(agents: readonly FleetAgent[], ageRecipients: readonly string[] = ['age1operator', 'age1vm']): FleetManifest {
      return { ...manifestWith(agents, ageRecipients), transport: { age_recipients: ageRecipients, router_app_scope: 'shared' } };
    }

    it('THE DECISIVE TEST: vault carries router App id+key -> the mint/manifest-flow seam is NEVER invoked (throwing fake, not a call-count) — and the existing MACF_ROUTING_APP_ID/KEY_B64 vault entries survive the compose BYTE-IDENTICAL (never overwritten)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = sharedScopeManifest([CODE_AGENT]);
      const EXISTING_ROUTER_APP_ID = '9001';
      const EXISTING_ROUTER_APP_KEY_B64 = Buffer.from('EXISTING-SHARED-ROUTER-PEM').toString('base64');
      const existingVaultRaw =
        `MACF_ROUTING_APP_ID='${EXISTING_ROUTER_APP_ID}'\n` +
        `MACF_ROUTING_APP_KEY_B64='${EXISTING_ROUTER_APP_KEY_B64}'\n` +
        "MACF_AGENT_DEMO_FLEET_SCIENCE_AGENT_APP_ID='app-science-agent'\n";
      let capturedFinalPlaintext = '';

      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: () => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          startManifestFlow: async (opts) => {
            if (opts.role === 'router') {
              throw new Error('must not be called — the router App resolved via vault-reuse; zero App-creation attempts this run');
            }
            return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} };
          },
          exchangeManifestCode: async () => creds('code-agent'),
        }),
        vaultDeps: { exists: () => true, encrypt: async (_pt, _r, outPath) => writeFileSync(outPath, 'FAKE-CIPHERTEXT') },
        identityKeyPath: '/fake/operator-key.txt',
        vaultComposeDeps: {
          exists: () => true,
          assertIdentityReadable: () => {},
          decrypt: async () => existingVaultRaw,
          encrypt: async (plaintext) => {
            capturedFinalPlaintext = plaintext;
          },
          rename: () => {},
          unlink: () => {},
        },
        routerAppVaultDeps: {
          readVaultRouterApp: async () => ({ appId: EXISTING_ROUTER_APP_ID, appKeyPem: 'EXISTING-SHARED-ROUTER-PEM' }),
        },
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routerApp).toEqual({ role: 'router', status: 'vault-reused', appId: EXISTING_ROUTER_APP_ID });
      // No agents[] entry for 'router' — the vault, not the lock, is this
      // scope's source of truth for the credential VALUE (nothing NEW was
      // resolved this run, no install to confirm).
      expect(existsSync(result.lockPath)).toBe(true);
      const lock: FleetLock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
      expect(lock.agents.some((a) => a.role === 'router')).toBe(false);
      // groundnuty/macf#1162 — but a PROVENANCE marker IS written (this
      // manifest declares no `router_app_origin_fleet`, so it honestly
      // omits `origin_fleet` rather than a fabricated sentinel — the
      // "origin declared" case is covered by the DECISIVE pair below).
      expect(lock.scope_credentials).toEqual([{ role: 'router', scope: 'scope-level', held: 'locally', pending: 'scope-store' }]);

      // THE byte-identity assertion (assert-the-wrong-path.md: "byte-identity
      // of untouched state") — the SAME two lines, character-for-character,
      // not merely "a value is still present."
      expect(result.vault.status).toBe('written');
      const finalRaw = parseVaultPlaintext(capturedFinalPlaintext);
      expect(finalRaw['MACF_ROUTING_APP_ID']).toBe(EXISTING_ROUTER_APP_ID);
      expect(finalRaw['MACF_ROUTING_APP_KEY_B64']).toBe(EXISTING_ROUTER_APP_KEY_B64);
    });

    it('empty vault (no readVaultRouterApp) + shared name confirmed FREE -> STILL creates (the non-regression: reuse is not the only path)', async () => {
      const manifestPath = manifestPathIn();
      const manifest = sharedScopeManifest([CODE_AGENT]);
      let routerGate1Called = false;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: () => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          startManifestFlow: async (opts) => {
            if (opts.role === 'router') routerGate1Called = true;
            return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} };
          },
          exchangeManifestCode: async () => creds('router'),
          checkAppNameCollision: async () => 'absent',
          // `validateRouterAppInstall` fails CLOSED on a missing
          // `repositorySelection` (apply-router-app.ts's doc) — the base
          // fixture's canned `waitForAppInstallation` omits it entirely, so
          // the router App's own gate 2 needs the explicit 'selected' shape
          // every other install-validated test in this file already supplies.
          waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: 'install-router', appSlug: opts.expected.appSlug ?? '', accountLogin: 'groundnuty', repositorySelection: 'selected' }),
        }),
        routerAppVaultDeps: {}, // vault-aware restore NOT engaged
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(routerGate1Called).toBe(true);
      expect(result.routerApp.status).toBe('created');
      if (result.routerApp.status === 'created') {
        // The manifest actually submitted to GitHub carries this manifest
        // owner's shared (owner-keyed, groundnuty/macf#1088) handle, never
        // a fleet-prefixed one.
        expect(result.routerApp.appId).toBeDefined();
      }
    });

    it('empty vault + shared name confirmed TAKEN -> refuses with the instruction, NEVER a silent failure and NEVER a per-fleet fallback the operator did not ask for', async () => {
      const manifestPath = manifestPathIn();
      const manifest = sharedScopeManifest([CODE_AGENT]);
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: () => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          startManifestFlow: async (opts) => {
            if (opts.role === 'router') throw new Error('must not be called — a confirmed name-collision refuses before gate 1');
            return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} };
          },
          exchangeManifestCode: async () => creds('code-agent'),
          checkAppNameCollision: async () => 'present',
        }),
        routerAppVaultDeps: {},
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routerApp.status).toBe('failed');
      if (result.routerApp.status === 'failed') {
        expect(result.routerApp.reason).toMatch(/MACF_ROUTING_APP_ID/);
        expect(result.routerApp.reason).toMatch(/router_app_scope: per-fleet/);
      }
      // The instruction never leaks a credential value.
      expect(result.routerApp.status === 'failed' ? result.routerApp.reason : '').not.toMatch(/BEGIN.*PRIVATE KEY/);
    });
  });

  describe('router App — per-fleet scope opt-in (groundnuty/macf#1082) still works, unchanged', () => {
    it('transport.router_app_scope: per-fleet bypasses the new shared-reuse decision entirely — a fresh fleet still CREATEs its own dedicated App even with an unrelated shared App already confirmed taken', async () => {
      const manifestPath = manifestPathIn();
      // manifestWith(...) already sets router_app_scope: 'per-fleet' — this
      // test names the property explicitly rather than relying on it silently.
      const manifest = manifestWith([CODE_AGENT]);
      expect(manifest.transport.router_app_scope).toBe('per-fleet');
      let routerGate1Called = false;
      let readVaultRouterAppCalls = 0;
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: () => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          startManifestFlow: async (opts) => {
            if (opts.role === 'router') routerGate1Called = true;
            return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} };
          },
          exchangeManifestCode: async () => creds('router'),
          waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: 'install-router', appSlug: opts.expected.appSlug ?? '', accountLogin: 'groundnuty', repositorySelection: 'selected' }),
          // The SHARED (owner-keyed, groundnuty/macf#1088) name reads
          // "present" (taken); the PER-FLEET handle reads "absent" (free) —
          // discriminated by the slug actually queried, not the role,
          // because `applyIdentity`'s OWN generic collision pre-flight
          // (apply-agent.ts) uses this SAME hook for EVERY role including
          // per-fleet-scope's router App. If per-fleet scope silently
          // queried this manifest owner's shared name instead of its own
          // fleet-derived one, this fake would refuse it — proving the
          // isolation, not just asserting it.
          checkAppNameCollision: async (_owner, appSlug) => (appSlug === deriveRouterAppHandle('demo-fleet', 'groundnuty', 'shared') ? 'present' : 'absent'),
        }),
        // A vault carrying SHARED credentials must NOT be consulted either —
        // per-fleet scope has its own identity, never the shared one.
        routerAppVaultDeps: {
          readVaultRouterApp: async () => {
            readVaultRouterAppCalls += 1;
            return { appId: 'someone-elses-shared-app', appKeyPem: 'SHOULD-NEVER-BE-USED' };
          },
        },
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(routerGate1Called).toBe(true);
      expect(result.routerApp.status).toBe('created');
      // Per-fleet scope never runs resolveSharedRouterAppReuse at all —
      // the shared-scope vault-check seam is untouched.
      expect(readVaultRouterAppCalls).toBe(0);
    });
  });

  // --- groundnuty/macf#1162 — the DECISIVE PAIR for the scope-credential
  // provenance marker: a fleet holding a scope-level (cross-fleet-copied)
  // router credential gets a marker naming its origin; a fleet that
  // genuinely owns its router App (never resolved 'vault-reused') gets
  // NONE — otherwise the marker means nothing (per assert-the-wrong-path.md,
  // the negative half is what gives the positive half meaning). ---
  describe('router App — scope-credential provenance marker (groundnuty/macf#1162)', () => {
    function sharedScopeManifestWithOrigin(originFleet: string | undefined): FleetManifest {
      const base = manifestWith([CODE_AGENT]);
      return {
        ...base,
        transport: {
          age_recipients: base.transport.age_recipients,
          router_app_scope: 'shared',
          ...(originFleet !== undefined ? { router_app_origin_fleet: originFleet } : {}),
        },
      };
    }

    it('DECISIVE 1/2: router key present-but-scope-level, origin DECLARED -> fleet.lock carries the marker naming the origin fleet', async () => {
      const manifestPath = manifestPathIn();
      const manifest = sharedScopeManifestWithOrigin('macf-fresh-1');
      const ROUTER_PEM = 'EXISTING-SHARED-ROUTER-PEM-FOR-1162';
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: () => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          startManifestFlow: async (opts) => {
            if (opts.role === 'router') throw new Error('must not be called — the router App resolved via vault-reuse');
            return { startUrl: 'http://x/', redirectUrl: 'http://x/callback', waitForCode: async () => 'code', close: async () => {} };
          },
          exchangeManifestCode: async () => creds('code-agent'),
        }),
        vaultDeps: { exists: () => true, encrypt: async (_pt, _r, outPath) => writeFileSync(outPath, 'FAKE-CIPHERTEXT') },
        identityKeyPath: '/fake/operator-key.txt',
        vaultComposeDeps: {
          exists: () => true,
          assertIdentityReadable: () => {},
          decrypt: async () => `MACF_ROUTING_APP_ID='9001'\nMACF_ROUTING_APP_KEY_B64='${Buffer.from(ROUTER_PEM).toString('base64')}'\n`,
          encrypt: async () => {},
          rename: () => {},
          unlink: () => {},
        },
        routerAppVaultDeps: { readVaultRouterApp: async () => ({ appId: '9001', appKeyPem: ROUTER_PEM }) },
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routerApp).toEqual({ role: 'router', status: 'vault-reused', appId: '9001' });
      const rawLockText = readFileSync(result.lockPath, 'utf-8');
      const lock: FleetLock = parseFleetLock(rawLockText);
      // Still no agents[] entry (no install was confirmed this run) — the
      // marker is additive, not a substitute for that existing contract.
      expect(lock.agents.some((a) => a.role === 'router')).toBe(false);
      expect(lock.scope_credentials).toEqual([
        { role: 'router', scope: 'scope-level', held: 'locally', origin_fleet: 'macf-fresh-1', pending: 'scope-store' },
      ]);
      // The marker never carries key material — assert against the
      // SERIALIZED STRING (what's actually on disk), not the parsed object.
      expect(rawLockText).not.toContain(ROUTER_PEM);
      expect(rawLockText).not.toContain('BEGIN');
      expect(rawLockText).not.toContain('PRIVATE KEY');
    });

    it('DECISIVE 2/2: a fleet whose router it genuinely owns (per-fleet scope, freshly created this run) -> NO marker', async () => {
      const manifestPath = manifestPathIn();
      // manifestWith(...) defaults to router_app_scope: 'per-fleet' — this
      // fleet mints its OWN dedicated App; 'vault-reused' is unreachable.
      const manifest = manifestWith([CODE_AGENT]);
      expect(manifest.transport.router_app_scope).toBe('per-fleet');
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: () => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          exchangeManifestCode: async () => creds('router'),
          waitForAppInstallation: async (opts) => ({
            appId: opts.appId,
            installId: 'install-router',
            appSlug: opts.expected.appSlug ?? '',
            accountLogin: 'groundnuty',
            repositorySelection: 'selected',
          }),
        }),
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.routerApp.status).toBe('created');
      const lock: FleetLock = parseFleetLock(readFileSync(result.lockPath, 'utf-8'));
      expect(lock.agents.some((a) => a.role === 'router')).toBe(true);
      // THE negative assertion: the key that would prove "genuinely owns"
      // is that the marker's absence is a full key-absence, not an empty
      // array — `composeFleetLock` omits the key entirely when nothing
      // qualifies (see fleet-lock.ts's `mergeScopeCredentials` doc).
      expect(lock.scope_credentials).toBeUndefined();
      expect(Object.hasOwn(lock, 'scope_credentials')).toBe(false);
    });
  });

  // --- groundnuty/macf#1128 — the decisive pair: an ORDINARY agent App's
  // OWN repository_selection is now checked too, not just runner-ops's/the
  // router's. Two live fleets hit exactly this gap: a coordination agent
  // App installed "All repositories," carrying DR-019's full permission set
  // (including contents:write) onto every repo in the org.
  describe('agent App repository_selection (groundnuty/macf#1128)', () => {
    it('DECISIVE 1/2: an "all"-scoped install is REFUSED for an ORDINARY agent App — naming the App and the remediation, and later steps do NOT run for it', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      let repoInitCalled = false;
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {
          repoInitCalled = true;
        },
        commitAndPush: async () => 'pushed',
      };
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath, repoInitDeps),
        buildAgentDeps: (log) => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          log,
          waitForAppInstallation: async (opts) => ({
            appId: opts.appId,
            installId: 'install-x',
            appSlug: opts.expected.appSlug ?? '',
            accountLogin: 'groundnuty',
            repositorySelection: 'all', // the exact hazard reported live, twice
          }),
        }),
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      // Refused — named, actionable, naming THIS App's own handle:
      expect(result.agents[0]?.identity.status).toBe('failed');
      const reason = result.agents[0]?.identity.status === 'failed' ? result.agents[0].identity.reason : undefined;
      expect(reason).toContain('demo-fleet-code-agent'); // the App
      expect(reason).toMatch(/repository_selection must be "selected"/);
      expect(reason).toMatch(/"all"/); // the observed value
      expect(reason).toMatch(/open the install page/); // the remediation
      expect(reason).toMatch(/Only select repositories/);
      expect(reason).toMatch(/re-run apply/);

      // THE decisive assertion per assert-the-wrong-path.md: a check that
      // rejects EVERY install (even a correctly-scoped one) would satisfy
      // "refused" trivially. Prove the run did NOT proceed to the steps a
      // successful create would have taken for this role — repo-init never
      // ran, and no fleet.lock entry exists for it (the sibling positive
      // case below proves the SAME assertions flip to true on 'selected').
      expect(repoInitCalled).toBe(false);
      expect(result.agents[0]?.repoInit).toBeUndefined();
      expect(result.finalLock?.agents.some((a) => a.role === 'code-agent')).toBe(false);
    });

    it('DECISIVE 2/2: a "selected"-scoped install proceeds UNCHANGED — the sibling positive case proving (1) isn\'t just "refuse everything"', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      let repoInitCalled = false;
      // `creds()`'s SENTINEL (non-parseable) pem makes the REAL `repoInit()`
      // genuinely fail token-generation (macf#920) — irrelevant to THIS
      // test (repository_selection, not label-wiring), so fake `repoInit`
      // itself, same as the file's very first "a freshly-created agent"
      // test does for the identical reason (see that test's own comment).
      const repoInitDeps: RepoInitStepDeps = {
        cloneRepo: async () => {
          repoInitCalled = true;
        },
        commitAndPush: async () => 'pushed',
        repoInit: (async () => ({
          workflow: 'created',
          config: 'created',
          labels: { status: 'ok', created: ['code-agent'], existed: [] },
        })) as never,
      };
      const deps = baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath, repoInitDeps);

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('created');
      expect(repoInitCalled).toBe(true);
      expect(result.agents[0]?.repoInit?.status).toBe('applied');
      expect(result.finalLock?.agents.some((a) => a.role === 'code-agent')).toBe(true);
    });

    it('a repository_selection absent from the response fails CLOSED, not merely "not all" — validateInstallRepositoryScope\'s own contract, exercised through the full apply-fleet orchestration', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT]);
      const deps: FleetApplyDeps = {
        ...baseDeps(agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'), manifestPath),
        buildAgentDeps: (log) => ({
          ...agentDepsFor('code-agent', 'created', 'app-code-agent', 'install-1'),
          log,
          waitForAppInstallation: async (opts) => ({
            appId: opts.appId,
            installId: 'install-x',
            appSlug: opts.expected.appSlug ?? '',
            accountLogin: 'groundnuty',
            // repositorySelection deliberately omitted — a malformed/future API shape
          }),
        }),
      };

      const result = await applyFleet(manifest, manifestPath, null, deps);

      expect(result.agents[0]?.identity.status).toBe('failed');
      const reason = result.agents[0]?.identity.status === 'failed' ? result.agents[0].identity.reason : undefined;
      expect(reason).toMatch(/not reported by GitHub/);
    });
  });

  // --- groundnuty/macf#1179 — cancelling ONE identity's gate-2 wait never
  // discards ITS OWN recovery artifact, and never stops the REST of the
  // fleet. This is the property apply-agent.test.ts's own cancel tests
  // cannot pin on their own — the recovery artifact's deletion happens in
  // apply-fleet.ts, gated on `identity.status === 'created'` folding into
  // `pendingCreatedUpdates` (see this file's "THE DECISIVE ASSERTION" test
  // above, same shape, different trigger). A cancelled identity's status is
  // `'failed'`, never `'created'` — so it structurally can never reach that
  // deletion path; this test proves it with a REAL file on disk, not an
  // inference from the type.
  describe('cancelling one identity preserves its recovery artifact and does not affect other agents (groundnuty/macf#1179)', () => {
    it('code-agent is CANCELLED mid-gate-2 (its own recovery artifact still exists afterward); science-agent completes normally in the SAME run', async () => {
      const manifestPath = manifestPathIn();
      const manifest = manifestWith([CODE_AGENT, SCI_AGENT]);
      const recoveryRootDir = mkdtempSync(join(tmpdir(), 'macf-1179-cancel-recovery-'));
      dirs.push(recoveryRootDir);

      const agentDeps: AgentApplyDeps = {
        // `waitForCode` resolves to `opts.role` itself, and `exchangeManifestCode`
        // treats the "code" as the role — the only way this fixture can hand
        // back a role-SCOPED credential (`creds(role)`, distinct slug per
        // role) despite `exchangeManifestCode`'s real signature carrying no
        // role parameter of its own.
        startManifestFlow: async (opts) => ({
          startUrl: `http://x/${opts.role}`, redirectUrl: 'http://x/callback', waitForCode: async () => opts.role, close: async () => {},
        }),
        exchangeManifestCode: async (code) => creds(code),
        confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
        openUrl: async () => {},
        log: () => {},
        writeRecoveryArtifact: async () => {}, // overridden for real by applyFleet regardless — see baseDeps's doc
        startInstallInterstitial: async (opts) => ({
          startUrl: `http://x/install/${opts.role}`,
          close: async () => {},
          // Cancel fires ONLY for code-agent — science-agent's page is never
          // clicked "cancel" on, so its own gate 2 must complete normally.
          waitForCancel: opts.role === 'code-agent' ? (): Promise<void> => Promise.resolve() : undefined,
        }),
        waitForAppInstallation: async (opts) => {
          if (opts.expected.appSlug?.includes('code-agent') === true) {
            // Never resolves on its own — ONLY the cancel race (above) can
            // end code-agent's wait. If cancel were NOT wired, this test
            // would time out instead of asserting anything.
            return new Promise(() => { /* hangs forever */ });
          }
          return { appId: opts.appId, installId: 'install-science', appSlug: opts.expected.appSlug ?? '', accountLogin: 'groundnuty', repositorySelection: 'selected' };
        },
      };

      const deps: FleetApplyDeps = { ...baseDeps(agentDeps, manifestPath), recoveryRootDir };
      const result = await applyFleet(manifest, manifestPath, null, deps);

      const codeAgentIdentity = result.agents.find((a) => a.role === 'code-agent')?.identity;
      const sciAgentIdentity = result.agents.find((a) => a.role === 'science-agent')?.identity;

      // code-agent: cancelled, not a generic failure — and NEVER 'created'
      // (the type-level property `pendingCreatedUpdates`'s gate depends on).
      expect(codeAgentIdentity?.status).toBe('failed');
      if (codeAgentIdentity?.status === 'failed') {
        expect(codeAgentIdentity.reason).toContain('cancelled by the operator');
      }

      // science-agent: unaffected — the fleet loop continued past code-agent's cancel.
      expect(sciAgentIdentity?.status).toBe('created');

      // THE DECISIVE ASSERTION — code-agent's recovery artifact (written
      // BEFORE gate 2 ever opened, immediately after gate 1's credential
      // exchange) still exists on disk. Cancelling gate 2 must never reach
      // for it.
      const codeAgentRecoveryPath = operatorRecoveryArtifactPath(recoveryRootDir, 'demo-fleet', 'code-agent');
      expect(existsSync(codeAgentRecoveryPath)).toBe(true);
    });
  });
});
