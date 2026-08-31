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
import { operatorInputProvenance, resolveDeps, runBootstrapPlan, type BootstrapPlanDeps } from '../../src/cli/commands/bootstrap.js';
import type { ObservedState } from '../../src/cli/bootstrap/plan.js';
import { parseFleetManifest } from '../../src/cli/bootstrap/fleet-manifest.js';
import { resolveRunnerPlatformEndpointWithProvenance } from '../../src/cli/bootstrap/runner-platform.js';

// groundnuty/macf#1357 made `defaults.app_manifest` / `agents[].profile`
// `.optional()`; omitted here (the new ordinary case) so this fixture's own
// "the skipped-section block" tests below — which assert EXACT
// `skipped_sections` content keyed on `collaborators` alone — stay accurate.
// See `bootstrap/plan.test.ts`'s dedicated decisive-pair tests for the
// declared-case coverage of these two fields.
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
agents:
  - role: code-agent
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

const EMPTY_OBSERVED: ObservedState = { lock: null, agents: {}, caRegistry: 'unknown', caRepos: {}, controlRepoPresence: 'absent' };

/**
 * DR-043 Amendment D phase 2 (macf#838) — `ca` is fully implemented now
 * (mint-or-reuse + two-place publish), so `VALID_FLEET_YAML` + `EMPTY_OBSERVED`
 * alone no longer produce an `unimplemented_by_apply` entry. These two
 * fixtures add a `routing:` declaration + an observed value that DIVERGES
 * from it (`update` verb — apply's create-only posture never overwrites a
 * present-but-diverging value) for the tests that specifically exercise that
 * render. **Since groundnuty/macf#942** (DR-043 Amendment I), declaring
 * `routing.runner` ALSO always emits a `runner_warm` item (the `warm` field
 * it defaults to) — but `runner_warm` is fully IMPLEMENTED as of groundnuty/
 * macf#943 (apply calls the runner-provisioning contract), so it never
 * surfaces under `unimplemented_by_apply`; only the diverging `routing`
 * value does.
 */
const VALID_FLEET_YAML_WITH_ROUTING = VALID_FLEET_YAML.replace(
  'agents:\n',
  'routing:\n  runner:\n    runs_on: self-hosted\nagents:\n',
);
const OBSERVED_ROUTING_DRIFT: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };

/** groundnuty/macf#1197 — same fixture as {@link VALID_FLEET_YAML}, `transport.tailscale_oauth_required: true` declared. Used ONLY by the operator-inputs-provenance describe block below. */
const VALID_FLEET_YAML_WITH_TAILSCALE = VALID_FLEET_YAML.replace('age_recipients: []', 'age_recipients: []\n  tailscale_oauth_required: true');

/**
 * groundnuty/macf#1279 — same fixture as {@link VALID_FLEET_YAML} but with a
 * `registry: { type: org }` (never a router-App target, per
 * `apply-router-app.ts::routerAppInstallRepos`'s doc: empty for
 * `registry.type: org|local`) and no `routing:` declared (never a
 * runner-ops target either, per `runnerOpsNeeded`). Zero
 * `installScopeCoverageTargets` — used ONLY by the "nothing to check"
 * test below, to prove the unconditional call still makes ZERO I/O and
 * renders NO notice for a fleet with no fleet-level App at all.
 */
const VALID_FLEET_YAML_NO_FLEET_APPS = VALID_FLEET_YAML.replace(
  'registry: { type: profile, user: groundnuty }',
  'registry: { type: org, org: groundnuty-org }',
);

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
    // groundnuty/macf#1279 bumped FLEET_PLAN_JSON_SCHEMA_VERSION 1 -> 2 (the
    // failure envelope shares the SAME constant as the success envelope —
    // see fleetPlanFailureToJson's own doc).
    expect(json.schema_version).toBe(2);
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
    // groundnuty/macf#1279 bumped FLEET_PLAN_JSON_SCHEMA_VERSION 1 -> 2.
    expect(json.schema_version).toBe(2);
    expect(json.fleet).toBe('icsoc-2026');
    expect(json.plan.length).toBeGreaterThan(0);
    expect(json.summary.creates).toBeGreaterThan(0);
    // collaborators is declared + non-empty in the fixture → must be SKIPPED, not silently dropped.
    expect(json.skipped_sections).toEqual([
      { section: 'collaborators', reason: 'reconcile not implemented in v1' },
    ]);
    // macf#838 Amendment D phase 2: CA is fully implemented now — a fresh
    // fleet with no `routing:` declared has NOTHING unimplemented.
    expect(json.unimplemented_by_apply).toEqual([]);
  });

  it('--json carries ONLY a diverging routing value under unimplemented_by_apply — the remaining honest gap (macf#838 Amendment D phase 2); runner_warm is fully implemented as of groundnuty/macf#943', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML_WITH_ROUTING);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => OBSERVED_ROUTING_DRIFT };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      unimplemented_by_apply: ReadonlyArray<{ kind: string; target: string; verb: string; reason: string }>;
    };
    expect(json.unimplemented_by_apply.length).toBe(1);
    expect(json.unimplemented_by_apply.map((i) => i.kind)).toEqual(['routing']);
    expect(json.unimplemented_by_apply[0]?.verb).toBe('update');
    expect(json.unimplemented_by_apply.some((i) => i.kind === 'ca')).toBe(false);
    expect(json.unimplemented_by_apply.some((i) => i.kind === 'runner_warm')).toBe(false);
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
    expect(out).toContain('collaborators: SKIPPED (reconcile not implemented in v1)');
    // macf#838 Amendment D phase 2: CA is fully implemented now and this
    // fixture declares no `routing:` — nothing is unimplemented.
    expect(out).not.toMatch(/NOT IMPLEMENTED BY APPLY/);
  });

  it('plain-text mode STILL renders the ⚠ NOT IMPLEMENTED BY APPLY block for a diverging routing value', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML_WITH_ROUTING);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => OBSERVED_ROUTING_DRIFT };
    const code = await runBootstrapPlan({ file }, deps);
    expect(code).toBe(0);

    const out = logSpy.mock.calls.flat().join('\n');
    // macf#854 — the plan text names the items apply has no code path for
    // yet (distinct wording from "SKIPPED" — see plan.ts's
    // formatUnimplementedLines doc).
    expect(out).toMatch(/NOT IMPLEMENTED BY APPLY/);
    expect(out).toContain('routing:icsoc-2026:runner');
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
        // groundnuty/macf#800 — 'absent', not 'present': apply no longer
        // writes a per-repo CA copy at all, so the genuinely-clean steady
        // state for this var is "was never written here," not "written and
        // matching." A 'present' per-repo copy is now an ORPHAN (superseded
        // write target) — the opposite of "nothing to do" this test's title
        // claims. See `plan.test.ts`'s dedicated "per-repo CA" describe
        // block for the full presence/verb table.
        caRepos: { 'groundnuty/icsoc-2026-experiment': 'absent' },
        routingClientRepos: { 'groundnuty/icsoc-2026-experiment': 'present' },
      }),
    };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { summary: { noops: number; creates: number; writeAlways: number } };
    // 4 per-agent (app, repo, install, secret_fingerprint) + 2 CA (registry
    // present + the one agent repo confirmed absent — both noop, since
    // apply has no per-repo CA write to attempt regardless) + 1
    // routing_client (observed-present) — all noop.
    // `labels` is a write-always structural exception (groundnuty/macf#920,
    // verb per groundnuty/macf#926): it has no plan-time observed read at
    // all, so it ALWAYS emits `write-always` — this is not "unclean," it's
    // a documented limitation (see `labelsItem`'s doc), and it's counted
    // SEPARATELY from `creates` (a `write-always` item was never verified
    // missing). `runner_ops` (groundnuty/macf#943) is absent entirely here
    // (groundnuty/macf#1083): `VALID_FLEET_YAML` declares no `routing:`
    // section, so this fleet needs no runner-ops App. `router_app`
    // (groundnuty/macf#1105) IS present here though — UNCONDITIONAL, and
    // this fixture's `lock: null` has no 'router' entry. `ts_oauth`
    // (groundnuty/macf#1109) is ALSO UNCONDITIONAL, and `deps.observe`'s
    // fixture above sets no `vaultTsOauth` — so `router_app` + `ts_oauth`
    // are the two create-candidates; `labels` is the one write-always item.
    expect(json.summary.noops).toBe(7);
    expect(json.summary.creates).toBe(2);
    expect(json.summary.writeAlways).toBe(1);
  });

  // DR-043 Amendment D phase 3 — proves the `--vault`/`--identity-key` CLI
  // flags actually reach the REAL `vaultAwareObserver` → `readVault` chain
  // THROUGH `resolveDeps` (production wiring), not a fake this suite
  // constructs by hand. Points both flags at nonexistent paths — no `age`
  // binary needed, no fake to get wrong — and asserts the resulting plan
  // carries an honest `[vault: unknown — ...]` fact, not a silently-vault-
  // free plan (which would mean the flags were plumbed nowhere) and not a
  // crash (which the observer's own degrade-to-unknown contract forbids).
  //
  // Calls `resolveDeps` DIRECTLY (exported only for this test) rather than
  // rebuilding its vault branch inline — the discriminator that matters is
  // "does breaking `resolveDeps`'s vault wiring fail this test," and only
  // calling the real function preserves that; a hand-rebuilt `observe`
  // would make this test pass even if `resolveDeps` itself were broken
  // (`assert-the-wrong-path.md` Trigger 1 — circularity). ONLY
  // `readAgentRegistry` is overridden on the result (groundnuty/macf#1203)
  // — this test's assertions are entirely about the vault fact, never
  // `advertise_host_drift`, and the REAL `readAgentRegistryInfo` makes its
  // own live `gh api` calls per agent that this environment's network
  // conditions can push past a 5s test timeout; faking just this one dep
  // keeps the test fast and deterministic without weakening what it
  // actually proves about `resolveDeps`'s vault branch.
  it('--vault + --identity-key reach the REAL vault-aware observer THROUGH resolveDeps, surfacing an honest [vault: unknown] fact for a nonexistent vault', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const vaultPath = join(dir, 'does-not-exist', 'vault.age');
    const identityKeyPath = join(dir, 'does-not-exist', 'identity.txt');
    const real = resolveDeps(file, vaultPath, identityKeyPath);
    const deps: BootstrapPlanDeps = {
      ...real,
      readAgentRegistry: async () => ({ status: 'unknown', reason: 'not queried in this test' }),
    };
    const code = await runBootstrapPlan({ file, json: true, vaultPath, identityKeyPath }, deps);
    expect(code).toBe(0); // a vault-read failure degrades to unknown; it does NOT fail the plan
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      plan: ReadonlyArray<{ kind: string; target: string; reason: string }>;
    };
    const agentSecrets = json.plan.find((i) => i.kind === 'secret_fingerprint');
    expect(agentSecrets?.reason).toContain('[vault: unknown —');
    expect(agentSecrets?.reason).toContain('vault file not found');
  });

  // groundnuty/macf#1220 — the SAME nonexistent-vault-path trick as the test
  // immediately above, now proving `install_scope_coverage` reaches the
  // REAL `computeInstallScopeCoverage` (never a hand-rebuilt fake). This is
  // the honest-unknown-BEFORE-any-network-I/O floor, not the decisive
  // drift/covered pair (that pair is `install-scope-coverage.test.ts`'s
  // job against the pure function directly) — here the point is only "the
  // CLI wiring reaches it and doesn't crash or silently drop it." Also half
  // of groundnuty/macf#1279's decisive pair: flags present -> `plan`'s
  // `install_scope_coverage` behaves EXACTLY as before that fix
  // (byte-identical AC) — the `message` assertion at the bottom pins that
  // this is NOT the new "not checked this run" wording (mirrors
  // `bootstrap-apply.test.ts`'s sibling test for the SAME decisive pair,
  // PR #1276).
  it('--vault + --identity-key: `install_scope_coverage` is populated (unknown, for a nonexistent vault) — never silently omitted once the flags are given', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const vaultPath = join(dir, 'does-not-exist', 'vault.age');
    const identityKeyPath = join(dir, 'does-not-exist', 'identity.txt');
    const real = resolveDeps(file, vaultPath, identityKeyPath);
    const deps: BootstrapPlanDeps = { ...real, readAgentRegistry: async () => ({ status: 'unknown', reason: 'not queried in this test' }) };
    const code = await runBootstrapPlan({ file, json: true, vaultPath, identityKeyPath }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      install_scope_coverage?: ReadonlyArray<{ role: string; status: string; message?: string }>;
    };
    // VALID_FLEET_YAML declares no `routing:` (no runner-ops needed) but a
    // `profile`-type registry, so the router App IS an unconditional target
    // (`routerAppItem`'s own doc) — exactly one entry, `'unknown'`.
    expect(json.install_scope_coverage).toHaveLength(1);
    expect(json.install_scope_coverage?.[0]?.status).toBe('unknown');
    expect(json.install_scope_coverage?.[0]?.message).toContain('vault could not be read');
    // NOT the groundnuty/macf#1279 "no --vault/--identity-key given" wording
    // — this run gave both flags, so the ONLY reason it's still 'unknown'
    // is the (deliberately) nonexistent vault path.
    expect(json.install_scope_coverage?.[0]?.message).not.toContain('no --vault/--identity-key given');
  });

  // groundnuty/macf#1279 — the defect: this call site used to short-circuit
  // to `{}` whenever EITHER flag was missing, discarding
  // `computeInstallScopeCoverage`'s own honest-unknown output regardless of
  // whether the fleet had anything to check. `VALID_FLEET_YAML`'s router
  // App target (see the sibling test above) means there IS something to
  // check here, so post-fix this must be POPULATED — the opposite of the
  // old test name. Other half of the decisive pair (per
  // `assert-the-wrong-path.md`): (1) alone (this test) would be satisfied
  // by an implementation that ALWAYS prints the notice regardless of the
  // flags — the sibling "byte-identical when flags present" test above is
  // what rules that out. Same wording `#1276` uses for the identical `apply`
  // fix, so the two surfaces do not drift apart.
  it('WITHOUT --vault/--identity-key, `install_scope_coverage` states the check was NOT run and names the flags to supply — --json', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => EMPTY_OBSERVED };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      install_scope_coverage?: ReadonlyArray<{ role: string; status: string; message?: string }>;
      plan: ReadonlyArray<{ kind: string }>;
    };
    expect(json.install_scope_coverage).toHaveLength(1);
    expect(json.install_scope_coverage?.[0]?.status).toBe('unknown');
    expect(json.install_scope_coverage?.[0]?.message).toContain('--vault');
    expect(json.install_scope_coverage?.[0]?.message).toContain('--identity-key');
    expect(json.install_scope_coverage?.[0]?.message).toContain('not checked this run');
    // `unknown` must never render as a `PlanItem` verb (`installScopeCoverageItem`
    // returns `undefined` for `'unknown'` — see its own doc). Regression
    // guard: an `'unknown'` entry silently becoming a fabricated verb would
    // be a WORSE bug than the one this issue fixes.
    expect(json.plan.some((i) => i.kind === 'install_scope')).toBe(false);
  });

  // groundnuty/macf#1279 — the SAME notice, non-`--json` render. `plan`'s
  // JSON path and text path both read from the SAME `installScopeCoverage`
  // value (`commands/bootstrap.ts`'s single call site) via
  // `formatInstallScopeCoverageLines`, so this pins that the human-readable
  // surface never drifts from the `--json` one.
  it('WITHOUT --vault/--identity-key, the SAME notice reaches the human (non-`--json`) render, naming both flags', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => EMPTY_OBSERVED };
    const code = await runBootstrapPlan({ file }, deps);
    expect(code).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('install-scope coverage was not checked this run');
    expect(out).toContain('--vault');
    expect(out).toContain('--identity-key');
  });

  // groundnuty/macf#1279 — the OTHER honest-silent case: a fleet that
  // declares NO fleet-level App at all (`registry.type: org`, no
  // `routing.runner`) makes `installScopeCoverageTargets` return ZERO
  // targets, so `computeInstallScopeCoverage` returns `{}` with ZERO I/O
  // even though it is now called unconditionally — "unconditional call"
  // must not mean "unconditional noise." Both `--json` and text stay silent
  // on this surface, same as a fleet with nothing to report today.
  it('a manifest declaring NO fleet-level App: `install_scope_coverage` stays silent — unconditional call is not unconditional noise', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML_NO_FLEET_APPS);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => EMPTY_OBSERVED };
    const jsonCode = await runBootstrapPlan({ file, json: true }, deps);
    expect(jsonCode).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as Record<string, unknown>;
    expect('install_scope_coverage' in json).toBe(false);
    logSpy.mockClear();
    const textCode = await runBootstrapPlan({ file }, deps);
    expect(textCode).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('install-scope-coverage');
  });

  it('--vault WITHOUT --identity-key: refused loud (vault_flags_incomplete), never silently vault-free', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file: '/does/not/matter.yaml', json: true, vaultPath: '/fake/vault.age' });
    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('vault_flags_incomplete');
    expect(json.error.message).toContain('--identity-key');
  });

  it('--identity-key WITHOUT --vault: refused loud (vault_flags_incomplete), never silently vault-free', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file: '/does/not/matter.yaml', json: true, identityKeyPath: '/fake/key.txt' });
    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('vault_flags_incomplete');
    expect(json.error.message).toContain('--vault');
  });

  it('the half-specified-flags refusal fires BEFORE the manifest-file check — an argument error, not a manifest error', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file: '/does/not/exist/fleet.yaml', json: true, vaultPath: '/fake/vault.age' });
    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { error: { code: string } };
    expect(json.error.code).toBe('vault_flags_incomplete'); // NOT manifest_not_found
  });

  it('WITHOUT --vault/--identity-key (the default), the plan carries no vault fact at all — vault-free stays vault-free', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => EMPTY_OBSERVED };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      plan: ReadonlyArray<{ kind: string; reason: string }>;
    };
    const agentSecrets = json.plan.find((i) => i.kind === 'secret_fingerprint');
    expect(agentSecrets?.reason).not.toContain('[vault:');
  });
});

// --- Operator interaction budget (groundnuty/macf#880) ---
//
// `VALID_FLEET_YAML` declares ONE agent (`code-agent`) and no `routing:`
// section — as of groundnuty/macf#1083 the runner-ops App is NOT NEEDED for
// a fleet that never declares `routing.runner.runs_on: self-hosted`. As of
// groundnuty/macf#1105 the router App IS always needed (UNCONDITIONAL — see
// `plan.ts::routerAppItem`'s doc), so this fixture's honest maximum is 2 Apps
// (the agent + the router App), not 1. The arithmetic-decisive fresh-2-agent
// and add-one-agent cases, plus the runner-ops/router-app conditional/
// unconditional-creation cases themselves, live in `plan.test.ts` against
// `baseManifest()`'s 2-agent fixture — this file only proves the CLI wiring
// (text render + `--json`), not the counting itself (the #1000 golden-path
// rule: one place derives the count, plan.ts).
describe('runBootstrapPlan — operator interaction budget (groundnuty/macf#880)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const dirs: string[] = [];

  afterEach(() => {
    logSpy?.mockRestore();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('fresh fleet, plain text: names the honest maximum (1 declared agent + the UNCONDITIONAL router App, no runner-ops — groundnuty/macf#1083) and points at --vault/--identity-key on apply', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file }, { observe: async () => EMPTY_OBSERVED });
    expect(code).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toMatch(/Operator interaction: up to 2 Apps to create/);
    expect(out).toContain('2 "Create GitHub App" clicks');
    expect(out).toContain('2 install flows');
    expect(out).toContain('macf bootstrap apply --vault');
    expect(out).toContain('may confirm some of these already exist and skip their gates');
  });

  it('fresh fleet, --json: carries operator_interaction with the same maximum + bound: "maximum"', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file, json: true }, { observe: async () => EMPTY_OBSERVED });
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      operator_interaction: { gate1_clicks: number; gate2_flows: number; bound: string };
    };
    expect(json.operator_interaction).toEqual({ gate1_clicks: 2, gate2_flows: 2, bound: 'maximum' });
  });

  it('--vault/--identity-key on PLAN ITSELF never tightens this number (only apply\'s confirm-before-create guard can, macf#913) — the maximum stays 2', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan(
      { file, json: true, vaultPath: '/fake/vault.age', identityKeyPath: '/fake/identity.txt' },
      { observe: async () => EMPTY_OBSERVED },
    );
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      operator_interaction: { gate1_clicks: number; gate2_flows: number; bound: string };
    };
    expect(json.operator_interaction).toEqual({ gate1_clicks: 2, gate2_flows: 2, bound: 'maximum' });
  });

  it('a fully-provisioned fleet (every app/runner-ops/router-App item already present): "none — no consent gates", bound: "exact", zero stated explicitly', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const observed: ObservedState = {
      lock: {
        schema_version: 1,
        fleet: 'icsoc-2026',
        agents: [
          { role: 'runner-ops', app_id: 'a', install_id: 'i' },
          // groundnuty/macf#1105 — the router App is UNCONDITIONAL, so a
          // genuinely "everything already present" fixture needs a lock
          // entry for it too; without one, `router_app` would be the one
          // remaining create-candidate.
          { role: 'router', app_id: 'r', install_id: 'ri' },
        ],
      },
      agents: { 'code-agent': { app: 'present', install: 'present', repo: 'present', fingerprints: {} } },
      caRegistry: 'unknown',
      caRepos: {},
      controlRepoPresence: 'absent',
    };
    const code = await runBootstrapPlan({ file, json: true }, { observe: async () => observed });
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { operator_interaction: { gate1_clicks: number; gate2_flows: number; bound: string } };
    expect(json.operator_interaction).toEqual({ gate1_clicks: 0, gate2_flows: 0, bound: 'exact' });

    logSpy.mockRestore();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const textCode = await runBootstrapPlan({ file }, { observe: async () => observed });
    expect(textCode).toBe(0);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Operator interaction: none — no consent gates this run.');
  });
});

describe('runBootstrapPlan — advertise-host drift (groundnuty/macf#1203)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const dirs: string[] = [];

  afterEach(() => {
    logSpy?.mockRestore();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('no readAgentRegistry injected (every pre-existing test\'s shape): reports unknown, never mismatch, and never throws', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => EMPTY_OBSERVED };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      advertise_host_drift: ReadonlyArray<{ role: string; status: string; reason?: string }>;
    };
    expect(json.advertise_host_drift).toEqual([
      {
        role: 'code-agent',
        declared_host: 'example.ts.net',
        status: 'unknown',
        registered_host: undefined,
        reason: 'registry not queried this run',
        unknown_kind: 'read-failed',
      },
    ]);
  });

  it('DECISIVE 1 — injected registry read diverging from declared advertise_host: reported as a mismatch, both --json and text', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    const deps: BootstrapPlanDeps = {
      observe: async () => EMPTY_OBSERVED,
      readAgentRegistry: async () => ({
        status: 'confirmed',
        presence: 'present',
        info: { host: 'wrong-host.ts.net', port: 8443, type: 'permanent', instance_id: 'i1', started: '2026-08-10T00:00:00.000Z' },
      }),
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const jsonCode = await runBootstrapPlan({ file, json: true }, deps);
    expect(jsonCode).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      advertise_host_drift: ReadonlyArray<{ role: string; status: string; registered_host?: string }>;
    };
    expect(json.advertise_host_drift).toHaveLength(1);
    expect(json.advertise_host_drift[0]?.status).toBe('mismatch');
    expect(json.advertise_host_drift[0]?.registered_host).toBe('wrong-host.ts.net');

    logSpy.mockRestore();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const textCode = await runBootstrapPlan({ file }, deps);
    expect(textCode).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('ADVERTISE-HOST');
    expect(out).toContain('MISMATCH');
    expect(out).not.toMatch(/\bmacf#\d+\b|\bDR-0\d{2}\b/);
  });

  it('DECISIVE 2 — injected registry read MATCHING declared advertise_host: not reported as a mismatch', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    const deps: BootstrapPlanDeps = {
      observe: async () => EMPTY_OBSERVED,
      readAgentRegistry: async () => ({
        status: 'confirmed',
        presence: 'present',
        info: { host: 'example.ts.net', port: 8443, type: 'permanent', instance_id: 'i1', started: '2026-08-10T00:00:00.000Z' },
      }),
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      advertise_host_drift: ReadonlyArray<{ status: string }>;
    };
    expect(json.advertise_host_drift[0]?.status).toBe('match');
    expect(json.advertise_host_drift[0]?.status).not.toBe('mismatch');
  });

  it('never-registered (confirmed absent): reports unknown, never mismatch — the honest-unknown floor for a fresh, not-yet-deployed fleet', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    const deps: BootstrapPlanDeps = {
      observe: async () => EMPTY_OBSERVED,
      readAgentRegistry: async () => ({ status: 'confirmed', presence: 'absent' }),
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      advertise_host_drift: ReadonlyArray<{ status: string }>;
    };
    expect(json.advertise_host_drift[0]?.status).toBe('unknown');
    expect(json.advertise_host_drift[0]?.status).not.toBe('mismatch');
  });

  it('this is a REPORT, not a plan item — the mismatch never appears among plan.items/summary (apply has no code path to converge it)', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    const deps: BootstrapPlanDeps = {
      observe: async () => EMPTY_OBSERVED,
      readAgentRegistry: async () => ({
        status: 'confirmed',
        presence: 'present',
        info: { host: 'wrong-host.ts.net', port: 8443, type: 'permanent', instance_id: 'i1', started: '2026-08-10T00:00:00.000Z' },
      }),
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      plan: ReadonlyArray<{ kind: string }>;
      unimplemented_by_apply: ReadonlyArray<{ kind: string }>;
    };
    expect(json.plan.some((i) => i.kind === 'advertise_host')).toBe(false);
    expect(json.unimplemented_by_apply.some((i) => i.kind === 'advertise_host')).toBe(false);
  });
});

describe('operatorInputProvenance (pure) — groundnuty/macf#1197: "plan states which keys it will need... the resolved source of each key is reportable"', () => {
  it('a manifest declaring NOTHING relevant reports zero keys', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(operatorInputProvenance(manifest, undefined, undefined)).toEqual([]);
  });

  it('a manifest declaring tailscale_oauth_required reports BOTH keys — "not supplied" when neither file/env has them', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML_WITH_TAILSCALE);
    const report = operatorInputProvenance(manifest, undefined, undefined);
    expect(report).toEqual([
      { key: 'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID', source: 'none' },
      { key: 'MACF_BOOTSTRAP_TS_OAUTH_SECRET', source: 'none' },
    ]);
  });

  it('reports the resolved SOURCE (never the value) once a file supplies a key', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML_WITH_TAILSCALE);
    const report = operatorInputProvenance(
      manifest,
      { MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID: 'SENTINEL-PLAN-VALUE' },
      { MACF_BOOTSTRAP_TS_OAUTH_SECRET: 'SENTINEL-PLAN-SCOPE-VALUE' },
    );
    expect(report).toEqual([
      { key: 'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID', source: 'fleet-file' },
      { key: 'MACF_BOOTSTRAP_TS_OAUTH_SECRET', source: 'scope-file' },
    ]);
  });

  it('a manifest declaring routing.runner (self-hosted) reports the runner token AND the platform endpoint', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML_WITH_ROUTING);
    const report = operatorInputProvenance(manifest, undefined, undefined);
    expect(report.map((r) => r.key)).toEqual(['MACF_RUNNER_PLATFORM_ENDPOINT', 'MACF_BOOTSTRAP_RUNNER_TOKEN']);
  });
});

describe('runBootstrapPlan — operator secrets file (groundnuty/macf#1197)', () => {
  const dirs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    logSpy?.mockRestore();
    errSpy?.mockRestore();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('--json output carries an operator_inputs section, never a value — only key + source', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML_WITH_TAILSCALE);
    dirs.push(dir);
    const secretsPath = join(dir, 'secrets.env');
    writeFileSync(secretsPath, 'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID=SENTINEL-PLAN-JSON-VALUE\n');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file, json: true, secretsFilePath: secretsPath }, { observe: async () => EMPTY_OBSERVED });
    expect(code).toBe(0);
    const rendered = logSpy.mock.calls.flat().join('');
    expect(rendered).not.toContain('SENTINEL-PLAN-JSON-VALUE');
    const json = JSON.parse(rendered) as { operator_inputs: ReadonlyArray<{ key: string; source: string }> };
    expect(json.operator_inputs).toEqual([
      { key: 'MACF_BOOTSTRAP_TS_OAUTH_CLIENT_ID', source: 'fleet-file' },
      { key: 'MACF_BOOTSTRAP_TS_OAUTH_SECRET', source: 'none' },
    ]);
  });

  it('a --secrets-file path that does not exist refuses loud, before the manifest is even parsed', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runBootstrapPlan({ file, secretsFilePath: join(dir, 'does-not-exist.env') });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('does-not-exist.env');
  });

  // groundnuty/macf#1238 — the `runner_platform` plan ITEM (rendered inside
  // `plan.items`, via `observer.ts::githubRegistryObserver` UNCHANGED) must
  // name the secrets file too, not just the separate `operator_inputs`
  // section above. The injected `observe` below calls the REAL
  // `resolveRunnerPlatformEndpointWithProvenance` with the SAME candidate
  // shape `observer.ts` actually passes — proving `runBootstrapPlan`
  // registered the file tier BEFORE `observe` ran, without re-implementing
  // `observer.ts`'s own gh-api reads.
  it('DECISIVE: a runner-platform endpoint supplied ONLY via the secrets file names the file in the plan ITEM too — not "not resolved", not "environment variable"', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML_WITH_ROUTING);
    dirs.push(dir);
    const secretsPath = join(dir, 'secrets.env');
    writeFileSync(secretsPath, 'MACF_RUNNER_PLATFORM_ENDPOINT=http://plan-secrets-host:8088\n');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = {
      observe: async () => ({
        ...EMPTY_OBSERVED,
        runnerPlatformEndpoint: resolveRunnerPlatformEndpointWithProvenance({ explicit: undefined, manifestValue: undefined, scopeValue: undefined }),
      }),
    };
    const code = await runBootstrapPlan({ file, json: true, secretsFilePath: secretsPath }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { plan: ReadonlyArray<{ kind: string; reason: string }> };
    const item = json.plan.find((i) => i.kind === 'runner_platform');
    expect(item?.reason).toContain('http://plan-secrets-host:8088');
    expect(item?.reason).toMatch(/per-fleet operator secrets file/i);
    expect(item?.reason).not.toMatch(/environment variable/i);
    expect(item?.reason).not.toMatch(/not resolved/i);
  });
});
