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

---

## Path 2: research-niche labeling (2026-05-18, #371)

Per operator directive (2026-05-18) following science-agent review, the `/sign`
endpoint is kept as a **MACF research-niche extension** rather than promoted
to an A2A spec primitive. Live cryptographic agent attestation (the
challenge-response flow above) is a MACF-specific design choice that the A2A
spec does not currently model; rather than try to bend the A2A spec or
advertise a non-standard endpoint to external A2A clients, we **namespace the
path under `/macf/` and exclude it from A2A AgentCard advertisement**.

### Path-2 implementation

- **Route renamed:** `/sign` → `/macf/sign` (HTTPS POST, same handler, same
  DR-010 challenge-response semantics — the only change is the URL prefix).
- **Legacy-path shim:** `/sign` returns `HTTP 308 Permanent Redirect` with
  `Location: /macf/sign`. 308 (not 301/302) preserves the POST method per
  RFC 7538 — critical because `/sign` is POST-only with a JSON body. Every
  legacy hit logs `sign_redirect_legacy` so we can observe redirect traffic
  decay to zero as callers migrate.
- **AgentCard exclusion:** `/macf/sign` is intentionally NOT advertised in the
  A2A AgentCard returned by `/.well-known/agent-card.json` (Phase 1 scope, see
  groundnuty/macf#370). External A2A clients SHOULD NOT depend on this
  endpoint. The `https.ts` route registration carries an inline comment
  reminding future A2A-surface work to honor this exclusion.

### Removal trigger (12-month zero-call rule)

A new OTel counter `macf.sign_calls_total` is incremented on every
`/macf/sign` hit (canonical path only — legacy `/sign` redirects log
`sign_redirect_legacy` but do NOT increment this counter; the 308 steers
the caller to the canonical path, which then records here). The trigger:

> **If `macf.sign_calls_total` shows 0 calls for 12 consecutive months
> from this PR's merge date, file a follow-up issue to remove the
> endpoint entirely** (including the route handler, the redirect shim,
> and most of the surrounding DR-010 challenge-response machinery —
> retaining only the historical record of why we chose this trust model).

The counter's empirical basis: at the time of the namespace rename, the
caller audit showed **0 true HTTP callers** in the OSS codebase outside
of test fixtures (see issue body / audit-summary on #371). The 12-month
window allows for any latent operator-driven usage to surface; a
12-month-zero observation gives high confidence that the endpoint is
genuinely unused before removal.

### Path 1 deferred-work reference

After A2A implementation + testing is complete (Phase 4 done, per the
A2A integration sequence tracked in #369 / #370), file an A2A spec
discussion proposing live cryptographic attestation as an **optional A2A
feature** — per operator directive 2026-05-18. If the spec extension is
accepted upstream, the MACF-only path can be retired in favor of the
standardized A2A primitive (which would also unblock the removal
trigger above ahead of the 12-month window).

### References

- groundnuty/macf#371 — namespace + Path-2 implementation
- groundnuty/macf#370 — A2A Phase 1 (AgentCard endpoint; excludes /macf/sign)
- groundnuty/macf#368 — A2A integration master tracking

## Amendment (2026-07-05, #800) — CA rotation's out-of-band blast radius

**A CA re-init/rotation re-issues the *in-workspace* agent certs, but has an invisible blast radius on CA-signed artifacts that live *out-of-band* — and must enumerate + flag them, or routing breaks silently.** Concretely (root cause of #799): the macf-actions router presents a **routing-client cert** (`ROUTING_CLIENT_CERT`/`ROUTING_CLIENT_KEY` GitHub Actions secrets, per caller repo) in its mTLS `route-by-label` POST. When a fleet's CA is rotated, `macf certs` re-signs the agent certs but **cannot reach the routing-client secret** (agents can't write GitHub secrets — DR-019), so it silently retains a cert signed by the *old* CA → every agent rejects the router's POST → guest-tasking/routing breaks, **undetected until an operator hits it** (~5 days on #799).

This is a **silent-fallback hazard** (`silent-fallback-hazards.md` **Instance 16**): the rotation succeeds at its op boundary (exit 0, agent certs re-issued) while a sibling out-of-band artifact is silently orphaned; detection requires a **result-invariant assertion** (Pattern A), not the rotation's exit code.

**Principle (generalizes beyond the routing-client cert):** *a credential rotation MUST enumerate its full blast radius — including out-of-band copies it cannot directly update — and propagate to them or LOUDLY flag them.*

**Mechanism (#800; code-agent builds — this DR is the lifecycle rule):**
- **Prevent — rotation-time WARN.** `macf certs init`/`rotate` ends with a loud blast-radius warning enumerating the orphaned out-of-band artifacts + the exact re-mint / re-set operator commands. Warn, never auto-write (DR-019). **The blast radius is (at least) TWO out-of-band CA-copy classes, both keyed on the DR-030/DR-038 install-set:**
  1. the **routing-client cert** secret (`ROUTING_CLIENT_CERT`/`_KEY`) on each caller repo — re-mint via `macf certs issue-routing-client` + `gh secret set`;
  2. the **`<PROJECT>_CA_CERT` repo variable** on each agent repo (macf#806) — the v3 router reads the CA it trusts from `vars[<PROJECT>_CA_CERT]` on the caller repo, so a rotation orphans every per-repo copy; re-set via `gh variable set <PROJECT>_CA_CERT --repo … < ca-cert.pem`.
  **The `<PROJECT>_CA_CERT` repo-var class is retired structurally by macf-actions#66** (router reads the CA from the *registry*, the single source) — which both closes #806 and **shrinks this blast radius by one whole copy class**. Until #66 lands, the rotation-WARN + the doctor check below MUST enumerate the repo-var class too. (General lesson: every scheme that copies the CA out-of-band adds a rotation-blast-radius member; prefer registry-read over per-repo copies.)
- **Detect (static, primary) — issuer-match without reading the secret.** At `issue-routing-client` mint time, record the routing-client cert's **issuer-fingerprint + mint-epoch** in a registry variable (`<PROJECT>_ROUTING_CLIENT_CERT_ISSUER`, DR-006 scope — the CA material already lives there). `macf routing doctor` diffs that recorded issuer against the **current CA fingerprint** → mismatch = orphaned. This is required because a GitHub secret is **write-only** — the doctor cannot read the deployed cert, so it keys on the registry-recorded issuer, not the secret value.
- **Detect (live, stronger) — result-invariant.** `routing doctor --live` / the rotation e2e (#798) asserts a `route-by-label` mTLS POST actually succeeds after a CA rotation (cause-agnostic; the truest Pattern-A guard).
- **Remediate.** `macf certs issue-routing-client` re-mints + emits the per-repo `gh secret set` operator commands (DR-019: agent produces the artifact + command; operator executes).

**References:** #799 (the outage) · #800 (this mechanism) · `silent-fallback-hazards.md` Instance 16 · DR-019 (agents can't write secrets) · DR-030/DR-038 (install-set = the caller-repo enumeration) · #798 (rotation e2e).
