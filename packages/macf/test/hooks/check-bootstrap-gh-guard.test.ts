/**
 * Tests for `tools/macf-bootstrap/.claude/scripts/check-bootstrap-gh-guard.sh`
 * — the PreToolUse(Bash) hook that is the Bash/`gh` half of DR-035 §2.2's
 * dual-surface destructive-deny for the macf-bootstrap workspace. It blocks
 * irreversible-destructive `gh` / `gh api` verbs and enforces create-only
 * secret/variable `set` (overwrite ≠ delete).
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 = block
 * (stderr → Claude; exit-2-ONLY). Overrides: MACF_BOOTSTRAP_SKIP_GH_GUARD=1,
 * MACF_BOOTSTRAP_ALLOW_OVERWRITE=1.
 *
 * The create-only check probes existence via `gh <kind> list`, so the overwrite
 * tests prepend a stub `gh` shim to PATH (mirrors check-close-keyword.test.ts).
 * The destructive-verb tests need no stub — the hook blocks on the command
 * shape before any `gh` call.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const REPO_ROOT = resolve(findCliPackageRoot(), '..', '..');
const HOOK_SCRIPT = join(
  REPO_ROOT,
  'tools',
  'macf-bootstrap',
  '.claude',
  'scripts',
  'check-bootstrap-gh-guard.sh',
);

/**
 * Build a dir with a stub `gh` that answers `gh secret list` / `gh variable
 * list` with the given existing names (one per line, table-ish `NAME<TAB>date`),
 * so the create-only existence probe can resolve. Any other gh subcommand
 * exits non-zero (the hook should never call them in these tests).
 */
function makeStubGhDir(existing: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bootstrap-stub-gh-'));
  const lines = existing.map((n) => `${n}\t2026-01-01T00:00:00Z`).join('\\n');
  const stubScript = `#!/usr/bin/env bash
# Stub gh — only \`gh secret list\` / \`gh variable list\` are expected.
if [[ "$1" == "secret" || "$1" == "variable" ]] && [[ "$2" == "list" ]]; then
  printf '${lines}\\n'
  exit 0
fi
echo "stub gh: unexpected subcommand: $*" >&2
exit 1
`;
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, stubScript);
  chmodSync(ghPath, 0o755);
  return dir;
}

function runHook(opts: {
  readonly command: string;
  readonly env?: Record<string, string | undefined>;
  readonly stubExisting?: readonly string[];
}): ReturnType<typeof spawnSync> {
  const payload = JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  });
  const basePath = process.env['PATH'] ?? '';
  let path = basePath;
  let stubDir: string | undefined;
  if (opts.stubExisting) {
    stubDir = makeStubGhDir(opts.stubExisting);
    path = `${stubDir}:${basePath}`;
  }
  const cleanEnv: Record<string, string> = { PATH: path };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }
  try {
    return spawnSync('bash', [HOOK_SCRIPT], { input: payload, env: cleanEnv, encoding: 'utf-8' });
  } finally {
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  }
}

describe('check-bootstrap-gh-guard.sh (hook)', () => {
  describe('pass-through — non-destructive / non-gh', () => {
    it('allows a non-gh command', () => {
      expect(runHook({ command: 'make -f dev.mk check' }).status).toBe(0);
    });
    it('allows `gh repo create --template` (provisioning happy path)', () => {
      const r = runHook({ command: 'gh repo create myorg/myrepo --template owner/agentic-repo-template --private' });
      expect(r.status).toBe(0);
    });
    it('allows `gh api ... -X PUT` (install / configure)', () => {
      const r = runHook({ command: 'gh api repos/o/r/actions/secrets/x -X PUT -f encrypted_value=z' });
      expect(r.status).toBe(0);
    });
    it('allows `gh secret list`', () => {
      expect(runHook({ command: 'gh secret list --repo o/r' }).status).toBe(0);
    });
  });

  describe('irreversible-destructive gh verbs → BLOCK', () => {
    it('blocks `gh repo delete`', () => {
      const r = runHook({ command: 'gh repo delete myorg/myrepo --yes' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('repo delete');
    });
    it('blocks `gh repo transfer`', () => {
      expect(runHook({ command: 'gh repo transfer myorg/myrepo otherorg' }).status).toBe(2);
    });
    it('blocks `gh repo rename`', () => {
      expect(runHook({ command: 'gh repo rename newname --repo myorg/myrepo' }).status).toBe(2);
    });
    it('blocks `gh secret delete`', () => {
      expect(runHook({ command: 'gh secret delete MYSECRET --repo o/r' }).status).toBe(2);
    });
    it('blocks `gh variable delete`', () => {
      expect(runHook({ command: 'gh variable delete MYVAR --repo o/r' }).status).toBe(2);
    });
    it('blocks `gh api ... -X DELETE`', () => {
      const r = runHook({ command: 'gh api repos/o/r -X DELETE' });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('DELETE');
    });
    it('blocks `gh api ... --method DELETE` (App uninstall form)', () => {
      expect(runHook({ command: 'gh api user/installations/123/repositories/456 --method DELETE' }).status).toBe(2);
    });
    it('blocks the glued `-XDELETE` form', () => {
      expect(runHook({ command: 'gh api orgs/o/members/u -XDELETE' }).status).toBe(2);
    });
  });

  describe('wrapper-bypass coverage', () => {
    it('blocks `sudo gh repo delete`', () => {
      expect(runHook({ command: 'sudo gh repo delete o/r --yes' }).status).toBe(2);
    });
    it('blocks `bash -c "gh repo delete ..."` (SHELL_C path)', () => {
      expect(runHook({ command: `bash -c 'gh repo delete o/r --yes'` }).status).toBe(2);
    });
    it('blocks a wrapped `GH_TOKEN=x gh repo delete`', () => {
      expect(runHook({ command: 'GH_TOKEN=ghs_x gh repo delete o/r --yes' }).status).toBe(2);
    });
  });

  describe('create-only secret/variable set (overwrite ≠ delete)', () => {
    it('blocks overwriting an EXISTING secret', () => {
      const r = runHook({
        command: 'gh secret set MYSECRET --repo o/r --body xxx',
        stubExisting: ['MYSECRET', 'OTHER'],
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('OVERWRITE');
    });

    it('blocks overwriting an EXISTING variable', () => {
      const r = runHook({
        command: 'gh variable set MYVAR --repo o/r --body xxx',
        stubExisting: ['MYVAR'],
      });
      expect(r.status).toBe(2);
    });

    it('allows creating a NEW secret (name not present)', () => {
      const r = runHook({
        command: 'gh secret set NEWSECRET --repo o/r --body xxx',
        stubExisting: ['OTHER', 'STILL_OTHER'],
      });
      expect(r.status).toBe(0);
    });

    it('fail-open on the existence probe: allows set when `gh list` errors', () => {
      // No stub → the stub-less PATH has no usable `gh list`; the probe fails
      // and the hook allows the create (the destructive verbs stay fail-closed,
      // but a flaky list must not block a legit first-time create).
      const r = runHook({
        command: 'gh secret set NEWSECRET --repo o/r --body xxx',
        // Provide a stub `gh` that errors on list to simulate a flaky probe.
        env: { PATH: makeFailingGhPath() },
      });
      expect(r.status).toBe(0);
    });

    it('MACF_BOOTSTRAP_ALLOW_OVERWRITE=1 permits an intended overwrite', () => {
      const r = runHook({
        command: 'gh secret set MYSECRET --repo o/r --body xxx',
        stubExisting: ['MYSECRET'],
        env: { MACF_BOOTSTRAP_ALLOW_OVERWRITE: '1' },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('override', () => {
    it('MACF_BOOTSTRAP_SKIP_GH_GUARD=1 bypasses even `gh repo delete`', () => {
      const r = runHook({
        command: 'gh repo delete o/r --yes',
        env: { MACF_BOOTSTRAP_SKIP_GH_GUARD: '1' },
      });
      expect(r.status).toBe(0);
    });
  });
});

/** A PATH whose `gh` always errors on list — simulates a flaky existence probe. */
function makeFailingGhPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bootstrap-failgh-'));
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, '#!/usr/bin/env bash\necho "gh: boom" >&2\nexit 1\n');
  chmodSync(ghPath, 0o755);
  return `${dir}:${process.env['PATH'] ?? ''}`;
}
