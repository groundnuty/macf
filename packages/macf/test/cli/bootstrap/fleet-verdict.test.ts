/**
 * Tests for `fleet-verdict.ts` — the fleet-level VERDICT `apply` reports at
 * the end of a run (groundnuty/macf#1184, "a fleet that cannot route is
 * reported as 'provisioned'"). The decisive pair, per the issue's own test
 * requirement:
 *
 *   1. every component confirmed -> reports success
 *   2. ANY component unconfirmed -> does NOT, and names which
 *
 * Plus: `unknown` behaves as (2), never as (1) — the honest-unknown floor.
 * Per `assert-the-wrong-path.md`, (1) alone would be satisfied by a
 * function that ALWAYS claims success — every test below that asserts (1)
 * has a (2)-shaped sibling proving the render can actually say NOT
 * confirmed.
 */
import { describe, it, expect } from 'vitest';
import {
  determineFleetVerdict,
  fleetVerdictToJson,
  formatFleetVerdictLines,
  routingVerdictComponent,
  runnerVerdictComponent,
  workspaceVerdictComponent,
} from '../../../src/cli/bootstrap/fleet-verdict.js';
import type { FleetVerdictComponent } from '../../../src/cli/bootstrap/fleet-verdict.js';
import { ALL_ROUTING_SECRET_NAMES } from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import type { RoutingSecretsPublishResult } from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import type { EnsureVariableOutcome } from '../../../src/cli/bootstrap/ensure-variable.js';
import type { RemainingDeployReport } from '../../../src/cli/bootstrap/remaining-deploy.js';

const CONFIRMED: FleetVerdictComponent = { name: 'x', status: { state: 'confirmed', detail: '' } };
const NOT_CONFIRMED: FleetVerdictComponent = { name: 'y', status: { state: 'not-confirmed', detail: 'y is missing' } };
const UNKNOWN: FleetVerdictComponent = { name: 'z', status: { state: 'unknown', detail: 'z could not be determined' } };

// --- determineFleetVerdict (generic reduction) ---

describe('determineFleetVerdict (pure, generic)', () => {
  it('DECISIVE 1/2: every component confirmed -> confirmed: true, unconfirmed: []', () => {
    const verdict = determineFleetVerdict([CONFIRMED, { ...CONFIRMED, name: 'w' }]);
    expect(verdict.confirmed).toBe(true);
    expect(verdict.unconfirmed).toEqual([]);
  });

  it('DECISIVE 2/2: any component not-confirmed -> confirmed: false, naming which', () => {
    const verdict = determineFleetVerdict([CONFIRMED, NOT_CONFIRMED]);
    expect(verdict.confirmed).toBe(false);
    expect(verdict.unconfirmed).toEqual([NOT_CONFIRMED]);
  });

  it('unknown behaves as (2), never as (1) — an indeterminate claim is never treated as a working one', () => {
    const verdict = determineFleetVerdict([CONFIRMED, UNKNOWN]);
    expect(verdict.confirmed).toBe(false);
    expect(verdict.unconfirmed).toEqual([UNKNOWN]);
  });

  it('an empty component list is vacuously confirmed — nothing to contradict a positive claim', () => {
    expect(determineFleetVerdict([])).toEqual({ confirmed: true, components: [], unconfirmed: [] });
  });

  it('multiple unconfirmed components are ALL named, not just the first', () => {
    const verdict = determineFleetVerdict([NOT_CONFIRMED, UNKNOWN]);
    expect(verdict.unconfirmed).toHaveLength(2);
  });
});

// --- routingVerdictComponent ---

/** Every one of the six legs given `status` for every repo — mirrors `apply-routing-secrets.test.ts`'s own `resultWith` shape, generalized to any single uniform status. */
function routingResultWith(repos: readonly string[], leg: EnsureVariableOutcome): RoutingSecretsPublishResult {
  const result = {} as Record<string, Record<string, EnsureVariableOutcome>>;
  for (const name of ALL_ROUTING_SECRET_NAMES) {
    result[name] = Object.fromEntries(repos.map((r) => [r, leg]));
  }
  return result as RoutingSecretsPublishResult;
}

describe('routingVerdictComponent', () => {
  it('zero router-carrying repos observed -> unknown (honest-unknown floor, never confirmed)', () => {
    const empty = {} as Record<string, Record<string, EnsureVariableOutcome>>;
    for (const name of ALL_ROUTING_SECRET_NAMES) empty[name] = {};
    const c = routingVerdictComponent(empty as RoutingSecretsPublishResult);
    expect(c.status.state).toBe('unknown');
  });

  it('every repo has every leg created/already-present -> confirmed', () => {
    const c = routingVerdictComponent(routingResultWith(['o/a', 'o/b'], { status: 'already-present' }));
    expect(c.status.state).toBe('confirmed');
  });

  it('groundnuty/macf#1184 regression: a whole-bag SKIPPED leg (the macf-trial signature) -> NOT confirmed, not silently "confirmed"', () => {
    const c = routingVerdictComponent(routingResultWith(['o/a', 'o/b', 'o/c'], { status: 'skipped', reason: 'batched vault write not yet landed' }));
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('batched vault write not yet landed');
    expect(c.status.detail).toContain('3 of 3');
  });

  it('a genuine FAILED leg -> not-confirmed, naming the reason', () => {
    const c = routingVerdictComponent(routingResultWith(['o/a'], { status: 'failed', reason: 'router App identity unresolved' }));
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('router App identity unresolved');
  });
});

// --- runnerVerdictComponent ---

describe('runnerVerdictComponent', () => {
  it('empty routing map (self-hosted runner not declared) -> undefined (N/A, excluded from the verdict)', () => {
    expect(runnerVerdictComponent({})).toBeUndefined();
  });

  it('every repo "created" (a live check confirmed a usable runner THIS run) -> confirmed', () => {
    const c = runnerVerdictComponent({ 'o/a': { status: 'created' }, 'o/b': { status: 'created' } });
    expect(c?.status.state).toBe('confirmed');
  });

  it('reviewer-flagged regression guard: every repo "already-present" -> UNKNOWN, never "confirmed" — an inherited-from-an-earlier-run write proves nothing about THIS run', () => {
    const c = runnerVerdictComponent({ 'o/a': { status: 'already-present' }, 'o/b': { status: 'already-present' } });
    expect(c?.status.state).toBe('unknown');
    expect(c?.status.state).not.toBe('confirmed');
    expect(c?.status.detail).toContain('not re-checked this run');
  });

  it('the exact macf-trial signature — every repo failed/skipped, zero runners registered -> not-confirmed, naming the gap explicitly (never rendered identically to "cannot see runners")', () => {
    const c = runnerVerdictComponent({
      'o/a': { status: 'failed', reason: 'no usable runner registered' },
      'o/b': { status: 'skipped', reason: 'no runner token this run' },
    });
    expect(c?.status.state).toBe('not-confirmed');
    expect(c?.status.detail).toContain('NO confirmed self-hosted runner');
  });

  it('groundnuty/macf#1212: a "pending" leg is named explicitly as pending, never folded silently into "failed"', () => {
    const c = runnerVerdictComponent({ 'o/a': { status: 'pending', reason: 'still within the bounded wait' } });
    expect(c?.status.state).toBe('not-confirmed');
    expect(c?.status.detail).toContain('pending');
    expect(c?.status.detail).not.toContain('NO confirmed'); // the failed/skipped wording must not also fire
  });
});

// --- workspaceVerdictComponent ---

describe('workspaceVerdictComponent', () => {
  it('empty steps (every declared agent already deployed, or none declared) -> confirmed', () => {
    expect(workspaceVerdictComponent({ steps: [] }).status.state).toBe('confirmed');
  });

  it('a "not-deployed" step -> not-confirmed, naming the role', () => {
    const report: RemainingDeployReport = {
      steps: [{ role: 'code-agent', deployPath: '/x/code-agent', presence: 'not-deployed', command: 'macf fleet deploy --agent code-agent' }],
    };
    const c = workspaceVerdictComponent(report);
    expect(c.status.state).toBe('not-confirmed');
    expect(c.status.detail).toContain('code-agent');
  });

  it('only "unknown" steps (multi-host, unverifiable from here) -> unknown, not not-confirmed', () => {
    const report: RemainingDeployReport = {
      steps: [{ role: 'code-agent', deployPath: '/x/code-agent', presence: 'unknown', reason: 'parent dir absent', command: 'macf fleet deploy --agent code-agent' }],
    };
    expect(workspaceVerdictComponent(report).status.state).toBe('unknown');
  });

  it('a confidently-not-deployed step OUTRANKS an unrelated unknown one — weakest-claim rule', () => {
    const report: RemainingDeployReport = {
      steps: [
        { role: 'code-agent', deployPath: '/x/code-agent', presence: 'not-deployed', command: 'cmd-1' },
        { role: 'science-agent', deployPath: '/x/science-agent', presence: 'unknown', reason: 'parent dir absent', command: 'cmd-2' },
      ],
    };
    expect(workspaceVerdictComponent(report).status.state).toBe('not-confirmed');
  });
});

// --- formatFleetVerdictLines + fleetVerdictToJson (render, decisive pair through the SAME computation) ---

describe('formatFleetVerdictLines / fleetVerdictToJson', () => {
  it('DECISIVE 1/2: every component confirmed -> a success line, mentioning every checked area', () => {
    const verdict = determineFleetVerdict([{ ...CONFIRMED, name: 'routing' }, { ...CONFIRMED, name: 'workspaces' }]);
    const lines = formatFleetVerdictLines(verdict);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('confirmed');
    expect(lines[0]).toContain('routing');
    expect(lines[0]).toContain('workspaces');
    expect(lines[0]).not.toContain('NOT confirmed');

    const json = fleetVerdictToJson(verdict) as { confirmed: boolean; components: readonly unknown[] };
    expect(json.confirmed).toBe(true);
  });

  it('DECISIVE 2/2: any component unconfirmed -> NOT a success line, naming which component(s) and why', () => {
    const verdict = determineFleetVerdict([
      { ...CONFIRMED, name: 'workspaces' },
      { name: 'routing', status: { state: 'not-confirmed', detail: 'zero routing secrets on any repo' } },
    ]);
    const lines = formatFleetVerdictLines(verdict);
    const joined = lines.join('\n');
    expect(joined).toContain('NOT confirmed');
    expect(joined).toContain('routing');
    expect(joined).toContain('zero routing secrets on any repo');
    // The word "provisioned" as a POSITIVE claim must never appear in the
    // verdict render — groundnuty/macf#1184's core ask.
    expect(joined).not.toMatch(/\bis provisioned\b/);

    const json = fleetVerdictToJson(verdict) as { confirmed: boolean; components: readonly { name: string; state: string }[] };
    expect(json.confirmed).toBe(false);
    expect(json.components.find((c) => c.name === 'routing')?.state).toBe('not-confirmed');
  });

  it('unknown behaves as (2) at the render layer too — UNKNOWN is tagged distinctly from NOT CONFIRMED', () => {
    const verdict = determineFleetVerdict([{ ...CONFIRMED, name: 'workspaces' }, { name: 'routing', status: { state: 'unknown', detail: 'no repos observed' } }]);
    const lines = formatFleetVerdictLines(verdict);
    const joined = lines.join('\n');
    expect(joined).toContain('NOT confirmed working'); // the headline still fires
    expect(joined).toContain('UNKNOWN');
    expect(joined).not.toContain('routing: NOT CONFIRMED'); // tagged UNKNOWN, not the stronger NOT CONFIRMED tag
  });

  it('nothing checked at all (empty components) -> no lines, no key — never a content-free banner', () => {
    const verdict = determineFleetVerdict([]);
    expect(formatFleetVerdictLines(verdict)).toEqual([]);
    expect(fleetVerdictToJson(verdict)).toBeUndefined();
  });

  it('citation-guard: no internal issue/DR references leak into the rendered lines — comments may cite them, output may not', () => {
    const verdicts = [
      determineFleetVerdict([{ ...CONFIRMED, name: 'routing' }]),
      determineFleetVerdict([{ name: 'routing', status: { state: 'not-confirmed', detail: 'zero routing secrets on any repo' } }]),
      determineFleetVerdict([{ name: 'runners', status: { state: 'unknown', detail: 'no repos observed' } }]),
    ];
    const issueRefPattern = /#\d+|DR-\d+/i;
    for (const v of verdicts) {
      expect(formatFleetVerdictLines(v).join('\n')).not.toMatch(issueRefPattern);
    }
  });
});

// --- The exact macf-trial scenario end to end, through the public API surface ---

describe('the macf-trial scenario (groundnuty/macf#1184\'s own reproduction)', () => {
  it('all six routing legs whole-bag-skipped + zero runners registered + no local workspace -> the verdict names all three, and is never "confirmed"', () => {
    const routingSecrets = routingResultWith(
      ['groundnuty/macf-trial-code-agent', 'groundnuty/macf-trial-science-agent'],
      { status: 'skipped', reason: 'router App/routing-client cert freshly minted this run; vault write not yet confirmed' },
    );
    const routing: Readonly<Record<string, EnsureVariableOutcome>> = {
      'groundnuty/macf-trial-code-agent': { status: 'failed', reason: 'no usable runner registered' },
      'groundnuty/macf-trial-science-agent': { status: 'failed', reason: 'no usable runner registered' },
    };
    const remainingDeploy: RemainingDeployReport = {
      steps: [
        { role: 'code-agent', deployPath: '/x/code-agent', presence: 'not-deployed', command: 'macf fleet deploy --agent code-agent' },
        { role: 'science-agent', deployPath: '/x/science-agent', presence: 'not-deployed', command: 'macf fleet deploy --agent science-agent' },
      ],
    };

    const runnerComponent = runnerVerdictComponent(routing);
    const verdict = determineFleetVerdict([routingVerdictComponent(routingSecrets), ...(runnerComponent !== undefined ? [runnerComponent] : []), workspaceVerdictComponent(remainingDeploy)]);

    expect(verdict.confirmed).toBe(false);
    expect(verdict.unconfirmed.map((c) => c.name).sort()).toEqual(['routing', 'runners', 'workspaces']);
    const rendered = formatFleetVerdictLines(verdict).join('\n');
    expect(rendered).not.toMatch(/\bis provisioned\b/);
    expect(rendered).toContain('routing');
    expect(rendered).toContain('runners');
    expect(rendered).toContain('workspaces');
  });

  it('the positive twin: every leg created, every runner confirmed, every workspace present -> confirmed, no missing-piece line', () => {
    const routingSecrets = routingResultWith(['groundnuty/macf-trial-code-agent'], { status: 'created' });
    const routing: Readonly<Record<string, EnsureVariableOutcome>> = { 'groundnuty/macf-trial-code-agent': { status: 'created' } };
    const remainingDeploy: RemainingDeployReport = { steps: [] };

    const runnerComponent = runnerVerdictComponent(routing);
    const verdict = determineFleetVerdict([routingVerdictComponent(routingSecrets), ...(runnerComponent !== undefined ? [runnerComponent] : []), workspaceVerdictComponent(remainingDeploy)]);

    expect(verdict.confirmed).toBe(true);
    expect(verdict.unconfirmed).toEqual([]);
    expect(formatFleetVerdictLines(verdict).join('\n')).not.toContain('NOT confirmed');
  });
});
