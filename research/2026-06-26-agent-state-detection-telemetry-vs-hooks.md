# Agent state-detection: surface investigation + design (2026-06-26)

**Status:** design (informs the DR-030 `/health.state` increment, macf#568)
**Driver:** operator + code-agent, 2026-06-26
**Claude Code version under test:** 2.1.193

## 1. The question

DR-030's mesh-layer `/health` should report **what each agent is doing now** —
not just `idle|busy`, but ideally the **turn number**, the **turn status**, **how
long it's been on the current turn**, and a little recent context. The channel
server (the auto-starting plugin MCP) is the natural reader; the question is
**which surface exposes the live turn state**, under two hard constraints:

- **C1 — fleet-doctor is a *diagnostic*, not an observability stack.** The
  dedicated telemetry stack is DevOps-owned. We must **not** put our tool in the
  middle of the telemetry path.
- **C2 — don't modify the consumer project's `settings.json`.** Adding hooks to a
  consumer's `settings.json` risks friction with the user's own scripts.

The motivating worst case (operator): **an agent runs a script and waits 20
minutes for it.** It is *busy* the whole time, but there is **zero API activity**
during the wait. Any signal that says "idle" here is wrong.

## 2. Surfaces investigated

| Surface | Carries turn-state? | Live through a 20-min tool wait? | Puts us in telemetry path? | Touches `settings.json`? |
|---|---|---|---|---|
| **Metrics** (Prometheus pull) | only counters (`active_time`, `token`, `cost`) | **No** — boundary-recorded; freeze during any wait | No (clean dual-export) | No |
| **Traces** (`claude_code.interaction` span) | **Yes** — `interaction.sequence` (turn #), `interaction.duration_ms`, `stop_reason` (status), `tool.execution.duration_ms` | **No** — spans export at span-**end**; the open turn isn't visible | n/a | No |
| **Events** (`user_prompt`, `tool_result`) | partial — turn-start + tool-end markers | partial (~5s); no "in-progress" event | needs a local OTLP receiver | No |
| **Status-line JSON** | **No** — session-cumulative only (`cost.total_duration_ms`, context, cost); no turn #/status/elapsed field | n/a | No | No |
| **Transcript file** | implicit (written during a turn) | **No** — frozen during tool waits / inferences | No | No |
| **Local OTLP trace+event receiver** (reconstruct the turn FSM) | **Yes** (turn #, status, phase, recent steps) | **Yes** (~5s latency) | **Yes — tee** (rejected per C1) | No |
| **Plugin hooks** (`UserPromptSubmit`/`Stop`/`PreToolUse`) | **Yes** — turn #, status, elapsed, **live command** | **Yes** — exact turn boundaries; busy the whole wait | No | **No** — shipped in the plugin's `hooks/hooks.json` |

## 3. Empirical findings (live tests on 2.1.193)

- **The Prometheus dual-export is real.** `OTEL_METRICS_EXPORTER=prometheus,otlp`
  (prometheus **first**) + a **reachable** otlp endpoint → a local `/metrics`
  pull endpoint on `:9464` **and** the otlp push, with **no tee and no
  critical-path**. Gotchas, all confirmed by test:
  - **Order matters** — `otlp,prometheus` (otlp first) silently never binds
    `:9464`; `prometheus,otlp` binds it.
  - **Use the default port `:9464`** — setting `OTEL_EXPORTER_PROMETHEUS_PORT`
    broke the bind.
  - **The otlp endpoint must be reachable.** A dead-dummy endpoint causes the
    prometheus reader to come up serving `MetricReader is not bound to a
    MetricProducer` (no metrics) — this produced an initial *false* "it's
    broken." With a reachable otlp endpoint, both exporters serve correctly.
    *(In production otlp always points at the monitoring VM, so this is moot.)*
- **`-p`/headless suppresses `active_time`** (Claude Code changelog: *"Fixed
  `claude_code.active_time.total` not being emitted in `--print` mode"*).
  Interactive sessions emit it.
- **The metrics are recorded at API-call boundaries, not continuously.** Over
  **80+ seconds of a single long inference** (and by the same mechanism, a long
  tool wait) `active_time` and `token_usage` stayed **frozen**. So the metric
  signal is coarse and **reads idle during the 20-min wait** — it fails C-driver.
- **Prometheus is architecturally metrics-only.** It is an OTel *MetricReader*;
  it cannot serve traces or events. The turn-state lives in **span attributes**
  (`interaction.sequence`, `stop_reason`, `interaction.duration_ms`), so
  Prometheus **cannot** carry it regardless of effort.
- **Traces/events DO carry the live turn FSM** — `user_prompt` (turn start),
  `llm_request.stop_reason` (`tool_use` ⇒ dispatched a tool; `end_turn` ⇒
  winding down), `tool_result` (tool done), `interaction` close (turn done).
  Received locally (~5s), a state machine over this stream reconstructs "turn N,
  in a tool for 18 min, after these recent steps" **accurately, through the
  wait** — but reading traces+logs locally requires the server to **be** the
  OTLP endpoint and forward to the monitoring VM (a tee), which **C1 forbids**.
  *(The one thing even this can't give live: the specific in-flight command —
  `tool_name`/`full_command` are on the tool span, which exports at tool-end.)*
- **The status-line JSON has no turn-state.** Read the full field list: it is
  session-level cumulative (`cost.total_duration_ms`, `context_window.*`,
  `cost.*`) — no turn number, no status, no current-turn elapsed.
- **Plugin hooks are first-class and additive.** Claude Code has five hook
  sources — user / project / project-local `settings.json`, managed policy, and
  **plugin `hooks/hooks.json`** — and *"when a plugin is enabled, its hooks
  **merge with** your user and project hooks"* (additive; the `/hooks` menu
  labels each source). The MACF plugin **already** ships
  `packages/macf/plugin/hooks/hooks.json` (`SessionStart`/`Stop`/`PreCompact`).
  *Nuance:* v0.2.36 dropped the plugin **`manifest.hooks`** (`plugin.json`
  `hooks` key) because it *duplicated* the settings-wired hooks; the dedicated
  **`hooks/hooks.json` is the current, correct mechanism**, and the state hooks
  are *new* (plugin-only), so no doubling.

## 4. Decision

**Detect live turn-state with plugin-shipped hooks (turn marker). Keep
Prometheus only for cheap session metrics (overview), never for state.**

Rationale: only the hook marker is **accurate through a tool wait** (it tracks
the *turn boundary*, not activity bursts), **and** it satisfies both constraints
— it never sits in the telemetry path (C1) and it ships **in the plugin's
`hooks/hooks.json`, not the consumer's `settings.json`** (C2). The telemetry
route that could match it (local OTLP trace+event receiver) is rejected by C1.
Prometheus, though a clean dual-export, is metrics-only and coarse — it cannot
carry turn-state and fails the 20-min-wait driver.

### Rejected, and why
- **Telemetry-in-the-path** (local OTLP trace/event receiver + tee) — accurate,
  but violates C1 (fleet-doctor must not be a telemetry forwarder; DevOps owns
  observability).
- **Prometheus for state** — metrics-only, boundary-recorded, freezes during
  waits ⇒ wrong for the driver case.
- **`settings.json` hooks** — superseded by plugin hooks (no consumer
  `settings.json` modification, no user-script friction).
- **Status-line / transcript** — no turn-state / frozen during waits.

## 5. The `state` design

### 5.1 Plugin hooks (added to `packages/macf/plugin/hooks/hooks.json`)

All `command`-type, writing a single local **turn-state marker**. Set is
`async: true` (zero turn latency; a marker write is sub-ms anyway).

- **`UserPromptSubmit`** → `{ turn_number += 1, started_at: <now>,
  status: "busy", prompt_summary: <truncated> }`
- **`PreToolUse`** → `{ phase: "tool", current_tool: <name>,
  current_command: <truncated>, tool_started_at: <now> }`
- **`PostToolUse` / `PostToolUseFailure`** → `{ phase: "thinking",
  current_tool: null }`
- **`Stop`** → `{ status: "idle", ended_at: <now>,
  last_turn_duration_ms, tool_use_count, output_tokens }`
  *(the `Stop` payload provides `tool_use_count` + `output_tokens`)*
- **`StopFailure` / `SessionEnd`** → `{ status: "idle", reason }` (crash/error/exit)

Marker lives at a plugin/workspace path the channel server can read
(`${CLAUDE_PLUGIN_DATA}/turn-state.json` or `.macf/turn-state.json`).

### 5.2 Channel-server read → `/health.state`

The channel server reads the marker and derives, **live and correct through a
tool wait**:

```jsonc
"state": {
  "status": "busy" | "idle",
  "turn_number": 7,
  "elapsed_ms": 1182000,            // now − started_at; climbs through a 20-min wait
  "phase": "tool" | "thinking" | null,
  "current_tool": "Bash",           // optional (PreToolUse)
  "last_turn_duration_ms": 43000,
  "tool_use_count": 12,
  "output_tokens": 2048
}
```

- **Turn-number semantics** mirror `interaction.sequence`: per-session, 1-based,
  increments per prompt, **survives `/compact`** (same `session_id`), resets on
  a new session.
- **Crash without `Stop`** leaves a stale "busy" marker; the `started_at`
  timestamp makes the staleness visible as "busy since X" (duration shown), and
  `SessionEnd`/`StopFailure` cover graceful/error exits.

### 5.3 Optional Prometheus session stats (overview, not state)

Independently, the channel server MAY scrape the agent's local Prometheus
`:9464` (via `OTEL_METRICS_EXPORTER=prometheus,otlp`, prometheus-first, set in
`claude.sh`) for **cumulative session metrics** — cost, tokens, lines changed,
commits/PRs — surfaced as a `/health.session_stats` overview. This is a fleet
*"what has each agent produced/spent"* summary, **not** the live `state`, and
carries no telemetry-path risk (independent exporter; otlp still pushes straight
to the monitoring VM).

## 6. Build notes (macf#568)

- The state hooks are **new** plugin hooks — no overlap with the settings-wired
  `check-*.sh` hooks, so no `/doctor Duplicate hooks` risk.
- `state` was always best-effort in DR-030; this makes it **accurate** for the
  busy/idle + turn-structure dimension at no extra deployment cost (rides the
  plugin the fleet already loads).
- `current_command` (the live command) is the one detail telemetry can't give
  live; the `PreToolUse` hook is where it's earned.
