#!/usr/bin/env bash
#
# bootstrap-build-vault.sh — age-encrypt the assembled bootstrap secrets into
# `vault.age` (DR-035 output #1). The skill assembles the plaintext (per
# templates/vault.template.txt) from the per-agent manifest-exchange outputs +
# the routing creds + the CA key; THIS script encrypts it and guarantees no
# plaintext is left on disk.
#
# Usage:
#   bootstrap-build-vault.sh --in <plaintext> --out <vault.age> \
#       [--recipient <age1...|recipients-file>] [--key-out <age-key.txt>]
#
#   --in FILE         assembled plaintext vault (env-style; see vault.template.txt)
#   --out FILE        destination encrypted vault (vault.age)
#   --recipient R     an age recipient — either an `age1...` public key OR a path
#                     to a recipients file. If OMITTED, a fresh keypair is minted
#                     and its PRIVATE key is written to --key-out for the operator
#                     to scp out-of-band to the VM (DR-035 §6 two-machine handoff).
#   --key-out FILE    where to write the minted private key when --recipient is
#                     omitted. Default: <out-dir>/vault-age-key.txt (0600).
#
# Guarantees:
#   - the --in plaintext is SHREDDED after a successful encrypt (no plaintext
#     left on disk — DR-035 §4 secure-cleanup).
#   - on ANY failure the partial --out is removed (no half-written vault).
#
# Refs: DR-035 §4/§5/§6; sister scripts bootstrap-{exchange-manifest,commit-vault}.sh.
set -euo pipefail

IN=""; OUT=""; RECIPIENT=""; KEY_OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --in)         IN="${2:-}"; shift 2 ;;
    --in=*)       IN="${1#*=}"; shift ;;
    --out)        OUT="${2:-}"; shift 2 ;;
    --out=*)      OUT="${1#*=}"; shift ;;
    --recipient)  RECIPIENT="${2:-}"; shift 2 ;;
    --recipient=*)RECIPIENT="${1#*=}"; shift ;;
    --key-out)    KEY_OUT="${2:-}"; shift 2 ;;
    --key-out=*)  KEY_OUT="${1#*=}"; shift ;;
    *) echo "FATAL: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$IN" ]]  || { echo "FATAL: --in <plaintext> required." >&2; exit 2; }
[[ -n "$OUT" ]] || { echo "FATAL: --out <vault.age> required." >&2; exit 2; }
[[ -f "$IN" ]]  || { echo "FATAL: plaintext --in '$IN' not found." >&2; exit 2; }
command -v age >/dev/null 2>&1 || { echo "FATAL: age not found on PATH." >&2; exit 1; }

# Remove a partial vault on any failure so a broken run never leaves a half-vault.
cleanup_fail() { rm -f "$OUT" 2>/dev/null || true; }
trap 'cleanup_fail' ERR

shred_file() {
  # shred where available (overwrites), else best-effort remove. Either way the
  # plaintext must not survive (DR-035 §4).
  if command -v shred >/dev/null 2>&1; then shred -u "$1" 2>/dev/null || rm -f "$1"
  else rm -f "$1"; fi
}

# Build the `age -r/-R` recipient args. When --recipient is omitted, mint a fresh
# keypair, write its private key to --key-out, and use its public key.
recip_args=()
if [[ -z "$RECIPIENT" ]]; then
  command -v age-keygen >/dev/null 2>&1 || { echo "FATAL: age-keygen not found (needed to mint a recipient keypair)." >&2; exit 1; }
  if [[ -z "$KEY_OUT" ]]; then KEY_OUT="$(dirname "$OUT")/vault-age-key.txt"; fi
  ( umask 077; age-keygen -o "$KEY_OUT" 2>/dev/null )
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

# Encrypt. umask so the encrypted vault is 0600 even though it is safe-at-rest.
( umask 077; age "${recip_args[@]}" -o "$OUT" "$IN" )
[[ -s "$OUT" ]] || { echo "FATAL: age produced an empty vault." >&2; exit 1; }

# Success — shred the plaintext input (no plaintext on disk, DR-035 §4).
trap - ERR
shred_file "$IN"

echo "Encrypted vault written: $OUT" >&2
echo "Plaintext input shredded: $IN" >&2
