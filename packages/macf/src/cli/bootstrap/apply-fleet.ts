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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { caCertFingerprint } from '@groundnuty/macf-core';
import type { TokenSource } from '@groundnuty/macf-core';
import type { FleetAgent, FleetLock, FleetLockAgent, FleetManifest } from './fleet-manifest.js';
import { buildTrustedActorsValue, deriveAppHandle, deriveControlRepoName } from './fleet-manifest.js';
import type { AgentApplyDeps, AgentApplyOutcome } from './apply-agent.js';
import { applyAgentIdentity, applyIdentity, cleanupScratchPem, writeScratchPem } from './apply-agent.js';
import type { Presence } from './plan.js';
import { buildRegistryRepoValidateInstall, registryRepoCoverageUnverifiedOnSkipNote } from './registry-repo-coverage.js';
import type { AppCredentials } from './manifest-exchange.js';
import type { AgentRepoDeps, AgentRepoOptions, RepoInitStepDeps, RepoInitStepOutcome } from './apply-repo-init.js';
import { applyRepoInitForAgent, ensureAgentRepo } from './apply-repo-init.js';
import { repoHomepageUrl } from './app-manifest.js';
import type { ControlRepoDeps, ControlRepoOptions, ControlRepoOutcome } from './control-repo.js';
import { provisionControlRepo } from './control-repo.js';
import type { ControlRepoInitOutcome } from './apply-control-repo-init.js';
import { applyControlRepoInit } from './apply-control-repo-init.js';
import type { FleetLockAgentUpdate, FleetLockIdentityChange } from './fleet-lock.js';
import { composeFleetLock, readFleetLockFile, writeFleetLock } from './fleet-lock.js';
import type { VaultAgentSecrets, VaultCaSecrets, VaultEncryptFn, VaultRoutingClientSecrets, VaultRunnerOpsSecrets, WriteVaultDeps } from './vault-write.js';
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
import type { AppNameLengthCheck } from './apply-runner-ops.js';
import {
  RUNNER_OPS_ROLE,
  checkAppNameLengths,
  deriveRunnerOpsHandle,
  runnerOpsIdentityRequest,
  validateRunnerOpsInstall,
} from './apply-runner-ops.js';
import type { CaApplyDeps, CaApplyOutcome, CaPublishResult, CaResolveOutcome } from './apply-ca.js';
import { publishCaCertLegs, redactCaResolve, resolveCaCert, skippedCaPublish } from './apply-ca.js';
import type { EnsureVariableOutcome } from './ensure-variable.js';
import type { RunnerRegistrationDeps, RunnerTokenPollOptions } from './apply-routing.js';
import { formatRunnerPollProgress, publishTrustedActorsGated } from './apply-routing.js';
import type {
  RoutingClientApplyDeps,
  RoutingClientMintOutcome,
  RoutingClientPublishResult,
  RoutingClientSecretsForPublish,
} from './apply-routing-client.js';
import { mintRoutingClient, publishRoutingClientSecrets, resolveRoutingClientSecretsForPublish, skippedRoutingClientPublish } from './apply-routing-client.js';
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
   * mint-or-skip + create-only per-repo secret-deploy deps for the
   * macf-actions router's mTLS client identity. A SEPARATE field from
   * `trustDeps` (unlike `apply-routing.ts`'s `RoutingApplyDeps`, which really
   * is a `Pick` of the SAME shape) — this ceremony writes GitHub Actions
   * SECRETS via a wholly different API surface (`gh secret set`, no 409, no
   * registry leg) than `trustDeps`' variable-write primitives, so sharing one
   * dep object would blur two independently-testable seams together.
   */
  readonly routingClientDeps: RoutingClientApplyDeps;
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
   */
  readonly runnerOps: AgentApplyOutcome;
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
  /** DR-043 §D5 "routing-client re-mint" (groundnuty/macf#920) — see {@link RoutingClientApplyResult}'s doc. ALWAYS present — a fleet with no confirmed agent repos this run still reports `mint.status`. */
  readonly routingClient: RoutingClientApplyResult;
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
      deps.log(`Role "${role}": credential durably recorded at ${outPath} (recovery artifact, pre-gate-2, DR-043 §D5).`);
    },
    findRecoveryArtifact: async (role: string): Promise<AppCredentials | undefined> => {
      const artifactPath = operatorRecoveryArtifactPath(recoveryRootDir, fleetName, role);
      if (!recoveryExists(artifactPath)) return undefined;
      if (identityKeyPath === undefined) {
        deps.log(
          `Role "${role}": a durable recovery artifact exists at ${artifactPath} (from a prior run's crash before ` +
            'its credential reached the vault — DR-043 Amendment B, macf#988) but no --identity-key was given this ' +
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
              '(DR-043 Amendment B, macf#988).',
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
      'transport.age_recipients is empty (DR-043 §D5), so its credential could NEVER be made durable ' +
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
      'its current contents into a fresh compose (DR-043 Amendment D: the vault is never read-modify-written — a ' +
      "whole-payload rewrite of a LIVE vault must be composed from the vault's complete current contents, never a " +
      'partial payload). Refusing to open consent gate 1 for a credential whose vault write would fail after the ' +
      'fact (groundnuty/macf#989). Re-run with "macf bootstrap apply --vault <path> --identity-key <path>" so the ' +
      'existing vault can be decrypted, merged, and rewritten.',
  };
}

/** The final control-repo sync commit message (macf#857) — one constant so every call site + every test asserting on it agree. */
export const CONTROL_REPO_SYNC_COMMIT_MESSAGE = 'chore(bootstrap): apply — fleet.lock / vault.age update (DR-043 §D5)';

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
    vault: { status: 'skipped' },
    identityChanges: [],
    ca: {
      resolve: { status: 'failed', reason: `${reason} — see controlRepo above.` },
      registryLeg: { status: 'skipped', reason: `${reason} — see controlRepo above.` },
      repoLegs: {},
    },
    routing: {},
    routingClient: {
      mint: { status: 'skipped', reason: `${reason} — see controlRepo above.` },
      certLegs: {},
      keyLegs: {},
    },
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
  const controlRepoInit = await applyControlRepoInit(controlDir, manifest, { repoInit: deps.repoInitDeps.repoInit });
  if (controlRepoInit.status === 'failed') {
    deps.log(`Control repo "${controlRepo.repo}" repo-init: FAILED — ${controlRepoInit.reason}`);
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
  // was `'created'` (not `'present'`) this run — fed to
  // `apply-routing.ts::publishTrustedActorsGated`'s `justCreatedRepos` param
  // so it skips the 600s poll for a repo that, by construction, cannot yet
  // have a runner registered to it (nothing in this run provisions one —
  // macf#943 is unbuilt). A repo already present before this run keeps
  // polling — a runner may legitimately be mid-registration for it.
  const justCreatedRepos = new Set<string>();

  const writeIncrementalLock = (role: string, update: FleetLockAgentUpdate): void => {
    const composed = composeFleetLock({ fleet: manifest.metadata.name, previous: currentLock, agentUpdates: { [role]: update } });
    writeFleetLock(lockPath, composed.lock);
    currentLock = composed.lock;
    identityChanges.push(...composed.identityChanges);
  };

  // groundnuty/macf#1012 — computed ONCE (fleet-level, not per-agent):
  // `registry.type === 'repo'` is the only registry shape this run needs to
  // live-verify install coverage for. `type: profile`/`org`/`local` never
  // reach `buildRegistryRepoValidateInstall` at all — byte-identical
  // behavior to pre-#1012 (requirement 5).
  const registry = manifest.owner.registry;

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
    // groundnuty/macf#1012 — when the registry is repo-scoped, every
    // ordinary agent's install must be live-verified to actually cover the
    // registry repo (never the runner-ops, below — it never touches the
    // registry). Wired here (not in `apply-agent.ts::realAgentApplyDeps`)
    // because this check needs FLEET-level context
    // (`manifest.owner.registry`) `realAgentApplyDeps` doesn't have — same
    // reasoning `buildAgentDepsWithRecovery`'s own splice already
    // establishes for `writeRecoveryArtifact`/`findRecoveryArtifact`.
    const agentDeps: AgentApplyDeps = (() => {
      if (registry.type !== 'repo') return agentDepsBase;
      // Wired onto BOTH `validateInstall` (CREATE / resume-install, via
      // `runGate2`) AND `validateReuse` (an already-provisioned role
      // re-confirmed on a re-run, via `applyIdentity`'s `reuse-confirmed`
      // branch — see that field's doc for why it's separate from
      // `validateInstall`) — the SAME closure, so an agent's install is
      // verified identically regardless of which path resolved it this run.
      const registryRepoValidate = buildRegistryRepoValidateInstall(
        registry.owner,
        registry.repo,
        deriveAppHandle(manifest.metadata.name, agent.role),
        scopedLog,
        deps.checkRegistryRepoCoverage,
      );
      return { ...agentDepsBase, validateInstall: registryRepoValidate, validateReuse: registryRepoValidate };
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
      registry.type === 'repo' && rawIdentity.status === 'skipped-unverified' && agentDeps.resolveKeyPath === undefined
        ? {
            ...rawIdentity,
            reason: `${rawIdentity.reason} ${registryRepoCoverageUnverifiedOnSkipNote(deriveAppHandle(manifest.metadata.name, agent.role), registry.owner, registry.repo)}`,
          }
        : rawIdentity;

    let repoInitOutcome: RepoInitStepOutcome | undefined;
    const handle = deriveAppHandle(manifest.metadata.name, agent.role);

    if (identity.status === 'reused' || identity.status === 'resumed-install') {
      writeIncrementalLock(agent.role, { appId: identity.appId, installId: identity.installId });
      // No PEM in process memory this run for `reused`/`resumed-install` (no
      // vault-decrypt seam wired into repo-init yet — see
      // `RepoInitStepOptions.tokenSource`'s doc) — pre-existing, acknowledged
      // gap; groundnuty/macf#920 closes ONLY the `created` path below, which
      // is where apply-fleet.ts already holds a freshly-exchanged credential.
      repoInitOutcome = await applyRepoInitForAgent(agent, manifest, deps.repoInitDeps);
    } else if (identity.status === 'created') {
      const secrets = agentVaultSecrets(handle, identity);
      pendingVaultAgents.push(secrets);
      pendingCreatedUpdates[agent.role] = {
        appId: identity.appId,
        installId: identity.installId,
        secrets: vaultAgentSecretsForFingerprint(secrets),
      };
      repoInitOutcome = await applyRepoInitForCreatedAgent(agent, manifest, identity, deps.repoInitDeps);
    }
    // skipped-unverified / drift / failed: no lock write, no repo-init —
    // this agent's identity is unresolved this run.

    records.push({ role: agent.role, identity, repoInit: repoInitOutcome });
  }

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
  const runnerOpsPrior = currentLock?.agents.find((a) => a.role === RUNNER_OPS_ROLE);
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
    // repository_selection at creation time (see
    // `apply-runner-ops.ts::validateRunnerOpsInstall`'s doc); this
    // is the verify-then-refuse enforcement point, checked right after gate 2
    // confirms, before this identity is ever reported as created/resumed.
    validateInstall: validateRunnerOpsInstall,
  };
  const runnerOpsIdentity: AgentApplyOutcome = wouldCreateWithNoRecipient(runnerOpsPrior, recipients)
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

  let pendingRunnerOpsVaultSecrets: VaultRunnerOpsSecrets | undefined;
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
  deps.log(
    `Runner-ops App: ${runnerOpsIdentity.status.toUpperCase()}` +
      (runnerOpsIdentity.status === 'failed' ||
      runnerOpsIdentity.status === 'drift' ||
      runnerOpsIdentity.status === 'skipped-unverified'
        ? ` — ${runnerOpsIdentity.reason}`
        : '.'),
  );
  // `runnerOpsIdentity` is threaded straight onto `FleetApplyResult.runnerOps`
  // at the end of this function — a SEPARATE field from `agents` (see that
  // field's doc for why: `agents` is 1:1 with `manifest.agents[]` throughout
  // this module, and this App is never declared there).

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
    deps,
  );
  if (
    vault.status === 'written' &&
    (Object.keys(pendingCreatedUpdates).length > 0 || caSecretsForVault !== undefined || routingClientSecretsForVault !== undefined)
  ) {
    // Batched, not per-role: `writeVault` just persisted EVERY `created`
    // agent's secret (+ the CA key, when freshly minted, + the routing-client
    // key, when freshly minted) in ONE `age` invocation, so their lock
    // entries become durable together too — see the module doc's ordering
    // rationale. `fleetSecrets` is the CA-key / routing-client fingerprints
    // ONLY — this is the SOLE place `fingerprints.ca_key`/
    // `fingerprints.routing_client_key` are ever written (never an
    // incremental per-agent write), matching `pendingCreatedUpdates`'s
    // existing batched-only discipline.
    const fleetSecrets =
      caSecretsForVault !== undefined || routingClientSecretsForVault !== undefined
        ? vaultFleetSecretsForFingerprint({
            agents: [],
            ...(caSecretsForVault !== undefined ? { ca: caSecretsForVault } : {}),
            ...(routingClientSecretsForVault !== undefined ? { routingClient: routingClientSecretsForVault } : {}),
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
        'cert until its key is durable (DR-043 §D5). Re-run apply once the vault issue is fixed. The retry ' +
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

  // Per-repo routing-client secret deploy (DR-043 §D5 "routing-client
  // re-mint," groundnuty/macf#920 gap 2; per-repo publish groundnuty/macf#986)
  // — three cases, deliberately kept as three DISTINCT branches rather than
  // one blanket "always run the loop" so the two byte-identical-with-pre-#986
  // cases stay verifiably untouched:
  //
  //   1. A cert freshly minted THIS run whose key isn't confirmed durable
  //      yet (`vault.status !== 'written'`) publishes NOTHING — same
  //      ordering-safety rule as the CA cert above (deploying an unvaulted
  //      key would recreate the #799 orphan-cert class). fleet.lock never
  //      recorded a fingerprint for this run's key, so a retry safely
  //      re-mints; nothing is orphaned. UNCHANGED from pre-#986.
  //   2. A cert freshly minted THIS run with its key durable -> publish the
  //      in-memory material directly, exactly as before (just re-expressed
  //      through the same `RoutingClientSecretsForPublish` shape case 3
  //      below uses). UNCHANGED from pre-#986.
  //   3. Mint was SKIPPED because `lockHasRoutingClientKey` — a PRIOR run
  //      already minted this fleet's routing-client cert (the ONLY case
  //      `mintRoutingClient` can return 'skipped' for when this boolean is
  //      true). THIS is the case #986 is about: a repo added to the fleet
  //      AFTER that prior mint needs the cert/key published to it, not a
  //      re-mint. `resolveRoutingClientSecretsForPublish` tries a
  //      vault-restore (only when `--vault`/`--identity-key` were both
  //      supplied) before degrading to an honest 'unavailable';
  //      `publishRoutingClientSecrets` THEN always runs its per-repo
  //      idempotent loop — `'already-present'` for a repo that already has
  //      the secret, a loud `'failed'` (never a silent `'skipped'`) for one
  //      that's missing it and has no material to create it with.
  //
  // Every OTHER skip/failure shape — mint skipped because CA was reused and
  // NOTHING has ever been minted for this fleet (`!lockHasRoutingClientKey`),
  // or a genuine mint EXCEPTION (groundnuty/macf#954; only reachable when
  // `!lockHasRoutingClientKey` too, since `mintRoutingClient` only calls
  // `deps.mint` on that branch) — has NOTHING recoverable from the vault
  // either way (nothing was ever minted to restore), so it stays the
  // ORIGINAL blanket `skippedRoutingClientPublish`, byte-identical to
  // pre-#986 behaviour. Verified against `apply-fleet.test.ts`'s existing
  // CA-restore fixture (macf#978), which reuses this exact shape
  // (`lockHasRoutingClientKey === false`, CA restored not minted) and must
  // NOT start failing `apply`'s exit code over an orthogonal CA concern.
  let routingClientPublish: RoutingClientPublishResult;
  if (routingClientMint.status === 'minted' && vault.status !== 'written') {
    routingClientPublish = skippedRoutingClientPublish(
      confirmedRepos,
      'routing-client cert was freshly minted this run but the batched vault write did not succeed — refusing to ' +
        'deploy the private key to any repo until it is durable (DR-043 §D5). Re-run apply once the vault issue is ' +
        "fixed. The retry re-mints (fleet.lock never recorded a routing_client_key fingerprint), which is harmless: " +
        "this run's key was never made durable and was never deployed, so nothing is orphaned.",
    );
  } else if (routingClientMint.status === 'minted') {
    const secretsForPublish: RoutingClientSecretsForPublish = { status: 'available', certPem: routingClientMint.certPem, keyPem: routingClientMint.keyPem };
    routingClientPublish = await publishRoutingClientSecrets(secretsForPublish, confirmedRepos, deps.routingClientDeps);
  } else if (lockHasRoutingClientKey) {
    const secretsForPublish = await resolveRoutingClientSecretsForPublish(routingClientMint, true, deps.routingClientDeps);
    routingClientPublish = await publishRoutingClientSecrets(secretsForPublish, confirmedRepos, deps.routingClientDeps);
  } else {
    routingClientPublish = skippedRoutingClientPublish(confirmedRepos, routingClientMint.reason);
  }
  deps.log(
    `Routing-client cert legs: ${String(Object.values(routingClientPublish.certLegs).filter((l) => l.status === 'created').length)} created, ` +
      `${String(Object.values(routingClientPublish.certLegs).filter((l) => l.status === 'already-present').length)} already-present of ` +
      `${String(confirmedRepos.length)} confirmed repo(s).`,
  );
  for (const [repo, leg] of Object.entries(routingClientPublish.certLegs)) {
    if (leg.status === 'failed' || leg.status === 'skipped') {
      deps.log(`Routing-client cert leg (${repo}): ${leg.status} — ${leg.reason}`);
    }
  }
  for (const [repo, leg] of Object.entries(routingClientPublish.keyLegs)) {
    if (leg.status === 'failed' || leg.status === 'skipped') {
      deps.log(`Routing-client key leg (${repo}): ${leg.status} — ${leg.reason}`);
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
  const routing =
    manifest.routing?.runner !== undefined && manifest.routing.runner.runs_on === 'self-hosted'
      ? await publishTrustedActorsGated(
          buildTrustedActorsValue(manifest.metadata.name, manifest.agents),
          confirmedRepos,
          deps.trustDeps,
          // POLICY only (macf#929): the token gates whether we ATTEMPT the
          // detection-and-write at all; it never substitutes for confirming a
          // usable runner. `publishTrustedActorsGated` owns that contract.
          deps.runnerToken,
          routingPollOptions,
          // macf#972 — repos created THIS RUN skip the poll (see
          // `justCreatedRepos`'s doc above).
          justCreatedRepos,
        )
      : {};
  for (const [repo, leg] of Object.entries<EnsureVariableOutcome>(routing)) {
    deps.log(`Routing var (${repo}): ${leg.status}` + (leg.status === 'failed' || leg.status === 'skipped' ? ` — ${leg.reason}` : '.'));
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
          '<path>" and it will be found, decrypted, and consumed automatically (DR-043 Amendment B, macf#992) — no ' +
          'new App is created for these role(s). Without --identity-key, the role is NOT auto-recovered; it refuses ' +
          'on the App-name-collision pre-flight instead (no duplicate App, but no automatic recovery either).',
      );
    }
  }

  const ca: CaApplyResult = { resolve: redactCaResolve(caResolve), registryLeg: caPublish.registryLeg, repoLegs: caPublish.repoLegs };
  const routingClient: RoutingClientApplyResult = {
    mint: redactRoutingClientMint(routingClientMint),
    certLegs: routingClientPublish.certLegs,
    keyLegs: routingClientPublish.keyLegs,
  };
  return {
    controlRepo,
    controlRepoSync,
    controlRepoInit,
    lockPath,
    finalLock: currentLock,
    agents: records,
    runnerOps: runnerOpsIdentity,
    vault,
    identityChanges,
    ca,
    routing,
    routingClient,
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
        'stale (DR-043 Amendment D: re-encrypting needs an operator identity able to decrypt the current vault). ' +
        'Re-run "macf bootstrap apply --vault <path> --identity-key <path>" to reconcile.',
    };
  }

  log(
    `Vault: recipient set changed (${String(counted.count)} → ${String(desiredRecipients.length)}) — ` +
      're-encrypting (decrypt-then-whole-rewrite, DR-043 Amendment D).',
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
  deps: FleetApplyDeps,
): Promise<VaultApplyOutcome> {
  if (
    pendingVaultAgents.length === 0 &&
    caSecrets === undefined &&
    routingClientSecrets === undefined &&
    runnerOpsSecrets === undefined
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
            '--identity-key (paired with --vault) was supplied to decrypt its current contents (DR-043 Amendment ' +
            'D: a whole-payload rewrite of a live vault must be composed from its complete current contents, never ' +
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
            'fewer recipients, and would REVOKE decrypt access for whichever recipient was dropped (DR-043 §D3 ' +
            'invariant 4 — apply does NOT auto-shrink). Reconcile transport.age_recipients (add the missing entry ' +
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
