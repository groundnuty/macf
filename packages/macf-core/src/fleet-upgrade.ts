/**
 * The rolling fleet-upgrade DECISION layer (DR-037 / macf#682 Phase 2) — the
 * runtime-agnostic sequencer that promotes the devops `fleet/upgrade.sh`
 * reference impl onto the framework substrate.
 *
 * It is the pure decision half of the DR-037 decision/driver split (OQ2 — pure
 * logic lives in macf-core; the per-runtime driver bodies live in `packages/macf`
 * or a future K8s package). It NEVER touches `/proc`, tmux, `capture-pane`, or
 * kubectl — it drives entirely off the injected `FleetDriver` verbs
 * (`probe`/`discoverWorkspaces`/`isBusy`/`listDirtyConfig`/`currentBranch`/
 * `canonicalBranch`/`upgrade`/`restart`/`listModifiedFiles`/`acquireLock`/
 * `startHeartbeat`/`releaseLock`) plus an
 * injected `verifyGreen` runner, so the SAME sequencer rolls a VM tmux fleet, a
 * macOS host, and a far-future K8s deployment by swapping only the driver.
 *
 * The state machine (per fleet, one agent at a time):
 *
 *   probe() + discoverWorkspaces()
 *     → for each member whose RUNNING version < target (compareSemver):
 *         PRE-FLIGHT gate (BEFORE any mutation — never touches the agent):
 *           branch-gate (macf#755, FIRST — cheapest + most fundamental:
 *             driver.currentBranch != driver.canonicalBranch (or detached
 *             HEAD / unresolvable, i.e. `null`) ⇒ OBJECT: SKIP+REPORT, unless
 *             `--force` — a mutation or relaunch on the wrong branch either
 *             corrupts a feature branch or relaunches the agent stale on it)
 *           config-dirty-gate (driver.listDirtyConfig → non-empty ⇒ OBJECT:
 *             SKIP+REPORT the list of uncommitted files + an agent-directed
 *             message to inspect-and-commit-or-delete-or-gitignore-then-retry,
 *             unless `--force`; macf#725 — TRANSACTIONAL revision of macf#722
 *             Fix B: rather than silently stashing operator dirt, the roll
 *             OBJECTS and does NOTHING until the agent resolves it)
 *           busy-gate (driver.isBusy → busy ⇒ SKIP+REPORT, or `--wait` for idle)
 *         → driver.acquireLock(agent, target)  // DR-040 Decision 4 (macf#752):
 *             SET the maintenance lock BEFORE anything touches the agent, so a
 *             watchdog sweep racing the restart reads "planned maintenance,"
 *             never "unplanned outage." driver.startHeartbeat(agent) then
 *             keeps it fresh across the whole transaction below (background,
 *             decoupled from these awaits); its stop-handle fires exactly
 *             once, on whichever terminal branch is reached.
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
 *               message + list; stopHeartbeat() + driver.releaseLock(agent)
 *               (DR-040 Decision 3 — release ONLY on confirmed clean success);
 *               THEN next agent (`upgraded`)
 *             → confirmed back on the OLD (pre-upgrade) version ⇒ stopHeartbeat()
 *               WITHOUT releasing the lock, then HALT the roll, reason
 *               `bad-release` (a crash-loop / stuck-old-process release stalls
 *               at agent 1 and CANNOT brick the fleet)
 *             → past-grace still NOT confirmed green (down / unreachable /
 *               some other unknown version) ⇒ stopHeartbeat() WITHOUT
 *               releasing the lock, then HALT the roll, reason
 *               `relaunch-unconfirmed` — this is NOT a continue: "not yet
 *               green" cannot distinguish a slow-but-fine relaunch from a
 *               release that crashes on startup (which never shows the old
 *               version either), so continuing past an unconfirmed agent
 *               would risk cascading a crash-on-start release across the
 *               fleet (macf#722 Fix A). Both HALT paths deliberately LEAVE the
 *               lock in place (DR-040 Decision 3) — it self-clears once its
 *               heartbeat goes stale (`MAINT_LOCK_TTL`), giving the operator a
 *               bounded grace window before the watchdog resumes automatic
 *               action on a possibly-broken, mid-transition agent.
 *
 * Multi-fleet (`--fleet a,b,c`) rolls fleet-by-fleet: each fleet's roll must
 * finish without a HALT before the next fleet starts (a bad release in fleet-1
 * stops fleet-2 from ever being touched).
 *
 * DRY-RUN is the default at the command boundary: `execute: false` computes +
 * reports the PLAN (probe + classify) and performs NO driver mutations —
 * `rollFleet` (and therefore the maintenance lock) is never even called on
 * that path; `upgradeFleets` only invokes it when `execute: true`.
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
 * - `branch-skipped`        — branch-gated (macf#755): the agent's workspace
 *                             is not on its canonical branch (or is on a
 *                             detached HEAD / unresolvable branch), BEFORE any
 *                             mutation; NOT a failure, CONTINUES. The roll
 *                             OBJECTS — a mutation (macf update / an
 *                             auto-resolve commit) or a relaunch on the wrong
 *                             branch either corrupts a feature branch or
 *                             relaunches the agent stale on it.
 * - `stale-pin-skipped`     — (macf#899, NEW) verify-green did NOT confirm the
 *                             target version, but the agent's own launch pin
 *                             explains WHY without implicating the release:
 *                             `reason: 'stale-pin'` (see `HaltReason`). Unlike
 *                             `halted`, this is safe to continue past — the
 *                             agent WAS mutated (upgrade + restart already
 *                             ran) but its stale-old-pin state endangers no
 *                             OTHER agent, so `rollFleet` skips it and moves
 *                             on to the next agent in the SAME fleet.
 * - `halted`                — verify-green did NOT confirm the target version,
 *                             and the cause is either a confirmed/unverifiable
 *                             bad release or a genuinely unconfirmed relaunch;
 *                             the roll STOPS here. `reason` distinguishes WHY
 *                             (see `HaltReason`).
 *
 * The three pre-flight skip outcomes (`busy-skipped` / `config-dirty-skipped`
 * / `branch-skipped`) are safe to continue past because the agent was NEVER
 * mutated. `stale-pin-skipped` (macf#899) IS safe to continue past DESPITE the
 * agent having been mutated, because the specific cause (a stale LAUNCH pin)
 * is a property of this one workspace's launch config, not of the release —
 * see `HaltReason`'s `stale-pin` doc for the full reasoning. `halted` is
 * always terminal because the agent WAS rolled and its post-restart state is
 * either confirmed-bad, unverifiable, or unconfirmed — none of those three are
 * safe to leave behind while moving on to the next agent (macf#722 Fix A,
 * extended by macf#899).
 */
export type RollOutcome =
  | 'upgraded'
  | 'busy-skipped'
  | 'config-dirty-skipped'
  | 'branch-skipped'
  | 'stale-pin-skipped'
  | 'halted';

/**
 * WHY a roll's verify-green did not confirm the target version:
 * - `bad-release`           — verify-green confirmed the agent came back up
 *                             REACHABLE at its OLD (pre-upgrade) version, AND
 *                             (macf#899) its own launch pin either already
 *                             matches the target (a genuine crash-loop /
 *                             stuck-old-process release) or could not be
 *                             read at all (honest-unknown, treated
 *                             conservatively — see `classifyHalt`). Terminal;
 *                             `outcome: 'halted'` — stops this fleet's roll +
 *                             later fleets.
 * - `relaunch-unconfirmed`  — past the full verify-green grace budget, the
 *                             agent was never confirmed at the target version:
 *                             down the whole time, unreachable, or reachable at
 *                             some OTHER (neither old-pin nor target) version.
 *                             "Not yet green" cannot distinguish a slow-but-fine
 *                             relaunch from a release that crashes on startup
 *                             (which never shows the old version either), so
 *                             this is deliberately NOT a continue. Terminal;
 *                             `outcome: 'halted'`. UNCHANGED by macf#899 — the
 *                             pin-discrimination below only applies to the
 *                             `bad-release` precondition (a POSITIVELY
 *                             confirmed old-version match), never to this case.
 * - `stale-pin`             — (macf#899, NEW) verify-green confirmed the agent
 *                             came back REACHABLE at its OLD version, but its
 *                             own launch pin asks for a version OTHER than the
 *                             target — the LAUNCHER never asked for the
 *                             upgrade (a stale mounted-plugin pin, macf#889's
 *                             exact failure shape), not a bad release. NOT
 *                             terminal; `outcome: 'stale-pin-skipped'` —
 *                             `rollFleet` skips this ONE agent and CONTINUES,
 *                             because a stale launch pin on one workspace says
 *                             nothing about the release quality and endangers
 *                             no other agent.
 */
export type HaltReason = 'bad-release' | 'relaunch-unconfirmed' | 'stale-pin';

/** The per-agent EXECUTE result. `detail` carries a human-readable summary. */
export interface AgentRollResult {
  readonly agent: string;
  readonly outcome: RollOutcome;
  /**
   * Set when `outcome === 'halted'` OR `outcome === 'stale-pin-skipped'`
   * (macf#899 added the latter) — see `HaltReason`.
   */
  readonly reason?: HaltReason;
  readonly detail?: string;
  /**
   * Files auto-resolved (committed as already-canonical) during this
   * agent's pre-flight, if any (DR-040 Decision 3 / macf#698 R1). Orthogonal
   * to `outcome` — auto-resolve happens BEFORE the outcome is decided, so it
   * can co-occur with ANY outcome: e.g. all dirty files were already-canonical
   * → committed, roll proceeds → `outcome: 'upgraded'` WITH this field set; or
   * some were already-canonical (committed) and some were genuine-delta →
   * `outcome: 'config-dirty-skipped'` (message scoped to the genuine-delta
   * subset only) WITH this field set. Absent when nothing was auto-resolved.
   */
  readonly autoResolvedFiles?: readonly string[];
}

/**
 * The roll's MEANINGFUL config surface (macf#722 Fix B / macf#725 UNION,
 * narrowed by DR-040 Decision 6 / macf#698). The path globs that BOTH
 * consumers of this constant key on:
 *
 *   1. **The dirty-CHECK gate** — `rollFleet`'s pre-flight config-dirty
 *      gate (`isConfigDirty` / `listDirtyConfig` in `vm-driver.ts`) +
 *      `restart-self`'s standalone stash-refusal guard
 *      (`hasUncommittedConfigChanges`). `git status --porcelain -- <pattern>`
 *      → non-empty ⇒ OBJECT / refuse. Narrowing here narrows what OBJECTS.
 *   2. **The `excludeConfigSurface` stash** — `restart-self`'s roll-path
 *      relaunch (`git stash push -- . ':!<pattern>'` per entry) stashes
 *      everything EXCEPT this pattern, so the roll's own `macf update`
 *      regeneration stays uncommitted for the relaunched agent to see. A
 *      path DROPPED from the pattern is therefore no longer excluded → it
 *      gets STASHED on relaunch. For a TRACKED operator-evolution file
 *      (`CLAUDE.md`), that means the agent comes back with it reverted to
 *      HEAD and the edits buried in a stash = silent pre-reconcile loss.
 *
 * Because of use #2, this is a **UNION, not the overwrite-set alone**
 * (macf#725): (a) the files `macf update` OVERWRITES ∪ (b) the
 * operator-evolution files that must NOT be silently stashed on relaunch.
 * The `.claude/**` wildcard was the ONLY bug — it swept in runtime logs
 * (`.claude/audit.log`) + agent scratch that `macf update` never writes,
 * producing false CONFIG-DIRTY objections. This revision replaces ONLY that
 * wildcard with the specific managed paths; the union's meaningful members
 * are preserved.
 *
 * **(a) The exact set `macf update` OVERWRITES** — verified directly against
 * the CLI source (`update.ts` + `env-files-update.ts` + `rules.ts` +
 * `claude-sh.ts` + `host-prelude.ts` + `settings-writer.ts`):
 *
 * - `claude.sh` — `writeClaudeSh` (unconditional for a macf-managed workspace;
 *   preserved only when hand-authored/header-less, in which case it's never
 *   legitimately dirty from `macf update`'s perspective anyway — harmless to
 *   include unconditionally, same reasoning as the prior revision).
 * - `.claude/rules/**` — `copyCanonicalRules` (universal `.claude/rules/*.md`)
 *   + `fetchProjectRules` (project-tier `.claude/rules/project/*.md`); both
 *   land under this one glob.
 * - `.claude/scripts/**` — `copyCanonicalScripts`. Still the exact overwrite
 *   set as of DR-039 phase 2 (macf#749, hook SCRIPT FILES moved to
 *   `plugin/scripts/`): `macf update` still writes a `.claude/scripts/`
 *   compat copy for hand-wired substrate hooks + non-plugin-init'd
 *   workspaces (see `rules.ts` `copyCanonicalScripts` doc comment). Drop this
 *   entry once that compat copy is retired.
 * - `.claude/settings.json` — `installGhTokenHook` / `installPluginSkillPermissions`
 *   / `installSandboxFdAllowRead` / `installSandboxExcludedCommands` (all
 *   merge-preserving writers targeting this one file). Deliberately EXCLUDES
 *   `.claude/settings.local.json` — `macf update` only ever READS it (for the
 *   getters' merged-view), never writes it (+ it's gitignored → never dirty
 *   in the first place → no stash risk).
 * - `.claude/.macf/env._helpers` / `env.identity` / `env.github` / `env.certs`
 *   / `env.registry` — the 5 `MANAGED_ENV_FILES` (`env-files-update.ts`),
 *   regenerated unconditionally + warn-on-hand-edit. Deliberately EXCLUDES the
 *   2 `OPERATOR_ENV_FILES` (`env.telemetry`, `env.tmux` — bootstrap-write-if-
 *   absent, else preserved unconditionally).
 * - `.claude/.macf/host-prelude.sh` — `writeHostPrelude`, "macf-managed +
 *   RE-DETECTED (never preserve-existing)" per its own doc comment
 *   (`host-prelude.ts`). Genuinely overwritten every `macf update` run; ADDED
 *   here (the prior `.claude/**` wildcard caught it incidentally — narrowing
 *   the wildcard away would have silently dropped coverage for this file
 *   without this explicit addition).
 *
 * **(b) The operator-evolution surface that must NOT be silently stashed**
 * (macf#725 union half — kept, NOT dropped, per the use-#2 reasoning above):
 *
 * - `CLAUDE.md` — TRACKED operator/workbench doc. `macf update` never writes
 *   it (no write path in any CLI command), so it's NOT an overwrite-set
 *   member — but it IS a meaningful operator-evolution file: a dirty
 *   `CLAUDE.md` legitimately warrants a gate objection (unlike `audit.log`,
 *   it's real work, not runtime noise), and it MUST stay in the pattern so
 *   `excludeConfigSurface` leaves it uncommitted rather than stashing the
 *   operator's edits away on relaunch (verified TRACKED → live stash-loss
 *   hazard if dropped).
 * - `env.local.*` — the operator-custom env-extension slot (bare pathspec,
 *   preserved verbatim from the prior union). Untracked in practice (so no
 *   live stash risk today), but kept for union fidelity + zero-cost safety as
 *   a genuine operator-surface member.
 *
 * **Motivating incident** (devops review, PR #748 / macf#698): the prior
 * `.claude/**` wildcard matched `.claude/audit.log` — a runtime log a custom
 * `ConfigChange` hook appends to (hence perpetually git-dirty on that
 * workspace) that `macf update` never writes — and **blocked devops's
 * v0.2.48 fleet upgrade** with a false CONFIG-DIRTY objection on 2026-07-02.
 * Untracking `audit.log` itself (the `.gitignore` force-include +
 * `git rm --cached`) is a separate, devops-owned LOCAL workspace cleanup —
 * out of scope here; this pattern-narrowing is the FRAMEWORK-side fix so no
 * future non-canonical `.claude/` file (runtime logs, agent scratch, custom-
 * hook output) can trip the gate at all, regardless of gitignore state on any
 * given workspace.
 *
 * Both gate consumers already pathspec-filter their `git status --porcelain`
 * calls by this exact array (as does the stash), so this revision narrows
 * ALL consumers' behavior identically; no separate no-pathspec fix was needed
 * at any call site.
 */
export const ROLL_TOUCHED_CONFIG_PATTERNS = [
  // (a) the exact set `macf update` OVERWRITES:
  'claude.sh',
  '.claude/rules/**',
  '.claude/scripts/**',
  '.claude/settings.json',
  '.claude/.macf/env._helpers',
  '.claude/.macf/env.identity',
  '.claude/.macf/env.github',
  '.claude/.macf/env.certs',
  '.claude/.macf/env.registry',
  '.claude/.macf/host-prelude.sh',
  // (b) operator-evolution files that must NOT be silently stashed on relaunch
  //     (macf#725 union half — `excludeConfigSurface` leaves these uncommitted):
  'CLAUDE.md',
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
  /**
   * Count of agents skipped because their config surface still had a
   * GENUINE-DELTA file after tiering (macf#722 Fix B; scope narrowed to
   * genuine-delta-only by DR-040 Decision 3 / macf#698 R1 — an agent whose
   * ENTIRE dirty set was already-canonical is auto-resolved instead and does
   * NOT count here).
   */
  readonly configDirtySkipped: number;
  /**
   * Count of agents that had ≥1 dirty file auto-resolved (committed as
   * already-canonical) this roll (DR-040 Decision 3 / macf#698 R1). Same
   * per-agent-count style as the other counters; see each result's
   * `autoResolvedFiles` for the file-level detail.
   */
  readonly configAutoResolved: number;
  /**
   * Count of agents skipped because their workspace was NOT on its
   * canonical branch (or was on a detached HEAD / unresolvable branch) —
   * macf#755's pre-flight branch-gate, the FIRST gate in the transaction.
   */
  readonly branchSkipped: number;
  /**
   * Count of agents skipped because verify-green confirmed them REACHABLE
   * at their OLD version AND their own launch pin explained why without
   * implicating the release (`reason: 'stale-pin'`, macf#899) — POST-flight
   * (the agent WAS mutated: upgrade + restart already ran), unlike the other
   * skip counters above, but still safe to continue past — see `HaltReason`.
   */
  readonly stalePinSkipped: number;
}

/** Progress events for CLI rendering (the RESULT objects are what tests assert on). */
export type UpgradeEvent =
  | { readonly kind: 'fleet-start'; readonly fleet: string; readonly behind: number; readonly total: number }
  | { readonly kind: 'fleet-skipped'; readonly fleet: string; readonly reason: string }
  | { readonly kind: 'roll-start'; readonly agent: string; readonly from: string | null; readonly to: string }
  /**
   * The pre-flight BRANCH-GATE OBJECT (macf#755) — the FIRST gate, fired
   * BEFORE the config-dirty tiering / auto-resolve / busy-gate even run for
   * this agent. `current` is the agent's actual branch (`null` on detached
   * HEAD / an unresolvable branch); `canonical` is the resolved expected
   * branch. Fired INSTEAD of any mutation — nothing was touched.
   */
  | { readonly kind: 'branch-skip'; readonly agent: string; readonly current: string | null; readonly canonical: string }
  /**
   * The pre-flight AUTO-RESOLVE (DR-040 Decision 3 / macf#698 R1) — `files`
   * were dirty but their content already equalled canonical, so they were
   * committed automatically; no agent/operator involvement. Fired BEFORE the
   * genuine-delta OBJECT check (if any) + before the busy-gate / transaction,
   * for the SAME agent this iteration — an agent can see BOTH this event AND
   * a subsequent `config-dirty-skip` (for the remaining genuine-delta files)
   * in the same roll.
   */
  | { readonly kind: 'config-auto-resolved'; readonly agent: string; readonly files: readonly string[] }
  /**
   * The pre-flight OBJECT (macf#725; scope narrowed to GENUINE-DELTA files
   * only by DR-040 Decision 3 / macf#698 R1 — already-canonical files were
   * auto-resolved above and are never part of this list). `files` is the
   * exact genuine-delta uncommitted-path list; `message` is the
   * ready-to-forward, agent-directed text (inspect + commit / delete /
   * gitignore, then re-run). Fired INSTEAD of any mutation — nothing on this
   * agent's genuine-delta files was touched (though the already-canonical
   * subset, if any, WAS committed by the preceding `config-auto-resolved`).
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
  | { readonly kind: 'halt'; readonly agent: string; readonly reason: HaltReason; readonly lastVersion: string | null }
  /**
   * The POST-restart STALE-PIN skip (macf#899) — verify-green confirmed the
   * agent came back reachable at its OLD version, but its own launch `pin`
   * (read via `driver.readVersionPin`) asks for a version other than
   * `target`, so `rollFleet` skips this agent (NOT a halt) and continues to
   * the next one. Distinct from `halt`: the agent WAS mutated here too, but
   * the cause doesn't implicate the release.
   */
  | { readonly kind: 'stale-pin-skip'; readonly agent: string; readonly pin: string; readonly target: string };

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

/** The discriminated result of `classifyHalt` — `pin` is only ever populated on the branches that actually read it. */
type HaltClassification =
  | { readonly reason: 'relaunch-unconfirmed'; readonly detail: string }
  | { readonly reason: 'bad-release'; readonly detail: string; readonly pin: string | null }
  | { readonly reason: 'stale-pin'; readonly detail: string; readonly pin: string };

/**
 * Classify a failed verify-green against the agent's PRE-upgrade running
 * version (macf#722 Fix A) — UNCHANGED precondition — then, ONLY when that
 * precondition confirms `bad-release`, discriminate further against the
 * agent's LAUNCH PIN (macf#899) before finalizing the diagnosis.
 *
 * ## The macf#722 Fix A precondition (UNCHANGED)
 *
 * `bad-release`-shaped confirmation requires POSITIVE proof that the agent
 * came back reachable at the OLD pin — everything else (never reachable, or
 * reachable at some other unrecognized version) stays `relaunch-unconfirmed`,
 * exactly as before macf#899. Never infer a bad-release SHAPE from absence of
 * success; only from the last-seen version actually matching the old pin.
 * This half is deliberately untouched — macf#899's own author explicitly
 * retracted an earlier proposal to touch `relaunch-unconfirmed`'s semantics.
 *
 * ## The macf#899 pin-discriminator (NEW)
 *
 * A "confirmed reachable at OLD version" agent used to be named
 * `bad-release` unconditionally. The 0.2.56 roll (this issue's incident)
 * showed that conflates two causes with OPPOSITE fleet-safety implications:
 * a genuinely stuck/crash-looping release (cascading risk is real — HALT) vs
 * a launcher that never asked for the target in the first place (a stale
 * mounted-plugin pin, macf#889's exact failure shape — no cascading risk to
 * any OTHER agent — skip and CONTINUE). The discriminator is
 * `driver.readVersionPin(agent)` — the SAME mounted-manifest primitive
 * `macf update`'s own post-write verification already reads (macf#889/#896)
 * — compared against `targetVersion`:
 *
 * - `pin === targetVersion` → the launcher DID ask correctly → `bad-release`
 *   (unchanged terminal semantics, now positively cross-checked rather than
 *   assumed).
 * - `pin !== targetVersion` (non-null) → `stale-pin` (NEW, non-terminal —
 *   `rollFleet` skips this agent and continues).
 * - `pin === null` (mount undeterminable, manifest absent/malformed, or no
 *   channel-server pin present at all) → honest-unknown. NEITHER cause is
 *   evidenced. Per the issue's explicit constraint this must NOT silently
 *   become `stale-pin` (would skip an agent that might really be
 *   crash-looping — reintroducing the exact risk macf#722 Fix A closed for
 *   `relaunch-unconfirmed`) and must NOT silently masquerade as a
 *   fully-CONFIRMED `bad-release` either. **Judgment call** (documented in
 *   the implementation report): keep `reason: 'bad-release'` — i.e. preserve
 *   the PRE-macf#899 conservative default of halting, since an UNVERIFIED
 *   old-version confirmation carries the same cascading risk an unconfirmed
 *   one does — but the `detail` message says PLAINLY that the pin could not
 *   be read, so the reason string alone is never mistaken for a positively
 *   confirmed diagnosis, and the operator's remedy is "check the launch
 *   pin/mount," not "assume the release is broken."
 */
async function classifyHalt(
  green: VerifyGreenResult & { readonly ok: false },
  oldVersion: string | null,
  targetVersion: string,
  agent: string,
  driver: FleetDriver,
): Promise<HaltClassification> {
  const base = `verify-green ${green.reason} (last=${green.lastVersion ?? 'down'})`;
  const confirmedOldVersion =
    green.reason === 'wrong-version' &&
    green.lastVersion !== null &&
    oldVersion !== null &&
    compareSemver(green.lastVersion, oldVersion) === 0;

  if (!confirmedOldVersion) {
    return { reason: 'relaunch-unconfirmed', detail: `relaunch-unconfirmed: ${base}` };
  }

  // macf#899 — POSITIVELY confirmed reachable-at-OLD-version. Read the
  // agent's own launch pin before naming this a bad release.
  const pin = await driver.readVersionPin(agent);

  if (pin === null) {
    return {
      reason: 'bad-release',
      detail:
        `bad-release: ${base} — UNVERIFIED (launch pin unreadable: mount undeterminable, ` +
        `manifest absent/malformed, or no channel-server pin present) — NOT a confirmed bad ` +
        `release; verify ${agent}'s claude.sh --plugin-dir mount + plugin.json pin BEFORE ` +
        `assuming the ${targetVersion} release itself is broken. Halting conservatively.`,
      pin: null,
    };
  }

  if (compareSemver(pin, targetVersion) === 0) {
    return {
      reason: 'bad-release',
      detail:
        `bad-release: ${base} — CONFIRMED (launch pin @${pin} already matches target ` +
        `@${targetVersion}; the process is stuck/crash-looping on the old version despite ` +
        `asking for the right one). Remedy: investigate ${agent}'s release/process, not its ` +
        `launch config.`,
      pin,
    };
  }

  return {
    reason: 'stale-pin',
    detail:
      `stale-pin: ${base} — launch pin @${pin} != target @${targetVersion}; the LAUNCHER ` +
      `never asked for the upgrade (a stale --plugin-dir mount / manifest pin), not a bad ` +
      `release. Remedy: fix ${agent}'s launch pin (e.g. re-run \`macf update\` against its ` +
      `mounted plugin dir), then re-roll it — the fleet roll CONTINUES to the next agent; a ` +
      `stale pin on one workspace endangers no other agent.`,
    pin,
  };
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
 * Build the agent-directed OBJECT message for the branch-gate pre-flight skip
 * (macf#755). Pure — exported for CLI-rendering reuse / tests.
 */
export function buildBranchSkipMessage(
  agent: string,
  current: string | null,
  canonical: string,
): string {
  const branchDesc =
    current === null ? 'a detached HEAD (or an unresolvable branch)' : `branch \`${current}\``;
  return (
    `Fleet upgrade skipped ${agent} — on ${branchDesc}, expected \`${canonical}\`. ` +
    `A mutation (macf update / an auto-resolve commit) or a relaunch would land on the ` +
    `wrong branch. Switch the workspace to \`${canonical}\` (or set canonicalBranch / ` +
    `MACF_CANONICAL_BRANCH if this is a legitimate fork), then re-run the upgrade, or ` +
    `pass --force to bypass.`
  );
}

/**
 * Roll ONE fleet: for every `behind` plan (in order) run the PRE-FLIGHT gates
 * (branch-gate FIRST, then config-dirty tier-first, then busy) → upgrade →
 * restart → verify-green cycle, HALTING the roll on the first agent whose
 * post-restart state isn't confirmed-green. Non-`behind` plans are ignored
 * (planned skips). Pre-flight-gated agents are skipped + reported and NEVER a
 * halt (they were never mutated, so continuing is always safe) — the
 * branch-gate runs first (cheapest + most fundamental: branch-correctness
 * precedes config-correctness — a mutation on the wrong branch is unsafe
 * regardless of that branch's config-dirty state), then config-dirty (checked
 * before busy because a busy-but-clean agent may still become idle later via
 * `--wait`, whereas a dirty (genuine-delta) agent is skip-only regardless).
 * With `wait`, a busy agent is re-polled for idle first. The verb order +
 * HALT semantics mirror `fleet/upgrade.sh`'s `roll_one`.
 *
 * **Branch-gate (macf#755).** Before any other gate: resolve the agent's
 * CURRENT branch (`deps.driver.currentBranch`) and its CANONICAL branch
 * (`deps.driver.canonicalBranch`). Detached HEAD / an unresolvable branch
 * (`currentBranch` returns `null`) is ALWAYS treated as non-canonical — never
 * a safe mutate+relaunch target. A mismatch OBJECTS (`branch-skipped`) and
 * skips the agent entirely — no `classifyDirtyConfig`, no `isBusy`, no
 * `upgrade`/`restart`, no maintenance-lock activity. `--force` bypasses this
 * gate exactly like it bypasses the config-dirty gate (same flag, same
 * "I know what I'm doing" escape hatch).
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
 *
 * **Tier-first auto-resolve (DR-040 Decision 3 / macf#698 R1).** Before
 * deciding OBJECT-or-proceed, `deps.driver.classifyDirtyConfig` splits the
 * dirty set into `alreadyCanonical` (content already equals what `macf
 * update` would write — the common case: a stale-branch workspace, both
 * code-agent AND science hit ONLY this tier on the v0.2.48 roll) and
 * `genuineDelta` (a real local difference). `alreadyCanonical` files are
 * committed automatically via `autoResolveCanonical` — no agent/operator
 * involvement, no OBJECT — clearing the false config-dirty signal. Only a
 * non-empty `genuineDelta` still triggers the OBJECT-and-skip path, and its
 * message + `onEvent` payload are scoped to the genuine-delta files ONLY
 * (the auto-resolved noise is never re-surfaced as something to inspect).
 * When `genuineDelta` is empty (either the whole dirty set was
 * already-canonical, or there was nothing dirty at all), the roll falls
 * through into the transaction exactly as the clean case always has.
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
  let configAutoResolved = 0;
  let branchSkipped = 0;
  let stalePinSkipped = 0;

  for (const plan of plans) {
    if (plan.disposition !== 'behind') continue;
    const agent = plan.agent;

    // PRE-FLIGHT branch-gate (macf#755) — the FIRST gate, before config-dirty
    // or busy. Detached HEAD / unresolvable (`current === null`) is ALWAYS
    // non-canonical.
    if (!opts.force) {
      const canonical = await deps.driver.canonicalBranch(agent);
      const current = await deps.driver.currentBranch(agent);
      if (current === null || current !== canonical) {
        branchSkipped += 1;
        const message = buildBranchSkipMessage(agent, current, canonical);
        results.push({ agent, outcome: 'branch-skipped', detail: message });
        deps.onEvent?.({ kind: 'branch-skip', agent, current, canonical });
        continue;
      }
    }

    // PRE-FLIGHT config-dirty gate — tier-first (DR-040 Decision 3 /
    // macf#698 R1). By-design inter-roll STEADY-STATE (macf#725): a clean
    // roll LEAVES `macf update`'s regeneration uncommitted (so the relaunched
    // agent reviews it — see `restart`'s `leaveConfigUncommitted` below +
    // `buildModifiedFilesMessage`). Consequently, the NEXT roll's pre-flight
    // will re-classify that still-uncommitted regen — almost always as
    // ALREADY-CANONICAL (it IS what `macf update` just wrote) and therefore
    // auto-resolved here rather than objected on. This is the steady-state
    // this tier exists to smooth over.
    let autoResolvedFiles: readonly string[] | undefined;
    if (!opts.force) {
      const { alreadyCanonical, genuineDelta } = await deps.driver.classifyDirtyConfig(agent);

      if (alreadyCanonical.length > 0) {
        await deps.driver.autoResolveCanonical(agent, alreadyCanonical);
        configAutoResolved += 1;
        autoResolvedFiles = alreadyCanonical;
        deps.onEvent?.({ kind: 'config-auto-resolved', agent, files: alreadyCanonical });
      }

      if (genuineDelta.length > 0) {
        configDirtySkipped += 1;
        const message = buildConfigDirtyMessage(agent, genuineDelta);
        results.push({
          agent,
          outcome: 'config-dirty-skipped',
          detail: message,
          ...(autoResolvedFiles ? { autoResolvedFiles } : {}),
        });
        deps.onEvent?.({ kind: 'config-dirty-skip', agent, files: genuineDelta, message });
        continue;
      }
      // genuineDelta is empty (nothing dirty at all, or everything dirty WAS
      // already-canonical and is now committed) — fall through into the
      // transaction below exactly as the always-clean case does.
    }

    let busy = await deps.driver.isBusy(agent);
    let waited = false;
    if (busy && opts.wait) {
      waited = true;
      busy = !(await waitForIdle(agent, opts, deps));
    }
    if (busy) {
      busySkipped += 1;
      results.push({
        agent,
        outcome: 'busy-skipped',
        detail: waited ? 'still busy after --wait' : 'busy',
        ...(autoResolvedFiles ? { autoResolvedFiles } : {}),
      });
      deps.onEvent?.({ kind: 'busy-skip', agent, waited });
      continue;
    }

    // --- ENTERING THE TRANSACTION: upgrade + restart run together, always. ---
    deps.onEvent?.({ kind: 'roll-start', agent, from: plan.runningVersion, to: opts.targetVersion });
    // DR-040 Decision 4 (macf-devops-toolkit#158/#159, macf#752) — SET the
    // maintenance lock BEFORE anything touches the agent's process, so a
    // watchdog sweep racing the very first SIGTERM already reads "planned
    // maintenance," never "unplanned outage." The background heartbeat keeps
    // the lock fresh across the WHOLE transaction below (upgrade → restart →
    // verify-green can each individually take a while); `stopHeartbeat` is
    // invoked exactly once, on whichever terminal branch is reached.
    await deps.driver.acquireLock(agent, opts.targetVersion);
    const stopHeartbeat = deps.driver.startHeartbeat(agent);
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
      results.push({
        agent,
        outcome: 'upgraded',
        detail: message,
        ...(autoResolvedFiles ? { autoResolvedFiles } : {}),
      });
      deps.onEvent?.({ kind: 'upgraded', agent, version: green.version, modifiedFiles, message });
      // Clean GREEN is the ONLY release path (DR-040 Decision 3) — hand the
      // agent back to normal watchdog reconciliation immediately.
      stopHeartbeat();
      await deps.driver.releaseLock(agent);
      continue;
    }

    const classification = await classifyHalt(green, plan.runningVersion, opts.targetVersion, agent, deps.driver);
    const { reason, detail } = classification;

    if (reason === 'stale-pin') {
      // macf#899 — SAFE TO CONTINUE despite the agent having been mutated
      // (upgrade + restart already ran): the post-restart old-version state
      // is explained by a stale LAUNCH pin, not a bad release, and a stale
      // pin on ONE workspace endangers no OTHER agent — unlike `bad-release`,
      // where the release itself might be broken and must not cascade. Leave
      // the maintenance lock in place (DR-040 Decision 3 — "release ONLY on
      // confirmed clean success"; this agent is NOT confirmed clean): a
      // still-old, mid-transition agent should not be handed straight back to
      // the watchdog's healing ladder either. Only the heartbeat stops here;
      // the lock self-clears via MAINT_LOCK_TTL, same as a genuine halt.
      stalePinSkipped += 1;
      results.push({
        agent,
        outcome: 'stale-pin-skipped',
        reason,
        detail,
        ...(autoResolvedFiles ? { autoResolvedFiles } : {}),
      });
      deps.onEvent?.({ kind: 'stale-pin-skip', agent, pin: classification.pin, target: opts.targetVersion });
      stopHeartbeat();
      continue;
    }

    results.push({
      agent,
      outcome: 'halted',
      reason,
      detail,
      ...(autoResolvedFiles ? { autoResolvedFiles } : {}),
    });
    deps.onEvent?.({ kind: 'halt', agent, reason, lastVersion: green.lastVersion });
    // HALT deliberately LEAVES the lock in place (DR-040 Decision 3): a
    // possibly-broken, mid-transition agent must NOT be handed straight back
    // to the watchdog's Tier-1/2/3 healing ladder the instant the roll fails
    // — that is exactly the uncoordinated, racing intervention the
    // transactional halt exists to avoid. Only the background heartbeat is
    // stopped here; the lock self-clears once its heartbeat goes stale
    // (MAINT_LOCK_TTL), giving the operator a bounded grace window to
    // inspect the halted roll before the watchdog resumes automatic action.
    stopHeartbeat();
    return {
      results,
      halted: true,
      upgraded,
      busySkipped,
      configDirtySkipped,
      configAutoResolved,
      branchSkipped,
      stalePinSkipped,
    };
  }

  return {
    results,
    halted: false,
    upgraded,
    busySkipped,
    configDirtySkipped,
    configAutoResolved,
    branchSkipped,
    stalePinSkipped,
  };
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
