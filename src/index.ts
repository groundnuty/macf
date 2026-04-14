/**
 * Multi-Agent Coordination Framework (MACF)
 *
 * Coordinates multiple Claude Code agents via GitHub,
 * using MCP channels (HTTP/mTLS) for communication.
 */

export { MacfError, ConfigError, McpChannelError, HttpsServerError, PortUnavailableError, PortExhaustedError, ValidationError } from './errors.js';
export { createMcpChannel } from './mcp.js';
export { createHttpsServer } from './https.js';
export { createHealthState } from './health.js';
export { createLogger } from './logger.js';
export { loadConfig } from './config.js';
export { NotifyPayloadSchema, NotifyTypeSchema, HealthResponseSchema } from './types.js';
export type { NotifyPayload, NotifyType, HealthResponse, AgentConfig, Logger, McpChannel, HttpsServer, HealthState } from './types.js';

// P2: Registry & Discovery
export { createRegistryFromConfig, createRegistry, createGitHubClient, GitHubApiError, AgentInfoSchema, RegistryConfigSchema } from './registry/index.js';
export type { AgentInfo, Registry, RegistryConfig, GitHubVariablesClient } from './registry/index.js';
export { checkCollision, CollisionError } from './collision.js';
export type { CollisionResult } from './collision.js';
export { registerShutdownHandler } from './shutdown.js';
export { generateToken } from './token.js';
export { checkPendingIssues } from './startup-issues.js';
