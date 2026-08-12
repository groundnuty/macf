/**
 * Tests for the `fleet.yaml` / `fleet.lock` schema (DR-043 §D1, Slice 1a,
 * groundnuty/macf#838). The valid fixture mirrors the DR's own `icsoc-2026`
 * worked example verbatim.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveAppHandle,
  deriveControlRepoName,
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
    expect(manifest.transport.age_recipients).toEqual([]);
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
  age_recipients: []
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
    // trust is optional-with-default (macf#839 review nit 5) — a MACF fleet
    // always needs a CA, so an omitted `trust:` section defaults rather than
    // staying undefined (a manifest.trust?.-gate would silently skip the CA
    // plan items — see plan.test.ts's "always emits CA items" coverage).
    expect(manifest.trust).toEqual({ ca: 'per-project', federated_cas: [] });
  });
});

describe('parseFleetManifest — transport.age_recipients (macf#852: list, not a single nullable string)', () => {
  // §D5's multi-recipient requirement (operator key + VM key) is the whole
  // reason this field is a list. The SCHEMA itself does not enforce a
  // minimum length — an empty list is the "no key minted yet" state
  // `apply`'s §D5 pre-flight (`wouldCreateWithNoRecipient` in
  // `apply-fleet.ts`) and `writeAgentRecoveryArtifact` (`vault-write.ts`)
  // are the layers that refuse it, deliberately AFTER parse succeeds — see
  // `apply-fleet.test.ts` + `vault-write.test.ts` for that refusal coverage.
  it('accepts a list of two recipients (the §D5 operator-key + VM-key shape)', () => {
    const withTwo = VALID_FLEET_YAML.replace(
      'age_recipients: []',
      'age_recipients: [age1operatorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx, age1vmxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]',
    );
    const manifest = parseFleetManifest(withTwo);
    expect(manifest.transport.age_recipients).toEqual([
      'age1operatorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'age1vmxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ]);
  });

  it('accepts a single-element list (a v1-style single-recipient vault is still valid)', () => {
    const withOne = VALID_FLEET_YAML.replace('age_recipients: []', 'age_recipients: [age1solooperatorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]');
    const manifest = parseFleetManifest(withOne);
    expect(manifest.transport.age_recipients).toEqual(['age1solooperatorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx']);
  });

  it('accepts an empty list — the pre-first-apply "no key minted yet" state', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.transport.age_recipients).toEqual([]);
  });

  it('rejects an empty-string entry in the list (each recipient is still `.min(1)`)', () => {
    const bad = VALID_FLEET_YAML.replace('age_recipients: []', "age_recipients: ['']");
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects the old singular `age_recipient` key (no back-compat — macf#852)', () => {
    const bad = VALID_FLEET_YAML.replace('age_recipients: []', 'age_recipient: null');
    expect(() => parseFleetManifest(bad)).toThrow();
  });
});

describe('parseFleetManifest — transport.vault_repo REMOVED (macf#857, DR-043 Amendment F)', () => {
  // Amendment F: "transport.vault_repo is REMOVED; the vault always lives in
  // the control repo ... Make the bad state unrepresentable — the vault
  // location is derived from the control repo, no knob." `.strict()` makes
  // a reintroduced `vault_repo` key a loud parse rejection, not a silently-
  // ignored field.
  it('rejects a manifest that still declares transport.vault_repo', () => {
    const bad = VALID_FLEET_YAML.replace(
      'transport:\n  age_recipients: []',
      'transport:\n  vault_repo: groundnuty/icsoc-2026-science-agent\n  age_recipients: []',
    );
    expect(() => parseFleetManifest(bad)).toThrow();
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
  age_recipients: []
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

describe('parseFleetManifest — role/repo/name hygiene (macf#839 review [BLOCKING] 1 + 2 + nit 4/5)', () => {
  it('rejects a role starting with the fleet name prefix — the #791 front door', () => {
    const bad = VALID_FLEET_YAML.replace('role: code-agent', 'role: icsoc-2026-code-agent');
    expect(() => parseFleetManifest(bad)).toThrow(/791|double-prefix/);
  });

  it('rejects a bad-charset role (uppercase / underscore)', () => {
    const bad = VALID_FLEET_YAML.replace('role: code-agent', 'role: Code_Agent');
    expect(() => parseFleetManifest(bad)).toThrow(/kebab-case/);
  });

  it('rejects duplicate agents[].role', () => {
    const bad = VALID_FLEET_YAML.replace('role: writer-agent', 'role: code-agent');
    expect(() => parseFleetManifest(bad)).toThrow(/duplicate agents\[\]\.role/);
  });

  it('rejects duplicate agents[].repo', () => {
    const bad = VALID_FLEET_YAML.replace(
      'repo: groundnuty/icsoc-2026\n    provenance: mirror',
      'repo: groundnuty/icsoc-2026-experiment\n    provenance: mirror',
    );
    expect(() => parseFleetManifest(bad)).toThrow(/duplicate agents\[\]\.repo/);
  });

  it('rejects an uppercase metadata.name', () => {
    const bad = VALID_FLEET_YAML.replace('name: icsoc-2026', 'name: ICSOC-2026');
    expect(() => parseFleetManifest(bad)).toThrow(/metadata\.name/);
  });

  it('rejects an underscore-carrying metadata.name', () => {
    const bad = VALID_FLEET_YAML.replace('name: icsoc-2026', 'name: icsoc_2026');
    expect(() => parseFleetManifest(bad)).toThrow(/metadata\.name/);
  });

  it('rejects a non-enum trust.ca value', () => {
    const bad = VALID_FLEET_YAML.replace('ca: per-project', 'ca: shared-org-wide');
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('a well-formed manifest (unique kebab roles/repos, kebab name, per-project ca) still parses clean', () => {
    expect(() => parseFleetManifest(VALID_FLEET_YAML)).not.toThrow();
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

describe('deriveControlRepoName — DR-043 Amendment F (macf#857): <fleet>-control, always derived', () => {
  it('is <fleet>-control, no owner prefix (mirrors deriveAppHandle\'s bare-handle convention)', () => {
    expect(deriveControlRepoName('icsoc-2026')).toBe('icsoc-2026-control');
  });

  it('is a pure string concatenation with no normalization surprises', () => {
    expect(deriveControlRepoName('ppam-2026')).toBe('ppam-2026-control');
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
