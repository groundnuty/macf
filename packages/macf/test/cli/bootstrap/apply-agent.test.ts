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
  confirmBeforeCreateGuard,
  type AgentApplyDeps,
} from '../../../src/cli/bootstrap/apply-agent.js';
import type { FleetAgent, FleetLockAgent, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { AppCredentials } from '../../../src/cli/bootstrap/manifest-exchange.js';
import type { ConfirmedInstall, IdentityConfirmation } from '../../../src/cli/bootstrap/identity-confirm.js';
import type { ManifestFlowHandles } from '../../../src/cli/bootstrap/manifest-flow-server.js';

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

function baseDeps(overrides: Partial<AgentApplyDeps> = {}): AgentApplyDeps {
  const logs: string[] = [];
  return {
    startManifestFlow: async () => fakeFlowHandles('the-code'),
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
    // Gate 1 (the manifest form) then gate 2 (the install page, using the
    // REAL exchanged slug) — both gates now open a browser tab (consent-gate
    // UX fix), not just gate 1.
    expect(opened).toEqual(['http://127.0.0.1:9/', 'https://github.com/apps/demo-fleet-code-agent/installations/new']);
  });

  it('prints BOTH gates\' URLs before opening the browser, and states what is being waited on', async () => {
    const logs: string[] = [];
    const deps = baseDeps({ log: (l) => logs.push(l) });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    const joined = logs.join('\n');
    // Gate 1's URL is printed (as a fallback, in case the browser-open silently misfired).
    expect(joined).toContain('http://127.0.0.1:9/');
    expect(joined).toMatch(/waiting for you to click "Create GitHub App"/);
    // Gate 2's URL (the REAL exchanged slug, not the derived handle) is also printed.
    expect(joined).toContain('https://github.com/apps/demo-fleet-code-agent/installations/new');
    expect(joined).toMatch(/waiting for you to click "Install"/);
  });

  it('gate 2 browser-open failure does NOT abort the agent — the App already exists on GitHub by then', async () => {
    const deps = baseDeps({
      openUrl: async (url) => {
        if (url.includes('installations/new')) throw new Error('no DISPLAY / xdg-open missing');
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

describe('applyAgentIdentity — non-create outcomes short-circuit before any gate', () => {
  const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };

  it('reuse-confirmed: neither gate 1 nor gate 2 is attempted', async () => {
    const install: ConfirmedInstall = { appId: '9001', installId: '5555', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty' };
    const startManifestFlow = vi.fn();
    const waitForAppInstallation = vi.fn();
    const deps = baseDeps({
      startManifestFlow,
      waitForAppInstallation,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install }),
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(outcome).toEqual({ role: 'code-agent', status: 'reused', appId: '9001', installId: '5555' });
    expect(startManifestFlow).not.toHaveBeenCalled();
    expect(waitForAppInstallation).not.toHaveBeenCalled();
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
    // deriveAppHandle('demo-fleet', 'code-agent') — the ONLY slug available on
    // this path (no vault-decrypt wired to confirm the real one).
    expect(opened).toEqual(['https://github.com/apps/demo-fleet-code-agent/installations/new']);
    const joined = logs.join('\n');
    expect(joined).toMatch(/predicted from the fleet\/role naming convention/);
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
