---
name: macf-notify-peer
description: Send a message to a MACF peer agent. It is pushed into the peer's session and starts a turn there.
argument-hint: <peer> "<message>" [--verbose]
allowed-tools: mcp__macf-agent__notify_peer
---

Parse the args after `/macf-notify-peer`:

- **First positional arg** = peer name (e.g. `code-agent`)
- **Second positional arg** = message text (quoted; joined verbatim if multi-token)
- Optional flags (any order, anywhere in the args):
  - `--verbose` (default: minimal one-line response — see below; flip to full output for debugging)

Invoke `notify_peer` with:
- `to`: parsed peer name
- `event`: always `custom` (pushed into the peer's session; the other events are only recorded, never seen)
- `message`: parsed message text

**Respond with EXACTLY ONE LINE** (default; minimizes context-token consumption per macf#350):

- Success → `→ <peer> delivered=<bool>`
- Failure → `→ <peer> failed: <reason>`

Do NOT restate the JSON result, the tool's input schema, or describe what the operation did. The operator already knows what they invoked — they invoked the slash-command.

If `--verbose` was passed, also print the full `notify_peer` result JSON after the one-line confirmation.
