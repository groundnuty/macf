#!/usr/bin/env bash
# release.test.sh — pure-logic unit tests for release.sh (groundnuty/macf#766):
# version_compare + changelog_has_heading, plus cmd_cli's --dry-run scoping
# (groundnuty/macf#1099), plus check_harness_compat (groundnuty/macf#1069).
# NOT wired into `make check` / `make test` — release.sh's mutating
# subcommands push/tag/publish for real, so the REAL-path executions here
# never get past their preconditions (they die before any git push/gh
# mutation), and the DRY-path executions are, by the script's own --dry-run
# contract, side-effect-free. The one real network surface (`gh api`
# tag-existence lookups) is stubbed via a local `gh` shell function below —
# see the #1099 section for why. The harness-compat section additionally
# depends on a real `claude` binary on PATH (it invokes the actual
# installed Claude Code to validate settings — that's the whole point);
# it self-skips with a message, rather than failing, when `claude` is
# absent, mirroring check_harness_compat's own runtime behavior.
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

# --- wait_for_npm_version (groundnuty/macf#776 — npm registry lag) ---------
# npm's registry CDN is eventually consistent: `npm view` can report the OLD
# version for a while after `npm publish` already succeeded. Every scenario
# below zeroes the backoff (MACF_RELEASE_NPM_VERIFY_BASE_SECS/_CAP_SECS=0) so
# assertions run instantly and check ATTEMPT COUNTS, never wall-clock time —
# `npm_view_version` is overridden (shell-function redefinition, same
# technique the `gh` stub below uses) to avoid any real network call.
#
# Call counting is routed through a FILE, not a plain shell variable: each
# `npm_view_version` invocation happens inside `wait_for_npm_version`'s
# `live="$(npm_view_version "$pkg")"` — a command substitution, which bash
# always runs in a SUBSHELL. A variable increment inside that subshell is
# invisible to the caller the instant the subshell exits, so a plain
# counter variable would silently read back as unchanged after every call
# (caught empirically while writing these tests — see the mutation-check
# note in the issue thread / PR description).
export MACF_RELEASE_NPM_VERIFY_BASE_SECS=0
export MACF_RELEASE_NPM_VERIFY_CAP_SECS=0
NPM_CALL_COUNTER_FILE="$(mktemp)"
CLEANUP_DIRS+=("$NPM_CALL_COUNTER_FILE")
npm_call_reset() { printf '0' >"$NPM_CALL_COUNTER_FILE"; }
npm_call_incr() {
  local n
  n=$(($(cat "$NPM_CALL_COUNTER_FILE") + 1))
  printf '%s' "$n" >"$NPM_CALL_COUNTER_FILE"
  printf '%s' "$n"
}
npm_call_count() { cat "$NPM_CALL_COUNTER_FILE"; }

# Decisive pair, part 1: the version appears on the SECOND attempt. Must
# PASS *and* say it retried — a stub that always returns 0 regardless of
# retry logic would satisfy "passes" alone (assert-the-wrong-path.md), so
# the "says it retried" + "stopped calling after the match" assertions are
# what make this decisive.
npm_view_version() {
  local n
  n="$(npm_call_incr)"
  if [ "$n" -ge 2 ]; then
    echo "1.2.3"
  else
    echo "1.2.2"
  fi
}
npm_call_reset
MACF_RELEASE_NPM_VERIFY_TRIES=5
if WFN_OUT="$(wait_for_npm_version "@groundnuty/test-pkg" "1.2.3" 2>&1)"; then
  WFN_RC=0
else
  WFN_RC=$?
fi
assert_eq "wait_for_npm_version: passes when version appears on 2nd attempt" "0" "$WFN_RC"
assert_contains "wait_for_npm_version: success-after-retry says it retried" "$WFN_OUT" "after retrying"
assert_contains "wait_for_npm_version: success-after-retry names the succeeding attempt" "$WFN_OUT" "succeeded on attempt 2/5"
assert_eq "wait_for_npm_version: stops calling npm_view_version once matched (2 calls, not 5)" "2" "$(npm_call_count)"

# Decisive pair, part 2: the version NEVER appears. Must FAIL after the
# bound, and the TERMINAL line must name the attempt count and be worded
# distinctly from the mid-retry "still retrying" line — the two must never
# be confusable (one means wait, the other means genuine failure).
npm_view_version() {
  npm_call_incr >/dev/null
  echo "0.0.0-never-published"
}
npm_call_reset
MACF_RELEASE_NPM_VERIFY_TRIES=4
if WFN_OUT="$(wait_for_npm_version "@groundnuty/test-pkg" "1.2.3" 2>&1)"; then
  WFN_RC=0
else
  WFN_RC=$?
fi
WFN_LAST_LINE="$(printf '%s\n' "$WFN_OUT" | tail -n1)"
assert_true "wait_for_npm_version: fails when version never appears" test "$WFN_RC" -ne 0
assert_contains "wait_for_npm_version: terminal line is the MISMATCH line" "$WFN_LAST_LINE" "MISMATCH"
assert_contains "wait_for_npm_version: terminal line names the attempt bound (4)" "$WFN_LAST_LINE" "still absent after 4 attempts"
assert_not_contains "wait_for_npm_version: terminal MISMATCH line is NOT worded as a mid-retry line" "$WFN_LAST_LINE" "retrying"
assert_eq "wait_for_npm_version: exactly 4 attempts made (the bound), not more" "4" "$(npm_call_count)"

# Plus: first-attempt success -> no retry noise (the common happy path must
# stay quiet).
npm_view_version() {
  npm_call_incr >/dev/null
  echo "1.2.3"
}
npm_call_reset
MACF_RELEASE_NPM_VERIFY_TRIES=8
if WFN_OUT="$(wait_for_npm_version "@groundnuty/test-pkg" "1.2.3" 2>&1)"; then
  WFN_RC=0
else
  WFN_RC=$?
fi
assert_eq "wait_for_npm_version: first-attempt match passes" "0" "$WFN_RC"
assert_not_contains "wait_for_npm_version: first-attempt match has no retry noise" "$WFN_OUT" "retrying"
assert_not_contains "wait_for_npm_version: first-attempt match does not claim it retried" "$WFN_OUT" "after retrying"
assert_eq "wait_for_npm_version: exactly ONE npm_view_version call on first-attempt match" "1" "$(npm_call_count)"

# Plus: the bound is respected — asserted via ELAPSED ATTEMPTS (a call
# counter), never wall-clock. A never-matching stub must invoke
# npm_view_version EXACTLY max_tries times, no more (an off-by-one or
# unbounded loop would call it more; see the mutation-check note at the
# bottom of this file for the "make it unbounded" direction, which this
# same assertion is the one that would catch it).
npm_view_version() {
  npm_call_incr >/dev/null
  echo "0.0.0-never-published"
}
npm_call_reset
MACF_RELEASE_NPM_VERIFY_TRIES=6
wait_for_npm_version "@groundnuty/test-pkg" "1.2.3" >/dev/null 2>&1 || true
assert_eq "wait_for_npm_version: bound respected — exactly 6 attempts, not more" "6" "$(npm_call_count)"

unset MACF_RELEASE_NPM_VERIFY_TRIES MACF_RELEASE_NPM_VERIFY_BASE_SECS MACF_RELEASE_NPM_VERIFY_CAP_SECS
unset -f npm_view_version

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

# --- cmd_verify wiring (groundnuty/macf#776) --------------------------------
# End-to-end check that cmd_verify actually DELEGATES to wait_for_npm_version
# (rather than the unit tests above exercising a function nothing calls) —
# extends the existing `gh` stub with the run-polling URL shapes cmd_verify
# needs (workflow-run lookup + status/conclusion), and reuses the
# npm_view_version override technique for a package that lags by one
# attempt. `make -f dev.mk release-verify` is a thin wrapper straight to
# `release.sh verify` (see dev.mk's RELEASE_SH), so exercising cmd_verify
# directly here IS exercising the make-target path — no separate Make-layer
# test needed.
gh() {
  if [ "$1" = "api" ]; then
    case "$2" in
      */git/ref/tags/*)
        [ "$STUB_TAG_EXISTS" = "1" ] && return 0 || return 1
        ;;
      *actions/workflows/publish.yml/runs*)
        echo "${STUB_RUN_ID:-424242}"
        return 0
        ;;
      *actions/runs/*)
        case "$4" in
          *.status*) echo "${STUB_RUN_STATUS:-completed}" ;;
          *.conclusion*) echo "${STUB_RUN_CONCLUSION:-success}" ;;
        esac
        return 0
        ;;
    esac
  fi
  return 1
}

MACF_RELEASE_NPM_VERIFY_BASE_SECS=0
MACF_RELEASE_NPM_VERIFY_CAP_SECS=0
export MACF_RELEASE_NPM_VERIFY_BASE_SECS MACF_RELEASE_NPM_VERIFY_CAP_SECS

# Happy path: publish run green, two packages live on the first check, the
# third lags by one attempt — cmd_verify must still succeed overall AND
# surface that one package needed a retry. Reuses the file-backed
# npm_call_incr/npm_call_reset helpers defined above (a plain variable
# would hit the same subshell-scoping trap documented there).
npm_view_version() {
  case "$1" in
    "@groundnuty/macf-channel-server")
      local n
      n="$(npm_call_incr)"
      if [ "$n" -ge 2 ]; then
        echo "9.9.9"
      else
        echo "9.9.8"
      fi
      ;;
    *) echo "9.9.9" ;;
  esac
}
npm_call_reset
if CV_OUT="$(cmd_verify "9.9.9" 2>&1)"; then
  CV_RC=0
else
  CV_RC=$?
fi
assert_eq "cmd_verify: succeeds when publish is green and npm lag resolves within budget" "0" "$CV_RC"
assert_contains "cmd_verify: reports the lagging package as retried" "$CV_OUT" "after retrying"
assert_contains "cmd_verify: reports the two non-lagging packages OK on the first try" "$CV_OUT" "OK @groundnuty/macf@9.9.9 live on npm"
assert_contains "cmd_verify: final success line unchanged" "$CV_OUT" "release v9.9.9 fully verified: publish run green + all 3 packages live on npm at 9.9.9"

# Genuine failure: one package never appears even after the full retry
# budget — cmd_verify must still die (non-zero), and the die message must
# not claim the mismatch was mere registry lag.
npm_view_version() {
  case "$1" in
    "@groundnuty/macf-channel-server") echo "0.0.0-orphaned" ;;
    *) echo "9.9.9" ;;
  esac
}
# shellcheck disable=SC2034  # consumed by wait_for_npm_version() in the sourced release.sh, not in this file
MACF_RELEASE_NPM_VERIFY_TRIES=2
if CV_FAIL_OUT="$(cmd_verify "9.9.9" 2>&1)"; then
  CV_FAIL_RC=0
else
  CV_FAIL_RC=$?
fi
assert_true "cmd_verify: dies when a package never appears within the bound" test "$CV_FAIL_RC" -ne 0
assert_contains "cmd_verify: die message names it a genuine miss, not lag" "$CV_FAIL_OUT" "not registry lag"
assert_contains "cmd_verify: MISMATCH line names the still-missing package" "$CV_FAIL_OUT" "MISMATCH: @groundnuty/macf-channel-server"

unset MACF_RELEASE_NPM_VERIFY_TRIES MACF_RELEASE_NPM_VERIFY_BASE_SECS MACF_RELEASE_NPM_VERIFY_CAP_SECS
unset -f npm_view_version npm_call_reset npm_call_incr npm_call_count

# --- check_harness_compat (groundnuty/macf#1069) ---------------------------
# Decisive per assert-the-wrong-path.md: a tree WITH the drift must fail the
# gate, a tree WITHOUT it must pass — both directions asserted below, both
# outputs printed at the end so a reader can see the real diagnostic text,
# not just the pass/fail verdict. Uses the REAL, currently-installed `claude`
# binary for the permission-rule-grammar sub-check (the whole point is
# exercising Claude Code's actual, current grammar, not a guess at it); a
# fixture with a `Write(<path>)` deny rule reproduces the exact
# groundnuty/macf#1067 shape (a rule Claude Code accepts syntactically but
# never enforces). The launcher-flag sub-check additionally needs a
# NEGATIVE case (the real binary currently accepts our flag, so there is no
# way to drive it into rejecting one) — a tiny stub `claude` EXECUTABLE
# (not a shell function: check_harness_compat wraps calls in `timeout`,
# which execs by PATH lookup and cannot see shell functions) simulates a
# harness that has removed the flag.
if command -v claude >/dev/null 2>&1; then
  HC_FIXTURE="$(mktemp -d)"
  CLEANUP_DIRS+=("$HC_FIXTURE")
  mkdir -p "$HC_FIXTURE/.claude"

  # Sub-check A (real claude binary): permission-rule grammar. -----------
  # Clean settings.json (Edit(path), the correct form) must pass.
  cat >"$HC_FIXTURE/.claude/settings.json" <<'EOF'
{
  "permissions": {
    "allow": ["Bash(*)", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"],
    "deny": ["Bash(sudo *)", "Edit(~/.ssh/**)"]
  }
}
EOF
  if HC_CLEAN_OUT="$(check_harness_compat "$HC_FIXTURE" 2>&1)"; then
    HC_CLEAN_RC=0
  else
    HC_CLEAN_RC=$?
  fi
  assert_eq "harness-compat: clean settings.json (Edit(path)) passes" "0" "$HC_CLEAN_RC"
  assert_eq "harness-compat: clean settings.json produces no diagnostic output" "" "$HC_CLEAN_OUT"

  # Drifted settings.json — the #1067 shape (Write(path) instead of
  # Edit(path)): syntactically valid, silently never enforced.
  cat >"$HC_FIXTURE/.claude/settings.json" <<'EOF'
{
  "permissions": {
    "allow": ["Bash(*)", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"],
    "deny": ["Bash(sudo *)", "Write(~/.ssh/**)"]
  }
}
EOF
  if HC_DRIFT_OUT="$(check_harness_compat "$HC_FIXTURE" 2>&1)"; then
    HC_DRIFT_RC=0
  else
    HC_DRIFT_RC=$?
  fi
  assert_true "harness-compat: drifted settings.json (Write(path) deny) fails the gate" test "$HC_DRIFT_RC" -ne 0
  assert_contains "harness-compat: drift diagnostic names the exact rejected rule" "$HC_DRIFT_OUT" "Write(~/.ssh/**) is not matched by file permission checks"
  assert_contains "harness-compat: drift diagnostic carries Claude Code's own suggested fix" "$HC_DRIFT_OUT" "Use Edit(~/.ssh/**) instead"

  # Restore a clean settings.json before sub-check B (isolates the two
  # sub-checks — sub-check B's fixture also carries a claude.sh).
  cat >"$HC_FIXTURE/.claude/settings.json" <<'EOF'
{
  "permissions": {
    "allow": ["Bash(*)", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"],
    "deny": ["Bash(sudo *)", "Edit(~/.ssh/**)"]
  }
}
EOF
  cat >"$HC_FIXTURE/claude.sh" <<'EOF'
#!/usr/bin/env bash
MACF_CHANNELS_ARGS="--dangerously-load-development-channels server:macf-agent"
EOF

  # Sub-check B (real claude binary): the accepted-flag path is exit 0 with
  # a real claude.sh present too (proves the flag doesn't itself introduce
  # a false positive).
  if HC_FLAG_OK_OUT="$(check_harness_compat "$HC_FIXTURE" 2>&1)"; then
    HC_FLAG_OK_RC=0
  else
    HC_FLAG_OK_RC=$?
  fi
  assert_eq "harness-compat: accepted launcher flag + clean settings passes" "0" "$HC_FLAG_OK_RC"

  # Sub-check B, negative direction, + the advisor-flagged edge cases below:
  # a multi-mode stub `claude`, selected via $STUB_MODE, drives scenarios
  # the REAL currently-installed binary cannot be driven into (it doesn't
  # currently reject our flag, doesn't hang, and has no reproducible
  # ancestor-.mcp.json defect to point at on demand).
  HC_STUB_DIR="$(mktemp -d)"
  CLEANUP_DIRS+=("$HC_STUB_DIR")
  cat >"$HC_STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  --version) echo "99.0.0 (Claude Code, STUBBED for release.test.sh)"; exit 0 ;;
  doctor)
    case "${STUB_MODE:-}" in
      doctor_ambient)
        # An "Invalid settings" finding whose path is OUTSIDE the workspace
        # under test — simulates `claude doctor` walking up from cwd and
        # reporting on an unrelated ancestor .mcp.json/settings.json.
        printf 'Invalid settings\n- %s/.mcp.json: MCP config is not a regular file or exceeds 2097152 bytes: %s/.mcp.json\n\nRemote Control\nControl this session from claude.ai/code or the Claude mobile app\n' \
          "${STUB_AMBIENT_PATH:-/nowhere}" "${STUB_AMBIENT_PATH:-/nowhere}"
        exit 0
        ;;
      doctor_inscope)
        # An "Invalid settings" finding whose path IS inside the workspace
        # under test — a genuine, in-scope structural rejection. (Plain
        # colon separator here, not the real ">" glyph claude doctor uses —
        # irrelevant to the substring-match logic under test.)
        printf 'Invalid settings\n- %s/.claude/settings.json: permissions.allow: Invalid permission rule "mcp__*" was skipped: simulated for release.test.sh.\n\nRemote Control\nControl this session from claude.ai/code or the Claude mobile app\n' \
          "${STUB_WORKSPACE_DIR:-/nowhere}"
        exit 0
        ;;
      *) echo "No installation issues found."; exit 0 ;;
    esac
    ;;
  -p)
    shift
    case "${STUB_MODE:-}" in
      flag_reject)
        for a in "$@"; do
          if [ "$a" = "--dangerously-load-development-channels" ]; then
            echo "error: unknown option '--dangerously-load-development-channels'" >&2
            exit 1
          fi
        done
        echo "Error: Input must be provided either through stdin or as a prompt argument when using --print"
        exit 1
        ;;
      both_defects)
        # A permission-rule rejection line PLUS a non-terminal ending (a
        # simulated crash) — the exact composite the elif-vs-independent-if
        # fix targets: both signals must be reported, not just one.
        echo "Permission deny rule (.claude/settings.json): Write(~/.ssh/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(~/.ssh/**) instead (Edit rules cover all file-editing tools)."
        echo "simulated crash: unexpected internal error" >&2
        exit 1
        ;;
      timeout)
        # Outlives the short test-configured timeout — never reaches its
        # own echo/exit; `timeout` kills it first.
        sleep 5
        echo "Error: Input must be provided either through stdin or as a prompt argument when using --print"
        exit 1
        ;;
      *)
        echo "Error: Input must be provided either through stdin or as a prompt argument when using --print"
        exit 1
        ;;
    esac
    ;;
esac
exit 0
STUB
  chmod +x "$HC_STUB_DIR/claude"

  if HC_FLAG_REJECTED_OUT="$(PATH="$HC_STUB_DIR:$PATH" STUB_MODE=flag_reject check_harness_compat "$HC_FIXTURE" 2>&1)"; then
    HC_FLAG_REJECTED_RC=0
  else
    HC_FLAG_REJECTED_RC=$?
  fi
  assert_true "harness-compat: a harness that rejects the launcher flag fails the gate" test "$HC_FLAG_REJECTED_RC" -ne 0
  assert_contains "harness-compat: rejected-flag diagnostic names the flag" "$HC_FLAG_REJECTED_OUT" "unknown option '--dangerously-load-development-channels'"

  # --- Advisor-flagged edge case 1: BOTH defects present in one -p output
  # must produce BOTH diagnoses (not just the first-matched one). Before
  # the elif->independent-if fix, this scenario silently dropped the
  # permission-rule diagnosis and misreported it as a launch-invocation
  # rejection instead.
  if HC_BOTH_OUT="$(PATH="$HC_STUB_DIR:$PATH" STUB_MODE=both_defects check_harness_compat "$HC_FIXTURE" 2>&1)"; then
    HC_BOTH_RC=0
  else
    HC_BOTH_RC=$?
  fi
  assert_true "harness-compat: a composite (permission-rule + non-terminal exit) still fails the gate" test "$HC_BOTH_RC" -ne 0
  assert_contains "harness-compat: composite case reports the permission-rule diagnosis" "$HC_BOTH_OUT" "Permission deny rule (.claude/settings.json): Write(~/.ssh/**) is not matched by file permission checks"
  assert_contains "harness-compat: composite case ALSO reports the non-terminal-state diagnosis" "$HC_BOTH_OUT" "did not reach the expected 'no prompt given' terminal state"

  # --- Advisor-flagged edge case 2: a genuine timeout is a NOTE, never a
  # FATAL — checked via timeout's own exit code 124, not inferred from
  # output emptiness (a killed process can still have written partial
  # output first). MACF_HARNESS_CHECK_P_TIMEOUT_SECS=2 keeps this fast;
  # the stub sleeps 5s so `timeout 2` genuinely kills it.
  if HC_TIMEOUT_OUT="$(PATH="$HC_STUB_DIR:$PATH" STUB_MODE=timeout MACF_HARNESS_CHECK_P_TIMEOUT_SECS=2 check_harness_compat "$HC_FIXTURE" 2>&1)"; then
    HC_TIMEOUT_RC=0
  else
    HC_TIMEOUT_RC=$?
  fi
  assert_eq "harness-compat: a genuine claude -p timeout does NOT fail the gate" "0" "$HC_TIMEOUT_RC"
  assert_contains "harness-compat: timeout is reported as a non-blocking NOTE" "$HC_TIMEOUT_OUT" "NOTE (non-blocking): 'claude -p' timed out"

  # --- Advisor-flagged edge case 3: `claude doctor` findings about a path
  # OUTSIDE the workspace under test (ambient/ancestor state) must NOT fail
  # the gate; findings INSIDE the workspace must.
  if HC_DOCTOR_AMBIENT_OUT="$(PATH="$HC_STUB_DIR:$PATH" STUB_MODE=doctor_ambient STUB_AMBIENT_PATH="/some/unrelated/ancestor/dir" check_harness_compat "$HC_FIXTURE" 2>&1)"; then
    HC_DOCTOR_AMBIENT_RC=0
  else
    HC_DOCTOR_AMBIENT_RC=$?
  fi
  assert_eq "harness-compat: an out-of-scope (ambient) doctor finding does NOT fail the gate" "0" "$HC_DOCTOR_AMBIENT_RC"
  assert_contains "harness-compat: ambient finding is reported as a non-blocking NOTE" "$HC_DOCTOR_AMBIENT_OUT" "not this release's problem"

  if HC_DOCTOR_INSCOPE_OUT="$(PATH="$HC_STUB_DIR:$PATH" STUB_MODE=doctor_inscope STUB_WORKSPACE_DIR="$HC_FIXTURE" check_harness_compat "$HC_FIXTURE" 2>&1)"; then
    HC_DOCTOR_INSCOPE_RC=0
  else
    HC_DOCTOR_INSCOPE_RC=$?
  fi
  assert_true "harness-compat: an in-scope doctor finding DOES fail the gate" test "$HC_DOCTOR_INSCOPE_RC" -ne 0
  assert_contains "harness-compat: in-scope finding names the workspace path" "$HC_DOCTOR_INSCOPE_OUT" "$HC_FIXTURE"

  echo ""
  echo "--- check_harness_compat: clean settings.json (expect no output, rc=0) ---"
  echo "$HC_CLEAN_OUT"
  echo "--- check_harness_compat: drifted settings.json — Write(path) deny (expect rc!=0) ---"
  echo "$HC_DRIFT_OUT"
  echo "--- check_harness_compat: launcher flag rejected by a stubbed harness (expect rc!=0) ---"
  echo "$HC_FLAG_REJECTED_OUT"
  echo "--- check_harness_compat: BOTH a permission-rule rejection AND a non-terminal exit (expect rc!=0, BOTH messages) ---"
  echo "$HC_BOTH_OUT"
  echo "--- check_harness_compat: claude -p genuinely times out (expect rc=0, NOTE only) ---"
  echo "$HC_TIMEOUT_OUT"
  echo "--- check_harness_compat: doctor finding OUTSIDE the workspace (expect rc=0, NOTE only) ---"
  echo "$HC_DOCTOR_AMBIENT_OUT"
  echo "--- check_harness_compat: doctor finding INSIDE the workspace (expect rc!=0) ---"
  echo "$HC_DOCTOR_INSCOPE_OUT"
else
  echo "SKIP: 'claude' not found on PATH — skipping check_harness_compat tests (nothing installed to verify against)" >&2
fi

echo ""
echo "release.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
