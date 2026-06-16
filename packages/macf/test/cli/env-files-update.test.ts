/**
 * Tests for macf#342 PR-C — env-file refresh + monolithic→multi-file
 * migration + settings.local.json deprecation surface.
 *
 * Verifies the refresh-and-preserve semantics:
 *   - macf-managed file absent → write fresh
 *   - macf-managed file matches generator output → no-op
 *   - macf-managed file drifted → warn + overwrite
 *   - operator-managed file absent → bootstrap-write
 *   - operator-managed file present → preserve unconditionally
 *   - monolithic claude.sh → migrated to thin + env files written
 *   - already-thin claude.sh → no migration
 *   - settings.local.json env.MACF_/OTEL_ keys -> surface as deprecation
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  refreshEnvFiles,
  migrateMonolithicClaudeSh,
  detectSettingsLocalEnvKeys,
  formatDeprecationWarning,
} from '../../src/cli/env-files-update.js';
import {
  generateEnvHelpers,
  generateEnvIdentity,
  generateEnvCerts,
  generateEnvRegistry,
  generateEnvGitHub,
  generateEnvTelemetry,
  generateEnvTmux,
} from '../../src/cli/env-files.js';
import { generateClaudeSh } from '../../src/cli/claude-sh.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

const baseConfig: MacfAgentConfig = {
  project: 'TEST',
  agent_name: 'code-agent',
  agent_role: 'code-agent',
  agent_type: 'permanent',
  registry: { type: 'repo', owner: 'o', repo: 'r' },
  github_app: {
    app_id: '12345',
    install_id: '67890',
    key_path: '.github-app-key.pem',
  },
  versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
};

const localConfig: MacfAgentConfig = {
  project: 'TEST',
  agent_name: 'cv-architect',
  agent_role: 'cv-architect',
  agent_type: 'permanent',
  registry: { type: 'local', path: '/home/u/.macf/registry/TEST.json' },
  versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
};

let tmpRoot: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'macf-env-update-'));
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// refreshEnvFiles
// ---------------------------------------------------------------------------

describe('refreshEnvFiles', () => {
  it('creates .claude/.macf/ if absent (mkdir -p semantics)', () => {
    refreshEnvFiles(tmpRoot, baseConfig);
    expect(existsSync(join(tmpRoot, '.claude', '.macf'))).toBe(true);
  });

  it('writes all 5 macf-managed files when none exist (fresh state)', () => {
    const result = refreshEnvFiles(tmpRoot, baseConfig);
    expect(result.refreshed).toEqual(
      expect.arrayContaining([
        'env._helpers',
        'env.identity',
        'env.github',
        'env.certs',
        'env.registry',
      ]),
    );
    for (const name of result.refreshed) {
      expect(existsSync(join(tmpRoot, '.claude', '.macf', name))).toBe(true);
    }
  });

  it('bootstrap-writes operator-managed files when absent', () => {
    const result = refreshEnvFiles(tmpRoot, baseConfig);
    expect(result.bootstrapped).toEqual(
      expect.arrayContaining(['env.telemetry', 'env.tmux']),
    );
    expect(existsSync(join(tmpRoot, '.claude', '.macf', 'env.telemetry'))).toBe(true);
    expect(existsSync(join(tmpRoot, '.claude', '.macf', 'env.tmux'))).toBe(true);
  });

  it('bootstrap-writes env.telemetry with MACF_VERSION baked from config (macf#357 version-refresh-on-update)', () => {
    // When env.telemetry is absent at refresh time (e.g., operator
    // intentionally deleted it for a fresh bake, or workspace migrating
    // from monolithic claude.sh to multi-file env layout for the first
    // time), the bootstrap-write picks up the workspace's pinned macf
    // CLI version from config.versions.cli. This is the "version-refresh
    // on update" path from macf#357 AC.
    const result = refreshEnvFiles(tmpRoot, baseConfig);
    expect(result.bootstrapped).toContain('env.telemetry');
    const telemetry = readFileSync(
      join(tmpRoot, '.claude', '.macf', 'env.telemetry'),
      'utf-8',
    );
    // baseConfig.versions.cli is '0.1.0' in the test fixture.
    expect(telemetry).toContain(`export MACF_VERSION="${baseConfig.versions!.cli}"`);
    expect(telemetry).toContain('service.namespace=${MACF_PROJECT}');
    expect(telemetry).toContain('macf.framework=macf');
  });

  it('preserves operator-managed env.telemetry when present (operator edits intact)', () => {
    mkdirSync(join(tmpRoot, '.claude', '.macf'), { recursive: true });
    const customTelemetry =
      '# Operator-edited\nexport OTEL_EXPORTER_OTLP_ENDPOINT="http://my-collector:4318"\n';
    const path = join(tmpRoot, '.claude', '.macf', 'env.telemetry');
    writeFileSync(path, customTelemetry);

    const result = refreshEnvFiles(tmpRoot, baseConfig);

    expect(result.preserved).toContain('env.telemetry');
    expect(result.bootstrapped).not.toContain('env.telemetry');
    const after = readFileSync(path, 'utf-8');
    expect(after).toBe(customTelemetry);
  });

  it('preserves operator-managed env.tmux when present', () => {
    mkdirSync(join(tmpRoot, '.claude', '.macf'), { recursive: true });
    const customTmux = '# Operator-edited\nexport MACF_TMUX_SESSION="my-session"\n';
    const path = join(tmpRoot, '.claude', '.macf', 'env.tmux');
    writeFileSync(path, customTmux);

    const result = refreshEnvFiles(tmpRoot, baseConfig);

    expect(result.preserved).toContain('env.tmux');
    const after = readFileSync(path, 'utf-8');
    expect(after).toBe(customTmux);
  });

  it('preserves operator-set env.project-rules (MACF_PROJECT_RULES_SOURCE) across update (macf#501)', () => {
    mkdirSync(join(tmpRoot, '.claude', '.macf'), { recursive: true });
    // Operator has configured a project-rules source — must survive update.
    const customSource =
      '# Operator-edited\nexport MACF_PROJECT_RULES_SOURCE="my-org/coord//project-rules"\n';
    const path = join(tmpRoot, '.claude', '.macf', 'env.project-rules');
    writeFileSync(path, customSource);

    const result = refreshEnvFiles(tmpRoot, baseConfig);

    expect(result.preserved).toContain('env.project-rules');
    expect(result.bootstrapped).not.toContain('env.project-rules');
    expect(readFileSync(path, 'utf-8')).toBe(customSource);
  });

  it('bootstrap-writes env.project-rules when absent (default source UNSET)', () => {
    const result = refreshEnvFiles(tmpRoot, baseConfig);
    expect(result.bootstrapped).toContain('env.project-rules');
    const content = readFileSync(
      join(tmpRoot, '.claude', '.macf', 'env.project-rules'),
      'utf-8',
    );
    expect(content).toContain('MACF_PROJECT_RULES_SOURCE');
    // Default must NOT set an active export — the tier stays empty until the
    // operator opts in.
    for (const line of content.split('\n')) {
      if (line.includes('export MACF_PROJECT_RULES_SOURCE')) {
        expect(line.trimStart().startsWith('#')).toBe(true);
      }
    }
  });

  it('no-ops on macf-managed file when content matches fresh generator output', () => {
    mkdirSync(join(tmpRoot, '.claude', '.macf'), { recursive: true });
    const path = join(tmpRoot, '.claude', '.macf', 'env.identity');
    writeFileSync(path, generateEnvIdentity(baseConfig));

    const result = refreshEnvFiles(tmpRoot, baseConfig);

    expect(result.refreshed).not.toContain('env.identity');
    expect(result.warnedHandEdits).not.toContain('env.identity');
  });

  it('warns + overwrites macf-managed file when content drifted (hand-edit detected)', () => {
    mkdirSync(join(tmpRoot, '.claude', '.macf'), { recursive: true });
    const path = join(tmpRoot, '.claude', '.macf', 'env.identity');
    writeFileSync(path, '# operator hand-edit, not from generator\nexport FOO=bar\n');

    const result = refreshEnvFiles(tmpRoot, baseConfig);

    expect(result.refreshed).toContain('env.identity');
    expect(result.warnedHandEdits).toContain('env.identity');
    // Stderr warning should cite macf#342
    const stderrCalls = stderrSpy.mock.calls.flat().join('\n');
    expect(stderrCalls).toMatch(/hand-edited macf-managed/);
    expect(stderrCalls).toMatch(/macf#342/);
    // File content reflects fresh generator
    const after = readFileSync(path, 'utf-8');
    expect(after).toBe(generateEnvIdentity(baseConfig));
  });

  it('warns + overwrites multiple macf-managed files when several drifted', () => {
    mkdirSync(join(tmpRoot, '.claude', '.macf'), { recursive: true });
    const idPath = join(tmpRoot, '.claude', '.macf', 'env.identity');
    const certsPath = join(tmpRoot, '.claude', '.macf', 'env.certs');
    writeFileSync(idPath, '# hand-edit 1\n');
    writeFileSync(certsPath, '# hand-edit 2\n');

    const result = refreshEnvFiles(tmpRoot, baseConfig);

    expect(result.warnedHandEdits).toEqual(
      expect.arrayContaining(['env.identity', 'env.certs']),
    );
  });

  it('macf-managed write contract — env._helpers content matches generator', () => {
    refreshEnvFiles(tmpRoot, baseConfig);
    const helpers = readFileSync(
      join(tmpRoot, '.claude', '.macf', 'env._helpers'),
      'utf-8',
    );
    expect(helpers).toBe(generateEnvHelpers());
  });

  it('macf-managed write contract — env.registry content matches generator', () => {
    refreshEnvFiles(tmpRoot, baseConfig);
    const registry = readFileSync(
      join(tmpRoot, '.claude', '.macf', 'env.registry'),
      'utf-8',
    );
    expect(registry).toBe(generateEnvRegistry(baseConfig));
  });

  it('local-mode workspace — env.github gets local-mode placeholder', () => {
    refreshEnvFiles(tmpRoot, localConfig);
    const github = readFileSync(
      join(tmpRoot, '.claude', '.macf', 'env.github'),
      'utf-8',
    );
    expect(github).toBe(generateEnvGitHub(localConfig));
    expect(github).toContain('local-mode');
  });

  it('idempotent — second call without state changes refreshes nothing', () => {
    refreshEnvFiles(tmpRoot, baseConfig);
    stderrSpy.mockClear();

    const result = refreshEnvFiles(tmpRoot, baseConfig);

    // env._helpers etc. existed + matched → no-op (not in refreshed list).
    expect(result.refreshed).toEqual([]);
    expect(result.warnedHandEdits).toEqual([]);
    // Operator-managed files written on the first call are preserved.
    expect(result.preserved).toEqual(
      expect.arrayContaining(['env.telemetry', 'env.tmux']),
    );
    // No stderr noise on the second call.
    expect(stderrSpy.mock.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// migrateMonolithicClaudeSh
// ---------------------------------------------------------------------------

describe('migrateMonolithicClaudeSh', () => {
  it('returns no-claude-sh when claude.sh is absent', () => {
    const result = migrateMonolithicClaudeSh(tmpRoot, baseConfig);
    expect(result).toEqual({ migrated: false, reason: 'no-claude-sh' });
  });

  it('returns already-migrated when claude.sh has the source-loop marker', () => {
    // Write a thin claude.sh by going through generateClaudeSh.
    const thin = generateClaudeSh(baseConfig);
    writeFileSync(join(tmpRoot, 'claude.sh'), thin);
    const result = migrateMonolithicClaudeSh(tmpRoot, baseConfig);
    expect(result).toEqual({ migrated: false, reason: 'already-migrated' });
  });

  it('returns unrecognized-template for an operator-rewritten launcher', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      '#!/usr/bin/env bash\n# operator-custom\nexec claude "$@"\n',
    );
    const result = migrateMonolithicClaudeSh(tmpRoot, baseConfig);
    expect(result).toEqual({
      migrated: false,
      reason: 'unrecognized-template',
    });
  });

  it('migrates monolithic claude.sh → thin template + writes 7 env files', () => {
    // Fixture: a pre-#342 monolithic-shaped claude.sh has the inline
    // export MACF_AGENT_NAME= marker (one of many in the old template).
    // We only need the marker for detection; full content doesn't have
    // to be byte-perfect.
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      '#!/usr/bin/env bash\n' +
        'set -euo pipefail\n' +
        'export MACF_AGENT_NAME="code-agent"\n' +
        'export MACF_AGENT_ROLE="code-agent"\n' +
        'export MACF_PROJECT="TEST"\n' +
        'exec claude "$@"\n',
    );

    const result = migrateMonolithicClaudeSh(tmpRoot, baseConfig);
    expect(result).toEqual({ migrated: true });

    // Thin template marker present after migration
    const after = readFileSync(join(tmpRoot, 'claude.sh'), 'utf-8');
    expect(after).toContain('for f in "$SCRIPT_DIR/.claude/.macf"/env.*');
    expect(after).not.toContain('export MACF_AGENT_NAME='); // moved to env.identity

    // All 8 env files exist
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
      expect(
        existsSync(join(tmpRoot, '.claude', '.macf', name)),
        `env file should exist after migration: ${name}`,
      ).toBe(true);
    }
  });

  it('migration is idempotent — second call detects already-migrated', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      '#!/usr/bin/env bash\nset -euo pipefail\nexport MACF_AGENT_NAME="code-agent"\nexec claude\n',
    );
    const first = migrateMonolithicClaudeSh(tmpRoot, baseConfig);
    expect(first.migrated).toBe(true);

    const second = migrateMonolithicClaudeSh(tmpRoot, baseConfig);
    expect(second).toEqual({ migrated: false, reason: 'already-migrated' });
  });

  it('migrates local-mode workspace — env.github carries local-mode placeholder', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      '#!/usr/bin/env bash\nexport MACF_AGENT_NAME="cv-architect"\nexec claude\n',
    );
    const result = migrateMonolithicClaudeSh(tmpRoot, localConfig);
    expect(result.migrated).toBe(true);
    const github = readFileSync(
      join(tmpRoot, '.claude', '.macf', 'env.github'),
      'utf-8',
    );
    expect(github).toContain('local-mode');
  });
});

// ---------------------------------------------------------------------------
// detectSettingsLocalEnvKeys + formatDeprecationWarning
// ---------------------------------------------------------------------------

describe('detectSettingsLocalEnvKeys', () => {
  it('returns empty when settings.local.json is absent', () => {
    expect(detectSettingsLocalEnvKeys(tmpRoot)).toEqual([]);
  });

  it('returns empty when settings.local.json has no env block', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] } }),
    );
    expect(detectSettingsLocalEnvKeys(tmpRoot)).toEqual([]);
  });

  it('returns empty when env block has no MACF_* / OTEL_* keys', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { CUSTOM_VAR: 'foo', PATH: '/usr/bin' } }),
    );
    expect(detectSettingsLocalEnvKeys(tmpRoot)).toEqual([]);
  });

  it('surfaces MACF_* keys', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: {
          MACF_AGENT_NAME: 'foo',
          MACF_AGENT_ROLE: 'bar',
          OTHER_VAR: 'unrelated',
        },
      }),
    );
    expect(detectSettingsLocalEnvKeys(tmpRoot)).toEqual([
      'MACF_AGENT_NAME',
      'MACF_AGENT_ROLE',
    ]);
  });

  it('surfaces OTEL_* keys (deduped + sorted)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x',
          MACF_OTEL_ENDPOINT: 'http://y',
        },
      }),
    );
    expect(detectSettingsLocalEnvKeys(tmpRoot)).toEqual([
      'MACF_OTEL_ENDPOINT',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ]);
  });

  it('returns empty silently on malformed JSON (no double-report)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'settings.local.json'),
      '{ not valid json',
    );
    expect(detectSettingsLocalEnvKeys(tmpRoot)).toEqual([]);
  });
});

describe('formatDeprecationWarning', () => {
  it('returns empty string for empty key list (caller need not special-case)', () => {
    expect(formatDeprecationWarning([])).toBe('');
  });

  it('renders one line per key + cites macf#342', () => {
    const out = formatDeprecationWarning(['MACF_AGENT_NAME', 'OTEL_RESOURCE_ATTRIBUTES']);
    expect(out).toContain('env.MACF_AGENT_NAME');
    expect(out).toContain('env.OTEL_RESOURCE_ATTRIBUTES');
    expect(out).toContain('macf#342');
    expect(out).toContain('settings.local.json');
  });
});
