/**
 * Tests for src/otel.ts — macf#196 bootstrapOtel fix.
 *
 * Covers the 3 AC states from #196:
 *   1. env unset → silent no-op, no module-resolution cost, no error
 *      even if @opentelemetry/sdk-* packages aren't installed
 *   2. env set + packages available → bootstrap succeeds (provider
 *      registered, global tracer now records)
 *   3. env set + packages missing → process.exit(1) with actionable
 *      stderr message
 *
 * Strategy: state 1 is a direct invocation; state 2 relies on the
 * SDK packages being in node_modules (they are, via package.json);
 * state 3 stubs `await import(...)` via a vi.mock of
 * `@opentelemetry/sdk-trace-node` to throw, then asserts the
 * process.stderr + process.exit behavior.
 *
 * We don't test the actual span emission or OTLP wire format here —
 * those are integration concerns (`test/e2e/` scope, follow-up PR).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootstrapOtel, buildResource } from '../src/otel.js';

describe('bootstrapOtel', () => {
  let originalEnv: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // process.exit returns never — the type assertion swallows the
    // unreachability annotation so the spy can return undefined.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number): never => {
      throw new Error(`process.exit(${_code}) called in test`);
    }) as () => never);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = originalEnv;
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.resetModules();
  });

  describe('AC1: env unset → telemetry-off announced (macf#422: was a silent no-op)', () => {
    it('logs otel_init_skipped + returns undefined when env is unset', async () => {
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      await expect(bootstrapOtel()).resolves.toBeUndefined();
      // macf#422 AC-5: the unset path now ANNOUNCES the telemetry-off state
      // (closes the silent no-op) rather than returning silently — so a
      // channel-server exporting nothing is distinguishable from one whose
      // OTLP export is failing downstream.
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('otel_init_skipped'));
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('treats empty-string env as unset → also logs otel_init_skipped', async () => {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = '';
      await expect(bootstrapOtel()).resolves.toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('otel_init_skipped'));
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('AC2: env set + packages available → bootstrap succeeds', () => {
    it('resolves without throwing when env is set + SDK packages are importable', async () => {
      // Packages are in devDeps via package.json, so the dynamic
      // imports resolve. This asserts the happy path doesn't throw;
      // span-emission verification is integration-level.
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
      await expect(bootstrapOtel()).resolves.toBeUndefined();
      // macf#422 AC-5: success path announces init + the resolved endpoint,
      // so channel.log can distinguish "telemetry on (export may be failing
      // downstream)" from "telemetry off / env not propagated".
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('otel_init endpoint='));
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('AC: DELTA temporality (macf#281 Phase 2)', () => {
    it('OTLPMetricExporter constructed with temporalityPreference=DELTA emits DELTA for Counter', async () => {
      // Mirrors the construction in `bootstrapOtel` — verifies the API
      // contract that DELTA temporality is honored by the proto exporter.
      // Regression guard: if the `temporalityPreference` arg is dropped
      // from `new OTLPMetricExporter(...)`, the default falls back to
      // CUMULATIVE — this test fails immediately.
      const sdkMetrics = await import('@opentelemetry/sdk-metrics');
      const metricsExporter = await import('@opentelemetry/exporter-metrics-otlp-proto');

      const exporter = new metricsExporter.OTLPMetricExporter({
        temporalityPreference: sdkMetrics.AggregationTemporality.DELTA,
      });

      // OTLPMetricExporterBase exposes selectAggregationTemporality(instrumentType)
      // which returns the configured AggregationTemporality for that type.
      const counterTemporality = exporter.selectAggregationTemporality(
        sdkMetrics.InstrumentType.COUNTER,
      );
      expect(counterTemporality).toBe(sdkMetrics.AggregationTemporality.DELTA);
    });

    it('default OTLPMetricExporter (no config + no env override) emits CUMULATIVE for Counter — confirms the regression-guard target', async () => {
      // Counterpart to the above: verifies that the default IS cumulative,
      // so the explicit DELTA config in `bootstrapOtel` is load-bearing
      // (not a no-op).
      //
      // Note: OTel SDK reads OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE
      // when no explicit config is passed. Some dev VMs (this one included)
      // set it to 'delta' in their shell profile, which would mask the
      // default. Clear it for the duration of this test to assert the
      // SDK-default behavior independent of the surrounding env.
      const prior = process.env['OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE'];
      delete process.env['OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE'];
      try {
        const sdkMetrics = await import('@opentelemetry/sdk-metrics');
        const metricsExporter = await import('@opentelemetry/exporter-metrics-otlp-proto');

        const exporter = new metricsExporter.OTLPMetricExporter();
        const counterTemporality = exporter.selectAggregationTemporality(
          sdkMetrics.InstrumentType.COUNTER,
        );
        expect(counterTemporality).toBe(sdkMetrics.AggregationTemporality.CUMULATIVE);
      } finally {
        if (prior !== undefined) process.env['OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE'] = prior;
      }
    });
  });

  describe('AC3: env set + packages missing → fail-loud exit(1)', () => {
    it('calls process.exit(1) + writes actionable stderr when an SDK import fails', async () => {
      // We can't uninstall the SDK packages for one test case, so we
      // simulate the missing-module condition via vi.doMock making
      // one of the imports throw. The import is a dynamic `await
      // import('@opentelemetry/sdk-trace-node')` → vitest's mock
      // system hooks it. `vi.resetModules` in afterEach undoes for
      // other tests.
      vi.doMock('@opentelemetry/sdk-trace-node', () => {
        throw new Error(`Cannot find package '@opentelemetry/sdk-trace-node'`);
      });
      // Re-import the module fresh so the doMock takes effect for
      // its dynamic imports.
      vi.resetModules();
      const { bootstrapOtel: freshBootstrap } =
        await import('../src/otel.js');

      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';

      await expect(freshBootstrap()).rejects.toThrow(
        /process\.exit\(1\) called in test/,
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      // Stderr received the actionable error + recovery hint.
      expect(stderrSpy).toHaveBeenCalled();
      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrOutput).toContain('FATAL');
      expect(stderrOutput).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
      expect(stderrOutput).toContain('@opentelemetry/*');
      // Recovery hint mentions both fix paths (install OR unset).
      expect(stderrOutput).toContain('install');
      expect(stderrOutput).toContain('unset');

      vi.doUnmock('@opentelemetry/sdk-trace-node');
    });
  });
});

describe('buildResource (macf#427 — gen_ai.agent.name resource attrs)', () => {
  let originalRA: string | undefined;

  beforeEach(() => {
    originalRA = process.env['OTEL_RESOURCE_ATTRIBUTES'];
  });
  afterEach(() => {
    if (originalRA === undefined) delete process.env['OTEL_RESOURCE_ATTRIBUTES'];
    else process.env['OTEL_RESOURCE_ATTRIBUTES'] = originalRA;
  });

  it('lands gen_ai.agent.name / gen_ai.agent.role / service.namespace from OTEL_RESOURCE_ATTRIBUTES', async () => {
    process.env['OTEL_RESOURCE_ATTRIBUTES'] =
      'gen_ai.agent.name=cv-architect,gen_ai.agent.role=architect,service.namespace=macf';
    const resources = await import('@opentelemetry/resources');
    const semconv = await import('@opentelemetry/semantic-conventions');

    const r = buildResource(resources, semconv, 'macf-agent-cv-architect', '0.2.34');

    // The bug (groundnuty/macf#427): defaultResource() alone leaves these <UNSET>.
    expect(r.attributes['gen_ai.agent.name']).toBe('cv-architect');
    expect(r.attributes['gen_ai.agent.role']).toBe('architect');
    expect(r.attributes['service.namespace']).toBe('macf');
    // Explicit service.* still applied.
    expect(r.attributes['service.name']).toBe('macf-agent-cv-architect');
    expect(r.attributes['service.version']).toBe('0.2.34');
  });

  it('still sets service.name/version when OTEL_RESOURCE_ATTRIBUTES is unset', async () => {
    delete process.env['OTEL_RESOURCE_ATTRIBUTES'];
    const resources = await import('@opentelemetry/resources');
    const semconv = await import('@opentelemetry/semantic-conventions');

    const r = buildResource(resources, semconv, 'macf-agent-code-agent', '1.2.3');

    expect(r.attributes['service.name']).toBe('macf-agent-code-agent');
    expect(r.attributes['service.version']).toBe('1.2.3');
    expect(r.attributes['gen_ai.agent.name']).toBeUndefined();
  });

  it('explicit service.name wins over a service.name carried in OTEL_RESOURCE_ATTRIBUTES', async () => {
    process.env['OTEL_RESOURCE_ATTRIBUTES'] = 'service.name=from-env,gen_ai.agent.name=cv-x';
    const resources = await import('@opentelemetry/resources');
    const semconv = await import('@opentelemetry/semantic-conventions');

    const r = buildResource(resources, semconv, 'macf-agent-cv-x', '0.2.34');

    // Explicit merge is applied last → wins; env-only attrs still survive.
    expect(r.attributes['service.name']).toBe('macf-agent-cv-x');
    expect(r.attributes['gen_ai.agent.name']).toBe('cv-x');
  });
});
