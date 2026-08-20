/**
 * `macf fleet deactivate` / `macf fleet archive` — DR-043 Amendment G, the
 * REVERSIBLE half of the fleet teardown ladder (groundnuty/macf#867). See
 * `bootstrap/teardown.ts`'s module doc for the full design (exact-key
 * targeting, the ownership gate, why `deactivate` never touches repo-scoped
 * state). `delete-apps` / `destroy` are explicitly OUT OF SCOPE here.
 *
 * Same shape as `bootstrap-apply.ts`: a read-only plan/inventory is built +
 * rendered FIRST (the DR-035 §4 plan-approve-once artifact), ONE explicit
 * confirmation is obtained (`--yes` skips it for automation), THEN the
 * mutating step runs. `--json` always emits a valid, non-empty JSON object
 * on stdout, even on failure (macf#830 lesson).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve as resolvePath } from 'node:path';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import { checkControlRepoMeta, realReadControlManifestFile } from '../bootstrap/control-repo.js';
import { checkRegistryVariablePresence } from '../bootstrap/observer.js';
import { realDeleteRegistryVariable } from '../bootstrap/variable-write.js';
import { realArchiveRepo } from '../bootstrap/repo-archive.js';
import { createVmExecSeams, resolveTarget, type VmDriverSeams } from '../fleet/vm-driver.js';
import type {
  AgentReachability,
  AgentStopCategory,
  ArchivePlan,
  DeactivateInventoryEntry,
  DeactivatePlan,
  DeactivateTarget,
  RepoArchiveOutcome,
  TeardownAgentDeps,
  TeardownControlRepoDeps,
  TeardownGate,
  TeardownRepoArchiveDeps,
  TeardownVariableDeps,
  VariableTeardownOutcome,
} from '../bootstrap/teardown.js';
import { buildArchivePlan, buildDeactivatePlan, executeArchiveRepos, executeDeactivate } from '../bootstrap/teardown.js';

export const FLEET_TEARDOWN_JSON_SCHEMA_VERSION = 1;

export interface RunFleetTeardownOptions {
  readonly file: string;
  /** Skip the interactive confirmation prompt (the one non-interactive escape, mirroring `bootstrap apply --yes`). */
  readonly yes?: boolean;
  readonly json?: boolean;
  /**
   * `groundnuty/macf#1033` — the host-local directory used ONLY to locate
   * the canonical `tmux-send-to-claude.sh` submit helper for the
   * graceful-exit request (any macf workspace's copy works — it's not
   * role-specific). Defaults to `process.cwd()`. Discovery itself
   * (`discoverWorkspaces()`) is host-wide, independent of this value — see
   * `resolveAgentStopDeps`'s doc.
   */
  readonly dir?: string;
}

/** Injectable seam so tests drive the command without touching `gh` / stdin. */
export interface FleetTeardownDeps extends TeardownControlRepoDeps, TeardownVariableDeps, TeardownRepoArchiveDeps, TeardownAgentDeps {
  readonly confirm: (question: string) => Promise<boolean>;
}

// --- Real (production) deps ---

/** Real y/N prompt on stderr (stdout stays clean for a `--json` render) — same shape as `bootstrap-apply.ts`'s `realConfirmPlan`. */
async function realConfirm(question: string): Promise<boolean> {
  process.stderr.write(`${question} [y/N] `);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question('', (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * `groundnuty/macf#1033` — local-only reachability, reusing DR-037's
 * `FleetDriver` primitives (`resolveTarget` + `hasSession`, the SAME two
 * `vm-driver.ts::isBusy` already composes) — never a new mechanism.
 * `session: null` unless `'alive'` (nothing to submit into otherwise).
 * Exported so tests can pin the name-form contract directly against
 * `VmDriverSeams` fakes (the seam THIS function actually reads) rather than
 * only against `TeardownAgentDeps` fakes one level removed from it — the
 * class of gap `assert-the-wrong-path.md` names: a role-name-form mismatch
 * between `fleet.yaml`'s kebab `agents[].role` and whatever
 * `discoverWorkspaces()` puts in `WorkspaceRecord.agent` would silently
 * degrade every agent to `'unknown'` (never an error) — exactly the shape
 * `vm-driver.ts`'s own macf#708 docblock warns a name-form mismatch produces.
 */
export function reachabilityFor(seams: VmDriverSeams, role: string): { readonly reachability: AgentReachability; readonly session: string | null } {
  const target = resolveTarget(seams, role);
  if (!target?.session) return { reachability: 'unknown', session: null };
  const alive = seams.hasSession(target.session);
  return { reachability: alive ? 'alive' : 'dead', session: alive ? target.session : null };
}

/**
 * The `TeardownAgentDeps` trio's PURE logic over an already-built
 * `VmDriverSeams` (`groundnuty/macf#1033`) — factored out of
 * `resolveAgentStopDeps` so it is unit-testable with seam fakes instead of
 * only through `resolveDeps`'s real `createVmExecSeams(dir)` wiring. Never
 * a signal, never `tmux kill-session` — `submit(session, '/exit')` is the
 * ONLY agent-facing primitive this calls.
 */
export function agentStopDepsOverSeams(seams: VmDriverSeams): TeardownAgentDeps {
  return {
    checkAgentReachability: (role) => Promise.resolve(reachabilityFor(seams, role).reachability),
    requestGracefulExit: (role) => {
      const { session } = reachabilityFor(seams, role);
      if (!session) return Promise.resolve();
      // The native Claude Code TUI `/exit` slash command — the SAME "normal
      // TUI exit" `macf-channel-server`'s `shutdown.ts` stdin close/end
      // wiring already treats as the graceful-deregister trigger (macf#627).
      // NEVER a signal, NEVER `tmux kill-session` — see `TeardownAgentDeps`'s
      // doc in teardown.ts for the full mechanism rationale + the live
      // verification (macf#1033, 2026-08-20) that this submit dispatches.
      seams.submit(session, '/exit');
      return Promise.resolve();
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * Builds the `TeardownAgentDeps` trio over a MINIMAL local `VmDriverSeams` —
 * `createVmExecSeams(dir)` plus inert `listPeers`/`probeHealth` stubs (never
 * called by `resolveTarget` / `hasSession` / `submit`), so this needs NO
 * GitHub token mint and NO registry read, unlike the full
 * `createVmDriverFromConfig`. Discovery (`discoverWorkspaces()`, inside
 * `createVmExecSeams`'s `discover` field) is host-wide (`MACF_WORKSPACE_ROOT`
 * or the sensible default), independent of `dir` — `dir` is used ONLY to
 * locate `tmux-send-to-claude.sh` (see `vm-driver.ts::tmuxSubmitScript`), so
 * it works from ANY macf workspace, not necessarily the target agent's own.
 */
function resolveAgentStopDeps(dir: string): TeardownAgentDeps {
  const seams: VmDriverSeams = {
    listPeers: async () => [],
    probeHealth: async () => null,
    ...createVmExecSeams(dir),
  };
  return agentStopDepsOverSeams(seams);
}

function resolveDeps(dir?: string): FleetTeardownDeps {
  return {
    checkMeta: checkControlRepoMeta,
    readManifestFile: realReadControlManifestFile,
    checkRegistryPresence: checkRegistryVariablePresence,
    deleteRegistryVariable: realDeleteRegistryVariable,
    archiveRepo: realArchiveRepo,
    confirm: realConfirm,
    ...resolveAgentStopDeps(dir ?? process.cwd()),
  };
}

// --- Manifest loading (shared failure shape) ---

interface TeardownFailure {
  readonly code: string;
  readonly message: string;
}

function failureToJson(failure: TeardownFailure): unknown {
  return { schema_version: FLEET_TEARDOWN_JSON_SCHEMA_VERSION, error: failure };
}

function renderFailure(failure: TeardownFailure, opts: RunFleetTeardownOptions): number {
  console.error(failure.message);
  if (opts.json) {
    console.log(JSON.stringify(failureToJson(failure), null, 2));
  }
  return 1;
}

function loadManifest(opts: RunFleetTeardownOptions): FleetManifest | TeardownFailure {
  const manifestPath = resolvePath(opts.file);
  if (!existsSync(manifestPath)) {
    return { code: 'manifest_not_found', message: `fleet manifest not found: ${manifestPath}` };
  }
  try {
    return parseFleetManifest(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { code: 'manifest_invalid', message: `fleet manifest failed validation: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function isFailure(x: FleetManifest | TeardownFailure): x is TeardownFailure {
  return 'code' in x;
}

// --- Rendering (never a credential value — this surface has none) ---

function formatGateLine(gate: TeardownGate): string {
  if (gate.allowed) return `Control repo ownership: ${gate.ownership.kind.toUpperCase()} — proceeding.`;
  return `⚠ REFUSED — ${gate.reason ?? 'ownership check did not authorize teardown.'}`;
}

function formatInventoryLines(inventory: readonly DeactivateInventoryEntry[]): string[] {
  return inventory.map((e) => `  ${e.target.kind.padEnd(20)} ${e.target.name.padEnd(40)} currently: ${e.presence}`);
}

function formatVariableOutcomeLines(outcomes: readonly VariableTeardownOutcome[]): string[] {
  return outcomes.map((o) => {
    const suffix = o.reason !== undefined ? ` — ${o.reason}` : '';
    return `  ${o.target.kind.padEnd(20)} ${o.target.name.padEnd(40)} ${o.status.toUpperCase()}${suffix}`;
  });
}

/**
 * `groundnuty/macf#1033` — the pre-confirmation reachability preview: which
 * `agent_registration` targets are alive/dead/unknown from THIS host, and
 * what `deactivate` will therefore do to each, BEFORE the operator
 * confirms. `deactivate` may now stop a running agent — that belongs in the
 * plan the operator sees, not discovered only after the fact.
 */
async function renderAgentReachabilityPreview(targets: readonly DeactivateTarget[], deps: Pick<TeardownAgentDeps, 'checkAgentReachability'>): Promise<void> {
  const agentTargets = targets.filter((t): t is DeactivateTarget & { role: string } => t.kind === 'agent_registration' && t.role !== undefined);
  if (agentTargets.length === 0) return;

  const rows: { readonly role: string; readonly reachability: AgentReachability }[] = [];
  for (const t of agentTargets) {
    rows.push({ role: t.role, reachability: await deps.checkAgentReachability(t.role) });
  }
  const lines = rows.map((r) => {
    const note =
      r.reachability === 'alive'
        ? 'will be asked to exit gracefully (/exit) and self-deregister'
        : r.reachability === 'dead'
          ? 'no live session on this host — will be deregistered directly'
          : 'not discoverable on this host — left UNTOUCHED (a fleet may span hosts, #1018)';
    return `  ${r.role.padEnd(20)} ${r.reachability.toUpperCase().padEnd(9)} ${note}`;
  });
  process.stderr.write('\nLive-agent reachability (this host only, DR-037 Amendment D — a fleet may span hosts):\n');
  process.stderr.write(`${lines.join('\n')}\n`);
}

/** `groundnuty/macf#1033` — the three-category report (issue's requirement 4), exhaustively over the 4 reachable {@link AgentStopCategory} values. Empty when the fleet has no agent targets (never rendered). */
function formatAgentStopSummary(outcomes: readonly VariableTeardownOutcome[]): string[] {
  const categorized = outcomes.filter((o): o is VariableTeardownOutcome & { agentStopCategory: AgentStopCategory } => o.agentStopCategory !== undefined);
  if (categorized.length === 0) return [];

  const counts: Record<AgentStopCategory, number> = {
    'stopped-self-deregistered': 0,
    'deregistered-directly': 0,
    unreachable: 0,
    'stop-unconfirmed': 0,
  };
  for (const o of categorized) counts[o.agentStopCategory] += 1;

  return [
    'Agent-stop summary:',
    `  stopped + self-deregistered:              ${String(counts['stopped-self-deregistered'])}`,
    `  deregistered directly (no live owner):     ${String(counts['deregistered-directly'])}`,
    `  unreachable (unknown — never assumed stopped): ${String(counts.unreachable)}`,
    `  graceful exit requested, unconfirmed:      ${String(counts['stop-unconfirmed'])}`,
  ];
}

function agentStopSummaryToJson(outcomes: readonly VariableTeardownOutcome[]): Record<AgentStopCategory, number> | null {
  const categorized = outcomes.filter((o): o is VariableTeardownOutcome & { agentStopCategory: AgentStopCategory } => o.agentStopCategory !== undefined);
  if (categorized.length === 0) return null;
  const counts: Record<AgentStopCategory, number> = {
    'stopped-self-deregistered': 0,
    'deregistered-directly': 0,
    unreachable: 0,
    'stop-unconfirmed': 0,
  };
  for (const o of categorized) counts[o.agentStopCategory] += 1;
  return counts;
}

function formatRepoOutcomeLines(outcomes: readonly RepoArchiveOutcome[]): string[] {
  return outcomes.map((o) => {
    const suffix = o.status === 'failed' ? ` — ${o.reason ?? 'unknown error'}` : '';
    return `  ${o.repo}: ${o.status.toUpperCase()}${suffix}`;
  });
}

function planTargetsPreview(targets: readonly DeactivateTarget[]): string[] {
  return [
    'The following EXACT registry keys would be removed (never a prefix sweep — DR-043 Amendment G):',
    ...targets.map((t) => `  ${t.kind.padEnd(20)} ${t.name}`),
  ];
}

// --- deactivate ---

export interface DeactivateResult {
  readonly fleet: string;
  readonly gate: TeardownGate;
  readonly outcomes: readonly VariableTeardownOutcome[];
}

function deactivateResultToJson(result: DeactivateResult): unknown {
  return {
    schema_version: FLEET_TEARDOWN_JSON_SCHEMA_VERSION,
    mode: 'deactivate',
    fleet: result.fleet,
    gate: { allowed: result.gate.allowed, ownership: result.gate.ownership, reason: result.gate.reason ?? null },
    outcomes: result.outcomes.map((o) => ({ ...o })),
    // groundnuty/macf#1033 — the three(-plus-one)-category report, null when
    // this fleet has no agent_registration targets at all.
    agent_stop_summary: agentStopSummaryToJson(result.outcomes),
  };
}

function deactivateExitCode(result: DeactivateResult): number {
  if (!result.gate.allowed) return 1;
  return result.outcomes.some((o) => o.status === 'failed') ? 1 : 0;
}

/**
 * `macf fleet deactivate -f fleet.yaml [--yes] [--json]`. Returns the shell
 * exit code. NEVER exits the process directly.
 */
export async function runFleetDeactivate(opts: RunFleetTeardownOptions, deps?: FleetTeardownDeps): Promise<number> {
  const loaded = loadManifest(opts);
  if (isFailure(loaded)) return renderFailure(loaded, opts);
  const manifest = loaded;

  const resolved = deps ?? resolveDeps(opts.dir);
  const plan: DeactivatePlan = await buildDeactivatePlan(manifest, resolved);

  process.stderr.write(`${formatGateLine(plan.gate)}\n`);
  if (!plan.gate.allowed) {
    const result: DeactivateResult = { fleet: plan.fleet, gate: plan.gate, outcomes: [] };
    if (opts.json) console.log(JSON.stringify(deactivateResultToJson(result), null, 2));
    return deactivateExitCode(result);
  }

  process.stderr.write(`${planTargetsPreview(plan.targets).join('\n')}\n\n`);
  process.stderr.write('Current registry state:\n');
  process.stderr.write(`${formatInventoryLines(plan.inventory).join('\n')}\n`);
  await renderAgentReachabilityPreview(plan.targets, resolved);

  const approved = opts.yes === true ? true : await resolved.confirm(`\nDeactivate fleet "${plan.fleet}" (remove ${String(plan.targets.length)} registry key(s))?`);
  if (!approved) {
    console.error('Aborted by operator — nothing was removed.');
    return 1;
  }

  const outcomes = await executeDeactivate(manifest, plan.targets, resolved);
  const result: DeactivateResult = { fleet: plan.fleet, gate: plan.gate, outcomes };

  if (opts.json) {
    console.log(JSON.stringify(deactivateResultToJson(result), null, 2));
  } else {
    console.log('');
    console.log(formatVariableOutcomeLines(outcomes).join('\n'));
    const summary = formatAgentStopSummary(outcomes);
    if (summary.length > 0) {
      console.log('');
      console.log(summary.join('\n'));
    }
  }
  return deactivateExitCode(result);
}

// --- archive ---

export interface ArchiveResult extends DeactivateResult {
  readonly repoOutcomes: readonly RepoArchiveOutcome[];
}

function archiveResultToJson(result: ArchiveResult): unknown {
  return { ...(deactivateResultToJson(result) as Record<string, unknown>), mode: 'archive', repo_outcomes: result.repoOutcomes.map((o) => ({ ...o })) };
}

function archiveExitCode(result: ArchiveResult): number {
  if (deactivateExitCode(result) !== 0) return 1;
  return result.repoOutcomes.some((o) => o.status === 'failed') ? 1 : 0;
}

/**
 * `macf fleet archive -f fleet.yaml [--yes] [--json]` — `deactivate` +
 * archives the control repo and every agent repo (DR-043 Amendment G's
 * cumulative rungs). Returns the shell exit code. NEVER exits the process
 * directly.
 */
export async function runFleetArchive(opts: RunFleetTeardownOptions, deps?: FleetTeardownDeps): Promise<number> {
  const loaded = loadManifest(opts);
  if (isFailure(loaded)) return renderFailure(loaded, opts);
  const manifest = loaded;

  const resolved = deps ?? resolveDeps(opts.dir);
  const plan: ArchivePlan = await buildArchivePlan(manifest, resolved);

  process.stderr.write(`${formatGateLine(plan.gate)}\n`);
  if (!plan.gate.allowed) {
    const result: ArchiveResult = { fleet: plan.fleet, gate: plan.gate, outcomes: [], repoOutcomes: [] };
    if (opts.json) console.log(JSON.stringify(archiveResultToJson(result), null, 2));
    return archiveExitCode(result);
  }

  process.stderr.write(`${planTargetsPreview(plan.targets).join('\n')}\n\n`);
  process.stderr.write('Current registry state:\n');
  process.stderr.write(`${formatInventoryLines(plan.inventory).join('\n')}\n\n`);
  process.stderr.write('The following repos would be ARCHIVED (read-only; reversible via `apply`):\n');
  process.stderr.write(`${plan.repoTargets.map((r) => `  ${r}`).join('\n')}\n`);
  await renderAgentReachabilityPreview(plan.targets, resolved);

  const approved =
    opts.yes === true
      ? true
      : await resolved.confirm(
          `\nArchive fleet "${plan.fleet}" (remove ${String(plan.targets.length)} registry key(s) + archive ${String(plan.repoTargets.length)} repo(s))?`,
        );
  if (!approved) {
    console.error('Aborted by operator — nothing was removed or archived.');
    return 1;
  }

  const outcomes = await executeDeactivate(manifest, plan.targets, resolved);
  const repoOutcomes = await executeArchiveRepos(plan.repoTargets, resolved);
  const result: ArchiveResult = { fleet: plan.fleet, gate: plan.gate, outcomes, repoOutcomes };

  if (opts.json) {
    console.log(JSON.stringify(archiveResultToJson(result), null, 2));
  } else {
    console.log('');
    console.log(formatVariableOutcomeLines(outcomes).join('\n'));
    const summary = formatAgentStopSummary(outcomes);
    if (summary.length > 0) {
      console.log('');
      console.log(summary.join('\n'));
    }
    console.log('');
    console.log(formatRepoOutcomeLines(repoOutcomes).join('\n'));
  }
  return archiveExitCode(result);
}
