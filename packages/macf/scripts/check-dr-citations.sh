#!/usr/bin/env bash
#
# check-dr-citations.sh — STATE check for the DR-citation convention
# (groundnuty/macf#998): every `**Asserted by:**` line in
# `design/decisions/*.md` must resolve to a test that actually exists.
#
# Convention (ratified on #998): when a DR amendment's Mechanism section
# names an artifact the tool must produce, it carries a citation in the
# exact form:
#
#     **Asserted by:** `<path/to/file>.test.ts` → `"<exact test name>"`
#
# This script is the cheap half of the enforcement pair: it scans every
# citation line and verifies (a) the cited test FILE exists, and (b) the
# cited test NAME appears in that file. It catches a citation gone STALE —
# the test was renamed or moved and the citation line still points at the
# old location.
#
# It does NOT catch a citation being DELETED outright (a removed line
# leaves nothing here to check against) — that erosion mode is the sibling
# script's job: check-dr-citations-diff.sh. Ship both together; a state
# check alone is exactly the gap #998 exists to close (see the issue
# thread: "a deleted citation looks exactly like an amendment that never
# needed one").
#
# Zero citations anywhere is NOT a failure — the convention is
# self-limiting by design (most amendments never need one). A MALFORMED
# citation line — matches the `**Asserted by:**` marker but not the full
# expected shape — DOES fail, loudly, per this repo's most-catalogued
# defect class ("a checker that silently passes malformed input").
#
# Usage:
#   check-dr-citations.sh [REPO_ROOT]
#     REPO_ROOT defaults to the current working directory. No git
#     dependency — this is a plain filesystem scan, so it also works
#     against a bare checkout or a test fixture directory.
#
# Exit: 0 = all citations resolve (or none exist). 1 = at least one
# citation is stale or malformed (see stderr for specifics).
#
# Repo-local to groundnuty/macf — NOT distributed to consumer fleets (they
# don't carry design/decisions/*.md). Wired into `.github/workflows/ci.yml`
# on every pull_request touching design/decisions/**.
#
# Refs: groundnuty/macf#998 (convention + this enforcement), DR-022
# Amendment P (the amendment whose half-implementation motivated the rule).
set -euo pipefail

REPO_ROOT="${1:-.}"
cd "$REPO_ROOT"

DR_DIR="design/decisions"
FAIL=0
CITATION_COUNT=0

# Non-anchored on purpose — a citation line may carry leading list/quote
# markup before the marker. Captures: 1 = test file path, 2 = exact test
# name (the string between the inner double quotes).
CITATION_RE='\*\*Asserted by:\*\*[[:space:]]+`([^`]+)`[[:space:]]+→[[:space:]]+`"([^"]*)"`'

if [[ ! -d "$DR_DIR" ]]; then
  echo "check-dr-citations.sh: no $DR_DIR directory under $REPO_ROOT — nothing to check."
  exit 0
fi

shopt -s nullglob
DR_FILES=("$DR_DIR"/*.md)
shopt -u nullglob

for file in "${DR_FILES[@]}"; do
  # grep -n exits 1 on no-match; that's a legitimate "no citations in this
  # file" outcome here, not a script error — don't let set -e kill the loop.
  matches="$(grep -n '\*\*Asserted by:\*\*' "$file" || true)"
  [[ -z "$matches" ]] && continue

  while IFS=':' read -r linenum content; do
    [[ -z "$linenum" ]] && continue
    CITATION_COUNT=$((CITATION_COUNT + 1))

    if [[ "$content" =~ $CITATION_RE ]]; then
      test_path="${BASH_REMATCH[1]}"
      test_name="${BASH_REMATCH[2]}"

      if [[ ! -f "$test_path" ]]; then
        echo "::error::${file}:${linenum}: Asserted-by citation names a test file that does not exist: ${test_path}" >&2
        echo "::error::  citation: ${content}" >&2
        FAIL=1
        continue
      fi

      if ! grep -qF -- "$test_name" "$test_path"; then
        echo "::error::${file}:${linenum}: Asserted-by citation names a test that does not exist in ${test_path}: \"${test_name}\"" >&2
        echo "::error::  citation: ${content}" >&2
        FAIL=1
      fi
    else
      echo "::error::${file}:${linenum}: malformed **Asserted by:** citation — expected exactly:" >&2
      echo '::error::  **Asserted by:** `<path/to/file>.test.ts` → `"<exact test name>"`' >&2
      echo "::error::  got: ${content}" >&2
      FAIL=1
    fi
  done <<<"$matches"
done

if [[ "$FAIL" -ne 0 ]]; then
  echo "::error::check-dr-citations.sh: DR citation state check FAILED — see above (${CITATION_COUNT} citation(s) scanned)." >&2
  exit 1
fi

echo "check-dr-citations.sh: DR citation state check passed (${CITATION_COUNT} citation(s) scanned under ${DR_DIR})."
