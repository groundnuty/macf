/**
 * Tests for the `fleet.yaml` / `fleet.lock` schema (DR-043 §D1, Slice 1a,
 * groundnuty/macf#838). The valid fixture mirrors the DR's own `icsoc-2026`
 * worked example, less the fields the schema has since dropped (already true
 * for `transport.vault_repo`, Amendment F; `trust.ca` stays dropped per
 * groundnuty/macf#1201 — see the dedicated describe blocks below for that
 * sub-field's removal AND `trust.federated_cas`'s #810 reintroduction).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTrustedActorsValue,
  deriveAppHandle,
  deriveControlRepoName,
  effectiveFleetFingerprints,
  parseFleetLock,
  parseFleetManifest,
  isSelfHostedCapableActionsVersion,
  MIN_SELF_HOSTED_CAPABLE_ACTIONS_VERSION,
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

describe('parseFleetManifest — transport.age_recipients_narrowing_override (groundnuty/macf#1230)', () => {
  it('is undefined when omitted — the ordinary case for a fleet that has never narrowed its recipient set', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.transport.age_recipients_narrowing_override).toBeUndefined();
  });

  it('accepts ANY non-empty string at PARSE time — the schema does not enforce the exact acknowledgment text', () => {
    // Schema-level shape only; whether the text is the REQUIRED acknowledgment
    // is `age-recipients-narrowing.ts::checkAgeRecipientsNarrowing`'s job (see
    // that module's test), not `.strict()` schema validation — a wrong/stale
    // override string parses fine and is refused downstream with a diagnostic
    // naming the exact text, rather than a generic "invalid literal" here.
    const withField = VALID_FLEET_YAML.replace(
      'transport:\n  age_recipients: []',
      "transport:\n  age_recipients: []\n  age_recipients_narrowing_override: 'not the real text'",
    );
    const manifest = parseFleetManifest(withField);
    expect(manifest.transport.age_recipients_narrowing_override).toBe('not the real text');
  });

  it('rejects an empty-string value (`.min(1)`, same discipline as every other operator-supplied string field)', () => {
    const bad = VALID_FLEET_YAML.replace(
      'transport:\n  age_recipients: []',
      "transport:\n  age_recipients: []\n  age_recipients_narrowing_override: ''",
    );
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

describe('isSelfHostedCapableActionsVersion (pure, macf#1194)', () => {
  it('MIN_SELF_HOSTED_CAPABLE_ACTIONS_VERSION is v3.4.0 — the origin-routing threshold', () => {
    expect(MIN_SELF_HOSTED_CAPABLE_ACTIONS_VERSION).toBe('v3.4.0');
  });

  it('"main" is always capable', () => {
    expect(isSelfHostedCapableActionsVersion('main')).toBe(true);
  });

  it('a bare major floating ref ("v3") is trusted forward, even though its minor is unknown', () => {
    expect(isSelfHostedCapableActionsVersion('v3')).toBe(true);
  });

  it('a bare major ref below v3 ("v1", "v2") is NOT capable', () => {
    expect(isSelfHostedCapableActionsVersion('v1')).toBe(false);
    expect(isSelfHostedCapableActionsVersion('v2')).toBe(false);
  });

  it('a fully-pinned tag AT the threshold is capable', () => {
    expect(isSelfHostedCapableActionsVersion('v3.4.0')).toBe(true);
  });

  it('a fully-pinned tag ABOVE the threshold (minor and patch) is capable', () => {
    expect(isSelfHostedCapableActionsVersion('v3.4.1')).toBe(true);
    expect(isSelfHostedCapableActionsVersion('v3.5.0')).toBe(true);
  });

  it('DECISIVE: a fully-pinned tag BELOW the threshold is NOT capable, even at the same major', () => {
    expect(isSelfHostedCapableActionsVersion('v3.3.0')).toBe(false);
    expect(isSelfHostedCapableActionsVersion('v3.0.0')).toBe(false);
  });

  it('a floating MINOR ref below the threshold ("v3.3") is NOT capable — it never crosses into v3.4.x', () => {
    expect(isSelfHostedCapableActionsVersion('v3.3')).toBe(false);
  });

  it('a floating MINOR ref AT/above the threshold ("v3.4") is capable', () => {
    expect(isSelfHostedCapableActionsVersion('v3.4')).toBe(true);
  });

  it('a pre-v3 fully-pinned tag (v1.x, v2.x) is NOT capable', () => {
    expect(isSelfHostedCapableActionsVersion('v1.3.5')).toBe(false);
    expect(isSelfHostedCapableActionsVersion('v2.0.1')).toBe(false);
  });

  it('an unparseable ref (a branch name) is NOT capable — genuinely unconfirmable refuses here, never proceeds', () => {
    expect(isSelfHostedCapableActionsVersion('some-feature-branch')).toBe(false);
  });
});

describe('parseFleetManifest — self-hosted + versions.actions capability cross-check (macf#1194)', () => {
  it('DECISIVE 1: self-hosted declared + an INCAPABLE fully-pinned actions version -> REJECTED at parse time', () => {
    const bad = VALID_FLEET_YAML.replace('actions: v3.4.1', 'actions: v3.3.0');
    expect(() => parseFleetManifest(bad)).toThrow(/cannot read MACF_TRUSTED_ACTORS/);
  });

  it('DECISIVE 2: the SAME incapable actions version, but routing.runner is NOT declared self-hosted -> parses clean, unaffected', () => {
    const stillOld = VALID_FLEET_YAML.replace('actions: v3.4.1', 'actions: v3.3.0').replace(
      'routing:\n  runner:\n    runs_on: self-hosted\n\n',
      '',
    );
    const manifest = parseFleetManifest(stillOld);
    expect(manifest.versions?.actions).toBe('v3.3.0');
    expect(manifest.routing).toBeUndefined();
  });

  it('self-hosted declared + a CAPABLE actions version parses clean (the VALID_FLEET_YAML baseline)', () => {
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.versions?.actions).toBe('v3.4.1');
    expect(manifest.routing?.runner.runs_on).toBe('self-hosted');
  });

  it('self-hosted declared + versions.actions OMITTED entirely -> parses clean (defaults to the current floating major tag, always capable)', () => {
    const noVersions = VALID_FLEET_YAML.replace('versions:\n  macf: 0.2.44\n  actions: v3.4.1\n\n', '');
    const manifest = parseFleetManifest(noVersions);
    expect(manifest.versions).toBeUndefined();
    expect(manifest.routing?.runner.runs_on).toBe('self-hosted');
  });

  it('self-hosted declared + a floating major ref ("v3") for actions -> parses clean (trusted forward)', () => {
    const floating = VALID_FLEET_YAML.replace('actions: v3.4.1', 'actions: v3');
    const manifest = parseFleetManifest(floating);
    expect(manifest.versions?.actions).toBe('v3');
  });

  it('names the declared pin, the threshold, and the actual consequence — no internal issue numbers or DR names (citation guard)', () => {
    const bad = VALID_FLEET_YAML.replace('actions: v3.4.1', 'actions: v3.3.0');
    let message = '';
    try {
      parseFleetManifest(bad);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('v3.3.0');
    expect(message).toContain('v3.4.0');
    expect(message).toMatch(/versions\.actions/);
    expect(message).not.toMatch(/#\d+/);
    expect(message).not.toMatch(/DR-\d+/);
    expect(message).not.toMatch(/Amendment/i);
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

  // groundnuty/macf#1374 — the schema-level half of the fix: `registry.type:
  // 'repo'` must REQUIRE `owner` + `repo`, so a self-pointing registry is
  // unrepresentable rather than written and corrected at runtime.
  // `RegistryConfigSchema`'s `RepoRegistryConfigSchema` (`@groundnuty/macf-core`)
  // already makes both fields non-optional — this pins that invariant at the
  // fleet-manifest boundary, since `FleetOwnerSchema.registry` is that exact
  // schema (not a locally-relaxed copy of it).
  it('rejects registry.type: repo with NEITHER owner nor repo declared (macf#1374)', () => {
    const bad = VALID_FLEET_YAML.replace(
      'registry: { type: profile, user: groundnuty }\n\nnetwork:',
      'registry: { type: repo }\n\nnetwork:',
    );
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects registry.type: repo with owner but NO repo (partial targeting, macf#1374)', () => {
    const bad = VALID_FLEET_YAML.replace(
      'registry: { type: profile, user: groundnuty }\n\nnetwork:',
      'registry: { type: repo, owner: groundnuty }\n\nnetwork:',
    );
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects registry.type: repo with repo but NO owner (partial targeting, macf#1374)', () => {
    const bad = VALID_FLEET_YAML.replace(
      'registry: { type: profile, user: groundnuty }\n\nnetwork:',
      'registry: { type: repo, repo: macf-control }\n\nnetwork:',
    );
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('accepts registry.type: repo WITH both owner and repo declared (the shared-control-repo scope macf-trial/macf-fresh actually use, macf#1374)', () => {
    const good = VALID_FLEET_YAML.replace(
      'registry: { type: profile, user: groundnuty }\n\nnetwork:',
      'registry: { type: repo, owner: macf-experiment, repo: macf-trial-control }\n\nnetwork:',
    );
    const manifest = parseFleetManifest(good);
    expect(manifest.owner.registry).toEqual({ type: 'repo', owner: 'macf-experiment', repo: 'macf-trial-control' });
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

describe('parseFleetManifest — trust.federated_cas (groundnuty/macf#810, superseding #1201/#1205)', () => {
  // The decisive pair (assert-the-wrong-path.md): asserting ONLY that a
  // manifest WITHOUT `trust:` still parses (below) would also pass if this
  // PR had deleted the whole feature. Only the "a WELL-FORMED trust.federated_cas
  // parses + a malformed one is rejected" half proves the field actually
  // exists with the shape the ruling specified, not merely that unrelated
  // behaviour survived.

  it('a manifest without a trust: section parses exactly as before — trust is optional, absence changes nothing', () => {
    expect(() => parseFleetManifest(VALID_FLEET_YAML)).not.toThrow();
    const manifest = parseFleetManifest(VALID_FLEET_YAML);
    expect(manifest.trust).toBeUndefined();
  });

  it('parses a well-formed trust.federated_cas entry', () => {
    const withTrust = `${VALID_FLEET_YAML}\ntrust:\n  federated_cas:\n    - project: ppam-2026\n      ca_bundle: |\n        -----BEGIN CERTIFICATE-----\n        abc\n        -----END CERTIFICATE-----\n`;
    const manifest = parseFleetManifest(withTrust);
    expect(manifest.trust?.federated_cas).toEqual([
      { project: 'ppam-2026', ca_bundle: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n' },
    ]);
  });

  it('parses an empty trust.federated_cas list (declared, but nothing federated)', () => {
    const withEmptyTrust = `${VALID_FLEET_YAML}\ntrust:\n  federated_cas: []\n`;
    const manifest = parseFleetManifest(withEmptyTrust);
    expect(manifest.trust?.federated_cas).toEqual([]);
  });

  it('rejects a trust.federated_cas entry missing project', () => {
    const bad = `${VALID_FLEET_YAML}\ntrust:\n  federated_cas:\n    - ca_bundle: cert-pem\n`;
    expect(() => parseFleetManifest(bad)).toThrow(/project/);
  });

  it('rejects a trust.federated_cas entry missing ca_bundle', () => {
    const bad = `${VALID_FLEET_YAML}\ntrust:\n  federated_cas:\n    - project: ppam-2026\n`;
    expect(() => parseFleetManifest(bad)).toThrow(/ca_bundle/);
  });

  it('rejects a trust.federated_cas entry with an empty project string', () => {
    const bad = `${VALID_FLEET_YAML}\ntrust:\n  federated_cas:\n    - project: ""\n      ca_bundle: cert-pem\n`;
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects trust declared without federated_cas at all', () => {
    const bad = `${VALID_FLEET_YAML}\ntrust: {}\n`;
    expect(() => parseFleetManifest(bad)).toThrow(/federated_cas/);
  });

  it('rejects an unrecognized key under trust: (no type/scope/per-agent field — #810 ruling)', () => {
    const bad = `${VALID_FLEET_YAML}\ntrust:\n  federated_cas: []\n  scope: everything\n`;
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('rejects an unrecognized key on one federated_cas entry (e.g. a per-agent field)', () => {
    const bad = `${VALID_FLEET_YAML}\ntrust:\n  federated_cas:\n    - project: ppam-2026\n      ca_bundle: cert-pem\n      agent: code-agent\n`;
    expect(() => parseFleetManifest(bad)).toThrow();
  });

  it('still refuses the removed trust.ca sub-field, with a targeted explanation naming the replacement — not a bare .strict() unrecognized-key error', () => {
    const stillDeclaresTrustCa = `${VALID_FLEET_YAML}\ntrust:\n  ca: per-project\n  federated_cas: []\n`;
    expect(() => parseFleetManifest(stillDeclaresTrustCa)).toThrow(/trust\.ca/i);
    try {
      parseFleetManifest(stillDeclaresTrustCa);
      expect.unreachable('parseFleetManifest should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // NOT the generic zod `.strict()` message — a targeted explanation.
      expect(message).not.toMatch(/unrecognized key/i);
      // Names the replacement field.
      expect(message).toMatch(/federated_cas/);
      // States the removal (not merely "unsupported" or "unknown").
      expect(message).toMatch(/removed/i);
      // No internal issue/DR citation in user-facing text (macf#1061).
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
  // groundnuty/macf#1310 — this fixture DELIBERATELY uses the DEPRECATED
  // bare top-level `fingerprints:` key (the shape every already-provisioned
  // fleet's `fleet.lock` is in right now, including `macf-trial`'s live
  // artifact the issue quotes) — every test below exercises "an old-key
  // lock parses correctly" by construction. The per-agent `fingerprints:`
  // nested under `agents[0]` is the UNRELATED, never-renamed field.
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
    // groundnuty/macf#1310 — the raw legacy key is still readable directly
    // (schema back-compat), but `fleet_fingerprints` (the new key) is
    // genuinely absent from this YAML — never fabricated by the parse.
    expect(lock.fingerprints).toEqual({ ca_key: 'sha256:feedface' });
    expect(lock.fleet_fingerprints).toBeUndefined();
    expect(effectiveFleetFingerprints(lock)).toEqual({ ca_key: 'sha256:feedface' });
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

  // groundnuty/macf#1296 — FleetLockAgentSchema gains an optional `repo`
  // field so an orphaned role can still be NAMED (`#1281`'s orphan URL) and
  // a secret delete can resolve its target (`#1272`).
  describe('agents[].repo (groundnuty/macf#1296)', () => {
    it('parses an agent with a declared repo', () => {
      const withRepo = VALID_LOCK_YAML.replace('install_id: "22222222"', 'install_id: "22222222"\n    repo: groundnuty/icsoc-2026-science-agent');
      const lock = parseFleetLock(withRepo);
      expect(lock.agents[0]?.repo).toBe('groundnuty/icsoc-2026-science-agent');
    });

    // DECISIVE (backward-compat half): a lock written before this field
    // existed — every fleet's lock, pre-#1296 — must parse with `repo`
    // UNDEFINED, never a fabricated empty string or absent-therefore-known
    // value. This is `#1252`'s exact lesson (see `FleetLockAgentSchema`'s
    // own doc): undefined is unknown, not a fact.
    it('DECISIVE: a pre-#1296 lock (no repo key at all) parses fine, with repo undefined — never a fact, never fabricated', () => {
      const lock = parseFleetLock(VALID_LOCK_YAML);
      expect(lock.agents[0]?.repo).toBeUndefined();
      expect('repo' in (lock.agents[0] as object)).toBe(false);
    });

    it('rejects an empty-string repo (min(1), same discipline as role/app_id/install_id)', () => {
      const bad = VALID_LOCK_YAML.replace('install_id: "22222222"', 'install_id: "22222222"\n    repo: ""');
      expect(() => parseFleetLock(bad)).toThrow();
    });
  });

  // groundnuty/macf#1330 — FleetLockSchema gains an optional `collaborators`
  // array, the LAST-APPROVED age recipient set per federated peer (see
  // `FleetLockCollaboratorSchema`'s own doc for why this lives on the lock,
  // not `FleetCollaboratorSchema` in the manifest).
  describe('collaborators (groundnuty/macf#1330 — federated peer recipient sets)', () => {
    it('parses a lock declaring a federated collaborator with a recorded set', () => {
      const withCollaborator = `${VALID_LOCK_YAML}collaborators:\n  - project: ppam-2026\n    age_recipients:\n      - age1a\n      - age1b\n`;
      const lock = parseFleetLock(withCollaborator);
      expect(lock.collaborators).toEqual([{ project: 'ppam-2026', age_recipients: ['age1a', 'age1b'] }]);
    });

    // DECISIVE: every existing fleet's lock predates this field — a lock
    // with no `collaborators:` key at all must parse with the field
    // UNDEFINED, never a fabricated empty array. `#1252`'s exact lesson,
    // restated for the federated case per `#1330`'s own AC.
    it('DECISIVE: a lock with no "collaborators" key parses fine, with collaborators undefined — never fabricated', () => {
      const lock = parseFleetLock(VALID_LOCK_YAML);
      expect(lock.collaborators).toBeUndefined();
      expect('collaborators' in lock).toBe(false);
    });

    // DECISIVE: an entry's age_recipients: [] is a REAL, recorded fact (this
    // peer had zero recipients at last approval) — distinct from the entry
    // being absent entirely (unknown). Must parse, not be rejected or
    // silently coerced.
    it('DECISIVE: a collaborator entry with an explicit empty age_recipients parses as a real recorded fact, not a schema violation', () => {
      const withEmpty = `${VALID_LOCK_YAML}collaborators:\n  - project: ppam-2026\n    age_recipients: []\n`;
      const lock = parseFleetLock(withEmpty);
      expect(lock.collaborators).toEqual([{ project: 'ppam-2026', age_recipients: [] }]);
    });

    it('rejects a collaborator entry missing age_recipients entirely (required, not optional — unlike the entry\'s own presence in the array)', () => {
      const missing = `${VALID_LOCK_YAML}collaborators:\n  - project: ppam-2026\n`;
      expect(() => parseFleetLock(missing)).toThrow();
    });

    it('rejects a collaborator entry with an empty-string project (min(1), same discipline as agents[].role)', () => {
      const bad = `${VALID_LOCK_YAML}collaborators:\n  - project: ""\n    age_recipients: []\n`;
      expect(() => parseFleetLock(bad)).toThrow();
    });

    it('rejects an unknown key inside a collaborator entry (typo protection, same .strict() discipline as every other lock sub-schema)', () => {
      const bad = `${VALID_LOCK_YAML}collaborators:\n  - project: ppam-2026\n    age_recipients: []\n    ca_bundle: "not-a-lock-field"\n`;
      expect(() => parseFleetLock(bad)).toThrow();
    });

    it('parses multiple federated peers, each with its own independently-recorded set', () => {
      const multi = `${VALID_LOCK_YAML}collaborators:\n  - project: ppam-2026\n    age_recipients:\n      - age1a\n  - project: other-fleet\n    age_recipients: []\n`;
      const lock = parseFleetLock(multi);
      expect(lock.collaborators).toEqual([
        { project: 'ppam-2026', age_recipients: ['age1a'] },
        { project: 'other-fleet', age_recipients: [] },
      ]);
    });
  });

  // groundnuty/macf#1310 — `fleet_fingerprints` (fleet-level) vs
  // `fingerprints` (per-agent, unchanged) naming-collision fix. Science's
  // ruling: "fingerprints at fleet level and fingerprints per agent should
  // not be the same word." The fleet-level field was renamed; the
  // deprecated bare key stays schema-legal (read-only) so an
  // already-provisioned fleet's `fleet.lock` keeps parsing without a
  // re-apply. See `effectiveFleetFingerprints`'s own doc for the accessor
  // every reader must go through instead of either key directly.
  describe('fleet_fingerprints / fingerprints rename (groundnuty/macf#1310)', () => {
    it('DECISIVE (new key): a lock already on the post-#1310 `fleet_fingerprints` key parses correctly', () => {
      const yaml = `
schema_version: 1
fleet: icsoc-2026
agents: []
fleet_fingerprints:
  ca_key: sha256:feedface
`;
      const lock = parseFleetLock(yaml);
      expect(lock.fleet_fingerprints).toEqual({ ca_key: 'sha256:feedface' });
      expect(lock.fingerprints).toBeUndefined();
      expect(effectiveFleetFingerprints(lock)).toEqual({ ca_key: 'sha256:feedface' });
    });

    it('DECISIVE (old key): a lock still on the deprecated `fingerprints` key parses correctly — reads via effectiveFleetFingerprints', () => {
      const lock = parseFleetLock(VALID_LOCK_YAML);
      expect(lock.fingerprints).toEqual({ ca_key: 'sha256:feedface' });
      expect(lock.fleet_fingerprints).toBeUndefined();
      expect(effectiveFleetFingerprints(lock)).toEqual({ ca_key: 'sha256:feedface' });
    });

    it('a lock with NEITHER key present resolves to undefined, never a fabricated {}', () => {
      const minimal = `
schema_version: 1
fleet: minimal-fleet
agents: []
`;
      const lock = parseFleetLock(minimal);
      expect(effectiveFleetFingerprints(lock)).toBeUndefined();
    });

    it('a lock carrying BOTH keys (a hand-built/transitional shape) prefers the NEW key — never merges them', () => {
      const yaml = `
schema_version: 1
fleet: icsoc-2026
agents: []
fleet_fingerprints:
  ca_key: sha256:newkey
fingerprints:
  ca_key: sha256:oldkey
`;
      const lock = parseFleetLock(yaml);
      expect(effectiveFleetFingerprints(lock)).toEqual({ ca_key: 'sha256:newkey' });
    });

    // The whole point of the rename: neither fingerprints STRUCTURE can be
    // mistaken for the other, even when both are populated with disjoint
    // key sets and disjoint values on the SAME parsed lock.
    it('the fleet-level and per-agent fingerprints structures are never mistaken for one another', () => {
      const lock = parseFleetLock(VALID_LOCK_YAML);
      const fleetLevel = effectiveFleetFingerprints(lock);
      const perAgent = lock.agents[0]?.fingerprints;
      expect(fleetLevel).toEqual({ ca_key: 'sha256:feedface' });
      expect(perAgent).toEqual({ app_private_key: 'sha256:abc123', client_secret: 'sha256:def456' });
      expect(fleetLevel).not.toEqual(perAgent);
      // Different keys entirely — "ca_key" is a fleet-level concept and
      // never appears on the per-agent map, by construction of what each
      // scope actually establishes (CA/routing-client vs per-agent App
      // secrets).
      expect(Object.keys(perAgent ?? {})).not.toContain('ca_key');
    });
  });
});

/**
 * Regression guard, in the shape groundnuty/macf#1192's read-only WHY-guard
 * used: a source scan over production code, so a future contributor cannot
 * quietly re-add a `trust.ca` consumer without this test noticing. Narrowed
 * from its pre-`#810` form (which banned ANY `manifest.trust` /
 * `FleetTrustSchema` / `.trust.federated_cas` reference) — `#810` legitimately
 * reintroduced `trust.federated_cas` WITH a real consumer
 * (`apply-federated-trust.ts`), so banning bare `manifest.trust` access or
 * `FleetTrustSchema` would now fire on the feature this test suite exists to
 * cover. Only `trust.ca` stays banned: `#1201` removed it, `#810`'s ruling
 * never reintroduced it (`FleetTrustSchema` has no `ca` field — see
 * `fleet-manifest.ts`), and a bypass of the type system (e.g. `(manifest.trust
 * as any).ca`) is exactly the "declared but inert" shape this guard exists to
 * catch, now scoped to the one sub-field that is actually still gone.
 */
describe('trust.ca leaves no code-path consumer behind (groundnuty/macf#1201 source-scan regression, narrowed for #810)', () => {
  const BANNED_TRUST_CA_CONSUMER_PATTERN = /\.trust\.ca\b/;

  function isCommentLine(trimmed: string): boolean {
    return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
  }

  /** Lines matching the banned pattern, outside comments — a "hit" means a live code path, not prose explaining the removal. */
  function scanForTrustCaConsumer(source: string): readonly string[] {
    return source.split('\n').filter((line) => BANNED_TRUST_CA_CONSUMER_PATTERN.test(line) && !isCommentLine(line.trim()));
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
  it('FIRES on a deliberately-reintroduced trust.ca consumer', () => {
    const bad = 'if (manifest.trust.ca !== undefined) { doSomething(manifest.trust.ca); }';
    expect(scanForTrustCaConsumer(bad).length).toBeGreaterThan(0);
  });

  it('does NOT fire on a comment mentioning the removed field for historical context', () => {
    const ok = '// trust.ca was removed, groundnuty/macf#1201 — never reintroduced by #810.';
    expect(scanForTrustCaConsumer(ok)).toEqual([]);
  });

  it('does NOT fire on the legitimate trust.federated_cas consumer this issue (#810) adds', () => {
    const ok = 'for (const entry of manifest.trust?.federated_cas ?? []) { publish(entry); }';
    expect(scanForTrustCaConsumer(ok)).toEqual([]);
  });

  it('does NOT fire on the presence-only refusal check — it tests for the KEY, never reads a value', () => {
    // The literal shape `rejectDeclaredTrustCa` uses: no `.trust.ca` property
    // access anywhere (only an `in` check), so this must NOT be flagged.
    const ok = "if (typeof trust !== 'object' || trust === null || !('ca' in trust)) return;";
    expect(scanForTrustCaConsumer(ok)).toEqual([]);
  });

  // --- The real guard: the actual source tree carries no consumer --------
  it('the real packages/macf/src tree carries no trust.ca consumer outside comments', () => {
    const srcDir = fileURLToPath(new URL('../../../src', import.meta.url));
    const files = listTsFilesRecursive(srcDir);
    expect(files.length).toBeGreaterThan(50); // sanity: the walker found the tree, not an empty dir

    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      const hits = scanForTrustCaConsumer(source);
      if (hits.length > 0) violations.push(`${file}:\n  ${hits.join('\n  ')}`);
    }
    expect(violations).toEqual([]);
  });
});
