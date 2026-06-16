# `project-rules/` — MACF's own project-tier rules

This directory holds the **project-tier** coordination rules for the MACF
deployment itself (DR-026 §3, tier 2). It is the source that
`MACF_PROJECT_RULES_SOURCE="groundnuty/macf//project-rules"` points at.

## What belongs here

Per-deployment rules that **add to / specialize** the universal rules in
`packages/macf/plugin/rules/*.md` (which ship in the npm product and reach every
deployment). A rule belongs here — not in the universal set — when it is
specific to *this* deployment's repos, tooling, or topology and would be wrong
for a fresh deployment (e.g. a genomics project) to receive.

Examples of MACF-deployment-specific knowledge that lives at this tier:

- the `make -f dev.mk check` Stop-hook gate before a PR
- the substrate's hand-wired hook workstream conventions
- repo-specific routing / label conventions for `groundnuty/macf`

## Distribution

- **Consumer deployments** pull their own project rules from their own
  `MACF_PROJECT_RULES_SOURCE` via `macf update` / `macf rules refresh` into
  `.claude/rules/project/*.md`.
- **The MACF substrate** (science / code / devops) is hand-wired and does NOT
  run `macf init` / `macf update`, so these rules reach the substrate the
  hand-wired way (like the structural hooks) — not via auto-pull.

## Format + precedence

Each rule is a `*.md` file (a `.example` is a template, not a live rule). Rules
may specialize but must **never contradict or weaken** the universal protocol's
protected invariants. See `design/project-tier-rules.md` for the full model.
