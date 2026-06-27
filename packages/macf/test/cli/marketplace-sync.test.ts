/**
 * Tests for the marketplace plugin sync (groundnuty/macf#605).
 *
 * Builds a tmpdir fixture standing in for the canonical `plugin/` and the
 * marketplace `macf-agent/` trees — no real dirs are touched. Verifies
 * checkPluginSync's mismatch detection (missing / extra / content-differs),
 * that EXCLUDED paths (rules/, README.md, .claude-plugin/) are ignored, and
 * that syncPluginToMarketplace copies (mode-preserving) + prunes stale files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLUGIN_SYNC_SUBDIRS,
  checkPluginSync,
  syncPluginToMarketplace,
} from '../../src/cli/marketplace-sync.js';

let root: string;
let canonical: string;
let target: string;

function write(base: string, rel: string, content: string, mode?: number): void {
  const path = join(base, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

/**
 * Seed an in-sync pair: identical synced subdirs, plus EXCLUDED files
 * (rules/, README.md, .claude-plugin/) that DIFFER between the two trees to
 * prove they are not part of the sync surface.
 */
function seedInSync(): void {
  for (const base of [canonical, target]) {
    write(base, 'agents/code-agent.md', '# code-agent\n');
    write(base, 'skills/macf-status/SKILL.md', '# status\n');
    write(base, 'hooks/hooks.json', '{"hooks":{}}\n');
    write(base, 'scripts/mark-turn-state.sh', '#!/usr/bin/env bash\necho hi\n', 0o755);
  }
  // EXCLUDED surfaces — intentionally divergent; must be ignored by both fns.
  write(canonical, 'rules/coordination.md', 'CANONICAL rules\n');
  write(target, 'rules/coordination.md', 'STALE rules\n');
  write(canonical, 'README.md', 'canonical readme\n');
  // .claude-plugin lives only on the marketplace side (manifest, managed apart).
  write(target, '.claude-plugin/plugin.json', '{"version":"0.0.0"}\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'macf-mp-sync-'));
  canonical = join(root, 'plugin');
  target = join(root, 'macf-agent');
  mkdirSync(canonical, { recursive: true });
  mkdirSync(target, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('PLUGIN_SYNC_SUBDIRS', () => {
  it('mirrors agents/hooks/scripts/skills and excludes rules', () => {
    expect([...PLUGIN_SYNC_SUBDIRS]).toEqual(['agents', 'hooks', 'scripts', 'skills']);
    expect(PLUGIN_SYNC_SUBDIRS).not.toContain('rules');
  });
});

describe('checkPluginSync', () => {
  it('reports inSync:true when synced subdirs match (ignoring excluded surfaces)', () => {
    seedInSync();
    const res = checkPluginSync(canonical, target);
    expect(res.mismatches).toEqual([]);
    expect(res.inSync).toBe(true);
  });

  it('flags a file missing in target', () => {
    seedInSync();
    rmSync(join(target, 'scripts/mark-turn-state.sh'));
    const res = checkPluginSync(canonical, target);
    expect(res.inSync).toBe(false);
    expect(res.mismatches).toContain('scripts/mark-turn-state.sh (missing in target)');
  });

  it('flags an extra file in target', () => {
    seedInSync();
    write(target, 'hooks/session-start-pickup.sh', 'stale\n');
    const res = checkPluginSync(canonical, target);
    expect(res.inSync).toBe(false);
    expect(res.mismatches).toContain('hooks/session-start-pickup.sh (extra in target)');
  });

  it('flags a content-differing file', () => {
    seedInSync();
    write(target, 'hooks/hooks.json', '{"hooks":{"stale":true}}\n');
    const res = checkPluginSync(canonical, target);
    expect(res.inSync).toBe(false);
    expect(res.mismatches).toContain('hooks/hooks.json (content differs)');
  });

  it('ignores differences in rules/, README.md, and .claude-plugin/', () => {
    seedInSync();
    // Make the excluded surfaces diverge further — still must be inSync.
    write(target, 'rules/coordination.md', 'EVEN MORE STALE\n');
    write(target, 'README.md', 'divergent readme\n');
    write(target, '.claude-plugin/plugin.json', '{"version":"9.9.9"}\n');
    const res = checkPluginSync(canonical, target);
    expect(res.inSync).toBe(true);
    expect(res.mismatches).toEqual([]);
  });

  it('tolerates a missing subdir on either side (reports, does not throw)', () => {
    seedInSync();
    rmSync(join(target, 'scripts'), { recursive: true, force: true });
    const res = checkPluginSync(canonical, target);
    expect(res.inSync).toBe(false);
    expect(res.mismatches).toContain('scripts/mark-turn-state.sh (missing in target)');
  });
});

describe('syncPluginToMarketplace', () => {
  it('copies canonical files preserving content and executable mode', () => {
    seedInSync();
    // Diverge the target hooks + drop a canonical script so the sync must act.
    write(target, 'hooks/hooks.json', '{"hooks":{"stale":true}}\n');
    rmSync(join(target, 'scripts/mark-turn-state.sh'));

    const res = syncPluginToMarketplace(canonical, target);

    // Content now byte-identical.
    expect(readFileSync(join(target, 'hooks/hooks.json'), 'utf-8')).toBe('{"hooks":{}}\n');
    expect(existsSync(join(target, 'scripts/mark-turn-state.sh'))).toBe(true);
    // Executable bit preserved from canonical.
    expect(statSync(join(target, 'scripts/mark-turn-state.sh')).mode & 0o111).not.toBe(0);
    expect(res.written).toContain('scripts/mark-turn-state.sh');
    expect(res.written).toContain('hooks/hooks.json');
  });

  it('removes stale target-only files in synced subdirs', () => {
    seedInSync();
    write(target, 'hooks/session-start-pickup.sh', 'stale\n');

    const res = syncPluginToMarketplace(canonical, target);

    expect(existsSync(join(target, 'hooks/session-start-pickup.sh'))).toBe(false);
    expect(res.removed).toContain('hooks/session-start-pickup.sh');
  });

  it('leaves .claude-plugin/ and README.md untouched', () => {
    seedInSync();
    syncPluginToMarketplace(canonical, target);
    expect(readFileSync(join(target, '.claude-plugin/plugin.json'), 'utf-8')).toBe(
      '{"version":"0.0.0"}\n',
    );
    // README.md exists only on canonical; sync must not create it in target.
    expect(existsSync(join(target, 'README.md'))).toBe(false);
    // rules/ in target keeps its stale content (not synced).
    expect(readFileSync(join(target, 'rules/coordination.md'), 'utf-8')).toBe('STALE rules\n');
  });

  it('leaves the pair inSync after a full sync from drifted state', () => {
    seedInSync();
    write(target, 'hooks/hooks.json', '{"hooks":{"stale":true}}\n');
    write(target, 'hooks/session-start-pickup.sh', 'stale\n');
    rmSync(join(target, 'scripts/mark-turn-state.sh'));

    syncPluginToMarketplace(canonical, target);

    expect(checkPluginSync(canonical, target).inSync).toBe(true);
  });
});
