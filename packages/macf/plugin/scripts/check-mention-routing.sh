#!/usr/bin/env bash
#
# check-mention-routing.sh — Claude Code PreToolUse hook that blocks
# `gh issue comment` / `gh pr comment` / `gh issue close --comment` /
# `gh pr close --comment` invocations when the `--body` content contains
# raw `@macf-<role>-agent[bot]` mentions in describing contexts (mid-line,
# not backticked). Implements `mention-routing-hygiene.md` §5 structurally.
#
# Hook contract: JSON on stdin, exit 0 = allow, exit 2 = block (stderr
# is fed back to Claude as the error). Mirrors the shape of #140's
# check-gh-token.sh per groundnuty/macf#272 design alignment.
#
# Override: MACF_SKIP_MENTION_CHECK=1 bypasses (for legitimate raw-mention
# cases the heuristic catches; rare per the canonical rule's structure
# but mirrors check-gh-token.sh's escape hatch).
#
# Refs: groundnuty/macf#244 (must-have-mention class — orthogonal, deferred),
#       groundnuty/macf#272 (must-not-leak — what this script enforces),
#       DR-023 UC-4 (bash-form per substrate-compat — mcp_tool variant
#       won't fire on substrate workspaces where the macf-agent MCP server
#       isn't loaded, but the breach pattern is concentrated on substrate).
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_MENTION_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read PreToolUse payload. Fall through to allow on parse error — a
# broken hook must not brick the harness. Same defense-in-depth as
# check-gh-token.sh.
INPUT_JSON="$(cat)"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

# Wrapper-aware match for the comment-posting subcommands. Mirrors
# check-gh-token.sh's pattern shape — covers sudo, env VAR=, watch,
# ionice, setsid, nice, time prefix wrappers + chained-form leadins
# `;` `|` `&`. The subcommands we care about are exactly those that
# accept --body and post text content visible to other agents:
#   gh issue comment    gh pr comment
#   gh issue close      gh pr close      (only when --comment is present;
#                                          plain close has no body)
GH_COMMENT_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+(issue|pr)[[:space:]]+(comment|close)([[:space:]]|$)'

# Shell-wrapper bypass: catches `bash -c "gh issue comment ..."` and
# variants. Same flag-handling logic as check-gh-token.sh.
SHELL_C_GH_COMMENT_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]+(issue|pr)[[:space:]]+(comment|close)([[:space:]]|$)'

if [[ ! "$COMMAND" =~ $GH_COMMENT_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_GH_COMMENT_PATTERN ]]; then
  # Not a comment-posting command — allow.
  exit 0
fi

# `gh issue close` / `gh pr close` without --comment doesn't post text.
# Skip — nothing to check.
if [[ "$COMMAND" =~ gh[[:space:]]+(issue|pr)[[:space:]]+close ]] && [[ ! "$COMMAND" =~ --comment ]]; then
  exit 0
fi

# Track whether this is a `close` subcommand. Check A
# (must-have-mention; macf#244) does NOT apply to close subcommands —
# self-close verification comments are canonically no-recipient
# (reporter-internal verification per coordination.md §Issue Lifecycle 1
# case 2 self-close pattern: "Verified on main after PR #M merged.
# Closing as reporter."). The close action itself is the routing-end
# signal, not a routing-active comment requiring an addressed @mention.
# Check B (must-not-leak; describing-context) still applies on close
# subcommands — leak prevention is independent of recipient semantics.
IS_CLOSE_SUBCOMMAND=false
if [[ "$COMMAND" =~ gh[[:space:]]+(issue|pr)[[:space:]]+close ]]; then
  IS_CLOSE_SUBCOMMAND=true
fi

# --body-file handling (groundnuty/macf#944).
#
# The ORIGINAL exemption here unconditionally `exit 0`d for ANY
# `--body-file` invocation — the form `pr-discipline.md` explicitly
# recommends for review/comment bodies AND the write-then-post /
# write-and-post patterns. That blanket exemption silently skipped BOTH
# Check A and Check B for every `--body-file` call, including bodies with
# zero mentions (Check A's exact failure mode) or describing-context leaks
# (Check B's). Fixed per the #944 ruling: resolve the actual body content
# where possible and lint IT; only fall back to a non-blocking warning
# (Check A) / today's silent allow (Check B) when content genuinely can't
# be resolved.
#
# Three branches, in order:
#   1. `--body-file <path>` and the file is READABLE right now → lint the
#      file's actual content (both checks). Covers the two-call
#      write-then-post pattern (a prior tool call already wrote the file).
#   2. Not readable, but $COMMAND contains a heredoc whose redirect TARGET
#      is exactly the --body-file path, with a QUOTED delimiter → extract
#      the heredoc BODY TEXT (not evaluated — see the Instance-12 note
#      below) and lint THAT. Covers the single-call write-and-post pattern
#      (`cat > f <<'EOF' … EOF; gh … --body-file f` in one Bash call),
#      where PreToolUse fires before the file exists on disk.
#   3. Neither resolvable → Check A WARNS on stderr (non-blocking); Check B
#      keeps the pre-#944 silent allow (nothing lintable, same as before).
#
# --- Distinguishing branch 2 from silent-fallback Instance 12's
# decided-against (silent-fallback-hazards.md) ---
# Instance 12 records a *decided-against*: teaching a PreToolUse hook to
# parse inline shell, because doing so would require EVALUATING shell (the
# value there came from a command substitution `$(...)`, whose result
# can't be known without running it). Branch 2 here is a different
# operation: it only SLICES literal text between two known delimiters out
# of the already-available command STRING. A `<<'EOF'` heredoc body is
# unexpanded BY DEFINITION — the quoted delimiter is exactly what tells
# the real shell "don't touch this text" — so no variable substitution,
# command substitution, or globbing happens to it before it lands in the
# target file. The text sitting between the heredoc-open line and its
# closing delimiter line IN THE COMMAND STRING *is* the exact body that
# will land in the file: reading it off the string is text extraction, not
# shell evaluation. An UNQUOTED `<<EOF` does not carry this guarantee (its
# body undergoes expansion), which is exactly why branch 2 refuses to
# treat an unquoted delimiter as safe — it falls through to branch 3
# instead of guessing.

# --- Helpers -----------------------------------------------------------

# Bounded path-variable resolution for --body-file paths (branch 1).
# Expands a leading `~` to $HOME and any $VAR / ${VAR} references using
# bash's OWN indirect parameter expansion (${!name}) against variables
# already present in THIS hook process's environment — text substitution,
# never `eval` or a subshell. A reference to a variable this process
# doesn't have expands to empty string (same as unset-variable semantics),
# which naturally fails the subsequent readability check rather than
# guessing.
macf_resolve_path_vars() {
  local raw="$1"
  local resolved="$raw"
  # shellcheck disable=SC2088  # intentional: comparing a string's literal
  # leading chars against "~"/"~/" here, not asking the shell to expand a
  # tilde inside a quoted string. The manual $HOME substitution below IS
  # the expansion.
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
# TEXT out of the command string — never evaluates shell (see the
# Instance-12 distinguishing note above). Matching is done via plain
# substring containment (bash treats a quoted portion of a `[[ ]]` glob
# pattern as literal), so no path-to-regex escaping is needed anywhere.
#
# Contract: prints the extracted body and returns 0 on an UNAMBIGUOUS,
# quoted-delimiter match; prints nothing and returns 1 on anything else —
# no candidate line, more than one candidate line, or an unquoted
# delimiter. Every failure mode here falls through to branch 3; this
# function never guesses.
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
        # Candidate line targets our path but has no safely-literal
        # (quoted) delimiter — unsafe to treat as this heredoc's body.
        # Still counts toward ambiguity so a second, quoted-looking match
        # elsewhere doesn't win by default (fail closed, not a guess).
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

# --- Three-branch dispatch ----------------------------------------------

BODY_FILE_MODE=false
BODY_FILE_RESOLVED=false
LINT_TARGET="$COMMAND"

BODY_FILE_ARG_PATTERN='--body-file(=|[[:space:]]+)([^[:space:]]+)'
if [[ "$COMMAND" =~ $BODY_FILE_ARG_PATTERN ]]; then
  BODY_FILE_MODE=true
  BODY_FILE_RAW="${BASH_REMATCH[2]}"
  # Strip one layer of matching wrapping quotes (only the common
  # no-embedded-space quoted case; quoted paths WITH spaces aren't
  # captured by [^[:space:]]+ above and fall through to branch 3 —
  # fail-safe, never a wrong-answer risk).
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
    LINT_TARGET="$(cat -- "$RESOLVED_BODY_FILE_PATH" 2>/dev/null || true)"
    BODY_FILE_RESOLVED=true
  fi

  # Branch 2: literal heredoc targeting the same path.
  if [[ "$BODY_FILE_RESOLVED" == "false" ]]; then
    if HEREDOC_BODY="$(macf_extract_heredoc_body "$BODY_FILE_RAW" "$COMMAND")"; then
      LINT_TARGET="$HEREDOC_BODY"
      BODY_FILE_RESOLVED=true
    fi
  fi
fi

# Branch 3: neither resolvable.
if [[ "$BODY_FILE_MODE" == "true" ]] && [[ "$BODY_FILE_RESOLVED" == "false" ]]; then
  # Check B: nothing lintable — same silent allow as pre-#944 (no leak
  # check possible without content; operator discipline covers the gap).
  # Check A: WARN (do not block) — unlike Check B, a missing mention is
  # the exact silent-failure shape coordination.md §Communication 2 warns
  # about, so make the gap visible even though we can't prove it either
  # way. Bypassed for close subcommands — Check A never applies to them
  # (see IS_CLOSE_SUBCOMMAND above).
  if [[ "$IS_CLOSE_SUBCOMMAND" == "false" ]]; then
    cat >&2 <<WARNERR
WARNING (non-blocking) from MACF mention-routing-hygiene hook: this command
uses --body-file "$BODY_FILE_RAW" and the hook could not resolve its
content — the file isn't readable yet AND no literal (quoted-delimiter)
heredoc in this command targets that same path. The hook cannot verify
this comment carries a routing-active @<bot>[bot] mention
(coordination.md §Communication 2) or is free of a describing-context leak
(mention-routing-hygiene.md §5).

Proceeding WITHOUT blocking (groundnuty/macf#944 branch 3) — double-check
the file content manually before it posts.
WARNERR
  fi
  exit 0
fi

# Per-occurrence scan for raw @macf-<role>-agent[bot] patterns in the lint
# target (LINT_TARGET — the command string for a plain `--body`/`--comment`
# invocation, or the resolved --body-file content per the dispatch above
# for branches 1/2; branch 3 exits before reaching this scan at all — see
# groundnuty/macf#944). Heuristic per groundnuty/macf#272 design synthesis:
#   - Already wrapped in backticks (`@bot[bot]`) → allowed (describing form §5)
#   - At line start (only whitespace, blockquote `>`, or list markers
#     `* ` `- ` `1. ` before it on the same line) → allowed (addressing
#     form §3 — typical PR-closing-line / handoff / escalation shape)
#   - Otherwise → BLOCK as describing-context leak
#
# False-positive trade-off: single-line bodies with the addressing form
# right after `--body "` (no preceding newline) are flagged. The canonical
# rule's examples (§3) all show addressing on its own line, so this
# matches the expected idiom. Override available for rare exceptions.
#
# False-negative trade-off: line-start mentions that are actually
# describing-with-bot-as-subject ("@bot's response was clean" — line
# starts with the handle but the sentence is descriptive) pass through.
# This is rare in practice; canonical idiom puts describing references
# inside prose, not at line-start. Operator discipline catches the residual.
# awk regex: `[[]` and `[]]` express literal `[` and `]` in a char class
# context (awk's `\[` escape would either warn-and-strip or be ambiguous
# across awk variants).
#
# Pattern scope (broadened per macf#276): matches ANY `@<handle>[bot]`
# rather than only `@macf-*-agent[bot]`. First char must be a letter
# (excludes leading digit/underscore/hyphen forms which aren't valid
# GitHub handles anyway); body accepts alphanumeric / underscore /
# hyphen so digit-suffixed and multi-segment handles match.
#
# Covers: macf-* fleet (`macf-code-agent`, `macf-science-agent`,
# `macf-tester-N-agent`, `macf-devops-agent`); future CV fleet
# (`cv-architect`, `academic-resume-author`, similar shapes); future
# MACF-consumer fleets that may not follow the `macf-*-agent` naming
# convention; AND third-party bots (`dependabot`, `github-actions`).
# Third-party bots don't fire MACF routing (not in agent registry),
# but blocking their describing-context use is consistent style — and
# operators can use `MACF_SKIP_MENTION_CHECK=1` for the rare legitimate
# describing reference. The cost of generalization is small; the
# benefit (fleet-agnostic protection) is durable.
HANDLE_PATTERN='@[a-zA-Z][a-zA-Z0-9_-]*[[]bot[]]'

# Single AWK pass produces TWO outputs (line-prefix-discriminated):
#   - `LEAK:<line_no>: <line>` — describing-context leaks (Check B,
#     groundnuty/macf#272). Reported once per offending line.
#   - `ACTIVE_COUNT:<n>` — total routing-active @mentions across the
#     entire body (Check A, groundnuty/macf#244). Routing-active =
#     NOT wrapped in backticks. Both line-start addressing AND mid-line
#     describing-leaks are routing-active; only the backticked form is
#     routing-suppressed. If this count is 0, the comment has no
#     recipient — Check A blocks.
AWK_OUTPUT="$(awk -v pat="$HANDLE_PATTERN" '
  BEGIN { active_count = 0 }
  {
    # Track which lines we have already reported a leak for, so a line
    # with multiple offenders surfaces once (existing Check B behavior
    # — preserved verbatim across the Check A extension).
    line_already_reported = 0

    # Process every match on this line. After each match, advance the
    # search-substring past it (RSTART+RLENGTH from the original line $0
    # tracked via abs_offset).
    abs_offset = 0
    line = $0
    while ( match(line, pat) ) {
      abs_start = abs_offset + RSTART
      abs_end = abs_start + RLENGTH

      # Surrounding chars from the ORIGINAL line $0
      char_before = (abs_start - 1 >= 1) ? substr($0, abs_start - 1, 1) : ""
      char_after = substr($0, abs_end, 1)

      # Already-backticked? Allowed describing form (§5). Routing-suppressed
      # — does NOT count toward Check A active-mention total.
      if (char_before == "`" && char_after == "`") {
        line = substr(line, RSTART + RLENGTH)
        abs_offset = abs_start + RLENGTH - 1
        continue
      }

      # Routing-active (NOT backticked). Counts toward Check A regardless
      # of position (line-start addressing AND mid-line describing both
      # fire routing — the backtick suppression is the only routing-mute).
      active_count++

      # Line-start (after optional whitespace, blockquote, or list-item
      # markers)? Allowed addressing form (§3) — Check B passes; Check A
      # already incremented above.
      prefix = substr($0, 1, abs_start - 1)
      if (prefix ~ /^[[:space:]>]*([0-9]+\.[[:space:]]+|[-*][[:space:]]+)?$/) {
        line = substr(line, RSTART + RLENGTH)
        abs_offset = abs_start + RLENGTH - 1
        continue
      }

      # Mid-line raw mention — describing-context leak (Check B BLOCK).
      # Report once per line; counter still increments for additional
      # matches on the same line so Check A sees the complete picture.
      if (!line_already_reported) {
        print "LEAK:" NR ": " $0
        line_already_reported = 1
      }
      line = substr(line, RSTART + RLENGTH)
      abs_offset = abs_start + RLENGTH - 1
    }
  }
  END { print "ACTIVE_COUNT:" active_count }
' <<<"$LINT_TARGET")"

# `grep` returns 1 when no matches; under `set -euo pipefail` that
# propagates as the script's exit code without `|| true`. The Check A
# happy-path (no leaks) needs OFFENDING to be empty without the hook
# itself dying — the explicit fall-through is required.
OFFENDING="$(grep '^LEAK:' <<<"$AWK_OUTPUT" | sed 's/^LEAK://' || true)"
ACTIVE_COUNT="$(grep '^ACTIVE_COUNT:' <<<"$AWK_OUTPUT" | sed 's/^ACTIVE_COUNT://' || true)"

if [[ -n "$OFFENDING" ]]; then
  cat >&2 <<ERR
BLOCKED by MACF mention-routing-hygiene hook: this comment contains raw
@<bot>[bot] mention(s) in describing-context (mid-line, not backticked) which
would fire false-positive routing per mention-routing-hygiene.md §5.

Offending line(s) within the command:
$OFFENDING

Fix per the canonical rule — wrap describing-context mentions in backticks:
  Wrong:  @macf-tester-2-agent[bot] response quoted coordination.md ...
  Right:  \`@macf-tester-2-agent[bot]\` response quoted coordination.md ...

Or use one of the equivalent suppression forms (§5):
  - Backticks:  \`@macf-tester-2-agent[bot]\`   (preferred — semantic markup)
  - Escapes:    \\@macf-tester-2-agent\\[bot\\]
  - Label form: "tester-2" or "the tester-2 agent"

Addressing form (line-start, expected to fire routing) is allowed:
  @macf-science-agent[bot] PR ready for review.

Override (ONLY for legitimate raw-mention cases the heuristic catches) is
launch-time / operator only: MACF_SKIP_MENTION_CHECK is read from THIS
session's process env, fixed when ./claude.sh launched it. An in-session
\`export MACF_SKIP_MENTION_CHECK=1\` from a Bash tool call does NOT reach
it — Bash-tool commands run in a separate subshell that never persists
into the session's env. To use it: set MACF_SKIP_MENTION_CHECK=1 in the
launch env (or the workspace's .claude/.macf/env.* files) BEFORE running
./claude.sh, then relaunch. Need it mid-session? Ask the operator to set
it + relaunch, or route the specific comment through the operator directly.

Refs: groundnuty/macf#244, #272 (this hook); mention-routing-hygiene.md
(canonical rule, distributed via \`macf rules refresh\`).
ERR
  exit 2
fi

# Check A (groundnuty/macf#244): must-have-mention. Comment-emit commands
# must contain at least one routing-active @<bot>[bot] mention. Without
# one, the comment is "invisible" to other agents — coordination.md
# §Communication 2 names this as the silent-failure mode.
#
# Bypassed for `gh (issue|pr) close --comment` — self-close verification
# comments are canonically no-recipient (reporter-internal). The close
# action itself signals routing-end; no addressed mention required.
if [[ "$IS_CLOSE_SUBCOMMAND" == "false" ]] && [[ "$ACTIVE_COUNT" == "0" ]]; then
  cat >&2 <<ERR
BLOCKED by MACF mention-routing-hygiene hook: this comment has zero
routing-active @<bot>[bot] mentions. Per coordination.md §Communication 2:

  "@mention in EVERY comment. Routing depends on it. A comment without
  @mention is invisible to the recipient agent."

Without a routing-active mention, the comment is silently invisible to
peer agents — they have no notification that you posted, even if the
issue/PR is on their assigned-label queue.

Fix: add an addressing mention naming the recipient:
  @<recipient-handle>[bot] <your message>

Examples (where <recipient> is the issue reporter, PR reviewer, etc.):
  @macf-science-agent[bot] PR #N ready for review.
  @macf-code-agent[bot] LGTM, you can merge.

Override (ONLY for legitimate no-recipient cases — rare; status posts
on self-filed-self-closed issues, or test-orchestration scratch comments)
is launch-time / operator only: MACF_SKIP_MENTION_CHECK is read from THIS
session's process env, fixed when ./claude.sh launched it. An in-session
\`export MACF_SKIP_MENTION_CHECK=1\` from a Bash tool call does NOT reach
it — Bash-tool commands run in a separate subshell that never persists
into the session's env. To use it: set MACF_SKIP_MENTION_CHECK=1 in the
launch env (or the workspace's .claude/.macf/env.* files) BEFORE running
./claude.sh, then relaunch. Need it mid-session? Ask the operator to set
it + relaunch, or route the specific comment through the operator directly.

Refs: groundnuty/macf#244 (this check); coordination.md §Communication 2
(canonical rule, distributed via \`macf rules refresh\`).
ERR
  exit 2
fi

exit 0
