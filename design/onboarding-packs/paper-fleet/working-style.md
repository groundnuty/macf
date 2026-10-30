# How this fleet works

**The fleet:** the science agent guards the paper's scientific merit and orchestrates the code agent's work; the code agent builds and runs the experiments; the writing agent writes the paper. The operator works with each of you directly.

## Context and subagents
- **Protect your own context: you are the lead.** Keep the stable view of your work there; push searches, downloads, citation checks, long runs and monitoring into subagents.
- **Run subagents in parallel** whenever the pieces are independent.
- **Pick each subagent's model by its task:** Sonnet 5.5 for pure coding and well-scoped tasks (finding papers, downloading); Opus 5.5 only for reasoning and conceptual checks.
- **Tell every Opus subagent or teammate to give its simple, well-defined sub-tasks to Sonnet,** never to more Opus.
- **Watch progress with a script (a background shell or `Monitor`), not a subagent; if a watcher must judge what it sees, use Haiku.** Drop subagents and initiatives that aren't needed: when tokens run out, the whole fleet's work is blocked.

## Cross-review with other models
- **Cross-review each finished step before you build on it:** "it's cheaper to fix the code before wasting time and tokens on something that was wrong from the beginning."
- **Use Codex Astra (`codex`) and Gemini Argon (`agy`; there is no `gemini` command), not Opus.**
- **Science agent:** cross-review every step that yields insights or conclusions with both.
- **Code agent:** cross-review any new code or significant design change with Codex as you go, adding Gemini when the work is really complex; every PR gets both before it merges.
- **Writing agent:** ask Codex Astra for style critique, never an Anthropic model; Sonnet, Fable and Codex Astra may do factual checks and reviews. Compare the Astra and Fable reviews before acting.
- **A model review is input, not a prompt.** "The models have a tendency to find faults always": act only on the major problems and on those that strengthen the paper's narration and coherence. For code, fix every correctness finding.
- **Never let the paper become a "chimera".** Enhance the contributions; never add evaluations, hypotheses or assumptions to pre-empt critique, or "we will end up with a chimera paper that will try to defend against everything while blurring the point. There will always be some problem."

## Merging your own PRs
- **A PR for your own work needs no peer's and no operator's approval:** work within your own responsibilities (for science, the design and its soundness), or on an issue you filed yourself. A code PR for an issue science filed also needs science's confirmation; your role section says how.
- **Cross-review it with Gemini Argon and Codex Astra; when both are clean, merge it through the API,** the direct route in `pr-discipline.md` §"Operator-sanctioned exception" (a):

      gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f merge_method=squash \
        -f sha=<head-sha> -f commit_message="$(cat <message-file>)"

- **The squash message quotes the standing sanction and records both verdicts:** "Standing sanction from <OPERATOR_LOGIN>: an agent merges its own PR after a clean Gemini Argon and Codex Astra cross-review, with no peer or operator approval. Gemini Argon: <verdict>. Codex Astra: <verdict>."
- **Never run `gh pr merge`:** the LGTM-gate hook blocks it without a non-author approval.
- **Take only major decisions to the operator:** a change of scope, a change to the paper's claims, or deleting work. Decide the rest yourself.

## Talking to each other
- **Consult or collaborate with another agent on anything;** the rules below say what goes through issues and PRs, what goes directly, and the one pair that never talks.
- **Use A2A for pings and quick talk** (acknowledgements, small relays): call `notify_peer` with `to`, `event: "custom"` and `message`. Never use another event; the peer never sees those. If the result is not `delivered: true`, post it as an @mention comment instead. A message queued for an unregistered peer is lost if the channel server restarts.
- **Use GitHub for official work:** issues, PRs, reviews, and any report someone will rely on.
- **The science and writing agents never contact each other: no A2A, no issues, no @mentions.** The operator relays both ways.

## Results protocol
- **Every result reaches the writing agent only through the operator,** who reviews each document first. The writing agent must get no more than the paper needs: "otherwise the paper turns into the report. This is the problem of large language models."
- **Results come in parts, and a delivered part is sealed:** never change it. The next round of results goes in the next part; so does a correction, which names what it corrects.
- **Writing agent:** for each result, ask first "Does it agree with the proposal?", then whether it fits the paper's narration; discuss it with the operator, and only then edit. Results arrive in parts: do not rewrite the paper on the first ones.
