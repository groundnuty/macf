#!/usr/bin/env bash
#
# bootstrap-emit-commands.sh — render the VM-side handoff (DR-035 outputs #2 + #3)
# from the project spec + the captured App IDs.
#
# Output #2: the filled-in `macf` command list — per agent, the `git clone` of
#            its home repo + the `macf init` with every --app-id/--install-id/
#            --app-key/--registry-* substituted.
# Output #3: the verification commands — the DR-030 fleet-health trio
#            (`macf fleet status` / `macf routing doctor` / `macf fleet doctor`)
#            plus setup-specific asserts (Apps exist + installed; secrets present).
#
# Usage:
#   bootstrap-emit-commands.sh --spec <spec.json>
#
# Spec shape (see templates/bootstrap-spec.example.json):
#   {
#     "project": "icsoc-2026",
#     "registry": { "type": "profile", "user": "groundnuty" },
#     "advertise_host": "host.tailnet.ts.net",
#     "science_repo": "groundnuty/icsoc-2026-science-agent",
#     "agents": [
#       { "role": "science-agent", "name": "icsoc-2026-science-agent",
#         "repo": "groundnuty/icsoc-2026-science-agent",
#         "deploy_path": "/home/ubuntu/repos/agh/icsoc-2026-science-agent",
#         "app_id": "123", "install_id": "456",
#         "key_path": "~/.macf/keys/icsoc-2026-science-agent.pem" }
#     ]
#   }
#
# The emitted commands are what the operator runs ON THE VM after `git clone`ing
# the science repo (which carries vault.age) and decrypting it with the scp'd age
# key (DR-035 §6). Pure renderer — no side effects, deterministic, testable.
#
# Refs: DR-035 §5/§6; use-cases/scientific-paper-fleet.md §3 + §3f.
set -euo pipefail

SPEC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --spec)   SPEC="${2:-}"; shift 2 ;;
    --spec=*) SPEC="${1#*=}"; shift ;;
    *) echo "FATAL: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SPEC" ]] || { echo "FATAL: --spec <spec.json> required." >&2; exit 2; }
[[ -f "$SPEC" ]] || { echo "FATAL: spec '$SPEC' not found." >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq not found on PATH." >&2; exit 1; }
jq -e . "$SPEC" >/dev/null 2>&1 || { echo "FATAL: spec '$SPEC' is not valid JSON." >&2; exit 1; }

PROJECT="$(jq -r '.project // empty' "$SPEC")"
[[ -n "$PROJECT" ]] || { echo "FATAL: spec.project is required." >&2; exit 1; }
ADVERTISE="$(jq -r '.advertise_host // empty' "$SPEC")"
SCIENCE_REPO="$(jq -r '.science_repo // empty' "$SPEC")"

# Registry flags from spec.registry.type.
REG_TYPE="$(jq -r '.registry.type // "repo"' "$SPEC")"
case "$REG_TYPE" in
  profile) REG_FLAGS="--registry-type profile --registry-user $(jq -r '.registry.user // empty' "$SPEC")" ;;
  org)     REG_FLAGS="--registry-type org --registry-org $(jq -r '.registry.org // empty' "$SPEC")" ;;
  repo)    REG_FLAGS="--registry-type repo --registry-repo $(jq -r '.registry.repo // empty' "$SPEC")" ;;
  local)   REG_FLAGS="--registry-type local" ;;
  *) echo "FATAL: unknown registry.type '$REG_TYPE' (expected profile|org|repo|local)." >&2; exit 1 ;;
esac

n_agents="$(jq '.agents | length' "$SPEC")"
[[ "$n_agents" -gt 0 ]] || { echo "FATAL: spec.agents is empty." >&2; exit 1; }

echo "# ════════════════════════════════════════════════════════════════════"
echo "# macf-bootstrap — VM-side commands for project: ${PROJECT}"
echo "# Run these ON THE VM. Prereqs: macf CLI installed; the science repo cloned"
echo "# (it carries secrets/vault.age); the age key scp'd in; then \`source"
echo "#   <science-repo>/secrets/vault.sh\` to decrypt + materialize the per-agent"
echo "# key files at the --app-key paths below (DR-035 §6)."
echo "# ════════════════════════════════════════════════════════════════════"
echo ""
echo "# ── 1. Decrypt the vault (materializes per-agent .pem files) ──────────"
if [[ -n "$SCIENCE_REPO" ]]; then
  echo "#   git clone https://github.com/${SCIENCE_REPO}.git <science-home>"
fi
echo "#   scp <mac>:vault-age-key.txt ~/.config/macf/vault-age-key.txt"
echo "#   source <science-home>/secrets/vault.sh   # exports creds + writes .pem files"
echo ""
echo "# ── 2. Per-agent: clone the home repo + macf init ────────────────────"

# Iterate agents. Emit tab-separated fields then format in bash to keep quoting
# predictable and the renderer easy to unit-test.
jq -r '.agents[] | [
  (.role // ""), (.name // ""), (.repo // ""), (.deploy_path // ""),
  (.app_id // ""), (.install_id // ""),
  (.key_path // ("~/.macf/keys/" + (.name // "agent") + ".pem"))
] | @tsv' "$SPEC" | while IFS=$'\t' read -r role name repo deploy_path app_id install_id key_path; do
  echo ""
  echo "# ${name} (${role})"
  if [[ -n "$repo" && -n "$deploy_path" ]]; then
    echo "git clone https://github.com/${repo}.git ${deploy_path}"
  fi
  printf 'macf init \\\n'
  printf '  --project %s --role %s --name %s \\\n' "$PROJECT" "$role" "$name"
  printf '  --app-id %s --install-id %s \\\n' "$app_id" "$install_id"
  printf '  --app-key %s \\\n' "$key_path"
  printf '  %s \\\n' "$REG_FLAGS"
  [[ -n "$ADVERTISE" ]] && printf '  --advertise-host %s \\\n' "$ADVERTISE"
  printf '  --dir %s\n' "$deploy_path"
done

echo ""
echo "# ── 3. Verify the fleet (DR-030 health trio — run after all launch) ──"
echo "macf fleet status        # roster + live health (want all online + reachable)"
echo "macf routing doctor      # routing plane wired (want: routing plane: HEALTHY)"
echo "macf fleet doctor --inject   # mesh actually delivers (exit 0 = healthy)"
echo ""
echo "# ── 4. Setup asserts (the Apps + secrets the bootstrap created) ──────"
jq -r '.agents[] | [(.name // ""), (.repo // ""), (.install_id // "")] | @tsv' "$SPEC" \
  | while IFS=$'\t' read -r name repo install_id; do
  echo "gh api /app/installations/${install_id} --jq '.app_slug'   # ${name} App installed?"
  [[ -n "$repo" ]] && echo "macf doctor --dir <home-of-${name}>   # App-token perms vs DR-019 on ${repo}"
done
echo "# Routing secrets present on each repo:"
echo "#   gh secret list --repo <repo>   # expect MACF_ROUTING_APP_ID/KEY, ROUTING_CLIENT_CERT/KEY, TS_OAUTH_CLIENT_ID/SECRET"
if [[ -n "$ADVERTISE" || -n "$PROJECT" ]]; then
  proj_seg="$(printf '%s' "$PROJECT" | tr '[:lower:]-' '[:upper:]_')"
  echo "#   gh variable list --repo <registry-target>   # expect ${proj_seg}_CA_CERT + MACF_${proj_seg}_AGENT_<NAME> per agent"
fi
