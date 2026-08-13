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
 * `routing:`, plus an observed `routingRunsOn` that DIVERGES from it
 * (`update` verb). `ca` is fully implemented now (mint-or-reuse + two-place
 * publish); routing's `create` verb is too — the ONLY plan item that still
 * legitimately reads `unimplementedByApply` is a routing `update` (apply's
 * create-only posture never overwrites a present-but-diverging value — see
 * `plan.ts::planItemApplyCoverage`'s routing case). These two fixtures are
 * what exercises that one remaining honest gap.
 */
const FLEET_YAML_WITH_ROUTING = FLEET_YAML.replace(
  'agents:\n',
  'routing:\n  runner:\n    runs_on: self-hosted\nagents:\n',
);
const OBSERVED_ROUTING_DRIFT: ObservedState = { ...EMPTY_OBSERVED, routingRunsOn: 'github-hosted' };

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
    expect(parsed.planned_app_creations.map((c) => c.manifest.name)).toEqual([
      'demo-fleet-code-agent',
      'demo-fleet-science-agent',
    ]);
    expect(parsed.planned_app_creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
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
    expect(creations.map((c) => c.role)).toEqual(['code-agent', 'science-agent']);
    expect(creations[0]?.manifest.redirect_url).toBe(DRY_RUN_REDIRECT_PLACEHOLDER);
  });

  it('pairs each creation with its consent-gate-2 install URL, derived from the SAME handle as the manifest name', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
    ]);
    for (const c of creations) {
      expect(c.installUrl).toBe(`https://github.com/apps/${c.manifest.name}/installations/new`);
    }
  });

  it('EXCLUDES an agent whose App is already present (no re-create)', () => {
    const plan = computePlan(manifest, observedWithApp('code-agent'));
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.role)).toEqual(['science-agent']);
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

/** Default fake `CaApplyDeps` (macf#838 Amendment D phase 2) — everything absent, so a fresh mint + two-place publish succeeds by default; individual tests override to exercise other shapes. */
function fakeTrustDeps(overrides: Partial<CaApplyDeps> = {}): CaApplyDeps {
  return {
    checkRegistryPresence: async () => 'absent',
    readRegistryVariable: async () => undefined,
    createRegistryVariable: async () => 'created',
    checkRepoPresence: async () => 'absent',
    createRepoVariable: async () => 'created',
    mintCa: async () => ({ certPem: SENTINEL_CA_CERT_PEM, keyPem: SENTINEL_CA_KEY_PEM }),
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
    waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '222', appSlug: opts.expected.appSlug ?? '', accountLogin: 'groundnuty' }),
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
function fakeMutateDeps(manifestPath: string, overrides: Partial<MutateApplyDeps> = {}): MutateApplyDeps {
  return {
    buildAgentDeps: () => fakeAgentDeps(),
    repoInitDeps: { cloneRepo: async () => {}, commitAndPush: async () => 'pushed', repoInit: async () => {} },
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
    controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
    now: () => new Date('2026-08-11T00:00:00.000Z'),
    log: () => {},
    confirmPlan: async () => true,
    readPriorLock: () => null,
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
    expect(out).toMatch(/Vault: written to/);
    // DR-043 Amendment D phase 2 (macf#838) — the CA ceremony ran too: a
    // fresh mint (no prior lock, no prior registry var — the default
    // `fakeTrustDeps()`) publishes to the registry + BOTH agent repos.
    expect(out).toMatch(/CA: MINTED/);
    expect(out).toMatch(/registry leg: CREATED/);

    const dir = join(file, '..');
    expect(existsSync(join(dir, 'fleet.lock'))).toBe(true);
    const lock = parseFleetLock(readFileSync(join(dir, 'fleet.lock'), 'utf-8'));
    expect(lock.agents.map((a) => a.role).sort()).toEqual(['code-agent', 'science-agent']);
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

  // --- macf#854: apply must not overstate what it did — the final summary
  // must name the plan items it never attempted (CA / routing / repo-create),
  // and it must do so EVEN UNDER --yes, since --yes skips the pre-approval
  // render entirely (the final summary is the ONLY output an automated run sees).

  it('final summary (--yes, non-json) lists the ONE remaining apply-unimplemented item — a diverging routing value (macf#838 Amendment D phase 2) — the plan-approve-once artifact is skipped under --yes, so this is the only place it surfaces', async () => {
    const file = writeManifest(FLEET_YAML_WITH_ROUTING);
    const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(OBSERVED_ROUTING_DRIFT) }, fakeMutateDeps(file));
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
    const code = await runBootstrapApply({ file, yes: true, json: true }, { observe: () => Promise.resolve(OBSERVED_ROUTING_DRIFT) }, fakeMutateDeps(file));
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
      const code = await runBootstrapApply(
        { file },
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
});

// --- Pure result-rendering helpers ---

function resultWith(overrides: Partial<FleetApplyResult> = {}): FleetApplyResult {
  return {
    controlRepo: { status: 'created', repo: 'groundnuty/demo-fleet-control', localDir: '/x' },
    controlRepoSync: { status: 'pushed' },
    lockPath: '/x/fleet.lock',
    finalLock: null,
    agents: [],
    vault: { status: 'skipped' },
    identityChanges: [],
    // DR-043 Amendment D phase 2 (macf#838) defaults: a REUSED CA (no fresh
    // key this run, nothing to fail on) + no routing declared. Individual
    // tests below override to exercise failure/skip shapes.
    ca: { resolve: { status: 'reused', certFingerprint: 'deadbeef'.repeat(8) }, registryLeg: { status: 'already-present' }, repoLegs: {} },
    routing: {},
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
    expect(formatApplyResult(resultWith({ routing: {} }))).not.toMatch(/Routing \(MACF_ROUTING_RUNS_ON\)/);
    const text = formatApplyResult(resultWith({ routing: { 'groundnuty/x': { status: 'created' }, 'groundnuty/y': { status: 'already-present' } } }));
    expect(text).toMatch(/Routing \(MACF_ROUTING_RUNS_ON\):/);
    expect(text).toMatch(/groundnuty\/x: CREATED/);
    expect(text).toMatch(/groundnuty\/y: ALREADY-PRESENT/);
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
