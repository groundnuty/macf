/**
 * Tests for `control-repo-manifest-drift.ts` — the committed-vs-local
 * `fleet.yaml` drift check (groundnuty/macf#1249). Fully offline: the real
 * I/O leaf (`readManifestFile`, production wiring:
 * `control-repo.ts::realReadControlManifestFile`) is always an injected
 * fake here.
 *
 * The live evidence this module exists to catch (from the issue): a
 * `macf-trial` control repo committed with 2 agents and NO `routing:`
 * section, while `apply` was later given a 3-agent manifest with
 * `routing.runner.runs_on: self-hosted`. `manifestCommitted`/`manifestApplied`
 * below reproduce that shape (minus the 3rd agent, to keep fixtures small
 * — the routing-section-added case alone already exercises the "added
 * substructure" path the wholly-added-agent case would too).
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import { parseFleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import {
  computeControlRepoManifestDrift,
  controlRepoManifestDriftToJson,
  diffManifestFields,
  formatControlRepoManifestDriftLines,
  formatManifestFieldDiffLines,
  hasControlRepoManifestDrift,
} from '../../../src/cli/bootstrap/control-repo-manifest-drift.js';

const REPO = 'macf-experiment/trial-control';

const COMMITTED_YAML = `
apiVersion: macf/v0
kind: Fleet
metadata:
  name: trial
owner:
  account: macf-experiment
  type: org
  registry: { type: repo, owner: macf-experiment, repo: trial-control }
network:
  advertise_host: example.ts.net
transport:
  age_recipients: [age1operator]
defaults:
  role_template: groundnuty/agentic-repo-template
  app_manifest: dr-019
agents:
  - role: code-agent
    profile: code
    repo: macf-experiment/trial-code-agent
    deploy_path: /x
  - role: science-agent
    profile: science
    repo: macf-experiment/trial-science-agent
    deploy_path: /y
`;

function appliedManifest(overrides?: Partial<FleetManifest>): FleetManifest {
  return {
    ...parseFleetManifest(COMMITTED_YAML),
    ...overrides,
  };
}

// --- diffManifestFields — pure structural differ ---

describe('diffManifestFields (pure)', () => {
  it('identical values: no diff entries', () => {
    const a = { x: 1, y: { z: 2 } };
    expect(diffManifestFields(a, { x: 1, y: { z: 2 } })).toEqual([]);
  });

  it('a flat field changed: one entry naming that path', () => {
    const diffs = diffManifestFields({ advertise_host: 'old.ts.net' }, { advertise_host: 'new.ts.net' });
    expect(diffs).toEqual([{ path: 'advertise_host', committed: 'old.ts.net', applied: 'new.ts.net' }]);
  });

  it('a nested field changed: the path is dotted all the way down', () => {
    const diffs = diffManifestFields({ routing: { runner: { runs_on: 'ubuntu-latest' } } }, { routing: { runner: { runs_on: 'self-hosted' } } });
    expect(diffs).toEqual([{ path: 'routing.runner.runs_on', committed: 'ubuntu-latest', applied: 'self-hosted' }]);
  });

  it('a WHOLE section added (committed has no key at all): ONE entry at the section path, not one per leaf field', () => {
    const diffs = diffManifestFields({}, { routing: { runner: { runs_on: 'self-hosted', labels: ['self-hosted', 'macf-vm'], warm: 1 } } });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path).toBe('routing');
    expect(diffs[0]?.committed).toBeUndefined();
    expect(diffs[0]?.applied).toEqual({ runner: { runs_on: 'self-hosted', labels: ['self-hosted', 'macf-vm'], warm: 1 } });
  });

  it('a whole agent added (array length differs): ONE entry at the new index, carrying the whole object', () => {
    const committed = { agents: [{ role: 'code-agent' }] };
    const applied = { agents: [{ role: 'code-agent' }, { role: 'writing-agent' }] };
    const diffs = diffManifestFields(committed, applied);
    expect(diffs).toEqual([{ path: 'agents[1]', committed: undefined, applied: { role: 'writing-agent' } }]);
  });

  it('one field of an EXISTING array element changed: the path indexes into the array', () => {
    const committed = { agents: [{ role: 'code-agent', repo: 'old/repo' }] };
    const applied = { agents: [{ role: 'code-agent', repo: 'new/repo' }] };
    const diffs = diffManifestFields(committed, applied);
    expect(diffs).toEqual([{ path: 'agents[0].repo', committed: 'old/repo', applied: 'new/repo' }]);
  });

  it('formatManifestFieldDiffLines renders committed/applied for an added section (never "undefined" bare, never "[object Object]")', () => {
    const diffs = diffManifestFields({}, { routing: { runner: { runs_on: 'self-hosted' } } });
    const lines = formatManifestFieldDiffLines(diffs);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('routing:');
    expect(lines[0]).toContain('committed=(absent)');
    expect(lines[0]).toContain('applied=');
    expect(lines[0]).not.toContain('[object Object]');
    expect(lines[0]).toContain('"runs_on":"self-hosted"');
  });
});

// --- computeControlRepoManifestDrift — orchestration ---

describe('computeControlRepoManifestDrift', () => {
  it('DECISIVE (1/2) — committed differs from applied: drift, naming the fields', async () => {
    const applied = appliedManifest({
      agents: [
        { role: 'code-agent', profile: 'code', repo: 'macf-experiment/trial-code-agent', deploy_path: '/x' },
        { role: 'science-agent', profile: 'science', repo: 'macf-experiment/trial-science-agent', deploy_path: '/y' },
      ],
      routing: { runner: { runs_on: 'self-hosted', labels: ['self-hosted', 'macf-vm'], warm: 1 } },
    });
    const result = await computeControlRepoManifestDrift(applied, REPO, 'present', async () => COMMITTED_YAML);
    expect(result.status).toBe('drift');
    expect(result.fields.map((f) => f.path)).toEqual(['routing']);
    expect(result.reason).toContain('routing');
    expect(hasControlRepoManifestDrift(result)).toBe(true);
  });

  it('DECISIVE (2/2) — committed and applied identical: clean, not reported', async () => {
    const applied = appliedManifest();
    const result = await computeControlRepoManifestDrift(applied, REPO, 'present', async () => COMMITTED_YAML);
    expect(result.status).toBe('clean');
    expect(result.fields).toEqual([]);
    expect(hasControlRepoManifestDrift(result)).toBe(false);
    expect(formatControlRepoManifestDriftLines(result)).toEqual([]);
  });

  it('committed manifest unreadable (readManifestFile resolves undefined): unknown — distinct from both clean and drift', async () => {
    const applied = appliedManifest();
    const result = await computeControlRepoManifestDrift(applied, REPO, 'present', async () => undefined);
    expect(result.status).toBe('unknown');
    expect(result.reason).toMatch(/could not read/i);
  });

  it('committed manifest read throws: unknown, never propagates', async () => {
    const applied = appliedManifest();
    const result = await computeControlRepoManifestDrift(applied, REPO, 'present', async () => {
      throw new Error('gh api boom');
    });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('gh api boom');
  });

  it('committed manifest fails schema validation: unknown, names the validation failure', async () => {
    const applied = appliedManifest();
    const result = await computeControlRepoManifestDrift(applied, REPO, 'present', async () => 'apiVersion: macf/v0\nkind: Fleet\n');
    expect(result.status).toBe('unknown');
    expect(result.reason).toMatch(/schema validation/i);
  });

  it('control repo not confirmed present: unknown, honest-unknown — absence is never treated as "no declaration" (never clean, never drift)', async () => {
    const applied = appliedManifest();
    const result = await computeControlRepoManifestDrift(applied, REPO, 'absent', async () => {
      throw new Error('must not be called — presence check short-circuits before any read');
    });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('absent');
  });

  it('control repo presence itself unknown: unknown, names the observed presence', async () => {
    const applied = appliedManifest();
    const result = await computeControlRepoManifestDrift(applied, REPO, 'unknown', async () => {
      throw new Error('must not be called');
    });
    expect(result.status).toBe('unknown');
    expect(result.reason).toContain('unknown');
  });

  it('a committed manifest that OMITS a defaulted field (e.g. routing.runner.warm) compares clean against an applied manifest that declares the same default explicitly', async () => {
    const committedNoWarm = `${COMMITTED_YAML.trimEnd()}\nrouting:\n  runner:\n    runs_on: self-hosted\n`;
    const applied = appliedManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const result = await computeControlRepoManifestDrift(applied, REPO, 'present', async () => committedNoWarm);
    expect(result.status).toBe('clean');
  });
});

describe('controlRepoManifestDriftToJson', () => {
  it('a drift result serializes null (never JS undefined) for an absent side, and carries the reason', async () => {
    const applied = appliedManifest({ routing: { runner: { runs_on: 'self-hosted', warm: 1 } } });
    const result = await computeControlRepoManifestDrift(applied, REPO, 'present', async () => COMMITTED_YAML);
    const json = controlRepoManifestDriftToJson(result) as { status: string; fields: ReadonlyArray<{ path: string; committed: unknown; applied: unknown }>; reason?: string };
    expect(json.status).toBe('drift');
    expect(json.fields[0]?.path).toBe('routing');
    expect(json.fields[0]?.committed).toBeNull();
    expect(json.reason).toBeDefined();
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
