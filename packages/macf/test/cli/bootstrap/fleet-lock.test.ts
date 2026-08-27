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

  it('fleet-level fingerprints merge the same way: prior CA key fingerprint preserved, new fleet secret added', () => {
    const { lock } = composeFleetLock({
      fleet: 'demo-fleet',
      previous,
      agentUpdates: {},
      fleetSecrets: { routing_app_key: 'routing-pem' },
    });
    expect(lock.fingerprints).toEqual({
      ca_key: secretFingerprint('old-ca-key'),
      routing_app_key: secretFingerprint('routing-pem'),
    });
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

describe('serializeFleetLock', () => {
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
      fingerprints: Record<string, string>;
    };
    expect(parsed.agents.map((a) => a.role)).toEqual(['code-agent', 'science-agent']);
    expect(Object.keys(parsed.agents[0]?.fingerprints ?? {})).toEqual([]);
    expect(Object.keys(parsed.agents[1]?.fingerprints ?? {})).toEqual(['a_secret', 'z_secret']);
    expect(Object.keys(parsed.fingerprints)).toEqual(['a_key', 'z_key']);
  });

  it('is idempotent: serializing twice from the same input produces byte-identical output', () => {
    expect(serializeFleetLock(lock)).toBe(serializeFleetLock(lock));
  });

  it('round-trips through parseFleetLock unchanged', () => {
    const roundTripped = parseFleetLock(serializeFleetLock(lock));
    expect(roundTripped.fleet).toBe(lock.fleet);
    expect(roundTripped.agents).toHaveLength(2);
    expect(roundTripped.fingerprints).toEqual({ a_key: 'sha256:aa', z_key: 'sha256:zz' });
  });

  it('omits versions/fingerprints keys entirely when absent (never emits an empty {} placeholder)', () => {
    const minimal: FleetLock = { schema_version: 1, fleet: 'x', agents: [] };
    const parsed = JSON.parse(serializeFleetLock(minimal)) as Record<string, unknown>;
    expect('versions' in parsed).toBe(false);
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
});
