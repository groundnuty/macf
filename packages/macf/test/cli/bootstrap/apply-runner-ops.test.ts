/**
 * Tests for `apply-runner-ops.ts` — the runner-ops App's PURE
 * pieces (groundnuty/macf#943): permission set, manifest builder, handle
 * derivation, post-install validation, name-length pre-flight. Orchestration
 * (when it's created, how its credential folds into the vault) is exercised
 * in `apply-fleet.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  RUNNER_OPS_ROLE,
  RUNNER_OPS_PERMISSIONS,
  RUNNER_OPS_EVENTS,
  GITHUB_APP_NAME_MAX_LENGTH,
  deriveRunnerOpsHandle,
  runnerOpsIdentityRequest,
  buildRunnerOpsManifest,
  validateRunnerOpsInstall,
  plannedAppNames,
  checkAppNameLengths,
} from '../../../src/cli/bootstrap/apply-runner-ops.js';
import type { ConfirmedInstall } from '../../../src/cli/bootstrap/identity-confirm.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';

/**
 * `router_app_scope: 'per-fleet'` (groundnuty/macf#1082) pins this file's
 * `plannedAppNames` router-handle assertion to the pre-#1082 fleet-derived
 * name — that default flip is covered separately in `apply-router-app.test.ts`
 * / `apply-fleet.test.ts`, not re-verified here.
 */
function manifestWithRoles(fleetName: string, roles: readonly string[]): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: fleetName },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'], router_app_scope: 'per-fleet' },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: roles.map((role) => ({ role, profile: 'x', repo: `groundnuty/${fleetName}-${role}`, deploy_path: '/x' })),
    trust: { ca: 'per-project', federated_cas: [] },
  };
}

describe('RUNNER_OPS_ROLE / deriveRunnerOpsHandle', () => {
  it('role is the reserved "runner-ops" string, never declared in fleet.yaml agents[]', () => {
    expect(RUNNER_OPS_ROLE).toBe('runner-ops');
  });

  it('handle is derived via the SAME deriveAppHandle convention every agent App uses — <fleet>-<role>', () => {
    expect(deriveRunnerOpsHandle('macf-experiment')).toBe('macf-experiment-runner-ops');
    // Under GitHub's 34-char App-name cap for the live fleet (26).
    expect(deriveRunnerOpsHandle('macf-experiment').length).toBeLessThanOrEqual(34);
    // macf#943 budget criterion: a NEW derived role must be no longer than the
    // longest EXISTING role, so adding a credential never lowers the maximum
    // fleet-name length. `science-agent` (13) is today's limiter; `runner-ops`
    // (10) stays under it, keeping the ceiling at 34 - 1 - 13 = 20 rather than
    // moving it. Asserted as a relation, not a magic number, so a future role
    // rename fails HERE rather than silently shrinking every fleet's budget.
    expect(RUNNER_OPS_ROLE.length).toBeLessThanOrEqual('science-agent'.length);
  });
});

describe('RUNNER_OPS_PERMISSIONS — exactly three, no others', () => {
  it('is exactly {administration:write, actions:read, metadata:read}', () => {
    expect(RUNNER_OPS_PERMISSIONS).toEqual({
      administration: 'write',
      actions: 'read',
      metadata: 'read',
    });
    expect(Object.keys(RUNNER_OPS_PERMISSIONS)).toHaveLength(3);
  });

  it('carries NO DR-019 agent permission (issues/pull_requests/contents/actions_variables/workflows/actions:write) — disjoint by design', () => {
    const keys = Object.keys(RUNNER_OPS_PERMISSIONS);
    expect(keys).not.toContain('issues');
    expect(keys).not.toContain('pull_requests');
    expect(keys).not.toContain('contents');
    expect(keys).not.toContain('actions_variables');
    expect(keys).not.toContain('workflows');
    expect(RUNNER_OPS_PERMISSIONS['actions']).toBe('read'); // NOT 'write' — the agent App's DR-019 level
  });
});

describe('RUNNER_OPS_EVENTS — none', () => {
  it('is an empty array — this App never subscribes to coordination webhooks', () => {
    expect(RUNNER_OPS_EVENTS).toEqual([]);
  });
});

describe('buildRunnerOpsManifest — reuses buildAppManifest, differently configured', () => {
  it('submits EXACTLY the three permissions, the derived handle as name, and empty events', () => {
    const manifest = buildRunnerOpsManifest('macf-experiment', 'http://127.0.0.1:9/callback');
    expect(manifest.name).toBe('macf-experiment-runner-ops');
    expect(manifest.default_permissions).toEqual({ administration: 'write', actions: 'read', metadata: 'read' });
    expect(Object.keys(manifest.default_permissions)).toHaveLength(3);
    expect(manifest.default_events).toEqual([]);
    expect(manifest.redirect_url).toBe('http://127.0.0.1:9/callback');
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toEqual({ url: 'https://example.com/webhook', active: false });
  });

  it('honors an explicit homepageUrl (e.g. the control repo) over the default', () => {
    const manifest = buildRunnerOpsManifest('macf-experiment', 'http://x/callback', 'https://github.com/groundnuty/macf-experiment-control');
    expect(manifest.url).toBe('https://github.com/groundnuty/macf-experiment-control');
  });

  it('falls back to buildAppManifest\'s own default homepage when none is given', () => {
    const manifest = buildRunnerOpsManifest('macf-experiment', 'http://x/callback');
    expect(manifest.url).toBe('https://github.com/groundnuty/macf');
  });
});

describe('runnerOpsIdentityRequest', () => {
  it('produces the IdentityRequest applyIdentity needs — role + permissions + events, homepageUrl passed through', () => {
    const req = runnerOpsIdentityRequest('https://github.com/groundnuty/x-control');
    expect(req).toEqual({
      role: 'runner-ops',
      homepageUrl: 'https://github.com/groundnuty/x-control',
      permissions: RUNNER_OPS_PERMISSIONS,
      events: RUNNER_OPS_EVENTS,
    });
  });
});

describe('validateRunnerOpsInstall — repository_selection scoped to fleet repos, NEVER "all"', () => {
  const base: ConfirmedInstall = { appId: '1', installId: '2', appSlug: 'x-runner-ops', accountLogin: 'groundnuty' };

  it('accepts "selected" — the only passing shape', () => {
    expect(validateRunnerOpsInstall({ ...base, repositorySelection: 'selected' })).toBeUndefined();
  });

  it('REFUSES "all" — the exact hazard the task brief names', () => {
    const reason = validateRunnerOpsInstall({ ...base, repositorySelection: 'all' });
    expect(reason).toBeDefined();
    expect(reason).toMatch(/repository_selection must be "selected"/);
    expect(reason).toMatch(/"all"/);
  });

  it('REFUSES a missing repository_selection (fails CLOSED, not merely "not all")', () => {
    const reason = validateRunnerOpsInstall(base);
    expect(reason).toBeDefined();
    expect(reason).toMatch(/not reported by GitHub/);
  });

  it('REFUSES any other unexpected value too', () => {
    const reason = validateRunnerOpsInstall({ ...base, repositorySelection: 'weird-future-value' });
    expect(reason).toBeDefined();
  });

  it('never mentions a credential — this function only ever sees a ConfirmedInstall, which carries none', () => {
    const reason = validateRunnerOpsInstall({ ...base, repositorySelection: 'all' });
    expect(reason).not.toMatch(/BEGIN.*PRIVATE KEY/);
  });
});

describe('plannedAppNames / checkAppNameLengths — the 34-char pre-flight (groundnuty/macf#943)', () => {
  it('GITHUB_APP_NAME_MAX_LENGTH is 34', () => {
    expect(GITHUB_APP_NAME_MAX_LENGTH).toBe(34);
  });

  it('plannedAppNames includes every agent handle PLUS the runner-ops handle PLUS the router handle (groundnuty/macf#1074), in that order', () => {
    const manifest = manifestWithRoles('demo-fleet', ['code-agent', 'science-agent']);
    expect(plannedAppNames(manifest)).toEqual([
      'demo-fleet-code-agent',
      'demo-fleet-science-agent',
      'demo-fleet-runner-ops',
      'demo-fleet-router',
    ]);
  });

  it('checkAppNameLengths: ok when every derived name is <= 34 chars (the documented live-fleet example)', () => {
    const manifest = manifestWithRoles('macf-experiment', ['code-agent']);
    const check = checkAppNameLengths(manifest);
    expect(check.ok).toBe(true);
  });

  it('checkAppNameLengths: refuses when the RUNNER-OPS handle itself exceeds 34 chars', () => {
    // 'this-is-a-very-long-fleet-name' (31) + '-runner-ops' (18) = 49 chars, way over.
    const manifest = manifestWithRoles('this-is-a-very-long-fleet-name', ['code-agent']);
    const check = checkAppNameLengths(manifest);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.violations.map((v) => v.name)).toContain('this-is-a-very-long-fleet-name-runner-ops');
      expect(check.reason).toMatch(/exceed the 34-char/);
      expect(check.reason).toContain('this-is-a-very-long-fleet-name-runner-ops');
    }
  });

  it('checkAppNameLengths: refuses when an AGENT handle exceeds 34 chars, independent of the runner-ops credential', () => {
    const manifest = manifestWithRoles('demo', ['an-extremely-long-role-name-that-is-way-too-long']);
    const check = checkAppNameLengths(manifest);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.violations.map((v) => v.name)).toContain('demo-an-extremely-long-role-name-that-is-way-too-long');
    }
  });

  it('checkAppNameLengths: reports EVERY violation, not just the first (aggregate-fail-loud)', () => {
    const manifest = manifestWithRoles('this-is-a-very-long-fleet-name-indeed', [
      'an-extremely-long-role-name-that-is-way-too-long',
    ]);
    const check = checkAppNameLengths(manifest);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      // Both the agent's handle AND the runner-ops credential's handle exceed the cap for this fleet name.
      expect(check.violations.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('checkAppNameLengths is exactly at the boundary: 34 chars passes, 35 fails', () => {
    // `checkAppNameLengths` ALWAYS also checks the runner-ops credential's own handle
    // (fleet + '-runner-ops', 18 chars) — keep the fleet name SHORT
    // (runner-ops credential handle well under 34) so this test isolates the AGENT
    // handle's boundary, not the runner-ops credential's.
    const fleet = 'test'; // runner-ops credential handle: 'test-runner-ops' = 22 chars, fine.
    // deriveAppHandle = `${fleet}-${role}` = 4 + 1 + role.length.
    const roleForThirtyFour = 'a'.repeat(29); // 4 + 1 + 29 = 34
    const okManifest = manifestWithRoles(fleet, [roleForThirtyFour]);
    expect(checkAppNameLengths(okManifest).ok).toBe(true);

    const roleForThirtyFive = 'a'.repeat(30); // 4 + 1 + 30 = 35
    const badManifest = manifestWithRoles(fleet, [roleForThirtyFive]);
    const check = checkAppNameLengths(badManifest);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.violations).toHaveLength(1); // only the agent's handle — runner-ops credential stays under the cap
      expect(check.violations[0]?.length).toBe(35);
    }
  });
});
