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
