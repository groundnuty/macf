import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateWorkflow, generateAgentConfig, patchAgentConfig, createLabel, repoInit } from '../../src/cli/commands/repo-init.js';

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
      ssh_key_secret: 'AGENT_SSH_KEY',
      workspace_dir: '/home/ubuntu/repos/<owner>/<repo>',
    });
  });

  it('expands --agents list into entries with defaults (app_name unprefixed per #76)', () => {
    const json = generateAgentConfig(['code-agent', 'science-agent']);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.agents)).toEqual(['code-agent', 'science-agent']);
    // #76: app_name default is the agent name itself, not macf-<agent>.
    expect(parsed.agents['code-agent'].app_name).toBe('code-agent');
    expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
    expect(parsed.agents['science-agent'].app_name).toBe('science-agent');
  });

  it('includes ssh_key_secret in generated entries (required by routing workflow, #76)', () => {
    const json = generateAgentConfig(['code-agent']);
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].ssh_key_secret).toBe('AGENT_SSH_KEY');
  });

  it('includes default label_to_status block (#76)', () => {
    const json = generateAgentConfig(['code-agent']);
    const parsed = JSON.parse(json);
    expect(parsed.label_to_status).toEqual({
      'in-progress': 'In Progress',
      'in-review': 'In Review',
      'blocked': 'Blocked',
    });
  });

  it('populates workspace_dir default from owner/repo when defaults given (#71)', () => {
    const json = generateAgentConfig(
      ['code-agent'],
      undefined,
      { owner: 'groundnuty', repo: 'macf' },
    );
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].workspace_dir).toBe('/home/ubuntu/repos/groundnuty/macf');
  });

  it('omits workspace_dir when defaults are not provided (backward-compat callers)', () => {
    const json = generateAgentConfig(['code-agent']);
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent']).not.toHaveProperty('workspace_dir');
  });

  it('template (no --agents) includes a sample workspace_dir placeholder', () => {
    const json = generateAgentConfig([]);
    const parsed = JSON.parse(json);
    expect(parsed.agents['<agent-name>'].workspace_dir).toMatch(/^\/home\/.*\/repos\/.*\/.*/);
  });

  it('produces valid JSON', () => {
    expect(() => JSON.parse(generateAgentConfig([]))).not.toThrow();
    expect(() => JSON.parse(generateAgentConfig(['a', 'b']))).not.toThrow();
  });

  it('groups multiple agents into a shared session with per-agent windows when --session-name is given (#69)', () => {
    const json = generateAgentConfig(['code-agent', 'science-agent'], 'macf');
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].tmux_session).toBe('macf');
    expect(parsed.agents['code-agent'].tmux_window).toBe('code-agent');
    expect(parsed.agents['science-agent'].tmux_session).toBe('macf');
    expect(parsed.agents['science-agent'].tmux_window).toBe('science-agent');
  });

  it('omits tmux_window for a single agent even when --session-name is given', () => {
    // One agent means windowing is pure overhead — keep the simple layout.
    const json = generateAgentConfig(['code-agent'], 'macf');
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
    expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_window');
  });

  it('omits tmux_window when --session-name is not provided (backward compat)', () => {
    const json = generateAgentConfig(['code-agent', 'science-agent']);
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
    expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_window');
    expect(parsed.agents['science-agent'].tmux_session).toBe('science-agent');
    expect(parsed.agents['science-agent']).not.toHaveProperty('tmux_window');
  });
});

describe('patchAgentConfig (merge-preserving regenerate, #76)', () => {
  const existingConfig = () => ({
    agents: {
      'cv-architect': {
        app_name: 'cv-architect',
        host: '100.124.163.105',
        tmux_session: 'cv-architect',
        tmux_bin: 'tmux',
        ssh_user: 'ubuntu',
        ssh_key_secret: 'AGENT_SSH_KEY',
      },
      'cv-project-archaeologist': {
        app_name: 'cv-project-archaeologist',
        host: '100.124.163.105',
        tmux_session: 'cv-project-archaeologist',
        tmux_bin: 'tmux',
        ssh_user: 'ubuntu',
        ssh_key_secret: 'AGENT_SSH_KEY',
      },
    },
    label_to_status: {
      'in-progress': 'In Progress',
      'in-review': 'In Review',
      'blocked': 'Blocked',
    },
  });

  it('preserves app_name, host, ssh_key_secret, ssh_user on regenerate', () => {
    const existing = JSON.stringify(existingConfig(), null, 2);
    const patched = patchAgentConfig(existing,
      ['cv-architect', 'cv-project-archaeologist'], 'cv-project');
    const parsed = JSON.parse(patched);
    expect(parsed.agents['cv-architect'].app_name).toBe('cv-architect');
    expect(parsed.agents['cv-architect'].host).toBe('100.124.163.105');
    expect(parsed.agents['cv-architect'].ssh_key_secret).toBe('AGENT_SSH_KEY');
    expect(parsed.agents['cv-architect'].ssh_user).toBe('ubuntu');
  });

  it('updates tmux_session + adds tmux_window when --session-name with multiple agents', () => {
    const existing = JSON.stringify(existingConfig(), null, 2);
    const patched = patchAgentConfig(existing,
      ['cv-architect', 'cv-project-archaeologist'], 'cv-project');
    const parsed = JSON.parse(patched);
    expect(parsed.agents['cv-architect'].tmux_session).toBe('cv-project');
    expect(parsed.agents['cv-architect'].tmux_window).toBe('cv-architect');
    expect(parsed.agents['cv-project-archaeologist'].tmux_window).toBe('cv-project-archaeologist');
  });

  it('removes tmux_window when re-patching without --session-name (ungrouping)', () => {
    const existing = JSON.stringify({
      agents: {
        'cv-architect': {
          app_name: 'cv-architect', host: '100.0.0.1',
          tmux_session: 'cv-project', tmux_window: 'cv-architect',
          tmux_bin: 'tmux', ssh_user: 'ubuntu', ssh_key_secret: 'AGENT_SSH_KEY',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(existing, ['cv-architect']);
    const parsed = JSON.parse(patched);
    expect(parsed.agents['cv-architect'].tmux_session).toBe('cv-architect');
    expect(parsed.agents['cv-architect']).not.toHaveProperty('tmux_window');
  });

  it('preserves top-level label_to_status and unknown top-level fields', () => {
    const withExtras = {
      ...existingConfig(),
      custom_field: 'user added',
      routing_policy: { debounce_ms: 500 },
    };
    const patched = patchAgentConfig(
      JSON.stringify(withExtras, null, 2),
      ['cv-architect'], 'cv-project',
    );
    const parsed = JSON.parse(patched);
    expect(parsed.label_to_status).toEqual(withExtras.label_to_status);
    expect(parsed.custom_field).toBe('user added');
    expect(parsed.routing_policy).toEqual({ debounce_ms: 500 });
  });

  it('leaves agents NOT in --agents list unchanged', () => {
    const patched = patchAgentConfig(
      JSON.stringify(existingConfig(), null, 2),
      ['cv-architect'], 'cv-project',
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents).toHaveProperty('cv-project-archaeologist');
    expect(parsed.agents['cv-project-archaeologist'].host).toBe('100.124.163.105');
  });

  it('adds fresh entries for new agents while preserving old ones', () => {
    const patched = patchAgentConfig(
      JSON.stringify(existingConfig(), null, 2),
      ['cv-architect', 'writing-agent'], 'cv-project',
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents['writing-agent']).toBeDefined();
    expect(parsed.agents['writing-agent'].host).toBe('<agent-host-ip>');
    expect(parsed.agents['cv-architect'].host).toBe('100.124.163.105');
    expect(parsed.agents['writing-agent'].tmux_window).toBe('writing-agent');
  });

  it('injects ssh_key_secret default when old config lacks it', () => {
    const oldConfig = {
      agents: {
        'code-agent': {
          app_name: 'code-agent', host: '100.0.0.1',
          tmux_session: 'code-agent', tmux_bin: 'tmux', ssh_user: 'ubuntu',
        },
      },
    };
    const patched = patchAgentConfig(JSON.stringify(oldConfig, null, 2), ['code-agent']);
    const parsed = JSON.parse(patched);
    expect(parsed.agents['code-agent'].ssh_key_secret).toBe('AGENT_SSH_KEY');
  });

  it('throws on malformed JSON rather than overwriting', () => {
    expect(() => patchAgentConfig('{ not valid', ['a'])).toThrow(/not valid JSON/);
  });

  it('throws when the existing file has no agents key', () => {
    expect(() =>
      patchAgentConfig(JSON.stringify({ other: 'thing' }), ['a']),
    ).toThrow(/no `agents` object/);
  });

  it('injects workspace_dir default when an old entry lacks it (#71)', () => {
    // Config predates #71 — no workspace_dir field. Patch should upgrade
    // it so the routing workflow can invoke the helper.
    const existing = JSON.stringify({
      agents: {
        'code-agent': {
          app_name: 'code-agent',
          host: '100.0.0.1',
          tmux_session: 'code-agent',
          tmux_bin: 'tmux',
          ssh_user: 'ubuntu',
          ssh_key_secret: 'AGENT_SSH_KEY',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(
      existing, ['code-agent'], undefined,
      { owner: 'groundnuty', repo: 'macf' },
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents['code-agent'].workspace_dir)
      .toBe('/home/ubuntu/repos/groundnuty/macf');
  });

  it('preserves user-customized workspace_dir on patch', () => {
    const existing = JSON.stringify({
      agents: {
        'code-agent': {
          app_name: 'code-agent',
          host: '100.0.0.1',
          tmux_session: 'code-agent',
          tmux_bin: 'tmux',
          ssh_user: 'ubuntu',
          ssh_key_secret: 'AGENT_SSH_KEY',
          workspace_dir: '/custom/path/to/workspace',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(
      existing, ['code-agent'], undefined,
      { owner: 'groundnuty', repo: 'macf' },
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents['code-agent'].workspace_dir).toBe('/custom/path/to/workspace');
  });

  it('respects ssh_user when computing default workspace_dir (not hardcoded ubuntu)', () => {
    const existing = JSON.stringify({
      agents: {
        'code-agent': {
          app_name: 'code-agent',
          host: '100.0.0.1',
          tmux_session: 'code-agent',
          tmux_bin: 'tmux',
          ssh_user: 'deploy',  // non-default
          ssh_key_secret: 'AGENT_SSH_KEY',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(
      existing, ['code-agent'], undefined,
      { owner: 'groundnuty', repo: 'macf' },
    );
    const parsed = JSON.parse(patched);
    expect(parsed.agents['code-agent'].workspace_dir)
      .toBe('/home/deploy/repos/groundnuty/macf');
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

  it('adds new agents to existing config WITHOUT --force (#82)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    // First run: create config with one agent.
    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent',
      force: false,
    });

    // Customize the entry to simulate user-edited fields.
    const configPath = join(dir, '.github', 'agent-config.json');
    const config1 = JSON.parse(readFileSync(configPath, 'utf-8'));
    config1.agents['code-agent'].host = '100.0.0.5';
    config1.agents['code-agent'].app_name = 'custom-app-name';
    writeFileSync(configPath, JSON.stringify(config1, null, 2) + '\n');

    // Second run: add a second agent, no --force.
    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'code-agent,science-agent',
      force: false,
    });

    const config2 = JSON.parse(readFileSync(configPath, 'utf-8'));
    // Both agents present.
    expect(Object.keys(config2.agents).sort()).toEqual(['code-agent', 'science-agent']);
    // User-customized fields preserved on code-agent.
    expect(config2.agents['code-agent'].host).toBe('100.0.0.5');
    expect(config2.agents['code-agent'].app_name).toBe('custom-app-name');
    // New agent has defaults.
    expect(config2.agents['science-agent'].host).toBe('<agent-host-ip>');
  });

  it('--session-name applied on existing config WITHOUT --force (#82)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    // Create config with two un-grouped agents.
    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'a,b',
      force: false,
    });

    // Re-run with --session-name, no --force.
    await repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v1',
      agents: 'a,b',
      sessionName: 'proj',
      force: false,
    });

    const config = JSON.parse(readFileSync(join(dir, '.github', 'agent-config.json'), 'utf-8'));
    expect(config.agents['a'].tmux_session).toBe('proj');
    expect(config.agents['a'].tmux_window).toBe('a');
    expect(config.agents['b'].tmux_session).toBe('proj');
    expect(config.agents['b'].tmux_window).toBe('b');
  });

  it('workflow file still respects --force semantic even after #82', async () => {
    // #82 only loosens the CONFIG file's --force gate; workflow stays gated.
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v1', force: false });

    // Second run: change actionsVersion, no --force.
    await repoInit(dir, { repo: 'owner/r', actionsVersion: 'v2', force: false });
    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('@v1'); // unchanged because of --force gate
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
