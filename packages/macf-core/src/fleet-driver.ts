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

  /** Roll the agent's framework version. VM: `macf update` in its workspace. */
  readonly upgrade: (agent: string) => Promise<void>;

  /**
   * Restart the agent. VM: `macf restart-self` when ALIVE (graceful — stash +
   * detached relaunch), or `launch` when DEAD. K8s: cycle the pod.
   */
  readonly restart: (agent: string) => Promise<void>;

  /**
   * The tier-1 gated nudge — deliver `text` into the agent's live turn loop.
   * VM: the canonical `tmux-send-to-claude` submit pattern. Runtime-specific.
   */
  readonly inject: (agent: string, text: string) => Promise<void>;

  /** Cold-start a desired-but-down agent. VM: spawn its `./claude.sh`. */
  readonly launch: (agent: string) => Promise<void>;
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
