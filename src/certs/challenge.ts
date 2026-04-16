/**
 * Challenge-response for /sign per DR-010 (security fix — issue #80).
 *
 * Protocol (corrected per science-agent's implementation guidance):
 *
 *   Step 1 (server):  createChallenge(store, agentName)
 *                        — allocate (challenge_id, expected_value) in the
 *                          server's in-memory store
 *                        — return id + instruction to the client
 *                        — **do NOT write** the registry variable; that's
 *                          the client's job, and their doing so is the
 *                          actual proof-of-GitHub-write-access
 *
 *   Client:            writes MACF_CHALLENGE_<agent> = <expected_value>
 *                        in the registry, using ITS OWN github token
 *
 *   Step 2 (server):  verifyAndConsumeChallenge(store, client, challenge_id,
 *                                                agent_name)
 *                        — look up challenge_id in store (reject if absent,
 *                          expired, or agent_name doesn't match)
 *                        — read MACF_CHALLENGE_<agent> from the registry
 *                        — timing-safe compare observed vs expected
 *                        — delete the registry variable + in-memory entry
 *                          on ANY outcome (success or failure) to prevent
 *                          replay
 *                        — return 'ok' / 'mismatch' — caller returns a
 *                          GENERIC error ('challenge verification failed')
 *                          for all failure modes to avoid oracle attacks
 *
 * The previous implementation (pre-#80) had the SERVER write the variable
 * in step 1, then read what it itself wrote in step 6 — no comparison,
 * no client-side proof of GitHub write access. Any mTLS cert holder could
 * obtain a cert for arbitrary agent_name. This module is the fix.
 */
import type { GitHubVariablesClient } from '../registry/types.js';
import { toVariableSegment } from '../registry/variable-name.js';
import { MacfError } from '../errors.js';
import type { ChallengeStore } from './challenge-store.js';

export class ChallengeError extends MacfError {
  constructor(message: string) {
    super('CHALLENGE_ERROR', message);
    this.name = 'ChallengeError';
  }
}

/** Registry variable name for an agent's current challenge. */
export function challengeVarName(project: string, agentName: string): string {
  return `${toVariableSegment(project)}_CHALLENGE_${toVariableSegment(agentName)}`;
}

/**
 * Allocate a challenge and return the client-facing (id + instruction).
 * Does NOT write the registry variable — the client does that in the next
 * round-trip, proving GitHub write access at the registry scope.
 */
export function createChallenge(config: {
  readonly project: string;
  readonly agentName: string;
  readonly store: ChallengeStore;
}): { readonly challengeId: string; readonly instruction: string } {
  const rec = config.store.issue(config.agentName);
  const varName = challengeVarName(config.project, config.agentName);
  return {
    challengeId: rec.challengeId,
    instruction:
      `Write registry variable ${varName} = '${rec.expectedValue}'. ` +
      `Then POST /sign again with { challenge_done: true, challenge_id: '${rec.challengeId}' }.`,
  };
}

/**
 * Verify a step-2 request. Caller passes the client-supplied challenge_id
 * and agent_name. We read the registry variable, delete it regardless of
 * outcome (prevents replay), consume the in-memory entry, and return
 * 'ok' / 'mismatch' — the caller surfaces a generic error on mismatch to
 * avoid telling the attacker WHICH check failed.
 */
export async function verifyAndConsumeChallenge(config: {
  readonly project: string;
  readonly agentName: string;
  readonly challengeId: string;
  readonly store: ChallengeStore;
  readonly client: GitHubVariablesClient;
}): Promise<'ok' | 'mismatch'> {
  const varName = challengeVarName(config.project, config.agentName);

  const observedValue = await config.client.readVariable(varName);

  // Delete the registry variable unconditionally (best-effort). Intentional:
  // mismatch attempts don't leave a re-usable variable behind; attackers get
  // one shot per outstanding challenge.
  try {
    await config.client.deleteVariable(varName);
  } catch {
    // Ignore; consuming the in-memory entry below still blocks replay
    // server-side, which is the security-critical half.
  }

  if (observedValue === null) {
    // Still consume the in-memory entry (replay-block).
    config.store.consume(config.challengeId, config.agentName, '');
    return 'mismatch';
  }

  return config.store.consume(config.challengeId, config.agentName, observedValue);
}
