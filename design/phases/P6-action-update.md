# P6: Action Update

**Goal:** Update the GitHub Action (agent-router.yml) to use HTTP POST to channels instead of SSH+tmux.

**Depends on:** P1 (channel endpoint), P2 (registry discovery), P3 (mTLS certs for Action)
**Design decisions:** DR-003, DR-005, DR-006, DR-017

---

## Deliverables

1. **Updated `agent-router.yml` template** — HTTP POST instead of SSH
2. **Per-repo config** (`.github/macf-config.json`) — project prefix, registry scope
3. **Router cert** — Action authenticates to agents via mTLS
4. **Three jobs preserved**: route-by-label, route-by-mention, sync-board

## What Changes

| Component | Before (SSH) | After (Channels) |
|---|---|---|
| Network setup | Tailscale + SSH key setup | Tailscale + mTLS cert setup |
| Agent discovery | Read agent-config.json file | Read `{PROJECT}_AGENT_*` from registry |
| Message delivery | `ssh ... tmux send-keys` | `curl --cert ... POST /notify` |
| Offline detection | SSH failure | HTTP POST timeout |
| Secrets needed | SSH keys, Tailscale OAuth | Router cert+key, Tailscale OAuth, CA cert |

## Per-Repo Config

```json
// .github/macf-config.json
{
  "project": "MACF",
  "registry": {
    "type": "org",
    "org": "macf-experiment"
  }
}
```

Action reads this to know where to find agent variables.

## Action Secrets/Variables Needed

| Name | Type | Source | Purpose |
|---|---|---|---|
| `TS_OAUTH_CLIENT_ID` | Secret | Tailscale | VPN access |
| `TS_OAUTH_SECRET` | Secret | Tailscale | VPN access |
| `MACF_ROUTER_CERT` | Secret | P3 cert generation | mTLS client cert |
| `MACF_ROUTER_KEY` | Secret | P3 cert generation | mTLS client key |
| `{PROJECT}_CA_CERT` | Variable | P3 CA init | mTLS CA verification |
| `PROJECT_TOKEN` | Secret | GitHub PAT | Board sync (if Projects used) |

## Route-by-Label Job (key change)

```yaml
- name: Read project config
  id: config
  run: |
    PROJECT=$(jq -r '.project' .github/macf-config.json)
    REGISTRY_TYPE=$(jq -r '.registry.type' .github/macf-config.json)
    if [ "$REGISTRY_TYPE" = "org" ]; then
      ORG=$(jq -r '.registry.org' .github/macf-config.json)
      REGISTRY_PATH="orgs/$ORG"
    elif [ "$REGISTRY_TYPE" = "profile" ]; then
      USER=$(jq -r '.registry.user' .github/macf-config.json)
      REGISTRY_PATH="repos/$USER/$USER"
    else
      OWNER=$(jq -r '.registry.owner' .github/macf-config.json)
      REPO=$(jq -r '.registry.repo' .github/macf-config.json)
      REGISTRY_PATH="repos/$OWNER/$REPO"
    fi
    echo "project=$PROJECT" >> "$GITHUB_OUTPUT"
    echo "registry_path=$REGISTRY_PATH" >> "$GITHUB_OUTPUT"

- name: Setup mTLS certs
  env:
    PROJECT: ${{ steps.config.outputs.project }}
  run: |
    echo "$(gh api ${{ steps.config.outputs.registry_path }}/actions/variables/${PROJECT}_CA_CERT --jq '.value')" > /tmp/ca-cert.pem
    echo "${{ secrets.MACF_ROUTER_CERT }}" > /tmp/router-cert.pem
    echo "${{ secrets.MACF_ROUTER_KEY }}" > /tmp/router-key.pem

- name: Find agent
  env:
    LABEL: ${{ github.event.label.name }}
    PROJECT: ${{ steps.config.outputs.project }}
    REGISTRY_PATH: ${{ steps.config.outputs.registry_path }}
  run: |
    VAR_NAME="${PROJECT}_AGENT_${LABEL//-/_}"
    AGENT_INFO=$(gh api "$REGISTRY_PATH/actions/variables/$VAR_NAME" --jq '.value')
    HOST=$(echo "$AGENT_INFO" | jq -r '.host')
    PORT=$(echo "$AGENT_INFO" | jq -r '.port')

- name: Route to agent
  env:
    ISSUE_NUMBER: ${{ github.event.issue.number }}
    ISSUE_TITLE: ${{ github.event.issue.title }}
  run: |
    if curl --cert /tmp/router-cert.pem --key /tmp/router-key.pem \
      --cacert /tmp/ca-cert.pem --connect-timeout 10 \
      -X POST "https://${HOST}:${PORT}/notify" \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"issue_routed\",\"issue_number\":$ISSUE_NUMBER}" 2>/dev/null; then
      echo "Routed issue #${ISSUE_NUMBER} to ${LABEL}"
    else
      echo "Agent ${LABEL} is offline"
      gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPOSITORY" --add-label "agent-offline"
    fi
```

## Tests

- Action YAML validation
- Mock: curl to channel endpoint succeeds → no offline label
- Mock: curl to channel endpoint fails → offline label added
- Registry discovery: correct variable name construction from label + config
- Route-by-mention: same pattern but extracts @mentions from comment body
