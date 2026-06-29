#!/usr/bin/env bash
#
# bootstrap-cleanup.sh — wipe the macf-bootstrap scratch dir `.bootstrap-work/`
# (DR-035 §4; science's #659 secrets-on-disk review). That dir accumulates the
# secrets a run produces before they land in the encrypted vault:
#   - per-agent `*.app.json` (each holds a GitHub App PRIVATE KEY pem)
#   - any `vault.plain` (legacy — the current build-vault never writes one)
#   - `vault.age` (encrypted, but still the fleet's whole cred set)
#   - `vault-age-key.txt` (the age PRIVATE key that decrypts the vault)
#   - `spec.json` (project spec / IDs)
#
# The skill calls this as an ALWAYS step at the end of a run (success) AND on any
# abort. It is idempotent — safe to call repeatedly, and a no-op if the dir is
# already gone.
#
# Usage:
#   bootstrap-cleanup.sh [--work-dir <dir>]
#     --work-dir DIR   the scratch dir to wipe. Default: ${CLAUDE_PROJECT_DIR:-.}/.bootstrap-work
#
# Secrets-on-disk posture (be accurate, do not overclaim):
#   - `shred -u` is used where available, but it is BEST-EFFORT and a NO-OP on
#     macOS/APFS (copy-on-write filesystems never overwrite a file in place), so
#     it does NOT guarantee the bytes are unrecoverable. The real at-rest
#     protection on the operator's Mac is FileVault. The durable wins are
#     structural: nothing here is ever committed (.gitignore) and this cleanup
#     runs on both success and abort so the scratch secrets do not linger.
#   - `rm -f` is ALWAYS the fallback, so the files are removed even when `shred`
#     is absent or a no-op.
#   - An internal EXIT trap guarantees the dir is removed even if the shred pass
#     is interrupted partway.
#
# Refs: DR-035 §4/§5/§6; sister scripts bootstrap-{build-vault,commit-vault}.sh.
set -euo pipefail

WORK=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --work-dir)   WORK="${2:-}"; shift 2 ;;
    --work-dir=*) WORK="${1#*=}"; shift ;;
    *) echo "FATAL: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$WORK" ]] || WORK="${CLAUDE_PROJECT_DIR:-.}/.bootstrap-work"

# Idempotent: nothing to do if the scratch dir is already gone.
if [[ ! -e "$WORK" ]]; then
  echo "bootstrap-cleanup: nothing to clean ($WORK does not exist)." >&2
  exit 0
fi
if [[ ! -d "$WORK" ]]; then
  echo "FATAL: --work-dir '$WORK' exists but is not a directory; refusing to touch it." >&2
  exit 2
fi

# Belt-and-suspenders: even if the shred pass below is interrupted, the EXIT trap
# still removes the dir — the scratch secrets never linger after this script runs.
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT

# Best-effort overwrite of every file before removal (no-op on APFS — see header).
if command -v shred >/dev/null 2>&1; then
  find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true
fi

# Always remove the dir regardless of whether shred ran or overwrote anything.
rm -rf "$WORK" 2>/dev/null || true

echo "bootstrap-cleanup: wiped scratch dir $WORK (shred best-effort; rm -rf authoritative)." >&2
