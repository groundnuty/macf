# Agent launch and sandbox

Operator and framework reference, moved out of the distributed `coordination.md` because agents do not act on it.

## tmux sessions

Each agent runs in its own tmux session named `<project>@<agent>`. `claude.sh` creates it and re-attaches if it exists.

- One session per agent, because the channel server's tmux wake finds its pane from `$TMUX_PANE`; two agents sharing a session can resolve to the same pane and wakes land on the wrong agent.
- The name uses the agent's `MACF_ROUTING_LABEL`, not its display name `MACF_AGENT_NAME` (for example `macf@science-agent`, not `macf@macf-science-agent`), because the watchdog, registry key and certificate CN all key on the routing label. The two coincide for most agents. Log directories under the state dir use `MACF_AGENT_NAME`, so do not derive one from the other.
- `MACF_NO_TMUX_WRAP=1 ./claude.sh` skips the self-wrap, for debugging or CI.
- `claude.sh` passes `MACF_*` variables into the new session with `tmux new-session -e`, because a new tmux session otherwise inherits the tmux server's environment, not the launching shell's.
- Separate sessions let several terminals attach to different agents independently.

## Sandbox on Linux

Claude Code's sandbox breaks Bash tool calls on Linux. Two separate upstream failures produce it:

| failure | error text | state |
|---|---|---|
| `apply-seccomp` writes `/proc/self/setgroups` before mapping the UID; nested user namespaces reject that without `CAP_SYS_ADMIN` | setgroups / seccomp error | open upstream (anthropic/claude-code#43454) |
| the spawned shell reads `/proc/self/fd/3` at startup and is denied | `/proc/self/fd/3` denied | closed not-planned upstream (anthropic/claude-code#52118); never fixed |

The error string tells which one you have. An `allowRead` rule for `/proc/self/fd` does not help, because the failure happens before the rule applies. Treat the workaround as permanent: a distribution's AppArmor policy may be the real cause, which no Claude Code release fixes.

Workaround: list common dev-loop commands in `sandbox.excludedCommands` so they run unsandboxed. `macf init`, `macf update` and `macf rules refresh` install the canonical set (`SANDBOX_EXCLUDED_COMMANDS` in `packages/macf/src/cli/settings-writer.ts` is the source of truth) and preserve operator entries.

- Included: build and deployment tools (`ssh`, `scp`, `rsync`, `devbox`, `nix`, `git`, `gpg`, `gh`, `npx`, `npm`, `node`, `make`, `tmux`, `jq`, `openssl`), search and read tools, shell wrappers (`bash`, `sh`, `xargs`, because subprocess shells fail at init under the regression), and low-risk file writes (`mkdir`, `cp`, `touch`).
- Excluded on purpose: `rm` and `mv`, so destructive operations stay sandboxed.
- `MACF_SANDBOX_EXCLUDED_COMMANDS_SKIP=1` skips the install; refresh then does not re-add entries you removed.
