/**
 * Tests for groundnuty/macf#1183 — the deploy phase's "vault has no
 * app_id/install_id/private_key for role X" refusal must distinguish a role
 * PROVISIONED BY THIS SAME "macf bootstrap apply" run (whose credential the
 * SAME run's vault write composed, but which the vault this particular
 * deploy attempt is reading still lacks) from a role that was NEVER
 * provisioned at all. Both are genuinely `vault_entry_missing_for_role`
 * refusals; only the wording — and therefore the operator's next action —
 * should differ.
 *
 * A NEW file (not an addition to `fleet-deploy.test.ts`, a 1900+ line file
 * with its own real-RSA-keygen module-scope setup) per this repo's own
 * "avoid touching a file another agent may be editing concurrently"
 * convention (see `apply-deploy-seam-identity.test.ts`'s doc) — two other
 * agents are concurrently working `#1220`/`#1221`, both touching adjacent
 * bootstrap files.
 *
 * **Why this file asserts at BOTH the `extractAgentVaultCredentials` level
 * AND the `deployAgent` level (`assert-the-wrong-path.md`).** A unit test
 * that only calls `extractAgentVaultCredentials(raw, fleet, role, true)`
 * directly would still pass against a BROKEN `deployAgent` that hardcodes
 * `false` (or never reads `deps.rolesProvisionedThisApplyRun` at all) when
 * calling it — the exact "correct-by-accident" shape that rule warns
 * against. The `deployAgent`-level tests below are what actually proves the
 * wiring from `deps.rolesProvisionedThisApplyRun` through to the message a
 * real deploy attempt would produce.
 */
import { describe, it, expect } from 'vitest';
import {
  FleetDeployError,
  deployAgent,
  extractAgentVaultCredentials,
  vaultEntryMissingMessage,
  vaultEntryMissingProvisionedThisRunMessage,
  type FleetDeployDeps,
} from '../../../src/cli/bootstrap/fleet-deploy.js';
import type { FleetAgent, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';

const FLEET = 'demo-fleet';
const ROLE = 'auditor-agent';
const OTHER_ROLE = 'code-agent';
const AGENT: FleetAgent = { role: ROLE, profile: 'code', repo: 'groundnuty/demo-auditor', deploy_path: '/unused-in-tests' };

function manifestWith(): FleetManifest {
  return {
    apiVersion: 'macf/v0',
    kind: 'Fleet',
    metadata: { name: FLEET },
    owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
    network: { advertise_host: 'example.ts.net' },
    transport: { age_recipients: ['age1operator'] },
    defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
    agents: [AGENT],
  };
}

/** `FleetDeployDeps` whose three network/fs-touching fields throw if reached — every test in this file expects `deployAgent` to fail at credential-extraction, BEFORE any of them would run. */
function depsThatMustNotProceedPastCredentialExtraction(overrides: Partial<FleetDeployDeps> = {}): FleetDeployDeps {
  return {
    readVault: async () => ({}), // empty vault — every field missing for every role
    cloneRepo: async () => {
      throw new Error('must not be called — deployAgent should have refused before the clone step');
    },
    initAgent: async () => {
      throw new Error('must not be called — deployAgent should have refused before initAgent');
    },
    mintCloneToken: async () => {
      throw new Error('must not be called — deployAgent should have refused before minting a clone token');
    },
    ...overrides,
  };
}

// --- extractAgentVaultCredentials — the decisive pair, plus indeterminate ---

describe('extractAgentVaultCredentials — provisioned-this-run message differentiation (groundnuty/macf#1183)', () => {
  it('DECISIVE 1: provisionedThisRun=true → the NEW message, naming the next step, refusal clause intact', () => {
    try {
      extractAgentVaultCredentials({}, FLEET, ROLE, true);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FleetDeployError);
      const err = e as FleetDeployError;
      expect(err.code).toBe('vault_entry_missing_for_role');
      // Refusal clause is NOT weakened (#1183's own requirement):
      expect(err.message).toContain('refusing to deploy a partially-materialized workspace');
      // Says the role WAS provisioned this run — the corrected diagnosis:
      expect(err.message).toContain('WAS provisioned by this same "macf bootstrap apply" run');
      // Names a concrete next step (either remedy is acceptable; both are present):
      expect(err.message).toContain('macf bootstrap apply');
      expect(err.message).toContain(`macf fleet deploy --agent ${ROLE}`);
      // Never claims the operator failed to provision it — that's the OLD text only:
      expect(err.message).not.toContain('Confirm this agent was actually provisioned');
      // Field names still present (never a value):
      expect(err.message).toContain('app_id');
      expect(err.message).toContain('install_id');
      expect(err.message).toContain('private_key');
    }
  });

  it('DECISIVE 2: provisionedThisRun=false → the EXISTING message, unchanged (proves case 1 does not just always fire)', () => {
    try {
      extractAgentVaultCredentials({}, FLEET, ROLE, false);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as FleetDeployError;
      expect(err.code).toBe('vault_entry_missing_for_role');
      expect(err.message).toBe(vaultEntryMissingMessage(['app_id', 'install_id', 'private_key'], ROLE, FLEET));
      expect(err.message).toContain('Confirm this agent was actually provisioned');
      expect(err.message).not.toContain('WAS provisioned by this same');
    }
  });

  it('indeterminate: provisionedThisRun omitted → defaults to the EXISTING wording, never a guess (honest-unknown floor)', () => {
    try {
      // 3-arg call — exactly what every pre-#1183 call site (and the
      // standalone `macf fleet deploy` command) still does.
      extractAgentVaultCredentials({}, FLEET, ROLE);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as FleetDeployError;
      expect(err.message).toBe(vaultEntryMissingMessage(['app_id', 'install_id', 'private_key'], ROLE, FLEET));
    }
  });

  it('exact-shape pin: the provisioned-this-run message matches vaultEntryMissingProvisionedThisRunMessage byte-for-byte', () => {
    try {
      extractAgentVaultCredentials({}, FLEET, ROLE, true);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as FleetDeployError;
      expect(err.message).toBe(vaultEntryMissingProvisionedThisRunMessage(['app_id', 'install_id', 'private_key'], ROLE, FLEET));
    }
  });

  it('the two message builders never produce byte-identical output for the same inputs (so a caller reading text CAN tell them apart)', () => {
    const missing = ['app_id', 'install_id', 'private_key'];
    expect(vaultEntryMissingProvisionedThisRunMessage(missing, ROLE, FLEET)).not.toBe(vaultEntryMissingMessage(missing, ROLE, FLEET));
  });
});

// --- deployAgent-level wiring — proves deps.rolesProvisionedThisApplyRun actually threads through ---

describe('deployAgent — rolesProvisionedThisApplyRun wiring (groundnuty/macf#1183)', () => {
  it('role IS in deps.rolesProvisionedThisApplyRun → the outcome.reason carries the provisioned-this-run wording', async () => {
    const manifest = manifestWith();
    const deps = depsThatMustNotProceedPastCredentialExtraction({
      rolesProvisionedThisApplyRun: new Set([ROLE]),
    });
    const outcome = await deployAgent(AGENT, manifest, '/unused-destdir', { vaultPath: '/unused-vault', identityPath: '/unused-identity' }, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('WAS provisioned by this same "macf bootstrap apply" run');
      expect(outcome.reason).toContain('refusing to deploy a partially-materialized workspace');
    }
  });

  it('role is ABSENT from deps.rolesProvisionedThisApplyRun (a DIFFERENT role was provisioned) → the outcome.reason keeps the existing wording', async () => {
    const manifest = manifestWith();
    const deps = depsThatMustNotProceedPastCredentialExtraction({
      rolesProvisionedThisApplyRun: new Set([OTHER_ROLE]), // NOT this role
    });
    const outcome = await deployAgent(AGENT, manifest, '/unused-destdir', { vaultPath: '/unused-vault', identityPath: '/unused-identity' }, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('Confirm this agent was actually provisioned');
      expect(outcome.reason).not.toContain('WAS provisioned by this same');
    }
  });

  it('deps.rolesProvisionedThisApplyRun is UNSET (standalone `macf fleet deploy` shape) → honest-unknown floor, existing wording', async () => {
    const manifest = manifestWith();
    const deps = depsThatMustNotProceedPastCredentialExtraction(); // no rolesProvisionedThisApplyRun field at all
    const outcome = await deployAgent(AGENT, manifest, '/unused-destdir', { vaultPath: '/unused-vault', identityPath: '/unused-identity' }, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('Confirm this agent was actually provisioned');
      expect(outcome.reason).not.toContain('WAS provisioned by this same');
    }
  });
});
