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

  it('pushes one startup_check notification PER queued issue (#103 R1)', async () => {
    // Pre-#103: only the FIRST issue's number was passed to onNotify,
    // so the router never saw the others. Now we emit per-issue so each
    // gets its own routing event.
    const issues = [
      { number: 11, title: 'P1 Channel Server' },
      { number: 19, title: 'P2 Registration' },
      { number: 42, title: 'Third queued issue' },
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

    expect(onNotify).toHaveBeenCalledTimes(3);
    const issueNumbers = onNotify.mock.calls.map(c => c[0].issue_number);
    expect(issueNumbers).toEqual([11, 19, 42]);

    // Each payload carries its own title.
    expect(onNotify.mock.calls[0]![0].title).toBe('P1 Channel Server');
    expect(onNotify.mock.calls[1]![0].title).toBe('P2 Registration');
    expect(onNotify.mock.calls[2]![0].title).toBe('Third queued issue');

    // All payloads still typed as startup_check.
    for (const [payload] of onNotify.mock.calls) {
      expect(payload.type).toBe('startup_check');
      expect(payload.source).toBe('startup');
    }
  });

  it('single-issue case still fires exactly one notification', async () => {
    const issues = [{ number: 7, title: 'Solo' }];

    vi.mocked(mockExecFile).mockImplementation(
      (_cmd: any, _args: any, _opts: any, cb: any) => {
        if (cb) cb(null, { stdout: JSON.stringify(issues), stderr: '' });
        return {} as any;
      },
    );

    const onNotify = vi.fn().mockResolvedValue(undefined);

    await checkPendingIssues({
      repo: 'groundnuty/macf',
      agentLabel: 'code-agent',
      token: 'test-token',
      onNotify,
      logger: mockLogger(),
    });

    expect(onNotify).toHaveBeenCalledOnce();
    expect(onNotify.mock.calls[0]![0].issue_number).toBe(7);
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
