import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

// We need real cert files for the file-exists check.
// Use package.json as a stand-in for "file that exists".
const EXISTING_FILE = resolve(import.meta.dirname, '..', 'package.json');

function setMinimalEnv(): void {
  process.env['MACF_AGENT_NAME'] = 'test-agent';
  process.env['MACF_CA_CERT'] = EXISTING_FILE;
  process.env['MACF_AGENT_CERT'] = EXISTING_FILE;
  process.env['MACF_AGENT_KEY'] = EXISTING_FILE;
}

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all MACF_ vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MACF_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('loads minimal valid config with defaults', () => {
    setMinimalEnv();
    const config = loadConfig();
    expect(config.agentName).toBe('test-agent');
    expect(config.agentType).toBe('permanent');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(0);
    expect(config.debug).toBe(false);
    expect(config.logPath).toBeUndefined();
  });

  it('loads full config from env', () => {
    setMinimalEnv();
    process.env['MACF_PORT'] = '8847';
    process.env['MACF_HOST'] = '127.0.0.1';
    process.env['MACF_AGENT_TYPE'] = 'worker';
    process.env['MACF_DEBUG'] = 'true';
    process.env['MACF_LOG_PATH'] = '/tmp/test.log';

    const config = loadConfig();
    expect(config.port).toBe(8847);
    expect(config.host).toBe('127.0.0.1');
    expect(config.agentType).toBe('worker');
    expect(config.debug).toBe(true);
    expect(config.logPath).toBe('/tmp/test.log');
  });

  it('throws on missing MACF_AGENT_NAME', () => {
    process.env['MACF_CA_CERT'] = EXISTING_FILE;
    process.env['MACF_AGENT_CERT'] = EXISTING_FILE;
    process.env['MACF_AGENT_KEY'] = EXISTING_FILE;

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('MACF_AGENT_NAME');
  });

  it('throws on missing cert file', () => {
    setMinimalEnv();
    process.env['MACF_CA_CERT'] = '/nonexistent/ca-cert.pem';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('File not found');
  });

  it('throws on invalid agent type', () => {
    setMinimalEnv();
    process.env['MACF_AGENT_TYPE'] = 'invalid';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('permanent');
  });

  it('throws on invalid port', () => {
    setMinimalEnv();
    process.env['MACF_PORT'] = '99999';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('0-65535');
  });

  it('throws on non-numeric port', () => {
    setMinimalEnv();
    process.env['MACF_PORT'] = 'abc';

    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('accepts debug=1', () => {
    setMinimalEnv();
    process.env['MACF_DEBUG'] = '1';

    const config = loadConfig();
    expect(config.debug).toBe(true);
  });

  it('treats empty MACF_LOG_PATH as undefined', () => {
    setMinimalEnv();
    process.env['MACF_LOG_PATH'] = '';

    const config = loadConfig();
    expect(config.logPath).toBeUndefined();
  });

  // P2: Registry config tests
  it('defaults to repo registry with groundnuty/macf', () => {
    setMinimalEnv();
    const config = loadConfig();
    expect(config.registry).toEqual({ type: 'repo', owner: 'groundnuty', repo: 'macf' });
  });

  it('defaults project to MACF', () => {
    setMinimalEnv();
    const config = loadConfig();
    expect(config.project).toBe('MACF');
  });

  it('defaults agentRole to agentName', () => {
    setMinimalEnv();
    const config = loadConfig();
    expect(config.agentRole).toBe('test-agent');
  });

  it('generates a 6-char hex instanceId', () => {
    setMinimalEnv();
    const config = loadConfig();
    expect(config.instanceId).toMatch(/^[0-9a-f]{6}$/);
  });

  it('parses org registry config', () => {
    setMinimalEnv();
    process.env['MACF_REGISTRY_TYPE'] = 'org';
    process.env['MACF_REGISTRY_ORG'] = 'my-org';

    const config = loadConfig();
    expect(config.registry).toEqual({ type: 'org', org: 'my-org' });
  });

  it('throws when org registry missing MACF_REGISTRY_ORG', () => {
    setMinimalEnv();
    process.env['MACF_REGISTRY_TYPE'] = 'org';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('MACF_REGISTRY_ORG');
  });

  it('parses profile registry config', () => {
    setMinimalEnv();
    process.env['MACF_REGISTRY_TYPE'] = 'profile';
    process.env['MACF_REGISTRY_USER'] = 'groundnuty';

    const config = loadConfig();
    expect(config.registry).toEqual({ type: 'profile', user: 'groundnuty' });
  });

  it('throws when profile registry missing MACF_REGISTRY_USER', () => {
    setMinimalEnv();
    process.env['MACF_REGISTRY_TYPE'] = 'profile';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('MACF_REGISTRY_USER');
  });

  it('parses repo registry config from env', () => {
    setMinimalEnv();
    process.env['MACF_REGISTRY_TYPE'] = 'repo';
    process.env['MACF_REGISTRY_REPO'] = 'other-owner/other-repo';

    const config = loadConfig();
    expect(config.registry).toEqual({ type: 'repo', owner: 'other-owner', repo: 'other-repo' });
  });

  it('throws on invalid repo format', () => {
    setMinimalEnv();
    process.env['MACF_REGISTRY_TYPE'] = 'repo';
    process.env['MACF_REGISTRY_REPO'] = 'no-slash';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('owner/repo');
  });

  it('throws on unknown registry type', () => {
    setMinimalEnv();
    process.env['MACF_REGISTRY_TYPE'] = 'invalid';

    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow('"org", "profile", or "repo"');
  });

  it('reads custom project prefix', () => {
    setMinimalEnv();
    process.env['MACF_PROJECT'] = 'CPC';

    const config = loadConfig();
    expect(config.project).toBe('CPC');
  });

  it('reads custom agent role', () => {
    setMinimalEnv();
    process.env['MACF_AGENT_ROLE'] = 'code-agent';

    const config = loadConfig();
    expect(config.agentRole).toBe('code-agent');
  });

  it('defaults advertiseHost to 127.0.0.1 when host is 0.0.0.0', () => {
    setMinimalEnv();
    const config = loadConfig();
    expect(config.host).toBe('0.0.0.0');
    expect(config.advertiseHost).toBe('127.0.0.1');
  });

  it('uses host as advertiseHost when host is specific', () => {
    setMinimalEnv();
    process.env['MACF_HOST'] = '100.86.5.117';
    const config = loadConfig();
    expect(config.advertiseHost).toBe('100.86.5.117');
  });

  it('reads explicit MACF_ADVERTISE_HOST', () => {
    setMinimalEnv();
    process.env['MACF_ADVERTISE_HOST'] = '10.0.0.1';
    const config = loadConfig();
    expect(config.advertiseHost).toBe('10.0.0.1');
  });
});
