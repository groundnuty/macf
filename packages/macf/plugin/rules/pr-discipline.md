# PR discipline

Every change to a persistent artifact (code, tests, docs, config, research) goes through a pull request, never a direct push to the default branch. The PR is where review, CI and the audit trail happen.

## Branches, titles, bodies

- Branch: `<type>/<issue>-<slug>`, for example `fix/123-empty-agent-name`.
- Title: conventional commits, `<type>(<scope>): <lowercase description>`.
- Body: `Refs #N` when another agent filed the issue, because the reporter closes it after verifying. `Closes #N` only for an issue you filed yourself. This covers every close keyword (`Fixes`, `Resolves` and their variants). Hook `check-close-keyword.sh` blocks a close keyword next to another agent's issue; the override is operator-only.
- Discuss the work in the issue thread, so the discussion outlives the PR.

## How to submit LGTM

Approve or request changes with a formal review, because only that event notifies the PR author; a plain comment does not. Use as written:

    gh pr review <N> --repo <owner>/<repo> --approve --body-file <file>
    gh pr review <N> --repo <owner>/<repo> --request-changes --body-file <file>

Use a plain comment review only for questions and partial notes. Confirm the state change landed:

    gh pr view <N> --repo <owner>/<repo> --json reviews \
      --jq '[.reviews[] | select(.state=="APPROVED" or .state=="CHANGES_REQUESTED")] | last'

## Merging

- The implementer merges after a formal approval from someone other than the author, because the implementer knows whether the branch is ready to land. Hook `check-lgtm-gate.sh` blocks a merge without one; the override is operator-only.
- Check `gh pr view <N> --json mergeStateStatus` first. `CLEAN`: merge. `BEHIND` or `DIRTY`: merge main into the branch and push. `UNSTABLE` or `BLOCKED`: fix the failing check or the missing review. `UNKNOWN`: wait about a minute. Settings deny force-push, so never rebase and force-push.
- Squash-merge, then post the handoff on the issue as `coordination.md` describes.
- If the reviewer is unreachable, mention them again, then escalate to the issue reporter. Do not self-merge.

## Operator-sanctioned exception

When the operator sanctions a merge without a reviewer approval, the gate clears on either of these, because an agent cannot post as the operator's account:

- a formal approval from the operator's login;
- a PR comment from the operator's login containing `[macf-sanction-merge]`.

Both need `MACF_OPERATOR_LOGIN` set for the workspace. If the operator sanctioned verbally instead, record who sanctioned it and why in the squash-commit body or the close comment. `MACF_SKIP_LGTM_CHECK` is read at launch only; setting it inside a session has no effect.
