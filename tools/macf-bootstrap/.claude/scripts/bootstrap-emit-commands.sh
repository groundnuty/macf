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
PROJ_SEG="$(printf '%s' "$PROJECT" | tr '[:lower:]-' '[:upper:]_')"

# Registry flags from spec.registry.type.
REG_TYPE="$(jq -r '.registry.type // "repo"' "$SPEC")"
case "$REG_TYPE" in
  profile) REG_FLAGS="--registry-type profile --registry-user $(jq -r '.registry.user // empty' "$SPEC")" ;;
  org)     REG_FLAGS="--registry-type org --registry-org $(jq -r '.registry.org // empty' "$SPEC")" ;;
  repo)    REG_FLAGS="--registry-type repo --registry-repo $(jq -r '.registry.repo // empty' "$SPEC")" ;;
  local)   REG_FLAGS="--registry-type local" ;;
  *) echo "FATAL: unknown registry.type '$REG_TYPE' (expected profile|org|repo|local)." >&2; exit 1 ;;
esac

# macf#805/#806: registry flags for `macf repo-init` (below). repo-init derives
# repo-scope owner/repo from --repo and does NOT accept --registry-repo, so its
# flags differ from `macf init`'s REG_FLAGS on the repo case.
case "$REG_TYPE" in
  profile) RI_REG="--registry-type profile --registry-user $(jq -r '.registry.user // empty' "$SPEC")" ;;
  org)     RI_REG="--registry-type org --registry-org $(jq -r '.registry.org // empty' "$SPEC")" ;;
  *)       RI_REG="--registry-type repo" ;;
esac
# Full fleet: every repo's agent-config.json must list ALL agents (keyed by
# routing label) so route-by-mention/route-by-pr-review-state can resolve any
# of them, not just the local agent (macf#805). Comma-joined clean `name`s.
ALL_AGENTS="$(jq -r '[.agents[].name] | join(",")' "$SPEC")"

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
echo "# ── 1. Decrypt the vault (materializes per-agent .pem files + the CA) ─"
if [[ -n "$SCIENCE_REPO" ]]; then
  echo "#   git clone https://github.com/${SCIENCE_REPO}.git <science-home>"
fi
echo "#   scp <mac>:vault-age-key.txt ~/.config/macf/vault-age-key.txt"
echo "#   source <science-home>/secrets/vault.sh"
echo "#     → exports creds; writes ~/.macf/keys/<agent>.pem AND ~/.macf/certs/${PROJECT}/ca-{cert,key}.pem"
echo "#   (vault.sh is source-safe in any shell — bash or zsh.)"
echo "#   ⚠ Do NOT run \`macf certs init\` on the VM — it would mint a NEW CA and"
echo "#     overwrite ${PROJ_SEG}_CA_CERT in the registry. The CA from the vault plus"
echo "#     \`macf certs rotate\` (below) is all each agent needs."
echo ""
echo "# ── 2. Per-agent: clone (or mirror) the home repo + macf init + certs rotate ─"

# Iterate agents. Emit tab-separated fields then format in bash to keep quoting
# predictable and the renderer easy to unit-test.
jq -r '.agents[] | [
  (.role // ""), (.name // ""), (.repo // ""), (.deploy_path // ""),
  (.app_id // ""), (.install_id // ""),
  (.key_path // ("~/.macf/keys/" + (.name // "agent") + ".pem")),
  (.repo_provenance // "template")
] | @tsv' "$SPEC" | while IFS=$'\t' read -r role name repo deploy_path app_id install_id key_path provenance; do
  echo ""
  echo "# ${name} (${role})"
  case "$provenance" in
    overleaf-mirror|mirror)
      # Home dir ALREADY EXISTS (e.g. an Overleaf-backed paper repo) and the GitHub
      # repo is an empty MIRROR target — do NOT clone. Add GitHub as a 2nd remote
      # and push the existing content to it (keeps the existing 'origin').
      echo "# existing dir (${provenance}) — do NOT clone; mirror to the empty GitHub repo:"
      echo "cd ${deploy_path}"
      [[ -n "$repo" ]] && echo "git remote add github https://github.com/${repo}.git"
      echo "git push -u github HEAD   # mirror the current branch to GitHub"
      ;;
    *)
      [[ -n "$repo" && -n "$deploy_path" ]] && echo "git clone https://github.com/${repo}.git ${deploy_path}"
      ;;
  esac
  printf 'macf init \\\n'
  printf '  --project %s --role %s --name %s \\\n' "$PROJECT" "$role" "$name"
  printf '  --app-id %s --install-id %s \\\n' "$app_id" "$install_id"
  printf '  --app-key %s \\\n' "$key_path"
  printf '  %s \\\n' "$REG_FLAGS"
  [[ -n "$ADVERTISE" ]] && printf '  --advertise-host %s \\\n' "$ADVERTISE"
  printf '  --dir %s\n' "$deploy_path"
  printf 'macf certs rotate --dir %s   # agent mTLS cert (uses the CA materialized by vault.sh)\n' "$deploy_path"
  # macf#797/#804/#805/#806: set up the ROUTING PLANE for this repo. repo-init
  # generates the born-correct agent-router.yml (permissions block + immutable
  # v3 pin — repo-init resolves `v3` to the latest full tag) AND the full-fleet
  # agent-config.json (keyed by routing label, app_name=<project>-<agent> App
  # handle, all agents so cross-agent mention/review routing resolves).
  printf 'macf repo-init --repo %s --project %s --agents %s \\\n' "$repo" "$PROJECT" "$ALL_AGENTS"
  printf '  --actions-version v3 %s --dir %s   # born-correct router + full-fleet agent-config\n' "$RI_REG" "$deploy_path"
  # The v3 router reads the target CA it trusts from a REPO VARIABLE on this
  # repo (`vars[<PROJECT_SEG>_CA_CERT]`), NOT the registry — set it from the CA
  # materialized by vault.sh. Public cert → a variable, not a secret (macf#806).
  printf 'gh variable set %s_CA_CERT --repo %s --body "$(cat ~/.macf/certs/%s/ca-cert.pem)"\n' "$PROJ_SEG" "$repo" "$PROJECT"
done

echo ""
echo "# ── 3. Verify the fleet (DR-030 health trio — run after all launch) ──"
echo "macf fleet status        # roster + live health (want all online + reachable)"
echo "macf routing doctor      # routing plane wired (want: routing plane: HEALTHY)"
echo "macf fleet doctor --inject   # mesh actually delivers (exit 0 = healthy)"
echo ""
echo "# ── 4. Setup asserts (the Apps + secrets the bootstrap created) ──────"
echo "# Per agent — verify the App token mints + has DR-019 perms, from its home:"
jq -r '.agents[] | [(.name // ""), (.repo // "")] | @tsv' "$SPEC" \
  | while IFS=$'\t' read -r name repo; do
  [[ -n "$repo" ]] && echo "macf doctor --dir <home-of-${name}>   # App-token perms vs DR-019 on ${repo}"
done
echo "# (Verifying an install with \`gh api /app/installations/<id>\` needs an APP JWT, not"
echo "#  your user token — use \`macf doctor\` above, or each App's Install-App settings page.)"
echo "# Routing secrets present on each repo:"
echo "#   gh secret list --repo <repo>   # expect MACF_ROUTING_APP_ID/KEY, ROUTING_CLIENT_CERT/KEY, TS_OAUTH_CLIENT_ID/SECRET"
echo "#   gh variable list --repo <registry-target>   # expect ${PROJ_SEG}_CA_CERT + MACF_${PROJ_SEG}_AGENT_<NAME> per agent"
