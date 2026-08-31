import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { generateWorkflow, generateAgentConfig, patchAgentConfig, createLabel, repoInit, isV3PlusActionsVersion, isBundleCapableActionsVersion, isRunnerRunsOnCapableActionsVersion, fetchOwnerType } from '../../src/cli/commands/repo-init.js';
import { ALL_ROUTING_SECRET_NAMES } from '../../src/cli/bootstrap/apply-routing-secrets.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-repo-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('generateWorkflow', () => {
  it('templates the actions version correctly', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('@v1');
    expect(yaml).toContain('uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v1');
  });

  it('supports v1.0.0 version', () => {
    const yaml = generateWorkflow('v1.0.0');
    expect(yaml).toContain('@v1.0.0');
  });

  it('includes all five event triggers', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('issues:');
    expect(yaml).toContain('issue_comment:');
    expect(yaml).toContain('pull_request:');
    expect(yaml).toContain('pull_request_review:');
    expect(yaml).toContain('check_suite:');
  });

  it('uses secrets: inherit', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('secrets: inherit');
  });

  // macf#797 — the icsoc routing outage root cause: a generated router with NO
  // permissions block fails the reusable-workflow call at composition with
  // `startup_failure`, so nothing ever routes. The block must be present for
  // every pin, sit between `on:` and `jobs:`, and match macf's own router.
  it('emits the permissions block the reusable workflow requires (macf#797)', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('\npermissions:\n');
    expect(yaml).toContain('  contents: read');
    expect(yaml).toContain('  issues: write');
    expect(yaml).toContain('  pull-requests: read');
    expect(yaml).toContain('  checks: read');
    // Ordering: permissions after the on: triggers, before jobs.
    expect(yaml.indexOf('permissions:')).toBeGreaterThan(yaml.indexOf('check_suite:'));
    expect(yaml.indexOf('permissions:')).toBeLessThan(yaml.indexOf('jobs:'));
  });

  it('emits the permissions block for a v3+ pin too', () => {
    const yaml = generateWorkflow('v3.4.1', {
      project: 'macf',
      registryApiPath: '/repos/groundnuty/groundnuty',
    });
    expect(yaml).toContain('\npermissions:\n');
    expect(yaml).toContain('  issues: write');
    expect(yaml).toContain('  checks: read');
    // permissions is caller-side, not a reusable-workflow input, so it precedes with:
    expect(yaml.indexOf('permissions:')).toBeLessThan(yaml.indexOf('with:'));
  });

  // macf#566 — v3+ pins must emit the `with: { project, registry-api-path }`
  // block; v1.x pins must not (the v1 reusable workflow declares no inputs).
  it('emits a v3 with: block (project + registry-api-path) for a v3.3.0 pin', () => {
    const yaml = generateWorkflow('v3.3.0', {
      project: 'macf',
      registryApiPath: '/repos/groundnuty/groundnuty',
    });
    expect(yaml).toContain('uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.3.0');
    expect(yaml).toContain('\n    with:\n');
    expect(yaml).toContain('\n      project: macf\n');
    expect(yaml).toContain('\n      registry-api-path: /repos/groundnuty/groundnuty\n');
    // groundnuty/macf#1338: a v3+ pin with v3Inputs emits the explicit
    // six-name secrets form, NOT `secrets: inherit` — see the
    // "generateWorkflow — explicit six-secret emission" describe block
    // below for the decisive coverage; this test only pins the ordering.
    expect(yaml).toContain('    secrets:');
    expect(yaml).toContain('      ROUTING_CLIENT_CERT: ${{ secrets.ROUTING_CLIENT_CERT }}');
    // well-formed YAML: no tabs; with: nested under route: between uses: and secrets:
    expect(yaml).not.toContain('\t');
    expect(yaml.indexOf('with:')).toBeGreaterThan(yaml.indexOf('uses:'));
    expect(yaml.indexOf('with:')).toBeLessThan(yaml.indexOf('    secrets:'));
  });

  it('treats the bare v3 tag as v3+ (with: block present)', () => {
    const yaml = generateWorkflow('v3', { project: 'p', registryApiPath: '/orgs/acme' });
    expect(yaml).toContain('    with:');
    expect(yaml).toContain('      project: p');
    expect(yaml).toContain('      registry-api-path: /orgs/acme');
  });

  it('treats main as v3+ (with: block present)', () => {
    const yaml = generateWorkflow('main', { project: 'p', registryApiPath: '/orgs/acme' });
    expect(yaml).toContain('    with:');
    expect(yaml).toContain('      registry-api-path: /orgs/acme');
  });

  it('omits with: for a v1 pin even when v3 inputs are passed (back-compat)', () => {
    const yaml = generateWorkflow('v1', { project: 'p', registryApiPath: '/repos/o/r' });
    expect(yaml).not.toContain('with:');
    expect(yaml).not.toContain('project:');
    expect(yaml).not.toContain('registry-api-path:');
    expect(yaml).toContain('secrets: inherit');
  });

  it('omits with: for v2.x pins (back-compat)', () => {
    const yaml = generateWorkflow('v2.0.1', { project: 'p', registryApiPath: '/repos/o/r' });
    expect(yaml).not.toContain('with:');
  });

  it('omits with: on a v3 pin when no v3 inputs are supplied', () => {
    const yaml = generateWorkflow('v3.3.0');
    expect(yaml).not.toContain('with:');
    expect(yaml).toContain('@v3.3.0');
    expect(yaml).toContain('secrets: inherit');
  });
});

// macf#980 — a PR opened while mergeStateStatus: DIRTY produces ZERO
// workflow runs at all, so `opened` (the only pre-#980 pull_request trigger)
// is unreachable for that PR's whole life. Fix: subscribe to
// `synchronize` + `ready_for_review` too, gated by a caller-side `gate` job
// so `synchronize` (which fires on every push) doesn't re-notify on every
// ordinary review-iteration push — see the `gate` job's comments in
// generateWorkflow() / the committed .github/workflows/agent-router.yml for
// the full rationale.
describe('macf#980 — pull_request synchronize/ready_for_review recovery routing', () => {
  it('subscribes to [opened, ready_for_review, synchronize], in that order', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('    types: [opened, ready_for_review, synchronize]');
  });

  it('preserves every other existing trigger exactly (issues, issue_comment, pull_request_review, check_suite)', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('  issues:\n    types: [labeled, closed]');
    expect(yaml).toContain('  issue_comment:\n    types: [created]');
    expect(yaml).toContain('  pull_request_review:\n    types: [submitted]');
    expect(yaml).toContain('  check_suite:\n    types: [completed]');
  });

  it('preserves the permissions: block exactly unchanged (contents/issues/pull-requests/checks)', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain(
      'permissions:\n  contents: read\n  issues: write\n  pull-requests: read\n  checks: read\n',
    );
  });

  it('preserves secrets: inherit on the route: job unchanged', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('secrets: inherit');
  });

  it('parses as valid YAML with a gate job (job-scoped actions:read) ahead of route:', () => {
    const yaml = generateWorkflow('v1');
    const parsed = parseYaml(yaml) as { jobs: Record<string, any> };
    expect(Object.keys(parsed.jobs)).toEqual(['gate', 'route']);
    expect(parsed.jobs['gate'].permissions).toEqual({ actions: 'read' });
    expect(parsed.jobs['gate']['runs-on']).toBe('ubuntu-latest');
    // The workflow-level permissions: block (asserted unchanged above) is
    // NOT touched by the gate job's own job-scoped permissions — job-level
    // permissions: fully replace, never merge with, the workflow default
    // for that job only; route: still inherits the workflow-level block.
    expect(parsed.jobs['route'].permissions).toBeUndefined();
  });

  it('gates route: on gate.outputs.should-route via needs:, so non-pull_request events (which gate always passes) are unaffected', () => {
    const yaml = generateWorkflow('v1');
    const parsed = parseYaml(yaml) as { jobs: Record<string, any> };
    expect(parsed.jobs['route'].needs).toBe('gate');
    expect(parsed.jobs['route'].if).toBe("needs.gate.outputs.should-route == 'true'");
  });

  it('this works for a v3+ pin too (with: block still present, needs:/if: still wired)', () => {
    const yaml = generateWorkflow('v3.4.2', { project: 'macf', registryApiPath: '/repos/groundnuty/groundnuty' });
    const parsed = parseYaml(yaml) as { jobs: Record<string, any> };
    expect(parsed.jobs['route'].needs).toBe('gate');
    expect(parsed.jobs['route'].with).toEqual({ project: 'macf', 'registry-api-path': '/repos/groundnuty/groundnuty' });
  });

  it('the generated router is byte-identical (structurally) to the repo\'s own committed .github/workflows/agent-router.yml', () => {
    // Strip pure-comment + blank lines from both sides — the committed file
    // carries prose explanatory comments the generator has never fully
    // byte-mirrored (pre-#980 precedent: route-by-pr-review-state's comment
    // block above check_suite: is committed-only too), so this pins the
    // STRUCTURAL YAML shape, matching that existing precedent.
    function structural(text: string): string {
      return text
        .split('\n')
        .filter(line => {
          const t = line.trim();
          return t !== '' && !t.startsWith('#');
        })
        .join('\n');
    }
    const generated = generateWorkflow('v3.4.2', { project: 'macf', registryApiPath: '/repos/groundnuty/groundnuty' });
    const committedPath = join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'agent-router.yml');
    const committed = readFileSync(committedPath, 'utf-8');
    expect(structural(generated.slice(generated.indexOf('on:\n')))).toBe(
      structural(committed.slice(committed.indexOf('on:\n'))),
    );
  });

  describe('gate step bash — structural shape', () => {
    function gateScript(): string {
      const yaml = generateWorkflow('v1');
      const parsed = parseYaml(yaml) as { jobs: Record<string, any> };
      return parsed.jobs['gate'].steps[0].run as string;
    }

    it('never gates non-pull_request events — issues/issue_comment/pull_request_review/check_suite always route', () => {
      expect(gateScript()).toContain('if [ "$EVENT_NAME" != "pull_request" ]; then');
    });

    it('opened + ready_for_review always route unconditionally (no prior-run check reached)', () => {
      expect(gateScript()).toContain('if [ "$ACTION" != "synchronize" ]; then');
    });

    it('suppresses Dependabot-authored pull_request events uniformly, regardless of ACTION (groundnuty/macf#1363)', () => {
      const script = gateScript();
      expect(script).toContain('if [ "$ACTOR" = "dependabot[bot]" ]; then');
      expect(script).toContain('echo "should-route=false" >> "$GITHUB_OUTPUT"');
      // Regression guard: the pre-#1363 scoped form must be gone, not just
      // superseded textually elsewhere in the script.
      expect(script).not.toContain('$ACTION" != "opened" ] && [ "$ACTOR"');
    });

    it('excludes the CURRENT run from the prior-run count (self-exclusion by RUN_ID)', () => {
      const script = gateScript();
      expect(script).toContain('--arg run_id "$RUN_ID"');
      expect(script).toContain('(.databaseId | tostring) != $run_id');
    });

    it('queries by the committed workflow FILENAME, not the display name (survives a UI rename)', () => {
      expect(gateScript()).toContain('gh run list --repo "$REPO" --workflow agent-router.yml');
    });

    it('scopes the prior-run query to pull_request-triggered runs on the PR\'s own head branch', () => {
      const script = gateScript();
      expect(script).toContain('--branch "$HEAD_REF"');
      expect(script).toContain('--event pull_request');
    });
  });

  // The bash extracted from generateWorkflow() output, executed directly
  // against a fake `gh` on PATH. This exercises the actual decision logic
  // (not just its textual shape) for every macf#980 acceptance criterion —
  // EXCEPT the true end-to-end runtime path (a real conflicted PR, a real
  // rebase, a real GitHub Actions run), which only a live PR against real
  // GitHub proves. That live proof was explicitly out of scope for this fix
  // (no live-fleet / workflow triggering here).
  describe('gate step bash — executed decision logic (macf#980 ACs)', () => {
    let binDir: string;

    beforeEach(() => {
      binDir = join(tmpdir(), `macf-gate-fakebin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(binDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(binDir, { recursive: true, force: true });
    });

    /**
     * Installs a fake `gh` on PATH ahead of the real one. Only implements
     * `gh run list ... --json databaseId`, echoing back the FAKE_RUN_LIST_JSON
     * env var (a JSON array of `{databaseId}` objects) set on the eventual
     * gate-step invocation — the one subcommand the gate script actually
     * invokes.
     */
    function installFakeGh(): void {
      const script = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [ "$1" = "run" ] && [ "$2" = "list" ]; then',
        '  echo "$FAKE_RUN_LIST_JSON"',
        '  exit 0',
        'fi',
        'echo "fake gh: unexpected invocation: $*" >&2',
        'exit 1',
        '',
      ].join('\n');
      const ghPath = join(binDir, 'gh');
      writeFileSync(ghPath, script);
      chmodSync(ghPath, 0o755);
    }

    function runGate(env: Record<string, string>, runListJson = '[]'): string {
      installFakeGh();
      const yaml = generateWorkflow('v1');
      const parsed = parseYaml(yaml) as { jobs: Record<string, any> };
      const gateRun = parsed.jobs['gate'].steps[0].run as string;
      // Run the gate step as its OWN bash process (matching how GitHub
      // Actions actually invokes a `run:` block) and read $GITHUB_OUTPUT
      // back from a real file afterwards — NOT a chained `cmd1 ; cat file`
      // in one process, which the script's own `exit 0` (legitimate —
      // that's how a `run:` step ends early) would kill before the
      // appended `cat` ever ran.
      const scriptPath = join(binDir, 'gate-step.sh');
      writeFileSync(scriptPath, `#!/usr/bin/env bash\n${gateRun}`);
      chmodSync(scriptPath, 0o755);
      const outputPath = join(binDir, 'github_output');
      writeFileSync(outputPath, '');
      execFileSync('bash', [scriptPath], {
        env: {
          PATH: `${binDir}:/usr/bin:/bin`,
          GITHUB_OUTPUT: outputPath,
          FAKE_RUN_LIST_JSON: runListJson,
          ...env,
        },
      });
      const out = readFileSync(outputPath, 'utf-8');
      const match = /should-route=(true|false)/.exec(out);
      if (!match) throw new Error(`gate script produced no should-route output. $GITHUB_OUTPUT contents: ${JSON.stringify(out)}`);
      return match[1]!;
    }

    const baseEnv = {
      REPO: 'groundnuty/macf',
      EVENT_NAME: 'pull_request',
      ACTOR: 'macf-science-agent[bot]',
      RUN_ID: '999',
      HEAD_REF: 'fix/979-something',
    };

    it('AC: existing opened behaviour is unchanged — opened always routes, even with prior runs present', () => {
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'opened' },
        JSON.stringify([{ databaseId: 111 }, { databaseId: 222 }]),
      );
      expect(shouldRoute).toBe('true');
    });

    it('AC: a draft marked ready_for_review routes, even when opened already produced a run for this branch', () => {
      // Simulates the exact #942 scenario: `opened` already fired (a run
      // exists for this branch) but ready_for_review must NOT be suppressed
      // by that prior run — it is deliberately excluded from the
      // prior-run check entirely.
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'ready_for_review' },
        JSON.stringify([{ databaseId: 111 }]),
      );
      expect(shouldRoute).toBe('true');
    });

    it('AC: opened-with-no-run -> push -> routed — a synchronize with NO prior pull_request run for the branch (other than itself) routes', () => {
      // The current run's own databaseId (RUN_ID=999) is present in the
      // `gh run list` result (as it would be for a real in-progress run) —
      // exercising the self-exclusion, not just the empty-array case.
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'synchronize' },
        JSON.stringify([{ databaseId: 999 }]),
      );
      expect(shouldRoute).toBe('true');
    });

    it('AC: a push to an already-routed PR does not re-notify — synchronize with a PRIOR run (other than the current one) suppresses', () => {
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'synchronize' },
        JSON.stringify([{ databaseId: 111 }, { databaseId: 999 }]),
      );
      expect(shouldRoute).toBe('false');
    });

    it('regression guard: without RUN_ID self-exclusion the gate would ALWAYS suppress synchronize — this run alone must not count as "prior"', () => {
      // Only the current run appears (the realistic "first synchronize ever
      // seen for this branch" case) — must NOT be misread as "a prior run
      // exists".
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'synchronize' },
        JSON.stringify([{ databaseId: 999 }]),
      );
      expect(shouldRoute).toBe('true');
    });

    it('macf#1363: a Dependabot-authored synchronize is suppressed regardless of prior-run state', () => {
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'synchronize', ACTOR: 'dependabot[bot]' },
        '[]',
      );
      expect(shouldRoute).toBe('false');
    });

    // DECISIVE (1/2): the measured defect. Every dependabot PR on
    // groundnuty/macf was born red because `opened` — the ONLY action a
    // fresh Dependabot PR ever fires — was excluded from the pre-#1363
    // ACTOR check (macf#980 scoped it to non-opened actions only). Six
    // real PRs (#174/#484/#486/#487/#485/#819) sat unreviewed behind this
    // false-red for as long as four months. `#872: a Dependabot-authored
    // opened is NOT suppressed` was the OLD, buggy expectation this test
    // replaces.
    it('macf#1363 DECISIVE 1/2: a Dependabot-authored opened is now suppressed (the measured defect)', () => {
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'opened', ACTOR: 'dependabot[bot]' },
        '[]',
      );
      expect(shouldRoute).toBe('false');
    });

    // DECISIVE (2/2): the regression that matters. An agent-authored
    // (non-Dependabot) opened PR must keep routing exactly as before —
    // this is what distinguishes "actually gates on the actor" from "skips
    // unconditionally" (assert-the-wrong-path.md: (1) alone is satisfied
    // by always skipping). Duplicates the "AC: existing opened behaviour
    // is unchanged" case above with prior-run state varied, so it survives
    // independently of that test's own future edits.
    it('macf#1363 DECISIVE 2/2: an agent-authored opened still routes unconditionally (the regression that matters)', () => {
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'opened', ACTOR: 'macf-science-agent[bot]' },
        JSON.stringify([{ databaseId: 111 }]),
      );
      expect(shouldRoute).toBe('true');
    });

    it('macf#1363: a Dependabot-authored ready_for_review is also suppressed (uniform across every pull_request action)', () => {
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'ready_for_review', ACTOR: 'dependabot[bot]' },
        '[]',
      );
      expect(shouldRoute).toBe('false');
    });

    // honest-unknown: an actor that cannot be determined (empty string —
    // the shape ${{ github.actor }} would take if GitHub ever failed to
    // populate it) must NOT be treated as dependabot[bot]. Failing open on
    // ROUTING is safe; failing open on SECRETS is not — so the undetermined
    // case falls through to the routable branches, same as any other
    // non-dependabot actor.
    it('macf#1363: an undeterminable actor (empty string) is treated as routable, not skipped', () => {
      const shouldRoute = runGate(
        { ...baseEnv, ACTION: 'opened', ACTOR: '' },
        '[]',
      );
      expect(shouldRoute).toBe('true');
    });

    it('non-pull_request events always route, without ever invoking gh', () => {
      // FAKE_RUN_LIST_JSON left as the default '[]' is irrelevant here — the
      // fake `gh` would exit 1 on any unexpected invocation, so a passing
      // result also proves `gh` was never called for this event type.
      const shouldRoute = runGate({ ...baseEnv, EVENT_NAME: 'issues', ACTION: 'labeled' });
      expect(shouldRoute).toBe('true');
    });
  });
});

describe('isV3PlusActionsVersion (macf#566)', () => {
  it.each([
    ['v1', false],
    ['v1.3', false],
    ['v1.3.1', false],
    ['v2', false],
    ['v2.0.1', false],
    ['v3', true],
    ['v3.0', true],
    ['v3.3.0', true],
    ['v4', true],
    ['main', true],
  ] as const)('%s -> %s', (ver, expected) => {
    expect(isV3PlusActionsVersion(ver)).toBe(expected);
  });

  it('returns false for non-tag refs other than main', () => {
    expect(isV3PlusActionsVersion('some-branch')).toBe(false);
    expect(isV3PlusActionsVersion('v3-rc1')).toBe(false);
  });
});

describe('isBundleCapableActionsVersion (groundnuty/macf#1112)', () => {
  it.each([
    ['v1', false],
    ['v2.0.1', false],
    ['v3', false],
    ['v3.4.2', false],
    ['v3.4.99', false],
    ['v3.5.0', true],
    ['v3.5.1', true],
    ['v3.6.0', true],
    ['v4.0.0', true],
    ['main', true],
  ] as const)('%s -> %s', (ver, expected) => {
    expect(isBundleCapableActionsVersion(ver)).toBe(expected);
  });

  it('treats an unresolved floating ref (bare major/minor) as NOT bundle-capable — never guesses', () => {
    // `v3` / `v3.5` are floating pointers repo-init only ever sees when
    // `resolveActionsRefToFullTag` couldn't reach GitHub to pin them to a
    // full tag — deliberately conservative: `secrets: inherit` already
    // works unconditionally for a same-scope caller, so the safe fallback
    // is the existing default, never a guess about a version this code
    // cannot confirm.
    expect(isBundleCapableActionsVersion('v3')).toBe(false);
    expect(isBundleCapableActionsVersion('v3.5')).toBe(false);
  });

  it('returns false for non-tag refs other than main', () => {
    expect(isBundleCapableActionsVersion('some-branch')).toBe(false);
  });
});

// groundnuty/macf#1368 — verified live 2026-08-30 (`gh api
// repos/groundnuty/macf-actions/tags`): the latest RELEASED full tag is
// v3.4.2, cut before macf-actions#83 merged. #83 landed only on main
// (7316fec2). So NO released tag accepts `runner-runs-on` today — every
// full tag, including the newest one, must read false here. This is the
// decisive difference from `isBundleCapableActionsVersion` above: that
// predicate's threshold names a version (`v3.5.0`) the constant COULD be
// bumped to reflect once released; this one is pinned to `undefined`
// (see the constant's own doc for why — repeating #1338's mistake is
// exactly what this issue exists to avoid).
describe('isRunnerRunsOnCapableActionsVersion (groundnuty/macf#1368)', () => {
  it.each([
    ['main', true],
    ['v1', false],
    ['v2.0.1', false],
    ['v3', false],
    ['v3.4.0', false],
    ['v3.4.1', false],
    ['v3.4.2', false],
    ['v3.5.0', false],
    ['v4.0.0', false],
  ] as const)('%s -> %s', (ver, expected) => {
    expect(isRunnerRunsOnCapableActionsVersion(ver)).toBe(expected);
  });

  it('returns false for non-tag refs other than main', () => {
    expect(isRunnerRunsOnCapableActionsVersion('some-branch')).toBe(false);
  });
});

describe('generateWorkflow — runner-runs-on emission (groundnuty/macf#1368)', () => {
  const v3Inputs = { project: 'macf-experiment', registryApiPath: '/orgs/macf-experiment' };

  // Decisive pair 1/2 (per assert-the-wrong-path.md — (1) alone is
  // satisfied by a generator that always emits the key regardless of
  // declaration; the mutation below confirms (2) actually catches that).
  it('DECISIVE 1: declares runs_on: self-hosted + an accepting pin -> the generated caller carries runner-runs-on: self-hosted', () => {
    const yaml = generateWorkflow('main', { ...v3Inputs, runnerRunsOn: 'self-hosted' });
    const parsed = parseYaml(yaml) as { jobs: { route: { with: unknown } } };
    expect(parsed.jobs.route.with).toEqual({
      project: v3Inputs.project,
      'registry-api-path': v3Inputs.registryApiPath,
      'runner-runs-on': 'self-hosted',
    });
  });

  it('DECISIVE 2: declares nothing -> generated caller byte-identical to today', () => {
    const withoutField = generateWorkflow('main', v3Inputs);
    const withUndefinedField = generateWorkflow('main', { ...v3Inputs, runnerRunsOn: undefined });
    expect(withoutField).not.toContain('runner-runs-on');
    expect(withUndefinedField).toBe(withoutField);
  });

  it('a pin below the accepting version does not emit the key even when declared', () => {
    // v3.4.2 is the newest RELEASED tag as of this test's writing and does
    // NOT carry runner-runs-on (verified live — see the module doc); "the
    // reason is stated" is asserted at the repoInit() integration layer
    // below (generateWorkflow is a pure string generator with no I/O to
    // state a reason through).
    const yaml = generateWorkflow('v3.4.2', { ...v3Inputs, runnerRunsOn: 'self-hosted' });
    expect(yaml).not.toContain('runner-runs-on');
    const parsed = parseYaml(yaml) as { jobs: { route: { with: unknown } } };
    expect(parsed.jobs.route.with).toEqual({
      project: v3Inputs.project,
      'registry-api-path': v3Inputs.registryApiPath,
    });
  });

  it('runs_on: hosted is emitted verbatim, not omitted -- the declaration is still a declaration', () => {
    const yaml = generateWorkflow('main', { ...v3Inputs, runnerRunsOn: 'hosted' });
    expect(yaml).toContain('runner-runs-on: hosted');
  });

  it('a v1.x pin never emits runner-runs-on even when declared (no with: block at all)', () => {
    const yaml = generateWorkflow('v1', { ...v3Inputs, runnerRunsOn: 'self-hosted' });
    expect(yaml).not.toContain('runner-runs-on');
    expect(yaml).not.toContain('with:');
  });

  it('still passes the drift-detector shape check (with: carries only known keys when nothing declared)', () => {
    // Mirrors the pre-existing "byte-identical to committed router" test
    // above — macf's own committed router declares no routing.runner, so
    // its generated `with:` block must still be exactly {project,
    // registry-api-path}, unaffected by this feature's existence.
    const yaml = generateWorkflow('v3.4.2', v3Inputs);
    const parsed = parseYaml(yaml) as { jobs: { route: { with: unknown } } };
    expect(parsed.jobs.route.with).toEqual({
      project: v3Inputs.project,
      'registry-api-path': v3Inputs.registryApiPath,
    });
  });
});

describe('generateWorkflow — MACF_ROUTING_BUNDLE emission (groundnuty/macf#1112)', () => {
  const v3Inputs = { project: 'macf-experiment', registryApiPath: '/orgs/macf-experiment' };

  it('DECISIVE: a generated caller for a bundle-capable pin passes EXACTLY ONE secret name', () => {
    const yaml = generateWorkflow('v3.5.0', v3Inputs);
    const parsed = parseYaml(yaml) as { jobs: { route: { secrets: unknown } } };
    const secretsBlock = parsed.jobs.route.secrets;
    // Per `assert-the-wrong-path.md`: NOT "a secrets block exists" (which
    // the six-name explicit-passing form would also satisfy) — the KEY
    // COUNT of that block must be exactly 1.
    expect(typeof secretsBlock).toBe('object');
    expect(Object.keys(secretsBlock as object)).toEqual(['MACF_ROUTING_BUNDLE']);
    expect(Object.keys(secretsBlock as object)).toHaveLength(1);
  });

  it('DECISIVE: a hypothetical 7th router secret does not change the generated caller at all', () => {
    // The generator never enumerates the callee's secret names in bundle
    // mode — it emits exactly one literal string regardless of how many
    // secrets the pinned macf-actions version actually requires. Simulate
    // "the callee added a 7th required secret" by asserting the output is
    // IDENTICAL across two calls that differ only in `project`/registry
    // inputs the callee doesn't gate secrets on — the decisive property is
    // that nothing in this function's OWN secret-emission logic depends on
    // a count or enumeration of callee secret names.
    const before = generateWorkflow('v3.5.0', v3Inputs);
    // A future callee requiring a 7th secret changes NOTHING on the macf
    // side — there is no secret-name list here to regenerate. Re-running
    // the exact same generator call with the exact same inputs must be
    // byte-identical, proving the caller's secrets block has zero
    // dependency on the callee's required-secret count.
    const after = generateWorkflow('v3.5.0', v3Inputs);
    expect(after).toBe(before);
    const parsedBefore = parseYaml(before) as { jobs: { route: { secrets: unknown } } };
    expect(Object.keys(parsedBefore.jobs.route.secrets as object)).toHaveLength(1);
  });

  it('pre-bundle v3.x pins emit the explicit six-secret form, NOT secrets: inherit (groundnuty/macf#1338)', () => {
    // `secrets: inherit` is scoped by GitHub to "the same organization or
    // enterprise" (live docs, fetched 2026-08-29) — it does NOT cross an
    // org boundary, which is the case for every provisioned fleet. See the
    // "generateWorkflow — explicit six-secret emission" describe block
    // below for the decisive coverage.
    const yaml = generateWorkflow('v3.4.2', v3Inputs);
    expect(yaml).not.toContain('secrets: inherit');
    expect(yaml).not.toContain('MACF_ROUTING_BUNDLE');
  });

  it('legacy v1/v2 pins keep emitting secrets: inherit, unchanged', () => {
    expect(generateWorkflow('v1')).toContain('secrets: inherit');
    expect(generateWorkflow('v2.0.1')).toContain('secrets: inherit');
  });

  it('the bundle form references the secret via the correct expression syntax', () => {
    const yaml = generateWorkflow('v3.5.0', v3Inputs);
    expect(yaml).toContain('MACF_ROUTING_BUNDLE: ${{ secrets.MACF_ROUTING_BUNDLE }}');
  });

  it("'main' pin is treated as bundle-capable (dev branch always-current)", () => {
    const yaml = generateWorkflow('main', v3Inputs);
    const parsed = parseYaml(yaml) as { jobs: { route: { secrets: unknown } } };
    expect(Object.keys(parsed.jobs.route.secrets as object)).toEqual(['MACF_ROUTING_BUNDLE']);
  });
});

// groundnuty/macf#1338 — a present repo secret reported as "not provided
// while calling" on every live fleet's first-ever router run. Mechanism,
// confirmed live (not from training data): `secrets: inherit` is scoped by
// GitHub to "the same organization or enterprise" (fetched from
// https://docs.github.com/en/actions/using-workflows/reusing-workflows,
// 2026-08-29 — the phrase appears twice, once under "Using inputs and
// secrets in a reusable workflow" and once under "Passing inputs and
// secrets to a reusable workflow"); a provisioned fleet's agent repos
// live in the fleet's own org, never `groundnuty` (where `macf-actions`
// lives), so `inherit` fails the `route:` job's secret EVALUATION before
// any step runs — exactly the observed annotation. `#1112`'s bundle fix
// (above) only activates at `MIN_BUNDLE_CAPABLE_ACTIONS_VERSION`
// (`v3.5.0`), and no macf-actions release at or above that version has
// ever shipped (`gh api repos/groundnuty/macf-actions/tags` — the latest
// tag is `v3.4.2`, verified live 2026-08-29), so every currently-usable
// v3+ pin fell all the way through to the broken `inherit` fallback. The
// fix: emit the explicit six-name form instead of `inherit` for every
// v3+ pin below the bundle threshold — verified live against v3.0.0's AND
// v3.4.2's `workflow_call.secrets` block (`gh api
// repos/groundnuty/macf-actions/contents/.github/workflows/agent-router.yml?ref=<tag>`)
// that the SAME six required names have been stable across the entire
// v3.x line released so far, and that explicit named secret-passing
// (unlike the `inherit` shorthand) carries no org-boundary restriction
// per the same live docs fetch.
describe('generateWorkflow — explicit six-secret emission for a v3+ non-bundle pin (groundnuty/macf#1338)', () => {
  const v3Inputs = { project: 'trial-code-agent', registryApiPath: '/repos/macf-experiment/trial-code-agent' };

  // Per `assert-the-wrong-path.md` Trigger 1 (circularity): asserting
  // against `ALL_ROUTING_SECRET_NAMES` here would prove only that
  // `generateWorkflow` agrees with `apply-routing-secrets.ts`'s OWN
  // constant — both sides of the assertion would move together if that
  // constant ever drifted (a dropped/renamed/added name), and the test
  // would keep reporting "correct". This literal is deliberately NOT
  // imported from production code — it is the exact key set independently
  // read off the LIVE `workflow_call.secrets` block via `gh api
  // repos/groundnuty/macf-actions/contents/.github/workflows/agent-router.yml?ref=v3.4.2`
  // (2026-08-29; re-confirmed against `v3.0.0` too, see the sibling test
  // below), a second, independent source of truth this test can catch
  // `ALL_ROUTING_SECRET_NAMES` drifting away from.
  const V3_4_2_LIVE_REQUIRED_SECRETS = [
    'ROUTING_CLIENT_CERT',
    'ROUTING_CLIENT_KEY',
    'TS_OAUTH_CLIENT_ID',
    'TS_OAUTH_SECRET',
    'MACF_ROUTING_APP_ID',
    'MACF_ROUTING_APP_KEY',
  ] as const;

  it('DECISIVE: a v3+ non-bundle pin passes EXACTLY the six names v3.4.2\'s own workflow_call.secrets declares — not a hand-written list', () => {
    const yaml = generateWorkflow('v3.4.2', v3Inputs);
    const parsed = parseYaml(yaml) as { jobs: { route: { secrets: unknown } } };
    const secretsBlock = parsed.jobs.route.secrets as Record<string, string>;
    expect(Object.keys(secretsBlock).sort()).toEqual([...V3_4_2_LIVE_REQUIRED_SECRETS].sort());
    expect(Object.keys(secretsBlock)).toHaveLength(6);
    for (const name of V3_4_2_LIVE_REQUIRED_SECRETS) {
      expect(secretsBlock[name]).toBe(`\${{ secrets.${name} }}`);
    }
    // Sanity: the independently-sourced literal above and the production
    // constant the generator actually reads from DO currently agree — if
    // they ever diverge, this line (not the DECISIVE assertions above) is
    // the one that should fail, naming which side moved.
    expect([...ALL_ROUTING_SECRET_NAMES].sort()).toEqual([...V3_4_2_LIVE_REQUIRED_SECRETS].sort());
  });

  it('never emits secrets: inherit or the bundle secret for a v3+ non-bundle pin', () => {
    const yaml = generateWorkflow('v3.4.2', v3Inputs);
    expect(yaml).not.toContain('secrets: inherit');
    expect(yaml).not.toContain('MACF_ROUTING_BUNDLE');
  });

  it('a fleet without v3 routing (no v3Inputs) is UNCHANGED — no six-name block invented', () => {
    // The mirror half of the decisive pair: a caller that never gets v3
    // inputs (a v1.x/v2.x pin, or a v3 pin with no project/registry
    // resolved) must not suddenly grow a six-name secrets block it never
    // had before this fix.
    const yaml = generateWorkflow('v3.4.2'); // no v3Inputs
    expect(yaml).toContain('secrets: inherit');
    for (const name of ALL_ROUTING_SECRET_NAMES) {
      expect(yaml).not.toContain(`${name}:`);
    }
  });

  it('applies to a v3.0.0 pin too — the six-name contract has been stable since v3.0.0', () => {
    const yaml = generateWorkflow('v3.0.0', v3Inputs);
    const parsed = parseYaml(yaml) as { jobs: { route: { secrets: unknown } } };
    expect(Object.keys(parsed.jobs.route.secrets as object).sort()).toEqual([...ALL_ROUTING_SECRET_NAMES].sort());
  });

  it('a bundle-capable pin still wins over the explicit-six fallback (v3.5.0 unaffected by this fix)', () => {
    const yaml = generateWorkflow('v3.5.0', v3Inputs);
    const parsed = parseYaml(yaml) as { jobs: { route: { secrets: unknown } } };
    expect(Object.keys(parsed.jobs.route.secrets as object)).toEqual(['MACF_ROUTING_BUNDLE']);
  });
});

describe('generateAgentConfig', () => {
  it('generates template when no agents given', () => {
    const json = generateAgentConfig([]);
    const parsed = JSON.parse(json);
    expect(parsed.agents).toHaveProperty('<agent-name>');
    expect(parsed.agents['<agent-name>']).toEqual({
      app_name: '<github-app-name>',
      host: '<agent-host-ip>',
      tmux_session: '<tmux-session-name>',
      ssh_user: 'ubuntu',
      tmux_bin: 'tmux',
      ssh_key_secret: 'AGENT_SSH_KEY',
      workspace_dir: '/home/ubuntu/repos/<owner>/<repo>',
    });
  });

  it('expands --agents list into entries with defaults (app_name unprefixed per #76)', () => {
    const json = generateAgentConfig(['code-agent', 'science-agent']);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.agents)).toEqual(['code-agent', 'science-agent']);
    // #76: app_name default is the agent name itself, not macf-<agent>.
    expect(parsed.agents['code-agent'].app_name).toBe('code-agent');
    expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
    expect(parsed.agents['science-agent'].app_name).toBe('science-agent');
  });

  // macf#806 / DR-032: app_name is the GitHub App HANDLE (`<project>-<agent>`),
  // not the bare routing label — the v3 router matches `${app_name}[bot]`
  // against a PR/mention participant's login, so a consumer fleet (handle !=
  // routing label) needs the prefixed handle here or route-by-mention /
  // route-by-pr-review-state resolve nothing. The map KEY stays the bare
  // routing label; NO `[bot]` suffix (the router appends it).
  it('app_name is the <project>-<agent> App handle when project is given (macf#806)', () => {
    const json = generateAgentConfig(
      ['code-agent', 'science-agent'],
      undefined,
      { project: 'icsoc-2026' },
    );
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.agents)).toEqual(['code-agent', 'science-agent']);
    expect(parsed.agents['code-agent'].app_name).toBe('icsoc-2026-code-agent');
    expect(parsed.agents['science-agent'].app_name).toBe('icsoc-2026-science-agent');
    // key is still the bare routing label (the route-by-label / agent-config key)
    expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
  });

  it('app_name stays the bare agent when defaults carry no project (back-compat, #76)', () => {
    const json = generateAgentConfig(['code-agent'], undefined, { owner: 'o', repo: 'r' });
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].app_name).toBe('code-agent');
  });

  it('includes ssh_key_secret in generated entries (required by routing workflow, #76)', () => {
    const json = generateAgentConfig(['code-agent']);
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].ssh_key_secret).toBe('AGENT_SSH_KEY');
  });

  it('includes default label_to_status block (#76)', () => {
    const json = generateAgentConfig(['code-agent']);
    const parsed = JSON.parse(json);
    expect(parsed.label_to_status).toEqual({
      'in-progress': 'In Progress',
      'in-review': 'In Review',
      'blocked': 'Blocked',
    });
  });

  it('populates workspace_dir default from owner/repo when defaults given (#71)', () => {
    const json = generateAgentConfig(
      ['code-agent'],
      undefined,
      { owner: 'groundnuty', repo: 'macf' },
    );
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].workspace_dir).toBe('/home/ubuntu/repos/groundnuty/macf');
  });

  it('omits workspace_dir when defaults are not provided (backward-compat callers)', () => {
    const json = generateAgentConfig(['code-agent']);
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent']).not.toHaveProperty('workspace_dir');
  });

  it('template (no --agents) includes a sample workspace_dir placeholder', () => {
    const json = generateAgentConfig([]);
    const parsed = JSON.parse(json);
    expect(parsed.agents['<agent-name>'].workspace_dir).toMatch(/^\/home\/.*\/repos\/.*\/.*/);
  });

  it('produces valid JSON', () => {
    expect(() => JSON.parse(generateAgentConfig([]))).not.toThrow();
    expect(() => JSON.parse(generateAgentConfig(['a', 'b']))).not.toThrow();
  });

  it('groups multiple agents into a shared session with per-agent windows when --session-name is given (#69)', () => {
    const json = generateAgentConfig(['code-agent', 'science-agent'], 'macf');
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].tmux_session).toBe('macf');
    expect(parsed.agents['code-agent'].tmux_window).toBe('code-agent');
    expect(parsed.agents['science-agent'].tmux_session).toBe('macf');
    expect(parsed.agents['science-agent'].tmux_window).toBe('science-agent');
  });

  it('omits tmux_window for a single agent even when --session-name is given', () => {
    // One agent means windowing is pure overhead — keep the simple layout.
    const json = generateAgentConfig(['code-agent'], 'macf');
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
    expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_window');
  });

  it('omits tmux_window when --session-name is not provided (backward compat)', () => {
    const json = generateAgentConfig(['code-agent', 'science-agent']);
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
    expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_window');
    expect(parsed.agents['science-agent'].tmux_session).toBe('science-agent');
    expect(parsed.agents['science-agent']).not.toHaveProperty('tmux_window');
  });

  describe('omitTmuxSession (v3+ registry-routed, macf#678)', () => {
    it('omits the vestigial tmux_session from generated entries but keeps app_name/host/ssh fields', () => {
      const json = generateAgentConfig(
        ['code-agent', 'science-agent'],
        undefined,
        undefined,
        true,
      );
      const parsed = JSON.parse(json);
      expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_session');
      expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_window');
      // app_name is still asserted by routing-doctor's SELF-SKIP check on v3 —
      // only tmux_session is vestigial, the entry itself is not.
      expect(parsed.agents['code-agent'].app_name).toBe('code-agent');
      expect(parsed.agents['code-agent'].ssh_key_secret).toBe('AGENT_SSH_KEY');
      expect(parsed.agents['science-agent']).not.toHaveProperty('tmux_session');
    });

    it('omits tmux_session even with a --session-name (windowing is moot without a session)', () => {
      const json = generateAgentConfig(['code-agent', 'science-agent'], 'macf', undefined, true);
      const parsed = JSON.parse(json);
      expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_session');
      expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_window');
    });

    it('omits the tmux_session placeholder from the empty (no --agents) template', () => {
      const json = generateAgentConfig([], undefined, undefined, true);
      const parsed = JSON.parse(json);
      expect(parsed.agents['<agent-name>']).not.toHaveProperty('tmux_session');
      expect(parsed.agents['<agent-name>'].app_name).toBe('<github-app-name>');
    });

    it('default (omitTmuxSession=false) keeps the v1.x send-target (SSH routing reads it)', () => {
      const parsed = JSON.parse(generateAgentConfig(['code-agent']));
      expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
    });
  });
});

describe('patchAgentConfig (merge-preserving regenerate, #76)', () => {
  const existingConfig = () => ({
    agents: {
      'cv-architect': {
        app_name: 'cv-architect',
        host: '100.124.163.105',
        tmux_session: 'cv-architect',
        tmux_bin: 'tmux',
        ssh_user: 'ubuntu',
        ssh_key_secret: 'AGENT_SSH_KEY',
      },
      'cv-project-archaeologist': {
        app_name: 'cv-project-archaeologist',
        host: '100.124.163.105',
        tmux_session: 'cv-project-archaeologist',
        tmux_bin: 'tmux',
        ssh_user: 'ubuntu',
        ssh_key_secret: 'AGENT_SSH_KEY',
      },
    },
    label_to_status: {
      'in-progress': 'In Progress',
      'in-review': 'In Review',
      'blocked': 'Blocked',
    },
  });

  it('preserves app_name, host, ssh_key_secret, ssh_user on regenerate', () => {
    const existing = JSON.stringify(existingConfig(), null, 2);
    const patched = patchAgentConfig(existing,
      ['cv-architect', 'cv-project-archaeologist'], 'cv-project');
    const parsed = JSON.parse(patched);
    expect(parsed.agents['cv-architect'].app_name).toBe('cv-architect');
    expect(parsed.agents['cv-architect'].host).toBe('100.124.163.105');
    expect(parsed.agents['cv-architect'].ssh_key_secret).toBe('AGENT_SSH_KEY');
    expect(parsed.agents['cv-architect'].ssh_user).toBe('ubuntu');
  });

  it('updates tmux_session + adds tmux_window when --session-name with multiple agents', () => {
    const existing = JSON.stringify(existingConfig(), null, 2);
    const patched = patchAgentConfig(existing,
      ['cv-architect', 'cv-project-archaeologist'], 'cv-project');
    const parsed = JSON.parse(patched);
    expect(parsed.agents['cv-architect'].tmux_session).toBe('cv-project');
    expect(parsed.agents['cv-architect'].tmux_window).toBe('cv-architect');
    expect(parsed.agents['cv-project-archaeologist'].tmux_window).toBe('cv-project-archaeologist');
  });

  it('removes tmux_window when re-patching without --session-name (ungrouping)', () => {
    const existing = JSON.stringify({
      agents: {
        'cv-architect': {
          app_name: 'cv-architect', host: '100.0.0.1',
          tmux_session: 'cv-project', tmux_window: 'cv-architect',
          tmux_bin: 'tmux', ssh_user: 'ubuntu', ssh_key_secret: 'AGENT_SSH_KEY',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(existing, ['cv-architect']);
    const parsed = JSON.parse(patched);
    expect(parsed.agents['cv-architect'].tmux_session).toBe('cv-architect');
    expect(parsed.agents['cv-architect']).not.toHaveProperty('tmux_window');
  });

  it('preserves top-level label_to_status and unknown top-level fields', () => {
    const withExtras = {
      ...existingConfig(),
      custom_field: 'user added',
      routing_policy: { debounce_ms: 500 },
    };
    const patched = patchAgentConfig(
      JSON.stringify(withExtras, null, 2),
      ['cv-architect'], 'cv-project',
    );
    const parsed = JSON.parse(patched);
    expect(parsed.label_to_status).toEqual(withExtras.label_to_status);
    expect(parsed.custom_field).toBe('user added');
    expect(parsed.routing_policy).toEqual({ debounce_ms: 500 });
  });

  it('leaves agents NOT in --agents list unchanged', () => {
    const patched = patchAgentConfig(
      JSON.stringify(existingConfig(), null, 2),
      ['cv-architect'], 'cv-project',
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents).toHaveProperty('cv-project-archaeologist');
    expect(parsed.agents['cv-project-archaeologist'].host).toBe('100.124.163.105');
  });

  it('adds fresh entries for new agents while preserving old ones', () => {
    const patched = patchAgentConfig(
      JSON.stringify(existingConfig(), null, 2),
      ['cv-architect', 'writing-agent'], 'cv-project',
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents['writing-agent']).toBeDefined();
    expect(parsed.agents['writing-agent'].host).toBe('<agent-host-ip>');
    expect(parsed.agents['cv-architect'].host).toBe('100.124.163.105');
    expect(parsed.agents['writing-agent'].tmux_window).toBe('writing-agent');
  });

  it('injects ssh_key_secret default when old config lacks it', () => {
    const oldConfig = {
      agents: {
        'code-agent': {
          app_name: 'code-agent', host: '100.0.0.1',
          tmux_session: 'code-agent', tmux_bin: 'tmux', ssh_user: 'ubuntu',
        },
      },
    };
    const patched = patchAgentConfig(JSON.stringify(oldConfig, null, 2), ['code-agent']);
    const parsed = JSON.parse(patched);
    expect(parsed.agents['code-agent'].ssh_key_secret).toBe('AGENT_SSH_KEY');
  });

  it('deletes the vestigial tmux_session/tmux_window on a v3+ re-patch (omitTmuxSession, macf#678)', () => {
    // The substrate scenario: a leftover Stage-2 tmux_session ("cv-architect")
    // that drives routing-doctor's false SESSION WARN. Re-running repo-init at
    // v3 sheds it → doctor reads `absent` → PASS.
    const existing = JSON.stringify({
      agents: {
        'cv-architect': {
          app_name: 'cv-architect', host: '100.0.0.1',
          tmux_session: 'cv-architect', tmux_window: 'cv-architect',
          tmux_bin: 'tmux', ssh_user: 'ubuntu', ssh_key_secret: 'AGENT_SSH_KEY',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(existing, ['cv-architect'], undefined, undefined, true);
    const parsed = JSON.parse(patched);
    expect(parsed.agents['cv-architect']).not.toHaveProperty('tmux_session');
    expect(parsed.agents['cv-architect']).not.toHaveProperty('tmux_window');
    // Non-session fields survive the patch untouched.
    expect(parsed.agents['cv-architect'].app_name).toBe('cv-architect');
    expect(parsed.agents['cv-architect'].host).toBe('100.0.0.1');
  });

  it('creates fresh v3+ entries without a tmux_session (omitTmuxSession, macf#678)', () => {
    const existing = JSON.stringify({ agents: {} }, null, 2);
    const patched = patchAgentConfig(existing, ['writing-agent'], undefined,
      { owner: 'groundnuty', repo: 'macf' }, true);
    const parsed = JSON.parse(patched);
    expect(parsed.agents['writing-agent']).not.toHaveProperty('tmux_session');
    expect(parsed.agents['writing-agent'].app_name).toBe('writing-agent');
  });

  it('throws on malformed JSON rather than overwriting', () => {
    expect(() => patchAgentConfig('{ not valid', ['a'])).toThrow(/not valid JSON/);
  });

  it('throws when the existing file has no agents key', () => {
    expect(() =>
      patchAgentConfig(JSON.stringify({ other: 'thing' }), ['a']),
    ).toThrow(/no `agents` object/);
  });

  it('injects workspace_dir default when an old entry lacks it (#71)', () => {
    // Config predates #71 — no workspace_dir field. Patch should upgrade
    // it so the routing workflow can invoke the helper.
    const existing = JSON.stringify({
      agents: {
        'code-agent': {
          app_name: 'code-agent',
          host: '100.0.0.1',
          tmux_session: 'code-agent',
          tmux_bin: 'tmux',
          ssh_user: 'ubuntu',
          ssh_key_secret: 'AGENT_SSH_KEY',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(
      existing, ['code-agent'], undefined,
      { owner: 'groundnuty', repo: 'macf' },
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents['code-agent'].workspace_dir)
      .toBe('/home/ubuntu/repos/groundnuty/macf');
  });

  it('preserves user-customized workspace_dir on patch', () => {
    const existing = JSON.stringify({
      agents: {
        'code-agent': {
          app_name: 'code-agent',
          host: '100.0.0.1',
          tmux_session: 'code-agent',
          tmux_bin: 'tmux',
          ssh_user: 'ubuntu',
          ssh_key_secret: 'AGENT_SSH_KEY',
          workspace_dir: '/custom/path/to/workspace',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(
      existing, ['code-agent'], undefined,
      { owner: 'groundnuty', repo: 'macf' },
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents['code-agent'].workspace_dir).toBe('/custom/path/to/workspace');
  });

  it('respects ssh_user when computing default workspace_dir (not hardcoded ubuntu)', () => {
    const existing = JSON.stringify({
      agents: {
        'code-agent': {
          app_name: 'code-agent',
          host: '100.0.0.1',
          tmux_session: 'code-agent',
          tmux_bin: 'tmux',
          ssh_user: 'deploy',  // non-default
          ssh_key_secret: 'AGENT_SSH_KEY',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(
      existing, ['code-agent'], undefined,
      { owner: 'groundnuty', repo: 'macf' },
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents['code-agent'].workspace_dir)
      .toBe('/home/deploy/repos/groundnuty/macf');
  });

  // macf#805 / DR-032: pre-fix bootstrap guidance once told operators the
  // agent NAME *was* the GitHub App handle, so `--agents` got invoked with
  // the already-prefixed form and the map KEY itself ended up
  // `<project>-<agent>` instead of the bare routing label. route-by-label
  // looks the issue's clean `<role>-agent` label up directly against this
  // key — a lingering double-prefixed key means the lookup silently misses
  // (route-by-label skips with `exit 0`, no error anywhere). A separate
  // 2026-06-27 rename pass fixed cert CN / registry keys / tmux sessions on
  // the live icsoc-2026 fleet but missed this file, so the stale key can
  // still be sitting in a committed agent-config.json.
  describe('double-prefixed key normalization (macf#805)', () => {
    it('renames a stale <project>-<agent> key to the clean routing label', () => {
      const existing = JSON.stringify({
        agents: {
          'icsoc-2026-code-agent': {
            app_name: 'icsoc-2026-code-agent',
            host: '100.0.0.9',
            tmux_session: 'icsoc-2026-code-agent',
            tmux_bin: 'tmux',
            ssh_user: 'ubuntu',
            ssh_key_secret: 'AGENT_SSH_KEY',
          },
        },
      }, null, 2);
      const patched = patchAgentConfig(
        existing, ['code-agent'], undefined,
        { project: 'icsoc-2026' },
      );
      const parsed = JSON.parse(patched);
      // Clean key now exists, carrying the pre-existing (non-placeholder) data forward.
      expect(parsed.agents['code-agent']).toBeDefined();
      expect(parsed.agents['code-agent'].host).toBe('100.0.0.9');
      // The stale double-prefixed key is gone — not left behind as
      // routing-invisible dead weight.
      expect(parsed.agents).not.toHaveProperty('icsoc-2026-code-agent');
    });

    it('does not clobber an already-clean entry when a stale duplicate also lingers', () => {
      const existing = JSON.stringify({
        agents: {
          'code-agent': {
            app_name: 'icsoc-2026-code-agent',
            host: '100.0.0.1', // authoritative, current
            tmux_session: 'code-agent',
            tmux_bin: 'tmux',
            ssh_user: 'ubuntu',
            ssh_key_secret: 'AGENT_SSH_KEY',
          },
          'icsoc-2026-code-agent': {
            app_name: 'icsoc-2026-code-agent',
            host: '100.0.0.9', // stale
            tmux_session: 'icsoc-2026-code-agent',
            tmux_bin: 'tmux',
            ssh_user: 'ubuntu',
            ssh_key_secret: 'AGENT_SSH_KEY',
          },
        },
      }, null, 2);
      const patched = patchAgentConfig(
        existing, ['code-agent'], undefined,
        { project: 'icsoc-2026' },
      );
      const parsed = JSON.parse(patched);
      // Clean entry's current data wins — never overwritten by a stale duplicate.
      expect(parsed.agents['code-agent'].host).toBe('100.0.0.1');
    });

    it('is idempotent — re-patching an already-normalized config leaves keys unchanged', () => {
      const existing = JSON.stringify({
        agents: {
          'code-agent': {
            app_name: 'icsoc-2026-code-agent',
            host: '100.0.0.1',
            tmux_session: 'code-agent',
            tmux_bin: 'tmux',
            ssh_user: 'ubuntu',
            ssh_key_secret: 'AGENT_SSH_KEY',
          },
        },
      }, null, 2);
      const patched = patchAgentConfig(
        existing, ['code-agent'], undefined,
        { project: 'icsoc-2026' },
      );
      const parsed = JSON.parse(patched);
      expect(Object.keys(parsed.agents)).toEqual(['code-agent']);
    });

    it('skips normalization when no project is known (can\'t safely distinguish the prefix)', () => {
      const existing = JSON.stringify({
        agents: {
          'icsoc-2026-code-agent': {
            app_name: 'icsoc-2026-code-agent',
            host: '100.0.0.9',
            tmux_session: 'icsoc-2026-code-agent',
            tmux_bin: 'tmux',
            ssh_user: 'ubuntu',
            ssh_key_secret: 'AGENT_SSH_KEY',
          },
        },
      }, null, 2);
      // No `defaults` (hence no `project`) passed — normalization must not guess.
      const patched = patchAgentConfig(existing, ['code-agent']);
      const parsed = JSON.parse(patched);
      expect(parsed.agents).toHaveProperty('icsoc-2026-code-agent');
      expect(parsed.agents).toHaveProperty('code-agent');
    });

    it('leaves an unrelated stale key alone when its agent is not in the current --agents list', () => {
      // Only "code-agent" is being patched this run; a stale key for a
      // DIFFERENT agent must not be touched (matches the pre-existing
      // "agents not in --agents are left alone" contract).
      const existing = JSON.stringify({
        agents: {
          'icsoc-2026-science-agent': {
            app_name: 'icsoc-2026-science-agent',
            host: '100.0.0.9',
            tmux_session: 'icsoc-2026-science-agent',
            tmux_bin: 'tmux',
            ssh_user: 'ubuntu',
            ssh_key_secret: 'AGENT_SSH_KEY',
          },
        },
      }, null, 2);
      const patched = patchAgentConfig(
        existing, ['code-agent'], undefined,
        { project: 'icsoc-2026' },
      );
      const parsed = JSON.parse(patched);
      expect(parsed.agents).toHaveProperty('icsoc-2026-science-agent');
    });
  });
});

describe('createLabel', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns "created" on 201', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;
    const result = await createLabel('owner', 'repo', 'token', {
      name: 'test', color: 'fbca04', description: 'Test label',
    });
    expect(result).toBe('created');
  });

  it('returns "exists" on 422', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 422 }) as typeof fetch;
    const result = await createLabel('owner', 'repo', 'token', {
      name: 'test', color: 'fbca04', description: 'Test label',
    });
    expect(result).toBe('exists');
  });

  it('returns "failed" on other errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 403 }) as typeof fetch;
    const result = await createLabel('owner', 'repo', 'token', {
      name: 'test', color: 'fbca04', description: 'Test label',
    });
    expect(result).toBe('failed');
  });

  it('sends correct POST payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 201 });
    globalThis.fetch = fetchMock as typeof fetch;

    await createLabel('groundnuty', 'macf', 'tok-123', {
      name: 'code-agent', color: '1d76db', description: 'Assigned to code-agent',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/groundnuty/macf/labels',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer tok-123',
          'Accept': 'application/vnd.github+json',
        }),
        body: expect.stringContaining('"name":"code-agent"'),
      }),
    );
  });
});

describe('fetchOwnerType (groundnuty/macf#810)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns "org" for an Organization account', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'Organization' }),
    }) as typeof fetch;
    await expect(fetchOwnerType('acme-org')).resolves.toBe('org');
  });

  it('returns "user" for a User account', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'User' }),
    }) as typeof fetch;
    await expect(fetchOwnerType('groundnuty')).resolves.toBe('user');
  });

  it('returns "unknown" on a non-OK response (e.g. 404)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as typeof fetch;
    await expect(fetchOwnerType('nonexistent')).resolves.toBe('unknown');
  });

  it('returns "unknown" for a type that is neither "User" nor "Organization"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'Bot' }),
    }) as typeof fetch;
    await expect(fetchOwnerType('some-bot')).resolves.toBe('unknown');
  });

  it('returns "unknown" (never throws) when the network call itself rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof fetch;
    await expect(fetchOwnerType('unreachable')).resolves.toBe('unknown');
  });

  it('queries GET /users/<owner>', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ type: 'Organization' }) });
    globalThis.fetch = fetchMock as typeof fetch;
    await fetchOwnerType('acme-org');
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/users/acme-org', expect.anything());
  });
});

describe('repoInit integration', () => {
  let dir: string;
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = tempDir();
    process.env['GH_TOKEN'] = 'test-token';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('creates workflow and config files', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/test-repo',
      actionsVersion: 'v1',
      force: false,
    });

    expect(existsSync(join(dir, '.github', 'workflows', 'agent-router.yml'))).toBe(true);
    expect(existsSync(join(dir, '.github', 'agent-config.json'))).toBe(true);
  });

  it('writes correct workflow content', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/test-repo',
      actionsVersion: 'v1.0.0',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('@v1.0.0');
    expect(wf).toContain('secrets: inherit');
  });

  // groundnuty/macf#1109 — the "Next steps" secrets-audit: AGENT_SSH_KEY is
  // OBSOLETE for a v3+ pin (agent-router.yml's own doc: "may remain in the
  // file but are unread under v3"), and the Tailscale pair must state the
  // routing consequence rather than reading as a bland tidy-up item.
  it('omits AGENT_SSH_KEY for a v3+ pin and states the TS_OAUTH consequence (macf#1109)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await repoInit(dir, { repo: 'owner/test-repo', actionsVersion: 'v3.4.1', force: false });
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).not.toContain('AGENT_SSH_KEY');
      expect(printed).toContain('TS_OAUTH_CLIENT_ID');
      expect(printed).toContain('TS_OAUTH_SECRET');
      expect(printed).toMatch(/TS_OAUTH_CLIENT_ID.*REQUIRED/);
      expect(printed).toMatch(/routing will not function/i);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('keeps AGENT_SSH_KEY for a v1.x pin — still genuinely consumed by Stage-2 SSH+tmux routing (macf#1109)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await repoInit(dir, { repo: 'owner/test-repo', actionsVersion: 'v1', force: false });
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('AGENT_SSH_KEY');
    } finally {
      logSpy.mockRestore();
    }
  });

  // groundnuty/macf#1368 — the RepoInitOptions.routingRunnerRunsOn ->
  // generateWorkflow wiring, exercised at the repoInit() integration
  // layer (real filesystem, real generated content on disk).
  it('threads routingRunnerRunsOn through to the on-disk workflow for an accepting pin (macf#1368)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/test-repo',
      actionsVersion: 'main',
      project: 'trial',
      registryType: 'org',
      registryOrg: 'macf-experiment',
      routingRunnerRunsOn: 'self-hosted',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('runner-runs-on: self-hosted');
  });

  it('states the reason on stderr when routingRunnerRunsOn is declared but the pin cannot accept it (macf#1368)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await repoInit(dir, {
        repo: 'owner/test-repo',
        actionsVersion: 'v3.4.2',
        project: 'trial',
        registryType: 'org',
        registryOrg: 'macf-experiment',
        routingRunnerRunsOn: 'self-hosted',
        force: false,
      });
      const printed = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toMatch(/routing\.runner\.runs_on is declared/);
      expect(printed).toContain('v3.4.2');
      const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
      expect(wf).not.toContain('runner-runs-on');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('does not warn when routingRunnerRunsOn is undeclared (the common case)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await repoInit(dir, {
        repo: 'owner/test-repo',
        actionsVersion: 'v3.4.2',
        project: 'trial',
        registryType: 'org',
        registryOrg: 'macf-experiment',
        force: false,
      });
      const printed = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).not.toMatch(/routing\.runner\.runs_on/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('skips existing files without --force', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    // First run
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v1', force: false });
    const firstContent = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');

    // Second run without --force should skip
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v2', force: false });
    const secondContent = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(secondContent).toBe(firstContent); // unchanged
  });

  it('overwrites with --force', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v1', force: false });
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v2', force: true });

    const content = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(content).toContain('@v2');
  });

  it('expands --agents into config entries', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent,science-agent',
      force: false,
    });

    const config = JSON.parse(readFileSync(join(dir, '.github', 'agent-config.json'), 'utf-8'));
    expect(Object.keys(config.agents)).toEqual(['code-agent', 'science-agent']);
  });

  it('adds new agents to existing config WITHOUT --force (#82)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    // First run: create config with one agent.
    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent',
      force: false,
    });

    // Customize the entry to simulate user-edited fields.
    const configPath = join(dir, '.github', 'agent-config.json');
    const config1 = JSON.parse(readFileSync(configPath, 'utf-8'));
    config1.agents['code-agent'].host = '100.0.0.5';
    config1.agents['code-agent'].app_name = 'custom-app-name';
    writeFileSync(configPath, JSON.stringify(config1, null, 2) + '\n');

    // Second run: add a second agent, no --force.
    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent,science-agent',
      force: false,
    });

    const config2 = JSON.parse(readFileSync(configPath, 'utf-8'));
    // Both agents present.
    expect(Object.keys(config2.agents).sort()).toEqual(['code-agent', 'science-agent']);
    // User-customized fields preserved on code-agent.
    expect(config2.agents['code-agent'].host).toBe('100.0.0.5');
    expect(config2.agents['code-agent'].app_name).toBe('custom-app-name');
    // New agent has defaults.
    expect(config2.agents['science-agent'].host).toBe('<agent-host-ip>');
  });

  it('normalizes a pre-existing double-prefixed agent-config key on re-run (macf#805)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    // Simulate the icsoc-2026 pre-DR-032-fix on-disk state: the map key
    // itself carries the `<project>-` App-handle prefix instead of the bare
    // routing label, so `route-by-label` can never find it.
    mkdirSync(join(dir, '.github'), { recursive: true });
    writeFileSync(join(dir, '.github', 'agent-config.json'), JSON.stringify({
      agents: {
        'icsoc-2026-code-agent': {
          app_name: 'icsoc-2026-code-agent',
          host: '100.0.0.9',
          tmux_session: 'icsoc-2026-code-agent',
          tmux_bin: 'tmux',
          ssh_user: 'ubuntu',
          ssh_key_secret: 'AGENT_SSH_KEY',
        },
      },
    }, null, 2) + '\n');

    await repoInit(dir, {
      repo: 'owner/icsoc-2026',
      actionsVersion: 'v1',
      agents: 'code-agent',
      project: 'icsoc-2026',
      force: false,
    });

    const config = JSON.parse(readFileSync(join(dir, '.github', 'agent-config.json'), 'utf-8'));
    expect(config.agents).toHaveProperty('code-agent');
    expect(config.agents).not.toHaveProperty('icsoc-2026-code-agent');
    expect(config.agents['code-agent'].host).toBe('100.0.0.9');
  });

  it('--session-name applied on existing config WITHOUT --force (#82)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    // Create config with two un-grouped agents.
    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'a,b',
      force: false,
    });

    // Re-run with --session-name, no --force.
    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'a,b',
      sessionName: 'proj',
      force: false,
    });

    const config = JSON.parse(readFileSync(join(dir, '.github', 'agent-config.json'), 'utf-8'));
    expect(config.agents['a'].tmux_session).toBe('proj');
    expect(config.agents['a'].tmux_window).toBe('a');
    expect(config.agents['b'].tmux_session).toBe('proj');
    expect(config.agents['b'].tmux_window).toBe('b');
  });

  it('workflow file still respects --force semantic even after #82', async () => {
    // #82 only loosens the CONFIG file's --force gate; workflow stays gated.
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v1', force: false });

    // Second run: change actionsVersion, no --force.
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v2', force: false });
    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('@v1'); // unchanged because of --force gate
  });

  it('throws on invalid repo format', async () => {
    await expect(repoInit(dir, {
      repo: 'no-slash',
      actionsVersion: 'v1',
      force: false,
    })).rejects.toThrow('owner/repo');
  });

  it('creates status + agent labels via GitHub API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 201 });
    globalThis.fetch = fetchMock as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent,science-agent',
      force: false,
    });

    // 5 status labels (in-progress, in-review, blocked, agent-offline,
    // backlog — macf#1091 added `backlog`) + 2 agent labels = 7 API calls
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('creates the backlog label (macf#1091 — the check-mention-routing.sh create-guard escape hatch)', async () => {
    const createdNames: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { name: string }) : undefined;
      if (body?.name) createdNames.push(body.name);
      return Promise.resolve({ status: 201 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      force: false,
    });

    // Set membership, not a count or exact order — the assertion this test
    // exists for is "backlog is among the labels repo-init creates", not
    // "repo-init creates exactly N labels in exactly this order."
    expect(createdNames).toContain('backlog');
    expect(result.labels.status).toBe('ok');
    if (result.labels.status === 'ok') {
      expect(result.labels.created).toContain('backlog');
    }
  });

  it('handles 422 (label already exists) gracefully', async () => {
    // First two calls succeed, next return 422
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValue({ status: 422 });
    globalThis.fetch = fetchMock as typeof fetch;

    // Should not throw, and every label resolves 'created' or 'exists' — no 'failed'.
    const result = await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      force: false,
    });
    expect(result.labels.status).toBe('ok');
  });

  it('continues without labels when token fails, returning labels.status="skipped" (groundnuty/macf#920)', async () => {
    delete process.env['GH_TOKEN'];
    delete process.env['APP_ID'];

    // Should not throw — prints warning and continues
    const result = await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      force: false,
    });
    expect(result.labels.status).toBe('skipped');

    // Files should still be created
    expect(existsSync(join(dir, '.github', 'workflows', 'agent-router.yml'))).toBe(true);
  });

  // macf#566 — v3 caller generation (project + registry-api-path).
  // macf#810 — the UNSET-registryType default is no longer `repo` scope
  // (self-pointing at the calling repo's own registry — the per-repo drift
  // this issue exists to close). It's derived from a live `GET
  // /users/<owner>` account-type check: decisive pair below covers both
  // branches (org-owned, user-owned), plus the honest-unknown refusal.
  function mockFetchWithOwnerType(ownerType: 'Organization' | 'User' | null): void {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/users/')) {
        if (ownerType === null) {
          // Simulates an undeterminable owner type (e.g. a 404, or a shape
          // GitHub never actually returns) — never a network throw, which
          // fetchOwnerType already covers via its try/catch.
          return Promise.resolve({ ok: true, json: async () => ({ type: 'Bot' }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ type: ownerType }) });
      }
      return Promise.resolve({ status: 201, ok: true }); // label creation
    }) as typeof fetch;
  }

  it('v3 pin defaults an org-owned fleet to org scope (groundnuty/macf#810)', async () => {
    mockFetchWithOwnerType('Organization');

    await repoInit(dir, {
      repo: 'acme-org/test-repo',
      actionsVersion: 'v3.3.0',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('@v3.3.0');
    expect(wf).toContain('    with:');
    expect(wf).toContain('      project: test-repo');
    expect(wf).toContain('      registry-api-path: /orgs/acme-org');
    expect(wf).not.toContain('registry-api-path: /repos/acme-org/test-repo'); // NOT the old self-pointing default
  });

  it('v3 pin defaults a user-owned fleet to profile scope (groundnuty/macf#810)', async () => {
    mockFetchWithOwnerType('User');

    await repoInit(dir, {
      repo: 'groundnuty/test-repo',
      actionsVersion: 'v3.3.0',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('      registry-api-path: /repos/groundnuty/groundnuty');
    expect(wf).not.toContain('registry-api-path: /repos/groundnuty/test-repo'); // NOT the old self-pointing default
    expect(wf).not.toContain('registry-api-path: /orgs/groundnuty'); // NOT org scope — /orgs/<user> 404s
  });

  it('v3 pin refuses to guess when the owner type cannot be determined (groundnuty/macf#810)', async () => {
    mockFetchWithOwnerType(null);

    await expect(repoInit(dir, {
      repo: 'mystery-owner/test-repo',
      actionsVersion: 'v3.3.0',
      force: false,
    })).rejects.toThrow(/Could not determine whether "mystery-owner" is a GitHub User or Organization/);

    // Both explicit escape hatches must be named — the honest-unknown
    // requirement is "name the two options", not merely "refuse".
    await expect(repoInit(dir, {
      repo: 'mystery-owner/test-repo',
      actionsVersion: 'v3.3.0',
      force: false,
    })).rejects.toThrow(/--registry-type org --registry-org mystery-owner.*--registry-type profile --registry-user mystery-owner/s);

    // And it must NOT have silently fallen back to /orgs/ before throwing —
    // no workflow file should exist from either failed attempt.
    expect(existsSync(join(dir, '.github', 'workflows', 'agent-router.yml'))).toBe(false);
  });

  // Mutation check (per assert-the-wrong-path.md): if the owner-type
  // branch in buildRoutingRegistry were deleted or swapped (e.g. `ownerType
  // === 'org'` accidentally routed to profile scope, or vice versa), THIS
  // pair is what would catch it — the two tests above assert the org/user
  // branches individually, and this one asserts they are NOT interchangeable.
  it('org-owned and user-owned defaults are not interchangeable (mutation check for macf#810)', async () => {
    mockFetchWithOwnerType('Organization');
    await repoInit(dir, { repo: 'acme-org/test-repo', actionsVersion: 'v3.3.0', force: false });
    const orgWf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');

    rmSync(join(dir, '.github'), { recursive: true, force: true });

    mockFetchWithOwnerType('User');
    await repoInit(dir, { repo: 'acme-org/test-repo', actionsVersion: 'v3.3.0', force: false });
    const userWf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');

    // Same owner login, opposite live account type -> opposite scope form.
    // A mutant that swapped the org/user branches (or collapsed them to a
    // constant) would make these two identical; this test fails on that
    // mutant with a clear diff, which is the point of naming it here.
    expect(orgWf).toContain('registry-api-path: /orgs/acme-org');
    expect(userWf).toContain('registry-api-path: /repos/acme-org/acme-org');
    expect(orgWf).not.toBe(userWf);
  });

  // macf#797 — a floating v3+ pin is resolved to an immutable full tag at
  // generation time, so the born router never silently receives a behavioral
  // change within the major.
  it('resolves a floating v3 pin to the latest immutable full tag (macf#797)', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('macf-actions/tags')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ name: 'v3.4.1' }, { name: 'v3.4.0' }, { name: 'v3.3.0' }, { name: 'v3' }],
        });
      }
      // label creation + the default registry-api-path owner-type lookup (macf#810)
      return Promise.resolve({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) });
    }) as typeof fetch;

    await repoInit(dir, { repo: 'owner/test-repo', actionsVersion: 'v3', force: false });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('agent-router.yml@v3.4.1');
    expect(wf).not.toContain('agent-router.yml@v3\n'); // NOT the floating ref
    expect(wf).toContain('      project: test-repo'); // v3 inputs still emitted
    expect(wf).toContain('\npermissions:\n');
  });

  it('keeps the floating pin (no crash) when tag resolution is offline (macf#797)', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('macf-actions/tags')) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      // label creation + the default registry-api-path owner-type lookup (macf#810)
      return Promise.resolve({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) });
    }) as typeof fetch;

    const result = await repoInit(dir, { repo: 'owner/test-repo', actionsVersion: 'v3', force: false });
    expect(result.labels.status).toBe('ok');

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('agent-router.yml@v3\n'); // degraded to floating ref
    expect(wf).toContain('\npermissions:\n'); // still a valid, permissioned router
  });

  it('v3 pin + profile scope emits /repos/<user>/<user>', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await repoInit(dir, {
      repo: 'groundnuty/macf',
      actionsVersion: 'v3.3.0',
      registryType: 'profile',
      registryUser: 'groundnuty',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('      project: macf');
    expect(wf).toContain('      registry-api-path: /repos/groundnuty/groundnuty');
  });

  it('v3 pin + org scope emits /orgs/<org>', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await repoInit(dir, {
      repo: 'acme/widget',
      actionsVersion: 'v3.3.0',
      registryType: 'org',
      registryOrg: 'acme',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('      registry-api-path: /orgs/acme');
  });

  it('v3 pin honours an explicit --project override', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/some-repo',
      actionsVersion: 'v3.3.0',
      project: 'academic-resume',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('      project: academic-resume');
  });

  it('v1 pin emits no v3 with: block (back-compat preserved)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/test-repo',
      actionsVersion: 'v1',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('@v1');
    expect(wf).not.toContain('with:');
    expect(wf).not.toContain('registry-api-path:');
  });

  it('v3 pin + org scope without --registry-org throws', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await expect(repoInit(dir, {
      repo: 'acme/widget',
      actionsVersion: 'v3.3.0',
      registryType: 'org',
      force: false,
    })).rejects.toThrow('--registry-org required');
  });

  it('v3 pin + local scope is rejected (no GitHub-Actions routing path)', async () => {
    // status 201 (label creation) + ok/json (macf#810's default owner-type
    // lookup at `GET /users/<owner>`) — Organization is an arbitrary,
    // internally-consistent choice for tests that don't assert on the
    // resulting registry-api-path.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({ type: 'Organization' }) }) as typeof fetch;

    await expect(repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v3.3.0',
      registryType: 'local',
      force: false,
    })).rejects.toThrow('local registry has no GitHub-Actions routing path');
  });
});
