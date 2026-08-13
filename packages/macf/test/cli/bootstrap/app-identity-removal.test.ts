/**
 * Tests for `app-identity-removal.ts` — DR-043 Amendment G's App-identity
 * report (groundnuty/macf#867). Fully offline: no `gh`/network involved;
 * `openUrl` is injected.
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import {
  APP_DELETION_HAS_NO_REST_PATH_NOTE,
  appSettingsAdvancedUrl,
  computeAppIdentityTargets,
  enrichAppIdentityTargetsWithLock,
  reportAppIdentityRemoval,
} from '../../../src/cli/bootstrap/app-identity-removal.js';

const ORG_MANIFEST: FleetManifest = {
  apiVersion: 'macf/v0',
  kind: 'Fleet',
  metadata: { name: 'macf-experiment' },
  owner: { account: 'groundnuty', type: 'org', registry: { type: 'org', org: 'macf-experiment' } },
  network: { advertise_host: 'example.ts.net' },
  transport: { age_recipients: ['age1operator'] },
  defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
  agents: [
    { role: 'code-agent', profile: 'code', repo: 'groundnuty/macf-experiment-code', deploy_path: '/x' },
    { role: 'science-agent', profile: 'research', repo: 'groundnuty/macf-experiment-science', deploy_path: '/y' },
  ],
  trust: { ca: 'per-project', federated_cas: [] },
};

const USER_MANIFEST: FleetManifest = {
  ...ORG_MANIFEST,
  metadata: { name: 'demo-fleet' },
  owner: { account: 'someuser', type: 'user', registry: { type: 'profile', user: 'someuser' } },
};

describe('appSettingsAdvancedUrl', () => {
  it('org-owned -> /organizations/<org>/settings/apps/<slug>/advanced', () => {
    expect(appSettingsAdvancedUrl({ account: 'groundnuty', type: 'org' }, 'macf-experiment-code-agent')).toBe(
      'https://github.com/organizations/groundnuty/settings/apps/macf-experiment-code-agent/advanced',
    );
  });

  it('user-owned -> /settings/apps/<slug>/advanced (no /organizations/ prefix)', () => {
    expect(appSettingsAdvancedUrl({ account: 'someuser', type: 'user' }, 'demo-fleet-code-agent')).toBe(
      'https://github.com/settings/apps/demo-fleet-code-agent/advanced',
    );
  });
});

describe('computeAppIdentityTargets (pure)', () => {
  it('one target per manifest agent, in manifest order, slug = deriveAppHandle(fleet, role)', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    expect(targets).toEqual([
      {
        role: 'code-agent',
        appSlug: 'macf-experiment-code-agent',
        settingsUrl: 'https://github.com/organizations/groundnuty/settings/apps/macf-experiment-code-agent/advanced',
      },
      {
        role: 'science-agent',
        appSlug: 'macf-experiment-science-agent',
        settingsUrl: 'https://github.com/organizations/groundnuty/settings/apps/macf-experiment-science-agent/advanced',
      },
    ]);
  });

  it('user-owned fleet -> user-form settings URL', () => {
    const targets = computeAppIdentityTargets(USER_MANIFEST);
    expect(targets[0]?.settingsUrl).toBe('https://github.com/settings/apps/demo-fleet-code-agent/advanced');
  });

  it('zero agents -> zero targets', () => {
    const empty: FleetManifest = { ...ORG_MANIFEST, agents: [] };
    expect(computeAppIdentityTargets(empty)).toEqual([]);
  });
});

describe('enrichAppIdentityTargetsWithLock', () => {
  const LOCK_YAML = `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
  - role: science-agent
    app_id: "555222"
    install_id: "999333"
`;

  it('lock text absent -> targets unchanged (no appId)', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const enriched = enrichAppIdentityTargetsWithLock(targets, undefined);
    expect(enriched).toEqual(targets);
    expect(enriched.every((t) => t.appId === undefined)).toBe(true);
  });

  it('lock present + matching roles -> appId populated per role, everything else unchanged', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const enriched = enrichAppIdentityTargetsWithLock(targets, LOCK_YAML);
    expect(enriched.find((t) => t.role === 'code-agent')?.appId).toBe('555111');
    expect(enriched.find((t) => t.role === 'science-agent')?.appId).toBe('555222');
    // slug + settingsUrl untouched
    expect(enriched.find((t) => t.role === 'code-agent')?.appSlug).toBe('macf-experiment-code-agent');
  });

  it('lock present but a role is MISSING from it -> that target stays appId: undefined, others still enriched', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const partialLock = `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
`;
    const enriched = enrichAppIdentityTargetsWithLock(targets, partialLock);
    expect(enriched.find((t) => t.role === 'code-agent')?.appId).toBe('555111');
    expect(enriched.find((t) => t.role === 'science-agent')?.appId).toBeUndefined();
  });

  it('malformed/unparseable lock text -> degrades to targets unchanged, NEVER throws', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    expect(() => enrichAppIdentityTargetsWithLock(targets, 'not: [valid, fleet, lock')).not.toThrow();
    expect(enrichAppIdentityTargetsWithLock(targets, 'not: [valid, fleet, lock')).toEqual(targets);
  });

  it('empty-string lock text (a read that resolved but returned nothing) -> degrades to targets unchanged, NEVER throws', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    expect(() => enrichAppIdentityTargetsWithLock(targets, '')).not.toThrow();
  });
});

describe('reportAppIdentityRemoval', () => {
  it('NEVER returns a status other than manual-action-required, for every target', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const logs: string[] = [];
    const outcomes = await reportAppIdentityRemoval(targets, (l) => logs.push(l), {});
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === 'manual-action-required')).toBe(true);
    expect(outcomes.every((o) => o.reason === APP_DELETION_HAS_NO_REST_PATH_NOTE)).toBe(true);
  });

  it('logs the settings URL for every target BEFORE openUrl is attempted', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const logs: string[] = [];
    const opened: string[] = [];
    await reportAppIdentityRemoval(targets, (l) => logs.push(l), {
      openUrl: async (url) => {
        // The log line for THIS target must already be present by the time openUrl fires.
        expect(logs.some((l) => l.includes(url))).toBe(true);
        opened.push(url);
      },
    });
    expect(opened).toEqual(targets.map((t) => t.settingsUrl));
  });

  it('openUrl failure is non-fatal — still reports manual-action-required, logs the fallback line', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1);
    const logs: string[] = [];
    const outcomes = await reportAppIdentityRemoval(targets, (l) => logs.push(l), {
      openUrl: async () => {
        throw new Error('no display available');
      },
    });
    expect(outcomes[0]?.status).toBe('manual-action-required');
    expect(logs.join('\n')).toMatch(/could not automatically open a browser/);
  });

  it('openUrl omitted entirely -> still reports every target (headless/CI/test posture)', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const outcomes = await reportAppIdentityRemoval(targets, () => {});
    expect(outcomes).toHaveLength(2);
  });

  it('a target enriched with appId carries it through to the outcome AND the log line', async () => {
    const targets = enrichAppIdentityTargetsWithLock(computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1), `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
`);
    const logs: string[] = [];
    const outcomes = await reportAppIdentityRemoval(targets, (l) => logs.push(l));
    expect(outcomes[0]?.appId).toBe('555111');
    expect(logs.join('\n')).toMatch(/555111/);
  });

  it('a target WITHOUT appId (no lock enrichment) reports undefined and a "no confirmation" caveat', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1);
    const logs: string[] = [];
    const outcomes = await reportAppIdentityRemoval(targets, (l) => logs.push(l));
    expect(outcomes[0]?.appId).toBeUndefined();
    expect(logs.join('\n')).toMatch(/no fleet\.lock entry/);
  });
});
