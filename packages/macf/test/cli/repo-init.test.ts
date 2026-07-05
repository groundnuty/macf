import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateWorkflow, generateAgentConfig, patchAgentConfig, createLabel, repoInit, isV3PlusActionsVersion } from '../../src/cli/commands/repo-init.js';

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

  it('includes all five event triggers', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('issues:');
    expect(yaml).toContain('issue_comment:');
    expect(yaml).toContain('pull_request:');
    expect(yaml).toContain('pull_request_review:');
    expect(yaml).toContain('check_suite:');
  });

  it('uses secrets: inherit', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('secrets: inherit');
  });

  // macf#797 — the icsoc routing outage root cause: a generated router with NO
  // permissions block fails the reusable-workflow call at composition with
  // `startup_failure`, so nothing ever routes. The block must be present for
  // every pin, sit between `on:` and `jobs:`, and match macf's own router.
  it('emits the permissions block the reusable workflow requires (macf#797)', () => {
    const yaml = generateWorkflow('v1');
    expect(yaml).toContain('\npermissions:\n');
    expect(yaml).toContain('  contents: read');
    expect(yaml).toContain('  issues: write');
    expect(yaml).toContain('  pull-requests: read');
    expect(yaml).toContain('  checks: read');
    // Ordering: permissions after the on: triggers, before jobs.
    expect(yaml.indexOf('permissions:')).toBeGreaterThan(yaml.indexOf('check_suite:'));
    expect(yaml.indexOf('permissions:')).toBeLessThan(yaml.indexOf('jobs:'));
  });

  it('emits the permissions block for a v3+ pin too', () => {
    const yaml = generateWorkflow('v3.4.1', {
      project: 'macf',
      registryApiPath: '/repos/groundnuty/groundnuty',
    });
    expect(yaml).toContain('\npermissions:\n');
    expect(yaml).toContain('  issues: write');
    expect(yaml).toContain('  checks: read');
    // permissions is caller-side, not a reusable-workflow input, so it precedes with:
    expect(yaml.indexOf('permissions:')).toBeLessThan(yaml.indexOf('with:'));
  });

  // macf#566 — v3+ pins must emit the `with: { project, registry-api-path }`
  // block; v1.x pins must not (the v1 reusable workflow declares no inputs).
  it('emits a v3 with: block (project + registry-api-path) for a v3.3.0 pin', () => {
    const yaml = generateWorkflow('v3.3.0', {
      project: 'macf',
      registryApiPath: '/repos/groundnuty/groundnuty',
    });
    expect(yaml).toContain('uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3.3.0');
    expect(yaml).toContain('\n    with:\n');
    expect(yaml).toContain('\n      project: macf\n');
    expect(yaml).toContain('\n      registry-api-path: /repos/groundnuty/groundnuty\n');
    expect(yaml).toContain('secrets: inherit');
    // well-formed YAML: no tabs; with: nested under route: between uses: and secrets:
    expect(yaml).not.toContain('\t');
    expect(yaml.indexOf('with:')).toBeGreaterThan(yaml.indexOf('uses:'));
    expect(yaml.indexOf('with:')).toBeLessThan(yaml.indexOf('secrets: inherit'));
  });

  it('treats the bare v3 tag as v3+ (with: block present)', () => {
    const yaml = generateWorkflow('v3', { project: 'p', registryApiPath: '/orgs/acme' });
    expect(yaml).toContain('    with:');
    expect(yaml).toContain('      project: p');
    expect(yaml).toContain('      registry-api-path: /orgs/acme');
  });

  it('treats main as v3+ (with: block present)', () => {
    const yaml = generateWorkflow('main', { project: 'p', registryApiPath: '/orgs/acme' });
    expect(yaml).toContain('    with:');
    expect(yaml).toContain('      registry-api-path: /orgs/acme');
  });

  it('omits with: for a v1 pin even when v3 inputs are passed (back-compat)', () => {
    const yaml = generateWorkflow('v1', { project: 'p', registryApiPath: '/repos/o/r' });
    expect(yaml).not.toContain('with:');
    expect(yaml).not.toContain('project:');
    expect(yaml).not.toContain('registry-api-path:');
    expect(yaml).toContain('secrets: inherit');
  });

  it('omits with: for v2.x pins (back-compat)', () => {
    const yaml = generateWorkflow('v2.0.1', { project: 'p', registryApiPath: '/repos/o/r' });
    expect(yaml).not.toContain('with:');
  });

  it('omits with: on a v3 pin when no v3 inputs are supplied', () => {
    const yaml = generateWorkflow('v3.3.0');
    expect(yaml).not.toContain('with:');
    expect(yaml).toContain('@v3.3.0');
    expect(yaml).toContain('secrets: inherit');
  });
});

describe('isV3PlusActionsVersion (macf#566)', () => {
  it.each([
    ['v1', false],
    ['v1.3', false],
    ['v1.3.1', false],
    ['v2', false],
    ['v2.0.1', false],
    ['v3', true],
    ['v3.0', true],
    ['v3.3.0', true],
    ['v4', true],
    ['main', true],
  ] as const)('%s -> %s', (ver, expected) => {
    expect(isV3PlusActionsVersion(ver)).toBe(expected);
  });

  it('returns false for non-tag refs other than main', () => {
    expect(isV3PlusActionsVersion('some-branch')).toBe(false);
    expect(isV3PlusActionsVersion('v3-rc1')).toBe(false);
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

  // macf#806 / DR-032: app_name is the GitHub App HANDLE (`<project>-<agent>`),
  // not the bare routing label — the v3 router matches `${app_name}[bot]`
  // against a PR/mention participant's login, so a consumer fleet (handle !=
  // routing label) needs the prefixed handle here or route-by-mention /
  // route-by-pr-review-state resolve nothing. The map KEY stays the bare
  // routing label; NO `[bot]` suffix (the router appends it).
  it('app_name is the <project>-<agent> App handle when project is given (macf#806)', () => {
    const json = generateAgentConfig(
      ['code-agent', 'science-agent'],
      undefined,
      { project: 'icsoc-2026' },
    );
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.agents)).toEqual(['code-agent', 'science-agent']);
    expect(parsed.agents['code-agent'].app_name).toBe('icsoc-2026-code-agent');
    expect(parsed.agents['science-agent'].app_name).toBe('icsoc-2026-science-agent');
    // key is still the bare routing label (the route-by-label / agent-config key)
    expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
  });

  it('app_name stays the bare agent when defaults carry no project (back-compat, #76)', () => {
    const json = generateAgentConfig(['code-agent'], undefined, { owner: 'o', repo: 'r' });
    const parsed = JSON.parse(json);
    expect(parsed.agents['code-agent'].app_name).toBe('code-agent');
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

  describe('omitTmuxSession (v3+ registry-routed, macf#678)', () => {
    it('omits the vestigial tmux_session from generated entries but keeps app_name/host/ssh fields', () => {
      const json = generateAgentConfig(
        ['code-agent', 'science-agent'],
        undefined,
        undefined,
        true,
      );
      const parsed = JSON.parse(json);
      expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_session');
      expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_window');
      // app_name is still asserted by routing-doctor's SELF-SKIP check on v3 —
      // only tmux_session is vestigial, the entry itself is not.
      expect(parsed.agents['code-agent'].app_name).toBe('code-agent');
      expect(parsed.agents['code-agent'].ssh_key_secret).toBe('AGENT_SSH_KEY');
      expect(parsed.agents['science-agent']).not.toHaveProperty('tmux_session');
    });

    it('omits tmux_session even with a --session-name (windowing is moot without a session)', () => {
      const json = generateAgentConfig(['code-agent', 'science-agent'], 'macf', undefined, true);
      const parsed = JSON.parse(json);
      expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_session');
      expect(parsed.agents['code-agent']).not.toHaveProperty('tmux_window');
    });

    it('omits the tmux_session placeholder from the empty (no --agents) template', () => {
      const json = generateAgentConfig([], undefined, undefined, true);
      const parsed = JSON.parse(json);
      expect(parsed.agents['<agent-name>']).not.toHaveProperty('tmux_session');
      expect(parsed.agents['<agent-name>'].app_name).toBe('<github-app-name>');
    });

    it('default (omitTmuxSession=false) keeps the v1.x send-target (SSH routing reads it)', () => {
      const parsed = JSON.parse(generateAgentConfig(['code-agent']));
      expect(parsed.agents['code-agent'].tmux_session).toBe('code-agent');
    });
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

  it('deletes the vestigial tmux_session/tmux_window on a v3+ re-patch (omitTmuxSession, macf#678)', () => {
    // The substrate scenario: a leftover Stage-2 tmux_session ("cv-architect")
    // that drives routing-doctor's false SESSION WARN. Re-running repo-init at
    // v3 sheds it → doctor reads `absent` → PASS.
    const existing = JSON.stringify({
      agents: {
        'cv-architect': {
          app_name: 'cv-architect', host: '100.0.0.1',
          tmux_session: 'cv-architect', tmux_window: 'cv-architect',
          tmux_bin: 'tmux', ssh_user: 'ubuntu', ssh_key_secret: 'AGENT_SSH_KEY',
        },
      },
    }, null, 2);
    const patched = patchAgentConfig(existing, ['cv-architect'], undefined, undefined, true);
    const parsed = JSON.parse(patched);
    expect(parsed.agents['cv-architect']).not.toHaveProperty('tmux_session');
    expect(parsed.agents['cv-architect']).not.toHaveProperty('tmux_window');
    // Non-session fields survive the patch untouched.
    expect(parsed.agents['cv-architect'].app_name).toBe('cv-architect');
    expect(parsed.agents['cv-architect'].host).toBe('100.0.0.1');
  });

  it('creates fresh v3+ entries without a tmux_session (omitTmuxSession, macf#678)', () => {
    const existing = JSON.stringify({ agents: {} }, null, 2);
    const patched = patchAgentConfig(existing, ['writing-agent'], undefined,
      { owner: 'groundnuty', repo: 'macf' }, true);
    const parsed = JSON.parse(patched);
    expect(parsed.agents['writing-agent']).not.toHaveProperty('tmux_session');
    expect(parsed.agents['writing-agent'].app_name).toBe('writing-agent');
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

  // macf#566 — v3 caller generation (project + registry-api-path).
  it('v3 pin defaults project to repo name + repo-scoped registry-api-path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/test-repo',
      actionsVersion: 'v3.3.0',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('@v3.3.0');
    expect(wf).toContain('    with:');
    expect(wf).toContain('      project: test-repo');
    expect(wf).toContain('      registry-api-path: /repos/owner/test-repo');
  });

  // macf#797 — a floating v3+ pin is resolved to an immutable full tag at
  // generation time, so the born router never silently receives a behavioral
  // change within the major.
  it('resolves a floating v3 pin to the latest immutable full tag (macf#797)', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('macf-actions/tags')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ name: 'v3.4.1' }, { name: 'v3.4.0' }, { name: 'v3.3.0' }, { name: 'v3' }],
        });
      }
      return Promise.resolve({ status: 201, ok: true }); // label creation
    }) as typeof fetch;

    await repoInit(dir, { repo: 'owner/test-repo', actionsVersion: 'v3', force: false });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('agent-router.yml@v3.4.1');
    expect(wf).not.toContain('agent-router.yml@v3\n'); // NOT the floating ref
    expect(wf).toContain('      project: test-repo'); // v3 inputs still emitted
    expect(wf).toContain('\npermissions:\n');
  });

  it('keeps the floating pin (no crash) when tag resolution is offline (macf#797)', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('macf-actions/tags')) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      return Promise.resolve({ status: 201, ok: true }); // label creation
    }) as typeof fetch;

    await expect(
      repoInit(dir, { repo: 'owner/test-repo', actionsVersion: 'v3', force: false }),
    ).resolves.toBeUndefined();

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('agent-router.yml@v3\n'); // degraded to floating ref
    expect(wf).toContain('\npermissions:\n'); // still a valid, permissioned router
  });

  it('v3 pin + profile scope emits /repos/<user>/<user>', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, {
      repo: 'groundnuty/macf',
      actionsVersion: 'v3.3.0',
      registryType: 'profile',
      registryUser: 'groundnuty',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('      project: macf');
    expect(wf).toContain('      registry-api-path: /repos/groundnuty/groundnuty');
  });

  it('v3 pin + org scope emits /orgs/<org>', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, {
      repo: 'acme/widget',
      actionsVersion: 'v3.3.0',
      registryType: 'org',
      registryOrg: 'acme',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('      registry-api-path: /orgs/acme');
  });

  it('v3 pin honours an explicit --project override', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/some-repo',
      actionsVersion: 'v3.3.0',
      project: 'academic-resume',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('      project: academic-resume');
  });

  it('v1 pin emits no v3 with: block (back-compat preserved)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await repoInit(dir, {
      repo: 'owner/test-repo',
      actionsVersion: 'v1',
      force: false,
    });

    const wf = readFileSync(join(dir, '.github', 'workflows', 'agent-router.yml'), 'utf-8');
    expect(wf).toContain('@v1');
    expect(wf).not.toContain('with:');
    expect(wf).not.toContain('registry-api-path:');
  });

  it('v3 pin + org scope without --registry-org throws', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await expect(repoInit(dir, {
      repo: 'acme/widget',
      actionsVersion: 'v3.3.0',
      registryType: 'org',
      force: false,
    })).rejects.toThrow('--registry-org required');
  });

  it('v3 pin + local scope is rejected (no GitHub-Actions routing path)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as typeof fetch;

    await expect(repoInit(dir, {
      repo: 'owner/r',
      actionsVersion: 'v3.3.0',
      registryType: 'local',
      force: false,
    })).rejects.toThrow('local registry has no GitHub-Actions routing path');
  });
});
