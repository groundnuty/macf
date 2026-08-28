# Assert the wrong path was never entered

**Before writing a test assertion, ask: *would this assertion fail if the code were wrong?*** An assertion on the **outcome** frequently would not — because the broken implementation produces the right outcome too, for the wrong reason.

## The general form: could this check have come out differently?

**The question above is the test-assertion case of one property.** It applies to every instrument, not only to assertions:

> **An instrument whose result is independent of the thing measured is not an instrument.** Before trusting a check — a test, a grep, an API call, a fixture, a mock — ask **could this have come out differently?** If no, the reading was guaranteed before the system was consulted.

Five instruments observed failing this in one session (2026-08-27/28, three agents), each of which *reported* successfully:

| the instrument | why its result was guaranteed |
|---|---|
| `GET /orgs/<name>` where the account is a **User** | 404 by construction — identical from every credential, forever |
| `grep` against a path that does not exist | identical whether the string is present or absent |
| a fixture that **writes** the file whose read is under test | identical whether the read path is broken |
| a mock on `console.error` where the code writes `process.stderr` | identical whether anything is emitted at all |
| a substring match (`realDeleteRepo` matching `realDeleteRepoVariable`) | matches a name that was never the target |

### The second question: was the pipeline lossless?

**The question above catches an instrument that was never connected to the system. It does not catch a connected instrument whose reading is corrupted on the way to being cited.**

```
guaranteed reading   "could this check have come out differently?"        ← epistemic:
                                                                            is the instrument
                                                                            connected at all
corrupted reading    "did anything between the MEASUREMENT and the
                      CITATION have the power to alter the value?"        ← mechanical:
                                                                            is the pipeline
                                                                            lossless
```

**Neither implies the other.** The worked case (2026-08-28): `ls -la | grep … | cut -c30-120` reported a file as **`8835`** bytes; it is **`18835`**. **`cut -c` sliced the leading digit off the size column** — a transform added for readability that silently edited the data.

**This class is harder to catch than a guaranteed reading, not easier.** A guaranteed reading is *always* wrong, so it fails on the first case anyone examines. A character-offset truncation is *usually* right — it bites only when a column crosses the offset.

> **Systematic corruption gets noticed. Intermittent corruption gets cited.** The pipeline that produced `8835` had worked correctly on dozens of commands before it.

**And the corrupted value was plausible.** `8835` is an ordinary byte count; nothing about it announced a missing digit. **A guaranteed reading invites the question; a plausible wrong value closes it.**

**The mechanical rule:** `cut -c` is for prose. **A value you intend to cite is extracted by field — `awk '{print $5}'`, `--jq`, `grep -c`, `wc -l` — never by character offset.** Applies equally to `head -c`, a fixed-width `printf`, and any truncation applied for display that a number then travels through.

**Mutation is the operation that asks this question mechanically** — break the thing; if the check does not notice, the check was never connected to it. That is why every mutation requirement in this rule is load-bearing rather than ceremonial. **The cost of relying on mutation alone is that it answers late**, after the work is written; asking the question first is free.

**Note the altitude, stated as an open question rather than a restructure:** trigger 3 (*the population excludes the failing case*) and trigger 4 (*an empty result from an empty search space*) both look like instances of this property rather than peers of trigger 1 — **in each, the reading was guaranteed.**

**That argument rests on the shared mechanism, not on when the instances arrived.** The distinction matters, because co-arrival is a weaker signal than it appears:

> **Instances can co-arrive because someone was looking.** A session spent hunting instrument failures surfaces instrument failures together whether or not they share a mechanism. **Co-arrival is a smell, not a finding** — it says *check whether these share a mechanism*; it does not say they do.

**Trigger 4's five instances are exactly that case:** found by looking for instrument failures, so their co-arrival is partly attention. **What makes the subcase reading convincing is that both triggers reduce to the same sentence — and that would hold if the instances had arrived over five months.** The clustering only prompted the question.

**Recorded here to be argued with, not acted on.** The triggers are cited by number across issues and PRs; they are not renumbered.

---

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

### Four triggers, four different remedies

**Each trigger states its recurrence** — how many independent arrivals it rests on, and over what span. A trigger whose instances all arrived together is a *candidate* for being an instance of something else rather than a peer; the count prompts that question and the mechanism answers it. Where provenance is not recoverable from the issue trail, the line says **unrecorded** rather than inventing a number.

**Recurrence:** introduced in `#1154`, split from trigger 2 in `#1155`. Rests on the doc's five worked examples above — **one working session, 2026-08-19/20, across five unrelated subsystems.** The number of *independent* arrivals since is **unrecorded**.

**Trigger 1 — circularity: the reference value comes from what it checks.** The verification cannot fail, so it reports agreement and reads as correctness.

- A manifest **scaffolded from live state**, then validated by diffing it **against live state**. Empty by construction. *"Scaffold it, then run plan and see it clean"* is what a careful person writes unprompted — and it proves self-agreement, not correctness.
- A pin check taking the **modal** value among repos as expected. A uniformly-stale fleet agrees with itself perfectly and reads healthy, while a normal mid-upgrade fleet reads broken.
- Any assertion where the fixture and the expectation are built by the same helper.

**Remedy: forbid the assertion.** There is no right version of it — the shape is the defect.

**Recurrence:** split out of trigger 1 in `#1155` — **same session as trigger 1 (2026-08-19/20)**, not an independent arrival. Instance count since: **unrecorded.**

**Trigger 2 — the spec classifies a state without specifying its observable consequence.** Nothing is circular; the premise is correct, and the leap is to an observable nobody specified.

The worked case:

```ts
expect(code).toBe(0); // stale-pin is a skip, not a halt
```

**The comment is true.** Stale-pin *is* a skip rather than a halt. The spec said what the state **is** and never said what it should **exit** — so the test invented `0`, and the exact bug entered the suite green with correct reasoning attached.

> **A spec that classifies a state without specifying its observable consequence invites the test to invent one.**

**Remedy: specify the consequence — do NOT merely forbid the assertion.** Forbidding `toBe(0)` leaves the right value unstated and the next person guesses again. The fix is the spec sentence *"a roll that leaves any agent behind exits `2`"*, which makes the wrong assertion unwritable rather than merely disallowed.

**Recurrence:** `#1236`, refined by `#1242` (prospective form) and `#1251` (mechanism guard). **Two instances, at different scales**, stated in the trigger itself. **Re-arrived independently on 2026-08-27** as `#1311`'s fixture — which wrote the very file whose read was under test — so this is the one trigger with a confirmed arrival after a gap.

**Trigger 3 — the population under test excludes the failing case by construction.** Nothing is circular and the consequence is specified; the assertion is correct for every case it can see. **The case it cannot see is the one the code gets wrong.**

Two instances, at different scales — which is what makes this a trigger rather than an anecdote:

| | population | the case it excluded |
|---|---|---|
| a same-run vault fix | fixtures with **all-created** agents | **mixed created+reused** — the fix misdiagnosed reused roles, and every all-created run passed |
| every fleet e2e ever run | the **warm** `macf-experiment` org | **a cold scope** — shared Apps were reused-not-created and credentials pre-existed, so cold-start was never exercised |

The first is a fixture; the second is an entire test environment. **The exclusion can live anywhere the population is chosen**, and a green suite proves only that the chosen population passes.

**Remedy: ask the population question before trusting the result.**

> **What case cannot appear in this population, and is that the case the code is most likely to get wrong?**

For the vault fix the answer was *reused roles*, and it was. For the fleet e2e it was *a cold scope*, and it was.

**The prospective form — make the population able to exhibit the failure: restore what a repair removed, or construct what the population never contained.** The retrospective question (*what case did this population exclude?*) diagnoses; the prospective act makes the population able to fail again. It covers all three known cases: **restore** the label a mid-incident hand-repair had put back, so a verification run had something only the fix could create; **construct** a mixed created+reused fixture where every fixture was all-created; **provision** a cold scope where every environment had been warm. A fixture that cannot exhibit the failure validates nothing, however green it runs.

**Construct the population; never modify the mechanism.** A fixture is an *input* to the thing under test, so widening it is legitimate. The cap, the threshold, the predicate — those *are* the thing under test, and bending them to produce a pass is manufacturing the evidence. The pair, from one evening:

- **Legitimate** — delete a label a prior hand-repair had restored, so a run has something only it can create.
- **Illegitimate** — lower a sweep's cap from 5 so the issue under test appears in its own output.

**And its cheap companion — mutation as habit:** break the fix, re-run, confirm a test notices. **A test that passes with the fix removed is testing something else.** One fix shipped merged-and-green while its emitting call site stayed broken, because its tests asserted the mechanism in general rather than at the site; its replacement was proven load-bearing by disabling it and watching the assertion fail. **The cost is a single deliberately-broken run.**

**Recurrence:** `#1257`. **Five instances, ONE session (2026-08-27), two agents** — and per the confound noted above, instances found while hunting instrument failures co-arrive partly because of attention. **This trigger has no confirmed arrival after a gap.** Its case rests on the shared mechanism, not the count.

**Trigger 4 — an empty result from a search space that was empty.** The instrument reported nothing found, and nothing was searched. **The two outputs are identical and their meanings are opposite:**

```
grep -c X missing-file   →  0      ← searched nothing
grep -c X real-file      →  0      ← X is genuinely absent
```

The cases this covers, and each is caught by the same one-second act: **a path that does not exist**, **a typo'd path**, **a glob the shell ate before the command saw it**, **a `--jq` filter on a key that is not there**. Two that nearly became claims: a `grep` against **an invented filename** returned `0` and would have asserted a design amendment was never written — it was, in a file one word different; and an unquoted `--include=*.ts` **eaten by the shell** returned empty output that read as *"nothing references this."*

**Remedy: prove the search space is non-empty before believing an empty result.** `ls` the file. `wc -l` it. Count matches of something you know is there. **One extra command turns an uninformative zero into a real one.**

**Two neighbours it does NOT cover — and applying this remedy to them certifies the mistake**, because `ls` passes and the reading is still wrong:

- **Scope incompleteness** — the instrument reads a subset of where the answer lives. A repo-level variable listing exists and returns variables; the one you want is defined at the org level. **Remedy: enumerate the levels**, not the space.
- **Currency** — the artifact read is real but is not the one anyone runs: a stale checkout, a local file behind `origin/main`. **Remedy: name the provenance** — `git show origin/main:<path>`, or query the API rather than the working tree.

**Not trigger 3.** That one asks *what case can this population not produce* and is answered by **constructing** the missing case. This one asks *did I search anything at all* and is answered by **proving the space exists**. A trigger-3 population is real but narrow; a trigger-4 population is not there.

**The inverse deserves the same suspicion:** a *non-empty* result from a failed call. `--jq .value` against a **404** returns the error body — and it was **uniform across every subject**, which is the tell. Identical results across subjects that should differ means the wrong thing is being measured; thirteen unrelated repos do not agree to the byte.

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
