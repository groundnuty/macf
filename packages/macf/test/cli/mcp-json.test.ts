/**
 * Tests for `.mcp.json` channel-server mount writing (DR-022 Amendment P,
 * groundnuty/macf#995).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mcpJsonPath,
  channelServerOtelEnv,
  writeMcpJsonChannelServer,
  readMcpJsonChannelServerVersion,
  MCP_SERVER_NAME,
  CHANNEL_SERVER_PKG,
  DEFAULT_OTEL_ENDPOINT,
} from '../../src/cli/mcp-json.js';
import { generateClaudeSh } from '../../src/cli/claude-sh.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

const sampleConfig: MacfAgentConfig = {
  project: 'TEST',
  agent_name: 'code-agent',
  agent_role: 'code-agent',
  agent_type: 'permanent',
  registry: { type: 'repo', owner: 'o', repo: 'r' },
  github_app: {
    app_id: '12345',
    install_id: '67890',
    key_path: '.github-app-key.pem',
  },
  versions: { cli: '0.2.60', plugin: '0.2.60', actions: 'v3' },
};

function tempDir(): string {
  const dir = join(tmpdir(), `macf-mcp-json-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('mcpJsonPath', () => {
  it('returns <workspace>/.mcp.json', () => {
    expect(mcpJsonPath('/tmp/whatever')).toBe('/tmp/whatever/.mcp.json');
  });
});

describe('channelServerOtelEnv', () => {
  it('bakes the default endpoint when MACF_OTEL_ENDPOINT is unset', () => {
    const env = channelServerOtelEnv(sampleConfig, {});
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe(DEFAULT_OTEL_ENDPOINT);
  });

  it('bakes an operator-supplied MACF_OTEL_ENDPOINT override', () => {
    const env = channelServerOtelEnv(sampleConfig, { MACF_OTEL_ENDPOINT: 'http://custom:4318' });
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://custom:4318');
  });

  // health.ts::computeOtelEndpointInfo's endpoint_is_canonical self-report
  // compares these two — both must be present + equal.
  it('sets MACF_OTEL_ENDPOINT equal to OTEL_EXPORTER_OTLP_ENDPOINT (health.ts endpoint_is_canonical)', () => {
    const env = channelServerOtelEnv(sampleConfig, {});
    expect(env['MACF_OTEL_ENDPOINT']).toBe(env['OTEL_EXPORTER_OTLP_ENDPOINT']);
  });

  it('returns an empty object when MACF_OTEL_DISABLED=1 (macf#197 opt-out)', () => {
    expect(channelServerOtelEnv(sampleConfig, { MACF_OTEL_DISABLED: '1' })).toEqual({});
  });

  it('sets OTEL_SERVICE_NAME from agent_name', () => {
    const env = channelServerOtelEnv(sampleConfig, {});
    expect(env['OTEL_SERVICE_NAME']).toBe('macf-agent-code-agent');
  });

  it('resource attrs carry gen_ai.agent.name + gen_ai.agent.role', () => {
    const env = channelServerOtelEnv(sampleConfig, {});
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toContain('gen_ai.agent.name=code-agent');
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toContain('gen_ai.agent.role=code-agent');
  });

  it('bakes MACF_VERSION from config.versions.cli', () => {
    const env = channelServerOtelEnv(sampleConfig, {});
    expect(env['MACF_VERSION']).toBe('0.2.60');
  });

  it('rejects a shell-unsafe MACF_OTEL_ENDPOINT', () => {
    expect(() => channelServerOtelEnv(sampleConfig, { MACF_OTEL_ENDPOINT: 'http://x"; rm -rf /' })).toThrow(/shell-unsafe/);
  });

  it('never emits a token/credential-shaped key', () => {
    const env = channelServerOtelEnv(sampleConfig, {});
    const keys = Object.keys(env);
    expect(keys).not.toContain('GH_TOKEN');
    expect(keys.some((k) => /TOKEN|SECRET|KEY_PATH|APP_ID|INSTALL_ID/i.test(k))).toBe(false);
  });
});

describe('writeMcpJsonChannelServer', () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates a fresh .mcp.json with the pinned channel-server', () => {
    const result = writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    expect(result).toEqual({ status: 'written', changed: true, path: mcpJsonPath(dir) });

    const written = JSON.parse(readFileSync(mcpJsonPath(dir), 'utf-8'));
    expect(written.mcpServers[MCP_SERVER_NAME].command).toBe('npx');
    expect(written.mcpServers[MCP_SERVER_NAME].args).toEqual(['-y', `${CHANNEL_SERVER_PKG}@0.2.60`]);
  });

  // The decisive retrofit-adjacent case: an operator-authored .mcp.json with
  // OTHER servers must be merged into, never clobbered.
  it('merges into an existing .mcp.json with other servers, preserving them', () => {
    writeFileSync(
      mcpJsonPath(dir),
      JSON.stringify({ mcpServers: { 'my-other-tool': { command: 'node', args: ['other.js'] } } }, null, 2) + '\n',
    );

    const result = writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    expect(result.status).toBe('written');

    const written = JSON.parse(readFileSync(mcpJsonPath(dir), 'utf-8'));
    expect(written.mcpServers['my-other-tool']).toEqual({ command: 'node', args: ['other.js'] });
    expect(written.mcpServers[MCP_SERVER_NAME].command).toBe('npx');
  });

  it('preserves unrelated top-level keys in an existing .mcp.json', () => {
    writeFileSync(mcpJsonPath(dir), JSON.stringify({ someOperatorKey: 'keep-me', mcpServers: {} }, null, 2) + '\n');
    writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    const written = JSON.parse(readFileSync(mcpJsonPath(dir), 'utf-8'));
    expect(written.someOperatorKey).toBe('keep-me');
  });

  it('overwrites an already-present macf-agent entry (re-pin to a new version)', () => {
    writeMcpJsonChannelServer(dir, sampleConfig, '0.2.55', {});
    const result = writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    expect(result).toMatchObject({ status: 'written', changed: true });
    const written = JSON.parse(readFileSync(mcpJsonPath(dir), 'utf-8'));
    expect(written.mcpServers[MCP_SERVER_NAME].args).toEqual(['-y', `${CHANNEL_SERVER_PKG}@0.2.60`]);
  });

  it('is idempotent — a second write with the same inputs reports changed:false', () => {
    writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    const result = writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    expect(result).toEqual({ status: 'written', changed: false, path: mcpJsonPath(dir) });
  });

  it('refuses loudly on malformed JSON, writing nothing', () => {
    writeFileSync(mcpJsonPath(dir), '{ not valid json');
    const before = readFileSync(mcpJsonPath(dir), 'utf-8');
    const result = writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    expect(result.status).toBe('refused');
    expect(readFileSync(mcpJsonPath(dir), 'utf-8')).toBe(before);
  });

  it('refuses when the top-level content is not a JSON object (e.g. an array)', () => {
    writeFileSync(mcpJsonPath(dir), '[]');
    const result = writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    expect(result.status).toBe('refused');
  });

  it('refuses when mcpServers exists but is not an object', () => {
    writeFileSync(mcpJsonPath(dir), JSON.stringify({ mcpServers: 'not-an-object' }));
    const result = writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    expect(result.status).toBe('refused');
  });

  it('never writes a token/credential-shaped value into the file', () => {
    writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', { GH_TOKEN: 'ghs_shouldnotleak' });
    const raw = readFileSync(mcpJsonPath(dir), 'utf-8');
    expect(raw).not.toContain('ghs_shouldnotleak');
  });
});

describe('readMcpJsonChannelServerVersion', () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns null when .mcp.json is absent', () => {
    expect(readMcpJsonChannelServerVersion(dir)).toBeNull();
  });

  it('agrees with what writeMcpJsonChannelServer just wrote (write/read-back round-trip)', () => {
    writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    expect(readMcpJsonChannelServerVersion(dir)).toBe('0.2.60');
  });

  it('returns null for a non-npx command entry', () => {
    writeFileSync(
      mcpJsonPath(dir),
      JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: ['server.js'] } } }),
    );
    expect(readMcpJsonChannelServerVersion(dir)).toBeNull();
  });

  it('returns null when there is no macf-agent entry at all', () => {
    writeFileSync(mcpJsonPath(dir), JSON.stringify({ mcpServers: { 'other-tool': { command: 'node', args: [] } } }));
    expect(readMcpJsonChannelServerVersion(dir)).toBeNull();
  });
});

// Coordinator directive (2026-08-19): the flag half (claude.sh) and the
// mount half (.mcp.json) must be checked AGAINST EACH OTHER in one relation
// test, not as two independent assertions — splitting them is exactly how
// this issue's bug was born (the flag shipped in June; the mount never did).
describe('launcher flag <-> .mcp.json mount consistency (DR-022 Amendment P, groundnuty/macf#995)', () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("the launcher's server:<name> argument equals a key macf init writes to .mcp.json", () => {
    const launcherScript = generateClaudeSh(sampleConfig);
    const match = launcherScript.match(/--dangerously-load-development-channels server:([\w-]+)/);
    expect(match).not.toBeNull();
    const flagServerName = match![1];

    writeMcpJsonChannelServer(dir, sampleConfig, '0.2.60', {});
    const written = JSON.parse(readFileSync(mcpJsonPath(dir), 'utf-8')) as { mcpServers: Record<string, unknown> };

    expect(Object.keys(written.mcpServers)).toContain(flagServerName);
  });
});
