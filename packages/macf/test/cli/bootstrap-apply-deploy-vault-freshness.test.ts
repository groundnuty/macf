/**
 * Tests for groundnuty/macf#1183's staleness fix: `resolveDeployVaultPath`
 * and `provisionedThisRunRoles` in `commands/bootstrap-apply.ts`.
 *
 * A NEW file (not an addition to `bootstrap-apply.test.ts`, 5000+ lines and
 * — per that file's own established pattern — deliberately never exercises
 * the real deploy phase end-to-end, always passing `deploy: false` whenever
 * both vault flags are supplied) per this repo's own "avoid touching a file
 * another agent may be editing concurrently" convention; two other agents
 * are concurrently working `#1220`/`#1221` in adjacent bootstrap files.
 *
 * **Why these two functions are tested directly, not through
 * `runBootstrapApply`.** The full orchestrator needs a real (or heavily
 * faked) `applyFleet` call graph — GitHub App creation, control-repo clone,
 * vault compose — to ever reach the deploy-phase call site at all.
 * `resolveDeployVaultPath`/`provisionedThisRunRoles` are exported,
 * side-effect-free (`provisionedThisRunRoles`) or seam-injected
 * (`resolveDeployVaultPath`'s `doReadVault`) specifically so the DECISION
 * they make is provable without that machinery — same reasoning
 * `apply-deploy-no-runner-platform.test.ts` gives for testing a narrower,
 * more direct invariant instead of inventing a heavier fixture.
 */
import { describe, it, expect } from 'vitest';
import { provisionedThisRunRoles, resolveDeployVaultPath } from '../../src/cli/commands/bootstrap-apply.js';
import type { FleetApplyResult, AgentApplyRecord } from '../../src/cli/bootstrap/apply-fleet.js';
import type { VaultReadOptions } from '../../src/cli/bootstrap/vault-read.js';

/** Minimal, neutral `FleetApplyResult` — every field filled with a steady-state value; only `agents`/`vault` vary per test. Mirrors `bootstrap-apply.test.ts::resultWith`'s own neutral-default convention (kept local, not imported, per this file's own "avoid touching a file being concurrently edited" doc). */
function resultWith(overrides: Partial<FleetApplyResult> = {}): FleetApplyResult {
  return {
    controlRepo: { status: 'created', repo: 'groundnuty/demo-fleet-control', localDir: '/x' },
    controlRepoSync: { status: 'pushed' },
    controlRepoInit: { status: 'skipped' },
    lockPath: '/x/fleet.lock',
    finalLock: null,
    agents: [],
    runnerOps: { role: 'runner-ops', status: 'reused', appId: '900', installId: '901' },
    routerApp: { role: 'router', status: 'reused', appId: '902', installId: '903' },
    vault: { status: 'skipped' },
    identityChanges: [],
    ca: { resolve: { status: 'reused', certFingerprint: 'deadbeef'.repeat(8) }, registryLeg: { status: 'already-present' }, repoLegs: {} },
    routing: {},
    routingClient: { mint: { status: 'skipped', reason: 'no CA minted this run' }, certLegs: {}, keyLegs: {} },
    routingSecrets: {
      MACF_ROUTING_APP_ID: {},
      MACF_ROUTING_APP_KEY: {},
      ROUTING_CLIENT_CERT: {},
      ROUTING_CLIENT_KEY: {},
      TS_OAUTH_CLIENT_ID: {},
      TS_OAUTH_SECRET: {},
    },
    routingBundle: {},
    ...overrides,
  };
}

function createdAgentRecord(role: string): AgentApplyRecord {
  return {
    role,
    identity: {
      role,
      status: 'created',
      appId: '111',
      installId: '222',
      credentials: { appId: '111', name: role, slug: role, clientId: 'Iv1.abc', clientSecret: 'x', webhookSecret: 'y', pem: 'FAKE-PEM' },
    },
  };
}

function reusedAgentRecord(role: string): AgentApplyRecord {
  return { role, identity: { role, status: 'reused', appId: '111', installId: '222' } };
}

// --- provisionedThisRunRoles ---

describe('provisionedThisRunRoles (groundnuty/macf#1183)', () => {
  it('includes a role whose identity.status is "created" this run', () => {
    const result = resultWith({ agents: [createdAgentRecord('auditor-agent')] });
    expect(provisionedThisRunRoles(result)).toEqual(new Set(['auditor-agent']));
  });

  it('excludes a role that was merely REUSED (an existing App, not minted this run)', () => {
    const result = resultWith({ agents: [reusedAgentRecord('code-agent')] });
    expect(provisionedThisRunRoles(result)).toEqual(new Set());
  });

  it('mixed run: only the created role(s) are named, reused roles are not', () => {
    const result = resultWith({ agents: [createdAgentRecord('auditor-agent'), reusedAgentRecord('code-agent')] });
    expect(provisionedThisRunRoles(result)).toEqual(new Set(['auditor-agent']));
  });

  it('empty agents list -> empty set', () => {
    expect(provisionedThisRunRoles(resultWith({ agents: [] }))).toEqual(new Set());
  });
});

// --- resolveDeployVaultPath ---

const OPERATOR_VAULT = '/home/op/secrets/vault.age';
const IDENTITY_KEY = '/home/op/.age/identity.txt';
const FRESH_VAULT = '/tmp/macf-bootstrap-control-XXXXXX/secrets/vault.age';

function readVaultMustNotBeCalled(): (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>> {
  return async () => {
    throw new Error('must not be called — resolveDeployVaultPath should not attempt a decrypt on this path');
  };
}

describe('resolveDeployVaultPath (groundnuty/macf#1183)', () => {
  it('vault.status !== "written" (skipped) -> returns the operator-supplied path WITHOUT attempting a decrypt', async () => {
    const result = resultWith({ vault: { status: 'skipped' } });
    const logs: string[] = [];
    const path = await resolveDeployVaultPath(result, OPERATOR_VAULT, IDENTITY_KEY, readVaultMustNotBeCalled(), (l) => logs.push(l));
    expect(path).toBe(OPERATOR_VAULT);
    expect(logs.join('\n')).toContain(OPERATOR_VAULT);
  });

  it('vault.status === "failed" -> returns the operator-supplied path, logs that the write failed', async () => {
    const result = resultWith({ vault: { status: 'failed', reason: 'age encrypt exited 1' } });
    const logs: string[] = [];
    const path = await resolveDeployVaultPath(result, OPERATOR_VAULT, IDENTITY_KEY, readVaultMustNotBeCalled(), (l) => logs.push(l));
    expect(path).toBe(OPERATOR_VAULT);
    expect(logs.join('\n')).toMatch(/vault write FAILED/);
  });

  it('vault.status === "written" AND the fresh path decrypts -> returns the FRESH path, not the operator one', async () => {
    const result = resultWith({ vault: { status: 'written', path: FRESH_VAULT, versioned: false } });
    let calledWith: VaultReadOptions | undefined;
    const doReadVault = async (opts: VaultReadOptions): Promise<Readonly<Record<string, string>>> => {
      calledWith = opts;
      return { SOME_KEY: 'value' };
    };
    const logs: string[] = [];
    const path = await resolveDeployVaultPath(result, OPERATOR_VAULT, IDENTITY_KEY, doReadVault, (l) => logs.push(l));
    expect(path).toBe(FRESH_VAULT);
    expect(calledWith).toEqual({ vaultPath: FRESH_VAULT, identityPath: IDENTITY_KEY });
    expect(logs.join('\n')).toContain(FRESH_VAULT);
  });

  it('vault.status === "written" but the fresh path does NOT decrypt (e.g. a same-run recipient-set rotation) -> falls back to the operator path, never throws', async () => {
    const result = resultWith({ vault: { status: 'written', path: FRESH_VAULT, versioned: false } });
    const doReadVault = async (): Promise<Readonly<Record<string, string>>> => {
      throw new Error('age: no identity matched any of the recipients');
    };
    const logs: string[] = [];
    const path = await resolveDeployVaultPath(result, OPERATOR_VAULT, IDENTITY_KEY, doReadVault, (l) => logs.push(l));
    expect(path).toBe(OPERATOR_VAULT);
    expect(logs.join('\n')).toContain('could not decrypt the vault this run just wrote');
    expect(logs.join('\n')).toContain(OPERATOR_VAULT);
  });
});

// --- Call-site wiring pin (source-shape, mirrors apply-deploy-no-runner-platform.test.ts's technique) ---

describe('deploy-phase call site actually uses the fix (groundnuty/macf#1183)', () => {
  it('runBootstrapApply no longer passes resolvePath(opts.vaultPath) UNCONDITIONALLY into the deploy-phase VaultReadOptions', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(import.meta.dirname, '../../src/cli/commands/bootstrap-apply.ts'), 'utf-8');
    // The call site must route the vault path through the new resolver:
    expect(source).toContain('await resolveDeployVaultPath(');
    // And must no longer build the deploy-phase VaultReadOptions from a bare
    // `resolvePath(opts.vaultPath)` literal (the pre-#1183 shape) — the ONLY
    // remaining `resolvePath(opts.vaultPath)` call sites left in the file
    // are unrelated ones (e.g. the skip-reason branch's flag echo), so this
    // asserts the SPECIFIC old object-literal shape is gone, not the
    // substring everywhere.
    expect(source).not.toMatch(/\{\s*vaultPath:\s*resolvePath\(opts\.vaultPath\),\s*identityPath:\s*resolvePath\(opts\.identityKeyPath\)\s*\}/);
  });

  it('runBootstrapApply wires rolesProvisionedThisApplyRun on the production deploy-deps default', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(import.meta.dirname, '../../src/cli/commands/bootstrap-apply.ts'), 'utf-8');
    expect(source).toContain('rolesProvisionedThisApplyRun: provisionedThisRunRoles(result)');
  });
});
