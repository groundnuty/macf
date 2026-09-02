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

// A directory that certainly doesn't exist on disk — the resolver functions
// are pure path-joins (`join(packageRoot, ...)`), so calling them against a
// synthetic root and computing the RELATIVE path is enough; nothing here
// touches the filesystem.
const FAKE_ROOT = join('__fake_pkg_root_macf_1403__');

const dirResolverNames = Object.keys(rulesModule).filter((k) => /^canonical.*Dir$/.test(k));

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
  // --dry-run --json --offline` is cheap (~1.5s locally, no network) and
  // asserts the ACTUAL packed tarball, not just the declared intent.
  it('npm pack --dry-run includes a real plugin/scripts/ hook script (the actual tarball, not just files[])', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--offline'], {
      cwd: packageRoot,
      encoding: 'utf-8',
      timeout: 20_000,
    });
    const parsed = JSON.parse(raw) as readonly { readonly files: readonly { readonly path: string }[] }[];
    const paths = new Set(parsed[0].files.map((f) => f.path));
    expect(
      paths.has('plugin/scripts/check-gh-token.sh'),
      'expected the packed tarball to contain plugin/scripts/check-gh-token.sh — the #140 attribution-trap ' +
        'guard, and a stand-in for the whole PreToolUse guard family that lives in plugin/scripts/. See ' +
        'groundnuty/macf#1403.',
    ).toBe(true);
  });
});
