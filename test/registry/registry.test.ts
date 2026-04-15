import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRegistry } from '../../src/registry/registry.js';
import type { GitHubVariablesClient } from '../../src/registry/types.js';

function mockClient(): GitHubVariablesClient {
  return {
    writeVariable: vi.fn().mockResolvedValue(undefined),
    readVariable: vi.fn().mockResolvedValue(null),
    listVariables: vi.fn().mockResolvedValue([]),
    deleteVariable: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createRegistry', () => {
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    client = mockClient();
  });

  describe('register', () => {
    it('writes variable with project prefix', async () => {
      const registry = createRegistry(client, 'MACF');
      await registry.register('code_agent', {
        host: '100.86.5.117',
        port: 8847,
        type: 'permanent',
        instance_id: 'a8f3c2',
        started: '2026-03-28T18:00:00Z',
      });

      expect(client.writeVariable).toHaveBeenCalledWith(
        'MACF_AGENT_CODE_AGENT',
        expect.stringContaining('"host":"100.86.5.117"'),
      );
    });

    it('uppercases project prefix', async () => {
      const registry = createRegistry(client, 'macf');
      await registry.register('test', {
        host: 'localhost',
        port: 9000,
        type: 'worker',
        instance_id: 'abc',
        started: '2026-01-01T00:00:00Z',
      });

      expect(vi.mocked(client.writeVariable).mock.calls[0]![0]).toBe('MACF_AGENT_TEST');
    });
  });

  describe('get', () => {
    it('returns parsed AgentInfo when variable exists', async () => {
      vi.mocked(client.readVariable).mockResolvedValueOnce(JSON.stringify({
        host: 'localhost',
        port: 9000,
        type: 'permanent',
        instance_id: 'abc123',
        started: '2026-01-01T00:00:00Z',
      }));

      const registry = createRegistry(client, 'MACF');
      const result = await registry.get('code_agent');

      expect(result).not.toBeNull();
      expect(result!.host).toBe('localhost');
      expect(result!.port).toBe(9000);
      expect(client.readVariable).toHaveBeenCalledWith('MACF_AGENT_CODE_AGENT');
    });

    it('returns null when variable does not exist', async () => {
      const registry = createRegistry(client, 'MACF');
      const result = await registry.get('missing');

      expect(result).toBeNull();
    });

    it('returns null for invalid JSON in variable', async () => {
      vi.mocked(client.readVariable).mockResolvedValueOnce('not-json');

      const registry = createRegistry(client, 'MACF');
      const result = await registry.get('bad');
      expect(result).toBeNull();
    });

    it('returns null for valid JSON that fails schema validation', async () => {
      vi.mocked(client.readVariable).mockResolvedValueOnce(
        JSON.stringify({ host: 'localhost' }),
      );

      const registry = createRegistry(client, 'MACF');
      const result = await registry.get('partial');

      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('returns agents matching prefix', async () => {
      vi.mocked(client.listVariables).mockResolvedValueOnce([
        {
          name: 'MACF_AGENT_CODE_AGENT',
          value: JSON.stringify({
            host: 'host1', port: 8800, type: 'permanent',
            instance_id: 'a1', started: '2026-01-01T00:00:00Z',
          }),
        },
        {
          name: 'MACF_AGENT_SCIENCE_AGENT',
          value: JSON.stringify({
            host: 'host2', port: 8801, type: 'permanent',
            instance_id: 'a2', started: '2026-01-01T00:00:00Z',
          }),
        },
        { name: 'OTHER_VAR', value: 'not-an-agent' },
      ]);

      const registry = createRegistry(client, 'MACF');
      const result = await registry.list('');

      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe('CODE_AGENT');
      expect(result[1]!.name).toBe('SCIENCE_AGENT');
    });

    it('filters by sub-prefix', async () => {
      vi.mocked(client.listVariables).mockResolvedValueOnce([
        {
          name: 'MACF_AGENT_CODE_AGENT',
          value: JSON.stringify({
            host: 'h', port: 1, type: 'permanent',
            instance_id: 'x', started: '2026-01-01T00:00:00Z',
          }),
        },
        {
          name: 'MACF_AGENT_CODE_AGENT_2',
          value: JSON.stringify({
            host: 'h', port: 2, type: 'worker',
            instance_id: 'y', started: '2026-01-01T00:00:00Z',
          }),
        },
        {
          name: 'MACF_AGENT_SCIENCE_AGENT',
          value: JSON.stringify({
            host: 'h', port: 3, type: 'permanent',
            instance_id: 'z', started: '2026-01-01T00:00:00Z',
          }),
        },
      ]);

      const registry = createRegistry(client, 'MACF');
      const result = await registry.list('code');

      expect(result).toHaveLength(2);
      expect(result.map(r => r.name)).toEqual(['CODE_AGENT', 'CODE_AGENT_2']);
    });

    it('skips variables with invalid JSON', async () => {
      vi.mocked(client.listVariables).mockResolvedValueOnce([
        { name: 'MACF_AGENT_GOOD', value: JSON.stringify({
          host: 'h', port: 1, type: 'permanent', instance_id: 'x', started: '2026-01-01T00:00:00Z',
        }) },
        { name: 'MACF_AGENT_BAD', value: 'not-json' },
      ]);

      const registry = createRegistry(client, 'MACF');
      const result = await registry.list('');

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('GOOD');
    });

    it('skips variables that fail schema validation', async () => {
      vi.mocked(client.listVariables).mockResolvedValueOnce([
        { name: 'MACF_AGENT_INCOMPLETE', value: JSON.stringify({ host: 'h' }) },
      ]);

      const registry = createRegistry(client, 'MACF');
      const result = await registry.list('');

      expect(result).toHaveLength(0);
    });
  });

  describe('remove', () => {
    it('deletes variable with project prefix', async () => {
      const registry = createRegistry(client, 'MACF');
      await registry.remove('code_agent');

      expect(client.deleteVariable).toHaveBeenCalledWith('MACF_AGENT_CODE_AGENT');
    });
  });
});
