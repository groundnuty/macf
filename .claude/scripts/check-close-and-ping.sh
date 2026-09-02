#!/usr/bin/env bash
#
# check-close-and-ping.sh — Claude Code PreToolUse hook (groundnuty/macf#1385)
# that, at the moment of `gh issue close`, enumerates the still-OPEN issues
# whose own timeline cross-references the issue being closed — so the
# closer sees who is waiting on this close, without anyone remembering to
# check. The close-time-notification sibling of check-close-condition.sh
# (#1231/#1247, which surfaces the issue's OWN stated closing condition);
# this hook instead surfaces OTHER issues that referenced it and are still
# open — the "tell the waiters" half, not the "verify the condition" half.
#
# WHY: four agents each stranded an issue whose closing condition was met on
# a DIFFERENT issue, and nothing observed it: macf-science-agent#26 (3
# months), macf#640 (5 days), macf#789 (3 days), macf#1161 (3 days). This
# cannot be fixed by remembering, because the event that should prompt the
# memory (issue A closing) happens on a DIFFERENT issue (B) than the one
# whose closure gates it. The platform has no blocker edge to read this
# from — `GET /issues/N/dependencies` and `/blocked_by` both 404 (measured
# against #789; `/sub_issues` 200s as a control, so it's not an auth/scope
# gap, the edge genuinely doesn't exist). But the INVERSE edge exists: an
# issue's own timeline records every OTHER issue/PR that referenced it, via
# `cross-referenced` events (measured against #786: 20 timeline events, 9
# cross-referenced, one of which was #789 — the very issue that later
# stayed silently gated on #786's close for 3 days). At the moment of
# close, the waiter is enumerable from the issue being closed. The
# obligation belongs to the party already acting.
#
# WHAT IT DOES NOT DO: it does not post anything to GitHub, and it does not
# decide whether a referencing issue actually needs the close. It reads the
# closing issue's own timeline, keeps the `cross-referenced` events whose
# source is STILL OPEN, and surfaces those as candidates via the same
# allow+additionalContext PreToolUse contract check-close-condition.sh uses
# — the closer (a Claude Code agent, mid-turn) is the one who decides
# whether and how to actually ping each candidate (e.g. `gh issue comment`
# with an @mention per coordination.md).
#
# THE OPEN FILTER IS NOT A HEURISTIC — it's a fact about the domain, using a
# field already in the payload (`.source.issue.state`). A closed issue is
# definitionally not waiting on this close anymore. Measured against #786:
# 9 cross-referenced sources → 7 already MERGED/CLOSED → 2 real candidates.
# Without the filter, every close of a heavily-referenced issue would spam
# a pile of dead links — exactly the noise class `macf-actions#74` names in
# the routing layer, and the reason #1385 declined a SECOND filter (grepping
# referencing bodies for gate-language near the number): that filter would
# narrow 2 candidates to 1, but it is a rule about TEXT pretending to be a
# rule about MEANING, and its failure mode is silent — it drops a waiter and
# nobody learns. A false positive here costs a moment's skim; a false
# negative costs days (four documented instances). This inverts the
# "prefer under-coverage" reasoning that governs the BLOCKING hooks in this
# family (check-gh-token.sh / check-lgtm-gate.sh / check-close-keyword.sh):
# a guard that false-positives gets disabled and you lose everything it
# catches; a ping that false-positives just gets skimmed. Under-coverage is
# the rule for mechanisms that can be turned off — a ping is not one. So
# THIS hook keeps the OPEN filter (cheap, definitional, zero false
# negatives on the domain fact it checks) and stops there.
#
# NEVER BLOCKS, SAME POSTURE AS #1247: this hook always allows the close.
# Its only job is putting the still-open waiters on screen before the close
# completes — not deciding whether to close, and not deciding whether to
# actually ping any of them.
#
# TRUE SILENCE ON NO CANDIDATES — a deliberate divergence from
# check-close-condition.sh (which always emits a note, even a "no stated
# closing condition found" one). This hook follows its OTHER sibling's
# precedent instead: check-close-condition-create.sh emits nothing at all
# when there is nothing to surface, because most issues have none and
# printing a "nothing to report" note on every close would itself become
# the noise this hook exists to avoid ("no candidates → silent" is #1385's
# own acceptance criterion). Same reasoning also covers infrastructure
# failure (missing gh, network error, API error): this hook fails OPEN and
# SILENT — the close proceeds either way, and an intermittent fetch failure
# is not something worth surfacing on every affected close when the whole
# point is not training the override reflex.
#
# HOW IT SURFACES CANDIDATES: identical mechanism to check-close-condition.sh
# — the structured PreToolUse JSON contract on stdout:
#   {"hookSpecificOutput": {"hookEventName": "PreToolUse",
#     "permissionDecision": "allow", "additionalContext": "<candidates text>"}}
# `additionalContext` is the field Claude Code injects into the closer's own
# context even on an allow decision.
#
# Hook contract (PreToolUse): JSON on stdin, exit 0 ALWAYS. stdout carries
# the structured hookSpecificOutput JSON ONLY when at least one still-open
# candidate was found; otherwise stdout is empty.
#
# Override: MACF_SKIP_CLOSE_PING_CHECK=1 bypasses (no context injection at
# all — cheap exit, no stdin read), per the check-*.sh family's
# MACF_SKIP_* convention.
#
# Refs: groundnuty/macf#1385 (this hook); macf-science-agent#26 (where the
#       platform check and the filter measurement were done); macf#640,
#       #789, #1161 (three of the four stranded-waiter instances); #1289
#       (the reporter-side stall sweep this sits beside); macf-actions#74
#       (the same noise problem in the routing layer — the reason the OPEN
#       filter matters and a second text-heuristic filter was declined);
#       check-close-condition.sh (#1231/#1247 — the sibling this hook's
#       wrapper coverage, gh-token-refresh sourcing, and issue/repo
#       extraction are copied from verbatim); check-close-condition-create.sh
#       (#1248 — the true-silence-on-nothing-to-report precedent this hook
#       follows instead); assert-the-wrong-path.md (the decisive-test-pair
#       discipline this hook's own tests follow).
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_CLOSE_PING_CHECK:-}" == "1" ]]; then
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

# Wrapper-aware match for `gh issue close`. Identical to check-close-
# condition.sh's own pattern (itself mirroring check-close-keyword.sh) —
# covers sudo, env VAR=, watch, ionice, setsid, nice, time prefix wrappers +
# chained-form leadins `;` `|` `&` `(` (subshell) + bare `VAR=val gh ...`.
GH_CLOSE_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+issue[[:space:]]+close([[:space:]]|$)'

# Shell-wrapper bypass: `bash -c "gh issue close ..."` and variants.
SHELL_C_GH_CLOSE_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]+issue[[:space:]]+close([[:space:]]|$)'

if [[ ! "$COMMAND" =~ $GH_CLOSE_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_GH_CLOSE_PATTERN ]]; then
  exit 0
fi

# ── Extract the issue number + --repo (if given) ─────────────────────────
# Identical to check-close-condition.sh's own extraction (`gh issue close
# --help`'s flag set: -c/--comment, --duplicate-of, -r/--reason, -R/--repo,
# all value-taking; no boolean flags exist on this subcommand).
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
# quotes or a subshell — same as check-close-condition.sh.
REPO_VALUE="$(sed -E "s/[\"');\`]+\$//" <<<"$REPO_VALUE" 2>/dev/null || echo "$REPO_VALUE")"

# `gh api` has no `--repo` flag of its own; it instead supports literal
# `{owner}`/`{repo}` placeholders that it resolves from the current
# directory's git remote when no explicit repo was given on the close
# command — the `gh api`-native equivalent of `gh issue view`'s own --repo
# auto-detection that check-close-condition.sh relies on.
if [[ -n "$REPO_VALUE" ]]; then
  TIMELINE_PATH="repos/${REPO_VALUE}/issues/${ISSUE_NUMBER}/timeline"
else
  TIMELINE_PATH="repos/{owner}/{repo}/issues/${ISSUE_NUMBER}/timeline"
fi

# ── Fetch inbound cross-referenced timeline events ───────────────────────
# `--paginate` follows the Link header across pages (a heavily-referenced
# issue's timeline can exceed the 30-event default page size); `--jq` runs
# once per page and gh already emits one compact JSON object per line, so
# concatenating pages is safe to feed straight into `jq -s` below.
TIMELINE_NDJSON=""
GH_RC=0
TIMELINE_NDJSON="$(macf_hook_gh api "$TIMELINE_PATH" --paginate --jq '
  .[] | select(.event == "cross-referenced" and .source.issue != null)
      | {number: .source.issue.number,
         repo: .source.issue.repository.full_name,
         state: .source.issue.state}
')" || GH_RC=$?

if [[ "$GH_RC" -ne 0 ]]; then
  # Infrastructure error (network, auth, missing issue, gh missing) — fail
  # open AND silent. See the header's "TRUE SILENCE" note: this hook never
  # blocks either way, and an intermittent fetch failure is not worth
  # surfacing on every affected close.
  exit 0
fi

# Filter to still-OPEN sources, dedupe (a source issue can cross-reference
# the same target more than once — e.g. once from its body, once from a
# comment — which produces multiple `cross-referenced` events for the same
# source), and drop the self-reference edge case (an issue does not
# normally show up in its own timeline, but the filter costs nothing and
# closes off a degenerate loop if it ever did).
OPEN_CANDIDATES="[]"
if [[ -n "$TIMELINE_NDJSON" ]]; then
  OPEN_CANDIDATES="$(jq -s --argjson selfnum "$ISSUE_NUMBER" '
    map(select(.state == "open"))
    | map(select(.number != $selfnum))
    | unique_by(.repo + "#" + (.number | tostring))
  ' <<<"$TIMELINE_NDJSON" 2>/dev/null)" || OPEN_CANDIDATES="[]"
fi

CANDIDATE_COUNT="$(jq 'length' <<<"$OPEN_CANDIDATES" 2>/dev/null || echo 0)"
if [[ -z "$CANDIDATE_COUNT" || "$CANDIDATE_COUNT" -eq 0 ]]; then
  # No still-open waiters — true silence, no output at all. See header.
  exit 0
fi

# ── Build the candidate list text ─────────────────────────────────────────
# Each line names the candidate AND states WHY it was surfaced, per #1385's
# own acceptance criterion: a bare "#786 closed" trains the recipient to
# treat the next ping as noise, which turns a two-ping budget into a
# zero-ping one. `<repo>` is included on each candidate line whenever it
# differs from the repo the close targeted (or always, when the close's own
# repo could not be resolved without an extra API round trip) — cheap,
# unambiguous, never wrong to include.
CANDIDATE_LINES="$(jq -r --arg selfrepo "$REPO_VALUE" --arg selfnum "$ISSUE_NUMBER" '
  .[]
  | (if ($selfrepo != "" and .repo == $selfrepo) then "#\(.number)" else "\(.repo)#\(.number)" end) as $ref
  | "- \($ref) — #\($selfnum) closed; you referenced it and are still open."
' <<<"$OPEN_CANDIDATES" 2>/dev/null)" || CANDIDATE_LINES=""

if [[ -z "$CANDIDATE_LINES" ]]; then
  # Defensive — CANDIDATE_COUNT was non-zero but text construction produced
  # nothing (a jq/formatting failure). Fail open and silent rather than
  # emit a broken/empty context block.
  exit 0
fi

CONTEXT_MSG="Closing #${ISSUE_NUMBER} leaves still-open issues waiting on it. The following referenced #${ISSUE_NUMBER} in their own timeline and have not yet closed — consider pinging each with an @mentioned comment (coordination.md §Communication 1) once this close lands:

${CANDIDATE_LINES}

Refs groundnuty/macf#1385 (why this is surfaced), check-close-condition.sh #1231/#1247 (the sibling this mirrors)."

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
