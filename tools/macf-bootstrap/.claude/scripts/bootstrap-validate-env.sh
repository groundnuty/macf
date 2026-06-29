#!/usr/bin/env bash
#
# bootstrap-validate-env.sh — start-of-run environment validation for the
# macf-bootstrap skill (DR-035 §1: the skill "best-effort validates the
# environment at start ... stop loud if not", even though it cannot enforce it).
#
# Contract:
#   exit 0  → environment is usable (criticals satisfied; warnings may print)
#   exit 1  → a CRITICAL gap (the run cannot proceed) — actionable message on stderr
#
# Critical gaps (stop loud, exit 1):
#   - `gh` missing OR not authenticated
#   - `gh` authenticated as a BOT (ghs_) token, not the operator's USER token
#     (this workspace acts AS the operator — the deliberate inverse of the fleet
#      attribution discipline; a bot token here is the wrong identity, DR-035 §2)
#   - `age` / `age-keygen` missing (the vault is age-encrypted — no vault, no run)
#   - `jq` missing (every helper parses JSON with it)
#   - the two structural deny-rails missing from the workspace (the no-prompt
#     autonomy is only safe behind them — DR-035 §2.2)
#
# Best-effort (warn only, never fatal):
#   - the Chrome DevTools MCP debug endpoint is unreachable. Whether the MCP is
#     actually *connected* to Claude Code can't be probed from a shell; the best
#     proxy is "is a remote-debugging Chrome listening?" — a warning, not a stop.
#
# Overrides: none — validation is advisory criticals. To run despite a critical
# gap, fix the gap (that is the point).
#
# Refs: DR-035 §1/§2; sister guards check-bootstrap-{gh-guard,url-allowlist}.sh.
set -euo pipefail

# Workspace root = two levels up from this script (.claude/scripts/ → workspace).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/../.." && pwd)"

CHROME_URL="${MACF_BOOTSTRAP_CHROME_URL:-http://127.0.0.1:9222}"

fail=0
note_fail() { echo "✗ CRITICAL: $1" >&2; fail=1; }
note_warn() { echo "⚠ WARN: $1" >&2; }
note_ok()   { echo "✓ $1" >&2; }

# ── gh present + authenticated as the operator (USER, not bot) ──────────────
if ! command -v gh >/dev/null 2>&1; then
  note_fail "\`gh\` CLI not found on PATH. Install it and \`gh auth login\` as the operator."
else
  if token="$(gh auth token 2>/dev/null)" && [[ -n "$token" ]]; then
    case "$token" in
      ghs_*)
        note_fail "gh is authenticated as a BOT installation token (ghs_*). This workspace must act AS the operator's USER account (DR-035 §2 — the deliberate inverse of the fleet attribution discipline). Run \`gh auth login\` as your user, NOT a bot."
        ;;
      gho_*|ghp_*|ghu_*)
        note_ok "gh authenticated as a user token."
        ;;
      *)
        note_warn "gh auth token has an unrecognized prefix; expected a user token (gho_/ghp_/ghu_). Verify \`gh auth status\`."
        ;;
    esac
  else
    note_fail "gh is not authenticated. Run \`gh auth login\` as the operator (user, not a bot)."
  fi
fi

# ── age + age-keygen (vault encryption) ────────────────────────────────────
if ! command -v age >/dev/null 2>&1; then
  note_fail "\`age\` not found — the bootstrap vault is age-encrypted. Install age (https://github.com/FiloSottile/age)."
else
  note_ok "age present."
fi
if ! command -v age-keygen >/dev/null 2>&1; then
  note_fail "\`age-keygen\` not found — needed to mint the vault recipient keypair. Install age."
fi

# ── jq (every helper parses JSON) ──────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  note_fail "\`jq\` not found — required to parse GitHub API responses."
else
  note_ok "jq present."
fi

# ── the two structural deny-rails (the no-prompt autonomy's only fences) ────
SETTINGS="$WORKSPACE/.claude/settings.json"
GH_GUARD="$WORKSPACE/.claude/scripts/check-bootstrap-gh-guard.sh"
URL_GUARD="$WORKSPACE/.claude/scripts/check-bootstrap-url-allowlist.sh"
if [[ ! -f "$SETTINGS" ]]; then
  note_fail "workspace settings.json missing ($SETTINGS) — the deny-rails live there."
fi
if [[ ! -f "$GH_GUARD" ]]; then
  note_fail "gh deny-rail missing ($GH_GUARD) — the Bash/gh destructive fence (DR-035 §2.2)."
fi
if [[ ! -f "$URL_GUARD" ]]; then
  note_fail "browser deny-rail missing ($URL_GUARD) — the chrome-MCP URL fence (DR-035 §2.2)."
fi
if [[ -f "$SETTINGS" && -f "$GH_GUARD" && -f "$URL_GUARD" ]]; then
  note_ok "both structural deny-rails present."
fi

# ── Chrome DevTools MCP reachability (best-effort, warn only) ───────────────
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 2 "$CHROME_URL/json/version" >/dev/null 2>&1; then
    note_ok "Chrome remote-debugging endpoint reachable at $CHROME_URL (MCP can attach)."
  else
    note_warn "Chrome remote-debugging endpoint NOT reachable at $CHROME_URL. Start Chrome with --remote-debugging-port=9222 and point the chrome-devtools MCP at it (--browser-url). Best-effort check; the MCP connection itself is verified inside Claude Code."
  fi
else
  note_warn "curl not found — skipping the Chrome reachability probe (best-effort)."
fi

if [[ "$fail" -ne 0 ]]; then
  echo "" >&2
  echo "macf-bootstrap environment validation FAILED — fix the CRITICAL items above before running the skill (DR-035 §1)." >&2
  exit 1
fi
echo "macf-bootstrap environment validation OK." >&2
exit 0
