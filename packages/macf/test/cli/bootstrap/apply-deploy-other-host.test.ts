/**
 * The apply deploy phase skips an agent whose `deploy_path` this host cannot
 * create (a writability fact, not a same-host guess), and still fails loudly
 * on a real deploy failure on a writable host.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anyDeployFailed,
  checkDeployPathCreatable,
  runApplyDeployPhase,
  type ApplyDeployPhaseDeps,
} from '../../../src/cli/bootstrap/apply-deploy.js';
import { parseFleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { FleetDeployOutcome } from '../../../src/cli/bootstrap/fleet-deploy.js';

function manifestAt(path: string) {
  return parseFleetManifest(`apiVersion: macf/v0
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
    deploy_path: ${path}
`);
}

const FLAGS = { vaultPath: '/v', identityPath: '/i' };

function depsWith(
  deployed: string[],
  outcome?: (role: string) => FleetDeployOutcome,
  extra: Partial<ApplyDeployPhaseDeps> = {},
): ApplyDeployPhaseDeps {
  return {
    deployAgentFn: async (agent) => {
      deployed.push(agent.role);
      return outcome?.(agent.role) ?? ({ role: agent.role, status: 'failed', reason: 'boom' } as FleetDeployOutcome);
    },
    ...extra,
  } as unknown as ApplyDeployPhaseDeps;
}

describe('runApplyDeployPhase on a path this host cannot create', () => {
  it('skips with no deploy call, and the skip does not count as a failure', async () => {
    const deployed: string[] = [];
    // /proc is never writable and nothing can be created under it.
    const results = await runApplyDeployPhase(manifestAt('/proc/no-such-host/repos/x'), FLAGS, depsWith(deployed));
    expect(deployed).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toEqual({
      role: 'code-agent',
      status: 'skipped',
      reason: 'not on this host — /proc is not writable here',
    });
    expect(anyDeployFailed(results)).toBe(false);
  });

  it('deploys when the nearest existing ancestor is writable, even if the parent is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apply-deploy-'));
    try {
      const deployed: string[] = [];
      const results = await runApplyDeployPhase(manifestAt(join(root, 'missing', 'sub')), FLAGS, depsWith(deployed));
      expect(deployed).toEqual(['code-agent']);
      expect(results[0]?.outcome.status).toBe('failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a real deploy failure on a writable host still fails the run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apply-deploy-'));
    try {
      const results = await runApplyDeployPhase(manifestAt(join(root, 'ws')), FLAGS, depsWith([]));
      expect(anyDeployFailed(results)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an existing path counts as creatable', () => {
    const root = mkdtempSync(join(tmpdir(), 'apply-deploy-'));
    try {
      expect(checkDeployPathCreatable(root)).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
