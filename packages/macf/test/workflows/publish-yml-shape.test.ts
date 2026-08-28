/**
 * Static shape test for `.github/workflows/publish.yml` — groundnuty/macf#1297.
 *
 * This is a workflow file, not a TypeScript module: the vitest suite cannot
 * EXERCISE it (no runner, no real `npm publish`, no real registry). What it
 * CAN do — and what this file does — is parse the committed YAML and assert
 * on its STRUCTURE: that acceptance (did npm accept the publish?) and
 * availability (can the registry serve it yet?) are separate steps, that
 * the availability bound is a named attempt-count (never a harness/CI
 * timeout), and that a registry lag cannot set job failure while a genuine
 * defect still can. The workflow's first REAL exercise is the next live
 * release cut — these assertions are a regression pin on the YAML shape,
 * not a substitute for that.
 *
 * Precedent: `test/cli/repo-init.test.ts` already parses a committed
 * workflow (`agent-router.yml`) with the `yaml` package and asserts on a
 * step's `run` script content — this file follows the same technique
 * against `publish.yml`, which had no prior shape-test coverage at all.
 */
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

interface WorkflowStep {
  readonly name?: string;
  readonly id?: string;
  readonly run?: string;
  readonly 'continue-on-error'?: boolean;
  readonly 'timeout-minutes'?: number;
}

interface Workflow {
  readonly jobs: {
    readonly publish: {
      readonly steps: readonly WorkflowStep[];
    };
  };
}

const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'publish.yml',
);

function loadSteps(): readonly WorkflowStep[] {
  const raw = readFileSync(workflowPath, 'utf-8');
  const parsed = parseYaml(raw) as Workflow;
  return parsed.jobs.publish.steps;
}

function stepByName(steps: readonly WorkflowStep[], pattern: RegExp): WorkflowStep {
  const found = steps.find(s => pattern.test(s.name ?? ''));
  if (!found) {
    throw new Error(`no publish.yml step found matching ${pattern}`);
  }
  return found;
}

describe('publish.yml — acceptance vs availability (macf#1297)', () => {
  const steps = loadSteps();

  it('the three publish steps carry ids, so later steps read outcome instead of re-fetching the registry', () => {
    expect(stepByName(steps, /^Publish @groundnuty\/macf-core/).id).toBe('publish_core');
    expect(stepByName(steps, /^Publish @groundnuty\/macf \(CLI\)/).id).toBe('publish_cli');
    expect(stepByName(steps, /^Publish @groundnuty\/macf-channel-server/).id).toBe('publish_channel_server');
  });

  it('a real npm rejection still fails the job — no continue-on-error was added to the publish steps themselves', () => {
    for (const id of ['publish_core', 'publish_cli', 'publish_channel_server']) {
      const step = steps.find(s => s.id === id);
      expect(step, `expected a step with id=${id}`).toBeDefined();
      expect(step?.['continue-on-error']).toBeUndefined();
    }
  });

  it('acceptance is reported by a SEPARATE step from availability — not one conflated check', () => {
    const acceptance = stepByName(steps, /acceptance summary/i);
    const availability = stepByName(steps, /availability/i);
    expect(acceptance).not.toBe(availability);
  });

  it('acceptance comes from each publish step\'s own outcome, never a registry re-fetch', () => {
    const acceptance = stepByName(steps, /acceptance summary/i);
    const run = acceptance.run ?? '';
    // The defect this issue fixes IS a fetch inside the acceptance-adjacent
    // check — assert the acceptance step contains no fetch call at all.
    expect(run).not.toMatch(/curl/);
    expect(run).toMatch(/OUTCOME_CORE/);
    expect(run).toMatch(/OUTCOME_CLI/);
    expect(run).toMatch(/OUTCOME_CHANNEL_SERVER/);
  });

  it('the availability bound is a NAMED attempt-count variable, not a bare magic-number loop or a step timeout', () => {
    const availability = stepByName(steps, /availability/i);
    // Named, not `for try in 1 2 3 4 5` (the old shape) or a `sleep N`
    // buried with no accompanying counter.
    expect(availability.run ?? '').toMatch(/MAX_TRIES=\d+/);
    // The bound must never be asserted via a harness/CI timeout instead —
    // #1295 (release.sh's sibling fix) named this exact failure mode: a
    // timeout-derived bound weakens silently if ever raised for an
    // unrelated reason, and exit 124 is indistinguishable from infra flake.
    expect(availability['timeout-minutes']).toBeUndefined();
  });

  it('a registry lag on an accepted publish does NOT set job failure', () => {
    const availability = stepByName(steps, /availability/i);
    const run = availability.run ?? '';
    const markerIdx = run.indexOf('AVAILABILITY UNCONFIRMED');
    expect(markerIdx, 'expected an "AVAILABILITY UNCONFIRMED" (lag) branch').toBeGreaterThan(-1);
    // Back up to the start of that line — the marker text sits right after
    // an `echo "::warning::..."` prefix on the SAME line, so slicing from
    // the marker itself would miss the ::warning:: token before it.
    const lineStart = run.lastIndexOf('\n', markerIdx) + 1;
    // The lag branch must end at `continue` (proceed to the next package /
    // finish the loop iteration) before any `exit` could run.
    const continueIdx = run.indexOf('continue', markerIdx);
    expect(continueIdx, 'expected the lag branch to `continue`, not fall through to exit').toBeGreaterThan(markerIdx);
    const lagBranch = run.slice(lineStart, continueIdx);
    expect(lagBranch).toMatch(/::warning::/);
    expect(lagBranch).not.toMatch(/::error::/);
    expect(lagBranch).not.toMatch(/\bexit\s+1\b/);
  });

  it('a genuine defect (provenance missing on an AVAILABLE package) still fails the job', () => {
    const availability = stepByName(steps, /availability/i);
    const run = availability.run ?? '';
    expect(run).toMatch(/PROVENANCE MISSING/);
    expect(run).toMatch(/ANY_PROVENANCE_MISSING=1/);
    // The provenance-missing exit must be reachable — not merely mentioned
    // in a comment. Assert it appears as an actual gated exit at the end.
    expect(run).toMatch(/if \[ "\$ANY_PROVENANCE_MISSING" = "1" \]; then\s*\n\s*exit 1/);
  });

  it('a partial publish is nameable: ACCEPTED / REJECTED / NOT ATTEMPTED per package (silent-fallback-hazards.md Instance 9)', () => {
    const acceptance = stepByName(steps, /acceptance summary/i);
    const run = acceptance.run ?? '';
    expect(run).toMatch(/ACCEPTED\s/);
    expect(run).toMatch(/REJECTED\s/);
    expect(run).toMatch(/NOT ATTEMPTED\s/);
  });
});
