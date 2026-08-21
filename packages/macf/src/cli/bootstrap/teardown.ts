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
 * ## Agent-owned slots are stopped-then-deregistered, never deleted out from
 * under a live owner (groundnuty/macf#1033)
 *
 * `deactivate` used to delete every `agent_registration` target directly,
 * even while the agent was still running — a live agent never re-asserts
 * its own registration (it has no reason to, and no signal that its slot
 * was removed), so the fleet was left with every agent alive, healthy, and
 * invisible to routing. The operator's fix (issue #1033, reframed twice
 * before landing here) is ownership, not reconciliation: a fleet command
 * must not reach into a value the AGENT owns while the agent is alive.
 * {@link deactivateAgentTarget} asks a live agent to exit gracefully and
 * lets its own instance-id-guarded `shutdown.ts` deregister (DR-031,
 * groundnuty/macf#627) clear the slot; direct deletion survives ONLY as
 * the fallback for a target with no live owner. See that function's doc
 * for the full state machine + the mechanism this reuses (never invents).
 * DR-044's fleet/agent split is why an agent this host cannot discover is
 * `'unknown'`, never assumed dead — a fleet may span hosts (#1018).
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
 *   `already-archived` / `failed` for repos — groundnuty/macf#917) is
 *   returned, never swallowed; the CLI layer's exit
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

/**
 * `groundnuty/macf#1033` — a `deactivate` target's own reachability, from
 * THIS host only. `'alive'` = a live tmux session is discoverable for the
 * role (DR-037's `FleetDriver` local-only workspace scan, Amendment D);
 * `'dead'` = the workspace is discoverable but has no live session;
 * `'unknown'` = this host cannot discover a workspace for the role AT ALL
 * — it may be running on a DIFFERENT host (a fleet may span hosts, #1018),
 * and DR-037 Amendment D states `FleetDriver` discovery is local-only BY
 * CONSTRUCTION, never a cross-host claim. `'unknown'` must NEVER be treated
 * as `'dead'` — that would license the direct-delete fallback against a
 * possibly-live owner on another host, exactly the defect #1033 reports.
 */
export type AgentReachability = 'alive' | 'dead' | 'unknown';

/**
 * `groundnuty/macf#1033` — which of the four pathways an `agent_registration`
 * target went through. Exhaustive over every reachable outcome (including
 * the graceful-exit-requested-but-unconfirmed edge state, which the issue's
 * three named categories don't literally cover but which IS reachable in
 * practice — see `deactivateAgentTarget`'s doc) so a `deactivate` report's
 * per-category counts always sum to the agent-target count.
 */
export type AgentStopCategory = 'stopped-self-deregistered' | 'deregistered-directly' | 'unreachable' | 'stop-unconfirmed';

export interface VariableTeardownOutcome {
  readonly target: DeactivateTarget;
  readonly status: 'deleted' | 'already-absent' | 'failed' | 'self-deregistered' | 'unreachable';
  readonly reason?: string;
  /** Present ONLY for `target.kind === 'agent_registration'` — see {@link AgentStopCategory}. */
  readonly agentStopCategory?: AgentStopCategory;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `groundnuty/macf#1033` — the side effects `deactivateAgentTarget` needs to
 * gracefully stop a LIVE agent instead of deleting its registry slot out
 * from under it. Deliberately split into small, individually-fakeable
 * primitives (never a bundled "stopAgent" verb) so the STATE-MACHINE
 * (`deactivateAgentTarget`) stays pure orchestration, unit-testable with
 * hand-built fakes — same posture as every other dep bag in this module.
 *
 * **Mechanism, and why this one:** the operator's own reframing on the
 * issue is the design — `deactivate` must STOP the agent and let it
 * deregister ITSELF via the ALREADY-EXISTING instance-id-guarded path
 * (`macf-channel-server`'s `shutdown.ts`, DR-031/#627), not reach into a
 * value it does not own. The candidates considered (issue body): (1)
 * `restart-self` (DR-031 piece 3) — REJECTED, its entire design is to
 * RELAUNCH after killing the session (a detached relauncher is spawned
 * BEFORE the kill specifically so the agent comes back up) — the opposite
 * of what `deactivate` wants, and repurposing it would mean either fighting
 * its relaunch machinery or forking it, neither of which is "reuse." (2)
 * The canonical tmux session name + `tmux-send-to-claude.sh` submit
 * primitive (DR-037's `FleetDriver`, already used by `inject`/`isBusy`) —
 * CHOSEN: submitting the literal `/exit` slash command is the Claude Code
 * TUI's own normal-exit path, and `shutdown.ts`'s own module doc names
 * `/exit` explicitly as the trigger for its stdin `'end'`/`'close'`
 * graceful-deregister wiring ("A normal TUI exit (`/exit`, or
 * SIGTERM-to-the-TUI) does NOT deliver a SIGTERM/SIGINT to this process —
 * it only sees its stdin reach EOF"); `fleet reconcile`'s own description
 * separately treats `last-exit==0 /exit` as the recognized clean-shutdown
 * signature. No new mechanism is invented — `requestGracefulExit`'s real
 * implementation (`fleet-teardown.ts`) is the SAME `discover` +
 * `readConfig` + `hasSession` + `submit` seam quartet `vm-driver.ts`'s
 * `isBusy`/`inject` already compose, just without minting a registry token
 * (this command needs no `listPeers`/`probeHealth`).
 *
 * **Verified live (groundnuty/macf#1033, 2026-08-20):** the one prior
 * open question — whether `/exit` typed through `tmux-send-to-claude.sh`'s
 * double-Enter submit pattern (built for free-text prompts) actually
 * dispatches as a slash command rather than sitting in the input buffer or
 * being read as prose — was run against a real live agent: the tmux
 * session went away AND the channel-server process exited, confirming the
 * submit dispatches as intended. This module's own worktree still never
 * touches a live fleet (the decisive unit test below asserts the same
 * contract against fakes), but the mechanism itself is no longer an
 * open assumption.
 */
export interface TeardownAgentDeps {
  readonly checkAgentReachability: (role: string) => Promise<AgentReachability>;
  /**
   * Ask a LIVE agent to exit gracefully. ONLY ever called after
   * `checkAgentReachability` returned `'alive'`. NEVER a signal, NEVER
   * `tmux kill-session` — see this interface's doc for the mechanism.
   */
  readonly requestGracefulExit: (role: string) => Promise<void>;
  /** Sleep between deregister-poll attempts — injected so tests never wait in real time. */
  readonly sleep: (ms: number) => Promise<void>;
}

/** `deactivateAgentTarget`'s poll budget for a live agent's self-deregister, attempt-count-based (never `Date.now()` — keeps the state machine deterministic under fakes). */
export const DEFAULT_AGENT_STOP_GRACE_TIMEOUT_MS = 30_000;
export const DEFAULT_AGENT_STOP_POLL_INTERVAL_MS = 2_000;

export interface DeactivateAgentStopOptions {
  /** Total budget to wait for a live agent's self-deregister (default {@link DEFAULT_AGENT_STOP_GRACE_TIMEOUT_MS}). */
  readonly graceTimeoutMs?: number;
  /** Interval between presence polls within the budget (default {@link DEFAULT_AGENT_STOP_POLL_INTERVAL_MS}). */
  readonly pollIntervalMs?: number;
}

/**
 * The `groundnuty/macf#1033` state machine for ONE `agent_registration`
 * target — never called for `ca_registry`/`federated_cas` targets (those
 * have no owning agent to stop; `executeDeactivate` routes them straight
 * to the direct-delete path unchanged). Four reachable outcomes:
 *
 * - **`'unknown'` reachability** → `'unreachable'` — the direct-delete seam
 *   is NEVER called (module doc: "never assumed stopped").
 * - **`'dead'` reachability** → the pre-existing direct-delete FALLBACK
 *   (`'deregistered-directly'`) — a stale slot with no live owner is
 *   exactly what that path is for (issue requirement 3).
 * - **`'alive'` reachability, self-deregisters within the grace budget** →
 *   `'stopped-self-deregistered'` — the decisive case: `deleteRegistryVariable`
 *   is NEVER called for this target; the registry key going absent is
 *   entirely the agent's own `shutdown.ts` deregister.
 * - **`'alive'` reachability, does NOT self-deregister within the grace
 *   budget** → `'stop-unconfirmed'`, `status: 'failed'`. Deliberately NOT
 *   folded into a direct-delete fallback: the agent asked-but-unconfirmed
 *   is still POSSIBLY alive (busy, slow, or the `/exit` submission failed
 *   silently) — deleting its slot here would re-risk exactly the "delete
 *   out from under a live owner" defect #1033 reports. Surfaced loud
 *   instead (module doc's "report what could not be done, never exit
 *   green" rail) so the operator investigates rather than the command
 *   guessing.
 */
async function deactivateAgentTarget(
  manifest: FleetManifest,
  target: DeactivateTarget,
  role: string,
  deps: Pick<TeardownVariableDeps, 'deleteRegistryVariable' | 'checkRegistryPresence'> & TeardownAgentDeps,
  graceTimeoutMs: number,
  pollIntervalMs: number,
): Promise<VariableTeardownOutcome> {
  let reachability: AgentReachability;
  try {
    reachability = await deps.checkAgentReachability(role);
  } catch {
    // A reachability-check FAILURE is not evidence of death — degrade to
    // 'unknown' (DR-044's honest-unknown-over-false-present spirit) rather
    // than risk the direct-delete fallback against a possibly-live owner.
    reachability = 'unknown';
  }

  if (reachability === 'unknown') {
    return { target, status: 'unreachable', agentStopCategory: 'unreachable' };
  }

  if (reachability === 'dead') {
    try {
      const status = await deps.deleteRegistryVariable(manifest.owner.registry, target.name);
      return { target, status, agentStopCategory: 'deregistered-directly' };
    } catch (err) {
      return { target, status: 'failed', reason: errMessage(err), agentStopCategory: 'deregistered-directly' };
    }
  }

  // reachability === 'alive' — the graceful path (#1033's decisive case).
  try {
    await deps.requestGracefulExit(role);
  } catch (err) {
    return {
      target,
      status: 'failed',
      reason: `graceful-exit request failed: ${errMessage(err)}`,
      agentStopCategory: 'stop-unconfirmed',
    };
  }

  const maxAttempts = Math.max(1, Math.ceil(graceTimeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await deps.sleep(pollIntervalMs);
    let presence: Presence;
    try {
      presence = await deps.checkRegistryPresence(manifest.owner.registry, target.name);
    } catch {
      presence = 'unknown';
    }
    if (presence === 'absent') {
      // The agent's OWN instance-id-guarded deregister cleared this — we
      // never called deleteRegistryVariable for it (the decisive assertion).
      return { target, status: 'self-deregistered', agentStopCategory: 'stopped-self-deregistered' };
    }
  }

  return {
    target,
    status: 'failed',
    reason:
      `requested a graceful exit but the agent did not self-deregister within ${String(graceTimeoutMs)}ms — ` +
      'never deleted directly under a possibly-live owner.',
    agentStopCategory: 'stop-unconfirmed',
  };
}

/**
 * Delete every target by EXACT KEY. NEVER throws — each target's own
 * failure resolves to `status: 'failed'` with a reason, so one bad key
 * cannot abort the rest of the run (the caller reports failures, never
 * exits green on any — module doc's "report what could not be done" rail).
 *
 * `groundnuty/macf#1033` — `agent_registration` targets are routed through
 * {@link deactivateAgentTarget}'s stop-then-verify-else-fallback state
 * machine instead of the direct delete; `ca_registry`/`federated_cas`
 * targets (no owning agent) are unchanged.
 */
export async function executeDeactivate(
  manifest: FleetManifest,
  targets: readonly DeactivateTarget[],
  deps: Pick<TeardownVariableDeps, 'deleteRegistryVariable' | 'checkRegistryPresence'> & TeardownAgentDeps,
  opts?: DeactivateAgentStopOptions,
): Promise<readonly VariableTeardownOutcome[]> {
  const graceTimeoutMs = opts?.graceTimeoutMs ?? DEFAULT_AGENT_STOP_GRACE_TIMEOUT_MS;
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_AGENT_STOP_POLL_INTERVAL_MS;
  const out: VariableTeardownOutcome[] = [];
  for (const target of targets) {
    if (target.kind === 'agent_registration' && target.role !== undefined) {
      out.push(await deactivateAgentTarget(manifest, target, target.role, deps, graceTimeoutMs, pollIntervalMs));
      continue;
    }
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
  readonly status: 'archived' | 'already-archived' | 'failed';
  readonly reason?: string;
}

export interface TeardownRepoArchiveDeps {
  /**
   * Reuses `TeardownControlRepoDeps.checkMeta`'s EXACT shape (same
   * `checkControlRepoMeta` primitive in production) — the state-read this
   * rung needs is identical to the one `resolveControlRepoOwnership` already
   * performs for the control repo, just applied per-repo here. Naming the
   * field `checkMeta` (not a second, differently-named field) means a single
   * deps bag that already satisfies `TeardownControlRepoDeps` (every
   * production caller's deps object does) satisfies this interface too, with
   * nothing new to wire.
   */
  readonly checkMeta: (repo: string) => Promise<ControlRepoMeta>;
  readonly archiveRepo: (repo: string) => Promise<void>;
}

/**
 * Archive every target repo — reading each repo's CURRENT `archived` state
 * FIRST and skipping the PATCH entirely when it's already `true`
 * (groundnuty/macf#917). GitHub 403s a `PATCH archived=true` against an
 * ALREADY-archived repo ("Repository was archived so is read-only") because
 * an archived repo is read-only for every write, including a redundant
 * re-set of the SAME value — but 403 is an overloaded status (a genuine
 * permission failure produces the identical code), so classifying it from
 * the error response would be guessing at cause, not asserting it. The
 * `.archived` read is the actual result-invariant (Pattern A,
 * `silent-fallback-hazards.md`) — `deps.archiveRepo` (the PATCH) is
 * therefore NEVER called once the read confirms `archived === true`.
 *
 * This is what makes Amendment G's cumulative ladder
 * (`deactivate` → `archive` → `delete-apps`) actually walk end to end in one
 * sitting: `delete-apps` re-runs THIS SAME function over the SAME repo
 * targets `archive` just processed (`teardown-destructive.ts`'s
 * `executeDeleteApps`), so without this read every real ladder walk would
 * 403 on its second rung — which is exactly the failure observed on a live
 * teardown that motivated this fix. A `presence !== 'present'` or
 * `archived !== true` read (including `'unknown'`, e.g. a transient network
 * hiccup on the check itself) falls through to attempting the PATCH as
 * before — this function never REFUSES on an inconclusive read, it only
 * SKIPS on a confirmed one. NEVER throws — same per-target failure isolation
 * as {@link executeDeactivate}.
 */
export async function executeArchiveRepos(
  repos: readonly string[],
  deps: TeardownRepoArchiveDeps,
): Promise<readonly RepoArchiveOutcome[]> {
  const out: RepoArchiveOutcome[] = [];
  for (const repo of repos) {
    try {
      const meta = await deps.checkMeta(repo);
      if (meta.presence === 'present' && meta.archived === true) {
        out.push({ repo, status: 'already-archived' });
        continue;
      }
      await deps.archiveRepo(repo);
      out.push({ repo, status: 'archived' });
    } catch (err) {
      out.push({ repo, status: 'failed', reason: errMessage(err) });
    }
  }
  return out;
}
