/**
 * `macf fleet upgrade` — the rolling fleet-upgrade orchestrator (DR-037 /
 * macf#682 Phase 2). The CLI/production half of the decision/driver split: it
 * wires the runtime-agnostic decision layer (`upgradeFleets` in macf-core) to the
 * real VM driver (`createVmDriverFromConfig`), the npm-latest target resolver, the
 * `.macf/`-marker fleet discovery, and a re-resolving `verifyGreen` probe.
 *
 * Nothing runtime-specific lives here above the driver line — the sequencer,
 * busy-gate, HALT-on-not-green, and multi-fleet serial gating all live in
 * macf-core; this module only RESOLVES (target, fleets, drivers) and RENDERS.
 *
 * DRY-RUN by default: without `--execute` it probes + prints the PLAN and touches
 * nothing. `--execute` rolls one agent at a time, verify-green-before-next; a bad
 * release HALTS the roll (and, across `--fleet a,b,c`, stops later fleets).
 */
import {
  verifyGreen,
  upgradeFleets,
  type FleetDriver,
  type FleetUpgradeReport,
  type FleetPlanReport,
  type AgentUpgradePlan,
  type HealthResponse,
  type UpgradeEvent,
  type VerifyGreenOptions,
  type WorkspaceRecord,
} from '@groundnuty/macf-core';
import { readAgentConfig } from '../config.js';
import { discoverWorkspaces } from '../discovery.js';
import { createVmDriverFromConfig } from '../fleet/vm-driver.js';
import { fetchLatestCliVersion } from '../version-resolver.js';
import { formatTable } from './ps.js';

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
   * `--force` (macf#722 Fix B): roll an agent even if its config surface
   * (`.claude/**`, `CLAUDE.md`, `claude.sh`, `env.local.*` — DR-029
   * operator-preserved) is dirty. Also threaded into the `restart-self` stash
   * step via `MACF_RESTART_STASH_CONFIG=1` on the driver's `restart` exec, so
   * both halves of the override move together.
   */
  readonly force?: boolean;
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
}

/**
 * Choose the target version: an explicit `--target` wins (leading `v` stripped);
 * otherwise npm-latest. Pure w.r.t. the injected `fetchLatest`.
 */
export async function resolveTargetVersion(
  explicit: string | undefined,
  fetchLatest: () => Promise<string | null>,
): Promise<{ readonly ok: true; readonly target: string } | { readonly ok: false; readonly message: string }> {
  if (explicit && explicit.trim().length > 0) {
    return { ok: true, target: explicit.trim().replace(/^v/, '') };
  }
  const latest = await fetchLatest();
  if (!latest) {
    return { ok: false, message: 'could not resolve npm-latest target — pass --target <version>' };
  }
  return { ok: true, target: latest };
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
      return `UPGRADE ${plan.runningVersion ?? '?'}→${target} (busy-gated at execute)`;
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
        : r.outcome === 'busy-skipped' || r.outcome === 'config-dirty-skipped'
          ? '•'
          : '✗';
    log(`    ${mark} ${r.agent} — ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);
  }
  if (rolled.halted) {
    log(`    ROLL HALTED in ${report.fleet} — later fleets NOT started (a bad release cannot cascade).`);
  }
}

/** Render the full run report + return the shell exit code (halt ⇒ non-zero). */
function renderReport(report: FleetUpgradeReport, execute: boolean, log: (s: string) => void): number {
  log(`Rolling fleet-upgrade — target macf@${report.target}  [${execute ? 'EXECUTE' : 'dry-run'}]`);
  for (const fleet of report.fleets) {
    formatFleetReport(fleet, report.target, log);
  }
  if (!execute) {
    const behind = report.fleets.flatMap((f) => f.plans).filter((p) => p.disposition === 'behind').length;
    log(
      behind > 0
        ? `\n${behind} agent(s) behind target. Re-run with --execute to roll (ATTENDED: clear the launch-prompts as each agent returns).`
        : '\nAll selected agents are at target — nothing to roll.',
    );
    return 0;
  }
  if (report.halted) return 1;
  return 0;
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
  const resolved = deps ?? (await resolveDepsFromConfig(projectDir));
  if (!resolved) return 1;

  const targetR = await resolveTargetVersion(opts.target, resolved.fetchLatest);
  if (!targetR.ok) {
    console.error(`macf fleet upgrade: ${targetR.message}`);
    return 1;
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
  // CURRENTLY being rolled. `upgradeFleets` processes fleets serially and calls
  // `resolveDriver(fleet)` immediately before rolling it, so `current` is always
  // the right driver during that fleet's verify polls (DR-037 Decision 5:
  // `driver.probe()` re-lists the registry each call → the fresh restart-self port).
  let current: FleetDriver | null = null;
  const resolveDriver = async (fleet: string): Promise<FleetDriver | null> => {
    current = await resolved.resolveDriver(fleet);
    return current;
  };
  const probe = async (agent: string): Promise<HealthResponse | null> => {
    if (!current) return null;
    const state = await current.probe();
    const found = state.agents.find((a) => a.name === agent);
    return found && found.online ? found.health : null;
  };
  const runVerifyGreen = (o: VerifyGreenOptions) =>
    verifyGreen(o, { probe, sleep: resolved.sleep, now: resolved.now });

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
    },
  );

  return renderReport(report, execute, resolved.log);
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
    case 'config-dirty-skip':
      log(`   ${ev.agent}: CONFIG-DIRTY — skip + report (commit or --force)`);
      break;
    case 'busy-skip':
      log(`   ${ev.agent}: BUSY — skip + report${ev.waited ? ' (still busy after --wait)' : ''}`);
      break;
    case 'upgraded':
      log(`   ${ev.agent}: GREEN on ${ev.version}`);
      break;
    case 'halt':
      log(`   ${ev.agent}: HALT — verify-green ${ev.reason} (last=${ev.lastVersion ?? 'down'})`);
      break;
    case 'fleet-skipped':
      log(`── fleet ${ev.fleet}: SKIPPED (${ev.reason}) ──`);
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
 */
async function resolveDepsFromConfig(projectDir: string): Promise<FleetUpgradeDeps | null> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return null;
  }
  const defaultFleet = config.project;
  const discover = (): readonly WorkspaceRecord[] => discoverWorkspaces();

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
    log: (line: string) => console.log(line),
  };
}
