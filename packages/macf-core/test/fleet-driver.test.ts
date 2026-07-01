/**
 * Tests for the `FleetDriver` contract types (DR-037 Decision 3). The interface
 * itself is compile-time; these assert the shared runtime surface — the
 * `FleetDriverError` code/name + that a minimal object structurally satisfies the
 * interface (the subcommands import + rely on this exact shape).
 */
import { describe, it, expect } from 'vitest';
import {
  FleetDriverError,
  MacfError,
  type FleetDriver,
  type FleetState,
  type WorkspaceRecord,
} from '../src/index.js';

describe('FleetDriverError', () => {
  it('is a MacfError with a stable code + name', () => {
    const err = new FleetDriverError("unknown agent 'ghost'");
    expect(err).toBeInstanceOf(MacfError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('FLEET_DRIVER_ERROR');
    expect(err.name).toBe('FleetDriverError');
    expect(err.message).toContain('ghost');
  });
});

describe('FleetDriver structural contract', () => {
  it('a minimal object satisfies the interface + its verbs are callable', async () => {
    const records: readonly WorkspaceRecord[] = [
      { agent: 'code-agent', workspace: '/w/macf', registry: 'groundnuty', versionPin: '0.2.41' },
    ];
    const state: FleetState = { agents: [] };
    const calls: string[] = [];

    const driver: FleetDriver = {
      probe: async () => state,
      discoverWorkspaces: () => records,
      isBusy: async (a) => {
        calls.push(`isBusy:${a}`);
        return false;
      },
      upgrade: async (a) => void calls.push(`upgrade:${a}`),
      restart: async (a) => void calls.push(`restart:${a}`),
      inject: async (a, t) => void calls.push(`inject:${a}:${t}`),
      launch: async (a) => void calls.push(`launch:${a}`),
    };

    expect(await driver.probe()).toBe(state);
    expect(driver.discoverWorkspaces()).toBe(records);
    expect(await driver.isBusy('code-agent')).toBe(false);
    await driver.upgrade('code-agent');
    await driver.restart('code-agent');
    await driver.inject('code-agent', 'nudge');
    await driver.launch('code-agent');
    expect(calls).toEqual([
      'isBusy:code-agent',
      'upgrade:code-agent',
      'restart:code-agent',
      'inject:code-agent:nudge',
      'launch:code-agent',
    ]);
  });
});
