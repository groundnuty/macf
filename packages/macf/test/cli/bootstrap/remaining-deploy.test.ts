/**
 * Tests for `remaining-deploy.ts` — the DR-043 §D2 "honest completion"
 * report (groundnuty/macf#1014): which declared agents have no local
 * workspace yet, and the exact `macf fleet deploy` command for each. Fully
 * offline: `exists` is a hand-scripted fake, no real filesystem probe.
 */
import { describe, it, expect } from 'vitest';
import { resolve as resolvePath } from 'node:path';
import {
  computeRemainingDeploy,
  formatRemainingDeployLines,
  DEPLOY_IDENTITY_KEY_PLACEHOLDER,
} from '../../../src/cli/bootstrap/remaining-deploy.js';
import { parseFleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';

const MANIFEST_PATH = '/fake/fleet/fleet.yaml';

const TWO_AGENT_YAML = `apiVersion: macf/v0
kind: Fleet
metadata:
  name: demo-fleet
owner:
  account: groundnuty
  type: user
  registry: { type: profile, user: groundnuty }
network:
  advertise_host: example.ts.net
transport:
  age_recipients: [age1qtestrecipientxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx]
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: groundnuty/demo-code
    deploy_path: /fake/workspaces/code-agent
  - role: science-agent
    profile: research
    repo: groundnuty/demo-science
    deploy_path: /fake/workspaces/science-agent
`;

const MANIFEST = parseFleetManifest(TWO_AGENT_YAML);

describe('computeRemainingDeploy', () => {
  it('the decisive case: fleet with no workspaces names EVERY agent + a copy-pasteable command per agent', () => {
    // Neither leaf nor parent exists ANYWHERE in this fake fs, EXCEPT the
    // shared workspaces/ parent — the realistic "operator set up the parent
    // dir, hasn't deployed into it yet" shape.
    const exists = (p: string): boolean => p === '/fake/workspaces';
    const { steps } = computeRemainingDeploy(MANIFEST, MANIFEST_PATH, {}, exists);

    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.role)).toEqual(['code-agent', 'science-agent']);
    for (const step of steps) {
      expect(step.presence).toBe('not-deployed');
      expect(step.reason).toBeUndefined();
      // Specific agent + specific command — not merely "some text was printed".
      expect(step.command).toBe(`macf fleet deploy --agent ${step.role} -f ${MANIFEST_PATH} --identity-key ${DEPLOY_IDENTITY_KEY_PLACEHOLDER}`);
    }
  });

  it('a deploy_path whose parent ALSO does not exist is reported as unknown, never not-deployed', () => {
    const { steps } = computeRemainingDeploy(MANIFEST, MANIFEST_PATH, {}, () => false);

    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.presence).toBe('unknown');
      expect(step.presence).not.toBe('not-deployed');
      expect(step.reason).toContain('does not exist on this host');
      expect(step.reason).toContain('multi-host fleet');
    }
  });

  it('a fully-deployed fleet reports nothing remaining — no nagging, no vault note', () => {
    const report = computeRemainingDeploy(MANIFEST, MANIFEST_PATH, {}, () => true);
    expect(report.steps).toEqual([]);
    expect(report.vaultLocationNote).toBeUndefined();
  });

  it('a partially-deployed fleet reports only the missing agent, not the present one', () => {
    const exists = (p: string): boolean => p === resolvePath('/fake/workspaces/code-agent') || p === '/fake/workspaces';
    const { steps } = computeRemainingDeploy(MANIFEST, MANIFEST_PATH, {}, exists);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.role).toBe('science-agent');
  });

  it('echoes --vault/--identity-key verbatim when apply itself was invoked with them, and omits the vault-location note', () => {
    const report = computeRemainingDeploy(
      MANIFEST,
      MANIFEST_PATH,
      { vaultPath: '/fake/fleet/secrets/vault.age', identityKeyPath: '/home/op/age-key.txt' },
      () => false,
    );
    for (const step of report.steps) {
      expect(step.command).toBe(
        `macf fleet deploy --agent ${step.role} -f ${MANIFEST_PATH} --vault /fake/fleet/secrets/vault.age --identity-key /home/op/age-key.txt`,
      );
    }
    // The operator already gave a real --vault — nothing to warn about.
    expect(report.vaultLocationNote).toBeUndefined();
  });

  it('omits --vault (letting deploy default identically) and ADDS the vault-location note when apply was NOT given --vault', () => {
    const report = computeRemainingDeploy(MANIFEST, MANIFEST_PATH, { identityKeyPath: '/home/op/age-key.txt' }, () => false);
    for (const step of report.steps) {
      expect(step.command).not.toContain('--vault');
    }
    expect(report.vaultLocationNote).toContain('demo-fleet-control');
    expect(report.vaultLocationNote).toContain('--vault');
    expect(report.vaultLocationNote).toContain('git pull');
  });

  it('resolves deploy_path the SAME way commands/fleet-deploy.ts resolves it (path.resolve, cwd-relative)', () => {
    const relativeYaml = TWO_AGENT_YAML.replace('/fake/workspaces/code-agent', 'workspaces/code-agent');
    const manifest = parseFleetManifest(relativeYaml);
    const { steps } = computeRemainingDeploy(manifest, MANIFEST_PATH, {}, () => false);
    const codeAgentStep = steps.find((s) => s.role === 'code-agent');
    expect(codeAgentStep?.deployPath).toBe(resolvePath('workspaces/code-agent'));
  });

  it('the --identity-key placeholder carries no shell metacharacters (never angle-bracket-wrapped)', () => {
    expect(DEPLOY_IDENTITY_KEY_PLACEHOLDER).not.toMatch(/[<>]/);
  });

  it('never emits secret material — no PEM/key content in path, reason, command, or vault note', () => {
    const report = computeRemainingDeploy(MANIFEST, MANIFEST_PATH, { identityKeyPath: '/home/op/age-key.txt' }, () => false);
    const all = JSON.stringify(report);
    expect(all).not.toContain('-----BEGIN');
    expect(all).not.toMatch(/age1[a-z0-9]{20,}/);
  });
});

describe('formatRemainingDeployLines', () => {
  it('renders NOTHING for a complete fleet — no nagging (requirement 5)', () => {
    expect(formatRemainingDeployLines({ steps: [] })).toEqual([]);
  });

  it('names the specific role + the exact command for a not-deployed agent, host-scoped', () => {
    const lines = formatRemainingDeployLines({
      steps: [
        {
          role: 'code-agent',
          deployPath: '/fake/workspaces/code-agent',
          presence: 'not-deployed',
          command: `macf fleet deploy --agent code-agent -f /fake/fleet/fleet.yaml --identity-key ${DEPLOY_IDENTITY_KEY_PLACEHOLDER}`,
        },
      ],
    });
    const text = lines.join('\n');
    expect(text).toContain('code-agent');
    expect(text).toContain('NOT DEPLOYED');
    // Host-scoped, never a fleet-wide absence claim.
    expect(text).toContain('on this host');
    expect(text).toContain('macf fleet deploy --agent code-agent');
    expect(text).not.toContain('UNKNOWN');
  });

  it('renders UNKNOWN (never NOT DEPLOYED) for an unknown-presence step', () => {
    const lines = formatRemainingDeployLines({
      steps: [
        {
          role: 'science-agent',
          deployPath: '/elsewhere/science-agent',
          presence: 'unknown',
          reason: 'parent directory /elsewhere does not exist on this host',
          command: `macf fleet deploy --agent science-agent -f /fake/fleet/fleet.yaml --identity-key ${DEPLOY_IDENTITY_KEY_PLACEHOLDER}`,
        },
      ],
    });
    const text = lines.join('\n');
    expect(text).toContain('UNKNOWN');
    expect(text).not.toContain('NOT DEPLOYED');
    expect(text).toContain('parent directory /elsewhere does not exist');
  });

  it('renders the vault-location note once, ahead of the per-agent lines, when present', () => {
    const lines = formatRemainingDeployLines({
      steps: [
        {
          role: 'code-agent',
          deployPath: '/fake/workspaces/code-agent',
          presence: 'not-deployed',
          command: `macf fleet deploy --agent code-agent -f /fake/fleet/fleet.yaml --identity-key ${DEPLOY_IDENTITY_KEY_PLACEHOLDER}`,
        },
      ],
      vaultLocationNote: 'clone groundnuty/demo-fleet-control first, or pass --vault explicitly.',
    });
    const text = lines.join('\n');
    expect(text).toContain('clone groundnuty/demo-fleet-control first');
    // The note appears before the per-agent bullet.
    expect(text.indexOf('clone groundnuty/demo-fleet-control')).toBeLessThan(text.indexOf('code-agent: NOT DEPLOYED'));
  });
});
