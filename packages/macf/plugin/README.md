# `packages/macf/plugin/` — source-of-truth map

Not everything here is the consumer-facing source. Read this before editing.

## What consumers actually run (canonical = the marketplace)

The **mountable plugin** — the `.claude-plugin/plugin.json` manifest (incl. the
`mcpServers` channel-server launch block), `skills/`, `agents/`, `hooks/` — is
canonical in a **separate repo**: [`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace)
under `macf-agent/`. `macf init` / `macf update` fetch it at a pinned tag into
`<workspace>/.macf/plugin/`, and `claude.sh` mounts THAT copy via
`--plugin-dir` (DR-013). Nothing mounts or publishes the copy under this
directory.

Edit the plugin manifest / skills / agents / hooks in the **marketplace repo**,
not here.

## The exception: `rules/` IS canonical here

`packages/macf/plugin/rules/` (coordination.md, delegation-template.md,
silent-fallback-hazards.md, …) is the single source of truth — the CLI's
`rules.ts` distributes it into each workspace's `.claude/rules/` at
`macf init` / `macf update` / `macf rules refresh`. Edit rules HERE.

## Why there's no `.claude-plugin/plugin.json` here anymore

It was removed as vestigial (groundnuty/macf#426). It had silently drifted from
the live marketplace copy — frozen at `version: 0.1.0` with the pre-v0.2.0
`node ${CLAUDE_PLUGIN_ROOT}/dist/server.js` launch form, while the mounted
marketplace copy moved to `npx @groundnuty/macf-channel-server` and shipped
through 0.2.3x. Keeping a stale duplicate misled anyone reading it as the
source. **Marketplace is the source of truth for the manifest** (per the #426
design decision).

## Drift guard

`.github/workflows/publish.yml` runs a version-lockstep check at release time:
it fetches the marketplace `macf-agent/.claude-plugin/plugin.json` at the
release tag and fails the publish if its `version` doesn't match the release
version — so the marketplace can't silently lag npm (the hazard that left it at
0.2.26 / 0.2.33 behind shipping npm versions).

## Follow-up

Reconciling whether `skills/` / `agents/` / `hooks/` under this directory are
also vestigial (vs a generation source) is tracked separately — see the #426
thread. For now treat the marketplace as canonical for all of them.
