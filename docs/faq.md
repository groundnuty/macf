# FAQ

Common questions with concrete, citation-backed answers. Where a question doesn't have a clean answer yet, the question explicitly says "open work" rather than glossing.

## Cost: how much does running MACF cost?

**Token-wise:** the CPC predecessor (2-agent proof of concept) measured **~6.8M output tokens + ~10.26B cache-read tokens** (1,511:1 cache-read-to-output ratio — the empirical signature of multi-agent context-re-reading) over an 11-day production run (128 issues, 175 PRs merged). Cumulative tokens through the API: ~10.47B (output + uncached input + cache creation + cache reads). MACF inherits the same cost shape.

**Multi-agent overhead:** **1.18× total token cost vs single-agent** for the same work, measured on the CPC run. The overhead pays for cross-agent peer review + audit trail; it's not free, and it's not free-rolling either (see [use-cases.md](use-cases.md) for when the qualitative benefits justify the cost).

**Asymmetric-context savings:** **22.7% token savings** vs running everyone at symmetric max context. The MACF default (orchestrator at 1M tokens, workers at 200K) captures most of this saving for asymmetric-context workloads.

**Dollar-wise:** depends on your model + provider pricing. At 2026-04 Claude Sonnet API rates (input $3/MTok, output $15/MTok, cache creation $3.75/MTok, cache reads $0.30/MTok), CPC's 11-day run worked out to ~**$3-4K total billing** (~$300-400/day) — most of the spend (~78%) was cache reads at the $0.30/MTok rate, output was ~$100, uncached input was negligible. Max-plan flat-rate users pay the plan fee regardless of token volume (decouples token counts from cost). The CPC operator was on Max-plan flat-rate, so absolute dollar billing was the plan fee, not the API-rate computation above.

**Verify yourself:** look at `groundnuty/claude-plan-composer` for the predecessor empirical baseline. For an MACF deployment, monitor token spend via your model provider's dashboard + correlate with `gh run list` activity.

## VM-required? Or can I run this on my laptop?

**Currently: VM required.** Tailscale or equivalent for cross-host network reachability if multi-agent across hosts. tmux sessions need to persist across SSH disconnections, which isn't a default on most laptops (lid-close + sleep kills sessions).

**Open work — laptop-friendly path.** A single-laptop configuration (no VM, no Tailscale, agents launched + run within a single session) is theoretically possible but not currently supported. Key blockers:

- tmux survives between operator sessions only if the laptop never sleeps (impractical)
- channel server's mTLS cert depends on a stable hostname/IP; laptop network changes break this
- The operator-intervention flow (`tmux attach` from any device) presumes Tailscale-reachable persistence

The framework's design assumptions track production-grade deployment. Workarounds exist (e.g., always-on local server in your network); they require operator setup MACF doesn't streamline.

If laptop-friendly operation matters for your use case, file an issue on `groundnuty/macf` so it's on the roadmap with empirical motivation.

## Custom agent: can I add a new agent role?

**Yes, via three steps:**

1. **Create a GitHub App** for the new agent (per [quickstart.md § step 1](quickstart.md#step-1--create-the-agents-github-app-5-10-min)). Note the App ID + install ID + private key path.
2. **Run `macf init`** in the agent's workspace with `--role <new-role>` (and `--name <new-app-name>` if it doesn't match the role). This bootstraps the workspace, generates the cert, registers the agent in the project's variables.
3. **Update the project's `.github/agent-config.json`** to add the new agent's metadata (App slug, tmux session, port). Re-run `macf repo-init` if the routing-Action workflow needs label additions.

The `--role` parameter sets the agent's identity template (read by the agent at session start). Default identity templates ship in `groundnuty/macf-marketplace` under `plugin/agents/`: 3 permanent (`code-agent`, `science-agent`, `writing-agent`) + 4 experimental (`exp-architect`, `exp-reviewer`, `exp-implementer`, `exp-debugger`). For custom roles, fork the marketplace + add a new identity template; or use one of the `exp-*` templates as a starting point and customize per session via prompts.

Custom-role identity templates aren't yet a first-class CLI feature; ad-hoc customization happens through the agent's session prompts + per-workspace overrides in `.claude/`. If you have a recurring custom-role pattern, file an issue so the marketplace can include it.

## Production-safe: can I deploy MACF on a public/fork-PR repo?

**Depends on fork-PR exposure.**

The security model (per [DR-019](../design/decisions/DR-019-app-permissions.md), [DR-004](../design/decisions/DR-004-authentication-mtls.md), [DR-010](../design/decisions/DR-010-cert-signing.md)) protects against:

- **Bot identity spoofing** — every `gh` operation requires a `ghs_*` installation token; the `check-gh-token.sh` PreToolUse hook structurally enforces the prefix. Stored user `gh auth login` can't be used for bot operations.
- **Inter-agent message forging** — channel server `/notify` requires mTLS; only certs signed by the project CA are accepted.
- **Cert signing abuse** — `/sign` uses challenge-response per [DR-010](../design/decisions/DR-010-cert-signing.md); pre-fix ([macf#87](https://github.com/groundnuty/macf/issues/87)), the protocol was tautological + bypassable; post-fix it actually verifies.
- **Workflow-token abuse** — routing-Action runs in `pull_request_target` context only when triggered by repos in the agent registry; fork PRs from untrusted users don't fire routing.

**Open work — fork-PR review safety.** If you accept fork PRs from untrusted users, the agent reviewing the PR runs with elevated permissions (write access to your repo via the App's install). A malicious fork PR could attempt to extract secrets via prompt-injection or trick the agent into pushing arbitrary commits. The framework's Path-2 hooks (attribution-trap defense, mention-routing-hygiene) reduce the surface but don't eliminate it.

**Recommendation:** for public repos with fork-PR exposure, restrict MACF agent operations to maintainer-authored PRs (CODEOWNERS-gated review automation). Untrusted fork PRs should go through human review before any MACF agent acts on them.

The fuller security analysis lives in [`coordination.md` Token & Git Hygiene](../packages/macf/plugin/rules/coordination.md) and the DR-004/010/019/023 specs. If your threat model includes specific attack scenarios, file an issue so the security model can be updated.

## Why GitHub vs Slack/Linear/etc?

**Substrate-design choice; paper-grade reasoning, not marketing.**

GitHub provides four properties simultaneously that the alternatives don't:

| Property | GitHub | Slack | Linear | In-process queue |
|---|---|---|---|---|
| **Audit trail** | Per-issue thread; persistent; queryable via `gh api` | Channel-scoped; ephemeral retention defaults | Issue-scoped; persistent | Process-scoped; lost on restart |
| **Operator-readable** | Web UI + CLI + RSS + Projects | Slack UI; Slack-only | Linear UI; Linear-only | Custom UI required |
| **Identity primitives** | GitHub Apps (free, scoped, audit'd) | Slack Apps; per-workspace | Linear users; per-org | None native |
| **Free at scale** | Yes (public repos free; private repos free for small teams) | No (per-seat pricing past free tier) | No (per-seat) | Free but requires self-hosting |
| **Persistent across coordination tools** | Yes (issues + PRs + Projects unified) | Bridges exist but lossy | Native; one-tool | Custom integration cost |
| **Dogfoodable for code work** | Yes (the project's own code IS in GitHub) | No | Issue tracker, no code | No |

The combination matters: GitHub is the only option where the **same primitives that hold the team's code also hold the agents' coordination state**. Slack + Linear + GitHub-for-code is more flexible (each tool optimal for its scope) but produces a coordination story split across three places, with no single audit trail.

The trade-off: GitHub's webhook latency (2-5 sec/hop) is slower than direct IPC. If turn-around speed dominates your priority, MACF's substrate isn't optimal.

For the deeper rationale: [concepts.md § Why "agents talk through GitHub"](concepts.md#why-agents-talk-through-github-and-not-direct-ipc).

## ACMM comparison: how does MACF relate to academic peers?

**ACMM (Anderson, IBM Research, 2026-04-10, arXiv:2604.09388 — "The AI Codebase Maturity Model") operates on an orthogonal axis.** ACMM defines codebase maturity by *feedback-loop topology* — a 6-level framework (CMMI-inspired) where each level is unlocked by adding a specific feedback mechanism. MACF identifies a hazard class — *silent-fallback failures* where API-boundary success masks semantic failure — and develops 5 reusable structural-defense patterns (A through E) that span infrastructure layers.

The orthogonality means: ACMM's feedback-loop discipline is independent of MACF's hazard-class identification. A MACF deployment can sit at any ACMM level; an ACMM-level-6 codebase can have any silent-fallback profile. MACF's 8 documented hazard instances span ACMM Levels 1 through 6 — they are NOT maturity-stage-bounded. The two papers can co-exist with sharp differentiation: ACMM identifies the maturity-progression staircase; MACF identifies the safety-hazard surface that extends across all levels.

For canonical citation + status: `groundnuty/macf-science-agent:papers/index.md`. For the orthogonal-axis framing: `groundnuty/macf-science-agent:insights/2026-04-29-acmm-first-published-peer-establishes-orthogonal-axis.md`.

The broader academic peer landscape (planning systems, constraint solvers, multi-agent benchmarks) is largely orthogonal to MACF's substrate scope. MACF's contribution is on the engineering-discipline + observability axis: how do you operate N LLM-backed agents in production with auditability? Most academic work hasn't addressed that question explicitly because most academic work runs in dedicated experimental environments rather than production-engineering contexts.

For comparison to open-source alternatives (Aider, CrewAI, AutoGen, LangGraph): [use-cases.md § Comparison to open-source alternatives](use-cases.md#comparison-to-open-source-alternatives).

## How is MACF related to CPC (Claude Plan Composer)?

**CPC is the predecessor; MACF generalizes it.** CPC was a 2-agent proof of concept (orchestrator + implementer) that ran for 11 days in production on a scientific-workflow project: 128 issues, 175 PRs merged, 6.8M output tokens + 10.26B cache-read tokens (10.47B cumulative through the API), **1.18× multi-agent overhead** (cost vs single-agent for the same work), **22.7% token savings** vs running both agents at symmetric max context.

MACF generalizes CPC's architecture into:

- **N-agent** (not just 2)
- **Typed roles** (code-agent, science-agent, writing-agent, + experimental)
- **Cross-repo coordination** (CPC was single-repo)
- **Per-agent identity** (CPC shared an identity; MACF's per-agent GitHub Apps enable proper attribution + permission scoping)
- **Production security primitives** (mTLS between agents, attribution-trap structural defenses, schema-validated cross-agent payloads)

If CPC was the proof "this can work for an 11-day project," MACF is the engineering generalization "make this work as a framework other people can adopt."

Repo: [`groundnuty/claude-plan-composer`](https://github.com/groundnuty/claude-plan-composer). Empirical paper: in `groundnuty/macf-science-agent:papers/` (drafting; target venues ASE NIER / ESEM 2026).

## Do agents really catch each other's mistakes? Or is this just a marketing claim?

**Empirical examples in MACF's own development:**

- **[macf#80](https://github.com/groundnuty/macf/issues/80)** — code-agent audited its own challenge-response cert-signing implementation against the design doc; discovered the server wrote a challenge value and read back what it had just written, with no comparison to what the client submitted. The supposedly-secure protocol was trivially bypassable. Filed as P0; shipped the fix.
- **[macf#112](https://github.com/groundnuty/macf/issues/112)** — code-agent suggested a quick crypto-parameter workaround. Science-agent rejected it with an "eternal-debt" argument: the quick fix would leave existing deployments stuck on weaker config forever. Negotiated approach automatically migrates every deployment.
- **[macf#144](https://github.com/groundnuty/macf/issues/144)** — multi-round design refinement. Each round produced a measurably better outcome than the previous round.
- **[macf#121](https://github.com/groundnuty/macf/issues/121)** — agents started enforcing rules they wrote for themselves. Codified a rule, code-agent violated it on the next issue, science-agent pushed back citing the rule, code-agent acknowledged + complied.

These aren't curated success stories; they're sample bugs the agents caught on each other. Closed [issues](https://github.com/groundnuty/macf/issues?q=is%3Aissue+state%3Aclosed) + [PRs](https://github.com/groundnuty/macf/pulls?q=is%3Apr+state%3Aclosed) show the general texture.

Agents also miss things — the same way humans miss things in code review. The peer review provides a second perspective; it doesn't guarantee correctness. The 1.18× cost is the price for the second perspective.

## What if my agents disagree? Who decides?

**Human-in-the-loop on substantive disagreement.** Per [`coordination.md` § Peer Dynamic](../packages/macf/plugin/rules/coordination.md) + `peer-dynamic.md`: agents push back, ask for clarification on ambiguous work, defend choices with concrete reasoning. If after dialogue they still disagree, escalate to the operator (the human running the swarm).

Agents are peers, not subordinates. There's no "tiebreaker agent" that arbitrates. The escalation goes to the issue's reporter, who decides next steps (their own action, bringing in coordination by another peer, escalating to the operator).

The framework doesn't try to model agent voting / consensus / authority hierarchies. Trying to was an early design exploration that was abandoned — the GitHub-as-substrate model handles disagreement well via the existing primitives (issue threads make the disagreement visible; the operator can intervene at any point).

## Can I run MACF without OpenTelemetry?

**Yes.** OTel is opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT` env var. Unset → channel server runs without bootstrapping OTel, no traces, no metrics, no overhead.

If you opt in, you also need an OTel collector running somewhere reachable (Tempo for traces, Prometheus or Mimir for metrics). Common operator setup: deploy `groundnuty/macf-devops-toolkit` for the collector + Grafana stack, or BYO collector.

Spec: [DR-021](../design/decisions/DR-021-otel-instrumentation.md). Without observability, you lose the audit-grain advantage MACF makes a case for ([use-cases.md § Research-grade observability](use-cases.md)) — but the framework still works.

## What's MACF's release cadence? When should I update?

**8 npm releases over ~76 hours** during the 2026-04-27 → 04-30 sprint (v0.2.1 → v0.2.9). Cadence is event-driven, not calendar-driven: when substrate-evolution produces a canonical update worth distributing to consumers, a release ships.

**For consumers:** update when:

- A canonical rule change matters for your discipline class (check `CHANGELOG.md` for "Documentation" + "Added" entries)
- A doctor enhancement closes a false-positive trap you've been hitting
- A Path-2 hook adds protection against a class you're recurring on

**Don't update mechanically.** Each release's CHANGELOG entry explicitly says what's new; check whether you need it. Update via:

```bash
# Re-fetch plugin assets to current pinned version:
npx -y @groundnuty/macf@latest update --plugin --yes
# OR pin to a specific version:
macf update --plugin-version 0.2.9 --yes
```

For substrate workspaces (which don't run `macf init`/`update`), updates require manual `cp` from canonical to substrate `.claude/rules/` + `.claude/scripts/`. The canonicalization-distribution gap (see [concepts.md § Substrate vs consumer](concepts.md#substrate-vs-consumer-the-canonicalization-distribution-gap)) is operator-driven.

## What's research-grade about MACF? Is this just a software project?

**Research-grade in three specific senses:**

1. **Empirical evidence pre-claim.** Every framework claim has a citation: cv-e2e-test rehearsal #13b's 10/11 PASS witness, CPC's 1.18× overhead measurement, ~80 PRs in a development sprint, 8 release cycles in 76 hours, 8 silent-fallback hazard instances catalogued with Pattern A-E defenses. Verify any number yourself.
2. **Audit-grade observability.** OTel traces + counters per `/notify`, `/sign`, peer ping; GitHub issue threads as persistent coordination state; per-agent App attribution; reproducible npm tarballs + signed git tags. Post-hoc analysis of any coordination event is recoverable.
3. **Honest limitations.** Each component has documented failure modes ([troubleshooting.md](troubleshooting.md)), recurring discipline classes (Class A-H breach taxonomy in `groundnuty/macf-science-agent:research/2026-04-27-self-observed-canonical-rule-breach-pattern-analysis.md`), and explicit non-goals ([use-cases.md § Honest limitations](use-cases.md#honest-limitations-what-macf-does-not-solve)).

The framework also serves as a **research artifact**: 23 DRs, 7 phase specs, 13 canonical rules, 16 research notes, 8+ insights documents, ongoing paper drafting. Target venues: ASE NIER / ESEM 2026.

If "research-grade" matters for your context (academic deployment, reproducibility-mandated work, audit-required workflows), MACF's design is built for that. If you just need agents to do work fast, the research orientation may be more rigor than your use case warrants.

## Where do I file bugs / propose features?

[Open an issue](https://github.com/groundnuty/macf/issues/new) on `groundnuty/macf` for:

- **Bugs** — labeled `bug`. Include reproduction steps + expected vs actual behavior.
- **Feature requests** — labeled `enhancement`. Include the use case + expected interaction shape.
- **Discussion** — labeled `discussion` or `question`. Open-ended explorations welcome.

For the broader research-side concerns (paper drafting, methodology, hazard catalog updates), file on `groundnuty/macf-science-agent`.

For routing infrastructure changes: `groundnuty/macf-actions`. For plugin distribution: `groundnuty/macf-marketplace`.

The agents themselves operate via these issue queues; if you file with the right label (`code-agent`, `science-agent`, etc.), the routing-Action will deliver the issue to the relevant agent's queue. Be aware: agents have their own work queues + cadence; expect engagement on coordination-team timescales (hours to days), not bot-instant.

## Cross-references

- [glossary.md](glossary.md) — term definitions for any unfamiliar concepts
- [concepts.md](concepts.md) — architecture + design rationale
- [features.md](features.md) — concrete inventory of what's in v0.2.9
- [quickstart.md](quickstart.md) — hands-on tutorial
- [use-cases.md](use-cases.md) — when MACF is the right tool, when it isn't
- [troubleshooting.md](troubleshooting.md) — failure modes catalogued
- `groundnuty/macf-science-agent:insights/` — paper-grade observations
- `groundnuty/macf-science-agent:papers/index.md` — academic-peer baseline
