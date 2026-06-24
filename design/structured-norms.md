# Structured norms (the Moise representation) — DR-026 G2

**Status:** Built 2026-06-24 (macf#504, DR-026 G2 — PR-1).
**Authority:** DR-026 §4 (the auditor — self-evolving coordination governance).
**Code:** `packages/macf-core/src/norm.ts`,
`packages/macf-core/src/protected-invariant-norms.ts`.

This is the **versioned, machine-checkable representation** of the
coordination protocol's norms, plus a deterministic **deontic conflict-checker**
over them. It is the foundation the G3 SECP invariant-validator (macf#505) will
consume to mechanically check that a proposed rule change never contradicts a
protected invariant.

> **G2 MODELS, IT DOES NOT ENFORCE.** Everything here is a *data model* + a
> *pure checker function*. The runtime governor stays exactly what it is today:
> the `check-*.sh` PreToolUse/PostToolUse hooks plus the DR-026 auditor. No code
> in this module runs at coordination time, gates a tool call, or blocks an
> action. The `Scene` model (below) is data only — no transition is ever
> *executed*.

---

## 1. The representation

A **norm** is a deontic statement — an obligation, permission, or prohibition —
bound to a `(role, action, condition)` triple. The Moise organisational model
inspires the shape: norms attach a deontic modality to a role's behaviour
within a scene.

`NormSchema` (Zod) fields:

| field            | type                                              | meaning |
|------------------|---------------------------------------------------|---------|
| `id`             | string                                            | stable handle |
| `schema_version` | literal `'1.0'`                                   | forward-compat |
| `kind`           | literal `'macf.norm'`                             | type-tag on a multi-kind ledger |
| `role`           | `Role` enum                                       | the actor the norm binds to (match-key) |
| `deontic`        | `obligation` \| `permission` \| `prohibition`     | the modality |
| `action`         | `Action` enum (positive only)                     | what the actor does (match-key) |
| `condition`      | `Condition` enum                                  | the circumstance (match-key) |
| `deadline?`      | string                                            | descriptive; unused by the v1 checker |
| `sanction?`      | string                                            | descriptive; unused by the v1 checker |
| `tier`           | `universal` \| `project`                          | constitutional vs deployment-local |
| `provenance`     | string                                            | the source rule/invariant (e.g. `protected-invariants.md #1`) |

A **scene** (`SceneSchema`) models the issue-lifecycle as data: a set of
`states` (`open` / `in-progress` / `in-review` / `closed` / `blocked`, mirroring
`coordination.md` §Issue Lifecycle + the agent-identity label table) and a list
of `transitions` (`{ from, to, roleGate?, normRef? }`). `normRef` can point at a
`Norm.id` that governs a transition. This is purely descriptive — no enforcement.

---

## 2. Controlled vocabularies + the normalizer (the load-bearing guardrail)

The conflict-checker matches norms on `(role, action, condition)`. If two
**genuinely conflicting** norms are spelled differently — `after_merge` vs
`after-merge` — a naive checker silently fails to group them and reports "no
conflict." That is **false confidence**, strictly worse than having no checker:
an operator trusts a green result that is wrong.

Two mechanisms close the silent-miss:

1. **`normalizeToken(s)`** — lowercases, collapses any run of
   `_` / whitespace / `-` into a single `-`, and trims leading/trailing `-`. So
   `after_merge`, `after merge`, `After-Merge`, and `after--merge` all become the
   one canonical token `after-merge`. It is applied (via a Zod preprocessor) to
   every match-key **before** enum validation.

2. **Closed Zod enums** for `Role`, `Action`, `Condition`. After
   normalization, an **unknown** token is **rejected** by the schema. This forces
   a deliberate vocabulary extension (add the token to the enum, with review)
   rather than letting an accidental synonym slip through as a new, never-matched
   key.

Together: two conflicting norms cannot hide behind different spellings, and a
typo'd condition cannot silently introduce an un-checkable key.

---

## 3. The positive-action convention

The `Action` enum carries **only positive actions** (`self-merge`,
`close-issue`, `merge-pr`, …) — **never** negated forms (`not-self-merge`).
Negation lives exclusively in the `deontic` field.

Why this matters: if negated actions were allowed, a
`prohibition(implementer, merge-pr)` could be silently dodged by re-expressing
it as `obligation(implementer, not-merge-pr)` — the *same* constraint under a
key the conflict-checker would never group with the original. Keeping actions
positive means any clash on a constraint always surfaces on one shared key. The
schema enforces it structurally: `not-merge-pr` is simply not in the enum and is
rejected.

---

## 4. The deontic-conflict matrix

Within one `(role, action, condition)` group, `detectNormConflicts` applies
standard deontic logic:

| pair                          | result      | reason |
|-------------------------------|-------------|--------|
| obligation ∧ prohibition      | **CONFLICT** | "must" vs "must not" |
| permission ∧ prohibition      | **CONFLICT** | "may" vs "must not" |
| obligation ∧ permission       | consistent  | obligation ⊨ permission (must implies may) |
| same modality                 | consistent  | (duplicate obligations → warning, see below) |

`detectNormConflicts(norms)` returns `{ conflicts, warnings }`:

- `conflicts: { a, b, type }[]` — each clashing pair + its type
  (`obligation-vs-prohibition` / `permission-vs-prohibition`).
- `warnings: { a, b, kind: 'duplicate-obligation' }[]` — a **non-blocking**
  advisory for two same-key obligations (a likely-redundant rule, not a
  contradiction).

---

## 5. The norm-vs-structural taxonomy (signal for G3)

Not every protected invariant is a deontic norm. Forcing a property-invariant
into `(role, action, condition)` produces a norm that *lies* about what it
constrains, and the conflict-checker would then reason over a fiction. So each
of the 10 protected invariants (`design/protected-invariants.md`) is classified:

| # | invariant | class | representation |
|---|-----------|-------|----------------|
| 1 | reporter-owns-closure | **NORM** | `obligation(reporter, close-issue, after-merge)` |
| 2 | identity ↔ attribution | structural | property of *every* action; no single "attribute" act to bind |
| 3 | LGTM gate / no-self-merge | **NORM** | `prohibition(implementer, merge-pr, without-non-author-approval)` |
| 4 | routing integrity | structural | property of the message-transport surface (see below) |
| 5 | auto-close discipline | **NORM** | `prohibition(implementer, auto-close-keyword, on-foreign-reporter-issue)` |
| 6 | fail-loud over silent-fallback | structural | meta-principle about *how* ops are written |
| 7 | PR-for-every-artifact | structural | property of the artifact-landing *path* (see below) |
| 8 | auditor never-acts | **NORM** ×3 | `prohibition(auditor, {merge-pr, close-issue, implement}, always)` |
| 9 | operator-as-ratifier | **NORM** | `obligation(operator, ratify-rule-change, always)` |
| 10 | universal rules not locally mutable | **NORM** | `prohibition(deployment, mutate-universal-rule, always)` |

Norm-expressible: **{1, 3, 5, 8, 9, 10}**. Structural: **{2, 4, 6, 7}**.
Encoded in `PROTECTED_INVARIANT_TAXONOMY`.

**Structural invariants** are tagged as `StructuralInvariant`
(`{ id, statement, whyNotANorm, enforcement }`) — NOT modelled as norms. The
conflict-checker never reasons over them; G3 routes them to the
structural-enforcement check (the hooks / result-invariant pattern) instead of
the norm conflict-check.

### The #4 and #7 judgement calls

Science leaned structural for both; we concur, and document why:

- **#4 routing-integrity** — the @mention requirement is a **transport
  precondition** of a comment (it must carry a routing-active mention to be
  delivered), not a deontic action a role performs. Modelling it as
  `obligation(agent, mention, …)` would contort a transport invariant into a
  role-action norm, and the "describing-context mentions must not false-route"
  half has no action shape at all. It is enforced structurally by
  `check-mention-routing.sh` (Check A must-have-mention + Check B
  must-not-leak). → **structural.**

- **#7 PR-for-every-artifact** — there is no clean positive **action** token for
  "land via PR" without contortion; it is a property of the artifact-landing
  *path* (PR + review + CI + rollback checkpoint), and it carries an
  operator-terminal-recovery **exception** that a flat deontic norm cannot
  express. Enforced by `pr-discipline` + the LGTM-gate hook + CI required
  checks. → **structural.**

(#8's auditor-never-acts is itself enforced structurally today via
`check-auditor-never-acts.sh` (F1), but it *also* has a clean deontic shape —
`prohibition(auditor, <act>, always)` — so it is dual-tagged: modelled as norms
here for the conflict-checker AND enforced by the hook at runtime. The norm
form is what G3 reasons over; the hook is what blocks.)

---

## 6. The scene / governor framing

The hooks + auditor **govern** (block, warn, propose at runtime). G2 only
**models**. The `Scene` data model exists so G3 can reason about *which* norm
governs *which* lifecycle transition (via `normRef`), not so anything in
macf-core enforces a lifecycle. There is deliberately no state-machine executor
in this module.

---

## 7. v1 scope vs deferred (G3)

**In v1 (this PR):**
- The norm + scene schemas with controlled vocabularies + the normalizer.
- The deontic conflict-checker: exact-token grouping on the canonical triple;
  obligation/prohibition + permission/prohibition conflicts; duplicate-obligation
  warning.
- The 10 protected invariants converted (norm set + structural set + taxonomy).

**Deferred to G3 (macf#505):**
- **Condition subsumption** — one condition logically implying another
  (`always` subsuming a narrower condition; nested predicates). v1 is
  exact-match only.
- **Structured-predicate conditions** — conditions as structured expressions
  rather than flat enum tokens.
- **Temporal / deadline logic** — reasoning over `deadline` (currently a
  descriptive string).
- **Role-hierarchy inheritance** — a norm on `agent` flowing to
  `implementer`/`reviewer`/etc. v1 treats roles as flat, distinct keys.

The G3 SECP validator consumes `PROTECTED_INVARIANT_NORMS` +
`PROTECTED_STRUCTURAL_INVARIANTS` + `detectNormConflicts` directly: it will
check a proposed rule (lowered to norms) against the protected-norm set for
contradictions, and route the structural invariants to their hook-based checks.
