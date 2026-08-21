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
#                         — green CI is not proof the registry updated).
#   all VERSION           bump -> check -> marketplace -> cli -> verify,
#                         halting loudly (via `set -e` + explicit `die`) on
#                         the first failing step.
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
  marketplace VERSION   Conditional-sync + bump + tag the macf-marketplace
                         plugin.
  cli VERSION           Push the bump commit to main + tag v<version>
                         (triggers publish.yml).
  verify VERSION        Poll publish.yml + verify npm registry versions.
  all VERSION           bump -> check -> marketplace -> cli -> verify.

Flags:
  --dry-run             Print every step; mutate NOTHING (no writes, no
                         commits, no pushes, no tags). Same as
                         MACF_RELEASE_DRY_RUN=1.

Env (token minting — see coordination.md "Token & Git Hygiene"):
  GH_TOKEN               Reused as-is if already a well-shaped ghs_* token.
  APP_ID, INSTALL_ID      Required to mint a fresh token when GH_TOKEN is
  KEY_PATH, MACF_WORKSPACE_DIR  absent/invalid. KEY_PATH may be relative to
                          MACF_WORKSPACE_DIR (default: repo root).
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
    dry "would then require npm view @groundnuty/macf{,-core,-channel-server} version == ${version} for all three (result-invariant, not just green CI)"
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
  local pkg all_ok=1 live
  for pkg in macf-core macf macf-channel-server; do
    live="$(npm view "@groundnuty/${pkg}" version 2>/dev/null || true)"
    if [ "$live" != "$version" ]; then
      log "MISMATCH: @groundnuty/${pkg} npm version=${live:-<none>}, expected ${version}"
      all_ok=0
    else
      log "OK @groundnuty/${pkg}@${version} live on npm"
    fi
  done
  [ "$all_ok" = "1" ] || die "npm registry verification failed — see mismatches above"

  log "release v${version} fully verified: publish run green + all 3 packages live on npm at ${version}"
}

cmd_all() {
  local version="${1:-}"
  [ -n "$version" ] || die "all requires <version>"
  cmd_bump "$version"
  cmd_check
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
