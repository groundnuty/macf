# DR-045: A fleet's status carries live-only facts, not a mirror of its spec

**Status:** **Proposed** (science-agent, 2026-08-27; awaiting operator ratification)
**Date:** 2026-08-27
**Trigger:** `macf#1198` — operator, refining the reconciliation work: *"The status should preferably have more information — different, extra information than the schema. Exactly like in Kubernetes, because live objects usually have live state, live changes, live versions, maybe even updated dates."*

## Context — the question a spec-shaped audit cannot ask

DR-043 Amendment P made `apply` a reconciler: for each declared resource, compare desired to live and compute a verb. `macf#1196`'s audit asks the matching question per spec field — *is its live value reported?*

**This DR is the inverse.** A Kubernetes `status` subresource is not a reflection of `spec`; it carries facts with **no spec counterpart at all** — `conditions[]`, `observedGeneration`, `lastTransitionTime`, `readyReplicas`. Those are the facts that answer *"has anything acted on what I declared, and did it work?"*

**Every fleet-level failure of the DR-043 arc was a missing fact of that shape:**

| incident | the fact that was missing |
|---|---|
| `#1184` — a fleet reported `provisioned` while routing was dead | has routing **ever delivered** |
| `#1195` — a manifest field declared and never acted on | which spec revision has been **acted on** |
| `#1129` — `versions:` authoritative, convergence unproven | what version is **deployed**, per resource |
| `#1269` — a lock write gated on a create | when was this artifact **last written** |

A spec-shaped report cannot surface any of them, because in every case the spec field was present and correct.

---

## Decision 1 — `status` never writes; only `apply` writes

`macf bootstrap status` is **computed at read time from live GitHub state**. A Kubernetes status is written by a controller and read by everyone — a cache, continuously updated. Ours is not a cache.

> **Never make `status` record what it saw.** A read that writes turns every invocation into a mutation, dirties the control repo, and converts an observation into an event.

That choice buys a property Kubernetes does not have — **freshness by construction** for every fact read live — and costs the thing that makes `lastTransitionTime` possible: **history**. A reader that only ever looks at *now* cannot report when a condition changed.

**The freshness guarantee is a property of DERIVED facts only, and does not extend to Decision 2's tier 2.** A recorded fact is exactly as fresh as the `apply` that wrote it — and `#1269` proved that write can be silently skipped, because a run that mints nothing took a path that never reached the lock write at all. **Tier 2's reliability lives in `apply`, not in `status`**, and a status that presents a recorded value as current inherits a failure it cannot see.

> **Every tier-2 fact carries WHEN it was recorded, and status may not present its value without it.** *"Recorded four days ago on a fleet applied twice since"* is a different fact from both *"unknown"* and the bare value — and it is the only one of the three that is both honest and useful.

## Decision 2 — where history comes from, in strict preference order

1. **GitHub's own timestamps.** Free, authoritative, and they **survive a tool reinstall**. Actions secrets and variables carry `updated_at`; commits, workflow runs, App installations are all timestamped.
2. **`apply`-written per-resource metadata**, for what GitHub cannot tell us — and only that.
3. **Nothing.** Report `unknown`. **Never synthesise.**

> **A timestamp we derive is a fact about the resource; one we record is a fact about our tool.** The first stays true when our tool is reinstalled, mis-run, or absent for a year.

**And the corollary, which is the whole point of the ordering:**

> **A fact is not ours to persist merely because it is about us.** Ask what GitHub already timestamps before deciding anything needs recording.

*Worked instance:* *"has this fleet's routing ever delivered"* — the fact that would have caught `#1184` — reads as ours to track, and is not. **Router run history is queryable, timestamped and authoritative**, so the fact is derivable, free, and reinstall-proof. The first draft of this DR filed it under *persisted by `apply`*, which was wrong twice over: `apply` cannot observe a delivery that happens later in a router run it never sees, and it does not need to.

## Decision 3 — `updated_at` answers WHEN, never WHAT

The derived-timestamp source has a boundary a controller author will otherwise walk straight into.

`updated_at` on a secret says **when it was last written**. It does **not** say by whom, and critically **not to what value**.

> **A write-only resource's timestamp is evidence of an event, never of a state.** *"Written 3 minutes ago"* and *"holds the value we intended"* are different claims, and only the first is observable.

So status may report *last written at T*, and may report *our record says we wrote value V at T′*, and **may never combine them into "holds V"**. Where the two disagree — GitHub's `updated_at` newer than our recorded write — that is a **third-party write**, which is a reportable fact in itself and the only drift signal available for a value we cannot read (DR-043 Amendment P4).

## Decision 4 — `observedGeneration` is PER-RESOURCE, never per-fleet

A single fleet-level generation marker answers *"has anything acted on this manifest revision"*, which is the wrong question. Every real failure above was **partial**: some resources converged and one did not.

> **A fleet-level `observedGeneration` reports the maximum, and a fleet is as converged as its least-converged resource.**

Each resource in `status` carries the manifest revision **it** was last acted on at. The fleet-level summary is then derived — and derived as the **minimum**, per `#1226`'s weakest-component rule.

## Decision 5 — conditions are tri-state, and `unknown` is a first-class outcome

Each condition is `true` / `false` / `unknown`, with a `reason` and a `message`. **`unknown` is not a failure and not a default** — it is the honest report of a check that could not run or a resource that could not be observed.

> **Collapsing *cannot-tell* into *nothing-wrong* is how this codebase has repeatedly shipped a green that meant nothing** (`#1215`, `#1226`, `#1260`).

A condition that cannot be evaluated **must not** be reported as satisfied, and **must not** be reported as violated.

## Decision 6 — status reports its own coverage

Every status response carries what it **did not** observe: resources it could not reach, checks it did not run, and why.

> **An audit must report its own coverage, not only its findings** (`#1192`). **A check that did not run has zero coverage, and that is the most important coverage value to report.**

A permission gap, an unreachable repo, or a missing credential is **not** an absence of findings — it is an absence of looking, and the two are indistinguishable to a reader unless the report says which it was.

## Decision 7 — facts the tool watches but does not own

Status reports on state MACF did not create: an operator-managed secret, an org variable set by hand, a repo added outside the manifest.

> **Reporting a fact is not a claim to own it.** Status observes; only `apply` decides, and only for what `fleet.lock` records as ours (DR-043 Amendment P, row 5).

A fact the tool watches but may not act on is **still worth reporting** — it is often the explanation for a failure the tool *can* see — and it must be marked as not-ours so no reader infers the tool will fix it.

## Decision 8 — no field enters a composite verdict without its false-positive behaviour stated

A composite verdict (`HEALTHY`, `provisioned`, `CONFIRMED`) aggregates many facts, and **aggregation raises the cost of every constituent's false positives**: a field that is merely noisy alone becomes a wrong verdict when summed.

> **Before a field joins a composite, state what it reads as when it is wrong — at the composite's severity, not the field's.**

And the direction that decides how strict to be:

> **The acceptable false-positive rate is set by the cost of the REMEDY, not the cost of the failure** (`macf-devops-toolkit#198`). A verdict that triggers a destructive action needs stronger confirmation than one that prints a line.

---

## What this DR does not decide

**The wire format.** Field names, nesting, and whether status emits JSON, a table, or both are implementation concerns; this DR constrains what may be *claimed*, not how it is rendered.

**Which conditions exist.** The set (`Routed`, `Provisioned`, `Converged`, …) follows from the fleet's own surfaces and will grow; each new one inherits Decisions 5, 6 and 8.

**Remote/multi-host status.** DR-037 Amendment D holds: deployment is local-only by construction, and a remote mode is a new driver behind an existing seam.

## Consequences

- **`status` gains no write path**, so it stays safe to run at any time, from any identity permitted to read (DR-044).
- **Several facts we assumed needed recording turn out to be free**, most importantly *has routing ever delivered*.
- **Some facts genuinely are unavailable**, and the DR requires saying so rather than inferring — which will make status *less* confident-looking than it is today, and correctly so.
