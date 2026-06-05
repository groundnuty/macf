/**
 * Source-shape TRIPWIRE for the SUBSTRATE (repo-root) `claude.sh` native-OTEL
 * telemetry block (groundnuty/macf#418 / #197).
 *
 * code-agent's hand-maintained launcher inlines the native-OTEL env vars into
 * the launched command via `LAUNCH_ENV` (so they cross the `tmux new-session`
 * boundary — #430). The #430 hand-port DROPPED `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`
 * — the traces beta gate — so substrate set the master gate + the per-signal
 * exporters but emitted ZERO native traces (science A/B vs the CV fleet,
 * confirmed via Tempo; devops's ingestion-control probe proved :14318 reachable,
 * isolating the gap to the launcher). Without the beta gate,
 * `CLAUDE_CODE_ENABLE_TELEMETRY=1` emits metrics+logs but NOT traces.
 *
 * This pins every gate that must be BOTH defaulted AND inlined into LAUNCH_ENV,
 * so a future hand-edit can't silently drop one again (the #197 recurrence
 * class). Textual/source-shape only — the canonical `claude-sh.ts`
 * otelTelemetryLines generator is tested separately in claude-sh.test.ts; this
 * guards the hand-maintained repo-root copy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// packages/macf/test/cli → repo root is four levels up.
const CLAUDE_SH = readFileSync(resolve(__dirname, '../../../../claude.sh'), 'utf-8');

// Gates that MUST be defaulted (`: "${VAR=…}"`) AND inlined into the LAUNCH_ENV
// `for _v in …` loop. Traces require BOTH the master gate and the beta gate
// (+ OTEL_TRACES_EXPORTER) per #197 + plugin/rules/observability-wiring.md.
const REQUIRED_GATES = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'OTEL_TRACES_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'OTEL_RESOURCE_ATTRIBUTES',
] as const;

// The inline list: the var names between `for _v in` and `; do`.
const loopMatch = CLAUDE_SH.match(/for _v in ([\s\S]*?); do/);
const loopVars = loopMatch ? loopMatch[1] : '';

describe('substrate claude.sh native-OTEL telemetry block (macf#418/#197)', () => {
  it('has an OTEL block gated by MACF_OTEL_DISABLED', () => {
    expect(CLAUDE_SH).toContain('if [ "${MACF_OTEL_DISABLED:-}" != "1" ]; then');
  });

  it('has a LAUNCH_ENV inline loop', () => {
    expect(loopVars).not.toBe('');
  });

  for (const gate of REQUIRED_GATES) {
    it(`defaults ${gate} (: "\${${gate}=…}")`, () => {
      expect(CLAUDE_SH).toMatch(new RegExp(`: "\\$\\{${gate}=`));
    });
    it(`inlines ${gate} into LAUNCH_ENV`, () => {
      expect(loopVars).toContain(gate);
    });
  }

  it('specifically carries the traces beta gate (the #418/#430 regression)', () => {
    // The dropped-then-restored line; both the default and the inline must exist.
    expect(CLAUDE_SH).toMatch(/: "\$\{CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1\}"/);
    expect(loopVars).toContain('CLAUDE_CODE_ENHANCED_TELEMETRY_BETA');
  });
});
