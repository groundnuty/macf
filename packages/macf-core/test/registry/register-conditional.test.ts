/**
 * Conditional (compare-and-set) register — groundnuty/macf#439.
 *
 * Closes the TOCTOU window between the collision check's read
 * (`checkCollision` → `registry.get`) and the registration write
 * (`server.ts` → previously a blind `registry.register`). `registerConditional`
 * writes only if the slot still matches the state the collision check observed,
 * so a racing second writer of the same identity can't silently clobber the
 * first (a double-takeover).
 *
 * Coverage:
 *  - `agentInfoEquals` value semantics (the CAS comparator)
 *  - GitHub backend: pre-write compare + post-write read-back verify (no native
 *    CAS primitive on the Actions Variables API — best-effort narrowing)
 *  - Local backend: fully atomic CAS under the file lock, incl. two genuinely
 *    concurrent writers racing for the same slot → exactly one wins
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs, chmodSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRegistry } from '../../src/registry/registry.js';
import { createLocalRegistry } from '../../src/registry/local-client.js';
import { agentInfoEquals } from '../../src/registry/types.js';
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

const AGENT_B: AgentInfo = {
  host: '100.86.5.117',
  port: 8848,
  type: 'permanent',
  instance_id: 'bbbbbb',
  started: '2026-06-05T10:00:01Z',
};

const PREVIOUS: AgentInfo = {
  host: '100.86.5.117',
  port: 8800,
  type: 'permanent',
  instance_id: 'old123',
  started: '2026-06-05T09:00:00Z',
};

// --- agentInfoEquals ---------------------------------------------------------

describe('agentInfoEquals', () => {
  it('treats two nulls as equal (both slots empty)', () => {
    expect(agentInfoEquals(null, null)).toBe(true);
  });

  it('treats null vs a value as not equal', () => {
    expect(agentInfoEquals(null, AGENT_A)).toBe(false);
    expect(agentInfoEquals(AGENT_A, null)).toBe(false);
  });

  it('treats identical values as equal', () => {
    expect(agentInfoEquals(AGENT_A, { ...AGENT_A })).toBe(true);
  });

  it('detects a difference in any single field', () => {
    expect(agentInfoEquals(AGENT_A, { ...AGENT_A, host: 'x' })).toBe(false);
    expect(agentInfoEquals(AGENT_A, { ...AGENT_A, port: 1 })).toBe(false);
    expect(agentInfoEquals(AGENT_A, { ...AGENT_A, type: 'worker' })).toBe(false);
    expect(agentInfoEquals(AGENT_A, { ...AGENT_A, instance_id: 'zzz' })).toBe(false);
    expect(agentInfoEquals(AGENT_A, { ...AGENT_A, started: 'later' })).toBe(false);
  });
});

// --- GitHub backend ----------------------------------------------------------

function mockClient(): GitHubVariablesClient {
  return {
    writeVariable: vi.fn().mockResolvedValue(undefined),
    readVariable: vi.fn().mockResolvedValue(null),
    listVariables: vi.fn().mockResolvedValue([]),
    deleteVariable: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createRegistry().registerConditional (GitHub backend)', () => {
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = mockClient();
  });

  it('writes when the slot is still absent as expected (register), read-back confirms', async () => {
    // pre-write read → null (matches expected=null); post-write read-back → ours
    vi.mocked(client.readVariable)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(AGENT_A));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.registerConditional('code_agent', AGENT_A, null);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('claimed');
    expect(result.current).toEqual(AGENT_A);
    expect(client.writeVariable).toHaveBeenCalledWith(
      'MACF_AGENT_CODE_AGENT',
      expect.stringContaining('"instance_id":"aaaaaa"'),
    );
  });

  it('writes when the slot still holds the takeover target (takeover)', async () => {
    vi.mocked(client.readVariable)
      .mockResolvedValueOnce(JSON.stringify(PREVIOUS)) // pre-write: matches expected
      .mockResolvedValueOnce(JSON.stringify(AGENT_A)); // read-back: ours

    const registry = createRegistry(client, PROJECT);
    const result = await registry.registerConditional('code_agent', AGENT_A, PREVIOUS);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('claimed');
    expect(client.writeVariable).toHaveBeenCalledTimes(1);
  });

  it('does NOT write when the slot changed before the write (pre-write compare fails)', async () => {
    // Expected the slot absent, but a racer already registered AGENT_B.
    vi.mocked(client.readVariable).mockResolvedValueOnce(JSON.stringify(AGENT_B));

    const registry = createRegistry(client, PROJECT);
    const result = await registry.registerConditional('code_agent', AGENT_A, null);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lost-to-newer');
    expect(result.current).toEqual(AGENT_B);
    expect(client.writeVariable).not.toHaveBeenCalled();
  });

  it('detects a racer that wrote inside the residual window (post-write read-back shows a DIFFERENT instance)', async () => {
    // pre-write read matches expected (PREVIOUS), so we write — but the
    // read-back shows a DIFFERENT instance that is neither ours NOR the
    // expected pre-write value: a concurrent newer instance wrote between our
    // compare and our write. That is a real lost race, not a read-lag artifact.
    vi.mocked(client.readVariable)
      .mockResolvedValueOnce(JSON.stringify(PREVIOUS)) // pre-write compare OK
      .mockResolvedValueOnce(JSON.stringify(AGENT_B)); // read-back: someone else's

    const registry = createRegistry(client, PROJECT);
    const result = await registry.registerConditional('code_agent', AGENT_A, PREVIOUS);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lost-to-newer');
    expect(result.current).toEqual(AGENT_B);
  });

  // --- groundnuty/macf#702 over-register: read-after-write lag must NOT abort ---

  it('DEVOPS REGRESSION: current==expected==<stale> claims even when the read-back LAGS (never lost-to-newer)', async () => {
    // The exact devops 8h-outage shape: the collision check decided to take
    // over the stale/dead PREVIOUS entry; the pre-write compare finds it
    // unchanged (current==expected==PREVIOUS) → we write; but the GitHub
    // Variables API's read-after-write lag serves the STALE PREVIOUS value on
    // EVERY read-back retry (never catches up within the budget). Pre-#702
    // this returned ok:false (mistaking the lag for a lost race) → the agent
    // aborted with AGENT_REGISTER_RACE and stayed DOWN. Post-#702 it must
    // trust the write it issued and claim.
    vi.mocked(client.readVariable)
      .mockResolvedValueOnce(JSON.stringify(PREVIOUS)) // pre-write compare OK
      .mockResolvedValue(JSON.stringify(PREVIOUS)); // EVERY read-back lags (stale)

    const registry = createRegistry(client, PROJECT);
    const result = await registry.registerConditional('code_agent', AGENT_A, PREVIOUS);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('claimed');
    expect(result.current).toEqual(AGENT_A);
    // We DID issue the write — a lagging read-back must not un-write it.
    expect(client.writeVariable).toHaveBeenCalledTimes(1);
  });

  it('claims when the read-back lags but EVENTUALLY confirms our write (lag resolves within the retry budget)', async () => {
    // Write succeeds; first read-back still shows the stale PREVIOUS (lag),
    // second read-back catches up and shows OURS. Claim, no error.
    vi.mocked(client.readVariable)
      .mockResolvedValueOnce(JSON.stringify(PREVIOUS)) // pre-write compare OK
      .mockResolvedValueOnce(JSON.stringify(PREVIOUS)) // read-back #1: lagging
      .mockResolvedValueOnce(JSON.stringify(AGENT_A)); // read-back #2: confirmed

    const registry = createRegistry(client, PROJECT);
    const result = await registry.registerConditional('code_agent', AGENT_A, PREVIOUS);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('claimed');
    expect(result.current).toEqual(AGENT_A);
  });

  it('claims against an expected-absent slot even when the read-back reads null forever (propagation lag)', async () => {
    // Fresh register (expected=null): pre-write null (matches), write, but the
    // read-back never shows our write (stays null / propagation lag). The
    // write itself did not error → trust it, claim.
    vi.mocked(client.readVariable)
      .mockResolvedValueOnce(null) // pre-write compare OK (absent as expected)
      .mockResolvedValue(null); // read-back never propagates

    const registry = createRegistry(client, PROJECT);
    const result = await registry.registerConditional('code_agent', AGENT_A, null);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('claimed');
    expect(result.current).toEqual(AGENT_A);
  });
});

// --- Local backend -----------------------------------------------------------

interface Sandbox {
  readonly dir: string;
  readonly filePath: string;
}

function makeSandbox(): Sandbox {
  const dir = path.join(tmpdir(), `macf-cas-test-${randomBytes(6).toString('hex')}`);
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

describe('createLocalRegistry().registerConditional (local backend)', () => {
  it('writes when the slot is absent as expected', async () => {
    const sb = makeSandbox();
    try {
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.registerConditional('code-agent', AGENT_A, null);

      expect(result.ok).toBe(true);
      expect(result.reason).toBe('claimed');
      expect(await registry.get('code-agent')).toEqual(AGENT_A);
    } finally {
      await cleanup(sb);
    }
  });

  it('refuses to clobber when expected-absent but the slot is taken', async () => {
    const sb = makeSandbox();
    try {
      seed(sb, { 'code-agent': AGENT_B });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.registerConditional('code-agent', AGENT_A, null);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('lost-to-newer');
      expect(result.current).toEqual(AGENT_B);
      // The existing registration is untouched (no silent clobber).
      expect(await registry.get('code-agent')).toEqual(AGENT_B);
    } finally {
      await cleanup(sb);
    }
  });

  it('takes over when the slot still holds the expected previous instance', async () => {
    const sb = makeSandbox();
    try {
      seed(sb, { 'code-agent': PREVIOUS });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.registerConditional('code-agent', AGENT_A, PREVIOUS);

      expect(result.ok).toBe(true);
      expect(result.reason).toBe('claimed');
      expect(await registry.get('code-agent')).toEqual(AGENT_A);
    } finally {
      await cleanup(sb);
    }
  });

  it('DEVOPS REGRESSION (local backend): current==expected==<stale> claims (atomic — no lag, always claims)', async () => {
    // On the local backend the compare+write is lock-atomic so there is no
    // read-after-write lag to distinguish, but the invariant is identical to
    // the GitHub backend's #702 fix: current==expected==<stale> ALWAYS claims,
    // never returns lost-to-newer. Seed the stale entry as the takeover target.
    const sb = makeSandbox();
    try {
      seed(sb, { 'code-agent': PREVIOUS });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.registerConditional('code-agent', AGENT_A, PREVIOUS);

      expect(result.ok).toBe(true);
      expect(result.reason).toBe('claimed');
      expect(await registry.get('code-agent')).toEqual(AGENT_A);
    } finally {
      await cleanup(sb);
    }
  });

  it('refuses takeover when the slot changed since the collision check (stale expected)', async () => {
    const sb = makeSandbox();
    try {
      // Collision check observed PREVIOUS, but AGENT_B already took the slot.
      seed(sb, { 'code-agent': AGENT_B });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const result = await registry.registerConditional('code-agent', AGENT_A, PREVIOUS);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('lost-to-newer');
      expect(result.current).toEqual(AGENT_B);
      expect(await registry.get('code-agent')).toEqual(AGENT_B);
    } finally {
      await cleanup(sb);
    }
  });

  it('two concurrent fresh registers against an empty slot → exactly one wins', async () => {
    const sb = makeSandbox();
    try {
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const [r1, r2] = await Promise.all([
        registry.registerConditional('code-agent', AGENT_A, null),
        registry.registerConditional('code-agent', AGENT_B, null),
      ]);

      const winners = [r1, r2].filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      // The loser observed the winner's value (no silent clobber).
      const loser = [r1, r2].find((r) => !r.ok)!;
      const stored = await registry.get('code-agent');
      expect([AGENT_A, AGENT_B]).toContainEqual(stored);
      expect(loser.current).toEqual(stored);
    } finally {
      await cleanup(sb);
    }
  });

  it('two concurrent takeovers of the same dead instance → exactly one wins', async () => {
    const sb = makeSandbox();
    try {
      seed(sb, { 'code-agent': PREVIOUS });
      const registry = createLocalRegistry({ path: sb.filePath, project: PROJECT });
      const [r1, r2] = await Promise.all([
        registry.registerConditional('code-agent', AGENT_A, PREVIOUS),
        registry.registerConditional('code-agent', AGENT_B, PREVIOUS),
      ]);

      expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
      const stored = await registry.get('code-agent');
      // The winner replaced PREVIOUS; the loser did not re-clobber back to it.
      expect(stored).not.toEqual(PREVIOUS);
      expect([AGENT_A, AGENT_B]).toContainEqual(stored);
    } finally {
      await cleanup(sb);
    }
  });
});
