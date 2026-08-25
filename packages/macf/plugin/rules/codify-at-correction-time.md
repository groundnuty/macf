# Codify at Correction Time

**When peer correction reveals a substrate-discipline gap — write the workbench rule (or in-thread codification) immediately, not later.** Codify-at-correction-time is the substrate's natural Stage-3 mechanism for absorbing peer correction; making it canonical promotes it from emergent property to expected discipline.

This rule is the cross-agent canonical version of the `codify-at-decision-time` workbench discipline. They're complementary:

- **Decision time** — codify when introducing a new path / file / env var / workaround the canonical rules don't yet acknowledge. Pre-emptive.
- **Correction time** — codify when peer correction surfaces a gap in your existing application of canonical rules. Post-hoc.

Both are species of "make the lesson explicit and durable rather than implicit and fragile."

---

## When to fire

Within ~2 turns of any of the following:

- **Peer surfaces a class-of-slip** in your behavior (not just a single instance — they identify a recurring shape: *"this is the third time you've...")
- **You concede after pushback** + the concession represents new framing worth preserving past this thread
- **Your application of a canonical rule misfired** in a way that's not directly addressed by the rule's existing text — you've found the gap before the canonical rule has
- **A peer's correction lands a useful generalization** of the canonical rule (e.g., "verify-before-claim cuts at every hop, not just the original claim")

The trigger is *peer correction surfaces a substrate-discipline pattern*, not just *peer correction happens*. Routine "you got X wrong, fix it" doesn't require codification — only patterns that generalize past this incident.

---

## Before you write it — the instance list is the test suite for a rule

A rule is written from instances. **Those instances are its test suite, and the rule is not written until they pass.**

Run both checks before writing, not after:

**1. Membership — is every instance I listed actually in the class I described?**

**2. Recognition — would my stated TRIGGER identify each of them prospectively, given only what a reader knows before the fact?**

The usable form of (2): **take each listed instance, hide the diagnosis, and ask whether the trigger alone would flag it.**

### Two is the one that keeps failing

It is harder than (1) because **the author already knows the answer.** The trigger looks sufficient precisely because you are reading it with the instance in mind — you supply the recognition yourself and never notice the rule did not.

> **A rule written from an instance inherits that instance's trigger, and the trigger is almost always narrower than the rule.** The generalisation gets stated; the recognition condition stays as specific as whatever prompted it.

### Three worked failures, two authors, two days

**Recognition failures** — the instance *was* in the class, and the stated trigger could not identify it:

- A rule said *"forbid the plausible-but-wrong verification"* and named **circularity** as the trigger. One of its own two cited instances derived no expected value from anything observed — its premise was correct and the leap was to **an unstated observable**. A reader applying the trigger gets *"nothing circular here"* and writes the assertion anyway.
- A rule said *"re-verify a peer's claim before promoting it"*, with examples that implied the trigger was **uncertainty**. The case it could not recognise was **agreement** — where checking feels most wasted and a wrong result is invisible, because nobody re-examines a corroboration.

**A membership failure** — a listed instance was not in the class at all:

- Four stalled issues were unified as *"a claim about future state, recorded once, never re-presented."* Three were promises needing re-presentation. The fourth was an **assertion that was false when written** and needed checking once, immediately. One mechanism would have fitted three and quietly under-served the fourth.

**All three were caught by a reader re-running the instance list against the stated rule** — never by the author, and never by review of the prose alone.

### Why this belongs before writing

This is the same discipline `assert-the-wrong-path.md` applies to code, turned on the rule itself: **a rule that cannot fail on any of its own instances has not been tested.** Applying it after publication means the distributed copy is already wrong — and a canonical rule reaches every workspace.

---

## How to codify

Two surfaces, both useful:

### Workbench memory (private, durable across sessions)

Write a one-page feedback memory at `~/.claude/projects/.../memory/feedback_<slug>.md` (or your agent's equivalent memory location). Format:

    ---
    name: <one-line rule statement>
    description: <when to apply, why it exists>
    type: feedback
    ---

    <body: rule + when-to-apply + when-NOT + cross-references>

The memory loads on session start; future sessions inherit the discipline.

### In-thread paper-trail (durable on GitHub, audit-able)

If your agent class doesn't have durable workbench memory (e.g., ephemeral testers whose workspace regenerates on bootstrap), or if the lesson belongs in the paper-trail, post the codification as a comment on the thread where it surfaced:

    Pattern worth noting on my side: [class-of-slip articulated explicitly]. Hit N times in [window]; corrective shape is [what to do differently].

The thread becomes the durable substrate-of-codification. Future readers (peers, paper authors, future-you) can audit the codification chain via GitHub's issue history.

For research-grade findings: BOTH surfaces. Memory captures the lesson; the paper-trail comment makes it citable.

---

## Multi-agent codification cascades are the goal, not redundant work

When peer correction surfaces a substrate-discipline gap, expect multiple agents to independently codify the same lesson, often within minutes of each other. This is feature, not redundancy:

- **Cross-agent attestation** of the same meta-rule provides stronger evidence that the lesson generalizes than a single-agent codification
- **Memory-naming convergence** across agents (similar slugs, similar structure) is a signal that the rule is genuinely general
- **Codification-mechanism diversity** (memory file, in-thread comment, workbench rule promotion, retroactive-application announcement) is appropriate per agent — each agent's persistence model differs

Observed 2026-04-25 / 2026-04-26: 11 codification events across 4 agents (3 substrate + 1 measurement) in ~36 hours, on 3 distinct canonical-rule refinements + the meta-rule itself. Multi-agent codification cascades produced this pattern as a substrate-level emergent property; making the codification habit canonical promotes it from emergent to expected.

See `groundnuty/macf-science-agent:insights/2026-04-26-verify-at-every-hop-emitter-receiver-cross-cell.md` for the case study + meta-tally of the events that motivated this rule's promotion.

---

## When NOT to codify

- The correction was for a single instance with no recurring shape (one-off bug ≠ pattern)
- The lesson is already captured by an existing canonical rule (don't duplicate; reference)
- The agent's correction was substantively wrong and you're conceding to maintain harmony rather than because the framing is right (push back per `peer-dynamic.md`)
- Mid-flow on something more important + can defer by ≤1 turn safely

---

## Apply in real time

The discipline isn't aspirational — it's operational on the next decision after codification. If you save the rule at turn N, you're expected to apply it at turn N+1 (or have an explicit reason not to).

Observed 2026-04-25: code-agent saved `feedback_verify_at_every_hop_when_citing_peer_evidence.md` at ~18:38Z and applied it the same minute by deferring a fix that would have re-framed peer evidence without re-verification. Codify-at-correction-time + immediate application is the full pattern.

---

## Cross-references

- `verify-before-claim.md` §5 — the verify-at-every-hop discipline this rule operationalizes the codification habit for
- `peer-dynamic.md` — the broader peer-correction protocol this rule extends (correct each other through dialogue → codify the dialogue's lessons)
- `coordination.md` — the substrate-level coordination protocol that makes peer correction reliable enough for codification cascades to emerge
