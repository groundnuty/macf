/**
 * `macf fleet deactivate` / `macf fleet archive` — the REVERSIBLE half of
 * DR-043 Amendment G's fleet teardown ladder (groundnuty/macf#867).
 * `delete-apps` / `destroy` (the irreversible rungs) are explicitly OUT OF
 * SCOPE for this module — see Amendment G's "friction is the feature"
 * section for why those need a separate, harder-to-reach command, never a
 * flag on this one.
 *
 * Pure orchestration over injected deps — same posture as `apply-fleet.ts`:
 * no direct `gh` calls live here, only calls through {@link TeardownDeps},
 * so the SEQUENCING (what's targeted, what's refused, what's attempted) is
 * unit-testable with zero real I/O.
 *
 * ## `deactivate` is deregistration, not housekeeping
 *
 * Removes ONLY the fleet's org/account-scope registry presence — the
 * `<SEG>_CA_CERT` registry leg, the per-agent `<SEG>_AGENT_<ROLE-SEG>`
 * registrations, and `<SEG>_FEDERATED_CAS`. It NEVER touches repo-scoped
 * variables or secrets (Amendment G, operator correction 2026-08-12):
 * those travel with an archived repo, harm nothing sitting there, and
 * deleting them only makes revival more expensive. Removing the registry
 * presence is what makes a fleet INACTIVE — the registry is how agents are
 * discovered and how routing resolves a target; strip it and the fleet
 * stops being addressable while every durable artifact (the vault, the
 * repos, the Apps) survives untouched.
 *
 * ## Exact-key targeting — the highest-stakes rail in this module
 *
 * {@link computeDeactivateTargets} derives the target set from `fleet.yaml`
 * (+ implicitly `fleet.lock`, since every role in `manifest.agents` was, if
 * ever provisioned, registered under the SAME derivation) by EXACT KEY,
 * never a `<SEG>_`-prefix sweep. This matters more here than anywhere else
 * in the codebase: `deactivate`'s targets are ORG/ACCOUNT-SCOPE entries in
 * a namespace SHARED WITH EVERY OTHER FLEET on that account/org — a
 * prefix-based sweep (e.g. "delete every `MACF_EXPERIMENT_*` variable")
 * could delete a SIBLING fleet's registration (`macf-experiment-two`'s
 * `MACF_EXPERIMENT_TWO_AGENT_CODE_AGENT` is a DIFFERENT variable than
 * `macf-experiment`'s own, but a naive prefix match on `MACF_EXPERIMENT`
 * would catch the substring). This is silent-fallback Instance 20's write
 * face (`silent-fallback-hazards.md`) — derive the subject, never scan.
 *
 * **The agent-registration key formula is NOT the DR's own prose shorthand
 * `MACF_<PROJECT>_AGENT_<NAME>`.** The literal writer
 * (`@groundnuty/macf-core`'s `registry.ts::createRegistry`) computes
 * `${toVariableSegment(project)}_AGENT_${toVariableSegment(agentName)}` —
 * no separate `MACF_` prefix is ever prepended; for the substrate project
 * `macf` the two readings happen to coincide (`toVariableSegment('macf')`
 * is `'MACF'`), which is almost certainly why the DR's shorthand reads the
 * way it does. For any OTHER project (`macf-experiment` →
 * `MACF_EXPERIMENT_AGENT_<NAME>`, never `MACF_MACF_EXPERIMENT_AGENT_<NAME>`)
 * the two readings diverge. {@link agentRegistrationVariableName} below
 * mirrors the REAL formula, and `teardown.test.ts` pins it against the
 * ACTUAL `createRegistry` (not re-derived from prose) — see that test's
 * doc for why.
 *
 * ## `archive` = `deactivate` + repo archiving
 *
 * {@link computeArchiveRepoTargets} adds the control repo (derived the same
 * way `control-repo.ts::controlRepoFullName` does) plus every agent's
 * `repo` field. Amendment G frames the rungs as CUMULATIVE by CHOICE, not
 * by constraint — an archived-but-still-registered fleet would be
 * incoherent (the registry advertising addressable agents whose repos are
 * frozen read-only), so `archive` always includes `deactivate`'s work. The
 * two verbs are otherwise ORDER-INDEPENDENT on the teardown path (registry
 * vars vs repo archived-state don't interact) — the CLI layer runs them in
 * the same call for `archive`, but nothing here depends on which happens
 * first.
 *
 * ## Shared rails (both verbs)
 *
 * - **Inventory before mutation** — {@link buildTeardownPlan} is READ-ONLY
 *   (ownership classification + a presence read per target); the CLI layer
 *   renders it, gets confirmation, THEN calls the `execute*` functions.
 * - **Refuse a foreign control repo** — {@link evaluateTeardownGate} allows
 *   ONLY `ours` / `ours-archived` ownership (reusing
 *   `control-repo.ts::classifyControlRepoOwnership`, the same name-match
 *   classifier `apply` uses). `absent` / `foreign` / `unknown` all refuse —
 *   teardown cannot be aimed at another fleet's control plane, and an
 *   unconfirmed ownership read is not a green light to mutate ANYTHING.
 *   `ours-archived` is explicitly ALLOWED (not folded into the refusal) —
 *   re-running `archive` against an already-archived fleet must stay
 *   idempotent, and `deactivate` on an archived fleet is a legitimate,
 *   order-independent step of the ladder.
 * - **Report what could not be done, never exit green** — every outcome
 *   (`deleted` / `already-absent` / `failed` for variables; `archived` /
 *   `failed` for repos) is returned, never swallowed; the CLI layer's exit
 *   code is non-zero on ANY `failed` entry.
 */
import { toVariableSegment } from '@groundnuty/macf-core';
import type { RegistryConfig } from '@groundnuty/macf-core';
import type { FleetManifest } from './fleet-manifest.js';
import type { ControlRepoMeta, ControlRepoOwnership } from './control-repo.js';
import { classifyControlRepoOwnership, controlRepoFullName } from './control-repo.js';
import type { Presence } from './plan.js';
import type { DeleteVariableResult } from './variable-write.js';

// --- Exact-key target derivation (pure) ---

export type DeactivateTargetKind = 'ca_registry' | 'agent_registration' | 'federated_cas';

export interface DeactivateTarget {
  readonly kind: DeactivateTargetKind;
  /** The exact GitHub Actions registry-scope variable name — never a pattern. */
  readonly name: string;
  /** Present only for `kind === 'agent_registration'`. */
  readonly role?: string;
}

/** `<SEG>_CA_CERT` — the SAME derivation `apply-ca.ts::caCertVariableName` uses. Duplicated as a one-line literal rather than imported to keep this module's only cross-module data dependency on `control-repo.ts` (for ownership); see module doc for why the formula is pinned by test, not by cross-import, for the agent-registration case. */
function caRegistryVariableName(fleetName: string): string {
  return `${toVariableSegment(fleetName)}_CA_CERT`;
}

/**
 * Mirrors `@groundnuty/macf-core`'s `registry.ts::createRegistry`'s
 * `variableName` closure EXACTLY — see module doc's "exact-key targeting"
 * section for why this is NOT the DR's own `MACF_<PROJECT>_AGENT_<NAME>`
 * shorthand read literally. `role` is DR-032's "name" shape already (the
 * routing label an agent registers itself under — `fleet-manifest.ts`'s
 * module doc), so it is exactly the `agentName` `createRegistry` expects.
 */
function agentRegistrationVariableName(fleetName: string, role: string): string {
  return `${toVariableSegment(fleetName)}_AGENT_${toVariableSegment(role)}`;
}

/** `<SEG>_FEDERATED_CAS` — DR-041 Amendment B's UNION-target variable. Nothing in this codebase writes it yet (federation reconcile is day-2 / `plan.ts`'s `skippedSections`), so this target is expected to read `already-absent` on every fleet today — see `variable-write.ts::realDeleteVariable`'s doc for why that is NOT a failure. */
function federatedCasVariableName(fleetName: string): string {
  return `${toVariableSegment(fleetName)}_FEDERATED_CAS`;
}

/**
 * The exact, ordered target set for `deactivate` — CA registry leg, then
 * every agent's registration (manifest `agents[]` order), then the
 * federated-CAs union var. Pure; no I/O, no presence check (that is
 * {@link computeDeactivateInventory}'s job, separately, so a caller can
 * show inventory before committing to execute).
 */
export function computeDeactivateTargets(manifest: FleetManifest): readonly DeactivateTarget[] {
  const fleetName = manifest.metadata.name;
  const targets: DeactivateTarget[] = [{ kind: 'ca_registry', name: caRegistryVariableName(fleetName) }];
  for (const agent of manifest.agents) {
    targets.push({ kind: 'agent_registration', role: agent.role, name: agentRegistrationVariableName(fleetName, agent.role) });
  }
  targets.push({ kind: 'federated_cas', name: federatedCasVariableName(fleetName) });
  return targets;
}

/** `<fleet>-control` + every agent's `repo` — the full repo-archive target set for `archive`. Pure. */
export function computeArchiveRepoTargets(manifest: FleetManifest): readonly string[] {
  return [controlRepoFullName(manifest), ...manifest.agents.map((a) => a.repo)];
}

// --- Ownership gate (shared rail) ---

export interface TeardownGate {
  readonly allowed: boolean;
  readonly ownership: ControlRepoOwnership;
  /** Present when `allowed === false` — the operator-facing refusal reason. */
  readonly reason?: string;
}

/**
 * `ours` and `ours-archived` are the ONLY allowed ownership kinds — see
 * module doc's "Refuse a foreign control repo" rail. `absent` refuses too:
 * teardown has no confident evidence this `fleet.yaml` corresponds to a
 * real macf-bootstrap-managed fleet at all without a control repo to check
 * against.
 */
export function evaluateTeardownGate(manifest: FleetManifest, ownership: ControlRepoOwnership): TeardownGate {
  switch (ownership.kind) {
    case 'ours':
    case 'ours-archived':
      return { allowed: true, ownership };
    case 'absent':
      return {
        allowed: false,
        ownership,
        reason:
          `no control repo found for fleet "${manifest.metadata.name}" — nothing to tear down (this fleet may ` +
          'never have been provisioned via `macf bootstrap apply`, or the manifest points at the wrong fleet).',
      };
    case 'foreign':
      return { allowed: false, ownership, reason: `refusing — the control repo is not this fleet's own: ${ownership.reason}` };
    case 'unknown':
      return {
        allowed: false,
        ownership,
        reason: 'could not confirm control-repo ownership (auth / network / rate-limit) — refusing teardown without a confident read.',
      };
  }
}

export interface TeardownControlRepoDeps {
  readonly checkMeta: (repo: string) => Promise<ControlRepoMeta>;
  readonly readManifestFile: (repo: string) => Promise<string | undefined>;
}

/** Classify THIS fleet's control-repo ownership — the read `evaluateTeardownGate` consumes. Reuses `control-repo.ts::classifyControlRepoOwnership` (the SAME name-match classifier `apply` uses), so teardown and apply agree on "is this our fleet" by construction. */
export async function resolveControlRepoOwnership(manifest: FleetManifest, deps: TeardownControlRepoDeps): Promise<ControlRepoOwnership> {
  const repo = controlRepoFullName(manifest);
  const meta = await deps.checkMeta(repo);
  const manifestFileContent = meta.presence === 'present' ? await deps.readManifestFile(repo) : undefined;
  return classifyControlRepoOwnership(meta, manifestFileContent, manifest);
}

// --- Inventory (read-only) ---

export interface DeactivateInventoryEntry {
  readonly target: DeactivateTarget;
  readonly presence: Presence;
}

export interface TeardownVariableDeps {
  readonly checkRegistryPresence: (registry: RegistryConfig, name: string) => Promise<Presence>;
  readonly deleteRegistryVariable: (registry: RegistryConfig, name: string) => Promise<DeleteVariableResult>;
}

/** Read-only presence check per target — shown to the operator before any mutation (the DR-035 §4 plan-approve-once shape, applied to teardown). */
export async function computeDeactivateInventory(
  manifest: FleetManifest,
  targets: readonly DeactivateTarget[],
  deps: Pick<TeardownVariableDeps, 'checkRegistryPresence'>,
): Promise<readonly DeactivateInventoryEntry[]> {
  const out: DeactivateInventoryEntry[] = [];
  for (const target of targets) {
    out.push({ target, presence: await deps.checkRegistryPresence(manifest.owner.registry, target.name) });
  }
  return out;
}

export interface DeactivatePlan {
  readonly fleet: string;
  readonly gate: TeardownGate;
  readonly targets: readonly DeactivateTarget[];
  /** Empty when `gate.allowed === false` — nothing is read past a refused gate. */
  readonly inventory: readonly DeactivateInventoryEntry[];
}

/** Compose the full read-only `deactivate` plan: gate + exact targets + inventory. NEVER mutates anything. */
export async function buildDeactivatePlan(
  manifest: FleetManifest,
  deps: TeardownControlRepoDeps & Pick<TeardownVariableDeps, 'checkRegistryPresence'>,
): Promise<DeactivatePlan> {
  const ownership = await resolveControlRepoOwnership(manifest, deps);
  const gate = evaluateTeardownGate(manifest, ownership);
  const targets = computeDeactivateTargets(manifest);
  const inventory = gate.allowed ? await computeDeactivateInventory(manifest, targets, deps) : [];
  return { fleet: manifest.metadata.name, gate, targets, inventory };
}

export interface ArchivePlan extends DeactivatePlan {
  readonly repoTargets: readonly string[];
}

/** `buildDeactivatePlan` + the repo-archive target set (empty when the gate refused). */
export async function buildArchivePlan(
  manifest: FleetManifest,
  deps: TeardownControlRepoDeps & Pick<TeardownVariableDeps, 'checkRegistryPresence'>,
): Promise<ArchivePlan> {
  const base = await buildDeactivatePlan(manifest, deps);
  return { ...base, repoTargets: base.gate.allowed ? computeArchiveRepoTargets(manifest) : [] };
}

// --- Execute (mutating) ---

export interface VariableTeardownOutcome {
  readonly target: DeactivateTarget;
  readonly status: 'deleted' | 'already-absent' | 'failed';
  readonly reason?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Delete every target by EXACT KEY. NEVER throws — each target's own
 * failure resolves to `status: 'failed'` with a reason, so one bad key
 * cannot abort the rest of the run (the caller reports failures, never
 * exits green on any — module doc's "report what could not be done" rail).
 */
export async function executeDeactivate(
  manifest: FleetManifest,
  targets: readonly DeactivateTarget[],
  deps: Pick<TeardownVariableDeps, 'deleteRegistryVariable'>,
): Promise<readonly VariableTeardownOutcome[]> {
  const out: VariableTeardownOutcome[] = [];
  for (const target of targets) {
    try {
      const status = await deps.deleteRegistryVariable(manifest.owner.registry, target.name);
      out.push({ target, status });
    } catch (err) {
      out.push({ target, status: 'failed', reason: errMessage(err) });
    }
  }
  return out;
}

export interface RepoArchiveOutcome {
  readonly repo: string;
  readonly status: 'archived' | 'failed';
  readonly reason?: string;
}

export interface TeardownRepoArchiveDeps {
  readonly archiveRepo: (repo: string) => Promise<void>;
}

/** Archive every target repo. NEVER throws — same per-target failure isolation as {@link executeDeactivate}. */
export async function executeArchiveRepos(
  repos: readonly string[],
  deps: TeardownRepoArchiveDeps,
): Promise<readonly RepoArchiveOutcome[]> {
  const out: RepoArchiveOutcome[] = [];
  for (const repo of repos) {
    try {
      await deps.archiveRepo(repo);
      out.push({ repo, status: 'archived' });
    } catch (err) {
      out.push({ repo, status: 'failed', reason: errMessage(err) });
    }
  }
  return out;
}
