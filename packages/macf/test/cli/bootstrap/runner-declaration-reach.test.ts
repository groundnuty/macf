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
  checkRunnerDeclarationReach,
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
