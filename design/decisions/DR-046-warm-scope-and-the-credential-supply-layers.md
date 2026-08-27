# DR-046: A warm scope, and the three layers that make fleet N+1 need only a manifest

**Status:** **Proposed** (science-agent, 2026-08-27; awaiting operator ratification)
**Date:** 2026-08-27
**Trigger:** `macf#1207` — operator: *"We want to minimize what we need to provide when deploying on an organization or user account that already had a fleet deployed. Let's call it, from now, **WARM** — as in, already populated with shared fleet information and secrets."*

## Context — one concept that four issues were circling separately

`macf-trial` is the **fourth** fleet in `macf-experiment`. The shared routing App exists, its private key sits in two sibling fleets' vaults, and **`macf-trial` cannot route** — because there is no supported path to give a new fleet a credential that was emitted once, to someone else, months ago.

Four issues had each solved part of this and none of it (`#1084`, `#1189`, `#1197`, `#1082`). **Naming the concept is what showed they were layers rather than alternatives.**

---

## Decision 1 — the vocabulary, because it is load-bearing

- **COLD scope** — an org or user account with no prior fleet. Nothing to inherit; every scope-level credential must be supplied.
- **WARM scope** — already populated with shared fleet information and secrets. **Fleet N+1 should need essentially nothing new.**

## Decision 2 — warm means CREDENTIAL-SUPPLY goes to zero, not that clicks do

`#1207` originally asked for fleet N+1 *"verified by an agent doing it end-to-end with **no operator step**."* **That is unsatisfiable by construction.** DR-044 Decision 1: App creation and initial installation are **browser-only, two clicks per App, permanently**. No credential architecture removes them.

> **Warm scope means the credential-SUPPLY steps go to zero — never that the consent clicks do.** Fleet N+1 into a warm scope costs **the manifest, the operator's clicks, and nothing else.**

That target is achievable. *"No operator step"* is not, and leaving it as the bar guarantees the issue stays open while the actual goal is met — the same wall `#1138` hit when a live-smoke harness tried to be unattended.

## Decision 3 — warmth is a RELATION between a scope and an actor

Not a property of a scope:

> **Ask *"which prerequisites does this scope satisfy FOR THIS ACTOR"*, never *"is this scope warm."*** The answer differs per actor with the scope unchanged.

`macf-experiment` is **maximally warm** for fleet Apps and **stone cold** for the `groundnuty/runner-platform` controller, which has never been installed there. Same org, same instant, opposite verdicts.

**And this explains why nothing caught it.** Every check we have asks *"can OUR App reach X."* A third party's installation state is **unobservable with our credential**, so *"no controller is installed"* and *"we cannot see whether a controller is installed"* are indistinguishable — `verify-before-claim §5d` at the installation layer. The absence surfaced through the worst available channel: **a runner that would not start.**

## Decision 4 — unobservable prerequisites are DECLARED, then verified by EFFECT

> **A prerequisite you cannot observe must be declared in the manifest and checked by its outcome, never by its configuration.**

For the controller we cannot ask *"are you installed?"* — we can only ask *"did a runner appear?"* So the manifest declares the dependency and the check is the effect. Same shape as `macf-devops-toolkit#198`'s watchdog (a wedged runner has no `Runner.Worker`) and `#670`'s doctors: **measure the effect, not the proxy** — here because the proxy is not merely misleading but *invisible to us by construction*.

## Decision 5 — the three proposals are one architecture, in a fixed order

They answer different questions and none suffices alone:

| layer | question it answers | state today |
|---|---|---|
| **scope store** (`#1084`) | **WHERE** long-lived scope credentials live | not built |
| **minter**, generalised (`#1189`) | **HOW** a fleet obtains one without decrypting anything | not built; reads the store |
| **operator-inputs file** (`#1197`) | how a **COLD** scope gets its first credentials *into* the store | shipped (`#1228`) |

**A minter needs somewhere to keep the long-lived keys — that is the store.** Sequence: **store first** (it is the substrate), **minter second** (its only consumer), **inputs file feeds the store on cold start** (it exists and currently feeds nothing).

**What belongs in the store is settled by DR-043 Amendment N8:** the operator master key, shared App private keys, and Tailscale OAuth — **sealed things only.** Non-secret scope state stays an org variable (`#1219`).

## Decision 6 — minting is right because it is the least novel thing here

The framework already mints twice: **installation tokens** from an App private key, and **runner registration tokens** from the controller. A scope-level minter is **the same pattern at a third scope**, not a new mechanism — and *"the least novel option"* is the stronger argument for it, not a weaker one.

> **A fleet should never hold a scope-level long-lived key. It should be able to ASK for a short-lived one.** That is what makes DR-043 Amendment N1 satisfiable — *never store a key where the ciphertext's readers can also read* — while still letting fleet N+1 route.

## Decision 7 — a preflight's scope must not exceed its cause

Observed live: a missing runner-registration token **aborted `apply` before publishing the routing secrets**, which do not depend on it.

> **A precondition gates its dependents, never the whole run.** A missing input is a reason to skip what needs it and to report loudly — never a reason to abandon legs that would have succeeded.

The framework is otherwise built precisely against this — per-role outcomes (`#1167`), partial rolls (`#1150`/`#1163`), refuse-one-continue-others (`#1147`). **One coarse gate at the top discards all of it**, and the cost is real work silently not done.

## Decision 8 — two scopes, and the cold one is an instrument

    macf-experiment   →  WARM development scope.  Fix freely; install what is needed.
    <new org>         →  COLD test scope.         Pristine by construction.

`#1188` established that **a cold start has never been measured** — every e2e ran on a scope that already hosted a fleet — and **it cannot be measured twice on the same scope**, because the first provision warms it permanently.

> **The cold-test scope's entire value is that it is untouched.** Every convenience installed there *"to make it work"* destroys the measurement it exists to produce.

Operational form in `design/fleet-deployment-runbook.md §6a`, which is where whoever provisions that org will read it.

---

## What this DR does not decide

**The store's implementation** — file, org secret, external KMS. Decision 5 fixes its *place* and N8 fixes its *contents*; the medium is open and constrained by N1.

**The minter's transport** — DR-043 Amendment N6 already binds it: whatever ships must carry **per-agent slices, never whole vaults**.

**Whether the interim survives** — cross-fleet key copy under operator-authorised decrypt, marked by `#1167`, remains the labelled interim until the store lands. **A silent copy is the failure; a loud one is a deferral.**

## Consequences

- **`#1207` becomes closable** once fleet N+1 costs manifest + clicks, rather than waiting on a zero-operator-step bar DR-044 forbids.
- **Warmth becomes a question with an actor in it**, so `status` and `plan` must name *whose* prerequisites they checked (DR-045 Decision 6's coverage rule).
- **The runner-platform controller's absence is a declared dependency**, not an unexplained runner failure — and its check is an effect, not a state.
