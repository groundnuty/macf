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
6. **SessionStart dependency installer** (installs node_modules to `${CLAUDE_PLUGIN_DATA}`)

## Plugin Structure

```
macf-marketplace/
  .claude-plugin/
    marketplace.json
  macf-agent/
    .claude-plugin/
      plugin.json
    src/                    ← compiled from P1-P3
      dist/server.js
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
    package.json
```

## Skills (backed by CLI binary)

Each skill invokes the channel CLI for testable operations:

```markdown
# /macf-status
---
name: macf-status
description: Show agent identity, channel endpoint, network peers, and coordination status
---
Run: ${CLAUDE_PLUGIN_ROOT}/bin/macf-agent-cli status
Display the output as a formatted dashboard.
```

## Hooks

```json
{
  "hooks": {
    "SessionStart": [
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
- Skills load correctly
- Agent definitions appear in `/agents`
- SessionStart hook fires
- MCP server starts as subprocess
