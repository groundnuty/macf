# P6: Action Update — Reusable Workflow + Versioned Distribution

**Goal:** Extract the routing Action into a centrally-maintained, versioned reusable workflow. Swap SSH+tmux delivery for mTLS HTTP POST. Establish versioned distribution as the single source of truth for MACF infra.

**Depends on:** P1 (channel endpoint), P2 (registry discovery), P3 (mTLS certs), P4 (CLI)
**Design decisions:** DR-003, DR-005, DR-006, DR-017

---

## Scope Change (2026-04-15)

**Original scope:** Swap SSH+tmux → mTLS POST inside the existing per-repo Action YAML.

**Expanded scope:** Extract the Action to a central `groundnuty/macf-actions` repo as a **versioned reusable workflow**. Consumers reference it via `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v1` instead of copying 150 lines of YAML. Add CLI commands to bootstrap repos with version pins.

**Why:** Single source of truth. When we swap SSH→mTLS or add a feature, consumers bump `@v1` → `@v2` instead of copy-paste-merge-conflict across N repos.

---

## Deliverables

### 1. `groundnuty/macf-actions` repo (new)

```
macf-actions/
  .github/
    workflows/
      agent-router.yml          ← reusable workflow (callable)
  actions/
    (optional composite actions if we extract parts)
  README.md                      ← versioning policy, usage
  CHANGELOG.md                   ← semver changelog
```

Initial release: `v1.0.0` + floating `v1.0` + floating `v1` — matches current `agent-router.yml` on `groundnuty/macf` (SSH+tmux). This locks in the current behavior as `v1.x` so consumers can migrate without breaking changes.

Future release: `v2.0.0` + `v2.0` + `v2` — mTLS HTTP POST variant (the original P6 functionality).

### 2. Versioning scheme

Floating major tags + immutable semver tags (standard GitHub Actions convention):

| Tag | Moves? | Used by |
|---|---|---|
| `v1.0.0` | Immutable | Production (max stability) |
| `v1.0` | Floats to latest `v1.0.x` | Production (patches only) |
| `v1` | Floats to latest `v1.x.x` | Typical (auto-update within major) |

Breaking changes = new major (`v2`). Older majors remain live with backported patches.

### 3. Consumer workflow (5 lines instead of 150)

```yaml
# academic-resume/.github/workflows/agent-router.yml
name: Agent Router
on:
  issues: { types: [labeled, closed] }
  issue_comment: { types: [created] }
  pull_request: { types: [opened] }
  pull_request_review: { types: [submitted] }
jobs:
  route:
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v1
    secrets: inherit
```

### 4. Per-repo config stays local

`.github/agent-config.json` stays in the consumer repo (it's per-repo specific — agent names, hosts, sessions). The reusable workflow reads it from the calling repo via `actions/checkout`.

### 5. CLI additions (extends P4)

- **`macf repo-init`** — generates `.github/workflows/agent-router.yml` caller + `.github/agent-config.json` + creates labels + prompts for repo secrets
- **`macf init`** — writes version pins to `macf-agent.json` (new `versions` section)
- **`macf update`** — interactive version bump for pinned components

### 6. Version pinning in `macf-agent.json`

```json
{
  "project": "macf",
  "agent_name": "code-agent",
  "versions": {
    "cli": "0.1.0",
    "plugin": "0.1.0",
    "actions": "v1"
  },
  ...
}
```

`macf update` reads available versions (npm for CLI, GitHub Releases for plugin/actions) and prompts which to bump.

---

## Dependency Relationships

```
┌─────────────────────────────────────────────────────┐
│ groundnuty/macf-actions                             │
│  .github/workflows/agent-router.yml                 │
│  tags: v1.0.0, v1.0, v1 (SSH+tmux — current)        │
│  tags: v2.0.0, v2.0, v2 (mTLS POST — future)        │
└─────────────────────────────────────────────────────┘
            ▲                     ▲
            │ uses: ...@v1        │ uses: ...@v1
            │                     │
┌───────────┴─────────┐   ┌───────┴────────────┐
│ groundnuty/macf     │   │ groundnuty/        │
│ (framework repo)    │   │   academic-resume  │
│                     │   │ (testing ground)   │
│ 5-line caller       │   │ 5-line caller      │
└─────────────────────┘   └────────────────────┘
```

The reusable workflow is **callable across repositories**. Consumers reference it by Git ref (`@v1`). GitHub downloads the workflow definition at run time.

---

## What Changes (Original Scope Retained)

| Component | Before (SSH) | After v2 (mTLS) |
|---|---|---|
| Network setup | Tailscale + SSH key | Tailscale + mTLS cert |
| Agent discovery | Read `agent-config.json` | Read `{PROJECT}_AGENT_*` from registry |
| Message delivery | `ssh ... tmux send-keys` | `curl --cert ... POST /notify` |
| Offline detection | SSH failure | HTTP POST timeout |
| Secrets needed | SSH key, TS OAuth | Router cert+key, TS OAuth, CA cert |

---

## Action Secrets/Variables for v2 (mTLS)

| Name | Type | Source | Purpose |
|---|---|---|---|
| `TS_OAUTH_CLIENT_ID` | Secret | Tailscale | VPN access |
| `TS_OAUTH_SECRET` | Secret | Tailscale | VPN access |
| `MACF_ROUTER_CERT` | Secret | P3 cert generation | mTLS client cert |
| `MACF_ROUTER_KEY` | Secret | P3 cert generation | mTLS client key |
| `{PROJECT}_CA_CERT` | Variable | P3 CA init | mTLS CA verification |
| `PROJECT_TOKEN` | Secret | GitHub PAT | Board sync (if Projects used) |

---

## Migration Strategy

1. **Phase A (v1 extraction)**: `macf-actions` is created, `v1` matches current SSH+tmux behavior exactly. `groundnuty/academic-resume` migrates to the 5-line caller form, references `@v1`. This is the testing ground — validates the reusable workflow mechanism works.
2. **Phase B (CLI additions)**: `macf repo-init` command generates the 5-line caller. `macf init` writes version pins. `macf update` bumps them.
3. **Phase C (v2 mTLS variant)**: Build the mTLS POST variant as `v2`. Requires consumers have mTLS certs provisioned (P3). Consumers opt-in by bumping `@v1` → `@v2`.
4. **Phase D (defer)**: Migrate `groundnuty/macf` itself to the reusable workflow. Deferred — don't want to break the macf routing while iterating on the testing ground.

---

## PR Breakdown

| # | Title | Repo | Depends on |
|---|---|---|---|
| 1 | Create macf-actions + v1 reusable workflow | `macf-actions` (new) | — |
| 2 | Migrate academic-resume to `@v1` | `academic-resume` | #1 |
| 3 | `macf repo-init` command | `macf` | #1 |
| 4 | Version pinning in `macf init` | `macf` | #1 |
| 5 | `macf update` command | `macf` | #4 |
| 6 | mTLS v2 routing variant | `macf-actions` | #1 + P1-P3 (done) |
| 7 | (deferred) Migrate `macf` itself to `@v1` | `macf` | #1, #6 |

---

## Tests

- v1 reusable workflow: consumer workflow validates and runs on a test repo
- v1 behavior: label routing, mention routing, cleanup all work identically to current copy-pasted Action
- v2 behavior (when built): mTLS POST succeeds → no offline label; POST fails → offline label added
- Version pinning: `macf init` writes correct pins; `macf update` bumps correctly
- `macf repo-init`: generates valid 5-line caller, creates labels, prompts for secrets

---

## Out of Scope

- Migrating `groundnuty/macf` itself to the reusable workflow (Phase D, deferred)
- Distributing composite actions separately (may emerge organically)
- Marketplace listing (may add later for discoverability)
