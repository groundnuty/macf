/**
 * Tests for the project-tier rule distribution (groundnuty/macf#501, DR-026 F3).
 *
 * Covers: source parsing (github vs local vs unset vs malformed), the seed
 * (.example) template, local-dir fetch, github fetch (against a local bare git
 * repo standing in for a remote — no network), the unset no-op, and the
 * no-shadow invariant (project rules never touch the universal .claude/rules/).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseProjectRulesSource,
  fetchProjectRules,
  seedProjectRulesDir,
  projectRuleSeedContent,
  workspaceProjectRulesDir,
  PROJECT_RULE_SEED_NAME,
  PROJECT_RULES_SOURCE_ENV,
} from '../../src/cli/project-rules.js';

// ---------------------------------------------------------------------------
// parseProjectRulesSource
// ---------------------------------------------------------------------------

describe('parseProjectRulesSource', () => {
  it('returns undefined for unset / empty / whitespace', () => {
    expect(parseProjectRulesSource(undefined)).toBeUndefined();
    expect(parseProjectRulesSource('')).toBeUndefined();
    expect(parseProjectRulesSource('   ')).toBeUndefined();
  });

  it('parses <owner>/<repo>//<path> as a github source', () => {
    const s = parseProjectRulesSource('groundnuty/macf//project-rules');
    expect(s).toEqual({ kind: 'github', owner: 'groundnuty', repo: 'macf', subpath: 'project-rules' });
  });

  it('strips surrounding slashes from the subpath', () => {
    const s = parseProjectRulesSource('o/r//sub/dir/');
    expect(s).toEqual({ kind: 'github', owner: 'o', repo: 'r', subpath: 'sub/dir' });
  });

  it('parses a path without // as a local directory', () => {
    expect(parseProjectRulesSource('/abs/path/to/rules')).toEqual({ kind: 'local', dir: '/abs/path/to/rules' });
    expect(parseProjectRulesSource('relative/rules')).toEqual({ kind: 'local', dir: 'relative/rules' });
  });

  it('returns undefined for a malformed github form (missing repo / path)', () => {
    expect(parseProjectRulesSource('owner//path')).toBeUndefined();   // no repo
    expect(parseProjectRulesSource('owner/repo//')).toBeUndefined();  // empty path
  });
});

// ---------------------------------------------------------------------------
// seed (.example)
// ---------------------------------------------------------------------------

describe('project-rule seed', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'macf-projrule-seed-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('seeds the .example template into .claude/rules/project/', () => {
    const name = seedProjectRulesDir(workspace);
    expect(name).toBe(PROJECT_RULE_SEED_NAME);
    const path = join(workspaceProjectRulesDir(workspace), PROJECT_RULE_SEED_NAME);
    expect(existsSync(path)).toBe(true);
    expect(path.endsWith('.md.example')).toBe(true);
  });

  it('seed content is generic — NOT macf-specific (ships to every deployment)', () => {
    const content = projectRuleSeedContent();
    // Must self-document the tier + precedence.
    expect(content).toContain('project-tier');
    expect(content).toContain(PROJECT_RULES_SOURCE_ENV);
    expect(content).toContain('add to / specialize');
    // Must NOT leak macf-specific rules — a genomics deployment must not get a
    // macf dev.mk rule.
    expect(content).not.toContain('dev.mk');
    expect(content).not.toContain('make -f');
    expect(content).not.toMatch(/macf-science-agent/);
  });

  it('is idempotent (re-seed overwrites with the canonical example)', () => {
    seedProjectRulesDir(workspace);
    const path = join(workspaceProjectRulesDir(workspace), PROJECT_RULE_SEED_NAME);
    writeFileSync(path, 'operator scribbles');
    seedProjectRulesDir(workspace);
    expect(readFileSync(path, 'utf-8')).not.toContain('operator scribbles');
  });
});

// ---------------------------------------------------------------------------
// fetchProjectRules — unset no-op
// ---------------------------------------------------------------------------

describe('fetchProjectRules — unset is a no-op (optional tier)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'macf-projrule-noop-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('returns [] and creates nothing when source is undefined', () => {
    const copied = fetchProjectRules(workspace, { source: undefined });
    expect(copied).toEqual([]);
    expect(existsSync(workspaceProjectRulesDir(workspace))).toBe(false);
  });

  it('returns [] for an empty / whitespace source', () => {
    expect(fetchProjectRules(workspace, { source: '' })).toEqual([]);
    expect(fetchProjectRules(workspace, { source: '   ' })).toEqual([]);
    expect(existsSync(workspaceProjectRulesDir(workspace))).toBe(false);
  });

  it('returns [] (warns) for a malformed source without throwing', () => {
    const copied = fetchProjectRules(workspace, { source: 'owner//path' });
    expect(copied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchProjectRules — local-dir path
// ---------------------------------------------------------------------------

describe('fetchProjectRules — local directory source', () => {
  let root: string;
  let srcDir: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'macf-projrule-local-'));
    srcDir = join(root, 'project-rules');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'ci-gate.md'), '# CI gate\n\nRun the suite.\n');
    writeFileSync(join(srcDir, 'cluster.md'), '# Cluster pattern\n');
    // Non-.md + the .example template should be ignored.
    writeFileSync(join(srcDir, 'README.txt'), 'ignore me');
    writeFileSync(join(srcDir, 'EXAMPLE.project-rule.md.example'), 'a template, not a rule');
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies only *.md files into .claude/rules/project/', () => {
    const copied = fetchProjectRules(workspace, { source: srcDir });
    expect(copied.sort()).toEqual(['ci-gate.md', 'cluster.md']);

    const destDir = workspaceProjectRulesDir(workspace);
    expect(readdirSync(destDir).sort()).toEqual(['ci-gate.md', 'cluster.md']);
  });

  it('prepends a project-tier managed header to copied rules', () => {
    fetchProjectRules(workspace, { source: srcDir });
    const out = readFileSync(join(workspaceProjectRulesDir(workspace), 'ci-gate.md'), 'utf-8');
    expect(out.startsWith('<!--')).toBe(true);
    expect(out).toContain('PROJECT-TIER RULE');
    expect(out).toContain('# CI gate');
  });

  it('throws when the local source does not exist', () => {
    expect(() => fetchProjectRules(workspace, { source: join(root, 'nope') })).toThrow(/does not exist/);
  });

  it('throws when the local source is a file, not a directory', () => {
    const file = join(root, 'a-file');
    writeFileSync(file, 'x');
    expect(() => fetchProjectRules(workspace, { source: file })).toThrow(/not a directory/);
  });
});

// ---------------------------------------------------------------------------
// fetchProjectRules — github source (against a local bare repo, no network)
// ---------------------------------------------------------------------------

/**
 * Build a local bare git repo with a `project-rules/` subdir so the github
 * source path can be exercised without any network. The `githubBaseUrl`
 * override points the clone URL at this bare repo's parent dir, so
 * `${base}/<owner>/<repo>` resolves to the bare repo on disk.
 */
function buildFakeProjectRulesRepo(rootDir: string): { baseUrl: string; owner: string; repo: string } {
  const owner = 'fake-org';
  const repo = 'coord';
  const ownerDir = join(rootDir, owner);
  mkdirSync(ownerDir, { recursive: true });
  const bare = join(ownerDir, repo);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);

  const work = join(rootDir, 'work');
  execFileSync('git', ['clone', bare, work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', work, 'config', 'commit.gpgsign', 'false']);

  const rules = join(work, 'project-rules');
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, 'deploy-gate.md'), '# Deploy gate\n\nNeutral project rule.\n');
  writeFileSync(join(rules, 'README.md'), '# project rules index\n');

  execFileSync('git', ['-C', work, 'add', '.']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'initial']);
  execFileSync('git', ['-C', work, 'push', bare, 'main']);
  rmSync(work, { recursive: true, force: true });

  // baseUrl is the file:// parent so `${baseUrl}/<owner>/<repo>` = the bare repo.
  return { baseUrl: `file://${rootDir}`, owner, repo };
}

describe('fetchProjectRules — github source', () => {
  let root: string;
  let baseUrl: string;
  let owner: string;
  let repo: string;
  let workspace: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'macf-projrule-gh-'));
    ({ baseUrl, owner, repo } = buildFakeProjectRulesRepo(root));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'macf-projrule-gh-ws-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('clones the repo + copies *.md from the subpath into .claude/rules/project/', () => {
    const copied = fetchProjectRules(workspace, {
      source: `${owner}/${repo}//project-rules`,
      githubBaseUrl: baseUrl,
    });
    expect(copied.sort()).toEqual(['README.md', 'deploy-gate.md']);
    const destDir = workspaceProjectRulesDir(workspace);
    expect(readdirSync(destDir).sort()).toEqual(['README.md', 'deploy-gate.md']);
    const out = readFileSync(join(destDir, 'deploy-gate.md'), 'utf-8');
    expect(out).toContain('PROJECT-TIER RULE');
    expect(out).toContain('# Deploy gate');
  });

  it('throws when the subpath is missing in the cloned repo', () => {
    expect(() =>
      fetchProjectRules(workspace, {
        source: `${owner}/${repo}//does-not-exist`,
        githubBaseUrl: baseUrl,
      }),
    ).toThrow(/subpath/);
  });
});

// ---------------------------------------------------------------------------
// no-shadow invariant
// ---------------------------------------------------------------------------

describe('fetchProjectRules — no-shadow of the universal tier', () => {
  let root: string;
  let srcDir: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'macf-projrule-noshadow-'));
    srcDir = join(root, 'project-rules');
    mkdirSync(srcDir, { recursive: true });
    // A project rule with the SAME basename as a universal rule.
    writeFileSync(join(srcDir, 'coordination.md'), '# Project specialization\n');
    workspace = join(root, 'workspace');
    // Pre-existing universal rule at the flat path.
    const universalDir = join(workspace, '.claude', 'rules');
    mkdirSync(universalDir, { recursive: true });
    writeFileSync(join(universalDir, 'coordination.md'), '# UNIVERSAL coordination\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes into the project subdir, never the flat universal dir', () => {
    fetchProjectRules(workspace, { source: srcDir });

    // Universal rule untouched.
    const universal = readFileSync(join(workspace, '.claude', 'rules', 'coordination.md'), 'utf-8');
    expect(universal).toContain('# UNIVERSAL coordination');
    expect(universal).not.toContain('Project specialization');

    // Project rule landed in the subdir.
    const project = readFileSync(join(workspaceProjectRulesDir(workspace), 'coordination.md'), 'utf-8');
    expect(project).toContain('Project specialization');

    // The flat universal dir gained no project files beyond what was there +
    // the project/ subdir itself.
    const flat = readdirSync(join(workspace, '.claude', 'rules')).sort();
    expect(flat).toEqual(['coordination.md', 'project']);
  });
});
