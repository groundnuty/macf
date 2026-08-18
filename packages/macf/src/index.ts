/**
 * Multi-Agent Coordination Framework (MACF) CLI.
 *
 * The primary consumption shape of this package is as a binary (`macf`
 * and `macf-plugin-cli` — see the `bin` field in package.json). This
 * barrel exposes a small programmatic surface for tooling that needs
 * to invoke CLI helpers directly (tests, integration harnesses).
 *
 * Shared types + functions (errors, logger, config, registry, certs,
 * etc.) live in `@groundnuty/macf-core` and should be imported from
 * there directly, not re-exported here.
 */

// Settings-writer helpers — used by `macf init` / `macf update` /
// `macf rules refresh` to seed workspace `.claude/settings.json`.
export {
  MACF_HOOK_COMMAND,
  PLUGIN_SKILL_PERMISSIONS,
  SANDBOX_FD_READ_PATTERN,
  getSandboxAllowRead,
  installGhTokenHook,
  installPluginSkillPermissions,
  installSandboxFdAllowRead,
} from './cli/settings-writer.js';

// Config resolution — `macf-agent.json` reader + workspace discovery.
export {
  readAgentConfig,
  loadAllAgents,
  loadAllAgentsWithCwdFallback,
  readAgentsIndex,
  writeAgentConfig,
  agentCertPath,
  agentKeyPath,
  caDir,
  caCertPath,
  caKeyPath,
  tokenSourceFromConfig,
} from './cli/config.js';
export type { MacfAgentConfig, VersionPins } from './cli/config.js';

// Canonical rules distribution — `macf rules refresh` entrypoint.
export { copyCanonicalRules, copyCanonicalScripts, findCliPackageRoot } from './cli/rules.js';

// Doctor check — programmatic access for external verification tools.
export { MACF_REQUIRED_PERMISSIONS, diffPermissions, checkSandboxFdAllowRead } from './cli/commands/doctor.js';
export type { RequiredPermission, DoctorFinding, SandboxFdCheck } from './cli/commands/doctor.js';
