/**
 * Tests for `scripts/check-close-reference.sh` — the PreToolUse hook
 * (groundnuty/macf#1394) that warns, at the moment a `gh issue comment` /
 * `gh pr comment` body is about to post, when it references another issue
 * ONLY inside backticks. GitHub does not create a `cross-referenced`
 * timeline event for a reference inside a code span or fenced code block,
 * so check-close-and-ping.sh (#1385) — which enumerates INBOUND
 * `cross-referenced` events to find still-open waiters — can never see it.
 * Measured against #1393: a backticked reference produced 0 inbound
 * cross-refs; the bare form produced 1, within 25s.
 *
 * Hook contract (PreToolUse): JSON on stdin, exit 0 ALWAYS (this hook
 * never blocks). On a matching `gh issue comment` / `gh pr comment` whose
 * body contains a `#N` / `owner/repo#N` reference sitting inside a
 * backtick span or fenced code block, stdout carries the structured
 * `hookSpecificOutput` PreToolUse allow-contract with `additionalContext`
 * naming the reference(s); on a non-match OR a body with no such
 * reference, stdout is EMPTY — true silence.
 *
 * Decisive TRIPLE (per assert-the-wrong-path.md — a pair alone would not
 * prove the hook discriminates the backticked ref from a co-occurring bare
 * one in the SAME body; test 3 is the discriminating assertion):
 *   1. a body with ONLY a backticked `#N` → warned, naming it.
 *   2. the identical reference written bare (no backticks) → stdout EMPTY.
 *   3. a body with BOTH a backticked ref and a separate bare ref → warned,
 *      but the warning names ONLY the backticked one (asserts the bare
 *      ref's number does NOT appear in the warning text).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-close-reference.sh');

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

describe('check-close-reference.sh (hook)', () => {
  describe('pass-through — non-target commands (always exit 0, no output)', () => {
    it('allows `gh issue view`', () => {
      const r = runHook({ command: 'gh issue view 5' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows `gh pr view`', () => {
      const r = runHook({ command: 'gh pr view 5' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows `gh issue create` (out of scope by design — see file header)', () => {
      const r = runHook({ command: 'gh issue create --title t --body "blocked on `#1393`."' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows `gh pr create` (out of scope, same as `gh issue create`)', () => {
      const r = runHook({ command: 'gh pr create --title t --body "blocked on `#1393`."' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows `gh issue close --comment` (not `comment` subcommand)', () => {
      const r = runHook({ command: 'gh issue close 5 --comment "blocked on `#1393`. verified"' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('allows non-gh commands', () => {
      const r = runHook({ command: 'make -f dev.mk check' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('decisive triple (assert-the-wrong-path.md)', () => {
    it('1. a body with ONLY a backticked #N reference → warned, naming it', () => {
      const r = runHook({ command: 'gh issue comment 42 --body "This blocks on `#1393`."' });
      expect(r.status).toBe(0);
      const ctx = parseAdditionalContext(r.stdout);
      expect(ctx).not.toBeNull();
      expect(ctx).toContain('#1393');
      expect(ctx).toMatch(/does not create a cross-reference event/i);
      expect(ctx).toMatch(/bare form/i);
    });

    it('2. the identical reference written BARE → stdout completely EMPTY', () => {
      const r = runHook({ command: 'gh issue comment 42 --body "This blocks on #1393."' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('3. MIXED body (one backticked + one bare) → warned ONLY for the backticked one', () => {
      const r = runHook({ command: 'gh issue comment 42 --body "See `#1393` and also #1400 for context."' });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('#1393');
      // The discriminating assertion: the bare reference must NOT appear
      // anywhere in the warning — an implementation that dumps every ref
      // it finds (rather than only the backticked ones) would fail this.
      expect(ctx).not.toContain('#1400');
    });
  });

  describe('what counts as backticked', () => {
    it('a cross-repo backticked reference (`owner/repo#N`) is warned, naming the full form', () => {
      const r = runHook({ command: 'gh issue comment 42 --body "Blocked on `groundnuty/macf#1393`."' });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('groundnuty/macf#1393');
    });

    it('a bare cross-repo reference (no backticks) → silent', () => {
      const r = runHook({ command: 'gh issue comment 42 --body "Blocked on groundnuty/macf#1393."' });
      expect(r.stdout).toBe('');
    });

    it('a #N inside a fenced code block (quoting a command) is STILL warned — #1394\'s own resolution', () => {
      const body = [
        "Here's the command that reproduced it:",
        '',
        '```',
        '$ gh issue view groundnuty/macf#1393',
        '```',
      ].join('\n');
      const r = runHook({ command: `gh issue comment 55 --body "${body}"` });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('groundnuty/macf#1393');
    });

    it('multiple distinct backticked refs in one body are all named, deduped', () => {
      const r = runHook({ command: 'gh issue comment 42 --body "Blocked on `#10` and also `#10` and `#20`."' });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('#10');
      expect(ctx).toContain('#20');
      // Deduped: `#10` should appear once in the reference list, not twice.
      const occurrences = (ctx.match(/`#10`/g) ?? []).length;
      expect(occurrences).toBe(1);
    });
  });

  describe('direction hint', () => {
    it('states the direction fact using the actual self-number and the referenced number', () => {
      const r = runHook({ command: 'gh issue comment 42 --body "This blocks on `#1393`."' });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toMatch(/#42/);
      expect(ctx).toMatch(/lands on the issue MENTIONED/i);
    });

    it('is omitted (no guess) when the self-number cannot be confidently extracted', () => {
      // No positional number after `comment` before the body flag — e.g. a
      // URL/branch form this hook's best-effort extractor does not resolve.
      const r = runHook({ command: 'gh pr comment my-feature-branch --body "This blocks on `#1393`."' });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toContain('#1393');
      expect(ctx).not.toMatch(/lands on the issue MENTIONED/i);
    });
  });

  describe('--body-file / -F / literal-heredoc extraction (the primary path, not an edge case — see file header)', () => {
    it('reads a backticked reference from a readable --body-file path', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-close-ref-bf-'));
      const bodyPath = join(dir, 'body.md');
      writeFileSync(bodyPath, 'Blocked on `#77`.');
      try {
        const r = runHook({ command: `gh issue comment 10 --body-file ${bodyPath}` });
        const ctx = parseAdditionalContext(r.stdout) ?? '';
        expect(ctx).toContain('#77');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads a backticked reference from the `-F` short-flag alias', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-close-ref-f-'));
      const bodyPath = join(dir, 'body.md');
      writeFileSync(bodyPath, 'Blocked on `#99`.');
      try {
        const r = runHook({ command: `gh pr comment 30 -F ${bodyPath}` });
        const ctx = parseAdditionalContext(r.stdout) ?? '';
        expect(ctx).toContain('#99');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a bare reference read from --body-file → silent (extraction correctly finds no backticks)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-close-ref-bare-bf-'));
      const bodyPath = join(dir, 'body.md');
      writeFileSync(bodyPath, 'Blocked on #77.');
      try {
        const r = runHook({ command: `gh issue comment 10 --body-file ${bodyPath}` });
        expect(r.stdout).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a literal (quoted-delimiter) heredoc targeting the --body-file path is resolved even though the file does not exist yet (write-and-post single-call pattern)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'macf-close-ref-heredoc-'));
      const bodyPath = join(dir, 'f.txt');
      const cmd = [`cat > ${bodyPath} <<'EOF'`, 'Blocked on `#88`.', 'EOF', `gh issue comment 20 --body-file ${bodyPath}`].join('\n');
      try {
        const r = runHook({ command: cmd });
        const ctx = parseAdditionalContext(r.stdout) ?? '';
        expect(ctx).toContain('#88');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a missing/unreadable --body-file path with no resolvable heredoc → SILENT (not a warning — this hook cannot name a reference it never saw)', () => {
      const r = runHook({ command: 'gh issue comment 10 --body-file /nonexistent/path/does-not-exist.md' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  describe('wrapper / subshell bypass coverage (mirrors check-close-condition.sh / check-close-keyword.sh)', () => {
    const CMD = 'gh issue comment 42 --body "blocked on `#1393`."';

    it('recognizes `sudo gh issue comment ...`', () => {
      const r = runHook({ command: `sudo ${CMD}` });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#1393');
    });

    it('recognizes `bash -c "gh issue comment ..."` (SHELL_C path)', () => {
      const r = runHook({ command: `bash -c '${CMD.replace(/'/g, `'\\''`)}'` });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#1393');
    });

    it('recognizes a subshell `(gh issue comment ...)`', () => {
      const r = runHook({ command: `(${CMD})` });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#1393');
    });

    it('recognizes `env GH_TOKEN=x gh issue comment ...`', () => {
      const r = runHook({ command: `env GH_TOKEN=ghs_x ${CMD}` });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#1393');
    });

    it('recognizes `gh pr comment` (not just `gh issue comment`)', () => {
      const r = runHook({ command: 'gh pr comment 42 --body "blocked on `#1393`."' });
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#1393');
    });
  });

  describe('override', () => {
    it('MACF_SKIP_CLOSE_REFERENCE_CHECK=1 bypasses entirely — no output at all', () => {
      const r = runHook({
        command: 'gh issue comment 42 --body "blocked on `#1393`."',
        env: { MACF_SKIP_CLOSE_REFERENCE_CHECK: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it("does NOT respond to a sibling hook's own override (the flags are deliberately distinct)", () => {
      const r = runHook({
        command: 'gh issue comment 42 --body "blocked on `#1393`."',
        env: { MACF_SKIP_CLOSE_CONDITION_CHECK: '1' },
      });
      expect(r.status).toBe(0);
      expect(parseAdditionalContext(r.stdout) ?? '').toContain('#1393');
    });
  });

  describe('user-facing text carries no issue-number citations (per #1394\'s own requirement)', () => {
    it('the warning cites mention-routing-hygiene.md, never a `groundnuty/macf#N` framework-issue reference', () => {
      const r = runHook({ command: 'gh issue comment 42 --body "blocked on `#1393`."' });
      const ctx = parseAdditionalContext(r.stdout) ?? '';
      expect(ctx).toMatch(/mention-routing-hygiene\.md/);
      expect(ctx).not.toMatch(/groundnuty\/macf#\d+/);
    });
  });

  describe('never blocks', () => {
    it('exit code is always 0, even when a backticked reference is found (never exit 2)', () => {
      const r = runHook({ command: 'gh issue comment 42 --body "blocked on `#1393`."' });
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

    it('no --body at all → no crash, silent', () => {
      const r = runHook({ command: 'gh issue comment 42 --edit-last' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
  });
});
