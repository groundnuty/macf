/**
 * Tests for the versioned reflection-record schema (groundnuty/macf#500,
 * DR-026 F2). The `harvest-reflection.sh` PreCompact hook emits records that
 * MUST validate against `ReflectionRecordSchema`; F4's Monitor reads the
 * ledger back through the same schema. See `src/reflection.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  ReflectionRecordSchema,
  ReflectionStageSchema,
  REFLECTION_SCHEMA_VERSION,
  REFLECTION_KIND,
} from '../src/reflection.js';

/** A full envelope with every protocol-signal field populated. */
const FULL_RECORD = {
  schema_version: '1.0',
  kind: 'macf.reflection',
  agent: { name: 'macf-code-agent', role: 'implementer', login: 'macf-code-agent[bot]' },
  project: 'macf',
  session_id: 'sess-abc',
  timestamp: '2026-06-16T04:40:39Z',
  trigger: 'pre-compact',
  compaction_type: 'manual',
  observed_patterns: [
    { pattern: 'p1', evidence: 'e1', tier_hint: 'tier-1', key: 'k1' },
    { pattern: 'p2', evidence: 'e2', tier_hint: 'tier-2' }, // key omitted (optional)
  ],
  breaches: [{ rule: 'r1', what: 'w1', ref: '#500' }],
  rule_evolution_signals: [
    { signal: 's1', proposed_tier: 't2', rationale: 'because', key: 'k2' },
  ],
  unresolved: ['u1', 'u2'],
  synthesis: 'a paragraph of synthesis',
};

/** The minimal mechanical-only envelope the hook emits with an empty stage. */
const MECHANICAL_RECORD = {
  schema_version: '1.0',
  kind: 'macf.reflection',
  agent: { name: '', role: '', login: '' },
  project: '',
  session_id: 'sess-xyz',
  timestamp: '2026-06-16T04:41:00Z',
  trigger: 'pre-compact',
  compaction_type: null,
  observed_patterns: [],
  breaches: [],
  rule_evolution_signals: [],
  unresolved: [],
  synthesis: '',
};

describe('reflection schema constants', () => {
  it('exports the current version + kind tag', () => {
    expect(REFLECTION_SCHEMA_VERSION).toBe('1.0');
    expect(REFLECTION_KIND).toBe('macf.reflection');
  });
});

describe('ReflectionRecordSchema (valid samples)', () => {
  it('accepts a full record with every field populated', () => {
    const r = ReflectionRecordSchema.parse(FULL_RECORD);
    expect(r.schema_version).toBe('1.0');
    expect(r.kind).toBe('macf.reflection');
    expect(r.agent.login).toBe('macf-code-agent[bot]');
    expect(r.compaction_type).toBe('manual');
    expect(r.observed_patterns).toHaveLength(2);
    // Optional `key` present on the first pattern, absent on the second.
    expect(r.observed_patterns[0]!.key).toBe('k1');
    expect(r.observed_patterns[1]!.key).toBeUndefined();
    expect(r.rule_evolution_signals[0]!.key).toBe('k2');
  });

  it('accepts a mechanical-only record (empty arrays, null compaction_type)', () => {
    const r = ReflectionRecordSchema.parse(MECHANICAL_RECORD);
    expect(r.observed_patterns).toEqual([]);
    expect(r.breaches).toEqual([]);
    expect(r.rule_evolution_signals).toEqual([]);
    expect(r.unresolved).toEqual([]);
    expect(r.synthesis).toBe('');
    expect(r.compaction_type).toBeNull();
  });

  it('accepts compaction_type "auto"', () => {
    const r = ReflectionRecordSchema.parse({ ...MECHANICAL_RECORD, compaction_type: 'auto' });
    expect(r.compaction_type).toBe('auto');
  });

  it('defaults the arrays + synthesis when absent (forward-compat for the reader)', () => {
    // A producer that omits the optional arrays entirely still validates.
    const { observed_patterns, breaches, rule_evolution_signals, unresolved, synthesis, ...rest } =
      MECHANICAL_RECORD;
    void observed_patterns; void breaches; void rule_evolution_signals; void unresolved; void synthesis;
    const r = ReflectionRecordSchema.parse(rest);
    expect(r.observed_patterns).toEqual([]);
    expect(r.synthesis).toBe('');
  });
});

describe('ReflectionRecordSchema (invalid samples)', () => {
  it('rejects a wrong schema_version literal', () => {
    expect(() => ReflectionRecordSchema.parse({ ...MECHANICAL_RECORD, schema_version: '2.0' })).toThrow();
  });

  it('rejects a wrong kind tag', () => {
    expect(() => ReflectionRecordSchema.parse({ ...MECHANICAL_RECORD, kind: 'macf.other' })).toThrow();
  });

  it('rejects a non-pre-compact trigger', () => {
    expect(() => ReflectionRecordSchema.parse({ ...MECHANICAL_RECORD, trigger: 'session-end' })).toThrow();
  });

  it('rejects an unknown compaction_type enum value', () => {
    expect(() => ReflectionRecordSchema.parse({ ...MECHANICAL_RECORD, compaction_type: 'forced' })).toThrow();
  });

  it('rejects a missing agent block', () => {
    const { agent, ...rest } = MECHANICAL_RECORD;
    void agent;
    expect(() => ReflectionRecordSchema.parse(rest)).toThrow();
  });

  it('rejects an observed_pattern missing a required field', () => {
    expect(() =>
      ReflectionRecordSchema.parse({
        ...MECHANICAL_RECORD,
        observed_patterns: [{ pattern: 'p', evidence: 'e' }], // tier_hint missing
      }),
    ).toThrow();
  });
});

describe('ReflectionStageSchema (the pending.json shape)', () => {
  it('accepts an empty stage (the cleared state)', () => {
    const s = ReflectionStageSchema.parse({});
    expect(s.observed_patterns).toEqual([]);
    expect(s.synthesis).toBe('');
  });

  it('accepts a partial stage and defaults the rest', () => {
    const s = ReflectionStageSchema.parse({ synthesis: 'wip', unresolved: ['x'] });
    expect(s.synthesis).toBe('wip');
    expect(s.unresolved).toEqual(['x']);
    expect(s.breaches).toEqual([]);
  });
});
