/**
 * Tests for manifest-role vs config-`routing_label` drift detection
 * (groundnuty/macf#1059).
 */
import { describe, it, expect } from 'vitest';
import {
  detectRoutingLabelDrift,
  hasRoutingLabelDrift,
  buildAgentRoleLookup,
  detectRoutingLabelDriftFromManifestFile,
} from '../../../src/cli/bootstrap/routing-label-drift.js';
import type { RoutingLabelConfigLookup } from '../../../src/cli/bootstrap/routing-label-drift.js';
import { parseFleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { MacfAgentConfig } from '../../../src/cli/config.js';
import type { WorkspaceRecord } from '@groundnuty/macf-core';

function baseConfig(overrides: Partial<MacfAgentConfig> = {}): MacfAgentConfig {
  return {
    project: 'icsoc-2026',
    agent_name: 'science-agent',
    agent_role: 'science-agent',
    agent_type: 'permanent',
    registry: { type: 'repo', owner: 'o', repo: 'r' },
    ...overrides,
  };
}

const TWO_AGENT_MANIFEST_YAML = `
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
  - role: science-agent
    profile: research
    repo: groundnuty/icsoc-2026-science-agent
    deploy_path: /home/ubuntu/repos/agh/icsoc-2026-science-agent
  - role: code-agent
    profile: code
    repo: groundnuty/icsoc-2026-code-agent
    deploy_path: /home/ubuntu/repos/agh/icsoc-2026-code-agent
`;

function twoAgentManifest(): FleetManifest {
  return parseFleetManifest(TWO_AGENT_MANIFEST_YAML);
}

function oneAgentManifest(): FleetManifest {
  return parseFleetManifest(`
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
  - role: science-agent
    profile: research
    repo: groundnuty/icsoc-2026-science-agent
    deploy_path: /home/ubuntu/repos/agh/icsoc-2026-science-agent
`);
}

describe('detectRoutingLabelDrift — pure core (macf#1059)', () => {
  it('reports clean when routing_label is absent and agent_name/agent_role/role all coincide (the healthy fleet-deployed shape)', () => {
    // Deliberately written this way: `fleet-deploy.ts` -> `initAgent` passes
    // neither `name` nor `routingLabel`, so on every healthy deployed
    // workspace `routing_label` is ABSENT and `agent_name === agent_role ===
    // role`. A check that compares against the literal `routing_label`
    // field (instead of the `routing_label ?? agent_name` precedence) would
    // fail THIS test by reporting drift on a perfectly healthy agent.
    const config = baseConfig({ agent_name: 'science-agent', agent_role: 'science-agent' });
    expect(config.routing_label).toBeUndefined();
    const lookup = (): RoutingLabelConfigLookup => ({ kind: 'found', config, source: '/ws/science-agent' });

    const entries = detectRoutingLabelDrift(oneAgentManifest(), 'fleet.yaml', lookup);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'science-agent',
      status: 'clean',
      recordedLabel: 'science-agent',
    });
    expect(hasRoutingLabelDrift(entries)).toBe(false);
  });

  it('reports drift naming BOTH the declared role and the recorded routing_label when they diverge', () => {
    const config = baseConfig({
      agent_name: 'macf-science-agent',
      agent_role: 'science-agent',
      routing_label: 'sci', // hand-edited post-deploy — diverges from the manifest role
    });
    const lookup = (): RoutingLabelConfigLookup => ({ kind: 'found', config, source: '/ws/science-agent' });

    const entries = detectRoutingLabelDrift(oneAgentManifest(), 'fleet.yaml', lookup);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    // Decisive per assert-the-wrong-path.md: assert the SPECIFIC pair, not
    // just that some status/warning fired. A generic "drift" status alone
    // is satisfied by a check that always reports drift.
    expect(entry?.status).toBe('drift');
    expect(entry?.role).toBe('science-agent');
    expect(entry?.recordedLabel).toBe('sci');
    expect(entry?.reason).toContain('role "science-agent"');
    expect(entry?.reason).toContain('routing label "sci"');
    expect(entry?.reason).toContain('fleet.yaml');
    expect(entry?.reason).toContain('/ws/science-agent');
    expect(hasRoutingLabelDrift(entries)).toBe(true);
  });

  it('reports the science-agent-shape divergence (agent_name != routing_label) as clean when the EFFECTIVE label still matches the role', () => {
    // coordination.md's own worked example: agent_name=macf-science-agent,
    // routing_label=science-agent. The routing_label override brings the
    // EFFECTIVE label back in line with the manifest role — this must read
    // clean, not drift, even though agent_name alone would not match.
    const config = baseConfig({
      agent_name: 'macf-science-agent',
      agent_role: 'science-agent',
      routing_label: 'science-agent',
    });
    const lookup = (): RoutingLabelConfigLookup => ({ kind: 'found', config, source: '/ws/science-agent' });

    const entries = detectRoutingLabelDrift(oneAgentManifest(), 'fleet.yaml', lookup);

    expect(entries[0]?.status).toBe('clean');
    expect(entries[0]?.recordedLabel).toBe('science-agent');
  });

  it('reports unknown — never a silent clean — when the config cannot be resolved', () => {
    const lookup = (): RoutingLabelConfigLookup => ({
      kind: 'unknown',
      reason: 'no locally discovered workspace',
    });

    const entries = detectRoutingLabelDrift(oneAgentManifest(), 'fleet.yaml', lookup);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('unknown');
    expect(entries[0]?.recordedLabel).toBeNull();
    expect(entries[0]?.configSource).toBeNull();
    // Not clean, and not folded into the drift-detection verdict either way.
    const cleanOnly = entries.filter((e) => e.status === 'clean');
    expect(cleanOnly).toHaveLength(0);
    expect(hasRoutingLabelDrift(entries)).toBe(false);
  });

  it('reports MULTI-AGENT fleets per-agent — one drifted + one clean produce two distinct entries, never one collapsed verdict', () => {
    const scienceConfig = baseConfig({
      project: 'icsoc-2026',
      agent_name: 'science-agent',
      agent_role: 'science-agent',
    });
    const codeConfig = baseConfig({
      project: 'icsoc-2026',
      agent_name: 'code-agent',
      agent_role: 'code-agent',
      routing_label: 'drifted-code-label',
    });
    const lookup = (role: string): RoutingLabelConfigLookup => {
      if (role === 'science-agent') return { kind: 'found', config: scienceConfig, source: '/ws/science' };
      if (role === 'code-agent') return { kind: 'found', config: codeConfig, source: '/ws/code' };
      return { kind: 'unknown', reason: `unexpected role ${role}` };
    };

    const entries = detectRoutingLabelDrift(twoAgentManifest(), 'fleet.yaml', lookup);

    expect(entries).toHaveLength(2);
    const byRole = new Map(entries.map((e) => [e.role, e]));
    expect(byRole.get('science-agent')?.status).toBe('clean');
    expect(byRole.get('code-agent')?.status).toBe('drift');
    expect(byRole.get('code-agent')?.recordedLabel).toBe('drifted-code-label');
    expect(hasRoutingLabelDrift(entries)).toBe(true);
  });
});

describe('buildAgentRoleLookup — production join via agent_role (macf#1059)', () => {
  function workspace(project: string, agent: string, workspacePath: string): WorkspaceRecord {
    return { project, agent, workspace: workspacePath, registry: 'local', versionPin: null };
  }

  it('matches a discovered workspace to a manifest role via agent_role, scoped to the project', () => {
    const scienceConfig = baseConfig({ project: 'icsoc-2026', agent_role: 'science-agent' });
    const otherProjectConfig = baseConfig({ project: 'other-project', agent_role: 'science-agent' });
    const workspaces = [
      workspace('icsoc-2026', 'science-agent', '/ws/science'),
      workspace('other-project', 'science-agent', '/ws/other'),
    ];
    const configsByDir = new Map<string, MacfAgentConfig>([
      ['/ws/science', scienceConfig],
      ['/ws/other', otherProjectConfig],
    ]);
    const readConfig = (dir: string): MacfAgentConfig | null => configsByDir.get(dir) ?? null;

    const lookup = buildAgentRoleLookup('icsoc-2026', workspaces, readConfig);
    const result = lookup('science-agent');

    expect(result.kind).toBe('found');
    expect(result.kind === 'found' && result.source).toBe('/ws/science');
  });

  it('reports unknown when no discovered workspace has a matching agent_role', () => {
    const lookup = buildAgentRoleLookup('icsoc-2026', [], () => null);
    const result = lookup('science-agent');
    expect(result.kind).toBe('unknown');
  });

  it('reports unknown (never guesses) when TWO discovered workspaces share the same agent_role for the project', () => {
    const configA = baseConfig({ project: 'icsoc-2026', agent_role: 'science-agent' });
    const configB = baseConfig({ project: 'icsoc-2026', agent_role: 'science-agent' });
    const workspaces = [
      workspace('icsoc-2026', 'science-agent', '/ws/a'),
      workspace('icsoc-2026', 'science-agent', '/ws/b'),
    ];
    const configsByDir = new Map<string, MacfAgentConfig>([
      ['/ws/a', configA],
      ['/ws/b', configB],
    ]);
    const lookup = buildAgentRoleLookup('icsoc-2026', workspaces, (dir) => configsByDir.get(dir) ?? null);

    const result = lookup('science-agent');
    expect(result.kind).toBe('unknown');
    expect(result.kind === 'unknown' && result.reason).toContain('ambiguous');
  });

  it('honest-unknown floor: an unreadable config (readConfig returns null) is dropped, never treated as a match', () => {
    const workspaces = [workspace('icsoc-2026', 'science-agent', '/ws/broken')];
    const lookup = buildAgentRoleLookup('icsoc-2026', workspaces, () => null);

    const result = lookup('science-agent');
    expect(result.kind).toBe('unknown');
  });
});

describe('detectRoutingLabelDriftFromManifestFile — end-to-end wiring (macf#1059)', () => {
  it('threads the manifest path through as manifestSource and detects drift across the full pipeline', () => {
    const scienceConfig = baseConfig({
      project: 'icsoc-2026',
      agent_name: 'science-agent',
      agent_role: 'science-agent',
    });
    const codeConfig = baseConfig({
      project: 'icsoc-2026',
      agent_name: 'code-agent',
      agent_role: 'code-agent',
      routing_label: 'renamed-code',
    });
    const workspaces: readonly WorkspaceRecord[] = [
      { project: 'icsoc-2026', agent: 'science-agent', workspace: '/ws/science', registry: 'local', versionPin: null },
      { project: 'icsoc-2026', agent: 'renamed-code', workspace: '/ws/code', registry: 'local', versionPin: null },
    ];
    const configsByDir = new Map<string, MacfAgentConfig>([
      ['/ws/science', scienceConfig],
      ['/ws/code', codeConfig],
    ]);

    const entries = detectRoutingLabelDriftFromManifestFile('/repo/fleet.yaml', {
      readManifestText: (path) => {
        expect(path).toBe('/repo/fleet.yaml');
        return TWO_AGENT_MANIFEST_YAML;
      },
      discover: () => workspaces,
      readConfig: (dir) => configsByDir.get(dir) ?? null,
    });

    expect(entries).toHaveLength(2);
    const byRole = new Map(entries.map((e) => [e.role, e]));
    expect(byRole.get('science-agent')).toMatchObject({ status: 'clean', manifestSource: '/repo/fleet.yaml' });
    expect(byRole.get('code-agent')).toMatchObject({ status: 'drift', recordedLabel: 'renamed-code' });
  });

  it('propagates a malformed manifest as a thrown error (mirrors parseFleetManifest\'s own contract)', () => {
    expect(() =>
      detectRoutingLabelDriftFromManifestFile('/repo/fleet.yaml', {
        readManifestText: () => 'not: [valid, fleet, manifest',
        discover: () => [],
        readConfig: () => null,
      }),
    ).toThrow();
  });
});
