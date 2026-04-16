import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerShutdownHandler } from '../src/shutdown.js';
import type { Registry } from '../src/registry/types.js';
import type { HttpsServer, Logger } from '../src/types.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockRegistry(): Registry {
  return {
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function mockServer(): HttpsServer {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('registerShutdownHandler', () => {
  let processOnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
  });

  it('registers SIGTERM and SIGINT handlers', () => {
    registerShutdownHandler({
      agentName: 'test-agent',
      registry: mockRegistry(),
      httpsServer: mockServer(),
      logger: mockLogger(),
    });

    const events = processOnSpy.mock.calls.map(c => c[0]);
    expect(events).toContain('SIGTERM');
    expect(events).toContain('SIGINT');
  });

  it('cleanup removes variable and stops server', async () => {
    const registry = mockRegistry();
    const server = mockServer();
    const logger = mockLogger();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      httpsServer: server,
      logger,
    });

    await cleanup();

    expect(registry.remove).toHaveBeenCalledWith('test-agent');
    expect(server.stop).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.info).mock.calls.map(c => c[0])).toContain('shutdown_complete');
  });

  it('cleanup is idempotent', async () => {
    const registry = mockRegistry();
    const server = mockServer();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      httpsServer: server,
      logger: mockLogger(),
    });

    await cleanup();
    await cleanup();

    expect(registry.remove).toHaveBeenCalledOnce();
    expect(server.stop).toHaveBeenCalledOnce();
  });

  it('logs error but continues if registry remove fails', async () => {
    const registry = mockRegistry();
    vi.mocked(registry.remove).mockRejectedValueOnce(new Error('API error'));
    const server = mockServer();
    const logger = mockLogger();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      httpsServer: server,
      logger,
    });

    await cleanup();

    // Server stop should still be called despite registry error
    expect(server.stop).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'shutdown_deregister_failed',
      expect.objectContaining({ error: 'API error' }),
    );
  });

  it('logs error if server stop fails', async () => {
    const registry = mockRegistry();
    const server = mockServer();
    vi.mocked(server.stop).mockRejectedValueOnce(new Error('stop failed'));
    const logger = mockLogger();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      httpsServer: server,
      logger,
    });

    await cleanup();

    expect(logger.error).toHaveBeenCalledWith(
      'shutdown_server_stop_failed',
      expect.objectContaining({ error: 'stop failed' }),
    );
  });

  describe('exit code on cleanup failure (#103 R2)', () => {
    // Pre-#103: SIGTERM handler unconditionally called process.exit(0)
    // even when registry.remove or httpsServer.stop threw. External
    // monitors (systemd, macf-actions heartbeat) saw clean exit and
    // never surfaced the degraded state (stale registry variable
    // claiming the agent was still up).
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(
        (() => { /* noop */ }) as never,
      );
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('cleanup() returns true on clean shutdown', async () => {
      const cleanup = registerShutdownHandler({
        agentName: 'agent',
        registry: mockRegistry(),
        httpsServer: mockServer(),
        logger: mockLogger(),
      });

      const result = await cleanup();
      expect(result).toBe(true);
    });

    it('cleanup() returns false when registry.remove throws', async () => {
      const registry = mockRegistry();
      vi.mocked(registry.remove).mockRejectedValueOnce(new Error('api error'));

      const cleanup = registerShutdownHandler({
        agentName: 'agent',
        registry,
        httpsServer: mockServer(),
        logger: mockLogger(),
      });

      const result = await cleanup();
      expect(result).toBe(false);
    });

    it('cleanup() returns false when server.stop throws', async () => {
      const server = mockServer();
      vi.mocked(server.stop).mockRejectedValueOnce(new Error('stop error'));

      const cleanup = registerShutdownHandler({
        agentName: 'agent',
        registry: mockRegistry(),
        httpsServer: server,
        logger: mockLogger(),
      });

      const result = await cleanup();
      expect(result).toBe(false);
    });

    it('SIGTERM handler exits non-zero when cleanup fails', async () => {
      const registry = mockRegistry();
      vi.mocked(registry.remove).mockRejectedValueOnce(new Error('api error'));

      registerShutdownHandler({
        agentName: 'agent',
        registry,
        httpsServer: mockServer(),
        logger: mockLogger(),
      });

      // Extract the handler wired by process.on('SIGTERM', ...)
      const sigtermCall = processOnSpy.mock.calls.find(c => c[0] === 'SIGTERM')!;
      const handler = sigtermCall[1] as () => void;
      handler();

      // Wait for the async cleanup chain to flush.
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('SIGTERM handler exits 0 on clean shutdown', async () => {
      registerShutdownHandler({
        agentName: 'agent',
        registry: mockRegistry(),
        httpsServer: mockServer(),
        logger: mockLogger(),
      });

      const sigtermCall = processOnSpy.mock.calls.find(c => c[0] === 'SIGTERM')!;
      const handler = sigtermCall[1] as () => void;
      handler();

      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
