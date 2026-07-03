/**
 * The `FleetDriver` interface — the decision/driver boundary (DR-037 Decision 3).
 *
 * The fleet operational-layer has TWO layers and ONLY the bottom is
 * runtime-specific:
 *
 *   - **Decision layer** (runtime-agnostic): the reconcile HEAL ladder, the
 *     rolling-upgrade sequencer + verify-green, the busy-gate DECISION, the
 *     tier-3 `alert` (a `gh issue create` — runtime-agnostic, so it stays in the
 *     decision layer, NOT on the driver). It NEVER touches `/proc`, tmux,
 *     `capture-pane`, or the K8s API — it drives off `probe()` (the `/health`
 *     self-report) and `discoverWorkspaces()`.
 *   - **Driver layer** (this interface): the ONLY place a runtime leaks. The
 *     decision layer branches on the reconcile tier and calls a driver verb —
 *     gated-inject → `inject`; graceful-restart → `restart`; cold-start →
 *     `launch`; roll → `upgrade`.
 *
 * **Hard rule (DR-037):** nothing runtime-specific leaks ABOVE the driver line.
 * The `agent` argument is the portable identity — the agent's ROUTING LABEL
 * (the registry key), stable across a VM tmux session, a macOS host, and a
 * far-future K8s pod. A VM driver resolves that name → workspace + tmux session
 * INTERNALLY (via `discoverWorkspaces()` + the workspace config); a K8s driver
 * resolves it → pod. That resolution is the driver's job, never the decision
 * layer's.
 *
 * The interface TYPE lives HERE in macf-core (DR-037 OQ2 — the runtime-and-CLI-
 * independent contract; it references `WorkspaceRecord`, already here). The
 * per-runtime driver BODIES live in `packages/macf` (the VM driver) or a future
 * package (the K8s macf-operator).
 */
import { MacfError } from './errors.js';
import type { WorkspaceRecord } from './discovery.js';
import type { HealthResponse } from './types.js';

/**
 * One agent's routing-plane state as `probe()` sees it: its registry endpoint,
 * reachability, self-reported framework version, and the raw `/health` body
 * (which carries `state` idle/busy, `instance_id`, `cert_expiry`, …). Portable —
 * a VM pin and a K8s pod image self-report identically through `/health`.
 */
export interface FleetAgentState {
  /** The agent's routing label (registry key). */
  readonly name: string;
  /** Registry-advertised host. */
  readonly host: string;
  /** Registry-advertised port. */
  readonly port: number;
  /** `/health` reachable (mTLS 2xx JSON) at the registry endpoint. */
  readonly online: boolean;
  /**
   * The agent's self-reported framework version (`/health.version`, macf#682),
   * or `null` when offline or reporting a body that predates the field. The
   * runtime-portable version source (DR-037 Decision 5) — NOT the VM-only pin.
   */
  readonly version: string | null;
  /** Raw `/health` body (incl. `state`/`otel`/`last_processed`), or null when offline. */
  readonly health: HealthResponse | null;
}

/**
 * The fleet's routing-plane snapshot — the roster plus each member's `/health`
 * self-report. Built by `FleetDriver.probe()`; consumed by the decision layer's
 * reconcile ladder + rolling-upgrade sequencer. A plain aggregate (computed from
 * live probes, not parsed from a wire), so it's a plain interface — not a Zod
 * schema — mirroring `FleetAgentStatus` in the VM `fleet status` command.
 */
export interface FleetState {
  readonly agents: readonly FleetAgentState[];
}

/**
 * A pluggable fleet driver (DR-037 Decision 3). The runtime-agnostic decision
 * layer calls these verbs; each concrete driver (VM, macOS, K8s) implements them
 * with runtime primitives WITHOUT leaking any of that runtime above this line.
 *
 * `probe` + `discoverWorkspaces` are the two READ views (routing plane +
 * host-operational plane, DR-037 Decision 1). The remaining verbs are the
 * MUTATIONS the reconcile/upgrade decision layer drives; the tier-3 `alert`
 * (a GH issue) is deliberately NOT here — it is runtime-agnostic and stays in
 * the decision layer so no GitHub concern leaks into the driver.
 */
export interface FleetDriver {
  /**
   * The routing-plane snapshot: the registry roster + each agent's mTLS
   * `/health` (version, idle/busy). Per-agent probe failures are isolated — a
   * single unreachable peer degrades to `online: false`, never aborts the probe.
   */
  readonly probe: () => Promise<FleetState>;

  /**
   * The host-operational plane's source (DR-037 Decision 4): the host's agent
   * workspaces, ALIVE ∪ DEAD, from the registry-free `.macf/`-marker filesystem
   * scan. VM-filesystem-specific (a K8s driver reads namespaces/labels), so it's
   * a driver method. Synchronous — a pure FS scan.
   */
  readonly discoverWorkspaces: () => readonly WorkspaceRecord[];

  /**
   * The aliveness/busy gate — `true` when the agent is actively working and MUST
   * NOT be restarted. VM: a `capture-pane` content-diff over a short window
   * (macf#128/#130; NOT `#{session_activity}`, which does not reliably advance on
   * a busy agent — the 2026-06-28 silent-fallback Pattern-C correction). A
   * DEAD/absent agent is not busy (safe to `launch`).
   */
  readonly isBusy: (agent: string) => Promise<boolean>;

  /**
   * The pre-flight config-dirty predicate (macf#722 Fix B) — `true` when the
   * agent's workspace has UNCOMMITTED changes on the roll's touched-config
   * surface (the macf#725 UNION: the macf-update overwrite set ∪ the
   * operator-evolution files — `claude.sh`, `.claude/rules/**`,
   * `.claude/scripts/**`, `.claude/settings.json`, the managed
   * `.claude/.macf/env.*` + `host-prelude.sh`, `CLAUDE.md`, `env.local.*` —
   * see `ROLL_TOUCHED_CONFIG_PATTERNS` in `fleet-upgrade.ts`, narrowed off a
   * `.claude/**` wildcard by DR-040 Decision 6 / macf#698). VM: `git status`
   * in the agent's workspace, filtered to that path set. A DEAD/absent agent
   * reads `false` (nothing to check; reconcile will launch it). Kept as a
   * boolean convenience alongside `listDirtyConfig` below — `rollFleet`'s
   * pre-flight gate itself calls `listDirtyConfig` (it needs the file list to
   * OBJECT with, macf#725), so this predicate form is for OTHER callers that
   * only need the yes/no answer.
   */
  readonly isConfigDirty: (agent: string) => Promise<boolean>;

  /**
   * The pre-flight config-dirty gate's LIST form (macf#725 — transactional
   * object-with-message revision). Same predicate surface as `isConfigDirty`
   * (`ROLL_TOUCHED_CONFIG_PATTERNS`, tracked-only), but returns the actual
   * uncommitted paths rather than a boolean. Empty array == clean
   * (equivalent to `isConfigDirty` reading `false`). VM: `git status
   * --porcelain` in the agent's workspace, filtered to that path set, one
   * path per line.
   *
   * **Superseded as `rollFleet`'s pre-flight call site by `classifyDirtyConfig`
   * below (DR-040 Decision 3 / macf#698 R1)** — the roll no longer treats
   * every dirty file as an OBJECT-worthy delta; it tiers them first. This
   * verb remains on the interface (still used internally by
   * `classifyDirtyConfig`'s real implementation, and by other callers that
   * only need the raw uncommitted-path list without tier classification).
   */
  readonly listDirtyConfig: (agent: string) => Promise<readonly string[]>;

  /**
   * The pre-flight config-dirty gate's TIERED form (DR-040 Decision 3 /
   * macf#698 R1 — this is what `rollFleet` actually calls now). Splits
   * `listDirtyConfig`'s raw uncommitted-path list into two tiers by
   * comparing each file's CURRENT (dirty) content against what `macf
   * update` would write for it right now (the canonical-compute primitive,
   * `packages/macf/src/cli/fleet/canonical-compute.ts`):
   *
   * - `alreadyCanonical` — the file's content already IS the canonical
   *   regen (the common case: a stale-branch workspace whose "dirty" files
   *   are exactly what a fresh `macf update` would produce — both code-agent
   *   AND science hit only this tier on the v0.2.48 roll). Safe to commit
   *   as-is; NEVER a genuine conflict.
   * - `genuineDelta` — a real local difference from canonical. Still
   *   requires the OBJECT-and-halt treatment `listDirtyConfig`'s callers
   *   used to apply to the WHOLE dirty list.
   *
   * Both arrays are empty when the agent has no dirty config surface at all
   * (mirrors `listDirtyConfig`'s empty-array-== -clean contract). VM: reuses
   * `listDirtyConfig` for the raw list, then classifies each path via
   * `classifyDirtyFile`.
   */
  readonly classifyDirtyConfig: (agent: string) => Promise<{
    readonly alreadyCanonical: readonly string[];
    readonly genuineDelta: readonly string[];
  }>;

  /**
   * Commit exactly `files` in the agent's workspace (DR-040 Decision 3 /
   * macf#698 R1) — the auto-resolve half of the tier-first gate. Called ONLY
   * with `classifyDirtyConfig`'s `alreadyCanonical` subset: those files are,
   * by construction, deterministic canonical content (not an arbitrary
   * commit), so committing them clears the false config-dirty signal
   * without any agent/operator involvement. A no-op when `files` is empty.
   * VM: `git add -- <files>` + `git commit` in the agent's workspace (a
   * no-op commit, i.e. nothing actually staged after `add`, is tolerated —
   * never throws on "nothing to commit").
   */
  readonly autoResolveCanonical: (agent: string, files: readonly string[]) => Promise<void>;

  /**
   * Read the agent's current pane content for stall-signature matching
   * (`macf fleet resume`, DR-037 / macf#686). VM: a single `tmux capture-pane`
   * of the live session; K8s: recent pod logs. Returns `null` when the agent has
   * NO live session / is unreadable (DEAD / gone — resume can't help it, so the
   * caller skips it and leaves it to `reconcile`'s launch). Runtime-specific (a
   * pane read), so it belongs on the driver — the decision layer stays pure by
   * matching the returned string against the allowlist.
   */
  readonly capturePane: (agent: string) => Promise<string | null>;

  /** Roll the agent's framework version. VM: `macf update` in its workspace. */
  readonly upgrade: (agent: string) => Promise<void>;

  /**
   * Restart the agent. VM: `macf restart-self` when ALIVE (graceful — stash +
   * detached relaunch), or `launch` when DEAD. K8s: cycle the pod.
   *
   * `opts.leaveConfigUncommitted` (macf#725 — transactional revision, replaces
   * the earlier unconditional-`forceStashConfig` shape): set ONLY by `rollFleet`
   * on the restart that immediately follows an `upgrade` in the SAME roll. The
   * roll's pre-flight `listDirtyConfig` gate already guaranteed the config
   * surface was clean BEFORE `upgrade` ran; the ONLY dirt an upgrade can leave
   * behind is `macf update`'s OWN regeneration of the managed surface — which is
   * supposed to change and must never be silently stashed away (the relaunched
   * agent needs to SEE it via `git status`). So this tells `restart-self` to
   * relaunch WITHOUT stashing AND WITHOUT refusing on its own post-upgrade
   * config-dirty guard — it maps to `restart-self`'s `--leave-config-uncommitted`
   * flag / `MACF_RESTART_LEAVE_CONFIG_UNCOMMITTED=1`. Omitted (default false,
   * i.e. the STANDALONE guard stays fully active) for every OTHER caller (e.g. a
   * direct operator `macf restart-self` invocation, or `fleet-reconcile`'s
   * healing ladder), which never bypasses the config-dirty gate because it never
   * checks it in the first place.
   */
  readonly restart: (agent: string, opts?: { readonly leaveConfigUncommitted?: boolean }) => Promise<void>;

  /**
   * The tier-1 gated nudge — deliver `text` into the agent's live turn loop.
   * VM: the canonical `tmux-send-to-claude` submit pattern. Runtime-specific.
   */
  readonly inject: (agent: string, text: string) => Promise<void>;

  /** Cold-start a desired-but-down agent. VM: spawn its `./claude.sh`. */
  readonly launch: (agent: string) => Promise<void>;

  /**
   * List the agent's currently-modified files (macf#725) — used AFTER a
   * successful `upgrade` to report what `macf update` regenerated in the
   * relaunched agent's workspace, so the roll's post-upgrade message can name
   * them explicitly. VM: `git status --porcelain` (all tracked changes, not
   * scoped to the config-surface patterns — `macf update` can also touch pins /
   * other managed files outside that surface). Best-effort: an inspection
   * failure returns an empty list rather than throwing (never blocks reporting
   * on a diagnostic-only read).
   */
  readonly listModifiedFiles: (agent: string) => Promise<readonly string[]>;
}

/**
 * A fleet-driver operation failed against a resolvable target — most commonly an
 * `agent` name that matches no discovered workspace on this host (so the driver
 * cannot resolve its workspace / session). Runtime-agnostic (every driver shares
 * it), so it lives in macf-core beside the interface.
 */
export class FleetDriverError extends MacfError {
  constructor(message: string) {
    super('FLEET_DRIVER_ERROR', message);
    this.name = 'FleetDriverError';
  }
}
