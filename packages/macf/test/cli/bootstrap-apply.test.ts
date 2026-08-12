/**
 * Tests for `macf bootstrap apply` (DR-043 §D2, Slice 2b of
 * groundnuty/macf#838).
 *
 * **`--dry-run` suite (increments 1-3, unchanged):** the load-bearing case is
 * that `--dry-run` renders the full plan + blast radius and mutates nothing.
 *
 * **Mutating-apply suite (increment 5a, THIS increment):** supersedes the
 * old "non-`--dry-run` FAILS LOUD, not implemented yet" tests — those tested
 * a placeholder that no longer exists now that the real orchestrator
 * (`apply-fleet.ts`) is wired in. The load-bearing cases here are the
 * plan-approve-once gate (operator declines → nothing mutates) and `--yes`
 * bypassing it for automation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBootstrapApply,
  plannedAppCreations,
  formatPlannedAppCreations,
  formatApplyResult,
  fleetApplyResultToJson,
  applyExitCode,
  DRY_RUN_REDIRECT_PLACEHOLDER,
  FLEET_APPLY_JSON_SCHEMA_VERSION,
  type MutateApplyDeps,
} from '../../src/cli/commands/bootstrap-apply.js';
import { parseFleetManifest } from '../../src/cli/bootstrap/fleet-manifest.js';
import { parseFleetLock } from '../../src/cli/bootstrap/fleet-manifest.js';
import { computePlan } from '../../src/cli/bootstrap/plan.js';
import type { ObservedState, UnimplementedApplyItem } from '../../src/cli/bootstrap/plan.js';
import type { FleetApplyResult } from '../../src/cli/bootstrap/apply-fleet.js';
import type { AgentApplyDeps } from '../../src/cli/bootstrap/apply-agent.js';
import type { AppCredentials } from '../../src/cli/bootstrap/manifest-exchange.js';

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
  vault_repo: groundnuty/demo-science
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

/** Observed state where NOTHING exists — every agent is an App create-candidate. */
const EMPTY_OBSERVED: ObservedState = {
  lock: null,
  agents: {},
  caRegistry: 'absent',
  caRepos: {},
};

function observedWithApp(role: string): ObservedState {
  return {
    lock: null,
    agents: {
      [role]: { app: 'present', install: 'present', repo: 'present', fingerprints: {} },
    },
    caRegistry: 'present',
    caRepos: {},
  };
}

describe('macf bootstrap apply — increment 1 (dry-run only)', () => {
  const dirs: string[] = [];
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errs.push(a.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeManifest(body = FLEET_YAML): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-apply-test-'));
    dirs.push(dir);
    const p = join(dir, 'fleet.yaml');
    writeFileSync(p, body);
    return p;
  }

  it('--dry-run renders the plan + would-be App manifests + consent gate 2 URL, and mutates nothing', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, dryRun: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/demo-fleet-code-agent/);
    expect(out).toMatch(/demo-fleet-science-agent/);
    expect(out).toMatch(/actions_variables:write/);
    expect(out).toMatch(/consent gate 2/);
    expect(out).toMatch(/https:\/\/github\.com\/apps\/demo-fleet-code-agent\/installations\/new/);
    expect(out).toMatch(/https:\/\/github\.com\/apps\/demo-fleet-science-agent\/installations\/new/);
    expect(out).toMatch(/DRY RUN — nothing was created/);
    // macf#854 — the --dry-run text render (same formatPlanText the real
    // apply path's pre-approval render uses) already names the items apply
    // has no code path for, before any consent gate would open.
    expect(out).toMatch(/NOT IMPLEMENTED BY APPLY/);
  });

  it('--dry-run --json carries dry_run + planned_app_creations (incl. installUrl) + unimplemented_by_apply (macf#854)', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, dryRun: true, json: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      dry_run: boolean;
      planned_app_creations: { role: string; manifest: { name: string }; installUrl: string }[];
      unimplemented_by_apply: ReadonlyArray<{ kind: string }>;
    };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.planned_app_creations.map((c) => c.manifest.name)).toEqual([
      'demo-fleet-code-agent',
      'demo-fleet-science-agent',
    ]);
    expect(parsed.planned_app_creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
    ]);
    // Inherited automatically from fleetPlanToJson(plan) — no separate wiring needed.
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'ca')).toBe(true);
  });

  it('reports a missing manifest file without throwing', async () => {
    const code = await runBootstrapApply(
      { file: '/nonexistent/fleet.yaml', dryRun: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/not found/i);
  });

  it('reports a schema-invalid manifest without throwing', async () => {
    const file = writeManifest('apiVersion: macf/v0\nkind: Fleet\n');
    const code = await runBootstrapApply(
      { file, dryRun: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/failed validation/i);
  });
});

describe('plannedAppCreations (pure)', () => {
  const manifest = parseFleetManifest(FLEET_YAML);

  it('includes an agent whose app item is create', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.role)).toEqual(['code-agent', 'science-agent']);
    expect(creations[0]?.manifest.redirect_url).toBe(DRY_RUN_REDIRECT_PLACEHOLDER);
  });

  it('pairs each creation with its consent-gate-2 install URL, derived from the SAME handle as the manifest name', () => {
    const plan = computePlan(manifest, EMPTY_OBSERVED);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.installUrl)).toEqual([
      'https://github.com/apps/demo-fleet-code-agent/installations/new',
      'https://github.com/apps/demo-fleet-science-agent/installations/new',
    ]);
    for (const c of creations) {
      expect(c.installUrl).toBe(`https://github.com/apps/${c.manifest.name}/installations/new`);
    }
  });

  it('EXCLUDES an agent whose App is already present (no re-create)', () => {
    const plan = computePlan(manifest, observedWithApp('code-agent'));
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);
    expect(creations.map((c) => c.role)).toEqual(['science-agent']);
  });

  it('formats an empty creation set without claiming work', () => {
    expect(formatPlannedAppCreations([])).toMatch(/No GitHub Apps would be created/);
  });
});

// --- Mutating apply (increment 5a) ---

const SENTINEL_CREDS: AppCredentials = {
  appId: '111',
  name: 'demo-fleet-code-agent',
  slug: 'demo-fleet-code-agent',
  clientId: 'client-id',
  clientSecret: 'SENTINEL-CLIENT-SECRET',
  webhookSecret: 'SENTINEL-WEBHOOK-SECRET',
  pem: 'SENTINEL-PEM-VALUE',
};

function fakeAgentDeps(overrides: Partial<AgentApplyDeps> = {}): AgentApplyDeps {
  return {
    startManifestFlow: async () => ({
      startUrl: 'http://127.0.0.1:9/',
      redirectUrl: 'http://127.0.0.1:9/callback',
      waitForCode: async () => 'the-code',
      close: async () => {},
    }),
    exchangeManifestCode: async () => SENTINEL_CREDS,
    waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '222', appSlug: opts.expected.appSlug ?? '', accountLogin: 'groundnuty' }),
    confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
    openUrl: async () => {},
    log: () => {},
    // applyFleet ALWAYS overrides this field with its own real recovery-
    // artifact writer (see apply-fleet.ts's `buildAgentDepsWithRecovery`) —
    // present here only to satisfy `AgentApplyDeps`'s type.
    writeRecoveryArtifact: async () => {},
    ...overrides,
  };
}

function fakeMutateDeps(overrides: Partial<MutateApplyDeps> = {}): MutateApplyDeps {
  return {
    buildAgentDeps: () => fakeAgentDeps(),
    repoInitDeps: { cloneRepo: async () => {}, commitAndPush: async () => 'pushed', repoInit: async () => {} },
    vaultDeps: { exists: () => false, encrypt: async () => {} },
    now: () => new Date('2026-08-11T00:00:00.000Z'),
    log: () => {},
    confirmPlan: async () => true,
    readPriorLock: () => null,
    ...overrides,
  };
}

describe('runBootstrapApply — mutating apply (increment 5a)', () => {
  const dirs: string[] = [];
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errs.push(a.join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function writeManifest(body = FLEET_YAML): string {
    const dir = mkdtempSync(join(tmpdir(), 'macf-apply-mutate-test-'));
    dirs.push(dir);
    const p = join(dir, 'fleet.yaml');
    writeFileSync(p, body);
    return p;
  }

  it('operator DECLINES the plan-approval prompt -> exit 1, aborted, nothing mutates (no fleet.lock/vault file)', async () => {
    const file = writeManifest();
    let confirmPlanCalled = false;
    const code = await runBootstrapApply(
      { file },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps({ confirmPlan: async () => { confirmPlanCalled = true; return false; } }),
    );
    expect(code).toBe(1);
    expect(confirmPlanCalled).toBe(true);
    expect(errs.join('\n')).toMatch(/Aborted by operator/);
    expect(existsSync(join(join(file, '..'), 'fleet.lock'))).toBe(false);
    expect(existsSync(join(join(file, '..'), 'secrets', 'vault.age'))).toBe(false);
  });

  it('--yes bypasses the interactive prompt entirely (confirmPlan never called)', async () => {
    const file = writeManifest();
    let confirmPlanCalled = false;
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps({ confirmPlan: async () => { confirmPlanCalled = true; return true; } }),
    );
    expect(code).toBe(0);
    expect(confirmPlanCalled).toBe(false);
  });

  it('happy path: approves, creates both agents, writes a real fleet.lock + vault.age next to the manifest', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps());
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/code-agent: CREATED/);
    expect(out).toMatch(/science-agent: CREATED/);
    expect(out).toMatch(/Vault: written to/);

    const dir = join(file, '..');
    expect(existsSync(join(dir, 'fleet.lock'))).toBe(true);
    const lock = parseFleetLock(readFileSync(join(dir, 'fleet.lock'), 'utf-8'));
    expect(lock.agents.map((a) => a.role).sort()).toEqual(['code-agent', 'science-agent']);
  });

  it('--json emits the FLEET_APPLY_JSON_SCHEMA_VERSION envelope on a successful apply', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps());
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as { schema_version: number; agents: unknown[]; vault: { status: string } };
    expect(parsed.schema_version).toBe(FLEET_APPLY_JSON_SCHEMA_VERSION);
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.vault.status).toBe('written');
  });

  it('a per-agent gate failure still exits the run non-zero (via applyExitCode), even though applyFleet itself completed', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply(
      { file, yes: true },
      { observe: () => Promise.resolve(EMPTY_OBSERVED) },
      fakeMutateDeps({ buildAgentDeps: () => fakeAgentDeps({ exchangeManifestCode: async () => { throw new Error('one-shot code already redeemed'); } }) }),
    );
    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/FAILED/);
  });

  it('NEVER logs a secret value anywhere in stdout/stderr across a full run (text AND --json)', async () => {
    for (const json of [false, true]) {
      const file = writeManifest();
      await runBootstrapApply({ file, yes: true, json }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps());
    }
    const all = [...logs, ...errs].join('\n');
    expect(all).not.toContain('SENTINEL-CLIENT-SECRET');
    expect(all).not.toContain('SENTINEL-WEBHOOK-SECRET');
    expect(all).not.toContain('SENTINEL-PEM-VALUE');
  });

  // --- macf#854: apply must not overstate what it did — the final summary
  // must name the plan items it never attempted (CA / routing / repo-create),
  // and it must do so EVEN UNDER --yes, since --yes skips the pre-approval
  // render entirely (the final summary is the ONLY output an automated run sees).

  it('final summary (--yes, non-json) lists apply-unimplemented items — the plan-approve-once artifact is skipped under --yes, so this is the only place they surface', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps());
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/NOT IMPLEMENTED BY APPLY/);
    expect(out).toMatch(/ca:registry:/);
    // The registry CA var + per-repo CA vars are exactly the #854 incident's
    // silently-skipped resources — pin the kinds actually named.
    expect(out).toMatch(/\bca:/);
    expect(out).toMatch(/\brepo:/);
  });

  it('final summary (--yes, --json) carries unimplemented_by_apply with the SAME items as the plan', async () => {
    const file = writeManifest();
    const code = await runBootstrapApply({ file, yes: true, json: true }, { observe: () => Promise.resolve(EMPTY_OBSERVED) }, fakeMutateDeps());
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      unimplemented_by_apply: ReadonlyArray<{ kind: string; target: string; verb: string; reason: string }>;
    };
    expect(parsed.unimplemented_by_apply.length).toBeGreaterThan(0);
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'ca')).toBe(true);
    expect(parsed.unimplemented_by_apply.some((i) => i.kind === 'repo')).toBe(true);
    for (const item of parsed.unimplemented_by_apply) {
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });

  it('pre-approval stderr render (interactive path, confirmPlan declines) ALSO shows the NOT IMPLEMENTED block before the abort', async () => {
    // The DR-035 §4 plan-approve-once artifact goes straight to
    // `process.stderr.write` (not `console.error`) so a human running
    // without --json sees the SAME text a script skips past — spy on the
    // raw stream to see it.
    const rawWrites: string[] = [];
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        rawWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      });
    try {
      const file = writeManifest();
      const code = await runBootstrapApply(
        { file },
        { observe: () => Promise.resolve(EMPTY_OBSERVED) },
        fakeMutateDeps({ confirmPlan: async () => false }),
      );
      expect(code).toBe(1);
      // The plan-approve-once artifact is written to stderr BEFORE the
      // prompt — the operator must see this before typing "yes", not just after.
      expect(rawWrites.join('')).toMatch(/NOT IMPLEMENTED BY APPLY/);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// --- Pure result-rendering helpers ---

function resultWith(overrides: Partial<FleetApplyResult> = {}): FleetApplyResult {
  return {
    lockPath: '/x/fleet.lock',
    finalLock: null,
    agents: [],
    vault: { status: 'skipped' },
    identityChanges: [],
    ...overrides,
  };
}

describe('formatApplyResult / fleetApplyResultToJson / applyExitCode (pure)', () => {
  it('applyExitCode: 0 when every agent is created/reused/resumed-install and vault didn\'t fail', () => {
    const result = resultWith({
      agents: [
        { role: 'a', identity: { role: 'a', status: 'created', appId: '1', installId: '2', credentials: SENTINEL_CREDS } },
        { role: 'b', identity: { role: 'b', status: 'reused', appId: '3', installId: '4' } },
      ],
      vault: { status: 'written', path: '/x/secrets/vault.age', versioned: false },
    });
    expect(applyExitCode(result)).toBe(0);
  });

  it('applyExitCode: 1 when any agent is failed/drift/skipped-unverified', () => {
    expect(applyExitCode(resultWith({ agents: [{ role: 'a', identity: { role: 'a', status: 'failed', reason: 'x' } }] }))).toBe(1);
    expect(applyExitCode(resultWith({ agents: [{ role: 'a', identity: { role: 'a', status: 'skipped-unverified', appId: '1', reason: 'x' } }] }))).toBe(1);
    expect(
      applyExitCode(resultWith({ agents: [{ role: 'a', identity: { role: 'a', status: 'drift', reason: 'x', installs: [] } }] })),
    ).toBe(1);
  });

  it('applyExitCode: 1 when repo-init failed even though identity succeeded', () => {
    const result = resultWith({
      agents: [{ role: 'a', identity: { role: 'a', status: 'reused', appId: '1', installId: '2' }, repoInit: { repo: 'x/y', role: 'a', status: 'failed', reason: 'push rejected' } }],
    });
    expect(applyExitCode(result)).toBe(1);
  });

  it('applyExitCode: 1 when the vault write failed', () => {
    expect(applyExitCode(resultWith({ vault: { status: 'failed', reason: 'no age_recipients' } }))).toBe(1);
  });

  it('formatApplyResult never includes a credential value', () => {
    const result = resultWith({
      agents: [{ role: 'a', identity: { role: 'a', status: 'created', appId: '1', installId: '2', credentials: SENTINEL_CREDS } }],
      vault: { status: 'written', path: '/x/secrets/vault.age', versioned: false },
    });
    const text = formatApplyResult(result);
    expect(text).not.toContain('SENTINEL-CLIENT-SECRET');
    expect(text).not.toContain('SENTINEL-WEBHOOK-SECRET');
    expect(text).not.toContain('SENTINEL-PEM-VALUE');
    expect(text).toContain('a: CREATED');
  });

  it('formatApplyResult surfaces identityChanges loudly', () => {
    const result = resultWith({ identityChanges: [{ role: 'a', field: 'app_id', previous: 'OLD', next: 'NEW' }] });
    expect(formatApplyResult(result)).toMatch(/DRIFT detected/);
    expect(formatApplyResult(result)).toContain('OLD → NEW');
  });

  it('fleetApplyResultToJson never includes a credential value + always carries schema_version', () => {
    const result = resultWith({
      agents: [{ role: 'a', identity: { role: 'a', status: 'created', appId: '1', installId: '2', credentials: SENTINEL_CREDS } }],
    });
    const json = JSON.stringify(fleetApplyResultToJson(result));
    expect(json).not.toContain('SENTINEL-CLIENT-SECRET');
    expect(json).not.toContain('SENTINEL-WEBHOOK-SECRET');
    expect(json).not.toContain('SENTINEL-PEM-VALUE');
    expect(JSON.parse(json).schema_version).toBe(FLEET_APPLY_JSON_SCHEMA_VERSION);
  });

  // --- macf#854: formatApplyResult / fleetApplyResultToJson's optional
  // second param. Defaults to [] so pre-existing call sites (above, and any
  // caller that doesn't thread the plan through) keep compiling AND keep
  // rendering byte-identically — no spurious warning when nothing is unimplemented.

  const UNIMPLEMENTED_FIXTURE: readonly UnimplementedApplyItem[] = [
    { kind: 'ca', target: 'ca:registry:DEMO_FLEET_CA_CERT', verb: 'create', reason: 'no CA orchestrator step exists yet' },
  ];

  it('formatApplyResult omits the unimplemented block when the param is omitted (default [])', () => {
    const result = resultWith({});
    expect(formatApplyResult(result)).not.toMatch(/NOT IMPLEMENTED/);
  });

  it('formatApplyResult omits the unimplemented block when passed an explicit empty array', () => {
    const result = resultWith({});
    expect(formatApplyResult(result, [])).not.toMatch(/NOT IMPLEMENTED/);
  });

  it('formatApplyResult renders the unimplemented block when items are passed, never a credential value', () => {
    const result = resultWith({
      agents: [{ role: 'a', identity: { role: 'a', status: 'created', appId: '1', installId: '2', credentials: SENTINEL_CREDS } }],
    });
    const text = formatApplyResult(result, UNIMPLEMENTED_FIXTURE);
    expect(text).toMatch(/NOT IMPLEMENTED BY APPLY/);
    expect(text).toContain('ca:registry:DEMO_FLEET_CA_CERT');
    expect(text).not.toContain('SENTINEL-PEM-VALUE');
  });

  it('fleetApplyResultToJson defaults unimplemented_by_apply to [] when the param is omitted', () => {
    const result = resultWith({});
    const json = JSON.parse(JSON.stringify(fleetApplyResultToJson(result))) as { unimplemented_by_apply: unknown[] };
    expect(json.unimplemented_by_apply).toEqual([]);
  });

  it('fleetApplyResultToJson carries the passed unimplemented items verbatim', () => {
    const result = resultWith({});
    const json = JSON.parse(JSON.stringify(fleetApplyResultToJson(result, UNIMPLEMENTED_FIXTURE))) as {
      unimplemented_by_apply: ReadonlyArray<{ kind: string; target: string }>;
    };
    expect(json.unimplemented_by_apply).toEqual([
      { kind: 'ca', target: 'ca:registry:DEMO_FLEET_CA_CERT', verb: 'create', reason: 'no CA orchestrator step exists yet' },
    ]);
  });
});
