# DR-014: Startup-Only Polling

**Status:** Accepted
**Date:** 2026-03-28

## Context

How does an agent discover pending work? Options: periodic polling, event-driven only, or startup check.

## Decision

Check for pending issues ONCE at startup. No periodic polling. User runs `/macf-issues` manually when needed.

## Options Considered

| Option | Context contamination | Automation | Complexity |
|---|---|---|---|
| Periodic poll (every 5 min) | Yes — interrupts mid-task | Full | Timer, busy detection needed |
| Periodic with 30-min quiet threshold | Reduced but tasks can take 1h+ | Partial | Complex idle detection |
| Channel self-poll | Yes — same as periodic | Full | Same problems |
| **Startup check only + /macf-issues skill** | **None** | **Startup only** | **Simple** |
| No polling (pure event-driven) | None | None | Misses offline-accumulated issues |

## Rationale

Periodic polling contaminates the agent's session. If the agent is deep in implementing a feature and gets:

```
<channel type="poll_result">Pending issues: #42, #43</channel>
```

...it interrupts thinking, wastes context, and may confuse the agent ("should I stop?").

The channel server can't tell "agent is busy implementing" from "agent is idle." There's no reliable busy detection.

### How work gets picked up

1. **Normal flow**: Action POSTs to channel when issue is labeled → agent receives immediately
2. **Startup**: Channel checks once for pending issues → auto-picks up anything missed while offline
3. **Manual recovery**: User runs `/macf-issues` → sees pending work, tells agent to pick it up
4. **Self-chaining**: Agent rules say "check for more work after completing a task" → `gh issue list`

### Tailscale-down-then-up recovery

Action tried to POST, failed, added `agent-offline` label. When Tailscale comes back:
- Channel is already running (it's a subprocess of Claude Code)
- No automatic re-check — user runs `/macf-issues` to see accumulated work
- Or: agent finishes current task, self-chains to check for work (per rules)
