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
import { ROLL_TOUCHED_CONFIG_PATTERNS } from '@groundnuty/macf-core';
import { readAgentConfig, resolveCanonicalBranch } from '../config.js';
import {
  backupSessionTranscript,
  createRealTranscriptDeps,
  type TranscriptPreState,
} from './transcript-backup.js';

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
  /**
   * The matching half of `fleet-upgrade.ts`'s `listDirtyConfig` pre-flight gate
   * (macf#722 Fix B / macf#725): `true` when there are uncommitted TRACKED
   * changes on the roll's touched-config surface specifically (a subset of
   * `hasUncommittedTrackedChanges` — see `ROLL_TOUCHED_CONFIG_PATTERNS` in
   * `@groundnuty/macf-core`'s `fleet-upgrade.ts`). Drives the STANDALONE
   * stash-refusal guard: config-surface dirt refuses the whole restart (never
   * stashes operator config) unless `--force` / `MACF_RESTART_STASH_CONFIG=1`.
   * This guard is BYPASSED (not consulted) when `leaveConfigUncommitted` is
   * set (macf#725 roll path) — see `RunRestartSelfOptions.leaveConfigUncommitted`.
   */
  readonly hasUncommittedConfigChanges: () => boolean;
  readonly currentBranch: () => string;
  readonly headSha: () => string;
  /**
   * Stash uncommitted tracked changes under `label`. When `excludeConfigSurface`
   * is true (macf#725 — the roll's `leaveConfigUncommitted` path), the stash
   * EXCLUDES the touched-config-surface pathspec (`git stash push -- . ':!<pattern>'`
   * per pattern) so config-surface dirt (typically `macf update`'s own
   * regeneration) is deliberately LEFT UNCOMMITTED in the working tree for the
   * relaunched agent to see via `git status`, while any OTHER tracked dirt
   * (unrelated work-in-progress) is still stashed as usual.
   */
  readonly stash: (label: string, opts?: { readonly excludeConfigSurface?: boolean }) => StashResult;
  readonly writeFile: (path: string, content: string, mode?: number) => void;
  readonly mkdirp: (path: string) => void;
  readonly spawnDetached: (scriptPath: string, args: readonly string[]) => void;
  readonly killSession: (session: string) => void;
  /**
   * Back up the active session transcript (rotating) + write the pre-state file
   * the relauncher reads to assert-survived (macf#685). Returns the recorded
   * pre-state, or `null` when there is no active transcript to protect.
   */
  readonly backupTranscript: (
    session: string,
    prestatePath: string,
    now: Date,
  ) => TranscriptPreState | null;
}

/** Where `resolveIdentity` sourced `workspaceDir`/`project`/`agentName`/`routingLabel` from. */
export type IdentitySource = 'dir-flag' | 'env' | 'cwd-discovery';

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
  /**
   * `--force` / `MACF_RESTART_STASH_CONFIG=1` (macf#722 Fix B): bypass the
   * STANDALONE config-surface stash-refusal guard — proceed (and STASH, same
   * as any other dirt) even when the touched-config surface is dirty. Default
   * false: the guard refuses the WHOLE restart (no stash/write/spawn/kill)
   * rather than stash operator config underneath the caller. Mutually
   * distinct from `leaveConfigUncommitted` below — `force` still STASHES the
   * config surface (for a direct operator invocation that just wants to
   * proceed); it does not LEAVE it uncommitted.
   */
  readonly force: boolean;
  /**
   * `--leave-config-uncommitted` / `MACF_RESTART_LEAVE_CONFIG_UNCOMMITTED=1`
   * (macf#725 — the `macf fleet upgrade` roll path): set ONLY by the driver's
   * `restart(agent, { leaveConfigUncommitted: true })` call that immediately
   * follows an `upgrade` in the SAME roll transaction. Two effects, together:
   * (1) the STANDALONE config-dirty stash-refusal guard above is BYPASSED
   * entirely (never consulted — this is not "force past a refusal", the
   * refusal doesn't apply here because the roll's OWN pre-flight already
   * proved the config surface was clean before `upgrade` ran); (2) the stash
   * step EXCLUDES the touched-config-surface pathspec, so whatever `macf
   * update` just regenerated is left UNCOMMITTED in the working tree (visible
   * to the relaunched agent via `git status`) rather than silently stashed
   * away. Any OTHER tracked dirt (unrelated to the config surface) is still
   * stashed normally — this flag narrows what's EXCLUDED from the stash, it
   * does not disable stashing altogether. Default false: a direct/standalone
   * `macf restart-self` invocation keeps the full guard + full-stash behavior.
   */
  readonly leaveConfigUncommitted: boolean;
  /**
   * The resolved canonical branch (macf#755 — `resolveCanonicalBranch`:
   * `MACF_CANONICAL_BRANCH` env > `macf-agent.json` `canonicalBranch` > the
   * `'main'` default). The STANDALONE canonical-branch guard refuses the
   * whole restart (no stash/write/spawn/kill) when `deps.currentBranch()`
   * doesn't match, unless `force` is set or `leaveConfigUncommitted` is set
   * (the roll-path bypass — `macf fleet upgrade`'s OWN branch-gate, macf#755,
   * already vetted this before calling `upgrade`+`restart`).
   */
  readonly canonicalBranch: string;
  /**
   * Where `workspaceDir` / `project` / `agentName` / `routingLabel` were all
   * resolved from (macf#888) — carried into the plan so the resolution is
   * never invisible. `'dir-flag'` when an explicit `--dir` won; `'env'` when
   * ambient `MACF_WORKSPACE_DIR` won (the ordinary no-`--dir` self-restart
   * case, incl. the #763-scrubbed roll path once env is absent); `'cwd-discovery'`
   * when neither was set. See `resolveIdentity`.
   */
  readonly identitySource: IdentitySource;
  /**
   * The discarded `MACF_WORKSPACE_DIR` value, set only when an explicit
   * `--dir` won over a DIFFERING ambient value (macf#888). `null` whenever
   * there is nothing to warn about (env unset, env matches `--dir`, or
   * `--dir` was never passed).
   */
  readonly workspaceDirConflict: string | null;
}

/** The `--json` state-record (mirrors `fleet doctor`'s versioned shape). */
export const RESTART_SELF_JSON_SCHEMA_VERSION = 1;

export interface RestartSelfPlan {
  readonly schema_version: number;
  readonly dry_run: boolean;
  readonly reason: RestartReason;
  readonly session: string;
  readonly workspace_dir: string;
  /** macf#888 — see `RunRestartSelfOptions.identitySource`. */
  readonly identity_source: IdentitySource;
  /** macf#888 — see `RunRestartSelfOptions.workspaceDirConflict`. */
  readonly workspace_dir_conflict: string | null;
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
/** Pre-restart transcript state (macf#685) — written here, read by the relauncher. */
const SESSION_PRESTATE_REL = join('.claude', '.macf', 'restart-self-session-prestate.env');
/** Forensic log the detached relauncher's assert-survived writes into (macf#685). */
const GUARD_LOG_REL = join('.claude', '.macf', 'restart-self-guard.log');

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
 * then `cd`s to the workspace, spawns the assert-survived watcher (macf#685),
 * sources the host-prelude IF it exists (decoupled from DR-031 piece 4 — proceed
 * if absent), and relaunches into a FRESH detached tmux session. Uses absolute
 * paths so it does not depend on the dying session's env beyond what it
 * re-establishes.
 *
 * **macf#711 root cause + fix.** The relauncher process is detached from (but
 * still ENV-inherits) the dying agent's tmux pane, so `$TMUX` / `$TMUX_PANE` are
 * still SET in the relauncher's own environment even though it has no
 * controlling terminal. A bare `exec ./claude.sh` therefore skips `claude.sh`'s
 * own tmux self-wrap entirely (`[ -z "${TMUX:-}" ]` is false) and — even were
 * `$TMUX` unset first — that self-wrap's `tmux new-session` (no `-d`) needs a
 * controlling terminal to attach to and fails with "open terminal failed: not a
 * terminal" from a detached/`stdio:ignore` spawn. Both failure paths leave the
 * agent DOWN with no tmux session and no process — reproduced + root-caused via
 * live `spawn(..., { detached: true, stdio: 'ignore' })` experiments (macf#711).
 * The fix: the relauncher creates the fresh DETACHED session itself
 * (`tmux new-session -d -s "$SESSION" ...`, the exact form proven to work for
 * manual recovery) and passes `MACF_NO_TMUX_WRAP=1` to the inner `claude.sh` so
 * it does not attempt (and fail) its own self-wrap — `claude.sh` is already
 * running inside the fresh session by the time it starts, so `$TMUX` being set
 * there is the CORRECT signal to skip re-wrapping, not a leftover artifact.
 *
 * Assert-survived is Pattern A (silent-fallback-hazards): "restart exited 0" ≠
 * "the transcript survived". It runs in a DETACHED background watcher spawned
 * BEFORE the `exec` (exec replaces this process, so nothing after it runs — the
 * watcher is a separate PID that outlives the exec and polls the relaunched
 * session). It WAITS for the relaunch to come live (transcript mtime advancing)
 * BEFORE comparing — comparing the instant the relaunch spawns races the
 * transcript re-open and false-trips gone/shrank. The SAME watcher now also
 * asserts the tmux session itself came up (macf#711 AC#2) — a silent
 * session-creation failure must not be indistinguishable from "still starting".
 */
export function buildRelauncherScript(args: {
  readonly workspaceDir: string;
  readonly session: string;
  readonly iso: string;
  readonly prestatePath: string;
  readonly guardLogPath: string;
}): string {
  const { workspaceDir, session, iso, prestatePath, guardLogPath } = args;
  const prelude = join(workspaceDir, HOST_PRELUDE_REL);
  return [
    '#!/usr/bin/env bash',
    `# macf restart-self relauncher (DR-031 piece 3) — generated ${iso}`,
    '# Detached from the dying agent session; waits for it to exit, then relaunches.',
    'set -uo pipefail',
    `WORKSPACE=${shq(workspaceDir)}`,
    `SESSION=${shq(session)}`,
    `PRELUDE=${shq(prelude)}`,
    `PRESTATE=${shq(prestatePath)}`,
    `GUARD_LOG=${shq(guardLogPath)}`,
    '# Wait-for-live poll bounds (assert-survived rides the relaunch coming up).',
    'LIVE_TIMEOUT="${MACF_RESTART_LIVE_TIMEOUT:-120}"',
    'LIVE_INTERVAL="${MACF_RESTART_LIVE_INTERVAL:-3}"',
    '',
    ...relauncherGuardLines(),
    '',
    '# Wait for the dying session to actually exit (up to ~30s) so the relaunch',
    "# self-wrap re-creates it cleanly instead of attaching to the corpse.",
    'for _ in $(seq 1 60); do',
    '  tmux has-session -t "$SESSION" 2>/dev/null || break',
    '  sleep 0.5',
    'done',
    '',
    'cd "$WORKSPACE" || exit 1',
    '',
    '# Assert-live + assert-survived (Pattern A, macf#685 + macf#711): spawn the',
    '# guard as a DETACHED watcher BEFORE the exec below — exec replaces this',
    '# process, so anything after it never runs; the watcher is a separate PID',
    '# that survives the exec and polls the relaunched session. Fail-open: it',
    '# never blocks or aborts the relaunch, but it DOES surface a loud, durable',
    '# alert into $GUARD_LOG on failure (macf#711 AC#2) — a silent agent-down is',
    '# what let the original incident hang `fleet upgrade` invisibly.',
    '(',
    '  assert_session_live "$SESSION" >>"$GUARD_LOG" 2>&1',
    '  if [ -f "$PRESTATE" ]; then',
    '    assert_transcript_survived >>"$GUARD_LOG" 2>&1',
    '  fi',
    ') &',
    'disown 2>/dev/null || true',
    '',
    '# host-prelude re-establishes the toolchain (brew/devbox PATH) for a minimal',
    '# (cron/detached) env. Decoupled from DR-031 piece 4 — proceed if absent.',
    'if [ -f "$PRELUDE" ]; then',
    '  # shellcheck disable=SC1090',
    '  . "$PRELUDE"',
    'fi',
    '',
    '# Relaunch into a FRESH detached tmux session (macf#711) — the exact form',
    '# proven to work for manual recovery. A bare `exec ./claude.sh` here would',
    '# rely on claude.sh\'s OWN self-wrap, which (a) is defeated because $TMUX /',
    '# $TMUX_PANE are still set in this relauncher\'s inherited env even though it',
    '# has no controlling terminal, and (b) even with $TMUX unset, its',
    '# `tmux new-session` (no -d) needs a controlling terminal and fails with',
    '# "open terminal failed: not a terminal" when run detached. Creating the',
    '# session ourselves with -d sidesteps both. MACF_NO_TMUX_WRAP=1 tells the',
    '# inner claude.sh not to attempt (and fail) its own wrap — by the time it',
    '# runs it is already inside the fresh session, so $TMUX being set there is',
    '# the CORRECT signal, not a leftover artifact.',
    'exec tmux new-session -d -s "$SESSION" -c "$WORKSPACE" \\',
    '  "MACF_NO_TMUX_WRAP=1 exec \\"$WORKSPACE/claude.sh\\""',
    '',
  ].join('\n');
}

/**
 * The assert-survived guard functions embedded in the relauncher (macf#685).
 * Lifted from the VM reference `fleet/upgrade.sh` (`session_state` /
 * `session_survived`), split so the pure compare (`session_survived`) is
 * unit-testable via the `MACF_TEST_SESSION` seam WITHOUT real files.
 *
 * The invariant (append-only `.jsonl`): a healthy resume keeps the transcript at
 * least as large as before. LOSS = the transcript is GONE, or it SHRANK (a size
 * regression is impossible for an append-only log → truncation / fresh-start /
 * mis-resume). A uuid change WITH growth is allowed but NOTED.
 */
export function relauncherGuardLines(): readonly string[] {
  return [
    '# --- assert-survived guard (Pattern A; macf#685) --------------------------',
    '# session_post_state <projdir> -> "<uuid> <bytes>" of the newest .jsonl, "" if none.',
    '# Test seam: MACF_TEST_SESSION="<uuid>,<bytes>" DEFINED => authoritative (skips disk).',
    'session_post_state() {',
    '  if [ "${MACF_TEST_SESSION+set}" = set ]; then',
    '    [ -n "$MACF_TEST_SESSION" ] && printf \'%s\\n\' "$MACF_TEST_SESSION" | tr \',\' \' \'',
    '    return 0',
    '  fi',
    '  local projdir="$1" sf',
    '  sf="$(ls -t "$projdir"/*.jsonl 2>/dev/null | head -1)"',
    '  [ -n "${sf:-}" ] && [ -f "$sf" ] || { echo ""; return 0; }',
    '  echo "$(basename "$sf" .jsonl) $(stat -c%s "$sf" 2>/dev/null || stat -f%z "$sf" 2>/dev/null || echo 0)"',
    '}',
    '',
    '# session_survived <projdir> "<pre_uuid> <pre_size>" -> 0 survived, 1 HALT (state loss).',
    'session_survived() {',
    '  local projdir="$1" pre="$2" post pre_uuid pre_size post_uuid post_size',
    '  [ -n "$pre" ] || { echo "[state-guard] no pre-state — guard skipped"; return 0; }',
    '  post="$(session_post_state "$projdir")"',
    '  pre_uuid="${pre%% *}"; pre_size="${pre##* }"',
    '  if [ -z "$post" ]; then',
    '    echo "[STATE-GUARD] HALT: no active transcript after restart — possible state loss."',
    '    return 1',
    '  fi',
    '  post_uuid="${post%% *}"; post_size="${post##* }"',
    '  if [ "${post_size:-0}" -lt "${pre_size:-0}" ]; then',
    '    echo "[STATE-GUARD] HALT: transcript SHRANK after restart (pre=[$pre] post=[$post]) — truncation / fresh-start / mis-resume."',
    '    return 1',
    '  fi',
    '  [ "$post_uuid" != "$pre_uuid" ] && echo "[state-guard] note: uuid changed $pre_uuid -> $post_uuid (grew — not a loss, but verify the right session resumed)."',
    '  return 0',
    '}',
    '',
    '# assert_session_live <session> — WAIT (up to LIVE_TIMEOUT) for the tmux',
    '# session to exist, then assert it. This is the macf#711 structural fix\'s',
    '# OWN result-invariant check (Pattern A): "the relauncher ran to completion"',
    '# must not be conflated with "a live session came back" — that conflation is',
    '# exactly what let the original incident hang `fleet upgrade` invisibly with',
    '# no signal that the agent never came back up. Fail-open (never aborts',
    '# anything — the relaunch already happened by the time this runs) but LOUD',
    '# (a durable alert banner in $GUARD_LOG, same convention as the transcript',
    '# guard below) on failure.',
    '# Test seam: MACF_TEST_TMUX_UP="0"|"1" DEFINED => authoritative (skips the',
    '# real `tmux has-session` call so this is unit-testable without a live server).',
    'assert_session_live() {',
    '  local session="$1"',
    '  local deadline=$(( $(date +%s) + LIVE_TIMEOUT )) up=0',
    '  while [ "$(date +%s)" -lt "$deadline" ]; do',
    '    if [ "${MACF_TEST_TMUX_UP+set}" = set ]; then',
    '      [ "$MACF_TEST_TMUX_UP" = "1" ] && up=1',
    '      break',
    '    elif tmux has-session -t "$session" 2>/dev/null; then',
    '      up=1',
    '      break',
    '    fi',
    '    sleep "$LIVE_INTERVAL"',
    '  done',
    '  if [ "$up" -eq 1 ]; then',
    '    echo "[session-guard] OK: tmux session \'$session\' is live after relaunch."',
    '    return 0',
    '  fi',
    '  echo "==================== macf restart-self SESSION-GUARD ALERT =================="',
    '  echo "  The relaunch did NOT bring up a live tmux session within ${LIVE_TIMEOUT}s."',
    '  echo "  session: $session"',
    '  echo "  The agent is DOWN — nothing will register/respond until manually"',
    '  echo "  recovered, e.g.: tmux new-session -d -s \'$session\' \\"cd ${WORKSPACE:-<workspace>} && ./claude.sh\\""',
    '  echo "==============================================================================="',
    '  return 1',
    '}',
    '',
    '# assert_transcript_survived — WAIT for the relaunch to come live (the transcript',
    "# mtime advancing past pre-restart), THEN compare. Comparing the instant the",
    '# relaunch spawns races the transcript re-open + false-trips gone/shrank.',
    'assert_transcript_survived() {',
    '  # shellcheck disable=SC1090',
    '  . "$PRESTATE" 2>/dev/null || { echo "[state-guard] pre-state unreadable — guard skipped"; return 0; }',
    '  local projdir="${MACF_RESTART_PROJECT_DIR:-}" pre_uuid="${MACF_RESTART_PRE_UUID:-}"',
    '  local pre_size="${MACF_RESTART_PRE_SIZE:-0}" pre_mtime="${MACF_RESTART_PRE_MTIME:-0}"',
    '  local backup_dir="${MACF_RESTART_BACKUP_DIR:-}"',
    '  [ -n "$projdir" ] || { echo "[state-guard] no project dir in pre-state — guard skipped"; return 0; }',
    '',
    '  # wait-for-live: poll the active transcript mtime advancing past pre-restart.',
    '  local deadline=$(( $(date +%s) + LIVE_TIMEOUT )) live=0 sf cur',
    '  while [ "$(date +%s)" -lt "$deadline" ]; do',
    '    sf="$(ls -t "$projdir"/*.jsonl 2>/dev/null | head -1)"',
    '    if [ -n "${sf:-}" ] && [ -f "$sf" ]; then',
    '      cur="$(stat -c%Y "$sf" 2>/dev/null || stat -f%m "$sf" 2>/dev/null || echo 0)"',
    '      [ "${cur:-0}" -gt "${pre_mtime:-0}" ] && { live=1; break; }',
    '    fi',
    '    sleep "$LIVE_INTERVAL"',
    '  done',
    '  [ "$live" -eq 1 ] || echo "[state-guard] warning: relaunched session did not write within ${LIVE_TIMEOUT}s — comparing anyway."',
    '',
    '  if session_survived "$projdir" "$pre_uuid $pre_size"; then',
    '    echo "[state-guard] OK: transcript survived the restart (pre uuid=$pre_uuid size=$pre_size)."',
    '    return 0',
    '  fi',
    '  # HALT path — the relaunch already happened, so this SURFACES the loss LOUDLY',
    '  # and points at the retained backup for restore.',
    '  echo "==================== macf restart-self STATE-GUARD ALERT ===================="',
    '  echo "  A possible SESSION-STATE LOSS was detected after restart (Pattern A)."',
    '  echo "  pre-state: uuid=$pre_uuid size=$pre_size mtime=$pre_mtime"',
    '  echo "  RESTORE from the retained backup: $backup_dir"',
    '  echo "  (the newest .jsonl.bak there is the pre-restart transcript.)"',
    '  echo "============================================================================="',
    '  return 1',
    '}',
  ];
}

/** Single-quote a value for safe shell embedding (closes + escapes any `'`). */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Human-readable label for `identity_source` — used on both the `workspace:` and `session:` lines. */
function sourceLabel(source: IdentitySource): string {
  switch (source) {
    case 'dir-flag':
      return 'from --dir';
    case 'env':
      return 'from MACF_WORKSPACE_DIR';
    case 'cwd-discovery':
      return 'from cwd auto-discovery';
  }
}

/**
 * Human-readable dry-run / confirm plan for the table (non-JSON) output.
 * macf#888 — every line here used to look like a normal successful plan even
 * when `--dir` had been silently discarded in favor of the CALLER's ambient
 * `MACF_WORKSPACE_DIR`. Both the resolution *source* (not just the value) and
 * an explicit conflict banner are now always rendered, on BOTH the dry-run
 * and confirm paths (this function is the single render path for both).
 */
function renderPlanText(plan: RestartSelfPlan, dirty: boolean): string {
  const lines = [
    `macf restart-self — ${plan.dry_run ? 'DRY-RUN (default; pass --confirm to act)' : 'EXECUTING (--confirm)'}`,
    '',
    `  reason:        ${plan.reason}`,
  ];
  if (plan.workspace_dir_conflict) {
    lines.push(
      `  ⚠ CONFLICT: --dir wins over MACF_WORKSPACE_DIR=${plan.workspace_dir_conflict} — ` +
        'without this, restart-self would silently target the CALLER, not the named workspace.',
    );
  }
  lines.push(
    `  workspace:     ${plan.workspace_dir} (${sourceLabel(plan.identity_source)})`,
    `  session:       ${plan.session} (${sourceLabel(plan.identity_source)})`,
    `  would stash:   ${dirty ? 'yes (uncommitted tracked changes)' : 'no (working tree clean)'}`,
    `  resume note:   ${plan.resume_note_path}`,
    `  relauncher:    ${plan.relauncher_path}`,
    `  kill session:  ${plan.dry_run ? 'NO (dry-run)' : `yes — tmux kill-session -t ${plan.session}`}`,
  );
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
  // macf#888 — fire the conflict warning FIRST, unconditionally (dry-run,
  // confirm, --json, AND even the session-refusal path below): dry-run is
  // the default mode and the exact one the issue reports ("every line looks
  // like a normal successful plan"), so the warning must not be gated behind
  // any later branch. This is IN ADDITION TO the plan carrying the same
  // fields (see makePlan below) — stderr for anyone scanning past a wall of
  // stdout, the plan for anyone parsing --json or reading the rendered text.
  if (opts.workspaceDirConflict) {
    console.error(
      `macf restart-self: --dir wins over MACF_WORKSPACE_DIR=${opts.workspaceDirConflict} ` +
        `— targeting ${opts.workspaceDir} (without this, restart-self would ` +
        'silently target the CALLER, not the named workspace).',
    );
  }

  const session = resolveSession(opts);
  if (!session) {
    console.error(
      'macf restart-self: cannot resolve the tmux session name.\n' +
        'Need MACF_PROJECT + MACF_AGENT_NAME (or project/agent_name in ' +
        '.macf/macf-agent.json), or pass an explicit session. Refusing to act.',
    );
    return 1;
  }

  const { workspaceDir, reason, identitySource, workspaceDirConflict } = opts;
  const resumeNotePath = join(workspaceDir, RESUME_NOTE_REL);
  const relauncherPath = join(workspaceDir, RELAUNCHER_REL);
  const prestatePath = join(workspaceDir, SESSION_PRESTATE_REL);
  const guardLogPath = join(workspaceDir, GUARD_LOG_REL);
  const dryRun = opts.dryRun || !opts.confirm;

  const dirty = deps.hasUncommittedTrackedChanges();
  const nowDate = deps.now();
  const iso = nowDate.toISOString();

  if (dryRun) {
    const plan = makePlan({
      dryRun: true,
      reason,
      session,
      workspaceDir,
      identitySource,
      workspaceDirConflict,
      stashRef: null,
      resumeNotePath,
      relauncherPath,
      killed: false,
    });
    if (opts.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(renderPlanText(plan, dirty));
    return 0;
  }

  // The roll-path bypass (macf#725) — set ONLY by `macf fleet upgrade`'s
  // `restart(agent, { leaveConfigUncommitted: true })` call. It SKIPS the
  // standalone guard below entirely: the roll's OWN pre-flight already proved
  // the config surface was clean before `upgrade` ran, so there is nothing to
  // "refuse" — the only dirt now is `upgrade`'s own expected regeneration,
  // which this restart must leave uncommitted (see the stash call further
  // down), never stash away or refuse over.
  const leaveConfigUncommitted =
    opts.leaveConfigUncommitted || process.env['MACF_RESTART_LEAVE_CONFIG_UNCOMMITTED'] === '1';

  // Canonical-branch guard (macf#755) — the FIRST refusal, before the
  // config-surface guard below: cheapest + most fundamental (branch-
  // correctness precedes config-correctness). STANDALONE-invocation ONLY
  // (bypassed entirely by `leaveConfigUncommitted` — the roll-path, whose
  // OWN branch-gate in `rollFleet` already vetted this before calling
  // `restart`). Refuses the WHOLE restart (no stash/write/spawn/kill) when
  // the workspace is not on its canonical branch, unless `--force`. A
  // relaunch on the wrong branch either corrupts a feature branch (macf
  // update's regen + any auto-resolve commit land there) or comes back up
  // stale on it — the same hazard `rollFleet`'s branch-gate exists to catch.
  if (!leaveConfigUncommitted && !opts.force) {
    const branch = deps.currentBranch();
    if (branch !== opts.canonicalBranch) {
      console.error(
        `macf restart-self: refusing — on branch \`${branch}\`, expected ` +
          `\`${opts.canonicalBranch}\`. A relaunch here would either corrupt a ` +
          'non-canonical branch (config regen + any auto-resolve commit land on it) ' +
          'or come back up stale on it. Switch to the canonical branch, or pass ' +
          '--force to proceed anyway.',
      );
      return 1;
    }
  }

  // Config-surface stash-refusal guard (macf#722 Fix B) — STANDALONE-invocation
  // ONLY (bypassed entirely by `leaveConfigUncommitted` above). CONFIRM-mode
  // only; dry-run above already returned. Refuses the WHOLE restart (no
  // stash/write/spawn/kill) when the touched-config surface is dirty, unless
  // explicitly overridden with `--force`. Never partially-proceeds on ITS OWN
  // (e.g. stashing only the non-config files) — that would still risk `macf
  // update` clobbering config left dirty on disk mid-restart for a direct
  // operator invocation that never ran the roll's pre-flight gate.
  const forceStashConfig = opts.force || process.env['MACF_RESTART_STASH_CONFIG'] === '1';
  if (!leaveConfigUncommitted && !forceStashConfig && deps.hasUncommittedConfigChanges()) {
    console.error(
      'macf restart-self: refusing — uncommitted config-surface changes ' +
        '(claude.sh, .claude/rules/**, .claude/scripts/**, .claude/settings.json, ' +
        'the managed .claude/.macf/env.* + host-prelude.sh, CLAUDE.md, ' +
        'env.local.*) would be stashed ' +
        'by a restart. Commit them first, or pass --force / set ' +
        'MACF_RESTART_STASH_CONFIG=1 to proceed anyway.',
    );
    return 1;
  }

  // --- CONFIRM mode: prepare → backup → note → spawn → kill (each exactly once) ---
  deps.mkdirp(join(workspaceDir, MACF_DIR_REL));

  // 3. Prepare working tree — marked stash, ONLY when there are tracked changes.
  // `leaveConfigUncommitted` (macf#725) EXCLUDES the touched-config-surface
  // pathspec from the stash — the config regen `upgrade` just produced stays
  // uncommitted in the tree (visible via `git status` after relaunch), while
  // any OTHER tracked dirt is still stashed as usual.
  let stashRef: string | null = null;
  if (dirty) {
    const result = deps.stash(
      stashLabel(iso, reason),
      leaveConfigUncommitted ? { excludeConfigSurface: true } : undefined,
    );
    stashRef = result.stashed ? (result.ref ?? 'stash@{0}') : null;
  }

  // 3b. Back up the session transcript + record pre-state (macf#685) — the
  // TRANSCRIPT half of "protect state before the destructive restart". No-op
  // (returns null) when there's no active transcript; the relauncher's guard
  // then finds no pre-state file and skips.
  deps.backupTranscript(session, prestatePath, nowDate);

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
  const script = buildRelauncherScript({
    workspaceDir,
    session,
    iso,
    prestatePath,
    guardLogPath,
  });
  deps.writeFile(relauncherPath, script, 0o755);
  deps.spawnDetached(relauncherPath, []);

  // Emit the result BEFORE the kill — the kill terminates this very process in
  // production (it kills our own session), so anything after it never prints.
  const plan = makePlan({
    dryRun: false,
    reason,
    session,
    workspaceDir,
    identitySource,
    workspaceDirConflict,
    stashRef,
    resumeNotePath,
    relauncherPath,
    killed: true,
  });
  if (opts.json) console.log(JSON.stringify(plan, null, 2));
  else console.log(renderPlanText(plan, dirty));

  // 6. Kill the current session — the actual restart trigger.
  deps.killSession(session);
  return 0;
}

function makePlan(args: {
  readonly dryRun: boolean;
  readonly reason: RestartReason;
  readonly session: string;
  readonly workspaceDir: string;
  readonly identitySource: IdentitySource;
  readonly workspaceDirConflict: string | null;
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
    workspace_dir: args.workspaceDir,
    identity_source: args.identitySource,
    workspace_dir_conflict: args.workspaceDirConflict,
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
    hasUncommittedConfigChanges: () => {
      // Same tracked-only predicate, scoped to the roll's touched-config
      // surface (macf#722 Fix B / macf#725) — the matching guard to
      // `fleet-upgrade.ts`'s `listDirtyConfig` pre-flight gate.
      try {
        const out = git(workspaceDir, [
          'status',
          '--porcelain',
          '--untracked-files=no',
          '--',
          ...ROLL_TOUCHED_CONFIG_PATTERNS,
        ]);
        return out.length > 0;
      } catch {
        // Not a git repo / git unavailable → fail-open (never block a restart
        // on an inspection failure the surrounding tracked-changes check would
        // have already surfaced via `hasUncommittedTrackedChanges` anyway).
        return false;
      }
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
    stash: (label: string, stashOpts?: { readonly excludeConfigSurface?: boolean }): StashResult => {
      // `excludeConfigSurface` (macf#725): stash everything EXCEPT the roll's
      // touched-config surface — `git stash push -- . ':!<pattern>'` per
      // pattern, which stashes all OTHER tracked dirt while leaving the
      // config-surface paths uncommitted in the working tree.
      const args = stashOpts?.excludeConfigSurface
        ? [
            'stash',
            'push',
            '-m',
            label,
            '--',
            '.',
            ...ROLL_TOUCHED_CONFIG_PATTERNS.map((p) => `:!${p}`),
          ]
        : ['stash', 'push', '-m', label];
      const out = git(workspaceDir, args);
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
    backupTranscript: (session: string, prestatePath: string, now: Date) => {
      // Best-effort insurance: a backup failure must NOT abort the restart.
      try {
        return backupSessionTranscript(createRealTranscriptDeps(), session, prestatePath, now);
      } catch {
        return null;
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
  /** `--force` (macf#722 Fix B) — bypass the STANDALONE config-surface stash-refusal guard. */
  readonly force?: boolean;
  /**
   * `--leave-config-uncommitted` (macf#725) — the `macf fleet upgrade` roll
   * path's flag: skip the standalone guard entirely + leave the config
   * surface uncommitted instead of stashing it. Not intended for direct
   * operator use (the roll's driver passes it); documented on the CLI surface
   * for completeness / scripting.
   */
  readonly leaveConfigUncommitted?: boolean;
  /**
   * True iff the caller passed `--dir` on argv (macf#888) — as opposed to
   * `projectDir` merely holding a resolved path (which is ALWAYS truthy,
   * whether it came from `--dir` or from cwd auto-discovery; `projectDir`
   * alone can't distinguish the two — macf#347's lesson about inferring
   * "explicit" from a value that's equally present on the default path).
   * index.ts's `--dir <path>` registration carries no commander default, so
   * `opts.dir` is `undefined` exactly when the flag is absent; the caller
   * captures `opts.dir !== undefined` BEFORE `resolveProjectDir` collapses
   * both paths into the same string shape.
   */
  readonly dirExplicit?: boolean;
}

export interface ResolvedIdentity {
  readonly workspaceDir: string;
  readonly identitySource: IdentitySource;
  /** The discarded `MACF_WORKSPACE_DIR`, only when `--dir` won over a DIFFERING one. */
  readonly workspaceDirConflict: string | null;
  readonly project?: string;
  readonly agentName?: string;
  readonly routingLabel?: string;
}

/**
 * Resolve identity (workspace / project / agent / routing-label).
 *
 * `dirExplicit=false` (default — the ordinary self-restart invocation, and
 * the #763-scrubbed `fleet upgrade` roll path, which passes NO `--dir` at
 * all): unchanged from pre-macf#888 behavior — ambient env wins over
 * `.macf/macf-agent.json`, which wins over the auto-discovered `projectDir`.
 * This is intentionally untouched so #763's fix (scrub the orchestrator's
 * `MACF_*` env before exec'ing `restart-self` with no `--dir`) keeps working
 * exactly as before: with env absent, this branch already fell through to
 * config/cwd, which is what made that fix sufficient.
 *
 * `dirExplicit=true` (macf#888 — an explicit `--dir <other-workspace>`): the
 * operator named a workspace on purpose, almost always NOT their own. Every
 * `MACF_*` env var belongs to the CALLING agent's session (`claude.sh` sets
 * them for itself), so none of them may leak into a cross-workspace
 * resolution — that leak is exactly what silently retargeted `--dir` at the
 * caller for BOTH `workspaceDir` and the derived `<project>@<routing-label>`
 * session. Source ONLY the target's own config (`config`, already read from
 * `projectDir` == the validated `--dir` path) — no env fallback: if the
 * target's config lacks `project`/`agent_name`, `resolveSession` correctly
 * refuses (exit 1) rather than silently borrowing the caller's identity.
 */
export function resolveIdentity(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  dirExplicit = false,
): ResolvedIdentity {
  const config = readAgentConfig(projectDir);
  const envWorkspaceDir = env['MACF_WORKSPACE_DIR']?.trim();

  if (dirExplicit) {
    return {
      workspaceDir: projectDir,
      identitySource: 'dir-flag',
      workspaceDirConflict:
        envWorkspaceDir && envWorkspaceDir !== projectDir ? envWorkspaceDir : null,
      project: config?.project,
      agentName: config?.agent_name,
      routingLabel: config?.routing_label || config?.agent_name,
    };
  }

  const project = env['MACF_PROJECT']?.trim() || config?.project;
  const agentName = env['MACF_AGENT_NAME']?.trim() || config?.agent_name;
  const routingLabel = env['MACF_ROUTING_LABEL']?.trim() || config?.routing_label || agentName;
  return {
    workspaceDir: envWorkspaceDir || projectDir,
    identitySource: envWorkspaceDir ? 'env' : 'cwd-discovery',
    workspaceDirConflict: null,
    project,
    agentName,
    routingLabel,
  };
}

/** `macf restart-self` entry point — resolves config, wires real deps, runs. */
export async function runRestartSelfCommand(
  projectDir: string,
  cliOpts: RestartSelfCliOptions,
): Promise<number> {
  const { workspaceDir, identitySource, workspaceDirConflict, project, agentName, routingLabel } =
    resolveIdentity(projectDir, process.env, cliOpts.dirExplicit === true);
  // macf#755 — resolve the canonical-branch guard's expected branch from the
  // SAME `projectDir` config `resolveIdentity` reads (env override still
  // applies regardless of whether a config is found).
  const canonicalBranch = resolveCanonicalBranch(readAgentConfig(projectDir));
  const deps = createRealDeps(workspaceDir);
  return runRestartSelf(
    {
      workspaceDir,
      identitySource,
      workspaceDirConflict,
      project,
      agentName,
      routingLabel,
      canonicalBranch,
      reason: coerceReason(cliOpts.reason),
      confirm: cliOpts.confirm === true,
      dryRun: cliOpts.dryRun === true,
      json: cliOpts.json === true,
      force: cliOpts.force === true,
      leaveConfigUncommitted: cliOpts.leaveConfigUncommitted === true,
    },
    deps,
  );
}
