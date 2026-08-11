/**
 * Tests for `scripts/check-lgtm-gate.sh` — the PreToolUse hook that
 * structurally blocks `gh pr merge` invocations when no non-author
 * APPROVED review exists on the target PR. Implements
 * `plugin/rules/pr-discipline.md` "no LGTM = no merge" enforcement.
 *
 * Background (groundnuty/macf#270, DR-023 amendment 2026-04-27): the
 * LGTM gate is rule-discipline today (codified via macf#262 / PR #263).
 * UC-2 makes it structural. Per the DR-023 amendment, this is a bash
 * command-type hook (NOT `type: "mcp_tool"`) — PreToolUse-blocking
 * semantics + mcp_tool's non-blocking-on-disconnect mode are
 * incompatible. UC-4 (PR #275) demonstrated the bash-form path
 * empirically; this UC follows commit-by-commit.
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 =
 * block (stderr → Claude as the error). Override: MACF_SKIP_LGTM_CHECK=1.
 *
 * `gh pr view --json author,reviews` schema (verified 2026-05-01):
 *   {
 *     "author": { "login": "app/macf-code-agent" | "octocat", ... },
 *     "reviews": [ { "author": { "login": "macf-science-agent" }, "state": "APPROVED" }, ... ]
 *   }
 * Bot author logins are returned as `app/<name>` from this command;
 * reviews[].author.login is the bare login. The script normalizes both
 * sides (strip `app/` prefix + `[bot]` suffix) before comparing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-lgtm-gate.sh');

interface StubReview {
  readonly authorLogin: string;
  readonly state: string;
}

interface StubComment {
  readonly authorLogin: string;
  readonly body: string;
}

interface StubPr {
  readonly authorLogin: string;
  readonly reviews: readonly StubReview[];
  /** Optional — groundnuty/macf#822 Part 2 (operator-sanction-comment path). */
  readonly comments?: readonly StubComment[];
}

/**
 * Map of PR number → stub response. Each stub returns the JSON body
 * `gh pr view <N> --json author,reviews` would produce. Special value
 * `null` means the stub should exit 1 (PR not found / API failure).
 */
type StubMap = Record<string, StubPr | null>;

/**
 * Build a directory containing a stub `gh` shim that maps PR numbers
 * to the supplied responses. Returns the path to prepend to PATH.
 */
function makeStubGhDir(stubs: StubMap): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-lgtm-stub-gh-'));
  // The stub reads its argv, recognizes `pr view <N> ... --json ...`,
  // and emits the corresponding stub from the embedded jq table.
  // A python-script approach would be cleaner but adds a dep; keep
  // it bash + jq.
  const stubScript = `#!/usr/bin/env bash
# Stub gh — only handles \`gh pr view <N> [--repo X] --json author,reviews\`.
# Other gh invocations fail (ensures the test surfaces stray calls).
set -euo pipefail

# Find the subcommand (first non-flag arg after \`pr view\`).
if [[ "\${1:-}" != "pr" ]] || [[ "\${2:-}" != "view" ]]; then
  echo "stub gh: unexpected subcommand \$*" >&2
  exit 64
fi
shift 2  # drop "pr view"

PR_NUM=""
while (( $# > 0 )); do
  case "\$1" in
    --repo|-R)
      shift 2
      ;;
    --repo=*|-R=*)
      shift
      ;;
    --json)
      shift 2
      ;;
    --json=*)
      shift
      ;;
    --*)
      shift
      ;;
    -*)
      shift
      ;;
    *)
      if [[ -z "\$PR_NUM" ]]; then
        PR_NUM="\$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "\$PR_NUM" ]]; then
  echo "stub gh: no PR number" >&2
  exit 64
fi

case "\$PR_NUM" in
${Object.entries(stubs)
  .map(([prNum, stub]) => {
    if (stub === null) {
      // Simulate gh failure (e.g. 404, network).
      return `  ${prNum}) echo "stub gh: PR ${prNum} not found" >&2; exit 1 ;;`;
    }
    const json = JSON.stringify({
      author: { login: stub.authorLogin },
      reviews: stub.reviews.map((r) => ({
        author: { login: r.authorLogin },
        state: r.state,
      })),
      comments: (stub.comments ?? []).map((c) => ({
        author: { login: c.authorLogin },
        body: c.body,
      })),
    });
    return `  ${prNum}) cat <<'JSON_EOF'\n${json}\nJSON_EOF\n  ;;`;
  })
  .join('\n')}
  *)
    echo "stub gh: PR \$PR_NUM has no stub configured" >&2
    exit 1
    ;;
esac
`;
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, stubScript);
  chmodSync(ghPath, 0o755);
  return dir;
}

function runHook(opts: {
  readonly command: string;
  readonly env?: Record<string, string | undefined>;
  readonly stubGh?: StubMap;
}): ReturnType<typeof spawnSync> {
  const payload = JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  });
  // Preserve PATH so bash/jq/sed resolve. Optionally prepend a stub-gh
  // dir so the script's `gh pr view` resolves to our test stub.
  const basePath = process.env['PATH'] ?? '';
  let path = basePath;
  let stubDir: string | undefined;
  if (opts.stubGh) {
    stubDir = makeStubGhDir(opts.stubGh);
    path = `${stubDir}:${basePath}`;
  }
  const cleanEnv: Record<string, string> = { PATH: path };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }
  }
  try {
    return spawnSync('bash', [HOOK_SCRIPT], {
      input: payload,
      env: cleanEnv,
      encoding: 'utf-8',
    });
  } finally {
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  }
}

describe('check-lgtm-gate.sh (hook)', () => {
  describe('positive path — non-merge commands pass through', () => {
    it('allows `gh pr view` (different subcommand)', () => {
      const r = runHook({ command: 'gh pr view 270' });
      expect(r.status).toBe(0);
    });

    it('allows `gh pr list` (different subcommand)', () => {
      const r = runHook({ command: 'gh pr list --label code-agent' });
      expect(r.status).toBe(0);
    });

    it('allows `gh issue view` (entirely different command)', () => {
      const r = runHook({ command: 'gh issue view 270' });
      expect(r.status).toBe(0);
    });

    it('allows `gh issue close` (different command)', () => {
      const r = runHook({ command: 'gh issue close 270 --reason completed' });
      expect(r.status).toBe(0);
    });

    it('allows `git push` (different command axis)', () => {
      const r = runHook({ command: 'git push -u origin main' });
      expect(r.status).toBe(0);
    });

    it('allows non-gh commands entirely', () => {
      const r = runHook({ command: 'make -f dev.mk check' });
      expect(r.status).toBe(0);
    });

    it('allows `gh pr merge-base` if such a sibling subcommand existed (exact-match)', () => {
      // `gh pr merge` (with trailing space/EOL) is the exact match —
      // a hypothetical `gh pr merge-base` should NOT match.
      const r = runHook({ command: 'gh pr merge-base origin/main' });
      expect(r.status).toBe(0);
    });
  });

  describe('positive path — merge with non-author APPROVED review allowed', () => {
    it('allows `gh pr merge 123` when peer-agent approved', () => {
      const r = runHook({
        command: 'gh pr merge 123 --repo owner/repo --squash',
        stubGh: {
          '123': {
            authorLogin: 'app/macf-code-agent',
            reviews: [{ authorLogin: 'macf-science-agent', state: 'APPROVED' }],
          },
        },
      });
      expect(r.status).toBe(0);
    });

    it('allows merge with mixed reviews when at least one non-author APPROVED', () => {
      // PR has multiple reviews — one COMMENTED + one APPROVED from different reviewer.
      const r = runHook({
        command: 'gh pr merge 124 --repo owner/repo --squash --delete-branch',
        stubGh: {
          '124': {
            authorLogin: 'app/macf-code-agent',
            reviews: [
              { authorLogin: 'macf-science-agent', state: 'COMMENTED' },
              { authorLogin: 'macf-tester-1-agent', state: 'APPROVED' },
            ],
          },
        },
      });
      expect(r.status).toBe(0);
    });

    it('allows merge for non-bot author with bot reviewer', () => {
      // Human author, bot reviewer pattern.
      const r = runHook({
        command: 'gh pr merge 125 --repo owner/repo --merge',
        stubGh: {
          '125': {
            authorLogin: 'octocat',
            reviews: [{ authorLogin: 'macf-science-agent', state: 'APPROVED' }],
          },
        },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('negative path — merge without LGTM blocked', () => {
    it('blocks `gh pr merge 200` when PR has no reviews', () => {
      const r = runHook({
        command: 'gh pr merge 200 --repo owner/repo --squash',
        stubGh: {
          '200': {
            authorLogin: 'app/macf-code-agent',
            reviews: [],
          },
        },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/lgtm-gate/);
      expect(r.stderr).toMatch(/no LGTM = no merge/);
      expect(r.stderr).toMatch(/MACF_SKIP_LGTM_CHECK/);
    });

    it('blocks when only author APPROVED their own PR (self-approval)', () => {
      const r = runHook({
        command: 'gh pr merge 201 --repo owner/repo --squash',
        stubGh: {
          '201': {
            authorLogin: 'app/macf-code-agent',
            // Self-review (same login as author) doesn't count.
            reviews: [{ authorLogin: 'macf-code-agent', state: 'APPROVED' }],
          },
        },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
    });

    it('blocks when peer reviewed but did NOT approve (CHANGES_REQUESTED)', () => {
      const r = runHook({
        command: 'gh pr merge 202 --repo owner/repo --squash',
        stubGh: {
          '202': {
            authorLogin: 'app/macf-code-agent',
            reviews: [{ authorLogin: 'macf-science-agent', state: 'CHANGES_REQUESTED' }],
          },
        },
      });
      expect(r.status).toBe(2);
    });

    it('blocks when peer reviewed but only COMMENTED (no APPROVED state)', () => {
      const r = runHook({
        command: 'gh pr merge 203 --repo owner/repo --squash',
        stubGh: {
          '203': {
            authorLogin: 'app/macf-code-agent',
            reviews: [{ authorLogin: 'macf-science-agent', state: 'COMMENTED' }],
          },
        },
      });
      expect(r.status).toBe(2);
    });

    it('block message cites pr-discipline.md + canonical rule text', () => {
      const r = runHook({
        command: 'gh pr merge 204 --repo owner/repo --squash',
        stubGh: {
          '204': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('pr-discipline.md');
      expect(r.stderr).toContain('no LGTM = no merge');
    });

    it('block message includes example fix + override hint', () => {
      const r = runHook({
        command: 'gh pr merge 205 --repo owner/repo --squash',
        stubGh: {
          '205': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('gh pr review');
      expect(r.stderr).toContain('--approve');
      expect(r.stderr).toContain('MACF_SKIP_LGTM_CHECK=1');
    });

    it('override guidance is honest: launch-time/operator + relaunch, not an in-session export fix', () => {
      // groundnuty/macf#822 Part 1.
      const r = runHook({
        command: 'gh pr merge 206 --repo owner/repo --squash',
        stubGh: {
          '206': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/launch-time\s*\/\s*operator/);
      expect(r.stderr).toMatch(/relaunch/);
      expect(r.stderr).toMatch(/does\s+NOT\s+reach\s+it/);
      expect(r.stderr).not.toMatch(/^\s*export MACF_SKIP_LGTM_CHECK=1\s*$/m);
    });
  });

  describe('wrapper-aware matching (bypass prevention)', () => {
    it('blocks `sudo gh pr merge` without LGTM', () => {
      const r = runHook({
        command: 'sudo gh pr merge 300 --repo owner/repo --squash',
        stubGh: {
          '300': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
    });

    it('blocks `bash -c "gh pr merge ..."` without LGTM', () => {
      const r = runHook({
        command: 'bash -c \'gh pr merge 301 --repo owner/repo --squash\'',
        stubGh: {
          '301': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
    });

    it('blocks `env FOO=bar gh pr merge` without LGTM', () => {
      const r = runHook({
        command: 'env FOO=bar gh pr merge 302 --repo owner/repo --squash',
        stubGh: {
          '302': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
    });

    it('blocks `GH_TOKEN=ghs_x gh pr merge` without LGTM (env-VAR= form)', () => {
      const r = runHook({
        command: 'GH_TOKEN=ghs_x gh pr merge 303 --repo owner/repo --squash',
        stubGh: {
          '303': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
    });

    it('blocks chained `cmd && gh pr merge` without LGTM', () => {
      const r = runHook({
        command: 'echo ok && gh pr merge 304 --repo owner/repo --squash',
        stubGh: {
          '304': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
    });

    it('allows `sudo gh pr merge` when LGTM exists (wrapper does NOT bypass approval)', () => {
      const r = runHook({
        command: 'sudo gh pr merge 305 --repo owner/repo --squash',
        stubGh: {
          '305': {
            authorLogin: 'app/macf-code-agent',
            reviews: [{ authorLogin: 'macf-science-agent', state: 'APPROVED' }],
          },
        },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('override path — MACF_SKIP_LGTM_CHECK=1 bypasses', () => {
    it('allows merge without LGTM when MACF_SKIP_LGTM_CHECK=1', () => {
      const r = runHook({
        command: 'gh pr merge 400 --repo owner/repo --squash',
        env: { MACF_SKIP_LGTM_CHECK: '1' },
        // No stub — the override should short-circuit before any gh call.
      });
      expect(r.status).toBe(0);
    });

    it('does NOT bypass on MACF_SKIP_LGTM_CHECK=0 (only "1" overrides)', () => {
      const r = runHook({
        command: 'gh pr merge 401 --repo owner/repo --squash',
        env: { MACF_SKIP_LGTM_CHECK: '0' },
        stubGh: {
          '401': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
    });

    it('does NOT bypass on MACF_SKIP_LGTM_CHECK="" (empty string)', () => {
      const r = runHook({
        command: 'gh pr merge 402 --repo owner/repo --squash',
        env: { MACF_SKIP_LGTM_CHECK: '' },
        stubGh: {
          '402': { authorLogin: 'app/macf-code-agent', reviews: [] },
        },
      });
      expect(r.status).toBe(2);
    });
  });

  describe('operator-login sanction-comment path (groundnuty/macf#822 Part 2)', () => {
    it('clears the gate on an operator-login [macf-sanction-merge] comment with NO approving review', () => {
      const r = runHook({
        command: 'gh pr merge 800 --repo owner/repo --squash',
        env: { MACF_OPERATOR_LOGIN: 'groundnuty' },
        stubGh: {
          '800': {
            authorLogin: 'app/macf-code-agent',
            reviews: [],
            comments: [
              { authorLogin: 'groundnuty', body: 'Reviewer is offline, sanctioning this one. [macf-sanction-merge]' },
            ],
          },
        },
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/operator-sanction/i);
    });

    it('the un-forgeable property: an AGENT/non-operator login posting the marker does NOT clear the gate', () => {
      // Load-bearing test — this is the whole point of preferring (c) over
      // a self-writable marker: only a comment AUTHORED BY the configured
      // operator login counts. A peer agent (or the PR author itself)
      // posting the exact same marker text must still BLOCK.
      const r = runHook({
        command: 'gh pr merge 801 --repo owner/repo --squash',
        env: { MACF_OPERATOR_LOGIN: 'groundnuty' },
        stubGh: {
          '801': {
            authorLogin: 'app/macf-code-agent',
            reviews: [],
            comments: [
              { authorLogin: 'macf-science-agent', body: '[macf-sanction-merge]' },
            ],
          },
        },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
    });

    it('an operator-login comment WITHOUT the marker does NOT clear the gate', () => {
      const r = runHook({
        command: 'gh pr merge 802 --repo owner/repo --squash',
        env: { MACF_OPERATOR_LOGIN: 'groundnuty' },
        stubGh: {
          '802': {
            authorLogin: 'app/macf-code-agent',
            reviews: [],
            comments: [{ authorLogin: 'groundnuty', body: 'LGTM, go ahead and merge.' }],
          },
        },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
    });

    it('MACF_OPERATOR_LOGIN unset + sanction comment present + no approval → still BLOCKS (path off)', () => {
      const r = runHook({
        command: 'gh pr merge 803 --repo owner/repo --squash',
        // MACF_OPERATOR_LOGIN intentionally omitted from env.
        stubGh: {
          '803': {
            authorLogin: 'app/macf-code-agent',
            reviews: [],
            comments: [{ authorLogin: 'groundnuty', body: '[macf-sanction-merge]' }],
          },
        },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
    });

    it('marker match is case-insensitive', () => {
      const r = runHook({
        command: 'gh pr merge 804 --repo owner/repo --squash',
        env: { MACF_OPERATOR_LOGIN: 'groundnuty' },
        stubGh: {
          '804': {
            authorLogin: 'app/macf-code-agent',
            reviews: [],
            comments: [{ authorLogin: 'groundnuty', body: 'ok — [MACF-SANCTION-MERGE]' }],
          },
        },
      });
      expect(r.status).toBe(0);
    });

    it('a non-author APPROVED review still clears the gate when MACF_OPERATOR_LOGIN is configured (unchanged path)', () => {
      const r = runHook({
        command: 'gh pr merge 805 --repo owner/repo --squash',
        env: { MACF_OPERATOR_LOGIN: 'groundnuty' },
        stubGh: {
          '805': {
            authorLogin: 'app/macf-code-agent',
            reviews: [{ authorLogin: 'macf-science-agent', state: 'APPROVED' }],
            comments: [],
          },
        },
      });
      expect(r.status).toBe(0);
    });

    it('an operator FORMAL APPROVE (review, not comment) still clears the gate — the operator IS a valid non-author reviewer', () => {
      const r = runHook({
        command: 'gh pr merge 806 --repo owner/repo --squash',
        env: { MACF_OPERATOR_LOGIN: 'groundnuty' },
        stubGh: {
          '806': {
            authorLogin: 'app/macf-code-agent',
            reviews: [{ authorLogin: 'groundnuty', state: 'APPROVED' }],
          },
        },
      });
      expect(r.status).toBe(0);
    });

    it('self-approve by the PR author still does NOT clear the gate even with MACF_OPERATOR_LOGIN configured', () => {
      const r = runHook({
        command: 'gh pr merge 807 --repo owner/repo --squash',
        env: { MACF_OPERATOR_LOGIN: 'groundnuty' },
        stubGh: {
          '807': {
            authorLogin: 'app/macf-code-agent',
            reviews: [{ authorLogin: 'macf-code-agent', state: 'APPROVED' }],
            comments: [],
          },
        },
      });
      expect(r.status).toBe(2);
    });

    it('MACF_SKIP_LGTM_CHECK=1 still short-circuits before any operator-login logic runs', () => {
      const r = runHook({
        command: 'gh pr merge 808 --repo owner/repo --squash',
        env: { MACF_SKIP_LGTM_CHECK: '1', MACF_OPERATOR_LOGIN: 'groundnuty' },
        // No stub — the skip override should short-circuit before any gh call.
      });
      expect(r.status).toBe(0);
    });

    it('fail-open on gh error is unaffected by MACF_OPERATOR_LOGIN being configured', () => {
      const r = runHook({
        command: 'gh pr merge 809 --repo owner/repo --squash',
        env: { MACF_OPERATOR_LOGIN: 'groundnuty' },
        stubGh: { '809': null },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('PR-number extraction edge cases', () => {
    it('extracts PR number when followed by --squash flag', () => {
      const r = runHook({
        command: 'gh pr merge 500 --squash',
        stubGh: { '500': { authorLogin: 'app/x', reviews: [] } },
      });
      expect(r.status).toBe(2);
    });

    it('extracts PR number when --repo flag precedes it (--repo X 501)', () => {
      const r = runHook({
        command: 'gh pr merge --repo owner/repo 501 --squash',
        stubGh: { '501': { authorLogin: 'app/x', reviews: [] } },
      });
      expect(r.status).toBe(2);
    });

    it('extracts PR number from URL form (https://github.com/owner/repo/pull/N)', () => {
      const r = runHook({
        command: 'gh pr merge https://github.com/owner/repo/pull/502 --squash',
        stubGh: { '502': { authorLogin: 'app/x', reviews: [] } },
      });
      expect(r.status).toBe(2);
    });

    it('falls open when no PR number can be extracted (bare `gh pr merge` with no positional)', () => {
      // gh in interactive mode would prompt; in headless, it errors.
      // The hook fails open per defense-in-depth.
      const r = runHook({
        command: 'gh pr merge --squash',
      });
      expect(r.status).toBe(0);
    });
  });

  describe('defense-in-depth — fail-open on infrastructure errors', () => {
    it('allows merge when gh pr view exits non-zero (404 / network / auth)', () => {
      // Simulated gh failure — the stub returns null for PR 600, which
      // triggers `exit 1` in the stub gh.
      const r = runHook({
        command: 'gh pr merge 600 --repo owner/repo --squash',
        stubGh: { '600': null },
      });
      // Defense-in-depth: gh failure → fail-open. Operator discipline +
      // canonical rule remain primary defenses; the hook closes residual.
      expect(r.status).toBe(0);
    });

    it('allows merge when gh is not on PATH (worst-case missing tool)', () => {
      // Build a PATH that contains bash/jq/sed (so the script itself
      // runs) but lacks `gh`. Use only an empty stub dir prepended;
      // resolve standard system paths from the test's PATH so basic
      // shell builtins work.
      const stubDir = mkdtempSync(join(tmpdir(), 'macf-lgtm-no-gh-'));
      // Don't write a `gh` stub — just verify the script's `gh` lookup
      // is what fails. We must keep the rest of PATH for bash/jq/sed.
      // Filter out any path entries that contain `gh` from the basePATH
      // would be brittle; instead, prepend the empty stubDir AND filter
      // out brew/system paths likely to host `gh`. Simplest approach:
      // shadow `gh` itself with a non-executable file in stubDir at the
      // start of PATH.
      writeFileSync(join(stubDir, 'gh'), '');
      // No chmod +x — bash will report "permission denied" when trying
      // to exec; the script's `gh pr view ... 2>/dev/null || exit 0`
      // path then fires fail-open.
      const path = `${stubDir}:${process.env['PATH'] ?? ''}`;
      try {
        const r = spawnSync('bash', [HOOK_SCRIPT], {
          input: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'gh pr merge 601 --repo owner/repo --squash' },
          }),
          env: { PATH: path },
          encoding: 'utf-8',
        });
        expect(r.status).toBe(0);
      } finally {
        rmSync(stubDir, { recursive: true, force: true });
      }
    });

    it('falls through to allow on parse error (defense-in-depth)', () => {
      // Non-JSON stdin must not brick the harness — fail open.
      // Same convention as check-gh-token.sh + check-mention-routing.sh.
      const r = spawnSync('bash', [HOOK_SCRIPT], {
        input: 'not-json-at-all',
        env: { PATH: process.env['PATH'] ?? '' },
        encoding: 'utf-8',
      });
      expect(r.status).toBe(0);
    });

    it('falls through to allow on empty stdin', () => {
      const r = spawnSync('bash', [HOOK_SCRIPT], {
        input: '',
        env: { PATH: process.env['PATH'] ?? '' },
        encoding: 'utf-8',
      });
      expect(r.status).toBe(0);
    });
  });

  describe('author/reviewer identity normalization', () => {
    it('treats `app/macf-code-agent` (PR author) as same login as `macf-code-agent` (review author)', () => {
      // The script normalizes by stripping `app/` from PR author and
      // `[bot]` suffix from both — so `app/macf-code-agent` (author)
      // matches `macf-code-agent` (reviewer login). When the SAME bot
      // reviews its own PR, that doesn't count as a non-author approval.
      const r = runHook({
        command: 'gh pr merge 700 --repo owner/repo --squash',
        stubGh: {
          '700': {
            authorLogin: 'app/macf-code-agent',
            reviews: [{ authorLogin: 'macf-code-agent', state: 'APPROVED' }],
          },
        },
      });
      expect(r.status).toBe(2);
    });

    it('treats `[bot]` suffix variations as the same identity', () => {
      // Review author returned with `[bot]` suffix (some gh versions /
      // direct gh api shape) — same author normalization should apply.
      const r = runHook({
        command: 'gh pr merge 701 --repo owner/repo --squash',
        stubGh: {
          '701': {
            authorLogin: 'app/macf-code-agent',
            reviews: [{ authorLogin: 'macf-code-agent[bot]', state: 'APPROVED' }],
          },
        },
      });
      // Self-review even with [bot] suffix → not a non-author approval.
      expect(r.status).toBe(2);
    });
  });
});
