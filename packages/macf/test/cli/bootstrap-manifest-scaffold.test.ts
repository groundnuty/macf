/**
 * Tests for `macf bootstrap manifest scaffold` (groundnuty/macf#1153).
 * Offline + deterministic: every read is injected, mirroring
 * `bootstrap-status.test.ts`'s conventions for `runBootstrapStatus`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentSpec, runManifestScaffold } from '../../src/cli/commands/bootstrap-manifest-scaffold.js';
import type { ManifestScaffoldDeps } from '../../src/cli/bootstrap/manifest-scaffold.js';

function fullyObservableDeps(): ManifestScaffoldDeps {
  return {
    fetchOwnerType: vi.fn(async () => 'org'),
    checkRegistryVariablePresence: vi.fn(async () => 'present'),
    readAgentRegistryInfo: vi.fn(async (_registry, _fleet, role: string) => ({
      status: 'confirmed' as const,
      presence: 'present' as const,
      info: { host: '100.64.1.2', port: 8443, type: 'permanent' as const, instance_id: `${role}-inst`, started: '2026-01-01T00:00:00Z' },
    })),
    checkRepoArchivedState: vi.fn(async () => ({ presence: 'present' as const, archived: false })),
    readCallerActionsPin: vi.fn(async () => 'v3.4.1'),
    resolveAgentRepoState: vi.fn(async () => ({ repo: 'present' as const, caRepo: 'present' as const, routingClientRepo: 'present' as const })),
    readAgentConfigWorkspaceDir: vi.fn(async (repo: string) => `/home/ubuntu/repos/${repo}`),
    readVault: vi.fn(async () => ({})),
    readVaultRecipientCount: vi.fn(() => ({ status: 'absent' as const })),
  };
}

const BASE_OPTS = { owner: 'groundnuty', fleet: 'macf', agent: ['code-agent=groundnuty/macf-code-agent'], json: true } as const;

let logs: string[] = [];
let errs: string[] = [];
const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
  logs.push(String(msg));
});
const errSpy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
  errs.push(String(msg));
});

afterEach(() => {
  logs = [];
  errs = [];
  logSpy.mockClear();
  errSpy.mockClear();
});

describe('parseAgentSpec', () => {
  it('parses role=owner/repo', () => {
    expect(parseAgentSpec('code-agent=groundnuty/macf-code-agent')).toEqual({ role: 'code-agent', repo: 'groundnuty/macf-code-agent' });
  });

  it.each(['', 'no-equals-sign', '=owner/repo', 'role=', 'role=repo-without-slash'])('rejects malformed spec %s', (spec) => {
    expect(parseAgentSpec(spec)).toBeUndefined();
  });
});

describe('runManifestScaffold — failure paths', () => {
  it('fails loud when no --agent is given (cannot discover role<->repo bindings live)', async () => {
    const code = await runManifestScaffold({ ...BASE_OPTS, agent: [] }, fullyObservableDeps());
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('--agent'))).toBe(true);
  });

  it('fails loud on a malformed --agent spec', async () => {
    const code = await runManifestScaffold({ ...BASE_OPTS, agent: ['not-a-valid-spec'] }, fullyObservableDeps());
    expect(code).toBe(1);
  });

  it('fails loud on a malformed --fleet name', async () => {
    const code = await runManifestScaffold({ ...BASE_OPTS, fleet: 'NOT-kebab-case!' }, fullyObservableDeps());
    expect(code).toBe(1);
  });

  it('fails loud on a half-specified --vault/--identity-key pair', async () => {
    const code = await runManifestScaffold({ ...BASE_OPTS, vaultPath: '/tmp/vault.age' }, fullyObservableDeps());
    expect(code).toBe(1);
  });
});

describe('runManifestScaffold — success path', () => {
  it('emits a JSON payload carrying the draft, TODO count, schema issue paths, and the audit table', async () => {
    const code = await runManifestScaffold(BASE_OPTS, fullyObservableDeps());
    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    expect(typeof payload['yaml']).toBe('string');
    expect(typeof payload['todo_count']).toBe('number');
    expect(Array.isArray(payload['schema_issue_paths'])).toBe(true);
    expect(Array.isArray(payload['audit_table'])).toBe(true);
    expect((payload['audit_table'] as readonly unknown[]).length).toBeGreaterThan(0);
  });

  it('writes the draft to --out as a LOCAL file, and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'macf-manifest-scaffold-test-'));
    const outPath = join(dir, 'fleet.yaml');
    try {
      const code = await runManifestScaffold({ ...BASE_OPTS, json: false, out: outPath }, fullyObservableDeps());
      expect(code).toBe(0);
      const written = readFileSync(outPath, 'utf-8');
      expect(written).toContain('apiVersion: macf/v0');
      expect(written).toContain('kind: Fleet');
      expect(logs.join('\n')).toContain(outPath);
      expect(logs.join('\n')).toContain('nothing was written to any repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
