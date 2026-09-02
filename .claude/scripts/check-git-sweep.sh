#!/usr/bin/env bash
#
# check-git-sweep.sh — Claude Code PreToolUse hook (groundnuty/macf#814) that
# blocks `git stash` / `git clean` invocations which would sweep + destroy
# the macf-distributed framework surface — the moment BEFORE the destructive
# git operation runs, not after.
#
# WHY (the real incident this is the prevent half of): `.macf/plugin/`,
# `.macf/macf-agent.json`, `.macf/env.*`, and `.claude/scripts/check-*.sh`
# are ALL UNTRACKED in the consumer agent repo. `git stash push -u` (or
# `--include-untracked` / `-a` / `--all`) silently sweeps them into the
# stash; `git stash show -p` HIDES the untracked portion of a stash so the
# sweep looks safe; `git stash drop` then permanently deletes the payload —
# unrecoverable via git. `git clean` with a force+directories combo (`-fd`,
# `-fdx`, `-xdf`, etc.) does the same damage directly, no stash involved.
# See groundnuty/macf#814 for the full incident writeup (the operator's
# original report).
#
# This hook is the PREVENT half of the #814 combination. The DETECT half is
# `check-framework-surface.sh`, a SessionStart hook that self-heals-detects
# when a sweep already happened via some other path.
#
# Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 = block
# (stderr is fed back to Claude as the error). Same shape as the sibling
# check-*.sh hooks (check-gh-token.sh / check-lgtm-gate.sh / etc.).
#
# Gating logic — this hook does NOT blanket-block `git stash -u` / `git
# clean -fd`; those are legitimate operations in a repo with nothing
# untracked-and-framework-owned at risk. It blocks ONLY when BOTH hold:
#   (1) the command is an untracked-sweeping git stash/clean invocation, AND
#   (2) the macf framework surface (`.macf/**`, `.claude/scripts/check-*.sh`)
#       is CURRENTLY untracked in this repo — i.e. actually sweepable.
# A framework surface that is tracked, absent, or the repo has nothing
# matching → nothing at risk → allow. Any infra error (not a git repo, `git`
# missing) → fail-open (allow), same defense-in-depth posture as
# check-gh-token.sh / check-lgtm-gate.sh.
#
# Override: MACF_SKIP_GIT_SWEEP_CHECK=1 bypasses (for a deliberate,
# knowing sweep).
set -euo pipefail

# Operator override first — cheapest exit. No stdin read needed.
if [[ "${MACF_SKIP_GIT_SWEEP_CHECK:-}" == "1" ]]; then
  exit 0
fi

# Read PreToolUse payload. Fall through to allow on parse error — a broken
# hook must not brick the harness. Same defense-in-depth as check-gh-token.sh.
INPUT_JSON="$(cat 2>/dev/null || echo "")"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"

if [[ -z "$COMMAND" ]]; then
  # No command extractable — allow (defense-in-depth).
  exit 0
fi

# ── Wrapper-aware match, mirroring check-gh-token.sh / check-lgtm-gate.sh ──
# Zero or more of: sudo, env VAR=VAL..., watch, ionice, setsid, nice, time,
# or a bare VAR=VAL prefix — before the `git stash` / `git clean` verb.
# Also triggers when preceded by `;` `|` `&` so chained forms match.
WRAPPER='(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*'
STASH_PATTERN="(^|[[:space:];|&])${WRAPPER}git[[:space:]]+stash([[:space:]]|\$)"
CLEAN_PATTERN="(^|[[:space:];|&])${WRAPPER}git[[:space:]]+clean([[:space:]]|\$)"

# Shell-wrapper bypass: `bash -c "git stash -u"` / `sh -c '...'` / `zsh -c`,
# including flag-prefixed forms (`-x -c`, `-lc`, etc.). Same construction as
# check-gh-token.sh's SHELL_C_PATTERN.
SHELL_C_STASH_PATTERN="(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*git[[:space:]]+stash([[:space:]]|\$)"
SHELL_C_CLEAN_PATTERN="(^|[[:space:];|&])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*git[[:space:]]+clean([[:space:]]|\$)"

IS_STASH_CMD=0
IS_CLEAN_CMD=0
if [[ "$COMMAND" =~ $STASH_PATTERN ]] || [[ "$COMMAND" =~ $SHELL_C_STASH_PATTERN ]]; then
  IS_STASH_CMD=1
fi
if [[ "$COMMAND" =~ $CLEAN_PATTERN ]] || [[ "$COMMAND" =~ $SHELL_C_CLEAN_PATTERN ]]; then
  IS_CLEAN_CMD=1
fi

if [[ "$IS_STASH_CMD" -eq 0 ]] && [[ "$IS_CLEAN_CMD" -eq 0 ]]; then
  # Not a git stash/clean invocation at all — allow without further checks.
  exit 0
fi

# ── Does the matched invocation actually sweep untracked files? ────────────
# `git stash` (push, or bare) only sweeps untracked files with an explicit
# -u/--include-untracked/-a/--all flag — a bare `git stash` / `git stash
# pop` / `git stash drop` / `git stash list` is not a sweep. Standalone-flag
# match (word-bounded) so `--include-untracked` isn't matched inside some
# unrelated longer token.
IS_SWEEPING=0
if [[ "$IS_STASH_CMD" -eq 1 ]]; then
  # Boundary class includes quote chars too — a `bash -c "git stash -u"` /
  # `bash -c 'git stash -u'` wrapped form leaves the flag token immediately
  # followed by the wrapper's own closing quote rather than whitespace/EOL.
  STASH_FLAG_PATTERN='(^|[[:space:]"'\''])(-u|--include-untracked|-a|--all)([[:space:]]|$|["'\''])'
  if [[ "$COMMAND" =~ $STASH_FLAG_PATTERN ]]; then
    IS_SWEEPING=1
  fi
fi

# `git clean` only sweeps when BOTH "force" and "directories" are present —
# as bundled short flags (`-fd`, `-df`, `-xfd`, ...), as separate short
# flags (`-f -d`), or `--force` + a `-d`-bearing token. Without `-f`/
# `--force`, git clean refuses to run at all (dry-run by default) — and
# without `-d`, only untracked FILES are removed, never `.macf/plugin/`
# (a directory). Both must hold for `.macf/` to actually be at risk.
if [[ "$IS_CLEAN_CMD" -eq 1 ]]; then
  # Isolate the tail after the LAST `git clean` occurrence in the command
  # (handles wrapper prefixes uniformly — we only need the flag tokens).
  TAIL="$(sed -E 's/^.*git[[:space:]]+clean[[:space:]]*//' <<<"$COMMAND" 2>/dev/null || echo "")"
  HAS_FORCE=0
  HAS_DIRS=0
  # shellcheck disable=SC2086
  for tok in $TAIL; do
    case "$tok" in
      --)
        break
        ;;
      --force)
        HAS_FORCE=1
        ;;
      -*)
        body="${tok#-}"
        [[ "$body" == *f* ]] && HAS_FORCE=1
        [[ "$body" == *d* ]] && HAS_DIRS=1
        ;;
      *) ;;
    esac
  done
  if [[ "$HAS_FORCE" -eq 1 ]] && [[ "$HAS_DIRS" -eq 1 ]]; then
    IS_SWEEPING=1
  fi
fi

if [[ "$IS_SWEEPING" -eq 0 ]]; then
  # Matched `git stash`/`git clean` but not an untracked-sweeping form —
  # allow (e.g. `git stash pop`, `git stash list`, bare `git clean -n`).
  exit 0
fi

# ── Is the macf framework surface actually untracked-and-at-risk? ──────────
# Resolve the workspace the same way the sibling check-*.sh hooks do.
WORKSPACE="${CLAUDE_PROJECT_DIR:-${PWD:-}}"
[[ -n "$WORKSPACE" ]] || exit 0

command -v git >/dev/null 2>&1 || exit 0

# --untracked-files=all lists individual file paths even inside a wholly
# untracked directory (default porcelain collapses a dir to one line) — we
# need per-file paths to match against the framework-surface prefixes below.
# Any failure here (not a git repo, git error) → fail-open.
STATUS_OUT="$(git -C "$WORKSPACE" status --porcelain --untracked-files=all 2>/dev/null)" || exit 0

# Untracked entries are lines `?? <path>`. Filter for the macf framework
# surface: anything under `.macf/` or a `.claude/scripts/check-*.sh` guard
# hook script.
AT_RISK="$(printf '%s\n' "$STATUS_OUT" | sed -n 's/^?? //p' | grep -E '^(\.macf/|\.claude/scripts/check-.*\.sh$)' || true)"

if [[ -z "$AT_RISK" ]]; then
  # Nothing framework-owned is untracked right now — tracked, clean, or
  # absent. Nothing this command could sweep. Allow.
  exit 0
fi

AT_RISK_LIST="$(printf '%s\n' "$AT_RISK" | sed 's/^/  - /')"

cat >&2 <<ERR
BLOCKED by MACF git-sweep guard (groundnuty/macf#814): this command would
PERMANENTLY DESTROY untracked macf framework files.

Command: ${COMMAND}

The following untracked framework files are currently at risk of being
swept by this command:
${AT_RISK_LIST}

These files are UNTRACKED (by design — they are regenerated by \`macf
update\`, not committed), so \`git stash -u\` / \`git clean -fd\` sweep them
directly. \`git stash show -p\` on a resulting stash HIDES the untracked
portion — the sweep looks "safe" until \`git stash drop\` permanently
deletes it. This exact sequence bricked an agent workspace (no MCP plugin,
no identity config, and — worst — every guard hook gone, running silently
UNGUARDED) — see groundnuty/macf#814.

If you need to stash/clean TRACKED changes only, drop the untracked flag
(\`git stash\` with no \`-u\`/\`-a\`, or \`git clean -f\` without \`-d\`).

Override (ONLY for a deliberate, knowing sweep):
  export MACF_SKIP_GIT_SWEEP_CHECK=1
ERR
exit 2
