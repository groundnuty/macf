# P4: CLI (`macf`)

**Goal:** Command-line tool for setup, management, and diagnostics. Distributed via npm as `@macf/cli`.

**Depends on:** P2 (registry), P3 (certs)
**Design decisions:** DR-012, DR-016

---

## Deliverables

1. **`macf`** — list all agents on this machine (reads `~/.macf/agents.json` index)
2. **`macf init`** — set up a project directory for an agent
3. **`macf update`** — update plugin in current project's `.macf/plugin/`
4. **`macf status`** — ping all agents (terminal version of `/macf-status`)
5. **`macf peers`** — list peers (terminal version of `/macf-peers`)
6. **`macf certs init`** — create CA, upload cert + encrypted key to registry
7. **`macf certs recover`** — download and decrypt CA key from registry
8. **`macf certs rotate`** — regenerate agent cert with existing CA
9. **`macf setup github-app`** — Chrome automation for GitHub App creation (optional, `--chrome` flag)
10. **`macf cd <agent>`** — print agent's project path

## `macf init` Flow

```bash
macf init --project macf --role science-agent
```

1. Auto-detect: Tailscale IP, org from git remote
2. Prompt for: project name, role, agent name (defaults to role), GitHub App ID, Installation ID
3. Create `.macf/` directory structure
4. Clone plugin to `.macf/plugin/` (from marketplace repo at latest tag)
5. Generate agent cert (if CA key available locally or via `/sign` peer)
6. Write `macf-agent.json` config
7. Generate `claude.sh` (with passthrough args)
8. Add `.macf/` to `.gitignore`
9. Merge plugin reference into `.claude/settings.local.json`
10. Register in `~/.macf/agents.json` index

Two modes for GitHub App:
- **Manual**: prompts for App ID, Installation ID, key path
- **Auto** (`--setup-app`): uses `claude --chrome -p` to create App in browser

## `~/.macf/` Global Structure

```
~/.macf/
  config.json         ← {"default_org": "macf-experiment", "tailscale_hostname": "orzech-pro"}
  ca-key.pem          ← CA private key (if this is the CA machine)
  agents.json         ← ["/path/to/project1", "/path/to/project2", ...]
```

## Distribution

```bash
npm install -g @macf/cli
```

Package: `@macf/cli` on npm. Binary: `macf`.

## Tests

- `macf init`: creates correct directory structure, config, claude.sh
- `macf status`: reads index, pings agents, formats output
- `macf certs init`: creates CA, uploads to registry
- `macf certs recover`: round-trip test
- Integration: `macf init` + start claude.sh + verify channel works
