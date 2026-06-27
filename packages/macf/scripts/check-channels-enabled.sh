#!/usr/bin/env bash
#
# check-channels-enabled.sh — Claude Code SessionStart hook (macf#633) that
# asserts MCP "channel notifications" are actually ON for this session, and
# warns LOUDLY into the agent's context when they are OFF.
#
# WHY (the silent-fallback this catches): Claude Code v2.1.80+ gates the
# channel-notification push behind a launch flag (macf#632 makes claude.sh pass
# `--dangerously-load-development-channels server:macf-agent`). When the flag is
# missing / wrong / opted-out, or the binary is too old, the macf-agent MCP
# server logs "Channel notifications skipped: ... not in --channels list for
# this session" and EVERY routed issue/PR/mention is silently dropped — the
# agent has no signal that it is deaf to routing. macf#632 ENABLES channels;
# this guard is the result-invariant (Pattern A, silent-fallback-hazards.md):
# it reads the server's own startup log back and asserts the enablement
# actually took, catching the residual cases (wrong value, old claude, opt-out,
# a bare `claude` launch that bypassed claude.sh).
#
# Hook contract (SessionStart): JSON on stdin; STDOUT is injected into the
# agent's context (that is how the warning reaches the agent). This hook is
# OBSERVATIONAL + NON-BLOCKING: it ALWAYS exits 0 — a missing/unreadable log,
# a poll timeout, or any internal error fails open (never delays or blocks a
# session). Override with MACF_SKIP_CHANNELS_CHECK=1.
#
# FRAGILITY NOTE: this parses Claude Code's INTERNAL, UNDOCUMENTED MCP-server
# log files under ~/.cache/claude-cli-nodejs/<encoded-cwd>/mcp-logs-plugin-
# macf-agent-macf-agent/<timestamp>.jsonl. The format + path were verified
# against claude 2.1.195; a future Claude Code may rename/relocate them, in
# which case this guard fails open (no false alarms) and should be re-pointed.
set -euo pipefail

# Operator override first — cheapest exit, no stdin read needed.
if [ "${MACF_SKIP_CHANNELS_CHECK:-}" = "1" ]; then
  exit 0
fi

# Drain + ignore the SessionStart payload. We don't need any field from it; the
# workspace path comes from $CLAUDE_PROJECT_DIR / $PWD. Never block on stdin.
cat >/dev/null 2>&1 || true

# Resolve the workspace directory Claude Code was launched in. claude.sh `cd`s
# to $SCRIPT_DIR before exec, so $CLAUDE_PROJECT_DIR (set by Claude Code for the
# hook) and $PWD both point at the workspace. Fail open if neither is set.
WORKSPACE="${CLAUDE_PROJECT_DIR:-${PWD:-}}"
[ -n "$WORKSPACE" ] || exit 0

HOME_DIR="${HOME:-}"
[ -n "$HOME_DIR" ] || exit 0

# Claude Code encodes the launch cwd into its cache dir name by replacing every
# `/` and `.` with `-` (e.g. /home/u/repos/macf -> -home-u-repos-macf). Verify
# with: ls ~/.cache/claude-cli-nodejs/. We derive the same encoding here.
ENCODED="$(printf '%s' "$WORKSPACE" | sed 's#[/.]#-#g')"
LOG_DIR="$HOME_DIR/.cache/claude-cli-nodejs/$ENCODED/mcp-logs-plugin-macf-agent-macf-agent"

# No log dir (workspace never ran the macf-agent MCP server, encoding drifted,
# or a fresh machine) -> nothing to assert. Fail open.
[ -d "$LOG_DIR" ] || exit 0

# Markers emitted by the macf-agent MCP server at startup (verified vs 2.1.195):
#   OFF: "Channel notifications skipped: server plugin:macf-agent:macf-agent
#        not in --channels list for this session"
#   ON : "Successfully connected (transport: stdio) in <N>ms"
SKIP_MARKER='Channel notifications skipped'
OK_MARKER='Successfully connected'

# Bounded poll (~12 x 1s). The MCP server connects ~3-5s after session start,
# so the newest log may be empty when the hook first fires; poll until a marker
# appears, then break. An inconclusive poll times out + fails open (exit 0).
# MACF_CHANNELS_POLL_ITERS is an internal/test knob (default 12); a non-numeric
# value falls back to 12 so a bad env can't break the loop.
poll_iters="${MACF_CHANNELS_POLL_ITERS:-12}"
case "$poll_iters" in
  '' | *[!0-9]*) poll_iters=12 ;;
esac
state="unknown"
for ((i = 0; i < poll_iters; i++)); do
  # Re-evaluate the newest log each iteration — this session's log file is
  # created near MCP-connect time, so the freshest-by-mtime jsonl is the one to
  # read. `|| true` + the `-r` guard keep the no-match / unreadable cases quiet.
  newest="$(ls -t "$LOG_DIR"/*.jsonl 2>/dev/null | head -n1 || true)"
  if [ -n "$newest" ] && [ -r "$newest" ]; then
    if grep -q "$SKIP_MARKER" "$newest" 2>/dev/null; then
      state="off"
      break
    elif grep -q "$OK_MARKER" "$newest" 2>/dev/null; then
      state="on"
      break
    fi
  fi
  sleep 1
done

# Only the CONFIRMED-off case warns. on / unknown / inconclusive stay silent.
if [ "$state" = "off" ]; then
  cat <<'WARN'
⚠️  ROUTED NOTIFICATIONS ARE DISABLED this session (macf#632/#633).

The macf-agent MCP server logged "Channel notifications skipped: ... not in
--channels list for this session". Routed issues, PRs, reviews, and @mentions
will be SILENTLY DROPPED — you will NOT be woken for them.

Do NOT trust "no pings = nothing to do" / "I'm idle". You are deaf to routing
this session. Until relaunched with channels enabled:
  - Assert GitHub state directly (gh issue/pr list, review-sweep, gate-sweep)
    instead of waiting for a ping (coordination.md §Communication 5).
To fix: relaunch via ./claude.sh on Claude Code >= 2.1.80 (it passes the
channels flag). If it persists, check `claude --version` and that claude.sh
emits MACF_CHANNELS_ARGS, or set MACF_SKIP_CHANNELS_CHECK=1 to silence this.
WARN
fi

exit 0
