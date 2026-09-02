#!/usr/bin/env bash
#
# hook-gh-token.sh — shared library sourced by the MACF hooks that call the
# GitHub API (check-lgtm-gate.sh, check-close-keyword.sh,
# check-gh-attribution.sh) so a session outliving the 1-hour installation-
# token TTL doesn't leave them authenticating with a dead-but-well-shaped
# credential. Companion to macf#317 (macf-channel-server's in-process token
# refresh) for the hook-script consumer family that fix never covered.
#
# NOT a hook itself — nothing in hooks.json or settings.json invokes this
# file directly, and it has no PreToolUse/PostToolUse contract of its own.
# It is sourced by its sibling hooks:
#
#   # shellcheck source=./hook-gh-token.sh
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hook-gh-token.sh"
#
# which resolves correctly whether the sourcing hook is running from its
# plugin mount (${CLAUDE_PLUGIN_ROOT}/scripts/, DR-039 phase 2) or its
# `.claude/scripts/` compat copy — `copyCanonicalScripts` (rules.ts) copies
# every .sh file in the source directory, so this file is always a sibling
# of the hooks that source it, in whichever directory they actually run
# from.
#
# ── Why a fresh-token retry, not a persistent cache ────────────────────────
# macf-channel-server (macf#317) is a long-lived Node process, so an
# in-process ~50-minute token cache pays for itself across many calls. Each
# hook invocation here is instead a brand-new, short-lived subprocess (one
# per intercepted Bash command) — there is no in-process state to cache in,
# and a file-based cross-invocation cache would add staleness/locking
# concerns for a control this security-sensitive. The design that maps onto
# the actual shape is simpler and just as effective: use the ambient token
# first (the common case — cheap, no extra round trip), and mint a fresh one
# ONLY on an actual authentication failure. `gh pr merge` / `gh pr create`
# are not called in a tight loop, so the extra mint-on-401 round trip is not
# a meaningful cost.
#
# ── Public contract ─────────────────────────────────────────────────────
# macf_hook_gh <gh-arg>...
#   Runs `gh <gh-arg>...`. On an authentication failure against the ambient
#   $GH_TOKEN (HTTP 401 / "Bad credentials" — the shape of a dead-but-
#   well-formed installation token; silent-fallback-hazards.md Instance 1's
#   expiry sub-case), mints ONE fresh token via the canonical
#   macf-gh-token.sh helper and retries ONCE with it. A live, valid ambient
#   token is used as-is — no refresh is attempted.
#
#   Status is communicated purely via EXIT CODE, deliberately not a global
#   variable: this function is meant to be called inside a `$(...)` command
#   substitution (`X="$(macf_hook_gh ...)"`, matching the rest of this hook
#   family's style), which forks a subshell — a global variable assigned
#   inside it would silently vanish once that subshell exits.
#
#     0  ok            stdout = gh's own stdout, verbatim.
#     1  auth_failed    the check could NOT run — every attempt (including
#                       after a refresh, or the refresh itself failing to
#                       produce a token) hit an authentication failure.
#                       stdout = a short, human-readable, TOKEN-FREE
#                       diagnostic line (NOT gh's stdout, which is empty on
#                       a failed call anyway). groundnuty/macf#1409: this
#                       diagnostic now NAMES the specific cause (which
#                       launch-env var was absent, vs. the helper itself
#                       failing, vs. the helper being missing) rather than
#                       a single generic "check your credential" line —
#                       callers should surface it verbatim rather than
#                       inventing their own guess (e.g. "rotated key").
#                       Callers MUST treat this as "could not verify",
#                       never as "verified fine" — see check-lgtm-gate.sh
#                       for the load-bearing case this distinction exists
#                       for.
#     2  other_failed   gh failed for a reason that is not authentication
#                       (network down, 404, malformed args, gh missing,
#                       etc.) — unchanged posture from before this file
#                       existed. stdout = a short diagnostic line, same
#                       shape as auth_failed. This function does NOT
#                       distinguish a "not a pull request" 404 from any
#                       other other_failed cause — a caller that needs
#                       that distinction (check-lgtm-gate.sh does, per
#                       groundnuty/macf#1409) inspects this diagnostic
#                       text itself rather than this file growing a new
#                       return code for one caller's classification.
#
#   Callers under `set -e` must guard the call the same way any other
#   command whose non-zero exit is meaningful would be guarded:
#     RC=0
#     RESULT="$(macf_hook_gh pr view "$N" --json author,reviews)" || RC=$?
#   (a bare, unguarded `X=$(macf_hook_gh ...)` under `set -e` would abort
#   the calling script before it gets a chance to branch on the failure —
#   see feedback_set_e_bare_substitution_aborts.md.)
#
# Refs: groundnuty/macf#938 (this file); groundnuty/macf#1409 (diagnostic
# naming — this file's cause-specific stderr text, "diagnostics only" per
# that issue's scope); macf#317 (the refresh pattern this mirrors for the
# channel-server); silent-fallback-hazards.md Instance 1 (expiry sub-case);
# pr-discipline.md's fail-open posture (the paragraph this narrows — an
# expired/invalid credential is fixable, unlike a genuinely unreachable
# GitHub).

# Detect an authentication-failure shape in gh's stderr. Matches both the
# REST-endpoint form (`gh: Bad credentials (HTTP 401)`) and the GraphQL
# form used by `gh pr view` / `gh repo view`
# (`HTTP 401: Bad credentials (https://api.github.com/graphql)`) — both
# verified live against gh 2.95.0. Deliberately narrow to "401" / "bad
# credentials" so a 404 (`Not Found (HTTP 404)`) or a generic network/5xx
# failure does NOT match and falls through to the unchanged other_failed
# path — this function must never widen which commands a caller blocks.
_macf_hook_is_auth_failure() {
  grep -qiE 'bad credentials|HTTP[[:space:]]*401' <<<"$1"
}

# Locate the canonical token-minting helper. $MACF_WORKSPACE_DIR is the
# absolute workspace path claude.sh exports at launch — resolves regardless
# of the hook's cwd (gh-token-attribution-traps.md mode 6). Falls back to
# $CLAUDE_PROJECT_DIR (what Claude Code itself guarantees hooks receive) and
# finally "." for a workspace with neither set. Echoes the resolved path
# only if the helper actually exists there and is executable; prints
# nothing and returns 1 otherwise.
_macf_hook_token_helper_path() {
  local base candidate
  for base in "${MACF_WORKSPACE_DIR:-}" "${CLAUDE_PROJECT_DIR:-}" "."; do
    [[ -z "$base" ]] && continue
    candidate="${base}/.claude/scripts/macf-gh-token.sh"
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# Mint a fresh installation token via the canonical helper. Echoes ONLY the
# token on stdout on success (nothing else — never a diagnostic here, so
# nothing can accidentally end up inside a variable a caller might log or
# echo). On any failure (helper missing, APP_ID/INSTALL_ID/KEY_PATH unset,
# the helper itself errors, or its output isn't shaped like an installation
# token) prints nothing to stdout, WRITES A ONE-LINE CAUSE TO STDERR (never
# the token — that path is unaffected by this), and returns 1.
#
# groundnuty/macf#1409 defect 2: this used to fail silently (`return 1`
# with no diagnostic), which forced the caller in macf_hook_gh below to
# guess a single generic cause ("...and the App private key in this
# workspace") regardless of what actually went wrong. The observed
# incident's real cause was the hook's LAUNCH ENV never carrying
# APP_ID/INSTALL_ID/KEY_PATH at all — not a rotated key — so the stderr
# line here now says WHICH of the three was absent, distinctly from "the
# helper itself failed" (bad key / wrong App / installation ID) and from
# "the helper wasn't even found".
_macf_hook_refresh_token() {
  local helper token rc=0
  helper="$(_macf_hook_token_helper_path)" || {
    echo "the token-minting helper (macf-gh-token.sh) was not found in this workspace (checked MACF_WORKSPACE_DIR, CLAUDE_PROJECT_DIR, and .)" >&2
    return 1
  }

  local missing=()
  [[ -z "${APP_ID:-}" ]] && missing+=("APP_ID")
  [[ -z "${INSTALL_ID:-}" ]] && missing+=("INSTALL_ID")
  [[ -z "${KEY_PATH:-}" ]] && missing+=("KEY_PATH")
  if [[ "${#missing[@]}" -gt 0 ]]; then
    # NOTE: `IFS=', '; "${missing[*]}"` would NOT work here — `${array[*]}`
    # joins using only the FIRST character of IFS, so a 2-char separator
    # silently degrades to a 1-char one. Join explicitly instead.
    local joined="" item
    for item in "${missing[@]}"; do
      if [[ -n "$joined" ]]; then
        joined+=", "
      fi
      joined+="$item"
    done
    echo "this hook's launch environment is missing: ${joined} — not a rotated key; set these in the workspace's .claude/.macf/env.* files (or the launch env) and relaunch" >&2
    return 1
  fi

  token="$("$helper" --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH" 2>/dev/null)" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "the token-minting helper (macf-gh-token.sh) exited non-zero — the App private key may be missing, wrong, or rotated, or APP_ID/INSTALL_ID may be incorrect for this workspace" >&2
    return 1
  fi
  # Full-shape check, matching the canonical predicate (`^ghs_[A-Za-z0-9._-]+$`,
  # claude-sh.ts / check-gh-token.sh) — NOT a prefix check. Widened for the v3
  # installation-token format (`ghs_<install-id>_<JWT>`, dot-separated JWT
  # segments) alongside the classic opaque form.
  if ! [[ "$token" =~ ^ghs_[A-Za-z0-9._-]+$ ]]; then
    echo "the token-minting helper produced output that isn't shaped like an installation token" >&2
    return 1
  fi
  printf '%s' "$token"
}

# macf_hook_gh — see the file header for the full contract.
macf_hook_gh() {
  local out err errfile rc=0

  errfile="$(mktemp 2>/dev/null)" || {
    printf 'could not allocate a temp file to capture gh stderr'
    return 2
  }

  out="$(gh "$@" 2>"$errfile")" || rc=$?
  err="$(cat "$errfile" 2>/dev/null || true)"

  if [[ "$rc" -eq 0 ]]; then
    rm -f "$errfile"
    printf '%s' "$out"
    return 0
  fi

  if ! _macf_hook_is_auth_failure "$err"; then
    rm -f "$errfile"
    printf 'gh failed (non-auth): %s' "$(tr '\n' ' ' <<<"$err" | cut -c1-160)"
    return 2
  fi

  # Ambient token is dead-but-well-shaped (or genuinely invalid) — refresh
  # exactly once and retry exactly once. No further retries: a second
  # failure past a fresh mint means the problem isn't the ambient token's
  # staleness.
  #
  # Capture _macf_hook_refresh_token's stderr diagnostic (groundnuty/macf#1409
  # defect 2) via a second temp file — a plain `2>&1` merge would risk the
  # diagnostic text ending up interleaved into `fresh` (stdout carries the
  # token on success), and this function's contract is that stdout NEVER
  # carries anything but the token or nothing.
  local fresh="" refresh_diag="" refresh_errfile=""
  refresh_errfile="$(mktemp 2>/dev/null)" || refresh_errfile=""
  if [[ -n "$refresh_errfile" ]]; then
    fresh="$(_macf_hook_refresh_token 2>"$refresh_errfile")" || fresh=""
    refresh_diag="$(cat "$refresh_errfile" 2>/dev/null || true)"
    rm -f "$refresh_errfile"
  else
    fresh="$(_macf_hook_refresh_token 2>/dev/null)" || fresh=""
  fi
  if [[ -n "$fresh" ]]; then
    : > "$errfile"
    rc=0
    out="$(GH_TOKEN="$fresh" gh "$@" 2>"$errfile")" || rc=$?
    err="$(cat "$errfile" 2>/dev/null || true)"
    rm -f "$errfile"
    if [[ "$rc" -eq 0 ]]; then
      printf '%s' "$out"
      return 0
    fi
    if _macf_hook_is_auth_failure "$err"; then
      printf 'installation token was refreshed but the retry still failed authentication — check the App key, App ID, and installation ID for this workspace, or the GitHub auth service itself may be down'
      return 1
    fi
    printf 'gh failed (non-auth, after refresh): %s' "$(tr '\n' ' ' <<<"$err" | cut -c1-160)"
    return 2
  fi

  rm -f "$errfile"
  if [[ -n "$refresh_diag" ]]; then
    printf 'the ambient GitHub token is expired or invalid, and refreshing it failed: %s' "$(tr '\n' ' ' <<<"$refresh_diag" | cut -c1-220)"
  else
    printf 'the ambient GitHub token is expired or invalid, and refreshing it failed'
  fi
  return 1
}
