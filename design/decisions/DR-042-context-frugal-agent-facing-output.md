# DR-042: Context-frugal agent-facing coordination output

**Status:** **Accepted** (operator-ratified 2026-08-10; science-authored 2026-07-05, operator-directed via `macf#795`). code-agent implements (`#795` skill surface + the D3 budget test; first instance `#794` already shipped).
**Date:** 2026-07-05
**Trigger:** The coordination skills (`/macf-peers`, `/macf-status`, `/macf-ping`, `/macf-issues`) grew organically, each returning a fixed **human-oriented table/dump**. Now that multi-agent + cross-fleet guest collaboration (DR-036/DR-041) is live, a property that was negligible early is now load-bearing: **the consumer of these skills is an LLM agent with finite context.** To answer *"is `ppam-2026/code-agent` idle?"* an agent runs `/macf-peers`, gets the entire fleet table, and pays context for every field to read one cell. Operator framing (2026-07-05): *"the agent should check the status of ONE specific agent and get ONLY the information it wants — we don't want to bloat the agent's context with unneeded information."*

## Context — the audience changed under the surface

Early on (few agents, occasional checks) a broad table was fine. With N agents + guests + frequent coordination checks, **every field a skill returns that the agent didn't need is context cost** — it crowds the agent's finite working memory with irrelevant fleet data. The skills are formatted for a *human reading a terminal*; the primary consumer is now an *agent projecting one datum*. Symptom of the mismatch: agents already **bypass the skills**, hand-writing `gh … --json <fields> --jq` to project only what they need — the manual version of the frugality this DR builds in.

This is not a new lesson — the fleet learned it piecemeal and never generalized it:
- `notify_peer` was cut to **"EXACTLY ONE LINE"** output (`macf#350`) for exactly this reason.
- `coordination.md §Communication` mandates **concise comments** (1–3 sentences).
- The bash-output-frugality discipline (pipe through `head`/`grep`/`jq`, never raw-dump) is the agent disciplining *itself* to project.

DR-042 generalizes those three into **one ratified, structural principle** governing the whole coordination surface — and forward, every future agent-facing skill / MCP-tool response / hook injection.

## Decision

**Agent context is scarce, so agent-facing tool/skill output MUST be scarce by construction: default to minimal / projected / question-answering; verbose / full-table is explicit opt-in.**

### D1 — The audience inversion (the core reframe)

The **default consumer of a coordination skill is the agent, not the human.** Therefore:
- The **default** output shape serves the agent — frugal, structured, projected.
- The **human-facing full table** becomes an explicit mode (`--table` / `--human`), NOT the default.

Agent-facing and human-facing output are **different products**; today's skills ship the human product as the default to an agent audience. Flip the default.

### D2 — The uniform query model (across peers / status / ping / issues)

One model, not four ad-hoc shapes:

1. **Targeted** — `status <agent-slug>` (including `<project>/<name>` cross-fleet guests, DR-036/DR-041) returns **that one agent**, never the whole fleet.
2. **Projected** — `--fields state,version` returns **only** those fields; the response is small *by construction*, not by the agent post-filtering.
3. **Question-shortcuts** — the real queries are questions: *"is X idle?"*, *"what version is X?"*, *"is X reachable?"* → single-datum answers (ergonomic sugar over `--fields`).
4. **Frugal default** — no args → a compact one-line / few-field summary; `--table` / `--all` → the full human dump.

### D3 — Frugality is testable, not aspirational (the teeth)

The default output shape of each coordination query has a **rough token budget** (e.g. a targeted single-agent query ≤ ~1 line), asserted by a test/lint so "frugal" can't silently regress as fields accrete. This is the result-invariant discipline (assert the property, don't hope for it) applied to the output boundary — the same shape as the silent-fallback Pattern-A checks, here guarding *context cost* instead of correctness.

## Path-2 framing

This is a **behavioral-discipline → structural-default promotion** (the same pattern as the `check-*.sh` hooks promoting rule-discipline to harness enforcement): instead of each agent remembering to project (`--jq`) or to write concisely, the **skill projects by construction** and the human-verbose mode is the opt-in. The discipline stops depending on the agent remembering.

## First instance (build now, under this umbrella)

`macf#794` (federation-aware guest probe + guest turn-state) is the **first concrete application**: `status ppam-2026/code-agent [--fields state]` → one small answer (not the fleet table), guest-aware via the DR-041 federation probe. It proceeds now to the D2 shape; DR-042 generalizes the model across the surface.

## Boundaries / non-goals

- **Not a rewrite of the skills' function** — they work; this is an output-shape + query-ergonomics rethink, additive (the human `--table` mode preserves today's behavior).
- **Machine-readable `--json`** already exists on the backing CLI; D2's projection is about the *default agent-facing* path (and the skill/SKILL.md surface), not adding a new serialization.
- The DR sets the **principle + query-model convention**; the per-skill field sets + exact flag spelling are implementation (code-agent, on `#795`/`#794`).

## Enforcement

- **Default-frugality test/lint** (D3): each coordination query's default output asserted under its token budget; regression fails.
- **Convention for new skills:** any new agent-facing skill/tool defaults to frugal-projected + opt-in-verbose (this DR is the reference); reviewers check new agent-facing output against it.

## Consequences

- An agent answers *"is X idle?"* in a ~1-line response instead of eating the fleet table — directly reclaims working-memory context at coordination-check frequency (which is high in the multi-agent era).
- Uniform query model across the four skills → the agent learns one shape, not four.
- Guest-aware by construction → cross-fleet "is the guest idle/reachable?" is a small answer (composes with DR-041).
- The human table is preserved (explicit mode) → no loss for operator terminal use.

## Ownership / build split

- **Design (this DR + the query-model convention):** science (DR-042).
- **Implementation** (`#795` skill surface + `#794` first instance + the D3 budget test): code-agent.
- **Ratification:** operator (Proposed→Accepted).

## References
- `#795` — the operator-directed design rethink (this DR's origin).
- `#794` — federation-aware guest probe (first instance).
- DR-036 / DR-041 — the multi-agent + cross-fleet guest collaboration that made the context cost load-bearing.
- `macf#350` — `notify_peer` "EXACTLY ONE LINE" (the piecemeal precedent this generalizes).
- `coordination.md §Communication` — concise comments (the sibling discipline on the comment surface).
- `silent-fallback-hazards.md` Pattern A — the result-invariant/assert-the-property discipline D3 borrows.
