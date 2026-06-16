# DR-026: Self-evolving coordination governance (the auditor)

**Status:** Accepted
**Date:** 2026-06-16
**Ratified:** 2026-06-16 by the operator (the constitutional gate, DR-026 §1). Ratification (a) accepts the decision, (b) establishes the protected-invariant set in `design/protected-invariants.md` as the SECP guardrail core (§4), and (c) releases the gated policy slice (G1–G4, `macf#503`–`#506`) for implementation. The foundational invariant-safe slice (F1–F4) was already built pre-ratification (`macf#499`–`#502`).
**Trigger:** 2026-06-15 operator ↔ `macf-science-agent` design arc + a multi-modal, multi-decade SOTA survey (session `ww0mgbtma`). The operator currently performs protocol-evolution **ad hoc** — "from time to time when I see something, I intervene." This DR formalizes delegating the *noticing → aggregating → proposing* of rule evolution to a dedicated agent, the **auditor**, grounded in prior art rather than reinvented. Full design synthesis + the survey's per-claim verdicts and citations: `groundnuty/macf-science-agent:research/2026-06-15-auditor-design-sota-and-provenance.md`.

## Context

MACF distributes a coordination protocol — canonical rules (`plugin/rules/*.md`) + structural harness hooks (`check-*.sh`) — to every agent workspace, and (per DR-025) coordinates over a **durable, observable substrate** (GitHub issues/PRs/comments + the comms-ledger). Today that protocol **evolves manually**: a human or an agent notices a coordination failure in the trace, diagnoses it, and someone hand-writes a rule or a hook. This *is* the project's methodology — every silent-fallback instance, every canonical rule, every `check-*.sh` exists because a failure was visible and someone acted on it. But it has two structural costs:

1. **It spends operator attention as the scarce resource.** The operator is the de-facto protocol steward — they notice drift and intervene. That is reactive (the operator must be watching) and it does not scale across the fleet of deployments MACF is heading toward.
2. **Protocol-evolution is entangled in domain work.** Rule changes surface *inside* science/code/devops domain issues; there is no first-class surface for "the protocol itself should change."

This session alone supplies the evidence: the substrate-hook drift across the three substrate agents, the stale `CLAUDE.md` after the data outage, and silent-fallback Instance 12 were all protocol-evolution signals that surfaced ad hoc, mid-domain-work, via operator noticing. A dedicated **auditor** delegates the *noticing → aggregating → proposing*, retaining the operator only as the **ratifier** — giving protocol-evolution its own steward and its own surface.

**Prior art is a blueprint, not a novelty claim.** The SOTA survey found this problem solved in pieces across five decades; the design below *adopts* that work rather than reinventing it:

| Borrowed from | What we take |
|---|---|
| Argyris double-loop learning (1977); Ostrom, *Governing the Commons* (1990) | the governance *structure* — three change-difficulty layers; agents-act / agents-propose / operator-ratifies maps onto Ostrom's operational / collective-choice / constitutional layers |
| Kephart & Chess, MAPE-K autonomic computing (2003) | the control-*loop* shape |
| Moise organizational model; AMELI / electronic institutions (2004-2020) | structured **norm representation** + runtime norm revision + the "governor" mediating layer |
| SECP (arXiv:2602.02170, 2026); Evolving Interpretable Constitutions (arXiv:2602.00755, 2026) | **bounded** self-modification with **protected, externally-validated invariants**; human-readable evolving rules |

The survey's honest verdict: none of these claims is novel in isolation; MACF's distinctive engineering is the **integration** — an embedded peer-auditor running on **live** production traces, evolving rules **through the same version-controlled substrate** the agents coordinate on, with a **human constitutional gate**. This DR records that integration as a decision.

## Decision

Introduce a **self-evolving coordination-governance loop** — the *auditor*.

### 1. The auditor: a dedicated, out-of-band, least-privilege home

The auditor is a **fourth agent-home** (alongside science / code / devops), with its own distinct external identity (its own GitHub App). It is:

- **Out of band** — it observes the coordination substrate; it never sits in the work path. The domain agents coordinate among themselves via the universal protocol; nobody waits on the auditor.
- **A sensor + steward, not an actuator** — it never authors rule *content* and never acts on the work. The division of powers is fixed:
  > **agents propose** (context-locality — the agent in the situation has the richest context) → **the auditor aggregates** (the only place a cross-agent view exists) → **the operator ratifies** (the constitutional gate). No single role holds both content-authority and coherence-authority; that separation is what keeps self-evolution safe.
- **Least-privilege** in a specific shape: **read-broad** (all issues/PRs/OTEL across its project, to aggregate), **write-proposals-only** (it may open issues/PRs), **never-acts** (it cannot merge, close others' work, or implement). It judges **coherence, not content** — it can flag that two memories contradict or a rule is stale; it cannot rule on whether a domain decision is correct.
  > **`never-acts` is a *structural* guarantee, not a GitHub-App-scope one.** The App permission needed to *open* a PR (`pull_requests: write`) also grants **merge** and **close**; `issues: write` also grants close/edit. GitHub cannot express "may open a PR but not merge it." So `write-proposals-only` / `never-acts` are enforced at the **structural / result level** — branch protection requiring a non-author review, the #270 LGTM-gate, and a `check-*.sh` that blocks the auditor identity from `gh pr merge` / `gh issue close` — **not** by App scope. This is the silent-fallback Instance 12 (#489) lesson restated: the guarantee lives at the result level, not at the precondition/permission level.

### 2. The loop — MAPE-K

| Stage | In MACF |
|---|---|
| **Monitor** | live traces: GitHub artifacts + OTel receipts (DR-021/025) + agents' structured reflections |
| **Analyze** | cross-agent pattern / drift / rule-breach detection (the "membrane") |
| **Plan** | frame rule-evolution proposals — *agents* author the content; the auditor aggregates + frames + dedupes |
| **Execute** | route to ratification (a PR + the operator gate) |
| **Knowledge** | the cohort/protocol memory |

### 3. The three-tier rule model

Coordination knowledge lives in **three tiers with three change-difficulties** (Ostrom's structure):

| Tier | Examples | Mutated by | Change difficulty |
|---|---|---|---|
| **Product / universal** (delivered by the tool) | reporter-owns-closure, token hygiene, the routing protocol | **nobody locally** — only an upstream **PR to the product**, ratified at the product | hardest (constitutional) |
| **Project-scoped** (this deployment's specifics) | "PRs must pass `make -f dev.mk check`", "devops owns the manifests", release cadence, domain conventions | the **local auditor proposes → local operator ratifies** | medium (collective-choice) |
| **Agent-private** | raw per-task notes, working comprehension | the agent itself, freely | easiest (operational) — and where context-rot lives |

The **project tier is the new abstraction.** We already have it informally (the science-agent file-cache token pattern, the macf-repo `make -f dev.mk check` Stop-hook, devops's cluster-investigation patterns) — drift that currently lives in `CLAUDE.md` prose. The auditor formalizes it. The auditor is the **router between tiers**: for each observed pattern it judges *universal → upstream product PR* vs *project-specific → local project rule*.

### 4. The guardrail invariant (bounded evolution)

Self-evolution must never erode the guarantees the protocol depends on (the SECP lesson: bounded modification around a fixed, externally-validated invariant core; and the dependency-model norm — you do not patch your vendored library in place, you PR upstream or configure locally).

- A deployed instance **cannot modify the universal/product rules locally** — it may only PR them upstream.
- It **may** propose project-scoped rules locally.
- **Subordination check (or the separation is too soft):** project rules may *add to / specialize* the universal protocol but may **not contradict or weaken its invariants**. A **protected invariant set** is defined (reporter-owns-closure accountability; the identity↔attribution guarantee; the no-self-merge / LGTM gate; …), and **every proposal is validated against it before the operator ratifies.**
  > **v1 validation is operator-manual.** The realistic first increment is a committed `protected-invariants.md` that the operator eyeballs each proposal against — *not* an automated checker. An **automated** SECP-style invariant-validator depends on the structured-norm representation (§5, deferred), so until that lands the "validated against the invariant set" guarantee is human-in-the-loop. The DR commits to the *guardrail*; the *automation* of it is a later track (see Scope).

### 5. Norm representation (machine-checkable)

Direction (mechanics deferred to implementation): represent a rule not as free prose but as a **structured norm** — `(role, deontic-operator [obligation | permission | prohibition], activation-condition, deadline/sanction)` (Moise). This makes rules checkable for compliance, violation, and *conflict*, which prose cannot be. Examples: reporter-owns-closure = `obligation(reporter, close-issue, after-merge)`; the LGTM gate = `prohibition(implementer, self-merge, without-non-author-approval)`. Adjacent patterns to pull from AMELI/electronic-institutions: the protocol as a **scene / state-machine** with role-gated transitions (the issue lifecycle), and a **governor** mediating-enforcement layer (which the `check-*.sh` hooks + the auditor already approximate).

> Decide direction, defer mechanics: this DR commits to *structured, machine-checkable norms with a versioned, runtime-revisable representation*. The exact schema, the conflict-checker, and the invariant-validator are specified in the implementation issues, not here.

### 6. Two loops — enforcement vs evolution (only one is reconciliation)

- **Single-loop (enforcement):** desired = the *current* rules; drive observed behavior → rules. **This is Kubernetes-style reconciliation** — and MACF already has its seeds: the `check-*.sh` PreToolUse/PostToolUse hooks + the macf#444 receipt-reconciler. The auditor's enforcement side can generalize these into an explicit fleet-level conformance loop.
- **Double-loop (evolution):** *revise the rules themselves* from accumulated observation. There is **no fixed desired-state** — the desired-state is what changes. This is **curated generative evolution** (Argyris double-loop), **not reconciliation.** It is the auditor's distinctive job and must not be modeled as convergence-to-a-target.

### 7. Triggers — event + periodic (not continuous)

- **Event-triggered capture** — most importantly, **an agent approaching compaction**: harvest its reflection *before* its accumulated context is compressed or lost. This structurally automates the existing `synthesize-before-compaction` / `codify-at-decision-time` disciplines. Other triggers: a hook-detected breach, a PR merge, a sweep completing, a pattern crossing a count threshold.
- **Periodic sweep** — lower frequency, for the cross-agent aggregation (the membrane compares across agents over time → batch).

### 8. Deployment topology + the meta-auditor

**In a fresh deployment** (e.g. a genomic-infrastructure project with fresh science/code/devops): the auditor is the 4th out-of-band least-privilege home. **Lifecycle:** mostly dormant week 0-1 (value grows with accumulation — not a day-1 win); cross-agent patterns emerge by weeks 2-3; its **highest-value early function** is promoting hard-won infra knowledge from private agent memory (tier 3) into shared **project rules** (tier 2) before it siloes or rots. **Operator interface:** ratifiable proposals + a periodic **protocol-health digest** (`digest-to-operator`).

**The meta-auditor — there is no separate meta-layer.** MACF-the-project is *itself* a MACF deployment, so the "meta-auditor" is just **the MACF project's own project-auditor** — and because MACF hosts the universal rules, *its project-tier IS everyone's product-tier.* Other deployments' auditors are **external contributors opening PRs upstream** (open-source maintenance, dogfooded).

- **Who:** naturally `macf-science-agent` — it governs MACF's evolution and holds the design rationale needed to review a universal-rule change well. It is **review, not self-review** (upstream proposals are externally authored).
- **Guardrail:** science-agent reviews *externally-authored* upstream PRs (fine), but must **not** be the sole reviewer of MACF's *own internally-authored* rule changes (self-review trap → route those to code/devops/operator). The operator stays the constitutional ratifier for all universal changes regardless.
- **Genuine meta-value (at scale only):** the **cross-deployment membrane** — N projects independently proposing the same rule is the strong universal signal no single deployment can see.
- **YAGNI + recursion requirement:** start with `macf-science-agent` wearing the hat; split a dedicated meta-auditor home only if load or status-quo bias demands. MACF-the-project must eventually run its own project-auditor (the dogfooding that completes the picture).

## Alternatives considered

- **Status quo — operator ad hoc.** Rejected: spends operator attention, reactive, doesn't scale across deployments, no first-class evolution surface.
- **SECP (one-shot external validator).** We borrow its invariant-validation idea but reject the one-shot/external shape: our auditor is an embedded peer on *continuous live* traces, not a batch validator.
- **Evolving Constitutions (offline genetic search).** We borrow human-readable evolving rules but reject offline GP: evolution is driven by real production behavior, through the substrate, not a simulated fitness landscape.
- **JaCaMo / Moise (composed organizational MAS).** The closest composed prior art — we borrow its norm/organization mechanics, but it lacks the binding to distinct external identity + a durable vendor-independent substrate that MACF has.
- **Platform-native coordination hooks (Claude Code agent-teams `TaskCompleted`/`TeammateIdle`).** Real and useful *inside* a home, but intra-identity, ephemeral, single-machine — they cannot govern cross-home, persistent, accountable coordination. The auditor composes them where they fit, it does not replace this layer.

## Consequences

**Positive.** Protocol-evolution gets a dedicated steward + surface; operator attention shifts from continuous-watching to periodic-ratifying batched, pre-analyzed digests; each deployment becomes a contributor to the product (the upstream-PR channel); the substrate-hook-drift / stale-state / codification-gap failure modes this session exhibited get a structural owner.

**Honest negatives / risks.**
- **Unbuilt.** Today there is zero auditor code, zero auditor rule, zero auditor DR (until this one). This DR is the *design input*, not a description of something running.
- **Low day-1 value.** The auditor's worth grows with accumulation; early on it is a quiet watcher. Deploy day-1-but-quiet so it captures early reflections.
- **The operator still ratifies — load reduced, not eliminated.** The human-as-constitutional-gate is by design (no auto-ratified rule changes); at N deployments the operator ratifies N digests. Digest quality is the load-bearing mitigation.
- **Dependencies.** It is most effective once the **memory-curation / selective-retrieval** work lands (raw-append memory rots — Mem0 / Lost-in-the-Middle / plasticity-loss) and the **structured-norm** representation exists. Those are separate tracks (see Scope).
- **Reflection ≠ verification.** Self-authored proposals will be plausible-but-sometimes-wrong; the N>1 cross-agent generalization gate + the operator ratification are the defenses.

## Scope — in vs deferred

**IN this DR:** the auditor architecture (MAPE-K), the three-tier rule model, the guardrail invariant, the norm-representation *direction*, the two-loop distinction, the trigger model, and the deployment + meta-auditor topology.

**DEFERRED to their own tracks (cross-referenced, not absorbed):**
- **Memory-curation / selective-retrieval** (the C2-rot fix) — substrate, then product.
- **SPIFFE-style credential rotation** for the identity/token layer → `macf#494`.
- **The C2 home-vs-fresh experiment** (does a persistent home actually beat a fresh one — gates how much curation is needed).
- **Project-tier rule formalization** (the structured-norm schema + the invariant-checker).
- **Implementation** — a follow-up set of issues for `macf-code-agent` once this DR is Accepted.

## Open questions

- What concrete project-scoped rules look like beyond the informal seeds (the auditor discovers most empirically; seed the obvious ones at bootstrap).
- Whether the enforcement (single-loop) side should become an explicit declarative fleet-reconciliation loop (closing the Kubernetes-analogy gap) or stay event-driven.
- The exact structured-norm schema + the invariant-validation mechanism (implementation).
- `digest-to-operator` is the accepted operator interface for now; a richer cross-deployment view may be wanted once N deployments exist.

## References

- Design synthesis + SOTA survey (per-claim verdicts + citations): `groundnuty/macf-science-agent:research/2026-06-15-auditor-design-sota-and-provenance.md`; positioning companion: `…/research/2026-06-15-macf-coordination-plane-kubernetes-for-agent-homes.md`; tracker `groundnuty/macf-science-agent#38`.
- DR-025 (observable coordination substrate — the trace this loop consumes); DR-021 (OTel); macf#444 (receipt-reconciler — the single-loop seed); DR-019 (app permissions — the auditor's least-privilege identity); DR-023 (hook/MCP architecture — the governor layer).
- Prior art (key): Argyris double-loop (1977); Ostrom, *Governing the Commons* (1990); Kephart & Chess, MAPE-K (IEEE Computer 2003); Moise / JaCaMo (Sci. Comp. Programming 2013); AMELI (AAMAS 2004); SECP (arXiv:2602.02170, 2026); Evolving Interpretable Constitutions (arXiv:2602.00755, 2026).
