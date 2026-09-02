import { describe, it, expect } from 'vitest';
import {
  AgentInfoSchema,
  RegistryConfigSchema,
  agentInfoEquals,
} from '../../src/registry/types.js';

describe('AgentInfoSchema', () => {
  it('accepts valid agent info', () => {
    const data = {
      host: '100.86.5.117',
      port: 8847,
      type: 'permanent',
      instance_id: 'a8f3c2',
      started: '2026-03-28T18:00:00Z',
    };
    const result = AgentInfoSchema.parse(data);
    expect(result.host).toBe('100.86.5.117');
    expect(result.port).toBe(8847);
    expect(result.type).toBe('permanent');
  });

  // groundnuty/macf#1393 — `agent_name` additive-optional field.
  describe('agent_name (macf#1393, additive-optional)', () => {
    const base = {
      host: '100.86.5.117',
      port: 8847,
      type: 'permanent' as const,
      instance_id: 'a8f3c2',
      started: '2026-03-28T18:00:00Z',
    };

    it('DECISIVE PAIR (1/2): parses when agent_name DIFFERS from the registry key (science-shaped)', () => {
      const result = AgentInfoSchema.parse({ ...base, agent_name: 'macf-science-agent' });
      expect(result.agent_name).toBe('macf-science-agent');
    });

    it('DECISIVE PAIR (2/2): parses when agent_name COINCIDES with the registry key (code-shaped)', () => {
      const result = AgentInfoSchema.parse({ ...base, agent_name: 'CODE_AGENT' });
      expect(result.agent_name).toBe('CODE_AGENT');
    });

    it('a pre-existing entry with no agent_name still parses — field is undefined, not defaulted', () => {
      const result = AgentInfoSchema.parse(base);
      expect(result.agent_name).toBeUndefined();
    });
  });

  it('accepts worker type', () => {
    const data = {
      host: 'localhost',
      port: 9000,
      type: 'worker',
      instance_id: 'b2c4d6',
      started: '2026-03-28T18:00:00Z',
    };
    expect(AgentInfoSchema.parse(data).type).toBe('worker');
  });

  it('rejects invalid type', () => {
    expect(() => AgentInfoSchema.parse({
      host: 'localhost',
      port: 9000,
      type: 'invalid',
      instance_id: 'abc',
      started: '2026-01-01T00:00:00Z',
    })).toThrow();
  });

  it('rejects missing fields', () => {
    expect(() => AgentInfoSchema.parse({ host: 'localhost' })).toThrow();
  });

  it('rejects negative port', () => {
    expect(() => AgentInfoSchema.parse({
      host: 'localhost',
      port: -1,
      type: 'permanent',
      instance_id: 'abc',
      started: '2026-01-01T00:00:00Z',
    })).toThrow();
  });
});

describe('agentInfoEquals — agent_name is excluded from CAS identity (macf#1393)', () => {
  const identity = {
    host: '100.86.5.117',
    port: 8847,
    type: 'permanent' as const,
    instance_id: 'a8f3c2',
    started: '2026-03-28T18:00:00Z',
  };

  it('MUTATION GUARD: a differing agent_name must NOT make two otherwise-identical entries unequal', () => {
    const a = { ...identity, agent_name: 'macf-code-agent' };
    const b = { ...identity, agent_name: 'a-completely-different-name' };
    // If a future change folds agent_name into the identity comparison,
    // this fails — the CAS must keep comparing on the five identity fields
    // only, per the schema's `agent_name` + `agentInfoEquals` doc comments.
    expect(agentInfoEquals(a, b)).toBe(true);
  });

  it('a pre-existing entry (no agent_name) compares equal to a freshly composed one that carries it', () => {
    const withoutField = { ...identity };
    const withField = { ...identity, agent_name: 'macf-code-agent' };
    expect(agentInfoEquals(withoutField, withField)).toBe(true);
  });
});

describe('RegistryConfigSchema', () => {
  it('accepts org config', () => {
    const result = RegistryConfigSchema.parse({ type: 'org', org: 'my-org' });
    expect(result).toEqual({ type: 'org', org: 'my-org' });
  });

  it('accepts profile config', () => {
    const result = RegistryConfigSchema.parse({ type: 'profile', user: 'groundnuty' });
    expect(result).toEqual({ type: 'profile', user: 'groundnuty' });
  });

  it('accepts repo config', () => {
    const result = RegistryConfigSchema.parse({ type: 'repo', owner: 'groundnuty', repo: 'macf' });
    expect(result).toEqual({ type: 'repo', owner: 'groundnuty', repo: 'macf' });
  });

  it('accepts local config (DR-024)', () => {
    const result = RegistryConfigSchema.parse({ type: 'local', path: '/abs/path.json' });
    expect(result).toEqual({ type: 'local', path: '/abs/path.json' });
  });

  it('rejects local config with empty path', () => {
    expect(() => RegistryConfigSchema.parse({ type: 'local', path: '' })).toThrow();
  });

  it('rejects local config without path', () => {
    expect(() => RegistryConfigSchema.parse({ type: 'local' })).toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => RegistryConfigSchema.parse({ type: 'unknown' })).toThrow();
  });

  it('rejects empty org', () => {
    expect(() => RegistryConfigSchema.parse({ type: 'org', org: '' })).toThrow();
  });
});
