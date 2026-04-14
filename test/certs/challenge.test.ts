import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChallenge, verifyChallenge, ChallengeError } from '../../src/certs/challenge.js';
import type { GitHubVariablesClient } from '../../src/registry/types.js';

function mockClient(): GitHubVariablesClient {
  return {
    writeVariable: vi.fn().mockResolvedValue(undefined),
    readVariable: vi.fn().mockResolvedValue(null),
    listVariables: vi.fn().mockResolvedValue([]),
    deleteVariable: vi.fn().mockResolvedValue(undefined),
  };
}

describe('challenge', () => {
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = mockClient();
  });

  describe('createChallenge', () => {
    it('generates a random challenge ID and writes to registry', async () => {
      const result = await createChallenge({
        project: 'MACF',
        agentName: 'new_agent',
        client,
      });

      expect(result.challengeId).toMatch(/^[0-9a-f]{32}$/);
      expect(result.instruction).toContain('MACF_CHALLENGE_new_agent');
      expect(result.instruction).toContain(result.challengeId);

      expect(client.writeVariable).toHaveBeenCalledWith(
        'MACF_CHALLENGE_new_agent',
        result.challengeId,
      );
    });

    it('generates unique challenge IDs', async () => {
      const result1 = await createChallenge({ project: 'T', agentName: 'a', client });
      const result2 = await createChallenge({ project: 'T', agentName: 'a', client });

      expect(result1.challengeId).not.toBe(result2.challengeId);
    });
  });

  describe('verifyChallenge', () => {
    it('returns stored value and deletes the variable', async () => {
      vi.mocked(client.readVariable).mockResolvedValueOnce('abc123');

      const storedValue = await verifyChallenge({
        project: 'MACF',
        agentName: 'new_agent',
        client,
      });

      expect(storedValue).toBe('abc123');
      expect(client.readVariable).toHaveBeenCalledWith('MACF_CHALLENGE_new_agent');
      expect(client.deleteVariable).toHaveBeenCalledWith('MACF_CHALLENGE_new_agent');
    });

    it('throws when no challenge variable exists', async () => {
      await expect(verifyChallenge({
        project: 'MACF',
        agentName: 'missing',
        client,
      })).rejects.toThrow(ChallengeError);
    });
  });
});
