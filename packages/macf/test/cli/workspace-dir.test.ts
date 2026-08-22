/**
 * Tests for the shared `--dir`-vs-`MACF_WORKSPACE_DIR` discriminator
 * (macf#1123) that `fleet resume` / `fleet reconcile` / `fleet install-cron`
 * now thread instead of each re-deriving the precedence independently.
 *
 * Mirrors `restart-self.test.ts`'s `resolveIdentity` describe block byte-for-
 * byte in shape (same fixtures, same case names where the logic is shared) —
 * this module's `resolveWorkspaceDir` is a direct extraction of the
 * `workspaceDir`/`identitySource`/`workspaceDirConflict` slice of that
 * function, so the two test suites should never disagree about what
 * "--dir wins" means.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveWorkspaceDir,
  formatWorkspaceDirConflictWarning,
  isDirExplicit,
} from '../../src/cli/workspace-dir.js';

describe('resolveWorkspaceDir', () => {
  describe('dirExplicit=false (no --dir) — the ordinary in-session case must not break', () => {
    it('falls back to projectDir when env is unset (cwd-discovery)', () => {
      const r = resolveWorkspaceDir('/proj', false, {} as NodeJS.ProcessEnv);
      expect(r).toEqual({ workspaceDir: '/proj', source: 'cwd-discovery', workspaceDirConflict: null });
    });

    it('ambient MACF_WORKSPACE_DIR wins over the auto-discovered projectDir (unchanged pre-#888 precedence)', () => {
      const r = resolveWorkspaceDir('/proj', false, { MACF_WORKSPACE_DIR: '/env-ws' } as NodeJS.ProcessEnv);
      expect(r).toEqual({ workspaceDir: '/env-ws', source: 'env', workspaceDirConflict: null });
    });
  });

  describe('dirExplicit=true (an explicit --dir was passed) — macf#1123', () => {
    it('THE REGRESSION: --dir resolves to the TARGET workspace, not the ambient MACF_WORKSPACE_DIR', () => {
      const r = resolveWorkspaceDir('/target-b', true, { MACF_WORKSPACE_DIR: '/caller-a' } as NodeJS.ProcessEnv);
      expect(r.workspaceDir).toBe('/target-b');
      expect(r.source).toBe('dir-flag');
    });

    it('surfaces workspaceDirConflict with the discarded env value when --dir and env DISAGREE', () => {
      const r = resolveWorkspaceDir('/target-b', true, { MACF_WORKSPACE_DIR: '/caller-a' } as NodeJS.ProcessEnv);
      expect(r.workspaceDirConflict).toBe('/caller-a');
    });

    it('workspaceDirConflict is null when env is simply unset', () => {
      const r = resolveWorkspaceDir('/target-b', true, {} as NodeJS.ProcessEnv);
      expect(r.workspaceDirConflict).toBeNull();
    });

    it('workspaceDirConflict is null when --dir and env happen to AGREE (no false-positive warning)', () => {
      const r = resolveWorkspaceDir('/target-b', true, { MACF_WORKSPACE_DIR: '/target-b' } as NodeJS.ProcessEnv);
      expect(r.workspaceDirConflict).toBeNull();
      expect(r.source).toBe('dir-flag');
    });
  });
});

describe('formatWorkspaceDirConflictWarning', () => {
  it('null when there is no conflict', () => {
    const r = resolveWorkspaceDir('/proj', false, {} as NodeJS.ProcessEnv);
    expect(formatWorkspaceDirConflictWarning('fleet resume', r)).toBeNull();
  });

  it('matches restart-self.ts\'s warning SHAPE with only the command label substituted', () => {
    const r = resolveWorkspaceDir('/target-b', true, { MACF_WORKSPACE_DIR: '/caller-a' } as NodeJS.ProcessEnv);
    const warning = formatWorkspaceDirConflictWarning('fleet reconcile', r);
    expect(warning).toBe(
      'macf fleet reconcile: --dir wins over MACF_WORKSPACE_DIR=/caller-a — targeting ' +
        '/target-b (without this, fleet reconcile would silently target the CALLER, ' +
        'not the named workspace).',
    );
  });

  it('the warning names the discarded env value AND the winning target — both are load-bearing for an operator reading it', () => {
    const r = resolveWorkspaceDir('/target-b', true, { MACF_WORKSPACE_DIR: '/caller-a' } as NodeJS.ProcessEnv);
    const warning = formatWorkspaceDirConflictWarning('fleet install-cron', r);
    expect(warning).toContain('/caller-a');
    expect(warning).toContain('/target-b');
  });
});

describe('isDirExplicit', () => {
  it('true when opts.dir is a string (including an empty one — commander only omits the key when the flag is absent)', () => {
    expect(isDirExplicit({ dir: '/some/path' })).toBe(true);
  });

  it('false when opts.dir is undefined (the flag was never passed)', () => {
    expect(isDirExplicit({})).toBe(false);
    expect(isDirExplicit({ dir: undefined })).toBe(false);
  });
});
