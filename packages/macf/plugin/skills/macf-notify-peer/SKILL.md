---
name: macf-notify-peer
description: Send a peer notification to a specific MACF agent. Operator-driven cross-agent messaging — drops a message in the receiver's MCP push queue and wakes their tmux TUI on receipt (operator-driven `event: custom` is unconditionally wake-on-receipt; receiver-side discriminator).
argument-hint: <peer> "<message>" [--event=custom|session-end|session-compact|turn-complete|error] [--verbose]
allowed-tools: mcp__plugin_macf-agent_macf-agent__notify_peer
---

Parse the args after `/macf-agent:notify-peer`:

- **First positional arg** = peer name (e.g. `code-agent`)
- **Second positional arg** = message text (quoted; joined verbatim if multi-token)
- Optional flags (any order, anywhere in the args):
  - `--event=<type>` where `<type>` ∈ `custom` | `session-end` | `session-compact` | `turn-complete` | `error` (default: `custom`)
  - `--verbose` (default: minimal one-line response — see below; flip to full output for debugging)

Invoke `notify_peer` with:
- `to`: parsed peer name
- `event`: parsed event type (default `custom`)
- `message`: parsed message text

The receiver decides whether to wake based on the event type alone (macf#355 receiver-side discriminator): `event: 'custom'` (operator-driven) wakes the receiver TUI; the autonomous-flow events (`session-end` / `session-compact` / `turn-complete` / `error`) are observational-only (Pattern E preserves cross-agent Stop-hook loop prevention). `session-compact` is fired by the `PreCompact` hook (macf#673); `session-end` by the `SessionEnd` hook — neither fires per-turn. Operators wanting observational delivery should use a non-`custom` event type or post in a shared coordination doc.

**Respond with EXACTLY ONE LINE** (default; minimizes context-token consumption per macf#350):

- Success → `→ <peer> [<event>] delivered=<bool>`
- Failure → `→ <peer> failed: <reason>`

Do NOT restate the JSON result, the tool's input schema, or describe what the operation did. The operator already knows what they invoked — they invoked the slash-command.

If `--verbose` was passed, also print the full `notify_peer` result JSON after the one-line confirmation.
