/**
 * Instance-id-guarded deregister — DR-031, groundnuty/macf#553 ROOT-CAUSE fix.
 *
 * The graceful-shutdown handler calls `deregisterConditional` so the registry
 * stays accurate-by-construction: the slot is deleted ONLY when it is still
 * ours (its `instance_id` matches the one we registered). The load-bearing
 * guard (inverse-of-#553): if a NEWER instance took over the slot
 * (groundnuty/macf#424) while we ran, the slot now carries a different
 * instance_id → we must NOT delete it on our exit (that would strand a live
 * newer peer — the exact inverse of the #553 stale/missing-entry bug).
 *
 * Coverage (both backends):
 *  - deletes when instance_id matches            → { deregistered:true,  reason:'deleted'  }
 *  - NO-OP when instance_id differs (THE guard)  → { deregistered:false, reason:'not-ours' }
 *  - NO-OP when the slot is absent               → { deregistered:false, reason:'absent'   }
 *  - error RESULT (never throws) on read/delete failure → reason:'error'
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

const AGENT_A: AgentInfo = {
  host: '100.86.5.117',
  port: 8847,
  type: 'permanent',
  instance_id: 'aaaaaa',
  started: '2026-06-05T10:00:00Z',
};

// A different instance occupying the slot — a newer instance that took over
// (groundnuty/macf#424). Its instance_id ('bbbbbb') is NOT ours.
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

describe('createRegistry().deregisterConditional (GitHub backend)', () => {
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = mockClient();
  });

  it('deletes the slot when the instance_id matches (still ours)', async () => {
    vi.mocked(client.readVariable).mockResolvedValueOnce(JSON.stringify(AGENT_A));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.deregisterConditional('code_agent', 'aaaaaa');

    expect(result).toEqual({ deregistered: true, reason: 'deleted' });
    expect(client.deleteVariable).toHaveBeenCalledWith('MACF_AGENT_CODE_AGENT');
  });

  it('is a NO-OP when the instance_id differs (newer instance owns the slot) — THE guard', async () => {
    // A newer instance (groundnuty/macf#424) took over: the slot carries B's id,
    // not ours. We must NOT delete it.
    vi.mocked(client.readVariable).mockResolvedValueOnce(JSON.stringify(AGENT_B));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.deregisterConditional('code_agent', 'aaaaaa');

    expect(result).toEqual({ deregistered: false, reason: 'not-ours' });
    expect(client.deleteVariable).not.toHaveBeenCalled();
  });

  it('is a NO-OP when the slot is already absent', async () => {
    vi.mocked(client.readVariable).mockResolvedValueOnce(null);

    const registry = createRegistry(client, PROJECT);
    const result = await registry.deregisterConditional('code_agent', 'aaaaaa');

    expect(result).toEqual({ deregistered: false, reason: 'absent' });
    expect(client.deleteVariable).not.toHaveBeenCalled();
  });

  it('treats a corrupt/unparseable slot as absent (does not delete what it can\'t verify)', async () => {
    vi.mocked(client.readVariable).mockResolvedValueOnce('}{ not json');

    const registry = createRegistry(client, PROJECT);
    const result = await registry.deregisterConditional('code_agent', 'aaaaaa');

    expect(result).toEqual({ deregistered: false, reason: 'absent' });
    expect(client.deleteVariable).not.toHaveBeenCalled();
  });

  it('returns an error RESULT (never throws) when the read fails', async () => {
    vi.mocked(client.readVariable).mockRejectedValueOnce(new Error('network 500'));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.deregisterConditional('code_agent', 'aaaaaa');

    expect(result).toEqual({ deregistered: false, reason: 'error' });
  });

  it('returns an error RESULT (never throws) when the delete fails after a match', async () => {
    vi.mocked(client.readVariable).mockResolvedValueOnce(JSON.stringify(AGENT_A));
    vi.mocked(client.deleteVariable).mockRejectedValueOnce(new Error('delete 500'));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.deregisterConditional('code_agent', 'aaaaaa');

    expect(result).toEqual({ deregistered: false, reason: 'error' });
  });
});

// --- Local backend -----------------------------------------------------------

interface Sandbox {
  readonly dir: string;
  readonly filePath: string;
}

function makeSandbox(): Sandbox {
  const dir = path.join(tmpdir(), `macf-dereg-test-${randomBytes(6).toString('hex')}`);
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

describe('createLocalRegistry().deregisterConditional (local backend)', () => {
  it('deletes the slot when the instance_id matches', async () => {
    const sb = makeSandbox();
    try {
      seed(sb, { 'code-agent': AGENT_A });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.deregisterConditional('code-agent', 'aaaaaa');

      expect(result).toEqual({ deregistered: true, reason: 'deleted' });
      expect(await registry.get('code-agent')).toBeNull();
    } finally {
      await cleanup(sb);
    }
  });

  it('is a NO-OP when the instance_id differs — leaves the newer instance\'s slot intact (THE guard)', async () => {
    const sb = makeSandbox();
    try {
      // A newer instance (#424) holds the slot with id 'bbbbbb'.
      seed(sb, { 'code-agent': AGENT_B });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.deregisterConditional('code-agent', 'aaaaaa');

      expect(result).toEqual({ deregistered: false, reason: 'not-ours' });
      // The live newer registration is untouched (no inverse-of-#553 clobber).
      expect(await registry.get('code-agent')).toEqual(AGENT_B);
    } finally {
      await cleanup(sb);
    }
  });

  it('is a NO-OP when the slot is absent', async () => {
    const sb = makeSandbox();
    try {
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.deregisterConditional('code-agent', 'aaaaaa');

      expect(result).toEqual({ deregistered: false, reason: 'absent' });
    } finally {
      await cleanup(sb);
    }
  });

  it('deletes ours without disturbing other agents in the file', async () => {
    const sb = makeSandbox();
    try {
      seed(sb, { 'code-agent': AGENT_A, 'science-agent': AGENT_B });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.deregisterConditional('code-agent', 'aaaaaa');

      expect(result).toEqual({ deregistered: true, reason: 'deleted' });
      expect(await registry.get('code-agent')).toBeNull();
      expect(await registry.get('science-agent')).toEqual(AGENT_B);
    } finally {
      await cleanup(sb);
    }
  });

  it('returns an error RESULT (never throws) on a malformed registry file', async () => {
    const sb = makeSandbox();
    try {
      // Malformed JSON → readRegistryFile throws LocalRegistryError; the method
      // must catch it and report reason:'error' rather than crashing shutdown.
      writeFileSync(sb.filePath, '}{ not json', { mode: 0o600 });
      if (!IS_WIN) chmodSync(sb.filePath, 0o600);

      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.deregisterConditional('code-agent', 'aaaaaa');

      expect(result).toEqual({ deregistered: false, reason: 'error' });
    } finally {
      await cleanup(sb);
    }
  });
});
