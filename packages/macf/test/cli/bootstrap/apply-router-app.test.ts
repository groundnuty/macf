/**
 * Tests for `apply-router-app.ts` — the routing App's PURE pieces
 * (groundnuty/macf#1074): role/permission set, manifest builder, handle
 * derivation, install-repo derivation, post-install validation. Mirrors
 * `apply-runner-ops.test.ts`'s shape for the sibling App. Orchestration
 * (when it's created, how its credential folds into the vault, the
 * six-secret publish) is exercised in `apply-fleet.test.ts` /
 * `apply-routing-secrets.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  ROUTER_APP_ROLE,
  ROUTER_APP_PERMISSIONS,
  ROUTER_APP_EVENTS,
  deriveRouterAppHandle,
  routerAppIdentityRequest,
  buildRouterAppManifest,
  routerAppInstallRepos,
  validateRouterAppInstall,
} from '../../../src/cli/bootstrap/apply-router-app.js';
import { plannedAppNames, checkAppNameLengths } from '../../../src/cli/bootstrap/apply-runner-ops.js';
import type { ConfirmedInstall } from '../../../src/cli/bootstrap/identity-confirm.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { RegistryConfig } from '@groundnuty/macf-core';

function manifestWithRegistry(fleetName: string, registry: RegistryConfig, roles: readonly string[] = ['code-agent']): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: fleetName },
    owner: { account: 'groundnuty', type: 'user', registry },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'], tailscale_oauth_required: false },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: roles.map((role) => ({ role, profile: 'x', repo: `groundnuty/${fleetName}-${role}`, deploy_path: '/x' })),
    trust: { ca: 'per-project', federated_cas: [] },
  };
}

describe('ROUTER_APP_ROLE / deriveRouterAppHandle', () => {
  it('role is the reserved "router" string, never declared in fleet.yaml agents[]', () => {
    expect(ROUTER_APP_ROLE).toBe('router');
  });

  it('handle is derived via the SAME deriveAppHandle convention every agent App / runner-ops uses — <fleet>-<role>', () => {
    expect(deriveRouterAppHandle('macf-experiment')).toBe('macf-experiment-router');
    expect(deriveRouterAppHandle('macf-experiment').length).toBeLessThanOrEqual(34);
  });

  it('macf#943 budget criterion: role length <= "science-agent" (13), so a new role never lowers the fleet-name ceiling', () => {
    expect(ROUTER_APP_ROLE.length).toBeLessThanOrEqual('science-agent'.length);
  });
});

describe('ROUTER_APP_PERMISSIONS — exactly two, read-only, matching agent-router.yml\'s own documentation', () => {
  it('is exactly {actions_variables:read, metadata:read}', () => {
    expect(ROUTER_APP_PERMISSIONS).toEqual({
      actions_variables: 'read',
      metadata: 'read',
    });
    expect(Object.keys(ROUTER_APP_PERMISSIONS)).toHaveLength(2);
  });

  it('carries NO DR-019 write-scoped or runner-ops permission — read-only, disjoint from both', () => {
    const values = Object.values(ROUTER_APP_PERMISSIONS);
    expect(values).not.toContain('write');
    expect(ROUTER_APP_PERMISSIONS['administration']).toBeUndefined();
    expect(ROUTER_APP_PERMISSIONS['issues']).toBeUndefined();
    expect(ROUTER_APP_PERMISSIONS['contents']).toBeUndefined();
  });
});

describe('ROUTER_APP_EVENTS — none', () => {
  it('is an empty array — this App never subscribes to coordination webhooks', () => {
    expect(ROUTER_APP_EVENTS).toEqual([]);
  });
});

describe('buildRouterAppManifest — reuses buildAppManifest, differently configured', () => {
  it('submits EXACTLY the two permissions, the derived handle as name, and empty events', () => {
    const manifest = buildRouterAppManifest('macf-experiment', 'http://127.0.0.1:9/callback');
    expect(manifest.name).toBe('macf-experiment-router');
    expect(manifest.default_permissions).toEqual({ actions_variables: 'read', metadata: 'read' });
    expect(Object.keys(manifest.default_permissions)).toHaveLength(2);
    expect(manifest.default_events).toEqual([]);
    expect(manifest.redirect_url).toBe('http://127.0.0.1:9/callback');
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toEqual({ url: 'https://example.com/webhook', active: false });
  });

  it('honors an explicit homepageUrl (e.g. the control repo) over the default', () => {
    const manifest = buildRouterAppManifest('macf-experiment', 'http://x/callback', 'https://github.com/groundnuty/macf-experiment-control');
    expect(manifest.url).toBe('https://github.com/groundnuty/macf-experiment-control');
  });
});

describe('routerAppIdentityRequest', () => {
  it('produces the IdentityRequest applyIdentity needs — role + permissions + events + installRepos, homepageUrl passed through', () => {
    const req = routerAppIdentityRequest(['groundnuty/groundnuty'], 'https://github.com/groundnuty/x-control');
    expect(req).toEqual({
      role: 'router',
      homepageUrl: 'https://github.com/groundnuty/x-control',
      permissions: ROUTER_APP_PERMISSIONS,
      events: ROUTER_APP_EVENTS,
      installRepos: ['groundnuty/groundnuty'],
    });
  });
});

describe('routerAppInstallRepos — the registry target, NEVER any agent repo', () => {
  it('profile registry resolves to <user>/<user> — NOT any declared agent repo', () => {
    const manifest = manifestWithRegistry('demo-fleet', { type: 'profile', user: 'groundnuty' }, ['code-agent']);
    expect(routerAppInstallRepos(manifest)).toEqual(['groundnuty/groundnuty']);
    // Sanity: the profile target is genuinely distinct from the agent's own repo.
    expect(routerAppInstallRepos(manifest)).not.toContain('groundnuty/demo-fleet-code-agent');
  });

  it('repo registry resolves to the declared owner/repo', () => {
    const manifest = manifestWithRegistry('demo-fleet', { type: 'repo', owner: 'groundnuty', repo: 'demo-fleet-control' });
    expect(routerAppInstallRepos(manifest)).toEqual(['groundnuty/demo-fleet-control']);
  });

  it('org registry resolves to an empty array — unreachable in practice (registry-scope-preflight refuses first) but answered honestly, not guessed', () => {
    const manifest = manifestWithRegistry('demo-fleet', { type: 'org', org: 'groundnuty' });
    expect(routerAppInstallRepos(manifest)).toEqual([]);
  });

  it('local registry resolves to an empty array — no GitHub App surface exists for DR-024 local mode', () => {
    const manifest = manifestWithRegistry('demo-fleet', { type: 'local', path: '/tmp/registry.json' });
    expect(routerAppInstallRepos(manifest)).toEqual([]);
  });

  it('always exactly ONE repo for profile/repo registries — never the fleet\'s whole agent-repo list', () => {
    const manifest = manifestWithRegistry('demo-fleet', { type: 'profile', user: 'groundnuty' }, ['code-agent', 'science-agent', 'writing-agent']);
    expect(routerAppInstallRepos(manifest)).toHaveLength(1);
  });
});

describe('validateRouterAppInstall — repository_selection scoped to the registry repo, NEVER "all"', () => {
  const base: ConfirmedInstall = { appId: '1', installId: '2', appSlug: 'x-router', accountLogin: 'groundnuty' };

  it('accepts "selected" — the only passing shape', () => {
    expect(validateRouterAppInstall({ ...base, repositorySelection: 'selected' })).toBeUndefined();
  });

  it('REFUSES "all"', () => {
    const reason = validateRouterAppInstall({ ...base, repositorySelection: 'all' });
    expect(reason).toBeDefined();
    expect(reason).toMatch(/repository_selection must be "selected"/);
    expect(reason).toMatch(/"all"/);
  });

  it('REFUSES a missing repository_selection (fails CLOSED, not merely "not all")', () => {
    const reason = validateRouterAppInstall(base);
    expect(reason).toBeDefined();
    expect(reason).toMatch(/not reported by GitHub/);
  });

  it('never mentions a credential — this function only ever sees a ConfirmedInstall, which carries none', () => {
    const reason = validateRouterAppInstall({ ...base, repositorySelection: 'all' });
    expect(reason).not.toMatch(/BEGIN.*PRIVATE KEY/);
  });
});

describe('plannedAppNames / checkAppNameLengths — router handle joins the SAME pre-flight the runner-ops handle uses (groundnuty/macf#1074)', () => {
  it('plannedAppNames includes the router handle alongside every agent + runner-ops handle', () => {
    const manifest = manifestWithRegistry('demo-fleet', { type: 'profile', user: 'groundnuty' }, ['code-agent']);
    expect(plannedAppNames(manifest)).toEqual(['demo-fleet-code-agent', 'demo-fleet-runner-ops', 'demo-fleet-router']);
  });

  it('checkAppNameLengths refuses when the ROUTER handle itself exceeds 34 chars', () => {
    // 'this-is-a-very-long-fleet-name' (31) + '-router' (7) = 38, over the cap —
    // and the runner-ops handle (31 + 11 = 42) is ALSO over, so assert containment,
    // not exclusivity (mirrors apply-runner-ops.test.ts's own pattern for this case).
    const manifest = manifestWithRegistry('this-is-a-very-long-fleet-name', { type: 'profile', user: 'groundnuty' }, ['code-agent']);
    const check = checkAppNameLengths(manifest);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.violations.map((v) => v.name)).toContain('this-is-a-very-long-fleet-name-router');
    }
  });

  it('checkAppNameLengths: ok for the documented live-fleet example (macf-experiment)', () => {
    const manifest = manifestWithRegistry('macf-experiment', { type: 'profile', user: 'groundnuty' }, ['code-agent']);
    const check = checkAppNameLengths(manifest);
    expect(check.ok).toBe(true);
  });
});
