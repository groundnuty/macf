import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateWorkflow, generateAgentConfig, createLabel, repoInit } from '../../src/cli/commands/repo-init.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-repo-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('generateWorkflow', () => {
  it('templates the actions version correctly', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('@v1');
    expect(yaml).toContain('uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v1');
  });

  it('supports v1.0.0 version', () => {
    const yaml = generateWorkflow('v1.0.0');
    expect(yaml).toContain('@v1.0.0');
  });

  it('includes all four event triggers', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('issues:');
    expect(yaml).toContain('issue_comment:');
    expect(yaml).toContain('pull_request:');
    expect(yaml).toContain('pull_request_review:');
  });

  it('uses secrets: inherit', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('secrets: inherit');
  });
});

describe('generateAgentConfig', () => {
  it('generates template when no agents given', () => {
    const json = generateAgentConfig([]);
    const parsed = JSON.parse(json);
    expect(parsed.agents).toHaveProperty('<agent-name>');
    expect(parsed.agents['<agent-name>']).toEqual({
      app_name: '<github-app-name>',
      host: '<agent-host-ip>',
      tmux_session: '<tmux-session-name>',
      ssh_user: 'ubuntu',
      tmux_bin: 'tmux',
    });
  });

  it('expands --agents list into entries with defaults', () => {
    const json = generateAgentConfig(['code-agent', 'science-agent']);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.agents)).toEqual(['code-agent', 'science-agent']);
    expect(parsed.agents['code-agent'].app_name).toBe('macf-code-agent');
    expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
    expect(parsed.agents['science-agent'].app_name).toBe('macf-science-agent');
  });

  it('does NOT include dead ssh_key_secret field', () => {
    const json = generateAgentConfig(['code-agent']);
    expect(json).not.toContain('ssh_key_secret');
  });

  it('produces valid JSON', () => {
    expect(() => JSON.parse(generateAgentConfig([]))).not.toThrow();
    expect(() => JSON.parse(generateAgentConfig(['a', 'b']))).not.toThrow();
  });
});

describe('createLabel', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns "created" on 201', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;
    const result = await createLabel('owner', 'repo', 'token', {
      name: 'test', color: 'fbca04', description: 'Test label',
    });
    expect(result).toBe('created');
  });

  it('returns "exists" on 422', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 422 }) as typeof fetch;
    const result = await createLabel('owner', 'repo', 'token', {
      name: 'test', color: 'fbca04', description: 'Test label',
    });
    expect(result).toBe('exists');
  });

  it('returns "failed" on other errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 403 }) as typeof fetch;
    const result = await createLabel('owner', 'repo', 'token', {
      name: 'test', color: 'fbca04', description: 'Test label',
    });
    expect(result).toBe('failed');
  });

  it('sends correct POST payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 201 });
    globalThis.fetch = fetchMock as typeof fetch;

    await createLabel('groundnuty', 'macf', 'tok-123', {
      name: 'code-agent', color: '1d76db', description: 'Assigned to code-agent',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/groundnuty/macf/labels',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer tok-123',
          'Accept': 'application/vnd.github+json',
        }),
        body: expect.stringContaining('"name":"code-agent"'),
      }),
    );
  });
});

describe('repoInit integration', () => {
  let dir: string;
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    dir = tempDir();
    process.env['GH_TOKEN'] = 'test-token';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('creates workflow and config files', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/test-repo',
      actionsVersion: 'v1',
      force: false,
    });

    expect(existsSync(join(dir, '.github', 'workflows', 'agent-router.yml'))).toBe(true);
    expect(existsSync(join(dir, '.github', 'agent-config.json'))).toBe(true);
  });

  it('writes correct workflow content', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/test-repo',
      actionsVersion: 'v1.0.0',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('@v1.0.0');
    expect(wf).toContain('secrets: inherit');
  });

  it('skips existing files without --force', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    // First run
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v1', force: false });
    const firstContent = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');

    // Second run without --force should skip
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v2', force: false });
    const secondContent = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(secondContent).toBe(firstContent); // unchanged
  });

  it('overwrites with --force', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v1', force: false });
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v2', force: true });

    const content = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(content).toContain('@v2');
  });

  it('expands --agents into config entries', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent,science-agent',
      force: false,
    });

    const config = JSON.parse(readFileSync(join(dir, '.github', 'agent-config.json'), 'utf-8'));
    expect(Object.keys(config.agents)).toEqual(['code-agent', 'science-agent']);
  });

  it('throws on invalid repo format', async () => {
    await expect(repoInit(dir, {
      repo: 'no-slash',
      actionsVersion: 'v1',
      force: false,
    })).rejects.toThrow('owner/repo');
  });

  it('creates status + agent labels via GitHub API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 201 });
    globalThis.fetch = fetchMock as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent,science-agent',
      force: false,
    });

    // 4 status labels + 2 agent labels = 6 API calls
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('handles 422 (label already exists) gracefully', async () => {
    // First two calls succeed, next return 422
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValue({ status: 422 });
    globalThis.fetch = fetchMock as typeof fetch;

    // Should not throw
    await expect(repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      force: false,
    })).resolves.toBeUndefined();
  });

  it('continues without labels when token fails', async () => {
    delete process.env['GH_TOKEN'];
    delete process.env['APP_ID'];

    // Should not throw — prints warning and continues
    await expect(repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      force: false,
    })).resolves.toBeUndefined();

    // Files should still be created
    expect(existsSync(join(dir, '.github', 'workflows', 'agent-router.yml'))).toBe(true);
  });
});
