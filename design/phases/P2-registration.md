# P2: Registration and Discovery

**Goal:** Agents auto-register their host:port in GitHub variables and discover each other.

**Depends on:** P1 (channel server)
**Design decisions:** DR-005, DR-006, DR-007, DR-008, DR-018

---

## Deliverables

1. **Registry abstraction** — `OrgRegistry`, `ProfileRegistry`, `RepoRegistry` implementing a common interface
2. **Auto-registration on startup** — channel server writes `{PROJECT}_AGENT_{name}` variable after binding port
3. **Collision detection** — check if agent already running before overwriting (DR-018)
4. **Discovery** — list all `{PROJECT}_AGENT_*` variables to find peers
5. **Cleanup on shutdown** — delete own variable on graceful exit
6. **Startup issue check** — after registration, query `gh issue list` for pending issues labeled for this agent, push as `startup_check` notification

## Key Interfaces

```typescript
interface Registry {
  register(name: string, info: AgentInfo): Promise<void>;
  get(name: string): Promise<AgentInfo | null>;
  list(prefix: string): Promise<AgentInfo[]>;
  remove(name: string): Promise<void>;
  writeVariable(name: string, value: string): Promise<void>;
  readVariable(name: string): Promise<string | null>;
  deleteVariable(name: string): Promise<void>;
}
```

Three implementations: `OrgRegistry` (orgs API), `ProfileRegistry` (user/user repo API), `RepoRegistry` (repos API).

## Config

```json
// macf-agent.json
{
  "project": "macf",
  "agent_name": "code-agent",
  "agent_role": "code-agent",
  "agent_type": "permanent",
  "registry": {
    "type": "org",
    "org": "macf-experiment"
  }
}
```

## Variable Format

```
MACF_AGENT_code_agent = {
  "host": "100.86.5.117",
  "port": 8847,
  "type": "permanent",
  "instance_id": "a8f3c2",
  "started": "2026-03-28T18:00:00Z"
}
```

## Startup Sequence (extends P1)

1. [P1] Bind port, start HTTPS server
2. [P2] Check if agent already registered → ping `/health` → abort if alive
3. [P2] Generate GH_TOKEN (from APP_ID/INSTALL_ID/KEY_PATH)
4. [P2] Write agent variable to registry
5. [P2] Query pending issues → push `startup_check` notification if any
6. Log registration complete

## Tests

- Registry interface tests per implementation (mock GitHub API)
- Collision detection: mock health response vs timeout
- Startup issue check: mock `gh issue list` response
- Graceful shutdown: verify variable deleted
