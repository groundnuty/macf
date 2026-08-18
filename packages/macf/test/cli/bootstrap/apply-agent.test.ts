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
    expect(decision).toEqual({ action: 'reuse-confirmed', install });
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

describe('instruction-before-navigation ordering (the decisive test, groundnuty/macf#952)', () => {
  it('gate 1: the "creating GitHub App" instruction is logged BEFORE openUrl(flow.startUrl) is called', async () => {
    const events: string[] = [];
    const deps = baseDeps({
      log: (line: string) => { events.push(`log:${line}`); },
      openUrl: async (url: string) => { events.push(`open:${url}`); },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    const instructionIndex = events.findIndex((e) => e.startsWith('log:') && /submitted AS-IS/i.test(e));
    const gate1OpenIndex = events.findIndex((e) => e === 'open:http://127.0.0.1:9/');
    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(gate1OpenIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeLessThan(gate1OpenIndex);
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
});
