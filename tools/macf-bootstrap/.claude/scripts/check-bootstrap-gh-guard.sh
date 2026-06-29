#!/usr/bin/env bash
#
# check-bootstrap-gh-guard.sh — PreToolUse(Bash) hook for the macf-bootstrap
# operator-privileged workspace. The Bash/`gh` half of DR-035 §2.2's
# dual-surface destructive-deny (the browser half is
# check-bootstrap-url-allowlist.sh). Belt-and-suspenders with the settings.json
# permissions.deny rules: it blocks irreversible-destructive `gh` / `gh api`
# verbs AND enforces create-only secret/variable `set` (overwrite ≠ delete).
#
# WHY both a hook AND permissions.deny: a settings.json `Bash(gh repo delete*)`
# deny is the primary structural rail (fires before the hook), but a wrapped /
# shell-quoted form can slip a coarse arg-matcher — so this hook re-checks
# wrapper-aware (sudo / env VAR= / bash -c "…") for defense in depth, and adds
# the create-only-secret check that a static deny rule cannot express.
#
# Hook contract: PreToolUse JSON on stdin; exit 0 = allow, exit 2 = block
# (stderr → Claude). Block is exit-2-ONLY with the reason on stderr — never a
# JSON permissionDecision on stdout (the version-robust deny shape; same as
# check-gh-token.sh).
#
# Overrides:
#   MACF_BOOTSTRAP_SKIP_GH_GUARD=1     bypass the whole guard (deliberate op).
#   MACF_BOOTSTRAP_ALLOW_OVERWRITE=1   permit an intended secret/variable overwrite.
#
# Refs: DR-035 §2.2; sister browser guard check-bootstrap-url-allowlist.sh;
#       wrapper-matching pattern mirrors scripts/check-gh-token.sh (#140).
set -euo pipefail

# Cheap exit on operator override — no stdin read, no parsing.
if [[ "${MACF_BOOTSTRAP_SKIP_GH_GUARD:-}" == "1" ]]; then
  exit 0
fi

INPUT_JSON="$(cat)"
COMMAND="$(jq -r '.tool_input.command // ""' <<<"$INPUT_JSON" 2>/dev/null || echo "")"
[[ -z "$COMMAND" ]] && exit 0

# Wrapper-aware `gh` matcher (mirrors check-gh-token.sh GH_PATTERN): match a
# `gh ` invocation allowing zero or more prefix wrappers (sudo, env VAR=…,
# watch, ionice, setsid, nice, time, bare VAR=…) and chained-form leadins
# `;` `|` `&` `(`. The SHELL_C variant catches `bash -c "gh …"` / `sh -c` /
# `zsh -c` (incl. -lc/-xc forms) where gh runs inside a quoted shell argument.
GH_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|watch[[:space:]]+|ionice[[:space:]]+|setsid[[:space:]]+|nice[[:space:]]+|time[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]'
SHELL_C_PATTERN='(^|[[:space:];|&(])(sudo[[:space:]]+|env[[:space:]]+([A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*(bash|sh|zsh)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*c[[:space:]]+[^[:space:]].*gh[[:space:]]'

if [[ ! "$COMMAND" =~ $GH_PATTERN ]] && [[ ! "$COMMAND" =~ $SHELL_C_PATTERN ]]; then
  # Not a gh invocation — nothing to guard.
  exit 0
fi

block() {
  cat >&2 <<ERR
BLOCKED by macf-bootstrap gh guard: ${1}

Command: ${COMMAND}

macf-bootstrap is provisioning-only (create / install / configure); irreversible-
destructive GitHub ops are denied (DR-035 §2.2 — Bash/gh half of the dual-surface
deny, belt-and-suspenders with the settings.json permissions.deny rules).

Override (deliberate operator exception only):
  export MACF_BOOTSTRAP_SKIP_GH_GUARD=1
ERR
  exit 2
}

# ── Irreversible-destructive gh verbs ──────────────────────────────────────
if [[ "$COMMAND" =~ gh[[:space:]]+repo[[:space:]]+delete([[:space:]]|$) ]]; then
  block "gh repo delete (irreversible repository deletion)"
fi
if [[ "$COMMAND" =~ gh[[:space:]]+repo[[:space:]]+transfer([[:space:]]|$) ]]; then
  block "gh repo transfer (repository ownership transfer)"
fi
if [[ "$COMMAND" =~ gh[[:space:]]+repo[[:space:]]+rename([[:space:]]|$) ]]; then
  block "gh repo rename (renames break existing references/routing)"
fi
if [[ "$COMMAND" =~ gh[[:space:]]+secret[[:space:]]+delete([[:space:]]|$) ]]; then
  block "gh secret delete (removes a secret)"
fi
if [[ "$COMMAND" =~ gh[[:space:]]+variable[[:space:]]+delete([[:space:]]|$) ]]; then
  block "gh variable delete (removes a variable)"
fi

# gh api with a DELETE method — covers App uninstall, org/repo member removal,
# and any REST resource deletion that has no dedicated gh verb. Matches `-X
# DELETE`, `--method DELETE`, `-XDELETE`, `--method=DELETE`.
if [[ "$COMMAND" =~ gh[[:space:]]+api[[:space:]] ]]; then
  if [[ "$COMMAND" =~ (-X|--method)[[:space:]]*=?[[:space:]]*DELETE ]] || [[ "$COMMAND" =~ -XDELETE ]]; then
    block "gh api … DELETE (irreversible REST delete: App uninstall / member removal / resource deletion)"
  fi
fi

# ── Create-only secret/variable set (overwrite ≠ delete, DR-035 §2.2) ──────
# `gh secret set NAME` / `gh variable set NAME` SILENTLY CLOBBERS an existing
# value. Block when the name already exists; allow when it doesn't, OR when
# existence cannot be determined — fail-OPEN on the EXISTENCE probe only, so a
# flaky `gh … list` never blocks a legitimate first-time create. The hard
# destructive verbs above stay fail-closed. An intended overwrite is opt-in via
# MACF_BOOTSTRAP_ALLOW_OVERWRITE=1.
#
# Name-parse limitation (documented): the secret/variable NAME is taken as the
# first non-flag token after `set`. This matches the dominant idiom
# `gh secret set NAME --repo …`; the rarer `gh secret set --repo X NAME`
# (name after flags) may mis-parse — acceptable for a belt-and-suspenders check
# whose miss-mode is the uncommon re-run, gated again by the operator override.
if [[ "${MACF_BOOTSTRAP_ALLOW_OVERWRITE:-}" != "1" ]] \
   && [[ "$COMMAND" =~ gh[[:space:]]+(secret|variable)[[:space:]]+set([[:space:]]|$) ]]; then
  kind="${BASH_REMATCH[1]}"
  name="$(sed -E "s/.*gh[[:space:]]+${kind}[[:space:]]+set[[:space:]]+//" <<<"$COMMAND" \
            | tr ' ' '\n' | grep -vE '^-' | head -1 | tr -d "\"'" || true)"

  # Reconstruct scope flags so the existence probe targets the same scope.
  scope=()
  if [[ "$COMMAND" =~ (--repo|-R)[[:space:]]*=?[[:space:]]*([A-Za-z0-9._/-]+) ]]; then
    scope+=(--repo "${BASH_REMATCH[2]}")
  fi
  if [[ "$COMMAND" =~ --org[[:space:]]*=?[[:space:]]*([A-Za-z0-9._-]+) ]]; then
    scope+=(--org "${BASH_REMATCH[1]}")
  fi
  if [[ "$COMMAND" =~ (--env|-e)[[:space:]]*=?[[:space:]]*([A-Za-z0-9._-]+) ]]; then
    scope+=(--env "${BASH_REMATCH[2]}")
  fi
  if [[ "$COMMAND" =~ --user([[:space:]]|$) ]]; then
    scope+=(--user)
  fi

  if [[ -n "$name" ]]; then
    # `${scope[@]+...}` form is set -u safe for an empty array.
    if existing="$(gh "$kind" list ${scope[@]+"${scope[@]}"} 2>/dev/null)"; then
      if grep -qE "^${name}([[:space:]]|$)" <<<"$existing"; then
        block "gh ${kind} set ${name} would OVERWRITE an existing ${kind} (create-only; overwrite ≠ delete). Set MACF_BOOTSTRAP_ALLOW_OVERWRITE=1 to intentionally overwrite."
      fi
    fi
  fi
fi

exit 0
