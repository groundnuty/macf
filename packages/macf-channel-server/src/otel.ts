/**
 * OpenTelemetry bootstrap — dynamic-import gated by env.
 *
 * Zero-cost default (macf#196, revisiting macf#194):
 *
 *   The original v0.1.7 shipped this module with TOP-LEVEL static
 *   imports of the 5 SDK packages. That violated the zero-cost
 *   doctrine structurally: Node resolved + loaded all of them at
 *   startup regardless of whether `OTEL_EXPORTER_OTLP_ENDPOINT`
 *   was set. Worse, when a consumer workspace didn't have the
 *   packages in its `node_modules/` (which was the default — they
 *   weren't declared in `plugin/package.json`), the server crashed
 *   with `ERR_MODULE_NOT_FOUND` before the env-guard ever ran.
 *
 *   v0.1.8 fix: `bootstrapOtel()` is async; inside, we `await import()`
 *   the SDK packages only when the endpoint is set. Node only
 *   resolves the packages when the operator opts in. If they're
 *   missing at that point (operator set the env but forgot `npm
 *   install`), we fail LOUD with an actionable message — silent
 *   no-op would hide the opt-in attempt.
 *
 *   `@opentelemetry/api` stays statically imported because other
 *   modules (`src/tracing.ts`, `src/https.ts`) import it at eval
 *   time for the no-op tracer path. The `api` package has zero
 *   deps and is already a transitive dep, so it's safe to require.
 *
 * Why manual-only (no `auto-instrumentations-node`):
 *   Auto-instrumentations monkey-patch core Node modules including
 *   HTTPS — and we rely on exact mTLS client-cert validation
 *   semantics in `src/https.ts`. Any patching layer between us and
 *   Node's TLS code is a correctness risk we don't need.
 *
 * Version pinning:
 *   SDK-node packages (`@opentelemetry/sdk-trace-node` etc.) are
 *   still pre-1.0 (0.x). Breaking changes land in minor releases.
 *   Pin exact versions via package.json — do NOT use caret ranges.
 *
 * See DR-021 for the full rationale + option analysis.
 */

/**
 * Build the OTel Resource for the channel server.
 *
 * Merge order (later wins on key collision):
 *   1. `defaultResource()` — SDK defaults (telemetry.sdk.*, default service.name).
 *   2. `detectResources({ detectors: [envDetector] })` — parses
 *      `OTEL_RESOURCE_ATTRIBUTES` (gen_ai.agent.name, gen_ai.agent.role,
 *      service.namespace, …). `defaultResource()` does NOT run the env
 *      detector itself (verified on @opentelemetry/resources 2.7.0), so
 *      without this explicit merge those attrs never land — exported spans
 *      carried `service.name` but `gen_ai.agent.name` was <UNSET>
 *      (groundnuty/macf#427, surfaced verifying #422 AC-5).
 *   3. explicit `service.name` / `service.version` — applied last so the
 *      channel server's computed service.name wins over any env/default value.
 *
 * Extracted from bootstrapOtel() as a pure function of the dynamically-imported
 * SDK modules so the merge is unit-testable without standing up the provider.
 * Takes `resources`/`semconv` as params (rather than importing) to preserve
 * the zero-cost dynamic-import doctrine — see the module header.
 */
export function buildResource(
  resources: typeof import('@opentelemetry/resources'),
  semconv: typeof import('@opentelemetry/semantic-conventions'),
  serviceName: string,
  serviceVersion: string,
): ReturnType<(typeof import('@opentelemetry/resources'))['defaultResource']> {
  return resources
    .defaultResource()
    .merge(resources.detectResources({ detectors: [resources.envDetector] }))
    .merge(
      resources.resourceFromAttributes({
        [semconv.ATTR_SERVICE_NAME]: serviceName,
        [semconv.ATTR_SERVICE_VERSION]: serviceVersion,
      }),
    );
}

/**
 * Opt-in OTEL bootstrap. No-op (and zero module-resolution cost) when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. When set, dynamic-imports
 * the SDK packages, configures an OTLP-proto exporter, registers the
 * provider globally, and wires SIGTERM/SIGINT span-flush.
 *
 * **Must be awaited before any span-emitting module's handler runs.**
 * In `src/server.ts`, `await bootstrapOtel()` sits at the top of
 * `main()` so the global tracer provider is live before /notify,
 * /sign, etc. start accepting requests.
 *
 * Fail-loud policy:
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT` unset → silent return (zero-cost default).
 *   - Env set + import fails → process.exit(1) with actionable
 *     stderr. Operator explicitly opted into observability; silent
 *     no-op would hide the config mistake.
 *   - Env set + import ok + provider setup fails → same exit(1).
 */
export async function bootstrapOtel(): Promise<void> {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (endpoint === undefined || endpoint === '') {
    // macf#422 AC-5: announce the telemetry-off state instead of returning
    // silently. A channel-server that exports nothing is otherwise
    // indistinguishable from one whose OTLP export is failing downstream —
    // this line (MCP child's stderr → channel.log) confirms the cause is
    // env-propagation: OTEL_EXPORTER_OTLP_ENDPOINT never reached this
    // process. Sister to the Bug-2 silent-fallback fix.
    process.stderr.write('[macf-otel] otel_init_skipped reason=OTEL_EXPORTER_OTLP_ENDPOINT_unset\n');
    return;
  }

  const serviceVersion = process.env['MACF_VERSION'] ?? '0.0.0';
  const serviceName = process.env['OTEL_SERVICE_NAME'] ?? 'macf';

  // Dynamic imports — only resolved when opted in. Lets a workspace
  // WITHOUT `@opentelemetry/sdk-*` in node_modules start cleanly
  // (as long as it doesn't opt in). See macf#196 for the bug this
  // closes; consumer plugin workspaces have only a subset of deps
  // available via `npm install` unless opted into observability.
  let sdkNode: typeof import('@opentelemetry/sdk-trace-node');
  let sdkBase: typeof import('@opentelemetry/sdk-trace-base');
  let traceExporter: typeof import('@opentelemetry/exporter-trace-otlp-proto');
  let sdkMetrics: typeof import('@opentelemetry/sdk-metrics');
  let metricsExporter: typeof import('@opentelemetry/exporter-metrics-otlp-proto');
  let metricsApi: typeof import('@opentelemetry/api');
  let resources: typeof import('@opentelemetry/resources');
  let semconv: typeof import('@opentelemetry/semantic-conventions');
  try {
    [sdkNode, sdkBase, traceExporter, sdkMetrics, metricsExporter, metricsApi, resources, semconv] = await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/exporter-trace-otlp-proto'),
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/exporter-metrics-otlp-proto'),
      import('@opentelemetry/api'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `FATAL: OTEL_EXPORTER_OTLP_ENDPOINT is set ("${endpoint}") but required @opentelemetry/* packages are missing.\n` +
        `  Underlying error: ${msg}\n` +
        `  Fix: install them in the plugin dir (e.g. run macf-agent's SessionStart npm-install hook), ` +
        `or unset OTEL_EXPORTER_OTLP_ENDPOINT to disable telemetry.\n`,
    );
    process.exit(1);
  }

  // Resource = SDK defaults + OTEL_RESOURCE_ATTRIBUTES (gen_ai.agent.name,
  // gen_ai.agent.role, service.namespace) + explicit service.* on top.
  // See buildResource() for the merge order + why the env detector is
  // explicit (groundnuty/macf#427).
  const resource = buildResource(resources, semconv, serviceName, serviceVersion);

  const tracerProvider = new sdkNode.NodeTracerProvider({
    resource,
    spanProcessors: [new sdkBase.BatchSpanProcessor(new traceExporter.OTLPTraceExporter())],
  });

  // register() installs the provider as global + sets W3C trace-
  // context propagator as default. After this call,
  // `trace.getTracer('macf')` from anywhere in the process returns a
  // recording tracer bound to this provider.
  tracerProvider.register();

  // Metrics provider — parallel to traces. Per testbed#242 T6 closure
  // (groundnuty/macf#278): channel-server emits OTel metrics so paper-
  // evidence pipelines have notify_received / notify_peer counter data
  // alongside trace data. Same OTLP endpoint as traces (the collector
  // routes /v1/metrics vs /v1/traces internally).
  //
  // PeriodicExportingMetricReader: collects + exports at a fixed
  // cadence (default 60s). For the test scenarios + paper-evidence
  // sweeps that complete in ~5min, the default cadence delivers data
  // within the run window; no need to tune it.
  //
  // Aggregation temporality: DELTA (per macf#281 Phase 2 fix). With
  // the default cumulative temporality, each MeterProvider lifecycle
  // emits its own restart-from-zero counter — the Prometheus storage
  // sees these as discrete "drops" in the cumulative trajectory and
  // `rate()` / `increase()` over a range can return wrong totals (the
  // empirical surfacing: scenario-08 N=5 sweeps on v0.2.5 produced
  // counter values 1/5 of expected because process restarts between
  // export cycles broke the cumulative chain).
  //
  // DELTA temporality: each export interval emits the increments-this-
  // interval rather than running totals. Process restarts produce
  // independent delta points (not zero-resets); the collector
  // aggregates by series identity to reconstruct cumulative — robust
  // to N-process / restart topologies. Required reading:
  // silent-fallback-hazards.md Instance 7 framing.
  //
  // Type compatibility: `temporalityPreference` accepts
  // `AggregationTemporality | AggregationTemporalityPreference`. We
  // pass `AggregationTemporality.DELTA` (= 0) from `sdk-metrics` since
  // it's already imported. The semantic difference vs
  // `AggregationTemporalityPreference.DELTA` (also = 0) only matters
  // for non-deltable instruments (UpDownCounter / asynchronous);
  // we currently emit only Counter (delta-able), so the choice is
  // equivalent. If a future change adds an UpDownCounter, switch to
  // `AggregationTemporalityPreference.DELTA` from the http exporter
  // package — that selector keeps cumulative for non-deltable types.
  const meterProvider = new sdkMetrics.MeterProvider({
    resource,
    readers: [
      new sdkMetrics.PeriodicExportingMetricReader({
        exporter: new metricsExporter.OTLPMetricExporter({
          temporalityPreference: sdkMetrics.AggregationTemporality.DELTA,
        }),
      }),
    ],
  });
  metricsApi.metrics.setGlobalMeterProvider(meterProvider);

  // Clean shutdown: flush both providers before process exits. Without
  // these handlers, in-flight batches are dropped on SIGTERM/SIGINT —
  // the last few seconds of coordination events never reach the
  // collector. For metrics specifically, the periodic reader's last
  // unflushed batch (up to `exportIntervalMillis` worth of counter
  // increments) would be lost without explicit shutdown.
  const shutdown = async (): Promise<void> => {
    try {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    } catch {
      // Silent — we're exiting regardless; don't spam stderr.
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  // macf#422 AC-5: announce successful telemetry init + the resolved
  // endpoint. If spans STILL don't reach the collector after this logs,
  // the gap is export-side (e.g. localhost→::1 resolution per macf#419),
  // NOT env-propagation — distinguishing the two AC-5 candidates from
  // channel.log alone (no root-only /proc/<pid>/environ needed).
  process.stderr.write(`[macf-otel] otel_init endpoint="${endpoint}" service="${serviceName}"\n`);
}
