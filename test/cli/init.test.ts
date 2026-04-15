import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initAgent } from '../../src/cli/commands/init.js';
import { readAgentConfig } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('macf init', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates .macf directory structure', async () => {
    await initAgent(dir, {
      project: 'TEST',
      role: 'code-agent',
      appId: '123',
      installId: '456',
      keyPath: '.key.pem',
      registryType: 'repo',
      registryRepo: 'owner/repo',
    });

    expect(existsSync(join(dir, '.macf'))).toBe(true);
    expect(existsSync(join(dir, '.macf', 'certs'))).toBe(true);
    expect(existsSync(join(dir, '.macf', 'logs'))).toBe(true);
    expect(existsSync(join(dir, '.macf', 'plugin'))).toBe(true);
  });

  it('writes macf-agent.json with correct content', async () => {
    await initAgent(dir, {
      project: 'MACF',
      role: 'science-agent',
      name: 'my-agent',
      appId: '111',
      installId: '222',
      keyPath: 'app.pem',
      registryType: 'org',
      registryOrg: 'my-org',
    });

    const config = readAgentConfig(dir);
    expect(config).not.toBeNull();
    expect(config!.agent_name).toBe('my-agent');
    expect(config!.agent_role).toBe('science-agent');
    expect(config!.project).toBe('MACF');
    expect(config!.registry).toEqual({ type: 'org', org: 'my-org' });
  });

  it('defaults agent name to role', async () => {
    await initAgent(dir, {
      project: 'P',
      role: 'code-agent',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const config = readAgentConfig(dir);
    expect(config!.agent_name).toBe('code-agent');
  });

  it('generates claude.sh', async () => {
    await initAgent(dir, {
      project: 'TEST',
      role: 'agent',
      appId: '1',
      installId: '2',
      keyPath: 'k.pem',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const claudeSh = join(dir, 'claude.sh');
    expect(existsSync(claudeSh)).toBe(true);
    const content = readFileSync(claudeSh, 'utf-8');
    expect(content).toContain('MACF_AGENT_NAME="agent"');
    expect(content).toContain('exec claude');
    // Per-project CA path (PR #36)
    expect(content).toContain('MACF_CA_CERT="$HOME/.macf/certs/TEST/ca-cert.pem"');
  });

  it('adds .macf/ to .gitignore', async () => {
    await initAgent(dir, {
      project: 'T',
      role: 'a',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.macf/');
  });

  it('does not duplicate .macf/ in existing .gitignore', async () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(dir, '.gitignore'), '.macf/\nnode_modules/\n');

    await initAgent(dir, {
      project: 'T',
      role: 'a',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/\.macf\//g);
    expect(matches).toHaveLength(1);
  });

  it('rejects missing required registry options', async () => {
    await expect(initAgent(dir, {
      project: 'T',
      role: 'a',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'org',
      // missing registryOrg
    })).rejects.toThrow('--registry-org');
  });

  it('supports profile registry type', async () => {
    await initAgent(dir, {
      project: 'T',
      role: 'a',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'profile',
      registryUser: 'groundnuty',
    });

    const config = readAgentConfig(dir);
    expect(config!.registry).toEqual({ type: 'profile', user: 'groundnuty' });
  });
});
