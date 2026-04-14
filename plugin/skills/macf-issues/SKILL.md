---
name: macf-issues
description: Check pending GitHub issues assigned to this agent. Use this to find work that needs to be done.
allowed-tools: Bash(node *), Bash(gh *)
---

Run this command and display the result:

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/plugin/bin/macf-plugin-cli.js" issues
```

If there are pending issues, ask which one to work on.
