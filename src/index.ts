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
