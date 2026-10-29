/**
 * #1525 wiring tripwire: `main()` must run the lead check before any port
 * bind, token refresh or registry call, and must exit on `skip`. The check
 * has unit tests; they cannot see whether `main()` calls it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../src/server.ts'), 'utf-8');
const mainBody = SRC.slice(SRC.indexOf('async function main()'));

describe('server.ts main() runs the lead check first (#1525)', () => {
  it('calls checkIsLead and exits on skip', () => {
    expect(mainBody).toMatch(/const lead = checkIsLead\(config\.workspaceDir,\s*systemLeadCheckDeps\(\)\)/);
    expect(mainBody).toMatch(/lead\.action === 'skip'[\s\S]{0,200}process\.exit\(0\)/);
  });

  it('runs before the first token refresh, registry call or port bind', () => {
    const at = mainBody.indexOf('checkIsLead(');
    expect(at).toBeGreaterThan(-1);
    for (const needle of ['createTokenRefresher(', 'createRegistryFromConfig(', 'createRegistry(', 'checkCollision(', 'createHttpsServer(']) {
      const i = mainBody.indexOf(needle);
      expect(i, needle).toBeGreaterThan(at);
    }
  });
});
