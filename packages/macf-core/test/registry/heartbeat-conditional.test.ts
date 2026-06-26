/**
 * Instance-id-guarded registry heartbeat — DR-031, groundnuty/macf#568.
 *
 * The live instance periodically re-stamps `last_heartbeat` on its OWN slot so a
 * reader can TTL-judge an aged-out entry dead — the backstop for the UNGRACEFUL
 * death (kill -9 / OOM / power loss) that never runs the graceful-deregister
 * (#586) shutdown handler.
 *
 * Coverage (both backends):
 *  - re-stamps last_heartbeat when instance_id matches   → { beat:true,  reason:'beat'     }
 *  - NO-OP when instance_id differs (THE guard, #424)    → { beat:false, reason:'not-ours' }
 *  - NO-OP when the slot is absent                       → { beat:false, reason:'absent'   }
 *  - error RESULT (never throws) on read/write failure   → { beat:false, reason:'error'    }
 *  - preserves all OTHER fields; only last_heartbeat advances
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs, chmodSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRegistry } from '../../src/registry/registry.js';
import { createLocalRegistry } from '../../src/registry/local-client.js';
import type { AgentInfo, GitHubVariablesClient } from '../../src/registry/types.js';

const IS_WIN = process.platform === 'win32';
const PROJECT = 'macf';
const NOW = '2026-06-26T12:00:00.000Z';

const AGENT_A: AgentInfo = {
  host: '100.86.5.117',
  port: 8847,
  type: 'permanent',
  instance_id: 'aaaaaa',
  started: '2026-06-05T10:00:00Z',
};

// A newer instance that took over the slot (groundnuty/macf#424). id 'bbbbbb' is
// NOT ours — heartbeat must leave it alone.
const AGENT_B: AgentInfo = {
  host: '100.86.5.117',
  port: 8848,
  type: 'permanent',
  instance_id: 'bbbbbb',
  started: '2026-06-05T10:00:01Z',
};

// --- GitHub backend ----------------------------------------------------------

function mockClient(): GitHubVariablesClient {
  return {
    writeVariable: vi.fn().mockResolvedValue(undefined),
    readVariable: vi.fn().mockResolvedValue(null),
    listVariables: vi.fn().mockResolvedValue([]),
    deleteVariable: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createRegistry().heartbeatConditional (GitHub backend)', () => {
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = mockClient();
  });

  it('re-stamps last_heartbeat when the instance_id matches (still ours)', async () => {
    vi.mocked(client.readVariable).mockResolvedValueOnce(JSON.stringify(AGENT_A));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.heartbeatConditional('code_agent', 'aaaaaa', NOW);

    expect(result).toEqual({ beat: true, reason: 'beat' });
    // The write preserves every other field and only advances last_heartbeat.
    expect(client.writeVariable).toHaveBeenCalledWith(
      'MACF_AGENT_CODE_AGENT',
      JSON.stringify({ ...AGENT_A, last_heartbeat: NOW }),
    );
  });

  it('advances an EXISTING last_heartbeat in place (idempotent re-stamp)', async () => {
    const prior = { ...AGENT_A, last_heartbeat: '2026-06-26T11:55:00.000Z' };
    vi.mocked(client.readVariable).mockResolvedValueOnce(JSON.stringify(prior));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.heartbeatConditional('code_agent', 'aaaaaa', NOW);

    expect(result).toEqual({ beat: true, reason: 'beat' });
    expect(client.writeVariable).toHaveBeenCalledWith(
      'MACF_AGENT_CODE_AGENT',
      JSON.stringify({ ...AGENT_A, last_heartbeat: NOW }),
    );
  });

  it('is a NO-OP when the instance_id differs (newer instance owns the slot) — THE guard', async () => {
    vi.mocked(client.readVariable).mockResolvedValueOnce(JSON.stringify(AGENT_B));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.heartbeatConditional('code_agent', 'aaaaaa', NOW);

    expect(result).toEqual({ beat: false, reason: 'not-ours' });
    expect(client.writeVariable).not.toHaveBeenCalled();
  });

  it('is a NO-OP when the slot is already absent', async () => {
    vi.mocked(client.readVariable).mockResolvedValueOnce(null);

    const registry = createRegistry(client, PROJECT);
    const result = await registry.heartbeatConditional('code_agent', 'aaaaaa', NOW);

    expect(result).toEqual({ beat: false, reason: 'absent' });
    expect(client.writeVariable).not.toHaveBeenCalled();
  });

  it('treats a corrupt/unparseable slot as absent (does not re-stamp what it can\'t verify)', async () => {
    vi.mocked(client.readVariable).mockResolvedValueOnce('}{ not json');

    const registry = createRegistry(client, PROJECT);
    const result = await registry.heartbeatConditional('code_agent', 'aaaaaa', NOW);

    expect(result).toEqual({ beat: false, reason: 'absent' });
    expect(client.writeVariable).not.toHaveBeenCalled();
  });

  it('returns an error RESULT (never throws) when the read fails', async () => {
    vi.mocked(client.readVariable).mockRejectedValueOnce(new Error('network 500'));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.heartbeatConditional('code_agent', 'aaaaaa', NOW);

    expect(result).toEqual({ beat: false, reason: 'error' });
  });

  it('returns an error RESULT (never throws) when the write fails after a match', async () => {
    vi.mocked(client.readVariable).mockResolvedValueOnce(JSON.stringify(AGENT_A));
    vi.mocked(client.writeVariable).mockRejectedValueOnce(new Error('write 500'));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.heartbeatConditional('code_agent', 'aaaaaa', NOW);

    expect(result).toEqual({ beat: false, reason: 'error' });
  });
});

// --- Local backend -----------------------------------------------------------

interface Sandbox {
  readonly dir: string;
  readonly filePath: string;
}

function makeSandbox(): Sandbox {
  const dir = path.join(tmpdir(), `macf-hb-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!IS_WIN) chmodSync(dir, 0o700);
  return { dir, filePath: path.join(dir, `${PROJECT}.json`) };
}

async function cleanup(sb: Sandbox): Promise<void> {
  if (!IS_WIN && existsSync(sb.dir)) chmodSync(sb.dir, 0o700);
  await fs.rm(sb.dir, { recursive: true, force: true });
}

function seed(sb: Sandbox, agents: Record<string, AgentInfo>): void {
  const contents = JSON.stringify({ schema_version: 1, project: PROJECT, agents }, null, 2);
  writeFileSync(sb.filePath, contents, { mode: 0o600 });
  if (!IS_WIN) chmodSync(sb.filePath, 0o600);
}

describe('createLocalRegistry().heartbeatConditional (local backend)', () => {
  it('re-stamps last_heartbeat when the instance_id matches (preserving other fields)', async () => {
    const sb = makeSandbox();
    try {
      seed(sb, { 'code-agent': AGENT_A });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.heartbeatConditional('code-agent', 'aaaaaa', NOW);

      expect(result).toEqual({ beat: true, reason: 'beat' });
      expect(await registry.get('code-agent')).toEqual({ ...AGENT_A, last_heartbeat: NOW });
    } finally {
      await cleanup(sb);
    }
  });

  it('is a NO-OP when the instance_id differs — leaves the newer instance\'s slot intact (THE guard)', async () => {
    const sb = makeSandbox();
    try {
      seed(sb, { 'code-agent': AGENT_B });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.heartbeatConditional('code-agent', 'aaaaaa', NOW);

      expect(result).toEqual({ beat: false, reason: 'not-ours' });
      // Untouched: no last_heartbeat written onto the newer instance's slot.
      expect(await registry.get('code-agent')).toEqual(AGENT_B);
    } finally {
      await cleanup(sb);
    }
  });

  it('is a NO-OP when the slot is absent', async () => {
    const sb = makeSandbox();
    try {
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.heartbeatConditional('code-agent', 'aaaaaa', NOW);

      expect(result).toEqual({ beat: false, reason: 'absent' });
    } finally {
      await cleanup(sb);
    }
  });

  it('re-stamps ours without disturbing other agents in the file', async () => {
    const sb = makeSandbox();
    try {
      seed(sb, { 'code-agent': AGENT_A, 'science-agent': AGENT_B });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.heartbeatConditional('code-agent', 'aaaaaa', NOW);

      expect(result).toEqual({ beat: true, reason: 'beat' });
      expect(await registry.get('code-agent')).toEqual({ ...AGENT_A, last_heartbeat: NOW });
      expect(await registry.get('science-agent')).toEqual(AGENT_B);
    } finally {
      await cleanup(sb);
    }
  });

  it('returns an error RESULT (never throws) on a malformed registry file', async () => {
    const sb = makeSandbox();
    try {
      writeFileSync(sb.filePath, '}{ not json', { mode: 0o600 });
      if (!IS_WIN) chmodSync(sb.filePath, 0o600);

      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.heartbeatConditional('code-agent', 'aaaaaa', NOW);

      expect(result).toEqual({ beat: false, reason: 'error' });
    } finally {
      await cleanup(sb);
    }
  });
});
