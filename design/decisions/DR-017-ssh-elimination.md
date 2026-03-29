# DR-017: SSH Elimination

**Status:** Accepted
**Date:** 2026-03-28

## Context

The CPC PoC used SSH + tmux send-keys for routing work from GitHub Actions to agents. This was fragile and complex. Channels offer a cleaner alternative.

## Decision

Eliminate SSH entirely. Replace with HTTP POST to channel endpoint via Tailscale.

## What Changes

| Component | Before (SSH) | After (Channels) |
|---|---|---|
| Message delivery | `ssh user@host "tmux send-keys ..."` | `curl -X POST https://host:port/notify` |
| Authentication | SSH keys in authorized_keys | mTLS certificates |
| Network | Tailscale + SSH | Tailscale only |
| Agent discovery | Static agent-config.json | Dynamic GitHub variables |
| Session targeting | tmux session name | Channel process (automatic) |
| Input clearing | `tmux send-keys C-c` workaround | Not needed (clean MCP notification) |
| Offline detection | SSH connection refused | HTTP POST timeout |
| PATH issues | `tmux_bin: /opt/homebrew/bin/tmux` | Not applicable |
| Stale sessions | `can't find pane` crashes | Not applicable |

## What's Removed

- SSH key generation (`ssh-keygen`)
- `authorized_keys` management
- `SSH_KEY_CODE_AGENT` / `SSH_KEY_SCIENCE_AGENT` secrets
- `tmux_bin` config field
- `C-c` before send-keys hack
- Stale tmux session error handling
- `tmux has-session` check

## What's Kept

- Tailscale for network connectivity
- GitHub Actions for event routing
- GitHub Apps for agent identity
- Labels + @mentions for coordination

## Rationale

Every bug in the CPC PoC was related to SSH+tmux:
- `tmux: command not found` (PATH issue)
- `can't find pane` (stale session)
- Duplicate prompts (no C-c clearing)
- Git remote URL corrupted (tmux + token interaction)

Channels eliminate the entire class of tmux problems. The MCP protocol delivers clean, structured notifications directly to Claude Code's session — no shell injection, no PATH, no pane management.
