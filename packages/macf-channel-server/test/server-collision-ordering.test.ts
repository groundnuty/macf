/**
 * Source-shape TRIPWIRE for the takeover-after-serve ordering
 * (groundnuty/macf#424, science-agent design assumption 2).
 *
 * Version-aware takeover lets a newer instance displace an alive older one —
 * so it's critical that a newer-but-broken instance can't take the slot and
 * then fail to serve. The guarantee is structural in `server.ts main()`: the
 * registry write (the "take the slot" action) happens only AFTER the HTTPS
 * server has bound + is serving AND after the collision check:
 *
 *     P1  httpsServer.start(...)   ← bind + serve; throws here ⟹ never registers
 *     P2  checkCollision(...)      ← decide register / takeover / abort
 *     P2  registry.register(...)   ← take the slot
 *
 * A crash-on-boot never reaches checkCollision/register, so it never strands
 * the slot. **Scope caveat (per #438 review):** this asserts only the TEXTUAL
 * source ORDER of the three calls (`indexOf`), not the runtime invariant — it
 * would NOT catch a dropped `await` on `httpsServer.start` (fire-and-forget
 * bind) or an early `register` path on a different branch. It's a cheap
 * regression tripwire (same source-shape approach as a2a-response-headers.test
 * + the macf#347 regression test) for the common refactor that physically
 * reorders the calls; the runtime guarantee rests on the awaited
 * `httpsServer.start` at the call site, not on this test. A full runtime
 * assertion would need a server-startup harness (none exists yet).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVER_SOURCE = readFileSync(resolve(__dirname, '../src/server.ts'), 'utf-8');

describe('server.ts collision/serve/register ordering (macf#424 assumption 2)', () => {
  it('binds + serves (httpsServer.start) before the collision check', () => {
    const startIdx = SERVER_SOURCE.indexOf('httpsServer.start(');
    const checkIdx = SERVER_SOURCE.indexOf('checkCollision(');
    expect(startIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeLessThan(checkIdx);
  });

  it('writes the registry slot (registry.register) only AFTER the collision check', () => {
    const checkIdx = SERVER_SOURCE.indexOf('checkCollision(');
    const registerIdx = SERVER_SOURCE.indexOf('registry.register(');
    expect(registerIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(registerIdx);
  });

  it('passes PACKAGE_VERSION as the incoming version to checkCollision', () => {
    // The collision check must compare the running instance's actual version.
    const checkBlock = SERVER_SOURCE.slice(
      SERVER_SOURCE.indexOf('checkCollision('),
      SERVER_SOURCE.indexOf('checkCollision(') + 400,
    );
    expect(checkBlock).toContain('PACKAGE_VERSION');
  });
});
