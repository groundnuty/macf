/**
 * The rolling fleet-upgrade DECISION layer (DR-037 / macf#682 Phase 2) — the
 * runtime-agnostic sequencer that promotes the devops `fleet/upgrade.sh`
 * reference impl onto the framework substrate.
 *
 * It is the pure decision half of the DR-037 decision/driver split (OQ2 — pure
 * logic lives in macf-core; the per-runtime driver bodies live in `packages/macf`
 * or a future K8s package). It NEVER touches `/proc`, tmux, `capture-pane`, or
 * kubectl — it drives entirely off the injected `FleetDriver` verbs
 * (`probe`/`discoverWorkspaces`/`isBusy`/`upgrade`/`restart`) plus an injected
 * `verifyGreen` runner, so the SAME sequencer rolls a VM tmux fleet, a macOS
 * host, and a far-future K8s deployment by swapping only the driver.
 *
 * The state machine (per fleet, one agent at a time):
 *
 *   probe() + discoverWorkspaces()
 *     → for each member whose RUNNING version < target (compareSemver):
 *         busy-gate (driver.isBusy → busy ⇒ SKIP+REPORT, or `--wait` for idle)
 *           → driver.upgrade(agent)
 *           → driver.restart(agent)
 *           → verifyGreen({agent, target})   // re-resolves the fresh endpoint
 *               → green ⇒ next agent
 *               → NOT green within the budget ⇒ HALT the roll (a bad release
 *                 stalls at agent 1 and CANNOT brick the fleet)
 *
 * Multi-fleet (`--fleet a,b,c`) rolls fleet-by-fleet: each fleet's roll must
 * finish without a HALT before the next fleet starts (a bad release in fleet-1
 * stops fleet-2 from ever being touched).
 *
 * DRY-RUN is the default at the command boundary: `execute: false` computes +
 * reports the PLAN (probe + classify) and performs NO driver mutations.
 */
import { compareSemver } from './semver.js';
import type { FleetDriver, FleetState } from './fleet-driver.js';
import type { WorkspaceRecord } from './discovery.js';
import type { VerifyGreenOptions, VerifyGreenResult } from './verify-green.js';

/**
 * How a discovered fleet member classifies against the target version. Pure,
 * version-only (the busy-gate is an EXECUTE-time driver decision, not a plan
 * disposition):
 * - `behind`    — reachable + running a version `< target` ⇒ a roll candidate.
 * - `at-target` — reachable + running `>= target` ⇒ skip (already current).
 * - `offline`   — no comparable running version (unreachable OR a `/health` body
 *                 with no version) ⇒ skip + report (let reconcile heal it first;
 *                 a bad-release HALT must never be attributed to a down agent).
 */
export type UpgradeDisposition = 'behind' | 'at-target' | 'offline';

/** One member's version-classification against the target (pure planner output). */
export interface AgentUpgradePlan {
  /** The agent's routing label (registry key). */
  readonly agent: string;
  /** The fleet (registry identifier) this member belongs to. */
  readonly fleet: string;
  /** The agent's live self-reported `/health.version`, or `null` when offline/version-less. */
  readonly runningVersion: string | null;
  /** The workspace's on-disk version pin (legible even when the agent is dead). */
  readonly pinnedVersion: string | null;
  /** The version-only disposition (see `UpgradeDisposition`). */
  readonly disposition: UpgradeDisposition;
}

/**
 * The EXECUTE-path outcome of a single agent in the roll:
 * - `upgraded`     — rolled + came up green on the target.
 * - `busy-skipped` — busy-gated (or `--wait` timed out still busy); NOT a
 *                    failure, so the roll CONTINUES to the next agent.
 * - `halted`       — did not verify-green within the budget; the roll STOPS here.
 */
export type RollOutcome = 'upgraded' | 'busy-skipped' | 'halted';

/** The per-agent EXECUTE result. `detail` carries the green version or halt reason. */
export interface AgentRollResult {
  readonly agent: string;
  readonly outcome: RollOutcome;
  readonly detail?: string;
}

/** The result of rolling ONE fleet (the EXECUTE path). */
export interface FleetRollResult {
  readonly results: readonly AgentRollResult[];
  /** True when a member failed verify-green and the roll stopped early. */
  readonly halted: boolean;
  /** Count of agents rolled + verified green. */
  readonly upgraded: number;
  /** Count of agents skipped because they were busy. */
  readonly busySkipped: number;
}

/** Progress events for CLI rendering (the RESULT objects are what tests assert on). */
export type UpgradeEvent =
  | { readonly kind: 'fleet-start'; readonly fleet: string; readonly behind: number; readonly total: number }
  | { readonly kind: 'fleet-skipped'; readonly fleet: string; readonly reason: string }
  | { readonly kind: 'roll-start'; readonly agent: string; readonly from: string | null; readonly to: string }
  | { readonly kind: 'busy-skip'; readonly agent: string; readonly waited: boolean }
  | { readonly kind: 'upgraded'; readonly agent: string; readonly version: string }
  | { readonly kind: 'halt'; readonly agent: string; readonly reason: string; readonly lastVersion: string | null };

/**
 * Classify each discovered fleet member against the target version. PURE — no
 * driver, no clock, no network. The single source of the behind/at-target/offline
 * decision, unit-tested in isolation.
 */
export function planFleetUpgrade(
  members: readonly WorkspaceRecord[],
  state: FleetState,
  targetVersion: string,
): readonly AgentUpgradePlan[] {
  const byName = new Map(state.agents.map((a) => [a.name, a]));
  return members.map((m) => {
    const live = byName.get(m.agent);
    const runningVersion = live?.online ? (live.version ?? null) : null;
    let disposition: UpgradeDisposition;
    if (runningVersion === null) {
      disposition = 'offline';
    } else if (compareSemver(runningVersion, targetVersion) >= 0) {
      disposition = 'at-target';
    } else {
      disposition = 'behind';
    }
    return {
      agent: m.agent,
      fleet: m.registry,
      runningVersion,
      pinnedVersion: m.versionPin,
      disposition,
    };
  });
}

/** Tunables for a single-fleet roll. */
export interface RollFleetOptions {
  /** The version each rolled agent must self-report to be considered green. */
  readonly targetVersion: string;
  /** Per-agent verify-green wall-time budget (ms). */
  readonly verifyTimeoutMs: number;
  /** `--wait`: on a busy agent, poll for idle instead of skipping. */
  readonly wait?: boolean;
  /** Total budget to wait for a busy agent to go idle when `wait` is set (ms). */
  readonly waitTimeoutMs?: number;
  /** Re-poll interval while waiting for idle (ms). */
  readonly waitPollMs?: number;
}

/** Injected side-effect seams for the roll (all fakeable in tests). */
export interface RollFleetDeps {
  /** The fleet driver whose verbs the sequencer calls. */
  readonly driver: FleetDriver;
  /**
   * The post-restart verify-green runner. Injected whole (not built here) so the
   * command wires its RE-RESOLVING probe (DR-037 Decision 5 — re-read the registry
   * each poll for the fresh restart-self port) and tests supply a fake outcome.
   */
  readonly verifyGreen: (opts: VerifyGreenOptions) => Promise<VerifyGreenResult>;
  /** Sleep `ms` (used only by the `--wait` busy re-poll; injected so tests don't wait). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Monotonic clock in ms (drives the `--wait` budget; injected in tests). */
  readonly now: () => number;
  /** Optional progress sink for CLI rendering. */
  readonly onEvent?: (ev: UpgradeEvent) => void;
}

/** Default total `--wait` budget for a busy agent to go idle (ms). */
export const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
/** Default `--wait` re-poll interval (ms). */
export const DEFAULT_WAIT_POLL_MS = 5_000;

/**
 * Poll `driver.isBusy(agent)` until it reports idle or the budget is exhausted.
 * Returns `true` if the agent became idle (safe to roll), `false` if it stayed
 * busy for the whole budget. Called only after an initial busy reading, so it
 * sleeps-then-checks and always terminates on the injected clock.
 */
async function waitForIdle(agent: string, opts: RollFleetOptions, deps: RollFleetDeps): Promise<boolean> {
  const budget = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const poll = opts.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
  const start = deps.now();
  while (deps.now() - start < budget) {
    await deps.sleep(poll);
    if (!(await deps.driver.isBusy(agent))) return true;
  }
  return false;
}

/**
 * Roll ONE fleet: for every `behind` plan (in order) run the busy-gate → upgrade
 * → restart → verify-green cycle, HALTING the roll on the first agent that fails
 * to come up green. Non-`behind` plans are ignored (planned skips). Busy agents
 * are skipped + reported (never a halt); with `wait`, they are re-polled for idle
 * first. The verb order + HALT semantics mirror `fleet/upgrade.sh`'s `roll_one`.
 */
export async function rollFleet(
  plans: readonly AgentUpgradePlan[],
  opts: RollFleetOptions,
  deps: RollFleetDeps,
): Promise<FleetRollResult> {
  const results: AgentRollResult[] = [];
  let upgraded = 0;
  let busySkipped = 0;

  for (const plan of plans) {
    if (plan.disposition !== 'behind') continue;
    const agent = plan.agent;

    let busy = await deps.driver.isBusy(agent);
    let waited = false;
    if (busy && opts.wait) {
      waited = true;
      busy = !(await waitForIdle(agent, opts, deps));
    }
    if (busy) {
      busySkipped += 1;
      results.push({ agent, outcome: 'busy-skipped', detail: waited ? 'still busy after --wait' : 'busy' });
      deps.onEvent?.({ kind: 'busy-skip', agent, waited });
      continue;
    }

    deps.onEvent?.({ kind: 'roll-start', agent, from: plan.runningVersion, to: opts.targetVersion });
    await deps.driver.upgrade(agent);
    await deps.driver.restart(agent);
    const green = await deps.verifyGreen({
      agent,
      targetVersion: opts.targetVersion,
      timeoutMs: opts.verifyTimeoutMs,
    });

    if (green.ok) {
      upgraded += 1;
      results.push({ agent, outcome: 'upgraded', detail: green.version });
      deps.onEvent?.({ kind: 'upgraded', agent, version: green.version });
      continue;
    }

    const reason = green.reason;
    results.push({
      agent,
      outcome: 'halted',
      detail: `verify-green ${reason} (last=${green.lastVersion ?? 'down'})`,
    });
    deps.onEvent?.({ kind: 'halt', agent, reason, lastVersion: green.lastVersion });
    return { results, halted: true, upgraded, busySkipped };
  }

  return { results, halted: false, upgraded, busySkipped };
}

/** Options for the multi-fleet orchestrator. */
export interface UpgradeFleetsOptions extends RollFleetOptions {
  /** `false` = dry-run: probe + plan + report, NO driver mutations (the default). */
  readonly execute: boolean;
}

/** Injected seams for the multi-fleet orchestrator. */
export interface UpgradeFleetsDeps {
  /**
   * Resolve the driver for a fleet (registry identifier). Production binds
   * `createVmDriverFromConfig` at a representative workspace; tests return a fake.
   * `null` ⇒ the fleet cannot be reached (skip + report, NOT a halt).
   */
  readonly resolveDriver: (fleet: string) => Promise<FleetDriver | null>;
  readonly verifyGreen: (opts: VerifyGreenOptions) => Promise<VerifyGreenResult>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly onEvent?: (ev: UpgradeEvent) => void;
}

/** One fleet's slice of the run report. */
export interface FleetPlanReport {
  readonly fleet: string;
  readonly plans: readonly AgentUpgradePlan[];
  /** Present only in EXECUTE mode. */
  readonly rolled?: FleetRollResult;
  /** Present when the fleet was skipped whole (e.g. driver unresolved). */
  readonly skipped?: string;
}

/** The full run report across all selected fleets. */
export interface FleetUpgradeReport {
  readonly target: string;
  readonly fleets: readonly FleetPlanReport[];
  /** True when a fleet HALTED (and later fleets were consequently not started). */
  readonly halted: boolean;
}

/**
 * Orchestrate a rolling upgrade across the ORDERED `fleets` (registry
 * identifiers), fleet-by-fleet. Each fleet is probed + planned; in EXECUTE mode
 * it is then rolled, and a HALT in one fleet STOPS the whole run — later fleets
 * are never started (a bad release cannot cascade across fleets). An unresolvable
 * fleet is skipped + reported and does NOT halt the run.
 */
export async function upgradeFleets(
  fleets: readonly string[],
  opts: UpgradeFleetsOptions,
  deps: UpgradeFleetsDeps,
): Promise<FleetUpgradeReport> {
  const reports: FleetPlanReport[] = [];
  let halted = false;

  for (const fleet of fleets) {
    const driver = await deps.resolveDriver(fleet);
    if (!driver) {
      reports.push({ fleet, plans: [], skipped: 'driver-unresolved' });
      deps.onEvent?.({ kind: 'fleet-skipped', fleet, reason: 'driver-unresolved' });
      continue;
    }

    const members = driver.discoverWorkspaces().filter((r) => r.registry === fleet);
    const state = await driver.probe();
    const plans = planFleetUpgrade(members, state, opts.targetVersion);
    const behind = plans.filter((p) => p.disposition === 'behind').length;
    deps.onEvent?.({ kind: 'fleet-start', fleet, behind, total: plans.length });

    if (!opts.execute) {
      reports.push({ fleet, plans });
      continue;
    }

    const rolled = await rollFleet(plans, opts, {
      driver,
      verifyGreen: deps.verifyGreen,
      sleep: deps.sleep,
      now: deps.now,
      onEvent: deps.onEvent,
    });
    reports.push({ fleet, plans, rolled });
    if (rolled.halted) {
      halted = true;
      break; // do NOT start the next fleet — a bad release stops the whole run
    }
  }

  return { target: opts.targetVersion, fleets: reports, halted };
}
