/**
 * Tests for `macf fleet resume` — DR-037 subcommand (macf#686), porting
 * devops-toolkit fleet/resume.sh + its 10-case test oracle (test-resume.sh).
 *
 * The decision layer `runFleetResume` is exercised against a FAKE `FleetDriver`
 * (no real tmux / processes / network) + fake alert / fire-counter seams, so the
 * match→dispatch→fire-cap→verify orchestration is fully unit-tested. Ported cases
 * (1:1 with the reference oracle):
 *   - idle + matched nudge-signature   → NUDGE plan (dry-run) / inject (execute).
 *   - idle + matched report-signature  → REPORT (durable alert), NEVER a nudge.
 *   - busy                             → skipped (working — even with a stall-string).
 *   - unmatched idle                   → idle-CLEAN, never touched (no spam).
 *   - no-session / gone                → skip (resume can't help; reconcile launches).
 *   - report fire-cap (max_fires=1)    → already reported this episode → skip.
 *   - nudge fire-cap reached           → escalate, not re-nudge.
 *   - verify-resumed: pane advanced    → RESUMED, reset the counter.
 *   - verify-resumed: still stuck      → back off (counter stays incremented).
 *   - dry-run                          → plans without acting (no inject/alert/write).
 */
import { describe, it, expect } from 'vitest';
import type {
  FleetDriver,
  FleetState,
  StallAction,
  StallSignatureEntry,
  WorkspaceRecord,
} from '@groundnuty/macf-core';
import {
  runFleetResume,
  formatResumeLine,
  type FleetResumeDeps,
  type ResumeAlertInput,
} from '../../src/cli/commands/fleet-resume.js';

// --- fixtures ---------------------------------------------------------------

const SIGS: readonly StallSignatureEntry[] = [
  { name: 'rate-limit', signature: '(temporarily limiting requests|Rate limited)', action: 'nudge', nudge: 'please continue', max_fires: 4 },
  { name: 'permission-prompt', signature: 'Do you want to proceed\\?', action: 'report', report: 'blocked on a permission prompt', max_fires: 1 },
  { name: 'trust-folder-prompt', signature: 'Do you trust the files in this folder\\?', action: 'report', report: 'blocked on a trust prompt', max_fires: 1 },
];

/** One fake agent's observable runtime: its pane, idle-gate, and post-nudge behaviour. */
interface FakeAgent {
  /** `capturePane` result — `null` models a gone/no-session agent. */
  readonly pane: string | null;
  /** `isBusy` idle-gate result (first call). Default false (idle). */
  readonly busy?: boolean;
  /** `isBusy` verify-resumed result (later calls): true = pane advanced = resumed. Default true. */
  readonly resumedAfterNudge?: boolean;
}

interface Rec {
  readonly logs: string[];
  readonly warns: string[];
  readonly injects: { agent: string; text: string }[];
  readonly alerts: ResumeAlertInput[];
  readonly counts: Map<string, number>;
  readonly cleared: string[];
  readonly isBusyCalls: Map<string, number>;
}

function build(
  agents: Record<string, FakeAgent>,
  over: Partial<FleetResumeDeps> = {},
  signatures: readonly StallSignatureEntry[] = SIGS,
): { deps: FleetResumeDeps; rec: Rec } {
  const rec: Rec = {
    logs: [], warns: [], injects: [], alerts: [],
    counts: new Map(), cleared: [], isBusyCalls: new Map(),
  };
  const records: WorkspaceRecord[] = Object.keys(agents).map((name) => ({
    agent: name, workspace: `/w/${name}`, registry: 'groundnuty', versionPin: null,
  }));
  const driver: FleetDriver = {
    probe: async (): Promise<FleetState> => ({ agents: [] }),
    discoverWorkspaces: () => records,
    isBusy: async (agent: string): Promise<boolean> => {
      const n = rec.isBusyCalls.get(agent) ?? 0;
      rec.isBusyCalls.set(agent, n + 1);
      const a = agents[agent];
      if (!a) return false;
      // Call 1 = idle-gate; later calls = verify-resumed (busy==resumed).
      return n === 0 ? (a.busy ?? false) : (a.resumedAfterNudge ?? true);
    },
    capturePane: async (agent: string): Promise<string | null> => agents[agent]?.pane ?? null,
    upgrade: async (): Promise<void> => {},
    restart: async (): Promise<void> => {},
    inject: async (agent: string, text: string): Promise<void> => { rec.injects.push({ agent, text }); },
    launch: async (): Promise<void> => {},
  };
  const deps: FleetResumeDeps = {
    driver,
    loadSignatures: () => signatures,
    alert: async (input: ResumeAlertInput) => { rec.alerts.push(input); return { created: true, ref: 'url#1' }; },
    readFireCount: (agent: string, kind: StallAction) => rec.counts.get(`${agent}:${kind}`) ?? 0,
    writeFireCount: (agent: string, kind: StallAction, count: number) => { rec.counts.set(`${agent}:${kind}`, count); },
    clearFireCounts: (agent: string) => {
      rec.cleared.push(agent);
      rec.counts.delete(`${agent}:nudge`);
      rec.counts.delete(`${agent}:report`);
    },
    log: (m: string) => rec.logs.push(m),
    warn: (m: string) => rec.warns.push(m),
    ...over,
  };
  return { deps, rec };
}

/** The decision line emitted for `agent` (first whitespace token == the agent name). */
function lineFor(rec: Rec, agent: string): string {
  return rec.logs.find((l) => l.split(/\s+/)[0] === agent) ?? '';
}

// --- ported oracle cases ----------------------------------------------------

describe('runFleetResume — dry-run (plan only)', () => {
  it('idle + matched nudge-signature → NUDGE plan, no inject', async () => {
    const { deps, rec } = build({ 't-rl': { pane: 'API Error · Rate limited ·' } });
    const code = await runFleetResume({ execute: false }, deps);
    expect(code).toBe(0);
    expect(lineFor(rec, 't-rl')).toContain('NUDGE (rate-limit)');
    expect(rec.injects).toHaveLength(0);
    expect(rec.counts.size).toBe(0);
  });

  it('idle + matched report-signature → REPORT plan (NOT auto-answered), no alert/inject', async () => {
    const { deps, rec } = build({ 't-blk': { pane: 'Do you want to proceed? ❯ 1. Yes' } });
    await runFleetResume({ execute: false }, deps);
    const line = lineFor(rec, 't-blk');
    expect(line).toContain('REPORT (permission-prompt)');
    expect(line).toContain('NOT auto-answered');
    expect(rec.injects).toHaveLength(0);
    expect(rec.alerts).toHaveLength(0);
  });

  it('dry-run plans without acting (no inject / no alert / no counter writes)', async () => {
    const { deps, rec } = build({
      't-rl': { pane: 'Rate limited' },
      't-blk': { pane: 'Do you want to proceed?' },
    });
    await runFleetResume({ execute: false }, deps);
    expect(rec.injects).toHaveLength(0);
    expect(rec.alerts).toHaveLength(0);
    expect(rec.counts.size).toBe(0);
    expect(rec.cleared).toHaveLength(0);
    expect(rec.logs.some((l) => l.includes('would be acted on (dry-run)'))).toBe(true);
  });
});

describe('runFleetResume — non-actionable states', () => {
  it('busy agent is skipped — even with a stall-string in the pane', async () => {
    const { deps, rec } = build({ 't-busy': { pane: 'Rate limited 4213', busy: true } });
    await runFleetResume({ execute: true }, deps);
    const line = lineFor(rec, 't-busy');
    expect(line).toContain('busy');
    expect(line).toContain('never interrupt');
    expect(rec.injects).toHaveLength(0);
  });

  it('unmatched idle → idle-CLEAN, never touched (no spam)', async () => {
    const { deps, rec } = build({ 't-clean': { pane: '❯ DR-032 ok, all green' } });
    await runFleetResume({ execute: true }, deps);
    const line = lineFor(rec, 't-clean');
    expect(line).toContain('idle-clean');
    expect(line).toContain('never touched');
    expect(rec.injects).toHaveLength(0);
    expect(rec.alerts).toHaveLength(0);
  });

  it('idle-CLEAN in execute mode resets the fire counters (episode ended)', async () => {
    const { deps, rec } = build({ 't-clean': { pane: 'nothing here' } });
    rec.counts.set('t-clean:nudge', 2);
    await runFleetResume({ execute: true }, deps);
    expect(rec.cleared).toContain('t-clean');
    expect(rec.counts.get('t-clean:nudge')).toBeUndefined();
  });

  it('no-session / gone → skip (resume can\'t help; reconcile launches)', async () => {
    const { deps, rec } = build({ 't-gone': { pane: null } });
    await runFleetResume({ execute: true }, deps);
    const line = lineFor(rec, 't-gone');
    expect(line).toContain('no-session');
    expect(line).toContain('gone');
    expect(rec.injects).toHaveLength(0);
    // capturePane==null short-circuits BEFORE the busy-window probe.
    expect(rec.isBusyCalls.get('t-gone') ?? 0).toBe(0);
  });
});

describe('runFleetResume — report dispatch (execute)', () => {
  it('report path raises a durable alert and NEVER injects', async () => {
    const { deps, rec } = build({ 't-blk': { pane: 'Do you want to proceed?' } });
    await runFleetResume({ execute: true }, deps);
    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0]).toMatchObject({ agent: 't-blk', signature: 'permission-prompt' });
    expect(rec.injects).toHaveLength(0);
    expect(rec.counts.get('t-blk:report')).toBe(1);
  });

  it('report fire-cap (max_fires=1) → already reported this episode → no new alert', async () => {
    const { deps, rec } = build({ 't-blk': { pane: 'Do you want to proceed?' } });
    rec.counts.set('t-blk:report', 1); // maxed
    await runFleetResume({ execute: true }, deps);
    expect(lineFor(rec, 't-blk')).toContain('already reported this episode');
    expect(rec.alerts).toHaveLength(0);
  });

  it('trust-folder prompt also dispatches to report', async () => {
    const { deps, rec } = build({ 't-trust': { pane: 'Do you trust the files in this folder? ❯ 1. Yes' } });
    await runFleetResume({ execute: false }, deps);
    expect(lineFor(rec, 't-trust')).toContain('REPORT (trust-folder-prompt)');
  });
});

describe('runFleetResume — nudge dispatch + verify-resumed (execute)', () => {
  it('nudge fire-cap reached → escalate, not re-nudge', async () => {
    const { deps, rec } = build({ 't-rl': { pane: 'Rate limited' } });
    rec.counts.set('t-rl:nudge', 4); // cap==4
    await runFleetResume({ execute: true }, deps);
    const line = lineFor(rec, 't-rl');
    expect(line).toContain('fire-cap');
    expect(line).toContain('escalate');
    expect(rec.injects).toHaveLength(0);
  });

  it('nudge + verify-resumed (pane advanced) → RESUMED, reset the counter', async () => {
    const { deps, rec } = build({ 't-rl': { pane: 'Rate limited', resumedAfterNudge: true } });
    await runFleetResume({ execute: true }, deps);
    expect(rec.injects).toHaveLength(1);
    expect(rec.injects[0]).toMatchObject({ agent: 't-rl', text: 'please continue' });
    expect(lineFor(rec, 't-rl')).toContain('RESUMED');
    expect(rec.counts.get('t-rl:nudge')).toBe(0); // reset on confirmed resume
  });

  it('nudge + still stuck (pane unchanged) → back off, counter stays incremented', async () => {
    const { deps, rec } = build({ 't-rl': { pane: 'Rate limited', resumedAfterNudge: false } });
    await runFleetResume({ execute: true }, deps);
    expect(rec.injects).toHaveLength(1);
    const line = lineFor(rec, 't-rl');
    expect(line).toContain('NOT confirmed');
    expect(line).toContain('back off');
    expect(rec.counts.get('t-rl:nudge')).toBe(1); // incremented, NOT reset
  });
});

describe('runFleetResume — robustness', () => {
  it('an invalid allowlist aborts loud (exit 2), acts on nothing', async () => {
    const { deps, rec } = build(
      { 't-rl': { pane: 'Rate limited' } },
      { loadSignatures: () => { throw new Error('bad regex'); } },
    );
    const code = await runFleetResume({ execute: true }, deps);
    expect(code).toBe(2);
    expect(rec.injects).toHaveLength(0);
    expect(rec.warns.some((w) => w.includes('allowlist is invalid'))).toBe(true);
  });

  it('processes a mixed fleet in one sweep, dedup by routing label', async () => {
    const { deps, rec } = build({
      't-clean': { pane: 'ok' },
      't-rl': { pane: 'Rate limited' },
      't-blk': { pane: 'Do you want to proceed?' },
      't-gone': { pane: null },
      't-busy': { pane: 'Rate limited', busy: true },
    });
    const code = await runFleetResume({ execute: true }, deps);
    expect(code).toBe(0);
    expect(rec.injects.map((i) => i.agent)).toEqual(['t-rl']);
    expect(rec.alerts.map((a) => a.agent)).toEqual(['t-blk']);
  });
});

describe('formatResumeLine', () => {
  it('leads with the agent name (first whitespace token)', () => {
    const line = formatResumeLine('code-agent', 'stalled', 'NUDGE');
    expect(line.split(/\s+/)[0]).toBe('code-agent');
    expect(line).toContain('stalled');
    expect(line).toContain('NUDGE');
  });
});
