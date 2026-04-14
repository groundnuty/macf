---
name: macf-peers
description: List all registered agents with their health status. Use this to discover peers in the coordination network.
allowed-tools: Bash(node *)
---

Run this command and display the output as a table:

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/plugin/bin/macf-plugin-cli.js" peers
```
