import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Registry, AgentInfo } from '../src/registry/types.js';
import type { Logger } from '../src/types.js';

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

const existingAgent: AgentInfo = {
  host: '100.86.5.117',
  port: 8847,
  type: 'permanent',
  instance_id: 'a8f3c2',
  started: '2026-03-28T18:00:00Z',
};

describe('checkCollision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns register for fresh start (no variable)', async () => {
    const registry = mockRegistry(null);
    const logger = mockLogger();

    const result = await checkCollision('code-agent', registry, certPaths, logger);

    expect(result.action).toBe('register');
    expect(registry.get).toHaveBeenCalledWith('code-agent');
  });

  it('returns abort when existing agent responds to health ping', async () => {
    const registry = mockRegistry(existingAgent);
    const logger = mockLogger();

    // Simulate successful health response
    vi.mocked(mockRequest).mockImplementation((_opts, cb) => {
      const mockRes = {
        statusCode: 200,
        resume: vi.fn(),
      };
      if (cb) (cb as (res: typeof mockRes) => void)(mockRes);
      return {
        on: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as any;
    });

    const result = await checkCollision('code-agent', registry, certPaths, logger);

    expect(result.action).toBe('abort');
    if (result.action === 'abort') {
      expect(result.existing.host).toBe('100.86.5.117');
      expect(result.existing.port).toBe(8847);
    }
  });

  it('returns takeover when existing agent does not respond', async () => {
    const registry = mockRegistry(existingAgent);
    const logger = mockLogger();

    // Simulate connection error (agent is dead)
    vi.mocked(mockRequest).mockImplementation((_opts, _cb) => {
      const handlers: Record<string, (...args: any[]) => void> = {};
      const req = {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return req;
        }),
        end: vi.fn(() => {
          // Trigger error after end() is called
          if (handlers['error']) handlers['error'](new Error('ECONNREFUSED'));
        }),
        destroy: vi.fn(),
      };
      return req as any;
    });

    const result = await checkCollision('code-agent', registry, certPaths, logger);

    expect(result.action).toBe('takeover');
    if (result.action === 'takeover') {
      expect(result.previous.instance_id).toBe('a8f3c2');
    }
  });

  it('returns takeover when readFileSync throws (cert-rotation race, ultrareview H3)', async () => {
    // During a cert-rotation race at startup, the agent cert/key
    // files may be momentarily absent. Without the ENOENT guard,
    // pingHealth's top-of-function readFileSync would throw and
    // crash the entire server startup via unhandled rejection.
    // The guard treats read errors like network errors — peer is
    // effectively unreachable → takeover path.
    const registry = mockRegistry(existingAgent);
    const logger = mockLogger();

    // Make readFileSync throw on ANY file read (simulates the race).
    const fs = await import('node:fs');
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });

    const result = await checkCollision('code-agent', registry, certPaths, logger);

    // Without the guard, this test would throw. With the guard,
    // pingHealth returns false → takeover.
    expect(result.action).toBe('takeover');
    // request was never made — we bailed before the https.request call.
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('returns takeover when health ping times out', async () => {
    const registry = mockRegistry(existingAgent);
    const logger = mockLogger();

    // Simulate timeout
    vi.mocked(mockRequest).mockImplementation((_opts, _cb) => {
      const handlers: Record<string, (...args: any[]) => void> = {};
      const req = {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          handlers[event] = handler;
          return req;
        }),
        end: vi.fn(() => {
          if (handlers['timeout']) handlers['timeout']();
        }),
        destroy: vi.fn(),
      };
      return req as any;
    });

    const result = await checkCollision('code-agent', registry, certPaths, logger);

    expect(result.action).toBe('takeover');
  });
});
