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
    const deps: BootstrapStatusDeps = { observe: async () => EMPTY_OBSERVED, readAgentRegistry };
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
    '../commands/ps.js',
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
