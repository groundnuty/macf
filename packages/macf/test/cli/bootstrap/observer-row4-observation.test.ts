/**
 * groundnuty/macf#1271 (disclosed by #1270's own body) — row 4 of the
 * reconciler verb matrix (`plan.ts`'s `extraRoles` loop) computes
 * `delete`/`orphan` correctly, but until this change no REAL `plan` run
 * could ever reach it: `githubRegistryObserver` built `observed.agents`
 * exclusively from `manifest.agents`, so a role dropped from the manifest
 * but still recorded in `fleet.lock` never showed up as a key in
 * `observed.agents` for row 4 to act on. `computePlan`'s own tests (in
 * `plan.test.ts`) exhaustively cover row 4 against HAND-BUILT
 * `ObservedState` fixtures — exactly the "pure-function test passing" shape
 * the issue warns produced an unreachable feature the first time.
 *
 * This file exercises the LIVE path deliberately: the REAL
 * `githubRegistryObserver` (only `node:child_process`'s `execFile` is
 * mocked — no injected seam, unlike `checkRunnerUsableByRepo` /
 * `resolveAgentRepoState` in `observer.test.ts`, which this module's own
 * doc says are the ones exempted from the "not unit-tested here" posture)
 * feeding a REAL, unmodified `computePlan`. A regression in either the
 * observation or the wiring between them fails a test here, not just in
 * `plan.test.ts`'s fixture-only suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetLock, FleetLockAgent, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

const { execFile: mockExecFile } = await import('node:child_process');
const { githubRegistryObserver } = await import('../../../src/cli/bootstrap/observer.js');
const { computePlan } = await import('../../../src/cli/bootstrap/plan.js');
const { writeFleetLock } = await import('../../../src/cli/bootstrap/fleet-lock.js');

/** One route: match on the joined `gh` argv, respond with a fixed stdout (or throw a stderr-carrying error). */
interface GhRoute {
  readonly match: (argv: string) => boolean;
  readonly stdout?: string;
  readonly stderrOnFail?: string;
}

/**
 * Installs a `gh`-argv router on the mocked `execFile`. Any call not
 * matched by a route SUCCEEDS with a harmless generic body (`'{}'`) —
 * every read this file exercises degrades gracefully on an unparsable/
 * empty body (see `observer.ts`'s own "NEVER throws" convention), so the
 * default keeps every unrelated read (CA vars, secrets, actions pin,
 * archived bit, control repo) on its ordinary confirmed-present path
 * without this test needing to enumerate every single one.
 */
function installGhRouter(routes: readonly GhRoute[] = []): void {
  vi.mocked(mockExecFile).mockImplementation((_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
    const argv = (args as readonly string[]).join(' ');
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void;
    for (const route of routes) {
      if (!route.match(argv)) continue;
      if (route.stderrOnFail !== undefined) {
        callback(new Error('gh failed'), { stdout: '', stderr: route.stderrOnFail });
      } else {
        callback(null, { stdout: route.stdout ?? '', stderr: '' });
      }
      return {} as ReturnType<typeof import('node:child_process').execFile>;
    }
    callback(null, { stdout: '{}', stderr: '' });
    return {} as ReturnType<typeof import('node:child_process').execFile>;
  });
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
    ...overrides,
  } as FleetManifest;
}

describe('githubRegistryObserver — row-4 observation wiring (groundnuty/macf#1271, LIVE path)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tempManifestPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-bootstrap-row4-'));
    dirs.push(dir);
    return join(dir, 'fleet.yaml');
  }

  // --- Decisive pair, member 1 ------------------------------------------

  it('DECISIVE 1/2: a role recorded in fleet.lock, absent from manifest.agents, is observed — and the REAL computePlan emits its per-class row-4 verb', async () => {
    installGhRouter();
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();
    const lock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'dropped-agent', app_id: 'app-dropped', install_id: 'install-dropped', fingerprints: { app_private_key: 'sha256:x' } },
      ],
    };
    writeFleetLock(join(manifestPath, '..', 'fleet.lock'), lock);

    const observed = await githubRegistryObserver(manifest, manifestPath);

    // The extra role is observed, sourced entirely from fleet.lock.
    const extra = observed.agents['dropped-agent'];
    expect(extra?.app).toBe('present');
    expect(extra?.appId).toBe('app-dropped');
    expect(extra?.install).toBe('present');
    expect(extra?.installId).toBe('install-dropped');
    expect(extra?.fingerprints).toEqual({ app_private_key: 'sha256:x' });
    // No repo name exists anywhere in fleet.lock for ANY role — honest-
    // unknown, never a guessed 'absent'.
    expect(extra?.repo).toBe('unknown');

    // The declared role is untouched by the new loop.
    expect(observed.agents['code-agent']?.repo).toBe('present');

    // Feed the REAL observation into the REAL, unmodified computePlan.
    const plan = computePlan(manifest, observed);
    const appItem = plan.items.find((i) => i.kind === 'app' && i.target === 'agent:dropped-agent:app');
    expect(appItem?.verb).toBe('orphan');
    const secretItem = plan.items.find((i) => i.kind === 'secret_fingerprint' && i.target === 'agent:dropped-agent:secret_fingerprint:app_private_key');
    expect(secretItem?.verb).toBe('delete');
    // repo stays unknown -> no repo-class item for this role at all.
    expect(plan.items.find((i) => i.kind === 'repo' && i.target === 'agent:dropped-agent:repo')).toBeUndefined();
    // Never a coarse "report-extra" for a lock-recorded role — it decomposed.
    expect(plan.items.find((i) => i.kind === 'agent' && i.target === 'agent:dropped-agent')).toBeUndefined();
  });

  // --- Decisive pair, member 2 (the "wrong path" the issue calls out) ---

  it('DECISIVE 2/2: a role visible on GitHub (org-installations listing) but absent from fleet.lock is NEVER observed as an extra role — no unbounded enumeration', async () => {
    // owner.type: 'org' so the org-installations listing (the one call in
    // this file that genuinely enumerates MULTIPLE apps at once) actually
    // runs — and deliberately advertises an app for a role this fleet's
    // lock does not know about, to prove that signal alone can't leak a
    // role into `observed.agents`.
    const manifest = baseManifest({ owner: { account: 'demo-org', type: 'org', registry: { type: 'profile', user: 'groundnuty' } } });
    installGhRouter([
      {
        match: (argv) => argv.includes('orgs/demo-org/installations'),
        stdout: JSON.stringify({
          installations: [
            { app_slug: 'demo-fleet-code-agent', repository_selection: 'selected' },
            // Visible on GitHub, present in the org's installations — but
            // NOT in fleet.lock below.
            { app_slug: 'demo-fleet-ghost-role', repository_selection: 'all' },
          ],
        }),
      },
    ]);
    const manifestPath = tempManifestPath();
    // fleet.lock records ONLY the declared role — no 'ghost-role' entry.
    const lock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    };
    writeFleetLock(join(manifestPath, '..', 'fleet.lock'), lock);

    const observed = await githubRegistryObserver(manifest, manifestPath);

    expect(Object.keys(observed.agents).sort()).toEqual(['code-agent']);
    expect(observed.agents['ghost-role']).toBeUndefined();

    const plan = computePlan(manifest, observed);
    // Nothing in the plan references the ghost role at all — not
    // report-extra, not orphan, not delete. It was never observed, so row
    // 4's `extraRoles` loop (keyed off `Object.keys(observed.agents)`)
    // never even considers it.
    expect(plan.items.some((i) => i.target.includes('ghost-role'))).toBe(false);
  });

  // --- Supporting requirements --------------------------------------------

  it('an unreadable/unknowable observation stays "unknown", never "absent" — the extra role\'s repo has no source anywhere in fleet.lock', async () => {
    installGhRouter();
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();
    const lock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'dropped-agent', app_id: 'app-dropped', install_id: 'install-dropped' },
      ],
    };
    writeFleetLock(join(manifestPath, '..', 'fleet.lock'), lock);

    const observed = await githubRegistryObserver(manifest, manifestPath);
    expect(observed.agents['dropped-agent']?.repo).toBe('unknown');
    expect(observed.agents['dropped-agent']?.repo).not.toBe('absent');
  });

  it('a declared role\'s own observation is unaffected by the extra-role loop running alongside it', async () => {
    installGhRouter();
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();
    const lock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'dropped-agent', app_id: 'app-dropped', install_id: 'install-dropped' },
      ],
    };
    writeFleetLock(join(manifestPath, '..', 'fleet.lock'), lock);

    const observed = await githubRegistryObserver(manifest, manifestPath);
    const declared = observed.agents['code-agent'];
    expect(declared?.app).toBe('present');
    expect(declared?.install).toBe('present');
    expect(declared?.repo).toBe('present');
    expect(declared?.appId).toBe('app-code-agent');
  });

  it('a fleet whose fleet.lock records EXACTLY its manifest roles (no extra roles) issues NO additional gh calls versus a fleet with an extra role recorded', async () => {
    async function callCount(lockAgents: FleetLockAgent[]): Promise<number> {
      vi.mocked(mockExecFile).mockClear();
      installGhRouter();
      const manifest = baseManifest();
      const manifestPath = tempManifestPath();
      writeFleetLock(join(manifestPath, '..', 'fleet.lock'), { schema_version: 1, fleet: 'demo-fleet', agents: lockAgents });
      await githubRegistryObserver(manifest, manifestPath);
      return vi.mocked(mockExecFile).mock.calls.length;
    }

    const noExtra = await callCount([{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }]);
    const withExtra = await callCount([
      { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
      { role: 'dropped-agent', app_id: 'app-dropped', install_id: 'install-dropped', fingerprints: { app_private_key: 'sha256:x' } },
    ]);

    // The extra-role loop is a pure in-memory read over the ALREADY-parsed
    // `fleet.lock` — adding a lock-recorded extra role must cost ZERO
    // additional `gh` invocations.
    expect(withExtra).toBe(noExtra);
    expect(noExtra).toBeGreaterThan(0); // sanity: the observer did real work
  });

  // --- MACF_TRUSTED_ACTORS read widened to the undeclared-routing case ---

  it('MACF_TRUSTED_ACTORS is read even when routing.runner is undeclared — and the REAL computePlan turns a stale, lock-owned value into a "delete" row-4 item', async () => {
    installGhRouter([
      {
        match: (argv) => argv.includes('actions/variables/MACF_TRUSTED_ACTORS'),
        stdout: 'demo-fleet-code-agent[bot]',
      },
    ]);
    // routing is UNDECLARED — the exact row-4 trigger shape (#1229's
    // motivating case: routing.runner DROPPED from the manifest).
    const manifest = baseManifest();
    expect(manifest.routing).toBeUndefined();
    const manifestPath = tempManifestPath();
    // The representative role (agents[0] == 'code-agent') IS recorded in
    // fleet.lock — `routingDroppedItem`'s "ownedByThisTool" gate.
    const lock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    };
    writeFleetLock(join(manifestPath, '..', 'fleet.lock'), lock);

    const observed = await githubRegistryObserver(manifest, manifestPath);
    expect(observed.routingTrustedActors).toBe('demo-fleet-code-agent[bot]');

    const plan = computePlan(manifest, observed);
    const routingItem = plan.items.find((i) => i.kind === 'routing');
    expect(routingItem?.verb).toBe('delete');
    expect(routingItem?.reason).toContain('MACF_TRUSTED_ACTORS');
  });

  it('a declared routing.runner keeps reading MACF_TRUSTED_ACTORS exactly as before (widening the gate did not touch the declared-side behavior)', async () => {
    installGhRouter([
      {
        match: (argv) => argv.includes('actions/variables/MACF_TRUSTED_ACTORS'),
        stdout: 'demo-fleet-code-agent[bot]',
      },
      // Keep the runner-usability chain (register-before-route) trivially
      // "unknown" rather than throwing — its exact shape isn't this test's
      // concern, only that the trusted-actors read itself still happens.
      { match: (argv) => argv.includes('actions/runners'), stdout: '[]' },
      { match: (argv) => argv.includes('runner-groups'), stdout: '[]' },
    ]);
    const manifest = baseManifest({ routing: { runner: { runs_on: 'github-hosted', warm: 0 } } });
    const manifestPath = tempManifestPath();
    writeFleetLock(join(manifestPath, '..', 'fleet.lock'), {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    });

    const observed = await githubRegistryObserver(manifest, manifestPath);
    expect(observed.routingTrustedActors).toBe('demo-fleet-code-agent[bot]');
  });
});
