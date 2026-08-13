# Silent-Fallback Hazards (canonical, shared)

**This file is the single source of truth for recognizing the silent-fallback hazard class — failure modes where tool/API operations succeed at the API boundary but produce semantically wrong outcomes that are invisible until something downstream breaks.** It is copied into each agent workspace's `.claude/rules/` by `macf init` and refreshed by `macf update` / `macf rules refresh`. Do not edit workspace copies directly — edit the canonical file at `groundnuty/macf:packages/macf/plugin/rules/silent-fallback-hazards.md` and re-run the distribution.

> **Workspaces without full `macf init`** (e.g. `groundnuty/macf` itself, or any Claude Code workspace operated by a bot that isn't a MACF-registered agent) can still get this canonical rule via `macf rules refresh --dir <workspace>`. Same copy, no App credentials or registry required.

This rule names the CLASS so agents recognize the shape on first encounter rather than re-discovering each instance from scratch. Nineteen active instances are documented below as worked examples spanning different architectural layers (identity, parsing, TUI binding, observability routing, config substitution, multi-agent coordination protocol, metric-instrumentation lifecycle, observability-endpoint routing, release-pipeline-partial-publish, third-party-action retry-exhaustion, credential-refresh temporal-binding, multi-agent review-gate routing, notification-payload-anchor, channel-flag gating, CA-rotation out-of-band blast radius, health-check-proxy-not-invariant, routing-table dual-role, stale-copy currency (generated artifacts and cited facts), subject misidentification, reads and writes). (Instance 10 — a legacy substrate-routing receipt-gap — was retired 2026-06-07; its number is kept, not reused.) Seventeen of eighteen active instances have structural defenses applied or in flight — the pattern of defense generalizes alongside the pattern of hazard.

Instance 9 is annotated as **sister-shape** (failure correctly surfaced + partial side-effect breaks retry idempotency) — listed here for cross-reference convenience but warrants a sibling canonical rule (`partial-side-effect-hazards.md`) if more instances surface. The two classes share "multi-step pipeline where consumer assumes atomicity" but the failure surface differs: silent-fallback hides at the API boundary; partial-side-effect surfaces loudly but persists semi-state.

---

## The hazard shape

```
API call → exit 0 / HTTP 200 / no error
         → semantic outcome: WRONG identity / scope / target
         → downstream consumer assumes API success implies semantic success
         → failure invisible until something breaks elsewhere
```

The trap is that defensive programming targets exit codes, but exit-code success is satisfied by the silent-fallback path. Defenses must guard at the **result-invariant level** (what was actually written / posted / received), not at the **exit-code level**.

---

## Known instances

### Instance 1 — gh-token attribution traps

**Surface:** `gh` operations + bot installation tokens
**Failure shape:** broken/missing `GH_TOKEN` → silent fallback to stored `gh auth login` user → ops succeed, content correct, but `actor` on the resource is the human-operator account, not the bot
**Recurrence:** 5+ confirmed instances across multiple agents
**Canonical defense:** `gh-token-attribution-traps.md` (sister canonical rule) — 6 specific failure modes + result-invariant defenses (`[[ "$GH_TOKEN" == ghs_* ]]` prefix check, `macf-whoami.sh` spot-check, PreToolUse hook intercepts `gh` and `git push` invocations)

**Sub-case (expiry, macf#317, 2026-05-01):** Bot installation tokens have a **1-hour TTL by design** (GitHub App contract). `claude.sh` mints a fresh token at session start and exports `GH_TOKEN`; the macf-channel-server child process inherits that same env var via standard Node `process.env` pass-through. **Without an in-runner refresh, every gh-API-using handler 401s after ~60 minutes of session uptime.** Detection: 401 (`Bad credentials`) on `listVariables` / `readVariable` / `writeVariable` calls 60+ min after server start. Witnessed 2026-05-01 ~14:30Z on cv-architect's Stop hook at ~67min uptime — the operator-witnessed incident motivating macf#317.

This is a distinct sub-case from the missing-helper / mis-pipefail / wrong-prefix attribution-trap modes catalogued in `gh-token-attribution-traps.md`: the agent has the right token *shape* (`ghs_*`) but it's stale. The hazard is structural — session lifetime ≠ token lifetime by design (1hr vs ∞), so any long-running agent eventually hits this.

**Defense (macf#317, v0.2.11):** in-process token-refresh helper in macf-channel-server (`src/token-refresh.ts`) caches `{token, mintedAt}`; on every `getRefreshedToken()` call, returns cached if `age < 50min` (10-min safety margin under 1hr TTL), else mints fresh via `macf-gh-token.sh`. The refresh-aware client wrapper (`src/refresh-aware-client.ts`) decorates `GitHubVariablesClient`: every method call gets a refreshed token; on 401, force-refreshes + retries once. Refresh failures throw with diagnostic — never silently fall back to the stale env-var token. Sister-shape: `macf-testbed#135` (sweep-harness in-runner refresh between iterations; closed/deferred for testbed but the channel-server class needed structural defense).

### Instance 2 — GitHub auto-close negation-blindness

**Surface:** PR / issue body markdown parsing
**Failure shape:** `Closes #N` / `Fixes #N` / `Resolves #N` (and lowercase / past-tense variants — 9 forms total) trigger GitHub's auto-close on merge **regardless of surrounding context** — including inside negations ("will NOT close #N"), quotes, hypothetical examples, or AC checklists. Markdown structure is not a shield — the parser scans raw body text, so a **markdown table cell or coordination checklist that DOCUMENTS the closure protocol itself** (e.g. a who-closes-when row reading `| Close #N when ACs satisfied | reporter | … |`) is a high-frequency variant — the very act of writing down reporter-owns-closure fires the premature close it describes. Revert commits inherit the keyword via the default `Revert "..."` wrapping and fire auto-close a second time on the revert merge.
**Recurrence:** Multiple confirmed incidents; revert-message-keyword-inheritance sub-mode confirmed 2026-04-29; closure-protocol-table-cell sub-mode confirmed 2026-05-20 on `macf#406` (Phase-5 tracking issue auto-closed 2 s after PR #410 merged, attributed to the merger with `commit_id: null`, **premature against an 8-item operator checklist**, and **~2 weeks undetected** — a peer's "stays OPEN" comment 10 min later did not catch it).
**Canonical defense:** `pr-discipline.md` + `coordination.md §Issue Lifecycle 1` — use `Refs #N` exclusively when issue was filed by someone else; never use any of the 9 auto-close keywords with `#N` regardless of intended context. When reverting, override the default revert message to strip the inherited keyword. **When a PR body must DESCRIBE closure mechanics (tables, checklists, protocol notes), lead with the issue number and a non-keyword verb (`#N is closed by the reporter once ACs met` / `reporter handles closure of #N`) — never place a `close`/`fix`/`resolve` verb immediately before `#N`.** Grep the drafted body for the keyword-then-`#N` pattern before posting. **Structural backstop (SHIPPED, groundnuty/macf#431):** the `check-close-keyword.sh` PreToolUse hook now intercepts `gh pr create` / `gh pr edit` whose body or title carries a close-keyword adjacent to a `#N` (or cross-repo `owner/repo#N`) filed by another agent — resolves the referenced issue's author via `gh api` and blocks with `exit 2` unless it is self-filed (override: `MACF_SKIP_CLOSE_CHECK=1`). This moves the defense from grep-discipline to the harness, after 4 self-inflicted recurrences (macf#316/#410/#430) proved cognitive discipline insufficient — same Path-2 promotion as the #140 / #244+#272 / #270 hooks.

### Instance 3 — the tmux-wake keystroke is swallowed by an alternate input consumer (RC-IPC-binding OR a modal input state)

**Surface:** the channel-server's `wakeViaTmux` nudge (and any `tmux send-keys` routing) into a Claude Code TUI pane. `tmux_wake_delivered` logs success once the keystrokes are *sent* — but "sent to the pane" is not "submitted as a prompt" if some **other consumer owns the pane's input** at that instant. Two verified sub-shapes:

- **Sub-shape A — Remote Control IPC binding.** In a session with "Remote Control active", Claude Code's input handler is bound to a different IPC channel (RC's SDK socket); `send-keys` exits 0 + writes to pane stdin, but the actual input path is bypassed → the recipient never sees the routed prompt. (Cross-agent triangulated; 2+ confirmed firings on real routes hours apart.)
- **Sub-shape B — a modal input state (verified 2026-07-05, `/login`).** When the pane is in a **modal** at the moment the wake fires — a `/login` dialog, the "How is Claude doing this session?" rating survey, or a permission / plan-mode / ceremony prompt (e.g. the `--dangerously-load-development-channels` prompt of macf#703) — the keystrokes are **consumed by the modal instead of submitted as a message**, and the notification is **lost outright** (not merely delayed). Confirmed live: `icsoc-2026/science-agent` lost a PR #5 re-approve ping — routing + channel worked end-to-end (`notify_received → mcp_pushed → tmux_wake_delivered %377`; the router run logged `Routed mention … HTTP 200`), but science was mid-`/login` when the wake fired — its pane showed `❯ /login → Login successful` exactly where the ping would have submitted, and it never saw the request. **Distinct from a busy-mid-turn wake, which QUEUES and survives** (macf#481 settled that a mid-turn ping survives `C-u`); a *modal* CONSUMES the keystrokes rather than queueing them.

**Recovery / why it's silent-fallback:** every layer reports success (`tmux_wake_delivered`, HTTP 200) while the recipient processed nothing; only the recipient's own pane or the `from_cn:unknown` / no-response evidence reveals the gap. The message DOES reach the MCP channel (`mcp_pushed`), so it is recoverable **iff native channels are registered** (Instance 15 / macf#641). With `tmux_wake` as the ONLY live delivery path (channels not yet registered fleet-wide), an alternate-input-consumer loses it.

**Defense status:** per fleet class, plus two structural fixes that cover BOTH sub-shapes:
- **Native channels (macf#641) — load-bearing.** Delivery via the MCP channel is independent of tmux input state, so neither an RC binding nor a modal can swallow it. This is the structural end-state; once channels are registered fleet-wide the send-keys path stops being the sole delivery.
- **Modal auto-clear (macf#703 / DR-033 auto-responder) — covers sub-shape B.** The prompt-auto-responder should clear `/login` + the rating survey (+ ceremony prompts) so the input line is ready when a wake lands; its seed set must cover these, not just the channels prompt.
- **Consumer fleet** (CV agents, tester agents, macf-init'd consumers): sub-shape A's *content*-drop is retired — the routed message arrives via the channel-server's HTTP/MCP path regardless of RC state (DR-020 / macf-actions v3+); the **residual** is the `wakeViaTmux` nudge (send-keys) not landing under RC-bound OR modal input → message sits in the MCP channel until the agent next reads it (a wake-latency issue), UNLESS channels aren't registered, in which case sub-shape B loses it outright (the #641 gap).
- **Substrate fleet** (design-surface workspaces, no `macf init`): permanent operational reality. Defensive posture: rule-discipline + Pattern C fragility detector (capture-pane content-diff over a window — NOT `#{session_activity}`, which doesn't reliably advance on agent activity; see Pattern C's 2026-06-28 correction). Recipient-side discipline: on a suspected missed ping, **sweep GitHub state** rather than trust the (missing) wake.

The substrate fleet expects Instance-3 firings (both sub-shapes) to recur on routes until channels are registered fleet-wide (#641); rule-discipline + Pattern C catch the failure at observation time, not pre-emptively.

### Instance 4 — Loki / ClickHouse-logs pipeline divergence (label-vs-structured-metadata)

**Surface:** OTLP logs pipeline routing through central Collector → Loki + ClickHouse-logs
**Failure shape:** Loki only indexes a small set of labels (`service_name`, `service_namespace`, `k8s_*`); other OTLP resource attrs land in structured metadata, NOT as indexed labels. Loki query selector `{gen_ai_agent_name=...}` returns 0 streams silently — same data is visible in ClickHouse via Map-key access. Snapshot scripts that query Loki by an unindexed key return zero results while the parallel ClickHouse query returns full rows. Silent split where the same pipeline produces inconsistent retrieval shape across consumers.
**Recurrence:** Surfaced during phase-1 verification on a multi-tester scenario.
**Structural defense:** observability-snapshot scripts use `service_name` indexed label for the common `gen_ai.agent.name` filter case + structured-metadata fallback (`{service_name=~".+"} | <key>="<value>"`) for other keys + manifest warnings array detecting Loki/CH divergence at >10× ratio with shape-aware diagnostic per failure mode.

### Instance 5 — Workflow secrets-misnamed (operator-renames vs workflow-expects)

**Surface:** GitHub Actions workflow consuming `secrets.X` / `vars.Y` references
**Failure shape:** When an expected secret is missing or renamed (e.g., workflow expects `TAILSCALE_OAUTH_CLIENT_ID` but the operator created `TS_OAUTH_CLIENT_ID`), `${{ secrets.TAILSCALE_OAUTH_CLIENT_ID }}` substitutes empty string at action invocation time. The downstream tool surfaces a misleading error (auth fail at the consumer step) rather than the actual root cause (missing secret).
**Recurrence:** Surfaced via 3 confirmed workflow runs of confusing errors before the precheck-step pattern was introduced.
**Structural defense:** Workflow precheck step (runs after `checkout`, before any tool that consumes the secrets) pulls all expected secrets + vars into env, empty-string-checks each, aggregates missing names into one `::error::` annotation per missing input + runbook reference, exits 1 on any missing. Aggregate-fail-loud over fail-on-first-miss so the operator sees ALL gaps in one workflow run.

### Instance 6 — Cross-agent notification loop (multi-agent coordination protocol layer)

**Surface:** `type: "mcp_tool"` Stop hook + `notify_peer` broadcast tool deployed end-to-end (DR-023 UC-1)
**Failure shape:** Each individual operation succeeds at the API boundary (HTTP 200 from `/notify`, MCP push completed, `tmux_wake_delivered` logged). But the protocol has no termination condition for "peer notification triggers fresh turn → fresh turn fires Stop hook → Stop hook notifies peer." The platform's same-agent recursion guard (`(server, tool, input)` deduplication) catches recursion inside a single agent's MCP context; cross-agent recursion bypasses dedup because each agent has its own dispatcher state. Empirical observation: 8 cycles in 50s before manual termination.
**Architectural origin:** design-assumption mismatch — peer notifications were intended as informational (no auto-action) but the receiver's `/notify` handler triggered tmux-wake-on-receipt, turning notifications into programmatic prompts.
**Structural defense:** Pattern E (event-discriminator at receiver) shipped in macf v0.2.4 (initial type-based form) → refined to event-based discrimination in v0.2.21 (macf#355). Receiver's `decideWake()` reads the payload's `event` field directly: `event: 'custom'` (operator-driven slash-command per macf#350) wakes the receiver TUI; autonomous events (`session-end` / `turn-complete` / `error` from Stop-hook flows) skip wake with explicit log entry. Other `NotifyType`s (`issue_routed`, `mention`, `ci_completion`, `pr_review_state`, `startup_check`) preserve current wake-on-receipt behavior. Verified via clean post-fix trace (single 3-span trace where the prior version had 8 alternating cross-agent spans).

The v0.2.21 refinement (#355) replaced an interim `wake?: boolean` payload field (#351) with event-based discrimination. The boolean leaked Pattern E loop-prevention logic into every sender's API surface; the cleaner design keeps the policy at the receiver and reads from a property that's already present for other reasons (`event`). One-release-cycle window (v0.2.20 → v0.2.21 was 30 minutes) made the fast-follow refactor possible without a deprecation cycle.

### Instance 7 — OTel-counter cumulative-state assumption violated by short-lived process lifecycle

**Surface:** OTel cumulative-temporality counters in processes whose lifetime doesn't match the cumulative-counter contract (e.g., `macf-channel-server` runs as Claude Code's MCP subprocess; lifetime = Claude session lifetime; multiple sessions spawn fresh processes each starting counter at 0).
**Failure shape:** Counter increments emit fine via OTLP (HTTP 200 from Collector). Series identity (same labels: `macf_agent`, `macf_notify_type`, etc.) collides across short-lived process generations. Prometheus's cumulative-counter assumption sees the latest scrape value (often `1` per fresh process) rather than the true accumulated count (e.g., `5` events across a 5-iter sweep). `rate()` / `increase()` queries handle the resets correctly within scrape windows, but raw counter values become near-meaningless.
**Recurrence:** First observed instance, surfaced via T6 metrics runtime verification.
**Defense status:** Two-phase plan. **Phase 1** (immediate): document `sum(increase(metric[range])) by (labels)` as the canonical query pattern in operations runbook + add comment in `metrics.ts` explaining the per-session lifetime characteristic. **Phase 2** (in flight): configure OTel SDK delta temporality — `OTLPMetricExporter({ temporalityPreference: AggregationTemporality.DELTA })`. Each process exports its own deltas; OTel/Collector aggregates by series identity → cumulative count correct regardless of process topology. Verified robust to both "1-process-per-session-restart" and "N-parallel-processes-per-tester" topologies.

### Instance 8 — Telemetry-endpoint silent-drop on retired/wrong-port OTLP target

**Surface:** OTel exporter pointed at a retired or otherwise non-listening endpoint (e.g., a stale `:4318` after compose-stack retirement when the current cluster is on a different port).
**Failure shape:** `claude.sh` exports cleanly (no error). Claude Code's OTel exporter dispatches traces/metrics/logs to the configured endpoint → TCP connect refused → exporter silently retries-then-drops (no surfaced error in stderr; no log entry in operator-visible logs). Agents continue to function normally — coordination events fire, channel-server delivers notifications, GitHub artifacts get created. **The observability surface is empty** (no traces in Tempo, no metrics in Prometheus) but no failure signal at any layer.
**Recurrence:** First observed instance, surfaced via end-to-end smoke test (consumer agents ran for 34 minutes producing real coordination events but Tempo + Prometheus had zero traces and zero metric series for the test window).
**Defense status:** Five architectural surfaces (Layer 1 + Tiers 1-4) — paper-grade artifact for the methodology section.
- **Layer 1 (CLI release-discipline):** `macf update --help` documents always-on template-sync semantics; downstream tooling (e.g., e2e tests) pin the macf binary version with `npx -y @groundnuty/macf@<pin>` to prevent stale-CLI-binary clobbering of canonical templates.
- **Tier 1 (substrate testers):** env-override pattern — `OTEL_EXPORTER_OTLP_ENDPOINT=<correct-endpoint>` set before `claude.sh` runs.
- **Tier 2 (consumer canonical):** canonical `claude-sh.ts` produces a **two-layer override** form: template-time bake via `MACF_OTEL_ENDPOINT` + run-time override via `OTEL_EXPORTER_OTLP_ENDPOINT` + canonical default pointing to the current cluster.
- **Tier 3 (cluster-side compatibility port-map):** k3d serverlb persists host-port mappings for legacy ports, so any stale `claude.sh` predating the canonical-template fix routes correctly without re-bootstrap.
- **Tier 4 (agent-process exporter-state):** long-lived agent processes started during a connect-refused window have their bundled OTel SDK retry budget exhausted and don't auto-recover. Operator remediation: graceful relaunch (fresh OTel exporter state via fresh process). Detection: `doctor-otel.sh` queries each running claude process's `OTEL_SERVICE_NAME` from `/proc/<pid>/environ` against Tempo and reports stuck processes.

**Pattern A defense template:** result-invariant check at the observability boundary — assert "trace count > 0 in Tempo for the test window" before considering the run telemetered. Mirrors the gh-token-attribution Pattern B (pre-flight state validation) shape applied to the OTLP boundary instead. Two concrete script implementations form the complete result-invariant assertion surface for the OTLP-pipeline silent-fallback class:
- **Cluster-side:** `check-tempo-ingestion.sh` — compares `tempo_distributor_spans_received_total` delta to TraceQL search count over the same window; exits non-zero on ingestion-without-search-results signature. Detects Tiers 1/2/3 (config / endpoint / cluster-side) failures.
- **Agent-side:** `doctor-otel.sh` — for each running claude process with `OTEL_TRACES_EXPORTER=otlp` set, reads `OTEL_SERVICE_NAME` from `/proc/<pid>/environ` and queries Tempo for that service's recent traces. Reports stuck processes (Tier 4 firing condition).

Together the script-pair detects the entire OTLP-pipeline silent-fallback class regardless of which architectural surface broke. **Strongest empirical evidence yet that Pattern A is the load-bearing structural-defense template for the entire observability-pipeline-class.**

**TraceQL query-syntax note (Pattern A's adjacent gotcha):** when querying Tempo for traces by dotted resource attributes, **the dotted key must be quoted**. The unquoted form returns 0 silently (matches no traces; is NOT a parse error):

```bash
# WRONG (returns 0 silently — looks like "no telemetry" when traces actually exist)
curl -G "$TEMPO/api/search" --data-urlencode 'q={resource.gen_ai.agent.name=~"cv-.*"}'

# RIGHT (matches; canonical form for dotted resource attrs)
curl -G "$TEMPO/api/search" --data-urlencode 'q={resource."gen_ai.agent.name"=~"cv-.*"}'
```

This is a **secondary Pattern A failure mode** — the assertion script CAN return zero-traces and look like a Tier-1/2/3/4 firing when actually it's a query-syntax issue. Defense: when investigating "Pattern A reports zero traces," cross-check with the alternative query `{resource.service.name=~"macf-agent.*"}` (uses the OTel-canonical service-name attribute which TraceQL handles natively, no dotted-key quoting needed). If that returns non-zero, the issue is query-syntax not silent-fallback.

### Instance 9 — Sigstore TLOG orphans on failed npm publish (partial-side-effect-on-failed-publish)

**Surface:** `npm publish` with `--provenance` (sigstore attestation) — the multi-step pipeline `sigstore TLOG entry submit → attest binding → npm registry PUT` where each step's success isn't atomic with the others.

**Failure shape:** Two observed sub-shapes, both producing orphan TLOG entries in the public sigstore transparency log:

- **Sub-shape A — sigstore-409-on-retry** (`v0.2.25` 2026-05-18T21:48Z, groundnuty/macf#373): first publish-run aborted on pre-existing test flakes after TLOG entry submitted. Retry via tag-recreate hit `TLOG_CREATE_ENTRY_ERROR (409)` — sigstore correctly rejects the duplicate entry, but the retry's attestation is rejected. Two consumer packages already published (`@groundnuty/macf{,-core}@0.2.25`) became orphans pointing at a never-published `@groundnuty/macf-channel-server@0.2.25`.
- **Sub-shape B — npm-404-after-sigstore-success** (`v0.2.29` 2026-05-19T21:30:32Z + `v0.2.30` 2026-05-19T22:17:36Z, groundnuty/macf#391+#397+#395 release-cuts): publish-workflow auth-step succeeded (`NPM_TOKEN` present + valid); sigstore TLOG entry submitted successfully (logIndex 1575263520 for v0.2.29; logIndex 1575475073 for v0.2.30); npm registry `PUT /@groundnuty%2fmacf-core` returned HTTP 404 `"not in this registry"`. Sigstore TLOG entries persisted; npm registry never received the package. Operator-side root-cause investigation in flight at codification time (candidate causes: npm-token-scope mismatch / OIDC trust conflict / 2FA-bypass missing / transient registry issue).

**Recurrence:** 3 instances across 2 distinct trigger mechanisms (sigstore-409-on-retry; npm-404-after-sigstore-success); same root-shape (partial side-effect persists after downstream publish failure).

**Why this is sister-shape, not strict silent-fallback:**

| Aspect | Silent-fallback (Instances 1-8) | sigstore-TLOG-orphan (Instance 9) |
|---|---|---|
| API exit code | success (0 / HTTP 200) | failure (non-0 / HTTP 4xx-5xx) |
| Failure signal | absent at API boundary | LOUD at API boundary (npm 404; sigstore 409) |
| Hazard surface | detection (failure invisible until downstream breaks) | recovery (failure surfaces correctly but partial side-effect breaks retry idempotency) |
| Class generalization | "operation success masks semantic failure" | "operation failure persists partial state that breaks retry" |

Both classes share "multi-step pipeline where consumer assumes atomicity" but the failure mode + structural defense differ. Listed here as Instance 9 for cross-reference convenience; **future structural-defense work warrants a sibling canonical rule `partial-side-effect-hazards.md`** if more instances surface (e.g., partial-side-effect database migrations, partial-side-effect distributed-transaction failures). Codification at sibling-rule level happens at the 5-instance threshold per the rule-promotion convention.

**Defense status:** Pattern recovery codified via DR-022 Amendment L (groundnuty/macf#380); pre-publish validation via Pattern D analog (Pattern D adapted from workflow-secrets-prechecks to publish-pipeline-prechecks). Two specific defense layers shipped + one in operator's queue:

- **Defense 1 — bump-version recovery (NOT tag-retry)** — DR-022 Amendment L canonical recovery procedure. When publish fails leaving sigstore TLOG orphans, recover via `npm version <next>` + fresh push, NOT `git tag -d + tag-recreate + force-push`. Fresh version produces a fresh TLOG entry + a fresh attestation; idempotent + clean. Applied successfully for v0.2.25 → v0.2.26 (instance 1 recovery). v0.2.29 + v0.2.30 also followed bump-version (29 → 30 → 31-pending), but the underlying npm-404 trigger is operator-side configuration, not retry-idempotency:
  ```bash
  # WRONG (idempotency-breaking when retry hits TLOG-409 or repeats the original 404)
  git tag -d v0.2.25
  git tag v0.2.25 <new-sha>
  git push --force origin v0.2.25  # triggers re-publish with same version → TLOG 409 collision

  # RIGHT (orthogonal recovery)
  # Bump version: 0.2.25 → 0.2.26 with whatever fixes
  npm version 0.2.26 && git push origin v0.2.26  # fresh version, fresh TLOG entry, clean publish
  ```

- **Defense 2 — pre-flight registry-collision check** (Pattern D analog; groundnuty/macf#380): publish-workflow precheck step queries `npm view @scope/package@<version>` BEFORE invoking sigstore; aborts if the version already exists on the registry. Catches the same-version-retry-on-TLOG-409 failure shape at the workflow boundary (Pattern D's aggregate-fail-loud discipline applied to publish pipeline). Won't catch first-attempt npm-404 (instance 2/3 shape) where the version genuinely doesn't exist yet — that fail-mode requires Defense 3.

- **Defense 3 — TLOG-state observability** (in flight; devops-toolkit#74 + #77 dashboard live as of 2026-05-20T00:06:56Z): release-hygiene Grafana dashboard surfaces orphan-sigstore-attestations via `grafana-dashboards-release-hygiene` (UID `macf-release-hygiene`). Auto-detects "package N.M.K depends on N.M.K of sibling but sibling never published" + alerts when a tag's matching npm version is missing 24+ hours post-tag. Closes the operator-visibility gap that left v0.2.29 + v0.2.30 orphans accumulating without an automated catch.

**Cleanup pending after instance N+1 (codification followup):**

- v0.2.25 orphans (instance 1): `@groundnuty/macf{,-core}@0.2.25` published on npm → deprecate via `npm-deprecate.yml` workflow_dispatch (operator-side App-permission gate per DR-019 Amendment A — granted 2026-05-19, dispatch-allowlist for `npm-deprecate.yml` codified)
- v0.2.29 + v0.2.30 orphans (instances 2/3): npm registry never received the PUT → nothing to deprecate on npm side; sigstore TLOG entries persist by design (transparency log is append-only). Future audit-trail check should reconcile sigstore-TLOG entries against npm-registry-state to catch shape-mismatched orphans proactively.

**Codification rationale:** 3 instances across 2 trigger mechanisms + defense pattern stable + operator-witnessed across 2 calendar days (2026-05-18 + 2026-05-19) + cross-agent (instance 1 via science-agent's authoring; instances 2/3 via code-agent's release-cut workflow) — meets all four "When to add a new instance" criteria. The sister-class question (separate `partial-side-effect-hazards.md` canonical rule) is acknowledged inline + deferred to the 5-instance threshold per rule-promotion convention.

### Instance 10 — retired (legacy substrate-routing receipt-gap)

Documented a send-logged ≠ received gap on the legacy Stage-2 substrate routing last-mile, a path the macf **product** does not use: consumers route via the channel-server / A2A path, whose `notify_received` / `mcp_pushed` + OTel receipt spans (`macf.mcp.push`, `macf.tmux_wake.deliver`) already capture receipt. Removed from canonical 2026-06-07 — legacy-routing operational detail belongs in substrate workbench + git history, not the product rules. The number is retained (not reused) to keep Instances 1–9 + 11 stable as identifiers.

---

### Instance 11 — Third-party retry-wrapping action exits 0 on internal retry-exhaustion (connect-failure masked as step-success)

**Surface:** any consumer-CI step that delegates a connect/auth handshake to a third-party GitHub Action (or wrapper tool) that owns its own internal retry loop — tailnet join (`tailscale/github-action`), OTLP collector connect, cloud-provider auth (`aws-actions/configure-aws-credentials`, `google-github-actions/auth`), registry login, etc. The action retries internally and reports a single aggregate exit code for the step.

**Failure shape:** the wrapped tool fails on EVERY internal retry (a hard error, not a transient one — e.g. an invalid-auth `400` that no amount of retrying can fix), the action **exhausts its retry budget and still exits `0`**, and the workflow continues into a broken state. The connect never happened, but the step is green. The real failure then surfaces far downstream as a *different* problem — every later fetch/query against the resource the step was supposed to make reachable fails, and the symptom (timeout, connection-refused, "endpoint unreachable") points the investigator at the downstream consumer, not at the masked upstream connect. The exit-0 step is the last place anyone looks because it's the one place that reported success.

**Recurrence:** First confirmed instance — groundnuty/macf#461 (2026-06-07). The e2e workflow's `tailscale/github-action` step was configured with `tags: tag:ci`, but the OAuth client + ACL only permit `tag:ci-runner`. `tailscale up` returned `Status 400 "requested tags [tag:ci] are invalid or not permitted"` on all 5 internal retries; the action exited `0`; the runner never joined the tailnet; every subsequent tailnet fetch failed, presenting as a generic **"Tempo query unreachable."** Because the connect step was *green*, it was the last place examined — the diagnosis cycled through transient-retry, Tempo-serve-config, and DNS-vs-IP hypotheses until reading the connect step's **actual output** (not its exit code) surfaced the `400`. (Two *genuinely separate* upstream bugs — a devbox/Nix-install step-ordering fault [#460] and the Tempo query port not being tailnet-exposed [devops-toolkit #88] — were correctly diagnosed and landed first; they were real fixes, not projections of this masked failure. The exit-0 masking is what hid *this* failure for an extra diagnostic cycle even after those two were resolved.)

**Distinct from the sister GHA-surface instances** — do NOT fold this into Instance 5 or Instance 8:

| Aspect | Instance 5 (secrets-misnamed) | Instance 8 (OTLP endpoint silent-drop) | Instance 11 (this) |
|---|---|---|---|
| Where the lie originates | empty-string substitution at `${{ }}` expansion, BEFORE the tool runs | exporter silently retries-then-drops, no exit code surfaced at all | third-party action runs, fails every retry, then **exits `0` reporting success** |
| What's wrong | a required input is missing/renamed | a long-lived process points at a dead endpoint | a connect handshake hard-fails but its wrapper claims success |
| Downstream disguise | misleading auth error at the *consuming* step | empty observability surface, no failure signal anywhere | masquerades as a *different* downstream problem (here: "Tempo unreachable") |

Instance 5 is "the input was never there"; Instance 8 is "the data went into a void with no signal"; Instance 11 is "the connection step actively *reported success* while having hard-failed." All three live on the GitHub-Actions / CI-plumbing surface but the trust boundary that breaks differs — Instance 11's is specifically *a third party's exit code about its own retry exhaustion*. The tailscale case above is just the worked example: any consumer CI that wraps a connect/auth in a retrying action (tailnet, OTLP, cloud-auth, registry-login) is exposed to the same shape.

**Defense status:** SHIPPED (Pattern A result-invariant assert, with a Pattern D precheck flavor) — a **"Verify <resource> is up" step placed immediately after the connect step**, asserting the connection's result-invariant and failing LOUD (red job) when it doesn't hold. Never trust a third-party action's exit code as evidence that its own internal retries succeeded — assert the post-connect state directly.

```bash
# After the tailscale connect step (NOT trusting its exit 0):
tailscale status --json | jq -e '.BackendState == "Running"' >/dev/null \
  || { echo "::error::tailnet did not come up — tailscale BackendState != Running."; \
       echo "::error::The connect action may have exhausted retries and exited 0 anyway"; \
       echo "::error::(e.g. tag/ACL mismatch returns Status 400 on every retry)."; \
       tailscale status || true; exit 1; }
echo "✓ tailnet up (BackendState=Running)"
```

Generalizes to any retry-wrapping action: assert the result-invariant the connect was *supposed to establish* — `BackendState == "Running"` for a tailnet, a successful authenticated probe for cloud-auth, a `200` from the collector's health endpoint for OTLP — in a dedicated step right after the connect, before any downstream consumer runs. This converts a far-downstream misdiagnosis (the 3-hop red-herring chase in #461) into a fail-at-the-boundary red job pointing directly at the broken connect.

---

### Instance 12 — PreToolUse credential-guard validates the *ambient* token, blind to inline mid-command reassignment

**Surface:** the #140 `check-gh-token.sh` PreToolUse hook, plus any refresh idiom that reassigns `GH_TOKEN` *inline within the same Bash command* as the `gh` calls it is meant to guard (`export GH_TOKEN=$(gh token generate ... | jq -r .token) && gh ...`; `export GH_TOKEN=$(cat tok.txt) && gh ...`).

**Failure shape:** the hook validates `GH_TOKEN` purely from the **ambient environment present *before* the command runs** (`GH_TOKEN_VALUE="${GH_TOKEN:-}"`, then the `^ghs_[A-Za-z0-9_]+$` predicate). It never parses the command string for an inline `GH_TOKEN=` / `export GH_TOKEN=$(...)` reassignment. Agents launch with a valid `ghs_` token in ambient env, so the hook **passes and exits 0** — *then* the inline `$(...)` runs, and on an intermittent GitHub-side 401 the naive `| jq` (no `set -o pipefail`) emits empty/`null`, clobbering `GH_TOKEN` to empty **after the hook has already returned**. The chained `gh` calls fall back to the stored `gh auth login` user. **The recommended refresh-chain bypasses its own guard.** The hook only blocks when the ambient is *already* bad — the exact case the rules tell agents not to rely on; in the normal regime (valid ambient) it is a pass-through no-op for every inline-refresh shape, including the file-cache read.

Two adjacent sub-failures: **(a)** `export X=$(helper)` masks a fail-loud helper's non-zero exit, because `export` is a builtin whose own exit `0` replaces the substitution's (ShellCheck SC2155) — so `pipefail` / a fail-loud helper *alone* is insufficient; only `GH_TOKEN=$(helper) || exit 1` (bare assignment + explicit abort) short-circuits the `&&`. **(b)** A redirect `helper > tok.txt` truncates the cache file *before* the helper runs, so a 401 leaves an *empty* file for the next read — write atomic-validated (`mktemp` + `grep ghs_` + `mv`) instead.

**Recurrence:** First confirmed — `macf-cv-architect` 2026-06-12 (4 issue/PR comments posted as the operator under an intermittent GitHub-side 401). Verified by 3-lens adversarial review (source-code / shell-mechanism / alternative-cause, 3-0 survived). Generalizes to every agent's inline / file-cache refresh form; the substrate workbenches additionally had the footgun *taught* by an unrefreshed bootstrap `gh-token-refresh.md` that `macf update` does not distribute.

**Defense status:** layered. **(1) DOC (shipped):** de-footgun `gh-token-refresh.md` (+ `agent-identity.md`) — fail-loud `GH_TOKEN=$(helper) || exit 1`, no inline-refresh, atomic-validated file-cache; this rule's sister `gh-token-attribution-traps.md` strengthened with the export-mask. **(2) STRUCTURAL — the load-bearing fix, Pattern A:** a result-invariant **PostToolUse** check asserting the just-written resource's `author` == expected bot login (`macf-whoami.sh` / `--json author`) — the only level that sees through inline-clobber, file-cache-staleness, *and* future bypass shapes, because it checks what was actually posted, not the command-string shape (filed macf#489). **(3) Decided-against:** teaching the PreToolUse hook to detect inline `GH_TOKEN=$(...)` reassignment — brittle regex over arbitrary shell, and the export-mask makes the safe-predicate subtle.

**Class lesson:** a structural defense that validates a precondition at the **wrong temporal level** — pre-command ambient state instead of the post-mutation runtime value — provides no protection in exactly the regime it was built for. **Result-invariant assertion at the boundary (Pattern A) is the temporal-level-agnostic fix; command-string precondition checks are not.** This is the clearest case yet of *why* Pattern A bears the most weight in this rule.

---

### Instance 13 — PR-review-state routing strands interested third-party gate-owners (reviewer ≠ next-actor)

**Surface:** `route-by-pr-review-state` (macf-actions v3.3.0+) — fires on `pull_request_review.submitted` (state in {approved, changes_requested}) and notifies the **PR author's** channel-server.

**Failure shape:** the review is submitted + routed successfully (API success: webhook fires, author notified, HTTP 200). But in a multi-agent fleet the party who needs to know a review landed is frequently NOT the author — it is a **third agent whose own work is gated on that review** (build-gate owner, downstream implementer, coordinator). `route-by-pr-review-state` has no path to that third party; the blocked agent receives nothing and its gate **silently reads "pending"** though the review exists — invisible until the gate stalls and a human notices. `route-by-mention` CAN reach a third party IF the reviewer @mentions them in the review body, but the body is naturally addressed to the author, so the convention is forgotten: the capability exists, the discipline doesn't.

**Recurrence:** First confirmed — `groundnuty/macf` PR #574 (2026-06-26). `macf-devops-agent` APPROVED `17:07:10Z`, then was gated for its impl work on `macf-code-agent`'s framework-feasibility approval; code-agent APPROVED 31 s later (`17:07:41Z`); `route-by-pr-review-state` notified the author (`macf-science-agent`) only, and code's review body @mentioned only science, never devops (auditor-re-verified against the `/pulls/574/reviews` API + bodies + thread). The downstream consequence (devops's gate read "pending"; resolved by a manual relay + an operator-prompted direct channel push) is code-agent's reported channel trace, not GitHub-re-verifiable — the GitHub-observable structure above fully supports the mechanism regardless. **Scales worse with fleet size:** in a 2-agent author↔reviewer loop the author IS the next actor; in an N-agent fleet where a review unblocks a *different* agent, "reviewer ≠ next-actor" is the common case — which is why this surfaced exactly as the fleet began collaborating more freely.

**Defense status:** the load-bearing fix is **structural** — a coordination *guarantee* must anchor to a deterministic harness mechanism (the routing Action), never to an LLM remembering to run a sweep. Extend `route-by-pr-review-state` so a submitted review-state notifies everyone with deliberate review-engagement on the PR — **formal reviewers + requested reviewers + review-body @mentioned parties** — not the PR author alone (filed as `groundnuty/macf-actions#57`). An @mention-only signal would NOT have caught the incident below: the stranded gate-owner (devops) was a *formal reviewer*, never @mentioned — so routing to deliberate-engagement, not just body-@mentions, is what closes the gap. This is the same **Path-2 logic** as the `check-*.sh` hook family (cf. Instances 1/2/6): a recurring coordination discipline gets promoted to a structural/harness mechanism rather than enshrined as load-bearing behavior. Until that lands, the **backstop** (the behavioral safety-net, *not* the guarantee) is Pattern A at the gate boundary — a gate-owner clears its gate by **asserting the artifact exists on GitHub** (does an APPROVED review exist on the PR my gate depends on?), never by waiting for a ping. Codified as the `coordination.md §Communication 5(c)` gate-sweep (cheap, immediate, no code change), generalizing the existing §5(b) reviewer-sweep from the *requested-reviewer* side to the *gate-owner* side. Reviewer-@mentions-the-gate-owner is a complementary courtesy folded into §5(c) as a SHOULD (it depends on the reviewer remembering).

**Pattern:** structural route-extension (load-bearing) + Pattern A (gate-side result-invariant assert, backstop).

---

### Instance 14 — a context-free `type:mention` (no anchor AND no message) is delivered-but-useless → routed work strands invisibly

**Surface:** the channel-server `/notify` `type:mention` path (whatever the sender — `route-by-mention` or a Stage-3 POST). A `mention` payload that carries neither a GitHub anchor (`issue_number`/`pr_number`) nor a `message`.

**Failure shape:** delivery succeeds at every layer (HTTP 200 → `notify_received` → `mcp_pushed` → `tmux_wake`), but the payload is **semantically useless** — `formatNotifyContent`'s `payload.message ?? 'You were mentioned'` fallback surfaces it to the recipient as a bare, context-free **"You were mentioned"** with no pointer to the ask. The recipient sweeps, finds nothing, and the routed work strands with **no error at any layer**. The true hazard is **context-freeness (no anchor AND no message)**, NOT anchorlessness per se: a message-bearing anchorless mention (e.g. `macf fleet doctor --inject`'s probe — "fleet-doctor probe, no action needed [macf-route:…]") is *actionable* (the message IS the content). Conflating the two is itself a trap — the first fix (anchor-required) over-rejected `--inject`.

**Recurrence:** confirmed — `macf-science-agent` channel.log, 2026-06-27: 6 anchorless `type:mention` event-lines (3 distinct, 08:09:51 / 08:15:17 / 08:16:10) surfacing as bare "You were mentioned" pings. **The hazard is recursive** — it stranded the very reviews fixing its own siblings: a PR-#119 review-request routed under the wrong anchor + two anchorless ones, recovered only by manual re-ping / operator pointer. A notification-layer silent-fallback degrades the fleet's capacity to **repair itself** (self-repair flows through the broken layer).

**Defense status:** **Pattern B (schema-level — make the bad shape unrepresentable, reject at PARSE).** `NotifyPayloadSchema.refine` requires a `type:mention` to carry actionable content — `message` OR `issue_number`/`pr_number` (diagnostic-probes exempt) — so an anchorless-AND-message-less mention is rejected at parse with a loud `notify_validation_failed` + HTTP 400, never silently `mcp_push`ed as a context-free ping (`macf#620`). The invariant was corrected from anchor-only to **message-OR-anchor** (`macf#630`) after the over-tight first form would have 400'd the legitimate message-bearing `--inject` probe — the lesson being that the defect was *context-freeness*, not anchorlessness. The formatter also surfaces the anchor when message-less (`You were mentioned in #N`). Behavioral backstop (recipient-side): on a bare ping, **sweep GitHub state** rather than trust the (missing) ping content — same Pattern-A-at-the-recipient discipline as `coordination.md §5(c)`.

**Pattern:** B (schema-level reject-at-parse) + Pattern A (recipient-side sweep, backstop).

---

### Instance 15 — the launcher omits Claude Code's channels flag → the agent is silently deaf to ALL native channel notifications

**Surface:** the launcher (`claude.sh`) → Claude Code's MCP channel-notification gating. CC v2.1.80+ gates the async MCP channel push behind a `--channels` flag; a `--plugin-dir`-mounted, non-allowlisted channel-server plugin (DR-002's loading model) is rejected by the curated `--channels` and needs the `--dangerously-load-development-channels server:macf-agent` dev-flag form.

**Failure shape:** if the launcher never passes the flag, the channel-server pushes notifications but **Claude Code silently drops them** — logging only `Channel notifications skipped: server … not in --channels list for this session` — and the agent has **NO signal that it is deaf to native routing**. It appears *idle-because-no-work* when it is actually *idle-because-deaf*. The `tmux_wake` fallback (a send-keys keystroke) may still fire, **masking** the native-channel deafness (so partial delivery hides the gap). The worst silent-fallback shape: no error at any layer, and the recipient cannot tell it is broken.

**Recurrence:** confirmed — the whole fleet ran **without** the channels flag until 2026-06-27 (operator-driven, `macf#632`); the CC `skipped: not in --channels list` log line was the only trace. This is the **missing half of the Instance-14 bare-ping investigation**: the native channel path was off fleet-wide, and only the tmux-wake fallback was delivering (which is why the surfacing was erratic).

**Deeper sub-case — the launcher omits `--plugin-dir` entirely → the channel-server is never even MOUNTED (`macf#638`).** The flag-omission above (`--channels`) gates a *mounted* server's push; a worse layer is a launcher so stale it lacks **`--plugin-dir`**, so the channel-server MCP plugin is never loaded at all — the agent has *no channel server*, routing only via the Stage-2 tmux/`agent-config` path, with the same total absence of signal. Confirmed on code-agent's framework-repo `claude.sh`: a pre-v0.2.18 hand-authored relic (drifted ~6 canonical features behind) with neither `--plugin-dir` nor `--channels` — the bottom of the notification-death investigation. **This is the DR-029/`#623` "hand-authored launcher drifts behind canonical" class at its worst** (the relic predated the thin-launcher entirely). Same defense shape, applied at the launcher: PREVENT — adopt the canonical launcher (which carries `--plugin-dir` + `--channels`) + the **managed-header** so `macf update` keeps it current (`#638`/`#623`); DETECT — the `check-channels-enabled.sh` guard (and the proactive `/proc/<pid>/cmdline` argv-check follow-up would catch a missing `--plugin-dir` too, not just `--channels`). The two flags are one hazard at two depths (mount-the-server / enable-the-push) — but note the deepest layer below: even *with* both, native push still didn't register until the server was re-mounted via `.mcp.json`.

**Deepest layer — mount-form ↔ flag-form mismatch: even WITH both flags, native push never registers for a plugin-mounted server (`macf#641`).** Spike-proven on auditor (2026-06-28): a `--plugin-dir`-mounted plugin's channel id is `plugin:<name>:<server>` (`plugin:macf-agent:macf-agent`), which the `--dangerously-load-development-channels` dev-flag **rejects**; the flag's `server:macf-agent` argument therefore referenced **nothing** while the server was plugin-mounted. So the `--channels` flag was **necessary-but-insufficient** — pointing at a non-existent `server:` id. The only dev-flag-loadable form for a non-allowlisted channel is a **`.mcp.json` `server:<name>` MCP server** (the `plugin:<name>@<marketplace>` form is allowlist-enforced, incompatible with project-isolation). **The complete fix:** mount the channel-server as a project `.mcp.json` `server:macf-agent` (DR-022 Amendment P) so the flag resolves → CC logs `Channel notifications registered` and the native push fires. This is why native push **never worked for any agent**, and the tmux-wake fallback was the *only* delivery all along — masking ALL of: context-free payload (Instance 14), `--plugin-dir`-omitted, `--channels`-omitted, AND this id-form mismatch. (A separate *fifth* shape — the channel-server's stdio-lifecycle-coupling silent death under heavy load — is DR-022 Amendment P / `macf#642`/#643; the chosen fix is **harden the stdio child** [operator, 2026-06-28: "CC spawns + owns it as a child… first let's harden it"], with Path-B HTTP/SSE considered + **dropped on complexity** [leading revisit IF the `#642` reproduction shows hardening insufficient]. Whether harden is a full fix or mitigation is the open question the reproduction decides.)

**Defense status:** **prevent + detect.** PREVENT — `claude.sh` emits `--dangerously-load-development-channels server:macf-agent`; this resolves **only once the channel-server is mounted as a `.mcp.json` `server:macf-agent`** (`macf#641`/DR-022 Amendment P) — as a `--plugin-dir` plugin its id was `plugin:macf-agent:macf-agent` and the flag matched nothing. **Version-gated on CC≥2.1.80** with a loud stderr warn below the gate, plus the `MACF_CHANNELS_DISABLED` / operator-`MACF_CHANNELS_ARGS` opt-out family (`macf#632`). DETECT — a SessionStart guard `check-channels-enabled.sh` scans the channel-server log for the skip-message and warns **LOUDLY into the agent's context** (observational, fail-open, `MACF_SKIP_CHANNELS_CHECK=1` override) so the agent knows it is deaf (`macf#633`, approved/merging). A **proactive** complement — read the running `claude` process's argv (`/proc/<pid>/cmdline`) for the flag rather than waiting for a skip-message in the log (Pattern-A-direct, sister to Instance 8's `doctor-otel.sh` `/proc/<pid>/environ` probe) — is a worthwhile follow-up (the current guard is reactive: it needs a push to have been attempted-and-skipped).

**Pattern:** B (prevent — enable the flag, version-gated) + Pattern A (detect — assert-channels-enabled startup guard).

---

### Instance 16 — CA rotation re-issues in-workspace agent certs but silently orphans the out-of-band routing-client-cert secret → routing breaks undetected

**Surface:** `macf certs init`/`rotate` (a CA re-init/rotation) and the macf-actions router's `route-by-label` mTLS client cert, which lives **out-of-band as GitHub Actions secrets** (`ROUTING_CLIENT_CERT`/`ROUTING_CLIENT_KEY`, per caller repo) — NOT in the workspace the rotation touches.

**Failure shape:** the rotation succeeds at its op boundary (exit 0; the *in-workspace* agent certs ARE re-issued against the new CA — its stated job done). But the **system-level semantic** (routing works) is broken because a **sibling, out-of-band CA-signed artifact** — the routing-client-cert secret — is NOT reachable by `macf certs` (agents can't write GitHub secrets, DR-019) and silently retains a cert signed by the **old** CA. The router's POST is then rejected by every agent (mTLS: foreign issuer) → guest-tasking / `route-by-label` silently breaks, **invisible until exercised downstream** — an operator hit it ~5 days later. Success-masks-semantic-failure + detection-requires-invariant-check: textbook silent-fallback, distinguished by the wrong outcome living in a *sibling artifact the op never touched* (its blast radius), not in the op's own result.

**Recurrence:** First confirmed — `groundnuty/macf#799` (the onedata-mcp routing outage, 2026-07-05): ppam-2026 CA re-created Jun 30 → agent certs re-issued → the 2-month-old `ROUTING_CLIENT_CERT` secret orphaned → `route-by-label` mTLS rejected for ~5 days. Live-confirmed at diagnosis: a freshly-minted current-CA routing cert returns HTTP 200 to a ppam agent while the orphaned secret is rejected — exactly the issuer mismatch the detect-check catches. Generalizes to **any** out-of-band CA-signed artifact (not just the routing-client cert): a rotation's blast radius extends past what it can directly re-sign.

**Distinct from Instance 1 (gh-token expiry) and the Instance-9 sister-class:** Instance 1 is *the credential this op uses* going stale; here the rotated credential is fine — a *different, downstream* consumer's copy is orphaned by the rotation. It's not Instance-9 partial-side-effect either (that op *fails* loudly and leaves half-state); here the op *succeeds* and the orphaned state is in an artifact it correctly never wrote. The unifying lesson: **a credential rotation's success does not guarantee the system-level invariant (the credential works everywhere it's consumed) — assert that invariant, don't infer it from the rotation's exit code.**

**Defense status:** SHIPPED/in-flight per `#800` — **prevent + detect** (the generalizable principle: *a rotation MUST enumerate its full blast radius, including out-of-band copies it cannot update, and propagate-or-loudly-flag*):
- **PREVENT — rotation-time blast-radius WARN.** `macf certs init`/`rotate` ends with a loud warning enumerating the orphaned out-of-band artifacts + the exact re-mint / re-set operator commands. Warn, never auto-write (DR-019). **At least TWO out-of-band CA-copy classes, both keyed on the DR-030/DR-038 install-set:** (1) the **routing-client cert secret** (`ROUTING_CLIENT_CERT`/`_KEY`) per caller repo; (2) the **`<PROJECT>_CA_CERT` repo variable** per agent repo (macf#806 — the v3 router reads the CA it trusts from `vars[<PROJECT>_CA_CERT]`, so a rotation orphans every per-repo copy). The repo-var class is retired structurally by **macf-actions#66** (router reads the CA from the *registry*) — which shrinks this blast radius by a whole class. **General lesson: every out-of-band CA copy is a rotation-blast-radius member — prefer registry-read over per-repo copies.**
- **DETECT (static, primary) — Pattern A issuer-match, no secret-read.** A GitHub secret is **write-only**, so the doctor cannot read the deployed cert to diff it — instead, `issue-routing-client` records the routing-cert's **issuer-fingerprint + mint-epoch** in a registry variable (`<PROJECT>_ROUTING_CLIENT_CERT_ISSUER`, DR-006 scope), and `macf routing doctor` diffs that against the **current CA fingerprint** → mismatch = orphaned. (The write-only-secret constraint is *why* the check keys on the registry-recorded issuer, not the secret value — the load-bearing design point.)
- **DETECT (live, stronger) — Pattern A result-invariant.** `routing doctor --live` / the rotation e2e (`#798`) asserts a `route-by-label` POST actually succeeds post-rotation (cause-agnostic).
- **REMEDIATE.** `macf certs issue-routing-client` re-mints + emits the per-repo `gh secret set` operator commands (DR-019).

Codified as **DR-010 Amendment (2026-07-05, #800)** — the CA-lifecycle rule that a rotation enumerates + flags its out-of-band blast radius.

**Pattern:** A (detect — result-invariant issuer-match + live-route-assert) + prevent-side blast-radius WARN (Pattern-D-flavored precheck/enumerate-at-the-op).

---

### Instance 17 — a doctor/health check asserts a cheap PROXY instead of the live result-invariant it exists for → green precisely when the monitored property is uniformly false

**Surface:** health-check / `doctor` commands (`macf routing doctor`, DR-030) — any check that reports a fleet-health verdict.

**Failure shape:** the check asserts something *cheap to read* (internal agreement across members, well-formedness of a variable, presence of a key, a recorded value) as a stand-in for the *result-invariant it exists to guarantee* (the fleet runs current code, the CA is the current one, a route actually lands). The proxy and the invariant diverge exactly in the failure case, so the check goes **green when the monitored property is uniformly false** — the worst possible time. Two compounding sub-shapes:

- **Proxy-for-invariant.** `routing doctor` check 1 measured the **modal pin among fleet members** (agreement) instead of **the latest immutable tag** (freshness): a fleet where every repo is uniformly stale reported ✓ consistent. It did not surface **via the doctor** at all. Precision matters here, because the first telling of this incident got it wrong (corrected on macf#872): staleness *was* detected promptly — Dependabot opened the exact `v3.4.1 → v3.4.2` bump (`macf#818`) **the day after** the fix shipped (`macf-actions#69`/`v3.4.2`, 2026-07-06) — and the PR then **sat unread for 36 days** until a human noticed approval-echo noise. So two independent failures compounded: the doctor produced **no signal** (this instance), and the signal that *was* produced went **unread** (a queue-attention failure, sibling to the delivered-≠-processed shape of Instances 13/14 — see `coordination.md §Communication 5(b)`, whose sweep query already covers bot-authored PRs). The honest claim for a doctor check is therefore narrower than "it would have caught this": it surfaces staleness **at diagnosis time**, when someone is already debugging routing — pull-at-diagnosis, not another push into an unswept queue. That affordance is real and worth building; a guarantee it is not. An audit (macf#872) then found the same shape in **3 of 6 checks**: check 1 (modal-agreement not freshness), check 2b (`app_name ≠ label` — asserts not-the-known-bad-value, not the correct bot-login), check 4 (CA variable *parses* — not that it is the *current* CA), plus check 6 (recorded issuer vs current CA — a *forced* proxy, deployed cert being write-only, but named `ok` where `presumed-ok` is honest). Only check 3 (registry↔`/health` `instance_id` live probe) asserted its invariant.
- **Precondition-failure absorbed by downstream non-failing states (the severe one).** Check 4 is the live HEALTHY-while-broken path: a rotated-out but well-formed registry CA cert passes check 4 (well-formed) AND is the trust anchor for the `/health` probe, so every probe fails → `'unreachable'` (which, within heartbeat-TTL, does *not* fail the verdict) → `routable` still true (the registry key still exists) → `caFail` false (well-formed) → **net verdict HEALTHY while zero agents can route.** The CA failure was not merely unmeasured; it was *laundered* through three downstream checks that each independently declined to notice. This is the #799 / Instance-16 class one layer up: check 6 guards the routing-client cert against the current CA, and nothing guarded the registry's *published* CA.

**Recurrence:** 3 proxy checks + 1 forced-proxy on one surface (macf#872 — the audit covered all six `routing doctor` checks, so the roster is complete, not a sample), plus the same root in **Instance 16** (recorded-fingerprint proxy) and the **macf#855** attestation gap — well past a one-off; it is a *surface where the convention never landed*, not a set of isolated oversights.

**Recognition heuristic (predicts where to look next):** *the proxy tends to be the value that is cheap to read; the invariant the one that costs a probe or a comparison.* That is **why** the substitution happens (the cheap read is always right there) and **where** to audit first — distrust any health check that reaches a verdict without a network probe or a fingerprint/tag comparison.

**Defense status — two-part, Pattern A at the health-check boundary:**
1. **A check must assert the result-invariant it is *named for*, live, or degrade to `unknown`** (never `current`/`ok`/`present` on an unreachable-or-unverifiable read — the A4 floor: an API can confirm present, never prove absent). A *forced* proxy (write-only artifact) must name its state as presumed (`presumed-ok`), not collapse a presumption into a verified pass.
2. **A check whose failure is a *precondition* for other checks' failures must fail the verdict — not be absorbed by their non-failing states.** (The check-4 lesson: a stale CA guarantees every probe fails, so it must fail loudly at its own boundary rather than surface as a downstream `'unreachable'` the verdict tolerates.)

**The in-tree template:** `macf fleet doctor` (DR-030) already has the correct posture on two counts. First it makes the *costly* choice at every tier — a live mTLS call, an echoed `correlation_token`, and greens its ACCEPTED tier only on `HTTP 200 AND ack AND echoed token matches` ("the echo proves a real round-trip, not a coincidental 200"). Second — and this is the property the static-plane checks lack *most* — **it says out loud what it does NOT prove** (reaches-server ≠ delivered-to-agent) and ships `--inject` for the tier beyond. A proxy check is not automatically a bug (a *forced* proxy over a write-only artifact is defensible); it becomes a silent-fallback the moment it does not **declare** that it is a proxy. Several of the static-GitHub-plane checks are individually defensible but none states what it is not asserting — so a presumption reads as a proof. The fix is to port both halves of that posture (probe where you can; declare-the-limit always) to the static-plane checks. Fixes in flight: macf#873 → #874 → #872 (check 4 / #873 first — the live-broken one).

**Pattern:** A (assert the live result-invariant or degrade to `unknown`) + the precondition-must-fail-the-verdict clause (a health-check-specific extension of A).

---

### Instance 18 — a repo's `agent-config.json` is the routing table for EVERYONE mentioned there, not just its own agent → a single-agent config makes the repo a one-way channel

**Surface:** `.github/agent-config.json` in any fleet repo + `route-by-mention` / `route-by-pr-review-state`.

**Failure shape:** the file has an **undeclared dual role** — (1) the local agent's identity card, and (2) **the routing table every mention in that repo resolves against**. A config listing only its own agent satisfies role 1 perfectly and silently fails role 2: `route-by-mention` runs, finds no matching entry, exits 0, and emits **no `Routed mention` line**. Success at every observable layer; the mention reached nobody; neither the author nor the intended recipient learns. The property distinction to carry: **`reachable` ≠ `routable`** — an agent can be up, registered, heartbeating and mTLS-probe-green while structurally unable to receive work, because only the first property is measured anywhere.

**Recurrence:** confirmed 2026-08-12 (`groundnuty/macf-auditor-agent#4`, `macf#885` + the sibling inbound PRs). The auditor was isolated in **both** directions: its own config was pre-DR-032 stale (key `auditor` while the registry key is `MACF_AGENT_AUDITOR_AGENT`, `app_name` `auditor` while the bot is `macf-auditor-agent`) **and** no other fleet repo listed it at all. It sat at **turn 3 after 43h47m of uptime** while `macf fleet status` reported online/reachable and `/health` answered. **The hazard is recursive** (cf. Instance 14): the review request for the fix — @mentioning science *on the auditor's repo* — also silently dropped, because that repo's table listed only the auditor. A repo that cannot receive the review of its own repair; recovery required an out-of-band channel.

**The detection gap compounds it — and the run status is a PROXY (Instance 17's shape at the router boundary).** Verified on two runs ten minutes apart in the same repo: `31623337050` (mention **DROPPED**) and `31624148789` (mention **DELIVERED**) both report `conclusion: success`, at **both** the run and the job level. Nothing in the Actions surface distinguishes total delivery from total loss; the only discriminator is the runtime log line `Routed mention to <agent> via mTLS POST`. So any "is routing healthy?" check keyed on run/job conclusion — or on workflow presence, or on the config parsing without error — stays green straight through an outage that dropped every message to an agent for weeks. It was also missed by `routing doctor` check 2b (`macf#874`), whose `botLogins` covers only the *running agent's own* label: a defect **inside our detection capability** that our detection still missed.

**Defense status:**
- **PREVENT (Pattern B — make the bad shape unrepresentable):** `macf repo-init --agents <FULL FLEET>` writes **every** fleet member into **every** repo's table, so a one-agent table cannot be produced by the sanctioned path. This is the ratified *generate, never hand-author* doctrine (`macf#797`/`#805`/`#806`, DR-043's lessons table) applied to the routing plane — the drift here was hand-maintenance, and hand-repairing it preserves the mechanism.
- **DETECT (Pattern A):** assert that a mention can **resolve** — the `Routed mention to <agent>` line — never that the agent is merely registered, reachable, or that the job went green.

**Pattern:** B (prevent — full-fleet generation) + A (detect — assert the routed-line, never the run status).

---

### Instance 19 — a stale copy produces confident, well-formed output that is false about what is deployed: correct logic, outdated copy (generated artifacts AND cited facts)

**Surface:** anything produced from a copy that is not the live one. Two surfaces so far: **(a) emit** — any artifact-generating CLI run from a stale `dist/` (`macf repo-init` concretely, and by extension every generator whose output is a durable, security-relevant file); **(b) cite** — any `grep`/read run in a stale checkout whose result is then asserted as current fact (a review claim, an issue comment, a design ruling). The widening principle: **a claim is an artifact too, and a stale tree is a stale build for the purpose of producing one.**

**Failure shape:** the logic is **correct**; an outdated copy of it ran. `macf repo-init` from a July build emitted `.github/workflows/agent-router.yml` with **no `permissions:` block** (hence no `issues: write`) and **no `check_suite` trigger** (hence dead CI-completion routing), printed its normal success banner, and produced two spurious `Error: fetch failed`. `package.json` reported `0.2.55` while `dist/.build-info.json` recorded commit `06b3ce6` built 2026-07-05 — and that dist's `repo-init.js` contains **zero** occurrences of `permissions:`. Re-running from a current source build emits both correctly.

**Why this is its own instance and not Instance 17 at another boundary:** Instance 17 is a **substitution** failure — current logic asserting a cheap proxy in place of its invariant. This is a **currency** failure — correct logic, outdated copy. Nothing is substituted; the artifact is simply what an older build believed. The surface differs too (a file-writing CLI, not a health verdict), so a reader hitting it would never find it catalogued under "checks assert proxies."

**The load-bearing property — a stale generator inverts its own defense.** This codebase ratified *generate, never hand-author* precisely because generated output is **born-correct**. A silently-stale generator therefore **hand-drifts on your behalf while carrying the authority of "generated"**: it converts a ratified defense into the hazard that defense exists to prevent, and does so behind a success banner that makes the output *more* trusted than a hand-edit would have been. It was caught here only because a reviewer required regeneration and the author diffed the emitted artifact before committing — neither of which is a mechanism.

**Two faces, one defect.** The emit side writes a degraded artifact; the cite side asserts a false fact. Both are *correct logic on an outdated copy*, and both take the same defense — assert the currency of the source before trusting its output — which is why they share a number (the catalog's test: **a new number needs a distinct defense**). They are separated here only because the emit side leaves a durable wrong file while the cite side leaves a wrong belief in someone else's head, and a reader who meets only the emit side will not think to check a `grep`.

- **Emit side — the artifact is wrong** (`macf#886`, above): a July `dist/` emits a gutted `agent-router.yml` behind a success banner.
- **Cite side — the *claim* is wrong** (`macf#872`, 2026-08-13): an agent grepped `repo-init.ts` for `secrets: inherit`, read line **205**, and cited it as evidence in a design thread; `origin/main` had it at **238**. The checkout was **25 commits behind** — still on the previous day's `6128e06`, predating everything merged that day *including several of the citing agent's own merged PRs*. The conclusion drawn happened to survive (the finding was placement, not line number), but the evidence offered for it was a fact about a snapshot nobody was running.

**The cite side's mechanism is worth naming precisely, because it is not simple neglect — it is a *split-currency instrument*.** The agent had been building in isolated worktrees created off a fresh `FETCH_HEAD` (deliberate policy: the shared checkout carries other live sessions' uncommitted files), so every *build* was current. But ad-hoc `grep`s run for *reasoning* were executed in the shared checkout, which was never synced — by the same deliberate policy. So builds were pinned to today and verification reads to yesterday, **and nothing surfaced the split because both halves produce confident, well-formed output**. A split-currency instrument is more dangerous than a uniformly stale one: the current half continuously vouches for the stale half, so the operator's trust in the build is silently extended to the citation.

**Near-duplication is this class's second-order hazard.** On the same thread, *both* agents independently began drafting a NEW catalogue entry for the cite side ("right operation, wrong instance") — which is Instance 20's ratified title almost verbatim — and both stopped only on reading the file. Two independent near-duplicates in one thread suggests the catalogue's growth risk has shifted from *gaps* to *duplication*, and that the check-the-file-before-proposing discipline is what keeps it honest. Applying the distinct-defense test is what separated this sighting (currency → assert the source's freshness) from the superficially similar `macf#889` (subject-by-convention → derive the subject), which is already Instance 20's write side.

**Recurrence:** confirmed `macf#886` (2026-08-12, emit) and `macf#872` (2026-08-13, cite); the second and third manifestations of the `macf#144` stale-dist hazard class, whose first instance motivated the build-info staleness warning on `macf update`.

**Defense status:**
- **DETECT:** extend `#144`'s staleness warning from `macf update` to **every artifact-generating command**. The warning currently fires on the command that *updates* the toolchain, not on the commands that *emit durable artifacts* — exactly inverted, since a security-relevant generated file is the worst possible output to accept from an unknown-age build.
- **ASSERT (Pattern A at the emit boundary):** after generating, verify the artifact contains its required invariants (`permissions:`, the full trigger set) and fail loud when absent — so a stale generator cannot report success over a gutted file. Sibling to Instance 17: both are Pattern A, at opposite boundaries — **17 observes, 19 emits**.
- **CITE SIDE — make the source's currency explicit in the command, not remembered.** The behavioral floor is one cheap check before offering a read as evidence: `git rev-list --count HEAD..origin/main` (non-zero ⇒ the tree is not the thing anyone runs). The structural improvement is to **cite from a named-current source rather than from ambient tree state** — `git show origin/main:<path> | grep -n <pattern>` names its own provenance in the command itself, so the claim carries its currency instead of depending on an invisible property of the working directory. Same shape as preferring an explicit allowlist over `git add -A`: replace "the state happens to be right" with "the command says which state."

**Pattern:** A (emit-time result-invariant assert) + staleness-detection promoted to the generator boundary + source-currency made explicit at the cite boundary.

---


### Instance 20 — a component resolves its subject by scan/convention instead of identity, and operates on a PEER's: right operation, wrong subject (reads AND writes)

**Surface:** any component that must locate a subject it owns — "my own" artifact (log, socket, pidfile, port, state dir) **to read**, or the right target **to write/delete** — where sibling artifacts of peers live alongside it: a shared host, a shared registry namespace, a conventional directory. Sightings so far: the SessionStart guards resolving their channel-server log (`check-channel-alive.sh` / `check-channels-enabled.sh`), `macf update` resolving which plugin dir to write, and the teardown ladder resolving which registry keys to delete.

**Failure shape:** the guard cannot locate its subject from identity, so it *searches the host* and takes the best-looking candidate — `ls -t ~/.local/state/macf/*/channel.log | head -n1`, the newest log on the whole box. On a multi-agent host that is a **peer's**. The measurement is then performed correctly — on the wrong subject — and the verdict is reported as if it were the agent's own. Distinct from Instance 17: 17 measures *the wrong property* of the right subject; this measures *the right property* of the wrong subject, and the defenses are orthogonal (17 wants a better assertion; this wants identity-derived resolution).

**The verdict polarity is incidental, which is why the pairing matters.** The same fallback line produced both signs:
- **False green (`macf#887`):** a quiet agent reads a busy peer's healthy log and reports the peer's channel-server as its own. Worse, `check-channel-alive.sh` then read the *peer's* host/port out of that log and `curl`ed it. Self-defeating by construction — the agent most likely to hit the fallback (launcher too stale to export `MACF_LOG_PATH`) is exactly the one whose own server is most likely broken, and it gets a green light from someone else's health.
- **False DEAD (`macf#793`, verified live 2026-07-05):** `MACF_LOG_PATH` was correctly set to the agent's OWN log, but at guard-run time the channel-server (an async MCP stdio child) had not yet *created* the file, so `[ -r "$MACF_LOG_PATH" ]` was false → same fallback → picked the busy `macf@code-agent` log → read *its* port (9032) → probed 9032 with the icsoc agent's cert → cross-CA mTLS reject → 3 failed probes → confident "DOWN" about a server that was verifiably UP on 9777.

So a single wrong-subject resolution yields a false pass or a false fail depending only on *whose* artifact was freshest. Any check whose conclusion depends on which peer happened to write last is not measuring its own subject at all.

**Two faces, one defect.** The read side yields a *borrowed verdict*; the write side *acts on the wrong thing*. They are the same failure — subject resolved by scan/convention rather than by identity — and they take the same fix, which is why they share a number (the catalog's own test: **a new number needs a distinct defense**; these have one defense, one sentence). They are separated here only because the read side is recoverable and the write side often is not, and a reader who meets only the read side would otherwise under-rate the class:

- **Read side — a borrowed verdict.** `macf#887` (false-green: a quiet agent reads a busy peer's healthy log and reports it as its own) and `macf#793` (false-DEAD: same fallback, a peer's stale log → probing *its* port with our cert). Recoverable: the verdict was wrong, nothing was changed.
- **Write side — the wrong thing is changed, and success is reported.** `macf#889`: `macf update` wrote plugin assets to the conventional `.macf/plugin` while the launcher mounted `.macf/plugin-cs`; every step succeeded against a directory nobody mounts, the operator was told the upgrade landed, and the agent silently stayed on `0.2.47`. Recoverable (re-run against the resolved dir) but invisible without a downstream version-gate.
- **Write side, irreversible — the design rail that anticipated this.** DR-043 **Amendment G** forbids the teardown ladder from ever enumerating its targets by name pattern: *"Never scan-and-delete by name pattern — EXACT-KEY targeting only … a prefix sweep could delete **another live fleet's registration**."* Same root (subject-by-pattern, not by identity), worst consequence: `#889` writes the wrong thing; a prefix sweep **destroys** the wrong thing. Note what this sighting adds evidentially — it is not an incident report but a **ratified design contract that independently reached the same rail before any incident, in a layer with no hooks in it**. Two sightings inside one script invite "isn't that just that script's quirk?"; a hook bug, a CLI bug, and a design rail do not.

**Recurrence:** 3 sightings across 3 layers — 2 verified read-side on one line (`macf#887` false-green; `macf#793` false-DEAD, live during the icsoc DR-032 relaunch), 1 verified write-side in the CLI (`macf#889`), plus the DR-043 Amendment-G design rail above. Blast radius confirmed on the substrate host at catalog time: **five** channel logs under `~/.local/state/macf/` (`macf@devops-agent`, `macf@code-agent`, `macf@macf-science-agent`, `macf@auditor-agent`, `icsoc-2026@code-agent`) — the glob's pick is simply whoever wrote most recently.

**Defense (one sentence, both faces):** **derive the subject from resolved identity — never by scanning, convention, or name pattern — and when identity cannot be resolved, refuse rather than guess.** For destructive targets this hardens to *exact-key only* (Amendment G). Shipped read-side as `macf#892`, write-side as `macf#896` (`update` resolves the **mounted** plugin dir from `claude.sh`, and if the mount is undeterminable it warns loudly and **writes nothing** rather than defaulting to `.macf/plugin`): Resolution order: `MACF_LOG_PATH` → else reconstruct `${XDG_STATE_HOME:-$HOME/.local/state}/macf/${MACF_PROJECT}@${MACF_AGENT_NAME}/channel.log` (the same expression `claude-sh.ts`/`env-files.ts` bake in) → else **say so and skip**, setting an identity-unknown flag rather than guessing. `check-channel-alive.sh` returns *before computing any host/port*, so a peer can never be probed. Two distinctions the fix keeps: **identity-unknown ≠ artifact-not-written-yet** (only the former warns; a known-identity file that does not exist yet is the normal first-launch transient — and this is also what retires #793's false DEAD, since that path now goes quiet instead of probing a peer), and the identity-unknown path stamps the throttle before exiting so a persistently-broken launcher warns once per window rather than every prompt.

**Note on the directory key:** the path interpolates `MACF_AGENT_NAME`, **not** `MACF_ROUTING_LABEL`, even though `coordination.md`'s tmux convention keys on the routing label — confirmed against the live fleet (`macf@macf-science-agent` is science's *agent_name*; its routing_label is `science-agent`) and against `env-files.ts`/`claude-sh.ts`, which interpolate `config.agent_name`. A comment there claiming it "mirrors the canonical tmux session name" is stale; do not "fix" the derivation to match it.

**Test shape worth copying:** the regression pin builds a genuine multi-agent fixture (peer log dirs with their own `server_started` lines) and asserts `curlUrls.length === 0` — proving the peer path is *never read*, rather than that output happened to be quiet. Assert the peer was not touched; do not infer it from silence.

**Pattern:** identity-derived resolution (make the wrong subject unreachable — Pattern B in spirit) + honest-unknown-over-guess when identity is unavailable (Pattern A's floor: report "cannot determine", never substitute a plausible stand-in).

---
## How to recognize the class on first encounter

When investigating a "the operation completed but the outcome is wrong" incident, suspect silent-fallback if ANY of:

1. **Exit code 0 / HTTP 200 with semantic mismatch** — operation reported success, downstream behavior shows it didn't actually work.
2. **Multiple paths share the same exit-code outcome** — the "good path" and the "fallback path" both produce success, but only the good path produces correct semantics.
3. **Detection requires invariant-checking, not error-checking** — to find the failure, you have to query the result and check it against expected shape (token prefix, actor login, recipient activity, downstream telemetry presence).

If you recognize the class on first encounter, file the new instance as a research-doc or insight in your workspace, then propose canonicalization via PR per the threshold in *"When to add a new instance to this rule"* below.

---

## Defensive patterns

Apply the matching pattern when implementing tools that interact with these surfaces.

### Pattern A — Result-invariant assertion

After the operation, assert an invariant on the RESULT, not on the exit code:

```bash
# Don't:
gh issue comment N --body "..." || exit 1   # exit 0 doesn't prove correct attribution

# Do:
gh issue comment N --body "..."
COMMENT_AUTHOR=$(gh issue view N --json comments --jq '.comments[-1].author.login')
[ "$COMMENT_AUTHOR" = "$EXPECTED_BOT" ] || { echo "FATAL: wrong author"; exit 1; }
```

### Pattern B — Pre-flight state validation

Before the operation, validate that the precondition for the good path holds. **Validate the full shape of the state, not just a coarse prefix** — coarse-grained checks admit malformed-but-prefix-conformant values that satisfy the gate but violate the actual contract.

```bash
# WRONG: prefix-only check — admits values like "ghs_; rm -rf x" through
[[ "$GH_TOKEN" == ghs_* ]] || { echo "FATAL: bad token"; exit 1; }
gh ...

# RIGHT: validate the invariants WE own — non-empty, our-prefix, injection-safe
# charset. NOT length, NOT the provider's internal format (see the boundary
# note below): the charset is what carries the injection-safety.
[[ "$GH_TOKEN" =~ ^ghs_[A-Za-z0-9._-]+$ ]] || { echo "FATAL: bad token shape"; exit 1; }
gh ...
```

**Why this matters:** the §4.4 failure-injection sprint (paper-research §27) found that the deployed `check-gh-token.sh` PreToolUse hook used a substring prefix check (`${GH_TOKEN_VALUE:0:4} == ghs_`), which admitted the injection `GH_TOKEN=ghs_; rm -rf <sentinel>` (first-4-char check passes; full shape contains shell metacharacters). End-to-end attribution was still caught at the gh API boundary (HTTP 401 on a malformed token), so production behavior was unaffected — but Pattern B's specific contract (block-at-the-boundary) was bypassed for that injection class. The charset-restricted regex above (or equivalent) restores the contract.

**The boundary of "full shape" — validate the invariants you OWN; treat a PROVIDER's internals as opaque (2026-08-10, `macf#825`/`#826`/`#829`).** The §4.4 lesson over-rotates when "full shape" is read as "hardcode the provider's current internal format." Lived instance: our token predicates encoded GitHub's historical 40-char opaque `ghs_` format (`^ghs_[A-Za-z0-9_]+$`, no dots) — then GitHub changed the format ([changelog 2026-04-24](https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/): stateless `ghs_<app-id>_<JWT>`, dots + dashes, variable ~380–520 chars, with explicit *treat-tokens-as-opaque, drop your regexes* guidance). When the rollout reached our Apps, the strict predicates **false-positived on valid credentials** and blocked 10/14 workspaces' write path — **a Pattern-B validator hardcoding provider internals converts the provider's format evolution into a self-inflicted outage** (loud-false-positive — the inverse failure of the silent-fallback this rule catalogs, produced by the *defense* itself). The durable form: validate **only the invariants whose contract you own** — non-empty (catches the empty/`null` fallback), the `ghs_` prefix (rejects user-token classes `ghp_`/`gho_`/`ghu_`), and an injection-safe charset (`[A-Za-z0-9._-]` — excludes whitespace/`;`/`$`/`()`/backtick, which was always the load-bearing part) — and treat length + internal structure as the provider's business. Fixed in lockstep across all predicate sites (`macf#829`: the #140 hook + the #821 launch-check + `release.sh`'s mint-gate — a format change must never be widened at one site only, or the site disagreement recreates the deadlock).

**Coverage-gap classification:** defense-pattern coverage gaps inside the deployed boundary are themselves a sub-class of silent-fallback hazard, distinct from the designed-defense gap the pattern targets. The Pattern B example above is the canonical instance; sister observations may surface in other patterns where coarse-grained checks substitute for full-shape validation. Reviewers extending this catalog should test their patterns' deployed implementations against shape-violation injections, not just contract-violation injections — **and against provider-format evolution** (would this check survive the provider changing its internal encoding? If not, it validates something you don't own).

### Pattern C — Heartbeat / activity invariant

For routing-style operations, check that recipient pane state advanced post-delivery — by **content-diffing the captured pane**, NOT via `#{session_activity}`:

```bash
# tmux send-keys + check the pane CONTENT changed (Remote Control IPC detector)
PRE=$(tmux capture-pane -t $SESSION -p | md5sum)
tmux send-keys -t $SESSION "..." Enter
sleep 2
POST=$(tmux capture-pane -t $SESSION -p | md5sum)
[ "$PRE" != "$POST" ] || { echo "WARNING: pane content didn't change — RC-bound / not processing?"; }
```

> **⚠️ `#{session_activity}` is NOT a reliable activity/liveness signal — verified-corrected 2026-06-28 (`macf#645`).** A controlled test (detached session, 5 s of pure streaming output, no input) found `session_activity` **stayed stable** — it does **not** advance on an output-busy agent (spinner / streaming / tool-renders), and in that test did not advance on a `send-keys` either (likely a detached-session quirk; the precise input/output trigger is murky). The firm, verified conclusion: **`session_activity` cannot tell "working" from "dead" for an agent producing output**, so any "did it land / is it busy / did the prompt clear" check built on it **silently misclassifies a working agent**. **`capture-pane -p | md5sum` over a short window** detects real pane change (output OR echoed input) and is the correct primitive. This corrected a shipped Tier-2 aliveness-gate (`macf-devops-toolkit#128` / DR-031) that, on the old primitive, would have SIGTERM'd a streaming-busy agent it read as "not busy." Every place this catalog or a DR reaches for `session_activity` as an activity check should use the capture-pane content-diff instead.

### Pattern D — Precheck step at workflow / process entrypoint

For long-running workflows where a missing/misnamed configuration input renders as empty-string and causes a downstream tool to surface a misleading error: add a fail-fast precheck early in the execution that asserts the configuration shape is correct, aggregating ALL missing items into one error message rather than failing on the first miss.

```bash
# GitHub Actions workflow precheck (runs after checkout, before any tool that consumes the secrets)
# Aggregate-fail-loud over fail-on-first-miss — operator sees ALL gaps in one fire.
set -euo pipefail
missing=()
[ -z "${TAILSCALE_OAUTH_CLIENT_ID:-}" ] && missing+=("TAILSCALE_OAUTH_CLIENT_ID (secret)")
[ -z "${TAILSCALE_OAUTH_SECRET:-}" ]    && missing+=("TAILSCALE_OAUTH_SECRET (secret)")
# ... etc per expected secret/var
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Missing required workflow inputs:"
  for m in "${missing[@]}"; do echo "::error::  - $m"; done
  echo "::error::See docs/<runbook>.md for the runbook."
  exit 1
fi
echo "✓ All expected secrets + variables present"
```

Key elements:
- `${VAR:-}` defaulting required (without it, `set -u` fails BEFORE the precheck can collect the missing names). Note: `${VAR:-}` returns empty string when unset, AND empty string is the actual signal — GitHub Actions substitutes empty for missing secrets/vars (not "undefined"). The precheck detects "missing OR explicitly-empty" uniformly, which is correct: an operator setting a secret to empty string IS a misconfiguration worth blocking.
- Distinguish "(secret)" vs "(variable)" annotation — saves the operator a settings-page click
- Aggregate via `missing=()` array + `${#missing[@]}` length check
- One `::error::` annotation per missing item (GitHub UI renders red error annotations)
- Runbook cross-reference embedded in the error message

Generalizes beyond GitHub Actions: any process that consumes configuration from external sources benefits from a precheck-at-entrypoint pattern. The hazard is that empty-config typically causes a misleading downstream error rather than failing at the configuration boundary; the defense is asserting at the boundary itself.

### Pattern E — Type-discriminator at the receiver

For multi-agent protocols where notifications can drive recipient behavior: discriminate by message type at the receiver and restrict action-triggering paths to types that intentionally drive action. Informational types (peer notifications, status updates, FYI) flow through MCP push or equivalent observability surfaces but do NOT auto-trigger fresh turns / Stop hooks / response side-effects.

```typescript
// Receiver's notification handler
async function onNotify(payload: NotifyPayload, ...) {
  // Always: deposit into observable state (MCP push, log, metrics)
  await pushToMcpChannel(payload);

  // Conditional: discriminate by type for action-triggering side effects
  if (payload.type === 'peer_notification') {
    // Observational only — no fresh turn fires; recipient's LLM SEES the
    // notification via MCP channel state but doesn't auto-respond.
    // Cross-agent loop class structurally retired.
    logger.info('action_path_skipped', {
      reason: 'type_discriminator',
      type: payload.type,
    });
    return;
  }

  // Action-triggering types preserve current behavior
  if (config.tmuxWakeAvailable) {
    await wakeViaTmux(formatNotifyContent(payload));
  }
}
```

Key elements:
- **Always** deposit into observable state (preserves visibility / paper-trail)
- **Conditional** action-triggering (preserves termination by restricting which messages drive emergent behavior)
- **Explicit log** when the action path is skipped (surfaces the discrimination decision in operational logs; debuggable)

Pattern E specifically addresses the **multi-agent coordination protocol** layer where Patterns A-D don't apply — the issue isn't single-step semantic mismatch (Patterns A/B/C catch those) or config-substitution failure (Pattern D), but emergent multi-step behavior driven by misaligned action-triggering semantics. Pattern E restores the design assumption ("informational notifications don't drive turn-taking") at the implementation layer.

Generalizes to any multi-agent protocol with mixed informational + actionable notifications: the discriminator IS the contract, encoded at the receiver where it can't drift away from the implementation.

---

## Why this class matters at the architectural level

Silent-fallback hazards are **architectural**, not implementation bugs. They emerge from:

- Layered abstractions where a lower layer's "success" doesn't guarantee the upper layer's semantic correctness (tool API vs intent)
- Default-fallback paths designed for resilience that produce wrong-but-successful outcomes when the primary path fails
- Detection-via-invariant rather than detection-via-error-code

For coordination-system safety analysis: this is a class of hazards multi-agent systems must explicitly defend against. Each new instance teaches the same lesson; the class-name is what makes the lesson transferable across agents.

### Defense-pattern emergence (18-of-19 active instances have structural defense applied or shipped)

| Instance | Surface | Structural defense | Pattern |
|---|---|---|---|
| 1 — gh-token attribution traps | `gh` ops + bot tokens | PreToolUse hook + helper-with-fail-loud-prefix-check; expiry sub-case (macf#317) adds in-runner token refresh in macf-channel-server (`token-refresh.ts` + `refresh-aware-client.ts`) — caches token ~50min, force-refreshes on 401 | Pattern B (acquisition) + Pattern A (expiry retry) |
| 2 — GitHub auto-close negation-blindness | PR/issue body markdown | Structural defense SHIPPED — `check-close-keyword.sh` PreToolUse hook (groundnuty/macf#431) blocks `gh pr create`/`edit` carrying a close-keyword adjacent to another agent's `#N` | Pattern B (mitigated) |
| 3 — tmux-wake keystroke swallowed by an alternate input consumer (RC-IPC-binding **or** a modal input state: `/login`, rating survey, ceremony prompt — verified 2026-07-05) | Claude Code TUI input | Load-bearing = native channels (macf#641 — delivery independent of tmux input state, covers both sub-shapes); modal auto-clear (macf#703/DR-033) covers the modal sub-shape; consumer-fleet content-drop retired via channel-server HTTPS POST (DR-020); substrate = rule-discipline + Pattern C fragility detector | Pattern B (native channels — bad delivery-path unrepresentable) + Pattern C (fragility detector) |
| 4 — Loki/CH-logs pipeline divergence | OTLP logs routing | manifest warnings + shape-aware diagnostic | Pattern A |
| 5 — Workflow secrets-misnamed | GitHub Actions workflow inputs | Workflow precheck step | Pattern D |
| 6 — Cross-agent notification loop | Multi-agent coordination protocol | macf v0.2.4 + v0.2.21: event-discriminator in receiver's `decideWake()` — autonomous events skip wake (observational-only); `event: 'custom'` (operator-driven) wakes; other `NotifyType`s preserve wake-on-receipt | Pattern E |
| 7 — OTel-counter cumulative-state vs short-lived-process lifecycle | Metric-instrumentation lifecycle | Two-phase: doc workaround `sum(increase(...))` + OTel SDK delta temporality | Pattern A |
| 8 — OTLP endpoint silent-drop | Observability-endpoint routing | Five-surface defense: CLI release-discipline + substrate testers env-override + canonical template `:14318` default + cluster-side compat port-map + agent-process `doctor-otel.sh` Pattern A | Pattern A (composite — first multi-architectural-layer case in this rule; instances 1-7 have single-pattern defenses) |
| 9 — Sigstore TLOG orphans on failed npm publish (sister-class) | npm publish + sigstore attestation pipeline | Three-defense composite: bump-version recovery (DR-022 Amendment L) + pre-flight registry-collision check (Pattern D analog, macf#380) + TLOG-state observability (devops-toolkit#74+#77 Grafana dashboard live) | Pattern D analog (pre-flight precheck) + recovery-procedure-codification |
| 11 — Third-party retry-wrapping action exits 0 on retry-exhaustion | Consumer-CI connect/auth via third-party action (tailnet, OTLP, cloud-auth, registry-login) | SHIPPED — "Verify <resource> is up" step immediately after the connect asserts the connection's result-invariant (e.g. `tailscale status` `BackendState == "Running"`) + fails LOUD; never trusts the action's exit code about its own retry exhaustion (macf#461) | Pattern A (post-connect result-invariant assert) + Pattern D flavor (precheck-before-downstream) |
| 12 — PreToolUse credential-guard validates ambient token, blind to inline reassignment | gh-token PreToolUse hook + inline `export GH_TOKEN=$(...) && gh` (refresh-chain or file-cache) | DOC shipped (de-footgun `gh-token-refresh.md` + atomic-validated cache) + STRUCTURAL in flight (Pattern A result-invariant PostToolUse whoami post-check, macf#489) | Pattern A (result-invariant post-check — a wrong-temporal-level precondition can't see the inline clobber) |
| 13 — PR-review-state routing strands third-party gate-owners (reviewer ≠ next-actor) | `route-by-pr-review-state` notifies the PR author only; a review that clears a *third* agent's gate fires no signal to that agent | Load-bearing fix is structural (in flight) — extend `route-by-pr-review-state` to notify deliberate review-engagement (formal reviewers + requested reviewers + body-@mentioned parties), not the author alone (`macf-actions#57`); Path-2 promotion (cf. the `check-*.sh` family). Backstop = `coordination.md §Communication 5(c)` gate-sweep (assert the APPROVED review exists on GitHub, don't wait for a ping), generalizing the §5(b) reviewer-sweep to the gate-owner side | structural route-extension (load-bearing) + Pattern A (gate-side result-invariant assert, backstop) |
| 14 — context-free `type:mention` (no anchor AND no message) delivered-but-useless → bare "You were mentioned", work strands | channel-server `/notify` `type:mention` payload | `NotifyPayloadSchema.refine` requires actionable content (message OR issue/PR anchor; diagnostic-exempt) → reject anchorless-AND-message-less at PARSE with a loud 400, never silent `mcp_push` (`macf#620`); corrected anchor-only → message-OR-anchor so `--inject`'s message-bearing probe isn't 400'd (`macf#630`) | Pattern B (schema-level reject-at-parse) + Pattern A (recipient-side sweep, backstop) |
| 15 — launcher omits CC channels flag → agent silently deaf to ALL native channel notifications | `claude.sh` → Claude Code MCP channel-notification gating (v2.1.80+) | PREVENT: `claude.sh` emits `--dangerously-load-development-channels server:macf-agent` (the only form CC accepts for a non-allowlisted plugin-dir plugin), version-gated ≥2.1.80 + loud-warn + `MACF_CHANNELS_DISABLED`/`MACF_CHANNELS_ARGS` opt-outs (`macf#632`). DETECT: SessionStart `check-channels-enabled.sh` warns LOUD into the agent's context on the skip-message (`macf#633`); proactive argv-check is a follow-up | Pattern B (prevent — enable, version-gated) + Pattern A (detect — channels-enabled startup assert) |
| 16 — CA rotation orphans the out-of-band routing-client-cert secret | `macf certs init`/`rotate` + the routing-client cert (`ROUTING_CLIENT_CERT`/`_KEY` GitHub Actions secrets) | Prevent: rotation-time loud blast-radius WARN enumerating orphaned out-of-band copies + the re-mint/re-set operator commands (DR-010 Amendment, macf#800). Detect: registry-recorded issuer-fingerprint diffed against current CA (`routing doctor`) + a live `route-by-label` mTLS assert (`routing doctor --live`/#798). Remediate: `macf certs issue-routing-client` re-mints + emits `gh secret set` commands | Pattern A (detect — result-invariant issuer-match + live-route-assert) + prevent-side blast-radius WARN (Pattern-D-flavored enumerate-at-the-op) |
| 17 — doctor/health check asserts a cheap proxy instead of the live result-invariant → green when the property is uniformly false | health-check / `doctor` commands (`macf routing doctor`, DR-030) | Fixes in flight (macf#873→#874→#872): each check asserts the result-invariant it's named for LIVE or degrades to `unknown` (A4 floor; forced proxies name their state `presumed-ok`), AND a precondition-failure must fail the verdict rather than be laundered through downstream non-failing states. `macf fleet doctor`'s probe-first + declare-what-you-don't-prove posture is the in-tree template | Pattern A (assert the live result-invariant or degrade to `unknown`) + the precondition-must-fail-the-verdict extension |
| 18 — a repo's agent-config is the routing table for everyone mentioned there; a single-agent config makes the repo a one-way channel (`reachable` ≠ `routable`) | `.github/agent-config.json` + `route-by-mention` / `route-by-pr-review-state` | PREVENT: `macf repo-init --agents <FULL FLEET>` writes every fleet member into every repo's table, so a one-agent table is unproducible by the sanctioned path (the ratified generate-never-hand-author doctrine, macf#797/#805/#806). DETECT: assert the runtime `Routed mention to <agent>` line — NEVER the run/job conclusion, which is identical (`success`) for total delivery and total loss (verified on runs 31623337050 vs 31624148789) | Pattern B (prevent — full-fleet generation) + Pattern A (detect — assert the routed-line) |
| 19 — a stale-build generator emits a degraded artifact and reports success, carrying the authority of "generated" | any artifact-generating CLI command run from a stale `dist/` (`macf repo-init`; macf#886, the 2nd macf#144 stale-dist manifestation) | DETECT: extend #144's staleness warning from `macf update` to every ARTIFACT-GENERATING command. ASSERT: emit-time check that the artifact carries its required invariants (`permissions:`, the trigger set) + fail loud — a stale generator must not report success over a gutted file | Pattern A at the EMIT boundary (17 observes, 19 emits) + staleness-detection at the generator |
| 20 — a component resolves its subject by scan/convention instead of identity → operates on a PEER's (right operation, wrong subject; READS and WRITES) | shared-host guards resolving "my" channel log (`check-channel-alive.sh`/`check-channels-enabled.sh`); `macf update` resolving which plugin dir to write; teardown resolving which registry keys to delete | SHIPPED both faces — read: resolve `MACF_LOG_PATH` → else derive from own identity → else report identity-unknown and SKIP, never `ls -t` the host (macf#892; returns before any host/port is computed, regression pin asserts `curlUrls.length === 0`). write: `update` resolves the MOUNTED plugin dir from `claude.sh` and, if undeterminable, warns loudly and writes NOTHING rather than defaulting (macf#896); destructive targets are exact-key only, never prefix-swept (DR-043 Amendment G) | identity-derived resolution (make the wrong subject unreachable) + honest-unknown-over-guess (Pattern A floor) |

Eighteen of nineteen active instances have structural defense applied, shipped, or in flight. Defense patterns (A, B, C, D, E) generalize across instances — they're reusable defense templates, not case-specific fixes. **Pattern A (result-invariant assertion at the boundary) bears the most weight** — it's the structural defense for instances 4, 7, 8, 11, 12, 15's detect-guard, 16, 17, 18's detect-half, AND 19 (10 of 18), each at a different architectural boundary (logs pipeline, metric counter, observability endpoint, third-party-action connect-verify, credential-refresh temporal-binding, channels-enabled startup assert, CA-rotation issuer-match/live-route, health-check verdict boundary, mention-resolution boundary, generator emit boundary). (For Instance 13, Pattern A is the *backstop* gate-sweep, not the load-bearing fix — that role belongs to the structural route-extension `macf-actions#57`. **Pattern B (schema-level make-the-bad-shape-unrepresentable, reject-at-parse) is the load-bearing fix for Instance 14** + the prevent-half of Instance 15 — a sister structural template to Pattern A: A asserts the result-invariant *after* the boundary, B makes the invalid shape unrepresentable *at* the boundary.) Instance 8's five-surface defense topology (consumer canonical + cluster-side compat port-map + concrete Pattern A impl) demonstrates that structural defense at the observability-pipeline-class can compose across architectural layers — the canonical-distribution layer + the cluster-infrastructure layer + the assertion-script layer all reinforce each other rather than substituting for each other. Instance 9 demonstrates that the Pattern D template generalizes from workflow-secrets-prechecks to release-pipeline-prechecks AND that recovery-procedure-codification (DR-022 Amendment L's bump-version-not-tag-retry) is its own defense category — distinct from detection-pre-merge defenses (Patterns A/B/D) and discrimination-at-receiver defenses (Pattern E).

The breadth of layers spanned by 5 different defense patterns (identity, parsing, TUI binding, observability routing, config substitution, multi-agent coordination protocol, metric-instrumentation lifecycle, observability-endpoint routing, release-pipeline-partial-publish, third-party-action retry-exhaustion, credential-refresh temporal-binding, multi-agent review-gate routing, notification-payload-anchor, channel-flag gating, CA-rotation out-of-band blast radius, health-check-proxy-not-invariant, routing-table dual-role, stale-copy currency (generated artifacts and cited facts)) is independent evidence that the hazard CLASS is real. If silent-fallback was a single-instance accident, no defense pattern would emerge. **Pattern A's recurrence across 3 different observability boundaries (logs / metrics / endpoint) is the strongest signal that result-invariant assertion is the load-bearing structural-defense template for the entire observability-pipeline-class** of silent fallback.

---

## When to add a new instance to this rule

Add when ALL of the following hold:

- A new failure mode of the same shape is observed (success at API boundary, semantic failure invisible)
- The instance has been verified (not just suspected) — minimum 1 incident with a concrete trace
- The defense pattern is identified (otherwise the instance is a TODO, not a documented hazard)

The class-name is what makes the lesson transferable, not multi-agent witness. A single-agent-confirmed instance with a concrete trace + identified defense pattern is sufficient for canonicalization (instances 4, 5, 7, 8 are all single-agent-confirmed). Cross-agent triangulation strengthens the framing but isn't a precondition.

Add as a new numbered section (the next number is **21** — numbering is append-only; retired instances keep their slot, see Instance 10) with the same fields: Surface / Failure shape / Recurrence / Defense status. Increment the intro paragraph's active-instance count + the Defense-pattern emergence header's `N-of-M active instances` count too.

---

## When to read vs modify this rule

- **Read:** every session start. This rule is broadly applicable across coordination, observability, and tool-integration work.
- **Modify:** never directly in workspace copies. Edit the canonical file at `groundnuty/macf:packages/macf/plugin/rules/silent-fallback-hazards.md` and re-run `macf update`.
- **Disagree with a rule?** Open an issue on `groundnuty/macf` proposing the change, with rationale + the incident that showed the rule was wrong. Peer review applies.

---

## Cross-references

- `gh-token-attribution-traps.md` (canonical) — Instance 1 detail
- `pr-discipline.md` + `coordination.md §Issue Lifecycle 1` (canonical) — Instance 2 detail
- DR-020 (Stage 3 mTLS routing) — Instance 3 consumer-fleet structural retirement
- DR-022 / DR-023 (channel-server + MCP-tool architecture) — Instance 6 Pattern E shipping vehicle
