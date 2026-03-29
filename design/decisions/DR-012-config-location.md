# DR-012: Config Location (.macf Per Project)

**Status:** Accepted
**Date:** 2026-03-28

## Context

Multiple agents run on the same machine, same user. Plugin config needs to be per-agent, not per-user. Where does agent-specific config live?

## Decision

Per-project `.macf/` directory (gitignored) + global `~/.macf/` for machine-level state.

## Layout

```
~/.macf/                              Global (per machine)
  ca-key.pem                          CA private key
  config.json                         Default org, tailscale hostname
  agents.json                         Index of agent paths (just paths, no duplication)

project/.macf/                        Per project (gitignored)
  plugin/                             Pinned plugin version (cloned)
  certs/
    agent-cert.pem                    This agent's cert
    agent-key.pem                     This agent's private key
  macf-agent.json                     Agent config (project, role, name, type, registry)
  macf-agent.state.json               Runtime state (port, instance_id, last_registered)
  logs/
    channel.log                       Channel server logs
```

## Why Not User-Scope Plugin Config?

Claude Code's `~/.claude/settings.json` is shared by all sessions. If two agents run simultaneously, they'd share plugin config — but they need DIFFERENT configs (different roles, ports, certs).

Each agent works in a different project directory. `.macf/` in the project directory is naturally per-agent.

## Global Index (`~/.macf/agents.json`)

Stores ONLY paths — no duplication of agent config:

```json
{
  "agents": [
    "/Users/orzech/repos/macf-experiments",
    "/Users/orzech/repos/claude-plan-composer-ts"
  ]
}
```

`macf` CLI reads the index, then reads each project's `.macf/macf-agent.json` for details. One source of truth per agent.

## Config vs State Separation (PeonPing pattern)

- `macf-agent.json` — user choices, persists across restarts (project, role, name, registry config)
- `macf-agent.state.json` — runtime data, regenerated each startup (port, instance_id, timestamps)
