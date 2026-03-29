# DR-001: Plugin Name and Distribution

**Status:** Accepted
**Date:** 2026-03-28

## Context

We need to package the multi-agent coordination system as a Claude Code plugin. The user installs it to make their Claude Code session capable of coordinating with other agents.

## Decision

- **Plugin name:** `macf-agent`
- **Marketplace:** `macf-marketplace` (separate repo: `groundnuty/macf-marketplace`)
- **Framework repo:** `groundnuty/multi-agent-coordination-framework`
- **CLI tool name:** `macf`

## Options Considered

### Plugin naming

| Option | Feel | Problem |
|---|---|---|
| `macf-channels` | Describes the plumbing | User doesn't care about channels, they care about coordination |
| `macf-coordination` | Describes the outcome | Redundant (MACF already means coordination) |
| `agent-coordination` | Generic | Doesn't brand it |
| `macf` | Short | Blocks namespace for future plugins (`macf-experiment`, `macf-monitor`) |
| **`macf-agent`** | **What the user gets** | **None — "I installed an agent"** |

### Distribution approach

| Option | Pros | Cons |
|---|---|---|
| C1: npm package only | Simple | No Claude Code integration (skills, hooks, agents) |
| C2: Library + CLI | Testable, importable | No plugin features |
| **C3a: Plugin in own marketplace** | **Full plugin features, multiple plugins possible** | **Extra repo for marketplace** |
| C3b: Plugin in framework repo | One repo | Mixed concerns |
| C3c: Standalone plugin repo | Self-contained | Can't add more plugins |

## Rationale

The user thinks: "I'm adding an agent to my Claude Code." Not "I'm adding channels" or "coordination." `macf-agent` reflects the user's mental model.

Separate marketplace allows future plugins (`macf-experiment`, `macf-monitor`) without mixing with framework code.
