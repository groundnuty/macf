/**
 * Tests for `scripts/hook-gh-token.sh` — the shared library `macf_hook_gh`
 * lives in, sourced (not invoked directly) by the three MACF hooks that
 * call the GitHub API (check-lgtm-gate.sh, check-close-keyword.sh,
 * check-gh-attribution.sh). Companion to macf#317 (macf-channel-server's
 * in-process token refresh) for the hook-script consumer family that fix
 * never covered — see groundnuty/macf#938.
 *
 * `macf_hook_gh <gh-arg>...` runs `gh <gh-arg>...` against the ambient
 * $GH_TOKEN; on an authentication failure it mints ONE fresh token via the
 * canonical macf-gh-token.sh helper and retries ONCE. Status travels via
 * exit code only (0 ok / 1 auth_failed / 2 other_failed) — never a global
 * variable, since callers invoke it inside `$(...)` command substitution.
 *
 * These tests source the library into a small driver script (bash has no
 * notion of "import one function" — sourcing is the whole file) and stub
 * both `gh` and the refresh helper as external binaries on PATH, mirroring
 * check-lgtm-gate.test.ts / check-close-keyword.test.ts's external-binary
 * stubbing convention.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const LIB_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'hook-gh-token.sh');

const EXPIRED = 'ghs_expired0000000000000000000000000AAAA';
const FRESH = 'ghs_freshlyminted00000000000000000000AAAA';
const LIVE = 'ghs_live0000000000000000000000000000AAAA';

/**
 * A `gh` stub that answers based on the CALLER's ambient $GH_TOKEN:
 *   - EXPIRED  → an auth-failure shape (REST form, `gh api`'s actual
 *                stderr for a dead installation token — verified live
 *                against gh 2.95.0).
 *   - anything else → succeeds, echoing the token it was called with (so
 *                tests can assert exactly which token the underlying `gh`
 *                call actually used, without any token value crossing
 *                into a diagnostic string).
 * `notfound: true` makes any non-EXPIRED call also fail, with a 404 shape
 * — for testing the other_failed / non-auth path.
 */
function makeStubGhDir(opts: { readonly notfound?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-hookgh-stub-gh-'));
  const successArm = opts.notfound
    ? `echo "gh: Not Found (HTTP 404)" >&2; exit 1`
    : `echo "saw-token:\${GH_TOKEN:-<unset>}"`;
  const stubScript = `#!/usr/bin/env bash
if [[ "\${GH_TOKEN:-}" == "${EXPIRED}" ]]; then
  echo "gh: Bad credentials (HTTP 401)" >&2
  exit 1
fi
${successArm}
`;
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, stubScript);
  chmodSync(ghPath, 0o755);
  return dir;
}

/** Where a `recordKeyArg` workspace's helper stub writes the exact `--key`
 * value it was invoked with, so a test can assert the RESOLVED (not the
 * raw, possibly-relative) path reached the helper. */
function keyArgSeenPath(ws: string): string {
  return join(ws, 'key-arg-seen.txt');
}

/** A workspace carrying `.claude/scripts/macf-gh-token.sh`. When
 * `recordKeyArg` is set, the stub scans its own args for `--key` and
 * writes the following arg verbatim to `keyArgSeenPath(ws)` before doing
 * anything else — order-agnostic (doesn't assume `--key` is any
 * particular positional slot), per groundnuty/macf#1414's decisive pair:
 * proving the helper was invoked with the RESOLVED absolute path, not the
 * relative KEY_PATH the hook's env carried. */
function makeWorkspace(opts: { readonly succeeds: boolean; readonly recordKeyArg?: boolean }): string {
  const ws = mkdtempSync(join(tmpdir(), 'macf-hookgh-ws-'));
  const scriptsDir = join(ws, '.claude', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const helperPath = join(scriptsDir, 'macf-gh-token.sh');
  const recordSnippet = opts.recordKeyArg
    ? `while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--key" ]]; then
    printf '%s' "$2" > '${keyArgSeenPath(ws)}'
    break
  fi
  shift
done
`
    : '';
  const helperScript = opts.succeeds
    ? `#!/usr/bin/env bash\n${recordSnippet}echo "${FRESH}"\n`
    : `#!/usr/bin/env bash\n${recordSnippet}echo "stub helper: refresh failed (bad key)" >&2\nexit 1\n`;
  writeFileSync(helperPath, helperScript);
  chmodSync(helperPath, 0o755);
  return ws;
}

/** Runs `macf_hook_gh <ghArgs>` via a small driver that sources the library
 * and prints `EXIT:<n>` on its own line after the function's stdout, so
 * the test can split the two deterministically. */
function runMacfHookGh(opts: {
  readonly ambientToken: string;
  readonly ghArgs: readonly string[];
  readonly stubDir: string;
  readonly workspace?: string;
  /** Overrides/additions applied on top of the base env — e.g. a relative
   * KEY_PATH, or an explicit CLAUDE_PROJECT_DIR, for #1414's resolution
   * tests. Applied AFTER the `workspace` block's defaults, so a key here
   * always wins over the workspace-mode default for the same name. */
  readonly extraEnv?: Record<string, string>;
  /** cwd the driver script runs from — the third resolution candidate
   * ($PWD) in `_macf_hook_resolve_key_path`. Defaults to this process's
   * cwd when omitted. */
  readonly cwd?: string;
}): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  const driverDir = mkdtempSync(join(tmpdir(), 'macf-hookgh-driver-'));
  const driverPath = join(driverDir, 'driver.sh');
  const argsQuoted = opts.ghArgs.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  writeFileSync(
    driverPath,
    `#!/usr/bin/env bash
set -uo pipefail
source '${LIB_SCRIPT}'
OUT="$(macf_hook_gh ${argsQuoted})"
RC=$?
printf '%s' "$OUT"
printf '\\n===EXIT:%s===\\n' "$RC"
`
  );
  chmodSync(driverPath, 0o755);

  const basePath = process.env['PATH'] ?? '';
  const env: Record<string, string> = {
    PATH: `${opts.stubDir}:${basePath}`,
    GH_TOKEN: opts.ambientToken,
  };
  if (opts.workspace) {
    env['MACF_WORKSPACE_DIR'] = opts.workspace;
    env['APP_ID'] = 'test-app-id';
    env['INSTALL_ID'] = 'test-install-id';
    env['KEY_PATH'] = '/irrelevant-to-the-stub.pem';
  }
  Object.assign(env, opts.extraEnv ?? {});
  try {
    const r = spawnSync('bash', [driverPath], { env, encoding: 'utf-8', cwd: opts.cwd });
    const stdout = r.stdout ?? '';
    const match = /^(.*)\n===EXIT:(-?\d+)===\n?$/s.exec(stdout);
    if (!match) {
      throw new Error(`driver output did not carry the EXIT marker: ${JSON.stringify(stdout)}`);
    }
    return { exitCode: Number(match[2]), stdout: match[1] ?? '', stderr: r.stderr ?? '' };
  } finally {
    rmSync(driverDir, { recursive: true, force: true });
  }
}

describe('hook-gh-token.sh — macf_hook_gh', () => {
  describe('valid ambient token', () => {
    it('is used as-is — no refresh attempted, gh sees the ambient token', () => {
      const stubDir = makeStubGhDir();
      try {
        const r = runMacfHookGh({ ambientToken: LIVE, ghArgs: ['api', 'repos/o/r/issues/1'], stubDir });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe(`saw-token:${LIVE}`);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    });

    it('does not attempt a refresh even when no workspace/helper is configured', () => {
      // If the code path tried to refresh unconditionally, this would fail
      // (no helper reachable) even though the ambient token was fine.
      const stubDir = makeStubGhDir();
      try {
        const r = runMacfHookGh({ ambientToken: LIVE, ghArgs: ['api', 'repos/o/r/issues/1'], stubDir });
        expect(r.exitCode).toBe(0);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    });
  });

  describe('DECISIVE: auth failure — status is never silently "ok"', () => {
    it('an expired token with NO refresh helper reachable returns auth_failed (1), not ok (0)', () => {
      // per assert-the-wrong-path.md: assert the SPECIFIC exit code the
      // fix introduced (1), not just "non-zero" — a test asserting only
      // "!= 0" would also pass if this regressed to exit 2 (other_failed),
      // which is a materially different signal to callers (check-lgtm-
      // gate.sh treats 1 as BLOCK and 2 as fail-open — conflating them
      // would silently reopen the exact bug this hook exists to close).
      const stubDir = makeStubGhDir();
      try {
        const r = runMacfHookGh({ ambientToken: EXPIRED, ghArgs: ['api', 'repos/o/r/issues/1'], stubDir });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).not.toBe('');
        expect(r.stdout).toMatch(/expired or invalid/i);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    });

    it('the refresh helper\'s own failure (nonzero exit, no token produced) is handled and surfaced as auth_failed (1)', () => {
      // Uses the default absolute KEY_PATH ('/irrelevant-to-the-stub.pem')
      // that makeWorkspace()'s caller-side default sets — so this is the
      // "key resolved fine, helper itself failed" branch, and per
      // groundnuty/macf#1414's diagnostic-naming requirement its message
      // must be textually distinct from the "key file was not found"
      // branch exercised below (a caller reading the diagnostic needs to
      // tell "check the key/App-id" apart from "check KEY_PATH/cwd").
      const stubDir = makeStubGhDir();
      const ws = makeWorkspace({ succeeds: false });
      try {
        const r = runMacfHookGh({ ambientToken: EXPIRED, ghArgs: ['api', 'repos/o/r/issues/1'], stubDir, workspace: ws });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toMatch(/refreshing it failed/i);
        expect(r.stdout).toMatch(/exited non-zero/i);
        expect(r.stdout).not.toMatch(/private key file was not found/i);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('a SUCCESSFUL refresh whose retry STILL fails authentication is a distinct auth_failed (1) branch', () => {
      // Different failure shape from the two above: the helper DOES
      // produce a well-shaped token, but gh rejects it too (e.g. the App
      // key itself was rotated/revoked — a fresh mint from a dead key is
      // still a dead credential). Exercises the OTHER auth_failed message,
      // not just "refresh produced nothing".
      const ws = makeWorkspace({ succeeds: true });
      const stubDir = mkdtempSync(join(tmpdir(), 'macf-hookgh-stub-gh-allfail-'));
      try {
        writeFileSync(
          join(stubDir, 'gh'),
          `#!/usr/bin/env bash\necho "gh: Bad credentials (HTTP 401)" >&2\nexit 1\n`
        );
        chmodSync(join(stubDir, 'gh'), 0o755);
        const r = runMacfHookGh({ ambientToken: EXPIRED, ghArgs: ['api', 'repos/o/r/issues/1'], stubDir, workspace: ws });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toMatch(/retry still failed authentication/i);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('APP_ID/INSTALL_ID/KEY_PATH unset (but helper present) also can\'t refresh → auth_failed (1)', () => {
      const stubDir = makeStubGhDir();
      const ws = makeWorkspace({ succeeds: true }); // helper WOULD succeed if called
      const driverDir = mkdtempSync(join(tmpdir(), 'macf-hookgh-driver2-'));
      try {
        const driverPath = join(driverDir, 'driver.sh');
        writeFileSync(
          driverPath,
          `#!/usr/bin/env bash
set -uo pipefail
source '${LIB_SCRIPT}'
OUT="$(macf_hook_gh api repos/o/r/issues/1)"
RC=$?
printf '%s' "$OUT"
printf '\\n===EXIT:%s===\\n' "$RC"
`
        );
        chmodSync(driverPath, 0o755);
        const basePath = process.env['PATH'] ?? '';
        // Deliberately MACF_WORKSPACE_DIR set (helper IS reachable) but
        // APP_ID/INSTALL_ID/KEY_PATH withheld — the helper must not be
        // invoked at all without them (macf_hook_gh checks before calling).
        const r = spawnSync('bash', [driverPath], {
          env: { PATH: `${stubDir}:${basePath}`, GH_TOKEN: EXPIRED, MACF_WORKSPACE_DIR: ws },
          encoding: 'utf-8',
        });
        const stdout = r.stdout ?? '';
        const match = /^(.*)\n===EXIT:(-?\d+)===\n?$/s.exec(stdout);
        expect(match).not.toBeNull();
        expect(Number(match?.[2])).toBe(1);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
        rmSync(ws, { recursive: true, force: true });
        rmSync(driverDir, { recursive: true, force: true });
      }
    });
  });

  describe('expired token WITH a working refresh — recovers to ok (0)', () => {
    it('mints exactly one fresh token and retries with it', () => {
      const stubDir = makeStubGhDir();
      const ws = makeWorkspace({ succeeds: true });
      try {
        const r = runMacfHookGh({ ambientToken: EXPIRED, ghArgs: ['api', 'repos/o/r/issues/1'], stubDir, workspace: ws });
        expect(r.exitCode).toBe(0);
        // Proves the RETRY actually used the freshly-minted token (not the
        // stale one, not some third value) — the stub gh echoes back
        // whichever token it saw.
        expect(r.stdout).toBe(`saw-token:${FRESH}`);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('non-auth failure — other_failed (2), unchanged posture, no refresh attempted', () => {
    it('a 404 is other_failed (2), not auth_failed — no refresh even attempted', () => {
      // No workspace configured — if the code incorrectly tried to refresh
      // on a 404, this would still "work" in the sense of not crashing,
      // but the exit code assertion below is what actually catches a
      // regression that widens auth-failure detection to non-auth errors.
      const stubDir = makeStubGhDir({ notfound: true });
      try {
        const r = runMacfHookGh({ ambientToken: LIVE, ghArgs: ['api', 'repos/o/r/issues/999999'], stubDir });
        expect(r.exitCode).toBe(2);
        expect(r.stdout).toMatch(/non-auth/i);
        expect(r.stdout).toMatch(/404|not found/i);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    });
  });

  describe('never leaks token material', () => {
    it('the auth_failed diagnostic never contains the expired or fresh token value', () => {
      const stubDir = makeStubGhDir();
      const ws = makeWorkspace({ succeeds: false });
      try {
        const r = runMacfHookGh({ ambientToken: EXPIRED, ghArgs: ['api', 'repos/o/r/issues/1'], stubDir, workspace: ws });
        expect(r.stdout).not.toContain(EXPIRED);
        expect(r.stdout).not.toContain(FRESH);
        expect(r.stderr).not.toContain(EXPIRED);
        expect(r.stderr).not.toContain(FRESH);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  // groundnuty/macf#1414: a relative KEY_PATH used to be handed straight to
  // the minting helper unresolved. The hook runs BEFORE the intercepted
  // command's own `cd`, in whatever cwd the persistent shell happens to be
  // sitting in — so a relative KEY_PATH only ever resolved by accident, when
  // that cwd was the workspace root. These tests exercise the resolution
  // chain ($MACF_WORKSPACE_DIR -> $CLAUDE_PROJECT_DIR -> $PWD) directly.
  describe('KEY_PATH resolution (#1414)', () => {
    it('DECISIVE 1: relative KEY_PATH + a foreign cwd + MACF_WORKSPACE_DIR set — the helper is invoked with the ABSOLUTE resolved path, and refresh succeeds', () => {
      const ws = makeWorkspace({ succeeds: true, recordKeyArg: true });
      // The key file lives at the workspace root, matching the issue's own
      // measured shape (KEY_PATH='.github-app-key.pem').
      const relativeKey = '.github-app-key.pem';
      writeFileSync(join(ws, relativeKey), 'dummy-pem-content-not-parsed-by-the-stub');
      const stubDir = makeStubGhDir();
      // A cwd that is NOT the workspace and does NOT itself carry a file
      // named `.github-app-key.pem` — proves resolution isn't accidentally
      // succeeding off $PWD.
      const foreignCwd = mkdtempSync(join(tmpdir(), 'macf-hookgh-foreign-cwd-'));
      try {
        const r = runMacfHookGh({
          ambientToken: EXPIRED,
          ghArgs: ['api', 'repos/o/r/issues/1'],
          stubDir,
          workspace: ws,
          extraEnv: { KEY_PATH: relativeKey },
          cwd: foreignCwd,
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe(`saw-token:${FRESH}`);
        const keyArgSeen = readFileSync(keyArgSeenPath(ws), 'utf-8');
        expect(keyArgSeen).toBe(join(ws, relativeKey));
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
        rmSync(ws, { recursive: true, force: true });
        rmSync(foreignCwd, { recursive: true, force: true });
      }
    });

    it('DECISIVE 2: absolute KEY_PATH is passed through byte-identical, regardless of whether it exists on disk', () => {
      const ws = makeWorkspace({ succeeds: true, recordKeyArg: true });
      const stubDir = makeStubGhDir();
      try {
        // makeWorkspace's default env sets KEY_PATH='/irrelevant-to-the-
        // stub.pem' — an absolute path that does NOT exist anywhere. If
        // absolute paths were existence-checked (they must not be, to
        // preserve pre-#1414 behavior for operator-absolute paths like
        // /etc/macf/keys/...), this would incorrectly fail resolution
        // before ever reaching the helper.
        const r = runMacfHookGh({ ambientToken: EXPIRED, ghArgs: ['api', 'repos/o/r/issues/1'], stubDir, workspace: ws });
        expect(r.exitCode).toBe(0);
        const keyArgSeen = readFileSync(keyArgSeenPath(ws), 'utf-8');
        expect(keyArgSeen).toBe('/irrelevant-to-the-stub.pem');
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('a relative KEY_PATH found in NONE of the three candidates — the diagnostic names every path tried, distinct from "helper exited non-zero", and the helper is never invoked', () => {
      // Calls _macf_hook_refresh_token DIRECTLY rather than through
      // macf_hook_gh: the top-level wrapper truncates its combined message
      // to 220 chars (`cut -c1-220`, pre-existing #1409 behavior, out of
      // scope here), which on a long $TMPDIR could clip one of the three
      // full candidate paths before this test ever sees it. Going straight
      // to the function this issue actually changes proves the real
      // property (every path is named in the RAW diagnostic) without
      // coupling the assertion to an unrelated truncation budget.
      const ws = makeWorkspace({ succeeds: true, recordKeyArg: true }); // helper WOULD succeed — must never be reached
      const projectDir = mkdtempSync(join(tmpdir(), 'macf-hookgh-project-dir-'));
      const foreignCwd = mkdtempSync(join(tmpdir(), 'macf-hookgh-foreign-cwd2-'));
      const relativeKey = 'nonexistent-key.pem';
      const driverDir = mkdtempSync(join(tmpdir(), 'macf-hookgh-driver3-'));
      try {
        const driverPath = join(driverDir, 'driver.sh');
        writeFileSync(
          driverPath,
          `#!/usr/bin/env bash
set -uo pipefail
source '${LIB_SCRIPT}'
OUT="$(_macf_hook_refresh_token 2>&1 1>/dev/null)"
RC=$?
printf '%s' "$OUT"
printf '\\n===EXIT:%s===\\n' "$RC"
`
        );
        chmodSync(driverPath, 0o755);
        const r = spawnSync('bash', [driverPath], {
          env: {
            PATH: process.env['PATH'] ?? '',
            MACF_WORKSPACE_DIR: ws,
            APP_ID: 'test-app-id',
            INSTALL_ID: 'test-install-id',
            KEY_PATH: relativeKey,
            CLAUDE_PROJECT_DIR: projectDir,
          },
          cwd: foreignCwd,
          encoding: 'utf-8',
        });
        const stdout = r.stdout ?? '';
        const match = /^(.*)\n===EXIT:(-?\d+)===\n?$/s.exec(stdout);
        expect(match).not.toBeNull();
        expect(Number(match?.[2])).toBe(1);
        const diag = match?.[1] ?? '';
        expect(diag).toMatch(/private key file was not found/i);
        // Distinct from the "helper exited non-zero" branch — a caller
        // must be able to tell "fix KEY_PATH/cwd" apart from "fix the
        // key/App-id", per #1414's diagnostic-naming requirement.
        expect(diag).not.toMatch(/exited non-zero/i);
        // Names every candidate actually tried — all three resolution
        // bases, not just the first.
        expect(diag).toContain(join(ws, relativeKey));
        expect(diag).toContain(join(projectDir, relativeKey));
        expect(diag).toContain(join(foreignCwd, relativeKey));
        // The helper must never have run — its recordKeyArg stub would
        // have written this file had it been invoked.
        expect(existsSync(keyArgSeenPath(ws))).toBe(false);
      } finally {
        rmSync(ws, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(foreignCwd, { recursive: true, force: true });
        rmSync(driverDir, { recursive: true, force: true });
      }
    });
  });
});
