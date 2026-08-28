/**
 * Tests for `apply-routing.ts::reconcileTrustedActors` — DR-043 Amendment P
 * row 3 applied to `MACF_TRUSTED_ACTORS` (groundnuty/macf#1319: "adding an
 * agent leaves it untrusted by its predecessors"). Fully offline:
 * `readRepoVariableValue`/`updateRepoVariable`/`confirmReconciliation` are
 * hand-scripted fakes, no real `gh`.
 *
 * End-to-end coverage through `applyFleet` (the create-only path stays
 * untouched, the reconcile pass only ever sees `'already-present'` repos)
 * lives in `apply-fleet.test.ts`'s "routing reconciliation" describe block.
 * This file is the unit-level decisive-pair + honest-unknown + declined
 * coverage for `reconcileTrustedActors` in isolation.
 */
import { describe, it, expect } from 'vitest';
import { reconcileTrustedActors, TRUSTED_ACTORS_VAR } from '../../../src/cli/bootstrap/apply-routing.js';
import type { TrustedActorsDivergence, TrustedActorsReconcileDeps } from '../../../src/cli/bootstrap/apply-routing.js';

function depsWith(overrides: Partial<TrustedActorsReconcileDeps> = {}): TrustedActorsReconcileDeps {
  return {
    readRepoVariableValue: async () => 'stale[bot]',
    updateRepoVariable: async () => 'updated',
    confirmReconciliation: async () => true,
    ...overrides,
  };
}

describe('reconcileTrustedActors — decisive pair (per #1319: (1) alone is satisfied by "always overwrite")', () => {
  it('case 1: a DIVERGING value is reconciled after confirmation — the confirmation batch and the write both carry BOTH values', async () => {
    let confirmedWith: readonly TrustedActorsDivergence[] | undefined;
    const updateCalls: Array<{ repo: string; name: string; value: string }> = [];
    const deps = depsWith({
      readRepoVariableValue: async () => 'old-actor[bot]',
      confirmReconciliation: async (divergences) => {
        confirmedWith = divergences;
        return true;
      },
      updateRepoVariable: async (repo, name, value) => {
        updateCalls.push({ repo, name, value });
        return 'updated';
      },
    });

    const result = await reconcileTrustedActors('new-actor[bot] old-actor[bot]', ['a/repo'], deps);

    expect(confirmedWith).toEqual([{ repo: 'a/repo', observedValue: 'old-actor[bot]', desiredValue: 'new-actor[bot] old-actor[bot]' }]);
    // MUTATION-DECISIVE: the WRITTEN value is asserted, not merely the
    // reported status — a bug that wrote `observedValue` (a no-op-disguised-
    // as-fix) would still report 'updated' but fail THIS assertion.
    expect(updateCalls).toEqual([{ repo: 'a/repo', name: TRUSTED_ACTORS_VAR, value: 'new-actor[bot] old-actor[bot]' }]);
    expect(result['a/repo']?.status).toBe('updated');
    const reason = result['a/repo'] && 'reason' in result['a/repo'] ? result['a/repo'].reason : undefined;
    expect(reason).toContain('old-actor[bot]');
    expect(reason).toContain('new-actor[bot] old-actor[bot]');
  });

  it('case 2: a MATCHING value is left completely untouched — no write, no churn, no confirmation call at all', async () => {
    let updateCalled = false;
    let confirmCalled = false;
    const deps = depsWith({
      readRepoVariableValue: async () => 'same[bot]',
      confirmReconciliation: async () => {
        confirmCalled = true;
        return true;
      },
      updateRepoVariable: async () => {
        updateCalled = true;
        return 'updated';
      },
    });

    const result = await reconcileTrustedActors('same[bot]', ['a/repo'], deps);

    expect(result).toEqual({ 'a/repo': { status: 'already-present' } });
    expect(updateCalled).toBe(false);
    expect(confirmCalled).toBe(false);
  });
});

describe('reconcileTrustedActors — honest-unknown floor', () => {
  it('a value that cannot be re-read is reported (skipped), never assumed current, never overwritten, never included in the confirmation batch', async () => {
    let confirmCalled = false;
    let updateCalled = false;
    const deps = depsWith({
      readRepoVariableValue: async () => undefined,
      confirmReconciliation: async () => {
        confirmCalled = true;
        return true;
      },
      updateRepoVariable: async () => {
        updateCalled = true;
        return 'updated';
      },
    });

    const result = await reconcileTrustedActors('desired[bot]', ['a/repo'], deps);

    expect(result['a/repo']?.status).toBe('skipped');
    expect(confirmCalled).toBe(false);
    expect(updateCalled).toBe(false);
  });

  it('a readRepoVariableValue that THROWS is treated the same as an unreadable value — skipped, never overwritten', async () => {
    const deps = depsWith({
      readRepoVariableValue: async () => {
        throw new Error('gh api boom');
      },
    });

    const result = await reconcileTrustedActors('desired[bot]', ['a/repo'], deps);

    expect(result['a/repo']?.status).toBe('skipped');
  });

  it('a mix of one unreadable + one diverging repo: the unreadable one is skipped and EXCLUDED from the batch shown for the diverging one', async () => {
    let confirmedWith: readonly TrustedActorsDivergence[] | undefined;
    const deps = depsWith({
      readRepoVariableValue: async (repo) => (repo === 'unreadable/repo' ? undefined : 'old[bot]'),
      confirmReconciliation: async (divergences) => {
        confirmedWith = divergences;
        return true;
      },
    });

    const result = await reconcileTrustedActors('new[bot]', ['unreadable/repo', 'diverging/repo'], deps);

    expect(result['unreadable/repo']?.status).toBe('skipped');
    expect(result['diverging/repo']?.status).toBe('updated');
    expect(confirmedWith).toEqual([{ repo: 'diverging/repo', observedValue: 'old[bot]', desiredValue: 'new[bot]' }]);
  });
});

describe('reconcileTrustedActors — declined confirmation writes nothing', () => {
  it('a declined confirmation reports every divergent repo as declined, and updateRepoVariable is NEVER called for any of them', async () => {
    let updateCalled = false;
    const deps = depsWith({
      readRepoVariableValue: async (repo) => `old-${repo}[bot]`,
      confirmReconciliation: async () => false,
      updateRepoVariable: async () => {
        updateCalled = true;
        return 'updated';
      },
    });

    const result = await reconcileTrustedActors('new[bot]', ['a/repo', 'b/repo'], deps);

    expect(result['a/repo']?.status).toBe('declined');
    expect(result['b/repo']?.status).toBe('declined');
    expect(updateCalled).toBe(false);
  });

  it('a confirmation callback that THROWS fails closed — declines, never writes (fail-closed, not fail-open)', async () => {
    let updateCalled = false;
    const deps = depsWith({
      readRepoVariableValue: async () => 'old[bot]',
      confirmReconciliation: async () => {
        throw new Error('operator prompt boom');
      },
      updateRepoVariable: async () => {
        updateCalled = true;
        return 'updated';
      },
    });

    const result = await reconcileTrustedActors('new[bot]', ['a/repo'], deps);

    expect(result['a/repo']?.status).toBe('declined');
    expect(updateCalled).toBe(false);
  });
});

describe('reconcileTrustedActors — optional deps, race, and write-failure handling', () => {
  it('every optional dep omitted degrades to a full no-op ({}) — never a crash, never a write', async () => {
    const result = await reconcileTrustedActors('new[bot]', ['a/repo'], {});
    expect(result).toEqual({});
  });

  it('a write that reports the variable vanished (race between read and write) is "failed", never guessed at', async () => {
    const deps = depsWith({
      readRepoVariableValue: async () => 'old[bot]',
      updateRepoVariable: async () => 'absent',
    });

    const result = await reconcileTrustedActors('new[bot]', ['a/repo'], deps);

    expect(result['a/repo']?.status).toBe('failed');
  });

  it('a write that throws is "failed", isolated to that one repo', async () => {
    const deps = depsWith({
      readRepoVariableValue: async () => 'old[bot]',
      updateRepoVariable: async () => {
        throw new Error('gh api boom');
      },
    });

    const result = await reconcileTrustedActors('new[bot]', ['a/repo'], deps);

    expect(result['a/repo']?.status).toBe('failed');
  });

  it('an empty presentRepos list is a pure no-op — no confirmation call, no reads', async () => {
    let confirmCalled = false;
    const deps = depsWith({
      confirmReconciliation: async () => {
        confirmCalled = true;
        return true;
      },
    });

    const result = await reconcileTrustedActors('new[bot]', [], deps);

    expect(result).toEqual({});
    expect(confirmCalled).toBe(false);
  });
});
