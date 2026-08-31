/**
 * Stale-dist detection (#144).
 *
 * The installed `macf` CLI is typically `npm link`-ed to
 * `<source-repo>/dist/cli/index.js`. When a CLI-behavior PR merges to
 * main, operators must rebuild before the linked CLI reflects the
 * change — forgetting the rebuild produces silent-no-op behavior.
 *
 * At build time, `scripts/write-build-info.mjs` writes the git HEAD
 * into `dist/.build-info.json`. At runtime, `detectStaleDist()`
 * compares that stamp against the source repo's current HEAD
 * (via `git rev-parse HEAD`) and returns a non-null result when
 * they differ.
 *
 * Fail-soft: if the build stamp is missing, is "unknown" (npm tarball
 * install where git wasn't available at build time), or the source
 * repo has no `.git/` directory, detection returns null. The detector
 * never warns spuriously — it either catches a real drift or stays
 * silent.
 *
 * Bootstrap limitation: detection only works from the CLI version
 * that introduces it forward. Workspaces running pre-#144 CLIs won't
 * get the warning until they rebuild once.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildInfo {
  readonly commit: string;
  readonly built_at: string;
}

export interface StaleDistInfo {
  /** The commit that was current when `dist/` was last built. */
  readonly buildCommit: string;
  /** The source repo's current HEAD. */
  readonly currentCommit: string;
  /** ISO timestamp of when `dist/` was built. */
  readonly builtAt: string;
}

/**
 * Load `<packageRoot>/dist/.build-info.json`. Returns null if the file
 * is missing or malformed — never throws.
 */
export function readBuildInfo(packageRoot: string): BuildInfo | null {
  const path = join(packageRoot, 'dist', '.build-info.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'commit' in parsed &&
      typeof (parsed as { commit: unknown }).commit === 'string' &&
      'built_at' in parsed &&
      typeof (parsed as { built_at: unknown }).built_at === 'string'
    ) {
      return { commit: (parsed as BuildInfo).commit, built_at: (parsed as BuildInfo).built_at };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run `git rev-parse HEAD` in `packageRoot`. Returns null if the repo
 * has no `.git/` directory or git errors for any reason (e.g., no
 * commits, command not installed).
 */
function currentHeadCommit(packageRoot: string): string | null {
  if (!existsSync(join(packageRoot, '.git'))) return null;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: packageRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Compare the dist/ build stamp against the source repo's current
 * HEAD. Returns null when the check can't run (no build info, no git,
 * stamp is `unknown`) or when the dist is fresh. Returns non-null
 * only when a real stale-dist condition is detected.
 */
export function detectStaleDist(packageRoot: string): StaleDistInfo | null {
  const info = readBuildInfo(packageRoot);
  if (info === null) return null;
  if (info.commit === 'unknown') return null;

  const head = currentHeadCommit(packageRoot);
  if (head === null) return null;

  if (head === info.commit) return null;

  return {
    buildCommit: info.commit,
    currentCommit: head,
    builtAt: info.built_at,
  };
}

/**
 * Non-null iff the source repo is a git-clone install (has `.git/`)
 * AND the build-info is missing or its commit is "unknown". This is
 * the "you built via `npx tsc` directly and skipped the postbuild
 * hook" case — distinct from a stale-dist condition. Treat as a soft
 * warning pointing at the canonical `npm run build`, not as a fail.
 *
 * Returns null for the legit cases: no git (tarball install), or the
 * build stamp matches current HEAD (fresh).
 */
export function detectUnknownFreshness(
  packageRoot: string,
): { readonly reason: 'missing_build_info' | 'unknown_build_commit' } | null {
  // Only soft-warn for git-cloned installs. Tarball/npm-registry
  // installs never have .git/ and can't benefit from `npm run build`.
  if (!existsSync(join(packageRoot, '.git'))) return null;

  const info = readBuildInfo(packageRoot);
  if (info === null) return { reason: 'missing_build_info' };
  if (info.commit === 'unknown') return { reason: 'unknown_build_commit' };

  // Info is present and genuine — stale-detect is the right check for
  // drift, not this function.
  return null;
}

/**
 * Result of `detectCheckoutCurrency` (groundnuty/macf#1376) — the layer
 * neither `detectStaleDist` nor `checkDistributedScriptCurrency`/
 * `checkDistributedRuleCurrency` (doctor.ts) cover: is `projectDir` (the
 * workspace being doctored) itself behind the canonical branch of the macf
 * framework's own source repo — asked ONLY when `projectDir` IS that repo.
 *
 * **Why this targets `projectDir`, not `packageRoot`, despite the issue's own
 * "packageRoot IS the repo" framing:** an earlier version of this function
 * targeted `packageRoot` (`findCliPackageRoot()`) directly, mirroring
 * `detectStaleDist`'s parameter. That is wrong for the deployed fleet:
 * verified empirically against a live substrate workspace
 * (`groundnuty/macf#1376`'s own investigation) that `macf` is installed via
 * `npm i -g @groundnuty/macf` — a real, ordinary global npm package with
 * **zero directory relationship** to the git checkout it operates on
 * (`findCliPackageRoot()` resolves under `.npm-global/lib/node_modules/...`,
 * which isn't inside any git working tree at all). A `packageRoot`-only
 * check — or even a path-identity check between `packageRoot` and
 * `projectDir` — would NEVER fire for that real, common topology: the
 * fix would ship, pass every fixture-based test, and do nothing for the
 * actual reported problem (the `assert-the-wrong-path.md`
 * reached-vs-written class).
 *
 * The identity question this function actually needs to answer — "is
 * `projectDir` a checkout of the SAME package this running CLI is built
 * from" — is answered by CONTENT, not by PATH: does `projectDir` (or its
 * `packages/macf/` monorepo subdirectory) carry a `package.json` whose
 * `name` matches `packageRoot`'s own `package.json` `name`. This is
 * path-independent — it fires correctly whether the CLI is dev-linked
 * in-place, globally npm-installed, or reached via `npx`, as long as
 * `projectDir` really is the framework's own source.
 *
 *   - `not-a-checkout` — EITHER `projectDir` isn't inside a git working tree
 *     at all, OR its package identity doesn't match `packageRoot`'s (an
 *     unrelated consumer project, or a workspace where the identity marker
 *     can't be read). Nothing to report — this is what keeps the check off
 *     for both npm-installed consumers (their `package.json` name is their
 *     own project's, never `packageRoot`'s) and for any git-tracked
 *     directory that just isn't this framework's own source.
 *   - `no-upstream`    — a git checkout of this framework's own source, but
 *     with no `origin` remote configured at all. Honest-unknown, never
 *     reported as current.
 *   - `unreadable`     — an `origin` remote exists, but
 *     `origin/<canonicalBranch>` doesn't resolve locally (never fetched, or
 *     the canonical branch name is misconfigured) — genuinely reachable in
 *     the real world, unlike a prior `@{u}`-based design where this branch
 *     turned out to be dead code (see the git history of this file).
 *     Honest-unknown.
 *   - `ok`             — `commitCount` is the number of commits reachable
 *     from `origin/<canonicalBranch>` that HEAD lacks (`git rev-list
 *     --count HEAD..origin/<canonicalBranch>` — a literal, hardcoded-shape
 *     comparison, matching the issue's own worked example
 *     `git rev-list --count HEAD..origin/main`, NOT `@{u}`: `@{u}` is the
 *     upstream of whatever branch happens to be checked out, which is
 *     commonly unconfigured on a throwaway/feature/worktree branch — verified
 *     on this very repo's own agent-worktree branches — and would report
 *     `no-upstream` even when the workspace genuinely IS behind canonical).
 *     `0` IS current; any other number is the signal, reported as-is — no
 *     invented "stale enough" threshold.
 *
 * Every git call here is read-only and local (`rev-parse`, `remote
 * get-url`, `rev-list`) — this function never fetches. `upstream` names the
 * ref the comparison actually ran against (`origin/<canonicalBranch>`);
 * that ref is only as fresh as the last fetch, which is a fact about the
 * ref, not something this function can improve on without violating "must
 * not fetch implicitly."
 */
export type CheckoutCurrencyResult =
  | { readonly kind: 'not-a-checkout' }
  | { readonly kind: 'no-upstream' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'ok'; readonly upstream: string; readonly commitCount: number };

/**
 * Runs a read-only git subcommand in `cwd`; returns `null` on any failure
 * (never throws). Injectable seam — same shape as `proc-scan.ts`'s
 * `ProcReader` — so tests can drive branches without depending on real git
 * plumbing for every case.
 */
export type GitRunner = (args: readonly string[], cwd: string) => string | null;

export const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

/** Read `<dir>/package.json`'s `name` field. `null` on any failure (missing, malformed, no `name`). */
function readPkgName(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : null;
  } catch {
    return null;
  }
}

/**
 * Determine how far `projectDir`'s HEAD is behind `origin/<canonicalBranch>`
 * — but ONLY when `projectDir` is actually a checkout of the SAME package
 * `packageRoot` (the running CLI's own source) is built from. See the
 * `CheckoutCurrencyResult` doc comment above for the full rationale,
 * including why this targets `projectDir` by content-identity rather than
 * `packageRoot` by path (groundnuty/macf#1376).
 */
export function detectCheckoutCurrency(
  projectDir: string,
  packageRoot: string,
  canonicalBranch: string,
  gitRunner: GitRunner = defaultGitRunner,
): CheckoutCurrencyResult {
  const ownName = readPkgName(packageRoot);
  if (ownName === null) {
    // Can't even determine our own identity — defensive; a broken/stripped
    // install shouldn't crash the report, just report nothing to compare.
    return { kind: 'not-a-checkout' };
  }

  // The real monorepo layout: `packages/macf/package.json` carries the
  // identity marker, NOT the workspace root's own `package.json` (which is
  // the monorepo-tooling package, e.g. "macf-monorepo" — a DIFFERENT name).
  // Check both so a non-monorepo fork (identity marker at the root) also
  // matches.
  const rootName = readPkgName(projectDir);
  const monorepoSubdirName = readPkgName(join(projectDir, 'packages', 'macf'));
  if (rootName !== ownName && monorepoSubdirName !== ownName) {
    return { kind: 'not-a-checkout' };
  }

  const insideWorkTree = gitRunner(['rev-parse', '--is-inside-work-tree'], projectDir);
  if (insideWorkTree !== 'true') {
    return { kind: 'not-a-checkout' };
  }

  const originUrl = gitRunner(['remote', 'get-url', 'origin'], projectDir);
  if (originUrl === null || originUrl.length === 0) {
    return { kind: 'no-upstream' };
  }

  const upstream = `origin/${canonicalBranch}`;
  const countRaw = gitRunner(['rev-list', '--count', `HEAD..${upstream}`], projectDir);
  if (countRaw === null || !/^\d+$/.test(countRaw)) {
    return {
      kind: 'unreadable',
      reason: `\`git rev-list --count HEAD..${upstream}\` did not return a readable count`,
    };
  }

  return { kind: 'ok', upstream, commitCount: Number(countRaw) };
}
