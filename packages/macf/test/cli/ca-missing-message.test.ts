import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CA_NOT_IN_REGISTRY_MESSAGE } from '../../src/cli/registry-helper.js';

const SITES = [
  'commands/registry-prune.ts',
  'commands/fleet.ts',
  'fleet/vm-driver.ts',
  'commands/fleet-doctor.ts',
  'commands/status.ts',
];
const SRC = join(__dirname, '../../src/cli');

describe('CA-not-in-registry message', () => {
  it('names bootstrap apply for a deactivated fleet and certs init for a new one', () => {
    expect(CA_NOT_IN_REGISTRY_MESSAGE).toContain('`macf bootstrap apply`');
    expect(CA_NOT_IN_REGISTRY_MESSAGE).toContain('`macf certs init`');
  });

  it.each(SITES)('%s uses the shared constant, not a literal', (site) => {
    const src = readFileSync(join(SRC, site), 'utf8');
    expect(src).toContain('CA_NOT_IN_REGISTRY_MESSAGE');
    expect(src).not.toContain('CA certificate not found in registry');
  });

  it('no source file carries the old remedy text', () => {
    const all = SITES.map((s) => readFileSync(join(SRC, s), 'utf8')).join('\n');
    expect(all).not.toContain('Run `macf certs init` first');
  });
});
