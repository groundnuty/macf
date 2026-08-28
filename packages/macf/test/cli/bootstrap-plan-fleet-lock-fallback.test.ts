/**
 * groundnuty/macf#1309 — this is the THIRD attempt at "row 4 sees a
 * manifest-removed, lock-recorded, live-present role." #1270 computed row
 * 4's per-class verbs correctly with no observation feeding them. #1292
 * gave `githubRegistryObserver` that observation — but ONLY when the
 * observer's `manifestPath` happens to be co-located with a local
 * `fleet.lock` file. On a REAL `plan` run against a manifest COPY (the
 * canonical way to preview an edit without touching the real checkout —
 * exactly what #1309's live `macf-trial` reproduction did), no local
 * `fleet.lock` exists next to the copy, `readFleetLock` returned `null`,
 * and row 4's `extraRoles` loop saw an empty `observed.agents` — #1292's
 * OWN tests (`observer-row4-observation.test.ts`) never caught this because
 * every one of them writes a `fleet.lock` file INTO the same directory as
 * the manifest it observes (`writeFleetLock(join(manifestPath, '..',
 * 'fleet.lock'), lock)`) — a precondition the live invocation shape never
 * satisfies. **None of #1292's tests would have caught this gap** — not
 * because they tested a pure function (they drove the REAL
 * `githubRegistryObserver`, already at the "live path" altitude the #1309
 * issue calls for), but because their OWN fixture manufactured a
 * co-located lock that doesn't match how `plan` is actually invoked against
 * a manifest copy.
 *
 * This file drives ONE level higher than `observer-row4-observation.test.ts`
 * — `runBootstrapPlan` itself, through the REAL `resolveDeps` (never a
 * hand-injected `BootstrapPlanDeps.observe`), so the full production chain
 * (`resolveDeps -> githubRegistryObserver -> resolveObservedFleetLock ->
 * computeInstallScopeCoverage -> computePlan -> render`) is what's under
 * test. Only `node:child_process.execFile` is mocked (same shape
 * `observer-row4-observation.test.ts` already uses) — never `observe`
 * itself. The load-bearing detail in every "decisive" test below: **no
 * local `fleet.lock` file is ever written** — its absence is the live
 * condition this issue is about; writing one would silently rebuild
 * #1292's own blind spot one level up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetLock } from '../../src/cli/bootstrap/fleet-manifest.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

const { execFile: mockExecFile } = await import('node:child_process');
const { resolveDeps, runBootstrapPlan } = await import('../../src/cli/commands/bootstrap.js');
const { serializeFleetLock } = await import('../../src/cli/bootstrap/fleet-lock.js');

/** One route: match on the joined `gh` argv, respond with a fixed stdout (or throw a stderr-carrying error). Same shape `observer-row4-observation.test.ts` already uses. */
interface GhRoute {
  readonly match: (argv: string) => boolean;
  readonly stdout?: string;
  readonly stderrOnFail?: string;
}

/**
 * Any call not matched by a route SUCCEEDS with a harmless generic body
 * (`'{}'`) — every OTHER read a real `plan` run makes (repo existence, CA
 * vars, actions pin, archived bit, control repo, registry lookups) degrades
 * gracefully on an unparsable/empty body, same posture
 * `observer-row4-observation.test.ts`'s own router doc establishes; the
 * point of these tests is the fleet.lock resolution specifically, not
 * re-proving every OTHER read's honest-unknown floor.
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

/** `argv` substrings this file's fleet.lock live-read route matches on. Bounded to the ONE derived control repo — asserting no OTHER repo/App is ever touched. */
const FLEET_LOCK_CONTENTS_ARGV = 'demo-fleet-control/contents/fleet.lock';

const MANIFEST_YAML = `
apiVersion: macf/v0
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
  age_recipients: []
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/demo-fleet-code-agent
    deploy_path: /deploy/code-agent
  - role: science-agent
    profile: science
    repo: groundnuty/demo-fleet-science-agent
    deploy_path: /deploy/science-agent
`;

/** `writing-agent` — declared once, in `fleet.lock` only (never in `MANIFEST_YAML.agents`) — mirrors #1309's live `macf-trial` repro exactly (`writing-agent` removed from the manifest, still recorded in the lock). */
const LOCK_WITH_EXTRA_ROLE: FleetLock = {
  schema_version: 1,
  fleet: 'demo-fleet',
  agents: [
    { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
    { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
    { role: 'writing-agent', app_id: 'app-writing-agent', install_id: 'install-3', fingerprints: { app_private_key: 'sha256:x' } },
  ],
};

const LOCK_STEADY_STATE: FleetLock = {
  schema_version: 1,
  fleet: 'demo-fleet',
  agents: [
    // groundnuty/macf#1310 corollary — `code-agent`'s fingerprints live
    // ONLY in `fleet.lock` (never the manifest). Pre-#1309, an absent
    // local lock made `secretFingerprintItem` read `obs?.fingerprints ??
    // {}` as EMPTY for every declared agent too, not just extra roles —
    // reporting a false `create` ("no fingerprints recorded ... has not
    // been provisioned yet") for an agent the SAME live control-repo lock
    // already recorded three fingerprints for. DECISIVE 2/2 below asserts
    // this now reads `noop`, sourced through the identical fallback this
    // file's `writing-agent` assertions exercise -- one resolver, two
    // symptoms, same fix.
    {
      role: 'code-agent',
      app_id: 'app-code-agent',
      install_id: 'install-1',
      fingerprints: { app_private_key: 'sha256:a', client_secret: 'sha256:b', webhook_secret: 'sha256:c' },
    },
    { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
  ],
};

interface PlanJson {
  readonly plan: ReadonlyArray<{ kind: string; target: string; verb: string; reason: string }>;
  readonly fleet_lock_source: string;
}

describe('runBootstrapPlan — fleet.lock live-control-repo fallback (groundnuty/macf#1309)', () => {
  const dirs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // groundnuty/macf#1309 review fix — without this, `mockExecFile.mock.calls`
    // accumulates across `it()` blocks (vitest does not auto-reset a
    // `vi.fn()` between tests), so a LATER test's call-count assertion was
    // silently counting calls made by EARLIER tests in this file, not just
    // its own. Each test's call-count assertion must reflect ONLY that
    // test's own invocation.
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy?.mockRestore();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeManifestOnly(): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-bootstrap-plan-lock-fallback-'));
    dirs.push(dir);
    const file = join(dir, 'fleet.yaml');
    // Deliberately NO fleet.lock written into `dir` — its absence IS the
    // live condition. `dir` also contains nothing else a co-located
    // fleet.lock read could ever pick up.
    writeFileSync(file, MANIFEST_YAML);
    return file;
  }

  // --- DECISIVE 1/2 -------------------------------------------------------

  it('DECISIVE 1/2: no local fleet.lock, but the DERIVED control repo has one recording an extra role -> the REAL runBootstrapPlan surfaces it as an orphan, through production wiring end to end', async () => {
    const file = writeManifestOnly();
    installGhRouter([
      { match: (argv) => argv.includes(FLEET_LOCK_CONTENTS_ARGV), stdout: Buffer.from(serializeFleetLock(LOCK_WITH_EXTRA_ROLE), 'utf-8').toString('base64') },
    ]);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Production wiring — resolveDeps, NEVER a hand-injected `observe`.
    const deps = resolveDeps(file);
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);

    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as PlanJson;

    // The role reached observed.agents and row 4 decomposed it per-class —
    // an App orphan AND a secret_fingerprint delete, never a coarse
    // "report-extra" (see plan.ts's own extraRoles loop doc).
    const appItem = json.plan.find((i) => i.kind === 'app' && i.target === 'agent:writing-agent:app');
    expect(appItem?.verb).toBe('orphan');
    const secretItem = json.plan.find((i) => i.kind === 'secret_fingerprint' && i.target.includes('writing-agent'));
    expect(secretItem?.verb).toBe('delete');
    expect(json.plan.some((i) => i.kind === 'agent' && i.target === 'agent:writing-agent')).toBe(false);

    // Provenance says exactly where this came from — never conflated with
    // "never provisioned."
    expect(json.fleet_lock_source).toBe('control-repo');

    // Bounded: exactly ONE call touched the derived control repo's
    // fleet.lock — never a second, never a scan of anything else.
    const lockCalls = vi.mocked(mockExecFile).mock.calls.filter((c) => (c[1] as readonly string[]).join(' ').includes(FLEET_LOCK_CONTENTS_ARGV));
    expect(lockCalls).toHaveLength(1);
  });

  // --- DECISIVE 2/2 (the sibling case the issue's own brief names) -------

  it('DECISIVE 2/2: a lock-recorded role that IS still declared in the manifest gets normal per-agent handling -- no orphan, no report-extra', async () => {
    const file = writeManifestOnly();
    installGhRouter([
      { match: (argv) => argv.includes(FLEET_LOCK_CONTENTS_ARGV), stdout: Buffer.from(serializeFleetLock(LOCK_STEADY_STATE), 'utf-8').toString('base64') },
    ]);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const deps = resolveDeps(file);
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);

    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as PlanJson;
    expect(json.plan.some((i) => i.target.includes('code-agent') && i.verb === 'orphan')).toBe(false);
    expect(json.plan.some((i) => i.kind === 'agent' && i.target === 'agent:code-agent')).toBe(false);
    expect(json.fleet_lock_source).toBe('control-repo');

    // groundnuty/macf#1310 corollary (see LOCK_STEADY_STATE's doc) — the
    // SAME resolved lock feeds a DECLARED agent's per-field observation,
    // not just row 4's extraRoles loop. `code-agent`'s three recorded
    // fingerprints must read as `noop` ("N fingerprint(s) recorded"),
    // never the false `create` ("no fingerprints recorded ... has not
    // been provisioned yet") a null/absent lock would have produced.
    const codeAgentSecrets = json.plan.find((i) => i.kind === 'secret_fingerprint' && i.target === 'agent:code-agent:secrets');
    expect(codeAgentSecrets?.verb).toBe('noop');
    expect(codeAgentSecrets?.reason).toContain('3 fingerprint(s) recorded in fleet.lock');
  });

  // --- No extra API cost on the common path -------------------------------

  it('a LOCAL fleet.lock already co-located with the manifest costs ZERO calls to the control repo\'s fleet.lock -- the fallback never fires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-bootstrap-plan-lock-fallback-local-'));
    dirs.push(dir);
    const file = join(dir, 'fleet.yaml');
    writeFileSync(file, MANIFEST_YAML);
    writeFileSync(join(dir, 'fleet.lock'), serializeFleetLock(LOCK_STEADY_STATE));
    installGhRouter([{ match: (argv) => argv.includes(FLEET_LOCK_CONTENTS_ARGV), stdout: Buffer.from(serializeFleetLock(LOCK_WITH_EXTRA_ROLE), 'utf-8').toString('base64') }]);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const deps = resolveDeps(file);
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);

    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as PlanJson;
    expect(json.fleet_lock_source).toBe('local');
    // The route above (which WOULD have surfaced writing-agent) was never
    // consulted -- proof the local file short-circuits the fallback.
    expect(json.plan.some((i) => i.target.includes('writing-agent'))).toBe(false);
    const lockCalls = vi.mocked(mockExecFile).mock.calls.filter((c) => (c[1] as readonly string[]).join(' ').includes(FLEET_LOCK_CONTENTS_ARGV));
    expect(lockCalls).toHaveLength(0);
  });

  // --- Honest-unknown: both sources fail -> never launders into "unprovisioned" silently, but DOES say so explicitly ---

  it('no local file AND the live control-repo read fails (404) -> lock stays null, extra role stays invisible, but fleet_lock_source says "unreadable" (never silently identical to a genuinely-fresh fleet)', async () => {
    const file = writeManifestOnly();
    installGhRouter([{ match: (argv) => argv.includes(FLEET_LOCK_CONTENTS_ARGV), stderrOnFail: 'HTTP 404: Not Found' }]);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const deps = resolveDeps(file);
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);

    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as PlanJson;
    expect(json.plan.some((i) => i.target.includes('writing-agent'))).toBe(false);
    expect(json.fleet_lock_source).toBe('unreadable');
  });
});
