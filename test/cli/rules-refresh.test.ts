/**
 * Tests for `macf rules refresh` — distributes canonical rules + scripts
 * to any workspace, independent of `.macf/macf-agent.json`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rulesRefresh } from '../../src/cli/commands/rules-refresh.js';

describe('rulesRefresh', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-rules-refresh-test-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it('works on a workspace with no .macf/ directory', () => {
    // The whole point of this command: workspaces without `macf init`.
    expect(existsSync(join(tmpRoot, '.macf'))).toBe(false);

    const result = rulesRefresh(tmpRoot);

    // Real canonical files exist in-repo, so we get real output.
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.rules).toContain('coordination.md');
    expect(result.scripts).toContain('tmux-send-to-claude.sh');

    // Files landed where expected.
    expect(existsSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'))).toBe(true);
    expect(existsSync(join(tmpRoot, '.claude', 'scripts', 'tmux-send-to-claude.sh'))).toBe(true);

    // .macf/ still absent — we didn't create it.
    expect(existsSync(join(tmpRoot, '.macf'))).toBe(false);
  });

  it('works on a workspace that already has a .claude/ with hand-curated files', () => {
    // Simulate an existing workspace like groundnuty/macf: .claude/ exists
    // with a hand-curated agent-identity.md that we must not touch.
    const claudeDir = join(tmpRoot, '.claude');
    const rulesDir = join(claudeDir, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'agent-identity.md'), '# hand-curated\n');

    rulesRefresh(tmpRoot);

    // Hand-curated file is untouched.
    expect(existsSync(join(rulesDir, 'agent-identity.md'))).toBe(true);
    // Canonical file arrived alongside it.
    expect(existsSync(join(rulesDir, 'coordination.md'))).toBe(true);
  });

  it('is idempotent — running twice leaves the same final state', () => {
    rulesRefresh(tmpRoot);
    const first = existsSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'));

    // Second call should not crash and should leave the file in place.
    expect(() => rulesRefresh(tmpRoot)).not.toThrow();
    const second = existsSync(join(tmpRoot, '.claude', 'rules', 'coordination.md'));

    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it('throws when target directory does not exist', () => {
    const missing = join(tmpRoot, 'does-not-exist');
    expect(() => rulesRefresh(missing)).toThrow(/does not exist/);
  });

  it('throws when target path is a file, not a directory', () => {
    const filePath = join(tmpRoot, 'notadir');
    writeFileSync(filePath, 'just a file');
    expect(() => rulesRefresh(filePath)).toThrow(/not a directory/);
  });
});
