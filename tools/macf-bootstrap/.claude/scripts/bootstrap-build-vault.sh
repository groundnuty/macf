#!/usr/bin/env bash
#
# bootstrap-build-vault.sh — age-encrypt the assembled bootstrap secrets into
# `vault.age` (DR-035 output #1). The skill assembles the plaintext (per
# templates/vault.template.txt) from the per-agent manifest-exchange outputs +
# the routing creds + the CA key, and PIPES it to THIS script on STDIN; the
# script streams it straight into `age`. No `vault.plain` file is ever written —
# secure-by-construction (science's #659 secrets-on-disk review).
#
# Usage:
#   <assembled-plaintext> | bootstrap-build-vault.sh --out <vault.age> \
#       [--recipient <age1...|recipients-file>] [--key-out <age-key.txt>]
#
#   (plaintext on STDIN)  the assembled env-style vault (see vault.template.txt)
#   --out FILE        destination encrypted vault (vault.age)
#   --recipient R     an age recipient — either an `age1...` public key OR a path
#                     to a recipients file. If OMITTED, a fresh keypair is minted
#                     and its PRIVATE key is written to --key-out for the operator
#                     to scp out-of-band to the VM (DR-035 §6 two-machine handoff).
#   --key-out FILE    where to write the minted private key when --recipient is
#                     omitted. Default: <out-dir>/vault-age-key.txt (0600).
#
# Secrets-on-disk posture (science's #659 review — be accurate, do not overclaim):
#   - The plaintext is read from STDIN and streamed into `age`; it is NEVER
#     materialized as a file. This is the load-bearing protection — there is no
#     `vault.plain` to leak, shred, or forget. (The only plaintext that touches
#     disk in the wider flow is the per-agent `*.app.json` PEMs the manifest
#     exchange writes; those are .gitignored + shredded by bootstrap-cleanup.sh.)
#   - On ANY failure the partial --out (and a freshly-minted --key-out) are
#     removed so a broken run never leaves a half-written vault or an orphan key.
#   - `shred` (used elsewhere in this tool) is BEST-EFFORT and a NO-OP on
#     macOS/APFS (copy-on-write never overwrites in place). The real at-rest
#     protection on the operator's Mac is FileVault — not shred.
#
# Refs: DR-035 §4/§5/§6; sister scripts bootstrap-{exchange-manifest,commit-vault,cleanup}.sh.
set -euo pipefail

OUT=""; RECIPIENT=""; KEY_OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)        OUT="${2:-}"; shift 2 ;;
    --out=*)      OUT="${1#*=}"; shift ;;
    --recipient)  RECIPIENT="${2:-}"; shift 2 ;;
    --recipient=*)RECIPIENT="${1#*=}"; shift ;;
    --key-out)    KEY_OUT="${2:-}"; shift 2 ;;
    --key-out=*)  KEY_OUT="${1#*=}"; shift ;;
    --in|--in=*)
      echo "FATAL: --in is removed — plaintext is now read from STDIN (no vault.plain on disk)." >&2
      echo "  Pipe it instead:  <assembled-plaintext> | bootstrap-build-vault.sh --out <vault.age>" >&2
      exit 2 ;;
    *) echo "FATAL: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$OUT" ]] || { echo "FATAL: --out <vault.age> required." >&2; exit 2; }
command -v age >/dev/null 2>&1 || { echo "FATAL: age not found on PATH." >&2; exit 1; }
if [[ -t 0 ]]; then
  echo "FATAL: no plaintext on STDIN — pipe the assembled vault plaintext in." >&2
  echo "  e.g.  <assembled-plaintext> | bootstrap-build-vault.sh --out $OUT" >&2
  exit 2
fi

# Track whether WE minted the key so failure-cleanup removes only our own.
MINTED_KEY=0
# Remove a partial vault (and a just-minted key) on any failure so a broken run
# never leaves a half-written vault or an orphan private key.
cleanup_fail() {
  rm -f "$OUT" 2>/dev/null || true
  [[ "$MINTED_KEY" == "1" && -n "$KEY_OUT" ]] && rm -f "$KEY_OUT" 2>/dev/null || true
}
trap 'cleanup_fail' ERR

# Buffer STDIN in memory (never on disk) so we can reject an empty plaintext —
# a silently-empty vault is exactly the silent-fallback hazard this tool guards
# against. The buffer is a shell variable: process memory only, not a file, and
# not exported (so it never lands in /proc/<pid>/environ). Done BEFORE minting a
# keypair so an empty input never leaves an orphan key on disk.
plaintext="$(cat)"
[[ -n "$plaintext" ]] || { echo "FATAL: empty plaintext on STDIN — nothing to encrypt." >&2; exit 2; }

# Build the `age -r/-R` recipient args. When --recipient is omitted, mint a fresh
# keypair, write its private key to --key-out, and use its public key.
recip_args=()
if [[ -z "$RECIPIENT" ]]; then
  command -v age-keygen >/dev/null 2>&1 || { echo "FATAL: age-keygen not found (needed to mint a recipient keypair)." >&2; exit 1; }
  if [[ -z "$KEY_OUT" ]]; then KEY_OUT="$(dirname "$OUT")/vault-age-key.txt"; fi
  ( umask 077; age-keygen -o "$KEY_OUT" 2>/dev/null )
  MINTED_KEY=1
  chmod 600 "$KEY_OUT" 2>/dev/null || true
  # age-keygen writes a `# public key: age1...` comment line into the key file.
  pub="$(grep -oE 'age1[0-9a-z]+' "$KEY_OUT" | head -1 || true)"
  [[ -n "$pub" ]] || { echo "FATAL: could not derive the public key from the minted keypair ($KEY_OUT)." >&2; exit 1; }
  recip_args=(-r "$pub")
  echo "Minted a fresh age keypair. PRIVATE key: $KEY_OUT" >&2
  echo "  → scp this key out-of-band to the VM; vault.sh decrypts vault.age with it (DR-035 §6)." >&2
elif [[ -f "$RECIPIENT" ]]; then
  recip_args=(-R "$RECIPIENT")
else
  # treat as a literal age recipient public key
  case "$RECIPIENT" in
    age1*) recip_args=(-r "$RECIPIENT") ;;
    *) echo "FATAL: --recipient '$RECIPIENT' is neither an existing file nor an age1... public key." >&2; exit 2 ;;
  esac
fi

# Stream the buffered plaintext into age (set -o pipefail makes an age failure
# fail the whole pipeline → ERR trap → cleanup). umask so the vault is 0600 even
# though it is safe-at-rest. No plaintext file is ever created.
( umask 077; printf '%s\n' "$plaintext" | age "${recip_args[@]}" -o "$OUT" )
unset plaintext
[[ -s "$OUT" ]] || { echo "FATAL: age produced an empty vault." >&2; exit 1; }

trap - ERR
echo "Encrypted vault written: $OUT (plaintext was streamed on STDIN — no vault.plain on disk)." >&2
