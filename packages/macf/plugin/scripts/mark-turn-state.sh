#!/usr/bin/env bash
#
# mark-turn-state.sh — maintains the local turn-state marker file the channel
# server reads to report accurate live agent state through long tool waits
# (groundnuty/macf#568, DR-030 fleet-doctor phase-1 increment A).
#
# Invoked by the MACF plugin hooks (hooks/hooks.json) with ONE argument naming
# the lifecycle event:
#
#   user-prompt-submit  → a new turn begins (turn_number++, status=busy,
#                         tool_use_count reset to 0)
#   pre-tool-use        → entered a tool (phase=tool, current_tool/command,
#                         tool_use_count++)
#   post-tool-use       → tool finished (phase=thinking, tool fields cleared)
#   post-tool-use-failure (alias of post-tool-use)
#   stop                → turn ended (status=idle, ended_at, last_turn_duration_ms;
#                         tool_use_count keeps the turn's accumulated total)
#   stop-failure        → turn errored (status=idle, clear busy, rest as-is)
#   session-end         (alias of stop-failure)
#
# The marker is a single JSON object at:
#   ${MACF_WORKSPACE_DIR}/.macf/turn-state.json
# It is maintained by read-modify-write: read the prior marker, apply the
# event's field updates, write atomically (mktemp + mv) so a concurrent reader
# (the channel server's /health.state handler, increment B) never observes a
# half-written file. `turn_number` persists + increments across the session.
#
# Each event reads the Claude Code hook stdin JSON for the fields it needs
# (`.tool_name`, `.tool_input.command` on PreToolUse). All epoch times are
# milliseconds.
#
# `tool_use_count` (groundnuty/macf#612) is a LIVE per-turn counter the script
# DERIVES itself — reset to 0 on user-prompt-submit, +1 on each pre-tool-use —
# NOT read from the hook payload, because no Claude Code hook event carries a
# tool-use count as a stdin field. This makes the count visible mid-turn (the
# channel server's /health.state was reporting it null because the old writer
# only set it on Stop, from a `.tool_use_count` field the Stop payload never has).
#
# `output_tokens` is NULL-BY-DESIGN: no Claude Code hook event exposes per-turn
# token usage as a direct stdin field — it lives only inside the transcript JSONL,
# which this never-block hook deliberately does NOT parse (cost + fragility). The
# field is kept in the marker shape (the channel server reads it) but always
# written null. The DR-006 watchdog keys on status/elapsed_ms/phase regardless.
#
# ROBUSTNESS CONTRACT: this hook NEVER blocks a turn. Every path exits 0 —
# missing jq, missing workspace dir, malformed stdin, a broken prior marker, a
# failed write: all degrade to a clean `exit 0`. `.macf/` is created if absent.
#
# Override: MACF_SKIP_TURN_STATE=1 bypasses (MACF_SKIP_* hook-family convention).
set -uo pipefail

# Final safety net: any genuinely unexpected fault must NOT brick a turn. Fail
# open (exit 0), same posture as harvest-reflection.sh / check-gh-attribution.sh.
trap 'exit 0' ERR

# Cheap operator override — before any read/parse.
if [[ "${MACF_SKIP_TURN_STATE:-}" == "1" ]]; then
  exit 0
fi

# jq is required for the JSON read-modify-write; absent → degrade silently.
command -v jq >/dev/null 2>&1 || exit 0

# ── Normalize the event argument to one of the 5 canonical event keys ─────────
EVENT="${1:-}"
case "$EVENT" in
  post-tool-use-failure) EVENT="post-tool-use" ;;
  session-end)           EVENT="stop-failure" ;;
esac
case "$EVENT" in
  user-prompt-submit|pre-tool-use|post-tool-use|stop|stop-failure) ;;
  *) exit 0 ;; # unknown event → no-op
esac

# ── Resolve the marker path (graceful when MACF_WORKSPACE_DIR is unset) ────────
WS="${MACF_WORKSPACE_DIR:-${CLAUDE_PROJECT_DIR:-.}}"
[[ -z "$WS" ]] && WS="."
DIR="$WS/.macf"
MARKER="$DIR/turn-state.json"
mkdir -p "$DIR" 2>/dev/null || exit 0

# ── Current epoch milliseconds (GNU `date +%s%3N`; BSD/mac fallback) ──────────
now_ms() {
  local n
  n="$(date +%s%3N 2>/dev/null || true)"
  case "$n" in
    ''|*[!0-9]*) n="$(( $(date +%s 2>/dev/null || echo 0) * 1000 ))" ;;
  esac
  printf '%s' "$n"
}
NOW="$(now_ms)"

# ── Read the Claude Code hook payload from stdin (all defensive) ──────────────
INPUT="$(cat 2>/dev/null || echo '')"

# Fields needed by specific events; defaulted so absence never aborts.
TOOL_NAME="$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null || true)"

CURRENT_COMMAND=""
if [[ "$TOOL_NAME" == "Bash" ]]; then
  CURRENT_COMMAND="$(jq -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null || true)"
  # Truncate to <=120 chars so a long command can't bloat the marker.
  CURRENT_COMMAND="${CURRENT_COMMAND:0:120}"
fi

# NOTE: tool_use_count is NOT read from stdin — it is derived (reset on
# user-prompt-submit, +1 per pre-tool-use; see header). output_tokens is
# null-by-design (no hook event exposes it as a stdin field).

# ── Load the prior marker (or {} if absent/broken) ────────────────────────────
EXISTING='{}'
if [[ -f "$MARKER" ]]; then
  if _e="$(jq -c '.' "$MARKER" 2>/dev/null)" && [[ -n "$_e" ]]; then
    EXISTING="$_e"
  fi
fi

# ── Build the new marker: base ⊕ prior ⊕ event-specific updates ───────────────
NEW="$(
  jq -cn \
    --argjson existing "$EXISTING" \
    --arg event "$EVENT" \
    --argjson now "$NOW" \
    --arg tool_name "$TOOL_NAME" \
    --arg current_command "$CURRENT_COMMAND" \
    '
    def base:
      { turn_number: 0, status: "idle", started_at: null, ended_at: null,
        phase: null, current_tool: null, current_command: null,
        tool_started_at: null, last_turn_duration_ms: null,
        tool_use_count: null, output_tokens: null };
    (base + $existing) as $s
    | if $event == "user-prompt-submit" then
        $s + { turn_number: (($s.turn_number // 0) + 1), status: "busy",
               started_at: $now, ended_at: null, phase: "thinking",
               current_tool: null, current_command: null, tool_started_at: null,
               tool_use_count: 0, output_tokens: null }
      elif $event == "pre-tool-use" then
        $s + { phase: "tool",
               current_tool: ($tool_name | if . == "" then null else . end),
               current_command: ($current_command | if . == "" then null else . end),
               tool_started_at: $now,
               tool_use_count: (($s.tool_use_count // 0) + 1) }
      elif $event == "post-tool-use" then
        $s + { phase: "thinking", current_tool: null, current_command: null,
               tool_started_at: null }
      elif $event == "stop" then
        $s + { status: "idle", ended_at: $now,
               last_turn_duration_ms:
                 (if $s.started_at != null then ($now - $s.started_at) else null end),
               phase: null, current_tool: null }
      elif $event == "stop-failure" then
        $s + { status: "idle", ended_at: $now, phase: null, current_tool: null }
      else $s end
    ' 2>/dev/null || echo ""
)"

# If the jq build failed for any reason, bail cleanly — never block the turn.
[[ -z "$NEW" ]] && exit 0

# ── Atomic write: temp file in the SAME dir + mv (so a reader never sees a
# half-written marker). Any failure → clean exit 0. ───────────────────────────
TMP="$(mktemp "${DIR}/.turn-state.XXXXXX" 2>/dev/null)" || exit 0
if ! printf '%s\n' "$NEW" >"$TMP" 2>/dev/null; then
  rm -f "$TMP" 2>/dev/null || true
  exit 0
fi
mv -f "$TMP" "$MARKER" 2>/dev/null || { rm -f "$TMP" 2>/dev/null || true; exit 0; }

exit 0
