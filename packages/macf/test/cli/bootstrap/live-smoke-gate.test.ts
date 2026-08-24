/**
 * Tests for `test/live-smoke/live-smoke-gate.ts`'s pure config-resolution
 * logic (groundnuty/macf#869). Deliberately kept in the DEFAULT test
 * tier (not under `test/live-smoke/`, which is excluded from `vitest run`)
 * — this is exactly the "skip cleanly and loudly when credentials are
 * absent" behavior the issue requires, and that behavior must itself stay
 * covered by the ordinary `make check` gate, not only by the credentialed
 * suite it gates.
 */
import { describe, it, expect } from 'vitest';
import {
  describeMissingChecks,
  resolveLiveSmokeConfig,
  totalLiveSmokeChecks,
} from '../../live-smoke/live-smoke-gate.js';

describe('resolveLiveSmokeConfig (pure)', () => {
  it('resolves every field absent from an empty env — the default `make check` state', () => {
    const config = resolveLiveSmokeConfig({});
    expect(config).toEqual({
      appId: undefined,
      appKey: undefined,
      variableRepo: undefined,
      variableOrg: undefined,
      templateRepo: undefined,
    });
  });

  it('treats an explicit empty string the SAME as unset (not a truthy-but-empty target)', () => {
    const config = resolveLiveSmokeConfig({ MACF_LIVE_SMOKE_VARIABLE_REPO: '' });
    expect(config.variableRepo).toBeUndefined();
  });

  it('reads every configured var when all are present', () => {
    const config = resolveLiveSmokeConfig({
      MACF_LIVE_SMOKE_APP_ID: '123',
      MACF_LIVE_SMOKE_APP_KEY: '/tmp/key.pem',
      MACF_LIVE_SMOKE_VARIABLE_REPO: 'o/r',
      MACF_LIVE_SMOKE_VARIABLE_ORG: 'o',
      MACF_LIVE_SMOKE_TEMPLATE_REPO: 'o/t',
    });
    expect(config).toEqual({
      appId: '123',
      appKey: '/tmp/key.pem',
      variableRepo: 'o/r',
      variableOrg: 'o',
      templateRepo: 'o/t',
    });
  });
});

describe('describeMissingChecks (pure)', () => {
  it('DECISIVE: names EVERY check missing from an empty config — a stub returning [] would fail this', () => {
    const missing = describeMissingChecks({});
    expect(missing).toHaveLength(totalLiveSmokeChecks());
  });

  it('totalLiveSmokeChecks and the empty-config missing count always agree (single source of truth)', () => {
    // The decisive property this pins: the banner's "N of TOTAL" can never
    // drift, because TOTAL is derived from the SAME list `describeMissingChecks`
    // filters — there is no second hand-maintained count to fall out of sync.
    expect(describeMissingChecks({})).toHaveLength(totalLiveSmokeChecks());
    expect(totalLiveSmokeChecks()).toBeGreaterThan(0);
  });

  it('names ZERO checks missing when every field is configured', () => {
    const missing = describeMissingChecks({
      appId: '123',
      appKey: '/tmp/key.pem',
      variableRepo: 'o/r',
      variableOrg: 'o',
      templateRepo: 'o/t',
    });
    expect(missing).toHaveLength(0);
  });

  it('requires BOTH appId and appKey — either alone still counts as missing', () => {
    expect(describeMissingChecks({ appId: '123' })).toHaveLength(4);
    expect(describeMissingChecks({ appKey: '/tmp/key.pem' })).toHaveLength(4);
    expect(describeMissingChecks({ appId: '123', appKey: '/tmp/key.pem' })).toHaveLength(3);
  });

  it('drops exactly one entry per independently-configured field', () => {
    const missing = describeMissingChecks({ variableRepo: 'o/r' });
    expect(missing).toHaveLength(3);
    expect(missing.some((m) => m.includes('VARIABLE_REPO'))).toBe(false);
    expect(missing.some((m) => m.includes('VARIABLE_ORG'))).toBe(true);
    expect(missing.some((m) => m.includes('TEMPLATE_REPO'))).toBe(true);
  });
});
