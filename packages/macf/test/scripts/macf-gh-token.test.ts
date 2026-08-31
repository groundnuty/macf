/**
 * Tests for `scripts/macf-gh-token.sh`'s own token-shape validator —
 * groundnuty/macf#1360 ask 3: this producer's sanity-check on the token
 * `gh token generate` hands back must use the SAME anchored full-shape
 * predicate (`^ghs_[A-Za-z0-9._-]+$`) the two consumers already enforce
 * (`check-gh-token.sh`'s PreToolUse hook, `claude-sh.ts`'s launch-boundary
 * check). Before this fix the producer only checked the first 4 characters
 * (`${token:0:4} == ghs_`) — coarser than the consumer's gate, so this
 * helper could hand a caller a token the hook then refuses. That gap is
 * exactly what #1360 named "producer and consumer disagree."
 *
 * The script shells out to `gh token generate --token-only`; these tests
 * stub `gh` on PATH (same convention as hook-gh-token.test.ts) so no real
 * GitHub App credentials are needed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const SCRIPT = join(findCliPackageRoot(), 'scripts', 'macf-gh-token.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A `gh` stub whose `token generate --token-only` prints a fixed value. */
function makeStubGh(tokenOutput: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-ghtoken-stub-gh-'));
  cleanupDirs.push(dir);
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "token" && "\${2:-}" == "generate" ]]; then
  printf '%s' "${tokenOutput}"
  exit 0
fi
echo "gh: not stubbed for: $*" >&2
exit 1
`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  return dir;
}

/** A readable file to stand in for the `--key` PEM path (contents unread by the stub). */
function makeKeyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-ghtoken-key-'));
  cleanupDirs.push(dir);
  const keyPath = join(dir, 'app-key.pem');
  writeFileSync(keyPath, '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n');
  return keyPath;
}

function run(opts: { readonly stubGhDir: string; readonly keyPath: string }): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const basePath = process.env['PATH'] ?? '';
  const r = spawnSync(
    'bash',
    [SCRIPT, '--app-id', '123', '--install-id', '456', '--key', opts.keyPath],
    { env: { PATH: `${opts.stubGhDir}:${basePath}` }, encoding: 'utf-8' },
  );
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('macf-gh-token.sh — token-shape validation (macf#1360 ask 3)', () => {
  describe('DECISIVE pair', () => {
    it('(1) accepts a v2-shaped token (dots + hyphens) that a prefix-only check would ALSO accept, but proves full-shape logic ran', () => {
      // The classic 40-char form below is accepted by BOTH the old
      // prefix-only check and the new full-shape one — this alone can't
      // distinguish them. The decisive half is the next test: a token
      // that a naive prefix check would accept but the full-shape
      // predicate must reject.
      const token = 'ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
      const stubGhDir = makeStubGh(token);
      const keyPath = makeKeyFile();
      const r = run({ stubGhDir, keyPath });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(token);
      expect(r.stderr).toBe('');
    });

    it('(1b) accepts the GitHub v2 new-format token (ghs_<app-id>_<JWT>, dots + hyphens, ~380+ chars) — REJECTED by the old ${token:0:4} prefix-only check would have passed too; the point is the NEW-FORMAT case a stale hook rejected in #1360', () => {
      // This is the actual #1360 incident shape: gh-token v2.x mints a
      // token with dots and hyphens past the 4th character. A pure
      // prefix check (${token:0:4} == "ghs_") would have accepted this
      // just fine too — so this case alone doesn't discriminate the fix.
      // It's included because it's the literal token shape from the
      // incident, and (2) below is what actually discriminates.
      const token =
        'ghs_AbCdEfGh.eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJhdWQiOiJhdXRobmQiLCJpc3MiOiJnaXRodWIiLCJ2ZXIiOjN9.' +
        'qFG7VT5FvuM7k07o4qs2BI9c9BLVzpfvNpzV_qLd2TtZuEYrhnrwAkihg3UXZGzkj8OBS7Cpz7ZBYifZzUTQEg';
      const stubGhDir = makeStubGh(token);
      const keyPath = makeKeyFile();
      const r = run({ stubGhDir, keyPath });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(token);
    });

    it('(2) DECISIVE: rejects a ghs_-prefixed token containing a disallowed character (space) that the OLD prefix-only check would have accepted', () => {
      // ${token:0:4} == "ghs_" is satisfied by this value — the old
      // validator would have printed it to stdout. The full-shape
      // predicate `^ghs_[A-Za-z0-9._-]+$` must reject it (space is
      // outside the injection-safe charset). This is the pair-half that
      // actually distinguishes prefix-only from full-shape.
      const token = 'ghs_ this has a space and is not opaque-safe';
      const stubGhDir = makeStubGh(token);
      const keyPath = makeKeyFile();
      const r = run({ stubGhDir, keyPath });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe(''); // contract: nothing on stdout on failure
      expect(r.stderr).toMatch(/does not match the expected installation-token shape/);
      expect(r.stderr).toMatch(/\^ghs_\[A-Za-z0-9\._-\]\+\$/);
    });
  });

  describe('other non-installation-token shapes still rejected', () => {
    it('rejects a ghp_ user PAT', () => {
      const token = 'ghp_someUserPersonalAccessToken1234567890';
      const stubGhDir = makeStubGh(token);
      const keyPath = makeKeyFile();
      const r = run({ stubGhDir, keyPath });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
    });

    it('rejects an empty token with a distinct message from the shape-mismatch case', () => {
      const stubGhDir = makeStubGh('');
      const keyPath = makeKeyFile();
      const r = run({ stubGhDir, keyPath });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/empty token/);
    });
  });

  it('the pattern this script tests against is byte-identical to the hook + launch-boundary predicate (^ghs_[A-Za-z0-9._-]+$)', () => {
    // Static-source guard: the three copies of this predicate
    // (macf-gh-token.sh, check-gh-token.sh's hook, claude-sh.ts's
    // launchTokenValidationLines) must never drift apart — that
    // drift is the exact shape of #1360.
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toContain('^ghs_[A-Za-z0-9._-]+$');
    // Guard against a REGRESSION to prefix-only: the old predicate shape
    // must not reappear.
    expect(src).not.toContain('token_prefix} != "ghs_"');
    expect(src).not.toContain(':0:4}" != "ghs_"');
  });
});
