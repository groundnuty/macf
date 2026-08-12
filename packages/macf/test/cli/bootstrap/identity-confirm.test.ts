/**
 * Tests for `identity-confirm.ts`'s pure surface (DR-043 Amendment-A / Slice 2,
 * groundnuty/macf#838; hardened in Slice 2b increment 3):
 *   - `parseAppInstallations` + `selectConfirmedInstall` — the two pure pieces
 *     of the identity-read primitive.
 *   - `appInstallationUrl` — the pure consent-gate-2 URL helper.
 *   - `waitForAppInstallation` — the consent-gate-2 poll loop, tested via its
 *     injected `confirm` seam (fake timers; never real network).
 *
 * `confirmAppInstallation` itself is NOT unit-tested here (thin `gh`+`fetch`
 * I/O leaf, same posture as `observer.ts`'s `gh`-shelling fns) — the mechanic
 * was verified live against `macf-code-agent` on 2026-08-11 (`GET
 * /app/installations` → `[{id:123978053, app_id:3378862,
 * app_slug:"macf-code-agent"}]`).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseAppInstallations,
  selectConfirmedInstall,
  appInstallationUrl,
  waitForAppInstallation,
  waitForInstallTimeoutMessage,
} from '../../../src/cli/bootstrap/identity-confirm.js';
import type { ConfirmedInstall, IdentityConfirmation } from '../../../src/cli/bootstrap/identity-confirm.js';

describe('parseAppInstallations (macf#838 Slice 2 — credential-bearing identity parse)', () => {
  it('parses the live GET /app/installations shape, stringifying numeric ids + capturing account.login', () => {
    // The exact shape returned on 2026-08-11 for macf-code-agent.
    const body = [{ id: 123978053, app_id: 3378862, app_slug: 'macf-code-agent', account: { login: 'groundnuty' } }];
    expect(parseAppInstallations(body)).toEqual([
      { appId: '3378862', installId: '123978053', appSlug: 'macf-code-agent', accountLogin: 'groundnuty' },
    ]);
  });

  it('returns [] for a non-array body (404/error object, null, string)', () => {
    expect(parseAppInstallations({ message: 'Not Found' })).toEqual([]);
    expect(parseAppInstallations(null)).toEqual([]);
    expect(parseAppInstallations('nope')).toEqual([]);
    expect(parseAppInstallations(undefined)).toEqual([]);
  });

  it('returns [] for an empty array (App exists, zero installs — the app-no-install case upstream)', () => {
    expect(parseAppInstallations([])).toEqual([]);
  });

  it('skips entries missing id or app_id, keeps the valid ones', () => {
    const body = [
      { app_id: 1, app_slug: 'no-id' }, // missing id → skip
      { id: 2, app_slug: 'no-app-id' }, // missing app_id → skip
      null, // not an object → skip
      42, // not an object → skip
      { id: 99, app_id: 7, app_slug: 'good' }, // keep
    ];
    expect(parseAppInstallations(body)).toEqual([
      { appId: '7', installId: '99', appSlug: 'good', accountLogin: '' },
    ]);
  });

  it('tolerates a missing app_slug (→ empty string) and preserves multiple installs in order', () => {
    const body = [
      { id: 10, app_id: 100 }, // no app_slug, no account
      { id: 11, app_id: 101, app_slug: 'second', account: { login: 'org-b' } },
    ];
    expect(parseAppInstallations(body)).toEqual([
      { appId: '100', installId: '10', appSlug: '', accountLogin: '' },
      { appId: '101', installId: '11', appSlug: 'second', accountLogin: 'org-b' },
    ]);
  });

  it('skips entries with an explicit null id/app_id (not just undefined)', () => {
    expect(parseAppInstallations([{ id: null, app_id: 5 }, { id: 5, app_id: null }])).toEqual([]);
  });

  it('tolerates a malformed account (not an object, or missing .login) — accountLogin stays ""', () => {
    const body = [
      { id: 1, app_id: 2, account: 'not-an-object' },
      { id: 3, app_id: 4, account: {} },
      { id: 5, app_id: 6, account: null },
    ];
    expect(parseAppInstallations(body)).toEqual([
      { appId: '2', installId: '1', appSlug: '', accountLogin: '' },
      { appId: '4', installId: '3', appSlug: '', accountLogin: '' },
      { appId: '6', installId: '5', appSlug: '', accountLogin: '' },
    ]);
  });
});

describe('selectConfirmedInstall (macf#841 review nit d — do not trust entry [0])', () => {
  const a: ConfirmedInstall = { appId: '1', installId: '10', appSlug: 'demo-code-agent', accountLogin: 'personal-test' };
  const b: ConfirmedInstall = { appId: '1', installId: '11', appSlug: 'demo-code-agent', accountLogin: 'groundnuty' };

  it('returns undefined for an empty list', () => {
    expect(selectConfirmedInstall([])).toBeUndefined();
  });

  it('with no ExpectedIdentity, returns the first entry (backward-compatible default)', () => {
    expect(selectConfirmedInstall([a, b])).toBe(a);
  });

  it('with an ExpectedIdentity, picks the matching entry even when it is NOT first', () => {
    expect(selectConfirmedInstall([a, b], { accountLogin: 'groundnuty' })).toBe(b);
  });

  it('matches on appSlug + accountLogin together (both must hold)', () => {
    expect(selectConfirmedInstall([a, b], { appSlug: 'demo-code-agent', accountLogin: 'groundnuty' })).toBe(b);
  });

  it('returns undefined (never falls back to [0]) when nothing matches the expectation', () => {
    expect(selectConfirmedInstall([a, b], { accountLogin: 'nonexistent-account' })).toBeUndefined();
  });

  it('returns undefined on an empty list even with an ExpectedIdentity given', () => {
    expect(selectConfirmedInstall([], { accountLogin: 'groundnuty' })).toBeUndefined();
  });

  it('macf#846 review 3c: an ExpectedIdentity with ZERO criteria ({}) matches nothing — ' +
    'NOT the same as omitting expected entirely', () => {
    expect(selectConfirmedInstall([a, b], {})).toBeUndefined();
  });
});

describe('appInstallationUrl (DR-043 §D2 consent gate 2)', () => {
  it('renders the verified GitHub install-page URL for the App slug', () => {
    expect(appInstallationUrl('demo-fleet-code-agent')).toBe(
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
    );
  });

  it('is one shape regardless of slug content — no owner-type branching (unlike gate 1)', () => {
    expect(appInstallationUrl('org-owned-app')).toBe('https://github.com/apps/org-owned-app/installations/new');
  });
});

describe('waitForInstallTimeoutMessage (macf#841 review — name the actual last-observed cause)', () => {
  it('unconfirmable → says GitHub was never successfully queried, NOT "operator hasn\'t clicked"', () => {
    const msg = waitForInstallTimeoutMessage(60_000, { status: 'unconfirmable' });
    expect(msg).toMatch(/never successfully queried/i);
    expect(msg).toMatch(/not necessarily.*operator/i);
  });

  it('app-no-install → says the operator must click Install', () => {
    const msg = waitForInstallTimeoutMessage(60_000, { status: 'app-no-install' });
    expect(msg).toMatch(/must click "Install"/);
  });

  it('installed-unexpected-target → names the mismatch AND lists what was actually seen', () => {
    const seen: ConfirmedInstall = { appId: '1', installId: '9', appSlug: 'demo-code-agent', accountLogin: 'wrong-account' };
    const msg = waitForInstallTimeoutMessage(60_000, { status: 'installed-unexpected-target', installs: [seen] });
    expect(msg).toMatch(/IS installed, but not on the expected target/);
    expect(msg).toMatch(/demo-code-agent@wrong-account/);
  });

  it('the three non-confirmed messages are mutually distinct (never collapse to one generic sentence)', () => {
    const messages = [
      waitForInstallTimeoutMessage(60_000, { status: 'unconfirmable' }),
      waitForInstallTimeoutMessage(60_000, { status: 'app-no-install' }),
      waitForInstallTimeoutMessage(60_000, { status: 'installed-unexpected-target', installs: [] }),
    ];
    expect(new Set(messages).size).toBe(3);
  });

  it('omitting appSlug leaves the message byte-identical to before (no trailing URL hint)', () => {
    const msg = waitForInstallTimeoutMessage(60_000, { status: 'app-no-install' });
    expect(msg).not.toContain('Install page:');
    expect(msg).not.toContain('installations/new');
  });

  it('appSlug given -> re-prints the install URL in the timeout message itself (app-no-install)', () => {
    const msg = waitForInstallTimeoutMessage(60_000, { status: 'app-no-install' }, 'demo-fleet-code-agent');
    expect(msg).toContain('https://github.com/apps/demo-fleet-code-agent/installations/new');
  });

  it('appSlug given -> also re-printed on the unconfirmable + installed-unexpected-target branches', () => {
    expect(waitForInstallTimeoutMessage(60_000, { status: 'unconfirmable' }, 'demo-fleet-code-agent')).toContain(
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
    );
    expect(
      waitForInstallTimeoutMessage(60_000, { status: 'installed-unexpected-target', installs: [] }, 'demo-fleet-code-agent'),
    ).toContain('https://github.com/apps/demo-fleet-code-agent/installations/new');
  });
});

describe('waitForAppInstallation (DR-043 §D2 consent gate 2 poll loop)', () => {
  const install: ConfirmedInstall = { appId: '1', installId: '2', appSlug: 'demo-code-agent', accountLogin: 'groundnuty' };
  /** `expected` is REQUIRED as of macf#846 review 3a — every call site below supplies a real identity. */
  const expected = { accountLogin: 'groundnuty' };

  it('checks immediately, then polls on the interval, until confirm() reports confirmed', async () => {
    vi.useFakeTimers();
    try {
      const confirm = vi
        .fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>()
        .mockResolvedValueOnce({ status: 'app-no-install' })
        .mockResolvedValueOnce({ status: 'unconfirmable' }) // a transient hiccup must not abort the poll
        .mockResolvedValueOnce({ status: 'confirmed', install });

      const resultPromise = waitForAppInstallation({
        appId: 'a',
        keyPath: 'k',
        expected,
        pollIntervalMs: 1_000,
        confirm,
      });

      await vi.advanceTimersByTimeAsync(0); // 1st confirm() call — app-no-install
      await vi.advanceTimersByTimeAsync(1_000); // sleep, 2nd confirm() — unconfirmable
      await vi.advanceTimersByTimeAsync(1_000); // sleep, 3rd confirm() — confirmed

      await expect(resultPromise).resolves.toEqual(install);
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(confirm).toHaveBeenCalledWith('a', 'k', expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves on the FIRST check without waiting at all when already installed', async () => {
    vi.useFakeTimers();
    try {
      const confirm = vi.fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>().mockResolvedValue({
        status: 'confirmed',
        install,
      });
      const resultPromise = waitForAppInstallation({ appId: 'a', keyPath: 'k', expected, confirm });
      await vi.advanceTimersByTimeAsync(0);
      await expect(resultPromise).resolves.toEqual(install);
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('macf#846 review 3c: rejects an all-undefined expected ({}) IMMEDIATELY — before the first poll, ' +
    'no confirm() call at all', async () => {
    const confirm = vi.fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>();
    await expect(
      waitForAppInstallation({ appId: 'a', keyPath: 'k', expected: {}, confirm }),
    ).rejects.toThrow(/must carry at least one of appSlug\/accountLogin/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('macf#846 review nit b: fires onUnexpectedTarget ONCE on the first installed-unexpected-target poll, ' +
    'then keeps polling to a later confirm', async () => {
    vi.useFakeTimers();
    try {
      const wrongInstall: ConfirmedInstall = {
        appId: '1',
        installId: '9',
        appSlug: 'demo-code-agent',
        accountLogin: 'wrong-account',
      };
      const confirm = vi
        .fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>()
        .mockResolvedValueOnce({ status: 'installed-unexpected-target', installs: [wrongInstall] })
        .mockResolvedValueOnce({ status: 'installed-unexpected-target', installs: [wrongInstall] })
        .mockResolvedValueOnce({ status: 'confirmed', install });
      const onUnexpectedTarget = vi.fn();

      const resultPromise = waitForAppInstallation({
        appId: 'a',
        keyPath: 'k',
        expected,
        pollIntervalMs: 1_000,
        confirm,
        onUnexpectedTarget,
      });

      await vi.advanceTimersByTimeAsync(0); // 1st confirm — unexpected target, warns
      await vi.advanceTimersByTimeAsync(1_000); // 2nd confirm — unexpected target AGAIN, must NOT re-warn
      await vi.advanceTimersByTimeAsync(1_000); // 3rd confirm — confirmed
      await expect(resultPromise).resolves.toEqual(install);

      expect(onUnexpectedTarget).toHaveBeenCalledTimes(1);
      expect(onUnexpectedTarget).toHaveBeenCalledWith([wrongInstall]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never calls onUnexpectedTarget when no installed-unexpected-target poll ever occurs', async () => {
    vi.useFakeTimers();
    try {
      const confirm = vi.fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>().mockResolvedValue({
        status: 'confirmed',
        install,
      });
      const onUnexpectedTarget = vi.fn();
      const resultPromise = waitForAppInstallation({ appId: 'a', keyPath: 'k', expected, confirm, onUnexpectedTarget });
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise;
      expect(onUnexpectedTarget).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the ExpectedIdentity through to every confirm() call', async () => {
    vi.useFakeTimers();
    try {
      const confirm = vi.fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>().mockResolvedValue({
        status: 'confirmed',
        install,
      });
      const resultPromise = waitForAppInstallation({
        appId: 'a',
        keyPath: 'k',
        expected: { accountLogin: 'groundnuty' },
        confirm,
      });
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise;
      expect(confirm).toHaveBeenCalledWith('a', 'k', { accountLogin: 'groundnuty' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a loud, actionable error on timeout — NEVER resolves silently', async () => {
    vi.useFakeTimers();
    try {
      const confirm = vi
        .fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>()
        .mockResolvedValue({ status: 'app-no-install' });
      const resultPromise = waitForAppInstallation({
        appId: 'a',
        keyPath: 'k',
        expected,
        timeoutMs: 5_000,
        pollIntervalMs: 2_000,
        confirm,
      });
      // Attach a rejection handler immediately so the fake-timer advance below
      // (which is what actually triggers the rejection) never produces an
      // unhandled-rejection warning in the interim.
      const assertion = expect(resultPromise).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      await expect(resultPromise).rejects.toThrow(/must click "Install"/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on timeout, re-prints the install URL when expected.appSlug is given (consent-gate UX fix)', async () => {
    vi.useFakeTimers();
    try {
      const confirm = vi
        .fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>()
        .mockResolvedValue({ status: 'app-no-install' });
      const resultPromise = waitForAppInstallation({
        appId: 'a',
        keyPath: 'k',
        expected: { appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' },
        timeoutMs: 3_000,
        pollIntervalMs: 1_000,
        confirm,
      });
      const assertion = expect(resultPromise).rejects.toThrow(/https:\/\/github\.com\/apps\/demo-fleet-code-agent\/installations\/new/);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('on timeout, the error message is branched on the LAST observed status (macf#841 review) — ' +
    'unconfirmable throughout must NOT say "operator hasn\'t clicked"', async () => {
    vi.useFakeTimers();
    try {
      const confirm = vi
        .fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>()
        .mockResolvedValue({ status: 'unconfirmable' });
      const resultPromise = waitForAppInstallation({
        appId: 'a',
        keyPath: 'k',
        expected,
        timeoutMs: 3_000,
        pollIntervalMs: 1_000,
        confirm,
      });
      const assertion = expect(resultPromise).rejects.toThrow(/never successfully queried/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('on timeout with a mismatched install seen, the error names the mismatch (drift, not "not installed")', async () => {
    vi.useFakeTimers();
    try {
      const wrongInstall: ConfirmedInstall = {
        appId: '1',
        installId: '9',
        appSlug: 'demo-code-agent',
        accountLogin: 'wrong-account',
      };
      const confirm = vi
        .fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>()
        .mockResolvedValue({ status: 'installed-unexpected-target', installs: [wrongInstall] });
      const resultPromise = waitForAppInstallation({
        appId: 'a',
        keyPath: 'k',
        expected: { accountLogin: 'groundnuty' },
        timeoutMs: 3_000,
        pollIntervalMs: 1_000,
        confirm,
      });
      const assertion = expect(resultPromise).rejects.toThrow(/IS installed, but not on the expected target/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('never busy-spins: sleeps AT LEAST once between two non-confirmed checks', async () => {
    vi.useFakeTimers();
    try {
      const confirm = vi
        .fn<(appId: string, keyPath: string) => Promise<IdentityConfirmation>>()
        .mockResolvedValueOnce({ status: 'app-no-install' })
        .mockResolvedValueOnce({ status: 'confirmed', install });

      const resultPromise = waitForAppInstallation({
        appId: 'a',
        keyPath: 'k',
        expected,
        pollIntervalMs: 5_000,
        confirm,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(confirm).toHaveBeenCalledTimes(1); // must NOT have called again without a timer tick
      await vi.advanceTimersByTimeAsync(5_000);
      expect(confirm).toHaveBeenCalledTimes(2);
      await resultPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});
