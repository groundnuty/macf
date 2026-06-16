# Protected invariants (the SECP guardrail core)

**Status:** Ratified 2026-06-16 by the operator.
**Authority:** DR-026 §4 (the auditor — self-evolving coordination governance).

These are the guarantees the MACF coordination protocol depends on. They are the **fixed, externally-validated invariant core** around which all rule-evolution is bounded (the SECP model). The rule is simple and absolute:

> A project-tier rule (or any proposed rule change) may **add to / specialize** the universal protocol, but may **never contradict or weaken** an invariant below. A proposal that relaxes any of these is **wrong by construction** and must be rejected at ratification.

**v1 validation is operator-manual** (DR-026 §4): every proposed rule change is eyeballed against this list by the operator before ratification. The automated validator (DR-026 G3, `macf#505`) will consume this set once the structured-norm representation (G2, `macf#504`) lands; until then, this document is the human-read checklist.

This set is itself **constitutional** — it changes only by operator ratification of an explicit amendment to this file, never by a project-tier or agent-tier rule.

---

## The invariants

1. **Reporter-owns-closure accountability.** The agent who *opened* an issue owns its closure + verification — independent of who implemented the fix. (`coordination.md` §Issue Lifecycle 1)

2. **Identity ↔ attribution.** Every agent action is attributed to that agent's distinct external identity (its bot App), never silently to the operator or another agent. (`gh-token-attribution-traps`; silent-fallback Instances 1, 12)

3. **No-self-merge / LGTM gate.** No PR merges without a non-author `APPROVED` review. (`pr-discipline`; macf#270)

4. **Routing integrity.** A cross-agent comment must carry a routing-active `@mention` to reach its recipient; describing-context mentions must not false-route. (`mention-routing-hygiene`)

5. **Auto-close discipline.** Never use a GitHub auto-close keyword on a foreign-reporter issue; use `Refs #N`. (silent-fallback Instance 2)

6. **Fail-loud over silent-fallback.** Operations that can silently fall back to a wrong identity / scope / target must assert a **result-invariant**, not merely an exit code. (`silent-fallback-hazards`)

7. **PR-for-every-artifact.** Persistent artifacts land via PR (review + CI + audit + rollback checkpoint); only narrow operator-terminal recoveries excepted. (`pr-discipline`)

8. **Auditor never-acts.** The auditor proposes only — it cannot merge, close others' work, or implement; enforced **structurally** (`check-auditor-never-acts.sh`, macf#499/F1), not by App scope. (DR-026 §1/§4)

9. **Operator-as-constitutional-ratifier.** No rule change is auto-applied; the human ratifies — universal changes always. (DR-026)

10. **Universal rules are not locally mutable.** A deployment may only PR universal / product rules upstream; it never patches them locally (the dependency-model norm). (DR-026 §4)

---

## Amending this set

This file is amended only by:

1. A PR editing this file, authored as a deliberate constitutional change (not bundled with other work).
2. Explicit operator ratification of that PR (the operator is the only authority that can add, remove, or weaken a protected invariant).
3. A rationale recorded in the PR body: what invariant changed and why the protocol's guarantees still hold.

The auditor (DR-026) may *propose* an amendment here (it is write-proposals-only), but may never merge one — invariant #8 + #9 apply to the auditor's own governance recursively.
