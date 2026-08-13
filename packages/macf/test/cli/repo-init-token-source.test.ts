/**
 * `repoInit`'s `tokenSource` threading (groundnuty/macf#920 gap 1) — asserts
 * the wiring at the SAME boundary `apply-repo-init.ts` actually crosses:
 * `generateToken` (`@groundnuty/macf-core`), not `repoInit`'s own internal
 * `try`/`catch`. Kept in its own file (rather than folded into
 * `repo-init.test.ts`'s existing 1000+-line env/fetch-mock suite) because it
 * needs a module-level `vi.mock('@groundnuty/macf-core', ...)` — hoisted
 * mocks apply per test FILE, and mixing this mock into the existing suite
 * would risk shadowing that file's own real-`generateToken`-via-env-var
 * coverage. Mirrors `test/cli/issue-routing-client.test.ts`'s established
 * `vi.mock('@groundnuty/macf-core', ...)` + `importOriginal` pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const mockGenerateToken = vi.fn<(source?: unknown) => Promise<string>>();
vi.mock('@groundnuty/macf-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@groundnuty/macf-core')>();
  return { ...actual, generateToken: mockGenerateToken };
});

const { repoInit } = await import('../../src/cli/commands/repo-init.js');

function tempDir(): string {
  const dir = join(tmpdir(), `macf-repo-init-tokensource-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('repoInit — tokenSource threading (groundnuty/macf#920)', () => {
  let dir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = tempDir();
    mockGenerateToken.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  it('passes opts.tokenSource straight through to generateToken', async () => {
    mockGenerateToken.mockResolvedValue('ghs_fresh_from_tokensource');
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    const tokenSource = { appId: 'app-1', installId: 'install-1', keyPath: '/scratch/key.pem' };
    const result = await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent',
      force: false,
      tokenSource,
    });

    expect(mockGenerateToken).toHaveBeenCalledWith(tokenSource);
    expect(result.labels.status).toBe('ok');
  });

  it('the freshly-minted token (not a fallback) is what every label POST authenticates with', async () => {
    mockGenerateToken.mockResolvedValue('ghs_fresh_from_tokensource');
    const fetchMock = vi.fn().mockResolvedValue({ status: 201 });
    globalThis.fetch = fetchMock as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent',
      force: false,
      tokenSource: { appId: 'app-1', installId: 'install-1', keyPath: '/scratch/key.pem' },
    });

    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.headers).toMatchObject({ Authorization: 'Bearer ghs_fresh_from_tokensource' });
    }
  });

  it('a tokenSource that still fails to mint (e.g. clock drift) degrades to labels: {status:"skipped"} — never throws', async () => {
    mockGenerateToken.mockRejectedValue(new Error('JSON web token could not be decoded'));

    const result = await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      force: false,
      tokenSource: { appId: 'app-1', installId: 'install-1', keyPath: '/scratch/key.pem' },
    });

    expect(result.labels).toEqual({ status: 'skipped', reason: 'JSON web token could not be decoded' });
  });
});
