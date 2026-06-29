/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/bootstrap-cleanup.sh`
 * — shred-then-removes the ENTIRE `.bootstrap-work/` scratch dir (per-agent
 * `*.app.json` PEMs, any `vault.plain`, `vault.age`, the `vault-age-key.txt`,
 * `spec.json`). Idempotent; `rm -rf` is authoritative even when `shred` is a
 * no-op/absent (macOS/APFS); runs on abort when wired as an EXIT trap.
 * (science's #659 secrets-on-disk review, DR-035 §4.)
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const SCRIPT = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'scripts', 'bootstrap-cleanup.sh');

/** Build a populated `.bootstrap-work/` dir with the full set of scratch secrets. */
function makeWorkDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'macf-bs-cleanup-'));
  const work = join(root, '.bootstrap-work');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'code-agent.app.json'), '{"pem":"-----BEGIN PRIVATE KEY-----"}');
  writeFileSync(join(work, 'science-agent.app.json'), '{"pem":"-----BEGIN PRIVATE KEY-----"}');
  writeFileSync(join(work, 'vault.plain'), 'SECRET="x"\n');
  writeFileSync(join(work, 'vault.age'), 'ENCRYPTED');
  writeFileSync(join(work, 'vault-age-key.txt'), 'AGE-SECRET-KEY-1STUB');
  writeFileSync(join(work, 'spec.json'), '{}');
  return work;
}

/** Optional stub bin whose `shred` exits non-zero, simulating macOS/APFS no-op/fail. */
function makeFailingShredBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bs-cleanup-bin-'));
  writeFileSync(join(dir, 'shred'), '#!/usr/bin/env bash\necho "shred: simulated failure" >&2\nexit 1\n');
  chmodSync(join(dir, 'shred'), 0o755);
  return dir;
}

function run(args: readonly string[], extraPath?: string): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [SCRIPT, ...args], {
    env: { PATH: `${extraPath ? `${extraPath}:` : ''}${process.env['PATH'] ?? ''}` },
    encoding: 'utf-8',
  });
}

describe('bootstrap-cleanup.sh', () => {
  it('wipes the ENTIRE .bootstrap-work/ (app.json PEMs, vault.age, age key, spec)', () => {
    const work = makeWorkDir();
    try {
      // sanity: the secrets exist before cleanup
      expect(existsSync(join(work, 'code-agent.app.json'))).toBe(true);
      expect(existsSync(join(work, 'vault-age-key.txt'))).toBe(true);
      const r = run(['--work-dir', work]);
      expect(r.status).toBe(0);
      // the whole dir (and every secret in it) is gone
      expect(existsSync(work)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second run on a missing dir is a clean no-op (exit 0)', () => {
    const work = makeWorkDir();
    try {
      expect(run(['--work-dir', work]).status).toBe(0);
      expect(existsSync(work)).toBe(false);
      const r2 = run(['--work-dir', work]);
      expect(r2.status).toBe(0);
      expect(r2.stderr).toContain('nothing to clean');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('rm -rf is authoritative even when shred fails (macOS/APFS no-op simulation)', () => {
    const work = makeWorkDir();
    const failShred = makeFailingShredBin();
    try {
      const r = run(['--work-dir', work], failShred);
      expect(r.status).toBe(0);
      expect(existsSync(work)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(failShred, { recursive: true, force: true });
    }
  });

  it('refuses (exit 2) a --work-dir that exists but is not a directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'macf-bs-cleanup-nf-'));
    const f = join(root, 'afile');
    writeFileSync(f, 'x');
    try {
      const r = run(['--work-dir', f]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('not a directory');
      expect(existsSync(f)).toBe(true); // untouched
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors CLAUDE_PROJECT_DIR for the default work dir', () => {
    const work = makeWorkDir();
    const projectDir = resolve(work, '..'); // work = <projectDir>/.bootstrap-work
    try {
      const r = spawnSync('bash', [SCRIPT], {
        env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: projectDir },
        encoding: 'utf-8',
      });
      expect(r.status).toBe(0);
      expect(existsSync(work)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('runs on a simulated abort when wired as an EXIT trap', () => {
    // Mirrors SKILL.md Step 7: `trap '<cleanup>' EXIT` so an aborted run (exit 1
    // before reaching the explicit cleanup) still wipes the scratch dir.
    const work = makeWorkDir();
    const root = resolve(work, '..');
    const wrapper = join(root, 'aborting-run.sh');
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash
set -euo pipefail
trap '"${SCRIPT}" --work-dir "${work}"' EXIT
echo "simulating an aborted bootstrap run" >&2
exit 1
`,
    );
    chmodSync(wrapper, 0o755);
    try {
      const r = spawnSync('bash', [wrapper], { env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf-8' });
      expect(r.status).toBe(1); // the run aborted...
      expect(existsSync(work)).toBe(false); // ...but the EXIT trap still cleaned up
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
