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

## Relationship to the failure shapes

This rule is a **technique**, not a hazard. It is specifically the antidote to the *wrong-target* failure — a test asserting something real that is not the property that broke. The hazard side (a suite that cannot see a defect: wrong target · defect-as-contract · defect-proof world) is catalogued separately; **this is what to write, not what to fear.**

---

## When to read vs modify

- **Read:** when writing any test for a fix. The question costs one sentence of thought.
- **Modify:** never in workspace copies — edit the canonical file and re-distribute.
- **Disagree?** Open an issue with the incident that showed the rule was wrong.

Cross-references: `verify-before-claim.md` §5b (the same question about evidence rather than assertions) · **§5c** (choosing WHICH observable is the result — the sibling error to asserting the wrong property) · **§5d** (an empty result is not evidence of absence unless the instrument would have shown presence — the read-side companion to this rule) · `silent-fallback-hazards.md` (operations that succeed while their semantic outcome is wrong — the runtime analogue).
