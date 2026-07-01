# DR-038: A2A delivery-guarantee — the framework contract (durable inbox/outbox, effectively-once, complete relaunch-reconcile)

**Status:** Proposed
**Date:** 2026-07-01
**Trigger:** The framework-contract half of `macf-devops-toolkit` DR-008 (PR #147), filed as `macf#704` from the operator's 2026-07-01 reliability review. DR-008 is the substrate design + evidence + the store *drivers*; **DR-038 is the framework contract it triggers** — the channel-server delivery guarantee, the store *interface*, the plugin startup-reconcile, and the queue-source. Same split as DR-037↔DR-007 and DR-031↔DR-006 (framework primitives in `macf`; substrate drivers + cron in the devops toolkit). The 5 open questions DR-008 posed are resolved here, reconciled with code-agent's implementer positions (`#704` thread) — folded *before* authoring, not after.

> **Live-validated, not hypothetical.** The motivating failure — a direct A2A message to a down/restarting peer is silently dropped, and in-flight state dies with the process — occurred twice on 2026-07-01: the devops agent's ~8h outage, and (during this very design cycle) code-agent's channel-server dying at 11:55 from the #702 register-race, dropping every routed reply including the #705 approval. DR-008 was itself reviewed under a live instance of the gap. This DR closes it.

> **Relationship to #705 (reactive) — complementary halves.** #705 (over-register-on-relaunch, → v0.2.46) keeps the *endpoint* alive across an unclean relaunch (it no longer bricks on a stale/lagging registry read). DR-038 keeps the *message* alive when the endpoint isn't (durable outbox retries until the peer returns; durable inbox drains on the peer's recovery). #705 = the endpoint survives; DR-038 = the message survives the endpoint being gone.

---

## Decision 1 — The guarantee: at-least-once delivery + receiver dedup-by-id = effectively-once

The direct A2A path (`notify_peer` / `message/send`) gains **effectively-once** delivery, decomposed as:
- **at-least-once delivery** — a durable **sender outbox** retries until acknowledged (surviving the *sender's* own restarts);
- **idempotent receipt** — a durable **receiver inbox** dedups by a stable **message-id**, so a re-delivered message is processed exactly once.

This resolves the `a2a-client.ts` design-Q4 "not idempotent → no retry" blocker at the **id level**: `message/send` becomes safe-to-retry because the *receiver* makes it idempotent via the message-id, not the operation. GitHub stays the durable substrate for coordination-anchored messages (issue-routing, labels); the channel-server inbox/outbox is added for the **direct path only** — the hybrid DR-008 §1 pins (don't rebuild GitHub routing).

## Decision 2 — message-id: UUIDv4, persisted-once at enqueue, reused verbatim on every retry

- A **UUIDv4** minted **once at outbox-enqueue**, **persisted with the message before the first send**, and **reused verbatim on every retry — including across a sender restart** (the id must be stable, which is why it is persisted, not regenerated). This is the whole dedup key.
- **Not content-hash** (two legitimately-identical messages — a peer sending "ping" twice — would wrongly dedup-collide to one). **Not ULID**: its only advantage over UUIDv4 here was a lexicographic ordering-hint, but this DR explicitly scopes guaranteed ordering OUT (Boundaries), and the inbox entry carries an enqueue timestamp for drain-ordering anyway — so the id needn't encode time. UUIDv4 is simpler and the existing `a2a-client` already speaks `messageId`.

## Decision 3 — ACK transport: the HTTP 200 IS the ACK, returned only AFTER durable inbox-persist

No separate ACK channel. The `message/send` HTTP response is the acknowledgment, with a **load-bearing ordering**:
- **Receiver:** persist-to-inbox (idempotent by message-id) **→ THEN return 200.** Returning 200 *before* the persist would make ACK ≠ durable — the exact silent-fallback shape (success at the boundary, semantic durability absent). The persist-then-ACK ordering makes "200" mean "durably yours."
- **Sender:** `200` ⇒ durable-ACK ⇒ remove from outbox. Anything else (timeout / 5xx / connection-refused — the dead-peer case) ⇒ keep in outbox, retry.
- **A lost-in-transit 200** is safe: the sender re-sends the same id → the receiver dedups (already persisted) → re-returns 200. Idempotent by construction.

The ACK confirms **durable receipt (persisted to inbox)**, NOT processing. Processing is the inbox drain's job (Decision 5) — decoupling delivery-durability from processing-completeness, which is what makes the accepts-then-restarts-before-processing case correct (the message is already durably in the inbox; the drain processes it after the restart).

## Decision 4 — Retry budget: wall-clock TTL off a restart-surviving outbox, then dead-letter → GitHub-anchored escalation

- Retries are driven off the **persisted outbox (disk)** — **resumed on sender startup**, so a message to a peer down for hours keeps retrying **across the sender's own relaunches**. This is the crux of the 8h-outage durability: the retry loop is not in-memory (it wouldn't survive the sender restarting).
- **Exponential backoff, capped** (~1s → … → 5min), bounded by a **wall-clock TTL** (propose **24h**), NOT an attempt count (an attempt count is meaningless across restart-gaps of varying length).
- **On TTL-expiry → durable dead-letter + a LOUD alert:** a `gh issue` to the operator/reporter — a **decision-layer** action (a GitHub concern, runtime-agnostic, like DR-037's tier-3 alert — NOT a store-driver method). The dead-letter fallback for the *direct* path is the *coordination* path (GitHub), which DR-008's own table calls "durable + survives everything." So dead-letter is a **downgrade to the always-durable substrate**, not "give up." (This is precisely what would have preserved the devops-outage message.)

## Decision 5 — Drain trigger: on-receipt (live) + on-startup (completeness), both dedup-guarded

Two triggers, different roles, unified by the message-id dedup:
- **On-receipt** — the normal path: a message arrives, is persisted, and processed immediately.
- **On-startup** — the **completeness half** (DR-008 §4): the plugin's SessionStart `startup_check` (today issue-queue-only) extends to **drain the inbox** — any message persisted-but-not-yet-processed (arrived while the agent was busy / relaunching, or whose tmux-wake didn't land) — **and** auto-run the `coordination.md §5` review/gate/mention sweeps, injected + complete. This promotes §5 from "a pull-discipline the agent might forget" to "an injected startup step." **Without this, a persisted inbox is invisible** — delivery alone is insufficient.
- **Dedup-by-message-id** makes on-receipt and on-startup safe to overlap (a message can't be double-processed). No periodic drain is needed if receipt + startup cover it.

## Decision 6 — Store is a pluggable driver (DR-037 decision/driver split); logic is runtime-agnostic

The effectively-once **logic** (the outbox retry loop, the inbox dedup + drain) lives in the channel-server, runtime-agnostic. The **store is the only runtime-specific part** — the pluggable driver, exactly the DR-037/DR-007 boundary. Two interfaces (outbox and inbox have different lifecycles):

```ts
interface OutboxStore {
  enqueue(msg): void          // persist BEFORE first send
  pending(): Message[]        // undelivered — resumed on sender startup
  markAcked(id): void         // 200 received → remove
  deadLetter(id): void        // TTL expired → durable dead-letter
}
interface InboxStore {
  persist(msg): boolean       // returns wasNew — the ATOMIC dedup primitive (no check-then-act TOCTOU)
  undrained(): Message[]      // persisted-but-not-processed — drained on startup
  markDrained(id): void       // processed → won't re-drain
}
```

`persist(msg) -> wasNew` is the key design point: dedup-and-persist in **one atomic operation**, closing the check-then-act race a separate `seen(id)` + `append()` would open.

**Drivers (devops-owned, DR-008):** the VM disk-spool driver extends `comms-ledger`'s `appendFileSync`-jsonl surface into a queue (`.outbox.jsonl` / `.inbox.jsonl` siblings); the K8s driver uses a PVC/broker. **Durability scope (explicit): `appendFileSync` is sufficient** — it survives the actual failure mode, a process **crash** (`process_exit code:1`, the observed channel-server death). Only power-loss would need `fsync`, which is **out of scope** for this DR (the failure mode is crash, not power-loss).

## Decision 7 — Queue-source: App-install-set × label, complete-by-construction

Replace the hardcoded per-repo loop (`agent-identity.md §"Checking for Work"` / `startup-issues.ts`) with `enumerate /installation/repositories → for each repo: gh issue list --label <mine>`, per DR-008 §5/§6:
- NOT a global label-search (verified: `gh search issues --label devops-agent` poisons with a stranger's `rafamqrs/devops-slack-demo` label);
- NOT the bot login as assignee (verified: `[bot]` cannot be an assignee — 404);
- the **App-install set is the globally-unique "repos that are mine"**, and — DR-008 §6's **install-boundary = action-boundary = queue-boundary** result — an agent literally cannot *act* outside its install set, so the enumeration is **complete by construction**, not best-effort.
- **One shared primitive with `macf onboard-agent` (#698)** — the same `/installation/repositories` enumeration.

## Build split & ownership

- **code + science:** the channel-server delivery contract (outbox/inbox, effectively-once, message-id, persist-then-ACK, TTL/dead-letter), the **store interface** (Decision 6), the drain-on-recovery logic, the effectively-once invariant.
- **code:** the plugin startup-reconcile (extend `startup_check`: drain-inbox + §5 sweeps), the queue-source (`startup-issues.ts` → App-install×label). The plugin owns SessionStart.
- **devops (DR-008):** the VM disk-spool store driver, the K8s PVC/broker driver, the §5→startup-step operational rule.
- **science (this DR):** the framework contract + resolving DR-008's open questions.

## Boundaries / non-goals

- **Not guaranteed ordering** — effectively-once delivery, not a total order. Order-sensitive coordination goes through GitHub (the anchored path).
- **Not power-loss-durable** — `appendFileSync` survives a process crash (the failure mode); `fsync`/power-loss durability is out of scope.
- **Not a rebuild of GitHub routing** — the inbox/outbox is the *direct* path only; coordination-anchored messages stay on GitHub (the hybrid, DR-008 §1).
- **Not the store drivers themselves** — those are devops/DR-008 (this DR pins the *interface* they implement).

## Open questions

- **Dead-letter escalation target** — the operator, the issue-reporter, or a fleet-wide `delivery-failed` label? (Lean: the reporter if the message was coordination-linked, else the operator — mirrors the escalation-to-tasker rule.)
- **Outbox retry cadence across a long sender-downtime** — does a sender relaunching after 6h fire all backed-off retries immediately on startup, or re-enter the backoff schedule? (Lean: one immediate attempt on startup — the peer may be back — then re-enter backoff.)
- **TTL default** — 24h proposed; confirm against the longest realistic peer-downtime (the 8h outage fits comfortably; a multi-day VM outage would dead-letter, correctly escalating to GitHub).

## Cross-references

- **DR-008** (`macf-devops-toolkit` PR #147) — the substrate design + evidence + store drivers; the trigger. This DR is its framework mirror.
- **DR-023** — the A2A/channel-server architecture whose deferred Phase-2.5 this resolves.
- **DR-037** — the decision/driver split (Decision 6 reuses it) + tier-3-alert-in-decision-layer (Decision 4 mirrors it) + the App-install enumeration (Decision 7).
- **#698** (`macf onboard-agent`) — shares the App-install×label queue-source primitive (Decision 7).
- **#702 / #705** — the reactive over-register fix; DR-038 is the complementary systemic half.
- `coordination.md §5` — the pull-based sweeps Decision 5 promotes to an injected startup step.
- `silent-fallback-hazards.md` — Decision 3's persist-then-ACK ordering avoids the ACK≠durable silent-fallback shape.
