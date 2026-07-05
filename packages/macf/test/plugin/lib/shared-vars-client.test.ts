import { describe, it, expect } from 'vitest';
import type { RegistryConfig } from '@groundnuty/macf-core';
import { buildSharedVarsClient } from '../../../src/plugin/lib/shared-vars-client.js';

describe('buildSharedVarsClient (DR-041 Amendment B, groundnuty/macf#794)', () => {
  it('returns undefined for local-registry mode (no shared GitHub-Variables registry)', () => {
    const config: RegistryConfig = { type: 'local', path: '/tmp/does-not-matter.json' };
    expect(buildSharedVarsClient(config, 'token')).toBeUndefined();
  });

  it('returns a defined client for org mode', () => {
    const config: RegistryConfig = { type: 'org', org: 'groundnuty' };
    const client = buildSharedVarsClient(config, 'token');
    expect(client).toBeDefined();
    expect(typeof client?.readVariable).toBe('function');
  });

  it('returns a defined client for profile mode', () => {
    const config: RegistryConfig = { type: 'profile', user: 'someuser' };
    const client = buildSharedVarsClient(config, 'token');
    expect(client).toBeDefined();
    expect(typeof client?.readVariable).toBe('function');
  });

  it('returns a defined client for repo mode', () => {
    const config: RegistryConfig = { type: 'repo', owner: 'groundnuty', repo: 'macf' };
    const client = buildSharedVarsClient(config, 'token');
    expect(client).toBeDefined();
    expect(typeof client?.readVariable).toBe('function');
  });
});
