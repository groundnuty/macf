/**
 * Tests for `scripts/check-gh-attribution.sh` — the PostToolUse hook that,
 * after a `gh`-write Bash op, reads the just-written GitHub resource back and
 * warns LOUDLY (`exit 2`) when it was authored by the operator's USER account
 * instead of the bot. This is the silent-fallback Instance-12 attribution
 * trap; the result-invariant backstop to the #140 PreToolUse token check.
 * Path-2 result-check for groundnuty/macf#489.
 *
 * Hook contract (PostToolUse): JSON on stdin (carrying BOTH the executed
 * `.tool_input.command` AND the tool output under `.tool_output.stdout` /
 * `.tool_response.stdout`), exit 0 = ok, exit 2 = LOUD warning (stderr →
 * Claude; PostToolUse can't block — the tool already ran). Fail-open: every
 * uncertain branch exits 0; only a CONFIRMED user-authored write fires exit 2.
 * Override: MACF_SKIP_ATTRIBUTION_CHECK=1.
 *
 * The hook resolves authorship via `gh api <path> --jq '{login,type}'`, so
 * the tests prepend a stub `gh` shim to PATH (mirrors check-close-keyword.sh /
 * check-lgtm-gate.sh test pattern).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-gh-attribution.sh');

const BOT = 'macf-code-agent[bot]';

/** What the stub `gh api` returns for the resource: an author login+type, or
 *  a failure sentinel. */
type GhStub =
  | { readonly login: string; readonly type: 'Bot' | 'User' }
  | 'fail'; // gh api exits non-zero (network / 404 / auth)

/**
 * Build a directory with a stub `gh` shim that answers
 * `gh api <path> --jq '{login: .user.login, type: .user.type}'` with the
 * supplied canned author, or fails. Returns the dir to prepend to PATH.
 *
 * Because the real hook passes `--jq '{login: .user.login, type: .user.type}'`,
 * the stub just emits the already-projected JSON `{"login":...,"type":...}`
 * (the hook then jq-parses `.login` / `.type` off it).
 */
function makeStubGhDir(stub: GhStub): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-attr-stub-gh-'));
  let arm: string;
  if (stub === 'fail') {
    arm = `echo "gh: HTTP 503 Service Unavailable" >&2; exit 1`;
  } else {
    const body = JSON.stringify({ login: stub.login, type: stub.type });
    // Single-quote the JSON for echo; JSON has no single quotes.
    arm = `echo '${body}'; exit 0`;
  }
  const stubScript = `#!/usr/bin/env bash
# Stub gh — only handles \`gh api <path> --jq ...\`.
if [[ "$1" == "api" ]]; then
  ${arm}
fi
echo "stub gh: unexpected subcommand: $*" >&2
exit 1
`;
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, stubScript);
  chmodSync(ghPath, 0o755);
  return dir;
}

/**
 * Build a temp workspace with `.macf/macf-agent.json` carrying the given
 * fields, for the hook's `${CLAUDE_PROJECT_DIR}/.macf/macf-agent.json` read.
 * Returns the dir (pass as CLAUDE_PROJECT_DIR). macf#535.
 */
function makeAgentWorkspace(agentJson: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-attr-ws-'));
  mkdirSync(join(dir, '.macf'), { recursive: true });
  writeFileSync(join(dir, '.macf', 'macf-agent.json'), JSON.stringify(agentJson));
  return dir;
}

function runHook(opts: {
  readonly command: string;
  /** Tool output text (becomes `.tool_output.stdout`). */
  readonly output?: string;
  /** Use the older `.tool_response.stdout` shape instead of `.tool_output`. */
  readonly legacyOutputShape?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly stubGh?: GhStub;
}): ReturnType<typeof spawnSync> {
  const payload: Record<string, unknown> = {
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  };
  if (opts.output !== undefined) {
    if (opts.legacyOutputShape) {
      payload['tool_response'] = { stdout: opts.output };
    } else {
      payload['tool_output'] = { stdout: opts.output };
    }
  }
  const basePath = process.env['PATH'] ?? '';
  let path = basePath;
  let stubDir: string | undefined;
  if (opts.stubGh !== undefined) {
    stubDir = makeStubGhDir(opts.stubGh);
    path = `${stubDir}:${basePath}`;
  }
  // Scrub ambient MACF_* so the runner env doesn't leak an expected login.
  const cleanEnv: Record<string, string> = { PATH: path };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }
  try {
    return spawnSync('bash', [HOOK_SCRIPT], {
      input: JSON.stringify(payload),
      env: cleanEnv,
      encoding: 'utf-8',
    });
  } finally {
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  }
}

const ISSUE_URL = 'https://github.com/groundnuty/macf/issues/5';
const PR_URL = 'https://github.com/groundnuty/macf/pull/7';
const COMMENT_URL = 'https://github.com/groundnuty/macf/issues/5#issuecomment-123456';

describe('check-gh-attribution.sh (PostToolUse hook)', () => {
  describe('(a) non-gh-write commands → exit 0 (no check)', () => {
    it('allows a non-gh command', () => {
      expect(runHook({ command: 'make -f dev.mk check', output: 'ok' }).status).toBe(0);
    });
    it('allows a gh READ command (gh issue view)', () => {
      expect(runHook({ command: 'gh issue view 5', output: ISSUE_URL }).status).toBe(0);
    });
    it('allows `gh issue close` WITHOUT --comment (no attributable write)', () => {
      // close with no comment writes nothing attributable → skip even if a
      // URL happens to be in the output.
      expect(
        runHook({ command: 'gh issue close 5 --reason completed', output: ISSUE_URL }).status,
      ).toBe(0);
    });
  });

  describe('(b) gh-write but no URL in output → exit 0 (fail-open)', () => {
    it('allows when the output has no github URL (e.g. --json suppressed it)', () => {
      const r = runHook({
        command: 'gh issue create --title x --body y',
        output: '{"number": 5}',
        // stubGh intentionally omitted — the hook must bail before any gh call.
      });
      expect(r.status).toBe(0);
    });
    it('allows when there is no output at all', () => {
      const r = runHook({ command: 'gh pr create --title x --body y' });
      expect(r.status).toBe(0);
    });
  });

  describe('(c) URL present + author type=User (human) → exit 2 (the trap)', () => {
    it('warns LOUDLY naming the resource for a user-authored issue create', () => {
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `Creating issue...\n${ISSUE_URL}\n`,
        stubGh: { login: 'orzech', type: 'User' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(ISSUE_URL);
      expect(r.stderr).toContain('orzech');
      // Names the trap + repair guidance.
      expect(r.stderr).toContain('macf#489');
      expect(r.stderr).toContain('macf-gh-token.sh');
    });

    it('warns for a user-authored comment (comment-id URL → issues/comments path)', () => {
      const r = runHook({
        command: 'gh issue comment 5 --repo groundnuty/macf --body "hi"',
        output: `${COMMENT_URL}\n`,
        stubGh: { login: 'orzech', type: 'User' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(COMMENT_URL);
    });

    it('warns for a user-authored pr create (pull URL)', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body y',
        output: `${PR_URL}\n`,
        stubGh: { login: 'orzech', type: 'User' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(PR_URL);
    });

    it('reads the older .tool_response.stdout output shape too', () => {
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `${ISSUE_URL}\n`,
        legacyOutputShape: true,
        stubGh: { login: 'orzech', type: 'User' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(ISSUE_URL);
    });
  });

  describe('(d) author type=Bot (no expected login set) → exit 0', () => {
    it('allows a bot-authored issue create when no expected login is known', () => {
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `${ISSUE_URL}\n`,
        stubGh: { login: 'macf-code-agent[bot]', type: 'Bot' },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('(e) expected-login set + matches → exit 0', () => {
    it('allows when MACF_EXPECTED_BOT_LOGIN matches the actual login', () => {
      const r = runHook({
        command: 'gh issue comment 5 --repo groundnuty/macf --body "hi"',
        output: `${COMMENT_URL}\n`,
        stubGh: { login: BOT, type: 'Bot' },
        env: { MACF_EXPECTED_BOT_LOGIN: BOT },
      });
      expect(r.status).toBe(0);
    });

    it('matches across the app/ GraphQL-vs-REST prefix difference', () => {
      // Expected carries no app/ prefix; gh might report app/<name> — both
      // normalize to the same login.
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `${ISSUE_URL}\n`,
        stubGh: { login: `app/${BOT}`, type: 'Bot' },
        env: { MACF_EXPECTED_BOT_LOGIN: BOT },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('(f) expected-login set + actual differs → exit 2', () => {
    it('warns when the actual author differs from MACF_EXPECTED_BOT_LOGIN (even if a Bot)', () => {
      // A DIFFERENT bot wrote it — expected-login takes precedence over the
      // type-based check, so a wrong-bot write is still flagged.
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `${ISSUE_URL}\n`,
        stubGh: { login: 'some-other-agent[bot]', type: 'Bot' },
        env: { MACF_EXPECTED_BOT_LOGIN: BOT },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('some-other-agent[bot]');
      expect(r.stderr).toContain(BOT);
    });
  });

  describe('(g) MACF_SKIP_ATTRIBUTION_CHECK=1 → exit 0 (override)', () => {
    it('bypasses even a confirmed user-authored write', () => {
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `${ISSUE_URL}\n`,
        stubGh: { login: 'orzech', type: 'User' },
        env: { MACF_SKIP_ATTRIBUTION_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('(h) gh failure → exit 0 (fail-open)', () => {
    it('allows when gh api fails (cannot verify authorship)', () => {
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `${ISSUE_URL}\n`,
        stubGh: 'fail',
      });
      expect(r.status).toBe(0);
    });
  });

  // macf#535: agent_name is NOT always the App slug. The hook must not hard-trap
  // a Bot author merely because it differs from the agent_name-derived guess.
  describe('(i) agent_name guess != actual Bot → exit 0 (macf#535)', () => {
    it('allows the auditor (agent_name "auditor", App slug macf-auditor-agent)', () => {
      const ws = makeAgentWorkspace({ agent_name: 'auditor', agent_role: 'auditor' });
      try {
        const r = runHook({
          command: 'gh issue comment 1 --repo groundnuty/macf-auditor-agent --body "x"',
          output: `${COMMENT_URL}\n`,
          stubGh: { login: 'macf-auditor-agent[bot]', type: 'Bot' },
          env: { CLAUDE_PROJECT_DIR: ws },
        });
        expect(r.status).toBe(0);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('(j) github_app.bot_login (authoritative) matches → exit 0', () => {
    it('allows when the actual login matches the config bot_login', () => {
      const ws = makeAgentWorkspace({
        agent_name: 'auditor',
        github_app: { app_id: '1', install_id: '2', key_path: 'k.pem', bot_login: 'macf-auditor-agent[bot]' },
      });
      try {
        const r = runHook({
          command: 'gh issue create --repo groundnuty/macf-auditor-agent --title x --body y',
          output: `${ISSUE_URL}\n`,
          stubGh: { login: 'macf-auditor-agent[bot]', type: 'Bot' },
          env: { CLAUDE_PROJECT_DIR: ws },
        });
        expect(r.status).toBe(0);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('(k) github_app.bot_login (authoritative) + different Bot → exit 2', () => {
    it('warns when a different bot wrote it despite a config bot_login', () => {
      const ws = makeAgentWorkspace({
        agent_name: 'auditor',
        github_app: { app_id: '1', install_id: '2', key_path: 'k.pem', bot_login: 'macf-auditor-agent[bot]' },
      });
      try {
        const r = runHook({
          command: 'gh issue create --repo groundnuty/macf-auditor-agent --title x --body y',
          output: `${ISSUE_URL}\n`,
          stubGh: { login: 'some-other-agent[bot]', type: 'Bot' },
          env: { CLAUDE_PROJECT_DIR: ws },
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('some-other-agent[bot]');
        expect(r.stderr).toContain('macf-auditor-agent[bot]');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('(l) agent_name guess != actual User → exit 2 (Instance-12 still caught)', () => {
    it('traps a user-authored write even when only an agent_name guess exists', () => {
      const ws = makeAgentWorkspace({ agent_name: 'auditor', agent_role: 'auditor' });
      try {
        const r = runHook({
          command: 'gh issue create --repo groundnuty/macf-auditor-agent --title x --body y',
          output: `${ISSUE_URL}\n`,
          stubGh: { login: 'orzech', type: 'User' },
          env: { CLAUDE_PROJECT_DIR: ws },
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('orzech');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
