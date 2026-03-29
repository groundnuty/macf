# DR-010: Certificate Signing via Challenge-Response

**Status:** Accepted
**Date:** 2026-03-28

## Context

A new agent on a new machine needs an mTLS certificate signed by the project CA. The CA key may be on a different machine. How does the new agent get its cert signed without manual steps?

## Decision

Challenge-response over the `/sign` endpoint. The new agent proves it has GitHub write access at the project's registry scope.

## Flow

```
1. New agent generates key + CSR locally
2. POST /sign to any peer with CA key (discovered via registry variables)
   Body: { csr: "...", agent_name: "new-agent", project: "macf" }

3. Signing agent responds with challenge:
   Response: { challenge_id: "abc123",
               instruction: "Write MACF_CHALLENGE_new_agent = 'abc123' to the registry" }

4. New agent writes the variable:
   gh api {registry}/actions/variables -X POST \
     -f name=MACF_CHALLENGE_new_agent -f value=abc123

5. New agent retries /sign:
   Body: { csr: "...", agent_name: "new-agent", challenge_done: true }

6. Signing agent verifies:
   - Reads MACF_CHALLENGE_new_agent from registry
   - Value matches → agent proved GitHub write access → trusted
   - Deletes challenge variable (one-time use)
   - Signs CSR with CA key → returns cert

7. New agent saves cert, fully operational
```

## Options Considered

| Option | Manual steps | Security basis | Problem |
|---|---|---|---|
| Copy CA key to each machine | scp command | Physical access | Multiple copies of secret |
| One-time invite token | Paste token between machines | Knowledge of token | Manual, token could leak |
| No auth (Tailscale-only) | None | Network membership | Tailscale dependency for auth |
| GitHub Action as signing service | None | GitHub secret access | Complex, needs Action setup |
| **Challenge-response** | **None (fully automatic)** | **GitHub write access** | **None significant** |

## Rationale

1. **Fully automatic**: `macf init` handles everything. No manual token passing.
2. **Security model**: "If you can write to our GitHub scope, you're allowed a cert." This IS our trust boundary — GitHub org/repo membership.
3. **No Tailscale dependency**: Auth is through GitHub, not network topology.
4. **Works at any scope**: Org variables, profile repo variables, or repo variables — same challenge mechanism, different API endpoint.
5. **Auditable**: The challenge variable creation shows in GitHub audit log.
