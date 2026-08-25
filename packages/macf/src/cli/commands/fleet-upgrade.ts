/**
 * `macf fleet upgrade` — the rolling fleet-upgrade orchestrator (DR-037 /
 * macf#682 Phase 2). The CLI/production half of the decision/driver split: it
 * wires the runtime-agnostic decision layer (`upgradeFleets` in macf-core) to the
 * real VM driver (`createVmDriverFromConfig`), the target resolver (DR-043
 * Amendment L, groundnuty/macf#1045 — manifest-authoritative when `-f/--file`
 * is given, npm-latest ONLY as the standalone no-manifest default), the
 * `.macf/`-marker fleet discovery, and a re-resolving `verifyGreen` probe.
 *
 * Nothing runtime-specific lives here above the driver line — the sequencer,
 * busy-gate, HALT-on-not-green, and multi-fleet serial gating all live in
 * macf-core; this module only RESOLVES (target, fleets, drivers) and RENDERS.
 *
 * DRY-RUN by default: without `--execute` it probes + prints the PLAN and touches
 * nothing. `--execute` rolls one agent at a time, verify-green-before-next; a bad
 * release HALTS the roll (and, across `--fleet a,b,c`, stops later fleets).
 *
 * **DR-043 Amendment L / groundnuty/macf#1045 — this is also "the roll"**
 * `macf bootstrap apply`'s version-reconcile phase calls into, per
 * `apply-version.ts`'s module doc: by delegation, never reimplementation —
 * `resolveTargetVersion` and the re-resolving `verifyGreen` adapter both
 * moved to `bootstrap/version-target.ts` / `bootstrap/roll-verify-green.ts`
 * so BOTH callers share one copy rather than two that could silently drift.
 */
import {
  upgradeFleets,
  type FleetDriver,
  type FleetUpgradeReport,
  type FleetPlanReport,
  type FleetRollResult,
  type AgentUpgradePlan,
  type UpgradeEvent,
  type WorkspaceRecord,
} from '@groundnuty/macf-core';
import { readFileSync } from 'node:fs';
import { readAgentConfig } from '../config.js';
import { discoverWorkspaces } from '../discovery.js';
import { createVmDriverFromConfig } from '../fleet/vm-driver.js';
import { fetchLatestCliVersion } from '../version-resolver.js';
import { buildRecordDeployedVersion } from '../bootstrap/fleet-lock-recorder.js';
import { parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import { resolveTargetVersion, NO_MANIFEST_VERSION, type ManifestVersionInput } from '../bootstrap/version-target.js';
import { makeReResolvingVerifyGreen } from '../bootstrap/roll-verify-green.js';
import { formatTable } from './ps.js';

export { resolveTargetVersion, type ManifestVersionInput, type TargetResolution } from '../bootstrap/version-target.js';

/**
 * Default per-agent verify-green budget (ms) — mirrors `fleet/upgrade.sh`'s
 * 120s. Deliberately a RELAUNCH-AWARE grace, not a tight poll timeout
 * (macf#722 Fix A): a real `restart-self` relaunch involves the old tmux
 * session dying (~30s poll in the relauncher), the new process starting, AND
 * the fresh channel-server port re-registering + propagating through the
 * registry roster before `verifyGreen`'s re-resolving probe can see it. 120s
 * comfortably covers that whole sequence with margin, so a genuinely-fine
 * slow relaunch confirms green WITHIN the budget instead of spuriously
 * halting. Configurable via `--verify-timeout <sec>`.
 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

/** Parsed + validated command options. */
export interface RunFleetUpgradeOptions {
  /** Explicit target version pin (`--target`); default = npm-latest of `@groundnuty/macf`. */
  readonly target?: string;
  /** Comma-list of fleet identifiers (`--fleet a,b,c`) — project identifiers (macf#710). */
  readonly fleet?: string;
  /**
   * Comma-list of project identifiers (`--registry <project>,...`) — same
   * selector space as `--fleet`. The flag name predates macf#710's shift from
   * registry-scope to project-scope grouping; kept for back-compat.
   */
  readonly registry?: string;
  /** Actually roll (default: dry-run — plan only). */
  readonly execute?: boolean;
  /** On a busy agent, poll for idle instead of skipping. */
  readonly wait?: boolean;
  /** Per-agent verify-green budget in seconds (default 120). */
  readonly verifyTimeoutSec?: number;
  /**
   * `--force` (macf#722 Fix B / macf#725; union narrowed off the `.claude/**`
   * wildcard by DR-040 Decision 6, macf#698): roll an agent even if its config
   * surface (`claude.sh`, `.claude/rules/**`, `.claude/scripts/**`,
   * `.claude/settings.json`, the managed `.claude/.macf/env.*` +
   * `host-prelude.sh`, `CLAUDE.md`, `env.local.*` — see
   * `ROLL_TOUCHED_CONFIG_PATTERNS` in `@groundnuty/macf-core`'s
   * `fleet-upgrade.ts`) is dirty PRE-flight — bypasses the pre-flight OBJECT
   * gate. The bypassed agent's `restart` is then told
   * `leaveConfigUncommitted: true` (same as every normal roll transaction) via
   * the driver's `--leave-config-uncommitted` exec flag — `--force` means "roll
   * anyway," so the pre-existing dirt is left in place, not stashed.
   */
  readonly force?: boolean;
  /**
   * DR-043 §D6 write-back (macf#907) — path to the fleet's `fleet.yaml`
   * (mirrors `fleet deactivate`/`archive`'s existing `-f, --file`
   * convention). When given, a CONFIRMED verify-green records that agent's
   * `deployed_version` into the control repo's `fleet.lock`
   * (`fleet-lock-recorder.ts`). Omitted (the default) ⇒ unchanged
   * pre-macf#907 behavior — no write, `deployed_version` stays unknown.
   */
  readonly file?: string;
}

/** Injectable seams — production resolves them from config; tests supply fakes. */
export interface FleetUpgradeDeps {
  /** The registry-free host workspace scan (grouped into fleets by `project`, macf#710). */
  readonly discover: () => readonly WorkspaceRecord[];
  /**
   * Resolve a per-fleet driver (a representative workspace OF THAT PROJECT →
   * `createVmDriverFromConfig`, which binds the driver to the project's own CA +
   * registry namespace — macf#710).
   */
  readonly resolveDriver: (fleet: string) => Promise<FleetDriver | null>;
  /** The current project's fleet (its project identifier) — the DEFAULT selection. */
  readonly defaultFleet: string | null;
  /** Resolve npm-latest of `@groundnuty/macf` (the default `--target`). */
  readonly fetchLatest: () => Promise<string | null>;
  /** Sleep + clock for verify-green / `--wait` (injected so tests don't wait). */
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Output sink (default `console.log`). */
  readonly log: (line: string) => void;
  /**
   * DR-043 §D6 write-back (macf#907) — threaded straight through to
   * macf-core's `UpgradeFleetsDeps.recordDeployedVersion`; built from
   * `RunFleetUpgradeOptions.file` by `resolveDepsFromConfig` when given,
   * `undefined` otherwise (no write).
   */
  readonly recordDeployedVersion?: (agent: string, fleet: string, version: string) => Promise<void>;
  /**
   * DR-043 Amendment L (groundnuty/macf#1045) — the manifest's declared
   * `versions.macf` state, threaded to `resolveTargetVersion` (moved to
   * `bootstrap/version-target.ts` — see that module's doc for the full
   * resolution order). **Optional, defaulting to `NO_MANIFEST_VERSION`**
   * (`{ given: false }`) — every pre-Amendment-L construction site (every
   * existing test fixture, every standalone `macf fleet upgrade` call with
   * no `-f/--file`) stays byte-identical without touching this field.
   */
  readonly manifestVersion?: ManifestVersionInput;
}

/**
 * Resolve the ordered set of fleets (project identifiers, macf#710) to roll.
 * Selectors from `--fleet` + `--registry` are unioned (order preserved,
 * first-wins dedup) and filtered to the fleets actually present on this host;
 * unknown selectors are returned separately for a warning. With NO selectors,
 * defaults to the current project's fleet. Pure.
 */
export function selectFleets(
  available: readonly string[],
  selectors: readonly string[],
  defaultFleet: string | null,
): { readonly fleets: readonly string[]; readonly unknown: readonly string[] } {
  const avail = new Set(available);
  if (selectors.length === 0) {
    const fleets = defaultFleet && avail.has(defaultFleet) ? [defaultFleet] : [];
    return { fleets, unknown: [] };
  }
  const fleets: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const s of selectors) {
    if (seen.has(s)) continue;
    seen.add(s);
    if (avail.has(s)) fleets.push(s);
    else unknown.push(s);
  }
  return { fleets, unknown };
}

/** Split a comma-list option into trimmed, non-empty tokens. */
function splitSelectors(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

const PLAN_HEADERS = ['AGENT', 'FLEET', 'RUNNING', 'PIN', 'PLAN'] as const;

/** Render one plan row's PLAN cell from its disposition. */
function planCell(plan: AgentUpgradePlan, target: string): string {
  switch (plan.disposition) {
    case 'behind':
      return `UPGRADE ${plan.runningVersion ?? '?'}→${target}`;
    case 'at-target':
      return 'OK (at target)';
    case 'offline':
      return 'UNREACHABLE — skip (let reconcile heal first)';
  }
}

/** Render the per-fleet plan table (pure — exported for tests). */
export function formatPlanTable(plans: readonly AgentUpgradePlan[], target: string): string {
  const rows = plans.map((p) => [
    p.agent,
    p.fleet,
    p.runningVersion ?? 'down',
    p.pinnedVersion ?? '?',
    planCell(p, target),
  ]);
  return formatTable(PLAN_HEADERS, rows);
}

/** Render a fleet's EXECUTE outcome lines (pure — exported for tests). */
export function formatFleetReport(report: FleetPlanReport, target: string, log: (s: string) => void): void {
  if (report.skipped) {
    log(`  fleet ${report.fleet}: SKIPPED (${report.skipped})`);
    return;
  }
  log(`  fleet ${report.fleet}:`);
  log(formatPlanTable(report.plans, target));
  const rolled = report.rolled;
  if (!rolled) return;
  for (const r of rolled.results) {
    const mark =
      r.outcome === 'upgraded'
        ? '✓'
        : r.outcome === 'busy-skipped' ||
            r.outcome === 'config-dirty-skipped' ||
            r.outcome === 'branch-skipped' ||
            // macf#899 — POST-mutation but still safe-to-continue (unlike
            // 'halted' below): a stale launch pin explains the old-version
            // state without implicating the release.
            r.outcome === 'stale-pin-skipped' ||
            // Follow-up to macf#899 — same posture: the SAME pre-restart
            // process instance is still answering /health (relaunch hasn't
            // taken over yet), not a bad release.
            r.outcome === 'not-yet-serving-skipped'
          ? '•'
          : '✗';
    log(`    ${mark} ${r.agent} — ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);
    // DR-040 Decision 3 / macf#698 R1: surface auto-resolved (already-canonical,
    // committed) files in the SAME per-agent summary line, distinct from any
    // genuine-delta detail above — orthogonal to `outcome`.
    if (r.autoResolvedFiles && r.autoResolvedFiles.length > 0) {
      log(`      auto-resolved (already-canonical, committed): ${r.autoResolvedFiles.join(', ')}`);
    }
  }
  if (rolled.halted) {
    log(`    ROLL HALTED in ${report.fleet} — later fleets NOT started (a bad release cannot cascade).`);
  }
}

/**
 * True when a fleet's EXECUTE-mode roll left at least one member un-upgraded
 * for a reason OTHER than a halt — a pre-flight gate (branch / config-dirty /
 * busy) or a post-restart skip (stale-pin / not-yet-serving). Deliberately
 * excludes `configAutoResolved`: an auto-resolved file is committed
 * automatically and the agent still proceeds to `'upgraded'` — it never left
 * anyone behind. Pure — exported for tests (macf#1146).
 */
export function rollLeftAgentBehind(rolled: FleetRollResult): boolean {
  return (
    rolled.busySkipped > 0 ||
    rolled.configDirtySkipped > 0 ||
    rolled.branchSkipped > 0 ||
    rolled.stalePinSkipped > 0 ||
    rolled.notYetServingSkipped > 0
  );
}

/**
 * True when `report` (an EXECUTE-mode {@link FleetUpgradeReport}) is a MIXED
 * VERSION roll: it did not HALT, but it also did not finish every agent at
 * target. Two distinct shapes both count (macf#1146):
 *
 * - a per-agent skip inside a rolled fleet ({@link rollLeftAgentBehind});
 * - a WHOLE fleet whose driver never resolved (`FleetPlanReport.skipped`,
 *   e.g. `'driver-unresolved'`) — none of ITS members were even examined,
 *   which is at least as much "left un-upgraded" as a single skipped agent.
 *
 * Before macf#1146, `renderReport` looked ONLY at `report.halted` — every
 * one of the shapes here rendered success-shaped lines in the log AND
 * returned exit 0 in the same breath. Pure — exported for tests.
 */
export function isMixedVersionRoll(report: FleetUpgradeReport): boolean {
  return report.fleets.some((f) => f.skipped !== undefined || (f.rolled !== undefined && rollLeftAgentBehind(f.rolled)));
}

/**
 * The EXECUTE-mode exit code for `report` (macf#1146). Three-valued,
 * mirroring the THIRD-VALUE shape `fleet reconcile` already established
 * (`@groundnuty/macf-core`'s `fleet-reconcile.ts`: `rc` 0/1/2 on a different
 * severity axis — 0 nothing-to-do, 1 action-taken-or-needed, 2
 * precondition/probe failure) rather than inventing a new convention here:
 *
 * - `0` — every fleet finished fully green: no halt, no fleet-level skip, no
 *   per-agent skip.
 * - `1` — UNCHANGED: at least one fleet HALTED (a confirmed or unconfirmable
 *   bad release). This was already the sole non-zero code pre-macf#1146, so
 *   a caller already treating `1` as "a release is broken, stop and
 *   intervene" sees that signal unchanged. Checked FIRST — a halted fleet
 *   always reports `1` even if a DIFFERENT fleet in the same report also has
 *   a plain skip (multi-fleet halts stop the run before later fleets are
 *   even attempted, so this ordering is mostly defensive).
 * - `2` — NEW: not halted, but {@link isMixedVersionRoll}. Reusing `1` here
 *   would conflate "a release is broken" with "routine follow-up needed
 *   (wait for idle / commit dirt / switch branch / fix a pin / retry an
 *   unreachable driver), then re-run" — two different operator responses a
 *   single non-zero code can't tell apart. No caller in this repo branches
 *   on the SPECIFIC value of `runFleetUpgrade`'s return (`index.ts`'s
 *   action handler just forwards it via `process.exitCode`; nothing else
 *   calls `runFleetUpgrade` at all — `bootstrap/apply-version.ts` calls
 *   `upgradeFleets` directly, never this function), so introducing `2` does
 *   not change any existing caller's behavior beyond the fix itself: a
 *   caller doing the common `[ $? -ne 0 ]` check (the exact cron-wrapper gap
 *   macf#1146 reports) now correctly sees non-zero for a mixed roll too.
 *
 * Pure — exported for tests.
 */
export function fleetUpgradeExitCode(report: FleetUpgradeReport): number {
  if (report.halted) return 1;
  return isMixedVersionRoll(report) ? 2 : 0;
}

/**
 * The MIXED VERSION banner (macf#1146) — as loud as the exit code it
 * accompanies. An operator scanning scrollback for "did this finish" must
 * not have to count `•`/`SKIPPED` lines themselves to notice the fleet is
 * still on mixed versions. User-facing text: no internal issue/DR
 * references (structural guard, `no-internal-citations-in-user-facing-
 * output.test.ts`).
 */
function logMixedVersionBanner(log: (s: string) => void): void {
  log(
    '\n⚠ MIXED VERSION FLEET — this roll did not halt, but it also did not finish every agent ' +
      'at target (see the per-agent detail and any whole-fleet SKIPPED lines above). Re-run once ' +
      'the flagged agents are idle, clean, on their canonical branch, and correctly pinned, or ' +
      'once an unreachable fleet driver resolves.',
  );
}

/** Render the full run report + return the shell exit code (halt or mixed ⇒ non-zero). */
function renderReport(report: FleetUpgradeReport, execute: boolean, log: (s: string) => void): number {
  log(`Rolling fleet-upgrade — target macf@${report.target}  [${execute ? 'EXECUTE' : 'dry-run'}]`);
  for (const fleet of report.fleets) {
    formatFleetReport(fleet, report.target, log);
  }
  if (!execute) {
    const behind = report.fleets.flatMap((f) => f.plans).filter((p) => p.disposition === 'behind').length;
    log(
      behind > 0
        ? `\n${behind} agent(s) behind target. Re-run with --execute to roll (ATTENDED: clear the launch-prompts as each agent returns).\n` +
          'At execute, each agent rolls only when idle — a busy one is skipped and reported (use --wait to poll for idle instead).'
        : '\nAll selected agents are at target — nothing to roll.',
    );
    return 0;
  }
  const code = fleetUpgradeExitCode(report);
  if (code === 2) logMixedVersionBanner(log);
  return code;
}

/**
 * `macf fleet upgrade` entry point. Returns the shell exit code. `deps` is
 * injected by tests; production resolves it from the project config + registry.
 */
export async function runFleetUpgrade(
  projectDir: string,
  opts: RunFleetUpgradeOptions = {},
  deps?: FleetUpgradeDeps,
): Promise<number> {
  const resolved = deps ?? (await resolveDepsFromConfig(projectDir, opts.file));
  if (!resolved) return 1;

  const targetR = await resolveTargetVersion(opts.target, resolved.manifestVersion ?? NO_MANIFEST_VERSION, resolved.fetchLatest);
  if (targetR.kind === 'error') {
    console.error(`macf fleet upgrade: ${targetR.message}`);
    return 1;
  }
  if (targetR.kind === 'no-opinion') {
    // DR-043 Amendment L2.4 — nothing to reconcile, and nothing WRONG
    // either: exit 0, narrate why, touch nothing (no discovery, no driver,
    // no roll attempted).
    resolved.log(`macf fleet upgrade: ${targetR.message}`);
    return 0;
  }
  const target = targetR.target;

  const available = [...new Set(resolved.discover().map((r) => r.project))];
  const selectors = [...splitSelectors(opts.fleet), ...splitSelectors(opts.registry)];
  const { fleets, unknown } = selectFleets(available, selectors, resolved.defaultFleet);
  for (const u of unknown) {
    console.error(`macf fleet upgrade: no fleet '${u}' discovered on this host — skipping.`);
  }
  if (fleets.length === 0) {
    console.error(
      'macf fleet upgrade: no fleets selected. ' +
        `Available on this host: ${available.length ? available.join(', ') : '(none discovered)'}.`,
    );
    return 1;
  }

  // A single re-resolving verify-green probe, bound to whichever fleet's driver is
  // CURRENTLY being rolled — see `bootstrap/roll-verify-green.ts`'s doc (shared
  // with `apply-version.ts`'s version-reconcile phase, DR-043 Amendment L).
  const { resolveDriver, verifyGreen: runVerifyGreen } = makeReResolvingVerifyGreen(
    resolved.resolveDriver,
    resolved.sleep,
    resolved.now,
  );

  const execute = Boolean(opts.execute);
  const report = await upgradeFleets(
    fleets,
    {
      execute,
      targetVersion: target,
      verifyTimeoutMs:
        opts.verifyTimeoutSec !== undefined
          ? opts.verifyTimeoutSec * 1000
          : DEFAULT_VERIFY_TIMEOUT_MS,
      wait: Boolean(opts.wait),
      force: Boolean(opts.force),
    },
    {
      resolveDriver,
      verifyGreen: runVerifyGreen,
      sleep: resolved.sleep,
      now: resolved.now,
      onEvent: (ev: UpgradeEvent) => emit(ev, resolved.log),
      recordDeployedVersion: resolved.recordDeployedVersion,
    },
  );

  return renderReport(report, execute, resolved.log);
}

/**
 * Render a forwardable "block" for an agent-directed message + its file list
 * (macf#725) — used for BOTH the pre-flight OBJECT (`config-dirty-skip`) and
 * the post-upgrade report (`upgraded`). Same shape for both so an operator (or
 * a script) relaying the block to the named agent sees a consistent format
 * regardless of which path produced it.
 */
function renderMessageBlock(log: (s: string) => void, message: string, files: readonly string[]): void {
  log(`     ${message}`);
  for (const f of files) log(`       - ${f}`);
}

/** Live progress line for an upgrade event (execute mode). */
function emit(ev: UpgradeEvent, log: (s: string) => void): void {
  switch (ev.kind) {
    case 'fleet-start':
      log(`── fleet ${ev.fleet}: ${ev.behind}/${ev.total} behind target ──`);
      break;
    case 'roll-start':
      log(`   rolling ${ev.agent} (${ev.from ?? 'down'}→${ev.to})`);
      break;
    case 'branch-skip':
      // The FIRST pre-flight gate (macf#755): nothing was touched — the
      // workspace isn't on its canonical branch (or is detached/unresolvable).
      // `workspace` names the on-disk location actually inspected, so a
      // misattributed resolution (routing-label collision across fleets) is
      // visible right here rather than requiring separate investigation.
      log(
        `   ${ev.agent}: BRANCH — OBJECTING (on ${ev.current ?? 'detached HEAD'}, expected ` +
        `${ev.canonical}; workspace: ${ev.workspace ?? 'UNRESOLVED'}; no upgrade/restart run; ` +
        `switch branch or --force)`,
      );
      break;
    case 'config-auto-resolved':
      // DR-040 Decision 3 / macf#698 R1: these dirty files were ALREADY the
      // canonical `macf update` regen — committed automatically, no OBJECT,
      // no agent/operator involvement.
      log(`   ${ev.agent}: CONFIG auto-resolved (already-canonical, committed): ${ev.files.join(', ')}`);
      break;
    case 'config-dirty-skip':
      // The OBJECT path (macf#725): nothing was touched — forward the exact
      // list + the inspect/commit/delete/gitignore-then-retry message.
      log(`   ${ev.agent}: CONFIG-DIRTY — OBJECTING (no upgrade/restart run; commit or --force)`);
      renderMessageBlock(log, ev.message, ev.files);
      break;
    case 'busy-skip':
      log(`   ${ev.agent}: BUSY — skip + report${ev.waited ? ' (still busy after --wait)' : ''}`);
      break;
    case 'upgraded':
      // The clean-proceed path (macf#725): green on target — forward what
      // `macf update` regenerated (deliberately left uncommitted) for review.
      log(`   ${ev.agent}: GREEN on ${ev.version}`);
      if (ev.modifiedFiles.length > 0) renderMessageBlock(log, ev.message, ev.modifiedFiles);
      break;
    case 'halt':
      log(`   ${ev.agent}: HALT — verify-green ${ev.reason} (last=${ev.lastVersion ?? 'down'})`);
      break;
    case 'stale-pin-skip':
      // macf#899 — the agent WAS mutated (upgrade+restart already ran) but
      // its old-version state is explained by a stale LAUNCH pin, not a bad
      // release: skip it and CONTINUE (distinct from HALT above).
      log(
        `   ${ev.agent}: STALE-PIN — skip + CONTINUE (launch pin @${ev.pin} != target ` +
        `@${ev.target}; fix ${ev.agent}'s launch pin, not the release)`,
      );
      break;
    case 'not-yet-serving-skip':
      // Follow-up to macf#899 — the agent WAS mutated but the SAME
      // pre-restart process instance is still answering /health: its
      // relaunch simply hasn't taken over serving yet, not a bad release.
      // Skip it and CONTINUE (distinct from HALT above).
      log(
        `   ${ev.agent}: NOT-YET-SERVING — skip + CONTINUE (same instance ${ev.instanceId} still ` +
        `answering; clear ${ev.agent}'s launch prompt if one is pending, then re-run the upgrade)`,
      );
      break;
    case 'fleet-skipped':
      log(`── fleet ${ev.fleet}: SKIPPED (${ev.reason}) ──`);
      break;
    case 'lock-write-failed':
      // macf#907 — non-fatal: the agent above already reported 'upgraded'.
      // This is bookkeeping-only, surfaced loud rather than swallowed.
      log(`   ${ev.agent}: fleet.lock deployed_version write FAILED (non-fatal) — ${ev.error}`);
      break;
  }
}

/**
 * Wire the production deps from the project config: host discovery, npm-latest,
 * the default fleet (this workspace's OWN project — macf#710), and a per-fleet
 * driver resolver that binds `createVmDriverFromConfig` at a REPRESENTATIVE
 * workspace OF THAT PROJECT (so the driver carries the project's own CA +
 * registry namespace, never a sibling project's sharing the same registry
 * scope). Returns null (diagnostic on stderr) when the project isn't
 * initialised.
 *
 * `manifestFile` (DR-043 §D6, macf#907; the `-f, --file` CLI flag) is
 * OPTIONAL — when given, builds the `recordDeployedVersion` write-back
 * closure via `fleet-lock-recorder.ts` AND parses `versions.macf` into
 * `manifestVersion` (DR-043 Amendment L, macf#1045 — makes the manifest
 * AUTHORITATIVE over the target, per `bootstrap/version-target.ts`'s doc),
 * failing LOUD (returns `null`) if the manifest can't be read/parsed, at
 * RESOLVE time, before any agent is touched. When omitted,
 * `recordDeployedVersion` stays `undefined` and `manifestVersion` stays
 * `{ given: false }` — byte-identical to pre-macf#907 / pre-Amendment-L
 * standalone behavior (npm-latest remains the default target).
 */
async function resolveDepsFromConfig(projectDir: string, manifestFile?: string): Promise<FleetUpgradeDeps | null> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return null;
  }
  const defaultFleet = config.project;
  const discover = (): readonly WorkspaceRecord[] => discoverWorkspaces();

  let recordDeployedVersion: FleetUpgradeDeps['recordDeployedVersion'];
  let manifestVersion: ManifestVersionInput = NO_MANIFEST_VERSION;
  if (manifestFile) {
    try {
      const manifest = parseFleetManifest(readFileSync(manifestFile, 'utf-8'));
      manifestVersion = { given: true, macf: manifest.versions?.macf };
      recordDeployedVersion = buildRecordDeployedVersion(manifestFile);
    } catch (err) {
      console.error(
        `macf fleet upgrade: --file "${manifestFile}" could not be read/parsed as a fleet.yaml manifest — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  return {
    discover,
    defaultFleet,
    fetchLatest: async () => {
      const r = await fetchLatestCliVersion();
      return r.status === 'ok' ? r.value : null;
    },
    resolveDriver: async (fleet: string): Promise<FleetDriver | null> => {
      const rep = discover().find((r) => r.project === fleet);
      if (!rep) {
        console.error(`macf fleet upgrade: no workspace for fleet '${fleet}' on this host.`);
        return null;
      }
      return createVmDriverFromConfig(rep.workspace);
    },
    sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    manifestVersion,
    log: (line: string) => console.log(line),
    recordDeployedVersion,
  };
}
