# Coordination

Rules every agent in the fleet follows when working through GitHub issues and PRs. Other rules own their own topics: `pr-discipline.md` (reviews, merging), `gh-token-attribution-traps.md` (tokens), `peer-dynamic.md` (disagreement and review manner), `mention-routing-hygiene.md` (handles in prose).

## Issue Lifecycle

1. The reporter closes the issue, because only the reporter knows whether the fix matches the intent. Before any merge-handoff comment, run `gh issue view <N> --json author --jq '.author.login'`:
   - The author is someone else: post `@<author> PR #M merged, ready for you to close when verified.` and stop. Do not run `gh issue close`.
   - The author is you (your own login prints as `app/<bot-name>`; you opened it, whoever implemented it): close it yourself with a verification comment, `gh issue close <N> --reason completed --comment "..."`.
   - Use `Refs #N` for issues others filed; see pr-discipline.md.
2. Work through your queue without prompting: when an issue is done, pick up the next one. Wait only while your PR is in review or the queue is empty.
3. Keep your agent label; only the status labels (`in-progress`, `in-review`, `blocked`) change.
4. Once an assignee has picked an issue up (comment, `in-progress` label, or open PR), the issue body is their working spec and is frozen. Post scope changes as follow-up comments; the assignee may edit their own issue body. If the change needs a re-read from scratch, file a replacement issue that links back.
5. For an issue filed by a bot such as `github-actions[bot]`, use `Refs #N` (not `Closes`), route the review ping to a peer reviewer rather than echoing the bot's mention (which does not route), and wait for the next automatic run to confirm green before closing, citing its URL. If the workflow closes the issue on green itself, leave it.

## Communication

1. Put an @mention in every comment, because routing depends on it. A comment that only closes your own issue needs none.
2. Discuss on issue threads, not PR comments, because issues outlive the PR.
3. A review or close written in your reply reaches nobody; post it with `gh`. Hook `check-gh-attribution.sh` reads back who authored each comment, issue, PR or close and warns when it was the user account.
4. Keep comments short.
5. A review request addressed to you blocks the requester, so treat it as work. A fresh session injects the `/macf-issues` output, including the sweep; after a resume or compaction, and before declaring idle, run `/macf-issues` yourself:
   - (a) Reviewer sweep: every open PR by others with no approval yet, requested from you or not, bot-authored included. Answer with `gh pr review --approve` or `--request-changes`, because the merge gate counts only a formal approval.
   - (b) Inbound review requests and mentions: threads where you were mentioned or asked to review and have not replied.
   - (c) Gate sweep: when your next step waits on someone else's PR review, check GitHub (`gh pr view <N> --json reviews`), not a ping, because the router notifies the author, formal reviewers, requested reviewers and mentioned parties only. When you review a PR a third agent is gated on, @mention that agent in the review body.
6. Operator decisions have one solicitor: the owner of the work item (the DR author, the issue reporter, or the PR implementer). A peer who needs the decision asks the owner, not the operator. A decision relayed with clear attribution (who, when, what) is actionable; ask the operator again only to flip a DR's status, which needs an operator artifact on the record, or when relays conflict.

## Escalation

When stuck after trying, @mention the issue's reporter with what you tried and what you need. The reporter decides the next step; do not go past them to the operator unless they say they cannot help.

## Token & Git Hygiene

Mint tokens, push and check identity as gh-token-attribution-traps.md describes. Leave nothing uncommitted at turn end; never commit secrets.
