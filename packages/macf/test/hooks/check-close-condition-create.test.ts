/**
 * Tests for `scripts/check-close-condition-create.sh` — the PreToolUse hook
 * that grades an issue's closing condition at the moment it is WRITTEN, the
 * create-time sibling of `check-close-condition.sh` (which does the same
 * job at CLOSE time). Path-2 promotion for groundnuty/macf#1248 (science's
 * `#1231` argument extended: `#1245` "the next E2E run is green" was met by
 * luck; `#1170` "a fresh session surfaces it unprompted" was unmet by luck
 * — both luck-satisfiable, same remedy: grade the condition when it is
 * written).
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 ALWAYS (this hook never
 * blocks). On a matching `gh issue create` whose body states a closing
 * condition, stdout carries the structured `hookSpecificOutput` PreToolUse
 * allow-contract with `additionalContext` set to the condition's own text
 * PLUS the three grading criteria; on a non-match OR a body with no stated
 * condition, stdout is EMPTY — true silence (unlike the close-time sibling,
 * which still emits a short "no condition found" note; a create-time note
 * repeated on every ordinary issue would be exactly the noise #1248 says to
 * avoid).
 *
 * Decisive pair (per assert-the-wrong-path.md — test 1 alone is satisfied by
 * printing the three criteria on EVERY create; it takes test 2 to prove the
 * hook only fires when THIS body actually states a condition, and test 1
 * asserts the condition's OWN TEXT is echoed, not merely that the criteria
 * appear):
 *   1. an issue body stating a closing condition → that condition's OWN
 *      TEXT is surfaced, alongside the three criteria.
 *   2. an issue body with NO stated condition → stdout is EMPTY. Nothing at
 *      all — not even a "no condition found" note.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-close-condition-create.sh');

function runHook(opts: { readonly command: string; readonly env?: Record<string, string | undefined> }): ReturnType<typeof spawnSync> {
  const payload = JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: { command: opts.command },
  });
  const basePath = process.env['PATH'] ?? '';
  const cleanEnv: Record<string, string> = { PATH: basePath };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }
  return spawnSync('bash', [HOOK_SCRIPT], { input: payload, env: cleanEnv, encoding: 'utf-8' });
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

const CONDITION_MARKER = 'the fixture referenced by this issue is repaired and a clean run confirms it';

const SECTION_BODY_CMD = [
  'gh issue create --repo groundnuty/macf --title "fix the fixture" --body "Some intro prose.',
  ``,
  `## Closure condition`,
  ``,
  `Closes when ${CONDITION_MARKER}.`,
  `"`,
].join('\n');

describe('check-close-condition-create.sh (hook)', () => {
  describe('pass-through — non-target commands (always exit 0, no output)', () => {
    it('allows `gh issue view`', () => {
      const r = runHook({ command: 'gh issue view 5' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows `gh issue edit` (not `create`)', () => {
      const r = runHook({ command: 'gh issue edit 5 --body "Closes when X is repaired."' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows `gh pr create` (not `issue create`)', () => {
      const r = runHook({ command: 'gh pr create --body "Closes when X is repaired."' });
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
    it('1. a stated closing condition is surfaced — the CONDITION\'S OWN TEXT is echoed, not boilerplate', () => {
      const r = runHook({ command: SECTION_BODY_CMD });
      expect(r.status).toBe(0);
      const ctx = parseAdditionalContext(r.stdout);
      expect(ctx).not.toBeNull();
      expect(ctx).toContain(CONDITION_MARKER);
      // The three criteria are also present (the hook's whole job).
      expect(ctx).toMatch(/observable/i);
      expect(ctx).toMatch(/satisfiable only by the repair/i);
      expect(ctx).toMatch(/falsifiable when unmet/i);
    });

    it('2. NO stated closing condition → stdout is completely EMPTY (true silence, not a "nothing found" note)', () => {
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title "bug" --body "Just a plain bug report with no stated closing condition anywhere in it."',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('a `gh issue create` with no --body at all → no crash, silent', () => {
      const r = runHook({ command: 'gh issue create --repo groundnuty/macf --title "bug, no body"' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  describe('the worked #1245 example — luck-satisfiable condition still gets the honest (non-adjudicated) treatment', () => {
    it('"the next E2E run is green" → condition echoed + all three criteria present (the hook does NOT single out which one it fails)', () => {
      const cmd = [
        'gh issue create --repo groundnuty/macf --title "flaky e2e"',
        '--body "Closes when the next E2E run is green."',
      ].join(' ');
      const r = runHook({ command: cmd });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('the next E2E run is green');
      expect(ctx).toMatch(/observable/i);
      expect(ctx).toMatch(/satisfiable only by the repair/i);
      expect(ctx).toMatch(/falsifiable when unmet/i);
      // It surfaces the criteria; it does not adjudicate.
      expect(ctx.toLowerCase()).toContain('it does not adjudicate');
    });
  });

  describe('extraction shapes', () => {
    it('falls back to a bare "closes when" line when there is no heading section', () => {
      const cmd = 'gh issue create --repo groundnuty/macf --title "t" --body "Intro text. This closes when the flag is removed from settings.json. More prose."';
      const r = runHook({ command: cmd });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('closes when the flag is removed from settings.json');
    });

    it('recognizes "Closing condition" as a heading synonym for "Closure condition" (real heading, own line — exercises the SECTION path, not the line-fallback)', () => {
      const cmd = [
        'gh issue create --repo groundnuty/macf --title "t" --body "## Closing condition',
        '',
        'closes when the fixture is repaired."',
      ].join('\n');
      const r = runHook({ command: cmd });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('closes when the fixture is repaired');
    });

    it('stops the section capture at the next heading (does not bleed into unrelated content)', () => {
      const cmd = [
        'gh issue create --repo groundnuty/macf --title "t" --body "## Closure condition',
        '',
        'closes when X happens.',
        '',
        '## Unrelated section',
        '',
        'this text must not be surfaced."',
      ].join('\n');
      const r = runHook({ command: cmd });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('closes when X happens');
      expect(ctx).not.toContain('this text must not be surfaced');
    });
  });

  describe('--body-file / -F extraction', () => {
    it('reads a stated condition from a --body-file path', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-close-cond-create-bf-'));
      const bodyPath = join(dir, 'body.md');
      writeFileSync(bodyPath, ['## Closure condition', '', `Closes when ${CONDITION_MARKER}.`].join('\n'));
      try {
        const r = runHook({ command: `gh issue create --repo groundnuty/macf --title "t" --body-file ${bodyPath}` });
        const ctx = parseAdditionalContext(r.stdout) ?? '';
        expect(ctx).toContain(CONDITION_MARKER);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads a stated condition from the `-F` short-flag alias', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-close-cond-create-f-'));
      const bodyPath = join(dir, 'body.md');
      writeFileSync(bodyPath, `Closes when ${CONDITION_MARKER}.`);
      try {
        const r = runHook({ command: `gh issue create --repo groundnuty/macf --title "t" -F ${bodyPath}` });
        const ctx = parseAdditionalContext(r.stdout) ?? '';
        expect(ctx).toContain(CONDITION_MARKER);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a missing/unreadable --body-file path → no crash, fail-open (silent when nothing else states a condition)', () => {
      const r = runHook({
        command: 'gh issue create --repo groundnuty/macf --title "t" --body-file /nonexistent/path/does-not-exist.md',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  describe('wrapper / subshell bypass coverage (mirrors check-close-condition.sh / check-close-keyword.sh)', () => {
    it('recognizes `sudo gh issue create ...`', () => {
      const r = runHook({ command: `sudo ${SECTION_BODY_CMD}` });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('recognizes `bash -c "gh issue create ..."` (SHELL_C path)', () => {
      const r = runHook({ command: `bash -c '${SECTION_BODY_CMD.replace(/'/g, `'\\''`)}'` });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('recognizes a subshell `(gh issue create ...)`', () => {
      const r = runHook({ command: `(${SECTION_BODY_CMD})` });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });

    it('recognizes `env GH_TOKEN=x gh issue create ...`', () => {
      const r = runHook({ command: `env GH_TOKEN=ghs_x ${SECTION_BODY_CMD}` });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });
  });

  describe('override', () => {
    it('MACF_SKIP_CONDITION_GRADE_CHECK=1 bypasses entirely — no output at all', () => {
      const r = runHook({ command: SECTION_BODY_CMD, env: { MACF_SKIP_CONDITION_GRADE_CHECK: '1' } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('does NOT respond to the close-time sibling\'s override (the two flags are deliberately distinct)', () => {
      const r = runHook({ command: SECTION_BODY_CMD, env: { MACF_SKIP_CLOSE_CONDITION_CHECK: '1' } });
      expect(r.status).toBe(0);
      // The wrong flag must not suppress this hook.
      expect(parseAdditionalContext(r.stdout) ?? '').toContain(CONDITION_MARKER);
    });
  });

  describe('never blocks', () => {
    it('exit code is always 0, even when a condition is found (never exit 2)', () => {
      const r = runHook({ command: SECTION_BODY_CMD });
      expect(r.status).toBe(0);
    });
  });

  describe('malformed input → fail-open', () => {
    it('non-JSON stdin does not crash the hook', () => {
      const r = spawnSync('bash', [HOOK_SCRIPT], { input: 'not json at all', env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf-8' });
      expect(r.status).toBe(0);
    });

    it('empty stdin does not crash the hook', () => {
      const r = spawnSync('bash', [HOOK_SCRIPT], { input: '', env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf-8' });
      expect(r.status).toBe(0);
    });
  });
});
