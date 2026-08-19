import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initAgent } from '../../src/cli/commands/init.js';
import { readAgentConfig } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('macf init', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates .macf directory structure', async () => {
    await initAgent(dir, {
      project: 'TEST',
      role: 'code-agent',
      appId: '123',
      installId: '456',
      keyPath: '.key.pem',
      registryType: 'repo',
      registryRepo: 'owner/repo',
    });

    expect(existsSync(join(dir, '.macf'))).toBe(true);
    expect(existsSync(join(dir, '.macf', 'certs'))).toBe(true);
    expect(existsSync(join(dir, '.macf', 'logs'))).toBe(true);
    expect(existsSync(join(dir, '.macf', 'plugin'))).toBe(true);
  });

  // groundnuty/macf#995 (DR-022 Amendment P): a fresh init writes .mcp.json
  // with the pinned channel-server + strips mcpServers from the fetched
  // local plugin.json copy. Piggybacks on the network-hitting plugin-fetch
  // test above's sibling below (own `dir`, but still one initAgent() call —
  // this file's convention is to keep network-hitting initAgent() calls to
  // a minimum, not to zero, per the comment on the routing_label test).
  it('writes .mcp.json with the pinned channel-server + strips plugin.json mcpServers (macf#995)', async () => {
    await initAgent(dir, {
      project: 'TEST',
      role: 'code-agent',
      appId: '123',
      installId: '456',
      keyPath: '.key.pem',
      registryType: 'repo',
      registryRepo: 'owner/repo',
    });

    const cliVersion = readAgentConfig(dir)!.versions!.cli;

    const mcpJsonPath = join(dir, '.mcp.json');
    expect(existsSync(mcpJsonPath)).toBe(true);
    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as {
      mcpServers: { 'macf-agent': { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(mcpJson.mcpServers['macf-agent'].command).toBe('npx');
    expect(mcpJson.mcpServers['macf-agent'].args).toContain(`@groundnuty/macf-channel-server@${cliVersion}`);
    // OTEL env block present, not assumed inherited across the MCP spawn
    // boundary (macf#422).
    expect(mcpJson.mcpServers['macf-agent'].env['OTEL_SERVICE_NAME']).toBe('macf-agent-code-agent');
    // No secret/credential leakage into a committed workspace file.
    expect(Object.keys(mcpJson.mcpServers['macf-agent'].env)).not.toContain('GH_TOKEN');

    // The fetched local plugin.json copy no longer carries mcpServers — the
    // channel-server mounts via .mcp.json only, never both (macf#995).
    const pluginManifestPath = join(dir, '.macf', 'plugin', '.claude-plugin', 'plugin.json');
    if (existsSync(pluginManifestPath)) {
      const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf-8')) as Record<string, unknown>;
      expect(pluginManifest['mcpServers']).toBeUndefined();
    }
  });

  it('writes routing_label to config when --routing-label is provided (macf#545)', async () => {
    // Single init (these tests hit the network for the plugin fetch — keep it
    // to one). The omitted→undefined case is covered by the next test, which
    // inits without routingLabel.
    await initAgent(dir, {
      project: 'MACF',
      role: 'devops-agent',
      name: 'macf-devops-agent',
      routingLabel: 'devops-agent',
      appId: '1',
      installId: '2',
      keyPath: 'k.pem',
      registryType: 'repo',
      registryRepo: 'owner/repo',
    });
    expect(readAgentConfig(dir)!.routing_label).toBe('devops-agent');
  });

  it('writes macf-agent.json with correct content', async () => {
    await initAgent(dir, {
      project: 'MACF',
      role: 'science-agent',
      name: 'my-agent',
      appId: '111',
      installId: '222',
      keyPath: 'app.pem',
      registryType: 'org',
      registryOrg: 'my-org',
    });

    const config = readAgentConfig(dir);
    expect(config).not.toBeNull();
    expect(config!.agent_name).toBe('my-agent');
    expect(config!.agent_role).toBe('science-agent');
    expect(config!.project).toBe('MACF');
    expect(config!.registry).toEqual({ type: 'org', org: 'my-org' });
    // macf#545: routing_label omitted when --routing-label not given → undefined
    // (consumers default to agent_name; inert).
    expect(config!.routing_label).toBeUndefined();
  });

  it('defaults agent name to role', async () => {
    await initAgent(dir, {
      project: 'P',
      role: 'code-agent',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const config = readAgentConfig(dir);
    expect(config!.agent_name).toBe('code-agent');
  });

  it('generates claude.sh', async () => {
    await initAgent(dir, {
      project: 'TEST',
      role: 'agent',
      appId: '1',
      installId: '2',
      keyPath: 'k.pem',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const claudeSh = join(dir, 'claude.sh');
    expect(existsSync(claudeSh)).toBe(true);
    const content = readFileSync(claudeSh, 'utf-8');
    // Post-#342 PR-B: claude.sh is a thin source-then-exec template.
    // Identity vars + CA paths live in .claude/.macf/env.identity +
    // env.certs respectively — claude.sh sources them via the loop.
    expect(content).toContain('exec claude');
    expect(content).toContain('for f in "$SCRIPT_DIR/.claude/.macf"/env.*');

    // Per-project CA path (PR #36) — now in env.certs.
    const certsContent = readFileSync(join(dir, '.claude', '.macf', 'env.certs'), 'utf-8');
    expect(certsContent).toContain('MACF_CA_CERT="$HOME/.macf/certs/TEST/ca-cert.pem"');

    // 3-layer chain for MACF_AGENT_NAME (post-#313) — now in env.identity.
    const identityContent = readFileSync(join(dir, '.claude', '.macf', 'env.identity'), 'utf-8');
    expect(identityContent).toContain('MACF_AGENT_NAME="${MACF_AGENT_NAME:-agent}"');
    expect(identityContent).toContain('export MACF_AGENT_NAME');

    // host-prelude.sh (DR-031 piece 4) is written + sourced first by claude.sh.
    // Backend depends on the host (devbox / brew / none); only assert presence
    // + the managed header so the test is host-toolchain-agnostic.
    const hostPreludePath = join(dir, '.claude', '.macf', 'host-prelude.sh');
    expect(existsSync(hostPreludePath)).toBe(true);
    expect(readFileSync(hostPreludePath, 'utf-8')).toContain('managed by `macf`');
    expect(content).toContain(
      '[ -f "$SCRIPT_DIR/.claude/.macf/host-prelude.sh" ] && source "$SCRIPT_DIR/.claude/.macf/host-prelude.sh"',
    );
  });

  it('seeds the project-tier rules subdir with a generic .example (macf#501)', async () => {
    await initAgent(dir, {
      project: 'TEST',
      role: 'code-agent',
      appId: '1',
      installId: '2',
      keyPath: 'k.pem',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const seed = join(dir, '.claude', 'rules', 'project', 'EXAMPLE.project-rule.md.example');
    expect(existsSync(seed)).toBe(true);
    const content = readFileSync(seed, 'utf-8');
    // Generic — must self-document the tier but NOT carry a macf-specific rule
    // (init ships to every deployment).
    expect(content).toContain('project-tier');
    expect(content).toContain('MACF_PROJECT_RULES_SOURCE');
    expect(content).not.toContain('dev.mk');

    // The seed must NOT shadow the flat universal-rule dir — universal rules
    // (coordination.md) stay at .claude/rules/, project rules go in the subdir.
    expect(existsSync(join(dir, '.claude', 'rules', 'coordination.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'rules', 'project', 'coordination.md'))).toBe(false);
  });

  it('writes env.project-rules with MACF_PROJECT_RULES_SOURCE unset by default (macf#501)', async () => {
    await initAgent(dir, {
      project: 'TEST',
      role: 'code-agent',
      appId: '1',
      installId: '2',
      keyPath: 'k.pem',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const envFile = join(dir, '.claude', '.macf', 'env.project-rules');
    expect(existsSync(envFile)).toBe(true);
    const content = readFileSync(envFile, 'utf-8');
    expect(content).toContain('MACF_PROJECT_RULES_SOURCE');
    // No active export by default.
    for (const line of content.split('\n')) {
      if (line.includes('export MACF_PROJECT_RULES_SOURCE')) {
        expect(line.trimStart().startsWith('#')).toBe(true);
      }
    }
  });

  it('adds .macf/ to .gitignore', async () => {
    await initAgent(dir, {
      project: 'T',
      role: 'a',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.macf/');
  });

  it('does not duplicate .macf/ in existing .gitignore', async () => {
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(dir, '.gitignore'), '.macf/\nnode_modules/\n');

    await initAgent(dir, {
      project: 'T',
      role: 'a',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'repo',
      registryRepo: 'o/r',
    });

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/\.macf\//g);
    expect(matches).toHaveLength(1);
  });

  it('rejects missing required registry options', async () => {
    await expect(initAgent(dir, {
      project: 'T',
      role: 'a',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'org',
      // missing registryOrg
    })).rejects.toThrow('--registry-org');
  });

  it('supports profile registry type', async () => {
    await initAgent(dir, {
      project: 'T',
      role: 'a',
      appId: '1',
      installId: '2',
      keyPath: 'k',
      registryType: 'profile',
      registryUser: 'groundnuty',
    });

    const config = readAgentConfig(dir);
    expect(config!.registry).toEqual({ type: 'profile', user: 'groundnuty' });
  });

  describe('input validation (#105)', () => {
    // claude.sh embeds appId / installId / keyPath / project into a
    // shell double-quoted string via template literal. Validate at
    // init so bad inputs are rejected before any workspace state is
    // written, not caught later when claude.sh is run and fails
    // opaquely.

    const validBase = {
      project: 'T',
      role: 'a',
      appId: '12345',
      installId: '67890',
      keyPath: 'app.key.pem',
      registryType: 'repo',
      registryRepo: 'o/r',
    } as const;

    it('rejects non-numeric appId', async () => {
      await expect(initAgent(dir, { ...validBase, appId: '123abc' }))
        .rejects.toThrow(/appId.*numeric|numeric.*appId/i);
    });

    it('rejects appId with shell-special chars', async () => {
      await expect(initAgent(dir, { ...validBase, appId: '123"$x' }))
        .rejects.toThrow(/appId/);
    });

    it('rejects empty appId', async () => {
      await expect(initAgent(dir, { ...validBase, appId: '' }))
        .rejects.toThrow(/appId/);
    });

    it('rejects non-numeric installId', async () => {
      await expect(initAgent(dir, { ...validBase, installId: 'abc' }))
        .rejects.toThrow(/installId.*numeric|numeric.*installId/i);
    });

    it('rejects keyPath with double-quote', async () => {
      await expect(initAgent(dir, { ...validBase, keyPath: 'path"injection' }))
        .rejects.toThrow(/keyPath/);
    });

    it('rejects keyPath with $', async () => {
      await expect(initAgent(dir, { ...validBase, keyPath: 'path$HOME/evil' }))
        .rejects.toThrow(/keyPath/);
    });

    it('rejects keyPath with backtick', async () => {
      await expect(initAgent(dir, { ...validBase, keyPath: 'path`cmd`' }))
        .rejects.toThrow(/keyPath/);
    });

    it('rejects keyPath with newline', async () => {
      await expect(initAgent(dir, { ...validBase, keyPath: 'path\nextra' }))
        .rejects.toThrow(/keyPath/);
    });

    it('rejects project with slash', async () => {
      await expect(initAgent(dir, { ...validBase, project: 'bad/name' }))
        .rejects.toThrow(/project/);
    });

    it('rejects project with shell-special char', async () => {
      await expect(initAgent(dir, { ...validBase, project: 'bad$name' }))
        .rejects.toThrow(/project/);
    });

    it('rejects role with shell-special char (ultrareview C2)', async () => {
      // role is interpolated into claude.sh exports the same way
      // project is — without this check, --role 'foo"$(evil)' would
      // produce a shell-injection-vulnerable launcher on `claude.sh`
      // source.
      await expect(initAgent(dir, { ...validBase, role: 'bad"injection' }))
        .rejects.toThrow(/role/);
    });

    it('rejects role with backtick', async () => {
      await expect(initAgent(dir, { ...validBase, role: 'bad`cmd`' }))
        .rejects.toThrow(/role/);
    });

    it('rejects name with shell-special char (ultrareview C2)', async () => {
      await expect(initAgent(dir, { ...validBase, name: 'bad$name' }))
        .rejects.toThrow(/name/);
    });

    it('rejects name with double-quote', async () => {
      await expect(initAgent(dir, { ...validBase, name: 'bad"injection' }))
        .rejects.toThrow(/name/);
    });

    it('accepts undefined name (optional, defaults to role)', async () => {
      // Existing behavior: if --name is omitted, agentName defaults
      // to role. Validator must only reject malformed STRINGS, not
      // undefined. validBase has no name, so this case also verifies
      // the validator's undefined-safety for opts.name.
      await initAgent(dir, { ...validBase });
      const config = readAgentConfig(dir);
      expect(config!.agent_name).toBe(validBase.role);
    });

    it('accepts realistic valid inputs', async () => {
      // Normal GitHub App IDs, a relative key path, a typical project name.
      await initAgent(dir, { ...validBase });
      const config = readAgentConfig(dir);
      expect(config).not.toBeNull();
      expect(config!.github_app.app_id).toBe('12345');
      expect(config!.github_app.install_id).toBe('67890');
      expect(config!.github_app.key_path).toBe('app.key.pem');
    });

    it('accepts keyPath with dots, hyphens, underscores, slashes', async () => {
      // Normal absolute / nested paths must not be rejected.
      await initAgent(dir, {
        ...validBase,
        keyPath: '/absolute/path/to/my-app.key_2.pem',
      });
      const config = readAgentConfig(dir);
      expect(config!.github_app.key_path).toBe('/absolute/path/to/my-app.key_2.pem');
    });

    it('rejects before writing any workspace state', async () => {
      await expect(initAgent(dir, { ...validBase, appId: 'bad' }))
        .rejects.toThrow();
      // No .macf/ or claude.sh should exist — validation must run
      // before any mkdir/writeFile.
      expect(existsSync(join(dir, '.macf'))).toBe(false);
      expect(existsSync(join(dir, 'claude.sh'))).toBe(false);
    });
  });

  describe('github_app.bot_login resolution (macf#535 / macf#707)', () => {
    // These use the same fake App credentials as the rest of the suite
    // (appId '12345' has no real GitHub App behind it), so the App-slug
    // JWT-mint genuinely fails — exercising the real best-effort/non-fatal
    // code path rather than a mocked one.

    it('does not abort init when App-slug resolution fails (best-effort, non-fatal)', async () => {
      await expect(initAgent(dir, {
        project: 'TEST',
        role: 'code-agent',
        appId: '12345',
        installId: '67890',
        keyPath: 'app.key.pem',
        registryType: 'repo',
        registryRepo: 'owner/repo',
      })).resolves.not.toThrow();

      // Init still completed and wrote a usable config, even though
      // bot_login resolution against a fake App could not succeed.
      const config = readAgentConfig(dir);
      expect(config).not.toBeNull();
      expect(config!.github_app.app_id).toBe('12345');
    });

    it('leaves bot_login unset when App-slug resolution fails, never derives it from agent_name (AC #3)', async () => {
      await initAgent(dir, {
        project: 'TEST',
        role: 'code-agent',
        name: 'totally-different-name',
        appId: '12345',
        installId: '67890',
        keyPath: 'app.key.pem',
        registryType: 'repo',
        registryRepo: 'owner/repo',
      });
      const config = readAgentConfig(dir);
      // bot_login stays unset (undefined) — NOT silently derived from
      // agent_name as a fallback guess. That fallback belongs to the
      // shipped check-gh-attribution.sh hook (non-authoritative), not init.
      expect(config!.github_app.bot_login).toBeUndefined();
      expect(config!.agent_name).toBe('totally-different-name');
    });

    it('does not write bot_login at all in local-registry mode (no App to resolve)', async () => {
      await initAgent(dir, {
        project: 'TEST',
        role: 'code-agent',
        registryType: 'local',
      });
      const config = readAgentConfig(dir);
      expect(config!.github_app).toBeUndefined();
    });
  });
});
