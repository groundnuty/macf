import { describe, it, expect, vi } from 'vitest';
import { getOwnRegistration, listPeers } from '../../../src/plugin/lib/registry.js';
import type { Registry, AgentInfo } from '../../../src/registry/types.js';

const sampleInfo: AgentInfo = {
  host: '100.86.5.117',
  port: 8847,
  type: 'permanent',
  instance_id: 'a1b2c3',
  started: '2026-03-28T18:00:00Z',
};

function mockRegistry(getResult: AgentInfo | null = null, listResult: Array<{ name: string; info: AgentInfo }> = []): Registry {
  return {
    register: vi.fn(),
    get: vi.fn().mockResolvedValue(getResult),
    list: vi.fn().mockResolvedValue(listResult),
    remove: vi.fn(),
  };
}

describe('getOwnRegistration', () => {
  it('returns own registration when found', async () => {
    const registry = mockRegistry(sampleInfo);
    const result = await getOwnRegistration('code-agent', registry);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('code-agent');
    expect(result!.info.port).toBe(8847);
  });

  it('returns null when not registered', async () => {
    const registry = mockRegistry(null);
    const result = await getOwnRegistration('unknown', registry);
    expect(result).toBeNull();
  });
});

describe('listPeers', () => {
  it('returns all peers', async () => {
    const peers = [
      { name: 'code-agent', info: sampleInfo },
      { name: 'science-agent', info: { ...sampleInfo, port: 8848 } },
    ];
    const registry = mockRegistry(null, peers);
    const result = await listPeers(registry);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('code-agent');
  });

  it('returns empty array when no peers', async () => {
    const registry = mockRegistry(null, []);
    const result = await listPeers(registry);
    expect(result).toHaveLength(0);
  });

  it('passes prefix to registry.list', async () => {
    const registry = mockRegistry(null, []);
    await listPeers(registry, 'code');
    expect(registry.list).toHaveBeenCalledWith('code');
  });
});
