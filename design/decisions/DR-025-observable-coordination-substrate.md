# DR-025: Observable coordination substrate (the comms-ledger invariant)

**Status:** Proposed
**Date:** 2026-06-07
**Trigger:** Operator design review 2026-06-07 — once A2A (agent-to-agent direct messaging, DR-020 / DR-023 / the macf#368 A2A arc) lets agents talk *directly* rather than through GitHub, what stops us from losing the coordination trace we diagnose protocol failures from? Generalizes the [macf#444](https://github.com/groundnuty/macf/issues/444) receipt-observability arc and silent-fallback-hazards Instance 8 (OTLP endpoint silent-drop) from a single channel to *every* channel.

## Context

MACF's original coordination protocol is GitHub-mediated: work is delegated as issues, artifacts land as PRs, and messages are comments routed by `@mention` (DR-003 communication planes; the macf-actions router). A property we got *for free* from that design has turned out to be load-bearing in a way DR-003 didn't name: **because every interaction is a durable GitHub object, the coordination graph itself is observable** — who called whom, who mentioned whom, who failed to answer whom, with content, attribution, timestamps, and thread structure, all queryable via one API across the whole fleet.

That observable graph is the **instrument of the project's methodology**: observe a coordination failure in the trace → diagnose it → redesign a canonical rule or a PreToolUse harness hook → ship the structural fix. Every silent-fallback instance, every canonical rule, every `check-*.sh` hook exists because the failure was *visible* in the GitHub trace. It is also the paper's empirical foundation (the CPC dataset — 128 issues / 175 PRs / 11 days — *is* this trace).

Adding direct A2A messaging (channel-server `message/send`, `notify_peer`) introduces a second channel with the opposite properties: ephemeral, private, free-form, low-latency. If coordination moves onto it, the observable graph develops holes — we can no longer see "X failed to answer Y" because that exchange left no durable, analyzable, fleet-queryable record. **The instrument goes blind, and the diagnose→redesign loop (and the paper's evidence) degrades with it.**

This is not a new problem — it is [macf#444](https://github.com/groundnuty/macf/issues/444) one layer up. When routing moved off GitHub onto the Stage-2 tmux last-mile, the router logged the *send* but nothing logged whether the peer *received and processed* the prompt (`send ≠ receipt`); we went partially blind and had to *rebuild* observability (the `turn_processed` receipt span + the reconciler joining router-logs ⋈ Tempo). A2A is the next off-GitHub channel and threatens the instrument identically.

A2A is not a total black hole today — it emits OTel spans (`macf.a2a.message_send`, `macf.mcp.push`, `macf.tmux_wake.deliver`) and the channel-server logs delivery events (`notify_received` / `mcp_pushed` / `tmux_wake_delivered`) to `channel.log`. But that observability sits *below* GitHub's on exactly the research-relevant axes:

| Axis | GitHub | A2A today |
|---|---|---|
| Durable | permanent | Tempo retention window; per-agent `channel.log` (ages out / rotates) |
| Central / queryable | one API across the fleet | spans in Tempo + logs scattered per-agent |
| Captures | the *conversation* (content, addressing, thread, answered/unanswered) | *delivery* events, not intent or whether the peer meaningfully acted |
| Failure-detection | "mentioned-but-no-reply" is a trivial query | requires a reconciler-style join, and reports delivery, not response |

A naïve fix — "send everything to Tempo" — fails on its own terms: it makes the research instrument depend on the single lossiest hop (best-effort OTLP export → a retention-limited backend). That is **silent-fallback Instance 8 reproduced as the foundation of the methodology**: the exporter fires, the endpoint is dead or the trace ages out, *zero failure signal*, and the instrument goes blind without anyone knowing it went blind.

## Decision

### The invariant

**Observability of the coordination graph is a first-class requirement of the MACF protocol.** Any channel that carries agent-to-agent coordination MUST preserve a record of each coordination edge that is **durable**, **graph-reconstructable** (from / to / intent / answered), and **analyzable across the fleet**. GitHub satisfies this by construction; every *other* channel must satisfy it deliberately, or it is not an acceptable coordination channel for the project. This invariant governs every future channel, not just A2A.

### The mechanism — a write-ahead comms-ledger

The channel-server maintains a per-agent append-only **`comms-ledger.jsonl`** as the **authoritative** record of every coordination exchange it sends or receives, and emits to Tempo as a **derived, best-effort central index** over the same data. The ledger is the source of truth; Tempo is the convenient query view, rebuildable from the ledger.

**Write-order contract (the resilience):**

1. The channel-server appends the exchange to local `comms-ledger.jsonl` **first** — synchronous, local disk, durable. If *this* write fails, **fail loud** (an authoritative edge was just lost — this is the one operation that must not silently degrade).
2. *Then* emit the span to Tempo — async, best-effort. If Tempo is unreachable/erroring, degrade silently: the ledger has the edge and Tempo can be backfilled.

The durable write happens *before* the lossy network hop, on local disk, independent of Tempo's health. This is a write-ahead log + downstream index — the log survives, the index is rebuildable.

> **Clarification — "fail loud" at the coordination edge sites does NOT mean "block delivery" (operator decision 2026-06-08).** The original phrasing was ambiguous (it was reasonably read during implementation as a strict write-ahead that blocks the notify/wake on a ledger-write failure). The intended meaning: **"fail loud" = never-*silent*, not block-delivery.** The *library* writer (`appendEdge`) stays fail-loud — it throws so the failure surfaces. But at the three hot-path edge sites (inbound `/notify` recv, inbound A2A `message/send` recv, outbound `notify_peer` send), a ledger-write failure is caught and turned into a **loud, edge-carrying signal** — a `comms_ledger_write_failed` error log (with the edge inline, so the lost record is reconstructable) **plus** a `comms_ledger_write_failed` metric — and then **delivery proceeds**. The observability layer must never be able to cause a coordination *outage* (a local disk-full would otherwise take the agent dark for all coordination — the monitoring tail wagging the dog when already degraded). "Write-ahead" refers to durability *ordering* (append before the network hop in the common case), not to gating delivery on the ledger; the rare delivered-but-unrecorded edge in a write-failure window is loud and usually still recoverable from the async Tempo emit, which is not the silent blindness this DR targets. Implemented as the `recordEdge` policy in `packages/macf-channel-server/src/comms-ledger-record.ts` (macf#473 piece 2).

### The edge schema (one JSONL line per exchange)

```jsonc
{
  "ts": "2026-06-07T20:39:56.123Z",
  "from": "cv-architect",
  "to": "cv-project-archaeologist",
  "channel": "a2a",                 // a2a | github-route
  "event": "turn-complete",         // unified coordination-event type (see below)
  "direction": "send",              // send | recv
  "msg_id": "…",
  "intent_summary": "review request: PR #34 ready",
  "github_anchor": "groundnuty/macf-science-agent#34",  // or null
  "delivered": true,
  "processed": true,                // did it become a turn? (the #444 distinction)
  "trace_id": "8886200a…"           // cross-reference to the Tempo span
}
```

- `trace_id` lets an analyst pivot ledger ↔ Tempo in either direction.
- `processed` is the macf#444 distinction: delivery ≠ a turn actually happening (receipt ≠ distinct-turn).
- `github_anchor` stitches an off-GitHub A2A nudge back to its GitHub object, so the on-GitHub and off-GitHub graphs join into one.

### Channel unification

The ledger is not A2A-only. The channel-server logs **both** A2A exchanges **and** its handling of GitHub-routed deliveries it receives, so the JSONL becomes the single record of the *off-GitHub* coordination graph. Combined: **GitHub (on-GitHub graph) + the comms-ledger (off-GitHub graph) + Tempo (central index over both) = the complete, resilient coordination graph.** The unified `event` taxonomy (one enum spanning A2A's `turn-complete`/`session-end`/`error`/`custom` and the router's `issue-routed`/`mention`/`pr-review-state`) is what makes a coordination event analyzable identically regardless of which channel carried it.

## Consequences

**Defense-in-depth, by role:**

- **JSONL ledger = prevention.** The edge physically cannot be lost to a Tempo/OTLP/network failure — it is on local disk before any network hop.
- **Tempo = convenience.** Central cross-fleet query when it is up; rebuildable from the ledgers when it is not.
- **The existing Instance-8 assertions (`doctor-otel.sh`, trace-count > 0) = detection.** They surface *when* Tempo silently drops, so the gap between "ledger has it" and "Tempo has it" is itself observable.

Each layer covers what the others cannot. Critically, the research instrument no longer has a single point of failure.

**Research integrity preserved.** A2A can be the product's fast direct-coordination path *without* blinding the diagnose→redesign loop or eroding the paper's evidence. "GitHub-native coordination is observable by construction; direct agent channels require deliberately-engineered observability or they blind the operator" becomes a stated finding rather than an accidental property.

**Costs (accepted):**

- A synchronous local append per exchange (cheap; bounded; the durable write is the point).
- Fleet-graph analysis is "query Tempo (central, when up)" *or* "gather + merge the per-agent ledgers (always works)." The ledger is the floor, not the primary query path.
- Log rotation/retention on the ledger becomes an operator concern (it is the permanent record; size management is deliberate, e.g. archive-on-rotate, never silent truncation — cf. silent-fallback "no silent caps").

## Alternatives considered

- **Tempo-only ("send everything to Tempo").** Rejected: makes the instrument depend on the single lossiest hop; reproduces silent-fallback Instance 8 as the methodology's foundation; Tempo's retention is incompatible with a permanent research/paper record.
- **Mirror every A2A message to GitHub.** Rejected as the *primary* mechanism: GitHub API rate limits, board noise, write latency, and it defeats the "direct" point of A2A. (Retained in weaker form: `github_anchor` links ledger edges to GitHub objects, and *decisions/commitments* still land in GitHub per the system-of-record discipline — but routine direct exchanges do not each become a GitHub write.)
- **Discipline-only ("reflect decisions back to GitHub").** Rejected as a sole mechanism: behavioral discipline is ~80% reliable in this project (the entire `check-*.sh` PreToolUse hook family exists because of that). The ledger is structural; discipline can ride on top but cannot be the floor.
- **Phase-gate (GitHub-primary through the research phase; lean on A2A post-paper).** Held as the fallback: if the ledger is not built in time, keep GitHub the primary coordination path during data-gathering to protect the instrument, and treat A2A as "built + demonstrated" (the interop contribution) rather than the path the study runs on. The ledger is preferred because it lets us have both.

## Relationship to prior DRs + precedent

- **DR-003 (communication planes)** named the channels; this DR adds the *observability invariant across* them.
- **DR-020 (notify/wake), DR-021 (OTel instrumentation), DR-023 (Stage-3 hook→MCP-tool + Pattern E)** are the A2A/observability substrate this builds on.
- **silent-fallback-hazards Instance 8 (OTLP silent-drop)** is the hazard a Tempo-only design would reproduce; the ledger is the Pattern-A result-invariant defense applied to the observability pipeline itself.
- **macf#444 (receipt-observable substrate routing)** is the same lesson one layer down: when comms moved off GitHub, observability had to be rebuilt. The ledger generalizes that reconciler from "did the routed ping land" to "the whole coordination graph."

## Implementation

Out of scope for this DR (decision + principle + schema only). The channel-server `comms-ledger.jsonl` write path + the unified `event` taxonomy will be filed as a `code-agent` implementation issue referencing this DR. Build sequence and exact field encoding are the implementer's call within this schema + write-order contract.
