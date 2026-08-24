# Test-Timeout Discriminator (canonical, shared)

**A red test that reads `Test timed out in Nms` is not one failure shape — it is three, and they take three different fixes.** Treating them as one collapses a fix that doesn't work for the actual cause onto a symptom that merely resembles the shape it was written for.

---

## The three branches

1. **Environment claim (contention).** The identical red reproduces only under parallel-test-file load or a loaded CI runner, and disappears re-run alone / on an idle box. Fix: raise `--testTimeout` (or the margin was already real and this was noise).
2. **Assertion claim (system claim).** An `AssertionError` — not a timeout — reproducing IN ISOLATION, WITH a raised timeout already in effect. The test's model of the system and the system disagree. Raising `--testTimeout` does nothing for this shape; it buries the disagreement instead of resolving it.
3. **Budget claim (measure-first).** The timeout reproduces in ISOLATION too, on an idle box, with no other process competing for the runner — but the test's *measured* unit cost × count is genuinely at or near the configured ceiling. This is neither contention nor a wrong assertion: nobody measured the work before sizing the budget. Fix: measure the real per-unit cost, then either reduce total wall time (without dropping coverage — see `assert-the-wrong-path.md`'s sibling caution against correctness-by-omission) or set a budget with **real margin** over the measured cost. Never carry a round number that was guessed rather than measured.

**Discriminating between them:** run the reproducer (a) in isolation, with the timeout already raised, and (b) with a stopwatch on the actual per-unit cost × count.

- Isolation goes GREEN at a materially different (lower) number → branch 1 (contention).
- Isolation goes RED as an `AssertionError`, not a timeout → branch 2 (assertion).
- Isolation is STILL a timeout, and the measured total is at or near the configured budget → branch 3 (budget).

Branches 1 and 2 were the original two-branch form of this discriminator (`macf-prompt-watcher.test.ts`, groundnuty/macf#1103). Branch 3 was added after it was misdiagnosed as branch 1 for a full working session (groundnuty/macf#1133) — see the worked example below.

---

## Worked example — branch 3 (macf#1133)

`commit-msg.test.ts`'s `'allows each type in the commitlint enum'` test called the real `.githooks/commit-msg` hook once per commitlint type (13 types) inside a sequential loop, under a hardcoded `{ timeout: 30_000 }`. Measured per-invocation cost: 1.3–2.7s (idle box) — each spawn loads commitlint's ESM module graph fresh. **13 × 1.3–2.7s = 20–34s against a 30s ceiling: already AT its own budget with no headroom before a single other test file added contention.** It read as branch 1 (fails on nearly every full-suite run, passes in isolation) and was misdiagnosed as such roughly fifteen times in one session — a correct-by-luck conclusion, because the premise (contention) was wrong even though the recommendation (something needs fixing) was right.

**Compounding factor, general to the whole class:** the budget was a hardcoded inline `{ timeout: 30_000 }` on the `it(...)` call, which **overrides `--testTimeout` from the CLI**. Every attempt to "raise the timeout and re-run" during that session changed a number that was never in effect — see the corollary below.

**The fix was concurrency, not a bigger number.** The 13 invocations now run via `Promise.all` + async `spawn` instead of a sequential loop, so wall time is bounded by the slowest single spawn plus scheduling overhead, not the sum of all 13. Full coverage (every commitlint type, through the real hook subprocess) was preserved — no test cases were dropped to make the clock (see `#1103`'s "stabilise by checking less" caution: a suite that goes green by checking less is not fixed, it is degraded).

---

## Corollary — hardcoded inline timeouts silently defeat `--testTimeout`

Vitest supports a per-test timeout override two ways, both of which **override the CLI-level `--testTimeout` flag** and are consequently invisible to "just raise the flag":

```ts
it('name', { timeout: 30_000 }, () => { /* ... */ });   // object-form 2nd arg
it('name', () => { /* ... */ }, 30_000);                 // bare-number 3rd arg
```

Before reaching for `--testTimeout` as a fix for a timing-flaky test, check whether the failing test carries one of these — if it does, the flag is a no-op for that test and the fix has to touch the inline value (or the underlying cost) directly.

```bash
# Object-form:
grep -rn 'timeout:\s*[0-9_]' test/
# Bare-number 3rd-arg form (closing brace, comma, a number, closing paren):
grep -rnE '^\s*\},\s*[0-9]{3,7}\s*\);?\s*$' test/
```

**Both forms need eyeballing, not blind trust** — the bare-number regex in particular has false positives (e.g. a plain `setTimeout(fn, 3000)` callback delay inside a test helper reads identically to a bare-number `it(...)` timeout at the text level; only checking what opens the block disambiguates them). Same principle applies to the object-form grep against test-fixture data that happens to contain a `timeout` key unrelated to vitest's own API (e.g. a `settings.json` hook-config object under test).

**Once you've found the inline timeouts in a suite, verdict each — don't assume they're all safe or all suspect.** For every hit: measure the actual cost, compute margin = budget ÷ measured. Margin under ~2× is not "fixed", it is "hasn't tipped over yet" — the same one-run-passed trap `verify-before-claim.md` warns about generally, applied to timing specifically (a green run at a near-budget number proves nothing without the margin measured).

---

## When to read vs modify

- **Read:** when a test times out and you're deciding whether to raise `--testTimeout` — before you touch the flag, work out which of the three branches you're looking at.
- **Modify:** never in workspace copies — edit the canonical file and re-distribute.
- **Disagree?** Open an issue with the incident that showed the rule was wrong.

Cross-references: `macf-prompt-watcher.test.ts`'s `TEST-FAILURE DISCRIMINATOR` doc comment (groundnuty/macf#1103) — origin of branches 1+2, kept in sync with this file · `assert-the-wrong-path.md` — a sibling test-writing discipline about what an assertion actually proves, the same question applied here to what a timeout actually proves · `verify-before-claim.md` — measure, don't infer, before asserting a root cause · `silent-fallback-hazards.md` — the runtime analogue (operations that succeed at the API boundary while their semantic outcome is wrong); this rule is the test-authoring analogue (a suite that goes green while its margin is an illusion).
