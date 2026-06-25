import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ConfigError } from './errors.js';
import type { AgentConfig } from './types.js';
import type { RegistryConfig } from './registry/types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new ConfigError(`Required environment variable ${name} is not set`);
  }
  return value;
}

function requireFilePath(name: string): string {
  const path = requireEnv(name);
  if (!existsSync(path)) {
    throw new ConfigError(`File not found for ${name}: ${path}`);
  }
  return path;
}

export function loadConfig(): AgentConfig {
  const agentName = requireEnv('MACF_AGENT_NAME');
  // macf#538: the routing IDENTITY (registry key + cert CN) is distinct from the
  // OTEL bot-name. `MACF_AGENT_NAME` is the bot-name (e.g. `macf-devops-agent`,
  // used for OTEL `gen_ai.agent.name`); `MACF_ROUTING_LABEL` is the registry-key
  // / CN (e.g. `devops-agent`). They differ on the substrate; they coincide on
  // greenfield agents (auditor) where name == label. Defaults to agentName so
  // every existing agent is unchanged (back-compat: inert until set).
  const routingLabel = process.env['MACF_ROUTING_LABEL'] || agentName;
  const caCertPath = requireFilePath('MACF_CA_CERT');
  const caKeyPath = resolveCaKeyPath(caCertPath);
  const agentCertPath = requireFilePath('MACF_AGENT_CERT');
  const agentKeyPath = requireFilePath('MACF_AGENT_KEY');

  const agentType = process.env['MACF_AGENT_TYPE'] ?? 'permanent';
  if (agentType !== 'permanent' && agentType !== 'worker') {
    throw new ConfigError(`MACF_AGENT_TYPE must be "permanent" or "worker", got "${agentType}"`);
  }

  const portStr = process.env['MACF_PORT'] ?? '0';
  const port = Number.parseInt(portStr, 10);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    throw new ConfigError(`MACF_PORT must be 0-65535, got "${portStr}"`);
  }

  const host = process.env['MACF_HOST'] ?? '0.0.0.0';
  const advertiseHost = process.env['MACF_ADVERTISE_HOST'] ?? (host === '0.0.0.0' ? '127.0.0.1' : host);

  const debugStr = process.env['MACF_DEBUG'] ?? 'false';
  const debug = debugStr === 'true' || debugStr === '1';

  const logPath = process.env['MACF_LOG_PATH'] || undefined;

  // P2: Registry config
  const project = process.env['MACF_PROJECT'] ?? 'MACF';
  const agentRole = process.env['MACF_AGENT_ROLE'] ?? agentName;
  const instanceId = randomBytes(3).toString('hex');

  const registryType = process.env['MACF_REGISTRY_TYPE'] ?? 'repo';
  const registryConfig = parseRegistryConfig(registryType);

  // macf#185: workspace dir + tmux target for the on-notify wake path.
  // All three are optional from the plugin's runtime perspective:
  // - Missing workspaceDir → wake path no-ops (helper script can't be located).
  // - Missing tmuxSession/Window + no $TMUX → wake path no-ops silently.
  // - Any present → wake path uses explicit target, falls back to auto-detect.
  const workspaceDir = process.env['MACF_WORKSPACE_DIR'] || undefined;
  const tmuxSession = process.env['MACF_TMUX_SESSION'] || undefined;
  const tmuxWindow = process.env['MACF_TMUX_WINDOW'] || undefined;

  return {
    agentName,
    routingLabel,
    agentType,
    agentRole,
    host,
    advertiseHost,
    port,
    caCertPath,
    caKeyPath,
    agentCertPath,
    agentKeyPath,
    debug,
    logPath,
    project,
    instanceId,
    registry: registryConfig,
    workspaceDir,
    tmuxSession,
    tmuxWindow,
  };
}

let warnedFallback = false;

/**
 * Resolve the CA private-key path. Preferred source is the explicit
 * MACF_CA_KEY env var (#103 R3); falls back to the historical
 * `-cert.pem` → `-key.pem` swap on MACF_CA_CERT for workspaces that
 * haven't re-run `macf update` yet (claude.sh now emits MACF_CA_KEY).
 *
 * Edge case: if caCertPath doesn't literally contain `-cert.pem`,
 * `.replace()` silently returns the same string. That's the exact
 * failure mode this issue fixes — the fallback preserves the old
 * behavior for compat, but the explicit env is the only reliable
 * path going forward.
 */
function resolveCaKeyPath(caCertPath: string): string {
  const explicit = process.env['MACF_CA_KEY'];
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) {
      throw new ConfigError(`File not found for MACF_CA_KEY: ${explicit}`);
    }
    return explicit;
  }
  // Warn once per process so operators see their workspace is in legacy
  // mode. The structured logger isn't available this early in startup
  // (loadConfig runs before createLogger), so write directly to stderr.
  if (!warnedFallback) {
    warnedFallback = true;
    process.stderr.write(
      'Warning: MACF_CA_KEY not set; deriving from MACF_CA_CERT. ' +
      'This fallback is for legacy workspaces only — run `macf update` ' +
      'to regenerate claude.sh with the explicit MACF_CA_KEY export.\n',
    );
  }
  return caCertPath.replace('-cert.pem', '-key.pem');
}

function parseRegistryConfig(registryType: string): RegistryConfig {
  switch (registryType) {
    case 'org': {
      const org = process.env['MACF_REGISTRY_ORG'];
      if (!org) throw new ConfigError('MACF_REGISTRY_ORG is required when MACF_REGISTRY_TYPE=org');
      return { type: 'org', org };
    }
    case 'profile': {
      const user = process.env['MACF_REGISTRY_USER'];
      if (!user) throw new ConfigError('MACF_REGISTRY_USER is required when MACF_REGISTRY_TYPE=profile');
      return { type: 'profile', user };
    }
    case 'repo': {
      const scope = process.env['MACF_REGISTRY_REPO'] ?? 'groundnuty/macf';
      const parts = scope.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new ConfigError(`MACF_REGISTRY_REPO must be "owner/repo", got "${scope}"`);
      }
      return { type: 'repo', owner: parts[0], repo: parts[1] };
    }
    case 'local': {
      // DR-024 ships local-registry mode. The path is resolved at
      // `macf init --local` time (default: `~/.macf/registry/<project>.json`)
      // and exported into the channel-server env so this layer never
      // needs to expand `~` or guess the project. Fail-loud if absent —
      // DR-024 §"Decision rule for future PRs" 3 explicitly forbids
      // silent fallback to GitHub mode when local is requested.
      const filePath = process.env['MACF_REGISTRY_PATH'];
      if (!filePath) {
        throw new ConfigError(
          'MACF_REGISTRY_PATH is required when MACF_REGISTRY_TYPE=local. ' +
            'Run `macf init --local` to bootstrap, or set the env var explicitly.',
        );
      }
      return { type: 'local', path: filePath };
    }
    default:
      throw new ConfigError(
        `MACF_REGISTRY_TYPE must be "org", "profile", "repo", or "local", got "${registryType}"`,
      );
  }
}
