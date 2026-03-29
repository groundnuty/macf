# DR-005: Agent Registration via Per-Agent Variables

**Status:** Accepted
**Date:** 2026-03-28

## Context

Agents need to register their host:port so the GitHub Action and other agents can find them. This must work across VMs, handle concurrent startups, and support ephemeral workers.

## Decision

Each agent writes its own GitHub variable: `{PROJECT}_AGENT_{name}`. No shared state, no orchestrator.

## Options Considered (7 designs evaluated)

| # | Design | Race-free | Cross-VM | Ephemeral workers | Verdict |
|---|---|---|---|---|---|
| 1 | Static agent-config.json in repo | N/A | Yes | No | Can't handle workers |
| 2 | Dedicated orchestrator process | Yes | Yes | Yes | Single point of failure, overengineered |
| 3 | Leader election (etcd/bully) | Yes | Yes | Yes | Distributed consensus for port assignment is absurd |
| 4 | File-based registry (/tmp/) | Lock needed | **No** | Yes | Breaks cross-VM |
| 5 | GitHub Contents API with SHA CAS | Yes | Yes | Yes | Commits for ephemeral state |
| 6 | Single org variable (one JSON) | **No** | Yes | Yes | Race condition, no CAS |
| **7** | **Per-agent variables** | **Yes** | **Yes** | **Yes** | **Chosen** |

## Rationale

Per-agent variables are race-free by construction — each agent writes ONLY its own variable. No shared state means no concurrent write conflicts.

### Variable format

```
{PROJECT}_AGENT_{agent_name} = {
  "host": "100.86.5.117",
  "port": 8847,
  "type": "permanent",
  "started": "2026-03-28T18:00:00Z"
}
```

### No heartbeats

Liveness is checked at routing time: Action POSTs to the agent, if POST fails → agent is offline → add `agent-offline` label. No periodic API calls, no rate limit concerns.

### Cleanup

- Permanent agents: variable stays, agent overwrites on restart (self-healing)
- Workers: spawner deletes the variable after worker exits
- `/macf-status` flags stale entries

### Limits

1000 variables per org. With project prefix, that's 1000 agents per project — sufficient.
