#!/usr/bin/env bash
#
# vault.sh — accessor for the macf-bootstrap age-encrypted vault (DR-035 output #1).
# Committed alongside vault.age + vault.template.txt into the project's science
# repo. Run ON THE VM after `git clone`ing the science repo and scp'ing in the age
# key. It decrypts vault.age, exports the creds as env vars, and materializes the
# per-agent PEMs to ~/.macf/keys/<name>.pem (0600) so `macf init --app-key` finds
# them at the paths bootstrap-emit-commands.sh prints.
#
#   source vault.sh        # exports vars + writes key files into the CURRENT shell
#
# The age private key is read from (first found):
#   $MACF_VAULT_AGE_KEY  →  ~/.config/macf/vault-age-key.txt
#
# Refs: DR-035 §6 (two-machine handoff); templates/vault.template.txt (the shape).
set -euo pipefail

_vault_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
_vault_age="${_vault_dir}/vault.age"
_age_key="${MACF_VAULT_AGE_KEY:-$HOME/.config/macf/vault-age-key.txt}"

[[ -f "$_vault_age" ]] || { echo "FATAL: vault.age not found next to vault.sh ($_vault_age)." >&2; return 1 2>/dev/null || exit 1; }
[[ -f "$_age_key" ]]   || { echo "FATAL: age key not found ($_age_key). scp it in or set MACF_VAULT_AGE_KEY." >&2; return 1 2>/dev/null || exit 1; }
command -v age >/dev/null 2>&1 || { echo "FATAL: age not found on PATH." >&2; return 1 2>/dev/null || exit 1; }

# Decrypt + load into the current shell.
_vault_plain="$(age -d -i "$_age_key" "$_vault_age")" || {
  echo "FATAL: failed to decrypt vault.age (wrong key?)." >&2; return 1 2>/dev/null || exit 1; }
set -a
eval "$_vault_plain"
set +a
unset _vault_plain

# Materialize each per-agent PEM from its base64 var to ~/.macf/keys/<name>.pem.
mkdir -p "$HOME/.macf/keys"
chmod 700 "$HOME/.macf/keys" 2>/dev/null || true
while IFS= read -r _var; do
  _name="${_var#MACF_AGENT_}"; _name="${_name%_PRIVATE_KEY_B64}"
  _lc="$(printf '%s' "$_name" | tr '[:upper:]_' '[:lower:]-')"
  _dest="$HOME/.macf/keys/${_lc}.pem"
  ( umask 077; printf '%s' "${!_var}" | base64 -d > "$_dest" )
  echo "vault.sh: wrote $_dest" >&2
done < <(compgen -v | grep -E '^MACF_AGENT_.*_PRIVATE_KEY_B64$' || true)

echo "vault.sh: vault decrypted; creds exported; per-agent keys materialized under ~/.macf/keys/." >&2
