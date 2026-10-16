/**
 * Tests for `scripts/tmux-send-to-claude.sh` (groundnuty/macf#1442).
 *
 * The script is run for real against a fake `tmux` first on PATH. The fake
 * keeps a state dir and models the behaviour measured on a Claude Code
 * 2.1.300 TUI:
 *   - `send-keys <text> Enter` in ONE call, long text → the text lands in
 *     the box with a trailing newline and never submits (paste burst).
 *   - `send-keys -l -- <text>` appends text to the box.
 *   - a lone `send-keys Enter` submits when the box holds -l text and no
 *     paste-newline: the box clears, the text goes to a transcript file.
 *   - `capture-pane -p` prints transcript tail, border, `❯ <box line 1>`,
 *     border.
 * Extra modes: swallow-first-Enter, never-submits, no-❯-line.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const NEW_SCRIPT = resolve(__dirname, '../../scripts/tmux-send-to-claude.sh');

// Frozen copy of the pre-fix script (98a3a341) — the "decisive pair" control.
const OLD_SCRIPT_BODY = `#!/usr/bin/env bash
set -euo pipefail
session="$1"
prompt="$2"
if [ -n "$session" ]; then
  tmux send-keys -t "$session" C-u
  tmux send-keys -t "$session" "$prompt" Enter
  sleep 1
  tmux send-keys -t "$session" Enter
else
  tmux send-keys C-u
  tmux send-keys "$prompt" Enter
  sleep 1
  tmux send-keys Enter
fi
`;

const FAKE_TMUX = `#!/usr/bin/env bash
D="$FAKE_TMUX_DIR"
printf '%s\\n' "$*" | tr '\\n' ' ' >> "$D/calls"; echo >> "$D/calls"
cmd="$1"; shift
if [ "\${1:-}" = "-t" ]; then shift 2; fi
mode="$(cat "$D/mode")"
box() { cat "$D/box" 2>/dev/null || true; }
case "$cmd" in
  send-keys)
    if [ "$1" = "C-u" ]; then : > "$D/box"; rm -f "$D/paste"; exit 0; fi
    if [ "$1" = "-l" ]; then
      shift; [ "$1" = "--" ] && shift
      printf '%s' "$1" >> "$D/box"; exit 0
    fi
    if [ "$1" = "Enter" ] && [ "$#" -eq 1 ]; then
      n=$(( $(cat "$D/enters" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/enters"
      [ "$mode" = never ] && exit 0
      [ "$mode" = swallow ] && [ "$n" -eq 1 ] && exit 0
      if [ -e "$D/paste" ]; then printf '\\n' >> "$D/box"; exit 0; fi
      if [ -s "$D/box" ]; then
        cat "$D/box" >> "$D/transcript"; printf '\\n---\\n' >> "$D/transcript"
        : > "$D/box"
      fi
      exit 0
    fi
    # Text + Enter in ONE call: a long burst is a paste, Enter -> newline.
    text="$1"
    if [ "\${#text}" -ge 200 ]; then
      printf '%s\\n' "$text" > "$D/box"; : > "$D/paste"
    else
      printf '%s' "$text" > "$D/box"
    fi
    ;;
  capture-pane)
    echo "some earlier transcript line"
    echo "────────────────────────"
    if [ "$mode" != noprompt ]; then
      first="$(box | head -n 1)"
      if [ -z "$first" ]; then echo '❯ Try "fix a bug"'; else echo "❯ $first"; fi
    fi
    echo "────────────────────────"
    ;;
esac
`;

let dir: string;
let binDir: string;

function setup(mode: string): void {
  dir = mkdtempSync(join(tmpdir(), 'send-claude-'));
  binDir = join(dir, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'tmux'), FAKE_TMUX);
  chmodSync(join(binDir, 'tmux'), 0o755);
  writeFileSync(join(dir, 'old.sh'), OLD_SCRIPT_BODY);
  writeFileSync(join(dir, 'mode'), mode);
  writeFileSync(join(dir, 'box'), '');
  writeFileSync(join(dir, 'calls'), '');
}

function run(script: string, session: string, prompt: string) {
  const r = spawnSync('bash', [script, session, prompt], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_TMUX_DIR: dir,
      MACF_SEND_SETTLE_INTERVAL: '0.02',
      MACF_SEND_VERIFY_WAIT: '0.05',
      MACF_SEND_BACKOFF: '0.05',
    },
  });
  return r;
}

const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
const enters = () => Number(read('enters').trim() || '0');
const LONG = 'Please review PR 123 and summarise every finding in detail. '.repeat(11).trim();

beforeEach(() => undefined);
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('tmux-send-to-claude.sh', () => {
  it('decisive pair: OLD script strands a 650-char prompt; NEW submits it', () => {
    expect(LONG.length).toBeGreaterThan(600);
    setup('normal');
    const old = run(join(dir, 'old.sh'), 'agent:0', LONG);
    expect(old.status).toBe(0); // exits 0 …
    expect(read('box')).toContain('Please review PR 123'); // … yet still in the box
    expect(read('transcript')).toBe('');
    rmSync(dir, { recursive: true, force: true });

    setup('normal');
    const fresh = run(NEW_SCRIPT, 'agent:0', LONG);
    expect(fresh.status).toBe(0);
    expect(read('transcript')).toContain(LONG);
    expect(read('box').trim()).toBe('');
    expect(enters()).toBe(1);
  });

  it('never sends Enter in the same send-keys call as the text', () => {
    setup('normal');
    run(NEW_SCRIPT, 'agent:0', 'hello there');
    const sends = read('calls').split('\n').filter((l) => l.startsWith('send-keys'));
    for (const l of sends) {
      if (l.includes('hello there')) expect(l).not.toMatch(/\bEnter\b/);
    }
    expect(sends.some((l) => l.includes('-l -- hello there'))).toBe(true);
  });

  it('multi-line prompt arrives intact', () => {
    setup('normal');
    const p = 'line one of the prompt\nline two\n  line three indented';
    const r = run(NEW_SCRIPT, 'agent:0', p);
    expect(r.status).toBe(0);
    expect(read('transcript')).toBe(`${p}\n---\n`);
  });

  it('swallowed first Enter → exactly one retry, exit 0', () => {
    setup('swallow');
    const r = run(NEW_SCRIPT, 'agent:0', LONG);
    expect(r.status).toBe(0);
    expect(enters()).toBe(2);
    expect(read('transcript')).toContain(LONG);
  });

  it('never submits → exit 4 after 3 Enters, stderr names target', () => {
    setup('never');
    const r = run(NEW_SCRIPT, 'agent:0', LONG);
    expect(r.status).toBe(4);
    expect(enters()).toBe(3);
    expect(r.stderr).toContain('agent:0');
  });

  it('no ❯ line → exit 3 and exactly one Enter', () => {
    setup('noprompt');
    const r = run(NEW_SCRIPT, 'agent:0', LONG);
    expect(r.status).toBe(3);
    expect(enters()).toBe(1);
    expect(r.stderr).toContain('could not verify');
  });

  it('empty session: no -t on any tmux call, including capture-pane', () => {
    setup('normal');
    const r = run(NEW_SCRIPT, '', LONG);
    expect(r.status).toBe(0);
    const calls = read('calls');
    expect(calls).toContain('capture-pane');
    expect(calls).not.toMatch(/(^|\s)-t(\s|$)/m);
  });

  it('usage error → exit 2', () => {
    setup('normal');
    const r = spawnSync('bash', [NEW_SCRIPT, 'only-one'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });
});
