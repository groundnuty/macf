/**
 * Tests for the protected-invariant parser + subordination-check heuristics
 * (macf#503, DR-026 G1). Also pins that the parser handles the REAL on-disk
 * `design/protected-invariants.md` (10 invariants) and does not mistake the
 * "Amending this set" numbered list for invariants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseInvariants,
  invariantsTouched,
  readsAsRelaxation,
} from '../../../src/cli/propose/invariants.js';

const SAMPLE = `# Protected invariants

## The invariants

1. **Reporter-owns-closure accountability.** The agent who opened an issue owns its closure.
2. **Identity ↔ attribution.** Every agent action is attributed to that agent's bot.
3. **No-self-merge / LGTM gate.** No PR merges without a non-author APPROVED review.

## Amending this set

1. A PR editing this file.
2. Explicit operator ratification.
`;

describe('parseInvariants', () => {
  it('extracts only the invariant list, not the amendment list', () => {
    const inv = parseInvariants(SAMPLE);
    expect(inv).toHaveLength(3);
    expect(inv.map((i) => i.index)).toEqual([1, 2, 3]);
    expect(inv[0]!.title).toBe('Reporter-owns-closure accountability');
  });

  it('builds keyword sets from title words + curated keywords', () => {
    const inv = parseInvariants(SAMPLE);
    const lgtm = inv.find((i) => i.index === 3)!;
    expect(lgtm.keywords).toContain('merge');
    expect(lgtm.keywords).toContain('lgtm');
    expect(lgtm.keywords).toContain('approved');
  });
});

describe('invariantsTouched', () => {
  const inv = parseInvariants(SAMPLE);

  it('matches text mentioning a merge/approval to the LGTM-gate invariant', () => {
    const touches = invariantsTouched('let a PR merge without an approved review', inv);
    expect(touches.some((t) => t.index === 3)).toBe(true);
  });

  it('matches token/attribution text to the identity invariant', () => {
    const touches = invariantsTouched('refresh the bot token for attribution', inv);
    expect(touches.some((t) => t.index === 2)).toBe(true);
  });

  it('returns empty for text touching no invariant keyword', () => {
    expect(invariantsTouched('prefer ripgrep over grep', inv)).toHaveLength(0);
  });
});

describe('readsAsRelaxation', () => {
  it('flags weaken/relax/drop/without-approval phrasings', () => {
    expect(readsAsRelaxation('relax the LGTM gate')).toBe(true);
    expect(readsAsRelaxation('allow self-merge')).toBe(true);
    expect(readsAsRelaxation('merge without a review')).toBe(true);
    expect(readsAsRelaxation('make the mention optional')).toBe(true);
  });

  it('does NOT flag additive/specializing phrasings', () => {
    expect(readsAsRelaxation('add a reminder to refresh the token')).toBe(false);
    expect(readsAsRelaxation('always include an @mention')).toBe(false);
  });
});

describe('real on-disk protected-invariants.md', () => {
  // Walk up from the test file to find the repo root that holds design/.
  function repoRoot(): string | null {
    let dir = __dirname;
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(join(dir, 'design', 'protected-invariants.md'))) return dir;
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  it('parses exactly the 10 ratified invariants from the live doc', () => {
    const root = repoRoot();
    if (!root) {
      // Defensive: in some packaging layouts design/ may not be reachable.
      // Don't fail the suite — the synthetic-fixture tests above carry the logic.
      return;
    }
    const md = readFileSync(join(root, 'design', 'protected-invariants.md'), 'utf-8');
    const inv = parseInvariants(md);
    expect(inv).toHaveLength(10);
    expect(inv.map((i) => i.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Invariant #8 is the auditor-never-acts guardrail this whole feature obeys.
    expect(inv[7]!.title).toMatch(/Auditor never-acts/i);
  });
});
