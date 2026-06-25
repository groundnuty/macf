# MACF Use-Case Recipes

Concrete, **followable** recipes for standing up a fleet of MACF agents for a
specific kind of work — the *how-to*, distinct from
[`docs/use-cases.md`](../docs/use-cases.md) (the *when-to / should-I* analysis).

Each recipe is a worked example end-to-end: real agent roles, real repos, the
exact commands, and the rough edges to expect. They build on the generic
[`design/macf-consumer-onboarding.md`](../design/macf-consumer-onboarding.md)
bootstrap doc and pair it with operator-side Claude Code role configuration
(the [`groundnuty/agentic-repo-template`](https://github.com/groundnuty/agentic-repo-template)
profiles).

## Recipes

| Recipe | Fleet | Good for |
|---|---|---|
| [Scientific-paper research fleet](scientific-paper-fleet.md) | science (coordinator) + code (labor) + writer (paper) | Running a research study and writing it up as a paper |

> **These are living docs.** Each recipe was written to be *tried*. If a step is
> wrong, unclear, or papercut-y when you follow it, that's a bug in the
> onboarding process — file it (label `code-agent` for CLI/mechanics,
> `science-agent` for topology/design) and we harden the recipe + the tooling
> behind it. The `macf#530` `--app-key` ingestion fix came from exactly this
> loop.
