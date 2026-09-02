#!/usr/bin/env bash
#
# check-hooks-present.sh — Claude Code SessionStart hook (groundnuty/macf#1401)
# that asserts (A) the token-minting helper scripts the guards + `claude.sh`
# depend on, and (B) every WORKSPACE-hosted PreToolUse hook script this
# workspace's own `.claude/settings.json` (+ `settings.local.json`) actually
# REGISTERS, are present on disk and executable — and warns LOUDLY into the
# agent's context when any is not.
#
# WHY (the transition hazard this closes): groundnuty/macf#1395 correctly
# untracked `.claude/scripts/*.sh` — those files are `macf update`-managed
# installed copies of `packages/macf/plugin/scripts/` + `packages/macf/
# scripts/`, and tracking installed output created a second writer alongside
# the tool. But the FIRST `git pull`/rebase that brings that untracking
# commit in DELETES the working-tree files: git removes a file from the tree
# when the target commit no longer tracks it, and `.gitignore` does not
# protect a file git is in the middle of deleting BECAUSE it was tracked a
# moment ago. Measured live on this exact commit lineage (#1401's own
# reporting workspace, minutes after merging #1395): 17 tracked files in
# `.claude/scripts/` before the pull, 8 after — `check-gh-token.sh` and 15
# others GONE, `.gitignore` correctly marking them ignored, the files simply
# not there.
#
# THE SILENT PART: a Claude Code PreToolUse hook whose registered `command`
# points at a script that no longer exists does NOT block the tool call —
# Claude Code just can't find the command, and the call proceeds unguarded.
# So the exact moment `.claude/scripts/check-gh-token.sh` /
# `check-mention-routing.sh` / `check-lgtm-gate.sh` / `check-close-keyword.sh`
# / `check-gh-attribution.sh` vanish is also the moment every attribution /
# mention-routing / LGTM-gate / close-keyword / result-invariant guard those
# scripts implement goes silently dark — precisely the silent-fallback shape
# (`silent-fallback-hazards.md`) this hook family exists to catch, this time
# produced BY the change that made the hooks' on-disk copies stable.
#
# PART A — THE TOKEN-MINTING HELPERS, NOT THEMSELVES REGISTERED AS HOOKS
# (found on the #1401 issue thread, folded in before this hook shipped): a
# scan that only walks REGISTERED PreToolUse commands is blind to
# `macf-gh-token.sh` and `macf-whoami.sh` — neither is wired into any hook
# entry; both are invoked directly BY the check-*.sh guards and by
# `claude.sh` / agent-authored `gh` commands (coordination.md's canonical
# refresh pattern: `$MACF_WORKSPACE_DIR/.claude/scripts/macf-gh-token.sh`).
# A workspace can have every guard SCRIPT present (Part B all-clear) while
# `macf-gh-token.sh` itself is the one file missing — every guard installed,
# every `gh` call blocked, because there is no token to mint. That is
# precisely the state the #1395-incident's own broadcast remedy would have
# left a workspace in for anyone who followed it literally. `macf-gh-token.sh`
# is therefore checked as the single most consequential file in the
# directory; `macf-whoami.sh` (the token-attribution sanity-check helper
# coordination.md's Token & Git Hygiene rule 2 points agents at) rides along
# for the same reason — invoked directly, never hook-registered.
#
# Deliberately an EXPLICIT two-name list here, not a call into
# `listDistributedScriptNames` (`packages/macf/src/cli/rules.ts`): that
# function enumerates the CANONICAL SOURCE directories on the machine
# running the `macf` CLI (`canonicalScriptsDir()` /
# `canonicalPluginScriptsDir()`) — reachable from Node/TS tooling that is
# colocated with the CLI's own package tree, not cheaply from a dependency-
# light bash SessionStart hook that must run correctly in ANY consumer
# workspace, the overwhelming majority of which never have the macf
# monorepo checked out anywhere nearby to enumerate. Shelling out to `node`
# to require a compiled `dist/` module would add a hard runtime dependency
# this hook family has deliberately avoided everywhere else (see the jq
# fail-open below for the one dependency it does accept). If the canonical
# "what must be here" set ever needs to grow past these two names, the
# right fix is exporting a small static manifest at build time this script
# can read verbatim — not a live Node require from a shell hook.
#
# WHY THIS CHECK IS FINER-GRAINED THAN check-framework-surface.sh's Check C:
# that hook (groundnuty/macf#814) already warns when `.claude/scripts/
# check-*.sh` is ENTIRELY absent (a glob match against zero files) — a
# coarse "are there ANY guard scripts here at all" signal. It does NOT catch
# a PARTIAL loss: the #1395-transition incident above left 8 of 17 files
# behind (macf-statusline.sh + others), so a glob-any-match check stays
# silent even though the SPECIFIC script a live PreToolUse hook is wired to
# (check-gh-token.sh) is gone, and it never looks at macf-gh-token.sh at
# all (not a `check-*.sh` name). This hook checks each REGISTERED hook, plus
# the two token-minting helpers, individually against what's actually on
# disk — a partial loss is caught just as loudly as a total one.
#
# WHY THIS MUST LIVE IN THE PLUGIN, NOT `.claude/scripts/`: the exact same
# reasoning DR-039 phase 2 (groundnuty/macf#698/#749) already applied to the
# load-bearing guard hooks themselves — a workspace-hosted detector is
# exposed to the identical hazard it exists to detect (an untracked-sweep or
# a stale-checkout pull can take the detector down right alongside the
# guards it watches). `${CLAUDE_PLUGIN_ROOT}/scripts/` is tamper-resistant to
# a workspace-local git operation; this script lives there, beside
# `emit-agent-identity.sh` / `check-framework-surface.sh`.
#
# MANAGED-WORKSPACE GUARD: both parts are skipped entirely, silently, for a
# workspace with no independent evidence of being macf-managed (neither
# `.macf/` nor `.claude/settings.json` present) — same guard
# check-framework-surface.sh uses. Without it, Part A would false-alarm
# "token minter missing" on any ordinary non-macf Claude Code project.
#
# PART B SCOPE — PreToolUse only, `$CLAUDE_PROJECT_DIR`-form commands only:
# this hook parses `.claude/settings.json` + `.claude/settings.local.json`'s
# `hooks.PreToolUse` entries (the merged view Claude Code itself uses — same
# two files `macf doctor`'s DR-039 load-bearing-hook check already reads,
# per `readSettingsHookEntries` in `commands/doctor.ts`) and only evaluates
# `command` entries that reference the literal `$CLAUDE_PROJECT_DIR/.claude/
# scripts/<name>` (or braced `${CLAUDE_PROJECT_DIR}/...`) form — the exact
# shape every hand-wired substrate hook in this repo's own `.claude/
# settings.json` uses. A hook registered by a hardcoded absolute path, or by
# `${CLAUDE_PLUGIN_ROOT}/scripts/...` (a plugin-hosted hook — never the ones
# that vanish; see the WHY above), does not match this pattern at all and is
# skipped SILENTLY — out of scope for this check, not a false pass.
#
# NOT AUTO-REPAIR: writing hook scripts from a SessionStart step is the
# `#1386` self-erasing-remedy shape one layer down (a step that "fixes" a
# staleness gap can itself run from a stale copy and make things worse).
# This hook only observes + warns; the operator/agent runs `macf rules
# refresh` (or, inside a `groundnuty/macf` checkout with a current build,
# copies from `packages/macf/plugin/scripts/` + `packages/macf/scripts/`) to
# actually restore the files.
#
# Hook contract (SessionStart): JSON on stdin (drained, unused). STDOUT is
# injected into the agent's context on exit 0 (same mechanism
# check-framework-surface.sh / check-channel-alive.sh / emit-agent-identity.sh
# use). OBSERVATIONAL + NON-BLOCKING: this hook NEVER blocks a session — a
# missing `jq` (Part B only — Part A is pure `[ -e ]`/`[ -x ]` file tests and
# needs no dependency), an unreadable/malformed settings file, or any
# internal fault fails open to silence, never to a crash or a false alarm.
# Override: MACF_SKIP_GUARD_PRESENCE_CHECK=1.
#
# DELIBERATELY MATCHER-LESS (same posture as check-framework-surface.sh /
# emit-agent-identity.sh, for the same reason): the hazard this catches can
# be introduced by a pull/rebase mid-session, not only at a fresh `startup`
# — a `resume`/`compact`/`clear`/`fork` is exactly when the earliest re-check
# opportunity after such a pull may land. Restricting to `startup` would
# reopen the detection gap.
set -uo pipefail
trap 'exit 0' ERR

if [ "${MACF_SKIP_GUARD_PRESENCE_CHECK:-}" = "1" ]; then
  exit 0
fi

# Drain + ignore the SessionStart payload — no field needed. Never block on stdin.
cat >/dev/null 2>&1 || true

WORKSPACE="${CLAUDE_PROJECT_DIR:-${PWD:-}}"
[ -n "$WORKSPACE" ] || exit 0

# Managed-workspace guard (same predicate as check-framework-surface.sh) —
# see file header "MANAGED-WORKSPACE GUARD".
if [ ! -d "$WORKSPACE/.macf" ] && [ ! -f "$WORKSPACE/.claude/settings.json" ]; then
  exit 0
fi

MISSING=()
SEEN_LIST="|"

# ── Part A — the token-minting helpers (see file header "PART A") ──────────
for HELPER_NAME in macf-gh-token.sh macf-whoami.sh; do
  SEEN_LIST="${SEEN_LIST}${HELPER_NAME}|"
  SCRIPT_PATH="$WORKSPACE/.claude/scripts/$HELPER_NAME"

  if [ "$HELPER_NAME" = "macf-gh-token.sh" ]; then
    REASON="TOKEN MINTER missing: no guard can mint a ghs_ bot token; every gh call will be blocked"
  else
    REASON="token-attribution sanity-check helper missing (coordination.md Token & Git Hygiene rule 2)"
  fi

  if [ ! -e "$SCRIPT_PATH" ]; then
    MISSING+=("$HELPER_NAME  (not found on disk — $REASON)")
  elif [ ! -x "$SCRIPT_PATH" ]; then
    MISSING+=("$HELPER_NAME  (present but NOT executable — $REASON)")
  fi
done

# ── Part B — every registered PreToolUse hook (see file header "PART B
# SCOPE") ────────────────────────────────────────────────────────────────
if command -v jq >/dev/null 2>&1; then
  # _pretooluse_commands <file> — every `command`-kind hook string
  # registered under `.hooks.PreToolUse` in one settings file. Always
  # succeeds (exit 0): a missing/unreadable file, or a jq parse failure on
  # malformed JSON, both produce empty output rather than propagating an
  # error — "can't confirm what's registered here" and "nothing is
  # registered here" are treated identically by this hook, same posture as
  # `readHooksMapEntries` in `plugin-hook-resolver.ts`. `mcp_tool`-kind
  # entries have no `.command` field and are excluded explicitly (mirroring
  # `extractHookMatchEntries`'s kind-discrimination) even though
  # `.command // empty` would already drop them.
  _pretooluse_commands() {
    local file="$1"
    [ -f "$file" ] && [ -r "$file" ] || return 0
    jq -r '
      (.hooks.PreToolUse // [])[]?
      | (.hooks // [])[]?
      | select((.type // "command") != "mcp_tool")
      | (.command // empty)
    ' "$file" 2>/dev/null || true
  }

  # Both files contribute to Claude Code's merged hook set (same two files
  # `macf doctor`'s DR-039 check reads — see file header).
  ALL_COMMANDS="$(
    {
      _pretooluse_commands "$WORKSPACE/.claude/settings.json"
      _pretooluse_commands "$WORKSPACE/.claude/settings.local.json"
    } 2>/dev/null || true
  )"

  if [ -n "$ALL_COMMANDS" ]; then
    while IFS= read -r CMD; do
      [ -n "$CMD" ] || continue

      # Only the `$CLAUDE_PROJECT_DIR/.claude/scripts/<name>` (or braced)
      # form is in scope — see "PART B SCOPE" in the file header. Anything
      # else (a hardcoded absolute path, a `${CLAUDE_PLUGIN_ROOT}/...`
      # plugin-hosted hook, an inline `sh -c '...'` blob with no such
      # reference) produces an empty NAME here and is skipped, silently,
      # below.
      NAME="$(printf '%s' "$CMD" | sed -E -n 's#.*\$\{?CLAUDE_PROJECT_DIR\}?/\.claude/scripts/([A-Za-z0-9_.-]+).*#\1#p')"
      [ -n "$NAME" ] || continue

      # De-dup — the same script may be wired into multiple PreToolUse
      # matcher blocks, or already covered by Part A above (not the case
      # today — macf-gh-token.sh/macf-whoami.sh are never hook-registered —
      # but de-dup defends against that changing later without this loop
      # double-reporting).
      case "$SEEN_LIST" in
        *"|$NAME|"*) continue ;;
      esac
      SEEN_LIST="${SEEN_LIST}${NAME}|"

      SCRIPT_PATH="$WORKSPACE/.claude/scripts/$NAME"
      if [ ! -e "$SCRIPT_PATH" ]; then
        MISSING+=("$NAME  (not found on disk)")
      elif [ ! -x "$SCRIPT_PATH" ]; then
        MISSING+=("$NAME  (present but NOT executable — Claude Code cannot run it either)")
      fi
    done <<COMMANDS
$ALL_COMMANDS
COMMANDS
  fi
fi
# No jq → Part B silently skipped (fail open); Part A above still ran —
# it needs no dependency.

[ "${#MISSING[@]}" -gt 0 ] || exit 0

cat <<WARN
⚠️  YOUR ATTRIBUTION/MENTION/LGTM GUARDS ARE NOT FULLY INSTALLED
(groundnuty/macf#1401) — the following are REGISTERED or required by
.claude/settings.json (or settings.local.json) but missing from
.claude/scripts/:

$(printf '  - %s\n' "${MISSING[@]}")

A PreToolUse hook whose script is missing does NOT block — Claude Code
simply can't find the command, and the tool call proceeds UNGUARDED. Your
attribution-trap / mention-routing / LGTM-gate / close-keyword / result-
invariant guards are silently OFF for whichever of the above just vanished,
AND if \`macf-gh-token.sh\` itself is among them, no guard can mint a bot
token in the first place — every \`gh\` call will be blocked regardless of
how many other guards are present (silent-fallback-hazards.md — this is the
exact class these hooks exist to prevent). This typically happens when a
pull/rebase brings in an untracking commit for \`.claude/scripts/*.sh\`
(groundnuty/macf#1395) — those files are macf-update-managed, not
git-tracked, so \`.gitignore\` cannot stop git from deleting the
working-tree copy the moment it stops being tracked.

Run \`macf rules refresh --dir .\` to reinstall them. If your CLI is stale,
a faster stopgap inside a groundnuty/macf checkout: \`cp
packages/macf/plugin/scripts/*.sh packages/macf/scripts/*.sh
.claude/scripts/\` (\`macf rules refresh\` covers both source dirs in one
step; the two-dir cp above is the manual equivalent).

This guard is observational-only — it does NOT auto-repair (writing hook
scripts from a SessionStart step is the #1386 self-erasing-remedy shape one
layer down) and cannot run \`macf rules refresh\` for you.

Silence: MACF_SKIP_GUARD_PRESENCE_CHECK=1.
WARN

exit 0
