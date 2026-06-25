#!/usr/bin/env bash
set -euo pipefail

# MACF Agent Launcher: code-agent (HAND-WIRED substrate — devops-toolkit DR-005 Decision 6).
#
# RECONCILED to the framework generation (this repo's src/cli/claude-sh.ts) but maintained
# by hand: substrate workspace, NOT a `macf init` consumer (macf#273). Do NOT run
# `macf init`/`macf update` here. Canonical-worthy changes graduate UP (DR-029);
# host-specifics live in host-prelude.sh / env.local.*.
#
# Thin launcher (macf#342): per-concern env in .claude/.macf/env.*, sourced below.
# The minimal channel-server plugin (.macf/plugin-cs, mcpServers-only — macf#533)
# brings up the Stage-3 channel server as claude's MCP child via --plugin-dir.
# Prepped by devops (canary-1) per DR-027 phase-2; mirrors the proven devops launcher.
# As framework owner you own the canonical claude-sh.ts template — review + adjust freely;
# this is the substrate-mode shape the template should ultimately generate.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Host-local prelude FIRST — before the env.* loop, because env.github mints the bot
# token via brew-installed openssl/curl on this VM.
[ -f "$SCRIPT_DIR/.claude/.macf/host-prelude.sh" ] && source "$SCRIPT_DIR/.claude/.macf/host-prelude.sh"

# Source per-concern env files (macf#342). env._helpers (underscore) sorts first.
if [ -d "$SCRIPT_DIR/.claude/.macf" ]; then
  for f in "$SCRIPT_DIR/.claude/.macf"/env.*; do
    [ -f "$f" ] && source "$f"
  done
fi

# Channel-server network identity (DR-005 Decisions 2+3). Inherited by the MCP child.
# WITHOUT MACF_ADVERTISE_HOST the registry-advertised host defaults to 127.0.0.1 —
# unreachable from the GitHub router + SAN-mismatch vs the FQDN leaf cert. MACF_PORT
# is the per-agent fixed port from the DR-005 Decision-3 map (code=8702).
export MACF_HOST="${MACF_HOST:-0.0.0.0}"
export MACF_ADVERTISE_HOST="${MACF_ADVERTISE_HOST:-orzech-dev-agents.tail491af.ts.net}"
export MACF_PORT="${MACF_PORT:-8702}"

# Tmux self-wrap (macf#313/#340) → session <MACF_PROJECT>@<MACF_AGENT_NAME> =
# macf@macf-code-agent. The -e MACF_* passthrough pins this workspace's identity over
# the tmux server-global env (macf#340). The inner invocation ($TMUX set) re-sources
# env.* fresh, so OTEL_*/GH_TOKEN are re-derived in-session.
# Opt-out: MACF_NO_TMUX_WRAP=1 ./claude.sh
if [ -z "${TMUX:-}" ] && [ "${MACF_NO_TMUX_WRAP:-}" != "1" ]; then
  SESSION_NAME="${MACF_PROJECT}@${MACF_AGENT_NAME}"
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    exec tmux attach -t "$SESSION_NAME"
  else
    MACF_TMUX_E_ARGS=()
    while IFS= read -r macf_env_line; do
      MACF_TMUX_E_ARGS+=("-e" "$macf_env_line")
    done < <(env | grep -E "^MACF_" || true)
    exec tmux new-session "${MACF_TMUX_E_ARGS[@]}" -s "$SESSION_NAME" -c "$SCRIPT_DIR" "$0" "$@"
  fi
fi

# Inside the session: launch Claude Code with the minimal channel-server plugin →
# the MCP child binds :8702 and self-registers MACF_AGENT_CODE_AGENT.
if [ -n "${MACF_TEST:-}" ]; then
  exec claude --permission-mode acceptEdits --plugin-dir "$SCRIPT_DIR/.macf/plugin-cs" "$@"
else
  claude --permission-mode acceptEdits -c --plugin-dir "$SCRIPT_DIR/.macf/plugin-cs" "$@" \
    || exec claude --permission-mode acceptEdits --plugin-dir "$SCRIPT_DIR/.macf/plugin-cs" "$@"
fi
