#!/usr/bin/env bash
#
# check-auditor-never-acts.sh — Claude Code PreToolUse hook that blocks
# state-mutating `gh` ops (`gh pr merge`, `gh issue close`, `gh pr close`)
# when the active identity is the AUDITOR (`MACF_AGENT_ROLE=auditor`), while
# leaving the propose verbs (`gh issue/pr create|comment`) and all reads
# untouched. Structurally enforces the auditor's "never-acts" boundary per
# DR-026 (the auditor — self-evolving coordination governance): the auditor
# is write-PROPOSALS-only; it opens issues/PRs and comments, but never merges
# or closes — those acts route to a non-auditor implementer / the operator.
#
# Why structural and not permission-based: a GitHub App's `pull_requests:write`
# permission grants merge+close TOGETHER with open-PR; there is no "open-a-PR-
# but-not-merge" permission scope to express. The never-acts boundary therefore
# has to be enforced at tool-call time, in the same family as the sibling
# `check-*.sh` hooks (#140 token / #244+#272 mention / #270 lgtm / #431 close /
# #489 attribution).
#
# Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 = block
# (stderr is fed back to Claude as the error). Same shape as #140's
# check-gh-token.sh + #270's check-lgtm-gate.sh.
#
# Inert for every NON-auditor identity (exit 0 before any parsing) — this is
# the load-bearing gate that makes fleet-wide distribution safe: shipping this
# hook to every workspace via `macf init` / `macf update` is a no-op everywhere
# except the auditor, so code-agent / science-agent / cv-* keep their full
# `gh` surface unchanged.
#
# Override: MACF_SKIP_AUDITOR_ACT_CHECK=1 bypasses (for a sanctioned exception
# — e.g. the operator explicitly authorizing the auditor to perform a one-off
# merge/close). Consistent with MACF_SKIP_TOKEN_CHECK / MACF_SKIP_LGTM_CHECK /
# MACF_SKIP_CLOSE_CHECK / MACF_SKIP_ATTRIBUTION_CHECK in the sister hooks.
#
# Refs: groundnuty/macf#499 (this hook); DR-026 §1/§4 (auditor never-acts
#       boundary; PROPOSED via #495); #140 / #244+#272 / #270 / #431 / #489
#       (sister Path-2 hooks).
set -uo pipefail

# Defense-in-depth: any unexpected error past this point must NOT brick the
# harness. We use `set -uo pipefail` (NOT `-e`) so commands that fail are
# handled explicitly; this trap is a final safety net for a genuinely
# unexpected fault — fail open (allow).
trap 'exit 0' ERR

# 1. Operator override first — cheapest exit. No stdin read, no parsing.
if [[ "${MACF_SKIP_AUDITOR_ACT_CHECK:-}" == "1" ]]; then
  exit 0
fi

# 2. Inert for every non-auditor identity. This is the load-bearing gate —
#    when the active role isn't the auditor, the hook does nothing, so it is
#    safe to distribute to every workspace. `MACF_AGENT_ROLE` is exported by
#    claude.sh (env-files.ts) as the agent's role.
if [[ "${MACF_AGENT_ROLE:-}" != "auditor" ]]; then
  exit 0
fi

# 3. Read the PreToolUse payload. Fall through to allow on parse error — a
#    broken hook must not brick the harness. Same defense-in-depth as
#    check-gh-token.sh / check-lgtm-gate.sh.
INPUT_JSON="$(cat 2>/dev/null || echo "")"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

if [[ -z "$COMMAND" ]]; then
  # No command extractable — allow (defense-in-depth).
  exit 0
fi

# 4. Is this a `gh` invocation at all? Reuse the wrapper-aware GH_PATTERN +
#    SHELL_C_PATTERN from check-gh-token.sh so `sudo gh`, `env X= gh`,
#    `bash -c "gh …"`, and chained `&& gh` forms all count. If it's not a gh
#    command, there is nothing for this hook to gate — allow.
GH_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]'
SHELL_C_PATTERN='(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]'

if [[ ! "$COMMAND" =~ $GH_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_PATTERN ]]; then
  # Not a gh command — allow.
  exit 0
fi

# 5. Is the command one of the BLOCKED acting-verbs? Each op is matched two
#    ways, mirroring check-lgtm-gate.sh's merge match: a WRAPPER pattern
#    (sudo / env VAR= / watch / nice / chained-leadin `;|&` / inline VAR=)
#    and a SHELL_C pattern (`bash -c "gh pr merge …"` and variants). Both
#    anchor the `gh <noun> <verb>` substring and end on a whitespace-or-EOL
#    boundary so e.g. `gh pr merge` matches but a hypothetical
#    `gh pr merge-base` does NOT (exact-subcommand match).
#
#    ── BLOCKED acting-verbs (DENYLIST; intentionally minimal) ──────────────
#    This is a denylist of STATE-MUTATING acts. The propose verbs
#    (`gh issue create`, `gh pr create`, `gh issue comment`, `gh pr comment`)
#    are deliberately ABSENT — the auditor is write-proposals-only, so those
#    must fall through to the allow at the bottom. To extend the boundary
#    (e.g. block `gh issue edit` of another agent's issue), add a `<noun> <verb>`
#    entry to BLOCKED_VERBS below; keep the propose verbs out.
#
#      gh pr merge     — merging a PR is an act, not a proposal
#      gh issue close  — closing an issue is an act (reporter-owns-closure)
#      gh pr close     — closing a PR is an act
BLOCKED_VERBS=(
  'pr merge'
  'issue close'
  'pr close'
)

# Build the wrapper + shell-c regexes for a given `<noun> <verb>` and test the
# command against both. Echoes the canonical `gh <noun> <verb>` label on a hit.
_match_blocked_verb() {
  local noun_verb="$1"        # e.g. "pr merge"
  local cmd="$2"
  # Translate the space in "<noun> <verb>" into the whitespace-class form.
  local nv="${noun_verb/ /[[:space:]]+}"
  local wrapper_pat="(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+${nv}([[:space:]]|$)"
  local shell_c_pat="(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]+${nv}([[:space:]]|$)"
  if [[ "$cmd" =~ $wrapper_pat ]] || [[ "$cmd" =~ $shell_c_pat ]]; then
    echo "gh ${noun_verb}"
    return 0
  fi
  return 1
}

BLOCKED_OP=""
for verb in "${BLOCKED_VERBS[@]}"; do
  if hit="$(_match_blocked_verb "$verb" "$COMMAND")"; then
    BLOCKED_OP="$hit"
    break
  fi
done

if [[ -z "$BLOCKED_OP" ]]; then
  # 6. Not a blocked acting-verb — the propose verbs (gh issue/pr create,
  #    gh issue/pr comment) and all reads fall through here. Write-proposals-
  #    only is the auditor's permitted power. Allow.
  exit 0
fi

# Blocked acting-verb under the auditor identity — block LOUD.
cat >&2 <<ERR
BLOCKED by MACF auditor-never-acts hook: the AUDITOR is write-PROPOSALS-only and
must never perform a state-mutating act. The command you ran is a \`${BLOCKED_OP}\`,
which closes/merges a resource — that is an ACT, not a proposal.

Command: ${COMMAND}
Blocked op: ${BLOCKED_OP}

Per DR-026 §1/§4 (the auditor — self-evolving coordination governance), the
auditor opens issues + PRs and comments to PROPOSE changes, but the merge/close
ACT belongs to a non-auditor implementer (code-agent / science-agent) or the
operator. This boundary is structural because a GitHub App's
\`pull_requests:write\` permission grants merge+close together with open-PR —
there is no "open-a-PR-but-not-merge" scope to express it, so the hook enforces
it at tool-call time.

Fix — route the act to a non-auditor identity:
  - For a merge: @mention the PR's implementer on the issue thread; they merge
    after the LGTM gate, per coordination.md / pr-discipline.md.
  - For a close: @mention the issue's reporter; reporter-owns-closure
    (coordination.md §Issue Lifecycle 1) — they close after verifying.
  Leave the auditor's role to the PROPOSAL (the issue / PR / comment) you
  already created.

Override (ONLY for an operator-sanctioned exception) is launch-time /
operator only: MACF_SKIP_AUDITOR_ACT_CHECK is read from THIS session's
process env, fixed when ./claude.sh launched it. An in-session
\`export MACF_SKIP_AUDITOR_ACT_CHECK=1\` from a Bash tool call does NOT
reach it — Bash-tool commands run in a separate subshell that never
persists into the session's env. To use it: set
MACF_SKIP_AUDITOR_ACT_CHECK=1 in the launch env (or the workspace's
.claude/.macf/env.* files) BEFORE running ./claude.sh, then relaunch.
Need the operator-sanctioned exception NOW, mid-session? Don't self-apply
this flag — the operator performs (or explicitly directs) the specific
act, with the sanction recorded in the artifact itself.

Refs: groundnuty/macf#499 (this hook); DR-026 §1/§4 (auditor never-acts).
ERR
exit 2
