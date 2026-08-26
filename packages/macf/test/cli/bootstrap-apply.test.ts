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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  runBootstrapApply,
  resolveMutateDeps,
  resolveTsOauthFlagOrEnv,
  resolveVaultAgentPems,
  plannedAppCreations,
  formatPlannedAppCreations,
  formatAppCreationsHeader,
  recoveryResumableRoles,
  formatApplyResult,
  fleetApplyResultToJson,
  applyExitCode,
  findAvailableRecoveryArtifacts,
  formatRecoveryArtifactNotice,
  DRY_RUN_REDIRECT_PLACEHOLDER,
  FLEET_APPLY_JSON_SCHEMA_VERSION,
  type MutateApplyDeps,
  type DeployPhaseRenderInput,
} from '../../src/cli/commands/bootstrap-apply.js';
import type { DeployPhaseAgentResult } from '../../src/cli/bootstrap/apply-deploy.js';
import { writeAgentConfig } from '../../src/cli/config.js';
import { parseFleetManifest } from '../../src/cli/bootstrap/fleet-manifest.js';
import { parseFleetLock } from '../../src/cli/bootstrap/fleet-manifest.js';
import { computePlan } from '../../src/cli/bootstrap/plan.js';
import type { ObservedState, UnimplementedApplyItem } from '../../src/cli/bootstrap/plan.js';
import type { FleetApplyResult } from '../../src/cli/bootstrap/apply-fleet.js';
import { applyAgentIdentity } from '../../src/cli/bootstrap/apply-agent.js';
import type { AgentApplyDeps } from '../../src/cli/bootstrap/apply-agent.js';
import { registryRepoNotInstalledReason, registryRepoRetryInstruction } from '../../src/cli/bootstrap/registry-repo-coverage.js';
import type { AppCredentials } from '../../src/cli/bootstrap/manifest-exchange.js';
import type { ConfirmedInstall, IdentityConfirmation } from '../../src/cli/bootstrap/identity-confirm.js';
import type { CaApplyDeps } from '../../src/cli/bootstrap/apply-ca.js';
import type { RoutingClientApplyDeps } from '../../src/cli/bootstrap/apply-routing-client.js';
import type { RoutingSecretsPublishDeps } from '../../src/cli/bootstrap/apply-routing-secrets.js';
import { MISSING_OPERATOR_INPUTS_CODE } from '../../src/cli/bootstrap/operator-secrets-file.js';
import {
  TAILSCALE_OAUTH_MISSING_CODE,
  TS_OAUTH_CLIENT_ID_ENV_VAR,
  TS_OAUTH_CLIENT_ID_FLAG,
  TS_OAUTH_CLIENT_ID_SECRET_NAME,
  TS_OAUTH_FLAGS_INCOMPLETE_CODE,
  TS_OAUTH_SECRET_ENV_VAR,
  TS_OAUTH_SECRET_FLAG,
  TS_OAUTH_SECRET_SECRET_NAME,
} from '../../src/cli/bootstrap/apply-routing-secrets.js';
import type { RunnerRegistrationDeps } from '../../src/cli/bootstrap/apply-routing.js';
import { RUNNER_TOKEN_ENV_VAR, RUNNER_TOKEN_FLAG } from '../../src/cli/bootstrap/apply-routing.js';
import { RUNNER_OPS_ROLE, deriveRunnerOpsHandle } from '../../src/cli/bootstrap/apply-runner-ops.js';
import {
  VaultError,
  buildVaultPlaintext,
  operatorRecoveryArtifactPath,
  type VaultAgentSecrets,
  type VaultRunnerOpsSecrets,
} from '../../src/cli/bootstrap/vault-write.js';
import { parseVaultPlaintext, vaultRouterAppId, vaultRouterAppKeyPem } from '../../src/cli/bootstrap/vault-read.js';
import { ROUTER_APP_ROLE } from '../../src/cli/bootstrap/apply-router-app.js';
import { REGISTRY_SCOPE_UNSATISFIABLE_CODE } from '../../src/cli/bootstrap/registry-scope-preflight.js';
import { upgradeFleets } from '@groundnuty/macf-core';
import type { ApplyVersionPhaseDeps, ApplyVersionPhaseResult } from '../../src/cli/bootstrap/apply-version.js';

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

/**
 * groundnuty/macf#999 — same fixture as {@link FLEET_YAML}, `owner.type` +
 * `owner.registry` swapped to the org shape. Used ONLY by the registry-scope
 * pre-flight describe block below; every other test in this file keeps
 * using the `type: profile` {@link FLEET_YAML} default, which is the point
 * (#999 requirement: profile-scope fleets stay completely unaffected).
 */
const FLEET_YAML_WITH_ORG_REGISTRY = FLEET_YAML.replace('type: user', 'type: org').replace(
  'registry: { type: profile, user: groundnuty }',
  'registry: { type: org, org: demo-org }',
);

/**
 * groundnuty/macf#1156 — same fixture as {@link FLEET_YAML}, `owner.type` +
 * `owner.registry` swapped to the repo-scoped shape (`#999`'s supported
 * org-owned-fleet shape; mirrors {@link FLEET_YAML_WITH_ORG_REGISTRY}'s own
 * pattern for `type: org`). Used ONLY by the `--dry-run`-preview test in the
 * `plannedAppCreations` describe block below — every other test in this
 * file keeps the `type: profile` {@link FLEET_YAML} default.
 */
const FLEET_YAML_WITH_REPO_REGISTRY = FLEET_YAML.replace('type: user', 'type: org').replace(
  'registry: { type: profile, user: groundnuty }',
  'registry: { type: repo, owner: demo-org, repo: demo-org-control }',
);

/** groundnuty/macf#1074 — same fixture as {@link FLEET_YAML}, `transport.tailscale_oauth_required: true` declared. Used ONLY by the Tailscale-preflight describe block below. */
const FLEET_YAML_WITH_TAILSCALE = FLEET_YAML.replace(
  'age_recipients: [age1qtestrecipientxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]',
  'age_recipients: [age1qtestrecipientxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]\n  tailscale_oauth_required: true',
);

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
 * verb is too — the routing `update` (apply's create-only posture never
 * overwrites a present-but-diverging value — see
 * `plan.ts::planItemApplyCoverage`'s routing case) is the ONE legitimately
 * un-actioned item this fixture originally exercised. **Since
 * groundnuty/macf#942** (DR-043 Amendment I), declaring `routing.runner` ALSO
 * always emits a `runner_warm` item — the `warm` field it defaults to (1) —
 * but that kind is fully IMPLEMENTED as of groundnuty/macf#943 (apply calls
 * the runner-provisioning contract), so it never surfaces under
 * `unimplemented_by_apply`; the routing `update` remains the ONE gap this
 * fixture exercises — see the `--yes` summary tests below.
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

/**
 * groundnuty/macf#1054 — declares BOTH `routing.runner` AND `versions:`, so a
 * single run exercises the runner-gate (inside `applyFleet`) AND the
 * version-reconcile phase (AFTER `applyFleet` returns, in
 * `runBootstrapApply`) together. Used ONLY by the "runner-gate failure does
 * not block the version phase" regression test below — every other fixture
 * in this file keeps `routing:`/`versions:` separate on purpose.
 */
const FLEET_YAML_WITH_ROUTING_AND_VERSIONS = FLEET_YAML.replace(
  'agents:\n',
  'routing:\n  runner:\n    runs_on: self-hosted\nversions:\n  macf: "0.2.60"\n  actions: v3.4.1\nagents:\n',
);
const OBSERVED_ROUTING_AND_VERSION_DRIFT: ObservedState = { ...OBSERVED_VERSION_DRIFT, routingTrustedActors: 'github-hosted' };

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
    // groundnuty/macf#1083 — `FLEET_YAML` declares no self-hosted routing,
    // so the runner-ops App is NOT NEEDED and is absent from the planned
    // creation set entirely (never appended, unlike the pre-#1083
    // unconditional shape — see the dedicated `plannedAppCreations` describe
    // block above, whose manifest DOES declare self-hosted routing, for the
    // "runner-ops IS appended last" case). groundnuty/macf#1105 — the router
    // App IS always a create-candidate (UNCONDITIONAL, no `fleet.lock` entry
    // here) and is appended LAST, after runner-ops when present.
    expect(parsed.planned_app_creations.map((c) => c.manifest.name)).toEqual([
      'demo-fleet-code-agent',
      'demo-fleet-science-agent',
      'groundnuty-router',
    ]);
    expect(parsed.planned_app_creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
      'https://github.com/apps/groundnuty-router/installations/new',
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
  // groundnuty/macf#1083 — self-hosted DECLARED (`FLEET_YAML_WITH_ROUTING`,
  // not the bare `FLEET_YAML`) so the runner-ops App stays a create-candidate
  // in every test below — this describe block's whole point is exercising
  // ITS OWN preview/install-repos machinery, which only fires when the App
  // is actually needed. See the dedicated #1083 describe block further down
  // for the conditional-creation (hosted-fleet) behavior itself.
  const manifest = parseFleetManifest(FLEET_YAML_WITH_ROUTING);

  it('includes an agent whose app item is create', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    // groundnuty/macf#943 — the runner-ops is ALWAYS a create-candidate
    // on a fresh fleet (no `fleet.lock` entry yet). groundnuty/macf#1105 —
    // the router App is UNCONDITIONAL and appended LAST, after runner-ops.
    expect(creations.map((c) => c.role)).toEqual(['code-agent', 'science-agent', 'runner-ops', 'router']);
    expect(creations[0]?.manifest.redirect_url).toBe(DRY_RUN_REDIRECT_PLACEHOLDER);
  });

  it('pairs each creation with its consent-gate-2 install URL, derived from the SAME handle as the manifest name', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
      'https://github.com/apps/demo-fleet-runner-ops/installations/new',
      'https://github.com/apps/groundnuty-router/installations/new',
    ]);
    for (const c of creations) {
      expect(c.installUrl).toBe(`https://github.com/apps/${c.manifest.name}/installations/new`);
    }
  });

  // groundnuty/macf#952 — the dry-run preview names the LITERAL repos each
  // App would need selected, using the SAME derivation the live gate-2
  // interstitial uses (`apply-agent.ts::installReposForIdentity`).
  it('installRepos: each agent gets just its own repo; the runner-ops gets every declared agent repo', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    const byRole = Object.fromEntries(creations.map((c) => [c.role, c.installRepos]));
    expect(byRole['code-agent']).toEqual(['groundnuty/demo-code']);
    expect(byRole['science-agent']).toEqual(['groundnuty/demo-science']);
    expect(byRole['runner-ops']).toEqual(['groundnuty/demo-code', 'groundnuty/demo-science']);
  });

  it('formatPlannedAppCreations names the LITERAL runner-ops repos, never the phrase "this fleet\'s repos" (groundnuty/macf#952)', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    const out = formatPlannedAppCreations(creations);
    expect(out).toContain('select exactly: groundnuty/demo-code, groundnuty/demo-science');
    expect(out).not.toMatch(/this fleet's repos/);
    expect(out).toMatch(/Only select repositories/);
  });

  // groundnuty/macf#1128 — before this issue, the "⚠ choose Only select
  // repositories" warning above was shown ONLY for runner-ops/the router
  // App (the only two identities `apply` actually refused an "all"-scoped
  // install for). Ordinary agent Apps now get the SAME post-gate-2 refusal
  // (`install-scope.ts`), so the dry-run preview — which exists precisely
  // to tell the operator what to click BEFORE they get it wrong — must
  // warn them for every planned creation, not a subset.
  it('formatPlannedAppCreations shows the "Only select repositories" warning for an ORDINARY agent App too, naming its own single repo', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    const codeAgentIndex = creations.findIndex((c) => c.role === 'code-agent');
    expect(codeAgentIndex).toBeGreaterThanOrEqual(0);
    const out = formatPlannedAppCreations(creations);
    const lines = out.split('\n');
    // Find the "code-agent" bullet line, then assert the block up to (but
    // not including) the next bullet names its own repo. A block-join
    // (groundnuty/macf#1173) rather than a single-line `.find` — the
    // warning is now TWO lines (`gate2RepoSelectionInstructionLines`,
    // verbatim from the live gate — see that function's own doc), not one.
    const bulletIndex = lines.findIndex((l) => l.includes('role: code-agent'));
    expect(bulletIndex).toBeGreaterThanOrEqual(0);
    // Exactly this agent's own block (bullet + permissions + events +
    // public/webhook + gate-2 URL + the 2-line warning = 7 lines) — sized
    // to stop BEFORE the next bullet, so a false pass/fail can't come from
    // bleeding into the next agent's block.
    const block = lines.slice(bulletIndex, bulletIndex + 7).join('\n');
    expect(block).toMatch(/Only select repositories/);
    expect(block).toContain('select exactly: groundnuty/demo-code');
    expect(block).not.toContain('demo-science'); // NOT the other agent's repo
  });

  it('EXCLUDES an agent whose App is already present (no re-create)', () => {
    const plan = computePlan(manifest, observedWithApp('code-agent'));
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    // groundnuty/macf#943 — the runner-ops has its OWN presence signal
    // (`fleet.lock`, not `observedWithApp`'s per-agent fixture), so it stays
    // a create-candidate here regardless of code-agent's presence.
    // groundnuty/macf#1105 — same for the router App (UNCONDITIONAL, its own
    // `fleet.lock`/vault presence signal, absent here too).
    expect(creations.map((c) => c.role)).toEqual(['science-agent', 'runner-ops', 'router']);
  });

  it('formats an empty creation set without claiming work', () => {
    expect(formatPlannedAppCreations([])).toMatch(/No GitHub Apps would be created/);
  });

  // groundnuty/macf#1156 — `--dry-run` must show the operator the SAME repo
  // list the live gate-2 interstitial will (issue requirement 3). Both this
  // preview's `installRepos` field AND the live interstitial's `repos` field
  // are `installReposForIdentity`'s return value — this test observes the
  // PREVIEW side of that shared derivation (the live-interstitial side is
  // covered by apply-fleet.test.ts's #1156 DECISIVE integration test), using
  // its OWN repo-scoped manifest so it doesn't disturb this describe block's
  // shared `manifest` const (`type: profile`, used by every other test
  // above).
  //
  // NOT covered here: the one-clause "why" (`installWhyText`'s new
  // `registryControlRepo` param). `formatPlannedAppCreations` never renders
  // `whyText` at all (pre-#1156, unchanged by this issue) — the reason
  // clause reaches only the LIVE gate-2 surfaces (the interstitial's
  // `<p class="why">` + the terminal `instructionLines`, both covered by
  // `apply-agent.test.ts`'s `installWhyText` tests), never the `--dry-run`
  // preview. This asymmetry is pre-existing (whyText was already preview-
  // absent) and out of `bootstrap-apply.ts`'s file-scope for this issue —
  // named here so the test title doesn't overclaim what it verifies.
  it('groundnuty/macf#1156: registry.type === "repo" -> the preview\'s installRepos for an ordinary agent ALSO includes the control repo; the formatted warning line names both', () => {
    const repoRegistryManifest = parseFleetManifest(FLEET_YAML_WITH_REPO_REGISTRY);
    const plan = computePlan(repoRegistryManifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(repoRegistryManifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);

    const codeAgent = creations.find((c) => c.role === 'code-agent');
    expect(codeAgent?.installRepos).toEqual(['groundnuty/demo-code', 'demo-org/demo-org-control']);
    const sciAgent = creations.find((c) => c.role === 'science-agent');
    expect(sciAgent?.installRepos).toEqual(['groundnuty/demo-science', 'demo-org/demo-org-control']);

    // The formatted preview text shows the SAME list for code-agent's own
    // warning block — never dropped, never a class description. Block-join
    // (groundnuty/macf#1173), not a single-line `.find` — see the sibling
    // test above for why.
    const out = formatPlannedAppCreations(creations);
    const lines = out.split('\n');
    const bulletIndex = lines.findIndex((l) => l.includes('role: code-agent'));
    expect(bulletIndex).toBeGreaterThanOrEqual(0);
    const block = lines.slice(bulletIndex, bulletIndex + 7).join('\n');
    expect(block).toContain('select exactly: groundnuty/demo-code, demo-org/demo-org-control');
  });

  it('groundnuty/macf#1156: registry.type === "profile" (this describe block\'s own default fixture) -> installRepos is UNCHANGED — agent repo only, never the control repo', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    const codeAgent = creations.find((c) => c.role === 'code-agent');
    expect(codeAgent?.installRepos).toEqual(['groundnuty/demo-code']);
  });
});

// --- groundnuty/macf#1165 — the preview must not contradict a resumed gate ---

describe('recoveryResumableRoles (pure) — groundnuty/macf#1165', () => {
  const manifest = parseFleetManifest(FLEET_YAML_WITH_ROUTING);
  const plan = computePlan(manifest, EMPTY_OBSERVED);
  const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER); // code-agent, science-agent, runner-ops, router

  it('returns [] when identityKeyPath is undefined, even when roles overlap — an artifact cannot be decrypted without --identity-key', () => {
    expect(recoveryResumableRoles(creations, ['code-agent'], undefined)).toEqual([]);
  });

  it('returns [] when no recovery artifacts are available at all', () => {
    expect(recoveryResumableRoles(creations, [], '/fake/identity.txt')).toEqual([]);
  });

  it('intersects the creations roles with availableRecoveryRoles when identityKeyPath IS supplied', () => {
    expect(recoveryResumableRoles(creations, ['code-agent', 'runner-ops'], '/fake/identity.txt')).toEqual(['code-agent', 'runner-ops']);
  });

  it('ignores an available-recovery role that is NOT among creations (e.g. an unrelated stale .age file)', () => {
    expect(recoveryResumableRoles(creations, ['science-agent', 'not-a-declared-role'], '/fake/identity.txt')).toEqual(['science-agent']);
  });
});

describe('formatAppCreationsHeader (pure) — groundnuty/macf#1165', () => {
  it("bound 'exact' -> plain count, never the ceiling framing (unreachable in practice — operatorInteractionBudget's own contract guarantees 'maximum' whenever count > 0 — but the header derives from the field rather than assuming it, so this stays independently correct)", () => {
    const out = formatAppCreationsHeader(2, 'exact', []);
    expect(out).toContain('GitHub Apps that would be created (2)');
    expect(out).not.toContain('Up to');
    expect(out).not.toContain('ceiling');
  });

  it("bound 'maximum' -> 'Up to N' + explicit ceiling framing naming the live gate as authoritative", () => {
    const out = formatAppCreationsHeader(3, 'maximum', []);
    expect(out).toContain('Up to 3 GitHub Apps may be created');
    expect(out).toContain('ceiling, not a promise');
    expect(out).toContain('live gate is authoritative');
  });

  it('names excluded recovery-resumable roles explicitly rather than silently dropping them from the count', () => {
    const out = formatAppCreationsHeader(1, 'maximum', ['code-agent', 'science-agent']);
    expect(out).toContain('Not counted here');
    expect(out).toContain('code-agent, science-agent');
    expect(out).toMatch(/recovery artifact/);
  });

  it('singular phrasing when count is 1', () => {
    expect(formatAppCreationsHeader(1, 'maximum', [])).toContain('Up to 1 GitHub App may be created');
  });
});

describe('formatPlannedAppCreations — excludedRecoveryRoles threading (groundnuty/macf#1165)', () => {
  const manifest = parseFleetManifest(FLEET_YAML_WITH_ROUTING);
  const plan = computePlan(manifest, EMPTY_OBSERVED);
  const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);

  it('names the excluded role in the header, and the role NOT passed in `creations` gets no bullet at all — while a REMAINING role\'s own "select exactly" bullet is untouched (groundnuty/macf#952/#1128/#1156 must survive)', () => {
    // Caller-side filtering, mirroring exactly what `runBootstrapApply` now
    // does: `creations` here is ALREADY the post-exclusion list (this
    // function never re-derives the exclusion itself — see its own doc).
    const filtered = creations.filter((c) => c.role !== 'code-agent');
    const out = formatPlannedAppCreations(filtered, 0, ['code-agent']);
    expect(out).toContain('Not counted here');
    expect(out).toContain('code-agent');
    expect(out).not.toMatch(/role: code-agent/);
    // science-agent is unaffected — the EXACT pre-existing bullet text.
    expect(out).toContain('select exactly: groundnuty/demo-science');
  });

  it('the zero-creations branch also names an excluded recovery-resumable role, rather than reading as "nothing to do at all"', () => {
    const out = formatPlannedAppCreations([], 0, ['code-agent']);
    expect(out).toMatch(/No GitHub Apps would be created/);
    expect(out).toContain('code-agent');
    expect(out).toMatch(/recovery artifact/);
  });

  it('excludedRecoveryRoles defaults to [] — every pre-#1165 2-arg call site stays byte-identical', () => {
    const out = formatPlannedAppCreations(creations, 0);
    expect(out).not.toContain('Not counted here');
  });
});

describe('DECISIVE — the preview never claims a repo the live gate does not (groundnuty/macf#1165)', () => {
  // groundnuty/macf#1156's own repo-registry fixture — code-agent's full
  // required set is its own repo PLUS the control repo, the exact two-repo
  // shape #1164's resumed-gate fix narrows down to a delta of one.
  const repoRegistryManifest = parseFleetManifest(FLEET_YAML_WITH_REPO_REGISTRY);
  const codeAgentFixture = repoRegistryManifest.agents.find((a) => a.role === 'code-agent')!;
  const CANDIDATE_REPOS = ['groundnuty/demo-code', 'demo-org/demo-org-control'];

  /**
   * Test-LOCAL probe — never calls `installReposForIdentity` or any other
   * production derivation to build the candidate set (assert-the-wrong-path.md
   * trigger 1: a test whose expectation is built by the SAME helper as the
   * code under test can never fail). `CANDIDATE_REPOS` is a plain literal
   * matching this describe block's own hand-typed fixture.
   */
  function reposNamedIn(text: string): string[] {
    return CANDIDATE_REPOS.filter((r) => text.includes(r));
  }

  const RECOVERED: AppCredentials = {
    appId: 'recovered-app-id',
    name: 'demo-org-code-agent',
    slug: 'demo-org-code-agent',
    clientId: 'Iv1.recovered',
    clientSecret: 'SENTINEL-RECOVERED-CLIENT-SECRET',
    webhookSecret: 'SENTINEL-RECOVERED-WEBHOOK-SECRET',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL-RECOVERED-PEM\n-----END RSA PRIVATE KEY-----\n',
  };
  const CONFIRMED_INSTALL: ConfirmedInstall = {
    appId: RECOVERED.appId,
    installId: '9999',
    appSlug: RECOVERED.slug,
    accountLogin: 'demo-org',
    repositorySelection: 'selected',
  };

  function baseDeps(overrides: Partial<AgentApplyDeps> = {}): AgentApplyDeps {
    return {
      startManifestFlow: async () => ({
        startUrl: 'http://127.0.0.1:9/',
        redirectUrl: 'http://127.0.0.1:9/callback',
        waitForCode: async () => 'the-code',
        close: async () => {},
      }),
      startInstallInterstitial: async () => ({ startUrl: 'http://127.0.0.1:9/interstitial', close: async () => {} }),
      exchangeManifestCode: async () => RECOVERED,
      waitForAppInstallation: async (opts) => ({
        appId: opts.appId,
        installId: '9999',
        appSlug: RECOVERED.slug,
        accountLogin: 'demo-org',
        repositorySelection: 'selected',
      }),
      confirmAppInstallation: async () => ({ status: 'unconfirmable' }) as IdentityConfirmation,
      openUrl: async () => {},
      log: () => {},
      writeRecoveryArtifact: async () => {},
      ...overrides,
    };
  }

  it('for a resumed agent (recovery artifact + confirmed-but-insufficient install): the preview never names a repo the gate does not', async () => {
    // Drive the REAL gate — the SAME production path groundnuty/macf#1164 fixed.
    const logs: string[] = [];
    const deps = baseDeps({
      log: (l) => logs.push(l),
      // groundnuty/macf#1178 — this fixture's validateInstall never
      // accepts, so the resumed gate's auto-poll (pollForInstallFix) runs
      // to its OWN timeout; keep the budget tiny so this test (which only
      // cares about what got LOGGED, not the final outcome) doesn't wait
      // out the real 10-minute default.
      gateTimeoutMs: 30,
      pollIntervalMs: 10,
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }) as IdentityConfirmation,
      findRecoveryArtifact: async () => RECOVERED,
      validateInstall: () => ({
        message: registryRepoNotInstalledReason('demo-org-code-agent', 'demo-org', 'demo-org-control'),
        retryInstruction: registryRepoRetryInstruction('demo-org-code-agent', 'demo-org', 'demo-org-control'),
      }),
    });
    await applyAgentIdentity(codeAgentFixture, repoRegistryManifest, undefined, deps);
    const gateRepos = reposNamedIn(logs.join('\n'));
    // Sanity: the fixture genuinely exercises #1164's resumed-delta path —
    // ONLY the missing repo, never the already-covered one.
    expect(gateRepos).toEqual(['demo-org/demo-org-control']);

    // Drive the FIXED preview for the SAME role, with THIS issue's own
    // exclusion applied (a recovery artifact is available for this role,
    // and --identity-key was supplied this run).
    const plan = computePlan(repoRegistryManifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(repoRegistryManifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    const excluded = recoveryResumableRoles(creations, ['code-agent'], '/fake/identity.txt');
    const previewCreations = creations.filter((c) => !excluded.includes(c.role));
    const previewText = formatPlannedAppCreations(previewCreations, 0, excluded);
    const previewRepos = reposNamedIn(previewText);

    // THE decisive assertion — compared against the gate's OWN real output,
    // never against a hand-typed literal on either side.
    expect(previewRepos.filter((r) => !gateRepos.includes(r))).toEqual([]);
  });

  it('pre-fix regression proof: the UNFILTERED preview (no exclusion applied) WOULD have claimed a repo the gate does not — this is the live incident', () => {
    const plan = computePlan(repoRegistryManifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(repoRegistryManifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    // The pre-#1165 call shape: no exclusion applied at all.
    const unfilteredRepos = reposNamedIn(formatPlannedAppCreations(creations));
    // The naive full-list preview claims BOTH repos for code-agent...
    expect(unfilteredRepos).toEqual(CANDIDATE_REPOS);
    // ...but the resumed gate (proven above, same fixture) only ever asks
    // for the control repo. The naive preview's claim on `demo-code` is
    // exactly the disagreement this issue reports.
    expect(unfilteredRepos).toContain('groundnuty/demo-code');
  });

  it('first-run case (nothing to resume): preview and gate name the SAME full set — both obtained by running real code, neither typed as a literal', async () => {
    const logs: string[] = [];
    // No findRecoveryArtifact, no prior confirm -> the ordinary fresh-create
    // path; `runGate2WithInterstitial`'s DEFAULT instructionLines uses the
    // SAME `installReposForIdentity`-derived `repos` the preview's own
    // `installRepos` field does (see `apply-agent.ts::applyIdentity`).
    const deps = baseDeps({ log: (l) => logs.push(l) });
    const outcome = await applyAgentIdentity(codeAgentFixture, repoRegistryManifest, undefined, deps);
    expect(outcome.status).toBe('created');
    const gateRepos = reposNamedIn(logs.join('\n'));

    const plan = computePlan(repoRegistryManifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(repoRegistryManifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    const previewRepos = reposNamedIn(formatPlannedAppCreations(creations));

    expect(gateRepos).toEqual(CANDIDATE_REPOS); // sanity: the fixture exercises the full two-repo set
    expect(previewRepos).toEqual(gateRepos);
  });
});

describe('runBootstrapApply --dry-run — recovery-resumable exclusion end-to-end (groundnuty/macf#1165)', () => {
  const dirs: string[] = [];
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeManifest(body = FLEET_YAML): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-apply-1165-test-'));
    dirs.push(dir);
    const p = join(dir, 'fleet.yaml');
    writeFileSync(p, body);
    return p;
  }

  function stubRecoveryArtifact(fleetName: string, role: string): void {
    const recoveryDir = mkdtempSync(join(tmpdir(), 'macf-apply-1165-recovery-'));
    dirs.push(recoveryDir);
    const artifactPath = operatorRecoveryArtifactPath(recoveryDir, fleetName, role);
    mkdirSync(join(artifactPath, '..'), { recursive: true });
    writeFileSync(artifactPath, 'SENTINEL-RECOVERY-ARTIFACT-BYTES');
    vi.stubEnv('MACF_RECOVERY_DIR', recoveryDir);
  }

  it('WITH --identity-key: a role with an available recovery artifact is excluded from "would be created", named in the header, and folded into the gate-2 budget', async () => {
    const file = writeManifest();
    stubRecoveryArtifact('demo-fleet', 'code-agent');
    const code = await runBootstrapApply(
      { file, dryRun: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), readVault: async () => ({}) },
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    // code-agent's own bullet is gone — the live incident's exact shape.
    expect(out).not.toMatch(/demo-fleet-code-agent\s+\(role: code-agent/);
    // science-agent, with no recovery artifact, remains a genuine create-candidate.
    expect(out).toMatch(/demo-fleet-science-agent\s+\(role: science-agent/);
    // Named, not silently vanished from the count.
    expect(out).toContain('Not counted here');
    expect(out).toContain('code-agent');
  });

  it('WITHOUT --identity-key: the SAME available artifact does NOT exclude the role — findRecoveryArtifact cannot decrypt it this run, so it genuinely still creates (honest-unknown floor cuts both ways)', async () => {
    const file = writeManifest();
    stubRecoveryArtifact('demo-fleet', 'code-agent');
    const code = await runBootstrapApply({ file, dryRun: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) });
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/demo-fleet-code-agent\s+\(role: code-agent/);
    expect(out).not.toContain('Not counted here');
    // The pre-existing, separate recovery-artifact notice still fires (macf#988) —
    // unaffected by this issue.
    expect(out).toMatch(/Durable recovery artifact\(s\) found for: code-agent/);
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
 * default already reports `checkRunnerUsableByRepo` as `'present'`, so a
 * write would succeed with or without this sentinel post-groundnuty/macf#1195
 * (a missing token no longer refuses outright — it now consults the SAME
 * live `checkRunnerUsableByRepo` read this default already satisfies; see
 * `apply-routing.ts`'s top-level #1195 paragraph). Kept as the default
 * anyway so every pre-existing "routing var gets written" fixture in this
 * file stays unambiguous about which code path it exercises (the
 * token-supplied poll path). Tests exercising the no-token branch itself
 * override this to `undefined` explicitly.
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
    // groundnuty/macf#952 — consent gate 2's own locally-served interstitial;
    // a fixed, gate-1-distinct URL so tests can tell the two gates' opened
    // URLs apart without depending on real ephemeral-port allocation.
    startInstallInterstitial: async () => ({ startUrl: 'http://127.0.0.1:19/', close: async () => {} }),
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
/** groundnuty/macf#920 gap 2 default fake — mint returns SENTINEL cert/key (distinct from every other sentinel so a leak test can tell this surface apart). */
function fakeRoutingClientDeps(overrides: Partial<RoutingClientApplyDeps> = {}): RoutingClientApplyDeps {
  return {
    mint: async () => ({ certPem: 'SENTINEL-ROUTING-CLIENT-CERT-PEM', keyPem: 'SENTINEL-ROUTING-CLIENT-KEY-PEM' }),
    ...overrides,
  };
}

/** groundnuty/macf#1074 — the unified six-secret publisher's deps default fake: every repo reports 'absent' so a publish is attempted (not silently skipped for want of a dep). */
function fakeRoutingSecretsDeps(
  overrides: Partial<RoutingSecretsPublishDeps & { readVaultTsOauth?: () => Promise<{ readonly clientId: string; readonly secret: string } | undefined> }> = {},
): RoutingSecretsPublishDeps & { readVaultTsOauth?: () => Promise<{ readonly clientId: string; readonly secret: string } | undefined> } {
  return {
    checkRepoSecretPresence: async () => 'absent',
    setRepoSecret: async () => {},
    ...overrides,
  };
}

/**
 * DR-043 Amendment L (macf#1045) — hermetic version-reconcile-phase deps.
 * `discover: () => []` + `resolveDriver: async () => null` mean the REAL
 * `upgradeFleets` (used unmocked here — delegation, not a fake sequencer)
 * gracefully reports `fleet-skipped` (driver-unresolved) and returns
 * `{halted:false}` — deterministic, no real host filesystem / VM-driver I/O.
 * `fetchLatest` THROWS if called — `FLEET_YAML_WITH_VERSIONS` always
 * declares `versions.macf`, so Amendment L3's manifest-authoritative branch
 * must never reach it (`assert-the-wrong-path.md`).
 */
function fakeVersionDeps(overrides: Partial<ApplyVersionPhaseDeps> = {}): ApplyVersionPhaseDeps {
  return {
    discover: () => [],
    resolveDriver: async () => null,
    fetchLatest: async () => {
      throw new Error('fetchLatest must not be called — versions.macf is declared (DR-043 Amendment L3)');
    },
    sleep: async () => {},
    now: () => 0,
    log: () => {},
    runUpgradeFleetsFn: upgradeFleets,
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
    // macf#988 — `encrypt` MUST create a real file at the path it's given:
    // `writeAgentRecoveryArtifact`'s atomic-write tail (temp file -> chmod
    // 0600 -> rename into place) needs something to chmod/rename, the same
    // way a REAL `age -o <path>` invocation always would. A pure no-op (the
    // pre-#988 default here) now throws inside `chmodSync` (ENOENT) for any
    // test that reaches the CREATE path.
    vaultDeps: { exists: () => false, encrypt: async (_plaintext, _recipients, outPath) => writeFileSync(outPath, 'FAKE-CIPHERTEXT') },
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
    agentRepoDeps: { checkMeta: async () => ({ presence: 'absent' }), createRepo: async () => {}, unarchiveRepo: async () => {} },
    trustDeps: fakeTrustDeps(),
    routingClientDeps: fakeRoutingClientDeps(),
    routingSecretsDeps: fakeRoutingSecretsDeps(),
    routerAppVaultDeps: {},
    controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
    // macf#988 — the SAME tracked/cleaned-up tmpdir every other path in
    // this file already uses (see `controlRepoOptions.makeScratchDir`'s
    // identical shape above) — the primary test-safety seam; the
    // `MACF_RECOVERY_DIR` env stub in this describe block's `beforeEach` is
    // the belt-and-suspenders backstop.
    recoveryRootDir: join(manifestPath, '..'),
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
    // macf#988 belt-and-suspenders (see `vault-write.ts::defaultOperatorRecoveryRootDir`'s
    // doc): `fakeMutateDeps` below ALWAYS pins `recoveryRootDir` explicitly,
    // but this env override means even a hand-built `MutateApplyDeps`
    // literal that forgets it still cannot reach the real operator's
    // `~/.config/macf/recovery` — this suite never creates or touches
    // anything outside a tracked, per-test tmpdir.
    const recoverySafetyDir = mkdtempSync(join(tmpdir(), 'macf-apply-mutate-recovery-safety-'));
    dirs.push(recoverySafetyDir);
    vi.stubEnv('MACF_RECOVERY_DIR', recoverySafetyDir);
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

  // groundnuty/macf#952 requirement 5 — "`--yes` must not skip these" (the
  // per-gate consent instruction). `--yes` skips ONLY the plan-approval
  // prompt (`confirmPlan`, asserted above) — the gate instruction has no
  // conditional on `yes` anywhere in `apply-agent.ts` at all, so proving it
  // still prints under `--yes` is really proving there's nothing to skip.
  // The run completing synchronously (no manual interaction, no hang) IS
  // "prints without waiting" — there is no blocking prompt in this path.
  it('--yes: the gate instructions still print (both gates), even though the plan-approval prompt never fires', async () => {
    const file = writeManifest();
    const gateLogs: string[] = [];
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, {
        buildAgentDeps: (log) => fakeAgentDeps({ log: (line) => { gateLogs.push(line); log(line); } }),
      }),
    );
    expect(code).toBe(0);
    const joined = gateLogs.join('\n');
    expect(joined).toMatch(/consent gate 1 of 2/);
    expect(joined).toMatch(/consent gate 2 of 2/);
    expect(joined).toMatch(/submitted AS-IS/i);
    // groundnuty/macf#971 — the actionable clause (click GitHub's OWN
    // "Create GitHub App" button) must ALSO survive under `--yes`, same as
    // every other gate-1 instruction line — it has no `yes`-conditional
    // either, but a headless run is exactly the case with no page for a
    // human to fall back to reading, so this is the one case where the
    // terminal line is the ONLY copy that exists at all.
    expect(joined).toMatch(/Create GitHub App/);
    expect(joined).toMatch(/Only select repositories/);
  });

  it('happy path: approves, creates both agents, writes a real fleet.lock + vault.age next to the manifest', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/code-agent: CREATED/);
    expect(out).toMatch(/science-agent: CREATED/);
    // groundnuty/macf#1083 — `FLEET_YAML` (this test's default fixture)
    // declares no self-hosted routing, so the runner-ops App is correctly
    // NOT NEEDED and no lock entry is created for it — see the dedicated
    // "the runner-ops App" describe block for the self-hosted CREATE path.
    expect(out).toMatch(/Runner-ops App:\s*\n\s*runner-ops: NOT NEEDED/);
    expect(out).toMatch(/Vault: written to/);
    // DR-043 Amendment D phase 2 (macf#838) — the CA ceremony ran too: a
    // fresh mint (no prior lock, no prior registry var — the default
    // `fakeTrustDeps()`) publishes to the registry + BOTH agent repos.
    expect(out).toMatch(/CA: MINTED/);
    expect(out).toMatch(/registry leg: CREATED/);

    const dir = join(file, '..');
    expect(existsSync(join(dir, 'fleet.lock'))).toBe(true);
    const lock = parseFleetLock(readFileSync(join(dir, 'fleet.lock'), 'utf-8'));
    expect(lock.agents.map((a) => a.role).sort()).toEqual(['code-agent', 'router', 'science-agent']);
    // The CA key's fingerprint lands in fleet.lock's FLEET-level
    // `fingerprints.ca_key` — the SOLE place it is ever written (see
    // apply-fleet.ts's module doc) — never the raw key value.
    expect(lock.fingerprints?.['ca_key']).toBeDefined();
    expect(JSON.stringify(lock)).not.toContain(SENTINEL_CA_KEY_PEM);
  });

  // groundnuty/macf#954 — the FULL pipeline, end-to-end: on a fresh fleet
  // (CA minted THIS run — the exact live-run shape the bug report names as
  // "the exact next live run"), a `routingClientDeps.mint` EXCEPTION used to
  // collapse into the SAME 'skipped' shape as the two benign steady-state
  // skips, so `apply` exited 0 while NO routing-client cert reached any
  // repo. This test drives the exception through the REAL `apply-fleet.ts`
  // orchestration (not a unit-level `mintRoutingClient` call) and asserts
  // the OBSERVABLE consequence a script checking `$?` would see.
  it('a routing-client mint EXCEPTION on a fresh fleet (CA minted this run) makes the WHOLE apply exit non-zero — the defect groundnuty/macf#954 fixes', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, {
        routingClientDeps: fakeRoutingClientDeps({
          mint: async () => {
            throw new Error('x509 generation failed');
          },
        }),
      }),
    );
    // Before the fix: this was 0 (the mint exception silently collapsed into
    // a "skipped, expected steady state" shape `applyExitCode` never fails
    // on). After the fix: 1 — an automated gate checking `$?` (e.g. #869's
    // live-smoke) now actually catches it.
    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(out).toMatch(/Routing-client cert: FAILED to mint — routing-client cert mint failed: x509 generation failed/);
    // Every OTHER surface of this run still succeeds cleanly — the mint
    // exception is isolated to its own surface, not a cascading failure:
    expect(out).toMatch(/code-agent: CREATED/);
    expect(out).toMatch(/science-agent: CREATED/);
    expect(out).toMatch(/CA: MINTED/);
    expect(out).toMatch(/Vault: written to/);
  });

  it('the SAME fresh-fleet run with a WORKING routing-client mint exits 0 — the fix does not regress the steady/success path', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Routing-client cert: MINTED/);
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

  // groundnuty/macf#1220 — same nonexistent-vault-path trick
  // `bootstrap.test.ts`/`bootstrap-status.test.ts` already use for their own
  // install-scope-coverage wiring tests: proves `install_scope_coverage`
  // reaches the REAL `computeInstallScopeCoverage` through `runBootstrapApply`
  // (never mocked out) when both flags are given, exits 0 even though the
  // vault read fails (this check is reporting-only — see `applyExitCode`'s
  // own "Audited other inputs" doc), and is omitted entirely otherwise.
  it('--vault + --identity-key: `install_scope_coverage` is populated (unknown, for a nonexistent vault) and does not change the exit code', async () => {
    const file = writeManifest();
    const dir = join(file, '..');
    const vaultPath = join(dir, 'does-not-exist', 'vault.age');
    const identityKeyPath = join(dir, 'does-not-exist', 'identity.txt');
    // `deploy: false` — this test is about install-scope-coverage ONLY;
    // `--vault`/`--identity-key` also (correctly, separately) activate the
    // deploy + version-reconcile phases, which `fakeMutateDeps` was never
    // built to drive (its `deployDeps`/`versionDeps` are the REAL,
    // network-touching defaults absent an explicit override) — skipping
    // both keeps this test isolated to the ONE behavior it exists to pin.
    const code = await runBootstrapApply(
      { file, yes: true, json: true, vaultPath, identityKeyPath, deploy: false },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as { install_scope_coverage?: ReadonlyArray<{ role: string; status: string; message?: string }> };
    // FLEET_YAML declares no `routing:` (no runner-ops needed) but a
    // `profile`-type registry, so the router App is the one unconditional
    // target — same fixture shape `bootstrap.test.ts`'s sibling test uses.
    expect(parsed.install_scope_coverage).toHaveLength(1);
    expect(parsed.install_scope_coverage?.[0]?.status).toBe('unknown');
  });

  it('WITHOUT --vault/--identity-key, `install_scope_coverage` is omitted entirely from a successful apply', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as Record<string, unknown>;
    expect('install_scope_coverage' in parsed).toBe(false);
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

  // --- DR-043 Amendment G correction (groundnuty/macf#1034) — every
  // declared repo revives, under ONE approval covering the whole set ---

  it('macf#1034: control repo + BOTH agent repos archived -> the plan shows THREE update items, but confirmPlan fires EXACTLY ONCE (one approval covers the set)', async () => {
    const file = writeManifest();
    const archivedObserved: ObservedState = {
      lock: null,
      agents: {
        'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, archived: true },
        'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {}, archived: true },
      },
      caRegistry: 'present',
      caRepos: {},
      controlRepoPresence: 'present',
      controlRepoArchived: true,
    };
    let confirmPlanCallCount = 0;
    const unarchivedRepos: string[] = [];
    const code = await runBootstrapApply(
      { file },
      { observe: () => Promise.resolve(archivedObserved) },
      fakeMutateDeps(file, {
        confirmPlan: async (plan) => {
          confirmPlanCallCount += 1;
          // Sanity: the plan the operator is approving DOES list all three
          // archived-repo update items — this is what makes "one approval"
          // an honest claim rather than reviving repos the operator never
          // saw counted (Amendment G's "Inventory shown + confirmed before
          // any mutation" rail).
          const archivedItems = plan.items.filter((i) => i.kind === 'control_repo' || i.kind === 'agent_repo_archived');
          expect(archivedItems).toHaveLength(3);
          expect(archivedItems.every((i) => i.verb === 'update' && i.confirm_required)).toBe(true);
          return true;
        },
        controlRepoOptions: { confirmUnarchive: true, makeScratchDir: () => join(file, '..') },
        agentRepoOptions: { confirmUnarchive: true },
        controlRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: true }),
          readManifestFile: async () => FLEET_YAML,
          createRepo: async () => {
            throw new Error('must not be called — ours-archived never creates');
          },
          unarchiveRepo: async (repo) => {
            unarchivedRepos.push(repo);
          },
          cloneRepo: async () => {},
          commitAndPush: async () => 'nothing-to-commit',
        },
        agentRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: true }),
          createRepo: async () => {
            throw new Error('must not be called — every agent repo is present, not absent');
          },
          unarchiveRepo: async (repo) => {
            unarchivedRepos.push(repo);
          },
        },
      }),
    );

    expect(code).toBe(0);
    // Exactly ONE approval, regardless of the THREE archived repos it covers
    // — the decisive proof for "one approval covers the set, no per-repo
    // prompting" (macf#1034 requirement 2).
    expect(confirmPlanCallCount).toBe(1);
    expect([...unarchivedRepos].sort()).toEqual(['groundnuty/demo-code', 'groundnuty/demo-fleet-control', 'groundnuty/demo-science'].sort());
    expect(logs.join('\n')).toMatch(/REVIVED/);
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

  it('macf#972: a poll longer than ~30s narrates on the log seam (never console.log/stdout) — --json output stays valid JSON with progress enabled', async () => {
    const file = writeManifest(FLEET_YAML_WITH_ROUTING);
    const rawWrites: string[] = [];
    let clock = 0;
    const code = await runBootstrapApply(
      { file, yes: true, json: true, runnerToken: SENTINEL_RUNNER_TOKEN },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps(file, {
        // Pre-existing repo -> `apply-routing.ts` takes the real poll path
        // (a repo CREATED this run would skip straight to the immediate
        // single-check fast path — see apply-fleet.test.ts's macf#972 suite
        // for that case; this test is specifically about the >30s NARRATION
        // path, which only the real poll exercises).
        agentRepoDeps: { checkMeta: async () => ({ presence: 'present', archived: false }), createRepo: async () => {}, unarchiveRepo: async () => {} },
        trustDeps: fakeTrustDeps({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
        // `resolveMutateDeps`'s REAL wiring binds `log` to
        // `process.stderr.write` (bootstrap-apply.ts's `log: (line) => {
        // process.stderr.write(...) }`, never console.log — see that
        // binding's own comment: "stdout stays clean for a --json render").
        // This fake stands in for that binding: what matters here is that
        // `apply-fleet.ts`'s progress wiring calls `deps.log`, a channel
        // structurally distinct from the `console.log(JSON.stringify(...))`
        // this file's `logs` spy captures — not that THIS PARTICULAR fake
        // happens to be process.stderr.write.
        log: (line) => rawWrites.push(line),
        runnerTokenPollOptions: {
          timeoutMs: 90_000,
          pollIntervalMs: 10_000,
          progressIntervalMs: 30_000,
          now: () => clock,
          sleepFn: async (ms) => {
            clock += ms;
          },
        },
      }),
    );
    // groundnuty/macf#993 — the runner never becomes usable across this
    // whole poll (`checkRunnerUsableByRepo` always reports 'absent'), so the
    // run now exits non-zero: a declared runner is REQUIRED, never a silent
    // hosted-runner fallback. This test's OWN concern (progress narration
    // stays off stdout, --json stays parseable) is unaffected by the exit
    // code — both are asserted below regardless.
    expect(code).toBe(1);

    const progressLines = rawWrites.filter((l) => l.includes('waiting for a usable self-hosted runner'));
    expect(progressLines.length).toBeGreaterThan(0);
    expect(progressLines[0]).toMatch(/\d+s\/90s elapsed; nothing for you to do/);

    // The decisive --json assertion: stdout (what `logs` captures) is STILL
    // exactly one valid JSON document — progress narration never touched it.
    const stdout = logs.join('\n');
    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsed = JSON.parse(stdout) as { routing: Record<string, { status: string }> };
    expect(parsed.routing['groundnuty/demo-code']?.status).toBe('failed'); // groundnuty/macf#993 — was 'skipped'
    expect(stdout).not.toContain('waiting for a usable self-hosted runner');
  });

  // --- groundnuty/macf#993 — the operator's ruling: a declared runner is
  // REQUIRED, never a silent hosted-runner fallback. Full end-to-end
  // `runBootstrapApply` coverage — the pure `applyExitCode` unit tests below
  // (in the "formatApplyResult / fleetApplyResultToJson / applyExitCode"
  // describe block) already prove the exit-code MECHANISM in isolation; this
  // block proves the WHOLE CLI entrypoint, wired end-to-end, actually
  // produces that outcome for the exact scenario the issue reports:
  // "Routing var (...): skipped — ... MACF_TRUSTED_ACTORS was NOT written
  // ... until a runner is confirmed" printed beside otherwise-green output,
  // with `apply` still exiting 0.
  describe('groundnuty/macf#993 — a declared runner is REQUIRED, never a silent hosted-runner fallback', () => {
    it('DECISIVE: routing.runner declared self-hosted + a runner-token supplied + NO usable runner ever confirmed -> non-zero exit, and the message names the billing consequence', async () => {
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, yes: true, runnerToken: SENTINEL_RUNNER_TOKEN },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, {
          trustDeps: fakeTrustDeps({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
          runnerTokenPollOptions: { timeoutMs: 0 }, // no real wall-clock wait
        }),
      );
      // The decisive assertion: the EXIT CODE, not just the message — a test
      // asserting only the warning text passes against the pre-#993 code,
      // which exits 0. That is exactly the gap this issue closes.
      expect(code).toBe(1);
      const all = [...logs, ...errs].join('\n');
      // The message names the cost consequence — same reason text
      // `apply-routing.ts::runnerTokenPollExhaustedReason` has always
      // produced, now paired with a FAILED status instead of SKIPPED.
      expect(all).toContain('billed on private repos');
      expect(all).toContain('MACF_TRUSTED_ACTORS was NOT written');
      expect(all).toContain('groundnuty/demo-code: FAILED —');
      expect(all).not.toContain('groundnuty/demo-code: SKIPPED');
    });

    it('declared routing.runner self-hosted + a USABLE runner confirmed -> exit 0, MACF_TRUSTED_ACTORS written, unchanged from today', async () => {
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, yes: true, json: true, runnerToken: SENTINEL_RUNNER_TOKEN },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file), // fakeTrustDeps' default checkRunnerUsableByRepo reports 'present'
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(logs.join('\n')) as { routing: Record<string, { status: string }> };
      expect(parsed.routing['groundnuty/demo-code']?.status).toBe('created');
    });

    it('groundnuty/macf#1195 DECISIVE at the CLI level: declared routing.runner self-hosted + NO token resolvable + a USABLE runner confirmed -> exit 0 (the early pre-flight still WARNS on stderr, but does not gate the outcome)', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, yes: true, json: true }, // no opts.runnerToken at all
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        // fakeTrustDeps' default checkRunnerUsableByRepo reports 'present' —
        // this is the live-evidence case #1195 exists for: no token, but a
        // runner is ALREADY there, so nothing needs registering.
        fakeMutateDeps(file, { runnerToken: undefined }),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(logs.join('\n')) as { routing: Record<string, { status: string }> };
      expect(parsed.routing['groundnuty/demo-code']?.status).toBe('created');
      // The early pre-flight (checkRunnerTokenPreflight, `apply-routing.ts`)
      // still warns unconditionally at this point in the flow — it fires
      // before any repo is observed, so it genuinely cannot know the
      // outcome below will succeed. That is expected, not a bug: the
      // warning names a REQUIREMENT ("apply cannot REGISTER a new runner
      // without one"), never a guaranteed refusal — see
      // `noRunnerTokenReason`'s doc.
      expect(errs.join('\n')).toContain(RUNNER_TOKEN_FLAG);
    });

    it('REGRESSION GUARD: routing.runner NOT declared at all -> exit 0 even though no usable runner would ever be confirmed — an undeclared fleet is structurally unreachable by this change', async () => {
      const file = writeManifest(); // base FLEET_YAML — no `routing:` section at all
      const code = await runBootstrapApply(
        { file, yes: true, json: true }, // deliberately no runnerToken — an undeclared fleet needs none
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, {
          // Even if a runner-usability check WERE wired in, an undeclared
          // fleet must never call it — `apply-fleet.ts`'s
          // `manifest.routing?.runner.runs_on === 'self-hosted'` gate keeps
          // `publishTrustedActorsGated` (and therefore this fake) entirely
          // unreached. Asserting `presence: 'absent'` here — rather than
          // 'present' — is the point: this run must stay green regardless
          // of what a live check WOULD have said, because it's never asked.
          trustDeps: fakeTrustDeps({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }),
        }),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(logs.join('\n')) as { routing: Record<string, unknown> };
      expect(parsed.routing).toEqual({});
    });
  });

  // --- macf#932 (narrowed by groundnuty/macf#1209) — the pre-flight fires
  // BEFORE consent gate 1, but no longer ABORTS the run. It WARNS (still at
  // the same early point — before observe/plan/consent-gate work) and falls
  // through into `applyFleet`, which independently refuses ONLY the
  // `MACF_TRUSTED_ACTORS` write via `publishTrustedActorsGated` (UNCHANGED,
  // macf#929). See the `groundnuty/macf#1209` describe block below for the
  // decisive test proving legs that don't depend on the runner token now
  // proceed to completion instead of being discarded by this early abort.

  describe('macf#932 (narrowed by groundnuty/macf#1209) — early WARNING before consent gate 1, run proceeds regardless', () => {
    it('declared routing.runner self-hosted + NO token resolvable -> WARNS before consent gate 1 but the run PROCEEDS: observe/buildAgentDeps/openUrl/startManifestFlow ALL fire, unlike pre-#1209', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, ''); // pin: this test's verdict must not depend on the ambient shell env
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      let observeCalls = 0;
      let buildAgentDepsCalls = 0;
      let openUrlCalls = 0;
      let startManifestFlowCalls = 0;
      let checkRunnerUsableCalls = 0;

      const code = await runBootstrapApply(
        // `yes: true` bypasses `confirmPlan` entirely by design (see
        // `runBootstrapApply`'s own `opts.yes === true ? true :
        // await mutate.confirmPlan(...)`) — so `confirmPlan` staying at ZERO
        // calls here is unrelated to this test's point and is NOT asserted;
        // the seams below (observe/buildAgentDeps/openUrl/startManifestFlow)
        // are what prove the run reached past the pre-flight into
        // `applyFleet`. `confirmAppInstallation` is NOT one of them —
        // `waitForAppInstallation`'s default `repositorySelection: 'selected'`
        // fixture never reaches it in this happy-ish path (unrelated to this
        // fix), so it is not a reliable "did the run proceed" signal here.
        { file, yes: true }, // no opts.runnerToken
        {
          observe: () => {
            observeCalls += 1;
            return Promise.resolve(EMPTY_OBSERVED);
          },
        },
        fakeMutateDeps(file, {
          runnerToken: undefined,
          buildAgentDeps: () => {
            buildAgentDepsCalls += 1;
            return fakeAgentDeps({
              openUrl: async () => {
                openUrlCalls += 1;
              },
              startManifestFlow: async () => {
                startManifestFlowCalls += 1;
                return {
                  startUrl: 'http://127.0.0.1:9/',
                  redirectUrl: 'http://127.0.0.1:9/callback',
                  waitForCode: async () => 'the-code',
                  close: async () => {},
                };
              },
            });
          },
          // groundnuty/macf#1195 — genuinely absent here (not 'present'):
          // this test's OTHER point is that the run still correctly fails
          // overall when nothing is actually there. See the sibling
          // 'declared routing.runner self-hosted + a USABLE runner confirmed'
          // test above for the #1195 case where NO token + a PRESENT runner
          // proceeds and writes.
          trustDeps: fakeTrustDeps({
            checkRunnerUsableByRepo: async () => {
              checkRunnerUsableCalls += 1;
              return { presence: 'absent' };
            },
          }),
        }),
      );

      // groundnuty/macf#1209 — the run still FAILS overall (a declared
      // self-hosted runner with no confirmed runner stays non-zero, macf#993's
      // ruling), but it is NOT a total abort any more: every seam below fired.
      expect(code).toBe(1);
      expect(observeCalls).toBeGreaterThan(0);
      expect(buildAgentDepsCalls).toBeGreaterThan(0);
      expect(openUrlCalls).toBeGreaterThan(0);
      expect(startManifestFlowCalls).toBeGreaterThan(0);
      // groundnuty/macf#1195 — the runner-usability seam IS now consulted
      // even with no token (that is the fix: absence of a token no longer
      // forecloses a repo whose runner is already usable) — once PER
      // CONFIRMED REPO (this manifest declares two agents), never a poll
      // (nothing licenses a wait without a token).
      expect(checkRunnerUsableCalls).toBeGreaterThan(0);

      expect(errs.join('\n')).toContain(RUNNER_TOKEN_FLAG);
      expect(errs.join('\n')).toContain(RUNNER_TOKEN_ENV_VAR);
    });

    it('the failure is visible under --json too (never empty stdout, macf#830 lesson) — as a FULL apply-result, not an early-abort error object: routing shows the FAILED leg, other sections show their own real outcomes', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, yes: true, json: true },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        // groundnuty/macf#1195 — genuinely absent here: the point of THIS
        // test is the failure's JSON SHAPE, which needs a real 'failed' leg
        // to inspect. `fakeTrustDeps()`'s default now-live 'present' read
        // would otherwise let the write succeed with no token at all.
        fakeMutateDeps(file, { runnerToken: undefined, trustDeps: fakeTrustDeps({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }) }),
      );
      expect(code).toBe(1);
      expect(logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logs.join('\n')) as {
        routing: Record<string, { status: string; reason?: string }>;
        control_repo: { status: string };
      };
      // groundnuty/macf#1209 — NOT `{ error: { code: 'runner_token_missing' } }`
      // any more (that shape meant "nothing else was even attempted"). This is
      // the real, full `fleetApplyResultToJson` shape — proof the run reached
      // the point of having a `control_repo` outcome at all, which the
      // pre-#1209 early-abort object never carried.
      expect(parsed.control_repo).toBeDefined();
      const routingLeg = parsed.routing['groundnuty/demo-code'];
      expect(routingLeg?.status).toBe('failed');
      expect(routingLeg?.reason).toContain(RUNNER_TOKEN_FLAG);
      expect(routingLeg?.reason).toContain(RUNNER_TOKEN_ENV_VAR);
      // The early WARNING still fires, on stderr — never mixed into the
      // single JSON object `--json` mode emits on stdout.
      expect(errs.join('\n')).toContain(RUNNER_TOKEN_FLAG);
    });

    it('an empty-string --runner-token is treated the same as no token — still WARNS before gate 1, still lets the run proceed', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, yes: true, runnerToken: '' },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        // groundnuty/macf#1195 — genuinely absent here, same rationale as
        // the sibling '--json too' test above.
        fakeMutateDeps(file, { runnerToken: undefined, trustDeps: fakeTrustDeps({ checkRunnerUsableByRepo: async () => ({ presence: 'absent' }) }) }),
      );
      expect(code).toBe(1);
      expect(errs.join('\n')).toContain(RUNNER_TOKEN_FLAG);
      expect(logs.join('\n') + errs.join('\n')).toMatch(/Routing \(MACF_TRUSTED_ACTORS\):/);
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

  // --- groundnuty/macf#1209 — the refusal narrows to runner-dependent work
  // only. THE decisive test this issue exists for: a preflight that aborts
  // the run must gate only what actually depends on the missing input.
  // Observed live on `macf-trial` — a router credential had just been merged
  // into the vault (an operator-authorised one-time decrypt) and was never
  // published, because the runner-token refusal aborted the ENTIRE run
  // before ever reaching the routing-secrets publish, discarding that
  // irreversible operator action's whole purpose. Per
  // `assert-the-wrong-path.md`: asserting ONLY "the run still fails" is
  // satisfied by removing the refusal outright, so this test ALSO asserts
  // the negative half — MACF_TRUSTED_ACTORS was genuinely WITHHELD, not
  // silently written anyway.
  describe('groundnuty/macf#1209 — the runner-token refusal gates only runner-dependent work', () => {
    it('DECISIVE: self-hosted declared, no runner token, router credential available -> routing secrets ARE published, MACF_TRUSTED_ACTORS is NOT, run exits non-zero naming the skip', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      // `trustDeps.createRepoVariable` is SHARED — `apply-ca.ts`'s per-repo
      // `DEMO_FLEET_CA_CERT` writes go through the SAME primitive as
      // `MACF_TRUSTED_ACTORS`. A raw call-count of zero would be the WRONG
      // assertion (CA legs are expected to write here, since CA doesn't
      // depend on the runner token either) — capture the variable NAME per
      // call so the negative-half assertion below can single out
      // `MACF_TRUSTED_ACTORS` specifically.
      const createRepoVariableCalls: { repo: string; name: string }[] = [];
      let checkRunnerUsableCalls = 0;

      const code = await runBootstrapApply(
        { file, yes: true, json: true }, // no opts.runnerToken
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, {
          runnerToken: undefined,
          routingSecretsDeps: fakeRoutingSecretsDeps({
            checkRepoSecretPresence: async () => 'absent',
            setRepoSecret: async (repo, name, value) => {
              setSecretCalls.push({ repo, name, value });
            },
          }),
          trustDeps: fakeTrustDeps({
            createRepoVariable: async (repo, name) => {
              createRepoVariableCalls.push({ repo, name });
              return 'created';
            },
            // groundnuty/macf#1195 — genuinely absent here (not 'present'):
            // this test's point is #1209's NARROW-SCOPE refusal (routing
            // secrets + CA proceed, only MACF_TRUSTED_ACTORS is withheld),
            // which needs the write to actually stay refused. See the
            // dedicated #1195 tests elsewhere in this file/apply-fleet.test.ts
            // for the case where NO token + a PRESENT runner proceeds.
            checkRunnerUsableByRepo: async () => {
              checkRunnerUsableCalls += 1;
              return { presence: 'absent' };
            },
          }),
        }),
      );

      // The run still fails overall — NOT a downgrade to a warning. Uses
      // #1151's EXISTING 0/1/2 exit-code vocabulary (`applyExitCode`'s
      // pre-existing `routingBad` check, unchanged by this fix) rather than
      // inventing a new code — a declared-and-unconfirmable self-hosted
      // runner is a HARD failure (macf#993's ruling), not a partial-roll `2`
      // (that code is reserved for the version-reconcile phase leaving fleet
      // members un-rolled — see `applyExitCode`'s own doc — a different axis
      // entirely from fleet PROVISIONING completeness).
      expect(code).toBe(1);

      // Positive half — legs that do NOT depend on the runner token
      // proceeded and actually published. `MACF_ROUTING_APP_ID`/`_KEY` come
      // from the freshly-created router App this run; `ROUTING_CLIENT_CERT`/
      // `_KEY` come from the fresh routing-client mint — neither reads
      // `resolvedRunnerToken` at any point (`apply-fleet.ts`'s per-name
      // `RoutingSecretResolution` bag, `apply-routing-secrets.ts`'s module
      // doc).
      expect(setSecretCalls.some((c) => c.name === 'MACF_ROUTING_APP_ID')).toBe(true);
      expect(setSecretCalls.some((c) => c.name === 'MACF_ROUTING_APP_KEY')).toBe(true);
      expect(setSecretCalls.some((c) => c.name === 'ROUTING_CLIENT_CERT')).toBe(true);
      expect(setSecretCalls.some((c) => c.name === 'ROUTING_CLIENT_KEY')).toBe(true);

      // Negative half (the actual point, per assert-the-wrong-path.md) —
      // MACF_TRUSTED_ACTORS was genuinely WITHHELD, not silently written
      // anyway despite the exit code being non-zero for some OTHER reason.
      // `createRepoVariable` DOES get called — for the CA legs, which don't
      // depend on the runner token either and are expected to succeed (proof
      // CA proceeded too) — so the assertion is on the VARIABLE NAME, not the
      // raw call count: no call ever named `MACF_TRUSTED_ACTORS`.
      expect(createRepoVariableCalls.some((c) => c.name === 'MACF_TRUSTED_ACTORS')).toBe(false);
      expect(createRepoVariableCalls.some((c) => c.name === 'DEMO_FLEET_CA_CERT')).toBe(true);
      // groundnuty/macf#1195 — the runner-usability check IS now consulted
      // (that is the fix); the refusal above is EVIDENCED by a live read
      // reporting 'absent', not assumed from the missing token alone. A
      // passing "code is non-zero" assertion alone would not catch a
      // regression that quietly dropped either half of this contract.
      expect(checkRunnerUsableCalls).toBeGreaterThan(0);

      const parsed = JSON.parse(logs.join('\n')) as { routing: Record<string, { status: string; reason?: string }> };
      const routingLeg = parsed.routing['groundnuty/demo-code'];
      expect(routingLeg?.status).toBe('failed');
      expect(routingLeg?.reason).toContain('no runner registration token was supplied');
      // The summary distinguishes skipped-because-dependent (both agent
      // repos' routing legs, whose reason NAMES the missing token — "the
      // summary names what was skipped and why") from a genuine unrelated
      // failure: no OTHER section of this run's result carries a 'failed'
      // status anywhere (the setSecretCalls assertions above already prove
      // routing secrets succeeded; a genuinely-broken run would show BOTH
      // 'failed').
      expect(parsed.routing['groundnuty/demo-science']?.status).toBe('failed');
    });

    it('everything supplied -> unchanged (this decisive pair\'s control case)', async () => {
      vi.stubEnv(RUNNER_TOKEN_ENV_VAR, '');
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      const code = await runBootstrapApply(
        { file, yes: true, json: true, runnerToken: SENTINEL_RUNNER_TOKEN },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, {
          routingSecretsDeps: fakeRoutingSecretsDeps({
            checkRepoSecretPresence: async () => 'absent',
            setRepoSecret: async (repo, name, value) => {
              setSecretCalls.push({ repo, name, value });
            },
          }),
        }),
      );
      expect(code).toBe(0);
      expect(setSecretCalls.some((c) => c.name === 'MACF_ROUTING_APP_ID')).toBe(true);
      const parsed = JSON.parse(logs.join('\n')) as { routing: Record<string, { status: string }> };
      expect(parsed.routing['groundnuty/demo-code']?.status).toBe('created');
    });
  });

  // --- groundnuty/macf#1074 — Tailscale-declared refuse-before-gate-1
  // pre-flight, same shape as macf#932 immediately above: the decisive case
  // is zero gate invocations, not merely a non-zero exit code.
  describe('groundnuty/macf#1074 — Tailscale-declared pre-flight refusal before consent gate 1', () => {
    it('declared + NO --vault/--identity-key supplied -> refuses BEFORE consent gate 1: observe/confirmPlan/buildAgentDeps/openUrl/startManifestFlow/confirmAppInstallation are ALL zero calls', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      let observeCalls = 0;
      let confirmPlanCalls = 0;
      let buildAgentDepsCalls = 0;
      let openUrlCalls = 0;
      let startManifestFlowCalls = 0;
      let confirmAppInstallationCalls = 0;

      const code = await runBootstrapApply(
        { file, yes: true }, // no vaultPath/identityKeyPath
        {
          observe: () => {
            observeCalls += 1;
            return Promise.resolve(EMPTY_OBSERVED);
          },
        },
        fakeMutateDeps(file, {
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
      // THE decisive assertion: not "exited non-zero" but "never even
      // asked the operator to approve, never even read GitHub state,
      // never opened a browser." Each seam firing would mean the refusal
      // arrived too late (mirrors macf#932's identical discipline above).
      expect(observeCalls).toBe(0);
      expect(confirmPlanCalls).toBe(0);
      expect(buildAgentDepsCalls).toBe(0);
      expect(openUrlCalls).toBe(0);
      expect(startManifestFlowCalls).toBe(0);
      expect(confirmAppInstallationCalls).toBe(0);

      expect(errs.join('\n')).toContain('--vault/--identity-key');
      // Nothing mutated:
      const dir = join(file, '..');
      expect(existsSync(join(dir, 'fleet.lock'))).toBe(false);
      expect(existsSync(join(dir, 'secrets', 'vault.age'))).toBe(false);
    });

    it('declared + both flags supplied + vault lacks the values -> STILL refuses before gate 1 (same zero-calls proof)', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      let startManifestFlowCalls = 0;
      const code = await runBootstrapApply(
        { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
        { observe: () => Promise.resolve(EMPTY_OBSERVED), readVault: async () => ({}) },
        fakeMutateDeps(file, {
          buildAgentDeps: () =>
            fakeAgentDeps({
              startManifestFlow: async () => {
                startManifestFlowCalls += 1;
                throw new Error('must not be called');
              },
            }),
        }),
      );
      expect(code).toBe(1);
      expect(startManifestFlowCalls).toBe(0);
      expect(errs.join('\n')).toMatch(/did not yield TS_OAUTH_CLIENT_ID/);
    });

    it('the refusal is visible under --json too, never empty stdout', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const code = await runBootstrapApply({ file, yes: true, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
      expect(code).toBe(1);
      expect(logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logs.join('\n')) as { error: { code: string; message: string } };
      // groundnuty/macf#1197 — the operator-secrets-file aggregate check
      // now fires FIRST for the vault-absent case (this test supplies no
      // vault flags), superseding `checkTailscaleOauthPreflight`'s own
      // `TAILSCALE_OAUTH_MISSING_CODE` for this scenario; that code is
      // still reachable when vault flags ARE given (see the sibling
      // "vault lacks the values" test below).
      expect(parsed.error.code).toBe(MISSING_OPERATOR_INPUTS_CODE);
    });

    it('NOT declared at all -> unaffected: proceeds with no vault flags and no refusal (a fleet that has not set up Tailscale yet is not broken)', async () => {
      const file = writeManifest(); // FLEET_YAML — no tailscale_oauth_required
      const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
      expect(code).toBe(0);
      expect(errs.join('\n')).not.toContain(TAILSCALE_OAUTH_MISSING_CODE);
    });

    it('declared + both flags supplied + vault YIELDS the values -> proceeds (not a new obstacle for the already-satisfied case)', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const code = await runBootstrapApply(
        // macf#1013 — deploy:false: this test is about the Tailscale
        // preflight + publish-time resolution, not the (unrelated) deploy
        // phase, which would otherwise try to decrypt the fake vault path
        // for real and fail, contaminating this test's exit-code assertion.
        { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt', deploy: false },
        { observe: () => Promise.resolve(EMPTY_OBSERVED), readVault: async () => ({ TS_OAUTH_CLIENT_ID: 'ts-client-id', TS_OAUTH_SECRET: 'ts-secret' }) },
        fakeMutateDeps(file, {
          // The preflight (above) and the PUBLISH-time resolution
          // (apply-fleet.ts, via routingSecretsDeps.readVaultTsOauth) are
          // two SEPARATE reads (the "each concern gets its own decrypt"
          // convention this codebase already follows for CA/routing-client
          // restores) — both need wiring for the run to fully succeed, not
          // just clear the preflight.
          routingSecretsDeps: fakeRoutingSecretsDeps({
            checkRepoSecretPresence: async () => 'present',
            readVaultTsOauth: async () => ({ clientId: 'ts-client-id', secret: 'ts-secret' }),
          }),
        }),
      );
      expect(code).toBe(0);
      expect(errs.join('\n')).not.toContain(TAILSCALE_OAUTH_MISSING_CODE);
    });

    it('--dry-run is UNAFFECTED even with no vault flags — a dry run never opens a gate to begin with', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const code = await runBootstrapApply({ file, dryRun: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) });
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toMatch(/DRY RUN — nothing was created/);
    });
  });

  // --- groundnuty/macf#1186 — `--ts-oauth-client-id`/`--ts-oauth-secret`:
  // a fresh org has NO vault to read TS_OAUTH from at all (nothing ever
  // WRITES the pair into one), so the tests immediately above this block
  // (all requiring --vault/--identity-key) do not cover the cold-start
  // case. These tests cover the flag/env resolution path that bypasses the
  // vault requirement entirely.
  describe('groundnuty/macf#1186 — --ts-oauth-client-id/--ts-oauth-secret (flag/env, no vault required)', () => {
    it('flag alone (no vault flags at all) satisfies a declared requirement — proceeds past the pre-flight, publishes the flag values', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      const code = await runBootstrapApply(
        { file, yes: true, deploy: false, tsOauthClientId: 'flag-client-id', tsOauthSecret: 'flag-secret' }, // no vaultPath/identityKeyPath
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        // `mutateDeps` is EXPLICITLY given here, so `runBootstrapApply` never
        // calls `resolveMutateDeps` (which is where the CLI-resolved
        // opts.tsOauthClientId/tsOauthSecret would otherwise land on
        // `FleetApplyDeps.resolvedTsOauth`) — `resolvedTsOauth` must ALSO be
        // set directly here, mirroring `runnerToken`'s own identical
        // "opts.X must ALSO be set" contract for the same reason.
        fakeMutateDeps(file, {
          resolvedTsOauth: { clientId: 'flag-client-id', secret: 'flag-secret' },
          routingSecretsDeps: fakeRoutingSecretsDeps({
            checkRepoSecretPresence: async () => 'absent',
            setRepoSecret: async (repo, name, value) => {
              setSecretCalls.push({ repo, name, value });
            },
          }),
        }),
      );
      expect(code).toBe(0);
      expect(errs.join('\n')).not.toContain(TAILSCALE_OAUTH_MISSING_CODE);
      expect(setSecretCalls.some((c) => c.name === 'TS_OAUTH_CLIENT_ID' && c.value === 'flag-client-id')).toBe(true);
      expect(setSecretCalls.some((c) => c.name === 'TS_OAUTH_SECRET' && c.value === 'flag-secret')).toBe(true);
    });

    it('env fallback alone (MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID/_SECRET, no flags) also satisfies the pre-flight — the env-var half is exercised, not just the flag half', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      vi.stubEnv(TS_OAUTH_CLIENT_ID_ENV_VAR, 'env-client-id');
      vi.stubEnv(TS_OAUTH_SECRET_ENV_VAR, 'env-secret');
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      const code = await runBootstrapApply(
        { file, yes: true, deploy: false }, // no opts.tsOauthClientId/tsOauthSecret — only the env vars
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        // `mutateDeps` bypasses `resolveMutateDeps` (see the doc on the
        // sibling test above) — `resolvedTsOauth` here matches what the env
        // vars resolve to; the DECISIVE assertion for env-fallback itself is
        // `errs` not containing TAILSCALE_OAUTH_MISSING_CODE below (governed
        // entirely by `runBootstrapApply`'s own opts/env resolution, which
        // this override cannot influence).
        fakeMutateDeps(file, {
          resolvedTsOauth: { clientId: 'env-client-id', secret: 'env-secret' },
          routingSecretsDeps: fakeRoutingSecretsDeps({
            checkRepoSecretPresence: async () => 'absent',
            setRepoSecret: async (repo, name, value) => {
              setSecretCalls.push({ repo, name, value });
            },
          }),
        }),
      );
      expect(code).toBe(0);
      expect(errs.join('\n')).not.toContain(TAILSCALE_OAUTH_MISSING_CODE);
      expect(setSecretCalls.some((c) => c.name === 'TS_OAUTH_CLIENT_ID' && c.value === 'env-client-id')).toBe(true);
      expect(setSecretCalls.some((c) => c.name === 'TS_OAUTH_SECRET' && c.value === 'env-secret')).toBe(true);
    });

    // groundnuty/macf#1186 — "CLI flag wins over env" cannot be observed
    // decisively through the full `runBootstrapApply` integration surface:
    // once EITHER source clears the pre-flight, a flag-sourced and an
    // env-sourced value satisfy the exact same presence check identically,
    // and the only way to see which one "won" downstream is via
    // `mutateDeps.resolvedTsOauth` — which a test would have to hand-set to
    // the expected winner itself, making the assertion circular (per
    // `assert-the-wrong-path.md` trigger 1: the reference value would come
    // from what it checks). `resolveTsOauthFlagOrEnv` is tested directly,
    // non-circularly, in `bootstrap-apply.test.ts`'s own describe block
    // below instead.
    it('half a pair (only --ts-oauth-client-id, no secret and no env fallback) refuses BEFORE the manifest is even parsed — zero gate calls, naming what to supply', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      vi.stubEnv(TS_OAUTH_CLIENT_ID_ENV_VAR, '');
      vi.stubEnv(TS_OAUTH_SECRET_ENV_VAR, '');
      let observeCalls = 0;
      const code = await runBootstrapApply(
        { file, yes: true, tsOauthClientId: 'flag-client-id-only' }, // no tsOauthSecret
        {
          observe: () => {
            observeCalls += 1;
            return Promise.resolve(EMPTY_OBSERVED);
          },
        },
      );
      expect(code).toBe(1);
      expect(observeCalls).toBe(0);
      expect(errs.join('\n')).toContain(TS_OAUTH_CLIENT_ID_FLAG);
      expect(errs.join('\n')).toContain(TS_OAUTH_SECRET_FLAG);
      // The half-given VALUE that WAS supplied must never leak either.
      expect(errs.join('\n')).not.toContain('flag-client-id-only');
    });

    it('the flags-incomplete refusal is visible under --json too, with the dedicated error code', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const code = await runBootstrapApply({ file, yes: true, json: true, tsOauthSecret: 'flag-secret-only' }, { observe: () => Promise.resolve(EMPTY_OBSERVED) });
      expect(code).toBe(1);
      const parsed = JSON.parse(logs.join('\n')) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe(TS_OAUTH_FLAGS_INCOMPLETE_CODE);
    });

    it('declared + no vault + NEITHER flag/env supplied -> STILL refuses before gate 1 — naming both keys via the aggregate operator-inputs message (groundnuty/macf#1197)', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      let startManifestFlowCalls = 0;
      const code = await runBootstrapApply(
        { file, yes: true }, // no vault flags, no ts-oauth flags, no env, no secrets file
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, {
          buildAgentDeps: () =>
            fakeAgentDeps({
              startManifestFlow: async () => {
                startManifestFlowCalls += 1;
                throw new Error('must not be called — the pre-flight must refuse before this seam is ever reached');
              },
            }),
        }),
      );
      expect(code).toBe(1);
      expect(startManifestFlowCalls).toBe(0);
      // groundnuty/macf#1197 — since the operator secrets file's aggregate
      // check now runs before `checkTailscaleOauthPreflight`, the refusal
      // names the env-var-style keys the file understands (exactly what
      // the operator would put IN the file), not the flag literal.
      const message = errs.join('\n');
      expect(message).toContain(TS_OAUTH_CLIENT_ID_ENV_VAR);
      expect(message).toContain(TS_OAUTH_SECRET_ENV_VAR);
    });

    it('NEVER logs the supplied secret value anywhere in stdout/stderr across a full run (text AND --json) — only the flag/env NAMES may appear', async () => {
      const TS_OAUTH_CLIENT_ID_SECRET = 'SENTINEL-1186-CLIENT-ID-MUST-NEVER-LEAK';
      const TS_OAUTH_SECRET_SECRET = 'SENTINEL-1186-SECRET-MUST-NEVER-LEAK';
      for (const json of [false, true]) {
        const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
        const code = await runBootstrapApply(
          { file, yes: true, json, deploy: false, tsOauthClientId: TS_OAUTH_CLIENT_ID_SECRET, tsOauthSecret: TS_OAUTH_SECRET_SECRET },
          { observe: () => Promise.resolve(EMPTY_OBSERVED) },
          fakeMutateDeps(file, {
            resolvedTsOauth: { clientId: TS_OAUTH_CLIENT_ID_SECRET, secret: TS_OAUTH_SECRET_SECRET },
            routingSecretsDeps: fakeRoutingSecretsDeps({ checkRepoSecretPresence: async () => 'absent', setRepoSecret: async () => {} }),
          }),
        );
        expect(code).toBe(0);
      }
      const all = [...logs, ...errs].join('\n');
      expect(all).not.toContain(TS_OAUTH_CLIENT_ID_SECRET);
      expect(all).not.toContain(TS_OAUTH_SECRET_SECRET);
    });
  });

  // --- groundnuty/macf#1197 — the operator secrets file: widens the
  // ts-oauth resolution above to a 4-tier flag -> per-fleet file ->
  // per-scope file -> env chain. The decisive pair per the issue: (1) all
  // required keys present in the file -> apply proceeds with NO secret
  // flags on the command line, and the VALUES that were actually published
  // came FROM the file (not "ignored the file and got them elsewhere" —
  // `assert-the-wrong-path.md` trigger 1); (2) a required key missing ->
  // fails before the first gate, naming every missing key.
  describe('groundnuty/macf#1197 — operator secrets file (--secrets-file / --scope-secrets-file)', () => {
    function writeSecretsFile(dir: string, contents: string, name = 'secrets.env'): string {
      const path = join(dir, name);
      writeFileSync(path, contents);
      return path;
    }

    it('DECISIVE 1: every required key present in the per-fleet file -> apply proceeds with NO secret flags, publishing the FILE-sourced values', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const secretsFile = writeSecretsFile(
        dirname(file),
        'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=file-client-id\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=file-secret\n',
      );
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      const code = await runBootstrapApply(
        { file, yes: true, deploy: false, secretsFilePath: secretsFile }, // NO tsOauthClientId/tsOauthSecret flags
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, {
          resolvedTsOauth: { clientId: 'file-client-id', secret: 'file-secret' },
          routingSecretsDeps: fakeRoutingSecretsDeps({
            checkRepoSecretPresence: async () => 'absent',
            setRepoSecret: async (repo, name, value) => {
              setSecretCalls.push({ repo, name, value });
            },
          }),
        }),
      );
      expect(code).toBe(0);
      expect(errs.join('\n')).not.toContain(TAILSCALE_OAUTH_MISSING_CODE);
      // The decisive assertion: the FILE's values were published — proves
      // the file was actually consulted, not merely that SOME value
      // (e.g. from env) satisfied the pre-flight.
      expect(setSecretCalls.some((c) => c.name === 'TS_OAUTH_CLIENT_ID' && c.value === 'file-client-id')).toBe(true);
      expect(setSecretCalls.some((c) => c.name === 'TS_OAUTH_SECRET' && c.value === 'file-secret')).toBe(true);
    });

    it('DECISIVE 2: a required key missing from the file -> refuses BEFORE the first gate, naming every missing key together, via the FILE\'s own aggregate mechanism', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      // A file that supplies neither key at all — same as "no file given"
      // for this pair, but exercises the read path rather than the
      // undefined-path skip.
      const secretsFile = writeSecretsFile(dirname(file), '# nothing relevant in here\nSOME_UNRELATED_KEY=whatever\n');
      let observeCalls = 0;
      const code = await runBootstrapApply(
        { file, yes: true, json: true, secretsFilePath: secretsFile }, // no flags, no env
        {
          observe: () => {
            observeCalls += 1;
            return Promise.resolve(EMPTY_OBSERVED);
          },
        },
      );
      expect(code).toBe(1);
      expect(observeCalls).toBe(0); // never reached a gate
      // Decisive: the CODE proves this is the file's OWN aggregate
      // mechanism firing — not merely `checkTailscaleOauthPreflight`'s
      // pre-existing pair-shaped message happening to name two keys.
      const parsed = JSON.parse(logs.join('\n')) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe(MISSING_OPERATOR_INPUTS_CODE);
      expect(parsed.error.message).toContain(TS_OAUTH_CLIENT_ID_ENV_VAR);
      expect(parsed.error.message).toContain(TS_OAUTH_SECRET_ENV_VAR);
    });

    it('flag beats the per-fleet file on conflict', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const secretsFile = writeSecretsFile(
        dirname(file),
        'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=file-client-id\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=file-secret\n',
      );
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      const code = await runBootstrapApply(
        { file, yes: true, deploy: false, secretsFilePath: secretsFile, tsOauthClientId: 'flag-client-id', tsOauthSecret: 'flag-secret' },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, {
          resolvedTsOauth: { clientId: 'flag-client-id', secret: 'flag-secret' },
          routingSecretsDeps: fakeRoutingSecretsDeps({
            checkRepoSecretPresence: async () => 'absent',
            setRepoSecret: async (repo, name, value) => {
              setSecretCalls.push({ repo, name, value });
            },
          }),
        }),
      );
      expect(code).toBe(0);
      expect(setSecretCalls.some((c) => c.name === 'TS_OAUTH_CLIENT_ID' && c.value === 'flag-client-id')).toBe(true);
      expect(setSecretCalls.some((c) => c.value === 'file-client-id')).toBe(false);
    });

    // groundnuty/macf#1197's operator ruling: "a fleet supplying one
    // override must not lose every other scope-level value." Fleet file
    // overrides the client ID only; the secret comes from the SCOPE file.
    it('per-KEY override end-to-end: a fleet file overriding one key still inherits the OTHER key from the scope file', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const dir = dirname(file);
      const fleetFile = writeSecretsFile(dir, 'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=fleet-client-id\n', 'fleet-secrets.env');
      const scopeFile = writeSecretsFile(
        dir,
        'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=scope-client-id\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=scope-secret\n',
        'scope-secrets.env',
      );
      const setSecretCalls: { repo: string; name: string; value: string }[] = [];
      const code = await runBootstrapApply(
        { file, yes: true, deploy: false, secretsFilePath: fleetFile, scopeSecretsFilePath: scopeFile },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, {
          resolvedTsOauth: { clientId: 'fleet-client-id', secret: 'scope-secret' },
          routingSecretsDeps: fakeRoutingSecretsDeps({
            checkRepoSecretPresence: async () => 'absent',
            setRepoSecret: async (repo, name, value) => {
              setSecretCalls.push({ repo, name, value });
            },
          }),
        }),
      );
      expect(code).toBe(0);
      // Whole-file shadowing would have EITHER dropped the scope file
      // entirely (client-id resolves, secret never does -> refusal) OR
      // ignored the fleet override. Both keys resolving, from their
      // DIFFERENT declared tiers, is the decisive per-KEY proof.
      expect(setSecretCalls.some((c) => c.name === 'TS_OAUTH_CLIENT_ID' && c.value === 'fleet-client-id')).toBe(true);
      expect(setSecretCalls.some((c) => c.name === 'TS_OAUTH_SECRET' && c.value === 'scope-secret')).toBe(true);
    });

    it('a --secrets-file path that does not exist refuses loud, before the manifest is even parsed', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const code = await runBootstrapApply(
        { file, yes: true, secretsFilePath: join(dirname(file), 'does-not-exist.env') },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      );
      expect(code).toBe(1);
      expect(errs.join('\n')).toContain('does-not-exist.env');
    });

    it('a file with unknown extra keys is tolerated, not fatal', async () => {
      const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
      const secretsFile = writeSecretsFile(
        dirname(file),
        'SOME_UNKNOWN_FUTURE_KEY=whatever\nMACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=file-client-id\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=file-secret\n',
      );
      const code = await runBootstrapApply(
        { file, yes: true, deploy: false, secretsFilePath: secretsFile },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps(file, {
          resolvedTsOauth: { clientId: 'file-client-id', secret: 'file-secret' },
          routingSecretsDeps: fakeRoutingSecretsDeps({ checkRepoSecretPresence: async () => 'absent', setRepoSecret: async () => {} }),
        }),
      );
      expect(code).toBe(0);
    });

    it('NEVER logs a secret-file-sourced value anywhere in stdout/stderr (text AND --json)', async () => {
      const SENTINEL_CLIENT_ID = 'SENTINEL-1197-FILE-CLIENT-ID-MUST-NEVER-LEAK';
      const SENTINEL_SECRET = 'SENTINEL-1197-FILE-SECRET-MUST-NEVER-LEAK';
      for (const json of [false, true]) {
        const file = writeManifest(FLEET_YAML_WITH_TAILSCALE);
        const secretsFile = writeSecretsFile(dirname(file), `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=${SENTINEL_CLIENT_ID}\nMACF_BOOTSTRAP_TS_OAUTH_SECRET=${SENTINEL_SECRET}\n`);
        const code = await runBootstrapApply(
          { file, yes: true, json, deploy: false, secretsFilePath: secretsFile },
          { observe: () => Promise.resolve(EMPTY_OBSERVED) },
          fakeMutateDeps(file, {
            resolvedTsOauth: { clientId: SENTINEL_CLIENT_ID, secret: SENTINEL_SECRET },
            routingSecretsDeps: fakeRoutingSecretsDeps({ checkRepoSecretPresence: async () => 'absent', setRepoSecret: async () => {} }),
          }),
        );
        expect(code).toBe(0);
      }
      const all = [...logs, ...errs].join('\n');
      expect(all).not.toContain(SENTINEL_CLIENT_ID);
      expect(all).not.toContain(SENTINEL_SECRET);
    });
  });

  // --- macf#999 — `registry: { type: org }` is unsatisfiable with this
  // tool's current provisioning (no organization-scoped permission anywhere
  // in the manifest-building path); refuses BEFORE consent gate 1, same
  // shape as macf#932 immediately above. The decisive case: zero gate
  // invocations, not merely a non-zero exit code.

  describe('macf#999 — registry-scope pre-flight refusal before consent gate 1', () => {
    it('registry: { type: org } -> refuses BEFORE consent gate 1: observe/confirmPlan/buildAgentDeps/openUrl/startManifestFlow/confirmAppInstallation are ALL zero calls', async () => {
      const file = writeManifest(FLEET_YAML_WITH_ORG_REGISTRY);
      let observeCalls = 0;
      let confirmPlanCalls = 0;
      let buildAgentDepsCalls = 0;
      let openUrlCalls = 0;
      let startManifestFlowCalls = 0;
      let confirmAppInstallationCalls = 0;

      const code = await runBootstrapApply(
        { file, yes: true },
        {
          observe: () => {
            observeCalls += 1;
            return Promise.resolve(EMPTY_OBSERVED);
          },
        },
        fakeMutateDeps(file, {
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
      // Same discipline as the macf#932 test above: "never even asked the
      // operator to approve, never even read GitHub state, never opened a
      // browser." Each seam firing would mean the refusal arrived too late
      // — and would mean a later refactor moved this check after `observe`
      // without a test catching it.
      expect(observeCalls).toBe(0);
      expect(confirmPlanCalls).toBe(0);
      expect(buildAgentDepsCalls).toBe(0);
      expect(openUrlCalls).toBe(0);
      expect(startManifestFlowCalls).toBe(0);
      expect(confirmAppInstallationCalls).toBe(0);

      expect(errs.join('\n')).toContain('registry: { type: org, org: "demo-org" }');
      // Names the supported alternative plainly (task requirement 2) —
      // without asserting a resolution (#999 requirement 2 stays open).
      expect(errs.join('\n')).toContain('type: profile');
      expect(errs.join('\n')).toContain('is not yet decided');
      // Nothing mutated.
      const dir = join(file, '..');
      expect(existsSync(join(dir, 'fleet.lock'))).toBe(false);
      expect(existsSync(join(dir, 'secrets', 'vault.age'))).toBe(false);
    });

    it('the refusal is visible under --json too, never empty stdout (macf#830 lesson), and carries the registry_scope_unsatisfiable code', async () => {
      const file = writeManifest(FLEET_YAML_WITH_ORG_REGISTRY);
      const code = await runBootstrapApply({ file, yes: true, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(file));
      expect(code).toBe(1);
      expect(logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logs.join('\n')) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe(REGISTRY_SCOPE_UNSATISFIABLE_CODE);
      expect(parsed.error.message).toContain('type: profile');
    });

    it('--dry-run is ALSO refused (unlike macf#932s runner-token check) — mirrors checkAppNameLengths, not checkRunnerTokenPreflight: a dry-run render for an unsatisfiable registry would itself be misleading', async () => {
      const file = writeManifest(FLEET_YAML_WITH_ORG_REGISTRY);
      let observeCalls = 0;
      const code = await runBootstrapApply(
        { file, dryRun: true },
        {
          observe: () => {
            observeCalls += 1;
            return Promise.resolve(EMPTY_OBSERVED);
          },
        },
      );
      expect(code).toBe(1);
      expect(observeCalls).toBe(0);
      expect(errs.join('\n')).toContain('type: profile');
    });

    it('registry: { type: profile } (the FLEET_YAML default) is completely unaffected — proceeds exactly as every other test in this file', async () => {
      const file = writeManifest(); // FLEET_YAML default — type: profile
      const code = await runBootstrapApply({ file, dryRun: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) });
      expect(code).toBe(0);
      expect(errs.join('\n')).not.toContain(REGISTRY_SCOPE_UNSATISFIABLE_CODE);
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
    // NOT appear here; the routing update (diverging value, create-only
    // posture never overwrites) does. The warm posture is ALSO fully
    // implemented now (groundnuty/macf#943 — apply calls the runner-
    // provisioning contract), so it must NOT appear either.
    expect(out).not.toMatch(/\bca:/);
    expect(out).not.toMatch(/\brunner_warm:/);
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

  it('final summary (--yes, --json) carries unimplemented_by_apply with ONLY the diverging routing item (macf#838 Amendment D phase 2) — ca, repo, and runner_warm are NOT among them', async () => {
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
    const routingItem = parsed.unimplemented_by_apply.find((i) => i.kind === 'routing');
    expect(routingItem?.verb).toBe('update');
    // ca is fully implemented now (macf#838 Amendment D phase 2); repo has
    // been since macf#857; runner_warm has been since groundnuty/macf#943
    // (apply calls the runner-provisioning contract) — none appear here.
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'ca')).toBe(false);
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'repo')).toBe(false);
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'runner_warm')).toBe(false);
    expect(parsed.control_repo.status).toBe('created');
    expect(parsed.control_repo_sync.status).toBe('pushed');
    for (const item of parsed.unimplemented_by_apply) {
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });

  // --- DR-043 §D6 (this change) — versions steering. Same "the --yes
  // summary is the ONLY place an automated run sees the gap" contract the
  // routing tests above establish, now for a macf CLI version drift.

  it('final summary (--yes, non-json) no longer reports a macf version drift as NOT IMPLEMENTED BY APPLY — apply reconciles it (DR-043 Amendment L, macf#1045)', async () => {
    const file = writeManifest(FLEET_YAML_WITH_VERSIONS);
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(OBSERVED_VERSION_DRIFT), versionDeps: fakeVersionDeps() },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    // Neither versions.* kind is unimplemented anymore for 'version'
    // (macf#1045); 'actions_pin' was never unimplemented in this fixture
    // (observed pin already matches declared) — so the whole block is gone.
    expect(out).not.toMatch(/NOT IMPLEMENTED BY APPLY/);
    expect(out).not.toMatch(/\bversion:.*\(update\)/);
    expect(out).not.toMatch(/\bactions_pin:/);
    // groundnuty/macf#1053 — `fakeVersionDeps()` (`resolveDriver: async () =>
    // null`) is the UNREACHABLE fixture: the roll never found a local
    // workspace for this fleet, so it rolled ZERO agents. This USED to
    // render "completed toward macf@0.2.60" — indistinguishable from an
    // actual rollout (#1053's own live incident: agent uptimes never moved,
    // yet the summary said "completed"). The decisive assertion per
    // `assert-the-wrong-path.md`: the no-op line must NOT say "completed",
    // and must name why nothing was attempted.
    expect(out).not.toMatch(/Version reconcile: completed/);
    expect(out).toMatch(/Version reconcile: could not attempt toward macf@0\.2\.60 — no locally-discoverable workspace.*driver-unresolved/);
  });

  it('final summary (--yes, --json) carries version_phase (attempted + target), and unimplemented_by_apply no longer names the version kind (DR-043 Amendment L, macf#1045)', async () => {
    const file = writeManifest(FLEET_YAML_WITH_VERSIONS);
    const code = await runBootstrapApply(
      { file, yes: true, json: true },
      { observe: () => Promise.resolve(OBSERVED_VERSION_DRIFT), versionDeps: fakeVersionDeps() },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      unimplemented_by_apply: ReadonlyArray<{ kind: string; target: string; verb: string; reason: string }>;
      version_phase?: {
        target: string;
        halted: boolean;
        rolled_agents: readonly string[];
        unreachable: boolean;
        total_members: number;
        skip_breakdown: readonly string[];
        flagless?: boolean;
      };
    };
    // version is GONE from unimplemented_by_apply (macf#1045) — apply now
    // reconciles it; actions_pin was never present in this fixture either
    // way (observed pin already matches declared).
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'version')).toBe(false);
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'actions_pin')).toBe(false);
    // groundnuty/macf#1053 — same UNREACHABLE fixture as the non-json test
    // above: `--json` now carries the outcome as fields, not just prose —
    // `rolled_agents` is empty, `unreachable` is true, and `flagless` is
    // true (this test never passes --vault/--identity-key).
    expect(parsed.version_phase).toEqual({
      target: '0.2.60',
      halted: false,
      rolled_agents: [],
      unreachable: true,
      total_members: 0,
      skip_breakdown: [],
      flagless: true,
    });
  });

  // --- groundnuty/macf#1054 defect 2 — a runner-gate FAILURE must not
  // prevent phases that don't depend on it, at minimum the version phase.
  //
  // This pins a property that already holds in `applyFleet`/`runBootstrapApply`'s
  // control flow (a `'failed'` routing leg only logs and continues; the
  // version phase is gated on `controlRepoAborted || opts.deploy === false`,
  // never on the routing outcome) — turning an ACCIDENTAL non-gating
  // property into an ASSERTED one, so a future refactor that couples them
  // fails a test instead of silently reintroducing the block. Combined with
  // this issue's defect-1 fix (a confirmed 403 now fails in one `gh` call,
  // not after a 600s poll), this closes the practical "runner wait sits
  // ahead of the version phase" complaint the issue reports; a
  // *legitimately* still-polling (non-403) runner-gate remains a real,
  // separate, NOT-fixed-here sequencing delay — see the report for that
  // judgment call.
  it('groundnuty/macf#1054 defect 2 — a runner-gate FAILURE (confirmed 403, fails fast per defect 1) still lets the version-reconcile phase run + report; the routing failure is reported clearly, never silently swallowed', async () => {
    const file = writeManifest(FLEET_YAML_WITH_ROUTING_AND_VERSIONS);
    let sleepCalled = false;
    const code = await runBootstrapApply(
      { file, yes: true, json: true, runnerToken: SENTINEL_RUNNER_TOKEN },
      { observe: () => Promise.resolve(OBSERVED_ROUTING_AND_VERSION_DRIFT), versionDeps: fakeVersionDeps() },
      fakeMutateDeps(file, {
        trustDeps: fakeTrustDeps({
          checkRunnerUsableByRepo: async () => ({
            presence: 'unknown',
            permissionDenied: true,
            detail: 'could not read runners for "groundnuty/demo-code" — insufficient permission (HTTP 403; the App\'s installation token needs "administration: read"...)',
          }),
        }),
        // A sleepFn that fails the test if invoked — if defect 1's fail-fast
        // regressed, this run would try to poll and this would fire (or the
        // real 600s default would hang the test), not merely run slow.
        runnerTokenPollOptions: {
          sleepFn: async (ms) => {
            sleepCalled = true;
            throw new Error(`sleepFn must never be called on a confirmed 403 (asked to sleep ${String(ms)}ms)`);
          },
        },
      }),
    );
    // The routing gate failure alone must NOT fail exit code differently
    // than expected — applyExitCode's routingBad path makes a failed
    // routing leg non-zero-exit (groundnuty/macf#993), independent of the
    // version phase's own success.
    expect(code).not.toBe(0);
    expect(sleepCalled).toBe(false);
    const parsed = JSON.parse(logs.join('\n')) as {
      routing: Record<string, { status: string; reason?: string }>;
      version_phase?: { target: string; halted: boolean };
    };
    // The routing gate genuinely failed (not silently skipped, not
    // silently succeeded) — clearly reported with the permission cause.
    const routingLeg = parsed.routing['groundnuty/demo-code'];
    expect(routingLeg?.status).toBe('failed');
    expect(routingLeg?.reason).toContain('403');
    expect(routingLeg?.reason).toContain('FLEET authority, not agent authority');
    // DECISIVE — the version-reconcile phase STILL attempted + reported,
    // despite the routing gate having failed. Before this issue's fix this
    // would have been reached only after a 600s poll; the sleepFn assertion
    // above proves it was never even entered.
    // macf#1054 + macf#1055: assert the fields THIS test is about, not deep-equality
    // on the whole object — #1055 widened ApplyVersionPhaseResult with the
    // rolled/unreachable/skip discriminators, and a toEqual here couples this
    // routing test to that unrelated shape.
    expect(parsed.version_phase).toMatchObject({ target: '0.2.60', halted: false });
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

  /**
   * groundnuty/macf#954 — sibling of {@link vaultRawWithAgentPems} that ALSO
   * carries the runner-ops App's vault entry (`payload.runnerOps`, a
   * DIFFERENT vault namespace than `payload.agents` — see
   * `vault-write.ts::buildVaultPlaintext`'s `payload.runnerOps` branch doc).
   * Real write/parse round-trip, same discipline as the sibling above — the
   * key names are never hand-derived in the test.
   */
  function vaultRawWithAgentAndRunnerOpsPems(agentRoles: readonly string[], pem = SENTINEL_VAULT_PEM): Readonly<Record<string, string>> {
    const agents: VaultAgentSecrets[] = agentRoles.map((role) => ({
      appHandle: `demo-fleet-${role}`,
      appId: '111',
      installId: '222',
      clientId: 'Iv1.abc',
      clientSecret: 'not-under-test',
      webhookSecret: 'not-under-test',
      pem,
    }));
    const runnerOps: VaultRunnerOpsSecrets = {
      appHandle: deriveRunnerOpsHandle('demo-fleet'),
      appId: '999',
      installId: '998',
      clientId: 'Iv1.runner-ops',
      clientSecret: 'not-under-test',
      webhookSecret: 'not-under-test',
      pem,
    };
    return parseVaultPlaintext(buildVaultPlaintext({ agents, runnerOps }));
  }

  /**
   * groundnuty/macf#1074 — sibling of {@link vaultRawWithAgentAndRunnerOpsPems}
   * that ALSO carries the router App's vault entry (`payload.routingApp`,
   * the SAME "reopened gap #954 already closed for runner-ops" reasoning —
   * see `resolveVaultAgentPems`'s router-App explicit-lookup comment).
   */
  function vaultRawWithAgentRunnerOpsAndRouterPems(agentRoles: readonly string[], pem = SENTINEL_VAULT_PEM): Readonly<Record<string, string>> {
    const agents: VaultAgentSecrets[] = agentRoles.map((role) => ({
      appHandle: `demo-fleet-${role}`,
      appId: '111',
      installId: '222',
      clientId: 'Iv1.abc',
      clientSecret: 'not-under-test',
      webhookSecret: 'not-under-test',
      pem,
    }));
    const runnerOps: VaultRunnerOpsSecrets = {
      appHandle: deriveRunnerOpsHandle('demo-fleet'),
      appId: '999',
      installId: '998',
      clientId: 'Iv1.runner-ops',
      clientSecret: 'not-under-test',
      webhookSecret: 'not-under-test',
      pem,
    };
    return parseVaultPlaintext(buildVaultPlaintext({ agents, runnerOps, routingApp: { appId: '997', appKeyPem: pem } }));
  }

  // --- groundnuty/macf#954 — the runner-ops vault-confirm reach gap ---
  //
  // `resolveVaultAgentPems` used to loop ONLY `manifest.agents` — which
  // structurally never contains `'runner-ops'` (a fleet-level identity, never
  // declared there; `apply-runner-ops.ts`'s module doc) — so the returned map
  // could NEVER carry a runner-ops PEM regardless of what the vault actually
  // held. The sibling test at "with identity + an existing App recorded..."
  // above ALREADY covers runner-ops, but ONLY via a hand-rolled
  // `resolveKeyPath: (role) => ...` stand-in that answers for ANY role — its
  // own comment names this explicitly as a work-around for the REAL
  // `resolveMutateDeps`-derived one "which only ever resolves a PEM for a
  // DECLARED agent." These tests exercise the REAL, FIXED wiring instead.

  it('resolveVaultAgentPems (macf#954): the returned map includes a runner-ops PEM when the vault carries one — NOT gated on manifest.agents[] (the fixture declares only 2 agents, never runner-ops)', async () => {
    const manifest = parseFleetManifest(FLEET_YAML);
    const raw = vaultRawWithAgentAndRunnerOpsPems(['code-agent', 'science-agent']);
    const pems = await resolveVaultAgentPems(
      manifest,
      { vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
      async () => raw,
      () => {},
    );
    expect(pems?.get('code-agent')).toBe(SENTINEL_VAULT_PEM);
    expect(pems?.get('science-agent')).toBe(SENTINEL_VAULT_PEM);
    expect(pems?.get(RUNNER_OPS_ROLE)).toBe(SENTINEL_VAULT_PEM);
  });

  it('resolveVaultAgentPems: a vault with NO runner-ops entry -> the map has no runner-ops key (never fabricates one)', async () => {
    const manifest = parseFleetManifest(FLEET_YAML);
    const raw = vaultRawWithAgentPems(['code-agent', 'science-agent']); // no `runnerOps` payload at all
    const pems = await resolveVaultAgentPems(
      manifest,
      { vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
      async () => raw,
      () => {},
    );
    expect(pems?.has(RUNNER_OPS_ROLE)).toBe(false);
    expect(pems?.get('code-agent')).toBe(SENTINEL_VAULT_PEM); // sibling roles unaffected
  });

  it('with BOTH flags + fleet.lock entries for every role, the REAL resolveMutateDeps-derived resolveKeyPath (built from resolveVaultAgentPems\'s fixed output) resolves runner-ops too -> CONFIRMED, REUSED, gate 1 seam NEVER called for ANY role (macf#954 — not the hand-rolled any-role stand-in the sibling test above uses)', async () => {
    const file = writeManifest();
    const manifest = parseFleetManifest(FLEET_YAML);
    const priorLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
        { role: 'runner-ops', app_id: 'app-runner-ops', install_id: 'install-3' },
        // groundnuty/macf#1074 — the router App gets the SAME treatment.
        { role: 'router', app_id: 'app-router', install_id: 'install-4' },
      ],
    };
    const raw = vaultRawWithAgentRunnerOpsAndRouterPems(['code-agent', 'science-agent']);
    const vaultAgentPems = await resolveVaultAgentPems(
      manifest,
      { vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
      async () => raw,
      () => {},
    );
    expect(vaultAgentPems?.has(RUNNER_OPS_ROLE)).toBe(true); // the fix under test
    expect(vaultAgentPems?.has(ROUTER_APP_ROLE)).toBe(true); // groundnuty/macf#1074 — the SAME fix, reopened for the router App

    // The REAL resolveMutateDeps-built resolveKeyPath closure — extracted
    // once, never a hand-rolled `(role) => ...` any-role stand-in.
    const realMutate = resolveMutateDeps(file, vaultAgentPems, SENTINEL_RUNNER_TOKEN);
    const realResolveKeyPath = realMutate.buildAgentDeps(() => {}).resolveKeyPath;

    let startManifestFlowCalled = false;
    const installIdForAppId = (appId: string): string =>
      appId === 'app-code-agent' ? 'install-1' : appId === 'app-science-agent' ? 'install-2' : appId === 'app-runner-ops' ? 'install-3' : 'install-4';

    const code = await runBootstrapApply(
      // macf#1013 — deploy:false: this test is about macf#954's vault-aware
      // confirm-before-create wiring, not the (later) default deploy phase;
      // decoupling keeps it hermetic (this fixture's `deploy_path`s are
      // real-looking absolute paths, never a scratch dir — see
      // `BootstrapApplyDeps.deployDeps`'s own doc for why that's deliberate).
      { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt', deploy: false },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), readVault: async () => raw },
      fakeMutateDeps(file, {
        // Cleans up the REAL scratch-PEM dir `realResolveKeyPath` writes into
        // (mirrors runBootstrapApply's own `finally { mutate.cleanupVaultScratch?.() }`
        // contract — see resolveMutateDeps's doc).
        cleanupVaultScratch: realMutate.cleanupVaultScratch,
        // groundnuty/macf#1074 — the router App is REUSED (a prior lock
        // entry above), so its MACF_ROUTING_APP_ID/KEY publish resolves via
        // vault-restore, not fresh-creation credentials. Wired against the
        // SAME `raw` vault map this test's `readVault` already returns —
        // the real read-side primitives, not a stand-in.
        routerAppVaultDeps: {
          readVaultRouterApp: async () => {
            const appId = vaultRouterAppId(raw);
            const appKeyPem = vaultRouterAppKeyPem(raw);
            return appId !== undefined && appKeyPem !== undefined ? { appId, appKeyPem } : undefined;
          },
        },
        buildAgentDeps: () =>
          fakeAgentDeps({
            resolveKeyPath: realResolveKeyPath,
            confirmAppInstallation: async (appId) => ({
              status: 'confirmed',
              install: { appId, installId: installIdForAppId(appId), appSlug: '', accountLogin: 'groundnuty' },
            }),
            startManifestFlow: async () => {
              startManifestFlowCalled = true;
              throw new Error('must not be called — a CONFIRMED App must skip consent gate 1 entirely (macf#954)');
            },
          }),
        controlRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: false }),
          readManifestFile: async () => FLEET_YAML,
          createRepo: async () => {
            throw new Error('must not be called — reuse never creates');
          },
          unarchiveRepo: async () => {
            throw new Error('must not be called');
          },
          cloneRepo: async (_url, destDir) => {
            writeFileSync(join(destDir, 'fleet.lock'), JSON.stringify(priorLock), 'utf-8');
          },
          commitAndPush: async () => 'nothing-to-commit',
        },
      }),
    );
    expect(code).toBe(0);
    expect(startManifestFlowCalled).toBe(false); // gate 1 seam never even invoked, for ANY role
    const out = logs.join('\n');
    expect(out).toMatch(/code-agent: REUSED/);
    expect(out).toMatch(/science-agent: REUSED/);
    // groundnuty/macf#1083 — `FLEET_YAML` declares no self-hosted routing, so
    // the runner-ops entry in `priorLock` is an ORPHAN: apply's identity
    // ceremony is skipped entirely for it (never confirmed, never reused —
    // consistent with `startManifestFlowCalled` staying false for EVERY role,
    // asserted above, which this orphan path satisfies even more directly
    // than a genuine reuse would).
    expect(out).toMatch(/runner-ops: NOT NEEDED/);
    expect(out).not.toMatch(/runner-ops: SKIPPED/);
  });

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
      // macf#1013 — deploy:false, see the sibling test above's comment.
      { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt', deploy: false },
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
        // groundnuty/macf#1074 — the router App gets the SAME treatment as
        // runner-ops immediately above: a prior lock entry so it too takes
        // the REUSE path, not CREATE.
        { role: 'router', app_id: 'app-router', install_id: 'install-4' },
      ],
    };
    let startManifestFlowCalled = false;
    const code = await runBootstrapApply(
      // macf#1013 — deploy:false, see the sibling test above's comment.
      { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt', deploy: false },
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
            // covers the runner-ops + router (groundnuty/macf#943,
            // groundnuty/macf#1074) — this raw override answers for ANY
            // role, unlike the real `resolveMutateDeps`'s vault-derived one
            // (which only ever resolves a PEM for a DECLARED agent — see
            // that function's doc).
            resolveKeyPath: (role) => `/fake/${role}.pem`,
            confirmAppInstallation: async (appId) => ({
              status: 'confirmed',
              install: {
                appId,
                installId: appId === 'app-code-agent' ? 'install-1' : appId === 'app-science-agent' ? 'install-2' : appId === 'app-runner-ops' ? 'install-3' : 'install-4',
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
        // groundnuty/macf#1074 — this test's focus is the vault-aware
        // confirm-before-create gate skip, not the routing-secrets publish
        // (the router App is REUSED with no vault-restore wired here, so
        // its own MACF_ROUTING_APP_ID/KEY would otherwise report an
        // UNRELATED 'failed' leg and contaminate this test's exit-code
        // assertion — same fix as apply-fleet.test.ts's "deactivate-shaped
        // state" test).
        routingSecretsDeps: fakeRoutingSecretsDeps({ checkRepoSecretPresence: async () => 'present' }),
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
        // macf#1013 — deploy:false: this test is specifically about the
        // vault-aware CONFIRM PREVIEW degrading gracefully on a bad
        // identity key; the deploy phase would ALSO (correctly) fail loud
        // on the same bad key, which is a distinct, separately-tested
        // concern (see the "deploy phase" describe block below).
        { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/wrong-identity.txt', deploy: false },
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
        // groundnuty/macf#1074 — the router App gets the SAME treatment.
        { role: 'router', app_id: 'app-router', install_id: 'install-4' },
      ],
    };
    let unarchiveCalled = false;
    let startManifestFlowCalled = false;
    const code = await runBootstrapApply(
      // macf#1013 — deploy:false, see the sibling test above's comment
      // ("with identity + an existing App recorded..."): this test is about
      // the revival wiring, not the default deploy phase.
      { file, yes: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt', deploy: false },
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
                installId: appId === 'app-code-agent' ? 'install-1' : appId === 'app-science-agent' ? 'install-2' : appId === 'app-runner-ops' ? 'install-3' : 'install-4',
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
        // groundnuty/macf#1074 — see the identical comment on the sibling
        // "existing App recorded" test above: this test's focus is
        // revival, not routing-secrets specifics.
        routingSecretsDeps: fakeRoutingSecretsDeps({ checkRepoSecretPresence: async () => 'present' }),
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

  // --- Operator interaction budget (groundnuty/macf#880) ---
  //
  // Anchored on `displayCreations.length` (the SAME vault-aware-filtered
  // list `formatPlannedAppCreations` already renders — see that function's
  // doc), not `plan.items` directly: `bootstrap-apply.ts`'s own `plan` is
  // ALWAYS built from the non-vault-aware `githubRegistryObserver`
  // (`resolved.observe` defaults to it unconditionally), so `plan.items`
  // never reflects a vault-confirmed reuse — only `displayCreations` does.
  // Using `plan.items` here would print an overstated number on exactly the
  // run that matters most (archive→revive, macf#913/#915's zero-click
  // property).
  describe('operator interaction budget (groundnuty/macf#880)', () => {
    // --- resume-install: gate 1 is SKIPPED but gate 2 STILL RUNS ---
    //
    // `filterCreationsByPreview` drops every non-'create' decision —
    // correctly, for GATE 1. But `apply-agent.ts::runGate2WithInterstitial`
    // is "called for BOTH the create path and the resume-install path —
    // every gate-2 run gets an interstitial, regardless of how gate 2 was
    // reached." A role whose preview decision is 'resume-install' (App
    // confirmed live, ZERO installs) is therefore dropped from
    // `displayCreations` (gate 1 correctly excluded) but STILL costs one
    // gate-2 install flow — a gate-1-only count would silently drop it,
    // which is exactly the false-"none" regression these two tests pin.

    it('DECISIVE — every role resume-install (gate1=0, gate2>0): NEVER "none" — a fleet needing ONLY install flows is not zero-click', async () => {
      const file = writeManifest();
      const observedWithLock: ObservedState = {
        lock: {
          schema_version: 1,
          fleet: 'demo-fleet',
          agents: [
            { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
            { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
            { role: RUNNER_OPS_ROLE, app_id: 'app-runner-ops', install_id: 'install-3' },
            // groundnuty/macf#1105 — the router App is UNCONDITIONAL; a
            // lock entry here keeps this test isolated to its actual point
            // (agent resume-install semantics), not a router_app create.
            { role: 'router', app_id: 'app-router', install_id: 'install-4' },
          ],
        },
        // Empty, same as the fully-provisioned tests below — plan.items
        // shows every agent app as a create-candidate; ONLY the vault-aware
        // preview (via `lock` above) resolves the real decision.
        agents: {},
        caRegistry: 'present',
        caRepos: {},
        controlRepoPresence: 'present',
      };
      const code = await runBootstrapApply(
        { file, dryRun: true, json: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
        {
          observe: () => Promise.resolve(observedWithLock),
          readVault: async () => vaultRawWithAgentAndRunnerOpsPems(['code-agent', 'science-agent']),
          // BOTH agents confirmed live with ZERO installs — 'resume-install'
          // for both, per `confirmBeforeCreateGuard`'s `'app-no-install'`
          // switch arm. Runner-ops never reaches this fake at all (its
          // plan-level item is already noop via the lock entry above; see
          // `countResumeInstallFlows`'s doc for why the preview never even
          // loops it).
          confirmAppInstallation: async () => ({ status: 'app-no-install' }),
        },
      );
      expect(code).toBe(0);
      const json = JSON.parse(logs.join('')) as {
        planned_app_creations: readonly unknown[];
        operator_interaction: { gate1_clicks: number; gate2_flows: number; bound: string };
      };
      expect(json.planned_app_creations).toEqual([]); // gate 1 correctly empty — both roles' Apps already exist
      // ...but gate 2 is NOT empty: both roles still need their install flow.
      expect(json.operator_interaction).toEqual({ gate1_clicks: 0, gate2_flows: 2, bound: 'maximum' });
      const out = logs.join('\n');
      expect(out).not.toContain('Operator interaction: none — no consent gates this run.');
    });

    it('DECISIVE — one create + one resume-install: gate1_clicks !== gate2_flows, text names both counts directly (never "Apps to create")', async () => {
      const file = writeManifest();
      const observedWithLock: ObservedState = {
        lock: {
          schema_version: 1,
          fleet: 'demo-fleet',
          // ONLY code-agent has a prior lock entry — science-agent is a
          // genuine first-time create-candidate; runner-ops noop as usual.
          // groundnuty/macf#1105 — router App noop too (UNCONDITIONAL; a
          // lock entry keeps this test isolated to its actual point).
          agents: [
            { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
            { role: RUNNER_OPS_ROLE, app_id: 'app-runner-ops', install_id: 'install-3' },
            { role: 'router', app_id: 'app-router', install_id: 'install-4' },
          ],
        },
        agents: {},
        caRegistry: 'present',
        caRepos: {},
        controlRepoPresence: 'present',
      };
      const code = await runBootstrapApply(
        { file, dryRun: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
        {
          observe: () => Promise.resolve(observedWithLock),
          readVault: async () => vaultRawWithAgentAndRunnerOpsPems(['code-agent']),
          confirmAppInstallation: async () => ({ status: 'app-no-install' }), // code-agent -> resume-install
        },
      );
      expect(code).toBe(0);
      const out = logs.join('\n');
      // code-agent RESUMEs (gate 1 skipped, gate 2 still runs); science-agent
      // has no prior lock entry at all -> genuine CREATE (both gates).
      expect(out).toMatch(/code-agent: RESUME INSTALL/);
      expect(out).toMatch(/demo-fleet-science-agent\s+\(role: science-agent/); // still in "would be created"
      expect(out).not.toMatch(/demo-fleet-code-agent\s+\(role: code-agent/); // dropped — gate 1 will NOT open
      expect(out).toContain('up to 1 "Create GitHub App" click');
      expect(out).toContain('up to 2 install flows');
      expect(out).toContain('1 already-created App still needs its install flow');
    });

    it('DECISIVE — fresh 2-agent HOSTED-runner fleet (FLEET_YAML declares no routing:), --dry-run, no vault flags: 2 agent Apps + the UNCONDITIONAL router App (groundnuty/macf#1105), NO runner-ops (groundnuty/macf#1083) -> honest maximum of 6 total consent-gate clicks (3 gate-1 + 3 gate-2)', async () => {
      const file = writeManifest();
      const code = await runBootstrapApply({ file, dryRun: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) });
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toMatch(/Operator interaction: up to 3 Apps to create/);
      expect(out).toContain('3 "Create GitHub App" clicks');
      expect(out).toContain('3 install flows');
      expect(out).toContain('may confirm some of these already exist and skip their gates');
      // Set membership, not just arithmetic — the App-creation set genuinely
      // excludes runner-ops, never merely happens to count to 3.
      expect(out).not.toMatch(/runner-ops/);
    });

    it('DECISIVE non-regression — the SAME fresh 2-agent fleet, but SELF-HOSTED declared (FLEET_YAML_WITH_ROUTING): 4 Apps to create (2 agents + runner-ops + router App) -> honest maximum of 8 total consent-gate clicks (4 gate-1 + 4 gate-2)', async () => {
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, dryRun: true, runnerToken: SENTINEL_RUNNER_TOKEN },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      );
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toMatch(/Operator interaction: up to 4 Apps to create/);
      expect(out).toContain('4 "Create GitHub App" clicks');
      expect(out).toContain('4 install flows');
      expect(out).toContain('may confirm some of these already exist and skip their gates');
    });

    it('DECISIVE — fresh 2-agent HOSTED-runner fleet, --dry-run --json: operator_interaction carries gate1_clicks/gate2_flows both = 3 (2 agent Apps + the UNCONDITIONAL router App, groundnuty/macf#1105; no runner-ops, groundnuty/macf#1083), bound "maximum"', async () => {
      const file = writeManifest();
      const code = await runBootstrapApply({ file, dryRun: true, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) });
      expect(code).toBe(0);
      const json = JSON.parse(logs.join('')) as {
        operator_interaction: { gate1_clicks: number; gate2_flows: number; bound: string };
      };
      expect(json.operator_interaction).toEqual({ gate1_clicks: 3, gate2_flows: 3, bound: 'maximum' });
    });

    it('DECISIVE non-regression — the SAME fresh fleet, but SELF-HOSTED declared, --dry-run --json: operator_interaction carries gate1_clicks/gate2_flows both = 4 (2 declared agents + the now-needed runner-ops + the router App), bound "maximum"', async () => {
      const file = writeManifest(FLEET_YAML_WITH_ROUTING);
      const code = await runBootstrapApply(
        { file, dryRun: true, json: true, runnerToken: SENTINEL_RUNNER_TOKEN },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      );
      expect(code).toBe(0);
      const json = JSON.parse(logs.join('')) as {
        operator_interaction: { gate1_clicks: number; gate2_flows: number; bound: string };
      };
      expect(json.operator_interaction).toEqual({ gate1_clicks: 4, gate2_flows: 4, bound: 'maximum' });
    });

    it('adding one agent to an already-provisioned fleet (2 existing confirmed via vault, 1 new): budget is 2 clicks (1 App)', async () => {
      const file = writeManifest(
        FLEET_YAML.replace(
          '  - role: science-agent',
          '  - role: new-agent\n    profile: code\n    repo: groundnuty/demo-new-agent\n    deploy_path: /home/ubuntu/repos/demo-new-agent\n  - role: science-agent',
        ),
      );
      const observedWithLock: ObservedState = {
        lock: {
          schema_version: 1,
          fleet: 'demo-fleet',
          agents: [
            { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
            { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
            { role: RUNNER_OPS_ROLE, app_id: 'app-runner-ops', install_id: 'install-3' },
            // groundnuty/macf#1105 — router App noop too (UNCONDITIONAL; a
            // lock entry keeps this test isolated to its actual point: the
            // ONE new agent's click cost).
            { role: 'router', app_id: 'app-router', install_id: 'install-4' },
          ],
        },
        agents: {},
        caRegistry: 'present',
        caRepos: {},
        controlRepoPresence: 'present',
      };
      const code = await runBootstrapApply(
        { file, dryRun: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
        {
          observe: () => Promise.resolve(observedWithLock),
          readVault: async () => vaultRawWithAgentAndRunnerOpsPems(['code-agent', 'science-agent']),
          confirmAppInstallation: async (appId) => ({
            status: 'confirmed',
            install: {
              appId,
              installId: appId === 'app-code-agent' ? 'install-1' : appId === 'app-science-agent' ? 'install-2' : 'install-3',
              appSlug: '',
              accountLogin: 'groundnuty',
            },
          }),
        },
      );
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toMatch(/code-agent: REUSE/);
      expect(out).toMatch(/science-agent: REUSE/);
      expect(out).toMatch(/Operator interaction: up to 1 App to create/);
      expect(out).toContain('1 "Create GitHub App" click ');
      expect(out).toContain('1 install flow (');
    });

    // groundnuty/macf#880 — a PRODUCTION-shape zero test. `githubRegistryObserver`
    // derives `observed.agents[role].app` FROM `lock` (`lockEntry ? 'present'
    // : 'unknown'` — `observer.ts`), so a lock populated with `agents: {}`
    // (the shape the tests below this one use) is unreachable from the real
    // observer: where the lock has an entry, `observed.agents` reports
    // 'present' too. This test uses that PRODUCTION-REACHABLE shape — no
    // vault flags needed at all, since `plan.items` itself already shows
    // every app/runner_ops item as noop.
    it('a fully-provisioned fleet, PRODUCTION shape (observed.agents populated, no vault flags): "none — no consent gates this run"', async () => {
      const file = writeManifest();
      const observedProduction: ObservedState = {
        lock: {
          schema_version: 1,
          fleet: 'demo-fleet',
          agents: [
            { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
            { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
            { role: RUNNER_OPS_ROLE, app_id: 'app-runner-ops', install_id: 'install-3' },
            // groundnuty/macf#1105 — the router App is UNCONDITIONAL; without
            // this entry it would be the one remaining create-candidate.
            { role: 'router', app_id: 'app-router', install_id: 'install-4' },
          ],
        },
        agents: {
          'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
          'science-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
        },
        caRegistry: 'present',
        caRepos: {},
        controlRepoPresence: 'present',
      };
      const code = await runBootstrapApply({ file, dryRun: true, json: true }, { observe: () => Promise.resolve(observedProduction) });
      expect(code).toBe(0);
      const json = JSON.parse(logs.join('')) as {
        planned_app_creations: readonly unknown[];
        operator_interaction: { gate1_clicks: number; gate2_flows: number; bound: string };
      };
      expect(json.planned_app_creations).toEqual([]);
      expect(json.operator_interaction).toEqual({ gate1_clicks: 0, gate2_flows: 0, bound: 'exact' });
    });

    // NOTE — this test's `observe` fake (`agents: {}` + a populated `lock`)
    // is a shape the REAL `githubRegistryObserver` cannot emit (it derives
    // `observed.agents[role].app` FROM `lock` — see `observer.ts` — so a
    // populated lock always implies 'present' agents too). It exists to
    // isolate ONE thing: does the budget line track `displayCreations`
    // (post vault-preview) rather than `plan.items` (pre-preview)? The
    // PRODUCTION-reachable zero-click shape is the "PRODUCTION shape" test
    // above this one (no vault flags needed — plan.items alone is already
    // all-noop). This test's value is the wiring proof, not the "does a
    // real fleet reach zero via vault flags" claim.
    it('DECISIVE — a fully-provisioned fleet WITH --vault/--identity-key: every App (agents + runner-ops) confirmed REUSED -> "none — no consent gates this run", stated explicitly', async () => {
      const file = writeManifest();
      const observedWithLock: ObservedState = {
        lock: {
          schema_version: 1,
          fleet: 'demo-fleet',
          agents: [
            { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
            { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
            { role: RUNNER_OPS_ROLE, app_id: 'app-runner-ops', install_id: 'install-3' },
            // groundnuty/macf#1105 — the router App is UNCONDITIONAL; without
            // this entry it would be the one remaining create-candidate.
            { role: 'router', app_id: 'app-router', install_id: 'install-4' },
          ],
        },
        // Deliberately EMPTY — see the NOTE above this test.
        agents: {},
        caRegistry: 'present',
        caRepos: {},
        controlRepoPresence: 'present',
      };
      const code = await runBootstrapApply(
        { file, dryRun: true, json: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
        {
          observe: () => Promise.resolve(observedWithLock),
          readVault: async () => vaultRawWithAgentAndRunnerOpsPems(['code-agent', 'science-agent']),
          confirmAppInstallation: async (appId) => ({
            status: 'confirmed',
            install: {
              appId,
              installId: appId === 'app-code-agent' ? 'install-1' : appId === 'app-science-agent' ? 'install-2' : 'install-3',
              appSlug: '',
              accountLogin: 'groundnuty',
            },
          }),
        },
      );
      expect(code).toBe(0);
      const json = JSON.parse(logs.join('')) as {
        planned_app_creations: readonly unknown[];
        operator_interaction: { gate1_clicks: number; gate2_flows: number; bound: string };
      };
      expect(json.planned_app_creations).toEqual([]); // every role REUSED, none left "would be created"
      expect(json.operator_interaction).toEqual({ gate1_clicks: 0, gate2_flows: 0, bound: 'exact' });
    });

    it('DECISIVE — the SAME fully-provisioned fixture, plain text, non-json: "Operator interaction: none — no consent gates this run." stated explicitly, not silently omitted', async () => {
      const file = writeManifest();
      const observedWithLock: ObservedState = {
        lock: {
          schema_version: 1,
          fleet: 'demo-fleet',
          agents: [
            { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
            { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
            { role: RUNNER_OPS_ROLE, app_id: 'app-runner-ops', install_id: 'install-3' },
            // groundnuty/macf#1105 — the router App is UNCONDITIONAL; without
            // this entry it would be the one remaining create-candidate.
            { role: 'router', app_id: 'app-router', install_id: 'install-4' },
          ],
        },
        agents: {},
        caRegistry: 'present',
        caRepos: {},
        controlRepoPresence: 'present',
      };
      const code = await runBootstrapApply(
        { file, dryRun: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
        {
          observe: () => Promise.resolve(observedWithLock),
          readVault: async () => vaultRawWithAgentAndRunnerOpsPems(['code-agent', 'science-agent']),
          confirmAppInstallation: async (appId) => ({
            status: 'confirmed',
            install: {
              appId,
              installId: appId === 'app-code-agent' ? 'install-1' : appId === 'app-science-agent' ? 'install-2' : 'install-3',
              appSlug: '',
              accountLogin: 'groundnuty',
            },
          }),
        },
      );
      expect(code).toBe(0);
      expect(logs.join('\n')).toContain('Operator interaction: none — no consent gates this run.');
    });

    it('the REAL (non-dry-run) pre-approval render carries the identical budget line on stderr — same formatPlannedAppCreations call site', async () => {
      // The pre-approval render uses `process.stderr.write` directly (never
      // `console.error`), same channel `resolveMutateDeps`'s `log` field
      // uses — see the existing "decrypt failure" test above for the same
      // spy pattern.
      const file = writeManifest();
      const rawWrites: string[] = [];
      const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        rawWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      });
      let code: number;
      try {
        code = await runBootstrapApply(
          { file, yes: true, deploy: false },
          { observe: () => Promise.resolve(EMPTY_OBSERVED) },
          fakeMutateDeps(file),
        );
      } finally {
        writeSpy.mockRestore();
      }
      expect(code).toBe(0);
      // groundnuty/macf#1083 — `FLEET_YAML` declares no self-hosted routing:
      // no runner-ops. groundnuty/macf#1105 — the router App IS always a
      // create-candidate (UNCONDITIONAL): 2 agent Apps + 1 router App = 3.
      expect(rawWrites.join('')).toMatch(/Operator interaction: up to 3 Apps to create/);
    });
  });
});

// --- runBootstrapApply — remaining-deploy honest completion (macf#1014) ---
//
// `FLEET_YAML`'s two agents deploy_path to `/home/ubuntu/repos/demo-code`
// and `/home/ubuntu/repos/demo-science` — real-looking absolute paths this
// suite must NEVER depend on the actual host filesystem for (that would make
// these tests non-deterministic across machines/CI). Every test here injects
// `checkDeployPathExists` explicitly instead of relying on `BootstrapApplyDeps`'s
// real `existsSync` default (`remaining-deploy.ts::computeRemainingDeploy`'s
// own doc: `apply`'s wiring only falls back to a real fs probe when the CLI
// caller supplies no `deps` at all — a case this suite never exercises).
describe('runBootstrapApply — remaining-deploy honest completion (macf#1014)', () => {
  const dirs: string[] = [];
  let logs: string[];
  let errs: string[];
  const DEMO_CODE_PATH = '/home/ubuntu/repos/demo-code';
  const DEMO_SCIENCE_PATH = '/home/ubuntu/repos/demo-science';
  const DEMO_REPOS_PARENT = '/home/ubuntu/repos';

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errs.push(a.join(' ')));
    const recoverySafetyDir = mkdtempSync(join(tmpdir(), 'macf-apply-remaining-deploy-recovery-safety-'));
    dirs.push(recoverySafetyDir);
    vi.stubEnv('MACF_RECOVERY_DIR', recoverySafetyDir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeManifest(body = FLEET_YAML): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-apply-remaining-deploy-test-'));
    dirs.push(dir);
    const p = join(dir, 'fleet.yaml');
    writeFileSync(p, body);
    return p;
  }

  it('the decisive case: a fleet with no workspaces names EVERY agent + a copy-pasteable command per agent (not merely "some text was printed")', async () => {
    const file = writeManifest();
    // Parent (/home/ubuntu/repos) exists on this fake fs, neither leaf does
    // — the realistic "operator's workspaces tree exists, nothing deployed
    // into it yet" shape (`computeRemainingDeploy`'s `not-deployed` case).
    const checkDeployPathExists = (p: string): boolean => p === DEMO_REPOS_PARENT;
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('code-agent: NOT DEPLOYED');
    expect(out).toContain('science-agent: NOT DEPLOYED');
    // The DECISIVE assertion: an exact, copy-pasteable command naming the
    // SPECIFIC agent + manifest path — not merely that some warning text
    // was printed.
    expect(out).toContain(`macf fleet deploy --agent code-agent -f ${file} --identity-key PATH_TO_YOUR_AGE_IDENTITY_KEY`);
    expect(out).toContain(`macf fleet deploy --agent science-agent -f ${file} --identity-key PATH_TO_YOUR_AGE_IDENTITY_KEY`);
    // The --vault-omitted precondition note (review finding): the operator
    // must know the constructed commands' default --vault resolution only
    // works from a local clone of the fleet's OWN control repo.
    expect(out).toContain('demo-fleet-control');
    expect(out).toContain('git pull');
  });

  it('groundnuty/macf#1212 — the real runBootstrapApply entrypoint (not just the pure formatApplyResult unit) prints "confirm the fleet is green" BEFORE the per-agent deploy commands, echoing the SAME -f path apply itself was invoked with', async () => {
    const file = writeManifest();
    const checkDeployPathExists = (p: string): boolean => p === DEMO_REPOS_PARENT;
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain(`macf bootstrap status -f ${file}`);
    const statusIdx = out.indexOf('confirm the fleet is green');
    const deployIdx = out.indexOf('macf fleet deploy --agent code-agent');
    expect(statusIdx).toBeGreaterThan(-1);
    expect(deployIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeLessThan(deployIdx);
  });

  it('echoes the --vault/--identity-key flags apply was ITSELF invoked with into every deploy command, and OMITS the vault-location note', async () => {
    const file = writeManifest();
    const checkDeployPathExists = (p: string): boolean => p === DEMO_REPOS_PARENT;
    const code = await runBootstrapApply(
      // macf#1013 — deploy:false: this test is about `remaining-deploy.ts`'s
      // OWN flag-echoing behavior (macf#1014), independent of whether the
      // NEW default deploy phase (macf#1013) itself ran; a real vault path
      // here would make the deploy phase attempt a real decrypt.
      { file, yes: true, vaultPath: '/fake/secrets/vault.age', identityKeyPath: '/home/op/age-identity.txt', deploy: false },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain(
      `macf fleet deploy --agent code-agent -f ${file} --vault /fake/secrets/vault.age --identity-key /home/op/age-identity.txt`,
    );
    // The operator already gave a real --vault — no precondition note needed
    // (the bare "demo-fleet-control" repo name legitimately appears in the
    // unrelated "Control repo: CREATED ..." line above; assert against the
    // note's distinctive phrasing instead).
    expect(out).not.toContain('these commands omit --vault');
    expect(out).not.toContain('git pull');
  });

  it('a deploy_path not resolvable locally (parent ALSO absent) is reported as UNKNOWN, never NOT DEPLOYED', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists: () => false },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('code-agent: UNKNOWN');
    expect(out).toContain('science-agent: UNKNOWN');
    expect(out).not.toContain('NOT DEPLOYED');
    expect(out).toContain('multi-host fleet');
  });

  it('a fully-deployed fleet reports NOTHING remaining — no nagging on a re-run', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists: () => true },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).not.toContain('NOT DEPLOYED');
    expect(out).not.toContain('UNKNOWN');
    expect(out).not.toContain('macf fleet deploy');
    expect(out).not.toContain('macf#1014');
  });

  it('exit code is UNCHANGED by deploy presence — an undeployed fleet still exits 0 on a successful apply', async () => {
    const file = writeManifest();
    const codeAllMissing = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists: () => false },
      fakeMutateDeps(file),
    );
    expect(codeAllMissing).toBe(0);

    const file2 = writeManifest();
    const codeAllPresent = await runBootstrapApply(
      { file: file2, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists: () => true },
      fakeMutateDeps(file2),
    );
    expect(codeAllPresent).toBe(0);
    expect(codeAllMissing).toBe(codeAllPresent);
  });

  it('--json carries the same remaining_deploy facts the human-readable text shows', async () => {
    const file = writeManifest();
    const checkDeployPathExists = (p: string): boolean => p === DEMO_REPOS_PARENT;
    const code = await runBootstrapApply(
      { file, yes: true, json: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      remaining_deploy: ReadonlyArray<{ role: string; deploy_path: string; presence: string; command: string }>;
    };
    expect(parsed.remaining_deploy).toHaveLength(2);
    const roles = parsed.remaining_deploy.map((s) => s.role).sort();
    expect(roles).toEqual(['code-agent', 'science-agent']);
    const codeAgentEntry = parsed.remaining_deploy.find((s) => s.role === 'code-agent');
    expect(codeAgentEntry?.deploy_path).toBe(DEMO_CODE_PATH);
    expect(codeAgentEntry?.presence).toBe('not-deployed');
    expect(codeAgentEntry?.command).toBe(`macf fleet deploy --agent code-agent -f ${file} --identity-key PATH_TO_YOUR_AGE_IDENTITY_KEY`);
    const scienceAgentEntry = parsed.remaining_deploy.find((s) => s.role === 'science-agent');
    expect(scienceAgentEntry?.deploy_path).toBe(DEMO_SCIENCE_PATH);
  });

  it('--json OMITS remaining_deploy entirely (not an empty array) for a fully-deployed fleet — byte-identical to pre-#1014 shape', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, yes: true, json: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists: () => true },
      fakeMutateDeps(file),
    );
    expect(code).toBe(0);
    const raw = logs.join('\n');
    expect(raw).not.toContain('remaining_deploy');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect('remaining_deploy' in parsed).toBe(false);
  });

  it('never leaks secret material through the remaining-deploy report, in text or --json', async () => {
    const file = writeManifest();
    const checkDeployPathExists = (p: string): boolean => p === DEMO_REPOS_PARENT;

    const textCode = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists },
      fakeMutateDeps(file),
    );
    expect(textCode).toBe(0);
    const text = logs.join('\n');
    expect(text).not.toContain('-----BEGIN');
    expect(text).not.toContain('SENTINEL-CLIENT-SECRET');
    expect(text).not.toContain('SENTINEL-WEBHOOK-SECRET');
    expect(text).not.toContain('SENTINEL-PEM-VALUE');

    logs = [];
    const file2 = writeManifest();
    const jsonCode = await runBootstrapApply(
      { file: file2, yes: true, json: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists },
      fakeMutateDeps(file2),
    );
    expect(jsonCode).toBe(0);
    const json = logs.join('\n');
    expect(json).not.toContain('-----BEGIN');
    expect(json).not.toContain('SENTINEL-CLIENT-SECRET');
    expect(json).not.toContain('SENTINEL-WEBHOOK-SECRET');
    expect(json).not.toContain('SENTINEL-PEM-VALUE');
  });

  it('suppresses the remaining-deploy block entirely on a control-repo-ABORTED run (foreign) — deploying is not the next step there', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, yes: true },
      // Neither leaf nor parent exists — every declared agent WOULD be
      // flagged, if the block weren't suppressed for this abort shape.
      { observe: () => Promise.resolve(EMPTY_OBSERVED), checkDeployPathExists: () => false },
      fakeMutateDeps(file, {
        controlRepoDeps: {
          checkMeta: async () => ({ presence: 'present', archived: false }),
          readManifestFile: async () => undefined,
          createRepo: async () => {
            throw new Error('must not be called — foreign never creates');
          },
          unarchiveRepo: async () => {
            throw new Error('must not be called — foreign never unarchives');
          },
          cloneRepo: async () => {
            throw new Error('must not be called — foreign never clones');
          },
          commitAndPush: async () => {
            throw new Error('must not be called — foreign never commits');
          },
        },
      }),
    );
    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(out).toMatch(/⚠ ABORTED/);
    expect(out).not.toContain('NOT DEPLOYED');
    expect(out).not.toContain('UNKNOWN whether deployed');
    expect(out).not.toContain('macf fleet deploy --agent');
    expect(out).not.toContain('macf#1014');
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

  // --- resolvedTsOauth threading (groundnuty/macf#1186) ---

  it('resolvedTsOauth is undefined on FleetApplyDeps when not supplied — byte-identical to pre-#1186 wiring', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN);
    expect(deps.resolvedTsOauth).toBeUndefined();
  });

  it('resolvedTsOauth is threaded verbatim onto FleetApplyDeps when supplied — the SAME flag/env-resolved pair runBootstrapApply computed', () => {
    const deps = resolveMutateDeps(
      '/tmp/nonexistent/fleet.yaml',
      new Map(),
      SENTINEL_RUNNER_TOKEN,
      undefined,
      undefined,
      undefined,
      { clientId: 'resolved-client-id', secret: 'resolved-secret' },
    );
    expect(deps.resolvedTsOauth).toEqual({ clientId: 'resolved-client-id', secret: 'resolved-secret' });
  });

  // --- trustDeps.readVaultCaCert threading (DR-043 Amendment D phase 3, groundnuty/macf#978) ---

  it('trustDeps.readVaultCaCert is undefined when NEITHER vaultPath nor identityKeyPath is supplied — byte-identical to pre-#978 wiring', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml');
    expect(deps.trustDeps.readVaultCaCert).toBeUndefined();
  });

  it('trustDeps.readVaultCaCert is undefined when only identityKeyPath is supplied (no vaultPath) — both-or-neither', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN, '/fake/operator-key.txt', undefined);
    expect(deps.trustDeps.readVaultCaCert).toBeUndefined();
  });

  it('trustDeps.readVaultCaCert is undefined when only vaultPath is supplied (no identityKeyPath) — both-or-neither', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN, undefined, '/fake/vault.age');
    expect(deps.trustDeps.readVaultCaCert).toBeUndefined();
  });

  it('trustDeps.readVaultCaCert is wired (a function) when BOTH vaultPath and identityKeyPath are supplied', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN, '/fake/operator-key.txt', '/fake/vault.age');
    expect(typeof deps.trustDeps.readVaultCaCert).toBe('function');
  });

  it('the wired readVaultCaCert degrades to undefined (never throws) against a genuinely missing vault file, and logs no CA material', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deps = resolveMutateDeps(
        '/tmp/nonexistent/fleet.yaml',
        new Map(),
        SENTINEL_RUNNER_TOKEN,
        '/definitely/not/a/real/identity-key',
        '/definitely/not/a/real/vault.age',
      );
      await expect(deps.trustDeps.readVaultCaCert?.('demo-fleet')).resolves.toBeUndefined();
      const logged = stderrSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(logged).toMatch(/CA vault-restore UNAVAILABLE/);
      // The diagnostic carries the VaultError's (pre-scrubbed) reason, never
      // a PEM — there is no cert/key material to leak here since the vault
      // never even existed, but the assertion pins the never-a-PEM shape.
      expect(logged).not.toMatch(/-----BEGIN/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  // --- routingClientDeps.readVaultRoutingClient threading (groundnuty/macf#986) ---

  it('routingClientDeps.readVaultRoutingClient is undefined when NEITHER vaultPath nor identityKeyPath is supplied — byte-identical to pre-#986 wiring', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml');
    expect(deps.routingClientDeps.readVaultRoutingClient).toBeUndefined();
  });

  it('routingClientDeps.readVaultRoutingClient is undefined when only identityKeyPath is supplied (no vaultPath) — both-or-neither', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN, '/fake/operator-key.txt', undefined);
    expect(deps.routingClientDeps.readVaultRoutingClient).toBeUndefined();
  });

  it('routingClientDeps.readVaultRoutingClient is undefined when only vaultPath is supplied (no identityKeyPath) — both-or-neither', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN, undefined, '/fake/vault.age');
    expect(deps.routingClientDeps.readVaultRoutingClient).toBeUndefined();
  });

  it('routingClientDeps.readVaultRoutingClient is wired (a function) when BOTH vaultPath and identityKeyPath are supplied', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', new Map(), SENTINEL_RUNNER_TOKEN, '/fake/operator-key.txt', '/fake/vault.age');
    expect(typeof deps.routingClientDeps.readVaultRoutingClient).toBe('function');
  });

  it('the wired readVaultRoutingClient degrades to undefined (never throws) against a genuinely missing vault file, and logs no cert/key material', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deps = resolveMutateDeps(
        '/tmp/nonexistent/fleet.yaml',
        new Map(),
        SENTINEL_RUNNER_TOKEN,
        '/definitely/not/a/real/identity-key',
        '/definitely/not/a/real/vault.age',
      );
      await expect(deps.routingClientDeps.readVaultRoutingClient?.()).resolves.toBeUndefined();
      const logged = stderrSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(logged).toMatch(/Routing-client vault-restore UNAVAILABLE/);
      // No cert/key material to leak here since the vault never even
      // existed, but the assertion pins the never-a-PEM shape regardless.
      expect(logged).not.toMatch(/-----BEGIN/);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// --- resolveTsOauthFlagOrEnv — the CLI-flag-wins-over-env precedence
// (groundnuty/macf#1186), tested directly + non-circularly. Cannot be
// decisively tested through the full runBootstrapApply integration surface
// (see the comment at that describe block's own "flag wins" test site) —
// once either source clears the pre-flight, a flag-sourced and an
// env-sourced value satisfy the exact same presence check identically.
describe('resolveTsOauthFlagOrEnv — CLI flag wins over env (groundnuty/macf#1186)', () => {
  it('the flag value wins when both are given', () => {
    expect(resolveTsOauthFlagOrEnv('flag-val', 'env-val')).toBe('flag-val');
  });

  it('falls back to the env value when the flag is undefined', () => {
    expect(resolveTsOauthFlagOrEnv(undefined, 'env-val')).toBe('env-val');
  });

  it('undefined when neither is given', () => {
    expect(resolveTsOauthFlagOrEnv(undefined, undefined)).toBeUndefined();
  });
});

// --- resolveMutateDeps — waitForOperatorBeat wiring (groundnuty/macf#952
// follow-up: give the operator a beat to read the just-printed instructions
// BEFORE the browser opens) ---
//
// The interactive ("press Enter") branch touches real `process.stdin` via
// `node:readline` — the SAME reason `realOpenUrl`/`realConfirmPlan` above are
// never invoked for real in this suite (OS/stdin-interactive primitives are
// pinned by WIRING identity, not by driving a real prompt). The decisive
// assertion this issue's hard constraint needs — "`--yes` must never hang" —
// IS safe to drive for real: the `assumeYes: true` branch never touches
// stdin or stderr at all, so invoking it can't leave a dangling listener.

describe('resolveMutateDeps — waitForOperatorBeat wiring (groundnuty/macf#952 follow-up)', () => {
  it('is always wired as a function on buildAgentDeps(log), regardless of assumeYes', () => {
    const withYes = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', undefined, undefined, undefined, undefined, true);
    const interactive = resolveMutateDeps('/tmp/nonexistent/fleet.yaml');
    expect(typeof withYes.buildAgentDeps(() => {}).waitForOperatorBeat).toBe('function');
    expect(typeof interactive.buildAgentDeps(() => {}).waitForOperatorBeat).toBe('function');
  });

  it('--yes (assumeYes=true): the wired waitForOperatorBeat resolves WITHOUT writing to stderr — no prompt seam is invoked, so it cannot hang an unattended run (the decisive "never hangs" assertion)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', undefined, undefined, undefined, undefined, true);
      const beat = deps.buildAgentDeps(() => {}).waitForOperatorBeat;
      await expect(beat?.('code-agent', 'consent gate 1 of 2 (App-manifest form)')).resolves.toBeUndefined();
      // Zero stderr writes proves the prompt branch (which writes the
      // "press Enter" line BEFORE ever touching readline) was never reached
      // — not merely that the promise happened to resolve quickly.
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('assumeYes omitted (interactive default, undefined -> false): still resolves to a function distinct from the --yes no-op — the interactive real-prompt behavior itself is NOT driven here (would block on real stdin; same convention as realOpenUrl/realConfirmPlan, verified instead via the apply-agent.ts injected-fake ordering tests)', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml');
    const beat = deps.buildAgentDeps(() => {}).waitForOperatorBeat;
    expect(typeof beat).toBe('function');
  });
});

// --- resolveMutateDeps — allowInstallRetry / waitForOperatorFix wiring
// (groundnuty/macf#1063) ---
//
// `resolveMutateDeps` is exported "ONLY so a test can assert the wiring by
// identity" (this file's own doc, macf#857 review) — a security/UX primitive
// can be defined, unit-tested in isolation, and never actually threaded
// through the seam the CLI builds. Asserting `allowInstallRetry` only at the
// `AgentApplyDeps` level (as `apply-agent.test.ts` does) would NOT catch a
// wiring regression here — this describe block is that seam-level check,
// mirroring the `waitForOperatorBeat` block immediately above by pattern
// (both derive from the SAME `assumeYes`, both pinned by identity/value here
// rather than by driving a real interactive prompt).

describe('resolveMutateDeps — allowInstallRetry / waitForOperatorFix wiring (groundnuty/macf#1063)', () => {
  it('--yes (assumeYes=true): allowInstallRetry is false — a recoverable consent-gate-2 rejection must NOT re-open the page unattended', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', undefined, undefined, undefined, undefined, true);
    expect(deps.buildAgentDeps(() => {}).allowInstallRetry).toBe(false);
  });

  it('interactive (assumeYes omitted): allowInstallRetry is true', () => {
    const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml');
    expect(deps.buildAgentDeps(() => {}).allowInstallRetry).toBe(true);
  });

  it('waitForOperatorFix is always wired as a function on buildAgentDeps(log), regardless of assumeYes — paired with allowInstallRetry, never omitted', () => {
    const withYes = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', undefined, undefined, undefined, undefined, true);
    const interactive = resolveMutateDeps('/tmp/nonexistent/fleet.yaml');
    expect(typeof withYes.buildAgentDeps(() => {}).waitForOperatorFix).toBe('function');
    expect(typeof interactive.buildAgentDeps(() => {}).waitForOperatorFix).toBe('function');
  });

  it('--yes (assumeYes=true): the wired waitForOperatorFix resolves WITHOUT writing to stderr — moot in practice (allowInstallRetry is false so it is never called), but asserted anyway so the SAME "never hangs unattended" contract waitForOperatorBeat gets is verified for this hook too', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deps = resolveMutateDeps('/tmp/nonexistent/fleet.yaml', undefined, undefined, undefined, undefined, true);
      const fix = deps.buildAgentDeps(() => {}).waitForOperatorFix;
      await expect(fix?.('code-agent', 'consent gate 2 of 2 — retry 1 of 2')).resolves.toBeUndefined();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// --- Pure result-rendering helpers ---

function resultWith(overrides: Partial<FleetApplyResult> = {}): FleetApplyResult {
  return {
    controlRepo: { status: 'created', repo: 'groundnuty/demo-fleet-control', localDir: '/x' },
    controlRepoSync: { status: 'pushed' },
    // groundnuty/macf#1057 default: a NEUTRAL 'written' shape (every declared
    // agent's label present) so pre-existing tests in this file that don't
    // override it see a steady, non-alarming line. Tests exercising the
    // allowlist-gap / failed / skipped shapes override explicitly.
    controlRepoInit: {
      status: 'written',
      repo: 'groundnuty/demo-fleet-control',
      agents: ['code-agent'],
      labels: { status: 'ok', created: [], existed: ['code-agent', 'in-progress', 'in-review', 'blocked', 'agent-offline'] },
      workflowAndConfigAllowlisted: false,
    },
    lockPath: '/x/fleet.lock',
    finalLock: null,
    agents: [],
    // groundnuty/macf#943 — a NEUTRAL default ('reused', not
    // failed/drift/skipped-unverified) so every PRE-EXISTING `applyExitCode`
    // test in this file that doesn't override it keeps expecting the SAME
    // exit code it did before this field existed. Individual tests below
    // override to exercise the runner-ops's own failure/skip shapes.
    runnerOps: { role: 'runner-ops', status: 'reused', appId: '900', installId: '901' },
    // groundnuty/macf#1074 — same NEUTRAL-default reasoning as `runnerOps`
    // immediately above: a REUSED router App (never failed/drift/skipped-
    // unverified) so every PRE-EXISTING `applyExitCode` test in this file
    // keeps expecting the SAME exit code it did before this field existed.
    routerApp: { role: 'router', status: 'reused', appId: '902', installId: '903' },
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
    // groundnuty/macf#1074 — the unified six-secret publish result. Empty
    // (no repos, nothing attempted) is the NEUTRAL default matching
    // `routingClient`'s own no-repos-to-publish-to default above.
    routingSecrets: {
      MACF_ROUTING_APP_ID: {},
      MACF_ROUTING_APP_KEY: {},
      ROUTING_CLIENT_CERT: {},
      ROUTING_CLIENT_KEY: {},
      TS_OAUTH_CLIENT_ID: {},
      TS_OAUTH_SECRET: {},
    },
    // groundnuty/macf#1112 — the bundle publish result's own NEUTRAL
    // default, same "no repos, nothing attempted" reasoning as
    // `routingSecrets` immediately above.
    routingBundle: {},
    ...overrides,
  };
}

describe('findAvailableRecoveryArtifacts / formatRecoveryArtifactNotice — macf#988, DR-043 Amendment B requirement 4', () => {
  const MANIFEST_FOR_RECOVERY_CHECK = parseFleetManifest(FLEET_YAML);

  it('is EXISTENCE-ONLY: probes manifest.agents[] roles + RUNNER_OPS_ROLE at operatorRecoveryArtifactPath, decrypts nothing', () => {
    const probed: string[] = [];
    const roles = findAvailableRecoveryArtifacts(
      MANIFEST_FOR_RECOVERY_CHECK,
      (path) => {
        probed.push(path);
        return false;
      },
      '/fake/recovery-root',
    );
    expect(roles).toEqual([]);
    expect(probed).toEqual([
      '/fake/recovery-root/demo-fleet/code-agent.age',
      '/fake/recovery-root/demo-fleet/science-agent.age',
      '/fake/recovery-root/demo-fleet/runner-ops.age',
    ]);
  });

  it('returns only the roles whose artifact actually exists', () => {
    const roles = findAvailableRecoveryArtifacts(
      MANIFEST_FOR_RECOVERY_CHECK,
      (path) => path.endsWith('code-agent.age'),
      '/fake/recovery-root',
    );
    expect(roles).toEqual(['code-agent']);
  });

  it('returns [] when nothing exists (the ordinary, common-case fleet)', () => {
    const roles = findAvailableRecoveryArtifacts(MANIFEST_FOR_RECOVERY_CHECK, () => false, '/fake/recovery-root');
    expect(roles).toEqual([]);
  });

  it('formatRecoveryArtifactNotice names the roles + macf#988 + the --identity-key remedy', () => {
    const text = formatRecoveryArtifactNotice(['code-agent', 'runner-ops']);
    expect(text).toContain('code-agent, runner-ops');
    expect(text).toContain("a prior run's App creation reached the vault-durability step");
    expect(text).toContain('--identity-key');
  });
});

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

  it('applyExitCode: 1 when control-repo repo-init genuinely FAILED (groundnuty/macf#1057)', () => {
    expect(
      applyExitCode(
        resultWith({ controlRepoInit: { status: 'failed', repo: 'groundnuty/demo-fleet-control', agents: ['code-agent'], reason: 'local registry' } }),
      ),
    ).toBe(1);
  });

  it('applyExitCode: 0 when control-repo repo-init wrote successfully but labels were SKIPPED (no token this run — the expected steady state, not a failure)', () => {
    expect(
      applyExitCode(
        resultWith({
          controlRepoInit: {
            status: 'written',
            repo: 'groundnuty/demo-fleet-control',
            agents: ['code-agent'],
            labels: { status: 'skipped', reason: 'no GH_TOKEN/APP_ID this run' },
            workflowAndConfigAllowlisted: false,
          },
        }),
      ),
    ).toBe(0);
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

  it('applyExitCode: 0 when a routing leg is PENDING — an honest incomplete for a runner apply itself just provisioned, NOT a failure (groundnuty/macf#1212 operator ruling: "we cannot report an error... it sounds like the user\'s problem")', () => {
    expect(applyExitCode(resultWith({ routing: { 'x/y': { status: 'pending', reason: 'still provisioning' } } }))).toBe(0);
  });

  it('applyExitCode: 1 when a routing leg failed', () => {
    expect(applyExitCode(resultWith({ routing: { 'x/y': { status: 'failed', reason: 'boom' } } }))).toBe(1);
  });

  it('applyExitCode: 0 when routing legs are created/already-present', () => {
    expect(
      applyExitCode(resultWith({ routing: { 'x/y': { status: 'created' }, 'x/z': { status: 'already-present' } } })),
    ).toBe(0);
  });

  // --- groundnuty/macf#954 — the routing-client mint's three-way status
  // distinction (minted / skipped-benign / failed-exception) and its
  // exit-code consequence. Before this fix, a `deps.mint` exception collapsed
  // into the SAME `'skipped'` status+reason SHAPE as the two benign skip
  // causes below, so `applyExitCode` treated it identically — exit 0 — even
  // though NO routing-client cert ever reached any repo on a run whose CA was
  // freshly minted. These tests assert the EXIT CODE (the actual severity;
  // the human-readable message was already correct before this fix).

  it('applyExitCode: 0 when the routing-client mint is SKIPPED because it was already vaulted in a prior run (benign steady state — macf#954)', () => {
    const result = resultWith({
      routingClient: { mint: { status: 'skipped', reason: 'already minted in a PRIOR apply run' }, certLegs: {}, keyLegs: {} },
    });
    expect(applyExitCode(result)).toBe(0);
  });

  it('applyExitCode: 0 when the routing-client mint is SKIPPED because the CA was REUSED, not minted, this run (benign steady state — macf#954)', () => {
    const result = resultWith({
      routingClient: { mint: { status: 'skipped', reason: 'CA was not freshly minted this run' }, certLegs: {}, keyLegs: {} },
    });
    expect(applyExitCode(result)).toBe(0);
  });

  it('applyExitCode: 1 when the routing-client mint FAILED with a genuine exception — DISTINCT from a benign skip, even with every leg empty (macf#954, the defect #954 fixes)', () => {
    const result = resultWith({
      routingClient: { mint: { status: 'failed', reason: 'routing-client cert mint failed: x509 generation failed' }, certLegs: {}, keyLegs: {} },
    });
    expect(applyExitCode(result)).toBe(1);
  });

  it('applyExitCode: 1 when ANY routing-client cert/key leg failed, independent of the mint status', () => {
    expect(
      applyExitCode(
        resultWith({
          routingClient: {
            mint: { status: 'minted' },
            certLegs: { 'x/y': { status: 'failed', reason: 'network' } },
            keyLegs: { 'x/y': { status: 'created' } },
          },
        }),
      ),
    ).toBe(1);
  });

  it('applyExitCode: 0 when the mint is MINTED and every leg created/already-present', () => {
    expect(
      applyExitCode(
        resultWith({
          routingClient: {
            mint: { status: 'minted' },
            certLegs: { 'x/y': { status: 'created' } },
            keyLegs: { 'x/y': { status: 'created' } },
          },
        }),
      ),
    ).toBe(0);
  });

  // --- groundnuty/macf#1112 — the single bundled routing secret's own
  // exit-code gate, mirroring `routingSecretsBad`'s existing bar for the
  // six individual secrets.

  it('applyExitCode: 1 when the MACF_ROUTING_BUNDLE leg failed', () => {
    expect(applyExitCode(resultWith({ routingBundle: { 'x/y': { status: 'failed', reason: 'cannot compose MACF_ROUTING_BUNDLE — TS_OAUTH_SECRET: vault restore came up empty' } } }))).toBe(1);
  });

  it('applyExitCode: 0 when MACF_ROUTING_BUNDLE legs are created/already-present', () => {
    expect(
      applyExitCode(resultWith({ routingBundle: { 'x/y': { status: 'created' }, 'x/z': { status: 'already-present' } } })),
    ).toBe(0);
  });

  it('applyExitCode: 0 when MACF_ROUTING_BUNDLE is honestly skipped (not yet composable — e.g. Tailscale undeclared)', () => {
    expect(
      applyExitCode(resultWith({ routingBundle: { 'x/y': { status: 'skipped', reason: 'cannot compose MACF_ROUTING_BUNDLE yet — TS_OAUTH_CLIENT_ID: not declared' } } })),
    ).toBe(0);
  });

  it('applyExitCode: 0 with the default (empty) routingBundle fixture — the neutral no-repos-to-publish-to steady state', () => {
    expect(applyExitCode(resultWith({}))).toBe(0);
  });

  it('--json (fleetApplyResultToJson) distinguishes all three routing-client mint statuses verbatim — minted / skipped / failed (macf#954)', () => {
    const minted = fleetApplyResultToJson(resultWith({ routingClient: { mint: { status: 'minted' }, certLegs: {}, keyLegs: {} } })) as {
      routing_client: { mint: { status: string } };
    };
    const skipped = fleetApplyResultToJson(
      resultWith({ routingClient: { mint: { status: 'skipped', reason: 'CA was reused' }, certLegs: {}, keyLegs: {} } }),
    ) as { routing_client: { mint: { status: string; reason?: string } } };
    const failed = fleetApplyResultToJson(
      resultWith({ routingClient: { mint: { status: 'failed', reason: 'x509 generation failed' }, certLegs: {}, keyLegs: {} } }),
    ) as { routing_client: { mint: { status: string; reason?: string } } };
    expect(minted.routing_client.mint.status).toBe('minted');
    expect(skipped.routing_client.mint.status).toBe('skipped');
    expect(failed.routing_client.mint.status).toBe('failed');
    expect(failed.routing_client.mint.reason).toBe('x509 generation failed');
  });

  it('formatApplyResult renders a routing-client mint FAILURE loudly, distinct from a benign SKIPPED line, and NEVER a secret (macf#954)', () => {
    const text = formatApplyResult(
      resultWith({ routingClient: { mint: { status: 'failed', reason: 'routing-client cert mint failed: x509 generation failed' }, certLegs: {}, keyLegs: {} } }),
    );
    expect(text).toMatch(/Routing-client cert: FAILED to mint — routing-client cert mint failed: x509 generation failed/);
    expect(text).not.toMatch(/Routing-client cert: SKIPPED/);
    expect(text).not.toContain('-----BEGIN');
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

  it('formatApplyResult renders a SKIPPED routing leg with its reason (generic render behavior — EnsureVariableOutcome still admits "skipped")', () => {
    const text = formatApplyResult(
      resultWith({
        routing: { 'groundnuty/x': { status: 'skipped', reason: 'some future skip reason' } },
      }),
    );
    expect(text).toMatch(/groundnuty\/x: SKIPPED — some future skip reason/);
  });

  it('formatApplyResult renders a FAILED routing leg loudly, never as a SKIPPED line beside otherwise-green output (groundnuty/macf#993 — the no-runner-registered gap)', () => {
    const text = formatApplyResult(
      resultWith({
        routing: { 'groundnuty/x': { status: 'failed', reason: 'no self-hosted runner is confirmed registered for "groundnuty/x"' } },
      }),
    );
    expect(text).toMatch(/groundnuty\/x: FAILED — no self-hosted runner is confirmed registered/);
    expect(text).not.toMatch(/groundnuty\/x: SKIPPED/);
  });

  it('formatApplyResult renders a PENDING routing leg with its reason, distinct from FAILED — groundnuty/macf#1212', () => {
    const text = formatApplyResult(
      resultWith({
        routing: { 'groundnuty/x': { status: 'pending', reason: 'still provisioning, 30s/600s elapsed' } },
      }),
    );
    expect(text).toMatch(/groundnuty\/x: PENDING — still provisioning, 30s\/600s elapsed/);
    expect(text).not.toMatch(/groundnuty\/x: FAILED/);
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

  // --- groundnuty/macf#1053 — version-reconcile summary names the actual
  // outcome (rolled N / had nothing to roll / could not attempt), never the
  // single word "completed" that used to collapse all three (#1053's own
  // live incident: two agents at unchanged uptimes, summary said
  // "completed"). Fixtures here construct `ApplyVersionPhaseResult` directly
  // — `apply-version.test.ts` covers `runApplyVersionPhase` computing these
  // fields FROM a `FleetUpgradeReport`; this block covers the RENDER, the
  // layer the bug actually lived in.

  const VERSION_ROLLED: ApplyVersionPhaseResult = {
    attempted: true,
    target: '0.2.57',
    halted: false,
    rolledAgents: ['code-agent', 'science-agent'],
    unreachable: false,
    totalMembers: 2,
    skipBreakdown: [],
  };
  const VERSION_UNREACHABLE: ApplyVersionPhaseResult = {
    attempted: true,
    target: '0.2.57',
    halted: false,
    rolledAgents: [],
    unreachable: true,
    totalMembers: 0,
    skipBreakdown: [],
  };

  it('formatApplyResult: a genuine roll names the count + the agents, and does not say "could not attempt"', () => {
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, VERSION_ROLLED);
    expect(text).toMatch(/Version reconcile: rolled 2 agent\(s\) to macf@0\.2\.57 — code-agent, science-agent/);
    expect(text).not.toMatch(/could not attempt/);
    expect(text).not.toMatch(/0 of \d+/);
  });

  it('formatApplyResult: a PARTIAL roll names BOTH the rolled agent(s) AND what was skipped (never drops the skip breakdown)', () => {
    // groundnuty/macf#1053 review — the `rolled.length > 0` branch used to
    // return before `skipBreakdown` was ever read, so 1 rolled + 2 busy
    // rendered identically to 1 rolled + 0 remaining: the exact
    // "authoritative-looking summary that omits what didn't happen" shape
    // this issue reports, reproduced in this branch. Decisive per
    // `assert-the-wrong-path.md`: compare against the CLEAN-roll line, not
    // just "the text is non-empty" — a weaker assertion passes either way.
    const partial: ApplyVersionPhaseResult = {
      attempted: true,
      target: '0.2.57',
      halted: false,
      rolledAgents: ['code-agent'],
      unreachable: false,
      totalMembers: 3,
      skipBreakdown: ['2 busy'],
    };
    const clean: ApplyVersionPhaseResult = { ...partial, totalMembers: 1, skipBreakdown: [] };
    const partialText = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, partial);
    const cleanText = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, clean);
    expect(partialText).toMatch(/Version reconcile: rolled 1 agent\(s\) to macf@0\.2\.57 — code-agent \(2 busy not rolled\)/);
    expect(partialText).not.toBe(cleanText);
    expect(cleanText).not.toMatch(/not rolled/);
  });

  it('formatApplyResult: an unreachable fleet says "could not attempt", never "completed"', () => {
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, VERSION_UNREACHABLE);
    expect(text).toMatch(/Version reconcile: could not attempt toward macf@0\.2\.57 — no locally-discoverable workspace.*driver-unresolved/);
    expect(text).not.toMatch(/completed/);
  });

  // The decisive assertion per `assert-the-wrong-path.md`: a bare "a Version
  // reconcile line was printed" check cannot distinguish these two outcomes
  // — that indistinguishability IS the bug #1053 reports. The two rendered
  // lines must differ, and specifically neither collapses to "completed".
  it('formatApplyResult: the rolled line and the no-op line are NOT the same text (the collapse #1053 reports)', () => {
    const rolledLine = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, VERSION_ROLLED);
    const noOpLine = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, VERSION_UNREACHABLE);
    expect(rolledLine).not.toBe(noOpLine);
    expect(rolledLine).not.toMatch(/completed/);
    expect(noOpLine).not.toMatch(/completed/);
  });

  it('formatApplyResult: examined members but rolled none of them names the skip breakdown (busy/config-dirty/…)', () => {
    const versionPhase: ApplyVersionPhaseResult = {
      attempted: true,
      target: '0.2.57',
      halted: false,
      rolledAgents: [],
      unreachable: false,
      totalMembers: 2,
      skipBreakdown: ['1 busy', '1 config-dirty'],
    };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, versionPhase);
    expect(text).toMatch(/Version reconcile: 0 of 2 discovered member\(s\) rolled toward macf@0\.2\.57 — 1 busy, 1 config-dirty/);
    expect(text).not.toMatch(/completed/);
    expect(text).not.toMatch(/could not attempt/);
  });

  it('formatApplyResult: members discovered but none behind target says so, not a breakdown', () => {
    const versionPhase: ApplyVersionPhaseResult = {
      attempted: true,
      target: '0.2.57',
      halted: false,
      rolledAgents: [],
      unreachable: false,
      totalMembers: 2,
      skipBreakdown: [],
    };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, versionPhase);
    expect(text).toMatch(/Version reconcile: 0 of 2 discovered member\(s\) rolled toward macf@0\.2\.57 — none behind target/);
  });

  it('formatApplyResult: no fleet members discovered at all (0 total, reachable) names that, distinct from unreachable', () => {
    const versionPhase: ApplyVersionPhaseResult = {
      attempted: true,
      target: '0.2.57',
      halted: false,
      rolledAgents: [],
      unreachable: false,
      totalMembers: 0,
      skipBreakdown: [],
    };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, versionPhase);
    expect(text).toMatch(/Version reconcile: 0 of 0 discovered member\(s\) rolled toward macf@0\.2\.57 — no fleet members discovered locally/);
    expect(text).not.toMatch(/driver-unresolved/);
  });

  it('formatApplyResult: flagless note appears only when the phase says so, and never on a genuine roll', () => {
    const unreachableFlagless: ApplyVersionPhaseResult = { ...VERSION_UNREACHABLE, flagless: true };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, unreachableFlagless);
    expect(text).toMatch(/This apply run was invoked without --vault\/--identity-key/);

    const unreachableNotFlagless = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, VERSION_UNREACHABLE);
    expect(unreachableNotFlagless).not.toMatch(/invoked without --vault/);

    const rolledFlagless: ApplyVersionPhaseResult = { ...VERSION_ROLLED, flagless: true };
    const rolledText = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, rolledFlagless);
    // Even when this run WAS flagless, a genuine roll never carries the
    // note — the flagless fact is irrelevant once agents actually rolled.
    expect(rolledText).not.toMatch(/invoked without --vault/);
  });

  it('formatApplyResult: HALTED keeps its own dedicated message, unaffected by #1053 (well-formed parens, target named)', () => {
    const versionPhase: ApplyVersionPhaseResult = { attempted: true, target: '0.2.57', halted: true };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, versionPhase);
    expect(text).toMatch(
      /Version reconcile: HALTED — a bad release stopped the roll toward macf@0\.2\.57 \(see log above\)\.$/m,
    );
  });

  it('fleetApplyResultToJson: version_phase carries the outcome discriminator as fields, not just prose', () => {
    const json = JSON.parse(JSON.stringify(fleetApplyResultToJson(resultWith({}), [], { steps: [] }, undefined, VERSION_ROLLED))) as {
      version_phase: {
        target: string;
        halted: boolean;
        rolled_agents: readonly string[];
        unreachable: boolean;
        total_members: number;
        skip_breakdown: readonly string[];
      };
    };
    expect(json.version_phase).toEqual({
      target: '0.2.57',
      halted: false,
      rolled_agents: ['code-agent', 'science-agent'],
      unreachable: false,
      total_members: 2,
      skip_breakdown: [],
    });
  });

  it('fleetApplyResultToJson: an unreachable no-op carries unreachable:true + empty rolled_agents (never the JSON equivalent of "completed")', () => {
    const json = JSON.parse(JSON.stringify(fleetApplyResultToJson(resultWith({}), [], { steps: [] }, undefined, VERSION_UNREACHABLE))) as {
      version_phase: { rolled_agents: readonly string[]; unreachable: boolean };
    };
    expect(json.version_phase.rolled_agents).toEqual([]);
    expect(json.version_phase.unreachable).toBe(true);
  });

  // groundnuty/macf#1053 hard constraint — "do not change what the version
  // phase DOES, this is reporting only." An `unreachable` phase (no
  // locally-discoverable workspace AT ALL) is a distinct, honest
  // could-not-attempt state — `skipBreakdown` is always empty for it (see
  // `apply-version.ts::summarizeVersionRoll`'s doc), so it exits 0 exactly
  // as before groundnuty/macf#1151, same as a genuine roll.
  it('applyExitCode: an unreachable/no-op version phase does NOT force a non-zero exit (reporting only, unchanged)', () => {
    expect(applyExitCode(resultWith({}), [], VERSION_UNREACHABLE)).toBe(0);
  });

  // groundnuty/macf#1151 — the sibling of the unreachable case above: a
  // phase that ATTEMPTED and rolled EVERY discovered member (empty
  // `skipBreakdown`) is also fully green, not merely "not halted".
  it('applyExitCode: a version phase that rolled every discovered member (empty skipBreakdown) does NOT force a non-zero exit', () => {
    expect(applyExitCode(resultWith({}), [], VERSION_ROLLED)).toBe(0);
  });

  it('applyExitCode: HALTED still forces a non-zero exit, exactly as before #1053', () => {
    expect(applyExitCode(resultWith({}), [], { attempted: true, target: '0.2.57', halted: true })).toBe(1);
  });
});

// --- groundnuty/macf#1212 — the operator's ruling on the CLOSING output:
// "after the apply and before the deployment... I should be encouraged to
// run the status to see that everything is green." Status confirms; deploy
// acts; the order matters (printing deploy first invites skipping the
// check). `formatApplyResult`'s 6th param is `undefined` by default, so
// every pre-#1212 call site above keeps rendering byte-identically —
// pinned by the ABSENCE of the status line in every test that doesn't pass
// it.
describe('formatApplyResult — the "confirm the fleet is green" next-step line (groundnuty/macf#1212)', () => {
  it('renders nothing when statusNextStep is omitted — every pre-#1212 call site is unaffected', () => {
    const text = formatApplyResult(resultWith({}));
    expect(text).not.toMatch(/confirm the fleet is green/i);
    expect(text).not.toMatch(/bootstrap status/);
  });

  it('renders the exact copy-pasteable command, echoing ONLY the flags apply itself received (no vault/identity-key supplied)', () => {
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, undefined, {
      manifestPath: '/home/op/fleet.yaml',
      flags: {},
    });
    expect(text).toContain('Next step — confirm the fleet is green:');
    expect(text).toContain('macf bootstrap status -f /home/op/fleet.yaml');
    expect(text).not.toContain('--vault');
    expect(text).not.toContain('--identity-key');
  });

  it('echoes --vault/--identity-key VERBATIM when apply itself was invoked with them', () => {
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, undefined, {
      manifestPath: '/home/op/fleet.yaml',
      flags: { vaultPath: '/home/op/secrets/vault.age', identityKeyPath: '/home/op/.age/identity.key' },
    });
    expect(text).toContain('macf bootstrap status -f /home/op/fleet.yaml --vault /home/op/secrets/vault.age --identity-key /home/op/.age/identity.key');
  });

  it('DECISIVE ordering: the status line appears BEFORE the per-agent fleet-deploy commands, never after', () => {
    const text = formatApplyResult(
      resultWith({}),
      [],
      {
        steps: [
          { role: 'code-agent', deployPath: '/x/code-agent', presence: 'not-deployed', command: 'macf fleet deploy --agent code-agent -f /home/op/fleet.yaml' },
        ],
      },
      undefined,
      undefined,
      { manifestPath: '/home/op/fleet.yaml', flags: {} },
    );
    const statusIdx = text.indexOf('confirm the fleet is green');
    const deployIdx = text.indexOf('macf fleet deploy --agent code-agent');
    expect(statusIdx).toBeGreaterThan(-1);
    expect(deployIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeLessThan(deployIdx);
  });

  it('DECISIVE: N declared agents produce N deploy commands (groundnuty/macf#1014, unaffected by #1212 — pinning the pre-existing per-agent behavior the ordering test above builds on)', () => {
    const text = formatApplyResult(resultWith({}), [], {
      steps: [
        { role: 'code-agent', deployPath: '/x/code-agent', presence: 'not-deployed', command: 'macf fleet deploy --agent code-agent -f /home/op/fleet.yaml' },
        { role: 'science-agent', deployPath: '/x/science-agent', presence: 'not-deployed', command: 'macf fleet deploy --agent science-agent -f /home/op/fleet.yaml' },
      ],
    });
    expect(text).toContain('macf fleet deploy --agent code-agent');
    expect(text).toContain('macf fleet deploy --agent science-agent');
  });

  it('renders even when remainingDeploy has zero steps — the status check is unconditional, not gated on "something is incomplete"', () => {
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, undefined, undefined, {
      manifestPath: '/home/op/fleet.yaml',
      flags: {},
    });
    expect(text).toContain('confirm the fleet is green');
  });
});

// --- groundnuty/macf#1151 — a version-reconcile phase that left SOME but
// not ALL discovered fleet members un-rolled must be DISTINGUISHABLE, by
// exit code, from a fully-green apply. Before this fix, `applyExitCode`
// read only `versionPhase?.halted`, never `skipBreakdown` — the exact
// defect this block pins down. Shape mirrors
// `commands/fleet-upgrade.test.ts`'s "one skip cause at a time" +
// "DECISIVE" pattern for the identical question at the `fleet upgrade`
// layer (groundnuty/macf#1146/#1150).
describe('applyExitCode — version-reconcile PARTIAL roll (groundnuty/macf#1151)', () => {
  function partialPhase(skipBreakdown: readonly string[]): ApplyVersionPhaseResult {
    return {
      attempted: true,
      target: '0.2.57',
      halted: false,
      rolledAgents: [],
      unreachable: false,
      totalMembers: 2,
      skipBreakdown,
    };
  }

  // Local fixture (this describe block is a sibling of, not nested inside,
  // the "formatApplyResult / fleetApplyResultToJson / applyExitCode (pure)"
  // block that owns its own `VERSION_ROLLED`/`VERSION_UNREACHABLE`
  // block-scoped consts) — same shape as that block's `VERSION_ROLLED`:
  // attempted, not halted, every discovered member rolled, empty
  // `skipBreakdown`.
  const FULLY_ROLLED: ApplyVersionPhaseResult = {
    attempted: true,
    target: '0.2.57',
    halted: false,
    rolledAgents: ['code-agent', 'science-agent'],
    unreachable: false,
    totalMembers: 2,
    skipBreakdown: [],
  };

  // One test per skip cause `apply-version.ts::versionRollSkipBreakdown`
  // can produce — `applyExitCode` itself only checks `.length > 0`, but
  // covering each cause string separately pins that EVERY cause (not just
  // "busy") reaches the new branch, defending against a future refactor
  // that special-cases one of them.
  it.each([
    ['1 off-canonical-branch'],
    ['1 config-dirty'],
    ['1 busy'],
    ['1 stale-pin'],
    ['1 not-yet-serving'],
  ])('skipBreakdown = [%s], not halted → 2 (PARTIAL)', (cause) => {
    expect(applyExitCode(resultWith({}), [], partialPhase([cause]))).toBe(2);
  });

  it('multiple skip causes at once, not halted → 2 (PARTIAL)', () => {
    expect(applyExitCode(resultWith({}), [], partialPhase(['1 busy', '1 config-dirty']))).toBe(2);
  });

  it('DECISIVE (1/2) — a version phase with one skipped agent, no halt → non-zero AND distinguishable from a hard failure (exactly 2, not 1)', () => {
    const code = applyExitCode(resultWith({}), [], partialPhase(['1 busy']));
    expect(code).toBe(2);
    expect(code).not.toBe(1);
    expect(code).not.toBe(0);
  });

  it('DECISIVE (2/2) — a fully-green apply (clean result, version phase fully rolled) → 0', () => {
    expect(applyExitCode(resultWith({}), [], FULLY_ROLLED)).toBe(0);
  });

  // The priority-ordering test #1150 established for `fleetUpgradeExitCode`
  // ("halt takes priority over mixed"), copied here: a HALTED phase that
  // ALSO left other agents skipped for unrelated reasons must still report
  // `1`, never `2` — halt is checked as part of `hardFailure` BEFORE the
  // partial branch is ever reached, so this is not an accident of
  // evaluation order left untested.
  it('halted AND skipBreakdown non-empty → 1, not 2 (halt takes priority over partial)', () => {
    const halted: ApplyVersionPhaseResult = {
      attempted: true,
      target: '0.2.57',
      halted: true,
      rolledAgents: [],
      unreachable: false,
      totalMembers: 2,
      skipBreakdown: ['1 busy'],
    };
    expect(applyExitCode(resultWith({}), [], halted)).toBe(1);
  });

  // A DIFFERENT hard failure (not the version phase's own halt) must ALSO
  // outrank a partial version roll — proves `hardFailure` short-circuits
  // BEFORE the version-partial branch regardless of which of the many
  // hard-failure predicates fired, not just `halted`.
  it('a hard failure elsewhere (agent failed) AND skipBreakdown non-empty, not halted → 1, not 2', () => {
    const result = resultWith({
      agents: [{ role: 'a', identity: { role: 'a', status: 'failed', reason: 'boom' } }],
    });
    expect(applyExitCode(result, [], partialPhase(['1 config-dirty']))).toBe(1);
  });

  // groundnuty/macf#1151 — the honest-unknown deploy case (a `deploy_path`
  // that belongs to another host in a multi-host fleet, reported via
  // `remaining-deploy.ts`'s `presence: 'unknown'`) must NEVER become a
  // spurious non-zero/partial exit. `applyExitCode`'s signature has no
  // `remainingDeploy` parameter at all (see this function's own doc) — it
  // is structurally impossible for that report to influence this return
  // value. This pins the property directly (a clean apply with a
  // fully-rolled version phase still exits 0, independent of whatever
  // remaining-deploy state existed) and end-to-end coverage lives in
  // `runBootstrapApply — remaining-deploy honest completion (macf#1014)`'s
  // "a deploy_path not resolvable locally ... UNKNOWN ..." + "exit code is
  // UNCHANGED by deploy presence" tests above, which exercise the real
  // `computeRemainingDeploy` path through the full command and still see 0.
  it('a legitimately-UNKNOWN deploy elsewhere in the run does not produce a false partial (remainingDeploy is not even a parameter)', () => {
    expect(applyExitCode(resultWith({}), [], FULLY_ROLLED)).toBe(0);
  });
});

// --- macf#994: `apply`'s deploy-phase "launch the deployed agent(s)" block
// carries the SAME first-launch guidance `macf fleet deploy`'s own
// `nextStepLines` does (`fleet-deploy.test.ts` covers that surface; this
// block covers `formatApplyResult`'s `launchNextStepLines`, the apply-side
// mirror — both consume `first-launch-guidance.ts`, never duplicate it).
describe('formatApplyResult — macf#994 first-launch guidance (deploy phase)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function scratchDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'macf-apply-first-launch-test-'));
    dirs.push(d);
    return d;
  }

  /** A minimal, valid `'deployed'` `DeployPhaseAgentResult` — field values beyond role/destDir are arbitrary but schema-valid (this block is about the RENDER, not deploy internals). */
  function deployedResult(role: string, destDir: string): DeployPhaseAgentResult {
    return {
      role,
      destDir,
      outcome: {
        role,
        status: 'deployed',
        appId: '1',
        installId: '2',
        workspace: 'cloned',
        keyPath: join(destDir, 'key.pem'),
        keyWrite: 'written',
        keyFingerprint: 'sha256:deadbeef',
        ca: { status: 'vault-absent' },
        certIssue: 'not-attempted',
      },
    };
  }

  it('names BOTH first-launch prompts + the exact tmux attach command per deployed agent (falls back to role when no macf-agent.json exists)', () => {
    const destDir = scratchDir();
    const deployPhase: DeployPhaseRenderInput = {
      results: [deployedResult('code-agent', destDir)],
      checkAgentCertPresent: () => true,
      project: 'demo-fleet',
    };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, deployPhase);
    expect(text).toContain('Do you trust this folder?');
    expect(text).toContain('Loading development channels');
    expect(text).toContain('may ALSO need a manual answer');
    expect(text).toContain('tmux attach -t demo-fleet@code-agent');
  });

  it('the tmux attach command uses routing_label, NEVER agent_name, when a deployed workspace\'s config diverges (the decisive session-naming fixture, mirrors fleet-deploy.test.ts\'s own)', () => {
    const destDir = scratchDir();
    writeAgentConfig(destDir, {
      project: 'demo-fleet',
      agent_name: 'demo-fleet-science-agent',
      agent_role: 'science-agent',
      routing_label: 'totally-different-routing-label',
      agent_type: 'permanent',
      registry: { type: 'profile', user: 'groundnuty' },
    });
    const deployPhase: DeployPhaseRenderInput = {
      results: [deployedResult('science-agent', destDir)],
      checkAgentCertPresent: () => true,
      project: 'demo-fleet',
    };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, deployPhase);
    expect(text).toContain('tmux attach -t demo-fleet@totally-different-routing-label');
    expect(text).not.toContain('demo-fleet@demo-fleet-science-agent');
    expect(text).not.toContain('demo-fleet@science-agent');
  });

  it('DECISIVE two-agent case (DR-044 Decision 6, "say it once"): the explanation prints EXACTLY ONCE for the whole section, and each of TWO deployed agents gets its own correct attach line', () => {
    const codeDir = scratchDir();
    const scienceDir = scratchDir();
    writeAgentConfig(scienceDir, {
      project: 'demo-fleet',
      agent_name: 'macf-science-agent',
      agent_role: 'science-agent',
      routing_label: 'science-agent',
      agent_type: 'permanent',
      registry: { type: 'profile', user: 'groundnuty' },
    });
    const deployPhase: DeployPhaseRenderInput = {
      results: [deployedResult('code-agent', codeDir), deployedResult('science-agent', scienceDir)],
      checkAgentCertPresent: () => true,
      project: 'demo-fleet',
    };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, deployPhase);
    // The decisive assertion: the (agent-independent) explanation is NOT
    // repeated per agent — DR-044 Decision 6, "three copies of a paragraph
    // is quieter than one marker plus one footnote."
    const trustMentions = text.split('Do you trust this folder?').length - 1;
    expect(trustMentions).toBe(1);
    const channelsMentions = text.split('Loading development channels').length - 1;
    expect(channelsMentions).toBe(1);
    // Both agents still get their OWN attach line — the one agent-specific
    // piece — each with the CORRECT session name for that agent.
    expect(text).toContain('tmux attach -t demo-fleet@code-agent');
    expect(text).toContain('tmux attach -t demo-fleet@science-agent');
    // The explanation appears BEFORE either agent's attach line (read once,
    // top of the section, before the per-agent lines).
    const headerIdx = text.indexOf('Do you trust this folder?');
    const codeAttachIdx = text.indexOf('tmux attach -t demo-fleet@code-agent');
    const scienceAttachIdx = text.indexOf('tmux attach -t demo-fleet@science-agent');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeLessThan(codeAttachIdx);
    expect(headerIdx).toBeLessThan(scienceAttachIdx);
  });

  it('emits NOTHING for an agent whose deploy FAILED (no trust-dialog / tmux-attach text for an agent that never deployed)', () => {
    const deployedDir = scratchDir();
    const deployPhase: DeployPhaseRenderInput = {
      results: [
        deployedResult('code-agent', deployedDir),
        { role: 'science-agent', destDir: '/unused', outcome: { role: 'science-agent', status: 'failed', reason: 'clone failed' } },
      ],
      checkAgentCertPresent: () => true,
      project: 'demo-fleet',
    };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, deployPhase);
    // The deployed agent gets the full guidance block.
    const codeIdx = text.indexOf(`tmux attach -t demo-fleet@code-agent`);
    expect(codeIdx).toBeGreaterThan(-1);
    // The failed agent's role never appears anywhere in the launch section
    // — no guidance, no attach command, nothing implying it can be launched.
    const launchSectionIdx = text.indexOf('Next step — launch the deployed agent(s):');
    expect(launchSectionIdx).toBeGreaterThan(-1);
    expect(text.slice(launchSectionIdx)).not.toContain('science-agent');
  });

  it('omits the guidance entirely (no trust-dialog / tmux-attach text) when an agent has NO cert yet — the existing ⚠ warning bullet stands alone', () => {
    const destDir = scratchDir();
    const deployPhase: DeployPhaseRenderInput = {
      results: [deployedResult('code-agent', destDir)],
      checkAgentCertPresent: () => false,
      project: 'demo-fleet',
    };
    const text = formatApplyResult(resultWith({}), [], { steps: [] }, deployPhase);
    expect(text).toContain('no mTLS cert');
    expect(text).not.toContain('tmux attach');
    expect(text).not.toContain('Do you trust this folder');
  });
});

// --- groundnuty/macf#1184 — the fleet-level verdict, wired through the
// PUBLIC entrypoints (formatApplyResult / fleetApplyResultToJson), not just
// the standalone fleet-verdict.ts unit (see that file's own test for the
// component-level decisive pair). Proves `buildFleetVerdict`'s private
// wiring actually reaches both renders using the SAME real
// `FleetApplyResult` shape `resultWith` builds for every other test in this
// file. ---
describe('the #1184 fleet verdict, wired through formatApplyResult / fleetApplyResultToJson', () => {
  const ALL_SIX_LEGS = ['MACF_ROUTING_APP_ID', 'MACF_ROUTING_APP_KEY', 'ROUTING_CLIENT_CERT', 'ROUTING_CLIENT_KEY', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'] as const;

  function sixLegsWith(repos: readonly string[], leg: { status: string; reason?: string }): FleetApplyResult['routingSecrets'] {
    const out = {} as Record<string, Record<string, { status: string; reason?: string }>>;
    for (const name of ALL_SIX_LEGS) out[name] = Object.fromEntries(repos.map((r) => [r, leg]));
    return out as FleetApplyResult['routingSecrets'];
  }

  it('the exact macf-trial signature (whole-bag skip + zero runners + no workspace) never renders "is provisioned" as a positive claim, and names all three gaps', () => {
    const result = resultWith({
      routingSecrets: sixLegsWith(['groundnuty/trial-code', 'groundnuty/trial-science'], {
        status: 'skipped',
        reason: 'router App/routing-client cert freshly minted this run; vault write not yet confirmed',
      }),
      routing: {
        'groundnuty/trial-code': { status: 'failed', reason: 'no usable runner registered' },
        'groundnuty/trial-science': { status: 'failed', reason: 'no usable runner registered' },
      },
    });
    const remainingDeploy = {
      steps: [
        { role: 'code-agent', deployPath: '/x/code-agent', presence: 'not-deployed' as const, command: 'macf fleet deploy --agent code-agent' },
        { role: 'science-agent', deployPath: '/x/science-agent', presence: 'not-deployed' as const, command: 'macf fleet deploy --agent science-agent' },
      ],
    };

    const text = formatApplyResult(result, [], remainingDeploy);
    expect(text).not.toMatch(/\bis provisioned\b/);
    expect(text).toContain('Fleet verdict');
    expect(text).toContain('routing');
    expect(text).toContain('runners');
    expect(text).toContain('workspaces');

    const json = fleetApplyResultToJson(result, [], remainingDeploy) as { fleet_verdict: { confirmed: boolean; components: readonly { name: string; state: string }[] } };
    expect(json.fleet_verdict.confirmed).toBe(false);
    expect(json.fleet_verdict.components.map((c) => c.name).sort()).toEqual(['routing', 'runners', 'workspaces']);
  });

  it('the positive twin: everything confirmed -> a success verdict line, no "NOT confirmed" anywhere', () => {
    const result = resultWith({
      routingSecrets: sixLegsWith(['groundnuty/trial-code'], { status: 'created' }),
      routing: { 'groundnuty/trial-code': { status: 'created' } },
    });
    const text = formatApplyResult(result, [], { steps: [] });
    expect(text).toContain('Fleet verdict');
    expect(text).not.toContain('NOT confirmed');

    const json = fleetApplyResultToJson(result, [], { steps: [] }) as { fleet_verdict: { confirmed: boolean } };
    expect(json.fleet_verdict.confirmed).toBe(true);
  });
});
