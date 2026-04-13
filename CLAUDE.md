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

- TypeScript, ESM-only (`.js` import extensions, `"type": "module"`)
- Node.js (v25+)
- `@modelcontextprotocol/sdk` — MCP channel protocol
- `node:https` — HTTPS/mTLS server
- `node:crypto` — certificate operations
- Zod v4 — runtime validation, `z.infer<>` for types
- Vitest — testing (unit, e2e, coverage)

## Development Environment

- **Devbox** is mandatory — do NOT install tools on host
- **Makefile (`dev.mk`) is the primary interface** — always use `make -f dev.mk <target>`
- Never run `devbox run -- npx ...` or `npm` directly

Key targets:
- `make -f dev.mk check` — full CI: install + build + lint + test
- `make -f dev.mk build` — type check (`tsc --noEmit`)
- `make -f dev.mk lint` — ESLint
- `make -f dev.mk test` — unit tests (no API calls)
- `make -f dev.mk test-e2e` — E2E tests (require real mTLS certs)

One-off test: `devbox run -- npx vitest run test/path/to/file.test.ts`

## Conventions

- Immutable interfaces (`readonly` properties)
- Small files (200-400 lines, 800 max)
- Functions under 50 lines
- Explicit error handling at boundaries
- `import type` for type-only imports (enforced by `verbatimModuleSyntax`)
- Zod schemas for runtime validation, TypeScript types via `z.infer<>`
- Error classes extend `MacfError` with a unique `code` string
- ESM-only: `.js` import extensions in all imports
