---
name: macf-status
description: Show agent identity, channel endpoint, network peers, and coordination status. Use this when you need to check your own status or see which peers are online.
allowed-tools: Bash(node *)
---

Run this command and display the output as a formatted dashboard:

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/plugin/bin/macf-plugin-cli.js" status
```
