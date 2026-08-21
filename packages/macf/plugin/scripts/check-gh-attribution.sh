#!/usr/bin/env bash
#
# check-gh-attribution.sh — Claude Code PostToolUse hook that, AFTER a
# `gh`-write Bash op, verifies the just-written GitHub resource (issue /
# PR / comment) was authored by the BOT, not the operator's user account.
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

# ── Is this a gh-write op that produces an attributable resource? ─────────
# Match the write subcommands whose output carries a resource/comment URL:
#   gh issue comment / gh pr comment   → posts a comment
#   gh issue create  / gh pr create    → creates the resource
#   gh issue close … --comment         → posts a closing comment
#   gh pr close    … --comment         → posts a closing comment
# A bare `gh issue close` (no --comment) writes nothing attributable → skip.
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
is_gh_write "$COMMAND" || exit 0

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
    local out rc=0
    out="$(gh "$@" 2>/dev/null)" || rc=$?
    printf '%s' "$out"
    [[ "$rc" -eq 0 ]] && return 0
    return 2
  }
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
  resp="$(GH_PAGER= macf_hook_gh api "$API_PATH" --jq '{login: .user.login, type: .user.type}')" || rc=$?
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

NORM_ACTUAL="$(normalize_login "$ACTUAL_LOGIN")"

# ── Decide: OK vs MISMATCH ────────────────────────────────────────────────
MISMATCH=0
if [[ -n "$EXPECTED_LOGIN" ]]; then
  NORM_EXPECTED="$(normalize_login "$EXPECTED_LOGIN")"
  if [[ "$NORM_ACTUAL" == "$NORM_EXPECTED" ]]; then
    exit 0
  fi
  # Mismatch. Trap if the expectation is AUTHORITATIVE (env / bot_login — a
  # different author, even a Bot, is wrong), OR a User authored it (the
  # Instance-12 trap, regardless of source). A Bot author that only mismatches
  # a NON-authoritative agent_name guess is the name!=slug case (macf#535) → ok.
  if [[ "$EXPECTED_AUTHORITATIVE" == "1" || "$ACTUAL_TYPE" != "Bot" ]]; then
    MISMATCH=1
  else
    exit 0
  fi
else
  # No expected login known — best verifiable signal is the author TYPE.
  # A Bot authored it → trust it (some bot posted; correct by design).
  # A User authored it → the Instance-12 trap (a human account wrote it).
  if [[ "$ACTUAL_TYPE" == "Bot" ]]; then
    exit 0
  fi
  MISMATCH=1
fi

[[ "$MISMATCH" -ne 1 ]] && exit 0

# ── MISMATCH → loud warning to stderr, then exit 2 ────────────────────────
EXPECTED_LINE="(unknown — set \$MACF_EXPECTED_BOT_LOGIN or .macf/macf-agent.json)"
if [[ -n "$EXPECTED_LOGIN" ]]; then
  EXPECTED_LINE="$EXPECTED_LOGIN"
fi

cat >&2 <<ERR
WARNING (MACF attribution-result check): the GitHub resource you just wrote
appears to be authored by the WRONG account — the silent-fallback Instance-12
attribution trap (a \`gh\` write fell back to the operator's USER auth instead
of the bot installation token).

Resource:        ${URL}
Authored by:     ${ACTUAL_LOGIN} (type: ${ACTUAL_TYPE:-unknown})
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

  2. If the resource has NOT been replied-to yet, delete the mis-attributed
     write and re-post it as the bot (clean correction).
  3. If it HAS already been replied-to / acted-on, do NOT delete — post a
     short clarify-forward correction comment AS THE BOT noting the prior
     write was mis-attributed, so the thread stays coherent.

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
