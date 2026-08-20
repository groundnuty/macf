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
# log files under ~/.cache/claude-cli-nodejs/<encoded-cwd>/mcp-logs-*macf-agent/
# <timestamp>.jsonl. The directory name is derived from the server's MOUNT and
# has already been renamed TWICE (groundnuty/macf#1004): a --plugin-dir mount
# named it `mcp-logs-plugin-macf-agent-macf-agent`; an even older plugin
# naming used `mcp-logs-plugin-macf-channel-server-macf-agent`; the current
# `.mcp.json server:macf-agent` mount (macf#1002 / DR-022 Amendment P) names
# it `mcp-logs-macf-agent`. A guard hardcoded to any ONE of these "runs,
# passes, and detects nothing" the moment the mount changes again — the exact
# hazard this guard exists to catch, recursing on itself. So this script globs
# every `mcp-logs-*macf-agent` directory under the workspace's cache dir
# (macf-agent is the mount's server name, `MCP_SERVER_NAME` in
# packages/macf/src/cli/mcp-json.ts) and searches the newest log across ALL of
# them for the marker TEXT below — the directory shape is treated as
# best-effort routing to a candidate file, never as the thing being asserted.
# Format verified against claude 2.1.195; a future Claude Code may still
# rename/relocate in a way this glob doesn't anticipate (e.g. dropping
# "macf-agent" from the name entirely) — in that case this guard now reports
# an explicit "could not verify" note instead of failing silently in a way
# indistinguishable from a clean pass (see the NO_CANDIDATE_LOG_DIRS branch
# below).
set -euo pipefail

# macf#701: how far back a `tmux_wake_delivered` line's `ts` may be and still
# count as evidence THIS session is receiving deliveries. Without a bound, a
# single delivery from a PREVIOUS session (the log is append-only across
# relaunches) satisfies the "not deaf" check forever — the exact stale-proxy
# shape macf#700 already fixed one layer up (native-push state itself).
# MACF_CHANNELS_RECENCY_WINDOW_SECS is an internal/test knob; default 30 min.
CHANNELS_RECENCY_WINDOW_SECS="${MACF_CHANNELS_RECENCY_WINDOW_SECS:-1800}"
case "$CHANNELS_RECENCY_WINDOW_SECS" in
  '' | *[!0-9]*) CHANNELS_RECENCY_WINDOW_SECS=1800 ;;
esac

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
CACHE_ROOT="$HOME_DIR/.cache/claude-cli-nodejs/$ENCODED"

# Glob every candidate MCP-log directory rather than trust one hardcoded name
# (macf#1004 — see the FRAGILITY NOTE above). No `nullglob`/`shopt` dependency:
# a non-matching glob expands to its own literal pattern string, and `[ -d ]`
# on that literal is simply false, so it's filtered out below same as any
# other non-directory. Portable to bash 3.2 (macOS system bash) without shopt.
CANDIDATE_LOG_DIRS=()
for cand in "$CACHE_ROOT"/mcp-logs-*macf-agent; do
  [ -d "$cand" ] || continue
  CANDIDATE_LOG_DIRS+=("$cand")
done

# No candidate directory at all (workspace never ran the macf-agent MCP
# server, the encoding drifted, a fresh machine, OR the mount was renamed
# again in a way this glob doesn't cover) -> this session's channel status
# could not be checked. Track it explicitly (NO_CANDIDATE_LOG_DIRS) instead of
# exiting silently here: silent-exit-0 is indistinguishable from "checked and
# found on" — precisely the regression this issue is about (macf#1004,
# assert-the-wrong-path.md). The poll loop below still runs (harmlessly
# no-ops when the array is empty) so `state` stays "unknown" and the reporting
# block after it can tell "never checked" apart from "checked, inconclusive".
NO_CANDIDATE_LOG_DIRS="no"
if [ "${#CANDIDATE_LOG_DIRS[@]}" -eq 0 ]; then
  NO_CANDIDATE_LOG_DIRS="yes"
fi

# iso_to_epoch ISO_TS — print ISO_TS (e.g. "2026-07-01T09:05:06.742Z") as Unix
# epoch seconds on stdout, or nothing + non-zero exit if parsing fails on this
# platform. GNU `date -d` parses the form directly (fractional seconds + `Z`
# both fine); BSD/macOS `date -j -f` needs the fractional-seconds + trailing
# `Z` stripped down to `%Y-%m-%dT%H:%M:%S` first. Never treated as fatal by
# callers — a parse failure just means "can't confirm recency," which routes
# to the pre-macf#701 presence-only behavior (never a NEW failure mode).
iso_to_epoch() {
  local iso="$1"
  if date --version >/dev/null 2>&1; then
    # GNU coreutils date.
    date -d "$iso" +%s 2>/dev/null
  else
    # BSD/macOS date. Strip fractional seconds + the trailing Z so -f's
    # format string lines up with a plain "%Y-%m-%dT%H:%M:%S" (UTC via -u).
    local stripped
    stripped="$(printf '%s' "$iso" | sed -E 's/\.[0-9]+Z?$/Z/; s/Z$//' 2>/dev/null)"
    [ -n "$stripped" ] || return 1
    date -j -u -f "%Y-%m-%dT%H:%M:%S" "$stripped" +%s 2>/dev/null
  fi
}

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
if [ "${#CANDIDATE_LOG_DIRS[@]}" -gt 0 ]; then
  for ((i = 0; i < poll_iters; i++)); do
    # Re-evaluate the newest log each iteration, across ALL candidate
    # directories — this session's log file is created near MCP-connect time
    # under whichever mount is actually active, so the freshest-by-mtime
    # jsonl GLOBALLY is the one to read regardless of which directory shape
    # produced it. `[ -e ]` guards the no-match-literal-glob case (no
    # nullglob dependency, see above); `-nt` is bash's builtin mtime compare.
    newest=""
    for d in "${CANDIDATE_LOG_DIRS[@]}"; do
      for f in "$d"/*.jsonl; do
        [ -e "$f" ] || continue
        if [ -z "$newest" ] || [ "$f" -nt "$newest" ]; then
          newest="$f"
        fi
      done
    done
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
fi

# on, and unknown-because-the-poll-timed-out-with-a-log-present → stay silent
# (native channel-push is fine, or a transient still-connecting window that
# will very likely resolve on the next session; not worth a warning every
# time). unknown-because-NO-candidate-log-directory-was-found is different —
# that is the "never actually checked" state (macf#1004) and gets its own
# explicit, non-alarming note in the final `elif` below, distinguishable from
# both a clean pass (silent) and a confirmed-off warning (loud). Only the
# CONFIRMED-off case among these three says anything alarming — and WHAT it
# says depends on whether the tmux-wake FALLBACK is delivering, because
# "native-push off" is NOT "deaf to routing": tmux-wake (send-keys) is the
# load-bearing last-hop and is DELIVERING routed notifications on every current
# agent (macf#641/DR-022-Amendment-P: native channels are a pending UPGRADE, not
# yet applied — the .mcp.json mount the dev-flag needs isn't in place, so
# native-push is off fleet-wide, while tmux-wake carries delivery).
#
# The original macf#633 warning asserted the WRONG invariant — "is native-push
# on?" — and cried total deafness whenever it was off, a FALSE ALARM while
# tmux-wake delivers. This asserts the TRUE result-invariant (Pattern A):
# "is SOME delivery path working?" by reading the channel-server's own log for
# recent `tmux_wake_delivered` events. Only genuine total deafness (native off
# AND no tmux-wake delivery evidence) gets the loud warning.
if [ "$state" = "off" ]; then
  # Locate THIS agent's own channel-server log — never a peer's (macf#887).
  #
  # Preference order:
  #   1. MACF_LOG_PATH (set by claude.sh / env.certs) — the full, authoritative
  #      path, when it actually points at a readable file.
  #   2. Reconstruct the canonical default from THIS agent's own identity —
  #      MACF_PROJECT + MACF_AGENT_NAME, exported by env.identity — using the
  #      SAME derivation claude.sh / env-files.ts bake into MACF_LOG_PATH
  #      (packages/macf/src/cli/{claude-sh,env-files}.ts):
  #        ${XDG_STATE_HOME:-$HOME/.local/state}/macf/<project>@<agent>/channel.log
  #      This is scoped to THIS agent's own identity, never a scan of the host.
  #   3. Neither resolves → CHANNEL_LOG stays empty and
  #      CHANNEL_LOG_IDENTITY_UNKNOWN is set. Previously this branch fell back
  #      to `ls -t ~/.local/state/macf/*/channel.log | head -n1` — the NEWEST
  #      log on the WHOLE HOST. On a multi-agent box that's whichever PEER
  #      wrote most recently, not this agent — a quiet agent loses that race
  #      every time, and the guard would confidently report on delivery health
  #      that isn't its own (silent-fallback-hazards.md Instance 15, false
  #      green/false alarm both directions). Per DR-043 Amendment A's honest-
  #      unknown-over-false-present floor: report unknown, never guess.
  CHANNEL_LOG=""
  CHANNEL_LOG_IDENTITY_UNKNOWN=""
  if [ -n "${MACF_LOG_PATH:-}" ] && [ -r "${MACF_LOG_PATH}" ]; then
    CHANNEL_LOG="${MACF_LOG_PATH}"
  elif [ -n "${MACF_PROJECT:-}" ] && [ -n "${MACF_AGENT_NAME:-}" ]; then
    OWN_LOG="${XDG_STATE_HOME:-$HOME_DIR/.local/state}/macf/${MACF_PROJECT}@${MACF_AGENT_NAME}/channel.log"
    [ -r "$OWN_LOG" ] && CHANNEL_LOG="$OWN_LOG"
  else
    CHANNEL_LOG_IDENTITY_UNKNOWN=1
  fi

  # Evidence the tmux-wake fallback is delivering to THIS agent: a RECENT
  # `tmux_wake_delivered` event in its channel log. A functioning tmux-wake
  # agent accrues these; a recent one means routed notifications DO reach the
  # TUI (the agent is NOT deaf), even with native-push off.
  #
  # macf#701: bound "recent" — the log is append-only across relaunches, so a
  # bare presence check (any tmux_wake_delivered in the tail, ever) lets a hit
  # from a PREVIOUS session satisfy THIS session's check forever, even if
  # tmux-wake broke moments after this session started. Read each candidate
  # line's `ts` and require it within CHANNELS_RECENCY_WINDOW_SECS of now.
  #
  # Fail-open contract: if `now` or EVERY candidate line's `ts` fails to
  # parse on this platform, fall back to the pre-#701 presence-only check —
  # recency is a best-effort NARROWING of "yes", never a new way to produce a
  # false "no" (that would trade a stale-positive hazard for a false-alarm one).
  tmux_wake_alive="no"
  if [ -n "$CHANNEL_LOG" ] && [ -r "$CHANNEL_LOG" ]; then
    # Bound the scan to the tail (logs grow large); grep is quiet on no-match.
    candidates="$(tail -n 2000 "$CHANNEL_LOG" 2>/dev/null | grep 'tmux_wake_delivered' || true)"
    if [ -n "$candidates" ]; then
      now_epoch="$(date +%s 2>/dev/null || true)"
      if [ -z "$now_epoch" ]; then
        # Can't even get "now" — recency is unassertable on this platform;
        # fall back to presence-only (never a new failure mode).
        tmux_wake_alive="yes"
      else
        recency_confirmed="no"
        parse_ok_any="no"
        while IFS= read -r line; do
          [ -n "$line" ] || continue
          # Extract the `ts` field's value without a JSON parser dependency:
          # match `"ts":"..."` and capture the quoted ISO string.
          ts="$(printf '%s' "$line" | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')"
          [ -n "$ts" ] || continue
          epoch="$(iso_to_epoch "$ts" || true)"
          [ -n "$epoch" ] || continue
          parse_ok_any="yes"
          age=$((now_epoch - epoch))
          if [ "$age" -ge 0 ] && [ "$age" -le "$CHANNELS_RECENCY_WINDOW_SECS" ]; then
            recency_confirmed="yes"
            break
          fi
        done <<EOF
$candidates
EOF
        if [ "$recency_confirmed" = "yes" ]; then
          tmux_wake_alive="yes"
        elif [ "$parse_ok_any" = "no" ]; then
          # Every candidate's `ts` failed to parse (or had no `ts` at all) —
          # can't assert recency on this platform/shape; fall back to the
          # pre-#701 presence-only behavior rather than invent a new "no".
          tmux_wake_alive="yes"
        fi
      fi
    fi
  fi

  if [ "$tmux_wake_alive" = "yes" ]; then
    # The current, expected fleet state: native-push off, tmux-wake delivering.
    # Accurate + non-alarming — NOT "you are deaf".
    cat <<'INFO'
ℹ️  Native Claude Code channel-push is OFF this session, but tmux-wake IS
delivering routed notifications (recent `tmux_wake_delivered` in the
channel-server log) — you are NOT deaf to routing. Routed issues, PRs, reviews,
and @mentions still reach you via the tmux-wake last-hop.

Native channel-push is the pending macf#641 / DR-022-Amendment-P upgrade (the
channel-server must be mounted as a `.mcp.json server:macf-agent` for the
`--dangerously-load-development-channels` flag to resolve; it is currently
`--plugin-dir`-mounted, so the flag matches nothing). Expected until that
migration lands — no action needed. Good hygiene regardless: assert GitHub
state on hand-offs (coordination.md §Communication 5). Silence: MACF_SKIP_CHANNELS_CHECK=1.
INFO
  else
    # Genuine concern: native-push off AND no evidence tmux-wake is delivering.
    # macf#887: when that "no evidence" is because this agent's OWN log
    # couldn't even be identified (as opposed to identified-but-empty), say so
    # explicitly — an honest unknown, not a confident read of someone else's
    # log. printf (not the quoted heredoc below) so this line can interpolate.
    if [ -n "$CHANNEL_LOG_IDENTITY_UNKNOWN" ]; then
      printf "ℹ️  Also: could not identify this agent's own channel-server log — MACF_LOG_PATH is unset/unreadable, and MACF_PROJECT/MACF_AGENT_NAME (used to derive the default path) are unavailable — so the tmux-wake evidence check above could not even be attempted. This never falls back to a peer's log on a shared host (groundnuty/macf#887); set MACF_LOG_PATH, or relaunch via ./claude.sh, to restore it.\n\n"
    fi
    cat <<'WARN'
⚠️  ROUTED-NOTIFICATION DELIVERY IS UNCONFIRMED this session (macf#632/#633).

The macf-agent MCP server logged "Channel notifications skipped: ... not in
--channels list" (native channel-push is OFF — the pending macf#641 upgrade),
AND no recent `tmux_wake_delivered` was found in the channel-server log — so the
tmux-wake FALLBACK delivery could not be confirmed either. You may not be woken
for routed issues, PRs, reviews, or @mentions.

Do NOT trust "no pings = nothing to do" / "I'm idle". Assert GitHub state
directly (gh issue/pr list, review-sweep, gate-sweep) instead of waiting for a
ping (coordination.md §Communication 5).
To fix: relaunch via ./claude.sh on Claude Code >= 2.1.80. If it persists,
check `claude --version`, that claude.sh emits MACF_CHANNELS_ARGS, and that the
channel-server is running (its log should show `tmux_wake_delivered` on
delivery). Silence: MACF_SKIP_CHANNELS_CHECK=1.
WARN
  fi
elif [ "$state" = "unknown" ] && [ "$NO_CANDIDATE_LOG_DIRS" = "yes" ]; then
  # "Never actually checked" — distinguishable from BOTH a clean pass (fully
  # silent, state=on) and a confirmed-off warning (loud, state=off). Without
  # this branch, "no candidate directory matched" and "checked, found clean"
  # are the same observable outcome (silent, exit 0) — exactly the regression
  # macf#1004 is about: a guard pointed at a stale/wrong directory name runs,
  # passes, and detects nothing, forever, with no way to tell it apart from a
  # genuinely healthy session. Non-alarming tone: this is routinely true for a
  # few seconds after a fresh launch before the MCP server's log dir exists.
  cat <<INFO
ℹ️  Could not verify routed-notification channel status this session — no
Claude Code MCP log directory matching \`mcp-logs-*macf-agent\` was found under
$CACHE_ROOT/. This means "not yet checked", not "checked and found clean" —
those two look identical unless this note says which one happened.

Usually harmless: this directory is created once the macf-agent MCP server
first connects, so it can be legitimately absent for the first few seconds of
a fresh launch — no action needed if this doesn't recur. If it persists across
relaunches, Claude Code's MCP-log directory naming may have shifted again the
way it already has twice (groundnuty/macf#1002, groundnuty/macf#1004): this
guard globs any directory ending in \`macf-agent\` rather than one fixed path,
but a rename that drops "macf-agent" from the name entirely would still slip
past it — \`ls $CACHE_ROOT/\` to see what's actually there and re-point the glob.
Silence: MACF_SKIP_CHANNELS_CHECK=1.
INFO
fi

exit 0
