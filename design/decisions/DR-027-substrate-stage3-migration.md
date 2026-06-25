# DR-027: Substrate migration to Stage-3 (mTLS channel routing)

**Status:** Accepted
**Date:** 2026-06-25
**Ratified:** 2026-06-25 by the operator (the constitutional gate). Ratification (a) accepts the decision; (b) **releases the canary build** — phase-0 (`macf-auditor-agent` stood up on Stage-3 as canary-zero) + the devops Decision-6 infra expansion (channel-server unit + CA/cert lifecycle + per-agent port map + org-secret/Variable layout), then canary migrations devops → code → science; (c) carries one operator prerequisite — creating the read-only `MACF_ROUTING` App (`metadata:read` + `actions_variables:read`). Stage-2 remains the fallback through each cutover + a 2-month all-green bake, then dropped. The supersession of the permanent-Stage-2-transport stance takes effect on ratification; the `macf#273` never-`macf init` boundary is preserved.
**Trigger:** The "are we mature enough to use our own tool?" review (operator ↔ `macf-science-agent`, 2026-06-25) + `macf-devops-toolkit#90`'s finding that the MACF-project fleet (science/code/devops) runs `macf-actions@v1.3.4` — **Stage-2, SSH+tmux routing** — while the tool itself has shipped through `v3.3.0`: **Stage-3, mTLS channel routing** (a breaking transport change). The substrate is the last Stage-2 holdout: ~5 minor + 2 major versions behind its own product. The operator's *own* documented condition for substrate Stage-3 migration — *"substrate stays Stage-2 until substantial CV-on-Stage-3 work lands first"* (2026-06-08) — **is now met**: the CV consumer deployment has run Stage-3 for months (issue routing, PR routing, and A2A peer-to-peer; A2A e2e verified, trace `819c1586` / `macf#368`).

> **Supersession (explicit, dated).** This DR **supersedes the permanent-Stage-2-*transport* stance** for the MACF-project substrate — recorded as "substrate runs permanent Stage-2 v1.x, actively maintained, not retiring" and rooted in the **2026-04-27 operator directive (`macf#273`)** that substrate workspaces *never run `macf init`* — "**permanent operating state, not deferred**." DR-027 does **not** soft-pedal this as "not really a reversal" (an earlier draft did; corrected per code-agent's #524 review — shipping a soft contradiction in the very DR that enables the doc-vs-directive auditor would be self-undermining). It is a clean supersession, **justified** by the 2026-06-08 precondition now being met, using the same dated-supersession pattern as DR-026 §8 (`macf#523`). **Crucially, `macf#273`'s literal directive survives intact** — see Decision #1: the substrate migrates *transport* via devops hand-wiring, it does **not** become a `macf init` consumer. What is superseded is the *transport permanence*, not the *init-consumership boundary*.

## Context

Per **DR-003** (two communication planes), routing has two stages:

- **Stage-2** — the routing GitHub Action SSHes into the agent VM and `tmux`-injects the prompt (`AGENT_SSH_KEY`); the registry is a committed `.github/agent-config.json` file. This is what the substrate runs today (verified green bidirectionally this session).
- **Stage-3** — the routing Action resolves each agent's **channel-server** `host:port` from the registry and delivers over **mTLS** (`ROUTING_CLIENT_CERT/KEY`, **DR-004**); the registry is **GitHub Variables** (**DR-005/006/007**), read via a dedicated minimal-scope `MACF_ROUTING` App; architecture per **DR-023**.

Two facts make the migration both warranted and low-risk now:

1. **CV proves Stage-3 works** (the operator's migrate-after-CV condition, met). The open trade is *hardened-Stage-2 vs working-but-younger-Stage-3* — not *works vs doesn't*.
2. **The auditor home (`macf-auditor-agent`) is brand-new and Stage-3-native** — no v1 legacy to migrate — so it can validate the entire channel infra greenfield, before any load-bearing agent is touched.

Stage-2 also carries a known fragility this migration retires: the Remote-Control-IPC-blocks-`tmux-send-keys` silent-fallback (`silent-fallback-hazards.md` Instance 3). Channel delivery removes that class for the substrate.

## Decision

1. **Migrate the MACF-project agent homes' routing transport from Stage-2 (SSH+tmux) to Stage-3 (mTLS channels), and drop SSH+tmux once migrated.** **Transport-stage and `macf init`-consumership are separable, and this DR changes only the former.** The *existing* substrate agents (science/code/devops) migrate transport by **devops hand-wiring** (channel-server + certs + registry-Variables) — they do **NOT** become `macf init` consumers, so the `macf#273` boundary holds literally. Only the *greenfield* `macf-auditor-agent` is `macf init`'d (`--role auditor`) — it has no substrate-workbench history to preserve. (Avoids the reading "Stage-3 ⇒ `macf init`," which would contradict #273.)

2. **Channels-for-routing only; the A2A peer-to-peer protocol is NOT enabled yet.** Per the operator's call (mirroring the CV discipline): agents coordinate via **issues**; A2A is used only in **specifically-designed** situations, and none are designed for the substrate yet. A2A enablement is **deferred until a validated use case**. *(Observability is not the blocker — DR-025's comms-ledger already makes A2A observable when it is enabled.)*

3. **Canary sequence: `macf-auditor-agent` (canary-zero, greenfield) → devops → code → science.** The greenfield auditor proves the channel infra at zero migration risk; then the load-bearing agents migrate onto *proven* infra, lowest-routing-load first (devops), then the busy framework queue as a real load test (code), then the orchestrator last (science, highest blast radius). devops owns both ends of cutover-zero/one (the infra it stands up + the consuming agent → tightest debug loop, no cross-agent handoff mid-cutover).

4. **Stage-2 is retained as a fallback through each cutover and a 2-month all-green bake, then removed.** Two transports are maintenance debt; the bake earns the right to drop the old one. (Operator: "if it works well for two months, we drop it.")

5. **The registry moves from the `.github/agent-config.json` file to GitHub Variables** (DR-005/006/007), **repo-scoped** — `registry-api-path = /repos/groundnuty/<repo>` per caller. Each agent's channel-server `host:port` is a repo Variable. *(Correction 2026-06-25: `groundnuty` is a **user account**, not an org — verified, `/orgs/groundnuty` → 404 — so there is no org-level Variable/secret store. The registry is therefore the DR-006 **repo scope**, not org/profile. This matches how the existing routing secrets `AGENT_SSH_KEY`/`TS_OAUTH_*` are already set: per-repo. The v3 router's `registry-api-path` is an overridable input, so this is config, not a blocker.)* (The file may remain but is unread under v3.)

6. **Per-agent Stage-3 infra (devops-owned; resolved with devops on #524):**
   - **Topology:** **per-agent channel-server process, distinct ports, one shared CA** — matches the registry-per-agent-`host:port` model + the one-at-a-time canary (a crash isolates to one agent; no shared-demux single-point-of-failure). All five MACF-project homes (auditor + science/code/devops/writing) co-tenant on `orzech-dev-agents`, so N processes / N ports / 1 CA. *(Canary-zero validates this co-tenant layout directly — the auditor home is confirmed a 5th tenant on `orzech-dev-agents`, not a separate host.)*
   - **Registry host value:** register each channel-server as its **MagicDNS FQDN** `orzech-dev-agents.tail491af.ts.net:<port>` — **not** the `192.168.102.x` LAN IP (unreachable from the GitHub-hosted runner) nor the raw tailnet IP (not the contract). Same FQDN-over-IP lesson DR-004 applied to the obs cluster. (Exact hostname confirmed via `tailscale status` on the agent host at stand-up.)
   - **Certs:** per-agent **server** cert+key on the VM (root-owned, `0600`) under a long-lived shared CA trusted both ends; the **client** `ROUTING_CLIENT_CERT/KEY` (DR-004) as a secret.
   - **Secret placement + rotation:** `ROUTING_CLIENT_CERT/KEY` + `MACF_ROUTING_APP_KEY` are **per-repo secrets** on each of the 4 caller repos (no org-level store on a user account — see Decision #5 correction; `MACF_ROUTING_APP_ID`/`_KEY` already set per-repo 2026-06-25). Rotation re-pushes to the 4 repos (a `for` loop, as used to set them) — the lost "one rotation point" is the cost of the user-account topology, not a blocker. **Asymmetric cadence:** server leaf certs auto-rotate on the VM under the long-lived CA (no GH touch); the client cert rotates on the DR-004 default; the CA rotates only on compromise.
   - v3 caller inputs: `project` (required) + `registry-api-path` (`/repos/groundnuty/<repo>` per caller — NOT the `/orgs/...` default).
   - **devops will draft the full Decision-6 infra expansion** (channel-server unit + CA/cert lifecycle + the per-agent port map + the org-secret/Variable layout) as the post-ratification deliverable feeding phase-0 auditor stand-up.

7. **The dedicated `MACF_ROUTING` App (operator prerequisite).** The v3 router resolves the registry via `gh api .../actions/variables/...`, which the workflow's `GITHUB_TOKEN` cannot read; it mints a short-lived token from a **dedicated, minimal-scope App** (`metadata:read` + `actions_variables:read` only — far less than any agent App). This is structurally required by `agent-router.yml@v3.3.0` (the registry-read step is unconditional); it is the one hard operator passkey action. Least-privilege: a leaked router token reads the registry, nothing more.

8. **Pin `macf-actions@v3.3.0`** (immutable), per the established pin-discipline — Stage-3 routing does not move without an explicit PR per agent.

## Alternatives considered

- **Stay Stage-2 (status quo)** — rejected: the dogfooding gap (substrate doesn't use the layer the tool shipped), the 5+2-version drift, and the operator's migrate-after-CV condition being met.
- **Big-bang all agents at once** — rejected: blast radius on the load-bearing substrate, and it forfeits greenfield validation.
- **A substrate agent (not the auditor) as first canary** — rejected: the new auditor home is greenfield (zero migration risk) → strictly the better first validator than any agent carrying v1 legacy.
- **Enable A2A now** — rejected (operator): no validated use case; it adds a coordination-behavior change on top of a transport migration.
- **Keep Stage-2 permanently in parallel** — rejected: two-transport maintenance debt; bake-then-drop instead.

## Consequences

**Positive.** The substrate finally uses Stage-3 (dogfooding the layer the tool shipped → we catch consumer bugs as consumers); the auditor becomes operational, greenfield; channel delivery retires the RC-IPC-blocks-tmux fragility class (Instance 3) for the substrate; A2A is available the moment a use case is designed; the registry consolidates from the per-repo `agent-config.json` files to per-repo GitHub Variables (repo-scoped — `groundnuty` is a user account, no org store).

**Negative / risk (with mitigations).** Stage-3 is younger than Stage-2 → *canary-zero greenfield proof + per-agent canary + Stage-2 fallback + 2-month bake*. The substrate depends on more MACF machinery (channel-server lifecycle, certs) → *devops owns lifecycle + rotation; version-pin*. Bootstrapping circularity (the substrate running on the product it builds) → *immutable pin + retained fallback through the bake*. This reverses the documented substrate-stays-Stage-2 stance — but that stance's own precondition (CV proves Stage-3) is satisfied.

## Scope

**IN:** the routing transport of the 4 MACF-project agent homes (auditor + science/code/devops), canary-sequenced; registry-as-repo-Variables; the channel-server / mTLS-cert / `MACF_ROUTING` infra.

**OUT / deferred:** A2A peer-protocol enablement (until a validated use case); removing Stage-2 (until the 2-month bake passes); the self-hosted runner (`macf-devops-toolkit#90` — separate low-priority workstream; becomes v3-relevant once an agent is on channels); consumer fleets (CV already on v3).

## Open questions

*(The topology / agent-VM-address / rotation-cadence questions were resolved with devops on #524 and folded into Decision #6.)*

- **Exact channel-server hostname + port map** — confirmed via `tailscale status` on `orzech-dev-agents` at stand-up; carried in devops's Decision-6 infra expansion, not blocking the DR as Proposed.
- **The auditor's first real task post-stand-up** — likely the DR-026 §8 highest-value-early function (promote hard-won infra knowledge from agent memory → project rules) before it siloes.

## References

- DR-003 (communication planes / the stage model) · DR-004 (mTLS auth) · DR-005/006/007 (registry: per-agent Variables, scope, ports) · DR-023 (Stage-3 architecture) · DR-025 (observable coordination / the comms-ledger that makes A2A observable) · DR-026 (the auditor; §8 the dedicated auditor home)
- `macf-devops-toolkit#90` (runner + the version-landscape finding) · `macf#368` (A2A v1.0 e2e on CV, trace `819c1586`) · CV deployment (the Stage-3 proof)
- `silent-fallback-hazards.md` Instance 3 (the tmux-RC fragility this retires for the substrate)
