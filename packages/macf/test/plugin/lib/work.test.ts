import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process execFile (safe — no shell injection)
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const { execFile: mockExecFile } = await import('node:child_process');
const {
  checkIssues,
  checkIssuesAcrossFleet,
  searchInvolvesIssues,
  checkAllPendingWork,
  resolveSelfLogin,
} = await import('../../../src/plugin/lib/work.js');

describe('checkIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed issues from gh CLI', async () => {
    const issues = [
      { number: 11, title: 'P1 Channel Server' },
      { number: 19, title: 'P2 Registration' },
    ];

    vi.mocked(mockExecFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        if (cb) cb(null, { stdout: JSON.stringify(issues), stderr: '' });
        return {} as any;
      },
    );

    const result = await checkIssues({
      repo: 'groundnuty/macf',
      label: 'code-agent',
      token: 'test-token',
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.number).toBe(11);
  });

  it('returns empty array on gh failure', async () => {
    vi.mocked(mockExecFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        if (cb) cb(new Error('gh not found'), { stdout: '', stderr: '' });
        return {} as any;
      },
    );

    const result = await checkIssues({
      repo: 'groundnuty/macf',
      label: 'code-agent',
      token: 'test-token',
    });

    expect(result).toHaveLength(0);
  });

  it('tags each returned issue with its source repo', async () => {
    vi.mocked(mockExecFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        if (cb) cb(null, { stdout: JSON.stringify([{ number: 11, title: 'P1' }]), stderr: '' });
        return {} as any;
      },
    );

    const result = await checkIssues({
      repo: 'groundnuty/macf',
      label: 'code-agent',
      token: 'test-token',
    });

    expect(result).toEqual([{ number: 11, title: 'P1', repo: 'groundnuty/macf' }]);
  });
});

// DR-038 Decision 7: the queue-source is {App install-set} x {agent label},
// complete by construction — not a single hardcoded/configured repo.
describe('checkIssuesAcrossFleet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spans every repo in the App install-set, joined with the label', async () => {
    const repoArg: string[] = [];
    const labelArg: string[] = [];

    const result = await checkIssuesAcrossFleet({
      label: 'code-agent',
      token: 'test-token',
      listInstallRepos: async () => ['org/repo-a', 'org/repo-b'],
      checkOneRepo: async (repo, label) => {
        repoArg.push(repo);
        labelArg.push(label);
        return [{ number: repo === 'org/repo-a' ? 1 : 2, title: `issue in ${repo}`, repo }];
      },
    });

    expect(repoArg.sort()).toEqual(['org/repo-a', 'org/repo-b']);
    expect(labelArg).toEqual(['code-agent', 'code-agent']);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ number: 1, title: 'issue in org/repo-a', repo: 'org/repo-a' });
    expect(result).toContainEqual({ number: 2, title: 'issue in org/repo-b', repo: 'org/repo-b' });
  });

  it('is fail-soft: one repo erroring does not blank the others (aggregates reachable)', async () => {
    const result = await checkIssuesAcrossFleet({
      label: 'code-agent',
      token: 'test-token',
      listInstallRepos: async () => ['org/broken-repo', 'org/good-repo'],
      checkOneRepo: async (repo) => {
        if (repo === 'org/broken-repo') throw new Error('API 404: repo access revoked');
        return [{ number: 5, title: 'still reachable', repo }];
      },
    });

    expect(result).toEqual([{ number: 5, title: 'still reachable', repo: 'org/good-repo' }]);
  });

  it('returns empty when the App has no installed repos (no throw)', async () => {
    const result = await checkIssuesAcrossFleet({
      label: 'code-agent',
      token: 'test-token',
      listInstallRepos: async () => [],
    });

    expect(result).toEqual([]);
  });

  it('dedups repeated repo+number pairs', async () => {
    const result = await checkIssuesAcrossFleet({
      label: 'code-agent',
      token: 'test-token',
      listInstallRepos: async () => ['org/repo-a', 'org/repo-a'],
      checkOneRepo: async (repo) => [{ number: 1, title: 'dup', repo }],
    });

    expect(result).toEqual([{ number: 1, title: 'dup', repo: 'org/repo-a' }]);
  });

  it('single-install App behaves like the old single-repo checkIssues call (real wiring)', async () => {
    // Exercise the REAL default listInstallRepos (createInstallRepoLister) +
    // the REAL default checkOneRepo (checkIssues) end-to-end, distinguishing
    // the two `gh` shapes by args — proves the two real primitives compose
    // correctly, not just the injected-fake path above.
    vi.mocked(mockExecFile).mockImplementation(
      (_cmd: any, args: any, _opts: any, cb: any) => {
        if (args.includes('/installation/repositories')) {
          cb(null, { stdout: 'groundnuty/macf\n', stderr: '' });
        } else {
          cb(null, {
            stdout: JSON.stringify([
              { number: 11, title: 'P1 Channel Server' },
              { number: 19, title: 'P2 Registration' },
            ]),
            stderr: '',
          });
        }
        return {} as any;
      },
    );

    const result = await checkIssuesAcrossFleet({ label: 'code-agent', token: 'test-token' });

    expect(result).toEqual([
      { number: 11, title: 'P1 Channel Server', repo: 'groundnuty/macf' },
      { number: 19, title: 'P2 Registration', repo: 'groundnuty/macf' },
    ]);
  });
});

// macf#816: dynamic, non-hardwired identity resolution for the `involves:`
// search leg.
describe('resolveSelfLogin', () => {
  it('composes <project>-<name> from MACF_PROJECT + MACF_AGENT_NAME', () => {
    expect(
      resolveSelfLogin({ MACF_PROJECT: 'macf', MACF_AGENT_NAME: 'code-agent' }),
    ).toBe('macf-code-agent');
  });

  it('composes correctly for a non-macf consumer fleet project', () => {
    expect(
      resolveSelfLogin({ MACF_PROJECT: 'icsoc-2026', MACF_AGENT_NAME: 'code-agent' }),
    ).toBe('icsoc-2026-code-agent');
  });

  it('never appends [bot] — that is searchInvolvesIssues\' job alone', () => {
    const login = resolveSelfLogin({ MACF_PROJECT: 'macf', MACF_AGENT_NAME: 'code-agent' });
    expect(login).not.toContain('[bot]');
  });

  it('returns undefined when MACF_PROJECT is missing (fail-soft, no guess)', () => {
    expect(resolveSelfLogin({ MACF_AGENT_NAME: 'code-agent' })).toBeUndefined();
  });

  it('returns undefined when MACF_AGENT_NAME is missing (fail-soft, no guess)', () => {
    expect(resolveSelfLogin({ MACF_PROJECT: 'macf' })).toBeUndefined();
  });

  it('returns undefined when both are blank/whitespace-only', () => {
    expect(resolveSelfLogin({ MACF_PROJECT: '  ', MACF_AGENT_NAME: '' })).toBeUndefined();
  });

  it('does NOT fall back to the plugin-cli defaulted values (unknown/MACF)', () => {
    // Regression guard: composing from the ?? 'unknown' / ?? 'MACF' locals
    // main() uses for OTHER purposes would silently search a bogus login.
    expect(resolveSelfLogin({})).toBeUndefined();
  });
});

describe('searchInvolvesIssues (macf#816)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps search results to PendingIssue via repository.nameWithOwner', async () => {
    const result = await searchInvolvesIssues({
      selfLogin: 'macf-code-agent',
      token: 'test-token',
      listSearch: async () => [
        { number: 7, title: 'cross-repo issue', repo: 'groundnuty/onedata-mcp' },
      ],
    });

    expect(result).toEqual([
      { number: 7, title: 'cross-repo issue', repo: 'groundnuty/onedata-mcp' },
    ]);
  });

  it('appends [bot] to selfLogin before querying (poison-free — keys on the login, not a label)', async () => {
    const loginSeen: string[] = [];
    await searchInvolvesIssues({
      selfLogin: 'macf-code-agent',
      token: 'test-token',
      listSearch: async (login) => {
        loginSeen.push(login);
        return [];
      },
    });

    expect(loginSeen).toEqual(['macf-code-agent[bot]']);
  });

  it('is fail-soft: a thrown error (rate-limit/5xx/network) resolves to [] without throwing', async () => {
    const result = await searchInvolvesIssues({
      selfLogin: 'macf-code-agent',
      token: 'test-token',
      listSearch: async () => {
        throw new Error('API rate limit exceeded');
      },
    });

    expect(result).toEqual([]);
  });

  it('the default query shape uses --involves (poison-free), never --label', async () => {
    const capturedArgs: unknown[] = [];
    vi.mocked(mockExecFile).mockImplementation(
      (_cmd: any, args: any, _opts: any, cb: any) => {
        capturedArgs.push(args);
        cb(null, { stdout: '[]', stderr: '' });
        return {} as any;
      },
    );

    await searchInvolvesIssues({ selfLogin: 'macf-code-agent', token: 'test-token' });

    expect(capturedArgs).toHaveLength(1);
    const args = capturedArgs[0] as string[];
    expect(args).toContain('--involves');
    expect(args[args.indexOf('--involves') + 1]).toBe('macf-code-agent[bot]');
    expect(args).not.toContain('--label');
  });

  it('the default query maps gh search issues --json output (number,title,repository.nameWithOwner)', async () => {
    vi.mocked(mockExecFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, {
          stdout: JSON.stringify([
            { number: 3, title: 'guest task', repository: { nameWithOwner: 'other-org/other-repo' } },
          ]),
          stderr: '',
        });
        return {} as any;
      },
    );

    const result = await searchInvolvesIssues({ selfLogin: 'macf-code-agent', token: 'test-token' });

    expect(result).toEqual([{ number: 3, title: 'guest task', repo: 'other-org/other-repo' }]);
  });
});

// macf#816: the generic, non-hardwired work-discovery union. The devops
// review criterion was explicit: EITHER leg throwing must not blank the
// OTHER leg's results.
describe('checkAllPendingWork (macf#816)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unions install-set x label with involves, deduped by repo#number', async () => {
    const result = await checkAllPendingWork({
      label: 'code-agent',
      token: 'test-token',
      selfLogin: 'macf-code-agent',
      listInstallRepos: async () => ['groundnuty/macf'],
      checkOneRepo: async (repo) => [{ number: 1, title: 'labeled issue', repo }],
      searchInvolves: async () => [
        { number: 1, title: 'labeled issue', repo: 'groundnuty/macf' }, // same issue, both legs
        { number: 9, title: 'guest-fleet issue', repo: 'other-org/other-repo' },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ number: 1, title: 'labeled issue', repo: 'groundnuty/macf' });
    expect(result).toContainEqual({ number: 9, title: 'guest-fleet issue', repo: 'other-org/other-repo' });
  });

  it('independent fail-soft: involves throwing does not blank the install-set x label results', async () => {
    const result = await checkAllPendingWork({
      label: 'code-agent',
      token: 'test-token',
      selfLogin: 'macf-code-agent',
      listInstallRepos: async () => ['groundnuty/macf'],
      checkOneRepo: async (repo) => [{ number: 1, title: 'still here', repo }],
      searchInvolves: async () => {
        throw new Error('involves search exploded');
      },
    });

    expect(result).toEqual([{ number: 1, title: 'still here', repo: 'groundnuty/macf' }]);
  });

  it('independent fail-soft (vice-versa): install-set leg throwing does not blank the involves results', async () => {
    const result = await checkAllPendingWork({
      label: 'code-agent',
      token: 'test-token',
      selfLogin: 'macf-code-agent',
      // No per-repo try/catch can save this — a custom listInstallRepos that
      // throws propagates out of checkIssuesAcrossFleet uncaught.
      listInstallRepos: async () => {
        throw new Error('installation/repositories 500');
      },
      searchInvolves: async () => [{ number: 9, title: 'still here too', repo: 'other-org/other-repo' }],
    });

    expect(result).toEqual([{ number: 9, title: 'still here too', repo: 'other-org/other-repo' }]);
  });

  it('skips the involves leg entirely when selfLogin is unresolved (no guessed login)', async () => {
    let searchInvolvesCalled = false;
    const result = await checkAllPendingWork({
      label: 'code-agent',
      token: 'test-token',
      // selfLogin omitted — matches resolveSelfLogin() returning undefined.
      listInstallRepos: async () => ['groundnuty/macf'],
      checkOneRepo: async (repo) => [{ number: 1, title: 'basis-only', repo }],
      searchInvolves: async () => {
        searchInvolvesCalled = true;
        return [{ number: 99, title: 'should not appear', repo: 'x/y' }];
      },
    });

    expect(searchInvolvesCalled).toBe(false);
    expect(result).toEqual([{ number: 1, title: 'basis-only', repo: 'groundnuty/macf' }]);
  });

  it('returns [] when both legs are empty', async () => {
    const result = await checkAllPendingWork({
      label: 'code-agent',
      token: 'test-token',
      selfLogin: 'macf-code-agent',
      listInstallRepos: async () => [],
      searchInvolves: async () => [],
    });

    expect(result).toEqual([]);
  });
});
