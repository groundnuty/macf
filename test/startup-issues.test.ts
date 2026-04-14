import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '../src/types.js';

// Mock node:child_process execFile (we use execFile, not exec — safe from injection)
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const { execFile: mockExecFile } = await import('node:child_process');
const { checkPendingIssues } = await import('../src/startup-issues.js');

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('checkPendingIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pushes startup_check notification when issues found', async () => {
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

    const onNotify = vi.fn().mockResolvedValue(undefined);
    const logger = mockLogger();

    await checkPendingIssues({
      repo: 'groundnuty/macf',
      agentLabel: 'code-agent',
      token: 'test-token',
      onNotify,
      logger,
    });

    expect(onNotify).toHaveBeenCalledOnce();
    const payload = onNotify.mock.calls[0]![0];
    expect(payload.type).toBe('startup_check');
    expect(payload.message).toContain('#11');
    expect(payload.message).toContain('#19');
    expect(payload.issue_number).toBe(11);
  });

  it('does nothing when no issues found', async () => {
    vi.mocked(mockExecFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        if (cb) cb(null, { stdout: '[]', stderr: '' });
        return {} as any;
      },
    );

    const onNotify = vi.fn();
    const logger = mockLogger();

    await checkPendingIssues({
      repo: 'groundnuty/macf',
      agentLabel: 'code-agent',
      token: 'test-token',
      onNotify,
      logger,
    });

    expect(onNotify).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('startup_issues_none', expect.anything());
  });

  it('warns and continues when gh command fails', async () => {
    vi.mocked(mockExecFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        if (cb) cb(new Error('gh not found'), { stdout: '', stderr: '' });
        return {} as any;
      },
    );

    const onNotify = vi.fn();
    const logger = mockLogger();

    await checkPendingIssues({
      repo: 'groundnuty/macf',
      agentLabel: 'code-agent',
      token: 'test-token',
      onNotify,
      logger,
    });

    expect(onNotify).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'startup_issues_check_failed',
      expect.objectContaining({ error: 'gh not found' }),
    );
  });
});
