# MACF consumer onboarding

**Status:** Active runbook for new MACF-consumer projects
**Audience:** Operators bootstrapping a NEW MACF-consumer project (CV agents, future macf-init'd workspaces). **Substrate workspaces (`groundnuty/macf-science-agent`, `groundnuty/macf` — code-agent, `groundnuty/macf-devops-toolkit` — devops-agent) are out of scope per operator directive 2026-04-27 — substrate never runs `macf init`.**
**History:** Originally drafted as `stage2-to-stage3-migration.md` (PR #264, `macf#257` Phase A) for substrate migration. Reshaped per `macf#273` after the substrate-permanent-Stage-2 directive made the migration framing obsolete; consumer onboarding is the actual reusable surface.

This document is what an operator (or the consumer agent itself, picking up the directive) reads to bootstrap a new MACF-consumer project against Stage 3 routing infrastructure (mTLS HTTP-POST `/notify` against per-agent channel servers).

For a hands-on tutorial walking through the bootstrap path step-by-step (with concrete time budgets per step), see [`docs/quickstart.md`](../docs/quickstart.md). This document is the **reference runbook** (more detail per step + decommission + rollback paths); `quickstart.md` is the **tutorial** (linear, ~30 min, designed for first-time bootstrap).

## What you get

After bootstrap, a consumer agent participates in MACF coordination via:

| Layer | Mechanism |
|---|---|
| **Routing transport** | `curl -X POST https://<host>:<port>/notify` (mTLS) — sender's `agent-router.yml` workflow → receiver's channel-server `/notify` endpoint → recipient TUI wake |
| **Address resolution** | `MACF_<PROJECT>_AGENT_<NAME>` GitHub Variables registry entry, populated by the channel server on session start |
| **Failure detection** | Pattern A result-invariant assertion: HTTP 200 from channel server confirms recipient acknowledged the byte sequence (no silent-fallback Instance 3 class) |
| **Per-agent runtime** | Canonical `claude.sh` (from `macf init`) invokes `claude --plugin-dir .macf/plugin`; plugin's `mcpServers.macf-agent` spawns the channel server as MCP stdio child |
| **Coordination rules + scripts** | `.claude/rules/coordination.md`, `.claude/scripts/macf-gh-token.sh`, attribution-trap PreToolUse hook, mention-routing-hygiene PreToolUse hook — all distributed by `macf init` and refreshed by `macf update` |

## Requirements

Operator must verify before any consumer agent begins bootstrap:

- [ ] **`groundnuty/macf-actions` workflow is on v3.x** (already shipped — `agent-router.yml` v3 is "registry-driven mTLS transport"; SSH+tmux paths gone from active code per `macf#257` P6 finding). The consumer's project repo must reference it from `.github/workflows/agent-router.yml` via `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3` (or pinned tag).

  > **⚠ Routing-stage carve-out (read before pinning `@v3`).** Stage 3 (`@v3`, mTLS) is the default for a **brand-new, standalone** consumer project. The **established substrate / CV fleet** (`groundnuty/macf`, `macf-science-agent`, `macf-devops-toolkit`, …) runs the **v1.x SSH/tmux routing primitive** (`macf-actions@v1.3.x`, latest **`v1.3.4`**) per the operator directive of 2026-04-27 — and the two stages do **not** interoperate. If you are adding an agent that must coordinate with the existing CV fleet, pin **`@v1.3.4`** to match the fleet's stage; pinning `@v3` would put the new agent on a different transport and it would not route to/from the fleet. Confirm which stage the fleet you're joining is on before running `macf repo-init` (which scaffolds `@v3` by default).
- [ ] **`@groundnuty/macf` CLI** is installable globally — `npm install -g @groundnuty/macf` resolves to current published version (**v0.2.35** as of 2026-06-05). Latest reachable via `npm view @groundnuty/macf version`. The doctor + Path-2 hooks set shipped in v0.2.9; later versions inherit + extend (A2A surface, version-aware collision takeover, close-keyword + turn-receipt routing hooks, channel-server version-pinning at `init` — see `CHANGELOG.md`).
- [ ] **Per-project CA exists** at `~/.macf/certs/<project>/{ca-cert.pem,ca-key.pem}` (create one-time via `macf certs init` from any workspace in the project, with passphrase prompt; uploads CA cert to the project's GitHub Variables for the routing-Action to trust).
- [ ] **Each agent's GitHub App has `actions_variables: write`** on the project's registry repo/org/profile (per DR-019); without it the channel server can't self-register and the routing-Action can't resolve the agent's address. Verify via `macf doctor` post-bootstrap (it surfaces all DR-019 permission gaps + a few hardening checks for `permissions.allow` and `sandbox.filesystem.allowRead`).

## Bootstrap steps

For each new consumer agent (e.g., `cv-architect` on `groundnuty/academic-resume`, `cv-project-archaeologist` on its own repo, future MACF-consumer projects), the operator (or the agent itself, picking up via routing) executes:

### 1. Verify pre-conditions

```bash
# Pre-condition: macf CLI installed
command -v macf || npm install -g @groundnuty/macf

# Pre-condition: project CA exists (create if not — interactive passphrase)
ls ~/.macf/certs/<project>/{ca-cert.pem,ca-key.pem} 2>/dev/null \
  || (cd <existing-workspace> && macf certs init)
```

### 2. Run `macf init`

```bash
macf init \
  --project <project-name> \
  --role <agent-role> \
  --name <agent-app-name> \
  --type permanent \
  --app-id $APP_ID \
  --install-id $INSTALL_ID \
  --key-path .github-app-key.pem \
  --registry-type <repo|org|profile> \
  --registry-repo <owner>/<repo>     # if --registry-type repo
  --advertise-host <127.0.0.1|<tailscale-ip>>  # 127.0.0.1 if all agents on same VM
  --tmux-session <session-name>      # for on-notify wake (DR-020)
  --dir .
```

Required flags (per `packages/macf/src/cli/index.ts`): `--project`, `--role`, `--app-id`, `--install-id`, `--key-path`. Optional flags supply defaults; `--registry-type` defaults to `repo`, `--type` defaults to `permanent`. Cross-reference the live `--help` output for the canonical flag set when the CLI is updated.

Effects of `macf init`:

- Creates `.macf/{certs,logs,plugin}/`
- Generates the agent cert (signed by the project CA from step 1)
- Writes `.macf/macf-agent.json` (single source of truth for agent identity + registry pointer)
- Fetches `groundnuty/macf-marketplace@v<plugin-version>` plugin to `.macf/plugin/`
- Writes canonical `claude.sh` with MACF_* env exports
- Merges the gh-token + mention-routing PreToolUse hooks into `.claude/settings.json` (per `macf#140`, `macf#272`, `macf#244`)
- Pre-approves the 4 macf-agent plugin skills
- Distributes canonical rules to `.claude/rules/`: `coordination.md`, `pr-discipline.md`, `mention-routing-hygiene.md`, `silent-fallback-hazards.md`, `delegation-template.md`, `agent-identity.md`

### 3. Launch the agent's session via `claude.sh`

```bash
./claude.sh
```

The plugin loads; `mcpServers.macf-agent` spawns the channel server as an MCP stdio child; channel server bootstraps OTel (if `OTEL_EXPORTER_OTLP_ENDPOINT` is set), starts HTTPS server on a free port, and self-registers in the project's GitHub Variables.

### 4. Verify channel server is operationally registered

```bash
# Check the registry variable
gh api repos/<owner>/<registry-repo>/actions/variables/MACF_<PROJECT_UPPER>_AGENT_<NAME_UPPER> --jq '{name, value, updated_at}'
```

Expected: `value` is JSON with `host`, `port`, `type: "permanent"`, `instance_id`, `started` timestamp matching this session's start.

```bash
# Check the channel server log
cat .macf/logs/channel.log
```

Expected: `collision_check`, `registered`, `server_started` events at session-start timestamp.

### 5. Verify routing reaches the agent end-to-end

From a peer agent's workspace (or from any tester / coordinator), file an issue tagged for this agent (label = agent's app name without `[bot]` suffix, e.g., `cv-architect`). The routing-Action workflow on the project's repo fires `curl -X POST https://<this-agent-host>:<this-agent-port>/notify` and the prompt arrives in the agent's TUI.

If the routing succeeds (HTTP 200) but the prompt doesn't arrive in the recipient TUI, that's the silent-fallback Instance 3 class — file an issue on `groundnuty/macf-science-agent` to update the hazards catalog.

### 6. Run `macf doctor` (recommended)

```bash
macf doctor
```

Surfaces:
- DR-019 permission gaps on the GitHub App
- Sandbox `/proc/self/fd` allowRead pattern (fixes Bash tool failures per `macf#200`)
- Workspace permissions: `permissions.allow` Write/Edit presence (per `macf#296` / `#305`) — autonomous coordination prerequisite. Reads merged view of `.claude/settings.json` + `.claude/settings.local.json` per Claude Code's canonical merge semantics.

The doctor is warn-only on `permissions.allow` gaps (operator may have deliberate restrictions) but errors on missing DR-019 perms or absent sandbox FD pattern.

## Verification gate

Bootstrap considered complete for a consumer when:

- [ ] `MACF_<PROJECT>_AGENT_<NAME>` registry variable updated within last session-start window
- [ ] `.macf/logs/channel.log` shows `server_started` event for current session
- [ ] One end-to-end routing test from a peer agent confirmed (issue → routing-Action HTTP-POST → channel server `/notify` → recipient TUI wake)
- [ ] `macf doctor` returns exit 0 (no missing DR-019 perms; sandbox FD allowRead present; workspace `permissions.allow` either grants Write/Edit or has explicit operator deny rules)

## Rollback (if bootstrap fails partway)

If `macf init` aborts mid-flow, the channel server fails to register, or the routing test fails:

```bash
# Optionally remove .macf/ to clean up partial state
rm -rf .macf/

# Remove the canonical claude.sh (operator will re-run macf init)
rm claude.sh

# If certs were registered to the registry but the workspace is broken,
# remove the registry variable so a peer doesn't see a stale entry:
gh variable delete MACF_<PROJECT_UPPER>_AGENT_<NAME_UPPER> --repo <owner>/<registry-repo>
```

The `agent-router.yml` v3 workflow gracefully degrades — if a channel server is unreachable, it adds the `agent-offline` label (per `macf#140` defensive routing). So a workspace mid-bootstrap-failure looks "offline" to peers; once the operator diagnoses the failure (typically a missing GitHub App permission, expired install token, or wrong `--advertise-host`), re-running `macf init --dir .` is safe (idempotent — overwrites `claude.sh`, refreshes `.claude/`).

## Decommission (winding down a healthy consumer)

When a consumer project is winding down or a specific agent is being retired:

```bash
# 1. Stop the agent session (so the channel server flushes pending state)
#    Then: stop the claude process for this agent

# 2. Remove the registry variable so peers don't route to a dead address
gh variable delete MACF_<PROJECT_UPPER>_AGENT_<NAME_UPPER> --repo <owner>/<registry-repo>

# 3. (Optional) Revoke the agent's cert from the project CA
#    No central revocation list — re-issuance via macf certs is the canonical path; deletion is local

# 4. Remove the workspace MACF state
rm -rf .macf/ claude.sh

# 5. Remove the routing-action workflow if this is the project's last consumer
rm .github/workflows/agent-router.yml
```

The decommission is reversible — re-running `macf init` per the bootstrap section restores the agent. CV consumer workspaces have done this multiple times during cv-e2e-test rehearsal cycles without operator intervention beyond the standard bootstrap.

## Non-MACF rollback (consumer reverts to a different coordination substrate)

If a project decides to abandon MACF entirely (e.g., switch to a different multi-agent framework or revert to single-agent operation):

1. Decommission each consumer per the section above (stop sessions, remove registry vars, delete `.macf/` + `claude.sh`)
2. Remove `.github/workflows/agent-router.yml` from the project repo
3. Uninstall the GitHub Apps and remove the project CA from `~/.macf/certs/<project>/`
4. Remove the project's `.claude/rules/`, `.claude/scripts/`, and `.claude/settings.json` MACF entries (operator-edit; nothing in MACF mandates the operator removes their own settings, but coordination.md + helper scripts remain dormant otherwise)

There is no automated tooling for switching frameworks — MACF doesn't track consumers' history beyond what's in the workspace. The reverse path is operator-driven.

## Operator role

For each consumer project bootstrap, the operator's role is:

1. **One-time per project**: create the project CA, install the routing-action workflow, ensure the GitHub App's permissions are configured (per DR-019)
2. **Per-consumer**: provide `--app-id`, `--install-id`, `--key-path` to the consumer agent (or the bootstrap script invokes `macf init` directly with these resolved)
3. **Cross-consumer verification**: once two or more consumers are operational, verify cross-agent routing works (file an issue from agent A tagged for agent B; confirm B receives it)

The operator does NOT post-bootstrap-edit the workspace state by default. The agent owns its own runtime; operator owns the project-wide pre-conditions and the verification telemetry.

## Local-registry-mode bootstrap (DR-024)

[DR-024](decisions/DR-024-local-registry-mode.md) ships a fourth registry variant — `local` — for single-host scenarios where the GitHub coupling is the obstacle (solo small projects, education / demos, framework development, air-gapped environments, CI sanity-check fixtures). This section documents the local-mode bootstrap path; the GitHub-mode sections above remain the canonical surface for production multi-operator deployments.

**Read first:** [`docs/use-cases.md` §"When MACF without GitHub makes sense"](../docs/use-cases.md#when-macf-without-github-makes-sense-local-registry-mode) lays out the trust-boundary trade-offs. Local mode is **not** a replacement for GitHub mode — it's a distinct mode for cases where GitHub coupling is the bottleneck. The decision criteria (cross-host, multi-operator visibility, GitHub-driven routing, bot-attribution) all push toward GitHub mode whenever they apply.

### Requirements (local-mode subset)

Operator must verify before bootstrap:

- [ ] **`@groundnuty/macf` CLI v0.2.10 or later** — `npm view @groundnuty/macf version` (the `--local` shorthand + `--migrate-from` flag landed via [PR #329](https://github.com/groundnuty/macf/pull/329))
- [ ] **Single host.** Local mode does not coordinate across hosts. A laptop and a server are different hosts; agents on each cannot find each other through `local` mode.
- [ ] **POSIX filesystem** for cert + registry-file permission enforcement (`0700` on the registry directory, `0600` on the CA key). Windows is best-effort per DR-024 §threat-model — operators on Windows should manually verify ACLs.

You do **not** need: a GitHub App, a coordination repo, the `gh` CLI, the `macf certs init` step (CA auto-generates at `--local` time), or `macf repo-init` (no routing workflow applies).

### Bootstrap steps (per agent)

```bash
macf init \
  --project <project-name> \
  --role <agent-role> \
  --local \
  --advertise-host 127.0.0.1 \
  --tmux-session <session-name> \
  --dir .
```

Optional flags:

- **`--path <abs-path>`** — overrides the default `~/.macf/registry/<project>.json`. Must be absolute and free of shell-unsafe characters (`"`, `$`, backtick, backslash, newline) — validated at init time per DR-024 §File format.
- **`--registry-type local`** — the long form (equivalent to `--local`); both are accepted per macf#322 thread option-2 alias decision.

`--local` short-circuits App-cred validation entirely. The flags `--app-id`, `--install-id`, `--key-path` are skipped — the launcher doesn't mint a token in local mode.

Effects of `macf init --local` (verified against [PR #329](https://github.com/groundnuty/macf/pull/329) diff):

- Creates `~/.macf/registry/` if absent (`0700`)
- On first invocation in a project: generates `<registry-dir>/<project>.ca.crt` (`0644`) + `<registry-dir>/<project>.ca.key` (`0600`)
- On subsequent invocations: reuses the existing CA
- Generates this agent's cert signed against the project CA
- Writes `.macf/macf-agent.json` with `registry: { type: 'local', path: <abs> }`. The `github_app` field is **omitted** in local-mode configs (the schema marks it optional per DR-024)
- Writes a no-GitHub-mode `claude.sh`:
  - No `macf-gh-token.sh` invocation, no `GH_TOKEN` / `APP_ID` / `INSTALL_ID` / `KEY_PATH` exports
  - No `GIT_AUTHOR_NAME` / `GIT_COMMITTER_NAME` (commits land as the local OS user)
  - Exports `MACF_REGISTRY_TYPE="local"` + `MACF_REGISTRY_PATH=<abs>`
  - `MACF_CA_CERT` / `MACF_CA_KEY` point at the registry-co-located CA at `<registry-dir>/<project>.ca.{crt,key}` — **not** under `~/.macf/certs/` (the canonical location for GitHub-mode CAs)
  - A synthetic-identity comment block surfaces the trade-off explicitly

### Channel-server behavior in local mode

Per [PR #329](https://github.com/groundnuty/macf/pull/329) (`packages/macf-channel-server/src/server.ts`):

- Registry dispatch routes through `createRegistryFromConfig`, which the factory routes to `LocalRegistryClient` (per PR-A `8644d75`)
- `varsClient` (GitHub Actions Variables client) construction is skipped — local mode has no GitHub API client
- `/sign` endpoint returns `404` with a diagnostic body pointing at the local-mode trust model (DR-024 §"/sign endpoint disabled in local mode" — discoverable-failure strategy preferred over endpoint-not-registered)
- `/notify` and `/health` are unchanged across all four registry variants — same mTLS handshake, same payload validation, same wake mechanism

### Verification gate (local mode)

Bootstrap is complete for a local-mode consumer when:

- [ ] `~/.macf/registry/<project>.json` (or operator-specified `--path`) contains a `schema_version: 1` envelope and an `agents` map with this agent's `host`/`port`/`instance_id`/`started`
- [ ] `~/.macf/registry/<project>.ca.crt` + `.ca.key` exist with the documented permissions
- [ ] `.macf/logs/channel.log` shows `server_started` event for current session
- [ ] If two or more agents are operational: a peer-to-peer `notify_peer` MCP-tool call from agent A reaches agent B's TUI (mutual `/notify` confirmed)

`macf doctor` is GitHub-mode-only and does not apply in local mode (its DR-019 permission check has nothing to verify).

### Migration: local → GitHub mode

When local mode's limitations become binding (cross-host collaboration, audit trail requirements, GitHub-driven routing, multi-operator visibility), DR-024 §"Migration path" defines a one-shot, one-direction upgrade:

```bash
macf init \
  --project <project-name> \
  --role <agent-role> \
  --registry-type repo \
  --registry-repo <owner>/<repo> \
  --app-id $APP_ID --install-id $INSTALL_ID --key-path .github-app-key.pem \
  --migrate-from ~/.macf/registry/<project>.json
```

Per [PR #329](https://github.com/groundnuty/macf/pull/329) (`packages/macf/src/cli/commands/migrate.ts`):

- `readLocalRegistryFile` validates the source file against `schema_version=1` + `AgentInfoSchema`
- `migrateLocalToGitHub` mints a token from the new agent config, writes each record via `createRegistryFromConfig` against the GitHub-backed registry
- The local CA carries forward as the project CA — operators using the migrated workspace re-prove identity via `/sign` challenge-response in GitHub mode against the same CA

**Combinations rejected:**

- `--migrate-from` + `--local` — local→local is a no-op; rejected with a loud error per DR-024 §"Migration path"
- `MACF_REGISTRY_TYPE=repo` while reading a local-registry file — cross-mode behavior is undefined per DR-024 §"Decision rule for future PRs" 5; CLI fails loudly

Bi-directional sync is explicitly out of scope — operators wanting to switch back to local mode after going GitHub re-init manually with `--registry-type local`.

### Rollback (local mode)

If `macf init --local` aborts mid-flow or the channel-server fails to register:

```bash
# Remove .macf/ to clean up partial state
rm -rf .macf/ claude.sh

# If the CA was generated but the workspace is broken, removing the registry file
# (NOT the CA — other agents in the same project may depend on it) clears the
# agent's record. Re-running `macf init --local` will re-register.
# To remove a stale agent entry without touching peers, edit the JSON directly
# (atomic writers tolerate concurrent edits per DR-024 §"Atomic writes").
```

If the project itself is being decommissioned:

```bash
# Stop all agent sessions
# Then remove the entire registry directory (CA + JSON + per-agent state)
rm -rf ~/.macf/registry/<project>.{json,ca.crt,ca.key}
rm -rf ~/my-project/<agent>/.macf/ ~/my-project/<agent>/claude.sh  # per agent
```

The decommission is reversible — re-running `macf init --local` regenerates everything.

### Cross-references (local mode)

- [DR-024](decisions/DR-024-local-registry-mode.md) — full design, threat model, file format, cert flow, migration, alternatives considered
- [PR #324](https://github.com/groundnuty/macf/pull/324) — PR-A: `LocalRegistryClient` + factory dispatch + types extension
- [PR #329](https://github.com/groundnuty/macf/pull/329) — PR-B: `macf init --local` UX + `claude.sh` no-GitHub-mode template + channel-server local-mode dispatch + migration helper
- [`docs/quickstart.md` §"Quickstart — local-registry mode"](../docs/quickstart.md#quickstart--local-registry-mode-no-github-apps-required) — hands-on tutorial for the bootstrap path
- [`docs/use-cases.md` §"When MACF without GitHub makes sense"](../docs/use-cases.md#when-macf-without-github-makes-sense-local-registry-mode) — when to use local mode vs GitHub mode
- macf#322 — issue tracking the design + implementation work

## Worked example — CV-fleet onboarding (2026-04 timeline)

Empirical reference for the bootstrap path:

1. **`groundnuty/academic-resume`** (`cv-architect` agent) — bootstrap via `macf init`. Channel server registered; cross-routing tested via cv-e2e-test rehearsals #11b, #12b, #13b (10/11 PASS empirically validating route-by-pr-review-state per macf-actions#39). Notable workspace customization: operator-authored `Write` + `Edit` in `.claude/settings.local.json` (per `macf#305` merge-view fix in `macf doctor`).
2. **`groundnuty/cv-project-archaeologist`** — same bootstrap path; sister consumer; cross-routing exercised in research-handoff PR cycles.
3. **Future CV-fleet additions** — same path; differential is project-name + agent-role at `macf init` time.

Reference test bootstrap shape: `groundnuty/macf-testbed:scripts/bootstrap-tester.sh` shows the canonical save/restore-claude.sh pattern for workspaces with custom launchers (testbed agents have a custom `claude.sh` with extra OTel attrs + tmux/sg-docker wrappers; `bootstrap-tester.sh` saves it before `macf init` and re-merges after). Most consumer projects don't need this customization — the canonical `claude.sh` is sufficient.

## Cross-references

- `macf#254` + `#257` — Stage 3 master tracker + Phase A (this doc's original draft)
- `macf#273` — this doc's reshape from substrate-migration framing to consumer-onboarding framing
- `macf#260` — `FALLBACK_VERSIONS.plugin` bump that made `macf init` bootstrap actually work end-to-end
- `macf-testbed#229` — first end-to-end Phase B+C verification of the bootstrap path (testers; same mechanism)
- `macf-testbed:scripts/bootstrap-tester.sh` — reference implementation showing the save/restore-claude.sh pattern
- `groundnuty/macf-actions` v3.x — current routing-Action implementation (Stage 3; consumers reference it via `uses:`)
- `silent-fallback-hazards.md` Instance 3 (in `groundnuty/macf-science-agent`) — the hazard class Stage 3 structurally retires
- `design/decisions/DR-002` (channel-per-agent), `DR-003` (communication-planes), `DR-005` (agent-registration), `DR-007` (port-assignment), `DR-015` (http-endpoints), `DR-019` (App permissions), `DR-020` (notify-wake), `DR-022` (channel-server-npm-npx) — design decisions Stage 3 implements
