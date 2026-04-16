/**
 * Tests for DR-010 challenge-response after the #80 security fix.
 *
 * Covers the seven property-based cases science-agent specified:
 *   1. Reject mismatch (correct id, wrong value in registry)
 *   2. Reject expired (id known, past TTL)
 *   3. Reject replay (second attempt with same id after success or failure)
 *   4. Reject mismatched agent_name (id was for agent-A, step 2 asks for agent-B)
 *   5. Reject missing registry variable (client never wrote, calls step 2 anyway)
 *   6. Accept happy path with timing-safe comparison
 *   7. TTL boundary — at T+TTL-1 should accept, at T+TTL+1 should reject
 *
 * Plus coverage of the createChallenge contract (no registry write, UUID id,
 * varname sanitization).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createChallenge,
  verifyAndConsumeChallenge,
  challengeVarName,
  ChallengeError,
} from '../../src/certs/challenge.js';
import { createChallengeStore, DEFAULT_CHALLENGE_TTL_MS } from '../../src/certs/challenge-store.js';
import type { GitHubVariablesClient } from '../../src/registry/types.js';

function mockClient(): GitHubVariablesClient {
  return {
    writeVariable: vi.fn().mockResolvedValue(undefined),
    readVariable: vi.fn().mockResolvedValue(null),
    listVariables: vi.fn().mockResolvedValue([]),
    deleteVariable: vi.fn().mockResolvedValue(undefined),
  };
}

/** Extract the expected value from createChallenge's instruction string. */
function extractExpectedValue(instruction: string): string {
  const m = instruction.match(/= '([^']+)'/);
  expect(m).toBeTruthy();
  return m![1]!;
}

describe('challengeVarName', () => {
  it('uppercases and de-hyphenates project + agent_name', () => {
    expect(challengeVarName('macf', 'code-agent'))
      .toBe('MACF_CHALLENGE_CODE_AGENT');
  });

  it('handles hyphenated project names (issue #46 precedent)', () => {
    expect(challengeVarName('academic-resume', 'cv-architect'))
      .toBe('ACADEMIC_RESUME_CHALLENGE_CV_ARCHITECT');
  });
});

describe('createChallenge (step 1)', () => {
  let client: ReturnType<typeof mockClient>;
  let store: ReturnType<typeof createChallengeStore>;

  beforeEach(() => {
    client = mockClient();
    store = createChallengeStore();
  });

  it('returns a UUID challenge_id', () => {
    const r = createChallenge({ project: 'macf', agentName: 'code-agent', store });
    expect(r.challengeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does NOT write the registry variable (client writes in round-trip)', () => {
    // The whole point of #80: the server must NOT pre-write the value it's
    // about to compare against. The client writes, proving GitHub write access.
    createChallenge({ project: 'macf', agentName: 'code-agent', store });
    expect(client.writeVariable).not.toHaveBeenCalled();
  });

  it('instruction names the variable and includes the expected value', () => {
    const r = createChallenge({ project: 'macf', agentName: 'code-agent', store });
    expect(r.instruction).toContain('MACF_CHALLENGE_CODE_AGENT');
    const value = extractExpectedValue(r.instruction);
    expect(value.length).toBeGreaterThan(20);
  });

  it('allocates unique challenge_ids across successive calls', () => {
    const a = createChallenge({ project: 'macf', agentName: 'code-agent', store });
    const b = createChallenge({ project: 'macf', agentName: 'code-agent', store });
    expect(a.challengeId).not.toBe(b.challengeId);
  });
});

describe('verifyAndConsumeChallenge (step 2)', () => {
  let client: ReturnType<typeof mockClient>;
  let store: ReturnType<typeof createChallengeStore>;
  let fakeNow: number;

  beforeEach(() => {
    client = mockClient();
    fakeNow = 1_000_000;
    store = createChallengeStore({ clock: () => fakeNow });
  });

  /** Issue a challenge and have the mock registry return the expected value. */
  function issueAndWrite(agentName: string): { challengeId: string; expectedValue: string } {
    const r = createChallenge({ project: 'macf', agentName, store });
    const expectedValue = extractExpectedValue(r.instruction);
    vi.mocked(client.readVariable).mockResolvedValue(expectedValue);
    return { challengeId: r.challengeId, expectedValue };
  }

  // Case 6: happy path
  it('accepts the happy path (matching id + matching registry value)', async () => {
    const { challengeId } = issueAndWrite('code-agent');
    const result = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId, store, client,
    });
    expect(result).toBe('ok');
    expect(client.deleteVariable).toHaveBeenCalledWith('MACF_CHALLENGE_CODE_AGENT');
  });

  // Case 1: reject mismatch (wrong value in registry)
  it('rejects when the registry value does not match the expected value', async () => {
    const { challengeId } = issueAndWrite('code-agent');
    vi.mocked(client.readVariable).mockResolvedValue('not-the-expected-value');
    const result = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId, store, client,
    });
    expect(result).toBe('mismatch');
  });

  // Case 4: reject mismatched agent_name
  it('rejects when step 2 uses a different agent_name than step 1', async () => {
    const { challengeId } = issueAndWrite('code-agent');
    // Attacker tries to use code-agent's challenge to sign a science-agent cert.
    const result = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'science-agent', challengeId, store, client,
    });
    expect(result).toBe('mismatch');
  });

  // Case 5: reject missing registry variable
  it('rejects when the client never wrote the registry variable', async () => {
    const r = createChallenge({ project: 'macf', agentName: 'code-agent', store });
    vi.mocked(client.readVariable).mockResolvedValue(null);
    const result = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId: r.challengeId, store, client,
    });
    expect(result).toBe('mismatch');
  });

  // Case 3a: reject replay after success
  it('rejects replay of a successfully-used challenge_id', async () => {
    const { challengeId } = issueAndWrite('code-agent');
    const first = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId, store, client,
    });
    expect(first).toBe('ok');
    const second = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId, store, client,
    });
    expect(second).toBe('mismatch');
  });

  // Case 3b: reject replay after failure
  it('rejects replay after a prior mismatch on the same challenge_id', async () => {
    const { challengeId } = issueAndWrite('code-agent');
    vi.mocked(client.readVariable).mockResolvedValue('wrong');
    const first = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId, store, client,
    });
    expect(first).toBe('mismatch');
    vi.mocked(client.readVariable).mockResolvedValue('whatever');
    const second = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId, store, client,
    });
    expect(second).toBe('mismatch');
  });

  // Case 2 + 7: TTL boundary
  it('accepts at T+TTL-1 and rejects at T+TTL+1', async () => {
    const r = createChallenge({ project: 'macf', agentName: 'code-agent', store });
    const expectedValue = extractExpectedValue(r.instruction);
    vi.mocked(client.readVariable).mockResolvedValue(expectedValue);

    fakeNow += DEFAULT_CHALLENGE_TTL_MS - 1;
    const stillValid = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId: r.challengeId, store, client,
    });
    expect(stillValid).toBe('ok');

    // Fresh challenge, advance past TTL.
    const r2 = createChallenge({ project: 'macf', agentName: 'code-agent', store });
    const expectedValue2 = extractExpectedValue(r2.instruction);
    vi.mocked(client.readVariable).mockResolvedValue(expectedValue2);
    fakeNow += DEFAULT_CHALLENGE_TTL_MS + 1;
    const expired = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId: r2.challengeId, store, client,
    });
    expect(expired).toBe('mismatch');
  });

  it('deletes the registry variable on mismatch too (prevents retry)', async () => {
    const { challengeId } = issueAndWrite('code-agent');
    vi.mocked(client.readVariable).mockResolvedValue('wrong');
    await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId, store, client,
    });
    expect(client.deleteVariable).toHaveBeenCalledWith('MACF_CHALLENGE_CODE_AGENT');
  });

  it('rejects with mismatch when challenge_id is completely unknown', async () => {
    const result = await verifyAndConsumeChallenge({
      project: 'macf',
      agentName: 'code-agent',
      challengeId: '00000000-0000-4000-8000-000000000000',
      store,
      client,
    });
    expect(result).toBe('mismatch');
  });

  it('swallows deleteVariable errors (best-effort cleanup)', async () => {
    const { challengeId } = issueAndWrite('code-agent');
    vi.mocked(client.deleteVariable).mockRejectedValue(new Error('github down'));
    // Should still return 'ok' — in-memory consume is the security-critical half.
    const result = await verifyAndConsumeChallenge({
      project: 'macf', agentName: 'code-agent', challengeId, store, client,
    });
    expect(result).toBe('ok');
  });
});

describe('ChallengeError', () => {
  it('exists as an export for tagged throws (legacy compat)', () => {
    const err = new ChallengeError('test');
    expect(err.name).toBe('ChallengeError');
    expect(err.code).toBe('CHALLENGE_ERROR');
  });
});
