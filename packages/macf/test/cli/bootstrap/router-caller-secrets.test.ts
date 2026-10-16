import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { generateWorkflow } from '../../../src/cli/commands/repo-init.js';
import { extractCallerSecrets, evaluateCallerRoutingForm } from '../../../src/cli/bootstrap/router-caller-secrets.js';
import { computePlan, type ObservedState, type PlanItem } from '../../../src/cli/bootstrap/plan.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { classifyOrgSecretReach } from '../../../src/cli/bootstrap/observer.js';
import { callerSecretRewritesFromObserved, controlCallerSecretRewriteFromObserved } from '../../../src/cli/commands/bootstrap-apply.js';

const FOUR = ['MACF_ROUTING_APP_ID', 'MACF_ROUTING_APP_KEY', 'ROUTING_CLIENT_CERT', 'ROUTING_CLIENT_KEY'];
const TS = ['TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'];
const V3 = { project: 'demo', registryApiPath: '/users/groundnuty' };

/** The pre-fix generated caller: bundle only. */
function bundleOnlyCaller(): string {
  const full = generateWorkflow('v3.5.0', V3);
  return full.replace(/(MACF_ROUTING_BUNDLE: .*\n)(?: {6}[A-Z_]+: .*\n)+/, '$1');
}

function manifest(selfHosted: boolean): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'demo' },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: [] },
    defaults: { role_template: 'groundnuty/agentic-repo-template' },
    agents: [{ role: 'code-agent', repo: 'groundnuty/demo-code', deploy_path: '/x' }],
    ...(selfHosted ? { routing: { runner: { runs_on: 'self-hosted', warm: 1 } } } : {}),
  } as FleetManifest;
}

function observed(callerYaml: string | undefined, secrets: readonly string[] | 'unknown', org: readonly string[] | 'unknown' = []): ObservedState {
  return {
    lock: null,
    agents: {
      'code-agent': {
        app: 'present', appId: '1', install: 'present', installId: '2', repo: 'present', fingerprints: {},
        agentConfigRoles: ['code-agent'],
        callerSecrets: callerYaml === undefined ? undefined : extractCallerSecrets(callerYaml),
      },
    },
    caRegistry: 'present',
    caRepos: {},
    controlRepoPresence: 'absent',
    orgSecretRepos: {
      'groundnuty/demo-code': org === 'unknown' ? { status: 'unknown', reason: 'org read 403' } : { status: 'confirmed', names: new Set(org) },
    },
    routingSecretRepos: {
      'groundnuty/demo-code': secrets === 'unknown' ? { status: 'unknown', reason: 'listing failed' } : { status: 'confirmed', names: new Set(secrets) },
    },
  };
}

function row(items: readonly PlanItem[]): PlanItem {
  const r = items.find((i) => i.kind === 'router_caller_secrets');
  if (r === undefined) throw new Error('no router_caller_secrets row');
  return r;
}

describe('extractCallerSecrets', () => {
  it('reads the generated caller: bundle plus the six names', () => {
    const got = extractCallerSecrets(generateWorkflow('v3.5.0', V3));
    expect(got?.inherit).toBe(false);
    expect([...(got?.names ?? [])].sort()).toEqual(['MACF_ROUTING_BUNDLE', ...FOUR, ...TS].sort());
  });
  it('reads a bundle-only caller as exactly the bundle', () => {
    expect(extractCallerSecrets(bundleOnlyCaller())?.names).toEqual(['MACF_ROUTING_BUNDLE']);
    // the fixture really is YAML-valid and bundle-only
    expect(Object.keys((parseYaml(bundleOnlyCaller()) as { jobs: { route: { secrets: object } } }).jobs.route.secrets)).toEqual(['MACF_ROUTING_BUNDLE']);
  });
  it('reads secrets: inherit, and undefined when there is no router call', () => {
    expect(extractCallerSecrets(generateWorkflow('v1'))?.inherit).toBe(true);
    expect(extractCallerSecrets('name: x\n')).toBeUndefined();
  });

  const wrap = (body: string): string => `name: r\njobs:\n  route:\n${body}\n`;
  it('reads a secrets: block that comes BEFORE uses:', () => {
    const y = wrap(`    secrets:\n      MACF_ROUTING_BUNDLE: \${{ secrets.MACF_ROUTING_BUNDLE }}\n      ROUTING_CLIENT_CERT: x\n    with:\n      a: b\n    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.5.0`);
    expect(extractCallerSecrets(y)).toEqual({ inherit: false, names: ['MACF_ROUTING_BUNDLE', 'ROUTING_CLIENT_CERT'] });
  });
  it('reads secrets: inherit before uses:', () => {
    const y = wrap('    secrets: inherit\n    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.5.0');
    expect(extractCallerSecrets(y)).toEqual({ inherit: true, names: [] });
  });
  it('never attributes another job\'s secrets to the router job', () => {
    const before = 'name: r\njobs:\n  other:\n    uses: o/r/.github/workflows/x.yml@v1\n    secrets:\n      OTHER: y\n  route:\n    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.5.0\n';
    expect(extractCallerSecrets(before)).toEqual({ inherit: false, names: [] });
    const after = before + '  later:\n    secrets: inherit\n    uses: o/r/.github/workflows/z.yml@v1\n';
    expect(extractCallerSecrets(after)).toEqual({ inherit: false, names: [] });
    const beforeInherit = 'name: r\njobs:\n  other:\n    secrets: inherit\n    uses: o/r/.github/workflows/x.yml@v1\n  route:\n    uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.5.0\n';
    expect(extractCallerSecrets(beforeInherit)).toEqual({ inherit: false, names: [] });
  });
});

describe('router_caller_secrets plan row — decisive pair', () => {
  it('bundle-only caller + the four present + no bundle (self-hosted) → update naming the caller and the four; apply is told to rewrite', () => {
    const o = observed(bundleOnlyCaller(), FOUR);
    const r = row(computePlan(manifest(true), o).items);
    expect(r.verb).toBe('update');
    expect(r.reason).toContain('agent-router.yml');
    for (const n of FOUR) expect(r.reason).toContain(n);
    expect(r.reason).toContain('apply reconciles the caller');
    expect(callerSecretRewritesFromObserved(manifest(true), o)).toEqual({ 'code-agent': true });
  });

  it('both-forms caller + the four present (self-hosted) → noop, no rewrite', () => {
    const o = observed(generateWorkflow('v3.5.0', V3), FOUR);
    expect(row(computePlan(manifest(true), o).items).verb).toBe('noop');
    expect(callerSecretRewritesFromObserved(manifest(true), o)).toEqual({ 'code-agent': false });
  });

  it('hosted-runner repo missing the Tailscale pair → update naming the pair; a rewrite cannot fix it', () => {
    const o = observed(generateWorkflow('v3.5.0', V3), FOUR);
    const r = row(computePlan(manifest(false), o).items);
    expect(r.verb).toBe('update');
    expect(r.reason).toContain('TS_OAUTH_CLIENT_ID');
    expect(r.reason).toContain('TS_OAUTH_SECRET');
    expect(r.reason).toContain('apply cannot fix this by rewriting the caller');
    expect(callerSecretRewritesFromObserved(manifest(false), o)).toEqual({ 'code-agent': false });
  });

  it('bundle present and passed → noop even with no individual secrets', () => {
    expect(row(computePlan(manifest(true), observed(bundleOnlyCaller(), ['MACF_ROUTING_BUNDLE'])).items).verb).toBe('noop');
  });

  it('unreadable caller or unreadable secrets → create (low confidence), never noop', () => {
    for (const o of [observed(undefined, FOUR), observed(generateWorkflow('v3.5.0', V3), 'unknown')]) {
      const r = row(computePlan(manifest(true), o).items);
      expect(r.verb).toBe('create');
      expect(r.reason).toContain('LOW CONFIDENCE');
      expect(callerSecretRewritesFromObserved(manifest(true), o)).toEqual({ 'code-agent': false });
    }
  });
});

describe('org-level secrets and the control repo', () => {
  it('hosted repo: four at repo level + Tailscale pair ONLY at org level → noop', () => {
    const o = observed(generateWorkflow('v3.5.0', V3), FOUR, TS);
    expect(row(computePlan(manifest(false), o).items).verb).toBe('noop');
  });

  it('org-secrets read fails (403/404): the Tailscale pair is UNKNOWN, never missing', () => {
    const o = observed(generateWorkflow('v3.5.0', V3), FOUR, 'unknown');
    const r = row(computePlan(manifest(false), o).items);
    expect(r.verb).toBe('create');
    expect(r.reason).toContain('LOW CONFIDENCE');
    expect(r.reason).toContain('org-level');
    expect(r.reason).not.toContain('the repo has no secret named');
  });

  it('org read fails but the caller itself omits a held secret → still update (rewrite fixes it)', () => {
    const o = observed(bundleOnlyCaller(), FOUR, 'unknown');
    expect(row(computePlan(manifest(false), o).items).verb).toBe('update');
  });

  function controlObserved(caller: string | undefined, repo: readonly string[], org: readonly string[]): ObservedState {
    const base = observed(generateWorkflow('v3.5.0', V3), FOUR);
    return {
      ...base,
      controlRepoPresence: 'present',
      controlRepoCallerSecrets: caller === undefined ? undefined : extractCallerSecrets(caller),
      routingSecretRepos: { ...base.routingSecretRepos, 'groundnuty/demo-control': { status: 'confirmed', names: new Set(repo) } },
      orgSecretRepos: { ...base.orgSecretRepos, 'groundnuty/demo-control': { status: 'confirmed', names: new Set(org) } },
    };
  }
  const controlRow = (items: readonly PlanItem[]): PlanItem => {
    const r = items.find((i) => i.kind === 'router_caller_secrets' && i.target.startsWith('repo:'));
    if (r === undefined) throw new Error('no control row');
    return r;
  };

  it('control repo, live shape: bundle-only caller, four repo secrets, Tailscale pair at org → update + rewrite flagged (it runs hosted, so the pair is needed even in a self-hosted fleet)', () => {
    const o = controlObserved(bundleOnlyCaller(), FOUR, TS);
    const r = controlRow(computePlan(manifest(true), o).items);
    expect(r.target).toBe('repo:groundnuty/demo-control:router_caller_secrets');
    expect(r.verb).toBe('update');
    expect(controlCallerSecretRewriteFromObserved(manifest(true), o)).toBe(true);
  });

  it('control repo with a both-forms caller and the pair at org level → noop, no rewrite', () => {
    const o = controlObserved(generateWorkflow('v3.5.0', V3), FOUR, TS);
    expect(controlRow(computePlan(manifest(true), o).items).verb).toBe('noop');
    expect(controlCallerSecretRewriteFromObserved(manifest(true), o)).toBe(false);
  });

  it('no control row when the control repo is not confirmed present', () => {
    const o = { ...controlObserved(undefined, [], []), controlRepoPresence: 'absent' as const };
    expect(computePlan(manifest(true), o).items.some((i) => i.kind === 'router_caller_secrets' && i.target.startsWith('repo:'))).toBe(false);
  });
});

describe('evaluateCallerRoutingForm', () => {
  const have = { status: 'confirmed' as const, names: new Set(FOUR) };
  it('same-owner secrets: inherit passes everything the repo holds', () => {
    expect(evaluateCallerRoutingForm({ inherit: true, names: [] }, have, true, undefined, 'groundnuty').status).toBe('complete');
  });
  it('cross-owner secrets: inherit passes nothing → incomplete, rewrite fixes it', () => {
    const v = evaluateCallerRoutingForm({ inherit: true, names: [] }, have, true, undefined, 'macf-experiment');
    expect(v.status).toBe('incomplete');
    if (v.status === 'incomplete') {
      expect(v.callerRewriteFixes).toBe(true);
      expect(v.inheritCrossesOwner).toBe(true);
    }
  });
  it('plan row and rewrite flags name the cross-owner inherit', () => {
    const m = { ...manifest(true), owner: { account: 'macf-experiment', type: 'org', registry: { type: 'org', org: 'macf-experiment' } }, agents: [{ role: 'code-agent', repo: 'macf-experiment/demo-code', deploy_path: '/x' }] } as unknown as FleetManifest;
    const base = observed(generateWorkflow('v1'), FOUR);
    const o: ObservedState = {
      ...base,
      orgSecretRepos: { 'macf-experiment/demo-code': { status: 'confirmed', names: new Set() } },
      routingSecretRepos: { 'macf-experiment/demo-code': { status: 'confirmed', names: new Set(FOUR) } },
    };
    const r = row(computePlan(m, o).items);
    expect(r.verb).toBe('update');
    expect(r.reason).toContain('secrets: inherit');
    expect(r.reason).toContain('macf-experiment');
    expect(r.reason).toContain('apply reconciles the caller');
    expect(callerSecretRewritesFromObserved(m, o)).toEqual({ 'code-agent': true });
    const c: ObservedState = {
      ...o,
      controlRepoPresence: 'present',
      controlRepoCallerSecrets: extractCallerSecrets(generateWorkflow('v1')),
      routingSecretRepos: { ...o.routingSecretRepos, 'macf-experiment/demo-control': { status: 'confirmed', names: new Set(FOUR) } },
      orgSecretRepos: { ...o.orgSecretRepos, 'macf-experiment/demo-control': { status: 'confirmed', names: new Set(TS) } },
    };
    expect(controlCallerSecretRewriteFromObserved(m, c)).toBe(true);
  });
});

describe('org secrets reach a repo only if the repo can receive them (#1451)', () => {
  const REPO = 'groundnuty/demo-code';
  const caller = generateWorkflow('v3.5.0', V3);
  function planRow(repoNames: readonly string[], visibility: string, plan: string | undefined): { r: PlanItem; o: ObservedState } {
    const base = observed(caller, repoNames);
    const o: ObservedState = {
      ...base,
      orgSecretRepos: { [REPO]: classifyOrgSecretReach(new Set(TS), visibility, plan, REPO) },
    };
    return { r: row(computePlan(manifest(false), o).items), o };
  }

  it('private + free + pair only at org level → update, says the org secret does not reach the repo; no rewrite flagged', () => {
    const { r, o } = planRow(FOUR, 'private', 'free');
    expect(r.verb).toBe('update');
    expect(r.reason).toContain('the org secrets TS_OAUTH_CLIENT_ID, TS_OAUTH_SECRET do not reach groundnuty/demo-code');
    expect(r.reason).toContain('organisation secrets are not available to private repositories on the free plan');
    expect(r.reason).toContain('set it as a repository secret, or route this repo self-hosted');
    expect(r.reason).not.toContain('the repo has no secret named');
    expect(callerSecretRewritesFromObserved(manifest(false), o)).toEqual({ 'code-agent': false });
  });
  it('private + free + pair at repo level → noop', () => {
    expect(planRow([...FOUR, ...TS], 'private', 'free').r.verb).toBe('noop');
  });
  it('public + free + org-only → noop', () => {
    expect(planRow(FOUR, 'public', 'free').r.verb).toBe('noop');
  });
  it('private + plan absent (App token) → create, LOW CONFIDENCE, never noop', () => {
    const { r } = planRow(FOUR, 'private', undefined);
    expect(r.verb).toBe('create');
    expect(r.reason).toContain('LOW CONFIDENCE');
    expect(r.reason).toContain('org plan could not be read');
  });
  it('private + paid plan (team) + org-only → noop', () => {
    expect(planRow(FOUR, 'private', 'team').r.verb).toBe('noop');
  });
});
