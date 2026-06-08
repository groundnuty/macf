import { describe, it, expect } from 'vitest';
import { isDeliveredTruncated } from '../../src/reconciler/run.js';

// macf#477: the DELIVERED truncation guard must be WINDOW-aware, not
// lifetime-page-fullness-aware. The previous `runs.length >= LIMIT` went dark
// (delivered_ok=false every run) in any repo with >LIMIT lifetime router runs,
// making the reconciler a permanent no-op + blocking #462 self-close.

const LIMIT = 100;
const LOOKBACK = 120 * 60_000; // 120 min
const NOW = Date.UTC(2026, 5, 8, 12, 0, 0);

/** A run-list page of `n` runs (newest-first); only length + the OLDEST (last)
 *  entry's createdAt matter to the guard, so the oldest is set explicitly. */
function page(n: number, oldestOffsetMin: number): Array<{ createdAt: string }> {
  const arr = Array.from({ length: n }, () => ({ createdAt: new Date(NOW).toISOString() }));
  if (n > 0) arr[n - 1] = { createdAt: new Date(NOW - oldestOffsetMin * 60_000).toISOString() };
  return arr;
}

describe('isDeliveredTruncated (macf#477 window-aware truncation)', () => {
  it('(a) full page + oldest-on-page INSIDE the window → truncated (older in-window runs fell off)', () => {
    expect(isDeliveredTruncated(page(LIMIT, 60), NOW, LOOKBACK, LIMIT)).toBe(true);
  });

  it('(b) full page + oldest-on-page OLDER than the window → NOT truncated (window fully covered) [the bug fix]', () => {
    // 100 runs but the oldest is 200 min back — the 120-min window is fully
    // covered; the older entries are simply out-of-window, not truncation.
    expect(isDeliveredTruncated(page(LIMIT, 200), NOW, LOOKBACK, LIMIT)).toBe(false);
  });

  it('page NOT full → never truncated, regardless of oldest', () => {
    expect(isDeliveredTruncated(page(13, 60), NOW, LOOKBACK, LIMIT)).toBe(false);
    expect(isDeliveredTruncated(page(LIMIT - 1, 60), NOW, LOOKBACK, LIMIT)).toBe(false);
  });

  it('empty page → not truncated', () => {
    expect(isDeliveredTruncated([], NOW, LOOKBACK, LIMIT)).toBe(false);
  });

  it('full page + unparseable oldest createdAt → conservative: truncated (unknowable)', () => {
    const runs = page(LIMIT, 60);
    runs[runs.length - 1] = { createdAt: 'not-a-date' };
    expect(isDeliveredTruncated(runs, NOW, LOOKBACK, LIMIT)).toBe(true);
  });

  it('boundary: oldest exactly at the window start → not truncated (predates-or-equals = covered)', () => {
    const runs = page(LIMIT, 0);
    runs[runs.length - 1] = { createdAt: new Date(NOW - LOOKBACK).toISOString() };
    expect(isDeliveredTruncated(runs, NOW, LOOKBACK, LIMIT)).toBe(false);
  });

  it('reproduces the live #477 state: 13 in-window runs (page not full once scoped) → not truncated', () => {
    // After the --created window-scoping, the page holds only in-window runs;
    // 13 < 100 ⇒ not truncated ⇒ delivered_ok=true ⇒ the real join runs.
    expect(isDeliveredTruncated(page(13, 100), NOW, LOOKBACK, LIMIT)).toBe(false);
  });
});
