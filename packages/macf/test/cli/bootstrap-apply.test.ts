/**
 * Tests for `macf bootstrap apply` (DR-043 §D2, Slice 2b of
 * groundnuty/macf#838).
 *
 * **`--dry-run` suite (increments 1-3, unchanged):** the load-bearing case is
 * that `--dry-run` renders the full plan + blast radius and mutates nothing.
 *
 * **Mutating-apply suite (increment 5a, THIS increment):** supersedes the
 * old "non-`--dry-run` FAILS LOUD, not implemented yet" tests — those tested
 * a placeholder that no longer exists now that the real orchestrator
 * (`apply-fleet.ts`) is wired in. The load-bearing cases here are the
 * plan-approve-once gate (operator declines → nothing mutates) and `--yes`
 * bypassing it for automation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBootstrapApply,
  resolveMutateDeps,
  plannedAppCreations,
  formatPlannedAppCreations,
  formatApplyResult,
  fleetApplyResultToJson,
  applyExitCode,
  DRY_RUN_REDIRECT_PLACEHOLDER,
  FLEET_APPLY_JSON_SCHEMA_VERSION,
  type MutateApplyDeps,
} from '../../src/cli/commands/bootstrap-apply.js';
import { parseFleetManifest } from '../../src/cli/bootstrap/fleet-manifest.js';
import { parseFleetLock } from '../../src/cli/bootstrap/fleet-manifest.js';
import { computePlan } from '../../src/cli/bootstrap/plan.js';
import type { ObservedState, UnimplementedApplyItem } from '../../src/cli/bootstrap/plan.js';
import type { FleetApplyResult } from '../../src/cli/bootstrap/apply-fleet.js';
import type { AgentApplyDeps } from '../../src/cli/bootstrap/apply-agent.js';
import type { AppCredentials } from '../../src/cli/bootstrap/manifest-exchange.js';
import type { CaApplyDeps } from '../../src/cli/bootstrap/apply-ca.js';
import type { RoutingClientApplyDeps } from '../../src/cli/bootstrap/apply-routing-client.js';
import type { RunnerRegistrationDeps } from '../../src/cli/bootstrap/apply-routing.js';
import { RUNNER_TOKEN_ENV_VAR, RUNNER_TOKEN_FLAG } from '../../src/cli/bootstrap/apply-routing.js';
import { VaultError, buildVaultPlaintext, type VaultAgentSecrets } from '../../src/cli/bootstrap/vault-write.js';
import { parseVaultPlaintext } from '../../src/cli/bootstrap/vault-read.js';

const FLEET_YAML = `apiVersion: macf/v0
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
  age_recipients: [age1qtestrecipientxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/demo-code
    deploy_path: /home/ubuntu/repos/demo-code
  - role: science-agent
    profile: research
    repo: groundnuty/demo-science
    deploy_path: /home/ubuntu/repos/demo-science
`;

/** Observed state where NOTHING exists — every agent is an App create-candidate. */
const EMPTY_OBSERVED: ObservedState = {
  lock: null,
  agents: {},
  caRegistry: 'absent',
  caRepos: {},
  controlRepoPresence: 'absent',
};

/**
 * DR-043 Amendment D phase 2 (macf#838) — a manifest that DOES declare
 * `routing:`, plus an observed `routingTrustedActors` that DIVERGES from the
 * manifest-derived value (`update` verb; macf#922 corrected the observed
 * field from `routingRunsOn`/`MACF_ROUTING_RUNS_ON`). `ca` is fully
 * implemented now (mint-or-reuse + two-place publish); routing's `create`
 * verb is too — the ONLY plan item that still legitimately reads
 * `unimplementedByApply` is a routing `update` (apply's create-only posture
 * never overwrites a present-but-diverging value — see
 * `plan.ts::planItemApplyCoverage`'s routing case). These two fixtures are
 * what exercises that one remaining honest gap.
 */
const FLEET_YAML_WITH_ROUTING = FLEET_YAML.replace(
  'agents:\n',
  'routing:\n  runner:\n    runs_on: self-hosted\nagents:\n',
);
const OBSERVED_ROUTING_DRIFT: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };

/**
 * DR-043 §D6 (this change) — a manifest that declares `versions:`, plus an
 * observed state where BOTH agents' deployed macf version DIVERGES from the
 * declared one. Same "apply cannot action this" shape as
 * `FLEET_YAML_WITH_ROUTING` / `OBSERVED_ROUTING_DRIFT` above — apply
 * provisions identity/repo/CA/routing wiring but never rolls fleet software
 * (§D4); `planItemApplyCoverage`'s `'version'` case is `not_implemented`
 * for BOTH verbs it can emit, so this fixture is the `--yes`-summary
 * regression guard for that.
 */
const FLEET_YAML_WITH_VERSIONS = FLEET_YAML.replace(
  'agents:\n',
  'versions:\n  macf: "0.2.60"\n  actions: v3.4.1\nagents:\n',
);
const OBSERVED_VERSION_DRIFT: ObservedState = {
  lock: null,
  agents: {
    'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, deployedVersion: '0.2.44', actionsPin: 'v3.4.1' },
    'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, deployedVersion: '0.2.44', actionsPin: 'v3.4.1' },
  },
  caRegistry: 'present',
  caRepos: {},
};

function observedWithApp(role: string): ObservedState {
  return {
    lock: null,
    agents: {
      [role]: { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
    },
    caRegistry: 'present',
    caRepos: {},
    controlRepoPresence: 'absent',
  };
}

describe('macf bootstrap apply — increment 1 (dry-run only)', () => {
  const dirs: string[] = [];
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errs.push(a.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeManifest(body = FLEET_YAML): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-apply-test-'));
    dirs.push(dir);
    const p = join(dir, 'fleet.yaml');
    writeFileSync(p, body);
    return p;
  }

  it('--dry-run renders the plan + would-be App manifests + consent gate 2 URL, and mutates nothing', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, dryRun: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/demo-fleet-code-agent/);
    expect(out).toMatch(/demo-fleet-science-agent/);
    expect(out).toMatch(/actions_variables:write/);
    expect(out).toMatch(/consent gate 2/);
    expect(out).toMatch(/https:\/\/github\.com\/apps\/demo-fleet-code-agent\/installations\/new/);
    expect(out).toMatch(/https:\/\/github\.com\/apps\/demo-fleet-science-agent\/installations\/new/);
    expect(out).toMatch(/DRY RUN — nothing was created/);
    // macf#838 Amendment D phase 2: CA is fully implemented now and this
    // fresh-fleet fixture declares no `routing:` section, so nothing is
    // unimplemented — see the dedicated routing-drift test below (and
    // `plan.test.ts`) for the ⚠ NOT IMPLEMENTED block's positive case.
    expect(out).not.toMatch(/NOT IMPLEMENTED BY APPLY/);
  });

  it('--dry-run STILL renders the ⚠ NOT IMPLEMENTED BY APPLY block for a diverging routing value (macf#838 Amendment D phase 2)', async () => {
    const file = writeManifest(FLEET_YAML_WITH_ROUTING);
    const code = await runBootstrapApply({ file, dryRun: true }, { observe: () => Promise.resolve(OBSERVED_ROUTING_DRIFT) });
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/NOT IMPLEMENTED BY APPLY/);
    expect(out).toMatch(/\brouting:.*\(update\)/);
    expect(out).not.toMatch(/\bca:.*\(create\)/);
  });

  it('--dry-run --json carries dry_run + planned_app_creations (incl. installUrl) + unimplemented_by_apply (macf#854)', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, dryRun: true, json: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      dry_run: boolean;
      planned_app_creations: { role: string; manifest: { name: string }; installUrl: string }[];
      unimplemented_by_apply: ReadonlyArray<{ kind: string }>;
    };
    expect(parsed.dry_run).toBe(true);
    // groundnuty/macf#943 — the runner-ops's own planned creation is
    // ALWAYS last (`plannedAppCreations` appends it after every agent's).
    expect(parsed.planned_app_creations.map((c) => c.manifest.name)).toEqual([
      'demo-fleet-code-agent',
      'demo-fleet-science-agent',
      'demo-fleet-runner-ops',
    ]);
    expect(parsed.planned_app_creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
      'https://github.com/apps/demo-fleet-runner-ops/installations/new',
    ]);
    // Inherited automatically from fleetPlanToJson(plan) — no separate wiring
    // needed. macf#838 Amendment D phase 2: `ca` is now fully implemented
    // (mint-or-reuse + two-place publish, macf#806) and this manifest
    // declares no `routing:` section, so nothing remains unimplemented for
    // a fresh fleet — see the dedicated routing-update test below for the
    // one case that's STILL honestly reported as not_implemented.
    expect(parsed.unimplemented_by_apply).toEqual([]);
  });

  it('reports a missing manifest file without throwing', async () => {
    const code = await runBootstrapApply(
      { file: '/nonexistent/fleet.yaml', dryRun: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/not found/i);
  });

  it('reports a schema-invalid manifest without throwing', async () => {
    const file = writeManifest('apiVersion: macf/v0\nkind: Fleet\n');
    const code = await runBootstrapApply(
      { file, dryRun: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/failed validation/i);
  });
});

describe('plannedAppCreations (pure)', () => {
  const manifest = parseFleetManifest(FLEET_YAML);

  it('includes an agent whose app item is create', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    // groundnuty/macf#943 — the runner-ops is ALWAYS a create-candidate
    // on a fresh fleet (no `fleet.lock` entry yet) and is appended LAST.
    expect(creations.map((c) => c.role)).toEqual(['code-agent', 'science-agent', 'runner-ops']);
    expect(creations[0]?.manifest.redirect_url).toBe(DRY_RUN_REDIRECT_PLACEHOLDER);
  });

  it('pairs each creation with its consent-gate-2 install URL, derived from the SAME handle as the manifest name', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
      'https://github.com/apps/demo-fleet-runner-ops/installations/new',
    ]);
    for (const c of creations) {
      expect(c.installUrl).toBe(`https://github.com/apps/${c.manifest.name}/installations/new`);
    }
  });

  it('EXCLUDES an agent whose App is already present (no re-create)', () => {
    const plan = computePlan(manifest, observedWithApp('code-agent'));
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    // groundnuty/macf#943 — the runner-ops has its OWN presence signal
    // (`fleet.lock`, not `observedWithApp`'s per-agent fixture), so it stays
    // a create-candidate here regardless of code-agent's presence.
    expect(creations.map((c) => c.role)).toEqual(['science-agent', 'runner-ops']);
  });

  it('formats an empty creation set without claiming work', () => {
    expect(formatPlannedAppCreations([])).toMatch(/No GitHub Apps would be created/);
  });
});

// --- Mutating apply (increment 5a) ---

const SENTINEL_CREDS: AppCredentials = {
  appId: '111',
  name: 'demo-fleet-code-agent',
  slug: 'demo-fleet-code-agent',
  clientId: 'client-id',
  clientSecret: 'SENTINEL-CLIENT-SECRET',
  webhookSecret: 'SENTINEL-WEBHOOK-SECRET',
  pem: 'SENTINEL-PEM-VALUE',
};

// DR-043 Amendment D phase 2 (macf#838) — distinct sentinels from
// SENTINEL_CREDS so a leak test can tell "an AGENT credential leaked" apart
// from "the CA key leaked" if one but not the other ever regresses.
const SENTINEL_CA_KEY_PEM = 'SENTINEL-CA-KEY-PEM';
const SENTINEL_CA_CERT_PEM = 'SENTINEL-CA-CERT-PEM';

// macf#913 — a THIRD, distinct sentinel: the vault-derived agent PEM the
// vault-aware confirm-before-create guard resolves. Distinct from
// SENTINEL_CREDS/SENTINEL_CA_KEY_PEM so a leak test can tell exactly which
// secret surface regressed.
const SENTINEL_VAULT_PEM = '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL-VAULT-PEM-BYTES\n-----END RSA PRIVATE KEY-----\n';

/**
 * macf#929 — `fakeMutateDeps`'s default `runnerToken`. `fakeTrustDeps`'s own
 * default already reports `checkRunnerUsableByRepo` as `'present'`, so this
 * sentinel exists ONLY to satisfy the new POLICY precondition
 * (`publishTrustedActorsGated` refuses outright with no token, independent of
 * live usability) — every pre-existing "routing var gets written" fixture in
 * this file keeps exercising the write path unchanged. Tests exercising the
 * no-token refusal itself override this to `undefined` explicitly.
 *
 * **macf#932 note — this sentinel alone is NOT enough for a `FLEET_YAML_WITH_ROUTING`
 * mutating-apply test any more.** The macf#932 pre-flight
 * (`apply-routing.ts::checkRunnerTokenPreflight`) reads the RESOLVED
 * `opts.runnerToken ?? process.env[RUNNER_TOKEN_ENV_VAR]` value — NOT
 * `mutateDeps.runnerToken` — because it fires before `resolveMutateDeps`
 * (and therefore before a directly-injected `mutateDeps` object) is ever
 * consulted. A test that sets `fakeMutateDeps(file, { runnerToken:
 * SENTINEL_RUNNER_TOKEN })` but leaves `opts.runnerToken` unset was ONLY
 * legal pre-macf#932 because `mutateDeps ?? resolveMutateDeps(...)`
 * short-circuits `resolveMutateDeps` (and therefore `opts.runnerToken`)
 * entirely whenever `mutateDeps` is injected directly. Every
 * `FLEET_YAML_WITH_ROUTING` fixture below that expects the mutating apply to
 * PROCEED now also passes `runnerToken: SENTINEL_RUNNER_TOKEN` in `opts` —
 * this is what a real invocation actually looks like (the CLI flag/env var
 * is what `apply` reads first), not a test-only workaround.
 */
const SENTINEL_RUNNER_TOKEN = 'SENTINEL-RUNNER-TOKEN';

/**
 * Default fake `CaApplyDeps & RunnerRegistrationDeps` (macf#838 Amendment D
 * phase 2; `checkRunnerUsableByRepo` added macf#922, org-scope-corrected +
 * renamed macf#924) — everything absent, except a runner IS confirmed
 * registered-and-usable by default (so the pre-existing "routing var gets
 * written" fixtures below keep exercising the write path unchanged);
 * individual tests override to exercise other shapes.
 */
function fakeTrustDeps(overrides: Partial<CaApplyDeps & RunnerRegistrationDeps> = {}): CaApplyDeps & RunnerRegistrationDeps {
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

function fakeAgentDeps(overrides: Partial<AgentApplyDeps> = {}): AgentApplyDeps {
  return {
    startManifestFlow: async () => ({
      startUrl: 'http://127.0.0.1:9/',
      redirectUrl: 'http://127.0.0.1:9/callback',
      waitForCode: async () => 'the-code',
      close: async () => {},
    }),
    exchangeManifestCode: async () => SENTINEL_CREDS,
    // groundnuty/macf#943 — `repository_selection: 'selected'` so the SAME
    // shared fixture also satisfies the runner-ops's own gate-2
    // `validateRunnerOpsInstall` check (it takes the identical
    // no-prior-lock CREATE path via `apply-fleet.ts`'s runner-ops
    // step, using this SAME `buildAgentDeps` factory) — the vast majority of
    // this file's scenarios are about AGENT behavior, not the runner-ops credential, so
    // the default should make the runner-ops credential succeed cleanly rather than
    // spuriously fail every "happy path" test's exit code.
    waitForAppInstallation: async (opts) => ({
      appId: opts.appId,
      installId: '222',
      appSlug: opts.expected.appSlug ?? '',
      accountLogin: 'groundnuty',
      repositorySelection: 'selected',
    }),
    confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
    openUrl: async () => {},
    log: () => {},
    // applyFleet ALWAYS overrides this field with its own real recovery-
    // artifact writer (see apply-fleet.ts's `buildAgentDepsWithRecovery`) —
    // present here only to satisfy `AgentApplyDeps`'s type.
    writeRecoveryArtifact: async () => {},
    ...overrides,
  };
}

/**
 * `controlRepoOptions.makeScratchDir` is pinned to `dirname(manifestPath)`
 * (macf#857) — this is what keeps every EXISTING `join(join(file, '..'), ...)`
 * path assertion in this file valid unchanged: the control-repo "checkout"
 * IS the same temp dir `writeManifest()` already created. `checkMeta` always
 * reports `'absent'` -> every run here takes the CREATE path (no real
 * `gh`/`git`).
 */
/** groundnuty/macf#920 gap 2 default fake — mint returns SENTINEL cert/key (distinct from every other sentinel so a leak test can tell this surface apart), every repo reports 'absent' so a publish is attempted (not silently skipped for want of a dep). */
function fakeRoutingClientDeps(overrides: Partial<RoutingClientApplyDeps> = {}): RoutingClientApplyDeps {
  return {
    mint: async () => ({ certPem: 'SENTINEL-ROUTING-CLIENT-CERT-PEM', keyPem: 'SENTINEL-ROUTING-CLIENT-KEY-PEM' }),
    checkRepoSecretPresence: async () => 'absent',
    setRepoSecret: async () => {},
    ...overrides,
  };
}

function fakeMutateDeps(manifestPath: string, overrides: Partial<MutateApplyDeps> = {}): MutateApplyDeps {
  return {
    buildAgentDeps: () => fakeAgentDeps(),
    repoInitDeps: {
      cloneRepo: async () => {},
      commitAndPush: async () => 'pushed',
      repoInit: async () => ({ workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } }),
    },
    vaultDeps: { exists: () => false, encrypt: async () => {} },
    controlRepoDeps: {
      checkMeta: async () => ({ presence: 'absent' }),
      readManifestFile: async () => undefined,
      createRepo: async () => {},
      unarchiveRepo: async () => {
        throw new Error('must not be called — this default control repo is always absent, never ours-archived');
      },
      cloneRepo: async () => {},
      commitAndPush: async () => 'pushed',
    },
    agentRepoDeps: { checkExists: async () => 'absent', createRepo: async () => {} },
    trustDeps: fakeTrustDeps(),
    routingClientDeps: fakeRoutingClientDeps(),
    controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
    now: () => new Date('2026-08-11T00:00:00.000Z'),
    log: () => {},
    confirmPlan: async () => true,
    readPriorLock: () => null,
    runnerToken: SENTINEL_RUNNER_TOKEN,
    ...overrides,
  };
}

describe('runBootstrapApply — mutating apply (increment 5a)', () => {
  const dirs: string[] = [];
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errs.push(a.join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // macf#932 — belt-and-suspenders for tests that stub RUNNER_TOKEN_ENV_VAR
    // via vi.stubEnv; a no-op for every other test in this block.
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeManifest(body = FLEET_YAML): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-apply-mutate-test-'));
    dirs.push(dir);
    const p = join(dir, 'fleet.yaml');
    writeFileSync(p, body);
    return p;
  }

  it('operator DECLINES the plan-approval prompt -> exit 1, aborted, nothing mutates (no fleet.lock/vault file)', async () => {
    const file = writeManifest();
    let confirmPlanCalled = false;
    const code = await runBootstrapApply(
      { file },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, { confirmPlan: async () => { confirmPlanCalled = true; return false; } }),
    );
    expect(code).toBe(1);
    expect(confirmPlanCalled).toBe(true);
    expect(errs.join('\n')).toMatch(/Aborted by operator/);
    expect(existsSync(join(join(file, '..'), 'fleet.lock'))).toBe(false);
    expect(existsSync(join(join(file, '..'), 'secrets', 'vault.age'))).toBe(false);
  });

  it('--yes bypasses the interactive prompt entirely (confirmPlan never called)', async () => {
    const file = writeManifest();
    let confirmPlanCalled = false;
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, { confirmPlan: async () => { confirmPlanCalled = true; return true; } }),
    );
    expect(code).toBe(0);
    expect(confirmPlanCalled).toBe(false);
  });

  it('happy path: approves, creates both agents, writes a real fleet.lock + vault.age next to the manifest', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/code-agent: CREATED/);
    expect(out).toMatch(/science-agent: CREATED/);
    // groundnuty/macf#943 — the runner-ops App ALSO creates cleanly on
    // this fleet's first apply (the shared `fakeAgentDeps` fixture's
    // `repositorySelection: 'selected'` satisfies its own gate-2 check).
    expect(out).toMatch(/Runner-ops App:\s*\n\s*runner-ops: CREATED/);
    expect(out).toMatch(/Vault: written to/);
    // DR-043 Amendment D phase 2 (macf#838) — the CA ceremony ran too: a
    // fresh mint (no prior lock, no prior registry var — the default
    // `fakeTrustDeps()`) publishes to the registry + BOTH agent repos.
    expect(out).toMatch(/CA: MINTED/);
    expect(out).toMatch(/registry leg: CREATED/);

    const dir = join(file, '..');
    expect(existsSync(join(dir, 'fleet.lock'))).toBe(true);
    const lock = parseFleetLock(readFileSync(join(dir, 'fleet.lock'), 'utf-8'));
    expect(lock.agents.map((a) => a.role).sort()).toEqual(['code-agent', 'runner-ops', 'science-agent']);
    // The CA key's fingerprint lands in fleet.lock's FLEET-level
    // `fingerprints.ca_key` — the SOLE place it is ever written (see
    // apply-fleet.ts's module doc) — never the raw key value.
    expect(lock.fingerprints?.['ca_key']).toBeDefined();
    expect(JSON.stringify(lock)).not.toContain(SENTINEL_CA_KEY_PEM);
  });

  it('--json emits the FLEET_APPLY_JSON_SCHEMA_VERSION envelope on a successful apply', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as { schema_version: number; agents: unknown[]; vault: { status: string } };
    expect(parsed.schema_version).toBe(FLEET_APPLY_JSON_SCHEMA_VERSION);
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.vault.status).toBe('written');
  });

  it('control repo FOREIGN end-to-end (unreadable fleet.yaml): exit 1, NO agent App/repo/install is ever touched, no fleet.lock/vault.age written', async () => {
    const file = writeManifest();
    let agentDepsBuilt = false;
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, {
        buildAgentDeps: () => {
          agentDepsBuilt = true;
          return fakeAgentDeps();
        },
        controlRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: false }),
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
      }),
    );
    expect(code).toBe(1);
    expect(agentDepsBuilt).toBe(false);
    const out = logs.join('\n');
    expect(out).toMatch(/⚠ ABORTED/);
    expect(out).toMatch(/could not be read/);
    expect(existsSync(join(join(file, '..'), 'fleet.lock'))).toBe(false);
    expect(existsSync(join(join(file, '..'), 'secrets', 'vault.age'))).toBe(false);
  });

  // --- DR-043 Amendment G (macf#867) — the archived/foreign split end-to-end ---

  it('control repo ARCHIVED but a DIFFERENT fleet\'s fleet.yaml -> still FOREIGN (the case the pre-Amendment-G rule protects, preserved)', async () => {
    const file = writeManifest();
    const otherFleetYaml = FLEET_YAML.replace('name: demo-fleet', 'name: some-other-fleet');
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, {
        controlRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: true }),
          readManifestFile: async () => otherFleetYaml,
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
      }),
    );
    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/⚠ ABORTED/);
  });

  it('control repo ARCHIVED + confirmUnarchive NOT set on the mutate deps -> exit 1, "archived" status, NO unarchiveRepo/clone/commit', async () => {
    const file = writeManifest();
    let unarchiveCalled = false;
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, {
        // controlRepoOptions deliberately OMITTED — confirmUnarchive defaults to unset/false.
        controlRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: true }),
          readManifestFile: async () => FLEET_YAML,
          createRepo: async () => {
            throw new Error('must not be called');
          },
          unarchiveRepo: async () => {
            unarchiveCalled = true;
          },
          cloneRepo: async () => {
            throw new Error('must not be called');
          },
          commitAndPush: async () => {
            throw new Error('must not be called');
          },
        },
      }),
    );
    expect(code).toBe(1);
    expect(unarchiveCalled).toBe(false);
    expect(logs.join('\n')).toMatch(/⚠ ABORTED/);
  });

  it('control repo ARCHIVED + confirmUnarchive: true -> unarchiveRepo IS called, run proceeds (REVIVED)', async () => {
    const file = writeManifest();
    let unarchiveCalled = false;
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, {
        // Keep the same manifestPath-relative scratch dir the default uses
        // (avoids leaking a real `mkdtemp` dir) — only `confirmUnarchive` differs.
        controlRepoOptions: { confirmUnarchive: true, makeScratchDir: () => join(file, '..') },
        controlRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: true }),
          readManifestFile: async () => FLEET_YAML,
          createRepo: async () => {
            throw new Error('must not be called — ours-archived never creates');
          },
          unarchiveRepo: async () => {
            unarchiveCalled = true;
          },
          cloneRepo: async () => {},
          commitAndPush: async () => 'nothing-to-commit',
        },
      }),
    );
    expect(unarchiveCalled).toBe(true);
    expect(logs.join('\n')).toMatch(/REVIVED/);
    expect(code).toBe(0);
  });

  it('a per-agent gate failure still exits the run non-zero (via applyExitCode), even though applyFleet itself completed', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, { buildAgentDeps: () => fakeAgentDeps({ exchangeManifestCode: async () => { throw new Error('one-shot code already redeemed'); } }) }),
    );
    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/FAILED/);
  });

  it('NEVER logs a secret value anywhere in stdout/stderr across a full run (text AND --json) — agent creds AND the CA key (macf#838 Amendment D phase 2)', async () => {
    for (const json of [false, true]) {
      const file = writeManifest();
      await runBootstrapApply({ file, yes: true, json }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
    }
    const all = [...logs, ...errs].join('\n');
    expect(all).not.toContain('SENTINEL-CLIENT-SECRET');
    expect(all).not.toContain('SENTINEL-WEBHOOK-SECRET');
    expect(all).not.toContain('SENTINEL-PEM-VALUE');
    expect(all).not.toContain(SENTINEL_CA_KEY_PEM);
    // The CA CERT is PUBLIC material (published to the registry + repos) —
    // this only pins that the redacted `resolve.certFingerprint` (a SHA-256
    // hex digest) shows up instead of the raw PEM text.
    expect(all).not.toContain(SENTINEL_CA_CERT_PEM);
  });

  it('macf#929: the --runner-token value NEVER appears in captured stdout/stderr across a full run (text AND --json), even though it gates + is consumed by a real routing.runner: self-hosted write', async () => {
    const RUNNER_TOKEN_SECRET = 'ghr-SENTINEL-929-CLI-TOKEN-MUST-NEVER-LEAK';
    for (const json of [false, true]) {
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        // macf#932 — opts.runnerToken must ALSO be set: the pre-flight reads
        // the resolved opts/env value, not mutateDeps.runnerToken directly
        // (see SENTINEL_RUNNER_TOKEN's doc above).
        { file, yes: true, json, runnerToken: RUNNER_TOKEN_SECRET },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) }, // no drift here -> routing takes the create path, exercising the write
        fakeMutateDeps(file, { runnerToken: RUNNER_TOKEN_SECRET }),
      );
      expect(code).toBe(0);
    }
    const all = [...logs, ...errs].join('\n');
    expect(all).not.toContain(RUNNER_TOKEN_SECRET);
    // The FLAG/ENV-VAR NAMES are fine to appear (they're what a refusal
    // names) — only the token VALUE must never leak. Belt-and-suspenders:
    // this run's runner IS confirmed usable (fakeTrustDeps' default), so it
    // never even hits the refusal/poll-exhausted text paths — this test
    // pins the WRITE path specifically.
    expect(all).toMatch(/Routing \(MACF_TRUSTED_ACTORS\):/);
  });

  // --- macf#932 — the pre-flight fires BEFORE consent gate 1, not merely
  // before the late gate deep inside applyFleet's routing block. The
  // decisive case: zero gate invocations, not merely a non-zero exit code.

  describe('macf#932 — pre-flight refusal before consent gate 1', () => {
    it('declared routing.runner self-hosted + NO token resolvable -> refuses BEFORE consent gate 1: observe/confirmPlan/buildAgentDeps/openUrl/startManifestFlow/confirmAppInstallation are ALL zero calls', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, ''); // pin: this test's verdict must not depend on the ambient shell env
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      let observeCalls = 0;
      let confirmPlanCalls = 0;
      let buildAgentDepsCalls = 0;
      let openUrlCalls = 0;
      let startManifestFlowCalls = 0;
      let confirmAppInstallationCalls = 0;

      const code = await runBootstrapApply(
        { file, yes: true }, // no opts.runnerToken
        {
          observe: () => {
            observeCalls += 1;
            return Promise.resolve(EMPTY_OBSERVED);
          },
        },
        fakeMutateDeps(file, {
          runnerToken: undefined,
          confirmPlan: async () => {
            confirmPlanCalls += 1;
            return true;
          },
          buildAgentDeps: () => {
            buildAgentDepsCalls += 1;
            return fakeAgentDeps({
              openUrl: async () => {
                openUrlCalls += 1;
              },
              startManifestFlow: async () => {
                startManifestFlowCalls += 1;
                throw new Error('must not be called — the pre-flight must refuse before this seam is ever reached');
              },
              confirmAppInstallation: async () => {
                confirmAppInstallationCalls += 1;
                return { status: 'unconfirmable' };
              },
            });
          },
        }),
      );

      expect(code).toBe(1);
      // The whole point: NOT "exited non-zero" but "never even asked the
      // operator to approve, never even read GitHub state, never opened a
      // browser." Each of these is a DISTINCT seam any one of which firing
      // would mean the refusal arrived too late.
      expect(observeCalls).toBe(0);
      expect(confirmPlanCalls).toBe(0);
      expect(buildAgentDepsCalls).toBe(0);
      expect(openUrlCalls).toBe(0);
      expect(startManifestFlowCalls).toBe(0);
      expect(confirmAppInstallationCalls).toBe(0);

      expect(errs.join('\n')).toContain(RUNNER_TOKEN_FLAG);
      expect(errs.join('\n')).toContain(RUNNER_TOKEN_ENV_VAR);
      // Nothing mutated — same result-invariant the "operator declines"
      // test above asserts.
      const dir = join(file, '..');
      expect(existsSync(join(dir, 'fleet.lock'))).toBe(false);
      expect(existsSync(join(dir, 'secrets', 'vault.age'))).toBe(false);
    });

    it('the refusal is visible under --json too, never empty stdout (macf#830 lesson), and the token flag/env-var names appear but no token VALUE ever could (there is none — this fires precisely because it is absent)', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply({ file, yes: true, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file, { runnerToken: undefined }));
      expect(code).toBe(1);
      expect(logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logs.join('\n')) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe('runner_token_missing');
      expect(parsed.error.message).toContain(RUNNER_TOKEN_FLAG);
      expect(parsed.error.message).toContain(RUNNER_TOKEN_ENV_VAR);
    });

    it('an empty-string --runner-token is treated the same as no token — still refuses before gate 1', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, yes: true, runnerToken: '' },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, { runnerToken: undefined }),
      );
      expect(code).toBe(1);
      expect(errs.join('\n')).toContain(RUNNER_TOKEN_FLAG);
    });

    it('a token supplied via --runner-token proceeds as today — the pre-flight is not a NEW obstacle for the already-satisfied case', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, yes: true, runnerToken: SENTINEL_RUNNER_TOKEN },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file),
      );
      expect(code).toBe(0);
      expect(errs.join('\n')).not.toContain(RUNNER_TOKEN_FLAG);
      expect(logs.join('\n')).toMatch(/Routing \(MACF_TRUSTED_ACTORS\):/);
    });

    it('a token resolvable ONLY via MACF_BOOTSTRAP_RUNNER_TOKEN (no --runner-token flag) also satisfies the pre-flight — the env-var fallback half is exercised, not just the flag half', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, 'ghr-env-resolved-token');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, yes: true }, // no opts.runnerToken — only the env var
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file), // default runnerToken (SENTINEL) drives the actual write path
      );
      expect(code).toBe(0);
      expect(errs.join('\n')).not.toContain('runner registration token was supplied');
      expect(errs.join('\n')).not.toContain(RUNNER_TOKEN_FLAG);
      expect(logs.join('\n')).toMatch(/Routing \(MACF_TRUSTED_ACTORS\):/);
    });

    it('no routing.runner declared at all -> unaffected: proceeds with no token and no refusal (unchanged behavior)', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(); // FLEET_YAML — no routing: section
      const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file, { runnerToken: undefined }));
      expect(code).toBe(0);
      expect(errs.join('\n')).not.toContain(RUNNER_TOKEN_FLAG);
    });

    it('--dry-run is UNAFFECTED even with no token resolvable — a dry run never opens a gate to begin with, and its own plan render already carries the requirement note (plan.ts::runnerClassReason, macf#932 requirement 3)', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply({ file, dryRun: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) });
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toMatch(/DRY RUN — nothing was created/);
      // The plan's own routing item already names the requirement — see
      // plan.test.ts's dedicated coverage for this note's unconditional
      // presence; this test only pins that --dry-run does not ALSO refuse.
      expect(out).toContain(RUNNER_TOKEN_FLAG);
    });
  });

  // --- macf#854: apply must not overstate what it did — the final summary
  // must name the plan items it never attempted (CA / routing / repo-create),
  // and it must do so EVEN UNDER --yes, since --yes skips the pre-approval
  // render entirely (the final summary is the ONLY output an automated run sees).

  it('final summary (--yes, non-json) lists the ONE remaining apply-unimplemented item — a diverging routing value (macf#838 Amendment D phase 2) — the plan-approve-once artifact is skipped under --yes, so this is the only place it surfaces', async () => {
    const file = writeManifest(FLEET_YAML_WITH_ROUTING);
    // macf#932 — opts.runnerToken required so the pre-flight doesn't refuse
    // before this test's routing-drift/unimplemented-block assertions ever
    // get a plan to inspect (see SENTINEL_RUNNER_TOKEN's doc above).
    const code = await runBootstrapApply(
      { file, yes: true, runnerToken: SENTINEL_RUNNER_TOKEN },
      { observe: () => Promise.resolve(OBSERVED_ROUTING_DRIFT) },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/NOT IMPLEMENTED BY APPLY/);
    // CA is fully implemented now (macf#838 Amendment D phase 2) — it must
    // NOT appear here; ONLY the routing update (diverging value, create-only
    // posture never overwrites) does.
    expect(out).not.toMatch(/\bca:/);
    expect(out).toMatch(/\brouting:.*\(update\)/);
  });

  it('final summary (--yes, non-json) shows NO unimplemented block on a fresh fleet with no routing declared — CA is fully implemented (macf#838 Amendment D phase 2)', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toMatch(/NOT IMPLEMENTED BY APPLY/);
  });

  it('final summary (--yes, non-json) ALSO renders the Control repo: status line (macf#857)', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/^Control repo: CREATED "groundnuty\/demo-fleet-control"/m);
    expect(out).toMatch(/Control repo sync: pushed\./);
  });

  it('final summary (--yes, --json) carries unimplemented_by_apply with ONLY the diverging routing item (macf#838 Amendment D phase 2) — ca and repo are NOT among them', async () => {
    const file = writeManifest(FLEET_YAML_WITH_ROUTING);
    // macf#932 — see SENTINEL_RUNNER_TOKEN's doc above.
    const code = await runBootstrapApply(
      { file, yes: true, json: true, runnerToken: SENTINEL_RUNNER_TOKEN },
      { observe: () => Promise.resolve(OBSERVED_ROUTING_DRIFT) },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      unimplemented_by_apply: ReadonlyArray<{ kind: string; target: string; verb: string; reason: string }>;
      control_repo: { status: string };
      control_repo_sync: { status: string };
    };
    expect(parsed.unimplemented_by_apply.length).toBe(1);
    expect(parsed.unimplemented_by_apply[0]?.kind).toBe('routing');
    expect(parsed.unimplemented_by_apply[0]?.verb).toBe('update');
    // ca is fully implemented now (macf#838 Amendment D phase 2); repo has
    // been since macf#857 — neither appears here.
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'ca')).toBe(false);
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'repo')).toBe(false);
    expect(parsed.control_repo.status).toBe('created');
    expect(parsed.control_repo_sync.status).toBe('pushed');
    for (const item of parsed.unimplemented_by_apply) {
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });

  // --- DR-043 §D6 (this change) — versions steering. Same "the --yes
  // summary is the ONLY place an automated run sees the gap" contract the
  // routing tests above establish, now for a macf CLI version drift.

  it('final summary (--yes, non-json) surfaces a macf version drift as NOT IMPLEMENTED BY APPLY (DR-043 §D6)', async () => {
    const file = writeManifest(FLEET_YAML_WITH_VERSIONS);
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(OBSERVED_VERSION_DRIFT) },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/NOT IMPLEMENTED BY APPLY/);
    expect(out).toMatch(/\bversion:.*\(update\)/);
    // The fixture's `actionsPin` already matches the declared "v3.4.1" —
    // only the `version` kind should surface here, never `actions_pin`.
    expect(out).not.toMatch(/\bactions_pin:/);
  });

  it('final summary (--yes, --json) carries the version-drift items with the `macf fleet upgrade` remedy named in each reason', async () => {
    const file = writeManifest(FLEET_YAML_WITH_VERSIONS);
    const code = await runBootstrapApply(
      { file, yes: true, json: true },
      { observe: () => Promise.resolve(OBSERVED_VERSION_DRIFT) },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      unimplemented_by_apply: ReadonlyArray<{ kind: string; target: string; verb: string; reason: string }>;
    };
    const versionItems = parsed.unimplemented_by_apply.filter((i) => i.kind === 'version');
    // One per agent (code-agent + science-agent), both diverging (0.2.44 observed vs "0.2.60" declared).
    expect(versionItems).toHaveLength(2);
    for (const item of versionItems) {
      expect(item.verb).toBe('update');
      expect(item.reason).toMatch(/macf fleet upgrade/);
    }
    // actions_pin must NOT appear — the fixture's observed pin already matches declared.
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'actions_pin')).toBe(false);
  });

  it('pre-approval stderr render (interactive path, confirmPlan declines) ALSO shows the NOT IMPLEMENTED block before the abort', async () => {
    // The DR-035 §4 plan-approve-once artifact goes straight to
    // `process.stderr.write` (not `console.error`) so a human running
    // without --json sees the SAME text a script skips past — spy on the
    // raw stream to see it. Uses the routing-drift fixture (macf#838
    // Amendment D phase 2 — ca alone no longer produces an unimplemented
    // item on a fresh fleet).
    const rawWrites: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        rawWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      });
    try {
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      // macf#932 — see SENTINEL_RUNNER_TOKEN's doc above: without this the
      // macf#932 pre-flight refuses BEFORE the plan is ever rendered, which
      // would defeat this test's whole point.
      const code = await runBootstrapApply(
        { file, runnerToken: SENTINEL_RUNNER_TOKEN },
        { observe: () => Promise.resolve(OBSERVED_ROUTING_DRIFT) },
        fakeMutateDeps(file, { confirmPlan: async () => false }),
      );
      expect(code).toBe(1);
      // The plan-approve-once artifact is written to stderr BEFORE the
      // prompt — the operator must see this before typing "yes", not just after.
      expect(rawWrites.join('')).toMatch(/NOT IMPLEMENTED BY APPLY/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  // --- Vault-aware confirm-before-create (DR-043 Amendment A, macf#913) ---
  //
  // Through DR-043 Amendment D phase 3, `apply` had NO `--vault`/
  // `--identity-key` flags at all (only `plan` did), so `plan.ts`'s own
  // "a vault-aware confirm runs during apply" text was simply false. These
  // tests exercise apply's own flags, the shared XOR refusal, the
  // honest-unknown degrade on a failed decrypt, and — the load-bearing
  // behavior — that a role WITH a prior fleet.lock entry AND a confirmable
  // vault PEM is REUSED, never re-created, with consent gate 1 (the
  // `startManifestFlow` seam) asserted NEVER CALLED, not merely absent from
  // the outcome.

  /** A raw vault map carrying a decodable PEM for each of the given roles — built via the REAL write/parse round-trip (never hand-derived key names), same convention as `vault-read.test.ts`. */
  function vaultRawWithAgentPems(roles: readonly string[], pem = SENTINEL_VAULT_PEM): Readonly<Record<string, string>> {
    const agents: VaultAgentSecrets[] = roles.map((role) => ({
      appHandle: `demo-fleet-${role}`,
      appId: '111',
      installId: '222',
      clientId: 'Iv1.abc',
      clientSecret: 'not-under-test',
      webhookSecret: 'not-under-test',
      pem,
    }));
    return parseVaultPlaintext(buildVaultPlaintext({ agents }));
  }

  it('--vault WITHOUT --identity-key: refused loud (vault_flags_incomplete), never silently vault-free', async () => {
    const code = await runBootstrapApply({ file: '/does/not/matter.yaml', json: true, vaultPath: '/fake/vault.age' });
    expect(code).toBe(1);
    const json = JSON.parse(logs.join('\n')) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('vault_flags_incomplete');
    expect(json.error.message).toContain('--identity-key');
  });

  it('--identity-key WITHOUT --vault: refused loud (vault_flags_incomplete), never silently vault-free', async () => {
    const code = await runBootstrapApply({ file: '/does/not/matter.yaml', json: true, identityKeyPath: '/fake/key.txt' });
    expect(code).toBe(1);
    const json = JSON.parse(logs.join('\n')) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('vault_flags_incomplete');
    expect(json.error.message).toContain('--vault');
  });

  it('the half-specified-flags refusal fires BEFORE the manifest-file check — an argument error, not a manifest error', async () => {
    const code = await runBootstrapApply({ file: '/does/not/exist/fleet.yaml', json: true, vaultPath: '/fake/vault.age' });
    expect(code).toBe(1);
    const json = JSON.parse(logs.join('\n')) as { error: { code: string } };
    expect(json.error.code).toBe('vault_flags_incomplete'); // NOT manifest_not_found
  });

  it('with identity + genuinely absent App (no prior fleet.lock entry, no vault PEM either) -> creates as today, gate 1 IS opened', async () => {
    const file = writeManifest();
    let startManifestFlowCalled = false;
    const code = await runBootstrapApply(
      { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), readVault: async () => ({}) },
      fakeMutateDeps(file, {
        buildAgentDeps: () =>
          fakeAgentDeps({
            startManifestFlow: async () => {
              startManifestFlowCalled = true;
              return { startUrl: 'http://127.0.0.1:9/', redirectUrl: 'http://127.0.0.1:9/callback', waitForCode: async () => 'the-code', close: async () => {} };
            },
          }),
      }),
    );
    expect(code).toBe(0);
    expect(startManifestFlowCalled).toBe(true);
    const out = logs.join('\n');
    expect(out).toMatch(/code-agent: CREATED/);
    expect(out).toMatch(/science-agent: CREATED/);
  });

  it('with identity + an existing App recorded in the control-repo checkout -> CONFIRMED, REUSED, gate 1 seam is NEVER called (not merely unused)', async () => {
    const file = writeManifest();
    const priorLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
        // groundnuty/macf#943 — the runner-ops ALSO has a prior lock
        // entry here so "gate 1 seam is NEVER called" holds for it too; a
        // runner-ops credential genuinely ABSENT from a prior lock legitimately takes
        // the CREATE path (see the dedicated "genuinely absent" test above),
        // which is not what THIS test is about.
        { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-3' },
      ],
    };
    let startManifestFlowCalled = false;
    const code = await runBootstrapApply(
      { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
      {
        observe: () => Promise.resolve(EMPTY_OBSERVED),
        readVault: async () => vaultRawWithAgentPems(['code-agent', 'science-agent']),
      },
      fakeMutateDeps(file, {
        buildAgentDeps: () =>
          fakeAgentDeps({
            // Mirrors resolveMutateDeps's OWN resolveKeyPath shape (pinned
            // directly, unit-level, in the 'resolveMutateDeps' describe
            // block below) — proves the OVERALL behavior once such wiring
            // is present, without a real GitHub App / age binary. Also
            // covers the runner-ops (groundnuty/macf#943) — this raw
            // override answers for ANY role, unlike the real
            // `resolveMutateDeps`'s vault-derived one (which only ever
            // resolves a PEM for a DECLARED agent — see that function's doc).
            resolveKeyPath: (role) => `/fake/${role}.pem`,
            confirmAppInstallation: async (appId) => ({
              status: 'confirmed',
              install: {
                appId,
                installId: appId === 'app-code-agent' ? 'install-1' : appId === 'app-science-agent' ? 'install-2' : 'install-3',
                appSlug: '',
                accountLogin: 'groundnuty',
              },
            }),
            startManifestFlow: async () => {
              startManifestFlowCalled = true;
              throw new Error('must not be called — a CONFIRMED App must skip consent gate 1 entirely (macf#913)');
            },
          }),
        // 'ours' (present, not archived, fleet.yaml name-matches) — a
        // REALISTIC steady-state re-run against an already-provisioned
        // fleet, not the archived case (that's the dedicated revival test
        // below).
        controlRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: false }),
          readManifestFile: async () => FLEET_YAML,
          createRepo: async () => {
            throw new Error('must not be called — reuse never creates');
          },
          unarchiveRepo: async () => {
            throw new Error('must not be called');
          },
          // The real clone brings back whatever the control repo already has
          // committed — simulate that the SAME way apply-fleet.test.ts's own
          // self-heal test does (writing fleet.lock into destDir).
          cloneRepo: async (_url, destDir) => {
            writeFileSync(join(destDir, 'fleet.lock'), JSON.stringify(priorLock), 'utf-8');
          },
          commitAndPush: async () => 'nothing-to-commit',
        },
      }),
    );
    expect(code).toBe(0);
    expect(startManifestFlowCalled).toBe(false); // the gate seam was never even invoked
    const out = logs.join('\n');
    expect(out).toMatch(/Control repo: REUSED/);
    expect(out).toMatch(/code-agent: REUSED/);
    expect(out).toMatch(/science-agent: REUSED/);
    expect(out).not.toMatch(/code-agent: CREATED/);
  });

  it('decrypt failure (bad --identity-key) -> honest-unknown, falls back to the vault-free guard, NEVER a secret in any message', async () => {
    const file = writeManifest();
    // The diagnostic goes to process.stderr.write (same channel
    // resolveMutateDeps's `log` field uses for progress narration), not
    // console.error — spy on the raw stream, same pattern the existing
    // "pre-approval stderr render" test above already uses.
    const rawWrites: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      rawWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    let code: number;
    try {
      code = await runBootstrapApply(
        { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/wrong-identity.txt' },
        {
          observe: () => Promise.resolve(EMPTY_OBSERVED),
          readVault: async () => {
            throw new VaultError('vault_decrypt_failed', 'age -d exited 1 decrypting "/fake/vault.age" — wrong identity key, or a corrupted file.');
          },
        },
        fakeMutateDeps(file),
      );
    } finally {
      writeSpy.mockRestore();
    }
    expect(code).toBe(0); // degrades to the vault-free default; does NOT fail the run
    const stderrOut = rawWrites.join('');
    expect(stderrOut).toMatch(/Vault-aware confirm UNAVAILABLE/);
    expect(stderrOut).toMatch(/wrong identity key/);
    const out = [stderrOut, ...logs, ...errs].join('\n');
    expect(out).not.toContain('-----BEGIN');
    expect(out).not.toContain(SENTINEL_VAULT_PEM);
    // Falls all the way back to today's behaviour — both agents still CREATED.
    expect(logs.join('\n')).toMatch(/code-agent: CREATED/);
  });

  it('--dry-run reports which path it would take: a vault-confirmed role is REUSED (excluded from "would be created"), an unconfirmable one stays a create-candidate', async () => {
    const file = writeManifest();
    const observedWithLock: ObservedState = {
      lock: { schema_version: 1, fleet: 'demo-fleet', agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }] },
      agents: {},
      caRegistry: 'absent',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const code = await runBootstrapApply(
      { file, dryRun: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
      {
        observe: () => Promise.resolve(observedWithLock),
        readVault: async () => vaultRawWithAgentPems(['code-agent']),
        confirmAppInstallation: async (appId) => ({
          status: 'confirmed',
          install: { appId, installId: 'install-1', appSlug: '', accountLogin: 'groundnuty' },
        }),
      },
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    // The operator learns the outcome BEFORE spending a click:
    expect(out).toMatch(/code-agent: REUSE/);
    expect(out).not.toMatch(/demo-fleet-code-agent\s+\(role: code-agent/); // dropped from "would be created"
    // science-agent has no prior lock entry -> still a genuine create-candidate:
    expect(out).toMatch(/demo-fleet-science-agent\s+\(role: science-agent/);
    expect(out).toMatch(/DRY RUN — nothing was created/);
  });

  // --- DR-043 Amendment G (macf#867) + macf#913 — the combined revival case ---
  // this issue names explicitly: "archive state -> apply with identity ->
  // zero gate opens."

  it('archived-fleet revival WITH identity: unarchiveRepo IS called, REVIVED, both roles REUSED, gate 1 seam NEVER called', async () => {
    const file = writeManifest();
    const priorLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
        // groundnuty/macf#943 — see the identical comment on the sibling
        // "existing App recorded" test above: gate 1 must never open for the
        // runner-ops either when it too has a prior lock entry.
        { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-3' },
      ],
    };
    let unarchiveCalled = false;
    let startManifestFlowCalled = false;
    const code = await runBootstrapApply(
      { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
      {
        observe: () => Promise.resolve(EMPTY_OBSERVED),
        readVault: async () => vaultRawWithAgentPems(['code-agent', 'science-agent']),
      },
      fakeMutateDeps(file, {
        buildAgentDeps: () =>
          fakeAgentDeps({
            resolveKeyPath: (role) => `/fake/${role}.pem`,
            confirmAppInstallation: async (appId) => ({
              status: 'confirmed',
              install: {
                appId,
                installId: appId === 'app-code-agent' ? 'install-1' : appId === 'app-science-agent' ? 'install-2' : 'install-3',
                appSlug: '',
                accountLogin: 'groundnuty',
              },
            }),
            startManifestFlow: async () => {
              startManifestFlowCalled = true;
              throw new Error('must not be called — the archived-then-revived fleet\'s Apps are already confirmed live (macf#913)');
            },
          }),
        controlRepoOptions: { confirmUnarchive: true, makeScratchDir: () => join(file, '..') },
        controlRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: true }),
          readManifestFile: async () => FLEET_YAML,
          createRepo: async () => {
            throw new Error('must not be called — ours-archived never creates');
          },
          unarchiveRepo: async () => {
            unarchiveCalled = true;
          },
          cloneRepo: async (_url, destDir) => {
            writeFileSync(join(destDir, 'fleet.lock'), JSON.stringify(priorLock), 'utf-8');
          },
          commitAndPush: async () => 'pushed',
        },
      }),
    );
    expect(code).toBe(0);
    expect(unarchiveCalled).toBe(true);
    expect(startManifestFlowCalled).toBe(false); // zero gate opens
    const out = logs.join('\n');
    expect(out).toMatch(/REVIVED/);
    expect(out).toMatch(/code-agent: REUSED/);
    expect(out).toMatch(/science-agent: REUSED/);
  });
});

// --- resolveMutateDeps — the vault-aware resolveKeyPath wiring itself (macf#913) ---
//
// Unit-level, no gh/git — resolveKeyPath and cleanupVaultScratch only ever
// touch the local filesystem. Pins the WIRING (opts.vaultPath/identityKeyPath
// -> resolveVaultAgentPems -> resolveMutateDeps(path, pems) -> this exact
// resolveKeyPath shape) that the behavioral tests above simulate rather than
// exercise directly (they use fakeMutateDeps for everything else, per this
// suite's established no-real-gh/git convention).

describe('resolveMutateDeps — vault-aware resolveKeyPath + cleanupVaultScratch (macf#913)', () => {
  it('omits resolveKeyPath entirely when no vault map is supplied — byte-identical to pre-macf#913 wiring', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml');
    expect(deps.buildAgentDeps(() => {}).resolveKeyPath).toBeUndefined();
  });

  it('resolveKeyPath returns undefined for a role NOT present in the map', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map());
    expect(deps.buildAgentDeps(() => {}).resolveKeyPath?.('code-agent', 'app-1')).toBeUndefined();
  });

  it('resolveKeyPath writes the PEM to a 0600 scratch file and returns its path; cleanupVaultScratch removes it', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map([['code-agent', SENTINEL_VAULT_PEM]]));
    const path = deps.buildAgentDeps(() => {}).resolveKeyPath?.('code-agent', 'app-1');
    expect(path).toBeDefined();
    expect(readFileSync(path as string, 'utf-8')).toBe(SENTINEL_VAULT_PEM);
    deps.cleanupVaultScratch?.();
    expect(existsSync(path as string)).toBe(false);
  });

  it('resolveKeyPath returns undefined for a DIFFERENT role even when the map is non-empty for another role', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map([['code-agent', SENTINEL_VAULT_PEM]]));
    expect(deps.buildAgentDeps(() => {}).resolveKeyPath?.('science-agent', 'app-2')).toBeUndefined();
  });

  it('cleanupVaultScratch is a safe no-op when resolveKeyPath was configured but never actually invoked', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map([['code-agent', SENTINEL_VAULT_PEM]]));
    expect(() => deps.cleanupVaultScratch?.()).not.toThrow();
  });

  // --- identityKeyPath threading (DR-043 §D5 recipient reconciliation, macf#957) ---

  it('identityKeyPath is undefined on FleetApplyDeps when not supplied — byte-identical to pre-macf#957 wiring', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN);
    expect(deps.identityKeyPath).toBeUndefined();
  });

  it('identityKeyPath is threaded verbatim onto FleetApplyDeps when supplied — the SAME path opts.identityKeyPath already decrypted vaultAgentPems with', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN, '/fake/operator-key.txt');
    expect(deps.identityKeyPath).toBe('/fake/operator-key.txt');
  });

  it('vaultRecipientDeps is left unset — apply-fleet.ts::reconcileVaultRecipients takes the real vault-read.ts defaults', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN, '/fake/operator-key.txt');
    expect(deps.vaultRecipientDeps).toBeUndefined();
  });
});

// --- Pure result-rendering helpers ---

function resultWith(overrides: Partial<FleetApplyResult> = {}): FleetApplyResult {
  return {
    controlRepo: { status: 'created', repo: 'groundnuty/demo-fleet-control', localDir: '/x' },
    controlRepoSync: { status: 'pushed' },
    lockPath: '/x/fleet.lock',
    finalLock: null,
    agents: [],
    // groundnuty/macf#943 — a NEUTRAL default ('reused', not
    // failed/drift/skipped-unverified) so every PRE-EXISTING `applyExitCode`
    // test in this file that doesn't override it keeps expecting the SAME
    // exit code it did before this field existed. Individual tests below
    // override to exercise the runner-ops's own failure/skip shapes.
    runnerOps: { role: 'runner-ops', status: 'reused', appId: '900', installId: '901' },
    vault: { status: 'skipped' },
    identityChanges: [],
    // DR-043 Amendment D phase 2 (macf#838) defaults: a REUSED CA (no fresh
    // key this run, nothing to fail on) + no routing declared. Individual
    // tests below override to exercise failure/skip shapes.
    ca: { resolve: { status: 'reused', certFingerprint: 'deadbeef'.repeat(8) }, registryLeg: { status: 'already-present' }, repoLegs: {} },
    routing: {},
    // groundnuty/macf#920 gap 2 default: mint SKIPPED (steady-state re-run —
    // matches `ca`'s own REUSED default above), no repos to publish to.
    // Individual tests below override to exercise minted/failed-leg shapes.
    routingClient: { mint: { status: 'skipped', reason: 'no CA minted this run' }, certLegs: {}, keyLegs: {} },
    ...overrides,
  };
}

describe('formatApplyResult / fleetApplyResultToJson / applyExitCode (pure)', () => {
  it('applyExitCode: 0 when every agent is created/reused/resumed-install and vault didn\'t fail', () => {
    const result = resultWith({
      agents: [
        { role: 'a', identity: { role: 'a', status: 'created', appId: '1', installId: '2', credentials: SENTINEL_CREDS } },
        { role: 'b', identity: { role: 'b', status: 'reused', appId: '3', installId: '4' } },
      ],
      vault: { status: 'written', path: '/x/secrets/vault.age', versioned: false },
    });
    expect(applyExitCode(result)).toBe(0);
  });

  it('applyExitCode: 1 when any agent is failed/drift/skipped-unverified', () => {
    expect(applyExitCode(resultWith({ agents: [{ role: 'a', identity: { role: 'a', status: 'failed', reason: 'x' } }] }))).toBe(1);
    expect(applyExitCode(resultWith({ agents: [{ role: 'a', identity: { role: 'a', status: 'skipped-unverified', appId: '1', reason: 'x' } }] }))).toBe(1);
    expect(
      applyExitCode(resultWith({ agents: [{ role: 'a', identity: { role: 'a', status: 'drift', reason: 'x', installs: [] } }] })),
    ).toBe(1);
  });

  it('applyExitCode: 1 when repo-init failed even though identity succeeded', () => {
    const result = resultWith({
      agents: [{ role: 'a', identity: { role: 'a', status: 'reused', appId: '1', installId: '2' }, repoInit: { repo: 'x/y', role: 'a', status: 'failed', reason: 'push rejected' } }],
    });
    expect(applyExitCode(result)).toBe(1);
  });

  it('applyExitCode: 1 when the vault write failed', () => {
    expect(applyExitCode(resultWith({ vault: { status: 'failed', reason: 'no age_recipients' } }))).toBe(1);
  });

  // --- macf#857: control-repo abort states must fail the run too — an
  // aborted step 0 is not "nothing happened cleanly," it's an operator-
  // attention state (same shape #854/#861 already established for
  // unimplementedByApply: a gap must never read as exit-0 success).

  it('applyExitCode: 1 when the control repo is foreign', () => {
    expect(applyExitCode(resultWith({ controlRepo: { status: 'foreign', repo: 'x/y-control', reason: 'archived' } }))).toBe(1);
  });

  it('applyExitCode: 1 when the control repo could not be provisioned (failed)', () => {
    expect(applyExitCode(resultWith({ controlRepo: { status: 'failed', repo: 'x/y-control', reason: 'network down' } }))).toBe(1);
  });

  it('applyExitCode: 1 when the FINAL control-repo sync failed, even though every agent + the vault succeeded', () => {
    expect(applyExitCode(resultWith({ controlRepoSync: { status: 'failed', reason: 'push rejected' } }))).toBe(1);
  });

  it('applyExitCode: 0 when control repo is reused + sync is nothing-to-commit (steady-state re-run)', () => {
    expect(
      applyExitCode(
        resultWith({
          controlRepo: { status: 'reused', repo: 'x/y-control', localDir: '/x' },
          controlRepoSync: { status: 'nothing-to-commit' },
        }),
      ),
    ).toBe(0);
  });

  // --- DR-043 Amendment D phase 2 (macf#838) — CA + routing exit-code / render / JSON ---

  it('applyExitCode: 1 when the CA resolve failed', () => {
    const result = resultWith({ ca: { resolve: { status: 'failed', reason: 'no recipient' }, registryLeg: { status: 'skipped', reason: 'x' }, repoLegs: {} } });
    expect(applyExitCode(result)).toBe(1);
  });

  it('applyExitCode: 1 when the CA registry leg failed', () => {
    const result = resultWith({ ca: { resolve: { status: 'minted', certFingerprint: 'ab'.repeat(32) }, registryLeg: { status: 'failed', reason: 'race' }, repoLegs: {} } });
    expect(applyExitCode(result)).toBe(1);
  });

  it('applyExitCode: 1 when ANY CA repo leg failed', () => {
    const result = resultWith({
      ca: {
        resolve: { status: 'reused', certFingerprint: 'ab'.repeat(32) },
        registryLeg: { status: 'already-present' },
        repoLegs: { 'x/y': { status: 'failed', reason: 'network' } },
      },
    });
    expect(applyExitCode(result)).toBe(1);
  });

  it('applyExitCode: 0 when CA legs are all skipped due to an already-accounted-for vault failure (skipped is not independently bad)', () => {
    const result = resultWith({
      vault: { status: 'skipped' },
      ca: {
        resolve: { status: 'reused', certFingerprint: 'ab'.repeat(32) },
        registryLeg: { status: 'skipped', reason: 'unrelated' },
        repoLegs: { 'x/y': { status: 'skipped', reason: 'unrelated' } },
      },
    });
    expect(applyExitCode(result)).toBe(0);
  });

  it('applyExitCode: 1 when a routing leg failed', () => {
    expect(applyExitCode(resultWith({ routing: { 'x/y': { status: 'failed', reason: 'boom' } } }))).toBe(1);
  });

  it('applyExitCode: 0 when routing legs are created/already-present', () => {
    expect(
      applyExitCode(resultWith({ routing: { 'x/y': { status: 'created' }, 'x/z': { status: 'already-present' } } })),
    ).toBe(0);
  });

  it('formatApplyResult NEVER includes a CA cert or key value — only status + fingerprint', () => {
    const result = resultWith({
      ca: {
        resolve: { status: 'minted', certFingerprint: 'ab'.repeat(32) },
        registryLeg: { status: 'created' },
        repoLegs: { 'groundnuty/x': { status: 'created' } },
      },
    });
    const text = formatApplyResult(result);
    expect(text).toMatch(/CA: MINTED \(fingerprint (?:ab){32}\)/);
    expect(text).toMatch(/registry leg: CREATED/);
    expect(text).toMatch(/repo leg \(groundnuty\/x\): CREATED/);
    expect(text).not.toContain('-----BEGIN');
  });

  it('formatApplyResult renders a CA resolve failure loudly', () => {
    const text = formatApplyResult(resultWith({ ca: { resolve: { status: 'failed', reason: 'no age recipient' }, registryLeg: { status: 'skipped', reason: 'no cert resolved' }, repoLegs: {} } }));
    expect(text).toMatch(/CA: FAILED to resolve — no age recipient/);
    expect(text).toMatch(/registry leg: SKIPPED — no cert resolved/);
  });

  it('formatApplyResult renders routing lines only when routing is non-empty', () => {
    expect(formatApplyResult(resultWith({ routing: {} }))).not.toMatch(/Routing \(MACF_TRUSTED_ACTORS\)/);
    const text = formatApplyResult(resultWith({ routing: { 'groundnuty/x': { status: 'created' }, 'groundnuty/y': { status: 'already-present' } } }));
    expect(text).toMatch(/Routing \(MACF_TRUSTED_ACTORS\):/);
    expect(text).toMatch(/groundnuty\/x: CREATED/);
    expect(text).toMatch(/groundnuty\/y: ALREADY-PRESENT/);
  });

  it('formatApplyResult renders a SKIPPED routing leg with its reason (macf#922 requirement 3 — the no-runner-registered gap is visible even under --yes)', () => {
    const text = formatApplyResult(
      resultWith({
        routing: { 'groundnuty/x': { status: 'skipped', reason: 'no self-hosted runner is confirmed registered for "groundnuty/x"' } },
      }),
    );
    expect(text).toMatch(/groundnuty\/x: SKIPPED — no self-hosted runner is confirmed registered/);
  });

  it('fleetApplyResultToJson never includes a CA cert/key value and carries ca + routing verbatim otherwise', () => {
    const result = resultWith({
      ca: {
        resolve: { status: 'minted', certFingerprint: 'cd'.repeat(32) },
        registryLeg: { status: 'created' },
        repoLegs: { 'groundnuty/x': { status: 'created' } },
      },
      routing: { 'groundnuty/x': { status: 'created' } },
    });
    const json = JSON.parse(JSON.stringify(fleetApplyResultToJson(result))) as {
      ca: { resolve: { status: string; cert_fingerprint?: string; certFingerprint?: string }; registry_leg: { status: string }; repo_legs: Record<string, { status: string }> };
      routing: Record<string, { status: string }>;
    };
    expect(json.ca.resolve.status).toBe('minted');
    expect(json.ca.registry_leg.status).toBe('created');
    expect(json.ca.repo_legs['groundnuty/x']?.status).toBe('created');
    expect(json.routing['groundnuty/x']?.status).toBe('created');
    const raw = JSON.stringify(json);
    expect(raw).not.toContain('-----BEGIN');
  });

  it('formatApplyResult never includes a credential value', () => {
    const result = resultWith({
      agents: [{ role: 'a', identity: { role: 'a', status: 'created', appId: '1', installId: '2', credentials: SENTINEL_CREDS } }],
      vault: { status: 'written', path: '/x/secrets/vault.age', versioned: false },
    });
    const text = formatApplyResult(result);
    expect(text).not.toContain('SENTINEL-CLIENT-SECRET');
    expect(text).not.toContain('SENTINEL-WEBHOOK-SECRET');
    expect(text).not.toContain('SENTINEL-PEM-VALUE');
    expect(text).toContain('a: CREATED');
  });

  it('formatApplyResult surfaces identityChanges loudly', () => {
    const result = resultWith({ identityChanges: [{ role: 'a', field: 'app_id', previous: 'OLD', next: 'NEW' }] });
    expect(formatApplyResult(result)).toMatch(/DRIFT detected/);
    expect(formatApplyResult(result)).toContain('OLD → NEW');
  });

  // --- macf#857: the Control repo: line is ALWAYS the first thing rendered
  // — a foreign/failed abort must be visible in the SAME final-result render
  // a normal run's summary is, not just distinguishable by exit code (the
  // same false-consent shape #854/#861 already closed for unimplementedByApply,
  // applied here because --yes skips the pre-approval render entirely — see
  // this module's formatControlRepoLine doc).

  it('formatApplyResult renders "CREATED" for a fresh control repo', () => {
    const text = formatApplyResult(resultWith({ controlRepo: { status: 'created', repo: 'groundnuty/demo-fleet-control', localDir: '/tmp/x' } }));
    expect(text).toMatch(/^Control repo: CREATED "groundnuty\/demo-fleet-control"/m);
  });

  it('formatApplyResult renders "REUSED" for a steady-state re-run', () => {
    const text = formatApplyResult(resultWith({ controlRepo: { status: 'reused', repo: 'groundnuty/demo-fleet-control', localDir: '/tmp/x' } }));
    expect(text).toMatch(/^Control repo: REUSED "groundnuty\/demo-fleet-control"/m);
  });

  it('formatApplyResult renders a LOUD ⚠ ABORTED line for a foreign control repo — visible even under --yes, which skips the pre-approval render', () => {
    const text = formatApplyResult(resultWith({ controlRepo: { status: 'foreign', repo: 'groundnuty/demo-fleet-control', reason: 'archived' } }));
    expect(text).toMatch(/⚠ ABORTED.*groundnuty\/demo-fleet-control.*archived/);
  });

  it('formatApplyResult renders a LOUD ⚠ ABORTED line for a control repo that could not be provisioned', () => {
    const text = formatApplyResult(resultWith({ controlRepo: { status: 'failed', repo: 'groundnuty/demo-fleet-control', reason: 'network down' } }));
    expect(text).toMatch(/⚠ ABORTED.*network down/);
  });

  // --- DR-043 Amendment G (macf#867) — the revival outcomes ---

  it('formatApplyResult renders "REVIVED" for a control repo un-archived this run', () => {
    const text = formatApplyResult(resultWith({ controlRepo: { status: 'revived', repo: 'groundnuty/demo-fleet-control', localDir: '/tmp/x' } }));
    expect(text).toMatch(/^Control repo: REVIVED "groundnuty\/demo-fleet-control"/m);
  });

  it('formatApplyResult renders a LOUD ⚠ ABORTED line when revival was not confirmed', () => {
    const text = formatApplyResult(
      resultWith({ controlRepo: { status: 'archived', repo: 'groundnuty/demo-fleet-control', reason: 'revival was not confirmed' } }),
    );
    expect(text).toMatch(/⚠ ABORTED.*groundnuty\/demo-fleet-control.*revival was not confirmed/);
  });

  it('applyExitCode: 1 when the control repo is archived and revival was not confirmed', () => {
    expect(
      applyExitCode(resultWith({ controlRepo: { status: 'archived', repo: 'x/y-control', reason: 'revival was not confirmed' } })),
    ).toBe(1);
  });

  it('applyExitCode: 0 for a REVIVED control repo (with everything else clean) — revival itself is not a failure', () => {
    const result = resultWith({ controlRepo: { status: 'revived', repo: 'x/y-control', localDir: '/tmp/x' } });
    expect(applyExitCode(result)).toBe(0);
  });

  it('formatApplyResult renders the control-repo sync outcome, including a loud FAILED line', () => {
    expect(formatApplyResult(resultWith({ controlRepoSync: { status: 'pushed' } }))).toMatch(/Control repo sync: pushed\./);
    expect(formatApplyResult(resultWith({ controlRepoSync: { status: 'nothing-to-commit' } }))).toMatch(/Control repo sync: nothing to push/);
    expect(formatApplyResult(resultWith({ controlRepoSync: { status: 'failed', reason: 'push rejected' } }))).toMatch(/Control repo sync: ⚠ FAILED.*push rejected/);
  });

  it('fleetApplyResultToJson never includes a credential value + always carries schema_version', () => {
    const result = resultWith({
      agents: [{ role: 'a', identity: { role: 'a', status: 'created', appId: '1', installId: '2', credentials: SENTINEL_CREDS } }],
    });
    const json = JSON.stringify(fleetApplyResultToJson(result));
    expect(json).not.toContain('SENTINEL-CLIENT-SECRET');
    expect(json).not.toContain('SENTINEL-WEBHOOK-SECRET');
    expect(json).not.toContain('SENTINEL-PEM-VALUE');
    expect(JSON.parse(json).schema_version).toBe(FLEET_APPLY_JSON_SCHEMA_VERSION);
  });

  it('fleetApplyResultToJson carries control_repo + control_repo_sync verbatim (macf#857)', () => {
    const result = resultWith({
      controlRepo: { status: 'foreign', repo: 'groundnuty/demo-fleet-control', reason: 'archived' },
      controlRepoSync: { status: 'skipped' },
    });
    const json = JSON.parse(JSON.stringify(fleetApplyResultToJson(result))) as {
      control_repo: { status: string; reason: string };
      control_repo_sync: { status: string };
    };
    expect(json.control_repo).toEqual({ status: 'foreign', repo: 'groundnuty/demo-fleet-control', reason: 'archived' });
    expect(json.control_repo_sync).toEqual({ status: 'skipped' });
  });

  // --- macf#854: formatApplyResult / fleetApplyResultToJson's optional
  // second param. Defaults to [] so pre-existing call sites (above, and any
  // caller that doesn't thread the plan through) keep compiling AND keep
  // rendering byte-identically — no spurious warning when nothing is unimplemented.

  const UNIMPLEMENTED_FIXTURE: readonly UnimplementedApplyItem[] = [
    { kind: 'ca', target: 'ca:registry:DEMO_FLEET_CA_CERT', verb: 'create', reason: 'no CA orchestrator step exists yet' },
  ];

  it('formatApplyResult omits the unimplemented block when the param is omitted (default [])', () => {
    const result = resultWith({});
    expect(formatApplyResult(result)).not.toMatch(/NOT IMPLEMENTED/);
  });

  it('formatApplyResult omits the unimplemented block when passed an explicit empty array', () => {
    const result = resultWith({});
    expect(formatApplyResult(result, [])).not.toMatch(/NOT IMPLEMENTED/);
  });

  it('formatApplyResult renders the unimplemented block when items are passed, never a credential value', () => {
    const result = resultWith({
      agents: [{ role: 'a', identity: { role: 'a', status: 'created', appId: '1', installId: '2', credentials: SENTINEL_CREDS } }],
    });
    const text = formatApplyResult(result, UNIMPLEMENTED_FIXTURE);
    expect(text).toMatch(/NOT IMPLEMENTED BY APPLY/);
    expect(text).toContain('ca:registry:DEMO_FLEET_CA_CERT');
    expect(text).not.toContain('SENTINEL-PEM-VALUE');
  });

  it('fleetApplyResultToJson defaults unimplemented_by_apply to [] when the param is omitted', () => {
    const result = resultWith({});
    const json = JSON.parse(JSON.stringify(fleetApplyResultToJson(result))) as { unimplemented_by_apply: unknown[] };
    expect(json.unimplemented_by_apply).toEqual([]);
  });

  it('fleetApplyResultToJson carries the passed unimplemented items verbatim', () => {
    const result = resultWith({});
    const json = JSON.parse(JSON.stringify(fleetApplyResultToJson(result, UNIMPLEMENTED_FIXTURE))) as {
      unimplemented_by_apply: ReadonlyArray<{ kind: string; target: string }>;
    };
    expect(json.unimplemented_by_apply).toEqual([
      { kind: 'ca', target: 'ca:registry:DEMO_FLEET_CA_CERT', verb: 'create', reason: 'no CA orchestrator step exists yet' },
    ]);
  });
});
