#!/usr/bin/env bash
#
# bootstrap-commit-vault.sh — commit the encrypted vault into the project's
# science/coordination repo (DR-035 §4 step 6 + §6 two-machine handoff). The
# vault.age rides to the VM via `git` (encrypted — safe in a private repo); the
# age decryption key goes out-of-band via scp.
#
# Usage:
#   bootstrap-commit-vault.sh --repo <owner/repo> --vault <vault.age> \
#       [--accessor <vault.sh>] [--template <vault.template.txt>] \
#       [--message <commit-msg>]
#
# Non-destructive guarantees (DR-035 §4 — "never irreversibly mutate existing
# state"):
#   - if secrets/vault.age ALREADY EXISTS in the repo it FAILS LOUD (exit 1) and
#     does NOT clobber it. Set MACF_BOOTSTRAP_VAULT_VERSION=1 to instead write a
#     timestamped secrets/vault.<UTC>.age beside it (version, don't overwrite).
#   - the push is a NORMAL push — never --force (force-push is also denied in
#     settings.json + the gh guard).
#   - the /tmp clone (which briefly holds the encrypted vault on disk) is removed
#     on completion AND on abort (trap), with a best-effort `shred` pass first.
#     NOTE: `shred` is a no-op on macOS/APFS (copy-on-write) — the real at-rest
#     protection is FileVault; the durable win here is that the clone is always
#     removed (success + abort), not the overwrite.
#
# Refs: DR-035 §4/§6; sister scripts bootstrap-{exchange-manifest,build-vault}.sh.
set -euo pipefail

REPO=""; VAULT=""; ACCESSOR=""; TEMPLATE=""; MSG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)       REPO="${2:-}"; shift 2 ;;
    --repo=*)     REPO="${1#*=}"; shift ;;
    --vault)      VAULT="${2:-}"; shift 2 ;;
    --vault=*)    VAULT="${1#*=}"; shift ;;
    --accessor)   ACCESSOR="${2:-}"; shift 2 ;;
    --accessor=*) ACCESSOR="${1#*=}"; shift ;;
    --template)   TEMPLATE="${2:-}"; shift 2 ;;
    --template=*) TEMPLATE="${1#*=}"; shift ;;
    --message)    MSG="${2:-}"; shift 2 ;;
    --message=*)  MSG="${1#*=}"; shift ;;
    *) echo "FATAL: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO" ]]   || { echo "FATAL: --repo <owner/repo> required." >&2; exit 2; }
[[ -n "$VAULT" ]]  || { echo "FATAL: --vault <vault.age> required." >&2; exit 2; }
[[ -f "$VAULT" ]]  || { echo "FATAL: --vault '$VAULT' not found." >&2; exit 2; }
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "FATAL: --repo must be owner/repo, got '$REPO'." >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "FATAL: git not found on PATH." >&2; exit 1; }
[[ -n "$MSG" ]] || MSG="chore(secrets): add macf-bootstrap age-encrypted vault (DR-035)"

# Working clone in a scratch dir. SHRED + remove it on ANY exit (success, error,
# or interrupt) — it briefly holds the encrypted vault on disk (DR-035 §4).
TMP="$(mktemp -d "${TMPDIR:-/tmp}/macf-bootstrap-vault.XXXXXX")"
echo "bootstrap-commit-vault: working clone at $TMP" >&2
cleanup() {
  if [[ -d "$TMP" ]]; then
    if command -v shred >/dev/null 2>&1; then
      find "$TMP" -type f -exec shred -u {} + 2>/dev/null || true
    fi
    rm -rf "$TMP" 2>/dev/null || true
  fi
}
trap 'cleanup' EXIT

URL="https://github.com/${REPO}.git"
if ! git clone --depth 1 "$URL" "$TMP" >&2; then
  echo "FATAL: failed to clone $REPO. Ensure gh credential helper is set (gh auth setup-git) and you have access." >&2
  exit 1
fi

mkdir -p "$TMP/secrets"
DEST="$TMP/secrets/vault.age"
if [[ -e "$DEST" ]]; then
  if [[ "${MACF_BOOTSTRAP_VAULT_VERSION:-}" == "1" ]]; then
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    DEST="$TMP/secrets/vault.${ts}.age"
    echo "⚠ secrets/vault.age exists — versioning to secrets/vault.${ts}.age (MACF_BOOTSTRAP_VAULT_VERSION=1)." >&2
  else
    echo "FATAL: secrets/vault.age already exists in $REPO — refusing to overwrite an existing vault (DR-035 §4)." >&2
    echo "  To version instead of fail: re-run with MACF_BOOTSTRAP_VAULT_VERSION=1 (writes secrets/vault.<UTC>.age)." >&2
    exit 1
  fi
fi

cp "$VAULT" "$DEST"
[[ -n "$ACCESSOR" && -f "$ACCESSOR" ]] && cp "$ACCESSOR" "$TMP/secrets/vault.sh"
[[ -n "$TEMPLATE" && -f "$TEMPLATE" ]] && cp "$TEMPLATE" "$TMP/secrets/vault.template.txt"

git -C "$TMP" add secrets/
if git -C "$TMP" diff --cached --quiet; then
  echo "FATAL: nothing staged to commit (no vault files changed)." >&2
  exit 1
fi
git -C "$TMP" commit -m "$MSG" >&2

# NORMAL push — NEVER --force (DR-035 §4; also denied in settings.json + gh guard).
if ! git -C "$TMP" push >&2; then
  echo "FATAL: push to $REPO failed (no --force fallback by design — resolve and re-run)." >&2
  exit 1
fi

echo "Committed + pushed the vault to $REPO (secrets/$(basename "$DEST"))." >&2
