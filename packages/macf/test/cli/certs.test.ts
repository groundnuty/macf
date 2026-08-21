/**
 * Tests for `macf certs init` / `macf certs rotate` — the macf#800 (DR-010
 * amendment / silent-fallback-hazards.md Instance 16) out-of-band
 * blast-radius WARN.
 *
 * A CA (re-)issue re-signs the LOCAL/registry CA material + the in-workspace
 * agent cert, but it CANNOT reach artifacts that live out-of-band as GitHub
 * Actions secrets/variables on caller repos (agents can't write GitHub
 * secrets — DR-019). Those commands must WARN loudly instead:
 *
 *   - `certs rotate` warns UNCONDITIONALLY (an operator can't tell from the
 *     command alone whether the CA it signs against changed since the last
 *     out-of-band artifact was minted).
 *   - `certs init` warns only on RE-INIT (an existing CA cert already on
 *     disk) — a genuine first-time init has nothing to orphan yet.
 *
 * Uses vi.mock for `@groundnuty/macf-core`'s `createGitHubClient` (the
 * registry-write path `certs init` uses to upload the CA cert/backup) and
 * `../prompt.js` (`promptPassword`) so tests run without network or a TTY.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// `vi.hoisted` runs BEFORE the hoisted `vi.mock` factories below (and before
// this file's real ESM imports, which the JS spec hoists ahead of ordinary
// top-level statements) — a plain top-level `const` here would still be in
// its temporal-dead-zone when a factory dereferences it directly (bit us on
// `mockPromptPassword`; `mockWriteVariable` only "worked" because it was
// referenced from inside a not-yet-invoked closure). `vi.hoisted` is the
// canonical fix, not an accident of closure timing.
const { mockWriteVariable, mockPromptPassword } = vi.hoisted(() => ({
  mockWriteVariable: vi.fn<(name: string, value: string) => Promise<void>>(),
  mockPromptPassword: vi.fn<(opts: { message: string }) => Promise<string>>(),
}));

vi.mock('@groundnuty/macf-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@groundnuty/macf-core')>();
  return {
    ...actual,
    generateToken: vi.fn().mockResolvedValue('fake-token-for-tests'),
    createGitHubClient: () => ({
      writeVariable: mockWriteVariable,
      readVariable: vi.fn().mockResolvedValue(null),
      listVariables: vi.fn().mockResolvedValue([]),
      deleteVariable: vi.fn(),
    }),
  };
});

vi.mock('../../src/cli/prompt.js', () => ({
  promptPassword: mockPromptPassword,
  PromptCancelled: class PromptCancelled extends Error {},
}));

// Crypto provider must be initialized before @peculiar/x509-backed cert
// generation runs — the bare import triggers the provider's module-scoped
// initialization (same convention as issue-routing-client.test.ts).
import '@groundnuty/macf-core';
import { certsInit, certsRotate } from '../../src/cli/commands/certs.js';
import { toVariableSegment } from '@groundnuty/macf-core';
import { writeAgentConfig, caDir, agentCertPath } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';
import { dirname } from 'node:path';

function tempDir(): string {
  return mkdtemp('macf-certs-cmd-test');
}

function mkdtemp(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseConfig(project: string): MacfAgentConfig {
  return {
    project,
    agent_name: 'test-agent',
    agent_role: 'test-agent',
    agent_type: 'permanent',
    registry: { type: 'repo', owner: 'owner', repo: 'repo' },
    github_app: { app_id: '12345', install_id: '67890', key_path: 'ignored.pem' },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
  };
}

function cleanup(project: string, projectDir: string): void {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(caDir(project), { recursive: true, force: true });
}

describe('certsInit / certsRotate — macf#800 out-of-band blast-radius WARN', () => {
  let logs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    mockWriteVariable.mockReset().mockResolvedValue(undefined);
    mockPromptPassword.mockReset().mockResolvedValue('test-passphrase');
    process.exitCode = 0;
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
  });

  it('certs init — FIRST-TIME init does NOT print the blast-radius warning (nothing orphaned yet)', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const projectDir = tempDir();
    writeAgentConfig(projectDir, baseConfig(project));
    try {
      await certsInit(projectDir);

      expect(process.exitCode).toBe(0);
      const out = logs.join('\n');
      expect(out).toContain('CA initialization complete.');
      expect(out).not.toMatch(/OUT-OF-BAND blast radius/);
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('certs init — RE-INIT over an existing CA DOES print the blast-radius warning', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const projectDir = tempDir();
    writeAgentConfig(projectDir, baseConfig(project));
    try {
      await certsInit(projectDir); // first time — creates the CA, no warning expected
      logs = [];

      await certsInit(projectDir); // re-init over the existing CA — should warn

      const out = logs.join('\n');
      expect(out).toContain('CA initialization complete.');
      expect(out).toMatch(/OUT-OF-BAND blast radius/);
      expect(out).toMatch(/ROUTING_CLIENT_CERT/);
      expect(out).toMatch(/ROUTING_CLIENT_KEY/);
      expect(out).toContain('macf certs issue-routing-client');
      expect(out).toContain(`${toVariableSegment(project)}_CA_CERT`); // the repo-VARIABLE reminder (#806)
      expect(out).toMatch(/silent-fallback-hazards\.md Instance 16/);
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('certs init — RE-INIT with no passphrase (skip-backup early return) STILL warns', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const projectDir = tempDir();
    writeAgentConfig(projectDir, baseConfig(project));
    try {
      await certsInit(projectDir); // first time
      logs = [];
      mockPromptPassword.mockResolvedValueOnce(''); // no passphrase this run

      await certsInit(projectDir);

      const out = logs.join('\n');
      expect(out).toMatch(/No passphrase provided/);
      expect(out).not.toContain('CA initialization complete.'); // early-return path
      expect(out).toMatch(/OUT-OF-BAND blast radius/);
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('certs rotate — ALWAYS prints the blast-radius warning', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const projectDir = tempDir();
    writeAgentConfig(projectDir, baseConfig(project));
    try {
      await certsInit(projectDir); // sets up the CA
      // `certs rotate` writes the agent cert under `.macf/certs/` — a real
      // `macf init` would have created this directory; this test only sets
      // up the CA, so create the leaf dir directly.
      mkdirSync(dirname(agentCertPath(projectDir)), { recursive: true });
      logs = [];

      await certsRotate(projectDir);

      const out = logs.join('\n');
      expect(process.exitCode).toBe(0);
      expect(out).toContain('Rotation complete.');
      expect(out).toMatch(/OUT-OF-BAND blast radius/);
      expect(out).toContain(`${toVariableSegment(project)}_CA_CERT`);
    } finally {
      cleanup(project, projectDir);
    }
  });

  it('certs rotate — refuses (and does not warn) when no CA is present', async () => {
    const project = `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const projectDir = tempDir();
    writeAgentConfig(projectDir, baseConfig(project));
    try {
      await certsRotate(projectDir); // no `certs init` first — no CA on disk

      expect(process.exitCode).toBe(1);
      const out = logs.join('\n');
      expect(out).toMatch(/CA cert or key not found/);
      expect(out).not.toMatch(/OUT-OF-BAND blast radius/); // refused before reaching the warn
    } finally {
      cleanup(project, projectDir);
    }
  });
});
