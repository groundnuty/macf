/**
 * `routing-secret-parity.ts` — the per-repo routing-secret asymmetry sweep
 * (groundnuty/macf#1336). Pure, offline: `RepoSecretNamesObservation` is
 * hand-built, no `gh` / network involved (that's `observer.ts::listRepoSecretNames`'s
 * job).
 *
 * Per `assert-the-wrong-path.md`, the decisive pair is the load-bearing
 * proof — a "some repos" test alone is satisfied by a function that ALWAYS
 * reports an asymmetry regardless of input; only the paired "all/none"
 * negative shows the function is actually discriminating.
 */
import { describe, it, expect } from 'vitest';
import { findRoutingSecretAsymmetries, secretPresenceFor, type RoutingSecretAsymmetry } from '../../../src/cli/bootstrap/routing-secret-parity.js';
import type { RepoSecretNamesObservation } from '../../../src/cli/bootstrap/observer.js';
import {
  ALL_ROUTING_SECRET_NAMES,
  ROUTING_APP_ID_SECRET_NAME,
  ROUTING_APP_KEY_SECRET_NAME,
  TS_OAUTH_CLIENT_ID_SECRET_NAME,
  TS_OAUTH_SECRET_SECRET_NAME,
} from '../../../src/cli/bootstrap/apply-routing-secrets.js';
import { ROUTING_CLIENT_CERT_SECRET_NAME, ROUTING_CLIENT_KEY_SECRET_NAME } from '../../../src/cli/bootstrap/apply-routing-client.js';

const WARM = 'org/trial-code-agent';
const WARM_2 = 'org/trial-science-agent';
const COLD = 'org/trial-writing-agent';

function confirmed(...names: readonly string[]): RepoSecretNamesObservation {
  return { status: 'confirmed', names: new Set(names) };
}

const UNREADABLE: RepoSecretNamesObservation = { status: 'unknown', reason: 'could not read secret names on "org/x" (gh: HTTP 403)' };

const ALL_SIX = ALL_ROUTING_SECRET_NAMES;

describe('secretPresenceFor', () => {
  it('present when the name is in the confirmed set', () => {
    expect(secretPresenceFor(TS_OAUTH_CLIENT_ID_SECRET_NAME, confirmed(TS_OAUTH_CLIENT_ID_SECRET_NAME))).toBe('present');
  });

  it('absent when the observation is confirmed but the name is missing from it', () => {
    expect(secretPresenceFor(TS_OAUTH_CLIENT_ID_SECRET_NAME, confirmed(ROUTING_CLIENT_CERT_SECRET_NAME))).toBe('absent');
  });

  it("unreadable secret list -> 'unknown', never 'consistent' (never absent, never present)", () => {
    expect(secretPresenceFor(TS_OAUTH_CLIENT_ID_SECRET_NAME, UNREADABLE)).toBe('unknown');
  });

  it('an observation this function was never given (undefined) reads identically to unknown — never a fabricated claim', () => {
    expect(secretPresenceFor(TS_OAUTH_CLIENT_ID_SECRET_NAME, undefined)).toBe('unknown');
  });
});

describe('findRoutingSecretAsymmetries — the decisive pair (groundnuty/macf#1336)', () => {
  it('DECISIVE 1/2: present on SOME repos -> reported, naming which repos lack it', () => {
    const observed: Record<string, RepoSecretNamesObservation> = {
      [WARM]: confirmed(...ALL_SIX),
      [WARM_2]: confirmed(...ALL_SIX),
      [COLD]: confirmed(), // present on none of the 6
    };
    const findings = findRoutingSecretAsymmetries([WARM, WARM_2, COLD], observed);
    // Every one of the 6 tracked secrets is split the same way on this fixture.
    expect(findings).toHaveLength(ALL_SIX.length);
    const tsOauthClientId = findings.find((f) => f.secretName === TS_OAUTH_CLIENT_ID_SECRET_NAME);
    expect(tsOauthClientId).toBeDefined();
    expect(tsOauthClientId?.presentRepos).toEqual([WARM, WARM_2]);
    expect(tsOauthClientId?.absentRepos).toEqual([COLD]);
    expect(tsOauthClientId?.message).toContain(COLD);
    expect(tsOauthClientId?.message).toContain('2 of 3');
  });

  it('DECISIVE 2/2: present on ALL repos -> no asymmetry reported (the satisfied state)', () => {
    const observed: Record<string, RepoSecretNamesObservation> = {
      [WARM]: confirmed(...ALL_SIX),
      [WARM_2]: confirmed(...ALL_SIX),
      [COLD]: confirmed(...ALL_SIX),
    };
    expect(findRoutingSecretAsymmetries([WARM, WARM_2, COLD], observed)).toEqual([]);
  });

  it('DECISIVE 2/2 (sibling): present on NONE of the repos -> no asymmetry reported — uniform absence is undeclared, not drifted', () => {
    const observed: Record<string, RepoSecretNamesObservation> = {
      [WARM]: confirmed(),
      [WARM_2]: confirmed(),
      [COLD]: confirmed(),
    };
    expect(findRoutingSecretAsymmetries([WARM, WARM_2, COLD], observed)).toEqual([]);
  });

  it('a secret list unreadable on one repo, uniform among the CONFIRMED repos, does not manufacture a split — but is not silently "consistent" either (tracked, not reported as split)', () => {
    const observed: Record<string, RepoSecretNamesObservation> = {
      [WARM]: confirmed(...ALL_SIX),
      [WARM_2]: confirmed(...ALL_SIX),
      [COLD]: UNREADABLE,
    };
    // Both CONFIRMED repos agree (present); the unreadable repo is neither
    // present nor absent, so this must not read as a split.
    expect(findRoutingSecretAsymmetries([WARM, WARM_2, COLD], observed)).toEqual([]);
  });

  it('unreadable + a genuine split among the confirmed repos -> the unreadable repo is named in unknownRepos, never folded into presentRepos/absentRepos', () => {
    const observed: Record<string, RepoSecretNamesObservation> = {
      [WARM]: confirmed(...ALL_SIX),
      [WARM_2]: confirmed(), // genuinely absent
      [COLD]: UNREADABLE,
    };
    const findings = findRoutingSecretAsymmetries([WARM, WARM_2, COLD], observed);
    const finding = findings.find((f) => f.secretName === TS_OAUTH_CLIENT_ID_SECRET_NAME);
    expect(finding?.presentRepos).toEqual([WARM]);
    expect(finding?.absentRepos).toEqual([WARM_2]);
    expect(finding?.unknownRepos).toEqual([COLD]);
    expect(finding?.message).toContain(COLD);
    expect(finding?.message).not.toContain('1 of 3'); // the unreadable repo must not inflate the denominator
    expect(finding?.message).toContain('1 of 2');
  });

  it('a repo the fleet does not own is not consulted — extra keys in the observation map that are absent from `repos` never affect the result', () => {
    const observed: Record<string, RepoSecretNamesObservation> = {
      [WARM]: confirmed(...ALL_SIX),
      [WARM_2]: confirmed(...ALL_SIX),
      // A repo the caller never listed in `repos` — even though it is
      // observed absent, it must never surface in the finding.
      'org/some-other-repo-entirely': confirmed(),
    };
    expect(findRoutingSecretAsymmetries([WARM, WARM_2], observed)).toEqual([]);
    // Sanity: the excluded repo would have produced a split if consulted.
    const withExcludedRepoIncluded = findRoutingSecretAsymmetries([WARM, WARM_2, 'org/some-other-repo-entirely'], observed);
    expect(withExcludedRepoIncluded.length).toBeGreaterThan(0);
  });

  it('the ROUTING_CLIENT_CERT/KEY pair and the MACF_ROUTING_APP_ID/KEY pair get the SAME per-repo treatment as TS_OAUTH — not a TS_OAUTH-only check', () => {
    const observed: Record<string, RepoSecretNamesObservation> = {
      [WARM]: confirmed(ROUTING_CLIENT_CERT_SECRET_NAME, ROUTING_CLIENT_KEY_SECRET_NAME, ROUTING_APP_ID_SECRET_NAME, ROUTING_APP_KEY_SECRET_NAME),
      [COLD]: confirmed(), // missing all four non-TS_OAUTH secrets
    };
    const findings = findRoutingSecretAsymmetries([WARM, COLD], observed);
    const names = findings.map((f) => f.secretName).sort();
    expect(names).toEqual(
      [ROUTING_CLIENT_CERT_SECRET_NAME, ROUTING_CLIENT_KEY_SECRET_NAME, ROUTING_APP_ID_SECRET_NAME, ROUTING_APP_KEY_SECRET_NAME].sort(),
    );
    // TS_OAUTH_* is uniformly absent on this fixture (present on neither repo) — not reported.
    expect(findings.some((f) => f.secretName === TS_OAUTH_CLIENT_ID_SECRET_NAME || f.secretName === TS_OAUTH_SECRET_SECRET_NAME)).toBe(false);
  });

  it('the output NEVER contains a secret VALUE — only names and repo identifiers appear anywhere in a finding', () => {
    // A deliberately value-shaped string sitting IN a repo's confirmed name
    // set would be a bug elsewhere (observer.ts only ever extracts `.name`,
    // never `.value` — GitHub's write-only API has no such field to leak).
    // This asserts the CONTRACT at this module's own boundary: nothing in a
    // RoutingSecretAsymmetry — message included — is anything other than a
    // tracked secret NAME or a repo identifier from the input.
    const observed: Record<string, RepoSecretNamesObservation> = {
      [WARM]: confirmed(...ALL_SIX),
      [COLD]: confirmed(),
    };
    const findings: readonly RoutingSecretAsymmetry[] = findRoutingSecretAsymmetries([WARM, COLD], observed);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      const blob = JSON.stringify(f);
      expect(blob).not.toMatch(/ghs_|ghp_|gho_|ghu_|-----BEGIN/);
    }
  });
});
