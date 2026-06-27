/**
 * Tests for `scripts/check-channels-enabled.sh` — the SessionStart guard that
 * reads the macf-agent MCP server's startup log back and warns LOUDLY into the
 * agent's context when channel notifications are OFF for the session.
 * groundnuty/macf#633 (the result-invariant backstop to macf#632).
 *
 * Hook contract (SessionStart): JSON on stdin; STDOUT is injected into the
 * agent's context (that is how the warning reaches the agent). OBSERVATIONAL +
 * NON-BLOCKING — the script ALWAYS exits 0 (fail open on a missing/unreadable
 * log, a poll timeout, or any internal error). Override: MACF_SKIP_CHANNELS_CHECK=1.
 *
 * The guard parses Claude Code's internal MCP-log layout under
 * ~/.cache/claude-cli-nodejs/<encoded-cwd>/mcp-logs-plugin-macf-agent-macf-agent/
 * <ts>.jsonl. These tests fake that layout under a temp HOME + temp workspace,
 * and pin the poll to 1 iteration (MACF_CHANNELS_POLL_ITERS=1) so the
 * inconclusive path doesn't burn the full ~12s.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'check-channels-enabled.sh');

const SKIP_DEBUG =
  'Channel notifications skipped: server plugin:macf-agent:macf-agent not in --channels list for this session';
const OK_DEBUG = 'Successfully connected (transport: stdio) in 2927ms';

/** Encode a path the way Claude Code names its cache dir: `/` and `.` → `-`. */
function encodeCwd(p: string): string {
  return p.replace(/[/.]/g, '-');
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runHook(opts: {
  /** Lines to write into the newest jsonl log (each becomes one JSONL object).
   *  `undefined` → don't create the log dir at all. */
  readonly logDebugLines?: readonly string[];
  /** Override env (e.g. MACF_SKIP_CHANNELS_CHECK). */
  readonly env?: Record<string, string | undefined>;
  /** Stdin payload (defaults to a SessionStart-shaped JSON object). */
  readonly stdin?: string;
}): RunResult {
  const fakeHome = mkdtempSync(join(tmpdir(), 'macf-chan-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'macf-chan-ws-'));

  if (opts.logDebugLines !== undefined) {
    const logDir = join(
      fakeHome,
      '.cache',
      'claude-cli-nodejs',
      encodeCwd(workspace),
      'mcp-logs-plugin-macf-agent-macf-agent',
    );
    mkdirSync(logDir, { recursive: true });
    const lines = opts.logDebugLines
      .map((d) => JSON.stringify({ debug: d, timestamp: '2026-06-27T15:58:10.141Z' }))
      .join('\n');
    writeFileSync(join(logDir, '2026-06-27T15-58-04-000Z.jsonl'), lines + '\n');
  }

  // Clean env: temp HOME + workspace, fast poll. Drop ambient MACF_* so the
  // runner's identity doesn't leak in.
  const cleanEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: fakeHome,
    CLAUDE_PROJECT_DIR: workspace,
    MACF_CHANNELS_POLL_ITERS: '1',
  };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }

  const res = spawnSync('bash', [HOOK_SCRIPT], {
    input: opts.stdin ?? JSON.stringify({ session_id: 'sess-x', source: 'startup' }),
    env: cleanEnv,
    encoding: 'utf-8',
  });

  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('check-channels-enabled.sh (SessionStart guard)', () => {
  describe('(a) channels OFF (skip marker present) → loud warning', () => {
    it('prints the DISABLED warning to stdout + exits 0', () => {
      const r = runHook({ logDebugLines: [OK_DEBUG, SKIP_DEBUG] });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ROUTED NOTIFICATIONS ARE DISABLED');
      expect(r.stdout).toContain('macf#632/#633');
      expect(r.stdout).toContain('Assert GitHub state directly');
    });
  });

  describe('(b) channels ON (connected, no skip) → silent', () => {
    it('prints nothing + exits 0', () => {
      const r = runHook({ logDebugLines: [OK_DEBUG] });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('(c) fail-open paths → silent exit 0', () => {
    it('no log dir at all → silent exit 0', () => {
      const r = runHook({}); // logDebugLines undefined → dir not created
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('log present but inconclusive (no marker) → silent exit 0 (poll times out)', () => {
      const r = runHook({ logDebugLines: ['some unrelated debug line'] });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('malformed / empty stdin → still exits 0 (never blocks the session)', () => {
      expect(runHook({ stdin: 'not json {{{', logDebugLines: [OK_DEBUG] }).status).toBe(0);
      expect(runHook({ stdin: '', logDebugLines: [OK_DEBUG] }).status).toBe(0);
    });
  });

  describe('(d) MACF_SKIP_CHANNELS_CHECK=1 → no-op even when OFF', () => {
    it('skips the check entirely (no warning) + exits 0', () => {
      const r = runHook({
        logDebugLines: [SKIP_DEBUG],
        env: { MACF_SKIP_CHANNELS_CHECK: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('(e) exit code is 0 in ALL cases', () => {
    const cases: { readonly name: string; readonly opts: Parameters<typeof runHook>[0] }[] = [
      { name: 'off', opts: { logDebugLines: [SKIP_DEBUG] } },
      { name: 'on', opts: { logDebugLines: [OK_DEBUG] } },
      { name: 'no log dir', opts: {} },
      { name: 'inconclusive', opts: { logDebugLines: ['noise'] } },
      { name: 'skip override', opts: { logDebugLines: [SKIP_DEBUG], env: { MACF_SKIP_CHANNELS_CHECK: '1' } } },
      { name: 'no CLAUDE_PROJECT_DIR', opts: { env: { CLAUDE_PROJECT_DIR: undefined } } },
    ];
    for (const c of cases) {
      it(`exits 0: ${c.name}`, () => {
        expect(runHook(c.opts).status).toBe(0);
      });
    }
  });
});
