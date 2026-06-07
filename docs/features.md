# Features (v0.2.35)

Per-component reference: what each piece is, what it does, when you'd use it. Current as of **v0.2.35** (latest npm release, 2026-06-05). Some sub-sections still cite the version a feature *landed* in ("added in v0.2.9") — those are accurate history; the inventory reflects current behavior. For the full delta since v0.2.9 (A2A surface, version-aware collision takeover, close-keyword + turn-receipt routing hooks, channel-server version-pinning at `init`, routing-reliability hardening), see `CHANGELOG.md`.

## CLI surface

The `macf` binary ships via `@groundnuty/macf` on npm. After `npm install -g @groundnuty/macf`, the following subcommands are available:

| Subcommand | Purpose | When to use |
|---|---|---|
| `macf init` | Set up an agent workspace (`.macf/`, claude.sh, certs, plugin) | One-time per agent on bootstrap |
| `macf update` | Refresh pinned versions + rules/scripts/plugin assets | Per release; or to pull latest canonical content |
| `macf repo-init` | Bootstrap a coordination repo (`.github/agent-config.json`, routing workflow, labels) | One-time per project |
| `macf doctor` | Verify bot token permissions + sandbox config + workspace permissions | After bootstrap; whenever routing breaks for a permission-shaped reason |
| `macf rules refresh` | Distribute canonical rules/scripts into non-init'd workspaces | Substrate workspaces (per [DR-022 Amendment](../design/decisions/DR-022-channel-server-npm-npx.md) for substrate-permanent-Stage-2 directive) |
| `macf self-update` | Pull `origin/main` + rebuild `dist/` (npm-link dev installs only) | Dev cycle when working on the CLI source |
| `macf certs init` | Create the project CA (one-time, interactive passphrase) | One-time per project |
| `macf certs rotate` | Rotate an agent's mTLS cert | After cert expiry; on key compromise |
| `macf certs recover` | Recover the CA from backup if private key is lost | Disaster recovery |
| `macf status` | Agent registration + peer health summary | Operational health-check |
| `macf peers` | Table of registered peers with mTLS ping | Verify cross-agent reachability |
| `macf cd` | Print the workspace dir for a registered agent (shell-eval'd) | Operator quick-jumps |
| `macf list` | List all registered agents in this project | Operational |

`macf-plugin-cli` is a sibling binary (not user-facing) — invoked by the plugin's slash commands. Surface: `status / peers / ping / issues`.

### `macf doctor` — three-section report (v0.2.9)

```bash
macf doctor
```

Three independent check sections, each with its own status:

1. **DR-019 App permissions** — verifies the workspace's bot token satisfies the 7 required permissions (metadata, contents, issues, pull_requests, actions_variables, workflows, actions). Hard fail (exit 1) on missing/insufficient.
2. **Sandbox filesystem (macf#200)** — verifies `.claude/settings.json` `sandbox.filesystem.allowRead` contains `/proc/self/fd`. Without this pattern, every Bash tool call fails with `permission denied: /proc/self/fd/3`. Hard fail on absence.
3. **Workspace permissions (macf#296 / #305 / #306)** — reads merged view of `.claude/settings.json` + `.claude/settings.local.json` `permissions.allow` per Claude Code's canonical merge semantics (arrays union, scalars replace). Warns on Write/Edit absence. Three severity classes: BLOCK (Write absent + no Bash fallback — autonomous file ops impossible), WARN (degraded autonomy via Bash fallback), INFO (deny rule present — likely deliberate). **Warn-only**: doctor exit code unchanged by this section. Operators can have deliberate restrictions.

The merge-view fix (PR #306, v0.2.9) closed a false-positive WARN trap: pre-fix the doctor read only `settings.json`, missing operator-canonical Write/Edit placement in `settings.local.json`.

## Plugin (`macf-agent`)

Distributed via [`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace) at version pinned by `macf init`. Loaded by Claude Code via `claude --plugin-dir <workspace>/.macf/plugin`. Manifest at `.claude-plugin/plugin.json`.

### 5 skills (slash commands)

| Skill | What it does |
|---|---|
| `/macf-status` | Workspace + cert state — registered agent, channel-server health, key fingerprints |
| `/macf-peers` | mTLS peer-health table — list of registered peers with reachability + cert info |
| `/macf-ping` | Round-trip mTLS test — POST `/health` against a named peer; report latency + cert chain |
| `/macf-issues` | Pending-work queue — open issues tagged for this agent, with `agent-offline` highlighted |
| `/macf-notify-peer` | Send a peer notification (operator-driven cross-agent messaging). Wraps the `notify_peer` MCP tool with one-line minimal output by default — minimizes context-token consumption per macf#350. |

Pre-approved in `.claude/settings.json` per `installPluginSkillPermissions` so first-invocation doesn't fire an interactive permission prompt. Implementation: `packages/macf/src/plugin/`. Backing CLI: `macf-plugin-cli` binary.

`/macf-notify-peer` is the operator-driven counterpart to the autonomous Stop-hook `notify_peer` invocation. The receiver discriminates wake-on-receipt by `event` type alone (macf#355): `event: 'custom'` (the slash-command's default) wakes the receiver TUI; autonomous events (`session-end` / `turn-complete` / `error` from Stop-hook flows) are observational-only (Pattern E preserves cross-agent Stop-hook loop prevention). The slash-command emits a one-line confirmation (`→ <peer> [<event>] delivered=<bool>`); use `--verbose` to opt into the full JSON result for debugging.

### 7 agent identity templates

In `plugin/agents/`, distributed to consumer workspaces. Three permanent identities (`code-agent`, `science-agent`, `writing-agent`) + four experimental (`exp-architect`, `exp-reviewer`, `exp-implementer`, `exp-debugger`). Each defines:

- The agent's role + scope
- Tools it can/can't invoke
- Coordination primitives (when to file vs implement vs review)
- Cross-references to canonical rules

Agent identities are session-loaded; an agent reads its own identity at session start.

### Hooks

#### SessionStart hook

Fires when a Claude Code session starts. Outputs a brief project-state summary: pending work in the agent's queue, in-flight PRs, last-merged-commit. Per [DR-023](../design/decisions/DR-023-stage3-hook-mcp-tool-architecture.md) UC-3 + UC-4.

#### Stop hook (notify_peer)

Fires when a session ends (TUI turn-end, not session-exit). Per [DR-023 UC-1](../design/decisions/DR-023-stage3-hook-mcp-tool-architecture.md): on Stop, the agent's channel server invokes the `notify_peer` MCP tool with `{type: "peer_notification", event: "session-end", agent_name}`. Peer agents observe (Pattern E: observational-only delivery — they don't wake from peer_notification, just record). Used for cross-agent activity tracking + observability events.

#### PreToolUse hooks (Path-2 structural enforcement)

Three bash command-type hooks distributed to every workspace's `.claude/scripts/` and registered in `.claude/settings.json`:

| Hook | Blocks | Override |
|---|---|---|
| `check-gh-token.sh` ([macf#140](https://github.com/groundnuty/macf/issues/140)) | `gh` / `git push` invocations when `GH_TOKEN` lacks `ghs_` prefix (attribution-trap defense; catches `sudo gh`, `bash -c "gh ..."`, `GH_TOKEN=x gh`, etc.) | `MACF_SKIP_TOKEN_CHECK=1` |
| `check-mention-routing.sh` Check B ([macf#272](https://github.com/groundnuty/macf/issues/272)) | `gh issue/pr comment` / `gh issue/pr close --comment` invocations whose `--body` contains raw `@<bot>[bot]` in describing-context (mid-line, not backticked) | `MACF_SKIP_MENTION_CHECK=1` |
| `check-mention-routing.sh` Check A ([macf#244](https://github.com/groundnuty/macf/issues/244), v0.2.9) | `gh issue/pr comment` invocations whose `--body` contains zero routing-active `@<bot>[bot]` mentions (must-have-mention; bypassed for `gh (issue|pr) close --comment` self-close) | `MACF_SKIP_MENTION_CHECK=1` |

Same script (`check-mention-routing.sh`) runs both checks; one override knob covers both. Heuristic per `mention-routing-hygiene.md` §7: backticked → routing-suppressed; line-start (after whitespace/blockquote/list-marker) → addressing form (allowed); mid-line raw → describing-leak (Check B BLOCK); zero routing-active → no recipient (Check A BLOCK). Pattern broadened in v0.2.9 ([macf#276](https://github.com/groundnuty/macf/issues/276)) from `@macf-*-agent[bot]` to `@<any-handle>[bot]` so CV-fleet (`@cv-architect`, `@academic-resume-author`) and third-party bots (`@dependabot`, `@github-actions`) are covered.

## Channel server

`@groundnuty/macf-channel-server` on npm. HTTPS server with mTLS, run as an MCP stdio child by the plugin. Specs: [P1](../design/phases/P1-channel-server.md), [DR-002](../design/decisions/DR-002-channel-per-agent.md), [DR-015](../design/decisions/DR-015-http-endpoints.md), [DR-022](../design/decisions/DR-022-channel-server-npm-npx.md).

### HTTP endpoints

| Endpoint | Purpose |
|---|---|
| `POST /notify` | Inbound coordination event (issue/PR/comment routing). mTLS-required. Schema: `NotifyPayloadSchema` (Zod) per [DR-023](../design/decisions/DR-023-stage3-hook-mcp-tool-architecture.md). Handler chain: schema-validate → format → trace-emit → tmux-wake (or Pattern E observe-only). |
| `GET /health` | Liveness check + cert info echo. Used by `macf peers` for mTLS health-table. |
| `POST /sign` | Cert signing request (challenge-response). Spec: [DR-010](../design/decisions/DR-010-cert-signing.md), security fix [macf#87](https://github.com/groundnuty/macf/issues/87). |

### NotifyType variants

The `/notify` payload's `type` discriminator selects the handler. Defined in `@groundnuty/macf-core:types.ts` as a Zod enum:

| Type | Producer | Recipient action |
|---|---|---|
| `issue_routed` | `route-by-config` / `route-by-label` | Wake; pick up the issue |
| `comment_mention` | `route-by-mention` | Wake; respond to addressing |
| `ci_completion` | `route-by-ci-completion` | Wake; check the PR's CI rollup |
| `pr_review_state` ([macf-actions#39](https://github.com/groundnuty/macf-actions/issues/39), v3.3.0) | `route-by-pr-review-state` (fires on `pull_request_review.submitted`) | Wake; merge or fix per `state in {approved, changes_requested}` |
| `peer_notification` | Stop hook (`notify_peer` MCP tool, DR-023 UC-1) | **Pattern E: observe-only — do NOT wake.** Cross-agent activity signal |

The `peer_notification` Pattern-E asymmetry is structurally important — without it, every Stop hook firing would wake every peer and produce a cross-agent infinite loop. See [troubleshooting.md § cross-agent infinite loops](troubleshooting.md).

### MCP tools

The channel server registers MCP tools that the local agent can invoke from prompts. Per [DR-023](../design/decisions/DR-023-stage3-hook-mcp-tool-architecture.md):

| Tool | Purpose | Use case |
|---|---|---|
| `notify_peer` | Send a `peer_notification` to all peers (or a named peer) | Stop hook (UC-1: session-end signal) |
| `list_peers` | Returns registered peers + their reachability | Skill backing for `/macf-peers` |

### OTel instrumentation (DR-021)

Channel server bootstraps OpenTelemetry on session start when `OTEL_EXPORTER_OTLP_ENDPOINT` is set:

- **Tracer provider** — global; emits spans for every `/notify`, `/sign`, peer ping. Operation names align with GenAI semconv (`invoke_agent`, `handoff`, `peer_notify`).
- **Meter provider** — global; counters `macf_notify_received_total`, `macf_notify_peer_total` with labels `{macf_agent, type, event, delivered}`. Aggregation temporality is **DELTA** as of v0.2.9 ([macf#281 Phase 2](https://github.com/groundnuty/macf/issues/281)) — process restarts don't corrupt the cumulative trajectory in Prometheus storage.

Opt-out: unset `OTEL_EXPORTER_OTLP_ENDPOINT`. Spec: [DR-021](../design/decisions/DR-021-otel-instrumentation.md).

## Routing-Action workflow

[`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions). Reusable GitHub Actions workflow consumed by every coordination repo:

```yaml
# In <consumer-repo>/.github/workflows/agent-router.yml
on: [issues, issue_comment, pull_request, pull_request_review, check_suite]
jobs:
  router:
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3
```

Pinned at major tag (`@v3`) for routing; v3.3.0 latest as of 2026-04-30.

### Five route-by-* jobs

Each job filters the inbound event + dispatches to the recipient agent's channel server:

| Job | Filter | Trigger |
|---|---|---|
| `route-by-config` | Issue/PR with assignee-label matching `agent-config.json:agents[*].label` | Issue/PR creation, label apply |
| `route-by-label` | Existing issue/PR getting label changed | Label add/remove |
| `route-by-mention` | `@<bot-handle>[bot]` pattern in body (per `mention-routing-hygiene.md` §1-6) | Comment posted |
| `route-by-ci-completion` | `check_suite.completed` rolled-up status | All required checks finished |
| `route-by-pr-review-state` ([macf-actions#39](https://github.com/groundnuty/macf-actions/issues/39), v3.3.0+) | `pull_request_review.submitted` with state in `{approved, changes_requested}` | Reviewer used `gh pr review --approve` (not `gh pr comment`) |

The `route-by-pr-review-state` job is the structural defense for the LGTM→merge handoff (Path-2 promotion of `pr-discipline.md` formal-review-submission requirement). Empirical witness: cv-e2e-test rehearsal #11b/#12b/#13b — pre-fix had **zero** `pull_request_review` events firing because agents communicated approval via `gh pr comment`; post-fix the structural defense engages on every formal review submission.

### Address resolution

Each job resolves the recipient agent's address by looking up the registry variable:

```bash
gh api repos/<owner>/<registry-repo>/actions/variables/MACF_<PROJECT_UPPER>_AGENT_<NAME_UPPER> --jq '.value'
# Returns JSON: {"host": "<tailscale-ip>", "port": <port>, "type": "permanent", "instance_id": "...", "started": "..."}
```

Then fires:

```bash
curl -X POST "https://${HOST}:${PORT}/notify" \
  --cert "$AGENT_CERT" --key "$AGENT_KEY" \
  --cacert "$CA_CERT" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD"
```

Recipient channel server's mTLS validation rejects any client cert not signed by the project CA.

### Failure modes (Pattern A applied)

The routing-Action's HTTP 200 from the channel server is the result-invariant assertion that the prompt was successfully injected into the recipient TUI. If the channel server is unreachable, the routing-Action adds the `agent-offline` label per [macf#140](https://github.com/groundnuty/macf/issues/140) defensive routing. No silent-fallback to SSH (Stage 2 path is gone from active code per [macf#257 P6 finding](https://github.com/groundnuty/macf/issues/257)).

## Coordination rules (canonical Markdown)

13 canonical rules in `packages/macf/plugin/rules/`, distributed to every consumer workspace by `macf init` and refreshed by `macf update`. Operational discipline; agents read them session-loaded.

| Rule | Scope |
|---|---|
| `coordination.md` | Cross-cutting: issue lifecycle, communication, escalation, peer dynamic, token & git hygiene, tmux-send pattern, when to read/modify rules |
| `pr-discipline.md` | PR-as-merge-checkpoint default; narrow exceptions; PR anatomy; review loop; **formal-review-submission requirement** ([macf#297](https://github.com/groundnuty/macf/pull/297) v0.2.8) |
| `mention-routing-hygiene.md` | Routing-active vs routing-suppressed mentions (backticks distinguish); §7 structural enforcement (Check A + Check B PreToolUse hooks); broadened HANDLE_PATTERN per [macf#276](https://github.com/groundnuty/macf/issues/276) |
| `silent-fallback-hazards.md` | Eight catalogued hazard instances + five defense patterns (A-E); generative framing for new instances; canonicalized via [macf#294](https://github.com/groundnuty/macf/pull/294) |
| `delegation-template.md` | When to delegate vs do-it-yourself; 6-section issue template; ask-before-filing convention |
| `peer-dynamic.md` | Push-back, ask-clarifying, defend-with-reasoning, accept-valid-feedback, research-before-implementing |
| `verify-before-claim.md` | Three-cut verification: at every hop; before citing peer evidence; on degenerate inputs. Sister to `mention-routing-hygiene.md` for inline-quoting |
| `gh-token-attribution-traps.md` | Class catalog of attribution-trap recurrences; cross-references the structural defense (`check-gh-token.sh`) |
| `model-era-compatibility.md` | Conventions for cross-version Claude Code agent interop |
| `observability-wiring.md` | Where OTel + tracing + metrics are wired; conventions for new observability instruments |
| `check-before-propose.md` | When researching: cite primary sources; verify via tool calls before drafting |
| `codify-at-correction-time.md` | When discipline gets corrected mid-flow, codify the rule before continuing — prevents recurrence drift |
| `execute-on-directive.md` | When operator gives a directive (e.g., "merge whenever convenient"), execute promptly without re-confirming |

The `coordination.md` file is the most-cited; it's the single source of truth for cross-cutting rules. Agents read it session-loaded and on `macf rules refresh`.

### Recent canonicalizations (v0.2.9)

- `pr-discipline.md` formal-review-submission requirement ([#297](https://github.com/groundnuty/macf/pull/297)) — agents must use `gh pr review --approve` for LGTM (not `gh pr comment`); engages the `route-by-pr-review-state` Path-2 defense
- `silent-fallback-hazards.md` canonicalization ([#294](https://github.com/groundnuty/macf/pull/294)) — 8-instance hazard class + Pattern A-E defenses
- `coordination.md §Issue Lifecycle 1` Inversion warning ([#304](https://github.com/groundnuty/macf/pull/304)) — closure-direction independence from fix-authorship; 4-case enumeration for `{filed, implemented} × {self, peer}`
- `mention-routing-hygiene.md` §7 broadened scope ([#301](https://github.com/groundnuty/macf/pull/301)) — fleet-agnostic HANDLE_PATTERN
- `mention-routing-hygiene.md` §7 4-space-indent mechanism clarification ([#299](https://github.com/groundnuty/macf/pull/299)) — addressing-allowance vs code-block-recognition

## Helper scripts

Distributed to `.claude/scripts/` by `macf init`/`update`/`rules refresh`:

| Script | Purpose |
|---|---|
| `macf-gh-token.sh` | Fail-loud GitHub App installation token generator. Validates `ghs_` prefix; emits diagnostics on failure (clock drift, missing key, wrong App ID). Replaces the bare-`gh token generate` pattern that produced silent attribution traps |
| `macf-whoami.sh` | Identity/attribution check. Resolves the current `GH_TOKEN`'s actor login. Exit non-zero + warning if a user token (`ghp_*`, `gho_*`, `ghu_*`) is detected — surfaces the attribution trap |
| `tmux-send-to-claude.sh` | Canonical tmux-submit pattern with the 1-second sleep between Enters that the Claude Code TUI's multi-line-input mode requires |
| `check-gh-token.sh` | PreToolUse hook (Path-2: gh-token attribution-trap defense). See § PreToolUse hooks above |
| `check-mention-routing.sh` | PreToolUse hook (Path-2: must-not-leak + must-have-mention). See § PreToolUse hooks above |
| `write-build-info.mjs` | Postbuild step stamping `dist/.build-info.json` for stale-dist detection ([macf#144](https://github.com/groundnuty/macf/issues/144)) |

## Distribution pipeline

Consumer workspaces converge on canonical content via three channels:

| Asset | Distribution | Trigger |
|---|---|---|
| `macf` CLI binary | `npm install -g @groundnuty/macf` (or `npx -y @groundnuty/macf@latest <subcmd>`) | Operator-driven; semver-pinned |
| `macf-agent` plugin | `groundnuty/macf-marketplace@v<version>` cloned to `.macf/plugin/` | `macf init` (initial) or `macf update --plugin` (refresh) |
| Routing workflow | `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3` | GitHub Actions resolves the tag at workflow-fire time |
| Coordination rules + scripts | Bundled in CLI npm tarball; copied by `macf init` / `update` / `rules refresh` | CLI version determines which rules ship; `macf update --plugin` re-fetches plugin assets |

Trade-off: rule changes require a CLI npm release to reach consumers (substrate-canonicalization-distribution gap; see [concepts.md](concepts.md)). For substrate workspaces, the gap is closed by manual `cp` from canonical to substrate `.claude/rules/` post-merge.

## Cross-references

- [glossary.md](glossary.md) — term definitions
- [concepts.md](concepts.md) — architecture + design rationale
- [quickstart.md](quickstart.md) — hands-on tutorial using the features above
- [troubleshooting.md](troubleshooting.md) — when things break + how to fix
- [`CHANGELOG.md`](../CHANGELOG.md) — per-release notes (Keep-a-Changelog format)
- [`design/decisions/`](../design/decisions/) — 23 DRs grounding each feature
