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
 * it defaults to has no enforcement path yet, groundnuty/macf#943) — so these
 * fixtures now exercise TWO honest gaps, not one.
 */
const VALID_FLEET_YAML_WITH_ROUTING = VALID_FLEET_YAML.replace(
  'agents:\n',
  'routing:\n  runner:\n    runs_on: self-hosted\nagents:\n',
);
const OBSERVED_ROUTING_DRIFT: ObservedState = { ...EMPTY_OBSERVED, routingTrustedActors: 'github-hosted' };

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
    // macf#838 Amendment D phase 2: CA is fully implemented now — a fresh
    // fleet with no `routing:` declared has NOTHING unimplemented.
    expect(json.unimplemented_by_apply).toEqual([]);
  });

  it('--json ALSO carries a diverging routing value + the runner_warm posture under unimplemented_by_apply — the two remaining honest gaps (macf#838 Amendment D phase 2 + macf#942)', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML_WITH_ROUTING);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapPlanDeps = { observe: async () => OBSERVED_ROUTING_DRIFT };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      unimplemented_by_apply: ReadonlyArray<{ kind: string; target: string; verb: string; reason: string }>;
    };
    expect(json.unimplemented_by_apply.length).toBe(2);
    expect(json.unimplemented_by_apply.map((i) => i.kind)).toEqual(['routing', 'runner_warm']);
    expect(json.unimplemented_by_apply[0]?.verb).toBe('update');
    expect(json.unimplemented_by_apply[1]?.verb).toBe('create');
    expect(json.unimplemented_by_apply.some((i) => i.kind === 'ca')).toBe(false);
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
        caRepos: { 'groundnuty/icsoc-2026-experiment': 'present' },
        routingClientRepos: { 'groundnuty/icsoc-2026-experiment': 'present' },
      }),
    };
    const code = await runBootstrapPlan({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { summary: { noops: number; creates: number } };
    // 4 per-agent (app, repo, install, secret_fingerprint) + 2 CA (registry +
    // the one agent repo) + 1 routing_client (observed-present) — all noop.
    // `labels` is the one structural exception (groundnuty/macf#920): it has
    // no plan-time observed read at all, so it ALWAYS degrades to a
    // LOW-CONFIDENCE create-candidate — this is not "unclean," it's a
    // documented limitation (see `labelsItem`'s doc). `runner_ops`
    // (groundnuty/macf#943) is the SAME shape here: this fixture's
    // `observed.lock` is `null`, so the fleet-level runner-ops credential item can only
    // degrade to `unknown` -> `create`, alongside `labels`.
    expect(json.summary.noops).toBe(7);
    expect(json.summary.creates).toBe(2);
  });

  // DR-043 Amendment D phase 3 — proves the `--vault`/`--identity-key` CLI
  // flags actually reach the REAL `vaultAwareObserver` → `readVault` chain
  // (no injected `deps`, unlike every test above) rather than a fake this
  // suite constructs. Points both flags at nonexistent paths — no `age`
  // binary needed, no fake to get wrong — and asserts the resulting plan
  // carries an honest `[vault: unknown — ...]` fact, not a silently-vault-
  // free plan (which would mean the flags were plumbed nowhere) and not a
  // crash (which the observer's own degrade-to-unknown contract forbids).
  it('--vault + --identity-key (no injected deps) reach the REAL vault-aware observer and surface an honest [vault: unknown] fact for a nonexistent vault', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapPlan({
      file,
      json: true,
      vaultPath: join(dir, 'does-not-exist', 'vault.age'),
      identityKeyPath: join(dir, 'does-not-exist', 'identity.txt'),
    });
    expect(code).toBe(0); // a vault-read failure degrades to unknown; it does NOT fail the plan
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      plan: ReadonlyArray<{ kind: string; target: string; reason: string }>;
    };
    const agentSecrets = json.plan.find((i) => i.kind === 'secret_fingerprint');
    expect(agentSecrets?.reason).toContain('[vault: unknown —');
    expect(agentSecrets?.reason).toContain('vault file not found');
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
