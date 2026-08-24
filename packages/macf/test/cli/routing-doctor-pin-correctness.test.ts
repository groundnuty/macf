/**
 * Tests for the pin-CORRECTNESS axis (macf#872) — `routing-doctor-pin-
 * correctness.ts`'s pure classification functions + the `--manifest`-override /
 * control-repo-auto-discovery source resolution. Fully offline: the local-file
 * read uses a real temp file (cheap, deterministic); the "control repo" read is
 * always an injected fake, never `gh`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyPinState,
  evaluatePinCorrectness,
  pinClauseText,
  pinCorrectnessLine,
  pinCorrectnessWarning,
  resolveDesiredActionsPin,
} from '../../src/cli/commands/routing-doctor-pin-correctness.js';
import type { RepoPinRow, RoutingDoctorReport } from '../../src/cli/commands/routing-doctor.js';

/** A minimal valid `fleet.yaml` document — same shape as
 * `bootstrap/version-steering.test.ts`'s `baseManifest`, rendered as YAML text. */
function fleetYaml(over: { readonly project?: string; readonly actionsVersion?: string } = {}): string {
  const project = over.project ?? 'testfleet';
  const actions = over.actionsVersion ?? 'v3.4.2';
  return [
    'apiVersion: macf/v0',
    'kind: Fleet',
    'metadata:',
    `  name: ${project}`,
    'owner:',
    '  account: acme',
    '  type: user',
    '  registry:',
    '    type: profile',
    '    user: acme',
    'network:',
    '  advertise_host: example.ts.net',
    'transport:',
    '  age_recipients: []',
    'defaults:',
    '  role_template: acme/template',
    '  app_manifest: dr-019',
    'agents:',
    '  - role: code-agent',
    '    profile: code',
    `    repo: acme/${project}-code-agent`,
    `    deploy_path: /home/x/${project}-code-agent`,
    'versions:',
    '  macf: 0.2.58',
    `  actions: ${actions}`,
    '',
  ].join('\n');
}

/** A repo row, correctness-check-scoped defaults (participating, consistent). */
function row(over: Partial<RepoPinRow> = {}): RepoPinRow {
  return {
    repo: 'acme/testfleet-code-agent',
    pin: 'v3.4.2',
    status: 'pinned',
    fleetMember: true,
    consistent: true,
    correctness: 'unknown',
    ...over,
  };
}

function report(
  over: Partial<Pick<RoutingDoctorReport, 'repoPins' | 'desiredActionsPin' | 'expectedPin'>> = {},
): Pick<RoutingDoctorReport, 'repoPins' | 'desiredActionsPin' | 'expectedPin'> {
  return {
    repoPins: [row()],
    desiredActionsPin: null,
    expectedPin: 'v3.4.2',
    ...over,
  };
}

describe('evaluatePinCorrectness', () => {
  it('unknown when no authoritative desired pin is known, regardless of the observed pin', () => {
    expect(evaluatePinCorrectness('v3.4.2', null)).toBe('unknown');
    expect(evaluatePinCorrectness(null, null)).toBe('unknown');
  });
  it('correct on an exact match', () => {
    expect(evaluatePinCorrectness('v3.4.2', 'v3.4.2')).toBe('correct');
  });
  it('incorrect on a mismatch', () => {
    expect(evaluatePinCorrectness('v3.4.1', 'v3.4.2')).toBe('incorrect');
  });
  it('incorrect when the repo has no pin at all but a desired pin IS known', () => {
    expect(evaluatePinCorrectness(null, 'v3.4.2')).toBe('incorrect');
  });
  it('does NOT tolerate a floating pin as auto-correct — exact string equality only (mirrors bootstrap/plan.ts::actionsVersionItem)', () => {
    expect(evaluatePinCorrectness('v3', 'v3.4.2')).toBe('incorrect');
  });
});

describe('classifyPinState — the fleet-level composite (macf#872 "three states, not two")', () => {
  it('no-callers when nothing participates', () => {
    expect(classifyPinState(report({ repoPins: [row({ consistent: null, correctness: null })] }))).toBe(
      'no-callers',
    );
  });

  it('inconsistent when participating repos disagree with each other — takes priority over correctness', () => {
    const state = classifyPinState(
      report({
        repoPins: [
          row({ pin: 'v3.4.2', consistent: true, correctness: 'correct' }),
          row({ pin: 'v3.4.1', consistent: false, correctness: 'incorrect' }),
        ],
        desiredActionsPin: 'v3.4.2',
      }),
    );
    expect(state).toBe('inconsistent');
  });

  it('unknown when repos agree but no manifest was reachable', () => {
    const state = classifyPinState(
      report({
        repoPins: [row({ correctness: 'unknown' }), row({ correctness: 'unknown' })],
        desiredActionsPin: null,
      }),
    );
    expect(state).toBe('unknown');
  });

  it('DECISIVE CASE 1 — all repos correct vs the manifest → consistent-and-correct', () => {
    const state = classifyPinState(
      report({
        repoPins: [
          row({ pin: 'v3.4.2', correctness: 'correct' }),
          row({ pin: 'v3.4.2', correctness: 'correct' }),
        ],
        desiredActionsPin: 'v3.4.2',
      }),
    );
    expect(state).toBe('consistent-and-correct');
  });

  it('DECISIVE CASE 2 (the #872 bug) — all repos SAME wrong pin vs the manifest → consistent-but-wrong, NOT a pass', () => {
    // This is the case a consistency-only check reports IDENTICALLY to case 1
    // (every repo is `consistent: true` — they all agree with each other on the
    // SAME stale value). Without the fix, there is no way to tell the two apart.
    const state = classifyPinState(
      report({
        repoPins: [
          row({ pin: 'v3.4.1', consistent: true, correctness: 'incorrect' }),
          row({ pin: 'v3.4.1', consistent: true, correctness: 'incorrect' }),
        ],
        expectedPin: 'v3.4.1',
        desiredActionsPin: 'v3.4.2',
      }),
    );
    expect(state).toBe('consistent-but-wrong');
    expect(state).not.toBe('consistent-and-correct'); // the decisive assertion
  });

  it('DECISIVE CASE 3 — repos pinned to DIFFERENT versions → inconsistent, distinguishable from case 2', () => {
    const state = classifyPinState(
      report({
        repoPins: [
          row({ pin: 'v3.4.2', consistent: true, correctness: 'correct' }), // modal
          row({ pin: 'v3.4.1', consistent: false, correctness: 'incorrect' }),
        ],
        expectedPin: 'v3.4.2',
        desiredActionsPin: 'v3.4.2',
      }),
    );
    expect(state).toBe('inconsistent');
    expect(state).not.toBe('consistent-but-wrong');
  });

  it('an --expected-pin override that misses reality does NOT read as inconsistent — the repos still agree with EACH OTHER', () => {
    // Every repo pins v3.4.1 (they agree). An operator --expected-pin v3.4.9
    // override (unrelated to reality) drives `consistent:false` for ALL of them
    // — that is the override mechanism working as designed (routingVerdict still
    // fails on it), but pin CORRECTNESS is a DIFFERENT question: do the repos
    // agree with each other and with the MANIFEST, independent of the override.
    const state = classifyPinState(
      report({
        repoPins: [
          row({ pin: 'v3.4.1', consistent: false, correctness: 'unknown' }),
          row({ pin: 'v3.4.1', consistent: false, correctness: 'unknown' }),
        ],
        expectedPin: 'v3.4.9', // the override, not what's actually deployed
        desiredActionsPin: null, // no manifest in this scenario
      }),
    );
    expect(state).not.toBe('inconsistent'); // the repos DO self-agree
    expect(state).toBe('unknown'); // no manifest → honest unknown, not a false "inconsistent"
  });
});

describe('pinClauseText — the summaryLine clause (macf#872: replaces "pins consistent" IN PLACE, never a footnote)', () => {
  it('inconsistent → PIN DIVERGENCE (unchanged phrasing)', () => {
    expect(pinClauseText('inconsistent', null)).toBe('PIN DIVERGENCE');
  });
  it('unknown → does not claim consistency-as-health', () => {
    const text = pinClauseText('unknown', null);
    expect(text).toMatch(/UNKNOWN/);
    expect(text).not.toMatch(/^pins consistent$/); // never the bare old-positive phrasing
  });
  it('consistent-but-wrong → STALE, carries the desired pin, never reads as a plain pass', () => {
    const text = pinClauseText('consistent-but-wrong', 'v3.4.2');
    expect(text).toMatch(/STALE/);
    expect(text).toContain('v3.4.2');
    expect(text).not.toBe('pins consistent');
  });
  it('consistent-and-correct → current, carries the desired pin', () => {
    const text = pinClauseText('consistent-and-correct', 'v3.4.2');
    expect(text).toMatch(/current/);
    expect(text).toContain('v3.4.2');
  });
});

describe('pinCorrectnessLine — the dedicated text-render line', () => {
  it('unknown state names why (no manifest reachable)', () => {
    expect(pinCorrectnessLine(report({ desiredActionsPin: null }))).toMatch(/unknown/);
  });
  it('consistent-but-wrong names both the observed and the desired pin', () => {
    const r = report({
      repoPins: [row({ pin: 'v3.4.1', consistent: true, correctness: 'incorrect' })],
      expectedPin: 'v3.4.1',
      desiredActionsPin: 'v3.4.2',
    });
    const line = pinCorrectnessLine(r);
    expect(line).toMatch(/STALE/);
    expect(line).toContain('v3.4.1');
    expect(line).toContain('v3.4.2');
  });

  it('consistent-but-wrong names the OBSERVED pin, not a stale --expected-pin override', () => {
    // expectedPin (an operator override) disagrees with what's actually deployed;
    // the line must report what's REALLY there (v3.4.1), never the override value.
    const r = report({
      repoPins: [
        row({ pin: 'v3.4.1', consistent: false, correctness: 'incorrect' }),
        row({ pin: 'v3.4.1', consistent: false, correctness: 'incorrect' }),
      ],
      expectedPin: 'v3.4.9', // an override that matches nothing real
      desiredActionsPin: 'v3.4.2',
    });
    const line = pinCorrectnessLine(r);
    expect(line).toContain('v3.4.1'); // the real, observed value
    expect(line).not.toContain('v3.4.9'); // never the unrelated override
  });

  it('inconsistent WITH a known manifest reports how many repos already match it — not a bare "not evaluated"', () => {
    const r = report({
      repoPins: [
        row({ pin: 'v3.4.2', consistent: true, correctness: 'correct' }), // already current
        row({ pin: 'v3.4.1', consistent: false, correctness: 'incorrect' }), // still behind
      ],
      expectedPin: 'v3.4.2',
      desiredActionsPin: 'v3.4.2',
    });
    const line = pinCorrectnessLine(r);
    expect(line).toContain('1/2');
    expect(line).toContain('v3.4.2');
    expect(line).not.toMatch(/not evaluated/); // the per-repo correctness data IS used
  });

  it('inconsistent with NO manifest reachable falls back to "not evaluated" (nothing to compare against)', () => {
    const r = report({
      repoPins: [
        row({ pin: 'v3.4.2', consistent: true, correctness: 'unknown' }),
        row({ pin: 'v3.4.1', consistent: false, correctness: 'unknown' }),
      ],
      desiredActionsPin: null,
    });
    expect(pinCorrectnessLine(r)).toMatch(/not evaluated/);
  });
});

describe('pinCorrectnessWarning — the loud-but-non-fatal warning (macf#872)', () => {
  it('null when the state is not consistent-but-wrong', () => {
    expect(pinCorrectnessWarning(report({ desiredActionsPin: null }))).toBeNull();
  });

  it('fires on consistent-but-wrong, naming the OBSERVED pin (not a stale --expected-pin override)', () => {
    const r = report({
      repoPins: [
        row({ pin: 'v3.4.1', consistent: false, correctness: 'incorrect' }),
        row({ pin: 'v3.4.1', consistent: false, correctness: 'incorrect' }),
      ],
      expectedPin: 'v3.4.9', // unrelated override
      desiredActionsPin: 'v3.4.2',
    });
    const warning = pinCorrectnessWarning(r);
    expect(warning).toMatch(/STALE|uniformly pinned/i);
    expect(warning).toContain('v3.4.1');
    expect(warning).toContain('v3.4.2');
    expect(warning).not.toContain('v3.4.9');
  });
});

describe('resolveDesiredActionsPin — source precedence (macf#872)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('--manifest override wins: reads versions.actions from a local file', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'macf-pin-correctness-'));
    const manifestPath = join(tmpDir, 'fleet.yaml');
    writeFileSync(manifestPath, fleetYaml({ actionsVersion: 'v3.4.2' }), 'utf-8');
    const pin = await resolveDesiredActionsPin(manifestPath, [], 'testfleet', async () => {
      throw new Error('discovery must NOT run when an explicit override is given');
    });
    expect(pin).toBe('v3.4.2');
  });

  it('a broken --manifest override renders unknown (null) — never silently falls through to discovery', async () => {
    let discoveryCalled = false;
    const pin = await resolveDesiredActionsPin('/nonexistent/fleet.yaml', ['acme/testfleet-control'], 'testfleet', async () => {
      discoveryCalled = true;
      return fleetYaml({ actionsVersion: 'v3.4.2' });
    });
    expect(pin).toBeNull();
    expect(discoveryCalled).toBe(false); // explicit-but-broken must not silently substitute a different source
  });

  it('an unparseable --manifest override renders unknown (null)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'macf-pin-correctness-'));
    const manifestPath = join(tmpDir, 'fleet.yaml');
    writeFileSync(manifestPath, 'not: [valid, fleet, yaml', 'utf-8');
    const pin = await resolveDesiredActionsPin(manifestPath, [], 'testfleet', async () => null);
    expect(pin).toBeNull();
  });

  it('no override: auto-discovers the control repo from the already-fetched install-set', async () => {
    const seenRepos: string[] = [];
    const pin = await resolveDesiredActionsPin(
      undefined,
      ['acme/testfleet-code-agent', 'acme/testfleet-control'],
      'testfleet',
      async (repo) => {
        seenRepos.push(repo);
        return repo === 'acme/testfleet-control' ? fleetYaml({ actionsVersion: 'v3.4.2' }) : null;
      },
    );
    expect(pin).toBe('v3.4.2');
    expect(seenRepos).toEqual(['acme/testfleet-control']);
  });

  it('no override, no control repo in the install-set → null, reader never invoked', async () => {
    let readerCalled = false;
    const pin = await resolveDesiredActionsPin(undefined, ['acme/testfleet-code-agent'], 'testfleet', async () => {
      readerCalled = true;
      return null;
    });
    expect(pin).toBeNull();
    expect(readerCalled).toBe(false);
  });

  it('control repo found but its fleet.yaml is unreadable (404/network) → null', async () => {
    const pin = await resolveDesiredActionsPin(
      undefined,
      ['acme/testfleet-control'],
      'testfleet',
      async () => null,
    );
    expect(pin).toBeNull();
  });

  it('control repo found but its fleet.yaml does not declare versions.actions → null (schema-optional field absent)', async () => {
    const yamlNoActions = fleetYaml().replace(/versions:\n.*\n.*actions:.*\n/, '');
    const pin = await resolveDesiredActionsPin(
      undefined,
      ['acme/testfleet-control'],
      'testfleet',
      async () => yamlNoActions,
    );
    expect(pin).toBeNull();
  });
});
