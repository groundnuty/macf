/**
 * Tests for `runner-declaration-reach.ts` (groundnuty/macf#1194's
 * provision-time detection half). The decisive pair this module exists
 * for:
 *
 *   1. `runs_on: self-hosted` + an installed router whose `with:` block
 *      cannot possibly carry that declaration -> detected, named LOUDLY
 *      (which repo, which pin, what's actually passed, what the router
 *      does instead).
 *   2. `runs_on: self-hosted` + an installed router whose `with:` block
 *      DOES carry a runner-intent key -> `'honoured'`, no warning.
 *
 * Per `assert-the-wrong-path.md`, test 2's positive case must be reached
 * from a FIXTURE that genuinely differs from test 1's — not a hardcoded
 * `true` — so {@link conveysRunnerIntent} / {@link extractCallerWithKeys}
 * are exercised directly on realistic YAML text in both directions.
 */
import { describe, it, expect } from 'vitest';
import {
  extractCallerWithKeys,
  conveysRunnerIntent,
  evaluateRunnerDeclarationReach,
  evaluateRunnerDeclarationReachFromObservation,
  checkRunnerDeclarationReach,
  runnerDeclarationTag,
  KNOWN_NON_RUNNER_INTENT_WITH_KEYS,
} from '../../../src/cli/bootstrap/runner-declaration-reach.js';
import type { RunnerDeclarationDeps } from '../../../src/cli/bootstrap/runner-declaration-reach.js';

// Realistic fixture, shaped exactly like `repo-init.ts::generateWorkflow`'s
// own generated output (verified against that file's template lines and
// against a live `gh api` read of groundnuty/macf-actions's default
// branch, both cited in this module's own doc comment) — a v3+ caller
// passing only the two known, verified-non-runner-intent keys.
const TODAYS_CALLER_YAML = `name: Agent Router

on:
  issue_comment:
    types: [created]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
  route:
    needs: gate
    if: needs.gate.outputs.should-route == 'true'
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.4.2
    with:
      project: myproject
      registry-api-path: /orgs/myorg
    secrets:
      MACF_ROUTING_BUNDLE: \${{ secrets.MACF_ROUTING_BUNDLE }}
`;

// A HYPOTHETICAL future caller, once macf-actions#81 ships a runner-intent
// input AND macf's own generator is updated to pass it — the fixture that
// makes test 2's positive branch reachable from something other than a
// hardcoded constant.
const FUTURE_CALLER_YAML = `name: Agent Router

jobs:
  route:
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.6.0
    with:
      project: myproject
      registry-api-path: /orgs/myorg
      runner-intent: self-hosted
    secrets:
      MACF_ROUTING_BUNDLE: \${{ secrets.MACF_ROUTING_BUNDLE }}
`;

// A pre-v3 legacy caller — no workflow_call.inputs exist on that pin at
// all, so `repo-init.ts` never emits a `with:` block for it.
const LEGACY_CALLER_YAML = `name: Agent Router

jobs:
  route:
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v1.3.3
    secrets:
      ROUTING_CLIENT_CERT: \${{ secrets.ROUTING_CLIENT_CERT }}
`;

const UNRELATED_WORKFLOW_YAML = `name: CI

on: push

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

// groundnuty/macf#1421 — the REAL shape observed live on `macf-trial`
// (`with: runner-runs-on: self-hosted` at a runner-runs-on-capable pin,
// `v3.5.0`+): a capable pin whose `with:` block actually carries the
// `runner-runs-on` input.
const CAPABLE_PIN_WITH_RUNNER_RUNS_ON_YAML = `name: Agent Router

jobs:
  route:
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.5.0
    with:
      project: myproject
      registry-api-path: /orgs/myorg
      runner-runs-on: self-hosted
    secrets:
      MACF_ROUTING_BUNDLE: \${{ secrets.MACF_ROUTING_BUNDLE }}
`;

// The same pin (capable, >= v3.5.0), but the input is ABSENT — the
// generator never emitted it (e.g. the manifest didn't declare
// `routing.runner.runs_on: self-hosted` at generation time). Capability
// alone doesn't confer the verdict; the input has to actually be there.
const CAPABLE_PIN_WITHOUT_RUNNER_RUNS_ON_YAML = `name: Agent Router

jobs:
  route:
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.5.0
    with:
      project: myproject
      registry-api-path: /orgs/myorg
    secrets:
      MACF_ROUTING_BUNDLE: \${{ secrets.MACF_ROUTING_BUNDLE }}
`;

describe('extractCallerWithKeys (pure)', () => {
  it("today's real caller shape: pin + exactly [project, registry-api-path]", () => {
    const parsed = extractCallerWithKeys(TODAYS_CALLER_YAML);
    expect(parsed).toEqual({ pin: 'v3.4.2', withKeys: ['project', 'registry-api-path'] });
  });

  it('a hypothetical future caller with a third with: key', () => {
    const parsed = extractCallerWithKeys(FUTURE_CALLER_YAML);
    expect(parsed).toEqual({ pin: 'v3.6.0', withKeys: ['project', 'registry-api-path', 'runner-intent'] });
  });

  it('a legacy pre-v3 caller has no with: block at all', () => {
    const parsed = extractCallerWithKeys(LEGACY_CALLER_YAML);
    expect(parsed).toEqual({ pin: 'v1.3.3', withKeys: [] });
  });

  it('content with no macf-actions uses: line at all -> undefined', () => {
    expect(extractCallerWithKeys(UNRELATED_WORKFLOW_YAML)).toBeUndefined();
  });
});

describe('conveysRunnerIntent (pure)', () => {
  it('DECISIVE: the known, verified keys alone never convey runner intent', () => {
    expect(conveysRunnerIntent(KNOWN_NON_RUNNER_INTENT_WITH_KEYS)).toBe(false);
    expect(conveysRunnerIntent(['project', 'registry-api-path'])).toBe(false);
  });

  it('DECISIVE: an empty with: block never conveys runner intent', () => {
    expect(conveysRunnerIntent([])).toBe(false);
  });

  it('DECISIVE: ANY key outside the known set conveys runner intent', () => {
    expect(conveysRunnerIntent(['project', 'registry-api-path', 'runner-intent'])).toBe(true);
    expect(conveysRunnerIntent(['runs-on'])).toBe(true);
  });
});

describe('evaluateRunnerDeclarationReach — decisive pair', () => {
  it('1. self-hosted declared + installed router cannot honour it -> not-honoured, named (repo, pin, actual with: keys, actual mechanism)', () => {
    const finding = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', TODAYS_CALLER_YAML);
    expect(finding.verdict).toBe('not-honoured');
    expect(finding.message).toContain('groundnuty/x');
    expect(finding.message).toContain('v3.4.2');
    expect(finding.message).toContain('project, registry-api-path');
    expect(finding.message).toContain('MACF_TRUSTED_ACTORS');
  });

  it('2. self-hosted declared + installed router with: block DOES carry a runner-intent key -> honoured', () => {
    const finding = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', FUTURE_CALLER_YAML);
    expect(finding.verdict).toBe('honoured');
    expect(finding.message).toContain('groundnuty/x');
    expect(finding.message).toContain('v3.6.0');
  });

  it('a legacy pre-v3 caller (no with: block at all) is ALSO not-honoured, described as such', () => {
    const finding = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', LEGACY_CALLER_YAML);
    expect(finding.verdict).toBe('not-honoured');
    expect(finding.message).toContain('no with: block at all');
  });
});

/**
 * groundnuty/macf#1421 — `UNCERTAIN` read as "we could not tell what the
 * declaration is" for a verdict that is actually certain (the declaration
 * IS present); only the router's RUNTIME behaviour is unverified. The
 * decisive TRIPLE this issue's own AC names, run through the REAL
 * `runner-runs-on` key and the REAL capability threshold (`v3.5.0`) —
 * `runnerDeclarationTag` is what an operator actually reads, so these
 * assert the tag word, not just the machine-verdict.
 */
describe('runnerDeclarationTag — the operator-facing wording (groundnuty/macf#1421)', () => {
  it('1. DECISIVE: capable pin + runner-runs-on present -> DECLARED (runtime unverified), never UNCERTAIN', () => {
    const finding = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', CAPABLE_PIN_WITH_RUNNER_RUNS_ON_YAML);
    expect(finding.verdict).toBe('honoured');
    expect(runnerDeclarationTag(finding.verdict)).toBe('DECLARED (runtime unverified)');
    expect(runnerDeclarationTag(finding.verdict)).not.toBe('UNCERTAIN');
  });

  it('2. DECISIVE: capable pin + runner-runs-on ABSENT -> NOT HONOURED — capability alone never confers the verdict', () => {
    const finding = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', CAPABLE_PIN_WITHOUT_RUNNER_RUNS_ON_YAML);
    expect(finding.verdict).toBe('not-honoured');
    expect(runnerDeclarationTag(finding.verdict)).toBe('NOT HONOURED');
  });

  it('3. DECISIVE: incapable pin (v3.4.2), same with: shape as case 2 -> NOT HONOURED, unchanged by this issue', () => {
    const finding = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', TODAYS_CALLER_YAML);
    expect(finding.verdict).toBe('not-honoured');
    expect(runnerDeclarationTag(finding.verdict)).toBe('NOT HONOURED');
  });

  it('MUTATION GUARD: collapsing DECLARED back into the old UNCERTAIN wording fails this — the tag must be exactly "DECLARED (runtime unverified)" for the honoured verdict, "N/A" for not-applicable, and never "UNCERTAIN" for anything', () => {
    expect(runnerDeclarationTag('honoured')).toBe('DECLARED (runtime unverified)');
    expect(runnerDeclarationTag('not-honoured')).toBe('NOT HONOURED');
    expect(runnerDeclarationTag('unknown')).toBe('UNKNOWN');
    expect(runnerDeclarationTag('not-applicable')).toBe('N/A');
    for (const verdict of ['not-applicable', 'unknown', 'not-honoured', 'honoured'] as const) {
      expect(runnerDeclarationTag(verdict)).not.toBe('UNCERTAIN');
    }
  });

  // The issue's own AC: "`HONOURED` is reserved for whatever future check
  // can observe a run" — nothing in this static module may emit the bare
  // word today. Exact equality, not a substring/regex match — `NOT HONOURED`
  // legitimately CONTAINS `HONOURED`, so a `not.toMatch(/HONOURED/)` form
  // would fail on a correct implementation (assert-the-wrong-path.md: pick
  // the assertion a wrong implementation can't also satisfy).
  it('AC: bare "HONOURED" is reserved — no verdict tags to it today', () => {
    for (const verdict of ['not-applicable', 'unknown', 'not-honoured', 'honoured'] as const) {
      expect(runnerDeclarationTag(verdict)).not.toBe('HONOURED');
    }
  });
});

describe('evaluateRunnerDeclarationReach — not-applicable + honest-unknown floor', () => {
  it('hosted declared (not self-hosted) -> not-applicable, no check performed regardless of content', () => {
    expect(evaluateRunnerDeclarationReach('groundnuty/x', 'hosted', undefined).verdict).toBe('not-applicable');
    expect(evaluateRunnerDeclarationReach('groundnuty/x', 'hosted', TODAYS_CALLER_YAML).verdict).toBe('not-applicable');
  });

  it('runner.runs_on entirely absent -> not-applicable', () => {
    expect(evaluateRunnerDeclarationReach('groundnuty/x', undefined, undefined).verdict).toBe('not-applicable');
  });

  it('DECISIVE: installed workflow unreadable -> unknown, never claimed as honoured/not-honoured', () => {
    const finding = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', undefined);
    expect(finding.verdict).toBe('unknown');
    expect(finding.verdict).not.toBe('honoured');
    expect(finding.verdict).not.toBe('not-honoured');
    expect(finding.message).toMatch(/UNKNOWN/);
  });

  it('DECISIVE: installed content carries no recognizable macf-actions uses: line -> unknown, not "not-honoured"', () => {
    const finding = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', UNRELATED_WORKFLOW_YAML);
    expect(finding.verdict).toBe('unknown');
    expect(finding.message).toMatch(/UNKNOWN/);
  });
});

describe('evaluateRunnerDeclarationReachFromObservation — already-observed entry point (groundnuty/macf#1335)', () => {
  it('1. self-hosted declared + observed with: keys cannot honour it -> not-honoured, SAME message shape as the content-based function', () => {
    const contentBased = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', TODAYS_CALLER_YAML);
    const observationBased = evaluateRunnerDeclarationReachFromObservation('groundnuty/x', 'self-hosted', 'v3.4.2', ['project', 'registry-api-path']);
    expect(observationBased.verdict).toBe('not-honoured');
    expect(observationBased.message).toBe(contentBased.message);
  });

  it('2. self-hosted declared + observed with: keys DO carry a runner-intent key -> honoured, SAME message shape as the content-based function', () => {
    const contentBased = evaluateRunnerDeclarationReach('groundnuty/x', 'self-hosted', FUTURE_CALLER_YAML);
    const observationBased = evaluateRunnerDeclarationReachFromObservation('groundnuty/x', 'self-hosted', 'v3.6.0', [
      'project',
      'registry-api-path',
      'runner-intent',
    ]);
    expect(observationBased.verdict).toBe('honoured');
    expect(observationBased.message).toBe(contentBased.message);
  });

  it('hosted declared -> not-applicable, regardless of what was observed', () => {
    expect(evaluateRunnerDeclarationReachFromObservation('groundnuty/x', 'hosted', 'v3.4.2', ['project']).verdict).toBe('not-applicable');
    expect(evaluateRunnerDeclarationReachFromObservation('groundnuty/x', undefined, undefined, undefined).verdict).toBe('not-applicable');
  });

  it('DECISIVE: withKeys undefined (the SAME single signal collapsing "unreadable" and "no uses: line") -> unknown, never honoured/not-honoured/"consistent"', () => {
    const finding = evaluateRunnerDeclarationReachFromObservation('groundnuty/x', 'self-hosted', undefined, undefined);
    expect(finding.verdict).toBe('unknown');
    expect(finding.verdict).not.toBe('honoured');
    expect(finding.verdict).not.toBe('not-honoured');
    expect(finding.message).toMatch(/UNKNOWN/);
  });

  it('an empty with: block (a real, meaningful observation — a legacy caller with no with: at all) is ALSO not-honoured, described as such', () => {
    const finding = evaluateRunnerDeclarationReachFromObservation('groundnuty/x', 'self-hosted', 'v1.3.3', []);
    expect(finding.verdict).toBe('not-honoured');
    expect(finding.message).toContain('no with: block at all');
  });

  it('pin undefined falls back to a placeholder rather than throwing or losing the verdict', () => {
    const finding = evaluateRunnerDeclarationReachFromObservation('groundnuty/x', 'self-hosted', undefined, ['project', 'registry-api-path']);
    expect(finding.verdict).toBe('not-honoured');
    expect(finding.message).toContain('(unknown pin)');
  });
});

describe('checkRunnerDeclarationReach — live-read wrapper', () => {
  it('never calls readInstalledWorkflow when the declared runner is not self-hosted', async () => {
    let called = false;
    const deps: RunnerDeclarationDeps = {
      readInstalledWorkflow: async () => {
        called = true;
        return undefined;
      },
    };
    const finding = await checkRunnerDeclarationReach('groundnuty/x', 'hosted', deps);
    expect(finding.verdict).toBe('not-applicable');
    expect(called).toBe(false);
  });

  it('threads a failed read through to the honest-unknown floor', async () => {
    const deps: RunnerDeclarationDeps = { readInstalledWorkflow: async () => undefined };
    const finding = await checkRunnerDeclarationReach('groundnuty/x', 'self-hosted', deps);
    expect(finding.verdict).toBe('unknown');
  });

  it('threads a successful read through to the not-honoured verdict', async () => {
    const deps: RunnerDeclarationDeps = { readInstalledWorkflow: async () => TODAYS_CALLER_YAML };
    const finding = await checkRunnerDeclarationReach('groundnuty/x', 'self-hosted', deps);
    expect(finding.verdict).toBe('not-honoured');
  });
});
