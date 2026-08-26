/**
 * Tests for the `fleet.yaml` / `fleet.lock` schema (DR-043 §D1, Slice 1a,
 * groundnuty/macf#838). The valid fixture mirrors the DR's own `icsoc-2026`
 * worked example, less the fields the schema has since dropped (already true
 * for `transport.vault_repo`, Amendment F; as of groundnuty/macf#1201, also
 * true for `trust:` — see the dedicated describe block below for that
 * removal's own coverage).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTrustedActorsValue,
  deriveAppHandle,
  deriveControlRepoName,
  parseFleetLock,
  parseFleetManifest,
  FLEET_LOCK_SCHEMA_VERSION,
} from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { FleetAgent } from '../../../src/cli/bootstrap/fleet-manifest.js';

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

  it('parses routing and shared', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    // macf#942 (DR-043 Amendment I) — `warm` defaults to 1 even though the
    // worked example above never declares it; see the dedicated "warm"
    // describe block below for the full default/range/coverage story.
    expect(manifest.routing).toEqual({ runner: { runs_on: 'self-hosted', warm: 1 } });
    expect(manifest.shared).toEqual({ routing_app: 'macf-routing', ts_oauth: 'operator-supplied' });
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

describe('parseFleetManifest — transport.runner_platform_endpoint (groundnuty/macf#1211)', () => {
  it('is undefined when omitted — the expected steady state once a scope variable exists', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.transport.runner_platform_endpoint).toBeUndefined();
  });

  it('accepts a declared value — the narrow per-fleet escape hatch', () => {
    const withField = VALID_FLEET_YAML.replace(
      'transport:\n  age_recipients: []',
      'transport:\n  age_recipients: []\n  runner_platform_endpoint: http://orzech-dev-agents-monitoring.tail491af.ts.net:8088',
    );
    const manifest = parseFleetManifest(withField);
    expect(manifest.transport.runner_platform_endpoint).toBe('http://orzech-dev-agents-monitoring.tail491af.ts.net:8088');
  });

  it('rejects an empty-string value (`.min(1)`, same discipline as every other operator-supplied string field)', () => {
    const bad = VALID_FLEET_YAML.replace('transport:\n  age_recipients: []', "transport:\n  age_recipients: []\n  runner_platform_endpoint: ''");
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

describe('parseFleetManifest — routing.runner.labels cross-check against ROUTER_EMITTED_LABELS (macf#934)', () => {
  it('omitting routing.runner.labels entirely still parses clean (the pre-macf#934 default; convention applies)', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.routing?.runner.labels).toBeUndefined();
  });

  it('a declared label set that is EXACTLY the router-emitted set parses clean', () => {
    const withLabels = VALID_FLEET_YAML.replace(
      'routing:\n  runner:\n    runs_on: self-hosted',
      'routing:\n  runner:\n    runs_on: self-hosted\n    labels: [self-hosted, macf-vm]',
    );
    const manifest = parseFleetManifest(withLabels);
    expect(manifest.routing?.runner.labels).toEqual(['self-hosted', 'macf-vm']);
  });

  it('a declared label set that is a SUPERSET of the router-emitted set (extra labels) parses clean — superset, not equality', () => {
    const withLabels = VALID_FLEET_YAML.replace(
      'routing:\n  runner:\n    runs_on: self-hosted',
      'routing:\n  runner:\n    runs_on: self-hosted\n    labels: [self-hosted, macf-vm, gpu]',
    );
    const manifest = parseFleetManifest(withLabels);
    expect(manifest.routing?.runner.labels).toEqual(['self-hosted', 'macf-vm', 'gpu']);
  });

  it('a declared label set MISSING a router-emitted label is REJECTED at parse time, naming the missing label — the macf#934 worked example', () => {
    const withLabels = VALID_FLEET_YAML.replace(
      'routing:\n  runner:\n    runs_on: self-hosted',
      'routing:\n  runner:\n    runs_on: self-hosted\n    labels: [self-hosted, arc-runner]',
    );
    expect(() => parseFleetManifest(withLabels)).toThrow(/macf-vm/);
  });

  it('a declared label set missing EVERY router-emitted label names both, in ROUTER_EMITTED_LABELS order', () => {
    const withLabels = VALID_FLEET_YAML.replace(
      'routing:\n  runner:\n    runs_on: self-hosted',
      'routing:\n  runner:\n    runs_on: self-hosted\n    labels: [arc-runner]',
    );
    expect(() => parseFleetManifest(withLabels)).toThrow(/missing: \[self-hosted, macf-vm\]/);
  });
});

describe('parseFleetManifest — routing.runner.warm (macf#942, DR-043 Amendment I, DR-009 §7.4)', () => {
  function withWarm(value: string): string {
    return VALID_FLEET_YAML.replace(
      'routing:\n  runner:\n    runs_on: self-hosted',
      `routing:\n  runner:\n    runs_on: self-hosted\n    warm: ${value}`,
    );
  }

  it.each([0, 1, 5])('warm: %i parses, and the PARSED value round-trips exactly (not just "parses without throwing")', (value) => {
    const manifest = parseFleetManifest(withWarm(String(value)));
    expect(manifest.routing?.runner.warm).toBe(value);
  });

  it('omitting warm entirely defaults the PARSED value to 1 (DR-009 §7.4 — mandatory, not a default to tune)', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.routing?.runner.warm).toBe(1);
  });

  it('rejects a negative warm value', () => {
    expect(() => parseFleetManifest(withWarm('-1'))).toThrow();
  });

  it('rejects a non-integer warm value', () => {
    expect(() => parseFleetManifest(withWarm('1.5'))).toThrow();
  });

  it('rejects a non-numeric warm value', () => {
    expect(() => parseFleetManifest(withWarm('"dormant"'))).toThrow();
  });

  it('a manifest without routing.runner declared at all still parses unchanged — warm never fires a gate on a fleet with no routing section', () => {
    const minimal = VALID_FLEET_YAML.replace(/routing:\n {2}runner:\n {4}runs_on: self-hosted\n\n/, '');
    const manifest = parseFleetManifest(minimal);
    expect(manifest.routing).toBeUndefined();
  });

  // macf#942 §"Do NOT add `name` or `scope`" — pins that `.strict()` is
  // still intact on `FleetRoutingRunnerSchema` after this change; adding
  // `warm` must not have loosened the schema for OTHER unknown keys.
  it('still REJECTS `name` on routing.runner — `.strict()` is intact', () => {
    const bad = VALID_FLEET_YAML.replace(
      'routing:\n  runner:\n    runs_on: self-hosted',
      'routing:\n  runner:\n    runs_on: self-hosted\n    name: some-runner',
    );
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('still REJECTS `scope` on routing.runner — `.strict()` is intact', () => {
    const bad = VALID_FLEET_YAML.replace(
      'routing:\n  runner:\n    runs_on: self-hosted',
      'routing:\n  runner:\n    runs_on: self-hosted\n    scope: org',
    );
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('still REJECTS `name` AND `scope` together, even alongside a valid warm value', () => {
    const bad = VALID_FLEET_YAML.replace(
      'routing:\n  runner:\n    runs_on: self-hosted',
      'routing:\n  runner:\n    runs_on: self-hosted\n    warm: 1\n    name: some-runner\n    scope: org',
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

  it('a well-formed manifest (unique kebab roles/repos, kebab name) still parses clean', () => {
    expect(() => parseFleetManifest(VALID_FLEET_YAML)).not.toThrow();
  });
});

describe('parseFleetManifest — trust: is removed (groundnuty/macf#1201)', () => {
  // The decisive pair (assert-the-wrong-path.md): asserting ONLY that a
  // manifest WITHOUT `trust:` still parses (below) would also pass if this
  // PR had deleted far more than intended — e.g. the whole CA-plan-item
  // guarantee, or `FleetManifestSchema` itself. Only the "WITH trust: gets a
  // specific, non-generic refusal" half proves the trust-specific removal
  // behaves as decided, not merely that unrelated behaviour survived.

  it('refuses a manifest that still declares a trust: section, with a targeted explanation — not a bare .strict() unrecognized-key error', () => {
    // Uses the OLD valid shape (`ca: per-project`, `federated_cas: []`) —
    // proves the refusal fires on the KEY's mere presence, independent of
    // whether its (former) contents would themselves have validated.
    const stillDeclaresTrust = `${VALID_FLEET_YAML}\ntrust:\n  ca: per-project\n  federated_cas: []\n`;
    expect(() => parseFleetManifest(stillDeclaresTrust)).toThrow(/trust/i);
    try {
      parseFleetManifest(stillDeclaresTrust);
      expect.unreachable('parseFleetManifest should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // NOT the generic zod `.strict()` message — a targeted explanation.
      expect(message).not.toMatch(/unrecognized key/i);
      // Says it was never enforced (not merely "unsupported" or "unknown").
      expect(message).toMatch(/never (read|enforced)|no code path/i);
      // States the safe action.
      expect(message).toMatch(/remove/i);
    }
  });

  it('a manifest without a trust: section parses exactly as before — unaffected by the removal', () => {
    expect(() => parseFleetManifest(VALID_FLEET_YAML)).not.toThrow();
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest).not.toHaveProperty('trust');
  });

  it('the refusal message names the field but carries no internal issue/DR citation (user-facing text, macf#1061)', () => {
    const stillDeclaresTrust = `${VALID_FLEET_YAML}\ntrust:\n  ca: per-project\n  federated_cas: []\n`;
    try {
      parseFleetManifest(stillDeclaresTrust);
      expect.unreachable('parseFleetManifest should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toMatch(/\bmacf#\d+\b|\bgroundnuty\/macf#\d+\b|\bDR-0\d{2}\b|#\d+/);
    }
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

function agent(role: string, repo: string): FleetAgent {
  return { role, profile: 'x', repo, deploy_path: '/x' };
}

describe('buildTrustedActorsValue — MACF_TRUSTED_ACTORS shape (macf#922)', () => {
  it('space-joins every agent\'s <deriveAppHandle>[bot] login, in agents[] order', () => {
    const agents = [agent('code-agent', 'groundnuty/a'), agent('science-agent', 'groundnuty/b')];
    expect(buildTrustedActorsValue('icsoc-2026', agents)).toBe(
      'icsoc-2026-code-agent[bot] icsoc-2026-science-agent[bot]',
    );
  });

  it('every entry carries the [bot] suffix — NOT the bare deriveAppHandle output', () => {
    const value = buildTrustedActorsValue('macf', [agent('devops-agent', 'groundnuty/x')]);
    expect(value).toBe('macf-devops-agent[bot]');
    expect(value).not.toBe(deriveAppHandle('macf', 'devops-agent'));
  });

  it('a single agent produces no separator artifacts', () => {
    expect(buildTrustedActorsValue('ppam-2026', [agent('writer-agent', 'groundnuty/x')])).toBe('ppam-2026-writer-agent[bot]');
  });

  it('an empty agents[] produces an empty string (schema forbids this in practice — agents is .min(1) — but the function itself stays total)', () => {
    expect(buildTrustedActorsValue('icsoc-2026', [])).toBe('');
  });

  it('is space-separated, never comma or JSON — macf-devops-toolkit RUNNER.md: a JSON array silently fails to match', () => {
    const value = buildTrustedActorsValue('icsoc-2026', [agent('code-agent', 'groundnuty/a'), agent('science-agent', 'groundnuty/b')]);
    expect(value).not.toContain(',');
    expect(value).not.toMatch(/^\[.*\]$/);
    expect(value.split(' ')).toEqual(['icsoc-2026-code-agent[bot]', 'icsoc-2026-science-agent[bot]']);
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

/**
 * Regression guard, in the shape groundnuty/macf#1192's read-only WHY-guard
 * used: a source scan over production code, so a future contributor cannot
 * quietly re-add a `trust`-field consumer without this test noticing — the
 * exact "declared but inert" trap groundnuty/macf#1201 removed `trust.ca` /
 * `trust.federated_cas` to close. Deliberately narrower than "the word
 * trust" (which appears constantly for MACF_TRUSTED_ACTORS / trust bundles /
 * DR-041 federation — an unrelated, actively-consumed concept, see
 * `trust-bundle.ts`): this pattern targets only the REMOVED schema's own
 * identifiers and property-access shape.
 */
describe('trust: leaves no code-path consumer behind (groundnuty/macf#1201 source-scan regression)', () => {
  const BANNED_TRUST_CONSUMER_PATTERN = /\bFleetTrustSchema\b|\bFleetTrust\b|\bmanifest\.trust\b|\.trust\.(ca|federated_cas)\b/;

  function isCommentLine(trimmed: string): boolean {
    return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
  }

  /** Lines matching the banned pattern, outside comments — a "hit" means a live code path, not prose explaining the removal. */
  function scanForTrustConsumer(source: string): readonly string[] {
    return source.split('\n').filter((line) => BANNED_TRUST_CONSUMER_PATTERN.test(line) && !isCommentLine(line.trim()));
  }

  function listTsFilesRecursive(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listTsFilesRecursive(full));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  // --- Decisive: prove the scanner actually fires (assert-the-wrong-path.md) ---
  it('FIRES on a deliberately-reintroduced trust-field consumer', () => {
    const bad = 'if (manifest.trust !== undefined) { doSomething(manifest.trust.federated_cas); }';
    expect(scanForTrustConsumer(bad).length).toBeGreaterThan(0);
  });

  it('does NOT fire on a comment mentioning the removed field for historical context', () => {
    const ok = '// trust.ca / trust.federated_cas were removed, groundnuty/macf#1201 — see FleetTrust in git history.';
    expect(scanForTrustConsumer(ok)).toEqual([]);
  });

  it('does NOT fire on the presence-only refusal check — it tests for the KEY, never reads a value', () => {
    // The literal shape `rejectDeclaredTrust` uses: no `.trust` property
    // access anywhere, so this must NOT be flagged as a "consumer".
    const ok = "if (typeof raw !== 'object' || raw === null || !('trust' in raw)) return;";
    expect(scanForTrustConsumer(ok)).toEqual([]);
  });

  // --- The real guard: the actual source tree carries no consumer --------
  it('the real packages/macf/src tree carries no trust-field consumer outside comments', () => {
    const srcDir = fileURLToPath(new URL('../../../src', import.meta.url));
    const files = listTsFilesRecursive(srcDir);
    expect(files.length).toBeGreaterThan(50); // sanity: the walker found the tree, not an empty dir

    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      const hits = scanForTrustConsumer(source);
      if (hits.length > 0) violations.push(`${file}:\n  ${hits.join('\n  ')}`);
    }
    expect(violations).toEqual([]);
  });
});
