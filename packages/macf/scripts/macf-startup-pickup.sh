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
# verified fact — either could happen first:
#   (1) PRE-SEND: poll the pane (bounded by READY_TIMEOUT below) and don't
#       even attempt a submit while it visibly shows a blocking ceremony
#       menu (numbered-option cursor / (y/n) confirm) — mirrors
#       macf-prompt-watcher.sh's `_looks_prompt_like`.
#   (2) POST-SEND: a result-invariant check (Pattern C,
#       silent-fallback-hazards.md — content-diff via `capture-pane`, NOT
#       `#{session_activity}`, which does not reliably reflect activity).
#       Capture before + after the submit; if the pane content is
#       unchanged, the send didn't visibly land — one bounded retry, then
#       give up loud rather than silently.
# Either check alone would miss the ordering it doesn't cover; together they
# hold under both. If the pane can't be observed at all (no tmux reachable,
# capture fails), both checks fail open — same fail-open posture as every
# other gate in this script — and the submit proceeds/records success
# without a diff to compare against.
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
_pane_frame() {
  if [[ -n "${TMUX_PANE:-}" ]]; then
    tmux capture-pane -t "$TMUX_PANE" -p 2>/dev/null || true
  else
    tmux capture-pane -p 2>/dev/null || true
  fi
}

# _pane_blocked <frame> → 0 if the frame looks like a blocking ceremony
# prompt (numbered-menu cursor or a (y/n) confirm) that would swallow a
# free-text submit instead of accepting it as input. Mirrors
# macf-prompt-watcher.sh's `_looks_prompt_like` (same two signatures);
# intentionally duplicated, not sourced — see the file header.
_pane_blocked() {
  printf '%s' "$1" | grep -qE '❯[[:space:]]*[0-9]+[.)]' && return 0
  printf '%s' "$1" | grep -qE '\((y/n|y/N|Y/n)\)|\[(y/N|Y/n|y/n)\]' && return 0
  return 1
}

# _submit_when_ready <prompt> — the gated submit. Phase 1 (pre-send) waits
# out a KNOWN-shaped blocking prompt, bounded by READY_TIMEOUT; phase 2
# (post-send) verifies the pane actually changed after sending, with one
# bounded retry, because the ordering of "prompt renders" vs "hook sends"
# is unverified — phase 1 alone cannot catch a prompt that renders AFTER
# the pre-send check passed. Always returns 0 (never treated as a script
# fault) but is LOUD — not silent — when a submit could not be verified.
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
    if [[ -z "$before" ]] || ! _pane_blocked "$before"; then
      break
    fi
    if [[ "$SECONDS" -ge "$READY_TIMEOUT" ]]; then
      printf '\n[macf-startup-pickup] WARNING: pane still showed a startup ceremony prompt after %ss — skipped the auto-submit to avoid it landing on the wrong menu (groundnuty/macf#802). Pending work is listed above; pick it up manually, or wait for the #703 auto-responder to clear the prompt and re-run /macf-issues.\n' "$READY_TIMEOUT"
      return 0
    fi
    sleep "$READY_INTERVAL"
  done

  for attempt in 1 2; do
    "$TMUX_SUBMIT" "" "$prompt" || true
    sleep "$VERIFY_DELAY"
    after="$(_pane_frame)"
    # A pane that now LOOKS blocked is never success, even if its content
    # differs from $before — that shape is "a new/different ceremony prompt
    # swallowed the send", not "the send landed". Retry before treating a
    # content-diff as proof; a diff into a still-blocked pane is exactly the
    # false-positive a raw diff alone would miss.
    if [[ -n "$after" ]] && _pane_blocked "$after"; then
      before="$after"
      continue
    fi
    if [[ -z "$before" ]] || [[ -z "$after" ]] || [[ "$before" != "$after" ]]; then
      return 0
    fi
    before="$after"
  done
  printf '\n[macf-startup-pickup] WARNING: could not confirm the auto-submit landed — the pane still looks unchanged, or now shows another blocking prompt, after %d attempt(s) (groundnuty/macf#802). The prompt may have been swallowed by a startup menu that rendered after the readiness check passed. Pending work is listed above; pick it up manually.\n' "$attempt"
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
