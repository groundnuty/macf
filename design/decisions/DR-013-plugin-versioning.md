# DR-013: Plugin Versioning via --plugin-dir

**Status:** Accepted
**Date:** 2026-03-28

## Context

Plugin updates could break running agents. A plugin update at user-scope affects ALL agents simultaneously. We need per-agent version control.

## Decision

Don't install the plugin at user-scope. Each project has its own cloned copy of the plugin in `.macf/plugin/`. `claude.sh` references it via `--plugin-dir`.

## How It Works

```bash
# macf init clones the plugin at a specific version:
git clone --branch v1.2.0 macf-marketplace/macf-agent .macf/plugin/

# claude.sh references the local copy:
claude --plugin-dir "$DIR/.macf/plugin" --agent macf-agent:code-agent "$@"
```

Update one agent without affecting others:

```bash
cd ~/repos/macf-experiments
macf update                   # updates .macf/plugin/ to latest
# science-agent gets new version

# code-agent in another directory still runs the old version
```

## Options Considered

| Option | Per-agent version control | Disk cost | Complexity |
|---|---|---|---|
| User-scope install | No — all agents share | One copy | Low |
| Version pinning in settings | Claude Code doesn't support version constraints | One copy | N/A |
| **--plugin-dir per project** | **Yes — each project has own copy** | **N copies** | **Low** |
| npm install per project | Yes | N copies + node_modules | High |

## Rationale

`--plugin-dir` is additive — other user-scope plugins (superpowers, context7) still load. Only the macf-agent plugin is project-pinned.

The disk cost is negligible — the plugin is mostly markdown files (skills, agents) plus a small Node.js server.

Testing strategy: update code-agent first (least critical), then science-agent, then writing-agent.
