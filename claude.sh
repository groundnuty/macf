#!/bin/bash
# Launcher for macf-code-agent
# Generates a GitHub App token, starts tmux session, boots Claude Code.
#
# Requires:
#   - .claude/settings.local.json with env.APP_ID, env.INSTALL_ID, env.KEY_PATH
#   - .github-app-key.pem (or whatever KEY_PATH points to)
#   - gh CLI with personal login (for token generation)
#   - jq, tmux, claude
#
# Env vars:
#   CLAUDE_BIN  — path to the claude binary to use (default: "claude" in PATH).
#                 Useful when pinning to a specific version, e.g.
#                 CLAUDE_BIN=/tmp/claude-versions/claude-3 ./claude.sh -r

set -euo pipefail

if [ -d /home/linuxbrew/.linuxbrew ]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv bash)"
fi

CLAUDE_BIN="${CLAUDE_BIN:-claude}"

RESUME=0
RESUME_ID=""
if [ "${1:-}" = "-r" ]; then
  RESUME=1
  shift
  if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
    RESUME_ID="$1"
    shift
  fi
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS="$DIR/.claude/settings.local.json"

if [ ! -f "$SETTINGS" ]; then
  echo "error: $SETTINGS not found" >&2
  echo "copy .claude/settings.local.json.example and fill in APP_ID / INSTALL_ID" >&2
  exit 1
fi

APP_ID=$(jq -r '.env.APP_ID' "$SETTINGS")
INSTALL_ID=$(jq -r '.env.INSTALL_ID' "$SETTINGS")
KEY_PATH=$(jq -r '.env.KEY_PATH' "$SETTINGS")

if [ "$APP_ID" = "null" ] || [ "$INSTALL_ID" = "null" ] || [ "$KEY_PATH" = "null" ]; then
  echo "error: APP_ID / INSTALL_ID / KEY_PATH missing in $SETTINGS" >&2
  exit 1
fi

ABS_KEY="$DIR/$KEY_PATH"
if [ ! -f "$ABS_KEY" ]; then
  echo "error: private key not found at $ABS_KEY" >&2
  exit 1
fi

# Fail-loud token generation — the naive `export GH_TOKEN=$(gh token
# generate ... | jq)` silently swallows errors (no pipefail), making
# `GH_TOKEN` the string "null" and letting `gh` fall back to stored
# user auth. This is the attribution trap (see coordination.md Token
# & Git Hygiene + feedback_attribution_trap_recurring.md). Use the
# canonical helper so failures surface.
GH_TOKEN=$("$DIR/.claude/scripts/macf-gh-token.sh" \
  --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$ABS_KEY") || {
  echo "FATAL: bot token generation failed — see stderr above." >&2
  exit 1
}

SESSION="code-agent"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "session '$SESSION' already exists. attach with: tmux attach -t $SESSION" >&2
  exit 0
fi

# macf#418 item A: Claude Code native OTEL telemetry for code-agent.
# `tmux new-session` does NOT propagate this launcher's exported env to the
# `claude` process (the env-stripping boundary #418 root-caused — OTEL_* /
# CLAUDE_CODE_* exported here would never reach claude, so telemetry stays
# dark, as it has been on the substrate agents). Fix: inline the telemetry
# vars into the launched command the SAME way GH_TOKEN already is, via
# LAUNCH_ENV below. Mirrors the canonical claude-sh.ts otelTelemetryLines set
# + the devops#78 reference impl. Opt out with MACF_OTEL_DISABLED=1 (e.g. a
# host with no observability stack running). Existing env values win (the
# `: "${VAR=default}"` form only assigns when unset).
LAUNCH_ENV="GH_TOKEN=$GH_TOKEN"
if [ "${MACF_OTEL_DISABLED:-}" != "1" ]; then
  : "${CLAUDE_CODE_ENABLE_TELEMETRY=1}"
  # macf#418/#197: traces require this beta gate IN ADDITION to the master gate.
  # CLAUDE_CODE_ENABLE_TELEMETRY=1 alone emits metrics+logs but NOT traces — the
  # hand-port of this block dropped it, so substrate emitted zero native spans
  # (science A/B vs CV). Canonical claude-sh.ts otelTelemetryLines has it.
  : "${CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1}"
  : "${OTEL_TRACES_EXPORTER=otlp}"
  : "${OTEL_METRICS_EXPORTER=otlp}"
  : "${OTEL_LOGS_EXPORTER=otlp}"
  : "${OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf}"
  # IPv4 literal per macf#419 (avoids the localhost→::1 ambiguity); override
  # via MACF_OTEL_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT in the environment.
  : "${MACF_OTEL_ENDPOINT=http://127.0.0.1:14318}"
  : "${OTEL_EXPORTER_OTLP_ENDPOINT=$MACF_OTEL_ENDPOINT}"
  : "${OTEL_SERVICE_NAME=macf-agent-code-agent}"
  : "${OTEL_RESOURCE_ATTRIBUTES=gen_ai.agent.name=code-agent,gen_ai.agent.role=code-agent,service.namespace=macf}"
  for _v in CLAUDE_CODE_ENABLE_TELEMETRY CLAUDE_CODE_ENHANCED_TELEMETRY_BETA \
            OTEL_TRACES_EXPORTER OTEL_METRICS_EXPORTER \
            OTEL_LOGS_EXPORTER OTEL_EXPORTER_OTLP_PROTOCOL OTEL_EXPORTER_OTLP_ENDPOINT \
            OTEL_SERVICE_NAME OTEL_RESOURCE_ATTRIBUTES; do
    LAUNCH_ENV="$LAUNCH_ENV $_v=${!_v:-}"
  done
fi

if [ "$RESUME" = "1" ]; then
  if [ -n "$RESUME_ID" ]; then
    CMD="$LAUNCH_ENV '$CLAUDE_BIN' --permission-mode acceptEdits --resume $RESUME_ID"
  else
    CMD="$LAUNCH_ENV '$CLAUDE_BIN' --permission-mode acceptEdits --resume"
  fi
else
  CMD="$LAUNCH_ENV '$CLAUDE_BIN' --permission-mode acceptEdits -c || $LAUNCH_ENV '$CLAUDE_BIN' --permission-mode acceptEdits"
fi

tmux new-session -s "$SESSION" -c "$DIR" "$CMD"
