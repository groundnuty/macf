/**
 * Tests for `macf certs issue-routing-client` (#119).
 *
 * Covers:
 *   - Successful mint with default validity (365d) → files written at
 *     expected perms; cert has correct CN + signed by CA
 *   - Stdout-only mode (no --out-dir): prints PEMs + base64 blobs
 *   - Missing CA on disk → error + exit 1
 *   - Missing macf-agent.json → error + exit 1
 *   - Collision guard: agent already registered with routing-action →
 *     error + exit 1, no cert written
 *   - --validity-days 30 accepted; --validity-days 1000 warns
 *   - --validity-days invalid (zero, negative, non-integer) → error
 *
 * Uses vi.mock for `../../src/token.js` and
 * `../../src/registry/factory.js` so tests run without network / App
 * credentials.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import * as x509Lib from '@peculiar/x509';

// Mock the token + registry layers BEFORE importing the module under test.
vi.mock('../../src/token.js', () => ({
  generateToken: vi.fn().mockResolvedValue('fake-token-for-tests'),
}));

const mockRegistryGet = vi.fn<(name: string) => Promise<unknown>>();
vi.mock('../../src/registry/factory.js', () => ({
  createRegistryFromConfig: () => ({
    register: vi.fn(),
    get: mockRegistryGet,
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
  }),
}));

// Crypto provider must be initialized before @peculiar/x509 is used.
import '../../src/certs/crypto-provider.js';
import { issueRoutingClient } from '../../src/cli/commands/certs.js';
import { createCA } from '../../src/certs/ca.js';
import { writeAgentConfig } from '../../src/cli/config.js';
import { caDir, caCertPath, caKeyPath } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-irc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function setupWorkspace(project: string): Promise<{
  readonly projectDir: string;
  readonly caCertPath: string;
  readonly caKeyPath: string;
}> {
  const projectDir = tempDir();
  const config: MacfAgentConfig = {
    project,
    agent_name: 'test-agent',
    agent_role: 'test-agent',
    agent_type: 'permanent',
    registry: { type: 'repo', owner: 'owner', repo: 'repo' },
    github_app: {
      app_id: '12345',
      install_id: '67890',
      key_path: 'ignored.pem',
    },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
  };
  writeAgentConfig(projectDir, config);

  const caCertP = caCertPath(project);
  const caKeyP = caKeyPath(project);
  mkdirSync(caDir(project), { recursive: true, mode: 0o700 });
  await createCA({ project, certPath: caCertP, keyPath: caKeyP });

  return { projectDir, caCertPath: caCertP, caKeyPath: caKeyP };
}

function cleanup(project: string, projectDir: string): void {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(caDir(project), { recursive: true, force: true });
}

describe('issueRoutingClient (#119)', () => {
  let logs: string[] = [];
  let errors: string[] = [];
  let warnings: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    errors = [];
    warnings = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '));
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warnings.push(args.join(' '));
    });
    process.exitCode = 0;
    mockRegistryGet.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    process.exitCode = 0;
  });

  it('mints a cert with default validity (365d), writes files at tight perms', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const { projectDir } = await setupWorkspace(project);
    try {
      const outDir = join(projectDir, 'out');
      await issueRoutingClient(projectDir, { outDir });

      expect(process.exitCode).toBe(0);
      const certP = join(outDir, 'routing-action-cert.pem');
      const keyP = join(outDir, 'routing-action-key.pem');
      expect(existsSync(certP)).toBe(true);
      expect(existsSync(keyP)).toBe(true);

      // File perms: cert world-readable, key 0o600.
      const keyMode = statSync(keyP).mode & 0o777;
      expect(keyMode).toBe(0o600);

      // Cert has correct CN.
      const certPem = readFileSync(certP, 'utf-8');
      const cert = new x509Lib.X509Certificate(certPem);
      expect(cert.subject).toContain('CN=routing-action');

      // ~365 day validity.
      const spanDays = (cert.notAfter.getTime() - cert.notBefore.getTime()) / (1000 * 60 * 60 * 24);
      expect(spanDays).toBeGreaterThan(364.5);
      expect(spanDays).toBeLessThan(365.5);

      // stdout includes the GHA-secret base64 lines.
      const joined = logs.join('\n');
      expect(joined).toContain('ROUTING_CLIENT_CERT =');
      expect(joined).toContain('ROUTING_CLIENT_KEY  =');
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('stdout-only mode (no --out-dir): PEMs printed + GHA-secret base64', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const { projectDir } = await setupWorkspace(project);
    try {
      await issueRoutingClient(projectDir);

      expect(process.exitCode).toBe(0);
      const joined = logs.join('\n');
      expect(joined).toContain('-----BEGIN CERTIFICATE-----');
      expect(joined).toContain('-----BEGIN PRIVATE KEY-----');
      expect(joined).toContain('ROUTING_CLIENT_CERT =');
      expect(joined).toContain('ROUTING_CLIENT_KEY  =');
      expect(joined).toContain('KEEP SECRET');
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('refuses when no macf-agent.json in projectDir', async () => {
    const projectDir = tempDir();
    try {
      await issueRoutingClient(projectDir);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/macf-agent\.json/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('refuses when CA cert/key not on disk', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const projectDir = tempDir();
    try {
      const config: MacfAgentConfig = {
        project,
        agent_name: 'test-agent',
        agent_role: 'test-agent',
        agent_type: 'permanent',
        registry: { type: 'repo', owner: 'owner', repo: 'repo' },
        github_app: { app_id: '12345', install_id: '67890', key_path: 'ignored.pem' },
        versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
      };
      writeAgentConfig(projectDir, config);
      // Deliberately DO NOT create the CA.

      await issueRoutingClient(projectDir);

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/CA cert or key not found/);
      expect(errors.join('\n')).toMatch(/macf certs init|macf certs recover/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('collision guard: refuses when an agent is already registered as routing-action', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const { projectDir } = await setupWorkspace(project);
    try {
      // Simulate an existing registration.
      mockRegistryGet.mockResolvedValueOnce({
        host: '100.1.2.3',
        port: 8888,
        cert_fingerprint: 'x',
        started_at: new Date().toISOString(),
      });

      const outDir = join(projectDir, 'out');
      await issueRoutingClient(projectDir, { outDir });

      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/"routing-action" is already registered/);
      // No cert files should have been written.
      expect(existsSync(join(outDir, 'routing-action-cert.pem'))).toBe(false);
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('--validity-days 30: accepts short validity', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const { projectDir } = await setupWorkspace(project);
    try {
      const outDir = join(projectDir, 'out');
      await issueRoutingClient(projectDir, { outDir, validityDays: 30 });

      expect(process.exitCode).toBe(0);
      const certPem = readFileSync(join(outDir, 'routing-action-cert.pem'), 'utf-8');
      const cert = new x509Lib.X509Certificate(certPem);
      const spanDays = (cert.notAfter.getTime() - cert.notBefore.getTime()) / (1000 * 60 * 60 * 24);
      expect(spanDays).toBeGreaterThan(29.5);
      expect(spanDays).toBeLessThan(30.5);
      expect(warnings.join('\n')).not.toMatch(/exceeds/);
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('--validity-days 1000: warns but still issues', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const { projectDir } = await setupWorkspace(project);
    try {
      const outDir = join(projectDir, 'out');
      await issueRoutingClient(projectDir, { outDir, validityDays: 1000 });

      expect(process.exitCode).toBe(0);
      expect(warnings.join('\n')).toMatch(/exceeds 730 days/);
      expect(existsSync(join(outDir, 'routing-action-cert.pem'))).toBe(true);
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('rejects invalid --validity-days (zero, negative, non-integer)', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const { projectDir } = await setupWorkspace(project);
    try {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        process.exitCode = 0;
        errors = [];
        await issueRoutingClient(projectDir, { validityDays: bad });
        expect(process.exitCode, `validityDays=${bad}`).toBe(1);
        expect(errors.join('\n')).toMatch(/positive integer/);
      }
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('cert is signed by the project CA (issuer matches CA subject)', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const { projectDir, caCertPath: caCertP } = await setupWorkspace(project);
    try {
      const outDir = join(projectDir, 'out');
      await issueRoutingClient(projectDir, { outDir });

      const certPem = readFileSync(join(outDir, 'routing-action-cert.pem'), 'utf-8');
      const caCertPem = readFileSync(caCertP, 'utf-8');
      const cert = new x509Lib.X509Certificate(certPem);
      const caCert = new x509Lib.X509Certificate(caCertPem);
      expect(cert.issuer).toBe(caCert.subject);
    } finally {
      cleanup(project, projectDir);
    }
  });
});
