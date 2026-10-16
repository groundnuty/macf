---
paths:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/test/**"
  - "**/tests/**"
  - "**/__tests__/**"
  - "**/test_*.*"
  - "**/*_test.*"
  - "**/vitest.config.*"
---
# Diagnosing a test timeout

`Test timed out in Nms` has three causes with three different fixes. Work out which before touching `--testTimeout`, because raising it only fits the first.

## The three branches

- Contention: the timeout appears only under parallel load or a busy CI runner and passes alone on an idle box. Raise `--testTimeout`.
- Assertion: an `AssertionError` that reproduces in isolation with a raised timeout already in effect. The test's model of the system is wrong; a longer timeout hides that.
- Budget: the timeout reproduces in isolation on an idle box, and measured per-unit cost times count is at or near the configured ceiling. Nobody measured before sizing the budget. Time the real unit cost, then cut wall time (run independent units concurrently) or set a budget with real margin, at least about 2x the measured cost.

## How to tell them apart

Run the test alone with the timeout raised, and put a stopwatch on per-unit cost times count. Green alone means contention; a red assertion means assertion; a red timeout with a near-budget total means budget.

## Two cautions

- A per-test timeout written inline, as `it('x', { timeout: 30_000 }, fn)` or `it('x', fn, 30_000)`, overrides `--testTimeout`, so raising the flag changes nothing for that test. Grep the test files for these before using the flag, and read the match: `setTimeout(fn, 3000)` in a helper looks the same.
- Do not make a timeout pass by checking less. Keep full coverage and shorten the wall time instead.
