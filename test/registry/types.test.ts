import { describe, it, expect } from 'vitest';
import {
  AgentInfoSchema,
  RegistryConfigSchema,
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

  it('rejects unknown type', () => {
    expect(() => RegistryConfigSchema.parse({ type: 'unknown' })).toThrow();
  });

  it('rejects empty org', () => {
    expect(() => RegistryConfigSchema.parse({ type: 'org', org: '' })).toThrow();
  });
});
