/**
 * Tests for `scripts/macf-prompt-watcher.sh` — the DR-033 runtime
 * auto-responder watcher (groundnuty/macf#645/#684), specifically the
 * self-alert feedback-loop fix (groundnuty/macf#712).
 *
 * Bug: the watcher's own ALERT output (written to stderr, which in the
 * canonical claude.sh wiring shares the SAME tmux pane the watcher is
 * capturing) gets picked up by the watcher's OWN next `capture-pane` poll.
 * An unknown-prompt ALERT embeds an excerpt of the offending frame — which
 * for a `❯`-menu prompt contains the `❯` glyph — so the alert line itself
 * "looks prompt-like" on the next poll, causing an infinite self-alert loop
 * that floods the pane and defeats the existing per-frame dedup (each new
 * alert changes the frame content, so the dedup hash never repeats).
 *
 * The fix: `_capture` strips every line containing the watcher's own
 * `[macf-prompt-watcher]` marker before the frame is used for ANY
 * matching/detection. This test harness emulates the real-world "stderr
 * shares the watched pane" wiring by having a stub `tmux` binary maintain a
 * virtual pane file that the watcher's own stderr is appended to (mirroring
 * a real tmux pane's scrollback), so the self-alert loop would reproduce
 * end-to-end here absent the fix.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const WATCHER_SCRIPT = join(findCliPackageRoot(), 'scripts', 'macf-prompt-watcher.sh');

/**
 * Build a stub `tmux` on PATH backed by a "virtual pane" file at
 * `$STUB_PANE_FILE`. `capture-pane -p` prints its current contents;
 * `send-keys` appends a record of what was sent (so tests can assert on
 * auto-answer behavior too, though the self-alert tests below don't need
 * an allowlist match).
 *
 * Crucially: the watcher process's OWN stderr is redirected by the test
 * harness to APPEND to the same virtual pane file — this is what
 * reproduces the real "stderr shares the watched pane" hazard structurally,
 * without needing a real tmux server.
 */
function makeStubTmuxDir(paneFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-tmux-'));
  const shim = `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
case "$cmd" in
  capture-pane)
    cat "${paneFile}" 2>/dev/null || true
    ;;
  send-keys)
    echo "SEND: $*" >> "${paneFile}.sends"
    ;;
  *)
    exit 0
    ;;
esac
`;
  writeFileSync(join(dir, 'tmux'), shim);
  chmodSync(join(dir, 'tmux'), 0o755);
  return dir;
}

/** Minimal valid prompt-responses config with exactly one accepted entry —
 * required for the watcher to reach the poll loop at all (zero accepted
 * entries short-circuits before polling). The entry never matches the
 * "unknown prompt" frames used below.
 */
const MINIMAL_CONFIG = JSON.stringify({
  schema_version: '1',
  entries: [
    {
      name: 'dev-channels',
      frame_contains: ['I am using this for local development'],
      option_text: 'I am using this for local development',
      send: '1',
      max_fires: 1,
    },
  ],
});

interface RunResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly paneContents: string;
}

/**
 * Run the watcher against a virtual pane seeded with `initialFrame`, for a
 * short bounded window (WINDOW/INTERVAL tunables), with the watcher's own
 * stderr appended into the SAME virtual pane file (emulating the canonical
 * claude.sh same-pane wiring).
 */
function runWatcher(opts: {
  readonly initialFrame: string;
  readonly windowSecs: number;
  readonly intervalSecs: number;
}): RunResult {
  const stateDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-state-'));
  const workDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-work-'));
  const paneFile = join(workDir, 'pane.txt');
  writeFileSync(paneFile, opts.initialFrame);
  const tmuxDir = makeStubTmuxDir(paneFile);
  const configDir = join(workDir, '.macf');
  const configPath = join(configDir, 'prompt-responses.json');
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, MINIMAL_CONFIG);

    // The watcher appends its own stderr into the SAME pane file the stub
    // tmux reads from — this is the mechanism under test: does the watcher
    // stay blind to its own previously-emitted output on the next poll?
    const res = spawnSync('bash', ['-c', `"$0" "%99" 2>>"${paneFile}"`, WATCHER_SCRIPT], {
      encoding: 'utf-8',
      env: {
        PATH: `${tmuxDir}:${process.env['PATH'] ?? ''}`,
        MACF_PROMPT_RESPONSES_PATH: configPath,
        MACF_LOG_PATH: join(stateDir, 'channel.log'),
        MACF_PROMPT_WATCH_WINDOW_SECS: String(opts.windowSecs),
        MACF_PROMPT_WATCH_INTERVAL_SECS: String(opts.intervalSecs),
      },
    });
    return {
      status: res.status,
      stderr: res.stderr ?? '',
      paneContents: existsSync(paneFile) ? readFileSync(paneFile, 'utf-8') : '',
    };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(tmuxDir, { recursive: true, force: true });
  }
}

describe('macf-prompt-watcher.sh — self-alert feedback loop (macf#712)', () => {
  it(
    'does not re-alert on its own ALERT output (no feedback loop) when stderr shares the watched pane',
    () => {
      // An unknown menu-style prompt that never matches the allowlist entry.
      const unknownFrame = '❯ 1. Some unrecognized option\n  2. Another option\n';
      const result = runWatcher({ initialFrame: unknownFrame, windowSecs: 3, intervalSecs: 1 });

      // The watcher's stderr is redirected (by the test harness, mirroring
      // claude.sh's real same-pane wiring) into the virtual pane file rather
      // than the test process's own stderr stream — so assert against the
      // accumulated pane contents, which is what the watcher's NEXT poll
      // would also see.
      const alertLines = result.paneContents
        .split('\n')
        .filter((l) => l.includes('ALERT: UNKNOWN prompt-like frame'));

      // Across a ~3s window polling every 1s (>=2 polls after the first
      // alert), the watcher must NOT have alerted more than once: the fix
      // makes it blind to its own previously-emitted alert line, so the
      // frame it sees is the SAME real unknown frame every poll → dedup
      // holds. Pre-fix this would be >= 2 (one per poll after the first).
      expect(alertLines.length).toBe(1);
    },
    15_000,
  );

  it(
    'a persistent unknown prompt-like frame alerts once, not every poll tick',
    () => {
      const unknownFrame = 'Continue? (y/n)\n';
      const result = runWatcher({ initialFrame: unknownFrame, windowSecs: 4, intervalSecs: 1 });

      const alertLines = result.paneContents
        .split('\n')
        .filter((l) => l.includes('ALERT: UNKNOWN prompt-like frame'));

      expect(alertLines.length).toBe(1);
    },
    15_000,
  );

  it('never treats its own alert line as a NEW distinct unknown prompt (no re-alert on content growth from self)', () => {
    // Regression for the specific self-match shape reported in #712: the
    // alert text embeds a `❯`-containing excerpt of the frame it is
    // alerting about, so once written to the pane, the alert line itself
    // "looks prompt-like". Directly assert the pane after a run contains
    // at most ONE watcher-emitted ALERT line despite the marker being
    // present in what the stub tmux "pane" accumulates.
    const unknownFrame = '❯ mystery-menu\n';
    const result = runWatcher({ initialFrame: unknownFrame, windowSecs: 3, intervalSecs: 1 });
    const markerCount = (result.paneContents.match(/\[macf-prompt-watcher\] ALERT: UNKNOWN/g) ?? [])
      .length;
    expect(markerCount).toBe(1);
  });

  it('Inv 1 preserved: an unknown prompt is never auto-answered (no send-keys fires)', () => {
    const unknownFrame = '❯ 1. Some unrecognized option\n  2. Another option\n';
    const stateDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-state-'));
    const workDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-work-'));
    const paneFile = join(workDir, 'pane.txt');
    writeFileSync(paneFile, unknownFrame);
    const tmuxDir = makeStubTmuxDir(paneFile);
    const configDir = join(workDir, '.macf');
    const configPath = join(configDir, 'prompt-responses.json');
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, MINIMAL_CONFIG);
      spawnSync('bash', ['-c', `"$0" "%99" 2>>"${paneFile}"`, WATCHER_SCRIPT], {
        encoding: 'utf-8',
        env: {
          PATH: `${tmuxDir}:${process.env['PATH'] ?? ''}`,
          MACF_PROMPT_RESPONSES_PATH: configPath,
          MACF_LOG_PATH: join(stateDir, 'channel.log'),
          MACF_PROMPT_WATCH_WINDOW_SECS: '3',
          MACF_PROMPT_WATCH_INTERVAL_SECS: '1',
        },
      });
      expect(existsSync(`${paneFile}.sends`)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
      rmSync(tmuxDir, { recursive: true, force: true });
    }
  });

  it('a real allowlist match still fires normally once self-output is filtered (positive path unaffected)', () => {
    const matchFrame = '❯ 1. I am using this for local development\n  2. Skip\n';
    const stateDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-state-'));
    const workDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-work-'));
    const paneFile = join(workDir, 'pane.txt');
    writeFileSync(paneFile, matchFrame);
    const tmuxDir = makeStubTmuxDir(paneFile);
    const configDir = join(workDir, '.macf');
    const configPath = join(configDir, 'prompt-responses.json');
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, MINIMAL_CONFIG);
      spawnSync('bash', ['-c', `"$0" "%99" 2>>"${paneFile}"`, WATCHER_SCRIPT], {
        encoding: 'utf-8',
        env: {
          PATH: `${tmuxDir}:${process.env['PATH'] ?? ''}`,
          MACF_PROMPT_RESPONSES_PATH: configPath,
          MACF_LOG_PATH: join(stateDir, 'channel.log'),
          MACF_PROMPT_WATCH_WINDOW_SECS: '3',
          MACF_PROMPT_WATCH_INTERVAL_SECS: '1',
        },
      });
      expect(existsSync(`${paneFile}.sends`)).toBe(true);
      const sends = readFileSync(`${paneFile}.sends`, 'utf-8');
      expect(sends).toContain('send-keys');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
      rmSync(tmuxDir, { recursive: true, force: true });
    }
  });
});
