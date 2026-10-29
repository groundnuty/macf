import { describe, it, expect, vi } from 'vitest';

vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:readline')>();
  return {
    ...actual,
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb('yes'),
      once: () => undefined,
      on: () => undefined,
      close: () => undefined,
    }),
  };
});

const { realConfirmPlan, realWaitForOperatorBeat } = await import('../../src/cli/commands/bootstrap-apply.js');

function capture(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((t) => (out.push(String(t)), true));
  return { out, restore: () => spy.mockRestore() };
}

describe('operator waits are announced', () => {
  it('the consent-gate prompt is preceded by a blank line and the ▶ ACTION NEEDED banner', async () => {
    const c = capture();
    try {
      await realWaitForOperatorBeat(false)('code-agent', 'consent gate 1 of 2');
    } finally {
      c.restore();
    }
    const all = c.out.join('');
    expect(all).toContain('\n▶ ACTION NEEDED: ');
    expect(all.indexOf('▶ ACTION NEEDED')).toBeLessThan(all.indexOf('press Enter to open the browser'));
  });

  it('the plan confirmation prompt line comes after the banner', async () => {
    const c = capture();
    let ok: boolean;
    try {
      ok = await realConfirmPlan({ items: [], summary: { creates: 0, updates: 0, noops: 0, deletes: 0 }, unimplementedByApply: [] } as never, [], []);
    } finally {
      c.restore();
    }
    const all = c.out.join('');
    expect(ok).toBe(true);
    expect(all).toContain('Type "yes" to proceed');
    expect(all.indexOf('▶ ACTION NEEDED')).toBeGreaterThanOrEqual(0);
    expect(all.indexOf('▶ ACTION NEEDED')).toBeLessThan(all.indexOf('Type "yes" to proceed'));
  });
});
