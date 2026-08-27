import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process execFile (safe — no shell injection), same
// pattern as work.test.ts.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const { execFile: mockExecFile } = await import('node:child_process');
const {
  checkReporterStalls,
  DEFAULT_REPORTER_STALL_DAYS,
  DEFAULT_REPORTER_STALL_LIMIT,
} = await import('../../../src/plugin/lib/reporter-stall.js');

const NOW = Date.parse('2026-08-26T14:17:55Z');
const DAY = 86_400_000;

describe('checkReporterStalls (groundnuty/macf#1170)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Decisive pair #1: an issue I filed, open, untouched for > N days appears.
  it('surfaces an open self-filed issue quiet past the stale threshold', async () => {
    const result = await checkReporterStalls({
      token: 'test-token',
      now: NOW,
      staleDays: 5,
      listInstallRepos: async () => ['org/repo'],
      listOpenAuthored: async () => [
        { number: 1, title: 'stale one', updatedAt: new Date(NOW - 6 * DAY).toISOString() },
      ],
      fetchBodyAndComments: async () => ({ body: '', comments: [] }),
    });

    expect(result.enumerationFailed).toBe(false);
    expect(result.stalls).toHaveLength(1);
    expect(result.stalls[0]).toMatchObject({ repo: 'org/repo', number: 1, title: 'stale one' });
    expect(result.stalls[0]!.daysQuiet).toBeGreaterThanOrEqual(6);
    expect(result.totalStale).toBe(1);
  });

  // Decisive pair #2: an issue I filed, open, active yesterday does NOT appear.
  it('does not surface an issue active within the stale threshold', async () => {
    const result = await checkReporterStalls({
      token: 'test-token',
      now: NOW,
      staleDays: 5,
      listInstallRepos: async () => ['org/repo'],
      listOpenAuthored: async () => [
        { number: 2, title: 'active yesterday', updatedAt: new Date(NOW - 1 * DAY).toISOString() },
      ],
      fetchBodyAndComments: async () => ({ body: '', comments: [] }),
    });

    expect(result.stalls).toHaveLength(0);
  });

  // Per assert-the-wrong-path.md's second trigger: (1) alone is satisfied
  // by listing everything. The unread-repo case is what proves the sweep
  // distinguishes "confirmed nothing stale" from "could not check".
  it('reports an unreadable repo distinctly — never silently omitted as if it were clean', async () => {
    const result = await checkReporterStalls({
      token: 'test-token',
      now: NOW,
      staleDays: 5,
      listInstallRepos: async () => ['org/broken-repo', 'org/good-repo'],
      listOpenAuthored: async (repo) => {
        if (repo === 'org/broken-repo') throw new Error('API 404: repo access revoked');
        return [{ number: 9, title: 'still reachable', updatedAt: new Date(NOW - 10 * DAY).toISOString() }];
      },
      fetchBodyAndComments: async () => ({ body: '', comments: [] }),
    });

    expect(result.unreadableRepos).toEqual(['org/broken-repo']);
    expect(result.stalls).toHaveLength(1);
    expect(result.stalls[0]!.repo).toBe('org/good-repo');
  });

  // A genuinely empty install set does not happen for a live agent (DR-038
  // Decision 7) — an empty enumeration IS a failed enumeration, and must be
  // stated, never rendered identically to a clean sweep.
  it('treats an empty repo enumeration as a failure signal, not "nothing to sweep"', async () => {
    const result = await checkReporterStalls({
      token: 'test-token',
      now: NOW,
      listInstallRepos: async () => [],
    });

    expect(result.enumerationFailed).toBe(true);
    expect(result.stalls).toEqual([]);
    expect(result.unreadableRepos).toEqual([]);
    expect(result.totalStale).toBe(0);
  });

  it('someone else\'s issue is never surfaced — the listing call itself is author-scoped, so the sweep result is exactly whatever listOpenAuthored returns', async () => {
    const result = await checkReporterStalls({
      token: 'test-token',
      now: NOW,
      staleDays: 5,
      listInstallRepos: async () => ['org/repo'],
      // A fake that only ever returns MY issues, proving nothing in
      // checkReporterStalls itself widens the author scope.
      listOpenAuthored: async () => [
        { number: 3, title: 'mine, stale', updatedAt: new Date(NOW - 10 * DAY).toISOString() },
      ],
      fetchBodyAndComments: async () => ({ body: '', comments: [] }),
    });

    expect(result.stalls.map((s) => s.number)).toEqual([3]);
  });

  it('caps rendered stalls at `limit`, ranked by daysQuiet descending (oldest promises first)', async () => {
    const result = await checkReporterStalls({
      token: 'test-token',
      now: NOW,
      staleDays: 5,
      limit: 2,
      listInstallRepos: async () => ['org/repo'],
      listOpenAuthored: async () => [
        { number: 1, title: 'a', updatedAt: new Date(NOW - 6 * DAY).toISOString() },
        { number: 2, title: 'b', updatedAt: new Date(NOW - 20 * DAY).toISOString() },
        { number: 3, title: 'c', updatedAt: new Date(NOW - 10 * DAY).toISOString() },
      ],
      fetchBodyAndComments: async () => ({ body: '', comments: [] }),
    });

    expect(result.stalls).toHaveLength(2);
    expect(result.stalls.map((s) => s.number)).toEqual([2, 3]); // 20d, 10d — NOT 6d
    // macf#1170 "cap it and say what was capped" — totalStale carries the
    // pre-cap candidate count (all 3 qualified) so the render layer can
    // disclose "2 of 3" rather than silently truncating.
    expect(result.totalStale).toBe(3);
  });

  it('fail-soft: a broken repo does not blank the others (aggregates reachable, like the inbound sweep)', async () => {
    const result = await checkReporterStalls({
      token: 'test-token',
      now: NOW,
      staleDays: 5,
      listInstallRepos: async () => ['org/a', 'org/b', 'org/c'],
      listOpenAuthored: async (repo) => {
        if (repo === 'org/b') throw new Error('rate limited');
        return [{ number: 1, title: `in ${repo}`, updatedAt: new Date(NOW - 10 * DAY).toISOString() }];
      },
      fetchBodyAndComments: async () => ({ body: '', comments: [] }),
    });

    expect(result.unreadableRepos).toEqual(['org/b']);
    expect(result.stalls.map((s) => s.repo).sort()).toEqual(['org/a', 'org/c']);
  });

  describe('deferral verdict vs reminder (amendment 1)', () => {
    it('upgrades to a VERDICT when a deferral reference is found and resolves CLOSED', async () => {
      const result = await checkReporterStalls({
        token: 'test-token',
        now: NOW,
        staleDays: 5,
        listInstallRepos: async () => ['org/repo'],
        listOpenAuthored: async () => [
          { number: 1, title: 'deferred', updatedAt: new Date(NOW - 8 * DAY).toISOString() },
        ],
        fetchBodyAndComments: async () => ({
          body: 'This sits behind that, and behind #932 (a real prerequisite).',
          comments: [],
        }),
        resolveRefState: async (repo, number) => {
          expect(repo).toBe('org/repo');
          expect(number).toBe(932);
          return { state: 'CLOSED', closedAt: '2026-08-17T00:00:00Z' };
        },
      });

      expect(result.stalls[0]!.clearedRef).toEqual({ ref: '#932', closedAt: '2026-08-17T00:00:00Z' });
    });

    it('stays a REMINDER (no verdict) when the deferral reference is still OPEN', async () => {
      const result = await checkReporterStalls({
        token: 'test-token',
        now: NOW,
        staleDays: 5,
        listInstallRepos: async () => ['org/repo'],
        listOpenAuthored: async () => [
          { number: 1, title: 'deferred', updatedAt: new Date(NOW - 8 * DAY).toISOString() },
        ],
        fetchBodyAndComments: async () => ({ body: 'blocked on #55 for now.', comments: [] }),
        resolveRefState: async () => ({ state: 'OPEN' }),
      });

      expect(result.stalls[0]!.clearedRef).toBeUndefined();
    });

    it('stays a REMINDER — never a false verdict — when the deferral is prose with no number', async () => {
      const result = await checkReporterStalls({
        token: 'test-token',
        now: NOW,
        staleDays: 5,
        listInstallRepos: async () => ['org/repo'],
        listOpenAuthored: async () => [
          { number: 1, title: 'deferred', updatedAt: new Date(NOW - 8 * DAY).toISOString() },
        ],
        fetchBodyAndComments: async () => ({
          body: 'This sits behind the operator\'s live provisioning run.',
          comments: [],
        }),
        resolveRefState: async () => {
          throw new Error('should never be called — no numeric ref to resolve');
        },
      });

      expect(result.stalls[0]!.clearedRef).toBeUndefined();
    });

    it('stays a REMINDER when there is no deferral language at all', async () => {
      const result = await checkReporterStalls({
        token: 'test-token',
        now: NOW,
        staleDays: 5,
        listInstallRepos: async () => ['org/repo'],
        listOpenAuthored: async () => [
          { number: 1, title: 'plain stall', updatedAt: new Date(NOW - 8 * DAY).toISOString() },
        ],
        fetchBodyAndComments: async () => ({ body: 'A perfectly ordinary issue body. Refs #1, #2, #3.', comments: [] }),
      });

      expect(result.stalls[0]!.clearedRef).toBeUndefined();
    });

    it('does NOT treat an ordinary "Refs #N" trailer as a deferral reference (narrow phrase-anchored regex, not a general #N extractor)', async () => {
      const result = await checkReporterStalls({
        token: 'test-token',
        now: NOW,
        staleDays: 5,
        listInstallRepos: async () => ['org/repo'],
        listOpenAuthored: async () => [
          { number: 1, title: 'cites a dozen other issues', updatedAt: new Date(NOW - 8 * DAY).toISOString() },
        ],
        fetchBodyAndComments: async () => ({
          body: 'Refs #1012, #838, #999, #855, #854, #943 — see coordination.md.',
          comments: [],
        }),
        resolveRefState: async () => {
          throw new Error('should never be called — Refs trailers are not deferral phrases');
        },
      });

      expect(result.stalls[0]!.clearedRef).toBeUndefined();
    });

    it('resolves a deferral reference against a comment, most-recent-first', async () => {
      const result = await checkReporterStalls({
        token: 'test-token',
        now: NOW,
        staleDays: 5,
        listInstallRepos: async () => ['org/repo'],
        listOpenAuthored: async () => [
          { number: 1, title: 'deferred in a comment', updatedAt: new Date(NOW - 8 * DAY).toISOString() },
        ],
        fetchBodyAndComments: async () => ({
          body: 'See discussion.',
          comments: [
            { body: 'unrelated early comment' },
            { body: 'Sequencing: this sits behind #932.' },
          ],
        }),
        resolveRefState: async (_repo, number) => (number === 932 ? { state: 'CLOSED' } : undefined),
      });

      expect(result.stalls[0]!.clearedRef).toEqual({ ref: '#932' });
    });

    it('formats a cross-repo deferral reference as owner/repo#N', async () => {
      const result = await checkReporterStalls({
        token: 'test-token',
        now: NOW,
        staleDays: 5,
        listInstallRepos: async () => ['groundnuty/macf'],
        listOpenAuthored: async () => [
          { number: 1, title: 'cross-repo deferral', updatedAt: new Date(NOW - 8 * DAY).toISOString() },
        ],
        fetchBodyAndComments: async () => ({
          body: 'gated on groundnuty/macf-actions#57 landing first.',
          comments: [],
        }),
        resolveRefState: async (repo, number) => {
          expect(repo).toBe('groundnuty/macf-actions');
          expect(number).toBe(57);
          return { state: 'CLOSED' };
        },
      });

      expect(result.stalls[0]!.clearedRef).toEqual({ ref: 'groundnuty/macf-actions#57' });
    });

    it('a deep-fetch failure (fetchBodyAndComments throws) does not drop the stall — only the verdict enrichment is lost', async () => {
      const result = await checkReporterStalls({
        token: 'test-token',
        now: NOW,
        staleDays: 5,
        listInstallRepos: async () => ['org/repo'],
        listOpenAuthored: async () => [
          { number: 1, title: 'still a real stall', updatedAt: new Date(NOW - 8 * DAY).toISOString() },
        ],
        fetchBodyAndComments: async () => {
          throw new Error('gh issue view failed');
        },
      });

      expect(result.stalls).toHaveLength(1);
      expect(result.stalls[0]!.number).toBe(1);
      expect(result.stalls[0]!.clearedRef).toBeUndefined();
    });
  });

  describe('default wiring (real gh CLI shape)', () => {
    it('the default listOpenAuthored uses --author @me, matching the issue\'s own proposed query', async () => {
      const capturedArgs: unknown[] = [];
      vi.mocked(mockExecFile).mockImplementation(
        (_cmd: any, args: any, _opts: any, cb: any) => {
          capturedArgs.push(args);
          if (args.includes('/installation/repositories')) {
            cb(null, { stdout: 'groundnuty/macf\n', stderr: '' });
          } else if (args.includes('list')) {
            cb(null, { stdout: '[]', stderr: '' });
          } else {
            cb(null, { stdout: '{}', stderr: '' });
          }
          return {} as any;
        },
      );

      await checkReporterStalls({ token: 'test-token', now: NOW });

      const listArgs = capturedArgs.find((a) => (a as string[]).includes('list')) as string[];
      expect(listArgs).toContain('--author');
      expect(listArgs[listArgs.indexOf('--author') + 1]).toBe('@me');
      expect(listArgs).toContain('--state');
      expect(listArgs[listArgs.indexOf('--state') + 1]).toBe('open');
      expect(listArgs).not.toContain('--label');
    });
  });

  it('DEFAULT_REPORTER_STALL_DAYS / DEFAULT_REPORTER_STALL_LIMIT are used when config omits them', async () => {
    expect(DEFAULT_REPORTER_STALL_DAYS).toBeGreaterThan(0);
    expect(DEFAULT_REPORTER_STALL_LIMIT).toBeGreaterThan(0);

    const result = await checkReporterStalls({
      token: 'test-token',
      now: NOW,
      listInstallRepos: async () => ['org/repo'],
      listOpenAuthored: async () => [
        {
          number: 1,
          title: 'exactly at default threshold',
          updatedAt: new Date(NOW - (DEFAULT_REPORTER_STALL_DAYS + 1) * DAY).toISOString(),
        },
      ],
      fetchBodyAndComments: async () => ({ body: '', comments: [] }),
    });

    expect(result.stalls).toHaveLength(1);
  });
});
