# Multi-Agent Coordination Framework (MACF)

## What This Is

A framework for coordinating multiple Claude Code agents via GitHub. Agents communicate through MCP channels (HTTP/mTLS), register via GitHub variables, and coordinate work through Issues/PRs.

## Repository Layout

```
design/
  decisions/    ← 18 design decision records (DR-001 through DR-018)
  phases/       ← 7 implementation phase specs (P1 through P7)
research/       ← 15 research documents (literature reviews, empirical analysis)
```

## Implementation Status

Not yet implemented. Design phase complete. Implementation starts with P1 (Channel Server).

## Key Design Documents

Read these before implementing:
- `design/phases/P1-channel-server.md` — the first implementation phase
- `design/README.md` — index of all decisions and phases
- `design/decisions/DR-004-authentication-mtls.md` — mTLS architecture
- `design/decisions/DR-005-agent-registration.md` — registration via GitHub variables

## Tech Stack

- TypeScript, ESM-only
- Node.js (v25+)
- `@modelcontextprotocol/sdk` — MCP channel protocol
- `node:https` — HTTPS/mTLS server
- `node:crypto` — certificate operations

## Conventions

- Immutable interfaces (`readonly` properties)
- Small files (200-400 lines, 800 max)
- Functions under 50 lines
- Explicit error handling at boundaries
- `import type` for type-only imports
