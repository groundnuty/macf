/**
 * Write/refresh `<workspace>/.mcp.json` — the channel-server's project-scoped
 * MCP server mount (DR-022 Amendment P, groundnuty/macf#995).
 *
 * **Why this file exists at all.** Amendment P (ratified 2026-06-28,
 * spike-proven `macf#641`) found that native Claude Code channel-push NEVER
 * worked for any macf agent: a `--plugin-dir`-mounted plugin's channel id is
 * `plugin:<name>:<server>`, and the `--dangerously-load-development-channels`
 * dev-flag (the only form that loads a non-allowlisted channel) REJECTS that
 * colon-triple form — it only resolves a manual `.mcp.json` `server:<name>`
 * entry. `claude.sh` has emitted `--dangerously-load-development-channels
 * server:macf-agent` since macf#632, but nothing ever wrote the `.mcp.json`
 * that flag needs — see `channelNotificationsLines` in `claude-sh.ts`. This
 * module is the missing write side (groundnuty/macf#995).
 *
 * **Merge-not-clobber contract:** `.mcp.json` is a project file an operator
 * may already have authored (other MCP servers for their own tooling). This
 * module reads the existing file (default `{}`), merges/overwrites ONLY the
 * `mcpServers.macf-agent` key, and preserves every other key untouched.
 * Malformed JSON refuses loudly (never silently discarded) — same posture as
 * `settings-writer.ts::readSettings`.
 *
 * **OTEL env is baked, not shell-expanded (groundnuty/macf#422).** Env does
 * NOT inherit across the MCP stdio spawn boundary — a `.mcp.json` server's
 * `env` map is passed to `child_process.spawn` as literal strings; there is
 * no verified Claude Code support for `${VAR}` shell-expansion inside it (and
 * inventing that support would risk emitting a literal `${VAR}` string as the
 * OTLP endpoint — an Instance-8-shaped silent telemetry drop with no error at
 * any layer, silent-fallback-hazards.md). So the values here are RESOLVED at
 * `macf init`/`macf update` time from `MacfAgentConfig` + the calling shell's
 * env, mirroring the already-established template-time-resolution convention
 * `claude-sh.ts::otelTelemetryLines` / `env-files.ts::generateEnvTelemetry`
 * use for the same `MACF_OTEL_ENDPOINT` knob. Only the 3 vars the
 * channel-server's own `bootstrapOtel()` actually reads
 * (`packages/macf-channel-server/src/otel.ts`) plus the 2 vars its `/health`
 * self-report compares (`packages/macf-channel-server/src/health.ts
 * ::computeOtelEndpointInfo` — `endpoint_is_canonical` needs BOTH
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and `MACF_OTEL_ENDPOINT` present) are
 * written — never a token, an App ID, or a key path (this file is committed
 * to the workspace, not gitignored secret state).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { MacfAgentConfig } from './config.js';

/** The channel-server npm package the `.mcp.json` entry launches via npx. */
export const CHANNEL_SERVER_PKG = '@groundnuty/macf-channel-server';

/** The `.mcp.json` `mcpServers` key + the launcher flag's `server:<name>` value. */
export const MCP_SERVER_NAME = 'macf-agent';

/**
 * Default OTLP endpoint baked when `MACF_OTEL_ENDPOINT` is unset at
 * `macf init`/`update` time — the dedicated monitoring VM over Tailscale
 * (macf#516). Kept in lockstep BY HAND with the same literal in
 * `claude-sh.ts::otelTelemetryLines` and `env-files.ts::generateEnvTelemetry`
 * — those two already tolerate manual duplication (each cites the other in
 * its own doc comment) rather than a shared constant, so a third copy here
 * follows the established convention instead of introducing a new one.
 */
export const DEFAULT_OTEL_ENDPOINT = 'http://orzech-dev-agents-monitoring.tail491af.ts.net:4318';

export function mcpJsonPath(workspaceDir: string): string {
  return join(workspaceDir, '.mcp.json');
}

/**
 * Resolve the channel-server's OTEL env block for `.mcp.json`'s `env` map.
 * Empty object when `MACF_OTEL_DISABLED` is set — mirrors
 * `otelTelemetryLines`'s "omit the block entirely" opt-out (macf#197) so a
 * deployment without an observability stack doesn't get retry-spam baked
 * into every agent's channel-server child.
 *
 * `env` defaults to `process.env`; tests inject a fake (same convention as
 * `otelTelemetryLines` / `generateEnvTelemetry`).
 */
export function channelServerOtelEnv(
  config: MacfAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (env['MACF_OTEL_DISABLED'] === '1' || env['MACF_OTEL_DISABLED'] === 'true') {
    return {};
  }

  const endpoint = env['MACF_OTEL_ENDPOINT'] ?? DEFAULT_OTEL_ENDPOINT;

  // Same shell-unsafe-char rejection as otelTelemetryLines/generateEnvTelemetry.
  // Not strictly load-bearing here (this value lands in a JSON string, not a
  // shell export), but a value that would be rejected as unsafe there is
  // equally a sign of operator typo/misconfiguration here — fail the same way
  // rather than silently accepting a value the shell-side generators reject.
  if (/["$`\\\n\r]/.test(endpoint)) {
    throw new Error(
      `MACF_OTEL_ENDPOINT contains a shell-unsafe character. ` +
        `Got: ${JSON.stringify(endpoint)}. ` +
        `Expected a plain URL like http://host:port.`,
    );
  }

  const host = hostname();
  // Mirrors env-files.ts::generateEnvTelemetry's resourceAttrs list
  // (macf#357), baked to literal values instead of `${VAR}` shell expansion
  // — see the module doc comment for why. `host.name` / `service.instance.id`
  // resolve `hostname()` once at write time (macf init/update), not per
  // channel-server launch — a real (documented) limitation vs the shell
  // form's `$(hostname -s)`, which re-resolves every launch; acceptable
  // because these VMs' hostnames are stable in practice.
  const resourceAttrs = [
    `service.namespace=${config.project}`,
    `service.version=${config.versions?.cli ?? 'unknown'}`,
    `service.instance.id=${config.project}-${config.agent_name}@${host}`,
    `host.name=${host}`,
    `gen_ai.agent.name=${config.agent_name}`,
    `gen_ai.agent.role=${config.agent_role}`,
    'macf.framework=macf',
    `macf.agent.type=${config.agent_type}`,
    `macf.registry.type=${config.registry.type}`,
  ].join(',');

  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    // health.ts::computeOtelEndpointInfo's endpoint_is_canonical self-report
    // compares OTEL_EXPORTER_OTLP_ENDPOINT against MACF_OTEL_ENDPOINT — both
    // must be present + equal for the channel-server's own /health to report
    // canonical truthfully.
    MACF_OTEL_ENDPOINT: endpoint,
    OTEL_SERVICE_NAME: `macf-agent-${config.agent_name}`,
    OTEL_RESOURCE_ATTRIBUTES: resourceAttrs,
    MACF_VERSION: config.versions?.cli ?? 'unknown',
  };
}

/** The exact `.mcp.json` server entry shape this module writes/reads. */
interface ChannelServerMcpSpec {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

function buildChannelServerSpec(
  config: MacfAgentConfig,
  version: string,
  env: NodeJS.ProcessEnv,
): ChannelServerMcpSpec {
  return {
    command: 'npx',
    args: ['-y', `${CHANNEL_SERVER_PKG}@${version}`],
    env: channelServerOtelEnv(config, env),
  };
}

/** Loosely-typed `.mcp.json` shape — preserves unknown top-level + sibling-server keys verbatim. */
type McpJsonFile = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

export type McpJsonWriteResult =
  | { readonly status: 'written'; readonly changed: boolean; readonly path: string }
  | { readonly status: 'refused'; readonly reason: string; readonly path: string };

/**
 * Write (or merge-refresh) the `macf-agent` entry into `<workspaceDir>/.mcp.json`.
 *
 * Merge semantics (groundnuty/macf#995 — "refuse loudly rather than
 * overwrite something you did not write"):
 *   - File absent → create fresh with just `{ mcpServers: { macf-agent: spec } }`.
 *   - File present, valid JSON object, `mcpServers` absent or an object →
 *     merge the `macf-agent` key in (overwrite THAT key only — it is the
 *     macf-managed key by name, same contract as the managed `env.*` files);
 *     every other top-level key AND every other `mcpServers.<name>` key is
 *     preserved verbatim.
 *   - File present but NOT parseable JSON, OR top-level is not an object, OR
 *     `mcpServers` exists but is not an object → REFUSE (status: 'refused'),
 *     write nothing. Callers warn-and-continue (same posture as a plugin
 *     fetch failure) rather than aborting the whole init/update run.
 *
 * `changed` is false when the write would be byte-identical to what's
 * already on disk (idempotent no-op — e.g. a `macf update` with no version
 * bump against an already-current `.mcp.json`).
 */
/** Parse+validate result for `readExistingMcpJson` — the read half of the merge-not-clobber contract. */
type ParsedMcpJson =
  | { readonly ok: true; readonly parsed: McpJsonFile }
  | { readonly ok: false; readonly reason: string };

/**
 * Read + validate an existing `.mcp.json` for merging. Absent file → empty
 * object (nothing to merge into). Refuses (never throws) on anything this
 * tool didn't write: unreadable, malformed JSON, non-object top-level, or an
 * `mcpServers` key that isn't an object — "refuse loudly rather than
 * overwrite something you did not write" (groundnuty/macf#995).
 */
function readExistingMcpJson(path: string): ParsedMcpJson {
  if (!existsSync(path)) return { ok: true, parsed: {} };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `cannot read ${path}: ${msg}` };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `${path} is not valid JSON: ${msg}. Fix by hand, then re-run.` };
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {
      ok: false,
      reason: `${path} top-level content is not a JSON object — refusing to overwrite content this tool didn't write.`,
    };
  }

  const parsed = candidate as McpJsonFile;
  const servers = parsed.mcpServers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    return {
      ok: false,
      reason: `${path} has a "mcpServers" key that isn't an object — refusing to overwrite content this tool didn't write.`,
    };
  }
  return { ok: true, parsed };
}

export function writeMcpJsonChannelServer(
  workspaceDir: string,
  config: MacfAgentConfig,
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): McpJsonWriteResult {
  const path = mcpJsonPath(workspaceDir);

  const existing = readExistingMcpJson(path);
  if (!existing.ok) return { status: 'refused', reason: existing.reason, path };

  const spec = buildChannelServerSpec(config, version, env);
  const nextServers = { ...(existing.parsed.mcpServers ?? {}), [MCP_SERVER_NAME]: spec };
  const next: McpJsonFile = { ...existing.parsed, mcpServers: nextServers };
  const nextText = JSON.stringify(next, null, 2) + '\n';

  const priorText = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  if (priorText === nextText) {
    return { status: 'written', changed: false, path };
  }

  writeFileSync(path, nextText);
  return { status: 'written', changed: true, path };
}

/**
 * Read back the channel-server version pinned in `<workspaceDir>/.mcp.json`'s
 * `mcpServers.macf-agent` entry — the read-back half of
 * `writeMcpJsonChannelServer`'s write, mirroring the retired
 * `readPinnedChannelServerVersion`'s Pattern-A role (macf#889) but pointed at
 * the new mount (macf#995). Used as `macf update`'s post-write verification
 * AND as `vm-driver.ts`'s `readLaunchPin` seam (macf#899's stale-pin
 * discrimination reads the exact same "launch pin" this returns).
 *
 * Returns `null` when there's nothing to compare — file absent/malformed, no
 * `mcpServers`, no `macf-agent` entry, a non-npx command, or no
 * version-pinned arg. Unlike the retired plugin-manifest reader, there is no
 * "mount undeterminable" case here — `.mcp.json` always lives at a fixed
 * path (`<workspaceDir>/.mcp.json`), independent of which `--plugin-dir`
 * variant is mounted.
 */
export function readMcpJsonChannelServerVersion(workspaceDir: string): string | null {
  const path = mcpJsonPath(workspaceDir);
  if (!existsSync(path)) return null;
  let parsed: McpJsonFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as McpJsonFile;
  } catch {
    return null;
  }
  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== 'object') return null;
  const entry = (servers as Record<string, unknown>)[MCP_SERVER_NAME];
  if (!entry || typeof entry !== 'object') return null;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  if (command !== 'npx' || !Array.isArray(args)) return null;
  for (const arg of args) {
    if (typeof arg === 'string' && arg.startsWith(`${CHANNEL_SERVER_PKG}@`)) {
      return arg.slice(CHANNEL_SERVER_PKG.length + 1);
    }
  }
  return null;
}
