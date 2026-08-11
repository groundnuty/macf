/**
 * Tests for `parseAppInstallations` — the one pure piece of `identity-confirm.ts`
 * (DR-043 Amendment-A / Slice 2, groundnuty/macf#838). The `confirmAppInstallation`
 * gh-JWT + fetch wrapper is NOT unit-tested here (thin I/O leaf, same posture as
 * `observer.ts`'s `gh`-shelling fns) — the mechanic was verified live against
 * `macf-code-agent` on 2026-08-11 (`GET /app/installations` →
 * `[{id:123978053, app_id:3378862, app_slug:"macf-code-agent"}]`).
 */
import { describe, it, expect } from 'vitest';
import { parseAppInstallations } from '../../../src/cli/bootstrap/identity-confirm.js';

describe('parseAppInstallations (macf#838 Slice 2 — credential-bearing identity parse)', () => {
  it('parses the live GET /app/installations shape, stringifying numeric ids', () => {
    // The exact shape returned on 2026-08-11 for macf-code-agent.
    const body = [{ id: 123978053, app_id: 3378862, app_slug: 'macf-code-agent', account: { login: 'groundnuty' } }];
    expect(parseAppInstallations(body)).toEqual([
      { appId: '3378862', installId: '123978053', appSlug: 'macf-code-agent' },
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
    expect(parseAppInstallations(body)).toEqual([{ appId: '7', installId: '99', appSlug: 'good' }]);
  });

  it('tolerates a missing app_slug (→ empty string) and preserves multiple installs in order', () => {
    const body = [
      { id: 10, app_id: 100 }, // no app_slug
      { id: 11, app_id: 101, app_slug: 'second' },
    ];
    expect(parseAppInstallations(body)).toEqual([
      { appId: '100', installId: '10', appSlug: '' },
      { appId: '101', installId: '11', appSlug: 'second' },
    ]);
  });

  it('skips entries with an explicit null id/app_id (not just undefined)', () => {
    expect(parseAppInstallations([{ id: null, app_id: 5 }, { id: 5, app_id: null }])).toEqual([]);
  });
});
