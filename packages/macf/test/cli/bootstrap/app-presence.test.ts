/**
 * Tests for `app-presence.ts` — the "ask, don't predict" App-presence
 * resolver (groundnuty/macf#967). Fully offline: `listOrgInstallations` +
 * `checkPredictedSlug` are injected; no `gh`/network involved.
 * `listOrgAppInstallations` / `checkAppSlugPresence` themselves are thin
 * `execFile('gh', ...)` I/O leaves and are NOT unit-tested here — same
 * posture `observer.test.ts`'s module doc establishes for `checkRepoExists`.
 * `resolveAppPresence` is the pure COMPOSITION over the injected seam, and
 * that composition is what's exhaustively covered below, including the
 * decisive "App exists but the token cannot see it" scenario a mocked
 * always-visible seam structurally cannot reproduce.
 */
import { describe, it, expect } from 'vitest';
import { parseOrgInstallations, resolveAppPresence, resolveAppPresenceStatus } from '../../../src/cli/bootstrap/app-presence.js';
import type { AppOwnerRef, OrgInstallationRecord, OrgInstallationsOutcome } from '../../../src/cli/bootstrap/app-presence.js';

const ORG_OWNER: AppOwnerRef = { account: 'macf-experiment', type: 'org' };
const USER_OWNER: AppOwnerRef = { account: 'someuser', type: 'user' };

function okListing(installations: readonly OrgInstallationRecord[]): OrgInstallationsOutcome {
  return { kind: 'ok', installations };
}

describe('parseOrgInstallations (pure)', () => {
  it('extracts app_id/app_slug/account.login from a well-formed {installations: [...]} body', () => {
    const body = {
      total_count: 1,
      installations: [{ id: 1, app_id: 4623756, app_slug: 'macf-experiment-runner-ops', account: { login: 'macf-experiment' } }],
    };
    expect(parseOrgInstallations(body)).toEqual([{ appId: '4623756', appSlug: 'macf-experiment-runner-ops', accountLogin: 'macf-experiment' }]);
  });

  it('non-object / missing installations / non-array installations -> empty, never throws', () => {
    expect(parseOrgInstallations(null)).toEqual([]);
    expect(parseOrgInstallations('not an object')).toEqual([]);
    expect(parseOrgInstallations({})).toEqual([]);
    expect(parseOrgInstallations({ installations: 'not an array' })).toEqual([]);
  });

  it('an entry missing app_id is skipped; other well-formed entries are kept', () => {
    const body = {
      installations: [{ app_id: null, app_slug: 'bad' }, { id: 2, app_id: 99, app_slug: 'good', account: { login: 'org' } }],
    };
    expect(parseOrgInstallations(body)).toEqual([{ appId: '99', appSlug: 'good', accountLogin: 'org' }]);
  });

  it('missing account/app_slug degrades to empty string, never throws', () => {
    const body = { installations: [{ app_id: 5 }] };
    expect(parseOrgInstallations(body)).toEqual([{ appId: '5', appSlug: '', accountLogin: '' }]);
  });
});

describe('resolveAppPresence (org-owned fleet, listing succeeds)', () => {
  it('a matching slug in the listing -> present, with the REAL confirmed appId/appSlug/accountLogin, method=org-installations-listing', async () => {
    const result = await resolveAppPresence(ORG_OWNER, 'macf-experiment-code-agent', undefined, {
      listOrgInstallations: async () =>
        okListing([{ appId: '111', appSlug: 'macf-experiment-code-agent', accountLogin: 'macf-experiment' }]),
      checkPredictedSlug: async () => {
        throw new Error('must not be called — the listing already resolved this');
      },
    });
    expect(result).toEqual({
      presence: 'present',
      appId: '111',
      appSlug: 'macf-experiment-code-agent',
      accountLogin: 'macf-experiment',
      method: 'org-installations-listing',
    });
  });

  it('DECISIVE — the exact live-incident shape: private Apps the operator administers ARE present in the org listing, never already-absent', async () => {
    // groundnuty/macf#967's reported incident: `code-agent` + `science-agent`
    // both existed and were installed; the org owner's listing sees both.
    const result = await resolveAppPresence(ORG_OWNER, 'macf-experiment-science-agent', undefined, {
      listOrgInstallations: async () =>
        okListing([
          { appId: '111', appSlug: 'macf-experiment-code-agent', accountLogin: 'macf-experiment' },
          { appId: '222', appSlug: 'macf-experiment-science-agent', accountLogin: 'macf-experiment' },
        ]),
    });
    expect(result.presence).toBe('present');
  });

  it('a genuinely absent App (listing succeeds, no match) -> absent, method=org-installations-listing, reason names the listing as authoritative', async () => {
    const result = await resolveAppPresence(ORG_OWNER, 'macf-experiment-code-agent', undefined, {
      listOrgInstallations: async () => okListing([{ appId: '222', appSlug: 'macf-experiment-science-agent', accountLogin: 'macf-experiment' }]),
      checkPredictedSlug: async () => {
        throw new Error('must not be called — the listing already resolved this');
      },
    });
    expect(result.presence).toBe('absent');
    expect(result.method).toBe('org-installations-listing');
    expect(result.reason).toMatch(/1 App\(s\) installed/);
  });

  it('matches by knownAppId too (fleet.lock-recorded app_id), even if the slug differs', async () => {
    const result = await resolveAppPresence(ORG_OWNER, 'predicted-slug-that-does-not-match', '999', {
      listOrgInstallations: async () => okListing([{ appId: '999', appSlug: 'a-suffixed-real-slug', accountLogin: 'macf-experiment' }]),
    });
    expect(result.presence).toBe('present');
    expect(result.appId).toBe('999');
  });

  it('empty listing (zero Apps installed on the org) -> absent', async () => {
    const result = await resolveAppPresence(ORG_OWNER, 'macf-experiment-code-agent', undefined, { listOrgInstallations: async () => okListing([]) });
    expect(result.presence).toBe('absent');
  });
});

describe('resolveAppPresence (org-owned fleet, listing UNAVAILABLE — the decisive class)', () => {
  it('DECISIVE — listing forbidden (403) AND the predicted-slug fallback 404s (app exists but the token cannot see it) -> unknown, NEVER already-absent', async () => {
    // This is the exact live-incident mechanism: a private App this token
    // cannot see returns 404 at GET /apps/{slug}. A mocked always-visible
    // seam (one that just returns 'present'/'absent' from a fake registry)
    // cannot reproduce this — it has to come from the ambiguous-404 seam.
    const result = await resolveAppPresence(ORG_OWNER, 'macf-experiment-code-agent', undefined, {
      listOrgInstallations: async () => ({ kind: 'forbidden' }),
      checkPredictedSlug: async () => 'absent',
    });
    expect(result.presence).toBe('unknown');
    expect(result.method).toBe('predicted-slug-fallback');
    expect(result.reason).toMatch(/insufficient permission/);
    expect(result.reason).toMatch(/cannot distinguish/);
  });

  it('listing kind=unknown (network failure) -> ALSO falls back, and an inconclusive fallback stays unknown', async () => {
    const result = await resolveAppPresence(ORG_OWNER, 'macf-experiment-code-agent', undefined, {
      listOrgInstallations: async () => ({ kind: 'unknown', reason: 'connect ETIMEDOUT' }),
      checkPredictedSlug: async () => 'unknown',
    });
    expect(result.presence).toBe('unknown');
    expect(result.reason).toMatch(/connect ETIMEDOUT/);
  });

  it('listing unavailable -> falls back to prediction and SAYS SO, even on a confident present from the fallback', async () => {
    const result = await resolveAppPresence(ORG_OWNER, 'macf-experiment-code-agent', undefined, {
      listOrgInstallations: async () => ({ kind: 'forbidden' }),
      checkPredictedSlug: async () => 'present',
    });
    expect(result.presence).toBe('present');
    expect(result.method).toBe('predicted-slug-fallback');
    // "says so" — the reason names BOTH why the listing wasn't used AND that
    // the fallback is what actually confirmed it.
    expect(result.reason).toMatch(/insufficient permission/);
    expect(result.reason).toMatch(/fell back to the predicted-slug check/);
  });
});

describe('resolveAppPresence (personal-account-owned fleet — no listing endpoint exists at all)', () => {
  it('never calls listOrgInstallations for a user-owned fleet; goes straight to the fallback', async () => {
    let listingCalled = false;
    const result = await resolveAppPresence(USER_OWNER, 'demo-fleet-code-agent', undefined, {
      listOrgInstallations: async () => {
        listingCalled = true;
        return { kind: 'ok', installations: [] };
      },
      checkPredictedSlug: async () => 'present',
    });
    expect(listingCalled).toBe(false);
    expect(result.presence).toBe('present');
    expect(result.method).toBe('predicted-slug-fallback');
    expect(result.reason).toMatch(/personal account/);
  });

  it('a 404 on the fallback for a user-owned fleet is ALSO unknown, never absent (the same honest-unknown floor applies)', async () => {
    const result = await resolveAppPresence(USER_OWNER, 'demo-fleet-code-agent', undefined, { checkPredictedSlug: async () => 'absent' });
    expect(result.presence).toBe('unknown');
  });
});

describe('resolveAppPresenceStatus (bare-Presence convenience wrapper — the shape wired as checkAppPresence/checkAppNameCollision)', () => {
  it('unwraps resolveAppPresence down to the bare Presence value (deps injected — no real gh/network)', async () => {
    const status = await resolveAppPresenceStatus(ORG_OWNER, 'macf-experiment-code-agent', undefined, {
      listOrgInstallations: async () => ({ kind: 'ok', installations: [{ appId: '1', appSlug: 'macf-experiment-code-agent', accountLogin: 'macf-experiment' }] }),
    });
    expect(status).toBe('present');
  });

  it('carries the decisive unknown-not-absent result through the wrapper too', async () => {
    const status = await resolveAppPresenceStatus(ORG_OWNER, 'macf-experiment-code-agent', undefined, {
      listOrgInstallations: async () => ({ kind: 'forbidden' }),
      checkPredictedSlug: async () => 'absent',
    });
    expect(status).toBe('unknown');
  });
});
