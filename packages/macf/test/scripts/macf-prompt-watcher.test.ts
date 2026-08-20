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
import { spawnSync, spawn } from 'node:child_process';
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
 *
 * `totalCapSecs` defaults to `windowSecs` (macf#1041): the deadline-extension
 * fix restarts the watcher's deadline on ANY prompt-relevant frame (matched
 * OR merely prompt-like-but-unrecognized), so a test whose `initialFrame`
 * itself looks prompt-like would otherwise keep extending up to the script's
 * real 1800s default — pinning the cap to `windowSecs` reproduces the exact
 * pre-#1041 fixed-`launch+WINDOW` bound (the first computed deadline already
 * saturates at the cap, so no extension is observable) for tests that exist
 * to pin OTHER behaviour and don't care about the new mechanism.
 */
function runWatcher(opts: {
  readonly initialFrame: string;
  readonly windowSecs: number;
  readonly intervalSecs: number;
  readonly totalCapSecs?: number;
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
        MACF_PROMPT_WATCH_TOTAL_CAP_SECS: String(opts.totalCapSecs ?? opts.windowSecs),
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
    //
    // Uses a NUMBERED menu shape (post-macf#729 `_looks_prompt_like` only
    // treats `❯` as prompt-like on a numbered option line — see the
    // "input-box vs menu-cursor misclassification" describe block below).
    // The alert text embeds this same "❯ 1. mystery-menu" excerpt verbatim,
    // which is what reproduces the self-match hazard this test guards.
    const unknownFrame = '❯ 1. mystery-menu\n';
    const result = runWatcher({ initialFrame: unknownFrame, windowSecs: 3, intervalSecs: 1 });
    const markerCount = (result.paneContents.match(/\[macf-prompt-watcher\] ALERT: UNKNOWN/g) ?? [])
      .length;
    expect(markerCount).toBe(1);
  });

  it('Inv 1 preserved: an unknown prompt is never auto-answered (no send-keys fires)', () => {
    // Explicit generous timeout (vitest default is 5000ms): this test
    // blocks on a real bash subprocess for ~WINDOW(3s) of internal sleeps,
    // already close to that default under normal load and observed to trip
    // it under a heavily loaded machine — unrelated to macf#1041's change
    // (see runWatcher doc: the pinned TOTAL_CAP reproduces identical
    // pre-#1041 timing here), just pre-existing margin worth widening while
    // this file is being touched.
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
          // Pinned to windowSecs (macf#1041): this frame looks prompt-like
          // every poll, which would now extend the deadline indefinitely
          // (up to the real 1800s default) absent this cap — see runWatcher
          // doc for why the pin reproduces the pre-#1041 fixed bound.
          MACF_PROMPT_WATCH_TOTAL_CAP_SECS: '3',
        },
      });
      expect(existsSync(`${paneFile}.sends`)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
      rmSync(tmuxDir, { recursive: true, force: true });
    }
  }, 15_000);

  it(
    'a real allowlist match still fires normally once self-output is filtered (positive path unaffected)',
    () => {
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
            // Pinned to windowSecs (macf#1041): once fired, this frame
            // keeps looking prompt-like (unrecognized post-fire, since the
            // stub pane never changes) on every subsequent poll, which
            // would otherwise extend the deadline up to the real 1800s
            // default.
            MACF_PROMPT_WATCH_TOTAL_CAP_SECS: '3',
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
    },
    15_000,
  );
});

describe('macf-prompt-watcher.sh — input-box vs menu-cursor misclassification (macf#729)', () => {
  // `❯` is overloaded: it is BOTH the menu-selection cursor on a real
  // numbered ceremony prompt AND the Claude Code free-form input-box
  // cursor. `_looks_prompt_like` must distinguish a queued/typed message in
  // the input box (not prompt-like — no ALERT) from a real numbered menu
  // (still prompt-like — ALERT preserved, Inv 1).

  function alertCount(paneContents: string): number {
    return paneContents.split('\n').filter((l) => l.includes('ALERT: UNKNOWN prompt-like frame'))
      .length;
  }

  it('a queued message in the free-form input box is NOT prompt-like (no ALERT spam)', () => {
    const inputBoxFrame = '❯ you merge pleasee, complete startup-reconcile (DR-008)\n';
    const result = runWatcher({ initialFrame: inputBoxFrame, windowSecs: 3, intervalSecs: 1 });
    expect(alertCount(result.paneContents)).toBe(0);
  });

  it('an empty input box is NOT prompt-like (no ALERT)', () => {
    const emptyInputBoxFrame = '❯ \n';
    const result = runWatcher({ initialFrame: emptyInputBoxFrame, windowSecs: 3, intervalSecs: 1 });
    expect(alertCount(result.paneContents)).toBe(0);
  });

  it('Inv 1 preserved: a real numbered menu NOT on the allowlist is still prompt-like (ALERT fires)', () => {
    const menuFrame = '❯ 1. Yes, proceed\n  2. No\n';
    const result = runWatcher({ initialFrame: menuFrame, windowSecs: 3, intervalSecs: 1 });
    expect(alertCount(result.paneContents)).toBe(1);
  });

  it('Inv 1 preserved: a (y/n) prompt NOT on the allowlist is still prompt-like (ALERT fires)', () => {
    const yesNoFrame = 'Continue? (y/n)\n';
    const result = runWatcher({ initialFrame: yesNoFrame, windowSecs: 3, intervalSecs: 1 });
    expect(alertCount(result.paneContents)).toBe(1);
  });
});

/**
 * The macf#1041 deadline-extension + total-cap fix. Unlike `runWatcher`
 * above (blocking `spawnSync`, fixed run-to-completion), these tests need to
 * mutate the virtual pane WHILE the watcher is still running — the whole
 * point being to prove a prompt that appears only after the original
 * fixed-window deadline would have elapsed is still caught. `spawn` (async)
 * + an `exited` promise gives the test control over timing.
 */
function spawnWatcherAsync(opts: {
  readonly initialFrame: string;
  readonly windowSecs: number;
  readonly intervalSecs: number;
  readonly totalCapSecs: number;
  readonly config?: string;
}): {
  readonly setPane: (frame: string) => void;
  readonly sendsExist: () => boolean;
  readonly sendsContents: () => string;
  readonly exited: Promise<{ readonly code: number | null; readonly elapsedMs: number }>;
  readonly cleanup: () => void;
} {
  const stateDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-state-'));
  const workDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-work-'));
  const paneFile = join(workDir, 'pane.txt');
  writeFileSync(paneFile, opts.initialFrame);
  const tmuxDir = makeStubTmuxDir(paneFile);
  const configDir = join(workDir, '.macf');
  const configPath = join(configDir, 'prompt-responses.json');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, opts.config ?? MINIMAL_CONFIG);

  const start = Date.now();
  const child = spawn('bash', ['-c', `"$0" "%99" 2>>"${paneFile}"`, WATCHER_SCRIPT], {
    env: {
      PATH: `${tmuxDir}:${process.env['PATH'] ?? ''}`,
      MACF_PROMPT_RESPONSES_PATH: configPath,
      MACF_LOG_PATH: join(stateDir, 'channel.log'),
      MACF_PROMPT_WATCH_WINDOW_SECS: String(opts.windowSecs),
      MACF_PROMPT_WATCH_INTERVAL_SECS: String(opts.intervalSecs),
      MACF_PROMPT_WATCH_TOTAL_CAP_SECS: String(opts.totalCapSecs),
    },
  });

  const exited = new Promise<{ code: number | null; elapsedMs: number }>((resolve) => {
    child.on('exit', (code) => resolve({ code, elapsedMs: Date.now() - start }));
  });

  return {
    setPane: (frame: string) => writeFileSync(paneFile, frame),
    sendsExist: () => existsSync(`${paneFile}.sends`),
    sendsContents: () =>
      existsSync(`${paneFile}.sends`) ? readFileSync(`${paneFile}.sends`, 'utf-8') : '',
    exited,
    cleanup: () => {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
      rmSync(tmuxDir, { recursive: true, force: true });
    },
  };
}

/** Poll `predicate` every `pollMs` until it returns true or `timeoutMs` elapses. */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!predicate()) {
    throw new Error(`waitForCondition timed out after ${String(timeoutMs)}ms`);
  }
}

describe('macf-prompt-watcher.sh — deadline extension + total lifetime cap (macf#1041)', () => {
  it(
    'DECISIVE: a prompt that becomes answerable only AFTER the original fixed window has already elapsed is still answered',
    async () => {
      const windowSecs = 2;
      const totalCapSecs = 15;
      // Mirrors the unanswered/unattended trust dialog: prompt-like, never
      // on the allowlist, sits unchanged on screen — exactly what the
      // pre-#1041 watcher stopped watching for after `launch + WINDOW`.
      const unanswerableFrame = '❯ 1. Some unrecognized ceremony option\n  2. Another option\n';
      const h = spawnWatcherAsync({
        initialFrame: unanswerableFrame,
        windowSecs,
        intervalSecs: 1,
        totalCapSecs,
      });
      try {
        // Wait past the ORIGINAL fixed launch+WINDOW deadline (2s) while the
        // unanswerable frame is still showing. A pre-#1041 watcher would
        // already have exited by this point — this is the exact elapsed
        // time that produced the bug.
        await new Promise((r) => setTimeout(r, (windowSecs + 2) * 1000));
        // assert-the-wrong-path (packages/macf/plugin/rules/assert-the-wrong-path.md):
        // nothing should have fired yet — proves the send below (once it
        // happens) is caused by the NEWLY-appeared frame, not by the
        // unanswerable one somehow being misclassified as a match.
        expect(h.sendsExist()).toBe(false);

        // The operator finally clears the trust dialog; the seeded
        // dev-channels prompt appears right after (the exact #1041/#994
        // scenario).
        h.setPane('❯ 1. I am using this for local development\n  2. Skip\n');

        const { code } = await h.exited;
        expect(code).toBe(0);
        expect(h.sendsExist()).toBe(true);
        expect(h.sendsContents()).toContain('send-keys');
      } finally {
        h.cleanup();
      }
    },
    25_000,
  );

  it(
    'the "restart on ANSWERED prompt" branch (Option 1) is independently load-bearing: a SECOND answerable prompt, arriving after the base window via a NON-prompt-like gap, still fires',
    async () => {
      // assert-the-wrong-path (packages/macf/plugin/rules/assert-the-wrong-path.md):
      // the DECISIVE test above leaves the fired frame on screen, which is
      // STILL prompt-like (unrecognized post-fire) — so its extension could
      // be entirely explained by the `elif _looks_prompt_like` branch alone.
      // Deleting the `matched === 1 -> _extend_deadline` branch would not
      // fail that test. This test isolates the OTHER branch: the gap
      // between the two prompts is deliberately NOT prompt-like, so any
      // extension observed here can only be attributable to the first
      // prompt's successful ANSWER, not to lingering unrecognized content.
      // WINDOW small relative to entry A's OWN internal settle/send/verify/
      // retry sequence in `_handle_match` (~3.2s of fixed sleeps,
      // independent of WINDOW): by the time A's fire completes, real
      // elapsed time already EXCEEDS the original launch+WINDOW deadline —
      // so no extra artificial wait is needed to prove "past the original
      // deadline" before introducing the second prompt. WINDOW is set well
      // above that ~3.2s floor (not just barely above it) to leave generous
      // scheduling slack for the SECOND prompt's detection under a loaded
      // CI/dev machine — this test's assertion is about which branch causes
      // survival, not about racing a razor-thin edge.
      const windowSecs = 8;
      const totalCapSecs = 25;
      const config = JSON.stringify({
        schema_version: '1',
        entries: [
          {
            name: 'first-entry',
            frame_contains: ['FIRST_PROMPT_MARKER'],
            option_text: 'FIRST_PROMPT_MARKER option',
            send: '1',
            max_fires: 1,
          },
          {
            name: 'second-entry',
            frame_contains: ['SECOND_PROMPT_MARKER'],
            option_text: 'SECOND_PROMPT_MARKER option',
            send: '2',
            max_fires: 1,
          },
        ],
      });
      const firstFrame = '❯ 1. FIRST_PROMPT_MARKER option\n  2. Skip\n';
      // The stub tmux pane never changes state on its own (capture-pane
      // always returns the current static file contents), so a successful
      // fire always runs `_handle_match`'s full settle→send→verify→retry
      // sequence against the SAME unchanged frame, producing exactly 4
      // "SEND:" lines (digit, Enter, retry-digit, retry-Enter) before it
      // gives up and returns — this is the deterministic completion marker
      // used below, not a magic number.
      const h = spawnWatcherAsync({
        initialFrame: firstFrame,
        windowSecs,
        intervalSecs: 1,
        totalCapSecs,
        config,
      });
      try {
        await waitForCondition(
          () => (h.sendsContents().match(/SEND:/g) ?? []).length >= 4,
          15_000,
          150,
        );

        // Immediately clear the pane to something with NO prompt-relevant
        // shape at all — neither entry matches it, and it is not
        // `_looks_prompt_like`. Any deadline extension from here on can
        // only come from the FIRST prompt's successful answer having
        // restarted the clock, never from this frame itself. By this point
        // real elapsed time already exceeds the original launch+WINDOW (6s)
        // deadline is NOT yet guaranteed on a fast machine (A's fire alone
        // is ~3.2s) — the explicit wait below establishes it unambiguously
        // on any machine speed.
        h.setPane('Normal assistant output streaming, nothing prompt-like here.\n');

        // Wait past the ORIGINAL launch+WINDOW (8s) deadline before
        // introducing the second prompt, with real margin either side:
        // entry A's fire (~3.2s) plus this wait comfortably exceeds 8s, and
        // the extended deadline (fire-completion + 8s) still has generous
        // room left for the second prompt's detection below, even under a
        // heavily loaded machine.
        await new Promise((r) => setTimeout(r, 5_000));

        const secondFrame = '  1. Skip\n❯ 2. SECOND_PROMPT_MARKER option\n';
        h.setPane(secondFrame);

        // The second entry's digit ('2') is a marker no other entry ever
        // sends — proves ENTRY B specifically fired, not merely "more of
        // entry A" (which is capped at max_fires:1 regardless). Bounded by
        // a generous timeout, but must land within the WINDOW-sized grace
        // period the first prompt's answer restarted (~6s from A's fire
        // completion) for the matched===1 branch to be what saved it.
        await waitForCondition(() => h.sendsContents().includes('-- 2'), 20_000, 150);
        expect(h.sendsContents()).toContain('-- 2');

        const { code } = await h.exited;
        expect(code).toBe(0);
      } finally {
        h.cleanup();
      }
    },
    65_000,
  );

  it(
    'the total lifetime cap bounds the watcher even under CONTINUOUS prompt-relevant activity (no watcher runs forever)',
    async () => {
      const windowSecs = 2;
      const totalCapSecs = 4;
      // Persistently unanswerable — under per-activity extension alone
      // (no cap) this would never spontaneously go idle within any bounded
      // wait. Proves the cap, not idle-timeout, is what stops it.
      const unanswerableFrame = '❯ 1. Some unrecognized ceremony option\n  2. Another option\n';
      const h = spawnWatcherAsync({
        initialFrame: unanswerableFrame,
        windowSecs,
        intervalSecs: 1,
        totalCapSecs,
      });
      try {
        const { code, elapsedMs } = await h.exited;
        expect(code).toBe(0);
        // assert-the-wrong-path, direction 1: did NOT exit at the OLD
        // naive launch+WINDOW bound (~2s) — proves extension actually
        // happened (the activity signal is doing something).
        expect(elapsedMs).toBeGreaterThan(windowSecs * 1000);
        // assert-the-wrong-path, direction 2: did NOT run substantially
        // past the cap either — bounded near totalCapSecs, with slack only
        // for poll cadence + process overhead, not "forever".
        expect(elapsedMs).toBeLessThan((totalCapSecs + 3) * 1000);
        expect(h.sendsExist()).toBe(false); // Inv 1 held throughout
      } finally {
        h.cleanup();
      }
    },
    20_000,
  );

  it(
    'an idle pane with nothing prompt-like still exits promptly at the base window, unaffected by a much larger total cap',
    async () => {
      const windowSecs = 2;
      // A cap far larger than the base window — an idle pane must not be
      // held alive anywhere near it (idle watchers must still exit).
      const totalCapSecs = 60;
      const idleFrame = 'Normal assistant output streaming — nothing prompt-like here.\n';
      const h = spawnWatcherAsync({
        initialFrame: idleFrame,
        windowSecs,
        intervalSecs: 1,
        totalCapSecs,
      });
      try {
        const { code, elapsedMs } = await h.exited;
        expect(code).toBe(0);
        expect(h.sendsExist()).toBe(false);
        // Exited near windowSecs — nowhere near the 60s cap.
        expect(elapsedMs).toBeLessThan((windowSecs + 3) * 1000);
      } finally {
        h.cleanup();
      }
    },
    20_000,
  );

  it('the trust dialog is still HARD-REFUSED (Inv 2) even while the extended-lifetime mechanism keeps the watcher alive longer', () => {
    // A second allowlist entry whose signature contains "trust" — dropped
    // at LOAD time per Inv 2, same as the real dev-channels seed's sibling
    // trust entry would be. Kept alongside dev-channels so both the refused
    // and the answerable path are exercised in the same config.
    const configWithRefusedTrustEntry = JSON.stringify({
      schema_version: '1',
      entries: [
        {
          name: 'trust-workspace',
          frame_contains: ['Do you trust the files in this folder?'],
          option_text: 'Yes, proceed',
          send: '1',
          max_fires: 1,
        },
        {
          name: 'dev-channels',
          frame_contains: ['I am using this for local development'],
          option_text: 'I am using this for local development',
          send: '1',
          max_fires: 1,
        },
      ],
    });

    const stateDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-state-'));
    const workDir = mkdtempSync(join(tmpdir(), 'macf-prompt-watcher-work-'));
    const paneFile = join(workDir, 'pane.txt');
    // A frame that WOULD match the trust-workspace entry's shape if it were
    // not dropped at load — persists unchanged for several poll ticks,
    // which is exactly the "keep extending" signal macf#1041 adds. If
    // refusal were ever bypassed by the longer runtime, this is where it
    // would show up.
    const trustFrame = '❯ 1. Yes, proceed\n  2. No\nDo you trust the files in this folder?\n';
    writeFileSync(paneFile, trustFrame);
    const tmuxDir = makeStubTmuxDir(paneFile);
    const configDir = join(workDir, '.macf');
    const configPath = join(configDir, 'prompt-responses.json');
    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, configWithRefusedTrustEntry);
      const res = spawnSync('bash', ['-c', `"$0" "%99" 2>>"${paneFile}"`, WATCHER_SCRIPT], {
        encoding: 'utf-8',
        env: {
          PATH: `${tmuxDir}:${process.env['PATH'] ?? ''}`,
          MACF_PROMPT_RESPONSES_PATH: configPath,
          MACF_LOG_PATH: join(stateDir, 'channel.log'),
          MACF_PROMPT_WATCH_WINDOW_SECS: '1',
          // Deliberately LARGER than windowSecs: the trust frame is
          // prompt-relevant activity every poll, so this spans several
          // would-be extensions — proving refusal survives the longer
          // runtime macf#1041 introduces, not just the original 1s window.
          MACF_PROMPT_WATCH_TOTAL_CAP_SECS: '4',
          MACF_PROMPT_WATCH_INTERVAL_SECS: '1',
        },
      });
      expect(res.status).toBe(0);
      // stderr is redirected into paneFile by the harness (see the `2>>`
      // wrapper above) rather than propagating to `res.stderr` — read the
      // pane file, matching how every other test in this file verifies
      // alert output.
      const paneAfter = existsSync(paneFile) ? readFileSync(paneFile, 'utf-8') : '';
      // Inv 2: dropped at load, never a candidate to fire, regardless of
      // how long the watcher subsequently runs.
      expect(paneAfter).toContain('REFUSED entry "trust-workspace"');
      // Inv 1+2 combined result: never auto-answered.
      expect(existsSync(`${paneFile}.sends`)).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
      rmSync(tmuxDir, { recursive: true, force: true });
    }
  });
});
