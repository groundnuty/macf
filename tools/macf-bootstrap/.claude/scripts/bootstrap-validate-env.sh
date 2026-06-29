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
#   - the installed `macf` CLI is absent OR does not satisfy plugin.json's
#     declared `.compatibility.macf` range (DR-035 §7 — independent versioning +
#     ENFORCED compatibility; refuse on version-skew, safe-by-refusal)
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

# ── semver helpers (bash port of @groundnuty/macf-core `compareSemver`) ──────
# Scope: x.y.z (optional leading v) only — sufficient for the 0.2.x line; an
# unparseable string is treated as 0.0.0 (oldest), matching macf-core.
_semver_triplet() { # $1=version → "MAJ MIN PAT" (unparseable ⇒ "0 0 0")
  local v="${1#v}"
  if [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    printf '%s %s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
  else
    printf '0 0 0'
  fi
}
_compare_semver() { # $1 vs $2 → echoes lt|eq|gt
  local -a A B; local i
  read -ra A <<<"$(_semver_triplet "$1")"
  read -ra B <<<"$(_semver_triplet "$2")"
  for i in 0 1 2; do
    if (( A[i] < B[i] )); then printf lt; return 0; fi
    if (( A[i] > B[i] )); then printf gt; return 0; fi
  done
  printf eq
}
# macf_satisfies VERSION RANGE → exit 0 iff VERSION satisfies RANGE.
# Supports ">=X.Y.Z" (canonical), ">X.Y.Z", "=X.Y.Z", and a bare "X.Y.Z"
# (treated as a minimum). An unparseable VERSION or RANGE never satisfies —
# safe-by-refusal: refuse on version-skew OR on a version we cannot parse.
macf_satisfies() {
  local version="$1" range="$2" op min cmp
  range="${range//[[:space:]]/}"
  case "$range" in
    ">="*) op=">="; min="${range#>=}" ;;
    ">"*)  op=">";  min="${range#>}"  ;;
    "="*)  op="=";  min="${range#=}"  ;;
    *)     op=">="; min="$range"      ;;
  esac
  [[ "${version#v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ "${min#v}"     =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  cmp="$(_compare_semver "$version" "$min")"
  case "$op" in
    ">=") [[ "$cmp" == gt || "$cmp" == eq ]] ;;
    ">")  [[ "$cmp" == gt ]] ;;
    "=")  [[ "$cmp" == eq ]] ;;
  esac
}

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

# ── macf-bootstrap ↔ macf framework compatibility (version-skew refusal) ────
# macf-bootstrap is versioned INDEPENDENTLY of the framework (DR-035 §7) and
# DECLARES the macf range it needs in plugin.json (.compatibility.macf). The
# workspace runs `macf` locally (CA generation + emitting the VM-side `macf init`
# commands — DR-035 §3), so an incompatible/absent macf must STOP the run loud.
# This makes the compat declaration *enforced*, not just documented — the
# safe-by-refusal property of §2 extended to cover version-skew.
PLUGIN_JSON="$WORKSPACE/.claude-plugin/plugin.json"
if [[ ! -f "$PLUGIN_JSON" ]]; then
  note_fail "plugin.json missing ($PLUGIN_JSON) — the independent macf-bootstrap version + the .compatibility.macf declaration live there (DR-035 §7)."
elif ! command -v jq >/dev/null 2>&1; then
  : # jq absence already reported above; cannot parse the compat range without it.
else
  bs_version="$(jq -r '.version // empty' "$PLUGIN_JSON" 2>/dev/null || true)"
  macf_range="$(jq -r '.compatibility.macf // empty' "$PLUGIN_JSON" 2>/dev/null || true)"
  if [[ -z "$macf_range" ]]; then
    note_fail "plugin.json has no .compatibility.macf range — cannot verify macf-version compatibility (DR-035 §7)."
  elif ! command -v macf >/dev/null 2>&1; then
    note_fail "\`macf\` CLI not found on PATH — macf-bootstrap ${bs_version:-0.1.0} requires macf ${macf_range}. Run \`npm i -g @groundnuty/macf@latest\`."
  else
    macf_version="$(macf --version 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
    if macf_satisfies "$macf_version" "$macf_range"; then
      note_ok "macf ${macf_version} satisfies macf-bootstrap ${bs_version:-0.1.0} compatibility (${macf_range})."
    else
      note_fail "macf-bootstrap ${bs_version:-0.1.0} requires macf ${macf_range}; found ${macf_version:-<unparseable>}. Run \`npm i -g @groundnuty/macf@latest\` (or install a macf that satisfies ${macf_range})."
    fi
  fi
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
