# Silent-Fallback Hazards (canonical, shared)

**This file is the single source of truth for recognizing the silent-fallback hazard class — failure modes where tool/API operations succeed at the API boundary but produce semantically wrong outcomes that are invisible until something downstream breaks.** It is copied into each agent workspace's `.claude/rules/` by `macf init` and refreshed by `macf update` / `macf rules refresh`. Do not edit workspace copies directly — edit the canonical file at `groundnuty/macf:packages/macf/plugin/rules/silent-fallback-hazards.md` and re-run the distribution.

> **Workspaces without full `macf init`** (e.g. `groundnuty/macf` itself, or any Claude Code workspace operated by a bot that isn't a MACF-registered agent) can still get this canonical rule via `macf rules refresh --dir <workspace>`. Same copy, no App credentials or registry required.

This rule names the CLASS so agents recognize the shape on first encounter rather than re-discovering each instance from scratch. Fourteen active instances are documented below as worked examples spanning different architectural layers (identity, parsing, TUI binding, observability routing, config substitution, multi-agent coordination protocol, metric-instrumentation lifecycle, observability-endpoint routing, release-pipeline-partial-publish, third-party-action retry-exhaustion, credential-refresh temporal-binding, multi-agent review-gate routing, notification-payload-anchor, channel-flag gating). (Instance 10 — a legacy substrate-routing receipt-gap — was retired 2026-06-07; its number is kept, not reused.) Thirteen of fourteen active instances have structural defenses applied or in flight — the pattern of defense generalizes alongside the pattern of hazard.

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

### Instance 3 — Remote Control IPC blocking tmux send-keys

**Surface:** Claude Code TUI sessions with "Remote Control active" status
**Failure shape:** `tmux send-keys` exits 0 + keystrokes are written to pane stdin, but Claude Code's input handler is bound to a different IPC channel (RC's SDK socket); routing-via-tmux silently bypasses the actual input path → recipient never sees the routed prompt.
**Recurrence:** Cross-agent triangulated; 2+ confirmed firings on real routes hours apart, same shape.
**Defense status:** Two-tier per fleet class:
- **Consumer fleet** (CV agents, tester agents, future macf-init'd consumers): largely mitigated, not fully eliminated. The routed **message** arrives via the channel-server's HTTP/MCP path (not as a keystroke), so the prompt *content* reaches the agent regardless of RC state — that's the structural win over send-keys routing (DR-020 / macf-actions v3+). The **residual**: the channel-server's `wakeViaTmux` nudge still uses send-keys, so under RC-bound input the auto-wake keystroke may not land — the message sits in the MCP channel until the agent next reads it, rather than being lost. So the hazard is reduced to a wake-latency issue, not a content-drop.
- **Substrate fleet** (workspaces operated as the design surface, not registered MACF consumers): permanent operational reality — substrate workspaces don't run `macf init`. Defensive posture: rule-discipline + Pattern C fragility detector (capture-pane content-diff over a window — NOT `#{session_activity}`, which doesn't reliably advance on agent activity; see Pattern C's 2026-06-28 correction).

The content-drop is retired for the consumer fleet (message arrives via HTTP/MCP); only the wake-nudge residual remains there. The substrate fleet expects full Instance 3 firings to recur on routes indefinitely; rule-discipline catches the failure at observation time, not pre-emptively.

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

# RIGHT: shape validation — restricts to the actual installation-token alphabet
[[ "$GH_TOKEN" =~ ^ghs_[A-Za-z0-9_]+$ ]] || { echo "FATAL: bad token shape"; exit 1; }
gh ...
```

**Why this matters:** the §4.4 failure-injection sprint (paper-research §27) found that the deployed `check-gh-token.sh` PreToolUse hook used a substring prefix check (`${GH_TOKEN_VALUE:0:4} == ghs_`), which admitted the injection `GH_TOKEN=ghs_; rm -rf <sentinel>` (first-4-char check passes; full shape contains shell metacharacters). End-to-end attribution was still caught at the gh API boundary (HTTP 401 on a malformed token), so production behavior was unaffected — but Pattern B's specific contract (block-at-the-boundary) was bypassed for that injection class. The hardened regex above (or equivalent full-shape validation) restores the contract.

**Coverage-gap classification:** defense-pattern coverage gaps inside the deployed boundary are themselves a sub-class of silent-fallback hazard, distinct from the designed-defense gap the pattern targets. The Pattern B example above is the canonical instance; sister observations may surface in other patterns where coarse-grained checks substitute for full-shape validation. Reviewers extending this catalog should test their patterns' deployed implementations against shape-violation injections, not just contract-violation injections.

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

### Defense-pattern emergence (13-of-14 active instances have structural defense applied or shipped)

| Instance | Surface | Structural defense | Pattern |
|---|---|---|---|
| 1 — gh-token attribution traps | `gh` ops + bot tokens | PreToolUse hook + helper-with-fail-loud-prefix-check; expiry sub-case (macf#317) adds in-runner token refresh in macf-channel-server (`token-refresh.ts` + `refresh-aware-client.ts`) — caches token ~50min, force-refreshes on 401 | Pattern B (acquisition) + Pattern A (expiry retry) |
| 2 — GitHub auto-close negation-blindness | PR/issue body markdown | Structural defense SHIPPED — `check-close-keyword.sh` PreToolUse hook (groundnuty/macf#431) blocks `gh pr create`/`edit` carrying a close-keyword adjacent to another agent's `#N` | Pattern B (mitigated) |
| 3 — Remote Control IPC blocking tmux send-keys | Claude Code TUI input | Two-tier: consumer fleet structurally retired via channel-server primitive (DR-020 mTLS HTTPS POST); substrate fleet permanent operational reality — defense = rule-discipline + Pattern C fragility detector | Pattern C deployable as fragility detector |
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

Thirteen of fourteen active instances have structural defense applied, shipped, or in flight. Defense patterns (A, B, C, D, E) generalize across instances — they're reusable defense templates, not case-specific fixes. **Pattern A (result-invariant assertion at the boundary) bears the most weight** — it's the structural defense for instances 4, 7, 8, 11, 12, AND 15's detect-guard (6 of 14), each at a different architectural boundary (logs pipeline, metric counter, observability endpoint, third-party-action connect-verify, credential-refresh temporal-binding, channels-enabled startup assert). (For Instance 13, Pattern A is the *backstop* gate-sweep, not the load-bearing fix — that role belongs to the structural route-extension `macf-actions#57`. **Pattern B (schema-level make-the-bad-shape-unrepresentable, reject-at-parse) is the load-bearing fix for Instance 14** + the prevent-half of Instance 15 — a sister structural template to Pattern A: A asserts the result-invariant *after* the boundary, B makes the invalid shape unrepresentable *at* the boundary.) Instance 8's five-surface defense topology (consumer canonical + cluster-side compat port-map + concrete Pattern A impl) demonstrates that structural defense at the observability-pipeline-class can compose across architectural layers — the canonical-distribution layer + the cluster-infrastructure layer + the assertion-script layer all reinforce each other rather than substituting for each other. Instance 9 demonstrates that the Pattern D template generalizes from workflow-secrets-prechecks to release-pipeline-prechecks AND that recovery-procedure-codification (DR-022 Amendment L's bump-version-not-tag-retry) is its own defense category — distinct from detection-pre-merge defenses (Patterns A/B/D) and discrimination-at-receiver defenses (Pattern E).

The breadth of layers spanned by 5 different defense patterns (identity, parsing, TUI binding, observability routing, config substitution, multi-agent coordination protocol, metric-instrumentation lifecycle, observability-endpoint routing, release-pipeline-partial-publish, third-party-action retry-exhaustion, credential-refresh temporal-binding) is independent evidence that the hazard CLASS is real. If silent-fallback was a single-instance accident, no defense pattern would emerge. **Pattern A's recurrence across 3 different observability boundaries (logs / metrics / endpoint) is the strongest signal that result-invariant assertion is the load-bearing structural-defense template for the entire observability-pipeline-class** of silent fallback.

---

## When to add a new instance to this rule

Add when ALL of the following hold:

- A new failure mode of the same shape is observed (success at API boundary, semantic failure invisible)
- The instance has been verified (not just suspected) — minimum 1 incident with a concrete trace
- The defense pattern is identified (otherwise the instance is a TODO, not a documented hazard)

The class-name is what makes the lesson transferable, not multi-agent witness. A single-agent-confirmed instance with a concrete trace + identified defense pattern is sufficient for canonicalization (instances 4, 5, 7, 8 are all single-agent-confirmed). Cross-agent triangulation strengthens the framing but isn't a precondition.

Add as a new numbered section (the next number is **16** — numbering is append-only; retired instances keep their slot, see Instance 10) with the same fields: Surface / Failure shape / Recurrence / Defense status. Increment the intro paragraph's active-instance count + the Defense-pattern emergence header's `N-of-M active instances` count too.

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
