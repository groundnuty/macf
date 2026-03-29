# DR-002: One Channel Per Agent

**Status:** Accepted
**Date:** 2026-03-28

## Context

Multiple agents may run on the same VM. Should they share a channel server or each have their own?

## Decision

Each agent gets its own channel server on its own port.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| **One channel per agent** | **Simple routing (port = agent). MCP constraint: Claude Code spawns channel as subprocess, can't share across processes.** | **N agents = N ports on same VM** |
| Shared channel, routes by name | One port, simpler infrastructure | Can't work — MCP channel is stdio between ONE server and ONE Claude Code process |

## Rationale

This isn't a choice — it's a constraint. The MCP channel protocol uses stdio between the channel server process and the Claude Code process. Each Claude Code session spawns its own MCP servers. Two Claude Code processes can't share an MCP server. Therefore: one channel per agent.
