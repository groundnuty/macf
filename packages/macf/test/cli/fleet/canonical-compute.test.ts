/**
 * Tests for the canonical-compute primitive + tier-first dirty-file
 * classifier (DR-040 Decision 3, groundnuty/macf#698 R1).
 *
 * Covers: `computeCanonicalContent`'s per-file-type dispatch (rules, scripts,
 * env files, host-prelude, claude.sh — including the hand-authored-header-less
 * carve-out), the settings.json merge-fixed-point classification, the
 * never-written (`CLAUDE.md` / `env.local.*`) always-genuine-delta rule, and
 * the fail-safe posture (unreadable / malformed / unrecognized paths always
 * classify `genuine-delta`, never a false `already-canonical`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCanonicalContent,
  classifyDirtyFile,
} from '../../../src/cli/fleet/canonical-compute.js';
import { computeCanonicalRuleFile } from '../../../src/cli/rules.js';
import { computeCanonicalEnvFileContent } from '../../../src/cli/env-files-update.js';
import { computeCanonicalHostPrelude } from '../../../src/cli/host-prelude.js';
import { generateClaudeSh } from '../../../src/cli/claude-sh.js';
import {
  canPluginDeliverMigratedHooks,
  applyGhTokenHookTransform,
  applyPluginSkillPermissionsTransform,
  applySandboxFdAllowReadTransform,
  applySandboxExcludedCommandsTransform,
  type Settings,
} from '../../../src/cli/settings-writer.js';
import type { MacfAgentConfig } from '../../../src/cli/config.js';

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
  versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
};

let tmpRoot: string;
let workspace: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'macf-canonical-compute-test-'));
  workspace = join(tmpRoot, 'workspace');
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeWorkspaceFile(relPath: string, content: string): void {
  const abs = join(workspace, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// computeCanonicalContent — per-file-type dispatch
// ---------------------------------------------------------------------------

describe('computeCanonicalContent', () => {
  it('CLAUDE.md is never managed (macf update never writes it)', () => {
    expect(computeCanonicalContent('CLAUDE.md', workspace, sampleConfig)).toEqual({ managed: false });
  });

  it('env.local.* (any basename) is never managed', () => {
    expect(computeCanonicalContent('env.local.host', workspace, sampleConfig)).toEqual({ managed: false });
    expect(computeCanonicalContent('.claude/.macf/env.local.custom', workspace, sampleConfig)).toEqual({
      managed: false,
    });
  });

  it('.claude/settings.json is deliberately NOT handled here (its canonical form is a merge fixed point, see classifyDirtyFile)', () => {
    expect(computeCanonicalContent('.claude/settings.json', workspace, sampleConfig)).toEqual({ managed: false });
  });

  it('.claude/rules/<name>.md resolves via computeCanonicalRuleFile (real bundled canonical dir)', () => {
    const expected = computeCanonicalRuleFile('coordination.md');
    expect(expected).not.toBeNull();
    expect(computeCanonicalContent('.claude/rules/coordination.md', workspace, sampleConfig)).toEqual({
      managed: true,
      content: expected,
    });
  });

  it('.claude/rules/project/<name>.md (nested, network-fetched project-tier) is NOT computable — managed: false', () => {
    expect(
      computeCanonicalContent('.claude/rules/project/custom.md', workspace, sampleConfig),
    ).toEqual({ managed: false });
  });

  it('.claude/scripts/<name> resolves to the real bundled script bytes', () => {
    const result = computeCanonicalContent('.claude/scripts/macf-gh-token.sh', workspace, sampleConfig);
    expect(result.managed).toBe(true);
    if (result.managed) {
      expect(result.content).toContain('#!/usr/bin/env bash');
    }
  });

  it('.claude/scripts/<nested>/<name> (unexpected subdir) is NOT computable', () => {
    expect(
      computeCanonicalContent('.claude/scripts/sub/foo.sh', workspace, sampleConfig),
    ).toEqual({ managed: false });
  });

  it('.claude/.macf/env.identity resolves via computeCanonicalEnvFileContent', () => {
    expect(computeCanonicalContent('.claude/.macf/env.identity', workspace, sampleConfig)).toEqual({
      managed: true,
      content: computeCanonicalEnvFileContent('env.identity', sampleConfig),
    });
  });

  it('.claude/.macf/env.telemetry (operator-managed) is NOT computable', () => {
    expect(
      computeCanonicalContent('.claude/.macf/env.telemetry', workspace, sampleConfig),
    ).toEqual({ managed: false });
  });

  it('.claude/.macf/host-prelude.sh resolves via computeCanonicalHostPrelude (real toolchain re-detect)', () => {
    const result = computeCanonicalContent('.claude/.macf/host-prelude.sh', workspace, sampleConfig);
    expect(result).toEqual({ managed: true, content: computeCanonicalHostPrelude() });
  });

  it('claude.sh with the managed header resolves via generateClaudeSh(config)', () => {
    writeWorkspaceFile('claude.sh', generateClaudeSh(sampleConfig));
    expect(computeCanonicalContent('claude.sh', workspace, sampleConfig)).toEqual({
      managed: true,
      content: generateClaudeSh(sampleConfig),
    });
  });

  it('claude.sh WITHOUT the managed header (hand-authored) is NOT computable — DR-029 preserves it', () => {
    writeWorkspaceFile('claude.sh', '#!/usr/bin/env bash\n# Launcher for macf-code-agent\necho hi\n');
    expect(computeCanonicalContent('claude.sh', workspace, sampleConfig)).toEqual({ managed: false });
  });

  it('claude.sh absent on disk is NOT computable', () => {
    expect(computeCanonicalContent('claude.sh', workspace, sampleConfig)).toEqual({ managed: false });
  });

  it('an unrecognized path is NOT computable', () => {
    expect(computeCanonicalContent('some/random/path.txt', workspace, sampleConfig)).toEqual({ managed: false });
  });
});

// ---------------------------------------------------------------------------
// classifyDirtyFile — the tier classifier
// ---------------------------------------------------------------------------

describe('classifyDirtyFile', () => {
  it('CLAUDE.md is ALWAYS genuine-delta, even if its content happens to be empty/trivial', () => {
    writeWorkspaceFile('CLAUDE.md', '# Some doc\n');
    expect(classifyDirtyFile('CLAUDE.md', workspace, sampleConfig)).toBe('genuine-delta');
  });

  it('env.local.* is ALWAYS genuine-delta', () => {
    writeWorkspaceFile('env.local.host', 'export FOO=bar\n');
    expect(classifyDirtyFile('env.local.host', workspace, sampleConfig)).toBe('genuine-delta');
  });

  it('a missing/unreadable file classifies genuine-delta (fail-safe)', () => {
    // Nothing written at this path.
    expect(classifyDirtyFile('.claude/rules/coordination.md', workspace, sampleConfig)).toBe('genuine-delta');
  });

  it('an unrecognized/unmanaged path classifies genuine-delta', () => {
    writeWorkspaceFile('some/random/path.txt', 'anything\n');
    expect(classifyDirtyFile('some/random/path.txt', workspace, sampleConfig)).toBe('genuine-delta');
  });

  describe('rule files', () => {
    it('content EQUAL to the real canonical coordination.md → already-canonical', () => {
      const canonical = computeCanonicalRuleFile('coordination.md')!;
      writeWorkspaceFile('.claude/rules/coordination.md', canonical);
      expect(classifyDirtyFile('.claude/rules/coordination.md', workspace, sampleConfig)).toBe('already-canonical');
    });

    it('content DIFFERENT from canonical → genuine-delta', () => {
      writeWorkspaceFile('.claude/rules/coordination.md', '# a local edit that diverges\n');
      expect(classifyDirtyFile('.claude/rules/coordination.md', workspace, sampleConfig)).toBe('genuine-delta');
    });

    it('a rule name with no canonical source (agent-authored custom rule) → genuine-delta', () => {
      writeWorkspaceFile('.claude/rules/my-custom-rule.md', '# custom\n');
      expect(classifyDirtyFile('.claude/rules/my-custom-rule.md', workspace, sampleConfig)).toBe('genuine-delta');
    });

    it('project-tier rules (.claude/rules/project/*.md) → genuine-delta (network-fetched, not computable offline)', () => {
      writeWorkspaceFile('.claude/rules/project/custom.md', '# project rule\n');
      expect(classifyDirtyFile('.claude/rules/project/custom.md', workspace, sampleConfig)).toBe('genuine-delta');
    });
  });

  describe('script files', () => {
    it('content EQUAL to the real canonical macf-gh-token.sh → already-canonical', () => {
      const result = computeCanonicalContent('.claude/scripts/macf-gh-token.sh', workspace, sampleConfig);
      expect(result.managed).toBe(true);
      const canonical = result.managed ? result.content : '';
      writeWorkspaceFile('.claude/scripts/macf-gh-token.sh', canonical);
      expect(classifyDirtyFile('.claude/scripts/macf-gh-token.sh', workspace, sampleConfig)).toBe(
        'already-canonical',
      );
    });

    it('content DIFFERENT from canonical → genuine-delta', () => {
      writeWorkspaceFile('.claude/scripts/macf-gh-token.sh', '#!/usr/bin/env bash\n# a hand edit\n');
      expect(classifyDirtyFile('.claude/scripts/macf-gh-token.sh', workspace, sampleConfig)).toBe('genuine-delta');
    });

    it('a script name with no canonical source (agent scratch script) → genuine-delta', () => {
      writeWorkspaceFile('.claude/scripts/my-scratch.sh', '#!/usr/bin/env bash\necho hi\n');
      expect(classifyDirtyFile('.claude/scripts/my-scratch.sh', workspace, sampleConfig)).toBe('genuine-delta');
    });

    it('mark-turn-state.sh (PLUGIN_SCRIPTS_EXCLUDED_FROM_COMPAT) → genuine-delta even if present', () => {
      writeWorkspaceFile('.claude/scripts/mark-turn-state.sh', '#!/usr/bin/env bash\n');
      expect(classifyDirtyFile('.claude/scripts/mark-turn-state.sh', workspace, sampleConfig)).toBe('genuine-delta');
    });
  });

  describe('env files', () => {
    it('content EQUAL to computeCanonicalEnvFileContent(env.identity) → already-canonical', () => {
      const canonical = computeCanonicalEnvFileContent('env.identity', sampleConfig)!;
      writeWorkspaceFile('.claude/.macf/env.identity', canonical);
      expect(classifyDirtyFile('.claude/.macf/env.identity', workspace, sampleConfig)).toBe('already-canonical');
    });

    it('content DIFFERENT → genuine-delta', () => {
      writeWorkspaceFile('.claude/.macf/env.identity', 'export MACF_AGENT_NAME=hand-edited\n');
      expect(classifyDirtyFile('.claude/.macf/env.identity', workspace, sampleConfig)).toBe('genuine-delta');
    });

    it('env.telemetry (operator-managed) is ALWAYS genuine-delta', () => {
      writeWorkspaceFile('.claude/.macf/env.telemetry', 'export CLAUDE_CODE_ENABLE_TELEMETRY=1\n');
      expect(classifyDirtyFile('.claude/.macf/env.telemetry', workspace, sampleConfig)).toBe('genuine-delta');
    });
  });

  describe('host-prelude.sh', () => {
    it('content EQUAL to computeCanonicalHostPrelude() → already-canonical', () => {
      const canonical = computeCanonicalHostPrelude();
      writeWorkspaceFile('.claude/.macf/host-prelude.sh', canonical);
      expect(classifyDirtyFile('.claude/.macf/host-prelude.sh', workspace, sampleConfig)).toBe('already-canonical');
    });

    it('content DIFFERENT → genuine-delta', () => {
      writeWorkspaceFile('.claude/.macf/host-prelude.sh', '# a hand edit\n:\n');
      expect(classifyDirtyFile('.claude/.macf/host-prelude.sh', workspace, sampleConfig)).toBe('genuine-delta');
    });
  });

  describe('claude.sh', () => {
    it('managed header + content EQUAL to generateClaudeSh(config) → already-canonical', () => {
      writeWorkspaceFile('claude.sh', generateClaudeSh(sampleConfig));
      expect(classifyDirtyFile('claude.sh', workspace, sampleConfig)).toBe('already-canonical');
    });

    it('managed header + content DIFFERENT → genuine-delta', () => {
      const canonical = generateClaudeSh(sampleConfig);
      writeWorkspaceFile('claude.sh', canonical + '\n# a local addition\n');
      expect(classifyDirtyFile('claude.sh', workspace, sampleConfig)).toBe('genuine-delta');
    });

    it('hand-authored (no managed header) → genuine-delta ALWAYS, even if content happens to equal the canonical generator output', () => {
      // Pathological but instructive: even an exact-match content is
      // genuine-delta when it lacks the header, because `macf update`
      // would never regenerate it (DR-029) — there's no "canonical" claim
      // to make about it.
      writeWorkspaceFile('claude.sh', generateClaudeSh(sampleConfig).replace(/managed by `macf`\. [^\n]*/, 'hand-authored launcher'));
      expect(classifyDirtyFile('claude.sh', workspace, sampleConfig)).toBe('genuine-delta');
    });
  });

  describe('.claude/settings.json — merge fixed-point', () => {
    it('an EMPTY settings.json ({}) is genuine-delta — the canonical merge adds real content', () => {
      writeWorkspaceFile('.claude/settings.json', '{}');
      expect(classifyDirtyFile('.claude/settings.json', workspace, sampleConfig)).toBe('genuine-delta');
    });

    it('a settings.json that IS the merge fixed point (apply-once, then re-check) → already-canonical', () => {
      // Derive the fixed point empirically via the SAME exported transform
      // functions classifyDirtyFile uses internally: applying the merge to
      // `{}` once is provably idempotent for THIS workspace (nothing else
      // about it changes between the derivation and the classify call), so
      // feeding the once-applied result back in as "current" content must
      // classify as already-canonical.
      const delivery = canPluginDeliverMigratedHooks(workspace);
      let fixedPoint: Settings = {};
      fixedPoint = applyGhTokenHookTransform(fixedPoint, delivery);
      fixedPoint = applyPluginSkillPermissionsTransform(fixedPoint);
      fixedPoint = applySandboxFdAllowReadTransform(fixedPoint);
      fixedPoint = applySandboxExcludedCommandsTransform(fixedPoint);

      writeWorkspaceFile('.claude/settings.json', JSON.stringify(fixedPoint, null, 2) + '\n');
      expect(classifyDirtyFile('.claude/settings.json', workspace, sampleConfig)).toBe('already-canonical');
    });

    it('a settings.json missing the canonical hook/permission/sandbox entries (only operator content) → genuine-delta', () => {
      writeWorkspaceFile('.claude/settings.json', JSON.stringify({ some: 'operator-only-content' }));
      expect(classifyDirtyFile('.claude/settings.json', workspace, sampleConfig)).toBe('genuine-delta');
    });

    it('the fixed point PLUS one hand-added operator key is STILL already-canonical (operator extras are preserved, not a delta)', () => {
      const delivery = canPluginDeliverMigratedHooks(workspace);
      let fixedPoint: Settings = {};
      fixedPoint = applyGhTokenHookTransform(fixedPoint, delivery);
      fixedPoint = applyPluginSkillPermissionsTransform(fixedPoint);
      fixedPoint = applySandboxFdAllowReadTransform(fixedPoint);
      fixedPoint = applySandboxExcludedCommandsTransform(fixedPoint);
      const withOperatorExtra = { ...fixedPoint, model: 'opus' };

      writeWorkspaceFile('.claude/settings.json', JSON.stringify(withOperatorExtra, null, 2) + '\n');
      expect(classifyDirtyFile('.claude/settings.json', workspace, sampleConfig)).toBe('already-canonical');
    });

    it('malformed JSON → genuine-delta (fail-safe; never throws upward)', () => {
      writeWorkspaceFile('.claude/settings.json', '{ this is not valid json');
      expect(() => classifyDirtyFile('.claude/settings.json', workspace, sampleConfig)).not.toThrow();
      expect(classifyDirtyFile('.claude/settings.json', workspace, sampleConfig)).toBe('genuine-delta');
    });

    it('missing settings.json entirely → genuine-delta', () => {
      expect(classifyDirtyFile('.claude/settings.json', workspace, sampleConfig)).toBe('genuine-delta');
    });
  });
});
