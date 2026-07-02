---
name: macf-issues
description: Check pending GitHub issues, drain any inbox messages that arrived while you were offline, and run the coordination.md §5 sweeps. Use this to reconcile your startup state and find work that needs to be done.
allowed-tools: Bash(node *), Bash(gh *)
---

Run this command and display the result:

```!
node "${CLAUDE_PLUGIN_ROOT}/dist/plugin/bin/macf-plugin-cli.js" issues
```

The output has up to three parts (DR-038 Decision 5 — the on-startup completeness half):

1. **Pending issues** — if any, ask which one to work on.
2. **Drained inbox messages** (only shown if non-empty) — messages that
   were persisted but not yet processed: arrived while you were busy,
   relaunching, or whose tmux-wake didn't land. Treat each one as if it
   had just arrived and act on it.
3. **Coordination sweep instruction** — always shown. Run the
   coordination.md §Communication 5 review/gate/mention sweeps against
   live GitHub state before considering yourself idle, even if nothing
   above needs action.
