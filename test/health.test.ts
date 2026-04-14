import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHealthState } from '../src/health.js';

describe('createHealthState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T18:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns initial health state', () => {
    const state = createHealthState('code-agent', 'permanent');
    const health = state.getHealth();

    expect(health.agent).toBe('code-agent');
    expect(health.status).toBe('online');
    expect(health.type).toBe('permanent');
    expect(health.uptime_seconds).toBe(0);
    expect(health.current_issue).toBeNull();
    expect(health.version).toBe('0.1.0');
    expect(health.last_notification).toBeNull();
  });

  it('tracks uptime in seconds', () => {
    const state = createHealthState('code-agent', 'permanent');

    vi.advanceTimersByTime(5000);
    expect(state.getHealth().uptime_seconds).toBe(5);

    vi.advanceTimersByTime(60000);
    expect(state.getHealth().uptime_seconds).toBe(65);
  });

  it('sets and clears current issue', () => {
    const state = createHealthState('code-agent', 'permanent');

    state.setCurrentIssue(42);
    expect(state.getHealth().current_issue).toBe(42);

    state.setCurrentIssue(99);
    expect(state.getHealth().current_issue).toBe(99);

    state.setCurrentIssue(null);
    expect(state.getHealth().current_issue).toBeNull();
  });

  it('records notification timestamp', () => {
    const state = createHealthState('code-agent', 'permanent');
    expect(state.getHealth().last_notification).toBeNull();

    state.recordNotification();
    expect(state.getHealth().last_notification).toBe('2026-03-28T18:00:00.000Z');

    vi.advanceTimersByTime(60000);
    state.recordNotification();
    expect(state.getHealth().last_notification).toBe('2026-03-28T18:01:00.000Z');
  });

  it('handles worker agent type', () => {
    const state = createHealthState('worker-1', 'worker');
    expect(state.getHealth().type).toBe('worker');
    expect(state.getHealth().agent).toBe('worker-1');
  });
});
