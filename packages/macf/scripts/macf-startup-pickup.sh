#!/usr/bin/env bash
#
# macf-startup-pickup.sh — canonical SessionStart hook (groundnuty/macf#768)
# that surfaces pending work at session start and, for auto-resuming roles,
# submits a follow-up prompt so the agent picks the queue up without an
# operator nudge. Canonicalizes the "check pending issues at startup, then
# self-nudge" behavior agents had previously hand-rolled per-workspace in
# their gitignored `settings.local.json` (with duplicated `gh issue list`
# logic and, in at least one case, a buggy single-`Enter` tmux submit that
# never actually reaches Claude Code's multi-line input mode).
#
# THIN BY DESIGN: this hook does NOT hand-roll a GitHub query. It delegates
# the entire queue-discovery + inbox-drain + coordination.md §Communication 5
# sweep-injection to the plugin's OWN `issues` command — the exact command
# backing the `/macf-issues` skill (see plugin/skills/macf-issues/SKILL.md)
# — which already mints its own fresh GitHub token via the refresh-aware
# client (macf#338) and already does install-set x label pending-work
# discovery. Only the SUBMIT step below is bash: the Claude Code TUI's
# multi-line-input Enter quirk has no non-bash equivalent, and it goes
# through the sanctioned tmux-send-to-claude.sh 2-step-Enter helper — never
# an inline `tmux send-keys ... Enter`, which silently fails to submit.
#
# ROLE-AWARE DEFAULT (DR-026): auto-pickup defaults ON for every actuator
# role (code-agent / science-agent / devops-agent / writing-agent / the
# exp-* variants) and OFF for the auditor — the auditor is a propose-only
# sensor/discussant, never an actuator, and auto-submitting a work-pickup
# turn would make it act. This mirrors
# `startupPickupAutoResumesByDefault()` in
# packages/macf/src/cli/role-settings-model.ts (a lockstep test pins both
# copies to the same 'auditor' sentinel — the TS side can't be imported by
# bash, so the policy is intentionally duplicated, not derived).
#
# This gate is enforced by THIS SCRIPT reading `MACF_AGENT_ROLE` at runtime
# (exported by claude.sh / env-files.ts), NOT by conditionally omitting the
# settings.json entry at `macf init`/`update` generation time: `macf rules
# refresh` (the hand-wired-substrate distribution path this hook ALSO ships
# through, alongside `macf init` / `macf update`) has no workspace-role
# information available at write time (no `.macf/macf-agent.json` to read —
# see rules-refresh.ts). So the settings.json entry is written
# unconditionally for every workspace/role, mirroring
# check-auditor-never-acts.sh's own "distribute everywhere, gate at runtime"
# shape.
#
# Hook contract (SessionStart): JSON on stdin — the workspace path comes from
# $CLAUDE_PROJECT_DIR, but the payload IS now read (see TRIGGER + SUBAGENT
# GATE below, groundnuty/macf#930). STDOUT is injected into the agent's
# context. OBSERVATIONAL for the query half (deposits the plugin's own
# `issues`-command output into the agent's context, identical to what
# `/macf-issues` would print) — that half is instant once the gate below
# passes. The SUBMIT half ALWAYS exits 0 (fail open on a missing plugin
# mount, a query error, a missing tmux session, or any internal fault) but is
# NOT instant by design as of groundnuty/macf#802 — see below.
#
# TRIGGER + SUBAGENT GATE (groundnuty/macf#930): the pickup nudge is
# appropriate ONLY for a genuine fresh client start. Pre-#930 this hook was
# registered matcher-less (fires on every SessionStart source) and never
# read its own payload, so it ALSO fired on `compact` / `resume` / `clear` /
# `fork` (competing with in-flight work right after the agent lost context
# to compaction — the worst time to spend it re-injecting a queue prompt)
# and reached at least one MACF-orchestrated worker/subagent session
# (operator-witnessed live, groundnuty/macf#930 comments), which cannot
# distinguish an ambient framework injection from a genuine task from its
# principal. Independent, deliberately non-bypassable checks below:
#   - `source` must be exactly `startup` (registration also carries
#     `matcher: "startup"` as defense-in-depth, but the script-side check is
#     the one that actually gates the payload — Claude Code evaluates a
#     `matcher` before invoking the command at all, which makes a matcher
#     alone unobservable/untestable from inside the script, and this script
#     is what a test actually drives). Field name + values (startup/resume/
#     clear/compact/fork) verified against Claude Code's own hooks reference
#     (https://code.claude.com/docs/en/hooks — SessionStart matcher row)
#     plus a captured payload example, corroborated internally by this
#     repo's own DR-034 `SessionStart(source=compact)` usage — not
#     assumed from memory.
#   - `agent_id` must be absent — Claude Code documents `agent_id` as
#     present "ONLY when the hook fires inside a subagent", the precise
#     signal (deliberately NOT `agent_type` too — see the inline comment at
#     the check itself for why that field would false-positive on a
#     legitimate `--agent`-launched top-level session). This is a
#     BEST-EFFORT check: a MACF-orchestrated worktree/background worker
#     plausibly presents as a genuine `source: startup` session with
#     `agent_id` unset (it is not Claude Code's own Task-tool subagent,
#     which per the docs doesn't fire SessionStart at all), so this check
#     alone cannot see it. See the LINKED-WORKTREE check below (#1042) for
#     the fix that closes that residual.
#   - LINKED-WORKTREE check (groundnuty/macf#1042): closes the residual the
#     two checks above admit. A worktree/background-worker session spawned
#     via `git worktree add` (Agent-tool `isolation: "worktree"`; this
#     repo's own `agent-identity.md` "Parallel Issue Execution with Teams"
#     pattern) is a genuine separate `claude` process — it DOES fire
#     SessionStart — but empirically (live side-by-side comparison,
#     groundnuty/macf#1042) it inherits its parent's FULL environment
#     verbatim: `MACF_AGENT_TYPE`, `CLAUDE_CODE_CHILD_SESSION`, `$TMUX` (even
#     the exact tmux session name) all matched byte-for-byte between a live
#     worker and its spawning top-level session. None of those can
#     discriminate — the spawner forks inheriting the parent's env, so every
#     ambient variable describes the PARENT, not the child. `.git` is not
#     ambient env: it is a property of the checkout git itself is looking
#     at, so it cannot be inherited by a fork. Git writes a FILE (a
#     `gitdir:` pointer) for a linked worktree and a real DIRECTORY for the
#     primary checkout — a fact verified live against a genuine worker
#     (linked worktree) and a genuine permanent fleet agent (primary
#     checkout), not assumed. THE ASSUMPTION THIS RESTS ON: a permanent
#     macf agent's registered workspace is always the primary clone —
#     `macf init` / `claude.sh` never operate against a linked worktree, and
#     there is no supported pattern anywhere in this repo for a permanent
#     agent to live in one. If that ever changes, this check breaks and
#     needs revisiting alongside whatever introduces the exception.
#     Honest-unknown floor: only a CONFIRMED linked-worktree marker (`.git`
#     is a file whose content matches `^gitdir: `) suppresses. `.git`
#     absent, a directory, unreadable, or any other shape falls through to
#     genuine-startup behavior UNCHANGED (inject) — noise (one avoidable
#     pickup in a worker this check fails to catch) is recoverable; silence
#     (suppressing pickup for a genuine permanent agent because this check
#     misfired) is not, so ambiguity here resolves to inject, not skip.
#
# Both checks fail the SAME way (`exit 0`, no stdout) but for a DIFFERENT
# reason than the error-handling `trap` above — two distinct axes:
#   - INTERNAL ERRORS (a read/parse fault, an unexpected trap) fail OPEN:
#     never block a session regardless of what breaks internally.
#   - TRIGGER AMBIGUITY (`source` absent/unrecognised, or a subagent-shaped
#     payload) fails CLOSED: silently skip rather than risk an unwanted
#     injection. A missing pickup prompt is recoverable (`/macf-issues`); a
#     spurious one costs context in every session and, for a subagent, is
#     an unauthenticatable instruction landing in a narrow-brief context.
#
# READINESS + VERIFY GATE (groundnuty/macf#802): a synchronous SessionStart
# submit can race a relaunch (`claude -c`) that hasn't yet cleared its own
# startup ceremony prompts (#703 — folder-trust / `--dangerously-load-
# development-channels`). Landing the pickup keystrokes on a menu that
# doesn't accept free text makes the send "succeed" (tmux send-keys exits 0)
# while the prompt is silently swallowed — the silent-fallback shape
# (silent-fallback-hazards.md). Two independent defenses, because the
# ordering of "prompt renders" vs "hook sends" is a hypothesis, not a
# verified fact — either could happen first.
#
# ALLOWLIST, NOT BLOCKLIST (macf#802 review, post-PR#845): the FIRST shipped
# version of the pre-send check (`_pane_blocked`) mirrored
# macf-prompt-watcher.sh's ceremony-menu heuristic — hold while the frame
# looks like a KNOWN blocking shape (`❯ N.` numbered menu / `(y/n)` confirm),
# else submit. Follow-up review found that heuristic is a likely PRODUCTION
# NO-OP for the exact prompt it exists to catch: byte-level inspection of the
# installed Claude Code binary (2.1.226) found no numbered-select renderer at
# all — every observed select/confirm option renders as `❯` immediately
# followed by a LABEL, never a digit (the folder-trust dialog is a labelled
# confirm component, not a `❯ 1.` menu). A blocklist's fail direction is
# CATASTROPHIC on a miss: an unrecognized dialog reads as "not blocked" and
# the hook submits INTO it, where the pickup text or its Enter could land on
# "No, exit". So the gate is INVERTED here: submit ONLY when the pane
# affirmatively shows Claude Code's own free-form INPUT LINE, never merely
# "doesn't look like a dialog I recognize". An allowlist miss (a ready-line
# shape this hook doesn't yet know) fails BENIGN — hold + phase-2 warn — the
# opposite of a blocklist miss. This trades a rare, silent, catastrophic
# failure for a benign, loud one, permanently, by construction.
#
# The ready-line signature (`_pane_ready`) was pinned against a LIVE
# `capture-pane -p -J` of real, running Claude Code sessions on this fleet
# (not a synthetic construction) — the standing input box renders as a
# `─`-drawn separator line, then a line starting with `❯` (blank when idle,
# free text when something is typed/queued — both observed live), then a
# closing `─` separator. This 3-line chrome was observed IDENTICALLY across
# an idle session, a busy/spinner session, and a session with queued text —
# stable across state. The KNOWN ceremony shapes this hook must NOT treat as
# ready (folder-trust / dev-channels) are reconstructed from the #802 static-
# binary-inspection evidence above, not a live capture of an actual dialog
# (triggering one live on a shared multi-agent host was judged too invasive
# to attempt) — carried as the best evidence available, not as proven; see
# the test file for the same caveat inline. Architecturally, this is a
# defensible negative even so: a modal ceremony prompt exists specifically to
# INTERRUPT free-text entry, so it is expected to replace the standing input
# chrome rather than coexist with it — if that assumption is ever wrong, the
# gate's fail direction (hold + warn) is still the benign one.
#
# TRICHOTOMY (macf#802 review) — the pane-observation outcome is 3-valued,
# not 2-valued, and conflating rows 2 and 3 below is itself a hazard the
# review flagged explicitly:
#   - ready line PRESENT               → submit now.
#   - ready line ABSENT, pane OBSERVED → hold (bounded by READY_TIMEOUT),
#                                         phase-2 warn on timeout.
#   - pane UNOBSERVABLE (no tmux reachable, capture fails, empty frame)
#                                       → fail OPEN, submit immediately —
#                                         identical to this hook's pre-#802
#                                         baseline. Holding here buys
#                                         nothing: the post-send verify below
#                                         reads the SAME pane and is equally
#                                         blind, so refusing to submit would
#                                         only convert "can't tell" into
#                                         "silently never picks up work" for
#                                         every non-tmux / observability-
#                                         degraded environment.
#
# Two independent checks, because the ordering of "prompt renders" vs "hook
# sends" is a hypothesis, not a verified fact — either could happen first:
#   (1) PRE-SEND: poll the pane (bounded by READY_TIMEOUT below) per the
#       trichotomy above.
#   (2) POST-SEND: a result-invariant check (Pattern C,
#       silent-fallback-hazards.md — content-diff via `capture-pane`, NOT
#       `#{session_activity}`, which does not reliably reflect activity).
#       Capture before + after the submit; if the pane content is unchanged,
#       OR it changed into a frame that is no longer ready (a dialog may have
#       interrupted right after send), the send is not treated as proven —
#       one bounded retry, then give up loud rather than silently.
# Either check alone would miss the ordering it doesn't cover; together they
# hold under both.
#
# LOG-FILE BACKSTOP (Follow-up B, macf#802 review — the same gap #778 already
# closed for macf-prompt-watcher.sh): a WARNING's only channel here is
# SessionStart STDOUT, which is read only if a fresh turn fires — and a
# genuinely swallowed submit is the very mechanism meant to fire that turn,
# so the report's own delivery is defeated by the bug it reports. Every
# WARNING below is ALSO appended to a `startup-pickup.log` file (same
# `MACF_LOG_PATH`-derived directory convention as macf-prompt-watcher.sh's
# `prompt-watcher.log`) so the failure is visible even when no turn ever
# reads the SessionStart context that carried it. Best-effort: a log-write
# failure is swallowed, never escalated (this hook still never blocks).
#
# Overrides:
#   MACF_NO_STARTUP_PICKUP=1                    — skip entirely, no query, no
#                                                  submit (family:
#                                                  MACF_NO_TMUX_WRAP /
#                                                  MACF_OTEL_DISABLED).
#   MACF_STARTUP_PICKUP_READY_TIMEOUT_SECS=N    — pre-send poll bound
#                                                  (default: same as
#                                                  macf-prompt-watcher.sh's
#                                                  MACF_PROMPT_WATCH_WINDOW_SECS
#                                                  if set, else 90 — the two
#                                                  mechanisms are racing the
#                                                  SAME startup window, so
#                                                  they share a default
#                                                  rather than drift apart).
#   MACF_STARTUP_PICKUP_READY_INTERVAL_SECS=N   — pre-send poll cadence
#                                                  (default 1).
#   MACF_STARTUP_PICKUP_VERIFY_DELAY_SECS=N     — settle time between a
#                                                  submit attempt and the
#                                                  post-send capture
#                                                  (default 1).
#
# Refs: groundnuty/macf#768 (this hook); groundnuty/macf#802 (the
#       readiness/verify gate); groundnuty/macf#930 (the trigger + subagent
#       gate below); #703 (the startup-prompt collision partner); DR-026
#       (auditor never-acts boundary); plugin/skills/macf-issues/SKILL.md
#       (the delegated command); tmux-send-to-claude.sh (the sanctioned
#       2-step-Enter submit helper); macf-prompt-watcher.sh (sibling pane
#       watcher whose heuristics the #802 gate mirrors, intentionally
#       duplicated rather than sourced — bash can't import bash across
#       distribution boundaries any more than it can import the TS role-gate
#       above).
set -uo pipefail

# Defense-in-depth: an unexpected error past this point must NOT brick
# session start. Same posture as check-auditor-never-acts.sh /
# check-channels-enabled.sh.
trap 'exit 0' ERR

# 1. Operator override first — cheapest exit, no stdin read, no query, no
#    submit.
if [[ "${MACF_NO_STARTUP_PICKUP:-}" == "1" ]]; then
  exit 0
fi

# 2. DR-026: the auditor never auto-resumes. This is a FULL no-op — the
#    hook behaves exactly as if it were absent for this role (not just the
#    submit step), which is the load-bearing gate that makes fleet-wide
#    distribution of this entry safe for every role including the auditor.
if [[ "${MACF_AGENT_ROLE:-}" == "auditor" ]]; then
  exit 0
fi

# 3. Trigger + subagent gate (groundnuty/macf#930) — see the file header
#    "TRIGGER + SUBAGENT GATE" section for the full rationale + citations.
#    Read now (not drained/ignored, pre-#930 behavior) because this is the
#    place that can actually be tested: the `matcher: "startup"` on this
#    hook's registration (settings-writer.ts / hooks.json) is
#    defense-in-depth, but Claude Code evaluates matchers before invoking
#    the command at all, so a matcher alone is unobservable/untestable from
#    inside the script — this script-side check is what a test actually
#    drives.
INPUT_JSON="$(cat 2>/dev/null || echo '')"
SESSION_SOURCE="$(printf '%s' "$INPUT_JSON" | sed -n 's/.*"source":"\([^"]*\)".*/\1/p' 2>/dev/null || true)"
# Fail CLOSED on anything but an exact "startup" match — absent, malformed,
# or any of resume/clear/compact/fork all take this exit. No override: this
# is a correctness gate (matching Claude Code's own definition of "a client
# actually started"), not an optional feature toggle.
[[ "$SESSION_SOURCE" == "startup" ]] || exit 0

# Best-effort subagent no-op — see the file header for why this does NOT
# fully cover the operator-witnessed incident. Checked AFTER the source
# gate (cheaper to fail on source first) but still before any GitHub call.
# `agent_id` ONLY — deliberately NOT `agent_type` too. Claude Code documents
# `agent_type` as present "when the session uses --agent OR the hook fires
# inside a subagent" (two conditions); `agent_id` is documented as present
# "ONLY when the hook fires inside a subagent" — the exact signal. Gating on
# `agent_type` as well would treat a legitimate `--agent`-launched TOP-LEVEL
# session as a subagent and silently drop its pickup prompt, which is a
# correctness regression the fix must not introduce (requirement #3: preserve
# genuine-startup behavior exactly). `claude.sh`'s `exec claude` never emits
# `--agent` today (verified: no such flag in claude-sh.ts's invocation), so
# this is currently latent, not reachable — but `agent_id` is the textually
# correct reading regardless of what any particular launcher does.
AGENT_ID="$(printf '%s' "$INPUT_JSON" | sed -n 's/.*"agent_id":"\([^"]*\)".*/\1/p' 2>/dev/null || true)"
[[ -z "$AGENT_ID" ]] || exit 0

WORKSPACE="${CLAUDE_PROJECT_DIR:-${PWD:-}}"
[[ -n "$WORKSPACE" ]] || exit 0

# 3.5. Linked-git-worktree no-op (groundnuty/macf#1042) — see the file
#      header "LINKED-WORKTREE check" section for the full rationale +
#      the assumption it rests on. Only a CONFIRMED `gitdir:` pointer file
#      suppresses; `.git` absent/a directory/unreadable/any other shape
#      falls through unchanged (honest-unknown floor: inject, not skip).
if [[ -f "$WORKSPACE/.git" ]] && grep -q '^gitdir: ' "$WORKSPACE/.git" 2>/dev/null; then
  exit 0
fi

# 4. Locate the mounted plugin's CLI. `.macf/plugin` is the canonical mount
#    point for BOTH macf-init'd consumer workspaces
#    (plugin-fetcher.ts `workspacePluginDir`) AND hand-wired substrate
#    workspaces (claude.sh's `--plugin-dir "$SCRIPT_DIR/.macf/plugin"`) —
#    verified against this repo's own claude.sh, not assumed.
PLUGIN_CLI="$WORKSPACE/.macf/plugin/dist/plugin/bin/macf-plugin-cli.js"
[[ -f "$PLUGIN_CLI" ]] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# 5. Delegate the query — see the file header for why this is `issues`, not
#    a hand-rolled `gh issue list`. Never treat a non-zero exit (a
#    transient GitHub API error, a token the refresh-aware client couldn't
#    recover) as fatal to the SESSION — just skip the pickup this start.
OUTPUT="$(node "$PLUGIN_CLI" issues 2>/dev/null)" || exit 0
[[ -n "$OUTPUT" ]] || exit 0

# Surface the plugin's own output as SessionStart context — the identical
# text `/macf-issues` would print.
printf '%s\n' "$OUTPUT"

# 6. Pending work? Match the plugin's own literal text
#    (plugin/lib/format.ts `formatIssues` / `formatStartupReconcile`) rather
#    than re-parsing its output — avoids a second source of truth for "what
#    counts as pending."
if ! grep -qE 'pending issue\(s\):|inbox message\(s\) drained on startup:' <<<"$OUTPUT"; then
  exit 0
fi

# 7. Auto-submit. tmux-send-to-claude.sh is the ONLY sanctioned way to
#    programmatically submit a prompt (2-step Enter quirk) — never inline
#    `tmux send-keys ... Enter`. Requires an actual tmux session (claude.sh's
#    canonical self-wrap); silently skip outside one — checked FIRST so we
#    don't pay for the `--oneline` round-trip below when we couldn't submit
#    anyway.
TMUX_SUBMIT="$WORKSPACE/.claude/scripts/tmux-send-to-claude.sh"
if [[ -z "${TMUX:-}" ]] || [[ ! -x "$TMUX_SUBMIT" ]]; then
  exit 0
fi

# 8. Readiness + verify gate (macf#802) — see the file header for the full
#    rationale. Tunables read here so an operator override applies to
#    whichever branch below actually fires.
READY_TIMEOUT="${MACF_STARTUP_PICKUP_READY_TIMEOUT_SECS:-${MACF_PROMPT_WATCH_WINDOW_SECS:-90}}"
READY_INTERVAL="${MACF_STARTUP_PICKUP_READY_INTERVAL_SECS:-1}"
VERIFY_DELAY="${MACF_STARTUP_PICKUP_VERIFY_DELAY_SECS:-1}"

# _pane_frame → best-effort capture of the target pane's current content.
# Prefers the precise $TMUX_PANE target (exported by claude.sh right before
# `exec claude` — the same target macf-prompt-watcher.sh watches); falls
# back to a bare capture (matches tmux-send-to-claude.sh's own "current
# pane" default target) when TMUX_PANE isn't known — proven present only via
# $TMUX (the send already fires today), never assume $TMUX_PANE is set too.
# `|| true` on both branches: a capture failure (no server, stale pane, no
# tmux binary) is read as "can't tell" everywhere this is called, never as
# an error — same fail-open posture as the rest of this script.
#
# `-J` (groundnuty/macf#778's fix, applied here too): without it, tmux
# renders a logical line that exceeds the pane's column width as MULTIPLE
# physical rows, so a regex that expects the input-box chrome on adjacent
# LOGICAL lines can see it split across adjacent PHYSICAL rows instead (or,
# for a long single line, miss a pattern that spans the wrap boundary). `-J`
# joins wrapped rows back into the logical line tmux tracked internally
# before wrapping, matching what `_pane_ready` below assumes.
_pane_frame() {
  if [[ -n "${TMUX_PANE:-}" ]]; then
    tmux capture-pane -t "$TMUX_PANE" -p -J 2>/dev/null || true
  else
    tmux capture-pane -p -J 2>/dev/null || true
  fi
}

# _pane_ready <frame> → 0 if the frame affirmatively shows Claude Code's own
# standing free-form input box: a `─`-drawn separator line, then a line
# starting with `❯` (blank when idle, free text when queued/typed — both
# forms observed live), then a closing `─` separator, within a short bounded
# lookahead (tolerates a multi-line input box, which was not itself observed
# live but is a real Claude Code feature via Shift+Enter). See the file
# header "ALLOWLIST, NOT BLOCKLIST" section for why this replaces a
# known-blocking-shape blocklist, and for the evidence tier behind the
# positive shape (a live capture) vs. the negative/ceremony shapes this is
# deliberately NOT keying on (reconstructed evidence, not a live capture).
#
# PANE_READY_SEP_MARK is a FIXED STRING (grep -F), never a `{n,}`-quantified
# regex over the multibyte `─` — verified empirically that a bash `[[ =~ ]]`
# interval quantifier applied directly to a multibyte UTF-8 character is
# LOCALE-DEPENDENT and silently fails to match under the C/POSIX locale
# (`env -i` with no LANG/LC_ALL — exactly the shape a hook's spawned process
# is not guaranteed to avoid). A literal substring match has no such
# dependency: confirmed matching identically under both a UTF-8 locale and a
# stripped `env -i` one. This is the SAME hazard class as any other
# locale-sensitive text match; the fix is "don't quantify a multibyte glyph
# in a regex", not "always export LANG" (which this script does not control).
PANE_READY_SEP_MARK="$(printf '─%.0s' $(seq 1 10))"
readonly PANE_READY_SEP_MARK
readonly PANE_READY_INPUT_RE='^[[:space:]]*❯'
_pane_ready() {
  local frame="$1" i j
  local -a lines
  mapfile -t lines <<<"$frame"
  local n=${#lines[@]}
  for ((i = 0; i < n; i++)); do
    printf '%s' "${lines[i]}" | grep -qF -- "$PANE_READY_SEP_MARK" || continue
    for ((j = i + 1; j < n && j <= i + 6; j++)); do
      if printf '%s' "${lines[j]}" | grep -qF -- "$PANE_READY_SEP_MARK"; then
        break # box closed without an input line in between — not this box
      fi
      if [[ "${lines[j]}" =~ $PANE_READY_INPUT_RE ]]; then
        return 0
      fi
    done
  done
  return 1
}

# _log_warn <message> — best-effort log-file backstop (Follow-up B, macf#802
# review). See the file header "LOG-FILE BACKSTOP" section: a WARNING's only
# other channel is SessionStart STDOUT, read only if a fresh turn fires — and
# a genuinely swallowed submit is the very mechanism meant to fire that turn.
# Mirrors macf-prompt-watcher.sh's `MACF_LOG_PATH`-derived log directory
# convention (same #778 lineage) so both scripts' forensic logs live
# alongside each other. Never escalates a write failure — this hook still
# never blocks the session on ANYTHING, including its own diagnostics.
#
# Every branch below guards its OWN variable with `:-` before falling
# through to the next — under this script's `set -uo pipefail`, a nested
# default expression that references a second possibly-unset variable
# WITHOUT its own `:-` guard (`${A:-$B}` with both unset) is itself an
# unbound-variable error, not a graceful fallback. Caught by this file's own
# test suite running with a deliberately minimal env (no HOME, no
# XDG_STATE_HOME) — the exact shape a stripped harness or container exposes
# that an operator's login shell never would.
_log_warn() {
  local log_dir log_file ts
  if [[ -n "${MACF_LOG_PATH:-}" ]]; then
    log_dir="$(dirname "$MACF_LOG_PATH")"
  elif [[ -n "${XDG_STATE_HOME:-}" ]]; then
    log_dir="$XDG_STATE_HOME/macf"
  elif [[ -n "${HOME:-}" ]]; then
    log_dir="$HOME/.local/state/macf"
  else
    return 0 # nowhere sane to log — best-effort, give up quietly
  fi
  log_file="$log_dir/startup-pickup.log"
  mkdir -p "$log_dir" 2>/dev/null || return 0
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '?')"
  printf '[macf-startup-pickup] %s [WARN] %s\n' "$ts" "$1" >>"$log_file" 2>/dev/null || true
}

# _warn <message> — print to stdout (SessionStart context, the pre-existing
# channel) AND the log-file backstop above, so the failure is visible even
# when no turn ever reads the context that carried it.
_warn() {
  printf '\n[macf-startup-pickup] WARNING: %s\n' "$1"
  _log_warn "$1"
}

# _submit_when_ready <prompt> — the gated submit, per the file header
# TRICHOTOMY: pre-send, hold while the pane is OBSERVED but not yet ready
# (bounded by READY_TIMEOUT); proceed immediately once ready OR once the
# pane is UNOBSERVABLE (fail open — see the file header for why holding
# there buys nothing). Post-send verifies the pane actually changed AND is
# still (or again) ready, with one bounded retry, because the ordering of
# "prompt renders" vs "hook sends" is unverified — the pre-send check alone
# cannot catch a dialog that renders AFTER it passed. Always returns 0
# (never treated as a script fault) but is LOUD — not silent — when a submit
# could not be verified.
_submit_when_ready() {
  local prompt="$1" before after attempt

  # Deliberately NOT `local SECONDS` — declaring bash's special
  # auto-incrementing SECONDS local strips its auto-increment behavior on
  # some bash versions, turning it into an ordinary variable that never
  # advances and silently converting this bounded poll into an infinite
  # loop gated only by the harness's own hook timeout. A bare assignment
  # resets the (script-global, single) counter; only this function reads
  # it, and only one call happens per hook invocation (step 8's if/elif is
  # mutually exclusive), so the global reset is safe here.
  SECONDS=0
  while :; do
    before="$(_pane_frame)"
    if [[ -z "$before" ]]; then
      # UNOBSERVABLE (trichotomy row 3) — fail open, same as this hook's
      # pre-#802 baseline. The post-send verify below reads the same pane
      # and is equally blind, so holding here would only convert "can't
      # tell" into "silently never picks up work" for this environment.
      break
    fi
    if _pane_ready "$before"; then
      break
    fi
    if [[ "$SECONDS" -ge "$READY_TIMEOUT" ]]; then
      _warn "pane still does not show a ready input line after ${READY_TIMEOUT}s — skipped the auto-submit to avoid it landing on a startup ceremony prompt (groundnuty/macf#802). Pending work is listed above; pick it up manually, or wait for the #703 auto-responder to clear the prompt and re-run /macf-issues."
      return 0
    fi
    sleep "$READY_INTERVAL"
  done

  for attempt in 1 2; do
    "$TMUX_SUBMIT" "" "$prompt" || true
    sleep "$VERIFY_DELAY"
    after="$(_pane_frame)"
    # A pane that is now NOT ready is never proof of success, even if its
    # content differs from $before — that shape is "a dialog interrupted
    # right after the send", not "the send landed on a clear input line".
    # Retry before treating a content-diff as proof; a diff into a
    # not-ready pane is exactly the false-positive a raw diff alone would
    # miss. An UNOBSERVABLE after-frame ($after empty) is handled below,
    # same as the pre-send trichotomy: treated as a pass, not a hold.
    if [[ -n "$after" ]] && ! _pane_ready "$after"; then
      before="$after"
      continue
    fi
    if [[ -z "$before" ]] || [[ -z "$after" ]] || [[ "$before" != "$after" ]]; then
      return 0
    fi
    before="$after"
  done
  _warn "could not confirm the auto-submit landed — the pane still looks unchanged, or is no longer showing a ready input line, after ${attempt} attempt(s) (groundnuty/macf#802). The prompt may have been interrupted by a dialog that rendered after the readiness check passed. Pending work is listed above; pick it up manually."
}

# 9. Build the DETAILED submit prompt (macf#816) — the operator wants the
#    pickup prompt to CARRY the pending-issue list, not point back at
#    context with a generic "review the queue above" line. `issues
#    --oneline` is a second short-lived plugin-CLI invocation (same query
#    source as step 4, `checkAllPendingWork`) that renders a compact
#    `repo#N: title; ...` line with no inbox/sweep prose — never re-parse
#    $OUTPUT for this (a second source of truth for issue formatting).
if ONELINE="$(node "$PLUGIN_CLI" issues --oneline 2>/dev/null)" && [[ -n "$ONELINE" ]]; then
  # `--oneline` succeeded AND named pending GH issues → submit the detailed
  # list. (The `&&` matters: a non-zero `--oneline` exit must NOT submit even
  # if partial stdout was captured — a failed issue query is not a queue.)
  _submit_when_ready "Pick up pending issues: ${ONELINE}"
elif grep -q 'inbox message(s) drained on startup:' <<<"$OUTPUT"; then
  # No open GH issues, but inbox messages were drained on startup (offline-
  # arrived peer work). The pre-#816 hook fired the self-nudge on the
  # inbox-drained case too; preserve that so a drained message can't strand
  # un-processed (the #802 / silent-fallback shape). No issue list to name,
  # so nudge at the drained messages surfaced in context above.
  _submit_when_ready "Process the inbox message(s) drained on startup (surfaced above)."
fi
# else: neither issues nor drained inbox (the grep at step 5 already exits
# otherwise) → nothing to submit.

exit 0
