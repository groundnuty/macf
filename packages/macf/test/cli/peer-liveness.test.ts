/**
 * Tests for peer-liveness classification (macf#959 — "science died silently
 * and all five macf diagnostics failed to say so").
 *
 * The decisive pair (per `assert-the-wrong-path.md` — an assertion that
 * would fail if the classifier were wrong, not merely one it happens to
 * satisfy):
 *
 *   1. a genuinely DEAD peer (native down, no local session) → 'dead'
 *   2. a BUSY-BUT-ALIVE peer (native down, local session producing output)
 *      → NOT 'dead' (this is the shape a naive "native down ⇒ dead"
 *      classifier — exactly what the incident's diagnostics did — gets
 *      wrong; also guards the sibling wrong-implementation "alive requires
 *      busy" by covering the idle-but-alive case too).
 *
 * `probeLocalSession`'s own tests exercise the Pattern-C content-diff
 * MECHANISM directly (two distinct `capture-pane` captures across the sleep
 * window), not just a pre-baked boolean — proving busy/idle is read from
 * pane CONTENT, never a `#{session_activity}`-style staleness proxy
 * (macf#645).
 */
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  classifyPeerLiveness,
  createLocalSessionSeams,
  peerSessionName,
  probeLocalSession,
  DEFAULT_LIVENESS_WINDOW_MS,
  type LocalSessionSeams,
  type LocalSessionSnapshot,
} from '../../src/cli/commands/peer-liveness.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});
const mockExecFileSync = vi.mocked(execFileSync);

describe('classifyPeerLiveness', () => {
  it('is "online" whenever the native probe answered, regardless of session', () => {
    expect(classifyPeerLiveness(true, null)).toBe('online');
    expect(classifyPeerLiveness(true, { existence: 'absent', busy: null })).toBe('online');
    expect(classifyPeerLiveness(true, { existence: 'present', busy: true })).toBe('online');
  });

  it('DECISIVE 1: native down + no local session at all → "dead"', () => {
    const session: LocalSessionSnapshot = { existence: 'absent', busy: null };
    expect(classifyPeerLiveness(false, session)).toBe('dead');
  });

  it('DECISIVE 2: native down + BUSY local session → "degraded", never "dead"', () => {
    // The agent is producing output (busy: true) — a naive "native
    // unreachable ⇒ dead" classifier (the incident's actual diagnostics)
    // gets this case wrong. `busy` must never demote a present session
    // toward 'dead'.
    const session: LocalSessionSnapshot = { existence: 'present', busy: true };
    expect(classifyPeerLiveness(false, session)).toBe('degraded');
  });

  it('an IDLE (not busy) local session is also "degraded", never "dead"', () => {
    // Guards the sibling wrong-implementation this pair alone would miss:
    // a classifier that only checked `busy === true` for "alive" would also
    // pass DECISIVE 2 above, but would wrongly call an idle-but-present
    // session dead. Presence alone — not busy-ness — is what proves alive.
    const session: LocalSessionSnapshot = { existence: 'present', busy: false };
    expect(classifyPeerLiveness(false, session)).toBe('degraded');
  });

  it('a present session with an UNREADABLE pane is still "degraded" (existence already answers alive)', () => {
    const session: LocalSessionSnapshot = { existence: 'present', busy: null };
    expect(classifyPeerLiveness(false, session)).toBe('degraded');
  });

  it('honest-unknown floor: no local visibility → "unknown", never "dead" or "online"', () => {
    expect(classifyPeerLiveness(false, null)).toBe('unknown');
    expect(classifyPeerLiveness(false, { existence: 'unknown', busy: null })).toBe('unknown');
  });
});

describe('probeLocalSession — Pattern-C content-diff mechanism', () => {
  function seams(overrides: Partial<LocalSessionSeams> = {}): LocalSessionSeams {
    return {
      hasSession: vi.fn(() => 'present') as LocalSessionSeams['hasSession'],
      capturePane: vi.fn(() => 'frame') as LocalSessionSeams['capturePane'],
      sleep: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('a CHANGING pane across the window → busy: true (genuine content-diff, not a stale flag)', async () => {
    let call = 0;
    const capturePane = vi.fn(() => (call++ === 0 ? 'frame-A (streaming...)' : 'frame-B (still streaming...)'));
    const s = seams({ capturePane });
    const result = await probeLocalSession('proj@science-agent', s);
    expect(result).toEqual({ existence: 'present', busy: true });
    expect(capturePane).toHaveBeenCalledTimes(2);
    expect(s.sleep).toHaveBeenCalledWith(DEFAULT_LIVENESS_WINDOW_MS);
  });

  it('an UNCHANGING pane across the window → busy: false (idle, still alive)', async () => {
    const capturePane = vi.fn(() => 'same frame both times');
    const s = seams({ capturePane });
    const result = await probeLocalSession('proj@science-agent', s);
    expect(result).toEqual({ existence: 'present', busy: false });
  });

  it('an unreadable pane (both captures null) → busy: null, existence stays "present"', async () => {
    const s = seams({ capturePane: vi.fn(() => null) });
    const result = await probeLocalSession('proj@science-agent', s);
    expect(result).toEqual({ existence: 'present', busy: null });
  });

  it('session "absent" → never diffs the pane (zero capturePane / sleep calls)', async () => {
    const s = seams({ hasSession: vi.fn(() => 'absent') });
    const result = await probeLocalSession('proj@science-agent', s);
    expect(result).toEqual({ existence: 'absent', busy: null });
    expect(s.capturePane).not.toHaveBeenCalled();
    expect(s.sleep).not.toHaveBeenCalled();
  });

  it('session "unknown" → never diffs the pane either (honest-unknown short-circuits)', async () => {
    const s = seams({ hasSession: vi.fn(() => 'unknown') });
    const result = await probeLocalSession('proj@science-agent', s);
    expect(result).toEqual({ existence: 'unknown', busy: null });
    expect(s.capturePane).not.toHaveBeenCalled();
  });

  it('honors a custom window', async () => {
    const s = seams();
    await probeLocalSession('proj@science-agent', s, 500);
    expect(s.sleep).toHaveBeenCalledWith(500);
  });
});

describe('peerSessionName', () => {
  it('derives <project>@<routing-label> from a SCREAMING_SNAKE registry name', () => {
    expect(peerSessionName('macf', 'SCIENCE_AGENT')).toBe('macf@science-agent');
    expect(peerSessionName('macf', 'CODE_AGENT')).toBe('macf@code-agent');
  });

  it('is idempotent on an already-kebab peer name', () => {
    expect(peerSessionName('macf', 'science-agent')).toBe('macf@science-agent');
  });
});

describe('createLocalSessionSeams — the real tmux-backed production wiring', () => {
  it('hasSession: "present" when `tmux has-session` exits 0', () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from(''));
    const s = createLocalSessionSeams();
    expect(s.hasSession('macf@science-agent')).toBe('present');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'tmux',
      ['has-session', '-t', 'macf@science-agent'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    );
  });

  it('hasSession: "absent" when tmux reports "can\'t find session" on stderr', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('exit 1'), {
        stderr: Buffer.from("can't find session macf@science-agent"),
      });
    });
    const s = createLocalSessionSeams();
    expect(s.hasSession('macf@science-agent')).toBe('absent');
  });

  it('hasSession: "unknown" on any OTHER failure (no tmux server, tmux missing, permission error)', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn tmux ENOENT'), { stderr: Buffer.from('') });
    });
    const s1 = createLocalSessionSeams();
    expect(s1.hasSession('macf@science-agent')).toBe('unknown');

    mockExecFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('exit 1'), {
        stderr: Buffer.from('no server running on /tmp/tmux-1000/default'),
      });
    });
    const s2 = createLocalSessionSeams();
    expect(s2.hasSession('macf@science-agent')).toBe('unknown');
  });

  it('capturePane: returns the pane text on success, null on any failure', () => {
    mockExecFileSync.mockReturnValueOnce('some pane content\n');
    const s = createLocalSessionSeams();
    expect(s.capturePane('macf@science-agent')).toBe('some pane content\n');

    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('no such pane');
    });
    expect(s.capturePane('macf@science-agent')).toBeNull();
  });
});
