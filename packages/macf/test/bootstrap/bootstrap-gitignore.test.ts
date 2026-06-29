/**
 * Tests for `tools/macf-bootstrap/.gitignore`
 * — belt-and-suspenders against a stray `git add`/commit of scratch secrets in
 * this no-prompt git workspace (science's #659 secrets-on-disk review, DR-035 §4).
 * Behavioral check via `git check-ignore`, plus a content-presence backstop.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const BOOTSTRAP_DIR = join(REPO_ROOT, 'tools', 'macf-bootstrap');
const GITIGNORE = join(BOOTSTRAP_DIR, '.gitignore');

/** True iff `git check-ignore` says the path (relative to BOOTSTRAP_DIR) is ignored. */
function isIgnored(relPath: string): boolean {
  const r = spawnSync('git', ['check-ignore', '-q', relPath], { cwd: BOOTSTRAP_DIR, encoding: 'utf-8' });
  // exit 0 = ignored, 1 = not ignored, 128 = error (treat as not-ignored/loud).
  return r.status === 0;
}

describe('tools/macf-bootstrap/.gitignore', () => {
  it('exists', () => {
    expect(existsSync(GITIGNORE)).toBe(true);
  });

  it('lists every required secrets pattern', () => {
    const body = readFileSync(GITIGNORE, 'utf-8');
    for (const pat of ['/.bootstrap-work/', '*.app.json', 'vault.plain', 'vault*.age', 'vault-age-key.txt']) {
      expect(body).toContain(pat);
    }
  });

  it.each([
    '.bootstrap-work/',
    '.bootstrap-work/code-agent.app.json',
    'code-agent.app.json',
    'vault.plain',
    'vault.age',
    'vault.20260629T000000Z.age',
    'vault-age-key.txt',
  ])('ignores scratch-secret path %s', (p) => {
    expect(isIgnored(p)).toBe(true);
  });

  it.each([
    'README.md',
    'templates/macf-app-manifest.json',
    'templates/bootstrap-spec.example.json',
    'templates/vault.template.txt',
    'templates/vault.sh',
    '.claude/scripts/bootstrap-build-vault.sh',
    '.claude/scripts/bootstrap-cleanup.sh',
  ])('does NOT ignore tracked workspace file %s', (p) => {
    expect(isIgnored(p)).toBe(false);
  });
});
