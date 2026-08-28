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
const { computePlan, formatPlanText } = await import('../../../src/cli/bootstrap/plan.js');
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
 *
 * groundnuty/macf#1313 fix: `stderrOnFail` now attaches `.stderr` to the
 * rejected Error ITSELF (mirroring real `child_process.execFile`'s
 * documented error shape), not just the discarded second callback
 * argument. `execFileAsync` here is `promisify(execFile)` over a plain
 * `vi.fn()` mock with no `[util.promisify.custom]` — Node's default
 * promisify wrapper rejects with the callback's first (`err`) argument
 * verbatim and drops any additional arguments, so `getStderr(err)` (which
 * reads `err.stderr`) previously always saw `undefined` for every
 * `stderrOnFail` route in this file, even though the field has existed
 * since this file's original #1271 commit — it was simply never exercised
 * by a test until #1313 needed to simulate a confirmed-404 / unreadable
 * `checkRepoExists` read.
 */
function installGhRouter(routes: readonly GhRoute[] = []): void {
  vi.mocked(mockExecFile).mockImplementation((_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
    const argv = (args as readonly string[]).join(' ');
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void;
    for (const route of routes) {
      if (!route.match(argv)) continue;
      if (route.stderrOnFail !== undefined) {
        const err = Object.assign(new Error('gh failed'), { stdout: '', stderr: route.stderrOnFail });
        callback(err, { stdout: '', stderr: route.stderrOnFail });
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
    // groundnuty/macf#1313 — the observed repo Presence stays 'unknown'
    // (nothing changed there; asserted above), but `computePlan` STILL
    // emits a repo-orphan item for this role, naming it rather than
    // staying silent (the pre-fix behavior this test used to pin as
    // correct — it was actually the bug #1313 reported: the orphaned repo
    // was invisible on every pre-#1296 lock).
    const repoItem = plan.items.find((i) => i.kind === 'repo' && i.target === 'agent:dropped-agent:repo');
    expect(repoItem?.verb).toBe('orphan');
    expect(repoItem?.reason).toContain('dropped-agent');
    expect(repoItem?.reason).toContain('unrecorded');
    expect(repoItem?.reason).not.toMatch(/https:\/\/github\.com\/\S+\/settings/);
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

/**
 * groundnuty/macf#1313 — "row 4 orphans an App but never a repo" LIVE, via
 * the REAL `githubRegistryObserver` feeding the REAL `computePlan`, per
 * `assert-the-wrong-path.md`: a hand-built `ObservedState` fixture proves
 * nothing about reachability (groundnuty/macf#1311's own lesson — this
 * EXACT "lock predates repo recording" shape passed every `plan.test.ts`
 * unit test while remaining completely unreachable on a live `macf-trial`
 * run, because `githubRegistryObserver`'s row-4 loop hardcoded `repo:
 * 'unknown'` regardless of what `fleet.lock` recorded — see that file's
 * fix in this same PR). This describe block is the durable regression
 * guard for BOTH halves of the fix: the unrecorded-name branch firing
 * unconditionally in `plan.ts`, AND `observer.ts`'s row-4 loop actually
 * live-checking a RECORDED repo name instead of hardcoding `'unknown'`.
 */
describe('githubRegistryObserver + computePlan — groundnuty/macf#1313 (row-4 repo-orphan visibility), LIVE path', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tempManifestPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-bootstrap-row4-1313-'));
    dirs.push(dir);
    return join(dir, 'fleet.yaml');
  }

  function lockWith(extra: FleetLockAgent): FleetLock {
    return {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }, extra],
    };
  }

  // --- Decisive pair, member 1 (this issue's reported bug) ---------------

  it('DECISIVE 1/2: role in lock, repo ABSENT FROM THE LOCK (pre-#1296) → the RENDERED plan orphans it naming the ROLE, never a repo name', async () => {
    installGhRouter();
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();
    // No `repo` key at all on this entry — the pre-#1296 shape every
    // existing fleet.lock has until it next re-applies.
    writeFleetLock(join(manifestPath, '..', 'fleet.lock'), lockWith({ role: 'writing-agent', app_id: 'app-writing', install_id: 'install-writing' }));

    const observed = await githubRegistryObserver(manifest, manifestPath);
    // Nothing to live-check without a name — stays honestly 'unknown'.
    expect(observed.agents['writing-agent']?.repo).toBe('unknown');

    const plan = computePlan(manifest, observed);
    const repoItem = plan.items.find((i) => i.kind === 'repo' && i.target === 'agent:writing-agent:repo');
    expect(repoItem?.verb).toBe('orphan');
    expect(repoItem?.reason).toContain('writing-agent');
    expect(repoItem?.reason).toContain('unrecorded');
    expect(repoItem?.reason).not.toMatch(/https:\/\/github\.com\/\S+\/settings/);
    // The RENDERED, operator-facing plan text — not just the raw item.
    const text = formatPlanText(plan);
    expect(text).toContain('writing-agent');
    expect(text).not.toMatch(/https:\/\/github\.com\/\S+\/settings/);
  });

  // The above test's `formatPlanText` assertions sit BEHIND item-level
  // assertions in the same `it` — a failure there (e.g. under the mutation
  // documented below) throws before the text-level checks ever run, so it
  // alone does not demonstrate a RENDERED-OUTPUT failure, only an item-shape
  // one (`assert-the-wrong-path.md`). This test asserts ONLY on
  // `formatPlanText`'s string output, using phrasing that ONLY the repo-
  // orphan branch this fix adds can produce — the App-orphan row for the
  // SAME role never says any of it. Under the "break the unrecorded-repo
  // path" mutation, THIS is the assertion that fails, and it fails reading
  // rendered text, not a raw `PlanItem`.
  it('DECISIVE 1/2b: the RENDERED plan TEXT alone carries repo-row-specific language the App-orphan row never produces', async () => {
    installGhRouter();
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();
    writeFleetLock(join(manifestPath, '..', 'fleet.lock'), lockWith({ role: 'writing-agent', app_id: 'app-writing', install_id: 'install-writing' }));

    const observed = await githubRegistryObserver(manifest, manifestPath);
    const plan = computePlan(manifest, observed);
    const text = formatPlanText(plan);
    expect(text).toMatch(/unrecorded/i);
    expect(text).toMatch(/search your github/i);
    expect(text).toMatch(/self-limiting/i);
  });

  // --- Decisive pair, member 2 (must not regress) -------------------------

  it('DECISIVE 2/2: role in lock, repo RECORDED in the lock (post-#1296) and confirmed live on GitHub → the RENDERED plan names it exactly with its real settings URL', async () => {
    installGhRouter([{ match: (argv) => argv === 'api repos/groundnuty/trial-writing-agent', stdout: '{}' }]);
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();
    writeFleetLock(
      join(manifestPath, '..', 'fleet.lock'),
      lockWith({ role: 'writing-agent', app_id: 'app-writing', install_id: 'install-writing', repo: 'groundnuty/trial-writing-agent' }),
    );

    const observed = await githubRegistryObserver(manifest, manifestPath);
    // Proves the OTHER half of the #1313 fix: `observer.ts` no longer
    // hardcodes 'unknown' when the lock DOES record a name — it live-checks it.
    expect(observed.agents['writing-agent']?.repo).toBe('present');

    const plan = computePlan(manifest, observed);
    const repoItem = plan.items.find((i) => i.kind === 'repo' && i.target === 'agent:writing-agent:repo');
    expect(repoItem?.verb).toBe('orphan');
    expect(repoItem?.reason).toContain('https://github.com/groundnuty/trial-writing-agent/settings');
    const text = formatPlanText(plan);
    expect(text).toContain('https://github.com/groundnuty/trial-writing-agent/settings');
  });

  // --- Plus coverage -------------------------------------------------------

  it('repo RECORDED in the lock but genuinely absent on GitHub (confirmed 404) → no orphan at all — nothing to warn about', async () => {
    installGhRouter([{ match: (argv) => argv === 'api repos/groundnuty/gone-writing-agent', stderrOnFail: 'HTTP 404: Not Found' }]);
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();
    writeFleetLock(
      join(manifestPath, '..', 'fleet.lock'),
      lockWith({ role: 'writing-agent', app_id: 'app-writing', install_id: 'install-writing', repo: 'groundnuty/gone-writing-agent' }),
    );

    const observed = await githubRegistryObserver(manifest, manifestPath);
    expect(observed.agents['writing-agent']?.repo).toBe('absent');

    const plan = computePlan(manifest, observed);
    expect(plan.items.find((i) => i.kind === 'repo' && i.target === 'agent:writing-agent:repo')).toBeUndefined();
  });

  it('repo RECORDED in the lock but presence unreadable this run (non-404 failure) → stays "unknown", no orphan — the honest-unknown floor, never silently upgraded to a claim', async () => {
    installGhRouter([{ match: (argv) => argv === 'api repos/groundnuty/unreadable-writing-agent', stderrOnFail: 'gh: connection reset by peer' }]);
    const manifest = baseManifest();
    const manifestPath = tempManifestPath();
    writeFleetLock(
      join(manifestPath, '..', 'fleet.lock'),
      lockWith({ role: 'writing-agent', app_id: 'app-writing', install_id: 'install-writing', repo: 'groundnuty/unreadable-writing-agent' }),
    );

    const observed = await githubRegistryObserver(manifest, manifestPath);
    expect(observed.agents['writing-agent']?.repo).toBe('unknown');

    const plan = computePlan(manifest, observed);
    expect(plan.items.find((i) => i.kind === 'repo' && i.target === 'agent:writing-agent:repo')).toBeUndefined();
  });

  it('a DECLARED role never produces a row-4 repo orphan, regardless of live repo state', async () => {
    installGhRouter();
    const manifest = baseManifest(); // declares only 'code-agent'
    const manifestPath = tempManifestPath();
    writeFleetLock(join(manifestPath, '..', 'fleet.lock'), { schema_version: 1, fleet: 'demo-fleet', agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }] });

    const observed = await githubRegistryObserver(manifest, manifestPath);
    const plan = computePlan(manifest, observed);
    expect(plan.items.some((i) => i.kind === 'repo' && i.verb === 'orphan')).toBe(false);
  });

  // --- Mutation check: break the unrecorded-repo path, name what fails ---
  //
  // Empirically verified (not merely asserted): mutating `plan.ts`'s row-4
  // repo block's `if (lockedRepo === undefined)` to `if (false &&
  // lockedRepo === undefined)` — reproducing the pre-#1313 shape, where the
  // whole branch was gated on `obs?.repo === 'present'` regardless of
  // `lockedRepo` — and re-running this suite fails BOTH "DECISIVE 1/2" (the
  // item-level `repoItem?.verb` assertion) AND "DECISIVE 1/2b" (the
  // formatPlanText-ONLY assertion, which reads rendered text exclusively —
  // per `assert-the-wrong-path.md`, an item-level assertion failing first in
  // the SAME `it` would not by itself prove a rendered-output failure, which
  // is why 1/2b exists as its own test). Both fail because `observer.ts`
  // can never observe a pre-#1296 lock's row-4 repo as anything but
  // `'unknown'` (there is no name to check), so the gate never opens. The
  // mutation does NOT fail "DECISIVE 2/2" — that member exercises the
  // recorded-name path, unaffected. This is the concrete, rendered-output
  // test #1311's lesson calls for: a helper-level (`orphanResourceUrl`) or
  // hand-built-fixture test cannot distinguish the pre-fix code from the
  // fix, because both compute the SAME `orphanResourceUrl` return value
  // once a `PlanItem` is already being built — the defect was that the item
  // was never built in the first place. Mutation reverted after confirming;
  // these tests are the durable regression guard going forward.
});
