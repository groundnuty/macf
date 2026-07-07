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
# Hook contract (SessionStart): JSON on stdin (ignored — the workspace path
# comes from $CLAUDE_PROJECT_DIR); STDOUT is injected into the agent's
# context. OBSERVATIONAL for the query half (deposits the plugin's own
# `issues`-command output into the agent's context, identical to what
# `/macf-issues` would print) and NON-BLOCKING throughout — the script
# ALWAYS exits 0 (fail open on a missing plugin mount, a query error, a
# missing tmux session, or any internal fault) so it can never delay or
# block a session.
#
# Overrides:
#   MACF_NO_STARTUP_PICKUP=1   — skip entirely, no query, no submit (family:
#                                MACF_NO_TMUX_WRAP / MACF_OTEL_DISABLED).
#
# Refs: groundnuty/macf#768; DR-026 (auditor never-acts boundary);
#       plugin/skills/macf-issues/SKILL.md (the delegated command);
#       tmux-send-to-claude.sh (the sanctioned 2-step-Enter submit helper).
set -uo pipefail

# Defense-in-depth: an unexpected error past this point must NOT brick
# session start. Same posture as check-auditor-never-acts.sh /
# check-channels-enabled.sh.
trap 'exit 0' ERR

# Drain + ignore the SessionStart payload — no field is needed; the
# workspace path comes from $CLAUDE_PROJECT_DIR / $PWD.
cat >/dev/null 2>&1 || true

# 1. Operator override first — cheapest exit, no query, no submit.
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

WORKSPACE="${CLAUDE_PROJECT_DIR:-${PWD:-}}"
[[ -n "$WORKSPACE" ]] || exit 0

# 3. Locate the mounted plugin's CLI. `.macf/plugin` is the canonical mount
#    point for BOTH macf-init'd consumer workspaces
#    (plugin-fetcher.ts `workspacePluginDir`) AND hand-wired substrate
#    workspaces (claude.sh's `--plugin-dir "$SCRIPT_DIR/.macf/plugin"`) —
#    verified against this repo's own claude.sh, not assumed.
PLUGIN_CLI="$WORKSPACE/.macf/plugin/dist/plugin/bin/macf-plugin-cli.js"
[[ -f "$PLUGIN_CLI" ]] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# 4. Delegate the query — see the file header for why this is `issues`, not
#    a hand-rolled `gh issue list`. Never treat a non-zero exit (a
#    transient GitHub API error, a token the refresh-aware client couldn't
#    recover) as fatal to the SESSION — just skip the pickup this start.
OUTPUT="$(node "$PLUGIN_CLI" issues 2>/dev/null)" || exit 0
[[ -n "$OUTPUT" ]] || exit 0

# Surface the plugin's own output as SessionStart context — the identical
# text `/macf-issues` would print.
printf '%s\n' "$OUTPUT"

# 5. Pending work? Match the plugin's own literal text
#    (plugin/lib/format.ts `formatIssues` / `formatStartupReconcile`) rather
#    than re-parsing its output — avoids a second source of truth for "what
#    counts as pending."
if ! grep -qE 'pending issue\(s\):|inbox message\(s\) drained on startup:' <<<"$OUTPUT"; then
  exit 0
fi

# 6. Auto-submit. tmux-send-to-claude.sh is the ONLY sanctioned way to
#    programmatically submit a prompt (2-step Enter quirk) — never inline
#    `tmux send-keys ... Enter`. Requires an actual tmux session (claude.sh's
#    canonical self-wrap); silently skip outside one — checked FIRST so we
#    don't pay for the `--oneline` round-trip below when we couldn't submit
#    anyway.
TMUX_SUBMIT="$WORKSPACE/.claude/scripts/tmux-send-to-claude.sh"
if [[ -z "${TMUX:-}" ]] || [[ ! -x "$TMUX_SUBMIT" ]]; then
  exit 0
fi

# 7. Build the DETAILED submit prompt (macf#816) — the operator wants the
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
  "$TMUX_SUBMIT" "" "Pick up pending issues: ${ONELINE}" || true
elif grep -q 'inbox message(s) drained on startup:' <<<"$OUTPUT"; then
  # No open GH issues, but inbox messages were drained on startup (offline-
  # arrived peer work). The pre-#816 hook fired the self-nudge on the
  # inbox-drained case too; preserve that so a drained message can't strand
  # un-processed (the #802 / silent-fallback shape). No issue list to name,
  # so nudge at the drained messages surfaced in context above.
  "$TMUX_SUBMIT" "" "Process the inbox message(s) drained on startup (surfaced above)." || true
fi
# else: neither issues nor drained inbox (the grep at step 5 already exits
# otherwise) → nothing to submit.

exit 0
