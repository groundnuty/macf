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

## Amendment A — Cross-fleet guest *addressing* (the second half; `#786`)

**Status:** Accepted (operator-directed 2026-07-05; science-authored design, code-agent implements `#786`). **Corrects the DR-041 record: trust was necessary but not sufficient.** Step 1 (`#785`, v0.2.54) federated *trust* (the multi-CA mTLS bundle) so a cross-fleet guest CAN be reached — but a live test surfaced a **separate addressing gap** the trust layer doesn't touch: the outbound messaging clients can't *address* a cross-project guest at all.

**Trigger (verified, icsoc-2026-science, 2026-07-05):** `notify_peer(to: "ppam-2026/code-agent")` → `{delivered:false, channel_state:"offline", peers_attempted:0}`; `macf-ping ppam-2026/code-agent` → `not found in registry`. **Zero peers *attempted*** — the send never resolved a route. Root cause: `notify_peer`'s `resolveTargetPeers`, `a2a-client.ts` outbound resolution, and the `macf-ping` CLI all resolve `to` **only** against the agent's own-project namespace; none parses a `<project>/<name>` slug. DR-036 gave the STATUS layer cross-project resolution (`parseGuestAgentRef` + home-project keying — why the guest shows in `fleet status`), but the MESSAGING layer never got it.

**The two-layer reality this amendment records:** functional cross-fleet A2A = **trust (Step 1 / `#785`) + addressing (this / `#786`)**. Neither alone suffices.

### Decision A1 — Addressability is gated on `federated_cas` (the single admission gate)

A federated cross-fleet guest is outbound-addressable (`notify_peer` / A2A `message/send` / `ping`) by its `<home-project>/<name>` slug **iff its home project is in `federated_cas`**. This is Pattern-A at the addressing boundary — assert the trust precondition *at resolution* so a non-federated target fails **early + clear**, not **late + cryptic** at the TLS handshake — and it keeps `federated_cas` the single admission gate (consistent with Decision 1's per-fleet-CA all-or-nothing trust). The resolution ladder (drives the "clear error, never silent `peers_attempted:0`" requirement):

1. slug parses + registry slot resolves + home-project ∈ `federated_cas` → **attempt delivery**.
2. slug resolves + home-project ∉ `federated_cas` → **error**: *"guest `<project>/<name>`: home fleet `<project>` not in federated_cas — federate it (DR-041 Decision 1) to message this guest."*
3. slug parses + registry slot missing → **error**: *"guest `<project>/<name>` not found in registry."*
4. not a `<project>/<name>` slug → **unchanged** own-project resolution (regression-protected).

The `guests` binding is **not** a second addressing gate — `federated_cas` alone gates addressing. `guests` stays the **relationship + metadata** layer (DR-036 + `#779`'s `scope_out`/`capabilities`): *consulted* for scope-awareness, never a hard prerequisite (a second, finer gate would contradict the per-fleet all-or-nothing trust model).

### Decision A2 — Addressability is orthogonal to `delegate_via`

`delegate_via` remains the *work-delegation* channel (`route` = GitHub tasking — auditable structured work, the DR-036 model). Direct messaging (`notify_peer`/`a2a`/`ping`) is a different axis, gated on `federated_cas` (trust); `delegate_via` is untouched. Task-delegation-via-GitHub and direct-messaging-via-A2A coexisting is correct, not confusing (different channels, different purposes). **`delegate_via: a2a` is a documented future extension** — once addressing works, delegating *work* over A2A instead of GitHub becomes possible, but that is a separate work-routing decision, NOT built in `#786`.

### Decision A3 — All three call sites, one shared resolver

`notify_peer` + `a2a-client` outbound + `macf-ping` all get cross-project guest resolution (a subset would leave confusing partial capability). All three **reuse `parseGuestAgentRef` + the DR-036 home-project resolver** — one resolution path, no parallel slug-parsing logic (`check-before-propose §4`: the resolver exists; wire the clients into it).

### Non-goals of this Step (deferred, explicitly recorded)

- **`scope_out` surfacing** — deferred until `#779` ships the `scope_out`/`capabilities` fields on `GuestBinding` (currently backlog). This Step gates purely on `federated_cas`; scope-awareness wires in when the fields exist. The addressing gate is complete without it.
- **Secrets over A2A** — the encrypted+authenticated A2A/mTLS channel is *why* this matters for sending secrets to a guest (GitHub issue text is plaintext — never secrets there), and it is the direct enabler of the icsoc→ppam secure channel the operator needs. But **secret-*handling* over A2A** (no-log-body, age-vault reuse, trace-redaction) is its own design, filed as a separate follow-up — an explicit non-goal of the addressing Step.

## Amendment B — Fleet-level trust: declare once, all agents inherit (`#810`)

**Status:** Accepted (operator-directed 2026-07-05, `#810` — *"declare once that the entire fleet trusts someone"*; design settled + peer-endorsed on-thread 2026-07-05; science-authored; code-agent implements v1).
**Trigger (verified live, 2026-07-05):** Decision 1's `federated_cas` is declared **per agent** (each agent's `.github/macf-fleet.json`), so federating a guest with a host fleet requires N per-agent edits + N relaunches — and the per-agent model made a **half-federated fleet silent**: the `ppam-2026/code-agent` guest could A2A `icsoc-2026/science-agent` (federated) but got a **false "offline"** from `icsoc-2026/code-agent` — up and serving, but `federated_cas: null` (guest-*bound* yet not *federated*), rejecting the guest's client cert at the mTLS handshake (`tls_client_error: socket hang up`). Federation had been set on one agent and not its sibling; nothing surfaced the asymmetry. This is the **trust ⊥ binding** decoupling (Amendment A / `#786`) biting when the *trust* axis is per-agent: binding is correctly per-agent; trust is a **fleet-level** property and belongs at fleet scope.

### B1 — Declaration home: the shared-registry variable `<PROJECT_SEG>_FEDERATED_CAS`

A fleet declares its federated trust **once**, as a registry variable (DR-006 profile scope — the same namespace as `<PROJECT>_CA_CERT`): e.g. `ICSOC_2026_FEDERATED_CAS = ["ppam-2026"]`. Every agent of that project reads it at channel-server startup and unions it into the trust bundle. **NOT a fleet-config file:** there is no "fleet repo" (every agent owns its own home repo), so a canonical fleet file would need one repo anointed as authoritative — recreating the per-repo drift this amendment eliminates. Per-agent HOME config (`macf-fleet.json`) holds an agent's *own* identity + bindings; **fleet-shared state belongs in the registry** (`check-before-propose §4`: the state has a home).

### B2 — Reload semantics: relaunch-to-apply (v1); live reload is the v2 tier

The trust bundle builds at startup (`#785`), so **v1 = set the variable + relaunch the fleet's agents**. Crucially, **v1 already fixes the correctness bug**: the *declaration* becomes 1 (not N per-agent edits), so a fleet cannot be asymmetrically federated; the relaunches are operational cost, not a correctness surface (the silent asymmetry lived in the N config edits). A **reload path** (poll the variable + rebuild the `ca:` bundle without relaunch) is the **Decision-1c Tier-v2 enhancement** — it composes with the `#783` bundle-endpoint poller; do not build it in v1.

### B3 — Precedence: UNION, never override (the load-bearing safety call)

The effective trust set = **fleet-level declaration ∪ per-agent `federated_cas`**. Trust is monotonic-additive: a per-agent entry may **raise** an agent's trust above the fleet floor (this agent also trusts an extra project), **never lower it**. If per-agent config could *override* the fleet set, an agent's local list would silently drop fleet trust — reintroducing the exact asymmetry this amendment kills. **Pattern-B property (`silent-fallback-hazards.md`): union makes a half-federated fleet *unrepresentable***, not merely detectable — every agent inherits the floor by construction, so no doctor-check for "half-federated" is needed; the design eliminates the failure mode rather than policing it.

### Compositions (recorded deliberately)

- **CA-rotation blast radius (`#800` / Instance 16): neutral-to-positive.** `<PROJECT_SEG>_FEDERATED_CAS` is a *project-name list*, not a CA copy (the guest CAs already live in the registry as `<GUEST>_CA_CERT`) — zero new out-of-band CA copies, and it removes the per-agent `federated_cas` drift surface. Combined with `macf-actions#66` (router reads the own-CA from the registry), the registry becomes the **single source of all federation state**: own-CA, federated-trust list, federated CA certs — the smallest possible rotation blast radius.
- **Trust ⊥ binding preserved:** `guests` stays per-agent HOME config (who this agent collaborates with + the `#779` metadata); trust moves to fleet-registry scope. The two axes remain orthogonal — the trust axis simply can no longer be set asymmetrically.
- **The unifying principle (three facets, one lesson):** *cross-fleet state must be registry-sourced and fleet-complete — never per-repo / per-agent-config-limited.* Facet 1: A2A addressing (Amendment A — resolve guests from the registry, not own-project config). Facet 2: CA trust (this amendment). Facet 3: GitHub mention-routing (`macf-actions#67` — `route-by-mention` must resolve cross-fleet targets from the shared registry, not the local `agent-config.json`; the reverse-direction cousin of Amendment A, filed as its sibling). Each incident in this family was the same lesson surfacing on a different mechanism.

### Implementation (v1, code-agent — `#810`)

Channel-server startup: read `<PROJECT_SEG>_FEDERATED_CAS` from the shared registry (reusing the exact `#785` registry-read path — one more variable read), **union** with the per-agent `macf-fleet.json` `federated_cas`, feed the result to `buildTrustBundlePem` (fail-loud semantics unchanged: any *declared* project whose CA is unresolvable still refuses a partial bundle). Technically independent of `macf-actions#66` (different component, different variable): ship standalone if the asymmetry bites again, else batch with #66 for the registry-single-source coherence.

## References
- DR-036 Amendment A (`#679`) — the cross-fleet guest primitive this extends.
- DR-006 — profile-scope registry (shared discovery, per-project CA namespaces).
- DR-010 — per-fleet CA + challenge-response `/sign`.
- `#779` — GuestBinding metadata enrichment (subsumed by Decision 2 card-sourced capabilities).
- `#780` — the research delegation issue.
- `#783` — the v2 bundle-endpoint + poller (Decision 1c Tier v2, documented/backlog).
- `#784` / `#785` — Step 1: the multi-CA trust bundle (v0.2.54, shipped).
- `#786` — Amendment A: cross-fleet guest *addressing* (the second half; outbound `<project>/<name>` slug resolution).
- `#810` — Amendment B: fleet-level trust declaration (`<PROJECT_SEG>_FEDERATED_CAS`, union-never-override).
- `macf-actions#66` / `macf-actions#67` — the registry-single-source siblings (router reads own-CA from registry; route-by-mention resolves cross-fleet targets from registry).
- `macf-science-agent:research/2026-07-04-cross-fleet-trust-federation-dr041-sota.md` — the SOTA study grounding this design (26 sources, 22/25 claims verified; full source list + per-claim votes).
- SPIFFE Federation: https://spiffe.io/docs/latest/spiffe-specs/spiffe_federation/ · `github.com/spiffe/spiffe/blob/main/standards/SPIFFE_Federation.md` · IETF `draft-ietf-oauth-spiffe-client-auth-02`.
- A2A protocol (v1.0, Linux Foundation) Agent Cards + discovery: https://a2a-protocol.org/latest/specification/ · https://a2a-protocol.org/latest/topics/agent-discovery/
- AGNTCY / Internet of Agents Directory (forward-compat topology validation): https://docs.agntcy.org/dir/trust-model/
