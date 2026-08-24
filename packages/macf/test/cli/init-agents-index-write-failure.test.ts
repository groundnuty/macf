import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, existsSync } from 'node:fs';

/**
 * macf#1135 — a failure to write the global agents index (e.g. EROFS on a
 * read-only $HOME) must not present as a DIFFERENT failure downstream.
 * Before this fix, `addToAgentsIndex(absDir)` in `init.ts` was called
 * unguarded — a throw there aborted `initAgent` before `.claude/settings.json`
 * (or anything else written after that call) ever landed. The visible
 * symptom was "settings file missing", not "could not write your home
 * directory" — the wrong diagnosis, pointing at the wrong file.
 *
 * A genuine read-only-$HOME rehearsal isn't feasible in-process for this
 * repo: `config.ts`'s `AGENTS_INDEX_PATH` is a module-scope const resolved
 * from `homedir()` at IMPORT time (see the comment on `init.test.ts`'s
 * `skipCertIfPresent` describe block), so neither `vi.stubEnv('HOME', …)`
 * nor a plain `process.env.HOME` mutation redirects it once the module has
 * loaded — and a subprocess CLI invocation can't resolve this project's
 * `.js`-suffixed ESM imports without a build this repo's own verification
 * steps don't run first. So this file simulates the SAME failure SHAPE —
 * the write throwing — via dependency injection on `addToAgentsIndex`
 * itself. That's functionally equivalent from `initAgent`'s point of view:
 * the catch block only ever reads `err.message`, so a mocked EROFS-shaped
 * Error and a genuine EROFS from a real read-only $HOME hit the exact same
 * branch.
 */
vi.mock('../../src/cli/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/config.js')>();
  return {
    ...actual,
    addToAgentsIndex: vi.fn(actual.addToAgentsIndex),
  };
});

// Imported AFTER the mock factory (vitest hoists `vi.mock` above imports
// regardless of source order, but importing post-mock keeps the file
// readable top-to-bottom) — this binding is the SAME vi.fn `initAgent`
// calls internally, so overriding its implementation affects the real call.
import { addToAgentsIndex } from '../../src/cli/config.js';
import { initAgent } from '../../src/cli/commands/init.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-init-idxfail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('macf init — a failing agents-index write is non-fatal (macf#1135)', () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = tempDir();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    warnSpy.mockRestore();
    vi.mocked(addToAgentsIndex).mockReset();
  });

  it('reports the failure at the index write and lets init proceed — .claude/settings.json still lands, and the warning names the index, not the settings file', async () => {
    vi.mocked(addToAgentsIndex).mockImplementationOnce(() => {
      throw new Error("EROFS: read-only file system, mkdir '/home/x/.macf'");
    });

    await expect(initAgent(dir, {
      project: 'TEST',
      role: 'code-agent',
      appId: '123',
      installId: '456',
      keyPath: '.key.pem',
      registryType: 'repo',
      registryRepo: 'owner/repo',
      cliVersion: '0.1.0',
      pluginVersion: '0.1.0',
      actionsVersion: 'v1',
    })).resolves.not.toThrow();

    // The step immediately downstream of the index write must still have
    // run — before this fix, an unguarded throw here aborted init before
    // .claude/settings.json (or anything after it) was ever written.
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);

    const warned = warnSpy.mock.calls.flat().join('\n');
    // Names the actual failure (the index write + the underlying error) —
    // not the exact misdiagnosis this fix closes ("settings file missing").
    expect(warned).toMatch(/global agents index/);
    expect(warned).toMatch(/EROFS/);
    expect(warned).not.toMatch(/settings\.json/);
  }, 20000);
});
