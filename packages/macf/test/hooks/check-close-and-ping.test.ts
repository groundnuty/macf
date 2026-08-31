/**
 * Tests for `scripts/check-close-and-ping.sh` — the PreToolUse hook that, at
 * the moment of `gh issue close`, enumerates the still-OPEN issues whose own
 * timeline cross-references the issue being closed, so the closer sees who
 * is waiting on this close without anyone having to remember to check.
 * Path-2 promotion for groundnuty/macf#1385 (motivated by four instances of
 * a closing condition being met on a DIFFERENT issue than the one that
 * actually gates it — the event never got observed).
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 ALWAYS (this hook never
 * blocks). On a matching `gh issue close` with at least one still-open
 * inbound cross-reference, stdout carries the structured `hookSpecificOutput`
 * PreToolUse allow-contract with `additionalContext` naming each candidate
 * AND the reason it was surfaced; on anything else (no match, no open
 * candidates, infra failure) stdout is EMPTY — true silence, per #1385's own
 * "no candidates → silent" acceptance criterion.
 *
 * Decisive pair (per assert-the-wrong-path.md — test 1 alone is satisfied by
 * always printing something on every close; it takes test 2 to prove the
 * hook is actually filtering by state rather than emitting boilerplate for
 * any cross-reference at all):
 *   1. an issue with OPEN inbound cross-references → they are surfaced,
 *      WITH the reason each was surfaced.
 *   2. an issue whose inbound cross-references are all CLOSED → silent.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-close-and-ping.sh');

/** One `cross-referenced` timeline event's source, as this hook's jq filter distills it. */
type XrefStub = { readonly number: number; readonly repo: string; readonly state: 'open' | 'closed' };

/** Per-timeline-path stub: the NDJSON lines the hook's jq filter would have produced, or a fetch-error sentinel. */
type PathStub = { readonly xrefs: readonly XrefStub[] } | 'apierror';
type StubMap = Record<string, PathStub>;

/**
 * Build a directory with a stub `gh` shim that answers
 * `gh api <path> --paginate --jq '...'` from the supplied map, keyed by the
 * exact timeline path the hook constructs (e.g.
 * `repos/groundnuty/macf/issues/786/timeline` or, when the close omitted
 * `--repo`, the placeholder form `repos/{owner}/{repo}/issues/786/timeline`).
 * The stub bypasses real jq entirely — it hands back the NDJSON the real
 * `--jq` filter would have produced for that timeline, since this hook's own
 * jq-filter TEXT is not what's under test here (the shell logic around it
 * is).
 */
function makeStubGhDir(stubs: StubMap): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-close-ping-stub-gh-'));
  const arms = Object.entries(stubs)
    .map(([path, stub]) => {
      if (stub === 'apierror') {
        return `    '${path}') echo "gh: HTTP 503 Service Unavailable" >&2; exit 1 ;;`;
      }
      const ndjson = stub.xrefs
        .map((x) => JSON.stringify({ number: x.number, repo: x.repo, state: x.state }))
        .join('\n');
      return `    '${path}') cat <<'NDJSON_EOF'\n${ndjson}\nNDJSON_EOF\n    exit 0 ;;`;
    })
    .join('\n');

  const stubScript = `#!/usr/bin/env bash
# Stub gh — handles \`gh api <path> --paginate --jq '...'\`.
if [[ "$1" == "api" ]]; then
  path="$2"
  case "$path" in
${arms}
    *) echo "stub gh: no stub for $path" >&2; exit 1 ;;
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
    stubDir = makeStubGhDir(opts.stubGh);
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

/** Parse the hook's stdout as the PreToolUse hookSpecificOutput contract, or null if empty/unparseable. */
function parseAdditionalContext(stdout: string): string | null {
  if (!stdout.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    const obj = parsed as { hookSpecificOutput?: { additionalContext?: string } };
    return obj.hookSpecificOutput?.additionalContext ?? null;
  } catch {
    return null;
  }
}

const REASON_SUFFIX = 'closed; you referenced it and are still open.';

describe('check-close-and-ping.sh (hook)', () => {
  describe('pass-through — non-target commands (always exit 0, no output)', () => {
    it('allows `gh issue view` (not close)', () => {
      const r = runHook({ command: 'gh issue view 786' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows `gh pr close` (not `issue close`)', () => {
      const r = runHook({ command: 'gh pr close 786' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows `gh issue list`', () => {
      const r = runHook({ command: 'gh issue list --label code-agent' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows non-gh commands', () => {
      const r = runHook({ command: 'make -f dev.mk check' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('decisive pair (assert-the-wrong-path.md)', () => {
    it('1. OPEN inbound cross-references ARE surfaced, with the reason each fired', () => {
      const r = runHook({
        command: 'gh issue close 786 --repo groundnuty/macf',
        stubGh: {
          'repos/groundnuty/macf/issues/786/timeline': {
            xrefs: [
              { number: 789, repo: 'groundnuty/macf', state: 'open' },
              { number: 810, repo: 'groundnuty/macf', state: 'open' },
              { number: 787, repo: 'groundnuty/macf', state: 'closed' },
            ],
          },
        },
      });
      expect(r.status).toBe(0);
      const ctx = parseAdditionalContext(r.stdout);
      expect(ctx).not.toBeNull();
      expect(ctx).toContain('#789');
      expect(ctx).toContain('#810');
      expect(ctx).not.toContain('#787');
      // Each surfaced candidate states WHY — not a bare "#786 closed".
      expect(ctx).toContain(`#786 ${REASON_SUFFIX}`);
    });

    it('2. ALL inbound cross-references CLOSED → silent (no output at all)', () => {
      const r = runHook({
        command: 'gh issue close 42 --repo groundnuty/macf',
        stubGh: {
          'repos/groundnuty/macf/issues/42/timeline': {
            xrefs: [
              { number: 40, repo: 'groundnuty/macf', state: 'closed' },
              { number: 41, repo: 'groundnuty/macf', state: 'closed' },
            ],
          },
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('no cross-references at all → silent', () => {
    it('an issue with zero cross-referenced timeline events produces no output', () => {
      const r = runHook({
        command: 'gh issue close 99 --repo groundnuty/macf',
        stubGh: { 'repos/groundnuty/macf/issues/99/timeline': { xrefs: [] } },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('dedup — a source referencing the target more than once counts as ONE candidate', () => {
    it('collapses duplicate cross-referenced events from the same source issue', () => {
      const r = runHook({
        command: 'gh issue close 786 --repo groundnuty/macf',
        stubGh: {
          'repos/groundnuty/macf/issues/786/timeline': {
            xrefs: [
              { number: 789, repo: 'groundnuty/macf', state: 'open' },
              { number: 789, repo: 'groundnuty/macf', state: 'open' },
            ],
          },
        },
      });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      const occurrences = ctx.split('#789').length - 1;
      // Appears once as the candidate ref, once inside "#786 closed..." never
      // repeats #789 — so exactly one candidate-line occurrence.
      expect(occurrences).toBe(1);
    });
  });

  describe('cross-repo candidate formatting', () => {
    it('shows a bare "#N" for a candidate in the SAME repo as the close', () => {
      const r = runHook({
        command: 'gh issue close 786 --repo groundnuty/macf',
        stubGh: {
          'repos/groundnuty/macf/issues/786/timeline': {
            xrefs: [{ number: 789, repo: 'groundnuty/macf', state: 'open' }],
          },
        },
      });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('- #789 —');
      expect(ctx).not.toContain('groundnuty/macf#789');
    });

    it('shows "owner/repo#N" for a candidate in a DIFFERENT repo than the close', () => {
      const r = runHook({
        command: 'gh issue close 786 --repo groundnuty/macf',
        stubGh: {
          'repos/groundnuty/macf/issues/786/timeline': {
            xrefs: [{ number: 74, repo: 'groundnuty/macf-actions', state: 'open' }],
          },
        },
      });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('- groundnuty/macf-actions#74 —');
    });
  });

  describe('issue-number + --repo extraction forms (mirrors check-close-condition.sh)', () => {
    const XREFS = { xrefs: [{ number: 789, repo: 'groundnuty/macf', state: 'open' as const }] };

    it('extracts a bare integer positional', () => {
      const r = runHook({
        command: 'gh issue close 786 --repo groundnuty/macf',
        stubGh: { 'repos/groundnuty/macf/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });

    it('extracts the issue number from a URL positional', () => {
      const r = runHook({
        command: 'gh issue close https://github.com/groundnuty/macf/issues/786 --repo groundnuty/macf',
        stubGh: { 'repos/groundnuty/macf/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });

    it('extracts the issue number from `owner/repo#N` shorthand and resolves via the {owner}/{repo} placeholder path', () => {
      const r = runHook({
        command: 'gh issue close groundnuty/macf#786',
        stubGh: { 'repos/{owner}/{repo}/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });

    it('accepts `--repo=owner/repo` glued form', () => {
      const r = runHook({
        command: 'gh issue close 786 --repo=groundnuty/macf',
        stubGh: { 'repos/groundnuty/macf/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });

    it('accepts `-R owner/repo` short-flag form', () => {
      const r = runHook({
        command: 'gh issue close 786 -R groundnuty/macf',
        stubGh: { 'repos/groundnuty/macf/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });

    it('skips value-taking flags (--comment, --reason) before finding the issue number', () => {
      const r = runHook({
        command: 'gh issue close --comment "done" --reason completed 786 --repo groundnuty/macf',
        stubGh: { 'repos/groundnuty/macf/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });

    it('allows (no crash) when no issue number can be extracted', () => {
      const r = runHook({ command: 'gh issue close --repo groundnuty/macf' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('with no --repo given, resolves the timeline path via the {owner}/{repo} placeholder', () => {
      const r = runHook({
        command: 'gh issue close 786',
        stubGh: { 'repos/{owner}/{repo}/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });
  });

  describe('wrapper / subshell bypass coverage (mirrors check-close-condition.sh)', () => {
    const XREFS = { xrefs: [{ number: 789, repo: 'groundnuty/macf', state: 'open' as const }] };

    it('recognizes `sudo gh issue close ...`', () => {
      const r = runHook({
        command: 'sudo gh issue close 786 --repo groundnuty/macf',
        stubGh: { 'repos/groundnuty/macf/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });

    it('recognizes `bash -c "gh issue close ..."` (SHELL_C path)', () => {
      const r = runHook({
        command: `bash -c 'gh issue close 786 --repo groundnuty/macf'`,
        stubGh: { 'repos/groundnuty/macf/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });

    it('recognizes a subshell `(gh issue close ...)`', () => {
      const r = runHook({
        command: '(gh issue close 786 --repo groundnuty/macf)',
        stubGh: { 'repos/groundnuty/macf/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });

    it('recognizes `env GH_TOKEN=x gh issue close ...`', () => {
      const r = runHook({
        command: 'env GH_TOKEN=ghs_x gh issue close 786 --repo groundnuty/macf',
        stubGh: { 'repos/groundnuty/macf/issues/786/timeline': XREFS },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#789');
    });
  });

  describe('infrastructure failure → fail-open, silent', () => {
    it('a gh API error still allows the close (exit 0) and produces no output', () => {
      const r = runHook({
        command: 'gh issue close 500 --repo groundnuty/macf',
        stubGh: { 'repos/groundnuty/macf/issues/500/timeline': 'apierror' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('gh missing from PATH entirely still allows (no crash, no hang)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-close-ping-nogh-'));
      try {
        const r = runHook({
          command: 'gh issue close 786 --repo groundnuty/macf',
          env: { PATH: `${dir}:/usr/bin:/bin` },
        });
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('override', () => {
    it('MACF_SKIP_CLOSE_PING_CHECK=1 bypasses entirely — no output at all', () => {
      const r = runHook({
        command: 'gh issue close 786 --repo groundnuty/macf',
        stubGh: {
          'repos/groundnuty/macf/issues/786/timeline': {
            xrefs: [{ number: 789, repo: 'groundnuty/macf', state: 'open' }],
          },
        },
        env: { MACF_SKIP_CLOSE_PING_CHECK: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('never blocks', () => {
    it('exit code is always 0, even when candidates are found', () => {
      const r = runHook({
        command: 'gh issue close 786 --repo groundnuty/macf',
        stubGh: {
          'repos/groundnuty/macf/issues/786/timeline': {
            xrefs: [{ number: 789, repo: 'groundnuty/macf', state: 'open' }],
          },
        },
      });
      expect(r.status).toBe(0);
    });
  });
});
