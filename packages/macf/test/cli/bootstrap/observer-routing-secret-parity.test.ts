/**
 * `githubRegistryObserver`'s NEW routing-secret-name-list read
 * (`observer.ts::listRepoSecretNames`, groundnuty/macf#1336) exercised
 * LIVE, through mocked `gh` calls, all the way to `formatPlanText`'s
 * rendered output — same "only `node:child_process`'s `execFile` is mocked,
 * no injected seam" posture `observer-row4-observation.test.ts`'s own doc
 * establishes for `githubRegistryObserver` (this function has no DI, unlike
 * `resolveAgentRepoState`'s own injectable deps). A regression in either
 * the observation (gated read, `--paginate`, jq-parsed name list) or the
 * wiring between it and `computePlan`/`formatPlanText` fails a test here,
 * not just in `routing-secret-parity.test.ts`'s pure-fixture suite or
 * `plan.test.ts`'s hand-built-`ObservedState` suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME } from '../../../src/cli/bootstrap/apply-routing-secrets.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn() };
});

const { execFile: mockExecFile } = await import('node:child_process');
const { githubRegistryObserver } = await import('../../../src/cli/bootstrap/observer.js');
const { computePlan, formatPlanText } = await import('../../../src/cli/bootstrap/plan.js');

/** One route: match on the joined `gh` argv, respond with a fixed stdout (or throw a stderr-carrying error). Same shape `observer-row4-observation.test.ts::GhRoute` already establishes. */
interface GhRoute {
  readonly match: (argv: string) => boolean;
  readonly stdout?: string;
  readonly stderrOnFail?: string;
}

/** Same router as `observer-row4-observation.test.ts::installGhRouter` — unmatched calls succeed with a harmless generic body so every unrelated read (repo existence, CA var, actions pin, archived bit) stays on its ordinary confirmed path. */
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
    metadata: { name: 'macf-trial' },
    owner: { account: 'macf-experiment', type: 'org', registry: { type: 'org', org: 'macf-experiment' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: [] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [
      { role: 'code-agent', profile: 'code', repo: 'macf-experiment/trial-code-agent', deploy_path: '/deploy/code-agent' },
      { role: 'writing-agent', profile: 'writing', repo: 'macf-experiment/trial-writing-agent', deploy_path: '/deploy/writing-agent' },
    ],
    ...overrides,
  } as FleetManifest;
}

let tmpDir: string;
let manifestPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'macf-observer-routing-secret-'));
  manifestPath = join(tmpDir, 'fleet.yaml');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.mocked(mockExecFile).mockReset();
});

describe('githubRegistryObserver — routing-secret NAME-list wiring (groundnuty/macf#1336, LIVE path)', () => {
  it('DECISIVE 1/2: TS_OAUTH present on one repo, absent on the other -> the REAL observer + REAL computePlan render the split in formatPlanText', async () => {
    installGhRouter([
      {
        match: (argv) => argv.includes('trial-code-agent/actions/secrets'),
        stdout: `${TS_OAUTH_CLIENT_ID_SECRET_NAME}\n${TS_OAUTH_SECRET_SECRET_NAME}\n`,
      },
      {
        match: (argv) => argv.includes('trial-writing-agent/actions/secrets'),
        stdout: '', // zero secrets on the newer/colder repo
      },
      // Explicit route for the control repo (not the generic fallback) —
      // `computePlan` now compares across `routerCarryingRepos(manifest)`,
      // which includes it; giving it its own deliberate response (rather
      // than relying on the router's unmatched-call fallback body) keeps
      // this fixture's outcome designed, not incidental.
      {
        match: (argv) => argv.includes('macf-trial-control/actions/secrets'),
        stdout: `${TS_OAUTH_CLIENT_ID_SECRET_NAME}\n${TS_OAUTH_SECRET_SECRET_NAME}\n`,
      },
    ]);
    const manifest = baseManifest();
    const observed = await githubRegistryObserver(manifest, manifestPath);
    expect(observed.routingSecretRepos?.['macf-experiment/trial-code-agent']).toEqual({
      status: 'confirmed',
      names: new Set([TS_OAUTH_CLIENT_ID_SECRET_NAME, TS_OAUTH_SECRET_SECRET_NAME]),
    });
    expect(observed.routingSecretRepos?.['macf-experiment/trial-writing-agent']).toEqual({ status: 'confirmed', names: new Set() });

    const plan = computePlan(manifest, observed);
    const text = formatPlanText(plan);
    expect(text).toContain('routing_secret: WARNING');
    expect(text).toContain(TS_OAUTH_CLIENT_ID_SECRET_NAME);
    expect(text).toContain('macf-experiment/trial-writing-agent'); // the ABSENT repo is named
    // The control repo HAS the secret here — must not be misnamed as absent
    // in the routing_secret WARNING specifically (checked on the structured
    // finding AND the WARNING lines alone, not the whole render — since
    // groundnuty/macf#1348's separate control_repo_coverage NOTICE
    // legitimately names the control repo too, for an unrelated CA/
    // routing-client-write disclosure that has nothing to do with this
    // TS_OAUTH split).
    const asymmetry = plan.routingSecretAsymmetries.find((a) => a.secretName === TS_OAUTH_CLIENT_ID_SECRET_NAME);
    expect(asymmetry?.absentRepos).not.toContain('macf-experiment/macf-trial-control');
    const routingSecretLines = text
      .split('\n')
      .filter((line) => line.startsWith('routing_secret:'))
      .join('\n');
    expect(routingSecretLines).not.toContain('macf-experiment/macf-trial-control');
  });

  it('DECISIVE 2/2: TS_OAUTH present on EVERY router-carrying repo (agents + control) -> no asymmetry line at all — uniform is the satisfied state', async () => {
    installGhRouter([{ match: (argv) => argv.includes('actions/secrets'), stdout: `${TS_OAUTH_CLIENT_ID_SECRET_NAME}\n${TS_OAUTH_SECRET_SECRET_NAME}\n` }]);
    const manifest = baseManifest();
    const observed = await githubRegistryObserver(manifest, manifestPath);
    // Every router-carrying repo — including the control repo, which this
    // route also covers (it matches on `actions/secrets` alone) — reads the
    // identical present pair, so this is uniform, not a split.
    expect(observed.routingSecretRepos?.['macf-experiment/macf-trial-control']?.status).toBe('confirmed');
    const plan = computePlan(manifest, observed);
    expect(formatPlanText(plan)).not.toContain('routing_secret:');
  });

  it('a repo whose secrets listing returns something that does NOT look like a secret-name list reads `unknown`, never a fabricated absence', async () => {
    installGhRouter([
      {
        match: (argv) => argv.includes('trial-code-agent/actions/secrets'),
        stdout: `${TS_OAUTH_CLIENT_ID_SECRET_NAME}\n${TS_OAUTH_SECRET_SECRET_NAME}\n`,
      },
      // A malformed/unexpected response (e.g. a stray `{}` — the shape a
      // naive default-fallback mock, or a `gh`/jq error leaking onto
      // stdout, might produce) must NOT be laundered into "confirmed,
      // zero secrets" — that would report every one of the six tracked
      // names as confidently ABSENT on a repo this run never actually
      // read.
      { match: (argv) => argv.includes('trial-writing-agent/actions/secrets'), stdout: '{}\n' },
    ]);
    const manifest = baseManifest();
    const observed = await githubRegistryObserver(manifest, manifestPath);
    expect(observed.routingSecretRepos?.['macf-experiment/trial-writing-agent']).toMatchObject({ status: 'unknown' });
    // Because the affected repo is honestly unknown (not confirmed absent),
    // it must never be named in an ABSENT list.
    const plan = computePlan(manifest, observed);
    const finding = plan.routingSecretAsymmetries.find((f) => f.secretName === TS_OAUTH_CLIENT_ID_SECRET_NAME);
    expect(finding?.absentRepos ?? []).not.toContain('macf-experiment/trial-writing-agent');
  });

  it('a repo this run could not confirm PRESENT never gets its secret list listed — gated on the SAME macf#1026 visibility discipline the CA/routing-client reads already use', async () => {
    installGhRouter([
      // The repo-existence read itself 404s — `resolveAgentRepoState` degrades the WHOLE trio to 'unknown', and the
      // NEW secret-list read must degrade the same way WITHOUT ever attempting the `actions/secrets` call.
      // `checkRepoExists` calls `gh api repos/<repo>` with no further path segments, so an exact-match on that
      // argv (never a `startsWith`/`includes`) is what distinguishes it from the CA-var/secret/actions-pin reads
      // that all also carry the repo name as a path PREFIX.
      { match: (argv) => argv === 'api repos/macf-experiment/trial-writing-agent', stderrOnFail: 'HTTP 404: Not Found' },
    ]);
    const manifest = baseManifest();
    const observed = await githubRegistryObserver(manifest, manifestPath);
    const writingAgentSecrets = observed.routingSecretRepos?.['macf-experiment/trial-writing-agent'];
    expect(writingAgentSecrets?.status).toBe('unknown');
    // The gated-read discipline means the secrets-list endpoint for this repo was never even called.
    const calls = vi.mocked(mockExecFile).mock.calls.map((c) => (c[1] as readonly string[]).join(' '));
    expect(calls.some((argv) => argv.includes('trial-writing-agent/actions/secrets'))).toBe(false);
  });

  it('the rendered plan text never contains a secret VALUE', async () => {
    installGhRouter([
      {
        match: (argv) => argv.includes('trial-code-agent/actions/secrets'),
        stdout: `${TS_OAUTH_CLIENT_ID_SECRET_NAME}\n`,
      },
    ]);
    const manifest = baseManifest();
    const observed = await githubRegistryObserver(manifest, manifestPath);
    const plan = computePlan(manifest, observed);
    const text = formatPlanText(plan);
    expect(text).not.toMatch(/ghs_|ghp_|gho_|ghu_|-----BEGIN/);
  });
});
