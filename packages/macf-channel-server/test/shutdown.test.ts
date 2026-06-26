import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerShutdownHandler } from '../src/shutdown.js';
import type { Registry, DeregisterResult } from '@groundnuty/macf-core';
import type { HttpsServer, Logger } from '@groundnuty/macf-core';

// This instance's registered instance_id. The graceful-shutdown deregister is
// guarded on it (DR-031, groundnuty/macf#553 root-cause): the slot is deleted
// ONLY when it still carries this id.
const INSTANCE_ID = 'inst-abc123';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockRegistry(
  deregResult: DeregisterResult = { deregistered: true, reason: 'deleted' },
): Registry {
  return {
    register: vi.fn(),
    registerConditional: vi.fn(),
    deregisterConditional: vi.fn().mockResolvedValue(deregResult),
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

function infoEvents(logger: Logger): string[] {
  return vi.mocked(logger.info).mock.calls.map(c => c[0] as string);
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
      instanceId: INSTANCE_ID,
      httpsServer: mockServer(),
      logger: mockLogger(),
    });

    const events = processOnSpy.mock.calls.map(c => c[0]);
    expect(events).toContain('SIGTERM');
    expect(events).toContain('SIGINT');
  });

  it('cleanup deregisters the slot (key + instance_id) and stops server', async () => {
    const registry = mockRegistry();
    const server = mockServer();
    const logger = mockLogger();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      instanceId: INSTANCE_ID,
      httpsServer: server,
      logger,
    });

    await cleanup();

    // The load-bearing guard: deregister is called with our key AND our
    // instance_id — the registry decides whether the slot is still ours.
    expect(registry.deregisterConditional).toHaveBeenCalledWith('test-agent', INSTANCE_ID);
    // remove() (the unconditional delete) is NOT used anymore.
    expect(registry.remove).not.toHaveBeenCalled();
    expect(server.stop).toHaveBeenCalledOnce();
    expect(infoEvents(logger)).toContain('shutdown_deregistered');
    expect(infoEvents(logger)).toContain('shutdown_complete');
  });

  it('cleanup is idempotent', async () => {
    const registry = mockRegistry();
    const server = mockServer();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      instanceId: INSTANCE_ID,
      httpsServer: server,
      logger: mockLogger(),
    });

    await cleanup();
    await cleanup();

    expect(registry.deregisterConditional).toHaveBeenCalledOnce();
    expect(server.stop).toHaveBeenCalledOnce();
  });

  it('leaves a newer instance\'s slot intact (not-ours) — skipped, not a failure', async () => {
    // Inverse-of-#553 guard: a newer instance took over our slot (#424) while we
    // ran. deregisterConditional reports not-ours → we must NOT clobber it, and
    // it is NOT a shutdown failure.
    const registry = mockRegistry({ deregistered: false, reason: 'not-ours' });
    const server = mockServer();
    const logger = mockLogger();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      instanceId: INSTANCE_ID,
      httpsServer: server,
      logger,
    });

    const ok = await cleanup();

    expect(ok).toBe(true); // not-ours is a clean outcome
    expect(server.stop).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      'shutdown_deregister_skipped',
      expect.objectContaining({ reason: 'not-ours', instance_id: INSTANCE_ID }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('treats an already-absent slot as a clean no-op (skipped)', async () => {
    const registry = mockRegistry({ deregistered: false, reason: 'absent' });
    const server = mockServer();
    const logger = mockLogger();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      instanceId: INSTANCE_ID,
      httpsServer: server,
      logger,
    });

    const ok = await cleanup();

    expect(ok).toBe(true);
    expect(server.stop).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      'shutdown_deregister_skipped',
      expect.objectContaining({ reason: 'absent' }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs error but continues when deregister reports an error result', async () => {
    const registry = mockRegistry({ deregistered: false, reason: 'error' });
    const server = mockServer();
    const logger = mockLogger();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      instanceId: INSTANCE_ID,
      httpsServer: server,
      logger,
    });

    await cleanup();

    // Server stop should still be called despite the deregister error.
    expect(server.stop).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'shutdown_deregister_failed',
      expect.objectContaining({ reason: 'error', instance_id: INSTANCE_ID }),
    );
  });

  it('swallows a thrown deregister error (best-effort, never crashes shutdown)', async () => {
    // deregisterConditional is contracted never to throw, but the handler guards
    // it defensively so a future contract slip can't crash shutdown.
    const registry = mockRegistry();
    vi.mocked(registry.deregisterConditional).mockRejectedValueOnce(new Error('boom'));
    const server = mockServer();
    const logger = mockLogger();

    const cleanup = registerShutdownHandler({
      agentName: 'test-agent',
      registry,
      instanceId: INSTANCE_ID,
      httpsServer: server,
      logger,
    });

    await expect(cleanup()).resolves.toBe(false);
    expect(server.stop).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'shutdown_deregister_failed',
      expect.objectContaining({ error: 'boom' }),
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
      instanceId: INSTANCE_ID,
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
    // even when the deregister or httpsServer.stop failed. External
    // monitors (systemd, macf-actions heartbeat) saw clean exit and
    // never surfaced the degraded state (a possibly-stale registry slot
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
        instanceId: INSTANCE_ID,
        httpsServer: mockServer(),
        logger: mockLogger(),
      });

      const result = await cleanup();
      expect(result).toBe(true);
    });

    it('cleanup() returns false when deregister reports an error', async () => {
      const registry = mockRegistry({ deregistered: false, reason: 'error' });

      const cleanup = registerShutdownHandler({
        agentName: 'agent',
        registry,
        instanceId: INSTANCE_ID,
        httpsServer: mockServer(),
        logger: mockLogger(),
      });

      const result = await cleanup();
      expect(result).toBe(false);
    });

    it('cleanup() returns true when a newer instance owns the slot (not-ours)', async () => {
      // not-ours is the correct outcome, NOT a degraded exit.
      const registry = mockRegistry({ deregistered: false, reason: 'not-ours' });

      const cleanup = registerShutdownHandler({
        agentName: 'agent',
        registry,
        instanceId: INSTANCE_ID,
        httpsServer: mockServer(),
        logger: mockLogger(),
      });

      const result = await cleanup();
      expect(result).toBe(true);
    });

    it('cleanup() returns false when server.stop throws', async () => {
      const server = mockServer();
      vi.mocked(server.stop).mockRejectedValueOnce(new Error('stop error'));

      const cleanup = registerShutdownHandler({
        agentName: 'agent',
        registry: mockRegistry(),
        instanceId: INSTANCE_ID,
        httpsServer: server,
        logger: mockLogger(),
      });

      const result = await cleanup();
      expect(result).toBe(false);
    });

    it('SIGTERM handler exits non-zero when cleanup fails', async () => {
      const registry = mockRegistry({ deregistered: false, reason: 'error' });

      registerShutdownHandler({
        agentName: 'agent',
        registry,
        instanceId: INSTANCE_ID,
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
        instanceId: INSTANCE_ID,
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
