/**
 * Tests for `scripts/check-close-keyword.sh` — the PreToolUse hook that
 * structurally blocks `gh pr create` / `gh pr edit` invocations whose body /
 * title contains a GitHub auto-close keyword adjacent to an issue ref filed
 * by ANOTHER agent (which would auto-close that issue on merge, bypassing
 * reporter-owns-closure). Path-2 backstop for groundnuty/macf#431.
 *
 * Background: the auto-close-keyword hazard bit code-agent's own PR bodies
 * 4 times (macf#316/#410/#430), 2 of them after the canonical rule + a
 * personal memory existed → cognitive discipline is insufficient → structural
 * enforcement (same promotion logic as #140 / #244+#272 / #270).
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 = allow, exit 2 = block
 * (stderr → Claude). Discriminator is issue authorship — self-filed
 * `Closes #own` passes. Override: MACF_SKIP_CLOSE_CHECK=1.
 *
 * The hook resolves authorship via `gh api repos/<o>/<r>/issues/<N>`, so the
 * tests prepend a stub `gh` shim to PATH (mirrors check-lgtm-gate.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'check-close-keyword.sh');

const ACTING = 'macf-code-agent'; // ACTING_BOT resolves to `macf-code-agent[bot]`
const PEER = 'macf-science-agent[bot]';
const SELF = 'macf-code-agent[bot]';

/** Per-issue stub: who authored it (+ whether it's actually a PR), or a
 *  special sentinel for a 404 / non-404 API error. Keyed by `owner/repo#N`. */
type IssueStub =
  | { readonly author: string; readonly isPR?: boolean }
  | 'notfound'
  | 'apierror';
type StubMap = Record<string, IssueStub>;

/**
 * Build a directory with a stub `gh` shim that answers
 * `gh api repos/<o>/<r>/issues/<N>` from the supplied map (emits the full
 * issue JSON the hook then jq-parses), plus `gh repo view --json
 * nameWithOwner` for the no---repo fallback. Returns the dir to prepend to PATH.
 */
function makeStubGhDir(stubs: StubMap, defaultRepo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-close-stub-gh-'));
  const arms = Object.entries(stubs)
    .map(([key, stub]) => {
      if (stub === 'notfound') {
        return `    '${key}') echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`;
      }
      if (stub === 'apierror') {
        return `    '${key}') echo "gh: HTTP 503 Service Unavailable" >&2; exit 1 ;;`;
      }
      const body = JSON.stringify({
        number: Number(key.split('#')[1]),
        user: { login: stub.author },
        pull_request: stub.isPR ? { url: 'https://example/pr' } : null,
      });
      // Single-quote the JSON for echo; JSON has no single quotes.
      return `    '${key}') echo '${body}'; exit 0 ;;`;
    })
    .join('\n');

  const stubScript = `#!/usr/bin/env bash
# Stub gh — handles \`gh api repos/O/R/issues/N\` + \`gh repo view --json nameWithOwner\`.
if [[ "$1" == "repo" && "$2" == "view" ]]; then
  echo '${defaultRepo}'
  exit 0
fi
if [[ "$1" == "api" ]]; then
  PATH_ARG="$2"
  rest="\${PATH_ARG#repos/}"
  repo="\${rest%/issues/*}"
  num="\${rest##*/issues/}"
  key="\${repo}#\${num}"
  case "$key" in
${arms}
    *) echo "stub gh: no stub for $key" >&2; exit 1 ;;
  esac
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
  readonly stubGh?: StubMap;
  readonly defaultRepo?: string;
}): ReturnType<typeof spawnSync> {
  const payload = JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  });
  const basePath = process.env['PATH'] ?? '';
  let path = basePath;
  let stubDir: string | undefined;
  if (opts.stubGh) {
    stubDir = makeStubGhDir(opts.stubGh, opts.defaultRepo ?? 'groundnuty/macf');
    path = `${stubDir}:${basePath}`;
  }
  // Default identity = code-agent unless the test overrides it. Scrub other
  // MACF_* so ambient runner env doesn't leak.
  const cleanEnv: Record<string, string> = { PATH: path, MACF_AGENT_NAME: ACTING };
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

describe('check-close-keyword.sh (hook)', () => {
  describe('pass-through — non-target commands', () => {
    it('allows `gh pr view`', () => {
      expect(runHook({ command: 'gh pr view 5' }).status).toBe(0);
    });
    it('allows `gh issue create` (not pr create/edit)', () => {
      expect(runHook({ command: 'gh issue create --title x --body "closes #5"' }).status).toBe(0);
    });
    it('allows `gh pr merge`', () => {
      expect(runHook({ command: 'gh pr merge 5 --squash' }).status).toBe(0);
    });
    it('allows non-gh commands', () => {
      expect(runHook({ command: 'make -f dev.mk check' }).status).toBe(0);
    });
  });

  describe('no close-keyword adjacency → allow (no API call needed)', () => {
    it('allows `Refs #N`', () => {
      const r = runHook({ command: 'gh pr create --repo groundnuty/macf --title x --body "Refs #5"' });
      expect(r.status).toBe(0);
    });
    it('allows keyword NOT adjacent to the ref ("fix the bug in #5")', () => {
      const r = runHook({ command: 'gh pr create --repo groundnuty/macf --title x --body "this should fix the bug in #5"' });
      expect(r.status).toBe(0);
    });
    it('does not match a keyword embedded in a longer word ("prefixes #5")', () => {
      const r = runHook({ command: 'gh pr create --repo groundnuty/macf --title x --body "the prefixes #5 are listed"' });
      expect(r.status).toBe(0);
    });
  });

  describe('peer-authored issue → BLOCK', () => {
    it('blocks `closes #N` (inline --body) for a peer issue', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "closes #5"',
        stubGh: { 'groundnuty/macf#5': { author: PEER } },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('#5');
      expect(r.stderr).toContain(PEER);
      expect(r.stderr).toContain('Refs');
    });

    it('blocks `Fixes #N` (case-insensitive)', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "Fixes #7 with a patch"',
        stubGh: { 'groundnuty/macf#7': { author: PEER } },
      });
      expect(r.status).toBe(2);
    });

    it('blocks a close-keyword in the --title', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title "resolve #8 finally" --body "ok"',
        stubGh: { 'groundnuty/macf#8': { author: PEER } },
      });
      expect(r.status).toBe(2);
    });

    it('blocks the optional-colon form `Closes: #N`', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "Closes: #9"',
        stubGh: { 'groundnuty/macf#9': { author: PEER } },
      });
      expect(r.status).toBe(2);
    });

    it('blocks via wrapped invocation `GH_TOKEN=x gh pr create ...`', () => {
      const r = runHook({
        command: 'GH_TOKEN=ghs_x gh pr create --repo groundnuty/macf --title x --body "closes #5"',
        stubGh: { 'groundnuty/macf#5': { author: PEER } },
      });
      expect(r.status).toBe(2);
    });

    it('blocks `gh pr edit` too', () => {
      const r = runHook({
        command: 'gh pr edit 12 --repo groundnuty/macf --body "fixed #5"',
        stubGh: { 'groundnuty/macf#5': { author: PEER } },
      });
      expect(r.status).toBe(2);
    });
  });

  describe('--body-file (the file-content bypass) → BLOCK', () => {
    it('reads the --body-file contents and blocks a peer close-keyword', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-close-bodyfile-'));
      const bf = join(dir, 'body.md');
      writeFileSync(bf, 'Implements the fix.\n\nresolves #5\n');
      try {
        const r = runHook({
          command: `gh pr create --repo groundnuty/macf --title x --body-file ${bf}`,
          stubGh: { 'groundnuty/macf#5': { author: PEER } },
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('#5');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('cross-repo `owner/repo#N` → BLOCK, authorship resolved against the referenced repo', () => {
    it('blocks `closes other/repo#N` filed by a peer in the OTHER repo', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf-devops-toolkit --title x --body "closes groundnuty/macf#418"',
        // The PR repo is devops-toolkit, but authorship must resolve against
        // the referenced repo (groundnuty/macf).
        stubGh: { 'groundnuty/macf#418': { author: PEER } },
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('groundnuty/macf#418');
    });
  });

  describe('self-filed / safe cases → allow', () => {
    it('allows `closes #N` when the issue is self-filed', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "closes #9"',
        stubGh: { 'groundnuty/macf#9': { author: SELF } },
      });
      expect(r.status).toBe(0);
    });

    it('allows when the ref is a PR (auto-close keywords do not close PRs)', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "closes #20"',
        stubGh: { 'groundnuty/macf#20': { author: PEER, isPR: true } },
      });
      expect(r.status).toBe(0);
    });

    it('allows when the referenced issue does not exist (404 → no auto-close target)', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "closes #999"',
        stubGh: { 'groundnuty/macf#999': 'notfound' },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('conservative / fail-safe behavior', () => {
    it('blocks on a non-404 API error (cannot verify authorship)', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "closes #5"',
        stubGh: { 'groundnuty/macf#5': 'apierror' },
      });
      expect(r.status).toBe(2);
    });

    it('blocks when the acting identity cannot be determined', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "closes #5"',
        stubGh: { 'groundnuty/macf#5': { author: PEER } },
        env: { MACF_AGENT_NAME: undefined, GIT_AUTHOR_NAME: undefined },
      });
      expect(r.status).toBe(2);
    });

    it('resolves identity from GIT_AUTHOR_NAME when MACF_AGENT_NAME is unset', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "closes #9"',
        stubGh: { 'groundnuty/macf#9': { author: SELF } },
        env: { MACF_AGENT_NAME: undefined, GIT_AUTHOR_NAME: SELF },
      });
      expect(r.status).toBe(0);
    });
  });

  describe('override', () => {
    it('MACF_SKIP_CLOSE_CHECK=1 bypasses even a peer close-keyword', () => {
      const r = runHook({
        command: 'gh pr create --repo groundnuty/macf --title x --body "closes #5"',
        stubGh: { 'groundnuty/macf#5': { author: PEER } },
        env: { MACF_SKIP_CLOSE_CHECK: '1' },
      });
      expect(r.status).toBe(0);
    });
  });
});
