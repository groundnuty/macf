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
  resolveSharedRouterAppReuse,
  routerAppNameCollisionMessage,
  resolveRouterAppSecretsForPublish,
} from '../../../src/cli/bootstrap/apply-router-app.js';
import type { SharedRouterAppReuseDeps } from '../../../src/cli/bootstrap/apply-router-app.js';
import { plannedAppNames, checkAppNameLengths } from '../../../src/cli/bootstrap/apply-runner-ops.js';
import type { ConfirmedInstall } from '../../../src/cli/bootstrap/identity-confirm.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { RegistryConfig } from '@groundnuty/macf-core';

/**
 * `router_app_scope: 'per-fleet'` (groundnuty/macf#1082) pins every test in
 * THIS file that doesn't care about scope (routerAppInstallRepos,
 * validateRouterAppInstall, plannedAppNames/checkAppNameLengths) to the
 * pre-#1082 fleet-derived handle, so their existing assertions stay
 * byte-identical under the new 'shared' default. The dedicated
 * `resolveSharedRouterAppReuse` / `deriveRouterAppHandle(..., 'shared')`
 * describe blocks below construct their own scope-specific manifests
 * directly.
 */
function manifestWithRegistry(fleetName: string, registry: RegistryConfig, roles: readonly string[] = ['code-agent']): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: fleetName },
    owner: { account: 'groundnuty', type: 'user', registry },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'], tailscale_oauth_required: false, router_app_scope: 'per-fleet' },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: roles.map((role) => ({ role, profile: 'x', repo: `groundnuty/${fleetName}-${role}`, deploy_path: '/x' })),
    trust: { ca: 'per-project', federated_cas: [] },
  };
}

describe('ROUTER_APP_ROLE / deriveRouterAppHandle', () => {
  it('role is the reserved "router" string, never declared in fleet.yaml agents[]', () => {
    expect(ROUTER_APP_ROLE).toBe('router');
  });

  it('per-fleet scope: handle is derived via the SAME deriveAppHandle convention every agent App / runner-ops uses — <fleet>-<role>, ownerAccount unused', () => {
    expect(deriveRouterAppHandle('macf-experiment', 'groundnuty', 'per-fleet')).toBe('macf-experiment-router');
    expect(deriveRouterAppHandle('macf-experiment', 'groundnuty', 'per-fleet').length).toBeLessThanOrEqual(34);
    // ownerAccount is genuinely unused on this branch — a different owner produces the SAME handle.
    expect(deriveRouterAppHandle('macf-experiment', 'a-totally-different-owner', 'per-fleet')).toBe('macf-experiment-router');
  });

  it('shared scope (groundnuty/macf#1088): handle is keyed on ownerAccount via the SAME <x>-<role> convention, fleetName unused', () => {
    expect(deriveRouterAppHandle('macf-experiment', 'groundnuty', 'shared')).toBe('groundnuty-router');
    expect(deriveRouterAppHandle('a-totally-different-fleet', 'groundnuty', 'shared')).toBe('groundnuty-router');
  });

  it('THE DECISIVE TEST (groundnuty/macf#1088): two manifests differing ONLY in owner resolve to DIFFERENT shared handles — asserted by the resolved handle itself, not by "a lookup happened"', () => {
    const orgScopeHandle = deriveRouterAppHandle('macf-experiment', 'macf-experiment', 'shared');
    const personalScopeHandle = deriveRouterAppHandle('macf-experiment', 'groundnuty', 'shared');
    expect(orgScopeHandle).toBe('macf-experiment-router');
    expect(personalScopeHandle).toBe('groundnuty-router');
    expect(orgScopeHandle).not.toBe(personalScopeHandle);
  });

  it('groundnuty/macf#1088: within ONE owner, two DIFFERENT fleets resolve to the SAME shared handle — the #1086 reuse saving survives the owner-keying', () => {
    const fleetOneHandle = deriveRouterAppHandle('fleet-one', 'macf-experiment', 'shared');
    const fleetTwoHandle = deriveRouterAppHandle('fleet-two', 'macf-experiment', 'shared');
    expect(fleetOneHandle).toBe(fleetTwoHandle);
    expect(fleetOneHandle).toBe('macf-experiment-router');
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
    const manifest = buildRouterAppManifest('macf-experiment', 'groundnuty', 'http://127.0.0.1:9/callback');
    expect(manifest.name).toBe('macf-experiment-router');
    expect(manifest.default_permissions).toEqual({ actions_variables: 'read', metadata: 'read' });
    expect(Object.keys(manifest.default_permissions)).toHaveLength(2);
    expect(manifest.default_events).toEqual([]);
    expect(manifest.redirect_url).toBe('http://127.0.0.1:9/callback');
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toEqual({ url: 'https://example.com/webhook', active: false });
  });

  it('honors an explicit homepageUrl (e.g. the control repo) over the default', () => {
    const manifest = buildRouterAppManifest('macf-experiment', 'groundnuty', 'http://x/callback', 'https://github.com/groundnuty/macf-experiment-control');
    expect(manifest.url).toBe('https://github.com/groundnuty/macf-experiment-control');
  });

  it('groundnuty/macf#1082: scope defaults to per-fleet — every pre-#1082 call site keeps the fleet-derived name unchanged', () => {
    const manifest = buildRouterAppManifest('macf-experiment', 'groundnuty', 'http://x/callback');
    expect(manifest.name).toBe('macf-experiment-router');
  });

  it('groundnuty/macf#1088: scope "shared" submits the OWNER-keyed handle as name, not the fleet-derived one', () => {
    const manifest = buildRouterAppManifest('macf-experiment', 'groundnuty', 'http://x/callback', undefined, 'shared');
    expect(manifest.name).toBe('groundnuty-router');
    expect(manifest.name).not.toContain('macf-experiment');
  });

  it('THE DECISIVE TEST (groundnuty/macf#1088): the SAME fleet under two DIFFERENT owners submits two DIFFERENT App-manifest names for the shared scope', () => {
    const orgManifest = buildRouterAppManifest('macf-experiment', 'macf-experiment', 'http://x/callback', undefined, 'shared');
    const personalManifest = buildRouterAppManifest('macf-experiment', 'groundnuty', 'http://x/callback', undefined, 'shared');
    expect(orgManifest.name).toBe('macf-experiment-router');
    expect(personalManifest.name).toBe('groundnuty-router');
    expect(orgManifest.name).not.toBe(personalManifest.name);
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
    // handleOverride omitted -> undefined, `toEqual` treats it as absent.
    expect(req.handleOverride).toBeUndefined();
  });

  it('groundnuty/macf#1082: threads an explicit handleOverride through (the shared-scope create path)', () => {
    const ownerKeyedHandle = deriveRouterAppHandle('macf-experiment', 'groundnuty', 'shared');
    const req = routerAppIdentityRequest(['groundnuty/groundnuty'], undefined, ownerKeyedHandle);
    expect(req.handleOverride).toBe(ownerKeyedHandle);
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

// --- groundnuty/macf#1082 — shared-scope reuse decision ---

const OWNER: FleetManifest['owner'] = { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } };
/**
 * `resolveSharedRouterAppReuse` doesn't derive a handle itself — it takes
 * one as a parameter (groundnuty/macf#1088: the derivation lives entirely
 * in `deriveRouterAppHandle`, tested above). The tests below exercise
 * reuse/collision/vault-priority LOGIC, which is handle-value-agnostic; this
 * is the real handle `deriveRouterAppHandle` would compute for `OWNER`, used
 * consistently so these tests stay representative of production.
 */
const HANDLE = deriveRouterAppHandle('irrelevant-fleet-name', OWNER.account, 'shared');

describe('resolveSharedRouterAppReuse — vault first, name-collision second, never throws', () => {
  it('THE DECISIVE TEST: vault carries id+key -> "reuse", and checkAppNameCollision is NEVER called (per assert-the-wrong-path.md: a throwing fake, not a call-count)', async () => {
    const decision = await resolveSharedRouterAppReuse(OWNER, HANDLE, {
      readVaultRouterApp: async () => ({ appId: '9001', appKeyPem: 'SENTINEL-SHARED-PEM' }),
      checkAppNameCollision: async () => {
        throw new Error('must not be called — a vault hit resolves reuse without ever asking GitHub about the name');
      },
    });
    expect(decision).toEqual({ kind: 'reuse', appId: '9001' });
  });

  it('decision carries only the non-secret appId — the PEM never appears anywhere in the returned decision', async () => {
    const decision = await resolveSharedRouterAppReuse(OWNER, HANDLE, {
      readVaultRouterApp: async () => ({ appId: '9001', appKeyPem: 'SENTINEL-SHARED-PEM-MUST-NOT-LEAK' }),
    });
    expect(JSON.stringify(decision)).not.toContain('SENTINEL-SHARED-PEM-MUST-NOT-LEAK');
  });

  it('empty vault (readVaultRouterApp undefined) + name confirmed FREE -> "create" (the non-regression: an empty vault still creates)', async () => {
    let collisionCalls = 0;
    const decision = await resolveSharedRouterAppReuse(OWNER, HANDLE, {
      checkAppNameCollision: async () => {
        collisionCalls += 1;
        return 'absent';
      },
    });
    expect(decision).toEqual({ kind: 'create' });
    expect(collisionCalls).toBe(1);
  });

  it('empty vault + name UNCONFIRMABLE (unknown) -> "create" (fail-open, same posture as every other collision pre-flight in this codebase)', async () => {
    const decision = await resolveSharedRouterAppReuse(OWNER, HANDLE, {
      checkAppNameCollision: async () => 'unknown',
    });
    expect(decision).toEqual({ kind: 'create' });
  });

  it('neither dep wired (both undefined) -> "create" (vault-aware / collision-aware confirm NOT engaged this run, same opt-in contract as every sibling vault-restore closure)', async () => {
    const decision = await resolveSharedRouterAppReuse(OWNER, HANDLE, {});
    expect(decision).toEqual({ kind: 'create' });
  });

  it('empty vault + name CONFIRMED TAKEN -> "name-taken", carrying routerAppNameCollisionMessage\'s exact text — produces the instruction, not a silent failure', async () => {
    const decision = await resolveSharedRouterAppReuse(OWNER, HANDLE, {
      checkAppNameCollision: async () => 'present',
    });
    expect(decision.kind).toBe('name-taken');
    if (decision.kind !== 'name-taken') return;
    // OWNER.type === 'user' -> the personal-account settings URL shape; HANDLE is
    // the owner-keyed handle (groundnuty/macf#1088), not the old fixed 'macf-routing'.
    expect(decision.reason).toBe(routerAppNameCollisionMessage(HANDLE, `https://github.com/settings/apps/${HANDLE}/advanced`));
  });

  it('a throwing readVaultRouterApp degrades to the vault being empty, never propagates — falls through to the collision check', async () => {
    let collisionCalls = 0;
    const decision = await resolveSharedRouterAppReuse(OWNER, HANDLE, {
      readVaultRouterApp: async () => {
        throw new Error('simulated decrypt failure');
      },
      checkAppNameCollision: async () => {
        collisionCalls += 1;
        return 'absent';
      },
    });
    expect(decision).toEqual({ kind: 'create' });
    expect(collisionCalls).toBe(1);
  });

  it('a throwing checkAppNameCollision degrades to "unknown", never propagates -> "create" (fail-open)', async () => {
    const deps: SharedRouterAppReuseDeps = {
      checkAppNameCollision: async () => {
        throw new Error('simulated network failure');
      },
    };
    await expect(resolveSharedRouterAppReuse(OWNER, HANDLE, deps)).resolves.toEqual({ kind: 'create' });
  });
});

describe('routerAppNameCollisionMessage — the shared-scope instruction text', () => {
  it('names both operator next steps: supply vault credentials, or opt into per-fleet scope', () => {
    const msg = routerAppNameCollisionMessage('macf-routing', 'https://github.com/settings/apps/macf-routing/advanced');
    expect(msg).toMatch(/MACF_ROUTING_APP_ID/);
    expect(msg).toMatch(/MACF_ROUTING_APP_KEY_B64/);
    expect(msg).toMatch(/--vault\/--identity-key/);
    expect(msg).toMatch(/transport\.router_app_scope: per-fleet/);
    expect(msg).toContain('macf-routing');
  });

  it('never mentions a credential value — only the vault KEY NAMES, never a PEM or secret', () => {
    const msg = routerAppNameCollisionMessage('macf-routing', 'https://github.com/settings/apps/macf-routing/advanced');
    expect(msg).not.toMatch(/BEGIN.*PRIVATE KEY/);
  });

  it('carries no internal issue/DR citation — user-facing output, per the citation guard (groundnuty/macf#1061)', () => {
    const msg = routerAppNameCollisionMessage('macf-routing', 'https://github.com/settings/apps/macf-routing/advanced');
    expect(msg).not.toMatch(/\bmacf#\d+\b|\bgroundnuty\/macf#\d+\b|\bDR-0\d{2}\b|\bAmendment [A-Z0-9]\b/);
  });
});

describe('resolveRouterAppSecretsForPublish — the "vault-reused" status (groundnuty/macf#1082) joins the SAME publish path, no second seam', () => {
  it('"vault-reused": resolves "available" by re-reading the SAME vault closure — one publisher, not a new one', async () => {
    let readCalls = 0;
    const result = await resolveRouterAppSecretsForPublish({ role: 'router', status: 'vault-reused', appId: '9001' }, true, {
      readVaultRouterApp: async () => {
        readCalls += 1;
        return { appId: '9001', appKeyPem: 'SENTINEL-PUBLISH-PEM' };
      },
    });
    expect(result).toEqual({ status: 'available', appId: '9001', appKeyPem: 'SENTINEL-PUBLISH-PEM' });
    expect(readCalls).toBe(1);
  });

  it('"vault-reused" + no readVaultRouterApp wired -> "unavailable", never fabricates a credential', async () => {
    const result = await resolveRouterAppSecretsForPublish({ role: 'router', status: 'vault-reused', appId: '9001' }, true, {});
    expect(result.status).toBe('unavailable');
  });
});
