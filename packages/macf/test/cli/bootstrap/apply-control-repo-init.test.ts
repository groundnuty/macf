/**
 * Tests for `apply-control-repo-init.ts` — the control-repo `repo-init` step
 * (groundnuty/macf#1057). `repoInit` is either the REAL `commands/repo-init.ts`
 * function run against a local scratch directory (no clone, no network for
 * the label step — see the `beforeEach` env-strip below, same convention as
 * `apply-repo-init.test.ts`), or an injected fake that records exactly what
 * it was called with.
 *
 * Per `assert-the-wrong-path.md`: the decisive test below asserts against a
 * 3-agent manifest that ALL THREE agents' labels are requested — a 1- or
 * 2-agent fixture cannot distinguish "every declared agent" from "the first
 * one" (a bug that ships only one label would still pass a weaker test).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyControlRepoInit,
  controlRepoCarriesRouter,
  controlRepoWorkflowAllowlisted,
  deriveRouterCarryingRepos,
  resolveControlRepoLabelTokenSource,
  CONTROL_REPO_AGENT_CONFIG_RELATIVE_PATH,
  CONTROL_REPO_WORKFLOW_RELATIVE_PATH,
} from '../../../src/cli/bootstrap/apply-control-repo-init.js';
import type { ControlRepoInitOutcome } from '../../../src/cli/bootstrap/apply-control-repo-init.js';
import type { RepoInitOptions, RepoInitResult } from '../../../src/cli/commands/repo-init.js';
import type { FleetAgent, FleetLock, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { CONTROL_REPO_COMMIT_ALLOWLIST } from '../../../src/cli/bootstrap/control-repo.js';

const THREE_AGENTS: readonly FleetAgent[] = [
  { role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/x' },
  { role: 'science-agent', profile: 'research', repo: 'groundnuty/demo-science', deploy_path: '/y' },
  { role: 'writing-agent', profile: 'writing', repo: 'groundnuty/demo-writing', deploy_path: '/z' },
];

function manifestWith(agents: readonly FleetAgent[]): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'demo-fleet' },
    // Immutable full tag (macf#797) so a real-`repoInit`-driven test never
    // makes a network call resolving a floating ref.
    versions: { macf: '0.2.56', actions: 'v3.4.1' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents,
  };
}

describe('controlRepoWorkflowAllowlisted', () => {
  it('reflects the LIVE CONTROL_REPO_COMMIT_ALLOWLIST array, not a hand-copied literal', () => {
    // Finding (#1057 review): today's allowlist is fleet.yaml/fleet.lock/
    // secrets/vault.age/.gitignore — the two paths repo-init writes for the
    // control repo are absent. This test pins the CURRENT gap so a future
    // PR that deliberately extends the allowlist gets a RED here (signal to
    // update the expectation), rather than a silent behavior change.
    expect(CONTROL_REPO_COMMIT_ALLOWLIST).toContain(CONTROL_REPO_WORKFLOW_RELATIVE_PATH);
    expect(CONTROL_REPO_COMMIT_ALLOWLIST).toContain(CONTROL_REPO_AGENT_CONFIG_RELATIVE_PATH);
    expect(controlRepoWorkflowAllowlisted()).toBe(true);
  });
});

describe('controlRepoCarriesRouter (groundnuty/macf#1071)', () => {
  it('written + allowlisted -> true (the control repo belongs in a router-carrying-repo publish set)', () => {
    const outcome: ControlRepoInitOutcome = {
      repo: 'groundnuty/demo-fleet-control',
      agents: ['code-agent'],
      status: 'written',
      labels: { status: 'ok', created: [], existed: [] },
      workflowAndConfigAllowlisted: true,
      labelsGoodEnough: true,
    };
    expect(controlRepoCarriesRouter(outcome)).toBe(true);
  });

  it('written but NOT allowlisted -> false (the write never actually gets committed/pushed)', () => {
    const outcome: ControlRepoInitOutcome = {
      repo: 'groundnuty/demo-fleet-control',
      agents: ['code-agent'],
      status: 'written',
      labels: { status: 'ok', created: [], existed: [] },
      workflowAndConfigAllowlisted: false,
      labelsGoodEnough: true,
    };
    expect(controlRepoCarriesRouter(outcome)).toBe(false);
  });

  it('failed -> false', () => {
    const outcome: ControlRepoInitOutcome = { repo: 'groundnuty/demo-fleet-control', agents: ['code-agent'], status: 'failed', reason: 'disk full' };
    expect(controlRepoCarriesRouter(outcome)).toBe(false);
  });

  it('skipped (aborted-run fallback shape) -> false', () => {
    expect(controlRepoCarriesRouter({ status: 'skipped' })).toBe(false);
  });
});

describe('deriveRouterCarryingRepos (groundnuty/macf#1071) — the decisive target-set derivation', () => {
  const CONTROL_REPO = { repo: 'groundnuty/demo-fleet-control' };
  const WRITTEN_ALLOWLISTED: ControlRepoInitOutcome = {
    repo: CONTROL_REPO.repo,
    agents: ['code-agent'],
    status: 'written',
    labels: { status: 'ok', created: [], existed: [] },
    workflowAndConfigAllowlisted: true,
    labelsGoodEnough: true,
  };

  // Per `assert-the-wrong-path.md`: asserting the RETURNED LIST's exact
  // membership — not merely that the function ran, or that its length grew
  // by one — is what distinguishes "the control repo specifically joined
  // the set" from "some unrelated string got appended." This is the exact
  // property #1071 reports broken: three agent-repo entries where four
  // (three agents + control) belong.
  it('DECISIVE — a fleet whose control repo carries the router has the control repo IN the target set, alongside every agent repo', () => {
    const agentRepos = ['groundnuty/demo-code', 'groundnuty/demo-science', 'groundnuty/demo-writing'];
    const result = deriveRouterCarryingRepos(agentRepos, CONTROL_REPO, WRITTEN_ALLOWLISTED);
    expect(result).toEqual([...agentRepos, 'groundnuty/demo-fleet-control']);
    expect(result).toContain('groundnuty/demo-fleet-control');
    expect(result).toHaveLength(4);
  });

  it('a fleet whose control repo does NOT carry the router (repo-init failed) does not get the control repo in the target set', () => {
    const agentRepos = ['groundnuty/demo-code'];
    const failed: ControlRepoInitOutcome = { repo: CONTROL_REPO.repo, agents: ['code-agent'], status: 'failed', reason: 'disk full' };
    const result = deriveRouterCarryingRepos(agentRepos, CONTROL_REPO, failed);
    expect(result).toEqual(agentRepos);
    expect(result).not.toContain('groundnuty/demo-fleet-control');
  });

  it('a fleet whose control repo wrote the workflow but it is not yet allowlisted for commit does not get it in the target set', () => {
    const agentRepos = ['groundnuty/demo-code'];
    const writtenNotAllowlisted: ControlRepoInitOutcome = { ...WRITTEN_ALLOWLISTED, workflowAndConfigAllowlisted: false };
    const result = deriveRouterCarryingRepos(agentRepos, CONTROL_REPO, writtenNotAllowlisted);
    expect(result).toEqual(agentRepos);
  });

  it('the aborted-run `{ status: "skipped" }` fallback shape does not get the control repo in the target set', () => {
    const agentRepos: readonly string[] = [];
    const result = deriveRouterCarryingRepos(agentRepos, CONTROL_REPO, { status: 'skipped' });
    expect(result).toEqual([]);
  });

  it('zero agent repos + a router-carrying control repo -> the target set is exactly [control repo]', () => {
    const result = deriveRouterCarryingRepos([], CONTROL_REPO, WRITTEN_ALLOWLISTED);
    expect(result).toEqual(['groundnuty/demo-fleet-control']);
  });
});

describe('applyControlRepoInit', () => {
  const dirs: string[] = [];
  // Same convention as apply-repo-init.test.ts / apply-fleet.test.ts: strip
  // ambient GH_TOKEN/APP_ID/etc so the REAL repoInit()'s label-creation step
  // degrades deterministically (no real GitHub API call) rather than picking
  // up whatever token happens to be in this shell's environment.
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['GH_TOKEN', 'APP_ID', 'INSTALL_ID', 'KEY_PATH']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const k of ['GH_TOKEN', 'APP_ID', 'INSTALL_ID', 'KEY_PATH']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-control-repo-init-test-'));
    dirs.push(dir);
    return dir;
  }

  it('DECISIVE — 3-agent manifest: repoInit is called with ALL three roles, not one (real repoInit, checked via written .github/agent-config.json)', async () => {
    const dir = scratchDir();
    const manifest = manifestWith(THREE_AGENTS);
    const outcome = await applyControlRepoInit(dir, manifest);

    // Assert via the REAL repoInit's actual written output — proves the
    // agent LIST reached repoInit, not just that repoInit was invoked once
    // (a call-count assertion alone cannot tell "1 agent" from "3 agents").
    const cfg = JSON.parse(readFileSync(join(dir, '.github', 'agent-config.json'), 'utf-8')) as { agents: Record<string, unknown> };
    expect(Object.keys(cfg.agents).sort()).toEqual(['code-agent', 'science-agent', 'writing-agent']);
    expect(existsSync(join(dir, '.github', 'workflows', 'agent-router.yml'))).toBe(true);

    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') return;
    expect(outcome.agents).toEqual(['code-agent', 'science-agent', 'writing-agent']);
    // No tokenSource supplied (see this module's "Token sourcing" doc) —
    // real repoInit's generateToken() degrades to skipped, deterministically,
    // thanks to the env-strip above. Same change-detector intent as the
    // `controlRepoWorkflowAllowlisted` describe block above: this pins
    // TODAY's gap (no token -> no labels on a Mac-side apply run) so a
    // future PR that threads a legitimate token source gets a RED here —
    // a prompt to update the expectation, not a silent behavior change.
    expect(outcome.labels).toEqual({ status: 'skipped', reason: expect.stringContaining('APP_ID') });
    // Reflects the CURRENT allowlist gap (see the `controlRepoWorkflowAllowlisted` describe block above).
    expect(outcome.workflowAndConfigAllowlisted).toBe(true);
    // groundnuty/macf#1221 — no tokenSource was supplied (nor resolvable —
    // this call passes no `opts` at all), so this is the honest "nothing
    // was ever attempted" gap, not a genuine failure: `labelsGoodEnough`
    // stays `true` even though `labels.status` is `'skipped'`.
    expect(outcome.labelsGoodEnough).toBe(true);
  });

  it('DECISIVE (fake repoInit) — the agents option string passed to repoInit is a comma-join of ALL three roles', async () => {
    const dir = scratchDir();
    const manifest = manifestWith(THREE_AGENTS);
    const seenOptions: RepoInitOptions[] = [];
    const outcome = await applyControlRepoInit(dir, manifest, {
      repoInit: async (_projectDir, opts) => {
        seenOptions.push(opts);
        return { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } };
      },
    });
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.agents).toBe('code-agent,science-agent,writing-agent');
    expect(seenOptions[0]?.repo).toBe('groundnuty/demo-fleet-control');
    expect(seenOptions[0]?.project).toBe('demo-fleet');
    expect(outcome.status).toBe('written');
    if (outcome.status === 'written') expect(outcome.labels.status).toBe('ok');
  });

  it('idempotent re-run: running twice does not duplicate the agent-config.json agent list or re-error', async () => {
    const dir = scratchDir();
    const manifest = manifestWith(THREE_AGENTS);
    const first = await applyControlRepoInit(dir, manifest);
    const second = await applyControlRepoInit(dir, manifest);
    expect(first.status).toBe('written');
    expect(second.status).toBe('written');
    const cfg = JSON.parse(readFileSync(join(dir, '.github', 'agent-config.json'), 'utf-8')) as { agents: Record<string, unknown> };
    // Still exactly 3 keys — patchAgentConfig merge-preserves, never appends
    // a duplicate entry for an agent already present (commands/repo-init.ts).
    expect(Object.keys(cfg.agents).sort()).toEqual(['code-agent', 'science-agent', 'writing-agent']);
    // The workflow file is NOT rewritten on the second run (writeFileSafe
    // skips an existing file without --force) — repo-init's own existing
    // idempotency, inherited here for free.
    const workflowPath = join(dir, '.github', 'workflows', 'agent-router.yml');
    expect(existsSync(workflowPath)).toBe(true);
  });

  it('local registry -> failed, no repoInit call attempted', async () => {
    const dir = scratchDir();
    const manifest: FleetManifest = {
      ...manifestWith(THREE_AGENTS),
      owner: { account: 'groundnuty', type: 'user', registry: { type: 'local', path: '/x' } },
    };
    let called = false;
    const outcome = await applyControlRepoInit(dir, manifest, {
      repoInit: async (): Promise<RepoInitResult> => {
        called = true;
        return { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } };
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/local registry/);
    expect(called).toBe(false);
  });

  it('repoInit throwing -> status failed, carries the underlying reason', async () => {
    const dir = scratchDir();
    const manifest = manifestWith(THREE_AGENTS);
    const outcome = await applyControlRepoInit(dir, manifest, {
      repoInit: async () => {
        throw new Error('disk full');
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toBe('disk full');
  });

  // --- groundnuty/macf#1221: tokenSource threading + labelsGoodEnough ---

  it('REGRESSION (the credential path itself) — a supplied tokenSource reaches repoInit unchanged (appId/installId/keyPath), not silently dropped', async () => {
    // This is the test that would have caught the original bug: apply-fleet.ts
    // resolved a tokenSource but apply-control-repo-init.ts never threaded it
    // into the repoInit() call. Asserts the SEAM the fix actually touches —
    // the options object the injected repoInit fake receives — not a proxy
    // for it.
    const dir = scratchDir();
    const manifest = manifestWith(THREE_AGENTS);
    const seenOptions: RepoInitOptions[] = [];
    const tokenSource = { appId: 'app-code-agent', installId: 'install-1', keyPath: '/vault/code-agent.pem' };
    await applyControlRepoInit(
      dir,
      manifest,
      {
        repoInit: async (_dir, opts) => {
          seenOptions.push(opts);
          return { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } };
        },
      },
      { tokenSource },
    );
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.tokenSource).toEqual(tokenSource);
  });

  it('no tokenSource supplied -> repoInit receives no tokenSource field at all (unchanged pre-#1221 shape)', async () => {
    const dir = scratchDir();
    const manifest = manifestWith(THREE_AGENTS);
    const seenOptions: RepoInitOptions[] = [];
    await applyControlRepoInit(dir, manifest, {
      repoInit: async (_dir, opts) => {
        seenOptions.push(opts);
        return { workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } };
      },
    });
    expect(seenOptions[0]?.tokenSource).toBeUndefined();
  });

  it('DECISIVE PAIR (1/2) — a tokenSource was supplied and labels still did not fully land -> labelsGoodEnough: false (a genuine failure, not the honest gap)', async () => {
    const dir = scratchDir();
    const manifest = manifestWith(THREE_AGENTS);
    const outcome = await applyControlRepoInit(
      dir,
      manifest,
      {
        repoInit: async () => ({
          workflow: 'created',
          config: 'created',
          labels: { status: 'skipped', reason: 'GitHub API 401 — revoked key' },
        }),
      },
      { tokenSource: { appId: 'a', installId: 'i', keyPath: '/k.pem' } },
    );
    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') return;
    expect(outcome.labelsGoodEnough).toBe(false);
  });

  it('DECISIVE PAIR (2/2) — a tokenSource was supplied and labels landed ok -> labelsGoodEnough: true, run unaffected', async () => {
    const dir = scratchDir();
    const manifest = manifestWith(THREE_AGENTS);
    const outcome = await applyControlRepoInit(
      dir,
      manifest,
      {
        repoInit: async () => ({ workflow: 'created', config: 'created', labels: { status: 'ok', created: ['code-agent'], existed: [] } }),
      },
      { tokenSource: { appId: 'a', installId: 'i', keyPath: '/k.pem' } },
    );
    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') return;
    expect(outcome.labelsGoodEnough).toBe(true);
  });

  it('a partial-failure with a tokenSource supplied is ALSO not good enough (not just a skipped mint)', async () => {
    const dir = scratchDir();
    const manifest = manifestWith(THREE_AGENTS);
    const outcome = await applyControlRepoInit(
      dir,
      manifest,
      {
        repoInit: async () => ({
          workflow: 'created',
          config: 'created',
          labels: { status: 'partial-failure', created: ['code-agent'], existed: [], failed: ['science-agent'] },
        }),
      },
      { tokenSource: { appId: 'a', installId: 'i', keyPath: '/k.pem' } },
    );
    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') return;
    expect(outcome.labelsGoodEnough).toBe(false);
  });
});

describe('resolveControlRepoLabelTokenSource (groundnuty/macf#1221) — pure', () => {
  const MANIFEST = manifestWith(THREE_AGENTS);

  it('priorLock is null (a genuinely first-ever provision) -> undefined, resolveKeyPath never consulted', () => {
    let called = false;
    const result = resolveControlRepoLabelTokenSource(MANIFEST, null, () => {
      called = true;
      return '/x.pem';
    });
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it('resolveKeyPath is undefined (no --vault/--identity-key this run) -> undefined', () => {
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    };
    expect(resolveControlRepoLabelTokenSource(MANIFEST, priorLock, undefined)).toBeUndefined();
  });

  it('no declared role has a prior lock entry -> undefined', () => {
    const priorLock: FleetLock = { schema_version: 1, fleet: 'demo-fleet', agents: [] };
    expect(resolveControlRepoLabelTokenSource(MANIFEST, priorLock, () => '/x.pem')).toBeUndefined();
  });

  it('the first declared role that resolves wins, in manifest declaration order — not necessarily priorLock array order', () => {
    // priorLock lists writing-agent first, but the manifest declares
    // code-agent first — the returned credential must be code-agent's.
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'writing-agent', app_id: 'app-writing-agent', install_id: 'install-3' },
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
      ],
    };
    const seenRoles: string[] = [];
    const result = resolveControlRepoLabelTokenSource(
      MANIFEST,
      priorLock,
      (role, appId) => {
        seenRoles.push(role);
        return `/vault/${appId}.pem`;
      },
      () => true,
    );
    expect(result).toEqual({ appId: 'app-code-agent', installId: 'install-1', keyPath: '/vault/app-code-agent.pem' });
    expect(seenRoles).toEqual(['code-agent']);
  });

  it('skips a role whose resolveKeyPath returns undefined (present in priorLock, but not in the vault) and tries the next declared role', () => {
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [
        { role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' },
        { role: 'science-agent', app_id: 'app-science-agent', install_id: 'install-2' },
      ],
    };
    const result = resolveControlRepoLabelTokenSource(
      MANIFEST,
      priorLock,
      (role) => (role === 'science-agent' ? '/vault/science-agent.pem' : undefined),
      () => true,
    );
    expect(result).toEqual({ appId: 'app-science-agent', installId: 'install-2', keyPath: '/vault/science-agent.pem' });
  });

  it('every declared role fails to resolve -> undefined (honest "nothing to try", not a thrown error)', () => {
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    };
    expect(resolveControlRepoLabelTokenSource(MANIFEST, priorLock, () => undefined)).toBeUndefined();
  });

  it('REGRESSION — a resolved keyPath that does not exist on disk is NOT a credential (default real existsSync, no fake exists injected)', () => {
    // No `exists` override here — this exercises the REAL `existsSync`
    // default, proving the guard fires for a path that genuinely isn't on
    // disk, not merely for a fake that always says "no."
    const priorLock: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
    };
    const result = resolveControlRepoLabelTokenSource(MANIFEST, priorLock, () => '/definitely/does/not/exist/x.pem');
    expect(result).toBeUndefined();
  });

  it('a resolved keyPath that DOES exist on disk (real file, real existsSync) IS a usable credential', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-control-repo-token-exists-test-'));
    try {
      const keyPath = join(dir, 'code-agent.pem');
      writeFileSync(keyPath, 'not a real PEM, just needs to exist for this check', 'utf-8');
      const priorLock: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [{ role: 'code-agent', app_id: 'app-code-agent', install_id: 'install-1' }],
      };
      const result = resolveControlRepoLabelTokenSource(MANIFEST, priorLock, () => keyPath);
      expect(result).toEqual({ appId: 'app-code-agent', installId: 'install-1', keyPath });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// No-App-installation-touched proof (structural, not a runtime assertion):
// `ControlRepoInitDeps` (apply-control-repo-init.ts) declares exactly ONE
// optional field, `repoInit?: typeof realRepoInit` — there is no dependency
// this function could be given that creates, installs, or mutates a GitHub
// App. Every test above passes either nothing (real `repoInit`, which itself
// only writes local files + calls the labels REST endpoint) or a fake
// `repoInit` — neither path has an install-capable seam to exercise. The
// executable half of this proof (that WIRING this step into `applyFleet`
// doesn't add any new identity/install call) lives in `apply-fleet.test.ts`'s
// "#1057" describe block, which spies on the identity deps directly.
