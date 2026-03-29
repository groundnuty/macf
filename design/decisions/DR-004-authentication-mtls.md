# DR-004: Authentication via mTLS

**Status:** Accepted
**Date:** 2026-03-28

## Context

Channel endpoints are accessible over the network (Tailscale). How do we authenticate who can POST to an agent's channel?

## Decision

Mutual TLS (mTLS) with a project-level Certificate Authority (CA).

## Options Considered

| Option | Security | Complexity | Per-agent identity | Tailscale dependency |
|---|---|---|---|---|
| Shared secret header | Medium | Low | No | No |
| Per-agent secret | Good | Low | Yes | No |
| **mTLS with CA** | **Best** | **Medium (~20 lines openssl)** | **Yes (CN in cert)** | **No** |
| Tailscale-only (no app auth) | Good | Zero | No | Yes |
| GitHub webhook HMAC | Good | Medium | No | No |

## Rationale

1. **Per-agent identity**: Each agent has a unique certificate with its name in the CN field. The signing agent can verify WHO is connecting.
2. **Tailscale-independent**: Tailscale provides network connectivity, mTLS provides authentication. Clean layer separation. If we ever switch VPNs, auth still works.
3. **~20 lines of openssl**: Not complex. CA creation + agent cert signing is a short shell script.
4. **Industry standard**: Same approach as Kubernetes service mesh (Istio), Consul, etc.

## CA Structure

```
CA cert (public) → distributed via GitHub variable
CA key (private) → stays on signing machine + encrypted backup in GitHub variable
Agent cert + key → generated per agent, stored in .macf/certs/
```

Agents trust each other because they all trust the same CA. No need to distribute individual agent certs — only the CA cert is shared.

## Cert Lifecycle

- CA cert: 5-year expiry
- Agent certs: 1-year expiry
- Agent cert rotation: local operation, no distribution
- CA rotation: 5-yearly event, all agents re-sign
