# DR-030: `macf fleet` namespace + the interconnect fleet-doctor

**Status:** Proposed
**Date:** 2026-06-26
**Trigger:** The 2026-06-26 Stage-3 routing outage — science-agent silently received zero routed issues for a full session because `groundnuty/macf`'s caller was stuck `@v1.3.4` while science was on Stage-3 channels, compounded by an `agent-config.json` session-name mismatch that silently killed the Stage-2 fallback. Every root cause was an invisible-until-broken fleet-health gap that took manual cross-repo archaeology to find. Operator-directed design ask (`macf#560`); the concrete check requirements were harvested separately as `macf#564`. This DR is the 3-way synthesis of code-agent's seed (`#560`), science-agent's design review, and devops-agent's ops review.

## Context

The CLI operates at **three scopes**, only two of which are named:

| Scope | Backed by | Commands today | Answers |
|---|---|---|---|
| Workspace / single-agent | `.macf/` + cwd | `init`, `update`, `doctor`, `certs`, `status` | *Is THIS agent configured + healthy?* |
| Host / process | `/proc` (local) | `macf ps` (#558) | *What's running on THIS box?* |
| **Fleet** | **the registry (on GitHub)** | `peers`, `registry prune` (#558) | *What's the whole fleet doing?* |

`macf doctor` is correctly the **single-agent** health check (DR-019 token perms, the DR-028 settings floor, sandbox, the #558 OTEL launch-boundary probe) — it has no notion of the fleet or the interconnect. **No command answers the fleet/interconnect question today**, and the fleet-reasoning commands that do exist (`registry prune`) are scattered under other namespaces. `macf#564` catalogued the specific health checks the 2026-06-26 incident proved necessary; this DR is their home.

## Decision

Introduce the **`macf fleet <verb>`** namespace and **`macf fleet doctor`** — the end-to-end interconnect test — built on a **two-halves architecture** and a **three-state delivery model**.

### 1. The `macf fleet` namespace + scope-parallel naming

```
macf fleet status            roster + LIVE health + idle/busy     (everyday; supersedes the macf-peers health view)
macf fleet ping <agent>      one peer, detailed
macf fleet doctor            the end-to-end interconnect test
macf fleet doctor --inject   + the invasive "Processed" round-trip (opt-in)
macf fleet prune             confirmed-dead cleanup               (moved from `registry prune`; alias kept 1 cycle)
```

**Design principle — scope-parallel verbs:** `macf <verb>` (workspace) and `macf fleet <verb>` (fleet) share verbs (`status`, `doctor`, `ping`); **scope is the only axis that changes**. Learnable + extensible. (`ls`/`e2e`/`check` break the parallel — rejected.) `registry` stays for variable *mechanics* (read/write/list); `fleet` is fleet *reasoning* — so `prune` moves to `fleet prune`, with a deprecated `registry prune` alias for one release cycle (it just shipped in #558).

### 2. Two-halves architecture (topology-agnostic by construction)

`fleet doctor` has two complementary halves; neither inspects per-deployment backend infrastructure:

**Half A — GitHub shared-plane inspection** (static; no agent contact). The load-bearing constraint, sharpened by devops: **being addressable via GitHub *is the definition* of fleet membership** — the router is itself a GitHub Action, so an agent that can't be reached through GitHub *cannot be in the fleet*. Inspecting the GitHub-resident substrate (registry, caller workflows, `agent-config.json`, the `MACF_CA_CERT` variable) is therefore not an assumed dependency — it *is* the coordination plane. Per-deployment backends (Tempo/Loki/Prometheus) are the opposite: never queried (→ self-report or the devops backend-diagnostic, `macf-devops-toolkit#114`).

**Half B — per-agent self-report fan-out** (the only thing assumable per-agent: reachability at the registry address). `fleet doctor` asks each agent *"are you healthy, including your own telemetry?"* over its mTLS endpoint and aggregates. Same code for a 1-VM or 5-cloud fleet.

**This folds `macf#564` in as the check catalog** (§4); `fleet doctor` is its implementation.

**Two scope boundaries, named so they aren't hard-coded as single** (both assume-single in v1):
- **The registry is owner-scoped, not global** — it lives at `/repos/groundnuty/groundnuty` because `groundnuty` is a *user* (profile-mode, DR-006). A fleet spanning multiple owners/orgs has **N registries**; a future `--registry-scope` would union them.
- **One shared CA today** (`MACF_CA_CERT` + `~/.macf/certs/macf/ca-cert.pem`). A sub-fleet that `init`s its own CA → the mTLS fan-out must be **CA-per-scope**, keyed off the same scope as the registry.

Multi-host is *already* real (the CV fleet runs on the operator's laptop — different host/network), so the topology-agnostic constraint is not theoretical.

### 3. Three-state delivery model (inspect-vs-inject)

The interconnect has the *send ≠ received ≠ processed* hierarchy (silent-fallback Instance 10 / DR-025 comms-ledger / the #444 route-receipt reconciler):

| State | Proves | Invasive? | Check |
|---|---|---|---|
| **Reachable** | mTLS + cert trust + network + channel up | No | `GET /health` |
| **Accepted** | the protocol: auth, wire parse, receiver ready | No | a `diagnostic`-flagged request the server ACKs **synchronously, without push/wake** |
| **Processed** | the full chain: server → MCP push → agent reads → agent acts | **Yes** | a correlation-token the agent echoes back (comms-ledger / channel reply) |

- **Non-invasive (default, run anytime mid-work):** Reachable + Accepted + the self-reports.
- **Invasive (`--inject`, for setup/triage):** the Processed round-trip — costs each agent one turn; the **correlation token** (reusing the #45 route-marker) defeats stale/duplicate false-positives.

**Honesty requirement (loud in the output):** non-invasive `fleet doctor` proves the protocol **up to the server's receive path** — it does **NOT** exercise server→MCP-push→agent-read, exactly where the 2026-06-26 failures lived (channel up + ACKing, but delivery-to-agent broken). **Only `--inject` (Processed) proves delivery.** A green non-invasive run must never be read as "routing works end-to-end."

### 4. The check catalog (`macf#564`, mapped to the two halves)

**Half A — GitHub shared-plane (static):**
- **Routing-transport consistency** — every agent-router caller across the fleet's repos pins the *same expected* macf-actions version (flag mixed `@v1.3.x`/`@v3.3.0` = an incomplete cutover — *this would have caught the outage*).
- **Routability key (#538, part 1)** — each agent is registered under **`MACF_AGENT_<ROUTING_LABEL>`** (resolution uses the *label*: `agent_seg = tr($LABEL)`, v3.3.0 agent-router ~L167/L208). A registration under the bot-name key is silently unrouteable — *the exact class that killed code's 06:02 run*.
- **Self-skip correctness (#538, part 2 — a DISTINCT check)** — `agent-config.json[label].app_name == <bot-login>` (v3.3.0 ~L161 actor-skip). Confirmed independent of routability: `macf-auditor-agent` had `app_name: "auditor"` (should be `macf-auditor-agent`) yet routed fine, because **resolution never touches `app_name`**. Root cause: `repo-init.ts:146` writes agent-name not bot-login (`macf#566`).
- **Registration freshness** — `registry.instance_id == /health.instance_id` (the precise current-vs-stale test) **and** `registry.port == /health.port` (ports reassign every relaunch — observed `:9620→:9436` + `4658c8→29e418` in one relaunch). `instance_id` match also disambiguates the #553 dying-server race (a relaunching server momentarily answers `/health`; "alive" is point-in-time).
- **CA material** — `MACF_CA_CERT` is a *variable* (readable): decode + parse + expiry. This is also where the **#563 malformed-base64 class** is caught statically (presence passes, parse fails).
- **Cross-half rotation check** — each agent's `/health`-presented leaf must **chain to the current `MACF_CA_CERT` key**. Catches partial rotation (an agent on an old-CA leaf after the CA rotated — passes presence + its own expiry, but no longer fleet-trusted). The check that makes CA rotation safe.
- **Stage-2 fallback consistency** — `agent-config.json` `tmux_session` matches the agent's actual session name (the silent Stage-2 drop: flat `science-agent` vs actual `macf@macf-science-agent`). Revert-safety.

**Half B — per-agent self-report (fan-out):**
- **Reachable / Accepted / Processed** (§3).
- **Per-agent leaf `cert_expiry`** in `/health` (warn <30d, crit <7d — an expired leaf = silent off-channels).
- **`otel`** = the channel-server's **own** export config + reachability (§5).
- **`state: idle|busy`** (best-effort; §5).

**The routing-client cert (the single fleet-wide point)** is a *write-only secret* → uncheckable statically; it is exercised **at use** by `fleet doctor`-as-GHA's own mTLS (a malformed cert fails fleet-doctor's own POST = the signal), and on-disk where devops holds the source (`~/.macf/routing-client/`).

### 5. The `/health` schema extension + the telemetry model

**Extend `/health` additively (NOT a new `/diag` for the self-report).** `/health` already carries `version` (`server.ts:396`) + the macf#545 routing identity, and #553's collision check parses it — additive fields are back-compat (unknown-field-tolerant). Blessed field set:

```jsonc
{ alive, version, routing_label, instance_id,
  state: "idle"|"busy", current?: "<one-line>",
  cert_expiry: "<iso8601>",
  otel: { endpoint, endpoint_is_canonical: bool, endpoint_reachable: bool } }
```

**`otel` is bounded to what's HONESTLY knowable** (not `last_export_ok`): it reports the **channel-server's own exporter** config-correctness + reachability, read from the server's **live `/proc/self/environ`, NOT the config file** (the #78 class — a correct config that never reached the process reports green while the process is dark). The server **cannot** introspect the `claude` TUI's exporter — a separate process (that is literally the `pgrep | head-1` mistake of #554).

**Telemetry: three non-overlapping surfaces + one owned seam:**
- `fleet doctor` `/health.otel` — the **server's** export config + reach (cross-host, honest).
- `macf doctor` / `doctor-otel.sh` (#558) — the **TUI's** export reality via host-local `/proc` (NOT fleet-reportable).
- **`macf-devops-toolkit#114`** — backend **ingest** (per-deployment, owner-run, Pattern-A "trace count > 0").

The one irreducible seam — export-attempted-but-SDK-dropped (Instance 8) — is invisible to config+reach and to host-local, and surfaces only as **#114's backend-absence**, which is the actionable signal regardless of sub-cause. Together the three cover export→ingest with no gap and no overlap.

**`state: idle|busy` is best-effort** (the server heuristically infers from MCP/turn activity; "busy mid-turn" isn't authoritatively visible). **`current` activity requires the agent to actively publish** its turn-state (a checkpoint/MCP write the server reads) — build `idle|busy` first, `current` second.

### 6. The `diagnostic` discriminator (the Accepted check)

The `diagnostic` request must exercise the **same `/notify` auth+parse path** real routing uses (else "Accepted green" is meaningless) — so it is a discriminator **on the `/notify` path**, not a separate endpoint. **Correction to the seed:** it is **not** just a new `decideWake` event value — today `decideWake` (`a2a-delivery.ts`, keyed on `event`, macf#355) gates only the *wake*; an unrecognized event still **pushes to MCP** (push-only, no wake). The Accepted check needs **no push at all** (ACK-only, zero queue pollution), so it is an **earlier short-circuit, before `pushToMcpChannel`**: parse + auth → if `diagnostic` → synchronous ACK + return; else → push / `decideWake`. Wire: `diagnostic: true` (+ optional `correlation_token` for the Processed variant) on the notify payload. Composes with — but is distinct from — Pattern E (DR-023).

### 7. Execution context

`fleet doctor` needs gh-auth (Half A) + a client cert + tailnet (Half B's mTLS fan-out). Two contexts, shipped in order:
1. **Agent-runnable CLI first** — runnable today (App gh-auth + the routing-client cert on disk + already on the tailnet). The mTLS fan-out **must run outside Claude Code's sandbox** (the sandbox flaps tailnet probes — devops's `reference_tempo_query_sandbox` finding).
2. **CI `workflow_dispatch` second** (the 6 routing secrets are present on all 4 fleet repos). **No new tailnet ACL is needed** — devops verified (correcting an earlier from-memory claim) that the path is already permitted: the live v3 router (`macf-devops-toolkit` run 28217505738) is itself a GHA runner that joins the tailnet and mTLS-POSTs to an agent's channel at `orzech-dev-agents:9xxx` on every routing event — *precisely* fleet-doctor's fan-out primitive. The CI sibling **reuses the router's proven `Connect to Tailscale` step config** (`tag:ci-runner`) — **NOT `e2e.yml`'s**, which is exactly where the Instance-11 `tag:ci`-vs-`tag:ci-runner` bug lived (macf#461) — and keeps the `tailscale status … BackendState=="Running"` assert as cheap insurance (else fleet-doctor misdiagnoses a tag failure as "agents unreachable").

(A note on proc↔workspace correlation: on Dropbox-synced hosts `/proc/<pid>/cwd` can report a macOS-style alias path; the server reading its *own* env is unaffected, but any proc-cwd↔workspace cross-reference needs alias-awareness.)

## Boundaries (compose, don't duplicate)

- **`macf monitor`** (DR-026 F4, auditor digest) = *coordination/governance* health (auditor lens); **`fleet doctor`** = *infrastructure/interconnect* health (ops lens). Related, distinct.
- **`macf-devops-toolkit#114`** = backend-ingest diagnosis (the export-vs-ingest other half) — explicitly out of `fleet doctor`'s scope; devops scopes it to dovetail with §5.
- **`e2e.yml`** = the CI E2E suite; `fleet doctor` is its on-demand operator-facing sibling.
- **`observability-snapshot.yml`** queries Tempo directly — the *opposite* of the Half-A/Half-B constraint; `fleet doctor` must not inherit any "query the backend" assumption from it.

## Build plan (incremental, code-agent; after ratification)

1. `/health`-carries-state extension (§5 field set, `otel` from live process env, server-scoped) + `macf fleet status` (Reachable + self-reports + idle/busy) + the Half-A static checks (caller-pin, the **#538 split**, instance_id/port staleness, CA-var parse, session-name).
2. The `diagnostic` discriminator (§6, early short-circuit) + `fleet doctor` non-invasive (Accepted) + the cross-half rotation check.
3. `--inject` round-trip (Processed) via the comms-ledger correlation token.
4. Fold `registry prune` → `fleet prune` (+ alias); the CI `workflow_dispatch` (reuses the router's `Connect to Tailscale` config — no ACL dependency).

**Build-relevant items flagged by code/devops:** (a) `/health.otel` reads live process env, server-scoped only; (b) the #538 split = two distinct checks (routability-by-label + self-skip-by-app_name); (c) the CI sibling reuses the router's proven `Connect to Tailscale` step config (`tag:ci-runner`) — no new ACL needed (devops verified via the live router).

## Consequences

- One command answers "is the whole fleet's interconnect healthy?" — and the specific failure classes from 2026-06-26 (caller-pin drift, wrong-key registration, malformed routing cert, stale registration, session-name drift, OTEL endpoint drift) become a single red/green instead of a multi-hour cross-repo investigation.
- A `/health` schema change consumers must tolerate additively (the #553 collision check is the existing parser — additive-only is the contract).
- A new protocol verb (`diagnostic`) on the channel server's receive path — minimal, early-short-circuit, well-tested (it's in the hot path).

## Open questions

1. `fleet doctor` output format — human table vs `--json` for automation (lean: both, `--json` for the CI variant).
2. Does `fleet status` fully supersede the `macf-peers` skill, or do they coexist during transition?
3. Where the fleet's *repo set* (for caller-pin consistency) is sourced — the registry tracks agents, not repos; a `fleet.repos` config input may be needed.

## References

DR-006 / DR-024 (registry) · DR-005 (profile-mode registry scope) · DR-023 Pattern E (receiver discriminator) · DR-025 + #444 + #45 (comms-ledger / route-receipt / correlation marker) · DR-026 F4 (`macf monitor`) · DR-028 (`macf doctor` per-role) · silent-fallback-hazards Instance 8 (export-vs-ingest) + Instance 10 (send≠processed) + Instance 11 (tailscale exit-0 mask) · #556/#558 (identity-scoped diagnostics) · #563/#562 (the cutover + the malformed-cert instance) · #564 (the check catalog) · #566 (the `app_name` root cause) · `macf-devops-toolkit#114` (backend-ingest diagnostic) · `e2e.yml`.
