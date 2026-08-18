/**
 * Tests for `app-identity-removal.ts` — DR-043 Amendment G's App-identity
 * report (groundnuty/macf#867). Fully offline: no `gh`/network involved;
 * `openUrl` is injected.
 */
import { describe, it, expect } from 'vitest';
import type { FleetManifest } from '../../../src/cli/bootstrap/fleet-manifest.js';
import {
  APP_DELETION_HAS_NO_REST_PATH_NOTE,
  appSettingsAdvancedUrl,
  classifyLockReadability,
  computeAppIdentityTargets,
  enrichAppIdentityTargetsWithLock,
  reportAppIdentityRemoval,
} from '../../../src/cli/bootstrap/app-identity-removal.js';

const ORG_MANIFEST: FleetManifest = {
  apiVersion: 'macf/v0',
  kind: 'Fleet',
  metadata: { name: 'macf-experiment' },
  owner: { account: 'groundnuty', type: 'org', registry: { type: 'org', org: 'macf-experiment' } },
  network: { advertise_host: 'example.ts.net' },
  transport: { age_recipients: ['age1operator'] },
  defaults: { role_template: 'groundnuty/agentic-repo-template', app_manifest: 'dr-019' },
  agents: [
    { role: 'code-agent', profile: 'code', repo: 'groundnuty/macf-experiment-code', deploy_path: '/x' },
    { role: 'science-agent', profile: 'research', repo: 'groundnuty/macf-experiment-science', deploy_path: '/y' },
  ],
  trust: { ca: 'per-project', federated_cas: [] },
};

const USER_MANIFEST: FleetManifest = {
  ...ORG_MANIFEST,
  metadata: { name: 'demo-fleet' },
  owner: { account: 'someuser', type: 'user', registry: { type: 'profile', user: 'someuser' } },
};

describe('appSettingsAdvancedUrl', () => {
  it('org-owned -> /organizations/<org>/settings/apps/<slug>/advanced', () => {
    expect(appSettingsAdvancedUrl({ account: 'groundnuty', type: 'org' }, 'macf-experiment-code-agent')).toBe(
      'https://github.com/organizations/groundnuty/settings/apps/macf-experiment-code-agent/advanced',
    );
  });

  it('user-owned -> /settings/apps/<slug>/advanced (no /organizations/ prefix)', () => {
    expect(appSettingsAdvancedUrl({ account: 'someuser', type: 'user' }, 'demo-fleet-code-agent')).toBe(
      'https://github.com/settings/apps/demo-fleet-code-agent/advanced',
    );
  });
});

describe('computeAppIdentityTargets (pure)', () => {
  it('one target per manifest agent, in manifest order, slug = deriveAppHandle(fleet, role)', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    expect(targets).toEqual([
      {
        role: 'code-agent',
        appSlug: 'macf-experiment-code-agent',
        settingsUrl: 'https://github.com/organizations/groundnuty/settings/apps/macf-experiment-code-agent/advanced',
      },
      {
        role: 'science-agent',
        appSlug: 'macf-experiment-science-agent',
        settingsUrl: 'https://github.com/organizations/groundnuty/settings/apps/macf-experiment-science-agent/advanced',
      },
    ]);
  });

  it('user-owned fleet -> user-form settings URL', () => {
    const targets = computeAppIdentityTargets(USER_MANIFEST);
    expect(targets[0]?.settingsUrl).toBe('https://github.com/settings/apps/demo-fleet-code-agent/advanced');
  });

  it('zero agents -> zero targets', () => {
    const empty: FleetManifest = { ...ORG_MANIFEST, agents: [] };
    expect(computeAppIdentityTargets(empty)).toEqual([]);
  });
});

describe('enrichAppIdentityTargetsWithLock', () => {
  const LOCK_YAML = `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
  - role: science-agent
    app_id: "555222"
    install_id: "999333"
`;

  it('lock text absent -> targets unchanged (no appId)', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const enriched = enrichAppIdentityTargetsWithLock(targets, undefined, ORG_MANIFEST);
    expect(enriched).toEqual(targets);
    expect(enriched.every((t) => t.appId === undefined)).toBe(true);
  });

  it('lock present + matching roles -> appId populated per role, everything else unchanged', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const enriched = enrichAppIdentityTargetsWithLock(targets, LOCK_YAML, ORG_MANIFEST);
    expect(enriched.find((t) => t.role === 'code-agent')?.appId).toBe('555111');
    expect(enriched.find((t) => t.role === 'science-agent')?.appId).toBe('555222');
    // slug + settingsUrl untouched
    expect(enriched.find((t) => t.role === 'code-agent')?.appSlug).toBe('macf-experiment-code-agent');
  });

  it('lock present but a role is MISSING from it -> that target stays appId: undefined, others still enriched', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const partialLock = `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
`;
    const enriched = enrichAppIdentityTargetsWithLock(targets, partialLock, ORG_MANIFEST);
    expect(enriched.find((t) => t.role === 'code-agent')?.appId).toBe('555111');
    expect(enriched.find((t) => t.role === 'science-agent')?.appId).toBeUndefined();
  });

  it('malformed/unparseable lock text -> degrades to targets unchanged, NEVER throws', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    expect(() => enrichAppIdentityTargetsWithLock(targets, 'not: [valid, fleet, lock', ORG_MANIFEST)).not.toThrow();
    expect(enrichAppIdentityTargetsWithLock(targets, 'not: [valid, fleet, lock', ORG_MANIFEST)).toEqual(targets);
  });

  it('empty-string lock text (a read that resolved but returned nothing) -> degrades to targets unchanged, NEVER throws', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    expect(() => enrichAppIdentityTargetsWithLock(targets, '', ORG_MANIFEST)).not.toThrow();
  });

  // --- groundnuty/macf#953 — the UNION fix: a lock role absent from the manifest is still targeted ---

  it('DECISIVE: a lock role NOT in manifest.agents[] is still targeted, marked extraFromLock, and PREPENDED — proves the fix is GENERAL, not runner-ops-specific', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST); // code-agent, science-agent
    const lockWithExtraRole = `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
  - role: science-agent
    app_id: "555222"
    install_id: "999333"
  - role: some-future-non-agent-role
    app_id: "999000"
    install_id: "111222"
`;
    const union = enrichAppIdentityTargetsWithLock(targets, lockWithExtraRole, ORG_MANIFEST);
    expect(union.map((t) => t.role)).toEqual(['some-future-non-agent-role', 'code-agent', 'science-agent']);
    const extra = union.find((t) => t.role === 'some-future-non-agent-role');
    expect(extra?.appId).toBe('999000');
    expect(extra?.extraFromLock).toBe(true);
    expect(extra?.appSlug).toBe('macf-experiment-some-future-non-agent-role');
    expect(extra?.settingsUrl).toBe('https://github.com/organizations/groundnuty/settings/apps/macf-experiment-some-future-non-agent-role/advanced');
    // manifest-declared targets are NEVER marked extraFromLock
    expect(union.find((t) => t.role === 'code-agent')?.extraFromLock).toBeUndefined();
  });

  it('the runner-ops role specifically is unioned in the same way — the concrete case #953 reported', () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const lockWithRunnerOps = `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
  - role: science-agent
    app_id: "555222"
    install_id: "999333"
  - role: runner-ops
    app_id: "777444"
    install_id: "888555"
`;
    const union = enrichAppIdentityTargetsWithLock(targets, lockWithRunnerOps, ORG_MANIFEST);
    const runnerOps = union.find((t) => t.role === 'runner-ops');
    expect(runnerOps).toBeDefined();
    expect(runnerOps?.appId).toBe('777444');
    expect(runnerOps?.appSlug).toBe('macf-experiment-runner-ops');
    expect(runnerOps?.extraFromLock).toBe(true);
    expect(union[0]?.role).toBe('runner-ops'); // reported FIRST
  });

  it('a lock role that IS already in manifest.agents[] (e.g. a future fleet.yaml that declares "runner-ops" as a real agent) is NEVER double-counted', () => {
    const manifestWithRunnerOpsDeclared: FleetManifest = {
      ...ORG_MANIFEST,
      agents: [...ORG_MANIFEST.agents, { role: 'runner-ops', profile: 'code', repo: 'groundnuty/macf-experiment-runner-ops', deploy_path: '/z' }],
    };
    const targets = computeAppIdentityTargets(manifestWithRunnerOpsDeclared);
    const lockWithRunnerOps = `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
  - role: science-agent
    app_id: "555222"
    install_id: "999333"
  - role: runner-ops
    app_id: "777444"
    install_id: "888555"
`;
    const union = enrichAppIdentityTargetsWithLock(targets, lockWithRunnerOps, manifestWithRunnerOpsDeclared);
    expect(union.filter((t) => t.role === 'runner-ops')).toHaveLength(1);
    expect(union.find((t) => t.role === 'runner-ops')?.extraFromLock).toBeUndefined(); // enriched, not unioned-in
  });

  it('zero manifest agents (degenerate) -> a lock-only role is still the ENTIRE union', () => {
    const empty: FleetManifest = { ...ORG_MANIFEST, agents: [] };
    const targets = computeAppIdentityTargets(empty);
    const lockOnlyRunnerOps = `schema_version: 1
fleet: macf-experiment
agents:
  - role: runner-ops
    app_id: "1"
    install_id: "2"
`;
    const union = enrichAppIdentityTargetsWithLock(targets, lockOnlyRunnerOps, empty);
    expect(union.map((t) => t.role)).toEqual(['runner-ops']);
  });
});

describe('classifyLockReadability', () => {
  it('undefined lockText -> unreadable', () => {
    expect(classifyLockReadability(undefined)).toBe('unreadable');
  });

  it('valid lock YAML -> read', () => {
    const validLock = `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
`;
    expect(classifyLockReadability(validLock)).toBe('read');
  });

  it('malformed/unparseable lock text -> unreadable, never throws', () => {
    expect(() => classifyLockReadability('not: [valid, fleet, lock')).not.toThrow();
    expect(classifyLockReadability('not: [valid, fleet, lock')).toBe('unreadable');
  });

  it('empty-string lock text -> unreadable, never throws', () => {
    expect(() => classifyLockReadability('')).not.toThrow();
    expect(classifyLockReadability('')).toBe('unreadable');
  });
});

describe('reportAppIdentityRemoval', () => {
  it('no checkAppPresence wired -> NEVER returns a status other than manual-action-required, for every target (backward-compatible default)', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const logs: string[] = [];
    const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, (l) => logs.push(l), {});
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === 'manual-action-required')).toBe(true);
    expect(outcomes.every((o) => o.reason === APP_DELETION_HAS_NO_REST_PATH_NOTE)).toBe(true);
  });

  it('logs the settings URL for every target BEFORE openUrl is attempted', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const logs: string[] = [];
    const opened: string[] = [];
    await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, (l) => logs.push(l), {
      openUrl: async (url) => {
        // The log line for THIS target must already be present by the time openUrl fires.
        expect(logs.some((l) => l.includes(url))).toBe(true);
        opened.push(url);
      },
    });
    expect(opened).toEqual(targets.map((t) => t.settingsUrl));
  });

  it('openUrl failure is non-fatal — still reports manual-action-required, logs the fallback line', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1);
    const logs: string[] = [];
    const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, (l) => logs.push(l), {
      openUrl: async () => {
        throw new Error('no display available');
      },
    });
    expect(outcomes[0]?.status).toBe('manual-action-required');
    expect(logs.join('\n')).toMatch(/could not automatically open a browser/);
  });

  it('openUrl omitted entirely -> still reports every target (headless/CI/test posture)', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST);
    const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, () => {});
    expect(outcomes).toHaveLength(2);
  });

  it('a target enriched with appId carries it through to the outcome AND the log line', async () => {
    const targets = enrichAppIdentityTargetsWithLock(computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1), `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
`, ORG_MANIFEST);
    const logs: string[] = [];
    const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, (l) => logs.push(l));
    expect(outcomes[0]?.appId).toBe('555111');
    expect(logs.join('\n')).toMatch(/555111/);
  });

  it('a target WITHOUT appId (no lock enrichment) reports undefined and a "no confirmation" caveat', async () => {
    const targets = computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1);
    const logs: string[] = [];
    const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, (l) => logs.push(l));
    expect(outcomes[0]?.appId).toBeUndefined();
    expect(logs.join('\n')).toMatch(/no fleet\.lock entry/);
  });

  // --- groundnuty/macf#917 — App already gone: report already-absent, never instruct a browser deletion of nothing ---

  describe('checkAppPresence wired', () => {
    it('presence "absent" -> status already-absent, the manual-deletion line is NEVER logged, openUrl is NEVER called', async () => {
      const targets = computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1);
      const logs: string[] = [];
      let openCalled = false;
      const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, (l) => logs.push(l), {
        checkAppPresence: async () => 'absent',
        openUrl: async () => {
          openCalled = true;
        },
      });
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.status).toBe('already-absent');
      expect(openCalled).toBe(false);
      expect(logs.join('\n')).toMatch(/already absent/);
      expect(logs.join('\n')).not.toMatch(/MANUAL ACTION REQUIRED|Delete at:/);
    });

    it('presence "absent" -> reason names the check as a PREDICTED-slug read, not a confirmed-deletion claim', async () => {
      const targets = computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1);
      const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, () => {}, { checkAppPresence: async () => 'absent' });
      expect(outcomes[0]?.reason).toMatch(/PREDICTION/);
      expect(outcomes[0]?.reason).toMatch(/404/);
    });

    it('presence "present" -> stays manual-action-required (an existing App is NOT already-absent)', async () => {
      const targets = computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1);
      const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, () => {}, { checkAppPresence: async () => 'present' });
      expect(outcomes[0]?.status).toBe('manual-action-required');
    });

    // groundnuty/macf#967 — an explicitly-wired-but-inconclusive check now
    // gets its OWN distinct status, never silently upgraded to
    // 'already-absent' NOR conflated with the confirmed-present
    // 'manual-action-required' bucket. See `AppDeletionOutcome.status`'s doc.
    it('presence "unknown" (permission-denied / listing unavailable) -> its OWN distinct "unknown" status — never already-absent, never silently folded into manual-action-required', async () => {
      const targets = computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1);
      const logs: string[] = [];
      const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, (l) => logs.push(l), { checkAppPresence: async () => 'unknown' });
      expect(outcomes[0]?.status).toBe('unknown');
      expect(outcomes[0]?.reason).toMatch(/could not verify/);
      expect(logs.join('\n')).toMatch(/UNKNOWN —/);
    });

    it('checkAppPresence OMITTED entirely still stays manual-action-required (the pre-#917 default — distinct from an explicit inconclusive check)', async () => {
      const targets = computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1);
      const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, () => {});
      expect(outcomes[0]?.status).toBe('manual-action-required');
    });

    it('appId + settingsUrl are still carried through on an already-absent outcome', async () => {
      const targets = enrichAppIdentityTargetsWithLock(computeAppIdentityTargets(ORG_MANIFEST).slice(0, 1), `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
`, ORG_MANIFEST);
      const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, () => {}, { checkAppPresence: async () => 'absent' });
      expect(outcomes[0]?.appId).toBe('555111');
      expect(outcomes[0]?.settingsUrl).toBe(targets[0]?.settingsUrl);
    });

    it('mixed fleet: one role already-absent, one still present -> each target resolved independently', async () => {
      const targets = computeAppIdentityTargets(ORG_MANIFEST); // code-agent, science-agent
      const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, () => {}, {
        // groundnuty/macf#967 widened checkAppPresence to (owner, appSlug) —
        // appSlug is now the SECOND positional param.
        checkAppPresence: async (_owner, slug) => (slug === targets[0]?.appSlug ? 'absent' : 'present'),
      });
      expect(outcomes.find((o) => o.role === 'code-agent')?.status).toBe('already-absent');
      expect(outcomes.find((o) => o.role === 'science-agent')?.status).toBe('manual-action-required');
    });

    // --- groundnuty/macf#953 — already-absent report for a lock-only target still carries the distinct marker ---

    it('already-absent App still reports already-absent with the predicted-slug caveat, EVEN when it is a lock-only (extraFromLock) target — and gets the distinct NOT-DECLARED marker too', async () => {
      const runnerOpsTarget = enrichAppIdentityTargetsWithLock([], `schema_version: 1
fleet: macf-experiment
agents:
  - role: runner-ops
    app_id: "777444"
    install_id: "888555"
`, ORG_MANIFEST);
      expect(runnerOpsTarget).toHaveLength(1);
      const logs: string[] = [];
      const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, runnerOpsTarget, (l) => logs.push(l), { checkAppPresence: async () => 'absent' });
      expect(outcomes[0]?.status).toBe('already-absent');
      expect(outcomes[0]?.extraFromLock).toBe(true);
      expect(outcomes[0]?.reason).toMatch(/PREDICTION/);
      expect(outcomes[0]?.reason).toMatch(/404/);
      expect(logs.join('\n')).toMatch(/already absent/);
      expect(logs.join('\n')).toMatch(/NOT DECLARED IN fleet\.yaml/);
      // the distinct marker must never be confused with the manual-deletion shape
      expect(logs.join('\n')).not.toMatch(/MANUAL ACTION REQUIRED|Delete at:/);
    });
  });

  // --- groundnuty/macf#953 — the "mark it distinctly" half: lock-only targets get a visible marker ---

  it('a lock-only (extraFromLock) target gets a visible "NOT DECLARED IN fleet.yaml" marker in its log line', async () => {
    const targets = enrichAppIdentityTargetsWithLock(computeAppIdentityTargets(ORG_MANIFEST), `schema_version: 1
fleet: macf-experiment
agents:
  - role: code-agent
    app_id: "555111"
    install_id: "999222"
  - role: science-agent
    app_id: "555222"
    install_id: "999333"
  - role: runner-ops
    app_id: "777444"
    install_id: "888555"
`, ORG_MANIFEST);
    const logs: string[] = [];
    const outcomes = await reportAppIdentityRemoval(ORG_MANIFEST.owner, targets, (l) => logs.push(l));
    expect(outcomes).toHaveLength(3);
    const runnerOpsOutcome = outcomes.find((o) => o.role === 'runner-ops');
    expect(runnerOpsOutcome?.extraFromLock).toBe(true);
    expect(runnerOpsOutcome?.appId).toBe('777444');
    const runnerOpsLine = logs.find((l) => l.includes('runner-ops'));
    expect(runnerOpsLine).toMatch(/NOT DECLARED IN fleet\.yaml/);
    // manifest-declared roles' log lines carry NO such marker
    const codeAgentLine = logs.find((l) => l.includes('code-agent'));
    expect(codeAgentLine).not.toMatch(/NOT DECLARED IN fleet\.yaml/);
  });
});
