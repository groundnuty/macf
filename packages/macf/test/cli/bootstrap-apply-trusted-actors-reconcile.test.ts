/**
 * Tests for `bootstrap-apply.ts::formatTrustedActorsReconciliationLines` —
 * the "confirmation at the point they occur" enumeration groundnuty/macf#1319
 * adds for a PRESENT-but-diverging `MACF_TRUSTED_ACTORS` value. Mirrors
 * `bootstrap-apply-deletion-consent.test.ts::formatDeletionEnumerationLines`'s
 * own coverage shape (enumerate, don't just count) for the sibling
 * update-verb confirmation.
 */
import { describe, it, expect } from 'vitest';
import { formatTrustedActorsReconciliationLines } from '../../src/cli/commands/bootstrap-apply.js';
import type { TrustedActorsDivergence } from '../../src/cli/bootstrap/apply-routing.js';

describe('formatTrustedActorsReconciliationLines', () => {
  it('empty input renders no lines at all — nothing to confirm', () => {
    expect(formatTrustedActorsReconciliationLines([])).toEqual([]);
  });

  it('shows OBSERVED vs DECLARED for every divergent repo, never just a count', () => {
    const divergences: readonly TrustedActorsDivergence[] = [
      { repo: 'groundnuty/demo-code', observedValue: 'demo-fleet-code-agent[bot]', desiredValue: 'demo-fleet-code-agent[bot] demo-fleet-science-agent[bot]' },
      { repo: 'groundnuty/demo-science', observedValue: 'demo-fleet-code-agent[bot]', desiredValue: 'demo-fleet-code-agent[bot] demo-fleet-science-agent[bot]' },
    ];
    const rendered = formatTrustedActorsReconciliationLines(divergences).join('\n');

    expect(rendered).toContain('2 repo(s)');
    for (const d of divergences) {
      expect(rendered).toContain(d.repo);
      expect(rendered).toContain(d.observedValue);
      expect(rendered).toContain(d.desiredValue);
    }
    // A y/n gate — the operator must be asked, not merely informed.
    expect(rendered.toLowerCase()).toContain('yes');
  });
});
