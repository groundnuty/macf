import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  writeAgentConfig, readAgentConfig, writeAgentsIndex, readAgentsIndex,
  addToAgentsIndex, loadAllAgents, loadAllAgentsWithCwdFallback, agentConfigPath,
  resolveCanonicalBranch, DEFAULT_CANONICAL_BRANCH, AGENTS_INDEX_PATH,
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
      // Pre-existing lint fix (unrelated to #959): use the top-level ESM
      // import (now in scope for the #959 tests below) instead of a
      // require() — @typescript-eslint/no-require-imports.
      writeFileSync(path, '{"invalid": true}');
      expect(readAgentConfig(dir)).toBeNull();
    });

    it('returns null (never throws) for a present-but-malformed-JSON config (macf#894)', () => {
      // A present-but-unparsable config used to throw an uncaught SyntaxError
      // straight out of readAgentConfig, crashing every --dir-taking command
      // that reads config through this shared function. It must degrade the
      // same way a schema-invalid config already does above: warn, return
      // null, never throw.
      const path = agentConfigPath(dir);
      mkdirSync(join(dir, '.macf'), { recursive: true });
      writeFileSync(path, '{ this is not json at all');
      expect(() => readAgentConfig(dir)).not.toThrow();
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

  // #959: `loadAllAgentsWithCwdFallback` is the fix for `macf peers`/`macf
  // status` misreporting "No agents configured" on a workspace whose
  // .macf/macf-agent.json exists but never made it into the global index.
  // These tests temporarily replace the REAL ~/.macf/agents.json (backed up
  // + restored) so the index side of the picture is fully controlled —
  // loadAllAgents() has no injectable seam for it (see the note above), and
  // this machine's real index carries leftover entries from other test
  // runs that would otherwise make these assertions non-hermetic.
  describe('loadAllAgentsWithCwdFallback (#959)', () => {
    let hadIndex: boolean;
    let originalIndexBytes: string | null = null;

    beforeEach(() => {
      hadIndex = existsSync(AGENTS_INDEX_PATH);
      originalIndexBytes = hadIndex ? readFileSync(AGENTS_INDEX_PATH, 'utf-8') : null;
      writeAgentsIndex({ agents: [] });
    });

    afterEach(() => {
      if (hadIndex && originalIndexBytes !== null) {
        writeFileSync(AGENTS_INDEX_PATH, originalIndexBytes);
      } else if (existsSync(AGENTS_INDEX_PATH)) {
        unlinkSync(AGENTS_INDEX_PATH);
      }
    });

    it('includes a cwd-discovered project the index does not know about', () => {
      writeAgentConfig(dir, sampleConfig);

      const agents = loadAllAgentsWithCwdFallback(dir);

      expect(agents.some((a) => resolve(a.path) === resolve(dir))).toBe(true);
    });

    it('walks up from a nested subdirectory to find the project root', () => {
      writeAgentConfig(dir, sampleConfig);
      const nested = join(dir, 'deeply', 'nested');
      mkdirSync(nested, { recursive: true });

      const agents = loadAllAgentsWithCwdFallback(nested);

      expect(agents.some((a) => resolve(a.path) === resolve(dir))).toBe(true);
    });

    it('does not duplicate an entry already present via the index', () => {
      writeAgentConfig(dir, sampleConfig);
      addToAgentsIndex(dir);

      const agents = loadAllAgentsWithCwdFallback(dir);

      expect(agents.filter((a) => resolve(a.path) === resolve(dir))).toHaveLength(1);
    });

    it('falls through to the (empty) index when cwd has no project', () => {
      const agents = loadAllAgentsWithCwdFallback(dir); // dir has no .macf/ written
      expect(agents).toEqual([]);
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
