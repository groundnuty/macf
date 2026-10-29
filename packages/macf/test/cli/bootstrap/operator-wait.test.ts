import { describe, it, expect, vi } from 'vitest';
import { actionNeededBanner, announceOperatorWait, MAX_REMINDERS, REMINDER_INTERVAL_MS } from '../../../src/cli/bootstrap/operator-wait.js';

describe('operator wait banner', () => {
  it('writes a blank line then the ▶ ACTION NEEDED banner', () => {
    const out: string[] = [];
    const stop = announceOperatorWait('type "yes".', (t) => out.push(t));
    stop();
    expect(out).toEqual([`\n${actionNeededBanner('type "yes".')}\n`]);
    expect(out[0]).toContain('▶ ACTION NEEDED: type "yes".');
  });

  it('repeats every 60 s, at most 10 times, and stops when told', () => {
    vi.useFakeTimers();
    try {
      const out: string[] = [];
      announceOperatorWait('x', (t) => out.push(t));
      vi.advanceTimersByTime(REMINDER_INTERVAL_MS * (MAX_REMINDERS + 5));
      expect(out).toHaveLength(1 + MAX_REMINDERS);
      const out2: string[] = [];
      const stop = announceOperatorWait('y', (t) => out2.push(t));
      vi.advanceTimersByTime(REMINDER_INTERVAL_MS * 2);
      stop();
      vi.advanceTimersByTime(REMINDER_INTERVAL_MS * 5);
      expect(out2).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
