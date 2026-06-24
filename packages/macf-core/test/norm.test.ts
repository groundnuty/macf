/**
 * Tests for the structured-norm representation + deontic conflict-checker
 * (groundnuty/macf#504, DR-026 G2 — PR-1). See `src/norm.ts`.
 *
 * The load-bearing case is the synonym-spelled-differently conflict: it proves
 * the controlled vocabulary + normalizer closes the silent-miss (two genuinely
 * conflicting norms spelled `after_merge` vs `after-merge` MUST still be
 * flagged). Without it the checker would give false confidence.
 */
import { describe, it, expect } from 'vitest';
import {
  NormSchema,
  SceneSchema,
  normalizeToken,
  detectNormConflicts,
  NORM_SCHEMA_VERSION,
  NORM_KIND,
} from '../src/norm.js';
import type { Norm } from '../src/norm.js';

/** Build a valid norm from the variable parts; envelope fields are fixed. */
function mkNorm(over: Partial<Norm> & Pick<Norm, 'id'>): Norm {
  return NormSchema.parse({
    schema_version: NORM_SCHEMA_VERSION,
    kind: NORM_KIND,
    role: 'implementer',
    deontic: 'prohibition',
    action: 'merge-pr',
    condition: 'always',
    tier: 'universal',
    provenance: 'test',
    ...over,
  });
}

describe('norm schema constants', () => {
  it('exports the current version + kind tag', () => {
    expect(NORM_SCHEMA_VERSION).toBe('1.0');
    expect(NORM_KIND).toBe('macf.norm');
  });
});

describe('normalizeToken', () => {
  it('maps underscore/space/case variants to one canonical hyphenated token', () => {
    expect(normalizeToken('after_merge')).toBe('after-merge');
    expect(normalizeToken('after merge')).toBe('after-merge');
    expect(normalizeToken('After-Merge')).toBe('after-merge');
    expect(normalizeToken('after--merge')).toBe('after-merge');
    expect(normalizeToken('  after  merge  ')).toBe('after-merge');
  });

  it('trims leading/trailing separators', () => {
    expect(normalizeToken('_close_issue_')).toBe('close-issue');
    expect(normalizeToken('-merge-pr-')).toBe('merge-pr');
  });

  it('is idempotent on an already-canonical token', () => {
    expect(normalizeToken('without-non-author-approval')).toBe('without-non-author-approval');
  });
});

describe('NormSchema (valid)', () => {
  it('accepts a canonical norm', () => {
    const n = mkNorm({ id: 'n1' });
    expect(n.role).toBe('implementer');
    expect(n.action).toBe('merge-pr');
    expect(n.condition).toBe('always');
  });

  it('normalizes synonym-spelled match-keys to canonical tokens on parse', () => {
    const n = NormSchema.parse({
      id: 'n-syn',
      schema_version: NORM_SCHEMA_VERSION,
      kind: NORM_KIND,
      role: 'Implementer',
      deontic: 'obligation',
      action: 'close_issue', // underscore synonym
      condition: 'after_merge', // underscore synonym
      tier: 'project',
      provenance: 'test',
    });
    expect(n.role).toBe('implementer');
    expect(n.action).toBe('close-issue');
    expect(n.condition).toBe('after-merge');
  });

  it('carries optional deadline + sanction', () => {
    const n = mkNorm({ id: 'n2', deadline: '24h', sanction: 'revert' });
    expect(n.deadline).toBe('24h');
    expect(n.sanction).toBe('revert');
  });
});

describe('NormSchema (invalid)', () => {
  it('rejects an unknown role token (forces deliberate vocab extension)', () => {
    expect(() => mkNorm({ id: 'bad', role: 'janitor' as never })).toThrow();
  });

  it('rejects an unknown action token even after normalization', () => {
    expect(() => mkNorm({ id: 'bad', action: 'rage-quit' as never })).toThrow();
  });

  it('rejects a negated/inverted action (positive-action convention)', () => {
    // "not-merge-pr" is not in the positive-action vocabulary → rejected.
    expect(() => mkNorm({ id: 'bad', action: 'not-merge-pr' as never })).toThrow();
  });

  it('rejects an unknown condition token', () => {
    expect(() => mkNorm({ id: 'bad', condition: 'on-a-tuesday' as never })).toThrow();
  });

  it('rejects an unknown deontic modality', () => {
    expect(() => mkNorm({ id: 'bad', deontic: 'recommendation' as never })).toThrow();
  });

  it('rejects a wrong schema_version / kind literal', () => {
    expect(() =>
      NormSchema.parse({ ...mkNorm({ id: 'x' }), schema_version: '2.0' }),
    ).toThrow();
    expect(() => NormSchema.parse({ ...mkNorm({ id: 'x' }), kind: 'macf.other' })).toThrow();
  });
});

describe('SceneSchema', () => {
  it('accepts the issue-lifecycle scene (data-model only, no enforcement)', () => {
    const scene = SceneSchema.parse({
      id: 'issue-lifecycle',
      schema_version: NORM_SCHEMA_VERSION,
      kind: 'macf.scene',
      states: ['open', 'in-progress', 'in-review', 'closed', 'blocked'],
      transitions: [
        { from: 'open', to: 'in-progress', roleGate: 'implementer' },
        { from: 'in-progress', to: 'in-review', roleGate: 'implementer' },
        { from: 'in-review', to: 'closed', roleGate: 'reporter', normRef: 'pi-1-reporter-owns-closure' },
        { from: 'in-progress', to: 'blocked' },
      ],
    });
    expect(scene.states).toContain('in-review');
    expect(scene.transitions).toHaveLength(4);
    expect(scene.transitions[2]!.normRef).toBe('pi-1-reporter-owns-closure');
  });
});

describe('detectNormConflicts', () => {
  it('flags obligation ∧ prohibition on a matching key', () => {
    const a = mkNorm({ id: 'a', deontic: 'obligation' });
    const b = mkNorm({ id: 'b', deontic: 'prohibition' });
    const { conflicts } = detectNormConflicts([a, b]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.type).toBe('obligation-vs-prohibition');
  });

  it('flags permission ∧ prohibition on a matching key', () => {
    const a = mkNorm({ id: 'a', deontic: 'permission' });
    const b = mkNorm({ id: 'b', deontic: 'prohibition' });
    const { conflicts } = detectNormConflicts([a, b]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.type).toBe('permission-vs-prohibition');
  });

  it('flags a conflict even when the condition was spelled differently (the silent-miss closer)', () => {
    // Same logical key, two spellings — the normalizer collapses them so the
    // checker still groups + flags them. THIS is the guardrail the controlled
    // vocabulary exists for.
    const obl = NormSchema.parse({
      id: 'spell-a',
      schema_version: NORM_SCHEMA_VERSION,
      kind: NORM_KIND,
      role: 'reporter',
      deontic: 'obligation',
      action: 'close_issue',
      condition: 'after_merge', // underscore
      tier: 'universal',
      provenance: 'test',
    });
    const pro = NormSchema.parse({
      id: 'spell-b',
      schema_version: NORM_SCHEMA_VERSION,
      kind: NORM_KIND,
      role: 'reporter',
      deontic: 'prohibition',
      action: 'close-issue',
      condition: 'after-merge', // hyphen — same canonical token
      tier: 'universal',
      provenance: 'test',
    });
    const { conflicts } = detectNormConflicts([obl, pro]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.type).toBe('obligation-vs-prohibition');
  });

  it('does NOT flag obligation ∧ permission (obligation entails permission)', () => {
    const a = mkNorm({ id: 'a', deontic: 'obligation' });
    const b = mkNorm({ id: 'b', deontic: 'permission' });
    const { conflicts, warnings } = detectNormConflicts([a, b]);
    expect(conflicts).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('does NOT flag norms on different keys', () => {
    const a = mkNorm({ id: 'a', deontic: 'obligation', action: 'merge-pr' });
    const b = mkNorm({ id: 'b', deontic: 'prohibition', action: 'close-issue' });
    const { conflicts } = detectNormConflicts([a, b]);
    expect(conflicts).toHaveLength(0);
  });

  it('does NOT flag a prohibition that differs only by role (no role hierarchy in v1)', () => {
    const a = mkNorm({ id: 'a', deontic: 'obligation', role: 'reporter' });
    const b = mkNorm({ id: 'b', deontic: 'prohibition', role: 'implementer' });
    const { conflicts } = detectNormConflicts([a, b]);
    expect(conflicts).toHaveLength(0);
  });

  it('emits a non-blocking warning for duplicate same-key obligations', () => {
    const a = mkNorm({ id: 'a', deontic: 'obligation' });
    const b = mkNorm({ id: 'b', deontic: 'obligation' });
    const { conflicts, warnings } = detectNormConflicts([a, b]);
    expect(conflicts).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('duplicate-obligation');
  });

  it('returns empty results for an empty / single-norm set', () => {
    expect(detectNormConflicts([])).toEqual({ conflicts: [], warnings: [] });
    expect(detectNormConflicts([mkNorm({ id: 'solo' })])).toEqual({
      conflicts: [],
      warnings: [],
    });
  });
});
