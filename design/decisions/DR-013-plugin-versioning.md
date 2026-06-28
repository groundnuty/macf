# DR-013: Plugin Versioning via --plugin-dir

**Status:** Accepted
**Date:** 2026-03-28

## Context

Plugin updates could break running agents. A plugin update at user-scope affects ALL agents simultaneously. We need per-agent version control.

## Decision

Don't install the plugin at user-scope. Each project has its own cloned copy of the plugin in `.macf/plugin/`. `claude.sh` references it via `--plugin-dir`.

## How It Works

```bash
# macf init clones the plugin at a specific version:
git clone --branch v1.2.0 macf-marketplace/macf-agent .macf/plugin/

# claude.sh references the local copy:
claude --plugin-dir "$DIR/.macf/plugin" --agent macf-agent:code-agent "$@"
```

Update one agent without affecting others:

```bash
cd ~/repos/macf-experiments
macf update                   # updates .macf/plugin/ to latest
# science-agent gets new version

# code-agent in another directory still runs the old version
```

## Options Considered

| Option | Per-agent version control | Disk cost | Complexity |
|---|---|---|---|
| User-scope install | No — all agents share | One copy | Low |
| Version pinning in settings | Claude Code doesn't support version constraints | One copy | N/A |
| **--plugin-dir per project** | **Yes — each project has own copy** | **N copies** | **Low** |
| npm install per project | Yes | N copies + node_modules | High |

## Rationale

`--plugin-dir` is additive — other user-scope plugins (superpowers, context7) still load. Only the macf-agent plugin is project-pinned.

The disk cost is negligible — the plugin is mostly markdown files (skills, agents) plus a small Node.js server.

Testing strategy: update code-agent first (least critical), then science-agent, then writing-agent.

## Amendment (2026-06-28, `macf#641`) — the channel-server is no longer plugin-versioned

Per DR-022 Amendment P, the **channel-server** moves out of the plugin's `mcpServers` and into a project `.mcp.json` MCP server (`npx -y @groundnuty/macf-channel-server@<pin>`), because only a `.mcp.json` `server:<name>` channel id is dev-flag-loadable for a non-allowlisted channel (the `plugin:<name>:<server>` form is rejected). **Consequence for this DR:** plugin-versioning (this DR) **no longer governs the channel-server** — its pin now lives in the `.mcp.json` `npx` args (DR-022 Amendment P). Plugin-versioning still governs the `--plugin-dir`-mounted plugin's **skills / agents / hooks / rules**. (Lock-step versioning across the three npm packages — DR-022 Amendment D — is unchanged.)
