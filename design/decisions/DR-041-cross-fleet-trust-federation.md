# DR-041: Cross-fleet trust federation (collaborator agents across fleet-CA boundaries)

**Status:** **Accepted** (operator-ratified 2026-07-04). Grounded in science's independent state-of-the-art study. Plane-1 rollout tier (Decision 1c) is **v1 = static committed multi-CA bundle** (operator direction 2026-07-04); the endpoint tier is documented as **v2** (backlog `#783`). code-agent implements, starting with Step 1 (the live icsoc↔ppam `offline → reachable` validation).
**Date:** 2026-07-04 (refined 2026-07-04 post-research)
**Trigger:** Registering `ppam-2026/code-agent` as a cross-fleet **guest** of the icsoc-2026 fleet (DR-036 Amendment A, live 2026-07-04) surfaced the limitation cleanly: a guest whose home fleet has a **different per-fleet CA** resolves + is discoverable + is GitHub-taskable, but reads **`offline`** in the consumer's `fleet status` because the consumer's channel-server validates incoming mTLS client certs against **its own single CA only** (`https.ts:359` `ca: readFileSync(config.caCertPath)` + `rejectUnauthorized: true`). The operator wants **trust across fleets without regenerating or redistributing agent certificates** — keep each fleet's own CA (isolation is a feature), but let fleet A genuinely trust + reach a collaborator from fleet B.
**Research:** `macf-science-agent:research/2026-07-04-cross-fleet-trust-federation-dr041-sota.md` — independent `deep-research` pass (26 sources → 25 claims 3-vote-verified → 22 confirmed / 3 refuted / 0 unverified). Delegation issue `#780`. The study **corroborated** the initial two-plane direction and **superseded one mechanism** (JWS-signed cards → lighter provenance, Decision 3); the design below reflects the corrected result.

## Context — two forces, again in tension

1. **Per-fleet CA isolation is deliberate + good.** Each project/fleet has its own CA namespace (`<PROJECT>_CA_CERT` / `_CA_KEY_ENCRYPTED` in the shared profile registry per DR-006). A compromised or retired fleet doesn't taint others; blast radius is bounded. We do NOT want to collapse this into one global CA.
2. **Cross-fleet collaboration is now a real, live use case.** DR-036 Amendment A gave the consumer-side **guest binding** (`.github/macf-fleet.json`), and it works for **discovery** (shared profile registry) + **tasking** (GitHub issue/@mention routed through the guest's *own* fleet router). What it does NOT give is **direct mTLS trust** — so the consumer can't health-probe or directly `/notify` the guest; the guest reads `offline` (its liveness is only inferrable from the registry heartbeat).

DR-036 is the **binding** layer (who depends on whom). This DR adds the missing **trust + capability-exchange** layer so a cross-fleet collaborator is a first-class, reachable, capability-described peer — without touching the per-fleet-CA model.

**Key finding of the research: only Plane 1 is actually a gap.** The reachability problem is 100% a CA-trust gap; Plane 2 (discovery/capability) is already solved by MACF's existing A2A-conformant stack (see Decision 2).

## What MACF already has (≈80%)

| Piece | Status |
|---|---|
| Per-fleet CA + challenge-response `/sign` (DR-010) | ✅ have (keep) |
| AgentCard w/ capabilities (`skills`+`tags`) + mTLS security scheme | ✅ have (`agent-card.ts`) |
| Shared profile-registry discovery (DR-006) | ✅ have |
| DR-036 guest binding (consumer-side) | ✅ have (live) |
| A2A inbound/outbound `message/send` (Phase 2–3) | ✅ have |
| **Multi-CA trust bundle** (federation) | ❌ gap — `ca:` single → array (Decision 1) |
| **Provenance** on the exchanged card+bundle | ❌ add a lighter detached-sig / Sigstore check (Decision 3) — NOT JWS |
| **Invitation export/import** flow (skill) | ❌ the paste-able handshake (Decision 4) |
| Bundle **rotation/revocation** propagation | ❌ `revoked_keys` + short-lived certs (Decision 5) |

## Decision

Adopt the **SPIFFE Federation *pattern*** for trust — exchange public CA bundles between fleets that each keep their own CA — **without deploying any SPIFFE/SPIRE infrastructure.** The SPIFFE Federation spec itself blesses this "consume-the-bundle, skip-the-infra" path (a workload may "directly fetch the customer's trust domain bundle... obviating the need to commit to a full-blown SPIFFE deployment"). The honest recommendation: **adopt the pattern, not the infra.** It satisfies all three operator values — industry-standard/forward-compatible (it is exactly the Linux-Foundation AGNTCY "Internet of Agents" Directory topology: each org runs its own CA + exchanges trust bundles), simple/low-maintenance (a small additive code change, no PKI control plane to babysit), and scientifically grounded (matches the trust-anchor-set model in the current agent-identity literature).

### Decision 1 — Plane 1 (trust / mTLS): multi-CA trust bundle via the `ca`-array

**1a. Mechanism.** Make the channel-server's TLS `ca` a **bundle (array) of CAs** — `ca: [ownCA, ...federatedCAs]` — instead of the single `ca: readFileSync(oneCA)` at `https.ts:359`. Node's TLS validates a peer cert against the array with **any-of-N** semantics (authorized if the peer chains to *any* supplied CA). Admitting a guest fleet's CA is therefore **purely additive**: it extends trust to that fleet's agents, has zero effect on home-CA validation, and requires **zero certificate regeneration**. A guest whose CA is in the bundle flips `offline → reachable`.

**1b. Two implementation invariants (from the research caveats — MUST hold):**
- **Server-verifies-client empirical confirm (Step-1 gate).** The verbatim Node docs quote describes *client*-verifies-server; MACF needs *server*-verifies-client (mTLS). The mechanism is symmetric, but that is inference-from-symmetry — so Step 1 MUST assert that `requestCert: true` + `ca: [ownCA, foreignCA]` actually accepts a foreign-CA client cert before the model is called validated (a Pattern-A verify-the-instrument check).
- **The bundle is the complete allow-list.** Specifying `ca` **replaces** Node's default Mozilla root store (desired for private-CA fleets), so the multi-CA array must carry **every** CA the channel-server intends to trust — no silent fallback to system roots.

**1c. Rollout tier — DECIDED (research Open-Q 1; operator direction 2026-07-04).** The same trust model has two automation tiers; static forecloses nothing (the endpoint is a later drop-in enhancement, not a different design):
- **Tier v1 — static committed multi-CA bundle. ✅ CHOSEN (ship this).** Concatenate home-CA + guest-CA into the channel-server `ca` array; re-commit on the (rare) rotation. Simplest / lowest-maintenance, fits today's topology (a handful of own fleets, long-lived CAs, rare rotation), and forecloses nothing since it's the same SPIFFE trust model.
- **Tier v2 — well-known bundle *endpoint* + poller. DOCUMENTED, not built yet** (backlog `#783`). Each fleet publishes its CA bundle at a well-known URL; peers poll (SPIFFE default cadence = the bundle's `spiffe_refresh_hint`, 5 min if unset) for rotation-awareness. The standards-aligned target — adopt when we federate many/external fleets or rotation toil becomes real.

### Decision 2 — Plane 2 (discovery / capability): no new standard needed

MACF's existing stack is already **A2A v1.0-conformant** and needs no additions for discovery/capability:
- **A2A does NOT standardize a registry** (confirmed 3-0) → MACF's shared profile registry (DR-006) is a valid project-level choice A2A neither prescribes nor constrains. Keep it.
- **`MutualTlsSecurityScheme`** is a first-class A2A card-advertised security scheme; MACF already emits it (`agent-card.ts`).
- **Capability-based discovery** via AgentCard `skills`/`tags` is A2A-native; MACF already emits these.

**This subsumes `#779`** (GuestBinding metadata enrichment): a guest's `capabilities` (and `tasking_repo` / `scope_out`) become **sourced from its published AgentCard at admission** rather than hand-typed. #779's fields stay as the *schema*; their *source* becomes the card.

### Decision 3 — Provenance: lighter than JWS-signed cards

**Do NOT adopt the A2A "JWS-signed AgentCard" mechanism.** The research **refuted (0-3)** the claim that A2A v1.0 defines signed AgentCards via JWS-JSON with standard protected-header key-resolution — so signed-card provenance is less standardized than the initial pass assumed. Instead use a **lighter provenance check**: a **plain detached signature** (or a Sigstore attestation, as AGNTCY uses — the keyless-OIDC / GitHub-Actions-token / self-managed-Cosign spectrum) over the published `{card + CA-bundle}`. The verifier checks the signature before trusting the bundle. No bespoke JWS card plumbing.

### Decision 4 — Invitation handshake: collaborator-publishes, home explicitly admits

**Direction: collaborator-publishes-{signed-card + CA-bundle}**, home fleet makes an **explicit, out-of-band, manual admission decision** (adds the CA to its trust-anchor set). NOT fleet-issues-invitation-token. Every standard surveyed models cross-domain trust as a **policy decision, not a protocol constraint** (a Node `ca`-array *is* a trust-anchor set). Matches the intuitive "ask the collaborator for a paste-able block, paste it into the consumer fleet" flow; bidirectional trust = both publish.

**Bootstrap trust root (research Open-Q 2):** the very-first bundle fetch is anchored over a channel the guest is **already trusted on** — the **GitHub-taskable path** (the guest is already a registered DR-036 guest, reachable + attributable via GitHub routing), or a GitHub-OIDC/Sigstore attestation. This anchors admission without the fleets needing public Web-PKI certs.

**No capability token for admission** (macaroon/JWT/VC NOT warranted): the mTLS handshake + card-declared skills already scope capability, and short-lived certs (Decision 5) provide the blast-radius cap a macaroon caveat would add. *(Deferred, not rejected: if per-guest capability **enforcement** at the trust boundary is ever needed — vs the current all-or-nothing-per-fleet admission — a capability token re-enters scope. Tracked below.)*

### Decision 5 — Rotation / revocation: advance-publish + revoked-keys + short-lived certs

At minimum-viable complexity (there is **no** real-time per-credential revocation in any surveyed standard — an accepted limitation that matches MACF's existing bounded-blast-radius rationale):
- **Rotation:** publish new keys **in advance** (SPIFFE-recommended 3–5× the refresh hint under Tier v2; a deliberate re-commit-then-notify under Tier v1) with **overlapping validity windows**; remove deprecated keys only after no valid certs remain under them.
- **Revocation:** authority-key-level (drop a signing key → its certs invalid) + a **`revoked_keys` list** published at the fleet's endpoint (Tier v2) or committed (Tier v1), checked before accepting an identity, **backstopped by short-lived certs**.
- **Open-Q 4 for the operator:** what max cross-fleet-guest cert TTL is acceptable, and does the per-fleet CA already issue short-lived enough certs, or would guest-admission need a shorter-TTL issuance profile?

## Incremental path (validated by the research)

1. **Step 1 — prove the model (smallest change):** make `ca:` a bundle + manually add the collaborator fleet's CA → the **live icsoc↔ppam guest flips `offline → reachable`, zero cert regen.** MUST include the Decision-1b server-verifies-client empirical confirm. This is the minimum-viable validation of the whole DR.
2. **Step 2 — invitation flow:** a collaborator-side skill emits `{signed card + CA bundle}` (Decisions 3/4); a consumer-side skill imports it (federate the CA into the `ca` bundle + auto-fill DR-036 guest metadata **from the card**, subsuming #779).
3. **Step 3 — rotation-awareness (Tier v2, only if chosen/needed):** the well-known bundle endpoint + poller + `revoked_keys` list.

## Open questions (post-ratification / non-gating)

- **Decision 1c — the rollout tier** — ✅ RESOLVED: v1 = static committed bundle (operator 2026-07-04); endpoint = documented v2, backlog `#783`.
- **Decision 5 — max guest-cert TTL** + whether the per-fleet CA already issues short-lived enough certs. *(Refine at implementation time; not gating ratification.)*
- **Capability enforcement (not just discovery) at the trust boundary** — deferred; a macaroon/JWT token would re-enter scope only if per-guest skill/action restriction becomes a need (current model: all-or-nothing per fleet).

## Honest caveats (carried from the research)

- **Time-sensitivity:** SPIFFE Federation + Node TLS are stable primary standards; but `draft-ietf-oauth-spiffe-client-auth` is an active IETF draft (-02), A2A registry-standardization is explicitly "future community exploration," and AGNTCY is actively evolving.
- **Scientific anchor strength:** arXiv 2601.14567 ("Agent Identity URI Scheme") is a single-author, non-peer-reviewed preprint — used as principle-level corroboration, not authority.
- **Coverage honesty:** ANP / Agora / MCP-side identity / macaroons were surveyed but produced no surviving verified claims — treat as "insufficient verified signal in-window," NOT "evaluated and rejected."
- **Three load-bearing refutations (0-3)** shaped this design: JWS-signed-cards (→ Decision 3 lighter provenance), "AGNTCY coupled to full SPIRE" (→ reinforces pattern-not-infra), and "SPIFFE requires a manual `spire-server bundle` static exchange" (→ the out-of-band bootstrap requirement stands, but not that specific mechanism).

## Decision status

**Accepted (operator-ratified 2026-07-04).** The concrete mechanism (Decisions 1–5), the rollout tier (D1c = v1 static bundle), and the incremental path are all settled. code-agent implements, starting with Step 1 (the live icsoc↔ppam `offline → reachable` validation) — subject to the usual PR feasibility review + merge of `#782`.

## References
- DR-036 Amendment A (`#679`) — the cross-fleet guest primitive this extends.
- DR-006 — profile-scope registry (shared discovery, per-project CA namespaces).
- DR-010 — per-fleet CA + challenge-response `/sign`.
- `#779` — GuestBinding metadata enrichment (subsumed by Decision 2 card-sourced capabilities).
- `#780` — the research delegation issue.
- `#783` — the v2 bundle-endpoint + poller (Decision 1c Tier v2, documented/backlog).
- `macf-science-agent:research/2026-07-04-cross-fleet-trust-federation-dr041-sota.md` — the SOTA study grounding this design (26 sources, 22/25 claims verified; full source list + per-claim votes).
- SPIFFE Federation: https://spiffe.io/docs/latest/spiffe-specs/spiffe_federation/ · `github.com/spiffe/spiffe/blob/main/standards/SPIFFE_Federation.md` · IETF `draft-ietf-oauth-spiffe-client-auth-02`.
- A2A protocol (v1.0, Linux Foundation) Agent Cards + discovery: https://a2a-protocol.org/latest/specification/ · https://a2a-protocol.org/latest/topics/agent-discovery/
- AGNTCY / Internet of Agents Directory (forward-compat topology validation): https://docs.agntcy.org/dir/trust-model/
