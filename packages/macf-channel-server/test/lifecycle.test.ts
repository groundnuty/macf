/**
 * Tests for the lifecycle-phase tracker (groundnuty/macf#642).
 *
 * The crash handlers + the periodic alive-tick log the server's last-known
 * lifecycle phase so the forensic log's final line pinpoints WHERE the process
 * was when it died (booting vs serving vs deregistering).
 */
import { describe, it, expect } from 'vitest';
import { createLifecycleTracker } from '../src/lifecycle.js';

describe('createLifecycleTracker', () => {
  it('defaults to the "boot" phase', () => {
    const lc = createLifecycleTracker();
    expect(lc.snapshot().phase).toBe('boot');
  });

  it('honors an explicit initial phase', () => {
    const lc = createLifecycleTracker({ initial: 'starting' });
    expect(lc.snapshot().phase).toBe('starting');
  });

  it('set() advances the current phase', () => {
    const lc = createLifecycleTracker();
    lc.set('mcp-connected');
    expect(lc.snapshot().phase).toBe('mcp-connected');
    lc.set('serving');
    expect(lc.snapshot().phase).toBe('serving');
  });

  it('snapshot() reports a monotonically non-decreasing uptime_ms from an injected clock', () => {
    let t = 1000;
    const lc = createLifecycleTracker({ now: () => t });
    expect(lc.snapshot().uptime_ms).toBe(0);
    t = 1500;
    expect(lc.snapshot().uptime_ms).toBe(500);
    t = 9000;
    expect(lc.snapshot().uptime_ms).toBe(8000);
  });
});
