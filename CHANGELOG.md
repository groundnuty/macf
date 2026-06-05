# Changelog

All notable changes to the `macf` CLI. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning per
[SemVer](https://semver.org/spec/v2.0.0.html).

Plugin + routing-workflow changes ship from separate repos
([`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace),
[`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions))
and are not included here — pin them explicitly in each workspace.

## [0.2.34] — 2026-06-05

A2A receiver-side delivery — closes the "A2A routes but agents don't
receive the message" gap (the Phase 5 follow-on surfaced on #422/#368).

### feat — A2A `/a2a/v1` delivers to the agent (#429, Phase 3.5)

Before this, the inbound `message/send` handler created an A2A Task and
returned, but never delivered the message to the receiving agent (no
MCP-channel deposit, no wake) — so A2A was protocol-proven but agents
didn't actually receive over it. Now the handler, after creating the
Task (happy-path + resume), calls the same `onNotify` primitive legacy
`/notify` uses (`mcp.pushNotification` → `decideWake` → `wakeViaTmux`):

- `a2a-delivery.ts` maps the inbound A2A `Message` → a `peer_notification`
  `NotifyPayload`: body = joined text parts; `event`/`source` from
  `Message.metadata` (spec-free-form). Missing/unrecognized event → omit
  → `decideWake` skips → push-only (no accidental wake from a non-MACF
  client; mTLS is the wake trust-gate).
- Pattern E preserved at the receiver (`decideWake`, unchanged): `custom`
  → wake; autonomous (`turn-complete`/`session-end`/`error`) → push-only.
- Sender: the `selectOutboundProtocol` `event === 'custom' → legacy`
  carve-out is lifted (its own comment deferred it to "Phase 3.5") —
  custom now travels A2A + wakes via the receiver. Protocol selection is
  event-independent; loop-prevention is transport-independent.

### fix — code-agent launcher telemetry (#430, #418 item A)

`macf/claude.sh` (code-agent's hand-maintained launcher) had zero OTEL
lines. Wires the telemetry vars inlined into the tmux command (the
`LAUNCH_ENV` pattern) so they cross the `tmux new-session` env-stripping
boundary — code-agent now emits OTEL like the other agents. (Launcher-only
change; not part of the npm packages, but bundled in this release.)

## [0.2.33] — 2026-06-04

Reliability + observability release surfaced by the Phase 5 A2A live-fleet
verification (`#406` / `#368`). First release since the v0.2.32 recovery
arc; cut via OIDC Trusted Publishers (no npm-token step).

### Reliability — A2A outbound observability (#422)

The Phase 5 live-fleet test surfaced a real integration gap: an A2A
`notify_peer` was silently falling back to the legacy `/notify` path,
invisibly. Two silent-no-op hazards closed:

- **`#423`** — `selectOutboundProtocol`'s AgentCard-discovery step (`notify-peer.ts`)
  silently fell back to legacy on `getAgentCard` returning `null`
  (peer 404/401/403 — a clean null-return, not an exception) or a card
  without a JSONRPC binding. Only the catch path (transport/5xx/schema-fail)
  warned. Now both quiet branches warn — `notify_peer_a2a_no_agent_card`
  `{ peer, url }` + `notify_peer_a2a_no_jsonrpc_binding` `{ peer, url, bindings }`
  (the bindings seen, so a version-skewed peer is diagnosable from one line).
- **`#425`** — `bootstrapOtel` (`otel.ts`) returned silently when
  `OTEL_EXPORTER_OTLP_ENDPOINT` was unset, making a channel-server that
  exports nothing indistinguishable from one whose OTLP export fails
  downstream. Now announces on startup (→ MCP child's channel.log):
  `otel_init endpoint="..."` when set+registered, `otel_init_skipped
  reason=...` when unset. Diagnoses the AC-5 sender-export gap.

### Fix — OTLP endpoint hygiene (#419)

- Default OTLP endpoint `localhost:14318` → **`127.0.0.1:14318`** (IPv4
  literal) in both the canonical reference (`claude-sh.ts`) and the live
  consumer-output path (`env-files.ts` `generateEnvTelemetry`). Removes
  the latent `localhost`→`::1` resolution ambiguity; aligns with the
  sibling `MACF_ADVERTISE_HOST ?? '127.0.0.1'` default.

### Docs — A2A Phase 4/5 + DR-022 amendments

- Phase 4 (`#405`/#409) external-publication topology + `notify_peer`
  sunset options; Phase 5 (`#406`/#410/#411) CV consumer-fleet migration
  procedure + operator checklist (AC-4 observability query corrected to
  Tempo `service.version`).
- DR-022 Amendment N (#408 — OIDC Trusted Publishers as canonical CI auth)
  + Amendment O (#412 — legacy `notify_peer` sunset criterion Option A,
  counter-based 60-day).
- `silent-fallback-hazards.md` Instance 2 (#417) — closure-protocol-table-cell
  auto-close sub-shape.

## [0.2.32] — 2026-05-20

Recovery release per DR-022 Amendment L (fourth bump in the v0.2.29 →
v0.2.32 recovery arc). v0.2.31 publish FAILED with `EOTP` — the
operator-issued token lacked Bypass-2FA capability (npm granular tokens
require this checkbox at creation time even when account 2FA is off;
sister-class to `feedback_npm_bypass_2fa_flag.md`).

Operator pivoted to **OIDC Trusted Publishers** (long-term cleaner; no
token to rotate). Configured on all 3 packages on npmjs.com 2026-05-20;
GitHub `NPM_TOKEN` secret deleted; workflow's `HAS_NPM_TOKEN=false`
branch falls through to OIDC. workflow_dispatch dry-run via OIDC
succeeded (`gh run view 26137973195`) before this bump.

Workflow changes for OIDC support:

- Added `npm install -g npm@11.14.1` step (OIDC trusted publishers
  require npm 11.5.1+; devbox's pin is 10.8.3). Installed under
  `$HOME/npm-global` user-prefix; devbox's read-only Nix store
  prevents the standard `-g` install path.
- Switched the 6 `npm publish` steps from `devbox run --` to bare
  `npm` so the upgraded 11.14.1 binary is used (devbox's npm 10.x
  lacks OIDC handshake support).
- PINNED npm to specific version `11.14.1`, NOT `latest` — per
  operator directive 2026-05-20 (floating tags create silent temporal
  bitrot when upstream ships behavioral changes).

Content is the same as the failed v0.2.31 attempt: full A2A v1.0
bidirectional surface (Phase 2 inbound + Phase 3 outbound) + the
CI / docs / test-stabilization PRs that accumulated during the
recovery window. v0.2.31 sigstore TLOG entry (`logIndex 1576145129`)
persists as orphan attestation; transparency log is append-only.

## [0.2.31] — 2026-05-20 (PUBLISH-FAILED)

**This version was never published to npm.** Publish workflow failed
with `EOTP` (token lacked Bypass-2FA capability). v0.2.32 supersedes
with identical content via OIDC trusted publisher path. Sigstore TLOG
orphan accumulated (`logIndex 1576145129`).

Recovery release per DR-022 Amendment L. v0.2.29 + v0.2.30 publish
workflows previously failed at npm registry PUT step (HTTP 404; sigstore
TLOG entries orphan; operator-side npm-token investigation gating).
Operator issued fresh token 2026-05-20; v0.2.31 attempted to republish
the bundled content plus the post-v0.2.30 work that accumulated during
the recovery window.

This release is **the full A2A v1.0 bidirectional surface** (Phase 2
inbound + Phase 3 outbound) plus CI / docs / test-stabilization PRs.

### A2A v1.0 inbound — Phase 2a/b/c/d

- **Phase 2a** ([#391], Refs #390) — inbound JSON-RPC `message/send`
  at `/a2a/v1`; full 8-state TaskState enum (SUBMITTED → WORKING →
  COMPLETED happy path; INPUT_REQUIRED / AUTH_REQUIRED / REJECTED states
  declared); in-memory TaskStore.
- **Phase 2b** ([#397], Refs #392) — intermediate states + resume
  via `Message.taskId`; TaskNotFoundError + TaskNotResumableError;
  ROLE_USER enforcement on resume; env-flag-gated REJECTED test fixture.
- **Phase 2c** ([#395], Refs #393) — AgentCard proto-canonical
  schema realignment; top-level `id` + `url` removed; `description` +
  `supportedInterfaces` + `defaultInputModes` + `defaultOutputModes`
  upgraded to required. See DR-022 Amendment M for migration narrative.
- **Phase 2d** ([#402], Refs #398) — `tasks/get` + `tasks/cancel`
  JSON-RPC methods; TaskIdParamsSchema accepts both bare `{ id }` and
  proto-canonical `{ name: "tasks/<id>" }`; TaskStore.cancel() with
  TaskNotCancelableError; Python a2a-sdk v1.0.3 round-trip integration
  test; W3C tracecontext propagation E2E smoke via
  InMemorySpanExporter + W3CTraceContextPropagator.

### A2A v1.0 outbound — Phase 3

- **Phase 3** ([#407], Refs #396) — `A2aClient` outbound primitive
  with `sendMessage` + `getAgentCard` (5-min TTL cache) + mTLS via
  per-project CA + traceparent injection. Protocol selection in
  `notify_peer.ts` via `selectOutboundProtocol()` decision tree
  (`MACF_OUTBOUND_LEGACY=1` env / `event === 'custom'` / no AgentCard
  → legacy; AgentCard with JSONRPC binding → A2A). Tracing attrs
  (`OutboundProtocol`, `OutboundTargetUrl`, `A2aTaskId`, `A2aTaskState`)
  disambiguate the two outbound paths under canonical
  `invoke_agent {target}` span name. Wire-form divergence between A2A
  v1.0 spec text + Python SDK implementation surfaced + documented;
  Phase 3.5 (receiver-side wake-decision on `/a2a/v1` for `custom`
  events) + Phase 3.6 (wire-form convergence) reactive-deferrals.

### CI + tests + docs

- **CI integration job** ([#399], Refs #386) — extends `e2e.yml`
  with `integration-python-a2a` job; path-filter scopes PR trigger to
  AgentCard surface; venv cache keyed on SDK + dep set + OS;
  self-close-on-green incident pattern from #163.
- **Test stabilization** ([#400], Refs #382) — mock plugin-version
  resolution path (root-cause refinement vs PR #380's hypothesis);
  revert #380's 30s timeout lift back to default 5s.
- **DR-019 doc backfill** ([#401]) — #TBD placeholders resolved with
  delivered devops dashboard refs (`groundnuty/macf-devops-toolkit#74`
  closed; #77 PR merged at `85c966a8`); PromQL string-escape gotcha
  methodology paragraph
  (`reference_multi_language_regex_escape_translation.md` cross-ref).
- **Silent-fallback Instance 9** ([#403]) — sigstore TLOG orphans on
  failed npm publish canonicalized as 9th instance (sister-shape to
  strict silent-fallback: failure LOUD at API boundary; hazard is
  retry-recovery not detection-surface). 3-instance evidence base
  + three documented defense layers.

### Test count baseline

- macf-channel-server: 311 (+39 from pre-v0.2.30; Phase 2d + Phase 3)
- macf-core: 296 (unchanged)
- macf: 870+ (unchanged)
- Integration tests (opt-in via `make test-integration`): 8 total
  (4 Phase 2d Python-client + 4 Phase 3 Python-server, 1 documented
  skip for wire-form divergence)

### Operator notes

- v0.2.29 + v0.2.30 sigstore TLOG entries (`logIndex 1575263520` +
  `1575475073`) persist as orphan attestations; transparency log is
  append-only by design. No cleanup needed.
- `@groundnuty/macf{,-core}@0.2.25` orphan packages on npm remain;
  deprecate via `npm-deprecate.yml` workflow_dispatch when convenient
  (independent of release path).

## [0.2.30] — 2026-05-19

Recovery + bundled release. v0.2.29 publish workflow failed at npm registry
PUT step (HTTP 404; sigstore TLOG entries orphan per DR-022 Amendment L
witness 2; npm-token root cause under operator investigation). Per the
canonical recovery procedure, v0.2.30 bumps + republishes all three
packages with bundled Phase 2a + Phase 2c + Phase 2b content. Identical
to the failed v0.2.29 publish content + Phase 2b additions; sigstore gets
fresh TLOG entries for v0.2.30.

Three A2A v1.0 phases bundled in this single release vehicle:

### Phase 2a — inbound message/send + task lifecycle (PR [#391])

- POST `/a2a/v1` JSON-RPC `message/send` endpoint per spec § 9 examples
- Full 8-state TaskState enum + transition table (REJECTED included)
- AgentCard.skills populated with MACF capabilities
- `A2A-Version: 1.0` response header per spec § 3.6 (added in #391 review-amend)
- TaskStore + Zod schemas + state machine
- See PR #391 / closes [#390]

### Phase 2c — AgentCard schema proto-alignment (PR #395)

- Realigned with canonical `a2aproject/A2A:specification/a2a.proto`
- Removed non-canonical top-level `id` + `url` (URL moved to
  `supportedInterfaces[0].url` per AgentInterface)
- Added required `description`, `supportedInterfaces`,
  `defaultInputModes`, `defaultOutputModes`
- AgentSkill `description` + `tags` upgraded to required
- Strict-validation assertion in Python SDK integration test
- DR-022 Amendment M documents the migration
- See PR #395 / closes [#393]

### Phase 2b — intermediate states + Message.taskId resume (PR #397)

- TaskStore.resume() + rejectFresh() methods
- Route handler resume branch (Message.taskId presence check)
- Structured error mapping: TaskNotFoundError, TaskNotResumableError,
  InvalidTaskTransitionError → JSON-RPC google.rpc.Status form
- ROLE_USER enforcement on resume messages (spec § 4.1.5)
- Env-flag-gated REJECTED test fixture
- New reason codes: TASK_TERMINAL_STATE, TASK_NOT_RESUMABLE
- See PR #397 / Refs [#392]

### Cumulative

- Tests: 1438/1438 pass (870 macf + 272 channel-server + 296 macf-core)
- Backwards-compat: `/notify`, `/macf/sign`, `/health`, AgentCard
  discovery all unchanged
- `/macf/sign` Path 2 exclusion invariant preserved across all three phases

Phase 2d sub-issue ([#398]) tracks remaining deferrals: Python SDK
`message/send` round-trip + traceparent E2E mock-OTLP + `tasks/get` +
`tasks/cancel` JSON-RPC methods.

Phase 3 sub-issue ([#396]) tracks outbound A2A (MACF as client); design
proposal acked; impl follows Phase 2d.

[#390]: https://github.com/groundnuty/macf/issues/390
[#392]: https://github.com/groundnuty/macf/issues/392
[#391]: https://github.com/groundnuty/macf/pull/391
[#396]: https://github.com/groundnuty/macf/issues/396
[#398]: https://github.com/groundnuty/macf/issues/398

## [0.2.29] — 2026-05-19 — FAILED PUBLISH (not on npm)

**This version was NEVER PUBLISHED to npm.** The release-cut commit landed
on `groundnuty/macf:main` (`11cbbccf`), the v0.2.29 tag was pushed, the
`publish.yml` workflow started + completed Sigstore provenance for
`@groundnuty/macf-core@0.2.29`, but npm registry returned HTTP 404 on
the PUT step (root cause under operator-side investigation; candidates:
expired NPM_TOKEN, missing 2FA-bypass capability, OIDC trusted-publisher
conflict per DR-022 Amendments C + J).

Recovery per DR-022 Amendment L: bump to v0.2.30 + republish.
**Consumers MUST NOT pin to v0.2.29** — it doesn't exist on npm.
v0.2.30 ships the intended Phase 2a + 2c + 2b content with fresh sigstore
TLOG entries.

Master tracking: [#368]. Sigstore TLOG entries from the v0.2.29 attempt
will be operator-deprecated post-recovery (via `npm-deprecate.yml`
workflow_dispatch, sister-shape to v0.2.25 → v0.2.26 orphan cleanup).

[#368]: https://github.com/groundnuty/macf/issues/368

## [0.2.28] — 2026-05-19

Single-piece micro-release: follow-up to v0.2.27's audit-log emission
landing. Populates `resource.attributes` from claude.sh's
`OTEL_SERVICE_NAME` + `OTEL_RESOURCE_ATTRIBUTES` env exports so
hook-emitted spans aggregate by `service.name` + `gen_ai.*` with the
rest of the MACF observability stack (previously empty
`resource.attributes` block left them under
`rootServiceName=<root span not yet received>` in Tempo).

### Fixed

- **Audit-log resource-attrs gap** in `check-gh-token.sh`. New
  `_macf_audit_build_resource_attrs_json` helper reads canonical OTel
  env vars (per `observability-wiring.md`) and populates both span +
  counter emission bodies. Pass-through approach (env → parsed → OTLP
  body) over direct `MACF_AGENT_NAME` / `MACF_AGENT_ROLE` read keeps
  claude.sh as the single source of truth + auto-propagates future
  canonical additions. Graceful degradation when env unset (empty
  array; identical to pre-#388 shape; devops's direct-invocation smoke
  still works). PR [#389] / closes [#388].

[#388]: https://github.com/groundnuty/macf/issues/388
[#389]: https://github.com/groundnuty/macf/pull/389

## [0.2.27] — 2026-05-19

Three-piece release: A2A v1.0 interop empirical evidence (Python SDK
integration test), DR-019 Amendment A audit-log emission landing, and
deprecated `SpanNames.ToolNotifyPeer` constant cleanup. Bundled per the
substrate-evolution-cadence directive.

### Added

- **DR-019 Amendment A — `actions:write` audit-log emission** in
  `check-gh-token.sh` PreToolUse hook. Detects `gh workflow run|cancel|rerun`
  + `gh api .../actions/...` invocations across all three subcommand
  classes (workflow lifecycle / run lifecycle / API-direct POST). Emits
  OTel CLIENT span (`macf.app.gh_api_call` with HTTP semconv + MACF
  governance attrs) + counter (`macf.app.gh_actions_write_total`
  bounded by the dispatch-allowlist `MACF_ACTIONS_DISPATCH_ALLOWLIST_REGEX`).
  Emission via `otel-cli` (preferred for span) with curl-OTLP-HTTP
  fallback (always for counter); silent skip when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. Observational only —
  emit-failure non-blocking. Wrapper-form-aware (sudo/env/bash-c).
  PR [#384] / closes [#381]; sequence (a) impl-first per three-way
  reviewer alignment.
- **Python A2A SDK integration test** at
  `packages/macf-channel-server/test/integration/a2a-python-sdk.test.ts`.
  Cross-implementation triangulation: the official `a2a-sdk` v1.0.3
  PyPI package's `A2ACardResolver` + pydantic AgentCard model parses
  MACF's hand-rolled Zod-validated `/.well-known/agent-card.json`
  output. Closes the deferred Phase 1 acceptance criterion from
  [#370] (PR #375). Integration tests gated outside `make check`
  (`make -f dev.mk test-integration` invocation; venv cached at
  `node_modules/.cache/a2a-python-venv` with SDK-version sentinel).
  PR [#385] / closes [#376]; CI coverage extension tracked as [#386].

### Removed

- **Deprecated `SpanNames.ToolNotifyPeer` constant** from
  `packages/macf-channel-server/src/tracing.ts`. The literal had been
  unemitted since [#369] (PR #372, v0.2.23) renamed the outbound
  notify_peer span to `invoke_agent {gen_ai.agent.name}` per OTel
  GenAI Agent Spans semconv. Trigger conditions satisfied per [#374]
  thread (operator-overrode the 7-day defensive window on 2026-05-19;
  rename live 24h+; zero legacy hits in full 7d Tempo retention;
  devops dashboards migrated). Substrate-Stage-2-routing context as
  the cause of trivially-zero condition 2 captured in DR-022
  Amendment L. PR [#383] / closes [#374].

[#369]: https://github.com/groundnuty/macf/pull/372
[#370]: https://github.com/groundnuty/macf/pull/375
[#374]: https://github.com/groundnuty/macf/issues/374
[#376]: https://github.com/groundnuty/macf/issues/376
[#381]: https://github.com/groundnuty/macf/issues/381
[#383]: https://github.com/groundnuty/macf/pull/383
[#384]: https://github.com/groundnuty/macf/pull/384
[#385]: https://github.com/groundnuty/macf/pull/385
[#386]: https://github.com/groundnuty/macf/issues/386

## [0.2.26] — 2026-05-18

Republish of v0.2.25 due to a sigstore-provenance race condition in
the npm publish workflow. **Same content as v0.2.25** (no code
changes); the 0.2.25 split-publish on npm is recovered by bumping
to a fresh version.

### What happened (operator-facing)

- v0.2.25 publish workflow first run hit two pre-existing test
  flakes (5s vitest timeouts in `init.test.ts` + `check-lgtm-gate.test.ts`)
  and aborted before the npm publish step. Retry by tag-recreate
  passed the test step, but on `@groundnuty/macf-channel-server`
  publish hit `TLOG_CREATE_ENTRY_ERROR (409)` from sigstore — the
  previous run had already submitted a transparency-log entry,
  blocking the retry's attestation. Result: `@groundnuty/macf-core@0.2.25`
  + `@groundnuty/macf@0.2.25` published; `@groundnuty/macf-channel-server@0.2.25`
  did not. `@groundnuty/macf@0.2.25` declares a dep on the
  non-existent channel-server@0.2.25 — broken consumer install path.

### Recovery

- v0.2.26 republishes all three packages with the same content as
  the intended v0.2.25 (the actual content from PR #373 / #371).
- Orphaned npm versions `@groundnuty/macf@0.2.25` and
  `@groundnuty/macf-core@0.2.25` are deprecated via the
  `npm-deprecate.yml` workflow post-publish, with the deprecation
  message pointing at v0.2.26.
- A separate follow-up issue will track the sigstore-retry hazard
  + propose vitest `testTimeout` lift to make the pre-existing
  flakes more resilient.

### Content (identical to intended v0.2.25; see [#371] / [#373])

- `/sign` → `/macf/sign` namespace move with 308 redirect; full
  details in v0.2.25 changelog entry below (kept for historical
  reference even though that version is broken-on-npm).

[#371]: https://github.com/groundnuty/macf/issues/371
[#373]: https://github.com/groundnuty/macf/pull/373

## [0.2.25] — 2026-05-18

`/sign` namespace move to `/macf/sign` per DR-010 Path 2 (research-niche
labeling). MACF live cryptographic attestation now lives under the
`/macf/` prefix to signal it as a MACF-only extension that A2A-spec
clients SHOULD NOT depend on. **Zero functional change** to the
challenge-response protocol; existing flows redirect 308 → canonical
path. Parallel-with the A2A integration arc (#370 Phase 1).

### Refactored
- **`POST /sign` → `POST /macf/sign` + 308 redirect + 12-month
  removal trigger ([#373], closes [#371])** — channel-server's
  live-attestation endpoint moved under `/macf/` namespace. Legacy
  `/sign` returns HTTP 308 Permanent Redirect (NOT 301/302 —
  preserves POST method per RFC 7538) with `Location: /macf/sign`
  header; emits `sign_redirect_legacy` log event for observability
  of migration progress.

  New `macf.sign_calls_total{agent}` OTel counter on the canonical
  path drives a **telemetry-based removal trigger** (sister to
  #374's trigger pattern): if the counter reads zero for 12
  consecutive months from this PR merge date, file a follow-up
  issue to remove the endpoint entirely. Calendar-based trigger
  was deliberately rejected in favor of observed-state trigger
  (the principle from #374 review pushback: a clock that ticks
  on cluster idleness proves nothing about migration progress).

  DR-010 updated with "Path 2: research-niche labeling" section
  covering the Path 2 framing, removal trigger, AgentCard
  exclusion lockstep with #370 / PR #375, and Path 1 deferred-work
  pointer (advocate live-attestation as A2A spec extension after
  Phase 4 lands).

  Cross-repo audit confirmed 0 true HTTP callers across
  `groundnuty/macf{,-actions,-marketplace}` plus CV agents
  (`cv-project-archaeologist`, `academic-resume`); the 16 test
  fixtures + 1 user-visible error string updated to canonical path.
  External-caller concern explicitly cleared.

  **#370 AgentCard lockstep**: `/macf/sign` is NOT advertised in
  the AgentCard returned by `/.well-known/agent-card.json` (Phase 1
  / PR #375). Both unit-level + E2E-level invariants in #370's
  tests pin this so a future skill-array addition can't accidentally
  re-include the endpoint.

  175/175 + 49/49 channel-server tests pass; 2 pre-existing flakes
  (init-test GitHub anon-API rate-limit timeouts) explicitly
  identified as unrelated to this PR.

[#371]: https://github.com/groundnuty/macf/issues/371
[#373]: https://github.com/groundnuty/macf/pull/373

## [0.2.24] — 2026-05-18

A2A integration Phase 1 — adds a well-known AgentCard discovery
endpoint to `macf-channel-server` per A2A Protocol v1.0 § 14.3 + § 4.4.1.
Purely additive discovery; **zero behavior change** to existing
endpoints (`/notify`, `/macf/sign`, `/health`). Bumps existing MACF
agents to a state where external A2A-spec clients can discover them
without per-vendor configuration.

### Added
- **AgentCard endpoint at `/.well-known/agent-card.json`
  ([#375], closes [#370])** — serves a spec-compliant A2A v1.0
  AgentCard JSON over the existing mTLS channel. Fields populated
  from MACF identity (`agentName`, `agentRole`, `project`) +
  channel-server `PACKAGE_VERSION`:

  - `id`: `<project>-<agentName>` (e.g. `macf-code-agent`)
  - `name`: `<agentName>`
  - `url`: `https://<advertiseHost>:<port>`
  - `version`: channel-server PACKAGE_VERSION
  - `provider`: `{organization: "groundnuty/macf (<project>)", url: "https://github.com/groundnuty/macf"}`
  - `securitySchemes.mutual_tls.type`: `"mutualTls"` (per spec § 4.5.6)
  - `security`: `[{mutual_tls: []}]` (default requirement)
  - `skills`: `[]` (Phase 1; populated as A2A task lifecycle surfaces materialize in Phase 2+)
  - `capabilities`: `{}` (Phase 1; populated when inbound A2A JSON-RPC `message/send` lands)

  Hand-rolled Zod schema (`packages/macf-channel-server/src/agent-card.ts`)
  instead of `@a2a-js/sdk` because the npm SDK is v0.3.13 implementing
  A2A v0.3, not v1.0 (v1.0 still alpha on `epic/1.0_breaking_changes`
  branch). Phase 1's narrow scope makes ~120 lines of Zod the minimal
  correct surface; will swap to `@a2a-js/sdk` v1.0 when stable. Schema
  cites spec § 4.4.1 / § 4.4.5 / § 4.5.6 / § 14.3 (verified live
  2026-05-18 via a2a-protocol.org).

  Phase 1 **mTLS-only stance**. `securitySchemes` field uses an
  mTLS-discriminated `z.record`; Phase 2+ widening to a
  `z.discriminatedUnion` for OAuth/OIDC is noted as an extension point
  in a code comment.

  **#371 Path 2 lockstep**: `/macf/sign` is intentionally NOT
  advertised in the AgentCard. Live cryptographic attestation stays
  MACF-only per DR-010 Path 2. Both unit-level and E2E-level invariants
  pin this — neither `/macf/sign` nor `/sign` appears anywhere in the
  served JSON.

  20 unit tests + 8 E2E tests pass (196/197 in channel-server suite;
  +21 over the v0.2.23 baseline). Python A2A SDK reference-client
  integration test deferred to follow-up [#376] (cross-implementation
  triangulation; non-blocking; gates Phase 3 outbound-A2A work).

[#370]: https://github.com/groundnuty/macf/issues/370
[#375]: https://github.com/groundnuty/macf/pull/375
[#376]: https://github.com/groundnuty/macf/issues/376

## [0.2.23] — 2026-05-18

A2A integration Phase 0 — OTel GenAI semconv alignment for the
outbound-invocation span. Aligns MACF's `notify_peer` CLIENT span to
the OTel GenAI Agent Spans semconv so standard observability vendors
(Datadog, Grafana Cloud AI Observability, etc.) auto-instrument MACF
traces without per-vendor configuration after the upcoming A2A Phase 1
(AgentCard endpoint).

### Refactored
- **`notify_peer` span renamed to `invoke_agent {target}` per OTel
  GenAI Agent Spans semconv ([#372], closes [#369])** — sender-side
  CLIENT-kind span now uses the spec-compliant dynamic name. Per-span
  `gen_ai.agent.name` attribute carries the TARGET peer (distinct
  from the per-resource `gen_ai.agent.name` set by env.telemetry =
  the EMITTING agent). TraceQL queries disambiguate via `resource.`
  vs `span.` prefix.

  Inventory audit confirmed only 1-of-10 spans maps to invoke_agent
  semantics (sender-side outbound CLIENT call); the other 9 are
  receiver-side / local / cert / registry operations and stay as
  `macf.*` literals. Receiver-side `NotifyReceived` operation name
  (`peer_notify`) preserved — sender and receiver carry different
  GenAI op-semantics by design.

  `SpanNames.ToolNotifyPeer = 'macf.tool.notify_peer'` constant kept
  as an exported-but-unemitted reference for grep-traceability + the
  Tempo-dashboard migration window. Cleanup tracked at [#374] —
  removes the constant once devops-agent confirms Tempo dashboards
  are migrated to the new form (≥7 days clean `invoke_agent` traces,
  zero legacy hits).

  Tests: 4 new in `tracing.test.ts` covering target-present,
  undefined fallback, empty-string fallback, and the `^invoke_agent`
  prefix-regression invariant for Tempo TraceQL prefix queries.

  Devops-agent (cross-checked on #369 thread): no Collector processors
  in macf-devops-toolkit depend on the old span name; all 3
  trace-pipeline processors (k8sattributes, resource/paper-dims,
  transform/genai-semconv) are span-name-agnostic. Dual-scope TraceQL
  examples for `observability-snapshot.sh` ship as
  `groundnuty/macf-devops-toolkit#71`.

[#369]: https://github.com/groundnuty/macf/issues/369
[#372]: https://github.com/groundnuty/macf/pull/372
[#374]: https://github.com/groundnuty/macf/issues/374

## [0.2.22] — 2026-05-04

OTel resource-attribute identity plumbing. Replaces the literal
`service.namespace=macf` in `env.telemetry` with shell-expanded
identity-bearing attributes so Tempo / Loki / Prometheus can
distinguish PPAM agents on macbook from VM substrate, and adds
`service.version` for release-cadence correlation queries.

### Added
- **9-attribute OTel resource set on `env.telemetry`
  ([#358], closes [#357])** — `OTEL_RESOURCE_ATTRIBUTES` now carries:

  | Attribute | Source |
  |---|---|
  | `service.namespace` | `${MACF_PROJECT}` (was: literal `macf`) |
  | `service.version` | `${MACF_VERSION:-unknown}` (NEW; baked from `versions.cli`) |
  | `service.instance.id` | `${MACF_PROJECT}-${MACF_AGENT_NAME}@$(hostname -s)` |
  | `host.name` | `$(hostname -s)` (NEW) |
  | `gen_ai.agent.name` / `role` | `${MACF_AGENT_NAME}` / `${MACF_AGENT_ROLE}` |
  | `macf.framework=macf` | literal (NEW; designed all-macf-agents filter) |
  | `macf.agent.type` | `${MACF_AGENT_TYPE}` (NEW) |
  | `macf.registry.type` | `${MACF_REGISTRY_TYPE}` (NEW) |

  Shell-var expansion picks up `env.identity`'s 3-layer settings
  priority (operator overrides for `MACF_AGENT_NAME` / `MACF_AGENT_ROLE`
  via `settings.local.json` survive) and `env.registry`'s mode
  discrimination. `env.telemetry` sources after `env.identity` +
  `env.registry` per alphabetical glob, so vars are available at
  export time.

  `MACF_VERSION` baked literal from `.macf/macf-agent.json` `versions.cli`
  at template-write time. Falls back to `unknown` via
  `${MACF_VERSION:-unknown}` for substrate / pre-P6 workspaces lacking
  the versions block — well-formed label, not empty-string.

  `gen_ai.system` intentionally NOT set — Claude Code's SDK auto-sets
  it for the LLM provider; overwriting would mislabel telemetry.

  `env.telemetry` remains operator-managed per macf#342 — bootstrap-
  write on first `macf update` if absent; preserved unconditionally
  otherwise. **Operator-side note**: `MACF_VERSION` does NOT auto-
  refresh on subsequent `macf update`s (operator-managed contract
  trumps automatic version refresh). To pick up a new pinned version,
  delete `env.telemetry` and re-run `macf update`, or hand-edit the
  `MACF_VERSION` line. Documented in `docs/configuration.md`.

  Enables paper-grade query patterns:
  - `macf.framework="macf" AND service.namespace="ppam-2026"` — just PPAM
  - `macf.framework="macf" AND service.version="0.2.20"` — pre-/post-release behavior comparison
  - `macf.framework="macf" AND macf.registry.type="local"` — coordination-mode dimension

  1296 tests green (827 macf + 173 channel-server + 296 core; +12
  from #357).

[#357]: https://github.com/groundnuty/macf/issues/357
[#358]: https://github.com/groundnuty/macf/pull/358

## [0.2.21] — 2026-05-04

Fast-follow refactor for v0.2.20. Removes the `wake?: boolean` field
from sender-side schemas. Receiver-side `decideWake()` now reads
`payload.event` directly: `event === 'custom'` (operator-driven slash
command) → wake; autonomous events (`session-end` / `turn-complete` /
`error` from Stop-hook flows) → skip wake (Pattern E preserved).

The previous design (#351) leaked Pattern E loop-prevention logic
into every sender's API surface via a per-call boolean. The cleaner
design discriminates at the receiver from a property already there
for other reasons (`event`) — single source of truth, smaller agent-
facing API.

### Refactored
- **Wake discriminator: event-based ([#356], closes [#355])** — receiver
  `decideWake()` is now a 3-rule pure function:
  1. `peer_notification` + `event: 'custom'` → WAKE
  2. `peer_notification` + autonomous events → SKIP
  3. Other NotifyTypes → WAKE (unchanged)

  Schemas:
  - Dropped `wake` from `NotifyPeerInputSchema` (channel-server)
  - Dropped `wake` from `NotifyPayloadSchema` + `PeerNotificationPayloadSchema` (macf-core)

  Slash-command:
  - Dropped `--no-wake` from `/macf-agent:macf-notify-peer` argument-hint + body
  - Receiver decides from `event` alone

  Log event renames:
  - `peer_notification_observational` → `peer_notification_autonomous_event`
  - `peer_notification_wake_opt_in` → `peer_notification_custom_event`

  Source-level invariants pin the cleaner shape:
  - `PeerNotificationPayloadSchema.shape` MUST NOT contain `wake`
  - `NotifyPayloadSchema.shape` MUST NOT contain `wake`
  - SKILL.md MUST NOT mention `--no-wake`
  - SKILL.md MUST NOT instruct passing `wake: true|false`

  Backward-compatibility: v0.2.20 shipped ~30 minutes before #355
  was filed; no external consumers had time to adopt the wake field.
  v0.2.21 fast-follow removes it cleanly without a deprecation cycle.

  Documentation: `silent-fallback-hazards.md` Instance 6 updated to
  reflect Pattern E refinement (event-based vs flag-based discrimination);
  `docs/features.md` slash-command subsection updated.

  1284 tests green (815 macf + 173 channel-server + 296 core).

[#355]: https://github.com/groundnuty/macf/issues/355
[#356]: https://github.com/groundnuty/macf/pull/356

## [0.2.20] — 2026-05-04

Three-piece operator-driven cross-agent messaging bundle. Closes the
ergonomic gap surfaced 2026-05-04 (PPAM 2026 deployment): operator
invokes `notify_peer` against a peer agent, the receiver doesn't
visibly wake, and the verbose default output consumes coordination
context-tokens. The bundle addresses all three sub-problems in lockstep
(approval friction + wake semantics + output verbosity).

### Added
- **`/macf-agent:notify-peer` slash-command
  ([#354], closes [#350])** — operator-driven counterpart to the
  autonomous Stop-hook `notify_peer` invocation. New SKILL.md at
  `packages/macf/plugin/skills/macf-notify-peer/` directs the LLM to:
  invoke `notify_peer` with `wake: true` by default (cancels Pattern E
  for that one call so the receiver TUI visibly wakes), respond with
  EXACTLY ONE LINE (`→ <peer> [<event>] delivered=<bool>`),
  and explicitly NOT restate the JSON result or the tool's input
  schema. The one-line discipline addresses the load-bearing concern
  surfaced by the operator: not visual brevity, but token-budget
  preservation across N turns of operator-driven coordination
  (verbose-by-default would erode the budget for actual coordination
  content). Opt-outs: `--no-wake` preserves Pattern E (quiet
  observational delivery); `--verbose` opts back into full JSON
  result for debug. `Skill(macf-agent:macf-notify-peer)` added as the
  5th `PLUGIN_SKILL_PERMISSIONS` entry — slash-command itself
  pre-approved alongside the underlying MCP tool (sister to #349
  which pre-approved the tool).

- **Wake-on-receipt opt-in for `notify_peer`
  ([#353], closes [#351])** — `wake?: boolean` field on
  `NotifyPeerInputSchema` (channel-server). Default `false` preserves
  Pattern E (Stop-hook autonomous flows omit the field → cross-agent
  Stop-hook loop prevention intact). Operator-driven invocations
  (the `/macf-agent:notify-peer` slash-command above) opt in by
  passing `wake: true`. Receiver-side discriminator extracted as
  pure helper at `packages/macf-channel-server/src/wake-decision.ts`
  (`decideWake()`); was inline in server.ts main(). New log event
  `peer_notification_wake_opt_in` distinct from downstream
  `tmux_wake_delivered` so operators can grep for the cause. Outbound
  POST omits `wake` when false/undefined (wire shape-compatible with
  pre-#351 receivers; no unknown-field surface). `formatNotifyContent`
  already supports `peer_notification` content shape — no formatter
  changes needed. hooks.json verified: no Stop-hook entry passes
  wake → Pattern E preserved → no regression to cross-agent loop
  prevention.

### Reliability
- **MCP tool pre-approval gap closed
  ([#352], closes [#349])** — `installPluginSkillPermissions` now
  installs `mcp__plugin_macf-agent_macf-agent__*` patterns
  (`notify_peer` + `checkpoint_to_memory`) in lockstep with the
  channel-server's `mcp.mcp.registerTool(...)` calls. Previously,
  every first invocation of `notify_peer` (autonomous Stop-hook AND
  operator-driven coordination) fired an interactive approval dialog
  on each fresh workspace — blocking the DR-023 UC-1 + UC-3 autonomy
  contract. Sister to macf#189 sub-item 2 (skill pre-approval) but
  for the MCP-tool surface the original install-time pre-approval
  missed. Operator-witnessed 2026-05-04 on PPAM 2026 macbook;
  cross-agent `notify_peer` worked but each fresh workspace prompted
  "Yes, and don't ask again for plugin:macf-agent:macf-agent -
  notify_peer commands" before delivery.

  Pattern: `mcp__plugin_<plugin-name>_<server-key>__<tool-name>`.
  New `PLUGIN_MCP_TOOL_PERMISSIONS` constant + new
  `MACF_MCP_TOOL_PATTERN_PREFIX` for stale-entry cleanup on refresh
  (lockstep semantic: drop-and-replace so a since-removed tool's
  pre-approval doesn't linger). Operator-authored `mcp__*` wildcards
  preserved verbatim. Path-2 promotion: future channel-server tools =
  one-line constant addition + CLI version bump.

  7 regression tests in `test/cli/settings-writer.test.ts` (constant
  shape, install on fresh workspace, lockstep with skill perms,
  operator-wildcard preservation, idempotency, stale-cleanup).

### Plugin
- 5 skills now (was 4): adds `/macf-agent:macf-notify-peer`. See
  Added → slash-command above. Marketplace mirror PR follows
  separately per established convention.

[#349]: https://github.com/groundnuty/macf/issues/349
[#350]: https://github.com/groundnuty/macf/issues/350
[#351]: https://github.com/groundnuty/macf/issues/351
[#352]: https://github.com/groundnuty/macf/pull/352
[#353]: https://github.com/groundnuty/macf/pull/353
[#354]: https://github.com/groundnuty/macf/pull/354

## [0.2.19] — 2026-05-03

Single hotfix release for a v0.2.18 wiring regression that silently
skipped the entire multi-file env layout migration on `macf update`.
Operator hit it on CV workspaces immediately after v0.2.18 publish.

### Fixed
- **`macf update --all --yes` migration block silently skipped
  ([#348], closes [#347])** — `index.ts` registered the
  `--no-migrate-env-files` option with an explicit `false` 3rd-arg
  default. Commander v14's `--no-<flag>` convention auto-defaults
  `opts.migrateEnvFiles` to `true` so the flag can flip it to `false`
  when passed. Adding the explicit `false` 3rd-arg CONFLICTED with the
  convention and made `opts.migrateEnvFiles` always-`false` regardless
  of whether the flag was passed. The action handler's translation
  `noMigrateEnvFiles = opts.migrateEnvFiles === false` then evaluated
  to `true` on every invocation. The migration block in `update.ts`
  (gated on `!opts.noMigrateEnvFiles`) skipped on every `macf update`
  call. v0.2.18 architectural release shipped its surface but not its
  operator-facing benefit.

  Empirically reproduced via standalone commander v14 test before
  applying the fix; verified the canonical (no 3rd-arg-default) form
  returns `migrateEnvFiles: true` by default.

  Fix: drop the `, false` 3rd-arg. Comment block in index.ts cites
  macf#347 + the framework-default-conflict gotcha.

  4 regression tests at `test/cli/no-migrate-env-files-flag.test.ts`:
  default-no-flag → `migrateEnvFiles=true`; with-flag →
  `migrateEnvFiles=false`; action-handler translation distinguishes
  both; **static source-shape regression** reads index.ts source +
  asserts the option line MUST NOT include an explicit 3rd-arg
  default (catches future re-introduction at unit-test time).

  Discipline lessons captured:
  - `feedback_commander_no_flag_default_conflict.md` — specific
    framework-convention gotcha
  - `feedback_silent_default_fallback_class.md` — class-level
    pattern covering 3 instances across 2 days (macf#332 +
    macf#335 + macf#347): default-fallback masks the actual surface
    failure; counter-discipline: source-shape tests +
    verify-actual-source-not-just-resolver-output

[#347]: https://github.com/groundnuty/macf/issues/347
[#348]: https://github.com/groundnuty/macf/pull/348

## [0.2.18] — 2026-05-03

Architectural release: multi-file env layout in `<workspace>/.claude/.macf/env.*`
replaces monolithic claude.sh inline-export approach. Operator-surfaced
during macf#340 thread; 4-PR sequence per #322 PR-A/B/C/D pattern.

### Added
- **Per-concern env files in `.claude/.macf/env.*` ([#343]/[#344]/[#345]/[#346],
  closes [#342])** — claude.sh refactored from monolithic generator that
  inlined ALL env exports into one ~500-line bash file → thin
  source-then-exec template (~80 lines) sourcing 7 per-concern files:
  - **macf-managed** (regenerated by `macf update` + warn-once on
    hand-edit): `env._helpers` (macf_settings_get + future helpers),
    `env.identity` (MACF_PROJECT/AGENT_NAME/AGENT_ROLE/AGENT_TYPE/
    WORKSPACE_DIR), `env.github` (App creds + GH_TOKEN mint + git
    author/committer; empty placeholder in local-mode per DR-024),
    `env.certs` (CA + agent cert + log paths), `env.registry`
    (MACF_REGISTRY_TYPE + per-type vars).
  - **operator-managed** (preserved by `macf update` unconditionally):
    `env.telemetry` (3 OTel mandatory gates + per-signal exporters +
    4-layer endpoint chain), `env.tmux` (MACF_TMUX_SESSION/WINDOW).
  - **library** (sourced first per alphabetical order): `env._helpers`
    using underscore-prefix-sorts-first convention (`_` 0x5F < lowercase
    a-z 0x61-0x7A).

  4-PR sequence:
  - **PR-A ([#343])**: 6 pure generator functions in
    `packages/macf/src/cli/env-files.ts`. No bin/init/update wiring; pure
    additive. 80 regression tests covering per-concern content shape,
    schema_version, headers, local-mode placeholder semantics.
  - **PR-B ([#344])**: thin claude.sh template sourcing
    `<dir>/.claude/.macf/env.*` glob; new `generateEnvHelpers()` +
    `writeEnvFiles()` orchestrator; `macf init` calls writeEnvFiles
    before writeClaudeSh. Plus follow-up commit `351e170` adding
    documented operator-custom convention (`env.local.*` / `env.zz.*`
    for post-canonical sort) + regression tests pinning the alphabetical
    sort + the convention-doc invariant. macf#340 tmux env-isolation
    (env-grep + -e flags) preserved.
  - **PR-C ([#345])**: `macf update` env-file refresh wiring (overwrite
    macf-managed + warn on hand-edit; preserve operator-managed) +
    monolithic claude.sh → multi-file auto-migration (detection-gated;
    `--no-migrate-env-files` opt-out skips all 3 coupled steps as a
    unit per safety contract). Option α (clean break with deprecation
    shim) for settings.local.json env block: runtime macf_settings_get
    still reads JSON env block (backward-compat structural); `macf
    update` emits one-time deprecation warning per invocation listing
    all deprecated keys. Operator manually migrates JSON keys to per-
    concern files at their convenience; auto-migration NOT included
    (risk-conservative).
  - **PR-D ([#346])**: `docs/configuration.md` (~270 lines) covering
    full per-concern layout + macf-managed/operator-managed boundary +
    file-by-file reference + operator workflows (OTLP endpoint, tmux,
    custom env vars) + operator-custom convention + rollback path
    (deferred PR-C nit) + Option α deprecation shim doc + cross-
    references. `docs/quickstart.md` "Customize observability endpoint"
    section. `docs/README.md` TOC update. claude.sh comment-block
    listing the 7 canonical files + extension model (descriptive labels
    rather than literal var names — preserves PR-B's "no inlined
    per-concern exports" regression-guard invariant).

  Test count: 1144 → 1252 (+108: 80 PR-A + 23 PR-B + 5 PR-B follow-up +
  34 PR-C; PR-D docs-only no test delta).

  Discipline notes captured during the cycle:
  - `feedback_jsdoc_close_substring_in_test_strings.md` — `*/`
    substring inside JSDoc comments closes the block early; vitest
    oxc-parser cryptic error. Sister-class to heredoc-backtick. Surfaced
    by PR-C subagent's initial test docstring `MACF_*/OTEL_*` →
    rewrote as `MACF_/OTEL_`.

  Deferred to v0.2.19 cycle: legacy `generateClaudeShMonolithic()`
  removal + auto-migration of settings.local.json env keys
  (deprecate-then-remove discipline; one release-cycle of safety net).

[#342]: https://github.com/groundnuty/macf/issues/342
[#343]: https://github.com/groundnuty/macf/pull/343
[#344]: https://github.com/groundnuty/macf/pull/344
[#345]: https://github.com/groundnuty/macf/pull/345
[#346]: https://github.com/groundnuty/macf/pull/346

## [0.2.17] — 2026-05-03

Single hotfix release for the tmux server-global env leak that broke
multi-agent-per-project deployments. Operator hit it on PPAM 2026
macbook (4-hour debug session with science-agent root-caused).

### Fixed
- **claude.sh tmux self-wrap env-isolation ([#341], closes [#340])** —
  when `tmux new-session` runs against an already-running tmux server,
  the new session's env initializes from the SERVER'S GLOBAL env (set
  once at server-start), NOT the calling shell's env. So a second
  `./claude.sh` from a different workspace inherited the FIRST agent's
  `MACF_AGENT_NAME` from server-global; the `${VAR:-default}` shortcut
  in the inner shell preserved the leaked value, causing
  AGENT_COLLISION on register. Bug latent since macf#313 (v0.2.10)
  introduced the self-wrap; only manifests in 2-agents-per-project
  deployments. PPAM 2026 paper-and-code workspaces hit it 2026-05-03.

  Fix: build `MACF_TMUX_E_ARGS` array dynamically from
  `env | grep -E "^MACF_"` and pass each via `-e VAR=VAL` to
  `tmux new-session`. Pattern-driven rather than hard-coded var list:
  - Single source of truth = the grep pattern (`^MACF_`)
  - Future MACF_* additions auto-included; no risk of forgetting to
    update a maintained list
  - Vars set AFTER the wrap (cert paths, App creds, OTel) are
    naturally absent from the wrap-time env — they're set fresh by
    inner re-execed shell, so no leak risk
  - Works in local mode without conditional logic (fewer pre-wrap
    vars; grep finds what's there; empty result → empty array →
    clean tmux invocation)
  - `|| true` after grep tolerates no-match case under
    `set -euo pipefail`
  - Doesn't pollute negative-string test assertions (no var names in
    template source)

  The actual leak surface is only `${VAR:-default}`-resolved vars
  set BEFORE the wrap = `MACF_AGENT_NAME` + `MACF_AGENT_ROLE`. Vars
  using unconditional `export` re-set per invocation regardless of
  any leak. Pattern-grep covers this surface cleanly.

  Architectural follow-up (multi-file env layout in
  `.claude/.macf/env.{telemetry,identity,github,certs}`) deferred to
  v0.2.18 per @macf-science-agent's note — broader scoping beyond
  this fix's bug-fix scope.

  7 regression tests at `test/cli/claude-sh.test.ts` describe
  "tmux self-wrap env-isolation (macf#340)": env-grep pattern emitted,
  read-loop appends `-e` flags, expansion into tmux invocation,
  attach-branch unchanged, opt-out gate preserved, same template
  across agent_name/role variations, defensive `|| true`. Plus 1
  existing test updated for the new multi-line shape.

[#340]: https://github.com/groundnuty/macf/issues/340
[#341]: https://github.com/groundnuty/macf/pull/341

## [0.2.16] — 2026-05-02

Single hotfix release for the GitHub-mode plugin-CLI token-staleness
class. Sister-shape to v0.2.11's macf#317 (which fixed the same
class in macf-channel-server) — the plugin-CLI subprocess was outside
that fix's scope, so operators with long-running Claude TUIs hit 401
on `/macf-peers` / `/macf-status` / `/macf-ping` / `/macf-issues`
after ≥1hr uptime.

### Fixed
- **`macf-plugin-cli` GitHub-mode token freshness ([#339], closes [#338])** —
  every `macf-plugin-cli` invocation runs as a short-lived npx
  subprocess from a Claude TUI parent. The subprocess inherits the
  parent's `GH_TOKEN` env, which is a 1hr-TTL bot installation token
  minted at TUI startup. After ≥1hr of TUI uptime, that env-token is
  stale and `generateToken()` returned it as-is (env-shortcut),
  causing 401 from GitHub Variables / Issues APIs. Operator hit it
  on CV workspace 2026-05-02 ~19:30Z (~24h TUI uptime).

  Two-part fix:
  1. **`generateToken()` `forceMint?: boolean` option** in
     `@groundnuty/macf-core/src/token.ts` — when `forceMint: true`,
     skip the GH_TOKEN env-shortcut and always mint fresh from
     APP_ID/INSTALL_ID/KEY_PATH (env or TokenSource). Backward-compat
     preserved: `forceMint: false` and undefined match pre-fix
     behavior.
  2. **`mintFreshGitHubToken()` helper** at
     `packages/macf/src/plugin/lib/fresh-github-token.ts` wraps
     `generateToken(undefined, { forceMint: true })` as a single
     declarative entry point. All 4 plugin-cli cases
     (status / peers / ping / issues) call the helper. Bin file no
     longer imports `generateToken` directly — the import boundary
     enforces the invariant.

  Why Option A (force-fresh per invocation) over Option B
  (`createRefreshAwareClient` mirror): plugin-cli subprocesses are
  short-lived (one CLI run per call), so the in-process 50min cache
  from macf#317's helper provides zero benefit across invocations
  (cache discarded with subprocess). Option A eliminates the
  staleness class entirely (no retry-on-401 needed).

  10 regression tests across two layers:
  - 5 `generateToken()` unit tests for `forceMint` option (forceMint
    true bypasses env, forceMint false preserves shortcut, throws
    actionably without App-creds, explicit TokenSource still wins
    under forceMint, undefined opts preserves backward-compat)
  - 3 source-level invariant tests at
    `test/plugin/lib/fresh-github-token.test.ts` pin the
    "no direct generateToken( in bin" rule + "exactly 4 helper call
    sites" + "helper imported from lib path"
  - 2 helper unit tests for `mintFreshGitHubToken()` itself

  Diagnosis discipline note: the original commit's `replace_all`
  matched only 2 of 4 sites (peers + ping) because their comment text
  matched verbatim; status's comment differed, so it was silently
  skipped. Caught by science-agent in PR review via
  verify-at-every-hop on the diff. Counter-discipline saved as memory
  `feedback_verify_after_replace_all.md`: when replace_all is meant
  to enforce a multi-site invariant, grep for residual unmatched
  sites BEFORE pushing. Refactor-to-helper + source-level invariant
  test is the structural form (this PR demonstrates).

[#338]: https://github.com/groundnuty/macf/issues/338
[#339]: https://github.com/groundnuty/macf/pull/339

## [0.2.15] — 2026-05-02

Single feature release: unified preview-then-prompt flow for `macf update`
replaces the per-candidate y/N loop. Operator-experience polish driven
by the friction of being asked y/N for each component sequentially.

### Added
- **`macf update` unified Proceed? prompt + `--confirm` flag ([#337],
  closes [#334])** — replaces per-candidate `confirmBump` loop with a
  single `confirmPlan` prompt that previews ALL pending bumps in one
  pass + asks one `Proceed? [y/N]:`. Behavior matrix:
  - Bare `macf update`: preview + single Proceed? prompt
  - `--confirm`: explicit alias for the new default (scripted-intent
    declaration; no behavioral change vs bare)
  - `--yes`: bypass prompt entirely (existing behavior preserved)
  - `--dry-run`: preview only, no prompt, no writes (existing
    behavior preserved)
  - `--all` / `--cli` / `--plugin` / `--actions`: scope select +
    prompt-bypass for backward compat with existing scripts

  Scope-narrowing note: canonical refreshes (rules / scripts /
  settings / claude.sh / sandbox / plugin repair) remain always-on,
  matching the existing `--dry-run` semantic where dry-run only gates
  version-bump writes — not canonical refreshes. Full plan-then-execute
  restructure (where Proceed? gates ALL writes including canonical
  refreshes) is out of scope; deferred to a follow-up if operator
  surfaces a concrete need.

  6 regression tests at `test/cli/update.test.ts` cover every branch
  of the behavior matrix. `node:readline.createInterface` mocked at
  file top so tests drive the prompt deterministically via
  `mockPromptAnswer`. 1121 → 1127 tests.

[#334]: https://github.com/groundnuty/macf/issues/334
[#337]: https://github.com/groundnuty/macf/pull/337

## [0.2.14] — 2026-05-02

Single hotfix release for a long-latent v0.1.x version-resolver typo
that surfaced when operator's CV workspaces tried to bump the cli pin
on the v0.2.13 cycle and got stuck. Companion fix to v0.2.13 (which
fixed local-mode dispatch but exposed this orthogonal cli-pin bug).

### Fixed
- **`macf update --all --yes` cli pin actually bumps now ([#336], closes [#335])** —
  two coupled fixes in `packages/macf/src/cli/`:
  1. **Primary (URL typo)**: `version-resolver.ts` `fetchLatestCliVersion()`
     fetched `https://registry.npmjs.org/@macf/cli` — but the actual
     package is `@groundnuty/macf` (typo from pre-`@groundnuty` org-scope
     days; latent since the original P5 design landed). The wrong URL
     always 404'd, classified as `not_published`, and the candidates
     filter in `update.ts` silently excluded the row. Operator's 4 CV
     workspaces stuck at older cli pins despite explicit `--all --yes`
     during the v0.2.13 cycle. Fix: use the correct package URL.
  2. **Secondary (operator-experience)**: `update.ts` summary path
     printed `Everything is up to date` even when one or more rows
     were silently filtered out due to fetch failure
     (`not_published` / `network_error` / `rate_limited` /
     `invalid_response`). Fix: distinguish "all OK + same" (existing
     bare summary) from "some rows in failure states" (explicit
     `Skipped due to fetch failure: <component> (<status>)` +
     `Other pins are up to date. See per-component status above for
     details.`).

  3 regression tests: URL assertion (pins the correct npm package URL
  so a future regression to `@macf/cli` or any other path fails
  immediately), skipped-rows summary path (cli URL returns 404,
  plugin/actions same → asserts new summary surfaces the skip), and a
  no-regression companion (all 3 ok+same → bare summary still prints).
  1118 → 1121 tests.

  Diagnosis discipline note: `FALLBACK_VERSIONS.cli = PACKAGE_VERSION`
  caused the operator's resolver-output table to show
  `Latest = 0.2.13` (the locally-installed version), masking the
  actual cause until I curl'd the URL directly. Verify-before-claim
  at every hop including resolver-output tables.

[#335]: https://github.com/groundnuty/macf/issues/335
[#336]: https://github.com/groundnuty/macf/pull/336

## [0.2.13] — 2026-05-01

Single hotfix release: critical regression fix for v0.2.12 local-mode
consumers. Operator hit it on the macbook PPAM 2026 deployment
immediately after v0.2.12 release-cut — `/macf-peers` /
`/macf-status` / `/macf-ping` failed in local-registry mode with
`No GH_TOKEN, no TokenSource provided, and missing APP_ID/INSTALL_ID/KEY_PATH`.

### Fixed
- **macf-peers / macf-status / macf-ping in local-registry mode ([#333],
  closes [#332])** — two coupled bugs in `packages/macf/src/plugin/bin/macf-plugin-cli.ts`:
  1. `getRegistryConfig()` ignored `MACF_REGISTRY_TYPE=local` and fell
     through to the `groundnuty/macf` default fallback. claude.sh
     correctly exports `MACF_REGISTRY_TYPE="local"` +
     `MACF_REGISTRY_PATH=<abs-path>` per PR #329, but the plugin's
     dispatch couldn't read those. Fix extracts `getRegistryConfig` to
     `plugin/lib/registry-config.ts` (testable; env-injectable
     signature) and adds the `MACF_REGISTRY_TYPE === 'local'` branch
     with fail-loud-on-missing-PATH diagnostic citing
     `macf init --local`. Local mode wins over GitHub-backed variants.
  2. `generateToken()` was called unconditionally before factory
     dispatch in 3 cases (status/peers/ping). Local mode has no GitHub
     App env (claude.sh `githubAppEnvLines` returns `[]` per DR-024),
     so `generateToken()` threw the operator-witnessed error. Fix
     applies the ternary gate `registryConfig.type === 'local' ? '' :
     await generateToken()` in each case — mirrors
     `channel-server/src/server.ts` line 210 pattern from PR #329.

  `issues` case left in scope as-is per AC (`/macf-issues` is
  GitHub-only by design; queries `gh api repos/...`; not coordination-
  shaped). 11 unit tests for `getRegistryConfig` covering all 4
  RegistryConfig variants + error paths + precedence ordering. 3
  integration-style tests at `local-mode-dispatch.test.ts` exercising
  the full env → config → factory → LocalRegistryClient → formatPeerTable
  path against a real tmp registry file with PPAM-shaped peer fixture.
  1102 → 1118 tests (+16).

  Test-coverage gap closed: pre-fix, `probe-peer-health.test.ts` and
  `build-dashboard-health.test.ts` (PR #326 + #328) tested helpers in
  isolation with mocked probes, and `init-local.test.ts` (PR #329)
  tested workspace bootstrap. Neither covered the runtime
  `macf-plugin-cli peers/status/ping` dispatch path in local mode —
  this PR's tests close that.

[#332]: https://github.com/groundnuty/macf/issues/332
[#333]: https://github.com/groundnuty/macf/pull/333

## [0.2.12] — 2026-05-01

Bundles 5 changes accumulated since v0.2.11. **Headline: DR-024
local-registry-mode delivered end-to-end** — laptop-local / education
/ demo / framework-development / air-gapped / CI-fixture deployments
now work without GitHub Apps. Sister-stub fixes for `macf-peers` +
`macf-status` MCP tools complete the v0.2.11 fleet bug-fix arc.

### Added
- **DR-024 local-registry mode ([#322], [#324] PR-A + [#329] PR-B + [#330] PR-C)** —
  4th `RegistryConfig` discriminated-union variant `{ type: 'local'; path: string }`.
  Implementation lands across 3 PRs:
  - **PR-A ([#324])**: `LocalRegistryClient` in `@groundnuty/macf-core` mirroring
    `GitHubVariablesClient`'s `Registry` interface. File-locked JSON read/write
    via `proper-lockfile` (parent-dir lock target — stable identity across
    file-creation boundary). Atomic write via temp-file-then-rename. FS-perms
    fail-loud at constructor (`0700` directory + `0600` ca-key). Schema
    versioning (`schema_version: 1`) with unsupported-version throw. Factory
    dispatch on `registry.type === 'local'`.
  - **PR-B ([#329])**: `macf init --local` shorthand alias for `--registry-type
    local`. App-cred flags (`--app-id` / `--install-id` / `--key-path`)
    optional under `--local`. `MacfAgentConfig.github_app` made optional in
    schema. Auto-CA generation on first invocation; CA co-located with
    registry file at `<dir>/<project>.ca.{crt,key}` (registry-dir IS the
    trust boundary per DR-024 — NOT under `~/.macf/certs/`). claude.sh
    template factored helpers (`githubAppEnvLines`, `caPathLines`,
    `githubTokenAndIdentityLines`) so each returns `[]` or local-mode-specific
    lines. `/sign` returns 404 with diagnostic body in local mode
    (discoverable-failure strategy from DR-024 §"Two viable disable
    strategies"). One-shot migration via `macf init --migrate-from <path>`
    (GitHub-direction-only; `--migrate-from + --local` rejected loudly).
  - **PR-C ([#330])**: `docs/use-cases.md` "When MACF without GitHub makes
    sense" subsection (5 use cases unlocked + honest limitations + verbatim
    trust-boundary statement + side-by-side decision matrix vs GitHub mode);
    `docs/quickstart.md` "Quickstart — local-registry mode" variant
    (two-agent bootstrap + mutual `/notify` test + what-did-NOT-happen
    differential + migration upgrade flow); `design/macf-consumer-onboarding.md`
    "Local-registry-mode bootstrap (DR-024)" section (requirements subset,
    bootstrap steps, channel-server local-mode behavior, verification gate,
    migration helper specifics, rollback paths); `docs/README.md` extended
    table-of-contents pointers.

  PPAM 2026 paper-and-code use case driver (operator surfaced 2026-05-01:
  "on my laptop I'm writing a paper and implementing code, too small project
  for full github events, but sufficient for 2 claude code sessions that
  could communicate directly").

### Fixed
- **`macf-peers` MCP tool self-probe ([#326], closes [#325])** — `peers` case in
  `macf-plugin-cli.ts` was a stub that mapped every peer to `health: null`
  without ever calling `pingAgent`. `formatPeerTable` renders `null` health as
  "offline", so operators saw "everything offline" even when channel-servers
  were running fine. CV-architect fleet hit this 2026-05-01 ~15:29Z (post
  v0.2.11 update). Fix extracts `probePeerHealth` helper at
  `lib/probe-peer-health.ts` mirroring the cert-path read + `pingAgent` call
  pattern from the `ping` case. `peers` case now uses
  `Promise.all(peers.map(probePeerHealth))` for parallel probing. Self-probe
  is just one entry in the registry list — same path. 7 regression tests.
- **`macf-status` MCP tool dashboard ([#328], closes [#327])** — sister-stub
  fix to [#326]. `status` case mapped every peer to `health: null` AND
  hardcoded `ownHealth: null` regardless of probe results, so `macf-status`
  rendered "everything offline" identically to broken `macf-peers`. Fix
  extracts `buildDashboardHealth` pure helper that takes injected probe
  function + own-registration + peers and returns
  `{ ownHealth, peersWithHealth }` for `formatDashboard`. Self-probe path
  invokes probe on `ownRegistration`. Stale `// Live-health self-ping
  tracked under #85` inline comment removed (#85 was specifically about the
  `macf-ping` skill stub, closed when ping case was wired up). 6 regression
  tests.

[#322]: https://github.com/groundnuty/macf/issues/322
[#324]: https://github.com/groundnuty/macf/pull/324
[#325]: https://github.com/groundnuty/macf/issues/325
[#326]: https://github.com/groundnuty/macf/pull/326
[#327]: https://github.com/groundnuty/macf/issues/327
[#328]: https://github.com/groundnuty/macf/pull/328
[#329]: https://github.com/groundnuty/macf/pull/329
[#330]: https://github.com/groundnuty/macf/pull/330

## [0.2.11] — 2026-05-01

Bundles 5 changes accumulated since v0.2.10: 1 Path-2 promotion (LGTM
gate PreToolUse hook), 1 silent-fallback hazard closure (in-runner
GH_TOKEN refresh — Instance 1 expiry sub-case), 1 reliability addition
(PreCompact checkpoint MCP tool — DR-023 §UC-3), 1 design decision
(DR-024 local-registry-mode), and 1 operations runbook.

### Added
- **`check-lgtm-gate.sh` PreToolUse hook ([#319], closes [#270])** —
  Path-2 promotion of `pr-discipline.md` "no LGTM = no merge" canonical
  rule. Bash-form PreToolUse hook intercepts `gh pr merge` invocations
  (with wrapper-aware regex coverage) and blocks the merge if no
  non-author APPROVED review exists on the PR. Mirrors PR #275's
  `check-mention-routing.sh` pattern commit-by-commit. Identity
  normalization handles `app/<bot>` vs `<bot>` vs `<bot>[bot]` API-shape
  variations. Override via `MACF_SKIP_LGTM_CHECK=1` for legitimate
  reporter-sanctioned exceptions per pr-discipline.md §"When the
  reviewer is absent or unreachable". 35 unit tests + settings-writer
  extension. Distributes via canonical scripts dir + extended
  `MACF_HOOK_FILENAMES` array.
- **PreCompact `checkpoint_to_memory` MCP tool + DR-023 §UC-3 amendment
  ([#320], closes [#271])** — DR-023 use case 3 implementation. Stop hook
  was wrong-cadence (fires per turn-end, not per session-exit/compaction);
  amendment migrates UC-3 to PreCompact event which fires before manual
  `/compact` AND auto-compaction. Tool writes structured session-summary
  checkpoint to the agent's memory directory using `originSessionId`
  frontmatter dedup (overwrite same-session, suffix on calendar-date
  collision). Failure-mode contract: tool returns `isError: false`
  always; soft-fail surfaces as `written: false` + `reason` structured
  fields; checkpoint failure NEVER blocks compaction. Memory-server
  framing in original spec was aspirational; actual impl is direct
  filesystem-write via per-project memory dir. 20 channel-server tests.
- **In-runner GH_TOKEN refresh in `macf-channel-server` ([#321], closes
  [#317])** — addresses cv-architect 67min-uptime hazard from 2026-05-01
  ~14:30Z (Stop hook 401 due to bot-installation-token 1hr TTL +
  channel-server inheriting fixed token at startup). Two-layer additive
  design: `createTokenRefresher` (50min cache, in-flight de-dup, ghs_
  prefix validation, fail-loud on mint error) + `createRefreshAwareClient`
  (decorates `GitHubVariablesClient` with pre-call refresh +
  401-retry-once-with-force-refresh). Both registry-client + /sign
  varsClient share one refresher instance. Tokens stay in-process;
  never written to env or leaked to child processes. Doctrine updated:
  `silent-fallback-hazards.md` Instance 1 expiry sub-case + new
  "Structural backstop" section in `gh-token-attribution-traps.md`.
  17 channel-server tests.

### Documentation
- **DR-024 local-registry-mode design decision ([#323], Refs [#322])** —
  339-line design doc for `MACF_REGISTRY_TYPE=local` 4th registry variant.
  Discriminated union extension + `LocalRegistryClient` + factory
  dispatch + threat model (same-host / trusted-LAN; NOT defense against
  external attackers; filesystem perms = trust boundary) + file format
  with `schema_version` + pre-shared local-CA cert flow (sister-DR to
  DR-010, NOT amendment) + routing trade-offs (no GitHub-driven routing;
  3 operator-discipline paths) + bidirectional migration path with
  bidirectional sync deferred + 5 use cases unlocked (laptop projects,
  education/demos, framework dev, air-gapped, CI fixtures) + first-class
  limitations section. Implementation deferred to follow-up PR sequence
  per the design-decision-first sequencing pattern. Cross-references
  DR-005, DR-010, DR-022, DR-023.
- **Stage 3 operations runbook ([#318], closes [#274])** —
  471-line living-doc at `design/operations-runbook.md` covering 7
  operational concerns: cert lifecycle (rotation triggers + symptoms +
  recovery via `macf certs rotate`/`recover`), port collisions
  (DR-007 range + reassignment), registration drift (org var staleness +
  reconciliation), missed notifications (Tempo trace inspection +
  fragility detector), mTLS handshake failures (cert expiry / CN
  mismatch / EKU rollout sequence), channel-server crash recovery
  (DR-022 SLA + stateless-across-restarts), routing-Action workflow
  debugging (silent-fallback Instance 3 family). Each section follows a
  consistent shape — Failure-shape / Detection / Diagnostic flow /
  Remediation / Known-gaps. Validity constants verified against source
  (crypto-provider.ts CA 5y / agent 1y; https.ts port range 8800-9799 /
  10 attempts). 14 DRs + silent-fallback-hazards Instances 3/6/7/8 +
  coordination.md cross-referenced; observability specifics
  cross-linked to `groundnuty/macf-devops-toolkit:CLAUDE.md` rather
  than duplicated. 7 explicit TODO gaps marked instead of fabricated.
- **Token-unit error reconciliation across docs/ + research/ ([#316],
  Refs [#315])** — operator first-user-mode review surfaced "10.5T
  tokens" as physically impossible on a Max x20 plan. Source unit error
  in `research/2026-03-28-token-usage-empirical-analysis.md`
  (`51d10bd`) corrected to "~10.5 billion cache reads" (off by 1000×
  factor — actual 10.26B cumulative cache reads + 6.8M output tokens =
  ~10.47B "effective input"); follow-up PR #316 propagated the
  correction across 11 occurrences in `docs/` + `research/` with audit
  trail.
- **README mass-refresh per first-user-mode operator review** — diagram
  redrawn for canonical-only state (no Stage 2 substrate caption);
  `agent-config.json` example updated to v3 canonical (just `app_name`,
  no SSH fields); Status section dropped Stage 2 substrate framing;
  observability appendix added with cross-links to
  `groundnuty/macf-devops-toolkit` (canonical k3d Tempo/Loki/Grafana
  topology); SSH framing clarified (admin/debugging only — no longer
  for routing); phone access corrected from "Tailscale" to "Claude
  Remote"; sprint stat refreshed (`162 PRs in 2026-04-17→05-01`);
  macf-actions tag bumped @v2 → @v3; DR count refreshed (19 → 23 incl.
  DR-022/DR-023). Lands across `eee105f` / `49c7cef` / `dfb83a8`.
- **CLAUDE.md refresh to v0.2.10 canonical state (`186309e`)** —
  Implementation Status updated; Path-2 promotions subsection added
  (#140 attribution-trap, #244+#272 mention-routing-hygiene, #313
  claude-sh tmux self-wrap, macf-actions#39 route-by-pr-review-state);
  observability section added (cross-link to
  `groundnuty/macf-devops-toolkit`); Where to Start When Debugging
  table extended with 4 new rows for current-state symptoms; test
  count refreshed (671 → 942).

[#270]: https://github.com/groundnuty/macf/issues/270
[#271]: https://github.com/groundnuty/macf/issues/271
[#274]: https://github.com/groundnuty/macf/issues/274
[#315]: https://github.com/groundnuty/macf/issues/315
[#316]: https://github.com/groundnuty/macf/pull/316
[#317]: https://github.com/groundnuty/macf/issues/317
[#318]: https://github.com/groundnuty/macf/pull/318
[#319]: https://github.com/groundnuty/macf/pull/319
[#320]: https://github.com/groundnuty/macf/pull/320
[#321]: https://github.com/groundnuty/macf/pull/321
[#322]: https://github.com/groundnuty/macf/issues/322
[#323]: https://github.com/groundnuty/macf/pull/323

## [0.2.10] — 2026-05-01

Bundles 5 changes accumulated since v0.2.9: 2 Path-2 promotions
(must-have-mention check + claude-sh tmux self-wrap), 1 silent-fallback
hazard closure (OTel DELTA temporality, Phase 2 of Instance 7), and 2
docs (consumer-onboarding reshape + 7-doc first-user `docs/` directory).

### Added
- **`docs/` first-user directory ([#312], closes [#311])** —
  7 cohesive docs covering quickstart + concepts + features + use-cases +
  troubleshooting + faq + glossary, plus a `docs/README.md` entry-point
  with Diátaxis-organized table + suggested reading order. Tone target:
  research-grade, citation-backed, honest about limitations; no marketing
  language. 1,736 insertions; 147 canonical-artifact references across the
  bundle. Distributes via repo-level `docs/` for first-user reading
  (not part of plugin distribution).
- **`check-mention-routing.sh` Check A — must-have-mention ([#309], closes [#244])** —
  Path-2 promotion of `coordination.md §Communication 2` ("@mention in EVERY
  comment. Routing depends on it. A comment without @mention is invisible
  to the recipient agent."). Single AWK pass extended to track BOTH
  per-line describing-leak (Check B; macf#272 unchanged) AND total
  routing-active mention count (new). If body has zero routing-active
  mentions, BLOCK with stderr explanation. Bypassed for `gh (issue|pr)
  close --comment` (self-close verification comments are reporter-internal,
  no recipient required). Same `MACF_SKIP_MENTION_CHECK=1` override
  covers both checks.
- **`claude.sh` self-wrap in tmux + settings-driven identity ([#314], closes [#313])** —
  Path-2 promotion of `coordination.md §Canonical tmux launch pattern`.
  Pre-#313, the canonical session-name rule existed as text-only doc that
  operators had to manually wrap `tmux new-session -d -s "<project>@<agent>"
  "./claude.sh"`. Post-#313, bare `./claude.sh` produces the same canonical
  session structurally — the launcher self-wraps in tmux when launched
  outside one (re-attach if exists, create if not). Three components:
  `macf_settings_get` bash helper (reusable JSON-reader for
  `.claude/settings.local.json`); 3-layer settings-driven identity
  (`MACF_AGENT_NAME` / `MACF_AGENT_ROLE` / `MACF_OTEL_ENDPOINT` —
  env > settings.local.json > baked default); tmux self-wrap with `$TMUX`
  + `MACF_NO_TMUX_WRAP=1` two-condition bypass. OTel endpoint extended to
  4-layer chain (settings.local.json layer added between template-time
  bake and runtime override).

### Fixed
- **OTel DELTA temporality ([#308], closes [#281] Phase 2)** —
  `OTLPMetricExporter` now constructed with
  `temporalityPreference: AggregationTemporality.DELTA`. Pre-fix, the SDK
  defaulted to CUMULATIVE temporality; process restarts between export
  cycles produced zero-resets in the cumulative trajectory in Prometheus
  storage. Empirical surfacing: scenario-08 N=5 sweeps produced counter
  values 1/5 of expected because process restarts broke the cumulative
  chain. Post-fix: each export interval emits increments-this-interval;
  process restarts produce independent delta points; OTel Collector
  aggregates by series identity to reconstruct cumulative — robust to
  N-process / restart topologies. Closes silent-fallback-hazards.md
  Instance 7 end-to-end.

### Documentation
- **Reshape stage2-to-stage3-migration → macf-consumer-onboarding ([#310], closes [#273])** —
  `git mv design/stage2-to-stage3-migration.md design/macf-consumer-onboarding.md`
  (history preserved). Audience explicitly stated: NEW MACF-consumer
  projects (CV agents, future macf-init'd workspaces); substrate workspaces
  out of scope per operator directive 2026-04-27. Section reframes:
  Pre-conditions → Requirements; Per-agent migration steps → Bootstrap
  steps; Rollback → Decommission + Rollback (separated); added Worked
  Example with cv-e2e-test rehearsal #11b/#12b/#13b citations; added
  cross-reference back-link from quickstart.md to consumer-onboarding.md.
- **`coordination.md §Canonical tmux launch pattern` updated ([#314])** —
  Notes the post-v0.2.10 self-wrap structural enforcement; pre-v0.2.10
  manual wrap form preserved as compat note for mixed-version fleets;
  `MACF_NO_TMUX_WRAP=1` opt-out documented alongside sister conventions
  (`MACF_OTEL_DISABLED=1`, `MACF_SKIP_TOKEN_CHECK=1`,
  `MACF_SKIP_MENTION_CHECK=1`).
- **`mention-routing-hygiene.md` §7 reshaped ([#309])** — enumerates both
  Check A (must-have-mention) and Check B (must-not-leak) with their
  subcommand-applicability + heuristic-bullet inclusion.
- **First-user docs entry section in root README ([#312])** —
  Cross-link to `docs/` directory + 7-doc index. Plus stale-content
  corrections: "Latest CLI release v0.1.1" → "v0.2.9"; "Design Decisions
  (19)" → "Design Decisions (23)"; coordination.md path corrected
  (post-monorepo).

[#244]: https://github.com/groundnuty/macf/issues/244
[#273]: https://github.com/groundnuty/macf/issues/273
[#281]: https://github.com/groundnuty/macf/issues/281
[#308]: https://github.com/groundnuty/macf/pull/308
[#309]: https://github.com/groundnuty/macf/pull/309
[#310]: https://github.com/groundnuty/macf/pull/310
[#311]: https://github.com/groundnuty/macf/issues/311
[#312]: https://github.com/groundnuty/macf/pull/312
[#313]: https://github.com/groundnuty/macf/issues/313
[#314]: https://github.com/groundnuty/macf/pull/314

## [0.2.9] — 2026-04-30

Bundles 6 changes accumulated since v0.2.8: 2 doctor enhancements, 1 hook
broadening, 1 regression test, and 2 canonical-rule clarifications.

### Added
- **`macf doctor` warns when `permissions.allow` missing Write/Edit ([#298], closes [#296])** —
  New "Workspace permissions" report section parallel to the existing Sandbox
  filesystem block. Surfaces the configuration drift class that blocks
  autonomous coordination via interactive permission prompts on first
  Write/Edit invocation. Severity classification: `BLOCK` (Write absent +
  no Bash fallback), `WARN` (tool absent + Bash fallback present), `INFO`
  (tool absent + deny rule present — deliberate). Doctor exit code unchanged
  by this check (warn-only). Empirical motivation: cv-architect blocked
  mid-test on a Write tool prompt during cv-e2e-test rehearsal #11b
  (2026-04-30) because `permissions.allow` lacked Write — sister
  cv-project-archaeologist had it; operator-authored drift.
- **`check-mention-routing.sh` HANDLE_PATTERN broadened beyond macf fleet ([#301], closes [#276])** —
  Generalizes from `@macf-*-agent[bot]` to `@<any-handle>[bot]` so the hook
  protects describing-context discipline across the full bot ecosystem:
  macf-* fleet, future CV fleet (`@cv-architect`, `@academic-resume-author`,
  similar shapes), future MACF-consumer fleets, AND third-party bots
  (`@dependabot`, `@github-actions`). First-char-letter constraint excludes
  invalid handle shapes (`@1bot[bot]`, `@_bot[bot]`, `@[bot]`).

### Fixed
- **`macf doctor` reads merged `settings.json` + `settings.local.json` for permissions ([#306], closes [#305])** —
  Pre-fix the doctor read only `.claude/settings.json` for the Write/Edit
  warning, but Claude Code merges `permissions.{allow,deny,ask}` arrays
  across both files (operators canonically place Write/Edit in
  settings.local.json since Claude Code TUI doesn't auto-rewrite that
  file). Post-fix `getPermissionsAllow` / `getPermissionsDeny` return the
  deduped union. Closes the false-positive WARN trap on workspaces where
  Write/Edit is canonically placed in the local override file
  (academic-resume + cv-project-archaeologist post-macf#302 workaround).

### Documentation
- **`coordination.md` closure-direction independence from fix-authorship ([#304])** —
  New "Inversion warning" subsection in §Issue Lifecycle 1 explicitly
  addressing the failure mode where the issue reporter delegates closure
  mechanics back to the implementer of a PR that addressed their issue.
  Names the substitution-mistake (fix-author ≠ reporter), enumerates the
  4 cases of `{filed, implemented} × {self, peer}` with explicit
  closure-owner per case, reinforces the `gh issue view --json author`
  self-check. Empirical motivation: 4 observed cross-agent occurrences
  (testbed#185 → macf#291 → macf#302 → macf#305).
- **`mention-routing-hygiene.md` §7 4-space-indent mechanism clarification ([#299], closes [#277])** —
  Documents that 4-space-indent code blocks pass the hook via the
  line-start addressing-allowance regex (NOT via code-block recognition).
  Triple-backtick passes via the adjacent-backtick check; 4-space-indent
  passes via leading-whitespace satisfying the line-start prefix regex.
  Same allowed outcome, different reasoning.

### Tests
- **Regression test: macf update preserves operator-authored allow entries ([#303], refs [#302])** —
  Locks in the round-trip preservation guarantee for `permissions.allow`
  through the 4 settings-writers (`installGhTokenHook` +
  `installPluginSkillPermissions` + `installSandboxFdAllowRead` +
  `installSandboxExcludedCommands`). Investigation of macf#302 confirmed
  macf-update is NOT the source of operator-entry drift on academic-resume
  (the 2:30 mtime gap and structural inconsistency of the after-state
  rule out macf as the writer); the regression test defends against any
  future refactor introducing a stripping bug.

### Investigation summary

The 6-change accumulation reflects the discipline-canonicalization
substrate-evolution cycle (per macf-science-agent's
`insights/2026-04-30-rehearsal-13b-empirical-witnesses.md`): cv-e2e-test
rehearsal #11b/#12b/#13b surfaced multiple coordination-discipline gaps;
each was addressed at one of the three promotion paths (Path 1 doc /
Path 2 hook / Path 3 detection). Rehearsal #13b reached 10/11 PASS
empirically validating the LGTM-routing structural defense.

[#296]: https://github.com/groundnuty/macf/issues/296
[#298]: https://github.com/groundnuty/macf/pull/298
[#277]: https://github.com/groundnuty/macf/issues/277
[#299]: https://github.com/groundnuty/macf/pull/299
[#276]: https://github.com/groundnuty/macf/issues/276
[#301]: https://github.com/groundnuty/macf/pull/301
[#302]: https://github.com/groundnuty/macf/issues/302
[#303]: https://github.com/groundnuty/macf/pull/303
[#304]: https://github.com/groundnuty/macf/pull/304
[#305]: https://github.com/groundnuty/macf/issues/305
[#306]: https://github.com/groundnuty/macf/pull/306

## [0.2.8] — 2026-04-30

### Documentation
- **Canonical `silent-fallback-hazards.md` rule ([#294], merges [macf-science-agent#9])** —
  New canonical rule file at `plugin/rules/silent-fallback-hazards.md` distributed via
  `macf init` / `macf update` / `macf rules refresh`. Codifies the 8-instance
  silent-fallback hazard class with 5 defense patterns (A — result-invariant
  assertion; B — dual-source corroboration; C — fail-loud chain; D — structural
  prevention; E — observational-only delivery). Includes the three promotion paths
  framework as an inline "When to apply Path 1 vs Path 2 vs Path 3" decision rule.
  Reaches consumer agents (CV, devops, science) only via this release — bundled-template
  architecture means rule changes require an npm publish to propagate beyond the macf
  monorepo.
- **`pr-discipline.md` formal-review-submission requirement ([#297])** —
  Adds a new "How to submit LGTM — formal review, not comment" section to
  `plugin/rules/pr-discipline.md`. Mandates `gh pr review --approve` /
  `--request-changes` (not `gh pr comment`) for state-change decisions.
  Engages `route-by-pr-review-state` (macf-actions v3.3.0+, [macf-actions#39]) — the
  Path-2 structural defense for the LGTM→merge handoff. Empirical motivation:
  cv-e2e-test rehearsals #9 / #10 / #11b completed with zero `pull_request_review`
  events firing because agents communicated approval via `gh pr comment`.
  CORRECT/WRONG worked examples + verification snippet
  (`gh pr view --json reviews | jq '[.reviews[] | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")] | last'`)
  + when `--comment` IS appropriate (mid-review clarifying questions, scope-of-change
  questions, parking-lot async discussion, review-pickup acknowledgment).

[#294]: https://github.com/groundnuty/macf/pull/294
[#297]: https://github.com/groundnuty/macf/pull/297
[macf-science-agent#9]: https://github.com/groundnuty/macf-science-agent/pull/9
[macf-actions#39]: https://github.com/groundnuty/macf-actions/issues/39

## [0.2.7] — 2026-04-30

### Added
- **`pr_review_state` `NotifyType` variant ([#293], part of [macf-actions#39] PR A)** —
  Receiver-side schema + handler chain for the `pr_review_state` notification that
  `@groundnuty/macf-actions` v3.3.0's `route-by-pr-review-state` job will produce.
  `NotifyTypeSchema` adds `'pr_review_state'`; `NotifyPayloadSchema` gains optional
  `review_state` / `reviewer_login` / `review_url` (`pr_number` + `pr_url` reused
  from the `ci_completion` variant). New `PrReviewStatePayloadSchema` for
  producer-side strict validation; `review_state` enum constrained to
  `{approved, changes_requested}` (`commented` + `dismissed` out-of-scope at
  v3.3.0). `notify-formatter.ts` renders `<reviewer> approved PR #N: <url>` /
  `<reviewer> requested changes on PR #N: <url>` with graceful degradation on
  partial fields. `tracing.ts` `operationNameForNotifyType` maps the new type to
  `'handoff'` (PR work-unit state-change routing — sister to `issue_routed`;
  distinct from `invoke_agent` reserved for addressed `@mentions` and
  `peer_notify` for framework-induced peer traffic). `onNotify` triggers
  tmux-wake (Pattern E observational-only applies only to `peer_notification`;
  PR-author SHOULD wake to merge or fix). Closes the LGTM→merge handoff gap
  that was the final cv-e2e-test cascade cause (test #9 + #10 evidence).

### Documentation
- **`macf update` flag semantics clarification ([#292], closes [#291])** —
  CLI `--description` + `update()` JSDoc + `update --help` extended block now
  document that `claude.sh` regeneration is unconditional (independent of
  `--cli` / `--plugin` / `--actions` flag selection); flags only gate
  version-pin bumps + plugin-dir re-fetch. The unconditional regeneration
  is correct + intentional per [#63] (template-evolution sync — landed
  specifically so workspaces pick up changes like [#60]'s `--plugin-dir`
  or [#283]'s `:4318` → `:14318` OTLP endpoint without re-running
  `macf init` from scratch). Pre-fix the docs implied flag-gated
  regeneration, causing devops-agent's diagnostic chain on `macf-devops-toolkit#62`
  to misread the v0.2.4 binary's behavior. Doc-only; no behavior change.

[#291]: https://github.com/groundnuty/macf/issues/291
[#292]: https://github.com/groundnuty/macf/pull/292
[#293]: https://github.com/groundnuty/macf/pull/293
[#60]: https://github.com/groundnuty/macf/issues/60
[#63]: https://github.com/groundnuty/macf/issues/63
[macf-actions#39]: https://github.com/groundnuty/macf-actions/issues/39

## [0.2.6] — 2026-04-29

### Fixed
- **Canonical claude-sh.ts hardcoded retired :4318 OTLP endpoint ([#283], closes [#282])** —
  `packages/macf/src/cli/claude-sh.ts` produced a `claude.sh` template that hardcoded
  `OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"` — the retired compose-stack port
  decommissioned 2026-04-25. Current k3d cluster topology uses `:14318` (host-port-mapped serverlb
  endpoint per `groundnuty/macf-devops-toolkit:CLAUDE.md`). All consumer-workspace telemetry was
  silently dropped pre-fix: TCP-connect-refused on `:4318`, OTel SDK retried quietly, no error
  surfaced. Surfaced 2026-04-27 during cv-e2e-test smoke (CV agents had 34min of zero traces
  + zero counters despite producing real coordination events). Two-part fix: (1) default endpoint
  `:4318` → `:14318`, (2) emit env-overridable `${OTEL_EXPORTER_OTLP_ENDPOINT:-<default>}` form
  instead of unconditional hardcoded export, so run-time `OTEL_EXPORTER_OTLP_ENDPOINT` in the
  launching shell wins per OTel canonical semantics. Two-layer override pattern documented:
  template-time `MACF_OTEL_ENDPOINT` (at `macf init` / `macf update`) bakes a custom default
  into `claude.sh`; run-time `OTEL_EXPORTER_OTLP_ENDPOINT` overrides per-launch. Closes
  silent-fallback-hazards.md Instance 8 distribution gap; CV consumers re-run `macf update`
  post-release to converge on canonical (transient local patches in `groundnuty/academic-resume`
  and `groundnuty/cv-project-archaeologist` get cleanly clobbered + re-generated with the canonical
  fix on next update cycle).

[#282]: https://github.com/groundnuty/macf/issues/282
[#283]: https://github.com/groundnuty/macf/pull/283

## [0.2.5] — 2026-04-27

### Added
- **OTel metric instrumentation in channel-server ([#280], closes [#278]; T6 closure on [testbed#242])** —
  `macf.notify_received_total{type, agent}` and `macf.notify_peer_total{event, delivered, agent}`
  counters via a new `MeterProvider` bootstrap alongside the existing `TracerProvider` in `otel.ts`.
  Same dynamic-import + `OTEL_EXPORTER_OTLP_ENDPOINT` env-gating + zero-cost-default doctrine (DR-021).
  Increments fire on validated `/notify` requests (server side) and per attempted peer in `notify_peer`
  broadcasts (client side; one increment per peer with `delivered=true|false` label for Prom rate
  computation). `PeriodicExportingMetricReader` at default 60s cadence; shutdown handler force-flushes
  both providers on SIGTERM/SIGINT. Closes the deferred T6 metrics AC from testbed#242 Phase D /
  Claim 1b synthesis.
- **PreToolUse hook for mention-routing-hygiene ([#275], closes [#272])** —
  `check-mention-routing.sh` distributed via canonical scripts directory; blocks `gh issue comment`
  / `gh pr comment` / `gh issue close --comment` invocations whose `--body` contains raw
  `@<bot>[bot]` mentions in describing-context positions (mid-line, not backticked, not at
  line-start). Implements `mention-routing-hygiene.md` §5 enforcement structurally per
  science-agent's empirical motivation (6 routing-hygiene class breaches in 1.5 days; codification
  caught ~80%; structural defense closes the 20% gap). Override: `MACF_SKIP_MENTION_CHECK=1`.
  Bash command-type hook (not mcp_tool) per the substrate-compatibility decision rule documented
  in DR-023 amendment ([#279]).

### Documentation
- **DR-023 substrate-compatibility amendment ([#279])** —
  Promotes the architectural insight from PR #275 to DR-level decision rule: `PreToolUse`-blocking
  hooks (UC-2 LGTM gate, UC-4 routing-leak) must use bash command-type form because mcp_tool hooks
  fail open (non-blocking) when the named MCP server is unavailable — permanent state on substrate
  workspaces, transient state on consumer workspaces. `Stop` / `SessionStart` best-effort hooks
  (UC-1 notify_peer, UC-3 checkpoint) keep mcp_tool form because failure-to-fire only loses an
  observability event there. UC-2 ([#270]) issue body reframed accordingly.

[#270]: https://github.com/groundnuty/macf/issues/270
[#272]: https://github.com/groundnuty/macf/issues/272
[#275]: https://github.com/groundnuty/macf/pull/275
[#278]: https://github.com/groundnuty/macf/issues/278
[#279]: https://github.com/groundnuty/macf/pull/279
[#280]: https://github.com/groundnuty/macf/pull/280
[testbed#242]: https://github.com/groundnuty/macf-testbed/issues/242

## [0.2.4] — 2026-04-27

### Reliability
- **Cross-agent loop in `notify_peer` (Option d, [#268], fixes [#267] Finding 2)** —
  Stop hook on agent A → notify_peer broadcasts → agent B's tmux wakes
  → B's LLM processes input → completes turn → B's Stop hook fires →
  notify back to A → loop. ~6s round-trip; 8 cycles in 50s observed
  during macf#256 v0.2.3 testbed validation before manual kill. The
  DR-023 §"Cycle prevention" same-agent `(server, tool, input)` dedup
  doesn't catch cross-agent ping-pong (each leg has its own MCP context).
  Fix: `server.ts` `onNotify` discriminates by payload type. For
  `type === 'peer_notification'` → MCP push only, tmux wake skipped.
  All other NotifyTypes preserve current wake-on-receipt behavior.
  Recipient SEES the notification (channel state via `/macf-status`)
  but doesn't auto-respond as a fresh turn → no Stop hook firing in
  response → no notify back. SessionStart polling-fallback (DR-020)
  catches missed notifications next session start.
- **Sender timeout 1s → 5s ([#268], fixes [#267] Finding 1)** —
  v0.2.3's 1s `notify_peer` timeout cut off mid-receiver-wake (~1050ms
  total per Tempo trace `6a4764e42ac5...` — `tmux_wake_delivered` alone
  was 1044ms). Sender reported `peers_delivered=0` even when delivery
  succeeded → unreliable structuredContent metrics. Bumped to 5s;
  Option d's tmux-wake-skip drops /notify response to ~5ms, so 5s is
  comfortable margin even for any future receiver-path latency.

### Features
- **Sender-side OTel span `macf.tool.notify_peer` ([#268], fixes [#267] Finding 3)** —
  v0.2.3 `notify_peer` invoked `httpsRequest` directly without OTel
  instrumentation → sender side invisible in Tempo (only receiver's
  `macf.server.notify_received` appeared). Fix: wrap body in
  `tracer.startActiveSpan(SpanNames.ToolNotifyPeer, CLIENT, ...)`. Span
  attributes: `gen_ai.operation.name=peer_notify`, `macf.notify.type`,
  `macf.notify.event` (session-end | turn-complete | error | custom),
  `macf.notify.target` (peer-name | "broadcast"),
  `macf.notify.peers_attempted`, `macf.notify.peers_delivered`. Phase
  D / Claim 1b cell-effect dimensions are now sliceable.
- **W3C traceparent propagation cross-channel-server ([#268], fixes [#267] Finding 4)** —
  v0.2.3 outbound POST had no traceparent header → receiver's
  `notify_received` span was a ROOT (no parent) → cross-trace correlation
  impossible. Fix: `notify-peer.ts` `postToPeer` injects via
  `propagation.inject(context.active(), headers)` before sending.
  Receiver-side extract was already in place from macf#194
  (`https.ts` calls `propagation.extract(context.active(), req.headers)`
  + uses as parent context for `notify_received` span). Result:
  receiver's `NotifyReceived` becomes a child of sender's `notify_peer`
  span; full cross-channel-server parent-child trace relationship.

### Docs
- **DR-023 §UC-1 inline amendment** documenting all 4 refinements
  (Option d observational semantic, cross-agent loop class, sender-side
  OTel span emission, traceparent propagation flow + 5s timeout
  rationale) — future implementers get the WHY for each post-hoc fix.

[#267]: https://github.com/groundnuty/macf/issues/267
[#268]: https://github.com/groundnuty/macf/pull/268

## [0.2.3] — 2026-04-27

### Reliability
- **`notify_peer` self-exclusion normalization ([#266], fixes [#256] Bug 1)** —
  `Registry.list()` returns names in GitHub Variables canonical form
  (`MACF_TESTER_1_AGENT` — uppercased + hyphens-to-underscores per
  `toVariableSegment`); `selfAgentName` is the canonical agent identity
  (`macf-tester-1-agent`). Raw string comparison never matched →
  broadcasts looped back to self → triggered the `(server, tool, input)`
  deduplication cycle DR-023 §"Cycle prevention" warns about. Bug surfaced
  during macf#256 v0.2.2 testbed validation (`peers_attempted=2` when
  registry had only 1 peer + self). Fix normalizes BOTH sides via
  `toVariableSegment` before comparison; applies to both single-peer
  (`to` short-circuit) and broadcast (filter list) modes.

### Features
- **`peer_notification` NotifyType ([#266], fixes [#256] Bug 2)** —
  v0.2.2 `notify_peer` POSTed `type: input.event` (e.g., `"session-end"`),
  but the `/notify` endpoint validates against the closed `NotifyTypeSchema`
  enum → HTTP 400 validation error. Per Option B (operator-authorized
  on macf#256), `peer_notification` is added as a dedicated NotifyType
  variant in `@groundnuty/macf-core` with a new narrow producer schema
  `PeerNotificationPayloadSchema`. `notify_peer` now sends
  `type: "peer_notification"`, `event: input.event`, `source: selfAgentName`.
  `notify-formatter.ts` renders the new type (`"Peer X reports event: Y"`
  or producer's `message`); `tracing.ts` `operationNameForNotifyType`
  maps to `peer_notify` GenAI op-name (distinct from `notify` /
  `invoke_agent` — preserves Phase D / Claim 1b cell-effect measurement
  clarity).

### Docs
- **DR-023 §UC-1 inline amendment** documenting both refinements
  (peer_notification payload variant + self-exclusion-must-normalize
  discipline) so future implementers get the WHY, not just the WHAT.
- **`packages/macf/plugin/hooks/hooks.json` server-reference fix** —
  bare `"server": "macf-agent"` → `"server": "plugin:macf-agent:macf-agent"`
  (Claude Code 2.1.x mounts plugin-provided MCP servers under that prefix;
  bare key resolves only against global registry → "not connected" error).
  Matches marketplace v0.2.2 fix.

[#266]: https://github.com/groundnuty/macf/pull/266

## [0.2.2] — 2026-04-27

### Features
- **`notify_peer` MCP tool ([#265], implements [#256] Sub 2 of Stage 3 master tracker [#254])** —
  new tool registered on `@groundnuty/macf-channel-server`'s MCP surface,
  invokable from the plugin's `Stop` hook (`type: "mcp_tool"`). Resolves
  peer agent's channel-server URL from the project registry, mTLS-POSTs
  to peer's `/notify` HTTP endpoint. Supports both single-peer mode (`to`
  argument) and broadcast mode (`to` absent → fan out to all registered
  peers, exclude self for cycle prevention). Per DR-023 §UC-1; refines
  the literal `to: z.string()` to `to: z.string().optional()` per the
  Option A impl-time scope refinement (universal hook entry, no
  per-workspace customization needed).
- **`McpServer` API uplift in channel-server** — switched from low-level
  `Server` to `McpServer` (canonical v1.x API per `@modelcontextprotocol/sdk`
  1.29.0). `pushNotification` path preserved via the underlying
  `mcp.server.notification` accessor for the Claude-Code-extension
  `notifications/claude/channel` method. Same wire behavior; new tool
  registration path enabled.
- **Plugin `Stop` hook entry** in `packages/macf/plugin/hooks/hooks.json`
  invoking `macf-agent:notify_peer` with `{event: "session-end"}`. Universal
  across consumer workspaces (no per-agent `to:` customization needed).

### Reliability
- **Self-exclusion cycle prevention** for `notify_peer` in both single-peer
  (`to === selfAgentName` short-circuit) and broadcast (registry.list filter)
  modes. Blocks the `(server, tool, input)` deduplication cycle DR-023
  §"Cycle prevention" warned about for universally-shipped hook inputs.

### Tests
- **789/789 unit + integration pass** (was 778; +10 new `notify-peer.test.ts`
  cases covering single/broadcast modes + cycle prevention + transport
  errors + partial-success aggregation; +1 `mcp.test.ts` for the new
  `.mcp` accessor on the channel surface).

### Docs
- **DR-023 §UC-1 inline update** documenting the Option A refinement
  (`to` optional + broadcast semantic + `isError` semantic asymmetry
  between single-peer and broadcast modes).

[#256]: https://github.com/groundnuty/macf/issues/256
[#265]: https://github.com/groundnuty/macf/pull/265

## [0.2.1] — 2026-04-26

### Reliability
- **Fallback-version regression for plugin manifest ([#260], fixes [#259])** —
  `FALLBACK_VERSIONS.plugin = '0.1.0'` was sticking consumers on the
  pre-DR-022 plugin manifest (`mcpServers.macf-agent.command: "node"`
  against `${CLAUDE_PLUGIN_ROOT}/dist/server.js`) when the version-
  resolver's network fetch fell through (anon GitHub API rate limit
  during bootstrap). The v0.1.0 manifest fails on Claude Code spawn
  with `Cannot find package '@modelcontextprotocol/sdk'` (deps land in
  `CLAUDE_PLUGIN_DATA`, node looks from `PLUGIN_ROOT`). v0.2.0
  marketplace plugin cut over to `npx -y @groundnuty/macf-channel-server`
  (DR-022 npm-dispatch), but the fallback never moved with it.
  Bumped to `'0.2.0'`. Empirical impact: testbed (`groundnuty/macf-testbed#229`)
  blocked at Phase C; substrate workspaces (macf#257 Sub 3) unable to
  bootstrap channel servers via `macf init`. Fix verified — tester-1
  channel server spawned (port 9777, instance `2a7f82`) + registry
  variable populated at `MACF_TESTBED_AGENT_MACF_TESTER_1_AGENT`
  timestamp `2026-04-26T22:25:11Z`. Test (`init-versions.test.ts:49`)
  updated to reference `FALLBACK_VERSIONS.plugin` constant instead of
  hardcoding (lockstep pattern per macf#216).

[#259]: https://github.com/groundnuty/macf/issues/259
[#260]: https://github.com/groundnuty/macf/pull/260

## [Unreleased]

Merged after the `v0.1.1` tag on 2026-04-20/21. Will be included in the
next tag (candidate `v0.1.2` unless a breaking change lands first).

### Security
- **Cross-repo absolute-path token refresh ([#161])** — `claude.sh`
  exports `MACF_WORKSPACE_DIR` and absolutizes `KEY_PATH`. 7 agent
  templates + workspace rules rewritten from `./.claude/scripts/` to
  `$MACF_WORKSPACE_DIR/.claude/scripts/`. Closes the 6th attribution-
  trap recurrence (cross-repo cwd variant).

### Reliability / CI
- **E2E workflow install step ([#156], fixes [#154])** — adds
  `make -f dev.mk install` before `test-e2e` on CI runners.
- **E2E self-close on green ([#166], fixes [#163])** — post-merge
  push + schedule runs auto-close open auto-opened incident issues
  when E2E passes. Machine-enforces the "stays open until green"
  contract.
- **E2E cert-tmpdir race + version-bump completeness ([#162], fixes
  [#160])** — `randomUUID()` suffix for parallel-safe temp dirs; 3
  missed E2E version assertions aligned with v0.1.1.
- **`INCIDENT_TITLE_PREFIX` env extraction ([#168])** — job-level env
  so auto-open + self-close share a single title-prefix source.

### Tests
- **Pre-commit commitlint hook ([#159], fixes [#158])** —
  `.githooks/commit-msg` + `make -f dev.mk install-hooks` target.
- **Real-SDK MCP smoke test ([#169])** — `test/mcp-integration.test.ts`
  with `CapturingTransport` verifies `notifications/claude/channel`
  reaches the transport. Catches silent SDK framing drift the mocks
  can't see.
- **Version-literal helper ([#167])** — `test/version-helper.ts`
  exports `EXPECTED_VERSION` from `package.json`; 5 test sites
  rewritten. Next bump is single-site.

### Docs
- **Coordination.md auto-opened-issue rule ([#165], fixes [#164])** —
  Issue Lifecycle rule 5 codifies `Refs #N` (not `Closes`) on bot-
  filed issues, explicit reviewer ping (not bot-reporter echo), and
  wait-for-green-before-close doctrine.
- **Post-session CLAUDE.md refresh ([#170])** — test count, security
  landings, scripts list, debugging table updated. Rule 5 staleness
  fix post-#166 merge.
- **Dogfood hook install ([#175])** — `.claude/scripts/check-gh-token.sh`
  added to match existing workspace-script convention.

[#154]: https://github.com/groundnuty/macf/issues/154
[#158]: https://github.com/groundnuty/macf/issues/158
[#160]: https://github.com/groundnuty/macf/issues/160
[#163]: https://github.com/groundnuty/macf/issues/163
[#164]: https://github.com/groundnuty/macf/issues/164
[#156]: https://github.com/groundnuty/macf/pull/156
[#159]: https://github.com/groundnuty/macf/pull/159
[#161]: https://github.com/groundnuty/macf/pull/161
[#162]: https://github.com/groundnuty/macf/pull/162
[#165]: https://github.com/groundnuty/macf/pull/165
[#166]: https://github.com/groundnuty/macf/pull/166
[#167]: https://github.com/groundnuty/macf/pull/167
[#168]: https://github.com/groundnuty/macf/pull/168
[#169]: https://github.com/groundnuty/macf/pull/169
[#170]: https://github.com/groundnuty/macf/pull/170
[#175]: https://github.com/groundnuty/macf/pull/175

## [0.1.1] — 2026-04-20

First release after the 2026-04-17 ultrareview + 2026-04-20 audit arc.
Eleven merges across five categories, covering attribution-trap
hardening, stale-dist detection, E2E backfill, and CI cadence. No
breaking changes; operators upgrading from 0.1.0 pick everything up on
next `npm link` rebuild (or via the new `macf self-update`).

### Security
- **PreToolUse hook blocks `gh` / `git push` on non-`ghs_` tokens
  ([#140], PR [#142])** — structural enforcement of the
  attribution-trap rule. Moved from operator-discipline to
  harness-enforced; blocks the command before it runs when
  `GH_TOKEN` is missing or user-scoped.
- **Hook covers shell-wrapper bypass paths ([#153], PR [#155])** —
  post-audit fixes for `bash -c "gh ..."`, `sh -c '...'`, `bash -x -c`,
  and combined-flag forms (`-xc`, `-exc`, `-lc`). Earlier regex missed
  the wrapping shell; now matches the whole wrapper → gh chain.

### Features
- **`macf self-update` command ([#144], PR [#146])** — for npm-link
  dev installs. Fetches origin/main, ff-merges, conditionally runs
  `npm ci` only when `package-lock.json` changed, then `npm run build`.
  Refuses dirty trees; clamps oversized status output.
- **Stale-dist detection in `macf update` ([#144], PR [#146])** —
  three-way freshness check: `dist/.build-info.json` stamp matches
  source HEAD → silent; stamp older → loud warning with SHAs + fix
  command; stamp missing or `unknown` commit → softer warning pointing
  at `npm run build`. Bootstrap-limitation documented: detection only
  helps versions from 0.1.1 forward.

### Tests
- **`/sign` E2E suite ([#137] Chunk 2, PR [#148])** — 14 cases
  covering the two-step DR-010 challenge-response, error-status
  mapping, endpoint-level gates, and transport edges. Resurrected
  the silently-broken E2E fixture as a side effect (no clientAuth
  EKU since the #121 gate landed; all E2E tests had been 403'ing for
  3 days without detection).
- **`/health` EKU-reject E2E ([#137] Chunk 3, PR [#151])** — 5 cases
  pinning the clientAuth-EKU gate invariants across `/health`,
  `/notify`, `/sign`, and unknown routes. Adds a no-EKU cert fixture
  to exercise the actual reject path that #121 was built for.
- **Weak-PRNG repo-wide guard (PR [#150])** — widened from `src/https.ts`
  only to `src/**/*.ts`. `Math.random` repo-banned; `crypto.randomInt`
  / `randomUUID` / `randomBytes` are the canonical sources.

### Reliability
- **Self-update output polish (PR [#150])** — dirty-tree error clamps
  to 20 status lines + `(N more; run \`git status\`)` footer for
  pathological cases (post-`rm -rf node_modules/` rebuild etc.).
- **`.claude/rules/` gitignored at source repo (PR [#150])** —
  `macf rules refresh` artifacts no longer trip the `macf self-update`
  dirty-tree check when run on the macf source repo itself.
- **CI install step before E2E ([#154], PR [#156])** — E2E workflow
  now calls `make -f dev.mk install` before `test-e2e`. Caught by
  the workflow's own auto-open mechanism within 1 min of the #152
  merge — feedback loop working as designed.

### CI
- **E2E suite runs on cadence ([#149], PR [#152])** — `.github/workflows/e2e.yml`
  fires on push-to-main (with paths filter) + daily 07:00 UTC + on
  `workflow_dispatch`. On failure, auto-opens (or appends to existing)
  `code-agent` / `blocked` issue with title-prefix dedup.

### Docs
- **`coordination.md` Issue Lifecycle rule 4: body is frozen during
  active work (#141, PR [#145])** — scope edits on an in-flight issue
  go as follow-up comments; body edits during active work silently
  shift the target under the assignee.
- **`coordination.md` Communication rule 3: verify your comment
  actually posted (#143, PR [#145])** — writing a review in prose
  isn't the same as posting it via tool; mandatory `gh issue view
  --json comments --jq '.comments[-1].author.login'` verification
  tail on any review-producing turn.
- **Top-level `README.md` (PR [#147])** — architecture overview,
  setup walkthrough, dogfooding evidence, related-repos section,
  example configs appendix. Reviewed + corrected for CLI flag names,
  DR file paths, empirical claims.

### Dependencies
- **`hono` 4.12.12 → 4.12.14** — transitive via `@modelcontextprotocol/sdk`
  → `@hono/node-server`; closes GHSA-458j-xx4x-4375 (moderate HTML
  injection in hono/jsx SSR; not exploitable in MACF's usage but cleanest
  to stay on supported version).
- **`@modelcontextprotocol/sdk` pin `^1.12.1` → `~1.29.0`** — previous
  caret-range allowed 17 minor-version silent drift. Patch-level range
  now requires deliberate `package.json` edit to accept new minors.

### Meta
Companion cross-repo fix in `groundnuty/macf-actions` PR #14 closes
[`groundnuty/macf-actions#13`][mamt-13] (regex → fixed-string match
for mention routing). Filed from the same audit sweep.

[#137]: https://github.com/groundnuty/macf/issues/137
[#140]: https://github.com/groundnuty/macf/issues/140
[#141]: https://github.com/groundnuty/macf/issues/141
[#143]: https://github.com/groundnuty/macf/issues/143
[#144]: https://github.com/groundnuty/macf/issues/144
[#149]: https://github.com/groundnuty/macf/issues/149
[#153]: https://github.com/groundnuty/macf/issues/153
[#154]: https://github.com/groundnuty/macf/issues/154
[#142]: https://github.com/groundnuty/macf/pull/142
[#145]: https://github.com/groundnuty/macf/pull/145
[#146]: https://github.com/groundnuty/macf/pull/146
[#147]: https://github.com/groundnuty/macf/pull/147
[#148]: https://github.com/groundnuty/macf/pull/148
[#150]: https://github.com/groundnuty/macf/pull/150
[#151]: https://github.com/groundnuty/macf/pull/151
[#152]: https://github.com/groundnuty/macf/pull/152
[#155]: https://github.com/groundnuty/macf/pull/155
[#156]: https://github.com/groundnuty/macf/pull/156
[mamt-13]: https://github.com/groundnuty/macf-actions/issues/13

## [0.1.0] — 2026-04-15

Initial release. Phases P1–P7 from the design doc set landed; CLI,
channel server, registry, certs, plugin distribution, routing workflow
all shipped. See `design/decisions/` and `design/phases/` for the
architectural context; see the Git log for the ~60 merges from the
2026-04-15 → 2026-04-17 development sprint.
