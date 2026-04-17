#!/usr/bin/env bash
# Send a prompt to a Claude Code TUI running in a tmux session.
#
# Claude Code's TUI is in multi-line input mode by default, so a single
# Enter inserts a newline instead of submitting. Sending the prompt and
# a single Enter leaves the text stuck in the input buffer until someone
# manually presses Enter again.
#
# The correct pattern is:
#   1. C-u                  — clear any stale input
#   2. "<prompt>" + Enter   — type the prompt and a first Enter
#   3. sleep 1              — let tmux deliver those as one read event
#                             (without the sleep, tmux may batch both
#                             Enters together and Claude processes them
#                             atomically as "newline + newline", never
#                             submitting)
#   4. Enter                — the second Enter that actually submits
#
# Usage:
#   tmux-send-to-claude.sh <session> <prompt>
#
#   <session> — tmux target session/window/pane (e.g. "agent:0"), or
#               empty string "" to send to the current pane (useful
#               when the caller is already inside the target tmux).
#   <prompt>  — the prompt text to submit.
#
# This script is the ONLY sanctioned way to programmatically submit a
# prompt to a Claude Code TUI. Never inline `tmux send-keys ... Enter`
# for prompt submission — the quirk above is easy to forget.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <session-or-empty> <prompt>" >&2
  exit 2
fi

session="$1"
prompt="$2"

if [ -n "$session" ]; then
  tmux send-keys -t "$session" C-u
  tmux send-keys -t "$session" "$prompt" Enter
  sleep 1
  tmux send-keys -t "$session" Enter
else
  tmux send-keys C-u
  tmux send-keys "$prompt" Enter
  sleep 1
  tmux send-keys Enter
fi
