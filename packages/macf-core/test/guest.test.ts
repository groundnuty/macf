/**
 * Tests for the cross-fleet GUEST binding schema (DR-036 Amendment A,
 * groundnuty/macf#679): `.github/macf-fleet.json` guests + the `routing_fleet`
 * marker, plus the `<home-project>/<name>` agent-ref parser.
 */
import { describe, it, expect } from 'vitest';
import {
  GuestBindingSchema,
  MacfFleetConfigSchema,
  parseMacfFleetConfig,
  parseGuestAgentRef,
  GuestConfigError,
  type GuestBinding,
} from '../src/guest.js';

const validGuest: GuestBinding = {
  agent: 'ppam-2026/code-agent',
  local_role: 'onedata-specialist',
  purpose: 'data-access dependency (onedata-mcp)',
  delegate_via: 'route',
  until: null,
};

describe('GuestBindingSchema', () => {
  it('accepts a well-formed binding', () => {
    const r = GuestBindingSchema.safeParse(validGuest);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.agent).toBe('ppam-2026/code-agent');
  });

  it('accepts operator-relay + defaults `until` to null when absent', () => {
    const r = GuestBindingSchema.safeParse({
      agent: 'ppam-2026/code-agent',
      local_role: 'onedata-specialist',
      purpose: 'data dep',
      delegate_via: 'operator-relay',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.until).toBeNull();
  });

  it('rejects an agent ref without exactly one slash', () => {
    for (const agent of ['code-agent', 'a/b/c', '/code-agent', 'ppam-2026/']) {
      const r = GuestBindingSchema.safeParse({ ...validGuest, agent });
      expect(r.success, `agent="${agent}" should be rejected`).toBe(false);
    }
  });

  it('rejects an unknown delegate_via', () => {
    const r = GuestBindingSchema.safeParse({ ...validGuest, delegate_via: 'b2-live-push' });
    expect(r.success).toBe(false);
  });

  it('rejects an empty local_role / purpose', () => {
    expect(GuestBindingSchema.safeParse({ ...validGuest, local_role: '' }).success).toBe(false);
    expect(GuestBindingSchema.safeParse({ ...validGuest, purpose: '' }).success).toBe(false);
  });
});

describe('MacfFleetConfigSchema', () => {
  it('defaults guests to [] for a routing_fleet-only marker', () => {
    const r = MacfFleetConfigSchema.safeParse({ routing_fleet: false });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.guests).toEqual([]);
      expect(r.data.routing_fleet).toBe(false);
    }
  });

  it('parses guests + strips unknown additive keys', () => {
    const r = MacfFleetConfigSchema.safeParse({
      guests: [validGuest],
      some_future_key: 'ignored',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.guests).toHaveLength(1);
      expect((r.data as Record<string, unknown>)['some_future_key']).toBeUndefined();
    }
  });

  it('defaults guests to [] for an empty object', () => {
    const r = MacfFleetConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.guests).toEqual([]);
  });

  // DR-041 Decision 1 (macf#784): federated_cas — cross-fleet CA trust bundle.
  it('defaults federated_cas to [] when absent', () => {
    const r = MacfFleetConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.federated_cas).toEqual([]);
  });

  it('parses a federated_cas array of project identifiers', () => {
    const r = MacfFleetConfigSchema.safeParse({ federated_cas: ['ppam-2026', 'icsoc-2026'] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.federated_cas).toEqual(['ppam-2026', 'icsoc-2026']);
  });

  it('rejects a non-string entry in federated_cas', () => {
    const r = MacfFleetConfigSchema.safeParse({ federated_cas: [123] });
    expect(r.success).toBe(false);
  });

  it('federated_cas + guests coexist independently', () => {
    const r = MacfFleetConfigSchema.safeParse({ guests: [validGuest], federated_cas: ['ppam-2026'] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.guests).toHaveLength(1);
      expect(r.data.federated_cas).toEqual(['ppam-2026']);
    }
  });
});

describe('parseMacfFleetConfig', () => {
  it('returns the parsed config on valid input', () => {
    const cfg = parseMacfFleetConfig({ guests: [validGuest] });
    expect(cfg.guests[0]!.local_role).toBe('onedata-specialist');
  });

  it('throws GuestConfigError with the offending path on invalid input', () => {
    expect(() => parseMacfFleetConfig({ guests: [{ ...validGuest, agent: 'nope' }] })).toThrow(
      GuestConfigError,
    );
    try {
      parseMacfFleetConfig({ guests: [{ ...validGuest, agent: 'nope' }] });
    } catch (e) {
      expect((e as GuestConfigError).code).toBe('GUEST_CONFIG_ERROR');
      expect((e as Error).message).toMatch(/guests\.0\.agent/);
    }
  });
});

describe('parseGuestAgentRef', () => {
  it('splits <home-project>/<name>', () => {
    expect(parseGuestAgentRef('ppam-2026/code-agent')).toEqual({
      homeProject: 'ppam-2026',
      name: 'code-agent',
    });
  });

  it('throws for a malformed ref', () => {
    expect(() => parseGuestAgentRef('code-agent')).toThrow(GuestConfigError);
    expect(() => parseGuestAgentRef('a/b/c')).toThrow(GuestConfigError);
    expect(() => parseGuestAgentRef('ppam-2026/')).toThrow(GuestConfigError);
  });
});
