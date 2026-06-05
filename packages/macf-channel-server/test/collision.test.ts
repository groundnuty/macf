import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Registry, AgentInfo } from '@groundnuty/macf-core';
import type { Logger } from '@groundnuty/macf-core';

// Mock node:https request to avoid real network calls
vi.mock('node:https', () => ({
  request: vi.fn(),
}));

// Mock node:fs readFileSync for cert loading
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue(Buffer.from('mock-cert')),
  };
});

const { request: mockRequest } = await import('node:https');
const { checkCollision } = await import('../src/collision.js');

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockRegistry(getResult: AgentInfo | null = null): Registry {
  return {
    register: vi.fn(),
    get: vi.fn().mockResolvedValue(getResult),
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
  };
}

const certPaths = {
  caCertPath: '/fake/ca.pem',
  agentCertPath: '/fake/agent.pem',
  agentKeyPath: '/fake/agent-key.pem',
};

const INCOMING = '0.2.34'; // this instance's version in most tests

const existingAgent: AgentInfo = {
  host: '100.86.5.117',
  port: 8847,
  type: 'permanent',
  instance_id: 'a8f3c2',
  started: '2026-03-28T18:00:00Z',
};

/**
 * Mock a LIVE /health response (200) whose JSON body advertises `version`
 * (omitted entirely when `version === null`, simulating a pre-#424 instance).
 * Wires res.on('data')/on('end') so collision's pingHealth reads the body.
 */
function mockAliveWithVersion(version: string | null): void {
  vi.mocked(mockRequest).mockImplementation((_opts, cb) => {
    const bodyObj = version === null ? { status: 'online' } : { status: 'online', version };
    const bodyStr = JSON.stringify(bodyObj);
    const mockRes = {
      statusCode: 200,
      resume: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === 'data') handler(Buffer.from(bodyStr));
        if (event === 'end') handler();
        return mockRes;
      }),
    };
    if (cb) (cb as (res: typeof mockRes) => void)(mockRes);
    return { on: vi.fn(), end: vi.fn(), destroy: vi.fn() } as any;
  });
}

/** Mock a dead peer (connection error on end()). */
function mockDead(): void {
  vi.mocked(mockRequest).mockImplementation((_opts, _cb) => {
    const handlers: Record<string, (...args: any[]) => void> = {};
    const req = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers[event] = handler;
        return req;
      }),
      end: vi.fn(() => {
        if (handlers['error']) handlers['error'](new Error('ECONNREFUSED'));
      }),
      destroy: vi.fn(),
    };
    return req as any;
  });
}

/** Find the warn-level collision_check log basis (the #424 decision). */
function decisionBasis(logger: Logger): string | undefined {
  const warn = vi.mocked(logger.warn);
  const call = warn.mock.calls.find((c) => c[0] === 'collision_check');
  return call ? (call[1] as { result?: string }).result : undefined;
}

describe('checkCollision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['MACF_NO_VERSION_TAKEOVER'];
  });

  it('returns register for fresh start (no variable)', async () => {
    const registry = mockRegistry(null);
    const result = await checkCollision('code-agent', registry, certPaths, INCOMING, mockLogger());
    expect(result.action).toBe('register');
    expect(registry.get).toHaveBeenCalledWith('code-agent');
  });

  describe('dead / unreachable existing → takeover (unchanged)', () => {
    it('takeover when existing agent does not respond', async () => {
      mockDead();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, INCOMING, mockLogger());
      expect(result.action).toBe('takeover');
      if (result.action === 'takeover') expect(result.previous.instance_id).toBe('a8f3c2');
    });

    it('takeover when readFileSync throws (cert-rotation race, ultrareview H3)', async () => {
      const fs = await import('node:fs');
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      });
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, INCOMING, mockLogger());
      expect(result.action).toBe('takeover');
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('takeover when health ping times out', async () => {
      vi.mocked(mockRequest).mockImplementation((_opts, _cb) => {
        const handlers: Record<string, (...args: any[]) => void> = {};
        const req = {
          on: vi.fn((event: string, handler: (...args: any[]) => void) => { handlers[event] = handler; return req; }),
          end: vi.fn(() => { if (handlers['timeout']) handlers['timeout'](); }),
          destroy: vi.fn(),
        };
        return req as any;
      });
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, INCOMING, mockLogger());
      expect(result.action).toBe('takeover');
    });
  });

  describe('alive existing → version-aware decision (groundnuty/macf#424)', () => {
    it('aborts when the alive peer runs the SAME version', async () => {
      mockAliveWithVersion('0.2.34');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_same_or_newer');
    });

    it('aborts when the alive peer runs a NEWER version', async () => {
      mockAliveWithVersion('0.2.40');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_same_or_newer');
    });

    it('TAKES OVER an alive peer running an OLDER version', async () => {
      mockAliveWithVersion('0.2.20');
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_newer_version');
    });

    it('TAKES OVER an alive peer that advertises NO version (pre-#424 ⟹ oldest) — the motivating incident', async () => {
      mockAliveWithVersion(null);
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('takeover');
      expect(decisionBasis(logger)).toBe('takeover_unversioned_existing');
    });

    it('aborts when the INCOMING is unversioned (never displaces a live peer)', async () => {
      mockAliveWithVersion('0.2.20'); // existing older, but incoming is unversioned
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_incoming_unversioned');
    });

    it('MACF_NO_VERSION_TAKEOVER=1 disables takeover even of an older alive peer (escape hatch)', async () => {
      process.env['MACF_NO_VERSION_TAKEOVER'] = '1';
      mockAliveWithVersion('0.2.20'); // older — would normally be taken over
      const logger = mockLogger();
      const result = await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      expect(result.action).toBe('abort');
      expect(decisionBasis(logger)).toBe('abort_version_takeover_disabled');
    });

    it('reports both versions in the decision log line', async () => {
      mockAliveWithVersion('0.2.20');
      const logger = mockLogger();
      await checkCollision('code-agent', mockRegistry(existingAgent), certPaths, '0.2.34', logger);
      const call = vi.mocked(logger.warn).mock.calls.find((c) => c[0] === 'collision_check');
      expect(call?.[1]).toMatchObject({ incoming_version: '0.2.34', existing_version: '0.2.20' });
    });
  });
});
