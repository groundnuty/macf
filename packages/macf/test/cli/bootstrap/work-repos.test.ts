/** `work_repos:` — schema, routing set order, install scope, and plan rows. */
import { describe, it, expect } from 'vitest';
import { FleetManifestSchema, routerCarryingRepos, workRepos } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { installReposForIdentity } from '../../../src/cli/bootstrap/apply-agent.js';
import { RUNNER_OPS_ROLE } from '../../../src/cli/bootstrap/apply-runner-ops.js';
import { computeInstallScopeCoverage, installScopeCoverageTargets } from '../../../src/cli/bootstrap/install-scope-coverage.js';
import { computePlan, formatOperatorInteractionLine, installScopeWidenApps, operatorInteractionBudget } from '../../../src/cli/bootstrap/plan.js';
import type { ObservedState } from '../../../src/cli/bootstrap/plan.js';

const WORK = 'o/f-experiments';

function manifest(extra: Record<string, unknown> = {}): FleetManifest {
  return FleetManifestSchema.parse({
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'f' },
    versions: { macf: '0.2.75', actions: 'v3.5.0' },
    owner: { account: 'o', type: 'user', registry: { type: 'profile', user: 'o' } },
    network: { advertise_host: 'h.ts.net' },
    transport: { age_recipients: ['age1x'] },
    defaults: { role_template: 'o/t', app_manifest: 'dr-019' },
    agents: [
      { role: 'code-agent', profile: 'code', repo: 'o/f-code', deploy_path: '/x' },
      { role: 'science-agent', profile: 'research', repo: 'o/f-science', deploy_path: '/y' },
    ],
    ...extra,
  });
}

describe('work_repos schema', () => {
  it('accepts a valid list and exposes it through workRepos()', () => {
    const m = manifest({ work_repos: [WORK] });
    expect(workRepos(m)).toEqual([WORK]);
  });
  it('workRepos() is empty when the field is absent', () => {
    expect(workRepos(manifest())).toEqual([]);
  });
  const refusals: ReadonlyArray<readonly [string, string[]]> = [
    ['a duplicate', [WORK, WORK]],
    ['an entry equal to an agent repo', ['o/f-code']],
    ['an entry equal to the control repo', ['o/f-control']],
    ['an entry owned by another account', ['someone-else/f-experiments']],
  ];
  for (const [label, list] of refusals) {
    it(`refuses ${label}, naming work_repos`, () => {
      const r = FleetManifestSchema.safeParse({ ...rawManifest(), work_repos: list });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('work_repos');
    });
  }
  for (const bad of ['o', 'o/', '/x', 'a/b/c', 'o/ok name']) {
    it(`refuses the malformed entry "${bad}", naming work_repos and the entry`, () => {
      const r = FleetManifestSchema.safeParse({ ...rawManifest(), work_repos: [bad] });
      expect(r.success).toBe(false);
      const text = r.error?.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('\n') ?? '';
      expect(text).toContain('work_repos');
      expect(text).toContain(`"${bad}"`);
      expect(text).toContain('exactly owner/repo');
    });
  }
  it('explains why another owner is refused', () => {
    const r = FleetManifestSchema.safeParse({ ...rawManifest(), work_repos: ['x/y'] });
    expect(JSON.stringify(r.error?.issues)).toContain('a private GitHub App can only be installed on the account that owns it');
  });
});

function rawManifest(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifest())) as Record<string, unknown>;
}

describe('routerCarryingRepos order', () => {
  it('is agent repos, then work repos, then the control repo LAST', () => {
    const repos = routerCarryingRepos(manifest({ work_repos: [WORK, 'o/f-more'] }));
    expect(repos).toEqual(['o/f-code', 'o/f-science', WORK, 'o/f-more', 'o/f-control']);
    expect(repos.at(-1)).toBe('o/f-control');
  });
  it('is unchanged when no work repos are declared', () => {
    expect(routerCarryingRepos(manifest())).toEqual(['o/f-code', 'o/f-science', 'o/f-control']);
  });
});

describe('install scope', () => {
  const m = manifest({ work_repos: [WORK] });
  it('installReposForIdentity(role) includes the work repos, after the agent’s own repo', () => {
    expect(installReposForIdentity('code-agent', m)).toEqual(['o/f-code', WORK]);
  });
  it('runner-ops’ set includes the work repos too', () => {
    expect(installReposForIdentity(RUNNER_OPS_ROLE, m)).toEqual(['o/f-code', 'o/f-science', WORK]);
  });
  it('a fleet without work repos has no agent coverage targets', () => {
    expect(installScopeCoverageTargets(manifest()).map((t) => t.role)).not.toContain('code-agent');
  });
  it('every agent App becomes a coverage target when work repos are declared', () => {
    const roles = installScopeCoverageTargets(m).map((t) => t.role);
    expect(roles).toContain('code-agent');
    expect(roles).toContain('science-agent');
  });
  it('an existing agent install that lacks a work repo yields coverage drift for that App', async () => {
    const lock = {
      schema_version: 1 as const,
      fleet: 'f',
      agents: [{ role: 'code-agent', app_id: '11', install_id: '1' }],
    };
    const vaultRaw = { MACF_AGENT_F_CODE_AGENT_PRIVATE_KEY_B64: Buffer.from('PEM').toString('base64') };
    const entries = await computeInstallScopeCoverage(
      m,
      lock,
      { 'code-agent': 'present', 'science-agent': 'present' },
      'present',
      { vaultPath: '/v', identityPath: '/i' },
      {
        workRepoPresence: { [WORK]: 'present' },
        readVaultFn: async () => vaultRaw,
        // the App covers its own repo but not the work repo
        probeFn: async (_appId, _key, _owner, repo) => (repo === 'f-experiments' ? 'absent' : 'present'),
      },
    );
    const entry = entries['code-agent'];
    expect(entry?.status).toBe('drift');
    expect(entry?.missingRepos).toEqual([WORK]);
    expect(entry?.message).toContain(WORK);
  });
});

describe('plan rows', () => {
  const m = manifest({ work_repos: [WORK, 'o/f-more'], routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
  const secrets = { status: 'confirmed' as const, names: new Set<string>() };
  const observed: ObservedState = {
    lock: null,
    agents: {},
    caRegistry: 'unknown',
    caRepos: {},
    controlRepoPresence: 'unknown',
    routingSecretRepos: { [WORK]: secrets, 'o/f-more': secrets },
    orgSecretRepos: { [WORK]: secrets, 'o/f-more': secrets },
    workRepos: {
      [WORK]: { presence: 'present', callerReadable: true, callerRunsOn: 'self-hosted', trustedActors: undefined, runnerRegistered: 'absent' },
      'o/f-more': { presence: 'absent' },
    },
  };
  const items = computePlan(m, observed).items;
  const find = (target: string) => items.find((i) => i.target === target);

  it('has a repo row per work repo, NOOP when present and CREATE when absent', () => {
    expect(find(`work_repo:${WORK}:repo`)?.verb).toBe('noop');
    expect(find('work_repo:o/f-more:repo')?.verb).toBe('create');
  });
  it('has agent_config, caller-secrets and actions-pin rows per work repo', () => {
    for (const repo of [WORK, 'o/f-more']) {
      expect(find(`work_repo:${repo}:agent_config`)).toBeDefined();
      expect(find(`work_repo:${repo}:router_caller_secrets`)).toBeDefined();
      expect(find(`repo:${repo}:version:actions`)).toBeDefined();
    }
  });
  it('has its OWN runner + trusted-actors row per work repo, not folded into the representative row', () => {
    const a = find(`routing:f:work-runner:${WORK}`);
    const b = find('routing:f:work-runner:o/f-more');
    expect(a?.verb).toBe('update');
    expect(a?.reason).toContain(WORK);
    expect(a?.reason).toContain('no MACF_TRUSTED_ACTORS');
    expect(b).toBeDefined();
    expect(b?.reason).toContain('o/f-more');
    expect(a?.target).not.toBe(b?.target);
  });
  it('an archived work repo gives a confirmation-required update naming the revival, not only NOOP', () => {
    const archivedObserved: ObservedState = { ...observed, workRepos: { ...observed.workRepos, [WORK]: { ...observed.workRepos![WORK]!, archived: true } } };
    const row = computePlan(m, archivedObserved).items.find((i) => i.target === `work_repo:${WORK}:repo:archived`);
    expect(row).toMatchObject({ verb: 'update', confirm_required: true });
    expect(row?.reason).toContain('un-archive');
    expect(row?.reason).toContain(WORK);
    expect(find(`work_repo:${WORK}:repo:archived`)).toBeUndefined();
  });
  it('emits no work-repo rows when none are declared', () => {
    const none = computePlan(manifest(), { ...observed, workRepos: undefined }).items;
    expect(none.some((i) => i.target.startsWith('work_repo:') || i.target.includes(':work-runner:'))).toBe(false);
  });
});

describe('operator interaction line counts "Save" clicks', () => {
  const none = operatorInteractionBudget(0);
  const widen = {
    kind: 'install_scope' as const,
    target: 'runner-ops:install_scope:f-runner-ops',
    verb: 'update' as const,
    reason: 'x',
    confirm_required: true,
  };
  it('without an install-scope UPDATE the line is what it was', () => {
    expect(formatOperatorInteractionLine(none, installScopeWidenApps([{ ...widen, verb: 'noop' }]))).toBe('Operator interaction: none — no consent gates this run.');
    expect(formatOperatorInteractionLine(none)).toBe('Operator interaction: none — no consent gates this run.');
  });
  it('with one install-scope UPDATE it names the Save click and the App', () => {
    expect(formatOperatorInteractionLine(none, installScopeWidenApps([widen]))).toBe(
      'Operator interaction: none to create; 1 "Save" click to widen an existing install (f-runner-ops).',
    );
  });
  it('alongside creations it appends the Save clicks', () => {
    const line = formatOperatorInteractionLine(operatorInteractionBudget(1), ['a', 'b']);
    expect(line).toContain('1 App to create');
    expect(line).toContain('Also 2 "Save" clicks to widen existing installs (a, b).');
  });
});
