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
 * `checkDistributedRuleCurrency` (doctor.ts) cover: is `packageRoot`'s OWN
 * git checkout behind the canonical branch it tracks. `detectStaleDist`
 * compares the BUILT `dist/` stamp against `packageRoot`'s own HEAD (a
 * rebuild-freshness question); this compares `packageRoot`'s HEAD against
 * its configured upstream (a checkout-currency question). Distinct axes,
 * same `packageRoot` parameter.
 *
 *   - `not-a-checkout` — `packageRoot` is not inside a git working tree (an
 *     npm-registry/tarball install, or an unpacked global/local npm
 *     package). Nothing to report — the expected, healthy shape for an
 *     installed CLI. This is what makes the check NOT fire for npm-installed
 *     consumers.
 *   - `no-upstream`    — inside a git working tree, but the current branch
 *     has no configured upstream (`@{u}` unresolvable — includes a detached
 *     HEAD). Honest-unknown, never reported as current.
 *   - `unreadable`     — an upstream is configured but the count itself
 *     could not be read (git error). Honest-unknown.
 *   - `ok`             — `commitCount` is the number of commits reachable
 *     from `upstream` that HEAD lacks (`git rev-list --count
 *     HEAD..<upstream>`). `0` IS current; any other number is the signal,
 *     reported as-is — no invented "stale enough" threshold.
 *
 * Every git call here is read-only and local (`rev-parse`, `rev-list`) —
 * this function never fetches. `upstream` names the ref the comparison
 * actually ran against (typically `origin/<branch>`); that ref is only as
 * fresh as the last fetch, which is a fact about the ref, not something
 * this function can improve on without violating "must not fetch
 * implicitly."
 */
export type CheckoutCurrencyResult =
  | { readonly kind: 'not-a-checkout' }
  | { readonly kind: 'no-upstream' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'ok'; readonly upstream: string; readonly commitCount: number };

/**
 * Runs a read-only git subcommand in `cwd`; returns `null` on any failure
 * (never throws). Injectable seam — same shape as `proc-scan.ts`'s
 * `ProcReader` — so `detectCheckoutCurrency`'s harder-to-construct-for-real
 * branches (see `unreadable` below) are testable without needing a git
 * failure mode that real git can actually be coaxed into producing.
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

/**
 * Determine how far `packageRoot`'s HEAD is behind its configured upstream.
 * Ancestor-aware — unlike `detectStaleDist`'s `existsSync(join(dir, '.git'))`
 * gate, `git rev-parse --is-inside-work-tree` walks UP from `packageRoot`
 * the same way every other git command does. That difference matters for
 * THIS CLI's own real layout: `packageRoot` (from `findCliPackageRoot`) is
 * `packages/macf/` in a dev/npm-link install, and `.git/` lives at the
 * monorepo root — one level up, not inside `packages/macf/` itself. A
 * direct-existence gate never detects that as a checkout at all, which is
 * exactly how #144's build-freshness check "never reaches" the real
 * monorepo checkout shape (see groundnuty/macf#1376).
 *
 * `unreadable` is a defensive branch, not one real git can be coaxed into
 * hitting: empirically, `@{u}` resolution is atomic — if it names an
 * upstream at all, that upstream already resolves to a real commit, so the
 * subsequent `rev-list --count` essentially cannot fail (verified: a
 * dangling upstream config with the tracking ref deleted makes `@{u}` ITSELF
 * fail with "no such branch", collapsing into `no-upstream` rather than
 * reaching this branch). It stays as a guard against a non-numeric
 * `rev-list` result from a future/unexpected git output shape — exercised
 * in tests via the injected `gitRunner` seam, not a constructed real
 * checkout, since no real one reaches it.
 */
export function detectCheckoutCurrency(
  packageRoot: string,
  gitRunner: GitRunner = defaultGitRunner,
): CheckoutCurrencyResult {
  const insideWorkTree = gitRunner(['rev-parse', '--is-inside-work-tree'], packageRoot);
  if (insideWorkTree !== 'true') {
    return { kind: 'not-a-checkout' };
  }

  const upstream = gitRunner(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], packageRoot);
  if (upstream === null || upstream.length === 0) {
    return { kind: 'no-upstream' };
  }

  const countRaw = gitRunner(['rev-list', '--count', `HEAD..${upstream}`], packageRoot);
  if (countRaw === null || !/^\d+$/.test(countRaw)) {
    return {
      kind: 'unreadable',
      reason: `\`git rev-list --count HEAD..${upstream}\` did not return a readable count`,
    };
  }

  return { kind: 'ok', upstream, commitCount: Number(countRaw) };
}
