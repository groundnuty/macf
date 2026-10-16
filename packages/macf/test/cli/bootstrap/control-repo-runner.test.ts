/** groundnuty/macf#1446 — control repo runner-class plan row + schema + caller emission. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlRepoRunnerItem, extractRunnerRunsOnInput } from '../../../src/cli/bootstrap/control-repo-runner.js';
import { controlRepoSelfHosted, FleetManifestSchema } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { applyControlRepoInit } from '../../../src/cli/bootstrap/apply-control-repo-init.js';
import { computePlan } from '../../../src/cli/bootstrap/plan.js';
import type { ObservedState } from '../../../src/cli/bootstrap/plan.js';
import { callerSecretRewritesFromObserved, controlCallerSecretRewriteFromObserved } from '../../../src/cli/commands/bootstrap-apply.js';

const WANT = 'f-code-agent[bot]';
const ready = { callerRunsOn: 'self-hosted', callerReadable: true, trustedActors: WANT, runnerPresence: 'present' as const, runnerHandover: undefined, runnerDetail: undefined };

describe('controlRepoRunnerItem (#1446)', () => {
  it('declared + caller + trusted actors + runner all present -> noop', () => {
    expect(controlRepoRunnerItem('f', 'o/f-control', WANT, ready).verb).toBe('noop');
  });
  it('declared but the runner is missing -> reported, never noop, and says routing fails (no hosted fallback)', () => {
    const item = controlRepoRunnerItem('f', 'o/f-control', WANT, { ...ready, runnerPresence: 'absent' });
    expect(item.verb).toBe('update');
    expect(item.reason).toContain('no self-hosted runner is registered');
    expect(item.reason).toContain('does not fall back to a hosted runner');
  });
  it('declared but the caller lacks runner-runs-on, or the variable is absent, is each reported', () => {
    expect(controlRepoRunnerItem('f', 'o/c', WANT, { ...ready, callerRunsOn: undefined }).reason).toContain('does not pass "runner-runs-on: self-hosted"');
    const noVar = controlRepoRunnerItem('f', 'o/c', WANT, { ...ready, trustedActors: undefined });
    expect(noVar.verb).toBe('update');
    expect(noVar.reason).toContain('no MACF_TRUSTED_ACTORS');
  });
  it('extractRunnerRunsOnInput reads the value, not just the key', () => {
    expect(extractRunnerRunsOnInput('with:\n  project: x\n  runner-runs-on: ubuntu-latest\n')).toBe('ubuntu-latest');
    expect(extractRunnerRunsOnInput('with:\n  project: x\n')).toBeUndefined();
  });
});

function manifest(routing?: FleetManifest['routing']): FleetManifest {
  return {
    apiVersion: 'macf/v0', kind: 'Fleet', metadata: { name: 'f' },
    versions: { macf: '0.2.63', actions: 'v3.5.0' },
    owner: { account: 'o', type: 'user', registry: { type: 'profile', user: 'o' } },
    network: { advertise_host: 'h.ts.net' }, transport: { age_recipients: ['age1x'] },
    defaults: { role_template: 'o/t', app_manifest: 'dr-019' },
    agents: [{ role: 'code-agent', profile: 'code', repo: 'o/f-code', deploy_path: '/x' }],
    ...(routing !== undefined ? { routing } : {}),
  } as FleetManifest;
}
const SELF = { runner: { runs_on: 'self-hosted', warm: 1 } };

describe('manifest field (#1446)', () => {
  it('not declared (even with self-hosted agents) -> controlRepoSelfHosted false', () => {
    expect(controlRepoSelfHosted(manifest(SELF))).toBe(false);
    expect(controlRepoSelfHosted(manifest())).toBe(false);
    expect(controlRepoSelfHosted(manifest({ ...SELF, control_repo_runs_on: 'self-hosted' }))).toBe(true);
  });
  it('rejects control_repo_runs_on when routing.runner is not self-hosted', () => {
    const r = FleetManifestSchema.safeParse({ ...manifest({ runner: { runs_on: 'ubuntu-latest', warm: 1 }, control_repo_runs_on: 'self-hosted' }) });
    expect(r.success).toBe(false);
  });
});

describe('control caller emission (#1446)', () => {
  async function workflowFor(m: FleetManifest): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'ctl-runner-'));
    try {
      await applyControlRepoInit(dir, m);
      return readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it('declared -> caller passes runner-runs-on: self-hosted; not declared -> no such line even with self-hosted agents', async () => {
    expect(await workflowFor(manifest({ ...SELF, control_repo_runs_on: 'self-hosted' }))).toContain('runner-runs-on: self-hosted');
    expect(await workflowFor(manifest(SELF))).not.toContain('runner-runs-on');
  });
});

describe('plan rows (#1446)', () => {
  const observedBase = {
    lock: null, agents: {}, caRegistry: 'unknown' as const, caRepos: {},
    controlRepoPresence: 'present' as const,
    controlRepoCallerSecrets: { inherit: false, names: ['MACF_ROUTING_BUNDLE', 'MACF_ROUTING_APP_ID', 'MACF_ROUTING_APP_KEY', 'ROUTING_CLIENT_CERT', 'ROUTING_CLIENT_KEY'] },
    routingSecretRepos: { 'o/f-control': { status: 'confirmed' as const, names: new Set(['MACF_ROUTING_APP_ID', 'MACF_ROUTING_APP_KEY', 'ROUTING_CLIENT_CERT', 'ROUTING_CLIENT_KEY']) } },
    orgSecretRepos: { 'o/f-control': { status: 'confirmed' as const, names: new Set<string>() } },
  };
  const rows = (m: FleetManifest, extra = {}): { caller?: string; runner?: string } => {
    const items = computePlan(m, { ...observedBase, ...extra }).items;
    return {
      caller: items.find((i) => i.target === 'repo:o/f-control:router_caller_secrets')?.verb,
      runner: items.find((i) => i.target === 'routing:f:control-runner')?.verb,
    };
  };
  it('declared: control secrets row needs no Tailscale pair; runner row reports the gap', () => {
    const r = rows(manifest({ ...SELF, control_repo_runs_on: 'self-hosted' }));
    expect(r.caller).toBe('noop');
    expect(r.runner).toBe('update');
  });
  it('not declared: Tailscale pair still required of the control row; no runner row at all', () => {
    const r = rows(manifest(SELF));
    expect(r.caller).not.toBe('noop');
    expect(r.runner).toBeUndefined();
  });
});

describe('runner-input drift forces the caller rewrite (#1446 review P1)', () => {
  const COMPLETE = { inherit: false, names: ['MACF_ROUTING_BUNDLE', 'MACF_ROUTING_APP_ID', 'MACF_ROUTING_APP_KEY', 'ROUTING_CLIENT_CERT', 'ROUTING_CLIENT_KEY'] };
  const REPO_SECRETS = { status: 'confirmed' as const, names: new Set(['MACF_ROUTING_BUNDLE']) };
  const obs = (callerRunsOn: string | undefined, readable = true): ObservedState => ({
    lock: null, caRegistry: 'unknown', caRepos: {},
    agents: { 'code-agent': { app: 'present', appId: '1', install: 'present', installId: '2', repo: 'present', fingerprints: {}, callerSecrets: COMPLETE, ...(callerRunsOn !== undefined ? { callerRunsOn } : {}) } },
    controlRepoPresence: 'present', controlRepoCallerSecrets: COMPLETE, controlRepoCallerReadable: readable,
    ...(callerRunsOn !== undefined ? { controlRepoRunnerRunsOn: callerRunsOn } : {}),
    routingSecretRepos: { 'o/f-control': REPO_SECRETS, 'o/f-code': REPO_SECRETS },
    orgSecretRepos: { 'o/f-control': { status: 'confirmed', names: new Set() }, 'o/f-code': { status: 'confirmed', names: new Set() } },
  });
  const declared = manifest({ ...SELF, control_repo_runs_on: 'self-hosted' });

  it('hosted control caller + field declared + secrets complete -> rewrite forced', () => {
    expect(controlCallerSecretRewriteFromObserved(declared, obs(undefined))).toBe(true);
    expect(controlCallerSecretRewriteFromObserved(declared, obs('ubuntu-latest'))).toBe(true);
  });
  it('caller already self-hosted -> no force from this predicate', () => {
    expect(controlCallerSecretRewriteFromObserved(declared, obs('self-hosted'))).toBe(false);
  });
  it('field not declared -> no force, whatever the caller says', () => {
    expect(controlCallerSecretRewriteFromObserved(manifest(SELF), obs('ubuntu-latest'))).toBe(false);
  });
  it('unreadable caller -> no force (nothing observed to compare)', () => {
    expect(controlCallerSecretRewriteFromObserved(declared, obs(undefined, false))).toBe(false);
  });
  it('DECISIVE — existing hosted caller on disk: the observed-state flag drives repoInit force and the rewrite lands runner-runs-on: self-hosted (unforced it does not)', async () => {
    const wf = (d: string): string => readFileSync(join(d, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    const dir = mkdtempSync(join(tmpdir(), 'ctl-drift-'));
    try {
      await applyControlRepoInit(dir, manifest(SELF)); // the installed hosted caller
      expect(wf(dir)).not.toContain('runner-runs-on');
      const flag = controlCallerSecretRewriteFromObserved(declared, obs(undefined));
      expect(flag).toBe(true);
      await applyControlRepoInit(dir, declared, undefined, { actionsVersion: 'v3.5.0', force: false });
      expect(wf(dir)).not.toContain('runner-runs-on'); // repoInit skips an existing file — the bug
      await applyControlRepoInit(dir, declared, undefined, { actionsVersion: 'v3.5.0', force: flag });
      expect(wf(dir)).toContain('runner-runs-on: self-hosted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('agent repos: self-hosted declared + caller without the input -> rewrite; already self-hosted or undeclared -> none', () => {
    const agentDeclared = manifest(SELF);
    expect(callerSecretRewritesFromObserved(agentDeclared, obs(undefined))).toEqual({ 'code-agent': true });
    expect(callerSecretRewritesFromObserved(agentDeclared, obs('self-hosted'))).toEqual({ 'code-agent': false });
    expect(callerSecretRewritesFromObserved(manifest(), obs(undefined))).toEqual({ 'code-agent': false });
  });
});
