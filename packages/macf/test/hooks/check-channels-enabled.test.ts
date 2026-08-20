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
 * ~/.cache/claude-cli-nodejs/<encoded-cwd>/mcp-logs-*macf-agent/<ts>.jsonl —
 * globbed rather than one fixed directory name, because that name has already
 * changed twice (groundnuty/macf#1002 moved the mount from --plugin-dir to
 * .mcp.json; #1004 is the fix for the guard still greping the OLD name after
 * that move). These tests fake that layout under a temp HOME + temp
 * workspace, and pin the poll to 1 iteration (MACF_CHANNELS_POLL_ITERS=1) so
 * the inconclusive path doesn't burn the full ~12s.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'check-channels-enabled.sh');

const SKIP_DEBUG =
  'Channel notifications skipped: server plugin:macf-agent:macf-agent not in --channels list for this session';
const OK_DEBUG = 'Successfully connected (transport: stdio) in 2927ms';

// The three MCP-log directory names observed live (macf#1004): the legacy
// --plugin-dir mount, an even older plugin-manifest naming, and the current
// .mcp.json server:macf-agent mount (macf#1002 / DR-022 Amendment P). Default
// fixture dir name stays the LEGACY one so every pre-existing test below is
// unchanged; new tests exercise the other two explicitly.
const LEGACY_PLUGIN_DIR_NAME = 'mcp-logs-plugin-macf-agent-macf-agent';
const OLDER_PLUGIN_DIR_NAME = 'mcp-logs-plugin-macf-channel-server-macf-agent';
const CURRENT_MCP_JSON_DIR_NAME = 'mcp-logs-macf-agent';

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
  /** MCP-log directory name to write `logDebugLines` under (macf#1004 —
   *  the guard now globs `mcp-logs-*macf-agent` instead of one fixed name).
   *  Default: the legacy --plugin-dir mount name, so every test that doesn't
   *  care about the specific shape is unaffected. */
  readonly logDirName?: string;
  /** Additional MCP-log directories to create alongside the primary one
   *  (e.g. a stale legacy-mount dir coexisting with the current mount) —
   *  proves the guard picks the globally-newest log across ALL matching
   *  directories, not just whichever one `logDirName` names. Each entry's
   *  file mtime is set to `mtimeOffsetSecs` seconds before "now" (default
   *  -3600, i.e. an hour older than the primary log) so cross-directory
   *  newest-wins ordering is deterministic regardless of write/filesystem
   *  mtime-resolution timing — never inferred from write order alone. */
  readonly extraLogDirs?: readonly {
    readonly name: string;
    readonly lines: readonly string[];
    readonly mtimeOffsetSecs?: number;
  }[];
  /** Override env (e.g. MACF_SKIP_CHANNELS_CHECK). */
  readonly env?: Record<string, string | undefined>;
  /** Stdin payload (defaults to a SessionStart-shaped JSON object). */
  readonly stdin?: string;
  /** When set, create a channel-server log at
   *  `$HOME/.local/state/macf/testproj@test-agent/channel.log` with these JSONL
   *  lines — the tmux-wake fallback evidence the guard reads (macf#633
   *  false-deafness fix). `undefined` → no channel.log (can't confirm tmux-wake). */
  readonly channelLogLines?: readonly string[];
  /** When `channelLogLines` is set, whether to export MACF_LOG_PATH pointing at
   *  it (the primary locator). Default true. Set false to exercise the
   *  macf#887 identity-derivation fallback (MACF_PROJECT/MACF_AGENT_NAME) or
   *  the identity-unknown path instead. */
  readonly exportLogPathEnv?: boolean;
  /** MACF_PROJECT / MACF_AGENT_NAME to export — the identity pair the
   *  macf#887 fallback derives this agent's own log path from. `undefined` for
   *  either half → that half is left unset (both required to derive). */
  readonly identityEnv?: { readonly project?: string; readonly agentName?: string };
  /** Extra channel.log fixtures under OTHER `<project>@<agent>` dirs — never
   *  this agent's own — used to prove the macf#887 fix does not fall back to
   *  a cross-agent glob when this agent's own log can't be identified. */
  readonly peerChannelLogs?: readonly { readonly dir: string; readonly lines: readonly string[] }[];
}): RunResult {
  const fakeHome = mkdtempSync(join(tmpdir(), 'macf-chan-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'macf-chan-ws-'));

  const cacheRoot = join(fakeHome, '.cache', 'claude-cli-nodejs', encodeCwd(workspace));

  /** Write one MCP-log directory fixture (`debug` line each, one jsonl file),
   *  with an explicit mtime (seconds offset from "now") so cross-directory
   *  newest-wins ordering never depends on write-order/filesystem timing. */
  const writeMcpLogDir = (dirName: string, lines: readonly string[], filename: string, mtimeOffsetSecs: number): void => {
    const logDir = join(cacheRoot, dirName);
    mkdirSync(logDir, { recursive: true });
    const body = lines.map((d) => JSON.stringify({ debug: d, timestamp: '2026-06-27T15:58:10.141Z' })).join('\n');
    const filePath = join(logDir, filename);
    writeFileSync(filePath, body + '\n');
    const mtime = new Date(Date.now() + mtimeOffsetSecs * 1000);
    utimesSync(filePath, mtime, mtime);
  };

  if (opts.logDebugLines !== undefined) {
    writeMcpLogDir(opts.logDirName ?? LEGACY_PLUGIN_DIR_NAME, opts.logDebugLines, '2026-06-27T15-58-04-000Z.jsonl', 0);
  }

  // Each extra dir gets its own filename so the fixtures never collide on
  // disk even when several are written in the same test.
  (opts.extraLogDirs ?? []).forEach((extra, i) => {
    writeMcpLogDir(
      extra.name,
      extra.lines,
      `2026-06-27T15-58-0${5 + i}-000Z.jsonl`,
      extra.mtimeOffsetSecs ?? -3600,
    );
  });

  let channelLogPath: string | undefined;
  if (opts.channelLogLines !== undefined) {
    const chanDir = join(fakeHome, '.local', 'state', 'macf', 'testproj@test-agent');
    mkdirSync(chanDir, { recursive: true });
    channelLogPath = join(chanDir, 'channel.log');
    writeFileSync(channelLogPath, opts.channelLogLines.join('\n') + '\n');
  }

  for (const peer of opts.peerChannelLogs ?? []) {
    const peerDir = join(fakeHome, '.local', 'state', 'macf', peer.dir);
    mkdirSync(peerDir, { recursive: true });
    writeFileSync(join(peerDir, 'channel.log'), peer.lines.join('\n') + '\n');
  }

  const exportLogPathEnv = opts.exportLogPathEnv ?? true;

  // Clean env: temp HOME + workspace, fast poll. Drop ambient MACF_* so the
  // runner's identity doesn't leak in. Point MACF_LOG_PATH at the fake
  // channel.log when one was created (the guard's primary locator), unless
  // the test explicitly wants to exercise the fallback/unknown path instead.
  const cleanEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: fakeHome,
    CLAUDE_PROJECT_DIR: workspace,
    MACF_CHANNELS_POLL_ITERS: '1',
    ...(channelLogPath && exportLogPathEnv ? { MACF_LOG_PATH: channelLogPath } : {}),
    ...(opts.identityEnv?.project !== undefined ? { MACF_PROJECT: opts.identityEnv.project } : {}),
    ...(opts.identityEnv?.agentName !== undefined ? { MACF_AGENT_NAME: opts.identityEnv.agentName } : {}),
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

/** Build a `tmux_wake_delivered` JSONL line with `ts` offset from now (minutes). */
function tmuxWakeDeliveredAt(minutesAgo: number): string {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return JSON.stringify({ ts, level: 'info', event: 'tmux_wake_delivered', target: '%221' });
}

const TMUX_WAKE_DELIVERED = tmuxWakeDeliveredAt(1); // 1 min ago — comfortably "recent"
const TMUX_WAKE_DELIVERED_STALE = tmuxWakeDeliveredAt(120); // 2h ago — outside the recency window
const TMUX_WAKE_SKIPPED =
  '{"ts":"2026-07-01T09:05:06.742Z","level":"info","event":"tmux_wake_skipped","reason":"observational"}';

describe('check-channels-enabled.sh (SessionStart guard)', () => {
  // macf#633 false-deafness fix: native-push OFF is NOT "deaf" when tmux-wake
  // is delivering. The guard asserts the TRUE invariant (is SOME path
  // delivering?) via the channel-server log's `tmux_wake_delivered` events.
  describe('(a) native-push OFF + tmux-wake DELIVERING → info note, NOT a deafness alarm', () => {
    it('prints the accurate ℹ️ note (not deaf) + does NOT cry deafness + exits 0', () => {
      const r = runHook({
        logDebugLines: [OK_DEBUG, SKIP_DEBUG],
        channelLogLines: [TMUX_WAKE_DELIVERED],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('you are NOT deaf to routing');
      expect(r.stdout).toContain('tmux-wake');
      expect(r.stdout).toContain('macf#641');
      // The old false claims must be GONE.
      expect(r.stdout).not.toContain('ROUTED NOTIFICATIONS ARE DISABLED');
      expect(r.stdout).not.toContain('SILENTLY DROPPED');
    });
  });

  describe('(a2) native-push OFF + NO tmux-wake evidence → the (reworded, honest) warning', () => {
    it('warns delivery is UNCONFIRMED (not a false-absolute "you are deaf") + exits 0', () => {
      const r = runHook({
        logDebugLines: [OK_DEBUG, SKIP_DEBUG],
        channelLogLines: [TMUX_WAKE_SKIPPED], // channel.log exists but no delivery
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('UNCONFIRMED');
      expect(r.stdout).toContain('macf#632/#633');
      expect(r.stdout).toContain('Assert GitHub state'); // wraps across a newline in the heredoc
    });

    it('no channel.log at all → also the UNCONFIRMED warning (can\'t verify tmux-wake)', () => {
      const r = runHook({ logDebugLines: [OK_DEBUG, SKIP_DEBUG] }); // no channelLogLines
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('UNCONFIRMED');
    });

    // macf#701: a `tmux_wake_delivered` line only counts as evidence if its
    // `ts` is recent — a stale hit (e.g. carried over from a PREVIOUS session)
    // must NOT satisfy the "not deaf" check for THIS session.
    it('only a STALE tmux_wake_delivered (old ts) → UNCONFIRMED, not "not deaf"', () => {
      const r = runHook({
        logDebugLines: [OK_DEBUG, SKIP_DEBUG],
        channelLogLines: [TMUX_WAKE_DELIVERED_STALE],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('UNCONFIRMED');
      expect(r.stdout).not.toContain('you are NOT deaf to routing');
    });

    it('a STALE delivery mixed with older noise (both outside window) → UNCONFIRMED', () => {
      const r = runHook({
        logDebugLines: [OK_DEBUG, SKIP_DEBUG],
        channelLogLines: [TMUX_WAKE_SKIPPED, TMUX_WAKE_DELIVERED_STALE],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('UNCONFIRMED');
      expect(r.stdout).not.toContain('you are NOT deaf to routing');
    });
  });

  describe('(b) channels ON (connected, no skip) → silent', () => {
    it('prints nothing + exits 0', () => {
      const r = runHook({ logDebugLines: [OK_DEBUG] });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('(c) fail-open paths → exit 0 (silent OR honest-unknown, never blocking)', () => {
    // macf#1004 / assert-the-wrong-path.md: "no candidate directory matched"
    // and "checked, found clean" (test (b) above) were IDENTICAL observable
    // outcomes before this fix — both silent, exit 0. That is precisely how
    // the guard's own log-path regression went undetected: pointed at a
    // renamed directory, it "ran, passed, and detected nothing." So this is
    // no longer silent — it must say SOMETHING that a clean pass does not.
    it('no log dir at all → reports "could not verify" (unknown), NOT the silence a clean pass produces', () => {
      const r = runHook({}); // logDebugLines undefined → no directory created at all
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).not.toBe(''); // the decisive negative: (b)'s clean pass IS empty
      expect(r.stdout).toContain('Could not verify');
      expect(r.stdout).toContain('not yet checked');
      expect(r.stdout).toContain('macf#1004');
      // Must stay non-alarming — this is "unknown", not "you are deaf".
      expect(r.stdout).not.toContain('UNCONFIRMED');
      expect(r.stdout).not.toContain('you are NOT deaf to routing');
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

  describe("(f) macf#887 — own-log resolution never globs a peer's log", () => {
    it('MACF_LOG_PATH set + readable → used unchanged (regression pin)', () => {
      const r = runHook({
        logDebugLines: [OK_DEBUG, SKIP_DEBUG],
        channelLogLines: [TMUX_WAKE_DELIVERED],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('you are NOT deaf to routing');
    });

    it('MACF_LOG_PATH unset but MACF_PROJECT/MACF_AGENT_NAME derivable → the reconstructed path is read', () => {
      const r = runHook({
        logDebugLines: [OK_DEBUG, SKIP_DEBUG],
        channelLogLines: [TMUX_WAKE_DELIVERED], // written under testproj@test-agent
        exportLogPathEnv: false,
        identityEnv: { project: 'testproj', agentName: 'test-agent' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('you are NOT deaf to routing');
    });

    it('MACF_LOG_PATH unset AND identity undeterminable, with a BUSIER peer log present → skips with an honest message, never reads the peer log', () => {
      const r = runHook({
        logDebugLines: [OK_DEBUG, SKIP_DEBUG],
        // No channelLogLines for THIS agent — own log genuinely absent/unknown.
        exportLogPathEnv: false,
        peerChannelLogs: [
          // Would satisfy "not deaf" if the old cross-agent glob picked it up.
          { dir: 'otherproj@busy-peer', lines: [TMUX_WAKE_DELIVERED] },
        ],
      });
      expect(r.status).toBe(0);
      // Must NOT report "not deaf" based on the peer's delivery evidence —
      // this is the regression that matters (macf#887).
      expect(r.stdout).not.toContain('you are NOT deaf to routing');
      // Must say so explicitly rather than silently guessing.
      expect(r.stdout).toContain("could not identify this agent's own channel-server log");
      expect(r.stdout).toContain('macf#887');
      expect(r.stdout).toContain('UNCONFIRMED');
    });

    it('MACF_PROJECT set but MACF_AGENT_NAME missing (partial identity) → still undeterminable, never a peer glob', () => {
      const r = runHook({
        logDebugLines: [OK_DEBUG, SKIP_DEBUG],
        exportLogPathEnv: false,
        identityEnv: { project: 'testproj' }, // agentName omitted
        peerChannelLogs: [{ dir: 'otherproj@busy-peer', lines: [TMUX_WAKE_DELIVERED] }],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('you are NOT deaf to routing');
      expect(r.stdout).toContain('could not identify');
    });

    it('derivable identity but the reconstructed path has no file on disk → fails open like "no channel.log" (identity WAS known, so no false "could not identify" claim)', () => {
      const r = runHook({
        logDebugLines: [OK_DEBUG, SKIP_DEBUG],
        // channelLogLines omitted → no file exists at the derivable path.
        exportLogPathEnv: false,
        identityEnv: { project: 'testproj', agentName: 'test-agent' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('UNCONFIRMED');
      expect(r.stdout).not.toContain('could not identify');
    });
  });

  describe('(g) macf#1004 — mount-name-agnostic log-dir discovery', () => {
    // THE decisive regression test. Before macf#1004, the guard's LOG_DIR was
    // hardcoded to the LEGACY --plugin-dir mount name. On a workspace whose
    // channel-server is mounted the CURRENT way (.mcp.json server:macf-agent,
    // macf#1002), that hardcoded path never existed — the guard hit its
    // `[ -d "$LOG_DIR" ] || exit 0` fail-open branch and stayed silent, EVEN
    // THOUGH native channel-push was genuinely off and no tmux-wake evidence
    // existed. That is a silent PASS on a genuinely broken session — it would
    // pass here too if the code still had the old hardcoded path, because the
    // fixture below deliberately writes ONLY the current-mount directory name.
    it('current .mcp.json-mount directory name is CHECKED, not silently skipped (the regression itself)', () => {
      const r = runHook({
        logDirName: CURRENT_MCP_JSON_DIR_NAME,
        logDebugLines: [SKIP_DEBUG],
        // No channelLogLines → tmux-wake fallback evidence unavailable either
        // → the loud, checked-and-broken path is the only honest outcome.
      });
      expect(r.status).toBe(0);
      // The regression's fingerprint: a broken guard would produce '' here
      // (identical to test (b)'s clean pass) — see assert-the-wrong-path.md.
      expect(r.stdout.trim()).not.toBe('');
      expect(r.stdout).toContain('UNCONFIRMED');
      expect(r.stdout).not.toContain('Could not verify'); // this is CHECKED, not "unknown"
    });

    it('current .mcp.json-mount directory name, channels genuinely ON → still a clean, silent pass', () => {
      const r = runHook({ logDirName: CURRENT_MCP_JSON_DIR_NAME, logDebugLines: [OK_DEBUG] });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('legacy --plugin-dir mount name still works unchanged (no regression on old fleets)', () => {
      const r = runHook({ logDirName: LEGACY_PLUGIN_DIR_NAME, logDebugLines: [SKIP_DEBUG] });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('UNCONFIRMED');
    });

    it('the even-older plugin-manifest naming also works (a 3rd observed live shape)', () => {
      const r = runHook({ logDirName: OLDER_PLUGIN_DIR_NAME, logDebugLines: [SKIP_DEBUG] });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('UNCONFIRMED');
    });

    it('a directory name NOT ending in "macf-agent" is never matched (glob is scoped, not `mcp-logs-*`)', () => {
      // Guards against widening the glob so far it picks up an unrelated MCP
      // server's log (which would ALSO contain a generic "Successfully
      // connected" line) and reports a false "on" for macf-agent itself.
      const r = runHook({ logDirName: 'mcp-logs-some-other-server', logDebugLines: [OK_DEBUG] });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Could not verify'); // never matched → honest unknown, not a false "on"
    });

    it('stale legacy-mount log coexists with a fresher current-mount log → the CURRENT one wins', () => {
      // Primary (current mount) is "now"; the legacy dir's fixture is
      // deliberately backdated (default -3600s) so newest-across-directories
      // selection is unambiguous rather than relying on write-order timing.
      const r = runHook({
        logDirName: CURRENT_MCP_JSON_DIR_NAME,
        logDebugLines: [OK_DEBUG],
        extraLogDirs: [{ name: LEGACY_PLUGIN_DIR_NAME, lines: [SKIP_DEBUG] }],
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(''); // reads the fresher ON log, not the stale OFF one
    });

    it('stale current-mount log coexists with a fresher legacy-mount log → the LEGACY (newer) one wins', () => {
      // Inverts the previous case: proves selection is genuinely by mtime
      // across directories, not by any directory-name preference order.
      const r = runHook({
        logDirName: CURRENT_MCP_JSON_DIR_NAME,
        logDebugLines: [OK_DEBUG],
        extraLogDirs: [{ name: LEGACY_PLUGIN_DIR_NAME, lines: [SKIP_DEBUG], mtimeOffsetSecs: 3600 }],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('UNCONFIRMED');
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
