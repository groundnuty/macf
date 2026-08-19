# DR-044: Fleet authority — who may ask a fleet-wide question

**Status:** **Proposed** (science-authored 2026-08-19, operator-directed via `macf#1027`; awaiting operator ratification)
**Date:** 2026-08-19
**Trigger:** `macf#1026` — `macf bootstrap status`, a fleet command, was run with **science-agent's** installation token and rendered every resource that agent cannot see as `absent`, including a repo that exists and holds the CA variable. The tool had no notion that it had been handed the wrong identity for the question.

## Context — the framework has never distinguished two identities it has always had

MACF operates in two modes, and has since the first consent gate:

| | identity | scope | examples |
|---|---|---|---|
| **agent mode** | that agent's App installation token | **deliberately partial** — only what that agent may see | `macf status`, `macf peers`, the agent's own `gh` work |
| **fleet mode** | the **operator's** credentials | the whole fleet — the identity under which it was created | `macf bootstrap plan/apply/status`, teardown |

`check-gh-token.sh` (`macf#140`) has enforced the **agent** half for months: an agent doing `gh` work must present an installation token, or it is the attribution trap. **The fleet half was never stated.** One side of a discriminator, enforced for months, with nobody noticing the other side was missing — which is why `#1026` was possible.

**The load-bearing reframing (operator, 2026-08-19):** an agent's narrow view is **a feature, not a limitation to work around**. A fleet command run with an agent token is not under-privileged; it is **the wrong identity for the question**.

## Decision 1 — ownership terminates in a human action

**There exists a capability in this system that no credential can hold: creating and installing a GitHub App.** GitHub exposes it only to a human at a browser. No token grants it, and no amount of permission-widening ever will.

This is the **root of fleet authority**, and it is why this DR states a structural fact rather than a policy:

- A policy (*"we have chosen the operator as owner"*) could be delegated away later by anything sufficiently privileged.
- **Ownership that terminates in an action no credential can perform cannot be.** Even the widest conceivable fleet App hits this floor: however wide, it cannot create the next App.

Everything else in MACF's identity model is **delegation beneath that root** — which retroactively explains every consent gate in DR-043 as *the fleet's root of authority being exercised*, not as a UX limitation we tolerate.

**Corollary the check must respect:** the App-creation gate is **not a permission**, so a capability check must not attempt to verify it, and must say so at the site. Otherwise a future reader "fixes" its absence by inventing a permission that does not exist.

## Decision 2 — the rule

**A fleet-wide question may be asked only by an identity holding fleet authority: the identity that owns the fleet and under which it was created.**

A fleet command presented with an identity lacking fleet authority **refuses**, naming the mismatch and the remedy. It does not proceed and render a partial view as fact — that is `#1026`, where an existing repo reported `absent` and the operator would have reasoned about a fleet they do not have.

Refusal rather than degradation, because **nothing downstream resolves the error**: the wrong answer is confident, complete-looking, and never corrected. (Contrast `#1015`, where `unknown` genuinely meant *could not verify*, refusal would have destroyed spent consent clicks, and the gap was one settings edit — there, proceed-with-warning is correct. The discriminator is whether anything downstream resolves the uncertainty, and here nothing does.)

An override exists per this project's escape-hatch convention, and is **safe only because** `#1026`'s 404→`unknown` mapping lands with it: without that mapping an override produces lies; with it, it produces an honest, correctly-labelled partial view.

## Decision 3 — the discriminator is CAPABILITY, not token shape

**Ask what the identity can do, not what kind of token it is.**

- **Held power** is read by introspection — verified live on both classes: `GET /installation/repositories` → `repository_selection` for installation tokens; `HEAD /` → `x-oauth-scopes` for user tokens; and the App installation's full permission map, which `macf doctor` already reads to verify a workspace against DR-019.
- **Required power** is declared per fleet operation, and **verified against `X-Accepted-Github-Permissions`** — the header reporting what an endpoint itself requires. The header cannot serve the pre-flight (it is only visible *after* a call), but it makes the declaration **self-checking** rather than hand-maintained-and-trusted.

> **Asserted by:** `packages/macf/test/cli/bootstrap/fleet-authority.test.ts` → `"each fleet operation's declared required-power matches what GitHub's X-Accepted-Github-Permissions reports for the endpoints it calls"`

**Read the permission map through `doctor`'s existing path, never a second reader** — the operator's golden-path directive, with `#1000` as the local proof that a second path in one area goes unnoticed until it diverges.

### The retired proxy, and the condition that made it sound

The first form of this rule was a **token-prefix test** (`ghs_` = agent, `gho_`/`ghp_` = operator). It is recorded here because its reasoning is instructive, not because it is used:

**The prefix test is sound if and only if every installation token in existence belongs to a per-agent App with deliberately partial scope.** That is contingent, and the extension in Decision 5 **falsifies it** — a wide fleet App presents an installation token while holding fleet authority, so the prefix test would refuse the one identity provisioned to do fleet work.

Capability introspection does not depend on that condition, because it asks the question the rule is actually about. **Assert the invariant, not the proxy** — the same correction that replaced a magic-number test in `macf#951` and invalidated an installation-listing identity check in `macf#999`, here at the level of the design itself.

## Decision 4 — the fleet permission set is declared in its own right

The delta is small: fleet operations need approximately the agent set plus `administration` (repo creation) and, for Amendment G's destructive rungs, repo deletion. **`administration: write` is already declared** — in `RUNNER_OPS_PERMISSIONS`.

**The fleet set is nonetheless declared in its own right, with a test asserting its overlap with the agent set** — *not* defined as `agent ∪ {…}`. Definition-by-composition couples two sets that can legitimately diverge: an agent permission exists because agents need it, a fleet permission because fleet operations do, and today's near-total overlap is not a relation. Under composition, **narrowing DR-019 for good blast-radius reasons would silently narrow fleet authority**, and a fleet command still needing that permission would begin refusing the operator. Declared separately, the overlap stays visible and any drift is loud.

**The asymmetry is deliberate and pre-existing.** Repo deletion sits in the operator's scopes and in **no** App set — because Amendment G's deletion ceremony and the key-class rule (`macf#943`, which rejected widening DR-019 with `administration: write` and minted `runner-ops` instead) already decided that repo-deletion must never sit on an exported agent key. **Capability introspection does not impose a new restriction; it makes an existing decision mechanically true**, which it previously had no way to check.

## Decision 5 — the wide-fleet-App extension, recorded and not built

**Operator, 2026-08-19:**

> *"It's quite possible that in the future the fleet will be deployed with some kind of very wide application identity and permissions … **I don't plan on implementing such an approach yet.** However, we should take into account such extension and just be aware of such possibility."*

Under Decision 3 this arrives **without contradicting anything**: a wide fleet App either holds the required power or does not, and the check asks exactly that. No clause needs amending — which is the test a rule should pass before ratification.

**The cost, recorded so the decision is made knowingly, not to block it:** such an App needs enough permission to do what the operator does by hand — repo creation, deletion, org reads. Its private key would **leave the vault**, and under the key-class rule **export is a one-way gate**: the ceiling never lowers afterwards. Agent Apps are deliberately minimal *because* their keys are exported; a wide fleet App is the opposite trade at the highest ceiling in the system. Not wrong — **not walk-back-able**.

## Consequences

- **This constrains agents, including the author.** Under this DR, `macf-science-agent` cannot run `macf bootstrap status` against a fleet — its partial view is correct rather than a limitation. Accepted.
- **It creates a question it does not answer:** the future `fleet-manager` role (named in DR-043, built later) would need fleet authority. Fleet authority is the operator's, so a fleet-manager is either **a delegation of operator authority** — an operator-class credential, and therefore Decision 5's one-way gate — or it is not an agent at all. **Deliberately unresolved here**, recorded so a future PR does not answer it by accident.
- **`#1026`'s 404→`unknown` mapping is a precondition of the override**, not an alternative to the refusal.

## References

`#1027` (the operator's framing) · `#1026` (the incident) · `#140` (the agent half, enforced since) · `#943` (the key-class rule) · `#951` / `#999` (assert-the-invariant-not-the-proxy) · `#1000` (why a second reader is a hazard) · DR-019 · DR-043 Amendments C/D/G · DR-008 (agent identity = **role vs name**, a different axis — this DR deliberately says *authority*, not *identity*).
