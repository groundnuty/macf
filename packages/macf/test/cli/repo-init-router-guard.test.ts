/**
 * Tests for the router-workflow result-invariant guard (groundnuty/macf#886).
 *
 * Per `assert-the-wrong-path.md`: a check that only ever reports "clean" is
 * indistinguishable from a broken check. Every decisive test below asserts
 * the SPECIFIC missing-element name in the thrown message, not merely that
 * something threw — matching the reported incident, which was two elements
 * (the permissions block and the check_suite trigger) silently absent from
 * an otherwise plausible-looking file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  ROUTER_WORKFLOW_REQUIREMENTS,
  findMissingRouterWorkflowRequirements,
  assertRouterWorkflowWellFormed,
} from '../../src/cli/commands/repo-init-router-guard.js';
import { generateWorkflow } from '../../src/cli/commands/repo-init.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-router-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The baseline, version-independent content generateWorkflow() always
// emits (no v3Inputs — the v3-only `with:` block is out of this guard's
// scope; see the guard module's doc for why).
const GOOD_V1 = generateWorkflow('v1');

describe('assertRouterWorkflowWellFormed / findMissingRouterWorkflowRequirements (macf#886)', () => {
  // --- Good path: the real generator's output is never flagged -----------
  it('does NOT throw on the real generateWorkflow("v1") output', () => {
    expect(() => assertRouterWorkflowWellFormed(GOOD_V1)).not.toThrow();
    expect(findMissingRouterWorkflowRequirements(GOOD_V1)).toEqual([]);
  });

  it('does NOT throw on a v3+ pin with the with: block present (superset content)', () => {
    const v3 = generateWorkflow('v3.4.2', { project: 'macf', registryApiPath: '/repos/groundnuty/groundnuty' });
    expect(() => assertRouterWorkflowWellFormed(v3)).not.toThrow();
    expect(findMissingRouterWorkflowRequirements(v3)).toEqual([]);
  });

  it('does NOT throw on a v1 pin even though it lacks the v3-only with: block (out of scope, not a defect)', () => {
    // v1 output has no `with:` at all — proves the guard doesn't wrongly
    // require the v3-only block on a legitimately-scoped v1/v2 emission.
    expect(GOOD_V1).not.toContain('with:');
    expect(() => assertRouterWorkflowWellFormed(GOOD_V1)).not.toThrow();
  });

  it('does NOT throw on a bundle-capable pin that emits MACF_ROUTING_BUNDLE instead of secrets: inherit (macf#1112)', () => {
    const bundleForm = generateWorkflow('v3.5.0', { project: 'macf', registryApiPath: '/repos/groundnuty/groundnuty' });
    expect(bundleForm).not.toContain('secrets: inherit');
    expect(bundleForm).toContain('MACF_ROUTING_BUNDLE');
    expect(() => assertRouterWorkflowWellFormed(bundleForm)).not.toThrow();
    expect(findMissingRouterWorkflowRequirements(bundleForm)).toEqual([]);
  });

  // --- Decisive: each required element is individually detected -----------
  // Table-driven — one corruption per requirement, isolated so exactly one
  // requirement fails per case (verified by the `missing.length === 1` +
  // `missing[0].name` assertions, not merely "it threw").
  const CORRUPTIONS: ReadonlyArray<{ readonly name: string; readonly corrupt: (yaml: string) => string }> = [
    { name: 'issues trigger (labeled, closed)', corrupt: (y) => y.replace('  issues:\n    types: [labeled, closed]\n', '') },
    { name: 'issue_comment trigger (created)', corrupt: (y) => y.replace('  issue_comment:\n    types: [created]\n', '') },
    { name: 'pull_request trigger (opened, ready_for_review, synchronize)', corrupt: (y) => y.replace('  pull_request:\n    types: [opened, ready_for_review, synchronize]\n', '') },
    { name: 'pull_request_review trigger (submitted)', corrupt: (y) => y.replace('  pull_request_review:\n    types: [submitted]\n', '') },
    // The reported incident's symptom #2 (macf#886).
    { name: 'check_suite trigger (completed)', corrupt: (y) => y.replace('  check_suite:\n    types: [completed]\n', '') },
    // The reported incident's symptom #1 (macf#886) — the header only; the
    // 4 permission keys below stay textually present so this case isolates
    // to exactly this one requirement (see the 4 key-level cases below for
    // their own isolated coverage).
    { name: 'permissions block present', corrupt: (y) => y.replace('permissions:\n', '') },
    { name: 'permissions.contents: read', corrupt: (y) => y.replace('  contents: read\n', '') },
    { name: 'permissions.issues: write', corrupt: (y) => y.replace('  issues: write\n', '') },
    { name: 'permissions.pull-requests: read', corrupt: (y) => y.replace('  pull-requests: read\n', '') },
    { name: 'permissions.checks: read', corrupt: (y) => y.replace('  checks: read\n', '') },
    { name: 'reusable workflow reference (uses:)', corrupt: (y) => y.replace(/uses: groundnuty\/macf-actions[^\n]*\n/, '\n') },
    { name: 'secrets propagation (secrets: inherit OR MACF_ROUTING_BUNDLE)', corrupt: (y) => y.replace('    secrets: inherit\n', '') },
  ];

  it('the corruption table covers every declared requirement exactly once', () => {
    // Guards the table itself against silently drifting out of sync with
    // the requirement list (a new requirement added without a matching
    // corruption case would otherwise never get decisive coverage).
    expect(CORRUPTIONS.map((c) => c.name).sort()).toEqual(
      ROUTER_WORKFLOW_REQUIREMENTS.map((r) => r.name).sort(),
    );
  });

  for (const { name, corrupt } of CORRUPTIONS) {
    it(`FIRES with the specific missing-element name when "${name}" is dropped`, () => {
      const bad = corrupt(GOOD_V1);
      expect(bad).not.toBe(GOOD_V1); // sanity: the corruption actually changed something

      const missing = findMissingRouterWorkflowRequirements(bad);
      expect(missing.map((m) => m.name)).toEqual([name]);

      // The decisive assertion (assert-the-wrong-path.md): the thrown
      // message names THIS element, not just "something is wrong".
      expect(() => assertRouterWorkflowWellFormed(bad)).toThrow(name);
    });
  }

  it('names BOTH missing elements when the reported incident shape recurs (permissions block AND check_suite both absent)', () => {
    const bothMissing = GOOD_V1
      .replace('permissions:\n', '')
      .replace('  contents: read\n', '')
      .replace('  issues: write\n', '')
      .replace('  pull-requests: read\n', '')
      .replace('  checks: read\n', '')
      .replace('  check_suite:\n    types: [completed]\n', '');

    let thrown: Error | undefined;
    try {
      assertRouterWorkflowWellFormed(bothMissing);
    } catch (err) {
      thrown = err instanceof Error ? err : undefined;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain('permissions block present');
    expect(thrown?.message).toContain('permissions.contents: read');
    expect(thrown?.message).toContain('permissions.issues: write');
    expect(thrown?.message).toContain('permissions.pull-requests: read');
    expect(thrown?.message).toContain('permissions.checks: read');
    expect(thrown?.message).toContain('check_suite trigger (completed)');
  });

  it('the thrown message tells the reader what to do, not just what is wrong', () => {
    const bad = GOOD_V1.replace('  checks: read\n', '');
    expect(() => assertRouterWorkflowWellFormed(bad)).toThrow(/add `checks: read`/);
  });
});

// --- Wiring proof: repoInit() actually calls the guard on the write path ---
// A guard function that exists but was never wired in is exactly the class
// of gap this issue is about — proving `repoInit()` invokes it (and that a
// thrown guard blocks the write) is the part a standalone unit test of the
// guard alone cannot show.
vi.mock('../../src/cli/commands/repo-init-router-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/commands/repo-init-router-guard.js')>();
  return {
    ...actual,
    assertRouterWorkflowWellFormed: vi.fn(actual.assertRouterWorkflowWellFormed),
  };
});

describe('repoInit wiring — the guard runs on the actual write path (macf#886)', () => {
  let dir: string;
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = tempDir();
    process.env['GH_TOKEN'] = 'test-token';
    // The mock is module-scoped (shared with the decisive tests above,
    // which call the guard directly) — reset its call history so each
    // wiring test in THIS block starts from a clean count.
    const { assertRouterWorkflowWellFormed: guard } = await import('../../src/cli/commands/repo-init-router-guard.js');
    vi.mocked(guard).mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('calls the guard exactly once, with the generated workflow content, when writing a fresh file', async () => {
    const { repoInit } = await import('../../src/cli/commands/repo-init.js');
    const { assertRouterWorkflowWellFormed: guard } = await import('../../src/cli/commands/repo-init-router-guard.js');
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v1', force: false });

    expect(guard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(guard).mock.calls[0]?.[0]).toContain('check_suite:');
  });

  it('a thrown guard propagates out of repoInit() and the file is never written', async () => {
    const { repoInit } = await import('../../src/cli/commands/repo-init.js');
    const { assertRouterWorkflowWellFormed: guard } = await import('../../src/cli/commands/repo-init-router-guard.js');
    vi.mocked(guard).mockImplementationOnce(() => {
      throw new Error('synthetic guard failure for macf#886 wiring test');
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await expect(
      repoInit(dir, { repo: 'owner/r', actionsVersion: 'v1', force: false }),
    ).rejects.toThrow('synthetic guard failure for macf#886 wiring test');

    expect(existsSync(join(dir, '.github', 'workflows', 'agent-router.yml'))).toBe(false);
  });

  it('does NOT call the guard on the skip-existing-file branch (no --force, file already present)', async () => {
    const { repoInit } = await import('../../src/cli/commands/repo-init.js');
    const { assertRouterWorkflowWellFormed: guard } = await import('../../src/cli/commands/repo-init-router-guard.js');
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v1', force: false });
    vi.mocked(guard).mockClear();

    // Second run, no --force: writeFileSafe takes the skip branch.
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v2', force: false });

    expect(guard).not.toHaveBeenCalled();
  });
});
