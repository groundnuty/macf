/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/bootstrap-rail-selftest.sh` —
 * the on-request proof (added per the first-run finding,
 * macf-automated-github-setup#1, item 10) that the browser URL-allowlist rail
 * actually BLOCKS destructive navigation (exit 2) and ALLOWS provisioning URLs
 * (exit 0). It invokes the real `check-bootstrap-url-allowlist.sh` guard with
 * synthetic PreToolUse payloads — it must NOT weaken the guard.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const SCRIPT = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'scripts', 'bootstrap-rail-selftest.sh');

describe('bootstrap-rail-selftest.sh', () => {
  it('passes (exit 0): rail blocks destructive nav + allows provisioning', () => {
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf-8' });
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    // positive evidence in the transcript: a BLOCKED line for a destructive URL
    expect(r.stdout).toMatch(/✓ BLOCKED \(exit 2\)\s+https:\/\/github\.com\/.*danger/);
    expect(r.stdout).toMatch(/✓ BLOCKED \(exit 2\)\s+https:\/\/github\.com\/settings\/billing/);
    // and an ALLOWED line for the manifest-create page
    expect(r.stdout).toMatch(/✓ ALLOWED \(exit 0\)\s+https:\/\/github\.com\/settings\/apps\/new/);
    expect(r.stdout).toContain('rail self-test PASSED');
  });

  it('runs cwd-independently (self-resolves the sibling guard)', () => {
    // Run from an unrelated cwd: the script must still find its sibling guard.
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf-8', cwd: REPO_ROOT });
    expect(r.status).toBe(0);
  });

  it('refuses to run when the guard is bypassed (would prove nothing)', () => {
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf-8',
      env: { ...process.env, MACF_BOOTSTRAP_SKIP_URL_GUARD: '1' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('bypassed');
  });
});
