/**
 * `macf fleet delete-apps` / `macf fleet destroy` — the IRREVERSIBLE half of
 * DR-043 Amendment G's fleet teardown ladder (groundnuty/macf#867).
 * `deactivate` / `archive` (the reversible rungs) live in `teardown.ts` —
 * that module's own doc explicitly scopes `delete-apps`/`destroy` OUT
 * ("those need a separate, harder-to-reach command, never a flag on this
 * one"), and this module is that separate command's orchestration layer.
 *
 * Pure orchestration over injected deps, same posture as `teardown.ts` and
 * `apply-fleet.ts`: no direct `gh`/`age` calls live here, only calls through
 * the deps interfaces below, so SEQUENCING (what's targeted, what's
 * refused, what's attempted) is unit-testable with zero real I/O. Every
 * `build*Plan` function is READ-ONLY (never mutates); every `execute*`
 * function performs no gating of its own — gating happens once, at the
 * orchestration layer above (the CLI command file), exactly like
 * `teardown.ts`'s own `executeDeactivate`/`executeArchiveRepos` split.
 *
 * ## `delete-apps` = `archive`'s work + the App-identity report
 *
 * Amendment G's ladder table is CUMULATIVE-BY-STATE: `delete-apps` REMOVES
 * everything `archive` removes, plus the per-agent App identities. Mirroring
 * `archive`'s OWN precedent of re-running `deactivate`'s registry deletion
 * inside its own execution (idempotent-on-rerun, so this is never a
 * double-mutation hazard — see `teardown.ts`'s doc), `delete-apps` re-runs
 * BOTH `deactivate`'s registry-target deletion AND `archive`'s
 * repo-archiving inside its own execution, then layers the App-identity
 * report on top — a single `delete-apps` invocation is self-sufficient even
 * if the operator never separately ran `deactivate`/`archive` first.
 *
 * `delete-apps` does **NOT** delete repositories — per the ladder table,
 * repos are still only ARCHIVED at this rung ({@link computeArchiveRepoTargets}
 * reused from `teardown.ts` + `archiveRepo`, the SAME primitive `archive`
 * uses); only `destroy` deletes them.
 *
 * The App-identity portion can NEVER report success — see
 * `app-identity-removal.ts`'s module doc for why (no REST path to delete a
 * GitHub App registration, verified against current GitHub docs). The
 * command layer's exit code is therefore non-zero whenever the fleet has at
 * least one agent — "report what could not be done, never exit green"
 * (Amendment G's shared rail) at its most literal.
 *
 * ## `destroy` — terminal, deletes repos DIRECTLY (never archive-then-delete)
 *
 * "archiving something you're about to delete is pointless work" (Amendment
 * G). `destroy` derives the IDENTICAL target SETS `delete-apps` does (both
 * route through the SAME {@link buildIrreversibleTeardownPlan} — never a
 * second, independently-hand-derived target computation) but applies
 * DELETION, not archiving, to the repo targets ({@link executeDestroyRepos}
 * via `repo-destroy.ts::realDeleteRepo`), and — load-bearing, see
 * {@link buildDestroyPlan}'s own doc — REORDERS the repo targets so agent
 * repos are deleted before the control repo, never after.
 *
 * **Friction is the feature** (the operator's own words: "we should never —
 * and I repeat never — allow to easily remove repositories"). `destroy`
 * requires ALL THREE of: the `--destroy-repositories` flag (implied by
 * nothing else), typing the fleet's exact name, and an environment
 * acknowledgment (`MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES=1`).
 * {@link evaluateDestroyAcknowledgments} is the pure gate — aggregates EVERY
 * missing acknowledgment into one refusal (Pattern D's aggregate-fail-loud
 * discipline, `silent-fallback-hazards.md`), rather than stopping at the
 * first, so an operator missing two of three sees both at once.
 *
 * The ownership gate ({@link evaluateTeardownGate}, reused unchanged from
 * `teardown.ts` — never re-derived) is checked FIRST by the caller, before
 * the destroy-specific acknowledgments — refusing a foreign/unconfirmed
 * control repo before ever asking the operator to type anything.
 *
 * ## The age-key shred — explicit opt-in, never implied, never on the
 * default path
 *
 * See `age-key-shred.ts`'s module doc for the mechanism. This module's own
 * contribution is {@link evaluateShredRequest} — the pure gate that refuses
 * to guess an identity-file path (an unset `--age-identity` with
 * `--shred-age-key` passed is a REFUSAL, not a silent no-op) — kept
 * structurally SEPARATE from {@link executeDestroy}'s mutation set, so a
 * caller cannot reach it by accident; the CLI command layer calls
 * `deps.shredAgeIdentity` only after `evaluateShredRequest(...).proceed`
 * is `true`.
 */
import type { FleetManifest } from './fleet-manifest.js';
import type {
  DeactivateInventoryEntry,
  DeactivateTarget,
  RepoArchiveOutcome,
  TeardownControlRepoDeps,
  TeardownGate,
  TeardownRepoArchiveDeps,
  TeardownVariableDeps,
  VariableTeardownOutcome,
} from './teardown.js';
import {
  computeArchiveRepoTargets,
  computeDeactivateInventory,
  computeDeactivateTargets,
  evaluateTeardownGate,
  executeArchiveRepos,
  executeDeactivate,
  resolveControlRepoOwnership,
} from './teardown.js';
import type { AppDeletionDeps, AppDeletionOutcome, AppIdentityTarget } from './app-identity-removal.js';
import { classifyLockReadability, computeAppIdentityTargets, enrichAppIdentityTargetsWithLock, reportAppIdentityRemoval } from './app-identity-removal.js';
import { controlRepoFullName } from './control-repo.js';
import type { DeleteRepoFn } from './repo-destroy.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Shared plan shape (delete-apps AND destroy derive the SAME targets) ---

/**
 * `'read'` — `fleet.lock` was read AND parsed (see
 * `app-identity-removal.ts::classifyLockReadability`). `'unreadable'` — a
 * `readFleetLock` dep WAS supplied and called but the lock could not be
 * used (missing/network-failed/malformed). `'not-attempted'` — no
 * `readFleetLock` dep was supplied at all (a caller/test that never wired
 * one — production wiring always supplies
 * `control-repo.ts::realReadControlFleetLockFile`, so this state is a
 * degrade path, not a normal production outcome), OR the gate refused (no
 * point reading a lock for a run that touches nothing).
 *
 * The three-way split is deliberate (groundnuty/macf#953's honest-unknown
 * floor) — collapsing `'unreadable'` and `'not-attempted'` into one boolean
 * would make a caller that never wired `readFleetLock` at all render
 * identically to one whose lock read genuinely failed, silently implying
 * "checked, found nothing extra" for a run that never checked at all.
 */
export type FleetLockReadStatus = 'read' | 'unreadable' | 'not-attempted';

export interface IrreversibleTeardownPlan {
  readonly fleet: string;
  readonly gate: TeardownGate;
  readonly registryTargets: readonly DeactivateTarget[];
  readonly registryInventory: readonly DeactivateInventoryEntry[];
  /** Repo NAMES both rungs act on — `delete-apps` archives them, `destroy` deletes them (the ACTION differs, never the derivation). Empty when the gate refuses. */
  readonly repoTargets: readonly string[];
  readonly appTargets: readonly AppIdentityTarget[];
  /**
   * Whether {@link appTargets} could have included lock-only (non-manifest)
   * identities — see {@link FleetLockReadStatus}'s doc. The render layer
   * (`fleet-teardown-destructive.ts`) surfaces a LOUD caveat whenever this
   * is not `'read'`, so an operator never mistakes "the lock couldn't be
   * checked" for "the lock was checked and found nothing extra."
   */
  readonly lockReadStatus: FleetLockReadStatus;
}

export type IrreversibleTeardownPlanDeps = TeardownControlRepoDeps &
  Pick<TeardownVariableDeps, 'checkRegistryPresence'> & {
    /**
     * OPTIONAL best-effort read of the control repo's committed
     * `fleet.lock` — used to UNION + enrich {@link IrreversibleTeardownPlan.appTargets}
     * with roles `fleet.lock` recorded that `manifest.agents[]` never
     * declared (e.g. the runner-ops App), plus the AUTHORITATIVE recorded
     * `app_id` per role (see `app-identity-removal.ts`'s
     * `enrichAppIdentityTargetsWithLock` doc for why the derived slug alone
     * isn't enough — groundnuty/macf#953). Optional — and skipped entirely
     * when absent — so existing callers/tests that never wire it keep
     * working with manifest-only, slug-only targets unchanged; this is
     * purely additive enrichment, never a new precondition. When omitted,
     * {@link IrreversibleTeardownPlan.lockReadStatus} reads `'not-attempted'`
     * — the report is honest about not having checked, rather than silently
     * implying nothing extra exists.
     */
    readonly readFleetLock?: (repo: string) => Promise<string | undefined>;
  };

/**
 * Compose the full read-only plan shared by `delete-apps` and `destroy`:
 * gate + every rung's exact targets, by exact-key derivation (never a
 * pattern sweep — reuses `teardown.ts`'s own derivations unchanged). NEVER
 * mutates anything.
 */
async function buildIrreversibleTeardownPlan(manifest: FleetManifest, deps: IrreversibleTeardownPlanDeps): Promise<IrreversibleTeardownPlan> {
  const ownership = await resolveControlRepoOwnership(manifest, deps);
  const gate = evaluateTeardownGate(manifest, ownership);
  const registryTargets = computeDeactivateTargets(manifest);
  const registryInventory = gate.allowed ? await computeDeactivateInventory(manifest, registryTargets, deps) : [];
  const repoTargets = gate.allowed ? computeArchiveRepoTargets(manifest) : [];
  let appTargets = gate.allowed ? computeAppIdentityTargets(manifest) : [];
  let lockReadStatus: FleetLockReadStatus = 'not-attempted';
  if (gate.allowed && deps.readFleetLock) {
    // `readFleetLock`'s type (`(repo) => Promise<string | undefined>`) does
    // NOT forbid rejection — only the PRODUCTION implementation
    // (`realReadControlFleetLockFile`) happens to catch everything and
    // degrade to `undefined`. A test/alternate dep that throws must not
    // blow up plan-building: that would kill the command with no `--json`
    // envelope (this package's own `--json` always-emits-something rail,
    // groundnuty/macf#830) and, worse, would SKIP reporting the exact
    // "lock cannot be read" case `lockReadStatus`/`classifyLockReadability`
    // exist to surface (groundnuty/macf#953's honest-unknown floor). A
    // throw degrades identically to a resolved `undefined`.
    try {
      const lockText = await deps.readFleetLock(controlRepoFullName(manifest));
      lockReadStatus = classifyLockReadability(lockText);
      appTargets = enrichAppIdentityTargetsWithLock(appTargets, lockText, manifest);
    } catch {
      lockReadStatus = 'unreadable';
    }
  }
  return { fleet: manifest.metadata.name, gate, registryTargets, registryInventory, repoTargets, appTargets, lockReadStatus };
}

// --- delete-apps ---

export type DeleteAppsPlan = IrreversibleTeardownPlan;
export type DeleteAppsPlanDeps = IrreversibleTeardownPlanDeps;

/** `delete-apps`'s plan — identical shape/derivation to `destroy`'s, see module doc. */
export async function buildDeleteAppsPlan(manifest: FleetManifest, deps: DeleteAppsPlanDeps): Promise<DeleteAppsPlan> {
  return buildIrreversibleTeardownPlan(manifest, deps);
}

export type DeleteAppsExecuteDeps = Pick<TeardownVariableDeps, 'deleteRegistryVariable'> & TeardownRepoArchiveDeps & AppDeletionDeps;

export interface DeleteAppsExecuteResult {
  readonly registryOutcomes: readonly VariableTeardownOutcome[];
  readonly repoOutcomes: readonly RepoArchiveOutcome[];
  readonly appOutcomes: readonly AppDeletionOutcome[];
}

/**
 * Execute `delete-apps`'s three rungs in sequence: registry deletion, repo
 * ARCHIVING (SAME primitive `archive` uses — never repo deletion), then the
 * App-identity report. Caller MUST have already confirmed `plan.gate.allowed`
 * — this function performs no gating of its own (same split
 * `teardown.ts`'s `executeDeactivate`/`executeArchiveRepos` establish).
 * NEVER throws — every sub-step isolates its own per-target failures.
 */
export async function executeDeleteApps(
  manifest: FleetManifest,
  plan: DeleteAppsPlan,
  log: (line: string) => void,
  deps: DeleteAppsExecuteDeps,
): Promise<DeleteAppsExecuteResult> {
  const registryOutcomes = await executeDeactivate(manifest, plan.registryTargets, deps);
  const repoOutcomes = await executeArchiveRepos(plan.repoTargets, deps);
  const appOutcomes = await reportAppIdentityRemoval(manifest.owner, plan.appTargets, log, deps);
  return { registryOutcomes, repoOutcomes, appOutcomes };
}

// --- destroy ---

export type DestroyPlan = IrreversibleTeardownPlan;
export type DestroyPlanDeps = IrreversibleTeardownPlanDeps;

/**
 * `destroy`'s plan — SAME derivation as `delete-apps` (never a second,
 * independently hand-derived target SET). The ACTION applied to
 * `repoTargets` differs (delete, not archive — see
 * {@link executeDestroyRepos}); the repo-target ORDER also deliberately
 * differs, for a load-bearing reason: `computeArchiveRepoTargets` (reused
 * by {@link buildIrreversibleTeardownPlan}) orders `[control, ...agents]`,
 * which is fine for archiving (order-independent — an archived control repo
 * still classifies `ours-archived`, so re-running `archive` after a partial
 * failure is safe regardless of which repo failed) but load-bearing for
 * DELETION: once the control repo is gone, `checkMeta` reads `absent` and
 * `evaluateTeardownGate` refuses EVERY subsequent invocation with "nothing
 * to tear down" — so a partial failure on an agent-repo delete THAT HAPPENS
 * AFTER the control repo is already gone would strand the operator with no
 * tool path back to finish the job. Deleting agent repos FIRST and the
 * control repo LAST means any partial failure leaves the fleet still
 * addressable-for-teardown-purposes (the ownership gate still resolves),
 * so the operator can fix the failure and re-run `destroy` to completion.
 * The derived SET is identical either way — only order flips.
 */
export async function buildDestroyPlan(manifest: FleetManifest, deps: DestroyPlanDeps): Promise<DestroyPlan> {
  const base = await buildIrreversibleTeardownPlan(manifest, deps);
  const [control, ...agentRepos] = base.repoTargets;
  const repoTargets = control === undefined ? base.repoTargets : [...agentRepos, control];
  return { ...base, repoTargets };
}

// --- destroy's acknowledgment ladder (pure) ---

export interface DestroyAcknowledgmentInput {
  readonly destroyRepositoriesFlag: boolean;
  readonly envAck: boolean;
  /** `''` when never prompted — the CLI layer skips the interactive typed-name prompt once flag/env already fail, to avoid demanding the scary confirmation on a run that's refused regardless (see `fleet-teardown-destructive.ts`). */
  readonly typedFleetName: string;
}

export interface DestroyAcknowledgmentResult {
  readonly allowed: boolean;
  /** Every missing/failed acknowledgment, aggregated — Pattern D's aggregate-fail-loud discipline (`silent-fallback-hazards.md`), never stop-at-first. */
  readonly missing: readonly string[];
}

/**
 * Pure gate — ALL THREE of `--destroy-repositories`, the env acknowledgment,
 * and an EXACT typed-name match are required; missing ANY refuses. See
 * module doc's "friction is the feature" section for why this is a SEPARATE
 * ladder from the ownership gate (checked earlier, by the caller, via
 * `plan.gate`).
 */
export function evaluateDestroyAcknowledgments(expectedFleetName: string, input: DestroyAcknowledgmentInput): DestroyAcknowledgmentResult {
  const missing: string[] = [];
  if (!input.destroyRepositoriesFlag) {
    missing.push('--destroy-repositories was not passed (implied by nothing else — a dedicated flag is required).');
  }
  if (!input.envAck) {
    missing.push('environment acknowledgment MACF_I_UNDERSTAND_THIS_DELETES_REPOSITORIES=1 is not set.');
  }
  if (input.typedFleetName !== expectedFleetName) {
    missing.push(`typed fleet-name confirmation did not exactly match "${expectedFleetName}" (got "${input.typedFleetName}").`);
  }
  return { allowed: missing.length === 0, missing };
}

// --- destroy's age-key-shred opt-in (pure) ---

export interface ShredRequestInput {
  readonly shredRequested: boolean;
  readonly identityPath: string | undefined;
}

export interface ShredRequestDecision {
  /** `true` only when the operator explicitly opted in AND supplied a path — see module doc: never guess, never imply. */
  readonly proceed: boolean;
  /** Present when `shredRequested` but `identityPath` is missing — a refusal, not a silent no-op. */
  readonly reason?: string;
}

/** Pure — never touches the filesystem. See `age-key-shred.ts` for the real shred primitive this gate authorizes calling. */
export function evaluateShredRequest(input: ShredRequestInput): ShredRequestDecision {
  if (!input.shredRequested) return { proceed: false };
  if (input.identityPath === undefined || input.identityPath.length === 0) {
    return {
      proceed: false,
      reason: '--shred-age-key was passed without --age-identity <path> — refusing to guess a key location. Nothing was shredded.',
    };
  }
  return { proceed: true };
}

// --- destroy's repo-deletion execute (mutating, irreversible) ---

export interface RepoDestroyOutcome {
  readonly repo: string;
  /** `'already-absent'` — groundnuty/macf#917 — see `repo-destroy.ts::realDeleteRepo`'s doc for the idempotency ruling this status carries through. */
  readonly status: 'deleted' | 'already-absent' | 'failed';
  readonly reason?: string;
}

export interface DestroyRepoDeps {
  readonly deleteRepo: DeleteRepoFn;
}

/** Delete every target repo. NEVER throws — same per-target failure isolation as `executeArchiveRepos`/`executeDeactivate`. Pushes `deps.deleteRepo`'s own result directly (`'deleted'` or `'already-absent'`) rather than assuming success, same shape as `executeDeactivate`'s `deleteRegistryVariable` call. */
export async function executeDestroyRepos(repos: readonly string[], deps: DestroyRepoDeps): Promise<readonly RepoDestroyOutcome[]> {
  const out: RepoDestroyOutcome[] = [];
  for (const repo of repos) {
    try {
      const status = await deps.deleteRepo(repo);
      out.push({ repo, status });
    } catch (err) {
      out.push({ repo, status: 'failed', reason: errMessage(err) });
    }
  }
  return out;
}

export type DestroyExecuteDeps = Pick<TeardownVariableDeps, 'deleteRegistryVariable'> & DestroyRepoDeps & AppDeletionDeps;

export interface DestroyExecuteResult {
  readonly registryOutcomes: readonly VariableTeardownOutcome[];
  readonly appOutcomes: readonly AppDeletionOutcome[];
  readonly repoOutcomes: readonly RepoDestroyOutcome[];
}

/**
 * Execute destroy's mutating rungs — registry deletion, the App-identity
 * report, then repo DELETION (never archive). Caller MUST have already
 * confirmed `plan.gate.allowed` AND obtained ALL THREE destroy
 * acknowledgments before calling this — this function performs no gating of
 * its own (same "gate lives at the orchestration layer above the execute
 * step" split every other execute function in this package follows).
 */
export async function executeDestroy(
  manifest: FleetManifest,
  plan: DestroyPlan,
  log: (line: string) => void,
  deps: DestroyExecuteDeps,
): Promise<DestroyExecuteResult> {
  const registryOutcomes = await executeDeactivate(manifest, plan.registryTargets, deps);
  const appOutcomes = await reportAppIdentityRemoval(manifest.owner, plan.appTargets, log, deps);
  const repoOutcomes = await executeDestroyRepos(plan.repoTargets, deps);
  return { registryOutcomes, appOutcomes, repoOutcomes };
}
