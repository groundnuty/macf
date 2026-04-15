import { randomBytes } from 'node:crypto';
import type { GitHubVariablesClient } from '../registry/types.js';
import { toVariableSegment } from '../registry/variable-name.js';
import { MacfError } from '../errors.js';

export class ChallengeError extends MacfError {
  constructor(message: string) {
    super('CHALLENGE_ERROR', message);
    this.name = 'ChallengeError';
  }
}

function challengeVarName(project: string, agentName: string): string {
  return `${toVariableSegment(project)}_CHALLENGE_${toVariableSegment(agentName)}`;
}

/**
 * Create a new challenge for an agent cert signing request.
 * Stores the challenge ID in a registry variable.
 */
export async function createChallenge(config: {
  readonly project: string;
  readonly agentName: string;
  readonly client: GitHubVariablesClient;
}): Promise<{ readonly challengeId: string; readonly instruction: string }> {
  const challengeId = randomBytes(16).toString('hex');
  const varName = challengeVarName(config.project, config.agentName);

  await config.client.writeVariable(varName, challengeId);

  return {
    challengeId,
    instruction: `Write ${varName} = '${challengeId}' to the registry`,
  };
}

/**
 * Verify and consume a challenge: read the variable, compare with submitted ID,
 * delete on match (one-time use). Throws on mismatch or missing challenge.
 */
export async function verifyAndConsumeChallenge(config: {
  readonly project: string;
  readonly agentName: string;
  readonly client: GitHubVariablesClient;
}): Promise<string> {
  const varName = challengeVarName(config.project, config.agentName);

  const storedValue = await config.client.readVariable(varName);
  if (storedValue === null) {
    throw new ChallengeError(`No challenge found for agent "${config.agentName}"`);
  }

  // Delete the challenge variable (one-time use) — consume regardless of match
  // to prevent brute-force attempts
  await config.client.deleteVariable(varName);

  return storedValue;
}
