# Multi-Agent Coordination Framework (MACF)

## What This Is

A framework for coordinating multiple Claude Code agents via GitHub. Agents communicate through MCP channels (HTTP/mTLS), register via GitHub variables, and coordinate work through Issues/PRs.

## Repository Layout

```
src/
  cli/            ← `macf` CLI (init, update, repo-init, doctor, rules,
                    certs, status, peers, cd, claude-sh, plugin-fetcher)
  certs/          ← CA creation, agent certs, challenge-response for /sign,
                    in-memory challenge-store (DR-010 per #80)
  registry/       ← GitHub Variables registry (repo/org/profile scopes)
  plugin/
    bin/          ← macf-plugin-cli.ts (invoked by skills)
    lib/          ← health ping, peer list, dashboard/table/health-detail
                    formatting, issue queue
  server.ts       ← HTTPS + MCP entrypoint, loaded by claude.sh per DR-013
  https.ts, mcp.ts, health.ts, collision.ts, shutdown.ts, ...
  token.ts        ← GitHub App installation token generation

scripts/          ← shipped with CLI, copied into <workspace>/.claude/scripts/
  macf-gh-token.sh       ← fail-loud token helper (#61)
  macf-whoami.sh         ← identity/attribution check (#61)
  tmux-send-to-claude.sh ← canonical tmux-submit pattern (#56)
  check-gh-token.sh      ← PreToolUse attribution-trap hook (#140)
  write-build-info.mjs   ← postbuild: stamps dist/.build-info.json for stale-dist detection (#144)

templates/
  macf-app-manifest.json ← GitHub App manifest with DR-019 permissions

plugin/
  .claude-plugin/plugin.json  ← manifest
  agents/         ← 7 agent identity templates (3 permanent + 4 exp-*)
  skills/         ← 4 skills (macf-status, macf-peers, macf-ping, macf-issues)
  hooks/hooks.json
  rules/
    coordination.md  ← canonical cross-cutting rules, distributed to
                       every workspace by `macf init` / `macf update` /
                       `macf rules refresh`

design/
  decisions/      ← 24 decision records (DR-001 through DR-024;
                    DR-019 + DR-022 each have post-review amendments)
  phases/         ← 8 implementation phase specs
                    (P1–P7 + P-A2A-phase-2 added 2026-05-19 for the
                    A2A v1.0 inbound JSON-RPC arc per macf#390)
  project-tier-rules.md ← DR-026 F3 (macf#501): the three-tier rule model's
                    PROJECT tier — `.claude/rules/project/*.md`,
                    `MACF_PROJECT_RULES_SOURCE` config, distribution +
                    precedence
research/         ← literature reviews, empirical analysis

test/             ← unit tests (default vitest run) + test/e2e/ (excluded)
```

## Implementation Status

> **Current state (updated 2026-06-16).** `main` HEAD `79d4f50`.
> **Structural-hook workstream COMPLETE** this stretch (all merged): the 4
> PreToolUse hooks were hand-wired into the substrate workbenches (**#488** —
> code-agent was **0/4**; the substrate is rule-based/hand-wired, not a
> `macf init` consumer), and a NEW result-invariant **PostToolUse
> `check-gh-attribution.sh`** hook shipped (**#489/#491**) as the structural
> backstop for **silent-fallback Instance 12**: the #140 PreToolUse hook reads
> the *ambient* `GH_TOKEN` *before* the command, so it's blind to an inline
> `export GH_TOKEN=$(...) && gh` that empties mid-command (a transient 401 +
> no `pipefail` posted as the operator on 2026-06-12); the new hook checks the
> **result** — `gh api`s who actually authored the just-written resource and
> warns LOUD (`exit 2`, fail-open, `MACF_SKIP_ATTRIBUTION_CHECK=1`). **#490**
> codified Instance 12 in `silent-fallback-hazards.md`; **#493** hand-wired the
> new hook to the substrate. **DR-026 (the auditor — self-evolving coordination
> governance) is PROPOSED** (**#495**, awaiting operator sign-off; once Accepted,
> code-agent files the implementation issues). **macf-actions #53 gate-5**
> (self-hosted no-SSH-direct inject, honors #91's low-priv bound) merged →
> **v1.3.6 candidate, HELD for operator go-ahead**; **#42** (Tailscale wall-time
> number) is the only open issue on that line.
>
> **Prior (2026-06-08) record stands below.** `main` is **post-v0.2.36**. The CLI
> v0.2.36 is LIVE on npm (all 3 packages, provenance); it dropped the breaking
> plugin `manifest.hooks` key (the Claude Code ≥2.1.x "/doctor Duplicate hooks"
> fix), and the marketplace plugin was bumped to v0.2.36 in lockstep.
> **Merged-but-unreleased on `main` (→ v0.2.37
> candidate):** the **DR-025 comms-ledger** (#472/#474/#475/#473/#476 — per-agent
> write-ahead `comms-ledger.jsonl` authoritative + Tempo derived index;
> loud-but-proceeds) and the **#444 route-receipt reconciler** (#477/#478
> window-aware truncation; #479/#480 coalesced-turn precision-floor gate via
> sibling-delivery-receipted). **#462** (routing-drop incident) self-closed
> 2026-06-08 — its original benign drop aged out to `drops=0`; #480's
> sibling-delivery-receipted gate now prevents new coalesced false-positives.
> **#481** (C-u-clobber hypothesis) was settled **not-a-bug** by a controlled
> tmux experiment — mid-turn pings *queue* and survive `C-u`, so it's the benign
> `receipt≠distinct-turn` gap (#480 suppresses the symptom).
>
> **Routing transport is two-track** (substrate-permanent-Stage-2 directive, #273):
> new consumer projects + the **CV fleet** → Stage-3 (`macf-actions@v3`, mTLS); the
> **substrate** (macf / science / devops) stays permanent **Stage-2** v1.x SSH/tmux
> (`@v1.3.x`), actively maintained — **not** retiring. macf-actions **v1.3.5**
> (2026-06-08) bundles #47 (router prompt-injection → base64 data-passing, dropping
> the `tr -d "'"` strip) + #42 (Tailscale `sleep`→readiness-poll + action v4.1.2
> SHA-pin) + #49 (self-hosted-runner enablement, inert by default); `@v1.3` / `@v1`
> moved to it. (v1.3.4 was the #45 route-correlation marker, 2026-06-06.) The
> detailed v0.2.35 record below stands as prior-release history.

P1–P7 all implemented. Post-P7 work is bug-fix + security + hardening driven
by issue queue and periodic audits. **v0.2.35 (2026-06-05 release)**: `main` was at v0.2.35
(`3a7b7c6` bump-commit). **LIVE on npm: v0.2.35 across all 3 packages with
provenance attestations** — cut 2026-06-05 via OIDC Trusted Publishers (bump+tag
→ auto-publish, no npm-token step). **v0.2.35 = the post-Phase-5 hardening queue
shipped in one release** — closing the stale-instance / version-skew /
auto-close hazard classes that surfaced during the A2A fleet work:
- **#424** — version-aware collision takeover (a fresh newer instance displaces
  an alive *older* one; missing-version=oldest; `MACF_NO_VERSION_TAKEOVER=1`
  escape; `compareSemver` moved to macf-core). Closes the #422 stale-squat class.
- **#431** — `check-close-keyword.sh` PreToolUse hook (blocks `gh pr create/edit`
  auto-closing another agent's issue; authorship discriminator; `-F`/wrapper
  coverage; `MACF_SKIP_CLOSE_CHECK=1`). Path-2 fix for the 4×-recurring auto-close.
- **#427** — OTEL `gen_ai.agent.name` resource attr (`buildResource` merges
  `OTEL_RESOURCE_ATTRIBUTES` via envDetector). Code shipped; issue OPEN pending
  the live Tempo verify on next CV relaunch (science verifies, code-agent closes).
- **#421** — pin the channel-server version in plugin `mcpServers` args at
  `macf init/update` (bare-npx cache can't serve a stale cs; cs = cli version).
- **#426** — marketplace-is-source for the plugin manifest (vestigial repo
  `plugin.json` → README pointer) + a release-time version-lockstep check in
  `publish.yml` (it PASSED its first run gating the v0.2.35 publish).
- **#416** — Stop-hook latency (skip turn-end `make check` when no
  build-affecting changes).
See `CHANGELOG.md` [0.2.35]. Earlier: v0.2.33 (reliability #419/#423/#425) +
v0.2.34 (A2A Phase 3.5 receiver-delivery #428/#429 + #418 OTEL).

**Phase 5 A2A status: CLOSED.** Full bidirectional A2A v1.0 live + observable on
the real CV fleet. Bug-1 (stale registry-squatter) resolved operationally + now
structurally (#424); Bug-2 (#423 warns); AC-5 export gap fixed (marketplace
v0.2.33 `mcpServers.env` block + #427 resource attrs); receiver-side delivery
verified (#428/#429 — science co-verified Tempo trace + channel.log + TUI). The
`gen_ai.agent.name` resource-attr (#427) is the last observability nicety,
pending its operator-timed Tempo verify on the next CV relaunch to cs 0.2.35.
**Routing**: macf-actions **v1.3.2** (#432, `route-by-pr-review-state` on the v1.x
SSH/tmux primitive — `gh pr review --approve` notifies the PR author; AC-6 proven)
then **v1.3.3** (#437 causes 2/3 — liveness-probe hardening across all four
route-by-* blocks: split has-session/helper probes, retry, classify
alive/absent/unknown, attempt-on-ambiguity, + the `set -e`/`|| true` blocker fix).
**All 3 callers (macf/testbed/devops-toolkit) pin @v1.3.3** + carry `workspace_dir`
in agent-config.json. **#437 routing-reliability CLOSED** (the missed-ping bug):
cause-1 `workspace_dir`→helper (#443/#268/#81) + cause-2/3 v1.3.3 probe-hardening;
busy-session co-verify PASS (`via helper … session=alive` on a live mid-turn ping);
cause-3 structural receipt-close → #444. **#368 A2A master umbrella CLOSED** (A2A
v1.0 complete + live-verified). silent-fallback Instance 10 documents the
send≠receipt last-mile gap.

The post-Phase-5 hardening queue is CLEARED. **Open issues:** #427
(gen_ai.agent.name — code shipped in v0.2.35; AC-3 live Tempo verify OPERATOR-TIMED:
CV `macf update` → cs 0.2.35 → science verifies → code-agent closes), #444
(receipt-observable substrate routing — structural, backlog), #439 (register
CAS/If-Match TOCTOU — backlog), #418 (claude-sh telemetry — devops), #224
(NPM_TOKEN rotation). 24 DRs, 9 phase specs, 13 canonical rules, 16 research notes.

**A2A integration arc** (master tracking #368): **full bidirectional v1.0
surface LIVE on npm via v0.2.32**:
- Phase 0 (#369, v0.2.23 — OTel `invoke_agent` span rename) ✓
- Phase 1 (#370, v0.2.24 — `/.well-known/agent-card.json` discovery) ✓
- `/sign` Path 2 (#371, v0.2.26 — `/macf/sign` namespace) ✓
- **Phase 2a (#391/#390, v0.2.32 — inbound JSON-RPC `message/send` at
  `/a2a/v1` + task lifecycle state machine + AgentCard skills/url update;
  full 8-state TaskState enum including v1.0-only `REJECTED`)** ✓ RELEASED
- **Phase 2c (#395/#393, v0.2.32 — AgentCard schema proto-alignment;
  top-level `id`+`url` removed; `description` + `supportedInterfaces`
  (where endpoint URL lives) + `defaultInputModes` + `defaultOutputModes`
  required per canonical proto)** ✓ RELEASED
- **Phase 2b (#397/#392, v0.2.32 — intermediate states + `Message.taskId`
  resume + structured JSON-RPC error mapping; TaskNotFoundError +
  TaskNotResumableError; ROLE_USER enforcement; env-flag-gated REJECTED
  test fixture)** ✓ RELEASED
- **Phase 2d (#402/#398, v0.2.32 — `tasks/get` + `tasks/cancel` JSON-RPC
  methods; TaskIdParamsSchema accepts both `{ id }` + proto-canonical
  `{ name: "tasks/<id>" }`; TaskStore.cancel() + TaskNotCancelableError;
  Python a2a-sdk v1.0.3 round-trip integration; W3C tracecontext E2E via
  InMemorySpanExporter + W3CTraceContextPropagator)** ✓ RELEASED
- **Phase 3 (#407/#396, v0.2.32 — outbound A2A `message/send` via
  `A2aClient` (sendMessage + getAgentCard with 5-min TTL cache); protocol
  selection in `notify_peer.ts` via `selectOutboundProtocol()`;
  MACF_OUTBOUND_LEGACY=1 + 'custom' event → legacy preserved;
  `macf.outbound.protocol` + `OutboundTargetUrl` + `A2aTaskId` +
  `A2aTaskState` tracing attrs)** ✓ RELEASED
- **Phase 3.5 (#428/#429, v0.2.34 — receiver-side delivery on `/a2a/v1`:
  `onNotify`(mcp_push + decideWake) after Task creation; sender
  `custom→legacy` carve-out lifted; Pattern E preserved at the receiver)**
  ✓ RELEASED + live-verified on the CV fleet (science co-verified)
- Phase 3.6 — wire-form convergence with Python a2a-sdk JSON-RPC
  dispatcher; reactive-deferral; trigger = SDK stabilization OR external
  client surfacing the form-mismatch (3 forms documented in design doc:
  spec-text / SDK v1.0 primary PascalCase / SDK v0.3 compat lowercase)
- Phase 4 (#405) — external publication + legacy `notify_peer` sunset;
  unblocked post-v0.2.32; queued for next pickup
- Phase 5 (#406) — CV consumer-fleet migration; light-touch (version-bump
  coordination + cv-e2e-test rehearsal); queued post-Phase-4

Test count at v0.2.32 release: **1477 across the three packages** + 8
integration tests (opt-in via `make test-integration`). Channel-server
went 272 → 311 (+39 from Phase 2d + Phase 3 a2a-client). macf-core 296
unchanged. macf 870+ unchanged.

**Recent release notes worth knowing on resume:**
- v0.2.23 = #369 Phase 0 span rename
- v0.2.24 = #370 Phase 1 AgentCard discovery
- v0.2.26 = #371 /macf/sign Path 2 recovery (v0.2.25 was broken/orphan)
- v0.2.27 = #383 + #384 + #385 (deprecated-constant removal + DR-019
  Amendment A audit-log impl + Python A2A SDK integration test)
- v0.2.28 = #389 resource-attrs population in audit-log emission
- v0.2.29 / v0.2.30 / v0.2.31 = bundled content; ALL FAILED to publish
  (npm 404 PUT / npm 404 PUT / EOTP-Bypass-2FA-missing). Sigstore TLOG
  orphans persist (4 entries: logIndex 1573948960 v0.2.25 + 1575263520
  v0.2.29 + 1575475073 v0.2.30 + 1576145129 v0.2.31). NEVER published.
- **v0.2.32 = bundled Phase 2a/b/c/d + Phase 3 + #399/#400/#401/#403;
  PUBLISHED 2026-05-20T03:04Z via OIDC Trusted Publishers**
- DR-019 Amendment A SHIPPED v0.2.27 (#378 → #384 impl) — App has
  `actions:write`; audit-log emission live
- DR-022 Amendment M SHIPPED v0.2.30 bump-commit (#395) — AgentCard
  proto-alignment migration documentation; LIVE on npm via v0.2.32

**Critical operator-action gating release progress** (#368): npm-token
investigation. Per science-agent diagnostic candidates: NPM_TOKEN expired
/ missing 2FA-bypass capability / scope edited / OIDC trusted-publisher
conflict per DR-022 Amendments C + J. Five-min diagnostic commands +
npmjs.com Web UI checks per `#368` 21:59Z + 22:01Z comments. Sigstore
TLOG orphans at logIndex 1575263520 (v0.2.29) + 1575475073 (v0.2.30);
append-only by design + remain as orphan attestations of attempted
publishes (no cleanup needed).

**Architecture in canonical state** (post-v0.2.18):
- Stage 3 routing — mTLS HTTPS POST `/notify` via `macf-actions@v3.3.0`. SSH-based
  routing was Stage 2 (legacy; gone from active code in `macf-actions@v3+`).
  Substrate workspaces still pin `@v1.3.1` for permanent Stage-2 routing per
  operator directive 2026-04-27 — all NEW consumer projects use Stage 3.
- Per-agent channel server — HTTPS+mTLS, spawned as MCP stdio child. Endpoints:
  `/notify` (inbound coordination), `/sign` (cert signing), `/health` (peer ping).
- `claude.sh` self-wraps in canonical `<project>@<agent>` tmux session as of
  v0.2.10 (`MACF_NO_TMUX_WRAP=1` opt-out). Post-v0.2.17 (macf#340), tmux
  self-wrap passes `MACF_*` env via `-e` flags built from `env | grep` so
  same-project second-agent launches don't inherit first agent's identity from
  tmux server-global env.
- **Multi-file env layout** (v0.2.18, macf#342): per-workspace
  `.claude/.macf/env.{_helpers,identity,github,certs,registry,telemetry,tmux}`
  replaces monolithic claude.sh inline-export. claude.sh is now a thin
  source-then-exec template. Macf-managed files (identity/github/certs/registry/
  _helpers) regenerated by `macf update` + warn-once on hand-edit; operator-
  managed (telemetry/tmux) preserved unconditionally. Auto-migration from
  monolithic claude.sh detection-gated. Operator-custom convention: prefix
  with `env.local.*` or `env.zz.*` to sort post-canonical (avoids
  `env.UPPERCASE` pre-`_helpers` trap).

**Recent Path-2 promotions (structural enforcement of canonical rules):**
- **#140 / attribution-trap PreToolUse hook** — `check-gh-token.sh` blocks `gh`
  / `git push` when `GH_TOKEN` isn't a `ghs_` bot token. Catches wrapped forms.
- **#244 + #272 / mention-routing-hygiene hooks** — `check-mention-routing.sh`
  Check A (must-have-mention) + Check B (must-not-leak describing-context).
- **#270 / check-lgtm-gate.sh** — blocks `gh pr merge` without non-author
  APPROVED review. Path-2 promotion of `pr-discipline.md §"no LGTM = no
  merge"`. v0.2.11.
- **#313 / claude-sh tmux self-wrap** — Path-2 promotion of `coordination.md
  §Canonical tmux launch pattern`. v0.2.10.
- **#349 / MCP tool pre-approval** — `installPluginSkillPermissions` now
  installs `mcp__plugin_macf-agent_macf-agent__*` patterns (notify_peer +
  checkpoint_to_memory) so first-call invocations don't gate on interactive
  approval. Lockstep with channel-server's `registerTool` calls. v0.2.20.
- **macf-actions#39 / route-by-pr-review-state** — Path-2 promotion of
  `pr-discipline.md §formal-review-submission`. v3.3.0.

**Recent security-critical landings:**
- **#161 / cross-repo token paths** — `claude.sh` exports `MACF_WORKSPACE_DIR`
  and absolutizes `KEY_PATH` so the token helper resolves from any cwd.
- **#87 / DR-010 fix** — `/sign` challenge-response now actually verifies (was
  tautological). In-memory challenge store with 5-min TTL.
- **#98 / #89** — `extractCN` rejects multi-CN + non-CN-prefix subjects.
- **#99 / #94** — `decryptCAKey` semantic-checks PEM shape of output.

**Recent reliability landings:**
- **#281 Phase 2 / OTel DELTA temporality** (v0.2.9) — `OTLPMetricExporter` now
  uses DELTA temporality. Process restarts produce independent delta points;
  collector aggregates by series identity. Closes silent-fallback Instance 7.
- **#296 + #305 / `macf doctor` workspace permissions check** — surfaces
  `permissions.allow` Write/Edit absence + reads merged view of
  `settings.json` + `settings.local.json` per Claude Code's canonical merge
  semantics. v0.2.9.
- **#317 / in-runner GH_TOKEN refresh** (v0.2.11) — channel-server long-running-
  session refresh-on-401 + 50min cache. Closes silent-fallback Instance 1
  expiry sub-case. Sister to macf#338 (plugin-CLI subprocess force-fresh
  via `mintFreshGitHubToken()` helper, v0.2.16).
- **#340 / tmux self-wrap env-isolation** (v0.2.17) — `tmux new-session`
  passes `-e VAR=VAL` for each `MACF_*` env captured at wrap-time, so
  same-project second-agent doesn't inherit first agent's identity from
  tmux server-global env.
- **#347 / commander --no-flag default conflict** (v0.2.19) — `--no-migrate-env-files`
  registered with explicit `false` 3rd-arg conflicted with commander's `--no-`
  convention; made the flag silently always-`true`. Migration block silently
  skipped on every `macf update --all --yes`. Fix: drop the explicit default.
  Static source-shape regression test pins the fix.
- **#349 / MCP tool pre-approval gap** (v0.2.20 in-flight) — see Path-2 above.
- **#351 / wake-on-receipt opt-in for notify_peer** (v0.2.20 in-flight) —
  `wake?: boolean` field on NotifyPeerInputSchema lets operator-driven
  invocations opt into tmux-wake (cancels Pattern E for that call); Stop-hook
  autonomous flows omit it (default false → Pattern E preserved → cross-agent
  Stop-hook loop prevention intact).

**Doctrine reference:**
- **DR-019** — 7 required App permissions (`metadata`, `contents`, `issues`,
  `pull_requests`, `actions_variables`, `workflows`, `actions`). `macf doctor`
  verifies a workspace's token against DR-019.
- **DR-022** — channel-server-npm-npx (CLI distribution).
- **DR-023** — Stage-3-hook-mcp-tool-architecture (`peer_notification`
  Pattern E observational-only delivery; bash-form vs mcp_tool decision rule).
  Note: macf#351 (v0.2.20) extends Pattern E with optional wake-on-receipt
  opt-in via `wake?: boolean` on NotifyPeerInputSchema (Stop-hook flows
  omit; operator-driven slash-command #350 will pass true).
- **DR-024** — local-registry mode (sister to DR-010). Per-workspace
  `.macf/registry/<project>.json` + pre-shared local-CA. Lets MACF run
  end-to-end on a single host without GitHub Apps. v0.2.12 implementation;
  v0.2.18 multi-file env layout makes it fully canonical.

## Tech Stack

- TypeScript, ESM-only (`.js` import extensions, `"type": "module"`)
- Node.js 22+ (v25 dev target)
- `@modelcontextprotocol/sdk` — MCP channel protocol
- `@peculiar/x509` + `@peculiar/webcrypto` — cert operations (node:crypto
  can't create X.509; known early decision)
- `node:https` — HTTPS/mTLS server
- `node:crypto` — `pbkdf2`, `createCipheriv`, `timingSafeEqual`, JWT-adjacent
- Zod v4 — runtime validation, `z.infer<>` for types
- Commander v14 — CLI command dispatch
- Vitest v4 — testing
- `gh` CLI + `gh-token` plugin for App token generation

## Development Environment

- **Devbox** is mandatory — do NOT install tools on host
- **Makefile (`dev.mk`) is the primary interface** — always use `make -f dev.mk <target>`
- Never run `devbox run -- npx ...` or `npm` directly from the host for
  first-order workflows; `make -f dev.mk check` is the canonical gate

Key targets:
- `make -f dev.mk check` — full CI: install + typecheck + lint + test (1262/1262 tests
  as of 2026-05-04 v0.2.19 — 807 macf + 162 macf-channel-server + 293 macf-core;
  +320 from v0.2.10 across the 9-release stretch v0.2.11 → v0.2.19)
- `make -f dev.mk typecheck` — type check only (`tsc --noEmit`; formerly `build`, renamed per #127)
- `make -f dev.mk build` — real compile, emits `dist/` (matches `npm run build`)
- `make -f dev.mk lint` — ESLint
- `make -f dev.mk test` — unit tests (no API calls)
- `make -f dev.mk test-e2e` — E2E tests (require real mTLS certs)

One-off test: `devbox run -- npx vitest run test/path/to/file.test.ts`

**Workflow note (after #127):** `make -f dev.mk check` only runs `typecheck`, not `build`. If you've `npm link`ed the CLI for operator use and then modified source, run `make -f dev.mk build` before invoking the linked CLI — otherwise `dist/` is stale and you'll run yesterday's code. Surfaced the hard way during #125 / #126 EKU rollout.

**Stale-dist detection (after #144):** `macf update` warns when the installed CLI's `dist/` is behind the source repo's current HEAD (build-info stamp comparison). Run `macf self-update` to pull origin/main + rebuild in one step. The `dev.mk build` target now routes through `npm run build` so the `postbuild` hook writes `dist/.build-info.json`. Direct `npx tsc` bypasses the hook and triggers a softer "can't verify freshness" warning on next `macf update`.

**E2E runs on cadence (after #149):** `.github/workflows/e2e.yml` runs the E2E suite on every push to main + daily at 07:00 UTC + on `workflow_dispatch`. `make check` stays fast by not including E2E; the workflow catches fixture/gate drift within minutes instead of days (two silent-for-days cases surfaced in one session motivated the split). On failure, the workflow auto-opens (or appends to an existing) `code-agent`/`blocked` issue routed to code-agent's tmux via the router. On the next GREEN push or schedule run, the workflow's self-close-on-green step (#163) closes the open incident issue with a comment citing the green run's SHA + URL — no manual operator close needed. Incident re-opens via title-prefix dedup if failures recur.

**Pre-commit commitlint (after #158):** `.githooks/commit-msg` runs commitlint locally against every staged commit so subject violations (length, type, case) are caught before the commit lands. One-time per clone — run `make -f dev.mk install-hooks` to wire it via `git config core.hooksPath .githooks`. CI keeps the check as a backstop; local runs it too. Clones that haven't opted in are unaffected (no global hooks install).

## Conventions

- Immutable interfaces (`readonly` properties); avoid mutable schema types
- Small files (200-400 lines, 800 max)
- Functions under 50 lines
- Explicit error handling at boundaries
- `import type` for type-only imports (enforced by `verbatimModuleSyntax`)
- Zod schemas for runtime validation, TypeScript types via `z.infer<>`
- Error classes extend `MacfError` with a unique `code` string
- ESM-only: `.js` import extensions in all imports
- Commit types per `commitlint.config.mjs`: feat / fix / **security** /
  **reliability** / refactor / perf / docs / test / chore / ci / revert /
  build / style. Use `security:` for vulnerability fixes + hardening
  (not `fix:`); use `reliability:` for observability / robustness fixes
  from audit / ultrareview findings (not `fix:`) so release notes and
  `git log --grep='^security\|^reliability'` surface them distinctly.

## CLI Surface

`macf` (published via npm when released):
- `init` — set up an agent workspace (`.macf/`, claude.sh, certs, plugin)
- `update` — refresh pinned versions + rules/scripts/plugin assets
- `repo-init` — bootstrap a REPO for routing (agent-config.json, workflow, labels)
- `doctor` — verify bot token permissions vs DR-019
- `rules refresh` — distribute canonical rules/scripts into non-init'd workspaces
- `self-update` — for npm-link dev installs: pull origin/main + rebuild `dist/` (#144)
- `certs init / recover / rotate` — CA key lifecycle
- `status / peers / cd / list` — operational helpers

`macf-plugin-cli` (invoked by plugin skills, not user-facing):
- `status / peers / ping / issues` — backing `/macf-*` skills

## Distribution Pipeline

- CLI ships via npm (eventual)
- Plugin ships via `groundnuty/macf-marketplace@v<version>` (separate repo)
  — `macf init` and `macf update` clone `macf-marketplace:macf-agent/` at
  the pinned tag into `<workspace>/.macf/plugin/`; `claude.sh` uses
  `--plugin-dir` per DR-013. The marketplace `mcpServers` args ship a BARE
  `npx -y @groundnuty/macf-channel-server` spec; `macf init`/`update` rewrite
  the mounted copy to pin `@<cli-version>` via `pinChannelServerVersion`
  (macf#421) so a bare-npx cache hit can't silently serve a stale channel-server
  (the cs version tracks the CLI in the monorepo, not the marketplace plugin tag)
- Routing workflow ships via `groundnuty/macf-actions@v<version>` — consumers
  reference it from their `.github/workflows/agent-router.yml` via
  `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3`
  (current; v3.3.0 latest tag)
- Canonical helpers (coordination.md, tmux-send-to-claude.sh,
  macf-gh-token.sh, macf-whoami.sh, check-gh-token.sh,
  check-mention-routing.sh) ship IN the CLI package and are
  distributed to workspaces at `macf init` / `macf update` /
  `macf rules refresh`

## Observability (optional, opt-in)

Channel server emits OpenTelemetry traces + metrics + logs when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set. The canonical observability stack
(k3d cluster + Tempo + Prometheus/Mimir + Loki + Grafana + central OTel
Collector) lives in [`groundnuty/macf-devops-toolkit`](https://github.com/groundnuty/macf-devops-toolkit).
See `groundnuty/macf-devops-toolkit:CLAUDE.md` for the canonical endpoint
reference (`http://127.0.0.1:14318` host-port-mapped via k3d serverlb)
and `docs/observability-bundle-setup.md` for the operator runbook.

DELTA temporality on counters per macf#281 Phase 2 (v0.2.9+) — robust to
N-process / restart topologies. 4-layer endpoint resolution chain in
`claude.sh` (env > settings.local.json > template-time bake > hardcoded
default) per macf#313 v0.2.10.

## Where to Start When Debugging

| Symptom                                      | Likely location                          |
|----------------------------------------------|------------------------------------------|
| `gh` operations attributed to user not bot   | `packages/macf/scripts/macf-gh-token.sh` + coordination.md Token & Git Hygiene |
| `macf doctor` reports missing permission     | DR-019 — update the App on GitHub        |
| Routing not delivering to recipient channel  | `groundnuty/macf-actions@v3` workflow + recipient agent's registry variable (`MACF_<PROJECT>_AGENT_<NAME>`) |
| `/sign` unexpected behavior                  | `packages/macf-channel-server/src/certs/challenge.ts` + DR-010 |
| Version pins weirdness                       | `packages/macf/src/cli/version-resolver.ts` + `macf-agent.json.versions` |
| Agent template out of sync across workspaces | `packages/macf/plugin/rules/coordination.md` (canonical); re-run `macf rules refresh` |
| PreToolUse hook blocks legitimate `gh` call  | `GH_TOKEN` not `ghs_`-prefixed; refresh via `macf-gh-token.sh`; see `packages/macf/scripts/check-gh-token.sh` + #140 |
| PreToolUse hook blocks `gh issue/pr comment` | `check-mention-routing.sh` Check A (no @mention) or Check B (describing-leak); override `MACF_SKIP_MENTION_CHECK=1`; see #244 + #272 |
| `claude.sh` re-execs in tmux unexpectedly    | v0.2.10+ self-wrap; if launching outside tmux is intentional, use `MACF_NO_TMUX_WRAP=1`; see #313 |
| Telemetry not landing in Tempo/Prometheus    | `OTEL_EXPORTER_OTLP_ENDPOINT` unset OR pointing at retired `:4318` (use `:14318` per macf-devops-toolkit canonical k3d topology); see #282 + #283 |
| Auto-close fired on someone else's issue     | PR body had `Closes/Fixes/Resolves #N`; use `Refs #N` for peer-filed issues per coordination.md §Issue Lifecycle 1 |
| Doctor false-positive on Write/Edit absence  | `permissions.allow` check reads merged settings.json + settings.local.json post-v0.2.9 (#305); operator entries in either file count |
| E2E suite failing silently / fixture drift   | `.github/workflows/e2e.yml` + auto-opened `code-agent/blocked` issue on main |
| Linked CLI behavior doesn't match main       | Stale `dist/`; run `macf self-update` (or `make -f dev.mk build`); see #144 |
| A2A `/a2a/v1` JSON-RPC error / unexpected response shape | `packages/macf-channel-server/src/https.ts` route block (post-#391/#397) + `a2a-types.ts` Zod schemas + `a2a-task.ts` TaskStore. Errors map to spec § 9.5 google.rpc.Status form with `reason: TASK_NOT_FOUND` / `TASK_NOT_RESUMABLE` / `TASK_TERMINAL_STATE` / `INVALID_MESSAGE` |
| AgentCard `/.well-known/agent-card.json` shape questions | `packages/macf-channel-server/src/agent-card.ts` post-#395 (proto-canonical: top-level `id`/`url` ABSENT; endpoint URL lives in `supportedInterfaces[0].url`; `description`/`defaultInputModes`/`defaultOutputModes`/`skills` REQUIRED) — see DR-022 Amendment M for migration narrative |
| npm publish fails after sigstore step | Per DR-022 Amendment L recovery procedure: STOP retrying same version (sigstore TLOG entries are append-only orphans); diagnose downstream cause (npm-token, OIDC, scope); bump-version + republish after fix lands. See `feedback_partial_publish_orphan_tlog_class.md` memory (3 instances 2026-05-18→19) |
| A2A inbound resume not dispatching to existing task | `Message.taskId` field set on incoming `message/send` per spec § 4.1.4 + 3.4.3; only resumable from INPUT_REQUIRED + AUTH_REQUIRED states; ROLE_USER enforced per spec § 4.1.5 — see #392 PR #397 + `a2a-task.ts:resume()` |
