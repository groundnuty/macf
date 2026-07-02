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
# Override: MACF_SKIP_LGTM_CHECK=1 bypasses (for legitimate operator-
# allowed exceptions per pr-discipline.md §"When the reviewer is absent
# or unreachable" — reporter-sanctioned self-merge, urgent revert, etc.).
#
# Refs: groundnuty/macf#270 (this hook); pr-discipline.md (canonical
#       rule, distributed via `macf rules refresh`); DR-023 amendment
#       (bash-form decision rule); macf#262 / PR #263 (LGTM rule
#       codification); PR #275 / macf#244+#272 (empirical pattern).
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

# Query PR author + reviews. Use `gh pr view --json author,reviews`
# rather than two separate `gh api` calls — single round-trip, gh
# handles repo detection if --repo was on the original command.
# Defense-in-depth: any failure (gh missing, network, 404, auth) →
# fail-open. Same posture as check-gh-token.sh.
#
# Strip surrounding quotes from REPO_FLAG's value if quoted.
PR_JSON=""
# shellcheck disable=SC2086
if ! PR_JSON="$(gh pr view "$PR_NUMBER" $REPO_FLAG --json author,reviews 2>/dev/null)"; then
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

# No non-author APPROVED review — block.
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
§"When the reviewer is absent or unreachable"):
  export MACF_SKIP_LGTM_CHECK=1

Refs: groundnuty/macf#270 (this hook); pr-discipline.md (canonical rule);
DR-023 amendment (bash-form decision rule); macf#262 / PR #263 (rule
codification origin).
ERR
exit 2
