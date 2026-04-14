import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process execFile (safe — no shell injection)
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const { execFile: mockExecFile } = await import('node:child_process');
const { checkIssues } = await import('../../../src/plugin/lib/work.js');

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
});
