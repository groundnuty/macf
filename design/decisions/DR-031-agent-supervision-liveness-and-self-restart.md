# DR-031: Agent supervision — liveness contract + portable self-restart

**Status:** Accepted
**Date:** 2026-06-26
**Ratified:** 2026-06-26 by the operator ("DR-031 Accepted") — as the aligned pair with `macf-devops-toolkit` DR-006 (the VM realization). Establishes agent supervision as **desired-state reconciliation** (reconcile actual → operator-owned desired; the don't-fight-a-deliberate-stop property + cold-start fall out of the model), the minimal agent-owned surface (`/health` + be-replaceable), upgrade-as-substrate-capability (VM self-restart / K8s GitOps), graceful-deregister + registry TTL as the #553 root-cause fix, and the `host-prelude` toolchain re-establishment. Scoped to VM + K8s (cloud out-of-scope with rationale; Managed-Agents-self-hosted a future spike). Build is phased (framework root-cause first, then the devops VM reconciler), code + devops.
**Trigger:** The 2026-06-26 incident — `macf-devops-agent` silently went off-channels after a relaunch (the `macf#553` collision-abort left a healthy-looking-but-deaf agent + a stale registry entry; the operator had to hand-relay a peer's review). "Idle because there's no work" and "idle because I've gone deaf" are indistinguishable from inside the agent, so the fleet blocks and nobody knows — a single-point-of-fleet-failure of the silent-fallback hazard class applied to liveness. Design drafted by devops + the operator (`macf-devops-toolkit#115`), reviewed by science, graduated here. Sibling to DR-030 (detection); this is the **action/supervision** tier.

## Context

The fleet has three planes of health, increasing in abstraction:

| Layer | Question | Where |
|---|---|---|
| **Supervision (this DR)** | Is the agent *reachable*, and if not, heal it. The dumb, always-on **liveness floor**. | DR-031 + a devops-toolkit impl DR |
| **Detection (DR-030)** | Is the *interconnect* healthy? On-demand operator diagnostic. | DR-030 (`macf fleet`/`macf routing`) |
| **Reasoning (DR-026)** | Is the *coordination* behaving — norms, patterns, governance? | the auditor (`macf monitor`) |

These compose, they don't overlap: **the auditor reasons assuming agents are reachable; DR-031 is the floor that keeps them reachable** — the auditor literally stands on it. DR-030 *detects* a malfunction on demand; DR-031 *acts* on it always-on. An agent can be alive-but-channel-down (the #553 collision-abort), alive-but-registry-stale (dead port), or fully dead — in every case peers route to it, the route silently fails, coordination stalls, and the only signal is a human eventually noticing.

## Decision

The supervision **model is desired-state reconciliation** (the Kubernetes model): a stateless reconciler continuously drives *actual* fleet state toward an **operator-owned *desired* state** (which agents should run, at which versions). "Restart a deaf agent" is one reconciliation action among several — this single reframe subsumes the whole problem space:

- **cold-start / one-command launch-all** = reconcile from empty;
- **VM-reboot recovery** = the same reconcile on the first post-boot run (automatic);
- **per-agent heal** = the tiered ladder (below), for a *desired-up but deaf* agent;
- **don't-fight-the-operator** = a deliberate stop **updates desired state** (or sets a per-agent `paused` flag); the reconciler skips desired-down agents and **never resurrects them**. This is load-bearing: a bare liveness watchdog cannot distinguish "operator stopped it" from "it crashed," so it *would* fight a deliberate exit — the desired-state model is the fix, and it is the same model that yields cold-start. On K8s this is native (`replicas`; `scale --replicas=0` = desired-down); on the VM it is a tiny reconciler (DR-006) reading an operator-owned desired set + per-agent intent.

**The agent owns a minimal, substrate-identical surface** (identical on VM, container, any harness):
1. **A `/health` liveness contract** — expose it.
2. **Be replaceable** — restartable/killable so the substrate can reconcile it (VM: a `restart-self` verb; K8s: exit / be-killed → kubelet respawns).

*Who* probes, *what* restarts, *who upgrades*, and *what the desired set is* are the substrate's/operator's job (cron now, kubelet later). Swapping Claude Code → another harness, or VM → pod, leaves the agent surface unchanged — that is what makes supervision portable.

### Two invariants (everything follows)

1. **Out-of-band.** The check must NOT ride the channel it's checking — if the channel is down, anything using it can't detect or fix it. Probe via registry + mTLS `/health` + tmux/process — none depend on the (possibly-broken) channel.
2. **Always-on, even when idle.** The failure state *is* idleness, and the harness doesn't self-fire when idle. The trigger must be **external** (a timer), not the agent itself.

These rule out: self-check-only (can't detect own deafness), peer-mutual-watch as primary (makes liveness depend on other deaf-able LLM agents), and harness-internal schedulers as primary (die with the session + vendor-lock — §"Triggers").

### The liveness contract (`/health` — ONE contract with DR-030)

DR-031's `/health` is **the same `/health` DR-030 §5 extends — hardened for liveness, not a parallel one.** The probe chain (any link broken = the same silent symptom):
1. registry entry exists (`MACF_AGENT_<ROUTING_LABEL>` — the #538 routability key);
2. its `host:port` answers **mTLS `/health`** (using the routing-client cert — *exactly* what the v3 router sees);
3. `/health` identity matches the expected agent (`instance_id` + port — DR-030's registration-freshness; catches drift, disambiguates the #553 dying-server race);
4. the tmux session / process is alive.

Plus a **registry heartbeat/TTL** (the channel server stamps "alive at \<t\>"): staleness becomes self-evident (a passive check, no live probe) and dead entries self-expire — the TTL `macf#553` also calls for. **The probe primitive is shared, not duplicated:** it is `macf fleet doctor` (mesh-Reachable) + `macf routing doctor` (registration-freshness) + `macf#556`'s dead-vs-alive `/health` check. The supervision watchdog **consumes those** (next section), it does not re-implement them.

### The reconciler — stateless one-shot, substrate-native trigger

The reconciler is a **stateless one-shot** (read desired-state → probe actual → reconcile the delta → exit); the *trigger* is substrate-native. (On the VM the "reconcile" step is the tiered ladder + launch-the-missing; on K8s the controller does it natively.)

| concern | VM (today) | Kubernetes (future) |
|---|---|---|
| periodic trigger | user-level **cron** | **kubelet liveness probe** on `/health` |
| supervision / respawn | cron one-shot + detached relauncher | `restartPolicy` (native) |
| self-restart | detached `setsid`/`nohup` relauncher | exit PID 1 / liveness-fail (native) |
| restart-loop → operator | watchdog threshold + alert issue | `CrashLoopBackOff` (native) |
| env / toolchain | `host-prelude` (brew shellenv) | `host-prelude` no-op (image PATH) |
| desired set / intent | operator-owned desired set + `paused` flag | Deployment `replicas` (`scale --replicas=0` = down) |
| **agent-owned surface** | **`/health` + be-replaceable** | **`/health` + be-replaceable** |

`cron ⇿ kubelet-liveness` is the clean 1:1 — same role, both substrate-native, **zero bespoke daemon**. The VM cron is explicitly *scaffolding that K8s's native liveness replaces*. **Not systemd** (container-hostile: no systemd in standard containers, wants PID 1 + cgroup ownership, `systemctl --user` needs a D-Bus/logind session containers lack — choosing it *forces* a two-mechanism split). **Not the harness's own scheduler** (`/loop`/hooks): it dies with the session (covers alive-but-deaf, not total crash) and is vendor-lock; keep it at most as a thin optional inner layer.

**The watchdog consumes DR-030's detection:** it shells out to `macf fleet doctor --json` + `macf routing doctor --json`, parses the verdict, and acts. **DR-030's `--json` schema IS the watchdog's input contract** (this is who DR-030's `--json` is for; state both sides). The watchdog runs from cron — i.e. *outside Claude Code's sandbox*, which is exactly DR-030 §7's required execution context; the `host-prelude` (below) makes the CLI runnable there. **Free detection via the router:** the v3 router reads the registry on *every* route, so a stale heartbeat / failed `/health` there can alarm "this agent looks deaf" as a side effect of normal traffic — covering *routed* agents; the cron sweep then only has to cover the **idle gap** (agents nobody is currently routing to).

### Tiered response — the delivery-confirmed-or-fall-through ladder

1. **Tier 1 — inject a self-diagnose prompt** (via the canonical `tmux-send-to-claude.sh`, harness-agnostic): *"⚠️ You appear OFF-CHANNELS: registry says :PORT, port DOWN, last health \<t\>. You're silently not receiving messages — investigate, clear any stale entry, request a relaunch."* The agent wakes + self-heals with full context.
2. **Tier 2 — `restart-self`** the one thing the agent can't do mid-deafness. Gated (confirmed off-channels + idle, after a commit + RESUME-note window).
3. **Tier 3 — escalate to the operator** (open/raise an alert issue) on persistent failure / restart-loop. Silent fleet-block becomes a **loud alarm** — the single most important property.

**Ladder doctrine (load-bearing): every rung must be delivery-confirmed or fall through — a ladder with a silent rung is no ladder.** Tier 1 specifically rides `tmux send-keys`, which **silently no-ops against an RC-bound TUI** (silent-fallback **Instance 3**) exactly when needed. So the watchdog gates Tier 1 with the **Pattern-C `session_activity`-advanced check**; an un-confirmed-delivered inject **falls through to Tier 2**. The same principle applies at every rung: never assume a response landed — verify the result-invariant, else escalate.

### Be-replaceable (the restart verb) + upgrade-as-substrate-capability

The naive self-kill is suicide (an agent that `tmux kill-session`s its own session dies mid-command with no respawn). The restart must **outlive the agent's death**: VM = a detached `setsid`/`nohup` relauncher (commit + RESUME-note, then kill + relaunch); K8s = exit PID 1 / fail liveness / self-delete (kubelet respawns).

**Upgrade is a substrate-provided capability — NOT a uniform agent-owned one.** On the **VM**, the restart verb *is* co-equally the upgrade primitive (one verb, two drivers): a **fault driver** (the reconciler says "restart") and an **upgrade driver** (a version-check — "am I on the pinned channel-server/plugin/claude?", source **DR-029 / the registry `versions` block** — "if behind, restart-self with new bits"). But that is the **VM** realization and does **not** generalize: on **K8s** images are immutable, so an upgrade is a **new Deployment revision driven externally by GitOps** — the agent doesn't self-check-version-and-restart, it is simply *replaced*. So **"desired version" is just another facet of the desired state** the substrate reconciles; *who upgrades* differs by substrate while the agent stays passive/replaceable:

| | restart | upgrade |
|---|---|---|
| **VM** | self-restart (detached relauncher) | **self** — version-check → `restart-self` with new bits |
| **K8s** | kill pod → kubelet respawns | **GitOps** — bump image, controller reconciles; agent passive |

Upgrade adds over fault-recovery: **staging** (new bits in place before restart); **rolling sequencing** (never all-at-once — reconcile one, verify green via `macf fleet doctor`, then the next); **rollback** = the Tier-3 escalation (restart-loop → operator). We just paid the *manual* version — the Stage-3 migration hand-relaunched every agent to adopt the new launcher/plugin/caller (a mixed-routing window + total-fleet-loss risk); the automated rolling reconcile is the durable fix.

### Graceful-shutdown deregistration + registry TTL — the #553 root-cause fix

#553's collision was a *symptom* of stale-registration-never-cleaned; #557 fixed the *takeover* (re-confirm liveness before aborting). The root cause is upstream: a clean shutdown should **deregister** (remove its `MACF_AGENT_<LABEL>` entry), and entries should carry a **TTL** so a dirty death self-expires. Together they prevent the stale entry at the source, closing #553's own "TTL also called for" loop and shrinking the watchdog's failure surface so it rarely fires. **Phase 1.**

### Portable bootstrap — `host-prelude` (converges with DR-029)

cron and a container entrypoint have a minimal env; `claude.sh` today *inherits* the user's login-shell toolchain. The reframe: **the launch must *re-establish* its toolchain, not *inherit* it** — then login / cron / container-entrypoint are identical. Mechanism: a **`host-prelude.sh`** every entry point sources first, using absolute paths (`eval "$(/home/linuxbrew/.../brew shellenv)"`), proven on real cron (devops#115 §10: `claude` MISSING → FOUND). **This is the same `host-prelude` slot DR-029's launcher template already carries — extend it, do not fork a parallel prelude.** Toolchain-detected at `macf init` (brew / devbox-nix / container-no-op), and the **dynamic** re-source form (not a frozen PATH snapshot) so it can't go stale.

## Boundaries

- **DR-030 (detection):** DR-031's watchdog *consumes* DR-030's `--json` probes; one `/health` contract across both. DR-031 adds the trigger + ladder + `restart-self` + bootstrap + upgrade that DR-030 doesn't have.
- **DR-026 auditor (reasoning):** the auditor reasons over coordination *assuming* the liveness floor; DR-031 *is* that floor. The auditor consumes the guarantee, doesn't re-implement it.
- **`macf#556`:** the dead-vs-alive `/health` primitive (`registry prune`) is shared as the probe primitive.
- **`macf-devops-toolkit` impl DR (devops):** the VM-cron-watchdog realization (the cron one-shot reconciler, the tiered ladder with the Tier-1 gating, idempotent cron registration on launch, the watchdog self-heartbeat, the operator-owned desired-set + `paused` mechanism, the K8s liveness/restartPolicy manifests) references this DR. The §10 cron-prelude empirics + the why-not-systemd analysis are settled there.

## Substrate scope (in / out, with rationale)

Supervision + routing target **VM + Kubernetes** — the two substrates where an agent can be a push-routed peer (inbound mTLS + tailnet + persistence) and be reconciled to a desired set. **Anthropic-cloud substrates are out-of-scope *by rationale*, not by accident:** interactive cloud-hosted Claude Code cannot be a push-routed peer (no inbound reachability, no tailnet, no persistence across turns), so the `/health`-probe + mTLS-fan-out + reconcile model does not apply. **Managed Agents (self-hosted) is a noted *future spike*, not a fold-in:** it inverts delivery to a **poll-queue** (no inbound needed) with tool-execution on our infra, and natively provides `workers_polling` liveness + `work.stop` + agent-versioning — i.e. it could *replace* much of DR-031's machinery for that substrate. Strategic + separate; cite `macf-devops-toolkit:research/2026-06-26-claude-code-on-anthropic-cloud-for-macf-agents.md`.

## Ownership / build split

- **Framework (code-agent, `groundnuty/macf`):** the `/health` liveness-contract hardening (one contract with DR-030 §5) + the `restart-self` verb + **graceful-shutdown deregistration** + the registry **heartbeat/TTL** + the toolchain-detected **`host-prelude` generator** in the launcher template (DR-029 slot). Shares DR-030's `/health` schema + `macf#556`'s probe. **Note (the "be-replaceable" reframe re-labels, does not expand, this build):** "be-replaceable" is *satisfied by* graceful-deregister (a replacement instance doesn't `AGENT_COLLISION` with the dying one — #557's race writ large) + the registry TTL (the dead slot frees for the replacement) + (VM) `restart-self` as the VM *realization* of being replaced. So `restart-self` stays a framework deliverable, scoped as the VM realization in the capability matrix — not dropped, not a universal agent primitive. The desired-state reframe sits *above* this surface (the reconciler + the operator-owned desired set / `paused` intent flag are the watchdog's + registry's concern, devops-side) and doesn't change what the agent exposes.
- **Devops (`macf-devops-toolkit`, its own DR):** the cron watchdog + K8s manifests.
- **Design (science):** this DR + the DR-030 family coherence.

## Phasing

1. **Framework root-cause first:** graceful-deregister + registry TTL (shrinks the failure surface) + the `restart-self` verb + the toolchain-detected `host-prelude`.
2. **Devops VM v1:** cron watchdog with Tier-1 (gated inject) + Tier-3 (alert) + the watchdog self-heartbeat; hold Tier-2 (auto-restart) behind operator sign-off.
3. **Upgrade dual-use:** the version-check driver (DR-029 `versions`) + the rolling sequencer.
4. **K8s:** replace cron+watchdog with native liveness/restartPolicy when agents become pods; the agent contract (`/health` + `restart-self`) is unchanged.

## Consequences

- A silent fleet-block becomes a loud, escalating alarm — the single most important property — and most cases self-heal before a human is involved.
- The agent surface stays two constants (`/health` + `restart-self`), so the supervision is portable across harness + substrate by construction.
- A `/health` schema + a `restart-self` verb on the channel server (the latter must be safe — it commits + RESUME-notes before killing).
- The same machinery automates fleet upgrades (rolling restarts), retiring the manual hand-relaunch we just lived.

## Open questions

1. Tier-2 auto-restart gating: inject-first vs. auto on confirmed-dead-and-idle (lean: inject-first, auto after N failures + idle).
2. Heartbeat cadence + TTL window vs. restart latency.
3. Single per-host watchdog vs. mutual/redundant (lean: single per-host v1; the watchdog self-heartbeat + Tier-3 terminates the who-watches regress at the operator).
4. Generate-at-init vs. detect-at-runtime for the prelude's toolchain backend.

## Amendment (2026-06-28, `macf#642`/#643) — the stdio-coupling death mode: HEAL detects + relaunches; whether that's the full fix or a stopgap is the open question the `#642` reproduction decides

A death mode this supervision model **detects + relaunches**: the channel-server is a **stdio MCP child of Claude Code**, so its survival is coupled to the main agent's activity — under heavy main-thread load CC stops servicing the stdio pipe, deems the connection dead, and kills the child, which is **never auto-respawned** (observed 2026-06-28: code-agent's server died silently at 7.4 h under ~880k-token load; science's *idle* server ran 9.5 h — the activity differential is the diagnosis).

- **Detection is covered.** The liveness probe (mTLS `/health` reachability) catches "channel-server dead, main agent alive" → the reconciler HEALs (relaunch). No new detection needed — exactly the deaf-but-up case the floor exists for. This HEAL is a correct backstop **regardless** of the root cause.
- **Whether HEAL is the full fix or a stopgap is OPEN, pending the `#642` reproduction** (verify-before-claim — do not assert mechanism-as-fact). If the death is the **child blocking its own event loop** (sync ops), the chosen **harden-the-stdio-child** path (`#642`/#643: forensic log + crash handlers + async-responsiveness) is a **full fix** and HEAL is belt-and-suspenders. If CC **starves the pipe regardless** of child responsiveness, hardening is mitigation and the transport revisit (Path B) leads.
- **Chosen direction (operator, 2026-06-28): harden the stdio child, NOT re-architect the transport.** Verbatim: *"I prefer 'CC spawns + owns it as a child'… first let's harden it and not make it more complicated."* **Path B (HTTP/SSE standalone service) was considered + DROPPED on complexity**; it's the leading revisit IF the reproduction shows hardening insufficient. Tracked in **DR-022 Amendment P**.

So the honest layering: **supervision (this DR) keeps the agent reachable by relaunching a dead server (always correct); the chosen harden-stdio work (`#642`/#643) aims to stop it dying — and the reproduction decides whether that suffices or a transport change is also needed.** The B-vs-harden final call is the operator's.

## Amendment (2026-06-28, `macf#128` / `macf-devops-toolkit#128`) — the probe-target ≠ action-target gap: an aliveness-gate MUST precede Tier-2 restart

A model sharpening the §"Tiered response" ladder needs, found by a live near-miss: **the liveness probe measures the *channel-server* (`/health` reachability), but Tier-2 restart acts on the *whole agent* (the TUI / tmux session).** These are different targets. So `reachable=false` has **two causes**, only one of which warrants a restart:
1. the agent is genuinely dead → restart is correct; or
2. the **channel-server died but the agent TUI is alive and working** (the `#642` stdio-starvation mode: CC starved the channel-server's pipe while the agent itself was mid-task).

In case 2, a naive "`reachable=false` → restart" **SIGTERMs a working peer mid-task.** (Real near-miss, 2026-06-28: code-agent read `reachable=false` while actively working; only a pane capture revealed it was alive — a restart would have killed it.)

**The fix (shipped — `macf-devops-toolkit#128`): an execute-time aliveness-gate before Tier-2.** Sample the agent's tmux pane `session_activity` over a short window; **if it advanced (agent busy) → ABORT the restart** (never apply a destructive recovery to a working agent); no-session → genuinely gone → restart proceeds. Held behind `--allow-restart` AND the gate (defense-in-depth). Fail-safe: a false-"busy" merely delays a needed restart (recoverable next sweep); a dead agent has no session → not busy → restart proceeds. (This reuses the silent-fallback Instance-3 `session_activity` primitive as an *aliveness* signal — inverse of its tmux-wake use.)

**The constitutional refinement to §"Tiered response":** **never apply a destructive recovery (Tier-2 SIGTERM) to a working agent** — disambiguate the probe-target/action-target mismatch with an aliveness-gate first. Detection (the `/health` probe) is correct as-is; it is the *action* that must gate on a second, agent-level signal.

**Residual (follow-on, ties to the `#642` harden work):** the **idle-AND-channel-dead** agent (TUI alive but idle, channel-server dead) reads not-busy → Tier-2 restarts the *whole TUI* to recover a dead *child* server — heavier than necessary. If the `#642`/#643 harden work makes the channel-server child independently restartable, prefer a **server-only restart** when the TUI is alive (gentler than a full agent restart); at minimum log the two cases distinctly (restart-alive-but-idle-to-recover-channel vs restart-dead-agent) so the forensic trail distinguishes a recovery from a crash. Increment-N, not blocking.

## References

DR-030 (interconnect detection — the sibling) · DR-026 F4 (`macf monitor` — the reasoning layer above) · DR-029 (substrate config + the launcher-template `host-prelude` slot + the `versions` block) · DR-005/DR-006 (registration + registry scope) · silent-fallback-hazards Instance 3 (RC-bound tmux send-keys) + the liveness application of the class · `macf#553` (collision / graceful-deregister / TTL) · `macf#556` (dead-vs-alive `/health` / `registry prune`) · `macf#560`/DR-030 (`--json` = the watchdog's input contract) · `macf-devops-toolkit#115` (the design session + §10 cron-prelude empirics + §6 why-not-systemd) · the forthcoming devops-toolkit implementation DR.
