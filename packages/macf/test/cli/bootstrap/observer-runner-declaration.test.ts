/**
 * groundnuty/macf#1335 — this file exercises the LIVE wiring deliberately
 * (mirrors `observer-row4-observation.test.ts`'s own posture): the REAL
 * `githubRegistryObserver` (only `node:child_process`'s `execFile` is
 * mocked) feeding a REAL, unmodified `computePlan` + `formatPlanText`. A
 * regression in either the observation or the wiring between them fails a
 * test here — not just in `plan.test.ts`'s fixture-only suite, which
 * hand-builds `ObservedAgentState.routerWithKeys` and so cannot catch a bug
 * in HOW that field gets populated (the exact "fixture supplied the
 * precondition whose absence was the bug" shape this issue's own thread
 * warns about, citing groundnuty/macf#1292).
 *
 * Also proves the "no second read" requirement directly: the installed
 * `.github/workflows/agent-router.yml` contents-API route is hit EXACTLY
 * ONCE per agent, powering BOTH `actionsPin` and `routerWithKeys`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

const { execFile: mockExecFile } = await import('node:child_process');
const { githubRegistryObserver } = await import('../../../src/cli/bootstrap/observer.js');
const { computePlan, formatPlanText } = await import('../../../src/cli/bootstrap/plan.js');

/**
 * Scoped to the AGENT's own repo specifically — `githubRegistryObserver`
 * ALSO reads the derived control repo's installed router (a legitimate,
 * separate read of a DIFFERENT repo, `resolveObservedFleetLock`'s own
 * fallback) — the unscoped path substring alone would double-count that
 * unrelated read as if it were a second read of the SAME agent's file.
 */
const AGENT_ROUTER_CONTENTS_PATH = 'repos/groundnuty/demo-fleet-experiment/contents/.github/workflows/agent-router.yml';

/** A caller passing only the two known, verified-non-runner-intent keys — the SAME shape `runner-declaration-reach.test.ts`'s `TODAYS_CALLER_YAML` fixture uses. */
const TODAYS_CALLER_YAML = `name: Agent Router

on:
  issue_comment:
    types: [created]

jobs:
  route:
    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.4.2
    with:
      project: myproject
      registry-api-path: /orgs/myorg
    secrets:
      MACF_ROUTING_BUNDLE: \${{ secrets.MACF_ROUTING_BUNDLE }}
`;

interface GhRoute {
  readonly match: (argv: string) => boolean;
  readonly stdout?: string;
  readonly fail?: boolean;
}

/** Same router shape `observer-row4-observation.test.ts` uses — any unmatched call succeeds with a harmless generic body. */
function installGhRouter(routes: readonly GhRoute[] = []): { callCountFor: (needle: string) => number } {
  const calls: string[] = [];
  vi.mocked(mockExecFile).mockImplementation((_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
    const argv = (args as readonly string[]).join(' ');
    calls.push(argv);
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void;
    for (const route of routes) {
      if (!route.match(argv)) continue;
      if (route.fail === true) {
        callback(new Error('gh failed'), { stdout: '', stderr: 'gh failed' });
      } else {
        callback(null, { stdout: route.stdout ?? '', stderr: '' });
      }
      return {} as ReturnType<typeof import('node:child_process').execFile>;
    }
    callback(null, { stdout: '{}', stderr: '' });
    return {} as ReturnType<typeof import('node:child_process').execFile>;
  });
  return { callCountFor: (needle: string) => calls.filter((c) => c.includes(needle)).length };
}

function baseManifest(overrides: Partial<FleetManifest> = {}): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'demo-fleet' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: [] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [{ role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-fleet-experiment', deploy_path: '/deploy/code-agent' }],
    routing: { runner: { runs_on: 'self-hosted', warm: 1 } },
    ...overrides,
  } as FleetManifest;
}

describe('githubRegistryObserver -> computePlan -> formatPlanText — runner-declaration LIVE wiring (groundnuty/macf#1335)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tempManifestPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-bootstrap-runner-decl-'));
    dirs.push(dir);
    return join(dir, 'fleet.yaml');
  }

  it('DECISIVE: a real gh-mocked read of an installed router whose with: keys cannot convey a self-hosted declaration reaches the RENDERED plan text, from ONE contents-API call', async () => {
    const b64 = Buffer.from(TODAYS_CALLER_YAML, 'utf-8').toString('base64');
    const { callCountFor } = installGhRouter([{ match: (argv) => argv.includes(AGENT_ROUTER_CONTENTS_PATH), stdout: b64 }]);
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();

    const observed = await githubRegistryObserver(manifest, manifestPath);

    // The observation itself: both fields, from the same single read.
    expect(observed.agents['code-agent']?.actionsPin).toBe('v3.4.2');
    expect(observed.agents['code-agent']?.routerWithKeys).toEqual(['project', 'registry-api-path']);
    expect(callCountFor(AGENT_ROUTER_CONTENTS_PATH)).toBe(1);

    // The REAL, unmodified computePlan + formatPlanText — the mutation-test
    // altitude this issue's own thread demands: assert against the RENDERED
    // output, not a helper's return value.
    const plan = computePlan(manifest, observed);
    expect(plan.runnerDeclarationMismatches).toHaveLength(1);
    const text = formatPlanText(plan);
    expect(text).toContain('runner_declaration: NOT HONOURED');
    expect(text).toContain('groundnuty/demo-fleet-experiment');
    expect(text).toContain('MACF_TRUSTED_ACTORS');
  });

  it('hosted declared -> the read still happens (actionsPin is needed regardless) but NOTHING renders — no row, no noise', async () => {
    const b64 = Buffer.from(TODAYS_CALLER_YAML, 'utf-8').toString('base64');
    installGhRouter([{ match: (argv) => argv.includes(AGENT_ROUTER_CONTENTS_PATH), stdout: b64 }]);
    const manifest = baseManifest({ routing: { runner: { runs_on: 'ubuntu-latest', warm: 1 } } });
    const manifestPath = tempManifestPath();

    const observed = await githubRegistryObserver(manifest, manifestPath);
    const plan = computePlan(manifest, observed);
    expect(plan.runnerDeclarationMismatches).toEqual([]);
    expect(formatPlanText(plan)).not.toContain('runner_declaration');
  });

  it('the installed workflow is unreadable (gh call fails) -> an UNKNOWN row, never silence, and the run does not fail', async () => {
    installGhRouter([{ match: (argv) => argv.includes(AGENT_ROUTER_CONTENTS_PATH), fail: true }]);
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();

    const observed = await githubRegistryObserver(manifest, manifestPath);
    expect(observed.agents['code-agent']?.routerWithKeys).toBeUndefined();

    const plan = computePlan(manifest, observed);
    expect(plan.runnerDeclarationMismatches).toHaveLength(1);
    expect(plan.runnerDeclarationMismatches[0]?.verdict).toBe('unknown');
    expect(formatPlanText(plan)).toContain('runner_declaration: UNKNOWN');
  });
});
