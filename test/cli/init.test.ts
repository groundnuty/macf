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

  describe('input validation (#105)', () => {
    // claude.sh embeds appId / installId / keyPath / project into a
    // shell double-quoted string via template literal. Validate at
    // init so bad inputs are rejected before any workspace state is
    // written, not caught later when claude.sh is run and fails
    // opaquely.

    const validBase = {
      project: 'T',
      role: 'a',
      appId: '12345',
      installId: '67890',
      keyPath: 'app.key.pem',
      registryType: 'repo',
      registryRepo: 'o/r',
    } as const;

    it('rejects non-numeric appId', async () => {
      await expect(initAgent(dir, { ...validBase, appId: '123abc' }))
        .rejects.toThrow(/appId.*numeric|numeric.*appId/i);
    });

    it('rejects appId with shell-special chars', async () => {
      await expect(initAgent(dir, { ...validBase, appId: '123"$x' }))
        .rejects.toThrow(/appId/);
    });

    it('rejects empty appId', async () => {
      await expect(initAgent(dir, { ...validBase, appId: '' }))
        .rejects.toThrow(/appId/);
    });

    it('rejects non-numeric installId', async () => {
      await expect(initAgent(dir, { ...validBase, installId: 'abc' }))
        .rejects.toThrow(/installId.*numeric|numeric.*installId/i);
    });

    it('rejects keyPath with double-quote', async () => {
      await expect(initAgent(dir, { ...validBase, keyPath: 'path"injection' }))
        .rejects.toThrow(/keyPath/);
    });

    it('rejects keyPath with $', async () => {
      await expect(initAgent(dir, { ...validBase, keyPath: 'path$HOME/evil' }))
        .rejects.toThrow(/keyPath/);
    });

    it('rejects keyPath with backtick', async () => {
      await expect(initAgent(dir, { ...validBase, keyPath: 'path`cmd`' }))
        .rejects.toThrow(/keyPath/);
    });

    it('rejects keyPath with newline', async () => {
      await expect(initAgent(dir, { ...validBase, keyPath: 'path\nextra' }))
        .rejects.toThrow(/keyPath/);
    });

    it('rejects project with slash', async () => {
      await expect(initAgent(dir, { ...validBase, project: 'bad/name' }))
        .rejects.toThrow(/project/);
    });

    it('rejects project with shell-special char', async () => {
      await expect(initAgent(dir, { ...validBase, project: 'bad$name' }))
        .rejects.toThrow(/project/);
    });

    it('accepts realistic valid inputs', async () => {
      // Normal GitHub App IDs, a relative key path, a typical project name.
      await initAgent(dir, { ...validBase });
      const config = readAgentConfig(dir);
      expect(config).not.toBeNull();
      expect(config!.github_app.app_id).toBe('12345');
      expect(config!.github_app.install_id).toBe('67890');
      expect(config!.github_app.key_path).toBe('app.key.pem');
    });

    it('accepts keyPath with dots, hyphens, underscores, slashes', async () => {
      // Normal absolute / nested paths must not be rejected.
      await initAgent(dir, {
        ...validBase,
        keyPath: '/absolute/path/to/my-app.key_2.pem',
      });
      const config = readAgentConfig(dir);
      expect(config!.github_app.key_path).toBe('/absolute/path/to/my-app.key_2.pem');
    });

    it('rejects before writing any workspace state', async () => {
      await expect(initAgent(dir, { ...validBase, appId: 'bad' }))
        .rejects.toThrow();
      // No .macf/ or claude.sh should exist — validation must run
      // before any mkdir/writeFile.
      expect(existsSync(join(dir, '.macf'))).toBe(false);
      expect(existsSync(join(dir, 'claude.sh'))).toBe(false);
    });
  });
});
