/**
 * `macf bootstrap apply`'s version-reconcile phase (DR-043 Amendment L,
 * groundnuty/macf#1045).
 *
 * WHY: the operator's objection, verbatim — *"I would like to object [that]
 * we should ever need to run apply, not upgrade... we should be thinking in
 * terms of `kubectl apply`."* Amendment L's ruling: `versions:` in
 * `fleet.yaml` is AUTHORITATIVE desired state, and `apply` reconciles toward
 * it — by CALLING the existing `macf fleet upgrade` roll machinery, never
 * reimplementing it.
 *
 * **Golden-path rule (macf#1000; the SAME rule #1023 applied to deploy,
 * applied here to the version roll).** This module calls
 * `@groundnuty/macf-core`'s {@link upgradeFleets} — the exact sequencer
 * `commands/fleet-upgrade.ts`'s `runFleetUpgrade` itself calls — never a
 * reimplementation of the roll one agent at a time / busy-gate /
 * config-dirty pre-flight / per-agent verify-green / transactional rollback
 * properties Amendment L2 names as load-bearing. Only the CLI-specific glue
 * around it (target resolution, driver resolution, verify-green wiring) is
 * apply-shaped here — and even THAT glue is shared with `commands/
 * fleet-upgrade.ts` via `version-target.ts` / `roll-verify-green.ts` rather
 * than duplicated (see those modules' docs).
 *
 * **Ruling 4 (absent `versions:` = no opinion, not latest) gates the WHOLE
 * phase** — `runApplyVersionPhase` returns `{ attempted: false }` and never
 * touches `deps.discover` / `deps.resolveDriver` / `deps.fetchLatest` when
 * `manifest.versions` is undefined, mirroring `computePlan`'s own gate
 * (`plan.ts`'s `if (manifest.versions) { ... }`) — apply must never decide
 * something `plan` never showed the operator.
 *
 * **No vault/identity-key gate, deliberately.** Unlike the deploy phase
 * (which needs vault access to materialize NEW secrets), rolling an
 * ALREADY-deployed agent needs only a live, locally-discoverable workspace —
 * `upgradeFleets`'s own `resolveDriver` returning `null` (no matching
 * workspace on this host) is a graceful SKIP + report, never a halt (see
 * `@groundnuty/macf-core`'s `upgradeFleets` doc) — so attempting the phase
 * unconditionally (whenever `versions:` is declared) cannot make an
 * apply run fail just because nothing local is reachable yet.
 *
 * **Never restarts a busy agent, never interrupts one.** Entirely
 * `rollFleet`'s own gate (macf-core) — this module adds no gate of its own
 * and removes none of macf-core's.
 */
import type { FleetDriver, FleetPlanReport, FleetRollResult, WorkspaceRecord } from '@groundnuty/macf-core';
import { upgradeFleets, type UpgradeEvent } from '@groundnuty/macf-core';
import type { FleetManifest } from './fleet-manifest.js';
import { resolveTargetVersion } from './version-target.js';
import { makeReResolvingVerifyGreen } from './roll-verify-green.js';

/**
 * Per-agent verify-green budget (ms) — mirrors `commands/fleet-upgrade.ts`'s
 * `DEFAULT_VERIFY_TIMEOUT_MS` (kept as a separate constant rather than an
 * import to avoid a `bootstrap/` → `commands/` dependency for a single
 * numeric literal; see that module's doc for why 120s is sized the way it
 * is — a relaunch-aware grace, not a tight poll timeout, macf#722 Fix A).
 */
const VERIFY_TIMEOUT_MS = 120_000;

/**
 * Injectable seams — mirrors `commands/fleet-upgrade.ts`'s `FleetUpgradeDeps`
 * (minus `defaultFleet`/`manifestVersion`, both derived from the `manifest`
 * argument at call time — there is exactly one fleet in apply's context, the
 * manifest's own, never a selector). Production wires real functions via
 * `commands/bootstrap-apply.ts::resolveApplyVersionDeps`; tests supply
 * fakes.
 */
export interface ApplyVersionPhaseDeps {
  /** The registry-free host workspace scan (grouped into fleets by `project`, macf#710). */
  readonly discover: () => readonly WorkspaceRecord[];
  /** Resolve a per-fleet driver — same contract as `FleetUpgradeDeps.resolveDriver`. */
  readonly resolveDriver: (fleet: string) => Promise<FleetDriver | null>;
  /**
   * Resolve npm-latest of `@groundnuty/macf`. Present for shape-parity with
   * `FleetUpgradeDeps` and defensive-only — `manifest.versions.macf` is
   * schema-REQUIRED once `versions:` is declared (`FleetVersionsSchema`),
   * so `resolveTargetVersion`'s manifest-authoritative branch always
   * resolves before this could ever be reached (DR-043 Amendment L3).
   */
  readonly fetchLatest: () => Promise<string | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** DR-043 §D6 write-back (macf#907) — same contract as `FleetUpgradeDeps.recordDeployedVersion`; optional, omitted ⇒ no write. */
  readonly recordDeployedVersion?: (agent: string, fleet: string, version: string) => Promise<void>;
  /**
   * The golden-path seam (macf#1000 / #1024's identity-assertion shape) —
   * REQUIRED, not optional-with-an-internal-default: the ONE place that
   * decides what "the roll" means is the production wiring site
   * (`resolveApplyVersionDeps(manifestPath)`), so identity is assertable
   * there directly (`expect(resolveApplyVersionDeps(p).runUpgradeFleetsFn)
   * .toBe(upgradeFleets)` — see `apply-deps-wiring.test.ts`) rather than at
   * a fallback buried inside this module that a same-signature wrapper
   * could silently replace unnoticed.
   */
  readonly runUpgradeFleetsFn: typeof upgradeFleets;
}

export interface ApplyVersionPhaseResult {
  /** `false` when `manifest.versions` is absent (Amendment L2.4 — no opinion, nothing attempted). */
  readonly attempted: boolean;
  /** The manifest-declared target this run reconciled toward — present only when `attempted`. */
  readonly target?: string;
  /** `true` when the roll HALTED (a bad release) — present only when `attempted`. */
  readonly halted?: boolean;
  /** Narration lines this phase emitted (via `deps.log`) — for CLI rendering. */
  readonly logLines?: readonly string[];
  /**
   * groundnuty/macf#1053 — agents this run actually rolled + verified green
   * (`outcome === 'upgraded'` in the roll's own report), by name. Reporting
   * only — computed from the SAME `report` `runUpgradeFleetsFn` already
   * returns, never a second decision about what to roll. Present only when
   * `attempted` (empty array is a real, distinct value: "attempted, rolled
   * nothing" — NOT the same as absent/not-attempted).
   */
  readonly rolledAgents?: readonly string[];
  /**
   * groundnuty/macf#1053 — `true` when the fleet's driver could not be
   * resolved locally AT ALL (`report.fleets[0].skipped`, e.g.
   * `'driver-unresolved'` — no representative workspace for this project on
   * this host) — the roll never got to examine a single member. Distinct
   * from "examined members, rolled none of them" (`rolledAgents: []` with
   * this `false`): naming THIS case "could not attempt" rather than folding
   * it into a generic no-op is the whole point of this issue.
   */
  readonly unreachable?: boolean;
  /** groundnuty/macf#1053 — fleet members discovered locally this run (`report.fleets[0].plans.length`), for the "0 of N" no-op phrasing. `0` when `unreachable`. */
  readonly totalMembers?: number;
  /**
   * groundnuty/macf#1053 — non-zero pre-flight skip-category counts
   * (off-canonical-branch / config-dirty / busy / stale-pin) explaining WHY
   * a member that WAS behind target still didn't roll, in priority order.
   * Empty when nothing was behind target at all (see {@link totalMembers}).
   */
  readonly skipBreakdown?: readonly string[];
  /**
   * groundnuty/macf#1053 — `true` when THIS apply run was invoked without
   * both `--vault`/`--identity-key` (mirrors `bootstrap-apply.ts`'s own
   * `deploySkipReason` gate). Set by the caller (`resolveApplyVersionDeps`'s
   * consumer in `commands/bootstrap-apply.ts`), never by this module — this
   * phase itself needs no vault access (see the module doc) and has no CLI
   * flags to read. Rendered as an adjacent FACT alongside a no-op reason,
   * never as an asserted CAUSE (the roll's own driver-resolution / pre-flight
   * gates are independent of these flags — see #1053's own investigation).
   */
  readonly flagless?: boolean;
}

/**
 * groundnuty/macf#1053 — non-zero pre-flight skip-category counts from one
 * fleet's EXECUTE-mode roll result, in priority order (mirrors the gate
 * ORDER `rollFleet` itself applies: branch, then config-dirty, then busy,
 * then stale-pin). Pure; only counts a member once (each `behind` plan
 * produces exactly one `AgentRollResult`, `rollFleet`'s own invariant), so
 * the parts never double-count.
 */
export function versionRollSkipBreakdown(rolled: FleetRollResult): readonly string[] {
  const parts: string[] = [];
  if (rolled.branchSkipped > 0) parts.push(`${String(rolled.branchSkipped)} off-canonical-branch`);
  if (rolled.configDirtySkipped > 0) parts.push(`${String(rolled.configDirtySkipped)} config-dirty`);
  if (rolled.busySkipped > 0) parts.push(`${String(rolled.busySkipped)} busy`);
  if (rolled.stalePinSkipped > 0) parts.push(`${String(rolled.stalePinSkipped)} stale-pin`);
  return parts;
}

/**
 * `macf bootstrap apply`'s version-reconcile phase entry point. Called AFTER
 * `applyFleet` (the GitHub-side provisioning) and the deploy phase (macf#1013)
 * — by that point, an agent this run just deployed has a fresh, locally
 * discoverable `.macf/`-marker workspace (`deployAgent`'s `initAgent` call
 * writes it), so `deps.discover()` sees it in the SAME run.
 */
export async function runApplyVersionPhase(
  manifest: FleetManifest,
  deps: ApplyVersionPhaseDeps,
): Promise<ApplyVersionPhaseResult> {
  // Ruling 4 (DR-043 Amendment L2.4) — versions: ABSENT means NO OPINION:
  // skip the roll entirely, never touch discover/resolveDriver/fetchLatest.
  // Mirrors `computePlan`'s own gate — apply must not decide something
  // `plan` never showed the operator.
  if (!manifest.versions) {
    return { attempted: false };
  }

  const targetR = await resolveTargetVersion(
    undefined, // apply has no --target override surface — the manifest IS the desired state (L2.3)
    { given: true, macf: manifest.versions.macf },
    deps.fetchLatest,
  );
  // Amendment L3 — schema-guaranteed unreachable in practice (`versions.macf`
  // is a required, non-empty string once `versions:` is declared), but
  // handled explicitly rather than asserted-away: a manifest somehow
  // reaching this with an empty target is "no opinion", not a crash.
  if (targetR.kind !== 'resolved') {
    deps.log(`macf bootstrap apply (version phase): ${targetR.message}`);
    return { attempted: false };
  }

  const logLines: string[] = [];
  const log = (line: string): void => {
    logLines.push(line);
    deps.log(line);
  };
  const onEvent = (ev: UpgradeEvent): void => log(`   ${formatVersionRollEvent(ev)}`);

  const { resolveDriver, verifyGreen } = makeReResolvingVerifyGreen(deps.resolveDriver, deps.sleep, deps.now);

  log(`macf bootstrap apply — version-reconcile phase: target macf@${targetR.target}`);
  const report = await deps.runUpgradeFleetsFn(
    [manifest.metadata.name],
    { execute: true, targetVersion: targetR.target, verifyTimeoutMs: VERIFY_TIMEOUT_MS },
    {
      resolveDriver,
      verifyGreen,
      sleep: deps.sleep,
      now: deps.now,
      onEvent,
      recordDeployedVersion: deps.recordDeployedVersion,
    },
  );

  // groundnuty/macf#1053 — apply calls `runUpgradeFleetsFn` with EXACTLY one
  // fleet name (`[manifest.metadata.name]`, above), so `report.fleets` always
  // has length 1 in practice; `[0]` is still `FleetPlanReport | undefined`
  // under `noUncheckedIndexedAccess`, and an absent report renders as
  // `unreachable` rather than ever being able to claim a roll happened.
  const fleetReport = report.fleets[0];
  return { attempted: true, target: targetR.target, halted: report.halted, logLines, ...summarizeVersionRoll(fleetReport) };
}

/**
 * groundnuty/macf#1053 — the reporting-only outcome discriminator for ONE
 * fleet's version-reconcile result. Pure; never called before the roll has
 * already run (this only reads `report`, it makes no decisions the roll
 * itself didn't already make — DR-043 Amendment L2 untouched).
 */
function summarizeVersionRoll(
  fleetReport: FleetPlanReport | undefined,
): Pick<ApplyVersionPhaseResult, 'rolledAgents' | 'unreachable' | 'totalMembers' | 'skipBreakdown'> {
  if (fleetReport === undefined || fleetReport.skipped !== undefined) {
    return { rolledAgents: [], unreachable: true, totalMembers: 0, skipBreakdown: [] };
  }
  const rolledAgents = fleetReport.rolled?.results.filter((r) => r.outcome === 'upgraded').map((r) => r.agent) ?? [];
  const skipBreakdown = fleetReport.rolled !== undefined ? versionRollSkipBreakdown(fleetReport.rolled) : [];
  return { rolledAgents, unreachable: false, totalMembers: fleetReport.plans.length, skipBreakdown };
}

/**
 * Compact one-line-per-event narration for the apply-driven roll (pure —
 * exported for tests). Deliberately lighter than `commands/fleet-upgrade.ts`'s
 * own `emit()` (which is the standalone CLI's full per-event render): apply's
 * final summary is one section among several, not the whole output, so this
 * favors a single readable line per event over that renderer's multi-line
 * per-event blocks.
 */
export function formatVersionRollEvent(ev: UpgradeEvent): string {
  switch (ev.kind) {
    case 'fleet-start':
      return `fleet ${ev.fleet}: ${String(ev.behind)}/${String(ev.total)} behind target`;
    case 'fleet-skipped':
      return `fleet ${ev.fleet}: SKIPPED (${ev.reason})`;
    case 'roll-start':
      return `${ev.agent}: rolling (${ev.from ?? 'down'} → ${ev.to})`;
    case 'branch-skip':
      return `${ev.agent}: BRANCH — OBJECTING (on ${ev.current ?? 'detached HEAD'}, expected ${ev.canonical})`;
    case 'config-auto-resolved':
      return `${ev.agent}: CONFIG auto-resolved (already-canonical, committed): ${ev.files.join(', ')}`;
    case 'config-dirty-skip':
      return `${ev.agent}: CONFIG-DIRTY — OBJECTING (no upgrade/restart run): ${ev.files.join(', ')}`;
    case 'busy-skip':
      return `${ev.agent}: BUSY — skip + report${ev.waited ? ' (still busy after wait)' : ''}`;
    case 'upgraded':
      return `${ev.agent}: GREEN on ${ev.version}`;
    case 'halt':
      return `${ev.agent}: HALT — verify-green ${ev.reason} (last=${ev.lastVersion ?? 'down'})`;
    case 'stale-pin-skip':
      return `${ev.agent}: STALE-PIN — skip + CONTINUE (launch pin @${ev.pin} != target @${ev.target})`;
    case 'lock-write-failed':
      return `${ev.agent}: fleet.lock deployed_version write FAILED (non-fatal) — ${ev.error}`;
  }
}
