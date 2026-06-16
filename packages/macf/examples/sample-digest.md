# Protocol-Health Digest — macf

- Repo: `groundnuty/macf`
- Generated at: 2026-06-16T12:00:00Z
- Stale threshold: 14 days
- Read-only auditor (DR-026 F4). Drift + candidate signals below are **surfaced, not acted on** — proposing/actuation is gated (DR-026 G1).

## Stale issues

### code-agent

- #439 — register CAS/If-Match TOCTOU (40d open)
- #418 — claude-sh telemetry export (32d open)

### science-agent

- #224 — NPM_TOKEN rotation runbook (51d open)

## PRs awaiting action

### Awaiting review

- #520 — feat: candidate evolution-signal surfacing

### Approved, unmerged

- #511 — feat: route-receipt reconciler window-aware truncation

### Changes requested

- #519 — reliability: coalesced-turn precision-floor gate

## Aggregated reflection signals

_Candidate rule-evolution signals harvested from F2 reflections — surfaced for operator awareness, not proposed (G1)._

### proposed_tier: canonical

- send≠receipt last-mile gap should be a canonical rule [key: `send-neq-receipt`] (×2 agents)

### proposed_tier: project

- worktree-or-die for parallel subagent work [key: `worktree-isolation`]

## Summary

- Open issues: 6 (stale: 3)
- Open PRs: 3 (awaiting review: 1, approved-unmerged: 1, changes-requested: 1)
- Reflection records: 4 across 2 ledger file(s) (skipped malformed lines: 1)
- Candidate signals: 2 | breaches: 1 | unresolved: 3
- Project-tier rules present: 0

> This is a read-only protocol-health report. No issues were created, commented on, closed, or merged. Proposing rule changes / actuation is a separate, ratification-gated step (DR-026 G1).
