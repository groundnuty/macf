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
- **Server-side authorization** (intended scope): POST `/notify` for routing notifications. `/sign` and peer-only endpoints are NOT intended use cases. Current enforcement is defense-in-depth via protocol gates (see "Authorization surface" below), not CN-based authz at the transport layer — the routing-action principal is admitted at `/health`/`/notify`/`/sign` uniformly by the EKU check, but `/sign`'s challenge-response protocol requires a registered-agent slot that routing-action doesn't have. CN-based tightening is captured as a potential future DR revision if a need surfaces.
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

### State as shipped (2026-04-17)

- **Peer-agent certs**: emit `clientAuth` EKU. `generateAgentCert` and `signCSR` both apply `ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.2'])` — per #125 / #126.
- **Routing-client certs**: emit `clientAuth` EKU. Signed by `generateClientCert` — per #119.
- **Server-side auth** at `/health`, `/notify`, `/sign`: verifies `tlsSocket.authorized` (CA-chain) **and** `clientAuth` EKU via `peerCertHasClientAuthEKU` in `src/https.ts`. Non-EKU certs are rejected uniformly with a 403 pointing at `macf certs rotate`. Enforced per #121 / #129.

### Rollout as executed (2026-04-17)

Getting to the state above required a 3-step ordering to prevent a common failure mode (tightening server check before peers emit EKU → instant auth break across the whole fleet):

1. **Emit** (#125 / #126): `generateAgentCert` + `signCSR` add the `clientAuth` EKU on new peer certs. Does not break existing peers — their older certs simply don't have the extension yet, and the server isn't verifying it at this point.
2. **Rotate** (step 2, operator-driven): each peer agent runs `macf certs rotate` to pick up an EKU-carrying cert. Per-workspace, one-shot. Completed for CV peers (cv-architect, cv-project-archaeologist) on 2026-04-17.
3. **Tighten** (#121 / #129): server-side `/notify` handler adds EKU verification. Safe to tighten only AFTER all active peers carry the EKU.

Each step was independent and reversible. Future EKU-adjacent changes (e.g. requiring additional EKUs) should follow the same ordering.

### Authorization surface — defense-in-depth, not CN-based

Server-side EKU verification is uniform across `/health`, `/notify`, `/sign` — any CA-signed cert with `clientAuth` EKU is admitted at the transport layer. Per-endpoint access scoping is enforced by protocol gates above the transport layer, not by CN inspection:

- **`/sign`** requires the challenge-response protocol (per DR-010). The client must prove GitHub write access by writing to a registry variable keyed on their CN. The routing-action principal has no registered-agent slot in the registry, so the challenge can't be satisfied regardless of cert validity.
- **`/notify`** accepts any CA+EKU cert as a routing-target — the routing-action principal's intended use case.
- **`/health`** is read-only; admitting any CA+EKU cert matches its inspection-friendly intent.

If future principals need tighter CN-based scoping (e.g. "this principal class may POST `/notify` but not read `/health`"), that's a defense-in-depth improvement over the current state rather than a replacement for the protocol gates. File as a separate DR revision if the need arises.

## Revision History

- **2026-03-28 (v1)** — Initial decision: mTLS with per-project CA; peer agents as the single principal type.
- **2026-04-17 (v2)** — Principal-type taxonomy added (peer-agent + routing-client); EKU doctrine established and executed via 3-step rollout (#125 emit → step 2 rotate → #129 tighten, all landed same day). Surfaced by macf-actions#8 migration from SSH+tmux to mTLS HTTPS POST transport.
