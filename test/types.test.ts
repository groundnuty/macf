import { describe, it, expect } from 'vitest';
import { NotifyPayloadSchema, NotifyTypeSchema, HealthResponseSchema } from '../src/types.js';

describe('NotifyTypeSchema', () => {
  it('accepts valid types', () => {
    expect(NotifyTypeSchema.parse('issue_routed')).toBe('issue_routed');
    expect(NotifyTypeSchema.parse('mention')).toBe('mention');
    expect(NotifyTypeSchema.parse('startup_check')).toBe('startup_check');
  });

  it('rejects unknown types', () => {
    expect(() => NotifyTypeSchema.parse('unknown')).toThrow();
  });
});

describe('NotifyPayloadSchema', () => {
  it('accepts minimal payload', () => {
    const result = NotifyPayloadSchema.parse({ type: 'mention' });
    expect(result.type).toBe('mention');
    expect(result.issue_number).toBeUndefined();
  });

  it('accepts full payload', () => {
    const result = NotifyPayloadSchema.parse({
      type: 'issue_routed',
      issue_number: 42,
      title: 'Fix bug',
      source: 'agent-router',
      message: 'Routed to you',
    });
    expect(result.type).toBe('issue_routed');
    expect(result.issue_number).toBe(42);
    expect(result.title).toBe('Fix bug');
    expect(result.source).toBe('agent-router');
    expect(result.message).toBe('Routed to you');
  });

  it('rejects missing type', () => {
    expect(() => NotifyPayloadSchema.parse({ issue_number: 1 })).toThrow();
  });

  it('rejects invalid issue_number', () => {
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', issue_number: -1 })).toThrow();
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', issue_number: 0 })).toThrow();
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', issue_number: 1.5 })).toThrow();
  });
});

describe('HealthResponseSchema', () => {
  it('accepts valid health response', () => {
    const data = {
      agent: 'code-agent',
      status: 'online' as const,
      type: 'permanent',
      uptime_seconds: 3600,
      current_issue: null,
      version: '0.1.0',
      last_notification: null,
    };
    const result = HealthResponseSchema.parse(data);
    expect(result.agent).toBe('code-agent');
    expect(result.status).toBe('online');
  });

  it('accepts health with current issue', () => {
    const data = {
      agent: 'code-agent',
      status: 'online' as const,
      type: 'worker',
      uptime_seconds: 0,
      current_issue: 42,
      version: '0.1.0',
      last_notification: '2026-03-28T18:01:00Z',
    };
    const result = HealthResponseSchema.parse(data);
    expect(result.current_issue).toBe(42);
    expect(result.last_notification).toBe('2026-03-28T18:01:00Z');
  });

  it('rejects negative uptime', () => {
    expect(() => HealthResponseSchema.parse({
      agent: 'test',
      status: 'online',
      type: 'permanent',
      uptime_seconds: -1,
      current_issue: null,
      version: '0.1.0',
      last_notification: null,
    })).toThrow();
  });
});
