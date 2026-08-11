/**
 * Tests for the `fleet.yaml` / `fleet.lock` schema (DR-043 §D1, Slice 1a,
 * groundnuty/macf#838). The valid fixture mirrors the DR's own `icsoc-2026`
 * worked example verbatim.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveAppHandle,
  parseFleetLock,
  parseFleetManifest,
  FLEET_LOCK_SCHEMA_VERSION,
} from '../../../src/cli/bootstrap/fleet-manifest.js';

/** The DR-043 §D1 worked example, verbatim. */
const VALID_FLEET_YAML = `
apiVersion: macf/v0
kind: Fleet
metadata:
  name: icsoc-2026

versions:
  macf: 0.2.44
  actions: v3.4.1

owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }

network:
  advertise_host: orzech-dev-agents.tail491af.ts.net

transport:
  vault_repo: groundnuty/icsoc-2026-science-agent
  age_recipient: null

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
    repo: groundnuty/icsoc-2026-experiment
    deploy_path: /home/ubuntu/repos/agh/icsoc-2026-experiment
  - role: writer-agent
    profile: paper-latex
    repo: groundnuty/icsoc-2026
    provenance: mirror
    deploy_path: /home/ubuntu/repos/papers/icsoc-2026

routing:
  runner:
    runs_on: self-hosted

collaborators:
  - project: ppam-2026
    registry: { type: profile, user: groundnuty }
    ca_bundle: bundles/ppam-2026-ca.pem

shared:
  routing_app: macf-routing
  ts_oauth: operator-supplied

trust:
  ca: per-project
  federated_cas: []
`;

describe('parseFleetManifest — valid DR-043 §D1 worked example', () => {
  it('parses without throwing and round-trips the top-level shape', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.apiVersion).toBe('macf/v0');
    expect(manifest.kind).toBe('Fleet');
    expect(manifest.metadata.name).toBe('icsoc-2026');
    expect(manifest.owner).toEqual({
      account: 'groundnuty',
      type: 'user',
      registry: { type: 'profile', user: 'groundnuty' },
    });
    expect(manifest.transport.age_recipient).toBeNull();
    expect(manifest.agents).toHaveLength(3);
  });

  it('parses versions (steering input, day-2 reconcile) even though it is not reconciled in Slice 1a', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.versions).toEqual({ macf: '0.2.44', actions: 'v3.4.1' });
  });

  it('parses collaborators (cross-fleet guests) even though reconcile is deferred', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.collaborators).toEqual([
      {
        project: 'ppam-2026',
        registry: { type: 'profile', user: 'groundnuty' },
        ca_bundle: 'bundles/ppam-2026-ca.pem',
      },
    ]);
  });

  it('parses every agent, including the optional `provenance` field', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.agents[0]).toEqual({
      role: 'science-agent',
      profile: 'research',
      repo: 'groundnuty/icsoc-2026-science-agent',
      deploy_path: '/home/ubuntu/repos/agh/icsoc-2026-science-agent',
    });
    expect(manifest.agents[2]).toEqual({
      role: 'writer-agent',
      profile: 'paper-latex',
      repo: 'groundnuty/icsoc-2026',
      deploy_path: '/home/ubuntu/repos/papers/icsoc-2026',
      provenance: 'mirror',
    });
  });

  it('parses routing, shared, and trust', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.routing).toEqual({ runner: { runs_on: 'self-hosted' } });
    expect(manifest.shared).toEqual({ routing_app: 'macf-routing', ts_oauth: 'operator-supplied' });
    expect(manifest.trust).toEqual({ ca: 'per-project', federated_cas: [] });
  });

  it('parses a minimal manifest that omits every optional section', () => {
    const minimal = `
apiVersion: macf/v0
kind: Fleet
metadata:
  name: minimal-fleet
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
network:
  advertise_host: example.ts.net
transport:
  vault_repo: groundnuty/minimal-fleet-science-agent
  age_recipient: null
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/minimal-fleet-experiment
    deploy_path: /home/ubuntu/repos/agh/minimal-fleet-experiment
`;
    const manifest = parseFleetManifest(minimal);
    expect(manifest.versions).toBeUndefined();
    expect(manifest.routing).toBeUndefined();
    expect(manifest.collaborators).toBeUndefined();
    expect(manifest.shared).toBeUndefined();
    expect(manifest.trust).toBeUndefined();
  });
});

describe('parseFleetManifest — rejections', () => {
  it('rejects a wrong apiVersion', () => {
    const bad = VALID_FLEET_YAML.replace('apiVersion: macf/v0', 'apiVersion: macf/v1');
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects a missing metadata.name', () => {
    const bad = VALID_FLEET_YAML.replace('  name: icsoc-2026', '');
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects an unrecognized registry type', () => {
    const bad = VALID_FLEET_YAML.replace(
      'registry: { type: profile, user: groundnuty }\n\nnetwork:',
      'registry: { type: carrier-pigeon, user: groundnuty }\n\nnetwork:',
    );
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects an unknown top-level key (typo protection — `.strict()`)', () => {
    const bad = VALID_FLEET_YAML.replace('kind: Fleet', 'kind: Fleet\nkidn: Fleet');
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects zero agents', () => {
    const bad = `
apiVersion: macf/v0
kind: Fleet
metadata:
  name: empty-fleet
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
network:
  advertise_host: example.ts.net
transport:
  vault_repo: groundnuty/empty-fleet-science-agent
  age_recipient: null
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents: []
`;
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects an unknown `provenance` enum value', () => {
    const bad = VALID_FLEET_YAML.replace('provenance: mirror', 'provenance: symlink');
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  describe('handle derivation, never declaration (macf#791) — an agent MUST NOT carry app_handle / app_id', () => {
    it('rejects `app_handle` on an agent entry', () => {
      const bad = VALID_FLEET_YAML.replace(
        'role: code-agent',
        'role: code-agent\n    app_handle: icsoc-2026-code-agent',
      );
      expect(() => parseFleetManifest(bad)).toThrow(/app_handle/);
    });

    it('rejects `app_id` on an agent entry', () => {
      const bad = VALID_FLEET_YAML.replace(
        'role: code-agent',
        'role: code-agent\n    app_id: "333333"',
      );
      expect(() => parseFleetManifest(bad)).toThrow(/app_id/);
    });
  });
});

describe('deriveAppHandle — DR-032 Amendment (macf#791): handle = <project>-<role>', () => {
  it('matches the DR-032 icsoc-2026 worked example', () => {
    expect(deriveAppHandle('icsoc-2026', 'code-agent')).toBe('icsoc-2026-code-agent');
    expect(deriveAppHandle('icsoc-2026', 'science-agent')).toBe('icsoc-2026-science-agent');
  });

  it('matches the DR-032 macf-project worked example', () => {
    expect(deriveAppHandle('macf', 'devops-agent')).toBe('macf-devops-agent');
  });

  it('is a pure string concatenation with no normalization surprises', () => {
    expect(deriveAppHandle('ppam-2026', 'writer-agent')).toBe('ppam-2026-writer-agent');
  });
});

describe('parseFleetLock', () => {
  const VALID_LOCK_YAML = `
schema_version: 1
fleet: icsoc-2026
agents:
  - role: science-agent
    app_id: "111111"
    install_id: "22222222"
    fingerprints:
      app_private_key: sha256:abc123
      client_secret: sha256:def456
    deployed_version: "0.2.44"
fingerprints:
  ca_key: sha256:feedface
`;

  it('parses a valid lock', () => {
    const lock = parseFleetLock(VALID_LOCK_YAML);
    expect(lock.schema_version).toBe(FLEET_LOCK_SCHEMA_VERSION);
    expect(lock.fleet).toBe('icsoc-2026');
    expect(lock.agents).toHaveLength(1);
    expect(lock.agents[0]).toEqual({
      role: 'science-agent',
      app_id: '111111',
      install_id: '22222222',
      fingerprints: { app_private_key: 'sha256:abc123', client_secret: 'sha256:def456' },
      deployed_version: '0.2.44',
    });
    expect(lock.fingerprints).toEqual({ ca_key: 'sha256:feedface' });
  });

  it('rejects a wrong schema_version', () => {
    const bad = VALID_LOCK_YAML.replace('schema_version: 1', 'schema_version: 2');
    expect(() => parseFleetLock(bad)).toThrow();
  });

  it('rejects an unknown top-level key (typo protection)', () => {
    const bad = VALID_LOCK_YAML.replace('fleet: icsoc-2026', 'fleet: icsoc-2026\nfleeet: icsoc-2026');
    expect(() => parseFleetLock(bad)).toThrow();
  });

  it('parses a minimal lock with no fingerprints/versions', () => {
    const minimal = `
schema_version: 1
fleet: minimal-fleet
agents: []
`;
    const lock = parseFleetLock(minimal);
    expect(lock.agents).toEqual([]);
    expect(lock.fingerprints).toBeUndefined();
  });
});
