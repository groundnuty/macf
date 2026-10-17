#!/usr/bin/env bash
#
# check-gh-attribution.sh — Claude Code PostToolUse hook that, AFTER a
# `gh`-write Bash op, verifies the just-written GitHub resource (issue /
# PR / comment / review / merge) was authored by the BOT, not the operator's user account.
# A user-attributed write is the silent-fallback Instance-12 attribution
# trap: the `gh` call fell back to stored `gh auth login` (user) because
# GH_TOKEN was empty / a `ghp_`/`gho_`/`ghu_` user token / the literal
# string "null", and nothing surfaced the mismatch at the time. The
# #140 PreToolUse `check-gh-token.sh` catches the *missing-bot-token*
# shape BEFORE the call; this hook is the result-invariant backstop that
# catches a slipped write AFTER the fact by reading who actually authored
# the resource on GitHub.
#
# Hook contract (PostToolUse): JSON on stdin, exit 0 = ok. PostToolUse
# CANNOT block (the tool already ran) — the loud signal is `exit 2` with a
# multi-line stderr message, which Claude Code surfaces back to Claude.
# Read both the newer (`.tool_output.stdout`) and older
# (`.tool_response.stdout` / `.tool_response`) output shapes defensively.
#
# Posture: FAIL-OPEN. `set -uo pipefail` (NOT `-e`) — every uncertain
# branch (no URL, gh failure, can't parse, can't resolve expected login)
# exits 0. A false WARN is more costly than a missed one here: the call
# already happened, and the operator may be running a knowingly
# user-attributed op. Only a CONFIRMED user-authored write fires `exit 2`.
#
# Override: MACF_SKIP_ATTRIBUTION_CHECK=1 bypasses (intentional
# user-attributed ops, e.g. an onboarding `gh` call before the bot token
# is wired). Consistent with MACF_SKIP_TOKEN_CHECK / MACF_SKIP_CLOSE_CHECK
# in the sister hooks.
#
# Refs: groundnuty/macf#489 (this hook); silent-fallback-hazards.md
#       Instance 12; coordination.md §Token & Git Hygiene (the attribution
#       trap); #140 / #244+#272 / #270 / #431 (sister Path-2 hooks);
#       groundnuty/macf#938 (routes the author lookup through a credential-
#       refresh wrapper — see query_author() below; this hook's fail-open
#       posture is unchanged, since PostToolUse cannot block a write that
#       already happened — the fix is visibility, not enforcement).
set -uo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_ATTRIBUTION_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Defense-in-depth: any unexpected error past this point must NOT brick the
# harness. We already use `set -uo pipefail` (no `-e`) so commands that fail
# are handled explicitly; this trap is a final safety net for a genuinely
# unexpected fault (e.g. a bash internal error) — fail open.
trap 'exit 0' ERR

# Read the PostToolUse payload. Fall through to allow on parse error.
INPUT_JSON="$(cat)"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
[[ -z "$COMMAND" ]] && exit 0
# The directory the command ran in (Claude Code passes it in the payload).
CWD="$(jq -r '.cwd // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

# ── Is this a gh-write op that produces an attributable resource? ─────────
# Match the write subcommands whose output carries a resource/comment URL:
#   gh issue comment / gh pr comment   → posts a comment
#   gh issue create  / gh pr create    → creates the resource
#   gh issue close … --comment         → posts a closing comment
#   gh pr close    … --comment         → posts a closing comment
#   gh pr review                       → posts a review (no URL in output)
#   gh api -X PUT …/pulls/<N>/merge    → merges (no URL in output)
# A bare `gh issue close` (no --comment) writes nothing attributable → skip.
# The review and the API merge print no URL, so the hook reads every review
# on the PR from the last five minutes (the window), or the PR's merged_by,
# instead of a URL from the output.
# This is a RESULT check (not a blocker), so a simple wrapper-tolerant
# `grep -qE` over the raw command suffices — we don't need the airtight
# bypass-resistant regex the PreToolUse blockers carry.
is_gh_write() {
  local cmd="$1"
  if grep -qiE 'gh[[:space:]]+(issue|pr)[[:space:]]+comment([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  if grep -qiE 'gh[[:space:]]+(issue|pr)[[:space:]]+create([[:space:]]|$)' <<<"$cmd"; then
    return 0
  fi
  # close … --comment (the --comment may appear anywhere after the verb)
  if grep -qiE 'gh[[:space:]]+(issue|pr)[[:space:]]+close([[:space:]]|$)' <<<"$cmd" \
     && grep -qiE '(^|[[:space:]])--comment([[:space:]]|=|$)' <<<"$cmd"; then
    return 0
  fi
  return 1
}

# `gh pr review` posts a review and prints no URL.
is_pr_review() {
  grep -qiE 'gh[[:space:]]+pr[[:space:]]+review([[:space:]]|$)' <<<"$1"
}
# `gh api -X PUT repos/<o>/<r>/pulls/<N>/merge` merges and prints JSON or a sha.
MERGE_PATH_RE='(^|[[:space:]"'"'"'])/?repos/([^/[:space:]"'"'"']+)/([^/[:space:]"'"'"']+)/pulls/([0-9]+)/merge([[:space:]"'"'"'?]|$)'
is_api_merge() {
  grep -qiE 'gh[[:space:]]+api[[:space:]]' <<<"$1" \
    && grep -qE "$MERGE_PATH_RE" <<<"$1" \
    && grep -qiE '(^|[[:space:]])(-X[[:space:]]*|--method[[:space:]=]+)PUT([[:space:]]|$)' <<<"$1"
}

# Split a command into shell-style words WITHOUT evaluating anything: single
# quotes are literal, double quotes honour \", a backslash outside quotes
# escapes the next char, unquoted whitespace splits. Each unquoted ; | & run
# is emitted as a lone \001 line. One token per line; newlines become spaces.
shell_tokens() {
  MACF_CMD="$1" awk 'BEGIN {
    s = ENVIRON["MACF_CMD"]; n = length(s); tok = ""; intok = 0; q = ""
    for (i = 1; i <= n; i++) {
      c = substr(s, i, 1)
      if (q == "\047") { if (c == "\047") q = ""; else tok = tok c; continue }
      if (q == "\"") {
        if (c == "\\" && substr(s, i + 1, 1) == "\"") { tok = tok "\""; i++ }
        else if (c == "\"") q = ""
        else tok = tok c
        continue
      }
      if (c == "\047" || c == "\"") { q = c; intok = 1; continue }
      if (c == "\\") {
        nx = substr(s, i + 1, 1); i++
        if (nx != "\n") { tok = tok nx; intok = 1 }
        continue
      }
      if (c == " " || c == "\t" || c == "\n") { flush(); continue }
      if (c == ";" || c == "|" || c == "&") { flush(); print "\001"; continue }
      tok = tok c; intok = 1
    }
    flush()
  }
  function flush() {
    if (intok) { gsub("\n", " ", tok); print tok }
    tok = ""; intok = 0
  }'
}

# Parse `gh pr review …` into OWNER/REPO/NUM. Quoted strings are kept as
# single tokens; only the value after --body/-b/--body-file/-F is skipped, so
# a number inside a body is never read as the PR number. The PR number is the
# first positional; a PR URL there also gives the repo.
parse_pr_review() {
  local tok want="" started=0 prev1="" prev2="" sep
  sep=$'\001'
  while IFS= read -r tok; do
    if [[ "$started" -eq 0 ]]; then
      if [[ "$prev2" == "gh" && "$prev1" == "pr" && "$tok" == "review" ]]; then
        started=1
      elif [[ "$tok" == "cd" || "$tok" == "pushd" ]]; then
        SAW_CD=1
      fi
      prev2="$prev1"; prev1="$tok"
      continue
    fi
    [[ "$tok" == "$sep" ]] && break
    case "$want" in
      repo) REPO_FLAG="$tok"; want=""; continue ;;
      skip) want=""; continue ;;
    esac
    case "$tok" in
      --repo|-R) want="repo" ;;
      --repo=*) REPO_FLAG="${tok#--repo=}" ;;
      -R?*) REPO_FLAG="${tok#-R}" ;;
      --body|-b|--body-file|-F) want="skip" ;;
      -*) ;;
      *)
        [[ -n "$NUM" ]] && continue
        if [[ "$tok" =~ ^https://github\.com/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)/pull/([0-9]+) ]]; then
          OWNER="${BASH_REMATCH[1]}"; REPO="${BASH_REMATCH[2]}"; NUM="${BASH_REMATCH[3]}"
        elif [[ "$tok" =~ ^[0-9]+$ ]]; then
          NUM="$tok"
        fi
        ;;
    esac
  done < <(shell_tokens "$1")
}

MODE=""
OWNER=""; REPO=""; NUM=""; REPO_FLAG=""; SAW_CD=0
if is_gh_write "$COMMAND"; then
  MODE="generic"
elif is_pr_review "$COMMAND"; then
  MODE="review"
elif is_api_merge "$COMMAND"; then
  MODE="merge"
else
  exit 0
fi

if [[ "$MODE" == "generic" ]]; then
  # ── Extract the resource URL from the tool output ─────────────────────────
  # `gh issue create` / `gh pr create` print the new URL on stdout; `gh issue
  # comment` / `gh pr comment` print the comment URL (…#issuecomment-<id>).
  # Read both PostToolUse output shapes (newer `.tool_output.stdout`, older
  # `.tool_response.stdout`, oldest `.tool_response` as a raw string).
  OUTPUT="$(jq -r '.tool_output.stdout // .tool_response.stdout // .tool_response // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
  [[ -z "$OUTPUT" ]] && exit 0

  URL="$(grep -oE 'https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/(issues|pull)/[0-9]+(#issuecomment-[0-9]+)?' <<<"$OUTPUT" | head -1 || true)"
  # No URL in output (e.g. `--json` suppressed it, or output was discarded) →
  # fail open. We can't verify what we can't see.
  [[ -z "$URL" ]] && exit 0

  # ── Parse the URL → owner / repo / kind / number / optional comment-id ────
  # Form: https://github.com/<owner>/<repo>/(issues|pull)/<N>[#issuecomment-<id>]
  URL_PATH="${URL#https://github.com/}"
  OWNER="$(cut -d/ -f1 <<<"$URL_PATH")"
  REPO="$(cut -d/ -f2 <<<"$URL_PATH")"
  KIND="$(cut -d/ -f3 <<<"$URL_PATH")"          # issues | pull
  NUM_AND_FRAG="$(cut -d/ -f4 <<<"$URL_PATH")"  # <N> | <N>#issuecomment-<id>
  NUM="${NUM_AND_FRAG%%#*}"
  COMMENT_ID=""
  if [[ "$NUM_AND_FRAG" == *"#issuecomment-"* ]]; then
    COMMENT_ID="${NUM_AND_FRAG##*#issuecomment-}"
  fi
  # Sanity — if any required piece is missing/odd, fail open.
  [[ -z "$OWNER" || -z "$REPO" || -z "$KIND" || -z "$NUM" ]] && exit 0

  # ── Build the ACTUAL-resource API path ────────────────────────────────────
  # Comment-id present → both issue AND pr comments live under the issues
  # comments namespace; else a PR → pulls/<N>; else an issue → issues/<N>.
  if [[ -n "$COMMENT_ID" ]]; then
    API_PATH="/repos/${OWNER}/${REPO}/issues/comments/${COMMENT_ID}"
  elif [[ "$KIND" == "pull" ]]; then
    API_PATH="/repos/${OWNER}/${REPO}/pulls/${NUM}"
  else
    API_PATH="/repos/${OWNER}/${REPO}/issues/${NUM}"
  fi

fi

# ── review / merge: no URL in the output — locate the PR from the command ─
AUTHOR_JQ='{login: .user.login, type: .user.type}'
if [[ "$MODE" == "review" ]]; then
  parse_pr_review "$COMMAND"
  [[ -z "$NUM" ]] && exit 0
  if [[ -n "$REPO_FLAG" && "$REPO_FLAG" == */* ]]; then
    REPO_FLAG="${REPO_FLAG#https://github.com/}"
    OWNER="$(cut -d/ -f1 <<<"$REPO_FLAG")"
    REPO="$(cut -d/ -f2 <<<"$REPO_FLAG")"
  fi
elif [[ "$MODE" == "merge" ]]; then
  if [[ "$COMMAND" =~ $MERGE_PATH_RE ]]; then
    OWNER="${BASH_REMATCH[2]}"; REPO="${BASH_REMATCH[3]}"; NUM="${BASH_REMATCH[4]}"
  fi
  [[ -z "$OWNER" || -z "$REPO" || -z "$NUM" ]] && exit 0
fi

# hook-gh-token.sh is copied alongside this file by every distribution path,
# so it should always be right here — but a `source` of a missing file would
# leave macf_hook_gh undefined and the call below would fail confusingly.
# Guard it: if the sibling is somehow missing (a stale or partial
# distribution), degrade to a plain, non-refreshing gh call instead — this
# hook's fail-open posture is unaffected either way, it's already the
# terminal outcome of every failure branch here.
HOOK_GH_TOKEN_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hook-gh-token.sh"
if [[ -r "$HOOK_GH_TOKEN_LIB" ]]; then
  # shellcheck source=./hook-gh-token.sh
  source "$HOOK_GH_TOKEN_LIB"
else
  echo "MACF attribution-result check: the credential-refresh helper library is missing from this workspace's scripts — running without token refresh. Update this workspace to pick up the missing file." >&2
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

# ── review / merge: resolve the repo (gh's own default if none given) ─────
if [[ "$MODE" == "review" || "$MODE" == "merge" ]]; then
  if [[ -z "$OWNER" || -z "$REPO" ]]; then
    # A cd/pushd earlier in the command may have moved gh to another repo.
    [[ "$SAW_CD" == "1" ]] && exit 0
    NWO="$( [[ -n "$CWD" && -d "$CWD" ]] && cd "$CWD"; GH_PAGER= macf_hook_gh repo view --json nameWithOwner -q .nameWithOwner)" || exit 0
    [[ "$NWO" == */* ]] || exit 0
    OWNER="$(cut -d/ -f1 <<<"$NWO")"
    REPO="$(cut -d/ -f2 <<<"$NWO")"
  fi
  if [[ "$MODE" == "review" ]]; then
    URL="the latest review on ${OWNER}/${REPO}#${NUM}"
    API_PATH="/repos/${OWNER}/${REPO}/pulls/${NUM}/reviews?per_page=100"
    # One line per review, every page; the latest is picked in query_author.
    AUTHOR_JQ='.[] | [.submitted_at, .user.login, .user.type] | @tsv'
  else
    URL="the merge of ${OWNER}/${REPO}#${NUM}"
    API_PATH="/repos/${OWNER}/${REPO}/pulls/${NUM}"
    AUTHOR_JQ='{login: (.merged_by.login // ""), type: (.merged_by.type // ""), merged: (.merged // false), merged_at: (.merged_at // "")}'
  fi
fi

# ── Query the author (short timeout; one brief retry for API consistency) ─
# The resource was JUST created, so a first read can occasionally race the
# write through GitHub's read replicas. One `sleep 1` retry handles that
# without materially delaying the turn. gh failure / empty → fail open.
#
# groundnuty/macf#938: routed through macf_hook_gh (hook-gh-token.sh) so a
# merely-EXPIRED ambient token (this PostToolUse hook, like its siblings,
# inherits the session's 1-hour installation token) gets one refresh-and-
# retry before falling back to this hook's pre-existing fail-open posture.
# That posture is UNCHANGED here — this hook cannot block (the write it's
# checking already happened), so "could not verify" and "verified fine"
# both end in exit 0 either way. What changes is visibility: on an
# unrefreshable auth failure, a diagnostic now goes to stderr instead of
# silently doing nothing, so "the check never actually ran this time" is
# distinguishable from "the check ran and found no mismatch" in the log.
query_author() {
  local resp rc=0
  if [[ "$MODE" == "review" ]]; then
    resp="$(GH_PAGER= macf_hook_gh api --paginate "$API_PATH" --jq "$AUTHOR_JQ")" || rc=$?
    if [[ "$rc" -eq 0 && -n "$resp" ]]; then
      # Keep only reviews submitted within the window: an older review (or a
      # concurrent one) is not evidence about what this command posted.
      resp="$(printf '%s\n' "$resp" | jq -rR --argjson now "$(date -u +%s)" \
        --argjson win "${MACF_ATTRIBUTION_WINDOW_SEC:-300}" \
        'split("\t") | select((try (.[0] | fromdateiso8601) catch 0) > ($now - $win)) | @tsv' \
        2>/dev/null | LC_ALL=C sort -t$'\t' -k1,1 || true)"
    fi
  else
    resp="$(GH_PAGER= macf_hook_gh api "$API_PATH" --jq "$AUTHOR_JQ")" || rc=$?
  fi
  printf '%s' "$resp"
  return "$rc"
}
RC=0
RESP="$(query_author)" || RC=$?
if [[ "$RC" -eq 2 ]]; then
  # other_failed (network / 404 / read-replica lag on a just-created
  # resource, etc.) — retry once after a short pause, unchanged from
  # before this fix. Skipped for auth_failed (RC=1): macf_hook_gh already
  # attempted a refresh + retry internally, so an immediate second attempt
  # here would just repeat the same failed dance.
  sleep 1
  RC=0
  RESP="$(query_author)" || RC=$?
fi

if [[ "$RC" -eq 1 ]]; then
  echo "MACF attribution-result check: could not verify this write's author — ${RESP:-no diagnostic available}. This check did not run (exit code is unaffected — this hook cannot block a write that already happened)." >&2
  exit 0
fi

[[ -z "$RESP" ]] && exit 0

# review: RESP holds the recent reviews, oldest first. None → nothing was
# posted (or we cannot tell). Otherwise judge them all below and warn about
# the most recent one.
RECENT_REVIEWS=""
if [[ "$MODE" == "review" ]]; then
  RECENT_REVIEWS="$RESP"
  RESP="$(printf '%s\n' "$RECENT_REVIEWS" | tail -n 1 \
    | jq -R 'split("\t") | {login: (.[1] // ""), type: (.[2] // "")}' 2>/dev/null || true)"
  [[ -z "$RESP" ]] && exit 0
fi

if [[ "$MODE" == "merge" ]]; then
  # The merge failed or was refused: nothing was merged, nothing to check.
  [[ "$(jq -r '.merged // false' <<<"$RESP" 2>/dev/null || echo false)" == "true" ]] || exit 0
  # An older merge is not evidence about this command: a failed retry on a PR
  # merged earlier proves nothing. Same window as the review path.
  jq -e --argjson now "$(date -u +%s)" --argjson win "${MACF_ATTRIBUTION_WINDOW_SEC:-300}" \
    '(try (.merged_at | fromdateiso8601) catch 0) > ($now - $win)' <<<"$RESP" >/dev/null 2>&1 || exit 0
fi

ACTUAL_LOGIN="$(jq -r '.login // ""' <<<"$RESP" 2>/dev/null || echo "")"
ACTUAL_TYPE="$(jq -r '.type // ""' <<<"$RESP" 2>/dev/null || echo "")"
# Couldn't extract an author at all → fail open.
[[ -z "$ACTUAL_LOGIN" ]] && exit 0

# ── Resolve the EXPECTED bot login + whether it is AUTHORITATIVE ──────────
# AUTHORITATIVE sources (a mismatch is a real trap, even vs a different Bot):
#   1. $MACF_EXPECTED_BOT_LOGIN — explicit operator/test override.
#   2. .macf/macf-agent.json `.github_app.bot_login` — the App's real bot login
#      (App slug + `[bot]`), written by macf init/doctor (DR-028). Authoritative.
# NON-authoritative HINT:
#   3. .macf/macf-agent.json `.agent_name` / `.app_name` — a derived guess that
#      assumes agent_name == App slug, which is NOT always true (macf#535: the
#      auditor's agent_name is "auditor" but its App slug is macf-auditor-agent).
#      A mismatch on this guess is trapped ONLY when a User authored it (the
#      Instance-12 trap); a Bot author that just doesn't match the guess is the
#      name!=slug case and is allowed (no false positive).
#   4. empty — fall back to the type-based check below.
EXPECTED_LOGIN="${MACF_EXPECTED_BOT_LOGIN:-}"
EXPECTED_AUTHORITATIVE=0
[[ -n "$EXPECTED_LOGIN" ]] && EXPECTED_AUTHORITATIVE=1
if [[ -z "$EXPECTED_LOGIN" ]]; then
  AGENT_JSON="${CLAUDE_PROJECT_DIR:-.}/.macf/macf-agent.json"
  if [[ -f "$AGENT_JSON" ]]; then
    BOT_LOGIN="$(jq -r '.github_app.bot_login // .bot_login // ""' "$AGENT_JSON" 2>/dev/null || echo "")"
    if [[ -n "$BOT_LOGIN" ]]; then
      # Append `[bot]` exactly once (tolerate a config that already carries it).
      EXPECTED_LOGIN="${BOT_LOGIN%"[bot]"}[bot]"
      EXPECTED_AUTHORITATIVE=1
    else
      AGENT_NAME="$(jq -r '.agent_name // .app_name // ""' "$AGENT_JSON" 2>/dev/null || echo "")"
      if [[ -n "$AGENT_NAME" ]]; then
        # Non-authoritative guess (see note above) — leave AUTHORITATIVE=0.
        EXPECTED_LOGIN="${AGENT_NAME%"[bot]"}[bot]"
      fi
    fi
  fi
fi

# Normalize a login for comparison: strip a leading `app/` prefix (gh's
# GraphQL author.login carries `app/<name>`; the REST `.user.login` does
# not) and lowercase. Echoes the normalized form.
normalize_login() {
  local l="$1"
  l="${l#app/}"
  echo "${l,,}"
}

# Is this author acceptable? 0 = ok, 1 = mismatch (the trap).
#   A matching login is ok. Otherwise trap when the expectation is
#   AUTHORITATIVE (env / bot_login — a different author, even a Bot, is wrong)
#   or a User wrote it (the Instance-12 trap, whatever the source). A Bot that
#   only mismatches a NON-authoritative agent_name guess is the name!=slug
#   case (macf#535) → ok. With no expected login, a Bot is ok, a User is not.
author_ok() {
  local login type norm_expected
  login="$(normalize_login "$1")"; type="$2"
  if [[ -n "$EXPECTED_LOGIN" ]]; then
    norm_expected="$(normalize_login "$EXPECTED_LOGIN")"
    [[ "$login" == "$norm_expected" ]] && return 0
    if [[ "$EXPECTED_AUTHORITATIVE" == "1" || "$type" != "Bot" ]]; then
      return 1
    fi
    return 0
  fi
  [[ "$type" == "Bot" ]] && return 0
  return 1
}

# ── Decide: OK vs MISMATCH ────────────────────────────────────────────────
if [[ "$MODE" == "review" ]]; then
  # Any recent review by the expected identity means ours landed.
  while IFS=$'\t' read -r _ts r_login r_type; do
    author_ok "$r_login" "$r_type" && exit 0
  done <<<"$RECENT_REVIEWS"
fi
MISMATCH=0
author_ok "$ACTUAL_LOGIN" "$ACTUAL_TYPE" || MISMATCH=1

[[ "$MISMATCH" -ne 1 ]] && exit 0

# ── MISMATCH → loud warning to stderr, then exit 2 ────────────────────────
EXPECTED_LINE="(unknown — set \$MACF_EXPECTED_BOT_LOGIN or .macf/macf-agent.json)"
if [[ -n "$EXPECTED_LOGIN" ]]; then
  EXPECTED_LINE="$EXPECTED_LOGIN"
fi

AUTHOR_LABEL="Authored by:     "
[[ "$MODE" == "merge" ]] && AUTHOR_LABEL="Merged by:       "
case "$MODE" in
  merge)
    REPAIR_2="A merge cannot be redone; do not revert it. Comment on the PR as the bot that the
     merge ran under the wrong account."
    REPAIR_3="" ;;
  review)
    REPAIR_2="Submit the review again as the bot, then comment that the earlier one ran under the
     wrong account."
    REPAIR_3="" ;;
  *)
    REPAIR_2="If the resource has NOT been replied-to yet, delete the mis-attributed
     write and re-post it as the bot (clean correction)."
    REPAIR_3="
  3. If it HAS already been replied-to / acted-on, do NOT delete — post a
     short clarify-forward correction comment AS THE BOT noting the prior
     write was mis-attributed, so the thread stays coherent." ;;
esac

cat >&2 <<ERR
WARNING (MACF attribution-result check): the GitHub resource you just wrote
appears to be authored by the WRONG account — the silent-fallback Instance-12
attribution trap (a \`gh\` write fell back to the operator's USER auth instead
of the bot installation token).

Resource:        ${URL}
${AUTHOR_LABEL}${ACTUAL_LOGIN} (type: ${ACTUAL_TYPE:-unknown})
Expected (bot):  ${EXPECTED_LINE}

The tool already ran — this is a PostToolUse check, so the resource is live on
GitHub under the wrong attribution. Cross-agent routing keys off the bot login;
a user-attributed comment/issue/PR is invisible to peers and breaks the
reporter-owns-closure + @mention-routing contracts.

Repair:
  1. Refresh the bot token (fail-loud helper), THEN re-do the op as the bot:

       GH_TOKEN=\$("\$MACF_WORKSPACE_DIR/.claude/scripts/macf-gh-token.sh" \\
         --app-id "\$APP_ID" --install-id "\$INSTALL_ID" --key "\$KEY_PATH") || exit 1
       export GH_TOKEN

  2. ${REPAIR_2}${REPAIR_3}

Verify your identity any time:
  GH_TOKEN=\$GH_TOKEN "\$MACF_WORKSPACE_DIR/.claude/scripts/macf-whoami.sh"

Override (ONLY for intentional user-attributed ops, e.g. onboarding) is
launch-time / operator only: MACF_SKIP_ATTRIBUTION_CHECK is read from
THIS session's process env, fixed when ./claude.sh launched it. An
in-session \`export MACF_SKIP_ATTRIBUTION_CHECK=1\` from a Bash tool call
does NOT reach it — Bash-tool commands run in a separate subshell that
never persists into the session's env. To use it: set
MACF_SKIP_ATTRIBUTION_CHECK=1 in the launch env (or the workspace's
.claude/.macf/env.* files) BEFORE running ./claude.sh, then relaunch.
Need it mid-session? Ask the operator to set it + relaunch, or route the
specific op through the operator directly.

Refs: groundnuty/macf#489 (this hook); silent-fallback-hazards.md Instance 12;
coordination.md §Token & Git Hygiene.
ERR
exit 2
