/**
 * The 10 protected invariants, expressed in the structured-norm representation
 * (groundnuty/macf#504, DR-026 G2 — PR-1).
 *
 * Source of truth for the prose: `design/protected-invariants.md` (ratified
 * 2026-06-16). This module is the *machine-readable* projection of that set,
 * the foundation G3's SECP invariant-validator (macf#505) consumes to check a
 * proposed rule change against the constitutional core.
 *
 * --------------------------------------------------------------------------
 * NORM-vs-STRUCTURAL TAXONOMY.
 * --------------------------------------------------------------------------
 * Not every invariant is a deontic norm. Forcing a property-invariant into a
 * `(role, action, condition)` shape it doesn't fit produces a norm that lies
 * about what it constrains — and the conflict-checker would then reason over a
 * fiction. So each invariant is classified:
 *
 *   - NORM-EXPRESSIBLE  → a `Norm` (obligation/permission/prohibition bound to
 *                         a role + a positive action + a condition).
 *   - STRUCTURAL PROPERTY → a `StructuralInvariant` (a property/meta-principle
 *                           enforced by a mechanism — a hook, the
 *                           result-invariant pattern — NOT by a deontic norm).
 *
 * The split (and the #4/#7 judgement calls) is documented in
 * `design/structured-norms.md` and asserted by the tests.
 *
 *   #1  reporter-owns-closure        → NORM   obligation
 *   #2  identity ↔ attribution       → STRUCTURAL (a property of every action)
 *   #3  LGTM gate / no-self-merge     → NORM   prohibition
 *   #4  routing integrity            → STRUCTURAL (a property of comments; the
 *                                      @mention is a transport precondition,
 *                                      not a role's deontic action — science
 *                                      leaned structural; concurred)
 *   #5  auto-close discipline        → NORM   prohibition
 *   #6  fail-loud over silent-fallback → STRUCTURAL (a meta-principle over ops)
 *   #7  PR-for-every-artifact        → STRUCTURAL (no clean positive action
 *                                      token without contortion; "land via PR"
 *                                      is a property of the artifact-landing
 *                                      path, enforced by hooks/CI/review —
 *                                      science leaned structural; concurred)
 *   #8  auditor never-acts           → NORM   prohibition (×3 actions)
 *   #9  operator-as-ratifier         → NORM   obligation
 *   #10 universal rules not locally  → NORM   prohibition
 *       mutable
 */
import { NormSchema, NORM_SCHEMA_VERSION, NORM_KIND } from './norm.js';
import type { Norm } from './norm.js';
import { z } from 'zod';

/**
 * A protected invariant that is a structural PROPERTY rather than a deontic
 * norm. `statement` restates the guarantee; `whyNotANorm` records why it
 * resists the `(role, action, condition)` shape; `enforcement` names the
 * mechanism that actually guarantees it at runtime.
 */
export const StructuralInvariantSchema = z.object({
  id: z.string(),
  statement: z.string(),
  whyNotANorm: z.string(),
  enforcement: z.string(),
});
export type StructuralInvariant = z.infer<typeof StructuralInvariantSchema>;

/** Shorthand to build a validated `Norm` with the fixed envelope fields. */
function norm(spec: Omit<Norm, 'schema_version' | 'kind'>): Norm {
  return NormSchema.parse({
    ...spec,
    schema_version: NORM_SCHEMA_VERSION,
    kind: NORM_KIND,
  });
}

/**
 * The norm-expressible protected invariants. Each `provenance` points back at
 * the numbered entry in `design/protected-invariants.md`.
 */
export const PROTECTED_INVARIANT_NORMS: readonly Norm[] = [
  // #1 — the agent who opened an issue owns its closure (after the fix merges).
  norm({
    id: 'pi-1-reporter-owns-closure',
    role: 'reporter',
    deontic: 'obligation',
    action: 'close-issue',
    condition: 'after-merge',
    tier: 'universal',
    provenance: 'protected-invariants.md #1',
  }),

  // #3 — no PR merges without a non-author APPROVED review.
  norm({
    id: 'pi-3-lgtm-gate',
    role: 'implementer',
    deontic: 'prohibition',
    action: 'merge-pr',
    condition: 'without-non-author-approval',
    tier: 'universal',
    provenance: 'protected-invariants.md #3',
  }),

  // #5 — never use a GitHub auto-close keyword on a foreign-reporter issue.
  norm({
    id: 'pi-5-auto-close-discipline',
    role: 'implementer',
    deontic: 'prohibition',
    action: 'auto-close-keyword',
    condition: 'on-foreign-reporter-issue',
    tier: 'universal',
    provenance: 'protected-invariants.md #5',
  }),

  // #8 — the auditor proposes only; it can neither merge, close others' work,
  // nor implement. Modelled as three positive-action prohibitions (the
  // positive-action convention forbids a single negated "act" token).
  norm({
    id: 'pi-8-auditor-never-merge',
    role: 'auditor',
    deontic: 'prohibition',
    action: 'merge-pr',
    condition: 'always',
    tier: 'universal',
    provenance: 'protected-invariants.md #8',
  }),
  norm({
    id: 'pi-8-auditor-never-close',
    role: 'auditor',
    deontic: 'prohibition',
    action: 'close-issue',
    condition: 'always',
    tier: 'universal',
    provenance: 'protected-invariants.md #8',
  }),
  norm({
    id: 'pi-8-auditor-never-implement',
    role: 'auditor',
    deontic: 'prohibition',
    action: 'implement',
    condition: 'always',
    tier: 'universal',
    provenance: 'protected-invariants.md #8',
  }),

  // #9 — no rule change is auto-applied; the operator ratifies.
  norm({
    id: 'pi-9-operator-ratifier',
    role: 'operator',
    deontic: 'obligation',
    action: 'ratify-rule-change',
    condition: 'always',
    tier: 'universal',
    provenance: 'protected-invariants.md #9',
  }),

  // #10 — a deployment may only PR universal rules upstream; never patch them
  // locally.
  norm({
    id: 'pi-10-no-local-universal-mutation',
    role: 'deployment',
    deontic: 'prohibition',
    action: 'mutate-universal-rule',
    condition: 'always',
    tier: 'universal',
    provenance: 'protected-invariants.md #10',
  }),
];

/**
 * The structural-property protected invariants. These are guarantees the
 * conflict-checker does NOT reason over — they are enforced by mechanisms, not
 * by deontic logic. Tagged here so the full set of 10 is accounted for and G3
 * knows to route them to the structural-enforcement check, not the norm
 * conflict-check.
 */
export const PROTECTED_STRUCTURAL_INVARIANTS: readonly StructuralInvariant[] = [
  {
    id: 'pi-2-identity-attribution',
    statement:
      'Every agent action is attributed to that agent’s distinct external identity (its bot App), never silently to the operator or another agent.',
    whyNotANorm:
      'A cross-cutting PROPERTY of every action, not a single role’s deontic act on a (role, action, condition) key. There is no one "attribute" action to obligate/prohibit; the guarantee holds over all actions at once.',
    enforcement:
      'check-gh-token.sh (PreToolUse, ghs_ prefix) + check-gh-attribution.sh (PostToolUse result-invariant, macf#489/#491). silent-fallback Instances 1, 12.',
  },
  {
    id: 'pi-4-routing-integrity',
    statement:
      'A cross-agent comment must carry a routing-active @mention to reach its recipient; describing-context mentions must not false-route.',
    whyNotANorm:
      'A property of the message-transport surface (a comment’s @mention is a delivery precondition), not a deontic action a role does. Modelling it as obligation(agent, mention, …) would contort a transport invariant into a role-action norm; science leaned structural and we concur.',
    enforcement:
      'check-mention-routing.sh Check A (must-have-mention) + Check B (must-not-leak describing-context). mention-routing-hygiene; macf#244/#272.',
  },
  {
    id: 'pi-6-fail-loud',
    statement:
      'Operations that can silently fall back to a wrong identity/scope/target must assert a result-invariant, not merely an exit code.',
    whyNotANorm:
      'A meta-principle about HOW operations are written (assert the result, not just the exit code), spanning many actions — not a single (role, action, condition) deontic statement.',
    enforcement:
      'The result-invariant pattern (e.g. check-gh-attribution.sh checks who actually authored the resource). silent-fallback-hazards.',
  },
  {
    id: 'pi-7-pr-for-every-artifact',
    statement:
      'Persistent artifacts land via PR (review + CI + audit + rollback checkpoint); only narrow operator-terminal recoveries excepted.',
    whyNotANorm:
      'No clean positive ACTION token captures "land via PR" without contortion — it is a property of the artifact-landing PATH (PR + review + CI), enforced by hooks/CI/review discipline, with an operator-terminal exception that a flat deontic norm cannot express. science leaned structural and we concur.',
    enforcement:
      'pr-discipline rules + the LGTM-gate hook (check-lgtm-gate.sh, macf#270) + CI required checks. pr-discipline; protected-invariants.md #7.',
  },
];

/**
 * Short machine-readable taxonomy note: which of the 10 invariants became a
 * norm vs a structural property. Mirrors `design/structured-norms.md`.
 */
export const PROTECTED_INVARIANT_TAXONOMY = {
  normExpressible: [1, 3, 5, 8, 9, 10],
  structural: [2, 4, 6, 7],
} as const;
