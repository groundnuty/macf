/**
 * Versioned structured-norm (Moise-style) representation + deontic
 * conflict-checker (groundnuty/macf#504, DR-026 G2 — PR-1).
 *
 * This module gives the coordination protocol a *machine-checkable* form for
 * its norms. A "norm" is a deontic statement — an obligation, permission, or
 * prohibition — bound to a `(role, action, condition)` triple. G3's SECP
 * invariant-validator (macf#505) consumes this representation to mechanically
 * check that a proposed rule change never contradicts a protected invariant.
 *
 * --------------------------------------------------------------------------
 * G2 MODELS, IT DOES NOT ENFORCE.
 * --------------------------------------------------------------------------
 * This is a *data model* only. The runtime governor is the existing set of
 * `check-*.sh` PreToolUse/PostToolUse hooks plus the DR-026 auditor — they
 * are what actually block/warn at tool-call time. `SceneSchema` below models
 * the issue-lifecycle scene as data (states + transitions); it carries NO
 * enforcement code. Nothing here runs at coordination time.
 *
 * --------------------------------------------------------------------------
 * CONTROLLED VOCABULARIES — the load-bearing guardrail.
 * --------------------------------------------------------------------------
 * The conflict-checker matches norms on three keys: `role`, `action`,
 * `condition`. If two genuinely-conflicting norms are spelled differently
 * (`after_merge` vs `after-merge`), a naive checker silently fails to match
 * them — producing FALSE CONFIDENCE, which is worse than no checker at all.
 *
 * To close that silent-miss, every match-key is a CLOSED Zod enum over a
 * canonical token set, and `normalizeToken` is applied to inputs first
 * (lowercase, collapse runs of `_`/whitespace/`-` to a single `-`). An
 * unknown token after normalization is REJECTED by the schema, forcing a
 * deliberate vocabulary extension rather than an accidental synonym.
 *
 * --------------------------------------------------------------------------
 * POSITIVE-ACTION CONVENTION.
 * --------------------------------------------------------------------------
 * The `Action` enum carries ONLY positive actions (`self-merge`,
 * `close-issue`, …) — NEVER negated forms (`not-self-merge`). Negation lives
 * exclusively in the `deontic` field. This is deliberate: if negated actions
 * were allowed, a `prohibition(merge-pr)` could be silently dodged by
 * re-expressing it as `obligation(not-merge-pr)` — the same constraint under
 * a key the conflict-checker would never group together. Keeping actions
 * positive means a clash on a constraint is always visible on one shared key.
 *
 * --------------------------------------------------------------------------
 * DEONTIC-CONFLICT MATRIX (within one (role, action, condition) group).
 * --------------------------------------------------------------------------
 *   obligation  ∧ prohibition  → CONFLICT  ("must" vs "must not")
 *   permission  ∧ prohibition  → CONFLICT  ("may"  vs "must not")
 *   obligation  ∧ permission   → consistent (obligation ⊨ permission)
 * Same deontic on the same key is not a logical conflict; duplicate
 * obligations get a NON-BLOCKING warning (likely a redundant rule).
 *
 * v1 SCOPE: matching is exact-token on the canonical triple. Condition
 * subsumption (one condition implies another), temporal/deadline logic, and
 * role-hierarchy inheritance are DEFERRED to the G3 increment (macf#505).
 */
import { z } from 'zod';

/** Current norm schema version. Bump on a breaking shape change. */
export const NORM_SCHEMA_VERSION = '1.0' as const;

/** Stable type-tag distinguishing norm records on a multi-kind ledger. */
export const NORM_KIND = 'macf.norm' as const;

/**
 * Canonicalize a vocabulary token: lowercase, then collapse any run of
 * underscores / whitespace / hyphens into a single hyphen, and trim leading
 * and trailing hyphens. This is what makes `after_merge`, `after merge`,
 * `After-Merge`, and `after--merge` all map to the ONE canonical token
 * `after-merge`. Applied to every match-key before enum validation so the
 * enum only ever sees canonical forms.
 */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A Zod preprocessor that normalizes the input token before the wrapped enum
 * validates it. Non-string inputs pass through untouched so the enum produces
 * its normal type error.
 */
const canonical = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' ? normalizeToken(v) : v), schema);

/**
 * Canonical ROLE vocabulary — the coordination actors a norm can bind to.
 * Closed set: an unknown role is rejected (extend deliberately).
 */
export const ROLE_TOKENS = [
  'reporter',
  'implementer',
  'reviewer',
  'auditor',
  'operator',
  'deployment',
  'agent',
] as const;
export const RoleSchema = canonical(z.enum(ROLE_TOKENS));
export type Role = (typeof ROLE_TOKENS)[number];

/**
 * Canonical ACTION vocabulary — POSITIVE actions only (see file header). Each
 * is a thing an actor *does*; prohibition/obligation/permission is expressed
 * via `deontic`, never by negating the action name.
 */
export const ACTION_TOKENS = [
  'close-issue',
  'merge-pr',
  'self-merge',
  'auto-close-keyword',
  'implement',
  'mutate-universal-rule',
  'ratify-rule-change',
] as const;
export const ActionSchema = canonical(z.enum(ACTION_TOKENS));
export type Action = (typeof ACTION_TOKENS)[number];

/**
 * Canonical CONDITION vocabulary — the circumstance under which the norm
 * applies. `always` is the unconditioned default. Conditions are exact-match
 * keys in v1 (no subsumption — deferred to G3).
 */
export const CONDITION_TOKENS = [
  'always',
  'after-merge',
  'without-non-author-approval',
  'on-foreign-reporter-issue',
] as const;
export const ConditionSchema = canonical(z.enum(CONDITION_TOKENS));
export type Condition = (typeof CONDITION_TOKENS)[number];

/** The three deontic modalities. */
export const DeonticSchema = z.enum(['obligation', 'permission', 'prohibition']);
export type Deontic = z.infer<typeof DeonticSchema>;

/** Which tier a norm belongs to (constitutional vs deployment-local). */
export const NormTierSchema = z.enum(['universal', 'project']);
export type NormTier = z.infer<typeof NormTierSchema>;

/**
 * A single structured norm.
 *
 * `role` / `action` / `condition` are the three CANONICAL match-keys the
 * conflict-checker groups on. `deontic` is the modality. `deadline` and
 * `sanction` are optional descriptive fields (not used by the v1 checker —
 * room for G3's temporal logic). `tier` + `provenance` record where the norm
 * came from (the source rule / invariant), so a flagged conflict is traceable
 * back to a human-readable rule.
 */
export const NormSchema = z.object({
  id: z.string(),
  schema_version: z.literal(NORM_SCHEMA_VERSION),
  kind: z.literal(NORM_KIND),
  role: RoleSchema,
  deontic: DeonticSchema,
  action: ActionSchema,
  condition: ConditionSchema,
  deadline: z.string().optional(),
  sanction: z.string().optional(),
  tier: NormTierSchema,
  provenance: z.string(),
});
export type Norm = z.infer<typeof NormSchema>;

/**
 * A transition in the issue-lifecycle scene. `from`/`to` are state names;
 * `roleGate` (optional) names the role permitted to drive the transition;
 * `normRef` (optional) points at a `Norm.id` that governs it. Data-model
 * only — no transition is *executed* anywhere; the runtime governor is the
 * hooks + auditor.
 */
export const TransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  roleGate: z.string().optional(),
  normRef: z.string().optional(),
});
export type Transition = z.infer<typeof TransitionSchema>;

/**
 * The issue-lifecycle scene: the set of states an issue moves through and the
 * legal transitions between them, mirroring `coordination.md` §Issue
 * Lifecycle + the agent-identity label table (open → in-progress → in-review
 * → closed, with a blocked side-state). DATA ONLY — see file header.
 */
export const SceneSchema = z.object({
  id: z.string(),
  schema_version: z.literal(NORM_SCHEMA_VERSION),
  kind: z.literal('macf.scene'),
  states: z.array(z.string()),
  transitions: z.array(TransitionSchema),
});
export type Scene = z.infer<typeof SceneSchema>;

/** The kind of deontic clash the checker found. */
export const ConflictTypeSchema = z.enum([
  'obligation-vs-prohibition',
  'permission-vs-prohibition',
]);
export type ConflictType = z.infer<typeof ConflictTypeSchema>;

/** A detected conflict: the two clashing norms + the clash type. */
export interface NormConflict {
  readonly a: Norm;
  readonly b: Norm;
  readonly type: ConflictType;
}

/** A non-blocking advisory: same-key duplicate obligations (redundant rule). */
export interface NormWarning {
  readonly a: Norm;
  readonly b: Norm;
  readonly kind: 'duplicate-obligation';
}

/** The result of a conflict-check pass. */
export interface ConflictCheckResult {
  readonly conflicts: readonly NormConflict[];
  readonly warnings: readonly NormWarning[];
}

/** The canonical group key for a norm: its (role, action, condition) triple. */
function groupKey(n: Norm): string {
  // Values are already canonical (validated by the enums), so JSON-joining is
  // a stable, collision-free key for grouping.
  return JSON.stringify([n.role, n.action, n.condition]);
}

/**
 * Is this an actual deontic conflict per the matrix? Returns the conflict
 * type, or `null` if the pair is consistent.
 *
 *   obligation ∧ prohibition → conflict
 *   permission ∧ prohibition → conflict
 *   obligation ∧ permission  → consistent (obligation entails permission)
 *   same modality            → consistent (handled as a warning elsewhere)
 */
function clashType(d1: Deontic, d2: Deontic): ConflictType | null {
  const pair = new Set([d1, d2]);
  if (pair.has('prohibition') && pair.has('obligation')) return 'obligation-vs-prohibition';
  if (pair.has('prohibition') && pair.has('permission')) return 'permission-vs-prohibition';
  return null;
}

/**
 * Detect deontic conflicts among a set of norms.
 *
 * Groups norms by their already-canonical `(role, action, condition)` triple,
 * then within each group compares every pair:
 *   - opposite-modality clashes (obligation/prohibition, permission/prohibition)
 *     are returned as CONFLICTS;
 *   - duplicate obligations on the same key are returned as non-blocking
 *     WARNINGS (a likely-redundant rule, not a contradiction).
 *
 * Because the keys are canonical (the schema normalized them), two norms that
 * conflict but were spelled differently on input (`after_merge` vs
 * `after-merge`) land in the SAME group and are correctly flagged — that is
 * the whole point of the controlled vocabulary.
 *
 * v1 is exact-token grouping only. Condition subsumption, temporal/deadline
 * reasoning, and role-hierarchy inheritance are DEFERRED to G3 (macf#505).
 */
export function detectNormConflicts(norms: readonly Norm[]): ConflictCheckResult {
  const groups = new Map<string, Norm[]>();
  for (const n of norms) {
    const key = groupKey(n);
    const bucket = groups.get(key);
    if (bucket) bucket.push(n);
    else groups.set(key, [n]);
  }

  const conflicts: NormConflict[] = [];
  const warnings: NormWarning[] = [];

  for (const bucket of groups.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const type = clashType(a.deontic, b.deontic);
        if (type) {
          conflicts.push({ a, b, type });
        } else if (a.deontic === 'obligation' && b.deontic === 'obligation') {
          warnings.push({ a, b, kind: 'duplicate-obligation' });
        }
      }
    }
  }

  return { conflicts, warnings };
}
