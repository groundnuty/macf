---
paths:
  - "**/claude.sh"
  - "**/.claude/.macf/env.*"
  - "**/claude-sh.ts"
  - "**/env-files.ts"
---
# Observability wiring

The launcher exports Claude Code's OpenTelemetry variables so traces, metrics and logs reach the collector. They are generated into `.claude/.macf/env.telemetry` (`macf init` / `macf update`; source `claude-sh.ts` and `env-files.ts`); edit the generator or re-run `macf update`, not the output.

## Variables to keep set

- `CLAUDE_CODE_ENABLE_TELEMETRY=1` and `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`: master gates for all signals and for traces.
- `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` and `OTEL_LOGS_EXPORTER`, each `otlp`: every signal is gated separately, so a missing one silently emits nothing while the others work.
- `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_PROTOCOL` (`http/protobuf`).
- `OTEL_SERVICE_NAME` (`macf-agent-<name>`) and `OTEL_RESOURCE_ATTRIBUTES` with `gen_ai.agent.name`, `gen_ai.agent.role` and `service.namespace`: dashboards filter on these `gen_ai.*` keys.

## Endpoint and opt-out

- `MACF_OTEL_ENDPOINT` overrides the endpoint at `macf update` time. Run `grep OTEL_EXPORTER_OTLP_ENDPOINT .claude/.macf/env.telemetry` to see the active one rather than trusting a value written elsewhere; a retired or wrong endpoint drops telemetry with no error.
- `MACF_OTEL_DISABLED=1` generates a minimal file with no exports, for hosts with no collector.

## Check the result

A present export proves only configuration; it looks the same whether telemetry arrives or not. To verify, query the trace backend for recent traces from this agent's `OTEL_SERVICE_NAME`, quoting dotted attributes in TraceQL (`resource."gen_ai.agent.name"`; unquoted returns 0 silently). If the backend cannot be reached, report unknown, not fine.
