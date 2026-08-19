# Verify Before Claim

**Tool output beats memory. Diff beats prose. Freshly-queried state beats last-known state.**

Before you make an assertion about system state — the status of an issue, whether a PR merged, what a config file contains, whether a service is running — verify it with a tool call, then claim it. The cost of a `gh`/`kubectl`/`helm`/`ls`/`grep` call is ~1 second. The cost of a confidently-wrong assertion that a peer acts on is much larger.

This rule compounds every behavior in this file — they're four faces of the same discipline.

---

## 1. Never fabricate "verified" output in close comments

When closing an issue (or writing any "this is done" artifact), paste **literal output** from the verifying tool call. Do not paraphrase it. Do not write what it "should" say.

**Bad:**
> Verified — `macf --version` returns `0.2.0` and `npm view @groundnuty/macf version` returns `0.2.0`. Closing.

(If you didn't actually run those commands in the current session, the text is a fabrication even if the values happen to be correct.)

**Good:**
>     $ npm view @groundnuty/macf version
>     0.2.0
>     $ macf --version
>     0.2.0
>
> Closing as reporter.

Literal quoted output with the `$` prompts is the signal that the assertion is grounded in a just-executed command. Future readers (auditors, peers, future-you) can tell by formatting whether the evidence is fresh or narrated.

**Applies to:** issue close comments, PR merge-handoff comments, runbook "I ran X, got Y" sections, status updates on long-running tasks.

---

## 2. After `gh issue comment` / `gh issue close`, verify it actually posted

Writing the review/LGTM/close-comment as prose in your response is NOT the same as posting it. Only executed tool calls reach the repo; chat output is invisible to other agents. Treat the verification step as a **mandatory tail**, not optional.

After any `gh issue comment` / `gh pr comment` / `gh issue close`:

    gh issue view <N> --repo <owner>/<repo> --json comments \
      --jq '.comments[-1].author.login'

Confirms:
- (a) the comment exists (non-empty output)
- (b) attribution is correct — your bot login, not the user's login (attribution-trap catch)

Signs you may have missed the tool call:

- Your last action was describing a review / decision / close in prose
- The recipient's status comment says "waiting for review" or "ready for you to close" with no reply from you visible on the thread
- Time has passed since you "reviewed" but no downstream activity has happened

When in doubt, run the `gh issue view` check. Cheap to verify; costly to have the peer wait on a review that never arrived.

---

## 3. Before ordering-claims, `gh pr view` the predecessor

Before asserting "PR A must merge before PR B" or "X is blocked on Y":

    gh pr view <predecessor-N> --repo <owner>/<repo> --json state,mergeStateStatus,mergedAt

Don't infer the predecessor's state from stale in-context memory. PR review conversations often span hours; a PR you saw as OPEN two hours ago may be MERGED now. Sequencing claims based on stale state lead to peers doing unnecessary rebases or waiting on already-satisfied dependencies.

Same principle for `gh issue view` / `helm status` / `kubectl get` — the live query beats the remembered value, always, for anything that could have moved.

---

## 4. Before committing "root cause: X" to memory, read the fix diff

When an incident closes with a post-mortem-style "root cause: X" from the reporter, that statement is the reporter's *hypothesis*. Before writing it into persistent memory, verify against the actual fix diff:

    git show <fix-commit-sha>
    # or
    gh pr diff <fix-PR-N> --repo <owner>/<repo>

The diff shows what was *actually* changed. Reporter prose is narrative — often right, sometimes simplified, occasionally wrong. A memory file claiming "mode-6 of the attribution trap is X" is load-bearing for future sessions; miscalling the root cause sends those future sessions chasing the wrong bug class.

Cluster to which this belongs: always prefer concrete artifact (diff, config, tool output) over narrative description of it. The narrative is lossy compression.

---

## 5. Verify-at-every-hop — both sides apply

When evidence flows through multiple agents (peer-A observes → peer-B cites → peer-C tracks), the verify-before-claim discipline applies **at each hop**, not just at the original observation. Two complementary species:

### Emitter side — label hypotheses as hypothetical

When proposing a mechanism, root-cause framing, or other interpretive claim into the substrate-record (issue thread, comment, memory, paper-trail entry), explicitly label hypotheses as hypothetical. Don't claim mechanism-as-fact when it's mechanism-as-hypothesis.

The surface observation may be valid even when the named mechanism isn't; preserve the observation while making the proposal-status explicit:

- **Hypothesis-as-hypothesis (good):** *"the mechanism appears to be X — anyone want to verify?"*
- **Fact (only when verified):** *"the mechanism is X (verified via `gh api ... --jq ...` returning Y)"*
- **Hypothesis-as-fact (avoid):** *"the mechanism is X."* — forces downstream peers to either re-derive from the source or propagate an unverified claim

### Receiver side — re-verify before promoting

When citing another agent's API-evidence claim into a higher-visibility tracking surface (tracking issue, synthesis comment, workbench rule, paper-trail entry), re-verify the literal data with a fresh tool call. Don't propagate citations.

The data-quality buck stops at whoever promotes the claim into the higher-visibility surface, regardless of who originally observed it. Tracking-surface citations carry the misread forward indefinitely once promoted.

### Worked examples

**Receiver-side, observed 2026-04-25:** Peer-A reports *"PR#57 was created at 18:23:31Z, 5s before FAIL."* Peer-B writes a tracking issue update citing that timestamp without re-running `gh api .../pulls/57 --jq '.created_at'`. Peer-C re-verifies and finds the actual API returns `18:24:36Z` — 61s AFTER FAIL. The receiver-side discipline at peer-B's citation hop would have caught this.

**Emitter-side, observed 2026-04-26:** Peer-A reports *"the window appears to count from `issue.createdAt`."* Peer-B reads the helper code and finds the deadline is calculated from `SECONDS + timeout` at helper-call time (post-merge). The mechanism was already merge-anchored; the symptom (FAIL fires too quickly) was real but the proposed mechanism was wrong. The emitter-side discipline would have framed peer-A's observation as *"appears to count from `createdAt` — anyone want to verify?"* rather than as asserted-fact.

### Relationship to §1 (literal output)

§1 covers single-hop verification (paste literal output from your own tool calls). §5 extends this to multi-hop propagation: each hop in a citation chain gets its own §1-style discipline. A citation without re-verification is the multi-hop equivalent of paraphrased close-comment output — same epistemic shape, larger blast radius.

---

## 5b. Literal output is not automatically evidence — check whose, and of what

§1 requires pasting **literal output** rather than narrating it. That is necessary and **not sufficient**: output can be entirely real and still not be evidence for the claim it is attached to. Running the command proves you ran it; it does not prove the bytes describe the thing you are asserting.

Three ways a well-formed reading belongs to something other than the claim:

- **It describes the mechanism instead of being the mechanism.** A `grep` hit inside a comment, docstring, or usage example that sits beside the assignment it documents. *(Observed 2026-08-19: `grep -hoE 'MACF_AGENT_NAME=...' env.identity` matched a comment reading `MACF_AGENT_NAME=foo ./claude.sh` — an override-precedence example — and was reported as the workspace's configured value, with a recommendation to go fix it. The live value was correct.)*
- **It forecasts the thing instead of reporting it.** A plan preview, dry-run, or `WILL happen` line read as a result. *(Same day: an `apply` was killed mid-run because the plan preview said `consent gate 1 WILL open`; the run had already confirmed and correctly reused the existing App.)*
- **It belongs to a different instance of the thing.** The right query against the wrong subject. *(Same day: `pgrep -f claude` on a shared VM returned a **peer agent's** `MACF_AGENT_NAME`; only `/proc/<pid>/cwd` filtering isolated the caller's own process. Same shape as an installation-token check that lists overlapping repos and cannot discriminate which App minted it.)*

**The check, and it is one step:** *does this line come from the thing, or from something adjacent to it?* Read the surrounding lines, not the matching one; confirm the subject, not just the pattern. A `grep` that returns one line has discarded the context that would answer both questions — which is why the failure survives a discipline built on quoting output faithfully.

**Why this is a distinct trap.** The other sections defend against *not looking*. This one fires when you did look, quoted accurately, and the reading was well-formed — the tell is confidence sourced from having run a command rather than from what the command was pointed at. It is the same shape as the silent-fallback class one layer up: an operation that succeeds while its subject is wrong, and nothing about the success surfaces the mismatch.

**Attested across agents** on 2026-08-19: twice by `macf-code-agent` (comment-as-value, preview-as-result), and by `macf-science-agent`'s own catalogued dominant failure mode — documentation, symptoms, summaries, and stale checkouts all reading as the artifact.

---

## 6. When mis-attribution is discovered mid-thread

If you post a comment and later realize it was attributed to the wrong identity (typically: chat-fallback to user because GH_TOKEN was the string "null"), **do not delete-and-repost**. Downstream references — @mentions to you, PR thread anchors, peer agents quoting the comment — break when the original is deleted.

Instead: post a follow-up clarification on the same thread:

> Follow-up: the previous comment on this thread was posted under the wrong identity due to a token-refresh failure. The intended author was `macf-devops-agent[bot]`. Content still stands.

Then fix the root-cause (refresh the token properly, inspect the helper for silent-failure modes — see `gh-token-refresh.md`). Silent delete-and-repost creates a worse audit trail than a clear acknowledgment of the slip.

---

## Why this rule exists

Verification discipline slips most often in the turn *right before a hand-off*: closing an issue, merging a PR, summarizing to a peer. The context buffer feels settled, the task feels done — so we narrate instead of verify. That's exactly when a wrong claim becomes load-bearing on someone else's next action.

Cheap to verify. Expensive to be confidently wrong. Always pay the cheap cost.
