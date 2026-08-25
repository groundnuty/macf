/**
 * Tests for `registry-repo-coverage.ts` — the live post-gate-2 registry-repo
 * installation-coverage check (groundnuty/macf#1012). Fully offline: the
 * real I/O leaf (`checkRepoInAppInstallation`, `mintAppJwt`) is
 * deliberately UNTESTED here (same "pure-parse tested, I/O leaf untested"
 * split `identity-confirm.test.ts` establishes for `confirmAppInstallation`)
 * — every test below exercises either the pure status-mapping function or
 * `buildRegistryRepoValidateInstall` via an INJECTED `checkFn` fake.
 */
import { describe, it, expect } from 'vitest';
import type { ConfirmedInstall } from '../../../src/cli/bootstrap/identity-confirm.js';
import type { Presence } from '../../../src/cli/bootstrap/plan.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import {
  buildRegistryRepoValidateInstall,
  mapRepoInstallationStatus,
  registryRepoCoverageUnknownWarning,
  registryRepoNotInstalledReason,
  requiredRegistryRepoCoverage,
} from '../../../src/cli/bootstrap/registry-repo-coverage.js';

const INSTALL: ConfirmedInstall = { appId: '9001', installId: '5555', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' };

/** Minimal manifest shape, module-scoped for the `requiredRegistryRepoCoverage` describe block below. */
function manifestWithRegistry(registry: FleetManifest['owner']['registry']): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: 'demo-fleet' },
    owner: { account: 'demo-org', type: 'org', registry },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [{ role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/x' }],
    trust: { ca: 'per-project', federated_cas: [] },
  };
}

describe('requiredRegistryRepoCoverage (pure, groundnuty/macf#1156) — the SAME derivation both the check (this module) and the gate-2 instruction (apply-agent.ts::installReposForIdentity) read', () => {
  it('registry.type === "repo" -> { owner, repo } read straight from the manifest', () => {
    expect(requiredRegistryRepoCoverage(manifestWithRegistry({ type: 'repo', owner: 'demo-org', repo: 'demo-org-registry' }))).toEqual({
      owner: 'demo-org',
      repo: 'demo-org-registry',
    });
  });

  it.each([
    ['profile', { type: 'profile', user: 'demo-org' }] as const,
    ['org', { type: 'org', org: 'demo-org' }] as const,
    ['local', { type: 'local', path: '/tmp/registry.json' }] as const,
  ])('registry.type === "%s" -> undefined (no specific repo an install needs to cover)', (_label, registry) => {
    expect(requiredRegistryRepoCoverage(manifestWithRegistry(registry))).toBeUndefined();
  });
});

describe('mapRepoInstallationStatus — GET /repos/{owner}/{repo}/installation status→Presence (macf#1012 AC)', () => {
  it('200 -> present', () => {
    expect(mapRepoInstallationStatus(200)).toBe('present');
  });

  it('404 -> absent (decisive — the App is not installed with access to this repo, or the repo does not exist)', () => {
    expect(mapRepoInstallationStatus(404)).toBe('absent');
  });

  it.each([301, 401, 403, 500, 502, 0])('%d -> unknown (never decisive; DR-043 Amendment A honest-unknown floor)', (status) => {
    expect(mapRepoInstallationStatus(status)).toBe('unknown');
  });
});

describe('registryRepoNotInstalledReason — the refusal text names WHICH App and WHICH repo (macf#1012 decisive AC)', () => {
  it('names the exact App handle and the exact owner/repo — "one installation edit rather than a search"', () => {
    const reason = registryRepoNotInstalledReason('demo-fleet-code-agent', 'demo-org', 'demo-org-registry');
    expect(reason).toContain('demo-fleet-code-agent');
    expect(reason).toContain('demo-org/demo-org-registry');
  });

  it('names BOTH causes a 404 collapses — installation scope AND repo existence — never asserts only one', () => {
    const reason = registryRepoNotInstalledReason('demo-fleet-code-agent', 'demo-org', 'demo-org-registry');
    expect(reason).toMatch(/does not include/);
    expect(reason).toMatch(/does not exist or was renamed/);
  });

  it('explains the failure mode plainly, without citing internal issue numbers (#1061)', () => {
    const reason = registryRepoNotInstalledReason('demo-fleet-code-agent', 'demo-org', 'demo-org-registry');
    expect(reason).toContain('a known failure mode');
    expect(reason).toContain('now guarded for registry.type: repo');
  });
});

describe('registryRepoCoverageUnknownWarning — names the App + repo, states UNKNOWN never confirmed-missing', () => {
  it('names the App handle and owner/repo, and says this is not a failure', () => {
    const warning = registryRepoCoverageUnknownWarning('demo-fleet-code-agent', 'demo-org', 'demo-org-registry');
    expect(warning).toContain('demo-fleet-code-agent');
    expect(warning).toContain('demo-org/demo-org-registry');
    expect(warning).toMatch(/UNKNOWN/);
    expect(warning).toMatch(/never treated as confirmed-missing/);
  });
});

describe('buildRegistryRepoValidateInstall — the AgentApplyDeps.validateInstall/validateReuse closure', () => {
  it('DECISIVE: presence "absent" -> rejects, the rejection names the App and the repo', async () => {
    const checkFn = async (): Promise<Presence> => 'absent';
    const validate = buildRegistryRepoValidateInstall('demo-org', 'demo-org-registry', 'demo-fleet-code-agent', () => {}, checkFn);
    const rejection = await validate(INSTALL, '/fake/key.pem');
    expect(rejection).toBeDefined();
    // groundnuty/macf#1063 widened the rejection to `{ message, retryInstruction }`
    // — `message` keeps #1012's own technical text (assert unchanged below);
    // this test's "names the App and the repo" AC is satisfied by BOTH halves.
    if (typeof rejection === 'object') {
      expect(rejection.message).toContain('demo-fleet-code-agent');
      expect(rejection.message).toContain('demo-org/demo-org-registry');
    } else {
      throw new Error('expected the structured { message, retryInstruction } rejection shape (macf#1063)');
    }
  });

  it('groundnuty/macf#1063: the "absent" rejection ALSO carries a plain-language retryInstruction — no HTTP verbs, no issue numbers — for the interactive retry dialogue', async () => {
    const checkFn = async (): Promise<Presence> => 'absent';
    const validate = buildRegistryRepoValidateInstall('demo-org', 'demo-org-registry', 'demo-fleet-code-agent', () => {}, checkFn);
    const rejection = await validate(INSTALL, '/fake/key.pem');
    if (typeof rejection !== 'object' || rejection.retryInstruction === undefined) {
      throw new Error('expected a retryInstruction on the structured rejection');
    }
    const { retryInstruction } = rejection;
    expect(retryInstruction).toContain('demo-fleet-code-agent');
    expect(retryInstruction).toContain('demo-org/demo-org-registry');
    expect(retryInstruction).not.toMatch(/GET \/repos|HTTP|404|#\d+/);
  });

  it('groundnuty/macf#1176: the "absent" rejection ALSO carries the specific owner/repo as a structured missingRepos list — not just prose', async () => {
    const checkFn = async (): Promise<Presence> => 'absent';
    const validate = buildRegistryRepoValidateInstall('demo-org', 'demo-org-registry', 'demo-fleet-code-agent', () => {}, checkFn);
    const rejection = await validate(INSTALL, '/fake/key.pem');
    if (typeof rejection !== 'object') {
      throw new Error('expected the structured { message, retryInstruction, missingRepos } rejection shape');
    }
    expect(rejection.missingRepos).toEqual(['demo-org/demo-org-registry']);
  });

  it('presence "present" -> accepts (undefined), no churn, no warning logged', async () => {
    const checkFn = async (): Promise<Presence> => 'present';
    const logs: string[] = [];
    const validate = buildRegistryRepoValidateInstall('demo-org', 'demo-org-registry', 'demo-fleet-code-agent', (l) => logs.push(l), checkFn);
    const rejection = await validate(INSTALL, '/fake/key.pem');
    expect(rejection).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it('presence "unknown" -> accepts (undefined, never blocks) BUT logs a warning naming the App + repo', async () => {
    const checkFn = async (): Promise<Presence> => 'unknown';
    const logs: string[] = [];
    const validate = buildRegistryRepoValidateInstall('demo-org', 'demo-org-registry', 'demo-fleet-code-agent', (l) => logs.push(l), checkFn);
    const rejection = await validate(INSTALL, '/fake/key.pem');
    expect(rejection).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('demo-fleet-code-agent');
    expect(logs[0]).toContain('demo-org/demo-org-registry');
    expect(logs[0]).toMatch(/UNKNOWN/);
  });

  it('passes install.appId + the given keyPath + the configured owner/repo to checkFn, verbatim', async () => {
    let seen: readonly [string, string, string, string] | undefined;
    const checkFn = async (appId: string, keyPath: string, owner: string, repo: string): Promise<Presence> => {
      seen = [appId, keyPath, owner, repo];
      return 'present';
    };
    const validate = buildRegistryRepoValidateInstall('demo-org', 'demo-org-registry', 'demo-fleet-code-agent', () => {}, checkFn);
    await validate(INSTALL, '/the/key.pem');
    expect(seen).toEqual(['9001', '/the/key.pem', 'demo-org', 'demo-org-registry']);
  });
});
