# DR-018: Startup Collision Detection

**Status:** Accepted
**Date:** 2026-03-28

## Context

If a user accidentally starts a second instance of the same agent, the second should NOT silently replace the first's registration.

## Decision

On startup, check if the agent is already running. Abort if alive, take over if dead.

## Flow

```
1. Pick port, start listening on it
2. Read registry variable: {PROJECT}_AGENT_{name}
3. If variable exists:
   a. GET /health on registered host:port
   b. If responds: "Agent {name} is already running at {host}:{port}. Aborting."
      → exit with error
   c. If no response: "Previous {name} is dead. Taking over."
      → overwrite registration with new host:port
4. If variable doesn't exist:
   → fresh registration
```

## Scenarios

| Scenario | Variable exists? | Health ping? | Result |
|---|---|---|---|
| Fresh start | No | — | Register normally |
| Previous crashed | Yes | No response | Take over |
| Already running | Yes | Responds | **Abort with error** |
| Moved to different machine | Yes (different host) | No response | Take over |
| Same machine, different port | Yes (different port) | Responds | **Abort** (same host, existing instance alive) |

## Rationale

Silent replacement is dangerous — the first agent might be mid-task. An overwrite would disconnect it from the routing system without warning. The user should explicitly stop the first agent before starting another.

For workers: collision is impossible because each worker has a unique instance ID in its name (`worker_a8f3c2`).

## User Experience

```bash
./claude.sh
# Error: Agent 'science-agent' is already running at 100.86.5.117:8847
# To force takeover: macf init --force
# To stop the existing agent: switch to its tmux session and /exit
```
