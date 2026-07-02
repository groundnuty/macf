import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copyCanonicalRules,
  canonicalRulesDir,
  copyCanonicalScripts,
  canonicalScriptsDir,
  canonicalPluginScriptsDir,
  findCliPackageRoot,
} from '../../src/cli/rules.js';

describe('findCliPackageRoot', () => {
  it('locates the CLI package root by walking up for package.json', () => {
    const root = findCliPackageRoot();
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    // The repo package.json contains our bin entry — sanity check.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('@groundnuty/macf');
  });
});

describe('canonicalRulesDir', () => {
  it('points to <repo>/plugin/rules/ in dev layout', () => {
    const dir = canonicalRulesDir();
    expect(dir.endsWith(join('plugin', 'rules'))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('coordination.md exists in the canonical dir', () => {
    const dir = canonicalRulesDir();
    expect(existsSync(join(dir, 'coordination.md'))).toBe(true);
  });
});

describe('copyCanonicalRules', () => {
  let tmpRoot: string;
  let fakeCanonical: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-rules-test-'));
    fakeCanonical = join(tmpRoot, 'canonical');
    mkdirSync(fakeCanonical, { recursive: true });
    writeFileSync(join(fakeCanonical, 'coordination.md'), '# Coordination\n\nBody text.\n');
    writeFileSync(join(fakeCanonical, 'other.md'), '# Other rule\n');
    // A non-markdown file should be ignored.
    writeFileSync(join(fakeCanonical, 'README.txt'), 'ignore me');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies every .md file to <workspace>/.claude/rules/', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    const copied = copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    expect(copied).toContain('coordination.md');
    expect(copied).toContain('other.md');
    expect(copied).not.toContain('README.txt');

    const rulesDir = join(workspace, '.claude', 'rules');
    expect(existsSync(rulesDir)).toBe(true);
    const files = readdirSync(rulesDir).sort();
    expect(files).toEqual(['coordination.md', 'other.md']);
  });

  it('prepends a managed-file warning header', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    const copied = readFileSync(join(workspace, '.claude', 'rules', 'coordination.md'), 'utf-8');
    expect(copied.startsWith('<!--')).toBe(true);
    expect(copied).toContain('managed by `macf`');
    expect(copied).toContain('# Coordination');
  });

  it('overwrites existing workspace copies on re-run', () => {
    const workspace = join(tmpRoot, 'workspace');
    const rulesDir = join(workspace, '.claude', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'coordination.md'), '# stale edits by user\n');

    copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    const out = readFileSync(join(rulesDir, 'coordination.md'), 'utf-8');
    expect(out).not.toContain('stale edits by user');
    expect(out).toContain('# Coordination');
  });

  it('does not double-prepend the header when canonical file already has one', () => {
    // If a canonical file ever starts with <!-- (perhaps someone added a comment),
    // the copy shouldn't stack another managed header on top. Simulate by writing
    // a canonical file that already begins with <!--.
    writeFileSync(join(fakeCanonical, 'coordination.md'),
      '<!-- This is a pre-existing comment -->\n# Coordination\n');

    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    const copied = readFileSync(join(workspace, '.claude', 'rules', 'coordination.md'), 'utf-8');
    const openingComments = copied.match(/<!--/g) ?? [];
    expect(openingComments.length).toBe(1);
  });

  it('creates .claude/rules/ when it does not exist', () => {
    const workspace = join(tmpRoot, 'fresh-workspace');
    mkdirSync(workspace);
    expect(existsSync(join(workspace, '.claude'))).toBe(false);

    copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    expect(existsSync(join(workspace, '.claude', 'rules', 'coordination.md'))).toBe(true);
  });

  it('returns empty array when canonical dir does not exist (no crash)', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    const copied = copyCanonicalRules(workspace, {
      canonicalDir: join(tmpRoot, 'does-not-exist'),
    });

    expect(copied).toEqual([]);
    expect(existsSync(join(workspace, '.claude'))).toBe(false);
  });
});

describe('canonicalScriptsDir', () => {
  it('points to <repo>/scripts/ in dev layout', () => {
    const dir = canonicalScriptsDir();
    expect(dir.endsWith('scripts')).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('tmux-send-to-claude.sh exists in the canonical dir', () => {
    const dir = canonicalScriptsDir();
    expect(existsSync(join(dir, 'tmux-send-to-claude.sh'))).toBe(true);
  });

  it('macf-gh-token.sh exists in the canonical dir', () => {
    const dir = canonicalScriptsDir();
    expect(existsSync(join(dir, 'macf-gh-token.sh'))).toBe(true);
  });

  it('macf-whoami.sh exists in the canonical dir', () => {
    const dir = canonicalScriptsDir();
    expect(existsSync(join(dir, 'macf-whoami.sh'))).toBe(true);
  });
});

describe('canonicalPluginScriptsDir', () => {
  it('points to <repo>/plugin/scripts/ in dev layout', () => {
    const dir = canonicalPluginScriptsDir();
    expect(dir.endsWith(join('plugin', 'scripts'))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('mark-turn-state.sh exists in the canonical plugin scripts dir', () => {
    const dir = canonicalPluginScriptsDir();
    expect(existsSync(join(dir, 'mark-turn-state.sh'))).toBe(true);
  });

  it('the 7 DR-039-phase-2-migrated hook scripts exist in the canonical plugin scripts dir', () => {
    const dir = canonicalPluginScriptsDir();
    for (const name of [
      'check-gh-token.sh',
      'check-mention-routing.sh',
      'check-lgtm-gate.sh',
      'check-close-keyword.sh',
      'check-gh-attribution.sh',
      'check-channel-alive.sh',
      'harvest-reflection.sh',
    ]) {
      expect(existsSync(join(dir, name)), `expected ${name} in ${dir}`).toBe(true);
    }
  });

  it('the 7 migrated hook scripts no longer exist in the LEGACY canonical scripts dir', () => {
    const dir = canonicalScriptsDir();
    for (const name of [
      'check-gh-token.sh',
      'check-mention-routing.sh',
      'check-lgtm-gate.sh',
      'check-close-keyword.sh',
      'check-gh-attribution.sh',
      'check-channel-alive.sh',
      'harvest-reflection.sh',
    ]) {
      expect(existsSync(join(dir, name)), `expected ${name} NOT in ${dir}`).toBe(false);
    }
  });
});

describe('copyCanonicalScripts', () => {
  let tmpRoot: string;
  let fakeCanonical: string;
  let fakePluginScripts: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-scripts-test-'));
    fakeCanonical = join(tmpRoot, 'canonical');
    mkdirSync(fakeCanonical, { recursive: true });
    writeFileSync(join(fakeCanonical, 'helper.sh'), '#!/usr/bin/env bash\necho hi\n');
    writeFileSync(join(fakeCanonical, 'other.sh'), '#!/usr/bin/env bash\necho bye\n');
    // Non-.sh files should be ignored.
    writeFileSync(join(fakeCanonical, 'README.md'), '# not a script');

    // A second, empty fake plugin-scripts dir so the default real
    // <repo>/plugin/scripts/ content doesn't leak into these single-source
    // assertions. Dual-source behavior is covered by its own describe block
    // below.
    fakePluginScripts = join(tmpRoot, 'plugin-canonical');
    mkdirSync(fakePluginScripts, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies every .sh file to <workspace>/.claude/scripts/', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    const copied = copyCanonicalScripts(workspace, { canonicalDir: fakeCanonical, pluginScriptsDir: fakePluginScripts });

    expect(copied).toContain('helper.sh');
    expect(copied).toContain('other.sh');
    expect(copied).not.toContain('README.md');

    const scriptsDir = join(workspace, '.claude', 'scripts');
    expect(existsSync(scriptsDir)).toBe(true);
    const files = readdirSync(scriptsDir).sort();
    expect(files).toEqual(['helper.sh', 'other.sh']);
  });

  it('copies scripts verbatim without a managed header', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    copyCanonicalScripts(workspace, { canonicalDir: fakeCanonical, pluginScriptsDir: fakePluginScripts });

    const out = readFileSync(join(workspace, '.claude', 'scripts', 'helper.sh'), 'utf-8');
    expect(out).toBe('#!/usr/bin/env bash\necho hi\n');
    expect(out.startsWith('<!--')).toBe(false);
  });

  it('sets executable mode (0o755) on copied scripts', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    copyCanonicalScripts(workspace, { canonicalDir: fakeCanonical, pluginScriptsDir: fakePluginScripts });

    const stats = statSync(join(workspace, '.claude', 'scripts', 'helper.sh'));
    // Check the owner-execute bit is set. mode & 0o111 == any-execute.
    expect(stats.mode & 0o111).toBeGreaterThan(0);
    // Tighter: owner rwx + group rx + other rx.
    expect(stats.mode & 0o777).toBe(0o755);
  });

  it('overwrites existing workspace scripts on re-run', () => {
    const workspace = join(tmpRoot, 'workspace');
    const scriptsDir = join(workspace, '.claude', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'helper.sh'), '#!/usr/bin/env bash\necho STALE\n');

    copyCanonicalScripts(workspace, { canonicalDir: fakeCanonical, pluginScriptsDir: fakePluginScripts });

    const out = readFileSync(join(scriptsDir, 'helper.sh'), 'utf-8');
    expect(out).not.toContain('STALE');
    expect(out).toContain('echo hi');
  });

  it('returns empty array when both canonical dirs do not exist (no crash)', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    const copied = copyCanonicalScripts(workspace, {
      canonicalDir: join(tmpRoot, 'does-not-exist'),
      pluginScriptsDir: join(tmpRoot, 'also-does-not-exist'),
    });

    expect(copied).toEqual([]);
    expect(existsSync(join(workspace, '.claude'))).toBe(false);
  });

  describe('dual-source merge (DR-039 phase 2, groundnuty/macf#698)', () => {
    it('copies .sh files from BOTH the legacy dir and the plugin scripts dir', () => {
      writeFileSync(join(fakePluginScripts, 'check-fake-hook.sh'), '#!/usr/bin/env bash\necho hook\n');

      const workspace = join(tmpRoot, 'workspace');
      mkdirSync(workspace);

      const copied = copyCanonicalScripts(workspace, { canonicalDir: fakeCanonical, pluginScriptsDir: fakePluginScripts });

      expect(copied).toContain('helper.sh');
      expect(copied).toContain('other.sh');
      expect(copied).toContain('check-fake-hook.sh');

      const scriptsDir = join(workspace, '.claude', 'scripts');
      const files = readdirSync(scriptsDir).sort();
      expect(files).toEqual(['check-fake-hook.sh', 'helper.sh', 'other.sh']);
    });

    it('excludes mark-turn-state.sh from the plugin-scripts-dir compat copy', () => {
      writeFileSync(join(fakePluginScripts, 'mark-turn-state.sh'), '#!/usr/bin/env bash\necho turn\n');
      writeFileSync(join(fakePluginScripts, 'check-fake-hook.sh'), '#!/usr/bin/env bash\necho hook\n');

      const workspace = join(tmpRoot, 'workspace');
      mkdirSync(workspace);

      const copied = copyCanonicalScripts(workspace, { canonicalDir: fakeCanonical, pluginScriptsDir: fakePluginScripts });

      expect(copied).toContain('check-fake-hook.sh');
      expect(copied).not.toContain('mark-turn-state.sh');
      expect(existsSync(join(workspace, '.claude', 'scripts', 'mark-turn-state.sh'))).toBe(false);
    });
  });

  describe('real default sources (no override) — the actual CLI-shipped scripts', () => {
    it('distributes all 7 DR-039-phase-2-migrated hook scripts to <workspace>/.claude/scripts/', () => {
      const workspace = join(tmpRoot, 'workspace');
      mkdirSync(workspace);

      const copied = copyCanonicalScripts(workspace);

      for (const name of [
        'check-gh-token.sh',
        'check-mention-routing.sh',
        'check-lgtm-gate.sh',
        'check-close-keyword.sh',
        'check-gh-attribution.sh',
        'check-channel-alive.sh',
        'harvest-reflection.sh',
      ]) {
        expect(copied, `expected ${name} to be copied`).toContain(name);
        expect(existsSync(join(workspace, '.claude', 'scripts', name)), `expected ${name} on disk`).toBe(true);
      }
    });

    it('also still distributes the legacy helper + hand-wired-hook scripts', () => {
      const workspace = join(tmpRoot, 'workspace');
      mkdirSync(workspace);

      const copied = copyCanonicalScripts(workspace);

      for (const name of [
        'macf-gh-token.sh',
        'macf-whoami.sh',
        'tmux-send-to-claude.sh',
        'check-auditor-never-acts.sh',
        'emit-turn-receipt.sh',
        'check-channels-enabled.sh',
      ]) {
        expect(copied, `expected ${name} to be copied`).toContain(name);
      }
    });

    it('does NOT distribute the plugin-only mark-turn-state.sh', () => {
      const workspace = join(tmpRoot, 'workspace');
      mkdirSync(workspace);

      const copied = copyCanonicalScripts(workspace);

      expect(copied).not.toContain('mark-turn-state.sh');
      expect(existsSync(join(workspace, '.claude', 'scripts', 'mark-turn-state.sh'))).toBe(false);
    });
  });
});
