# Glossary

Term definitions for MACF. Cross-references point to canonical artifacts (DRs, phase specs, insights) rather than paraphrasing them.

## Agent

A long-running Claude Code session in a tmux window on a VM, with its own GitHub App identity (e.g., `macf-code-agent[bot]`, `macf-science-agent[bot]`). Agents communicate through GitHub issues + PRs (Stage 2: SSH+tmux delivery; Stage 3: mTLS HTTPS POST), not directly.

## Agent identity

Each agent has one GitHub App. The App provides authentication (installation tokens for `gh` CLI), attribution (`<app-name>[bot]` username on commits/comments), and permissions (per [DR-019](../design/decisions/DR-019-app-permissions.md): metadata, contents, issues, pull_requests, actions_variables, workflows, actions).

## Bot token

A short-lived (1-hour) GitHub App installation token (prefix `ghs_`) generated from the App's private key. Used by `gh` CLI for all bot-attributed operations. The fail-loud helper at `.claude/scripts/macf-gh-token.sh` validates the prefix and emits diagnostics on failure (clock drift, missing key, wrong App ID). Never use the bare `gh token generate ... | jq` pattern — see [DR-019](../design/decisions/DR-019-app-permissions.md) and [coordination.md Token & Git Hygiene](../packages/macf/plugin/rules/coordination.md).

## Canonical / canonical content

Content that is the single source of truth for the framework. Lives in `groundnuty/macf` under `design/`, `packages/macf/plugin/rules/`, `packages/macf/scripts/`. Distributed to consumer workspaces by `macf init` and refreshed by `macf update` / `macf rules refresh`. Contrast with **substrate workbench copies** (e.g., `groundnuty/macf-science-agent:.claude/rules/`) which are operational copies, not authoritative.

## Channel server

Per-agent HTTPS server (mTLS-authenticated) accepting `POST /notify` for inbound coordination events. Spawned as an MCP stdio child by the `macf-agent` plugin on session start. Self-registers in the project's GitHub Variables (`MACF_<PROJECT>_AGENT_<NAME>`) so peers can resolve the address. Implementation: `@groundnuty/macf-channel-server` (npm). Specs: [DR-002](../design/decisions/DR-002-channel-per-agent.md), [DR-015](../design/decisions/DR-015-http-endpoints.md), [P1](../design/phases/P1-channel-server.md).

## Class A–H (self-observation breach taxonomy)

Eight classes of self-observed canonical-rule breaches catalogued in `groundnuty/macf-science-agent:research/2026-04-27-self-observed-canonical-rule-breach-pattern-analysis.md`. Roughly: Class A = missing-@mention; Class B = describing-context leak; Class C = closure-direction inversion; etc. Used to track which discipline classes need Path-1/2/3 promotion (see below).

## Consumer / consumer-fleet

A project that uses MACF for coordination but doesn't develop the framework itself. CV agents (`groundnuty/academic-resume`, `groundnuty/cv-project-archaeologist`) are the first consumer-fleet. Consumers run `macf init` to bootstrap; substrate workspaces never run `macf init` per operator directive 2026-04-27.

## CPC (Claude Plan Composer)

The 2-agent proof-of-concept that preceded MACF. 11 days production data on a scientific-workflow project: 128 issues, 175 PRs merged, 6.8M output tokens + 10.26B cache-read tokens (1,511:1 cache-read-to-output ratio), 1.18× multi-agent overhead, 22.7% asymmetric-context savings vs symmetric-max-context configuration. Repo: [`groundnuty/claude-plan-composer`](https://github.com/groundnuty/claude-plan-composer). MACF generalizes the PoC into an N-agent framework.

## DR (Decision Record)

Architecturally-significant decisions with rationale. 23 DRs in `design/decisions/DR-001-*.md` through `DR-023-*.md`. Format: context → decision → consequences → alternatives. Cited inline throughout the codebase + docs.

## Diátaxis

Documentation framework distinguishing four content types by user need:

- **Tutorials** (learning-oriented) — guided lessons; safe to fail
- **How-to guides** (problem-oriented) — solutions to specific problems
- **Reference** (information-oriented) — facts about each component
- **Explanation** (understanding-oriented) — clarifies design decisions

Source: <https://diataxis.fr> (Daniele Procida). MACF's `docs/` follows the framework loosely — `quickstart.md` = tutorial; `concepts.md` + `use-cases.md` = explanation; `features.md` + `glossary.md` = reference; `troubleshooting.md` + `faq.md` = how-to + explanation hybrid.

## Discipline-canonicalization

The cycle by which substrate-evolved coordination discipline gets promoted to canonical content + structurally enforced. Eight iterations observed v0.2.1 → v0.2.9 over ~76 hours per `groundnuty/macf-science-agent:insights/2026-04-30-rehearsal-13b-empirical-witnesses.md`. Each iteration: substrate observes a breach, codifies a rule, ships canonical update, consumers pick up via `macf update`.

## GitHub App

GitHub's first-class bot-identity primitive. MACF uses one App per agent. Apps have installation tokens (1-hour TTL), per-resource permissions, and produce attribution as `<app-name>[bot]`. Manifest template at `templates/macf-app-manifest.json`.

## Hook (PreToolUse)

Claude Code lifecycle hook that intercepts a tool call before it executes. Used by MACF to structurally enforce coordination discipline (Path-2 promotion):

- `check-gh-token.sh` ([macf#140](https://github.com/groundnuty/macf/issues/140)) — blocks `gh` ops when `GH_TOKEN` lacks `ghs_` prefix (attribution-trap defense)
- `check-mention-routing.sh` ([macf#272](https://github.com/groundnuty/macf/issues/272), [macf#244](https://github.com/groundnuty/macf/issues/244)) — Check B (must-not-leak: blocks raw `@<bot>[bot]` in describing-context) + Check A (must-have-mention: blocks comment bodies with no addressing)

Exit 2 = block; exit 0 = allow. Override via `MACF_SKIP_*_CHECK=1` for legitimate edge cases.

## Installation token

GitHub App's per-installation authentication token. 1-hour TTL; regenerated from the App's private key + JWT exchange. Prefix `ghs_`. See **Bot token** above.

## MACF (Multi-Agent Coordination Framework)

This framework. Three repos: [`groundnuty/macf`](https://github.com/groundnuty/macf) (CLI + design + rules), [`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace) (plugin distribution), [`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions) (reusable routing workflow).

## MCP (Model Context Protocol)

Anthropic's stdio-based protocol for tool/resource extension to Claude Code. The macf-agent plugin's `mcpServers.macf-agent` entry tells Claude Code to spawn `@groundnuty/macf-channel-server` as an MCP stdio child on session start. The channel server registers MCP **Tools** (e.g., `notify_peer` for Stage 3 / DR-023) which agents can invoke from prompts.

## mTLS (mutual TLS)

Two-way TLS authentication: client and server both present certs, both validate. MACF uses mTLS for inter-agent `/notify` calls — channel servers accept only requests from clients with certs signed by the project CA. Specs: [DR-004](../design/decisions/DR-004-authentication-mtls.md), [DR-010](../design/decisions/DR-010-cert-signing.md), [DR-011](../design/decisions/DR-011-ca-key-backup.md).

## Operator

The human running the agents. Provides one-time per-project setup (CA, GitHub Apps, routing workflow), provisions per-agent credentials, and intervenes when agents are blocked. Operators don't post-bootstrap-edit workspace state by default — agents own their own runtime.

## Pattern A–E (silent-fallback defenses)

Five defense patterns against the silent-fallback hazard class catalogued in `design/silent-fallback-catalog.md`:

- **A** — result-invariant assertion (verify the outcome, not just the surface signal)
- **B** — dual-source corroboration (cross-check two sources)
- **C** — fail-loud chain (every step in a pipeline either succeeds or aborts)
- **D** — structural prevention (Path-2-style hook that makes the failure mode impossible)
- **E** — observational-only delivery (deliver without forcing the recipient to wake)

Pattern A bears 3 of 8 instances; cross-cutting framework for all routing/tooling defenses.

## Path-1 / Path-2 / Path-3 promotion

The three substrate→canonical promotion paths for coordination discipline, formalized in `groundnuty/macf-science-agent:insights/2026-04-30-coordination-rules-vs-routing-infrastructure.md`:

- **Path 1** (rules-as-text) — Markdown rule file in `packages/macf/plugin/rules/`, distributed via `macf init`/`update`. For cognitive discipline (research-first, scope-discipline, ask-before-presuming).
- **Path 2** (infrastructure) — bash hook or Action job that makes violations structurally impossible. STRONGEST when applicable. For blockable discipline (gh-token attribution, mention-routing-hygiene, LGTM-routing).
- **Path 3** (assertion-script) — result-invariant script run at the boundary that detects violation post-hoc. For detection-only scenarios where structural prevention isn't feasible.

Decision rule: if the violation can be detected at the API boundary deterministically → Path 2; if the discipline requires LLM cognition → Path 1; if it's a class of failures (recurring across surfaces) → Path 3.

## Plugin

The `macf-agent` plugin distributed via [`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace). Contains: 4 skills (`/macf-status`, `/macf-peers`, `/macf-ping`, `/macf-issues`), 7 agent identity templates, SessionStart + Stop hooks (DR-023 UC-1 `notify_peer`), and the MCP server entry that spawns the channel server. Loaded by Claude Code via `claude --plugin-dir .macf/plugin/` per [DR-013](../design/decisions/DR-013-plugin-versioning.md).

## Registry

GitHub Variables-backed agent address book. Each agent's channel server self-registers `MACF_<PROJECT>_AGENT_<NAME>` with `{host, port, type, instance_id, started}`. Routing workflow reads the registry to resolve peer addresses. Scope: repo / org / profile per [DR-006](../design/decisions/DR-006-registry-scope.md).

## Routing-Action

The reusable GitHub Actions workflow at [`groundnuty/macf-actions:.github/workflows/agent-router.yml`](https://github.com/groundnuty/macf-actions). Consumer projects reference it via `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3` (or pinned tag). Five route-by-* jobs: `route-by-config` (label dispatch), `route-by-label` (label apply/remove), `route-by-mention` (@-mention parse), `route-by-ci-completion` (check-suite roll-up), `route-by-pr-review-state` (`pull_request_review.submitted` per macf-actions#39, v3.3.0+).

## Routing-active mention

A `@<handle>[bot]` reference NOT wrapped in backticks. Routing-active mentions fire GitHub's @-mention webhook → routing-Action → recipient TUI wake. Backticked mentions (`` `@bot[bot]` ``) are routing-suppressed (canonical describing form per `mention-routing-hygiene.md` §5). Distinction is load-bearing for hook Check A (must-have-mention) and Check B (must-not-leak).

## Skill

Claude Code's slash-command extension. The `macf-agent` plugin ships 4: `/macf-status` (workspace + cert state), `/macf-peers` (mTLS peer-health table), `/macf-ping` (round-trip test), `/macf-issues` (pending-work queue). Pre-approved in `.claude/settings.json` per `installPluginSkillPermissions` to avoid first-invocation prompts.

## Stage 0 / 1 / 2 / 3 routing

Successive routing-mechanism generations:

- **Stage 0** — direct prompts (no automation; operator pastes between sessions). Pre-MACF.
- **Stage 1** — single-issue label dispatch via Actions (no per-agent state). Pre-MACF.
- **Stage 2** — SSH + tmux delivery; routing-Action SSHes into the agent VM and `tmux send-keys`. Substrate currently runs Stage 2 permanently per operator directive.
- **Stage 3** — mTLS HTTPS POST `/notify` against per-agent channel servers. Consumer-fleet target. Implemented in macf-actions v3.x; consumer onboarding doc covers the bootstrap path.

Specs across [DR-003](../design/decisions/DR-003-communication-planes.md), [DR-017](../design/decisions/DR-017-ssh-elimination.md), [DR-020](../design/decisions/DR-020-notify-wake-mechanism.md).

## Substrate (substrate workbench)

The MACF-developing-MACF agents: `macf-code-agent` (in `groundnuty/macf`), `macf-science-agent` (in `groundnuty/macf-science-agent`), `macf-devops-agent` (in `groundnuty/macf-devops-toolkit`). Substrate workspaces never run `macf init` per operator directive 2026-04-27 — they predate the canonical bootstrap path and remain on Stage 2 routing permanently. Substrate produces canonical content but doesn't consume it back automatically (the canonicalization-distribution gap).

## Verification gate

Set of explicit checks marking a milestone as done. Used in consumer onboarding (`design/macf-consumer-onboarding.md`), release procedures, and rehearsal protocols. Always literal commands + expected outputs, not narrative claims.

## Cross-references

- `README.md` (root) — entry point with high-level architecture
- `design/macf-consumer-onboarding.md` — bootstrap reference for new consumer projects
- `design/decisions/` — 23 DRs
- `design/phases/` — 7 phase specs
- `packages/macf/plugin/rules/` — 13 canonical rules
- `groundnuty/macf-science-agent:insights/` — paper-grade observations on the discipline classes named above
- `groundnuty/macf-science-agent:papers/` — academic-peer baseline (ACMM and others)
