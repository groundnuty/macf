# DR-003: Two Communication Planes

**Status:** Accepted
**Date:** 2026-03-28

## Context

How do agents communicate? Through GitHub? Through direct channels? Both?

## Decision

Two separate communication planes:

1. **GitHub** (work artifacts): Issues, PRs, reviews, comments. Persistent, auditable, board-visible.
2. **Channels** (operational signals): Routing notifications, P2P health pings. Ephemeral, infrastructure.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| GitHub only (current CPC) | Simple, auditable | Can't health-ping, no direct agent-to-agent |
| Channels only | Fast, direct | No audit trail, no board visibility |
| **Both, separated by purpose** | **Audit trail for work, speed for operations** | **Two systems to maintain** |

## Rationale

These planes serve different purposes and don't compete:

- **GitHub** answers: "What work was done? Who decided what? What's the status?" (content)
- **Channels** answer: "Is the agent alive? Where is it? Route this issue to it." (plumbing)

Like HTTP serves content but TCP keepalives check the connection. Different layers, different concerns.

The GitHub Action stays — it handles label routing, @mention routing, board sync, offline detection. Channels replace only the message delivery mechanism (HTTP POST instead of SSH+tmux).
