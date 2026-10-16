# Stage 3 Operations Runbook

**Status:** Living document
**Initial draft:** 2026-05-01 (Refs [#274](https://github.com/groundnuty/macf/issues/274))
**Audience:** Operators of MACF Stage 3 consumer projects + agents debugging their own infrastructure

This runbook covers operational concerns for the Stage 3 surface (mTLS HTTPS POST routing via `macf-actions@v3+`; per-agent channel server spawned as MCP stdio child; per-agent registration variables in GitHub). It is organized by failure mode, not by component — each section follows the same shape:

- **Failure shape** — what the operator/agent observes
- **Detection** — how to confirm this failure mode (vs. a similar-looking one)
- **Diagnostic flow** — concrete commands and what each result means
- **Remediation** — fix steps + verification

A failure mode you encounter that doesn't fit any section here is a runbook gap — file an issue against `groundnuty/macf` so the next operator doesn't have to re-discover it.

## Table of contents

1. [Cert lifecycle](#1-cert-lifecycle)
2. [Port collisions](#2-port-collisions)
3. [Registration drift](#3-registration-drift)
4. [Debugging missed notifications](#4-debugging-missed-notifications)
5. [mTLS handshake failures](#5-mtls-handshake-failures)
6. [Channel-server crash recovery](#6-channel-server-crash-recovery)
7. [Routing-Action workflow debugging](#7-routing-action-workflow-debugging)

---

## 1. Cert lifecycle

> **Design refs:** [DR-004 (mTLS authentication)](decisions/DR-004-authentication-mtls.md), [DR-010 (cert signing via challenge-response)](decisions/DR-010-cert-signing.md), [DR-011 (CA key backup)](decisions/DR-011-ca-key-backup.md). Code: `packages/macf-core/src/certs/{ca,agent-cert}.ts`, `packages/macf/src/cli/commands/certs.ts`.

### Validity defaults (verified 2026-05-01)

| Cert type | Validity | Source |
|---|---|---|
| CA cert | **5 years** | `CA_CERT_VALIDITY_YEARS = 5` in `packages/macf-core/src/certs/crypto-provider.ts` |
| Peer agent cert (`generateAgentCert`) | **1 year** | `AGENT_CERT_VALIDITY_YEARS = 1` in same file |
| Agent cert via `macf certs rotate --validity-days N` | N days (default 365, warning >730) | `DEFAULT_VALIDITY_DAYS = 365`, `VALIDITY_WARN_DAYS = 730` in `packages/macf/src/cli/commands/certs.ts` |
| Routing-action client cert | 1 year (same as peer; `generateClientCert`) | Same module |

### Failure shape

- Outbound `/notify` POSTs return 403 with `clientAuth EKU missing` or expired-cert TLS errors.
- `gh pr view` on routing PRs shows the routing workflow logging `certificate has expired`.
- Channel server's own `/health` ping during startup collision check fails with `CERT_HAS_EXPIRED` or unknown-issuer.

### Detection

Inspect the agent's cert directly:

```bash
openssl x509 -in .macf/certs/agent.crt -noout -subject -issuer -dates -ext extendedKeyUsage
```

Expected:
- `subject= /CN=<agent-name>` (or literal `/CN=routing-action` for routing-client certs)
- `issuer=` matches the project CA's CN
- `notAfter=` is in the future
- `Extended Key Usage:` contains `TLS Web Client Authentication` (per DR-004 v2 EKU doctrine, enforced post-2026-04-17)

### Diagnostic flow

1. **Check expiry on the active cert:** the `notAfter` line. If past or within ~30 days, rotate.
2. **Check EKU presence:** workspaces predating the 2026-04-17 EKU rollout (#125 / #126 / #129) carry certs without `clientAuth` EKU. Server-side enforcement (#121) rejects these uniformly with 403 on `/notify` / `/health` / `/sign`. **Diagnostic signature:** all three endpoints 403 simultaneously after a server upgrade, while curl-without-cert returns the expected client-cert-required error.
3. **Check the CA cert** — same `openssl x509` invocation against `.macf/certs/ca.crt`. CA expiry is rare (5-year default) but catastrophic — every peer needs re-signing.

### Remediation

**Agent cert rotation (local — keeps existing CA):**

```bash
macf certs rotate
# or with explicit validity:
macf certs rotate --validity-days 365
```

This regenerates the agent cert + key against the existing CA in `.macf/certs/ca.{crt,key}`. No registry interaction; no peer involvement; the new cert immediately gets used on next channel-server restart (`pkill` the channel-server PID; Claude Code's MCP layer respawns).

**Agent cert when CA key isn't local** (operator joining an existing project from a fresh machine, or after `macf certs init` was run on a different host): the cert is signed by a peer via the `/sign` challenge-response flow per DR-010.

```bash
macf init  # bootstraps the workspace + invokes /sign on a registered peer
```

The flow: client generates CSR, POSTs to a peer's `/sign`, peer issues a challenge ID and instructs the client to write `MACF_CHALLENGE_<agent>` to the registry, peer reads the registry to verify GitHub-write access, peer signs and returns the cert. Failure at any step keeps the workspace half-bootstrapped — the operator re-runs `macf init` after fixing the underlying cause (registry permission, network, peer offline).

**CA key recovery (operator-driven, encrypted variable per DR-011):**

```bash
macf certs recover  # prompts for CA key passphrase
```

Pulls the encrypted CA key from the project registry variable (`{PROJECT}_CA_KEY`) and decrypts to `.macf/certs/ca.key`. Use this when joining an existing project from a new machine where the CA was originally created elsewhere.

**Worked example.** A channel-server startup logs `Error: certificate has expired` while pinging itself for collision detection. `openssl x509 -in .macf/certs/agent.crt -noout -dates` shows `notAfter=Apr 30 12:00:00 2026 GMT`. Operator runs `macf certs rotate`, then kills the channel-server process; Claude Code's MCP layer respawns it; collision check now passes; agent reaches `online` state.

### Known gaps

- **No automated cert-rotation alarm.** Currently no cron / Prometheus alert / Action that surfaces approaching expiry. **TODO:** add a `macf doctor` check that warns when `notAfter` is within 30 days; track as a follow-up.
- **CA rotation is a 5-year event with no rehearsed runbook.** All peers must re-sign certs against the new CA. **TODO:** document the choreography before the first 5-year boundary lands.

---

## 2. Port collisions

> **Design refs:** [DR-007 (dynamic port assignment)](decisions/DR-007-port-assignment.md), [DR-018 (startup collision detection)](decisions/DR-018-startup-collision-detection.md). Code: `packages/macf-channel-server/src/{https,collision}.ts`. Constants: `PORT_RANGE_START = 8800`, `PORT_RANGE_SIZE = 1000`, `MAX_PORT_ATTEMPTS = 10` in `packages/macf-channel-server/src/https.ts`.

### Failure shape

Channel server fails to start with one of:

- `PortExhaustedError: tried 10 random ports in [8800, 9800), all bound`
- `PortUnavailableError` on a specific port
- `CollisionError: Agent '<name>' is already running at <host>:<port>` — a different shape: the port is fine, but a registry entry for this agent name already exists AND that registered host:port responds to `/health`.

### Detection

```bash
# Active listeners on this VM (Linux)
ss -tlnp | awk '$4 ~ /:8[89][0-9]{2}$/ || $4 ~ /:9[0-7][0-9]{2}$/'

# Same on macOS
lsof -nP -iTCP -sTCP:LISTEN | awk '/:8[89][0-9]{2} |\:9[0-7][0-9]{2} /'
```

You'll see one of:

- **Several macf-channel-server PIDs on the same host** — multiple agents on this VM, each holding one port in the 8800-9799 range. Normal.
- **Non-macf processes binding ports in the macf range** — a different service has squatted the macf range (rare; macf range chosen to be uncommon).
- **Stale macf-channel-server PIDs** — left over from a crash that didn't run shutdown handlers. Two-binding-PIDs-for-the-same-agent is the classic shape.

### Diagnostic flow

1. **`PortExhaustedError`** — 10 random attempts in [8800, 9800) all hit `EADDRINUSE`. Run the `ss` / `lsof` snippet above. If <10 ports occupied, this is statistically near-impossible — you've hit a real bug or extreme bad luck; investigate via the channel server's startup logs (`packages/macf-channel-server/src/https.ts` startup logs + retry attempts).
2. **`PortUnavailableError` on a specific port** — almost always Tailscale `host`-binding semantics. The channel server binds to the Tailscale IP, not 0.0.0.0; a sibling process on the same VM bound to the same Tailscale IP + port collides. Same fix as `PortExhaustedError` below: identify the squatter.
3. **`CollisionError`** — port assignment succeeded; collision is at the registry layer. Either a previous instance of this agent name is genuinely alive (check `/macf-peers` or curl that `host:port/health`), or the registry entry is stale (see §3).

### Remediation

**Stale macf process holding the port:** identify and kill.

```bash
ss -tlnp | grep ':<port>'  # find PID
kill -TERM <pid>
# wait ~2s, then verify
ss -tlnp | grep ':<port>' || echo "released"
```

The shipped shutdown handler (`packages/macf-channel-server/src/shutdown.ts`) deregisters the agent from the registry on SIGTERM/SIGINT before stopping the HTTPS server. SIGKILL skips that cleanup → registry drift (see §3).

**Non-macf process holding a port:** identify the offending service and either move it off the 8800-9799 range or accept the rare collision (random retry will pick a different port within the range on next channel-server start).

**Worked example.** Operator launches `code-agent` on a VM where another macf agent (`science-agent`) is already running on port 8847. `code-agent`'s channel server tries `randomPort()` (CSPRNG over [8800, 9800)) and hits 8847 on the third attempt; that fails with `EADDRINUSE`; retry picks 9013 successfully. Routing variable `MACF_<PROJECT>_AGENT_CODE_AGENT` gets the JSON `{"host":"100.86.5.117","port":9013,...}`.

### Known gaps

- **Tailscale + IPv6 listener edge case.** If Tailscale ever exposes IPv6 addresses + the channel server binds via `tailscaleIp` parsed as the v6 form, port-collision semantics may differ. Not observed in practice; **TODO:** verify if Tailscale rolls out v6 in the operator fleet.

---

## 3. Registration drift

> **Design refs:** [DR-005 (per-agent variables)](decisions/DR-005-agent-registration.md), [DR-006 (registry scope)](decisions/DR-006-registry-scope.md), [DR-019 (App permissions)](decisions/DR-019-app-permissions.md). Code: `packages/macf-core/src/registry/`, `packages/macf-channel-server/src/{collision,shutdown}.ts`.

### Failure shape

- A peer is `online` per `/macf-peers` output, but every POST to its `host:port/health` times out or connection-refuses.
- Routing Action picks up an issue, looks up the recipient's registration variable, POSTs to the published `host:port`, gets connection refused, marks the issue with `agent-offline`.
- An agent's own startup `CollisionError` against a registration that points to a dead host (e.g., the operator moved VMs).
- `macf doctor` reports App permission gaps (`actions_variables` missing) — the agent can't write to its own registration variable, so the variable carries stale data even when the agent is alive.

### Detection

```bash
# What does the registry say about this agent?
gh variable list --org <org> --json name,value | jq '.[] | select(.name | test("^MACF_<PROJECT>_AGENT_"))'

# What does the agent say about itself?
curl --cert .macf/certs/agent.crt --key .macf/certs/agent.key \
     --cacert .macf/certs/ca.crt \
     -fsS "https://<host>:<port>/health" || echo "unreachable"
```

Drift signatures:

- Variable says `host:port` X, X is unreachable → registration is stale (process gone, never deregistered).
- Variable says `host:port` X, X is reachable but `/health` returns `agent_name` ≠ the variable's key → identity drift (a different agent took over this name).
- Variable absent, agent process running → agent never registered (App permission gap during startup, or registry write failed silently).

### Diagnostic flow

1. **Run `macf doctor`** in the agent's workspace. As of v0.2.9 it surfaces App permission gaps (DR-019 set: `metadata`, `contents`, `issues`, `pull_requests`, `actions_variables`, `workflows`, `actions`) and (post-#296/#305) `permissions.allow` Write/Edit absence in the merged `settings.json` + `settings.local.json` view. A missing `actions_variables: write` is the canonical cause of "agent runs but registration never appears."
2. **Race-condition check.** When two agents with the same name start within seconds (e.g., a stuck process + a fresh launch via SessionStart), the second one's `checkCollision` may see the first one's `/health` come up just as it's exiting. The `collision_check` log entries (`agent`, `host`, `port`, `instance_id`) clarify which variant fired:
   - `result: 'fresh'` → no prior variable; clean register.
   - `result: 'variable_exists'` followed by `result: 'takeover'` → prior instance is dead; this instance overwrites.
   - `result: 'variable_exists'` followed by `result: 'abort'` → prior instance is alive; this instance refuses to start.
3. **Shutdown-handler succession.** The shutdown handler in `packages/macf-channel-server/src/shutdown.ts` calls `registry.remove(agentName)` on SIGTERM/SIGINT. Crash signals (SIGKILL, OOM kill, kernel panic) skip this — a stale variable lingers until the next launch cleans it up via the takeover path.

### Remediation

**Stale variable from a crashed predecessor:** the next launch of the same agent self-heals via the takeover path (registry sees prior entry's `/health` failing → marks as takeover → overwrites). No operator action needed if you're about to relaunch anyway.

**Stale variable, no relaunch planned (agent retired):** delete it manually.

```bash
gh variable delete MACF_<PROJECT>_AGENT_<NAME> --org <org>
```

**Variable missing, agent running** (App permission gap surfacing):

```bash
macf doctor  # confirms which permission is missing
# then operator-side: re-grant on GitHub App settings + re-accept the install
```

After permission fix, kill and respawn the channel server (Claude Code's MCP layer respawns it); the next start path writes the variable.

**Identity drift (variable says agent X, channel server says agent Y):** `MACF_AGENT_NAME` env var or `.claude/settings.local.json` `env` block disagrees with what was registered. Check the 3-layer priority (env > settings.local.json > baked default) per macf v0.2.10 (#313). Realign and relaunch.

**Worked example.** Operator gracefully `kill -TERM`s `code-agent`'s channel server. Shutdown logs show `shutdown_deregister_failed` with a 403 — the GitHub App's installation token has expired during the long-running channel server's lifetime, and shutdown's `registry.remove()` has no token-refresh path. Variable lingers. Next launch detects the variable, pings the no-longer-running host:port, gets connection-refused, takes over → variable rewritten with current host:port + new `instance_id`. Self-healed.

### Known gaps

- **No periodic registry sweep.** Stale entries from never-relaunched agents persist until manually deleted. **TODO:** consider a `macf doctor` flag that surfaces variables whose `/health` doesn't respond — already on the roadmap as a "registry-reconciliation" tool but not implemented.

---

## 4. Debugging missed notifications

> **Design refs:** [DR-015 (HTTP endpoints)](decisions/DR-015-http-endpoints.md), [DR-020 (notify-wake mechanism)](decisions/DR-020-notify-wake-mechanism.md), [DR-023 (Stage-3 mcp_tool architecture)](decisions/DR-023-stage3-hook-mcp-tool-architecture.md). Code: `packages/macf-channel-server/src/{server,tmux-wake,notify-formatter}.ts`. Cross-link: [`silent-fallback-hazards.md` Instance 3](silent-fallback-catalog.md#known-instances), Instance 6 (cross-agent notification loop), Instance 7 (OTel cumulative-counter), Instance 8 (telemetry-endpoint silent-drop).

### Failure shape

- Routing Action shows `Routing succeeded — POST /notify HTTP 200` for the recipient.
- Recipient's `/macf-status` shows the notification as deposited in MCP channel state.
- Recipient agent's TUI never processes the notification as a fresh turn.

This is silent-fallback Instance 3 in observable form. The MCP push deposits the notification in channel state; the tmux-wake sidecar runs `tmux send-keys`; helper exits 0; recipient's Claude Code TUI is in Remote Control mode → keystrokes go to the SDK socket, not pane stdin → recipient sees nothing.

### Detection

**Stage 3 consumer fleet path** (HTTP POST `/notify`, MCP stdio push between channel-server and Claude Code):

```bash
# Channel server logs (if launched via claude.sh, captured to console)
journalctl --user -u <session> | grep -E '(notify_received|tmux_wake_(delivered|skipped|failed|unconfirmed))'
```

Look for the sequence on a single notification:

- `notify_received` (HTTP layer accepted)
- One of `tmux_wake_delivered` / `tmux_wake_skipped reason=...` / `tmux_wake_failed reason=...`
- For `tmux_wake_unconfirmed` (Pattern C heartbeat detector per DR-020 amendment) — `session_activity` didn't advance; Instance 3 silent-fallback signature.

**Tempo trace inspection** (when observability stack is online — see [`groundnuty/macf-devops-toolkit:CLAUDE.md`](https://github.com/groundnuty/macf-devops-toolkit/blob/main/CLAUDE.md) for canonical endpoint topology):

```bash
# Round-trip notification trace, sender-side span chains to receiver's notify_received
TEMPO=http://127.0.0.1:14318
curl -G "$TEMPO/api/search" \
  --data-urlencode 'q={resource."gen_ai.agent.name"="<recipient>"} | name="macf.server.notify_received"' \
  --data-urlencode 'limit=20'
```

The dotted-key quoting matters — `{resource.gen_ai.agent.name=...}` (unquoted) returns 0 results silently and looks like "no telemetry" when traces actually exist. See `silent-fallback-hazards.md` Instance 8 for the secondary failure mode + canonical query patterns.

For full observability stack setup + endpoint topology + version-pinned query syntax, refer to [`groundnuty/macf-devops-toolkit:docs/observability-bundle-setup.md`](https://github.com/groundnuty/macf-devops-toolkit/blob/main/docs/observability-bundle-setup.md). This runbook does not duplicate the canonical observability docs.

### Diagnostic flow

1. **Confirm POST reached the recipient** — receiver's `notify_received` log entry / Tempo span exists. If absent, the issue is upstream (routing-Action delivery, network, mTLS — see §5 + §7).
2. **Confirm MCP push happened** — receiver's `/macf-status` shows the notification in channel state. If POST landed but channel state is empty, that's an MCP layer bug — file an issue.
3. **Confirm wake reached input** — for Stage 3 substrate fleet (workspaces NOT running `macf init`), this falls back to tmux-mediated wake and is subject to Instance 3. For Stage 3 consumer fleet, MCP stdio push is in-process between channel-server and Claude Code — bypasses the tmux layer entirely.
4. **For substrate fleet:** check `tmux display -p -t <target> '#{session_activity}'` pre/post a known wake event. If timestamp didn't advance, Instance 3 is firing — recipient's TUI is in Remote Control mode and keystrokes are silently bypassed.
5. **Cross-agent notification loop (Instance 6).** Symptom: rapid alternating `tmux_wake_delivered` events between two agents, ~6s round-trip. Each agent's `Stop` hook fires `notify_peer`, peer's wake triggers a new turn, the new turn ends → Stop fires again. **Structurally retired in v0.2.4** (`peer_notification` skips tmux wake at receiver per DR-023 Pattern E). If observed on v0.2.4+, the receiver-side discriminator is broken — file an issue.

### Remediation

- **Substrate fleet Instance 3 firing:** disable Remote Control on the recipient's TUI (or accept that the substrate fleet is operationally exposed to this hazard — rule-discipline catches it at observation time per the canonical defense).
- **Consumer fleet:** the MCP-stdio path is in-process and Instance 3-immune. Missed notifications on consumer fleet are usually upstream (routing failure §7) or cert-related (§5).
- **Polling fallback:** SessionStart auto-pickup (DR-014) sweeps the registry for outstanding work on next session start. If a notification was structurally lost, polling closes the gap on the next session boundary.

### Known gaps

- **Pattern C heartbeat detector** (`tmux_wake_unconfirmed` log event) is **proposed** in DR-020's amendment but not yet shipped in `tmux-wake.ts`. **TODO:** verify implementation status; if absent, file an issue to add it for substrate fleet observability.
- **No alert on POST-success-with-no-wake-confirmed** — Tempo + Loki have the data but no Grafana panel calls out the silent-fallback signature. **TODO:** propose a panel for the devops-toolkit observability stack.

---

## 5. mTLS handshake failures

> **Design refs:** [DR-004 (mTLS authentication)](decisions/DR-004-authentication-mtls.md) — especially §"Extended Key Usage (EKU)", [DR-010 (cert signing)](decisions/DR-010-cert-signing.md). Code: `packages/macf-channel-server/src/https.ts` (server-side EKU + chain check), `packages/macf-core/src/certs/agent-cert.ts` (cert generation).

### Failure shape

- `curl` to a peer's `/health` returns one of:
  - `SSL_ERROR_BAD_CERT_ALERT` / `tlsv13 alert certificate required`
  - `unable to verify the first certificate` / `UNABLE_TO_GET_ISSUER_CERT`
  - `certificate has expired`
  - `Hostname/IP does not match certificate's altnames`
- Channel server's HTTPS handler responds 403 with body `{"error":"missing clientAuth EKU"}` or similar — peer cert chain is valid but the cert itself doesn't carry the `clientAuth` Extended Key Usage extension.

### Detection

Inspect the cert presented by the peer:

```bash
# Server cert (your peer's /health)
echo | openssl s_client -connect <host>:<port> -showcerts 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext extendedKeyUsage

# Your local cert (used as client when calling peers)
openssl x509 -in .macf/certs/agent.crt -noout -subject -issuer -dates -ext extendedKeyUsage
```

Verify both:

- `subject= /CN=<expected-name>` — for peer agents, the agent name; for routing-action, the literal `routing-action`.
- `Extended Key Usage:` — must contain `TLS Web Client Authentication` (OID `1.3.6.1.5.5.7.3.2`) per DR-004 v2.
- `notAfter:` — in the future.
- `issuer=` — matches the project CA's CN.

### Diagnostic flow

1. **Cert expired** → §1 remediation (`macf certs rotate`).
2. **EKU missing** → cert was generated before the 2026-04-17 EKU rollout. Same fix: `macf certs rotate` regenerates against the current cert-generation code (which emits EKU per #125 / #126).
3. **CN mismatch** → cert's CN doesn't match the agent name the channel server thinks it has. Either:
   - Agent identity drift (env var > settings.local.json > baked default disagrees with the cert) — fix identity, regenerate cert.
   - Multi-CN subject — `extractCN` rejects these (#98 / #89). Regenerate cleanly.
4. **Issuer mismatch** → presenting cert was signed by a different CA than the verifying server trusts. Common cause: operator joined the project from a fresh machine without `macf certs recover` — they're using a brand-new self-signed CA. Fix: `macf certs recover` to pull the project CA from the registry.
5. **Intermediate CA chain issue** — MACF doesn't use intermediate CAs (single project root CA per DR-004), so this should not appear. If it does, an operator has stitched in a non-standard chain — investigate.

### Remediation

Most paths route to `macf certs rotate` (local cert) or `macf certs recover` (recover CA from registry). For the EKU rollout-class failures, the canonical fix sequence is documented in DR-004 v2 §"Rollout as executed (2026-04-17)" — Emit → Rotate → Tighten. If a future EKU-adjacent change happens, follow that same ordering.

**Worked example.** `cv-architect` posts to `cv-project-archaeologist`'s `/health` and gets a 403 with `{"error":"clientAuth EKU not present"}`. Operator runs `openssl x509 -in .macf/certs/agent.crt -noout -ext extendedKeyUsage` on `cv-architect` — EKU section is empty. Confirms the cert predates #125 / #126. Operator runs `macf certs rotate`; new cert emits EKU; next POST succeeds.

### Known gaps

- **EKU-rollout follow-up principals.** New principal types added per DR-004 §"Extending the taxonomy" must explicitly state whether they emit `clientAuth` EKU. Worked example: an "experiment orchestrator" worker. **TODO:** ensure new-principal DR amendments include this checklist item.

---

## 6. Channel-server crash recovery

> **Design refs:** [DR-002 (channel per agent — MCP stdio)](decisions/DR-002-channel-per-agent.md), [DR-022 (channel-server-npm-npx)](decisions/DR-022-channel-server-npm-npx.md). Code: `packages/macf-channel-server/src/{shutdown,collision,server}.ts`.

### Failure shape

- The channel server process exits unexpectedly (segfault, OOM kill, panic, manual `kill -9`).
- Claude Code's MCP layer respawns it (since `npx -y @groundnuty/macf-channel-server` is the configured `mcpServers.macf-agent.command`).
- In-flight notifications during the crash window are dropped — neither MCP push nor tmux wake fires for whatever was inbound during the crash.
- Stale registration variable lingers if shutdown handlers didn't run (SIGKILL bypasses `registerShutdownHandler`).

### Detection

Check process state + restart history:

```bash
# Currently running
pgrep -af 'macf-channel-server'

# Recent restarts (Linux journald — exact filter depends on how Claude Code routes stderr)
journalctl --user --since '1 hour ago' | grep -E '(macf-channel-server.*started|shutdown_complete|EADDRINUSE)'
```

Stale-registration check per §3.

### Diagnostic flow

1. **Auto-restart status:** Claude Code's MCP layer respawns the configured `mcpServers.macf-agent` command on death. As of DR-022 + v0.2.0+ this is `npx -y @groundnuty/macf-channel-server` — first-launch cold-fetch can take 60s; subsequent restarts use the npm cache and come up in ≤10s (per DR-022 Amendment E SLA).
2. **State recovery:** the channel server is **stateless across restarts**. All authoritative state lives in the registry (host:port via `MACF_<PROJECT>_AGENT_<NAME>` per DR-005) and per-agent cert files (`.macf/certs/`). On restart:
   - `checkCollision` reads its own prior registration variable — if `/health` ping fails (the prior process is dead), takes over with a fresh `instance_id` and re-binds a (possibly different) random port from [8800, 9799).
   - HTTPS server starts; registers fresh; resumes accepting `/notify` / `/health` / `/sign`.
3. **In-flight notification loss:** notifications inbound during the crash window are **dropped at the TCP layer** — sender sees a connection refused or RST. The polling fallback (DR-014 SessionStart auto-pickup) is the recovery path: on next SessionStart, the registry sweep picks up outstanding GitHub-mediated work; `notify_peer`-style ephemeral events are not replayed.
4. **Port-shifts on restart** are normal — `randomPort()` picks a fresh port; the registration variable is rewritten with the new value before the server reports `register_complete`. Senders that cached `host:port` between two notifications see a stale value briefly; their next POST 502s and they re-read the registry on retry.

### Remediation

- **No operator action required for normal crash → respawn cycle.** Claude Code restarts the MCP child process; collision-check takes over the stale registration; routing resumes within ~10-60s.
- **Stale registration after SIGKILL** — covered in §3 remediation. The next clean launch self-heals via the takeover path.
- **Repeated crashes** — investigate via channel-server logs (stderr captured by Claude Code). Common causes:
  - OOM in long-running OTel exporter on a memory-constrained VM (rare; OTLP exporter is bounded).
  - Cert-rotation race during startup — `collision.ts` H3 guard (treat any read error as "peer unreachable") prevents the unhandled-rejection class but doesn't fix the underlying race source.
  - npm-fetch error during cold-cache `npx` — the channel server failed to install before exec; check `npm install` exit logs in Claude Code's MCP launch trace.

**Worked example.** `code-agent`'s VM hits OOM and the kernel kills the channel-server process with SIGKILL. Registration variable lingers. Claude Code's MCP layer respawns the channel server. New process starts; `checkCollision` reads the stale variable; pings `host:port/health` (fails — the prior process is gone); logs `result: 'takeover'`; re-binds a fresh port (8847 → 9013); registers `MACF_<PROJECT>_AGENT_CODE_AGENT` with new host:port + new `instance_id`. Total downtime: ~10-15s (warm npm cache).

### Known gaps

- **No process supervisor wrapping** — if the entire Claude Code process dies (not just the MCP child), nothing respawns the agent until the operator manually relaunches. This is by design (Claude Code is a TUI session, not a daemon) but worth flagging.
- **No metric for restart-frequency** — repeated crashes don't raise a Prometheus alert. **TODO:** consider exposing `macf_channel_server_restart_total` counter; track via the devops-toolkit observability stack.

---

## 7. Routing-Action workflow debugging

> **Design refs:** [DR-017 (SSH elimination)](decisions/DR-017-ssh-elimination.md), [DR-020 (notify-wake)](decisions/DR-020-notify-wake-mechanism.md). External: [`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions) (currently `v3.3.0`). Cross-link: [`silent-fallback-hazards.md` Instance 3](silent-fallback-catalog.md#known-instances) — the canonical hazard class for "exit 0 but recipient never sees it."

### Failure shape

- `gh run view <id>` for the agent-router workflow shows `conclusion: success` (exit 0).
- Recipient agent never sees the routed prompt — no fresh turn, no MCP channel-state entry, no log entry on the recipient side.
- The route was a real `@<agent>` mention in an issue or a label trigger that should have fanned out.

This is silent-fallback Instance 3's family — workflow-API success, semantic outcome wrong.

### Detection

```bash
# Refresh token (per coordination.md Token & Git Hygiene)
GH_TOKEN=$("$MACF_WORKSPACE_DIR/.claude/scripts/macf-gh-token.sh" \
  --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") && export GH_TOKEN

# Recent agent-router runs
gh run list --workflow agent-router.yml --repo <consumer-repo> --limit 10 \
  --json databaseId,conclusion,event,headBranch,createdAt

# Drill into a specific run
gh run view <id> --repo <consumer-repo> --log
```

What to look for in the run logs:

1. **`Resolved recipient: <agent-name>`** — did the workflow resolve the right agent from the issue's labels / mention?
2. **`Looking up registration variable: MACF_<PROJECT>_AGENT_<NAME>`** — did the variable lookup succeed?
3. **`POST https://<host>:<port>/notify ... HTTP 200`** — did the POST succeed at the HTTP layer?

If all three are present but the recipient never saw the wake → silent-fallback (substrate fleet Instance 3, OR consumer fleet ÷ MCP push but tmux wake suppressed).

### Diagnostic flow

1. **Workflow ran but didn't fire on the trigger event you expected** — check the workflow's `on:` filter. The shipped `agent-router.yml` keys on issue / PR / comment events with specific patterns. A comment without an `@<agent>` mention won't fire. (Path-2 enforcement of the must-have-mention rule is via `check-mention-routing.sh` PreToolUse hook per #244 + #272 — this would have blocked the comment author from posting an unrouted comment, but if a route is missing from a hand-crafted automation outside the hook, that's the source.)

2. **Workflow fired but didn't resolve a recipient** — the issue's labels and body weren't parseable by the routing logic. Check the workflow's `Resolved recipient` step output.

3. **Recipient resolved but registration variable missing** — see §3 (registration drift). Workflow logs `agent-offline label added to issue #N` in this case, which is the soft-handle shape.

4. **POST returned non-2xx** — could be:
   - 403: cert / EKU issue (§5).
   - 502 / connection refused: channel-server down (§6).
   - 400: wire-payload schema mismatch — check the routing-Action version vs the consumer's channel-server version (`macf-actions@v3+` ↔ macf v0.2.x).

5. **POST returned 200 but recipient never woke** — Instance 3 family. For substrate fleet the canonical defense is rule-discipline + Pattern C heartbeat detector (per §4); for consumer fleet, MCP stdio push in-process bypasses the tmux layer.

### Remediation

- **Re-route the lost message.** Add an explicit @-mention to the recipient on the issue thread; the next routing run picks it up.
- **Workflow version pin upgrade.** Substrate workspaces pin `macf-actions@v1.3.1` per operator directive 2026-04-27 (permanent Stage-2 routing). Consumer projects should be on `macf-actions@v3+` (`v3.3.0` latest as of 2026-05-01) for Stage 3 mTLS routing. Mixed-version fleets that mismatch wire-payload schemas surface as 400s.
- **Workflow secret missing/renamed (silent-fallback Instance 5)** — the routing workflow's precheck step aggregates missing secrets into a single `::error::` annotation with a runbook reference. The shipped workflow already contains this; if a custom workflow doesn't, file as a follow-up.
- **Auto-opened incident lifecycle.** When the workflow fails on `main` it auto-opens (or appends to an existing) `code-agent`/`blocked` issue per `.github/workflows/e2e.yml` (#149 / #163). On the next green push, the workflow's self-close-on-green step closes the open incident with a comment citing the green run's SHA + URL. Don't manually close auto-opened incidents from PR auto-close keywords — it 1-second-races the next failure check; see [`coordination.md` §Issue Lifecycle 5](../packages/macf/plugin/rules/coordination.md#issue-lifecycle).

**Worked example.** Operator @-mentions `code-agent` on a new issue. Agent-router run starts, succeeds. Recipient never replies. Operator runs the diagnostic flow above:
1. `Resolved recipient: code-agent` — correct.
2. `Looking up MACF_MACF_AGENT_CODE_AGENT` — present, `host=100.86.5.117 port=8847`.
3. `POST https://100.86.5.117:8847/notify HTTP 200` — succeeded.
4. Recipient's channel-server log shows `notify_received` followed by `tmux_wake_delivered`. `tmux display-message -p '#{session_activity}'` pre/post comparison shows timestamp didn't advance (Pattern C signature). Recipient's TUI is in Remote Control mode → Instance 3 firing. Operator quits RC mode on the recipient TUI; re-mentions on the issue; next route lands.

### Known gaps

- **silent-fallback-hazards.md Instance 3 is canonical-pending in substrate** — substrate workspaces don't run `macf init`, so they get the rule via `macf rules refresh`. Verify periodically that substrate copies match the canonical.
- **No central dashboard of routing failures.** Per-workflow-run inspection only. **TODO:** consider a Grafana panel summarizing routing successes vs `agent-offline`-label-added events; track via devops-toolkit.

---

## How to use this runbook

- **Encountering a failure mode listed here:** start from the Detection step, walk through Diagnostic flow, apply the matching Remediation. Don't skip Detection — the failure shapes overlap and the wrong remediation can mask the real cause.
- **Encountering a failure mode NOT listed here:** capture the failure shape + diagnostic steps + fix in a comment on a new issue against `groundnuty/macf` so the next operator doesn't re-discover it. The runbook is a living document; a clean comment thread is enough material to graft a new section.
- **Updating this runbook:** Sections are scoped per failure mode, not per component, on purpose. If a new failure crosses two sections, add a cross-link rather than duplicating content. DR cross-links should always point at decisions/DRs (single source of doctrinal truth), not back at this runbook (which is the operational distillation).
