/**
 * `macf fleet resume` — DR-037 subcommand: nudge a STALLED idle agent to
 * continue, or REPORT a BLOCKED one (a durable operator alert, never
 * auto-answered).
 *
 * Ports `groundnuty/macf-devops-toolkit:fleet/resume.sh` + `stall-signatures.json`
 * as a native-TypeScript decision layer over the DR-037 `FleetDriver` (DR-037
 * Decision 6 — reimplement, don't wrap). THE load-bearing unattended-operation
 * primitive (operator, 2026-06-28): agents stop after each turn and wait; an idle
 * agent is one of three things and only the pane tells them apart —
 *
 *   - idle-CLEAN (no signature)              → legitimately idle/done → DO NOTHING.
 *   - idle-STALLED (rate-limit / turn-abort) → `nudge`: resume the SAME session
 *     (preserves in-progress work; a restart would lose it + re-hit a rate-limit).
 *   - idle-BLOCKED (permission/trust/skill/  → `report`: a DURABLE operator alert,
 *     memory prompt)                           NEVER auto-answered (an authorization
 *                                              decision needs a human — DR-033).
 *
 * SAFETY CONTRACT (the sibling of DR-033's; allowlist-only, never a blind nudge):
 *   - **Allowlist-only.** Act ONLY on an idle agent whose pane matches a KNOWN
 *     signature. An unmatched idle pane → idle-CLEAN → never touched (no spam).
 *   - **Idle-gate.** Never act on a BUSY agent — it's working. Busy = pane content
 *     changing over the window (`driver.isBusy`, the capture-pane content-diff —
 *     NOT `#{session_activity}`, macf#645).
 *   - **Verify-resumed (nudge only).** After a nudge, confirm the pane started
 *     changing (`driver.isBusy` again). If not (still throttled / RC-bound) → back
 *     off, don't re-spam.
 *   - **Report-never-answers.** `report` only raises the alert (the DR-037 tier-3
 *     alert — a `gh issue create`, so it stays in the DECISION layer, NOT on the
 *     driver); it never injects into an authorization prompt.
 *   - **Fire-cap + per-episode reset.** Cap actions per episode; reset the counter
 *     when the agent returns to idle-CLEAN (the episode ended) so a fresh episode
 *     re-fires.
 *
 * DRY-RUN BY DEFAULT — detects + prints the plan; `--execute` nudges / raises alerts.
 *
 * Every side effect flows through `FleetResumeDeps` (the injected `FleetDriver`,
 * the alert seam, the fire-counter store, the allowlist loader) so the decision
 * logic is unit-testable against a FAKE driver — no real tmux / processes /
 * network. Production wires the real deps via `createRealResumeDeps`.
 *
 * Refs: DR-037 (fleet operational-layer as canonical CLI), macf#686,
 *       macf-devops-toolkit DR-006 + #129 (rate-limit) + #132 (operator-blocked report).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  generateToken,
  matchStallSignature,
  registryIdentifier,
  resolveMaxFires,
  MacfError,
  STALL_SIGNATURES_SEED,
  type FleetDriver,
  type StallAction,
  type StallSignatureEntry,
} from '@groundnuty/macf-core';
import { readAgentConfig, tokenSourceFromConfig } from '../config.js';
import { createVmDriverFromConfig } from '../fleet/vm-driver.js';
import { loadStallSignaturesFromWorkspace } from '../stall-signatures.js';
import { resolveWorkspaceDir, formatWorkspaceDirConflictWarning } from '../workspace-dir.js';

/** Raised on a genuine resume-wiring failure (fail-loud, never silent). */
export class FleetResumeError extends MacfError {
  constructor(message: string) {
    super('FLEET_RESUME_ERROR', message);
    this.name = 'FleetResumeError';
  }
}

/** The tier-3 alert's input — the blocked agent + the matched signature + a summary. */
export interface ResumeAlertInput {
  readonly agent: string;
  /** The matched signature's `name` (the alert-title dedup key). */
  readonly signature: string;
  /** The operator-facing summary of what the agent is blocked on. */
  readonly summary: string;
}

/** The tier-3 alert's outcome. `created: false` when an open alert already existed (dedup). */
export interface ResumeAlertResult {
  readonly created: boolean;
  /** The created issue's URL/ref when `created`; absent on dedup. */
  readonly ref?: string;
}

/**
 * Every side effect the resume decision layer performs, injected so tests verify
 * the match→dispatch→fire-cap→verify orchestration against a FAKE driver.
 */
export interface FleetResumeDeps {
  /** The DR-037 driver (reused): discovery + capture-pane + idle-gate + inject. */
  readonly driver: FleetDriver;
  /** The accepted stall-signature allowlist (from `.claude/.macf/stall-signatures.json`). */
  readonly loadSignatures: () => readonly StallSignatureEntry[];
  /**
   * Raise a DURABLE operator alert for a blocked agent (the DR-037 tier-3 alert —
   * a `gh issue create`, dedup'd). Runtime-agnostic, so it lives in the decision
   * layer, NOT on the driver.
   */
  readonly alert: (input: ResumeAlertInput) => Promise<ResumeAlertResult>;
  /** Read the per-agent, per-action fire counter (0 when none). */
  readonly readFireCount: (agent: string, kind: StallAction) => number;
  /** Write the per-agent, per-action fire counter. */
  readonly writeFireCount: (agent: string, kind: StallAction, count: number) => void;
  /** Clear BOTH of an agent's fire counters (the episode ended — idle-CLEAN). */
  readonly clearFireCounts: (agent: string) => void;
  /** Info line to stdout. */
  readonly log: (msg: string) => void;
  /** Warning line to stderr. */
  readonly warn: (msg: string) => void;
}

/** Already-resolved orchestrator input. */
export interface RunFleetResumeOptions {
  /** When false (default), detect + print the plan; when true, nudge / raise alerts. */
  readonly execute: boolean;
}

/** Render one agent's decision line (AGENT / STATE / ACTION). */
export function formatResumeLine(agent: string, state: string, action: string): string {
  return `${agent.padEnd(16)} ${state.padEnd(10)} ${action}`;
}

/** Report path (action=report): fire-capped durable operator alert; never a nudge. */
async function handleReport(
  agent: string,
  entry: StallSignatureEntry,
  opts: RunFleetResumeOptions,
  deps: FleetResumeDeps,
): Promise<boolean> {
  const cap = resolveMaxFires(entry);
  const n = deps.readFireCount(agent, 'report');
  const summary = entry.report ?? 'blocked on an operator-input prompt — needs your input';
  if (n >= cap) {
    deps.log(formatResumeLine(agent, 'blocked', `skip (${entry.name}: already reported this episode — operator notified)`));
    return false;
  }
  if (!opts.execute) {
    deps.log(
      formatResumeLine(
        agent,
        'blocked',
        `[dry-run] REPORT (${entry.name}): ${summary} → durable operator alert (NOT auto-answered)`,
      ),
    );
    return true;
  }
  deps.log(formatResumeLine(agent, 'blocked', `[execute] REPORT (${entry.name}) → raising operator alert (never auto-answered)`));
  try {
    const res = await deps.alert({ agent, signature: entry.name, summary });
    if (!res.created) {
      deps.log(formatResumeLine(agent, 'blocked', `(dedup: an open alert already exists for ${agent})`));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.warn(`alert create FAILED for ${agent} (gh/token/repo?) — block NOT surfaced: ${msg}`);
  }
  // Increment regardless (mirrors resume.sh): a re-run this episode must not re-alert.
  deps.writeFireCount(agent, 'report', n + 1);
  return true;
}

/** Nudge path (action=nudge, default): fire-capped resume + verify-resumed. */
async function handleNudge(
  agent: string,
  entry: StallSignatureEntry,
  opts: RunFleetResumeOptions,
  deps: FleetResumeDeps,
): Promise<boolean> {
  const cap = resolveMaxFires(entry);
  const n = deps.readFireCount(agent, 'nudge');
  if (n >= cap) {
    deps.log(formatResumeLine(agent, 'stalled', `skip (${entry.name}: fire-cap ${cap} reached → escalate, not re-nudge)`));
    return false;
  }
  const msg = entry.nudge ?? 'Please continue your work.';
  if (!opts.execute) {
    deps.log(
      formatResumeLine(agent, 'stalled', `[dry-run] NUDGE (${entry.name}): send "${msg}" → verify resumed (fire ${n + 1}/${cap})`),
    );
    return true;
  }
  try {
    await deps.driver.inject(agent, msg);
  } catch (err) {
    const emsg = err instanceof Error ? err.message : String(err);
    deps.warn(`nudge inject FAILED for ${agent}: ${emsg}`);
    return true;
  }
  // Record the fire BEFORE verifying (so a crash mid-verify still counts it).
  deps.writeFireCount(agent, 'nudge', n + 1);
  // Verify-resumed: is the pane now changing (busy)? Then the nudge landed.
  const resumed = await deps.driver.isBusy(agent);
  if (resumed) {
    deps.log(formatResumeLine(agent, 'resumed', `[execute] nudged (${entry.name}) → RESUMED (pane changing); reset counter`));
    deps.writeFireCount(agent, 'nudge', 0); // fresh episode next time
  } else {
    deps.log(
      formatResumeLine(agent, 'stalled', `[execute] nudged (${entry.name}) → NOT confirmed (still throttled/RC-bound) → back off (${n + 1}/${cap})`),
    );
  }
  return true;
}

/**
 * Sweep the host's agents (from `driver.discoverWorkspaces()` — the DR-037
 * host-operational plane) and act on the stalled/blocked idle ones. Returns 0 on
 * a completed sweep (like the reference), 2 when the allowlist itself is invalid.
 */
export async function runFleetResume(opts: RunFleetResumeOptions, deps: FleetResumeDeps): Promise<number> {
  let entries: readonly StallSignatureEntry[];
  try {
    entries = deps.loadSignatures();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.warn(`stall-signature allowlist is invalid — resume cannot run: ${msg}`);
    return 2;
  }

  deps.log(`Resume sweep — nudge stalled / report blocked idle agents  [${opts.execute ? 'EXECUTE' : 'dry-run'}]`);

  const seen = new Set<string>();
  let acted = 0;
  for (const record of deps.driver.discoverWorkspaces()) {
    const agent = record.agent;
    if (seen.has(agent)) continue;
    seen.add(agent);

    // 1. Gone? No live session (capture-pane null) → resume can't help; reconcile
    //    launches a dead agent. Checked first so a gone agent skips the busy-window.
    const pane = await deps.driver.capturePane(agent);
    if (pane === null) {
      deps.log(formatResumeLine(agent, 'no-session', "skip (gone — resume can't help; reconcile launches)"));
      continue;
    }
    // 2. Busy? Working — never interrupt (idle-gate, capture-pane content-diff).
    if (await deps.driver.isBusy(agent)) {
      deps.log(formatResumeLine(agent, 'busy', 'skip (working — never interrupt)'));
      continue;
    }
    // 3. Idle → match the pane against the allowlist.
    const entry = matchStallSignature(pane, entries);
    if (entry === null) {
      // idle-CLEAN: legitimately idle/done. The episode (if any) ended → reset the
      // fire counters so a FUTURE stall/block re-fires (per-episode, not lifetime).
      if (opts.execute) deps.clearFireCounts(agent);
      deps.log(formatResumeLine(agent, 'idle-clean', 'skip (no signature — legitimately idle/done, never touched)'));
      continue;
    }
    const didAct = entry.action === 'report'
      ? await handleReport(agent, entry, opts, deps)
      : await handleNudge(agent, entry, opts, deps);
    if (didAct) acted += 1;
  }

  deps.log(
    acted === 0
      ? 'No stalled/blocked agents needing action.'
      : `${acted} agent(s) ${opts.execute ? 'acted on' : 'would be acted on (dry-run)'}.`,
  );
  return 0;
}

// --- Real-seam wiring (production) ---

/** Per-agent fire-counter directory (mirrors resume.sh's `$HOME/.macf/resume-state`). */
function resumeStateDir(): string {
  return process.env['MACF_RESUME_STATE']?.trim() || join(homedir(), '.macf', 'resume-state');
}

/** Path to an agent's per-action fire-counter file (`<agent>` nudge / `<agent>.report`). */
function fireCounterPath(agent: string, kind: StallAction): string {
  const base = join(resumeStateDir(), agent);
  return kind === 'report' ? `${base}.report` : base;
}

/** Read a fire counter (0 when absent / unparsable). */
function readFireCountFile(agent: string, kind: StallAction): number {
  try {
    const raw = readFileSync(fireCounterPath(agent, kind), 'utf-8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Write a fire counter (creates the state dir). */
function writeFireCountFile(agent: string, kind: StallAction, count: number): void {
  const p = fireCounterPath(agent, kind);
  mkdirSync(join(resumeStateDir()), { recursive: true });
  writeFileSync(p, `${count}\n`);
}

/** Clear both of an agent's fire counters (best-effort; absent files are fine). */
function clearFireCountFiles(agent: string): void {
  for (const kind of ['nudge', 'report'] as const) {
    try {
      writeFileSync(fireCounterPath(agent, kind), '0\n');
    } catch {
      /* best-effort reset — a missing dir means no counter to clear */
    }
  }
}

/**
 * Resolve the repo the durable operator alert lands in: `MACF_ALERT_REPO` env,
 * else the workspace's registry identifier WHEN it is `owner/repo` (repo-scoped).
 * Throws (fail-loud) otherwise — better to abort a report than post to the wrong
 * repo. Only consulted when a `report` actually executes.
 */
function resolveAlertRepo(projectDir: string): string {
  const fromEnv = process.env['MACF_ALERT_REPO']?.trim();
  if (fromEnv) return fromEnv;
  const config = readAgentConfig(projectDir);
  if (config) {
    const id = registryIdentifier(config.registry);
    if (id.includes('/')) return id;
  }
  throw new FleetResumeError(
    'cannot resolve the alert repo — set MACF_ALERT_REPO=<owner>/<repo> (the workspace ' +
      'registry is not repo-scoped, so a report target cannot be derived).',
  );
}

/** Build the production `alert` seam: dedup via open-issue title search, then `gh issue create`. */
function createRealAlert(projectDir: string): (input: ResumeAlertInput) => Promise<ResumeAlertResult> {
  return async (input: ResumeAlertInput): Promise<ResumeAlertResult> => {
    const config = readAgentConfig(projectDir);
    if (!config) throw new FleetResumeError('no macf-agent.json found — run `macf init` first.');
    const repo = resolveAlertRepo(projectDir);
    const label = process.env['MACF_ALERT_LABEL']?.trim() || 'operator-blocked';
    const token = await generateToken(tokenSourceFromConfig(projectDir, config));
    const env = { ...process.env, GH_TOKEN: token };
    const title = `operator-input blocked: ${input.agent} (${input.signature})`;

    // Dedup: skip if an open alert with this title already exists.
    try {
      const existing = execFileSync(
        'gh',
        ['issue', 'list', '--repo', repo, '--state', 'open', '--search', `in:title "${title}"`, '--json', 'number', '--jq', '.[0].number // empty'],
        { encoding: 'utf-8', env },
      ).trim();
      if (existing) return { created: false };
    } catch {
      /* dedup best-effort — a failed search must not suppress the alert */
    }

    const body =
      `**Agent \`${input.agent}\` is idle-BLOCKED, not idle-done** — silently waiting on an operator-input prompt.\n\n` +
      `- **Signature:** \`${input.signature}\`\n` +
      `- **What:** ${input.summary}\n` +
      `- **Detected by:** \`macf fleet resume\` (capture-pane-diff idle + prompt-signature match).\n\n` +
      `**Action needed:** attach to the agent's TUI and respond to the prompt.\n\n` +
      `This alert was raised because the prompt is an **authorization** decision the fleet must NOT ` +
      `auto-answer. Close it once you've handled the prompt.\n\n` +
      `(An idle-blocked agent is invisible unless something explicitly surfaces it — see silent-fallback-hazards.md.)`;

    const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
    try {
      const url = execFileSync('gh', [...args, '--label', label], { encoding: 'utf-8', env }).trim();
      return { created: true, ref: url };
    } catch {
      // The label may not exist on the repo — retry unlabeled rather than fail the report.
      const url = execFileSync('gh', args, { encoding: 'utf-8', env }).trim();
      return { created: true, ref: url };
    }
  };
}

/** Wire the production resume deps over a real VM `FleetDriver`. */
export function createRealResumeDeps(projectDir: string, driver: FleetDriver): FleetResumeDeps {
  return {
    driver,
    loadSignatures: () => loadStallSignaturesFromWorkspace(projectDir) ?? STALL_SIGNATURES_SEED,
    alert: createRealAlert(projectDir),
    readFireCount: readFireCountFile,
    writeFireCount: writeFireCountFile,
    clearFireCounts: clearFireCountFiles,
    log: (msg: string) => console.log(msg),
    warn: (msg: string) => console.error(msg),
  };
}

/** CLI options passed from commander. */
export interface FleetResumeCliOptions {
  readonly execute?: boolean;
  /**
   * True iff the caller passed `--dir` on argv (macf#1123, threading
   * `restart-self`'s macf#888 `dirExplicit` pattern via the shared
   * `isDirExplicit`/`resolveWorkspaceDir` in `../workspace-dir.js`). Without
   * this, an explicit `--dir <other-workspace>` silently loses to the
   * caller's own ambient `MACF_WORKSPACE_DIR` below.
   */
  readonly dirExplicit?: boolean;
}

/** `macf fleet resume` entry point — resolves the workspace, wires the real driver + deps. */
export async function runFleetResumeCommand(
  projectDir: string,
  cliOpts: FleetResumeCliOptions,
): Promise<number> {
  const resolved = resolveWorkspaceDir(projectDir, cliOpts.dirExplicit === true);
  const conflictWarning = formatWorkspaceDirConflictWarning('fleet resume', resolved);
  if (conflictWarning) console.error(conflictWarning);

  const driver = await createVmDriverFromConfig(resolved.workspaceDir);
  if (!driver) return 1; // createVmDriverFromConfig already printed the diagnostic.
  const deps = createRealResumeDeps(resolved.workspaceDir, driver);
  return runFleetResume({ execute: Boolean(cliOpts.execute) }, deps);
}
