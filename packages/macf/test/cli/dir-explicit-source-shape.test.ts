/**
 * Static source-shape regression guard (macf#1123), mirroring the
 * `check-framework-surface.sh` / `macf-startup-pickup.sh` lockstep test from
 * macf#1124: two independent copies of the SAME "was --dir passed
 * explicitly" predicate are a silent-drift risk, not just duplicated code —
 * `fleet resume`/`fleet reconcile`/`fleet install-cron` each independently
 * dropped the `dirExplicit` distinction `restart-self` (macf#888) already
 * had, and a naive per-command re-derivation is exactly how a FIFTH
 * `--dir`-taking command could reintroduce the same gap.
 *
 * Unlike the bash-script pair in macf#1124 (which can't share code across
 * distribution directories and so can only be pinned by asserting identical
 * TEXT), `index.ts`'s four `--dir`-taking commands genuinely share ONE
 * TypeScript function (`isDirExplicit` in `workspace-dir.ts`) — so this test
 * pins the STRONGER invariant a real import allows: the raw expression must
 * never reappear inline, and every capture site must route through the
 * shared helper.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('index.ts --dir capture is threaded through the shared isDirExplicit (macf#1123)', () => {
  const indexPath = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
  const source = readFileSync(indexPath, 'utf-8');

  it('imports isDirExplicit from the shared workspace-dir module', () => {
    expect(source).toMatch(/import\s*\{\s*isDirExplicit\s*\}\s*from\s*'\.\/workspace-dir\.js'/);
  });

  it('never re-derives the predicate inline (opts.dir !== undefined)', () => {
    // If this fires, someone added a --dir-taking command that reads
    // MACF_WORKSPACE_DIR downstream and re-derived "was --dir explicit"
    // locally instead of calling isDirExplicit(opts) — the exact shape of
    // drift macf#1123 fixed for the three sibling fleet commands.
    expect(source).not.toMatch(/opts\.dir\s*!==\s*undefined/);
  });

  it('all four --dir-taking commands with an ambient-env fallback call the shared helper (restart-self, fleet resume, fleet reconcile, fleet install-cron)', () => {
    const calls = source.match(/isDirExplicit\(opts\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});

// --- Set-membership audit: who may read MACF_WORKSPACE_DIR directly? -------
//
// The `isDirExplicit`-call-count check above pins the discriminator's
// CAPTURE site (index.ts). It does NOT catch a fifth `--dir`-taking command
// added straight to `src/cli/commands/**` that reads
// `process.env['MACF_WORKSPACE_DIR']` directly instead of going through
// `resolveWorkspaceDir` — the count of `isDirExplicit(opts)` calls in
// index.ts would stay unchanged (still >= 4) while the new command silently
// reproduced the exact macf#1123 defect. This is the durable invariant that
// closes that gap: `restart-self.ts` is the ONLY file under
// `src/cli/commands/` allowed a direct read (it is the reference
// implementation, deliberately left untouched); every other command must
// route through `workspace-dir.ts`.

// Matches both the bracket form this codebase actually uses (`env['MACF_WORKSPACE_DIR']`)
// AND the dot-access form (`env.MACF_WORKSPACE_DIR` / `process.env.MACF_WORKSPACE_DIR`)
// — a future command written in dot form must not silently slip past this guard.
const DIRECT_ENV_READ_PATTERN = /\benv\[['"]MACF_WORKSPACE_DIR['"]\]|\benv\.MACF_WORKSPACE_DIR\b/;

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('MACF_WORKSPACE_DIR direct-read set-membership audit (macf#1123)', () => {
  const commandsDir = fileURLToPath(new URL('../../src/cli/commands', import.meta.url));

  // Decisive per assert-the-wrong-path.md: prove the scanner actually fires
  // before trusting its "clean" verdict on the real tree below (matches the
  // no-internal-citations guard's own precedent for this exact shape of test).
  it('FIRES on a synthetic direct read of MACF_WORKSPACE_DIR — bracket form', () => {
    const bad = "const workspaceDir = env['MACF_WORKSPACE_DIR']?.trim() || projectDir;";
    expect(DIRECT_ENV_READ_PATTERN.test(bad)).toBe(true);
  });

  it('FIRES on a synthetic direct read of MACF_WORKSPACE_DIR — dot-access form (a future command could write it either way)', () => {
    const bad = 'const workspaceDir = process.env.MACF_WORKSPACE_DIR ?? projectDir;';
    expect(DIRECT_ENV_READ_PATTERN.test(bad)).toBe(true);
  });

  it('does NOT fire on the shared resolveWorkspaceDir call sites (resolveWorkspaceDir(...), not a direct env read)', () => {
    const ok = "const resolved = resolveWorkspaceDir(projectDir, cliOpts.dirExplicit === true);";
    expect(DIRECT_ENV_READ_PATTERN.test(ok)).toBe(false);
  });

  it('only restart-self.ts reads MACF_WORKSPACE_DIR directly — every OTHER src/cli/commands/*.ts routes through workspace-dir.ts', () => {
    const files = listTsFilesRecursive(commandsDir);
    expect(files.length).toBeGreaterThan(10); // sanity: the walker found the tree

    const violators = files
      .filter((f) => DIRECT_ENV_READ_PATTERN.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(commandsDir, f))
      .filter((rel) => rel !== 'restart-self.ts');

    expect(violators).toEqual([]);
  });
});

// --- Lockstep wording: the conflict warning text ----------------------------
//
// `restart-self.ts` is off-limits to edit (it is the reference
// implementation), so its inline `console.error` conflict-warning wording
// and `workspace-dir.ts`'s `formatWorkspaceDirConflictWarning` are two
// independently-necessary copies of the same sentence — exactly the
// macf#1124 shape (two scripts that can't share code across a boundary,
// pinned by asserting they carry the identical text) applied to a boundary
// this PR was told not to cross (restart-self.ts itself).

describe('conflict-warning wording stays in lockstep between restart-self.ts and workspace-dir.ts (macf#1123, same class as #1121/#1124)', () => {
  const FIXED_FRAGMENTS = [
    '--dir wins over MACF_WORKSPACE_DIR=',
    '— targeting ',
    'silently target the CALLER, not the named workspace).',
  ];

  it('restart-self.ts still carries every fixed fragment (fails loudly if its wording ever changes without this test being updated)', () => {
    const restartSelfPath = fileURLToPath(new URL('../../src/cli/commands/restart-self.ts', import.meta.url));
    const source = readFileSync(restartSelfPath, 'utf-8');
    for (const fragment of FIXED_FRAGMENTS) {
      expect(source).toContain(fragment);
    }
  });

  it('workspace-dir.ts\'s formatWorkspaceDirConflictWarning carries the SAME fixed fragments', () => {
    const workspaceDirPath = fileURLToPath(new URL('../../src/cli/workspace-dir.ts', import.meta.url));
    const source = readFileSync(workspaceDirPath, 'utf-8');
    for (const fragment of FIXED_FRAGMENTS) {
      expect(source).toContain(fragment);
    }
  });
});
