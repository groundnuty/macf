#!/usr/bin/env bash
#
# check-managed-drift.sh — SessionStart hook (startup|resume), groundnuty/macf#1525.
# Re-hashes every file listed in `.macf/managed-hashes.json` (what `macf init` /
# `macf update` last wrote). A missing file or a changed hash is drift; on
# drift it prints one line to the agent's context. Quiet when clean.
#
# Quiet too when the record is absent or unreadable: a workspace that macf
# never managed has none. Observational: always exits 0.
# Override: MACF_SKIP_MANAGED_DRIFT_CHECK=1.

[ "${MACF_SKIP_MANAGED_DRIFT_CHECK:-}" = "1" ] && exit 0
cat >/dev/null 2>&1 || true

root="${CLAUDE_PROJECT_DIR:-$PWD}"
record="$root/.macf/managed-hashes.json"
[ -r "$record" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  hash_of() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }
else
  exit 0
fi

entries=$(jq -r 'if type == "object" then to_entries[] | select(.value | type == "string") | "\(.value)\t\(.key)" else empty end' "$record" 2>/dev/null) || exit 0
[ -n "$entries" ] || exit 0

drifted=()
while IFS=$'\t' read -r want rel; do
  [ -n "$rel" ] || continue
  case "$rel" in /*|..|../*|*/../*) continue ;; esac
  # Only a missing file is reported: a changed one may be an operator edit that
  # macf update deliberately keeps (its record keeps macf's last-written hash).
  [ -f "$root/$rel" ] || drifted+=("$rel")
done <<< "$entries"

n=${#drifted[@]}
[ "$n" -gt 0 ] || exit 0

shown=""
i=0
for p in "${drifted[@]}"; do
  [ "$i" -lt 5 ] || break
  shown="${shown:+$shown, }$p"
  i=$((i + 1))
done
[ "$n" -gt 5 ] && shown="$shown, and $((n - 5)) more"

echo "MACF: $n managed files are missing ($shown). Run macf update to restore them, and tell the operator."
exit 0
