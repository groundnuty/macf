#!/usr/bin/env bash
#
# check-close-reference.sh — Claude Code PreToolUse hook (groundnuty/macf#1394)
# that warns, at the moment a `gh issue comment` / `gh pr comment` body is
# about to post, when it references another issue ONLY inside backticks —
# a shape that is invisible to check-close-and-ping.sh (#1385).
#
# WHY: GitHub does not autolink a `#N` reference that sits inside a code
# span (single backtick) or a fenced code block (triple backtick), so no
# `cross-referenced` timeline event is created for it. check-close-and-ping.sh
# enumerates INBOUND `cross-referenced` events on the issue being closed to
# find still-open waiters — a backticked reference simply never produces the
# event it depends on, so the waiter/blocker edge silently never arms.
# Measured against groundnuty/macf#1393: a reference written as
# `` `groundnuty/macf#1393` `` (backticked) produced 0 inbound cross-refs;
# the identical reference written bare produced 1, within 25s. Devops hit
# this recording a real gate (macf-devops-toolkit#203 on #1393) — precisely
# because the fleet backticks handles by rule (mention-routing-hygiene.md
# §5) and, by habit, backticks issue references the same way. That habit is
# exactly backwards for a `#N` a waiter DEPENDS on: backticking a handle
# SUPPRESSES an unwanted side effect (routing); backticking an issue
# reference SUPPRESSES a wanted one (the cross-reference edge).
#
# WHAT IT DOES NOT DO: it does not read GitHub's timeline API, and it does
# not decide whether a reference matters. It scans the body text the
# comment command is ALREADY carrying (same source check-close-condition-
# create.sh already parses for its own purpose) for `#N` / `owner/repo#N`
# patterns that sit inside a backtick span or a fenced code block, and
# names them. A body with no such reference produces no output at all.
#
# WARN-ONLY, NOT BLOCK: same posture as every sibling in this family
# (check-close-condition.sh / check-close-condition-create.sh /
# check-close-and-ping.sh). This hook ALWAYS allows the comment to post.
# There is a real cost asymmetry (#1385's own reasoning, reused here): a
# false-positive warning costs the author a moment's skim; a false-negative
# (an un-caught backticked reference) costs days of a silently-stranded
# waiter, per the four incidents that motivated #1385 in the first place.
#
# SCOPE: `gh issue comment` / `gh pr comment` ONLY — deliberately NOT `gh
# issue create` / `gh pr create`, even though #1394's own checklist names
# check-close-condition-create.sh as a candidate host. That hook's own
# header explains why firing on every ordinary `create` "would train the
# override reflex on the common case" (most issues state no closing
# condition, so it stays silent by default) — but #1394's own body ends
# `` Refs `#1388`, `#1393` `` (a backticked-footer shape the fleet writes on
# MOST issues it creates), so extending create-time coverage would fire
# near-universally rather than on the rare arm-a-waiter case. Left as an
# acknowledged partial, per science's own comment on #1394: "if body-
# parsing is too costly [there], say so and let the rule stand alone as an
# acknowledged partial" — the rule half (mention-routing-hygiene.md) covers
# create-time by discipline; this hook covers comment-time structurally.
#
# WHAT COUNTS AS "BACKTICKED": two shapes, both warned (#1394's own
# resolution: "a backticked #N inside a fenced code block that is quoting a
# command → still warned? I lean warn anyway, it is one line and the author
# can ignore it"):
#   1. An inline single-backtick span: `` `#1393` `` or
#      `` `groundnuty/macf#1393` `` — detected by checking that the
#      character immediately before and immediately after the matched `#N`
#      is a literal backtick (same adjacency heuristic check-mention-
#      routing.sh already uses for `@handle[bot]` backtick-suppression —
#      reused here for consistency, not reinvented).
#   2. Inside a fenced code block (a line starting with three-or-more
#      backticks toggles fence state; every `#N` on a line while the fence
#      is open counts, regardless of local backtick adjacency — a fenced
#      block's delimiters are two lines away from the reference, so the
#      single-backtick adjacency check alone would miss it).
# A bare `#N` (no backticks, no fence) is the CORRECT form — silent, no
# warning, by design.
#
# DIRECTION HINT: when the comment's own target issue/PR number can be
# confidently extracted from the command (the token immediately following
# `comment`, scanned only up to the first body-carrying flag — see the
# extraction note below), the warning also states the mechanical fact: the
# cross-reference edge lands on the issue MENTIONED in the body, not on the
# one the comment is posted to. A waiter must reference its blocker from
# the WAITER's own thread, not the other way around (macf-devops-agent hit
# this as a *second*, distinct failure mode on #1394 — posting the
# reference from the wrong side reads correctly in prose but arms nothing).
# When the self number can't be confidently extracted, this sentence is
# omitted entirely rather than guessed at.
#
# HOW IT SURFACES THE WARNING: the structured PreToolUse JSON contract, same
# as every warn-only sibling in this family:
#   {"hookSpecificOutput": {"hookEventName": "PreToolUse",
#     "permissionDecision": "allow", "additionalContext": "<warning text>"}}
#
# Hook contract (PreToolUse): JSON on stdin, exit 0 ALWAYS (this hook never
# blocks). stdout carries the structured hookSpecificOutput JSON ONLY when
# at least one backticked/fenced issue reference was found; otherwise stdout
# is empty — true silence, same posture as check-close-condition-create.sh
# and check-close-and-ping.sh (most comments reference nothing, or
# reference correctly; a note on every ordinary comment would itself become
# noise).
#
# --body-file / -F / literal-heredoc resolution: this is NOT an edge case
# for this hook — pr-discipline.md names `--body-file` "the canonical way
# to pass that body without shell-quoting issues" specifically BECAUSE a
# backtick inside an inline `--body "..."` value risks shell interpretation
# (command substitution), so the bodies most likely to legitimately need
# `--body-file` are disproportionately the ones this hook exists to check.
# A guard that only reads inline `--body` values would miss precisely the
# authors who followed the canonical form — silent-fallback Instance 12's
# shape (a defense whose coverage anti-correlates with rule-fluency). Three
# branches, copied from check-mention-routing.sh's own #944 resolution:
#   1. `--body-file <path>` (or `-F <path>`, normalized) and the file is
#      READABLE right now → scan the file's actual content.
#   2. Not readable, but $COMMAND contains a literal (quoted-delimiter)
#      heredoc whose redirect target is exactly that path → scan the
#      heredoc's literal body text (sliced out of the command string, never
#      evaluated as shell — see check-mention-routing.sh's own Instance-12
#      distinguishing note for why this is text extraction, not evaluation).
#   3. Neither resolvable → SILENT, not a warning. Unlike check-mention-
#      routing.sh's Check A (which warns on an unresolvable --body-file
#      because a missing mention is itself the failure class it guards),
#      this hook has nothing it can respond to a warn-anyway posture with:
#      it cannot name a reference it never saw, so it says nothing rather
#      than emit a content-free "could not check" note on every such call.
#
# Override: MACF_SKIP_CLOSE_REFERENCE_CHECK=1 bypasses (no context
# injection at all — cheap exit, no stdin read), per the check-*.sh family's
# MACF_SKIP_* convention. Deliberately distinct from every sibling's own
# flag (MACF_SKIP_CLOSE_CONDITION_CHECK / MACF_SKIP_CONDITION_GRADE_CHECK /
# MACF_SKIP_CLOSE_PING_CHECK) — sharing one flag across hooks in this family
# would let a single override silently disable more than the operator meant.
#
# additionalContext carries no `groundnuty/macf#N` issue citations — only a
# pointer to mention-routing-hygiene.md, the canonical rule this hook is the
# structural backstop for. Every sibling hook in this family closes its
# context message with `Refs groundnuty/macf#NNNN (why this is surfaced)`;
# this one deliberately does not, per #1394's own requirement.
#
# Refs: groundnuty/macf#1394 (this hook); #1393 (the measurement); #1388 /
#       #1385 (check-close-and-ping.sh, the hook this closes the coverage
#       gap for — itself unmodified per #1394's own requirement: "it
#       correctly enumerates what GitHub linked; the fix is upstream of
#       it"); check-close-condition-create.sh (#1248 — the SCAN_TEXT /
#       --body-file extraction shape this hook's non-heredoc branch mirrors,
#       and the "most issues don't need this" reasoning that keeps `create`
#       out of this hook's scope); check-mention-routing.sh (#244/#272/#944
#       — the backtick-adjacency heuristic AND the --body-file/heredoc
#       three-branch dispatch this hook copies verbatim); mention-routing-
#       hygiene.md (the canonical rule; §5's backtick-suppression precedent
#       is what this hook's own backtick-detection heuristic is modeled on);
#       assert-the-wrong-path.md (the decisive-test-pair discipline this
#       hook's own tests follow — bare refs must stay silent, not merely
#       "backticked refs get flagged").
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_CLOSE_REFERENCE_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read PreToolUse payload. Fall through to allow on parse error — a broken
# hook must not brick the harness. Same defense-in-depth as the sister hooks.
INPUT_JSON="$(cat 2>/dev/null || echo "")"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
[[ -z "$COMMAND" ]] && exit 0

# Wrapper-aware match for `gh issue comment` / `gh pr comment`. Mirrors the
# rest of this hook family's GH_*_PATTERN shape — covers sudo, env VAR=,
# watch, ionice, setsid, nice, time prefix wrappers + chained-form leadins
# `;` `|` `&` `(` (subshell) + bare `VAR=val gh ...`.
GH_COMMENT_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+(issue|pr)[[:space:]]+comment([[:space:]]|$)'

# Shell-wrapper bypass: `bash -c "gh issue comment ..."` and variants.
SHELL_C_GH_COMMENT_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]+(issue|pr)[[:space:]]+comment([[:space:]]|$)'

if [[ ! "$COMMAND" =~ $GH_COMMENT_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_GH_COMMENT_PATTERN ]]; then
  exit 0
fi

# ── --body-file / -F / literal-heredoc resolution (copied from
#    check-mention-routing.sh's #944 three-branch dispatch — see the file
#    header for why this is the primary path, not an edge case, for THIS
#    hook specifically). `-F` is gh's documented short alias for
#    `--body-file`; normalize it first. ─────────────────────────────────

# Bounded path-variable resolution for --body-file paths (branch 1).
# Text substitution only — never `eval` or a subshell.
macf_resolve_path_vars() {
  local raw="$1"
  local resolved="$raw"
  # shellcheck disable=SC2088  # intentional literal leading-chars compare.
  if [[ "$resolved" == "~" || "$resolved" == "~/"* ]]; then
    resolved="${HOME:-}${resolved:1}"
  fi
  local out="" rest="$resolved" guard=0
  while [[ "$rest" =~ \$\{?([A-Za-z_][A-Za-z0-9_]*)\}? ]] && [[ "$guard" -lt 20 ]]; do
    guard=$((guard + 1))
    local varname="${BASH_REMATCH[1]}"
    local whole="${BASH_REMATCH[0]}"
    local prefix="${rest%%"$whole"*}"
    out+="${prefix}${!varname:-}"
    rest="${rest#"${prefix}${whole}"}"
  done
  out+="$rest"
  printf '%s' "$out"
}

# Literal heredoc-body extraction for --body-file paths (branch 2). Slices
# TEXT out of the command string — never evaluates shell. Contract: prints
# the extracted body and returns 0 on an UNAMBIGUOUS, quoted-delimiter
# match; prints nothing and returns 1 on anything else — every failure mode
# falls through to branch 3; this function never guesses.
macf_extract_heredoc_body() {
  local target="$1" cmd="$2"
  if [[ -z "$target" ]]; then
    return 1
  fi

  local heredoc_open_sq_pattern="^-?[[:space:]]*'([A-Za-z_][A-Za-z0-9_]*)'"
  local heredoc_open_dq_pattern='^-?[[:space:]]*"([A-Za-z_][A-Za-z0-9_]*)"'

  local -a lines=()
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    lines+=("$line")
  done <<<"$cmd"

  local match_idx=-1 match_count=0 delimiter="" strip_tabs=false
  local i=0
  while [[ "$i" -lt "${#lines[@]}" ]]; do
    line="${lines[$i]}"
    if [[ "$line" == *">"* ]] && [[ "$line" == *"$target"* ]] && [[ "$line" == *"<<"* ]]; then
      local frag="${line#*<<}"
      if [[ "$frag" =~ $heredoc_open_sq_pattern ]] || [[ "$frag" =~ $heredoc_open_dq_pattern ]]; then
        match_count=$((match_count + 1))
        delimiter="${BASH_REMATCH[1]}"
        match_idx="$i"
        if [[ "$frag" == "-"* ]]; then strip_tabs=true; else strip_tabs=false; fi
      else
        match_count=$((match_count + 1))
        delimiter=""
      fi
    fi
    i=$((i + 1))
  done

  if [[ "$match_count" -ne 1 ]] || [[ -z "$delimiter" ]] || [[ "$match_idx" -lt 0 ]]; then
    return 1
  fi

  local body="" found_close=false
  i=$((match_idx + 1))
  while [[ "$i" -lt "${#lines[@]}" ]]; do
    line="${lines[$i]}"
    local cmp_line="$line"
    if [[ "$strip_tabs" == "true" ]]; then
      while [[ "$cmp_line" == $'\t'* ]]; do
        cmp_line="${cmp_line#$'\t'}"
      done
    fi
    if [[ "$cmp_line" == "$delimiter" ]]; then
      found_close=true
      break
    fi
    body+="${line}"$'\n'
    i=$((i + 1))
  done

  if [[ "$found_close" == "false" ]]; then
    return 1
  fi

  printf '%s' "$body" || true
  return 0
}

NORM_CMD="$(sed -E 's/(^|[[:space:]])-F([ =])/\1--body-file\2/g' <<<"$COMMAND" 2>/dev/null || echo "$COMMAND")"

BODY_FILE_RESOLVED=false
SCAN_TARGET="$COMMAND"

BODY_FILE_ARG_PATTERN='--body-file(=|[[:space:]]+)([^[:space:]]+)'
if [[ "$NORM_CMD" =~ $BODY_FILE_ARG_PATTERN ]]; then
  BODY_FILE_RAW="${BASH_REMATCH[2]}"
  if [[ "$BODY_FILE_RAW" == \"*\" ]] && [[ "$BODY_FILE_RAW" == *\" ]]; then
    BODY_FILE_RAW="${BODY_FILE_RAW:1:-1}"
  elif [[ "$BODY_FILE_RAW" == \'*\' ]] && [[ "$BODY_FILE_RAW" == *\' ]]; then
    BODY_FILE_RAW="${BODY_FILE_RAW:1:-1}"
  fi

  # Branch 1: readable file right now.
  RESOLVED_BODY_FILE_PATH="$(macf_resolve_path_vars "$BODY_FILE_RAW")"
  if [[ -n "$RESOLVED_BODY_FILE_PATH" ]] \
     && [[ -f "$RESOLVED_BODY_FILE_PATH" ]] \
     && [[ -r "$RESOLVED_BODY_FILE_PATH" ]]; then
    SCAN_TARGET="$(cat -- "$RESOLVED_BODY_FILE_PATH" 2>/dev/null || true)"
    BODY_FILE_RESOLVED=true
  fi

  # Branch 2: literal heredoc targeting the same path.
  if [[ "$BODY_FILE_RESOLVED" == "false" ]]; then
    if HEREDOC_BODY="$(macf_extract_heredoc_body "$BODY_FILE_RAW" "$COMMAND")"; then
      SCAN_TARGET="$HEREDOC_BODY"
      BODY_FILE_RESOLVED=true
    fi
  fi

  # Branch 3: neither resolvable — silent (see file header for why this
  # differs from check-mention-routing.sh's warn-anyway posture).
  if [[ "$BODY_FILE_RESOLVED" == "false" ]]; then
    exit 0
  fi
fi

# ── Scan SCAN_TARGET for #N / owner/repo#N references sitting inside a
#    backtick span or a fenced code block. Adjacency check (char
#    immediately before/after the match is a literal backtick) mirrors
#    check-mention-routing.sh's own "already-backticked" heuristic for
#    @handle[bot]; the in-fence toggle is this hook's own addition, since a
#    fenced block's delimiter lines are not adjacent to the reference. ────
REF_PATTERN='[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+|#[0-9]+'

BACKTICKED_REFS="$(awk -v pat="$REF_PATTERN" '
  BEGIN { in_fence = 0 }
  {
    if ($0 ~ /^[[:space:]]*```+/) {
      in_fence = !in_fence
      next
    }

    abs_offset = 0
    line = $0
    while ( match(line, pat) ) {
      abs_start = abs_offset + RSTART
      abs_end = abs_start + RLENGTH
      matched = substr($0, abs_start, RLENGTH)

      if (in_fence) {
        backticked = 1
      } else {
        char_before = (abs_start - 1 >= 1) ? substr($0, abs_start - 1, 1) : ""
        char_after = substr($0, abs_end, 1)
        backticked = (char_before == "`" && char_after == "`") ? 1 : 0
      }

      if (backticked && !(matched in seen)) {
        seen[matched] = 1
        print matched
      }

      line = substr(line, RSTART + RLENGTH)
      abs_offset = abs_start + RLENGTH - 1
    }
  }
' <<<"$SCAN_TARGET" 2>/dev/null || true)"

# No backticked/fenced reference found — true silent pass. Most comments
# reference nothing, or reference correctly (bare); a note on every
# ordinary comment would itself become the noise this hook exists to avoid.
[[ -z "$BACKTICKED_REFS" ]] && exit 0

# ── Best-effort direction hint: the comment's own target issue/PR number,
#    scanned ONLY up to the first body-carrying flag. `gh issue comment`'s
#    flag set (`gh issue comment --help`): -b/--body, -F/--body-file (both
#    value-taking, body content), --create-if-none / --delete-last /
#    --edit-last / -e/--editor / -w/--web / --yes (boolean), -R/--repo
#    (value-taking, not body-related). Stopping at the first body flag
#    avoids lifting a number OUT OF the body text itself when the naive
#    space-split loop (this family's existing convention) walks past it —
#    a wrong-subject risk (silent-fallback-hazards.md Instance 20) rather
#    than a wrong-answer one, since an unconfident extraction is simply
#    omitted below, never guessed. ──────────────────────────────────────
TAIL="$(sed -E 's/^.*gh[[:space:]]+(issue|pr)[[:space:]]+comment[[:space:]]*//' <<<"$COMMAND" 2>/dev/null || echo "")"

SELF_NUMBER=""
PREV_FLAG=""
if [[ -n "$TAIL" ]]; then
  # shellcheck disable=SC2086
  for tok in $TAIL; do
    if [[ -n "$PREV_FLAG" ]]; then
      PREV_FLAG=""
      continue
    fi
    case "$tok" in
      -b|--body|-F|--body-file|--body=*|--body-file=*)
        break
        ;;
      --repo|-R)
        PREV_FLAG="$tok"
        continue
        ;;
      --repo=*)
        continue
        ;;
      --create-if-none|--delete-last|--edit-last|-e|--editor|-w|--web|--yes)
        continue
        ;;
    esac
    if [[ "$tok" =~ ^[0-9]+$ ]]; then
      SELF_NUMBER="$tok"
      break
    fi
    if [[ "$tok" =~ /(issues|pull)/([0-9]+) ]]; then
      SELF_NUMBER="${BASH_REMATCH[2]}"
      break
    fi
    STRIPPED="${tok#\"}"; STRIPPED="${STRIPPED%\"}"
    STRIPPED="${STRIPPED#\'}"; STRIPPED="${STRIPPED%\'}"
    if [[ "$STRIPPED" =~ ^[0-9]+$ ]]; then
      SELF_NUMBER="$STRIPPED"
      break
    fi
  done
fi

# ── Build the warning ──────────────────────────────────────────────────
# shellcheck disable=SC2016  # literal backticks by design, nothing to expand.
REF_LIST="$(sed 's/^/  - `/; s/$/`/' <<<"$BACKTICKED_REFS" 2>/dev/null || echo "$BACKTICKED_REFS")"
FIRST_REF="$(head -1 <<<"$BACKTICKED_REFS" 2>/dev/null || echo "")"

DIRECTION_SENTENCE=""
if [[ -n "$SELF_NUMBER" ]] && [[ -n "$FIRST_REF" ]]; then
  DIRECTION_SENTENCE="

Also: the cross-reference edge (once you drop the backticks) lands on the issue MENTIONED (${FIRST_REF}), not on the one you are posting from (#${SELF_NUMBER}). If #${SELF_NUMBER} is the one waiting on ${FIRST_REF}, referencing it from here is correct. If ${FIRST_REF} is actually the one waiting on #${SELF_NUMBER}, post the reference from ${FIRST_REF}'s own thread instead."
fi

CONTEXT_MSG="This comment references another issue only inside backticks — GitHub does not create a cross-reference event for a reference inside a code span or fenced code block, so close-and-ping cannot see it and the waiter/blocker edge never arms:

${REF_LIST}

Use the bare form instead (drop the backticks) so the reference autolinks and close-and-ping can find it when the referenced issue closes.${DIRECTION_SENTENCE}

Refs mention-routing-hygiene.md (backtick handles, never issue references you depend on)."

# Emit the structured PreToolUse allow+context-injection contract. Guarded
# against a missing/broken jq: if construction fails, fall through to a
# plain exit 0 with no injected context rather than letting a jq failure
# propagate under `set -e`.
OUTPUT=""
OUTPUT="$(jq -n --arg ctx "$CONTEXT_MSG" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    additionalContext: $ctx
  }
}' 2>/dev/null)" || OUTPUT=""

if [[ -n "$OUTPUT" ]]; then
  printf '%s\n' "$OUTPUT"
fi

exit 0
