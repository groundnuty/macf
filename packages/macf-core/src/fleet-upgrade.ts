/**
 * The rolling fleet-upgrade DECISION layer (DR-037 / macf#682 Phase 2) — the
 * runtime-agnostic sequencer that promotes the devops `fleet/upgrade.sh`
 * reference impl onto the framework substrate.
 *
 * It is the pure decision half of the DR-037 decision/driver split (OQ2 — pure
 * logic lives in macf-core; the per-runtime driver bodies live in `packages/macf`
 * or a future K8s package). It NEVER touches `/proc`, tmux, `capture-pane`, or
 * kubectl — it drives entirely off the injected `FleetDriver` verbs
 * (`probe`/`discoverWorkspaces`/`isBusy`/`listDirtyConfig`/`upgrade`/`restart`/
 * `listModifiedFiles`) plus an injected `verifyGreen` runner, so the SAME
 * sequencer rolls a VM tmux fleet, a macOS host, and a far-future K8s deployment
 * by swapping only the driver.
 *
 * The state machine (per fleet, one agent at a time):
 *
 *   probe() + discoverWorkspaces()
 *     → for each member whose RUNNING version < target (compareSemver):
 *         PRE-FLIGHT gate (BEFORE any mutation — never touches the agent):
 *           config-dirty-gate (driver.listDirtyConfig → non-empty ⇒ OBJECT:
 *             SKIP+REPORT the list of uncommitted files + an agent-directed
 *             message to inspect-and-commit-or-delete-or-gitignore-then-retry,
 *             unless `--force`; macf#725 — TRANSACTIONAL revision of macf#722
 *             Fix B: rather than silently stashing operator dirt, the roll
 *             OBJECTS and does NOTHING until the agent resolves it)
 *           busy-gate (driver.isBusy → busy ⇒ SKIP+REPORT, or `--wait` for idle)
 *         → driver.upgrade(agent)        // dirties the managed config surface —
 *                                        // this is EXPECTED, not a fault
 *         → driver.restart(agent, { leaveConfigUncommitted: true })
 *             // relaunches WITHOUT stashing macf update's own regeneration —
 *             // the pre-flight gate already proved the ONLY dirt is the
 *             // upgrade's, so leaving it uncommitted (visible via `git status`
 *             // in the relaunched agent) is safe + intended (macf#725)
 *         → verifyGreen({agent, target})   // re-resolves the fresh endpoint
 *             each poll, over a relaunch-aware grace budget (`--verify-timeout`)
 *             → green on TARGET ⇒ driver.listModifiedFiles(agent) → emit an
 *               agent-directed "review + commit what macf update regenerated"
 *               message + list, THEN next agent (`upgraded`)
 *             → confirmed back on the OLD (pre-upgrade) version ⇒ HALT the
 *               roll, reason `bad-release` (a crash-loop / stuck-old-process
 *               release stalls at agent 1 and CANNOT brick the fleet)
 *             → past-grace still NOT confirmed green (down / unreachable /
 *               some other unknown version) ⇒ HALT the roll, reason
 *               `relaunch-unconfirmed` — this is NOT a continue: "not yet
 *               green" cannot distinguish a slow-but-fine relaunch from a
 *               release that crashes on startup (which never shows the old
 *               version either), so continuing past an unconfirmed agent
 *               would risk cascading a crash-on-start release across the
 *               fleet (macf#722 Fix A)
 *
 * Multi-fleet (`--fleet a,b,c`) rolls fleet-by-fleet: each fleet's roll must
 * finish without a HALT before the next fleet starts (a bad release in fleet-1
 * stops fleet-2 from ever being touched).
 *
 * DRY-RUN is the default at the command boundary: `execute: false` computes +
 * reports the PLAN (probe + classify) and performs NO driver mutations.
 *
 * **Reconcile is MANUAL this iteration (macf#725).** The config-dirty OBJECT
 * path surfaces the dirt via `onEvent` + a non-mutating skip; it does NOT
 * auto-resolve (no auto-stash, no auto-commit, no auto-delete). A clean
 * re-run, after the agent (or operator) resolves the flagged files, completes
 * the roll for that agent.
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
  /**
   * The fleet this member belongs to — the workspace's PROJECT (macf#710), NOT
   * its (possibly-shared) registry scope. See `WorkspaceRecord.project`.
   */
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
 * - `upgraded`              — rolled + confirmed green on the target. CONTINUES.
 * - `busy-skipped`          — busy-gated (or `--wait` timed out still busy),
 *                             BEFORE any mutation; NOT a failure, CONTINUES.
 * - `config-dirty-skipped`  — config-dirty-gated (uncommitted changes on the
 *                             roll's touched-config surface), BEFORE any
 *                             mutation; NOT a failure, CONTINUES. The roll
 *                             OBJECTS with the specific file list + an
 *                             agent-directed message (macf#725 — replaces
 *                             macf#722 Fix B's silent skip).
 * - `halted`                — verify-green did NOT confirm the target version;
 *                             the roll STOPS here. `reason` distinguishes WHY
 *                             (see `HaltReason`).
 *
 * The two pre-flight skip outcomes (`busy-skipped` / `config-dirty-skipped`)
 * are safe to continue past because the agent was NEVER mutated. `halted` is
 * always terminal because the agent WAS rolled and its post-restart state is
 * either confirmed-bad or unconfirmed — neither is safe to leave behind while
 * moving on to the next agent (macf#722 Fix A).
 */
export type RollOutcome = 'upgraded' | 'busy-skipped' | 'config-dirty-skipped' | 'halted';

/**
 * WHY a roll halted (only meaningful when `outcome === 'halted'`):
 * - `bad-release`           — verify-green confirmed the agent came back up
 *                             REACHABLE at its OLD (pre-upgrade) version — a
 *                             crash-loop / stuck-old-process release. Terminal;
 *                             stops this fleet's roll + later fleets.
 * - `relaunch-unconfirmed`  — past the full verify-green grace budget, the
 *                             agent was never confirmed at the target version:
 *                             down the whole time, unreachable, or reachable at
 *                             some OTHER (neither old-pin nor target) version.
 *                             "Not yet green" cannot distinguish a slow-but-fine
 *                             relaunch from a release that crashes on startup
 *                             (which never shows the old version either), so
 *                             this is deliberately NOT a continue.
 */
export type HaltReason = 'bad-release' | 'relaunch-unconfirmed';

/** The per-agent EXECUTE result. `detail` carries a human-readable summary. */
export interface AgentRollResult {
  readonly agent: string;
  readonly outcome: RollOutcome;
  /** Set only when `outcome === 'halted'` — see `HaltReason`. */
  readonly reason?: HaltReason;
  readonly detail?: string;
}

/**
 * The roll's TOUCHED-CONFIG-SURFACE UNION (macf#722 Fix B, corrected naming
 * macf#725) — the path globs `rollFleet`'s pre-flight config-dirty gate checks
 * for uncommitted tracked changes before touching an agent.
 *
 * **This is a UNION, not an "operator-preserved" set** (the DR-037 Amendment B
 * naming was a misnomer, corrected here macf#725): it spans BOTH (a) the files
 * `macf update` OVERWRITES (the managed surface — canonical rules/scripts/hooks
 * under `.claude/**`, `.macf/*`) and (b) the files `restart-self` would STASH
 * (the operator surface — `settings.local.json`, `rules/project/**`,
 * `env.local.*`, `CLAUDE.md`, a hand-authored `claude.sh`). Both halves answer
 * the SAME pre-flight question the gate asks — "would this roll's `upgrade` +
 * `restart` silently clobber or stash SOMETHING uncommitted on this surface?"
 * — so both belong in the one union the gate checks, regardless of which half
 * of DR-029's managed-vs-operator taxonomy a given path falls in.
 *
 * Sourced from DR-029's Amendment (2026-06-27, macf#598) managed-vs-operator
 * taxonomy: `.claude/**` (rules + scripts + settings — managed AND
 * project-tier), `CLAUDE.md` (operator workbench doc), `claude.sh` (the
 * launcher — operator-preserved when hand-authored/header-less, and harmless
 * to include even when macf-managed since a macf-managed copy is never
 * legitimately "dirty" outside an in-flight `macf update`), and `env.local.*`
 * (the operator-custom env extension slot — see
 * `design/decisions/DR-029-substrate-config-via-init-and-reintegrate.md`
 * Amendment table). Deliberately excludes macf-managed/regenerated files
 * (`env.*` canonical seven, `host-prelude.sh`) that are ONLY ever touched by
 * `macf update` itself and never by an operator — dirtiness there pre-flight
 * would still be a genuine conflict (someone hand-edited a regenerated file),
 * so those ARE covered by `.claude/**`/`.macf/*` where they live; the excluded
 * class is narrower than "everything macf update touches."
 *
 * NOTE (macf#724 review, still applicable post-rename): this gate's set is
 * intentionally a slight SUPERSET of DR-029's *regenerate*-boundary for
 * `claude.sh`. The two answer DIFFERENT questions — this gate: "does the roll
 * need to OBJECT before touching this agent?"; DR-029's header-conditional
 * rule: "should `macf update` REGENERATE this file?". So do NOT "align"
 * `claude.sh` here to DR-029's header-conditional form: that would reintroduce
 * the roll-past-a-dirty-managed-`claude.sh` hole. Unconditional here is
 * harmless when clean (nothing flagged) and protective when dirty, regardless
 * of header.
 */
export const ROLL_TOUCHED_CONFIG_PATTERNS = [
  '.claude/**',
  'CLAUDE.md',
  'claude.sh',
  'env.local.*',
] as const;

/** The result of rolling ONE fleet (the EXECUTE path). */
export interface FleetRollResult {
  readonly results: readonly AgentRollResult[];
  /** True when a member failed verify-green and the roll stopped early. */
  readonly halted: boolean;
  /** Count of agents rolled + verified green. */
  readonly upgraded: number;
  /** Count of agents skipped because they were busy. */
  readonly busySkipped: number;
  /** Count of agents skipped because their config surface was dirty (macf#722 Fix B). */
  readonly configDirtySkipped: number;
}

/** Progress events for CLI rendering (the RESULT objects are what tests assert on). */
export type UpgradeEvent =
  | { readonly kind: 'fleet-start'; readonly fleet: string; readonly behind: number; readonly total: number }
  | { readonly kind: 'fleet-skipped'; readonly fleet: string; readonly reason: string }
  | { readonly kind: 'roll-start'; readonly agent: string; readonly from: string | null; readonly to: string }
  /**
   * The pre-flight OBJECT (macf#725) — the agent's touched-config surface has
   * UNCOMMITTED changes. `files` is the exact uncommitted-path list;
   * `message` is the ready-to-forward, agent-directed text (inspect + commit /
   * delete / gitignore, then re-run). Fired INSTEAD of any mutation — nothing
   * on this agent was touched.
   */
  | { readonly kind: 'config-dirty-skip'; readonly agent: string; readonly files: readonly string[]; readonly message: string }
  | { readonly kind: 'busy-skip'; readonly agent: string; readonly waited: boolean }
  /**
   * The post-upgrade modified-files report (macf#725) — fired once an agent is
   * confirmed green, before advancing to the next agent. `files` lists what
   * `macf update` regenerated (and `restart-self` deliberately left
   * uncommitted) in the relaunched agent's workspace; `message` is the
   * ready-to-forward, agent-directed text (review with `git diff` + commit /
   * act as needed).
   */
  | { readonly kind: 'upgraded'; readonly agent: string; readonly version: string; readonly modifiedFiles: readonly string[]; readonly message: string }
  | { readonly kind: 'halt'; readonly agent: string; readonly reason: HaltReason; readonly lastVersion: string | null };

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
      fleet: m.project,
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
  /**
   * `--force` (macf#722 Fix B / macf#725): roll an agent EVEN IF its config
   * surface is dirty PRE-flight — bypasses the pre-flight config-dirty OBJECT
   * gate. Once bypassed for an agent, that agent's `restart` is ALSO told
   * `leaveConfigUncommitted: true` (same as the normal clean-path transaction)
   * — `--force` means "roll anyway," not "stash the pre-existing dirt," so the
   * pre-existing uncommitted files are left in place exactly like `macf
   * update`'s own regeneration would be.
   */
  readonly force?: boolean;
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
 * Classify a failed verify-green against the agent's PRE-upgrade running
 * version (macf#722 Fix A). `bad-release` requires POSITIVE confirmation that
 * the agent came back reachable at the OLD pin — everything else (never
 * reachable, or reachable at some other unrecognized version) is
 * `relaunch-unconfirmed`. Never infer `bad-release` from absence of success;
 * only from the last-seen version actually matching the old pin.
 */
function classifyHalt(green: VerifyGreenResult & { readonly ok: false }, oldVersion: string | null): HaltReason {
  if (
    green.reason === 'wrong-version' &&
    green.lastVersion !== null &&
    oldVersion !== null &&
    compareSemver(green.lastVersion, oldVersion) === 0
  ) {
    return 'bad-release';
  }
  return 'relaunch-unconfirmed';
}

/**
 * Build the agent-directed OBJECT message for a config-dirty pre-flight skip
 * (macf#725). Pure — exported for CLI-rendering reuse / tests.
 */
export function buildConfigDirtyMessage(agent: string, files: readonly string[]): string {
  return (
    `Fleet upgrade skipped ${agent} — these files have uncommitted changes ` +
    `\`macf update\` would overwrite: ${files.join(', ')}. Inspect each and ` +
    `commit, delete, or .gitignore it, then re-run the upgrade.`
  );
}

/**
 * Build the agent-directed post-upgrade modified-files message (macf#725).
 * Pure — exported for CLI-rendering reuse / tests.
 *
 * The message names the intended STEADY-STATE explicitly: a clean roll LEAVES
 * this regeneration uncommitted (so the agent can review it), which means the
 * NEXT roll's pre-flight WILL re-flag these same files as uncommitted unless
 * they're committed. That re-flag is intended hygiene ("commit last update's
 * regen before upgrading again"), not a surprise — so the message tells the
 * agent to commit them, not merely review them.
 */
export function buildModifiedFilesMessage(agent: string, files: readonly string[]): string {
  return (
    `Fleet upgrade regenerated these files in ${agent}'s workspace: ` +
    `${files.join(', ')}. Review with \`git diff\` and commit them (so the next ` +
    `upgrade's pre-flight doesn't re-flag them as uncommitted) or act as needed.`
  );
}

/**
 * Roll ONE fleet: for every `behind` plan (in order) run the PRE-FLIGHT gates
 * (config-dirty, then busy) → upgrade → restart → verify-green cycle, HALTING
 * the roll on the first agent whose post-restart state isn't confirmed-green.
 * Non-`behind` plans are ignored (planned skips). Pre-flight-gated agents are
 * skipped + reported and NEVER a halt (they were never mutated, so continuing
 * is always safe) — config-dirty is checked first because a busy-but-clean
 * agent may still become idle later (`--wait`), whereas a dirty agent is
 * skip-only regardless. With `wait`, a busy agent is re-polled for idle first.
 * The verb order + HALT semantics mirror `fleet/upgrade.sh`'s `roll_one`.
 *
 * **Transactional + OBJECT-with-message revision (macf#725).** The pre-flight
 * config-dirty gate is the ONLY decision point that inspects PRE-upgrade
 * state: clean (or explicitly `--force`-bypassed) ⇒ the roll enters the
 * transaction and MUST complete it — `upgrade` → `restart(agent,
 * { leaveConfigUncommitted: true })` always runs together, never mutating
 * `upgrade` without following through to `restart`. Dirty (and not forced) ⇒
 * the roll does NOTHING to this agent (no `upgrade`, no `restart`) and OBJECTS
 * via `onEvent` with the exact file list + an agent-directed message —
 * reconcile is MANUAL: the agent (or operator) resolves the flagged files and
 * a clean re-run completes it. This replaces the earlier (macf#722 Fix B)
 * silent-skip + separately-force-stashed-restart shape, which could dirty the
 * workspace via `upgrade` and then have `restart-self`'s OWN guard refuse —
 * aborting mid-transaction with the workspace already mutated.
 */
export async function rollFleet(
  plans: readonly AgentUpgradePlan[],
  opts: RollFleetOptions,
  deps: RollFleetDeps,
): Promise<FleetRollResult> {
  const results: AgentRollResult[] = [];
  let upgraded = 0;
  let busySkipped = 0;
  let configDirtySkipped = 0;

  for (const plan of plans) {
    if (plan.disposition !== 'behind') continue;
    const agent = plan.agent;

    // PRE-FLIGHT config-dirty gate. By-design inter-roll STEADY-STATE
    // (macf#725): a clean roll LEAVES `macf update`'s regeneration uncommitted
    // (so the relaunched agent reviews it — see `restart`'s
    // `leaveConfigUncommitted` below + `buildModifiedFilesMessage`).
    // Consequently, the NEXT roll's pre-flight WILL object on that
    // still-uncommitted regen. This is INTENDED HYGIENE — "commit last update's
    // regen before upgrading again" — NOT the mid-run abort bug this revision
    // fixed: it is self-resolving via the object-with-message (the agent
    // commits the flagged regen, then a clean re-run rolls). The alternative —
    // auto-committing the deterministic canonical regen at end-of-transaction
    // (zero inter-roll friction, but trades away the agent's review-visibility
    // of what changed) — is a DEFERRED future option, the operator's call.
    if (!opts.force) {
      const dirtyFiles = await deps.driver.listDirtyConfig(agent);
      if (dirtyFiles.length > 0) {
        configDirtySkipped += 1;
        const message = buildConfigDirtyMessage(agent, dirtyFiles);
        results.push({
          agent,
          outcome: 'config-dirty-skipped',
          detail: message,
        });
        deps.onEvent?.({ kind: 'config-dirty-skip', agent, files: dirtyFiles, message });
        continue;
      }
    }

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

    // --- ENTERING THE TRANSACTION: upgrade + restart run together, always. ---
    deps.onEvent?.({ kind: 'roll-start', agent, from: plan.runningVersion, to: opts.targetVersion });
    await deps.driver.upgrade(agent);
    // The pre-flight gate above (clean, or explicitly `--force`-bypassed) is
    // the only thing that decided whether to enter this transaction. Once
    // entered, `restart` must NOT stash or refuse on the config surface —
    // `upgrade` (macf update) is EXPECTED to have just dirtied it, and that
    // dirt (plus any pre-existing `--force`-bypassed dirt) is deliberately
    // LEFT UNCOMMITTED for the relaunched agent to see via `git status`.
    await deps.driver.restart(agent, { leaveConfigUncommitted: true });
    const green = await deps.verifyGreen({
      agent,
      targetVersion: opts.targetVersion,
      timeoutMs: opts.verifyTimeoutMs,
    });

    if (green.ok) {
      upgraded += 1;
      const modifiedFiles = await deps.driver.listModifiedFiles(agent);
      const message = buildModifiedFilesMessage(agent, modifiedFiles);
      results.push({ agent, outcome: 'upgraded', detail: message });
      deps.onEvent?.({ kind: 'upgraded', agent, version: green.version, modifiedFiles, message });
      continue;
    }

    const reason = classifyHalt(green, plan.runningVersion);
    results.push({
      agent,
      outcome: 'halted',
      reason,
      detail: `${reason}: verify-green ${green.reason} (last=${green.lastVersion ?? 'down'})`,
    });
    deps.onEvent?.({ kind: 'halt', agent, reason, lastVersion: green.lastVersion });
    return { results, halted: true, upgraded, busySkipped, configDirtySkipped };
  }

  return { results, halted: false, upgraded, busySkipped, configDirtySkipped };
}

/** Options for the multi-fleet orchestrator. */
export interface UpgradeFleetsOptions extends RollFleetOptions {
  /** `false` = dry-run: probe + plan + report, NO driver mutations (the default). */
  readonly execute: boolean;
}

/** Injected seams for the multi-fleet orchestrator. */
export interface UpgradeFleetsDeps {
  /**
   * Resolve the driver for a fleet (a PROJECT identifier — macf#710). Production
   * binds `createVmDriverFromConfig` at a representative workspace OF THAT
   * PROJECT (so the driver's mTLS CA + registry namespace are the project's own,
   * never a sibling project's sharing the same registry scope); tests return a
   * fake. `null` ⇒ the fleet cannot be reached (skip + report, NOT a halt).
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
 * Orchestrate a rolling upgrade across the ORDERED `fleets` (PROJECT
 * identifiers — macf#710: a "fleet" == a project, which owns its own CA +
 * registry namespace + version cadence; a profile/org registry scope hosting N
 * projects yields N fleets here, never one), fleet-by-fleet. Each fleet is
 * probed + planned; in EXECUTE mode it is then rolled, and a HALT in one fleet
 * STOPS the whole run — later fleets are never started (a bad release cannot
 * cascade across fleets). An unresolvable fleet is skipped + reported and does
 * NOT halt the run.
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

    const members = driver.discoverWorkspaces().filter((r) => r.project === fleet);
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
