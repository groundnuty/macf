/**
 * Tests for `macf bootstrap apply` increment 1 — dry-run-only (DR-043 §D2,
 * Slice 2b of groundnuty/macf#838).
 *
 * The load-bearing case: a non-`--dry-run` invocation must FAIL LOUD. An
 * `apply` that exits 0 having changed nothing is the silent-fallback shape this
 * codebase exists to avoid, and it would be indistinguishable from a successful
 * provisioning run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBootstrapApply,
  plannedAppCreations,
  formatPlannedAppCreations,
  DRY_RUN_REDIRECT_PLACEHOLDER,
} from '../../src/cli/commands/bootstrap-apply.js';
import { parseFleetManifest } from '../../src/cli/bootstrap/fleet-manifest.js';
import { computePlan } from '../../src/cli/bootstrap/plan.js';
import type { ObservedState } from '../../src/cli/bootstrap/plan.js';

const FLEET_YAML = `apiVersion: macf/v0
kind: Fleet
metadata:
  name: demo-fleet
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
network:
  advertise_host: example.ts.net
transport:
  vault_repo: groundnuty/demo-science
  age_recipient: null
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/demo-code
    deploy_path: /home/ubuntu/repos/demo-code
  - role: science-agent
    profile: research
    repo: groundnuty/demo-science
    deploy_path: /home/ubuntu/repos/demo-science
`;

/** Observed state where NOTHING exists — every agent is an App create-candidate. */
const EMPTY_OBSERVED: ObservedState = {
  lock: null,
  agents: {},
  caRegistry: 'absent',
  caRepos: {},
};

function observedWithApp(role: string): ObservedState {
  return {
    lock: null,
    agents: {
      [role]: { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
    },
    caRegistry: 'present',
    caRepos: {},
  };
}

describe('macf bootstrap apply — increment 1 (dry-run only)', () => {
  const dirs: string[] = [];
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errs.push(a.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeManifest(body = FLEET_YAML): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-apply-test-'));
    dirs.push(dir);
    const p = join(dir, 'fleet.yaml');
    writeFileSync(p, body);
    return p;
  }

  it('FAILS LOUD without --dry-run (never exits 0 having changed nothing)', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file }, { observe: () => Promise.resolve(EMPTY_OBSERVED) });
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/not implemented yet/i);
    expect(errs.join('\n')).toMatch(/--dry-run/);
  });

  it('under --json, a non-dry-run failure still emits a NON-EMPTY envelope (macf#830 lesson)', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) });
    expect(code).toBe(1);
    const parsed = JSON.parse(logs.join('\n')) as { schema_version: number; error: { code: string } };
    expect(parsed.schema_version).toBeGreaterThanOrEqual(1);
    expect(parsed.error.code).toBe('apply_not_implemented');
  });

  it('--dry-run renders the plan + would-be App manifests + consent gate 2 URL, and mutates nothing', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, dryRun: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/demo-fleet-code-agent/);
    expect(out).toMatch(/demo-fleet-science-agent/);
    expect(out).toMatch(/actions_variables:write/);
    expect(out).toMatch(/consent gate 2/);
    expect(out).toMatch(/https:\/\/github\.com\/apps\/demo-fleet-code-agent\/installations\/new/);
    expect(out).toMatch(/https:\/\/github\.com\/apps\/demo-fleet-science-agent\/installations\/new/);
    expect(out).toMatch(/DRY RUN — nothing was created/);
  });

  it('--dry-run --json carries dry_run + planned_app_creations (incl. installUrl)', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, dryRun: true, json: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      dry_run: boolean;
      planned_app_creations: { role: string; manifest: { name: string }; installUrl: string }[];
    };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.planned_app_creations.map((c) => c.manifest.name)).toEqual([
      'demo-fleet-code-agent',
      'demo-fleet-science-agent',
    ]);
    expect(parsed.planned_app_creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
    ]);
  });

  it('reports a missing manifest file without throwing', async () => {
    const code = await runBootstrapApply(
      { file: '/nonexistent/fleet.yaml', dryRun: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/not found/i);
  });

  it('reports a schema-invalid manifest without throwing', async () => {
    const file = writeManifest('apiVersion: macf/v0\nkind: Fleet\n');
    const code = await runBootstrapApply(
      { file, dryRun: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/failed validation/i);
  });
});

describe('plannedAppCreations (pure)', () => {
  const manifest = parseFleetManifest(FLEET_YAML);

  it('includes an agent whose app item is create', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.role)).toEqual(['code-agent', 'science-agent']);
    expect(creations[0]?.manifest.redirect_url).toBe(DRY_RUN_REDIRECT_PLACEHOLDER);
  });

  it('pairs each creation with its consent-gate-2 install URL, derived from the SAME handle as the manifest name', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
    ]);
    for (const c of creations) {
      expect(c.installUrl).toBe(`https://github.com/apps/${c.manifest.name}/installations/new`);
    }
  });

  it('EXCLUDES an agent whose App is already present (no re-create)', () => {
    const plan = computePlan(manifest, observedWithApp('code-agent'));
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.role)).toEqual(['science-agent']);
  });

  it('formats an empty creation set without claiming work', () => {
    expect(formatPlannedAppCreations([])).toMatch(/No GitHub Apps would be created/);
  });
});
