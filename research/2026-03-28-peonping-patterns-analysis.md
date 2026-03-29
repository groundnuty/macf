# PeonPing Patterns Analysis: What We Adopted for MACF

Date: 2026-03-28
Source: https://github.com/PeonPing/peon-ping (v2.17.0)
Context: Analyzed PeonPing as a reference implementation for Claude Code plugin distribution and configuration patterns.

---

## What PeonPing Is

A notification and sound effect system for AI coding agents. Plays game character voice lines (Warcraft, StarCraft, Portal) when agents need attention. Integrates with Claude Code via hooks and skills.

## Key Insight: PeonPing is NOT a Claude Code Plugin

PeonPing predates the plugin system. It uses `install.sh` that:
1. Copies files to `~/.claude/hooks/peon-ping/`
2. Merges hooks into `settings.json` without clobbering existing entries
3. Downloads sound packs from a registry
4. Provides skills via `skills/` directory

This is a hook system, not a plugin. But its patterns are applicable to our plugin design.

## Patterns Adopted for MACF

### 1. Auto-Detection Over Manual Input

PeonPing auto-detects: platform (macOS/Linux/WSL2), headphones, meeting status, IDE type.

**MACF adopts**: auto-detect Tailscale IP (`tailscale ip -4`), org from git remote, existing GitHub Apps. `macf init` prompts only for what can't be auto-detected (project name, agent role).

### 2. Config + State Separation

PeonPing splits:
- `config.json` — user preferences, persisted
- `.state.json` — runtime data (session IDs, rotation index, no-repeat cache)

**MACF adopts**:
- `macf-agent.json` — user choices (project, role, name, registry config)
- `macf-agent.state.json` — runtime data (port, instance_id, last_registered)

### 3. Global + Project-Level Config Hierarchy

PeonPing: `$PWD/.claude/hooks/peon-ping/config.json` overrides `~/.claude/hooks/peon-ping/config.json`.

**MACF adopts**: `~/.macf/` for global config (CA key, agent index), `.macf/` per project for agent-specific config.

### 4. Config Migration on Version Change

PeonPing auto-backfills new config keys when updated. `peon update` runs migrations.

**MACF adopts**: `macf-agent.json` will have a version field. `macf update` auto-migrates config to new schema.

### 5. Skills as User Interface

PeonPing: `/peon-ping-config`, `/peon-ping-toggle`, `/peon-ping-use`. Slash commands for in-session interaction.

**MACF adopts**: `/macf-status`, `/macf-peers`, `/macf-ping`, `/macf-issues`. Same pattern.

### 6. CLI as Fallback

PeonPing: `peon toggle`, `peon volume 0.8` work from terminal if skills fail.

**MACF adopts**: `macf status`, `macf peers` as terminal equivalents of the skills. The CLI binary (`macf-channels-cli`) backs both skills and terminal commands.

### 7. Debug Mode

PeonPing: `"debug": true` in config enables structured logging.

**MACF adopts**: `"debug": true` in `macf-agent.json` enables JSON-structured channel server logs in `.macf/logs/channel.log`.

### 8. Async SessionStart Hook

PeonPing runs most hooks async to avoid blocking the IDE.

**MACF adopts**: SessionStart hook uses `"once": true` and runs `/macf-status` as a prompt-type hook (async, doesn't block session start).

### 9. Atomic State I/O

PeonPing uses temp file + rename for crash-safe config writes. Windows uses `Move-Item -Force`.

**MACF adopts**: Same pattern for `macf-agent.state.json` updates during registration and port changes.

### 10. Hook Registration as Code

PeonPing's installer uses Python to read/merge `settings.json`, preserving existing entries.

**MACF adopts**: `macf init` merges plugin references into `.claude/settings.local.json` without clobbering user's existing hooks and plugins.

## Patterns NOT Adopted

| PeonPing Pattern | Why Not |
|---|---|
| `curl \| bash` install | We use Claude Code plugin system instead |
| Sound packs + registry | Not applicable to coordination |
| Homebrew tap | Plugin marketplace is our distribution |
| Multi-IDE adapters | We only target Claude Code |
| Embedded Python in bash | Our channel server is TypeScript/Node |

## Reference

- PeonPing repo: https://github.com/PeonPing/peon-ping
- PeonPing skills: `skills/peon-ping-config/SKILL.md` (good template for skill structure)
- PeonPing config: `config.json` (good reference for config schema design)
- PeonPing installer: `install.sh` (hook registration pattern)
