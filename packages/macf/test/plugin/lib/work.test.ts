import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process execFile (safe — no shell injection)
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const { execFile: mockExecFile } = await import('node:child_process');
const { checkIssues, checkIssuesAcrossFleet } = await import('../../../src/plugin/lib/work.js');

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
