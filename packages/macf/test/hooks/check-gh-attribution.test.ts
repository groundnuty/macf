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
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-gh-attribution.sh');

const BOT = 'macf-code-agent[bot]';

/** What the stub `gh api` returns for the resource: an author login+type, or
 *  a failure sentinel. */
type GhStub =
  | {
      readonly login: string;
      readonly type: 'Bot' | 'User';
      /** Merge reads only: whether the PR is merged (default true). */
      readonly merged?: boolean;
    }
  | 'fail' // gh api exits non-zero, non-auth (network / 404 / 5xx)
  | 'authfail'; // gh api exits non-zero with an auth-failure shape (groundnuty/macf#938)

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
  } else if (stub === 'authfail') {
    // Same shape gh 2.95.0 emits live for a dead installation token,
    // verified against both its REST form (`gh api`) and GraphQL form
    // (`gh pr view`) — groundnuty/macf#938.
    arm = `echo "gh: Bad credentials (HTTP 401)" >&2; exit 1`;
  } else {
    const body = JSON.stringify({
      login: stub.login,
      type: stub.type,
      merged: stub.merged ?? true,
    });
    // Single-quote the JSON for echo; JSON has no single quotes.
    arm = `echo '${body}'; exit 0`;
  }
  const reviewArm =
    typeof stub === 'string'
      ? ''
      : `printf '%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '${stub.login}' '${stub.type}'; exit 0`;
  const stubScript = `#!/usr/bin/env bash
# Stub gh — handles \`gh api <path> --jq ...\` and \`gh repo view\`.
[[ -n "\${STUB_LOG:-}" ]] && echo "$*" >> "$STUB_LOG"
if [[ "$1" == "repo" ]]; then
  [[ -n "\${STUB_CWD_LOG:-}" ]] && pwd >> "$STUB_CWD_LOG"
  echo "\${STUB_REPO:-groundnuty/macf}"; exit 0
fi
if [[ "$1" == "api" ]]; then
  if [[ "$*" == */reviews* ]]; then
    # Reviews are read as one TSV line per review (the hook passes --paginate).
    if [[ -n "\${STUB_PAGE1:-}" ]]; then
      printf '%b\\n' "$STUB_PAGE1"
      [[ "$*" == *--paginate* ]] && printf '%b\\n' "\${STUB_PAGE2:-}"
      exit 0
    fi
    ${reviewArm}
  fi
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
  /** The payload's `cwd` (where the command ran). */
  readonly cwd?: string;
}): ReturnType<typeof spawnSync> {
  const payload: Record<string, unknown> = {
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  };
  if (opts.cwd !== undefined) payload['cwd'] = opts.cwd;
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

    it('override guidance is honest: launch-time/operator + relaunch, not an in-session export fix', () => {
      // groundnuty/macf#822 Part 1.
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `Creating issue...\n${ISSUE_URL}\n`,
        stubGh: { login: 'orzech', type: 'User' },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/launch-time\s*\/\s*operator/);
      expect(r.stderr).toMatch(/relaunch/);
      expect(r.stderr).toMatch(/does\s+NOT\s+reach\s+it/);
      expect(r.stderr).not.toMatch(/^\s*export MACF_SKIP_ATTRIBUTION_CHECK=1\s*$/m);
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

  describe('(h2) credential expired + unrefreshable (groundnuty/macf#938)', () => {
    it('still fails open (exit 0) — this hook cannot block a write that already happened', () => {
      // No MACF_WORKSPACE_DIR / APP_ID / INSTALL_ID / KEY_PATH supplied, so
      // the refresh helper is unreachable and macf_hook_gh's refresh
      // attempt fails too — this is the "refresh helper's own failure is
      // handled" case, exercised together with the auth-failure path.
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `${ISSUE_URL}\n`,
        stubGh: 'authfail',
      });
      expect(r.status).toBe(0);
    });

    it('prints a diagnostic to stderr instead of silently doing nothing', () => {
      // The decisive assertion for this hook: exit code alone cannot
      // distinguish "verified clean" from "never verified" (both are 0) —
      // per assert-the-wrong-path.md, assert the SIGNAL this fix actually
      // changed (stderr visibility), not just the unchanged exit code.
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `${ISSUE_URL}\n`,
        stubGh: 'authfail',
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/could not verify/i);
      expect(r.stderr).toMatch(/did not run/i);
    });

    it('never prints anything token-shaped to stdout or stderr', () => {
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title x --body y',
        output: `${ISSUE_URL}\n`,
        stubGh: 'authfail',
        env: {
          MACF_WORKSPACE_DIR: '/nonexistent-workspace',
          APP_ID: 'test-app-id',
          INSTALL_ID: 'test-install-id',
          KEY_PATH: '/nonexistent-key.pem',
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout ?? '').not.toMatch(/ghs_/);
      expect(r.stderr ?? '').not.toMatch(/ghs_/);
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

  describe('(m) gh pr review / gh api merge are read back (macf#1475)', () => {
    const logs: string[] = [];
    function hook(command: string, stub: GhStub, extraEnv: Record<string, string> = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'macf-attr-log-'));
      const log = join(dir, 'gh.log');
      logs.push(dir);
      const r = runHook({
        command,
        output: '',
        stubGh: stub,
        env: { STUB_LOG: log, ...extraEnv },
      });
      let calls = '';
      try {
        calls = readFileSync(log, 'utf-8');
      } catch {
        calls = '';
      }
      return { r, calls };
    }
    afterEach(() => {
      for (const d of logs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const USER: GhStub = { login: 'orzech', type: 'User' };
    const BOTSTUB: GhStub = { login: BOT, type: 'Bot' };
    const bot = { MACF_EXPECTED_BOT_LOGIN: BOT };
    const ago = (sec: number): string =>
      new Date(Date.now() - sec * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

    it('review by the bot → silent', () => {
      const { r } = hook('gh pr review 7 --approve', BOTSTUB, bot);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    });
    it('review by a user → warns, naming the review', () => {
      const { r, calls } = hook('gh pr review 7 --approve --body "LGTM 99"', USER, bot);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('the review on groundnuty/macf#7');
      expect(r.stderr).toContain('orzech');
      expect(calls).toContain('/repos/groundnuty/macf/pulls/7/reviews');
    });
    it('review with --repo reads that repo', () => {
      const { r, calls } = hook('gh pr review -R acme/widgets 12 --request-changes', USER, bot);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('the review on acme/widgets#12');
      expect(calls).toContain('/repos/acme/widgets/pulls/12/reviews');
      expect(calls).not.toContain('repo view');
    });
    it('review via a PR URL is parsed', () => {
      const { r, calls } = hook(
        'gh pr review https://github.com/acme/widgets/pull/31 --comment --body hi',
        USER,
        bot,
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('the review on acme/widgets#31');
      expect(calls).toContain('/repos/acme/widgets/pulls/31/reviews');
    });
    it('review with no repo uses the repo gh would use', () => {
      const { r } = hook('gh pr review 3 --approve', USER, { ...bot, STUB_REPO: 'o/dflt' });
      expect(r.stderr).toContain('the review on o/dflt#3');
    });

    it('review with the body before the PR number still reads that PR', () => {
      const { r, calls } = hook('gh pr review --body "LGTM" 7 --approve', USER, bot);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('the review on groundnuty/macf#7');
      expect(calls).toContain('/repos/groundnuty/macf/pulls/7/reviews');
    });
    it('review with a quoted PR URL is parsed', () => {
      const { r, calls } = hook('gh pr review "https://github.com/o/r/pull/9" --approve', USER, bot);
      expect(r.stderr).toContain('the review on o/r#9');
      expect(calls).toContain('/repos/o/r/pulls/9/reviews');
    });
    it('review with a quoted --repo value reads that repo', () => {
      const { r, calls } = hook('gh pr review 5 --repo "o/r" --approve', USER, bot);
      expect(r.stderr).toContain('the review on o/r#5');
      expect(calls).not.toContain('repo view');
    });
    it('a command substitution in the body is never executed', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-attr-inj-'));
      logs.push(dir);
      const marker = join(dir, 'x');
      const { r } = hook(`gh pr review 7 --approve --body "$(touch ${marker})"`, USER, bot);
      expect(r.status).toBe(2);
      expect(existsSync(marker)).toBe(false);
    });
    it('a recent review on a later page is read', () => {
      const { r, calls } = hook('gh pr review 7 --approve', USER, {
        ...bot,
        STUB_PAGE1: `${ago(7200)}\\t${BOT}\\tBot`,
        STUB_PAGE2: `${ago(10)}\\torzech\\tUser`,
      });
      expect(calls).toContain('--paginate');
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('orzech');
    });

    it('the latest review is 2 hours old and by a user → silent (the command posted nothing)', () => {
      const { r } = hook('gh pr review 7 --approve', USER, {
        ...bot,
        STUB_PAGE1: `${ago(7200)}\\torzech\\tUser`,
        STUB_PAGE2: '',
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    });
    it('a recent review by the bot plus a recent one by a user → silent', () => {
      const { r } = hook('gh pr review 7 --approve', USER, {
        ...bot,
        STUB_PAGE1: `${ago(20)}\\t${BOT}\\tBot`,
        STUB_PAGE2: `${ago(5)}\\torzech\\tUser`,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    });
    it('only a recent review by a user → warns', () => {
      const { r } = hook('gh pr review 7 --approve', USER, {
        ...bot,
        STUB_PAGE1: `${ago(30)}\\torzech\\tUser`,
        STUB_PAGE2: '',
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('orzech');
    });

    it('a cd before the review with no --repo → silent, no repo lookup', () => {
      const { r, calls } = hook('cd /x && gh pr review 7 --approve', USER, bot);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(calls).not.toContain('repo view');
    });
    it('no --repo → the repo is looked up in the payload cwd', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-attr-cwd-'));
      logs.push(dir);
      const cwdDir = join(dir, 'elsewhere');
      mkdirSync(cwdDir);
      const cwdLog = join(dir, 'cwd.log');
      const logDir = mkdtempSync(join(tmpdir(), 'macf-attr-log-'));
      logs.push(logDir);
      const r = runHook({
        command: 'gh pr review 7 --approve',
        output: '',
        cwd: cwdDir,
        stubGh: USER,
        env: { STUB_LOG: join(logDir, 'gh.log'), STUB_CWD_LOG: cwdLog, ...bot },
      });
      expect(r.status).toBe(2);
      expect(readFileSync(cwdLog, 'utf-8').trim()).toBe(realpathSync(cwdDir));
    });

    it('merge by the bot → silent', () => {
      const { r } = hook('gh api -X PUT repos/o/r/pulls/9/merge -f merge_method=squash', BOTSTUB, bot);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    });
    it('merge by a user → warns, naming the merge', () => {
      const { r, calls } = hook('gh api -X PUT repos/o/r/pulls/9/merge', USER, bot);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('the merge of o/r#9');
      expect(calls).toContain('/repos/o/r/pulls/9');
    });
    it('merge that did not merge → silent', () => {
      const { r } = hook('gh api -X PUT repos/o/r/pulls/9/merge', { ...USER, merged: false }, bot);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    });
    it('merge with a leading slash, flag after the path, and --jq .sha → still matched', () => {
      const { r } = hook('gh api /repos/o/r/pulls/9/merge --method PUT --jq .sha', USER, bot);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('the merge of o/r#9');
    });
    it('a gh api call that is not a merge is not matched', () => {
      const { r, calls } = hook('gh api repos/o/r/issues', USER, bot);
      expect(r.status).toBe(0);
      expect(calls).toBe('');
    });
  });
});
