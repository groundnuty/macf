#!/usr/bin/env bash
#
# check-lgtm-gate.sh — Claude Code PreToolUse hook that blocks
# `gh pr merge` invocations when no non-author APPROVED review exists
# on the target PR. Implements `pr-discipline.md` §"How to submit
# LGTM — formal review, not comment" + §"When the reviewer is absent
# or unreachable" structurally.
#
# Hook contract: JSON on stdin, exit 0 = allow, exit 2 = block (stderr
# is fed back to Claude as the error). Same shape as #140's
# check-gh-token.sh + #244/#272's check-mention-routing.sh per
# groundnuty/macf#270 design alignment.
#
# Architectural note (DR-023 amendment 2026-04-27, PR #279): this is a
# bash command-type hook, NOT `type: "mcp_tool"`. PreToolUse-blocking
# semantics + mcp_tool's non-blocking-on-disconnect failure mode are
# structurally incompatible — bash form fires uniformly across substrate
# (no macf-agent MCP server) AND consumer workspaces (startup window,
# transient disconnect). Same reasoning UC-4 (PR #275) demonstrated.
#
# Override: MACF_SKIP_LGTM_CHECK=1 bypasses (launch-time / operator only —
# per pr-discipline.md §"When the reviewer is absent or unreachable" —
# reporter-sanctioned self-merge, urgent revert, etc.).
#
# Operator-sanctioned exception, agent-usable (groundnuty/macf#822 Part 2,
# direction (c) — operator + science + auditor-advisory approved): when
# MACF_OPERATOR_LOGIN is configured (env.identity, from macf-agent.json
# `operator_login`), a PR comment authored by THAT login containing the
# exact marker `[macf-sanction-merge]` clears the gate — un-forgeable,
# since an agent cannot post a GitHub comment attributed to the operator's
# own account. Unset (the default) → this path is off and the gate
# behaves exactly as before #822 Part 2.
#
# Refs: groundnuty/macf#270 (this hook); pr-discipline.md (canonical
#       rule, distributed via `macf rules refresh`); DR-023 amendment
#       (bash-form decision rule); macf#262 / PR #263 (LGTM rule
#       codification); PR #275 / macf#244+#272 (empirical pattern);
#       groundnuty/macf#822 (operator-login sanction-comment path);
#       groundnuty/macf#938 (credential-refresh + auth-failure-fails-
#       closed — the ambient $GH_TOKEN is a 1-hour installation token,
#       so a long session's `gh pr view` call below can hit an
#       authentication failure that is unrelated to whether a review
#       exists; see the `macf_hook_gh` call below).
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_SKIP_LGTM_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read PreToolUse payload. Fall through to allow on parse error — a
# broken hook must not brick the harness. Same defense-in-depth as
# check-gh-token.sh.
INPUT_JSON="$(cat 2>/dev/null || echo "")"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

if [[ -z "$COMMAND" ]]; then
  # No command extractable — allow (defense-in-depth).
  exit 0
fi

# Wrapper-aware match for `gh pr merge`. Mirrors check-mention-routing.sh's
# pattern shape — covers sudo, env VAR=, watch, ionice, setsid, nice,
# time prefix wrappers + chained-form leadins `;` `|` `&`. Subcommand
# match: `gh pr merge` ONLY (NOT `gh pr view`, `gh pr list`, etc.) —
# trailing whitespace or end-of-string forces exact-subcommand match.
GH_MERGE_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'

# Shell-wrapper bypass: catches `bash -c "gh pr merge ..."` and variants.
# Same flag-handling logic as check-gh-token.sh + check-mention-routing.sh.
SHELL_C_GH_MERGE_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'

if [[ ! "$COMMAND" =~ $GH_MERGE_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_GH_MERGE_PATTERN ]]; then
  # Not a `gh pr merge` command — allow.
  exit 0
fi

# Extract PR number from the matched command. The PR number is the
# first non-flag positional argument after `gh pr merge`. Examples:
#   gh pr merge 123 --squash
#   gh pr merge --squash 123
#   gh pr merge 123 --repo owner/repo --squash --delete-branch
#   bash -c "gh pr merge 123 --squash"
# We scan the whole command for `gh pr merge` then walk forward to find
# the first bare integer token (not preceded by `=` so it's not a flag
# value like `--retries=3`).
PR_NUMBER=""
# Strip leading wrappers up to and including `gh pr merge`. Use sed
# with extended regex to find the gh-pr-merge prefix and remove it.
TAIL="$(sed -E 's/^.*gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+//' <<<"$COMMAND" 2>/dev/null || echo "")"
if [[ -z "$TAIL" ]]; then
  # No tail after `gh pr merge` — likely the operator is invoking with
  # no args (interactive prompt). Allow; the command will fail at gh
  # itself with a usage error, not silently merge anything.
  exit 0
fi

# Find the first bare-integer token. Skip flags (`--foo`, `-x`) and
# their values (handled via `[[ $prev == --* ]]` lookback for non-`=`
# flag-value form). We only need the FIRST PR number — `gh pr merge`
# only takes one positional.
PREV_FLAG=""
# shellcheck disable=SC2086
for tok in $TAIL; do
  # Flags introducing a value with a separate-arg form (e.g. `--repo X`)
  # — set PREV_FLAG so the next token is consumed as a value.
  if [[ -n "$PREV_FLAG" ]]; then
    PREV_FLAG=""
    continue
  fi
  # `--flag=value` form — single token, no lookahead needed.
  if [[ "$tok" =~ ^--[a-zA-Z0-9-]+= ]]; then
    continue
  fi
  # `--flag` without `=` — set PREV_FLAG to consume next token as value.
  # Boolean flags (e.g. `--squash`, `--delete-branch`) don't consume a
  # value, but we can't tell from the command alone — heuristic: the
  # first non-flag token AFTER any flags is the PR number, even if we
  # mistakenly skip a boolean's "value." If that "value" is the PR
  # number itself, we miss it; mitigation: gh's canonical positional
  # ordering is `gh pr merge <N> [flags]`, so PR-first is the common
  # form. The few cases that put flags first AND use boolean flags
  # without `=` are rare; fail-open is acceptable per defense-in-depth.
  if [[ "$tok" =~ ^-- ]]; then
    # Known value-taking flags from `gh pr merge --help`:
    #   --repo, --body, --body-file, --match-head-commit, --subject,
    #   --author-email
    # Boolean flags don't consume a value:
    #   --squash, --merge, --rebase, --delete-branch, --auto, --admin,
    #   --disable-auto
    case "$tok" in
      --repo|--body|--body-file|--match-head-commit|--subject|--author-email)
        PREV_FLAG="$tok"
        ;;
      *) ;;
    esac
    continue
  fi
  # Short flag — `-X`. Same boolean-vs-value ambiguity. `gh pr merge`
  # short flags from --help: `-s` (squash), `-m` (merge), `-r` (rebase),
  # `-d` (delete-branch), `-R` (repo, value-taking), `-b` (body, value),
  # `-F` (body-file, value), `-t` (subject, value).
  if [[ "$tok" =~ ^-[a-zA-Z]$ ]]; then
    case "$tok" in
      -R|-b|-F|-t)
        PREV_FLAG="$tok"
        ;;
      *) ;;
    esac
    continue
  fi
  # Bare integer — this is our PR number.
  if [[ "$tok" =~ ^[0-9]+$ ]]; then
    PR_NUMBER="$tok"
    break
  fi
  # URL form: `https://github.com/owner/repo/pull/<N>` — gh accepts
  # this as a positional. Extract the trailing integer.
  if [[ "$tok" =~ /pull/([0-9]+) ]]; then
    PR_NUMBER="${BASH_REMATCH[1]}"
    break
  fi
  # `owner/repo#N` shorthand — also accepted by gh.
  if [[ "$tok" =~ \#([0-9]+) ]]; then
    PR_NUMBER="${BASH_REMATCH[1]}"
    break
  fi
  # Quoted forms — strip surrounding quotes before re-checking.
  STRIPPED="${tok#\"}"
  STRIPPED="${STRIPPED%\"}"
  STRIPPED="${STRIPPED#\'}"
  STRIPPED="${STRIPPED%\'}"
  if [[ "$STRIPPED" =~ ^[0-9]+$ ]]; then
    PR_NUMBER="$STRIPPED"
    break
  fi
done

if [[ -z "$PR_NUMBER" ]]; then
  # Couldn't extract a PR number — allow per defense-in-depth.
  # gh itself will fail with a usage error if the command is malformed,
  # OR if it succeeds, the merge happens against the current branch's
  # PR (gh auto-detects) — the LGTM gate is a structural guard, not a
  # 100% catcher. Operator discipline + the canonical rule remain the
  # primary defenses; the hook closes the residual.
  exit 0
fi

# Extract --repo if present so the api call targets the right repo.
# Without it, `gh api` falls back to the current git remote's repo,
# which works in most agent-shell flows but breaks for cross-repo merges.
REPO_FLAG=""
# Check for `--repo X` (separate-arg form)
if [[ "$COMMAND" =~ --repo[[:space:]]+([^[:space:]]+) ]]; then
  REPO_FLAG="--repo ${BASH_REMATCH[1]}"
elif [[ "$COMMAND" =~ --repo=([^[:space:]]+) ]]; then
  REPO_FLAG="--repo ${BASH_REMATCH[1]}"
elif [[ "$COMMAND" =~ (^|[[:space:]])-R[[:space:]]+([^[:space:]]+) ]]; then
  REPO_FLAG="--repo ${BASH_REMATCH[2]}"
fi

# hook-gh-token.sh is copied alongside this file by every distribution path
# (copyCanonicalScripts, the marketplace sync), so it should always be
# right here — but `source`ing a file that isn't there would abort this
# whole script under `set -e` before any of the logic below runs, which is
# a worse failure than the one this fix closes. Guard it: if the sibling
# is somehow missing (a stale or partial distribution), degrade to a
# plain, non-refreshing gh call instead of crashing — reproducing exactly
# this hook's behavior from before this fix, not a new failure mode.
HOOK_GH_TOKEN_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hook-gh-token.sh"
if [[ -r "$HOOK_GH_TOKEN_LIB" ]]; then
  # shellcheck source=./hook-gh-token.sh
  source "$HOOK_GH_TOKEN_LIB"
else
  echo "MACF lgtm-gate: the credential-refresh helper library is missing from this workspace's scripts — running without token refresh. Update this workspace to pick up the missing file." >&2
  macf_hook_gh() {
    local out rc=0
    out="$(gh "$@" 2>/dev/null)" || rc=$?
    printf '%s' "$out"
    [[ "$rc" -eq 0 ]] && return 0
    return 2
  }
fi

# Query PR author + reviews + comments. Use one `gh pr view --json
# author,reviews,comments` call rather than separate `gh api` round-trips
# — gh handles repo detection if --repo was on the original command.
# `comments` feeds the (c) operator-login sanction-comment path below
# (macf#822 Part 2); it's always requested (single round-trip) even when
# MACF_OPERATOR_LOGIN is unset — the extra field is simply unused in that
# case.
#
# groundnuty/macf#938: the ambient $GH_TOKEN this hook inherits at launch
# is a 1-hour installation token. Past the first hour of any session, a
# call here can 401 for a reason that has NOTHING to do with whether an
# approval exists — the credential died, not the review. Routing the call
# through macf_hook_gh (hook-gh-token.sh) means a merely-EXPIRED token gets
# one refresh-and-retry before we give up, so the common case (a long
# session, a live App key) still gets a real answer instead of a
# false "could not verify".
#
# Posture past that retry (macf#938's actual decision point): the ORIGINAL
# "any failure (gh missing, network, 404, auth) → fail-open" blanket is now
# split in two —
#   - other_failed (gh missing / network down / 404 / malformed args):
#     UNCHANGED — still fails open. A hook that blocks every merge because
#     GitHub itself is unreachable would be its own outage, and `gh pr
#     merge` needs that same connectivity to succeed anyway, so failing
#     open here doesn't let a merge through GitHub couldn't also perform.
#   - auth_failed (the credential is expired/invalid AND a refresh attempt
#     also failed to fix it): fails CLOSED instead. This is NOT "GitHub is
#     unreachable" — it is "this workspace's credential is broken", which
#     is a locally fixable condition, not an outage. A merge gate that
#     cannot ask GitHub whether an approval exists must not read that
#     silence as an approval — see silent-fallback-hazards.md Instance 1
#     (the expiry sub-case this closes for the hook family) and the
#     amended fail-open paragraph in pr-discipline.md.
#
# Strip surrounding quotes from REPO_FLAG's value if quoted.
PR_JSON=""
GH_RC=0
# shellcheck disable=SC2086
PR_JSON="$(macf_hook_gh pr view "$PR_NUMBER" $REPO_FLAG --json author,reviews,comments)" || GH_RC=$?

if [[ "$GH_RC" -eq 1 ]]; then
  cat >&2 <<ERR
BLOCKED by MACF lgtm-gate hook: could not verify PR #${PR_NUMBER}'s review
state. ${PR_JSON}

This is NOT "no approval exists" — it is "the check could not ask GitHub".
The credential this hook needs to verify a merge is expired or invalid, and
refreshing it did not fix it. A merge gate that cannot verify must not
silently allow the merge through.

Likely causes: this workspace's APP_ID / INSTALL_ID / KEY_PATH are wrong,
the App's private key was rotated without updating this workspace, or
GitHub's own auth service is down (rare).

Fix the credential, then retry the merge:
  GH_TOKEN=\$("\$MACF_WORKSPACE_DIR/.claude/scripts/macf-gh-token.sh" \\
    --app-id "\$APP_ID" --install-id "\$INSTALL_ID" --key "\$KEY_PATH") || exit 1
  export GH_TOKEN

Override (ONLY for a reporter-sanctioned exception, same escape hatch as a
missing-LGTM block) is launch-time / operator only: MACF_SKIP_LGTM_CHECK=1, set
before ./claude.sh launches.
ERR
  exit 2
elif [[ "$GH_RC" -ne 0 ]]; then
  # other_failed — unchanged posture: a genuine infrastructure failure
  # (network down, gh missing, malformed args, a real 404) still fails
  # open, exactly as before this fix.
  exit 0
fi

if [[ -z "$PR_JSON" ]]; then
  exit 0
fi

# author.login from `gh pr view --json author` returns either the bare
# login (e.g. "octocat") for users or `app/<name>` for bots (e.g.
# "app/macf-code-agent"). reviews[].author.login returns the bare
# login form (e.g. "octocat" or "macf-science-agent" — no `app/`
# prefix and no `[bot]` suffix). Normalize both to compare reliably:
# strip `app/` prefix from author and `[bot]` suffix from both sides.
PR_AUTHOR="$(jq -r '.author.login // ""' <<<"$PR_JSON" 2>/dev/null || echo "")"
PR_AUTHOR="${PR_AUTHOR#app/}"
PR_AUTHOR="${PR_AUTHOR%\[bot\]}"

if [[ -z "$PR_AUTHOR" ]]; then
  # Couldn't parse author — fail-open.
  exit 0
fi

# Look for at least one APPROVED review where reviewer != author.
# `gh pr view --json reviews` returns `[{author: {login: "..."}, state: "APPROVED"}, ...]`.
NON_AUTHOR_APPROVALS="$(
  jq -r --arg author "$PR_AUTHOR" '
    [.reviews[]? |
      select(.state == "APPROVED") |
      (.author.login // "" | sub("^app/"; "") | sub("\\[bot\\]$"; "")) as $reviewer |
      select($reviewer != "" and $reviewer != $author) |
      $reviewer
    ] | length
  ' <<<"$PR_JSON" 2>/dev/null || echo "0"
)"

if [[ -z "$NON_AUTHOR_APPROVALS" ]] || ! [[ "$NON_AUTHOR_APPROVALS" =~ ^[0-9]+$ ]]; then
  # Parse error — fail-open.
  exit 0
fi

if [[ "$NON_AUTHOR_APPROVALS" -ge 1 ]]; then
  # At least one non-author APPROVED review — allow merge.
  exit 0
fi

# --- (c) operator-login sanction-comment path (groundnuty/macf#822 Part 2) ---
# Design direction converged operator + science + auditor-advisory
# (macf#822): the operator's own GitHub login is an UN-FORGEABLE trust
# anchor — an agent cannot post a comment attributed to it, so a comment
# authored by that exact login is a structurally-verified artifact, not a
# self-attestation (unlike a marker file the agent could write itself).
# Only engages when the workspace has configured MACF_OPERATOR_LOGIN
# (env.identity, from macf-agent.json `operator_login`); unset (the
# default) → this whole block is a no-op and the gate behaves exactly as
# it did before #822 Part 2.
OPERATOR_LOGIN="${MACF_OPERATOR_LOGIN:-}"
if [[ -n "$OPERATOR_LOGIN" ]]; then
  # Normalize the same way PR_AUTHOR / review logins are normalized above
  # (strip `app/` prefix + `[bot]` suffix) so an operator config value in
  # any of those shapes still compares correctly.
  NORM_OPERATOR="${OPERATOR_LOGIN#app/}"
  NORM_OPERATOR="${NORM_OPERATOR%\[bot\]}"

  # The operator login must ALSO differ from the PR author — mirrors the
  # non-author condition the review path enforces (groundnuty/macf#822
  # review). `operator_login` lives in agent-writable macf-agent.json →
  # env.identity → MACF_OPERATOR_LOGIN, and restart-self is agent-invocable,
  # so WITHOUT this an agent could set operator_login to its OWN login,
  # relaunch, post `[macf-sanction-merge]` on its OWN PR, and clear its own
  # gate — the exact self-attestation (c) exists to eliminate. This kills
  # the self-sanction shape; poisoning the config toward ANOTHER agent's
  # login still requires THAT agent to post the marker (cross-agent
  # collusion, genuinely beyond threat model). Config integrity is this
  # trust anchor's root assumption; the cleared login is logged below for
  # the auditor's gate-bypass sweep.
  if [[ -n "$NORM_OPERATOR" ]] && [[ "$NORM_OPERATOR" != "$PR_AUTHOR" ]]; then
    # Count comments where: (a) the body contains the exact marker
    # `[macf-sanction-merge]` (case-insensitive), AND (b) the comment's
    # author, normalized, equals the configured operator login. Both
    # conditions must hold on the SAME comment — a marker posted by a
    # non-operator login does NOT count, regardless of content (the
    # un-forgeable property this path depends on).
    SANCTION_HITS="$(
      jq -r --arg operator "$NORM_OPERATOR" --arg marker '[macf-sanction-merge]' '
        [.comments[]? |
          select(((.body // "") | ascii_downcase) | contains($marker | ascii_downcase)) |
          (.author.login // "" | sub("^app/"; "") | sub("\\[bot\\]$"; "")) |
          select(. == $operator)
        ] | length
      ' <<<"$PR_JSON" 2>/dev/null || echo "0"
    )"

    if [[ "$SANCTION_HITS" =~ ^[0-9]+$ ]] && [[ "$SANCTION_HITS" -ge 1 ]]; then
      echo "MACF lgtm-gate: operator-sanction comment ([macf-sanction-merge] authored by ${NORM_OPERATOR}) found on PR #${PR_NUMBER} — clearing gate via the un-forgeable operator-login path (groundnuty/macf#822 Part 2)." >&2
      exit 0
    fi
  fi
fi

# No non-author APPROVED review, and no operator-sanction comment — block.
cat >&2 <<ERR
BLOCKED by MACF lgtm-gate hook: PR #${PR_NUMBER} has no non-author APPROVED
review on record. Per pr-discipline.md "no LGTM = no merge" (canonical rule
distributed via \`macf rules refresh\`):

  "Without an explicit LGTM from the reviewer, the implementer does NOT
  merge — even if waiting indefinitely."

PR author: ${PR_AUTHOR}
Non-author APPROVED reviews: 0

The LGTM gate is structural — it ensures someone other than the implementer
has read the diff in context. Self-merge without LGTM bypasses that quality
gate even if the work is correct.

Fix — request a formal review from a peer agent via state-change-firing
mechanism (NOT a plain comment, per pr-discipline.md §"How to submit LGTM"):

  gh pr review ${PR_NUMBER} --approve --body "LGTM"   # reviewer side
  gh pr review ${PR_NUMBER} --request-changes --body "..."   # changes needed

Then the reviewer @mentions you on the originating issue with the LGTM
state-change as the wake signal.

Override (ONLY for reporter-sanctioned exceptions per pr-discipline.md
§"When the reviewer is absent or unreachable") is launch-time / operator
only: MACF_SKIP_LGTM_CHECK is read from THIS session's process env, fixed
when ./claude.sh launched it. An in-session \`export MACF_SKIP_LGTM_CHECK=1\`
from a Bash tool call does NOT reach it — Bash-tool commands run in a
separate subshell that never persists into the session's env. To use it:
set MACF_SKIP_LGTM_CHECK=1 in the launch env (or the workspace's
.claude/.macf/env.* files) BEFORE running ./claude.sh, then relaunch.
Need the reporter-sanctioned exception NOW, mid-session? Don't self-apply
this flag — ask the operator to set it + relaunch, or route the merge
through the operator directly with the sanction recorded in the artifact.

Preferred agent-usable exception (groundnuty/macf#822 Part 2): if this
workspace has MACF_OPERATOR_LOGIN configured, ask the operator to post a
PR comment containing exactly the marker [macf-sanction-merge] under
THEIR OWN GitHub login (a formal \`gh pr review --approve\` from them also
clears the gate via the path above). This is un-forgeable — an agent
cannot post a comment attributed to the operator's account — so the gate
verifies a real artifact instead of trusting a self-attestation. See
pr-discipline.md §"Operator-sanctioned exception (macf#822)".

Refs: groundnuty/macf#270 (this hook); pr-discipline.md (canonical rule);
DR-023 amendment (bash-form decision rule); macf#262 / PR #263 (rule
codification origin); groundnuty/macf#822 (operator-login sanction path).
ERR
exit 2
