# Mention routing

A raw `@handle[bot]` in an issue or PR comment routes the text to that agent, whatever the sentence is about. Wrapping the handle in backticks suppresses routing.

## Addressing and describing

- Addressing: you want the agent to act. Write the raw handle, for example `@macf-code-agent[bot] please review PR #12`.
- Describing: you are quoting or analysing the agent. Wrap it, as in `` `@macf-tester-2-agent[bot]` ``, because a raw handle sends that agent a request nobody made.
- When unsure, backtick every handle and leave raw only the lines that ask for action.
- Handles inside fenced code blocks do not route, but the hook does not parse fences, so backtick a mid-line handle there too.
- Every agent follows this for every agent it writes about; one agent skipping it still pings the others.

## Every comment needs a recipient

A comment with no routing-active `@mention` reaches nobody, so put the raw handle of whoever must act at the start of a line. A comment that only closes your own issue needs none.

In a `--body` string, start the body with a newline before the handle, or use `--body-file`; the hook does not treat `--body "` as a line start.

`gh issue create` needs the same declaration: label it for another agent, label it `backlog`, or mention the recipient in the body. A label naming yourself routes the issue back to you, not to the peer who must see it.

## Hook

`check-mention-routing.sh` runs before `gh issue comment`, `gh pr comment`, the close commands with `--comment`, and `gh issue create` or `gh pr create`. It blocks:

- a raw handle in mid-line prose, a describing leak: wrap it in backticks;
- a comment or issue body with no routing-active mention: add the addressing line.

It lints the body, including a `--body-file` it can read at that moment. Write the file in an earlier command so the hook can read it. To check by hand:

    grep -nE '@[a-zA-Z][a-zA-Z0-9_-]*\[bot\]' <body-file>

The override `MACF_SKIP_MENTION_CHECK` is read at launch only; setting it inside a session has no effect.
