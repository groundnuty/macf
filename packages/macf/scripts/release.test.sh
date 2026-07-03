#!/usr/bin/env bash
# release.test.sh — pure-logic unit tests for release.sh (groundnuty/macf#766):
# version_compare + changelog_has_heading. NOT wired into `make check` /
# `make test` — release.sh's mutating subcommands push/tag/publish for real,
# so they are exercised only via `--dry-run` (see the smoke check in the
# #766 PR description), never by an automated harness that could
# accidentally push/tag/publish. This script covers the two pure functions
# that don't touch git/gh/npm at all.
#
# Run manually:
#   bash packages/macf/scripts/release.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=packages/macf/scripts/release.sh
source "$SCRIPT_DIR/release.sh"

pass=0
fail=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $desc — expected [$expected] got [$actual]" >&2
  fi
}

assert_true() {
  local desc="$1"
  shift
  if "$@"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $desc (expected true)" >&2
  fi
}

assert_false() {
  local desc="$1"
  shift
  if "$@"; then
    fail=$((fail + 1))
    echo "FAIL: $desc (expected false)" >&2
  else
    pass=$((pass + 1))
  fi
}

# --- version_compare -------------------------------------------------------
assert_eq "equal versions -> 0" "0" "$(version_compare 0.2.52 0.2.52)"
assert_eq "patch bump -> 1" "1" "$(version_compare 0.2.53 0.2.52)"
assert_eq "patch behind -> -1" "-1" "$(version_compare 0.2.52 0.2.53)"
assert_eq "numeric not lexicographic (9 vs 10)" "-1" "$(version_compare 0.2.9 0.2.10)"
assert_eq "numeric not lexicographic reversed" "1" "$(version_compare 0.2.10 0.2.9)"
assert_eq "minor rollover beats patch" "1" "$(version_compare 0.3.0 0.2.99)"
assert_eq "major beats everything" "1" "$(version_compare 1.0.0 0.99.99)"

# --- changelog_has_heading --------------------------------------------------
TMP_ROOT="$(mktemp -d)"
CLEANUP_DIRS+=("$TMP_ROOT")
cat >"$TMP_ROOT/CHANGELOG.md" <<'EOF'
# Changelog

## [0.9.9] — 2026-01-01

Some notes.

## [0.9.8] — 2025-12-31

Older notes.
EOF
# shellcheck disable=SC2034  # consumed by changelog_has_heading() in the sourced release.sh, not in this file
REPO_ROOT="$TMP_ROOT"

assert_true "heading present at top for current release" changelog_has_heading "0.9.9"
assert_false "no heading at all for an unreleased version" changelog_has_heading "0.9.10"
assert_false "heading exists but NOT at the top" changelog_has_heading "0.9.8"

echo ""
echo "release.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
