/**
 * Multi-Agent Coordination Framework (MACF)
 *
 * Coordinates multiple Claude Code agents via GitHub,
 * using MCP channels (HTTP/mTLS) for communication.
 */

export { MacfError, ConfigError, McpChannelError, HttpsServerError, PortUnavailableError, PortExhaustedError, ValidationError } from '@groundnuty/macf-core';
export { createMcpChannel } from './mcp.js';
export { createHttpsServer } from './https.js';
export { createHealthState } from './health.js';
export { createLogger } from '@groundnuty/macf-core';
export { loadConfig } from '@groundnuty/macf-core';
export {
  NotifyPayloadSchema, NotifyTypeSchema, HealthResponseSchema,
  CiCompletionPayloadSchema, CheckSuiteConclusionSchema,
} from '@groundnuty/macf-core';
export type {
  NotifyPayload, NotifyType, HealthResponse, AgentConfig, Logger,
  McpChannel, HttpsServer, HealthState,
  CiCompletionPayload, CheckSuiteConclusion,
} from '@groundnuty/macf-core';

// P2: Registry & Discovery
export { createRegistryFromConfig, createRegistry, createGitHubClient, GitHubApiError, AgentInfoSchema, agentInfoEquals, RegistryConfigSchema } from '@groundnuty/macf-core';
export type { AgentInfo, Registry, RegisterResult, RegistryConfig, GitHubVariablesClient } from '@groundnuty/macf-core';
export { checkCollision, CollisionError, RegisterRaceError } from './collision.js';
export type { CollisionResult } from './collision.js';
export { registerShutdownHandler } from './shutdown.js';
export { generateToken } from '@groundnuty/macf-core';
export { checkPendingIssues } from './startup-issues.js';

// P3: Certificate Management
export { createCA, backupCAKey, recoverCAKey, encryptCAKey, decryptCAKey, loadCA, CaError } from '@groundnuty/macf-core';
export type { CaKeyPair } from '@groundnuty/macf-core';
export { generateAgentCert, generateCSR, signCSR, AgentCertError } from '@groundnuty/macf-core';
export type { AgentCertResult } from '@groundnuty/macf-core';
export { createChallenge, verifyAndConsumeChallenge, ChallengeError } from '@groundnuty/macf-core';
export { SignRequestSchema, SignChallengeResponseSchema, SignCertResponseSchema } from '@groundnuty/macf-core';
export type { SignRequest } from '@groundnuty/macf-core';
