/**
 * Tests for groundnuty/macf#1272 — the deletion-consent enumeration + the
 * execution wiring it gates. The blocking issue: `bootstrap-apply.ts:942`
 * said "Nothing is deleted (§D3 no-prune)" in the LAST text an operator
 * reads before typing "yes", while wiring `delete`-verb execution under that
 * promise would obtain consent by a statement that had become false.
 *
 * **Decisive pair (per `assert-the-wrong-path.md`):**
 * 1. a plan WITH `delete` items -> the approval text NAMES each one and does
 *    NOT say nothing is deleted.
 * 2. a plan WITHOUT `delete` items -> the text RETAINS the exact "Nothing is
 *    deleted (§D3 no-prune)." sentence, byte-identical to before #1272.
 *
 * Both run through `formatApprovalBanner` — the EXACT function
 * `realConfirmPlan` passes verbatim to `process.stderr.write`, so testing
 * its return value IS testing the rendered approval text, not a
 * hand-assembled fragment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBootstrapApply,
  formatApprovalBanner,
  formatDeletionEnumerationLines,
  formatDeletionResultLines,
  deletionOutcomeToJson,
  type MutateApplyDeps,
} from '../../src/cli/commands/bootstrap-apply.js';
import type { FleetPlan, ObservedState, PlanItem } from '../../src/cli/bootstrap/plan.js';
import type { AgentApplyDeps } from '../../src/cli/bootstrap/apply-agent.js';
import type { CaApplyDeps } from '../../src/cli/bootstrap/apply-ca.js';
import type { RoutingClientApplyDeps } from '../../src/cli/bootstrap/apply-routing-client.js';
import type { RoutingSecretsPublishDeps } from '../../src/cli/bootstrap/apply-routing-secrets.js';
import type { RunnerRegistrationDeps } from '../../src/cli/bootstrap/apply-routing.js';
import { TRUSTED_ACTORS_VAR } from '../../src/cli/bootstrap/apply-routing.js';
import type { DeletionAction, DeletionOutcome, ApplyDeleteDeps } from '../../src/cli/bootstrap/apply-delete.js';

const FLEET_YAML = `apiVersion: macf/v0
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
    deploy_path: /home/ubuntu/repos/demo-code
  - role: science-agent
    profile: research
    repo: groundnuty/demo-science
    deploy_path: /home/ubuntu/repos/demo-science
`;

const EMPTY_OBSERVED: ObservedState = { lock: null, agents: {}, caRegistry: 'absent', caRepos: {}, controlRepoPresence: 'absent' };

/** Same shape `manifest.agents[0].role` recorded, plus MACF_TRUSTED_ACTORS observed present -> `computePlan` (plan.ts row 4) emits ONE 'routing'-kind delete item. Not this file's concern to re-derive; this is the SAME `routingDroppedItem` trigger `plan.test.ts` already exercises. */
const OBSERVED_WITH_ROUTING_DROPPED: ObservedState = {
  ...EMPTY_OBSERVED,
  lock: { schema_version: 1, fleet: 'demo-fleet', agents: [{ role: 'code-agent', app_id: 'a', install_id: 'i' }] },
  routingTrustedActors: 'demo-fleet-code-agent[bot],demo-fleet-science-agent[bot]',
};

// --- Minimal hermetic fakes for a full runBootstrapApply pass, mirroring
// bootstrap-apply.test.ts's own fakeMutateDeps/fakeAgentDeps/fakeTrustDeps
// shape (duplicated here, not imported, to keep this file self-contained —
// those helpers are closures private to that file's own describe block). ---

function fakeAgentDeps(): AgentApplyDeps {
  return {
    startManifestFlow: async () => ({
      startUrl: 'http://127.0.0.1:9/',
      redirectUrl: 'http://127.0.0.1:9/callback',
      waitForCode: async () => 'the-code',
      close: async () => {},
    }),
    startInstallInterstitial: async () => ({ startUrl: 'http://127.0.0.1:19/', close: async () => {} }),
    exchangeManifestCode: async () => ({
      appId: '111',
      name: 'demo-fleet-code-agent',
      slug: 'demo-fleet-code-agent',
      clientId: 'client-id',
      clientSecret: 'SENTINEL-CLIENT-SECRET',
      webhookSecret: 'SENTINEL-WEBHOOK-SECRET',
      pem: 'SENTINEL-PEM-VALUE',
    }),
    waitForAppInstallation: async (opts) => ({
      appId: opts.appId,
      installId: '222',
      appSlug: opts.expected.appSlug ?? '',
      accountLogin: 'groundnuty',
      repositorySelection: 'selected',
    }),
    confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
    openUrl: async () => {},
    log: () => {},
    writeRecoveryArtifact: async () => {},
  };
}

function fakeTrustDeps(): CaApplyDeps & RunnerRegistrationDeps {
  return {
    checkRegistryPresence: async () => 'absent',
    readRegistryVariable: async () => undefined,
    createRegistryVariable: async () => 'created',
    checkRepoPresence: async () => 'absent',
    createRepoVariable: async () => 'created',
    mintCa: async () => ({ certPem: 'SENTINEL-CA-CERT-PEM', keyPem: 'SENTINEL-CA-KEY-PEM' }),
    checkRunnerUsableByRepo: async () => ({ presence: 'present' }),
  };
}

function fakeRoutingClientDeps(): RoutingClientApplyDeps {
  return { mint: async () => ({ certPem: 'SENTINEL-ROUTING-CLIENT-CERT-PEM', keyPem: 'SENTINEL-ROUTING-CLIENT-KEY-PEM' }) };
}

function fakeRoutingSecretsDeps(): RoutingSecretsPublishDeps {
  return { checkRepoSecretPresence: async () => 'absent', setRepoSecret: async () => {} };
}

function fakeMutateDeps(manifestPath: string, overrides: Partial<MutateApplyDeps> = {}): MutateApplyDeps {
  return {
    buildAgentDeps: () => fakeAgentDeps(),
    repoInitDeps: {
      cloneRepo: async () => {},
      commitAndPush: async () => 'pushed',
      repoInit: async () => ({ workflow: 'created', config: 'created', labels: { status: 'ok', created: [], existed: [] } }),
    },
    vaultDeps: { exists: () => false, encrypt: async (_plaintext, _recipients, outPath) => writeFileSync(outPath, 'FAKE-CIPHERTEXT') },
    controlRepoDeps: {
      checkMeta: async () => ({ presence: 'absent' }),
      readManifestFile: async () => undefined,
      createRepo: async () => {},
      unarchiveRepo: async () => {
        throw new Error('must not be called — control repo is always absent in this fixture');
      },
      cloneRepo: async () => {},
      commitAndPush: async () => 'pushed',
    },
    agentRepoDeps: { checkMeta: async () => ({ presence: 'absent' }), createRepo: async () => {}, unarchiveRepo: async () => {} },
    trustDeps: fakeTrustDeps(),
    routingClientDeps: fakeRoutingClientDeps(),
    routingSecretsDeps: fakeRoutingSecretsDeps(),
    routerAppVaultDeps: {},
    controlRepoOptions: { makeScratchDir: () => join(manifestPath, '..') },
    recoveryRootDir: join(manifestPath, '..'),
    now: () => new Date('2026-08-27T00:00:00.000Z'),
    log: () => {},
    confirmPlan: async () => true,
    readPriorLock: () => null,
    runnerToken: 'SENTINEL-RUNNER-TOKEN',
    ...overrides,
  };
}

// --- Fixture PlanItem/FleetPlan builders for the pure-formatter tests ---

const ROUTING_DELETE_ITEM: PlanItem = {
  kind: 'routing',
  target: 'routing:demo-fleet:runner',
  verb: 'delete',
  reason: 'MACF_TRUSTED_ACTORS is observed present but routing.runner is no longer declared — removing it.',
  confirm_required: true,
};

const APP_ORPHAN_ITEM: PlanItem = {
  kind: 'app',
  target: 'agent:dropped-agent:app',
  verb: 'orphan',
  reason: 'GitHub App for "dropped-agent" was provisioned by this tool but "dropped-agent" is no longer declared.',
  confirm_required: false,
};

const REPO_ORPHAN_ITEM: PlanItem = {
  kind: 'repo',
  target: 'agent:dropped-agent:repo',
  verb: 'orphan',
  reason: 'The repo for "dropped-agent" was provisioned by this tool but "dropped-agent" is no longer declared.',
  confirm_required: false,
};

const SECRET_DELETE_ITEM: PlanItem = {
  kind: 'secret_fingerprint',
  target: 'agent:dropped-agent:secret_fingerprint:app_private_key',
  verb: 'delete',
  reason: 'Secret "app_private_key" for "dropped-agent" was provisioned by this tool but "dropped-agent" is no longer declared.',
  confirm_required: true,
};

function basePlan(items: readonly PlanItem[]): FleetPlan {
  return {
    fleet: 'demo-fleet',
    items,
    skippedSections: [],
    unimplementedByApply: items
      .filter((i) => i.verb === 'delete')
      .map((i) => ({ kind: i.kind, target: i.target, verb: i.verb, reason: 'apply has no code path for a delete-verb item of this kind yet.' })),
    registryScopeIssues: [],
    registryRepoScopeNotices: [],
    installScopeDrift: [],
    scopeCredentials: [],
  };
}

const EXECUTABLE_ROUTING_ACTION: DeletionAction = {
  item: ROUTING_DELETE_ITEM,
  executable: true,
  repo: 'groundnuty/demo-code',
  variableName: TRUSTED_ACTORS_VAR,
};
const SKIPPED_SECRET_ACTION: DeletionAction = {
  item: SECRET_DELETE_ITEM,
  executable: false,
  reason: 'the repo this secret lives on is not recorded anywhere apply can read.',
};

describe('formatApprovalBanner — decisive pair (groundnuty/macf#1272)', () => {
  it('DECISIVE (1): a plan WITH delete items names each one, and does NOT say "Nothing is deleted"', () => {
    const plan = basePlan([ROUTING_DELETE_ITEM]);
    const text = formatApprovalBanner(plan, [], [EXECUTABLE_ROUTING_ACTION]);
    expect(text).not.toContain('Nothing is deleted');
    expect(text).toContain('This apply WILL DELETE 1 resource(s) this run:');
    expect(text).toContain(TRUSTED_ACTORS_VAR);
    expect(text).toContain('groundnuty/demo-code');
    expect(text).toContain(ROUTING_DELETE_ITEM.target);
  });

  it('DECISIVE (2): a plan with NO delete items retains the exact "Nothing is deleted (§D3 no-prune)." sentence, byte-identical', () => {
    const plan = basePlan([]);
    const text = formatApprovalBanner(plan, [], []);
    expect(text).toContain('Nothing is deleted (§D3 no-prune).');
    expect(text).not.toMatch(/WILL DELETE/);
  });

  it('a plan with ONLY orphan items ALSO retains "Nothing is deleted" — orphan removes nothing, so the sentence stays true — AND names each orphan with its own "not deleted" text (groundnuty/macf#1281)', () => {
    const plan = basePlan([APP_ORPHAN_ITEM, REPO_ORPHAN_ITEM]);
    const text = formatApprovalBanner(plan, [], []);
    expect(text).toContain('Nothing is deleted (§D3 no-prune).');
    expect(text).not.toMatch(/WILL DELETE/);
    // groundnuty/macf#1281 — before this issue, an orphan item was
    // completely invisible on this surface; now each one is named, with the
    // explicit "nothing is deleted" framing restated in a loud block.
    expect(text).toContain(APP_ORPHAN_ITEM.target);
    expect(text).toContain(REPO_ORPHAN_ITEM.target);
    expect(text).toMatch(/NOTHING IS DELETED/);
  });

  it('a mix of orphan + delete items: the DELETION ENUMERATION never names an orphan item, but the SEPARATE orphan block does (groundnuty/macf#1281)', () => {
    const plan = basePlan([APP_ORPHAN_ITEM, REPO_ORPHAN_ITEM, ROUTING_DELETE_ITEM]);
    const text = formatApprovalBanner(plan, [], [EXECUTABLE_ROUTING_ACTION]);
    expect(text).not.toContain('Nothing is deleted');
    expect(text).toContain('This apply WILL DELETE 1 resource(s) this run:');
    // `formatDeletionEnumerationLines` itself is untouched by #1281 — still
    // derived ONLY from delete-verb `DeletionAction[]`, never from orphan
    // items (this is the property the ORIGINAL version of this test named
    // "the enumeration").
    const enumerationLines = formatDeletionEnumerationLines([EXECUTABLE_ROUTING_ACTION]).join('\n');
    expect(enumerationLines).not.toContain(APP_ORPHAN_ITEM.target);
    expect(enumerationLines).not.toContain(REPO_ORPHAN_ITEM.target);
    // But the banner AS A WHOLE now names both orphan items too, in a
    // dedicated block distinct from the deletion enumeration above.
    expect(text).toContain(APP_ORPHAN_ITEM.target);
    expect(text).toContain(REPO_ORPHAN_ITEM.target);
  });

  it('a non-executable delete item (secret_fingerprint) is named as SKIPPED, not claimed as deleted', () => {
    const plan = basePlan([SECRET_DELETE_ITEM]);
    const text = formatApprovalBanner(plan, [], [SKIPPED_SECRET_ACTION]);
    expect(text).not.toContain('Nothing is deleted');
    expect(text).not.toMatch(/WILL DELETE 1/); // nothing executable this run
    expect(text).toContain('1 resource(s) were computed for deletion but will NOT be deleted this run');
    expect(text).toContain(SECRET_DELETE_ITEM.target);
  });

  it('the "N item(s) NOT IMPLEMENTED" trailing line excludes routing-kind deletes apply now executes, but still counts a secret_fingerprint delete', () => {
    const plan = basePlan([ROUTING_DELETE_ITEM, SECRET_DELETE_ITEM]);
    const text = formatApprovalBanner(plan, [], [EXECUTABLE_ROUTING_ACTION, SKIPPED_SECRET_ACTION]);
    expect(text).toMatch(/⚠ 1 item\(s\) in the plan above are NOT IMPLEMENTED by apply yet/);
  });

  it('preamble text (CREATE/update/noop counts) is unaffected by the presence of delete items', () => {
    const noDeletePlan = basePlan([]);
    const withDeletePlan = basePlan([ROUTING_DELETE_ITEM]);
    const a = formatApprovalBanner(noDeletePlan, [], []);
    const b = formatApprovalBanner(withDeletePlan, [], [EXECUTABLE_ROUTING_ACTION]);
    // The no-delete banner's ONLY difference is the trailing "Nothing is
    // deleted (§D3 no-prune)." clause appended to the SAME line — strip it
    // before comparing so this test isolates the CREATE/update/noop counts
    // themselves, not the delete-verb framing this whole file is about.
    const preambleOf = (s: string): string => (s.split('\n')[1] ?? '').replace(' Nothing is deleted (§D3 no-prune).', '');
    expect(preambleOf(a)).toBe(preambleOf(b));
  });
});

describe('formatDeletionEnumerationLines', () => {
  it('never mentions the word "orphan" — it is derived from delete-verb actions only, by construction', () => {
    const lines = formatDeletionEnumerationLines([EXECUTABLE_ROUTING_ACTION, SKIPPED_SECRET_ACTION]).join('\n');
    expect(lines.toLowerCase()).not.toContain('orphan');
  });

  it('empty input -> empty output', () => {
    expect(formatDeletionEnumerationLines([])).toEqual([]);
  });
});

describe('formatDeletionResultLines / deletionOutcomeToJson', () => {
  it('renders each outcome with a human status and never a credential value', () => {
    const results: DeletionOutcome[] = [
      { kind: 'routing', target: 'routing:demo-fleet:runner', status: 'deleted' },
      { kind: 'routing', target: 'routing:other:runner', status: 'already-absent' },
      { kind: 'secret_fingerprint', target: 'agent:x:secret_fingerprint:y', status: 'skipped', reason: 'repo unknown' },
    ];
    const lines = formatDeletionResultLines(results);
    // macf#1061 — user-facing CLI output explains, never cites an internal
    // issue/DR number.
    expect(lines[0]).toContain('Deletions this run:');
    expect(lines.join('\n')).not.toMatch(/groundnuty\/macf#\d+/);
    expect(lines.some((l) => l.includes('DELETED'))).toBe(true);
    expect(lines.some((l) => l.includes('already absent'))).toBe(true);
    expect(lines.some((l) => l.includes('repo unknown'))).toBe(true);
  });

  it('empty input -> empty lines (silent when nothing to report)', () => {
    expect(formatDeletionResultLines([])).toEqual([]);
  });

  it('deletionOutcomeToJson omits "reason" when absent, includes it when present', () => {
    expect(deletionOutcomeToJson({ kind: 'routing', target: 't', status: 'deleted' })).toEqual({ kind: 'routing', target: 't', status: 'deleted' });
    expect(deletionOutcomeToJson({ kind: 'routing', target: 't', status: 'skipped', reason: 'why' })).toEqual({
      kind: 'routing',
      target: 't',
      status: 'skipped',
      reason: 'why',
    });
  });
});

// --- End-to-end execution wiring through runBootstrapApply -----------------

describe('runBootstrapApply — deletion execution wiring (groundnuty/macf#1272)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const recoverySafetyDir = mkdtempSync(join(tmpdir(), 'macf-apply-delete-recovery-safety-'));
    dirs.push(recoverySafetyDir);
    vi.stubEnv('MACF_RECOVERY_DIR', recoverySafetyDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeManifest(body = FLEET_YAML): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-apply-delete-test-'));
    dirs.push(dir);
    const p = join(dir, 'fleet.yaml');
    writeFileSync(p, body);
    return p;
  }

  it('a "routing"-kind delete item is EXECUTED: deleteRepoVariable is called with the representative repo + MACF_TRUSTED_ACTORS', async () => {
    const file = writeManifest();
    const deleteRepoVariable = vi.fn(async () => 'deregistered' as const);
    const deleteDeps: ApplyDeleteDeps = { deleteRepoVariable };

    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(OBSERVED_WITH_ROUTING_DROPPED), deleteDeps },
      fakeMutateDeps(file),
    );

    expect(code).toBe(0);
    expect(deleteRepoVariable).toHaveBeenCalledExactlyOnceWith('groundnuty/demo-code', TRUSTED_ACTORS_VAR);
  });

  it('a plan with NO delete items never invokes deleteRepoVariable at all', async () => {
    const file = writeManifest();
    const deleteRepoVariable = vi.fn(async () => 'deregistered' as const);
    const deleteDeps: ApplyDeleteDeps = { deleteRepoVariable };

    const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED), deleteDeps }, fakeMutateDeps(file));

    expect(code).toBe(0);
    expect(deleteRepoVariable).not.toHaveBeenCalled();
  });

  it('the operator DECLINING the plan-approval prompt means deleteRepoVariable is NEVER called, even though a delete item exists', async () => {
    const file = writeManifest();
    const deleteRepoVariable = vi.fn(async () => 'deregistered' as const);
    const deleteDeps: ApplyDeleteDeps = { deleteRepoVariable };

    const code = await runBootstrapApply(
      { file },
      { observe: () => Promise.resolve(OBSERVED_WITH_ROUTING_DROPPED), deleteDeps },
      fakeMutateDeps(file, { confirmPlan: async () => false }),
    );

    expect(code).toBe(1);
    expect(deleteRepoVariable).not.toHaveBeenCalled();
  });

  it('the approval text shown to the operator (confirmPlan args) NAMES the same repo/variable execution later touches', async () => {
    const file = writeManifest();
    let seenActions: readonly DeletionAction[] = [];
    const code = await runBootstrapApply(
      { file },
      { observe: () => Promise.resolve(OBSERVED_WITH_ROUTING_DROPPED), deleteDeps: { deleteRepoVariable: async () => 'deregistered' } },
      fakeMutateDeps(file, {
        confirmPlan: async (_plan, _creations, deletionActions) => {
          seenActions = deletionActions;
          return true;
        },
      }),
    );
    expect(code).toBe(0);
    expect(seenActions).toHaveLength(1);
    const [action] = seenActions;
    expect(action?.executable).toBe(true);
    if (action?.executable !== true) throw new Error('unreachable');
    expect(action.repo).toBe('groundnuty/demo-code');
    expect(action.variableName).toBe(TRUSTED_ACTORS_VAR);
  });

  it('--json output carries a "deletions" key naming the outcome when a delete ran, and OMITS the key entirely when nothing was deleted', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));

    const fileWith = writeManifest();
    await runBootstrapApply(
      { file: fileWith, yes: true, json: true },
      { observe: () => Promise.resolve(OBSERVED_WITH_ROUTING_DROPPED), deleteDeps: { deleteRepoVariable: async () => 'deregistered' } },
      fakeMutateDeps(fileWith),
    );
    const withDeleteJson = JSON.parse(logs.at(-1) ?? '{}') as { deletions?: unknown };
    expect(withDeleteJson.deletions).toEqual([{ kind: 'routing', target: 'routing:demo-fleet:runner', status: 'deleted' }]);

    logs.length = 0;
    const fileWithout = writeManifest();
    await runBootstrapApply({ file: fileWithout, yes: true, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps(fileWithout));
    const withoutDeleteJson = JSON.parse(logs.at(-1) ?? '{}') as { deletions?: unknown };
    expect(withoutDeleteJson.deletions).toBeUndefined();
  });
});
