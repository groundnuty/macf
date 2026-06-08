/**
 * Tests for `src/metrics.ts` — channel-server metric instrument
 * conventions + counter caching (testbed#242 T6 closure / macf#278).
 *
 * These tests cover:
 *   - `getMeter()` returns a meter (no-op when no global MeterProvider
 *     registered; real when one is)
 *   - Counter caching: `getNotifyReceivedCounter()` returns same
 *     instance on repeated calls
 *   - `resetMetricsCacheForTesting()` clears the cache so a fresh
 *     MeterProvider can re-create instruments cleanly between tests
 *   - Counter `.add()` doesn't throw on the no-op meter path (zero-cost
 *     default per DR-021)
 *   - Counter increments record on real MeterProvider — verified via
 *     in-memory metric reader collecting the export
 *
 * Integration-level verification (counter increments during a real
 * /notify request) lives in `https.test.ts` scope and the post-merge
 * scenario-08 re-run; this file is unit coverage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, AggregationTemporality, type ResourceMetrics, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import {
  getMeter,
  getNotifyReceivedCounter,
  getNotifyPeerCounter,
  getSignCallsCounter,
  getCommsLedgerWriteFailedCounter,
  resetMetricsCacheForTesting,
  MetricNames,
  MetricAttr,
} from '../src/metrics.js';

/**
 * Minimal in-memory exporter that captures the most-recent collected
 * batch on each export call. Sufficient for asserting "did this counter
 * record an increment with these labels?"
 */
class InMemoryMetricExporter implements PushMetricExporter {
  public readonly batches: ResourceMetrics[] = [];

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: { code: number }) => void,
  ): void {
    this.batches.push(metrics);
    resultCallback({ code: 0 });
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }
}

describe('metrics module', () => {
  afterEach(() => {
    // Reset the cached instruments so each test starts clean.
    resetMetricsCacheForTesting();
    // Unset the global MeterProvider so the next test starts from
    // no-op meter state. The api uses a singleton so leakage between
    // tests would mask provider-registration behavior.
    metrics.disable();
  });

  describe('getMeter()', () => {
    it('returns a Meter instance (no-op when no provider registered)', () => {
      const meter = getMeter();
      expect(meter).toBeDefined();
      // The no-op meter still implements createCounter; calling it
      // must not throw.
      expect(() => meter.createCounter('test')).not.toThrow();
    });

    it('returns a meter bound to the registered provider when one is set', () => {
      const provider = new MeterProvider();
      metrics.setGlobalMeterProvider(provider);
      const meter = getMeter();
      expect(meter).toBeDefined();
      expect(() => meter.createCounter('macf.test')).not.toThrow();
    });
  });

  describe('counter caching', () => {
    it('getNotifyReceivedCounter returns the same instance on repeated calls', () => {
      const a = getNotifyReceivedCounter();
      const b = getNotifyReceivedCounter();
      expect(a).toBe(b);
    });

    it('getNotifyPeerCounter returns the same instance on repeated calls', () => {
      const a = getNotifyPeerCounter();
      const b = getNotifyPeerCounter();
      expect(a).toBe(b);
    });

    it('getSignCallsCounter returns the same instance on repeated calls', () => {
      // macf#371: empirical-basis counter for DR-010 Path-2 removal trigger.
      const a = getSignCallsCounter();
      const b = getSignCallsCounter();
      expect(a).toBe(b);
    });

    it('getCommsLedgerWriteFailedCounter returns the same instance on repeated calls', () => {
      // macf#473 piece 2: loud-but-proceeds write-failed metric.
      const a = getCommsLedgerWriteFailedCounter();
      const b = getCommsLedgerWriteFailedCounter();
      expect(a).toBe(b);
    });

    it('resetMetricsCacheForTesting() lets the next call re-create the counter', async () => {
      // Reference-equality on the no-op meter is misleading because
      // NoopCounterMetric is a process singleton — both pre- and
      // post-reset would return the same instance regardless of cache
      // state. Test caching behavior with a real MeterProvider where
      // createCounter() returns distinct instances per call.
      const sdkMetrics = await import('@opentelemetry/sdk-metrics');
      const provider = new sdkMetrics.MeterProvider();
      metrics.setGlobalMeterProvider(provider);

      const a = getNotifyReceivedCounter();
      const same = getNotifyReceivedCounter();
      // Same instance across calls without reset (cache hit).
      expect(a).toBe(same);

      resetMetricsCacheForTesting();
      const b = getNotifyReceivedCounter();
      // After reset, the cache miss creates a fresh instance.
      expect(a).not.toBe(b);

      await provider.shutdown();
    });
  });

  describe('counter .add() — no-op meter (zero-cost default)', () => {
    it('does not throw when increment fires before any provider is registered', () => {
      const counter = getNotifyReceivedCounter();
      expect(() =>
        counter.add(1, { [MetricAttr.NotifyType]: 'mention', [MetricAttr.Agent]: 'test' }),
      ).not.toThrow();
    });

    it('does not throw on repeated increments without a provider', () => {
      const counter = getNotifyPeerCounter();
      expect(() => {
        for (let i = 0; i < 10; i++) {
          counter.add(1, {
            [MetricAttr.Event]: 'session-end',
            [MetricAttr.Delivered]: 'true',
            [MetricAttr.Agent]: 'test',
          });
        }
      }).not.toThrow();
    });
  });

  describe('counter .add() — real MeterProvider records increments', () => {
    it('records notify_received_total increments with type + agent labels', async () => {
      // We build the provider/reader/exporter manually here so we can
      // call collect() directly + inspect the in-memory batches —
      // PeriodicExportingMetricReader's interval is 60s by default,
      // way too slow for unit-test latency.
      const exporter = new InMemoryMetricExporter();

      // Use ManualMetricReader-equivalent: dynamic import to keep
      // the test SDK-version-agnostic. Or use a fixed reader.
      const sdkMetrics = await import('@opentelemetry/sdk-metrics');
      const reader = new sdkMetrics.PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000, // we'll force-collect manually
      });
      const provider = new MeterProvider({ readers: [reader] });
      metrics.setGlobalMeterProvider(provider);

      // Increment 3 times with varying labels
      const counter = getNotifyReceivedCounter();
      counter.add(1, { [MetricAttr.NotifyType]: 'mention', [MetricAttr.Agent]: 'tester-1' });
      counter.add(1, { [MetricAttr.NotifyType]: 'peer_notification', [MetricAttr.Agent]: 'tester-1' });
      counter.add(1, { [MetricAttr.NotifyType]: 'mention', [MetricAttr.Agent]: 'tester-1' });

      // Force a collection cycle.
      await reader.forceFlush();

      expect(exporter.batches.length).toBeGreaterThan(0);
      const lastBatch = exporter.batches.at(-1);
      expect(lastBatch).toBeDefined();
      // Find the metric by name.
      const metric = lastBatch?.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === MetricNames.NotifyReceivedTotal);
      expect(metric).toBeDefined();
      // 2 distinct attribute combinations → 2 data points (mention×2 + peer_notification×1).
      expect(metric?.dataPoints.length).toBe(2);

      // Total count across all data points should equal 3.
      const total = (metric?.dataPoints ?? []).reduce(
        (sum, dp) => sum + (dp.value as number),
        0,
      );
      expect(total).toBe(3);

      await provider.shutdown();
    });
  });

  describe('macf#371 sign_calls_total counter', () => {
    it('records sign_calls_total increments with agent label', async () => {
      // Empirical basis for DR-010 Path-2 12-month zero-call removal
      // trigger. Verifies the counter is wired to the global MeterProvider
      // and records `.add(1, { agent })` calls correctly.
      const exporter = new InMemoryMetricExporter();
      const sdkMetrics = await import('@opentelemetry/sdk-metrics');
      const reader = new sdkMetrics.PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      });
      const provider = new MeterProvider({ readers: [reader] });
      metrics.setGlobalMeterProvider(provider);

      const counter = getSignCallsCounter();
      counter.add(1, { [MetricAttr.Agent]: 'tester-1' });
      counter.add(1, { [MetricAttr.Agent]: 'tester-1' });
      counter.add(1, { [MetricAttr.Agent]: 'tester-2' });

      await reader.forceFlush();

      const lastBatch = exporter.batches.at(-1);
      expect(lastBatch).toBeDefined();
      const metric = lastBatch?.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === MetricNames.SignCallsTotal);
      expect(metric).toBeDefined();
      // 2 distinct agent labels → 2 data points (tester-1×2 + tester-2×1).
      expect(metric?.dataPoints.length).toBe(2);

      const total = (metric?.dataPoints ?? []).reduce(
        (sum, dp) => sum + (dp.value as number),
        0,
      );
      expect(total).toBe(3);

      await provider.shutdown();
    });
  });

  describe('macf#473 comms_ledger_write_failed_total counter', () => {
    it('records comms_ledger_write_failed_total increments with agent/channel/direction labels', async () => {
      const exporter = new InMemoryMetricExporter();
      const sdkMetrics = await import('@opentelemetry/sdk-metrics');
      const reader = new sdkMetrics.PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      });
      const provider = new MeterProvider({ readers: [reader] });
      metrics.setGlobalMeterProvider(provider);

      const counter = getCommsLedgerWriteFailedCounter();
      counter.add(1, {
        [MetricAttr.Agent]: 'tester-1',
        [MetricAttr.Channel]: 'a2a',
        [MetricAttr.Direction]: 'send',
      });
      counter.add(1, {
        [MetricAttr.Agent]: 'tester-1',
        [MetricAttr.Channel]: 'github-route',
        [MetricAttr.Direction]: 'recv',
      });

      await reader.forceFlush();

      const lastBatch = exporter.batches.at(-1);
      expect(lastBatch).toBeDefined();
      const metric = lastBatch?.scopeMetrics
        .flatMap((sm) => sm.metrics)
        .find((m) => m.descriptor.name === MetricNames.CommsLedgerWriteFailedTotal);
      expect(metric).toBeDefined();
      // 2 distinct (channel, direction) combos → 2 data points.
      expect(metric?.dataPoints.length).toBe(2);

      await provider.shutdown();
    });
  });

  describe('instrument names + attributes', () => {
    it('exposes canonical metric names matching documented conventions', () => {
      expect(MetricNames.NotifyReceivedTotal).toBe('macf.notify_received_total');
      expect(MetricNames.NotifyPeerTotal).toBe('macf.notify_peer_total');
      expect(MetricNames.SignCallsTotal).toBe('macf.sign_calls_total');
      expect(MetricNames.CommsLedgerWriteFailedTotal).toBe('macf.comms_ledger_write_failed_total');
    });

    it('exposes canonical attribute keys', () => {
      expect(MetricAttr.NotifyType).toBe('macf.notify.type');
      expect(MetricAttr.Agent).toBe('macf.agent');
      expect(MetricAttr.Delivered).toBe('macf.notify.delivered');
      expect(MetricAttr.Event).toBe('macf.notify.event');
      expect(MetricAttr.Channel).toBe('macf.comms.channel');
      expect(MetricAttr.Direction).toBe('macf.comms.direction');
    });
  });
});
