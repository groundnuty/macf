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
  openInstallScopeCoverageGate,
  realAgentApplyDeps,
  type AgentApplyDeps,
} from '../../../src/cli/bootstrap/apply-agent.js';
import type { FleetAgent, FleetLockAgent, FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import type { AppCredentials } from '../../../src/cli/bootstrap/manifest-exchange.js';
import type { ConfirmedInstall, IdentityConfirmation } from '../../../src/cli/bootstrap/identity-confirm.js';
import { CANCEL_LABEL, CHECK_AGAIN_LABEL, escapeHtmlAttribute, renderInstallInterstitial, startInstallInterstitial as realStartInstallInterstitial } from '../../../src/cli/bootstrap/manifest-flow-server.js';
import type { InstallInterstitialHandles, InstallInterstitialOptions, ManifestFlowHandles } from '../../../src/cli/bootstrap/manifest-flow-server.js';
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

/**
 * groundnuty/macf#1176 — extracts the `<pre>` content under the named `<h2>`
 * heading, split into lines. Superseded the `<li>`-per-`messageLines`-entry
 * shape #1173 pinned (`renderInstallInterstitial` now renders two distinct
 * `<pre>` blocks — see that function's own doc). The `<pre[^>]*>` form
 * (groundnuty/macf#1179) tolerates the `class="macf-repos"`/`class=
 * "macf-instructions"` attribute the CSS-class split added — this helper
 * extracts CONTENT, the class-split's own tests assert the classes
 * themselves (`manifest-flow-server.test.ts`).
 */
function extractPreBlock(html: string, heading: string): readonly string[] {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<h2>${escapedHeading}<\\/h2>\\n<pre[^>]*>([\\s\\S]*?)<\\/pre>`);
  const match = re.exec(html);
  return match ? match[1]!.split('\n') : [];
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

  it('confirmed but validateInstall REJECTS (wrong scope) -> does NOT weaken the install-scope refusal, and (groundnuty/macf#1178) auto-opens the page + polls rather than a menu-walk refusal', async () => {
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const badScopeInstall: ConfirmedInstall = { ...CONFIRMED_INSTALL, repositorySelection: 'all' };
    const deps = baseDeps({
      startInstallInterstitial,
      // groundnuty/macf#1178 — never fixed in this fixture, so
      // pollForInstallFix runs to its OWN timeout; keep the budget tiny so
      // the test does not actually wait the real 10-minute default.
      gateTimeoutMs: 30,
      pollIntervalMs: 10,
      confirmAppInstallation: async () => ({ status: 'confirmed', install: badScopeInstall }),
      validateInstall: (install) => (install.repositorySelection === 'selected' ? undefined : 'wrong scope'),
      findRecoveryArtifact: async () => RECOVERED,
    });

    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    // groundnuty/macf#1178 — the operator's own ruling reverses #1175's
    // refusal-without-opening choice: a confirmed-but-insufficient install
    // now auto-opens the SAME gate-2 page (never a menu-walk) and polls for
    // the fix. The refusal was NOT silently accepted either — the failure
    // is still reported once the (tiny, test-only) poll budget runs out.
    expect(startInstallInterstitial).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toContain('wrong scope');
  });

  it('is a no-op on the FRESH-mint (viaRecovery: false) path — confirmAppInstallation is never called for a just-created App', async () => {
    const confirmAppInstallation = vi.fn(async () => ({ status: 'unconfirmable' }) as IdentityConfirmation);
    const deps = baseDeps({ confirmAppInstallation }); // no findRecoveryArtifact — ordinary create path
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('created');
    expect(confirmAppInstallation).not.toHaveBeenCalled();
  });
});

// --- groundnuty/macf#1160 — resumed gate names only the missing repo ---
//
// A live incident: the operator selected ONE of two required repos on gate
// 2's install page, the registry-repo-coverage check correctly refused, and
// on RE-RUN the instruction restated BOTH repos as if nothing had been
// done — discarding the exact single-repo observation the refusal had just
// computed. `finishGate2FromCredentials`'s `viaRecovery` path (the SAME
// gate-1-succeeded/gate-2-rejected shape macf#988's recovery-artifact
// consume side resumes into) is where that observation used to be thrown
// away — see `skipGate2IfAlreadyInstalled`/`resumeGate2Preflight`'s own doc.
describe('applyAgentIdentity — resumed-gate instruction reuses the pre-flight rejection, never restates the full set (groundnuty/macf#1160)', () => {
  const MANIFEST_TWO_REPOS: FleetManifest = {
    ...MANIFEST,
    owner: { ...MANIFEST.owner, registry: { type: 'repo', owner: 'groundnuty', repo: 'demo-fresh-control' } },
  };
  const AGENT_TWO_REPOS: FleetAgent = MANIFEST_TWO_REPOS.agents[0]!;
  const FULL_SELECT_EXACTLY_LINE = 'select exactly: groundnuty/demo-code, groundnuty/demo-fresh-control';

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

  // Sentinel strings — deliberately NOT produced via `gate2ResumedInstructionLines`
  // or any other production helper (assert-the-wrong-path.md trigger 1: a
  // test that builds its expectation with the same helper that builds the
  // instruction can never fail). The fixture's `validateInstall` return
  // value IS "the same observation the refusal used" per the issue's own
  // requirement; the test only has to prove that value survives into the
  // printed instruction verbatim, so a literal, unrelated string is the
  // right fixture.
  const SENTINEL_TECHNICAL_REASON = 'SENTINEL-TECHNICAL: control repo not reachable under this App JWT.';
  const SENTINEL_RETRY_INSTRUCTION = 'SENTINEL-RETRY: add groundnuty/demo-fresh-control under Repository access, then Save.';

  // Decisive pair, item 1: a resumed gate whose install already covers one
  // of the two required repos -> the instruction names ONLY the missing
  // one (verbatim, from the SAME rejection already computed) and never
  // restates the full required set.
  it('decisive (1): resumed gate, one of two required repos already covered -> instruction names only the missing repo, never the full "select exactly" restatement', async () => {
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const logs: string[] = [];
    let calls = 0;
    const deps = baseDeps({
      startInstallInterstitial,
      log: (l) => logs.push(l),
      gateTimeoutMs: 200,
      pollIntervalMs: 10,
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }) as IdentityConfirmation,
      findRecoveryArtifact: async () => RECOVERED,
      // Rejects the pre-flight check (call 1), then the poll's first tick
      // (call 2) observes the fix — proves the poll re-checks rather than
      // trusting its own pre-flight observation forever.
      validateInstall: () => {
        calls += 1;
        return calls === 1 ? { message: SENTINEL_TECHNICAL_REASON, retryInstruction: SENTINEL_RETRY_INSTRUCTION } : undefined;
      },
    });

    const outcome = await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);

    // groundnuty/macf#1178 — the operator's ruling: a resumed,
    // confirmed-but-insufficient install auto-opens the SAME gate-2 page
    // (never a menu-walk refusal).
    expect(startInstallInterstitial).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('created');

    const joined = logs.join('\n');
    // The delta — verbatim from the pre-flight's OWN already-computed rejection.
    expect(joined).toContain(SENTINEL_RETRY_INSTRUCTION);
    // The resumed framing — an install already exists; this is not a from-scratch ask.
    expect(joined).toContain("this App's install already exists from an earlier run");
    // The decisive negative: the old full-list restatement must be GONE.
    expect(joined).not.toContain(FULL_SELECT_EXACTLY_LINE);
    expect(joined).not.toContain('select exactly:');
    // groundnuty/macf#1178 — the App is already installed on this path;
    // the button to click is "Save," never "Install" again.
    expect(joined).toContain('waiting for you to click "Save"');
    expect(joined).not.toContain('waiting for you to click "Install"');
  });

  // groundnuty/macf#1178 — the operator's ruling reverses #1175's own fix:
  // a resumed gate whose install already exists but fails validation now
  // auto-opens the page (never a six-step menu-walk refusal) and polls the
  // installation's CONTENTS — re-running `validate` on every tick — rather
  // than merely re-confirming the install still exists (which would
  // resolve instantly and prove nothing changed).
  it('groundnuty/macf#1178 — a resumed gate whose install already exists auto-opens the page and polls for the fix, never a menu-walk refusal', async () => {
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const openUrl = vi.fn(async () => {});
    const logs: string[] = [];
    let validateCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial,
      openUrl,
      log: (l) => logs.push(l),
      gateTimeoutMs: 200,
      pollIntervalMs: 10,
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }) as IdentityConfirmation,
      findRecoveryArtifact: async () => RECOVERED,
      validateInstall: () => {
        validateCalls += 1;
        // Rejects the pre-flight (call 1) AND the poll's first tick (call
        // 2) — accepts on the third, simulating the operator saving the
        // fix mid-poll.
        return validateCalls <= 2 ? { message: SENTINEL_TECHNICAL_REASON, retryInstruction: SENTINEL_RETRY_INSTRUCTION } : undefined;
      },
    });

    const outcome = await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);

    // The page opened, and the browser launch was attempted — nothing left
    // for the operator to walk a settings menu for.
    expect(startInstallInterstitial).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledTimes(1);
    // Decisive per assert-the-wrong-path.md: "it eventually succeeded"
    // alone cannot tell a genuine poll-then-fix apart from a fake that
    // always accepted — the call count is what distinguishes them.
    expect(validateCalls).toBe(3);
    expect(outcome.status).toBe('created');
    const joined = logs.join('\n');
    expect(joined).toContain('waiting for you to click "Save"');
    expect(joined).toContain('apply detected it automatically');
  });

  // groundnuty/macf#1178 — the SAME shape, but the fix never lands: the
  // poll must terminate on its OWN timeout (bounded via gateTimeoutMs in
  // this test, never the real 10-minute default) rather than hang, and the
  // failure message must state the bound it actually waited.
  it('groundnuty/macf#1178 — an unattended run on a resumed gate terminates on timeout rather than hanging, and states the bound it waited', async () => {
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const deps = baseDeps({
      startInstallInterstitial,
      gateTimeoutMs: 30,
      pollIntervalMs: 10,
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }) as IdentityConfirmation,
      findRecoveryArtifact: async () => RECOVERED,
      // Never fixed — the operator never gets to it in this run.
      validateInstall: () => ({ message: SENTINEL_TECHNICAL_REASON, retryInstruction: SENTINEL_RETRY_INSTRUCTION }),
    });

    const outcome = await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);

    expect(startInstallInterstitial).toHaveBeenCalledTimes(1); // opened once — no reopen loop, one continuous poll
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      // Leads with the action (the retryInstruction), states the bound in
      // SECONDS (never a rounded-to-minutes false claim on a sub-minute
      // test budget — identity-confirm.ts::waitForInstallTimeoutMessage's
      // own lesson), and never claims to hang.
      expect(outcome.reason).toContain(SENTINEL_RETRY_INSTRUCTION);
      expect(outcome.reason).toMatch(/polled for \d+ms|polled for \d+s/);
    }
  });

  // groundnuty/macf#1178 — THE decisive test. Per assert-the-wrong-path.md
  // (two triggers) and the authoring check codify-at-correction-time.md
  // added: a test that fakes `startInstallInterstitial` and asserts "the
  // fake was called" cannot reproduce the live failure #1175 found — the
  // page opened, but was gone before it could be fetched, three times,
  // live. That failure is invisible to a mock; it is only visible to a
  // REAL HTTP server. This test uses the REAL `startInstallInterstitial`
  // (binds a real ephemeral 127.0.0.1 listener) and fakes only `openUrl`
  // (to capture the URL instead of actually launching a browser) and the
  // GitHub reads. The decisive assertion runs FROM INSIDE `validateInstall`
  // — i.e. WHILE `pollForInstallFix` is still polling, mid-run, not after
  // the outcome resolves — and does a REAL `fetch` of the captured URL.
  it('groundnuty/macf#1178 DECISIVE: on a confirmed-but-insufficient install, a REAL page is opened AND a REAL fetch of it succeeds WHILE the run is still polling', async () => {
    let capturedUrl: string | undefined;
    let fetchedWhileWaiting: string | undefined;
    let validateCalls = 0;
    const confirmCalls: number[] = [];
    const deps = baseDeps({
      startInstallInterstitial: realStartInstallInterstitial, // the REAL listener — no fake
      openUrl: async (url) => {
        capturedUrl = url;
      },
      gateTimeoutMs: 2000,
      pollIntervalMs: 10,
      confirmAppInstallation: async () => {
        confirmCalls.push(Date.now());
        return { status: 'confirmed', install: CONFIRMED_INSTALL } as IdentityConfirmation;
      },
      findRecoveryArtifact: async () => RECOVERED,
      validateInstall: async () => {
        validateCalls += 1;
        // On the poll's first internal tick (call 2 — call 1 is the
        // pre-flight's own check, before any page exists), the page is
        // open and `capturedUrl` is set: fetch it FOR REAL, right now,
        // while apply is still waiting on THIS call to resolve. This is
        // exactly the moment the live incident found the server already
        // gone — a fake `startInstallInterstitial` cannot fail this way.
        if (validateCalls === 2 && capturedUrl !== undefined) {
          const response = await fetch(capturedUrl);
          fetchedWhileWaiting = await response.text();
        }
        // Accept on the 3rd call — lets the poll (and the test) terminate.
        return validateCalls < 3 ? { message: SENTINEL_TECHNICAL_REASON, retryInstruction: SENTINEL_RETRY_INSTRUCTION } : undefined;
      },
    });

    const outcome = await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);

    expect(outcome.status).toBe('created');
    expect(capturedUrl).toBeDefined();
    // The decisive check: the fetch, issued mid-poll, actually returned
    // real page content — not 0 bytes, not a connection failure. This is
    // the check that failed three times live.
    expect(fetchedWhileWaiting).toBeDefined();
    expect(fetchedWhileWaiting!.length).toBeGreaterThan(0);
    expect(fetchedWhileWaiting).toContain(SENTINEL_RETRY_INSTRUCTION);
    // Distinguishes "polls contents" from "re-reads the install it was
    // handed": confirmAppInstallation was called MORE THAN ONCE — a fresh
    // read on every tick, not a cached observation from the pre-flight.
    expect(confirmCalls.length).toBeGreaterThan(1);
  });

  // Decisive pair, item 2: a genuinely FIRST gate (fresh create) is
  // UNCHANGED — the full set is correct there, nothing is known satisfied.
  it('decisive (2): a first gate (fresh create, viaRecovery: false) -> unchanged full "select exactly" instruction', async () => {
    const logs: string[] = [];
    const deps = baseDeps({ log: (l) => logs.push(l) }); // no findRecoveryArtifact — the ordinary fresh-create path
    const outcome = await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);
    expect(outcome.status).toBe('created');
    expect(logs.join('\n')).toContain(FULL_SELECT_EXACTLY_LINE);
  });

  it('honest-unknown: recovered credential but ZERO installs (app-no-install) -> full set, same as a first gate — nothing is known satisfied', async () => {
    const logs: string[] = [];
    const deps = baseDeps({
      log: (l) => logs.push(l),
      confirmAppInstallation: async () => ({ status: 'app-no-install' }),
      findRecoveryArtifact: async () => RECOVERED,
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '7001', appSlug: RECOVERED.slug, accountLogin: 'groundnuty' }),
    });
    await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);
    expect(logs.join('\n')).toContain(FULL_SELECT_EXACTLY_LINE);
  });

  it('honest-unknown: current selection cannot be observed (unconfirmable) -> full set, NEVER a guessed delta', async () => {
    const logs: string[] = [];
    const deps = baseDeps({
      log: (l) => logs.push(l),
      confirmAppInstallation: async () => ({ status: 'unconfirmable' }),
      findRecoveryArtifact: async () => RECOVERED,
      waitForAppInstallation: async (opts) => ({ appId: opts.appId, installId: '7002', appSlug: RECOVERED.slug, accountLogin: 'groundnuty' }),
    });
    await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);
    expect(logs.join('\n')).toContain(FULL_SELECT_EXACTLY_LINE);
  });

  it('a bare-string rejection (e.g. a scope-only check, no single "missing repo" to name) falls back to its own message text on a resumed gate — still never the full-list restatement', async () => {
    const logs: string[] = [];
    const deps = baseDeps({
      log: (l) => logs.push(l),
      // groundnuty/macf#1178 — this fixture's validateInstall never
      // accepts, so pollForInstallFix runs to its OWN timeout; keep the
      // budget tiny so the test doesn't wait the real 10-minute default.
      gateTimeoutMs: 30,
      pollIntervalMs: 10,
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }) as IdentityConfirmation,
      findRecoveryArtifact: async () => RECOVERED,
      validateInstall: () => 'SENTINEL-BARE: repository_selection must be selected.',
    });
    await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);
    const joined = logs.join('\n');
    expect(joined).toContain('SENTINEL-BARE: repository_selection must be selected.');
    expect(joined).not.toContain(FULL_SELECT_EXACTLY_LINE);
  });

  // Real production shape, end-to-end: the ACTUAL registry-repo-coverage
  // rejection text (not a sentinel) still lands on a resumed gate, and the
  // check + the instruction still share ONE derivation (never re-derived —
  // groundnuty/macf#1156 must not be weakened by this fix).
  it('wired to the REAL registry-repo-coverage rejection text -> that exact text appears on the resumed gate, and the full-list line does not', async () => {
    const logs: string[] = [];
    const realRetryInstruction = registryRepoRetryInstruction('demo-fleet-code-agent', 'groundnuty', 'demo-fresh-control');
    const realMessage = registryRepoNotInstalledReason('demo-fleet-code-agent', 'groundnuty', 'demo-fresh-control');
    const deps = baseDeps({
      log: (l) => logs.push(l),
      gateTimeoutMs: 30,
      pollIntervalMs: 10,
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }) as IdentityConfirmation,
      findRecoveryArtifact: async () => RECOVERED,
      validateInstall: () => ({ message: realMessage, retryInstruction: realRetryInstruction }),
    });
    await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);
    const joined = logs.join('\n');
    expect(joined).toContain(realRetryInstruction);
    expect(joined).not.toContain(FULL_SELECT_EXACTLY_LINE);
  });

  // --- groundnuty/macf#1173 — the decisive cross-surface tests -----------
  //
  // Everything above proves the TERMINAL narrows on a resumed gate. It says
  // nothing about the served interstitial — and before #1173, the page had
  // ZERO delta-awareness: `renderInstallInterstitial` built its own text
  // straight from `repos`/`whyText`, ignoring whatever `instructionLines`
  // the terminal was given. That gap is the operator-witnessed incident
  // #1173 reports (terminal said "missing access to macf-fresh-control";
  // the page still listed the full original set).
  //
  // Per the issue's own testing mandate, these tests assert the two
  // surfaces against EACH OTHER — the terminal's `logs` array and the
  // interstitial's captured `opts.messageLines` / rendered HTML — never
  // against a second, independently-typed literal. Two literals can both
  // "look right" while drifting (that is exactly how this reached four
  // instances); comparing captured outputs to each other cannot.

  it('DECISIVE: on a resumed gate, every line the terminal prints for gate 2 is present, verbatim, in the served interstitial — asserted against each other, never against a literal', async () => {
    const logs: string[] = [];
    let seenOpts: InstallInterstitialOptions | undefined;
    const deps = baseDeps({
      log: (l) => logs.push(l),
      // groundnuty/macf#1178 — the page now ALWAYS opens for a resumed,
      // confirmed-but-insufficient install (never gated on
      // allowInstallRetry). This fixture's validateInstall never accepts,
      // so pollForInstallFix runs to its own timeout — kept tiny so this
      // cross-surface test doesn't wait the real 10-minute default.
      gateTimeoutMs: 30,
      pollIntervalMs: 10,
      startInstallInterstitial: async (opts) => {
        seenOpts = opts;
        return fakeInterstitialHandles();
      },
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }) as IdentityConfirmation,
      findRecoveryArtifact: async () => RECOVERED,
      validateInstall: () => ({ message: SENTINEL_TECHNICAL_REASON, retryInstruction: SENTINEL_RETRY_INSTRUCTION }),
    });

    await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);

    expect(seenOpts).toBeDefined();
    const messageLines = seenOpts!.messageLines;
    expect(messageLines.length).toBeGreaterThan(0);

    // Surface 1 (terminal): every messageLines entry was actually logged,
    // in the SAME `Role "<role>": <line>` form `announceAndOpenGate` uses.
    for (const line of messageLines) {
      expect(logs).toContain(`Role "code-agent": ${line}`);
    }

    // Surface 2 (browser): render the ACTUAL captured opts (not a re-typed
    // fixture) and confirm the verbatim-instruction block is exactly one
    // escaped, role-prefixed messageLines entry per line, in order —
    // nothing the page adds, nothing it drops (groundnuty/macf#1176
    // supersedes the pre-#1176 `<li>`-per-line shape).
    const html = renderInstallInterstitial(seenOpts!);
    const items = extractPreBlock(html, 'The instruction, as printed');
    expect(items).toEqual(messageLines.map((line) => `Role "code-agent": ${escapeHtmlAttribute(line)}`));

    // And it IS the resumed-gate delta (groundnuty/macf#1160's own fix,
    // reached here via the retry-reopen's `gate2RetryInstructionLines`),
    // now proven present on BOTH surfaces — not the stale full-list
    // restatement #1173 reports the page as showing.
    expect(messageLines).toContain(SENTINEL_RETRY_INSTRUCTION);
    expect(messageLines.join('\n')).not.toContain(FULL_SELECT_EXACTLY_LINE);
  });

  it('DECISIVE: on a FIRST (non-resumed) gate, the terminal and the served interstitial ALSO agree — both show the full "select exactly" set', async () => {
    const logs: string[] = [];
    let seenOpts: InstallInterstitialOptions | undefined;
    const deps = baseDeps({
      log: (l) => logs.push(l),
      startInstallInterstitial: async (opts) => {
        seenOpts = opts;
        return fakeInterstitialHandles();
      },
    }); // no findRecoveryArtifact — the ordinary fresh-create path

    const outcome = await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);
    expect(outcome.status).toBe('created');

    expect(seenOpts).toBeDefined();
    const messageLines = seenOpts!.messageLines;
    for (const line of messageLines) {
      expect(logs).toContain(`Role "code-agent": ${line}`);
    }
    const html = renderInstallInterstitial(seenOpts!);
    const items = extractPreBlock(html, 'The instruction, as printed');
    expect(items).toEqual(messageLines.map((line) => `Role "code-agent": ${escapeHtmlAttribute(line)}`));
    expect(messageLines.join('\n')).toContain(FULL_SELECT_EXACTLY_LINE);
  });

  it('groundnuty/macf#1173 — HTML escaping survives the shared-source refactor: a messageLines entry with `<`/`&`/`"` renders raw in the terminal but escaped (inert) on the served page', async () => {
    const logs: string[] = [];
    let seenOpts: InstallInterstitialOptions | undefined;
    const DANGEROUS_RETRY_INSTRUCTION = 'add "groundnuty/<script>evil()</script>" & retry';
    const deps = baseDeps({
      log: (l) => logs.push(l),
      // groundnuty/macf#1178 — see the cross-surface agreement test above:
      // the page always opens now; this fixture's validateInstall never
      // accepts, so keep the poll budget tiny.
      gateTimeoutMs: 30,
      pollIntervalMs: 10,
      startInstallInterstitial: async (opts) => {
        seenOpts = opts;
        return fakeInterstitialHandles();
      },
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }) as IdentityConfirmation,
      findRecoveryArtifact: async () => RECOVERED,
      validateInstall: () => ({ message: 'technical detail, terminal/--json only', retryInstruction: DANGEROUS_RETRY_INSTRUCTION }),
    });

    await applyAgentIdentity(AGENT_TWO_REPOS, MANIFEST_TWO_REPOS, undefined, deps);

    // The terminal is a human-read log — raw text, no escaping needed.
    expect(logs.join('\n')).toContain(DANGEROUS_RETRY_INSTRUCTION);
    // The served page is HTML — the SAME text must never appear un-escaped,
    // proving the shared-source refactor did not drop the boundary escape.
    expect(seenOpts).toBeDefined();
    const html = renderInstallInterstitial(seenOpts!);
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain(escapeHtmlAttribute(DANGEROUS_RETRY_INSTRUCTION));
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

// groundnuty/macf#1156 — a repo-scoped registry, module-scoped so both the
// `installReposForIdentity` and `installWhyText` describe blocks below (and
// any future sibling) share the identical fixture rather than each hand-
// typing their own `owner`/`repo` literals.
const REGISTRY_REPO_MANIFEST: FleetManifest = {
  ...MULTI_AGENT_MANIFEST,
  owner: { account: 'demo-org', type: 'org', registry: { type: 'repo', owner: 'demo-org', repo: 'demo-org-control' } },
};

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

  // groundnuty/macf#1156 — the control-repo fold-in this issue adds.
  describe('groundnuty/macf#1156 — registry.type === "repo" folds the control repo in', () => {
    it('a role matching a declared agent gets its own repo PLUS the control repo', () => {
      expect(installReposForIdentity('code-agent', REGISTRY_REPO_MANIFEST)).toEqual([
        'groundnuty/demo-code',
        'demo-org/demo-org-control',
      ]);
      expect(installReposForIdentity('science-agent', REGISTRY_REPO_MANIFEST)).toEqual([
        'groundnuty/demo-science',
        'demo-org/demo-org-control',
      ]);
    });

    it('the runner-ops fallback (no declared-agent match) is UNCHANGED — every agent repo, control repo NOT added (it never touches the registry)', () => {
      expect(installReposForIdentity('runner-ops', REGISTRY_REPO_MANIFEST)).toEqual([
        'groundnuty/demo-code',
        'groundnuty/demo-science',
      ]);
    });

    it('a non-repo-scoped registry (profile scope) gets the agent repo ONLY — no spurious control-repo entry', () => {
      // MULTI_AGENT_MANIFEST inherits MANIFEST's default `registry: { type: 'profile', ... }`.
      expect(installReposForIdentity('code-agent', MULTI_AGENT_MANIFEST)).toEqual(['groundnuty/demo-code']);
    });

    it('a role whose OWN home repo IS the control repo gets it listed once, not twice', () => {
      const selfHostingManifest: FleetManifest = {
        ...MULTI_AGENT_MANIFEST,
        owner: { account: 'demo-org', type: 'org', registry: { type: 'repo', owner: 'groundnuty', repo: 'demo-code' } },
      };
      expect(installReposForIdentity('code-agent', selfHostingManifest)).toEqual(['groundnuty/demo-code']);
    });
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

  // groundnuty/macf#1156 — the one-clause registry-control-repo reason.
  it('registryControlRepo, when given, appends a one-clause reason naming it — "an operator who understands why will not mis-fix it later"', () => {
    const text = installWhyText(undefined, 'demo-org/demo-org-control');
    expect(text).toMatch(/only needs access to the repo\(s\) listed above/); // base reason still present
    expect(text).toContain('demo-org/demo-org-control');
    expect(text).toMatch(/this App must read the fleet registry/);
  });

  it('registryControlRepo omitted (every pre-#1156 call site) leaves the text byte-identical to before this parameter existed', () => {
    expect(installWhyText(undefined)).not.toMatch(/fleet registry/);
    expect(installWhyText({ administration: 'write' })).not.toMatch(/fleet registry/);
  });
});

// groundnuty/macf#1173 — `InstallInterstitialOptions` no longer carries
// separate `repos`/`whyText` fields; `messageLines` is the ONE canonical
// instruction body (the SAME array the terminal prints — see the decisive
// cross-surface tests below). These tests now assert the derived repos/
// why-text landed INSIDE that shared array, not on their own fields.
describe('gate 2 receives the derived repos/whyText, folded into messageLines (integration, groundnuty/macf#952 + #1173)', () => {
  it('create path: startInstallInterstitial is called with the role, the real exchanged slug, and messageLines carrying the derived repos + why-text', async () => {
    const seen: { role: string; appName: string; messageLines: readonly string[]; gateNumber: number; gateTotal: number }[] = [];
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
      gateNumber: 2,
      gateTotal: 2,
    });
    const joined = seen[0]?.messageLines.join('\n') ?? '';
    expect(joined).toContain('groundnuty/demo-code');
    expect(joined).toMatch(/only needs access to the repo\(s\) listed above/);
  });

  it('resume-install path: startInstallInterstitial ALSO gets messageLines carrying the derived repos', async () => {
    const seen: { role: string; messageLines: readonly string[] }[] = [];
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
    expect(seen[0]?.messageLines.join('\n')).toContain('groundnuty/demo-code');
  });

  it('a role with no matching agent (runner-ops shape) gets every declared repo + the admin-write why-text, folded into messageLines', async () => {
    const seen: { role: string; messageLines: readonly string[] }[] = [];
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
    const joined = seen[0]?.messageLines.join('\n') ?? '';
    expect(joined).toContain('groundnuty/demo-code');
    expect(joined).toContain('groundnuty/demo-science');
    expect(joined).toMatch(/blast radius/);
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

// --- groundnuty/macf#1179 — the ANNOUNCE line precedes the instructions,
// which precede the page opening — asserted in EMITTED ORDER, not merely
// "both present somewhere". The operator's own model: (1) announce a window
// will open, (2) print the instructions, (3) the browser shows them too,
// (4) state waiting and block. A test that only checked the announce
// sentence EXISTS would pass even if it were logged after the instructions
// or after the browser already opened — exactly the ordering bug #952/#971
// already fixed once for the instructions-vs-open pair; this pins the THIRD
// event into the same chain.

describe('announce-before-instructions-before-open ordering (the decisive test, groundnuty/macf#1179)', () => {
  it('gate 1: the announce line ("a window will open") is logged BEFORE any instruction line, which is logged BEFORE openUrl', async () => {
    const events: string[] = [];
    const deps = baseDeps({
      log: (line: string) => { events.push(`log:${line}`); },
      openUrl: async (url: string) => { events.push(`open:${url}`); },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    const announceIndex = events.findIndex((e) => e.startsWith('log:') && /window will open/i.test(e));
    const firstInstructionIndex = events.findIndex((e) => e.startsWith('log:') && /creating GitHub App/i.test(e));
    const openIndex = events.findIndex((e) => e === 'open:http://127.0.0.1:9/');

    expect(announceIndex).toBeGreaterThanOrEqual(0);
    expect(firstInstructionIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(announceIndex).toBeLessThan(firstInstructionIndex);
    expect(firstInstructionIndex).toBeLessThan(openIndex);
  });

  it('gate 2: the announce line ALSO precedes the "Only select repositories" instruction, which precedes openUrl(interstitial.startUrl)', async () => {
    const events: string[] = [];
    const deps = baseDeps({
      log: (line: string) => { events.push(`log:${line}`); },
      openUrl: async (url: string) => { events.push(`open:${url}`); },
      startInstallInterstitial: async () => fakeInterstitialHandles(),
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    const instructionIndex = events.findIndex((e) => e.startsWith('log:') && e.includes('Only select repositories'));
    const gate2OpenIndex = events.findIndex((e) => e === `open:${FAKE_INTERSTITIAL_URL}`);

    // At least one announce line exists before gate 2's open — narrow to the
    // LAST announce line before that open (gate 1's own announce fired
    // earlier in the same run; this asserts gate 2's, not gate 1's).
    const announceIndicesBeforeOpen = events
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => e.startsWith('log:') && /window will open/i.test(e) && i < gate2OpenIndex);
    expect(announceIndicesBeforeOpen.length).toBeGreaterThan(0);
    const lastAnnounceBeforeGate2Open = announceIndicesBeforeOpen[announceIndicesBeforeOpen.length - 1]!.i;

    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(gate2OpenIndex).toBeGreaterThanOrEqual(0);
    expect(lastAnnounceBeforeGate2Open).toBeLessThan(instructionIndex);
    expect(instructionIndex).toBeLessThan(gate2OpenIndex);
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

  // groundnuty/macf#1176 — the retry-reopen's copyable repo block narrows
  // to the SPECIFIC repo the rejecting hook found missing (`missingRepos`),
  // never the full required set — mirroring `messageLines`' own
  // `retryInstruction` narrowing, structurally instead of by parsing prose.
  it('groundnuty/macf#1176: the reopened page narrows the copyable repo block to missingRepos, not the full required set', async () => {
    let seenOpts: InstallInterstitialOptions | undefined;
    let validateReuseCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial: async (opts) => {
        // Only capture the REOPEN's opts — the reopen is the second call.
        if (validateReuseCalls >= 1) seenOpts = opts;
        return fakeInterstitialHandles();
      },
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      waitForAppInstallation: async () => REUSE_INSTALL,
      allowInstallRetry: true,
      waitForOperatorFix: async () => {},
      validateReuse: async () => {
        validateReuseCalls += 1;
        return validateReuseCalls === 1
          ? { message: MISSING_REPO_REASON, retryInstruction: 'add it, then Save', missingRepos: ['groundnuty/demo-fleet-control'] }
          : undefined;
      },
    });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(seenOpts).toBeDefined();
    // Bare name — the picker's own format (`apply-agent.ts::bareRepoName`).
    expect(seenOpts!.repoNames).toEqual(['demo-fleet-control']);
  });

  it('groundnuty/macf#1176: WITHOUT a structured missingRepos on the rejection, the reopened page falls back to the full required set — never omits the block', async () => {
    let seenOpts: InstallInterstitialOptions | undefined;
    let validateInstallCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial: async (opts) => {
        if (validateInstallCalls >= 1) seenOpts = opts;
        return fakeInterstitialHandles();
      },
      allowInstallRetry: true,
      waitForOperatorFix: async () => {},
      waitForAppInstallation: async () => ({ appId: CREDS.appId, installId: '5555', appSlug: CREDS.slug, accountLogin: 'groundnuty' }),
      validateInstall: async () => {
        validateInstallCalls += 1;
        // A bare-string rejection — no missingRepos (e.g. apply-runner-ops.ts's shape).
        return validateInstallCalls === 1 ? MISSING_REPO_REASON : undefined;
      },
    });
    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(seenOpts).toBeDefined();
    // Falls back to the identity's own full required set (AGENT's one repo).
    expect(seenOpts!.repoNames).toEqual(['demo-code']);
  });

  // groundnuty/macf#1178 — reverses the old #1063 "reopen N times, bounded
  // by attempt-count" shape for this branch. A never-fixed rejection now
  // exhausts a single continuous poll's TIME budget instead — bounded via
  // gateTimeoutMs in this test (never the real 10-minute default).
  it('groundnuty/macf#1178 — a never-fixed reuse rejection terminates on the poll TIMEOUT, not an attempt count; the page opens exactly once', async () => {
    let validateReuseCalls = 0;
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const deps = baseDeps({
      startInstallInterstitial,
      gateTimeoutMs: 30,
      pollIntervalMs: 10,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      validateReuse: async () => {
        validateReuseCalls += 1;
        return MISSING_REPO_REASON; // NEVER fixed — the operator never gets it right
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    // Multiple ticks happened (a REAL poll, not a single check) — the exact
    // count depends on timer precision, so this asserts "more than one,"
    // not a pinned literal.
    expect(validateReuseCalls).toBeGreaterThanOrEqual(2);
    expect(startInstallInterstitial).toHaveBeenCalledTimes(1); // ONE continuous poll — no reopen loop
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain(MISSING_REPO_REASON);
      expect(outcome.reason).toMatch(/polled for \d+ms|polled for \d+s/);
    }
  });

  // groundnuty/macf#1178 — the operator's own ruling reverses this test's
  // pre-#1178 name ("--yes / unattended never re-opens the gate"): the page
  // now ALWAYS opens, `allowInstallRetry` given or not, because opening it
  // costs nothing manual (auto-poll, never a manual press-Enter wait).
  it('groundnuty/macf#1178 — unattended (allowInstallRetry omitted) STILL auto-opens the page and polls, never a menu-walk refusal', async () => {
    let validateReuseCalls = 0;
    const startInstallInterstitial = vi.fn(async () => fakeInterstitialHandles());
    const openUrl = vi.fn(async () => {});
    const deps = baseDeps({
      startInstallInterstitial,
      openUrl,
      gateTimeoutMs: 200,
      pollIntervalMs: 10,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      // allowInstallRetry deliberately OMITTED — bootstrap-apply.ts's real
      // `--yes` wiring (`assumeYes !== true` -> false). No longer changes
      // whether the page opens (see #1178) — only the OLD manual-retry
      // loop (now removed for this branch) depended on it.
      validateReuse: async () => {
        validateReuseCalls += 1;
        return validateReuseCalls === 1 ? MISSING_REPO_REASON : undefined;
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(validateReuseCalls).toBe(2); // the pre-flight check, then the poll's first tick — both live
    expect(startInstallInterstitial).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ role: 'code-agent', status: 'reused', appId: '9001', installId: '5555' });
  });

  // groundnuty/macf#1178 — the operator's own words: "do not expect me to
  // click anything manually." The poll re-checks automatically, on its own
  // interval — no `waitForOperatorFix`/press-Enter primitive is invoked
  // for this branch anymore.
  it('groundnuty/macf#1178 — the poll re-checks automatically; no manual "press Enter" wait is invoked', async () => {
    const waitForOperatorFix = vi.fn(async () => {});
    let validateReuseCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial: async () => fakeInterstitialHandles(),
      gateTimeoutMs: 200,
      pollIntervalMs: 10,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      allowInstallRetry: true, // even opted-in, this hook must never fire for this branch now
      waitForOperatorFix,
      validateReuse: async () => {
        validateReuseCalls += 1;
        return validateReuseCalls <= 2 ? MISSING_REPO_REASON : undefined;
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(validateReuseCalls).toBe(3);
    expect(waitForOperatorFix).not.toHaveBeenCalled();
    expect(outcome.status).toBe('reused');
  });

  it('the resumed-gate dialogue shows the CLEAN retryInstruction, never the technical message (its GET/HTTP/issue-number detail), on the terminal lines it owns', async () => {
    const logs: string[] = [];
    let validateReuseCalls = 0;
    const cleanInstruction = registryRepoRetryInstruction('demo-fleet-code-agent', 'groundnuty', 'demo-fleet-control');
    const deps = baseDeps({
      startInstallInterstitial: async () => fakeInterstitialHandles(),
      log: (l) => logs.push(l),
      gateTimeoutMs: 200,
      pollIntervalMs: 10,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      validateReuse: async () => {
        validateReuseCalls += 1;
        if (validateReuseCalls === 1) return { message: MISSING_REPO_REASON, retryInstruction: cleanInstruction };
        return undefined;
      },
    });
    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    // The clean sentence IS shown, as its own printed line (the resumed
    // gate's instructionLines are logged one-per-line).
    expect(logs).toContain(`Role "code-agent": ${cleanInstruction}`);
    // The technical `message` (its GET/HTTP-status/issue-number detail)
    // reaches the ONE pre-existing diagnostic line ("REFUSED on reuse — …")
    // — but the resumed-gate dialogue's OWN lines (from the "install
    // already exists from an earlier run" framing sentence onward) must
    // never repeat it.
    const dialogueIndex = logs.findIndex((l) => l.includes("install already exists from an earlier run"));
    expect(dialogueIndex).toBeGreaterThanOrEqual(0);
    const dialogueLines = logs.slice(dialogueIndex);
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

  it('no internal issue/PR references leak into any of the NEW #1178 text (the resumed-gate dialogue + the poll-timeout explanation) — comments may cite them freely, output may not', async () => {
    // A rejection reason with NO issue references of its own (unlike the
    // real `registryRepoNotInstalledReason`, which — pre-existing, #1012's
    // own shipped text — cites `groundnuty/macf#999`/`#1012` by design; that
    // choice belongs to #1012, not this issue, so re-litigating it here
    // would test the wrong code). Isolating the reason this way means every
    // reference this assertion could catch is one #1178 itself introduced.
    const NO_REF_REASON = 'App is installed, but its install does not cover the required repository.';
    const logs: string[] = [];
    let validateReuseCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial: async () => fakeInterstitialHandles(),
      log: (l) => logs.push(l),
      gateTimeoutMs: 30,
      pollIntervalMs: 10,
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      validateReuse: async () => {
        validateReuseCalls += 1;
        return NO_REF_REASON; // never fixed -> the poll exhausts its timeout -> the "gave up" text also gets checked
      },
    });
    const outcome = await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    expect(validateReuseCalls).toBeGreaterThanOrEqual(2); // sanity: the poll actually ran more than once
    const issueRefPattern = /#\d+|DR-\d+/i;
    expect(logs.join('\n')).not.toMatch(issueRefPattern);
    if (outcome.status === 'failed') expect(outcome.reason).not.toMatch(issueRefPattern);
  });
});

// --- groundnuty/macf#1179 — "check again" wakes the resumed-gate poll ------
//
// `pollForInstallFix`'s ordinary tick cadence is a TIMER (15s default,
// `pollIntervalMs` here). These tests set that timer to something the test's
// own timeout could never survive (10 minutes) — if "check again" were NOT
// wired to interrupt the sleep, the run would still be waiting on the timer
// when the test itself times out, and the assertion below would never even
// run. That is the negative trigger: it is not "the run eventually succeeds"
// (true even without this feature, given enough wall-clock time) but "the
// run succeeds FAST, inside a budget that only makes sense if the click
// short-circuited the wait."

describe('"check again" continues the SAME invocation (groundnuty/macf#1179)', () => {
  const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };
  const REUSE_INSTALL: ConfirmedInstall = { appId: '9001', installId: '5555', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty', repositorySelection: 'selected' };
  const MISSING_REPO_REASON = registryRepoNotInstalledReason('demo-fleet-code-agent', 'groundnuty', 'demo-fleet-control');
  const TEN_MINUTES_MS = 10 * 60 * 1000;

  it('DECISIVE: a click resolves waitForCheckAgain(), the poll re-checks immediately, validate now accepts, and applyAgentIdentity resolves — all inside one invocation, well under the 10-minute poll interval', async () => {
    let checkAgainResolve: (() => void) | undefined;
    const checkAgainPromise = new Promise<void>((res) => { checkAgainResolve = res; });
    let validateReuseCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial: async () => ({
        startUrl: FAKE_INTERSTITIAL_URL,
        close: () => Promise.resolve(),
        waitForCheckAgain: () => checkAgainPromise,
        updateContent: () => {},
      }),
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      gateTimeoutMs: TEN_MINUTES_MS,
      pollIntervalMs: TEN_MINUTES_MS,
      validateReuse: async () => {
        validateReuseCalls += 1;
        return validateReuseCalls === 1 ? MISSING_REPO_REASON : undefined;
      },
    });

    const outcomePromise = applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    // Give the poll's FIRST (immediate) tick a moment to run and observe the
    // rejection, then simulate the operator's click.
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    checkAgainResolve?.();

    const outcome = await outcomePromise;
    expect(validateReuseCalls).toBe(2); // the pre-flight check, then the check-again-triggered re-check
    expect(outcome).toEqual({ role: 'code-agent', status: 'reused', appId: '9001', installId: '5555' });
  }, 5000);

  it('NEGATIVE — with the SAME 10-minute interval and NO click ever arriving, the run is still in flight after a short window (proves the fast path above is not just "polling is fast anyway")', async () => {
    const deps = baseDeps({
      startInstallInterstitial: async () => fakeInterstitialHandles(), // waitForCheckAgain omitted -> never fires
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      gateTimeoutMs: TEN_MINUTES_MS,
      pollIntervalMs: TEN_MINUTES_MS,
      validateReuse: async () => MISSING_REPO_REASON, // never fixed
    });

    const outcomePromise = applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);
    const stillPending = Symbol('still-pending');
    const race = await Promise.race([
      outcomePromise,
      new Promise((resolve) => { setTimeout(() => resolve(stillPending), 100); }),
    ]);
    expect(race).toBe(stillPending);
  });
});

// --- groundnuty/macf#1179 — "cancel this identity" ends ONE gate-2 wait ----

describe('"cancel this identity" (groundnuty/macf#1179)', () => {
  it('DECISIVE: cancel ends the wait immediately with a cancel-specific reason — never the "orphaned App, finish manually" wording a genuine failure gets', async () => {
    const deps = baseDeps({
      startInstallInterstitial: async () => ({
        startUrl: FAKE_INTERSTITIAL_URL,
        close: () => Promise.resolve(),
        waitForCancel: () => Promise.resolve(), // "already clicked" by the time the wait starts
      }),
      // Never resolves on its own — ONLY the cancel race can end this wait.
      waitForAppInstallation: () => new Promise(() => { /* hangs forever */ }),
    });

    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('cancelled by the operator');
      expect(outcome.reason).not.toContain('orphaned');
      expect(outcome.reason).not.toContain('finish the install manually');
    }
  }, 5000);

  it('NEGATIVE — a genuine gate-2 failure (cancel never fires) gets the "App WAS created... finish manually" framing, and NEVER the cancel wording — the two failure shapes stay textually distinguishable', async () => {
    const deps = baseDeps({
      startInstallInterstitial: async () => fakeInterstitialHandles(), // waitForCancel omitted -> never fires
      waitForAppInstallation: async () => { throw new Error('simulated poll failure — not a cancel'); },
    });

    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).not.toContain('cancelled by the operator');
      expect(outcome.reason).toContain('the App WAS created on GitHub');
    }
  });

  it('a cancel is never treated as `recoverable` — #1063\'s reopen loop must not retry a deliberate cancel even when allowInstallRetry is set', async () => {
    const startInstallInterstitial = vi.fn(async () => ({
      startUrl: FAKE_INTERSTITIAL_URL,
      close: () => Promise.resolve(),
      waitForCancel: () => Promise.resolve(),
    }));
    const deps = baseDeps({
      startInstallInterstitial,
      allowInstallRetry: true,
      waitForOperatorFix: async () => {},
      waitForAppInstallation: () => new Promise(() => { /* hangs forever */ }),
    });

    const outcome = await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);
    expect(outcome.status).toBe('failed');
    // Exactly ONE page open — a reopen would mean the cancel was mistaken
    // for a recoverable rejection and re-tried.
    expect(startInstallInterstitial).toHaveBeenCalledTimes(1);
  }, 5000);
});

// --- groundnuty/macf#1179 — #1174's "one message source" extended to the
// new page buttons: the terminal's mention of them must use the EXACT same
// two label strings the page's own buttons render — imported from
// `manifest-flow-server.ts` on both sides of this assertion, never
// independently re-typed on either.

describe('the new page buttons are also covered by #1174\'s one-message-source discipline (groundnuty/macf#1179)', () => {
  it('DECISIVE: the terminal line naming the two buttons uses CHECK_AGAIN_LABEL/CANCEL_LABEL verbatim — the SAME constants the served page renders its buttons with', async () => {
    const logs: string[] = [];
    let seenOpts: InstallInterstitialOptions | undefined;
    const deps = baseDeps({
      log: (l) => logs.push(l),
      startInstallInterstitial: async (opts) => {
        seenOpts = opts;
        return fakeInterstitialHandles();
      },
    });

    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    // Surface 1 (terminal): the mention line exists and carries BOTH labels
    // verbatim — not a paraphrase ("you can also cancel", "click check
    // again again to re-check") that could drift from the page's own text.
    const mentionLine = logs.find((l) => l.includes(CHECK_AGAIN_LABEL) && l.includes(CANCEL_LABEL));
    expect(mentionLine).toBeDefined();

    // Surface 2 (browser): render the ACTUAL captured opts and confirm the
    // page's own buttons carry the SAME two strings.
    expect(seenOpts).toBeDefined();
    const html = renderInstallInterstitial(seenOpts!);
    expect(html).toContain(CHECK_AGAIN_LABEL);
    expect(html).toContain(CANCEL_LABEL);
  });

  it('NEGATIVE — when NO real local page exists (the bind-failure fallback to GitHub\'s install URL directly), the terminal never mentions the buttons — they don\'t exist there', async () => {
    const logs: string[] = [];
    const deps = baseDeps({
      log: (l) => logs.push(l),
      startInstallInterstitial: async () => { throw new Error('EADDRINUSE'); },
    });

    await applyAgentIdentity(AGENT, MANIFEST, undefined, deps);

    const mentionLine = logs.find((l) => l.includes(CHECK_AGAIN_LABEL) || l.includes(CANCEL_LABEL));
    expect(mentionLine).toBeUndefined();
  });
});

// --- groundnuty/macf#1179 — pollForInstallFix actually calls updateContent
// with the CLASSIFIED diagnosis, not just any narrowed text. gate2-diagnosis
// .test.ts already proves the classifier itself is correct in isolation;
// this proves the poll loop actually WIRES it, end to end.

describe('pollForInstallFix narrows the served page via the classifier (groundnuty/macf#1179)', () => {
  it('a coverage-short rejection (scope selected, missingRepos present) narrows updateContent to the classified coverage-short lines, not the scope-wrong ones', async () => {
    const PRIOR: FleetLockAgent = { role: 'code-agent', app_id: '9001', install_id: '5555' };
    const REUSE_INSTALL: ConfirmedInstall = { appId: '9001', installId: '5555', appSlug: 'demo-fleet-code-agent', accountLogin: 'groundnuty', repositorySelection: 'selected' };
    const updateCalls: { readonly messageLines: readonly string[]; readonly repoNames: readonly string[] }[] = [];
    let validateReuseCalls = 0;
    const deps = baseDeps({
      startInstallInterstitial: async () => ({
        startUrl: FAKE_INTERSTITIAL_URL,
        close: () => Promise.resolve(),
        updateContent: (messageLines, repoNames) => { updateCalls.push({ messageLines, repoNames }); },
      }),
      resolveKeyPath: () => '/fake/key.pem',
      confirmAppInstallation: async () => ({ status: 'confirmed', install: REUSE_INSTALL }),
      gateTimeoutMs: 200,
      pollIntervalMs: 10,
      validateReuse: async () => {
        validateReuseCalls += 1;
        // Rejects on call 1 (the pre-flight, OUTSIDE pollForInstallFix —
        // decides whether gate 2 opens at all) AND call 2 (the poll's own
        // FIRST tick, INSIDE pollForInstallFix — this is the one that must
        // reach `updateContent`); accepts on call 3, so the poll's SECOND
        // tick is what resolves the run.
        return validateReuseCalls <= 2
          ? { message: 'registry repo not installed', retryInstruction: 'add groundnuty/demo-fresh-control under Repository access, then Save.', missingRepos: ['groundnuty/demo-fresh-control'] }
          : undefined;
      },
    });

    await applyAgentIdentity(AGENT, MANIFEST, PRIOR, deps);

    expect(updateCalls.length).toBeGreaterThan(0);
    const first = updateCalls[0]!;
    // Classified as coverage-short (not scope-wrong, not honest-unknown):
    // the "still missing repository access:" prefix and the repo name.
    expect(first.messageLines.join('\n')).toContain('still missing repository access:');
    expect(first.messageLines.join('\n')).not.toContain('still wrong (repository scope)');
    expect(first.repoNames).toEqual(['demo-fresh-control']); // bare name, per bareRepoNames
  });
});

// --- openInstallScopeCoverageGate (groundnuty/macf#1220 — the ACT half) ---

describe('openInstallScopeCoverageGate — reopens gate 2 for a FLEET-LEVEL App widening its install (groundnuty/macf#1220)', () => {
  const CONFIRMED_INSTALL: ConfirmedInstall = { appId: '9001', installId: '5555', appSlug: 'trial-runner-ops', accountLogin: 'macf-experiment' };

  /** `Omit<AgentApplyDeps, 'writeRecoveryArtifact'>` — mirrors `MutateApplyDeps.buildAgentDeps`'s own return shape, which is what this function's real caller (`bootstrap-apply.ts`) actually hands it. */
  function gateDeps(overrides: Partial<AgentApplyDeps> = {}): Omit<AgentApplyDeps, 'writeRecoveryArtifact'> {
    const { writeRecoveryArtifact: _drop, ...base } = baseDeps(overrides);
    return base;
  }

  it('opens the SAME interstitial gate 2 uses: instructionLines === [opts.message] (single message source, never a second authored text) and repoNames are the BARED missingRepos', async () => {
    const seen: { messageLines: readonly string[]; repoNames: readonly string[] }[] = [];
    const deps = gateDeps({
      startInstallInterstitial: async (o: InstallInterstitialOptions) => {
        seen.push({ messageLines: o.messageLines, repoNames: o.repoNames });
        return fakeInterstitialHandles();
      },
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }),
      gateTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    const outcome = await openInstallScopeCoverageGate({
      role: 'runner-ops',
      appId: '9001',
      keyPath: '/tmp/key.pem',
      appSlug: 'trial-runner-ops',
      accountLogin: 'macf-experiment',
      message: 'App "trial-runner-ops" is missing repository access to macf-experiment/trial-writing-agent — add exactly this repo under "Repository access" on the App\'s install page (never "All repositories"), then click "Save."',
      missingRepos: ['macf-experiment/trial-writing-agent'],
      recheck: async () => ({ covered: true, missingRepos: [], message: '' }),
      deps,
    });

    expect(outcome.status).toBe('covered');
    expect(seen[0]?.messageLines).toEqual([
      'App "trial-runner-ops" is missing repository access to macf-experiment/trial-writing-agent — add exactly this repo under "Repository access" on the App\'s install page (never "All repositories"), then click "Save."',
    ]);
    expect(seen[0]?.repoNames).toEqual(['trial-writing-agent']); // bared, per bareRepoNames
  });

  it('ONE gate per App even when several repos are missing — the whole missing set is named in one opening, never one per repo', async () => {
    const seen: { repoNames: readonly string[] }[] = [];
    const deps = gateDeps({
      startInstallInterstitial: async (o: InstallInterstitialOptions) => {
        seen.push({ repoNames: o.repoNames });
        return fakeInterstitialHandles();
      },
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }),
      gateTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    await openInstallScopeCoverageGate({
      role: 'runner-ops',
      appId: '9001',
      keyPath: '/tmp/key.pem',
      appSlug: 'trial-runner-ops',
      accountLogin: 'macf-experiment',
      message: 'two repos missing',
      missingRepos: ['macf-experiment/trial-writing-agent', 'macf-experiment/trial-science-agent'],
      recheck: async () => ({ covered: true, missingRepos: [], message: '' }),
      deps,
    });

    expect(seen).toHaveLength(1); // ONE interstitial open, not two
    expect(seen[0]?.repoNames).toEqual(['trial-writing-agent', 'trial-science-agent']);
  });

  it('really waits: a recheck rejecting on tick 1 and accepting on tick 2 only resolves covered AFTER the second poll actually runs', async () => {
    let ticks = 0;
    const deps = gateDeps({
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }),
      gateTimeoutMs: 5_000,
      pollIntervalMs: 5,
    });

    const outcome = await openInstallScopeCoverageGate({
      role: 'runner-ops',
      appId: '9001',
      keyPath: '/tmp/key.pem',
      appSlug: 'trial-runner-ops',
      accountLogin: 'macf-experiment',
      message: 'still missing',
      missingRepos: ['macf-experiment/trial-writing-agent'],
      recheck: async () => {
        ticks += 1;
        return ticks < 2
          ? { covered: false, missingRepos: ['macf-experiment/trial-writing-agent'], message: 'still missing' }
          : { covered: true, missingRepos: [], message: '' };
      },
      deps,
    });

    expect(outcome.status).toBe('covered');
    expect(ticks).toBeGreaterThanOrEqual(2); // proves it actually polled again, never resolved on the first check
  });

  it('a recheck that never covers times out to drift, never hangs past gateTimeoutMs', async () => {
    const deps = gateDeps({
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }),
      gateTimeoutMs: 20,
      pollIntervalMs: 5,
    });

    const outcome = await openInstallScopeCoverageGate({
      role: 'runner-ops',
      appId: '9001',
      keyPath: '/tmp/key.pem',
      appSlug: 'trial-runner-ops',
      accountLogin: 'macf-experiment',
      message: 'still missing',
      missingRepos: ['macf-experiment/trial-writing-agent'],
      recheck: async () => ({ covered: false, missingRepos: ['macf-experiment/trial-writing-agent'], message: 'still missing' }),
      deps,
    });

    expect(outcome.status).toBe('drift');
    expect(outcome.status === 'drift' ? outcome.reason : '').toContain('polled for');
  });

  it('expected identity carries accountLogin ONLY, never the predicted appSlug — a wrong prediction must not make the gate structurally unable to resolve', async () => {
    let seenExpected: unknown;
    const deps = gateDeps({
      confirmAppInstallation: async (_appId: string, _keyPath: string, expected?: unknown) => {
        seenExpected = expected;
        return { status: 'confirmed', install: CONFIRMED_INSTALL };
      },
      gateTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    await openInstallScopeCoverageGate({
      role: 'runner-ops',
      appId: '9001',
      keyPath: '/tmp/key.pem',
      appSlug: 'a-predicted-handle-that-may-not-be-the-real-slug',
      accountLogin: 'macf-experiment',
      message: 'x',
      missingRepos: ['macf-experiment/trial-writing-agent'],
      recheck: async () => ({ covered: true, missingRepos: [], message: '' }),
      deps,
    });

    expect(seenExpected).toEqual({ accountLogin: 'macf-experiment' });
  });

  it('waitLabel is "Save" (adding to an existing install), never "Install" — this App already exists', async () => {
    const logs: string[] = [];
    const deps = gateDeps({
      confirmAppInstallation: async () => ({ status: 'confirmed', install: CONFIRMED_INSTALL }),
      log: (line: string) => logs.push(line),
      gateTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    await openInstallScopeCoverageGate({
      role: 'runner-ops',
      appId: '9001',
      keyPath: '/tmp/key.pem',
      appSlug: 'trial-runner-ops',
      accountLogin: 'macf-experiment',
      message: 'x',
      missingRepos: ['macf-experiment/trial-writing-agent'],
      recheck: async () => ({ covered: true, missingRepos: [], message: '' }),
      deps,
    });

    expect(logs.some((l) => l.includes('waiting for you to click "Save"'))).toBe(true);
    expect(logs.some((l) => l.includes('waiting for you to click "Install"'))).toBe(false);
  });
});
