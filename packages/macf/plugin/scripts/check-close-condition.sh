#!/usr/bin/env bash
#
# check-close-condition.sh — Claude Code PreToolUse hook (groundnuty/macf#1231)
# that surfaces an issue's OWN STATED closing condition back to the closer at
# the moment of `gh issue close`, so the close is made against the condition
# rather than against whatever happens to be in context.
#
# WHY: a closing condition recorded in an issue body at filing time is a
# claim about future state that nobody re-presents at the moment of closing
# — it has to be in front of the closer WHEN they type the close, not merely
# somewhere in a body they read hours earlier. `groundnuty/macf#1221` closed
# prematurely TWICE on the same issue (once on PR-approval, once on merge)
# despite its body stating an observable closing condition throughout — the
# condition existed and was never re-surfaced at the two moments that
# mattered. This hook is the structural fix: reprint the condition, every
# close, no exceptions.
#
# WHAT IT DOES NOT DO: it does not decide whether the condition is met. It
# extracts a body line matching `[Cc]loses when …` (falling back if absent)
# or the contents of a `## Closure condition` (or `## Closing condition`)
# section, and surfaces that text — nothing more. Adjudicating arbitrary
# prose would be wrong often enough to get bypassed (see check-close-
# keyword.sh's own authorship-only discriminator for the sibling precedent
# of "check what's checkable, surface what isn't"). Per `#1231`'s own
# acceptance criteria: an issue with NO stated closing condition passes with
# a short note — most issues have none, and blocking those would train the
# override reflex on the common case.
#
# WARN-ONLY, NOT BLOCK-ONCE (the design decision `#1231` asked to be made
# explicitly, and justified): every `check-*.sh` PreToolUse hook that
# actually BLOCKS (check-gh-token.sh / check-mention-routing.sh /
# check-lgtm-gate.sh / check-close-keyword.sh / check-auditor-never-acts.sh
# / check-git-sweep.sh) makes its allow/block decision PURELY from the
# current invocation — none of them persist a marker file to remember "I
# already warned about this once." The one hook in the family that DOES
# read/write a state file (check-channel-alive.sh) uses it only to THROTTLE
# an always-allow observational probe, never to gate a decision. There is no
# precedent anywhere in this hook family for "block once via a marker file,
# then allow on retry" — introducing one here would add novel per-issue
# state-lifecycle complexity (where it lives, when it's cleared, what
# happens when a DIFFERENT agent or workspace closes the same issue and has
# never seen the marker) for a feature whose entire acceptance criteria is
# "surface, don't decide." A block-once-then-allow gate is also, in effect,
# a content-free adjudication ("have you looked yet?") — exactly the shape
# `#1231` says must not exist. So: warn-only. The hook ALWAYS allows the
# close; its only job is making sure the condition (if any) was actually
# put on screen first.
#
# HOW IT SURFACES THE CONDITION: plain stdout/stderr on an ALLOWING
# PreToolUse hook is not injected into the calling agent's own context (only
# a human watching in transcript mode would see it) — printing to stderr on
# exit 0 would satisfy "printed something" without satisfying "the closer
# actually saw it," which is the whole point. This hook instead emits the
# structured PreToolUse JSON contract on stdout:
#   {"hookSpecificOutput": {"hookEventName": "PreToolUse",
#     "permissionDecision": "allow", "additionalContext": "<condition text>"}}
# `additionalContext` is the field Claude Code injects into the model's own
# context even on an allow decision — the correct mechanism for "surface,
# don't block." No sibling hook in this family uses this JSON form yet
# (they all block-via-exit-2/stderr or are silently observational); this is
# a new but load-bearing pattern for a hook whose entire job is context-
# injection-without-blocking.
#
# Hook contract (PreToolUse): JSON on stdin, exit 0 always (this hook never
# blocks — see WARN-ONLY above). stdout may carry the structured
# hookSpecificOutput JSON described above; otherwise empty.
#
# Override: MACF_SKIP_CLOSE_CONDITION_CHECK=1 bypasses (no context
# injection at all — cheap exit, no stdin read), per the check-*.sh family's
# MACF_SKIP_* convention.
#
# Refs: groundnuty/macf#1231 (this hook); #1221 (the two premature-close
#       instances that motivated it); #1222 (the sibling sweep for the
#       non-action half of the taxonomy); #1112 (the taxonomy this
#       completes); #878 (closing conditions as observables);
#       check-close-keyword.sh (the primitive this hook's wrapper coverage +
#       fail-open posture is copied from); assert-the-wrong-path.md (the
#       decisive-test-pair discipline this hook's own tests follow).
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_CLOSE_CONDITION_CHECK:-}" == "1" ]]; then
  exit 0
fi

# hook-gh-token.sh is copied alongside this file by every distribution path
# (copyCanonicalScripts) — but `source`ing a missing file would abort this
# whole script under `set -e`. Guard it: degrade to a plain, non-refreshing
# gh call if the sibling is somehow missing. Since this hook never blocks,
# the only consequence of degraded mode is a slightly worse chance of
# recovering from a merely-stale ambient token — never a change in
# allow/block posture (there is no block posture to change).
HOOK_GH_TOKEN_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hook-gh-token.sh"
if [[ -r "$HOOK_GH_TOKEN_LIB" ]]; then
  # shellcheck source=./hook-gh-token.sh
  source "$HOOK_GH_TOKEN_LIB"
else
  macf_hook_gh() {
    local out err errfile rc=0
    errfile="$(mktemp 2>/dev/null)" || { printf 'could not allocate a temp file'; return 2; }
    out="$(gh "$@" 2>"$errfile")" || rc=$?
    err="$(cat "$errfile" 2>/dev/null || true)"
    rm -f "$errfile"
    if [[ "$rc" -eq 0 ]]; then
      printf '%s' "$out"
      return 0
    fi
    printf '%s' "$err"
    return 2
  }
fi

# Read PreToolUse payload. Fall through to allow on parse error — a broken
# hook must not brick the harness. Same defense-in-depth as the sister hooks.
INPUT_JSON="$(cat 2>/dev/null || echo "")"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
[[ -z "$COMMAND" ]] && exit 0

# Wrapper-aware match for `gh issue close`. Mirrors check-close-keyword.sh's
# GH_PR_PATTERN shape — covers sudo, env VAR=, watch, ionice, setsid, nice,
# time prefix wrappers + chained-form leadins `;` `|` `&` `(` (subshell) +
# bare `VAR=val gh ...`.
GH_CLOSE_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+issue[[:space:]]+close([[:space:]]|$)'

# Shell-wrapper bypass: `bash -c "gh issue close ..."` and variants.
SHELL_C_GH_CLOSE_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]+issue[[:space:]]+close([[:space:]]|$)'

if [[ ! "$COMMAND" =~ $GH_CLOSE_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_GH_CLOSE_PATTERN ]]; then
  exit 0
fi

# ── Extract the issue number + --repo (if given) ─────────────────────────
# Mirrors check-lgtm-gate.sh's PR_NUMBER extraction, adapted to
# `gh issue close`'s own flag set (`gh issue close --help`):
#   -c, --comment string        (value-taking)
#       --duplicate-of string   (value-taking)
#   -r, --reason string         (value-taking)
#   -R, --repo OWNER/REPO       (value-taking; inherited)
# No boolean flags exist on this subcommand.
TAIL="$(sed -E 's/^.*gh[[:space:]]+issue[[:space:]]+close[[:space:]]+//' <<<"$COMMAND" 2>/dev/null || echo "")"
if [[ -z "$TAIL" ]]; then
  # No positional after `gh issue close` — gh itself will error with a
  # usage message; nothing to check here.
  exit 0
fi

ISSUE_NUMBER=""
PREV_FLAG=""
# shellcheck disable=SC2086
for tok in $TAIL; do
  if [[ -n "$PREV_FLAG" ]]; then
    PREV_FLAG=""
    continue
  fi
  if [[ "$tok" =~ ^--[a-zA-Z0-9-]+= ]]; then
    continue
  fi
  if [[ "$tok" =~ ^-- ]]; then
    case "$tok" in
      --comment|--duplicate-of|--reason|--repo)
        PREV_FLAG="$tok"
        ;;
      *) ;;
    esac
    continue
  fi
  if [[ "$tok" =~ ^-[a-zA-Z]$ ]]; then
    case "$tok" in
      -c|-r|-R)
        PREV_FLAG="$tok"
        ;;
      *) ;;
    esac
    continue
  fi
  if [[ "$tok" =~ ^[0-9]+$ ]]; then
    ISSUE_NUMBER="$tok"
    break
  fi
  # URL form: `https://github.com/owner/repo/issues/<N>`.
  if [[ "$tok" =~ /issues/([0-9]+) ]]; then
    ISSUE_NUMBER="${BASH_REMATCH[1]}"
    break
  fi
  # `owner/repo#N` shorthand.
  if [[ "$tok" =~ \#([0-9]+) ]]; then
    ISSUE_NUMBER="${BASH_REMATCH[1]}"
    break
  fi
  # Quoted forms.
  STRIPPED="${tok#\"}"; STRIPPED="${STRIPPED%\"}"
  STRIPPED="${STRIPPED#\'}"; STRIPPED="${STRIPPED%\'}"
  if [[ "$STRIPPED" =~ ^[0-9]+$ ]]; then
    ISSUE_NUMBER="$STRIPPED"
    break
  fi
done

if [[ -z "$ISSUE_NUMBER" ]]; then
  # Couldn't extract an issue number — allow, no fuss. gh itself will
  # surface a usage error if the command is malformed.
  exit 0
fi

REPO_VALUE=""
if [[ "$COMMAND" =~ --repo[[:space:]]+([^[:space:]]+) ]]; then
  REPO_VALUE="${BASH_REMATCH[1]}"
elif [[ "$COMMAND" =~ --repo=([^[:space:]]+) ]]; then
  REPO_VALUE="${BASH_REMATCH[1]}"
elif [[ "$COMMAND" =~ (^|[[:space:]])-R[[:space:]]+([^[:space:]]+) ]]; then
  REPO_VALUE="${BASH_REMATCH[2]}"
fi
# Strip trailing shell-wrapper punctuation that can end up glued to the
# value when the whole `gh issue close ...` command is itself wrapped in
# quotes or a subshell (`bash -c '... --repo owner/repo'`, `(... --repo
# owner/repo)`) — the greedy `[^[:space:]]+` above has no way to know the
# wrapper's own closing character isn't part of the repo spec.
REPO_VALUE="$(sed -E "s/[\"');\`]+\$//" <<<"$REPO_VALUE" 2>/dev/null || echo "$REPO_VALUE")"
REPO_FLAG=""
[[ -n "$REPO_VALUE" ]] && REPO_FLAG="--repo $REPO_VALUE"

# ── Fetch the issue body ──────────────────────────────────────────────────
# `gh issue view` (not raw `gh api`) so gh's own --repo auto-detection
# applies exactly as it would for the close call this hook is guarding.
ISSUE_JSON=""
GH_RC=0
# shellcheck disable=SC2086
ISSUE_JSON="$(macf_hook_gh issue view "$ISSUE_NUMBER" $REPO_FLAG --json body)" || GH_RC=$?

CONTEXT_MSG=""
if [[ "$GH_RC" -ne 0 ]]; then
  # Could not fetch the body — infrastructure error (network, auth,
  # missing issue, gh missing). This hook never blocks either way; the
  # only consequence is not having anything to surface. Fail-open per the
  # whole check-*.sh family's defense-in-depth posture.
  CONTEXT_MSG="MACF close-condition guard: could not fetch issue #${ISSUE_NUMBER}'s body to check for a stated closing condition (infrastructure error) — proceeding without surfacing one. Refs groundnuty/macf#1231."
else
  BODY="$(jq -r '.body // ""' <<<"$ISSUE_JSON" 2>/dev/null || echo "")"

  # ── Extract a stated closing condition ──────────────────────────────
  # Prefers a `## Closure condition` / `## Closing condition` section —
  # heading text may carry trailing prose (e.g. "## Closure condition,
  # stated as an observable per #878") — captured until the next heading
  # line of ANY level or end-of-body (a heuristic line-scan, not a full
  # markdown parser — matches this hook family's existing style). Falls
  # back to a bare `[Cc]loses when …` line anywhere in the body when no
  # such section exists.
  SECTION="$(awk '
    /^#+[[:space:]].*([Cc]losure|[Cc]losing)[[:space:]]+[Cc]ondition/ {
      if (insection) { exit }
      insection = 1
      next
    }
    insection && /^#+[[:space:]]/ { exit }
    insection { print }
  ' <<<"$BODY" | sed '/^[[:space:]]*$/d' || true)"

  CONDITION_TEXT=""
  if [[ -n "$SECTION" ]]; then
    CONDITION_TEXT="$SECTION"
  else
    LINE="$(grep -iE 'closes when' <<<"$BODY" | head -1 || true)"
    if [[ -n "$LINE" ]]; then
      # Strip a wrapping markdown emphasis marker (`**`/`_`) at the line's
      # own start/end, if present — cosmetic only.
      CONDITION_TEXT="$(sed -E 's/^[[:space:]]*[*_]{1,2}//; s/[*_]{1,2}[[:space:]]*$//' <<<"$LINE")"
    fi
  fi

  # Truncate defensively — this is meant to be a short definition-of-done
  # statement, but an unbounded body section shouldn't blow up the
  # injected context. Mirrors the `cut -c1-120`-style truncation used
  # elsewhere in this hook family (check-close-keyword.sh's APIERROR
  # diagnostics), widened here since a condition is meant to be read in
  # full, not just diagnosed.
  if [[ ${#CONDITION_TEXT} -gt 1000 ]]; then
    CONDITION_TEXT="${CONDITION_TEXT:0:1000}…[truncated]"
  fi

  if [[ -n "$CONDITION_TEXT" ]]; then
    CONTEXT_MSG="This issue (#${ISSUE_NUMBER}) states its own closing condition — verify it is actually met before this close proceeds (this hook surfaces the condition; it does not adjudicate whether it holds):

${CONDITION_TEXT}

Refs groundnuty/macf#1231 (why this is surfaced), #1221 (the premature-close instances that motivated it)."
  else
    CONTEXT_MSG="MACF close-condition guard: no stated closing condition found in issue #${ISSUE_NUMBER}'s body — proceeding. Refs groundnuty/macf#1231."
  fi
fi

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
