#!/usr/bin/env bash
#
# check-bootstrap-url-allowlist.sh — PreToolUse hook for the macf-bootstrap
# operator-privileged workspace. Fences the Chrome DevTools MCP browser surface
# to the GitHub-provisioning allowlist (DR-035 §2.2, browser/MCP surface).
#
# WHY a hook and not a permissions.deny rule (verified, CC 2.1.195):
#   - permission `deny` rules fire BEFORE PreToolUse hooks AND skip them, so a
#     denied tool never reaches this script. The chrome-devtools MCP tool is
#     therefore `allow`ed in settings.json and the URL policy is enforced HERE.
#   - permissions.deny also CANNOT arg-match MCP tools: the `Tool(param:value)`
#     matcher (CC 2.1.178) is built-in-tools-only, not `mcp__*`. So a URL
#     allowlist on the browser is ONLY expressible as a PreToolUse hook.
#
# Hook contract: PreToolUse JSON on stdin; exit 0 = allow, exit 2 = block
# (stderr is fed back to Claude). Block is exit-2-ONLY with a human-readable
# reason on stderr — never a JSON permissionDecision on stdout (the JSON+exit-2
# mix mis-blocked before the CC 2.1.109 fix; exit-2-only is the version-robust
# deny, same shape as check-gh-token.sh / check-mention-routing.sh).
#
# Policy (default-deny): a navigation URL must (a) NOT match the destructive
# denylist AND (b) match the provisioning allowlist, else it is blocked.
# Non-navigation chrome tools (screenshot/snapshot/click/type/…) carry no URL
# and pass through.
#
# Override: MACF_BOOTSTRAP_SKIP_URL_GUARD=1 (deliberate operator exception).
#
# Refs: DR-035 §2.2 (dual-surface deny — this is the browser/MCP surface);
#       sister Bash-surface guard check-bootstrap-gh-guard.sh.
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_BOOTSTRAP_SKIP_URL_GUARD:-}" == "1" ]]; then
  exit 0
fi

# Read and parse the PreToolUse payload. Fall through to allow on parse error —
# a broken hook must not brick the workspace; the destructive denylist still
# fires for any URL we DO parse, and a parse failure yields an empty URL which
# is handled conservatively per-tool below.
INPUT_JSON="$(cat)"
TOOL_NAME="$(jq -r '.tool_name // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
URL="$(jq -r '.tool_input.url // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

# Bare tool name (strip the `mcp__<server>__` prefix).
SHORT_TOOL="${TOOL_NAME##*__}"

# In chrome-devtools-mcp the only navigation tools that carry a URL are:
#   - new_page     (url REQUIRED)
#   - navigate_page (url OPTIONAL — also used for back/forward/reload with NO url)
# Everything else (take_screenshot, take_snapshot, click, fill, type_text,
# evaluate_script, …) takes no URL: a read/interact action on whatever page is
# already open. Those pass through (the page they act on was already gated by an
# earlier navigation through this hook).
if [[ -z "$URL" || "$URL" == "null" ]]; then
  case "$SHORT_TOOL" in
    new_page)
      # url is REQUIRED for new_page — missing/unparseable url cannot be verified
      # against the allowlist → fail-closed (deny if you can't verify).
      cat >&2 <<ERR
BLOCKED by macf-bootstrap URL guard: new_page called without a verifiable URL.

new_page requires a destination URL; a missing/unparseable URL cannot be checked
against the provisioning allowlist, so it is denied (fail-closed, DR-035 §2.2).

Override (deliberate operator exception only):
  export MACF_BOOTSTRAP_SKIP_URL_GUARD=1
ERR
      exit 2
      ;;
    *)
      # navigate_page history-nav (back/forward/reload — no destination URL) or
      # a non-navigation chrome tool. Nothing to fence.
      exit 0
      ;;
  esac
fi

# Match case-insensitively — GitHub hosts/paths are effectively case-insensitive
# for our purposes, and lowercasing never weakens a substring/anchor match here.
URL_LC="${URL,,}"

# ── Destructive denylist (checked FIRST; a deny wins over any allow) ────────
# Distinct destructive GitHub URLs/pages that provisioning must never reach.
# Provisioning is all create/install/configure, so none of these appear on the
# happy path — denying them has zero happy-path impact (DR-035 §2.2).
DENY_PATTERNS=(
  'danger'                          # repo/org Danger Zone (e.g. #danger-zone)
  '/billing'                        # billing / payment surfaces
  '/delete'                         # any delete endpoint
  '/transfer'                       # repo/org transfer
  'revoke'                          # token / App revoke
  '/settings/apps/[^/]+/advanced'   # GitHub App "Advanced": delete/transfer/revoke
  '/people/[^/]+/remove'            # org member removal
)
for pat in "${DENY_PATTERNS[@]}"; do
  if [[ "$URL_LC" =~ $pat ]]; then
    cat >&2 <<ERR
BLOCKED by macf-bootstrap URL guard: destructive GitHub surface.

URL: ${URL}
Matched denylisted pattern: ${pat}

Provisioning is create/install/configure only; it never visits a destructive
GitHub page (delete / transfer / billing / revoke / danger-zone / member-remove).
See DR-035 §2.2 (browser/MCP surface of the dual-surface deny).

Override (deliberate operator exception only):
  export MACF_BOOTSTRAP_SKIP_URL_GUARD=1
ERR
    exit 2
  fi
done

# ── Provisioning allowlist (default-deny: the URL must match one) ───────────
# The GitHub App manifest-flow, App-install, and OAuth/sudo/2FA gate pages the
# provisioning legitimately drives in the browser. Everything not listed here is
# blocked — the browser surface is fenced tight; `gh`/REST does the rest.
ALLOW_PATTERNS=(
  '^about:blank$'                                                   # initial blank page
  '^https://github\.com/?$'                                         # github root
  '^https://github\.com/settings/apps/new'                          # manifest create (personal)
  '^https://github\.com/organizations/[^/]+/settings/apps/new'      # manifest create (org)
  '^https://github\.com/settings/apps(/|$|\?)'                      # app list / app settings
  '^https://github\.com/organizations/[^/]+/settings/apps(/|$|\?)'  # org app list / settings
  '^https://github\.com/apps/[^/]+/installations'                   # App install flow
  '^https://github\.com/settings/installations'                     # installations mgmt (personal)
  '^https://github\.com/organizations/[^/]+/settings/installations' # installations mgmt (org)
  '^https://github\.com/login'                                      # login + /login/oauth/authorize
  '^https://github\.com/session'                                    # session POST
  '^https://github\.com/sessions/'                                  # 2FA (sessions/two-factor)
  '^https://github\.com/sudo'                                       # sudo-mode re-auth gate
)
for pat in "${ALLOW_PATTERNS[@]}"; do
  if [[ "$URL_LC" =~ $pat ]]; then
    exit 0
  fi
done

cat >&2 <<ERR
BLOCKED by macf-bootstrap URL guard: URL is outside the provisioning allowlist.

URL: ${URL}

The browser is fenced to the GitHub App manifest-flow, App-install, and
auth/sudo/2FA pages only (DR-035 §2.2 — default-deny). If this URL is genuinely
required for provisioning, add it to ALLOW_PATTERNS in this hook; for a one-off:
  export MACF_BOOTSTRAP_SKIP_URL_GUARD=1
ERR
exit 2
