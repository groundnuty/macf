# DR-036: Cross-fleet delegation — inviting a specialist agent that owns a dependency

**Status:** Proposed
**Date:** 2026-06-30
**Trigger:** Operator-requested. A fleet depends on a tool/product that is **owned and developed by a different agent in another fleet**. Forcing the dependent fleet's own code-agent to learn + maintain that product is the wrong move; the natural move is to **invite the specialist agent (the product owner) to collaborate across the fleet boundary**, the same way every consumer fleet already collaborates with `groundnuty/macf` / `macf-code-agent`. The worked example throughout: the **`icsoc-2026` paper fleet** (`groundnuty/icsoc-2026-science-agent` [science/coordinator], `groundnuty/icsoc-2026-experiment` [code], `groundnuty/icsoc-2026` [paper]) depends on **`groundnuty/onedata-mcp`** — an MCP server for the Onedata data-platform that the experiment uses for data access — which is owned by its own specialist agent in its own line of work. Design driven by the operator + code-agent dialogue (2026-06-30); routed to science for canonical-record review + operator ratification (same path as DR-035).

> **The anchor insight.** MACF already lives this relationship — cross-fleet delegation is the **substrate-serves-consumers** pattern generalized. `macf-code-agent` develops the framework in `groundnuty/macf`; every consumer fleet uses it, files issues against `groundnuty/macf`, and consumes versioned releases — without absorbing the framework or moving code-agent into the consumer fleet. A specialist tool-owner agent (the `onedata-mcp` maintainer) is a domain-specific instance of exactly that shape. **This DR names + generalizes a proven pattern; it does not invent one.**

## Context — depend on a product, not on relearning it

The `icsoc-2026` experiment needs data access via Onedata. `onedata-mcp` is a real product with its own roadmap, its own maintainer (a specialist agent), and its own release cadence. Two non-options frame the decision:

| Anti-pattern | Why it's wrong |
|---|---|
| The dependent fleet's **code-agent absorbs** the product (learns + forks + maintains `onedata-mcp` inside `icsoc-2026-experiment`) | Duplicates the specialist's expertise, forks the product, and creates a second source of truth that drifts from upstream. The dependent code-agent is not the domain expert and is not positioned to be (`delegation-template.md` §"When to delegate"). |
| The specialist **relocates** into the dependent fleet | The specialist stops owning its product on its own roadmap; the dependency becomes captive to one consumer. Other consumers of `onedata-mcp` lose a maintainer. |

The right shape is **delegation across the fleet boundary**: the specialist stays where it is, owns its product, and the dependent fleet asks it for what it needs — on the GitHub plane, against a versioned artifact. This is the in-fleet `delegation-template.md` pattern stretched one repo / one fleet outward.

**Open / confirm-these (do not assume — track as open items):**

- ~~Is the `onedata-mcp` maintainer **already a registered MACF agent**...?~~ **RESOLVED 2026-06-30:** it is the **(c) local-mode case** — worked by the `ppam-2026` code-agent (DR-024 local-registry, macf 0.2.21, no GitHub App, operator-identity, private `127.0.0.1` mTLS mesh, branch `ppam2026/14-tools`). NOT GitHub-routable; collaborate operator-mediated (or opt-in bootstrap to App-scoped). See enabler path (c).
- What is its **routing label / bot handle**? *(Needed for the delegation issue's assignee label + the @mention.)*
- What is its **registry scope** — the same `groundnuty` Profile scope `icsoc-2026` uses (`groundnuty/groundnuty`, per DR-006), or a different account/org?

## Decision — cross-fleet delegation

**The dependent fleet delegates to the specialist; it does NOT absorb the product and does NOT relocate the specialist.** The specialist stays in its own fleet and **owns its product repo + roadmap**. Concretely:

### 1. Work stays in the specialist's repo; the artifact is a versioned release

The dependent fleet's coordinator files a **6-section delegation issue** (per `delegation-template.md`) on the *specialist's* repo (`groundnuty/onedata-mcp`), tagged with the specialist's routing label. The specialist implements **there**, opens a PR in **its** repo, and cuts a **versioned release**. The dependent fleet **consumes the release + version-pins** it (§5). Collaboration is **GitHub-plane delegation + a versioned artifact** — the same contract the substrate already runs with every consumer.

This is **B1-flavored — no cross-fleet CA/mTLS trust is required.** Routing rides the GitHub @mention → the specialist's own channel-server in its own fleet, exactly as in-fleet delegation does. It is explicitly **NOT** the heavier "live cross-fleet `/notify`" (B2) form, which would require shared or cross-signed CAs between two independently-provisioned fleets. B2 is **out of scope** here and noted only as a future option (§Boundaries) if continuous live cross-fleet push ever becomes necessary.

### 2. The delegation tree — one delegation owner

- The dependent fleet's **science-agent (coordinator) owns the cross-fleet delegation.** It treats the specialist as **just-another-implementer that happens to live in another fleet/repo** — parallel to how it already delegates to its own in-fleet code-agent. The cross-fleet hop changes the *repo* the issue is filed on; it does not change *who* delegates.
- The dependent fleet's **code-agent does NOT delegate to the specialist.** One delegation owner avoids two-delegator ambiguity (which fleet member speaks for the dependency?). **Exception:** if the dependent code-agent hits a tool bug mid-implementation, it files that as a normal **dependency-bug issue** on `groundnuty/onedata-mcp` — and then *it* is the reporter of that one issue (reporter-owns-closure applies to it).
- **Reporter-owns-closure across the boundary** (`coordination.md` §Issue Lifecycle 1): whoever filed the delegation (science, for the feature request; code-agent, for a tool bug it filed) **verifies** the released tool actually unblocks them, then closes — the same rule, applied cross-repo. The specialist, as implementer-but-not-reporter, posts the merge handoff and stops; it does **not** auto-close a dependent-fleet-filed issue (the close-keyword discipline holds across repos).

### 3. Peer-ownership (load-bearing principle)

Because the specialist **owns its product**, the dependent fleet's delegation is a **request it can prioritize, push back on, or decline** — the `peer-dynamic.md` stance, stretched across fleets. The dependent fleet does **not** dictate the specialist's product or roadmap; it states a need and negotiates. The specialist is a **guest peer, not a fleet member**: it does not take a `code-agent`/`science-agent` label in the dependent fleet's registry, and is not supervised by the dependent fleet's liveness/reconciliation machinery (DR-031). It is a peer in another fleet that the dependent fleet collaborates with. **(Amendment A, 2026-06-30: the original text also said the guest "does not appear in the dependent fleet's `macf fleet status`"; that visibility prohibition is superseded — the consumer MAY now *show* the guest in its `macf fleet status`, clearly marked as an external, **unsupervised** guest. Visibility is split from supervision; only the no-supervision invariant stands. See Amendment A.)**

**The specialist keeps its own identity.** It posts, reviews, and releases **as its own App/bot** — it never impersonates a dependent-fleet agent, and the dependent fleet's agents never post as the specialist. The per-agent attribution discipline (`gh-token-attribution-traps.md`) holds verbatim across the boundary: each party's `gh` operations carry its own `ghs_` installation token for its own App. Clean per-agent attribution is exactly what makes the cross-fleet paper-trail auditable.

### 4. Optional cross-review

The dependent fleet's code-agent **MAY review the specialist's PRs in the specialist's repo** — it brings the consumer's "does this actually unblock us" perspective, which the specialist's own reviewer may lack. Two forms:

- **Formal review** (`gh pr review --approve` / `--request-changes`, which fires `route-by-pr-review-state`) requires the dependent code-agent's **App installed on the specialist's repo** with `pull_requests:write`. This is the higher-fidelity path (state-change routing per `pr-discipline.md`).
- **Informal review** — a plain `@mention` review comment if the dependent code-agent's App is not installed on the specialist's repo. Lower fidelity (no state-change routing) but needs no cross-install.

Cross-review is **optional** — the specialist's own review discipline is sufficient for merge; the consumer's review is value-add, not a gate.

### 5. Version contract

The specialist's tool ships a **`compatibility` declaration** (the `macf-bootstrap` `compatibility.<framework>` pattern from DR-035 Amendment — a semver-range manifest key naming what it requires), and the dependent fleet **pins a known-good version** of `onedata-mcp`. The tool evolving on its own cadence therefore does not silently break the dependent fleet: the pin holds the consumer on a verified version, and the compatibility range documents what the tool itself depends on. This is the same "declared + pinned, never float-and-hope" discipline the framework already runs (channel-server version pin per macf#421; the two-track routing version pins per CLAUDE.md).

## Two enabler paths (the materially-important branch)

Whether cross-fleet delegation is light or needs an on-ramp depends entirely on whether the specialist is already a MACF agent.

### (a) The specialist is ALREADY a MACF agent

(Registered in a registry, has a channel-server, has its own App.) Cross-fleet delegation is **light** — mostly **routing-resolution + App-installs**:

- **Routing-resolution is FREE if both fleets share a registry scope.** `icsoc-2026` is Profile scope on `groundnuty/groundnuty` (DR-006). If the `onedata-mcp` agent is also a `groundnuty`-Profile agent, it is **already discoverable** in the same registry — `route-by-mention` resolves its channel-server with no extra wiring. A specialist registered under a **different account/org** needs the **cross-scope resolution** the routing-doctor already performs (union of registries — `macf#621`'s registry-iterated per-agent tier); the resolution mechanism exists, it just spans two scopes.
- **App-installs (the only genuinely new GitHub-plane wiring):** the dependent bot that files the delegation (science) needs **`issues:write` on `groundnuty/onedata-mcp`** to file + comment. For **formal cross-review** (§4), the dependent code-agent's App needs an install on the specialist's repo with `pull_requests:write`. These are ordinary `gh`/REST installs — no new transport, no new CA.
  - **Same-owner vs cross-owner is a distinct authorization step** (science #667 review). When both fleets are under the **same `groundnuty` Profile**, the operator owns both sides and authorizes the install unilaterally — trivial. Installing the dependent's App on a **different-account** specialist's repo is a **cross-owner handshake**: the *specialist's* owner must approve the install (you cannot install your App on another org's repo without their consent). Note this is orthogonal to routing-*resolution*: `macf#621`'s cross-scope work resolves *where* the specialist is; the cross-owner App-*install* approval is a separate operator/owner action.
- **Precondition — the specialist's repo must run the routing Action, and the dependent fleet must VERIFY it at the delegation boundary** (science #667 review — strengthened from "acknowledged hazard" to "checked precondition"). All cross-fleet routing (delegation @mention → the specialist; review-state / closure events back) goes through `macf-actions` on the **specialist's** repo (`groundnuty/onedata-mcp`). For an (a)-path specialist this is a given (`macf repo-init`'d); a (b)-path specialist gets it from bootstrap. **But the dependent fleet can't see the specialist's repo internals**, so the most likely first-run failure is exactly this: science delegates, the @mention **silently doesn't route** (no routing Action there), and the delegation **strands while science believes "delegated, waiting"** — the worst onboarding silent-fail (a cross-fleet instance of `silent-fallback-hazards.md` Instance 13). So the dependent science-agent **asserts the precondition at delegation time** (Pattern A / `coordination.md` §5(c) gate-sweep, applied cross-fleet, *sender*-side): before relying on @mention routing, confirm the specialist is **registry-resolvable** (`macf routing doctor` / a registry lookup) and, ideally, that the **first** cross-fleet @mention actually routed (a delivery-receipt or a posted ack) — so a missing routing Action surfaces **loud at delegation time**, not as a silent non-delivery. (Pairs with `macf-actions#57`, which is the *receiver*-side cross-fleet reviewer-notify; this is the sender-side check.)

### (b) The specialist is NOT yet a MACF agent

(A plain repo / a non-MACF developer.) The **first step is making it one — via `macf-bootstrap` (DR-035)** — after which it becomes a cross-fleet collaborator per path (a). This is the natural on-ramp: the bootstrap product (which provisions a fleet's GitHub side: per-agent App, channel-server wiring, registry entry) is exactly what turns a plain product repo into a routable specialist agent. **DR-035 enables DR-036** — bootstrap a single-agent "fleet" for the product owner, register it (sharing the consumer's scope makes path (a) free), and the cross-fleet delegation pattern then applies unchanged.

### (c) The specialist is a MACF agent but NOT GitHub-routable (local-mode / operator-identity)

A specialist may already be a working MACF agent that is **deliberately not GitHub-App-scoped** — e.g. a **local-mode (DR-024)** fleet: no GitHub App, a local-CA mTLS mesh on a private host, acting **as the operator** (operator-attributed commits, no `ghs_` bot footprint). This is the **`groundnuty/onedata-mcp` ↔ `ppam-2026` case** (verified 2026-06-30: worked by the local-mode `ppam-2026` code-agent, macf 0.2.21, on a private `127.0.0.1` mesh — the work is the operator-attributed `ppam2026/14-tools` branch, which is why a bot/App fingerprint scan finds nothing yet the repo was demonstrably worked by a fleet agent). Such an agent is **not GitHub-@mention-routable** from the consumer fleet — there is no App, no resolvable shared-scope registry entry, and the channel-server is on a host the consumer can't reach.

**Load-bearing principle (operator, 2026-06-30): the dependent fleet adapts to the specialist's chosen topology; it does NOT require identities/features the specialist deliberately lacks.** Local-mode is a *legitimate, intentional* configuration, not a deficiency to be "fixed." Upgrading such a fleet to the newest macf, or bootstrapping it to App-scoped, is *possible* and the specialist's operator **may** choose it (if they want automated cross-fleet routing) — but **App-scoping is NEVER a precondition the dependent fleet can demand.** So for a (c)-path specialist:

- **Operator-mediated collaboration is a FIRST-CLASS supported mode, not a fallback-because-routing-failed.** The delegation still follows the §1 shape (6-section issue on the specialist's repo → versioned release → consumer pins), but the *transport* is the **operator bridging the two fleets** (relaying the delegation / the result) rather than GitHub-@mention auto-routing. The peer-ownership (§3) and version-contract (§5) are unchanged; only the wake/notify hop differs.
- **Bootstrapping to App-scoped (→ path (a)) is an OPT-IN the specialist's operator may take**, not a requirement — it buys automated routing in exchange for adopting the App identity that fleet deliberately didn't have.
- This is the **peer-dynamic applied to topology**: you don't dictate a peer's identity model any more than you dictate their roadmap. The dependent fleet uses GitHub-routing **if** the specialist is App-scoped (paths a/b), operator-relay **if** it is local-mode (path c) — adapting to the specialist, never the reverse.

## Boundaries (what this does NOT do)

- **Not B2.** No live cross-fleet mTLS `/notify`; no shared or cross-signed CAs between fleets. Collaboration is GitHub-plane delegation + a versioned artifact. B2 is a future option only if continuous live cross-fleet push is ever needed — deliberately deferred, not designed here.
- **The specialist does not relocate** into the dependent fleet. It keeps its repo, roadmap, identity, and registry home.
- **The dependent fleet does not fork or absorb** the product. It depends on a pinned release; it does not vendor a copy it then maintains.
- **Clean per-agent attribution is preserved.** Each party keeps its own App/bot; nobody impersonates anybody across the boundary.
- **The specialist is not a *supervised* member** of the dependent fleet — not an owned member of its registry, not under its DR-031 supervision/reconciliation. It is a guest peer. **(Amendment A: it MAY be *shown* in the consumer's `macf fleet status` as an unsupervised guest — visibility ≠ supervision.)**

## Consequences

- **A reusable playbook** for every consumer fleet that depends on another agent's product — not just `icsoc-2026` ↔ `onedata-mcp`. The pattern is the generalization of substrate-serves-consumers.
- **No new transport / CA machinery** in the common (a) path — it rides existing GitHub-plane routing + existing registry resolution. The cost is a couple of App-installs, not a new protocol surface.
- **DR-035 and DR-036 pair up.** DR-035 (bootstrap) is the on-ramp that path (b) uses to make a plain product repo into a routable specialist; DR-036 is the collaboration pattern that applies once it is.
- **Pairs with a future short use-case recipe** — "inviting a cross-fleet collaborator", a sibling to `use-cases/scientific-paper-fleet.md`, walking the `icsoc-2026` ↔ `onedata-mcp` worked example end-to-end (the App-installs, the delegation issue, the version pin, the verify).

## Open questions

- **The three `onedata-mcp` confirm-these** (Trigger §): is its maintainer already a MACF agent (decides path (a) vs (b))? its routing label / bot handle? its registry scope (same `groundnuty` Profile as `icsoc-2026`, or different — decides whether routing-resolution is free or cross-scope)?
- **Write the use-case recipe now, or after a first real cross-fleet delegation?** A recipe written before the first real run risks the DR-035 prior-art lesson (a spec written ahead of a real run fights the environment); a recipe written after captures what actually happened. Lean: write it after the first `icsoc-2026` ↔ `onedata-mcp` delegation completes.
- **Does `route-by-pr-review-state` cross-fleet reviewer-notify (`macf-actions#57`) need the collaborator in scope?** §4's formal cross-review depends on the specialist's repo routing the review-state event back to the dependent reviewer/gate-owner. The in-flight `macf-actions#57` (notify deliberate review-engagement, not just the PR author — silent-fallback Instance 13) is the mechanism; confirm it resolves cross-fleet reviewers, not only same-fleet ones.

## Routing note (route-now-vs-backlog)

Design-now (capture the pattern while the `icsoc-2026` ↔ `onedata-mcp` dependency is live and the dialogue is fresh — done). The (a) path is implementable today on existing routing + registry; the only build work is per-engagement App-installs. The (b) path sequences behind `macf-bootstrap` (DR-035) availability. Operator's final sequencing call; a first real cross-fleet delegation is the natural trigger for the use-case recipe.

## References

- DR-006 (registry scope: org / profile / repo) — the discovery substrate. Path (a)'s "routing-resolution is free if both share a scope" rests on Profile-scope (`groundnuty/groundnuty`) being one shared registry; cross-account needs cross-scope resolution.
- DR-035 (macf-bootstrap GitHub-provisioning skill) — the on-ramp path (b) uses to turn a plain product repo into a routable specialist agent; DR-035 enables DR-036.
- `.claude/rules/delegation-template.md` — the in-fleet 6-section delegation pattern this DR stretches across a fleet boundary; §"When to delegate" (asymmetric capability — the specialist is the domain expert) is the core justification.
- `.claude/rules/coordination.md` — §Issue Lifecycle 1 (reporter-owns-closure, applied cross-repo), §Communication (@mention routing), §Peer Dynamic (the stance §3 generalizes across fleets).
- `.claude/rules/peer-dynamic.md` — the peer relationship §3 stretches across the fleet boundary (request, push back, decline — not dictate).
- `.claude/rules/gh-token-attribution-traps.md` — the keep-your-own-identity discipline §3 preserves across the boundary (each party posts as its own bot; nobody impersonates across fleets).
- `pr-discipline.md` §"How to submit LGTM" — formal-review state-change routing the (optional) cross-review in §4 rides.
- CLAUDE.md "Routing transport is two-track" + the substrate-serves-consumers framing — the proven instance this DR generalizes.

---

## Amendment A (2026-06-30): guest visibility in the consumer's `macf fleet status` — split visibility from supervision

**Status:** Proposed (amends §3 + §Boundaries). Ratification = operator's call, same as the base DR.

**Trigger:** operator, 2026-06-30 — *"in the ideal situation the external contractor would be shown to the paper-writing fleet on `macf fleet status` … a (maybe temporary) official member of 2 fleets."* Surfaced while wiring the first live cross-fleet collaborator: `ppam-2026/code-agent` ↔ `icsoc-2026` (the `onedata-mcp` data dependency).

### What changes

Base §3 said the specialist *"does not appear in the dependent fleet's `macf fleet status` … and is not supervised by it."* That conflated two separable properties. This amendment splits them:

- **Supervision** (DR-031 liveness / reconciliation / restart / prune) — the consumer fleet **MUST NOT** do this to a guest. It does not own the guest's lifecycle; a consumer reconciler that SIGTERM'd, pruned, or restarted a "down" guest would be acting on an agent another fleet owns. **UNCHANGED: a guest is never supervised by the consumer.**
- **Visibility** (the guest appears in `macf fleet status`) — base §3 forbade this too, but it is safe and valuable: the consumer operator / coordinator seeing the external collaborator it depends on models the real topology. **CHANGED: a guest MAY be shown, clearly marked as external + unsupervised.**

So base §3's clause "does not appear in the dependent fleet's `macf fleet status`" is **superseded**; the "is not supervised" clause **stands**.

### The guest-membership model — asymmetric, two-fleet

A cross-fleet collaborator is:

- a **full member** of its **home** fleet — owned, supervised, lifecycle-managed there (`ppam-2026/code-agent` in ppam);
- a **guest member** of each **consumer** fleet that depends on it — visible, perspectival-role'd, **not** supervised (`onedata-specialist` in icsoc).

This is the operator's "member of 2 fleets," with deliberately **asymmetric** membership (full-home + guest-consumer). Grounded in MOISE+ **group-scoped roles**: an agent adopts different roles in different organizational groups; the consumer fleet is a different group with its own role vocabulary.

### The consumer-side guest binding (perspectival role)

The consumer fleet carries a **local** binding naming the external agent + the role it plays from the consumer's viewpoint. The external agent neither sees nor agrees to it — **topology-autonomy preserved** (a consumer cannot impose membership on a peer; it only annotates its own view).

```jsonc
{
  "guests": [
    {
      "agent": "ppam-2026/code-agent",     // home-fleet/agent; resolves in the shared registry scope
      "local_role": "onedata-specialist",  // the perspectival role (consumer's vocabulary)
      "purpose": "data-access dependency (onedata-mcp)",
      "delegate_via": "route",             // "route" (App-scoped -> GitHub @mention) | "operator-relay" (local-mode/(c))
      "until": null                         // optional expiry -> "temporary" membership; null = open-ended
    }
  ]
}
```

### `macf fleet status` rendering

The consumer's `fleet status` reads the guest binding and renders a distinct **GUEST / external collaborators** block, separate from the fleet's own members:

- the guest's **registry-derived state** (instance_id, cert-expiry, registry-heartbeat freshness) IS shown — resolvable **for free** when the guest shares the consumer's registry scope (`ppam-2026/code-agent` is a `PPAM_2026_AGENT_*` entry in the same `groundnuty` Profile registry `icsoc` reads — *because it was promoted to App-scope via Path-Y*; a pure DR-024 local-mode agent would instead live in its own local-*file* registry, not the shared Profile — see enabler-path (c). So this line is consistent with §(c)/#669, not a contradiction: #669 describes the *pre-promotion* local-mode state, this describes the *post-promotion* path-(a) state);
- the **reachability column is path-aware** (science review, #675): for a **routable (a/b)** guest a live `/health` probe works and is shown; for a **(c) private-mesh** guest a cross-fleet probe is NOT meaningful (it would hit the consumer's own localhost or fail), so reachability renders **"local-mode — home-fleet-observable only"** and **never "down"** — mirroring how `macf#621`'s routing-doctor treats a registry-only agent (resolvable + freshness shown; live-probe n/a). A false "DOWN" is exactly the misleading "is it down? should I restart it?" signal this amendment exists to prevent (even with supervision off);
- the row is marked `guest` and carries its `local_role`;
- the guest is **excluded from DR-031 supervision** — `macf fleet doctor` MAY report its reachability but MUST NOT propose restart / prune / reconcile actions against it (not the consumer's to manage).

### "Temporary"

The binding is a consumer-side annotation: add it when the collaboration is active, remove it (or set `until`) when done. Membership is scoped in time with no change on the guest's side.

### Relationship to the design candidates

This is **design-candidate #2 (perspectival cross-fleet roles)** made concrete — the dual of **candidate #1 (local-mode identity aliasing**, how an agent labels *itself*). #2 is how the *consumer* labels the *external* agent. The two are the who-I-am ⇄ who-you-are-to-me halves of cross-fleet identity.

### Boundaries / non-goals

- **No supervision** of the guest by the consumer (the load-bearing invariant kept from §3).
- **No cross-fleet CA / mTLS** — still B1. Visibility rides the **shared-registry read**, not a live cross-fleet trust path. (A guest in a *non-shared* scope is shown from whatever the consumer can resolve via `macf#621` cross-scope iteration, or as a static binding with no live state if unreachable.)
- **No change to the guest's home-fleet membership.**
- The binding is **consumer-local**; the guest is unaware.

### Build surface (code-agent, additive)

1. A `guests` binding schema + a home for it in the consumer's coordination config / registry.
2. `macf fleet status` reads it + renders the GUEST block (reusing the shared-scope registry resolution that already exists for DR-030).
3. `macf fleet doctor` excludes guests from supervision/reconcile proposals (reachability-report-only).

Small and additive — no protocol change, no new transport.

### Open questions for the build PR

- **Where does the `guests` binding live** — the consumer's coordination-config, or a registry annotation? Lean: **coordination-config** (a perspectival role is a consumer-local fact, not a shared registry fact; the registry is GitHub-Variables-shaped and owned per-agent). Left open for the build PR to settle.
- **`delegate_via` taxonomy** — `route` (App-scoped → GitHub @mention) vs `operator-relay` (local-mode/(c) path). Confirm these two cover the cases, or whether a B2 live-push value is ever needed (out of scope today).
