/**
 * Versioned reflection-record schema (groundnuty/macf#500, DR-026 F2).
 *
 * A "reflection" is a single JSON object an agent emits at compaction time:
 * the `harvest-reflection.sh` PreCompact hook (Deliverable 2) reads a *staged*
 * reflection the agent maintains incrementally in
 * `.claude/.macf/reflections/pending.json` (see `reflection-staging.md`), wraps
 * it in this schema envelope, and appends it as one line to a local JSONL
 * ledger. F4's Monitor imports this schema to read the ledger back.
 *
 * Forward-compat is carried by two envelope fields:
 *   - `schema_version` ("1.0") — F4's reader can branch on the version when the
 *     shape evolves.
 *   - `kind` ("macf.reflection") — a stable type-tag so a multi-kind ledger (or
 *     a shared bus) can discriminate reflection records from other record types.
 *
 * Defaults make a *mechanical-only* record valid: every array defaults to `[]`
 * and `synthesis` to `""`. The hook ALWAYS emits a record at PreCompact (even
 * with no staged content) so the Monitor sees that a compaction happened.
 *
 * The optional `key` fields on `observed_patterns` / `rule_evolution_signals`
 * are reserved for deterministic cross-agent dedup later (G1's membrane) —
 * additive and unused now.
 */
import { z } from 'zod';

/** Current reflection schema version. Bump on a breaking shape change. */
export const REFLECTION_SCHEMA_VERSION = '1.0' as const;

/** Stable type-tag distinguishing reflection records on a multi-kind ledger. */
export const REFLECTION_KIND = 'macf.reflection' as const;

/**
 * A pattern the agent observed during the session — a recurring behaviour,
 * coordination dynamic, or workflow shape worth surfacing. `tier_hint` is the
 * agent's loose guess at where this belongs (e.g. a rule tier / promotion
 * path); kept as a free-form string so the schema doesn't pin a taxonomy the
 * governance layer hasn't frozen yet. `key` (optional) is the future
 * cross-agent dedup handle — additive, unused now.
 */
export const ObservedPatternSchema = z.object({
  pattern: z.string(),
  evidence: z.string(),
  tier_hint: z.string(),
  key: z.string().optional(),
});
export type ObservedPattern = z.infer<typeof ObservedPatternSchema>;

/**
 * A canonical-rule breach the agent committed or witnessed. `rule` names the
 * rule, `what` describes the breach, `ref` points at the supporting evidence
 * (an issue/PR/commit ref, a file:line, a rule-doc anchor).
 */
export const ReflectionBreachSchema = z.object({
  rule: z.string(),
  what: z.string(),
  ref: z.string(),
});
export type ReflectionBreach = z.infer<typeof ReflectionBreachSchema>;

/**
 * A signal that a coordination rule should evolve — a proposal the governance
 * layer (DR-026 auditor) can later weigh. `proposed_tier` is the tier the agent
 * suggests the signal be promoted into (free-form for the same reason as
 * `tier_hint` above). `key` (optional) is the future cross-agent dedup handle.
 */
export const RuleEvolutionSignalSchema = z.object({
  signal: z.string(),
  proposed_tier: z.string(),
  rationale: z.string(),
  key: z.string().optional(),
});
export type RuleEvolutionSignal = z.infer<typeof RuleEvolutionSignalSchema>;

/** The agent's identity at emission time. */
export const ReflectionAgentSchema = z.object({
  name: z.string(),
  role: z.string(),
  login: z.string(),
});
export type ReflectionAgent = z.infer<typeof ReflectionAgentSchema>;

/**
 * The full reflection record — one JSON object per JSONL line.
 *
 * `compaction_type` mirrors the PreCompact payload's `trigger` field
 * ("auto" | "manual"); `null` when the hook couldn't read it. `trigger` is the
 * fixed literal `"pre-compact"` recording WHICH hook produced the record (room
 * for future non-compaction reflection emitters).
 */
export const ReflectionRecordSchema = z.object({
  schema_version: z.literal(REFLECTION_SCHEMA_VERSION),
  kind: z.literal(REFLECTION_KIND),
  agent: ReflectionAgentSchema,
  project: z.string(),
  session_id: z.string(),
  // ISO8601 UTC, e.g. 2026-06-16T04:40:39Z.
  timestamp: z.string(),
  trigger: z.literal('pre-compact'),
  compaction_type: z.enum(['auto', 'manual']).nullable(),
  // Arrays default [] and synthesis defaults "" → a mechanical-only record
  // (no staged content) is valid. `.default()` keeps the field optional on the
  // wire while inferring a non-optional type for consumers.
  observed_patterns: z.array(ObservedPatternSchema).default([]),
  breaches: z.array(ReflectionBreachSchema).default([]),
  rule_evolution_signals: z.array(RuleEvolutionSignalSchema).default([]),
  unresolved: z.array(z.string()).default([]),
  synthesis: z.string().default(''),
});
export type ReflectionRecord = z.infer<typeof ReflectionRecordSchema>;

/**
 * The staged-reflection shape the agent maintains in
 * `.claude/.macf/reflections/pending.json` (see `reflection-staging.md`). Only
 * the protocol-signal fields live here — the envelope (`schema_version`,
 * `kind`, `agent`, `project`, `session_id`, `timestamp`, `trigger`,
 * `compaction_type`) is added by the hook at harvest time. Every field is
 * optional/defaulted so an empty `{}` stage is valid (and is what the hook
 * writes back to clear the stage).
 */
export const ReflectionStageSchema = z.object({
  observed_patterns: z.array(ObservedPatternSchema).default([]),
  breaches: z.array(ReflectionBreachSchema).default([]),
  rule_evolution_signals: z.array(RuleEvolutionSignalSchema).default([]),
  unresolved: z.array(z.string()).default([]),
  synthesis: z.string().default(''),
});
export type ReflectionStage = z.infer<typeof ReflectionStageSchema>;
