/**
 * Packaging seam test (groundnuty/macf#1403): every directory the copy
 * primitives (`copyCanonicalRules` / `copyCanonicalScripts`, rules.ts) read
 * from `packageRoot` at runtime must be covered by `package.json`'s
 * `files[]` — otherwise a real `npm publish` silently omits it from the
 * tarball. That is exactly what happened to `plugin/scripts/` on every
 * release through 0.2.59: the `files[]` entry was never added when the 7
 * load-bearing hook scripts moved there in #749, so `macf init` / `macf
 * update` / `rules refresh` from an npm-installed CLI silently distributed 0
 * of the 14 scripts that live there (including the entire PreToolUse guard
 * family: `check-gh-token.sh`, `check-mention-routing.sh`, ...) and reported
 * success — `listDistributedScriptNames` / `copyCanonicalScripts` skip a
 * missing source dir individually, so nothing about the *count* looked wrong
 * from inside a repo checkout where both dirs happen to exist.
 *
 * The read set below is DERIVED FROM THE CODE, not hand-listed as path
 * strings: every export from `rules.ts` whose name matches
 * `/^canonical.*Dir$/` is a directory-resolver function the copy primitives
 * read from `packageRoot` (`canonicalRulesDir`, `canonicalScriptsDir`,
 * `canonicalPluginScriptsDir` today). A future 5th resolver export is picked
 * up automatically by this filter — the population this test checks is
 * never a fixed list an author could add a new source dir without also
 * updating.
 *
 * TIMEOUT BUDGET (groundnuty/macf#1417, test-timeout-discriminator.md branch
 * 3 — a budget set without measuring the cost under the load the gate
 * always runs under). The tarball-membership check below spawns a REAL
 * `npm pack --dry-run --json --offline` — the only actual `npm` subprocess
 * anywhere in this package's ~240-file test suite (`grep -rn
 * "execFileSync(\s*['\"]npm" test/` confirms it; no other file spawns it).
 * Measured wall time (2026-09-02, this devbox):
 *   - idle, nothing else running:                                ~1.4-1.65s (3 runs)
 *   - inside a full `vitest run` of this package (240 files,
 *     this box's 16 real cores):                                  ~2.28s
 *   - inside a full `vitest run`, `taskset -c 0-3` (approximates
 *     a 4-vCPU GitHub-hosted runner's core count):                 ~1.43s
 * None of those reproduce the actual failure: three real CI/staging runs
 * hit `spawnSync npm ETIMEDOUT` against the previous 20_000ms budget
 * (#1408's original value, set without measurement). This box's
 * contention profile evidently isn't a faithful stand-in for whatever the
 * GitHub-hosted runner was doing at the time (this suite's own 65 other
 * subprocess-spawning test files are the leading suspect, but the spike
 * wasn't reproducible here even under a throttled 4-core run of the whole
 * suite) — so the new budget below is sized off the WORST REAL evidence
 * (a confirmed >20_000ms spike), not off the much lower numbers this box
 * reproduces: 90_000ms, ~4.5x the budget that already failed three times,
 * ~40-60x every wall time actually measured here.
 *
 * There is only ONE `npm pack` spawn in this file (and in the whole
 * package's test suite) — no redundant per-assertion re-spawn to memoize
 * away. `packedTarballFiles()` below still caches the result at module
 * scope so a future second assertion against the same tarball listing
 * shares this one spawn instead of paying for a second, rather than
 * re-deriving a budget from scratch at that point.
 *
 * Both `execFileSync`'s own `timeout` AND this test's inline vitest
 * timeout are set to PACK_SPAWN_TIMEOUT_MS. `execFileSync`'s own timeout is
 * what actually governs in practice: `spawnSync` blocks the event loop
 * synchronously for its whole duration, so vitest's own testTimeout (a
 * `setTimeout` race) never gets a turn to preempt it mid-call — the
 * observed `spawnSync npm ETIMEDOUT` message can only originate from
 * `execFileSync`'s own `timeout` option firing, confirming the real
 * underlying `npm` process is what took >20s, not a vitest scheduling
 * artifact. The inline `it(..., { timeout })` override is set anyway as a
 * defensive backstop against relying on that blocking-event-loop detail:
 * per test-timeout-discriminator.md's corollary, an inline timeout
 * silently outranks `--testTimeout` — intentional here (this test's real
 * budget must exceed the package-level 20_000ms default regardless of
 * which mechanism ends up enforcing it), not the footgun the corollary
 * otherwise warns about.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rulesModule from '../src/cli/rules.js';

// Mirrors test/package-version.test.ts's own walk-up convention: test/ and
// src/ both sit one level below the package root, so this resolves the same
// package.json rules.ts's own `findCliPackageRoot()` would in dev layout —
// without depending on that function's own (correct, but separately tested)
// walk-up behavior.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8')) as {
  readonly files: readonly string[];
};

// See header comment for the measured numbers behind this value.
const PACK_SPAWN_TIMEOUT_MS = 90_000;

// A directory that certainly doesn't exist on disk — the resolver functions
// are pure path-joins (`join(packageRoot, ...)`), so calling them against a
// synthetic root and computing the RELATIVE path is enough; nothing here
// touches the filesystem.
const FAKE_ROOT = join('__fake_pkg_root_macf_1403__');

const dirResolverNames = Object.keys(rulesModule).filter((k) => /^canonical.*Dir$/.test(k));

let packedFilesCache: ReadonlySet<string> | undefined;

/**
 * The REAL packed-tarball file list, from `npm pack --dry-run --json
 * --offline` — memoised at module scope (see header comment) so a future
 * second assertion against the same listing wouldn't re-spawn `npm`.
 */
function packedTarballFiles(): ReadonlySet<string> {
  if (packedFilesCache) return packedFilesCache;
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--offline'], {
    cwd: packageRoot,
    encoding: 'utf-8',
    timeout: PACK_SPAWN_TIMEOUT_MS,
  });
  const parsed = JSON.parse(raw) as readonly { readonly files: readonly { readonly path: string }[] }[];
  packedFilesCache = new Set(parsed[0].files.map((f) => f.path));
  return packedFilesCache;
}

/**
 * Why `plugin/{agents,hooks,skills}` are deliberately NOT in `files[]` — read this
 * before "fixing" the omission (an auditor re-derived it from a tarball listing
 * once, 2026-09-03):
 *
 *   The npm package is not the plugin's distribution channel. The plugin ships
 *   via `groundnuty/macf-marketplace` — `marketplace-sync.ts` pushes
 *   `agents/ hooks/ scripts/ skills/` from this repo to the marketplace at
 *   release, and `fetchPluginToWorkspace` clones the pinned tag into a
 *   workspace's `.macf/plugin/`, which is what `--plugin-dir` mounts. That is
 *   where every consumer's hook REGISTRATIONS (`hooks/hooks.json`) come from.
 *
 *   `plugin/rules/` and `plugin/scripts/` are in `files[]` for one reason only:
 *   they are the SOURCES `rules refresh` / `copyCanonicalScripts` copy into a
 *   workspace's `.claude/` as the compat layer. No code reads `plugin/hooks`
 *   (or agents, or skills) from the package root — the seam test below derives
 *   the read-set from the `canonical*Dir` resolvers precisely so that the
 *   packaged set equals the set that is actually read, nothing more.
 */
describe('packaging: canonical source dirs are covered by package.json files[] (groundnuty/macf#1403)', () => {
  it('sanity: the derivation found at least the known resolvers (rules.ts exports haven\'t silently changed shape)', () => {
    expect(dirResolverNames).toEqual(
      expect.arrayContaining(['canonicalRulesDir', 'canonicalScriptsDir', 'canonicalPluginScriptsDir']),
    );
    expect(dirResolverNames.length).toBeGreaterThanOrEqual(3);
  });

  it.each(dirResolverNames)('%s() is covered by package.json files[]', (name) => {
    const resolver = (rulesModule as unknown as Record<string, (packageRoot: string) => string>)[name];
    const abs = resolver(FAKE_ROOT);
    // Relative, POSIX-slash form with a trailing slash — the shape a
    // directory entry takes in an npm `files[]` array (e.g. "plugin/scripts/").
    const rel = relative(FAKE_ROOT, abs).split(sep).join('/') + '/';
    expect(
      pkg.files,
      `expected package.json files[] to contain "${rel}" (from ${name}()) — without it, a real ` +
        `npm publish silently omits every file under ${rel} from the tarball. See groundnuty/macf#1403.`,
    ).toContain(rel);
  });

  // The derived-read-set check above is a pure package.json/rules.ts
  // comparison — it can't detect an npm packaging quirk (a .npmignore
  // entry, an npm bug) that excludes a covered dir anyway. `npm pack
  // --dry-run --json --offline` asserts the ACTUAL packed tarball, not just
  // the declared intent. See the header comment for the timeout budget.
  it(
    'npm pack --dry-run includes a real plugin/scripts/ hook script (the actual tarball, not just files[])',
    { timeout: PACK_SPAWN_TIMEOUT_MS },
    () => {
      expect(
        packedTarballFiles().has('plugin/scripts/check-gh-token.sh'),
        'expected the packed tarball to contain plugin/scripts/check-gh-token.sh — the #140 attribution-trap ' +
          'guard, and a stand-in for the whole PreToolUse guard family that lives in plugin/scripts/. See ' +
          'groundnuty/macf#1403.',
      ).toBe(true);
    },
  );
});
