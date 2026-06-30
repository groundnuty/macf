#!/usr/bin/env bash
#
# vault.sh — accessor for the macf-bootstrap age-encrypted vault (DR-035 output #1).
# Committed alongside vault.age + vault.template.txt into the project's science
# repo. SOURCE it ON THE VM (after cloning the science repo + scp'ing the age key):
# it decrypts vault.age, exports the creds, and materializes:
#   - per-agent App PEMs → ~/.macf/keys/<name>.pem                 (0600)
#   - the per-project CA  → ~/.macf/certs/<project>/ca-{cert,key}.pem
# so `macf init --app-key ...` and `macf certs rotate` find them at the paths
# bootstrap-emit-commands.sh prints.
#
#   source vault.sh        # exports vars + writes key/CA files into the CURRENT shell
#
# SHELL-SAFE (first-run finding, macf-automated-github-setup#1): this script is
# `source`d, often into an interactive LOGIN shell that may be zsh (the common VM
# default), not bash. The previous version ran `set -euo pipefail` and used
# bash-only constructs (`compgen`, `${!var}`, `BASH_SOURCE`); sourced into zsh the
# bash-isms failed under errexit and TOOK THE OPERATOR'S SHELL DOWN. This version:
#   - NEVER enables set -e/-u/pipefail (those leak into — and can kill — the
#     caller's interactive shell on the first non-zero command);
#   - resolves its own path + parses the vault WITHOUT compgen/${!var}, so it
#     behaves identically sourced from bash or zsh.
#
# The age private key is read from (first found):
#   $MACF_VAULT_AGE_KEY  →  ~/.config/macf/vault-age-key.txt
#
# Refs: DR-035 §6 (two-machine handoff); templates/vault.template.txt (the shape).

# Resolve this script's own dir across bash + zsh when sourced. The zsh-only
# `${(%):-%x}` is hidden behind `eval` so bash never parses it (and vice-versa).
if [ -n "${ZSH_VERSION:-}" ]; then
  eval '_vault_self="${(%):-%x}"'
elif [ -n "${BASH_SOURCE:-}" ]; then
  _vault_self="${BASH_SOURCE[0]}"
else
  _vault_self="$0"
fi
_vault_dir="$(cd "$(dirname "$_vault_self")" 2>/dev/null && pwd)"
_vault_age="${_vault_dir}/vault.age"
_age_key="${MACF_VAULT_AGE_KEY:-$HOME/.config/macf/vault-age-key.txt}"

# Soft-fail: return when sourced, exit when executed — and NEVER via `set -e`,
# so a guard miss can't terminate an interactive shell.
_vault_fail() { echo "FATAL: $*" >&2; return 1 2>/dev/null || exit 1; }

[ -f "$_vault_age" ] || _vault_fail "vault.age not found next to vault.sh ($_vault_age)."
[ -f "$_age_key" ]   || _vault_fail "age key not found ($_age_key). scp it in or set MACF_VAULT_AGE_KEY."
command -v age >/dev/null 2>&1 || _vault_fail "age not found on PATH."

_vault_plain="$(age -d -i "$_age_key" "$_vault_age")" \
  || _vault_fail "failed to decrypt vault.age (wrong key?)."

# Export every cred into the current shell.
set -a
eval "$_vault_plain"
set +a

# Materialize per-agent App PEMs: MACF_AGENT_<NAME>_PRIVATE_KEY_B64 → ~/.macf/keys/<name>.pem
# Parse the decrypted text directly (no compgen / ${!var}) so it's shell-portable.
mkdir -p "$HOME/.macf/keys"; chmod 700 "$HOME/.macf/keys" 2>/dev/null || true
printf '%s\n' "$_vault_plain" | grep -E '^MACF_AGENT_[A-Z0-9_]+_PRIVATE_KEY_B64=' | while IFS= read -r _line; do
  _val="${_line#*=}"; _val="${_val#\"}"; _val="${_val%\"}"
  _nm="${_line%%=*}"; _nm="${_nm#MACF_AGENT_}"; _nm="${_nm%_PRIVATE_KEY_B64}"
  _lc="$(printf '%s' "$_nm" | tr 'A-Z_' 'a-z-')"
  _dst="$HOME/.macf/keys/${_lc}.pem"
  ( umask 077; printf '%s' "$_val" | base64 -d > "$_dst" )
  echo "vault.sh: wrote $_dst" >&2
done

# Materialize the per-project CA: MACF_<PROJECT>_CA_{CERT,KEY}_B64 → ~/.macf/certs/<project>/
# so `macf certs rotate` works on the VM WITHOUT a manual step (and without ever
# running `macf certs init` there, which would mint a NEW CA + clobber the registry var).
printf '%s\n' "$_vault_plain" | grep -E '^MACF_[A-Z0-9_]+_CA_(CERT|KEY)_B64=' | while IFS= read -r _line; do
  _val="${_line#*=}"; _val="${_val#\"}"; _val="${_val%\"}"
  _key="${_line%%=*}"
  case "$_key" in
    *_CA_KEY_B64)  _proj="${_key#MACF_}"; _proj="${_proj%_CA_KEY_B64}";  _file="ca-key.pem";  _mode=600 ;;
    *_CA_CERT_B64) _proj="${_key#MACF_}"; _proj="${_proj%_CA_CERT_B64}"; _file="ca-cert.pem"; _mode=644 ;;
    *) continue ;;
  esac
  _plc="$(printf '%s' "$_proj" | tr 'A-Z_' 'a-z-')"
  _cadir="$HOME/.macf/certs/${_plc}"
  mkdir -p "$_cadir"; chmod 700 "$_cadir" 2>/dev/null || true
  ( umask 077; printf '%s' "$_val" | base64 -d > "$_cadir/$_file" )
  chmod "$_mode" "$_cadir/$_file" 2>/dev/null || true
  echo "vault.sh: wrote $_cadir/$_file" >&2
done

unset _vault_plain
echo "vault.sh: vault decrypted; creds exported; per-agent keys + CA materialized under ~/.macf/." >&2
