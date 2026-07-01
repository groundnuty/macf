# DR-037: MACF fleet-operations framework contract — two planes, the CLI as delivery channel, the fleet-command family

**Status:** Proposed
**Date:** 2026-07-01
**Trigger:** The framework-side counterpart to `macf-devops-toolkit` DR-006 (VM watchdog / supervision) and DR-007 (fleet-upgrade orchestration) + its Amendments A (host-local plane) and B (distribution contract). Those DRs are the *devops design + VM reference implementations + the delegation triggers*; this DR captures the **framework contract** they consume and promote into: the canonical `macf` subcommands, the `/health` contract additions, the two-plane model, and — load-bearing — the **distribution contract** (`capability-in-CLI / config-local / cluster-via-gitops`). Recommended in the DR-007 #139 review and again in the #141 (Amendment B) review; authored by science as the framework-canonical consolidation. Build tracked in `macf#682` (`fleet upgrade`), `#683` (`ps` version), `#685` (`restart-self` session-safety), `#686` (the operational-layer promotion).

> **Why a framework DR, not just a devops-toolkit doc.** The `macf` binary is the only artifact distributed to every VM. Any fleet-operations *capability* that must run on the VMs therefore has to live **in** the binary, not beside it in a repo the VMs never clone. That makes the command surface, the `/health` contract, and the distribution split **framework architecture decisions** — DR-030/031 already established this pattern (the fleet-health commands + supervision primitives are `macf`; the cron/orchestration is devops). This DR generalizes that split to the whole fleet-operations layer.

---

## Decision 1 — Two planes; never conflate them (DR-007 Amendment A)

Fleet operations read two *different* views of "the fleet," and the original DR-007 §1–4 blurred them. They must stay distinct:

| Plane | Source | Answers | Needs | Scope |
|---|---|---|---|---|
| **Routing / delivery** | the **registry** (per-fleet GitHub org-vars, DR-006) | *reachability* — who is registered + alive-ish, at `host:port` | repo + network + auth | **per-fleet** (a fleet == a registry) |
| **Host-operational** | a **local scan** (workspaces + processes + on-disk pin + tmux) | *"what macf agents live on THIS box — alive or dead, at what version, busy or idle"* | **nothing** (no repo, no network) | **per-host** (all fleets on the box) |

- **The registry is the routing plane** — correct for delivery and for upgrade *selection isolation* (`--fleet <name>` / `--registry <owner/repo>`; a fleet's version-target advances independently; MACF upgrading must not touch CV).
- **The host-operational plane is a local scan** — enumeration and reasoning (`alive/dead + version + idle/busy`) are **registry-independent, exactly like K8s**: on K8s this is `kubectl get pods -l app=macf` (the control plane); on a VM it is **`macf ps`**. Enumeration MUST NOT depend on any repo.
- **Consequence:** the fleet-upgrade decision layer enumerates + reasons from the **host-operational plane** (all local), touching the registry only for the routing it is actually for — or not at all on a pure-local upgrade.

**`macf ps` is the host-operational plane.** Its required shape (build in `macf#682`/`#683`): union **running processes** with **known agent workspaces** (local `.macf/` + `desired-agents.yaml` markers — NOT the registry) → mark each **alive/dead**; resolve **version** locally (cs process → on-disk `package.json`; works for a dead agent from the pin — shipped `#683`); cross-platform (workspace-scan is filesystem-portable; only the alive-match needs `ps`/`lsof` vs `/proc`). **Open:** bound the workspace-scan to a configured root-set (not a full-FS walk per invocation).

---

## Decision 2 — The distribution contract: the binary IS the delivery channel (DR-007 Amendment B)

The `macf` binary is the only thing delivered to every VM (`npm i -g` + `macf init`/`update`). So fleet-operations work has **three homes by kind**, and putting a capability in the wrong home means the VMs never receive it:

| Kind | Home | Distribution |
|---|---|---|
| **Capability** — the upgrade orchestrator, the watchdog reconciler, resume/nudge-report, `restart-self`, install-cron | a canonical **`macf` subcommand** | rides the **npm package** → every VM via `npm i -g` + `macf init`/`update` (already the channel) |
| **Per-VM config** — `desired-agents.yaml`, cron schedule, endpoints, alert-repo | **local on each VM** | seeded by `macf init` / bootstrap per VM — never one-size-distributed |
| **Cluster-side** — the watchdog-heartbeat PrometheusRule, dashboards | the **gitops repo** | argocd → the monitoring cluster (already solved) |

- **The devops `fleet/*.sh` are reference implementations + the interim** (VMs clone the repo until the subcommands land), NOT the distributed artifact. The distributed artifact is the CLI. This is the DR-006/007 build-split generalized to *delivery*: **devops designs + proves; the canonical `macf` subcommand is what ships.**
- **The recursion (load-bearing):** once `macf fleet upgrade` is distributed, *it* is how future macf-binary updates roll across the fleet, and `macf init` bootstraps a new VM. **`init` seeds; `fleet upgrade` sustains.** The operational layer becomes self-distributing via the binary.

---

## Decision 3 — The decision/driver split is a framework interface (DR-007 §1–2)

Fleet-operations that mutate agents (upgrade, restart, reconcile) are **a runtime-agnostic decision layer over a pluggable per-runtime driver**, and the boundary is a framework contract, not an implementation detail:

- **Decision layer (runtime-agnostic)** — drives off self-reported state (`/health`: roster + version + idle/busy) + the host-operational plane; computes who-is-behind / who-is-unhealthy; sequences the rolling action (busy-gate → act → verify-green → next). **Never** touches `/proc` / tmux / kubectl directly.
- **Driver layer (pluggable, per-runtime)** — the ONLY place the runtime leaks: VM (Linux/macOS) = `macf update` + `restart-self`; K8s (future *macf operator*, a separate DR) = patch image + cycle pod. Both register + serve `/health`, so the decision layer is identical across runtimes.
- **Hard rule:** nothing runtime-specific leaks above the driver line. A canonical `macf` subcommand MUST honor this (the devops VM reference impl may couple to `/proc`+tmux; the canonical must not, or K8s means a rewrite). The **busy-gate is why the orchestrator is its own runtime-agnostic thing** and not a shell-out to a stock rolling primitive (`kubectl rollout restart` evicts a busy agent mid-turn — forbidden).

---

## Decision 4 — The `/health` contract is the universal decision substrate; it needs `version`

The decision layer stands on self-reported facts, so they belong in the `/health` contract (portable across VM and pod):

- **idle/busy** — already reported (`fleet status` STATE). The don't-interrupt signal, self-reported, no `/proc`.
- **`/health.version`** — the agent self-reports its running framework version. Runtime-portable (a VM's pin and a pod's image tag answer the same probe) — unlike reading `macf-agent.json`, which is VM-only. Surfaced as a `VERSION` column in `fleet status`/`ps` + `--json`. **The version-visibility blocker for targeting an upgrade.** (Note: `macf ps`'s host-local version is resolved locally per Decision 1; `/health.version` is the routing-plane/cross-runtime equivalent — both must agree.)

---

## The fleet-command family (the canonical surface)

`macf` becomes the fleet-operations CLI (the kubectl analog), each command honoring the plane it belongs to:

| Command | Plane | Status |
|---|---|---|
| `macf ps` (alive+dead, versioned, cross-platform) | host-operational | version shipped `#683`; dead-agents + macOS → `#682`/`#686` |
| `macf fleet status` / `fleet doctor` / `routing doctor` | routing | shipped (DR-030) + guest-visibility (DR-036 Amendment A, `#681`) |
| `macf fleet upgrade` (decision layer + fleet/registry selection + multi-select) | both (enumerate host-local, isolate per-registry) | `#682` |
| `macf restart-self` (session-safe clean restart) | driver primitive | shipped + `#685` |
| `macf watchdog reconcile` / `macf fleet resume` / `macf watchdog install-cron` | driver + decision | `#686` (operational-layer promotion) |

Implementation language of a promoted subcommand (bash-wrap of the proven devops reference impl vs native TypeScript) is code-agent's call per command.

---

## Build split & ownership

- **Framework (code-agent):** the canonical subcommands above, `/health.version` + the `VERSION` column, the decision/driver interface. Tested in `make check`; distributed via npm.
- **Devops-toolkit (devops):** the VM reference implementations (`fleet/*.sh`) + the operational proof + the per-VM config (`desired-agents.yaml`, cron) + the cluster-side gitops (PrometheusRule/dashboards) + the delegation triggers (DR-006/007 + Amendments).
- **Future (code/science):** the *macf operator* (the K8s driver) — its own DR; consumes the same `/health` contract + decision layer.

---

## Boundaries / non-goals

- **Not** a re-design of DR-006/007 — this consolidates their framework-facing contract (the commands, the `/health` additions, the two-plane + distribution models) into the canonical layer.
- **Not** the macf-operator design — deferred to a future DR; this only fixes it as *the K8s driver* consuming the same contract.
- **Not** `kubectl rollout restart` or any busy-blind rolling primitive — the busy-gate forbids it.
- **Config is never one-size-distributed** — per-VM config stays local (seeded by `init`), only capability rides the binary.

---

## Open questions

1. **Workspace-scan root** for the host-operational plane — a configured root-set vs a discovery mechanism (avoid a full-FS walk per `ps`). Lean: a small config of known workspace roots, seeded by `init`.
2. **Version-target source** per fleet on upgrade — explicit pin (`--target`) vs npm-latest default. Lean: explicit-pin-with-`--target` (deterministic > "whatever's latest today"); npm-latest as the convenience default (DR-007 OQ2).
3. **Promotion language per subcommand** — bash-wrap the proven reference impl (fast, keeps the tested logic) vs native TS (portable, in `make check`). Per-command, code's call.
4. **`ps` version vs `/health.version` agreement** — the host-local pin and the self-reported running version can differ (pin bumped, not yet relaunched). `ps` should show both ("pinned X, running Y") so a mid-upgrade state is legible.

---

## Cross-references

- `macf-devops-toolkit` **DR-006** (VM watchdog / supervision) + **DR-007** (fleet-upgrade orchestration) + **Amendments A** (host-local plane) **/ B** (distribution contract) — the devops design + reference impls this DR is the framework contract for.
- **DR-030** (fleet-health commands) / **DR-031** (supervision primitives + reconciler) — the same framework/orchestration split, of which this is the generalization.
- **DR-033** (`#684`, auto-responder) — the unattended-operation unblock the upgrade loop depends on (a relaunched agent's launch-prompts).
- **DR-036** (cross-fleet delegation) — fleet-upgrade selects registry *members*, never guests (a guest is in a different registry) — the visibility-vs-supervision invariant, for free.
- Build: `macf#682` (fleet upgrade), `#683` (ps version), `#685` (restart-self), `#686` (operational-layer promotion).
