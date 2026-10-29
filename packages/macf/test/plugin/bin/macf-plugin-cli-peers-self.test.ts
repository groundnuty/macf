/**
 * groundnuty/macf#1525 — `/macf-peers` lists peers but never said whether THIS
 * agent is registered, so an agent whose channel server was gone looked fine.
 * Drives the real `main()` for the `peers` case with the registry factory
 * mocked (same boundary as macf-plugin-cli-ping-guest.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const createRegistryFromConfigMock = vi.fn();
vi.mock('@groundnuty/macf-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createRegistryFromConfig: (...args: unknown[]) => createRegistryFromConfigMock(...args),
  };
});
vi.mock('../../../src/plugin/lib/probe-peer-health.js', () => ({
  probePeerHealth: async () => null,
}));

const { main } = await import('../../../src/plugin/bin/macf-plugin-cli.js');

const info = (host: string, port: number) => ({
  host, port, type: 'permanent' as const, instance_id: 'i', started: 't',
});

let workDir: string;

function registry(entries: Record<string, ReturnType<typeof info>>) {
  createRegistryFromConfigMock.mockImplementation(() => ({
    get: vi.fn(async (name: string) => entries[name] ?? null),
    list: vi.fn(async () => Object.entries(entries).map(([name, i]) => ({ name, info: i }))),
    register: vi.fn(), registerConditional: vi.fn(), remove: vi.fn(),
  }));
}

async function runPeers(): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await main();
  const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  logSpy.mockRestore();
  return out;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'macf-peers-self-'));
  process.env['MACF_WORKSPACE_DIR'] = workDir;
  process.env['MACF_REGISTRY_TYPE'] = 'local';
  process.env['MACF_REGISTRY_PATH'] = join(workDir, 'registry.json');
  process.env['MACF_PROJECT'] = 'my-project';
  process.env['MACF_AGENT_NAME'] = 'my-agent';
  process.argv[2] = 'peers';
  createRegistryFromConfigMock.mockReset();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('macf-plugin-cli peers — self row (#1525)', () => {
  it('own key missing from the registry → NOT REGISTERED row, peer table kept', async () => {
    registry({ 'peer-agent': info('10.0.0.9', 8801) });
    const out = await runPeers();
    expect(out).toContain('this agent (my-agent): NOT REGISTERED — its channel server is not running');
    expect(out).toContain('peer-agent');
  });

  it('own key present → normal row, no NOT REGISTERED line', async () => {
    registry({ 'my-agent': info('10.0.0.1', 8800), 'peer-agent': info('10.0.0.9', 8801) });
    const out = await runPeers();
    expect(out).not.toContain('NOT REGISTERED');
    expect(out).toContain('my-agent');
    expect(out).toContain('10.0.0.1:8800');
    expect(out).toContain('peer-agent');
  });
});
