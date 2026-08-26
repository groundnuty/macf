/**
 * `macf bootstrap apply` (DR-043 §D2/§D3, Slice 2b of groundnuty/macf#838).
 *
 * **`--dry-run` (unchanged, byte-identical to increments 1-3):** renders the
 * read-only plan plus the exact GitHub App-manifest documents (+ consent
 * gate 2 install URLs) that would be submitted — the DR-035 §4
 * plan-approve-once artifact, shown BEFORE any browser gate opens. Mutates
 * nothing.
 *
 * **Real apply (increment 5a — the orchestrator, THIS increment):** computes
 * the same plan, shows it plus the blast radius, obtains ONE explicit
 * operator approval (`--yes` to skip interactively, for automation), then
 * drives `apply-fleet.ts::applyFleet` — per-agent confirm-before-create
 * guard → consent gate 1 → consent gate 2 → repo-init → the single
 * whole-payload vault write → `fleet.lock`. See `apply-fleet.ts`'s module
 * doc for the full ordering rationale (why the vault write is batched, why
 * `fleet.lock` splits into two write moments) and `apply-agent.ts`'s module
 * doc for the per-agent gate-1→gate-2 window discussion. NEVER logs a
 * secret (PEM / client / webhook secret) — every render in this file reads
 * only `role`/`status`/`appId`/`installId`/`reason`/paths off the outcomes,
 * never `credentials`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { join, resolve as resolvePath } from 'node:path';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { deriveAppHandle, deriveControlRepoName, parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { FleetObserverFn, FleetPlan, FleetPlanFailure, ObservedState, OperatorInteractionBound, UnimplementedApplyItem } from '../bootstrap/plan.js';
import {
  checkVaultFlagsComplete,
  computePlan,
  fleetPlanFailureToJson,
  fleetPlanToJson,
  formatOperatorInteractionLine,
  formatPlanText,
  formatUnimplementedLines,
  operatorInteractionBudget,
  operatorInteractionToJson,
  summarizePlan,
} from '../bootstrap/plan.js';
import { githubRegistryObserver, readFleetLock } from '../bootstrap/observer.js';
import type { GitHubAppManifest } from '../bootstrap/app-manifest.js';
import { buildAppManifest, repoHomepageUrl } from '../bootstrap/app-manifest.js';
import { appInstallationUrl, confirmAppInstallation as realConfirmAppInstallation } from '../bootstrap/identity-confirm.js';
import type { ExpectedIdentity, IdentityConfirmation } from '../bootstrap/identity-confirm.js';
import { confirmBeforeCreateGuard, gate2RepoSelectionInstructionLines, installReposForIdentity, realAgentApplyDeps } from '../bootstrap/apply-agent.js';
import type { CreateGuardDecision, CreateGuardDeps } from '../bootstrap/apply-agent.js';
import { realCloneRepo, realCommitAndPush } from '../bootstrap/apply-repo-init.js';
import type { AgentRepoDeps, RepoInitStepDeps } from '../bootstrap/apply-repo-init.js';
import { applyFleet } from '../bootstrap/apply-fleet.js';
import type { ActionsPinRepoStatus, ControlRepoSyncOutcome, FleetApplyDeps, FleetApplyResult } from '../bootstrap/apply-fleet.js';
import type { ControlRepoDeps } from '../bootstrap/control-repo.js';
import { checkControlRepoMeta, realControlRepoCommitAndPush, realReadControlManifestFile } from '../bootstrap/control-repo.js';
import { realUnarchiveRepo } from '../bootstrap/repo-archive.js';
import {
  checkRepoArchivedState,
  checkRepoSecretPresence,
  checkRepoVariablePresence,
  checkRegistryVariablePresence,
  checkRunnerUsableByRepo,
  readRegistryVariable,
} from '../bootstrap/observer.js';
import { realCreateRepo } from '../bootstrap/repo-create.js';
import type { CaApplyDeps } from '../bootstrap/apply-ca.js';
import { realCreateRegistryVariable, realCreateRepoVariable, realMintCa } from '../bootstrap/apply-ca.js';
import type { EnsureVariableOutcome } from '../bootstrap/ensure-variable.js';
import type { RoutingClientApplyDeps } from '../bootstrap/apply-routing-client.js';
import { realMintRoutingClient, realSetRepoSecret } from '../bootstrap/apply-routing-client.js';
import type { ResolvedTsOauth, RoutingSecretsPublishDeps } from '../bootstrap/apply-routing-secrets.js';
import {
  checkTailscaleOauthPreflight,
  checkTsOauthFlagsComplete,
  resolvedTsOauthPair,
  TS_OAUTH_CLIENT_ID_ENV_VAR,
  TS_OAUTH_SECRET_ENV_VAR,
} from '../bootstrap/apply-routing-secrets.js';
import type { RunnerRegistrationDeps } from '../bootstrap/apply-routing.js';
import { checkRunnerTokenPreflight, RUNNER_TOKEN_ENV_VAR } from '../bootstrap/apply-routing.js';
import {
  readVault,
  vaultAgentPrivateKeyPem,
  vaultCaCertPem,
  vaultRoutingClientCertPem,
  vaultRoutingClientKeyPem,
  vaultRouterAppId,
  vaultRouterAppKeyPem,
  vaultTsOauthClientId,
  vaultTsOauthSecret,
  vaultRunnerOpsPrivateKeyPem,
} from '../bootstrap/vault-read.js';
import type { VaultReadOptions } from '../bootstrap/vault-read.js';
import type { LabelsOutcome } from './repo-init.js';
import type { AppNameLengthCheck, RunnerOpsApplyOutcome } from '../bootstrap/apply-runner-ops.js';
import { RUNNER_OPS_ROLE, buildRunnerOpsManifest, checkAppNameLengths, deriveRunnerOpsHandle } from '../bootstrap/apply-runner-ops.js';
import { ROUTER_APP_ROLE, buildRouterAppManifest, deriveRouterAppHandle, routerAppInstallRepos } from '../bootstrap/apply-router-app.js';
import { defaultOperatorRecoveryRootDir, operatorRecoveryArtifactPath } from '../bootstrap/vault-write.js';
import { checkRegistryScopePreflight } from '../bootstrap/registry-scope-preflight.js';
import type { DeployFlagsEcho, RemainingDeployReport, RemainingDeployStep } from '../bootstrap/remaining-deploy.js';
import { computeRemainingDeploy, formatRemainingDeployLines } from '../bootstrap/remaining-deploy.js';
import type { ApplyDeployPhaseDeps, DeployPhaseAgentResult } from '../bootstrap/apply-deploy.js';
import { anyDeployFailed, runApplyDeployPhase } from '../bootstrap/apply-deploy.js';
import { realAuthenticatedCloneRepo, realMintCloneToken, deployAgent as realDeployAgent } from '../bootstrap/fleet-deploy.js';
// DR-043 Amendment L (macf#1045) — the version-reconcile phase; production
// deps mirror `commands/fleet-upgrade.ts::resolveDepsFromConfig`'s discover
// + driver + npm-latest wiring, minus the `readAgentConfig(projectDir)`
// requirement (apply already knows its ONE fleet — the manifest's own).
import { upgradeFleets, type FleetDriver, type WorkspaceRecord } from '@groundnuty/macf-core';
import type { ApplyVersionPhaseDeps, ApplyVersionPhaseResult } from '../bootstrap/apply-version.js';
import { runApplyVersionPhase } from '../bootstrap/apply-version.js';
import { discoverWorkspaces } from '../discovery.js';
import { createVmDriverFromConfig } from '../fleet/vm-driver.js';
import { fetchLatestCliVersion } from '../version-resolver.js';
import { buildRecordDeployedVersion } from '../bootstrap/fleet-lock-recorder.js';
import { firstLaunchGuidanceHeaderLines, firstLaunchAttachLine } from '../bootstrap/first-launch-guidance.js';
import { outcomeToJson as fleetDeployOutcomeToJson } from './fleet-deploy.js';
import { initAgent as realInitAgent } from './init.js';
import { agentCertPath, agentKeyPath } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * The redirect URL shown in a dry-run. The REAL one carries the ephemeral
 * listener's port, chosen at exchange time — a dry run binds nothing, so it
 * renders this placeholder rather than pretending to hold a port.
 */
export const DRY_RUN_REDIRECT_PLACEHOLDER = 'http://localhost:<port-chosen-at-apply-time>/callback';

export interface RunBootstrapApplyOptions {
  readonly file: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  /** Skip the interactive plan-approval prompt (DR-035 §4 plan-approve-once — this is the one non-interactive escape). */
  readonly yes?: boolean;
  /**
   * Vault-aware confirm-before-create (DR-043 Amendment A, macf#913) —
   * mirrors `bootstrap plan`'s own `--vault`/`--identity-key` pair
   * (`commands/bootstrap.ts`, `plan.ts::checkVaultFlagsComplete`). When BOTH
   * are given, `apply` decrypts the vault in memory, recovers each agent's
   * PEM, and confirms a role WITH a prior `fleet.lock` entry live against
   * GitHub BEFORE deciding whether to open consent gate 1 — a confirmed App
   * is reused, gate 1 is never opened (`resolveMutateDeps`'s `resolveKeyPath`
   * wiring, consumed by `apply-agent.ts::confirmBeforeCreateGuard`).
   * Omitting either (the default, unchanged behaviour) keeps `apply` exactly
   * as it was before this flag existed. Half-given is refused loud.
   */
  readonly vaultPath?: string;
  readonly identityKeyPath?: string;
  /**
   * `--runner-token` (macf#929) — the CLI-flag form of the register-before-
   * route POLICY gate `apply-routing.ts::publishTrustedActorsGated` enforces.
   * `undefined` here does NOT necessarily mean "no token": `runBootstrapApply`
   * falls back to the {@link RUNNER_TOKEN_ENV_VAR} env var when this is unset
   * (CLI flag wins on conflict) — see the resolution right after the
   * manifest is parsed, shared by BOTH the macf#932 pre-flight refusal
   * (before consent gate 1) AND `resolveMutateDeps`. NEVER logged, NEVER
   * copied onto any rendered result (mirrors `FleetApplyDeps.runnerToken`'s
   * own doc).
   */
  readonly runnerToken?: string;
  /**
   * `--ts-oauth-client-id` (groundnuty/macf#1186) — the CLI-flag form of a
   * SECOND operator-supplied source for `TS_OAUTH_CLIENT_ID`, alongside the
   * vault (`#1109`). `undefined` here does NOT necessarily mean "not
   * supplied": `runBootstrapApply` falls back to {@link TS_OAUTH_CLIENT_ID_ENV_VAR}
   * when this is unset (CLI flag wins on conflict) — same resolution shape
   * `runnerToken`'s own doc establishes. Must be given TOGETHER with
   * `tsOauthSecret` (or neither) — see `checkTsOauthFlagsComplete`. NEVER
   * logged, NEVER written to `fleet.yaml` or `vault.age`, NEVER copied onto
   * any rendered result.
   */
  readonly tsOauthClientId?: string;
  /** The pair to {@link tsOauthClientId} — same resolution/XOR/never-logged contract. Falls back to {@link TS_OAUTH_SECRET_ENV_VAR}. */
  readonly tsOauthSecret?: string;
  /**
   * `--no-deploy` (macf#1013) — commander's `--no-<flag>` convention: the
   * CLI registration carries NO explicit 3rd-arg default (macf#347 — a
   * `--no-` flag with an explicit default silently pins the option
   * always-true/always-false regardless of what's on the command line), so
   * `opts.deploy` is `true` unless `--no-deploy` was actually passed.
   * `undefined` here (a caller that never set the field at all, e.g. every
   * pre-#1013 test) behaves identically to `true` — deploy is attempted by
   * default, per the operator's own directive: *"Deployment should be
   * default, definitely."* Explicit `false` restores the pre-#1013,
   * GitHub-phase-only behaviour byte-for-byte — for multi-host fleets, and
   * for operators who want the two phases apart (the operator's own words:
   * *"I very much like and respect this separation"* — `--no-deploy` is how
   * that separation stays available, not how it's removed).
   */
  readonly deploy?: boolean;
}

export interface BootstrapApplyDeps {
  readonly observe: FleetObserverFn;
  /**
   * Injectable seam for tests (macf#913) — real default is
   * `vault-read.ts::readVault`. Never invoked unless BOTH `opts.vaultPath`
   * and `opts.identityKeyPath` were given (see `checkVaultFlagsComplete`).
   */
  readonly readVault?: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>;
  /**
   * Injectable seam for tests (macf#913) — real default is
   * `identity-confirm.ts::confirmAppInstallation`. Used ONLY by the
   * `--dry-run` / pre-approval vault-aware PREVIEW (a read-only GET,
   * consistent with `--dry-run`'s "mutates nothing" contract); the real
   * mutating path gets its OWN copy via `resolveMutateDeps`'s
   * `buildAgentDeps` — this seam never influences what apply actually does.
   */
  readonly confirmAppInstallation?: (appId: string, keyPath: string, expected?: ExpectedIdentity) => Promise<IdentityConfirmation>;
  /**
   * Injectable filesystem-existence check for the DR-043 §D2 "honest
   * completion" remaining-deploy report (macf#1014,
   * `remaining-deploy.ts::computeRemainingDeploy`'s seam). Defaults to a
   * real `existsSync`. Tests inject a fake so the decisive "no workspaces" /
   * "already deployed" / "unknown" scenarios don't depend on real host
   * filesystem state — mirrors `findAvailableRecoveryArtifacts`'s own
   * injectable-`exists` parameter in this same file.
   */
  readonly checkDeployPathExists?: (path: string) => boolean;
  /**
   * Injectable deploy-phase deps (macf#1013) — the SAME `ApplyDeployPhaseDeps`
   * shape `apply-deploy.ts::runApplyDeployPhase` takes (which itself mirrors
   * `commands/fleet-deploy.ts::FleetDeployCommandDeps`). `undefined` (the
   * production default) resolves to REAL functions — see
   * `resolveApplyDeployDeps()` below: real network clone, a real minted
   * installation token, the real `macf init`. **Tests that reach the deploy
   * phase (vault flags given, `opts.deploy !== false`, control repo not
   * aborted) MUST override this to hermetic fakes** — same "tests MUST
   * override" posture `FleetDeployDeps.mintCloneToken`'s own doc establishes
   * for `commands/fleet-deploy.ts`'s tests; the fixture `deploy_path`s in
   * this file's tests are real-looking absolute paths (`/home/ubuntu/repos/
   * demo-code`), never a scratch dir, precisely so a forgotten override here
   * fails loud (real clone / real CA-materialize under the actual test
   * runner's home dir) rather than silently touching a real path.
   */
  readonly deployDeps?: ApplyDeployPhaseDeps;
  /**
   * Injectable version-reconcile-phase deps (DR-043 Amendment L, macf#1045)
   * — the SAME `ApplyVersionPhaseDeps` shape `apply-version.ts::
   * runApplyVersionPhase` takes. `undefined` (the production default)
   * resolves to REAL functions — see `resolveApplyVersionDeps()` below: real
   * host-workspace discovery, a real VM driver, real npm-latest (defensive-
   * only — structurally unreachable once `versions.macf` is declared, per
   * Amendment L3). **Tests whose fixture manifest declares `versions:` MUST
   * override this to hermetic fakes** — same "tests MUST override" posture
   * `deployDeps`'s own doc establishes; this phase runs UNCONDITIONALLY
   * (no vault-flag gate — see `apply-version.ts`'s module doc for why) so a
   * forgotten override here reaches real `discoverWorkspaces()` /
   * `createVmDriverFromConfig()` against the actual test-runner host.
   */
  readonly versionDeps?: ApplyVersionPhaseDeps;
  /**
   * Ground-truth mTLS-cert-present check for the "Next step: launch" render
   * (macf#1013 requirement 5 — "the final output names `./claude.sh`, not
   * `fleet deploy`, for a fully-deployed local fleet"). Mirrors
   * `commands/fleet-deploy.ts::FleetDeployCommandDeps.checkAgentCertPresent`'s
   * own doc + default exactly (`agentCertPath`/`agentKeyPath(destDir)`
   * existence) — checked AFTER the deploy phase, reflecting whatever
   * actually landed on disk regardless of which path produced it.
   */
  readonly checkAgentCertPresent?: (destDir: string) => boolean;
}

/** Extends `apply-fleet.ts`'s `FleetApplyDeps` with the three apply-CLI-level seams: the plan-approval prompt, the prior-lock read, and vault-scratch cleanup. */
export interface MutateApplyDeps extends FleetApplyDeps {
  readonly confirmPlan: (plan: FleetPlan, creations: readonly PlannedAppCreation[]) => Promise<boolean>;
  readonly readPriorLock: (manifestPath: string) => ReturnType<typeof readFleetLock>;
  /**
   * Cleanup for any vault-derived scratch PEM file(s) `resolveMutateDeps`'s
   * `resolveKeyPath` closure wrote this run (macf#913) — see that function's
   * doc. `undefined`/omitted is a no-op (vault-aware confirm wasn't
   * configured this run, or a test's fake deps don't need one).
   * `runBootstrapApply` ALWAYS invokes it in a `finally`, so a scratch PEM
   * never outlives the run regardless of how `applyFleet` exits.
   */
  readonly cleanupVaultScratch?: () => void;
}

/** One agent's would-be App creation, paired with the plan item that motivated it. */
export interface PlannedAppCreation {
  readonly role: string;
  readonly repo: string;
  readonly manifest: GitHubAppManifest;
  /**
   * Consent gate 2 (§D2 point 2) — the install-page URL the operator would
   * open, once this App exists. PREDICTED from `deriveAppHandle` (this App
   * doesn't exist yet at dry-run/approval-preview time, so there is no real
   * GitHub-assigned slug to read). GitHub slugifies the submitted manifest
   * `name` and may append a disambiguating suffix on a global collision —
   * the REAL apply path (`apply-agent.ts`) uses the exchange's returned
   * `AppCredentials.slug` instead, never re-derives it.
   */
  readonly installUrl: string;
  /**
   * The EXACT repos consent gate 2 needs selected (groundnuty/macf#952) —
   * same derivation `apply-agent.ts::installReposForIdentity` uses for the
   * real gate-2 interstitial, so the dry-run preview and the live gate never
   * describe the scope differently. Never the phrase "this fleet's repos" —
   * see `formatPlannedAppCreations`'s doc for why.
   */
  readonly installRepos: readonly string[];
}

/**
 * Which agents would get an App created, given a computed plan. Pure. An agent
 * whose `app` item is `noop` is NOT re-created — the confirm-before-create
 * guard (`apply-agent.ts::confirmBeforeCreateGuard`) additionally re-checks
 * live before any create actually fires.
 */
export function plannedAppCreations(
  manifest: FleetManifest,
  plan: FleetPlan,
  redirectUrl: string,
): readonly PlannedAppCreation[] {
  const creating = new Set(
    plan.items.filter((i) => i.kind === 'app' && i.verb === 'create').map((i) => i.target),
  );
  const out: PlannedAppCreation[] = [];
  for (const agent of manifest.agents) {
    const target = `agent:${agent.role}:app:${deriveAppHandle(manifest.metadata.name, agent.role)}`;
    if (!creating.has(target)) continue;
    const appManifest = buildAppManifest({
      fleetName: manifest.metadata.name,
      role: agent.role,
      redirectUrl,
      homepageUrl: repoHomepageUrl(agent.repo),
    });
    out.push({
      role: agent.role,
      repo: agent.repo,
      manifest: appManifest,
      installUrl: appInstallationUrl(appManifest.name),
      installRepos: installReposForIdentity(agent.role, manifest),
    });
  }

  // groundnuty/macf#943 — the runner-ops App, a fleet-level `create`
  // candidate (`plan.ts::runnerOpsItem`), rendered here so the SAME
  // "exact manifest sent" preview every agent App already gets also covers
  // this one (its 3-permission set, its scoped-install caveat) BEFORE the
  // operator spends the two consent-gate clicks. `repo: ''` — this App has
  // no home repo; `formatPlannedAppCreations` below renders it as `(fleet-
  // level, no home repo)` rather than an empty string.
  const runnerOpsCreating = plan.items.some((i) => i.kind === 'runner_ops' && i.verb === 'create');
  if (runnerOpsCreating) {
    // Same homepage the REAL apply path will submit (`apply-fleet.ts`'s
    // `repoHomepageUrl(controlRepo.repo)`) — derived without any I/O since
    // both `owner.account` and the control-repo NAME are pure functions of
    // the manifest (`deriveControlRepoName`), so the preview and the real
    // submission never diverge on this field.
    const rrHomepage = repoHomepageUrl(`${manifest.owner.account}/${deriveControlRepoName(manifest.metadata.name)}`);
    const rrManifest = buildRunnerOpsManifest(manifest.metadata.name, redirectUrl, rrHomepage);
    out.push({
      role: RUNNER_OPS_ROLE,
      repo: '',
      manifest: rrManifest,
      installUrl: appInstallationUrl(deriveRunnerOpsHandle(manifest.metadata.name)),
      // No `manifest.agents[]` entry matches `RUNNER_OPS_ROLE` (by design —
      // see `apply-runner-ops.ts`'s doc), so `installReposForIdentity` falls
      // through to its "every declared agent repo" branch — same derivation
      // the live gate-2 interstitial uses.
      installRepos: installReposForIdentity(RUNNER_OPS_ROLE, manifest),
    });
  }

  // groundnuty/macf#1105 — the router App, a fleet-level `create` candidate
  // (`plan.ts::routerAppItem`), rendered here so the operator sees the exact
  // manifest + install target BEFORE spending its 2 consent-gate clicks —
  // the SAME disclosure `runnerOpsCreating` above already gives runner-ops.
  // `apply-router-app.ts::buildRouterAppManifest`'s doc used to call this
  // render "NOT yet wired there" — this is that wiring. `repo: ''` — this
  // App also has no home repo (its install target is the fleet's REGISTRY,
  // never an agent repo — `routerAppInstallRepos`'s doc); rendered the same
  // way `formatPlannedAppCreations` already renders runner-ops.
  const routerAppCreating = plan.items.some((i) => i.kind === 'router_app' && i.verb === 'create');
  if (routerAppCreating) {
    const routerAppScope = manifest.transport.router_app_scope === 'per-fleet' ? 'per-fleet' : 'shared';
    const routerAppHandle = deriveRouterAppHandle(manifest.metadata.name, manifest.owner.account, routerAppScope);
    // Same homepage derivation the runner-ops block above uses (this App
    // also has no home repo of its own).
    const routerHomepage = repoHomepageUrl(`${manifest.owner.account}/${deriveControlRepoName(manifest.metadata.name)}`);
    const routerManifest = buildRouterAppManifest(manifest.metadata.name, manifest.owner.account, redirectUrl, routerHomepage, routerAppScope);
    out.push({
      role: ROUTER_APP_ROLE,
      repo: '',
      manifest: routerManifest,
      installUrl: appInstallationUrl(routerAppHandle),
      // `routerAppInstallRepos` — the fleet's registry target, never an
      // agent repo (see that function's doc) — NOT `installReposForIdentity`
      // (which has no concept of this identity's real install target).
      installRepos: routerAppInstallRepos(manifest),
    });
  }

  return out;
}

/**
 * The section header for {@link formatPlannedAppCreations} (pure, exported
 * for tests) — extracted to keep that function under this codebase's
 * function-length convention. `bound` is `operatorInteractionBudget`'s OWN
 * `'exact'`/`'maximum'` distinction — the SAME source
 * {@link formatOperatorInteractionLine}'s own trailing budget line already
 * derives its ceiling framing from (groundnuty/macf#1165's "derive from one
 * source" requirement: this header must not invent a SEPARATE condition for
 * whether it is overstating). `'exact'` cannot occur while `count > 0`
 * (`operatorInteractionBudget`'s own contract: zero on both counts is the
 * only exact case), but branching on the field — rather than hardcoding the
 * ceiling framing — means a future change to that contract cannot silently
 * leave this header overstating without also failing loudly here.
 *
 * `excludedRoles` names any role dropped from `creations` because a
 * recovery artifact for it already exists (see
 * {@link recoveryResumableRoles}) — named explicitly rather than silently
 * vanished from the count, so an operator counting agents against the
 * header total is never left one short with no explanation.
 */
export function formatAppCreationsHeader(count: number, bound: OperatorInteractionBound, excludedRoles: readonly string[]): string {
  const plural = count === 1 ? '' : 's';
  const excludedNote =
    excludedRoles.length === 0
      ? ''
      : ` Not counted here (each already has a recovery artifact — its App exists; apply resumes its install rather than creating it): ${excludedRoles.join(', ')}.`;
  if (bound === 'exact') {
    return `GitHub App${plural} that would be created (${String(count)}) — consent gate 1 (§D2), one operator click each:${excludedNote}`;
  }
  return (
    `Up to ${String(count)} GitHub App${plural} may be created — consent gate 1 (§D2), one operator click each. This is a ceiling, ` +
    'not a promise: an App this preview could not confirm already exists still counts here, and the live gate is authoritative on ' +
    `which repos (if any) are still needed.${excludedNote}`
  );
}

/**
 * Human render of the would-be App creations (pure — exported for tests).
 * `gate2InstallOnly` (groundnuty/macf#880) is the count of roles the
 * vault-aware preview confirmed `'resume-install'` for — an App exists
 * (gate 1 SKIPPED) but has ZERO installs, so gate 2 still runs
 * (`apply-agent.ts::runGate2WithInterstitial`'s doc). Those roles are
 * already excluded from `creations` (`filterCreationsByPreview` drops every
 * non-`'create'` decision — correctly, for gate 1), so `creations.length`
 * ALONE would silently drop their gate-2 cost; this parameter recovers it.
 * Defaults to 0 (no preview ran, or nothing resume-eligible) — every
 * pre-#880-preview call site stays byte-identical.
 *
 * `excludedRecoveryRoles` (groundnuty/macf#1165, defaults to `[]` — every
 * pre-this-issue call site stays byte-identical) names roles the CALLER
 * already dropped from `creations` via {@link recoveryResumableRoles} —
 * this function never re-derives the exclusion itself, only renders the
 * caller's own decision (this issue's "derive from one source"
 * requirement).
 */
export function formatPlannedAppCreations(
  creations: readonly PlannedAppCreation[],
  gate2InstallOnly = 0,
  excludedRecoveryRoles: readonly string[] = [],
): string {
  // groundnuty/macf#880 — the operator's consent-click budget, projected
  // from `creations` itself (already the vault-aware-filtered list when a
  // preview ran — see `filterCreationsByPreview`'s doc) plus any
  // resume-install-only gate-2 flows the caller counted separately: no new
  // observation, just naming what this run's own decisions already imply.
  // Appended to BOTH branches so it shows up identically on `--dry-run` and
  // the real pre-approval render (both call this same function — see the
  // call sites below).
  const budget = operatorInteractionBudget(creations.length, creations.length + gate2InstallOnly);
  const budgetLine = formatOperatorInteractionLine(budget);
  if (creations.length === 0) {
    const excludedNote =
      excludedRecoveryRoles.length === 0
        ? ''
        : ` (${excludedRecoveryRoles.join(', ')} excluded — each already has a recovery artifact; apply resumes rather than creates.)`;
    return `No GitHub Apps would be created (every declared agent already has one, or presence is confirmed).${excludedNote}\n${budgetLine}`;
  }
  const parts: string[] = [formatAppCreationsHeader(creations.length, budget.bound, excludedRecoveryRoles), ''];
  for (const c of creations) {
    // groundnuty/macf#943 — the runner-ops has no home repo (`c.repo === ''`).
    parts.push(`  • ${c.manifest.name}   (role: ${c.role}, home repo: ${c.repo === '' ? '(fleet-level, no home repo)' : c.repo})`);
    const perms = Object.entries(c.manifest.default_permissions)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    // groundnuty/macf#943 — the runner-ops's set is DR-019-DISJOINT by
    // design (see `apply-runner-ops.ts::RUNNER_OPS_PERMISSIONS`'s doc);
    // groundnuty/macf#1105 — the router App's set is ALSO DR-019-DISJOINT +
    // ONE-WAY-RATCHET, for the identical export-class-key reason (see
    // `apply-router-app.ts::ROUTER_APP_PERMISSIONS`'s doc); labeling either
    // "(DR-019)" here would misrepresent it as the derived agent set.
    const permsLabel =
      c.role === RUNNER_OPS_ROLE || c.role === ROUTER_APP_ROLE ? 'permissions (ONE-WAY RATCHET — never widen)' : 'permissions';
    parts.push(`      ${permsLabel}: ${perms}`);
    parts.push(`      events: ${c.manifest.default_events.join(', ')}`);
    parts.push(`      public: ${String(c.manifest.public)}   webhook active: ${String(c.manifest.hook_attributes.active)}`);
    parts.push(`      consent gate 2 (install, after gate 1 creates the App): ${c.installUrl}`);
    // groundnuty/macf#952 — the literal repo names, never "this fleet's
    // repos": a class description isn't actionable at GitHub's repo-picker
    // dropdown. `c.installRepos` is the SAME derivation the live gate-2
    // interstitial renders (`installReposForIdentity` for ordinary agents
    // and runner-ops; `routerAppInstallRepos` for the router App —
    // groundnuty/macf#1105), and `install-scope.ts` enforces the SAME
    // post-gate-2 refusal for every one of them (groundnuty/macf#1128 —
    // this warning used to be shown ONLY for runner-ops/the router App,
    // because they were the only two types that check-with-refusal applied
    // to; now that every App type does, the preview shows it for every
    // planned creation, not a subset).
    //
    // groundnuty/macf#1173 — the two lines below are `gate2RepoSelectionInstructionLines`
    // VERBATIM (the exact wording the live gate-2 terminal + served
    // interstitial also print), not this preview's own paraphrase. Before
    // this fix the paraphrase ("NEVER" vs "NOT", one sentence vs two) was a
    // fifth independently-authored copy of this instruction — found during
    // this issue's own enumeration requirement, alongside the four sites
    // #1156/#1164/#1168 already closed.
    for (const line of gate2RepoSelectionInstructionLines(c.installRepos)) {
      parts.push(`      ⚠ ${line}`);
    }
  }
  parts.push('', budgetLine);
  return parts.join('\n');
}

// --- Vault-aware identity confirm — DR-043 Amendment A (macf#913) ---
//
// The false-promise this closes: through DR-043 Amendment D phase 3, ONLY
// `plan` had `--vault`/`--identity-key` — `apply` had no such flags at all,
// so `plan`'s own "a vault-aware confirm runs during apply" text
// (`plan.ts::UNKNOWN_REASONS.identity`, fixed alongside this change) was
// simply false. Consequence for a fleet whose App already exists but is
// unconfirmable (the state after `macf fleet archive` + revival — DR-043
// Amendment G): apply had no way to reuse it, so a role WITH a prior
// `fleet.lock` entry fell all the way to `skip-unverified`
// (`apply-agent.ts::confirmBeforeCreateGuard`'s existing, ALREADY-BUILT
// `resolveKeyPath` seam — its own doc names this exact gap: "A future
// increment wires this to the age-decrypted vault"). This section IS that
// increment.

/**
 * Decrypt `opts.vaultPath`/`opts.identityKeyPath` (when BOTH given) into a
 * per-ROLE PEM map — the shared vault-aware-confirm precondition for BOTH
 * `--dry-run`'s preview and the real mutating path's confirm-before-create
 * guard. `undefined` means "vault-aware confirm is NOT engaged this run" —
 * either because the flags weren't given (the vault-free default, unchanged
 * behaviour) OR because the decrypt failed.
 *
 * **Amendment A's honest-unknown floor applies to the failure case too:** a
 * failed decrypt must never be read as "no App exists" nor fabricate a false
 * "confirmed" — it degrades to EXACTLY the pre-macf#913 behaviour
 * (fleet.lock-driven skip-unverified/create), the same floor
 * `vaultAwareObserver` already establishes for `plan`. The causing error is
 * logged via `log` (never `console.error`/`console.log` directly — this
 * function has no opinion on whether the caller is mid-`--json` render) so
 * the operator sees WHY vault-aware confirm didn't engage rather than
 * silence; every `VaultError` message from `vault-read.ts` is pre-scrubbed
 * of secret material at the source (see that module's doc), so logging it
 * verbatim is safe — never a PEM, client secret, or webhook secret.
 *
 * **The runner-ops entry (groundnuty/macf#954).** The map is keyed by ROLE,
 * and `manifest.agents[]` is NOT a complete role enumeration — it never
 * contains `'runner-ops'` (a fleet-level identity, never declared there; see
 * `apply-runner-ops.ts`'s module doc). Looping only `manifest.agents` here
 * used to mean this map could NEVER carry a runner-ops PEM regardless of
 * what the vault actually held, so `resolveMutateDeps`'s `resolveKeyPath`
 * closure below (itself entirely role-agnostic — a plain `map.get(role)`)
 * had nothing to return for that one role, and `confirmBeforeCreateGuard`
 * fell to `skip-unverified` for runner-ops even with both flags supplied.
 * This is the SAME "not a complete role enumeration" gap groundnuty/macf#953
 * found in teardown's App list — resolved here by adding the runner-ops PEM
 * as an EXPLICIT lookup alongside the loop, not by trying to make the loop
 * itself exhaustive over roles the manifest structurally cannot declare.
 * Exported for direct unit testing (macf#954) — mirrors `resolveMutateDeps`'s
 * own export precedent.
 */
export async function resolveVaultAgentPems(
  manifest: FleetManifest,
  vaultOpts: Pick<RunBootstrapApplyOptions, 'vaultPath' | 'identityKeyPath'>,
  doReadVault: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>,
  log: (line: string) => void,
): Promise<ReadonlyMap<string, string> | undefined> {
  if (vaultOpts.vaultPath === undefined || vaultOpts.identityKeyPath === undefined) return undefined;

  let raw: Readonly<Record<string, string>>;
  try {
    raw = await doReadVault({ vaultPath: vaultOpts.vaultPath, identityPath: vaultOpts.identityKeyPath });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `Vault-aware confirm UNAVAILABLE this run — ${reason} — falling back to the vault-free confirm-before-create ` +
        'guard (this is NOT evidence any App is absent, only that the vault could not be read).',
    );
    return undefined;
  }

  const pems = new Map<string, string>();
  for (const agent of manifest.agents) {
    const pem = vaultAgentPrivateKeyPem(raw, manifest.metadata.name, agent.role);
    if (pem !== undefined) pems.set(agent.role, pem);
  }
  // groundnuty/macf#954 — the explicit runner-ops lookup this doc's "The
  // runner-ops entry" section explains. `RUNNER_OPS_ROLE` (not a hand-typed
  // 'runner-ops' literal) so this can never drift from the SAME constant
  // `apply-fleet.ts` keys its `currentLock?.agents.find(...)`/
  // `pendingCreatedUpdates` lookups on for this role.
  const runnerOpsPem = vaultRunnerOpsPrivateKeyPem(raw, manifest.metadata.name);
  if (runnerOpsPem !== undefined) pems.set(RUNNER_OPS_ROLE, runnerOpsPem);
  // groundnuty/macf#1074 — the SAME gap #954 closed for runner-ops,
  // reopened for the router App: `manifest.agents[]` never contains
  // `ROUTER_APP_ROLE` either (`apply-router-app.ts`'s module doc), so
  // without this explicit lookup a vault-confirmable router App (a
  // `'reused'`/`'resumed-install'` outcome with both --vault/--identity-key
  // supplied) would fall all the way to `skip-unverified` even with a
  // decryptable key sitting right there — unlike `vaultRunnerOpsPrivateKeyPem`
  // (which is fleet-name-segmented, since a runner-ops key lives under
  // `MACF_RUNNER_OPS_<seg>_*`), `vaultRouterAppKeyPem` reads a FLAT key
  // (`MACF_ROUTING_APP_KEY_B64`, unsegmented — see that function's own doc)
  // so it takes no `manifest.metadata.name` argument.
  const routerAppPem = vaultRouterAppKeyPem(raw);
  if (routerAppPem !== undefined) pems.set(ROUTER_APP_ROLE, routerAppPem);
  return pems;
}

/**
 * Preview what `confirmBeforeCreateGuard` would decide for every agent —
 * NEVER mutates (`confirmAppInstallation` is a read-only `GET`, consistent
 * with `--dry-run`'s "mutates nothing" contract). Consulted by BOTH
 * `--dry-run` (requirement: "surface which path it would take, before
 * spending a click," macf#913) and the real mutating path's pre-approval
 * render, so an operator never sees "N Apps would be created" when some
 * would actually be silently reused.
 *
 * **This is a best-effort EXPLANATION, not the source of truth for what
 * apply will do.** `prior` here comes from `observed.lock` — whatever
 * `fleet.lock` this run's OBSERVER could see (the SAME source `plan.ts`'s
 * own `app`/`install` items already read; for the default
 * `githubRegistryObserver` that's the OPERATOR's LOCAL manifest directory,
 * per that module's doc). The REAL apply-time decision is made
 * independently inside `applyFleet` (via `resolveMutateDeps`'s
 * `resolveKeyPath` wiring), using `fleet.lock` freshly re-read from the
 * control-repo's OWN clone — which can see MORE than this preview when the
 * operator's local directory has no copy (e.g. an archived-then-revived
 * fleet whose lock lives only in `<fleet>-control`, never locally cloned;
 * see `apply-fleet.ts`'s own "self-heal" comment). A stale/absent preview
 * therefore never blocks or misdirects the real run — worst case it
 * under-reports a reuse the real run still gets right.
 */
async function previewIdentityDecisions(
  manifest: FleetManifest,
  observed: ObservedState,
  vaultAgentPems: ReadonlyMap<string, string>,
  confirmAppInstallation: CreateGuardDeps['confirmAppInstallation'],
): Promise<ReadonlyMap<string, CreateGuardDecision>> {
  const scratchDirs: string[] = [];
  const resolveKeyPath = (role: string): string | undefined => {
    const pem = vaultAgentPems.get(role);
    if (pem === undefined) return undefined;
    const dir = mkdtempSync(join(tmpdir(), `macf-bootstrap-vault-preview-${role}-`));
    scratchDirs.push(dir);
    const path = join(dir, 'key.pem');
    writeFileSync(path, pem, { mode: 0o600 });
    return path;
  };

  const out = new Map<string, CreateGuardDecision>();
  try {
    for (const agent of manifest.agents) {
      const prior = observed.lock?.agents.find((a) => a.role === agent.role);
      const expected: ExpectedIdentity = {
        appSlug: deriveAppHandle(manifest.metadata.name, agent.role),
        accountLogin: manifest.owner.account,
      };
      const decision = await confirmBeforeCreateGuard(agent.role, prior, expected, { confirmAppInstallation, resolveKeyPath });
      out.set(agent.role, decision);
    }
  } finally {
    for (const dir of scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort — never let scratch-file cleanup mask the preview result */
      }
    }
  }
  return out;
}

/** Drop a planned creation whose vault-aware preview says it would NOT actually be created — reused, resumable, drifted, or refused-unverified all mean "gate 1 will not open for this role." Pure. */
function filterCreationsByPreview(
  creations: readonly PlannedAppCreation[],
  preview: ReadonlyMap<string, CreateGuardDecision>,
): readonly PlannedAppCreation[] {
  return creations.filter((c) => (preview.get(c.role)?.action ?? 'create') === 'create');
}

/**
 * Count of roles the preview confirmed `'resume-install'` for — an App
 * exists live (gate 1 SKIPPED) with ZERO installs, so gate 2 still runs
 * (groundnuty/macf#880; see `formatPlannedAppCreations`'s `gate2InstallOnly`
 * doc for the full rationale). `'resume-install'`-shaped roles are already
 * excluded from `filterCreationsByPreview`'s output, so this is how the
 * caller recovers their gate-2-only cost before rendering the budget.
 */
function countResumeInstallFlows(preview: ReadonlyMap<string, CreateGuardDecision> | undefined): number {
  if (preview === undefined) return 0;
  let n = 0;
  for (const decision of preview.values()) {
    if (decision.action === 'resume-install') n += 1;
  }
  return n;
}

/** One `<role>: <PATH>` line for {@link formatIdentityPreview} — never a credential value (`CreateGuardDecision` carries none). */
function formatIdentityDecisionLine(role: string, decision: CreateGuardDecision): string {
  switch (decision.action) {
    case 'create':
      return `  • ${role}: CREATE — no confirmed prior App; consent gate 1 WILL open.`;
    case 'reuse-confirmed':
      return (
        `  • ${role}: REUSE — confirmed live (app_id ${decision.install.appId}, install_id ` +
        `${decision.install.installId}); consent gate 1 will be SKIPPED.`
      );
    case 'resume-install':
      return `  • ${role}: RESUME INSTALL — app_id ${decision.appId} exists with zero installs; gate 1 will be SKIPPED, gate 2 (install) will run.`;
    case 'skip-unverified':
      return `  • ${role}: SKIP (unverified) — ${decision.reason}`;
    case 'drift':
      return `  • ${role}: DRIFT — ${decision.reason}`;
  }
}

/** Human render of the vault-aware confirm-before-create preview (macf#913) — never a credential value. */
export function formatIdentityPreview(decisions: ReadonlyMap<string, CreateGuardDecision>): string {
  return [
    'Vault-aware identity confirm — which path each agent would take:',
    ...[...decisions.entries()].map(([role, decision]) => formatIdentityDecisionLine(role, decision)),
  ].join('\n');
}

/** `--json` render of the preview — never a credential value (every `CreateGuardDecision` variant carries only role/status/appId/installId/reason/installs, verified against `apply-agent.ts`'s own union). */
function identityPreviewToJson(decisions: ReadonlyMap<string, CreateGuardDecision>): unknown {
  return Object.fromEntries([...decisions.entries()].map(([role, decision]) => [role, { ...decision }]));
}

function renderFailure(failure: FleetPlanFailure, opts: RunBootstrapApplyOptions): number {
  console.error(failure.message);
  if (opts.json) {
    console.log(JSON.stringify(fleetPlanFailureToJson(failure), null, 2));
  }
  return 1;
}

// --- Real (production) deps for the mutating path ---

async function realOpenUrl(url: string): Promise<void> {
  const platform = process.platform;
  if (platform === 'darwin') {
    await execFileAsync('open', [url]);
  } else if (platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '""', url]);
  } else {
    await execFileAsync('xdg-open', [url]);
  }
}

/**
 * Real `AgentApplyDeps.waitForOperatorBeat` (groundnuty/macf#952 follow-up)
 * — the operator, live: *"the first instructions were so fast that I didn't
 * notice them at all … if I cannot see them, I'm not sure why they are
 * there."* `announceAndOpenGate` already logs every instruction line before
 * this runs (#962/#974); what was missing is a GAP between printing and the
 * browser taking focus.
 *
 * **Judgment call (groundnuty/macf#952 requirement 1): a blocking "press
 * Enter" prompt, not a fixed-duration sleep.** A sleep can still be missed if
 * the operator glances away at the exact moment it elapses — which is
 * functionally the SAME failure this issue reports, just with a shorter
 * fuse. A prompt that only proceeds on an explicit keypress cannot silently
 * elapse unread; the browser cannot take focus until the operator has acted.
 * Reuses the exact `readline` + stderr pattern `realConfirmPlan` above
 * already uses, so there is one interactive-prompt idiom in this file, not
 * two.
 *
 * **Hard constraint: `--yes` must never hang (groundnuty/macf#952
 * requirement 4).** `assumeYes` is resolved ONCE, at `resolveMutateDeps` call
 * time, into which of these two closures gets wired — never a runtime branch
 * inside a single closure — so an unattended run's code path never so much
 * as constructs a `readline.Interface` (no stdin listener exists to leak or
 * hang on). The instruction text itself is unconditional either way — this
 * hook only ever gates the PAUSE, never the printing (`announceAndOpenGate`'s
 * `deps.log` calls run regardless).
 *
 * **A second, independent reason a non-`--yes` run is never a SURPRISE hang:**
 * `runBootstrapApply` already gates entry to `applyFleet` (and therefore every
 * gate) on `realConfirmPlan`'s own blocking prompt — `opts.yes === true ? true
 * : await mutate.confirmPlan(...)`. Any invocation that reaches a consent gate
 * without `--yes` has, by construction, already sat through one interactive
 * prompt on the SAME stdin; this hook adds no NEW class of "a script that
 * never expected to block did." A future auto-approve path that bypasses
 * `confirmPlan` while still reaching this closure would reintroduce that gap
 * — anyone adding one must thread `assumeYes` through it too.
 *
 * The `rl.on('close', ...)` below is defence-in-depth on top of both of the
 * above, not a substitute: if stdin is CLOSED (piped-from-`/dev/null`,
 * redirected-EOF) rather than merely non-interactive, `question`'s callback
 * never fires — `close` does, and this run's beat resolves instead of
 * hanging on a stream that will never produce another byte.
 */
function realWaitForOperatorBeat(assumeYes: boolean): (role: string, gateLabel: string) => Promise<void> {
  if (assumeYes) {
    return () => Promise.resolve();
  }
  return (role: string, gateLabel: string) => blockingEnterPrompt(`Role "${role}": press Enter to open the browser for ${gateLabel}… `);
}

/**
 * Real `AgentApplyDeps.waitForOperatorFix` (groundnuty/macf#1063) — the
 * SAME blocking-"press Enter"-not-a-sleep primitive `realWaitForOperatorBeat`
 * already establishes (see that function's own doc for why: a fixed sleep
 * can elapse unread; a prompt cannot), reused here for a DIFFERENT moment —
 * after the retry browser tab opens, before `apply` re-checks. Distinct
 * wording ("press Enter once you've fixed it," not "press Enter to open the
 * browser") because the browser is ALREADY open by the time this runs; see
 * `AgentApplyDeps.waitForOperatorFix`'s own doc for why this exists at all
 * (the App is already installed on a retry, so `waitForAppInstallation`'s
 * poll would otherwise resolve — and re-validate — on its very first check,
 * before the operator could possibly have acted).
 *
 * Same `--yes` never-hangs contract as `realWaitForOperatorBeat`: moot in
 * practice, since `allowInstallRetry` (wired from the SAME `assumeYes`
 * immediately below) is never `true` under `--yes` either, so a retry never
 * happens for this closure to be called on.
 */
function realWaitForOperatorFix(assumeYes: boolean): (role: string, gateLabel: string) => Promise<void> {
  if (assumeYes) {
    return () => Promise.resolve();
  }
  return (role: string, gateLabel: string) => blockingEnterPrompt(`Role "${role}": press Enter once you've fixed it on GitHub for ${gateLabel}… `);
}

/** Shared blocking-"press Enter" mechanics for both operator-pause prompts above — same `readline` + stderr idiom, varying only the printed prompt text. See `realWaitForOperatorBeat`'s doc for why `close` is a defence-in-depth branch, not the primary resolve path. */
function blockingEnterPrompt(promptText: string): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write(promptText);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const done = (): void => {
      rl.close();
      resolve();
    };
    rl.once('close', done);
    rl.question('', done);
  });
}

/** Real y/N prompt on stderr (stdout stays clean for a `--json` render). */
async function realConfirmPlan(plan: FleetPlan, creations: readonly PlannedAppCreation[]): Promise<boolean> {
  const summary = summarizePlan(plan.items);
  // groundnuty/macf#926 — `write-always` items (labels/runner_warm) are
  // deliberately EXCLUDED from `summary.creates` (a write-always item was
  // never verified missing, unlike a genuine create — see `PlanSummary`'s
  // doc). But apply DOES attempt them every run, so a banner silent about
  // them would under-state what's about to happen on the operator's LAST
  // read before typing "yes" — the exact failure this banner's own #854
  // comment already guards against for unimplemented items. Named
  // separately, never folded into "CREATE N," so the count keeps meaning
  // "confirmed-or-plausibly missing."
  const writeAlwaysNote = summary.writeAlways > 0 ? ` (plus ${String(summary.writeAlways)} write-always attempt(s), regardless of whether already present)` : '';
  process.stderr.write(
    `\nThis apply will CREATE ${String(summary.creates)} resource(s) (including ${String(creations.length)} GitHub ` +
      `App(s) — ${String(creations.length * 2)} browser consent click(s): manifest-create + install, per App)${writeAlwaysNote}, ` +
      `${String(summary.updates)} update(s) requiring confirmation at the point they occur, and leave ` +
      `${String(summary.noops)} already-present resource(s) untouched. Nothing is deleted (§D3 no-prune).\n`,
  );
  // macf#854 — the plan above already lists the NOT-IMPLEMENTED items loudly
  // (formatPlanText), but this is the LAST thing the operator reads before
  // typing "yes" — restate the count here so approving doesn't read as
  // approving work that will silently never happen.
  if (plan.unimplementedByApply.length > 0) {
    process.stderr.write(
      `⚠ ${String(plan.unimplementedByApply.length)} item(s) in the plan above are NOT IMPLEMENTED by apply yet — ` +
        'approving will NOT create or update them (see the ⚠ block in the plan above for which).\n',
    );
  }
  process.stderr.write('Type "yes" to proceed with this plan, anything else to abort: ');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

/**
 * DR-043 Amendment F (macf#857) — the real `<fleet>-control` provisioning
 * primitives. `commitAndPush` is deliberately `realControlRepoCommitAndPush`
 * (the explicit-allowlist commit), NOT the `-A` `realCommitAndPush` used
 * below for agent-repo `repoInitDeps` — see `control-repo.ts`'s
 * "git-committed content invariant" doc section (#857 review) for why the
 * two checkouts need different commit primitives.
 */
const REAL_CONTROL_REPO_DEPS: ControlRepoDeps = {
  checkMeta: checkControlRepoMeta,
  readManifestFile: realReadControlManifestFile,
  createRepo: realCreateRepo,
  unarchiveRepo: realUnarchiveRepo,
  cloneRepo: realCloneRepo,
  commitAndPush: realControlRepoCommitAndPush,
};

/**
 * macf#857 + macf#1034 (DR-043 Amendment G correction) — the real
 * agent-repo-ensure/revive primitives. `checkRepoArchivedState` is the SAME
 * `{archived}` read `observer.ts`'s plan-time control-repo observation
 * already uses (macf#1034: one reader, not a second `checkRepoExists`-only
 * read plus a separate archived probe). `createRepo` is the SAME primitive
 * the control repo uses, with a template. `unarchiveRepo` is
 * `repo-archive.ts::realUnarchiveRepo` — the EXACT SAME PATCH primitive
 * `REAL_CONTROL_REPO_DEPS.unarchiveRepo` (above) already wires for the
 * control repo, never a second un-archive implementation.
 */
const REAL_AGENT_REPO_DEPS: AgentRepoDeps = {
  checkMeta: checkRepoArchivedState,
  createRepo: realCreateRepo,
  unarchiveRepo: realUnarchiveRepo,
};

/**
 * DR-043 Amendment D phase 2 (macf#838, macf#854's CA/routing gap) — the
 * real CA-ceremony + two-place-publish + routing-var deps. Every
 * presence-check function here is the SAME one `observer.ts`'s plan-time
 * reads already use (`checkRegistryVariablePresence` / `readRegistryVariable`
 * / `checkRepoVariablePresence` / `checkRunnerUsableByRepo`) — plan and apply
 * agree on what "present"/"registered-and-usable" means at the exact same
 * call sites, by construction, not by convention. `checkRunnerUsableByRepo`
 * (macf#922, org-scope-corrected by macf#924) is the register-before-route
 * gate `apply-routing.ts::publishTrustedActors` checks per-repo before every
 * write.
 */
const REAL_TRUST_DEPS: CaApplyDeps & RunnerRegistrationDeps = {
  checkRegistryPresence: checkRegistryVariablePresence,
  readRegistryVariable,
  createRegistryVariable: realCreateRegistryVariable,
  checkRepoPresence: checkRepoVariablePresence,
  createRepoVariable: realCreateRepoVariable,
  mintCa: realMintCa,
  checkRunnerUsableByRepo,
};

/**
 * DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920 gap 2) — the real
 * mint-or-skip deps. `mint` is the real `certs.ts::mintRoutingClientCert`
 * primitive. **Publish moved out (groundnuty/macf#1074)** — see
 * `REAL_ROUTING_SECRETS_DEPS` below for the (now unified, six-secret)
 * publish deps `checkRepoSecretPresence`/`setRepoSecret` live on instead.
 */
const REAL_ROUTING_CLIENT_DEPS: RoutingClientApplyDeps = {
  mint: realMintRoutingClient,
};

/**
 * groundnuty/macf#1074 — the real unified six-secret routing publish deps.
 * `checkRepoSecretPresence`/`setRepoSecret` are the SAME concrete functions
 * `REAL_ROUTING_CLIENT_DEPS`'s publish half used to carry (`observer.ts`'s
 * read, `apply-routing-client.ts::realSetRepoSecret`'s `gh secret set`-via-
 * stdin write — both reused verbatim, never a second implementation).
 * `readVaultTsOauth` is wired by `resolveMutateDeps` below (opt-in on
 * `--vault`/`--identity-key`, same both-or-neither contract every other
 * vault-restore closure in this file already follows).
 */
const REAL_ROUTING_SECRETS_PUBLISH_DEPS: RoutingSecretsPublishDeps = {
  checkRepoSecretPresence,
  setRepoSecret: realSetRepoSecret,
};

/**
 * groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
 * — projects the ALREADY-COMPUTED `observed` (`computePlan`'s own input,
 * read once via `githubRegistryObserver` before `applyFleet` is ever
 * called) into the shape `FleetApplyDeps.observedActionsPins` expects.
 * Pure; never re-reads anything — the #1000 golden path applied to this
 * field's threading.
 */
function actionsPinsFromObserved(
  manifest: FleetManifest,
  observed: ObservedState,
): { readonly agents: Readonly<Record<string, string | undefined>>; readonly controlRepo: string | undefined } {
  const agents: Record<string, string | undefined> = {};
  for (const agent of manifest.agents) {
    agents[agent.role] = observed.agents[agent.role]?.actionsPin;
  }
  return { agents, controlRepo: observed.controlRepoActionsPin };
}

/**
 * Build the REAL (production) mutating deps. Exported ONLY so a test can assert
 * the wiring by identity (macf#857 review): a security primitive can be
 * defined, unit-tested, and never actually called — which is exactly what
 * happened here (commit `2bbc4c3` added the explicit-allowlist commit but left
 * this function wiring the control repo to the `-A` primitive, so the fix was
 * inert in production while its own unit tests passed green). Unit-testing a
 * primitive against itself cannot see that; only asserting through THIS seam
 * can. Pure — it builds a plain object and performs no I/O until a field is
 * invoked — so a test may call it directly.
 */
export function resolveMutateDeps(
  manifestPath: string,
  vaultAgentPems?: ReadonlyMap<string, string>,
  // macf#929 — resolved CLI-flag/env-var token (see `runBootstrapApply`'s
  // resolution right before this is called); threaded verbatim onto
  // `FleetApplyDeps.runnerToken`, never read anywhere else in this function.
  runnerToken?: string,
  // macf#957 — `opts.identityKeyPath` (same flag `vaultAgentPems` above was
  // already decrypted with), threaded verbatim onto
  // `FleetApplyDeps.identityKeyPath` for `apply-fleet.ts::reconcileVaultRecipients`.
  // Never read anywhere else in this function.
  identityKeyPath?: string,
  // groundnuty/macf#978 — `opts.vaultPath`, appended as the LAST parameter
  // (not inserted before `identityKeyPath`) so every pre-#978 positional
  // call site — including this file's own `runBootstrapApply` call and every
  // existing test that stops at `identityKeyPath` — keeps compiling and
  // behaving byte-identically. Used ONLY to build `trustDeps.readVaultCaCert`
  // below; paired with `identityKeyPath` (both-or-neither, mirroring
  // `checkVaultFlagsComplete`'s XOR refusal one layer up in
  // `runBootstrapApply`, which guarantees these two are never partially set
  // by the time either reaches here).
  vaultPath?: string,
  // groundnuty/macf#952 follow-up — `opts.yes`, appended as the LAST
  // parameter for the SAME reason `vaultPath` was (macf#978's comment
  // above): every pre-existing positional call site keeps compiling and
  // behaving byte-identically. `undefined`/omitted defaults to `false`
  // (interactive) below — matching `RunBootstrapApplyOptions.yes?: boolean`'s
  // own "undefined means the interactive default" contract one layer up.
  assumeYes?: boolean,
  // groundnuty/macf#1186 — `resolvedTsOauth` (the flag-then-env-resolved
  // `--ts-oauth-client-id`/`--ts-oauth-secret` pair), appended as the LAST
  // parameter for the SAME reason `vaultPath`/`assumeYes` were (macf#978's
  // comment above): every pre-existing positional call site keeps compiling
  // and behaving byte-identically. Threaded verbatim onto
  // `FleetApplyDeps.resolvedTsOauth`, never read anywhere else in this
  // function.
  resolvedTsOauth?: ResolvedTsOauth,
): MutateApplyDeps {
  const repoInitDeps: RepoInitStepDeps = { cloneRepo: realCloneRepo, commitAndPush: realCommitAndPush };

  // groundnuty/macf#978 — the CA vault-restore fallback (`apply-ca.ts::
  // resolveCaCert`'s `deps.readVaultCaCert`). `undefined` — the field
  // omitted entirely from `trustDeps` below, not set to `undefined` — when
  // either flag is missing: `resolveCaCert` then takes EXACTLY its pre-#978
  // refusal path, byte-identical (same "vault-aware X is opt-in" shape
  // `resolveKeyPath` above already establishes for identity-confirm).
  // Re-decrypts the vault independently of `vaultAgentPems`'s own read
  // above (`runBootstrapApply::resolveVaultAgentPems`) rather than
  // threading that map's discarded `raw` payload through — this closure is
  // invoked at most ONCE per run (only on the rare deactivate-then-apply
  // refusal path), so a second `age -d` there is not a hot path, and
  // keeping the two reads independent avoids widening `resolveVaultAgentPems`'s
  // return shape for a wholly separate concern (agent-PEM confirm vs. CA
  // cert restore).
  const readVaultCaCert =
    vaultPath !== undefined && identityKeyPath !== undefined
      ? async (project: string): Promise<string | undefined> => {
          try {
            const raw = await readVault({ vaultPath, identityPath: identityKeyPath });
            return vaultCaCertPem(raw, project);
          } catch (err) {
            // Amendment A4 honest-unknown floor, extended to CA restore: a
            // failed decrypt must degrade to `apply-ca.ts`'s existing
            // refusal, never be read as "no cert exists" nor fabricate a
            // false restore. `VaultError` messages are pre-scrubbed of
            // secret material at the source (`vault-read.ts`'s own doc), so
            // logging one verbatim here is safe — never a PEM.
            const reason = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `CA vault-restore UNAVAILABLE this run — ${reason} — falling back to the existing refusal ` +
                '(this is NOT evidence the CA cert is actually gone, only that the vault could not be read).\n',
            );
            return undefined;
          }
        }
      : undefined;

  // groundnuty/macf#986 — the routing-client vault-restore fallback
  // (`apply-routing-client.ts::RoutingClientVaultRestoreDeps.readVaultRoutingClient`).
  // Same both-or-neither / never-throws / never-logs-a-value contract as
  // `readVaultCaCert` above, and the SAME reasoning for re-decrypting the
  // vault independently rather than threading a shared `raw` payload
  // through — this closure is invoked at most once per run (only on the
  // "a prior run already minted this fleet's routing-client cert" path),
  // so a third `age -d` in the same run is not a hot path. Unlike
  // `readVaultCaCert` (cert PEM only — the CA's public material), this
  // returns BOTH `certPem` AND `keyPem`: a routing-client secret has no
  // registry-variable "public half" to reuse — the only way to publish it
  // to a new repo is to hold the actual key bytes.
  const readVaultRoutingClient =
    vaultPath !== undefined && identityKeyPath !== undefined
      ? async (): Promise<{ readonly certPem: string; readonly keyPem: string } | undefined> => {
          try {
            const raw = await readVault({ vaultPath, identityPath: identityKeyPath });
            const certPem = vaultRoutingClientCertPem(raw);
            const keyPem = vaultRoutingClientKeyPem(raw);
            if (certPem === undefined || keyPem === undefined) return undefined;
            return { certPem, keyPem };
          } catch (err) {
            // Amendment A4 honest-unknown floor, extended to routing-client
            // restore: a failed decrypt must degrade to the existing
            // "no material available" outcome, never be read as "the vault
            // has nothing" nor fabricate a false restore. `VaultError`
            // messages are pre-scrubbed of secret material at the source
            // (`vault-read.ts`'s own doc), so logging one verbatim here is
            // safe — never a PEM.
            const reason = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `Routing-client vault-restore UNAVAILABLE this run — ${reason} — falling back to the existing ` +
                'honest-unavailable reason (this is NOT evidence the routing-client cert is actually gone, only ' +
                'that the vault could not be read).\n',
            );
            return undefined;
          }
        }
      : undefined;

  // groundnuty/macf#1074 — the router App's vault-restore fallback
  // (`apply-router-app.ts::RouterAppVaultRestoreDeps.readVaultRouterApp`).
  // Same both-or-neither / never-throws / never-logs-a-value contract as
  // `readVaultRoutingClient` immediately above, and the same "re-decrypt
  // independently, not a hot path" reasoning (invoked at most once per run —
  // only on a `'reused'`/`'resumed-install'` router App outcome).
  const readVaultRouterApp =
    vaultPath !== undefined && identityKeyPath !== undefined
      ? async (): Promise<{ readonly appId: string; readonly appKeyPem: string } | undefined> => {
          try {
            const raw = await readVault({ vaultPath, identityPath: identityKeyPath });
            const appId = vaultRouterAppId(raw);
            const appKeyPem = vaultRouterAppKeyPem(raw);
            if (appId === undefined || appKeyPem === undefined) return undefined;
            return { appId, appKeyPem };
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `Router-App vault-restore UNAVAILABLE this run — ${reason} — falling back to the existing ` +
                'honest-unavailable reason (this is NOT evidence the router App key is actually gone, only that ' +
                'the vault could not be read).\n',
            );
            return undefined;
          }
        }
      : undefined;

  // groundnuty/macf#1074 — the Tailscale OAuth vault-read (Amendment C:
  // operator-provided, `apply` never mints it, so this is READ-ONLY — there
  // is no mint/create counterpart the way the router App or routing-client
  // cert have one). Same both-or-neither / never-throws / never-logs-a-value
  // contract as every other vault-restore closure in this function.
  const readVaultTsOauth =
    vaultPath !== undefined && identityKeyPath !== undefined
      ? async (): Promise<{ readonly clientId: string; readonly secret: string } | undefined> => {
          try {
            const raw = await readVault({ vaultPath, identityPath: identityKeyPath });
            const clientId = vaultTsOauthClientId(raw);
            const secret = vaultTsOauthSecret(raw);
            if (clientId === undefined || secret === undefined) return undefined;
            return { clientId, secret };
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `Tailscale-OAuth vault-read UNAVAILABLE this run — ${reason} — falling back to the existing ` +
                'honest-unavailable reason (this is NOT evidence the operator never supplied it, only that the ' +
                'vault could not be read).\n',
            );
            return undefined;
          }
        }
      : undefined;

  // macf#913 — the vault-aware confirm-before-create guard's key resolver.
  // ONE scratch dir for the WHOLE run (not one per role), created lazily on
  // first use so a vault-free run (the common case) never touches the
  // filesystem for this. `undefined` — the field omitted entirely, not set
  // to `undefined` — when no vault map was supplied: `confirmBeforeCreateGuard`
  // then takes EXACTLY its pre-macf#913 path (skip-unverified for a role with
  // a prior lock entry, unconditional create otherwise). `cleanupVaultScratch`
  // below is `runBootstrapApply`'s obligation to call once the run is fully
  // done — see `MutateApplyDeps.cleanupVaultScratch`'s doc.
  let vaultScratchDir: string | undefined;
  const resolveKeyPath =
    vaultAgentPems !== undefined
      ? (role: string): string | undefined => {
          const pem = vaultAgentPems.get(role);
          if (pem === undefined) return undefined;
          vaultScratchDir ??= mkdtempSync(join(tmpdir(), 'macf-bootstrap-vault-confirm-'));
          const path = join(vaultScratchDir, `${role}.pem`);
          writeFileSync(path, pem, { mode: 0o600 });
          return path;
        }
      : undefined;

  // groundnuty/macf#952 follow-up — resolved ONCE per run, outside the
  // `buildAgentDeps` closure (which runs once per agent): every agent in the
  // fleet shares the SAME interactive-vs-headless posture, derived from the
  // SAME `assumeYes` this function received. See `realWaitForOperatorBeat`'s
  // own doc for why the branch lives here (closure SELECTION) rather than
  // inside a single closure (runtime branch).
  const waitForOperatorBeat = realWaitForOperatorBeat(assumeYes === true);
  // groundnuty/macf#1063 — resolved ONCE per run, same reasoning as
  // `waitForOperatorBeat` immediately above (and paired with it: both derive
  // from the SAME `assumeYes`, both closure-SELECTED here rather than
  // runtime-branched inside `buildAgentDeps`).
  const waitForOperatorFix = realWaitForOperatorFix(assumeYes === true);

  return {
    // `writeRecoveryArtifact` is deliberately absent here — `apply-fleet.ts`
    // splices it in (it owns the fleet-level context that seam needs; see
    // its module doc's "Recovery-artifact lifecycle" section).
    buildAgentDeps: (log: (line: string) => void) => ({
      ...realAgentApplyDeps(realOpenUrl, log, waitForOperatorBeat),
      // groundnuty/macf#1063 — a recoverable consent-gate-2 rejection
      // (missing-repo install, etc.) re-opens the install page ONLY on an
      // interactive run. `--yes` verifies once, refuses, and exits — exactly
      // as before this issue (see `AgentApplyDeps.allowInstallRetry`'s doc).
      // `waitForOperatorFix` is ALWAYS paired with `allowInstallRetry` —
      // never one without the other — so a retry that DOES fire always has
      // its genuine operator-wait wired too (see that field's own doc for
      // why a retry without it would burn its whole budget in milliseconds).
      allowInstallRetry: assumeYes !== true,
      waitForOperatorFix,
      ...(resolveKeyPath !== undefined ? { resolveKeyPath } : {}),
    }),
    repoInitDeps,
    vaultDeps: {},
    controlRepoDeps: REAL_CONTROL_REPO_DEPS,
    // DR-043 Amendment G — reaching `applyFleet` at all means the operator
    // already gave the ONE plan-approve-once "yes" this run needed (see
    // `runBootstrapApply` below); if that plan showed a control-repo-
    // archived item (`plan.ts`'s new `control_repo` kind), THIS is the
    // approval that authorizes `provisionControlRepo` to un-archive it.
    // `false`/absent is the only unsafe alternative here — never invert
    // this to a conditional without also re-deriving it from the actual
    // approved plan.
    controlRepoOptions: { confirmUnarchive: true },
    agentRepoDeps: REAL_AGENT_REPO_DEPS,
    // macf#1034 (DR-043 Amendment G correction) — the SAME single
    // plan-approve-once "yes" ALSO covers every declared agent repo the
    // plan showed archived (`agentRepoArchivedItems`, threaded into
    // `computePlan` above) — one approval for the whole declared repo set,
    // not a second per-repo prompt. Same "never invert to a conditional
    // without re-deriving from the approved plan" caveat as
    // `controlRepoOptions` above.
    agentRepoOptions: { confirmUnarchive: true },
    trustDeps: { ...REAL_TRUST_DEPS, ...(readVaultCaCert !== undefined ? { readVaultCaCert } : {}) },
    routingClientDeps: { ...REAL_ROUTING_CLIENT_DEPS, ...(readVaultRoutingClient !== undefined ? { readVaultRoutingClient } : {}) },
    routingSecretsDeps: { ...REAL_ROUTING_SECRETS_PUBLISH_DEPS, ...(readVaultTsOauth !== undefined ? { readVaultTsOauth } : {}) },
    routerAppVaultDeps: { ...(readVaultRouterApp !== undefined ? { readVaultRouterApp } : {}) },
    now: () => new Date(),
    log: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
    allowVaultVersion: process.env['MACF_BOOTSTRAP_VAULT_VERSION'] === '1',
    // macf#929 — POLICY only (see apply-routing.ts::publishTrustedActorsGated's
    // doc); `runnerTokenPollOptions` is deliberately left unset here, taking
    // that function's real 10min/3s deploy-window defaults.
    runnerToken,
    // groundnuty/macf#1186 — see `FleetApplyDeps.resolvedTsOauth`'s doc.
    resolvedTsOauth,
    // macf#957 — `vaultRecipientDeps` deliberately left unset here, taking
    // `apply-fleet.ts::reconcileVaultRecipients`'s real `vault-read.ts`
    // defaults (`readVaultRecipientCount`/`reencryptVault`).
    identityKeyPath,
    confirmPlan: realConfirmPlan,
    // DR-043 Amendment F residual (macf#857): this still reads from the
    // OPERATOR's local manifest directory, not the (not-yet-cloned, at this
    // point in the flow) control-repo checkout. `applyFleet`'s own
    // checkout-lock self-heal (see its module doc) makes this harmless on a
    // REUSE run — the checkout's own `fleet.lock`, once cloned, wins over
    // whatever this returns. Fully closing the gap (reading `fleet.lock`
    // from the control repo BEFORE this function even runs) needs
    // `provisionControlRepo` to run ahead of this call, which is a bigger
    // reshuffle than this increment's scope — left for a later phase.
    readPriorLock: () => readFleetLock(manifestPath),
    cleanupVaultScratch: () => {
      if (vaultScratchDir !== undefined) {
        try {
          rmSync(vaultScratchDir, { recursive: true, force: true });
        } catch {
          /* best-effort — never let scratch-file cleanup mask the apply result */
        }
      }
    },
  };
}

// --- Deploy phase (macf#1013) — production deps + rendering ---

/**
 * Real deploy-phase deps — the SAME real functions `commands/fleet-deploy.ts::resolveDeps`
 * wires for a standalone `macf fleet deploy` call (`readVault` is this file's
 * OWN existing import, already shared with the vault-aware confirm-before-
 * create preview above). Never invoked when `BootstrapApplyDeps.deployDeps`
 * was supplied (tests) — only the production CLI path (no `deps` argument
 * at all) reaches this.
 *
 * **`deployAgentFn: realDeployAgent` is wired EXPLICITLY here (groundnuty/macf#1024),
 * not left to `apply-deploy.ts::runApplyDeployPhase`'s own `deps.deployAgentFn ??
 * realDeployAgent` fallback.** Runtime behavior is unchanged either way — the
 * `??` already resolved to the real function when this field was omitted —
 * but an implicit default cannot be pinned by identity from a test:
 * `apply-deps-wiring.test.ts`'s whole reason for existing (see its module
 * doc, macf#857) is that every OTHER production seam is asserted
 * `=== realFn` at this exact resolver boundary; leaving this ONE field
 * un-set here meant a future edit could add `deployAgentFn: someWrapper`
 * to this object with nothing catching it — the identical "defined, tested,
 * never asserted" gap #862's postmortem named. Exported ONLY so
 * `apply-deploy-seam-identity.test.ts` can assert the wiring by identity;
 * pure — builds a plain object, no I/O until a field is invoked.
 *
 * **Same treatment applies to any future sequencer of this shape** (the
 * issue's own AC3 — e.g. a `fleet up` composing deploy+version — the
 * constraint is on the ROLE "a sequencer's default dependency IS the real
 * golden-path function, provably," not on this one function).
 */
export function resolveApplyDeployDeps(): ApplyDeployPhaseDeps {
  return {
    readVault,
    cloneRepo: realAuthenticatedCloneRepo,
    initAgent: realInitAgent,
    mintCloneToken: realMintCloneToken,
    deployAgentFn: realDeployAgent,
  };
}

// --- Version-reconcile phase (DR-043 Amendment L, macf#1045) — production deps ---

/**
 * Real version-reconcile-phase deps — mirrors `commands/fleet-upgrade.ts::
 * resolveDepsFromConfig`'s discover/driver/npm-latest wiring exactly, minus
 * the `readAgentConfig(projectDir)` requirement (apply already knows its
 * fleet — the manifest's own `metadata.name`, never a host-config lookup).
 * `runUpgradeFleetsFn: upgradeFleets` is the identity-pinned golden-path
 * seam (see `apply-version.ts`'s `ApplyVersionPhaseDeps.runUpgradeFleetsFn`
 * doc + `apply-deps-wiring.test.ts`'s sibling assertion for THIS field) —
 * the ONE place production decides what "the roll" means. Never invoked
 * when `BootstrapApplyDeps.versionDeps` was supplied (tests) — only the
 * production CLI path reaches this.
 *
 * `recordDeployedVersion` mirrors `macf fleet upgrade -f <fleet.yaml>`'s own
 * write-back (macf#907) — apply's version phase behaves exactly like a
 * `-f`-scoped roll, so a confirmed-green agent updates `fleet.lock` the same
 * way, keeping the NEXT `plan`/`apply` run's honest-unknown floor accurate.
 */
export function resolveApplyVersionDeps(manifestPath: string): ApplyVersionPhaseDeps {
  const discover = (): readonly WorkspaceRecord[] => discoverWorkspaces();
  return {
    discover,
    resolveDriver: async (fleet: string): Promise<FleetDriver | null> => {
      const rep = discover().find((r) => r.project === fleet);
      if (!rep) return null; // graceful skip+report — see apply-version.ts's module doc
      return createVmDriverFromConfig(rep.workspace);
    },
    fetchLatest: async () => {
      const r = await fetchLatestCliVersion();
      return r.status === 'ok' ? r.value : null;
    },
    sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    log: (line: string) => console.log(line),
    recordDeployedVersion: buildRecordDeployedVersion(manifestPath),
    runUpgradeFleetsFn: upgradeFleets,
  };
}

/** Real ground-truth cert-present check — mirrors `commands/fleet-deploy.ts::nextStepLines`'s own default exactly. */
function defaultCheckAgentCertPresent(destDir: string): boolean {
  return existsSync(agentCertPath(destDir)) && existsSync(agentKeyPath(destDir));
}

/**
 * Bundles the deploy phase's render inputs (macf#1013) — `undefined` as a
 * WHOLE (never passed to {@link formatApplyResult}/{@link fleetApplyResultToJson})
 * means the phase was never attempted at all (`--no-deploy`, or the control
 * repo itself aborted): renders NOTHING new, byte-identical to pre-#1013
 * output (requirement 3). Exactly one of `results`/`skipReason` is set when
 * this IS passed — `results` for an attempted run (deployed/failed per
 * agent), `skipReason` for the loud "deploy needs the vault" refusal
 * (requirement: "skip with a loud, explicit reason, never silently").
 */
export interface DeployPhaseRenderInput {
  readonly results?: readonly DeployPhaseAgentResult[];
  readonly skipReason?: string;
  readonly checkAgentCertPresent?: (destDir: string) => boolean;
  /**
   * The fleet name (`manifest.metadata.name`) — macf#994's first-launch
   * guidance block needs it to build `<project>@<routing-label>`
   * (coordination.md's canonical tmux session name) for each deployed
   * agent's `tmux attach` line. Threaded from the ONE production call site
   * (`runBootstrapApply`'s `manifest`, already in scope there); required
   * (not defaulted) because {@link launchNextStepLines} has no other source
   * for it — `DeployPhaseAgentResult` carries per-agent `role`/`destDir`
   * only, never the fleet-level name.
   */
  readonly project: string;
}

/**
 * Human render of the deploy phase itself (macf#1013) — deployed/failed per
 * agent, or the skip banner. Distinct from {@link launchNextStepLines} below
 * (the "what to do now" section, requirement 5) — this section is "what
 * just happened."
 */
function deployPhaseSummaryLines(deployPhase: DeployPhaseRenderInput): string[] {
  if (deployPhase.skipReason !== undefined) {
    return ['', `⚠ ${deployPhase.skipReason}`];
  }
  const results = deployPhase.results ?? [];
  if (results.length === 0) return [];
  const lines: string[] = ['', 'Deploy phase (runs after the GitHub phase above):'];
  for (const r of results) {
    lines.push(
      r.outcome.status === 'deployed'
        ? `  • ${r.role}: DEPLOYED — workspace ${r.outcome.workspace === 'cloned' ? 'cloned' : 'already present (not re-cloned)'} at ${r.destDir}`
        : `  • ${r.role}: FAILED — ${r.outcome.reason}`,
    );
  }
  return lines;
}

/**
 * groundnuty/macf#1212 — the operator's ruling, verbatim: "after the apply
 * and before the deployment... I should be encouraged to run the status to
 * see that everything is green." Positioned in {@link formatApplyResult}
 * BEFORE {@link formatRemainingDeployLines}'s deploy commands — status is
 * the CONFIRMATION that apply reconciled; deploy is the next ACTION, and
 * printing deploy first would invite skipping the check (the operator's own
 * framing for why the order matters).
 *
 * ALWAYS rendered, never gated on `remainingDeploy.steps` or on whether the
 * deploy phase ran — a read-only "is everything green" check is useful
 * after every apply, not only when something is visibly incomplete.
 * `bootstrap status` accepts `-f`/`--json`/`--vault`/`--identity-key`
 * (verified against `index.ts`'s own command registration — no
 * `--runner-token`, unlike `apply`, since status never provisions
 * anything); echoes ONLY the flags THIS apply run itself received, same
 * "echo what was actually supplied" discipline
 * `remaining-deploy.ts::buildDeployCommand` already uses for the deploy
 * commands below it. Unlike those commands, this one is a pure GitHub read
 * — it runs correctly from ANY host, so it is NEVER suppressed for the
 * host-resolvability reason `remaining-deploy.ts`'s `'unknown'` presence
 * branch exists for (that caveat applies only to the deploy commands,
 * which touch a local filesystem path).
 */
function bootstrapStatusNextStepLines(manifestPath: string, flags: DeployFlagsEcho): string[] {
  const parts = ['macf', 'bootstrap', 'status', '-f', manifestPath];
  if (flags.vaultPath !== undefined) parts.push('--vault', flags.vaultPath);
  if (flags.identityKeyPath !== undefined) parts.push('--identity-key', flags.identityKeyPath);
  return ['', 'Next step — confirm the fleet is green:', `  ${parts.join(' ')}`];
}

/**
 * The operator's concrete next step (macf#1013 requirement 5 — "the end of
 * the output is the operator's next step... for a fully-deployed local
 * fleet that is the `./claude.sh` launch command per agent, not a `fleet
 * deploy` command"). Only ever names `./claude.sh` for an agent THIS run's
 * deploy phase reported `'deployed'` — never for an agent `remainingDeploy`
 * (computed separately, AFTER the deploy phase, from real on-disk state)
 * still lists as missing, so the two sections can never disagree about the
 * SAME agent (a deployed agent's `deploy_path` exists on disk by the time
 * `remainingDeploy` runs, so it is silently absent from that report — see
 * `remaining-deploy.ts`'s own "silent when nothing applies" convention).
 */
function launchNextStepLines(deployPhase: DeployPhaseRenderInput): string[] {
  const results = deployPhase.results ?? [];
  const deployed = results.filter((r) => r.outcome.status === 'deployed');
  if (deployed.length === 0) return [];
  const checkAgentCertPresent = deployPhase.checkAgentCertPresent ?? defaultCheckAgentCertPresent;
  const lines: string[] = ['', 'Next step — launch the deployed agent(s):'];
  // macf#994 — that step cannot complete unattended for a FIRST launch of a
  // workspace (trust dialog, conditionally the channels-confirmation
  // prompt). Named ONCE for the whole section (DR-044 Decision 6 — "one
  // reason, once"; see first-launch-guidance.ts's module doc), never once
  // per agent, and only when at least one agent below actually gets a
  // launch line (a cert-absent agent gets the ⚠ bullet instead — see that
  // branch below — so the explanation would otherwise dangle with nothing
  // to attach to).
  const launchable = deployed.filter((r) => checkAgentCertPresent(r.destDir));
  if (launchable.length > 0) {
    lines.push(...firstLaunchGuidanceHeaderLines());
  }
  for (const r of deployed) {
    // Pre-existing asymmetry with `fleet-deploy.ts::nextStepLines` (macf#976,
    // predates macf#994): the single-agent command always prints its launch
    // line even when the cert is missing; this multi-agent one withholds it
    // and prints ONLY the warning bullet below. Not something macf#994
    // changes — the guidance here simply follows wherever the pre-existing
    // launch line already appears, per agent.
    if (!checkAgentCertPresent(r.destDir)) {
      lines.push(`  ⚠ ${r.role}: no mTLS cert at ${r.destDir} yet — check the deploy phase output above before launching.`);
      continue;
    }
    lines.push(`  cd ${r.destDir} && ./claude.sh`);
    lines.push(`  ${firstLaunchAttachLine(deployPhase.project, r.destDir, r.role)}`);
  }
  return lines;
}

// --- Apply-result rendering (never a credential value) ---

/**
 * groundnuty/macf#1212 bumped this 1 → 2: `result.routing[repo].status` can
 * now be `'pending'` (a NEW enum value a `--json` consumer's exhaustive
 * switch must add an arm for) AND, for the SAME repos, what previously
 * meant "no usable runner confirmed, for any reason" under `'failed'` now
 * narrows to "confirmed dead" — a timeout on a repo `apply` itself just
 * provisioned no longer renders as `'failed'` at all. Same class of change
 * as `routing-doctor.ts`'s #1192 (3→4) and #1199 (4→5) bumps: a
 * previously-collapsed status gains a new, narrower meaning a script
 * consuming `--json` would silently misread without the version signal.
 */
export const FLEET_APPLY_JSON_SCHEMA_VERSION = 2;

/**
 * The control-repo status line — ALWAYS rendered first (macf#857), so a
 * `foreign`/`failed` step-0 abort is visible in the SAME place a normal run's
 * "Agent identities:" summary would be, not just as a bare non-zero exit
 * code. This matters most under `--yes`, which skips the pre-approval render
 * entirely — this final-result render is the ONLY output a script sees, so
 * an abort that's only distinguishable by exit code (same shape #854/#861
 * already closed for `unimplementedByApply`) would be a regression.
 */
function formatControlRepoLine(result: FleetApplyResult): string {
  const cr = result.controlRepo;
  switch (cr.status) {
    case 'created':
      return `CREATED "${cr.repo}" (checkout: ${cr.localDir})`;
    case 'reused':
      return `REUSED "${cr.repo}" (checkout: ${cr.localDir})`;
    case 'revived':
      return `REVIVED "${cr.repo}" (was archived; checkout: ${cr.localDir})`;
    case 'foreign':
      return `⚠ ABORTED — "${cr.repo}" exists but is not this fleet's control repo: ${cr.reason}`;
    case 'archived':
      return `⚠ ABORTED — "${cr.repo}" is archived and revival was not confirmed: ${cr.reason}`;
    case 'failed':
      return `⚠ ABORTED — could not provision "${cr.repo}": ${cr.reason}`;
  }
}

/**
 * The control-repo routing setup line (groundnuty/macf#1057) — reports
 * whether the router workflow + per-agent labels were installed on the
 * control repo, so cross-agent coordination there is actually usable.
 * Explains outcomes in plain language rather than citing an internal
 * tracker reference (operator ruling: user-facing output should stand on
 * its own).
 */
function formatControlRepoInitLine(init: FleetApplyResult['controlRepoInit']): string {
  switch (init.status) {
    case 'skipped':
      return 'skipped (control repo was not provisioned this run — see the Control repo line above).';
    case 'failed':
      return `⚠ FAILED — ${init.reason}`;
    case 'written': {
      const labelNote =
        init.labels.status === 'skipped'
          ? `labels not created this run (${init.labels.reason}) — will retry on the next apply`
          : init.labels.status === 'partial-failure'
            ? `some labels failed: ${init.labels.failed.join(', ')}`
            : 'labels present for every declared agent';
      const workflowNote = init.workflowAndConfigAllowlisted
        ? ''
        : ' The router workflow file is not yet included in what gets pushed to this repo — cross-agent GitHub Actions routing is not live until that is addressed.';
      return `${labelNote} (${init.agents.join(', ')}).${workflowNote}`;
    }
  }
}

/** The final control-repo sync line (macf#857) — see `ControlRepoSyncOutcome`'s doc. */
function formatControlRepoSyncLine(sync: ControlRepoSyncOutcome): string {
  switch (sync.status) {
    case 'skipped':
      return 'skipped (control repo was not provisioned this run — see the Control repo line above).';
    case 'pushed':
      return 'pushed.';
    case 'nothing-to-commit':
      return 'nothing to push (no fleet.lock/vault.age change this run).';
    case 'failed':
      return `⚠ FAILED — ${sync.reason} (fleet.lock/vault.age changes exist only in the local checkout; re-run apply to retry the push).`;
  }
}

/**
 * One identity's status line — shared by `agentSummaryLines` (below, per
 * declared coordination agent) and `runnerOpsSummaryLines` (groundnuty/
 * macf#943, the fleet-level runner-ops App) since both render the SAME
 * status vocabulary. Typed over `RunnerOpsApplyOutcome` (`AgentApplyOutcome`
 * widened with `'not-needed'`, groundnuty/macf#1083) rather than the bare
 * `AgentApplyOutcome` — a strict superset, so every per-agent/router-App
 * call site (whose outcome can never actually BE `'not-needed'`) keeps
 * passing an `AgentApplyOutcome` value unchanged. Extracted rather than
 * duplicated (macf#943 task requirement).
 */
function formatIdentityLine(role: string, id: RunnerOpsApplyOutcome): string {
  switch (id.status) {
    case 'created':
      return `  ${role}: CREATED (app_id ${id.appId}, install_id ${id.installId})`;
    case 'reused':
      return `  ${role}: REUSED — already confirmed live (app_id ${id.appId}, install_id ${id.installId})`;
    case 'resumed-install':
      return `  ${role}: RESUMED INSTALL (app_id ${id.appId}, install_id ${id.installId})`;
    case 'skipped-unverified':
      return `  ${role}: SKIPPED (unverified) — ${id.reason}`;
    case 'drift':
      return `  ${role}: DRIFT — ${id.reason}`;
    case 'failed':
      return `  ${role}: FAILED — ${id.reason}`;
    // groundnuty/macf#1083 — only `result.runnerOps` can ever carry this
    // status; every other call site's `AgentApplyOutcome` argument cannot
    // reach it, so this arm is unreachable for them, never wrong for them.
    case 'not-needed':
      return `  ${role}: NOT NEEDED — ${id.reason}`;
  }
}

/** Runner-ops App render (groundnuty/macf#943) — its own labeled section, NOT folded into `agentSummaryLines`'s "Agent identities:" list (it isn't a declared coordination agent; see `FleetApplyResult.runnerOps`'s doc). Never a credential value — `formatIdentityLine` reads only status/id/reason fields, same as every agent's render. */
function runnerOpsSummaryLines(result: FleetApplyResult): string[] {
  return [`Runner-ops App:`, formatIdentityLine('runner-ops', result.runnerOps)];
}

function agentSummaryLines(result: FleetApplyResult): string[] {
  const lines: string[] = [];
  for (const rec of result.agents) {
    lines.push(formatIdentityLine(rec.role, rec.identity));
    if (rec.repoInit) {
      lines.push(
        rec.repoInit.status === 'applied'
          ? `    repo-init: applied to ${rec.repoInit.repo} (pushed: ${String(rec.repoInit.pushed)}) — ${formatLabelsLine(rec.repoInit.labels)}`
          : `    repo-init: FAILED on ${rec.repoInit.repo} — ${rec.repoInit.reason}`,
      );
    }
  }
  return lines;
}

/**
 * One clause describing the label-creation outcome (groundnuty/macf#920) —
 * appended to `agentSummaryLines`'s `repo-init: applied` line so a
 * `reused`/`resumed-install` role's SKIPPED labels (the pre-existing,
 * acknowledged gap `applyRepoInitForAgent`'s doc names — no credentials
 * threaded for that path yet) never renders as bare, unqualified silence
 * even though the step's overall `status` is still `'applied'` (this repo's
 * own "never let a gap render as silence" discipline, `plan.ts`'s
 * `unimplementedByApply` applied at the render layer here).
 */
function formatLabelsLine(labels: LabelsOutcome): string {
  switch (labels.status) {
    case 'ok':
      return `labels: ok (${String(labels.created.length)} created, ${String(labels.existed.length)} already present)`;
    case 'partial-failure':
      return `labels: FAILED for ${labels.failed.join(', ')}`;
    case 'skipped':
      return `labels: skipped — ${labels.reason}`;
  }
}

/** One `<label>: <status>` line, appending `— <reason>` for `failed`/`skipped`/`pending` — the shared render shape for `EnsureVariableOutcome` (macf#838 Amendment D phase 2; `'pending'` added groundnuty/macf#1212 — see that status's own doc in `ensure-variable.ts`). NEVER a value — the type carries none. */
function formatVariableLegLine(label: string, leg: EnsureVariableOutcome): string {
  const suffix = leg.status === 'failed' || leg.status === 'skipped' || leg.status === 'pending' ? ` — ${leg.reason}` : '.';
  return `  ${label}: ${leg.status.toUpperCase()}${suffix}`;
}

/** CA ceremony + two-place publish render (macf#838 Amendment D phase 2). Never a credential value — `result.ca.resolve` is the redacted `CaApplyOutcome` (fingerprint only, never cert/key PEM). */
function caSummaryLines(result: FleetApplyResult): string[] {
  const r = result.ca.resolve;
  const resolveLine =
    r.status === 'failed'
      ? `CA: FAILED to resolve — ${r.reason}`
      : `CA: ${r.status.toUpperCase()}${r.certFingerprint !== undefined ? ` (fingerprint ${r.certFingerprint})` : ''}`;
  const lines = [resolveLine, formatVariableLegLine('registry leg', result.ca.registryLeg)];
  for (const [repo, leg] of Object.entries(result.ca.repoLegs)) {
    lines.push(formatVariableLegLine(`repo leg (${repo})`, leg));
  }
  return lines;
}

/** `MACF_TRUSTED_ACTORS` per-repo render (macf#838 Amendment D phase 2; corrected target macf#922). Empty when `routing.runner` wasn't declared, or its `runs_on` isn't `"self-hosted"`. A `'failed'` leg (rendered via `formatVariableLegLine`'s reason suffix — groundnuty/macf#993 corrected this from `'skipped'`: a declared runner is REQUIRED, so the register-before-route gate blocking the write now fails the run, not just the leg) is visible here even under `--yes`, which skips the pre-approval plan render entirely. */
function routingSummaryLines(result: FleetApplyResult): string[] {
  const entries = Object.entries(result.routing);
  if (entries.length === 0) return [];
  const lines = ['Routing (MACF_TRUSTED_ACTORS):'];
  for (const [repo, leg] of entries) lines.push(formatVariableLegLine(repo, leg));
  return lines;
}

/**
 * Routing-client mint + per-repo secret-deploy render (groundnuty/macf#920
 * gap 2). Never a credential value — `result.routingClient.mint` is the
 * redacted `RedactedRoutingClientMint` (status/reason only, never cert/key
 * PEM). `'failed'` (groundnuty/macf#954 — a genuine mint exception, distinct
 * from the two benign 'skipped' causes) renders its own loud line so a human
 * reading full stdout sees the operator-attention state named explicitly,
 * not folded into "SKIPPED" prose that reads as steady-state-benign.
 */
function routingClientSummaryLines(result: FleetApplyResult): string[] {
  const m = result.routingClient.mint;
  const lines = [
    m.status === 'minted'
      ? 'Routing-client cert: MINTED (CN=routing-action).'
      : m.status === 'failed'
        ? `Routing-client cert: FAILED to mint — ${m.reason}`
        : `Routing-client cert: SKIPPED — ${m.reason}`,
  ];
  for (const [repo, leg] of Object.entries(result.routingClient.certLegs)) {
    lines.push(formatVariableLegLine(`cert leg (${repo})`, leg));
  }
  for (const [repo, leg] of Object.entries(result.routingClient.keyLegs)) {
    lines.push(formatVariableLegLine(`key leg (${repo})`, leg));
  }
  return lines;
}

/**
 * groundnuty/macf#1072 — the actions-pin reconcile report, one line per
 * router-carrying repo. `[]` (no section rendered at all) when
 * `result.actionsPin.attempted` is `false` — `versions:` was never
 * declared this run, same "nothing was promised, say nothing" convention
 * `routingSummaryLines` already uses when `routing.runner` isn't declared.
 *
 * Plain-language explanation, never a DR/issue citation — this is
 * user-facing stdout (per this repo's convention: explain, don't cite).
 */
function actionsPinSummaryLines(result: FleetApplyResult): string[] {
  if (result.actionsPin?.attempted !== true) return [];
  const target = result.actionsPin.target ?? '?';
  const lines = [`Router pin (macf-actions@${target}):`];
  for (const r of result.actionsPin.results) {
    const suffix = r.status === 'could-not-attempt' && r.reason !== undefined ? ` — ${r.reason}` : '';
    lines.push(`  ${r.repo}: ${actionsPinStatusLabel(r.status)}${suffix}`);
  }
  return lines;
}

function actionsPinStatusLabel(status: ActionsPinRepoStatus): string {
  switch (status) {
    case 'reconciled':
      return 'RECONCILED (router workflow rewritten this run)';
    case 'already-current':
      return 'already current (no change needed)';
    case 'could-not-attempt':
      return 'COULD NOT ATTEMPT';
  }
}

/**
 * Human render of a completed (non-dry-run) apply result. Never a credential
 * value.
 *
 * `unimplemented` is the plan's `unimplementedByApply` (macf#854) — the
 * caller threads it through from the SAME plan the operator approved, so
 * this final summary names the same gap the pre-approval render did. This is
 * the ONLY place that gap is visible under `--yes` (which skips the
 * pre-approval render entirely) — see the module doc + plan.ts's "Apply
 * coverage" section. Defaults to `[]` so existing callers/tests that don't
 * thread it through keep compiling and rendering byte-identically.
 *
 * `remainingDeploy` (macf#1014) is `remaining-deploy.ts::computeRemainingDeploy`'s
 * output — which declared agents have no local workspace yet. Defaults to
 * `{ steps: [] }` (silent — `formatRemainingDeployLines` renders no lines at
 * all for an empty `steps`) so every existing 2-arg call site keeps
 * compiling and rendering byte-identically.
 *
 * `deployPhase` (macf#1013) is `undefined` by default — the ENTIRE deploy
 * phase (`--no-deploy`, or the control repo aborted) — so every existing
 * 3-arg call site keeps compiling and rendering BYTE-IDENTICALLY
 * (requirement 3: "`--no-deploy` restores today's behaviour"). When given,
 * it renders as the LAST two sections, in order: "what the deploy phase
 * just did" ({@link deployPhaseSummaryLines}), then "what to do now"
 * ({@link launchNextStepLines}) — deliberately AFTER `remainingDeploy`
 * (requirement 5: "the end of the output is the operator's next step").
 *
 * `statusNextStep` (groundnuty/macf#1212) is `undefined` by default — no
 * status-command line renders — so every existing 5-arg-or-fewer call site
 * keeps compiling and rendering BYTE-IDENTICALLY. When given
 * `{ manifestPath, flags }`, {@link bootstrapStatusNextStepLines} renders
 * immediately before `remainingDeploy`'s deploy commands (see that
 * function's own doc for the full ordering rationale — status confirms,
 * deploy acts, and confirming-before-acting is the point).
 */
export function formatApplyResult(
  result: FleetApplyResult,
  unimplemented: readonly UnimplementedApplyItem[] = [],
  remainingDeploy: RemainingDeployReport = { steps: [] },
  deployPhase?: DeployPhaseRenderInput,
  versionPhase?: ApplyVersionPhaseResult,
  statusNextStep?: { readonly manifestPath: string; readonly flags: DeployFlagsEcho },
): string {
  const parts: string[] = [
    `Control repo: ${formatControlRepoLine(result)}`,
    `Control repo routing setup: ${formatControlRepoInitLine(result.controlRepoInit)}`,
    '',
    ...runnerOpsSummaryLines(result),
    '',
    'Agent identities:',
    ...agentSummaryLines(result),
    '',
  ];
  switch (result.vault.status) {
    case 'skipped':
      parts.push('Vault: skipped (no agent needed fresh credentials this run).');
      break;
    case 'written':
      parts.push(`Vault: written to ${result.vault.path}${result.vault.versioned ? ' (versioned — a prior vault existed)' : ''}.`);
      break;
    case 'failed':
      parts.push(`Vault: FAILED — ${result.vault.reason}`);
      break;
  }
  parts.push(`fleet.lock: ${result.lockPath}`);
  parts.push(`Control repo sync: ${formatControlRepoSyncLine(result.controlRepoSync)}`);
  parts.push('', ...caSummaryLines(result));
  const routingLines = routingSummaryLines(result);
  if (routingLines.length > 0) parts.push('', ...routingLines);
  parts.push('', ...routingClientSummaryLines(result));
  const actionsPinLines = actionsPinSummaryLines(result);
  if (actionsPinLines.length > 0) parts.push('', ...actionsPinLines);
  if (result.identityChanges.length > 0) {
    parts.push('', `⚠ identity DRIFT detected (${String(result.identityChanges.length)}) — confirm before trusting fleet.lock:`);
    for (const c of result.identityChanges) {
      parts.push(`  ${c.role}.${c.field}: ${c.previous} → ${c.next}`);
    }
  }
  if (unimplemented.length > 0) {
    parts.push(
      '',
      `⚠ apply did NOT action ${String(unimplemented.length)} planned item(s) below — these are NOT IMPLEMENTED ` +
        'yet, this is not "nothing to do":',
      ...formatUnimplementedLines(unimplemented),
    );
  }
  if (statusNextStep !== undefined) {
    parts.push(...bootstrapStatusNextStepLines(statusNextStep.manifestPath, statusNextStep.flags));
  }
  const remainingDeployLines = formatRemainingDeployLines(remainingDeploy);
  if (remainingDeployLines.length > 0) {
    parts.push('', ...remainingDeployLines);
  }
  if (deployPhase !== undefined) {
    parts.push(...deployPhaseSummaryLines(deployPhase));
    parts.push(...launchNextStepLines(deployPhase));
  }
  if (versionPhase?.attempted === true) {
    parts.push('', formatVersionReconcileLine(versionPhase));
  }
  return parts.join('\n');
}

/**
 * groundnuty/macf#1053 — the version-reconcile phase's ONE summary line, now
 * naming which of three outcomes actually happened. Before this, "completed"
 * covered a genuine roll AND a zero-agent no-op AND an unreachable fleet
 * identically — indistinguishable from an actual rollout on a live run
 * (agent uptimes never moved; #1053's own incident). HALTED keeps its
 * existing dedicated message, unchanged — a bad release was already loud.
 * Reporting only: reads fields `runApplyVersionPhase` already computed
 * (`apply-version.ts`'s `summarizeVersionRoll`), never re-decides anything
 * the roll itself decided (DR-043 Amendment L2).
 */
function formatVersionReconcileLine(versionPhase: ApplyVersionPhaseResult): string {
  const target = versionPhase.target ?? '?';
  if (versionPhase.halted === true) {
    return `Version reconcile: HALTED — a bad release stopped the roll toward macf@${target} (see log above).`;
  }
  const rolled = versionPhase.rolledAgents ?? [];
  const breakdown = versionPhase.skipBreakdown ?? [];
  if (rolled.length > 0) {
    // groundnuty/macf#1053 review — a PARTIAL roll (some agents rolled,
    // others busy/config-dirty/branch-mismatched/stale-pinned) must name
    // BOTH halves. Returning early on `rolled.length > 0` alone silently
    // dropped `breakdown` here — the exact "summary reads as authoritative
    // while describing something that did not happen" shape this issue is
    // about, reproduced one branch over.
    // Parenthesized, not a second em-dash clause — two `—`s at the same
    // nesting level read as one flat list ("code-agent" / "2 busy not
    // rolled" looking like peers); parens make clear the second clause is
    // subordinate to the first.
    const notRolledNote = breakdown.length > 0 ? ` (${breakdown.join(', ')} not rolled)` : '';
    return `Version reconcile: rolled ${String(rolled.length)} agent(s) to macf@${target} — ${rolled.join(', ')}${notRolledNote}.`;
  }
  // Zero rolled — say so explicitly, with a reason, per macf#1053's
  // requirement 3 ("a no-op must not read as a completed roll"). The
  // flagless note is an adjacent FACT (this run had no --vault/
  // --identity-key), never an asserted CAUSE — the roll's own
  // driver-resolution + pre-flight gates don't read those flags at all (see
  // `apply-version.ts`'s `ApplyVersionPhaseResult.flagless` doc).
  const flaglessNote = versionPhase.flagless === true ? ' This apply run was invoked without --vault/--identity-key.' : '';
  if (versionPhase.unreachable === true) {
    return (
      `Version reconcile: could not attempt toward macf@${target} — no locally-discoverable workspace for this ` +
      `fleet on this host (driver-unresolved).${flaglessNote}`
    );
  }
  const total = versionPhase.totalMembers ?? 0;
  // "discovered member(s)" (not "declared agent(s)") — `total` counts what
  // THIS host found locally (`report.fleets[0].plans.length`), which can be
  // fewer than the manifest's full agent list when only some workspaces are
  // reachable from here; naming it "declared" would overclaim.
  const reason = breakdown.length > 0 ? breakdown.join(', ') : total > 0 ? 'none behind target' : 'no fleet members discovered locally';
  return `Version reconcile: 0 of ${String(total)} discovered member(s) rolled toward macf@${target} — ${reason}.${flaglessNote}`;
}

/**
 * Redact an {@link AgentApplyOutcome} (or, for `result.runnerOps` — groundnuty/
 * macf#1083 — the widened {@link RunnerOpsApplyOutcome}) for JSON rendering.
 * The `created` variant carries the raw `AppCredentials` (PEM / client secret
 * / webhook secret) so `apply-fleet.ts` can assemble the vault payload — that
 * object must NEVER reach a log line or a `--json` envelope. Every other
 * variant carries no credential field to begin with; this still copies them
 * explicitly (rather than spreading) so a FUTURE variant that adds one is a
 * compile error here, not a silent leak.
 */
function redactIdentity(identity: RunnerOpsApplyOutcome): unknown {
  switch (identity.status) {
    case 'created':
      return { role: identity.role, status: identity.status, appId: identity.appId, installId: identity.installId };
    case 'reused':
    case 'resumed-install':
      return { role: identity.role, status: identity.status, appId: identity.appId, installId: identity.installId };
    case 'skipped-unverified':
      return { role: identity.role, status: identity.status, appId: identity.appId, reason: identity.reason };
    case 'drift':
      return { role: identity.role, status: identity.status, reason: identity.reason, installs: identity.installs };
    case 'failed':
      return { role: identity.role, status: identity.status, reason: identity.reason };
    // groundnuty/macf#1083 — only `result.runnerOps` can ever carry this
    // status (see `RunnerOpsApplyOutcome`'s doc); no credential field to redact.
    case 'not-needed':
      return { role: identity.role, status: identity.status, reason: identity.reason };
  }
}

/** `RemainingDeployStep` → the `--json` snake_case shape. Never a credential value — only role/path/presence/reason/command (all path-shaped or plain strings; see that type's own doc). */
function remainingDeployStepToJson(step: RemainingDeployStep): unknown {
  return {
    role: step.role,
    deploy_path: step.deployPath,
    presence: step.presence,
    ...(step.reason !== undefined ? { reason: step.reason } : {}),
    command: step.command,
  };
}

/**
 * `DeployPhaseAgentResult` → the `--json` snake_case shape (macf#1013).
 * Reuses `commands/fleet-deploy.ts::outcomeToJson` verbatim for the
 * `FleetDeployOutcome` fields (role/status/app_id/install_id/workspace/
 * key_path/key_write/key_fingerprint/ca/cert_issue, or role/status/reason
 * on failure) — the SAME redaction `macf fleet deploy --json` already
 * applies, never a second, possibly-diverging one — and adds only
 * `workspace_dir` (the resolved absolute path) plus, when deployed AND a
 * cert is present, the copy-pasteable `next_step` command (symmetry with
 * `remainingDeployStepToJson`'s own `command` field).
 */
function deployPhaseResultToJson(r: DeployPhaseAgentResult, checkAgentCertPresent: (destDir: string) => boolean): unknown {
  const base = { ...(fleetDeployOutcomeToJson(r.outcome) as Record<string, unknown>), workspace_dir: r.destDir };
  if (r.outcome.status !== 'deployed') return base;
  return {
    ...base,
    next_step: checkAgentCertPresent(r.destDir) ? `cd ${r.destDir} && ./claude.sh` : null,
  };
}

/** `DeployPhaseRenderInput` → the `--json` `deploy_phase` key (macf#1013). `undefined` in, `undefined` out (the caller omits the whole key — see {@link fleetApplyResultToJson}'s doc). */
function deployPhaseToJson(deployPhase: DeployPhaseRenderInput | undefined): unknown {
  if (deployPhase === undefined) return undefined;
  if (deployPhase.skipReason !== undefined) return { attempted: false, reason: deployPhase.skipReason };
  const checkAgentCertPresent = deployPhase.checkAgentCertPresent ?? defaultCheckAgentCertPresent;
  return { attempted: true, results: (deployPhase.results ?? []).map((r) => deployPhaseResultToJson(r, checkAgentCertPresent)) };
}

/**
 * Structured `--json` render. Never a credential value — only status/id/path/
 * reason fields (see {@link redactIdentity}). `unimplemented` is the plan's
 * `unimplementedByApply` (macf#854); defaults to `[]` so existing
 * callers/tests keep compiling — see {@link formatApplyResult}'s doc for why
 * the caller threads it through.
 *
 * `remainingDeploy` (macf#1014) defaults to `{ steps: [] }`. `remaining_deploy`
 * (and its sibling `remaining_deploy_note`, when present) is OMITTED
 * ENTIRELY (never an empty-array key) when `remainingDeploy.steps` is
 * empty — deliberately deviating from `unimplemented_by_apply`'s
 * always-present convention, mirroring `plan.ts::fleetPlanToJson`'s
 * `registry_scope_issues` precedent (macf#999/macf#1010): a fully-deployed
 * fleet's `--json` output must stay byte-identical to its pre-#1014 shape,
 * which an unconditional new key would not be.
 *
 * `deployPhase` (macf#1013) defaults to `undefined` — `deploy_phase` is
 * OMITTED ENTIRELY (never present-but-empty) whenever the deploy phase was
 * never attempted at all (`--no-deploy`, or the control repo aborted), same
 * omit-when-N/A convention `remaining_deploy` above already established —
 * every existing 2-arg call site's `--json` output stays byte-identical.
 */
export function fleetApplyResultToJson(
  result: FleetApplyResult,
  unimplemented: readonly UnimplementedApplyItem[] = [],
  remainingDeploy: RemainingDeployReport = { steps: [] },
  deployPhase?: DeployPhaseRenderInput,
  versionPhase?: ApplyVersionPhaseResult,
): unknown {
  return {
    schema_version: FLEET_APPLY_JSON_SCHEMA_VERSION,
    control_repo: result.controlRepo,
    control_repo_sync: result.controlRepoSync,
    control_repo_init: result.controlRepoInit,
    // groundnuty/macf#943 — same `redactIdentity` conversion every agent's
    // identity goes through (never a credential value; see that function's
    // doc). Separate top-level key, not folded into `agents` — matches
    // `FleetApplyResult.runnerOps` being its own field.
    runner_ops: redactIdentity(result.runnerOps),
    agents: result.agents.map((rec) => ({ role: rec.role, identity: redactIdentity(rec.identity), repo_init: rec.repoInit ?? null })),
    vault: result.vault,
    lock_path: result.lockPath,
    identity_changes: result.identityChanges.map((c) => ({ ...c })),
    unimplemented_by_apply: unimplemented.map((i) => ({ ...i })),
    ...(remainingDeploy.steps.length > 0
      ? {
          remaining_deploy: remainingDeploy.steps.map(remainingDeployStepToJson),
          ...(remainingDeploy.vaultLocationNote !== undefined ? { remaining_deploy_note: remainingDeploy.vaultLocationNote } : {}),
        }
      : {}),
    // `result.ca.resolve` is ALREADY the redacted `CaApplyOutcome`
    // (fingerprint only — see `apply-ca.ts::redactCaResolve`); `registryLeg`/
    // `repoLegs`/`routing` are `EnsureVariableOutcome`s, which carry no
    // credential field at all. Safe to spread verbatim (macf#838 Amendment D
    // phase 2).
    ca: { resolve: { ...result.ca.resolve }, registry_leg: { ...result.ca.registryLeg }, repo_legs: { ...result.ca.repoLegs } },
    routing: { ...result.routing },
    // `result.routingClient.mint` is ALREADY the redacted `RedactedRoutingClientMint`
    // (status/reason only — see `apply-fleet.ts::redactRoutingClientMint`);
    // `certLegs`/`keyLegs` are `EnsureVariableOutcome`s, which carry no
    // credential field. Safe to spread verbatim (groundnuty/macf#920 gap 2).
    routing_client: {
      mint: { ...result.routingClient.mint },
      cert_legs: { ...result.routingClient.certLegs },
      key_legs: { ...result.routingClient.keyLegs },
    },
    ...(deployPhase !== undefined ? { deploy_phase: deployPhaseToJson(deployPhase) } : {}),
    // DR-043 Amendment L (macf#1045) — same omit-when-N/A convention as
    // `deploy_phase` above: absent entirely when the version phase was never
    // attempted (no `versions:` declared, or the control repo aborted), so
    // every pre-Amendment-L `--json` call site stays byte-identical.
    // groundnuty/macf#1053 — `rolled_agents`/`unreachable`/`total_members`/
    // `skip_breakdown` are the SAME outcome discriminator the human render
    // (`formatVersionReconcileLine`) reads, so a script consuming `--json`
    // gets the real outcome as a field, not just as prose it would have to
    // parse out of the old (misleading) "completed" string.
    ...(versionPhase?.attempted === true
      ? {
          version_phase: {
            target: versionPhase.target,
            halted: versionPhase.halted === true,
            rolled_agents: versionPhase.rolledAgents ?? [],
            unreachable: versionPhase.unreachable === true,
            total_members: versionPhase.totalMembers ?? 0,
            skip_breakdown: versionPhase.skipBreakdown ?? [],
            ...(versionPhase.flagless === true ? { flagless: true } : {}),
          },
        }
      : {}),
    // groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
    // — same omit-when-N/A convention as `version_phase` above: absent
    // entirely when `versions:` was never declared this run (or the control
    // repo aborted before this ever ran), so every pre-#1072 `--json` call
    // site stays byte-identical.
    ...(result.actionsPin?.attempted === true
      ? {
          actions_pin: {
            target: result.actionsPin.target,
            results: result.actionsPin.results.map((r) => ({ repo: r.repo, status: r.status, ...(r.reason !== undefined ? { reason: r.reason } : {}) })),
          },
        }
      : {}),
  };
}

/**
 * Three-valued (groundnuty/macf#1151), mirroring the 0/1/2 contract
 * `commands/fleet-upgrade.ts::fleetUpgradeExitCode` established for the
 * IDENTICAL "did a version roll leave someone behind" question
 * (macf#1146/#1150) — reused here rather than invented fresh, same as
 * `@groundnuty/macf-core`'s `fleet-reconcile.ts` 0/1/2 precedent that
 * function itself cites. Caller audit (macf#1151): `applyExitCode` has
 * exactly ONE production call site (`cli/index.ts`'s `bootstrap apply`
 * action, `process.exitCode = code` — a plain pass-through, no branch on the
 * specific value), so introducing `2` changes no existing caller's
 * behavior beyond the fix itself — same finding #1150 made for
 * `fleetUpgradeExitCode`'s own sole caller.
 *
 * - **`1`** — a HARD failure needing operator attention. The control repo
 *   could not be provisioned this run (`foreign`/`failed`/`archived` —
 *   DR-043 Amendment G added `archived` alongside macf#857's
 *   `foreign`/`failed`; the entire run aborted in all three cases), OR the
 *   final control-repo sync failed (durable-locally-but-not-pushed is still
 *   an operator-attention state), OR the control-repo repo-init step
 *   genuinely failed (groundnuty/macf#1057 — e.g. a local-registry
 *   misconfiguration; NOT the ordinary "no token this run" label-skip,
 *   which stays `'written'` — see `applyControlRepoInit`'s doc), OR ANY
 *   agent needs operator attention (failed/drift/skipped-unverified/
 *   repo-init-failed), OR the runner-ops App needs operator attention
 *   (groundnuty/macf#943 — same failed/drift/skipped-unverified bar as an
 *   agent), OR the vault write failed, OR ANY agent's deploy-phase attempt
 *   failed (macf#1013 requirement 4 — "partial failure exits non-zero";
 *   `deployResults` defaults to `[]`, matching "the deploy phase was never
 *   attempted" — see `anyDeployFailed`'s own doc), OR the version-reconcile
 *   phase HALTED (DR-043 Amendment L, macf#1045 — a bad release during the
 *   roll; `versionPhase` defaults to `undefined`, matching "the phase was
 *   never attempted"). Checked FIRST, same ordering rationale
 *   `fleetUpgradeExitCode` documents for its own `halted` check: a halted
 *   version phase always reports `1` even when it ALSO left other agents
 *   skipped for unrelated reasons (busy/config-dirty/etc.) — halt is a
 *   strictly worse signal than partial, so it must win, never be masked by
 *   the `2` branch below.
 * - **`2`** — NEW (macf#1151). Not a hard failure, but the version-reconcile
 *   phase left at least one discovered fleet member un-rolled
 *   (`versionPhase.skipBreakdown.length > 0` — busy / config-dirty /
 *   off-canonical-branch / stale-pin / not-yet-serving; see
 *   `apply-version.ts::versionRollSkipBreakdown`). This is the EXACT defect
 *   #1151 reports: `formatVersionReconcileLine` (macf#1053) already narrates
 *   this as "rolled N agent(s) … (M busy not rolled)" in the human-readable
 *   summary, but the exit code never read `skipBreakdown` at all — a 2-of-3
 *   partial roll exited `0`, indistinguishable from a fully-green apply to
 *   any script checking `$?`. Reusing `versionPhase.skipBreakdown` directly
 *   (never re-deriving it) keeps this exit code consistent with the summary
 *   line by construction — one decision, read twice, never two decisions
 *   that could drift. An `unreachable` phase (no locally-discoverable
 *   workspace at all) reports an EMPTY `skipBreakdown`
 *   (`apply-version.ts::summarizeVersionRoll`'s own doc — "could not
 *   attempt" is a distinct, honest-unknown state, not a partial roll), so
 *   this branch never fires for it — matches `fleetUpgradeExitCode`'s own
 *   "driver-unresolved is still `isMixedVersionRoll`" choice being
 *   deliberately NOT mirrored here: apply's `unreachable` is reporting-only
 *   (DR-043 Amendment L2's "reporting only" floor for this whole phase, per
 *   the pre-existing #1053 test this file keeps), while `fleet upgrade`'s
 *   own whole-fleet-`skipped` shape is a stronger signal at that command's
 *   own layer.
 * - **`0`** — every hard-failure predicate is false AND the version phase
 *   left no one behind (not attempted at all, attempted-and-fully-rolled,
 *   or attempted-and-honestly-unreachable).
 *
 * **Audited other inputs for the same "partial success, not surfaced"
 * shape (macf#1151) — none needed a change:**
 * - `deployResults` (the attempted-this-run deploy phase): `FleetDeployOutcome.status`
 *   is a strict two-value union, `'deployed' | 'failed'` (see that type's own
 *   doc) — no per-agent "attempted, partially done" state exists at this
 *   layer to miss; `anyDeployFailed` already catches the only bad shape.
 * - `remainingDeploy` / the honest-`'unknown'`-presence report
 *   (`remaining-deploy.ts` — e.g. a `deploy_path` that belongs to another
 *   host in a multi-host fleet): NEVER reaches this function at all — it is
 *   not one of this function's parameters, by design (see the "Never
 *   changes `applyExitCode` below (requirement 3)" comment at this
 *   function's call site) — an honest "I can't tell from here" must not
 *   become a spurious non-zero, and structurally cannot, since it is never
 *   read here.
 * - `result`'s own `'skipped'`-shaped legs (CA / routing-client /
 *   routing-secrets / routing-bundle / control-repo-init labels): every one
 *   is already either (a) a symptom of a DIFFERENT already-`'failed'` state
 *   this function independently catches (e.g. a skipped CA repo-leg when
 *   `ca.resolve.status === 'failed'`), or (b) a genuinely benign steady
 *   state with nothing left to do (CA reused, mint already vaulted, no
 *   token minted this run so labels are 'skipped') — never a "some work
 *   remains, no failure occurred" gap the way `skipBreakdown` was. No new
 *   discriminator needed for any of them.
 */
export function applyExitCode(
  result: FleetApplyResult,
  deployResults: readonly DeployPhaseAgentResult[] = [],
  versionPhase?: ApplyVersionPhaseResult,
): number {
  const controlRepoBad =
    result.controlRepo.status === 'foreign' || result.controlRepo.status === 'failed' || result.controlRepo.status === 'archived';
  const controlRepoSyncBad = result.controlRepoSync.status === 'failed';
  // groundnuty/macf#1057 — a GENUINE control-repo repo-init failure (e.g. a
  // local-registry misconfiguration) needs operator attention, same bar as
  // `controlRepoSyncBad`. Deliberately narrower than "labels weren't
  // created": `controlRepoInit.status` stays `'written'` even when
  // `labels.status === 'skipped'` (no token minted this run — see
  // `apply-control-repo-init.ts`'s "Token sourcing" doc; the common,
  // EXPECTED case for a Mac-side apply run today) — that skip is a known,
  // reported gap, not a run-level failure, and must not flip every ordinary
  // apply to a non-zero exit over it.
  const controlRepoInitBad = result.controlRepoInit.status === 'failed';
  const agentBad = result.agents.some(
    (rec) =>
      rec.identity.status === 'failed' ||
      rec.identity.status === 'drift' ||
      rec.identity.status === 'skipped-unverified' ||
      rec.repoInit?.status === 'failed',
  );
  const runnerOpsBad =
    result.runnerOps.status === 'failed' ||
    result.runnerOps.status === 'drift' ||
    result.runnerOps.status === 'skipped-unverified';
  // groundnuty/macf#1074 — same bar as runnerOpsBad: the router App is a
  // fleet-level identity every one of the six routing secrets ultimately
  // depends on (MACF_ROUTING_APP_ID/KEY come directly from it), so an
  // unresolved identity here needs operator attention exactly like an
  // unresolved runner-ops does. groundnuty/macf#1082 — `'vault-reused'`
  // (the shared-scope zero-creation success path) is deliberately NOT in
  // this list: it is a resolved, healthy outcome, not one needing operator
  // attention — only `RouterAppApplyOutcome`'s `AgentApplyOutcome`-inherited
  // statuses can be bad.
  const routerAppBad =
    result.routerApp.status === 'failed' ||
    result.routerApp.status === 'drift' ||
    result.routerApp.status === 'skipped-unverified';
  // DR-043 Amendment D phase 2 (macf#838) — a CA resolve failure or ANY
  // publish-leg failure needs operator attention, same bar as an agent
  // failure. A 'skipped' leg does NOT independently fail the run here — it
  // is always a SYMPTOM of an already-`ca.resolve.status === 'failed'` or
  // `vault.status === 'failed'` state, both already covered below.
  const caBad =
    result.ca.resolve.status === 'failed' ||
    result.ca.registryLeg.status === 'failed' ||
    Object.values(result.ca.repoLegs).some((leg) => leg.status === 'failed');
  // groundnuty/macf#993 — the operator's ruling: "the failure of our runner
  // should be loud, and the lack of it being provisioned at this stage
  // should block everything else." No code change was needed HERE: a
  // declared-self-hosted-runner repo with no usable runner confirmed is now
  // reported as `'failed'`, not `'skipped'`, by
  // `apply-routing.ts::publishTrustedActorsGated` (the only producer of
  // `result.routing` entries — `result.routing` stays `{}` when
  // `routing.runner` isn't declared self-hosted, so an undeclared fleet
  // never reaches this check either way). This `some(status === 'failed')`
  // already covers that outcome — it did before macf#993 too, for the
  // missing-`--runner-token` refusal; #993 only widened WHICH outcomes the
  // gate reports as `'failed'` rather than changing this check itself.
  const routingBad = Object.values(result.routing).some((leg) => leg.status === 'failed');
  // DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920 gap 2) — same
  // 'skipped' vs 'failed' distinction `caBad` above already applies to CA
  // resolve. A `'skipped'` MINT is the EXPECTED steady state on an ordinary
  // re-run of an already-provisioned fleet (CA reused, or the routing-client
  // key already vaulted from a prior run) — it does NOT independently fail
  // the run. But `mint.status === 'failed'` (groundnuty/macf#954 — a genuine
  // mint EXCEPTION: crypto/tmpdir/disk, distinct from the two benign skip
  // causes) MUST fail it, same bar as `caBad`'s `ca.resolve.status ===
  // 'failed'` check — otherwise a transient mint exception on a freshly-
  // minted CA (the exact next live run) makes `apply` exit 0 while no
  // routing-client cert ever reached a repo, and nothing but full-stdout
  // reading would ever surface it. A publish-leg `'failed'` needs operator
  // attention too, independent of the mint outcome (a mint can succeed while
  // an individual repo's `gh secret set` still fails).
  const routingClientBad =
    result.routingClient.mint.status === 'failed' ||
    Object.values(result.routingClient.certLegs).some((leg) => leg.status === 'failed') ||
    Object.values(result.routingClient.keyLegs).some((leg) => leg.status === 'failed');
  // groundnuty/macf#1074 — the decisive check: a `'failed'` leg on ANY of
  // the six routing secrets, on ANY repo, fails the run. `routingClientBad`
  // above already covers two of the six (kept for its own mint-status
  // check); this covers the OTHER four (MACF_ROUTING_APP_ID/KEY,
  // TS_OAUTH_CLIENT_ID/SECRET) — the exact gap that let a two-of-six fleet
  // exit 0 while genuinely unable to route.
  const routingSecretsBad = Object.values(result.routingSecrets).some((legs) => Object.values(legs).some((leg) => leg.status === 'failed'));
  // groundnuty/macf#1112 — same bar as `routingSecretsBad` immediately
  // above, applied to the single bundled secret: a `'failed'` leg means
  // this run genuinely SHOULD have been able to compose the bundle (all
  // six resolved to `'available'`) but the repo-level `gh secret set`
  // itself failed — a real gap needing operator attention, not the
  // honest `'skipped'` that a not-yet-composable bundle reports.
  const routingBundleBad = Object.values(result.routingBundle).some((leg) => leg.status === 'failed');
  // groundnuty/macf#1072 — a 'could-not-attempt' router-pin reconcile needs
  // operator attention, same bar as an agent identity failure (`agentBad`
  // above already covers "identity unresolved" independently; this covers
  // the repo-init-itself-failed sub-case of 'could-not-attempt').
  const actionsPinBad = result.actionsPin?.results.some((r) => r.status === 'could-not-attempt') ?? false;
  const hardFailure =
    controlRepoBad ||
    controlRepoSyncBad ||
    controlRepoInitBad ||
    agentBad ||
    runnerOpsBad ||
    routerAppBad ||
    result.vault.status === 'failed' ||
    caBad ||
    routingBad ||
    routingClientBad ||
    routingSecretsBad ||
    routingBundleBad ||
    anyDeployFailed(deployResults) ||
    versionPhase?.halted === true ||
    actionsPinBad;
  if (hardFailure) return 1;

  // groundnuty/macf#1151 — the defect this function existed to fix: a
  // version-reconcile phase that rolled SOME but not all discovered fleet
  // members (`skipBreakdown` non-empty — busy/config-dirty/off-branch/
  // stale-pin/not-yet-serving) is NOT a hard failure (checked above, no bad
  // release, no halt) but it is also not a fully-green apply — reuses the
  // SAME `skipBreakdown` `formatVersionReconcileLine` (macf#1053) already
  // narrates in the human-readable summary, never re-derives it, so the
  // exit code and the printed summary can never silently disagree. `halted`
  // is excluded here on purpose: it was already checked above as part of
  // `hardFailure` and returns `1` before this line is ever reached, so halt
  // always outranks partial even when a halted roll ALSO left other agents
  // skipped for unrelated reasons.
  const versionPartial = versionPhase?.attempted === true && (versionPhase.skipBreakdown?.length ?? 0) > 0;
  return versionPartial ? 2 : 0;
}

// --- Recovery-artifact presence notice (macf#988, DR-043 Amendment B requirement 4) ---

/**
 * A CHEAP, existence-only sweep for durable recovery artifacts
 * (`vault-write.ts::operatorRecoveryArtifactPath`'s `~/.config/macf/recovery/<fleet>/<role>.age`)
 * — surfaces "recovery is available" to the operator BEFORE any browser
 * click, even on a `--dry-run` or a `--yes` run with no `--identity-key`
 * supplied. Deliberately existence-only: `exists` is a bare `fs.existsSync`
 * check, NEVER an `age -d` invocation — no identity key is read or needed
 * here. The actual CONSUME path (`apply-fleet.ts::buildAgentDepsWithRecovery`'s
 * `findRecoveryArtifact`) is the only place these artifacts are ever
 * decrypted; this function only answers "does a file exist at that path."
 * `recoveryRootDir` defaults to the real
 * {@link defaultOperatorRecoveryRootDir}; tests inject an `exists` fake
 * (never a real filesystem probe against a fixture's fake paths).
 */
export function findAvailableRecoveryArtifacts(
  manifest: FleetManifest,
  exists: (path: string) => boolean = existsSync,
  recoveryRootDir: string = defaultOperatorRecoveryRootDir(),
): readonly string[] {
  const roles = [...manifest.agents.map((a) => a.role), RUNNER_OPS_ROLE];
  return roles.filter((role) => exists(operatorRecoveryArtifactPath(recoveryRootDir, manifest.metadata.name, role)));
}

/** Pure text builder for {@link findAvailableRecoveryArtifacts}'s result — shared by the `--dry-run` render and the real pre-approval render so the wording never drifts between the two. */
export function formatRecoveryArtifactNotice(roles: readonly string[]): string {
  return (
    `⚠ Durable recovery artifact(s) found for: ${roles.join(', ')} — a prior run's ` +
    'App creation reached the vault-durability step but that run did not complete. Supply --identity-key (and ' +
    '--vault) to this apply and it will be consumed automatically — the recovered credential folds into the vault ' +
    'instead of a new App being created. Without --identity-key, this run treats the role the same as before this ' +
    'fix (a collision refusal if the App also still exists on GitHub).'
  );
}

/**
 * Roles among `creations` whose "would be created" preview line is
 * misleading — a recovery artifact for them ALREADY exists, so gate 1 (App
 * creation) will be SKIPPED and apply resumes their install instead
 * (groundnuty/macf#1165 — the live incident that issue quotes: a preview
 * claiming "GitHub Apps that would be created (5)" while 4 already existed;
 * the live gate correctly resumed them and named only the still-missing
 * repo, contradicting this SAME preview's own "select exactly: A, B" line
 * for the identical role).
 *
 * `identityKeyPath === undefined` returns `[]` unconditionally —
 * `findAvailableRecoveryArtifacts` is existence-only (a bare
 * `fs.existsSync`, per that function's own doc); WITHOUT `--identity-key`,
 * `AgentApplyDeps.findRecoveryArtifact` cannot DECRYPT the artifact this
 * run (`formatRecoveryArtifactNotice`'s own text: "Without --identity-key,
 * this run treats the role the same as before this fix"), so the role
 * genuinely goes through gate 1 as an ordinary create — excluding it here
 * would UNDER-report a click that will actually happen. The honest-unknown
 * floor cuts both ways: never claim a create that will not happen, and
 * never hide one that will.
 *
 * Pure — only intersects two ALREADY-computed lists (`creations`'s own
 * roles, `availableRecoveryRoles` from `findAvailableRecoveryArtifacts`)
 * and invents no new observation, per this issue's "derive from one
 * source" requirement: `#1156` merged because an instruction and a check
 * were computed independently and drifted; `#1164` fixed the live gate by
 * reusing the refusal's own observation; this function is the preview
 * side of the SAME fix, reusing `findAvailableRecoveryArtifacts`'s
 * existing existence check rather than adding a fourth, independent
 * computation of "will this role actually create."
 */
export function recoveryResumableRoles(
  creations: readonly PlannedAppCreation[],
  availableRecoveryRoles: readonly string[],
  identityKeyPath: string | undefined,
): readonly string[] {
  if (identityKeyPath === undefined || availableRecoveryRoles.length === 0) return [];
  const available = new Set(availableRecoveryRoles);
  return creations.filter((c) => available.has(c.role)).map((c) => c.role);
}

/**
 * groundnuty/macf#1186 — the `--ts-oauth-client-id`/`--ts-oauth-secret`
 * flag-then-env precedence, pulled out as its OWN pure function (unlike
 * `--runner-token`'s equivalent inline `opts.runnerToken ?? process.env[...]`
 * expression) specifically so "the CLI flag wins over the env var" is
 * directly, non-circularly testable. `runBootstrapApply`'s CLI-integration
 * surface has no way to discriminate WHICH source produced a resolved
 * value once it clears the pre-flight (both a flag-sourced and an
 * env-sourced value satisfy the SAME presence check identically); this
 * function is what let the precedence rule itself be unit-tested.
 */
export function resolveTsOauthFlagOrEnv(flagValue: string | undefined, envValue: string | undefined): string | undefined {
  return flagValue ?? envValue;
}

// --- Entry point ---

/**
 * `macf bootstrap apply -f fleet.yaml [--dry-run] [--yes] [--json]`.
 *
 * Returns the shell exit code. NEVER exits the process directly; every
 * failure path renders through {@link renderFailure} or the apply-result
 * renderers above.
 */
export async function runBootstrapApply(
  opts: RunBootstrapApplyOptions,
  deps?: BootstrapApplyDeps,
  mutateDeps?: MutateApplyDeps,
): Promise<number> {
  // macf#913 — mirrors `bootstrap plan`'s own XOR refusal
  // (`plan.ts::checkVaultFlagsComplete`'s doc); fires BEFORE the
  // manifest-file check, same ordering `plan` uses (an argument error, not a
  // manifest error).
  const vaultFlagsFailure = checkVaultFlagsComplete(opts.vaultPath, opts.identityKeyPath);
  if (vaultFlagsFailure !== undefined) {
    return renderFailure(vaultFlagsFailure, opts);
  }

  // groundnuty/macf#1186 — CLI flag wins on conflict; the MACF_BOOTSTRAP_TS_OAUTH_*
  // env vars are the fallback (same "flag, then env" precedence
  // `resolvedRunnerToken` below already establishes). Resolved here,
  // unconditionally and before the manifest is even parsed — same placement
  // + rationale as `vaultFlagsFailure` immediately above: a half-given pair
  // is an argument-boundary mistake, not a manifest error, and should never
  // depend on what this fleet's manifest happens to declare.
  const resolvedTsOauthClientId = resolveTsOauthFlagOrEnv(opts.tsOauthClientId, process.env[TS_OAUTH_CLIENT_ID_ENV_VAR]);
  const resolvedTsOauthSecretRaw = resolveTsOauthFlagOrEnv(opts.tsOauthSecret, process.env[TS_OAUTH_SECRET_ENV_VAR]);
  const tsOauthFlagsFailure = checkTsOauthFlagsComplete(resolvedTsOauthClientId, resolvedTsOauthSecretRaw);
  if (tsOauthFlagsFailure !== undefined) {
    return renderFailure(tsOauthFlagsFailure, opts);
  }
  const resolvedTsOauth = resolvedTsOauthPair(resolvedTsOauthClientId, resolvedTsOauthSecretRaw);

  const manifestPath = resolvePath(opts.file);
  if (!existsSync(manifestPath)) {
    return renderFailure({ code: 'manifest_not_found', message: `fleet manifest not found: ${manifestPath}` }, opts);
  }

  let manifest: FleetManifest;
  try {
    manifest = parseFleetManifest(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return renderFailure(
      {
        code: 'manifest_invalid',
        message: `fleet manifest failed validation: ${err instanceof Error ? err.message : String(err)}`,
      },
      opts,
    );
  }

  // macf#929 — CLI flag wins on conflict; MACF_BOOTSTRAP_RUNNER_TOKEN is the
  // fallback (same "flag, then env" precedence `--min-agents`/
  // MACF_PROPOSE_MIN_AGENTS already establishes in index.ts). Resolved HERE
  // (moved up from immediately before `resolveMutateDeps` — macf#932) so
  // BOTH the pre-flight refusal below AND the real mutating wiring further
  // down read the exact same resolved value; there is exactly one place this
  // precedence is computed.
  const resolvedRunnerToken = opts.runnerToken ?? process.env[RUNNER_TOKEN_ENV_VAR];

  // macf#932 — WARN (not refuse) as early as possible, before consent gate 1
  // ever opens — an operator who forgot the flag sees this before spending a
  // browser click. Skipped for `--dry-run`: a dry run never opens a gate to
  // begin with, and its own plan render already carries the SAME requirement
  // note unconditionally (`plan.ts::runnerClassReason`'s
  // `RUNNER_TOKEN_PLAN_NOTE`, macf#932 requirement 3) — nothing is hidden
  // from a `--dry-run` operator either.
  //
  // **groundnuty/macf#1209 — no longer aborts the run.** Through #1209, a
  // missing token turned this into a run-aborting `return renderFailure(...)`
  // — one line, exit 1, nothing else attempted — even though routing
  // secrets, CA legs, repo-init, and vault composition never read
  // `resolvedRunnerToken` at all. Observed live on `macf-trial`: the router
  // credential had just been merged into the vault (an operator-authorised
  // one-time decrypt), and this refusal discarded that entire run before
  // ever publishing it — a leg with zero dependency on the runner token.
  // `checkVaultFlagsComplete`/`checkTailscaleOauthPreflight` (this function's
  // OTHER pre-flights) are deliberately NOT changed alongside this one: a
  // half-given `--vault`/`--identity-key` pair (or a declared-but-
  // unverifiable Tailscale OAuth pair) is an unsatisfiable ARGUMENT, not a
  // "one optional feature is unavailable" fact — see groundnuty/macf#1209's
  // own audit for the distinction (Tailscale's ACTUAL enforcement, unlike
  // the vault-flags XOR, has the SAME narrow-leg shape as the runner token
  // and is flagged there as a candidate follow-up, out of this fix's scope).
  //
  // The ACTUAL enforcement point is UNCHANGED — exactly where macf#929 put
  // it: `apply-routing.ts::publishTrustedActorsGated`, called from
  // `applyFleet` below, independently refuses ONLY the `MACF_TRUSTED_ACTORS`
  // write (never any other leg) with this SAME message, per confirmed repo,
  // `'failed'` (never `'skipped'` — macf#993, so `applyExitCode`'s existing
  // `routingBad` check still fails the run overall — see that function's doc;
  // no new exit code is introduced here). This block now only WARNS to
  // stderr and falls through — never `--json` output (that would corrupt the
  // single JSON object `--json` mode emits at the end of a real run).
  // groundnuty/macf#943 — the name-length pre-flight, run as early as
  // possible (right after the manifest parses, before ANY observe/plan/
  // consent-gate work — including `--dry-run`, which would otherwise render
  // a plan for App names GitHub will reject at submission). `applyFleet`
  // itself re-derives this SAME check (`apply-runner-ops.ts::checkAppNameLengths`)
  // as its own first statement, so this CLI-level refusal is a fast-path,
  // not the only enforcement point — see that module's doc for why both
  // exist. Ordered BEFORE the macf#932 token pre-flight: a name GitHub will
  // reject is unsatisfiable regardless of whether a token was supplied.
  const nameLengthCheck: AppNameLengthCheck = checkAppNameLengths(manifest);
  if (!nameLengthCheck.ok) {
    return renderFailure({ code: 'app_name_too_long', message: nameLengthCheck.reason }, opts);
  }

  // groundnuty/macf#999 — the registry-scope pre-flight, same placement
  // rationale as the name-length check immediately above (unconditional,
  // including `--dry-run`): `registry: { type: org }` is unsatisfiable with
  // this tool's current provisioning regardless of what `apply` would go on
  // to do, so there is nothing later a `--dry-run` operator would learn by
  // NOT seeing this refusal now. See `registry-scope-preflight.ts`'s doc for
  // what this checks (a manifest-derived permission-set fact) and what it
  // deliberately does NOT decide (which resolution #999 requirement 2
  // adopts). Pure; zero I/O; asserts the SAME "gate seam never invoked"
  // contract `checkAppNameLengths` does.
  const registryScopeFailure = checkRegistryScopePreflight(manifest.owner);
  if (registryScopeFailure !== undefined) {
    return renderFailure(registryScopeFailure, opts);
  }

  if (opts.dryRun !== true) {
    const runnerTokenFailure = checkRunnerTokenPreflight(manifest.routing, resolvedRunnerToken);
    if (runnerTokenFailure !== undefined) {
      // groundnuty/macf#1209 — WARN, don't abort: see the block comment
      // above for why. `applyFleet` below still runs every leg that doesn't
      // depend on this token; `publishTrustedActorsGated` still refuses the
      // ONE leg that does, with this SAME message, per confirmed repo.
      console.error(runnerTokenFailure.message);
    }

    // groundnuty/macf#1074 — the Tailscale-declared refuse-before-gate-1
    // preflight (Amendment C precedent, same placement + `--dry-run`-skip
    // posture as `checkRunnerTokenPreflight` immediately above: a dry run
    // never opens a gate to begin with, and its own plan render carries no
    // equivalent note today the way `RUNNER_TOKEN_PLAN_NOTE` does for the
    // runner-token case — flagged as a follow-up, not required for THIS
    // refusal to be correct). Needs a vault read (unlike the pure
    // `checkAppNameLengths`/`checkRegistryScopePreflight` checks above), so
    // it is the ONE async pre-flight in this block.
    const tailscaleFailure = await checkTailscaleOauthPreflight(manifest.transport.tailscale_oauth_required, opts.vaultPath, opts.identityKeyPath, resolvedTsOauth, {
      readVault: deps?.readVault ?? readVault,
    });
    if (tailscaleFailure !== undefined) {
      return renderFailure(tailscaleFailure, opts);
    }
  }

  const resolved = deps ?? { observe: (m: FleetManifest) => githubRegistryObserver(m, manifestPath) };
  const stderrLog = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  try {
    const observed = await resolved.observe(manifest);
    const plan = computePlan(manifest, observed);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);

    // macf#913 — decrypted ONCE (when both flags given), shared by BOTH the
    // `--dry-run` preview below and the real mutating path's
    // confirm-before-create guard (`resolveMutateDeps`). See
    // `resolveVaultAgentPems`'s doc for the honest-unknown degrade-on-failure
    // contract.
    const vaultAgentPems = await resolveVaultAgentPems(manifest, opts, deps?.readVault ?? readVault, stderrLog);
    const preview =
      vaultAgentPems !== undefined
        ? await previewIdentityDecisions(manifest, observed, vaultAgentPems, deps?.confirmAppInstallation ?? realConfirmAppInstallation)
        : undefined;
    // requirement 4 (macf#913): an operator must learn which path apply
    // would ACTUALLY take before spending a browser click — a role the
    // preview confirms live is dropped from "would be created" in BOTH the
    // `--dry-run` render below AND the real path's pre-approval render.
    const displayCreations = preview !== undefined ? filterCreationsByPreview(creations, preview) : creations;
    // groundnuty/macf#880 — roles the preview confirmed `'resume-install'`
    // for: gate 1 SKIPPED (already excluded from `displayCreations` above)
    // but gate 2 still runs — see `formatPlannedAppCreations`'s
    // `gate2InstallOnly` doc. Zero when no preview ran (matches
    // `countResumeInstallFlows`'s own `undefined` short-circuit).
    const gate2InstallOnly = countResumeInstallFlows(preview);
    // macf#988 requirement 4 — existence-only, never decrypted here (see
    // `findAvailableRecoveryArtifacts`'s doc); surfaced on BOTH the
    // `--dry-run` render and the real pre-approval render so an operator
    // learns recovery is available before spending a browser click,
    // regardless of whether `--identity-key` was supplied this run.
    const availableRecoveryRoles = findAvailableRecoveryArtifacts(manifest);
    // groundnuty/macf#1165 — a role in `displayCreations` with an available,
    // this-run-consumable recovery artifact will NOT go through gate 1 at
    // all (see `recoveryResumableRoles`'s doc for the full mechanism + the
    // live incident this closes). Filtered ONCE, here, into `finalCreations`
    // — every render below (both `--dry-run` branches, the real
    // pre-approval stderr render, AND `mutate.confirmPlan`'s own count, the
    // fourth independent computation of this fact this issue's own "derive
    // from one source" requirement calls out) reads `finalCreations`, never
    // the unfiltered `displayCreations`, so there is no second site left to
    // drift from the first.
    const recoveryResumable = recoveryResumableRoles(displayCreations, availableRecoveryRoles, opts.identityKeyPath);
    const finalCreations =
      recoveryResumable.length === 0 ? displayCreations : displayCreations.filter((c) => !recoveryResumable.includes(c.role));
    // An excluded role still costs a gate-2 flow (only gate 1 — App
    // creation — is skipped; its install still needs a click) — folded into
    // the SAME `gate2InstallOnly` accumulator `formatPlannedAppCreations`
    // already uses for the identical shape (a `'resume-install'` role,
    // groundnuty/macf#880), not a second, differently-named counter.
    const finalGate2InstallOnly = gate2InstallOnly + recoveryResumable.length;

    if (opts.dryRun === true) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ...(fleetPlanToJson(plan) as Record<string, unknown>),
              dry_run: true,
              planned_app_creations: finalCreations.map((c) => ({ ...c })),
              // groundnuty/macf#880 — from `finalCreations.length`/
              // `finalGate2InstallOnly`, NOT `plan.items` (see
              // `plan.ts::countAppsToCreate`'s doc): `finalCreations` is
              // the vault-aware- AND recovery-artifact-filtered list, so
              // gate1 is the tighter of the two counts whenever a preview
              // ran; `finalGate2InstallOnly` folds back in any
              // `'resume-install'`/recovery-resumable role's gate-2-only
              // cost `finalCreations.length` alone would silently drop.
              operator_interaction: operatorInteractionToJson(
                operatorInteractionBudget(finalCreations.length, finalCreations.length + finalGate2InstallOnly),
              ),
              ...(preview !== undefined ? { vault_identity_preview: identityPreviewToJson(preview) } : {}),
              // groundnuty/macf#1165 — same JSON-parity precedent
              // `vault_identity_preview` above sets: surfaced only when
              // non-empty, so every pre-this-issue `--json` consumer's
              // shape is unaffected.
              ...(recoveryResumable.length > 0 ? { recovery_resumable_creations: recoveryResumable } : {}),
            },
            null,
            2,
          ),
        );
      } else {
        console.log(formatPlanText(plan));
        console.log('');
        console.log(formatPlannedAppCreations(finalCreations, finalGate2InstallOnly, recoveryResumable));
        if (preview !== undefined) {
          console.log('');
          console.log(formatIdentityPreview(preview));
        }
        if (availableRecoveryRoles.length > 0) {
          console.log('');
          console.log(formatRecoveryArtifactNotice(availableRecoveryRoles));
        }
        console.log('');
        console.log('DRY RUN — nothing was created, changed, or submitted.');
      }
      return 0;
    }

    // Real apply — the DR-035 §4 plan-approve-once artifact: show the FULL
    // plan + blast radius BEFORE any consent gate opens. Always stderr (even
    // without --json) so stdout is reserved for the FINAL result — the same
    // "stdout is data, stderr is narration" split `--json` needs to stay
    // clean; keeping it uniform (not conditional on opts.json) means a human
    // running without --json sees the identical preview a script would have
    // to skip past on stderr, rather than two different code paths.
    process.stderr.write(`${formatPlanText(plan)}\n\n${formatPlannedAppCreations(finalCreations, finalGate2InstallOnly, recoveryResumable)}\n`);
    if (preview !== undefined) {
      process.stderr.write(`\n${formatIdentityPreview(preview)}\n`);
    }
    if (availableRecoveryRoles.length > 0) {
      process.stderr.write(`\n${formatRecoveryArtifactNotice(availableRecoveryRoles)}\n`);
    }

    // macf#929/#932 — `resolvedRunnerToken` was already computed above (right
    // after manifest parsing, shared with the pre-flight refusal); reused
    // verbatim here, not inside `resolveMutateDeps`, so that function stays a
    // pure plain-object builder — no `process.env` read hidden inside it for
    // this field (unlike the pre-existing `allowVaultVersion` line above it,
    // which this does NOT imitate).
    // groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
    // — merged on TOP of whatever `mutateDeps ?? resolveMutateDeps(...)`
    // produced, never threaded through `resolveMutateDeps`'s own (long,
    // carefully-ordered, positional) parameter list: `observed` is in scope
    // HERE (computed once, above, before `applyFleet` is ever called — the
    // #1000 golden path), and every EXISTING test/caller that supplies its
    // own `mutateDeps` keeps its own `observedActionsPins` (or the SAFE
    // `undefined` default — see `FleetApplyDeps.observedActionsPins`'s doc)
    // untouched, same "tests MUST override or it safely no-ops" posture
    // `deployDeps`/`versionDeps` already establish elsewhere in this file.
    const mutate: MutateApplyDeps = {
      ...(mutateDeps ?? resolveMutateDeps(manifestPath, vaultAgentPems, resolvedRunnerToken, opts.identityKeyPath, opts.vaultPath, opts.yes, resolvedTsOauth)),
      observedActionsPins: mutateDeps?.observedActionsPins ?? actionsPinsFromObserved(manifest, observed),
      // groundnuty/macf#1211 — same "merged on TOP, never through
      // resolveMutateDeps's own param list" precedent as observedActionsPins
      // immediately above: the RAW scope-variable value, already read once
      // by `observed` above, threaded so `applyFleet` never re-reads it.
      observedRunnerPlatformEndpointScope: mutateDeps?.observedRunnerPlatformEndpointScope ?? observed.runnerPlatformScopeVariable,
    };
    try {
      const approved = opts.yes === true ? true : await mutate.confirmPlan(plan, finalCreations);
      if (!approved) {
        console.error('Aborted by operator — nothing was created, changed, or submitted.');
        return 1;
      }

      const priorLock = mutate.readPriorLock(manifestPath);
      const result = await applyFleet(manifest, manifestPath, priorLock, mutate);

      // macf#1014 — computed AFTER applyFleet (so a fresh `created` agent's
      // just-materialized workspace, if any, is reflected too) but
      // completely independent of `result`: a plain filesystem check against
      // each declared agent's `deploy_path`, echoing the SAME --vault/
      // --identity-key flags THIS run was invoked with (never re-derived
      // from `result.vault.path` — that's an ephemeral scratch checkout, not
      // a stable path to hand an operator; see `remaining-deploy.ts`'s
      // module doc). Never changes `applyExitCode` below (requirement 3).
      //
      // SUPPRESSED when the control repo itself aborted this run (SAME
      // three statuses `applyExitCode`'s `controlRepoBad` checks below) —
      // "deploy the agents" is not the operator's next step when the run
      // never got past step 0; the actionable next step there is fixing the
      // control-repo conflict, not a deploy command that would be
      // misleading noise alongside it.
      const controlRepoAborted =
        result.controlRepo.status === 'foreign' || result.controlRepo.status === 'failed' || result.controlRepo.status === 'archived';

      // macf#1013 — the default deploy phase. Operator directive quoted
      // verbatim in the issue: *"Deployment should be default, definitely."*
      // Runs AFTER the GitHub phase above (`applyFleet`) and BEFORE
      // `computeRemainingDeploy` below, so a workspace this phase just
      // materialized is reflected as "no longer remaining" rather than
      // double-reported. Gated off (no attempt, no skip banner — `undefined`
      // stays `undefined`) on the SAME `controlRepoAborted` condition
      // `remainingDeploy` itself already suppresses on (deploying is not the
      // next step when step 0 never completed), and on `--no-deploy`
      // (`opts.deploy === false`) — both restore byte-identical pre-#1013
      // output (requirement 3).
      let deployResults: readonly DeployPhaseAgentResult[] | undefined;
      let deploySkipReason: string | undefined;
      if (!controlRepoAborted && opts.deploy !== false) {
        // Hard constraint (macf#1013): "Deploy needs the vault... if they
        // are absent, deploying is impossible — skip with a loud, explicit
        // reason (never silently)." `checkVaultFlagsComplete` at the top of
        // this function already guarantees `vaultPath`/`identityKeyPath` are
        // never HALF given by this point — either both are present (deploy
        // this run), or (this branch) both are absent.
        if (opts.vaultPath === undefined || opts.identityKeyPath === undefined) {
          deploySkipReason =
            `deploy phase SKIPPED for all ${String(manifest.agents.length)} declared agent(s) — deploying needs ` +
            '--vault + --identity-key (this apply run was invoked without them). Supply both to deploy ' +
            'automatically next run, or run the per-agent `macf fleet deploy` command(s) named below.';
        } else {
          const deployDeps: ApplyDeployPhaseDeps = resolved.deployDeps ?? { ...resolveApplyDeployDeps(), log: stderrLog };
          deployResults = await runApplyDeployPhase(
            manifest,
            { vaultPath: resolvePath(opts.vaultPath), identityPath: resolvePath(opts.identityKeyPath) },
            deployDeps,
          );
        }
      }

      // DR-043 Amendment L (macf#1045) — the version-reconcile phase. Runs
      // AFTER deploy (so a workspace THIS run just materialized is freshly
      // discoverable). Gated on `controlRepoAborted` (same as deploy — step
      // 0 never completed) AND `opts.deploy !== false`: `--no-deploy` is the
      // operator's explicit "keep the two phases apart, don't touch
      // workspaces this run" signal (deploy's own doc quotes the operator:
      // *"I very much like and respect this separation"*) — rolling an
      // agent restarts it, which is workspace-adjacent in the same sense.
      // Deliberately NOT gated on vault/identity-key (unlike deploy):
      // rolling an ALREADY-deployed agent needs no vault access, and an
      // unreachable/undiscoverable fleet is a graceful skip+report inside
      // `upgradeFleets` itself, never a hard failure (see `apply-version.ts`'s
      // module doc) — so attempting whenever deploy would have run cannot
      // make an otherwise-successful run fail just because nothing local is
      // reachable yet.
      // groundnuty/macf#1053 — `flagless` is threaded onto the result AFTER
      // the phase runs, never INTO it: this phase's own roll needs no vault
      // access (see the comment above + `apply-version.ts`'s module doc), so
      // the flag is reporting-only context for the summary line, not an
      // input the roll's decisions read. Same `--vault`/`--identity-key`
      // absence check `deploySkipReason` above already used.
      const versionRunFlagless = opts.vaultPath === undefined || opts.identityKeyPath === undefined;
      const versionResult: ApplyVersionPhaseResult =
        controlRepoAborted || opts.deploy === false
          ? { attempted: false }
          : {
              ...(await runApplyVersionPhase(manifest, resolved.versionDeps ?? { ...resolveApplyVersionDeps(manifestPath), log: stderrLog })),
              flagless: versionRunFlagless,
            };

      const remainingDeploy: RemainingDeployReport = controlRepoAborted
        ? { steps: [] }
        : computeRemainingDeploy(manifest, manifestPath, opts, resolved.checkDeployPathExists);
      // macf#1013 + macf#1014 consistency: a SKIP banner on a fleet with
      // nothing left to deploy is pure noise — "I could not deploy" is a
      // non-event when every declared agent already has a workspace. Suppress
      // the skip-only banner in that case so a re-run of a complete fleet
      // stays silent (macf#1014's no-nagging contract). A skip alongside
      // genuinely-remaining agents still renders, because there the operator
      // does need to know why nothing was attempted.
      const deploySkipIsNoise = deployResults === undefined && remainingDeploy.steps.length === 0;
      const deployPhase: DeployPhaseRenderInput | undefined =
        (deployResults === undefined && deploySkipReason === undefined) || deploySkipIsNoise
          ? undefined
          : {
              results: deployResults,
              skipReason: deploySkipReason,
              checkAgentCertPresent: resolved.checkAgentCertPresent,
              project: manifest.metadata.name,
            };

      if (opts.json) {
        console.log(
          JSON.stringify(fleetApplyResultToJson(result, plan.unimplementedByApply, remainingDeploy, deployPhase, versionResult), null, 2),
        );
      } else {
        console.log('');
        console.log(
          formatApplyResult(result, plan.unimplementedByApply, remainingDeploy, deployPhase, versionResult, {
            manifestPath,
            flags: opts,
          }),
        );
      }
      return applyExitCode(result, deployResults, versionResult);
    } finally {
      // macf#913 — a vault-derived scratch PEM must never outlive this run,
      // regardless of how it ends (declined, applyFleet threw, or a clean
      // return above). No-op when vault-aware confirm wasn't configured, or
      // resolveKeyPath was never actually invoked this run.
      mutate.cleanupVaultScratch?.();
    }
  } catch (err) {
    return renderFailure({ code: 'unexpected_error', message: err instanceof Error ? err.message : String(err) }, opts);
  }
}
