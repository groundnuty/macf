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

- Is the `onedata-mcp` maintainer **already a registered MACF agent** (registry entry + channel-server + App), or a plain non-MACF repo/developer? *(Decides the (a)-vs-(b) enabler path below.)*
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

Because the specialist **owns its product**, the dependent fleet's delegation is a **request it can prioritize, push back on, or decline** — the `peer-dynamic.md` stance, stretched across fleets. The dependent fleet does **not** dictate the specialist's product or roadmap; it states a need and negotiates. The specialist is a **guest peer, not a fleet member**: it does not take a `code-agent`/`science-agent` label in the dependent fleet's registry, does not appear in the dependent fleet's `macf fleet status`, and is not supervised by the dependent fleet's liveness/reconciliation machinery (DR-031). It is a peer in another fleet that the dependent fleet collaborates with.

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
- **Precondition — the specialist's repo must run the routing Action.** All of the above (delegation @mention → the specialist; review-state / closure events back to the dependent fleet) routes through `macf-actions` on the **specialist's** repo (`groundnuty/onedata-mcp`). For an (a)-path specialist that already operates as a fleet, this is a given (its repo was `macf repo-init`'d). It's called out explicitly because it's the one thing that, if absent, makes cross-fleet routing **silently** not fire — and for a (b)-path specialist it is **part of what bootstrap installs** (see below).

### (b) The specialist is NOT yet a MACF agent

(A plain repo / a non-MACF developer.) The **first step is making it one — via `macf-bootstrap` (DR-035)** — after which it becomes a cross-fleet collaborator per path (a). This is the natural on-ramp: the bootstrap product (which provisions a fleet's GitHub side: per-agent App, channel-server wiring, registry entry) is exactly what turns a plain product repo into a routable specialist agent. **DR-035 enables DR-036** — bootstrap a single-agent "fleet" for the product owner, register it (sharing the consumer's scope makes path (a) free), and the cross-fleet delegation pattern then applies unchanged.

## Boundaries (what this does NOT do)

- **Not B2.** No live cross-fleet mTLS `/notify`; no shared or cross-signed CAs between fleets. Collaboration is GitHub-plane delegation + a versioned artifact. B2 is a future option only if continuous live cross-fleet push is ever needed — deliberately deferred, not designed here.
- **The specialist does not relocate** into the dependent fleet. It keeps its repo, roadmap, identity, and registry home.
- **The dependent fleet does not fork or absorb** the product. It depends on a pinned release; it does not vendor a copy it then maintains.
- **Clean per-agent attribution is preserved.** Each party keeps its own App/bot; nobody impersonates anybody across the boundary.
- **The specialist is not a member** of the dependent fleet's registry / `fleet status` / supervision. It is a guest peer.

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
