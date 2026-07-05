import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentInfo, GitHubVariablesClient, HealthResponse } from '@groundnuty/macf-core';

vi.mock('../../../src/plugin/lib/health.js', () => ({
  pingAgent: vi.fn(),
}));

import { probePeerHealth } from '../../../src/plugin/lib/probe-peer-health.js';
import { pingAgent } from '../../../src/plugin/lib/health.js';

const sampleInfo: AgentInfo = {
  host: '127.0.0.1',
  port: 9001,
  type: 'permanent',
  instance_id: 'a1b2c3',
  started: '2026-05-01T15:00:00Z',
};

const samplePeer = { name: 'CODE_AGENT', info: sampleInfo };

const sampleHealth: HealthResponse = {
  agent_name: 'code-agent',
  agent_type: 'permanent',
  uptime_seconds: 42,
  current_issue: null,
  notifications_received: 0,
};

let workDir: string;

beforeEach(() => {
  workDir = join(tmpdir(), `macf-probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
  vi.clearAllMocks();
  delete process.env['MACF_CA_CERT'];
  delete process.env['MACF_AGENT_CERT'];
  delete process.env['MACF_AGENT_KEY'];
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('probePeerHealth (#325 regression)', () => {
  it('returns null when MACF_CA_CERT is unset', async () => {
    process.env['MACF_AGENT_CERT'] = join(workDir, 'agent-cert.pem');
    process.env['MACF_AGENT_KEY'] = join(workDir, 'agent-key.pem');
    const result = await probePeerHealth(samplePeer);
    expect(result).toBeNull();
    expect(pingAgent).not.toHaveBeenCalled();
  });

  it('returns null when MACF_AGENT_CERT is unset', async () => {
    process.env['MACF_CA_CERT'] = join(workDir, 'ca.pem');
    process.env['MACF_AGENT_KEY'] = join(workDir, 'agent-key.pem');
    const result = await probePeerHealth(samplePeer);
    expect(result).toBeNull();
    expect(pingAgent).not.toHaveBeenCalled();
  });

  it('returns null when MACF_AGENT_KEY is unset', async () => {
    process.env['MACF_CA_CERT'] = join(workDir, 'ca.pem');
    process.env['MACF_AGENT_CERT'] = join(workDir, 'agent-cert.pem');
    const result = await probePeerHealth(samplePeer);
    expect(result).toBeNull();
    expect(pingAgent).not.toHaveBeenCalled();
  });

  it('returns null when CA cert file does not exist', async () => {
    process.env['MACF_CA_CERT'] = join(workDir, 'nonexistent-ca.pem');
    process.env['MACF_AGENT_CERT'] = join(workDir, 'agent-cert.pem');
    process.env['MACF_AGENT_KEY'] = join(workDir, 'agent-key.pem');
    const result = await probePeerHealth(samplePeer);
    expect(result).toBeNull();
    expect(pingAgent).not.toHaveBeenCalled();
  });

  it('calls pingAgent with cert paths from env vars when all are set', async () => {
    const caPath = join(workDir, 'ca.pem');
    const certPath = join(workDir, 'agent-cert.pem');
    const keyPath = join(workDir, 'agent-key.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nfake-ca\n-----END CERTIFICATE-----\n');
    process.env['MACF_CA_CERT'] = caPath;
    process.env['MACF_AGENT_CERT'] = certPath;
    process.env['MACF_AGENT_KEY'] = keyPath;
    vi.mocked(pingAgent).mockResolvedValue(sampleHealth);

    const result = await probePeerHealth(samplePeer);

    expect(result).toEqual(sampleHealth);
    expect(pingAgent).toHaveBeenCalledOnce();
    expect(pingAgent).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 9001,
      caCertPem: '-----BEGIN CERTIFICATE-----\nfake-ca\n-----END CERTIFICATE-----\n',
      certPath,
      keyPath,
    });
  });

  it('returns null when pingAgent itself returns null (peer offline)', async () => {
    const caPath = join(workDir, 'ca.pem');
    writeFileSync(caPath, 'fake-ca');
    process.env['MACF_CA_CERT'] = caPath;
    process.env['MACF_AGENT_CERT'] = join(workDir, 'agent-cert.pem');
    process.env['MACF_AGENT_KEY'] = join(workDir, 'agent-key.pem');
    vi.mocked(pingAgent).mockResolvedValue(null);

    const result = await probePeerHealth(samplePeer);

    expect(result).toBeNull();
    expect(pingAgent).toHaveBeenCalledOnce();
  });

  it('passes through host:port from peer info verbatim (self-probe path)', async () => {
    const caPath = join(workDir, 'ca.pem');
    writeFileSync(caPath, 'fake-ca');
    process.env['MACF_CA_CERT'] = caPath;
    process.env['MACF_AGENT_CERT'] = join(workDir, 'cert');
    process.env['MACF_AGENT_KEY'] = join(workDir, 'key');
    vi.mocked(pingAgent).mockResolvedValue(sampleHealth);

    const selfPeer = { name: 'SELF', info: { ...sampleInfo, host: '100.86.5.117', port: 8847 } };
    await probePeerHealth(selfPeer);

    expect(pingAgent).toHaveBeenCalledWith(
      expect.objectContaining({ host: '100.86.5.117', port: 8847 }),
    );
  });
});

function fakeVarsClient(vars: Record<string, string | null>): GitHubVariablesClient {
  return {
    readVariable: async (name: string) => (name in vars ? vars[name]! : null),
    writeVariable: async () => undefined,
    listVariables: async () => [],
    deleteVariable: async () => undefined,
  };
}

describe('probePeerHealth — federation-aware guest probe (DR-041 Amendment B, #794)', () => {
  function setEnv(): { caPath: string } {
    const caPath = join(workDir, 'ca.pem');
    writeFileSync(caPath, 'OWN-CA-PEM');
    process.env['MACF_CA_CERT'] = caPath;
    process.env['MACF_AGENT_CERT'] = join(workDir, 'agent-cert.pem');
    process.env['MACF_AGENT_KEY'] = join(workDir, 'agent-key.pem');
    return { caPath };
  }

  it('a guest probe builds a bundle that includes the federated CA', async () => {
    setEnv();
    vi.mocked(pingAgent).mockResolvedValue(sampleHealth);
    const varsClient = fakeVarsClient({ PPAM_2026_CA_CERT: 'FOREIGN-CA-PEM' });

    const result = await probePeerHealth(samplePeer, {
      homeProject: 'ppam-2026',
      federatedCaProjects: ['ppam-2026'],
      varsClient,
    });

    expect(result).toEqual(sampleHealth);
    expect(pingAgent).toHaveBeenCalledWith(
      expect.objectContaining({ caCertPem: 'OWN-CA-PEM\nFOREIGN-CA-PEM' }),
    );
  });

  it('a same-fleet peer probe (no guest param) uses own-CA only — UNCHANGED', async () => {
    setEnv();
    vi.mocked(pingAgent).mockResolvedValue(sampleHealth);

    await probePeerHealth(samplePeer);

    expect(pingAgent).toHaveBeenCalledWith(expect.objectContaining({ caCertPem: 'OWN-CA-PEM' }));
  });

  it('homeProject NOT declared in federatedCaProjects → probes with own CA only (pre-#794 passthrough)', async () => {
    setEnv();
    vi.mocked(pingAgent).mockResolvedValue(sampleHealth);

    const result = await probePeerHealth(samplePeer, {
      homeProject: 'unknown-fleet',
      federatedCaProjects: ['ppam-2026'],
      varsClient: undefined,
    });

    expect(result).toEqual(sampleHealth);
    expect(pingAgent).toHaveBeenCalledWith(expect.objectContaining({ caCertPem: 'OWN-CA-PEM' }));
  });

  it('an unresolvable DECLARED federated CA degrades the guest to offline (null) — never throws', async () => {
    setEnv();
    const varsClient = fakeVarsClient({}); // PPAM_2026_CA_CERT resolves null

    const result = await probePeerHealth(samplePeer, {
      homeProject: 'ppam-2026',
      federatedCaProjects: ['ppam-2026'],
      varsClient,
    });

    expect(result).toBeNull();
    expect(pingAgent).not.toHaveBeenCalled();
  });

  it('local-registry mode (no varsClient) + a declared federated project degrades to offline (null)', async () => {
    setEnv();

    const result = await probePeerHealth(samplePeer, {
      homeProject: 'ppam-2026',
      federatedCaProjects: ['ppam-2026'],
      varsClient: undefined,
    });

    expect(result).toBeNull();
    expect(pingAgent).not.toHaveBeenCalled();
  });
});
