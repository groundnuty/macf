/**
 * Source-shape regression guard for DR-036 Amendment A (groundnuty/macf#679):
 * the `/macf-peers` backing (`macf-plugin-cli.ts` `peers` case) MUST render the
 * same GUEST / external-collaborators block as `macf fleet status`. The block
 * rendering itself is unit-tested in `test/cli/fleet-guests.test.ts`; this pins
 * that the plugin `peers` path actually wires it (the main() is env/network-heavy
 * to run directly, so a source-shape check is the pragmatic regression guard —
 * same posture as the #347 commander-flag static test).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSrc = readFileSync(join(repoRoot, 'src', 'plugin', 'bin', 'macf-plugin-cli.ts'), 'utf-8');

describe('macf-plugin-cli peers — GUEST block wiring (#679)', () => {
  it('imports the shared guest helpers from fleet-guests', () => {
    expect(cliSrc).toMatch(/from '\.\.\/\.\.\/cli\/commands\/fleet-guests\.js'/);
    expect(cliSrc).toContain('loadGuestBindings');
    expect(cliSrc).toContain('gatherGuestStatuses');
    expect(cliSrc).toContain('formatGuestBlock');
  });

  it('loads guests + renders the block inside the peers case', () => {
    // The peers case (between `case 'peers'` and the next `case`) must load +
    // render guests.
    const peersCase = cliSrc.slice(cliSrc.indexOf("case 'peers'"), cliSrc.indexOf("case 'ping'"));
    expect(peersCase).toContain('loadGuestBindings');
    expect(peersCase).toContain('formatGuestBlock');
  });
});

/**
 * DR-041 Amendment A (groundnuty/macf#786): `macf-ping` resolves a
 * `<project>/<name>` cross-fleet guest slug via the SAME unified ladder
 * `notify_peer` / outbound A2A use (`resolveGuestAddress`, macf-core), gated
 * on `federated_cas` — never the `guests` binding. Same source-shape wiring-
 * guard posture as the `peers` block above (`main()` is env/network-heavy).
 */
describe('macf-plugin-cli ping — cross-fleet guest addressing wiring (#786)', () => {
  function pingCaseSource(): string {
    const start = cliSrc.indexOf("case 'ping'");
    const end = cliSrc.indexOf("case 'issues'");
    return cliSrc.slice(start, end);
  }

  it('imports the shared macf-core guest-resolution ladder', () => {
    expect(cliSrc).toContain("import { resolveGuestAddress } from '@groundnuty/macf-core'");
    expect(cliSrc).toContain('CrossProjectAgentResolver');
  });

  it('imports loadFederatedCas from the shared fleet-guests module (NOT the guests binding)', () => {
    expect(cliSrc).toMatch(/from '\.\.\/\.\.\/cli\/commands\/fleet-guests\.js'/);
    expect(cliSrc).toContain('loadFederatedCas');
  });

  it('the ping case calls resolveGuestAddress gated on federatedCas, not loadGuestBindings', () => {
    const pingCase = pingCaseSource();
    expect(pingCase).toContain('loadFederatedCas');
    expect(pingCase).toContain('resolveGuestAddress');
    // The addressing gate is federated_cas alone (DR-041 Amendment A decision
    // 1) — the ping case must NOT consult the `guests` binding loader.
    expect(pingCase).not.toContain('loadGuestBindings');
  });

  it('the ping case handles all 3 ladder outcomes distinctly (resolved / not-a-guest-ref / error rungs)', () => {
    const pingCase = pingCaseSource();
    expect(pingCase).toContain("guestResolution.kind === 'resolved'");
    expect(pingCase).toContain("guestResolution.kind === 'not-a-guest-ref'");
    // The not-federated / not-found rungs share the else-branch printing
    // `guestResolution.error` — assert the clear-error surface is wired.
    expect(pingCase).toContain('guestResolution.error');
  });

  it('falls through to the existing sanitized-name registry lookup on rung 4 (own-project, unchanged)', () => {
    const pingCase = pingCaseSource();
    expect(pingCase).toContain('toVariableSegment(targetName)');
    expect(pingCase).toContain('listPeers(registry)');
  });
});
