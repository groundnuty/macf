/**
 * Tests for `plugin/scripts/mark-turn-state.sh` — the plugin-shipped turn-state
 * marker writer (groundnuty/macf#568, DR-030 fleet-doctor phase-1 increment A).
 *
 * The script maintains a single local marker file at
 * `${MACF_WORKSPACE_DIR}/.macf/turn-state.json` via read-modify-write, one
 * invocation per lifecycle event (argv[1]): `user-prompt-submit`, `pre-tool-use`,
 * `post-tool-use` (+ `post-tool-use-failure` alias), `stop`, `stop-failure`
 * (+ `session-end` alias). `turn_number` persists + increments across the
 * session. The channel server reads this marker for /health.state (increment B),
 * so the JSON shape below is THE CONTRACT.
 *
 * ROBUSTNESS: the hook NEVER blocks a turn — every path exits 0 (missing jq is
 * the only un-testable degrade-path here; malformed stdin, broken prior marker,
 * unknown/empty event arg all exit 0 cleanly). `.macf/` is created if absent.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'mark-turn-state.sh');

/** The marker contract (increment B reads exactly these fields). */
interface TurnState {
  readonly turn_number: number;
  readonly status: 'busy' | 'idle';
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly phase: 'thinking' | 'tool' | null;
  readonly current_tool: string | null;
  readonly current_command: string | null;
  readonly tool_started_at: number | null;
  readonly last_turn_duration_ms: number | null;
  readonly tool_use_count: number | null;
  readonly output_tokens: number | null;
}

/** A self-contained agent workspace (its own `.macf/turn-state.json`). */
class Workspace {
  readonly dir: string;
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'macf-turn-state-'));
  }
  /** Fire one event with a stdin payload; returns the script exit status. */
  fire(event: string, payload: Record<string, unknown> | string = {}): number | null {
    const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const res = spawnSync('bash', [HOOK_SCRIPT, event], {
      input,
      encoding: 'utf-8',
      // Clean env so the runner's ambient MACF_* can't leak in; point the hook
      // at this workspace's temp dir.
      env: { PATH: process.env['PATH'] ?? '', MACF_WORKSPACE_DIR: this.dir },
    });
    return res.status;
  }
  get markerPath(): string {
    return join(this.dir, '.macf', 'turn-state.json');
  }
  /** Parsed marker (throws if absent — call only after an event wrote it). */
  read(): TurnState {
    return JSON.parse(readFileSync(this.markerPath, 'utf-8')) as TurnState;
  }
  markerExists(): boolean {
    return existsSync(this.markerPath);
  }
}

describe('mark-turn-state.sh (turn-state marker writer)', () => {
  describe('(a) UserPromptSubmit begins a turn', () => {
    it('creates .macf/, sets turn_number=1, status=busy, phase=thinking, started_at', () => {
      const ws = new Workspace();
      expect(ws.fire('user-prompt-submit')).toBe(0);
      const s = ws.read();
      expect(s.turn_number).toBe(1);
      expect(s.status).toBe('busy');
      expect(s.phase).toBe('thinking');
      expect(typeof s.started_at).toBe('number');
      expect(s.ended_at).toBeNull();
      expect(s.current_tool).toBeNull();
      expect(s.current_command).toBeNull();
      expect(s.tool_started_at).toBeNull();
    });

    it('increments turn_number across the session (preserves prior value)', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      expect(ws.read().turn_number).toBe(1);
      ws.fire('user-prompt-submit');
      expect(ws.read().turn_number).toBe(2);
      ws.fire('user-prompt-submit');
      expect(ws.read().turn_number).toBe(3);
    });
  });

  describe('(b) PreToolUse records the tool', () => {
    it('Bash → phase=tool, current_tool=Bash, current_command set, tool_started_at', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      expect(
        ws.fire('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'make build' } }),
      ).toBe(0);
      const s = ws.read();
      expect(s.phase).toBe('tool');
      expect(s.current_tool).toBe('Bash');
      expect(s.current_command).toBe('make build');
      expect(typeof s.tool_started_at).toBe('number');
      // Turn metadata preserved.
      expect(s.turn_number).toBe(1);
      expect(s.status).toBe('busy');
    });

    it('non-Bash tool → current_command is null (only Bash carries a command)', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      ws.fire('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: '/x' } });
      const s = ws.read();
      expect(s.phase).toBe('tool');
      expect(s.current_tool).toBe('Read');
      expect(s.current_command).toBeNull();
    });

    it('truncates current_command to <=120 chars', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      const longCmd = 'x'.repeat(500);
      ws.fire('pre-tool-use', { tool_name: 'Bash', tool_input: { command: longCmd } });
      const s = ws.read();
      expect(s.current_command).not.toBeNull();
      expect(s.current_command!.length).toBe(120);
      expect(s.current_command).toBe('x'.repeat(120));
    });
  });

  describe('(c) PostToolUse / PostToolUseFailure clear the tool', () => {
    it('post-tool-use → phase=thinking, tool fields cleared', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      ws.fire('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'make build' } });
      expect(ws.fire('post-tool-use')).toBe(0);
      const s = ws.read();
      expect(s.phase).toBe('thinking');
      expect(s.current_tool).toBeNull();
      expect(s.current_command).toBeNull();
      expect(s.tool_started_at).toBeNull();
      expect(s.status).toBe('busy'); // still mid-turn
    });

    it('post-tool-use-failure is an alias → same clearing behavior', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      ws.fire('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'false' } });
      expect(ws.fire('post-tool-use-failure')).toBe(0);
      const s = ws.read();
      expect(s.phase).toBe('thinking');
      expect(s.current_tool).toBeNull();
      expect(s.current_command).toBeNull();
      expect(s.tool_started_at).toBeNull();
    });
  });

  describe('(d) Stop ends the turn + records last-turn stats', () => {
    it('status=idle, ended_at, last_turn_duration_ms, tool_use_count, output_tokens', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      expect(ws.fire('stop', { tool_use_count: 12, output_tokens: 2048 })).toBe(0);
      const s = ws.read();
      expect(s.status).toBe('idle');
      expect(typeof s.ended_at).toBe('number');
      expect(typeof s.last_turn_duration_ms).toBe('number');
      expect(s.last_turn_duration_ms!).toBeGreaterThanOrEqual(0);
      expect(s.tool_use_count).toBe(12);
      expect(s.output_tokens).toBe(2048);
      expect(s.phase).toBeNull();
      expect(s.current_tool).toBeNull();
    });

    it('last_turn_duration_ms == ended_at - started_at', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      const started = ws.read().started_at!;
      ws.fire('stop', { tool_use_count: 0, output_tokens: 1 });
      const s = ws.read();
      expect(s.last_turn_duration_ms).toBe(s.ended_at! - started);
    });

    it('missing Stop payload fields → tool_use_count/output_tokens null (no crash)', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      expect(ws.fire('stop')).toBe(0);
      const s = ws.read();
      expect(s.status).toBe('idle');
      expect(s.tool_use_count).toBeNull();
      expect(s.output_tokens).toBeNull();
    });
  });

  describe('(e) StopFailure / SessionEnd clear busy, leave the rest as-is', () => {
    it('stop-failure → status=idle, ended_at, phase/current_tool null; turn_number kept', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      ws.fire('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'sleep 99' } });
      expect(ws.fire('stop-failure')).toBe(0);
      const s = ws.read();
      expect(s.status).toBe('idle');
      expect(typeof s.ended_at).toBe('number');
      expect(s.phase).toBeNull();
      expect(s.current_tool).toBeNull();
      expect(s.turn_number).toBe(1);
    });

    it('session-end is an alias of stop-failure', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      expect(ws.fire('session-end')).toBe(0);
      const s = ws.read();
      expect(s.status).toBe('idle');
      expect(typeof s.ended_at).toBe('number');
      expect(s.phase).toBeNull();
    });
  });

  describe('(f) full turn lifecycle: idle → busy → tool → thinking → idle', () => {
    it('drives the documented state machine and persists cross-turn stats', () => {
      const ws = new Workspace();

      ws.fire('user-prompt-submit');
      expect(ws.read()).toMatchObject({ turn_number: 1, status: 'busy', phase: 'thinking' });

      ws.fire('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'echo hi' } });
      expect(ws.read()).toMatchObject({ phase: 'tool', current_tool: 'Bash', current_command: 'echo hi' });

      ws.fire('post-tool-use');
      expect(ws.read()).toMatchObject({ phase: 'thinking', current_tool: null });

      ws.fire('stop', { tool_use_count: 3, output_tokens: 99 });
      const ended = ws.read();
      expect(ended).toMatchObject({ status: 'idle', tool_use_count: 3, output_tokens: 99 });

      // Next turn: turn_number increments; PREVIOUS turn's stats persist into the
      // busy state (the contract's "of the PREVIOUS turn" semantics).
      ws.fire('user-prompt-submit');
      const next = ws.read();
      expect(next.turn_number).toBe(2);
      expect(next.status).toBe('busy');
      expect(next.last_turn_duration_ms).toBe(ended.last_turn_duration_ms);
      expect(next.tool_use_count).toBe(3);
      expect(next.output_tokens).toBe(99);
    });
  });

  describe('(g) robustness — never blocks a turn; recovers from bad state', () => {
    it('malformed stdin → exit 0 + valid marker written', () => {
      const ws = new Workspace();
      expect(ws.fire('user-prompt-submit', 'not json {{{')).toBe(0);
      const s = ws.read();
      expect(s.turn_number).toBe(1);
      expect(s.status).toBe('busy');
    });

    it('a broken prior marker is treated as empty (recovers, no crash)', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit'); // creates .macf/
      // Corrupt the marker, then fire another event.
      writeFileSync(ws.markerPath, 'BROKEN {{{ not json');
      expect(ws.fire('user-prompt-submit')).toBe(0);
      const s = ws.read();
      // Recovered from base → turn_number restarts at 1 (prior value unreadable).
      expect(s.turn_number).toBe(1);
      expect(s.status).toBe('busy');
    });

    it('unknown event arg → exit 0, no marker written', () => {
      const ws = new Workspace();
      expect(ws.fire('bogus-event')).toBe(0);
      expect(ws.markerExists()).toBe(false);
    });

    it('missing event arg → exit 0, no marker written', () => {
      const ws = new Workspace();
      const res = spawnSync('bash', [HOOK_SCRIPT], {
        input: '{}',
        encoding: 'utf-8',
        env: { PATH: process.env['PATH'] ?? '', MACF_WORKSPACE_DIR: ws.dir },
      });
      expect(res.status).toBe(0);
      expect(ws.markerExists()).toBe(false);
    });

    it('MACF_SKIP_TURN_STATE=1 → no-op, no marker written', () => {
      const ws = new Workspace();
      const res = spawnSync('bash', [HOOK_SCRIPT, 'user-prompt-submit'], {
        input: '{}',
        encoding: 'utf-8',
        env: {
          PATH: process.env['PATH'] ?? '',
          MACF_WORKSPACE_DIR: ws.dir,
          MACF_SKIP_TURN_STATE: '1',
        },
      });
      expect(res.status).toBe(0);
      expect(ws.markerExists()).toBe(false);
    });

    it('the write is atomic — no leftover temp files in .macf/', () => {
      const ws = new Workspace();
      ws.fire('user-prompt-submit');
      ws.fire('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'x' } });
      ws.fire('stop', { tool_use_count: 1, output_tokens: 1 });
      const entries = readdirSync(join(ws.dir, '.macf'));
      expect(entries).toEqual(['turn-state.json']);
    });

    it('every event always exits 0', () => {
      const ws = new Workspace();
      for (const ev of [
        'user-prompt-submit',
        'pre-tool-use',
        'post-tool-use',
        'post-tool-use-failure',
        'stop',
        'stop-failure',
        'session-end',
      ]) {
        expect(ws.fire(ev)).toBe(0);
      }
    });
  });
});
