# DR-019: MACF GitHub App Permissions

**Status:** Accepted
**Date:** 2026-04-16

## Context

Every MACF agent runs as a GitHub App with an installation token (`ghs_*`).
The App's permission set defines what the agent can do — and getting it wrong
triggers the silent-fallback attribution trap (see #61): a missing permission
returns 401, `gh` falls through to the stored user login, and subsequent ops
get mis-attributed to the operator instead of the bot.

We've re-discovered permission gaps three times during implementation:

- `variables: write` (PR #46) — needed for the agent registry
- `workflows: write` — needed to push `.github/workflows/` changes (macf-actions setup)
- `actions: read` (#72) — needed by coordinator agents to debug team workflow runs
  via `gh run list` / `gh run view --log-failed`

Rather than re-discover on the next App, we codify the minimum set here.

## Decision

The minimum permission set for a MACF agent's GitHub App:

| Permission          | Level  | Why                                                             |
|---------------------|--------|------------------------------------------------------------------|
| `metadata`          | read   | Mandatory by GitHub — cannot be omitted                         |
| `contents`          | write  | Push commits, PRs to feature branches                           |
| `issues`            | write  | Comment, label, edit issues — the primary coordination surface  |
| `pull_requests`     | write  | Create/merge PRs, submit reviews                                |
| `variables`         | write  | Agent registry lives in repo/org/user variables (DR-005/DR-006) |
| `workflows`         | write  | `macf repo-init` writes `.github/workflows/agent-router.yml`    |
| `actions`           | read   | `gh run list` / `gh run view --log-failed` for self-debug       |

Every MACF App should have all seven. Coordinator/review agents (science-agent,
writing-agent) especially need `actions: read` to debug their team's CI — a
coordinator that can't read workflow logs can't do its job.

## Creating a new App (manifest flow)

GitHub Apps can be created from a manifest. Use the template at
`templates/macf-app-manifest.json` (shipped with this PR) as the baseline — it
encodes the permission table above and the event subscriptions MACF needs.

For a one-off App created via the web UI, set every permission in the table
above at its listed level before installing.

## Verifying an existing App

A future `macf doctor` command (#73) will compare an App's installation-token
permissions against this table and fail loud if anything is missing. Until
that lands, a manual check:

    GH_TOKEN=$(./scripts/macf-gh-token.sh --app-id $APP_ID ...) gh api /rate_limit
    # and
    GH_TOKEN=$GH_TOKEN gh api /installation/repositories

401 on either → the App is missing `metadata` (mandatory) or `contents` — fix
before shipping.

## Options Considered

| Option                                    | Trade-off                                              |
|-------------------------------------------|---------------------------------------------------------|
| Minimum set (just `contents: write`)      | Under-permissioned — re-discovery on every new feature |
| **Conservative (seven above)**            | **Covers current + near-future needs, one update here** |
| Maximum (every repo-scoped permission)    | Over-broad; violates least-privilege                   |

## Rationale

- Silent failures from missing permissions are expensive to debug (see #72)
- The seven-permission set covers every MACF feature built so far (P1–P7)
- `actions: read` is the only non-write permission, included specifically for
  coordinator self-debug — minor surface area, high debuggability payoff
- Keeping this as a DR (not just inline in each phase doc) means App creators
  have a single canonical reference
