# P5: Plugin Packaging

**Goal:** Package the channel server, skills, agents, and hooks as a Claude Code plugin distributed via marketplace.

**Depends on:** P1 (server), P2 (registration), P4 (CLI for setup)
**Design decisions:** DR-001, DR-013, DR-014, DR-016

---

## Deliverables

1. **Plugin manifest** (`plugin.json`) — name, version, channels, mcpServers, userConfig
2. **Marketplace** (`macf-marketplace` repo with `marketplace.json`)
3. **Skills**: `/macf-status`, `/macf-peers`, `/macf-ping`, `/macf-issues`
4. **Agent definitions**: code-agent, science-agent, writing-agent, exp-* variants
5. **Hooks**: SessionStart (run `/macf-status` + `/macf-issues` on startup)
6. **Plugin CLI binary** (`bin/macf-plugin-cli.js`) — testable entry point for skills
7. **SessionStart dependency installer** hook

## Plugin Structure

```
macf-marketplace/
  .claude-plugin/
    marketplace.json
  macf-agent/
    .claude-plugin/
      plugin.json
    src/                    ← compiled from P1-P3
      dist/server.js        ← channel server (MCP + HTTPS)
    bin/
      macf-plugin-cli.js    ← CLI for skills: status, peers, ping, issues
    lib/                    ← shared library (used by both server and CLI)
      registry.ts           ← getOwnRegistration(), listPeers()
      health.ts             ← pingAgent()
      work.ts               ← checkIssues()
      format.ts             ← formatDashboard(), formatTable()
    agents/
      code-agent.md         ← from P7
      science-agent.md
      writing-agent.md
      exp-code-agent.md
      exp-science-code-aware.md
      exp-science-domain-only.md
      exp-single-agent.md
    skills/
      macf-status/SKILL.md
      macf-peers/SKILL.md
      macf-ping/SKILL.md
      macf-issues/SKILL.md
    hooks/
      hooks.json
    test/
      lib/                  ← unit tests for lib/
    package.json
```

## Plugin CLI Binary (`bin/macf-plugin-cli.js`)

A lightweight CLI bundled WITH the plugin that skills invoke. This is NOT the `macf` npm CLI (P4) — it's a plugin-internal binary that reads the agent's runtime state and registry.

```bash
# Invoked by skills:
node ${CLAUDE_PLUGIN_ROOT}/bin/macf-plugin-cli.js status
node ${CLAUDE_PLUGIN_ROOT}/bin/macf-plugin-cli.js peers
node ${CLAUDE_PLUGIN_ROOT}/bin/macf-plugin-cli.js ping code-agent
node ${CLAUDE_PLUGIN_ROOT}/bin/macf-plugin-cli.js issues
```

The CLI uses `lib/` functions which are unit-testable. The channel server (`src/dist/server.js`) also uses the same `lib/` for registration and health tracking. Shared code, two entry points.

**Relationship to `macf` npm CLI (P4):**
- `macf` (P4): setup and management, runs BEFORE Claude Code starts
- `macf-plugin-cli` (P5): runtime queries, runs INSIDE Claude Code session via skills

## Skills

Each skill runs the plugin CLI and displays the output:

```markdown
# /macf-status
---
name: macf-status
description: Show agent identity, channel endpoint, network peers, and coordination status
---
Run this command and display the output as a formatted dashboard:
    ${CLAUDE_PLUGIN_ROOT}/bin/macf-plugin-cli.js status
```

```markdown
# /macf-peers
---
name: macf-peers
description: List all registered agents with their health status
---
Run this command and display the output as a table:
    ${CLAUDE_PLUGIN_ROOT}/bin/macf-plugin-cli.js peers
```

```markdown
# /macf-ping
---
name: macf-ping
description: Ping a specific peer agent and show its detailed status
argument-hint: [agent-name]
---
Run this command and display the result:
    ${CLAUDE_PLUGIN_ROOT}/bin/macf-plugin-cli.js ping $ARGUMENTS
```

```markdown
# /macf-issues
---
name: macf-issues
description: Check pending GitHub issues assigned to this agent
---
Run this command and display the result:
    ${CLAUDE_PLUGIN_ROOT}/bin/macf-plugin-cli.js issues
If there are pending issues, ask which one to work on.
```

## Hooks

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CLAUDE_PLUGIN_ROOT}/package.json\" \"${CLAUDE_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CLAUDE_PLUGIN_DATA}\" && cp \"${CLAUDE_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CLAUDE_PLUGIN_DATA}/package.json\"",
            "timeout": 30
          }
        ]
      },
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Run /macf-status to see your identity and peers, then /macf-issues to check pending work.",
            "once": true
          }
        ]
      }
    ]
  }
}
```

The first hook installs/updates node_modules in `${CLAUDE_PLUGIN_DATA}` (PeonPing pattern — compares package.json, installs only on mismatch). The second hook prompts the agent to check status and work.

## Installation

```bash
# Add marketplace (one-time):
/plugin marketplace add groundnuty/macf-marketplace

# Install plugin:
/plugin install macf-agent@macf-marketplace

# Or for per-project pinning (via macf CLI):
macf init  # clones plugin to .macf/plugin/
claude --plugin-dir .macf/plugin/
```

## Tests

- Plugin validation: `claude plugin validate` passes
- Skills load correctly and invoke plugin CLI
- Plugin CLI `status`, `peers`, `ping`, `issues` produce correct output
- `lib/` functions have unit tests (registry, health, work, format)
- Agent definitions appear in `/agents`
- SessionStart dependency installer hook works
- SessionStart prompt hook fires
- MCP server starts as subprocess
