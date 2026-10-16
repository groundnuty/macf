#!/usr/bin/env bash
# Send a prompt to a Claude Code TUI running in a tmux session, and verify
# that it was actually submitted.
#
# Mechanism (measured on a real Claude Code 2.1.300 TUI):
#   - An Enter delivered in the SAME `send-keys` call as the prompt text
#     arrives in one burst with the text. On a long prompt the TUI treats
#     that burst as a paste, so the Enter becomes a literal newline inside
#     the input box instead of a submit.
#   - Once that has happened a second Enter does not submit either — not
#     after 1 s, not after 3 s. So the old "text+Enter, sleep 1, Enter"
#     idiom was not a timing problem; it was the wrong shape, and it left
#     long prompts sitting unsubmitted while the helper exited 0.
#   - What works: type the text with `send-keys -l --` (no Enter in the
#     burst), wait until the pane stops changing (the paste has been
#     absorbed — ~0.5 s in practice), then send ONE Enter on its own.
#   - After a submit the `❯` input line is empty or shows a grey placeholder;
#     while unsubmitted it starts with the prompt's text. That is the
#     observable this script verifies, retrying Enter a bounded number of
#     times.
#
# The initial C-u is a best-effort pre-clear only: it is cursor-relative
# (deletes from the cursor to the start of the line), so a draft with the
# cursor elsewhere survives and our text is appended to it. Verification
# therefore checks that the input region (the `❯` row plus its wrapped
# continuation rows, down to the next border) CONTAINS the prompt's start
# anywhere, not that it begins with it. Never use C-c here: it interrupts a busy
# agent's turn, and on an empty box it arms the session-quit.
#
# Usage:
#   tmux-send-to-claude.sh <session> <prompt>
#
#   <session> — tmux target session/window/pane (e.g. "agent:0"), or
#               empty string "" to send to the current pane (useful
#               when the caller is already inside the target tmux; no
#               -t is passed to any tmux call in that mode).
#   <prompt>  — the prompt text to submit (may be multi-line).
#
# Exit codes:
#   0  submitted and verified
#   2  usage error
#   3  could not verify submission (no `❯` line in the pane); no further
#      Enter is sent, since a blind retry could submit twice
#   4  still unsubmitted after the Enter and its retries
#
# Tunables (environment; defaults suit a real TUI):
#   MACF_SEND_SETTLE_INTERVAL  seconds between pane samples   (0.25)
#   MACF_SEND_SETTLE_MAX       max samples while settling     (12 ≈ 3 s)
#   MACF_SEND_VERIFY_WAIT      seconds after Enter, pre-check (0.5)
#   MACF_SEND_RETRIES          extra Enters if unsubmitted    (2)
#   MACF_SEND_BACKOFF          seconds between retries        (0.5)
#
# This script is the ONLY sanctioned way to programmatically submit a
# prompt to a Claude Code TUI. Never inline `tmux send-keys ... Enter`
# for prompt submission.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <session-or-empty> <prompt>" >&2
  exit 2
fi

session="$1"
prompt="$2"

settle_interval="${MACF_SEND_SETTLE_INTERVAL:-0.25}"
settle_max="${MACF_SEND_SETTLE_MAX:-12}"
verify_wait="${MACF_SEND_VERIFY_WAIT:-0.5}"
retries="${MACF_SEND_RETRIES:-2}"
backoff="${MACF_SEND_BACKOFF:-0.5}"

# Target args: empty array in current-pane mode (no -t anywhere).
# Expanded as ${target[@]+"${target[@]}"} so an empty array is safe under
# `set -u` on bash < 4.4 too.
target=()
if [ -n "$session" ]; then
  target=(-t "$session")
fi
label="${session:-<current pane>}"

# Collapse all whitespace runs to single spaces and trim the ends.
collapse() {
  local IFS=$' \t\n'
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  printf '%s' "$*"
}

# Whole pane as text (no hashing: stock macOS has no md5sum).
pane_text() {
  tmux capture-pane ${target[@]+"${target[@]}"} -p 2>/dev/null || true
}

# Pane text WITH escape sequences (-e). Used only for verification, to tell
# typed text from Claude Code's dimmed prompt suggestion / placeholder.
pane_text_styled() {
  tmux capture-pane ${target[@]+"${target[@]}"} -p -e 2>/dev/null || true
}

# Drop every dim (SGR 2) span — from ESC[2m up to the next reset (ESC[0m,
# ESC[22m or ESC[m), carrying state across lines — then strip all remaining
# escape sequences. Claude Code renders its predicted-next-prompt suggestion
# and the empty-box placeholder dim; typed text is never dim. Without this, a
# suggestion that echoes the prompt just sent makes a SUBMITTED prompt look
# unsubmitted (false exit 4). Only awk/sed/tr, already required here.
strip_dim() {
  awk '
    BEGIN { esc = sprintf("%c", 27); dim = 0 }
    {
      line = $0; out = ""
      while (length(line) > 0) {
        if (dim) {
          if (match(line, esc "\\[(0|22)?m")) {
            line = substr(line, RSTART + RLENGTH); dim = 0
          } else { line = "" }
        } else if (match(line, esc "\\[2m")) {
          out = out substr(line, 1, RSTART - 1)
          line = substr(line, RSTART + RLENGTH); dim = 1
        } else { out = out line; line = "" }
      }
      print out
    }' | sed "s/$(printf '\033')\\[[0-9;]*[A-Za-z]//g"
}

# The whole input region as ONE line: from the last `❯` line down to (not
# including) the next border line starting with `─`, rows joined with single
# spaces. Claude Code wraps a long input over several indented rows, so a
# surviving draft can push our text off the `❯` row. Empty if no `❯` line.
# Dim spans (suggestions/placeholder) are removed first, see strip_dim.
# (Leading whitespace is dropped by collapse() at the call site.)
input_line() {
  pane_text_styled | strip_dim | awk '
    /^❯/ { found = 1; inbox = 1; out = $0; next }
    inbox && /^─/ { inbox = 0; next }
    inbox { out = out " " $0 }
    END { if (found) print out }'
}

# 1. Clear stale input, then type the text with NO Enter in the burst.
tmux send-keys ${target[@]+"${target[@]}"} C-u
tmux send-keys ${target[@]+"${target[@]}"} -l -- "$prompt"

# 2. Settle: wait until two consecutive pane samples match (bounded).
prev="$(pane_text)"
i=0
while [ "$i" -lt "$settle_max" ]; do
  sleep "$settle_interval"
  cur="$(pane_text)"
  [ "$cur" = "$prev" ] && break
  prev="$cur"
  i=$((i + 1))
done

# 3. One Enter, on its own.
tmux send-keys ${target[@]+"${target[@]}"} Enter

# Verification needle: first prompt line, whitespace-collapsed, 30 chars.
first_line="${prompt%%$'\n'*}"
needle="$(collapse "$first_line")"
needle="${needle:0:30}"
if [ -z "$needle" ]; then
  exit 0  # nothing distinctive to look for (blank prompt)
fi

# 4. Verify; re-send Enter (bounded) while the box still holds the text.
attempt=0
while :; do
  sleep "$verify_wait"
  line="$(input_line)"
  if [ -z "$line" ]; then
    echo "tmux-send-to-claude: could not verify submission for target '$label' (no ❯ input line in pane)" >&2
    exit 3
  fi
  if [[ "$(collapse "$line")" != *"$needle"* ]]; then
    exit 0
  fi
  if [ "$attempt" -ge "$retries" ]; then
    echo "tmux-send-to-claude: prompt still unsubmitted in target '$label' after $((attempt + 1)) Enter(s)" >&2
    exit 4
  fi
  attempt=$((attempt + 1))
  sleep "$backoff"
  tmux send-keys ${target[@]+"${target[@]}"} Enter
done
