/**
 * Tests for the `macf doctor` OTEL launch-boundary probe (macf#554/#556).
 *
 * Offline + deterministic: `checkOtelLaunchBoundary` reads through an
 * injectable `ProcReader`, so tests feed synthetic `/proc` data. The
 * load-bearing case is the cwd disambiguation — on a multi-tenant host with
 * several `claude` processes, the probe must assert against the ONE whose cwd
 * is this workspace, never `head -1`.
 */
import { describe, it, expect } from 'vitest';
import { checkOtelLaunchBoundary } from '../../src/cli/commands/doctor.js';
import type { ProcReader } from '../../src/cli/proc-scan.js';

interface FakeProc {
  readonly cwd?: string;
  readonly cmdline: readonly string[];
  readonly environ?: Record<string, string>;
}

function fakeReader(procs: Record<string, FakeProc>, available = true): ProcReader {
  const nul = (parts: readonly string[]): string => parts.join('\0') + '\0';
  return {
    available: () => available,
    listPids: () => Object.keys(procs),
    readCwd: (pid) => procs[pid]?.cwd ?? null,
    readCmdline: (pid) => (procs[pid] ? nul(procs[pid]!.cmdline) : null),
    readEnviron: (pid) => {
      const env = procs[pid]?.environ;
      if (!env) return null;
      return nul(Object.entries(env).map(([k, v]) => `${k}=${v}`));
    },
  };
}

describe('checkOtelLaunchBoundary', () => {
  it('INFO when /proc is unavailable (non-Linux host)', () => {
    const res = checkOtelLaunchBoundary('/w/macf', fakeReader({}, false));
    expect(res.status).toBe('INFO');
    expect(res.detail).toMatch(/non-Linux/);
  });

  it('INFO when no claude process has this workspace as cwd', () => {
    const reader = fakeReader({
      '1': { cwd: '/w/other', cmdline: ['claude'], environ: { OTEL_EXPORTER_OTLP_ENDPOINT: 'x' } },
    });
    const res = checkOtelLaunchBoundary('/w/macf', reader);
    expect(res.status).toBe('INFO');
    expect(res.detail).toMatch(/no running claude/);
  });

  it('PASS when this workspace’s claude exports the OTEL endpoint', () => {
    const reader = fakeReader({
      '1': {
        cwd: '/w/macf',
        cmdline: ['claude'],
        environ: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://mon:4318' },
      },
    });
    const res = checkOtelLaunchBoundary('/w/macf', reader);
    expect(res.status).toBe('PASS');
    expect(res.detail).toContain('https://mon:4318');
  });

  it('WARN when this workspace’s claude exists but lacks the OTEL endpoint', () => {
    const reader = fakeReader({
      '1': { cwd: '/w/macf', cmdline: ['claude'], environ: { MACF_AGENT_NAME: 'code-agent' } },
    });
    const res = checkOtelLaunchBoundary('/w/macf', reader);
    expect(res.status).toBe('WARN');
    expect(res.detail).toMatch(/NO OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it('disambiguates by cwd — a sibling claude WITH the endpoint does not mask this one’s gap', () => {
    // Two claudes: the workspace one lacks OTEL; a sibling (different cwd) has it.
    // A `head -1` instrument could grab the sibling and falsely PASS. The probe
    // must select by cwd and WARN.
    const reader = fakeReader({
      '10': { cwd: '/w/sibling', cmdline: ['claude'], environ: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://mon:4318' } },
      '20': { cwd: '/w/macf', cmdline: ['claude'], environ: { MACF_AGENT_NAME: 'code-agent' } },
    });
    const res = checkOtelLaunchBoundary('/w/macf', reader);
    expect(res.status).toBe('WARN');
    expect(res.detail).toContain('pid 20');
  });

  it('normalises a trailing-slash workspace path before comparing', () => {
    const reader = fakeReader({
      '1': { cwd: '/w/macf', cmdline: ['claude'], environ: { OTEL_EXPORTER_OTLP_ENDPOINT: 'x' } },
    });
    expect(checkOtelLaunchBoundary('/w/macf/', reader).status).toBe('PASS');
  });

  it('ignores channel-server processes (probe targets claude only)', () => {
    const reader = fakeReader({
      '1': {
        cwd: '/w/macf',
        cmdline: ['node', '/x/@groundnuty/macf-channel-server/dist/server.js'],
        environ: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://mon:4318' },
      },
    });
    // Only a channel-server runs in this cwd; no claude → INFO (skip).
    expect(checkOtelLaunchBoundary('/w/macf', reader).status).toBe('INFO');
  });
});
