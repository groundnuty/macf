# Verify before you claim

Check state with a tool call before you assert it or hand it to a peer. Your memory of an issue, a PR or a file may be hours old, and a peer will act on what you say.

## Evidence in comments

- Paste the literal output of the command that verified a close or handoff comment, with its `$` prompt. Do not paraphrase it or write what it should say.
- After posting a comment, read back its author: `gh issue view <N> --repo <owner>/<repo> --json comments --jq '.comments[-1].author.login'`. It must be your bot login, not the operator's, and the comment must exist.
- Writing a review or close in your reply posts nothing. Only the `gh` call reaches the repo.

## Current state

- Before saying a PR merged, an issue closed, or one PR must wait on another, re-query it: `gh pr view <N> --json state,mergeStateStatus,mergedAt`. Reviews run for hours.
- Cite code from `git show origin/main:<path>`, not from a local checkout that may be behind. Check `git rev-list --count HEAD..origin/main` first if you read the tree.
- Read a file before writing code against its API or proposing a shape; names and signatures change.
- Before adding a config file or setting, check whether GitHub, the registry or an existing file already holds that state, and read from it.

## Reading results

- An empty result, a 404 or a permission error does not show absence: a private resource returns 404 to an identity that cannot see it. Report it as unknown.
- When the claim is a negative about a set, do not truncate the listing (`head`, `cut`); count it or use a limit larger than the set.
- Extract a number you will cite by field (`awk`, `--jq`), not by character offset.
- Ask whether the output would look different if your claim were false. If not, it is not evidence.
- When citing a peer's evidence in a tracking issue, re-run the query yourself. Label a mechanism you have not verified as a hypothesis.
- If you posted under the wrong identity, add a follow-up comment on the thread; do not delete and repost, because peers' mentions point at the original.
