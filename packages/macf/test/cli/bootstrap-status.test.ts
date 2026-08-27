/**
 * Tests for `macf bootstrap status` (groundnuty/macf#1017). Offline +
 * deterministic: both the observer and the registry read are injected (no
 * `gh` / network), mirroring `bootstrap.test.ts`'s conventions for
 * `runBootstrapPlan`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBootstrapStatus, type BootstrapStatusDeps } from '../../src/cli/commands/bootstrap-status.js';
import type { ObservedState } from '../../src/cli/bootstrap/plan.js';
import type { AgentRegistryObservation } from '../../src/cli/bootstrap/observer.js';
import { BOOTSTRAP_STATUS_JSON_SCHEMA_VERSION } from '../../src/cli/bootstrap/status.js';

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
`;

function writeManifest(text: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'macf-bootstrap-status-test-'));
  const file = join(dir, 'fleet.yaml');
  writeFileSync(file, text);
  return { dir, file };
}

const EMPTY_OBSERVED: ObservedState = { lock: null, agents: {}, caRegistry: 'unknown', caRepos: {}, controlRepoPresence: 'absent' };

const PRESENT_REGISTRY: AgentRegistryObservation = {
  status: 'confirmed',
  presence: 'present',
  info: { host: '100.64.0.1', port: 8443, type: 'permanent', instance_id: 'code-instance-1', started: '2026-08-10T00:00:00.000Z' },
};

describe('runBootstrapStatus', () => {
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
    const code = await runBootstrapStatus({ file: '/does/not/exist/fleet.yaml' });
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('a missing manifest file under --json: non-empty JSON {error} on stdout, nonzero exit (macf#830 lesson)', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapStatus({ file: '/does/not/exist/fleet.yaml', json: true });
    expect(code).toBe(1);
    const out = logSpy.mock.calls.flat().join('');
    expect(out.length).toBeGreaterThan(0);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('an invalid manifest (schema violation) under --json: non-empty JSON {error}, nonzero exit', async () => {
    const { dir, file } = writeManifest('apiVersion: macf/v0\nkind: Fleet\n');
    dirs.push(dir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapStatus({ file, json: true });
    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { error?: unknown };
    expect(json.error).toBeDefined();
  });

  it('an observer throw is caught + rendered as {error}, never propagates', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapStatusDeps = {
      observe: () => {
        throw new Error('boom');
      },
      readAgentRegistry: async () => ({ status: 'confirmed', presence: 'absent' }),
      readControlManifest: async () => undefined,
    };
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(1);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { error?: { message?: string } };
    expect(json.error?.message).toContain('boom');
  });

  it('a valid manifest + injected deps: exit 0, --json carries schema_version + fleet + per-agent provisioning AND registry facts', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const observed: ObservedState = {
      ...EMPTY_OBSERVED,
      agents: { 'code-agent': { app: 'present', appId: 'app-1', install: 'present', installId: 'install-1', repo: 'present', fingerprints: {} } },
    };
    const deps: BootstrapStatusDeps = {
      observe: async () => observed,
      readAgentRegistry: async () => PRESENT_REGISTRY,
      readControlManifest: async () => undefined,
    };
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(0);

    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      schema_version: number;
      fleet: string;
      agents: ReadonlyArray<{ role: string; appId?: string; registry: unknown }>;
    };
    expect(json.schema_version).toBe(BOOTSTRAP_STATUS_JSON_SCHEMA_VERSION);
    expect(json.fleet).toBe('icsoc-2026');
    expect(json.agents).toHaveLength(1);
    expect(json.agents[0]?.role).toBe('code-agent');
    expect(json.agents[0]?.appId).toBe('app-1');
    expect(json.agents[0]?.registry).toEqual(PRESENT_REGISTRY);
  });

  it('plain-text mode renders the human tables, including the observed host:port', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapStatusDeps = {
      observe: async () => EMPTY_OBSERVED,
      readAgentRegistry: async () => PRESENT_REGISTRY,
      readControlManifest: async () => undefined,
    };
    const code = await runBootstrapStatus({ file }, deps);
    expect(code).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('macf bootstrap status — icsoc-2026');
    expect(out).toContain('PROVISIONING');
    expect(out).toContain('RUNTIME');
    expect(out).toContain('100.64.0.1:8443');
    // Never computes/renders a diff — no create/update/noop verbs anywhere.
    expect(out).not.toMatch(/\bCREATE\b|\bUPDATE\b|\bNOOP\b/);
  });

  it('never calls readAgentRegistry for an agent not declared in the manifest', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readAgentRegistry = vi.fn(async () => PRESENT_REGISTRY);
    const deps: BootstrapStatusDeps = { observe: async () => EMPTY_OBSERVED, readAgentRegistry, readControlManifest: async () => undefined };
    await runBootstrapStatus({ file }, deps);
    expect(readAgentRegistry).toHaveBeenCalledTimes(1);
    expect(readAgentRegistry).toHaveBeenCalledWith(expect.objectContaining({ type: 'profile' }), 'icsoc-2026', 'code-agent');
  });

  it('--vault WITHOUT --identity-key: refused loud (vault_flags_incomplete), never silently vault-free', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapStatus({ file, vaultPath: '/tmp/vault.age' });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/vault/i);
  });

  it('--identity-key WITHOUT --vault: refused loud (vault_flags_incomplete)', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapStatus({ file, identityKeyPath: '/tmp/id.key' });
    expect(code).toBe(1);
  });

  it('the half-specified-flags refusal fires BEFORE the manifest-file check — an argument error, not a manifest error', async () => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapStatus({ file: '/does/not/exist/fleet.yaml', vaultPath: '/tmp/vault.age' });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).not.toContain('fleet manifest not found');
  });

  // groundnuty/macf#1220 — same shape as `bootstrap.test.ts`'s pair for
  // `runBootstrapPlan`: proves `install_scope_coverage` reaches the REAL
  // `computeInstallScopeCoverage` (not mocked out — only `observe` is
  // faked here, exactly as this file already fakes it for every other
  // test) when both flags are given, and is omitted entirely otherwise.
  it('--vault + --identity-key: `install_scope_coverage` is populated (unknown, for a nonexistent vault)', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const vaultPath = join(dir, 'does-not-exist', 'vault.age');
    const identityKeyPath = join(dir, 'does-not-exist', 'identity.txt');
    const deps: BootstrapStatusDeps = {
      observe: async () => EMPTY_OBSERVED,
      readAgentRegistry: async () => ({ status: 'unknown', reason: 'not queried in this test' }),
      readControlManifest: async () => undefined,
    };
    const code = await runBootstrapStatus({ file, json: true, vaultPath, identityKeyPath }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      install_scope_coverage?: ReadonlyArray<{ role: string; status: string; message?: string }>;
    };
    expect(json.install_scope_coverage).toHaveLength(1);
    expect(json.install_scope_coverage?.[0]?.status).toBe('unknown');
  });

  it('WITHOUT --vault/--identity-key, `install_scope_coverage` is omitted entirely', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapStatusDeps = {
      observe: async () => EMPTY_OBSERVED,
      readAgentRegistry: async () => ({ status: 'unknown', reason: 'not queried in this test' }),
      readControlManifest: async () => undefined,
    };
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as Record<string, unknown>;
    expect('install_scope_coverage' in json).toBe(false);
  });

  // groundnuty/macf#1249 — `control_repo_manifest_drift` is ALWAYS present
  // (unlike `install_scope_coverage`, which is omitted when there is
  // nothing to check): this check needs no `--vault`/`--identity-key` gate
  // (see `control-repo-manifest-drift.ts`'s module doc), so it runs on
  // every `status` invocation regardless of flags.
  it('a committed manifest that differs from the local one: `control_repo_manifest_drift` reports drift, naming the field', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const staleCommitted = VALID_FLEET_YAML.replace('advertise_host: example.ts.net', 'advertise_host: stale.ts.net');
    const deps: BootstrapStatusDeps = {
      observe: async () => ({ ...EMPTY_OBSERVED, controlRepoPresence: 'present' }),
      readAgentRegistry: async () => ({ status: 'unknown', reason: 'not queried in this test' }),
      readControlManifest: async () => staleCommitted,
    };
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      control_repo_manifest_drift?: { status: string; fields: ReadonlyArray<{ path: string }> };
    };
    expect(json.control_repo_manifest_drift?.status).toBe('drift');
    expect(json.control_repo_manifest_drift?.fields.map((f) => f.path)).toEqual(['network.advertise_host']);
  });

  it('an identical committed manifest: `control_repo_manifest_drift` reports clean, in both --json and plain-text mode', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapStatusDeps = {
      observe: async () => ({ ...EMPTY_OBSERVED, controlRepoPresence: 'present' }),
      readAgentRegistry: async () => ({ status: 'unknown', reason: 'not queried in this test' }),
      readControlManifest: async () => VALID_FLEET_YAML,
    };
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { control_repo_manifest_drift?: { status: string; fields: unknown[] } };
    expect(json.control_repo_manifest_drift?.status).toBe('clean');
    expect(json.control_repo_manifest_drift?.fields).toEqual([]);

    logSpy.mockClear();
    const textCode = await runBootstrapStatus({ file }, deps);
    expect(textCode).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('control-repo-manifest-drift');
  });

  it('control repo not confirmed present (the default `EMPTY_OBSERVED` fixture): `control_repo_manifest_drift` is unknown, never clean/drift', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: BootstrapStatusDeps = {
      observe: async () => EMPTY_OBSERVED, // controlRepoPresence: 'absent'
      readAgentRegistry: async () => ({ status: 'unknown', reason: 'not queried in this test' }),
      readControlManifest: async () => {
        throw new Error('must not be called — presence check short-circuits before any read');
      },
    };
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { control_repo_manifest_drift?: { status: string } };
    expect(json.control_repo_manifest_drift?.status).toBe('unknown');
  });
});

/**
 * groundnuty/macf#1203, science-agent's "option 4" ruling on the issue
 * thread: the pure comparison (`advertise-host-drift.ts`) and its rendering
 * through `computeBootstrapStatus` are already fixture-tested exhaustively
 * (`status.test.ts`'s "computeBootstrapStatus — advertise-host drift"
 * describe block covers the decisive pair, the honest-unknown floor, and
 * the port ruling against a HAND-BUILT registry map). What neither of those
 * files can prove is that `runBootstrapStatus` — the actual command
 * entrypoint — reaches that comparison AT ALL: `resolveDeps` wires
 * `readAgentRegistry: readAgentRegistryInfo` (the REAL, unmocked function,
 * `observer.ts`'s `gh`-shelling registry read) directly, and this suite
 * cannot invoke that function without a live registry — so instead it
 * proves the SEAM: the same `AgentRegistryObservation` shapes
 * `readAgentRegistryInfo` can produce, fed through the identical
 * `deps.readAgentRegistry` seam production code calls, surface correctly in
 * `runBootstrapStatus`'s own output.
 *
 * `PRESENT_REGISTRY` (top of this file, already used by three pre-existing
 * tests above) is exactly this "REAL_CALL_SHAPE" — the same idiom
 * `runner-platform.test.ts`'s `REAL_CALL_SHAPE` constant establishes for
 * groundnuty/macf#1238/#1244: a literal object typed against the REAL
 * production type (`AgentRegistryObservation`'s `'confirmed'`/`'present'`
 * member, which is exactly what `readAgentRegistryInfo` returns for a
 * successfully-parsed `AgentInfo`), not an invented shape a broken
 * implementation might accept but the real function never produces. Its
 * `host: '100.64.0.1'` already diverges from `VALID_FLEET_YAML`'s declared
 * `advertise_host: example.ts.net` — a mismatch shape was sitting in this
 * file's own fixture, unasserted, before this block existed (see the
 * "carries registry facts" test above, which checks `registry` but never
 * `advertiseHostDrift`).
 */
describe('runBootstrapStatus — advertise-host drift SEAM (groundnuty/macf#1203)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const dirs: string[] = [];

  afterEach(() => {
    logSpy?.mockRestore();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('DECISIVE 1 — a real-shaped registry read diverging from declared advertise_host reaches the render as a mismatch (--json AND text)', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    const deps: BootstrapStatusDeps = { observe: async () => EMPTY_OBSERVED, readAgentRegistry: async () => PRESENT_REGISTRY };

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const jsonCode = await runBootstrapStatus({ file, json: true }, deps);
    expect(jsonCode).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      agents: ReadonlyArray<{ advertiseHostDrift: { status: string; declaredHost: string; registeredHost?: string } }>;
    };
    expect(json.agents[0]?.advertiseHostDrift.status).toBe('mismatch');
    expect(json.agents[0]?.advertiseHostDrift.declaredHost).toBe('example.ts.net');
    expect(json.agents[0]?.advertiseHostDrift.registeredHost).toBe('100.64.0.1');

    logSpy.mockRestore();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const textCode = await runBootstrapStatus({ file }, deps);
    expect(textCode).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('ADVERTISE-HOST');
    expect(out).toContain('MISMATCH');
  });

  it('DECISIVE 2 — a real-shaped registry read MATCHING declared advertise_host reaches the render as a match, never a mismatch (proves the seam is not "always mismatch")', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    const matchingRegistry: AgentRegistryObservation = {
      ...PRESENT_REGISTRY,
      info: { ...PRESENT_REGISTRY.info, host: 'example.ts.net' },
    };
    const deps: BootstrapStatusDeps = { observe: async () => EMPTY_OBSERVED, readAgentRegistry: async () => matchingRegistry };

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { agents: ReadonlyArray<{ advertiseHostDrift: { status: string } }> };
    expect(json.agents[0]?.advertiseHostDrift.status).toBe('match');
    expect(json.agents[0]?.advertiseHostDrift.status).not.toBe('mismatch');

    logSpy.mockRestore();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const textCode = await runBootstrapStatus({ file }, deps);
    expect(textCode).toBe(0);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('ADVERTISE-HOST');
    expect(out).not.toContain('MISMATCH');
  });

  it('same host, different live port -> still a match at the seam — the port ruling (advertise-host-drift.ts\'s module doc) must hold through the REAL entrypoint, not only the pure comparison', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    const samehostDifferentPort: AgentRegistryObservation = {
      ...PRESENT_REGISTRY,
      info: { ...PRESENT_REGISTRY.info, host: 'example.ts.net', port: 51999 },
    };
    const deps: BootstrapStatusDeps = { observe: async () => EMPTY_OBSERVED, readAgentRegistry: async () => samehostDifferentPort };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as { agents: ReadonlyArray<{ advertiseHostDrift: { status: string } }> };
    expect(json.agents[0]?.advertiseHostDrift.status).toBe('match');
  });

  it('never-registered reaches the seam as unknown, never mismatch — the honest-unknown floor holds through the REAL entrypoint too', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    const deps: BootstrapStatusDeps = { observe: async () => EMPTY_OBSERVED, readAgentRegistry: async () => ({ status: 'confirmed', presence: 'absent' }) };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      agents: ReadonlyArray<{ advertiseHostDrift: { status: string; unknownKind?: string } }>;
    };
    expect(json.agents[0]?.advertiseHostDrift.status).toBe('unknown');
    expect(json.agents[0]?.advertiseHostDrift.status).not.toBe('mismatch');
    expect(json.agents[0]?.advertiseHostDrift.unknownKind).toBe('never-registered');
  });

  it('a registry-read FAILURE (status: unknown) reaches the seam as unknown, never mismatch — distinct unknownKind from never-registered', async () => {
    const { dir, file } = writeManifest(VALID_FLEET_YAML);
    dirs.push(dir);
    const deps: BootstrapStatusDeps = {
      observe: async () => EMPTY_OBSERVED,
      readAgentRegistry: async () => ({ status: 'unknown', reason: 'registry variable could not be read (network/auth/gh failure)' }),
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runBootstrapStatus({ file, json: true }, deps);
    expect(code).toBe(0);
    const json = JSON.parse(logSpy.mock.calls.flat().join('')) as {
      agents: ReadonlyArray<{ advertiseHostDrift: { status: string; unknownKind?: string } }>;
    };
    expect(json.agents[0]?.advertiseHostDrift.status).toBe('unknown');
    expect(json.agents[0]?.advertiseHostDrift.unknownKind).toBe('read-failed');
  });
});

describe('runBootstrapStatus — no-mutation guarantee (static import-shape assertion)', () => {
  // The cheapest durable form of "reading state must not mutate anything":
  // assert the two new modules import ONLY from a read-only allowlist —
  // never from any apply-side write/push/mint/destroy module. A test that
  // merely calls the command with injected fakes cannot prove this (the fake
  // deps hide whatever the PRODUCTION `resolveDeps` wiring would reach) —
  // this reads the actual source text instead.
  const READ_ONLY_ALLOWLIST = new Set([
    'node:fs',
    'node:path',
    '@groundnuty/macf-core',
    '../bootstrap/fleet-manifest.js',
    '../bootstrap/plan.js',
    '../bootstrap/observer.js',
    '../bootstrap/status.js',
    './fleet-manifest.js',
    './plan.js',
    './observer.js',
    './apply-runner-ops.js', // pure derivation only (RUNNER_OPS_ROLE / deriveRunnerOpsHandle) — see status.ts's import
    './vault-read.js',
    './advertise-host-drift.js', // pure comparison only (groundnuty/macf#1203) — no gh/network, see that module's doc
    '../commands/ps.js',
    '../bootstrap/install-scope-coverage.js', // groundnuty/macf#1220 — read-only: GET /repos/.../installation under an App JWT + a vault DECRYPT (read), no GitHub write; writeScratchPem/cleanupScratchPem are a LOCAL fs scratch file, never a mutation
    '../bootstrap/control-repo-manifest-drift.js', // groundnuty/macf#1249 — pure diff + a `readManifestFile` callback this file supplies; no I/O of its own
    '../bootstrap/control-repo.js', // groundnuty/macf#1249 — only `controlRepoFullName` (pure string derivation) + `realReadControlManifestFile` (GET /repos/.../contents/fleet.yaml, read-only) are used here; this module ALSO exports write-capable functions (`provisionControlRepo`, `realControlRepoCommitAndPush`) that this file never imports
  ]);

  function importSpecifiers(source: string): readonly string[] {
    const specs: string[] = [];
    const re = /from\s+'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (spec !== undefined) specs.push(spec);
    }
    return specs;
  }

  it('commands/bootstrap-status.ts imports only read-only modules', () => {
    const source = readFileSync(new URL('../../src/cli/commands/bootstrap-status.ts', import.meta.url), 'utf-8');
    for (const spec of importSpecifiers(source)) {
      expect(READ_ONLY_ALLOWLIST.has(spec), `unexpected import "${spec}" in commands/bootstrap-status.ts`).toBe(true);
    }
  });

  it('bootstrap/status.ts imports only read-only modules', () => {
    const source = readFileSync(new URL('../../src/cli/bootstrap/status.ts', import.meta.url), 'utf-8');
    for (const spec of importSpecifiers(source)) {
      expect(READ_ONLY_ALLOWLIST.has(spec), `unexpected import "${spec}" in bootstrap/status.ts`).toBe(true);
    }
  });

  it('neither file references any known write-capable function name', () => {
    const dangerous = [
      'writeVariable',
      'ensureVariable',
      'writeVault',
      'reencryptVault',
      'createRepo',
      'pushControlRepo',
      'recordFleetLock',
      'writeFleetLock',
      'applyIdentity',
      'settleVault',
      'publishTrustedActors',
      'publishCaCertLegs',
      'publishRoutingClientSecrets',
    ];
    const statusSrc = readFileSync(new URL('../../src/cli/bootstrap/status.ts', import.meta.url), 'utf-8');
    const cmdSrc = readFileSync(new URL('../../src/cli/commands/bootstrap-status.ts', import.meta.url), 'utf-8');
    for (const name of dangerous) {
      expect(statusSrc, `status.ts references "${name}"`).not.toContain(name);
      expect(cmdSrc, `bootstrap-status.ts references "${name}"`).not.toContain(name);
    }
  });
});
