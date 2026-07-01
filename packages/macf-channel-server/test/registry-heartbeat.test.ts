/**
 * Periodic registry heartbeat — DR-031, groundnuty/macf#568.
 *
 * The live instance re-stamps `last_heartbeat` on its OWN registry slot on a
 * coarse interval (default 5 min) so a reader can TTL-judge an aged-out entry
 * dead — the backstop for the UNGRACEFUL death (kill -9 / OOM / power loss) the
 * graceful-deregister (#586) shutdown handler never runs for.
 *
 * Lifecycle MIRRORS `createOtelReachabilityProbe` (health.ts): an unref()'d
 * setInterval, an immediate beat at start(), and an explicit stop() cleared from
 * the shutdown handler. Failures are swallowed (fail-open) and never throw.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createRegistryHeartbeat,
  resolveHeartbeatIntervalMs,
} from '../src/registry-heartbeat.js';
import { DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS } from '@groundnuty/macf-core';
import type { Registry, HeartbeatResult, Logger } from '@groundnuty/macf-core';

const AGENT = 'code-agent';
const INSTANCE_ID = 'inst-abc123';
const NOW = '2026-06-26T12:00:00.000Z';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function mockRegistry(
  hbResult: HeartbeatResult = { beat: true, reason: 'beat' },
): Registry {
  return {
    register: vi.fn(),
    registerConditional: vi.fn(),
    deregisterConditional: vi.fn(),
    heartbeatConditional: vi.fn().mockResolvedValue(hbResult),
    get: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  };
}

describe('resolveHeartbeatIntervalMs', () => {
  it('unset → the default 5-minute cadence', () => {
    expect(resolveHeartbeatIntervalMs(undefined)).toBe(DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS);
  });

  it('empty string → the default cadence', () => {
    expect(resolveHeartbeatIntervalMs('')).toBe(DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS);
  });

  it('"0" → 0 (disabled — the operator escape)', () => {
    expect(resolveHeartbeatIntervalMs('0')).toBe(0);
  });

  it('a positive integer → that value (a deliberate coarse override)', () => {
    expect(resolveHeartbeatIntervalMs('600000')).toBe(600000);
  });

  it('invalid / negative → the default (a typo must not silently disable the backstop)', () => {
    expect(resolveHeartbeatIntervalMs('not-a-number')).toBe(DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS);
    expect(resolveHeartbeatIntervalMs('-1')).toBe(DEFAULT_REGISTRY_HEARTBEAT_INTERVAL_MS);
  });
});

describe('createRegistryHeartbeat', () => {
  it('runOnce re-stamps with the right name + instance_id + now', async () => {
    const registry = mockRegistry();
    const hb = createRegistryHeartbeat({
      registry,
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger: mockLogger(),
      now: () => NOW,
    });

    await hb.runOnce();

    expect(registry.heartbeatConditional).toHaveBeenCalledWith(AGENT, INSTANCE_ID, NOW);
  });

  it('logs registry_heartbeat on a successful beat', async () => {
    const logger = mockLogger();
    const hb = createRegistryHeartbeat({
      registry: mockRegistry({ beat: true, reason: 'beat' }),
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger,
      now: () => NOW,
    });

    await hb.runOnce();

    expect(logger.info).toHaveBeenCalledWith(
      'registry_heartbeat',
      expect.objectContaining({ agent: AGENT, instance_id: INSTANCE_ID }),
    );
  });

  it('warns "displaced" (not a failure) when a newer instance owns the slot (not-ours), no onDisplaced', async () => {
    // macf#702: not-ours now warns registry_heartbeat_displaced (the older
    // instance recognizes it was over-registered). Without an onDisplaced
    // callback it only logs — no stand-down (pre-#702 behaviour, used by
    // callers/tests that don't wire the guard).
    const logger = mockLogger();
    const hb = createRegistryHeartbeat({
      registry: mockRegistry({ beat: false, reason: 'not-ours' }),
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger,
      now: () => NOW,
    });

    await hb.runOnce();

    expect(logger.warn).toHaveBeenCalledWith(
      'registry_heartbeat_displaced',
      expect.objectContaining({ reason: 'not-ours' }),
    );
  });

  // --- macf#702 loser-yields split-brain guard ---

  it('SPLIT-BRAIN GUARD: fires onDisplaced (stand-down) exactly once when over-registered (not-ours)', async () => {
    const logger = mockLogger();
    const onDisplaced = vi.fn();
    const hb = createRegistryHeartbeat({
      registry: mockRegistry({ beat: false, reason: 'not-ours' }),
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger,
      now: () => NOW,
      onDisplaced,
    });

    // Two beats both see not-ours; the guard must fire the stand-down ONCE.
    await hb.runOnce();
    await hb.runOnce();

    expect(onDisplaced).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'registry_heartbeat_displaced',
      expect.objectContaining({ reason: 'not-ours' }),
    );
  });

  it('SPLIT-BRAIN GUARD: a THROWN onDisplaced is swallowed (a stand-down hiccup never crashes the tick)', async () => {
    const logger = mockLogger();
    const onDisplaced = vi.fn(() => {
      throw new Error('stand-down boom');
    });
    const hb = createRegistryHeartbeat({
      registry: mockRegistry({ beat: false, reason: 'not-ours' }),
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger,
      now: () => NOW,
      onDisplaced,
    });

    await expect(hb.runOnce()).resolves.toBeUndefined();
    expect(onDisplaced).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'registry_heartbeat_displaced_callback_failed',
      expect.objectContaining({ error: 'stand-down boom' }),
    );
  });

  it('SPLIT-BRAIN GUARD: does NOT fire onDisplaced on a healthy beat (beat) or a benign absent slot', async () => {
    const onDisplaced = vi.fn();
    const beatHb = createRegistryHeartbeat({
      registry: mockRegistry({ beat: true, reason: 'beat' }),
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger: mockLogger(),
      now: () => NOW,
      onDisplaced,
    });
    const absentHb = createRegistryHeartbeat({
      registry: mockRegistry({ beat: false, reason: 'absent' }),
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger: mockLogger(),
      now: () => NOW,
      onDisplaced,
    });

    await beatHb.runOnce();
    await absentHb.runOnce();

    expect(onDisplaced).not.toHaveBeenCalled();
  });

  it('logs a skip when the slot is absent', async () => {
    const logger = mockLogger();
    const hb = createRegistryHeartbeat({
      registry: mockRegistry({ beat: false, reason: 'absent' }),
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger,
      now: () => NOW,
    });

    await hb.runOnce();

    expect(logger.info).toHaveBeenCalledWith(
      'registry_heartbeat_skipped',
      expect.objectContaining({ reason: 'absent' }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a warning (fail-open) on an error RESULT — never throws', async () => {
    const logger = mockLogger();
    const hb = createRegistryHeartbeat({
      registry: mockRegistry({ beat: false, reason: 'error' }),
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger,
      now: () => NOW,
    });

    await expect(hb.runOnce()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'registry_heartbeat_failed',
      expect.objectContaining({ reason: 'error' }),
    );
  });

  it('swallows a THROWN heartbeat error (best-effort, never crashes the tick)', async () => {
    // heartbeatConditional is contracted never to throw, but the tick guards it
    // defensively so a future contract slip can't escape.
    const registry = mockRegistry();
    vi.mocked(registry.heartbeatConditional).mockRejectedValueOnce(new Error('boom'));
    const logger = mockLogger();
    const hb = createRegistryHeartbeat({
      registry,
      agentName: AGENT,
      instanceId: INSTANCE_ID,
      logger,
      now: () => NOW,
    });

    await expect(hb.runOnce()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'registry_heartbeat_failed',
      expect.objectContaining({ error: 'boom' }),
    );
  });

  describe('interval lifecycle (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('start() fires an immediate beat then re-stamps on each interval; stop() clears it', () => {
      const registry = mockRegistry();
      const hb = createRegistryHeartbeat({
        registry,
        agentName: AGENT,
        instanceId: INSTANCE_ID,
        logger: mockLogger(),
        intervalMs: 300_000,
        now: () => NOW,
      });

      hb.start();
      // Immediate beat at startup (mirrors the otel-probe lifecycle).
      expect(registry.heartbeatConditional).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(300_000);
      expect(registry.heartbeatConditional).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(900_000); // three more intervals
      expect(registry.heartbeatConditional).toHaveBeenCalledTimes(5);

      // Cleared on shutdown — no further beats fire.
      hb.stop();
      vi.advanceTimersByTime(3_000_000);
      expect(registry.heartbeatConditional).toHaveBeenCalledTimes(5);
    });

    it('start() is a no-op when the cadence is 0 (disabled)', () => {
      const registry = mockRegistry();
      const hb = createRegistryHeartbeat({
        registry,
        agentName: AGENT,
        instanceId: INSTANCE_ID,
        logger: mockLogger(),
        intervalMs: 0,
        now: () => NOW,
      });

      hb.start();
      vi.advanceTimersByTime(3_000_000);
      expect(registry.heartbeatConditional).not.toHaveBeenCalled();
    });

    it('start() is idempotent — a second call does not create a second interval', () => {
      const registry = mockRegistry();
      const hb = createRegistryHeartbeat({
        registry,
        agentName: AGENT,
        instanceId: INSTANCE_ID,
        logger: mockLogger(),
        intervalMs: 300_000,
        now: () => NOW,
      });

      hb.start();
      hb.start(); // no-op (timer already set)
      expect(registry.heartbeatConditional).toHaveBeenCalledTimes(1); // single immediate beat

      vi.advanceTimersByTime(300_000);
      expect(registry.heartbeatConditional).toHaveBeenCalledTimes(2); // single interval, not doubled

      hb.stop();
    });

    it('stop() is idempotent and safe before start()', () => {
      const hb = createRegistryHeartbeat({
        registry: mockRegistry(),
        agentName: AGENT,
        instanceId: INSTANCE_ID,
        logger: mockLogger(),
        intervalMs: 300_000,
        now: () => NOW,
      });

      expect(() => {
        hb.stop();
        hb.stop();
      }).not.toThrow();
    });
  });
});
