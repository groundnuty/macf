/**
 * Tests for `macf bootstrap plan` (DR-043 Slice 1a, groundnuty/macf#838).
 * Offline + deterministic: the observer is injected (no `gh` / network), and
 * every failure path is exercised for the macf#830 "never empty stdout under
 * --json" lesson.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBootstrapPlan, type BootstrapPlanDeps } from '../../src/cli/commands/bootstrap.js';
import type { ObservedState } from '../../src/cli/bootstrap/plan.js';

const VALID_FLEET_YAML = `
apiVersion: macf/v0
kind: Fleet
metadata:
  name: icsoc-2026
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
network:
  advertise_host: example.ts.net
transport:
  age_recipients: []
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/icsoc-2026-experiment
    deploy_path: /home/ubuntu/repos/agh/icsoc-2026-experiment
collaborators:
  - project: ppam-2026
    registry: { type: profile, user: groundnuty }
    ca_bundle: bundles/ppam-2026-ca.pem
`;

function writeManifest(text: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bootstrap-plan-test-'));
  const file = join(dir, 'fleet.yaml');
  writeFileSync(file, text);
  return { dir, file };
}

const EMPTY_OBSERVED: ObservedState = { lock: null, agents: {}, caRegistry: 'unknown', caRepos: {} };

describe('runBootstrapPlan', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const dirs: string[] = [];

  afterEach(() => {
    logSpy?.mockRestore();
    errSpy?.mockRestore();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a missing manifest file: nonzero exit, plain-text mode prints to stderr only', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file: '/does/not/exist/fleet.yaml' });
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('a missing manifest file under --json: non-empty JSON {error} on stdout, nonzero exit (macf#830 lesson)', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file: '/does/not/exist/fleet.yaml', json: true });
    expect(code).toBe(1);
    const printed = logSpy.mock.calls.flat().join('');
    expect(printed.length).toBeGreaterThan(0);
    const json = JSON.parse(printed) as { schema_version: number; error: { code: string; message: string } };
    expect(json.schema_version).toBe(1);
    expect(json.error.code).toBe('manifest_not_found');
  });

  it('an invalid manifest (schema violation) under --json: non-empty JSON {error}, nonzero exit', async () => {
    const { dir, file } = writeManifest('apiVersion: macf/v1\nkind: Fleet\n');
    dirs.push(dir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file, json: true });
    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { error: { code: string } };
    expect(json.error.code).toBe('manifest_invalid');
  });

  it('an observer throw is caught + rendered as {error}, never propagates', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = {
      observe: async () => {
        throw new Error('gh: rate limited');
      },
    };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('unexpected_error');
    expect(json.error.message).toContain('rate limited');
  });

  it('a valid manifest + injected observer: exit 0, --json plan carries schema_version + fleet + items + skipped_sections', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => EMPTY_OBSERVED };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);

    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      schema_version: number;
      fleet: string;
      plan: ReadonlyArray<{ kind: string; verb: string }>;
      summary: { creates: number };
      skipped_sections: ReadonlyArray<{ section: string; reason: string }>;
      unimplemented_by_apply: ReadonlyArray<{ kind: string; target: string; verb: string; reason: string }>;
    };
    expect(json.schema_version).toBe(1);
    expect(json.fleet).toBe('icsoc-2026');
    expect(json.plan.length).toBeGreaterThan(0);
    expect(json.summary.creates).toBeGreaterThan(0);
    // collaborators is declared + non-empty in the fixture → must be SKIPPED, not silently dropped.
    expect(json.skipped_sections).toEqual([
      { section: 'collaborators', reason: 'reconcile not implemented in v1 — see #838 follow-ups' },
    ]);
    // macf#854 — the plan's json ALWAYS carries the apply-coverage gap for
    // automation, not just the human-text render. This fixture has no
    // agent/CA presence observed at all → CA items are unimplemented creates.
    expect(json.unimplemented_by_apply.length).toBeGreaterThan(0);
    expect(json.unimplemented_by_apply.some((i) => i.kind === 'ca')).toBe(true);
  });

  it('plain-text mode renders the human table + the skipped-section loud line', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => EMPTY_OBSERVED };
    const code = await runBootstrapPlan({ file }, deps);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('macf bootstrap plan — icsoc-2026');
    expect(out).toContain('CREATE');
    expect(out).toContain('collaborators: SKIPPED (reconcile not implemented in v1 — see #838 follow-ups)');
    // macf#854 — the plan text ALSO names the items apply has no code path
    // for yet (distinct wording from "SKIPPED" — see plan.ts's
    // formatUnimplementedLines doc).
    expect(out).toMatch(/NOT IMPLEMENTED BY APPLY/);
    expect(out).toContain('ca:registry:ICSOC_2026_CA_CERT');
  });

  it('plain-text mode omits the skipped-section block entirely when nothing was skipped', async () => {
    const { dir, file } = writeManifest(
      VALID_FLEET_YAML.replace(/collaborators:\n(.|\n)*$/, ''),
    );
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => EMPTY_OBSERVED };
    const code = await runBootstrapPlan({ file }, deps);
    expect(code).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('SKIPPED');
  });

  it('a fully-clean plan (nothing to do) still exits 0 — a plan full of creates is a SUCCESSFUL run', async () => {
    const { dir, file } = writeManifest(
      VALID_FLEET_YAML.replace(/collaborators:\n(.|\n)*$/, ''),
    );
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = {
      observe: async () => ({
        lock: null,
        agents: {
          'code-agent': {
            app: 'present',
            install: 'present',
            repo: 'present',
            fingerprints: { app_private_key: 'sha256:aaa' },
          },
        },
        caRegistry: 'present',
        caRepos: { 'groundnuty/icsoc-2026-experiment': 'present' },
      }),
    };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { summary: { noops: number; creates: number } };
    // 4 per-agent (app, repo, install, secret_fingerprint) + 2 CA (registry + the one agent repo) — all noop.
    expect(json.summary.noops).toBe(6);
    expect(json.summary.creates).toBe(0);
  });
});
