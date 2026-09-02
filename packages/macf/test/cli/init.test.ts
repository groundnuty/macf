import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initAgent } from '../../src/cli/commands/init.js';
import {
  readAgentConfig, agentCertPath, caCertPath, caKeyPath, caDir, readAgentsIndex, writeAgentsIndex,
} from '../../src/cli/config.js';
import { hasManagedHeader } from '../../src/cli/claude-sh.js';
import { createCA } from '@groundnuty/macf-core';

// `findCliPackageRoot` wrapped in `vi.fn()` (delegating to the real
// implementation by default) so the #1401 guard-integration tests below can
// override JUST that one call — `initAgent` imports `findCliPackageRoot`
// from THIS module directly and passes it as `copyCanonicalAssetsGuarded`'s
// explicit `packageRoot`. `copyCanonicalRules` / `copyCanonicalScripts`
// themselves are left real + unmocked (same same-module-self-call caveat as
// `update.test.ts` / `rules-refresh.test.ts`'s identical mock comment) — they
// always copy from THIS repo's real canonical sources regardless of the
// fixture root the guard judges staleness against.
vi.mock('../../src/cli/rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/rules.js')>();
  return {
    ...actual,
    findCliPackageRoot: vi.fn(actual.findCliPackageRoot),
  };
});

import { findCliPackageRoot } from '../../src/cli/rules.js';

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

  // --- --force / hand-authored claude.sh guard (#897) ---
  //
  // `initAgent` used to call `writeClaudeSh` unconditionally — a workspace
  // whose `claude.sh` was hand-authored (no macf managed-file header) got
  // silently clobbered by re-running `macf init`, with no opt-in and no way
  // to decline. `--force` is now required to overwrite such a file; a fresh
  // workspace (no `claude.sh` yet) or an already macf-managed one still
  // needs no flag at all — the historical unconditional-overwrite behavior
  // every other `macf init` remediation message in this codebase depends on.
  describe('--force / hand-authored claude.sh guard (#897)', () => {
    const HAND_AUTHORED = '#!/usr/bin/env bash\necho "hand-authored launcher, not macf-managed"\n';

    const opts = {
      project: 'TEST',
      role: 'code-agent',
      appId: '12345',
      installId: '67890',
      keyPath: 'app.key.pem',
      registryType: 'repo',
      registryRepo: 'owner/repo',
      // Pin all three so `resolveVersions` skips its network fetch —
      // these tests are about the claude.sh guard, not version resolution.
      cliVersion: '0.1.0',
      pluginVersion: '0.1.0',
      actionsVersion: 'v1',
    } as const;

    it('refuses + touches NOTHING when claude.sh exists and is hand-authored, without --force', async () => {
      const claudeShPath = join(dir, 'claude.sh');
      writeFileSync(claudeShPath, HAND_AUTHORED);

      await expect(initAgent(dir, { ...opts })).rejects.toThrow(/--force/);

      // Byte-identity of the untouched file (assert-the-wrong-path.md: a
      // refusal that had already written something still "refuses" and
      // passes a weaker check) — the hand-authored file must be BYTE-FOR-BYTE
      // unchanged, not merely still present.
      expect(readFileSync(claudeShPath, 'utf-8')).toBe(HAND_AUTHORED);
      // Zero-effect: no other workspace state was written either — the
      // refusal runs before any mkdir/writeFile, same contract the
      // "rejects before writing any workspace state" test above pins for
      // opts-validation failures.
      expect(existsSync(join(dir, '.macf'))).toBe(false);
    });

    it('--force overwrites the hand-authored claude.sh with the macf-managed template', async () => {
      const claudeShPath = join(dir, 'claude.sh');
      writeFileSync(claudeShPath, HAND_AUTHORED);

      await expect(initAgent(dir, { ...opts, force: true })).resolves.not.toThrow();

      const written = readFileSync(claudeShPath, 'utf-8');
      expect(written).not.toBe(HAND_AUTHORED);
      expect(hasManagedHeader(written)).toBe(true);
      expect(existsSync(join(dir, '.macf'))).toBe(true);
    });

    it('does not require --force on a fresh workspace (no claude.sh yet)', async () => {
      expect(existsSync(join(dir, 'claude.sh'))).toBe(false);

      await expect(initAgent(dir, { ...opts })).resolves.not.toThrow();

      expect(hasManagedHeader(readFileSync(join(dir, 'claude.sh'), 'utf-8'))).toBe(true);
    });

    it('does not require --force to refresh an already macf-managed claude.sh (re-init)', async () => {
      // First run with no pre-existing claude.sh — writes the managed template.
      await initAgent(dir, { ...opts });
      const claudeShPath = join(dir, 'claude.sh');
      expect(hasManagedHeader(readFileSync(claudeShPath, 'utf-8'))).toBe(true);

      // Second `macf init` run over the SAME already-managed workspace,
      // still with no --force — must NOT refuse (the file it's about to
      // overwrite already carries macf's own header).
      await expect(initAgent(dir, { ...opts })).resolves.not.toThrow();
      expect(hasManagedHeader(readFileSync(claudeShPath, 'utf-8'))).toBe(true);
    }, 20000);
  });

  // --- init preserves operator-managed env files across re-init (macf#1116) ---
  //
  // `writeEnvFiles` used to overwrite env.telemetry / env.tmux /
  // env.project-rules unconditionally on every `macf init` run — the exact
  // three files the multi-file env layout's own docs call "operator-managed,
  // preserved unconditionally" (a contract `update`'s `refreshEnvFiles`
  // already honored). These tests pin the fixed contract at the CLI level.
  describe('env-file preservation across re-init (macf#1116)', () => {
    const opts = {
      project: 'TEST',
      role: 'code-agent',
      appId: '12345',
      installId: '67890',
      keyPath: 'app.key.pem',
      registryType: 'repo',
      registryRepo: 'owner/repo',
      cliVersion: '0.1.0',
      pluginVersion: '0.1.0',
      actionsVersion: 'v1',
    } as const;

    it('creates all 8 env files on a fresh workspace (nothing to preserve yet)', async () => {
      await initAgent(dir, { ...opts });
      for (const name of [
        'env._helpers',
        'env.identity',
        'env.github',
        'env.certs',
        'env.registry',
        'env.telemetry',
        'env.tmux',
        'env.project-rules',
      ]) {
        expect(existsSync(join(dir, '.claude', '.macf', name)), name).toBe(true);
      }
    });

    it('DECISIVE: env.telemetry survives a second `macf init` byte-identically, WHILE env.identity is regenerated in the same run', async () => {
      // Both halves per assert-the-wrong-path.md: an init that silently
      // wrote nothing on the second run would also pass a preserve-only
      // assertion — a far worse regression than the bug this fixes.
      await initAgent(dir, { ...opts });

      const telemetryPath = join(dir, '.claude', '.macf', 'env.telemetry');
      const identityPath = join(dir, '.claude', '.macf', 'env.identity');
      const operatorTelemetry =
        '# Operator hand-tuned OTLP endpoint\nexport OTEL_EXPORTER_OTLP_ENDPOINT="http://operator-host:4318"\n';
      const staleIdentity = '# stale content a fresh init run must overwrite\n';
      writeFileSync(telemetryPath, operatorTelemetry);
      writeFileSync(identityPath, staleIdentity);

      await initAgent(dir, { ...opts });

      // Preserved half — byte-identical, not just "still exists".
      expect(readFileSync(telemetryPath, 'utf-8')).toBe(operatorTelemetry);
      // Regenerated half — proves the second run wasn't a silent no-op.
      const identityAfter = readFileSync(identityPath, 'utf-8');
      expect(identityAfter).not.toBe(staleIdentity);
      expect(identityAfter).toContain('export MACF_AGENT_NAME');
    }, 30000);

    it('preserves env.tmux and env.project-rules too, not just env.telemetry', async () => {
      await initAgent(dir, { ...opts });

      const tmuxPath = join(dir, '.claude', '.macf', 'env.tmux');
      const rulesPath = join(dir, '.claude', '.macf', 'env.project-rules');
      const operatorTmux = '# Operator-edited\nexport MACF_TMUX_SESSION="my-session"\n';
      const operatorRules =
        '# Operator-edited\nexport MACF_PROJECT_RULES_SOURCE="my-org/coord//project-rules"\n';
      writeFileSync(tmuxPath, operatorTmux);
      writeFileSync(rulesPath, operatorRules);

      await initAgent(dir, { ...opts });

      expect(readFileSync(tmuxPath, 'utf-8')).toBe(operatorTmux);
      expect(readFileSync(rulesPath, 'utf-8')).toBe(operatorRules);
    }, 30000);

    it('reports what was preserved, not just what was written (macf#1105 lesson)', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await initAgent(dir, { ...opts });
        const telemetryPath = join(dir, '.claude', '.macf', 'env.telemetry');
        writeFileSync(telemetryPath, '# operator content\n');
        logSpy.mockClear();

        await initAgent(dir, { ...opts });

        const logged = logSpy.mock.calls.flat().join('\n');
        expect(logged).toMatch(/preserved/i);
        expect(logged).toContain('env.telemetry');
      } finally {
        logSpy.mockRestore();
      }
    }, 30000);

    it('--force does NOT override env-file preservation — it is scoped to the claude.sh guard only', async () => {
      await initAgent(dir, { ...opts });

      const telemetryPath = join(dir, '.claude', '.macf', 'env.telemetry');
      const operatorTelemetry =
        '# Operator hand-tuned OTLP endpoint\nexport OTEL_EXPORTER_OTLP_ENDPOINT="http://operator-host:4318"\n';
      writeFileSync(telemetryPath, operatorTelemetry);

      await initAgent(dir, { ...opts, force: true });

      expect(readFileSync(telemetryPath, 'utf-8')).toBe(operatorTelemetry);
    }, 30000);
  });

  // --- agents-index scoping via --no-agents-index (macf#1135) ---
  //
  // `addToAgentsIndex` writes ~/.macf/agents.json unconditionally — no
  // `--dir` ever redirected it, in EITHER registry mode. `agentsIndex:
  // false` (`--no-agents-index`) is a dedicated, mode-independent opt-out:
  // NOT tied to the local-registry `--path` flag, whose own documented
  // purpose is PERMANENT relocation of the registry file (opposite intent
  // to "this run is ephemeral") and which only ever exists for `--local`
  // anyway — a GitHub-mode CI/scratch-dir run has no `--path` to key off
  // at all. See the `addToAgentsIndex` call site in `init.ts` for the full
  // decision + rejected alternatives.
  describe('agents-index scoping via --no-agents-index (macf#1135)', () => {
    // AGENTS_INDEX_PATH is a SHARED file on this machine — every `macf
    // init` run on this host, including any OTHER agent/process running
    // concurrently, reads/writes the SAME path (it is a module-scope const
    // resolved from `homedir()` at IMPORT time — see the comment on the
    // `skipCertIfPresent` describe block below for why `vi.stubEnv('HOME',
    // …)` can't redirect it). Assertions below are therefore CONTAINMENT
    // checks on "did THIS run's own entry land", not whole-file
    // byte-identity: byte-identity is exposed to false failures from any
    // unrelated concurrent writer, and — worse — a naive snapshot/restore
    // around it risks CLOBBERING that writer's legitimate entry.
    //
    // This is also why a genuine read-only-$HOME rehearsal isn't attempted
    // in-process: the fix's mechanism (skip the write entirely) means a
    // `--no-agents-index` run touches nothing under $HOME at all, which is
    // exactly what the decisive test below proves.
    it('DECISIVE: --no-agents-index never registers the workspace, corrupts nothing already there, and succeeds — equivalent to succeeding under a read-only $HOME, since nothing here is asked to write there', async () => {
      const workspaceDir = join(dir, 'workspace');
      // Snapshot what's already there so the "corrupts nothing" half of
      // the assertion below isn't fooled by `readAgentsIndex()`'s own
      // parse-failure fallback (`{ agents: [] }` on missing/malformed
      // JSON) — a corrupted file would otherwise read as "contains
      // nothing", which trivially (and wrongly) satisfies a pure
      // not-toContain check. `arrayContaining` catches that: concurrent
      // writers on this shared file only ever APPEND, so every entry
      // present before this run must still be present after, in EITHER
      // outcome (fixed or broken).
      const beforeAgents = readAgentsIndex().agents;

      await expect(initAgent(workspaceDir, {
        project: `pathrun${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        role: 'code-agent',
        registryType: 'local',
        registryPath: join(dir, 'registry.json'), // scratch — inside this test's own tmp dir, never $HOME
        agentsIndex: false,
        cliVersion: '0.1.0',
        pluginVersion: '0.1.0',
        actionsVersion: 'v1',
      })).resolves.not.toThrow();

      // Per assert-the-wrong-path.md: a zero-effect containment assertion,
      // not merely "the command exited 0" — today's code exits 0 WHILE
      // registering this workspace, which is the bug this test pins.
      const afterAgents = readAgentsIndex().agents;
      expect(afterAgents).not.toContain(resolve(workspaceDir));
      expect(afterAgents).toEqual(expect.arrayContaining(beforeAgents));
    }, 20000);

    it('is mode-independent: also skips for a GitHub-mode (repo) registry, not just --local', async () => {
      const workspaceDir = join(dir, 'workspace-gh');

      await initAgent(workspaceDir, {
        project: 'TEST',
        role: 'code-agent',
        appId: '123',
        installId: '456',
        keyPath: '.key.pem',
        registryType: 'repo',
        registryRepo: 'owner/repo',
        agentsIndex: false,
        cliVersion: '0.1.0',
        pluginVersion: '0.1.0',
        actionsVersion: 'v1',
      });

      const index = readAgentsIndex();
      expect(index.agents).not.toContain(resolve(workspaceDir));
    }, 20000);

    it('reports the skip, naming how to opt back in', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const workspaceDir = join(dir, 'workspace2');

        await initAgent(workspaceDir, {
          project: `pathrun2${Date.now()}${Math.floor(Math.random() * 1e6)}`,
          role: 'code-agent',
          registryType: 'local',
          registryPath: join(dir, 'registry2.json'),
          agentsIndex: false,
          cliVersion: '0.1.0',
          pluginVersion: '0.1.0',
          actionsVersion: 'v1',
        });

        const logged = logSpy.mock.calls.flat().join('\n');
        expect(logged).toMatch(/skipped the global agents index/);
      } finally {
        logSpy.mockRestore();
      }
    }, 20000);

    it('an ORDINARY run (agentsIndex unset) still updates the index — the fix does not silently disable it', async () => {
      const workspaceDir = join(dir, 'workspace3');

      await initAgent(workspaceDir, {
        project: 'TEST',
        role: 'code-agent',
        appId: '123',
        installId: '456',
        keyPath: '.key.pem',
        registryType: 'repo',
        registryRepo: 'owner/repo',
        cliVersion: '0.1.0',
        pluginVersion: '0.1.0',
        actionsVersion: 'v1',
      });

      const resolvedWorkspace = resolve(workspaceDir);
      try {
        const index = readAgentsIndex();
        expect(index.agents).toContain(resolvedWorkspace);
      } finally {
        // Remove only OUR OWN entry via a read-modify-write, never a full
        // restore. Still a narrower version of the SAME shared-file hazard
        // this describe block's other tests avoid entirely: a concurrent
        // writer that appends between this read and this write loses its
        // entry. Accepted here (not eliminated) because addToAgentsIndex
        // itself is a read-modify-write over the same file with the same
        // exposure — this cleanup doesn't introduce a NEW hazard class,
        // just narrows the existing one back down after the test.
        const current = readAgentsIndex();
        writeAgentsIndex({ agents: current.agents.filter((p) => p !== resolvedWorkspace) });
      }
    }, 20000);
  });
});

// --- GitHub-mode agent leaf-cert flow: `skipCertIfPresent` (macf#1000) ---
//
// These tests touch the REAL `~/.macf/certs/<owner>/<project>/` — the
// GitHub-mode cert-flow (`issueGithubModeAgentCert` in `commands/init.ts`)
// has NO path-override seam for the per-owner, per-project CA; it always
// resolves via `resolveExistingCaPaths(owner, project)` from
// `../../src/cli/config.js` directly (owner-scoped as of macf#1277).
// Proving the "no behaviour change for `macf init` used directly"
// AC (macf#1000) therefore requires the CA to actually live at that
// conventional location. Same convention `certs.test.ts` already
// established: a RANDOMIZED per-test project name (never collides with a
// real fleet) + guaranteed cleanup in `finally` — not `vi.stubEnv('HOME', …)`,
// which is a no-op here (`config.ts`'s `MACF_GLOBAL_DIR` is a module-scope
// `const` computed from `homedir()` at import time).
describe('macf init — GitHub-mode agent leaf-cert flow, skipCertIfPresent (macf#1000)', () => {
  function freshProject(): string {
    return `T${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  }

  // Matches every initOpts fixture below (`registryType: 'repo'`,
  // `registryRepo: 'owner/repo'`) — owner resolves to the literal 'owner'.
  async function mintRealCaFor(project: string): Promise<void> {
    await createCA({ project, certPath: caCertPath('owner', project), keyPath: caKeyPath('owner', project) });
  }

  function removeFromAgentsIndex(absDir: string): void {
    const resolved = resolve(absDir);
    const index = readAgentsIndex();
    const filtered = index.agents.filter((p) => p !== resolved);
    if (filtered.length !== index.agents.length) {
      writeAgentsIndex({ agents: filtered });
    }
  }

  it('DEFAULT (skipCertIfPresent unset): a `macf init` re-run UNCONDITIONALLY reissues the cert — the "no behaviour change for `macf init` used directly" AC, proven as a DISCRIMINATING PAIR (differ across two runs), not merely "a cert exists"', async () => {
    const project = freshProject();
    const dir = tempDir();
    const initOpts = {
      project,
      role: 'code-agent',
      appId: '111',
      installId: '222',
      keyPath: 'k.pem',
      registryType: 'repo' as const,
      registryRepo: 'owner/repo',
      cliVersion: '0.1.0',
      pluginVersion: '0.1.0',
      actionsVersion: 'v1',
    };
    try {
      await mintRealCaFor(project);

      await initAgent(dir, initOpts);
      const firstCertPem = readFileSync(agentCertPath(dir), 'utf-8');

      await initAgent(dir, initOpts);
      const secondCertPem = readFileSync(agentCertPath(dir), 'utf-8');

      // Unconditional reissue (unchanged, pre-#1000 contract): a fresh
      // random serial number (agent-cert.ts::generateAgentCert) makes the
      // second cert BYTE-DIFFERENT from the first, even against the SAME
      // CA/CN/inputs.
      expect(secondCertPem).not.toBe(firstCertPem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(caDir('owner', project), { recursive: true, force: true });
      removeFromAgentsIndex(dir);
    }
    // Two full `initAgent()` runs (each hitting the network for the plugin
    // fetch — same accepted cost this file's OTHER tests already pay once
    // per test, per this file's own "routing_label" test comment) exceed
    // vitest's 5000ms default under full-suite parallel load, even though
    // both runs complete comfortably under it in isolation (verified:
    // `vitest run test/cli/init.test.ts` alone, 31.94s / 35 tests total).
    // Matches this monorepo's own convention for real-crypto/real-network
    // tests (`ca.test.ts`, `migrate-ca-key.test.ts`).
  }, 20000);

  it('skipCertIfPresent: true (the `fleet deploy` delegation signal): a re-run with an existing cert leaves it byte-for-byte UNTOUCHED', async () => {
    const project = freshProject();
    const dir = tempDir();
    const initOpts = {
      project,
      role: 'code-agent',
      appId: '111',
      installId: '222',
      keyPath: 'k.pem',
      registryType: 'repo' as const,
      registryRepo: 'owner/repo',
      cliVersion: '0.1.0',
      pluginVersion: '0.1.0',
      actionsVersion: 'v1',
      skipCertIfPresent: true,
    };
    try {
      await mintRealCaFor(project);

      await initAgent(dir, initOpts);
      const firstCertPem = readFileSync(agentCertPath(dir), 'utf-8');

      await initAgent(dir, initOpts);
      const secondCertPem = readFileSync(agentCertPath(dir), 'utf-8');

      expect(secondCertPem).toBe(firstCertPem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(caDir('owner', project), { recursive: true, force: true });
      removeFromAgentsIndex(dir);
    }
    // See the sibling test's own comment on the explicit timeout below.
  }, 20000);
});

describe('canonical-overwrite guard integration (groundnuty/macf#1401, extending #1386 from update alone)', () => {
  // Local git-fixture helpers, matching the shape update.test.ts /
  // rules-refresh.test.ts / canonical-overwrite-guard.test.ts already use —
  // never invents a second staleness notion of its own to test against.
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  function gitUserConfig(cwd: string): void {
    git(cwd, 'config', 'user.email', 'test@example.invalid');
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'commit.gpgsign', 'false');
  }
  function writePackageJson(pkgDir: string, name = '@fake-scope/fake-cli'): void {
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  }
  /** A stale fake CLI checkout: `behindBy` commits behind origin/main. */
  function makeStaleFakeCliCheckout(pkgDir: string, remote: string, behindBy: number): void {
    mkdirSync(remote, { recursive: true });
    git(remote, 'init', '-q', '--bare', '--initial-branch=main');
    writePackageJson(pkgDir);
    git(pkgDir, 'init', '-q', '-b', 'main');
    gitUserConfig(pkgDir);
    git(pkgDir, 'commit', '-q', '--allow-empty', '-m', 'initial');
    git(pkgDir, 'remote', 'add', 'origin', remote);
    git(pkgDir, 'push', '-q', '-u', 'origin', 'main');
    const throwaway = join(dirname(remote), `throwaway-clone-${Math.random().toString(36).slice(2)}`);
    git(dirname(remote), 'clone', '-q', remote, throwaway);
    gitUserConfig(throwaway);
    for (let i = 0; i < behindBy; i++) {
      git(throwaway, 'commit', '-q', '--allow-empty', '-m', `advance ${i}`);
    }
    git(throwaway, 'push', '-q', 'origin', 'HEAD:main');
    rmSync(throwaway, { recursive: true, force: true });
    git(pkgDir, 'fetch', '-q', 'origin');
    // A REAL canonical rule NAME (coordination.md) — see the identical
    // comment in rules-refresh.test.ts's copy of this helper for why.
    mkdirSync(join(pkgDir, 'plugin', 'rules'), { recursive: true });
    writeFileSync(join(pkgDir, 'plugin', 'rules', 'coordination.md'), '<!-- fake stale canonical -->\nirrelevant\n');
  }

  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('DECISIVE PAIR (1/2) — REACHABILITY: a re-init through the real `initAgent()` refuses when the installed CLI checkout is stale — a pre-existing workspace rule is left untouched', async () => {
    // Everything lives under ONE scratch dir (never directly under the
    // shared system /tmp) — `ensureLocalRegistryDir` chmod's the registry
    // path's PARENT directory, which must be a dir this test owns, not
    // `/tmp` itself.
    const tmpRoot = tempDir();
    const workspaceDir = join(tmpRoot, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const fakeRoot = join(tmpRoot, `fake-stale-cli-${Math.random().toString(36).slice(2)}`);
    const remote = join(tmpRoot, `fake-stale-remote-${Math.random().toString(36).slice(2)}.git`);
    // Distinctive count — see update.test.ts's identical REACHABILITY test
    // for why (guards against a silently-bypassed mock coincidentally
    // matching this repo's own real ambient checkout state).
    makeStaleFakeCliCheckout(fakeRoot, remote, 71);
    vi.mocked(findCliPackageRoot).mockReturnValueOnce(fakeRoot);

    // Pre-seed a workspace that already has a canonical rule copy (e.g. a
    // prior `rules refresh`, or a re-init) BEFORE `macf init` runs — the
    // same shape init.ts's own doc comment describes as exposing this call
    // to #1386 just as much as `macf update`.
    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    const sentinel = '<!-- test -->\nWORKSPACE HAS SOMETHING NEWER — must survive\n';
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'coordination.md'), sentinel);

    const project = `stalecliinit${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    try {
      await initAgent(workspaceDir, {
        project,
        role: 'code-agent',
        registryType: 'local',
        registryPath: join(tmpRoot, `registry-${project}.json`),
        agentsIndex: false,
        cliVersion: '0.1.0',
        pluginVersion: '0.1.0',
        actionsVersion: 'v1',
      });

      expect(readFileSync(join(workspaceDir, '.claude', 'rules', 'coordination.md'), 'utf-8')).toBe(sentinel);
      const allErrors = errorSpy.mock.calls.flat().join('\n');
      expect(allErrors).toMatch(/Refused:/);
      expect(allErrors).toMatch(/71 commit\(s\) behind/);
      expect(allErrors).toContain(join('.claude', 'rules', 'coordination.md'));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 20000);

  it('DECISIVE PAIR (2/2) — REACHABILITY: a current checkout proceeds through the real `initAgent()` — real canonical content lands', async () => {
    const tmpRoot = tempDir();
    const workspaceDir = join(tmpRoot, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const fakeRoot = join(tmpRoot, `fake-current-cli-${Math.random().toString(36).slice(2)}`);
    const remote = join(tmpRoot, `fake-current-remote-${Math.random().toString(36).slice(2)}.git`);
    makeStaleFakeCliCheckout(fakeRoot, remote, 0);
    vi.mocked(findCliPackageRoot).mockReturnValueOnce(fakeRoot);

    const project = `currentcliinit${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    try {
      await initAgent(workspaceDir, {
        project,
        role: 'code-agent',
        registryType: 'local',
        registryPath: join(tmpRoot, `registry-${project}.json`),
        agentsIndex: false,
        cliVersion: '0.1.0',
        pluginVersion: '0.1.0',
        actionsVersion: 'v1',
      });

      expect(existsSync(join(workspaceDir, '.claude', 'rules', 'coordination.md'))).toBe(true);
      expect(errorSpy.mock.calls.flat().join('\n')).not.toMatch(/Refused:/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 20000);

  it('--force overrides the refusal on a re-init — the file IS overwritten, with a warning noting the override', async () => {
    const tmpRoot = tempDir();
    const workspaceDir = join(tmpRoot, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const fakeRoot = join(tmpRoot, `fake-stale-cli-force-${Math.random().toString(36).slice(2)}`);
    const remote = join(tmpRoot, `fake-stale-remote-force-${Math.random().toString(36).slice(2)}.git`);
    makeStaleFakeCliCheckout(fakeRoot, remote, 83);
    vi.mocked(findCliPackageRoot).mockReturnValueOnce(fakeRoot);

    mkdirSync(join(workspaceDir, '.claude', 'rules'), { recursive: true });
    const sentinel = '<!-- test -->\nWORKSPACE HAS SOMETHING NEWER — should be overwritten by --force\n';
    writeFileSync(join(workspaceDir, '.claude', 'rules', 'coordination.md'), sentinel);

    const project = `forceinit${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    try {
      await initAgent(workspaceDir, {
        project,
        role: 'code-agent',
        registryType: 'local',
        registryPath: join(tmpRoot, `registry-${project}.json`),
        agentsIndex: false,
        cliVersion: '0.1.0',
        pluginVersion: '0.1.0',
        actionsVersion: 'v1',
        force: true,
      });

      expect(readFileSync(join(workspaceDir, '.claude', 'rules', 'coordination.md'), 'utf-8')).not.toBe(sentinel);
      const warnOut = warnSpy.mock.calls.flat().map(String).join('\n');
      expect(warnOut).toMatch(/--force overriding a stale-CLI overwrite refusal/);
      expect(warnOut).toMatch(/83 commit\(s\) behind/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 20000);
});
