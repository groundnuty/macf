/**
 * Tests for `packages/macf/scripts/sync-bootstrap-product.mjs` (groundnuty/macf#657).
 *
 * The publish-sync helper mirrors the develop-in-monorepo dev source
 * (`tools/macf-bootstrap/`) into a checkout of the SEPARATE product repo
 * `groundnuty/macf-automated-github-setup` (DR-035 §7 Option B). Invoked as a
 * subprocess (mirroring the bootstrap-*.sh test harness), with `--source` used
 * to drive a synthetic source for the exclusion test so the real source / git
 * working tree is never touched.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const PKG_ROOT = findCliPackageRoot(); // packages/macf
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SCRIPT = join(PKG_ROOT, 'scripts', 'sync-bootstrap-product.mjs');
const REAL_SOURCE = join(REPO_ROOT, 'tools', 'macf-bootstrap');

/** Invoke the sync helper as a subprocess via the running node binary. */
function run(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env['PATH'] ?? '' },
    encoding: 'utf-8',
  });
}

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(base: string, rel: string, content: string, mode?: number): void {
  const path = join(base, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

describe('sync-bootstrap-product.mjs — mirror the real dev source', () => {
  it('publishes sampled source files (preserving exec bit), prunes target-only files, never touches .git/', () => {
    const target = mkTmp('macf-bs-sync-tgt-');
    try {
      // Pre-existing target state: a .git/ history sentinel (must survive) and a
      // stale file not in the source (must be pruned — true mirror).
      write(target, '.git/HEAD', 'ref: refs/heads/main\n');
      write(target, 'stale-file.txt', 'left over from a prior publish\n');

      const r = run(['--target', target]);
      expect(r.status).toBe(0);

      // Sampled real source files are present.
      for (const rel of [
        '.claude/settings.json',
        '.claude/skills/macf-bootstrap/SKILL.md',
        '.claude/scripts/bootstrap-cleanup.sh',
        'README.md',
      ]) {
        expect(existsSync(join(target, rel))).toBe(true);
      }
      // The .sh keeps its executable bit.
      expect(statSync(join(target, '.claude/scripts/bootstrap-cleanup.sh')).mode & 0o111).not.toBe(0);

      // The target's own git history is untouched.
      expect(existsSync(join(target, '.git/HEAD'))).toBe(true);
      expect(readFileSync(join(target, '.git/HEAD'), 'utf-8')).toBe('ref: refs/heads/main\n');

      // The stale target-only file was pruned.
      expect(existsSync(join(target, 'stale-file.txt'))).toBe(false);

      // No scratch/secret surfaces leaked from the real source.
      expect(existsSync(join(target, '.bootstrap-work'))).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('sync-bootstrap-product.mjs — --check gate', () => {
  it('exits 0 when in sync, exits 1 after a target file is mutated or removed', () => {
    const target = mkTmp('macf-bs-check-tgt-');
    try {
      expect(run(['--target', target]).status).toBe(0); // publish first
      expect(run(['--check', '--target', target]).status).toBe(0); // now in sync

      // Mutate a published file -> out of sync.
      const readme = join(target, 'README.md');
      writeFileSync(readme, `${readFileSync(readme, 'utf-8')}\n<drift>\n`);
      const mutated = run(['--check', '--target', target]);
      expect(mutated.status).toBe(1);
      expect(mutated.stderr).toContain('OUT OF SYNC');
      expect(mutated.stderr).toContain('README.md');

      // Re-publish heals it, then remove a file -> out of sync again.
      expect(run(['--target', target]).status).toBe(0);
      expect(run(['--check', '--target', target]).status).toBe(0);
      rmSync(join(target, '.claude/skills/macf-bootstrap/SKILL.md'));
      const removed = run(['--check', '--target', target]);
      expect(removed.status).toBe(1);
      expect(removed.stderr).toContain('SKILL.md (missing in target)');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('sync-bootstrap-product.mjs — excludes scratch + secrets from a synthetic source', () => {
  it('publishes legit files but never .bootstrap-work/ or stray *.app.json / vault secrets', () => {
    const source = mkTmp('macf-bs-syn-src-');
    const target = mkTmp('macf-bs-syn-tgt-');
    try {
      // Legit workspace files (published).
      write(source, '.claude/settings.json', '{"permissions":{}}\n');
      write(source, '.claude/skills/macf-bootstrap/SKILL.md', '# bootstrap skill\n');
      write(source, '.claude/scripts/runme.sh', '#!/usr/bin/env bash\necho hi\n', 0o755);
      write(source, 'README.md', '# macf-bootstrap\n');

      // Planted scratch + secrets (must NOT be published).
      write(source, '.bootstrap-work/secret', 'AGE-SECRET-KEY-1STUB\n');
      write(source, '.bootstrap-work/code-agent.app.json', '{"pem":"x"}\n');
      write(source, 'code-agent.app.json', '{"pem":"y"}\n');
      write(source, 'vault.age', 'ENCRYPTED\n');
      write(source, 'vault.20260629T000000Z.age', 'ENCRYPTED\n');
      write(source, 'vault-age-key.txt', 'AGE-SECRET-KEY-1STUB\n');
      write(source, 'vault.plain', 'SECRET="x"\n');

      const r = run(['--source', source, '--target', target]);
      expect(r.status).toBe(0);

      // Legit files published, exec bit preserved.
      for (const rel of [
        '.claude/settings.json',
        '.claude/skills/macf-bootstrap/SKILL.md',
        '.claude/scripts/runme.sh',
        'README.md',
      ]) {
        expect(existsSync(join(target, rel))).toBe(true);
      }
      expect(statSync(join(target, '.claude/scripts/runme.sh')).mode & 0o111).not.toBe(0);

      // Scratch + secrets NOT published.
      expect(existsSync(join(target, '.bootstrap-work'))).toBe(false);
      expect(existsSync(join(target, 'code-agent.app.json'))).toBe(false);
      expect(existsSync(join(target, 'vault.age'))).toBe(false);
      expect(existsSync(join(target, 'vault.20260629T000000Z.age'))).toBe(false);
      expect(existsSync(join(target, 'vault-age-key.txt'))).toBe(false);
      expect(existsSync(join(target, 'vault.plain'))).toBe(false);

      // And a --check of the same pair is in sync (the excluded files don't count).
      expect(run(['--source', source, '--check', '--target', target]).status).toBe(0);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('fails loud (exit 2) on a missing --target', () => {
    const r = run(['--source', REAL_SOURCE]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage:');
  });
});
