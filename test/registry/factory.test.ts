import { describe, it, expect, vi } from 'vitest';
import { createRegistryFromConfig } from '../../src/registry/factory.js';

// Mock the underlying modules
vi.mock('../../src/registry/github-client.js', () => ({
  createGitHubClient: vi.fn().mockReturnValue({
    writeVariable: vi.fn(),
    readVariable: vi.fn(),
    listVariables: vi.fn(),
    deleteVariable: vi.fn(),
  }),
}));

const { createGitHubClient } = await import('../../src/registry/github-client.js');

describe('createRegistryFromConfig', () => {
  it('creates org registry with correct path prefix', () => {
    createRegistryFromConfig({ type: 'org', org: 'my-org' }, 'MACF', 'token');

    expect(createGitHubClient).toHaveBeenCalledWith('/orgs/my-org', 'token');
  });

  it('creates profile registry with user/user path prefix', () => {
    createRegistryFromConfig({ type: 'profile', user: 'groundnuty' }, 'MACF', 'token');

    expect(createGitHubClient).toHaveBeenCalledWith('/repos/groundnuty/groundnuty', 'token');
  });

  it('creates repo registry with owner/repo path prefix', () => {
    createRegistryFromConfig(
      { type: 'repo', owner: 'groundnuty', repo: 'macf' },
      'MACF',
      'token',
    );

    expect(createGitHubClient).toHaveBeenCalledWith('/repos/groundnuty/macf', 'token');
  });

  it('returns a Registry with standard interface methods', () => {
    const registry = createRegistryFromConfig(
      { type: 'repo', owner: 'o', repo: 'r' },
      'TEST',
      'tok',
    );

    expect(typeof registry.register).toBe('function');
    expect(typeof registry.get).toBe('function');
    expect(typeof registry.list).toBe('function');
    expect(typeof registry.remove).toBe('function');
  });
});
