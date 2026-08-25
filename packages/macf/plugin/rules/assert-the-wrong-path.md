# Assert the wrong path was never entered

**Before writing a test assertion, ask: *would this assertion fail if the code were wrong?*** An assertion on the **outcome** frequently would not — because the broken implementation produces the right outcome too, for the wrong reason.

This is `verify-before-claim.md` **§5b** with a different subject. That section asks *"would this output look different if my claim were false?"* about evidence an agent quotes; a test assertion is evidence about code, so the same question becomes the one above. Same discipline, different surface.

---

## Five worked examples, and the weaker sibling each one replaced

All observed in a single working session (2026-08-19/20), across five unrelated subsystems:

| assertion that works | the weaker sibling that passes against the broken code |
|---|---|
| `sleepFn` **throws if called** | *"it completed quickly"* |
| **zero** consent-gate invocations | *"it exited non-zero"* |
| `generateAgentCert` **call count === 1** | *"a cert exists afterwards"* |
| **zero** stderr writes under `--yes` | *"it returned promptly"* |
| `fetchLatest` **never invoked** | *"it targeted the pinned version"* |

**The right-hand column is what a competent person writes first.** Three of these five were written in their weak form and caught only in review. The rule's value is recognising the weak form *while writing it* — which is why the pairing matters more than the technique stated abstractly.

---

## Why the weak form feels sufficient

**Asserting the outcome feels complete because the outcome is what the user experiences.** The wrong-path assertion feels redundant: the result was right, so what is left to check?

What is left is that the result was right **for the intended reason**:

- a **double** cert-issue produces a perfectly valid cert
- an **abandoned** deregister still exits `0`
- a **pointless** poll still terminates
- a **discarded** network read still yields the pinned version

**Correct-by-accident and correct-by-design are indistinguishable from the outcome alone, and only the second survives the next refactor.** The discarded read is one *"let's use it as a fallback"* away from silently restoring the defect — and the outcome test will still pass when it does.

---

## The gate — assert the wrong path when correct-by-accident is REACHABLE

**Do not assert the wrong path everywhere.** A blanket requirement produces ceremonial negative-assertions on paths with no plausible wrong-reason; those decay into noise, get deleted, and take the load-bearing ones with them.

The gate is self-limiting: **can you name a broken implementation that would still produce the right outcome?**

- **Yes** → the outcome assertion cannot distinguish them. Assert the wrong path.
- **No** → the outcome assertion is sufficient, and a negative assertion is ceremony.

Every example above passes the gate trivially, which is the sign it is set at the right height.

---

## Shapes this takes

- **Throw from the fake** — a `sleepFn`/`fetchX` that fails the test if invoked. Strongest: it fails **at the moment of the violation**, with the offending call's arguments in the message.
- **Call-count equality** — `toHaveBeenCalledTimes(1)`, not `toHaveBeenCalled()`. Distinguishes *delegated once* from *worked*.
- **Zero-effect assertions** — no writes, no output, no file created. Proves a seam was **never reached**, not merely that it returned fast.
- **Byte-identity of untouched state** — a refusal that had already written something still "refuses" and passes a weaker check.

---

## The negative form — forbid the wrong assertion, don't merely omit it

Everything above says which assertion to **add**. Sometimes the necessary move is to say which assertion must **not be written at all**.

Acceptance criteria almost always enumerate what must hold. That is sufficient while the wrong verification is *unattractive* — nobody writes it, so nothing needs to forbid it. It stops being sufficient the moment **the wrong verification is the intuitive one**:

> **When a plausible-but-wrong verification exists, the criteria must FORBID it — not merely leave it out.** Omitting it leaves it available; forbidding it makes writing it a spec violation.

### Two triggers, two different remedies

**Trigger 1 — circularity: the reference value comes from what it checks.** The verification cannot fail, so it reports agreement and reads as correctness.

- A manifest **scaffolded from live state**, then validated by diffing it **against live state**. Empty by construction. *"Scaffold it, then run plan and see it clean"* is what a careful person writes unprompted — and it proves self-agreement, not correctness.
- A pin check taking the **modal** value among repos as expected. A uniformly-stale fleet agrees with itself perfectly and reads healthy, while a normal mid-upgrade fleet reads broken.
- Any assertion where the fixture and the expectation are built by the same helper.

**Remedy: forbid the assertion.** There is no right version of it — the shape is the defect.

**Trigger 2 — the spec classifies a state without specifying its observable consequence.** Nothing is circular; the premise is correct, and the leap is to an observable nobody specified.

The worked case:

```ts
expect(code).toBe(0); // stale-pin is a skip, not a halt
```

**The comment is true.** Stale-pin *is* a skip rather than a halt. The spec said what the state **is** and never said what it should **exit** — so the test invented `0`, and the exact bug entered the suite green with correct reasoning attached.

> **A spec that classifies a state without specifying its observable consequence invites the test to invent one.**

**Remedy: specify the consequence — do NOT merely forbid the assertion.** Forbidding `toBe(0)` leaves the right value unstated and the next person guesses again. The fix is the spec sentence *"a roll that leaves any agent behind exits `2`"*, which makes the wrong assertion unwritable rather than merely disallowed.

**Distinguishing them:** ask whether your expected value came from **the population under test** (trigger 1) or from **your own inference about an unstated observable** (trigger 2). A reader who only knows trigger 1 gets *"no, nothing circular here"* on the second case and writes the assertion anyway — which is how this section's own first draft failed to recognise one of the two cases it cited.

### Why omission is not enough

**A defect-as-contract test gets written by someone being careful, not careless.** They write the assertion that seems obviously right, it passes, and it enters the suite green — with a comment explaining the reasoning, which is what makes it durable. Later readers see coverage.

Two found in this repo after the fact: a `stale-pin` test whose assertion **literally equated "not halted" with "exit 0"** — the exact bug it should have caught, sitting green with an explanatory comment; and a health check that measured self-agreement among repos and rendered it as `pins consistent`.

Both would have been prevented by one forbidding line in the spec. Neither was prevented by omission, because omission is silent and the intuitive assertion is loud.

### How to write one

Name the assertion and why it cannot discriminate:

> **No test may assert "scaffolded manifest ⇒ empty plan."** The plan's reference value is derived from the same observation that produced the manifest, so it passes for a manifest that is entirely wrong.

And put the limit **in the tool's own output**, not only in the spec — the spec is read once, at implementation; the output is read every time anyone runs it.

---

## Relationship to the failure shapes

This rule is a **technique**, not a hazard. It is specifically the antidote to the *wrong-target* failure — a test asserting something real that is not the property that broke. The hazard side (a suite that cannot see a defect: wrong target · defect-as-contract · defect-proof world) is catalogued separately; **this is what to write, not what to fear.**

---

## When to read vs modify

- **Read:** when writing any test for a fix. The question costs one sentence of thought.
- **Modify:** never in workspace copies — edit the canonical file and re-distribute.
- **Disagree?** Open an issue with the incident that showed the rule was wrong.

Cross-references: `verify-before-claim.md` §5b (the same question about evidence rather than assertions) · **§5c** (choosing WHICH observable is the result — the sibling error to asserting the wrong property) · **§5d** (an empty result is not evidence of absence unless the instrument would have shown presence — the read-side companion to this rule) · `silent-fallback-hazards.md` (operations that succeed while their semantic outcome is wrong — the runtime analogue).
