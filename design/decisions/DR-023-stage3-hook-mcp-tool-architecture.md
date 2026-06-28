# DR-023: Stage-3 hook → MCP-tool architecture

**Status:** Accepted
**Date:** 2026-04-26
**Trigger:** [macf#241](https://github.com/groundnuty/macf/issues/241) (architectural primitive design); [macf#255](https://github.com/groundnuty/macf/issues/255) (Stage-3 design sub-issue under master [#254](https://github.com/groundnuty/macf/issues/254))

## Context

Claude Code 2.1.118 added a new hook type — `type: "mcp_tool"` — that lets a hook directly invoke a tool on a connected MCP server, instead of shelling out to a separate process. The tool runs inside Claude Code's existing MCP-client context, gets typed parameters, and returns a structured response.

This is an architectural primitive that becomes load-bearing once MACF's Stage-3 channel server (already shipped per DR-022 + DR-020 + 9 prior DRs) is paired with hook-driven workflows: cross-agent session-end notification, programmatic LGTM enforcement, auto-checkpoint, routing-leak detection.

Forward-looking design lived in `groundnuty/macf-science-agent:research/2026-04-25-stage3-hook-mcp-tool-architecture.md` since 2026-04-25. Per macf#255 Sub 1's research-first AC, the schema was re-verified against canonical docs on 2026-04-26 before this DR landed; **5 corrections** to the original research doc are folded into this DR (see §"Schema corrections from re-verification").

## Decision

Adopt the `type: "mcp_tool"` hook surface as the canonical primitive for hook-driven channel-server tool invocation in MACF Stage 3.

Implementation expands the existing `@groundnuty/macf-channel-server` package with MCP tools for hook invocation (separate surface from the HTTP `/notify` / `/health` / `/sign` endpoints — see DR-015 amendment). Plugin manifest (`packages/macf/plugin/hooks/hooks.json`) gains `type: "mcp_tool"` hook entries that invoke these tools.

## Schema (verified 2026-04-26 against [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks))

```json
{
  "type": "mcp_tool",
  "server": "<configured-mcp-server-name>",
  "tool": "<tool-name-on-that-server>",
  "input": { "field": "literal", "path_field": "${tool_input.file_path}" },
  "timeout": 60,
  "statusMessage": "...",
  "if": "Bash(git push *)"
}
```

Field shape:

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"mcp_tool"` | yes | Hook type discriminator |
| `server` | string | yes | Configured MCP server name; must already be connected (no OAuth/connection-flow trigger) |
| `tool` | string | yes | Tool name on that server |
| `input` | object | no | Arguments. String values support `${path}` substitution from hook's JSON input via dot notation (e.g., `${tool_input.file_path}`) |
| `timeout` | number | no | Seconds; default 60 |
| `statusMessage` | string | no | Spinner text |
| `if` | string | no | Permission rule syntax filter (tool events only) |

## Failure-mode contract — non-blocking by default

**Critical correction from the prior research doc:** all errors are **non-blocking** unless the tool successfully returns an explicit JSON decision. Specifically:

- Server not connected → non-blocking error; execution continues
- Tool does not exist on server → non-blocking error; execution continues
- Tool returns `isError: true` → non-blocking error; execution continues
- Tool times out → non-blocking error; execution continues

To **block** an event, the tool must:
1. Successfully execute (no error path)
2. Return JSON content matching the event-specific decision shape

This invalidates the original research doc's framing of UC-2 (LGTM gate) as "fail-safe = block on tool failure." The hook layer is structurally observational; fail-safe-block semantics must live on a different layer (e.g., routing-Action-side Pattern A invariant assertion — see DR-005 amendment).

## Decision shape per event

Tool's JSON output is parsed against event-specific schemas:

| Event | Decision JSON | Effect |
|---|---|---|
| `PreToolUse` | `{hookSpecificOutput: {hookEventName, permissionDecision: "deny", permissionDecisionReason}}` | Blocks tool call |
| `PostToolUse` | `{decision: "block", reason}` | Feedback to Claude (tool already ran) |
| `PermissionRequest` | `{decision: {behavior: "allow"|"deny"}}` | Permission decision |
| `UserPromptSubmit` | `{decision: "block", reason}` | Rejects prompt |
| `Stop` and most other events | JSON honored if returned; non-blocking-error path always-continues | Mostly observational |

Reference example (PreToolUse deny):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Merge blocked: no LGTM on PR per pr-discipline.md"
  }
}
```

## Use cases

Four use cases. UC-1 ships first (lowest blast-radius, demonstrates the wire-level pattern); others follow as design + operational evidence accumulates.

### UC-1: Cross-agent session-end notification (`Stop` → `notify_peer`)

**Hook event:** `Stop` (session end via `/exit`, Ctrl-C, or process signal).

**MCP tool:** `macf-channel:notify_peer` (new — exposed on `@groundnuty/macf-channel-server`).

**Tool surface (MCP SDK shape, Zod-validated per `/modelcontextprotocol/typescript-sdk` v1.x):**

```typescript
server.registerTool(
  'notify_peer',
  {
    description: 'Notify a peer agent of an event via the channel-server network',
    inputSchema: z.object({
      to: z.string().optional(),       // optional per macf#256 Option A
      event: z.enum(['session-end', 'turn-complete', 'error', 'custom']),
      message: z.string().optional(),
      context: z.record(z.unknown()).optional(),
    }),
    outputSchema: z.object({
      delivered: z.boolean(),
      channel_state: z.enum(['online', 'offline']),
      peers_attempted: z.number().int().nonnegative(),
      peers_delivered: z.number().int().nonnegative(),
    }),
  },
  async ({ to, event, message, context }) => {
    // If `to` is provided, POSTs to that single peer's /notify (1:1).
    // If absent, looks up all peers via Registry.list(), excludes self
    // (cycle-prevention per §"Cycle prevention" tuple-dedup), POSTs in
    // parallel to each (1:N broadcast). Returns content + structuredContent
    // with per-peer aggregate counts.
  }
);
```

**`to` field semantic — refined post-design via macf#256 Option A (impl-time):**

- `to` is OPTIONAL. The plugin-shipped Stop hook entry in
  `packages/macf/plugin/hooks/hooks.json` ships universally to all
  consumer workspaces; per-agent `to: "<peer>"` customization is not
  feasible because hook-input substitution (`${path}`) only resolves
  from the hook's JSON input + `${cwd}` — no env-var path. So the
  default Stop hook fires `notify_peer` without `to`, broadcasting
  to all registered peers. Single-peer mode is available for any
  caller (other hook entries, MCP-tool-using agent code, ad-hoc
  invocation) that needs explicit targeting.
- Self-exclusion: when broadcasting, the tool excludes the calling
  agent's own registration to prevent the (server, tool, input)
  deduplication cycle warned about in §"Cycle prevention".

**Failure profile:** observational — `Stop` events ignore non-blocking errors by design. If channel-server unreachable or peer offline, notification is missed but session-end proceeds normally. Polling-fallback (existing pattern) catches missed notifications on next session-start.

**`isError` semantic** (paper-trail observability for the LLM):

- Single-peer mode (`to` provided): `isError: true` if the named peer didn't deliver (transport error, peer-rejected, peer-not-registered)
- Broadcast mode (`to` absent): `isError: true` if `peers_attempted > 0 && peers_delivered === 0` (tried but all failed). `isError: false` if `peers_attempted === 0` (no peers registered — not a failure, just empty state) or if at least one peer delivered (partial success counts as overall success)

The `Stop` event itself is non-blocking regardless of `isError` — `isError` only signals to the LLM for self-correction in the next turn (e.g., "all peers offline; falling back to GitHub-issue-mediated notification").

**Wire payload — `peer_notification` NotifyType** (added macf#256 v0.2.3 per the same Option B refinement):

The MCP tool's input is what the calling LLM sees; the wire payload sent to the peer's `/notify` endpoint uses the canonical `NotifyPayloadSchema` from `@groundnuty/macf-core`. To keep peer-notification traffic distinguishable from GitHub @mention routing in observability surfaces (Tempo `gen_ai.operation.name` dimension, channel-server tracing), `notify_peer` posts a dedicated `type: "peer_notification"` payload variant:

```json
{
  "type": "peer_notification",
  "source": "macf-tester-1-agent",
  "event": "session-end",
  "message": "optional human-readable",
  "context": {"optional": "structured data"}
}
```

The receiver discriminates via `type === 'peer_notification'` and renders via `notify-formatter.ts` (e.g., `"Peer macf-tester-1-agent reports event: session-end"`). `tracing.ts` `operationNameForNotifyType` maps this type to the `peer_notify` GenAI op-name, distinct from `notify` (status-update class) and `invoke_agent` (mention class).

Initial v0.2.2 implementation reused `type: input.event` directly, which collided with the `/notify` endpoint's strict NotifyType enum (HTTP 400 validation error). Empirical macf#256 validation surfaced this; v0.2.3 fix dedicates the type and adds the `event` discriminator field.

**Self-exclusion comparison must normalize** (added macf#256 v0.2.3): Registry's `list()` returns names in GitHub Variables canonical form (uppercased, hyphens-to-underscores per `toVariableSegment` in `@groundnuty/macf-core:registry/variable-name.ts`). The `notify_peer` self-exclusion check (single-peer + broadcast) MUST normalize both sides via `toVariableSegment` before comparison — raw-string comparison against canonical `selfAgentName` would never match → broadcasts loop back to self → triggers the `(server, tool, input)` deduplication cycle this DR's §"Cycle prevention" warns about. Empirical surfacing on testbed validation; codified in DR for future implementers.

**Observational-only delivery — peer_notification skips tmux wake** (added macf#267 v0.2.4): Receiver's `/notify` handler discriminates by payload type. For `type === 'peer_notification'`, the MCP push deposits the notification in channel state (visible via `/macf-status` + recipient's MCP channel content) but tmux wake is suppressed. For all other NotifyTypes (issue_routed, mention, startup_check, ci_completion), wake-on-receipt behavior is preserved.

This stops a cross-agent loop class that the §"Cycle prevention" same-agent dedup doesn't cover: Stop hook on agent A → notify_peer broadcasts → agent B's tmux wakes → B's LLM processes input → completes turn → B's Stop hook fires → notify_peer back to A → loop. Each leg has its own `(server, tool, input)` tuple in its own MCP context; the platform dedup catches same-agent recursion but not cross-agent ping-pong. Empirical surfacing on testbed validation (~6s round-trip, 8 cycles in 50s observed before manual kill); v0.2.4 Option (d) fix structurally retires the loop class by making peer_notification observational rather than action-triggering.

SessionStart polling-fallback (DR-020) catches missed notifications on next session start. The Stop hook becomes a passive notify (LLM sees the peer event in MCP channel content next time it queries channel state) rather than an active wake (no fresh turn on receipt).

**Cross-channel-server trace correlation — sender-side OTel span + W3C traceparent propagation** (added macf#267 v0.2.4):

- Sender wraps `notify_peer` body in `macf.tool.notify_peer` CLIENT-kind span (per `tracing.ts` `SpanNames.ToolNotifyPeer`). Span attributes: `gen_ai.operation.name=peer_notify`, `macf.notify.type=peer_notification`, `macf.notify.event`, `macf.notify.target`, `macf.notify.peers_attempted`, `macf.notify.peers_delivered`. Sender-side latency + outcome become observable.
- Sender injects W3C traceparent header on outbound POST via `propagation.inject(context.active(), headers)`. Receiver's `/notify` handler already extracts via `propagation.extract(context.active(), req.headers)` (existing macf#194 behavior); receiver's `macf.server.notify_received` span becomes child of sender's `macf.tool.notify_peer` span.
- Phase D / Claim 1b cell-effect measurement now sees full round-trip latency + parent-child trace relationship across channel-server boundary.

**Sender-side timeout** (added macf#267 v0.2.4): per-peer `timeoutMs` is 5000ms (was 1000ms in v0.2.3). v0.2.3's 1s timeout cut off mid-receiver-wake (receiver's `/notify` handler did MCP push + tmux wake synchronously inside response; ~1050ms wake latency observed). With Option (d) suppressing tmux wake for peer_notification, response latency drops to ~5ms; 5s margin remains comfortable. Eliminates Finding 1's false-negative `peers_delivered=0` reports.

**Latency budget:** <500ms typical (well within `Stop` event's tolerance for non-interactive shutdown).

**Why first:** lowest blast-radius. Failure mode is "peer doesn't get heads-up" — recoverable via polling. Validates the wire-level pattern with minimal risk surface.

### UC-2: Pre-merge LGTM gate (`PreToolUse` → `check_lgtm`)

> **REFRAMED 2026-04-27 — see Amendment §"Substrate-compatibility" below.** The original mcp_tool framing in this section is **deprecated**. UC-2 is a PreToolUse-blocking hook → must use bash command-type form per the substrate-compat decision rule. The schema below documents the original mcp_tool framing for reference; the actually-shipped form will be a bash hook (`check-lgtm-gate.sh`) calling `gh api` directly. Tracker: macf#270.

**Hook event:** `PreToolUse` with `if: "Bash(gh pr merge*)"` filter.

**MCP tool:** `macf-channel:check_lgtm`.

**Tool surface:**

```typescript
server.registerTool(
  'check_lgtm',
  {
    description: 'Check whether a PR has reviewer LGTM before allowing merge',
    inputSchema: z.object({
      pr_url: z.string().url(),
      required_reviewers: z.array(z.string()).optional(),
    }),
    outputSchema: z.object({
      has_lgtm: z.boolean(),
      reviewers: z.array(z.string()),
      required_count: z.number(),
      reason: z.string().optional(),
    }),
  },
  async ({ pr_url, required_reviewers }) => {
    // Calls gh API to read PR review state
    // Returns content + structuredContent + (if no LGTM)
    //   { hookSpecificOutput: { hookEventName: 'PreToolUse',
    //     permissionDecision: 'deny',
    //     permissionDecisionReason: '...' } }
  }
);
```

**Failure profile:** **observational with deny-on-success.** If channel-server unreachable, hook fails non-blocking → merge proceeds without gate. To enforce fail-safe-block semantics, pair with Pattern A defense at routing-Action layer (see DR-005 amendment) — the routing-Action's pre-merge invariant check is the structural fail-safe; the hook is the in-process speed-up that catches violations before the merge command actually fires.

**Latency budget:** <200ms (single `gh api` call).

**Risk surface:** auto-merge bots (Renovate-style) trigger this; bypass via `MACF_SKIP_LGTM=1` env var or scope the `if` filter to agent-initiated merges only.

### UC-3: Auto-checkpoint to memory (`PreCompact` → `checkpoint_to_memory`)

> **REFRAMED + SHIPPED 2026-05-01 — see Amendment §UC-3 reframe below.** Hook event is **`PreCompact`** (not `Stop` as originally drafted) and tool lives in the existing `@groundnuty/macf-channel-server` package (no separate memory MCP server). Tracker: macf#271 (this PR). The deferred-status framing in the prior draft is superseded.

**Hook event:** `PreCompact` — fires before context compaction, both `/compact` (manual) and auto-compaction (token threshold).

**MCP tool:** `checkpoint_to_memory` on `@groundnuty/macf-channel-server` (same MCP surface as `notify_peer`; UC-1 architecture mirror).

**Tool surface (Zod-validated per `/modelcontextprotocol/typescript-sdk` v1.x):**

```typescript
server.registerTool(
  'checkpoint_to_memory',
  {
    description: 'Write a session-handoff checkpoint to per-project memory directory ' +
      'before context compaction. Best-effort + non-blocking on failure.',
    inputSchema: z.object({
      session_id: z.string().min(1),
      transcript_path: z.string().optional(),
      cwd: z.string().min(1),
      trigger: z.enum(['manual', 'auto']).optional(),
      summary: z.string().optional(),
    }),
    outputSchema: z.object({
      written: z.boolean(),
      path: z.string().optional(),
      deduplicated: z.boolean(),
      reason: z.string().optional(),
    }),
  },
  async ({ session_id, transcript_path, cwd, trigger, summary }) => {
    // Resolve memory dir as ~/.claude/projects/<encoded-cwd>/memory/
    // Encoding: every `/` replaced with `-` (matches Claude Code convention).
    // Find existing entry by `originSessionId: <session_id>` in frontmatter
    // (dedup); update in place if found, allocate new path otherwise.
    // Naming: project_session_handoff_YYYY_MM_DD.md; suffix with first-8
    // of session-id when a different session has already claimed today's
    // canonical name.
    // Returns {written, path?, deduplicated, reason?} — never throws.
  }
);
```

**Hook entry (`packages/macf/plugin/hooks/hooks.json`):**

```json
{
  "PreCompact": [{
    "hooks": [{
      "type": "mcp_tool",
      "server": "plugin:macf-agent:macf-agent",
      "tool": "checkpoint_to_memory",
      "input": {
        "session_id": "${session_id}",
        "transcript_path": "${transcript_path}",
        "cwd": "${cwd}"
      },
      "timeout": 30,
      "statusMessage": "Writing session checkpoint to memory..."
    }]
  }]
}
```

**Failure profile:** observational + non-blocking, even though `PreCompact` *can* block (top-level `decision: "block"` per [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) Decision-control table). Design choice: a failed checkpoint is recoverable (operator can manually author a handoff entry post-compaction), but blocking compaction would harm the operator. Tool always returns `isError: false` to the wrapper; the `written: false` + `reason` fields surface diagnostics for LLM self-correction.

**`isError` semantic:** always `false`. Even on write-failure, the tool returns success-shape with `written: false` + `reason`. This differs from UC-1 (`isError: true` when peers attempted but none delivered) — UC-1 signals to the LLM for next-turn fallback; UC-3's failure mode is "synthesize manually" which is operator-discipline, not in-context LLM action.

**Memory directory resolution:**

```
${HOME}/.claude/projects/<encoded-cwd>/memory/project_session_handoff_<YYYY_MM_DD>.md
```

Where `<encoded-cwd>` replaces every `/` in the absolute cwd with `-` (e.g., `/Users/x/repos/y` → `-Users-x-repos-y`). Verified against existing project dirs in the operational env. Frontmatter follows the canonical convention captured by existing handoff entries:

```yaml
---
name: <YYYY-MM-DD> session checkpoint (PreCompact auto-write)
description: Auto-checkpoint written by <agent> on <date> via PreCompact hook (trigger=manual|auto).
type: project
originSessionId: <session_id>
---
```

**Deduplication rule:** `originSessionId` is the dedup key. PreCompact may fire multiple times in a single session for sequential auto-compactions; the second-and-later invocations OVERWRITE the existing entry (rather than create N files for one session). Different sessions sharing a calendar date land at suffixed paths (`project_session_handoff_<date>_<short-sid>.md`).

**Limitations (codified, not bugs):**

- `/exit` and Claude Code crashes do NOT fire `PreCompact` — operator-discipline territory (the existing `synthesize-before-compaction` rule still applies for those exit modes)
- `PreCompact` fires before BOTH manual `/compact` AND auto-compaction; the `trigger` field disambiguates
- Tool runs purely on local filesystem (no peer registry, no network); the MCP-server-not-connected mode of substrate workspaces still applies — substrate doesn't get this UC, by design (consistent with the substrate-permanent-off-limit directive captured in the §"Substrate-compatibility" amendment)
- The `transcript_path` field is metadata only; the tool does not currently parse the transcript (future work could synthesize a body from recent turns)

**OTel instrumentation:** `macf.tool.checkpoint_to_memory` INTERNAL-kind span (no outbound network). Attributes: `macf.checkpoint.trigger` (manual|auto|unknown), `macf.checkpoint.written` (bool), `macf.checkpoint.deduplicated` (bool). Span rolls under `macf.hook.latency_ms` histogram via the existing telemetry pattern.

**Latency budget:** <100ms typical (single fs scan over memory dir + one writeFile). PreCompact's effective ceiling is `timeout: 30` per hook entry; comfortable margin.

**Why ship it now (vs. continued defer):** the codification-gap firing pattern continued accumulating across multiple agents through 2026-04 sessions (`feedback_synthesize_before_compaction.md` + `feedback_codify-at-decision-time.md` updates). The original "defer pending memory-MCP-server architecture decision" framing was solved by recognizing the channel-server already owns the per-agent MCP surface; checkpoint is just another tool on it. No new package needed. UC-1 (`notify_peer`) shipped first per "lowest blast-radius" doctrine; UC-3 follows now that the architecture pattern is proven.

### UC-4: Routing-leak detector (`PreToolUse` → `check_routing_hygiene`)

> **REFRAMED + SHIPPED 2026-04-27 — see Amendment §"Substrate-compatibility" below.** UC-4 shipped via PR #275 (commit `9c5099d1`) as a **bash command-type PreToolUse hook** (`check-mention-routing.sh`), NOT as `type: "mcp_tool"`. Reframe driver: PreToolUse-blocking semantics + substrate-distribution + non-blocking-fail-mode of mcp_tool make bash form load-bearing. The mcp_tool framing below is deprecated for UC-4 specifically (general framework still applies for Stop hooks). Tracker: macf#272 (closed).

**Hook event:** `PreToolUse` with `if: "Bash(gh issue comment *)"` and `if: "Bash(gh pr comment *)"`.

**MCP tool (deprecated):** `macf-lint:check_routing_hygiene` (hypothetical — would live in a separate `macf-lint` MCP server).

**Actually-shipped form:** bash command-type PreToolUse hook at `packages/macf/scripts/check-mention-routing.sh`, distributed via canonical scripts directory; settings.json entry installed by extended `installGhTokenHook`. Override: `MACF_SKIP_MENTION_CHECK=1`.

## Architectural constraints (from re-verification)

### Hook deduplication by `(server, tool, input)` tuple

Identical hook invocations are deduplicated by the platform. Two events triggering the same `(server, tool, input)` tuple → second invocation suppressed. Use distinct `input` objects (e.g., include `${tool_input.command}` substitution) or separate tools if repeated calls are needed.

Affects MACF design: notify_peer should include event-distinguishing params in `input` (e.g., the `event` field), so repeated `Stop` notifications across sessions don't collapse.

### No guaranteed parallel-hook execution order

> "All matching hooks run in parallel, and identical handlers are deduplicated automatically."

Cannot rely on UC-1 firing before UC-2 even when both match the same event. Build idempotency into peer-notification handlers + don't depend on hook-ordering for correctness.

### `SessionStart` + `Setup` events fire BEFORE MCP servers connect

UCs that hook these events get `"not connected"` errors on first run. UC-1 hooks `Stop` (post-connect) so this doesn't bite; UC adoption on `SessionStart` for things like checkpoint-on-startup would need a different mechanism (e.g., delayed retry inside the tool itself).

### Substitution syntax: `${path}` from hook's JSON input

Path uses dot notation into the hook's JSON input. Example: `${tool_input.file_path}`, `${cwd}`. Substitution failure (path doesn't exist) is silent; treat as empty/null at tool boundary + handle in input validation.

## Cycle prevention

A hook calling an MCP tool that triggers another hook risks infinite loop. Mechanisms:

1. **Platform deduplication by tuple** — identical `(server, tool, input)` is automatically suppressed; catches the simplest 1-step cycles structurally
2. **Per-hook depth cap** — track session-counter of hook invocations from a given matcher; cap at e.g. 10
3. **Recursion detection via call stack** — track `(event, matcher, tool)` tuples in current invocation; abort if same tuple appears twice
4. **Tool-side reentrancy guard** — MCP tool maintains in-process flag, refuses re-entry

Decision: rely on platform deduplication (1) as the primary defense; recommend tool-side reentrancy guards (4) as a per-tool implementation pattern in the design freeze. Depth cap (2) + recursion detection (3) deferred until empirical cycle observed.

## Latency budgets

| Event | Cap | Rationale |
|---|---|---|
| `Stop` | <500ms | Non-interactive shutdown |
| `PreToolUse` non-merge | <100ms | Fires every Bash; latency compounds |
| `PreToolUse` merge gate | <200ms | One-shot; interactive but not high-frequency |
| `PostToolUse` | <100ms | Same compounding concern as PreToolUse |

The `type: "mcp_tool"` path's structural advantage (~50ms typical vs ~200-500ms shell-script cold-start) makes the <100ms cap feasible for high-frequency hooks.

Implementation MUST emit OTel histogram metrics under `macf.hook.latency_ms` per `packages/macf/plugin/rules/observability-wiring.md`.

## Test harness shape

Hook → MCP-tool path is unit-testable without spinning up real channel server or MCP infrastructure:

- **Mock MCP client**: `MockMcpClient` captures tool calls, returns canned responses; injectable via `new HookDispatcher({ client: mockClient })`
- **Hook-event simulation**: `simulateHookEvent({ event: 'Stop', matcher: '*' })` drives dispatcher with synthetic events
- **Assertion library**: convenience matchers — `did hook X fire?`, `with what params?`, `in what order?`

Test categories:

1. **Wire-level**: hook fires → mock client receives expected call → dispatcher returns expected action
2. **Failure-mode**: mock client raises (timeout, transport error) → dispatcher applies non-blocking-error semantics
3. **Cycle-detection**: tuple deduplication + (if implemented) depth cap triggers
4. **Concurrency**: parallel hooks on same client don't cross-contaminate state

Lives under `packages/macf-channel-server/test/hook-dispatcher/`. Implementation belongs to code-agent per macf#256.

## Schema corrections from re-verification

Five corrections to the prior research doc (`research/2026-04-25-stage3-hook-mcp-tool-architecture.md` in `groundnuty/macf-science-agent`):

1. **All errors always non-blocking** — research doc framed UC-2 as "fail-safe = block on tool failure"; that's structurally impossible at hook layer. Corrected: hook is observational; fail-safe-block must live elsewhere.
2. **Decision shape is event-specific** — research doc proposed generic `{action, message, override_env}`; actual shape is per-event JSON (PreToolUse vs PostToolUse vs PermissionRequest vs UserPromptSubmit).
3. **Hook deduplication by tuple** — research doc didn't anticipate platform-level dedup; informs cycle-prevention design (D-3).
4. **No guaranteed parallel-hook order** — research doc implicitly assumed sequential; corrected.
5. **`SessionStart` + `Setup` fire before MCP connect** — research doc's smoke-test path uses `Stop` so this doesn't bite; documented for any future SessionStart-event UC.

The research doc itself stays in place as the design rationale + use-case-tradeoff record. This DR supersedes its concrete schema + failure-mode claims.

## Smoke-test status

Smoke-test hook deployed `2026-04-26` in `groundnuty/macf-science-agent:.claude/settings.json` (commit `f642746`) — `Stop` event invoking `chrome-devtools.list_pages` (idempotent, read-only). Pending fire on next session-end. Verifies wire-level mechanism using existing MCP server before any MACF-specific tools exist.

Result will document as Appendix A in `research/2026-04-25-stage3-hook-mcp-tool-architecture.md`.

## Implementation scope (macf#256 Sub 2)

Per the master tracker reframe ([macf#254](https://github.com/groundnuty/macf/issues/254)):

1. **Channel-server tool surface:** add `notify_peer` tool to `@groundnuty/macf-channel-server` (Zod-validated per MCP SDK v1.x; `server.registerTool` API)
2. **Plugin hook config:** add `type: "mcp_tool"` Stop hook entry in `packages/macf/plugin/hooks/hooks.json` invoking `notify_peer`
3. **Tests:** unit (notify_peer tool) + integration (hook → tool → channel-server → peer round-trip) + e2e
4. **OTel:** `macf.hook.latency_ms` histogram + traces
5. **Documentation:** `@groundnuty/macf-channel-server` README + plugin docs

UC-2 (LGTM gate), UC-3 (checkpoint), UC-4 (routing-hygiene) ship in follow-up DR/issue cycles as their respective design questions resolve.

## Migration scope (macf#257 Sub 3)

Substrate workspaces (science / code / devops) currently lack channel servers (still on Stage 2 SSH+tmux routing — exposed to RC IPC silent-fallback Instance 3 per `silent-fallback-hazards.md`). Sub 3 covers:

- Bootstrap channel servers on each substrate workspace via existing `macf init` (channel-server already on npm v0.2.0 per DR-022; no code changes needed)
- Once channel servers operational, the new mcp_tool hook config (from Sub 2) propagates via `macf update`
- Retire SSH+tmux routing path post-cutover

## Sources consulted (research-first AC)

Per macf#255 Sub 1's research-first AC + standing directive (memory `feedback_design_features_with_research_first.md`):

- **[code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)** (WebFetch 2026-04-26) — canonical hook schema, failure semantics, decision shape
- **`/modelcontextprotocol/typescript-sdk` v1.x** (Context7 query 2026-04-26) — `server.registerTool` API, Zod input/output schemas, response shape (`content`, `structuredContent`, `isError`), `McpServer` class metadata
- **`silent-fallback-hazards.md` Instance 3** — operational evidence motivating UC-2 fail-safe-block-must-live-elsewhere
- **`research/2026-04-26-stage3-dr-audit.md`** (`groundnuty/macf-science-agent`) — audit driving the 5 amendments alongside this new DR
- **`research/2026-04-25-stage3-hook-mcp-tool-architecture.md`** (`groundnuty/macf-science-agent`) — design doc + 4 use-case tradeoff record (corrected per §"Schema corrections")
- **macf#241** — backlog tracker; this DR closes the architectural-primitive design surface

## Amendment 2026-04-27 — Substrate-compatibility: bash-form vs mcp_tool selection rule

**Reason for amendment:** PR #275 (macf#272) shipped UC-4 (routing-leak detector) as a **bash command-type PreToolUse hook**, NOT as `type: "mcp_tool"` per the original UC-4 framing. The reframe surfaced an architectural insight worth promoting from implementation note to DR-level decision rule; UC-2 (LGTM gate) needs the same reframe before code-agent picks up macf#270.

**Architectural insight:**

Per `feedback_substrate_workspaces_dont_use_macf.md` (operator directive 2026-04-27): substrate workspaces (science / code / devops) NEVER use the macf binary — `macf init` + `macf update` + `macf rules refresh` are all permanent-off-limit. The macf-agent MCP server is therefore not loaded on substrate, and mcp_tool hooks invoked there fail non-blocking ("MCP server not connected"); see "Failure-mode contract — non-blocking by default" §.

The constraint is **broader than substrate-specific**: even on consumer workspaces (CV, testers, future macf-init'd projects), there's a startup window + occasional transient disconnect window where mcp_tool hooks fail open ("not connected" → exit 0). This means **mcp_tool hooks cannot reliably BLOCK** — when the failure-to-fire path is taken, the gated action proceeds without the check having run.

**Decision rule:**

| Hook event | Required semantics | Recommended form | Reason |
|---|---|---|---|
| `PreToolUse` (gating / blocking) | MUST reliably block on policy violation | **Bash command-type** | Non-blocking fail = silently allowed bypass |
| `Stop` / `SessionStart` (best-effort) | OK to no-op when MCP unavailable | mcp_tool | Best-effort observability; missing notification = lost ping, not safety violation |
| `PreToolUse` (telemetry-only) | OK to no-op when MCP unavailable | Either form | Same as Stop hooks |

**Tactical rule:** if the hook's failure-to-fire would let an action complete that the policy intends to block, use bash form. If failure-to-fire only means "this observability event got lost," mcp_tool is fine.

**Application across UCs:**

| UC | Event | Original form (DR-023 v1) | Reframed form | Status |
|---|---|---|---|---|
| **UC-1** | Stop → notify_peer | mcp_tool | mcp_tool ✅ (unchanged) | **Shipped** v0.2.4 |
| **UC-2** | PreToolUse → check_lgtm (blocking) | mcp_tool | **bash form** | macf#270 (issue body reframe pending) |
| **UC-3** | PreCompact → checkpoint_to_memory (best-effort) | mcp_tool (Stop) | **mcp_tool (PreCompact)** — event reframe per macf#271 | **Shipped** macf#271 |
| **UC-4** | PreToolUse → check_routing_hygiene (blocking) | mcp_tool | **bash form** | **Shipped** PR #275 (`9c5099d1`) as `check-mention-routing.sh` |

**Distribution mechanics:** bash-form hooks ship via canonical `packages/macf/scripts/` directory, distributed to consumer workspaces by `macf init` / `macf update` / `macf rules refresh` (consumer-side; substrate excluded per directive). The `installGhTokenHook` function in `packages/macf/src/cli/settings-writer.ts` (kept-named for back-compat; now installs ALL canonical bash hooks) consumes the `MACF_HOOK_FILENAMES` array. Adding UC-2's eventual `check-lgtm-gate.sh` extends this array — no new framework plumbing required, mirrors PR #275's pattern.

**For substrate fleet:** UC-2 + UC-4's structural defenses are observable via tester agents (which DO run macf init); substrate operates on rule-discipline + operator-correction loop. Per operator framing: *"all what you want will be made avilable in cv project and you can see all of that in action in tester agetns."* See `silent-fallback-hazards.md` Instance 3's two-tier defense entry for analogous framing.

**Implications for future UC additions:** when proposing a new UC against this DR, the decision rule above is the first design question — "is this PreToolUse-blocking, or is this Stop / best-effort?" — before working out the MCP tool API. A blocking hook needs bash form; the rest of the design follows from that.

## Amendment 2026-06-28 — MCP tool namespace flips to the manual-server form (`macf#641`); `#639` delivery-mode toggle

The channel-server moves from the plugin's `mcpServers` to a project `.mcp.json` `server:macf-agent` (DR-022 Amendment P — the only channel-id form the dev-flag loads for a non-allowlisted channel). The MCP **tool namespace flips accordingly**, and this DR's hook wiring with it:

- **Tool names:** `mcp__plugin_macf-agent_macf-agent__*` → **`mcp__macf-agent__*`** (the manual-server namespace; the `plugin_` infix is gone). The `notify_peer` / `checkpoint_to_memory` MCP tools (Amendment K / UC-1) keep their semantics; only the namespace prefix changes.
- **Stop-hook `server` field:** `"plugin:macf-agent:macf-agent"` → **`"macf-agent"`** (this was the live `not connected` Stop-hook error the `#641` spike surfaced — the hook referenced a plugin-server id that no longer mounts as a plugin).
- **Pre-approved permission patterns** update in lockstep (the `mcp__macf-agent__*` allow-patterns), and settings `enabledMcpjsonServers: ["macf-agent"]` pre-approves the manual server so launch doesn't stall on the server-approval prompt.

**`#639` — delivery is a MODE toggle, not a hard XOR.** `MACF_CHANNELS_ACTIVE` (read by `onNotify`): `both` (default — push + tmux-wake), `channels` (push only), `tmux` (tmux-wake only). The two paths are **functionally different, not redundant**: native channel-push is stored as `type:queue-operation` + `isMeta:true` — **outside the rewindable conversation tree, so it vanishes on rewind** — while tmux-wake is a real `type:user` turn (**rewind-durable**). Default **`both`**: it preserves the only path that actually worked pre-`#641` (tmux-wake) while adding channels, and the rewind-durability difference argues *against* a `channels`-only default (a rewind would silently drop an `isMeta` push). Narrow to `channels`-only only once native push is proven robust fleet-wide.

(Cross-ref: silent-fallback-hazards Instance 15 — native channel-push never registered pre-`#641` because the plugin channel-id was dev-flag-rejected; the `server:` mount is the fix. The channel-server's stdio-lifecycle-coupling + the Path-B HTTP/SSE decoupling are tracked in DR-022 Amendment P + `macf#642`/#643.)

## Cross-references

- **PR #275** (`groundnuty/macf#272`) — shipped UC-4 as bash form; first implementation of the bash-vs-mcp_tool decision rule
- **`feedback_substrate_workspaces_dont_use_macf.md`** (private memory) — substrate-permanent-off-limit directive (2026-04-27)
- **`silent-fallback-hazards.md` Instance 3** — two-tier defense (substrate vs non-substrate) precedent
- **DR-015 (HTTP endpoints)** — amended to add §"Two surface types: HTTP endpoints + MCP tools" cross-referencing this DR
- **DR-022 (channel-server-npm-npx)** — amended with cross-ref to this DR's tool surface
- **DR-020 (notify-wake)** — amended to document RC IPC silent-fallback as known failure mode
- **DR-005 (agent-registration)** — amended to note hidden online-but-routing-bypassed state + Pattern A fail-safe-block defense
- **DR-003 (communication-planes)** — amended to document Stage 2/3 structural asymmetry
