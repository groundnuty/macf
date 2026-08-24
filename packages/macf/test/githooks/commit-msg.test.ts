/**
 * Tests for `.githooks/commit-msg` — the local commitlint pre-commit
 * hook added per #158.
 *
 * The hook is git's standard commit-msg mechanism: git invokes it with
 * the path to a file containing the staged commit message. Exit 0 =
 * commit proceeds; non-zero = commit aborted. Our hook runs
 * `node_modules/.bin/commitlint --edit <file> --config commitlint.config.mjs`
 * against the message and inherits its exit code.
 *
 * Smoke-tests the three failure classes that bit us 3 times in recent
 * PRs (length, type, case), plus the valid-happy-path baseline, plus
 * the defensive "missing commitlint in node_modules" fall-through.
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Four levels up: test/githooks/ → test/ → packages/macf/ → packages/ →
// monorepo root where .githooks/ + commitlint.config.mjs live (post #206).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hookPath = join(repoRoot, '.githooks', 'commit-msg');

function runHook(msg: string): ReturnType<typeof spawnSync> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'macf-commit-msg-'));
  const msgFile = join(tmpDir, 'msg');
  writeFileSync(msgFile, msg);
  try {
    return spawnSync('bash', [hookPath, msgFile], {
      encoding: 'utf-8',
      cwd: repoRoot,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Async twin of `runHook`, used ONLY by the enum-sweep test below so its 13
 * invocations can run concurrently instead of serially — see that test's
 * comment for why (macf#1133). Same subprocess, same real hook, same
 * temp-file setup; only the scheduling differs.
 */
function runHookAsync(msg: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'macf-commit-msg-'));
  const msgFile = join(tmpDir, 'msg');
  writeFileSync(msgFile, msg);
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', [hookPath, msgFile], { cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (status) => {
      rmSync(tmpDir, { recursive: true, force: true });
      resolvePromise({ status, stdout, stderr });
    });
  });
}

describe('.githooks/commit-msg (#158)', () => {
  describe('happy path', () => {
    it('allows a valid conventional commit subject', () => {
      const r = runHook('feat: valid subject\n');
      expect(r.status).toBe(0);
    });

    it('allows a subject with a valid scope', () => {
      const r = runHook('security(hooks): block bash -c bypass\n');
      expect(r.status).toBe(0);
    });

    it('allows each type in the commitlint enum', { timeout: 30_000 }, async () => {
      // groundnuty/macf#1133 — this test was NOT a contention flake. Each
      // spawn execs the real `.githooks/commit-msg`, which execs
      // commitlint, and loading commitlint's ESM module graph (cli, load,
      // lint, parse, rules, config-conventional, + their transitive deps —
      // ~18 @commitlint/* packages plus yargs/ajv/cosmiconfig et al.) costs
      // ~1.3–2.7s per spawn on an IDLE box, confirmed via `node --prof` +
      // `--prof-process`: the dominant cost is `ModuleWrap::New` + the
      // filesystem stat/read calls ESM resolution makes walking that graph
      // — not V8 compile time (NODE_COMPILE_CACHE made it slower, not
      // faster, once measured). That's inherent to commitlint's package
      // shape; nothing in this repo can cheaply shrink it without bundling
      // commitlint itself, which is out of scope here (and fragile against
      // upstream commitlint updates).
      //
      // The old code ran all 13 as SEQUENTIAL `spawnSync` calls, so the
      // test's own total cost was ~13× the per-spawn cost — 20–34s against
      // a 30s ceiling, i.e. sitting AT its budget on an idle box already,
      // before a single other test file added contention. The 30_000
      // number here was consequently not a real margin — it was a coin
      // flip. Compounding it: this inline `{ timeout: 30_000 }` overrides
      // `--testTimeout` from the CLI, so "raise the timeout and re-run"
      // changed nothing, all session.
      //
      // The fix is concurrency, not a bigger number: the 13 invocations
      // below run as PARALLEL `spawn` calls (`runHookAsync` + `Promise.all`)
      // instead of a sequential loop, so the test's wall time is bounded by
      // the slowest single spawn plus scheduling overhead, not the sum of
      // all 13. Measured on this box (16 cores): ~3.9-4.4s unconstrained,
      // ~11.5s capped at 2 concurrent (`xargs -P2`, modeling a small CI
      // runner), ~7.2s at 4, ~5.5s at 8 — vs. ~21s sequential regardless of
      // core count. The 30s ceiling is kept as a genuine hang-detector: at
      // the worst measured (2-core-capped) figure it now represents ~2.6×
      // real margin, not ~1× budget-matching. Every commitlint type is
      // still individually exercised through the real hook subprocess —
      // no coverage was traded for speed (see #1103's "stabilise by
      // checking less" caution).
      const validTypes = [
        'feat', 'fix', 'security', 'reliability', 'refactor',
        'perf', 'docs', 'test', 'chore', 'ci', 'revert', 'build', 'style',
      ];
      const results = await Promise.all(
        validTypes.map((t) => runHookAsync(`${t}: example subject\n`)),
      );
      results.forEach((r, i) => {
        expect(r.status, `type ${validTypes[i]} should be valid`).toBe(0);
      });
    });
  });

  describe('reject path — catches the violations from recent PRs', () => {
    it('rejects a subject exceeding the 100-char length limit (#131 shape)', () => {
      const longSubject = 'feat: ' + 'x'.repeat(105);
      const r = runHook(`${longSubject}\n`);
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/header must not be longer|max-length/i);
    });

    it('rejects a type not in the enum (#132 shape — pre-`reliability`)', () => {
      const r = runHook('nope: bad type\n');
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/type-enum|type must be one of/i);
    });

    it('rejects a subject with start-case/upper-case proper noun (#157 shape)', () => {
      const r = runHook('docs: CHANGELOG updates for release\n');
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/subject-case|must not be/i);
    });
  });

  describe('defensive no-op', () => {
    it('exits cleanly when invoked with no argument', () => {
      const r = spawnSync('bash', [hookPath], { encoding: 'utf-8', cwd: repoRoot });
      // The hook warns and exits 0 — a broken invocation must not block commits.
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/expected commit message file/);
    });
  });
});
