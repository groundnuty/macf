/**
 * Unit tests for the runtime-agnostic fleet reconciler (DR-037 / macf#686). The
 * acceptance oracle is the devops reference `fleet/reconcile.sh` + its 52-case
 * suite (`test-reconcile.sh`); these port the BEHAVIORAL cases onto the
 * FleetDriver seam — a FAKE driver (no real tmux/probe), an in-memory state
 * store, and a virtual clock, so every ladder / gate / backoff / stagger path is
 * exercised deterministically without any runtime side effects.
 *
 * Behavioral coverage (mapping the shell oracle onto the driver seam):
 *   - decision engine: OK / LAUNCH / SKIP / HEAL + exit codes
 *   - exit-code intent: last-exit==0 → SKIP (desired-down); !=0/absent → LAUNCH
 *   - aliveness-gate: a BUSY agent is NEVER restarted
 *   - tiered ladder: sweep-1 Tier-1 inject → sweep-2+ Tier-2 restart → Tier-3 alert
 *   - restart-backoff: a repeatedly-failing agent is NOT restart-stormed (exponential)
 *   - stuck-in-backoff escalation → Tier-3 alert (not a restart)
 *   - launch-stagger: N dead agents → spaced cold-start launches
 *   - self-heartbeat emitted (execute-only)
 *   - dry-run plans-without-acting; --execute acts
 */
import { describe, it, expect } from 'vitest';
import {
  reconcileFleet,
  resolveReconcileConfig,
  classifyReachability,
  nextBackoffMs,
  parseDesiredAgents,
  EMPTY_RECONCILE_STATE,
  DEFAULT_RECONCILE_CONFIG,
  type DesiredAgent,
  type FleetDriver,
  type FleetState,
  type FleetAgentState,
  type HealthResponse,
  type ReconcileAgentState,
  type ReconcileConfig,
  type ReconcileDeps,
  type ReconcileHeartbeat,
  type ReconcileStateStore,
  type WorkspaceRecord,
} from '../src/index.js';

// --- fixtures ---------------------------------------------------------------

function mkHealth(): HealthResponse {
  return {
    agent: 'a',
    status: 'online',
    type: 'permanent',
    uptime_seconds: 5,
    current_issue: null,
    version: '0.2.41',
    last_notification: null,
  };
}

/** A FleetState agent — `online:true` = reachable, `false` = deaf, absent = not present. */
function agentState(name: string, online: boolean): FleetAgentState {
  return { name, host: 'h', port: 4000, online, version: online ? '0.2.41' : null, health: online ? mkHealth() : null };
}

function fleet(...agents: FleetAgentState[]): FleetState {
  return { agents };
}

const DESIRED: readonly DesiredAgent[] = [
  { agent: 'devops-agent', workspace: '/w/devops' },
  { agent: 'science-agent', workspace: '/w/science' },
  { agent: 'code-agent', workspace: '/w/macf' },
];

// --- fakes ------------------------------------------------------------------

interface DriverCalls {
  launched: string[];
  injected: { agent: string; text: string }[];
  restarted: string[];
  busyChecks: string[];
}

interface FakeDriverOpts {
  readonly probe: FleetState | (() => Promise<FleetState>);
  readonly busy?: ReadonlySet<string>;
  readonly workspaces?: readonly WorkspaceRecord[];
}

function fakeDriver(o: FakeDriverOpts): { driver: FleetDriver; calls: DriverCalls } {
  const calls: DriverCalls = { launched: [], injected: [], restarted: [], busyChecks: [] };
  const busy = o.busy ?? new Set<string>();
  const driver: FleetDriver = {
    probe: typeof o.probe === 'function' ? o.probe : async () => o.probe,
    discoverWorkspaces: () => o.workspaces ?? [],
    isBusy: async (agent: string) => {
      calls.busyChecks.push(agent);
      return busy.has(agent);
    },
    upgrade: async () => {},
    restart: async (agent: string) => void calls.restarted.push(agent),
    inject: async (agent: string, text: string) => void calls.injected.push({ agent, text }),
    launch: async (agent: string) => void calls.launched.push(agent),
  };
  return { driver, calls };
}

interface StoreCalls {
  writes: { agent: string; state: ReconcileAgentState }[];
  resets: string[];
}

function memStore(
  seed: Readonly<Record<string, Partial<ReconcileAgentState>>> = {},
): { store: ReconcileStateStore; calls: StoreCalls } {
  const data = new Map<string, ReconcileAgentState>();
  for (const [k, v] of Object.entries(seed)) data.set(k, { ...EMPTY_RECONCILE_STATE, ...v });
  const calls: StoreCalls = { writes: [], resets: [] };
  const store: ReconcileStateStore = {
    read: (agent) => data.get(agent) ?? EMPTY_RECONCILE_STATE,
    write: (agent, state) => {
      data.set(agent, state);
      calls.writes.push({ agent, state });
    },
    reset: (agent) => {
      const cur = data.get(agent) ?? EMPTY_RECONCILE_STATE;
      data.set(agent, { ...EMPTY_RECONCILE_STATE, lastExit: cur.lastExit, paused: cur.paused });
      calls.resets.push(agent);
    },
  };
  return { store, calls };
}

interface Harness {
  readonly deps: ReconcileDeps;
  readonly calls: DriverCalls;
  readonly storeCalls: StoreCalls;
  readonly logs: string[];
  readonly alerts: { agent: string; reason: string }[];
  readonly heartbeats: ReconcileHeartbeat[];
  readonly sleeps: number[];
  setNow: (n: number) => void;
}

function harness(driverOpts: FakeDriverOpts, seed?: Record<string, Partial<ReconcileAgentState>>): Harness {
  const { driver, calls } = fakeDriver(driverOpts);
  const { store, calls: storeCalls } = memStore(seed);
  const logs: string[] = [];
  const alerts: { agent: string; reason: string }[] = [];
  const heartbeats: ReconcileHeartbeat[] = [];
  const sleeps: number[] = [];
  let nowMs = 1_000_000;
  const deps: ReconcileDeps = {
    driver,
    store,
    now: () => nowMs,
    sleep: async (ms) => void sleeps.push(ms),
    alert: async (agent, reason) => void alerts.push({ agent, reason }),
    heartbeat: async (info) => void heartbeats.push(info),
    log: (line) => void logs.push(line),
  };
  return { deps, calls, storeCalls, logs, alerts, heartbeats, sleeps, setNow: (n) => (nowMs = n) };
}

/** The last decision for an agent in a result. */
function decisionOf(rows: readonly { agent: string; decision: string }[], agent: string): string | undefined {
  return rows.find((r) => r.agent === agent)?.decision;
}

const cfg = (o?: Partial<ReconcileConfig>): ReconcileConfig => resolveReconcileConfig(o);

// --- pure helpers -----------------------------------------------------------

describe('classifyReachability', () => {
  it('absent when the agent is not in the roster', () => {
    expect(classifyReachability(fleet(agentState('a', true)), 'ghost')).toBe('absent');
  });
  it('reachable when present + online', () => {
    expect(classifyReachability(fleet(agentState('a', true)), 'a')).toBe('reachable');
  });
  it('deaf when present but offline', () => {
    expect(classifyReachability(fleet(agentState('a', false)), 'a')).toBe('deaf');
  });
});

describe('nextBackoffMs', () => {
  it('is 0 for <= 0 attempts', () => {
    expect(nextBackoffMs(0, DEFAULT_RECONCILE_CONFIG)).toBe(0);
    expect(nextBackoffMs(-1, DEFAULT_RECONCILE_CONFIG)).toBe(0);
  });
  it('doubles per attempt (base * 2^(n-1))', () => {
    const c = cfg({ backoffBaseMs: 1000, backoffMaxMs: 1_000_000 });
    expect(nextBackoffMs(1, c)).toBe(1000);
    expect(nextBackoffMs(2, c)).toBe(2000);
    expect(nextBackoffMs(3, c)).toBe(4000);
  });
  it('clamps at backoffMaxMs', () => {
    const c = cfg({ backoffBaseMs: 1000, backoffMaxMs: 3000 });
    expect(nextBackoffMs(5, c)).toBe(3000);
  });
});

describe('parseDesiredAgents', () => {
  it('pairs agent/workspace, strips comments + quotes, ignores header/comments', () => {
    const text = [
      '# desired-agents.yaml',
      'agents:',
      '  - agent: devops-agent',
      '    workspace: /home/ubuntu/repos/groundnuty/macf-devops-toolkit',
      '  # code-agent lives in the framework repo',
      '  - agent: "code-agent"   # quoted + trailing comment',
      "    workspace: '/home/ubuntu/repos/groundnuty/macf'",
      '',
    ].join('\n');
    expect(parseDesiredAgents(text)).toEqual([
      { agent: 'devops-agent', workspace: '/home/ubuntu/repos/groundnuty/macf-devops-toolkit' },
      { agent: 'code-agent', workspace: '/home/ubuntu/repos/groundnuty/macf' },
    ]);
  });
  it('returns [] for an empty manifest', () => {
    expect(parseDesiredAgents('agents:\n')).toEqual([]);
  });
});

// --- decision engine --------------------------------------------------------

describe('reconcileFleet — decision engine', () => {
  it('reachable + accepting → OK, rc 0 when all healthy', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', true), agentState('science-agent', true), agentState('code-agent', true)) });
    const r = await reconcileFleet(DESIRED, h.deps, cfg());
    expect(r.rows.map((x) => x.decision)).toEqual(['OK', 'OK', 'OK']);
    expect(r.rc).toBe(0);
  });

  it('paused → SKIP (desired-down), not resurrected', async () => {
    const h = harness({ probe: fleet(agentState('science-agent', true), agentState('code-agent', true)) }, { 'devops-agent': { paused: true } });
    const r = await reconcileFleet(DESIRED, h.deps, cfg());
    expect(decisionOf(r.rows, 'devops-agent')).toBe('SKIP');
    expect(h.calls.launched).toEqual([]);
  });

  it('deaf → HEAL, absent → LAUNCH, present → OK (mixed), rc 1', async () => {
    // devops deaf, science reachable, code absent.
    const h = harness({ probe: fleet(agentState('devops-agent', false), agentState('science-agent', true)) });
    const r = await reconcileFleet(DESIRED, h.deps, cfg());
    expect(decisionOf(r.rows, 'devops-agent')).toBe('HEAL');
    expect(decisionOf(r.rows, 'science-agent')).toBe('OK');
    expect(decisionOf(r.rows, 'code-agent')).toBe('LAUNCH');
    expect(r.rc).toBe(1);
  });

  it('a probe failure fails loud → rc 2, no rows', async () => {
    const h = harness({ probe: async () => { throw new Error('registry unreachable'); } });
    const r = await reconcileFleet(DESIRED, h.deps, cfg());
    expect(r.rc).toBe(2);
    expect(r.rows).toEqual([]);
    expect(h.logs.some((l) => l.includes('FATAL: fleet probe failed'))).toBe(true);
  });
});

// --- exit-code intent -------------------------------------------------------

describe('reconcileFleet — exit-code intent (B.1/B.2)', () => {
  const oneAbsent: readonly DesiredAgent[] = [{ agent: 'code-agent', workspace: '/w/macf' }];

  it('absent + last-exit==0 (operator /exit) → SKIP, desired-down', async () => {
    const h = harness({ probe: fleet() }, { 'code-agent': { lastExit: 0 } });
    const r = await reconcileFleet(oneAbsent, h.deps, cfg({ execute: true }));
    expect(decisionOf(r.rows, 'code-agent')).toBe('SKIP');
    expect(h.calls.launched).toEqual([]);
  });

  it('absent + last-exit==143 (SIGTERM) → LAUNCH', async () => {
    const h = harness({ probe: fleet() }, { 'code-agent': { lastExit: 143 } });
    const r = await reconcileFleet(oneAbsent, h.deps, cfg({ execute: true }));
    expect(decisionOf(r.rows, 'code-agent')).toBe('LAUNCH');
    expect(h.calls.launched).toEqual(['code-agent']);
  });

  it('absent + no last-exit (never ran) → LAUNCH', async () => {
    const h = harness({ probe: fleet() });
    const r = await reconcileFleet(oneAbsent, h.deps, cfg({ execute: true }));
    expect(decisionOf(r.rows, 'code-agent')).toBe('LAUNCH');
    expect(h.calls.launched).toEqual(['code-agent']);
  });
});

// --- dry-run vs execute -----------------------------------------------------

describe('reconcileFleet — dry-run plans without acting', () => {
  it('LAUNCH dry-run does NOT call driver.launch or write state or heartbeat', async () => {
    const h = harness({ probe: fleet() }, { 'code-agent': { lastExit: 143 } });
    await reconcileFleet([{ agent: 'code-agent', workspace: '/w/macf' }], h.deps, cfg());
    expect(h.calls.launched).toEqual([]);
    expect(h.storeCalls.writes).toEqual([]);
    expect(h.heartbeats).toEqual([]);
  });

  it('HEAL sweep-1 dry-run prints Tier-1 but does NOT inject', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', false)) });
    await reconcileFleet([{ agent: 'devops-agent', workspace: '/w/devops' }], h.deps, cfg());
    expect(h.logs.some((l) => l.includes('first deaf sweep → Tier-1'))).toBe(true);
    expect(h.calls.injected).toEqual([]);
    expect(h.storeCalls.writes).toEqual([]);
  });
});

describe('reconcileFleet — --execute acts', () => {
  it('LAUNCH execute calls driver.launch', async () => {
    const h = harness({ probe: fleet() }, { 'code-agent': { lastExit: 143 } });
    await reconcileFleet([{ agent: 'code-agent', workspace: '/w/macf' }], h.deps, cfg({ execute: true }));
    expect(h.calls.launched).toEqual(['code-agent']);
  });

  it('HEAL sweep-1 execute injects the Tier-1 nudge + writes deafSweeps=1', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', false)) });
    await reconcileFleet([{ agent: 'devops-agent', workspace: '/w/devops' }], h.deps, cfg({ execute: true }));
    expect(h.calls.injected.map((x) => x.agent)).toEqual(['devops-agent']);
    expect(h.storeCalls.writes.at(-1)?.state.deafSweeps).toBe(1);
  });

  it('reachable execute resets escalation state (recovery)', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', true)) }, { 'devops-agent': { deafSweeps: 2, alertOpen: true } });
    await reconcileFleet([{ agent: 'devops-agent', workspace: '/w/devops' }], h.deps, cfg({ execute: true }));
    expect(h.storeCalls.resets).toEqual(['devops-agent']);
  });
});

// --- cross-sweep escalation ladder ------------------------------------------

describe('reconcileFleet — cross-sweep escalation', () => {
  const oneDeaf: readonly DesiredAgent[] = [{ agent: 'devops-agent', workspace: '/w/devops' }];

  it('sweep 1 (no prior state) → Tier-1 first deaf sweep, not escalation', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', false)) });
    await reconcileFleet(oneDeaf, h.deps, cfg());
    expect(h.logs.some((l) => l.includes('first deaf sweep → Tier-1'))).toBe(true);
    expect(h.logs.some((l) => l.includes('escalate'))).toBe(false);
  });

  it('sweep 2 (deafSweeps=1) → escalate, not re-inject', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', false)) }, { 'devops-agent': { deafSweeps: 1 } });
    await reconcileFleet(oneDeaf, h.deps, cfg());
    expect(h.logs.some((l) => l.includes('still deaf after 1 prior sweep'))).toBe(true);
    expect(h.calls.injected).toEqual([]);
  });
});

// --- Tier-2 gating ----------------------------------------------------------

describe('reconcileFleet — Tier-2 restart gating', () => {
  const oneDeaf: readonly DesiredAgent[] = [{ agent: 'devops-agent', workspace: '/w/devops' }];

  it('escalation without --allow-restart → SUPPRESSED, no restart, Tier-3 alert', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', false)) }, { 'devops-agent': { deafSweeps: 1 } });
    await reconcileFleet(oneDeaf, h.deps, cfg({ execute: true }));
    expect(h.logs.some((l) => l.includes('SUPPRESSED (no --allow-restart'))).toBe(true);
    expect(h.calls.restarted).toEqual([]);
    expect(h.alerts).toHaveLength(1);
  });

  it('escalation dry-run WITH --allow-restart constructs the restart line, does not act', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', false)) }, { 'devops-agent': { deafSweeps: 1 } });
    await reconcileFleet(oneDeaf, h.deps, cfg({ allowRestart: true }));
    expect(h.logs.some((l) => l.includes('Tier-2 graceful-restart devops-agent'))).toBe(true);
    expect(h.calls.restarted).toEqual([]);
  });

  it('escalation execute WITH --allow-restart → driver.restart + backoff set + Tier-3 alert', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', false)) }, { 'devops-agent': { deafSweeps: 1 } });
    h.setNow(5_000);
    await reconcileFleet(oneDeaf, h.deps, cfg({ execute: true, allowRestart: true, backoffBaseMs: 1000 }));
    expect(h.calls.restarted).toEqual(['devops-agent']);
    const w = h.storeCalls.writes.find((x) => x.state.restartAttempts === 1);
    expect(w?.state.backoffUntil).toBe(5_000 + 1000);
    expect(h.alerts.some((a) => a.reason.includes('restarted after'))).toBe(true);
  });
});

// --- aliveness-gate ---------------------------------------------------------

describe('reconcileFleet — aliveness-gate (never restart a busy agent)', () => {
  it('a BUSY deaf agent at escalation is NOT restarted (#642 mode)', async () => {
    const h = harness(
      { probe: fleet(agentState('devops-agent', false)), busy: new Set(['devops-agent']) },
      { 'devops-agent': { deafSweeps: 1 } },
    );
    await reconcileFleet([{ agent: 'devops-agent', workspace: '/w/devops' }], h.deps, cfg({ execute: true, allowRestart: true }));
    expect(h.calls.busyChecks).toContain('devops-agent');
    expect(h.calls.restarted).toEqual([]);
    expect(h.logs.some((l) => l.includes('pane ACTIVE'))).toBe(true);
    expect(h.alerts.some((a) => a.reason.includes('#642'))).toBe(true);
  });
});

// --- restart-backoff + stuck escalation -------------------------------------

describe('reconcileFleet — restart-backoff (no restart-storm)', () => {
  const oneDeaf: readonly DesiredAgent[] = [{ agent: 'devops-agent', workspace: '/w/devops' }];

  it('within the backoff window → restart suppressed (not stormed)', async () => {
    const h = harness(
      { probe: fleet(agentState('devops-agent', false)) },
      { 'devops-agent': { deafSweeps: 2, restartAttempts: 1, backoffUntil: 9_999_999 } },
    );
    h.setNow(1_000); // < backoffUntil
    await reconcileFleet(oneDeaf, h.deps, cfg({ execute: true, allowRestart: true }));
    expect(h.calls.restarted).toEqual([]);
    expect(h.logs.some((l) => l.includes('[BACKOFF]'))).toBe(true);
  });

  it('stuck in backoff (restartAttempts >= stuckMax) → Tier-3 alert, no restart', async () => {
    const h = harness(
      { probe: fleet(agentState('devops-agent', false)) },
      { 'devops-agent': { deafSweeps: 4, restartAttempts: 3, backoffUntil: 9_999_999 } },
    );
    h.setNow(1_000);
    await reconcileFleet(oneDeaf, h.deps, cfg({ execute: true, allowRestart: true, stuckMax: 3 }));
    expect(h.calls.restarted).toEqual([]);
    expect(h.logs.some((l) => l.includes('[STUCK]'))).toBe(true);
    expect(h.alerts.some((a) => a.reason.includes('stuck'))).toBe(true);
  });

  it('restarts exhausted with the window elapsed → escalate (Tier-3), do NOT restart again', async () => {
    const h = harness(
      { probe: fleet(agentState('devops-agent', false)) },
      { 'devops-agent': { deafSweeps: 4, restartAttempts: 3, backoffUntil: 0 } },
    );
    h.setNow(1_000_000); // window elapsed
    await reconcileFleet(oneDeaf, h.deps, cfg({ execute: true, allowRestart: true, stuckMax: 3 }));
    expect(h.calls.restarted).toEqual([]);
    expect(h.alerts.some((a) => a.reason.includes('did not recover'))).toBe(true);
  });
});

// --- launch-stagger ---------------------------------------------------------

describe('reconcileFleet — launch-stagger', () => {
  const threeDead: readonly DesiredAgent[] = [
    { agent: 'devops-agent', workspace: '/w/devops' },
    { agent: 'science-agent', workspace: '/w/science' },
    { agent: 'code-agent', workspace: '/w/macf' },
  ];

  it('execute spaces N cold-starts: N launches, N-1 stagger sleeps', async () => {
    const h = harness({ probe: fleet() });
    await reconcileFleet(threeDead, h.deps, cfg({ execute: true, launchStaggerMs: 15_000 }));
    expect(h.calls.launched).toEqual(['devops-agent', 'science-agent', 'code-agent']);
    expect(h.sleeps).toEqual([15_000, 15_000]); // first launch immediate, next two staggered
  });

  it('dry-run neither launches nor sleeps', async () => {
    const h = harness({ probe: fleet() });
    await reconcileFleet(threeDead, h.deps, cfg());
    expect(h.calls.launched).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });
});

// --- self-heartbeat ---------------------------------------------------------

describe('reconcileFleet — self-heartbeat', () => {
  it('execute emits a heartbeat carrying the sweep rc', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', true), agentState('science-agent', true), agentState('code-agent', true)) });
    const r = await reconcileFleet(DESIRED, h.deps, cfg({ execute: true }));
    expect(h.heartbeats).toHaveLength(1);
    expect(h.heartbeats[0]!.rc).toBe(r.rc);
  });

  it('dry-run does NOT emit a heartbeat (side-effect-free)', async () => {
    const h = harness({ probe: fleet(agentState('devops-agent', true), agentState('science-agent', true), agentState('code-agent', true)) });
    await reconcileFleet(DESIRED, h.deps, cfg());
    expect(h.heartbeats).toEqual([]);
  });
});

// --- Tier-3 dedup -----------------------------------------------------------

describe('reconcileFleet — Tier-3 alert dedup', () => {
  it('an already-open alert is not re-raised (dedup sentinel)', async () => {
    const h = harness(
      { probe: fleet(agentState('devops-agent', false)) },
      { 'devops-agent': { deafSweeps: 1, alertOpen: true } },
    );
    await reconcileFleet([{ agent: 'devops-agent', workspace: '/w/devops' }], h.deps, cfg({ execute: true }));
    expect(h.alerts).toEqual([]);
    expect(h.logs.some((l) => l.includes('already open (dedup)'))).toBe(true);
  });
});
