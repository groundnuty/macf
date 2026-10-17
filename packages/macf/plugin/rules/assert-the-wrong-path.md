---
paths:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/test/**"
  - "**/tests/**"
  - "**/__tests__/**"
  - "**/test_*.*"
  - "**/*_test.*"
---
# Writing tests that can fail

Ask of every assertion and every check: would this have come out differently if the code were wrong? If not, it was settled before the code ran and proves nothing.

## What to do

- Assert that the wrong path was never entered when a broken implementation could still give the right outcome. Throw from a fake that must not be called, use `toHaveBeenCalledTimes(1)` over `toHaveBeenCalled()`, assert zero writes or zero output where none is expected. A double cert-issue still yields a valid cert, so asserting "a cert exists" cannot tell the two apart.
- Skip the negative assertion when no broken implementation could pass the outcome check; it would only be noise.
- Mutation-test a fix: break it, re-run, and confirm a test fails. A test that passes without the fix tests something else.
- After loosening a failing assertion, invert the loosened form and confirm it still fails. A relaxation that cannot fail is a surrender, not a fix.
- Build the population the failure needs: a mixed created+reused fixture, a cold scope, the label a repair removed. Change inputs, never the mechanism under test (the cap, the threshold, the predicate).
- Prove the search space is non-empty before trusting a zero. A `grep -c` of 0 on a missing file looks like a clean pass. Use a sibling that would have matched, or the subject's own use count, as the control.
- Extract a cited number by field (`awk '{print $5}'`, `--jq`), never by character offset; `cut -c` silently drops digits.
- Check which observable is the result. Acceptance is immediate; availability (an npm listing, a cache) is eventually consistent. If a check needs a retry budget, it is waiting on a consequence, not the result.
