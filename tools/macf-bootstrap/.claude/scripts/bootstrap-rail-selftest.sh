#!/usr/bin/env bash
#
# bootstrap-rail-selftest.sh — prove the browser URL-allowlist rail actually fires.
#
# Feeds the sibling check-bootstrap-url-allowlist.sh hook synthetic PreToolUse
# payloads and asserts it BLOCKS (exit 2) denylisted/destructive URLs and ALLOWS
# (exit 0) the provisioning URLs. This leaves positive, deterministic evidence in
# the transcript that the guard works — WITHOUT weakening it and WITHOUT driving
# the real browser. The operator asked for live proof during the first run
# (macf-automated-github-setup#1); this is the on-request self-test.
#
# It does NOT touch the guard's policy — it only invokes the guard and checks the
# verdict. Run it before a first provisioning run, or whenever you want to show the
# rail is healthy. Exit 0 = every case behaved correctly; non-zero = the rail is
# broken (a destructive URL was allowed, or a provisioning URL was blocked) — STOP.
#
# Refs: DR-035 §2.2 (browser/MCP surface); check-bootstrap-url-allowlist.sh.
set -euo pipefail

# Self-resolve our own dir so we find the sibling hook regardless of cwd / whether
# CLAUDE_PROJECT_DIR is exported (the same cwd-independence the first run needed).
_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
GUARD="${_self_dir}/check-bootstrap-url-allowlist.sh"

[ -x "$GUARD" ] || [ -f "$GUARD" ] || {
  echo "FATAL: URL-allowlist guard not found next to this script ($GUARD)." >&2
  exit 1
}

# Make sure an operator override isn't masking the rail during the self-test.
if [[ "${MACF_BOOTSTRAP_SKIP_URL_GUARD:-}" == "1" ]]; then
  echo "FATAL: MACF_BOOTSTRAP_SKIP_URL_GUARD=1 is set — the rail is bypassed, so this" >&2
  echo "       self-test would prove nothing. Unset it and re-run." >&2
  exit 1
fi

# Run the guard against a synthetic PreToolUse payload for a chrome-devtools
# navigation to <url>; echo the observed exit code.
_probe() {
  local url="$1"
  local payload
  payload="$(printf '{"tool_name":"mcp__chrome-devtools__navigate_page","tool_input":{"url":%s}}' \
    "$(printf '%s' "$url" | jq -R .)")"
  set +e
  printf '%s' "$payload" | env -u MACF_BOOTSTRAP_SKIP_URL_GUARD bash "$GUARD" >/dev/null 2>&1
  local rc=$?
  set -e
  echo "$rc"
}

fail=0

# Cases the rail MUST block (exit 2): the distinct destructive GitHub surfaces.
DENY_URLS=(
  'https://github.com/groundnuty/icsoc-2026/settings#danger-zone'
  'https://github.com/settings/apps/macf-routing/advanced'
  'https://github.com/settings/billing'
  'https://github.com/orgs/groundnuty/people/someone/remove'
)
# Cases the rail MUST allow (exit 0): the provisioning happy-path pages.
ALLOW_URLS=(
  'https://github.com/settings/apps/new'
  'https://github.com/apps/macf-code-agent/installations/new'
  'https://github.com/settings/installations/12345678'
  'https://github.com/login/oauth/authorize?client_id=x'
)

echo "── macf-bootstrap rail self-test (URL allowlist) ──"
for u in "${DENY_URLS[@]}"; do
  rc="$(_probe "$u")"
  if [[ "$rc" == "2" ]]; then
    echo "✓ BLOCKED (exit 2)  $u"
  else
    echo "✗ NOT BLOCKED (exit $rc)  $u   ← RAIL BROKEN: destructive URL slipped through"
    fail=1
  fi
done
for u in "${ALLOW_URLS[@]}"; do
  rc="$(_probe "$u")"
  if [[ "$rc" == "0" ]]; then
    echo "✓ ALLOWED (exit 0)  $u"
  else
    echo "✗ NOT ALLOWED (exit $rc)  $u   ← RAIL BROKEN: provisioning URL blocked"
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "RAIL SELF-TEST FAILED — the URL guard did not behave as designed. STOP." >&2
  exit 1
fi
echo "rail self-test PASSED — the URL allowlist blocks destructive nav + permits provisioning."
