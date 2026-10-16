# Coordination

Rules every agent in the fleet follows when working through GitHub issues and PRs. Other rules own their own topics: `pr-discipline.md` (reviews, merging), `gh-token-attribution-traps.md` (tokens), `peer-dynamic.md` (disagreement and review manner), `mention-routing-hygiene.md` (handles in prose).

## Issue Lifecycle

1. The reporter closes the issue, because only the reporter knows whether the fix matches the intent. Before any merge-handoff comment, run `gh issue view <N> --json author --jq '.author.login'`:
   - The author is someone else: post `@<author> PR #M merged, ready for you to close when verified.` and stop. Do not run `gh issue close`.
   - The author is you (you opened it, whoever implemented it): close it yourself with a verification comment, `gh issue close <N> --reason completed --comment "..."`. Nobody else will.
   - In a PR body, use `Refs #N` for an issue someone else filed. Any of the nine close keywords (Closes, Fixes, Resolves, Close, Fix, Resolve, Closed, Fixed, Resolved) fires on merge whatever the surrounding text. Hook `check-close-keyword.sh` blocks it; the override is operator-only.
2. Work through your queue without prompting: when an issue is done, pick up the next one. Wait only while your PR is in review or the queue is empty. Ask clarifying questions on the issue and move to the next while waiting.
3. Keep your agent label; only the status labels (`in-progress`, `in-review`, `blocked`) change.
4. Once an assignee has picked an issue up (comment, `in-progress` label, or open PR), the issue body is their working spec and is frozen. Post scope changes as follow-up comments; the assignee may edit their own issue body. If the change needs a re-read from scratch, file a replacement issue that links back.
5. For an issue filed by a bot such as `github-actions[bot]`, use `Refs #N` (not `Closes`), route the review ping to a peer reviewer rather than echoing the bot's mention (which does not route), and wait for the next automatic run to confirm green before closing, citing its URL. If the workflow closes the issue on green itself, leave it.

## Communication

1. Put an @mention in every comment, because routing depends on it.
2. Discuss on issue threads, not PR comments: issues stay visible on the board after the PR closes.
3. Writing a review or close comment as prose does not post it (chat output is invisible to other agents). As a mandatory tail, after any `gh issue comment` or `gh pr comment`, check it landed under your bot login: `gh issue view <N> --repo <owner>/<repo> --json comments --jq '.comments[-1].author.login'`.
4. Keep comments to one to three sentences unless detail is needed.
5. A review request addressed to you blocks the requester, so treat it as work, not status. Sessions start with `/macf-issues`, which prints the sweep instruction; before declaring idle, run it again for anything that arrived mid-session:
   - (a) Reviewer sweep: open PRs by others awaiting your review, bot-authored included (a stale router pin degrades routing for everyone), and threads where you were mentioned and have not replied. Answer a review with `gh pr review --approve` or `--request-changes`; a plain comment does not notify the author.
   - (b) Gate sweep: when your next step waits on someone else's PR review, check GitHub (`gh pr view <N> --json reviews`), not a ping, because the router notifies the author, formal reviewers, requested reviewers and mentioned parties only. When you review a PR a third agent is gated on, @mention that agent in the review body.
6. Operator decisions have one solicitor: the owner of the work item (the DR author, the issue reporter, or the PR implementer). A peer who needs the decision asks the owner, not the operator. A decision relayed with clear attribution (who, when, what) is actionable; ask the operator again only to flip a DR's status, which needs an operator artifact on the record, or when relays conflict.

## When You're Stuck — Escalation

1. Read the merge state with `gh pr view <N> --json mergeStateStatus,mergeable` and act:
   - `CLEAN`: merge. `UNKNOWN`: GitHub is computing; wait up to a minute. After a CI-completion notification, an `UNKNOWN` or `UNSTABLE` rollup may mean another workflow is still running; re-query after about 30 seconds.
   - `BEHIND` or `DIRTY`: merge main into the branch and resolve conflicts. Do not force-push; settings deny it and review history stays intact.
   - `BLOCKED`: check reviews, required checks and branch protection. `UNSTABLE`: a required check failed; fix it.
2. When stuck after trying, @mention the issue's reporter with what you tried and what you need. The reporter decides the next step; do not go past them to the operator unless they say they cannot help.

## Token & Git Hygiene

Mint `GH_TOKEN` and verify attribution as `gh-token-attribution-traps.md` describes. Push with `-c url.insteadOf` per push and never write a token into a remote URL, because it would persist. Leave no uncommitted changes at the end of a turn, and never commit keys or tokens.

## Peer Dynamic

See `peer-dynamic.md`.
