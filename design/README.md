# MACF Design Documentation

## Decision Records

Each file documents a specific design decision with full rationale, options considered, and why we chose what we chose.

| # | Decision | File |
|---|---|---|
| DR-001 | [Plugin name and distribution](decisions/DR-001-plugin-name-and-distribution.md) |
| DR-002 | [Channel per agent (MCP constraint)](decisions/DR-002-channel-per-agent.md) |
| DR-003 | [Communication planes (GitHub vs channels)](decisions/DR-003-communication-planes.md) |
| DR-004 | [Authentication (mTLS)](decisions/DR-004-authentication-mtls.md) |
| DR-005 | [Agent registration (per-agent org variables)](decisions/DR-005-agent-registration.md) |
| DR-006 | [Registry scope (org/profile/repo)](decisions/DR-006-registry-scope.md) |
| DR-007 | [Port assignment (random + retry)](decisions/DR-007-port-assignment.md) |
| DR-008 | [Agent identity (role vs name)](decisions/DR-008-agent-identity.md) |
| DR-009 | [Worker pool identity](decisions/DR-009-worker-pool-identity.md) |
| DR-010 | [Cert signing (challenge-response)](decisions/DR-010-cert-signing.md) |
| DR-011 | [CA key backup (encrypted variable)](decisions/DR-011-ca-key-backup.md) |
| DR-012 | [Config location (.macf per project)](decisions/DR-012-config-location.md) |
| DR-013 | [Plugin versioning (--plugin-dir pinning)](decisions/DR-013-plugin-versioning.md) |
| DR-014 | [Polling strategy (startup only)](decisions/DR-014-polling-strategy.md) |
| DR-015 | [HTTP endpoints (/notify, /health, /sign)](decisions/DR-015-http-endpoints.md) |
| DR-016 | [CLI + plugin split](decisions/DR-016-cli-plugin-split.md) |
| DR-017 | [SSH elimination](decisions/DR-017-ssh-elimination.md) |
| DR-018 | [Startup collision detection](decisions/DR-018-startup-collision-detection.md) |

## Implementation Phases

Each phase is a self-contained PR with its own spec.

| Phase | Scope | File |
|---|---|---|
| P1 | [Channel Server](phases/P1-channel-server.md) |
| P2 | [Registration & Discovery](phases/P2-registration.md) |
| P3 | [Certificate Management](phases/P3-cert-management.md) |
| P4 | [CLI (macf)](phases/P4-cli.md) |
| P5 | [Plugin Packaging](phases/P5-plugin.md) |
| P6 | [Action Update](phases/P6-action-update.md) |
| P7 | [Agent Templates](phases/P7-agent-templates.md) |
