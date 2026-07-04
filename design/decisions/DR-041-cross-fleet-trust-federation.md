# DR-041: Cross-fleet trust federation (collaborator agents across fleet-CA boundaries)

**Status:** Proposed (operator-directed brainstorm 2026-07-04; code-agent scopes this proposal + the candidate direction; **science owns the state-of-the-art research + authorship toward ratification**; design specifics are GATED on that research — see the Research Task section + the delegation issue). Not ratified — Proposed→Accepted is the operator's call after science's research + design land.
**Date:** 2026-07-04
**Trigger:** Registering `ppam-2026/code-agent` as a cross-fleet **guest** of the icsoc-2026 fleet (DR-036 Amendment A, live 2026-07-04) surfaced the limitation cleanly: a guest whose home fleet has a **different per-fleet CA** resolves + is discoverable + is GitHub-taskable, but reads **`offline`** in the consumer's `fleet status` because the consumer's channel-server validates incoming mTLS client certs against **its own single CA only** (`https.ts:359` `ca: readFileSync(config.caCertPath)` + `rejectUnauthorized: true`). The operator wants **trust across fleets without regenerating or redistributing agent certificates** — keep each fleet's own CA (isolation is a feature), but let fleet A genuinely trust + reach a collaborator from fleet B.

## Context — two forces, again in tension

1. **Per-fleet CA isolation is deliberate + good.** Each project/fleet has its own CA namespace (`<PROJECT>_CA_CERT` / `_CA_KEY_ENCRYPTED` in the shared profile registry per DR-006). A compromised or retired fleet doesn't taint others; blast radius is bounded. We do NOT want to collapse this into one global CA.
2. **Cross-fleet collaboration is now a real, live use case.** DR-036 Amendment A gave the consumer-side **guest binding** (`.github/macf-fleet.json`), and it works for **discovery** (shared profile registry) + **tasking** (GitHub issue/@mention routed through the guest's *own* fleet router). What it does NOT give is **direct mTLS trust** — so the consumer can't health-probe or directly `/notify` the guest; the guest reads `offline` (its liveness is only inferrable from the registry heartbeat).

DR-036 is the **binding** layer (who depends on whom). This DR adds the missing **trust + capability-exchange** layer so a cross-fleet collaborator is a first-class, reachable, capability-described peer — without touching the per-fleet-CA model.

## Candidate direction (from an initial code-agent research pass, 2026-07-04 — to be verified/superseded by science's study)

Two **separate planes**, each with a mature industry standard we should aim to adopt for durability + compatibility:

### Plane 1 — Trust (mTLS): SPIFFE-style trust-bundle federation
The canonical "trust across independent CAs without re-issuing certs" pattern is **trust-bundle exchange** (SPIFFE Federation; IETF `draft-ietf-spiffe-federation`). Domains exchange **public CA bundles** — never private keys, never re-issued certs. Each side adds the other's CA to its trust store; mTLS then validates the foreign fleet's certs. Bundles are re-fetched periodically so rotation/revocation propagate.
- **MACF lever is one line:** the channel-server's `ca:` is a single CA today; Node's TLS `ca` accepts an **array/bundle**, so `ca: [ownCA, ...federatedCAs]` *is* this pattern. A guest whose CA is in the bundle flips `offline → reachable` with **zero cert regeneration**.

### Plane 2 — Discovery + capability: A2A v1.0 Signed Agent Cards
The "collaborator hands you a paste-able message describing its capabilities" instinct is exactly an **A2A Agent Card**. A2A (v1.0, Linux Foundation, 2026) added **Signed Agent Cards** — a cryptographic signature so the receiver can verify the card was issued by the domain owner (A2A's decentralized-discovery trust model). A2A does **not** standardize an agent registry (still application-level) — so our profile-registry stands as our discovery layer.
- **MACF already emits an AgentCard** (`agent-card.ts`) with `skills` (id/name/description/**tags** = capabilities) + a **`MutualTlsSecurityScheme`**. Missing: **signing** it, and **exchanging** it as an invitation.

### Handshake direction
Industry pattern: the trust anchor flows **trusted → truster**. The **collaborator publishes** {signed Agent Card (capabilities + endpoint) + its CA public bundle}; the **consumer fleet imports + authorizes** it (federate the CA + register the DR-036 guest binding + optionally append operator task-context). This matches the intuitive "ask the collaborator for a paste-able block, paste it into the consumer fleet" flow. Bidirectional trust = both publish.

## What MACF already has (≈80%)

| Piece | Status |
|---|---|
| Per-fleet CA + challenge-response `/sign` (DR-010) | ✅ have (keep) |
| AgentCard w/ capabilities (`skills`+`tags`) + mTLS security scheme | ✅ have (`agent-card.ts`) |
| Shared profile-registry discovery (DR-006) | ✅ have |
| DR-036 guest binding (consumer-side) | ✅ have (live) |
| A2A inbound/outbound `message/send` (Phase 2–3) | ✅ have |
| **Multi-CA trust bundle** (federation) | ❌ gap — `ca:` single → array |
| **Signed** AgentCard (A2A v1.0) | ❌ card exists; add signature + verify |
| **Invitation export/import** flow (skill) | ❌ the paste-able handshake |
| Bundle **rotation/revocation** propagation | ❌ open (SPIFFE re-fetches; we're registry-based) |

## Candidate incremental path (to be validated by the research/design)
1. **Prove the model:** make `ca:` a bundle + manually add the collaborator fleet's CA → the live icsoc↔ppam guest flips `offline → reachable`, zero cert regen. (Smallest change; validates Plane 1.)
2. **Invitation flow:** a **collaborator-side skill** emits {signed Agent Card + CA bundle} as a paste-able block; a **consumer-side skill** imports it (federate CA + auto-fill the DR-036 guest metadata **from the card's capabilities** — which subsumes the #779 enrichment, sourced from the card instead of hand-typed).
3. **Signed cards + rotation:** verify card provenance before trusting its CA; periodic bundle re-fetch for rotation/revocation.

## Open questions (the research must resolve these)
- **Federation mechanism:** SPIFFE bundle-**endpoint** (live-fetched, rotation-aware) vs a **static** committed bundle (simpler, but manual rotation)? What's the simplest form that still handles rotation/revocation safely?
- **Signed Agent Cards:** adopt A2A v1.0 signing? Key management + verification path? Is it worth the complexity vs a lighter provenance check?
- **Invitation direction + artifact:** collaborator-publishes-card vs fleet-issues-invitation-token — which is the cleaner primary, and is a capability token (macaroon/JWT) warranted, or does the signed card + CA bundle suffice?
- **Simplicity vs standards:** the full SPIFFE/SPIRE stack is heavy — adopt the **protocol/pattern** (bundle exchange) without the infra? Where's the line between "compatible with the standard" and "don't build a PKI we have to babysit"?
- **Alternatives to survey:** other agent-identity/trust schemes surfacing in the literature (e.g. ANP, Agora, agntcy trust-model, attested-identity/delegation-contract work) — do any fit better or subsume A2A for our case?

## Research Task — DELEGATED to science (state-of-the-art study; gating this DR)
Per operator direction (2026-07-04): science runs an **independent state-of-the-art research workflow** (do NOT just inherit code-agent's initial pass above — corroborate or supersede it), covering the **last ~2–3 months** of movement, then documents the research + reports a **summary in the delegation issue**, and authors/refines this DR toward ratification. Operator's standing values to weight:
1. **Adopt industry standards** — so MACF stays compatible with whatever emerges (A2A, SPIFFE, successors).
2. **Simple, clever, low-maintenance** — minimize what we have to debug/babysit; prefer a small correct mechanism over a heavyweight PKI/infra.
3. **Scientific-literature awareness** — be conscious of relevant conference/journal work on cross-domain agent identity, trust, and capability discovery.

Delegation issue: **#780** (`research(DR-041): state-of-the-art study — cross-fleet trust federation`).

## Decision
**DEFERRED pending science's state-of-the-art research + design.** This DR frames the problem, the candidate two-plane direction (SPIFFE-style trust-bundle federation + A2A signed agent cards), and the open questions. The concrete mechanism, the incremental-path validation, and ratification follow science's study. code-agent implements once the shape is ratified.

## References
- DR-036 Amendment A (`#679`) — the cross-fleet guest primitive this extends.
- DR-006 — profile-scope registry (shared discovery, per-project CA namespaces).
- DR-010 — per-fleet CA + challenge-response `/sign`.
- `#779` — GuestBinding metadata enrichment (subsumed by Plane-2 card-sourced capabilities).
- SPIFFE Federation: https://spiffe.io/docs/latest/spiffe-specs/spiffe_federation/ · IETF `draft-ietf-spiffe-federation`.
- A2A protocol (v1.0, Linux Foundation) Agent Cards + Signed Agent Cards: https://a2a-protocol.org/latest/topics/agent-discovery/
