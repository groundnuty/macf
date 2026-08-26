/**
 * Tests for `live-smoke.ts` — the pure contract-assertion + injectable
 * orchestration half of the DR-043 provisioning live-smoke
 * (groundnuty/macf#869).
 *
 * These are the DECISIVE tests per `assert-the-wrong-path.md`: every "FAILS
 * when..." case below feeds the assertion function a deliberately malformed
 * fake response and checks it reports `ok: false` — proving the checker
 * actually fires on a contract violation, not merely that it runs. A
 * stubbed implementation that always returns `ok: true` would pass every
 * "passes when..." test here but fail every "FAILS when..." one; that
 * asymmetry is the point (mirrors the citation-guard test's
 * "prove the checker fires before trusting its clean verdict" shape).
 *
 * `realCreateVariable`/`realDeleteVariable`/`realFetchRepoJson`/
 * `confirmAppInstallation` themselves are thin `gh`/`fetch` I/O leaves —
 * untested here, same posture as every other `gh api` shell-out in this
 * package (see `variable-write.test.ts`'s own doc comment). The REAL
 * network calls are exercised only by the opt-in, credentialed
 * `test/live-smoke/provisioning-live-smoke.test.ts`, which this file's
 * fakes stand in for.
 */
import { describe, it, expect } from 'vitest';
import type { IdentityConfirmation } from '../../../src/cli/bootstrap/identity-confirm.js';
import type { CreateVariableFn, DeleteVariableFn } from '../../../src/cli/bootstrap/variable-write.js';
import {
  assertIsTemplateContract,
  assertRepositorySelectionPresent,
  buildLiveSmokeVariableName,
  checkInstallationsContract,
  checkTemplateRepoContract,
  runVariableRoundTrip,
  type ConfirmFn,
  type FetchRepoJsonFn,
} from '../../../src/cli/bootstrap/live-smoke.js';

describe('assertRepositorySelectionPresent (pure)', () => {
  it('FAILS when a confirmed install is missing repository_selection (the macf#1136 contract)', () => {
    const confirmation: IdentityConfirmation = {
      status: 'confirmed',
      install: { appId: '1', installId: '2', appSlug: 'x', accountLogin: 'y' },
    };
    const result = assertRepositorySelectionPresent(confirmation);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('repository_selection');
  });

  it('passes when repository_selection is present on the confirmed install', () => {
    const confirmation: IdentityConfirmation = {
      status: 'confirmed',
      install: { appId: '1', installId: '2', appSlug: 'x', accountLogin: 'y', repositorySelection: 'selected' },
    };
    expect(assertRepositorySelectionPresent(confirmation).ok).toBe(true);
  });

  it('treats app-no-install as not-a-violation (nothing returned to check)', () => {
    const confirmation: IdentityConfirmation = { status: 'app-no-install' };
    expect(assertRepositorySelectionPresent(confirmation).ok).toBe(true);
  });

  it('treats unconfirmable as a live-smoke FAILURE — GitHub was never successfully asked', () => {
    const confirmation: IdentityConfirmation = { status: 'unconfirmable' };
    expect(assertRepositorySelectionPresent(confirmation).ok).toBe(false);
  });

  it('checks EVERY returned install in the installed-unexpected-target case, not just the first', () => {
    const confirmation: IdentityConfirmation = {
      status: 'installed-unexpected-target',
      installs: [
        { appId: '1', installId: '2', appSlug: 'x', accountLogin: 'y', repositorySelection: 'selected' },
        { appId: '1', installId: '3', appSlug: 'x', accountLogin: 'z' },
      ],
    };
    const result = assertRepositorySelectionPresent(confirmation);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('1 of 2');
  });

  it('passes installed-unexpected-target when every returned install carries the field', () => {
    const confirmation: IdentityConfirmation = {
      status: 'installed-unexpected-target',
      installs: [{ appId: '1', installId: '2', appSlug: 'x', accountLogin: 'y', repositorySelection: 'all' }],
    };
    expect(assertRepositorySelectionPresent(confirmation).ok).toBe(true);
  });
});

describe('checkInstallationsContract (injectable orchestration)', () => {
  it('delegates to the injected confirm fn and applies the assertion to its result', async () => {
    const confirm: ConfirmFn = async () => ({ status: 'app-no-install' });
    const result = await checkInstallationsContract('123', '/tmp/key.pem', confirm);
    expect(result.ok).toBe(true);
  });

  it('surfaces a missing-field violation from the injected confirm fn', async () => {
    const confirm: ConfirmFn = async () => ({
      status: 'confirmed',
      install: { appId: '1', installId: '2', appSlug: 'x', accountLogin: 'y' },
    });
    const result = await checkInstallationsContract('123', '/tmp/key.pem', confirm);
    expect(result.ok).toBe(false);
  });
});

describe('buildLiveSmokeVariableName (pure)', () => {
  it('is stable for the same inputs and varies with either input', () => {
    const a = buildLiveSmokeVariableName(1000, 'ab12cd');
    const b = buildLiveSmokeVariableName(1000, 'ab12cd');
    const c = buildLiveSmokeVariableName(2000, 'ab12cd');
    const d = buildLiveSmokeVariableName(1000, 'zz99zz');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('is a valid Actions-variable name shape (uppercase, no spaces)', () => {
    const name = buildLiveSmokeVariableName(1_700_000_000_000, 'ab12cd');
    expect(name).toMatch(/^[A-Z0-9_]+$/);
  });
});

describe('runVariableRoundTrip (pure orchestration — fakes only, no network)', () => {
  it('FAILS and surfaces the underlying error when create is rejected (the macf#866 org-visibility shape)', async () => {
    const createFn: CreateVariableFn = async () => {
      throw new Error('gh api create-variable failed for "X" at "orgs/o": HTTP 422: object is missing required key: visibility');
    };
    const deleteFn: DeleteVariableFn = async () => 'deregistered';
    const result = await runVariableRoundTrip('orgs/o', createFn, deleteFn);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('visibility');
  });

  it('reports success on a clean create+delete round trip', async () => {
    const createFn: CreateVariableFn = async () => 'created';
    const deleteFn: DeleteVariableFn = async () => 'deregistered';
    const result = await runVariableRoundTrip('repos/o/r', createFn, deleteFn);
    expect(result.ok).toBe(true);
  });

  it('FAILS + names the leftover variable when create succeeds but cleanup delete throws', async () => {
    const createFn: CreateVariableFn = async () => 'created';
    const deleteFn: DeleteVariableFn = async () => {
      throw new Error('gh api delete-variable failed: HTTP 403');
    };
    const result = await runVariableRoundTrip('repos/o/r', createFn, deleteFn);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('manual removal');
    expect(result.detail).toContain('PROVISIONING_LIVE_SMOKE_');
  });

  it('FAILS when create returns "exists" for a freshly-generated name (a bare truthy check would miss this)', async () => {
    const createFn: CreateVariableFn = async () => 'exists';
    const deleteFn: DeleteVariableFn = async () => 'deregistered';
    const result = await runVariableRoundTrip('repos/o/r', createFn, deleteFn);
    expect(result.ok).toBe(false);
  });

  it('FAILS when the cleanup delete returns "absent" instead of "deregistered" (create silently no-opped)', async () => {
    const createFn: CreateVariableFn = async () => 'created';
    const deleteFn: DeleteVariableFn = async () => 'absent';
    const result = await runVariableRoundTrip('repos/o/r', createFn, deleteFn);
    expect(result.ok).toBe(false);
  });

  it('FAILS when the cleanup delete returns "unknown" instead of "deregistered" (groundnuty/macf#1206 — never treated as a confirmed cleanup)', async () => {
    const createFn: CreateVariableFn = async () => 'created';
    const deleteFn: DeleteVariableFn = async () => 'unknown';
    const result = await runVariableRoundTrip('repos/o/r', createFn, deleteFn);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unknown');
  });

  it('passes the SAME name to createFn and deleteFn (round trip on one variable, not two)', async () => {
    const seen: { created?: string; deleted?: string } = {};
    const createFn: CreateVariableFn = async (_prefix, name) => {
      seen.created = name;
      return 'created';
    };
    const deleteFn: DeleteVariableFn = async (_prefix, name) => {
      seen.deleted = name;
      return 'deregistered';
    };
    await runVariableRoundTrip('repos/o/r', createFn, deleteFn);
    expect(seen.created).toBeDefined();
    expect(seen.created).toBe(seen.deleted);
  });
});

describe('assertIsTemplateContract (pure)', () => {
  it('FAILS when is_template is false', () => {
    expect(assertIsTemplateContract({ is_template: false }, 'o/r').ok).toBe(false);
  });

  it('FAILS when is_template is missing entirely', () => {
    expect(assertIsTemplateContract({}, 'o/r').ok).toBe(false);
  });

  it('FAILS on a non-object body', () => {
    expect(assertIsTemplateContract(null, 'o/r').ok).toBe(false);
    expect(assertIsTemplateContract('not json', 'o/r').ok).toBe(false);
    expect(assertIsTemplateContract([], 'o/r').ok).toBe(false);
  });

  it('passes when is_template is true', () => {
    expect(assertIsTemplateContract({ is_template: true }, 'o/r').ok).toBe(true);
  });
});

describe('checkTemplateRepoContract (injectable orchestration)', () => {
  it('surfaces the fetch failure without swallowing it', async () => {
    const fetchRepoJson: FetchRepoJsonFn = async () => {
      throw new Error('gh api repos/o/r failed: HTTP 404: Not Found');
    };
    const result = await checkTemplateRepoContract('o/r', fetchRepoJson);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('404');
  });

  it('delegates to assertIsTemplateContract on a successful fetch', async () => {
    const fetchRepoJson: FetchRepoJsonFn = async () => ({ is_template: true });
    const result = await checkTemplateRepoContract('o/r', fetchRepoJson);
    expect(result.ok).toBe(true);
  });
});
