# P1: Channel Server

> **For agentic workers:** Use superpowers:executing-plans to implement this spec.

**Goal:** A working MCP channel server that receives HTTP POSTs via mTLS and pushes notifications into a running Claude Code session.

**Depends on:** Nothing (foundation phase)
**Blocked by this:** P2, P3, P4, P5, P6

**Design decisions referenced:** DR-002, DR-003, DR-004, DR-015, DR-017

---

## What This Phase Delivers

A single TypeScript package that:
1. Connects to Claude Code via MCP stdio (channel capability)
2. Listens on HTTPS with mTLS
3. Exposes `POST /notify` — pushes work notifications to Claude Code
4. Exposes `GET /health` — returns agent status
5. Logs to a file with optional debug mode

This phase does NOT include: registration (P2), cert generation (P3), CLI (P4), plugin packaging (P5), or Action integration (P6).

For testing, certs are manually created and the port is passed as an env var.

---

## File Structure

```
macf-marketplace/
  macf-agent/
    src/
      server.ts           ← entry point (~30 lines)
      mcp.ts              ← MCP channel setup + pushNotification() (~40 lines)
      https.ts            ← HTTPS/mTLS server + route handling (~70 lines)
      health.ts           ← health state tracking (~30 lines)
      logger.ts           ← structured JSON logging (~30 lines)
      types.ts            ← shared types (~20 lines)
    test/
      mcp.test.ts
      https.test.ts
      health.test.ts
      logger.test.ts
    package.json
    tsconfig.json
```

---

## Module Specifications

### server.ts — Entry Point

Reads config from environment variables, wires modules together, starts the server.

**Environment variables consumed:**

| Variable | Source | Required | Example |
|---|---|---|---|
| `MACF_AGENT_NAME` | settings.local.json env or CLAUDE_PLUGIN_OPTION | Yes | `code-agent` |
| `MACF_PORT` | Env or default 0 (random) | No | `8847` |
| `MACF_HOST` | Env or default `0.0.0.0` | No | `100.86.5.117` |
| `MACF_CA_CERT` | Path to CA cert | Yes | `certs/ca-cert.pem` |
| `MACF_AGENT_CERT` | Path to agent cert | Yes | `certs/agent-cert.pem` |
| `MACF_AGENT_KEY` | Path to agent key | Yes | `certs/agent-key.pem` |
| `MACF_DEBUG` | Enable debug logging | No | `true` |
| `MACF_LOG_PATH` | Log file path | No | `.macf/logs/channel.log` |

**Startup sequence:**
1. Read env vars
2. Create MCP channel (mcp.ts)
3. Connect MCP to Claude Code via stdio
4. Create HTTPS server with mTLS (https.ts)
5. Start listening
6. Log startup info (port, host, agent name)

### mcp.ts — MCP Channel

Creates the MCP Server with `claude/channel` capability and provides the `pushNotification()` function.

**Exports:**

```typescript
interface McpChannel {
  connect(): Promise<void>;
  pushNotification(content: string, meta: Record<string, string>): Promise<void>;
}

function createMcpChannel(config: {
  agentName: string;
  instructions: string;
}): McpChannel;
```

**Channel instructions** (injected into Claude's system prompt):

```
Events arrive as <channel source="macf-agent" type="..." ...>.

type="issue_routed": A GitHub issue was routed to you by the agent-router Action.
  Read the issue and work on it following your agent identity rules.

type="mention": You were @mentioned in an issue comment or PR review.
  Read the context and respond.

type="startup_check": Pending issues found at session startup.
  Review and pick up the most important one.
```

**What Claude sees** when a notification arrives:

```xml
<channel source="macf-agent" type="issue_routed" issue_number="42">
Issue #42 was routed to you: Add health check endpoint
</channel>
```

### https.ts — HTTPS/mTLS Server

Creates an HTTPS server that requires client certificates signed by the project CA.

**Exports:**

```typescript
interface HttpsServer {
  start(port: number, host: string): Promise<{ actualPort: number }>;
  stop(): Promise<void>;
}

function createHttpsServer(config: {
  caCertPath: string;
  agentCertPath: string;
  agentKeyPath: string;
  onNotify: (payload: NotifyPayload) => Promise<void>;
  onHealth: () => HealthResponse;
}): HttpsServer;
```

**Routes:**

#### POST /notify

Receives work notifications. Calls `mcpChannel.pushNotification()`.

Request:
```json
{
  "type": "issue_routed",
  "issue_number": 42,
  "title": "Add health check endpoint",
  "source": "agent-router"
}
```

Response: `200 OK` with body `{"status":"received"}`

Errors:
- `401` — invalid or missing client cert
- `400` — malformed JSON body
- `500` — internal error pushing to MCP

#### GET /health

Returns agent status. No request body.

Response:
```json
{
  "agent": "code-agent",
  "status": "online",
  "type": "permanent",
  "uptime_seconds": 3600,
  "current_issue": null,
  "version": "0.1.0"
}
```

**mTLS configuration:**

```typescript
const server = createServer({
  key: readFileSync(agentKeyPath),
  cert: readFileSync(agentCertPath),
  ca: readFileSync(caCertPath),
  requestCert: true,
  rejectUnauthorized: true,
});
```

**Port selection with retry:**

```typescript
for (let attempt = 0; attempt < 10; attempt++) {
  const port = requestedPort || (8800 + Math.floor(Math.random() * 1000));
  try {
    await new Promise((resolve, reject) => {
      server.listen(port, host, resolve);
      server.on('error', reject);
    });
    return { actualPort: port };
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    // retry with different port
  }
}
throw new Error('Failed to find available port after 10 attempts');
```

### health.ts — Health State

Tracks agent status for the `/health` endpoint.

**Exports:**

```typescript
interface HealthState {
  getHealth(): HealthResponse;
  setCurrentIssue(issueNumber: number | null): void;
  recordNotification(): void;
}

function createHealthState(agentName: string, agentType: string): HealthState;

interface HealthResponse {
  agent: string;
  status: 'online';
  type: string;
  uptime_seconds: number;
  current_issue: number | null;
  version: string;
  last_notification: string | null;
}
```

The `current_issue` field is updated when a notification of type `issue_routed` arrives. Set to `null` when no issue is being worked on. (In P2, registration will also write this to the org variable for richer discovery.)

### logger.ts — Structured Logging

JSON-structured logs to file with optional stdout echo in debug mode.

**Exports:**

```typescript
interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

function createLogger(config: { logPath?: string; debug?: boolean }): Logger;
```

**Log format:**

```json
{"ts":"2026-03-28T18:00:00Z","level":"info","event":"server_started","port":8847,"host":"100.86.5.117"}
{"ts":"2026-03-28T18:01:00Z","level":"info","event":"notify_received","type":"issue_routed","issue":42}
{"ts":"2026-03-28T18:01:00Z","level":"info","event":"mcp_pushed","type":"issue_routed","issue":42}
{"ts":"2026-03-28T18:05:00Z","level":"info","event":"health_pinged","from_cn":"science-agent"}
```

### types.ts — Shared Types

```typescript
export interface NotifyPayload {
  type: 'issue_routed' | 'mention' | 'startup_check';
  issue_number?: number;
  title?: string;
  source?: string;
  message?: string;
}

export interface AgentConfig {
  agentName: string;
  agentType: string;
  host: string;
  port: number;
  caCertPath: string;
  agentCertPath: string;
  agentKeyPath: string;
  debug: boolean;
  logPath: string;
}
```

---

## Testing

### Unit Tests

Each module is tested independently with mocked dependencies.

**mcp.test.ts:**
- Test: pushNotification sends correct MCP notification format
- Test: channel instructions are set correctly
- Mock: StdioServerTransport

**https.test.ts:**
- Test: POST /notify returns 200 and calls onNotify
- Test: POST /notify with invalid JSON returns 400
- Test: GET /health returns correct format
- Test: connection without client cert returns 401
- Test: port retry on EADDRINUSE
- Mock: TLS certs (self-signed test CA)

**health.test.ts:**
- Test: initial state is online with null current_issue
- Test: setCurrentIssue updates the response
- Test: uptime_seconds increases over time
- Test: recordNotification updates last_notification

**logger.test.ts:**
- Test: info/warn/error write JSON lines to file
- Test: debug mode echoes to stdout
- Test: log file is created if missing

### Integration Test

One test that starts the full server with test certs and verifies:
1. Health endpoint responds
2. Notify endpoint accepts POST and triggers MCP notification
3. Invalid cert is rejected

---

## Manual Testing

Before P2 (registration), test manually:

```bash
# 1. Generate test certs
openssl genrsa -out ca-key.pem 2048
openssl req -x509 -new -key ca-key.pem -out ca-cert.pem -days 30 -subj "/CN=test-ca"
openssl genrsa -out agent-key.pem 2048
openssl req -new -key agent-key.pem -out agent.csr -subj "/CN=code-agent"
openssl x509 -req -in agent.csr -CA ca-cert.pem -CAkey ca-key.pem -out agent-cert.pem -days 30

# 2. Start the server
MACF_AGENT_NAME=code-agent \
MACF_HOST=127.0.0.1 \
MACF_PORT=8847 \
MACF_CA_CERT=ca-cert.pem \
MACF_AGENT_CERT=agent-cert.pem \
MACF_AGENT_KEY=agent-key.pem \
MACF_DEBUG=true \
node dist/server.js

# 3. Test health (from another terminal)
curl --cert agent-cert.pem --key agent-key.pem --cacert ca-cert.pem \
  https://127.0.0.1:8847/health

# 4. Test notify
curl --cert agent-cert.pem --key agent-key.pem --cacert ca-cert.pem \
  -X POST https://127.0.0.1:8847/notify \
  -H "Content-Type: application/json" \
  -d '{"type":"issue_routed","issue_number":42,"title":"test"}'
```

---

## Integration with Claude Code (P5 prerequisite)

In P5, this server will be registered as an MCP server in the plugin manifest:

```json
{
  "mcpServers": {
    "macf-agent": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"]
    }
  }
}
```

For P1 testing without the plugin, add to `.mcp.json` manually:

```json
{
  "mcpServers": {
    "macf-agent": {
      "command": "node",
      "args": ["/path/to/macf-marketplace/macf-agent/dist/server.js"]
    }
  }
}
```

And launch Claude Code with:

```bash
claude --dangerously-load-development-channels server:macf-agent
```

---

## Success Criteria

- [ ] Channel server starts and connects to Claude Code via MCP stdio
- [ ] `POST /notify` delivers a `<channel>` event that Claude sees and can act on
- [ ] `GET /health` returns correct JSON with agent name and uptime
- [ ] Connection without valid mTLS cert is rejected (401)
- [ ] Port retry works on EADDRINUSE
- [ ] Structured logs written to file
- [ ] All unit tests pass
- [ ] Integration test passes with test certs
- [ ] Manual test with `curl` + Claude Code works

---

## Out of Scope (Later Phases)

- Agent registration in GitHub variables (P2)
- `/sign` endpoint for cert signing (P3)
- `macf init` CLI (P4)
- Plugin manifest and skills (P5)
- GitHub Action update (P6)
- Agent identity templates (P7)
