/**
 * Tests for `fleet-lock.ts` — the `fleet.lock` composer/serializer (DR-043
 * §D5 write-through, Slice 2b increment 4, groundnuty/macf#838 / macf#846
 * review). Fully offline + pure: `writeFleetLock` (the only I/O leaf) is
 * exercised separately and lightly, per the `observer.ts` thin-leaf
 * convention.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeFleetLock,
  secretFingerprint,
  serializeFleetLock,
  writeFleetLock,
  type ComposeFleetLockInput,
} from '../../../src/cli/bootstrap/fleet-lock.js';
import { parseFleetLock, type FleetLock } from '../../../src/cli/bootstrap/fleet-manifest.js';

describe('secretFingerprint', () => {
  it('is sha256:<64-hex-char> — matches the shape fixed by fleet-manifest.test.ts\'s parseFleetLock fixture', () => {
    const fp = secretFingerprint('hunter2');
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic (same input -> same fingerprint)', () => {
    expect(secretFingerprint('abc')).toBe(secretFingerprint('abc'));
  });

  it('differs for different inputs (no accidental collisions on trivial cases)', () => {
    expect(secretFingerprint('abc')).not.toBe(secretFingerprint('abd'));
  });

  it('matches the known SHA-256 of the empty string (sanity-checks the algorithm choice, not just self-consistency)', () => {
    expect(secretFingerprint('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('composeFleetLock — fresh fleet (previous = null)', () => {
  it('composes a brand-new agent with fingerprinted secrets, no identityChanges', () => {
    const input: ComposeFleetLockInput = {
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: {
        'code-agent': {
          appId: '111',
          installId: '222',
          secrets: { client_secret: 'shh', webhook_secret: 'hook' },
        },
      },
    };
    const { lock, identityChanges } = composeFleetLock(input);
    expect(identityChanges).toEqual([]);
    expect(lock.schema_version).toBe(1);
    expect(lock.fleet).toBe('demo-fleet');
    expect(lock.agents).toEqual([
      {
        role: 'code-agent',
        app_id: '111',
        install_id: '222',
        fingerprints: {
          client_secret: secretFingerprint('shh'),
          webhook_secret: secretFingerprint('hook'),
        },
      },
    ]);
  });

  it('omits fingerprints entirely (never {}) when no secrets are given for an agent', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: { 'code-agent': { appId: '111', installId: '222' } },
    });
    expect(lock.agents[0]?.fingerprints).toBeUndefined();
  });

  it('carries deployedVersion through when given', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: { 'code-agent': { appId: '111', installId: '222', deployedVersion: '0.2.56' } },
    });
    expect(lock.agents[0]?.deployed_version).toBe('0.2.56');
  });

  // groundnuty/macf#1296 — a fleet.lock agent gains an optional `repo` field
  // so a role can still be NAMED after it is dropped from `manifest.agents[]`
  // (`#1281`'s repo-orphan URL) and a secret delete can resolve its target
  // (`#1272`). See `fleet-manifest.ts::FleetLockAgentSchema`'s own doc.
  it('carries repo through when given', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: { 'code-agent': { appId: '111', installId: '222', repo: 'groundnuty/demo-code-agent' } },
    });
    expect(lock.agents[0]?.repo).toBe('groundnuty/demo-code-agent');
  });

  it('omits repo entirely (never a fabricated value) when no repo is given for a fresh agent', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: { 'code-agent': { appId: '111', installId: '222' } },
    });
    expect(lock.agents[0]?.repo).toBeUndefined();
    expect('repo' in (lock.agents[0] ?? {})).toBe(false);
  });

  it('sorts agents by role for deterministic output regardless of input order', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: {
        'writer-agent': { appId: '3', installId: '3' },
        'code-agent': { appId: '1', installId: '1' },
        'science-agent': { appId: '2', installId: '2' },
      },
    });
    expect(lock.agents.map((a) => a.role)).toEqual(['code-agent', 'science-agent', 'writer-agent']);
  });

  it('fails loud (throws) when composed with an invalid fleet name — never silently accepts a lock we built wrong', () => {
    expect(() =>
      composeFleetLock({ fleet: '', previous: null, agentUpdates: {} }),
    ).toThrow();
  });
});

describe('composeFleetLock — re-apply against a previous lock (no-prune, §D3 invariant 4)', () => {
  const previous: FleetLock = {
    schema_version: 1,
    fleet: 'demo-fleet',
    agents: [
      {
        role: 'science-agent',
        app_id: '999',
        install_id: '888',
        repo: 'groundnuty/demo-science-agent',
        fingerprints: { client_secret: secretFingerprint('old-secret') },
        deployed_version: '0.2.50',
      },
    ],
    fingerprints: { ca_key: secretFingerprint('old-ca-key') },
  };

  it('carries an UNTOUCHED agent forward verbatim when agentUpdates does not mention it', () => {
    const { lock, identityChanges } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'code-agent': { appId: '1', installId: '2' } },
    });
    expect(identityChanges).toEqual([]);
    const science = lock.agents.find((a) => a.role === 'science-agent');
    expect(science).toEqual(previous.agents[0]);
  });

  it('a re-touched agent with the SAME app_id/install_id produces no identityChanges', () => {
    const { identityChanges } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'science-agent': { appId: '999', installId: '888' } },
    });
    expect(identityChanges).toEqual([]);
  });

  it('Amendment-A §A2: a DIFFERENT app_id on a touched agent is surfaced as an identityChange, never silently absorbed', () => {
    const { lock, identityChanges } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'science-agent': { appId: '111222', installId: '888' } },
    });
    expect(identityChanges).toEqual([
      { role: 'science-agent', field: 'app_id', previous: '999', next: '111222' },
    ]);
    // The lock still records the FRESH value (§D5: apply's actual result) —
    // identityChanges is the "don't silently resolve" signal, not a veto.
    expect(lock.agents.find((a) => a.role === 'science-agent')?.app_id).toBe('111222');
  });

  it('a DIFFERENT install_id on a touched agent is ALSO surfaced (independent of app_id)', () => {
    const { identityChanges } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'science-agent': { appId: '999', installId: '777' } },
    });
    expect(identityChanges).toEqual([
      { role: 'science-agent', field: 'install_id', previous: '888', next: '777' },
    ]);
  });

  it('both app_id AND install_id changing produces two identityChanges entries', () => {
    const { identityChanges } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'science-agent': { appId: '1', installId: '2' } },
    });
    expect(identityChanges).toHaveLength(2);
  });

  it('a brand-new agent (no previous entry) never produces an identityChange', () => {
    const { identityChanges } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'code-agent': { appId: '1', installId: '2' } },
    });
    expect(identityChanges).toEqual([]);
  });

  it('merges a touched agent\'s fingerprints: a secret name absent from THIS run\'s update keeps its prior fingerprint', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {
        'science-agent': { appId: '999', installId: '888', secrets: { webhook_secret: 'new-hook' } },
      },
    });
    expect(lock.agents[0]?.fingerprints).toEqual({
      client_secret: secretFingerprint('old-secret'), // carried forward, untouched this run
      webhook_secret: secretFingerprint('new-hook'), // freshly established this run
    });
  });

  it('a re-established secret OVERRIDES its prior fingerprint (fresh always wins)', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {
        'science-agent': { appId: '999', installId: '888', secrets: { client_secret: 'rotated-secret' } },
      },
    });
    expect(lock.agents[0]?.fingerprints?.client_secret).toBe(secretFingerprint('rotated-secret'));
    expect(lock.agents[0]?.fingerprints?.client_secret).not.toBe(secretFingerprint('old-secret'));
  });

  it('an untouched deployed_version is preserved when the update omits it', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'science-agent': { appId: '999', installId: '888' } },
    });
    expect(lock.agents[0]?.deployed_version).toBe('0.2.50');
  });

  // groundnuty/macf#1296 — same "omitted update ≠ clobber" contract
  // deployed_version already establishes above, extended to repo. This is
  // the shape `fleet-lock-recorder.ts`'s deployedVersion-only write ACTUALLY
  // sends (never a repo), so this pins that a version-recording run never
  // wipes out a role's previously-recorded repo as a side effect.
  it('a repo recorded on a PRIOR run is preserved when a re-touch update omits repo entirely', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'science-agent': { appId: '999', installId: '888' } },
    });
    expect(lock.agents[0]?.repo).toBe('groundnuty/demo-science-agent');
  });

  it('a FRESH repo on a touched agent overrides the prior recorded repo', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'science-agent': { appId: '999', installId: '888', repo: 'groundnuty/demo-science-agent-renamed' } },
    });
    expect(lock.agents[0]?.repo).toBe('groundnuty/demo-science-agent-renamed');
  });

  it('a changed repo is deliberately NOT surfaced as an identityChange — repo is operator-editable free text, not a drift signal', () => {
    const { identityChanges } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'science-agent': { appId: '999', installId: '888', repo: 'groundnuty/demo-science-agent-renamed' } },
    });
    expect(identityChanges).toEqual([]);
  });

  // groundnuty/macf#1310 DECISIVE (1/2): `previous` above declares its
  // fleet-level fingerprint under the DEPRECATED bare `fingerprints` key
  // (the shape every already-provisioned fleet's lock is in right now) —
  // composing over it must still read the old CA-key fingerprint AND
  // migrate the merged result onto the NEW `fleet_fingerprints` key, never
  // losing the value and never emitting the old key again. This is the
  // "a rename must read the old key and write the new one" contract
  // (`#1252`'s undefined-vs-absent lesson, applied to a key rename).
  it('fleet-level fingerprints merge the same way: prior CA key fingerprint preserved, new fleet secret added — reading the DEPRECATED `fingerprints` key, writing the NEW `fleet_fingerprints` key', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      fleetSecrets: { routing_app_key: 'routing-pem' },
    });
    expect(lock.fleet_fingerprints).toEqual({
      ca_key: secretFingerprint('old-ca-key'),
      routing_app_key: secretFingerprint('routing-pem'),
    });
    // Never re-emits the legacy key alongside the new one — a rewritten
    // lock finishes fully migrated, not carrying both.
    expect('fingerprints' in lock).toBe(false);
  });

  // groundnuty/macf#1310 DECISIVE (2/2): the mirror case — `previous`
  // already uses the NEW `fleet_fingerprints` key (a lock written by a
  // post-#1310 `apply`) — composing over it reads correctly with no
  // fallback needed.
  it('fleet-level fingerprints read correctly from a lock ALREADY on the new `fleet_fingerprints` key (post-#1310 shape)', () => {
    const previousNewKey: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      fleet_fingerprints: { ca_key: secretFingerprint('old-ca-key') },
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: previousNewKey,
      agentUpdates: {},
      fleetSecrets: { routing_app_key: 'routing-pem' },
    });
    expect(lock.fleet_fingerprints).toEqual({
      ca_key: secretFingerprint('old-ca-key'),
      routing_app_key: secretFingerprint('routing-pem'),
    });
  });

  it('a fleet whose lock carries BOTH keys (a hand-built/transitional shape) prefers the NEW key, never silently merging the two', () => {
    const previousBothKeys: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      fleet_fingerprints: { ca_key: secretFingerprint('new-key-ca') },
      fingerprints: { ca_key: secretFingerprint('old-key-ca') },
    };
    const { lock } = composeFleetLock({ fleet: 'demo-fleet', previous: previousBothKeys, agentUpdates: {} });
    expect(lock.fleet_fingerprints?.['ca_key']).toBe(secretFingerprint('new-key-ca'));
  });

  it('versions merge field-by-field: fresh actions overrides, previous macf (absent from fresh) is preserved', () => {
    const withVersions: FleetLock = { ...previous, versions: { macf: '0.2.55', actions: 'v3.4.1' } };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: withVersions,
      agentUpdates: {},
      versions: { actions: 'v3.4.2' },
    });
    expect(lock.versions).toEqual({ macf: '0.2.55', actions: 'v3.4.2' });
  });

  it('versions is omitted entirely (never {}) when neither previous nor fresh declares any version', () => {
    const { lock } = composeFleetLock({ fleet: 'demo-fleet', previous, agentUpdates: {} });
    expect(lock.versions).toBeUndefined();
  });
});

describe('composeFleetLock — age_recipients_removed_by_override (groundnuty/macf#1230)', () => {
  it('is undefined when neither previous nor fresh has ever recorded a removal', () => {
    const { lock } = composeFleetLock({ fleet: 'demo-fleet', previous: null, agentUpdates: {} });
    expect(lock.age_recipients_removed_by_override).toBeUndefined();
  });

  it('a first removal (previous has none) is recorded verbatim', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: {},
      ageRecipientsRemovedByOverride: ['age1b'],
    });
    expect(lock.age_recipients_removed_by_override).toEqual(['age1b']);
  });

  it('DECISIVE: UNIONS with previous, never replaces — an implementation that overwrote instead of unioned would pass every OTHER test in this file (all start from an empty ledger) but fail this one', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      age_recipients: ['age1a'],
      age_recipients_removed_by_override: ['age1c'], // an EARLIER run's removal
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      ageRecipientsRemovedByOverride: ['age1b'], // THIS run's removal
    });
    // Both survive — the append-only ledger contract (AC 4: "a later reader
    // can tell a narrowed list from an original one") depends entirely on
    // this NOT being a replace.
    expect(lock.age_recipients_removed_by_override).toEqual(['age1b', 'age1c']);
  });

  it('deduplicates — the same recipient removed twice across two runs appears once', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      age_recipients_removed_by_override: ['age1b'],
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      ageRecipientsRemovedByOverride: ['age1b'],
    });
    expect(lock.age_recipients_removed_by_override).toEqual(['age1b']);
  });

  it('carries the ledger forward UNCHANGED when a write touches nothing age_recipients-related — the writeIncrementalLock/writeScopeCredentialMarker shape (both omit this field on every call)', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      age_recipients_removed_by_override: ['age1b'],
    };
    // Mirrors an unrelated per-agent write: agentUpdates touches a role,
    // but ageRecipientsRemovedByOverride is never passed at all.
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'code-agent': { appId: '1', installId: '2' } },
    });
    expect(lock.age_recipients_removed_by_override).toEqual(['age1b']);
  });
});

describe('composeFleetLock — collaborators (groundnuty/macf#1330 — federated peer recipient sets)', () => {
  it('is undefined when neither previous nor fresh has ever recorded a federated collaborator', () => {
    const { lock } = composeFleetLock({ fleet: 'demo-fleet', previous: null, agentUpdates: {} });
    expect(lock.collaborators).toBeUndefined();
  });

  it('a first-recorded collaborator is written verbatim', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: {},
      collaboratorRecipients: [{ project: 'ppam-2026', ageRecipients: ['age1a', 'age1b'] }],
    });
    expect(lock.collaborators).toEqual([{ project: 'ppam-2026', age_recipients: ['age1a', 'age1b'] }]);
  });

  it('an UNTOUCHED collaborator (this run updates a DIFFERENT project) carries forward verbatim — never pruned', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      collaborators: [{ project: 'ppam-2026', age_recipients: ['age1a'] }],
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      collaboratorRecipients: [{ project: 'other-fleet', ageRecipients: ['age1z'] }],
    });
    expect(lock.collaborators).toEqual([
      { project: 'other-fleet', age_recipients: ['age1z'] },
      { project: 'ppam-2026', age_recipients: ['age1a'] },
    ]);
  });

  it('DECISIVE: a project present in `fresh` REPLACES its prior entry WHOLESALE, never unions — a shrink must actually shrink on disk, not silently keep the old members alongside the new', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      collaborators: [{ project: 'ppam-2026', age_recipients: ['age1a', 'age1gone'] }],
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      collaboratorRecipients: [{ project: 'ppam-2026', ageRecipients: ['age1a'] }],
    });
    expect(lock.collaborators).toEqual([{ project: 'ppam-2026', age_recipients: ['age1a'] }]);
  });

  it('carries every collaborator forward UNCHANGED when a write touches nothing collaborator-related (collaboratorRecipients omitted entirely)', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      collaborators: [{ project: 'ppam-2026', age_recipients: ['age1a'] }],
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'code-agent': { appId: '1', installId: '2' } },
    });
    expect(lock.collaborators).toEqual([{ project: 'ppam-2026', age_recipients: ['age1a'] }]);
  });

  it('sorts by project for deterministic output regardless of input/previous order', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      collaborators: [{ project: 'zzz-fleet', age_recipients: ['age1z'] }],
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      collaboratorRecipients: [{ project: 'aaa-fleet', ageRecipients: ['age1a'] }],
    });
    expect(lock.collaborators?.map((c) => c.project)).toEqual(['aaa-fleet', 'zzz-fleet']);
  });

  it('a collaborator with an explicit empty age_recipients (a real, recorded "zero recipients" fact) is preserved, never dropped as if it were undefined', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: {},
      collaboratorRecipients: [{ project: 'ppam-2026', ageRecipients: [] }],
    });
    expect(lock.collaborators).toEqual([{ project: 'ppam-2026', age_recipients: [] }]);
  });
});

describe('composeFleetLock — federated_ca_trust (groundnuty/macf#1389 — federated-CA-bundle approved fingerprints)', () => {
  it('is undefined when neither previous nor fresh has ever recorded a federated-CA-trust fingerprint', () => {
    const { lock } = composeFleetLock({ fleet: 'demo-fleet', previous: null, agentUpdates: {} });
    expect(lock.federated_ca_trust).toBeUndefined();
  });

  it('a first-recorded project is written verbatim', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous: null,
      agentUpdates: {},
      federatedCaTrust: [{ project: 'ppam-2026', caBundleFingerprint: 'sha256:aaa' }],
    });
    expect(lock.federated_ca_trust).toEqual([{ project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:aaa' }]);
  });

  it('an UNTOUCHED project (this run records a DIFFERENT project) carries forward verbatim — never pruned', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      federated_ca_trust: [{ project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:aaa' }],
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      federatedCaTrust: [{ project: 'other-fleet', caBundleFingerprint: 'sha256:bbb' }],
    });
    expect(lock.federated_ca_trust).toEqual([
      { project: 'other-fleet', ca_bundle_fingerprint: 'sha256:bbb' },
      { project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:aaa' },
    ]);
  });

  it('DECISIVE: a project present in `fresh` REPLACES its prior fingerprint WHOLESALE, never accumulates — a CHANGED-then-re-approved bundle must overwrite the old fingerprint on disk, not sit alongside it', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      federated_ca_trust: [{ project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:old' }],
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      federatedCaTrust: [{ project: 'ppam-2026', caBundleFingerprint: 'sha256:new' }],
    });
    expect(lock.federated_ca_trust).toEqual([{ project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:new' }]);
  });

  it('carries every project forward UNCHANGED when a write touches nothing federated-CA-trust-related (federatedCaTrust omitted entirely)', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      federated_ca_trust: [{ project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:aaa' }],
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: { 'code-agent': { appId: '1', installId: '2' } },
    });
    expect(lock.federated_ca_trust).toEqual([{ project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:aaa' }]);
  });

  it('sorts by project for deterministic output regardless of input/previous order', () => {
    const previous: FleetLock = {
      schema_version: 1,
      fleet: 'demo-fleet',
      agents: [],
      federated_ca_trust: [{ project: 'zzz-fleet', ca_bundle_fingerprint: 'sha256:zzz' }],
    };
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      federatedCaTrust: [{ project: 'aaa-fleet', caBundleFingerprint: 'sha256:aaa' }],
    });
    expect(lock.federated_ca_trust?.map((c) => c.project)).toEqual(['aaa-fleet', 'zzz-fleet']);
  });
});

describe('serializeFleetLock', () => {
  // groundnuty/macf#1310 — this fixture DELIBERATELY declares its
  // fleet-level fingerprints under the DEPRECATED bare `fingerprints` key
  // (the shape every already-provisioned fleet's `fleet.lock` is in right
  // now), so every test in this block exercises "reads the old key" by
  // construction. The per-agent `fingerprints` on `science-agent` below is
  // the UNRELATED, never-renamed per-agent field — same word, different
  // object, see `FleetLockAgentSchema`'s doc.
  const lock: FleetLock = {
    schema_version: 1,
    fleet: 'demo-fleet',
    agents: [
      { role: 'science-agent', app_id: '2', install_id: '2', fingerprints: { z_secret: 'sha256:zz', a_secret: 'sha256:aa' } },
      { role: 'code-agent', app_id: '1', install_id: '1' },
    ],
    fingerprints: { z_key: 'sha256:zz', a_key: 'sha256:aa' },
  };

  it('ends with exactly one trailing newline', () => {
    const out = serializeFleetLock(lock);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('is valid JSON (a strict subset of the YAML-superset format fleet.lock uses)', () => {
    expect(() => JSON.parse(serializeFleetLock(lock))).not.toThrow();
  });

  it('sorts agents[] by role and each fingerprints map by key, regardless of input order', () => {
    const parsed = JSON.parse(serializeFleetLock(lock)) as {
      agents: { role: string; fingerprints?: Record<string, string> }[];
      fleet_fingerprints: Record<string, string>;
    };
    expect(parsed.agents.map((a) => a.role)).toEqual(['code-agent', 'science-agent']);
    expect(Object.keys(parsed.agents[0]?.fingerprints ?? {})).toEqual([]);
    expect(Object.keys(parsed.agents[1]?.fingerprints ?? {})).toEqual(['a_secret', 'z_secret']);
    expect(Object.keys(parsed.fleet_fingerprints)).toEqual(['a_key', 'z_key']);
  });

  it('is idempotent: serializing twice from the same input produces byte-identical output', () => {
    expect(serializeFleetLock(lock)).toBe(serializeFleetLock(lock));
  });

  // groundnuty/macf#1310 DECISIVE — `lock` above declares its fleet-level
  // fingerprints under the DEPRECATED `fingerprints` key; round-tripping
  // through serialize+parse must both preserve the values AND land them on
  // the NEW `fleet_fingerprints` key — the "read old, write new" contract.
  it('round-trips through parseFleetLock, MIGRATED onto the new `fleet_fingerprints` key — the deprecated key never reappears', () => {
    const roundTripped = parseFleetLock(serializeFleetLock(lock));
    expect(roundTripped.fleet).toBe(lock.fleet);
    expect(roundTripped.agents).toHaveLength(2);
    expect(roundTripped.fleet_fingerprints).toEqual({ a_key: 'sha256:aa', z_key: 'sha256:zz' });
    expect(roundTripped.fingerprints).toBeUndefined();
  });

  it('omits versions/fleet_fingerprints keys entirely when absent (never emits an empty {} placeholder)', () => {
    const minimal: FleetLock = { schema_version: 1, fleet: 'x', agents: [] };
    const parsed = JSON.parse(serializeFleetLock(minimal)) as Record<string, unknown>;
    expect('versions' in parsed).toBe(false);
    expect('fleet_fingerprints' in parsed).toBe(false);
    expect('fingerprints' in parsed).toBe(false);
  });

  // groundnuty/macf#1310 — `serializeFleetLock` is the boundary a caller
  // could feed a hand-built object through (its own module doc); confirms
  // it upgrades a lock that ONLY ever had the legacy key, with no
  // `composeFleetLock` step in between.
  it('a hand-built lock carrying ONLY the deprecated `fingerprints` key still serializes onto `fleet_fingerprints`', () => {
    const legacyOnly: FleetLock = { schema_version: 1, fleet: 'x', agents: [], fingerprints: { ca_key: 'sha256:legacy' } };
    const parsed = JSON.parse(serializeFleetLock(legacyOnly)) as Record<string, unknown>;
    expect(parsed['fleet_fingerprints']).toEqual({ ca_key: 'sha256:legacy' });
    expect('fingerprints' in parsed).toBe(false);
  });

  it('re-validates and throws on a hand-built, schema-invalid lock (never trusts an unvalidated shape onto disk)', () => {
    const bad = { schema_version: 1, fleet: 'x', agents: [], extra_unknown_key: 'nope' } as unknown as FleetLock;
    expect(() => serializeFleetLock(bad)).toThrow();
  });

  // groundnuty/macf#1230 — `serializeFleetLock` hand-builds its output
  // object from an explicit field allowlist (`ordered`) rather than
  // spreading `validated` — a real bug this exact test caught: the ledger
  // field was correctly computed by `composeFleetLock` and correctly
  // present on `validated` (post `.parse()`), but silently dropped before
  // ever reaching disk because `ordered`'s allowlist hadn't been updated to
  // include it. `.parse()` succeeding is NOT evidence the field survives —
  // this is a `silent-fallback-hazards.md`-shaped trap at the serialization
  // boundary, distinct from schema validation.
  it('age_recipients_removed_by_override round-trips through parseFleetLock unchanged (regression pin for the allowlist-drop bug)', () => {
    const withLedger: FleetLock = { ...lock, age_recipients: ['age1a'], age_recipients_removed_by_override: ['age1b'] };
    const roundTripped = parseFleetLock(serializeFleetLock(withLedger));
    expect(roundTripped.age_recipients).toEqual(['age1a']);
    expect(roundTripped.age_recipients_removed_by_override).toEqual(['age1b']);
  });

  // groundnuty/macf#1296 — `orderedAgent` hand-builds from an explicit field
  // allowlist, same shape `age_recipients_removed_by_override`'s regression
  // pin above documents for the fleet-level allowlist. A composer-altitude
  // assertion (checking `composeFleetLock`'s returned object) would NOT
  // catch a field dropped from `orderedAgent` — `.parse()` inside
  // `serializeFleetLock` does not strip a schema-valid field, only the
  // hand-built `ordered` object can silently omit it. This test round-trips
  // through `parseFleetLock`, so it fails if `orderedAgent` ever drops
  // `repo` — the exact #1260 defect class.
  it('agent repo round-trips through parseFleetLock unchanged (allowlist-drop regression pin)', () => {
    const withRepo: FleetLock = {
      ...lock,
      agents: [{ role: 'code-agent', app_id: '1', install_id: '1', repo: 'groundnuty/demo-code-agent' }],
    };
    const roundTripped = parseFleetLock(serializeFleetLock(withRepo));
    expect(roundTripped.agents[0]?.repo).toBe('groundnuty/demo-code-agent');
  });

  // groundnuty/macf#1330 — same allowlist-drop shape as the two regression
  // pins immediately above (#1230's ledger, #1296's repo), applied to the
  // new federated `collaborators` field: `ordered`'s object literal must
  // explicitly copy it through, or a schema-valid field silently never
  // reaches disk.
  it('collaborators round-trip through parseFleetLock unchanged, SORTED by project (allowlist-drop regression pin)', () => {
    const withCollaborators: FleetLock = {
      ...lock,
      collaborators: [
        { project: 'zzz-fleet', age_recipients: ['age1z'] },
        { project: 'ppam-2026', age_recipients: ['age1a', 'age1b'] },
      ],
    };
    const roundTripped = parseFleetLock(serializeFleetLock(withCollaborators));
    expect(roundTripped.collaborators).toEqual([
      { project: 'ppam-2026', age_recipients: ['age1a', 'age1b'] },
      { project: 'zzz-fleet', age_recipients: ['age1z'] },
    ]);
  });

  it('a collaborator\'s own age_recipients order is preserved VERBATIM (position is real information within one peer\'s set)', () => {
    const withCollaborators: FleetLock = {
      ...lock,
      collaborators: [{ project: 'ppam-2026', age_recipients: ['age1second', 'age1first'] }],
    };
    const roundTripped = parseFleetLock(serializeFleetLock(withCollaborators));
    expect(roundTripped.collaborators?.[0]?.age_recipients).toEqual(['age1second', 'age1first']);
  });

  it('omits the "collaborators" key entirely when absent (never a fabricated empty array)', () => {
    const parsed = JSON.parse(serializeFleetLock(lock)) as Record<string, unknown>;
    expect('collaborators' in parsed).toBe(false);
  });

  // groundnuty/macf#1389 — same allowlist-drop shape as `collaborators`
  // immediately above, applied to the new `federated_ca_trust` field.
  it('federated_ca_trust round-trips through parseFleetLock unchanged, SORTED by project (allowlist-drop regression pin)', () => {
    const withFederatedCaTrust: FleetLock = {
      ...lock,
      federated_ca_trust: [
        { project: 'zzz-fleet', ca_bundle_fingerprint: 'sha256:zzz' },
        { project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:ppam' },
      ],
    };
    const roundTripped = parseFleetLock(serializeFleetLock(withFederatedCaTrust));
    expect(roundTripped.federated_ca_trust).toEqual([
      { project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:ppam' },
      { project: 'zzz-fleet', ca_bundle_fingerprint: 'sha256:zzz' },
    ]);
  });

  it('omits the "federated_ca_trust" key entirely when absent (never a fabricated empty array)', () => {
    const parsed = JSON.parse(serializeFleetLock(lock)) as Record<string, unknown>;
    expect('federated_ca_trust' in parsed).toBe(false);
  });
});

describe('writeFleetLock (thin I/O leaf)', () => {
  it('writes a file that parseFleetLock reads back correctly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-lock-test-'));
    try {
      const path = join(dir, 'fleet.lock');
      const { lock } = composeFleetLock({
        fleet: 'demo-fleet',
        previous: null,
        agentUpdates: { 'code-agent': { appId: '1', installId: '2' } },
      });
      writeFleetLock(path, lock);
      const roundTripped = parseFleetLock(readFileSync(path, 'utf-8'));
      expect(roundTripped.fleet).toBe('demo-fleet');
      expect(roundTripped.agents).toEqual(lock.agents);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // groundnuty/macf#1296 DECISIVE — "the field survives to disk" per the
  // issue's own AC ("a test must assert the field reaches the file, not
  // that the composer produced it"). Reads the raw JSON bytes off disk
  // directly (not through parseFleetLock's schema-tolerant re-validation),
  // so this is the strongest possible pin against `orderedAgent` silently
  // dropping `repo` before the write — the exact #1260 defect the issue
  // cites. Mutation check performed manually: deleting the `ordered.repo =
  // agent.repo;` line in `orderedAgent` (fleet-lock.ts) makes this test
  // fail (raw parsed JSON has no "repo" key), confirming it is NOT
  // satisfiable by a composer-altitude assertion alone.
  it('DECISIVE: agent repo reaches the WRITTEN FILE on disk, readable as a raw "repo" key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-lock-test-'));
    try {
      const path = join(dir, 'fleet.lock');
      const { lock } = composeFleetLock({
        fleet: 'demo-fleet',
        previous: null,
        agentUpdates: { 'code-agent': { appId: '1', installId: '2', repo: 'groundnuty/demo-code-agent' } },
      });
      writeFleetLock(path, lock);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { agents: { role: string; repo?: string }[] };
      const codeAgent = raw.agents.find((a) => a.role === 'code-agent');
      expect(codeAgent?.repo).toBe('groundnuty/demo-code-agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a lock predating the field writes NO "repo" key at all (never a fabricated empty string) — the pre-#1296 shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-lock-test-'));
    try {
      const path = join(dir, 'fleet.lock');
      const { lock } = composeFleetLock({
        fleet: 'demo-fleet',
        previous: null,
        agentUpdates: { 'code-agent': { appId: '1', installId: '2' } },
      });
      writeFleetLock(path, lock);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { agents: Record<string, unknown>[] };
      expect('repo' in (raw.agents[0] ?? {})).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // groundnuty/macf#1330 DECISIVE — same "assert the WRITTEN FILE, not the
  // composer's return value" discipline the two tests immediately above
  // (and #1296's/#1310's own decisive tests) establish, applied to the new
  // federated `collaborators` field. Reads the RAW JSON bytes off disk
  // directly (not through `parseFleetLock`'s schema-tolerant re-validation)
  // — the strongest possible pin against `serializeFleetLock`'s hand-built
  // `ordered` allowlist silently dropping `collaborators` before the write,
  // the exact #1260/#1328 defect shape `#1330`'s own AC names. Mutation
  // check performed manually: commenting out the
  // `if (validated.collaborators !== undefined) { ordered.collaborators = ... }`
  // block in `serializeFleetLock` (fleet-lock.ts) makes this test fail (raw
  // parsed JSON has no "collaborators" key) — confirmed the same way as the
  // #1310 precedent immediately below.
  it('DECISIVE: a federated collaborator reaches the WRITTEN FILE on disk under "collaborators", readable as a raw key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-lock-test-'));
    try {
      const path = join(dir, 'fleet.lock');
      const { lock } = composeFleetLock({
        fleet: 'demo-fleet',
        previous: null,
        agentUpdates: {},
        collaboratorRecipients: [{ project: 'ppam-2026', ageRecipients: ['age1a', 'age1b'] }],
      });
      writeFleetLock(path, lock);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { collaborators?: { project: string; age_recipients: string[] }[] };
      expect(raw.collaborators).toEqual([{ project: 'ppam-2026', age_recipients: ['age1a', 'age1b'] }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a lock recording no federated collaborators writes NO "collaborators" key at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-lock-test-'));
    try {
      const path = join(dir, 'fleet.lock');
      const { lock } = composeFleetLock({
        fleet: 'demo-fleet',
        previous: null,
        agentUpdates: { 'code-agent': { appId: '1', installId: '2' } },
      });
      writeFleetLock(path, lock);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      expect('collaborators' in raw).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // groundnuty/macf#1389 DECISIVE — same "assert the WRITTEN FILE, not the
  // composer's return value" discipline the `collaborators` decisive test
  // immediately above establishes, applied to the new `federated_ca_trust`
  // field. Reads the RAW JSON bytes off disk directly (not through
  // `parseFleetLock`'s schema-tolerant re-validation) — the strongest
  // possible pin against `serializeFleetLock`'s hand-built `ordered`
  // allowlist silently dropping `federated_ca_trust` before the write.
  // Mutation check performed manually: commenting out the
  // `if (validated.federated_ca_trust !== undefined) { ordered.federated_ca_trust = ... }`
  // block in `serializeFleetLock` (fleet-lock.ts) makes this test fail (raw
  // parsed JSON has no "federated_ca_trust" key).
  it('DECISIVE: a federated-CA-trust fingerprint reaches the WRITTEN FILE on disk under "federated_ca_trust", readable as a raw key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-lock-test-'));
    try {
      const path = join(dir, 'fleet.lock');
      const { lock } = composeFleetLock({
        fleet: 'demo-fleet',
        previous: null,
        agentUpdates: {},
        federatedCaTrust: [{ project: 'ppam-2026', caBundleFingerprint: 'sha256:aaa' }],
      });
      writeFleetLock(path, lock);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { federated_ca_trust?: { project: string; ca_bundle_fingerprint: string }[] };
      expect(raw.federated_ca_trust).toEqual([{ project: 'ppam-2026', ca_bundle_fingerprint: 'sha256:aaa' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a lock recording no federated-CA trust writes NO "federated_ca_trust" key at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-lock-test-'));
    try {
      const path = join(dir, 'fleet.lock');
      const { lock } = composeFleetLock({
        fleet: 'demo-fleet',
        previous: null,
        agentUpdates: { 'code-agent': { appId: '1', installId: '2' } },
      });
      writeFleetLock(path, lock);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      expect('federated_ca_trust' in raw).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // groundnuty/macf#1310 DECISIVE — same "assert the WRITTEN FILE, not the
  // composer's return value" discipline #1296's own decisive test above
  // established, applied to the fleet-level rename: (1) a lock composed
  // over a PRIOR lock still on the deprecated `fingerprints` key reaches
  // disk under the NEW `fleet_fingerprints` key, with the legacy key
  // ABSENT from the raw bytes (never both at once). This is the test the
  // brief's own mutation check targets: dropping `ordered.fleet_fingerprints
  // = ...` from `serializeFleetLock` (fleet-lock.ts) makes this fail (raw
  // parsed JSON has no "fleet_fingerprints" key) — confirmed manually,
  // matching the #1296 precedent's own verification style. A composer-
  // altitude assertion on `composeFleetLock`'s return value would NOT
  // catch that mutation (`composeFleetLock` already produces the right
  // field; the drop happens in `serializeFleetLock`'s own hand-built
  // allowlist) — the exact #1260 defect shape this issue's own AC names.
  it('DECISIVE: a fleet-level fingerprint reaches the WRITTEN FILE on disk under "fleet_fingerprints", migrated off a prior "fingerprints"-keyed lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-lock-test-'));
    try {
      const path = join(dir, 'fleet.lock');
      const priorOnLegacyKey: FleetLock = {
        schema_version: 1,
        fleet: 'demo-fleet',
        agents: [],
        fingerprints: { ca_key: secretFingerprint('old-ca-key') },
      };
      const { lock } = composeFleetLock({
        fleet: 'demo-fleet',
        previous: priorOnLegacyKey,
        agentUpdates: {},
      });
      writeFleetLock(path, lock);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      expect(raw['fleet_fingerprints']).toEqual({ ca_key: secretFingerprint('old-ca-key') });
      expect('fingerprints' in raw).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // groundnuty/macf#1310 — the whole point of the rename: the two
  // `fingerprints` STRUCTURES (fleet-level, now `fleet_fingerprints`; and
  // per-agent, still `agents[i].fingerprints`) must never be mistaken for
  // one another even when a fleet has BOTH populated with disjoint key
  // sets. Asserted explicitly against the raw written bytes.
  it('neither fingerprints structure is mistaken for the other on disk — fleet-level and per-agent stay on separate keys with disjoint values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-fleet-lock-test-'));
    try {
      const path = join(dir, 'fleet.lock');
      const { lock } = composeFleetLock({
        fleet: 'demo-fleet',
        previous: null,
        agentUpdates: { 'code-agent': { appId: '1', installId: '2', secrets: { client_secret: 'agent-secret' } } },
        fleetSecrets: { ca_key: 'fleet-ca-pem' },
      });
      writeFleetLock(path, lock);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
        fleet_fingerprints?: Record<string, string>;
        agents: { role: string; fingerprints?: Record<string, string> }[];
      };
      expect(raw.fleet_fingerprints).toEqual({ ca_key: secretFingerprint('fleet-ca-pem') });
      expect(raw.agents[0]?.fingerprints).toEqual({ client_secret: secretFingerprint('agent-secret') });
      // Disjoint key SETS and disjoint VALUES — no cross-contamination.
      expect(raw.fleet_fingerprints).not.toEqual(raw.agents[0]?.fingerprints);
      expect('fingerprints' in raw).toBe(false); // the legacy top-level key never appears
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
