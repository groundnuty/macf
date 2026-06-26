export { AgentInfoSchema, agentInfoEquals, RegistryConfigSchema, OrgRegistryConfigSchema, ProfileRegistryConfigSchema, RepoRegistryConfigSchema, LocalRegistryConfigSchema } from './types.js';
export type { AgentInfo, Registry, RegisterResult, DeregisterResult, HeartbeatResult, RegistryConfig, GitHubVariablesClient } from './types.js';
export { isStaleEntry, DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS, DEFAULT_REGISTRY_TTL_MS } from './heartbeat.js';
export { createGitHubClient, GitHubApiError } from './github-client.js';
export { createRegistry } from './registry.js';
export { createRegistryFromConfig } from './factory.js';
export { createLocalRegistry, LocalRegistryError, RegistryFileSchema, REGISTRY_SCHEMA_VERSION } from './local-client.js';
export type { LocalRegistryOptions, RegistryFile } from './local-client.js';
export { toVariableSegment } from './variable-name.js';
