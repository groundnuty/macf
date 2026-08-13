/**
 * Tests for `resolvePluginUpdateTarget` (macf#889) — where `macf update`
 * should write, resolved from the workspace's REAL claude.sh (no mocking of
 * `plugin-fetcher.js` here: this file exercises the actual
 * `resolvePluginDirFromClaudeSh` parse + the actual `workspacePluginDir`
 * default, so a pass here is evidence the production wiring — not a test
 * double standing in for it — resolves correctly).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePluginUpdateTarget } from '../../src/cli/plugin-hook-resolver.js';
import { workspacePluginDir } from '../../src/cli/plugin-fetcher.js';

describe('resolvePluginUpdateTarget (macf#889)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'plugin-update-target-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves to the conventional default when claude.sh mounts .macf/plugin', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      'exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"\n',
    );
    const result = resolvePluginUpdateTarget(tmpRoot);
    expect(result.determinable).toBe(true);
    expect(result.dir).toBe(workspacePluginDir(tmpRoot));
    expect(result.divergesFromDefault).toBe(false);
  });

  it('resolves to .macf/plugin-cs (diverging from the default) when claude.sh mounts it', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      'exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin-cs" "$@"\n',
    );
    const result = resolvePluginUpdateTarget(tmpRoot);
    expect(result.determinable).toBe(true);
    expect(result.dir).toBe(join(tmpRoot, '.macf', 'plugin-cs'));
    expect(result.divergesFromDefault).toBe(true);
    // Must not equal the conventional default.
    expect(result.dir).not.toBe(workspacePluginDir(tmpRoot));
  });

  it('is undeterminable + refuses (dir null) when claude.sh is absent', () => {
    const result = resolvePluginUpdateTarget(tmpRoot);
    expect(result.determinable).toBe(false);
    expect(result.dir).toBeNull();
    expect(result.divergesFromDefault).toBe(false);
    expect(result.detail).toMatch(/no claude\.sh/i);
  });

  it('is undeterminable when claude.sh has no --plugin-dir flag at all', () => {
    writeFileSync(join(tmpRoot, 'claude.sh'), 'exec claude "$@"\n');
    const result = resolvePluginUpdateTarget(tmpRoot);
    expect(result.determinable).toBe(false);
    expect(result.dir).toBeNull();
  });

  it('is undeterminable when claude.sh has multiple distinct --plugin-dir values', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      [
        'if [ -n "$FOO" ]; then',
        '  claude --plugin-dir "$SCRIPT_DIR/.macf/plugin-a" "$@"',
        'else',
        '  exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin-b" "$@"',
        'fi',
        '',
      ].join('\n'),
    );
    const result = resolvePluginUpdateTarget(tmpRoot);
    expect(result.determinable).toBe(false);
    expect(result.dir).toBeNull();
  });
});
