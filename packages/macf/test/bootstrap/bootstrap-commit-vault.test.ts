/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/bootstrap-commit-vault.sh`
 * — commits the encrypted vault into the project's science repo NON-destructively
 * (DR-035 §4/§6): fail-or-version when secrets/vault.age exists, NEVER --force,
 * and shred + remove the /tmp clone on exit (trap).
 *
 * Tests stub `git` on PATH. The stub records every invocation to a capture file
 * (so we can assert no --force) and, on clone, materializes the dest dir —
 * optionally pre-seeding secrets/vault.age to simulate an existing vault.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const SCRIPT = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'scripts', 'bootstrap-commit-vault.sh');

/**
 * Stub `git` writing all invocations to $GIT_CAP. `clone` makes the dest dir
 * (+ secrets/vault.age if $STUB_EXISTING_VAULT=1); `-C <dir> diff` returns 1 so
 * the script sees staged changes and proceeds to commit; everything else exits 0.
 */
function makeStubGitDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bs-commit-git-'));
  const stub = `#!/usr/bin/env bash
echo "$*" >> "$GIT_CAP"
case "$1" in
  clone)
    for last; do :; done
    mkdir -p "$last/secrets"
    [ "\${STUB_EXISTING_VAULT:-}" = "1" ] && : > "$last/secrets/vault.age"
    exit 0 ;;
  -C)
    [ "$3" = "diff" ] && exit 1
    exit 0 ;;
esac
exit 0
`;
  const p = join(dir, 'git');
  writeFileSync(p, stub);
  chmodSync(p, 0o755);
  return dir;
}

function run(args: readonly string[], extraEnv: Record<string, string> = {}): {
  readonly res: ReturnType<typeof spawnSync>;
  readonly calls: string;
} {
  const stubDir = makeStubGitDir();
  const cap = join(stubDir, 'calls.log');
  writeFileSync(cap, '');
  try {
    const res = spawnSync('bash', [SCRIPT, ...args], {
      env: { PATH: `${stubDir}:${process.env['PATH'] ?? ''}`, GIT_CAP: cap, ...extraEnv },
      encoding: 'utf-8',
    });
    const calls = readFileSync(cap, 'utf-8');
    return { res, calls };
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

function makeVaultFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bs-commit-vault-'));
  const v = join(dir, 'vault.age');
  writeFileSync(v, 'ENCRYPTED');
  return v;
}

describe('bootstrap-commit-vault.sh', () => {
  it('clones, commits, pushes WITHOUT --force, and shreds the /tmp clone (trap)', () => {
    const vault = makeVaultFile();
    try {
      const { res, calls } = run(['--repo', 'groundnuty/icsoc-2026-science-agent', '--vault', vault]);
      expect(res.status).toBe(0);
      // a push happened, and NO force anywhere
      expect(calls).toMatch(/(^|\n)-C .* push/);
      expect(calls).not.toContain('--force');
      expect(calls).not.toMatch(/push.* -f(\s|$)/);
      // the /tmp working clone was removed by the EXIT trap
      const m = /working clone at (\S+)/.exec(res.stderr);
      expect(m).not.toBeNull();
      expect(existsSync(m![1])).toBe(false);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('FAILS (never clobbers) when secrets/vault.age already exists', () => {
    const vault = makeVaultFile();
    try {
      const { res } = run(['--repo', 'groundnuty/x', '--vault', vault], { STUB_EXISTING_VAULT: '1' });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('already exists');
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('versions instead of failing when MACF_BOOTSTRAP_VAULT_VERSION=1', () => {
    const vault = makeVaultFile();
    try {
      const { res, calls } = run(['--repo', 'groundnuty/x', '--vault', vault], {
        STUB_EXISTING_VAULT: '1',
        MACF_BOOTSTRAP_VAULT_VERSION: '1',
      });
      expect(res.status).toBe(0);
      expect(res.stderr).toMatch(/versioning to secrets\/vault\./);
      expect(calls).toMatch(/(^|\n)-C .* push/);
      expect(calls).not.toContain('--force');
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it('fails (exit 2) when --vault is missing', () => {
    const { res } = run(['--repo', 'groundnuty/x']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--vault');
  });

  it('rejects a malformed --repo', () => {
    const vault = makeVaultFile();
    try {
      const { res } = run(['--repo', 'not-a-repo', '--vault', vault]);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('owner/repo');
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
