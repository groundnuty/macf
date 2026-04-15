import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChallenge, verifyAndConsumeChallenge, ChallengeError } from '../../src/certs/challenge.js';
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
      expect(result.instruction).toContain('MACF_CHALLENGE_NEW_AGENT');
      expect(result.instruction).toContain(result.challengeId);

      expect(client.writeVariable).toHaveBeenCalledWith(
        'MACF_CHALLENGE_NEW_AGENT',
        result.challengeId,
      );
    });

    it('generates unique challenge IDs', async () => {
      const result1 = await createChallenge({ project: 'T', agentName: 'a', client });
      const result2 = await createChallenge({ project: 'T', agentName: 'a', client });

      expect(result1.challengeId).not.toBe(result2.challengeId);
    });
  });

  describe('verifyAndConsumeChallenge', () => {
    it('returns stored value and deletes the variable', async () => {
      vi.mocked(client.readVariable).mockResolvedValueOnce('abc123');

      const storedValue = await verifyAndConsumeChallenge({
        project: 'MACF',
        agentName: 'new_agent',
        client,
      });

      expect(storedValue).toBe('abc123');
      expect(client.readVariable).toHaveBeenCalledWith('MACF_CHALLENGE_NEW_AGENT');
      expect(client.deleteVariable).toHaveBeenCalledWith('MACF_CHALLENGE_NEW_AGENT');
    });

    it('throws when no challenge variable exists', async () => {
      await expect(verifyAndConsumeChallenge({
        project: 'MACF',
        agentName: 'missing',
        client,
      })).rejects.toThrow(ChallengeError);
    });

    it('sanitizes hyphens in project and agent name (issue #46)', async () => {
      // academic-resume / cv-architect are realistic inputs that previously
      // produced invalid variable names with hyphens.
      const result = await createChallenge({
        project: 'academic-resume',
        agentName: 'cv-architect',
        client,
      });

      expect(client.writeVariable).toHaveBeenCalledWith(
        'ACADEMIC_RESUME_CHALLENGE_CV_ARCHITECT',
        result.challengeId,
      );
    });
  });
});
