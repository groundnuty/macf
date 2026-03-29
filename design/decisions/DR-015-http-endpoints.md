# DR-015: HTTP Endpoints

**Status:** Accepted
**Date:** 2026-03-28

## Context

The channel server exposes HTTP endpoints for receiving work, health checks, and certificate signing. What should they be named?

## Decision

Three endpoints, all requiring mTLS:

| Endpoint | Method | Purpose |
|---|---|---|
| `/notify` | POST | Receive work notifications from Action or other agents |
| `/health` | GET | P2P health check, returns agent status |
| `/sign` | POST | Sign a CSR for a new agent (challenge-response auth) |

## Industry Validation

Researched endpoint naming conventions across Kubernetes, Slack, Discord, AWS, Google, Spring Boot, Consul, and other infrastructure systems.

### `/notify`

Tier 1 convention for service-to-service event push. Short, imperative, unambiguous. Used in internal service APIs. Alternative `/webhook` is for external systems (CI, SaaS) — `/notify` is more natural for peer agents.

### `/health`

The single most dominant health check endpoint name in the industry. Used by Docker, Kubernetes, Spring Boot, Express.js, AWS ALB, Consul, and virtually every microservice tutorial.

Returns rich response (status, current issue, uptime) — similar to Spring Boot Actuator's `/health` which also returns detailed dependency states. If we later need minimal liveness separate from status, we can split into `/health` + `/status`.

### `/sign`

Not an industry standard name (cert signing is usually a dedicated service like Vault or CFSSL). But for our self-contained system, `/sign` is clear: "sign this CSR."

## Response Formats

```
GET /health → 200
{
  "agent": "code-agent",
  "status": "online",
  "type": "permanent",
  "uptime": 3600,
  "current_issue": 42
}

POST /notify → 200 "ok"
Body: { "type": "issue_routed", "issue_number": 42, "title": "..." }

POST /sign → 200
Body (request): { "csr": "...", "agent_name": "new-agent", "project": "macf" }
Body (challenge): { "challenge_id": "abc123", "instruction": "..." }
Body (cert): { "cert": "-----BEGIN CERTIFICATE-----..." }
```
