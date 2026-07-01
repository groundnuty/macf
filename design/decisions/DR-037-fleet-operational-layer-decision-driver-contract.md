# DR-037: The fleet operational-layer as canonical CLI — decision/driver contract, distribution, workspace discovery

**Status:** Proposed
**Date:** 2026-07-01
**Trigger:** The 2026-07-01 operator session surfaced a *delivery* problem and a converging set of routed feature issues. Devops built a fleet operational layer (the DR-006 watchdog, resume/nudge-report, the cron installer, the DR-007 upgrade roll) as **reference implementations in `groundnuty/macf-devops-toolkit:fleet/`** — but the agent VMs only ever receive the **macf binary**, so none of it reaches them. Three routed issues (`macf#682` fleet-upgrade + version-visibility, `macf#686` watchdog/resume/install-cron promotion, and the `macf ps` dead-agent enumeration follow-up filed off DR-007 Amendment A / `#141`) all promote operational tooling into the CLI, and — surfaced in the code-agent review of DR-007 (`#682`) and the code↔devops exchange on `#686` — **they all consume the same three framework primitives that no macf DR yet defines.** This DR defines them, so the subcommands promote onto one substrate instead of each growing its own copy. Code-seeded (the framework-contract half of DR-007); routed to science for co-authorship + operator ratification (same seed→shape path as `#645`→DR-033).

> **The anchor insight.** MACF already has the split this DR formalizes — DR-030 put the fleet-*health commands* in macf while DR-031 put the *primitives* in macf and the *watchdog cron* in devops. This DR does the same for the operational layer: the **runtime-agnostic decision logic + the driver *interface* + the distribution rule + the workspace-discovery primitive are framework primitives (macf)**; the **per-runtime driver bodies + the VM cron + the tested reference impls are devops** (DR-006/DR-007). The DR names + generalizes a boundary the fleet already half-lives; it does not invent one.

## Context — three issues, one missing substrate

`macf#682` (fleet-upgrade), `macf#686` (watchdog/resume/cron), and the `macf ps` dead-enum (`#141`) are not three independent lifts. Each needs the same three things, and building them separately would grow three divergent copies — the "two half-built enumerations racing" hazard flagged on `#682`, at 4× the surface (`check-before-propose.md §4`):

1. a **decision/driver boundary** — so the *same* rolling/reconcile/busy-gate logic runs on a VM tmux session, a macOS host, and (far-future) a K8s pod, by swapping only the driver;
2. a **workspace-discovery primitive** — "what agents exist on this host" — shared by `ps` (alive∪dead), the upgrade orchestrator (group-by-registry → fleets), and the watchdog (desired-set reconcile);
3. a **distribution contract** — the rule that decides *what ships in the binary vs stays per-VM vs rides gitops*, i.e. why "promote it into the CLI" is the answer to "how do we deliver the operational work."

This DR pins all three as macf framework contract. The subcommands (`#682` Phase 2, `#686`, `ps` dead-enum) then build on it.

## Decision

### 1. The distribution contract — capability→binary, config→local, cluster→gitops

The delivery rule (operator, 2026-07-01; devops DR-007 Amendment B is the trigger):

| Kind | Ships via | Example |
|---|---|---|
| **Capability** (reusable logic) | the **macf binary as a subcommand** — npm → every VM through `macf init` / `macf update` | `macf fleet upgrade`, `macf watchdog reconcile`, `macf fleet resume`, `macf ps` |
| **Per-VM config** (host-specific state) | **local**, provided by `macf init` / bootstrap — NOT distributed identically | `desired-agents.yaml`, the cron schedule, endpoints / alert-repo, `MACF_WORKSPACE_ROOT` |
| **Cluster-side** (the K8s future) | **gitops → argocd** | the macf-operator's manifests |

**"Shipping the binary ships the capability."** A capability that lives only as a `fleet/*.sh` reference impl in a devops repo reaches no VM; promoted to a subcommand, it reaches every VM the next `macf update`. The nice recursion: once `macf fleet upgrade` is distributed, **it** rolls future binary updates across the fleet (`macf init` seeds a VM; `macf fleet upgrade` sustains it).

### 2. The decision/driver split — a framework primitive

Generalized from DR-007 into a macf contract. Exactly two layers; **only the bottom one is runtime-specific**:

**Decision layer (runtime-agnostic).** Drives off the `/health` self-report (roster, version, idle/busy — DR-031 + `macf#683`) and the workspace-discovery primitive (§3). It **never** touches `/proc`, tmux, `capture-pane`, or the Kubernetes API. It owns the pure logic: the reconcile HEAL ladder, exit-code intent, restart backoff + stuck-in-backoff escalation, launch-stagger, self-heartbeat, the rolling upgrade sequencer + verify-green, and the busy-gate *decision*. Native TypeScript (§5), unit-tested against the devops `fleet/*.sh` case suites (the acceptance oracle: `reconcile.sh` 52, `resume.sh` 10, `upgrade.sh`'s guard cases).

**Driver layer (pluggable, per-runtime) — the ONLY place the runtime leaks.** Implements a fixed interface the decision layer calls. The **hard rule this DR locks: nothing runtime-specific leaks above the driver line.** Wrapping the bash `reconcile.sh`/`upgrade.sh` would violate this (they carry `/proc`+tmux+`capture-pane`) — which is why §5 says reimplement, not wrap.

Proposed driver interface (exact method set is an open question):

```
interface FleetDriver {
  probe(): FleetState                 // roster + /health (version, idle/busy) — mTLS self-report
  discoverWorkspaces(): Workspace[]   // §3 — the host's agents (alive∪dead)
  isBusy(agent): boolean              // VM: capture-pane-diff aliveness-gate | K8s: /health busy
  upgrade(agent): void                // VM: macf update | K8s: patch desired image
  restart(agent): void                // VM: restart-self (alive→graceful, dead→launch) | K8s: cycle pod
  launch(agent): void                 // cold-start a desired-but-down agent
}
```

| Driver | `isBusy` / `restart` / `discover` | Status |
|---|---|---|
| **VM (Linux)** | `/proc` + tmux + `capture-pane`-diff (`#128`/`#130`) + `macf update` + `restart-self` | the reference impl exists (`fleet/*.sh`); promote to the TS driver |
| **VM (macOS)** | `ps`/`lsof`/libproc variant of the `/proc` reads | `#686` / `ps` follow-up |
| **K8s (far-future, the *macf operator*)** | pod phase + preStop-deregister (`#627`) + readiness-gate verify-green; **never `kubectl rollout restart`** (the busy-gate forbids stock rolling) | own future code/science DR; consumes this same interface |

### 3. The workspace-discovery primitive

"What agents exist on this host" — agreed on `#682`/`#141` (code↔devops). One primitive, three consumers (`ps` dead-enum, upgrade fleet-enum, watchdog desired-set).

- **Shape (per discovered workspace):** `{ agent (routing-label), workspace, registry, versionPin }` — carries what all three need. `ps` adds alive/dead (process↔cwd match); the upgrade orchestrator groups by `registry` (→ fleets, per-fleet version-target); the watchdog reconciles against the desired-set.
- **Source — registry-free filesystem discovery, NOT a registry-of-registries.** Scan for the `.macf/` agent marker under configured workspace-root(s) (`MACF_WORKSPACE_ROOT`, env-override + sensible default). This is *discovery* (a search path), not a 4th source of truth that drifts when a fleet is added/removed (`check-before-propose.md §4` — the same reason science rejected a hand-maintained `fleets.yaml` in DR-007 OQ1).
- **Marker-scan is primary** (it's what reveals the **dead** agents — a stopped agent has a workspace but no process); **running-process cwds are a cross-check** (they surface only ALIVE agents). A dead agent's version reads from its on-disk pin (`package.json` / the workspace pin), no process required.
- **Discovery is itself a driver concern** (code-agent's DR-007 review): "scan the host's workspaces" is VM-filesystem-specific; on K8s "the agents on a host" is namespaces/labels. So `discoverWorkspaces()` lives on the driver; the decision layer *consumes* the resulting roster.

### 4. Version substrate — `/health.version`, `compareSemver`, re-resolve-on-restart

- **`/health.version`** (shipped, `macf#683`) is the runtime-portable version source — a VM's installed pin and a K8s pod's image both self-report identically; NOT the VM-only `macf-agent.json`.
- **Comparison** uses macf-core's `compareSemver` (`packages/macf-core/src/semver.ts`, from `#424`) — the canonical TS semver-compare — NOT a fresh impl and NOT the bash `macf-bootstrap #660` version (that one is for the devops shell reference).
- **verify-green re-resolves the endpoint.** `restart-self` relaunches with a **new port + instance_id**, so the post-restart `/health.version == target` check MUST re-read the registry for the fresh endpoint and poll-with-timeout — never probe the dead pre-restart `host:port` (a silent-fallback trap: false "not-green").

### 5. Language — native TypeScript decision-layer + pluggable driver (not bash-wrapping)

The canonical subcommands are **native TypeScript**: the runtime-agnostic decision layer in TS (unit-tested against the devops case suites), the per-runtime driver bodies in TS calling the OS primitives. The devops `fleet/*.sh` are the **tested spec + the interim** (VMs clone the toolkit repo until the subcommands land), NOT a prescription to keep bash. Rationale: bash-wrapping ships the `/proc`+tmux coupling *above* the driver line, which forbids the macOS + K8s drivers from being a swap (they'd be a rewrite). (Operator: "let the agents decide"; this is the decision.)

### 6. The subcommand surface (what promotes onto this substrate)

Each is a separate build issue; this DR is the substrate they share, not their implementation.

| Subcommand | Issue | Lifts |
|---|---|---|
| `macf fleet upgrade` (roll: busy-gate → upgrade → restart → verify-green; fleet/registry selection; multi-select) | `#682` Phase 2 | `fleet/upgrade.sh` |
| `macf watchdog reconcile` (desired-state reconcile: probe → HEAL ladder → exit-code intent → aliveness-gate → backoff → stuck-escalation → launch-stagger → heartbeat; dry-run default) | `#686` | `fleet/reconcile.sh` (52 tests) |
| `macf fleet resume` (idle + pane-signature → nudge\|report, allowlist-driven, fire-cap, verify-resumed) | `#686` | `fleet/resume.sh` (10) + `stall-signatures.json` |
| `macf watchdog install-cron` (host-cron installer, report-only default, fail-loud token-mint, host-prelude) | `#686` | `fleet/install-cron.sh` |
| `macf ps` (alive∪dead enumeration + VERSION + macOS `ps`/`lsof`) | `#682` P1 (shipped) + `#141` follow-up | `ps.ts` + §3 discovery |

## Boundaries / non-goals

- **Not** the macf-operator (K8s driver) design — that is a future code/science DR; this DR only fixes it as *a driver* consuming this interface.
- **Not** `kubectl rollout restart` or any stock rolling primitive — the busy-gate forbids it (a stock roll evicts a mid-turn agent).
- **Not** a new supervisor — it composes DR-006's reconcile concept + DR-031's `restart-self` + DR-030's fleet-health commands. Version/desired-state are facets of the same reconcile.
- **Per-VM config stays local** — this DR distributes *capability*, never a one-size `desired-agents.yaml` / cron schedule / endpoint set.
- **The reference `fleet/*.sh` stay** as the tested spec + the interim delivery until each subcommand lands; this DR does not delete them.

## Consequences

- **One substrate, N subcommands.** `#682` Phase 2, `#686`'s three commands, and the `ps` dead-enum all build on the decision/driver interface + the discovery primitive — no divergent copies.
- **Cross-platform + K8s fall out of one code path** — the whole reason to pay for the split now: macOS is a driver variant; the macf-operator is a driver, not a rewrite.
- **Delivery is solved** — promoted capabilities reach every VM via `macf update`; the recursion (`fleet upgrade` rolls the binary that carries `fleet upgrade`) makes the fleet self-sustaining after `init` seeds it.
- **DR-006/DR-007 stay the devops-side design + reference impls + delegation triggers**; this macf DR carries the framework contract they promote onto — the DR-030/DR-031 split, applied to the operational layer.
- **Cost:** a native-TS reimplementation of proven bash is more work than wrapping — bought back by portability + the tested case-suites as the acceptance oracle, and paid down incrementally (one subcommand at a time).

## Open questions (for review)

1. **The exact `FleetDriver` method set** (§2) — is the 6-method sketch complete, or do `reconcile`'s ladder tiers (gated-inject vs graceful-restart vs tier-3-alert) need first-class driver methods vs decision-layer branching on `restart`/`launch`?
2. **Where the decision-layer + driver code lives** — `packages/macf/src/cli/fleet/` (decision) + `.../drivers/{vm,macos}.ts`? Or a `macf-core` home for the pure decision logic so it's runtime-and-CLI-independent? Lean: decision logic in `macf-core` (pure, testable), drivers in `packages/macf`.
3. **`macf watchdog` vs `macf fleet` namespace** — devops filed `watchdog reconcile`/`watchdog install-cron` and `fleet resume`/`fleet upgrade`. Unify under one (`macf fleet {upgrade,reconcile,resume,install-cron,status,doctor}`) or keep `watchdog` for the cron-side verbs? Lean: one `fleet` namespace; `watchdog` is the *cron consumer* of `fleet reconcile`, not a separate noun.
4. **Discovery override escape-hatch** — beyond `MACF_WORKSPACE_ROOT` marker-scan, is an explicit per-host workspace-list override ever needed, or does that reintroduce the drift §3 rejects? Lean: env-configurable roots only; no static list.
5. **Ratification + numbering vis-à-vis DR-007 Amendment B** — this DR is the macf-side contract; DR-007 Amendment B (devops) is the distribution-contract statement that triggered it. Keep both (macf = contract, devops = trigger + reference), cross-referenced, per the DR-030/031 precedent.

## Cross-references

- **DR-006** (macf-devops-toolkit) — the VM watchdog + reconcile ladder + exit-code intent + heartbeat design; the reference impls (`fleet/*.sh`) this promotes.
- **DR-007** (macf-devops-toolkit) + **Amendments A/B** — fleet-upgrade orchestration + host-local plane + the distribution contract; the orchestration design this generalizes. This DR is its framework-contract half (the code-agent review of `#682` proposed the split).
- **macf DR-030** — fleet-health commands (`macf fleet status`/`doctor`); the precedent for "commands in macf, watchdog cron in devops."
- **macf DR-031** — `/health` + `restart-self` supervision contract this rides.
- **`macf#682`** (fleet-upgrade + `/health.version` visibility, Phase 1 shipped `#683`), **`macf#686`** (watchdog/resume/install-cron promotion), **`#141`** (`ps` dead-agent enum) — the subcommands that build on this substrate.
- **`packages/macf-core/src/semver.ts`** (`#424` `compareSemver`) — §4 version comparison.
- **`check-before-propose.md §4`** — the "don't build a parallel source of truth" rule §3's registry-free discovery honors.
