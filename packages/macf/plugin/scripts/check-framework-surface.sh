#!/usr/bin/env bash
#
# check-framework-surface.sh — Claude Code SessionStart hook (groundnuty/macf#814)
# that detects when the macf-distributed framework surface (the MCP plugin
# mount, the agent identity config, the guard-hook scripts) has been silently
# swept away by an untracked-sweeping git operation, and warns LOUDLY into the
# agent's context so it knows to run `macf update` to re-distribute.
#
# WHY (the real incident this is the safety net for): `.macf/plugin/`,
# `.macf/macf-agent.json`, `.macf/env.*`, and `.claude/scripts/check-*.sh` are
# ALL UNTRACKED in the consumer agent repo. A routine `git stash push -u`
# (or `git stash --include-untracked` / `-a` / `--all`) silently sweeps them
# into the stash; `git checkout` / a branch switch then leaves the working
# tree without them; `git stash show -p` HIDES the untracked portion of a
# stash (so a swept stash still looks "safe" — only tracked-file diffs show);
# `git stash drop` then PERMANENTLY deletes the payload, unrecoverable via
# git. `git clean -fd` (or any force+directories combo) does the same damage
# directly, no stash involved. The resulting damage: no MCP plugin
# (notify_peer / channel tools gone), no identity config (`macf-agent.json`,
# so a clean relaunch fails), and — worst — every PreToolUse/PostToolUse
# guard hook gone. Those hooks fail NON-BLOCKING when their script is
# missing (Claude Code just can't find the command), so the agent keeps
# running SILENTLY UNGUARDED: no attribution-trap / mention-routing / lgtm /
# close-keyword checks, and nothing announces the gap. See
# groundnuty/macf#814 for the full incident writeup.
#
# This hook is the DETECT half of the #814 combination. The PREVENT half is
# `check-git-sweep.sh`, a PreToolUse hook that blocks the sweeping git
# commands themselves at the moment they'd run. Together: prevent the sweep
# where possible, and self-heal-detect (this hook) when a sweep already
# happened via some other path (a hand-run command outside a Bash tool call,
# an older workspace pre-dating check-git-sweep.sh, etc.).
#
# This mirrors `macf doctor`'s existing bad-stash / hooks-floor detection
# (DR-039 Decision 1 — `doctor.ts` `DR039_LOAD_BEARING_HOOKS`), but runs
# UNCONDITIONALLY at every session start instead of only on a manual
# `macf doctor` invocation — the same Path-2 "a recurring discipline gets
# promoted to a deterministic harness mechanism" shape as the check-*.sh
# family (silent-fallback-hazards.md).
#
# Hook contract (SessionStart): JSON on stdin; STDOUT is injected into the
# agent's context on exit 0 (same mechanism check-channel-alive.sh /
# check-channels-enabled.sh use). This hook is OBSERVATIONAL + NON-BLOCKING:
# it does NOT attempt repair — no auto `macf update` (that would be a
# surprising, slow, network-touching side effect buried inside a SessionStart
# hook) — and it ALWAYS exits 0. Override: MACF_SKIP_FRAMEWORK_CHECK=1.
#
# FALSE-WARN GUARD: a bare checkout of `groundnuty/macf` itself (the
# framework source repo), or any workspace that was simply never
# `macf init`'d, legitimately has none of `.macf/plugin`,
# `.macf/macf-agent.json`, or `.claude/scripts/check-*.sh` — that is NOT
# damage, it's just never having been initialized. This hook only evaluates
# the checks below when the workspace shows INDEPENDENT evidence of being a
# MANAGED workspace (a `.macf/` directory exists, OR `.claude/settings.json`
# exists) — a workspace with neither marker is skipped entirely, silently.
set -euo pipefail

# Operator override first — cheapest exit, no stdin read needed.
if [ "${MACF_SKIP_FRAMEWORK_CHECK:-}" = "1" ]; then
  exit 0
fi

# Drain + ignore the SessionStart payload — no field needed. Never block on stdin.
cat >/dev/null 2>&1 || true

# Resolve the workspace directory the same way the sibling check-*.sh hooks do.
WORKSPACE="${CLAUDE_PROJECT_DIR:-${PWD:-}}"
[ -n "$WORKSPACE" ] || exit 0

# ── Managed-workspace guard ──────────────────────────────────────────────
# Only a workspace with independent evidence of having been `macf init`'d is
# a candidate for "the framework surface was swept". A bare checkout was
# simply never initialized — not damage — so skip entirely, silently.
if [ ! -d "$WORKSPACE/.macf" ] && [ ! -f "$WORKSPACE/.claude/settings.json" ]; then
  exit 0
fi

MISSING=()

# Check A — the plugin mount. Missing directory OR present-but-empty (a
# swept untracked dir can survive as an empty directory depending on how it
# was removed) both count as "gone".
PLUGIN_DIR="$WORKSPACE/.macf/plugin"
if [ ! -d "$PLUGIN_DIR" ] || [ -z "$(ls -A "$PLUGIN_DIR" 2>/dev/null || true)" ]; then
  MISSING+=(".macf/plugin/  (the MCP plugin mount — notify_peer / channel tools gone)")
fi

# Check B — the agent identity config.
if [ ! -f "$WORKSPACE/.macf/macf-agent.json" ]; then
  MISSING+=(".macf/macf-agent.json  (identity config — cannot relaunch cleanly)")
fi

# Check C — at least one guard-hook script present. Portable glob-loop (NOT
# `compgen -G` — absent from some minimal/Nix bash builds that exclude
# programmable-completion support). Nullglob is off by default, so a
# no-match leaves the pattern LITERAL (containing an unexpanded `*`); the
# `-e` test on that literal string correctly evaluates false.
CHECK_SCRIPT_FOUND=0
for f in "$WORKSPACE"/.claude/scripts/check-*.sh; do
  if [ -e "$f" ]; then
    CHECK_SCRIPT_FOUND=1
    break
  fi
done
if [ "$CHECK_SCRIPT_FOUND" -eq 0 ]; then
  MISSING+=(".claude/scripts/check-*.sh  (ALL guard hooks gone — you are running UNGUARDED: no attribution-trap / mention-routing / lgtm-gate / close-keyword checks)")
fi

[ "${#MISSING[@]}" -gt 0 ] || exit 0

cat <<WARN
⚠️  MACF FRAMEWORK SURFACE IS DAMAGED (groundnuty/macf#814) — untracked
files are missing from this workspace:

$(printf '  - %s\n' "${MISSING[@]}")

This usually means a routine git operation silently swept + destroyed these
files — they are UNTRACKED, so \`git stash push -u\` / \`git stash
--include-untracked\` / \`git stash -a\` / \`git stash --all\` / \`git clean
-fd\` all sweep them. \`git stash show -p\` HIDES the untracked portion of a
stash (so a swept stash still looks "safe" — only the tracked-file diff
shows), which is how the sweep goes unnoticed until \`git stash drop\`
permanently deletes it. See groundnuty/macf#814 for the full incident.

Run \`macf update\` to re-distribute the framework files (they are
regenerated from the CLI package, not recovered from git — a swept
untracked payload is not git-recoverable). This guard is observational-only
— it does NOT auto-repair and cannot run \`macf update\` for you.

Silence: MACF_SKIP_FRAMEWORK_CHECK=1.
WARN

exit 0
