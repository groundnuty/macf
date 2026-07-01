/**
 * `macf restart-self` — DR-031 piece 3, the VM "be-replaceable" verb.
 *
 * Safely prepares the workspace and spawns a DETACHED relauncher that OUTLIVES
 * the agent's session death, so a watchdog (or the agent itself) can trigger a
 * clean restart without losing uncommitted work. The naive self-kill is suicide
 * (an agent that `tmux kill-session`s its own session dies mid-command with no
 * respawn — DR-031 §"Be-replaceable"); the detached relauncher is what makes the
 * restart survive the kill.
 *
 * Orchestration (in this exact order, ALL under a confirm gate):
 *   1. Resolve config (workspace + the canonical `<project>@<routing-label>` tmux session).
 *   2. Safety gate — DRY-RUN BY DEFAULT. Without `--confirm` (or with `--dry-run`)
 *      it emits the full plan and exits 0 having done NOTHING (no stash/kill/spawn).
 *   3. Prepare the working tree — a MARKED STASH (not auto-commit): only if there
 *      are uncommitted *tracked* changes. A marked stash is local, recoverable,
 *      non-destructive, and survives a same-host restart; auto-commit risks leaking
 *      half-baked state into history.
 *   4. Write a RESUME-note (reason / ts / branch / HEAD / stash-ref + a recovery line).
 *   5. Spawn a DETACHED relauncher that waits for the old session to die, re-sources
 *      the host-prelude (if present), then `exec ./claude.sh`.
 *   6. Kill the current tmux session — the actual restart trigger. ONLY in
 *      `--confirm` mode, and ONLY as the final step after 3–5 succeeded.
 *
 * ALL side effects flow through `RestartSelfDeps` so `runRestartSelf` is unit-
 * testable with fakes (no real stash / kill / spawn). Production wires the real
 * deps via `createRealDeps`.
 */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readAgentConfig } from '../config.js';

/** The three restart drivers (DR-031 §"Be-replaceable" — fault / upgrade / manual). */
export const RESTART_REASONS = ['fault', 'upgrade', 'manual'] as const;
export type RestartReason = (typeof RESTART_REASONS)[number];

/** Coerce an arbitrary `--reason` string to a known reason; defaults to `manual`. */
export function coerceReason(raw: string | undefined): RestartReason {
  return (RESTART_REASONS as readonly string[]).includes(raw ?? '')
    ? (raw as RestartReason)
    : 'manual';
}

/** Result of a stash attempt. `stashed: false` when there was nothing to stash. */
export interface StashResult {
  readonly stashed: boolean;
  readonly ref?: string;
}

/**
 * Every side effect `runRestartSelf` performs, injected so tests verify the
 * orchestration WITHOUT real stashes / kills / spawns. The git READS (branch,
 * HEAD, dirty-state) are side effects too, so they live here as well.
 */
export interface RestartSelfDeps {
  readonly now: () => Date;
  readonly hasUncommittedTrackedChanges: () => boolean;
  readonly currentBranch: () => string;
  readonly headSha: () => string;
  readonly stash: (label: string) => StashResult;
  readonly writeFile: (path: string, content: string, mode?: number) => void;
  readonly mkdirp: (path: string) => void;
  readonly spawnDetached: (scriptPath: string, args: readonly string[]) => void;
  readonly killSession: (session: string) => void;
}

/** Options for `runRestartSelf` (already-resolved identity; pure orchestrator input). */
export interface RunRestartSelfOptions {
  /** Absolute workspace dir (holds `claude.sh` + `.claude/.macf/`). */
  readonly workspaceDir: string;
  /** Project name (for the `<project>@<routing-label>` session derivation). */
  readonly project?: string;
  /** OTEL agent name (display only; NOT the session key). */
  readonly agentName?: string;
  /**
   * Routing label — the canonical session key (`<project>@<routing-label>`,
   * macf#678), matching what `claude.sh` self-wraps on. Falls back to
   * `agentName` when unset (the name == routing_label case).
   */
  readonly routingLabel?: string;
  /** Explicit session override; when set it wins over the derived form. */
  readonly session?: string;
  readonly reason: RestartReason;
  /** Without this, the command is DRY-RUN regardless. */
  readonly confirm: boolean;
  /** Force dry-run even with `--confirm` (the safer of the two wins). */
  readonly dryRun: boolean;
  readonly json: boolean;
}

/** The `--json` state-record (mirrors `fleet doctor`'s versioned shape). */
export const RESTART_SELF_JSON_SCHEMA_VERSION = 1;

export interface RestartSelfPlan {
  readonly schema_version: number;
  readonly dry_run: boolean;
  readonly reason: RestartReason;
  readonly session: string;
  readonly stash_ref: string | null;
  readonly resume_note_path: string;
  readonly relauncher_path: string;
  readonly killed: boolean;
}

/**
 * Derive `<project>@<routing-label>` (the canonical claude.sh self-wrap session,
 * macf#678), or null. Keyed on the routing-label — NOT the OTEL agent-name — so a
 * name != routing_label agent (science) targets the session `claude.sh` actually
 * created + the watchdog/reconcile target. Falls back to `agentName` when no
 * routing-label is set (name == routing_label agents: code/devops/auditor).
 */
export function resolveSession(opts: RunRestartSelfOptions): string | null {
  const explicit = opts.session?.trim();
  if (explicit) return explicit;
  const p = opts.project?.trim();
  const label = opts.routingLabel?.trim() || opts.agentName?.trim();
  return p && label ? `${p}@${label}` : null;
}

/** The marked-stash label: `macf-restart-self/<ISO-8601-ts>/<reason>`. */
export function stashLabel(iso: string, reason: RestartReason): string {
  return `macf-restart-self/${iso}/${reason}`;
}

const RESUME_NOTE_REL = join('.claude', '.macf', 'RESUME-restart-self.md');
const RELAUNCHER_REL = join('.claude', '.macf', 'restart-self-relauncher.sh');
const HOST_PRELUDE_REL = join('.claude', '.macf', 'host-prelude.sh');
const MACF_DIR_REL = join('.claude', '.macf');

/** The RESUME-note body — what a future session needs to pick the work back up. */
export function buildResumeNote(args: {
  readonly reason: RestartReason;
  readonly iso: string;
  readonly branch: string;
  readonly head: string;
  readonly stashRef: string | null;
}): string {
  const { reason, iso, branch, head, stashRef } = args;
  const stashLine = stashRef ?? 'none';
  const recovery =
    stashRef === null
      ? 'Nothing was stashed (working tree was clean) — just resume your task.'
      : `Your uncommitted tracked changes were stashed. Recover with ` +
        `\`git stash apply ${stashRef}\` (or \`git stash list\` to find it).`;
  return [
    '# macf restart-self — RESUME',
    '',
    `- Reason: ${reason}`,
    `- Timestamp: ${iso}`,
    `- Branch: ${branch}`,
    `- HEAD: ${head}`,
    `- Stash: ${stashLine}`,
    '',
    `Resume from here: ${recovery}`,
    '',
  ].join('\n');
}

/**
 * The detached relauncher script. Waits for the OLD session to die (up to ~30s),
 * then `cd`s to the workspace, sources the host-prelude IF it exists (decoupled
 * from DR-031 piece 4 — proceed if absent), and `exec`s the launcher. Uses
 * absolute paths so it does not depend on the dying session's env beyond what it
 * re-establishes.
 */
export function buildRelauncherScript(args: {
  readonly workspaceDir: string;
  readonly session: string;
  readonly iso: string;
}): string {
  const { workspaceDir, session, iso } = args;
  const prelude = join(workspaceDir, HOST_PRELUDE_REL);
  return [
    '#!/usr/bin/env bash',
    `# macf restart-self relauncher (DR-031 piece 3) — generated ${iso}`,
    '# Detached from the dying agent session; waits for it to exit, then relaunches.',
    'set -uo pipefail',
    `WORKSPACE=${shq(workspaceDir)}`,
    `SESSION=${shq(session)}`,
    `PRELUDE=${shq(prelude)}`,
    '',
    '# Wait for the dying session to actually exit (up to ~30s) so the relaunch',
    "# self-wrap re-creates it cleanly instead of attaching to the corpse.",
    'for _ in $(seq 1 60); do',
    '  tmux has-session -t "$SESSION" 2>/dev/null || break',
    '  sleep 0.5',
    'done',
    '',
    'cd "$WORKSPACE" || exit 1',
    '# host-prelude re-establishes the toolchain (brew/devbox PATH) for a minimal',
    '# (cron/detached) env. Decoupled from DR-031 piece 4 — proceed if absent.',
    'if [ -f "$PRELUDE" ]; then',
    '  # shellcheck disable=SC1090',
    '  . "$PRELUDE"',
    'fi',
    'exec ./claude.sh',
    '',
  ].join('\n');
}

/** Single-quote a value for safe shell embedding (closes + escapes any `'`). */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Human-readable dry-run / confirm plan for the table (non-JSON) output. */
function renderPlanText(plan: RestartSelfPlan, dirty: boolean, workspaceDir: string): string {
  const lines = [
    `macf restart-self — ${plan.dry_run ? 'DRY-RUN (default; pass --confirm to act)' : 'EXECUTING (--confirm)'}`,
    '',
    `  reason:        ${plan.reason}`,
    `  workspace:     ${workspaceDir}`,
    `  session:       ${plan.session}`,
    `  would stash:   ${dirty ? 'yes (uncommitted tracked changes)' : 'no (working tree clean)'}`,
    `  resume note:   ${plan.resume_note_path}`,
    `  relauncher:    ${plan.relauncher_path}`,
    `  kill session:  ${plan.dry_run ? 'NO (dry-run)' : `yes — tmux kill-session -t ${plan.session}`}`,
  ];
  if (plan.dry_run) {
    lines.push('', 'No stash, no kill, no spawn performed. Re-run with --confirm to execute.');
  } else {
    lines.push('', `Stashed: ${plan.stash_ref ?? 'none'}. Detached relauncher spawned; killing session now.`);
  }
  return lines.join('\n');
}

/**
 * Pure orchestrator. Returns the shell exit code. DRY-RUN BY DEFAULT — only a
 * `--confirm` (and not `--dry-run`) run stashes / writes / spawns / kills.
 * Refuses (exit 1) when the session name cannot be resolved.
 */
export async function runRestartSelf(
  opts: RunRestartSelfOptions,
  deps: RestartSelfDeps,
): Promise<number> {
  const session = resolveSession(opts);
  if (!session) {
    console.error(
      'macf restart-self: cannot resolve the tmux session name.\n' +
        'Need MACF_PROJECT + MACF_AGENT_NAME (or project/agent_name in ' +
        '.macf/macf-agent.json), or pass an explicit session. Refusing to act.',
    );
    return 1;
  }

  const { workspaceDir, reason } = opts;
  const resumeNotePath = join(workspaceDir, RESUME_NOTE_REL);
  const relauncherPath = join(workspaceDir, RELAUNCHER_REL);
  const dryRun = opts.dryRun || !opts.confirm;

  const dirty = deps.hasUncommittedTrackedChanges();
  const iso = deps.now().toISOString();

  if (dryRun) {
    const plan = makePlan({ dryRun: true, reason, session, stashRef: null, resumeNotePath, relauncherPath, killed: false });
    if (opts.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(renderPlanText(plan, dirty, workspaceDir));
    return 0;
  }

  // --- CONFIRM mode: prepare → note → spawn → kill (each exactly once) ---
  deps.mkdirp(join(workspaceDir, MACF_DIR_REL));

  // 3. Prepare working tree — marked stash, ONLY when there are tracked changes.
  let stashRef: string | null = null;
  if (dirty) {
    const result = deps.stash(stashLabel(iso, reason));
    stashRef = result.stashed ? (result.ref ?? 'stash@{0}') : null;
  }

  // 4. RESUME-note.
  const note = buildResumeNote({
    reason,
    iso,
    branch: deps.currentBranch(),
    head: deps.headSha(),
    stashRef,
  });
  deps.writeFile(resumeNotePath, note);

  // 5. Detached relauncher (script + spawn).
  const script = buildRelauncherScript({ workspaceDir, session, iso });
  deps.writeFile(relauncherPath, script, 0o755);
  deps.spawnDetached(relauncherPath, []);

  // Emit the result BEFORE the kill — the kill terminates this very process in
  // production (it kills our own session), so anything after it never prints.
  const plan = makePlan({ dryRun: false, reason, session, stashRef, resumeNotePath, relauncherPath, killed: true });
  if (opts.json) console.log(JSON.stringify(plan, null, 2));
  else console.log(renderPlanText(plan, dirty, workspaceDir));

  // 6. Kill the current session — the actual restart trigger.
  deps.killSession(session);
  return 0;
}

function makePlan(args: {
  readonly dryRun: boolean;
  readonly reason: RestartReason;
  readonly session: string;
  readonly stashRef: string | null;
  readonly resumeNotePath: string;
  readonly relauncherPath: string;
  readonly killed: boolean;
}): RestartSelfPlan {
  return {
    schema_version: RESTART_SELF_JSON_SCHEMA_VERSION,
    dry_run: args.dryRun,
    reason: args.reason,
    session: args.session,
    stash_ref: args.stashRef,
    resume_note_path: args.resumeNotePath,
    relauncher_path: args.relauncherPath,
    killed: args.killed,
  };
}

// --- Real-deps factory (production wiring) ---

/** Run a git command in `cwd`, returning trimmed stdout (throws on non-zero). */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], { cwd, encoding: 'utf-8' }).trim();
}

/**
 * Real side-effect implementations bound to a workspace dir. Git reads/stash run
 * in `workspaceDir`; the spawn is FULLY DETACHED (`detached: true` opens a new
 * session — the Node equivalent of `setsid` — plus `stdio: 'ignore'` + `unref()`
 * so the relauncher outlives this process when its session is killed).
 */
export function createRealDeps(workspaceDir: string): RestartSelfDeps {
  return {
    now: () => new Date(),
    hasUncommittedTrackedChanges: () => {
      // Tracked, uncommitted (staged OR unstaged); untracked files excluded.
      const out = git(workspaceDir, ['status', '--porcelain', '--untracked-files=no']);
      return out.length > 0;
    },
    currentBranch: () => {
      try {
        return git(workspaceDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      } catch {
        return '(unknown)';
      }
    },
    headSha: () => {
      try {
        return git(workspaceDir, ['rev-parse', 'HEAD']);
      } catch {
        return '(unknown)';
      }
    },
    stash: (label: string): StashResult => {
      const out = git(workspaceDir, ['stash', 'push', '-m', label]);
      if (/no local changes/i.test(out)) return { stashed: false };
      let ref = 'stash@{0}';
      try {
        ref = git(workspaceDir, ['rev-parse', 'stash@{0}']);
      } catch {
        /* keep the symbolic ref */
      }
      return { stashed: true, ref };
    },
    writeFile: (path: string, content: string, mode?: number) => {
      writeFileSync(path, content, mode !== undefined ? { mode } : undefined);
    },
    mkdirp: (path: string) => {
      mkdirSync(path, { recursive: true });
    },
    spawnDetached: (scriptPath: string, args: readonly string[]) => {
      const child = spawn('/usr/bin/env', ['bash', scriptPath, ...args], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    },
    killSession: (session: string) => {
      try {
        execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
      } catch {
        // The goal — the session's death — is satisfied whether or not the
        // command "succeeds" (e.g. already gone). Never throw on the final step.
      }
    },
  };
}

// --- Command entry point (env + config resolution + real deps) ---

export interface RestartSelfCliOptions {
  readonly reason?: string;
  readonly confirm?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

/**
 * Resolve identity (workspace / project / agent / routing-label) from env first
 * (the running agent's `claude.sh`-exported values), falling back to
 * `.macf/macf-agent.json`. The canonical session claude.sh self-wraps into is
 * `${MACF_PROJECT}@${MACF_ROUTING_LABEL}` (macf#678); `routingLabel` defaults to
 * `agentName` when neither the env var nor `config.routing_label` is set.
 */
export function resolveIdentity(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  readonly workspaceDir: string;
  readonly project?: string;
  readonly agentName?: string;
  readonly routingLabel?: string;
} {
  const config = readAgentConfig(projectDir);
  const workspaceDir = env['MACF_WORKSPACE_DIR']?.trim() || projectDir;
  const project = env['MACF_PROJECT']?.trim() || config?.project;
  const agentName = env['MACF_AGENT_NAME']?.trim() || config?.agent_name;
  const routingLabel =
    env['MACF_ROUTING_LABEL']?.trim() || config?.routing_label || agentName;
  return { workspaceDir, project, agentName, routingLabel };
}

/** `macf restart-self` entry point — resolves config, wires real deps, runs. */
export async function runRestartSelfCommand(
  projectDir: string,
  cliOpts: RestartSelfCliOptions,
): Promise<number> {
  const { workspaceDir, project, agentName, routingLabel } = resolveIdentity(projectDir);
  const deps = createRealDeps(workspaceDir);
  return runRestartSelf(
    {
      workspaceDir,
      project,
      agentName,
      routingLabel,
      reason: coerceReason(cliOpts.reason),
      confirm: cliOpts.confirm === true,
      dryRun: cliOpts.dryRun === true,
      json: cliOpts.json === true,
    },
    deps,
  );
}
