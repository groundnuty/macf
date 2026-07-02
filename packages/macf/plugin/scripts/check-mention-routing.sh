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

# `--body-file` reads content from a file path; we don't lint file
# contents (the file may not exist at hook-fire time, or may be
# regenerated). Accept the trade-off and allow. The canonical rule
# still applies; operator discipline catches it without the hook.
if [[ "$COMMAND" =~ --body-file([[:space:]]|=) ]] && [[ ! "$COMMAND" =~ --body([[:space:]]|=)[[:space:]]*[\"\']*[@] ]]; then
  exit 0
fi

# Per-occurrence scan for raw @macf-<role>-agent[bot] patterns in the
# command string. Heuristic per groundnuty/macf#272 design synthesis:
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
' <<<"$COMMAND")"

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

Override (ONLY for legitimate raw-mention cases the heuristic catches):
  export MACF_SKIP_MENTION_CHECK=1

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
on self-filed-self-closed issues, or test-orchestration scratch comments):
  export MACF_SKIP_MENTION_CHECK=1

Refs: groundnuty/macf#244 (this check); coordination.md §Communication 2
(canonical rule, distributed via \`macf rules refresh\`).
ERR
  exit 2
fi

exit 0
