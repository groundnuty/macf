/**
 * `applyFleet` — the fleet-level driver behind `macf bootstrap apply`'s
 * mutating path (DR-043 §D2/§D3/§D5, Slice 2b increment 5a of
 * groundnuty/macf#838). Sibling to `plan.ts` (the read-only reconciler this
 * module shares its manifest/lock types with) and `apply-agent.ts` (the
 * per-agent identity primitive this module loops over).
 *
 * Pure orchestration over injected deps — no direct `gh`/`age`/`git` calls
 * live here, only calls into `apply-agent.ts` / `apply-repo-init.ts` /
 * `control-repo.ts` / `vault-write.ts` / `fleet-lock.ts`, all deps-injected
 * — so the SEQUENCING (who gets written when, in what order, and why) is
 * unit-testable with zero real I/O.
 *
 * ## Bootstrap ordering — the control repo is step 0 (DR-043 Amendment F, macf#857)
 *
 * `applyFleet`'s FIRST action, before the per-agent loop, before ANY
 * consent gate, is {@link provisionControlRepo}ing `<fleet>-control` (see
 * `control-repo.ts`'s module doc for the ownership/custody model). A
 * `foreign` or `failed` outcome there ABORTS THE ENTIRE RUN — no agent's
 * repo, App, or install is ever touched. On success, `fleet.lock` /
 * `secrets/vault.age` derive from the control repo's LOCAL CHECKOUT
 * (`controlRepo.localDir`), not from `dirname(manifestPath)` — this is what
 * structurally fixes the #854 "wrote vault.age/fleet.lock to /tmp" bug
 * (those paths used to derive from wherever the OPERATOR happened to point
 * `-f` at; now they derive from a fresh clone of a repo `apply` itself owns
 * the identity of). The per-agent RECOVERY artifact does NOT derive from
 * this checkout (macf#988 moved it OUT — see the "Recovery-artifact
 * lifecycle" section below for why an ephemeral checkout was itself the
 * bug for that one path).
 *
 * Within the per-agent loop, {@link ensureAgentRepo} (from
 * `apply-repo-init.ts`) runs FIRST for each agent — before
 * `applyAgentIdentity`, i.e. before EITHER of that agent's consent gates.
 * Ordering matters concretely: consent gate 2 (the App-install page) can't
 * list a repo that doesn't exist yet — the exact failure the first live
 * provision (#854) hit on the operator's first Install click.
 *
 * The full per-run sequence: **name-length pre-flight (zero I/O) → control
 * repo (once) → for each agent: ensure-repo → confirm-before-create guard →
 * gate 1 → gate 2 → repo-init → (loop) → the runner-ops App (its OWN
 * confirm-before-create guard → gate 1 → gate 2, fleet-level — DR-043
 * groundnuty/macf#943, see the "runner-ops" section below) → the
 * runner-provisioning-contract call, per confirmed repo (`runner-
 * platform.ts::provisionRunner`, non-fatal — see that module's doc) → the
 * batched vault write → a final control-repo commit+push.**
 *
 * ## The runner-ops App (groundnuty/macf#943)
 *
 * A SECOND, minimal GitHub App per fleet, created via the EXACT SAME
 * `apply-agent.ts::applyIdentity` gate-1/gate-2 primitive every coordination
 * agent uses — but it is NOT one of `manifest.agents[]` (no home repo, no
 * deploy path; `FleetManifestSchema` has no knowledge of this role at all).
 * Its permission set (`administration:write` / `actions:read` /
 * `metadata:read`) is deliberately DR-019-DISJOINT — see
 * `apply-runner-ops.ts`'s module doc for why DR-019 was never widened
 * to add `administration` instead. Runs AFTER the per-agent loop (so an
 * agent's own provisioning is never blocked by it) and BEFORE the batched
 * vault write (`settleVault`, below) — `writeVault` is single-shot
 * whole-payload, so a freshly-minted runner-ops credential MUST fold into the
 * SAME call as the fleet's agents/CA/routing-client. Its identity outcome is
 * a SEPARATE `FleetApplyResult.runnerOps` field, not folded into
 * `agents` — that field is 1:1 with `manifest.agents[]` throughout this
 * module and every existing test assumes exactly that.
 *
 * ## Ordering rationale — why lock writes split into TWO moments
 *
 * Agents are processed ONE AT A TIME, fully (identity → repo-init) before
 * the next agent starts — see `apply-agent.ts`'s module doc for why that
 * narrows the gate-1→gate-2 window to a single agent.
 *
 * `fleet.lock` is written at two DIFFERENT points, deliberately:
 *
 *   1. **Immediately**, per-agent, for `reused` / `resumed-install`
 *      outcomes — these carry no NEW secret material (either the App was
 *      already fully confirmed, or gate 2 just completed for an App whose
 *      credentials were already durably vaulted by a PRIOR successful
 *      apply), so there is nothing to lose by recording `app_id`/
 *      `install_id` right away. This is what makes a re-run after an
 *      interruption skip work it already finished.
 *   2. **Only after a successful vault write**, batched, for `created`
 *      outcomes — `vault-write.ts`'s `writeVault` is a SINGLE-SHOT,
 *      whole-payload operation (its own module doc: it deliberately does
 *      not decrypt-merge-reencrypt a prior vault), so there is no way to
 *      durably persist ONE freshly-minted agent's secret without ALSO
 *      persisting every OTHER freshly-minted agent's secret from this same
 *      run in the SAME `age` invocation. The invariant this module upholds:
 *      **`fleet.lock` must never claim a `created` agent is provisioned
 *      before its credentials are durably in the vault** — recording it
 *      early would leave the credential lost forever (memory-only, never
 *      written anywhere) while claiming success. If the vault write fails,
 *      those agents' lock entries are deliberately left UNWRITTEN; a re-run
 *      sees no prior entry, retries gate 1, and GitHub's own App-name
 *      uniqueness is the backstop against a silent duplicate (same
 *      mechanism `apply-agent.ts` already relies on for the narrower
 *      per-agent window — see its module doc).
 *
 * `repo-init` runs for BOTH lock-write moments (it depends on neither —
 * `.github/workflows/agent-router.yml` + `agent-config.json` only need the
 * DERIVED app handle, not a confirmed live identity), so a `created` agent's
 * routing config still lands even in the rare case the vault write fails
 * afterward.
 *
 * ## Recovery-artifact lifecycle (§D5 "durable before gate 2," 2026-08-11 review)
 *
 * **Phase-3 forward guard (#857 review, stated ahead of that increment):**
 * DR-043 Amendment E's §D5 phasing table names phase 3 as the VAULT-READ
 * increment — the first code path that will ever decrypt `vault.age` back to
 * plaintext during an `apply`/reconcile run. That decrypt MUST land in
 * memory or a scratch dir OUTSIDE the control-repo checkout this module
 * builds (`controlDir`, below) — NEVER into the working tree. The
 * control-repo commit path (`control-repo.ts`'s `realControlRepoCommitAndPush`)
 * stages an explicit allowlist rather than `git add -A` specifically so a
 * violation of this guard is merely inert (an untracked file `git status`
 * would show) rather than an auto-committed, published master secret — see
 * `control-repo.ts`'s "git-committed content invariant" doc section for the
 * full invariant this binds.
 *
 * This module OWNS the recovery-artifact path (`vault-write.ts`'s
 * `operatorRecoveryArtifactPath`) at ALL THREE ends of its lifecycle —
 * write, consume, delete — so none of the three can ever drift apart:
 *
 *   - **Write side:** `applyFleet` builds ONE `writeRecoveryArtifact`
 *     closure (knowing `recoveryRootDir` — macf#988's operator-scoped,
 *     stable directory, see below — and `manifest.transport.age_recipients`
 *     → who it encrypts to) and splices it onto the `AgentApplyDeps` object
 *     `deps.buildAgentDeps` returns — that factory deliberately does NOT
 *     produce this field (see `apply-agent.ts`'s `realAgentApplyDeps` doc);
 *     this module is the one with the fleet-level context to build it.
 *     `apply-agent.ts` calls it per-agent, immediately after gate 1, before
 *     gate 2 — see its module doc.
 *   - **Consume side (macf#988, DR-043 Amendment B's read half):** the SAME
 *     closure-builder (`buildAgentDepsWithRecovery`) also supplies
 *     `findRecoveryArtifact` — called by `apply-agent.ts::applyIdentity`
 *     BEFORE either the App-name-collision pre-flight or gate 1, on the
 *     CREATE path only. A found + decryptable artifact resumes straight at
 *     consent gate 2 with the recovered credentials instead of re-attempting
 *     gate 1 (which would hit GitHub's duplicate-App-name rejection anyway).
 *     Decrypting needs `--identity-key` (the SAME operator identity that
 *     decrypts the vault); existence alone is reported without it (task
 *     requirement: the operator learns recovery is available even on a run
 *     that forgot the flag).
 *   - **Delete side (macf#992):** ONLY after the batched final-vault compose
 *     SUCCEEDS locally (`vault.status === 'written'`) AND the FINAL
 *     control-repo push CONFIRMS (`syncControlRepo`'s `status === 'pushed'`)
 *     does this module delete each `created` role's recovery artifact — its
 *     credential now has a durable home OUTSIDE this run's per-process
 *     checkout, so the write-only insurance copy is no longer needed. A
 *     FAILED compose, a FAILED push, or anything short of a confirmed
 *     `'pushed'` deliberately leaves every recovery artifact from this run in
 *     place (loudly logged, by path — never silent), findable by the NEXT
 *     run's consume side above. Through macf#991 the delete fired on the
 *     local-compose success alone, before any push was even attempted — see
 *     the "Location, corrected" section below for the crash-window that
 *     defeated (macf#988 was filed about a different route into the same
 *     state; macf#992 closes THIS route).
 *   - **Pre-flight (the part that makes "closed" true, not just "usually
 *     true"):** `writeRecoveryArtifact` itself rejects when
 *     `transport.age_recipients` is empty (nothing to encrypt to) —
 *     but by the time it would run, gate 1 has ALREADY minted a real,
 *     irreversible GitHub App. Discovering the misconfiguration there is
 *     too late: the credential can never be captured (no recipient means
 *     no artifact either), so THAT App's credential is genuinely lost, not
 *     just delayed. `wouldCreateWithNoRecipient` / `noRecipientPreflightFailure`
 *     close this by refusing gate 1 ENTIRELY for any role that would take
 *     the CREATE path when `recipients` is empty — computed once, before
 *     the loop, from the same immutable `manifest.transport.age_recipients`
 *     input `writeRecoveryArtifact` itself would have checked. This is the
 *     ONLY reason the "credential-loss hole is closed" claim below is true
 *     rather than "true except when misconfigured."
 *
 * ## Location, corrected (macf#988) — why the artifact used to defeat its own purpose
 *
 * Through 2026-08-12, the artifact lived at `<controlDir>/secrets/recovery/<role>.age`
 * — INSIDE the per-run `mkdtemp` control-repo checkout (`controlDir`, above).
 * That checkout dies with the process. A run killed in the EXACT window this
 * mechanism exists to survive — gate 1 minted a real App, the artifact was
 * durably written, then the PROCESS ITSELF was lost before the batched vault
 * compose — took the artifact down with it: the App existed on GitHub, its
 * credential was unrecoverable, and every subsequent `apply` correctly
 * refused (the App-name-collision pre-flight, "already exists but is not in
 * this fleet's vault") because ownership could never be proven again. The
 * durability guarantee was defeated by its own location. `recoveryRootDir`
 * (this function's first local, computed from `deps.recoveryRootDir` ??
 * `vault-write.ts::defaultOperatorRecoveryRootDir()`) is now an
 * OPERATOR-SCOPED, STABLE directory (`~/.config/macf/recovery/<fleet>/`)
 * that outlives every `apply` run's checkout — the fix is the LOCATION; the
 * consume side above is what makes that location fix actually pay off (a
 * durable-but-never-read artifact is just as useless as a purged one).
 *
 * **A sibling durable-write of the SAME class, found in macf#988's review and
 * FIXED HERE (macf#992):** `secrets/vault.age` and `fleet.lock` are written
 * into `controlDir` (the same per-run `mkdtemp` checkout) and only become
 * genuinely durable once `syncControlRepo` pushes them to `<fleet>-control`
 * at the very end of this function — `vault.status === 'written'` proves
 * only that the LOCAL encrypt succeeded, which is BEFORE that push. Through
 * macf#991, the recovery-artifact DELETE fired on `vault.status === 'written'`
 * alone; a crash (or a push failure) between "vault compose succeeded,
 * artifacts deleted" and "the push actually landed" left the fresh
 * `vault.age` durable ONLY in the about-to-be-purged checkout, with its own
 * insurance already gone — reaching exactly the state macf#988 was filed
 * about, by a different route. macf#992 moves the delete to AFTER
 * `syncControlRepo` confirms `status === 'pushed'` — see the call site right
 * after that function's call for the retain-and-say-so behavior on anything
 * else (`'failed'` or `'nothing-to-commit'`).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { caCertFingerprint } from '@groundnuty/macf-core';
import type { TokenSource } from '@groundnuty/macf-core';
import type { FleetAgent, FleetLock, FleetLockAgent, FleetManifest } from './fleet-manifest.js';
import { buildTrustedActorsValue, deriveAppHandle, deriveControlRepoName } from './fleet-manifest.js';
import type { AgentApplyDeps, AgentApplyOutcome, InstallRejection } from './apply-agent.js';
import { applyAgentIdentity, applyIdentity, cleanupScratchPem, writeScratchPem } from './apply-agent.js';
import type { Presence } from './plan.js';
import { buildRegistryRepoValidateInstall, registryRepoCoverageUnverifiedOnSkipNote, requiredRegistryRepoCoverage } from './registry-repo-coverage.js';
import { buildInstallScopeValidator } from './install-scope.js';
import type { ConfirmedInstall } from './identity-confirm.js';
import type { AppCredentials } from './manifest-exchange.js';
import type { AgentRepoDeps, AgentRepoOptions, RepoInitStepDeps, RepoInitStepOutcome } from './apply-repo-init.js';
import { applyRepoInitForAgent, ensureAgentRepo, resolveActionsPinReconcile } from './apply-repo-init.js';
import { repoHomepageUrl } from './app-manifest.js';
import type { ControlRepoDeps, ControlRepoOptions, ControlRepoOutcome } from './control-repo.js';
import { provisionControlRepo } from './control-repo.js';
import type { ControlRepoInitOutcome } from './apply-control-repo-init.js';
import { applyControlRepoInit, deriveRouterCarryingRepos, resolveControlRepoLabelTokenSource } from './apply-control-repo-init.js';
import type { FleetLockAgentUpdate, FleetLockIdentityChange } from './fleet-lock.js';
import { composeFleetLock, readFleetLockFile, writeFleetLock } from './fleet-lock.js';
import type {
  VaultAgentSecrets,
  VaultCaSecrets,
  VaultEncryptFn,
  VaultRoutingAppSecrets,
  VaultRoutingClientSecrets,
  VaultRunnerOpsSecrets,
  WriteVaultDeps,
} from './vault-write.js';
import {
  VaultError,
  ageEncryptToFile,
  buildVaultPlaintext,
  defaultOperatorRecoveryRootDir,
  operatorRecoveryArtifactPath,
  removeAgentRecoveryArtifact,
  vaultAgentSecretsForFingerprint,
  vaultFleetSecretsForFingerprint,
  vaultRunnerOpsSecretsForFingerprint,
  writeAgentRecoveryArtifact,
  writeVault,
} from './vault-write.js';
import type { AppNameLengthCheck, RunnerOpsApplyOutcome } from './apply-runner-ops.js';
import {
  RUNNER_OPS_ROLE,
  checkAppNameLengths,
  deriveRunnerOpsHandle,
  runnerOpsIdentityRequest,
  runnerOpsNeeded,
} from './apply-runner-ops.js';
import type { RouterAppApplyOutcome, RouterAppSecretsForPublish, RouterAppVaultRestoreDeps, SharedRouterAppReuseDeps } from './apply-router-app.js';
import {
  ROUTER_APP_ROLE,
  deriveRouterAppHandle,
  resolveRouterAppSecretsForPublish,
  resolveSharedRouterAppReuse,
  routerAppIdentityRequest,
  routerAppInstallRepos,
} from './apply-router-app.js';
import type { CaApplyDeps, CaApplyOutcome, CaPublishResult, CaResolveOutcome } from './apply-ca.js';
import { publishCaCertLegs, redactCaResolve, resolveCaCert, skippedCaPublish } from './apply-ca.js';
import type { EnsureVariableOutcome } from './ensure-variable.js';
import type { RunnerRegistrationDeps, RunnerTokenPollOptions } from './apply-routing.js';
import { formatProvisionedRunnerWaitProgress, formatRunnerPollProgress, publishTrustedActorsForProvisioned, publishTrustedActorsGated } from './apply-routing.js';
import type { RunnerPlatformResult, RunnerPlatformStatusResult } from './runner-platform.js';
import {
  checkRunnerPlatformStatus,
  describeRunnerPlatformEndpointResolution,
  provisionRunner,
  resolveRunnerPlatformEndpointWithProvenance,
  runnerPlatformCredentialsFromOutcome,
} from './runner-platform.js';
import type { RoutingClientApplyDeps, RoutingClientMintOutcome, RoutingClientSecretsForPublish } from './apply-routing-client.js';
import { ROUTING_CLIENT_CERT_SECRET_NAME, ROUTING_CLIENT_KEY_SECRET_NAME, mintRoutingClient, resolveRoutingClientSecretsForPublish } from './apply-routing-client.js';
import type { ResolvedTsOauth, RoutingSecretResolution, RoutingSecretsForPublish, RoutingSecretsPublishDeps, RoutingSecretsPublishResult } from './apply-routing-secrets.js';
import {
  ROUTING_APP_ID_SECRET_NAME,
  ROUTING_APP_KEY_SECRET_NAME,
  TS_OAUTH_CLIENT_ID_SECRET_NAME,
  TS_OAUTH_SECRET_SECRET_NAME,
  determineFleetRoutingFact,
  publishRoutingBundle,
  publishRoutingSecrets,
  skippedRoutingBundlePublish,
  skippedRoutingSecretsPublish,
  toBase64ForSecret,
} from './apply-routing-secrets.js';
import type { ComposeAndWriteVaultDeps, VaultRecipientCountResult } from './vault-read.js';
import { composeAndWriteVault, readRecoveryArtifact, readVaultRecipientCount, reencryptVault } from './vault-read.js';

export interface FleetApplyDeps {
  /**
   * Builds every `AgentApplyDeps` primitive EXCEPT `writeRecoveryArtifact`
   * — `applyFleet` supplies that one itself (see this module's doc's
   * "Recovery-artifact lifecycle" section); it is the layer with the
   * fleet-level context (the control-repo checkout dir,
   * `manifest.transport.age_recipients`) the writer needs.
   */
  readonly buildAgentDeps: (log: (line: string) => void) => Omit<AgentApplyDeps, 'writeRecoveryArtifact'>;
  readonly repoInitDeps: RepoInitStepDeps;
  readonly vaultDeps: WriteVaultDeps;
  /** DR-043 Amendment F (macf#857) — provisions/reuses `<fleet>-control`; see `control-repo.ts`'s module doc. */
  readonly controlRepoDeps: ControlRepoDeps;
  /** Optional overrides threaded straight into `provisionControlRepo` (e.g. a deterministic `makeScratchDir` for tests — production leaves this unset, taking the real `mkdtemp` default). */
  readonly controlRepoOptions?: ControlRepoOptions;
  /** macf#857 — ensures each agent's OWN repo exists before either consent gate; see `apply-repo-init.ts::ensureAgentRepo`'s doc. */
  readonly agentRepoDeps: AgentRepoDeps;
  /**
   * DR-043 Amendment G revival confirm gate for agent repos (groundnuty/macf#1034)
   * — threaded straight into every `ensureAgentRepo` call, mirroring
   * `controlRepoOptions.confirmUnarchive` exactly (same single
   * plan-approve-once "yes" licenses both). Optional/`undefined` behaves
   * identically to `confirmUnarchive: false` (the safe default —
   * `ensureAgentRepo` never un-archives without it).
   */
  readonly agentRepoOptions?: AgentRepoOptions;
  /** Injectable clock, threaded into `writeVault`'s version-suffix (deterministic tests). */
  readonly now: () => Date;
  readonly log: (line: string) => void;
  /** `true` → an existing `secrets/vault.age` is versioned (timestamped sibling), not clobbered. Mirrors `MACF_BOOTSTRAP_VAULT_VERSION=1` (`bootstrap-build-vault.sh` precedent). Default `false` (fail loud on an existing vault). */
  readonly allowVaultVersion?: boolean;
  /**
   * DR-043 Amendment D phase 2 (macf#838, macf#854's CA/routing gap) — the
   * CA-ceremony + two-place-publish + `MACF_TRUSTED_ACTORS` deps. ONE field
   * covers both `apply-ca.ts` and `apply-routing.ts` — `RoutingApplyDeps` is
   * a `Pick` of `CaApplyDeps`'s repo-var shape PLUS `RunnerRegistrationDeps`
   * (see `apply-routing.ts`'s doc), so there is no second dep object to keep
   * in sync for the CA-shaped half. `RunnerRegistrationDeps` is intersected
   * in here (not folded into `CaApplyDeps` itself) — the register-before-
   * route check is routing-specific, not something `apply-ca.ts`'s CA
   * ceremony uses, so keeping it out of `CaApplyDeps` avoids widening that
   * module's own tests/fixtures for an unrelated concern (macf#922).
   */
  readonly trustDeps: CaApplyDeps & RunnerRegistrationDeps;
  /**
   * DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920) — the
   * mint-or-skip + vault-restore deps for the macf-actions router's mTLS
   * client identity. **Publish moved out of this bag (groundnuty/
   * macf#1074)** — `RoutingClientApplyDeps` no longer includes
   * `checkRepoSecretPresence`/`setRepoSecret` (those live on
   * `routingSecretsDeps` below, the unified six-secret publisher's deps);
   * this field is now MINT/RESTORE only.
   */
  readonly routingClientDeps: RoutingClientApplyDeps;
  /**
   * groundnuty/macf#1074 — the unified six-secret routing publish's deps:
   * the `checkRepoSecretPresence`/`setRepoSecret` primitives (SAME concrete
   * functions the retired `routingClientDeps` publish half used — a wholly
   * different API surface than `trustDeps`' variable-write primitives, no
   * 409, no registry leg, see `apply-routing-secrets.ts`'s doc) PLUS
   * `readVaultTsOauth` — the operator-supplied Tailscale OAuth vault-restore
   * closure (Amendment C: `apply` only ever READS this, never mints it).
   * Combined into ONE bag because both are consumed at the SAME call site
   * (`publishRoutingSecrets`'s single per-repo emission).
   */
  readonly routingSecretsDeps: RoutingSecretsPublishDeps & { readonly readVaultTsOauth?: () => Promise<{ readonly clientId: string; readonly secret: string } | undefined> };
  /**
   * The router App's vault-restore deps (groundnuty/macf#1074, extended by
   * groundnuty/macf#1082). Its IDENTITY ceremony (the `'per-fleet'`-scope
   * CREATE path, or `'shared'`-scope's own create-when-vault-empty path)
   * reuses `buildAgentDepsWithRecovery` like every other App — this field is
   * for reading its id/key back from the vault on a
   * `'reused'`/`'resumed-install'` run, mirroring `routingClientDeps`'s own
   * vault-restore half. **Since #1082, `readVaultRouterApp` is ALSO the
   * signal `resolveSharedRouterAppReuse` checks FIRST, before the identity
   * ceremony is ever reached** — the SAME closure serves both the
   * pre-ceremony reuse decision and the post-ceremony publish resolution
   * (see `apply-router-app.ts::RouterAppVaultRestoreDeps`'s doc).
   */
  readonly routerAppVaultDeps: RouterAppVaultRestoreDeps;
  /**
   * The `--runner-token`/`MACF_BOOTSTRAP_RUNNER_TOKEN` value (macf#929) —
   * `undefined`/empty means "no token supplied." Threaded verbatim into
   * `apply-routing.ts::publishTrustedActorsGated`'s POLICY gate; NEVER read
   * anywhere else in this module, NEVER copied onto `FleetApplyResult` (the
   * `--json`/text renderers in `commands/bootstrap-apply.ts` serialize
   * `FleetApplyResult`, not `FleetApplyDeps`, so this field is structurally
   * unreachable from any render — see `publishTrustedActorsGated`'s doc for
   * the "token licenses ATTEMPTING detection, never substitutes for it"
   * contract this field carries into that gate).
   */
  readonly runnerToken?: string;
  /**
   * The `--ts-oauth-client-id`/`--ts-oauth-secret` pair (or their
   * `MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID`/`MACF_BOOTSTRAP_TS_OAUTH_SECRET` env
   * fallbacks), already flag-then-env resolved by
   * `commands/bootstrap-apply.ts::runBootstrapApply` (groundnuty/macf#1186)
   * — a SECOND operator-supplied source for `TS_OAUTH_CLIENT_ID`/
   * `TS_OAUTH_SECRET`, alongside `routingSecretsDeps.readVaultTsOauth`'s
   * vault-restore path (`#1109`). The vault path requires a PRE-EXISTING
   * `vault.age` to read from — nothing in this codebase ever WRITES this
   * pair into one (`vault-write.ts`'s `payload.routing` is dead code), so a
   * freshly-provisioned org had no way to supply it at all before this
   * field existed. `undefined` means "not supplied via flag/env" — the
   * resolution in this module then falls through to the vault-restore path
   * exactly as `#1109` left it. When BOTH this field and a vault-restored
   * value are present, THIS field wins (an explicit THIS-RUN operator
   * instruction over a prior run's stored value — same "most explicit
   * source wins" precedent `--runner-token`'s own CLI-flag-over-env
   * resolution already establishes). Never written to the vault, never
   * logged, never copied onto `FleetApplyResult` — same "transient POLICY
   * input, never persisted" contract `runnerToken` above already has.
   */
  readonly resolvedTsOauth?: ResolvedTsOauth;
  /**
   * Test-only override for {@link RunnerTokenPollOptions} threaded into
   * `publishTrustedActorsGated`'s bounded poll (macf#929). Production
   * (`commands/bootstrap-apply.ts::resolveMutateDeps`) leaves this unset,
   * taking that function's real defaults (10 min / 3s — a genuine deploy
   * window); tests set a near-zero budget so a "runner never appears" case
   * resolves without real wall-clock delay.
   */
  readonly runnerTokenPollOptions?: RunnerTokenPollOptions;
  /**
   * The operator's age identity-key PATH (DR-043 §D5 recipient reconciliation,
   * groundnuty/macf#957) — mirrors `bootstrap plan`'s own `--identity-key`
   * (`plan.ts::checkVaultFlagsComplete`). `undefined` means "not supplied
   * this run": a DETECTED, definite recipient-set shortfall then REFUSES
   * loudly (see {@link reconcileVaultRecipients}) rather than silently
   * leaving the vault stale — Amendment D's decrypt-then-whole-rewrite needs
   * an operator identity able to decrypt the CURRENT vault; there is no
   * unattended path. Detection itself needs no identity at all (the
   * recipient stanza COUNT is observable from the ciphertext header) and
   * runs every `apply`, regardless of this field.
   */
  readonly identityKeyPath?: string;
  /** Injectable seam for the recipient-set reconciliation (macf#957) — real defaults are `vault-read.ts`'s `readVaultRecipientCount`/`reencryptVault`. */
  readonly vaultRecipientDeps?: VaultRecipientReconcileDeps;
  /**
   * Injectable seam for the vault-exists compose-and-write path (DR-043
   * Amendment D, groundnuty/macf#989) — real default is
   * `vault-read.ts::composeAndWriteVault`. Only ever invoked when
   * `settleVault` finds `vaultOutPath` already exists AND there is a fresh
   * secret to fold in this run (see `settleVault`'s doc). Kept separate from
   * `vaultDeps` (which is `WriteVaultDeps` — a narrower `exists`/`encrypt`
   * shape) because `composeAndWriteVault` needs the FULL decrypt-then-write
   * seam set (`decrypt`/`assertIdentityReadable`/`rename`/`unlink`/`tmpSuffix`
   * too), mirroring `vaultRecipientDeps`'s own "separate optional seam,
   * unset in production" precedent.
   */
  readonly vaultComposeDeps?: ComposeAndWriteVaultDeps;
  /**
   * Override for the recovery-artifact ROOT directory (macf#988, DR-043
   * Amendment B). `undefined` (production —
   * `commands/bootstrap-apply.ts::resolveMutateDeps` never sets this) takes
   * {@link defaultOperatorRecoveryRootDir}'s real `~/.config/macf/recovery`
   * default. Tests ALWAYS set this to a tracked tmpdir — see
   * `apply-fleet.test.ts`'s `baseDeps` — so the suite never creates or
   * touches anything under the real developer/CI machine's home directory.
   */
  readonly recoveryRootDir?: string;
  /**
   * Injectable seam for the recovery-artifact CONSUME side (macf#988) —
   * mirrors `vaultRecipientDeps`'s own test-injection shape. `exists`
   * overrides the file-presence check (defaults to real `fs.existsSync`);
   * `decrypt` overrides the `age -d` call (defaults to real
   * `vault-read.ts::ageDecryptFile` via `readRecoveryArtifact`'s own
   * default). Production leaves both unset.
   */
  readonly recoveryReadDeps?: {
    readonly exists?: (path: string) => boolean;
    readonly decrypt?: (artifactPath: string, identityPath: string) => Promise<string>;
  };
  /**
   * Injectable seam for the registry-repo installation-coverage LIVE check
   * (groundnuty/macf#1012) — real default (when `undefined`) is
   * `registry-repo-coverage.ts::checkRepoInAppInstallation`. Only ever
   * invoked when `manifest.owner.registry.type === 'repo'`; every other
   * registry type never wires `validateInstall` for ordinary agents at all
   * (byte-identical `profile`/`org`/`local` behavior — requirement 5). Tests
   * inject a fake so the suite never makes a real `gh token generate --jwt`
   * / `fetch` call.
   */
  readonly checkRegistryRepoCoverage?: (appId: string, keyPath: string, owner: string, repo: string) => Promise<Presence>;
  /**
   * Injectable seam for the registry-repo EXISTENCE probe (groundnuty/
   * macf#1178 — `registry-repo-coverage.ts::buildRegistryRepoValidateInstall`'s
   * 6th param) — real default (when `undefined`) is
   * `registry-repo-coverage.ts::checkRegistryRepoExists`, an unauthenticated
   * `fetch`. Same reasoning as {@link checkRegistryRepoCoverage}'s own doc:
   * tests inject a fake so the suite never makes a real network call.
   */
  readonly checkRegistryRepoExists?: (owner: string, repo: string) => Promise<Presence>;
  /**
   * groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
   * — the ALREADY-OBSERVED macf-actions router pin per repo
   * (`ObservedState.agents[role].actionsPin` / `.controlRepoActionsPin`),
   * threaded in from `commands/bootstrap-apply.ts` (where `observed` is
   * computed once, before `applyFleet` is ever called) so this module never
   * performs a SECOND live read of the same fact (#1000 golden path).
   * `undefined` (the default — every existing test/caller that doesn't set
   * it) means "no observed data available this run" — `resolveActionsPinReconcile`
   * then treats every repo's observed pin as an UNREADABLE pin (same as a
   * live read that failed), which is the ALREADY-established "not drift,
   * not a match — LOW CONFIDENCE" case `plan.ts::actionsVersionItem` reports
   * as `create`: a declared `versions.actions` STILL attempts to force-write
   * (mirroring `version`(macf)'s symmetric create+update treatment — the
   * roll's own attempt resolves what the Mac-side plan could only guess
   * at); it simply never claims `already-current` without positive evidence
   * the pin actually matched.
   */
  readonly observedActionsPins?: {
    readonly agents: Readonly<Record<string, string | undefined>>;
    readonly controlRepo: string | undefined;
  };
  /**
   * groundnuty/macf#943 (DR-043 Amendment I2) — the TOP (`'flag'`) tier of
   * the runner-provisioning contract's endpoint precedence (groundnuty/
   * macf#1211 widened this from a bare env-fallback to the full flag/env/
   * scope/manifest chain — see `runner-platform.ts::
   * resolveRunnerPlatformEndpointWithProvenance`'s doc). `undefined`
   * (production — `commands/bootstrap-apply.ts` never sets this; there is
   * still no CLI flag, see that module's doc for why) falls through to env,
   * then {@link observedRunnerPlatformEndpointScope}, then the manifest's
   * own `transport.runner_platform_endpoint`. Tests set this explicitly so
   * the suite never reads `process.env`.
   */
  readonly runnerPlatformEndpoint?: string;
  /**
   * groundnuty/macf#1211 — the RAW registry-scope-variable value, threaded
   * in from `commands/bootstrap-apply.ts` (where `observed` — via
   * `observer.ts::githubRegistryObserver` — is computed once, before
   * `applyFleet` is ever called, the SAME `observedActionsPins` precedent
   * this field mirrors). `undefined` (the default — every existing test/
   * caller that doesn't set it) means "no observed scope value available
   * this run," which resolves identically to a genuinely-absent scope
   * variable — never a false "resolved." Deliberately the RAW value, not
   * plan-time's already-fully-resolved one: `apply` re-applies its OWN
   * flag/env-first precedence against this raw candidate, so a plan-time
   * resolution that happened to come from ENV doesn't get mis-reported as
   * `'scope'` in apply's own log line (see `plan.ts`'s `ObservedState.
   * runnerPlatformScopeVariable` doc for the full "why separate fields"
   * reasoning).
   */
  readonly observedRunnerPlatformEndpointScope?: string;
  /** Test-only override for the runner-platform HTTP call (groundnuty/macf#943) — production leaves this unset, taking the real global `fetch`. */
  readonly runnerPlatformFetch?: typeof fetch;
}

/**
 * DR-043 §D5 recipient-set reconciliation (macf#957) — the injectable seam
 * for {@link reconcileVaultRecipients}. Both fields optional; production
 * (`commands/bootstrap-apply.ts::resolveMutateDeps`) leaves this whole field
 * unset on `FleetApplyDeps`, taking the real `vault-read.ts` primitives.
 */
export interface VaultRecipientReconcileDeps {
  readonly readRecipientCount?: (vaultPath: string) => VaultRecipientCountResult;
  readonly reencrypt?: (vaultPath: string, identityPath: string, recipients: readonly string[]) => Promise<void>;
}

export interface AgentApplyRecord {
  readonly role: string;
  readonly identity: AgentApplyOutcome;
  /** `undefined` when identity wasn't resolved this run (`skipped-unverified` / `drift` / `failed`) — repo-init never runs for those. */
  readonly repoInit?: RepoInitStepOutcome;
}

export type VaultApplyOutcome =
  | { readonly status: 'skipped' }
  | { readonly status: 'written'; readonly path: string; readonly versioned: boolean }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * The FINAL control-repo commit+push this run (macf#857) — distinct from
 * `controlRepo`'s own outcome (which is about PROVISIONING the repo, step
 * 0). This is the LAST thing `applyFleet` does: push whatever changed in the
 * checkout (`fleet.lock`, `vault.age`, any still-present recovery
 * artifacts) back to `<fleet>-control`. `'skipped'` only when `controlRepo`
 * itself was `foreign`/`failed` (no checkout ever existed to push from).
 */
export type ControlRepoSyncOutcome =
  | { readonly status: 'skipped' }
  | { readonly status: 'pushed' }
  | { readonly status: 'nothing-to-commit' }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * DR-043 Amendment D phase 2 (macf#838) — the CA ceremony's render-safe
 * result. `resolve` is {@link CaApplyOutcome} (`apply-ca.ts::redactCaResolve`'s
 * output — NEVER a raw {@link CaResolveOutcome}, which would carry the
 * private key on a `'minted'` result). `registryLeg`/`repoLegs` are always
 * present (never `undefined`) — a `'skipped'` entry (via
 * `apply-ca.ts::skippedCaPublish`) makes "never attempted this run" as
 * visible as a real failure, mirroring `plan.ts`'s `unimplementedByApply`
 * discipline of never letting a gap render as silence.
 */
export interface CaApplyResult {
  readonly resolve: CaApplyOutcome;
  readonly registryLeg: EnsureVariableOutcome;
  readonly repoLegs: Readonly<Record<string, EnsureVariableOutcome>>;
}

/**
 * DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920) — the render-safe
 * result of the routing-client mint-or-skip + per-repo secret publish. NEVER
 * carries `certPem`/`keyPem` — `mint.status === 'minted'` is a boolean-ish
 * fact, not the credential itself (mirrors `CaApplyResult.resolve` never
 * carrying `keyPem`; see {@link redactRoutingClientMint}). `certLegs`/
 * `keyLegs` are always present (never `undefined`) — a `'skipped'` entry
 * (via `apply-routing-client.ts::skippedRoutingClientPublish`) makes "never
 * attempted this run" as visible as a real failure, same discipline
 * `CaApplyResult` already establishes.
 */
export interface RoutingClientApplyResult {
  readonly mint: RedactedRoutingClientMint;
  readonly certLegs: Readonly<Record<string, EnsureVariableOutcome>>;
  readonly keyLegs: Readonly<Record<string, EnsureVariableOutcome>>;
}

/**
 * Render-safe mirror of {@link RoutingClientMintOutcome} — NEVER carries
 * `certPem`/`keyPem`. Explicit field copies (not a spread) per
 * `redactIdentity`'s own precedent — a future variant adding a credential
 * field is then a compile error here, not a silent leak. `'failed'`
 * (groundnuty/macf#954) is a THIRD, distinct status from `'skipped'` — see
 * {@link RoutingClientMintOutcome}'s doc; `applyExitCode`
 * (`commands/bootstrap-apply.ts`) reads THIS field to decide whether a mint
 * exception needs operator attention, so the status must survive redaction
 * undisturbed.
 */
export interface RedactedRoutingClientMint {
  readonly status: 'minted' | 'skipped' | 'failed';
  readonly reason?: string;
}

/** Strip every credential field before a {@link RoutingClientMintOutcome} is allowed near `FleetApplyResult` or a `--json` render. Pure. Mirrors `apply-ca.ts::redactCaResolve`. */
export function redactRoutingClientMint(outcome: RoutingClientMintOutcome): RedactedRoutingClientMint {
  switch (outcome.status) {
    case 'minted':
      return { status: 'minted' };
    case 'skipped':
      return { status: 'skipped', reason: outcome.reason };
    case 'failed':
      return { status: 'failed', reason: outcome.reason };
  }
}

/**
 * groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
 * — the #1055 honest-report vocabulary applied to the router-pin reconcile:
 * `'reconciled'` (this run attempted AND the pin actually changed),
 * `'already-current'` (nothing needed reconciling — either the pin already
 * matched, or an attempted write turned out byte-identical), and
 * `'could-not-attempt'` (this run tried and failed, OR could not even try —
 * e.g. the agent's identity was unresolved this run). The three are
 * TEXTUALLY DISTINCT statuses, not phrasings of one summary line — see
 * `assert-the-wrong-path.md`.
 */
export type ActionsPinRepoStatus = 'reconciled' | 'already-current' | 'could-not-attempt';

export interface ActionsPinRepoResult {
  readonly repo: string;
  readonly status: ActionsPinRepoStatus;
  /** Present only for `'could-not-attempt'`. */
  readonly reason?: string;
}

/**
 * groundnuty/macf#1072 — the whole-run actions-pin reconcile report.
 * `attempted: false` (Amendment L2.4's "absent means no opinion", applied
 * to `versions.actions`) means `manifest.versions` was never declared this
 * run — `results` is empty and `target` is absent; no repo was even
 * examined, let alone force-rewritten.
 */
export interface ActionsPinReport {
  readonly attempted: boolean;
  readonly target?: string;
  readonly results: readonly ActionsPinRepoResult[];
}

/**
 * groundnuty/macf#1072 — the per-agent-repo report entry, computed from the
 * SAME decision (`pinReconcile.force`) and outcome (`repoInitOutcome`) the
 * per-agent loop already has in hand; never a second `resolveActionsPinReconcile`
 * call or a second read of anything. `force === false` is decision-time
 * "nothing to reconcile" (`already-current`, no repoInit write attempted for
 * THIS reason — the general identity-sync call may still have run for
 * labels/config, independent of this field). `force === true` defers to
 * `repoInitOutcome.pushed` — the ACTUAL git-diff ground truth (`apply-repo-init.ts`'s
 * `-A` commit) — over the decision-time guess: an attempted rewrite that
 * turns out byte-identical is honestly `already-current`, not `reconciled`.
 */
function actionsPinResultFor(repo: string, force: boolean, outcome: RepoInitStepOutcome): ActionsPinRepoResult {
  if (outcome.status === 'failed') return { repo, status: 'could-not-attempt', reason: outcome.reason };
  if (!force) return { repo, status: 'already-current' };
  return { repo, status: outcome.pushed ? 'reconciled' : 'already-current' };
}

export interface FleetApplyResult {
  /** DR-043 Amendment F step 0 — see `control-repo.ts`'s module doc. A `foreign`/`failed` outcome means `agents`/`vault` below are trivially empty/skipped: the run aborted before touching anything else. */
  readonly controlRepo: ControlRepoOutcome;
  /** The final push of this run's control-repo changes — see the type doc. */
  readonly controlRepoSync: ControlRepoSyncOutcome;
  /**
   * Control-repo `repo-init` (groundnuty/macf#1057) — the router workflow +
   * one label per declared fleet agent, run against the SAME `controlDir`
   * `controlRepoSync` above pushes. See `apply-control-repo-init.ts`'s
   * module doc. `'skipped'` only when `controlRepo` itself aborted (no
   * checkout ever existed to run repo-init against) — mirrors
   * `controlRepoSync`'s own abort shape.
   */
  readonly controlRepoInit: ControlRepoInitOutcome | { readonly status: 'skipped' };
  readonly lockPath: string;
  readonly finalLock: FleetLock | null;
  readonly agents: readonly AgentApplyRecord[];
  /**
   * The runner-ops App's identity outcome (groundnuty/macf#943) — a
   * SEPARATE field from `agents` above, deliberately: `agents` is keyed 1:1
   * with `manifest.agents[]` throughout this module (and every existing
   * `apply-fleet.test.ts` assertion on its length/contents assumes exactly
   * that), and the runner-ops is a fleet-level identity that is never
   * declared there. Reuses `AgentApplyOutcome`'s own union + the SAME
   * `applyIdentity` primitive `agents[]` entries are built from — see the
   * "runner-ops" call-site comment below for the ordering/vault-fold
   * rationale. ALWAYS present (never `undefined`) — a control-repo abort
   * (see `controlRepo` above) reports it as `'failed'` with a reason
   * pointing at the abort, mirroring `ca`/`routingClient`'s own
   * always-present-even-on-abort discipline below.
   *
   * `RunnerOpsApplyOutcome` (groundnuty/macf#1083), not the bare
   * `AgentApplyOutcome` every other identity field uses — this App is the
   * first CONDITIONALLY-required identity (`runnerOpsNeeded`'s doc), so its
   * outcome can additionally be `'not-needed'`: the fleet never declared
   * `routing.runner.runs_on: self-hosted`, so no create-or-reuse ceremony
   * was even attempted and zero consent-gate clicks were spent on it.
   */
  readonly runnerOps: RunnerOpsApplyOutcome;
  /**
   * The router App's identity outcome (groundnuty/macf#1074, groundnuty/
   * macf#1082) — a SEPARATE field from `agents`/`runnerOps`, same reasoning
   * as `runnerOps`'s own doc above: this is a fleet-level identity never
   * declared in `manifest.agents[]`. See `apply-router-app.ts`'s module doc
   * for why this App exists. ALWAYS present — a control-repo abort reports
   * it as `'failed'`, mirroring `runnerOps`'s own always-present discipline.
   *
   * **`RouterAppApplyOutcome`, not `AgentApplyOutcome`** (groundnuty/
   * macf#1082) — the ONE identity in this fleet whose outcome can be
   * `'vault-reused'` (the shared-scope zero-creation path, no ceremony ever
   * run). See `apply-router-app.ts::RouterAppApplyOutcome`'s doc for why
   * that status widens this field specifically rather than the shared
   * `AgentApplyOutcome` union every other identity uses.
   */
  readonly routerApp: RouterAppApplyOutcome;
  readonly vault: VaultApplyOutcome;
  /** Accumulated across every incremental `composeFleetLock` call this run — DR-043 Amendment A §A2 "never silently resolve" drift. */
  readonly identityChanges: readonly FleetLockIdentityChange[];
  /** DR-043 Amendment D phase 2 (macf#838) — the per-project CA ceremony + two-place publish (macf#806). See {@link CaApplyResult}'s doc. */
  readonly ca: CaApplyResult;
  /**
   * `MACF_TRUSTED_ACTORS` create-only writes, keyed by repo — empty `{}`
   * when `routing.runner` is not declared OR its `runs_on` isn't
   * `"self-hosted"` (macf#922; was `MACF_ROUTING_RUNS_ON`, see
   * `apply-routing.ts`'s doc). A `'failed'` leg here means the register-
   * before-route gate blocked the write for that repo — groundnuty/macf#993
   * corrected this from `'skipped'`: a declared runner is REQUIRED, so this
   * FAILS the whole run (`commands/bootstrap-apply.ts::applyExitCode`'s
   * `routingBad`), never a silent hosted-runner fallback. See
   * `apply-routing.ts::runnerTokenPollExhaustedReason` /
   * `runnerJustCreatedRepoReason` for the reason text.
   */
  readonly routing: Readonly<Record<string, EnsureVariableOutcome>>;
  /**
   * groundnuty/macf#943 (DR-043 Amendment I2) — the runner-provisioning
   * contract's `POST /runners` outcome per confirmed agent repo. Empty `{}`
   * when `routing.runner` is not declared OR `runs_on` isn't `"self-hosted"`
   * (same condition as `routing` above — no call is even attempted for a
   * hosted-runner fleet). **Never fails the run** — every value is a
   * {@link RunnerPlatformResult}, including `'unreachable'`/`'not-configured'`;
   * this field records what was ATTEMPTED, not whether the runner is usable.
   * `usability` (whether the poll below actually found a runner) is reported
   * separately, unchanged, via `routing`'s own `EnsureVariableOutcome`
   * values — see `apply-routing.ts`'s doc for why the two are deliberately
   * separate facts.
   */
  readonly runnerProvision: Readonly<Record<string, RunnerPlatformResult>>;
  /** DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920) — see {@link RoutingClientApplyResult}'s doc. ALWAYS present — a fleet with no confirmed agent repos this run still reports `mint.status`. `certLegs`/`keyLegs` are a PROJECTION of `routingSecrets` below (groundnuty/macf#1074) — kept for backward compat, not a second publish call. */
  readonly routingClient: RoutingClientApplyResult;
  /**
   * The unified six-secret routing publish result (groundnuty/macf#1074) —
   * `MACF_ROUTING_APP_ID`/`MACF_ROUTING_APP_KEY`/`ROUTING_CLIENT_CERT`/
   * `ROUTING_CLIENT_KEY`/`TS_OAUTH_CLIENT_ID`/`TS_OAUTH_SECRET`, each keyed
   * by repo. See `apply-routing-secrets.ts::publishRoutingSecrets`'s doc.
   * This is the field the decisive "all six secret names landed" test
   * asserts against — never `routingClient` alone, which only ever knew
   * about two of the six.
   */
  readonly routingSecrets: RoutingSecretsPublishResult;
  /**
   * The single bundled routing secret publish result (groundnuty/macf#1112)
   * — `MACF_ROUTING_BUNDLE`, keyed by repo. Published ALONGSIDE (never
   * instead of) `routingSecrets` above — additive, so a bundle-capable
   * generated caller finds `MACF_ROUTING_BUNDLE` present the same run a
   * legacy caller finds the six individual secrets present. See
   * `apply-routing-secrets.ts::publishRoutingBundle`'s doc for the
   * all-six-available-or-refuse composition rule.
   */
  readonly routingBundle: Readonly<Record<string, EnsureVariableOutcome>>;
  /**
   * DR-043 Amendment L extended to `versions.actions` (groundnuty/macf#1072)
   * — see {@link ActionsPinReport}'s doc. The REAL `applyFleet` return ALWAYS
   * sets this (`attempted: false` when `versions:` was never declared this
   * run) — optional at the TYPE level only so every pre-#1072 hand-built
   * `FleetApplyResult` test fixture (this file's own test suite has dozens)
   * keeps compiling and behaving byte-identically; every reader treats
   * `undefined` the same as `{ attempted: false, results: [] }`.
   */
  readonly actionsPin?: ActionsPinReport;
}

function agentVaultSecrets(appHandle: string, outcome: Extract<AgentApplyOutcome, { status: 'created' }>): VaultAgentSecrets {
  return {
    appHandle,
    appId: outcome.appId,
    installId: outcome.installId,
    clientId: outcome.credentials.clientId,
    clientSecret: outcome.credentials.clientSecret,
    webhookSecret: outcome.credentials.webhookSecret,
    pem: outcome.credentials.pem,
  };
}

/**
 * `repo-init` for a freshly-CREATED agent (groundnuty/macf#920 gap 1) —
 * threads the just-exchanged credentials (already in process memory; NEVER
 * re-reads the vault, NEVER re-prompts the operator) into
 * `applyRepoInitForAgent`'s `tokenSource` so label creation can actually
 * mint a token instead of degrading to `labels: {status:'skipped'}` (the
 * repro this issue closes). Writes ONE scratch-PEM file for the duration of
 * this ONE repo-init call — `apply-agent.ts`'s `writeScratchPem`/
 * `cleanupScratchPem`, the SAME 0600-scratch-file primitive that module
 * already uses for its own JWT mints, reused rather than duplicated. Always
 * cleaned up in `finally`, regardless of outcome.
 */
async function applyRepoInitForCreatedAgent(
  agent: FleetAgent,
  manifest: FleetManifest,
  identity: Extract<AgentApplyOutcome, { status: 'created' }>,
  deps: RepoInitStepDeps,
): Promise<RepoInitStepOutcome> {
  const keyPath = writeScratchPem(agent.role, identity.credentials.pem);
  try {
    const tokenSource: TokenSource = { appId: identity.appId, installId: identity.installId, keyPath };
    return await applyRepoInitForAgent(agent, manifest, deps, { tokenSource });
  } finally {
    cleanupScratchPem(keyPath);
  }
}

/**
 * The run-2 credential-less-POST fix (groundnuty/macf#943 follow-up) —
 * resolves the runner-ops App's private-key PEM for a `'reused'`/
 * `'resumed-install'` outcome, the ONE shape {@link runnerPlatformCredentialsFromOutcome}'s
 * in-memory path cannot cover (no PEM was exchanged THIS run). Reuses
 * `AgentApplyDeps.resolveKeyPath` — the SAME vault-backed closure
 * `confirmBeforeCreateGuard` already called, with the SAME `(role,
 * priorAppId)` pair, to confirm THIS reuse is real in the first place (see
 * `apply-agent.ts::confirmBeforeCreateGuard`). Calling it again is safe: the
 * closure is idempotent (it writes a deterministic per-role scratch-file
 * path and returns it; a second call re-writes the SAME path), and its
 * scratch directory is cleaned up ONCE, at the very end of the whole run, by
 * `runBootstrapApply`'s own `cleanupVaultScratch` obligation — never by this
 * function.
 *
 * `undefined` in EVERY one of these cases, honestly, never a thrown error
 * propagating out of the non-fatal runner-provisioning block that calls
 * this: the outcome isn't `'reused'`/`'resumed-install'` (nothing to
 * resolve); `resolveKeyPath` itself is unset (no `--vault`/`--identity-key`
 * were supplied this run — the vault-aware guard was never wired at all);
 * `resolveKeyPath` returns `undefined` (the vault doesn't hold this role's
 * key — `vaultRunnerOpsPrivateKeyPem`'s own absent case); or the resolved
 * path can't be read (a transient fs error). Every branch logs WHY, via
 * `log`, except the vault-derived-and-readable success path (silence is the
 * expected case there — the caller's own "credential resolved" framing
 * covers it).
 */
function resolveRunnerOpsVaultPem(outcome: RunnerOpsApplyOutcome, resolveKeyPath: AgentApplyDeps['resolveKeyPath'], log: (line: string) => void): string | undefined {
  if (outcome.status !== 'reused' && outcome.status !== 'resumed-install') return undefined;
  if (resolveKeyPath === undefined) {
    log('Runner platform: no --vault/--identity-key were supplied this run — cannot attempt a vault-derived credential for the reused runner-ops App.');
    return undefined;
  }
  const keyPath = resolveKeyPath(RUNNER_OPS_ROLE, outcome.appId);
  if (keyPath === undefined) {
    log('Runner platform: --vault/--identity-key were supplied, but the vault does not (yet) hold the runner-ops role\'s key — cannot resolve a credential for this call.');
    return undefined;
  }
  try {
    return readFileSync(keyPath, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`Runner platform: vault-derived runner-ops key at "${keyPath}" could not be read (${reason}) — continuing without credentials for this provisioning call.`);
    return undefined;
  }
}

/** `manifest.transport.age_recipients` is already the exact shape `writeVault`/`writeAgentRecoveryArtifact` expect (macf#852) — an empty list (unconfigured) is rejected loudly by each of those functions on its own. Named accessor kept for the doc-comment cross-references elsewhere in this module ("computed once, before the loop, from the same immutable ..." — see the module doc). */
function ageRecipients(manifest: FleetManifest): readonly string[] {
  return manifest.transport.age_recipients;
}

/**
 * Splice the fleet-level `writeRecoveryArtifact` + `findRecoveryArtifact`
 * implementations onto the base `AgentApplyDeps` `deps.buildAgentDeps`
 * returns — see this module's doc's "Recovery-artifact lifecycle" section
 * for why THIS module (not `apply-agent.ts`, not `commands/bootstrap-apply.ts`)
 * owns this wiring: it is the layer that knows the recovery ROOT
 * (`recoveryRootDir`, macf#988 — an operator-scoped, stable directory,
 * NOT the per-run control-repo checkout the pre-#988 wiring used), the
 * fleet name, `manifest.transport.age_recipients` (→ who to encrypt to),
 * and the operator's `--identity-key` (→ what can decrypt back). Reuses
 * `deps.vaultDeps.encrypt` — the SAME injectable `age` seam the final vault
 * write uses (task requirement: no separate encrypt seam to keep in sync).
 *
 * `writeRecoveryArtifact` logs the artifact's PATH (never its contents) on
 * success — the whole point of the artifact is that an operator can FIND it
 * after a crash, so the transcript has to say where. On failure, the path
 * is folded into the re-thrown error's message so it also reaches
 * `AgentApplyOutcome.reason` (the one surface `--json` output guarantees
 * callers see) without `apply-agent.ts` needing to know anything about
 * paths.
 *
 * `findRecoveryArtifact` (macf#988 consume side) checks existence
 * UNCONDITIONALLY (needs no `--identity-key`) so a found-but-undecryptable
 * artifact is still logged — the operator learns recovery is AVAILABLE even
 * on a run that didn't supply the key to consume it (task requirement 4:
 * "report when an artifact is found"). Only attempts the actual decrypt
 * when `deps.identityKeyPath` is set.
 */
function buildAgentDepsWithRecovery(
  recoveryRootDir: string,
  fleetName: string,
  recipients: readonly string[],
  deps: FleetApplyDeps,
): AgentApplyDeps {
  const base = deps.buildAgentDeps(deps.log);
  const encrypt: VaultEncryptFn = deps.vaultDeps.encrypt ?? ageEncryptToFile;
  const identityKeyPath = deps.identityKeyPath;
  const recoveryExists = deps.recoveryReadDeps?.exists ?? existsSync;
  const recoveryDecrypt = deps.recoveryReadDeps?.decrypt;
  return {
    ...base,
    writeRecoveryArtifact: async (role: string, creds: AppCredentials): Promise<void> => {
      const outPath = operatorRecoveryArtifactPath(recoveryRootDir, fleetName, role);
      try {
        await writeAgentRecoveryArtifact(role, creds, recipients, outPath, encrypt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${msg} (recovery-artifact path: ${outPath})`, { cause: err });
      }
      deps.log(`Role "${role}": credential durably recorded at ${outPath} (recovery artifact, pre-gate-2).`);
    },
    findRecoveryArtifact: async (role: string): Promise<AppCredentials | undefined> => {
      const artifactPath = operatorRecoveryArtifactPath(recoveryRootDir, fleetName, role);
      if (!recoveryExists(artifactPath)) return undefined;
      if (identityKeyPath === undefined) {
        deps.log(
          `Role "${role}": a durable recovery artifact exists at ${artifactPath} (from a prior run's crash before ` +
            'its credential reached the vault) but no --identity-key was given this ' +
            'run, so it cannot be decrypted. Re-run with --identity-key <path> to consume it automatically.',
        );
        return undefined;
      }
      try {
        const recovered = await readRecoveryArtifact(artifactPath, identityKeyPath, role, {
          exists: recoveryExists,
          ...(recoveryDecrypt !== undefined ? { decrypt: recoveryDecrypt } : {}),
        });
        if (recovered !== undefined) {
          deps.log(
            `Role "${role}": found + decrypted a durable recovery artifact at ${artifactPath} — consuming it ` +
              '.',
          );
        }
        return recovered;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        deps.log(
          `Role "${role}": a durable recovery artifact exists at ${artifactPath} but could not be decrypted ` +
            `(${reason}) — proceeding as though it were absent; GitHub's own App-name uniqueness remains the backstop.`,
        );
        return undefined;
      }
    },
  };
}

/**
 * Chains multiple `AgentApplyDeps.validateInstall`/`validateReuse`-shaped
 * hooks into ONE closure (groundnuty/macf#1128) — the per-agent loop below
 * needs BOTH the shared `repository_selection` scope guard
 * (`install-scope.ts::buildInstallScopeValidator`, unconditional, every
 * registry type) AND the registry-repo-coverage check
 * (`registry-repo-coverage.ts::buildRegistryRepoValidateInstall`, only when
 * `registry.type === 'repo'`) on the SAME `validateInstall` field —
 * `AgentApplyDeps` has room for exactly one hook per field, not a list.
 * Runs hooks IN ORDER and returns the FIRST rejection — the cheap, pure,
 * no-I/O scope check runs before the live network coverage check, so a
 * scope-only rejection never pays for a call that would have told the
 * operator nothing new (an `"all"`-scoped install trivially "covers" any
 * one repo, so the coverage check alone cannot see this failure at all).
 */
function composeValidateInstall(
  ...hooks: readonly ((install: ConfirmedInstall, keyPath: string) => InstallRejection | undefined | Promise<InstallRejection | undefined>)[]
): (install: ConfirmedInstall, keyPath: string) => Promise<InstallRejection | undefined> {
  return async (install, keyPath) => {
    for (const hook of hooks) {
      const rejection = await hook(install, keyPath);
      if (rejection !== undefined) return rejection;
    }
    return undefined;
  };
}

/**
 * DR-043 §D5 pre-flight — see the module doc's "Recovery-artifact
 * lifecycle" section. `confirmBeforeCreateGuard` returns `{action:
 * 'create'}` UNCONDITIONALLY (zero I/O) whenever `prior === undefined` —
 * so with `recipients` empty, EVERY such role is guaranteed to hit gate 1
 * only to have `writeRecoveryArtifact` reject moments later, having
 * already minted a real, irreversible GitHub App with an UNRECOVERABLE
 * credential (no recipient means no artifact is possible either). This
 * pre-flight recognizes that deterministically and refuses gate 1 for
 * those roles ENTIRELY — the only way the "credential-loss hole is closed"
 * claim in this module's + `apply-agent.ts`'s doc is actually true: a role
 * that DOES reach gate 1 is now guaranteed to have a non-empty
 * `recipients`, so `writeAgentRecoveryArtifact`'s own no-recipients
 * rejection becomes unreachable via this orchestrator (it remains as
 * defense-in-depth for a caller that drives `applyAgentIdentity` directly).
 * A role WITH a prior lock entry is unaffected — reuse/resume/skip/drift
 * never mint a new credential, so an unconfigured recipient can't lose one.
 */
function wouldCreateWithNoRecipient(prior: FleetLockAgent | undefined, recipients: readonly string[]): boolean {
  return prior === undefined && recipients.length === 0;
}

function noRecipientPreflightFailure(role: string): AgentApplyOutcome {
  return {
    role,
    status: 'failed',
    reason:
      `role "${role}" has no prior fleet.lock entry, so it would take the CREATE path — but ` +
      'transport.age_recipients is empty, so its credential could NEVER be made durable ' +
      '(no recipient to encrypt the recovery artifact OR the final vault to). Refusing to open consent gate 1 ' +
      "for a credential that can never be saved — mint an age recipient and add it to transport.age_recipients in " +
      'fleet.yaml, then re-run.',
  };
}

/**
 * DR-043 Amendment D pre-flight (groundnuty/macf#989) — the SIBLING of
 * {@link wouldCreateWithNoRecipient}, for the OTHER way a `created` role's
 * credential could never make it into the final vault: `vaultOutPath`
 * already has content (a REUSE clone brought back a prior apply's committed
 * `vault.age`), so the batched compose (`settleVault`, below) would need to
 * DECRYPT it before folding in a fresh receipt — and that decrypt needs an
 * operator identity (`deps.identityKeyPath`) this run may not have been
 * given. Without this pre-flight, the OLD bug recurs: gate 1 + gate 2 both
 * spend a real consent click, mint a real GitHub App, and ONLY THEN does
 * `settleVault` discover it cannot durably record the credential — by which
 * point the click is already spent and, absent a working recovery-artifact
 * path, the credential is gone (no program can re-read an App's private key
 * after the one-time manifest exchange). Refusing HERE, before gate 1, is
 * what makes "the credential-loss hole is closed" true for THIS cause too,
 * the same way `wouldCreateWithNoRecipient` already closes it for an empty
 * `transport.age_recipients`.
 *
 * A role WITH a prior lock entry is unaffected (reuse/resume/skip/drift
 * never mint a new credential); a role that would create but the vault
 * doesn't exist yet is unaffected either (the ordinary first-write path,
 * `writeVault`, needs no decrypt).
 */
function wouldCreateWithUnreadableVault(prior: FleetLockAgent | undefined, vaultAlreadyExists: boolean, identityKeyPath: string | undefined): boolean {
  return prior === undefined && vaultAlreadyExists && identityKeyPath === undefined;
}

function noVaultAccessPreflightFailure(role: string, vaultOutPath: string): AgentApplyOutcome {
  return {
    role,
    status: 'failed',
    reason:
      `role "${role}" has no prior fleet.lock entry, so it would take the CREATE path — but a vault already ` +
      `exists at "${vaultOutPath}" and no --identity-key (paired with --vault) was supplied to decrypt-and-fold ` +
      'its current contents into a fresh compose (the vault is never read-modify-written — a ' +
      "whole-payload rewrite of a LIVE vault must be composed from the vault's complete current contents, never a " +
      'partial payload). Refusing to open consent gate 1 for a credential whose vault write would fail after the ' +
      'fact. Re-run with "macf bootstrap apply --vault <path> --identity-key <path>" so the ' +
      'existing vault can be decrypted, merged, and rewritten.',
  };
}

/** The final control-repo sync commit message (macf#857) — one constant so every call site + every test asserting on it agree. */
export const CONTROL_REPO_SYNC_COMMIT_MESSAGE = 'chore(bootstrap): apply — fleet.lock / vault.age update';

/**
 * The zero-I/O early-abort shape shared by the name-length pre-flight and
 * the control-repo abort branch immediately below it — every field
 * `FleetApplyResult` requires, for a run that never touched anything.
 * Extracted (groundnuty/macf#943) so the pre-flight doesn't hand-roll a
 * second copy of this same all-fields-empty object.
 */
function abortedFleetApplyResult(manifestPath: string, priorLock: FleetLock | null, controlRepo: ControlRepoOutcome, reason: string): FleetApplyResult {
  return {
    controlRepo,
    controlRepoSync: { status: 'skipped' },
    controlRepoInit: { status: 'skipped' },
    lockPath: join(dirname(manifestPath), 'fleet.lock'),
    finalLock: priorLock,
    agents: [],
    runnerOps: { role: RUNNER_OPS_ROLE, status: 'failed', reason: `${reason} — see controlRepo above.` },
    routerApp: { role: ROUTER_APP_ROLE, status: 'failed', reason: `${reason} — see controlRepo above.` },
    vault: { status: 'skipped' },
    identityChanges: [],
    ca: {
      resolve: { status: 'failed', reason: `${reason} — see controlRepo above.` },
      registryLeg: { status: 'skipped', reason: `${reason} — see controlRepo above.` },
      repoLegs: {},
    },
    routing: {},
    runnerProvision: {},
    routingClient: {
      mint: { status: 'skipped', reason: `${reason} — see controlRepo above.` },
      certLegs: {},
      keyLegs: {},
    },
    routingSecrets: skippedRoutingSecretsPublish([], `${reason} — see controlRepo above.`),
    routingBundle: skippedRoutingBundlePublish([], `${reason} — see controlRepo above.`),
    // groundnuty/macf#1072 — the control repo aborted before step 0.5 (its
    // own repo-init) ever ran, so no repo was even examined for this run —
    // `attempted: false`, same as the "versions: never declared" gate.
    actionsPin: { attempted: false, results: [] },
  };
}

/**
 * Drive the full fleet through control-repo provisioning (step 0) + identity
 * + repo-init + the (deferred, batched) vault write + a final control-repo
 * push. NEVER throws — every failure resolves into the returned result's
 * `controlRepo`/`controlRepoSync` outcomes, per-agent `identity`/`repoInit`
 * outcomes, or the top-level `vault` outcome; the caller
 * (`commands/bootstrap-apply.ts`) decides the exit code and renders the
 * human summary. See the module doc's "Bootstrap ordering" section for the
 * full sequence.
 */
export async function applyFleet(
  manifest: FleetManifest,
  manifestPath: string,
  priorLock: FleetLock | null,
  deps: FleetApplyDeps,
): Promise<FleetApplyResult> {
  // --- Name-length pre-flight (groundnuty/macf#943) — THE FIRST check in
  // the whole run, before EVEN the control repo (which itself precedes any
  // consent gate). Zero I/O; every App name this run would need (every
  // agent's derived handle + the runner-ops's) is knowable from the
  // manifest alone. `commands/bootstrap-apply.ts` runs the SAME check even
  // earlier (right after parsing the manifest, before `--dry-run` even
  // computes a plan) so a violating fleet.yaml never reaches this far in
  // practice — this second call site exists so the refusal holds even for a
  // caller that drives `applyFleet` directly (every test in this suite; a
  // future programmatic caller), and so "the gate seam is never invoked" is
  // provable as a property of `applyFleet` itself, not just of the CLI
  // wrapper around it.
  const nameLengthCheck: AppNameLengthCheck = checkAppNameLengths(manifest);
  if (!nameLengthCheck.ok) {
    deps.log(`ABORTING entire apply run before any consent gate — ${nameLengthCheck.reason}`);
    return abortedFleetApplyResult(
      manifestPath,
      priorLock,
      { status: 'failed', repo: `${manifest.owner.account}/${deriveControlRepoName(manifest.metadata.name)}`, reason: nameLengthCheck.reason },
      'name-length pre-flight refused',
    );
  }

  // --- Step 0 (DR-043 Amendment F, macf#857): the control repo. THE FIRST
  // mutating action of this run — before any consent gate, before ANY
  // per-agent processing. See control-repo.ts's module doc for the
  // ownership/custody model this enforces.
  const controlRepo = await provisionControlRepo(manifest, manifestPath, deps.controlRepoDeps, deps.controlRepoOptions);
  // DR-043 Amendment G: `'archived'` aborts exactly like `'foreign'`/`'failed'`
  // — `provisionControlRepo` already refused to touch ANYTHING (no
  // unarchiveRepo, no clone) when it returns this status, so there is
  // nothing partial to unwind; the run simply never started.
  if (controlRepo.status === 'foreign' || controlRepo.status === 'failed' || controlRepo.status === 'archived') {
    deps.log(`Control repo "${controlRepo.repo}": ABORTING entire apply run — ${controlRepo.reason}`);
    // Nothing else is ever touched — no agent repo, App, or install. A
    // best-effort fallback `lockPath` (never actually written to) so the
    // caller still has SOMETHING path-shaped to report.
    return abortedFleetApplyResult(manifestPath, priorLock, controlRepo, 'control repo aborted before any provisioning could run');
  }
  deps.log(`Control repo "${controlRepo.repo}": ${controlRepo.status.toUpperCase()} (checkout: ${controlRepo.localDir}).`);

  const controlDir = controlRepo.localDir;
  // groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
  // — one entry per router-carrying repo (`fleet-manifest.ts::routerCarryingRepos`)
  // this run had an opinion about; stays empty when `manifest.versions` is
  // absent (see `actionsPin`'s final assembly near the end of this
  // function, `attempted: false`). Declared here (control repo is step 0,
  // before any per-agent processing) so both this control-repo entry and
  // every per-agent entry (pushed inside the loop below) land in ONE array.
  const actionsPinResults: ActionsPinRepoResult[] = [];

  // --- Step 0.5 (groundnuty/macf#1057): control-repo repo-init — the router
  // workflow + one label per DECLARED fleet agent, so cross-agent
  // coordination has a repo every agent's App can already reach. Runs
  // straight against `controlDir` (no clone/commit/push of its own — see
  // `apply-control-repo-init.ts`'s module doc); commit/push happens ONCE,
  // at the very end of this run, via `syncControlRepo` below. Non-fatal on
  // failure (reported on the result, logged loud) — an agent repo's own
  // repo-init already established this precedent (`applyRepoInitForAgent`'s
  // callers below), and a control-repo-init failure must not prevent the
  // rest of the run (identities, vault) from proceeding.
  // groundnuty/macf#1072 — the SAME `resolveActionsPinReconcile` decision
  // point every per-agent call site routes through, applied to the control
  // repo's ALREADY-OBSERVED pin (`deps.observedActionsPins?.controlRepo`,
  // never a second live read here — #1000 golden path).
  const controlPinReconcile = resolveActionsPinReconcile(manifest.versions?.actions, deps.observedActionsPins?.controlRepo);
  // groundnuty/macf#1221 — the credential-path fix: no agent identity is
  // minted yet this early in the run, so the only legitimate tokenSource
  // for control-repo label creation is an ALREADY-EXISTING agent's
  // vault-stored credential (`priorLock` + the SAME `resolveKeyPath`
  // primitive `resolveRunnerOpsVaultPem` already uses below). `undefined`
  // here (a genuinely first-ever provision, or no `--vault`/`--identity-key`
  // this run) is an honest "nothing to try" — see
  // `resolveControlRepoLabelTokenSource`'s own doc for how that's reported.
  const controlRepoLabelTokenSource = resolveControlRepoLabelTokenSource(
    manifest,
    priorLock,
    deps.buildAgentDeps(deps.log).resolveKeyPath,
  );
  const controlRepoInit = await applyControlRepoInit(
    controlDir,
    manifest,
    { repoInit: deps.repoInitDeps.repoInit },
    {
      actionsVersion: controlPinReconcile.actionsVersion,
      force: controlPinReconcile.force,
      ...(controlRepoLabelTokenSource !== undefined ? { tokenSource: controlRepoLabelTokenSource } : {}),
    },
  );
  if (manifest.versions) {
    // Unlike the per-agent case, the control repo's write here is NOT
    // pushed yet (that happens once, at the very end of this run, via
    // `syncControlRepo` — see this section's own doc above) — there is no
    // local "did the byte content actually change" ground truth available
    // at this point the way `RepoInitStepOutcome.pushed` gives the agent
    // path. The decision-time signal (`force`) is therefore the report:
    // `force: false` means nothing needed reconciling (`already-current`);
    // `force: true` + a successful write means this run DID reconcile it
    // (`reconciled`) — `controlRepoSync`'s own outcome (reported
    // separately, `FleetApplyResult.controlRepoSync`) is what confirms the
    // push landed.
    actionsPinResults.push(
      controlRepoInit.status === 'failed'
        ? { repo: controlRepoInit.repo, status: 'could-not-attempt', reason: controlRepoInit.reason }
        : { repo: controlRepoInit.repo, status: controlPinReconcile.force ? 'reconciled' : 'already-current' },
    );
  }
  if (controlRepoInit.status === 'failed') {
    deps.log(`Control repo "${controlRepo.repo}" repo-init: FAILED — ${controlRepoInit.reason}`);
  } else if (!controlRepoInit.labelsGoodEnough) {
    // groundnuty/macf#1221 — a legitimate tokenSource WAS supplied this run
    // (see the resolveControlRepoLabelTokenSource call above) and labels
    // still did not fully land: a genuine problem, not the honest
    // credential-unavailable gap the `else` branch below narrates. Never
    // claims labels are "missing" when the outcome is `'skipped'` (the
    // mint/attempt itself never got a confirmed answer) — the honest-
    // unknown floor: say UNCONFIRMED, never assert absence or presence
    // without having actually read the state.
    const labels = controlRepoInit.labels;
    const detail =
      labels.status === 'skipped'
        ? `label state is UNCONFIRMED — ${labels.reason}`
        : labels.status === 'partial-failure'
          ? `label creation FAILED for: ${labels.failed.join(', ')}`
          : 'label state is UNCONFIRMED';
    deps.log(
      `Control repo "${controlRepo.repo}" repo-init: ⚠ ${detail} (${controlRepoInit.agents.join(', ')}) — ` +
        'a resolved credential was available this run, so this is not the ordinary "no token yet" gap. ' +
        'This fleet cannot be confirmed routable until labels are verified.',
    );
  } else {
    deps.log(
      `Control repo "${controlRepo.repo}" repo-init: labels ${controlRepoInit.labels.status} for [${controlRepoInit.agents.join(', ')}]` +
        (controlRepoInit.workflowAndConfigAllowlisted
          ? '.'
          : ' (router workflow was written locally but is not yet part of what gets committed — see the release notes for this behavior).'),
    );
  }

  const lockPath = join(controlDir, 'fleet.lock');
  const secretsDir = join(controlDir, 'secrets');
  const vaultOutPath = join(secretsDir, 'vault.age');
  const recipients = ageRecipients(manifest);
  // DR-043 Amendment D pre-flight (macf#989) — computed ONCE, right after
  // the control-repo checkout is confirmed (this is the earliest point
  // `vaultOutPath` reflects reality: a REUSE clone brings back whatever the
  // prior apply committed, a CREATE clone has nothing yet). Fed into
  // `wouldCreateWithUnreadableVault` below for every role that might take
  // the CREATE path this run, AND reused (same resolved function, same
  // path) inside `settleVault` — a test that stubs `vaultDeps.exists`
  // therefore sees ONE coherent answer everywhere in this run, not two
  // independently-resolved calls that could in principle disagree.
  const vaultAlreadyExists = (deps.vaultDeps.exists ?? existsSync)(vaultOutPath);
  // macf#988 review — `secretsDir` MUST exist before `settleVault`'s
  // `writeVault` call (below) ever runs `age -o <vaultOutPath>`, which does
  // NOT create missing parent directories itself. Pre-#988, this held only
  // as an UNDOCUMENTED side effect: the per-agent recovery-artifact write
  // used to live at `<secretsDir>/recovery/<role>.age`, and its own
  // `mkdirSync(..., { recursive: true })` recursively created `secretsDir`
  // as a byproduct, for any run with at least one `created` role. Moving
  // the recovery artifact OUT of `secretsDir` (this fix's whole point)
  // removes that byproduct — the precondition needs to be its own explicit
  // statement now, not inherited from an unrelated write. (This was ALSO
  // latently broken before #988 for a run that mints a FRESH CA/routing-
  // client with ZERO created agents — no recovery write ever fired to
  // create the directory as a side effect; this fix closes that case too.)
  mkdirSync(secretsDir, { recursive: true });
  // macf#988 (DR-043 Amendment B) — the recovery-artifact ROOT is
  // DELIBERATELY not derived from `controlDir` (see `buildAgentDepsWithRecovery`'s
  // doc): `controlDir` is a per-run `mkdtemp` checkout that dies with the
  // process, exactly the location this fix moves the artifact AWAY from.
  const recoveryRootDir = deps.recoveryRootDir ?? defaultOperatorRecoveryRootDir();

  // Self-heal (macf#857): a REUSE clone brings back whatever the PRIOR apply
  // already committed. Prefer that over the caller-supplied `priorLock`
  // (which today still reads from the OPERATOR's local manifest directory —
  // a residual pre-Amendment-F read path, see the module doc) whenever the
  // checkout actually has one; a fresh CREATE never has one yet, so this
  // degrades to `priorLock` there (and in every existing test's no-op fake
  // clone, which never populates the checkout).
  let currentLock = readFleetLockFile(lockPath) ?? priorLock;

  const records: AgentApplyRecord[] = [];
  const pendingVaultAgents: VaultAgentSecrets[] = [];
  const pendingCreatedUpdates: Record<string, FleetLockAgentUpdate> = {};
  const identityChanges: FleetLockIdentityChange[] = [];
  // DR-043 Amendment D phase 2 (macf#838) — agent repos CONFIRMED to exist
  // this run (created OR already-present; NOT the ones whose ensureAgentRepo
  // failed). Feeds both the CA two-place repo legs and the routing-var
  // write below — neither can target a repo that doesn't exist.
  const confirmedRepos: string[] = [];
  // macf#972 — the SUBSET of `confirmedRepos` whose `ensureAgentRepo` outcome
  // was `'created'` (not `'present'`) this run — the base set fed to
  // `apply-routing.ts::publishTrustedActorsGated`'s `justCreatedRepos` param
  // so it skips the 600s poll for a repo that has no reason yet to have a
  // runner registered. Corrected by macf#943: this run MAY now provision one
  // in-band (the runner-platform-contract call, below) — see
  // `justCreatedReposStillFast`, computed right before `publishTrustedActorsGated`'s
  // call site, for the set actually passed through (this raw set minus any
  // repo the provisioning call reported `'ok'` for). A repo already present
  // before this run keeps polling regardless — a runner may legitimately be
  // mid-registration for it independent of anything this run does.
  const justCreatedRepos = new Set<string>();

  const writeIncrementalLock = (role: string, update: FleetLockAgentUpdate): void => {
    const composed = composeFleetLock({ fleet: manifest.metadata.name, previous: currentLock, agentUpdates: { [role]: update } });
    writeFleetLock(lockPath, composed.lock);
    currentLock = composed.lock;
    identityChanges.push(...composed.identityChanges);
  };

  // groundnuty/macf#1162 — the sibling of `writeIncrementalLock` for a
  // credential this run did NOT mint/confirm itself (today: only the
  // router App's cross-fleet `'vault-reused'` outcome — see
  // `fleet-lock.ts::ScopeCredentialUpdate`'s doc for why this can never be
  // an `agentUpdates` entry). `agentUpdates: {}` — this write touches NO
  // agent; every prior agent entry carries forward verbatim through
  // `composeFleetLock`'s own no-prune contract.
  const writeScopeCredentialMarker = (role: string, originFleet: string | undefined): void => {
    const composed = composeFleetLock({
      fleet: manifest.metadata.name,
      previous: currentLock,
      agentUpdates: {},
      scopeCredentials: [{ role, ...(originFleet !== undefined ? { originFleet } : {}) }],
    });
    writeFleetLock(lockPath, composed.lock);
    currentLock = composed.lock;
  };

  // groundnuty/macf#1012 — computed ONCE (fleet-level, not per-agent):
  // `registry.type === 'repo'` is the only registry shape this run needs to
  // live-verify install coverage for. `type: profile`/`org`/`local` never
  // reach `buildRegistryRepoValidateInstall` at all — byte-identical
  // behavior to pre-#1012 (requirement 5). groundnuty/macf#1156 — reads
  // `requiredRegistryRepoCoverage(manifest)` (the SAME function
  // `apply-agent.ts::installReposForIdentity` calls to fold the control repo
  // into the gate-2 instruction/`--dry-run` preview) instead of a local
  // `registry.owner`/`registry.repo` field read, so the CHECK wired below
  // and the INSTRUCTION the operator reads can never independently drift —
  // see that function's own doc for the incident this closes.
  const registryCoverage = requiredRegistryRepoCoverage(manifest);

  const totalAgents = manifest.agents.length;
  for (const [agentIndex, agent] of manifest.agents.entries()) {
    // Operator-facing progress context (consent-gate UX fix) — a live
    // provisioning run showed the operator has no way to tell WHICH agent a
    // consent-gate wait belongs to once several are queued; every log line
    // for this agent's turn (from THIS loop AND from `applyAgentIdentity`'s
    // own gate messages, via `agentDeps.log` below) carries the same tag.
    // Suppressed for a single-agent fleet — "(agent 1/1)" is noise when
    // there's no ambiguity to resolve.
    const scopedLog = (line: string): void => {
      deps.log(totalAgents > 1 ? `[agent ${String(agentIndex + 1)}/${String(totalAgents)}] ${line}` : line);
    };
    // Built PER AGENT (not once for the whole run) specifically so its
    // `log` carries this agent's own progress tag — see `scopedLog` above.
    // `deps.buildAgentDeps` / the recovery-artifact writer are otherwise
    // identical every call; rebuilding is cheap (no I/O until a field is
    // invoked).
    const agentDepsBase = buildAgentDepsWithRecovery(recoveryRootDir, manifest.metadata.name, recipients, { ...deps, log: scopedLog });
    // groundnuty/macf#1128 — EVERY agent App's install is now checked
    // against `repository_selection === 'selected'`, unconditionally (the
    // runner-ops/router App already had this; ordinary agents had NOTHING —
    // the exact gap two live fleets hit: a coordination agent App installed
    // `"all"`-scoped, carrying DR-019's permission set onto every repo in
    // the org). Wired onto `validateInstall` ONLY (the CREATE/resume-install
    // path, via `runGate2`) — deliberately NOT onto `validateReuse` too:
    // `apply-agent.ts`'s own doc on `validateReuse` already records that
    // silently widening a validateInstall-only check onto reuse-confirmed
    // is a behavior change for an EXISTING caller nobody asked for, and that
    // doing exactly this for the registry-repo-coverage check below broke 6
    // unrelated tests whose fixtures never populate `repositorySelection` on
    // a reuse-confirmed install. The residual this leaves — an
    // already-`reused` role whose install scope drifted (or was wrong from
    // the start, on a fleet that predates this fix) — is what
    // `plan.ts`'s `computePlan`-computed `FleetPlan.installScopeDrift`
    // exists to catch for an ALREADY-provisioned fleet; see that field's
    // doc.
    const appHandle = deriveAppHandle(manifest.metadata.name, agent.role);
    const installScopeValidate = buildInstallScopeValidator(appHandle);
    // groundnuty/macf#1012 — when the registry is repo-scoped, every
    // ordinary agent's install must ALSO be live-verified to actually cover
    // the registry repo (never the runner-ops, below — it never touches the
    // registry). Wired here (not in `apply-agent.ts::realAgentApplyDeps`)
    // because this check needs FLEET-level context
    // (`manifest.owner.registry`) `realAgentApplyDeps` doesn't have — same
    // reasoning `buildAgentDepsWithRecovery`'s own splice already
    // establishes for `writeRecoveryArtifact`/`findRecoveryArtifact`.
    const agentDeps: AgentApplyDeps = (() => {
      if (registryCoverage === undefined) return { ...agentDepsBase, validateInstall: installScopeValidate };
      // `registryRepoValidate` is wired onto BOTH `validateInstall` (CREATE
      // / resume-install, via `runGate2`, composed with the scope check
      // above) AND `validateReuse` (an already-provisioned role
      // re-confirmed on a re-run, via `applyIdentity`'s `reuse-confirmed`
      // branch — see that field's doc for why it's separate from
      // `validateInstall`) — UNCHANGED from before this issue; only
      // `validateInstall` gains the new scope check.
      const registryRepoValidate = buildRegistryRepoValidateInstall(
        registryCoverage.owner,
        registryCoverage.repo,
        appHandle,
        scopedLog,
        deps.checkRegistryRepoCoverage,
        deps.checkRegistryRepoExists,
      );
      return {
        ...agentDepsBase,
        validateInstall: composeValidateInstall(installScopeValidate, registryRepoValidate),
        validateReuse: registryRepoValidate,
      };
    })();

    // macf#857 — ensure the agent's OWN repo exists BEFORE either consent
    // gate: gate 2's install page can't list a repo that doesn't exist yet
    // (the exact failure the first live provision, #854, hit on the
    // operator's first Install click). macf#1034 (DR-043 Amendment G
    // correction) — the SAME call also revives an archived agent repo, under
    // the SAME single plan-approve-once "yes" `deps.controlRepoOptions`
    // already threads to `provisionControlRepo` (see `agentRepoOptions`'s
    // doc on `FleetApplyDeps`).
    const repoOutcome = await ensureAgentRepo(agent, manifest, deps.agentRepoDeps, deps.agentRepoOptions);
    // macf#1034 — `'archived'` (un-archive not confirmed) and `'unknown'`
    // (existence/archived-state inconclusive) abort exactly like `'failed'`:
    // none of the three leaves a repo this run can safely install an App
    // onto or push routing config to, so this agent's turn stops here —
    // same treatment `applyFleet`'s control-repo step 0 already gives its
    // own `'archived'`/`'failed'` outcomes.
    if (repoOutcome.status === 'failed' || repoOutcome.status === 'archived' || repoOutcome.status === 'unknown') {
      scopedLog(`Role "${agent.role}": agent repo "${agent.repo}" ${repoOutcome.status.toUpperCase()} — ${repoOutcome.reason}`);
      records.push({
        role: agent.role,
        identity: {
          role: agent.role,
          status: 'failed',
          reason: `agent repo "${agent.repo}" could not be ensured before consent gate 1: ${repoOutcome.reason}`,
        },
      });
      continue;
    }
    scopedLog(`Role "${agent.role}": agent repo "${agent.repo}" ${repoOutcome.status.toUpperCase()}.`);
    confirmedRepos.push(agent.repo);
    // macf#972 — only a FRESH creation this run disqualifies the repo from
    // the register-before-route poll; `'present'`/`'revived'` (pre-existing)
    // keeps polling exactly as today.
    if (repoOutcome.status === 'created') {
      justCreatedRepos.add(agent.repo);
    }

    const prior = currentLock?.agents.find((a) => a.role === agent.role);
    // DR-043 §D5 pre-flight — see `noRecipientPreflightFailure`'s doc.
    // Never opens gate 1 for a role that could never make its credential
    // durable in the first place. Two independent ways that can be true —
    // no recipient to encrypt to AT ALL, or a live vault this run cannot
    // decrypt to fold into (macf#989) — checked in sequence.
    const rawIdentity = wouldCreateWithNoRecipient(prior, recipients)
      ? noRecipientPreflightFailure(agent.role)
      : wouldCreateWithUnreadableVault(prior, vaultAlreadyExists, deps.identityKeyPath)
        ? noVaultAccessPreflightFailure(agent.role, vaultOutPath)
        : await applyAgentIdentity(agent, manifest, prior, agentDeps);

    // groundnuty/macf#1016 — see `registry-repo-coverage.ts`'s "The gap
    // THAT coverage scope leaves open" doc section for the full mechanism.
    // `skip-unverified` means `confirmBeforeCreateGuard` never reached
    // `reuse-confirmed`/`resume-install`, so `validateReuse`/`validateInstall`
    // (and this fleet's registry-repo coverage check with them, wired above
    // when `registry.type === 'repo'`) never ran for this role. Gated on
    // `agentDeps.resolveKeyPath === undefined` — THIS RUN never had a
    // vault-aware resolver wired at all (requirement 3: "a vault-aware run
    // is unchanged" — a run where `resolveKeyPath` IS wired but still lands
    // on skip-unverified for an unrelated reason, e.g. `confirmAppInstallation`
    // itself unconfirmable, is untouched; re-running with the SAME flags
    // would not fix that case, so this note's advice would be wrong there).
    // Extends — never replaces — `confirmBeforeCreateGuard`'s own reason
    // text, so both gaps are named in one string (Amendment A: unverified is
    // `unknown`, never silently `ok`).
    const identity: AgentApplyOutcome =
      registryCoverage !== undefined && rawIdentity.status === 'skipped-unverified' && agentDeps.resolveKeyPath === undefined
        ? {
            ...rawIdentity,
            reason: `${rawIdentity.reason} ${registryRepoCoverageUnverifiedOnSkipNote(deriveAppHandle(manifest.metadata.name, agent.role), registryCoverage.owner, registryCoverage.repo)}`,
          }
        : rawIdentity;

    let repoInitOutcome: RepoInitStepOutcome | undefined;
    const handle = deriveAppHandle(manifest.metadata.name, agent.role);

    // groundnuty/macf#1072 (DR-043 Amendment L extended to `versions.actions`)
    // — computed unconditionally (pure, no I/O) but only PUSHED into
    // `actionsPinResults` when `manifest.versions` is declared, mirroring
    // `apply-version.ts`'s own "absent means no opinion, nothing recorded"
    // gate. `deps.observedActionsPins` is the ALREADY-READ pin
    // (`ObservedState.agents[role].actionsPin`, computed once in
    // `commands/bootstrap-apply.ts` before `applyFleet` was ever called) —
    // never a second live read here (#1000 golden path).
    const pinReconcile = resolveActionsPinReconcile(manifest.versions?.actions, deps.observedActionsPins?.agents[agent.role]);

    if (identity.status === 'reused' || identity.status === 'resumed-install') {
      writeIncrementalLock(agent.role, { appId: identity.appId, installId: identity.installId });
      // No PEM in process memory this run for `reused`/`resumed-install` (no
      // vault-decrypt seam wired into repo-init yet — see
      // `RepoInitStepOptions.tokenSource`'s doc) — pre-existing, acknowledged
      // gap; groundnuty/macf#920 closes ONLY the `created` path below, which
      // is where apply-fleet.ts already holds a freshly-exchanged credential.
      repoInitOutcome = await applyRepoInitForAgent(agent, manifest, deps.repoInitDeps, {
        actionsVersion: pinReconcile.actionsVersion,
        force: pinReconcile.force,
      });
      if (manifest.versions) actionsPinResults.push(actionsPinResultFor(agent.repo, pinReconcile.force, repoInitOutcome));
    } else if (identity.status === 'created') {
      const secrets = agentVaultSecrets(handle, identity);
      pendingVaultAgents.push(secrets);
      pendingCreatedUpdates[agent.role] = {
        appId: identity.appId,
        installId: identity.installId,
        secrets: vaultAgentSecretsForFingerprint(secrets),
      };
      repoInitOutcome = await applyRepoInitForCreatedAgent(agent, manifest, identity, deps.repoInitDeps);
      // A brand-new repo's workflow file is written unconditionally as part
      // of creation (no existing file to force past) — the declared pin (or
      // the bootstrap default, when nothing was declared) lands regardless
      // of `force`. Reported 'reconciled' when `versions:` was declared
      // (the pin now matches it, by construction); no entry otherwise.
      if (manifest.versions && repoInitOutcome.status === 'applied') {
        actionsPinResults.push({ repo: agent.repo, status: 'reconciled' });
      } else if (manifest.versions && repoInitOutcome.status === 'failed') {
        actionsPinResults.push({ repo: agent.repo, status: 'could-not-attempt', reason: repoInitOutcome.reason });
      }
    } else if (manifest.versions) {
      // skipped-unverified / drift / failed: no lock write, no repo-init —
      // this agent's identity is unresolved this run, so its router pin
      // cannot be examined or reconciled either.
      actionsPinResults.push({
        repo: agent.repo,
        status: 'could-not-attempt',
        reason: `agent identity is unresolved this run (${identity.status}) — the router pin was not examined`,
      });
    }

    records.push({ role: agent.role, identity, repoInit: repoInitOutcome });
  }

  // groundnuty/macf#1071 — the publish target set for anything the router
  // job itself needs (today: all six routing secrets — see the unified
  // publish section below). See
  // `apply-control-repo-init.ts::deriveRouterCarryingRepos`'s doc for the
  // fix's decisive derivation logic.
  const routerCarryingRepos: readonly string[] = deriveRouterCarryingRepos(confirmedRepos, controlRepo, controlRepoInit);

  // --- groundnuty/macf#943: the runner-ops App — a FLEET-LEVEL
  // identity (never declared in manifest.agents[]; `FleetManifestSchema` has
  // no knowledge of this role), driven through the EXACT SAME
  // confirm-before-create → gate 1 → gate 2 primitive
  // (apply-agent.ts::applyIdentity) every coordination agent uses above —
  // "a second, differently-configured use of that path, not a parallel
  // implementation" (task brief). Runs AFTER the per-agent loop (a failure
  // here never blocks agent provisioning, matching the CA/routing-client
  // ceremonies' own ordering below) and BEFORE `settleVault` — `writeVault`
  // is single-shot whole-payload (its own module doc), so a freshly-minted
  // credential MUST fold into the SAME batched call as the fleet's
  // agents/CA/routing-client; there is no second write later in this run to
  // catch one that missed this window. Its recovery artifact is written the
  // SAME way an agent's is (`buildAgentDepsWithRecovery`, reused verbatim)
  // and deleted in the SAME `vault.status === 'written'` branch that deletes
  // every agent's — its role is folded into `pendingCreatedUpdates` alongside
  // the agents' for exactly that reason (see that branch's
  // `for (const role of Object.keys(pendingCreatedUpdates))` loop below).
  //
  // groundnuty/macf#1083 — but ONLY when `runnerOpsNeeded(manifest)` holds.
  // Its sole purpose is minting self-hosted-runner registration tokens; a
  // fleet that never declares `routing.runner.runs_on: self-hosted` has
  // nothing for it to do, so the entire create-or-reuse ceremony below is
  // SKIPPED ENTIRELY for that fleet — `runnerOpsDeps` is never even built —
  // and the outcome is synthesized inline as `'not-needed'`. This is what
  // makes a hosted-runner fleet spend ZERO consent-gate clicks on this
  // identity. `plan.ts::runnerOpsItem` reads the SAME `runnerOpsNeeded`
  // predicate so plan and apply can never disagree about whether this App is
  // required.
  const runnerOpsPrior = currentLock?.agents.find((a) => a.role === RUNNER_OPS_ROLE);
  let pendingRunnerOpsVaultSecrets: VaultRunnerOpsSecrets | undefined;
  let runnerOpsIdentity: RunnerOpsApplyOutcome;
  // groundnuty/macf#943 follow-up (the run-2 credential-less-POST fix) —
  // captured ONLY inside the `runnerOpsNeeded` branch below (the same place
  // `runnerOpsDeps` itself is built), so the runner-provisioning block
  // further down can re-resolve THIS SAME vault-backed key path for a
  // 'reused'/'resumed-install' outcome without inventing a second lookup
  // mechanism. See `resolveRunnerOpsVaultPem`'s doc for why re-calling it is
  // safe (idempotent — the SAME scratch path `confirmBeforeCreateGuard`
  // already resolved, and wrote, while confirming this reuse).
  let runnerOpsResolveKeyPath: AgentApplyDeps['resolveKeyPath'];
  if (!runnerOpsNeeded(manifest)) {
    // `runnerOpsPrior === undefined`: the common case — no App was ever
    // created, none is created now, no clicks spent. `runnerOpsPrior !==
    // undefined`: an ORPHAN — a prior run created this App while the
    // manifest DID declare self-hosted, and a later edit dropped that
    // declaration. §D3 Design invariant 4 (never prune) applies to
    // identities exactly like it applies to plan items: apply never deletes
    // an App, so the orphan is left exactly as recorded — skipping
    // `writeIncrementalLock` below means the PRIOR lock entry survives this
    // run's `composeFleetLock` completely unchanged (see that function's
    // "any role NOT present in agentUpdates carries its entry here forward
    // unchanged" doc). Reporting it as `'not-needed'` with an explicit
    // orphan reason — rather than silently omitting it — is the load-bearing
    // half of #1083's "do not silently ignore it": an operator reading this
    // run's summary sees the orphan named, not a run that quietly stopped
    // mentioning an App it once created.
    runnerOpsIdentity = {
      role: RUNNER_OPS_ROLE,
      status: 'not-needed',
      reason:
        runnerOpsPrior === undefined
          ? 'routing.runner.runs_on is not "self-hosted" (routing is either undeclared or declares a ' +
            'different runner class) — this fleet needs no runner-ops App; none was created and no ' +
            'consent-gate clicks were spent on it.'
          : `runner-ops App "${deriveRunnerOpsHandle(manifest.metadata.name)}" is recorded in fleet.lock from ` +
            'a prior run, but routing.runner.runs_on is no longer "self-hosted" — it is an ORPHAN. apply never ' +
            'deletes an App (teardown is a separate, deliberate operator action); it is left exactly as recorded. ' +
            'Archive or remove it manually on GitHub if it is no longer wanted.',
    };
  } else {
    // Same §D5 pre-flight the per-agent loop already applies above — an empty
    // `transport.age_recipients` must refuse gate 1 for this identity too, not
    // just for declared agents (a role absent from `pendingCreatedUpdates`
    // never gets here on a re-run once a lock entry exists, mirroring the
    // per-agent guard).
    const runnerOpsDeps: AgentApplyDeps = {
      ...buildAgentDepsWithRecovery(recoveryRootDir, manifest.metadata.name, recipients, {
        ...deps,
        log: (line: string): void => {
          deps.log(`[runner-ops] ${line}`);
        },
      }),
      // groundnuty/macf#943 — GitHub's App-manifest flow has no field to FORCE
      // repository_selection at creation time (see `install-scope.ts`'s
      // doc); this is the verify-then-refuse enforcement point, checked
      // right after gate 2 confirms, before this identity is ever reported
      // as created/resumed. groundnuty/macf#1128 generalized the check
      // itself out of this file — every App type (agents, router, this one)
      // now builds its closure the SAME way, over its own handle.
      validateInstall: buildInstallScopeValidator(deriveRunnerOpsHandle(manifest.metadata.name)),
    };
    // Captured for the runner-provisioning block further down — see this
    // variable's declaration above `runnerOpsPrior` for why.
    runnerOpsResolveKeyPath = runnerOpsDeps.resolveKeyPath;
    runnerOpsIdentity = wouldCreateWithNoRecipient(runnerOpsPrior, recipients)
      ? noRecipientPreflightFailure(RUNNER_OPS_ROLE)
      : wouldCreateWithUnreadableVault(runnerOpsPrior, vaultAlreadyExists, deps.identityKeyPath)
        ? noVaultAccessPreflightFailure(RUNNER_OPS_ROLE, vaultOutPath)
        : await applyIdentity(
            // No home repo for this App — `controlRepo.repo` (the fleet's OWN
            // control-plane repo, already confirmed to exist by Step 0 above) is
            // the closest fleet-level homepage this tool has; a design choice,
            // not a spec requirement (flagged in the implementation report).
            runnerOpsIdentityRequest(repoHomepageUrl(controlRepo.repo)),
            manifest,
            runnerOpsPrior,
            runnerOpsDeps,
          );

    if (runnerOpsIdentity.status === 'reused' || runnerOpsIdentity.status === 'resumed-install') {
      writeIncrementalLock(RUNNER_OPS_ROLE, { appId: runnerOpsIdentity.appId, installId: runnerOpsIdentity.installId });
    } else if (runnerOpsIdentity.status === 'created') {
      const rrHandle = deriveRunnerOpsHandle(manifest.metadata.name);
      const rrSecrets: VaultRunnerOpsSecrets = {
        appHandle: rrHandle,
        appId: runnerOpsIdentity.appId,
        installId: runnerOpsIdentity.installId,
        clientId: runnerOpsIdentity.credentials.clientId,
        clientSecret: runnerOpsIdentity.credentials.clientSecret,
        webhookSecret: runnerOpsIdentity.credentials.webhookSecret,
        pem: runnerOpsIdentity.credentials.pem,
      };
      pendingRunnerOpsVaultSecrets = rrSecrets;
      pendingCreatedUpdates[RUNNER_OPS_ROLE] = {
        appId: runnerOpsIdentity.appId,
        installId: runnerOpsIdentity.installId,
        secrets: vaultRunnerOpsSecretsForFingerprint(rrSecrets),
      };
    }
    // skipped-unverified / drift / failed: no lock write this run — same
    // "unresolved this run" posture the per-agent loop already applies to its
    // own identical statuses.
  }
  deps.log(
    `Runner-ops App: ${runnerOpsIdentity.status.toUpperCase()}` +
      (runnerOpsIdentity.status === 'failed' ||
      runnerOpsIdentity.status === 'drift' ||
      runnerOpsIdentity.status === 'skipped-unverified' ||
      runnerOpsIdentity.status === 'not-needed'
        ? ` — ${runnerOpsIdentity.reason}`
        : '.'),
  );
  // `runnerOpsIdentity` is threaded straight onto `FleetApplyResult.runnerOps`
  // at the end of this function — a SEPARATE field from `agents` (see that
  // field's doc for why: `agents` is 1:1 with `manifest.agents[]` throughout
  // this module, and this App is never declared there).

  // --- groundnuty/macf#943 (DR-043 Amendment I2): call the runner-
  // provisioning contract for every confirmed repo, non-fatally. Placed
  // immediately after the runner-ops App block (not later, near the
  // register-before-route poll) because it is the FIRST point this run has
  // both `confirmedRepos` (built during the per-agent loop above) AND
  // `runnerOpsIdentity` (the credential source, just resolved) in hand — and
  // because provisioning should happen as early as possible so a freshly
  // created runner has the most time to register before the poll below runs
  // out its budget.
  //
  // Same guard `publishTrustedActorsGated`'s own call site (below) uses —
  // `routing.runner` undeclared or not "self-hosted" means NO call is
  // attempted at all, matching `routing`'s own empty-`{}`-when-not-declared
  // convention (see `FleetApplyResult.runnerProvision`'s doc).
  const runnerProvisionResults: Record<string, RunnerPlatformResult> = {};
  // A repo this run successfully told the contract to provision — excluded
  // from `justCreatedRepos`'s fast single-check path below (macf#972's own
  // doc predicted this: "at which point a fresh repo's poll becomes
  // justified again"). Without this exclusion, a brand-new fleet would POST
  // successfully, then fast-fail the register-before-route gate at t=0 —
  // ~15s before GitHub registration could possibly land — turning the
  // "new fleet for a new project" path (the actual point of this contract)
  // into a guaranteed first-run failure.
  const provisionedNowRepos = new Set<string>();
  // groundnuty/macf#1212 — hoisted OUT of the `if` below (unlike the
  // pre-#1212 shape, where this was scoped inside it) so the unconditional
  // wait immediately following this block can build the SAME advisory
  // `checkRunnerPlatformStatus` read from it, regardless of which branch
  // resolved it. Resolves to `undefined` (not-configured) when
  // `routing.runner` isn't declared self-hosted at all — the wait below is
  // then a no-op anyway (`provisionedNowRepos` stays empty), so this never
  // does unnecessary env/flag/scope/manifest resolution work for an
  // undeclared fleet.
  //
  // groundnuty/macf#1211 — resolved ONCE, here, via the full flag/env/
  // scope/manifest precedence chain (not just the original flag/env pair),
  // and reused by BOTH consumers below: the provisioning POST loop inside
  // the `if` immediately following, AND #1212's unconditional wait further
  // down (`runnerPlatformStatusCheck`). Resolving (and logging) it a SECOND
  // time inside the `if` would have let the two consumers silently observe
  // different values if `deps.observedRunnerPlatformEndpointScope` or
  // `process.env` changed mid-run — sharing one resolution makes that
  // structurally impossible. `observedRunnerPlatformEndpointScope` is the
  // RAW scope-variable value `commands/bootstrap-apply.ts` already threaded
  // in from its own plan-time `githubRegistryObserver` call (see that
  // field's doc); `manifest.transport.runner_platform_endpoint` is read
  // directly since `applyFleet` already has the parsed manifest.
  const runnerPlatformEndpointResolution =
    manifest.routing?.runner !== undefined && manifest.routing.runner.runs_on === 'self-hosted'
      ? resolveRunnerPlatformEndpointWithProvenance({
          explicit: deps.runnerPlatformEndpoint,
          manifestValue: manifest.transport.runner_platform_endpoint,
          scopeValue: deps.observedRunnerPlatformEndpointScope,
        })
      : undefined;
  if (runnerPlatformEndpointResolution !== undefined) {
    deps.log(`Runner platform endpoint: ${describeRunnerPlatformEndpointResolution(runnerPlatformEndpointResolution)}.`);
  }
  const runnerPlatformEndpointForWait = runnerPlatformEndpointResolution?.value;
  if (manifest.routing?.runner !== undefined && manifest.routing.runner.runs_on === 'self-hosted') {
    const runnerPlatformDeps = {
      endpoint: runnerPlatformEndpointForWait,
      fetchImpl: deps.runnerPlatformFetch,
    };
    // Freshly minted THIS run (`status === 'created'`) supplies the PEM
    // in-memory, no I/O needed. A `'reused'`/`'resumed-install'` outcome
    // falls back to `resolveRunnerOpsVaultPem` — the run-2 fix (groundnuty/
    // macf#943 follow-up): the SAME vault-backed `resolveKeyPath` closure
    // that already confirmed this reuse is real, re-consulted for the PEM
    // itself. See both functions' docs for the full "why."
    const runnerOpsCredentials = runnerPlatformCredentialsFromOutcome(runnerOpsIdentity, resolveRunnerOpsVaultPem(runnerOpsIdentity, runnerOpsResolveKeyPath, deps.log));
    if (runnerOpsCredentials === undefined) {
      deps.log(
        `Runner platform: no runner-ops credential available this run (${runnerOpsIdentity.status}) — provisioning ` +
          "call(s) below omit `credentials`, so the contract falls back to its OWN App, which only works for the " +
          'owner it happens to be installed on. This means either no --vault/--identity-key were supplied this ' +
          'run, or the vault does not (yet) hold this role\'s key — see the log lines above for which.',
      );
    }
    const declaredLabels = manifest.routing.runner.labels;
    const warm = manifest.routing.runner.warm;
    for (const repo of confirmedRepos) {
      const result = await provisionRunner(runnerPlatformDeps, {
        repo,
        ...(declaredLabels !== undefined ? { labels: declaredLabels } : {}),
        warm,
        fleet: manifest.metadata.name,
        ...(runnerOpsCredentials !== undefined ? { credentials: runnerOpsCredentials } : {}),
      });
      runnerProvisionResults[repo] = result;
      deps.log(
        `Runner platform (${repo}): ${result.status}` + (result.status === 'ok' ? '.' : ` — ${result.reason}`),
      );
      if (result.status === 'ok') provisionedNowRepos.add(repo);
    }
  }

  // groundnuty/macf#1212 — operator ruling: "apply requested the runner...
  // whether a --runner-token was supplied is irrelevant to whether the tool
  // should wait for something it itself asked for." Every repo THIS run
  // successfully told the contract to provision (`provisionedNowRepos`,
  // above) gets an UNCONDITIONAL bounded wait for GitHub to confirm it
  // usable — see `apply-routing.ts::publishTrustedActorsForProvisioned`'s
  // doc for the full "why here, why unconditional, why pending-not-failed"
  // narrative. Placed immediately after the POST loop (not at the later
  // register-before-route call site) for the SAME "as early as possible"
  // reason that block's own doc already gives the provisioning call itself
  // — maximizing the window before this run ends.
  //
  // `runnerPlatformStatusCheck` is OPTIONAL and advisory-only (see that
  // function's doc) — `undefined` when the endpoint was never configured,
  // so a fleet with no runner-platform reachable still gets the correct
  // GitHub-side wait, just without the platform's own progress content.
  const runnerPlatformStatusCheck =
    runnerPlatformEndpointForWait !== undefined ? (repo: string): Promise<RunnerPlatformStatusResult> => checkRunnerPlatformStatus({ endpoint: runnerPlatformEndpointForWait, fetchImpl: deps.runnerPlatformFetch }, repo) : undefined;
  const provisionedWaitPollOptions: RunnerTokenPollOptions = {
    ...deps.runnerTokenPollOptions,
    onProgress:
      deps.runnerTokenPollOptions?.onProgress ??
      ((repo: string, elapsedMs: number, totalMs: number, platformStatus?: RunnerPlatformStatusResult): void => {
        deps.log(formatProvisionedRunnerWaitProgress(repo, elapsedMs, totalMs, platformStatus));
      }),
  };
  // groundnuty/macf#1212 (coordinator UX addendum) — "so each time I can
  // see how much time it took." A per-repo tick already narrates via
  // `provisionedWaitPollOptions.onProgress` above; this ONE line closes the
  // loop with the number that matters most once the wait is over — the
  // real, measured total, not the budget.
  const provisionedWaitStartedAt = (provisionedWaitPollOptions.now ?? Date.now)();
  const routingProvisioned: Readonly<Record<string, EnsureVariableOutcome>> =
    provisionedNowRepos.size > 0
      ? await publishTrustedActorsForProvisioned(
          buildTrustedActorsValue(manifest.metadata.name, manifest.agents),
          [...provisionedNowRepos],
          {
            ...deps.trustDeps,
            ...(runnerPlatformStatusCheck !== undefined ? { checkRunnerPlatformStatus: runnerPlatformStatusCheck } : {}),
          },
          provisionedWaitPollOptions,
        )
      : {};
  if (provisionedNowRepos.size > 0) {
    const elapsedTotalS = Math.round(((provisionedWaitPollOptions.now ?? Date.now)() - provisionedWaitStartedAt) / 1000);
    const ready = Object.values(routingProvisioned).filter((leg) => leg.status === 'created' || leg.status === 'already-present').length;
    const pending = Object.values(routingProvisioned).filter((leg) => leg.status === 'pending').length;
    const failed = Object.values(routingProvisioned).filter((leg) => leg.status === 'failed').length;
    deps.log(
      `Runner wait: ${String(provisionedNowRepos.size)} repo(s) resolved in ${String(elapsedTotalS)}s — ` +
        `${String(ready)} ready, ${String(pending)} still pending, ${String(failed)} failed.`,
    );
  }
  for (const [repo, leg] of Object.entries(routingProvisioned)) {
    deps.log(
      `Routing var (${repo}): ${leg.status}` +
        (leg.status === 'failed' || leg.status === 'skipped' || leg.status === 'pending' ? ` — ${leg.reason}` : '.'),
    );
  }

  // --- groundnuty/macf#1074 + groundnuty/macf#1082: the routing App —
  // a fleet-level identity (alongside the per-agent Apps and runner-ops),
  // same "runs after the per-agent loop, before settleVault" ordering as
  // runner-ops immediately above. See `apply-router-app.ts`'s module doc for
  // the full scope-reversal narrative (why SHARED is now the default).
  //
  // `installRepos`: THIS App's correct install target is the fleet's
  // REGISTRY, never an agent's repo (`routerAppInstallRepos`'s doc) — an
  // empty result (org/local registry) is passed through unchanged rather
  // than guessed at; `applyIdentity`'s gate-2 interstitial simply lists zero
  // repos in that case (registry.type === 'org' is unreachable in practice —
  // `registry-scope-preflight.ts` already refuses it before ANY consent gate
  // opens).
  //
  // Mode is INPUT-implied (`resolveSharedRouterAppReuse`'s vault check),
  // never flag-selected — `manifest.transport.router_app_scope` is the ONE
  // exception (an operator's standing per-fleet-isolation preference, not a
  // per-run fact the vault's contents can express). `!== 'per-fleet'`
  // (rather than `=== 'shared'`) so a hand-built manifest that predates this
  // field (undefined, never parsed through the zod default) still gets the
  // new default, matching `tailscale_oauth_required`'s own
  // treat-falsy-as-undeclared precedent immediately below.
  const routerAppScope = manifest.transport.router_app_scope === 'per-fleet' ? 'per-fleet' : 'shared';
  // groundnuty/macf#1088 — `manifest.owner.account` (this FLEET's owner —
  // an org or user account), never the operator's own account, is what the
  // 'shared' branch keys on. See `deriveRouterAppHandle`'s doc for why.
  const routerAppHandle = deriveRouterAppHandle(manifest.metadata.name, manifest.owner.account, routerAppScope);
  const routerAppPrior = currentLock?.agents.find((a) => a.role === ROUTER_APP_ROLE);
  const routerAppDeps: AgentApplyDeps = {
    ...buildAgentDepsWithRecovery(recoveryRootDir, manifest.metadata.name, recipients, {
      ...deps,
      log: (line: string): void => {
        deps.log(`[router] ${line}`);
      },
    }),
    // groundnuty/macf#1128 — same shared repository_selection guard every
    // App type uses now (`install-scope.ts`), over THIS App's own handle.
    validateInstall: buildInstallScopeValidator(routerAppHandle),
  };

  // groundnuty/macf#1082 — SHARED scope only: resolve reuse-vs-instruct-vs-
  // create from the vault + a live name-presence check BEFORE the identity
  // ceremony is ever reached. A `'reuse'` decision means `applyIdentity` —
  // and therefore the mint/manifest-flow seam — is invoked ZERO times this
  // run. PER-FLEET scope skips this decision entirely and keeps #1074's
  // original ceremony, byte-identical.
  const sharedReuseDeps: SharedRouterAppReuseDeps = {
    ...(deps.routerAppVaultDeps.readVaultRouterApp !== undefined ? { readVaultRouterApp: deps.routerAppVaultDeps.readVaultRouterApp } : {}),
    ...(routerAppDeps.checkAppNameCollision !== undefined ? { checkAppNameCollision: routerAppDeps.checkAppNameCollision } : {}),
  };
  const sharedReuseDecision =
    routerAppScope === 'shared' ? await resolveSharedRouterAppReuse(manifest.owner, routerAppHandle, sharedReuseDeps) : undefined;

  let routerAppIdentity: RouterAppApplyOutcome;
  if (sharedReuseDecision?.kind === 'reuse') {
    // groundnuty/macf#1082 — the vault already carries this App's id/key
    // (an EXISTING App the operator supplied, possibly minted by a
    // different fleet entirely). Publish those values, mint NOTHING — NO
    // `agents[]` fleet.lock entry (this fleet resolved no NEW install this
    // run, and `install_id` is required there — see
    // `fleet-lock.ts::ScopeCredentialUpdate`'s doc) and no
    // `pendingRoutingAppVaultSecrets` (re-writing what was just read back
    // would be pointless at best and, since the value is unchanged,
    // harmless — but the "never overwrite" discipline is simplest to keep
    // exactly by never touching the vault payload on this path at all).
    // groundnuty/macf#1162 — corrected: this run DOES still write to
    // fleet.lock below (a `scope_credentials` provenance marker, never an
    // `agents[]` entry) — "the vault, not the lock, is this scope's source
    // of truth for reuse" is still true for WHERE the credential VALUE
    // lives, but no longer true for "nothing is written to the lock."
    routerAppIdentity = { role: ROUTER_APP_ROLE, status: 'vault-reused', appId: sharedReuseDecision.appId };
  } else if (sharedReuseDecision?.kind === 'name-taken') {
    // groundnuty/macf#1082 — no vault credentials, but the shared name is
    // confirmably taken on GitHub. Refuse with the two-next-steps
    // instruction (`routerAppNameCollisionMessage`) — never mint a
    // per-fleet fallback the operator did not explicitly ask for.
    routerAppIdentity = { role: ROUTER_APP_ROLE, status: 'failed', reason: sharedReuseDecision.reason };
  } else {
    // `sharedReuseDecision === undefined` (per-fleet scope) OR
    // `.kind === 'create'` (shared scope, name confirmed free/unconfirmable)
    // — #1074's original ceremony, unchanged. `handleOverride` carries the
    // SHARED fixed name through when applicable; `undefined` for per-fleet
    // scope keeps `applyIdentity`'s own fleet-derived handle.
    routerAppIdentity = wouldCreateWithNoRecipient(routerAppPrior, recipients)
      ? noRecipientPreflightFailure(ROUTER_APP_ROLE)
      : wouldCreateWithUnreadableVault(routerAppPrior, vaultAlreadyExists, deps.identityKeyPath)
        ? noVaultAccessPreflightFailure(ROUTER_APP_ROLE, vaultOutPath)
        : await applyIdentity(
            routerAppIdentityRequest(
              routerAppInstallRepos(manifest),
              repoHomepageUrl(controlRepo.repo),
              routerAppScope === 'shared' ? routerAppHandle : undefined,
            ),
            manifest,
            routerAppPrior,
            routerAppDeps,
          );
  }

  let pendingRoutingAppVaultSecrets: VaultRoutingAppSecrets | undefined;
  if (routerAppIdentity.status === 'reused' || routerAppIdentity.status === 'resumed-install') {
    writeIncrementalLock(ROUTER_APP_ROLE, { appId: routerAppIdentity.appId, installId: routerAppIdentity.installId });
  } else if (routerAppIdentity.status === 'created') {
    pendingRoutingAppVaultSecrets = { appId: routerAppIdentity.appId, appKeyPem: routerAppIdentity.credentials.pem };
    pendingCreatedUpdates[ROUTER_APP_ROLE] = {
      appId: routerAppIdentity.appId,
      installId: routerAppIdentity.installId,
      secrets: { app_private_key: routerAppIdentity.credentials.pem },
    };
  } else if (routerAppIdentity.status === 'vault-reused') {
    // groundnuty/macf#1162 — record the interim as an interim, not
    // silently indistinguishable from genuine ownership (see
    // `fleet-manifest.ts::ScopeCredentialMarkerSchema`'s doc). Written
    // UNCONDITIONALLY on this outcome, whether or not
    // `transport.router_app_origin_fleet` is declared — an undeclared
    // origin still gets a marker (just one honestly omitting a source it
    // was never told), because the alternative (no marker at all) is
    // exactly the silent-workaround-looks-like-ownership shape this issue
    // exists to close.
    writeScopeCredentialMarker(ROUTER_APP_ROLE, manifest.transport.router_app_origin_fleet);
  }
  // vault-reused: writes the scope_credentials marker above, never an
  // agents[] entry (see that branch's comment). skipped-unverified /
  // drift / failed: no lock write this run either — same "unresolved this
  // run" posture the runner-ops block above applies to its own identical
  // statuses.
  deps.log(
    `Router App: ${routerAppIdentity.status.toUpperCase()}` +
      (routerAppIdentity.status === 'failed' ||
      routerAppIdentity.status === 'drift' ||
      routerAppIdentity.status === 'skipped-unverified'
        ? ` — ${routerAppIdentity.reason}`
        : routerAppIdentity.status === 'vault-reused'
          ? ` (app_id ${routerAppIdentity.appId}) — publishing existing credentials, minting nothing.`
          : '.'),
  );
  // `routerAppIdentity` is threaded straight onto `FleetApplyResult.routerApp`
  // at the end of this function — a SEPARATE field from `agents`/`runnerOps`,
  // same reasoning as `runnerOpsIdentity` above.

  // --- DR-043 Amendment D phase 2 (macf#838, macf#854's CA/routing gap) ---
  //
  // Mint-or-reuse decision FIRST (fleet-level, independent of any one
  // agent's outcome) — `lockHasCaKey` reflects a PRIOR run's success only
  // (see `apply-ca.ts::resolveCaCert`'s doc); nothing written earlier in
  // THIS run's loop can set it.
  const lockHasCaKey = currentLock?.fingerprints?.['ca_key'] !== undefined;
  const caResolve: CaResolveOutcome = await resolveCaCert(
    manifest.metadata.name,
    manifest.owner.registry,
    lockHasCaKey,
    recipients,
    deps.trustDeps,
  );
  deps.log(
    caResolve.status === 'failed'
      ? `CA: FAILED to resolve — ${caResolve.reason}`
      : `CA: ${caResolve.status.toUpperCase()} (fingerprint ${caCertFingerprint(caResolve.certPem)}).`,
  );
  // A FRESH key needs a durable home before its PUBLIC cert is ever
  // published (see this module's + `apply-ca.ts`'s doc: publishing first
  // and losing the vault write would recreate the #799 orphan-cert class).
  // A REUSED cert has no fresh key this run — nothing to stage.
  const caSecretsForVault: VaultCaSecrets | undefined =
    caResolve.status === 'minted' ? { project: manifest.metadata.name, caKeyPem: caResolve.keyPem, caCertPem: caResolve.certPem } : undefined;

  // DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920 gap 2) —
  // MINT happens here, right after the CA resolve, because it's the only
  // point where a freshly-minted CA's private key is (possibly) in process
  // memory to sign the client cert with (`apply-routing-client.ts`'s "mint
  // gating" doc). Folds into the SAME `settleVault` call as agents + CA
  // below — never a second vault write (Amendment D).
  const lockHasRoutingClientKey = currentLock?.fingerprints?.['routing_client_key'] !== undefined;
  const routingClientMint: RoutingClientMintOutcome = await mintRoutingClient(
    caResolve.status === 'minted' ? caResolve.certPem : undefined,
    caResolve.status === 'minted' ? caResolve.keyPem : undefined,
    lockHasRoutingClientKey,
    caResolve.status === 'minted',
    deps.routingClientDeps,
  );
  // groundnuty/macf#954 — 'failed' (a genuine mint exception) is logged
  // distinctly from a benign 'skipped' — see `RoutingClientMintOutcome`'s doc.
  deps.log(
    routingClientMint.status === 'minted'
      ? 'Routing-client cert: MINTED (CN=routing-action).'
      : routingClientMint.status === 'failed'
        ? `Routing-client cert: FAILED to mint — ${routingClientMint.reason}`
        : `Routing-client cert: SKIPPED — ${routingClientMint.reason}`,
  );
  const routingClientSecretsForVault: VaultRoutingClientSecrets | undefined =
    routingClientMint.status === 'minted' ? { clientCertPem: routingClientMint.certPem, clientKeyPem: routingClientMint.keyPem } : undefined;

  const vault = await settleVault(
    manifest,
    vaultOutPath,
    pendingVaultAgents,
    caSecretsForVault,
    routingClientSecretsForVault,
    pendingRunnerOpsVaultSecrets,
    pendingRoutingAppVaultSecrets,
    deps,
  );
  if (
    vault.status === 'written' &&
    (Object.keys(pendingCreatedUpdates).length > 0 ||
      caSecretsForVault !== undefined ||
      routingClientSecretsForVault !== undefined ||
      pendingRoutingAppVaultSecrets !== undefined)
  ) {
    // Batched, not per-role: `writeVault` just persisted EVERY `created`
    // agent's secret (+ the CA key, when freshly minted, + the routing-client
    // key, when freshly minted, + the router App's key, when freshly created
    // — groundnuty/macf#1074) in ONE `age` invocation, so their lock entries
    // become durable together too — see the module doc's ordering rationale.
    // `fleetSecrets` is the CA-key / routing-client / router-App-key
    // fingerprints ONLY — this is the SOLE place `fingerprints.ca_key`/
    // `fingerprints.routing_client_key`/`fingerprints.routing_app_key` are
    // ever written (never an incremental per-agent write), matching
    // `pendingCreatedUpdates`'s existing batched-only discipline.
    const fleetSecrets =
      caSecretsForVault !== undefined || routingClientSecretsForVault !== undefined || pendingRoutingAppVaultSecrets !== undefined
        ? vaultFleetSecretsForFingerprint({
            agents: [],
            ...(caSecretsForVault !== undefined ? { ca: caSecretsForVault } : {}),
            ...(routingClientSecretsForVault !== undefined ? { routingClient: routingClientSecretsForVault } : {}),
            ...(pendingRoutingAppVaultSecrets !== undefined ? { routingApp: pendingRoutingAppVaultSecrets } : {}),
          })
        : undefined;
    const composed = composeFleetLock({
      fleet: manifest.metadata.name,
      previous: currentLock,
      agentUpdates: pendingCreatedUpdates,
      ...(fleetSecrets !== undefined ? { fleetSecrets } : {}),
    });
    writeFleetLock(lockPath, composed.lock);
    currentLock = composed.lock;
    identityChanges.push(...composed.identityChanges);
    // macf#992 — recovery-artifact DELETION does NOT happen here anymore.
    // `vault.status === 'written'` only proves the LOCAL encrypt succeeded
    // into this run's per-process `mkdtemp` control-repo checkout
    // (`controlDir`) — that checkout is NOT durable; it dies with the
    // process. The credential is genuinely durable outside this checkout
    // only once `syncControlRepo` (below) has PUSHED it to `<fleet>-control`.
    // Deleting the write-only insurance copy here — before that push is even
    // attempted — is the exact bug this issue closes: a crash or a rejected
    // push between this line and the push leaves NEITHER a durable vault NOR
    // a recovery artifact. See the deletion site after `syncControlRepo`,
    // and the module doc's "Recovery-artifact lifecycle" section.
  }

  // Two-place PUBLIC-cert publish (macf#806) — gated on the ordering rule
  // above: a MINTED cert publishes only once its key is confirmed durable
  // (`vault.status === 'written'`); a REUSED or RESTORED cert (groundnuty/
  // macf#978 — vault-recovered after `deactivate` dropped the registry leg)
  // had no fresh key this run, so both publish unconditionally (backfills
  // any repo leg the #806 drift class — or the #978 deactivate/apply
  // revive gap — left missing); a FAILED resolve or a minted-but-unwritten
  // vault publishes NOTHING — every leg reads `'skipped'` with the reason,
  // never silent (mirrors `plan.ts`'s `unimplementedByApply` discipline).
  let certToPublish: string | undefined;
  let caSkipReason: string | undefined;
  if (caResolve.status === 'reused' || caResolve.status === 'restored') {
    certToPublish = caResolve.certPem;
  } else if (caResolve.status === 'minted') {
    if (vault.status === 'written') {
      certToPublish = caResolve.certPem;
    } else {
      caSkipReason =
        'CA was freshly minted this run but the batched vault write did not succeed — refusing to publish the ' +
        'cert until its key is durable. Re-run apply once the vault issue is fixed. The retry ' +
        're-mints (the registry cert was never published, so resolveCaCert takes the mint path again), which is ' +
        'harmless: this run\'s key was never made durable and has signed nothing, so nothing is orphaned.';
    }
  } else {
    caSkipReason = `CA could not be resolved this run: ${caResolve.reason}`;
  }
  const caPublish: CaPublishResult =
    certToPublish !== undefined
      ? await publishCaCertLegs(certToPublish, manifest.metadata.name, manifest.owner.registry, confirmedRepos, deps.trustDeps)
      : skippedCaPublish(confirmedRepos, caSkipReason ?? 'CA cert unresolved');
  deps.log(
    `CA registry leg: ${caPublish.registryLeg.status}` +
      (caPublish.registryLeg.status === 'failed' || caPublish.registryLeg.status === 'skipped' ? ` — ${caPublish.registryLeg.reason}` : '.'),
  );
  for (const [repo, leg] of Object.entries(caPublish.repoLegs)) {
    deps.log(`CA repo leg (${repo}): ${leg.status}` + (leg.status === 'failed' || leg.status === 'skipped' ? ` — ${leg.reason}` : '.'));
  }

  // --- groundnuty/macf#1074: the unified six-secret routing publish ---
  //
  // Resolve all six `RoutingSecretResolution`s, THEN call
  // `apply-routing-secrets.ts::publishRoutingSecrets` exactly ONCE — the
  // task's explicit "not a second publisher" constraint, and the shape that
  // makes the decisive test possible (assert the exact 6-name set landed,
  // never an aggregation of two separate publish calls).

  // ROUTING_CLIENT_CERT / ROUTING_CLIENT_KEY — SAME 3-case resolution
  // `apply-routing-client.ts` has carried since #920/#986 (mint gating +
  // vault-restore), now producing `RoutingSecretResolution`s instead of
  // calling a routing-client-specific publisher. Base64-encoded HERE
  // (`toBase64ForSecret`) — the fix for the live encoding bug this issue's
  // implementation found: `agent-router.yml`'s router job base64-DECODES
  // these two secrets by hand (`echo "$X" | base64 -d`), but the retired
  // `publishRoutingClientSecrets` passed raw PEM text unencoded (see
  // `apply-routing-secrets.ts`'s module doc for the full incident) — every
  // repo #1073 published to got a value the router job's own
  // `set -euo pipefail` would choke on.
  let routingClientCert: RoutingSecretResolution;
  let routingClientKey: RoutingSecretResolution;
  if (routingClientMint.status === 'minted' && vault.status !== 'written') {
    const reason =
      'routing-client cert was freshly minted this run but the batched vault write did not succeed — refusing to ' +
      'deploy the private key to any repo until it is durable. Re-run apply once the vault issue is ' +
      "fixed. The retry re-mints (fleet.lock never recorded a routing_client_key fingerprint), which is harmless: " +
      "this run's key was never made durable and was never deployed, so nothing is orphaned.";
    routingClientCert = { status: 'unavailable', reason };
    routingClientKey = { status: 'unavailable', reason };
  } else {
    const secretsForPublish: RoutingClientSecretsForPublish =
      routingClientMint.status === 'minted'
        ? { status: 'available', certPem: routingClientMint.certPem, keyPem: routingClientMint.keyPem }
        : await resolveRoutingClientSecretsForPublish(routingClientMint, lockHasRoutingClientKey, deps.routingClientDeps);
    routingClientCert =
      secretsForPublish.status === 'available'
        ? { status: 'available', value: toBase64ForSecret(secretsForPublish.certPem) }
        : { status: 'unavailable', reason: secretsForPublish.reason };
    routingClientKey =
      secretsForPublish.status === 'available'
        ? { status: 'available', value: toBase64ForSecret(secretsForPublish.keyPem) }
        : { status: 'unavailable', reason: secretsForPublish.reason };
  }

  // MACF_ROUTING_APP_ID / MACF_ROUTING_APP_KEY — the dedicated router App's
  // own credentials, resolved from THIS run's identity outcome (created) or
  // vault-restored (reused/resumed-install) — see
  // `apply-router-app.ts::resolveRouterAppSecretsForPublish`'s doc for the
  // full case table (mirrors the routing-client resolution's shape).
  // `MACF_ROUTING_APP_KEY` is RAW PEM (NOT base64) per `SKILL.md`'s
  // documented asymmetry + `actions/create-github-app-token`'s own
  // consumption — never passed through `toBase64ForSecret`.
  const routerAppSecrets: RouterAppSecretsForPublish = await resolveRouterAppSecretsForPublish(
    routerAppIdentity,
    vault.status === 'written',
    deps.routerAppVaultDeps,
  );
  const routingAppId: RoutingSecretResolution =
    routerAppSecrets.status === 'available' ? { status: 'available', value: routerAppSecrets.appId } : { status: 'unavailable', reason: routerAppSecrets.reason };
  const routingAppKey: RoutingSecretResolution =
    routerAppSecrets.status === 'available'
      ? { status: 'available', value: routerAppSecrets.appKeyPem }
      : { status: 'unavailable', reason: routerAppSecrets.reason };

  // TS_OAUTH_CLIENT_ID / TS_OAUTH_SECRET — ALWAYS operator-supplied, NEVER
  // minted by `apply` — read-only, independent of `vault.status` (this run
  // never WRITES these, so their durability never depends on THIS run's
  // write succeeding).
  //
  // groundnuty/macf#1109 — the vault read is now UNCONDITIONAL, never gated
  // on `transport.tailscale_oauth_required`. The PRIOR shape gated the read
  // itself on the manifest flag: an undeclared fleet never even called
  // `readVaultTsOauth`, so a vault that DID carry the pair (the operator
  // supplied `--vault`/`--identity-key` with real values) was silently
  // ignored, and `apply` fell through to the "next steps: set these by
  // hand" instruction for a value it had just read off disk — the live
  // defect this issue reports (`agent-router.yml` requires both secrets
  // UNCONDITIONALLY, regardless of what this fleet's manifest declares
  // about them). The manifest flag now governs ONLY how the ABSENT case is
  // scored (refusal-worthy `'unavailable'` vs. an honest not-ready-yet
  // `'not-required'` skip) — it never gates whether a PRESENT value gets
  // used. `checkTailscaleOauthPreflight` in `commands/bootstrap-apply.ts`
  // still refuses BEFORE gate 1 whenever the flag IS declared and NEITHER
  // source (flag/env or vault) yields it, so a `tailscale_oauth_required:
  // true` fleet reaching this line always has ONE of the two sources
  // already confirmed once — this is a second, independent read/check
  // (the "each concern gets its own decrypt" convention this codebase
  // already follows for CA/routing-client restores), not a second source
  // of truth.
  //
  // groundnuty/macf#1186 — `deps.resolvedTsOauth` (the `--ts-oauth-client-id`/
  // `--ts-oauth-secret` flag/env pair) is a SECOND operator-supplied source,
  // checked FIRST: the vault path requires a PRE-EXISTING vault.age to read
  // from, which a freshly-provisioned org has none of. Wins over a
  // vault-restored value when both resolve (see `FleetApplyDeps.resolvedTsOauth`'s
  // doc for why THIS run's explicit flag/env input outranks a prior run's
  // stored vault value) — the vault read below still runs unconditionally
  // (cheap, and a test/caller may supply `readVaultTsOauth` without
  // `resolvedTsOauth`), its result just loses the OR-fallthrough race when
  // `deps.resolvedTsOauth` is already present.
  let tsOauthClientId: RoutingSecretResolution;
  let tsOauthSecret: RoutingSecretResolution;
  const restoredTsOauth = deps.routingSecretsDeps.readVaultTsOauth !== undefined ? await deps.routingSecretsDeps.readVaultTsOauth() : undefined;
  const suppliedTsOauth: ResolvedTsOauth | undefined = deps.resolvedTsOauth ?? restoredTsOauth;
  if (suppliedTsOauth !== undefined) {
    tsOauthClientId = { status: 'available', value: suppliedTsOauth.clientId };
    tsOauthSecret = { status: 'available', value: suppliedTsOauth.secret };
  } else if (manifest.transport.tailscale_oauth_required) {
    // Declared but the vault didn't yield it THIS run — a genuine gap:
    // LOUD `'unavailable'` (never a silent `'skipped'`), same "declared
    // requirement, missing value" bar every other 6-secret leg uses.
    const reason =
      'transport.tailscale_oauth_required is declared but neither --ts-oauth-client-id/--ts-oauth-secret (or their ' +
      'env fallbacks) nor the vault yielded TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET this run — supply the pair directly ' +
      'via those flags, or supply both --vault and --identity-key so an already-vaulted value can be read back and ' +
      'published. Routing will NOT function on this fleet until both secrets are set: agent-router.yml requires ' +
      'them unconditionally, and the GitHub-hosted runner cannot reach agent VMs without joining the tailnet ' +
      'through them.';
    tsOauthClientId = { status: 'unavailable', reason };
    tsOauthSecret = { status: 'unavailable', reason };
  } else {
    // Not declared AND no vault value found (or no vault supplied at all)
    // — 'not-required', NOT 'unavailable': an undeclared fleet with nothing
    // in the vault is an honest "not ready yet," and must never fail the
    // run the way a genuinely missing DECLARED secret does (see
    // `RoutingSecretResolution`'s doc for why the two are distinct states).
    // Still names the real consequence (groundnuty/macf#1109) rather than
    // reading as a harmless, optional tidy-up item: agent-router.yml
    // requires this pair UNCONDITIONALLY, so this fleet's routing plane
    // will not function until it is supplied, declared or not.
    const reason =
      'transport.tailscale_oauth_required is not declared in fleet.yaml, and no TS_OAUTH_CLIENT_ID/TS_OAUTH_SECRET ' +
      'values were resolved from --ts-oauth-client-id/--ts-oauth-secret (or their env fallbacks) or the supplied ' +
      'vault (or no vault was supplied) — this run will not publish these secrets. Routing will NOT function on ' +
      'this fleet until they are supplied: agent-router.yml requires this pair unconditionally regardless of the ' +
      'manifest declaration.';
    tsOauthClientId = { status: 'not-required', reason };
    tsOauthSecret = { status: 'not-required', reason };
  }

  const routingSecretsForPublish: RoutingSecretsForPublish = {
    [ROUTING_APP_ID_SECRET_NAME]: routingAppId,
    [ROUTING_APP_KEY_SECRET_NAME]: routingAppKey,
    [ROUTING_CLIENT_CERT_SECRET_NAME]: routingClientCert,
    [ROUTING_CLIENT_KEY_SECRET_NAME]: routingClientKey,
    [TS_OAUTH_CLIENT_ID_SECRET_NAME]: tsOauthClientId,
    [TS_OAUTH_SECRET_SECRET_NAME]: tsOauthSecret,
  };
  const routingSecretsPublish: RoutingSecretsPublishResult = await publishRoutingSecrets(routingSecretsForPublish, routerCarryingRepos, deps.routingSecretsDeps);

  // groundnuty/macf#1162 — the FLEET-LEVEL fact the per-repo/per-secret
  // rows below jointly determine but never state on their own (the exact
  // gap #1132 also found in `routing doctor`'s per-repo-consistency
  // report). Rendered BEFORE the per-secret detail so the operator reads
  // the headline first; the per-secret rows are UNCHANGED below — this is
  // additive, never a replacement for the diagnostic detail.
  const routingFact = determineFleetRoutingFact(routingSecretsPublish, routerCarryingRepos);
  if (routingFact.kind === 'all-failed') {
    deps.log(
      `Fleet-level: this fleet CANNOT route — every router-carrying repo (${String(routerCarryingRepos.length)}) ` +
        `failed at least one routing secret (${routingFact.reason}).`,
    );
  } else if (routingFact.kind === 'unknown') {
    deps.log('Fleet-level: routing status could not be determined this run — no router-carrying repos were observed.');
  }
  // 'no-claim' (some repos failed, others didn't, or none did): deliberately
  // SILENT here — no fleet-wide statement is honest for a partial result;
  // the per-repo rows below are where that detail lives.

  for (const name of Object.keys(routingSecretsForPublish) as (keyof RoutingSecretsForPublish)[]) {
    const legs = routingSecretsPublish[name];
    const created = Object.values(legs).filter((l) => l.status === 'created').length;
    const alreadyPresent = Object.values(legs).filter((l) => l.status === 'already-present').length;
    deps.log(`Routing secret "${name}" legs: ${String(created)} created, ${String(alreadyPresent)} already-present of ${String(routerCarryingRepos.length)} confirmed repo(s).`);
    for (const [repo, leg] of Object.entries(legs)) {
      if (leg.status === 'failed' || leg.status === 'skipped') {
        deps.log(`Routing secret "${name}" leg (${repo}): ${leg.status} — ${leg.reason}`);
      }
    }
  }

  // groundnuty/macf#1112 — the single bundled routing secret, published
  // ALONGSIDE (never instead of) the six above, from the SAME resolved
  // `routingSecretsForPublish` bag (never a second resolution pass — see
  // `apply-routing-secrets.ts::publishRoutingBundle`'s doc for why this
  // must compose from every-six-available or refuse).
  const routingBundlePublish = await publishRoutingBundle(routingSecretsForPublish, routerCarryingRepos, deps.routingSecretsDeps);
  {
    const created = Object.values(routingBundlePublish).filter((l) => l.status === 'created').length;
    const alreadyPresent = Object.values(routingBundlePublish).filter((l) => l.status === 'already-present').length;
    deps.log(`Routing secret "MACF_ROUTING_BUNDLE" legs: ${String(created)} created, ${String(alreadyPresent)} already-present of ${String(routerCarryingRepos.length)} confirmed repo(s).`);
    for (const [repo, leg] of Object.entries(routingBundlePublish)) {
      if (leg.status === 'failed' || leg.status === 'skipped') {
        deps.log(`Routing secret "MACF_ROUTING_BUNDLE" leg (${repo}): ${leg.status} — ${leg.reason}`);
      }
    }
  }

  // `MACF_TRUSTED_ACTORS` (§D1, macf#922) — independent of the CA outcome;
  // every caller repo is a confirmed agent repo, never the control repo (see
  // `apply-routing.ts`'s doc). `v0` supports exactly one opt-in `runs_on`
  // value — any other declared value (including a future non-"self-hosted"
  // string) needs no write at all, matching `plan.ts::routingItem`'s own
  // noop-for-non-self-hosted branch (mustn't drift from what `plan` told the
  // operator would happen).
  //
  // macf#972 — `onProgress` is wired to `deps.log` by default (same stream
  // every other progress line in this function already uses — see
  // `commands/bootstrap-apply.ts`'s `log` binding to `process.stderr`, never
  // stdout, so a `--json` render stays clean). A test-supplied
  // `deps.runnerTokenPollOptions.onProgress` (or `now`/`sleepFn`) wins over
  // this default via the spread order below.
  const routingPollOptions: RunnerTokenPollOptions = {
    ...deps.runnerTokenPollOptions,
    onProgress:
      deps.runnerTokenPollOptions?.onProgress ??
      ((repo: string, elapsedMs: number, totalMs: number): void => {
        deps.log(formatRunnerPollProgress(repo, elapsedMs, totalMs));
      }),
  };
  // groundnuty/macf#943 — a repo created THIS run but ALSO successfully
  // provisioned THIS run (`provisionedNowRepos`, above) is no longer routed
  // through the fast-path/poll dispatch below AT ALL as of groundnuty/
  // macf#1212 (see the very next comment) — this set-difference now exists
  // ONLY to keep a repo created-but-never-provisioned on its pre-#1212 fast
  // single-check path, unchanged.
  const justCreatedReposStillFast = new Set([...justCreatedRepos].filter((repo) => !provisionedNowRepos.has(repo)));
  // groundnuty/macf#1212 — every repo THIS run successfully told the
  // platform to provision already went through its OWN unconditional wait
  // immediately after the POST loop above (`routingProvisioned`) — polling
  // it a SECOND time here (this call's own token-gated poll, on a SEPARATE
  // deadline) would double an already-bounded wait for no reason, so those
  // repos are excluded from `repos` entirely. `publishTrustedActorsGated`'s
  // dispatch for every OTHER repo (never provisioned this run) is therefore
  // byte-unchanged from its pre-#1212 shape — including its own
  // `justProvisionedRepos` parameter, which is correctly left unpassed here
  // (no repo in `nonProvisionedRepos` can ever be a member of that set by
  // construction).
  const nonProvisionedRepos = confirmedRepos.filter((repo) => !provisionedNowRepos.has(repo));
  const routingRest =
    manifest.routing?.runner !== undefined && manifest.routing.runner.runs_on === 'self-hosted'
      ? await publishTrustedActorsGated(
          buildTrustedActorsValue(manifest.metadata.name, manifest.agents),
          nonProvisionedRepos,
          deps.trustDeps,
          // POLICY only (macf#929): the token gates whether we ATTEMPT the
          // detection-and-write at all; it never substitutes for confirming a
          // usable runner. `publishTrustedActorsGated` owns that contract.
          deps.runnerToken,
          routingPollOptions,
          // macf#972: repos created THIS run AND never provisioned THIS run
          // skip the full poll.
          justCreatedReposStillFast,
        )
      : {};
  // groundnuty/macf#1212 — `routingProvisioned` (built right after the POST
  // loop, above) and `routingRest` (just above) are keyed on DISJOINT repo
  // sets by construction (`provisionedNowRepos` vs. its complement), so the
  // merge below can never silently drop or overwrite an entry.
  const routing: Readonly<Record<string, EnsureVariableOutcome>> = { ...routingProvisioned, ...routingRest };
  for (const [repo, leg] of Object.entries<EnsureVariableOutcome>(routingRest)) {
    deps.log(
      `Routing var (${repo}): ${leg.status}` +
        (leg.status === 'failed' || leg.status === 'skipped' || leg.status === 'pending' ? ` — ${leg.reason}` : '.'),
    );
  }

  // Final sync (macf#857) — the LAST thing this run does: push whatever
  // changed in the control-repo checkout (fleet.lock from the incremental +
  // batched writes above, and vault.age if written). Deliberately SELECTIVE
  // — the real `commitAndPush` wired in here (`control-repo.ts`'s
  // `realControlRepoCommitAndPush`) stages an explicit allowlist, NEVER
  // `git add -A` (corrected 2026-08-12, #857 review — the prior framing
  // here, "UNSELECTIVE is a deliberate Amendment-B durability win," was
  // WRONG: committing a recovery artifact to permanent git history enlarges
  // an age-key compromise's blast radius to every HISTORICAL artifact, not
  // just current state, for a redundant second copy of secrets already in
  // `vault.age`). Any `secrets/recovery/<role>.age` STILL present because
  // the batched compose failed is left on LOCAL DISK ONLY, excluded by both
  // the allowlist and a committed `.gitignore` — see the module doc's
  // "Recovery-artifact lifecycle" section + `control-repo.ts`'s
  // "git-committed content invariant" section.
  const controlRepoSync = await syncControlRepo(controlDir, deps);

  // macf#992 (DR-043 Amendment B, the delete-timing fix) — recovery-artifact
  // DELETION happens HERE, after the push attempt, never at the earlier
  // `vault.status === 'written'` branch above. `vault.status === 'written'`
  // proves only that the LOCAL `age` encrypt into this run's per-process
  // `mkdtemp` checkout (`controlDir`) succeeded — that checkout is NOT
  // durable, it dies with the process. The credential is durable outside
  // this run's process only once `syncControlRepo` (immediately above) has
  // CONFIRMED a push. Deleting before that confirmation is exactly the bug
  // this issue closes: a crash or a rejected push in the window between
  // "local encrypt succeeded" and "push landed" would leave a freshly-minted
  // App on GitHub, a vault that existed only in the about-to-be-discarded
  // checkout, and no recovery artifact — because it was already gone. See
  // the module doc's "Recovery-artifact lifecycle" + "A sibling durable-write
  // of the SAME class" sections.
  //
  // Guarded on `pendingCreatedUpdates` being non-empty so a run with nothing
  // NEW this run (e.g. only a `transport.age_recipients` reencrypt via
  // `reconcileVaultRecipients`, which can independently set
  // `vault.status === 'written'` with zero created roles) never touches this
  // branch at all — there is nothing to retain OR delete for it.
  if (vault.status === 'written' && Object.keys(pendingCreatedUpdates).length > 0) {
    const createdRoles = Object.keys(pendingCreatedUpdates);
    if (controlRepoSync.status === 'pushed') {
      // The credential each `created` role's recovery artifact was insurance
      // FOR now has a CONFIRMED durable home outside this run's checkout —
      // the write-only insurance copy is no longer needed.
      for (const role of createdRoles) {
        removeAgentRecoveryArtifact(operatorRecoveryArtifactPath(recoveryRootDir, manifest.metadata.name, role));
      }
    } else {
      // NEVER delete insurance for a credential that is not confirmed
      // durable. `controlRepoSync.status === 'failed'` is the expected shape
      // here — the push failed for a boring reason (expired 1-hour bot
      // token, network blip, branch-protection rejection, a concurrent
      // push) — but `'nothing-to-commit'` is treated identically on
      // purpose: this branch only runs when THIS run's `settleVault` call
      // wrote FRESH content for at least one `created` role, so a
      // "nothing changed" push result here would itself be a symptom that
      // something is wrong, not proof the credential is safe. Retention is
      // the only safe default either way — say so LOUDLY, by path, so an
      // operator reading the transcript can find + recover it without
      // needing to decrypt anything first.
      const retainedPaths = createdRoles.map((role) => operatorRecoveryArtifactPath(recoveryRootDir, manifest.metadata.name, role));
      const syncReason = controlRepoSync.status === 'failed' ? ` — ${controlRepoSync.reason}` : '';
      // The consume path (`buildAgentDepsWithRecovery`'s `findRecoveryArtifact`,
      // above) only ever DECRYPTS when `deps.identityKeyPath` is supplied on
      // the NEXT run — without it, the artifact is found-but-unconsumed and
      // the role instead refuses on the App-name-collision pre-flight
      // (no duplicate App, but no automatic recovery either). Saying
      // "will consume automatically" unconditionally here would be exactly
      // the symmetric mistake this fix exists to prevent — an operator who
      // skips `--identity-key` on the re-run must not believe recovery is
      // automatic. Mirrors `commands/bootstrap-apply.ts::formatRecoveryArtifactNotice`'s
      // wording (the SAME conditional, surfaced pre-approval on the run
      // that FINDS the artifact — this log line is its sibling, surfaced
      // in-run on the run that RETAINS it).
      deps.log(
        `Recovery artifact(s) RETAINED for ${createdRoles.join(', ')} — the batched vault compose succeeded ` +
          `locally, but the control-repo push did not confirm as 'pushed' (status: ${controlRepoSync.status}` +
          `${syncReason}), so this run's fresh credential(s) are not yet durable outside the local checkout. ` +
          `Retained at: ${retainedPaths.join(', ')}. Re-run "macf bootstrap apply --vault <path> --identity-key ` +
          '<path>" and it will be found, decrypted, and consumed automatically — no ' +
          'new App is created for these role(s). Without --identity-key, the role is NOT auto-recovered; it refuses ' +
          'on the App-name-collision pre-flight instead (no duplicate App, but no automatic recovery either).',
      );
    }
  }

  const ca: CaApplyResult = { resolve: redactCaResolve(caResolve), registryLeg: caPublish.registryLeg, repoLegs: caPublish.repoLegs };
  // groundnuty/macf#1074 — `certLegs`/`keyLegs` are now a PROJECTION of the
  // unified six-secret publish result (`routingSecretsPublish`, below),
  // never a second publish call — kept as a field for backward-compat with
  // every existing `applyExitCode`/`formatApplyResult`/test consumer of
  // `result.routingClient.{cert,key}Legs`. `result.routingSecrets` (below)
  // is the NEW authoritative full-six view.
  const routingClient: RoutingClientApplyResult = {
    mint: redactRoutingClientMint(routingClientMint),
    certLegs: routingSecretsPublish[ROUTING_CLIENT_CERT_SECRET_NAME],
    keyLegs: routingSecretsPublish[ROUTING_CLIENT_KEY_SECRET_NAME],
  };
  return {
    controlRepo,
    controlRepoSync,
    controlRepoInit,
    lockPath,
    finalLock: currentLock,
    agents: records,
    runnerOps: runnerOpsIdentity,
    routerApp: routerAppIdentity,
    vault,
    identityChanges,
    ca,
    routing,
    runnerProvision: runnerProvisionResults,
    routingClient,
    routingSecrets: routingSecretsPublish,
    routingBundle: routingBundlePublish,
    actionsPin: manifest.versions
      ? { attempted: true, target: manifest.versions.actions, results: actionsPinResults }
      : { attempted: false, results: [] },
  };
}

/**
 * The final control-repo commit+push (macf#857) — see `ControlRepoSyncOutcome`'s
 * doc. NEVER throws; a push failure resolves to `status: 'failed'` so the
 * caller can render it (the durable-artifacts-exist-but-aren't-pushed-yet
 * state is recoverable — re-running `apply` re-clones the SAME control repo
 * and pushes again — but must not be silent, since it means this run's
 * `fleet.lock`/`vault.age` changes exist ONLY on local disk).
 */
async function syncControlRepo(controlDir: string, deps: FleetApplyDeps): Promise<ControlRepoSyncOutcome> {
  try {
    const result = await deps.controlRepoDeps.commitAndPush(controlDir, CONTROL_REPO_SYNC_COMMIT_MESSAGE);
    deps.log(`Control repo: final sync — ${result === 'pushed' ? 'pushed fleet.lock/vault.age changes' : 'nothing new to push'}.`);
    return { status: result };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.log(`Control repo: FINAL SYNC FAILED — ${reason}`);
    return { status: 'failed', reason };
  }
}

/**
 * DR-043 §D5 recipient-set reconciliation (groundnuty/macf#957) outcome —
 * see {@link reconcileVaultRecipients}'s doc.
 */
export type VaultRecipientReconcileOutcome =
  | { readonly status: 'noop' }
  | { readonly status: 'reencrypted' }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * DR-043 §D5 recipient-set reconciliation (groundnuty/macf#957) — closes the
 * gap `settleVault`'s prior unconditional early-`{status:'skipped'}` left
 * open: an operator adding a recipient to `transport.age_recipients` with no
 * NEW agent/CA/routing-client secret this run used to leave the vault
 * silently stale (§D5's "the vault must hold an identity that can decrypt
 * it" invariant, written-but-never-applied). See `vault-read.ts`'s module
 * doc for the full detection-needs-no-key / reencrypt-needs-an-identity
 * split this function implements.
 *
 * **Never auto-shrinks.** `stanzaCount > desired` REFUSES unconditionally
 * (even WITH an identity key) — re-encrypting to fewer recipients would
 * REVOKE decrypt access for whichever one was dropped, and §D3's "no delete
 * verb, extras are reported, never pruned" (Design invariant 4) applies at
 * the vault layer the same way it does everywhere else in this reconciler.
 * Only the SAFE, additive direction (fewer stanzas than desired) is ever
 * auto-applied, and only when `identityKeyPath` is supplied.
 */
async function reconcileVaultRecipients(
  vaultOutPath: string,
  desiredRecipients: readonly string[],
  identityKeyPath: string | undefined,
  deps: VaultRecipientReconcileDeps,
  log: (line: string) => void,
): Promise<VaultRecipientReconcileOutcome> {
  const readRecipientCount = deps.readRecipientCount ?? readVaultRecipientCount;
  const reencrypt = deps.reencrypt ?? reencryptVault;

  let counted: VaultRecipientCountResult;
  try {
    counted = readRecipientCount(vaultOutPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason: `could not read the current vault's recipient count — ${reason}` };
  }

  if (counted.status === 'absent') {
    // Nothing provisioned yet this run left un-provisioned — no vault
    // exists to have drifted; the first successful write will use whatever
    // is currently declared.
    return { status: 'noop' };
  }
  if (counted.count === desiredRecipients.length) {
    // Count-only match (age's header never reveals recipient IDENTITY
    // without decrypting per-key — see vault-read.ts's module doc) — this
    // IS the "no churn on every apply" steady state, not a claim the sets
    // are cryptographically confirmed identical.
    return { status: 'noop' };
  }

  if (counted.count > desiredRecipients.length) {
    return {
      status: 'refused',
      reason:
        `vault is encrypted to ${String(counted.count)} recipient(s), MORE than the ${String(desiredRecipients.length)} ` +
        'declared in transport.age_recipients. apply does NOT auto-shrink the recipient set — re-encrypting to fewer ' +
        'keys would REVOKE decrypt access for whichever recipient was dropped. Reconcile transport.age_recipients (add ' +
        'the missing entry back) or re-encrypt the vault manually, then re-run apply.',
    };
  }

  // counted.count < desiredRecipients.length — a DEFINITE, SAFE (additive)
  // shortfall. Needs an operator identity to decrypt the CURRENT vault
  // before it can re-encrypt to the fuller set (Amendment D).
  if (identityKeyPath === undefined) {
    return {
      status: 'refused',
      reason:
        `vault is encrypted to ${String(counted.count)} recipient(s), fewer than the ${String(desiredRecipients.length)} ` +
        'declared in transport.age_recipients, but no --identity-key was supplied — refusing to silently leave it ' +
        'stale (re-encrypting needs an operator identity able to decrypt the current vault). ' +
        'Re-run "macf bootstrap apply --vault <path> --identity-key <path>" to reconcile.',
    };
  }

  log(
    `Vault: recipient set changed (${String(counted.count)} → ${String(desiredRecipients.length)}) — ` +
      're-encrypting (decrypt-then-whole-rewrite).',
  );
  try {
    await reencrypt(vaultOutPath, identityKeyPath, desiredRecipients);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason: `re-encrypt to the new recipient set failed — ${reason}` };
  }
  log(`Vault: re-encrypted to ${String(desiredRecipients.length)} recipient(s) at ${vaultOutPath}.`);
  return { status: 'reencrypted' };
}

/**
 * Assemble + attempt the single, whole-payload vault write for every
 * `created` agent this run PLUS a freshly-minted CA key, when present
 * (`caSecrets`, DR-043 Amendment D phase 2 — macf#838), PLUS a freshly-minted
 * routing-client cert/key, when present (`routingClientSecrets`, DR-043 §D5
 * "routing-client re-mint" — groundnuty/macf#920). Returns the outcome
 * WITHOUT writing `fleet.lock` — the caller does that only on
 * `status: 'written'` (see module doc's ordering rationale). `writeVault`
 * is single-shot whole-payload (see `vault-write.ts`'s module doc) — there
 * can be only ONE vault write per run, so a fresh CA key / routing-client
 * key MUST fold into the SAME call as any fresh agent creds, never a second
 * write. `runnerOpsSecrets` (groundnuty/macf#943) is the SAME
 * once-per-run-only constraint applied to a fourth kind — see this module's
 * "runner-ops" call-site comment for why it MUST fold in here rather
 * than getting its own write.
 */
async function settleVault(
  manifest: FleetManifest,
  vaultOutPath: string,
  pendingVaultAgents: readonly VaultAgentSecrets[],
  caSecrets: VaultCaSecrets | undefined,
  routingClientSecrets: VaultRoutingClientSecrets | undefined,
  runnerOpsSecrets: VaultRunnerOpsSecrets | undefined,
  routingAppSecrets: VaultRoutingAppSecrets | undefined,
  deps: FleetApplyDeps,
): Promise<VaultApplyOutcome> {
  if (
    pendingVaultAgents.length === 0 &&
    caSecrets === undefined &&
    routingClientSecrets === undefined &&
    runnerOpsSecrets === undefined &&
    routingAppSecrets === undefined
  ) {
    // groundnuty/macf#957 — "nothing NEW to mint this run" does not mean
    // "nothing to do": a recipient added/removed from transport.age_recipients
    // since the vault was last written still needs a re-encrypt, and this
    // branch was previously the exact place that silently skipped it (see
    // this function's + `reconcileVaultRecipients`'s doc).
    const recipientOutcome = await reconcileVaultRecipients(
      vaultOutPath,
      manifest.transport.age_recipients,
      deps.identityKeyPath,
      deps.vaultRecipientDeps ?? {},
      deps.log,
    );
    switch (recipientOutcome.status) {
      case 'noop':
        return { status: 'skipped' };
      case 'reencrypted':
        return { status: 'written', path: vaultOutPath, versioned: false };
      case 'refused':
      case 'failed':
        return { status: 'failed', reason: recipientOutcome.reason };
    }
  }

  try {
    // Not merely a `writeVault`-will-catch-it-anyway redundancy: this
    // early throw produces a more actionable message (points at the exact
    // manifest field + `age-keygen`) than `writeVault`'s generic
    // `vault_no_recipients`, and by the time `applyFleet`'s loop reaches
    // here the §D5 pre-flight (`wouldCreateWithNoRecipient`) should already
    // have made this branch unreachable for any role that actually landed
    // in `pendingVaultAgents` — this remains as defense-in-depth for a
    // caller driving `settleVault` outside that orchestration.
    const recipients = manifest.transport.age_recipients;
    if (recipients.length === 0) {
      throw new VaultError(
        'vault_no_age_recipient',
        'transport.age_recipients is empty — no age recipient configured to encrypt the newly-minted credentials ' +
          'to. Mint one with `age-keygen` and add it to transport.age_recipients in fleet.yaml, then re-run apply ' +
          '— the App/install identities already recorded above are NOT re-created on re-run (GitHub App-name ' +
          'uniqueness is the guard).',
      );
    }
    const plaintext = buildVaultPlaintext({
      agents: [...pendingVaultAgents],
      ...(caSecrets !== undefined ? { ca: caSecrets } : {}),
      ...(routingClientSecrets !== undefined ? { routingClient: routingClientSecrets } : {}),
      ...(runnerOpsSecrets !== undefined ? { runnerOps: runnerOpsSecrets } : {}),
      ...(routingAppSecrets !== undefined ? { routingApp: routingAppSecrets } : {}),
    });

    // DR-043 Amendment D (groundnuty/macf#989) — a vault that ALREADY has
    // content needs a compose (decrypt current -> fold in `plaintext` ->
    // rewrite), never a direct single-shot `writeVault` — that either
    // refuses (the original bug) or, with `allowVersion`, writes a
    // timestamped SIBLING that nothing else ever reads, in neither case
    // extending the vault callers actually consult. `allowVaultVersion` is
    // therefore consulted ONLY on the first-write path below — once a vault
    // exists, `--identity-key` (checked by the per-agent/runner-ops
    // pre-flight, `wouldCreateWithUnreadableVault`) is the sole gate.
    const exists = deps.vaultDeps.exists ?? existsSync;
    if (exists(vaultOutPath)) {
      if (deps.identityKeyPath === undefined) {
        // Defense-in-depth, but genuinely REACHABLE (not dead code): the
        // per-agent/runner-ops pre-flight above only gates roles that would
        // CREATE a fresh App this run — a fresh CA-key or routing-client-cert
        // mint (`caSecrets`/`routingClientSecrets`) opens NO consent gate at
        // all (no App, no operator click), so a fleet where every agent
        // REUSES but the CA mints fresh this run (groundnuty/macf#978's
        // deactivate-then-apply shape) can reach here with an existing vault
        // and no identityKeyPath, entirely legitimately.
        throw new VaultError(
          'vault_no_identity_key',
          `vault already exists at "${vaultOutPath}" — this run has new secret(s) to fold into it, but no ` +
            '--identity-key (paired with --vault) was supplied to decrypt its current contents (a whole-payload ' +
            'rewrite of a live vault must be composed from its complete current contents, never ' +
            'a partial payload). Re-run "macf bootstrap apply --vault <path> --identity-key <path>" to reconcile.',
        );
      }
      // §D3 invariant 4 ("no delete verb, extras are reported, never
      // pruned") applies here exactly as it does to `reconcileVaultRecipients`
      // — composing this run's new secret(s) in must not ALSO silently
      // shrink the recipient set (which would revoke whichever recipient
      // transport.age_recipients dropped, as a side effect of an unrelated
      // add-agent run).
      const recipientCount = (deps.vaultRecipientDeps?.readRecipientCount ?? readVaultRecipientCount)(vaultOutPath);
      if (recipientCount.status === 'counted' && recipientCount.count > recipients.length) {
        throw new VaultError(
          'vault_would_shrink_recipients',
          `vault is encrypted to ${String(recipientCount.count)} recipient(s), MORE than the ${String(recipients.length)} ` +
            "declared in transport.age_recipients. Composing this run's new secret(s) in would ALSO re-encrypt to " +
            'fewer recipients, and would REVOKE decrypt access for whichever recipient was dropped ' +
            '(apply does NOT auto-shrink). Reconcile transport.age_recipients (add the missing entry ' +
            'back) first, then re-run apply.',
        );
      }
      const result = await composeAndWriteVault(vaultOutPath, deps.identityKeyPath, plaintext, recipients, deps.vaultComposeDeps);
      return { status: 'written', path: result.path, versioned: result.versioned };
    }

    const result = await writeVault(
      plaintext,
      { outPath: vaultOutPath, recipients, allowVersion: deps.allowVaultVersion === true, now: deps.now },
      deps.vaultDeps,
    );
    return { status: 'written', path: result.path, versioned: result.versioned };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

// Re-exported so callers building a `VaultPayload`-shaped record elsewhere
// (tests, future increments) reuse the same fingerprint mapping this module
// uses internally, without importing `vault-write.ts` AND `fleet-lock.ts`
// separately for one helper each.
export { vaultAgentSecretsForFingerprint };
