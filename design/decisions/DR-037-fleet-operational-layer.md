# DR-037: The fleet operational-layer as canonical CLI — two planes, decision/driver contract, distribution, workspace discovery

**Status:** Proposed
**Date:** 2026-07-01
**Trigger:** The 2026-07-01 operator session surfaced a *delivery* problem and a converging set of routed feature issues. Devops built a fleet operational layer (the DR-006 watchdog, resume/nudge-report, the cron installer, the DR-007 upgrade roll) as **reference implementations in `groundnuty/macf-devops-toolkit:fleet/`** — but the agent VMs only ever receive the **macf binary**, so none of it reaches them. Three routed issues (`macf#682` fleet-upgrade + version-visibility, `macf#686` watchdog/resume/install-cron promotion, and the `macf ps` dead-agent enumeration off DR-007 Amendment A / `#141`) all promote operational tooling into the CLI, and — surfaced in the code review of DR-007 (`#682`) and the code↔devops exchange on `#686` — **they all consume the same framework primitives no macf DR yet defines.** This DR defines them, so the subcommands promote onto one substrate.

> **Authorship note.** This DR was drafted in parallel by code-agent (`#687`, the concrete framework contract — the `FleetDriver` interface, discovery shape, verify-green re-resolve, `compareSemver`) and science (`#688`, the two-plane framing) at the same instant — a `check-before-propose §4` "two half-built things racing" miss, ironically on this very DR, resolved by each deferring to the other. This is the merge: code-seeded (the framework-contract half of DR-007), science-authored, consolidating both drafts. Same seed→shape path as `#645`→DR-033.

> **The anchor insight.** MACF already has the split this DR formalizes — DR-030 put the fleet-*health commands* in macf; DR-031 put the *primitives* in macf and the *watchdog cron* in devops. This DR does the same for the operational layer: the **runtime-agnostic decision logic + the driver *interface* + the distribution rule + the workspace-discovery primitive are framework (macf)**; the **per-runtime driver bodies + the VM cron + the tested reference impls are devops (DR-006/DR-007)**. It names + generalizes a boundary the fleet already half-lives; it does not invent one.

## Context — three issues, one missing substrate

`macf#682` (fleet-upgrade), `macf#686` (watchdog/resume/cron), and the `macf ps` dead-enum (`#141`) are not three independent lifts. Each needs the same things, and building them separately would grow divergent copies — the "two half-built enumerations racing" hazard flagged on `#682`, at 4× the surface (`check-before-propose.md §4`):
1. a **decision/driver boundary** — the same rolling/reconcile/busy-gate logic on a VM tmux session, a macOS host, and (far-future) a K8s pod, by swapping only the driver;
2. a **workspace-discovery primitive** — "what agents exist on this host" — shared by `ps` (alive∪dead), upgrade (group-by-registry → fleets), and the watchdog (desired-set reconcile);
3. a **distribution contract** — what ships in the binary vs stays per-VM vs rides gitops.

## Decision 1 — Two planes; never conflate them (DR-007 Amendment A)

Fleet operations read two *different* views of "the fleet," and DR-007 §1–4 blurred them:

| Plane | Source | Answers | Needs | Scope |
|---|---|---|---|---|
| **Routing / delivery** | the **registry** (per-fleet GitHub org-vars) | *reachability* — who is registered + alive-ish, at `host:port` | repo + network + auth | **per-fleet** (a fleet == a registry) |
| **Host-operational** | a **local scan** (workspaces + processes + on-disk pin + tmux) | *"what macf agents live on THIS box — alive or dead, at what version, busy or idle"* | **nothing** (no repo, no network) | **per-host** (all fleets) |

The registry is the routing plane (correct for delivery + upgrade *selection isolation* — `--fleet`/`--registry`, per-fleet version-target). The host-operational plane is registry-independent, **exactly like K8s**: `kubectl get pods -l app=macf` is the control plane; on a VM, **`macf ps` is that plane**. The upgrade/reconcile decision layer enumerates + reasons from the host-operational plane, touching the registry only for the routing it is actually for. **The two never conflate** — this is the *why* behind §4's registry-free discovery.

## Decision 2 — The distribution contract: capability→binary, config→local, cluster→gitops (DR-007 Amendment B)

| Kind | Ships via | Example |
|---|---|---|
| **Capability** (reusable logic) | the **macf binary as a subcommand** — npm → every VM via `macf init`/`update` | `macf fleet upgrade`, `macf fleet reconcile`, `macf fleet resume`, `macf ps` |
| **Per-VM config** (host-specific state) | **local**, seeded by `macf init`/bootstrap — NOT distributed identically | `desired-agents.yaml`, cron schedule, endpoints/alert-repo, `MACF_WORKSPACE_ROOT` |
| **Cluster-side** (the K8s future) | **gitops → argocd** | the macf-operator's manifests |

**"Shipping the binary ships the capability."** A capability that lives only as a `fleet/*.sh` in a devops repo reaches no VM; promoted to a subcommand, it reaches every VM the next `macf update`. The recursion: once `macf fleet upgrade` is distributed, **it** rolls future binary updates across the fleet — **`init` seeds a VM; `fleet upgrade` sustains it.**

## Decision 3 — The decision/driver split — a framework primitive

Generalized from DR-007 into a macf contract. Two layers; **only the bottom is runtime-specific**:

**Decision layer (runtime-agnostic).** Drives off the `/health` self-report (roster, version, idle/busy — DR-031 + `macf#683`) and the workspace-discovery primitive (§4). It **never** touches `/proc`, tmux, `capture-pane`, or the K8s API. It owns the pure logic: the reconcile HEAL ladder, exit-code intent, restart backoff + stuck-in-backoff escalation, launch-stagger, self-heartbeat, the rolling upgrade sequencer + verify-green, the busy-gate *decision*, **and the tier-3 alert** (a `gh issue create` — runtime-agnostic, so it stays here, NOT on the driver). Native TypeScript (§6), unit-tested against the devops `fleet/*.sh` case suites (the acceptance oracle: `reconcile.sh` 52, `resume.sh` 10, `upgrade.sh` guard cases).

**Driver layer (pluggable, per-runtime) — the ONLY place the runtime leaks.** A fixed interface the decision layer calls. **Hard rule: nothing runtime-specific leaks above the driver line.** Wrapping the bash `reconcile.sh`/`upgrade.sh` would violate this (they carry `/proc`+tmux+`capture-pane`) — which is why §6 says reimplement, not wrap.

```
interface FleetDriver {
  probe(): FleetState                 // roster + /health (version, idle/busy) — mTLS self-report
  discoverWorkspaces(): Workspace[]   // §4 — the host's agents (alive∪dead); VM-filesystem-specific
  isBusy(agent): boolean              // VM: capture-pane-diff aliveness-gate | K8s: /health busy
  inject(agent, msg): void            // tier-1 gated nudge — VM: tmux send-keys | K8s: TBD  (runtime-specific)
  upgrade(agent): void                // VM: macf update | K8s: patch desired image
  restart(agent): void                // VM: restart-self (alive→graceful, dead→launch) | K8s: cycle pod
  launch(agent): void                 // cold-start a desired-but-down agent
}
```

The decision layer branches on the reconcile tier: **gated-inject → `driver.inject`; graceful-restart → `driver.restart`; escalate → decision-layer `alert`** (a GH issue, not a driver method — else a GH concern leaks into the driver). `discoverWorkspaces` is a driver method (scanning a host's workspaces is VM-filesystem-specific; on K8s it's namespaces/labels).

| Driver | verbs | Status |
|---|---|---|
| **VM (Linux)** | `/proc` + tmux + `capture-pane`-diff (`#128`/`#130`) + `macf update` + `restart-self` | reference impl exists (`fleet/*.sh`); promote to TS |
| **VM (macOS)** | `ps`/`lsof`/libproc variant of the `/proc` reads | `#686` / `ps` follow-up |
| **K8s (far-future, *macf operator*)** | pod phase + preStop-deregister (`#627`) + readiness verify-green; **never `kubectl rollout restart`** (the busy-gate forbids stock rolling) | own future code/science DR; consumes this interface |

## Decision 4 — The workspace-discovery primitive (the host-operational plane's source)

One primitive, three consumers (`ps` dead-enum, upgrade fleet-enum, watchdog desired-set).
- **Shape (per workspace):** `{ agent (routing-label), workspace, registry, versionPin }`. `ps` adds alive/dead (process↔cwd match); upgrade groups by `registry` (→ fleets, per-fleet target); the watchdog reconciles the desired-set.
- **Source — registry-free filesystem discovery, NOT a registry-of-registries.** Scan for the `.macf/` marker under configured root(s) (`MACF_WORKSPACE_ROOT`, env-override + sensible default) — *discovery* (a search path), not a 4th drift-prone source of truth (`check-before-propose §4`; the same reason DR-007 OQ1 rejected a hand-maintained `fleets.yaml`).
- **Marker-scan is primary** (it reveals the **dead** agents — a stopped agent has a workspace, no process); running-process cwds are a cross-check (alive only). A dead agent's version reads from its on-disk pin.

## Decision 5 — Version substrate — `/health.version`, `compareSemver`, re-resolve-on-restart

- **`/health.version`** (shipped, `macf#683`) is the runtime-portable version source (a VM pin and a K8s pod image self-report identically) — NOT the VM-only `macf-agent.json`.
- **Comparison** uses macf-core's `compareSemver` (`packages/macf-core/src/semver.ts`, `#424`) — the canonical TS compare — NOT a fresh impl, NOT the bash `macf-bootstrap #660` (that's the devops shell reference).
- **verify-green re-resolves the endpoint.** `restart-self` relaunches with a **new port + instance_id**, so the post-restart `/health.version == target` check MUST re-read the registry for the fresh endpoint and poll-with-timeout — never probe the dead pre-restart `host:port` (a silent-fallback trap: false "not-green").
- **`ps` shows pinned-vs-running.** A mid-upgrade state (pin bumped, not yet relaunched) is legible when `ps` renders both (`pinned X, running Y`), not one conflated version.

## Decision 6 — Language: native TypeScript decision-layer + pluggable driver (not bash-wrapping)

The canonical subcommands are **native TypeScript** (decision layer unit-tested against the devops case suites; driver bodies in TS calling OS primitives). The devops `fleet/*.sh` are the **tested spec + interim** (VMs clone the toolkit repo until subcommands land), NOT a prescription to keep bash. Rationale: bash-wrapping ships the `/proc`+tmux coupling *above* the driver line, forbidding the macOS + K8s drivers from being a swap. (Operator: "let the agents decide"; this is the decision.)

## The subcommand surface

`macf` becomes the fleet-operations CLI (the kubectl analog). **One namespace — `fleet`** — with `watchdog` being the *cron consumer* of `fleet reconcile`, not a separate noun:

| Subcommand | Issue | Lifts |
|---|---|---|
| `macf fleet upgrade` (busy-gate → upgrade → restart → verify-green; fleet/registry select; multi-select) | `#682` P2 | `fleet/upgrade.sh` |
| `macf fleet reconcile` (probe → HEAL ladder → exit-code intent → aliveness-gate → backoff → stuck-escalation → launch-stagger → heartbeat; dry-run default; the cron runs this on a schedule) | `#686` | `fleet/reconcile.sh` (52) |
| `macf fleet resume` (idle + pane-signature → nudge\|report, allowlist, fire-cap, verify-resumed) | `#686` | `fleet/resume.sh` (10) |
| `macf fleet install-cron` (host-cron installer, report-only default, fail-loud token-mint) | `#686` | `fleet/install-cron.sh` |
| `macf ps` (alive∪dead + VERSION [pinned/running] + macOS) | `#682` P1 (shipped) + `#141` | `ps.ts` + §4 |

## Boundaries / non-goals

- **Not** the macf-operator (K8s driver) design — a future code/science DR; this only fixes it as a driver consuming this interface.
- **Not** `kubectl rollout restart` or any stock rolling primitive — the busy-gate forbids it.
- **Not** a new supervisor — composes DR-006 reconcile + DR-031 `restart-self` + DR-030 fleet-health. Version/desired-state are facets of one reconcile.
- **Per-VM config stays local** — distributes *capability*, never a one-size `desired-agents.yaml`/cron/endpoints.
- **The reference `fleet/*.sh` stay** as the tested spec + interim until each subcommand lands.

## Consequences

- **One substrate, N subcommands** — no divergent copies.
- **Cross-platform + K8s fall out of one code path** — macOS is a driver variant; the macf-operator is a driver, not a rewrite.
- **Delivery is solved** — promoted capabilities reach every VM via `macf update`; the recursion makes the fleet self-sustaining after `init` seeds it.
- **DR-006/DR-007 stay the devops design + reference impls + delegation triggers**; this macf DR carries the framework contract — the DR-030/031 split, applied to the operational layer.
- **Cost:** native-TS reimplementation of proven bash > wrapping — bought back by portability + the tested case-suites as the acceptance oracle; paid down one subcommand at a time.

## Resolved in review (were open questions; consolidated here)

1. **`FleetDriver` method set** — resolved: `inject` added to the driver (tier-1 gated-nudge, runtime-specific); tier-3 `alert` stays in the decision layer (GH issue, runtime-agnostic); tiers are decision-layer branching on `inject`/`restart`, not first-class driver tier-methods.
2. **Where the code lives** — resolved: pure decision logic in **`macf-core`** (runtime-and-CLI-independent, testable against the devops suites); drivers in `packages/macf`.
3. **`watchdog` vs `fleet` namespace** — resolved: **one `fleet` namespace**; `watchdog` is the cron consumer of `fleet reconcile`, not a separate noun.
4. **Discovery override** — resolved: **env-configurable roots (`MACF_WORKSPACE_ROOT`) + marker-scan only; no static per-host list** (it reintroduces the drift §4 rejects).
5. **Numbering vs DR-007 Amendment B** — resolved: **keep both, cross-referenced** (macf DR-037 = the framework contract; devops DR-007 Amendment B = the trigger + reference), per the DR-030/031 precedent.

**Still open:** whether `discoverWorkspaces` should cache per-invocation (a large host re-scans every `ps`/`reconcile`) or accept the scan cost — a perf question deferred to the `macf ps` build (`#682`/`#141`).

## Cross-references

- **DR-006** (macf-devops-toolkit) — VM watchdog + reconcile ladder + exit-code intent + heartbeat; the reference impls this promotes.
- **DR-007** (macf-devops-toolkit) + **Amendments A/B** — fleet-upgrade orchestration + host-local plane + distribution contract; the orchestration design this is the framework-contract half of.
- **macf DR-030** — fleet-health commands; the "commands in macf, cron in devops" precedent.
- **macf DR-031** — `/health` + `restart-self` supervision contract this rides.
- **macf DR-033** (`#684`) — the auto-responder that unblocks *unattended* upgrade (launch-prompts).
- **macf DR-036** — cross-fleet delegation; fleet-upgrade selects registry *members*, never guests (a guest is a different registry) — the visibility-vs-supervision invariant, for free.
- **`macf#682`** (fleet-upgrade + `/health.version`, P1 shipped `#683`), **`#686`** (watchdog/resume/install-cron promotion), **`#141`** (`ps` dead-enum) — the subcommands built on this substrate.
- **`packages/macf-core/src/semver.ts`** (`#424` `compareSemver`) — §5.
- **`check-before-propose.md §4`** — the "don't build a parallel source of truth" rule §4 honors (and the authorship-note race lesson).
