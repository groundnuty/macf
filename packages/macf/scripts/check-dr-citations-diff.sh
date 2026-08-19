#!/usr/bin/env bash
#
# check-dr-citations-diff.sh — DIFF check for the DR-citation convention
# (groundnuty/macf#998): fails when a `**Asserted by:**` citation line is
# REMOVED from a design/decisions/*.md file while the amendment it belonged
# to survives.
#
# This is the erosion half of the enforcement pair. check-dr-citations.sh
# (the state check) verifies every EXISTING citation resolves to a real
# test — but a state check, by construction, has nothing to say about a
# citation that's simply gone: "a deleted citation looks exactly like an
# amendment that never needed one" (the observation that motivated this
# script on #998). Only the DIFF carries the information a state check
# can't see.
#
# Semantics (ruled on #998 — do not re-derive):
#   - Removing an entire amendment (heading + body, citation included) is a
#     LEGITIMATE edit — it does not fail.
#   - Removing ONLY the citation line, while its amendment's heading still
#     exists in the file, FAILS. That's the erosion this script exists to
#     catch.
#   - A citation MAY MOVE between amendments in the same file (re-pointed,
#     or the DR reorganized) — legitimate, does not fail. Detected simply:
#     if the citation's exact text is still present ANYWHERE in the file,
#     it wasn't removed.
#   - Zero citations anywhere is not a failure.
#   - Both this script and check-dr-citations.sh HARD-FAIL (non-zero exit).
#     This convention exists because a soft signal went unnoticed for eight
#     weeks; a warning would repeat that mistake.
#
# Deliberately carries NO list of "amendments that should have a citation."
# Such a list would be hand-maintained prose asserting a fact about
# documents — the exact disease #998 exists to avoid. Everything here is
# derived from the diff between BASE_REF and HEAD_REF: for each removed
# citation line, walk backward (in the BASE version of the file) to the
# nearest preceding line that looks like an amendment heading
# (`^#+ Amendment...`), then check whether that exact heading line is still
# present anywhere in the HEAD version of the file. Present -> the
# amendment survives -> FAIL. Absent -> the amendment itself was removed
# -> legitimate, no fail.
#
# Usage:
#   check-dr-citations-diff.sh <base-ref> [<head-ref>]
#     head-ref defaults to HEAD. Must be run inside a git checkout with
#     both refs reachable (CI: actions/checkout with fetch-depth: 0).
#
# Exit: 0 = no citation was stripped out from under a surviving amendment.
# 1 = at least one was (see stderr for the file/heading/citation).
#
# Repo-local to groundnuty/macf — NOT distributed to consumer fleets.
# Wired into `.github/workflows/ci.yml` on every pull_request touching
# design/decisions/**, where github.event.pull_request.{base,head}.sha
# supply the two refs.
#
# Refs: groundnuty/macf#998 (convention + this enforcement), DR-022
# Amendment P (the amendment whose half-implementation motivated the rule).
set -euo pipefail

BASE_REF="${1:-}"
HEAD_REF="${2:-HEAD}"

if [[ -z "$BASE_REF" ]]; then
  echo "Usage: check-dr-citations-diff.sh <base-ref> [<head-ref>]" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

DR_PATHSPEC='design/decisions/*.md'
FAIL=0

# extract_citation_rows — reads a file's content on stdin, emits one TSV
# row per **Asserted by:** line: "<line number>\t<trimmed line>\t<trimmed
# enclosing Amendment heading, or empty>". The heading tracked is simply
# the last line seen so far that looks like an amendment heading — a
# single forward pass that is exactly "walk backward to the nearest
# preceding heading" computed incrementally.
#
# `#+` (one-or-more), not `{1,6}` — avoids relying on ERE interval-
# expression support, which isn't universal across awk implementations.
# The `([^a-zA-Z]|$)` boundary (instead of `\b`, a GNU extension awk may
# lack) excludes the plural section heading "## Amendments post-review"
# while still matching "## Amendment A", "### Amendment P — ...", and the
# unlabelled "## Amendment (2026-06-28, ...) — ..." form some DRs use.
extract_citation_rows() {
  awk '
    {
      trimmed = $0
      gsub(/^[ \t]+/, "", trimmed)
      gsub(/[ \t]+$/, "", trimmed)
      if (trimmed ~ /^#+[ \t]+Amendment([^a-zA-Z]|$)/) {
        heading = trimmed
      }
      if (index(trimmed, "**Asserted by:**") > 0) {
        print NR "\t" trimmed "\t" heading
      }
    }
  '
}

mapfile -t CHANGED_FILES < <(git diff --name-only "${BASE_REF}...${HEAD_REF}" -- "$DR_PATHSPEC" || true)

if [[ "${#CHANGED_FILES[@]}" -eq 0 ]]; then
  echo "check-dr-citations-diff.sh: no ${DR_PATHSPEC} changed between ${BASE_REF}...${HEAD_REF} — nothing to check."
  exit 0
fi

for file in "${CHANGED_FILES[@]}"; do
  base_content="$(git show "${BASE_REF}:${file}" 2>/dev/null || true)"
  head_content="$(git show "${HEAD_REF}:${file}" 2>/dev/null || true)"

  # New file (no base version) -> nothing could have been removed.
  [[ -z "$base_content" ]] && continue
  # Deleted file (no head version) -> whole-file removal, not erosion; every
  # citation + amendment in it went together.
  [[ -z "$head_content" ]] && continue

  base_rows="$(printf '%s\n' "$base_content" | extract_citation_rows)"
  [[ -z "$base_rows" ]] && continue

  while IFS=$'\t' read -r linenum citation heading; do
    [[ -z "$linenum" ]] && continue

    # Still present anywhere in the head file (possibly under a different
    # amendment)? That's a legitimate move, not a removal.
    if printf '%s\n' "$head_content" | grep -qF -- "$citation"; then
      continue
    fi

    if [[ -z "$heading" ]]; then
      echo "::error::${file}: line ${linenum}: an **Asserted by:** citation was removed, and no enclosing 'Amendment' heading could be found in the base version to check survival against — treating this as a failure rather than silently passing an ambiguous removal." >&2
      echo "::error::  removed citation: ${citation}" >&2
      FAIL=1
      continue
    fi

    if printf '%s\n' "$head_content" | grep -qF -- "$heading"; then
      echo "::error::${file}: an **Asserted by:** citation was removed while its amendment survives (erosion — see groundnuty/macf#998)." >&2
      echo "::error::  amendment heading: ${heading}" >&2
      echo "::error::  removed citation (was line ${linenum} in ${BASE_REF}): ${citation}" >&2
      FAIL=1
    fi
    # else: the amendment heading is also gone from HEAD -> the whole
    # amendment was removed -> legitimate, no failure for this citation.
  done <<<"$base_rows"
done

if [[ "$FAIL" -ne 0 ]]; then
  echo "::error::check-dr-citations-diff.sh: DR citation diff check FAILED — see above." >&2
  exit 1
fi

echo "check-dr-citations-diff.sh: DR citation diff check passed (${BASE_REF}...${HEAD_REF})."
