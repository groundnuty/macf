# MACF documentation

First-user docs for the Multi-Agent Coordination Framework. Tone: research-grade, citation-backed, honest about limitations. No marketing language; concrete claims grounded in canonical artifacts (DRs, phase specs, insights, paper-trail).

## What's in here

Eight docs covering the first-user journey, organized by [Diátaxis](https://diataxis.fr) (Procida) — distinguishing tutorials, how-to guides, reference, and explanation by user need:

| Doc | Type | Read when |
|---|---|---|
| [quickstart.md](quickstart.md) | **Tutorial** (learning) | You want to bootstrap your first agent now (~30 min hands-on). Includes a separate **local-registry-mode quickstart** (no-GitHub-Apps single-host bootstrap per [DR-024](../design/decisions/DR-024-local-registry-mode.md)) for solo / education / demo / framework-dev / air-gapped / CI-fixture cases |
| [concepts.md](concepts.md) | **Explanation** (understanding) | You want to understand WHY MACF is shaped the way it is, with DR citations |
| [configuration.md](configuration.md) | **Reference** (information) | You want to customize the per-concern env-file layout (`.claude/.macf/env.*`) introduced in macf#342 / v0.2.18 — macf-managed vs operator-managed boundary, operator workflows, rollback |
| [features.md](features.md) | **Reference** (information) | You need to look up what's in v0.2.35 — CLI subcommands, hooks, routing jobs, channel-server endpoints |
| [use-cases.md](use-cases.md) | **Explanation** (understanding) | You want to decide whether MACF is the right tool — when to use, when not to, comparison to academic + open-source peers. Includes **"When MACF without GitHub makes sense"** subsection covering local-registry mode trade-offs |
| [troubleshooting.md](troubleshooting.md) | **How-to** (problem-solving) | Something broke; you need the canonical fix for a known failure mode |
| [faq.md](faq.md) | **How-to + Explanation** | You have a question that doesn't fit the other docs (cost, security, customization, comparisons) |
| [glossary.md](glossary.md) | **Reference** (term lookup) | A term in another doc is unfamiliar; jump here for the definition + canonical-artifact pointer |

## Suggested reading order

### If you want to evaluate MACF (read first)

1. **[concepts.md](concepts.md)** — what MACF is + how it works + why the design is shaped this way
2. **[use-cases.md](use-cases.md)** — when to use, when not to, comparison to alternatives
3. **[faq.md](faq.md)** — common questions answered honestly

That's ~30-45 minutes of reading. By the end you'll know whether MACF fits your use case.

### If you want to deploy MACF (read second)

4. **[quickstart.md](quickstart.md)** — hands-on bootstrap (~30 minutes)
5. **[features.md](features.md)** — concrete reference for what's available
6. **[configuration.md](configuration.md)** — per-concern env-file layout for the bootstrapped workspace (read after `macf init`)
7. **[troubleshooting.md](troubleshooting.md)** — bookmark this; you'll need it when something breaks

### If you want to operate MACF (read as needed)

8. **[glossary.md](glossary.md)** — term lookup; cross-references to canonical artifacts
9. **[`design/macf-consumer-onboarding.md`](../design/macf-consumer-onboarding.md)** — full consumer-bootstrap reference (deeper than quickstart)
10. **[`packages/macf/plugin/rules/coordination.md`](../packages/macf/plugin/rules/coordination.md)** — operational discipline for cross-agent work
11. **[`design/decisions/`](../design/decisions/)** — 23 DRs grounding architectural choices

## What this directory does NOT cover

- **Detailed API docs** for `@groundnuty/macf-channel-server`, `@groundnuty/macf-core`, etc. — see TypeScript types + JSDoc in `packages/*/src/`
- **Per-DR rationale** at the depth needed for design contributions — see `design/decisions/DR-001-*.md` through `DR-023-*.md`
- **Per-phase implementation details** — see `design/phases/P1-*.md` through `P7-*.md`
- **Research methodology + literature reviews** — see `research/` (16 notes) and `groundnuty/macf-science-agent:research/`
- **Paper draft + academic-peer baselines** — see `groundnuty/macf-science-agent:papers/`
- **CHANGELOG** — see `CHANGELOG.md` at repo root

This `docs/` directory is the first-user surface. Deeper material lives one level down (`design/`, `research/`, `papers/` in the science-agent repo).

## Empirical anchors cited throughout

Numbers you can verify yourself; cited across the 7 docs to ground claims in evidence:

| Claim | Source |
|---|---|
| 1.18× multi-agent overhead | CPC 11-day production run; `groundnuty/claude-plan-composer` |
| 22.7% asymmetric-context savings | Same |
| 128 issues / 175 PRs / 6.8M output + 10.26B cache reads (1,511:1 ratio) | Same |
| ~80 PRs in 2026-04-15→04-30 sprint | MACF dogfooding; `gh pr list --state merged` on `groundnuty/macf` |
| 8 npm releases in ~76 hours (v0.2.1 → v0.2.9) | `npm view @groundnuty/macf versions` + `gh release list` |
| 10/11 PASS rehearsal #13b (21 notify_received events; 11 wake_delivered + 10 wake_skipped) | `groundnuty/macf-science-agent:insights/2026-04-30-rehearsal-13b-empirical-witnesses.md` |
| 23 DRs / 7 phase specs / 13 canonical rules / 16 research notes | `ls design/decisions/`, `ls design/phases/`, `ls packages/macf/plugin/rules/`, `ls research/` |
| 8 silent-fallback hazard instances + Pattern A-E defenses | `packages/macf/plugin/rules/silent-fallback-hazards.md` |

## Cross-references

- [Root README](../README.md) — high-level architecture + setup
- [`design/decisions/`](../design/decisions/) — 23 DRs
- [`design/phases/`](../design/phases/) — 7 phase specs (P1-P7)
- [`design/macf-consumer-onboarding.md`](../design/macf-consumer-onboarding.md) — bootstrap reference for new consumer projects
- [`packages/macf/plugin/rules/`](../packages/macf/plugin/rules/) — 13 canonical rules
- [`CHANGELOG.md`](../CHANGELOG.md) — per-release notes
- `groundnuty/macf-actions` — reusable routing-Action workflow
- `groundnuty/macf-marketplace` — plugin distribution
- `groundnuty/macf-science-agent` — paper-grade research observations + academic-peer baseline
