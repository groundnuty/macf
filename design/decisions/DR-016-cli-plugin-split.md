# DR-016: CLI + Plugin Split

**Status:** Accepted
**Date:** 2026-03-28

## Context

The system has two types of functionality: setup/management (one-time or occasional) and runtime (always-on during agent sessions). Should they be one thing or two?

## Decision

Two separate tools:
- **`macf` CLI** (npm): setup, management, cert operations, global status
- **`macf-agent` plugin** (marketplace): runtime channel, skills, agent identities, hooks

## Responsibility Split

| Concern | CLI (`macf`) | Plugin (`macf-agent`) |
|---|---|---|
| One-time setup | `macf init` | — |
| Cert management | `macf certs init/recover/rotate` | — |
| GitHub App creation | `macf setup github-app` (Chrome) | — |
| Global agent index | `macf` (lists all agents) | — |
| Plugin version management | `macf update` | — |
| Runtime channel server | — | MCP server |
| Runtime skills | — | `/macf-status`, `/macf-peers`, `/macf-ping`, `/macf-issues` |
| Agent identities | — | `agents/*.md` |
| Startup hooks | — | SessionStart check |
| Token refresh | — | In agent rules |

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Everything in plugin | One install | Plugin can't do Chrome automation, npm install, cert generation |
| Everything in CLI | One install | CLI can't inject into Claude Code session (no skills, hooks, channels) |
| **CLI for setup + Plugin for runtime** | **Each does what it's good at** | **Two installs** |

## Rationale

The CLI does things BEFORE Claude Code starts (setup, certs, config). The plugin does things WHILE Claude Code runs (channel, skills, hooks). Different lifecycles, different capabilities.

The CLI distributes via npm (`npm install -g @macf/cli`). The plugin distributes via marketplace. They complement but don't depend on each other at runtime — the plugin works without the CLI (if manually configured), and the CLI works without the plugin (for setup operations).

## CLI Commands

```bash
macf                                  # list all agents on this machine
macf init --project X --role Y        # set up project directory
macf update                           # update plugin in current project
macf status                           # ping all agents (terminal version of /macf-status)
macf certs init                       # create CA
macf certs recover                    # recover CA from encrypted backup
macf certs rotate                     # rotate agent cert
macf setup github-app                 # Chrome automation for App creation
macf cd <agent-name>                  # print agent's project path
```

## Plugin Skills

```
/macf-status    → self + peers + coordination dashboard
/macf-peers     → peer list with health
/macf-ping      → ping specific agent
/macf-issues    → check pending GitHub issues
```
