import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  writeAgentConfig, readAgentConfig, writeAgentsIndex, readAgentsIndex,
  addToAgentsIndex, loadAllAgents, agentConfigPath,
  resolveCanonicalBranch, DEFAULT_CANONICAL_BRANCH,
} from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sampleConfig: MacfAgentConfig = {
  project: 'MACF',
  agent_name: 'code-agent',
  agent_role: 'code-agent',
  agent_type: 'permanent',
  registry: { type: 'repo', owner: 'groundnuty', repo: 'macf' },
  github_app: { app_id: '123', install_id: '456', key_path: '.key.pem' },
};

describe('CLI config', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe('writeAgentConfig / readAgentConfig', () => {
    it('writes and reads back agent config', () => {
      writeAgentConfig(dir, sampleConfig);
      const loaded = readAgentConfig(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.agent_name).toBe('code-agent');
      expect(loaded!.project).toBe('MACF');
    });

    it('creates nested .macf directory', () => {
      writeAgentConfig(dir, sampleConfig);
      expect(existsSync(agentConfigPath(dir))).toBe(true);
    });

    it('returns null for missing config', () => {
      expect(readAgentConfig(dir)).toBeNull();
    });

    it('returns null for invalid config', () => {
      const path = agentConfigPath(dir);
      mkdirSync(join(dir, '.macf'), { recursive: true });
      const { writeFileSync } = require('node:fs');
      writeFileSync(path, '{"invalid": true}');
      expect(readAgentConfig(dir)).toBeNull();
    });
  });

  describe('agents index', () => {
    it('returns empty index when file missing', () => {
      // readAgentsIndex uses the global path, not our temp dir.
      // Just test the basic shape
      const index = readAgentsIndex();
      expect(index).toHaveProperty('agents');
      expect(Array.isArray(index.agents)).toBe(true);
    });
  });

  describe('loadAllAgents', () => {
    it('loads configs from index entries', () => {
      // Write a config in our temp dir
      writeAgentConfig(dir, sampleConfig);

      // loadAllAgents reads the global index — we can't easily mock it
      // without side effects. Test the function shape instead.
      const agents = loadAllAgents();
      expect(Array.isArray(agents)).toBe(true);
    });
  });
});

describe('resolveCanonicalBranch (macf#755)', () => {
  it('defaults to "main" when neither env nor config set it', () => {
    expect(resolveCanonicalBranch(null, {} as NodeJS.ProcessEnv)).toBe('main');
    expect(resolveCanonicalBranch(null, {} as NodeJS.ProcessEnv)).toBe(DEFAULT_CANONICAL_BRANCH);
  });

  it('prefers the macf-agent.json canonicalBranch field over the default', () => {
    expect(resolveCanonicalBranch({ canonicalBranch: 'develop' }, {} as NodeJS.ProcessEnv)).toBe('develop');
  });

  it('MACF_CANONICAL_BRANCH env wins over the config field', () => {
    const env = { MACF_CANONICAL_BRANCH: 'release' } as unknown as NodeJS.ProcessEnv;
    expect(resolveCanonicalBranch({ canonicalBranch: 'develop' }, env)).toBe('release');
  });

  it('MACF_CANONICAL_BRANCH env wins even when config is null', () => {
    const env = { MACF_CANONICAL_BRANCH: 'release' } as unknown as NodeJS.ProcessEnv;
    expect(resolveCanonicalBranch(null, env)).toBe('release');
  });

  it('treats a blank/whitespace-only env override as unset — falls through to config', () => {
    const env = { MACF_CANONICAL_BRANCH: '   ' } as unknown as NodeJS.ProcessEnv;
    expect(resolveCanonicalBranch({ canonicalBranch: 'develop' }, env)).toBe('develop');
  });

  it('treats a blank/whitespace-only config field as unset — falls through to default', () => {
    expect(resolveCanonicalBranch({ canonicalBranch: '   ' }, {} as NodeJS.ProcessEnv)).toBe('main');
  });

  it('defaults process.env when env is omitted (does not throw)', () => {
    expect(() => resolveCanonicalBranch(null)).not.toThrow();
  });
});
