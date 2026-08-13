# DR-037: The fleet operational-layer as canonical CLI — two planes, decision/driver contract, distribution, workspace discovery

**Status:** Accepted (ratified by operator 2026-07-01; see macf#689)
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
| **Routing / delivery** | the **registry** (per-fleet GitHub org-vars) | *reachability* — who is registered + alive-ish, at `host:port` | repo + network + auth | **per-fleet** (a fleet == a *project* — see Amendment A; == a registry only when one project owns the registry) |
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
- **Shape (per workspace):** `{ agent (routing-label), workspace, project, registry, versionPin }`. `ps` adds alive/dead (process↔cwd match); upgrade groups by **`project`** (→ fleets, per-fleet target — see Amendment A; `registry` is a demoted non-grouping identifier); the watchdog reconciles the desired-set.
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

## Amendment A — the fleet-grouping key is `project`, not `registry` (macf#710, 2026-07-01)

**Decision 1 as originally written ("a fleet == a registry") conflated two boundaries that coincide only in the one-project-per-registry case.** Surfaced by the live `groundnuty`-profile registry hosting *two* projects (the `macf` substrate fleet + the `icsoc_2026` fleet, via the DR-036 cross-fleet / DR-035 bootstrap work): `fleet upgrade` grouped by the profile-scope registry identifier (`groundnuty`), collapsing both projects into one "fleet," so a driver built from one project's workspace probed the other project's agents with the **wrong CA** → false-negative `UNREACHABLE` (fix: PR #719, macf#710).

**The two boundaries:**
- **Routing / registry-namespace** — registry-scoped (where agents self-register + resolve each other). Decision 1's original routing-plane context; unchanged.
- **Upgrade / probe** — the **CA** boundary. `fleet upgrade`/`reconcile` build a per-fleet driver that mTLS-probes `/health`, and the CA is **project**-scoped (`MACF_CA_CERT` ≠ `ICSOC_2026_CA_CERT`; the driver looks up `${toVariableSegment(project)}_CA_CERT`), as is the registry namespace (`MACF_AGENT_*` vs `ICSOC_2026_AGENT_*`).

**The refinement:** the **fleet-grouping key for the operational plane is `project`** — the CA + registry-namespace boundary. It *coincides* with the registry scope only when a single project owns the registry (the common case, which is why "== a registry" held until now); under a **shared profile/org-scope registry hosting multiple projects, `project` is the correct finer key.** A driver bound to one project's CA cannot probe another project's agents by construction, so grouping must never cross a project boundary. `WorkspaceRecord` gains a `project` field as the grouping key; `registry` is demoted to a non-grouping identifier.

**Consequences:**
- `fleet upgrade`/`reconcile`/`ps` group by `project`; per-fleet version-target is per-project.
- The `--registry` selector is a mild misnomer under this refinement (a fleet is a project); it is kept as a working, documented alias to avoid a breaking CLI change, with `--fleet` as the canonical spelling and `--registry` deprecated-in-favor-of-`--fleet` as a follow-up (macf#710 Q2).
- Cross-references that cite "fleet == registry" (DR-008/`#704` durable-substrate framing; the add-agent runbook; DR-007 fleet-enumeration) read correctly under the coincidence case; where a profile registry hosts multiple projects, read "fleet == project" per this amendment.

## Amendment B — verify-green is a THREE-outcome gate; continue only on confirmed green (macf#722, 2026-07-01)

**The rollFleet HALT contract as originally shipped ("HALT the roll on the first agent that doesn't verify-green within budget") conflated two failure shapes under one "not-green," and a live `macf fleet upgrade --target 0.2.47 --execute` on the substrate fleet (2026-07-01) exposed the false-positive:** the first agent (code-agent) relaunched slowly — `restart-self` kills the session + relaunches detached (~30s before the new session even starts) on a **fresh channel-server port the registry roster had not yet re-advertised** — so `verifyGreen` polled the stale endpoint, exceeded the budget, and HALTed the whole roll (devops/science never rolled), **though code-agent came up green on the target moments later.** The halt was spurious: a slow-but-fine relaunch, not a bad release.

**The root cause is a two-outcome model where there are three.** After `upgrade → restart`, `verifyGreen` can land in:
1. **came up GREEN (target)** → continue.
2. **came up on the OLD version** → confirmed bad release → HALT (reason `bad-release`).
3. **did NOT come up within budget** → **ambiguous**: a slow-but-fine relaunch, **OR a release that crashes on startup** (a bad release that never shows the old version — it just dies).

**The load-bearing correction — continue only on positive green confirmation, never on absence-of-failure.** A tempting fix ("not-yet-green → skip+continue") is **unsafe**: case 3 contains the crash-on-start bad release, and continuing there rolls the next agent → it also crashes → the bad release cascades across the fleet, defeating the whole point of no-cascade. "Absence of a failure signal" ≠ "confirmed fine" — the same Pattern-A / `silent-fallback-hazards` lesson (and the #700/#701 channels-guard lesson) applied to the roll. So:

- **Fix the spurious halt at its root (a budget/endpoint bug, not a HALT-policy relaxation):** extend the verify-green grace to cover real relaunch latency (session-death + startup + **re-register + roster-propagation of the fresh port**) AND re-resolve the relaunched agent's fresh endpoint from the registry roster with retry. A *fine* slow relaunch then confirms green **within** the grace → continues. (This is the mechanical half of DR-037 Decision 5's "verify-green re-resolves the endpoint," strengthened: re-resolve **with retry against a roster that lags the restart**, on a relaunch-aware budget.)
- **CONTINUE requires a confirmed green** (target version). Nothing else advances the roll.
- **HALT (terminal) covers BOTH remaining outcomes, with distinct reasons:** came-up-old-version → `bad-release`; past-grace-still-unconfirmed → `relaunch-unconfirmed` (a different operator message — "agent X didn't come back within Ns — investigate" — but still terminal, because you cannot safely proceed past an agent you couldn't confirm: a crash-on-start would cascade).

**Skip-BEFORE-roll continues; rolled-then-unconfirmed halts.** The safe skip-and-continue is for agents you did NOT mutate — **config-dirty** (Amendment-B Fix B, below) and **busy** are skipped *before* `upgrade`/`restart`, so the roll safely proceeds through them to the others. An agent that was *rolled* (upgrade+restart happened) and then can't be confirmed is the halt case. The clean line: skip-before-roll continues; rolled-then-unconfirmed halts.

**Fix B — config-dirty pre-flight skip (the stash-relaunch-wrong defect).** The same live run surfaced a second defect: `restart-self` stashes uncommitted *tracked* changes to relaunch clean (#711), but on a substrate workspace the operator's uncommitted `.claude/` config gets stashed → `macf update` regenerates **canonical** config → the agent relaunches on the *wrong (canonical)* config. Fix: a **pre-flight config-dirty gate** — before rolling an agent, if its workspace has uncommitted changes to the **operator-preserved config surface**, skip+report it (the busy-skip shape: "uncommitted config — commit or `--force`") rather than silently stash→relaunch-wrong; and `restart-self` refuses to stash config-surface files unless `--force`. **The config-surface path set is DR-029's operator-preserved boundary** (`env.local.*`, `.claude/**`, `CLAUDE.md`, `claude.sh`) — the stash-guard boundary == the DR-029 managed-vs-operator boundary, not an ad-hoc list. `macf fleet upgrade --force` threads the override through.

> **Correction (macf#725/#726, 2026-07-01 — supersedes this Fix-B paragraph's labeling + mechanism).** Fix B as written above has two errors, both surfaced by a live `macf fleet upgrade --execute` that aborted mid-roll: **(1) Mislabel.** The path set (`.claude/**`, `CLAUDE.md`, `claude.sh`, `env.local.*`) is NOT "operator-preserved" — it is the **pre-flight touched-surface UNION**: the files `macf update` OVERWRITES (managed — `.claude/rules/*.md`, `.claude/scripts/check-*.sh`, hooks, `.macf/*`, regenerated by design) ∪ the files `restart-self` STASHES (operator-preserved — `settings.local.json`, `rules/project/**`, `env.local.*`, `CLAUDE.md`, hand-authored `claude.sh`). Calling the whole set "operator-preserved" was wrong: the managed subset is `macf update`'s OWN output. Checking the union at pre-flight is correct (uncommitted work is lost either way — clobbered by update or hidden by stash); the error was the label, which led the impl to re-flag `macf update`'s own regeneration as "dirty" mid-transaction and abort every roll. **(2) Mechanism.** The guard is NOT "refuse to stash unless `--force` (force-stash)" — it is **object-with-message + leave-uncommitted**, per the transactional contract: pre-flight (before any mutation) — if any union-surface file is uncommitted → **OBJECT** (`config-dirty-skipped`, emit the file LIST + "inspect / commit / delete / .gitignore, then re-run"), mutate nothing; clean → run the transaction atomically, and the roll-path `restart-self` **leaves `macf update`'s regeneration uncommitted** (does NOT stash it — the relaunched agent sees it via `git status` + a modified-files message to review+commit) rather than force-stashing. `--force` proceeds despite dirt but STILL leaves-uncommitted (never stashes operator work). **Transactional invariant:** pre-flight-checks ⊇ everything-that-could-fail-later ⟹ pre-flight-pass GUARANTEES the transaction completes — never half-mutated (the #722/#725 mid-run-abort is closed). **Inter-roll steady-state (by design, documented):** a clean roll leaves the canonical regen uncommitted → the next roll's pre-flight objects on it (a self-correcting nudge to commit the canonical config update — correct repo hygiene, NOT a bug); auto-committing the deterministic regen to remove that friction is a deferred operator-call follow-up. Impl: `macf#726`. Standalone `restart-self` keeps its config-dirty guard for direct (non-roll) invocations.


**Consequences:** a slow relaunch no longer strands the fleet; a crash-on-start bad release still cannot cascade (halt-on-unconfirmed preserves no-cascade); a config-dirty substrate agent is skipped-not-relaunched-wrong. Build: `macf#722`.

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

## Amendment C — `stale-pin` is not `bad-release`: continue on a confirmed LOCAL cause, halt on anything fleet-wide or unconfirmed (macf#899/#900, 2026-08-13)

**Trigger — a live roll, and a flaw in Amendment B's own inference.** During the `0.2.56` roll, `devops-agent` came back **reachable at its old version** because its launch pin never asked for the new one (the pin-vs-mount bug, macf#889). Amendment B's line 144 — *"came up on the OLD version → **confirmed** bad release → HALT"* — fired and named the cause `bad-release`. That was **false**: `0.2.56` was fine. The blast radius of the mis-diagnosis: the whole fleet roll stopped to contain a bad release that did not exist, the operator was sent to prune a registry entry for a healthy release, and `macf-science-agent` lost its roll until the halt was cleared by hand.

**The flawed step was Amendment B's, not the implementation's.** Amendment B's governing rule is *"continue only on positive confirmation, never on absence-of-failure."* But "came up on the OLD version → **confirmed** bad release" silently assumes the release was **tried and rejected**. When the agent's launch pin never requested the target, the release was never exercised at all — the agent carries **no evidence about the release**. Halting there is halting on *absence of evidence*, presented as confirmation: the very move Amendment B exists to forbid, committed inside Amendment B.

**Decision — discriminate by the launch pin:**

| pin vs target | reason | disposition |
|---|---|---|
| pin **==** target, process on old version | `bad-release` | **HALT** (unchanged — a real bad release cascades) |
| pin **!=** target | **`stale-pin`** (new) | **skip that agent, CONTINUE the roll** |
| pin **unreadable** | `bad-release`, message marked **UNVERIFIED** | **HALT** conservatively |
| never answered within grace | `relaunch-unconfirmed` | unchanged (HALT) |

**No-cascade is preserved.** A stale-pin agent never exercised the target, so continuing risks nothing new; if the target genuinely crashes on start, the **next** agent fails to come up and halts as `relaunch-unconfirmed`. The protection still fires — one agent later, on real evidence.

**The unreadable pin: conservative halt, honestly named.** An unreadable pin is evidence of *neither* cause, so it must not silently become either — mapping it to `stale-pin` would skip an agent that might be crash-looping; mapping it silently to `bad-release` blames a release on missing information. The resolution keeps the **halt** (consequences are asymmetric: wrongly continuing past a real bad release cascades fleet-wide and unbounded; wrongly halting costs a paused roll with the operator already present) but marks the reason **UNVERIFIED**. That marking is load-bearing, not cosmetic: it fixes the second half of the #899 harm, where the operator was not merely stopped but *sent to prune a healthy release*. Halting conservatively while saying you do not know why is strictly better than halting confidently under a wrong name — honest-unknown applied to the diagnosis text, not only to control flow.

**Amendment B's "clean line" is refined (this supersedes it).** Amendment B wrote: *"Skip-BEFORE-roll continues; rolled-then-unconfirmed halts."* A **rolled** agent may now continue — when its cause is positively confirmed and provably local. The governing principle those collapse into:

> **Continue only on a positively-confirmed cause that is LOCAL to that agent; halt on anything fleet-wide, ambiguous, or unconfirmed.**

Rolled-vs-not-rolled was a *proxy* for that principle — a good one while every rolled-then-not-green outcome was ambiguous, and superseded the moment a confirmable per-agent cause existed. Amendment B's lines 144 and 153 read subject to this amendment.

**Implementation note (macf#900), recorded because it is what keeps the contract honest:** `readVersionPin` is a `FleetDriver` verb whose real implementation delegates to `resolvePluginUpdateTarget` + `readPinnedChannelServerVersion` — **the same primitives `macf update` uses for its own post-write verification**. One definition of "the launch pin," shared by the roll's diagnosis and the updater's self-check; two independent readers would have been free to drift, and a roll that disagreed with `update` about what the pin *is* would reproduce this class in the opposite direction. `stale-pin-skipped` is its own `RollOutcome` (the agent **was** mutated, so it is neither a pre-flight skip nor terminal), and the maintenance lock is deliberately **left in place** on that path (mirroring the halted branches, DR-040 Decision 3) so a still-old mid-transition agent is not handed straight back to the watchdog's healing ladder; the lock self-clears via TTL.

**References:** macf#899 (the live mis-diagnosis) · macf#900 (the discrimination) · macf#889 (the pin-vs-mount bug that produced the old-version agent) · Amendment B (lines 144/153, refined here) · DR-040 Decision 3 (lock-release-only-on-green) · `silent-fallback-hazards.md` Instance 20 (the wrong-subject write this incident began as).
