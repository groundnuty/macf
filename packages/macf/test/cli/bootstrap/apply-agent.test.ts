/**
 * Tests for `apply-agent.ts` — the confirm-before-create guard + per-agent
 * gate 1/gate 2 flow (DR-043 §D2, Slice 2b increment 5a, groundnuty/macf#838).
 * Fully offline: every network/subprocess primitive is injected; only the
 * scratch-PEM write/cleanup touches real fs (a genuinely local, short-lived
 * temp file — verified cleaned up for real, no fake needed).
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import {
  applyAgentIdentity,
  applyIdentity,
  confirmBeforeCreateGuard,
  installReposForIdentity,
  installWhyText,
  realAgentApplyDeps,
  type AgentApplyDeps,
} from '../../../src/cli/bootstrap/apply-agent.js';
import type { FleetAgent, FleetLockAgent, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { AppCredentials } from '../../../src/cli/bootstrap/manifest-exchange.js';
import type { ConfirmedInstall, IdentityConfirmation } from '../../../src/cli/bootstrap/identity-confirm.js';
import type { InstallInterstitialHandles, ManifestFlowHandles } from '../../../src/cli/bootstrap/manifest-flow-server.js';
import { appNameCollisionRefusalMessage, resolveAppPresenceStatus } from '../../../src/cli/bootstrap/app-presence.js';
import { registryRepoNotInstalledReason, registryRepoRetryInstruction } from '../../../src/cli/bootstrap/registry-repo-coverage.js';

const MANIFEST: FleetManifest = {
  apiVersion: 'macf/v0',
  kind: 'Fleet',
  metadata: { name: 'demo-fleet' },
  owner: { account: 'groundnuty', type: 'user', registry: { type: 'profile', user: 'groundnuty' } },
  network: { advertise_host: 'example.ts.net' },
  transport: { age_recipients: ['age1operator'] },
  defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
  agents: [{ role: 'code-agent', profile: 'code', repo: 'groundnuty/demo-code', deploy_path: '/x' }],
  trust: { ca: 'per-project', federated_cas: [] },
};

const AGENT: FleetAgent = MANIFEST.agents[0]!;

const CREDS: AppCredentials = {
  appId: '9001',
  name: 'demo-fleet-code-agent',
  slug: 'demo-fleet-code-agent',
  clientId: 'Iv1.client',
  clientSecret: 'SENTINEL-CLIENT-SECRET',
  webhookSecret: 'SENTINEL-WEBHOOK-SECRET',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL-PEM\n-----END RSA PRIVATE KEY-----\n',
};

function fakeFlowHandles(code: string | Error): ManifestFlowHandles {
  return {
    startUrl: 'http://127.0.0.1:9/',
    redirectUrl: 'http://127.0.0.1:9/callback',
    waitForCode: () => (code instanceof Error ? Promise.reject(code) : Promise.resolve(code)),
    close: () => Promise.resolve(),
  };
}

/** Fixed, distinct-from-gate-1 URL (groundnuty/macf#952) — the LOCAL interstitial `openUrl` now targets on gate 2, never GitHub's install URL directly. */
const FAKE_INTERSTITIAL_URL = 'http://127.0.0.1:19/';

function fakeInterstitialHandles(): InstallInterstitialHandles {
  return {
    startUrl: FAKE_INTERSTITIAL_URL,
    close: () => Promise.resolve(),
  };
}

function baseDeps(overrides: Partial<AgentApplyDeps> = {}): AgentApplyDeps {
  const logs: string[] = [];
  return {
    startManifestFlow: async () => fakeFlowHandles('the-code'),
    startInstallInterstitial: async () => fakeInterstitialHandles(),
    exchangeManifestCode: async () => CREDS,
    waitForAppInstallation: async () => ({ appId: CREDS.appId, installId: '5555', appSlug: CREDS.slug, accountLogin: 'groundnuty' }),
    confirmAppInstallation: async () => ({ status: 'unconfirmable' }) as IdentityConfirmation,
    openUrl: async () => {},
    log: (line: string) => logs.push(line),
    writeRecoveryArtifact: async () => {},
    ...overrides,
  };
}

describe('confirmBeforeCreateGuard', () => {
  const expected = { appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' };

  it('authorizes create when no prior lock entry exists', async () => {
    const decision = await confirmBeforeCreateGuard('code-agent', undefined, expected, {
      confirmAppInstallation: async () => {
        throw new Error('must not be called — no prior entry means nothing to confirm against');
      },
    });
    expect(decision).toEqual({ action: 'create' });
  });

  const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };

  it('skips-unverified when no resolveKeyPath is given (the production default — no vault-decrypt wired)', async () => {
    const decision = await confirmBeforeCreateGuard('code-agent', PRIOR, expected, {
      confirmAppInstallation: async () => {
        throw new Error('must not be called — no key path means nothing to confirm with');
      },
    });
    expect(decision.action).toBe('skip-unverified');
    expect(decision).toMatchObject({ appId: '9001' });
    if (decision.action === 'skip-unverified') {
      expect(decision.reason).toMatch(/vault-decrypt is not wired/);
    }
  });

  it('reuse-confirmed when a resolveKeyPath is given and confirmAppInstallation returns confirmed', async () => {
    const install: ConfirmedInstall = { appId: '9001', installId: '5555', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' };
    const decision = await confirmBeforeCreateGuard('code-agent', PRIOR, expected, {
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install }),
    });
    // groundnuty/macf#1012 — `keyPath` is now carried on `reuse-confirmed`
    // so `applyIdentity` can run `validateReuse` on this path too.
    expect(decision).toEqual({ action: 'reuse-confirmed', install, keyPath: '/fake/key.pem' });
  });

  it('resume-install when confirmAppInstallation returns app-no-install (the gate-1-succeeded/gate-2-interrupted resume case)', async () => {
    const decision = await confirmBeforeCreateGuard('code-agent', PRIOR, expected, {
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
    });
    expect(decision).toEqual({ action: 'resume-install', appId: '9001', keyPath: '/fake/key.pem' });
  });

  it('drift when confirmAppInstallation returns installed-unexpected-target — never silently resolved', async () => {
    const installs: ConfirmedInstall[] = [{ appId: '9001', installId: '7', appSlug: 'demo-fleet-code-agent', accountLogin: 'someone-else' }];
    const decision = await confirmBeforeCreateGuard('code-agent', PRIOR, expected, {
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'installed-unexpected-target', installs }),
    });
    expect(decision.action).toBe('drift');
    if (decision.action === 'drift') expect(decision.installs).toEqual(installs);
  });

  it('skip-unverified (never create) when confirmAppInstallation returns unconfirmable even WITH a key path', async () => {
    const decision = await confirmBeforeCreateGuard('code-agent', PRIOR, expected, {
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
    });
    expect(decision.action).toBe('skip-unverified');
  });
});

describe('applyAgentIdentity — create path', () => {
  it('happy path: no prior entry -> gate 1 -> gate 2 -> status created, carrying credentials', async () => {
    const opened: string[] = [];
    const deps = baseDeps({ openUrl: async (url) => { opened.push(url); } });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome).toEqual({
      role: 'code-agent',
      status: 'created',
      appId: '9001',
      installId: '5555',
      credentials: CREDS,
    });
    // Gate 1 (the manifest form) then gate 2 (groundnuty/macf#952: OUR OWN
    // local interstitial, never GitHub's install URL directly) — both gates
    // open a browser tab (consent-gate UX fix), not just gate 1.
    expect(opened).toEqual(['http://127.0.0.1:9/', FAKE_INTERSTITIAL_URL]);
  });

  it('prints BOTH gates\' URLs before opening the browser, and states what is being waited on', async () => {
    const logs: string[] = [];
    const deps = baseDeps({ log: (l) => logs.push(l) });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    const joined = logs.join('\n');
    // Gate 1's URL is printed (as a fallback, in case the browser-open silently misfired).
    expect(joined).toContain('http://127.0.0.1:9/');
    expect(joined).toMatch(/waiting for you to click "Create GitHub App"/);
    // Gate 2's LOCAL interstitial URL is printed (what's actually opened)...
    expect(joined).toContain(FAKE_INTERSTITIAL_URL);
    // ...and the REAL GitHub install URL (the REAL exchanged slug, not the
    // derived handle) is ALSO printed — a headless/`--yes` run has no page
    // to read, so the terminal must still carry the actionable URL
    // (groundnuty/macf#952 requirement 3).
    expect(joined).toContain('https://github.com/apps/demo-fleet-code-agent/installations/new');
    expect(joined).toMatch(/waiting for you to click "Install"/);
  });

  it('gate 2 browser-open failure does NOT abort the agent — the App already exists on GitHub by then', async () => {
    const deps = baseDeps({
      openUrl: async (url) => {
        // Gate 2's open now targets OUR interstitial URL, not GitHub's —
        // fail on anything that ISN'T gate 1's fixed fake URL.
        if (url !== 'http://127.0.0.1:9/') throw new Error('no DISPLAY / xdg-open missing');
        // gate 1's open still succeeds
      },
      log: () => {},
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created'); // NOT 'failed' — the printed URL is the fallback
  });

  it('passes the REAL exchanged slug (not the derived handle) as gate 2\'s expected identity', async () => {
    const seen: { appId: string; keyPath: string; expected?: { appSlug?: string; accountLogin?: string } }[] = [];
    const deps = baseDeps({
      exchangeManifestCode: async () => ({ ...CREDS, slug: 'demo-fleet-code-agent-2' }), // simulates a GitHub collision-suffixed slug
      waitForAppInstallation: async (opts) => {
        seen.push({ appId: opts.appId, keyPath: opts.keyPath, expected: opts.expected });
        return { appId: CREDS.appId, installId: '5555', appSlug: 'demo-fleet-code-agent-2', accountLogin: 'groundnuty' };
      },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.expected).toEqual({ appSlug: 'demo-fleet-code-agent-2', accountLogin: 'groundnuty' });
  });

  it('writes the PEM to a scratch file for gate 2, then removes it (cleanup verified for real — no fake fs)', async () => {
    let seenKeyPath = '';
    const deps = baseDeps({
      waitForAppInstallation: async (opts) => {
        seenKeyPath = opts.keyPath;
        expect(existsSync(opts.keyPath)).toBe(true); // exists WHILE gate 2 is polling
        return { appId: CREDS.appId, installId: '5555', appSlug: CREDS.slug, accountLogin: 'groundnuty' };
      },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(seenKeyPath).not.toBe('');
    expect(existsSync(seenKeyPath)).toBe(false); // gone after the call returns
  });

  it('gate 1 failure -> status failed, no gate 2 attempted', async () => {
    let gate2Called = false;
    const deps = baseDeps({
      exchangeManifestCode: async () => {
        throw new Error('one-shot code already redeemed');
      },
      waitForAppInstallation: async () => {
        gate2Called = true;
        throw new Error('must not be called');
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/consent gate 1/);
    expect(gate2Called).toBe(false);
  });

  it('writes the recovery artifact IMMEDIATELY after gate 1 exchange returns, BEFORE gate 2 starts (DR-043 §D5 durable-before-gate-2)', async () => {
    const callOrder: string[] = [];
    const seenCreds: { role: string; appId: string }[] = [];
    const deps = baseDeps({
      writeRecoveryArtifact: async (role, creds) => {
        callOrder.push('recovery-artifact');
        seenCreds.push({ role, appId: creds.appId });
      },
      waitForAppInstallation: async () => {
        callOrder.push('gate2');
        return { appId: CREDS.appId, installId: '5555', appSlug: CREDS.slug, accountLogin: 'groundnuty' };
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(callOrder).toEqual(['recovery-artifact', 'gate2']);
    expect(seenCreds).toEqual([{ role: 'code-agent', appId: CREDS.appId }]);
    expect(outcome.status).toBe('created');
  });

  it('recovery-artifact write failure aborts BEFORE gate 2 runs (DR-043 §D5 hard-failure invariant)', async () => {
    let gate2Called = false;
    const deps = baseDeps({
      writeRecoveryArtifact: async () => {
        throw new Error('disk full');
      },
      waitForAppInstallation: async () => {
        gate2Called = true;
        throw new Error('must not be called');
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toMatch(/durab.*gate 2/i);
      expect(outcome.reason).toContain('disk full');
      expect(outcome.reason).toContain(CREDS.appId);
      expect(outcome.reason).toContain(CREDS.name);
    }
    expect(gate2Called).toBe(false);
  });

  it('gate 2 failure after gate 1 succeeded -> status failed, names the app_id + a manual-recovery install URL (the gate-1->2 window)', async () => {
    const deps = baseDeps({
      waitForAppInstallation: async () => {
        throw new Error('timed out waiting for the install');
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toMatch(/consent gate 2/);
      expect(outcome.reason).toContain(CREDS.appId);
      expect(outcome.reason).toContain(CREDS.name);
      expect(outcome.reason).toMatch(/https:\/\/github\.com\/apps\/demo-fleet-code-agent\/installations\/new/);
    }
  });

  it('cleans up the scratch PEM even when gate 2 fails', async () => {
    let seenKeyPath = '';
    const deps = baseDeps({
      waitForAppInstallation: async (opts) => {
        seenKeyPath = opts.keyPath;
        throw new Error('boom');
      },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(existsSync(seenKeyPath)).toBe(false);
  });

  it('NEVER logs a secret value — no PEM/clientSecret/webhookSecret sentinel appears in any log line, on the happy path OR a failure', async () => {
    const logs: string[] = [];
    const reasons: string[] = [];
    const happy = baseDeps({ log: (l) => logs.push(l) });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, happy);

    const failing = baseDeps({
      log: (l) => logs.push(l),
      waitForAppInstallation: async () => { throw new Error('boom'); },
    });
    const failingOutcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, failing);
    if (failingOutcome.status === 'failed') reasons.push(failingOutcome.reason);

    // Also the recovery-artifact-write failure path (a DIFFERENT return
    // statement from the gate-2 failure above) — its reason string embeds
    // the underlying error message, which must never be a secret either.
    const recoveryFailing = baseDeps({
      log: (l) => logs.push(l),
      writeRecoveryArtifact: async () => { throw new Error('boom'); },
    });
    const recoveryOutcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, recoveryFailing);
    if (recoveryOutcome.status === 'failed') reasons.push(recoveryOutcome.reason);

    const joined = [...logs, ...reasons].join('\n');
    expect(joined).not.toContain('SENTINEL-CLIENT-SECRET');
    expect(joined).not.toContain('SENTINEL-WEBHOOK-SECRET');
    expect(joined).not.toContain('SENTINEL-PEM');
  });
});

// --- groundnuty/macf#967 Defect 2 — pre-flight App-name-collision check, run ONLY on the create path, BEFORE gate 1 ---

describe('applyAgentIdentity — pre-flight App-name-collision check (create path only, groundnuty/macf#967)', () => {
  it('taken-but-unconfirmable (checkAppNameCollision confirms "present") -> REFUSES before consent gate 1 opens; zero gate invocations; names both remedies', async () => {
    const startManifestFlow = vi.fn();
    const startInstallInterstitial = vi.fn();
    const openUrl = vi.fn(async () => {});
    let seenOwner: FleetManifest['owner'] | undefined;
    let seenSlug = '';
    const deps = baseDeps({
      startManifestFlow,
      startInstallInterstitial,
      openUrl,
      checkAppNameCollision: async (owner, appSlug) => {
        seenOwner = owner;
        seenSlug = appSlug;
        return 'present';
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    // The decisive assertion — NEITHER gate seam was ever invoked.
    expect(startManifestFlow).not.toHaveBeenCalled();
    expect(startInstallInterstitial).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      // Both remedies named verbatim (macf#967's exact two-option template).
      expect(outcome.reason).toContain('App "demo-fleet-code-agent" already exists');
      expect(outcome.reason).toContain("not in this fleet's vault");
      expect(outcome.reason).toContain('cannot be recovered');
      expect(outcome.reason).toContain('https://github.com/settings/apps/demo-fleet-code-agent/advanced');
      expect(outcome.reason).toContain('--vault/--identity-key');
    }
    // Checked the RIGHT identity — the fleet's owner + the derived handle.
    expect(seenOwner).toEqual(MANIFEST.owner);
    expect(seenSlug).toBe('demo-fleet-code-agent');
  });

  it('org-owned fleet: the refusal names the ORG-form settings URL (organizations/<org>/settings/apps/.../advanced)', async () => {
    const ORG_MANIFEST: FleetManifest = { ...MANIFEST, metadata: { name: 'macf-experiment' }, owner: { account: 'macf-experiment', type: 'org', registry: { type: 'org', org: 'macf-experiment' } } };
    const deps = baseDeps({ checkAppNameCollision: async () => 'present' });
    const outcome = await applyAgentIdentity(AGENT, ORG_MANIFEST, undefined, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('https://github.com/organizations/macf-experiment/settings/apps/macf-experiment-code-agent/advanced');
    }
  });

  it('absent (checkAppNameCollision confirms "absent") -> proceeds to gate 1 unchanged', async () => {
    const deps = baseDeps({ checkAppNameCollision: async () => 'absent' });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created'); // the happy path, unimpeded
  });

  it('unknown (checkAppNameCollision cannot verify) -> NEVER refuses — proceeds to gate 1; GitHub\'s own uniqueness check remains the backstop', async () => {
    const deps = baseDeps({ checkAppNameCollision: async () => 'unknown' });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created');
  });

  it('checkAppNameCollision OMITTED entirely -> no-op, proceeds to gate 1 exactly as before this fix (backward-compatible default)', async () => {
    const deps = baseDeps(); // no checkAppNameCollision override
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created');
  });

  it('a THROWING checkAppNameCollision degrades to unknown (fail-open, never a refusal) and still proceeds to gate 1', async () => {
    const logs: string[] = [];
    const deps = baseDeps({
      log: (l) => logs.push(l),
      checkAppNameCollision: async () => {
        throw new Error('gh unreachable');
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created');
    expect(logs.join('\n')).toMatch(/pre-flight App-name-collision check failed/);
  });

  it('is NEVER invoked on any non-create decision path (resume-install / reuse-confirmed / skip-unverified / drift)', async () => {
    const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };
    const checkAppNameCollision = vi.fn(async () => 'present' as const);
    // resume-install
    const resumeDeps = baseDeps({
      checkAppNameCollision,
      resolveKeyPath: () => '/resolved/key.pem',
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      waitForAppInstallation: async () => ({ appId: '9001', installId: '6001', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' }),
    });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, resumeDeps);
    // skip-unverified (no resolveKeyPath at all)
    const skipDeps = baseDeps({ checkAppNameCollision });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, skipDeps);
    expect(checkAppNameCollision).not.toHaveBeenCalled();
  });
});

// --- macf#988, DR-043 Amendment B consume side — findRecoveryArtifact ---

describe('applyAgentIdentity — recovery-artifact consume path (create path only, macf#988)', () => {
  const RECOVERED: AppCredentials = {
    appId: 'recovered-app-id',
    name: 'demo-fleet-code-agent',
    slug: 'demo-fleet-code-agent',
    clientId: 'Iv1.recovered',
    clientSecret: 'SENTINEL-RECOVERED-CLIENT-SECRET',
    webhookSecret: 'SENTINEL-RECOVERED-WEBHOOK-SECRET',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL-RECOVERED-PEM\n-----END RSA PRIVATE KEY-----\n',
  };

  it('a found recovery artifact skips gate 1 ENTIRELY (the decisive assertion) and resumes at gate 2, reporting status "created" with the recovered credentials', async () => {
    const startManifestFlow = vi.fn();
    const checkAppNameCollision = vi.fn(async () => 'present' as const); // would normally REFUSE — must never even be asked
    const deps = baseDeps({
      startManifestFlow,
      checkAppNameCollision,
      findRecoveryArtifact: async (role) => {
        expect(role).toBe('code-agent');
        return RECOVERED;
      },
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '7001', appSlug: RECOVERED.slug, accountLogin: 'groundnuty' }),
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    // The decisive assertion — gate 1's OWN seam was never invoked, and the
    // collision pre-flight (which would have refused) was never even asked.
    expect(startManifestFlow).not.toHaveBeenCalled();
    expect(checkAppNameCollision).not.toHaveBeenCalled();

    expect(outcome.status).toBe('created');
    if (outcome.status === 'created') {
      expect(outcome.appId).toBe(RECOVERED.appId);
      expect(outcome.installId).toBe('7001');
      expect(outcome.credentials).toEqual(RECOVERED);
    }
  });

  it('findRecoveryArtifact resolving undefined -> falls through to the #967 collision-refusal UNCHANGED (does not weaken it)', async () => {
    const findRecoveryArtifact = vi.fn(async () => undefined);
    const deps = baseDeps({
      findRecoveryArtifact,
      checkAppNameCollision: async () => 'present',
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(findRecoveryArtifact).toHaveBeenCalledWith('code-agent');
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      // Byte-identical #967 refusal text — proves the consume-path addition
      // doesn't change the refusal's shape when nothing was recoverable.
      expect(outcome.reason).toContain('App "demo-fleet-code-agent" already exists');
      expect(outcome.reason).toContain("not in this fleet's vault");
    }
  });

  it('findRecoveryArtifact OMITTED entirely -> no-op, proceeds exactly as before this fix (backward-compatible default)', async () => {
    const deps = baseDeps({ checkAppNameCollision: async () => 'absent' }); // no findRecoveryArtifact override
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created');
  });

  it('a THROWING findRecoveryArtifact degrades to "nothing recovered" (fail-open) and still proceeds to the collision check + gate 1', async () => {
    const logs: string[] = [];
    const deps = baseDeps({
      log: (l) => logs.push(l),
      findRecoveryArtifact: async () => {
        throw new Error('decrypt exploded');
      },
      checkAppNameCollision: async () => 'absent',
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created');
    expect(logs.join('\n')).toMatch(/recovery-artifact check failed/);
  });

  it('is NEVER invoked on any non-create decision path (resume-install / reuse-confirmed / skip-unverified / drift)', async () => {
    const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };
    const findRecoveryArtifact = vi.fn(async () => RECOVERED);
    const resumeDeps = baseDeps({
      findRecoveryArtifact,
      resolveKeyPath: () => '/resolved/key.pem',
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      waitForAppInstallation: async () => ({ appId: '9001', installId: '6001', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' }),
    });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, resumeDeps);
    const skipDeps = baseDeps({ findRecoveryArtifact });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, skipDeps);
    expect(findRecoveryArtifact).not.toHaveBeenCalled();
  });

  it('gate 2 failure on the recovered path names the app_id + notes the credential came from a recovery artifact', async () => {
    const deps = baseDeps({
      findRecoveryArtifact: async () => RECOVERED,
      waitForAppInstallation: async () => {
        throw new Error('timed out waiting for the install');
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('recovered from a durable recovery artifact');
      expect(outcome.reason).toContain(RECOVERED.appId);
    }
  });

  it('NEVER logs a secret value on the recovered path — no PEM/clientSecret/webhookSecret sentinel in any log line', async () => {
    const logs: string[] = [];
    const deps = baseDeps({
      log: (l) => logs.push(l),
      findRecoveryArtifact: async () => RECOVERED,
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '7001', appSlug: RECOVERED.slug, accountLogin: 'groundnuty' }),
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    const joined = logs.join('\n');
    expect(joined).not.toContain('SENTINEL-RECOVERED-CLIENT-SECRET');
    expect(joined).not.toContain('SENTINEL-RECOVERED-WEBHOOK-SECRET');
    expect(joined).not.toContain('SENTINEL-RECOVERED-PEM');
  });
});

// --- groundnuty/macf#1137 — pre-gate-2 observation on the recovery path ---

describe('applyAgentIdentity — pre-gate-2 install observation on the recovery path (groundnuty/macf#1137)', () => {
  const RECOVERED: AppCredentials = {
    appId: 'recovered-app-id',
    name: 'demo-fleet-code-agent',
    slug: 'demo-fleet-code-agent',
    clientId: 'Iv1.recovered',
    clientSecret: 'SENTINEL-RECOVERED-CLIENT-SECRET',
    webhookSecret: 'SENTINEL-RECOVERED-WEBHOOK-SECRET',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL-RECOVERED-PEM\n-----END RSA PRIVATE KEY-----\n',
  };
  const CONFIRMED_INSTALL: ConfirmedInstall = {
    appId: RECOVERED.appId,
    installId: '9999',
    appSlug: RECOVERED.slug,
    accountLogin: 'groundnuty',
    repositorySelection: 'selected',
  };

  // Decisive pair, case 1: an install that EXISTS on GitHub but is ABSENT
  // from the vault (the exact shape macf#1137 reported: a recovered
  // credential whose fleet.lock/vault never recorded the role). Per
  // assert-the-wrong-path.md, asserting only `outcome.status === 'created'`
  // would still pass against the OLD (broken) code — that code also reports
  // 'created' once the operator eventually clicks through the gate. The
  // decisive assertion is that the gate NEVER opened: zero interstitial/
  // openUrl calls.
  it('decisive pair (1): install already exists + is correctly scoped -> NO gate opened, work proceeds, the mismatch is reported', async () => {
    const startInstallInterstitial = vi.fn();
    const openUrl = vi.fn(async () => {});
    const logs: string[] = [];
    const confirmAppInstallation = vi.fn(async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }) as IdentityConfirmation);
    const deps = baseDeps({
      startInstallInterstitial,
      openUrl,
      log: (l) => logs.push(l),
      confirmAppInstallation,
      findRecoveryArtifact: async () => RECOVERED,
      // Mirrors apply-fleet.ts's real wiring (buildInstallScopeValidator) —
      // a validateInstall hook IS present in production; the check above
      // must be honored by it too, not bypassed.
      validateInstall: (install) => (install.repositorySelection === 'selected' ? undefined : 'wrong scope'),
    });

    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    // The decisive assertion — the gate's OWN seams were never invoked.
    expect(startInstallInterstitial).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();

    expect(outcome.status).toBe('created');
    if (outcome.status === 'created') {
      expect(outcome.appId).toBe(RECOVERED.appId);
      expect(outcome.installId).toBe('9999');
      expect(outcome.credentials).toEqual(RECOVERED);
    }

    // Reused the existing install-confirm primitive, on the recovered
    // App's real id + the recovered PEM (never a second implementation).
    expect(confirmAppInstallation).toHaveBeenCalledTimes(1);
    expect(confirmAppInstallation.mock.calls[0]?.[0]).toBe(RECOVERED.appId);

    // The vault/GitHub mismatch is reported, not silently absorbed.
    const joined = logs.join('\n');
    expect(joined).toMatch(/vault.*never recorded|drift/i);

    // Never logs a secret value on the skip-gate path either (the hard
    // constraint applies here too, not only on the normal gate-2 path the
    // pre-existing "NEVER logs a secret value" test already covers).
    expect(joined).not.toContain('SENTINEL-RECOVERED-CLIENT-SECRET');
    expect(joined).not.toContain('SENTINEL-RECOVERED-WEBHOOK-SECRET');
    expect(joined).not.toContain('SENTINEL-RECOVERED-PEM');
  });

  // Decisive pair, case 2: an install that genuinely does NOT exist ->
  // gate opens, exactly as today.
  it('decisive pair (2): install genuinely does not exist -> gate opens as today', async () => {
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const deps = baseDeps({
      startInstallInterstitial,
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      findRecoveryArtifact: async () => RECOVERED,
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '7001', appSlug: RECOVERED.slug, accountLogin: 'groundnuty' }),
    });

    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    expect(startInstallInterstitial).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('created');
    if (outcome.status === 'created') expect(outcome.installId).toBe('7001');
  });

  // Honest-unknown floor: a credential that CANNOT observe installs ->
  // gate opens, AND the log states why (never silently gated).
  it('a credential that cannot observe installs (unconfirmable) -> gate opens, and the log states why', async () => {
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const logs: string[] = [];
    const deps = baseDeps({
      startInstallInterstitial,
      log: (l) => logs.push(l),
      confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
      findRecoveryArtifact: async () => RECOVERED,
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '7002', appSlug: RECOVERED.slug, accountLogin: 'groundnuty' }),
    });

    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    expect(startInstallInterstitial).toHaveBeenCalledTimes(1); // the gate opened
    expect(outcome.status).toBe('created');
    // ...AND the operator is told why the shortcut wasn't taken.
    expect(logs.join('\n')).toMatch(/could not confirm whether the install already exists/);
  });

  it('a THROWING confirmAppInstallation is fail-open (inconclusive, never a silent skip) -> gate opens, log states why', async () => {
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const logs: string[] = [];
    const deps = baseDeps({
      startInstallInterstitial,
      log: (l) => logs.push(l),
      confirmAppInstallation: async () => {
        throw new Error('gh api unreachable');
      },
      findRecoveryArtifact: async () => RECOVERED,
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '7003', appSlug: RECOVERED.slug, accountLogin: 'groundnuty' }),
    });

    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    expect(startInstallInterstitial).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('created');
    expect(logs.join('\n')).toMatch(/pre-gate-2 install check threw/);
  });

  it('confirmed but validateInstall REJECTS (wrong scope) -> does NOT weaken the install-scope refusal — falls through to the normal gate-2 flow, never silently accepted', async () => {
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const badScopeInstall: ConfirmedInstall = { ...CONFIRMED_INSTALL, repositorySelection: 'all' };
    const deps = baseDeps({
      startInstallInterstitial,
      confirmAppInstallation: async () => ({ status: 'confirmed', install: badScopeInstall }),
      validateInstall: (install) => (install.repositorySelection === 'selected' ? undefined : 'wrong scope'),
      findRecoveryArtifact: async () => RECOVERED,
      // Once the gate re-opens, the SAME (bad-scope) install is what a
      // real waitForAppInstallation would observe again.
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '9999', appSlug: RECOVERED.slug, accountLogin: 'groundnuty', repositorySelection: 'all' }),
    });

    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    // The gate was NOT silently skipped for a mis-scoped install.
    expect(startInstallInterstitial).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('failed');
  });

  it('is a no-op on the FRESH-mint (viaRecovery: false) path — confirmAppInstallation is never called for a just-created App', async () => {
    const confirmAppInstallation = vi.fn(async () => ({ status: 'unconfirmable' }) as IdentityConfirmation);
    const deps = baseDeps({ confirmAppInstallation }); // no findRecoveryArtifact — ordinary create path
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created');
    expect(confirmAppInstallation).not.toHaveBeenCalled();
  });
});

describe('applyAgentIdentity — non-create outcomes short-circuit before any gate', () => {
  const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };

  it('reuse-confirmed (--vault/--identity-key with matching credentials): neither gate 1 nor gate 2 is attempted, and the NEW pre-flight collision check is never even reached', async () => {
    const install: ConfirmedInstall = { appId: '9001', installId: '5555', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' };
    const startManifestFlow = vi.fn();
    const waitForAppInstallation = vi.fn();
    const checkAppNameCollision = vi.fn(async () => 'present' as const);
    const deps = baseDeps({
      startManifestFlow,
      waitForAppInstallation,
      checkAppNameCollision,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install }),
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(outcome).toEqual({ role: 'code-agent', status: 'reused', appId: '9001', installId: '5555' });
    expect(startManifestFlow).not.toHaveBeenCalled();
    expect(waitForAppInstallation).not.toHaveBeenCalled();
    // Even wired to unconditionally return 'present', the collision check is
    // NEVER reached on the reuse-confirmed path — it lives strictly inside
    // the `decision.action === 'create'` branch.
    expect(checkAppNameCollision).not.toHaveBeenCalled();
  });

  it('resume-install: gate 1 is skipped, gate 2 runs with the resolver-provided key path', async () => {
    const startManifestFlow = vi.fn();
    let seenKeyPath = '';
    const deps = baseDeps({
      startManifestFlow,
      resolveKeyPath: () => '/resolved/key.pem',
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      waitForAppInstallation: async (opts) => {
        seenKeyPath = opts.keyPath;
        return { appId: '9001', installId: '6001', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' };
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(outcome).toEqual({ role: 'code-agent', status: 'resumed-install', appId: '9001', installId: '6001' });
    expect(startManifestFlow).not.toHaveBeenCalled();
    expect(seenKeyPath).toBe('/resolved/key.pem'); // the resolver's own path, NOT a scratch file this module wrote
  });

  it('resume-install: prints gate 2\'s (predicted) URL, opens it, and flags it as a prediction — not a confirmed slug', async () => {
    const opened: string[] = [];
    const logs: string[] = [];
    const deps = baseDeps({
      openUrl: async (url) => { opened.push(url); },
      log: (l) => logs.push(l),
      resolveKeyPath: () => '/resolved/key.pem',
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      waitForAppInstallation: async () => ({ appId: '9001', installId: '6001', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' }),
    });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    // groundnuty/macf#952 — resume-install ALSO opens the local interstitial,
    // never GitHub's (predicted) install URL directly.
    expect(opened).toEqual([FAKE_INTERSTITIAL_URL]);
    const joined = logs.join('\n');
    expect(joined).toMatch(/predicted from the fleet\/role naming convention/);
    // deriveAppHandle('demo-fleet', 'code-agent') — the ONLY slug available on
    // this path (no vault-decrypt wired to confirm the real one) — still
    // printed to the terminal even though it's not what got opened.
    expect(joined).toContain('https://github.com/apps/demo-fleet-code-agent/installations/new');
    expect(joined).toMatch(/waiting for you to click "Install"/);
  });

  it('resume-install: a gate-2 browser-open failure does not abort — the App already exists on GitHub', async () => {
    const deps = baseDeps({
      openUrl: async () => { throw new Error('no DISPLAY'); },
      log: () => {},
      resolveKeyPath: () => '/resolved/key.pem',
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      waitForAppInstallation: async () => ({ appId: '9001', installId: '6001', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' }),
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(outcome.status).toBe('resumed-install');
  });

  it('skipped-unverified never touches any gate', async () => {
    const startManifestFlow = vi.fn();
    const waitForAppInstallation = vi.fn();
    const deps = baseDeps({ startManifestFlow, waitForAppInstallation });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(outcome.status).toBe('skipped-unverified');
    expect(startManifestFlow).not.toHaveBeenCalled();
    expect(waitForAppInstallation).not.toHaveBeenCalled();
  });

  it('drift never touches any gate', async () => {
    const installs: ConfirmedInstall[] = [{ appId: '9001', installId: '7', appSlug: 'demo-fleet-code-agent', accountLogin: 'someone-else' }];
    const startManifestFlow = vi.fn();
    const deps = baseDeps({
      startManifestFlow,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'installed-unexpected-target', installs }),
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(outcome.status).toBe('drift');
    expect(startManifestFlow).not.toHaveBeenCalled();
  });
});

// --- groundnuty/macf#952 — the gate-2 interstitial's content derivation ---

const SCI_AGENT: FleetAgent = { role: 'science-agent', profile: 'research', repo: 'groundnuty/demo-science', deploy_path: '/y' };
const MULTI_AGENT_MANIFEST: FleetManifest = { ...MANIFEST, agents: [AGENT, SCI_AGENT] };

describe('installReposForIdentity (pure, groundnuty/macf#952)', () => {
  it('a role matching a declared agent gets EXACTLY its own home repo', () => {
    expect(installReposForIdentity('code-agent', MULTI_AGENT_MANIFEST)).toEqual(['groundnuty/demo-code']);
    expect(installReposForIdentity('science-agent', MULTI_AGENT_MANIFEST)).toEqual(['groundnuty/demo-science']);
  });

  it('a role with NO declared-agent match (e.g. runner-ops) gets EVERY declared agent repo', () => {
    expect(installReposForIdentity('runner-ops', MULTI_AGENT_MANIFEST)).toEqual([
      'groundnuty/demo-code',
      'groundnuty/demo-science',
    ]);
  });

  it('single-agent manifest: the matching role still gets just its own repo (not the whole array coincidentally)', () => {
    expect(installReposForIdentity('code-agent', MANIFEST)).toEqual(['groundnuty/demo-code']);
  });
});

describe('installWhyText (pure, groundnuty/macf#952)', () => {
  it('administration:write gets the specific blast-radius framing + the apply-refuses-"all" fact', () => {
    const text = installWhyText({ administration: 'write', actions: 'read', metadata: 'read' });
    expect(text).toMatch(/administration:write/);
    expect(text).toMatch(/blast radius/);
    expect(text).toMatch(/apply will refuse an "all" install/);
  });

  it('no administration permission gets the generic-but-concrete reason (undefined = DR-019 default set)', () => {
    const text = installWhyText(undefined);
    expect(text).not.toMatch(/administration/);
    expect(text).toMatch(/only needs access to the repo\(s\) listed above/);
  });

  it('a non-write administration level (defense-in-depth — never issued today) does NOT get the blast-radius framing', () => {
    expect(installWhyText({ administration: 'read' })).not.toMatch(/blast radius/);
  });
});

describe('gate 2 receives the derived repos/whyText (integration, groundnuty/macf#952)', () => {
  it('create path: startInstallInterstitial is called with the role, the real exchanged slug, the derived repos, and the why-text', async () => {
    const seen: { role: string; appName: string; repos: readonly string[]; whyText: string; gateNumber: number; gateTotal: number }[] = [];
    const deps = baseDeps({
      startInstallInterstitial: async (opts) => {
        seen.push(opts);
        return fakeInterstitialHandles();
      },
    });
    await applyAgentIdentity(AGENT, MULTI_AGENT_MANIFEST, undefined, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      role: 'code-agent',
      appName: CREDS.slug, // the REAL exchanged slug, not the derived handle
      repos: ['groundnuty/demo-code'],
      gateNumber: 2,
      gateTotal: 2,
    });
    expect(seen[0]?.whyText).toMatch(/only needs access to the repo\(s\) listed above/);
  });

  it('resume-install path: startInstallInterstitial ALSO gets the derived repos/why-text', async () => {
    const seen: { role: string; repos: readonly string[] }[] = [];
    const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };
    const deps = baseDeps({
      startInstallInterstitial: async (opts) => {
        seen.push(opts);
        return fakeInterstitialHandles();
      },
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      waitForAppInstallation: async () => ({ appId: '9001', installId: '6001', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' }),
    });
    await applyAgentIdentity(AGENT, MULTI_AGENT_MANIFEST, PRIOR, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.repos).toEqual(['groundnuty/demo-code']);
  });

  it('a role with no matching agent (runner-ops shape) gets every declared repo + the admin-write why-text', async () => {
    const seen: { role: string; repos: readonly string[]; whyText: string }[] = [];
    const deps = baseDeps({
      startInstallInterstitial: async (opts) => {
        seen.push(opts);
        return fakeInterstitialHandles();
      },
    });
    await applyIdentity(
      { role: 'runner-ops', permissions: { administration: 'write', actions: 'read', metadata: 'read' }, events: [] },
      MULTI_AGENT_MANIFEST,
      undefined,
      deps,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.repos).toEqual(['groundnuty/demo-code', 'groundnuty/demo-science']);
    expect(seen[0]?.whyText).toMatch(/blast radius/);
  });
});

describe('startInstallInterstitial failure degrades, never throws (groundnuty/macf#952)', () => {
  it('a local-listener bind failure falls back to opening GitHub\'s real install URL directly — status still "created", instruction still logged', async () => {
    const opened: string[] = [];
    const logs: string[] = [];
    const deps = baseDeps({
      startInstallInterstitial: async () => { throw new Error('EADDRINUSE'); },
      openUrl: async (url) => { opened.push(url); },
      log: (l) => logs.push(l),
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    // NEVER throws (module doc invariant) — resolves to a normal outcome.
    expect(outcome.status).toBe('created');
    // Falls back to GitHub's REAL install URL, not the (failed) local page.
    expect(opened).toEqual(['http://127.0.0.1:9/', 'https://github.com/apps/demo-fleet-code-agent/installations/new']);
    const joined = logs.join('\n');
    expect(joined).toMatch(/could not start the local install-instruction page/);
    // The instruction survives the degradation — it's in the terminal
    // instruction lines regardless of which URL got opened.
    expect(joined).toMatch(/Only select repositories/);
  });

  it('resume-install path ALSO degrades gracefully on a bind failure', async () => {
    const opened: string[] = [];
    const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };
    const deps = baseDeps({
      startInstallInterstitial: async () => { throw new Error('EADDRINUSE'); },
      openUrl: async (url) => { opened.push(url); },
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      waitForAppInstallation: async () => ({ appId: '9001', installId: '6001', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' }),
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(outcome.status).toBe('resumed-install');
    expect(opened).toEqual(['https://github.com/apps/demo-fleet-code-agent/installations/new']);
  });

  it('a close() failure on the interstitial does not mask a successful gate-2 result', async () => {
    const deps = baseDeps({
      startInstallInterstitial: async () => ({
        startUrl: FAKE_INTERSTITIAL_URL,
        close: () => Promise.reject(new Error('already closed')),
      }),
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created');
  });
});

// --- groundnuty/macf#952 — the decisive ordering test ---
//
// The whole defect this issue fixes is ORDERING: the operator's first live
// install picked GitHub's "All repositories" because the requirement only
// appeared in the FAILURE message, after the click. A test that merely
// asserts the instruction text EXISTS somewhere would pass even if it
// printed AFTER the navigation — this test asserts the instruction is
// logged strictly BEFORE `openUrl` is ever called, for BOTH gates.
//
// groundnuty/macf#971 extends this same discipline to gate 1's explanation
// itself: #952/#962 put that explanation ON the served page, where gate 1's
// own auto-submit script makes it unreadable BY CONSTRUCTION (confirmed live
// by the operator — "if I cannot see them, I'm not sure why they are
// there"). The explanation now lives ONLY in the terminal instructionLines
// printed here. The decisive assertion below is therefore not just
// "the instruction precedes openUrl" (already true structurally, since
// `announceAndOpenGate` prints instructionLines before calling `openUrl`)
// but that the ACTIONABLE clause — "click GitHub's own 'Create GitHub App'
// button" — is IN that pre-openUrl terminal stream. That clause is the one
// #971 requires to have moved off the auto-submitting page; a regression
// that quietly drops it back onto the page (and out of the terminal) would
// otherwise pass every other test in this file.

describe('instruction-before-navigation ordering (the decisive test, groundnuty/macf#952 + #971)', () => {
  it('gate 1: the App-name + as-is-submission + "Create GitHub App" click instructions are ALL logged BEFORE openUrl(flow.startUrl) is called', async () => {
    const events: string[] = [];
    const deps = baseDeps({
      log: (line: string) => { events.push(`log:${line}`); },
      openUrl: async (url: string) => { events.push(`open:${url}`); },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    const gate1OpenIndex = events.findIndex((e) => e === 'open:http://127.0.0.1:9/');
    expect(gate1OpenIndex).toBeGreaterThanOrEqual(0);

    // names the App (groundnuty/macf#971 requirement 1a — "which App").
    const appNameIndex = events.findIndex((e) => e.startsWith('log:') && e.includes(AGENT.role) && /creating GitHub App/i.test(e));
    // states the as-is submission (requirement 1b).
    const asIsIndex = events.findIndex((e) => e.startsWith('log:') && /submitted AS-IS/i.test(e));
    // THE decisive clause (requirement 1c, the actionable one): the next
    // click is GitHub's OWN "Create GitHub App" button — this exact string
    // must be in the TERMINAL stream, not only (as before #971) on a page
    // nobody can read.
    const clickInstructionIndex = events.findIndex((e) => e.startsWith('log:') && e.includes('Create GitHub App'));

    for (const idx of [appNameIndex, asIsIndex, clickInstructionIndex]) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(gate1OpenIndex);
    }
  });

  it('gate 2: the interstitial PAGE is started + the "Only select repositories" instruction is logged, BOTH before openUrl(interstitial.startUrl)', async () => {
    const events: string[] = [];
    const deps = baseDeps({
      log: (line: string) => { events.push(`log:${line}`); },
      openUrl: async (url: string) => { events.push(`open:${url}`); },
      // Marks the moment OUR page is actually up (bound + serving) — not
      // just that the intent to serve it was logged. Proves the structural
      // half of the fix (the page exists before the browser can reach
      // anything), not only the terminal-text half.
      startInstallInterstitial: async () => { events.push('interstitial:started'); return fakeInterstitialHandles(); },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    const interstitialStartedIndex = events.indexOf('interstitial:started');
    const instructionIndex = events.findIndex((e) => e.startsWith('log:') && e.includes('Only select repositories'));
    const gate2OpenIndex = events.findIndex((e) => e === `open:${FAKE_INTERSTITIAL_URL}`);
    expect(interstitialStartedIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(gate2OpenIndex).toBeGreaterThanOrEqual(0);
    // The page is up BEFORE the browser is told to navigate anywhere...
    expect(interstitialStartedIndex).toBeLessThan(gate2OpenIndex);
    // ...and the terminal instruction is printed before navigation too.
    expect(instructionIndex).toBeLessThan(gate2OpenIndex);
  });

  it('gate 2 (resume-install path): the instruction ALSO precedes the navigation', async () => {
    const events: string[] = [];
    const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };
    const deps = baseDeps({
      log: (line: string) => { events.push(`log:${line}`); },
      openUrl: async (url: string) => { events.push(`open:${url}`); },
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      waitForAppInstallation: async () => ({ appId: '9001', installId: '6001', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' }),
    });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);

    const instructionIndex = events.findIndex((e) => e.startsWith('log:') && e.includes('Only select repositories'));
    const openIndex = events.findIndex((e) => e === `open:${FAKE_INTERSTITIAL_URL}`);
    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeLessThan(openIndex);
  });
});

// --- groundnuty/macf#952 follow-up — the operator-beat happens AFTER the
// instructions are logged and BEFORE the browser opens ---
//
// The ordering fix above (#962/#974) closed "the requirement only appears in
// the failure message" — but printing and opening back-to-back left a
// SEPARATE, live-witnessed gap: "the first instructions were so fast that I
// didn't notice them at all." These tests assert the THIRD event
// (`waitForOperatorBeat`) sits strictly BETWEEN the instruction logs and
// `openUrl` — a test that only checked "beat happened at some point" would
// pass even if it fired after the browser already had focus, which is
// exactly the shape of bug this issue is about.

describe('waitForOperatorBeat sits between instructions and openUrl (the decisive ordering test, groundnuty/macf#952 follow-up)', () => {
  it('gate 1: waitForOperatorBeat is called with the role + gate label AFTER the instructions are logged and BEFORE openUrl(flow.startUrl)', async () => {
    const events: string[] = [];
    const deps = baseDeps({
      log: (line: string) => { events.push(`log:${line}`); },
      openUrl: async (url: string) => { events.push(`open:${url}`); },
      waitForOperatorBeat: async (role: string, gateLabel: string) => { events.push(`beat:${role}:${gateLabel}`); },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    const clickInstructionIndex = events.findIndex((e) => e.startsWith('log:') && e.includes('Create GitHub App'));
    const beatIndex = events.findIndex((e) => e.startsWith(`beat:${AGENT.role}:`) && e.includes('consent gate 1 of 2'));
    const gate1OpenIndex = events.findIndex((e) => e === 'open:http://127.0.0.1:9/');

    expect(clickInstructionIndex).toBeGreaterThanOrEqual(0);
    expect(beatIndex).toBeGreaterThanOrEqual(0);
    expect(gate1OpenIndex).toBeGreaterThanOrEqual(0);
    // Ordering, not merely presence — the whole defect is ordering.
    expect(clickInstructionIndex).toBeLessThan(beatIndex);
    expect(beatIndex).toBeLessThan(gate1OpenIndex);
  });

  it('gate 2: waitForOperatorBeat is called AFTER the "Only select repositories" instruction and BEFORE openUrl(interstitial.startUrl)', async () => {
    const events: string[] = [];
    const deps = baseDeps({
      log: (line: string) => { events.push(`log:${line}`); },
      openUrl: async (url: string) => { events.push(`open:${url}`); },
      waitForOperatorBeat: async (role: string, gateLabel: string) => { events.push(`beat:${role}:${gateLabel}`); },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    const instructionIndex = events.findIndex((e) => e.startsWith('log:') && e.includes('Only select repositories'));
    const beatIndex = events.findIndex((e) => e.startsWith(`beat:${AGENT.role}:`) && e.includes('consent gate 2 of 2'));
    const gate2OpenIndex = events.findIndex((e) => e === `open:${FAKE_INTERSTITIAL_URL}`);

    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(beatIndex).toBeGreaterThanOrEqual(0);
    expect(gate2OpenIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeLessThan(beatIndex);
    expect(beatIndex).toBeLessThan(gate2OpenIndex);
  });

  it('OMITTED entirely -> no-op, proceeds straight to openUrl exactly as before this fix (backward-compatible default)', async () => {
    const events: string[] = [];
    // baseDeps never sets waitForOperatorBeat — every pre-this-fix test in
    // this file already exercises this path implicitly; this test pins it
    // explicitly so a future regression that makes the hook non-optional
    // (breaking every caller that doesn't supply it) fails loudly here.
    const deps = baseDeps({
      log: (line: string) => { events.push(`log:${line}`); },
      openUrl: async (url: string) => { events.push(`open:${url}`); },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(events).toContain('open:http://127.0.0.1:9/');
    expect(events).toContain(`open:${FAKE_INTERSTITIAL_URL}`);
  });
});

// --- groundnuty/macf#952 — gate numbering + role attribution ---

describe('gates are numbered and role-attributed', () => {
  it('gate 1 and gate 2 log lines both carry "of 2" and the role', async () => {
    const logs: string[] = [];
    const deps = baseDeps({ log: (l) => logs.push(l) });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    const joined = logs.join('\n');
    expect(joined).toMatch(/Role "code-agent": consent gate 1 of 2/);
    expect(joined).toMatch(/Role "code-agent": consent gate 2 of 2/);
  });
});

// --- groundnuty/macf#967 Defect 2 — appNameCollisionRefusalMessage (pure) + realAgentApplyDeps wiring ---

describe('appNameCollisionRefusalMessage (pure)', () => {
  it('names both remedies verbatim: delete-at-URL, or re-run with --vault/--identity-key', () => {
    const msg = appNameCollisionRefusalMessage(
      'macf-experiment-runner-ops',
      'https://github.com/organizations/macf-experiment/settings/apps/macf-experiment-runner-ops/advanced',
    );
    expect(msg).toContain('App "macf-experiment-runner-ops" already exists');
    expect(msg).toContain("not in this fleet's vault");
    expect(msg).toContain('ownership cannot be proven');
    expect(msg).toContain('private key cannot be recovered');
    expect(msg).toContain('https://github.com/organizations/macf-experiment/settings/apps/macf-experiment-runner-ops/advanced');
    expect(msg).toContain('--vault/--identity-key');
  });
});

describe('realAgentApplyDeps wiring (groundnuty/macf#967)', () => {
  it('wires checkAppNameCollision to the real "ask, don\'t predict" resolver — a bare top-level reference, not a stub', () => {
    const deps = realAgentApplyDeps(async () => {}, () => {});
    expect(deps.checkAppNameCollision).toBe(resolveAppPresenceStatus);
  });

  // groundnuty/macf#952 follow-up — waitForOperatorBeat is a THIRD, optional,
  // trailing parameter (see this function's own doc for why trailing).
  it('the 2-arg call (every pre-this-fix caller) OMITS waitForOperatorBeat entirely — byte-identical to pre-fix wiring', () => {
    const deps = realAgentApplyDeps(async () => {}, () => {});
    expect(deps.waitForOperatorBeat).toBeUndefined();
    expect('waitForOperatorBeat' in deps).toBe(false);
  });

  it('a supplied 3rd arg is wired onto waitForOperatorBeat by identity — not wrapped, not a stub', () => {
    const beat = async (_role: string, _gateLabel: string): Promise<void> => {};
    const deps = realAgentApplyDeps(async () => {}, () => {}, beat);
    expect(deps.waitForOperatorBeat).toBe(beat);
  });
});

// --- groundnuty/macf#1063 — a recoverable consent-gate-2 rejection re-opens the SAME page instead of failing outright ---

describe('groundnuty/macf#1063 — recoverable consent-gate-2 rejection re-opens the same page', () => {
  const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };
  const REUSE_INSTALL: ConfirmedInstall = { appId: '9001', installId: '5555', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' };
  const MISSING_REPO_REASON = registryRepoNotInstalledReason('demo-fleet-code-agent', 'groundnuty', 'demo-fleet-control');

  it('DECISIVE: a reuse rejected for a missing registry repo re-opens the gate and succeeds on the second attempt — the check seam is invoked AGAIN, not just once', async () => {
    let validateReuseCalls = 0;
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const deps = baseDeps({
      startInstallInterstitial,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      waitForAppInstallation: async () => REUSE_INSTALL,
      allowInstallRetry: true,
      validateReuse: async () => {
        validateReuseCalls += 1;
        // Rejects on the FIRST check (the live incident's shape — install
        // exists but is missing the registry repo); accepts on the SECOND,
        // simulating the operator fixing it on the reopened page.
        return validateReuseCalls === 1 ? MISSING_REPO_REASON : undefined;
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    // Per assert-the-wrong-path.md: "it eventually succeeded" alone cannot
    // tell a genuine retry-then-fix apart from a fake that always accepted.
    // The call-count assertion is what distinguishes them — a
    // never-rejects fake would show validateReuseCalls === 1, not 2.
    expect(validateReuseCalls).toBe(2);
    expect(startInstallInterstitial).toHaveBeenCalledTimes(1); // exactly ONE reopen — not a re-poll disguised as a fresh gate
    expect(outcome).toEqual({ role: 'code-agent', status: 'reused', appId: '9001', installId: '5555' });
  });

  it('CREATE path: a validateInstall rejection on the freshly-installed App also re-opens gate 2 and succeeds on retry', async () => {
    let validateInstallCalls = 0;
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const deps = baseDeps({
      startInstallInterstitial,
      allowInstallRetry: true,
      waitForAppInstallation: async () => ({ appId: CREDS.appId, installId: '5555', appSlug: CREDS.slug, accountLogin: 'groundnuty' }),
      validateInstall: async () => {
        validateInstallCalls += 1;
        return validateInstallCalls === 1 ? MISSING_REPO_REASON : undefined;
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(validateInstallCalls).toBe(2);
    // Gate 2's interstitial opens once for the NORMAL first attempt (every
    // create goes through it regardless of #1063) + once more for the retry.
    expect(startInstallInterstitial).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ role: 'code-agent', status: 'created', appId: '9001', installId: '5555', credentials: CREDS });
  });

  it('bounds the retries: after the configured number of attempts it still fails, with the full explanation (assert the count)', async () => {
    let validateReuseCalls = 0;
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const deps = baseDeps({
      startInstallInterstitial,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      waitForAppInstallation: async () => REUSE_INSTALL,
      allowInstallRetry: true,
      validateReuse: async () => {
        validateReuseCalls += 1;
        return MISSING_REPO_REASON; // NEVER fixed — the operator never gets it right
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    // 1 initial check + N reopen-and-recheck retries — a small, FIXED bound,
    // not an unbounded loop. Pinned here as a literal so a future change to
    // the bound is a deliberate, reviewed test edit, not a silent drift.
    expect(validateReuseCalls).toBe(3);
    expect(startInstallInterstitial).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain(MISSING_REPO_REASON);
      expect(outcome.reason).toMatch(/gave up after 2 attempt/i);
    }
  });

  it('--yes / unattended (allowInstallRetry omitted) never re-opens the gate — verifies once, refuses, exits, exactly as before #1063; the prompt/open seam is never reached', async () => {
    let validateReuseCalls = 0;
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const openUrl = vi.fn(async () => {});
    const waitForOperatorBeat = vi.fn(async () => {});
    const deps = baseDeps({
      startInstallInterstitial,
      openUrl,
      waitForOperatorBeat,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      // allowInstallRetry deliberately OMITTED — this is bootstrap-apply.ts's
      // real `--yes` wiring (`assumeYes !== true` -> false).
      validateReuse: async () => {
        validateReuseCalls += 1;
        return MISSING_REPO_REASON;
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(validateReuseCalls).toBe(1); // one check, no retry
    expect(startInstallInterstitial).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(waitForOperatorBeat).not.toHaveBeenCalled(); // the prompt seam is UNREACHED, not merely a no-op
    expect(outcome).toEqual({
      role: 'code-agent',
      status: 'failed',
      reason: `existing install re-verification rejected: ${MISSING_REPO_REASON}`,
    });
  });

  it('DECISIVE: the operator gets a genuine post-open wait before each re-check — waitForOperatorFix runs BEFORE the poll/re-validate, not merely wired', async () => {
    const callOrder: string[] = [];
    let validateReuseCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial: async () => fakeInterstitialHandles(),
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      waitForAppInstallation: async () => {
        callOrder.push('poll');
        return REUSE_INSTALL;
      },
      allowInstallRetry: true,
      waitForOperatorFix: async () => {
        callOrder.push('wait-for-fix');
      },
      validateReuse: async () => {
        validateReuseCalls += 1;
        callOrder.push(`validate-${String(validateReuseCalls)}`);
        return validateReuseCalls === 1 ? MISSING_REPO_REASON : undefined;
      },
    });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    // validate-1 is the instant reuse check (no page open, pre-#1063
    // behavior). Then: reopen -> wait-for-fix (the operator's genuine
    // window) -> poll -> validate-2. Without the wait step, poll/validate-2
    // would immediately follow validate-1 with nothing giving the operator
    // a chance to act — this ordering assertion is what catches that.
    expect(callOrder).toEqual(['validate-1', 'wait-for-fix', 'poll', 'validate-2']);
  });

  it('the retry dialogue shows the CLEAN retryInstruction, never the technical message (its GET/HTTP/issue-number detail), when the rejecting hook supplies one', async () => {
    const logs: string[] = [];
    let validateReuseCalls = 0;
    const cleanInstruction = registryRepoRetryInstruction('demo-fleet-code-agent', 'groundnuty', 'demo-fleet-control');
    const deps = baseDeps({
      startInstallInterstitial: async () => fakeInterstitialHandles(),
      log: (l) => logs.push(l),
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      waitForAppInstallation: async () => REUSE_INSTALL,
      allowInstallRetry: true,
      validateReuse: async () => {
        validateReuseCalls += 1;
        if (validateReuseCalls === 1) return { message: MISSING_REPO_REASON, retryInstruction: cleanInstruction };
        return undefined;
      },
    });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    // The clean sentence IS shown, as its own printed line (the retry
    // dialogue's instructionLines are logged one-per-line).
    expect(logs).toContain(`Role "code-agent": ${cleanInstruction}`);
    // The technical `message` (its GET/HTTP-status/issue-number detail)
    // reaches the ONE pre-existing diagnostic line ("REFUSED on reuse — …",
    // unchanged from before #1063) — but the interactive dialogue's OWN
    // lines (everything logged as part of reopening the gate: from the
    // "reopened after a rejection" gate label onward) must never repeat it.
    const reopenIndex = logs.findIndex((l) => l.includes('reopened after a rejection'));
    expect(reopenIndex).toBeGreaterThanOrEqual(0);
    const dialogueLines = logs.slice(reopenIndex);
    expect(dialogueLines.some((l) => l.includes('GET /repos'))).toBe(false);
    expect(dialogueLines.some((l) => l.includes('#999') || l.includes('#1012'))).toBe(false);
  });

  it('a NON-recoverable failure (waitForAppInstallation itself throwing — not a validateInstall rejection) is never retried, even with allowInstallRetry set', async () => {
    let waitCalls = 0;
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const deps = baseDeps({
      startInstallInterstitial,
      allowInstallRetry: true,
      waitForAppInstallation: async () => {
        waitCalls += 1;
        throw new Error('timed out waiting for the install');
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(waitCalls).toBe(1); // no retry — this class of failure is untouched by #1063
    expect(startInstallInterstitial).toHaveBeenCalledTimes(1); // the ONE normal gate-2 attempt only
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toMatch(/consent gate 2 \(install\) failed/);
  });

  it('the retry announcement names the specific repo — the underlying rejection is printed verbatim, never summarized away', async () => {
    const logs: string[] = [];
    let validateReuseCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial: async () => fakeInterstitialHandles(),
      log: (l) => logs.push(l),
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      waitForAppInstallation: async () => REUSE_INSTALL,
      allowInstallRetry: true,
      validateReuse: async () => {
        validateReuseCalls += 1;
        return validateReuseCalls === 1 ? MISSING_REPO_REASON : undefined;
      },
    });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    const joined = logs.join('\n');
    expect(joined).toContain('groundnuty/demo-fleet-control'); // the repo named by the (real) registry-repo-coverage message
    expect(joined).toContain('demo-fleet-code-agent'); // the App handle, same message
  });

  it('no internal issue/PR references leak into any of the NEW #1063 text (the retry instruction + the "gave up" explanation) — comments may cite them freely, output may not', async () => {
    // A rejection reason with NO issue references of its own (unlike the
    // real `registryRepoNotInstalledReason`, which — pre-existing, #1012's
    // own shipped text — cites `groundnuty/macf#999`/`#1012` by design; that
    // choice belongs to #1012, not this issue, so re-litigating it here
    // would test the wrong code). Isolating the reason this way means every
    // reference this assertion could catch is one #1063 itself introduced.
    const NO_REF_REASON = 'App is installed, but its install does not cover the required repository.';
    const logs: string[] = [];
    let validateReuseCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial: async () => fakeInterstitialHandles(),
      log: (l) => logs.push(l),
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      waitForAppInstallation: async () => REUSE_INSTALL,
      allowInstallRetry: true,
      validateReuse: async () => {
        validateReuseCalls += 1;
        return NO_REF_REASON; // never fixed -> exhausts retries -> the "gave up" message also gets checked
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(validateReuseCalls).toBe(3); // sanity: the retry path (and its "gave up" text) actually ran
    const issueRefPattern = /#\d+|DR-\d+/i;
    expect(logs.join('\n')).not.toMatch(issueRefPattern);
    if (outcome.status === 'failed') expect(outcome.reason).not.toMatch(issueRefPattern);
  });
});
