/**
 * The DECISIVE test for macf#922: assert the GitHub Actions variable(s)
 * `macf bootstrap apply` provisions for runner selection are the EXACT set
 * the v3 router's `pick-runner` job actually reads — not the set a prior
 * increment merely believed it read (`MACF_ROUTING_RUNS_ON`, which has zero
 * consumers on the v3 line; see `apply-routing.ts`'s module doc). A test
 * that only checks "we wrote MACF_TRUSTED_ACTORS" would have passed
 * identically for the wrong variable name — this test instead pins the name
 * against a citation of the router's own source, AND (when a sibling
 * `macf-actions` checkout is available) parses that source live.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { TRUSTED_ACTORS_VAR } from '../../../src/cli/bootstrap/apply-routing.js';
import { ROUTER_EMITTED_LABELS } from '../../../src/cli/bootstrap/fleet-manifest.js';

/**
 * The COMPLETE set of `vars.MACF_*` GitHub Actions variables referenced
 * ANYWHERE in `agent-router.yml` — pinned as a literal so this test catches
 * drift without requiring a live `macf-actions` clone in every environment
 * that runs it (CI checkouts of `groundnuty/macf` alone don't have one).
 *
 * Verified 2026-08-13 against `groundnuty/macf-actions`
 * `.github/workflows/agent-router.yml` on `main` (`8e2aa48`), `v3.4.1`
 * (`39eb8f1`), and `v3.4.2` (`8e2aa48`) via `grep -n 'vars\.MACF_'
 * .github/workflows/agent-router.yml` — line 111, ONE match, in the
 * `pick-runner` job:
 *
 *     TRUSTED_ACTORS: ${{ vars.MACF_TRUSTED_ACTORS }}
 *
 * The router's other `MACF_*` references (`secrets.MACF_ROUTING_APP_ID` /
 * `secrets.MACF_ROUTING_APP_KEY`, the App-token-mint credentials) are
 * `secrets.*`, not `vars.*`, and are workflow-caller SECRETS supplied by the
 * consuming repo's `.github/workflows/agent-router.yml` caller block — not
 * something `bootstrap apply` provisions as a repo VARIABLE at all. The
 * per-project CA cert var (`<SEG>_CA_CERT`) is read dynamically inside a
 * `run:` block via `gh api` with a computed name, so it can never appear as
 * a static `vars.<literal>` reference — it is a SEPARATE apply module's
 * responsibility (`apply-ca.ts`), correctly out of scope for this pin.
 */
const EXPECTED_ROUTER_VARS_VARS = ['MACF_TRUSTED_ACTORS'] as const;

/** Matches a static `${{ vars.MACF_<NAME> }}` (or bare `vars.MACF_<NAME>`) reference in workflow YAML. */
const VARS_MACF_RE = /vars\.(MACF_[A-Z0-9_]+)/g;

function extractVarsMacfReferences(workflowText: string): string[] {
  const found = new Set<string>();
  for (const m of workflowText.matchAll(VARS_MACF_RE)) {
    const name = m[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

describe('extractVarsMacfReferences (self-test of the parser used below)', () => {
  it('finds every distinct vars.MACF_* reference, deduped and sorted', () => {
    const text = [
      'env:',
      '  A: ${{ vars.MACF_TRUSTED_ACTORS }}',
      '  B: ${{ vars.MACF_TRUSTED_ACTORS }}', // repeated — must dedupe
      '  C: ${{ secrets.MACF_ROUTING_APP_ID }}', // secrets.*, must NOT match
      '  D: ${{ vars.MACF_ZZZ }}',
    ].join('\n');
    expect(extractVarsMacfReferences(text)).toEqual(['MACF_TRUSTED_ACTORS', 'MACF_ZZZ']);
  });

  it('finds nothing when there are no vars.MACF_* references', () => {
    expect(extractVarsMacfReferences('env:\n  X: ${{ secrets.MACF_ROUTING_APP_KEY }}\n')).toEqual([]);
  });
});

describe('MACF_TRUSTED_ACTORS matches the router\'s actual read (macf#922 — the decisive test)', () => {
  it('TRUSTED_ACTORS_VAR — the constant apply-routing.ts writes — equals the pinned expected set (exactly one entry)', () => {
    expect(EXPECTED_ROUTER_VARS_VARS).toEqual(['MACF_TRUSTED_ACTORS']);
    expect(TRUSTED_ACTORS_VAR).toBe(EXPECTED_ROUTER_VARS_VARS[0]);
  });

  it('never regresses to the retired, unconsumed MACF_ROUTING_RUNS_ON name', () => {
    expect(TRUSTED_ACTORS_VAR).not.toBe('MACF_ROUTING_RUNS_ON');
  });

  // Best-effort LIVE parse against a sibling `macf-actions` checkout, when
  // one is available on this machine (the task brief's own dev environment
  // has one at /home/ubuntu/repos/groundnuty/macf-actions). Skips loudly —
  // never fails the suite — when no checkout is found, since a CI checkout
  // of `groundnuty/macf` alone has no reason to also clone a sibling repo.
  // Override the path via MACF_ACTIONS_CHECKOUT for a different clone
  // location.
  const checkoutRoot = process.env['MACF_ACTIONS_CHECKOUT'] ?? '/home/ubuntu/repos/groundnuty/macf-actions';
  const workflowPath = `${checkoutRoot}/.github/workflows/agent-router.yml`;

  it('LIVE PARSE (skips when no macf-actions checkout is present): the router\'s vars.MACF_* set equals what apply provisions for runner selection', () => {
    if (!existsSync(workflowPath)) {
      console.warn(
        `SKIP (router-trusted-actors-contract): no macf-actions checkout found at "${workflowPath}" — the live ` +
          'parse did not run this pass. The literal pin above (EXPECTED_ROUTER_VARS_VARS) still guards drift. ' +
          'Set MACF_ACTIONS_CHECKOUT to exercise the live parse.',
      );
      return;
    }
    const text = readFileSync(workflowPath, 'utf-8');
    const found = extractVarsMacfReferences(text);
    expect(found).toEqual(EXPECTED_ROUTER_VARS_VARS.slice().sort());
    expect(found).toContain(TRUSTED_ACTORS_VAR);
  });
});

// --- macf#934 — the SIBLING decisive test: the self-hosted LABELS literal, not just the var name ---

/**
 * Extracts every `labels='[...]'` JSON-array literal assignment in the
 * router's `pick-runner` step and returns the ONE that parses as a JSON
 * array of strings — the step also assigns `labels='"ubuntu-latest"'`
 * (a plain JSON STRING, not an array) as its github-hosted default, which
 * this regex's `\[...\]` bracket requirement already excludes. `undefined`
 * when no array-literal assignment is found (a structural change to the
 * step this test should then fail loudly on, not silently pass).
 */
function extractSelfHostedLabelsLiteral(workflowText: string): readonly string[] | undefined {
  const re = /labels='(\[[^']*\])'/g;
  for (const m of workflowText.matchAll(re)) {
    const literal = m[1];
    if (literal === undefined) continue;
    const parsed: unknown = JSON.parse(literal);
    if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) return parsed;
  }
  return undefined;
}

describe('extractSelfHostedLabelsLiteral (self-test of the parser used below)', () => {
  it('finds the array-literal assignment, ignoring the plain-string default', () => {
    const text = ["labels='\"ubuntu-latest\"'", 'if [ trusted ]; then', "  labels='[\"self-hosted\",\"macf-vm\"]'", 'fi'].join('\n');
    expect(extractSelfHostedLabelsLiteral(text)).toEqual(['self-hosted', 'macf-vm']);
  });

  it('returns undefined when no array-literal assignment exists', () => {
    expect(extractSelfHostedLabelsLiteral("labels='\"ubuntu-latest\"'\n")).toBeUndefined();
  });
});

describe("ROUTER_EMITTED_LABELS matches the router's actual self-hosted labels literal (macf#934 — the decisive test)", () => {
  it('is exactly ["self-hosted", "macf-vm"], in that order — the literal `fleet-manifest.ts`\'s superRefine + observer.ts\'s capability check both pin against', () => {
    expect(ROUTER_EMITTED_LABELS).toEqual(['self-hosted', 'macf-vm']);
  });

  // Same best-effort LIVE parse posture as the vars.MACF_* test above —
  // skips loudly, never fails the suite, when no macf-actions checkout is
  // present. Reuses the SAME checkoutRoot/workflowPath resolution.
  it('LIVE PARSE (skips when no macf-actions checkout is present): the router\'s self-hosted labels literal equals ROUTER_EMITTED_LABELS', () => {
    const checkoutRoot = process.env['MACF_ACTIONS_CHECKOUT'] ?? '/home/ubuntu/repos/groundnuty/macf-actions';
    const workflowPath = `${checkoutRoot}/.github/workflows/agent-router.yml`;
    if (!existsSync(workflowPath)) {
      console.warn(
        `SKIP (router-trusted-actors-contract labels): no macf-actions checkout found at "${workflowPath}" — the ` +
          'live parse did not run this pass. The literal pin above (ROUTER_EMITTED_LABELS) still guards drift. ' +
          'Set MACF_ACTIONS_CHECKOUT to exercise the live parse.',
      );
      return;
    }
    const text = readFileSync(workflowPath, 'utf-8');
    const found = extractSelfHostedLabelsLiteral(text);
    expect(found).toEqual(ROUTER_EMITTED_LABELS);
  });
});

// --- groundnuty/macf#1194 — the pick-runner hosted exemption, asserted BY NAME ---

/**
 * `pick-runner` is the ONE job `agent-router.yml` hosts by design (a tiny
 * dispatcher — see this file's `EXPECTED_ROUTER_VARS_VARS` doc). The
 * invariant a self-hosted fleet needs is not "no hosted runner runs" — it
 * is "no hosted runner does the WORK." Asserting the exemption BY NAME
 * (string equality against this one literal, never "the first job" or
 * "any job whose id contains 'pick'") is what makes a future job unable to
 * inherit the exemption by accident: a differently-named job that hardcodes
 * `runs-on: ubuntu-latest` fails this test.
 */
const PICK_RUNNER_EXEMPT_JOB_ID = 'pick-runner';

/** The exact literal EVERY non-exempt job's `runs-on:` must read — data-driven from `pick-runner`'s own output, never a second hardcoded value. */
const DATA_DRIVEN_RUNS_ON = '${{ fromJSON(needs.pick-runner.outputs.labels) }}';

/**
 * Extracts every top-level job's `runs-on:` value, keyed by job id.
 * `jobs:` entries are 2-space indented (`  <job-id>:`); a job's own keys
 * (including `runs-on:`) are 4-space indented directly under it. Comment
 * lines that happen to mention "runs-on:" inside a `steps:` block sit at
 * 6+ spaces of indent and never match the 4-space-exact pattern below.
 */
function extractJobRunsOn(workflowText: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let currentJob: string | undefined;
  for (const line of workflowText.split('\n')) {
    const jobMatch = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (jobMatch?.[1] !== undefined) {
      currentJob = jobMatch[1];
      continue;
    }
    if (currentJob === undefined) continue;
    const runsOnMatch = /^ {4}runs-on:\s*(.+)$/.exec(line);
    if (runsOnMatch?.[1] !== undefined) result.set(currentJob, runsOnMatch[1].trim());
  }
  return result;
}

describe('extractJobRunsOn (self-test of the parser used below)', () => {
  it('maps each job id to its runs-on value, ignoring deeper-indented lines that mention runs-on in prose', () => {
    const text = [
      'jobs:',
      '  pick-runner:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo hi # not a runs-on: line, deeper indent',
      '  config:',
      '    needs: pick-runner',
      '    runs-on: ${{ fromJSON(needs.pick-runner.outputs.labels) }}',
    ].join('\n');
    expect(extractJobRunsOn(text)).toEqual(
      new Map([
        ['pick-runner', 'ubuntu-latest'],
        ['config', '${{ fromJSON(needs.pick-runner.outputs.labels) }}'],
      ]),
    );
  });
});

/**
 * The pinned literal — every job id + its `runs-on:` value, verified
 * 2026-08-13 against `groundnuty/macf-actions` `v3.4.2` (`8e2aa48`) via
 * `grep -n '^  [a-zA-Z0-9_-]*:$\|runs-on:' .github/workflows/agent-router.yml`:
 * seven jobs total, exactly ONE (`pick-runner`) hardcodes `ubuntu-latest`;
 * every other job reads the literal `${{ fromJSON(needs.pick-runner.outputs.labels) }}`.
 */
const EXPECTED_JOB_RUNS_ON = new Map([
  ['pick-runner', 'ubuntu-latest'],
  ['config', DATA_DRIVEN_RUNS_ON],
  ['route-by-label', DATA_DRIVEN_RUNS_ON],
  ['route-by-mention', DATA_DRIVEN_RUNS_ON],
  ['route-by-ci-completion', DATA_DRIVEN_RUNS_ON],
  ['route-by-pr-review-state', DATA_DRIVEN_RUNS_ON],
  ['cleanup-labels', DATA_DRIVEN_RUNS_ON],
]);

describe('pick-runner is the ONLY hosted job (macf#1194 — the decisive exemption test)', () => {
  it('the pinned literal names exactly one hosted job, by id, and it is pick-runner', () => {
    const hostedJobs = [...EXPECTED_JOB_RUNS_ON.entries()].filter(([, runsOn]) => runsOn === 'ubuntu-latest').map(([id]) => id);
    expect(hostedJobs).toEqual([PICK_RUNNER_EXEMPT_JOB_ID]);
  });

  it('every OTHER pinned job resolves via pick-runner\'s own output, never a second hardcoded value', () => {
    for (const [jobId, runsOn] of EXPECTED_JOB_RUNS_ON) {
      if (jobId === PICK_RUNNER_EXEMPT_JOB_ID) continue;
      expect(runsOn).toBe(DATA_DRIVEN_RUNS_ON);
    }
  });

  // Same best-effort LIVE parse posture as the vars.MACF_*/labels tests above.
  it('LIVE PARSE (skips when no macf-actions checkout is present): every job\'s runs-on matches the pinned literal, and only pick-runner is hosted', () => {
    const checkoutRoot = process.env['MACF_ACTIONS_CHECKOUT'] ?? '/home/ubuntu/repos/groundnuty/macf-actions';
    const workflowPath = `${checkoutRoot}/.github/workflows/agent-router.yml`;
    if (!existsSync(workflowPath)) {
      console.warn(
        `SKIP (router-trusted-actors-contract pick-runner exemption): no macf-actions checkout found at ` +
          `"${workflowPath}" — the live parse did not run this pass. The literal pin above (EXPECTED_JOB_RUNS_ON) ` +
          'still guards drift. Set MACF_ACTIONS_CHECKOUT to exercise the live parse.',
      );
      return;
    }
    const text = readFileSync(workflowPath, 'utf-8');
    const found = extractJobRunsOn(text);
    expect(found).toEqual(EXPECTED_JOB_RUNS_ON);
    const hostedJobs = [...found.entries()].filter(([, runsOn]) => runsOn === 'ubuntu-latest').map(([id]) => id);
    expect(hostedJobs).toEqual([PICK_RUNNER_EXEMPT_JOB_ID]);
  });
});
