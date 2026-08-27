#!/usr/bin/env bash
# release.sh — one-call release orchestrator for the macf npm packages
# (groundnuty/macf#766). Drives the hand-orchestrated ~8-step release
# sequence (bump -> check -> build -> marketplace sync/bump/tag -> push CLI
# bump + tag -> poll publish.yml -> verify npm) that was run by hand for
# v0.2.48 through v0.2.52. Invoked via thin `dev.mk` targets — see
# `dev.mk`'s `release-*` block for the Make-level interface.
#
# Subcommands (each takes VERSION as $1; `check` ignores it but still
# expects it, for a uniform CLI):
#   bump VERSION         Bump the 3 package.json `version` fields + the
#                         @groundnuty/macf-core inter-dep in macf +
#                         macf-channel-server; refresh package-lock.json;
#                         require a `## [VERSION]` heading already at the
#                         top of CHANGELOG.md (release notes are authored,
#                         not generated); commit locally.
#   check VERSION        make -f dev.mk check (reuse).
#   harness-check VERSION  Build dist; materialize a scratch canonical
#                         workspace via the just-built CLI's own
#                         `init --local`; exercise its .claude/settings.json
#                         + .mcp.json + launcher channels-flag against the
#                         currently-installed Claude Code (`claude doctor`
#                         + a settings-load-only `claude -p`); FATAL if
#                         Claude Code rejects/skips any of it (the
#                         groundnuty/macf#1067 class — a rule ships that the
#                         harness silently ignores). VERSION is ignored.
#                         Runs identically under --dry-run (no dependency on
#                         any earlier step's real mutation, unlike `cli`
#                         below).
#   marketplace VERSION  make -f dev.mk build; clone macf-marketplace
#                         (HTTPS+token); conditional-sync the plugin tree
#                         (`sync-marketplace-plugin.mjs --check`, sync only
#                         if drifted); bump macf-agent/.claude-plugin/
#                         plugin.json version; re-check (must be in sync);
#                         commit + push main + tag v<version>; poll the raw
#                         githubusercontent URL until it serves <version>
#                         (the macf#426/#605 publish.yml lockstep gates
#                         need this live before the CLI tag is pushed).
#   cli VERSION           Verify tree clean + on main + HEAD is the bump
#                         commit for <version> + remote main is HEAD~1
#                         (fast-forward); push HEAD -> main + tag
#                         v<version> + push the tag (triggers publish.yml).
#                         Under --dry-run this is an ADVISORY preview, not
#                         the same gate: clean-tree/HEAD-version/fast-forward
#                         only hold once `bump` has committed for real, which
#                         a dry `bump` never does — so the preview reports
#                         what WOULD block the real run (tree dirty beyond
#                         the authored CHANGELOG entry, wrong branch, tag
#                         already exists) instead of aborting on the
#                         inevitable dry-chain shape (groundnuty/macf#1099).
#   verify VERSION        Poll the publish.yml run for tag v<version> to
#                         completion; on failure, print the DR-022
#                         Amendment L no-retry-same-version guidance
#                         (sigstore TLOG is append-only); on success,
#                         result-invariant check `npm view` for all three
#                         packages == <version> (per verify-before-claim.md
#                         — green CI is not proof the registry updated),
#                         retrying each package with capped exponential
#                         backoff (groundnuty/macf#776 — npm's registry CDN
#                         can lag a successful publish by ~90s+; a single
#                         unretried `npm view` false-negatives a release
#                         that actually succeeded).
#   all VERSION           bump -> check -> harness-check -> marketplace ->
#                         cli -> verify, halting loudly (via `set -e` +
#                         explicit `die`) on the first failing step.
#
# --dry-run (or MACF_RELEASE_DRY_RUN=1): every subcommand becomes FULLY
# side-effect-free — no file writes, no `npm install`, no `git commit`, no
# `git push`, no `git tag`, no marketplace clone/sync/commit/push, no
# polling loops that could be mistaken for the real thing. It only prints
# the plan. This is a deliberately stricter reading than "just don't
# push/tag/publish" (which would still let local edits/commits/builds run)
# — a preview mode that mutates NOTHING is the safest contract for a tool
# whose whole job is to push tags that trigger a real npm publish pipeline
# with an append-only (sigstore TLOG) failure surface. Read-only network
# calls used purely for realistic diagnostics (e.g. would-refuse-because-
# tag-already-exists checks) are the only thing that may still run under
# --dry-run; nothing that could ever be undone runs. A precondition that is
# only ever true AFTER an earlier step's real (non-dry) mutation must not be
# asked unconditionally — under a chained `all --dry-run`, earlier steps
# correctly perform none of those mutations, so the precondition would fail
# on every single preview for a reason that carries no information (see
# `cli`'s doc above + `cli_dry_preview` for the worked fix). Such
# preconditions live ONLY in the non-dry continuation; the dry branch either
# evaluates an independent form of the same concern and reports it as an
# advisory "[dry-run] NOTE: ... this would block the real run" (never an
# abort), or skips it with a neutral note when there is no dry-mode-
# meaningful answer at all.
#
# SSH-origin gotcha: `origin` on both groundnuty/macf and
# groundnuty/macf-marketplace is an SSH remote, and this tool's sandboxed
# execution environment denies the SSH key — so EVERY push/clone here uses
# an explicit `https://x-access-token:$GH_TOKEN@github.com/...` URL.
# `git -c url.<...>.insteadOf` does NOT help an SSH-configured remote; the
# explicit URL is passed directly as the push/clone target instead of
# `origin`. See reference_ssh_origin_push_hangs_use_https_token.md.
#
# DR-022 Amendment L: sigstore's transparency log is append-only. A publish
# failure AFTER the TLOG entry was submitted (npm 404/5xx, network blip,
# etc.) leaves an orphaned TLOG entry; retrying the SAME version risks a 409
# TLOG_CREATE_ENTRY_ERROR on whichever package's entry already landed,
# producing a structurally broken split-publish. `verify` never retries —
# it tells the operator to bump to the next version instead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

CLI_REPO="groundnuty/macf"
MARKETPLACE_REPO="groundnuty/macf-marketplace"

DRY_RUN=0
if [ "${MACF_RELEASE_DRY_RUN:-0}" = "1" ]; then
  DRY_RUN=1
fi

CLEANUP_DIRS=()
cleanup() {
  local d
  for d in "${CLEANUP_DIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
  # Explicit success return — this is an EXIT trap, and since the script
  # never calls `exit N` on the success paths (subcommands just fall off the
  # end of `main` after a `return 0`), the LAST command's status here would
  # otherwise become the script's real exit code. Without this, `[ -n "$d" ]`
  # evaluating false on an empty $CLEANUP_DIRS (the common no-temp-dir-used
  # case: bump/check/verify, and marketplace/cli under --dry-run) silently
  # turned every successful run into exit 1 — which `make -f dev.mk
  # release-dry` would have reported as a FAILED target despite a clean dry
  # run. Caught via `bash -x` exit-code tracing during development.
  return 0
}
trap cleanup EXIT

log() { printf '%s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }
dry() { log "[dry-run] $*"; }

usage() {
  cat <<'USAGE' >&2
Usage: release.sh <subcommand> <version> [--dry-run]

Subcommands:
  bump VERSION          Bump 3 package.json + inter-dep + lockfile; require
                         a CHANGELOG.md heading; commit locally.
  check VERSION         make -f dev.mk check.
  harness-check VERSION  Exercise the release-generated .claude/settings.json
                         + .mcp.json + launcher flags against the currently-
                         installed Claude Code; fail if any rule/flag is
                         rejected. VERSION is ignored.
  marketplace VERSION   Conditional-sync + bump + tag the macf-marketplace
                         plugin.
  cli VERSION           Push the bump commit to main + tag v<version>
                         (triggers publish.yml).
  verify VERSION        Poll publish.yml + verify npm registry versions
                         (retries each package with backoff — #776).
  all VERSION           bump -> check -> harness-check -> marketplace -> cli
                         -> verify.

Flags:
  --dry-run             Print every step; mutate NOTHING (no writes, no
                         commits, no pushes, no tags). Same as
                         MACF_RELEASE_DRY_RUN=1.

Env (token minting — see coordination.md "Token & Git Hygiene"):
  GH_TOKEN               Reused as-is if already a well-shaped ghs_* token.
  APP_ID, INSTALL_ID      Required to mint a fresh token when GH_TOKEN is
  KEY_PATH, MACF_WORKSPACE_DIR  absent/invalid. KEY_PATH may be relative to
                          MACF_WORKSPACE_DIR (default: repo root).

Env (release-verify npm-lag retry — #776, all optional):
  MACF_RELEASE_NPM_VERIFY_TRIES      Attempts per package before a genuine
                                      MISMATCH (default 8).
  MACF_RELEASE_NPM_VERIFY_BASE_SECS  Backoff base seconds (default 5).
  MACF_RELEASE_NPM_VERIFY_CAP_SECS   Backoff cap seconds (default 60).
USAGE
}

# ---------------------------------------------------------------------------
# Pure helpers (covered by release.test.sh)
# ---------------------------------------------------------------------------

# version_compare A B -> prints -1 / 0 / 1 for A </=/> B. Numeric per-segment
# (not lexicographic — "0.2.9" < "0.2.10"). Assumes X.Y.Z shape (this repo's
# convention); missing trailing segments default to 0.
version_compare() {
  local a="$1" b="$2"
  local -a av bv
  IFS='.' read -r -a av <<<"$a"
  IFS='.' read -r -a bv <<<"$b"
  local i ai bi
  for i in 0 1 2; do
    ai="${av[i]:-0}"
    bi="${bv[i]:-0}"
    if ((10#$ai > 10#$bi)); then
      echo 1
      return 0
    fi
    if ((10#$ai < 10#$bi)); then
      echo -1
      return 0
    fi
  done
  echo 0
}

# changelog_has_heading VERSION -> true if the FIRST `## [x.y.z]` heading in
# $REPO_ROOT/CHANGELOG.md is exactly for VERSION (release notes are authored
# at the top before a bump runs, never generated by this script).
changelog_has_heading() {
  local version="$1"
  local first
  first="$(grep -m1 -E '^## \[[0-9]' "$REPO_ROOT/CHANGELOG.md" 2>/dev/null || true)"
  [[ "$first" == "## [$version]"* ]]
}

# ---------------------------------------------------------------------------
# npm-registry-lag retry (groundnuty/macf#776)
# ---------------------------------------------------------------------------
#
# npm's registry CDN is eventually consistent: `npm view` can return the OLD
# version for up to ~2 minutes after `npm publish` has already accepted +
# signed (for --provenance publishes) the new one. A single unretried
# `npm view` therefore reports a genuinely successful publish as a MISMATCH
# — the exact false-negative #776 was filed to fix. Witnessed empirically:
# the v0.2.53 cut (2026-07-04, #776's original report) and the v0.2.58 cut
# (2026-08-21 comment thread, ~90s observed lag on the third package).
#
# The fix here is a bounded retry with backoff — a mitigation, not the
# acceptance-vs-availability redesign the #776 thread ultimately calls for
# (that spans publish.yml's own "Verify provenance attestations" step, which
# is a SEPARATE 5-retries-at-3s check outside this script and outside this
# fix's scope). This still closes the concrete bug this function targets:
# `cmd_verify`'s own single-shot `npm view` loop.

# npm_view_version PKG — thin wrapper around `npm view <pkg> version`,
# isolated as its own function so release.test.sh can override it (shell-
# function redefinition, same technique the existing `gh` test-stub below
# uses) without a real network call. Never errors — prints empty string when
# the version can't be resolved (yet), which is the expected shape while the
# registry CDN is still propagating a just-accepted publish.
npm_view_version() {
  npm view "$1" version 2>/dev/null || true
}

# npm_verify_backoff_secs ATTEMPT -> the delay before the retry that follows
# a failed 1-indexed ATTEMPT: exponential (base * 2^(attempt-1)), capped.
# Overridable via MACF_RELEASE_NPM_VERIFY_BASE_SECS (default 5) /
# MACF_RELEASE_NPM_VERIFY_CAP_SECS (default 60) — release.test.sh sets both
# to 0 so its retry-count assertions run instantly, asserting attempt counts
# rather than faking wall-clock time.
npm_verify_backoff_secs() {
  local attempt="$1"
  local base="${MACF_RELEASE_NPM_VERIFY_BASE_SECS:-5}"
  local cap="${MACF_RELEASE_NPM_VERIFY_CAP_SECS:-60}"
  local delay=$((base * (1 << (attempt - 1))))
  if [ "$delay" -gt "$cap" ]; then
    delay="$cap"
  fi
  printf '%s\n' "$delay"
}

# wait_for_npm_version PKG VERSION -> retries npm_view_version with capped
# exponential backoff until it matches VERSION or the attempt budget
# (MACF_RELEASE_NPM_VERIFY_TRIES, default 8) is exhausted. Default backoff
# (5s/10s/20s/40s/60s-capped) sums to ~4m15s worst case per package — well
# past the ~90s lag observed on #776, but still BOUNDED, so a genuine miss
# fails instead of hanging. Prints its own OK / in-progress / MISMATCH
# diagnostic (the caller doesn't re-derive attempt counts from a bare exit
# code): a first-attempt match logs a plain OK with no retry noise; a match
# after N>1 attempts says so explicitly ("after retrying"); exhausting the
# budget logs MISMATCH naming the attempt count, worded to be unambiguous
# against the mid-retry "not yet visible... retrying" line — the two must
# never be confused, since one is "wait" and the other is "this genuinely
# failed". Returns 0 on match, 1 on exhaustion.
wait_for_npm_version() {
  local pkg="$1" version="$2"
  local max_tries="${MACF_RELEASE_NPM_VERIFY_TRIES:-8}"
  local attempt=1 live="" delay

  while [ "$attempt" -le "$max_tries" ]; do
    live="$(npm_view_version "$pkg")"
    if [ "$live" = "$version" ]; then
      if [ "$attempt" -gt 1 ]; then
        log "OK ${pkg}@${version} live on npm (after retrying — succeeded on attempt ${attempt}/${max_tries})"
      else
        log "OK ${pkg}@${version} live on npm"
      fi
      return 0
    fi
    if [ "$attempt" -lt "$max_tries" ]; then
      delay="$(npm_verify_backoff_secs "$attempt")"
      log "${pkg}@${version} not yet visible on npm (attempt ${attempt}/${max_tries}, saw '${live:-<none>}') — registry lag is expected right after a successful publish; retrying in ${delay}s..."
      sleep "$delay"
    fi
    attempt=$((attempt + 1))
  done

  log "MISMATCH: ${pkg} npm version=${live:-<none>}, expected ${version} (still absent after ${max_tries} attempts — a genuine failure, not lag)"
  return 1
}

# ---------------------------------------------------------------------------
# Token + push-URL helpers
# ---------------------------------------------------------------------------

resolve_key_path() {
  local kp="${KEY_PATH:-.github-app-key.pem}"
  case "$kp" in
    /*) printf '%s\n' "$kp" ;;
    *) printf '%s\n' "${MACF_WORKSPACE_DIR:-$REPO_ROOT}/$kp" ;;
  esac
}

# ensure_gh_token — reuse an already-exported, well-shaped GH_TOKEN; else
# mint a fresh one via the fail-loud macf-gh-token.sh helper. Full-shape
# validation (not just a prefix substring) per silent-fallback-hazards.md
# Pattern B — a prefix-only check admits shell-metacharacter payloads.
ensure_gh_token() {
  if [ -n "${GH_TOKEN:-}" ] && [[ "$GH_TOKEN" =~ ^ghs_[A-Za-z0-9._-]+$ ]]; then
    return 0
  fi
  [ -n "${APP_ID:-}" ] || die "GH_TOKEN not set/valid and APP_ID is unset — cannot mint a fresh token"
  [ -n "${INSTALL_ID:-}" ] || die "GH_TOKEN not set/valid and INSTALL_ID is unset — cannot mint a fresh token"

  local key_path helper
  key_path="$(resolve_key_path)"
  helper="$REPO_ROOT/packages/macf/scripts/macf-gh-token.sh"
  if [ ! -x "$helper" ]; then
    helper="${MACF_WORKSPACE_DIR:-$REPO_ROOT}/.claude/scripts/macf-gh-token.sh"
  fi
  [ -x "$helper" ] || die "cannot find macf-gh-token.sh helper (checked packages/macf/scripts and .claude/scripts)"

  GH_TOKEN="$("$helper" --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$key_path")" \
    || die "token mint via $helper failed"
  [[ "$GH_TOKEN" =~ ^ghs_[A-Za-z0-9._-]+$ ]] || die "minted token has an unexpected shape (not ghs_*) — refusing to use it"
  export GH_TOKEN
}

# gh_https_url REPO -> the explicit x-access-token URL for REPO (SSH-origin
# gotcha — origin is SSH + the sandbox denies the key; `-c insteadOf`
# doesn't help an SSH remote, so every push/clone targets this URL directly
# instead of `origin`).
gh_https_url() {
  printf 'https://x-access-token:%s@github.com/%s.git' "$GH_TOKEN" "$1"
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

cmd_bump() {
  local version="${1:-}"
  [ -n "$version" ] || die "bump requires <version>"

  local current
  current="$(node -p "require('$REPO_ROOT/packages/macf-core/package.json').version")"
  local cmp
  cmp="$(version_compare "$version" "$current")"
  [ "$cmp" -gt 0 ] || die "refusing to bump: $version is not greater than current $current"

  changelog_has_heading "$version" \
    || die "CHANGELOG.md is missing a '## [$version]' heading at the top — release notes are authored, not generated. Add the entry first, then re-run bump."

  if [ "$DRY_RUN" = "1" ]; then
    dry "would bump packages/{macf-core,macf,macf-channel-server}/package.json version $current -> $version"
    dry "would bump the @groundnuty/macf-core inter-dep to $version in packages/{macf,macf-channel-server}/package.json"
    dry "would run: (cd $REPO_ROOT && devbox run -- npm install --package-lock-only)"
    dry "would commit: chore: bump to $version"
    return 0
  fi

  local pkg
  for pkg in macf-core macf macf-channel-server; do
    node -e "
      const fs = require('fs');
      const path = '$REPO_ROOT/packages/$pkg/package.json';
      const pkgJson = JSON.parse(fs.readFileSync(path, 'utf8'));
      pkgJson.version = '$version';
      if (pkgJson.dependencies && pkgJson.dependencies['@groundnuty/macf-core']) {
        pkgJson.dependencies['@groundnuty/macf-core'] = '$version';
      }
      fs.writeFileSync(path, JSON.stringify(pkgJson, null, 2) + '\n');
    "
  done

  (cd "$REPO_ROOT" && devbox run -- npm install --package-lock-only)

  (
    cd "$REPO_ROOT"
    git add \
      packages/macf/package.json \
      packages/macf-core/package.json \
      packages/macf-channel-server/package.json \
      package-lock.json \
      CHANGELOG.md
    git commit -m "chore: bump to $version"
  )
  log "bump complete: $current -> $version (committed locally)"
}

cmd_check() {
  if [ "$DRY_RUN" = "1" ]; then
    dry "would run: (cd $REPO_ROOT && make -f dev.mk check)"
    return 0
  fi
  (cd "$REPO_ROOT" && make -f dev.mk check)
}

# ---------------------------------------------------------------------------
# Harness-compat checking (groundnuty/macf#1069)
# ---------------------------------------------------------------------------
#
# "Harness-compatibility drift" here means: the currently-installed Claude
# Code binary silently REJECTS or downgrades a config artifact this repo's
# generators ship in `.claude/settings.json` / `.mcp.json` — a permission
# rule, a deny rule, an MCP config shape, or a launcher dev-flag — the same
# class as groundnuty/macf#1067 (19 dead `Write(path)` deny rules that
# warned on every agent launch, unnoticed for months, because the harness's
# own diagnostic scrolled past in a pane nobody read). It does NOT cover
# every "assumption that moved" instance #1069 cites as motivation: the MCP
# mount-form regression (#1002) is an MCP-CONNECTION outcome, not a
# settings-validation diagnostic (already covered by the runtime
# `check-channels-enabled.sh` detector — silent-fallback-hazards.md
# Instance 15); the SessionStart payload-gating bug (#1039) was a semantic
# misreading of VALID data, not a rejected rule; and the GitHub v3
# installation-token format change is a GitHub API/token-shape concern with
# nothing to do with Claude Code's settings grammar (already hardened
# separately — see `ensure_gh_token`'s full-shape `ghs_[A-Za-z0-9._-]+`
# predicate, widened for the v3 format by #825/#829). Scope, precisely:
# does Claude Code accept the rule/flag we ship — verified two ways, both
# confirmed empirically against a real Claude Code install while building
# this check:
#
#   1. `claude doctor` — structural validation (JSON shape, unsupported
#      wildcard tool-name syntax, malformed MCP config). No trust prompt,
#      no session, no model call. Prints an "Invalid settings" section
#      (each rejected item + Claude Code's own suggested fix) when
#      something was skipped, or "No installation issues found." Does NOT
#      catch semantically-dead-but-syntactically-valid rules — see next.
#   2. `claude -p` (print/non-interactive mode) with EMPTY stdin and no
#      prompt argument — this loads + validates settings for a real
#      session (the deeper pass `doctor` doesn't do) and prints the exact
#      per-rule diagnostic a human would otherwise see scroll past on every
#      launch (e.g. "Permission deny rule ...: Write(<path>) is not
#      matched by file permission checks ... Use Edit(<path>) instead" —
#      verbatim the #1067 shape), THEN exits 1 on "Input must be provided
#      ... when using --print" because no prompt was given. That expected
#      failure costs NO model API call — the diagnostics print during
#      settings load, before Claude Code would otherwise reach out to
#      Anthropic's API (verified: the same "Permission deny rule" line
#      appears with ANTHROPIC auth entirely absent from the invocation). An
#      untrusted scratch workspace (which this always is — nothing here
#      goes through the interactive trust dialog, deliberately) makes
#      Claude Code ignore `permissions.allow` wholesale, so this pass
#      validates `permissions.deny` grammar specifically; `allow`-rule
#      STRUCTURAL validity (JSON/wildcard-syntax shape) is covered by
#      `doctor` above instead — `allow`-rule SEMANTIC drift (the #1067
#      shape, on the allow side) is covered by NEITHER pass. Honest gap,
#      not a full guarantee.
#
# Neither pass blocks on a WARNING — Claude Code itself distinguishes a
# caveat (e.g. "glob patterns in sandbox permission rules are not fully
# supported on Linux": the rule still applies via the higher-level
# permission checker, just not via the sandbox's own enforcement layer)
# from a REJECTION ("Invalid settings" / "is not matched by" / "was
# skipped"). Only the latter fails the release — see cmd_harness_check's
# doc comment for why a rejection blocks rather than warns.

# check_harness_compat WORKSPACE_DIR — the testable core (release.test.sh
# exercises this directly against hand-built fixtures; no `macf init` or
# network dependency here). WORKSPACE_DIR must contain a
# `.claude/settings.json`; a `claude.sh` there (optional) is grepped for the
# channels dev-flag literal so the launcher-flag check folds into the SAME
# `claude -p` invocation below, rather than duplicating the flag string in
# this file — single source of truth stays whatever claude-sh.ts just
# generated. Prints diagnostics via log(); returns 0 when nothing was
# rejected (a NOTE may still print for a non-fatal caveat or an
# inconclusive/timed-out pass), 1 when Claude Code explicitly rejected
# something.
check_harness_compat() {
  local workspace_dir="$1"
  local rc=0

  if ! command -v claude >/dev/null 2>&1; then
    log "NOTE: 'claude' binary not found on PATH — skipping the harness-compat check (nothing installed to verify against)."
    return 0
  fi

  local cc_version
  cc_version="$(claude --version 2>/dev/null || true)"
  [ -n "$cc_version" ] || cc_version="<unknown>"

  # Internal/test knobs (same shape as e.g. check-channels-enabled.sh's
  # MACF_CHANNELS_POLL_ITERS) — let release.test.sh drive the timeout path
  # deterministically in seconds rather than waiting out a real 30s hang.
  local doctor_timeout="${MACF_HARNESS_CHECK_DOCTOR_TIMEOUT_SECS:-20}"
  case "$doctor_timeout" in '' | *[!0-9]*) doctor_timeout=20 ;; esac
  local p_timeout="${MACF_HARNESS_CHECK_P_TIMEOUT_SECS:-30}"
  case "$p_timeout" in '' | *[!0-9]*) p_timeout=30 ;; esac

  # --- 1. claude doctor: structural validation. No trust prompt, no
  # session, no model call — just a settings/MCP-config shape check.
  local doctor_out
  doctor_out="$(cd "$workspace_dir" && timeout "$doctor_timeout" claude doctor 2>&1)" || true
  if printf '%s\n' "$doctor_out" | grep -qx 'Invalid settings'; then
    # `claude doctor` walks up from cwd and can report findings about an
    # ANCESTOR directory's .mcp.json/settings.json that have nothing to do
    # with the scratch workspace this check just generated — verified
    # empirically: run from inside a nested worktree, it additionally
    # surfaced a finding about the PARENT checkout's unrelated .mcp.json.
    # Every "Invalid settings" bullet names the absolute path of the
    # offending file, so only fail on bullets whose path is actually
    # inside workspace_dir; an ancestor/ambient finding is real but not
    # this release's problem to block on. The sed range isolates just the
    # "Invalid settings" section's bullets (stops at the next ALL-CAPS-
    # initial section heading), so a LATER "N warning(s) found" section's
    # own "- " bullets are never mistaken for these.
    # Substring match, not path-position match — the workspace path could
    # in principle appear inside a bullet's DESCRIPTION rather than as the
    # finding's own subject (e.g. an ancestor finding that happens to quote
    # a workspace path in its text). A mktemp -d path is unique enough that
    # this is remote, and real bullets consistently lead with the path, so
    # this is "the workspace path appears in this finding," treated as
    # good-enough proxy for "this finding is about the workspace."
    local in_scope_bullets
    in_scope_bullets="$(printf '%s\n' "$doctor_out" \
      | sed -n '/^Invalid settings$/,/^[A-Z]/{/^- /p}' \
      | grep -F -- "$workspace_dir" || true)"
    if [ -n "$in_scope_bullets" ]; then
      log "Claude Code $cc_version (via 'claude doctor') rejects part of the release-generated settings:"
      log "$doctor_out"
      rc=1
    else
      log "NOTE (non-blocking): 'claude doctor' reported an 'Invalid settings' finding, but every reported path is OUTSIDE the scratch workspace (ambient/ancestor state) — not this release's problem:"
      log "$doctor_out"
    fi
  elif printf '%s\n' "$doctor_out" | grep -qE '^[0-9]+ warnings? found$'; then
    log "NOTE (non-blocking): 'claude doctor' found a caveat against Claude Code $cc_version — review, does not fail the release:"
    log "$doctor_out"
  fi

  # --- 2. claude -p, empty stdin, no prompt: session-load semantic
  # validation (catches the #1067 Write(path)-is-inert shape that `doctor`
  # above does not) + launcher dev-flag acceptance, folded into one call.
  # NOTE: this pass validates `permissions.deny` grammar (deny rules apply
  # regardless of the untrusted-workspace state below) plus whatever
  # `doctor` already covers structurally for `allow`. It does NOT catch
  # `allow`-rule SEMANTIC drift (the #1067 shape, on the allow side) —
  # an untrusted scratch workspace makes Claude Code ignore
  # `permissions.allow` wholesale, so there is no pass here that loads and
  # semantically validates allow rules. Honest gap, not a full guarantee.
  local channels_args=()
  if [ -f "$workspace_dir/claude.sh" ]; then
    local flag_line=""
    flag_line="$(grep -oE -- '--dangerously-load-development-channels [^[:space:]"]+' "$workspace_dir/claude.sh" 2>/dev/null | head -n1 || true)"
    if [ -n "$flag_line" ]; then
      local flag_name="" flag_value=""
      read -r flag_name flag_value <<<"$flag_line"
      channels_args=("$flag_name" "$flag_value")
    fi
  fi

  local p_out p_rc
  if p_out="$(cd "$workspace_dir" && printf '' | timeout "$p_timeout" claude -p --output-format text "${channels_args[@]}" 2>&1)"; then
    p_rc=0
  else
    p_rc=$?
  fi

  if [ "$p_rc" = 124 ]; then
    # `timeout`'s OWN exit code for "had to kill it" — checked explicitly
    # rather than inferred from empty output. A killed process can still
    # have written partial output (e.g. the trust-dialog line) before being
    # killed, so "p_out is non-empty" is NOT a reliable timeout signal; a
    # hang carries no information about drift either way, so this is
    # always a NOTE, never a FATAL — the same "never let the check itself
    # become the flaky signal" stance this file takes elsewhere.
    log "NOTE (non-blocking): 'claude -p' timed out after ${p_timeout}s — could not verify; not treated as a rejection."
  else
    # Two independent checks (NOT if/elif) — both can legitimately fire on
    # the SAME output: e.g. Claude Code prints the permission-rule
    # rejection line and then exits some OTHER way than the expected
    # "no prompt given" terminal state (a crash, an auth error, a future
    # wording change). Reporting only the first would misdiagnose a real
    # permission-rule rejection as "rejected the launch invocation" and
    # never surface the actual offending rule.
    if ! printf '%s' "$p_out" | grep -q 'Error: Input must be provided'; then
      log "Claude Code $cc_version did not reach the expected 'no prompt given' terminal state — raw output follows:"
      log "$p_out"
      rc=1
    fi
    if printf '%s' "$p_out" | grep -qE 'Permission (deny|allow) rule .*(is not matched by|was skipped)|Invalid permission rule'; then
      log "Claude Code $cc_version (via 'claude -p') rejects a permission rule in the release-generated settings:"
      log "$p_out"
      rc=1
    fi
  fi

  return "$rc"
}

# cmd_harness_check VERSION — the release-time orchestrator. Builds dist
# (idempotent — `tsc -b` is incremental), materializes a REAL canonical
# workspace via the just-built CLI's own `init --local` (the actual
# generator, not a hand-reconstructed shape) into an ephemeral scratch dir,
# then hands it to check_harness_compat. VERSION is accepted-but-unused,
# for CLI-signature uniformity with the other subcommands (see `check`).
#
# Runs IDENTICALLY under --dry-run and the real path — unlike `cli`'s
# preconditions (groundnuty/macf#1099), this check has NO dependency on any
# earlier step's REAL mutation (bump's commit, marketplace's tag): it only
# needs this source tree's current generator code + the currently-installed
# Claude Code, both of which are present regardless of DRY_RUN. So
# `release-dry` runs the REAL diagnostic here, not an advisory preview —
# deliberately: the whole point of a pre-publish preview is to build
# confidence before committing to a push, and this check exists
# specifically to catch what nothing else in the release pipeline looks
# for. The scratch workspace, its local-registry CA (via `--path`), AND
# `macf init`'s own cross-project state (via `HOME=`, see the comment
# below) are all confined under a single `mktemp -d` (registered in
# CLEANUP_DIRS, same as every other scratch dir this script creates) —
# nothing here is ever written to the operator's real `~/.macf/`. A
# `git clone`-free, read-only `GET` for the pinned plugin version is the
# only network call `macf init` makes here; it degrades gracefully to
# defaults when rate-limited (no GH_TOKEN is passed — this check doesn't
# need one).
cmd_harness_check() {
  (cd "$REPO_ROOT" && make -f dev.mk build)

  local cli_dist="$REPO_ROOT/packages/macf/dist/cli/index.js"
  [ -f "$cli_dist" ] || die "dist not built — $cli_dist missing after 'make build'"

  local scratch
  scratch="$(mktemp -d)"
  CLEANUP_DIRS+=("$scratch")

  # `macf init` writes to a few paths derived from $HOME beyond what --path
  # redirects — most importantly the cross-project agents index at
  # ~/.macf/agents.json (`addToAgentsIndex`, unconditional, no opt-out).
  # `--path` only redirects the local-registry JSON + its CA; without also
  # containing $HOME, every harness-check run — including under
  # --dry-run — would permanently register a throwaway
  # "macf-release-harness-check" entry into the OPERATOR'S real, persistent
  # global agents index. Point $HOME at a scratch subdirectory for this one
  # subprocess call so EVERY ~/.macf/* write it makes lands inside the same
  # `mktemp -d` this function already tears down — verified empirically
  # while building this check (the unredirected form left stray entries
  # behind). Scoped to just this line — check_harness_compat below runs
  # with the REAL ambient $HOME, since Claude Code itself needs real
  # user-level config/credentials to run at all.
  local init_out
  if ! init_out="$(HOME="$scratch/home" node "$cli_dist" init \
    --project "macf-release-harness-check" \
    --role code-agent \
    --local \
    --path "$scratch/registry/macf-release-harness-check.json" \
    --dir "$scratch/workspace" 2>&1)"; then
    log "$init_out"
    die "could not materialize a scratch canonical workspace via 'macf init --local' — cannot run the harness-compat check"
  fi

  if check_harness_compat "$scratch/workspace"; then
    log "harness-compat check passed — the currently-installed Claude Code accepts the release-generated settings/launcher config"
  else
    die "harness-compat check FAILED — see the diagnostics above. The currently-installed Claude Code rejected part of the release-generated .claude/settings.json / .mcp.json / launcher flags. Fix the generator (packages/macf/src/cli/settings-writer.ts, claude-sh.ts, or mcp-json.ts) before releasing."
  fi
}

cmd_marketplace() {
  local version="${1:-}"
  [ -n "$version" ] || die "marketplace requires <version>"

  ensure_gh_token

  if gh api "repos/${MARKETPLACE_REPO}/git/ref/tags/v${version}" >/dev/null 2>&1; then
    die "marketplace tag v${version} already exists on ${MARKETPLACE_REPO} — refusing (idempotent guard). If recovering from a partial failure, investigate before deliberately retagging."
  fi

  if [ "$DRY_RUN" = "1" ]; then
    dry "would run: (cd $REPO_ROOT && make -f dev.mk build)"
    dry "would clone https://x-access-token:***@github.com/${MARKETPLACE_REPO}.git to a temp dir"
    dry "would run sync-marketplace-plugin.mjs --check --target <clone>/macf-agent; sync only if OUT OF SYNC"
    dry "would bump <clone>/macf-agent/.claude-plugin/plugin.json version -> $version"
    dry "would re-run --check (must pass) then commit + push main + tag v$version on ${MARKETPLACE_REPO}"
    dry "would poll https://raw.githubusercontent.com/${MARKETPLACE_REPO}/v${version}/macf-agent/.claude-plugin/plugin.json until version=$version"
    return 0
  fi

  (cd "$REPO_ROOT" && make -f dev.mk build)

  local sync_dist="$REPO_ROOT/packages/macf/dist/cli/marketplace-sync.js"
  [ -f "$sync_dist" ] || die "dist not built — $sync_dist missing after 'make build'"

  local mp_dir
  mp_dir="$(mktemp -d)"
  CLEANUP_DIRS+=("$mp_dir")
  log "cloning ${MARKETPLACE_REPO} -> $mp_dir"
  git clone --quiet "$(gh_https_url "$MARKETPLACE_REPO")" "$mp_dir"

  local target="$mp_dir/macf-agent"
  local sync_node="$REPO_ROOT/packages/macf/scripts/sync-marketplace-plugin.mjs"
  if node "$sync_node" --check --target "$target"; then
    log "marketplace plugin tree already in sync — version-only bump"
  else
    log "marketplace plugin tree OUT OF SYNC — syncing canonical plugin/ content"
    node "$sync_node" --target "$target"
  fi

  local plugin_json="$target/.claude-plugin/plugin.json"
  [ -f "$plugin_json" ] || die "marketplace plugin.json not found at $plugin_json"
  sed -E "s/(\"version\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"/\1\"${version}\"/" \
    "$plugin_json" >"${plugin_json}.tmp"
  mv "${plugin_json}.tmp" "$plugin_json"

  node "$sync_node" --check --target "$target" \
    || die "marketplace plugin tree still OUT OF SYNC after sync + version bump — investigate before proceeding (do not force-push a known-drifted tree)"

  (
    cd "$mp_dir"
    git add -A
    git commit --quiet -m "chore: bump macf-agent plugin to v${version}"
    git push --quiet "$(gh_https_url "$MARKETPLACE_REPO")" HEAD:main
    git tag "v${version}"
    git push --quiet "$(gh_https_url "$MARKETPLACE_REPO")" "v${version}"
  )

  log "polling raw.githubusercontent.com for marketplace v${version}..."
  local raw_url="https://raw.githubusercontent.com/${MARKETPLACE_REPO}/v${version}/macf-agent/.claude-plugin/plugin.json"
  local tries=0 ok=0
  while [ "$tries" -lt 30 ]; do
    if curl -sfL "$raw_url" 2>/dev/null \
      | node -e "process.exit(JSON.parse(require('fs').readFileSync(0,'utf8')).version === '${version}' ? 0 : 1)" 2>/dev/null; then
      ok=1
      break
    fi
    tries=$((tries + 1))
    sleep 2
  done
  [ "$ok" = "1" ] || die "marketplace raw URL never served version ${version} after polling — tag push may not have propagated; re-run release-marketplace or check $raw_url manually"

  log "marketplace v${version} live — plugin.json version confirmed via raw URL"
}

# cli_dry_preview VERSION — advisory-only preview for `cli` under --dry-run.
# Deliberately NOT the same checks as the real path below (groundnuty/macf#1099):
# clean-tree, HEAD's-version-equals-target, and remote-main-is-HEAD~1 are all
# true only once `bump`'s REAL branch has committed — and a dry `bump` never
# commits (dry-run mutates nothing, by design; see the file header). Gating
# a preview on the result of a mutation the preview itself guarantees didn't
# happen means the gate fires on every single dry `all` run, for a reason
# that carries zero information (the exact defect reported: a check that is
# always wrong stops being a signal). So here each of those three is either:
#   (a) evaluated in a form that's genuinely independent of `bump` real-vs-
#       dry status — working-tree-clean EXCLUDING CHANGELOG.md (the one file
#       `bump` requires be pre-authored-but-uncommitted; see
#       changelog_has_heading) and on-main and tag-not-already-existing — and
#       surfaced as an advisory NOTE ("this would block the real run")
#       instead of an abort, since a preview mutates nothing regardless of
#       what it finds; or
#   (b) skipped with a neutral note when there is no dry-mode-meaningful
#       answer at all: HEAD's-version-equals-target and remote-is-exactly-
#       one-commit-behind ARE the question "did bump's commit happen", which
#       is unanswerable without performing the mutation dry-run exists to
#       avoid.
# The REAL path (below) is untouched: same checks, same order, same
# messages, same failures — this is a scoping fix, not a weakening.
cli_dry_preview() {
  local version="$1"

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '<detached>')"
  if [ "$branch" != "main" ]; then
    log "[dry-run] NOTE: not on main (current branch: $branch) — this would block the real 'cli' step"
  fi

  local other_dirty
  other_dirty="$(git status --porcelain | grep -v -E ' CHANGELOG\.md$' || true)"
  if [ -n "$other_dirty" ]; then
    log "[dry-run] NOTE: working tree has uncommitted changes beyond the authored CHANGELOG.md entry — this would block the real 'cli' step until committed or stashed:"
    log "$other_dirty"
  fi

  if gh api "repos/${CLI_REPO}/git/ref/tags/v${version}" >/dev/null 2>&1; then
    log "[dry-run] NOTE: tag v${version} already exists on ${CLI_REPO} — this would block the real 'cli' step (idempotent guard)"
  fi

  dry "would verify HEAD's macf-core version == $version and that remote main is exactly one commit behind HEAD — both depend on 'bump' having committed for real; not evaluated in preview"
  dry "would push HEAD to ${CLI_REPO}:main (fast-forward)"
  dry "would tag v${version} and push it to ${CLI_REPO} (triggers publish.yml)"
}

cmd_cli() {
  local version="${1:-}"
  [ -n "$version" ] || die "cli requires <version>"

  ensure_gh_token

  cd "$REPO_ROOT"

  if [ "$DRY_RUN" = "1" ]; then
    cli_dry_preview "$version"
    return 0
  fi

  [ -z "$(git status --porcelain)" ] || die "working tree not clean — commit or stash before release-cli"

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = "main" ] || die "not on main (current branch: $branch) — release-cli must run from main"

  local head_version
  head_version="$(node -p "require('$REPO_ROOT/packages/macf-core/package.json').version")"
  [ "$head_version" = "$version" ] || die "HEAD's macf-core version ($head_version) != target ($version) — run release-bump first"

  local remote_sha local_parent
  remote_sha="$(gh api "repos/${CLI_REPO}/git/ref/heads/main" --jq '.object.sha')"
  local_parent="$(git rev-parse HEAD~1)"
  [ "$remote_sha" = "$local_parent" ] \
    || die "remote main ($remote_sha) is not HEAD~1 ($local_parent) — rebase the bump commit onto latest main before pushing (fast-forward required)"

  if gh api "repos/${CLI_REPO}/git/ref/tags/v${version}" >/dev/null 2>&1; then
    die "tag v${version} already exists on ${CLI_REPO} — refusing (idempotent guard)"
  fi

  git push "$(gh_https_url "$CLI_REPO")" HEAD:main
  git tag "v${version}"
  git push "$(gh_https_url "$CLI_REPO")" "v${version}"
  log "pushed bump commit + tag v${version} to ${CLI_REPO} — publish.yml should trigger shortly"
}

cmd_verify() {
  local version="${1:-}"
  [ -n "$version" ] || die "verify requires <version>"

  ensure_gh_token

  if [ "$DRY_RUN" = "1" ]; then
    dry "would poll repos/${CLI_REPO}/actions/workflows/publish.yml runs for head_branch=v${version} to completion"
    dry "would then require npm view @groundnuty/macf{,-core,-channel-server} version == ${version} for all three (result-invariant, not just green CI), retrying each with backoff up to MACF_RELEASE_NPM_VERIFY_TRIES attempts (default 8) before declaring a genuine MISMATCH — npm's registry CDN can lag a successful publish (#776)"
    return 0
  fi

  log "locating the publish.yml run for tag v${version}..."
  local run_id="" tries=0
  while [ "$tries" -lt 30 ] && [ -z "$run_id" ]; do
    run_id="$(gh api "repos/${CLI_REPO}/actions/workflows/publish.yml/runs?event=push&per_page=30" \
      --jq ".workflow_runs[] | select(.head_branch==\"v${version}\") | .id" 2>/dev/null | head -n1 || true)"
    # Shape-validate: run_id must be purely numeric. A transient rate-limit /
    # malformed-response body from `gh api` (observed once during
    # development: a stray "{" leaked through the pipeline) must never be
    # threaded into the next `gh api .../runs/<run_id>` URL unvalidated.
    [[ "$run_id" =~ ^[0-9]+$ ]] || run_id=""
    if [ -z "$run_id" ]; then
      tries=$((tries + 1))
      sleep 5
    fi
  done
  [ -n "$run_id" ] || die "could not find a Publish workflow run for tag v${version} after polling — check https://github.com/${CLI_REPO}/actions/workflows/publish.yml manually"

  log "found publish run $run_id — polling to completion"
  local status="" conclusion=""
  tries=0
  while [ "$tries" -lt 120 ]; do
    status="$(gh api "repos/${CLI_REPO}/actions/runs/${run_id}" --jq '.status')"
    if [ "$status" = "completed" ]; then
      conclusion="$(gh api "repos/${CLI_REPO}/actions/runs/${run_id}" --jq '.conclusion')"
      break
    fi
    tries=$((tries + 1))
    sleep 10
  done
  [ "$status" = "completed" ] || die "publish run $run_id did not complete after polling — check https://github.com/${CLI_REPO}/actions/runs/${run_id}"

  if [ "$conclusion" != "success" ]; then
    log "publish run $run_id completed with conclusion=$conclusion"
    log ""
    log "DR-022 Amendment L: do NOT retry v${version}. Sigstore's transparency log is"
    log "append-only — retrying the same version risks a 409 TLOG_CREATE_ENTRY_ERROR on"
    log "whichever package's TLOG entry already landed, producing a structurally broken"
    log "split-publish. Diagnose the failure at"
    log "https://github.com/${CLI_REPO}/actions/runs/${run_id}, fix it, then bump to the"
    log "NEXT version and re-run 'make -f dev.mk release VERSION=<next>' from bump."
    die "publish run $run_id did not succeed (conclusion=$conclusion)"
  fi

  log "publish run $run_id succeeded — verifying npm registry (result-invariant per verify-before-claim.md)"
  local pkg all_ok=1
  for pkg in macf-core macf macf-channel-server; do
    wait_for_npm_version "@groundnuty/${pkg}" "$version" || all_ok=0
  done
  [ "$all_ok" = "1" ] || die "npm registry verification failed — see MISMATCH line(s) above (a genuine miss, not registry lag — each package was already retried with backoff; see #776)"

  log "release v${version} fully verified: publish run green + all 3 packages live on npm at ${version}"
}

cmd_all() {
  local version="${1:-}"
  [ -n "$version" ] || die "all requires <version>"
  cmd_bump "$version"
  cmd_check
  cmd_harness_check
  cmd_marketplace "$version"
  cmd_cli "$version"
  cmd_verify "$version"
  log "release v${version} complete."
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

main() {
  local sub="${1:-}"
  [ "$#" -gt 0 ] && shift

  local -a rest=()
  local a
  for a in "$@"; do
    case "$a" in
      --dry-run) DRY_RUN=1 ;;
      *) rest+=("$a") ;;
    esac
  done
  local version="${rest[0]:-}"

  case "$sub" in
    bump) cmd_bump "$version" ;;
    check) cmd_check ;;
    harness-check) cmd_harness_check ;;
    marketplace) cmd_marketplace "$version" ;;
    cli) cmd_cli "$version" ;;
    verify) cmd_verify "$version" ;;
    all) cmd_all "$version" ;;
    -h | --help | "")
      usage
      exit 0
      ;;
    *)
      log "Unknown subcommand: $sub"
      usage
      exit 2
      ;;
  esac
}

# Only run main when executed directly — sourcing (release.test.sh) gets the
# function definitions without triggering any subcommand.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
