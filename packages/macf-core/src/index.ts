/**
 * Barrel export for the macf-core package.
 *
 * Internal-shared-code package consumed by the MACF CLI and channel-
 * server packages via npm workspaces. Not intended for direct
 * external use (will be marked deprecated-internal on first npm
 * publish per DR-022 Amendment A).
 *
 * Re-exports everything the consumers need so they can
 * `import { X } from '@groundnuty/macf-core'` instead of reaching
 * into subpaths. Subpath imports are still supported via normal
 * node-resolution for consumers that need a specific module.
 */
export * from './errors.js';
export * from './logger.js';
export * from './config.js';
export * from './token.js';
export * from './types.js';
export * from './semver.js';
export * from './reflection.js';
export * from './prompt-responses.js';
export * from './guest.js';
export * from './norm.js';
export * from './protected-invariant-norms.js';
export * from './mtls-health-ping.js';
export * from './certs/index.js';
export * from './registry/index.js';

// Subpath modules NOT re-exported from the subdir index.ts files;
// surface them here so consumers can use the flat barrel uniformly.
export { createChallengeStore, DEFAULT_CHALLENGE_TTL_MS } from './certs/challenge-store.js';
export type { ChallengeRecord, ChallengeStore, Clock } from './certs/challenge-store.js';
