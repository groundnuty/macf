# DR-006: Registry Scope (Org / Profile / Repo)

**Status:** Accepted
**Date:** 2026-03-28

## Context

Where do agent registration variables live? GitHub has no user-level variables. Agents may span personal repos and org repos.

## Decision

Three registry modes. One project = one registry scope.

| Mode | Config | Variables at | Use when |
|---|---|---|---|
| **Org** | `{"type":"org","org":"papers-org"}` | Org variables | Team/org projects |
| **Profile** | `{"type":"profile","user":"groundnuty"}` | `groundnuty/groundnuty` repo variables | Personal account projects |
| **Repo** | `{"type":"repo","owner":"x","repo":"y"}` | Specific repo variables | Fallback/edge cases |

## Key Finding: Profile Repos as User-Level Scope

GitHub's special `user/user` repository (e.g., `groundnuty/groundnuty`) accepts repo-level variables via API. These variables are hidden (not visible on the profile page, only via authenticated API). This effectively provides user-level scope for personal accounts.

Validated empirically: write, read, delete all work on `groundnuty/groundnuty` repo variables.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Org only | Simple | Personal accounts excluded |
| Repo only | Works everywhere | Cross-repo agents can't discover each other |
| User-level (GitHub doesn't have) | Ideal | Doesn't exist |
| Gist as store | User-scoped | Hacky, no variables API |
| **Profile repo** | **Closest to user-level, hidden from public** | **Slightly non-obvious** |
| Dedicated registry repo | Clean | Yet another repo |

## Multi-Project on Same Scope

Multiple projects share a scope via project prefix:

```
papers-org org variables:
  CPC_AGENT_code_agent     ← CPC project
  CPC_AGENT_science_agent  ← CPC project
  MACF_AGENT_code_agent    ← MACF project
  MACF_AGENT_writing_agent ← MACF project
```

Each repo declares its project and scope in `.github/macf-config.json`:

```json
{
  "project": "CPC",
  "registry": { "type": "org", "org": "papers-org" }
}
```

All agents in one project use the same scope, even if they work on repos in different orgs/accounts.
