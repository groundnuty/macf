# DR-031: Agent supervision — liveness contract + portable self-restart

**Status:** Proposed
**Date:** 2026-06-26
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

Make every agent supervisable through a **minimal, substrate-identical surface**, and let the substrate provide the supervision:

**The agent owns exactly two things** (identical on VM, container, any harness):
1. **A `/health` liveness contract** — expose it.
2. **A `restart-self` verb** — be restartable.

*Who* probes and *what* restarts is the substrate's job (cron now, kubelet later). Swapping Claude Code → another harness, or VM → pod, leaves these two constants unchanged — that is what makes supervision portable.

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

### The supervision model — substrate-native triggers

The watchdog is a **stateless one-shot** (probe → act → exit); the *trigger* is substrate-native:

| concern | VM (today) | Kubernetes (future) |
|---|---|---|
| periodic trigger | user-level **cron** | **kubelet liveness probe** on `/health` |
| supervision / respawn | cron one-shot + detached relauncher | `restartPolicy` (native) |
| self-restart | detached `setsid`/`nohup` relauncher | exit PID 1 / liveness-fail (native) |
| restart-loop → operator | watchdog threshold + alert issue | `CrashLoopBackOff` (native) |
| env / toolchain | `host-prelude` (brew shellenv) | `host-prelude` no-op (image PATH) |
| **agent-owned surface** | **`/health` + `restart-self`** | **`/health` + `restart-self`** |

`cron ⇿ kubelet-liveness` is the clean 1:1 — same role, both substrate-native, **zero bespoke daemon**. The VM cron is explicitly *scaffolding that K8s's native liveness replaces*. **Not systemd** (container-hostile: no systemd in standard containers, wants PID 1 + cgroup ownership, `systemctl --user` needs a D-Bus/logind session containers lack — choosing it *forces* a two-mechanism split). **Not the harness's own scheduler** (`/loop`/hooks): it dies with the session (covers alive-but-deaf, not total crash) and is vendor-lock; keep it at most as a thin optional inner layer.

**The watchdog consumes DR-030's detection:** it shells out to `macf fleet doctor --json` + `macf routing doctor --json`, parses the verdict, and acts. **DR-030's `--json` schema IS the watchdog's input contract** (this is who DR-030's `--json` is for; state both sides). The watchdog runs from cron — i.e. *outside Claude Code's sandbox*, which is exactly DR-030 §7's required execution context; the `host-prelude` (below) makes the CLI runnable there. **Free detection via the router:** the v3 router reads the registry on *every* route, so a stale heartbeat / failed `/health` there can alarm "this agent looks deaf" as a side effect of normal traffic — covering *routed* agents; the cron sweep then only has to cover the **idle gap** (agents nobody is currently routing to).

### Tiered response — the delivery-confirmed-or-fall-through ladder

1. **Tier 1 — inject a self-diagnose prompt** (via the canonical `tmux-send-to-claude.sh`, harness-agnostic): *"⚠️ You appear OFF-CHANNELS: registry says :PORT, port DOWN, last health \<t\>. You're silently not receiving messages — investigate, clear any stale entry, request a relaunch."* The agent wakes + self-heals with full context.
2. **Tier 2 — `restart-self`** the one thing the agent can't do mid-deafness. Gated (confirmed off-channels + idle, after a commit + RESUME-note window).
3. **Tier 3 — escalate to the operator** (open/raise an alert issue) on persistent failure / restart-loop. Silent fleet-block becomes a **loud alarm** — the single most important property.

**Ladder doctrine (load-bearing): every rung must be delivery-confirmed or fall through — a ladder with a silent rung is no ladder.** Tier 1 specifically rides `tmux send-keys`, which **silently no-ops against an RC-bound TUI** (silent-fallback **Instance 3**) exactly when needed. So the watchdog gates Tier 1 with the **Pattern-C `session_activity`-advanced check**; an un-confirmed-delivered inject **falls through to Tier 2**. The same principle applies at every rung: never assume a response landed — verify the result-invariant, else escalate.

### `restart-self` — detached relauncher + dual-use (fault-recovery AND rolling-upgrade, co-equal)

The naive self-kill is suicide (an agent that `tmux kill-session`s its own session dies mid-command with no respawn). The verb is a relauncher that **outlives the agent's death**: VM = a detached `setsid`/`nohup` relauncher (commit + RESUME-note, then kill + relaunch); K8s = exit PID 1 / fail liveness / self-delete (kubelet respawns).

**`restart-self` is co-equally the *upgrade* primitive — not a bonus.** One primitive, two drivers:
- **Fault driver:** the watchdog says "restart" (above).
- **Upgrade driver:** a **version-check** — "am I on the pinned channel-server / plugin / claude?" (source: **DR-029 / the registry `versions` block**) — "if behind, request restart" — feeds the same path.

Upgrade adds over fault-recovery: **staging** (new bits in place before restart); **rolling sequencing** (never all-at-once — restart one, verify green via `macf fleet doctor`, then the next); **rollback** = the Tier-3 escalation (restart-loop → operator). We just paid the *manual* version of this — the Stage-3 migration required hand-relaunching every agent to adopt the new launcher/plugin/caller, with a mixed-routing window and total-fleet-loss risk. The automated rolling-restart is the durable fix. On K8s this is a new Deployment revision → native rolling restart; on the VM, `restart-self` + a small sequencer *is* that rolling restart. The agent only ever needs "am I current? / `restart-self`."

### Graceful-shutdown deregistration + registry TTL — the #553 root-cause fix

#553's collision was a *symptom* of stale-registration-never-cleaned; #557 fixed the *takeover* (re-confirm liveness before aborting). The root cause is upstream: a clean shutdown should **deregister** (remove its `MACF_AGENT_<LABEL>` entry), and entries should carry a **TTL** so a dirty death self-expires. Together they prevent the stale entry at the source, closing #553's own "TTL also called for" loop and shrinking the watchdog's failure surface so it rarely fires. **Phase 1.**

### Portable bootstrap — `host-prelude` (converges with DR-029)

cron and a container entrypoint have a minimal env; `claude.sh` today *inherits* the user's login-shell toolchain. The reframe: **the launch must *re-establish* its toolchain, not *inherit* it** — then login / cron / container-entrypoint are identical. Mechanism: a **`host-prelude.sh`** every entry point sources first, using absolute paths (`eval "$(/home/linuxbrew/.../brew shellenv)"`), proven on real cron (devops#115 §10: `claude` MISSING → FOUND). **This is the same `host-prelude` slot DR-029's launcher template already carries — extend it, do not fork a parallel prelude.** Toolchain-detected at `macf init` (brew / devbox-nix / container-no-op), and the **dynamic** re-source form (not a frozen PATH snapshot) so it can't go stale.

## Boundaries

- **DR-030 (detection):** DR-031's watchdog *consumes* DR-030's `--json` probes; one `/health` contract across both. DR-031 adds the trigger + ladder + `restart-self` + bootstrap + upgrade that DR-030 doesn't have.
- **DR-026 auditor (reasoning):** the auditor reasons over coordination *assuming* the liveness floor; DR-031 *is* that floor. The auditor consumes the guarantee, doesn't re-implement it.
- **`macf#556`:** the dead-vs-alive `/health` primitive (`registry prune`) is shared as the probe primitive.
- **`macf-devops-toolkit` impl DR (devops):** the VM-cron-watchdog realization (the cron one-shot, the tiered ladder with the Tier-1 gating, idempotent cron registration on launch, the watchdog self-heartbeat, the K8s liveness/restartPolicy manifests) references this DR. The §10 cron-prelude empirics + the why-not-systemd analysis are settled there.

## Ownership / build split

- **Framework (code-agent, `groundnuty/macf`):** the `/health` liveness-contract hardening (one contract with DR-030 §5) + the `restart-self` verb + **graceful-shutdown deregistration** + the registry **heartbeat/TTL** + the toolchain-detected **`host-prelude` generator** in the launcher template (DR-029 slot). Shares DR-030's `/health` schema + `macf#556`'s probe.
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

## References

DR-030 (interconnect detection — the sibling) · DR-026 F4 (`macf monitor` — the reasoning layer above) · DR-029 (substrate config + the launcher-template `host-prelude` slot + the `versions` block) · DR-005/DR-006 (registration + registry scope) · silent-fallback-hazards Instance 3 (RC-bound tmux send-keys) + the liveness application of the class · `macf#553` (collision / graceful-deregister / TTL) · `macf#556` (dead-vs-alive `/health` / `registry prune`) · `macf#560`/DR-030 (`--json` = the watchdog's input contract) · `macf-devops-toolkit#115` (the design session + §10 cron-prelude empirics + §6 why-not-systemd) · the forthcoming devops-toolkit implementation DR.
