/**
 * macf#639 wiring tripwire: `server.ts` must type the tmux copy only through
 * the wake router, so a registered channel suppresses it. The router and the
 * registration reader have their own tests (`channel-registration.test.ts`);
 * those cannot see whether `deliverNotification` actually calls the router,
 * because it is closed over inside `main()`. Without this test, restoring a
 * direct `wakeViaTmux(...)` call would pass the suite and bring back the
 * double delivery. Same source-shape approach as `server-collision-ordering`;
 * the live proof is a `delivery_path` line in `channel.log`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVER_SOURCE = readFileSync(resolve(__dirname, '../src/server.ts'), 'utf-8');

describe('server.ts routes the tmux wake through the registration check (macf#639)', () => {
  it('builds the router from the channel-registration reader', () => {
    expect(SERVER_SOURCE).toMatch(/createWakeRouter\(\s*\{[\s\S]*?read:\s*\(\)\s*=>\s*readChannelRegistration\(/);
  });

  it('calls wakeViaTmux exactly once, and only inside a routeWake(...) callback', () => {
    const calls = SERVER_SOURCE.match(/wakeViaTmux\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(SERVER_SOURCE).toMatch(/routeWake\(\s*\(\)\s*=>\s*\{\s*void wakeViaTmux\(/);
  });
});
