#!/usr/bin/env bash
# release.test.sh — pure-logic unit tests for release.sh (groundnuty/macf#766):
# version_compare + changelog_has_heading, plus cmd_cli's --dry-run scoping
# (groundnuty/macf#1099). NOT wired into `make check` / `make test` —
# release.sh's mutating subcommands push/tag/publish for real, so the
# REAL-path executions here never get past their preconditions (they die
# before any git push/gh mutation), and the DRY-path executions are, by the
# script's own --dry-run contract, side-effect-free. The one real network
# surface (`gh api` tag-existence lookups) is stubbed via a local `gh`
# shell function below — see the #1099 section for why.
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

# assert_contains DESC HAYSTACK NEEDLE — content assertion (not just exit
# code) per assert-the-wrong-path.md: a version of cmd_cli that silently
# skipped its preview entirely would also exit 0, so exit-code-only checks
# below are paired with a check that the specific preview text was actually
# produced.
assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $desc — expected to find [$needle]" >&2
    echo "--- actual output ---" >&2
    echo "$haystack" >&2
  fi
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    fail=$((fail + 1))
    echo "FAIL: $desc — did NOT expect to find [$needle]" >&2
    echo "--- actual output ---" >&2
    echo "$haystack" >&2
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

# --- cmd_cli --dry-run scoping (groundnuty/macf#1099) -----------------------
# Fixture: a real (tiny) git repo standing in for the monorepo, on `main`,
# with one commit at "current" version 0.2.1. Every scenario below then
# leaves the tree dirty in the specific shape a dry `all` chain produces —
# an authored, uncommitted `## [<version>]` CHANGELOG heading and nothing
# else — because `bump`'s dry branch (correctly) never commits it. TEST_VER
# is deliberately unreleased/fictional; no network call this file makes could
# ever publish anything even if the stub below were bypassed.
TMP_CLI="$(mktemp -d)"
CLEANUP_DIRS+=("$TMP_CLI")
TEST_VER="9.9.9"

git -C "$TMP_CLI" init -q -b main
git -C "$TMP_CLI" config user.email "test@example.invalid"
git -C "$TMP_CLI" config user.name "release.test.sh"
mkdir -p "$TMP_CLI/packages/macf-core"
cat >"$TMP_CLI/packages/macf-core/package.json" <<'EOF'
{
  "name": "@groundnuty/macf-core",
  "version": "0.2.1"
}
EOF
cat >"$TMP_CLI/CHANGELOG.md" <<'EOF'
# Changelog

## [0.2.1] — 2026-01-01

Notes.
EOF
git -C "$TMP_CLI" add -A
git -C "$TMP_CLI" commit -q -m "chore: fixture at 0.2.1"

# `gh` stub — the only real network surface `cli_dry_preview`/`cmd_cli`
# reach for (the tag-existence lookup); ensure_gh_token is bypassed below by
# pre-exporting an already-well-shaped token, so this is the sole call site
# exercised. Controlled by $STUB_TAG_EXISTS so one test can simulate the
# idempotent-guard case without a real `v9.9.9` tag existing anywhere.
STUB_TAG_EXISTS=0
gh() {
  if [ "$1" = "api" ]; then
    case "$2" in
      */git/ref/tags/*)
        [ "$STUB_TAG_EXISTS" = "1" ] && return 0 || return 1
        ;;
    esac
  fi
  return 1
}

GH_TOKEN="ghs_teststub0000000000000000"
export GH_TOKEN
REPO_ROOT="$TMP_CLI"

# run_cmd_cli VERSION DRY_RUN_VALUE — invokes cmd_cli inside a command
# substitution (which bash always subshells), so cmd_cli's own internal `cd
# "$REPO_ROOT"` can never leak into this script's cwd. Sets $LAST_OUTPUT /
# $LAST_RC. The `if` form is required to capture a non-zero exit without
# tripping this script's own `set -e`.
run_cmd_cli() {
  local version="$1"
  DRY_RUN="$2"
  if LAST_OUTPUT="$(cmd_cli "$version" 2>&1)"; then
    LAST_RC=0
  else
    LAST_RC=$?
  fi
}

# Scenario A — CHANGELOG-only dirty (exactly what a dry `all` leaves).
# Author the new heading, uncommitted — nothing else touched.
cat >"$TMP_CLI/CHANGELOG.md" <<'EOF'
# Changelog

## [9.9.9] — 2026-01-02

New notes for the dry-run test fixture.

## [0.2.1] — 2026-01-01

Notes.
EOF

run_cmd_cli "$TEST_VER" 1
assert_eq "dry cli on changelog-only-dirty tree: exit 0" "0" "$LAST_RC"
assert_contains "dry cli reaches its push preview line" "$LAST_OUTPUT" "would push"
assert_contains "dry cli reaches its tag preview line" "$LAST_OUTPUT" "would tag"
assert_not_contains "dry cli does NOT warn on the expected changelog-only artifact" "$LAST_OUTPUT" "would block the real 'cli' step until committed"

# Scenario B — genuinely dirty tree (an UNRELATED file on top of the
# changelog artifact). Must still preview (exit 0) AND say the real run
# would be blocked — advisory, not an abort.
echo "unrelated scratch content" >"$TMP_CLI/unrelated-file.txt"

run_cmd_cli "$TEST_VER" 1
assert_eq "dry cli on genuinely-dirty tree: still exit 0" "0" "$LAST_RC"
assert_contains "dry cli warns that the real run would be blocked" "$LAST_OUTPUT" "this would block the real 'cli' step"
assert_contains "dry cli still reaches its push preview line despite the warning" "$LAST_OUTPUT" "would push"
assert_contains "dry cli still reaches its tag preview line despite the warning" "$LAST_OUTPUT" "would tag"

rm -f "$TMP_CLI/unrelated-file.txt"

# Scenario C — tag already exists (idempotent guard): still advisory-only
# under --dry-run, still reaches the preview lines.
STUB_TAG_EXISTS=1
run_cmd_cli "$TEST_VER" 1
assert_eq "dry cli when tag already exists: still exit 0" "0" "$LAST_RC"
assert_contains "dry cli warns tag already exists would block real run" "$LAST_OUTPUT" "already exists on"
assert_contains "dry cli still reaches its preview lines with tag-exists warning" "$LAST_OUTPUT" "would push"
STUB_TAG_EXISTS=0

# Scenario D — the REAL (non-dry) path is UNCHANGED: same dirty tree still
# aborts, with the same message, before anything is pushed.
run_cmd_cli "$TEST_VER" 0
assert_true "real cli path aborts on a dirty tree (nonzero exit)" test "$LAST_RC" -ne 0
assert_contains "real cli path's abort message is unchanged" "$LAST_OUTPUT" "working tree not clean — commit or stash before release-cli"

echo ""
echo "release.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
