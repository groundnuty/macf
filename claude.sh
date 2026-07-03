#!/usr/bin/env bash
set -euo pipefail

# MACF Agent Launcher: code-agent
# This file is managed by `macf`. Do not edit directly — edits are
# overwritten on the next `macf update`. The template lives at
# groundnuty/macf:src/cli/claude-sh.ts. To change the launcher, file
# an issue or PR against that file, then run `macf update` here.
#
# This is a THIN launcher (macf#342). All per-concern env exports
# (identity, GitHub, certs, registry, telemetry, tmux) live in separate
# files under .claude/.macf/env.* and are sourced via the loop below.
# To regenerate after a config change, run `macf update` here.
#
# Canonical per-concern env files (sourced alphabetically):
#   env._helpers   — library: jq settings helper (sourced FIRST per underscore prefix)
#   env.certs      — cert + log paths                                        (macf-managed)
#   env.github     — App creds + bot token mint + git author/committer       (macf-managed; empty in local-mode)
#   env.identity   — project / agent name / role / type / workspace dir      (macf-managed)
#   env.registry   — registry type + per-type pointer                        (macf-managed)
#   env.telemetry  — OTel gates + endpoint                                   (operator-managed; preserved by macf update)
#   env.tmux       — wake-path session + window targets                      (operator-managed; preserved by macf update)
#
# Extension model: add operator-custom env files as `env.local.<name>` or
# `env.zz.<name>` so they sort AFTER the canonical seven (lowercase letters
# > underscore in ASCII, so .local.* and .zz.* both sort late). The thin
# source-loop below picks them up automatically — no edit to this file needed.
# See docs/configuration.md for the full reference (macf#342).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Host toolchain bootstrap (DR-031 piece 4). Source host-prelude.sh
# FIRST — before the env.* loop, the tmux self-wrap, and the final claude
# launch — so the toolchain (claude / jq / node / tmux) is on PATH when the
# launch context has a MINIMAL env that did not inherit the operator
# login-shell PATH: cron, a detached restart-self relauncher, or a
# container entrypoint. The env.* files (token mint needs gh/jq/openssl)
# and claude itself depend on the toolchain this re-establishes; it is
# macf-managed + re-detected (devbox/brew/none) on every `macf update`.
# The `[ -f ] &&` form is set -e safe (the left of && is not the final
# command) and lets a workspace lacking the file (older init) still
# launch. The same path is consumed by restart-self's relauncher.
[ -f "$SCRIPT_DIR/.claude/.macf/host-prelude.sh" ] && source "$SCRIPT_DIR/.claude/.macf/host-prelude.sh"

# Source per-concern env files (macf#342). Shell glob sorts
# alphabetically, so env._helpers (underscore prefix sorts before
# letters) loads first and defines macf_settings_get used by
# env.identity and env.telemetry. The `[ -f ]` guard tolerates the
# (very unusual) case where the directory exists but a sibling tool
# created a non-file glob match.
#
# Operator-custom env files (override or extend canonical config):
# use `env.local.<name>` or `env.zz.<name>` prefix so they sort
# AFTER all macf-managed canonical files (env._helpers / env.certs /
# env.github / env.identity / env.registry / env.telemetry / env.tmux).
# Bash glob sorts ASCII: uppercase A-Z (0x41-0x5A) BEFORE underscore
# (0x5F) BEFORE lowercase a-z (0x61-0x7A). An operator-added file like
# `env.UPPERCASE_OVERRIDE` would sort before `env._helpers` and source
# in a context without macf_settings_get defined yet — followed by
# `env.identity` calling that undefined function. Stick to the
# `env.local.*` or `env.zz.*` convention to avoid the trap.
if [ -d "$SCRIPT_DIR/.claude/.macf" ]; then
  for f in "$SCRIPT_DIR/.claude/.macf"/env.*; do
    [ -f "$f" ] && source "$f"
  done
fi

# Channel-server runtime knobs that don't cleanly bucket into a
# single env.* concern. MACF_HOST/MACF_ADVERTISE_HOST are network
# transport (close to certs but not cert-related); MACF_DEBUG is a
# global verbosity gate. Kept in claude.sh as orchestration; PR-D
# may refactor into a dedicated env.channel-server file.
#
# Listen on all interfaces; advertise the routable host below. When
# advertise_host is unset in macf-agent.json, fall back to 127.0.0.1
# (the plugin's existing default — keeps backward compat for
# workspaces that haven't set the field yet). See macf#178.
export MACF_HOST="0.0.0.0"
export MACF_ADVERTISE_HOST="orzech-dev-agents.tail491af.ts.net"
export MACF_DEBUG="${MACF_DEBUG:-false}"

# macf#642: the channel-server's native log path — its forensic trail. The
# comms-ledger + turn-receipt sink are siblings derived from it, and the
# channel-server reads MACF_LOG_PATH via @groundnuty/macf-core config. The
# whole cluster lives in the agent HOME under the XDG state dir (per-agent
# <project>@<agent> subdir, matching the forensic-log default base + the
# tmux session name) — OUT of the repo so it never clutters or is committed.
# For a fully macf-init'd workspace env.certs already exports this (sourced
# above) to the SAME path, so the ${VAR:-default} form preserves it and only
# supplies the default for an older/partial workspace whose env.certs
# predates the var.
export MACF_LOG_PATH="${MACF_LOG_PATH:-${XDG_STATE_HOME:-$HOME/.local/state}/macf/macf@code-agent/channel.log}"

# Tmux self-wrap (macf#313 Path-2 promotion of coordination.md
# §Canonical tmux launch pattern). If launched outside tmux and the
# operator hasn't opted out, re-exec inside a tmux session named
# <MACF_PROJECT>@<MACF_ROUTING_LABEL>. Attach if the session exists;
# otherwise create a new one. The second invocation (inside tmux)
# has $TMUX set and skips the wrap.
#
# Env-isolation guarantee (macf#340): when `tmux new-session` runs
# against an already-running tmux server, the new session's env is
# initialized from the SERVER'S GLOBAL env (set once at server
# start), NOT the calling shell's env. So a second `./claude.sh`
# from a different workspace would inherit the FIRST agent's
# MACF_ROUTING_LABEL from server-global — `${VAR:-default}` shortcut
# preserves the leaked value, causing AGENT_COLLISION on register.
# The `-e VAR=VAL` flags built from MACF_TMUX_PASSTHROUGH below pin
# session-level env that overrides server-global, ensuring this
# workspace's identity wins. Array-iteration pattern + unset-guard
# means the var list is single-source-of-truth + adding a new var
# is one line + unset vars (e.g., GH_TOKEN in local mode) skip
# cleanly without breaking generation.
#
# Opt-out: MACF_NO_TMUX_WRAP=1 ./claude.sh
#   For operator-driven manual launches outside tmux, debug sessions,
#   single-shot CLI use, CI environments.
if [ -z "${TMUX:-}" ] && [ "${MACF_NO_TMUX_WRAP:-}" != "1" ]; then
  SESSION_NAME="${MACF_PROJECT}@${MACF_ROUTING_LABEL}"
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    exec tmux attach -t "$SESSION_NAME"
  else
    # Capture every MACF_* env var currently exported in this outer
    # shell + pass each via `-e` to tmux new-session. Pattern-driven
    # rather than hard-coded list: future MACF_* additions are picked
    # up automatically; vars not set at wrap-time (e.g., cert paths
    # exported AFTER this block in the inner re-execed shell) are
    # naturally absent — they are set fresh per invocation, so no
    # leak risk through tmux server-global env. macf#340.
    MACF_TMUX_E_ARGS=()
    while IFS= read -r macf_env_line; do
      MACF_TMUX_E_ARGS+=("-e" "$macf_env_line")
    done < <(env | grep -E "^MACF_" || true)
    exec tmux new-session "${MACF_TMUX_E_ARGS[@]}" -s "$SESSION_NAME" -c "$SCRIPT_DIR" "$0" "$@"
  fi
fi

# Channel notifications enablement (macf#632). Claude Code v2.1.80+ gates
# the MCP channel-notification push (routed-coordination delivery) behind a
# launch flag; without it the macf-agent MCP server logs "Channel
# notifications skipped: ... not in --channels list" and routed pings are
# silently dropped. The dev-flag form is required because the --plugin-dir
# macf-agent plugin is not on Anthropic's curated channel allowlist.
#
# Escape hatches (priority order): MACF_CHANNELS_DISABLED=1 omits the flag;
# a preset MACF_CHANNELS_ARGS is respected verbatim (and bypasses the
# version gate); else the canonical dev-flag gated on Claude Code >= 2.1.80.
#
# $MACF_CHANNELS_ARGS is expanded UNQUOTED in the exec line below so the
# two-token flag word-splits into two argv entries.

# Parse the running Claude Code version (X.Y.Z) for the >= 2.1.80 gate. An
# unparseable/absent version is treated as old (flag left off + loud warn).
macf_cc_ver="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
macf_channels_supported=0
if [ -n "$macf_cc_ver" ]; then
  macf_cc_major="${macf_cc_ver%%.*}"
  macf_cc_rest="${macf_cc_ver#*.}"
  macf_cc_minor="${macf_cc_rest%%.*}"
  macf_cc_patch="${macf_cc_ver##*.}"
  if [ "${macf_cc_major:-0}" -gt 2 ] \
     || { [ "${macf_cc_major:-0}" -eq 2 ] && [ "${macf_cc_minor:-0}" -gt 1 ]; } \
     || { [ "${macf_cc_major:-0}" -eq 2 ] && [ "${macf_cc_minor:-0}" -eq 1 ] && [ "${macf_cc_patch:-0}" -ge 80 ]; }; then
    macf_channels_supported=1
  fi
fi

if [ "${MACF_CHANNELS_DISABLED:-}" = "1" ]; then
  MACF_CHANNELS_ARGS=""
elif [ -n "${MACF_CHANNELS_ARGS:-}" ]; then
  : # operator-supplied override — respect it verbatim (version gate bypassed)
elif [ "$macf_channels_supported" = "1" ]; then
  MACF_CHANNELS_ARGS="--dangerously-load-development-channels server:macf-agent"
else
  MACF_CHANNELS_ARGS=""
  echo "WARNING (macf#632): Claude Code ${macf_cc_ver:-<unknown>} is older than 2.1.80" >&2
  echo "WARNING: (or its version was unparseable) — MACF channel notifications are" >&2
  echo "WARNING: UNAVAILABLE this session; routed issues/PRs/mentions will be SILENTLY" >&2
  echo "WARNING: dropped. Update Claude Code to >= 2.1.80 to enable them (macf#632/#633)." >&2
fi

# Interactive-prompt auto-responder (macf#645 / DR-033). Start the pane
# watcher in the background so it can auto-clear KNOWN launch ceremony
# prompts (allowlist-only; unknown prompt-like frames are ALERTed, never
# answered — Inv 1) during the startup window. Only runs in-tmux (a
# deterministic $TMUX_PANE to watch); survives the claude launch below as a
# separate process and self-exits when the window elapses. Opt-out:
# MACF_PROMPT_AUTORESPOND_DISABLED=1 (sister to MACF_OTEL_DISABLED).
if [ "${MACF_PROMPT_AUTORESPOND_DISABLED:-}" != "1" ] \
   && [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] \
   && [ -x "$SCRIPT_DIR/.claude/scripts/macf-prompt-watcher.sh" ]; then
  "$SCRIPT_DIR/.claude/scripts/macf-prompt-watcher.sh" "$TMUX_PANE" &
fi

# shellcheck disable=SC2086
if [ -n "${MACF_TEST:-}" ]; then
  exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"
else
  claude -c --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@" || exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"
fi
