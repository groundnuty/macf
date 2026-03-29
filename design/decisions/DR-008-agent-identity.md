# DR-008: Agent Identity (Role vs Name)

**Status:** Accepted
**Date:** 2026-03-28

## Context

An agent needs two things: a behavioral template (what it does) and a unique identifier (who it is). These can be the same or different.

## Decision

Two fields: **role** (which template) and **name** (unique identity). Usually the same, can diverge for multiples.

## Example

```
Single code-agent:
  role: code-agent       → loads agents/code-agent.md template
  name: code-agent       → registers as MACF_AGENT_code_agent

Two code-agents:
  role: code-agent       → loads agents/code-agent.md template
  name: code-agent-framework  → registers as MACF_AGENT_code_agent_framework

  role: code-agent       → same template
  name: code-agent-paper     → registers as MACF_AGENT_code_agent_paper
```

## Agent Types

| Type | Lifetime | Cleanup | Identity |
|---|---|---|---|
| **permanent** | Long-lived, restarts | Self-heals on restart | Unique name, own GitHub App |
| **worker** | Short-lived, disposable | Spawner deletes variable | Unique instance ID, shared GitHub App pool |

## Startup Collision Prevention

When an agent starts:
1. Check if variable `{PROJECT}_AGENT_{name}` exists
2. If yes: ping the registered host:port via `GET /health`
3. If responds: "Agent already running. Aborting." (prevent replacement)
4. If no response: "Previous instance dead. Taking over." (overwrite)
5. If variable doesn't exist: fresh registration

## Instance ID

Each process generates a random 6-character instance ID at startup. Used for:
- Worker naming: `worker_{instance_id}`
- Distinguishing between restarts of the same agent
- Logged for debugging
