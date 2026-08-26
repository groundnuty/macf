/**
 * Tests for `scripts/check-close-condition.sh` — the PreToolUse hook that
 * surfaces an issue's OWN STATED closing condition back to the closer at
 * the moment of `gh issue close`. Path-2 promotion for groundnuty/macf#1231
 * (motivated by `#1221`'s two premature closes on the same issue, despite
 * its body stating an observable closing condition throughout).
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 ALWAYS (this hook never
 * blocks — see the script's own header for the warn-only-vs-block-once
 * justification). On a matching `gh issue close`, stdout carries the
 * structured `hookSpecificOutput` PreToolUse allow-contract with
 * `additionalContext` set; on a non-match, stdout is empty.
 *
 * Decisive pair (per assert-the-wrong-path.md — test 1 alone is satisfied by
 * printing something on every close; it takes test 2 to prove the hook is
 * actually reading THIS issue's body rather than emitting boilerplate):
 *   1. an issue whose body states a closing condition → that condition's
 *      OWN TEXT is surfaced.
 *   2. an issue with NO stated condition → the condition's text does NOT
 *      appear (a distinct "no condition found" note may appear instead).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-close-condition.sh');

/** Per-issue stub: the issue's body, or a sentinel for a fetch failure. */
type IssueStub = { readonly body: string } | 'notfound' | 'apierror';
type StubMap = Record<string, IssueStub>;

/**
 * Build a directory with a stub `gh` shim that answers
 * `gh issue view <N> [--repo O/R] --json body` from the supplied map, keyed
 * by `owner/repo#N` (defaulting to `defaultRepo` when no --repo is passed).
 */
function makeStubGhDir(stubs: StubMap, defaultRepo: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-close-cond-stub-gh-'));
  const arms = Object.entries(stubs)
    .map(([key, stub]) => {
      if (stub === 'notfound') {
        return `    '${key}') echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;`;
      }
      if (stub === 'apierror') {
        return `    '${key}') echo "gh: HTTP 503 Service Unavailable" >&2; exit 1 ;;`;
      }
      const body = JSON.stringify({ body: stub.body });
      return `    '${key}') echo '${body}'; exit 0 ;;`;
    })
    .join('\n');

  const stubScript = `#!/usr/bin/env bash
# Stub gh — handles \`gh issue view <N> [--repo O/R] --json body\`.
if [[ "$1" == "issue" && "$2" == "view" ]]; then
  num="$3"
  repo="${defaultRepo}"
  shift 3
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) repo="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
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

const SECTION_BODY = [
  'Some intro prose describing the change.',
  '',
  '## Closure condition, stated as an observable per #878',
  '',
  '**Closes when running `gh issue close` puts the condition on screen before the close executes** — verified by doing it.',
  '',
].join('\n');

const CONDITION_MARKER = 'puts the condition on screen before the close executes';

const PLAIN_BODY = 'Just a plain bug report with no stated closing condition anywhere in it.';

describe('check-close-condition.sh (hook)', () => {
  describe('pass-through — non-target commands (always exit 0, no output)', () => {
    it('allows `gh issue view` (not close)', () => {
      const r = runHook({ command: 'gh issue view 5' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows `gh pr close` (not `issue close`)', () => {
      const r = runHook({ command: 'gh pr close 5' });
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
    it('1. a stated closing condition IS surfaced', () => {
      const r = runHook({
        command: 'gh issue close 1231 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(r.status).toBe(0);
      const ctx = parseAdditionalContext(r.stdout);
      expect(ctx).not.toBeNull();
      expect(ctx).toContain(CONDITION_MARKER);
    });

    it('2. NO stated closing condition → the condition text is absent (a distinct note may appear, close proceeds)', () => {
      const r = runHook({
        command: 'gh issue close 42 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#42': { body: PLAIN_BODY } },
      });
      expect(r.status).toBe(0);
      const ctx = parseAdditionalContext(r.stdout);
      // No condition content leaked into the context.
      expect(ctx ?? '').not.toContain(CONDITION_MARKER);
      // If a note is present, it announces absence rather than presence.
      if (ctx) {
        expect(ctx.toLowerCase()).toMatch(/no stated closing condition/);
      }
    });
  });

  describe('extraction shapes', () => {
    it('falls back to a bare "closes when" line when there is no heading section', () => {
      const body = [
        'Intro text.',
        '',
        'This **closes when a fleet whose control repo lacks an agent label cannot report success**.',
        '',
        'More prose.',
      ].join('\n');
      const r = runHook({
        command: 'gh issue close 7 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#7': { body } },
      });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('closes when a fleet whose control repo lacks an agent label cannot report success');
    });

    it('recognizes "Closing condition" as a heading synonym for "Closure condition"', () => {
      const body = ['## Closing condition', '', 'closes when the fixture is repaired.'].join('\n');
      const r = runHook({
        command: 'gh issue close 8 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#8': { body } },
      });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('closes when the fixture is repaired');
    });

    it('stops the section capture at the next heading (does not bleed into unrelated content)', () => {
      const body = [
        '## Closure condition',
        '',
        'closes when X happens.',
        '',
        '## Unrelated section',
        '',
        'this text must not be surfaced',
      ].join('\n');
      const r = runHook({
        command: 'gh issue close 9 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#9': { body } },
      });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('closes when X happens');
      expect(ctx).not.toContain('this text must not be surfaced');
    });
  });

  describe('issue-number + --repo extraction forms', () => {
    it('extracts a bare integer positional', () => {
      const r = runHook({
        command: 'gh issue close 1231 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('extracts the issue number from a URL positional', () => {
      const r = runHook({
        command: 'gh issue close https://github.com/groundnuty/macf/issues/1231 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('extracts the issue number from `owner/repo#N` shorthand (repo resolved from the ref itself)', () => {
      const r = runHook({
        command: 'gh issue close groundnuty/macf#1231',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
        defaultRepo: 'groundnuty/macf',
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('accepts `--repo=owner/repo` glued form', () => {
      const r = runHook({
        command: 'gh issue close 1231 --repo=groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('accepts `-R owner/repo` short-flag form', () => {
      const r = runHook({
        command: 'gh issue close 1231 -R groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('skips value-taking flags (--comment, --reason) before finding the issue number', () => {
      const r = runHook({
        command: 'gh issue close --comment "done" --reason completed 1231 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('allows (no crash) when no issue number can be extracted', () => {
      const r = runHook({ command: 'gh issue close --repo groundnuty/macf' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('wrapper / subshell bypass coverage (mirrors check-close-keyword.sh)', () => {
    it('recognizes `sudo gh issue close ...`', () => {
      const r = runHook({
        command: 'sudo gh issue close 1231 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('recognizes `bash -c "gh issue close ..."` (SHELL_C path)', () => {
      const r = runHook({
        command: `bash -c 'gh issue close 1231 --repo groundnuty/macf'`,
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('recognizes a subshell `(gh issue close ...)`', () => {
      const r = runHook({
        command: '(gh issue close 1231 --repo groundnuty/macf)',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('recognizes `env GH_TOKEN=x gh issue close ...`', () => {
      const r = runHook({
        command: 'env GH_TOKEN=ghs_x gh issue close 1231 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });
  });

  describe('infrastructure failure → fail-open', () => {
    it('a 404 on the body fetch still allows, with a "could not fetch" note (not a crash)', () => {
      const r = runHook({
        command: 'gh issue close 999 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#999': 'notfound' },
      });
      expect(r.status).toBe(0);
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx.toLowerCase()).toMatch(/could not fetch/);
    });

    it('a non-404 API error still allows, with a "could not fetch" note', () => {
      const r = runHook({
        command: 'gh issue close 5 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#5': 'apierror' },
      });
      expect(r.status).toBe(0);
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx.toLowerCase()).toMatch(/could not fetch/);
    });

    it('gh missing from PATH entirely still allows (no crash, no hang)', () => {
      // A PATH with only the tools the hook's degraded path needs, minus gh.
      const dir = mkdtempSync(join(tmpdir(), 'macf-close-cond-nogh-'));
      try {
        const r = runHook({
          command: 'gh issue close 1231 --repo groundnuty/macf',
          env: { PATH: `${dir}:/usr/bin:/bin` },
        });
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('override', () => {
    it('MACF_SKIP_CLOSE_CONDITION_CHECK=1 bypasses entirely — no output at all', () => {
      const r = runHook({
        command: 'gh issue close 1231 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
        env: { MACF_SKIP_CLOSE_CONDITION_CHECK: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('never blocks', () => {
    it('exit code is always 0, even when a condition is found (never exit 2)', () => {
      const r = runHook({
        command: 'gh issue close 1231 --repo groundnuty/macf',
        stubGh: { 'groundnuty/macf#1231': { body: SECTION_BODY } },
      });
      expect(r.status).toBe(0);
    });
  });
});
