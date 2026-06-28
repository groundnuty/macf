# DR-034: Graceful compaction-drain — the quiesce → finalize → compact → resume contract

**Status:** Proposed
**Date:** 2026-06-28
**Trigger:** Operator-requested (`macf#651`): automate the graceful compaction-drain — when an agent's context nears full, stop it taking new work, consolidate durable memory + CLAUDE.md, compact, and resume the held queue, instead of letting Claude Code's auto-compact fire uncontrolled (which can truncate in-flight reasoning + lose the working set). Two research agents (CC compaction lifecycle + SOTA long-running-agent context management) confirm the approach fits cleanly; findings in `macf-devops-toolkit:research/2026-06-28-graceful-compaction-drain.md`. The 6th member of the unattended-operation family (`#641` channels, `#642`/#643 harden-stdio, `#645`/DR-033 auto-responder, `#131` resume, `#132` operator-blocked report, + this). Design seeded by devops; contract + consolidation-convention shaped by science.

## Context — we already do the hard part (verified)

The #1 SOTA best-practice across first-party sources (Anthropic memory-tool's "ASSUME INTERRUPTION", Manus "always restorable", Letta, Cognition) is **continuous durable file-memory written as-you-work, not lazily at compaction.** MACF already does this: `reflection-staging.md` + `.claude/.macf/reflections/pending.json` (staged as-you-work, harvested by the `harvest-reflection.sh` PreCompact hook), the `project_state_*` memory, the `codify-at-decision-time` discipline, and the restorable-pointer convention (open issue #s, branch SHAs, in-flight PR #s) — all verified present in the substrate workspace. **So the drain FINALIZES already-written durable state; it does not create it.** The genuinely novel part is the **quiesce/drain phase** (no agent framework names it — they emulate via turn-boundary input-queuing), a defensible extension snapped to a turn/tool boundary.

This is why the drain is low-risk: the fallback (uncontrolled auto-compact + the existing PreCompact harvest + as-you-work memory) already recovers most state. The drain upgrades "mostly recovers" to "cleanly finalized + nothing-in-flight-lost."

## Decision

An **externally-triggered, self-finalized, externally-verified** drain reusing existing primitives, governed by the order + verify contract below.

**Division of labor (load-bearing — mirrors the supervision split):**
- **Externally triggered.** An agent near-full **cannot reliably orchestrate its own drain** — it's the very thing about to lose context, and the trigger must fire even if the agent is mid-stall. So the **near-full detector + drain orchestrator are external** (devops, sibling of the watchdog), exactly as Tier-2 restart is external (DR-031).
- **Self-finalized.** Only the agent can consolidate *its own* in-flight reasoning into durable memory — so the **finalize step is a self-performed turn** (the orchestrator injects the prep prompt; the agent does the consolidation).
- **Externally verified + compacted.** The orchestrator **verifies finalize completed** and triggers compact — the agent doesn't self-trigger the irreversible step.

### The order contract (constitutional) — quiesce FIRST, spanning finalize AND compact

The correct order is **quiesce → (turn-boundary drain) → finalize-memory → verify-finalize → compact → resume+flush** — and **quiesce must come FIRST**, before finalize, not the reverse:

1. **Quiesce** — set the channel-server `draining` flag → new `/notify` is **held in the queue, not delivered**. Snaps to a turn/tool boundary: the *current* turn finishes; no *new* external work starts (mirrors CC's input-queue model). **Quiesce precedes finalize** because finalize must operate on a **stable state** — if memory is finalized first and *then* quiesce is set, work arriving in the gap either isn't captured in the finalized memory or is left mid-turn at compact. Quiesce-first makes the whole finalize+compact window race-free. (This sharpens `#651`'s point-1: the invariant isn't just "finalize before compact" — it's "quiesce spans the entire finalize→compact window.")
2. **Finalize-memory** (self-performed, under quiesce) — consolidate per the convention below into the *already-existing* durable surfaces. No external work interleaves (draining).
3. **Verify-finalize BEFORE compact (the irreversible-step gate, constitutional).** Compact is **irreversible context loss** — so it MUST be gated on a **positive confirmation that finalize completed**, never on a timer/`sleep`. A slow or failed finalize behind a timed compact loses the exact in-flight reasoning the drain exists to preserve. Confirm a result-invariant — `pending.json` mtime advanced + the agent emitted a "memory finalized" sentinel (verified via capture-pane content-diff, **not** `#{session_activity}` — per the DR-031 / Pattern-C verify-primitive correction, `macf#645`/#648). Same discipline as the #128 aliveness-gate: never gate an irreversible/destructive action on a weak signal.
4. **Compact** — trigger **proactively (manual `/compact`)** with enough headroom that **CC's auto-compact does not fire first** (auto-compact is uncontrolled — it would beat the drain and skip the verify-gate). The PreCompact `harvest-reflection.sh` hook runs as today (belt-and-suspenders: even a drain that mis-finalizes still gets the staged `pending.json` harvested).
5. **Resume via restorable pointers, not a dump.** SessionStart(`source=compact`) re-injects `additionalContext` ≤10K — **"you compacted; read `project_state_*.md` + the held-queue file"** (the restorable-pointer rule), NOT the content. The channel-server **flushes the held queue** on resume → the agent processes the backlog.

### Thrashing guard (constitutional) — verify the drain achieved its result-invariant

After compact, **verify context actually dropped below the trigger threshold.** CC documents an auto-compact failure mode where a huge artifact immediately refills context post-compact → a naive re-drain loops. So: post-compact, if context is **still near-full**, do **NOT** immediately re-drain — that's a runaway. Instead **alert loudly** (the artifact/working-set exceeds what compaction can shed; needs a human or a structural fix — e.g. the artifact shouldn't be in context). This is Pattern A applied to the drain itself: assert the drain's result-invariant (context shrank), don't assume the action worked. Pair with a minimum-interval between drains.

### Proactive-trigger headroom

Anchor ≈ Anthropic's 150K / MemGPT's 70%, calibrated to the **transcript-size proxy** (no native CC fullness signal — same external-proxy shape as the watchdog's liveness). The headroom must be large enough that **finalize + verify + manual-compact all complete before auto-compact would fire** — i.e. the trigger isn't "near full," it's "near full *minus the drain's own cost*."

## The consolidation convention (what "finalize-memory" consolidates) — science-owned

The prep prompt does NOT invent new state — it **finalizes the surfaces the as-you-work disciplines already maintain**:
- **`pending.json`** (reflection-staging) — flush the in-flight observations/breaches/synthesis to current.
- **`project_state_*.md`** / `context/project-state.md` — the living working-state (the restorable anchor SessionStart points at).
- **CLAUDE.md current-state header** — if a milestone shifted it.
- **Restorable pointers** — open issue #s, in-flight PR #s + branch SHAs, the held-queue file, the next-action — so resume re-grounds from pointers, not a context dump.

The drain is a **flush, not a fresh write** — if the as-you-work disciplines (codify-at-decision-time, reflection-staging) were followed, finalize is cheap (it confirms + tops up). That the drain is cheap *because* of the continuous discipline is the design's whole point (it rewards the SOTA best-practice we already follow).

## Build-split (per `#651`, sibling of the supervision DRs)

- **Framework (code):** the channel-server **`draining` flag + queue-hold** — block incoming `/notify` during the drain, flush on resume. The one piece not doable in the devops repo (sibling of the `paused` control-plane, `#131`).
- **Devops (sibling of the watchdog):** the near-full detector (transcript-size proxy), the drain orchestrator (inject prep-prompt → verify-finalize → trigger `/compact` → verify-shrank), the SessionStart(`source=compact`) resume-injection (≤10K pointers + flush trigger).
- **Science:** this DR (the order + verify + thrashing contract) + the consolidation convention.

## Composition with the family

Same `state/signal → action` spine as the supervision + idle-taxonomy work; here `state="context near-full"`, `action="drain"`. The channel-server queue is the **shared control plane** — the `draining` flag is a sibling of `paused` (`#131`) + the operator-blocked report (`#132`). The prep-prompt injection is the `#645`/DR-033 auto-responder send-keys primitive (ceremony-class: an injected prep prompt the operator pre-authorized fleet-wide — within DR-033's allowlist-only/ceremony-only contract). Memory + compaction are explicitly complementary (Anthropic: "compaction keeps active context small; memory preserves what must survive"). The verify steps use the capture-pane-diff primitive (`#648`), never `#{session_activity}`.

## Boundaries

- **Not** a replacement for the as-you-work disciplines — it *finalizes* them. If those lapse, the drain can't reconstruct what was never staged (it's a flush, not a recovery).
- **DR-031 (supervision):** same external-trigger/self-act/external-verify family + the same control plane + the same capture-pane-diff verify primitive. A draining agent is a *desired-up* agent (not paused) — the watchdog must not mistake a quiesced/compacting agent for dead (cross-ref: the draining flag should read as "alive, busy" to the liveness probe).
- **DR-033 (auto-responder):** the prep-prompt is a ceremony-class injected prompt under DR-033's contract; the `/compact` trigger is not an interactive-prompt answer (it's a command), so out of DR-033's allowlist scope.

## Consequences

- Controlled compaction replaces uncontrolled auto-compact: durable memory is finalized + verified before the irreversible step, and in-flight external work is held + flushed, not lost.
- A small new control-plane surface (the `draining` flag) + an external orchestrator — bounded by the order + verify + thrashing contract.
- The drain is cheap *because* of the continuous-memory discipline — reinforcing the SOTA best-practice the fleet already follows.

## Open questions

1. **Detector calibration** — the transcript-size→context-fullness proxy (no native signal); what headroom margin reliably beats auto-compact (open until the proxy is measured against real auto-compact-fire points).
2. **Verify-finalize sentinel** — the exact positive signal the orchestrator gates compact on (lean: `pending.json` mtime advance + a one-line agent-emitted "FINALIZED" marker, capture-pane-diff-confirmed).
3. **Draining-vs-liveness interaction** — confirm the watchdog (DR-031) reads a draining/compacting agent as alive-busy, not dead (the drain must not trip a Tier-2 restart mid-compact). Likely the aliveness-gate's capture-pane-diff already covers it (a compacting agent's pane changes), but worth an explicit cross-check.
4. **Route now or backlog the BUILD** — see the routing note below.

## Routing note (route-now-vs-backlog)

**DR now (this), build BACKLOG-behind-the-family.** The contract is worth capturing while the research is fresh, and it's cheap. But the *build* should sequence **after** the in-flight unattended-operation family (`#641` channels, `#642`/#643 harden-stdio, `#645` auto-responder) — three concurrent builds is already the active load, and **compaction works today** (the PreCompact `harvest-reflection.sh` + as-you-work memory recover most state on an uncontrolled auto-compact), so the drain is automation-polish, not an outage fix. It also *depends on* primitives still landing: the `draining` flag is a sibling of `#131`'s `paused`, and the verify steps need the `#648` capture-pane-diff primitive. So: ratify the contract, queue the build behind the family. (Operator's call on the final sequencing.)

## References

`macf#651` (the design ask + the research) · `macf-devops-toolkit:research/2026-06-28-graceful-compaction-drain.md` (PR #133) · `reflection-staging.md` + `harvest-reflection.sh` (the durable-memory + PreCompact-harvest foundation — verified present) · `codify-at-decision-time` + restorable-pointer conventions · DR-031 + DR-006 (the supervision family + control plane + capture-pane-diff verify) · DR-033 (`#645`, the prep-prompt injection primitive) · `#131` (`paused`/resume — the control-plane sibling) · `#132` (operator-blocked report) · `#648`/Pattern C (the capture-pane-diff verify primitive the verify steps require) · Anthropic memory-tool "ASSUME INTERRUPTION" / Manus / Letta / Cognition (the as-you-work-durable-memory SOTA).
