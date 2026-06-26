# DR-030: `macf fleet` + `macf routing` — the three-layer interconnect health model

**Status:** Accepted
**Date:** 2026-06-26
**Ratified:** 2026-06-26 by the operator ("DR-030 ok"). Establishes the `macf fleet` (mesh) + `macf routing` (plane) **three-layer interconnect health model** — Self (`macf doctor`) / Mesh (framework) / Routing-infra (routing-infra), with per-layer ownership, the delivery-proof ladder (passive-local → `--inject` → e2e), and the topology-agnostic GitHub-shared-plane constraint with named registry/CA scope boundaries. Folds the `#564` check catalog. Build is layer-phased (phase 1 mesh, phase 2 routing-infra), code-agent.
**Trigger:** The 2026-06-26 Stage-3 routing outage — science-agent silently received zero routed issues for a full session because `groundnuty/macf`'s caller was stuck `@v1.3.4` while science was on Stage-3 channels, compounded by an `agent-config.json` session-name mismatch that silently killed the Stage-2 fallback. Every root cause was an invisible-until-broken interconnect-health gap that took manual cross-repo archaeology to find. Operator-directed (`macf#560`); concrete checks harvested as `macf#564`. This DR is the synthesis of code-agent's seed (`#560`), science-agent's review, devops-agent's ops review, and an operator design review (the three-layer sharpening).

## Context

The CLI operates at scopes that map to **distinct health questions with distinct owners** — and only the first is currently answered:

| Layer | Question | Command | Owner |
|---|---|---|---|
| **Self** | Is *this* agent configured + healthy? | `macf doctor` (exists, DR-019/028) | each agent |
| **Mesh / peer** | Can agents reach *each other* — channels, messaging, delivery — **independent of** the GitHub routing plane? | `macf fleet doctor` (**new, phase 1**) | framework |
| **Routing-infra** | Is the GitHub *delivery plane* wired right — caller pins, registry-as-routing-source, certs, repo-set? | `macf routing doctor` (**new, phase 2**) | routing / infra |

`macf doctor` is the single-agent check; **no command answers the mesh or routing-plane questions today**, and the fleet-reasoning commands that exist (`registry prune`) are scattered. `macf#564` catalogued the specific checks the outage proved necessary; this DR is their home, distributed across the two new layers.

## Decision

Introduce **two new scope-parallel namespaces**, one per layer, with a clean ownership cut:

```
# Mesh layer (framework-owned) — the agents + their direct channel mesh:
macf fleet status            roster + LIVE health + idle/busy
macf fleet ping <agent>      one peer, detailed
macf fleet doctor            mesh interconnect test (Reachable + Accepted + passive-Processed)
macf fleet doctor --inject   synthetic Processed round-trip (idle-agent fallback)
macf fleet prune             confirmed-dead cleanup (moved from `registry prune`; alias 1 cycle)

# Routing-infra layer (routing/infra-owned) — the GitHub delivery plane that CARRIES the agents:
macf routing doctor          plane wiring: caller-pins + registry-correctness + certs + repo-set
macf routing doctor --e2e    the full round-trip proof (formalizes e2e.yml)
```

**Design principle — scope-parallel verbs:** `macf <verb>` (self) / `macf fleet <verb>` (mesh) / `macf routing <verb>` (plane) share verbs (`status`, `doctor`); the **layer** is the axis. **Why three commands, not one:** the layers cut by *what's checked* **and** *who owns it* — routing is the *plane that carries* the agents; `fleet` is *the agents and their direct mesh*. Different layer, different owner, different invasiveness of proof (§3). (`registry` stays for variable *mechanics*; `fleet`/`routing` are the *reasoning* layers — so `prune` → `fleet prune`.)

### Naming the layer-3 command: `routing`

Its checks **are** the routing plane (caller-pins, registry-as-routing-source, the routing-client cert, e2e routing delivery). `infra` is vaguer (and overlaps the self-layer's sandbox/settings infra); `fabric` is jargon. If a later command genuinely spans more than routing, revisit.

## Topology-agnostic by construction (the load-bearing constraint)

**Being addressable via GitHub *is the definition* of fleet membership** (the router is itself a GitHub Action — an agent unreachable through GitHub cannot be in the fleet). So inspecting the GitHub-resident substrate (registry, caller workflows, `agent-config.json`, the `MACF_CA_CERT` variable) is not an assumed dependency — it *is* the coordination plane (the **routing-infra** layer's surface). Per-deployment backends (Tempo/Loki/Prometheus) are the opposite: never queried (→ the agent's self-report, or the devops backend-diagnostic `macf-devops-toolkit#114`). The **mesh** layer assumes only what's per-agent provable: reachability at the registry address, over mTLS.

**Two scope boundaries, named so they aren't structurally baked as single** (both assume-single in v1):
- **The registry is owner-scoped, not global** (`/repos/groundnuty/groundnuty` — `groundnuty` is a *user*; profile-mode, DR-006). A multi-owner fleet has **N registries**; a future `--registry-scope` unions them.
- **One shared CA today** (`MACF_CA_CERT` + `~/.macf/certs/macf/ca-cert.pem`). A sub-fleet with its own CA → the mTLS fan-out must be **CA-per-scope**, keyed off the same scope as the registry.

Multi-host is *already* real (the CV fleet runs on the operator's laptop), so this is not theoretical. **Note the registry is read by both new layers** — the mesh layer reads it to *find* peers; the routing-infra layer *checks its correctness* (this is expected coupling, not a layer violation).

## §3 Delivery proof is an escalation ladder — each tier proves a different layer

Resolves the `--inject` invasiveness concern: proof escalates *with the layer*, and the default is **zero-cost passive observation**, not synthetic injection.

| Tier | Proves | Cost | Layer |
|---|---|---|---|
| **Reachable / Accepted** | mTLS+cert+channel up / protocol auth+parse+receiver-ready | none | mesh (non-invasive) |
| **Passive-Processed** | mesh delivery *happened* — a real, recent route-receipt | **zero** | mesh (default) |
| **`--inject`-Processed** | mesh delivery works *now* — synthetic, channel-only | one turn | mesh (idle-agent fallback) |
| **e2e** | the **routing plane** delivers end-to-end | full round-trip | routing-infra |

- **Reachable** = `GET /health`; **Accepted** = a `diagnostic`-flagged request the server ACKs synchronously **without push/wake** (§6).
- **Passive-Processed (the better-than-inject default):** the agent self-reports *its own* last-processed-real-receipt from **local** state (a `/health` field), sourced from DR-025 comms-ledger / #444 / #45 / the turn-receipt hook. A receipt for a real routed message proves the full chain at **zero cost**. **Phase-1 precondition — locality *and* granularity (devops):** passive stays topology-agnostic in the mesh layer **only if** each agent can self-report a per-agent/per-message *local* processed-receipt. If processed-receipts live **only centrally** (Tempo/#444), passive can't be a self-report → it degrades to the routing-infra layer (deployment-specific) and `--inject` carries more mesh weight. The local self-report is the cleaner design — keep passive in mesh, gated on this.
- **`--inject`** is the fallback for *idle* agents with no real traffic to observe (one turn; correlation-token echo, reusing #45).
- **e2e is the routing-infra layer's NATIVE proof:** an `--inject` rides the channel directly and **structurally cannot** exercise the GitHub plane (router → registry-resolve → mTLS → channel → agent-acts → PR). Only a real issue/PR does — so **`e2e.yml` is formalized as layer-3's delivery proof**: `macf routing doctor --e2e` **triggers `e2e.yml`'s `workflow_dispatch` and reads its result** (reuse the existing suite — it already runs scheduled + on-demand and auto-files an issue on post-merge failure — *not* a parallel test).

**Honesty requirement (loud in output):** non-invasive mesh checks prove the protocol **to the server's receive path**, NOT delivery-to-agent (the MCP-push blind spot that bit us this session) — only Passive/inject prove mesh delivery, and only e2e proves the routing plane.

## §4 The check catalog (`macf#564`), by layer

**Mesh layer (`macf fleet doctor`):**
- Reachable / Accepted / Passive-Processed / `--inject` (§3).
- Per-agent **leaf `cert_expiry`** in `/health` (warn <30d, crit <7d — an expired leaf = silent off-channels).
- **`otel`** = the channel-server's own export config + reachability (§5).
- **`state: idle|busy`** (best-effort; §5).

**Routing-infra layer (`macf routing doctor`):**
- **Routing-transport consistency** — every caller in the fleet's repo-set pins the *same expected* macf-actions version (mixed `@v1.3.x`/`@v3.3.0` = incomplete cutover — *this would have caught the outage*).
- **The #538 split — two distinct checks** (confirmed independent against v3.3.0 source: the auditor's wrong `app_name` routed fine because resolution never touches it):
  1. **Routability** — registered under **`MACF_AGENT_<ROUTING_LABEL>`** (resolution uses the label: `agent_seg = tr($LABEL)`, ~L167/L208). A bot-name key is silently unrouteable.
  2. **Self-skip correctness** — `agent-config.json[label].app_name == <bot-login>` (~L161 actor-skip; root cause `repo-init.ts:146`, `macf#566`).
- **Registration freshness** — `registry.instance_id == /health.instance_id` (precise current-vs-stale; disambiguates the #553 dying-server race) **and** `registry.port == /health.port` (ports reassign every relaunch — observed `:9620→:9436`, `4658c8→29e418` in one relaunch).
- **CA material** — `MACF_CA_CERT` is a *variable* (readable): decode + parse + expiry; also where the **#563 malformed-base64 class** is caught statically.
- **Cross-half rotation check** — each agent's `/health` leaf must **chain to the current `MACF_CA_CERT`** (catches partial rotation; makes CA rotation safe).
- **Stage-2 fallback consistency** — `agent-config.json` `tmux_session` matches the actual session name (the silent Stage-2 drop; revert-safety).
- **e2e delivery proof** (§3).
- **Repo-set source (resolves #560 Q3):** reuse an existing GitHub surface — the **App install-set** (or equivalent) — **not** a new `fleet.repos` config (no parallel, drift-prone surface).

**Detection ≠ fix (devops):** `macf routing doctor` *detects* (e.g. wrong-key registration) but several remedies are **framework-owned** (`MACF_ROUTING_LABEL`, #542) — devops owns the diagnostic, not the registration logic it inspects.

**The routing-client cert** (the single fleet-wide point) is a *write-only secret* → uncheckable statically; exercised **at use** by `macf routing doctor`'s own mTLS (a malformed cert fails its own POST = the signal) + on-disk where devops holds the source (`~/.macf/routing-client/`).

## §5 `/health` schema (the mesh self-report)

**Extend `/health` additively (not a new `/diag`).** It already carries `version` (`server.ts:396`) + the macf#545 routing identity, and #553's collision check parses it — additive fields are back-compat. Blessed set:

```jsonc
{ alive, version, routing_label, instance_id,
  state: "idle"|"busy", current?: "<one-line>",
  cert_expiry: "<iso8601>",
  otel: { endpoint, endpoint_is_canonical: bool, endpoint_reachable: bool } }
```

**`otel` is bounded to what's honestly knowable** (not `last_export_ok`): the **channel-server's own exporter** config + reachability, read from the server's **live `/proc/self/environ`, NOT the config file** (the #78 class — a correct config that never reached the process reports green while the process is dark). The server **cannot** introspect the `claude` TUI's exporter (a separate process — the `pgrep|head-1` mistake of #554).

**Three non-overlapping telemetry surfaces + one owned seam:** `macf fleet doctor` `/health.otel` = server export config+reach (cross-host) · `macf doctor`/#558 = the TUI's export via host-local `/proc` (NOT fleet-reportable) · **#114** = backend *ingest*. The irreducible seam (export-attempted-but-SDK-dropped, Instance 8) is invisible to config+reach and host-local, surfacing only as #114's backend-absence — **owned by #114**. Together they cover export→ingest with no gap/overlap.

**`state: idle|busy` is best-effort** (server-inferred from MCP/turn activity); **`current` requires the agent to publish** its turn-state. Build `idle|busy` first.

## §6 The `diagnostic` discriminator (the mesh Accepted check)

It must exercise the **same `/notify` auth+parse path** real routing uses (else "Accepted green" is meaningless) — so it's a discriminator **on `/notify`**, not a separate endpoint. **It is NOT a new `decideWake` value** — today `decideWake` (`a2a-delivery.ts`, keyed on `event`, macf#355) gates only the *wake*; an unrecognized event still **pushes to MCP**. The Accepted check needs **no push at all** (ACK-only, zero queue pollution), so it's an **earlier short-circuit, before `pushToMcpChannel`**: parse + auth → if `diagnostic` → synchronous ACK + return; else → push / `decideWake`. Wire: `diagnostic: true` (+ optional `correlation_token`) on the payload. Composes with — but is distinct from — Pattern E (DR-023).

## §7 Execution context + layer-based phasing

Both new commands need gh-auth (the GitHub reads) + a client cert + tailnet (the mTLS fan-out). Contexts, in order: **agent-runnable CLI first** (runnable today; the mTLS fan-out **must run outside Claude Code's sandbox** — the sandbox flaps tailnet probes), then a **CI `workflow_dispatch`** sibling. **No new tailnet ACL** — devops verified (correcting an earlier from-memory claim) the path is already permitted: the live v3 router (`macf-devops-toolkit` run 28217505738) is itself a GHA runner that joins the tailnet + mTLS-POSTs to `orzech-dev-agents:9xxx` every routing event — *precisely* the fan-out primitive. The CI sibling **reuses the router's `Connect to Tailscale` step config verbatim** (devops verified the path *succeeds*, so whatever tag it uses is permitted; the literal tag is *inferred* to be `tag:ci-runner` from macf#461 — code to confirm from the router workflow at build) — **NOT `e2e.yml`'s**, where the Instance-11 `tag:ci`-vs-`tag:ci-runner` bug lived — plus the `tailscale status … BackendState=="Running"` assert as insurance.

**Build phases (layer-ordered; mesh is the foundation the routing-infra checks consume):**
1. **Phase 1 — mesh layer:** `/health` self-report extension (§5, `otel` from live process env, server-scoped) + `macf fleet status` + the mesh delivery checks (Reachable/Accepted/Passive-Processed, `--inject` fallback) + idle/busy. *(Includes the comms-ledger-granularity precondition for passive proof.)*
2. **Phase 2 — routing-infra layer:** `macf routing doctor` — caller-pin consistency + the #538 split + registry `instance_id`/port staleness + CA-var parse + session-name + the cross-half rotation check + `--e2e` (formalized `e2e.yml`); the repo-set via the App install-set.
3. Fold `registry prune` → `fleet prune` (+ alias).

**Build-relevant items (code/devops-flagged):** (a) `/health.otel` reads live process env, server-scoped only; (b) the #538 split = two distinct checks (routability-by-label + self-skip-by-app_name); (c) the CI sibling reuses the router's `Connect to Tailscale` config verbatim — no new ACL (devops-verified); literal tag to confirm at build.

## Boundaries (compose, don't duplicate)

- **`macf monitor`** (DR-026 F4, auditor digest) = *coordination/governance* health (auditor lens); the new commands = *infrastructure/interconnect* health. Distinct.
- **`macf-devops-toolkit#114`** = backend-ingest diagnosis (the export-vs-ingest other half) — out of scope; devops scopes it to dovetail with §5.
- **`e2e.yml`** = formalized as the routing-infra layer's delivery proof (`macf routing doctor --e2e`), not a separate test.
- **`observability-snapshot.yml`** queries Tempo directly — the *opposite* of the topology-agnostic constraint; the new commands must not inherit any "query the backend" assumption.

## Consequences

- Each interconnect layer gets a health command at its own owner + invasiveness; the 2026-06-26 failure classes (caller-pin drift, wrong-key registration, malformed routing cert, stale registration, session-name drift, OTEL endpoint drift) become per-layer red/green instead of multi-hour archaeology.
- A `/health` schema change consumers tolerate additively (#553's parser is the contract).
- A new `diagnostic` verb on the channel server's receive path (minimal, early-short-circuit, well-tested — it's in the hot path).
- Two new commands instead of one — accepted as the cost of clean layer ownership (see Open questions for a possible aggregator).

## Open questions

1. **Compose entrypoint** — a single "is the whole interconnect green?" command (self+mesh+routing) vs running the three separately. Lean: keep separate (clean layers) + document the "run all three" recipe. An eventual `--all` aggregator must **degrade per-layer** (the layers have different access needs — self=local, mesh=tailnet+cert, routing=gh-auth+install-set), reporting e.g. "routing-infra: skipped — no gh-auth here" rather than failing the whole run; execution context determines which layers are runnable.
2. Output format — human table vs `--json` (lean: both; `--json` for the CI variant).
3. Does `fleet status` fully supersede the `macf-peers` skill, or coexist during transition?

## References

DR-005 (agent registration) · DR-006 (registry scope — Org/Profile/Repo, incl. profile-mode) · DR-024 (local-registry mode) · DR-023 Pattern E (receiver discriminator) · DR-025 + #444 + #45 (comms-ledger / route-receipt / correlation marker) · DR-026 F4 (`macf monitor`) · DR-028 (`macf doctor` per-role) · silent-fallback-hazards Instance 8 (export-vs-ingest) + Instance 10 (send≠processed) + Instance 11 (tailscale exit-0 mask) · #556/#558 (identity-scoped diagnostics) · #563/#562 (the cutover + the malformed-cert instance) · #564 (the check catalog) · #566 (the `app_name` root cause) · `macf-devops-toolkit#114` (backend-ingest diagnostic) · `e2e.yml`.
