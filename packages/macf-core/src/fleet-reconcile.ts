/**
 * The fleet desired-state reconciler — the DR-006 watchdog decision layer,
 * runtime-agnostic (DR-037 Decision 3 / OQ2). Ports the behavior of the devops
 * reference `fleet/reconcile.sh` (its 52-case test suite is the acceptance
 * oracle), but drives everything through the injectable `FleetDriver` + a state
 * store + a clock, so NOTHING runtime-specific (`/proc`, tmux, `capture-pane`,
 * the K8s API) leaks above this line.
 *
 * The model is Kubernetes-on-a-VM: reconcile ACTUAL (`driver.probe()` +
 * `driver.discoverWorkspaces()`) toward the operator-owned DESIRED set:
 *   - desired & not-running       → LAUNCH   (cold-start / reboot-recovery)
 *   - desired & running-but-deaf  → HEAL     (the tiered ladder)
 *   - desired-down                → SKIP     (never resurrect — don't-fight-the-operator)
 *       desired-down = an explicit `paused` sentinel OR `last-exit == 0` (the
 *       operator typed `/exit`) — the two compose (DR-031 §A.3 unification).
 *   - desired & reachable         → OK
 *
 * The HEAL ladder, per deaf agent, across sweeps (the cron gives the cross-sweep
 * memory):
 *   - sweep 1        → Tier-1 gated inject (`driver.inject` — the agent self-heals)
 *   - sweep 2+       → escalate, under two GATES that both hold before any restart:
 *       * aliveness-gate — NEVER restart a busy agent (`driver.isBusy`; the #642
 *         mode: channel-server dead while the TUI is alive + working).
 *       * restart-backoff — NEVER restart-storm a repeatedly-failing agent: after a
 *         Tier-2 restart, an EXPONENTIAL backoff window must elapse before the next
 *         one; a persistently-stuck agent (restarts exhausted) escalates to Tier-3.
 *     Tier-2 graceful-restart (`driver.restart`) is held behind `allowRestart`;
 *     Tier-3 `alert` (a `gh issue create`) is a DECISION-LAYER seam — deliberately
 *     NOT a `FleetDriver` method, so no GitHub concern leaks into the driver.
 *
 * Plus launch-stagger (space cold-starts so N dead agents don't thundering-herd)
 * and a self-heartbeat (the who-watches-the-watchdog signal). DRY-RUN BY DEFAULT
 * — the report is built + printed and NOTHING is acted on or persisted unless
 * `execute` is set.
 */
import type { FleetDriver, FleetState } from './fleet-driver.js';

/** One agent the operator declares SHOULD run on this host (DR-006 §A.2). */
export interface DesiredAgent {
  /** The routing-label identity (matches `FleetState.agents[].name`). */
  readonly agent: string;
  /** Absolute workspace dir — surfaced in the LAUNCH detail (driver resolves it). */
  readonly workspace: string;
}

/** The four reconcile verdicts (the report's DECISION column). */
export type ReconcileDecision = 'OK' | 'LAUNCH' | 'SKIP' | 'HEAL';

/**
 * Per-agent state that persists ACROSS sweeps (the cron's cross-sweep memory).
 * Read at the start of each agent's reconcile, written back only on `execute`.
 */
export interface ReconcileAgentState {
  /** Consecutive HEAL (deaf) sweeps — drives Tier-1 → escalation. */
  readonly deafSweeps: number;
  /** Consecutive Tier-2 restarts — the EXPONENTIAL-backoff exponent + stuck gauge. */
  readonly restartAttempts: number;
  /** Epoch-ms before which a Tier-2 restart is suppressed (the backoff window). */
  readonly backoffUntil: number;
  /** Tier-3 alert dedup sentinel (one alert per failure episode). */
  readonly alertOpen: boolean;
  /** Last observed process exit code (exit-code intent; `null` = absent/never-ran). */
  readonly lastExit: number | null;
  /** Explicit operator `paused` sentinel → desired-down. */
  readonly paused: boolean;
}

/** The zero state for an agent with no persisted history. */
export const EMPTY_RECONCILE_STATE: ReconcileAgentState = {
  deafSweeps: 0,
  restartAttempts: 0,
  backoffUntil: 0,
  alertOpen: false,
  lastExit: null,
  paused: false,
};

/**
 * Cross-sweep persisted state. Reads are pure lookups (defaulting to
 * `EMPTY_RECONCILE_STATE`); writes/resets happen only when the engine is in
 * `execute` mode (the caller gates them), so a dry-run is side-effect-free.
 */
export interface ReconcileStateStore {
  /** Current persisted state for `agent` (never throws — unknown → empty). */
  readonly read: (agent: string) => ReconcileAgentState;
  /** Persist `state` for `agent`. Only called on `execute`. */
  readonly write: (agent: string, state: ReconcileAgentState) => void;
  /**
   * Recovery reset — clear the escalation/backoff/alert counters (KEEP
   * `lastExit`/`paused`), so a future deaf episode starts a fresh ladder. Only
   * called on `execute`.
   */
  readonly reset: (agent: string) => void;
}

/** Tuning knobs for the ladder / backoff / stagger. */
export interface ReconcileConfig {
  /** Act (launch/inject/restart/alert/heartbeat/persist). `false` = dry-run (default). */
  readonly execute: boolean;
  /** Enable Tier-2 graceful-restart (operator sign-off). `false` → held. */
  readonly allowRestart: boolean;
  /** Deaf sweeps that stay on Tier-1 before escalating (default 1). */
  readonly escalateAfterSweeps: number;
  /** Base backoff (ms) — the first restart window (default 60_000). */
  readonly backoffBaseMs: number;
  /** Backoff ceiling (ms) — the exponential is clamped here (default 3_600_000). */
  readonly backoffMaxMs: number;
  /** Restart attempts beyond which a still-deaf agent is STUCK → Tier-3 (default 3). */
  readonly stuckMax: number;
  /** Delay (ms) inserted BETWEEN cold-start launches to avoid a thundering herd (default 15_000). */
  readonly launchStaggerMs: number;
  /** The Tier-1 self-diagnose nudge text delivered by `driver.inject`. */
  readonly injectMessage: string;
}

/** Sensible defaults; a caller overrides selectively via `resolveConfig`. */
export const DEFAULT_RECONCILE_CONFIG: ReconcileConfig = {
  execute: false,
  allowRestart: false,
  escalateAfterSweeps: 1,
  backoffBaseMs: 60_000,
  backoffMaxMs: 3_600_000,
  stuckMax: 3,
  launchStaggerMs: 15_000,
  injectMessage:
    '⚠️ You appear OFF-CHANNELS (watchdog): your channel is down / not accepting. ' +
    'Investigate, clear any stale registry entry, and request a relaunch.',
};

/** Merge partial overrides onto the defaults. */
export function resolveReconcileConfig(overrides?: Partial<ReconcileConfig>): ReconcileConfig {
  return { ...DEFAULT_RECONCILE_CONFIG, ...(overrides ?? {}) };
}

/** Info recorded by the self-heartbeat (execute-only). */
export interface ReconcileHeartbeat {
  /** The sweep's exit code. */
  readonly rc: number;
  /** Wall-clock (epoch ms) the sweep completed. */
  readonly at: number;
  /** Whether Tier-2 restart was enabled this sweep. */
  readonly restartEnabled: boolean;
}

/**
 * The injectable seams the reconcile orchestrator drives — all runtime-agnostic.
 * The tier-3 `alert` is HERE (a decision-layer seam), NOT on `driver`: it is a
 * GitHub concern, runtime-agnostic, so per DR-037 it must never leak into a
 * per-runtime driver.
 */
export interface ReconcileDeps {
  /** The pluggable fleet driver (probe + the mutation verbs). */
  readonly driver: FleetDriver;
  /** Cross-sweep persisted state. */
  readonly store: ReconcileStateStore;
  /** Monotonic-ish clock (ms) — injected so tests drive backoff/stagger timing. */
  readonly now: () => number;
  /** Sleep `ms` — injected so tests don't wait on the launch-stagger. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Tier-3 alert (a `gh issue create`) — decision-layer, dedup'd by the caller. */
  readonly alert: (agent: string, reason: string) => Promise<void>;
  /** Self-heartbeat — the who-watches-the-watchdog stamp (execute-only). */
  readonly heartbeat: (info: ReconcileHeartbeat) => Promise<void>;
  /** Emit one report line (the command wires it to stdout). */
  readonly log: (line: string) => void;
}

/** One row of the reconcile report. */
export interface ReconcileRow {
  readonly agent: string;
  readonly decision: ReconcileDecision;
  readonly detail: string;
}

/**
 * The sweep outcome. `rc` mirrors the reference exit contract:
 *   - 0 = every desired agent OK / down (no action)
 *   - 1 = action(s) taken or needed
 *   - 2 = precondition/probe failure (bad manifest, probe threw)
 */
export interface ReconcileResult {
  readonly rc: number;
  readonly rows: readonly ReconcileRow[];
}

// --- pure helpers -----------------------------------------------------------

/**
 * How the probe sees a desired agent (three-valued, mirroring the reference's
 * empty/`true`/`false` `reachable` field):
 *   - `absent`    — not in the registry roster at all (not running / never registered)
 *   - `deaf`      — in the roster but `/health` did NOT answer (registered, channel down)
 *   - `reachable` — in the roster + `/health` answered (mTLS 2xx)
 */
export function classifyReachability(
  state: FleetState,
  agent: string,
): 'absent' | 'deaf' | 'reachable' {
  const found = state.agents.find((a) => a.name === agent);
  if (!found) return 'absent';
  return found.online ? 'reachable' : 'deaf';
}

/**
 * The EXPONENTIAL restart-backoff window after `attempts` consecutive restarts:
 * `base * 2^(attempts-1)`, clamped to `maxMs`. `attempts <= 0` → no window (0).
 */
export function nextBackoffMs(attempts: number, config: ReconcileConfig): number {
  if (attempts <= 0) return 0;
  const raw = config.backoffBaseMs * 2 ** (attempts - 1);
  return Math.min(raw, config.backoffMaxMs);
}

/**
 * Minimal parser for the fixed `desired-agents.yaml` shape (no yaml dep — the
 * cron-light awk parse's TS twin). Pairs each `- agent: <x>` with the FOLLOWING
 * `workspace: <y>`; strips inline `# comments` + surrounding quotes; ignores the
 * `agents:` header, blank lines, and standalone comments.
 */
export function parseDesiredAgents(text: string): DesiredAgent[] {
  const out: DesiredAgent[] = [];
  let pendingAgent: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const agentMatch = line.match(/^\s*-\s*agent:\s*(.+)$/);
    if (agentMatch) {
      pendingAgent = cleanScalar(agentMatch[1]!);
      continue;
    }
    const wsMatch = line.match(/^\s*workspace:\s*(.+)$/);
    if (wsMatch && pendingAgent) {
      out.push({ agent: pendingAgent, workspace: cleanScalar(wsMatch[1]!) });
      pendingAgent = null;
    }
  }
  return out;
}

/** Strip a trailing `# comment`, trim, and drop one pair of surrounding quotes. */
function cleanScalar(raw: string): string {
  const noComment = raw.replace(/\s+#.*$/, '').trim();
  return noComment.replace(/^["']|["']$/g, '');
}

// --- report formatting ------------------------------------------------------

function headerRows(): readonly string[] {
  return [
    `${'AGENT'.padEnd(16)} ${'DECISION'.padEnd(10)} DETAIL`,
    `${'-----'.padEnd(16)} ${'--------'.padEnd(10)} ------`,
  ];
}

function reportRow(row: ReconcileRow): string {
  return `${row.agent.padEnd(16)} ${row.decision.padEnd(10)} ${row.detail}`;
}

// --- the orchestrator -------------------------------------------------------

/**
 * Run one reconcile sweep over the `desired` set. Probes ACTUAL state, decides +
 * (on `execute`) acts per agent through the injected driver + seams, and returns
 * the report + exit code. Dry-run (the default) prints the report and touches
 * nothing (no driver mutations, no state writes, no heartbeat).
 */
export async function reconcileFleet(
  desired: readonly DesiredAgent[],
  deps: ReconcileDeps,
  config: ReconcileConfig,
): Promise<ReconcileResult> {
  let fleet: FleetState;
  try {
    fleet = await deps.driver.probe();
  } catch (err) {
    deps.log(`FATAL: fleet probe failed — ${err instanceof Error ? err.message : String(err)}`);
    return { rc: 2, rows: [] };
  }

  for (const h of headerRows()) deps.log(h);

  const rows: ReconcileRow[] = [];
  let rc = 0;
  let launchCount = 0;

  for (const d of desired) {
    const state = deps.store.read(d.agent);
    const row = await reconcileAgent(d, state, fleet, deps, config, launchCount);
    deps.log(reportRow(row.row));
    rows.push(row.row);
    if (row.row.decision === 'LAUNCH') launchCount += 1;
    if (row.acted) rc = 1;
  }

  deps.log('');
  const mode = config.execute ? 'EXECUTE' : 'dry-run';
  const restart = config.allowRestart ? 'on' : 'off';
  if (config.execute) {
    await deps.heartbeat({ rc, at: deps.now(), restartEnabled: config.allowRestart });
  }
  deps.log(
    rc === 0
      ? `reconcile [${mode}, restart:${restart}]: all desired agents OK / down — no action.`
      : `reconcile [${mode}, restart:${restart}]: action(s) taken or needed above.`,
  );

  return { rc, rows };
}

/** Per-agent reconcile: classify → decide → (execute) act. Returns the row + whether it counts as an action. */
async function reconcileAgent(
  d: DesiredAgent,
  state: ReconcileAgentState,
  fleet: FleetState,
  deps: ReconcileDeps,
  config: ReconcileConfig,
  launchCount: number,
): Promise<{ readonly row: ReconcileRow; readonly acted: boolean }> {
  const agent = d.agent;

  // desired-down (SKIP): explicit paused sentinel.
  if (state.paused) {
    return { row: mkRow(agent, 'SKIP', 'paused (desired-down; explicit) — not resurrected'), acted: false };
  }

  const actual = classifyReachability(fleet, agent);

  if (actual === 'absent') {
    // exit-code intent: not running + last-exit==0 (operator typed /exit) → desired-down.
    if (state.lastExit === 0) {
      return {
        row: mkRow(agent, 'SKIP', 'not running + last-exit==0 (operator /exit) — desired-down, not restarted'),
        acted: false,
      };
    }
    await doLaunch(d, deps, config, launchCount);
    return {
      row: mkRow(agent, 'LAUNCH', `not running, last-exit!=0/absent → cold-start (ws: ${d.workspace})`),
      acted: true,
    };
  }

  if (actual === 'reachable') {
    if (config.execute) deps.store.reset(agent);
    return { row: mkRow(agent, 'OK', 'reachable + accepting'), acted: false };
  }

  // deaf → HEAL ladder.
  await healAgent(d, state, deps, config);
  return { row: mkRow(agent, 'HEAL', 'registered but channel DOWN (deaf) → ladder'), acted: true };
}

/** Cold-start a desired-but-down agent, STAGGERED so N dead agents don't thundering-herd. */
async function doLaunch(
  d: DesiredAgent,
  deps: ReconcileDeps,
  config: ReconcileConfig,
  launchCount: number,
): Promise<void> {
  if (!config.execute) return;
  // Space every launch after the first by the stagger window.
  if (launchCount > 0) await deps.sleep(config.launchStaggerMs);
  await deps.driver.launch(d.agent);
}

/**
 * The tiered HEAL ladder for one deaf agent (cross-sweep). Sweep 1 → Tier-1
 * inject; sweep 2+ → escalate under the aliveness-gate + restart-backoff before
 * any Tier-2 restart, with Tier-3 alert on every escalation path.
 */
async function healAgent(
  d: DesiredAgent,
  state: ReconcileAgentState,
  deps: ReconcileDeps,
  config: ReconcileConfig,
): Promise<void> {
  const agent = d.agent;
  const n = state.deafSweeps + 1;
  if (config.execute) deps.store.write(agent, { ...state, deafSweeps: n });

  if (n <= config.escalateAfterSweeps) {
    deps.log(`    [sweep ${n}] first deaf sweep → Tier-1 (gated inject)`);
    if (config.execute) await deps.driver.inject(agent, config.injectMessage);
    return;
  }

  deps.log(`    [sweep ${n}] still deaf after ${n - 1} prior sweep(s) → escalate (Tier-1 did not recover)`);

  // Aliveness-gate — NEVER restart a busy agent (the #642 channel-dead/TUI-alive mode).
  // Only probed on execute (dry-run constructs the plan without touching the driver).
  if (config.execute && (await deps.driver.isBusy(agent))) {
    deps.log(`    [ABORT] ${agent} pane ACTIVE — agent ALIVE despite channel-down (#642). NOT restarting a working agent.`);
    await raiseAlert(agent, `deaf ${n} sweeps but pane active (#642) — human check`, deps, config);
    return;
  }

  // Restart-backoff gate — NEVER restart-storm a repeatedly-failing agent.
  if (deps.now() < state.backoffUntil) {
    deps.log(`    [BACKOFF] ${agent} restart suppressed (attempt ${state.restartAttempts}, window not elapsed)`);
    if (state.restartAttempts >= config.stuckMax) {
      deps.log(`    [STUCK] ${agent} stuck in restart-backoff after ${state.restartAttempts} attempts → Tier-3`);
      await raiseAlert(agent, `stuck in restart-backoff after ${state.restartAttempts} restarts`, deps, config);
    }
    return;
  }

  await escalateRestart(d, state, n, deps, config);
}

/** The Tier-2/Tier-3 tail once the aliveness + backoff gates pass. */
async function escalateRestart(
  d: DesiredAgent,
  state: ReconcileAgentState,
  n: number,
  deps: ReconcileDeps,
  config: ReconcileConfig,
): Promise<void> {
  const agent = d.agent;

  // Restarts exhausted (>= stuckMax) but still deaf → escalate, do NOT restart again.
  if (state.restartAttempts >= config.stuckMax) {
    deps.log(`    [STUCK] ${agent} ${state.restartAttempts} restarts did not recover → Tier-3 (not restarting again)`);
    await raiseAlert(agent, `stuck: ${state.restartAttempts} restarts did not recover`, deps, config);
    return;
  }

  // Tier-2 graceful-restart — held behind operator sign-off.
  if (!config.allowRestart) {
    deps.log(`    [held] Tier-2 graceful-restart of ${agent} SUPPRESSED (no --allow-restart; operator sign-off required)`);
    await raiseAlert(agent, `deaf ${n} sweeps; Tier-2 held (no --allow-restart)`, deps, config);
    return;
  }

  deps.log(`    Tier-2 graceful-restart ${agent} (attempt ${state.restartAttempts + 1})`);
  if (config.execute) {
    await deps.driver.restart(agent);
    const attempts = state.restartAttempts + 1;
    const fresh = deps.store.read(agent);
    deps.store.write(agent, {
      ...fresh,
      restartAttempts: attempts,
      backoffUntil: deps.now() + nextBackoffMs(attempts, config),
    });
  }
  await raiseAlert(agent, `restarted after ${n} deaf sweeps`, deps, config);
}

/** Tier-3 alert (a `gh issue create`), dedup'd via the persisted `alertOpen` sentinel. */
async function raiseAlert(
  agent: string,
  reason: string,
  deps: ReconcileDeps,
  config: ReconcileConfig,
): Promise<void> {
  if (deps.store.read(agent).alertOpen) {
    deps.log(`    [skip] Tier-3 alert for ${agent} already open (dedup)`);
    return;
  }
  deps.log(`    Tier-3 alert for ${agent} (${reason})`);
  if (!config.execute) return;
  await deps.alert(agent, reason);
  const fresh = deps.store.read(agent);
  deps.store.write(agent, { ...fresh, alertOpen: true });
}

function mkRow(agent: string, decision: ReconcileDecision, detail: string): ReconcileRow {
  return { agent, decision, detail };
}
