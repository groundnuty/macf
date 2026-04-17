# DR-004: Authentication via mTLS

**Status:** Accepted
**Date:** 2026-03-28
**Revised:** 2026-04-17 (principal types + EKU doctrine — followup from macf-actions#8 / macf#119 / macf#121)

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

## Principal Types (added 2026-04-17)

The original decision assumed one principal type: **peer agents**, each with a unique CN and a registered endpoint in the peer registry. As of macf-actions v2.0.0 (#8), the framework also authenticates a **non-peer** principal — the routing Action — which presents a CA-signed cert but is not a registered peer.

This section codifies the principal-type taxonomy so future principals have a doctrinal home.

### Peer-agent (original, 2026-03-28+)

- **CN**: the agent's name (e.g. `code-agent`, `science-agent`)
- **Registered in the peer registry?**: yes — `<PROJECT>_<AGENT>_ENDPOINT` variable gives `host:port`
- **Issued by**: local `macf certs init` during agent workspace bootstrap, OR signed via `/sign` endpoint on another peer (challenge-response per DR-010)
- **Server-side authorization**: full access — can POST `/notify`, initiate `/sign` challenges, etc.
- **Client-side authorization**: presents cert when calling another peer's `/sign` or (future) `/notify`

### Routing-client (added 2026-04-17 per macf-actions#8)

- **CN**: the distinguished literal `routing-action`
- **Registered in the peer registry?**: **no** — explicit collision guard in `macf certs issue-routing-client` (see #119) refuses to issue if an agent with that name exists
- **Issued by**: `macf certs issue-routing-client` CLI; operator pastes the resulting PEM into each consumer repo's GHA secrets (`ROUTING_CLIENT_CERT` / `ROUTING_CLIENT_KEY`)
- **Server-side authorization**: POST `/notify` only (delivers routing notifications into the agent's session). Should NOT be allowed to POST `/sign` or access any peer-only endpoint. Current implementation's `tlsSocket.authorized` check accepts any CA-signed cert — sufficient for the single-endpoint case today but becomes ambiguous if additional non-peer principals are added. See #121 for the hardening path.
- **Client-side authorization**: presents cert when calling agents' `/notify`; never calls `/sign` or peer-only endpoints

### Extending the taxonomy

New principal types (e.g. an "experiment orchestrator" worker in the planned controlled-experiment infrastructure, or an "audit-read-only" principal for compliance tooling) should land as their own case in this section with:

- Distinguished CN (and collision guard if applicable)
- Explicit issuer (which CLI or endpoint mints the cert)
- Server-side authorization scope (which endpoints it may call)
- Client-side authorization scope (which endpoints it WILL call)

The goal is that the set of allowed `(CN-pattern × endpoint)` pairs is enumerable and auditable from this section alone — no implicit "any CA-signed cert can call anything" assumptions.

## Extended Key Usage (EKU) (added 2026-04-17)

The `clientAuth` EKU (OID `1.3.6.1.5.5.7.3.2`) is the X.509 standard attestation that a cert is intended for TLS **client** authentication — not server, not code-signing, not any other use. A server that verifies the `clientAuth` EKU on presented certs rejects misuse (e.g. a server cert being presented for client auth).

### Current state (2026-04-17)

- **Peer-agent certs**: do **not** emit `clientAuth` EKU. Signed by `generateAgentCert` in `src/certs/agent-cert.ts`; the extension is absent.
- **Routing-client certs**: **do** emit `clientAuth` EKU. Signed by `generateClientCert` in the same module (new in #119).
- **Server-side `/notify` auth**: checks `tlsSocket.authorized` only (CA-chain verification) — does **not** inspect EKU.

### Target state (tracked in #121)

All CA-signed cert presentations to the server should carry `clientAuth` EKU, and the server should verify it. Transition is ordered:

1. **Emit**: `generateAgentCert` adds the `clientAuth` EKU on new peer certs. Does not break existing peers — they just don't have the extension yet.
2. **Rotate**: each peer agent runs `macf certs rotate` to pick up an EKU-carrying cert. Per-workspace, one-shot.
3. **Tighten**: server-side `/notify` handler adds EKU verification. Safe to tighten only AFTER all active peers carry the EKU.

Each step is independent and reversible. The 3-step ordering prevents a common failure mode (tightening server check before peers emit EKU → instant auth break across the whole fleet).

## Revision History

- **2026-03-28 (v1)** — Initial decision: mTLS with per-project CA; peer agents as the single principal type.
- **2026-04-17 (v2)** — Principal-type taxonomy added (peer-agent + routing-client); EKU doctrine established with 3-step rollout path (tracked in #121). Surfaced by macf-actions#8 migration from SSH+tmux to mTLS HTTPS POST transport.
