/**
 * Package version, derived from `package.json` at module load.
 *
 * Structural fix for macf#216 — replaces hardcoded version literals
 * in `cli/index.ts` (commander `.version()`), `version-resolver.ts`
 * (`FALLBACK_VERSIONS.cli` default), and the init-versions test
 * assertion. Without this util, every release bump required editing
 * 4 source literals plus 5 package.json fields; missing any one
 * caused silent drift (seen on macf#215 PR review + macf#219 rc.1
 * bump).
 *
 * Path resolution works for both dev (source loaded from `src/`) and
 * installed (compiled loaded from `dist/`) layouts: one dir up from
 * this file's location lands at the package root where
 * `package.json` lives in both cases.
 *
 * `package.json` is always included in npm-published tarballs
 * regardless of the `files` field, so the runtime read works post-
 * publish for operators consuming `@groundnuty/macf` via npm.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(packageRoot, 'package.json');

/**
 * The canonical semver, exactly as published. Machine version-logic
 * (version-resolver defaults, `compareSemver` in collision/fleet-upgrade,
 * the init-versions pins) MUST use this — never the dev-suffixed display
 * form below, or a `-dev.<sha>` suffix would break semver comparisons.
 */
export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(pkgPath, 'utf-8')) as { readonly version: string }
).version;

/**
 * Human-facing version string for `macf --version` ONLY. When the CLI is
 * running from a git working tree (an `npm link` dev install — a published
 * npm tarball has no reachable `.git/`), appends `+dev.<shortsha>[.dirty]`
 * so it's unmistakable you're running an unpublished dev build rather than
 * the release the bare version implies (macf, operator request 2026-07-01,
 * after an npm-linked 0.2.44 build looked like a stale published 0.2.44).
 *
 * Fail-soft: any error (no git, detached, git unavailable) → the plain
 * `PACKAGE_VERSION`. Never throws; a broken detection just yields the
 * release form.
 */
export function packageVersionDisplay(): string {
  try {
    // A published tarball has no `.git/` above the package root; a linked
    // working-tree install does. That is the dev-vs-published signal.
    let dir = packageRoot;
    let gitRoot: string | null = null;
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, '.git'))) {
        gitRoot = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (gitRoot === null) return PACKAGE_VERSION; // published install → plain

    const git = (args: readonly string[]): string =>
      execFileSync('git', ['-C', gitRoot as string, ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

    const sha = git(['rev-parse', '--short', 'HEAD']);
    if (!sha) return PACKAGE_VERSION;
    const dirty = git(['status', '--porcelain']).length > 0 ? '.dirty' : '';
    return `${PACKAGE_VERSION}+dev.${sha}${dirty}`;
  } catch {
    return PACKAGE_VERSION;
  }
}
