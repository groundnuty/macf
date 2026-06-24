/**
 * Tests for the structured-norm projection of the 10 protected invariants
 * (groundnuty/macf#504, DR-026 G2 — PR-1). See `src/protected-invariant-norms.ts`
 * and `design/protected-invariants.md`.
 *
 * Asserts: (a) every converted norm is schema-valid + canonical, (b) the
 * norm-vs-structural taxonomy split covers all 10 with no overlap, and (c) the
 * converted set is self-consistent under the conflict-checker.
 */
import { describe, it, expect } from 'vitest';
import {
  NormSchema,
  detectNormConflicts,
} from '../src/norm.js';
import {
  PROTECTED_INVARIANT_NORMS,
  PROTECTED_STRUCTURAL_INVARIANTS,
  PROTECTED_INVARIANT_TAXONOMY,
  StructuralInvariantSchema,
} from '../src/protected-invariant-norms.js';

describe('protected-invariant norm conversion', () => {
  it('every converted invariant is a schema-valid canonical norm', () => {
    for (const n of PROTECTED_INVARIANT_NORMS) {
      // Re-parsing must succeed and round-trip unchanged (already canonical).
      const reparsed = NormSchema.parse(n);
      expect(reparsed).toEqual(n);
      expect(n.tier).toBe('universal'); // the constitutional core is universal
      expect(n.provenance).toMatch(/^protected-invariants\.md #\d+$/);
    }
  });

  it('every structural invariant is schema-valid + names an enforcement mechanism', () => {
    for (const s of PROTECTED_STRUCTURAL_INVARIANTS) {
      expect(() => StructuralInvariantSchema.parse(s)).not.toThrow();
      expect(s.enforcement.length).toBeGreaterThan(0);
      expect(s.whyNotANorm.length).toBeGreaterThan(0);
    }
  });

  it('models the specific named invariants from the spec', () => {
    const byId = new Map(PROTECTED_INVARIANT_NORMS.map((n) => [n.id, n]));

    // #1 reporter-owns-closure = obligation(reporter, close-issue, after-merge)
    const i1 = byId.get('pi-1-reporter-owns-closure')!;
    expect([i1.deontic, i1.role, i1.action, i1.condition]).toEqual([
      'obligation',
      'reporter',
      'close-issue',
      'after-merge',
    ]);

    // #3 LGTM-gate = prohibition(implementer, merge-pr, without-non-author-approval)
    const i3 = byId.get('pi-3-lgtm-gate')!;
    expect([i3.deontic, i3.role, i3.action, i3.condition]).toEqual([
      'prohibition',
      'implementer',
      'merge-pr',
      'without-non-author-approval',
    ]);

    // #5 auto-close = prohibition(implementer, auto-close-keyword, on-foreign-reporter-issue)
    const i5 = byId.get('pi-5-auto-close-discipline')!;
    expect([i5.deontic, i5.role, i5.action, i5.condition]).toEqual([
      'prohibition',
      'implementer',
      'auto-close-keyword',
      'on-foreign-reporter-issue',
    ]);

    // #8 auditor-never-acts = three positive-action prohibitions for the auditor.
    const auditorProhibitions = PROTECTED_INVARIANT_NORMS.filter(
      (n) => n.role === 'auditor' && n.deontic === 'prohibition',
    );
    expect(auditorProhibitions.map((n) => n.action).sort()).toEqual([
      'close-issue',
      'implement',
      'merge-pr',
    ]);

    // #9 operator-as-ratifier = obligation(operator, ratify-rule-change, always)
    const i9 = byId.get('pi-9-operator-ratifier')!;
    expect([i9.deontic, i9.role, i9.action]).toEqual([
      'obligation',
      'operator',
      'ratify-rule-change',
    ]);

    // #10 no-local-universal-mutation = prohibition(deployment, mutate-universal-rule, always)
    const i10 = byId.get('pi-10-no-local-universal-mutation')!;
    expect([i10.deontic, i10.role, i10.action]).toEqual([
      'prohibition',
      'deployment',
      'mutate-universal-rule',
    ]);
  });
});

describe('norm-vs-structural taxonomy', () => {
  it('the structural set tags exactly #2, #4, #6, #7', () => {
    const structuralIds = PROTECTED_STRUCTURAL_INVARIANTS.map((s) => s.id).sort();
    expect(structuralIds).toEqual([
      'pi-2-identity-attribution',
      'pi-4-routing-integrity',
      'pi-6-fail-loud',
      'pi-7-pr-for-every-artifact',
    ]);
    expect(PROTECTED_INVARIANT_TAXONOMY.structural).toEqual([2, 4, 6, 7]);
  });

  it('the taxonomy split covers all 10 invariants with no overlap', () => {
    const norm = [...PROTECTED_INVARIANT_TAXONOMY.normExpressible];
    const struct = [...PROTECTED_INVARIANT_TAXONOMY.structural];
    const all = [...norm, ...struct].sort((a, b) => a - b);
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // No invariant appears in both buckets.
    expect(norm.some((n) => struct.includes(n))).toBe(false);
  });

  it('the norm-expressible bucket {1,3,5,8,9,10} has at least one Norm each (#8 → multiple)', () => {
    const provenanceNums = new Set(
      PROTECTED_INVARIANT_NORMS.map((n) => Number(n.provenance.match(/#(\d+)$/)![1])),
    );
    for (const num of PROTECTED_INVARIANT_TAXONOMY.normExpressible) {
      expect(provenanceNums.has(num)).toBe(true);
    }
  });
});

describe('converted protected-invariant set is self-consistent', () => {
  it('contains no internal deontic conflicts', () => {
    const { conflicts } = detectNormConflicts(PROTECTED_INVARIANT_NORMS);
    expect(conflicts).toEqual([]);
  });
});
