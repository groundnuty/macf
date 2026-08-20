/**
 * Tests for DR-028 increment 2 — `macf doctor`'s role-settings validation
 * (`checkRoleSettings` + `inferRole`) and the `--fix` write-back path.
 *
 * Offline by construction: `checkRoleSettings` / `inferRole` are pure local-
 * file reads. The `runDoctor --fix` tests use a LOCAL-registry config (DR-024),
 * which has no GitHub App, so `runDoctor` skips the DR-019 token check entirely
 * — no network. The PASS fixtures are built by calling the real `install*`
 * emitters (the same code `macf init` runs), which is the whole DR-028 point:
 * init-emit and doctor-expect read from one model and cannot diverge.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  checkRoleSettings,
  inferRole,
  runDoctor,
} from '../../src/cli/commands/doctor.js';
import {
  installGhTokenHook,
  installStartupPickupHook,
  installPluginSkillPermissions,
  installSandboxExcludedCommands,
  installSandboxFdAllowRead,
  MACF_AUDITOR_HOOK_COMMAND,
} from '../../src/cli/settings-writer.js';
import { writeAgentConfig } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

function localConfig(role: string): MacfAgentConfig {
  return {
    project: 'TEST',
    agent_name: 'test-agent',
    agent_role: role,
    agent_type: 'permanent',
    registry: { type: 'local', path: '/tmp/macf-test-registry.json' },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
  };
}

/** Build a workspace whose settings.json carries the full DR-028 floor. */
function installFullFloor(dir: string): void {
  installPluginSkillPermissions(dir);
  installGhTokenHook(dir);
  installStartupPickupHook(dir);
  installSandboxFdAllowRead(dir);
  installSandboxExcludedCommands(dir);
}

/** Strip the auditor never-acts hook entry from a workspace's settings.json. */
function stripAuditorHook(dir: string): void {
  const path = join(dir, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(path, 'utf-8'));
  const pre = settings.hooks?.PreToolUse ?? [];
  settings.hooks.PreToolUse = pre.filter(
    (entry: { hooks: { command: string }[] }) =>
      !entry.hooks.some((h) => h.command === MACF_AUDITOR_HOOK_COMMAND),
  );
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}

describe('checkRoleSettings (DR-028)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-role-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSettings(obj: unknown): void {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(obj, null, 2));
  }

  it('PASS for a non-auditor role when the full floor is installed', () => {
    installFullFloor(tmpRoot);
    const result = checkRoleSettings(tmpRoot, 'code-agent');
    expect(result.status).toBe('PASS');
    expect(result.findings).toHaveLength(0);
    expect(result.role).toBe('code-agent');
    expect(result.roleKnown).toBe(true);
  });

  it('flags a non-canonical role as not known (macf#551 — surfaces auditor near-misses)', () => {
    installFullFloor(tmpRoot);
    // `auditor-agent` is a near-miss on the safety-critical `auditor` role: it
    // gets the floor (PASS) but NOT the never-acts delta, so the doctor must
    // mark it roleKnown=false so the report INFO surfaces the typo.
    const result = checkRoleSettings(tmpRoot, 'auditor-agent');
    expect(result.roleKnown).toBe(false);
    // No never-acts ERROR (the delta keys on exact "auditor"), so floor-only.
    expect(result.findings.some((f) => f.severity === 'ERROR')).toBe(false);
    // A canonical role is roleKnown=true.
    expect(checkRoleSettings(tmpRoot, 'auditor').roleKnown).toBe(true);
  });

  it('PASS for the auditor role when the full floor (incl. never-acts hook) is installed', () => {
    installFullFloor(tmpRoot);
    const result = checkRoleSettings(tmpRoot, 'auditor');
    expect(result.status).toBe('PASS');
    expect(result.findings).toHaveLength(0);
  });

  it('WARN with allow findings when Bash(*) and Write are absent', () => {
    // Read present, but no Bash grant + no Write → those floor entries flagged.
    writeSettings({ permissions: { allow: ['Read', 'Edit', 'Glob'] } });
    const result = checkRoleSettings(tmpRoot, 'code-agent');
    expect(result.status).toBe('WARN');
    const allowItems = result.findings.filter((f) => f.category === 'allow').map((f) => f.item);
    expect(allowItems).toContain('Bash(*)');
    expect(allowItems).toContain('Write');
    // No ERROR-severity finding for a non-auditor role.
    expect(result.findings.every((f) => f.severity === 'WARN')).toBe(true);
  });

  it('treats a broad Bash grant as satisfying the Bash(*) floor entry', () => {
    // Bare `Bash` (not `Bash(*)`) should still satisfy the floor's Bash need.
    writeSettings({ permissions: { allow: ['Bash'] } });
    const result = checkRoleSettings(tmpRoot, 'code-agent');
    const allowItems = result.findings.filter((f) => f.category === 'allow').map((f) => f.item);
    expect(allowItems).not.toContain('Bash(*)');
  });

  it('ERROR for an auditor missing the never-acts hook', () => {
    installFullFloor(tmpRoot);
    stripAuditorHook(tmpRoot);
    const result = checkRoleSettings(tmpRoot, 'auditor');
    expect(result.status).toBe('ERROR');
    const hookErrors = result.findings.filter(
      (f) => f.category === 'hook' && f.severity === 'ERROR',
    );
    expect(hookErrors).toHaveLength(1);
    expect(hookErrors[0]?.item).toBe(MACF_AUDITOR_HOOK_COMMAND);
  });

  it('does NOT error for a non-auditor missing the never-acts hook (not expected for them)', () => {
    installFullFloor(tmpRoot);
    stripAuditorHook(tmpRoot);
    const result = checkRoleSettings(tmpRoot, 'code-agent');
    // The auditor hook is not in code-agent's expected set, so its absence is
    // invisible → full floor minus an unexpected hook is still PASS.
    expect(result.status).toBe('PASS');
    expect(result.findings.some((f) => f.item === MACF_AUDITOR_HOOK_COMMAND)).toBe(false);
  });

  it('WARN with readError on malformed settings.json (no silent PASS)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ broken json');
    const result = checkRoleSettings(tmpRoot, 'code-agent');
    expect(result.status).toBe('WARN');
    expect(result.readError).toMatch(/Refusing to overwrite malformed/);
    expect(result.findings).toHaveLength(0);
  });

  it('reports missing floor deny entries as drift', () => {
    writeSettings({ permissions: { allow: ['Bash(*)', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent'] } });
    const result = checkRoleSettings(tmpRoot, 'code-agent');
    const denyFindings = result.findings.filter((f) => f.category === 'deny');
    expect(denyFindings.length).toBeGreaterThan(0);
    expect(denyFindings.every((f) => f.severity === 'WARN')).toBe(true);
  });

  it('WARNs on a superseded Write(<credential-path>) deny entry even when the full floor is otherwise present (macf#1067)', () => {
    // Reproduces the exact stale-workspace shape: everything ROLE_FLOOR_DENY
    // currently expects is present (so denyFindings() alone reports clean),
    // PLUS a leftover Write(<path>) entry from a pre-#1067 CLI version.
    // Without a dedicated presence check, this workspace would read PASS —
    // the doctor equivalent of the silent-startup-warning #1067 is about.
    installFullFloor(tmpRoot);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    settings.permissions.deny.push('Write(~/.ssh/**)');
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    const result = checkRoleSettings(tmpRoot, 'code-agent');
    expect(result.status).toBe('WARN');
    const legacyFinding = result.findings.find((f) => f.item === 'Write(~/.ssh/**)');
    expect(legacyFinding).toBeDefined();
    expect(legacyFinding?.category).toBe('deny');
    expect(legacyFinding?.severity).toBe('WARN');
  });
});

describe('inferRole (DR-028)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-infer-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads agent_role from macf-agent.json', () => {
    writeAgentConfig(tmpRoot, localConfig('auditor'));
    expect(inferRole(tmpRoot)).toBe('auditor');
  });

  it('returns null when no config is present (indeterminable)', () => {
    expect(inferRole(tmpRoot)).toBeNull();
  });
});

describe('runDoctor --fix (DR-028)', () => {
  let tmpRoot: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-fix-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes the floor and the re-check passes (auditor, exit 0)', async () => {
    writeAgentConfig(tmpRoot, localConfig('auditor'));
    // No settings.json yet → floor is entirely missing → auditor ERROR.
    const code = await runDoctor(tmpRoot, { fix: true, yes: true });
    expect(code).toBe(0);

    // Floor now present in settings.json.
    const settings = JSON.parse(
      readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.permissions.allow).toContain('Bash(*)');
    expect(settings.permissions.allow).toContain('Write');
    expect(settings.permissions.deny).toContain('Bash(sudo *)');
    const commands = (settings.hooks.PreToolUse as { hooks: { command: string }[] }[])
      .flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain(MACF_AUDITOR_HOOK_COMMAND);

    // And a fresh check confirms PASS.
    expect(checkRoleSettings(tmpRoot, 'auditor').status).toBe('PASS');
  });

  it('returns 1 without --fix when the auditor never-acts hook is missing (ERROR drives exit)', async () => {
    writeAgentConfig(tmpRoot, localConfig('auditor'));
    // Read-only run, no fix → ERROR → exit 1.
    const code = await runDoctor(tmpRoot);
    expect(code).toBe(1);
    // Nothing was written.
    expect(() =>
      readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf-8'),
    ).toThrow();
  });

  it('WARN-only role drift does not affect the exit code and is not auto-fixed without --fix', async () => {
    writeAgentConfig(tmpRoot, localConfig('code-agent'));
    // Start from a full, passing floor (sandbox + perms PASS), then introduce
    // pure WARN drift by removing one deny-floor entry.
    installFullFloor(tmpRoot);
    const path = join(tmpRoot, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(path, 'utf-8'));
    settings.permissions.deny = settings.permissions.deny.filter(
      (e: string) => e !== 'Bash(sudo *)',
    );
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');

    const code = await runDoctor(tmpRoot);
    // code-agent has no required hook → the deny gap is WARN-only → exit 0.
    expect(code).toBe(0);
    // Read-only run did NOT re-add the stripped deny entry.
    const after = JSON.parse(readFileSync(path, 'utf-8'));
    expect(after.permissions.deny).not.toContain('Bash(sudo *)');
    expect(checkRoleSettings(tmpRoot, 'code-agent').status).toBe('WARN');
  });

  it('--fix strips a superseded Write(<credential-path>) deny entry from an otherwise-compliant workspace (macf#1067)', async () => {
    // End-to-end proof that `doctor --fix` actually converges the exact
    // stale-workspace shape #1067's requirement 4 asked about — not just
    // that installPluginSkillPermissions *would* strip it in isolation.
    // Before the legacyDenyWriteFindings() detection wired into
    // checkRoleSettings, this workspace read PASS (denyFindings() only
    // checks for MISSING canonical entries, never superseded ones), so
    // --fix's needsFix gate never tripped and "nothing to fix" printed
    // while the dead rule (and its per-launch warning) stayed forever.
    writeAgentConfig(tmpRoot, localConfig('code-agent'));
    installFullFloor(tmpRoot);
    const path = join(tmpRoot, '.claude', 'settings.json');
    const before = JSON.parse(readFileSync(path, 'utf-8'));
    before.permissions.deny.push('Write(~/.ssh/**)', 'Write(~/.claude/settings.json)');
    writeFileSync(path, JSON.stringify(before, null, 2) + '\n');
    expect(checkRoleSettings(tmpRoot, 'code-agent').status).toBe('WARN');

    const code = await runDoctor(tmpRoot, { fix: true, yes: true });
    expect(code).toBe(0);

    const after = JSON.parse(readFileSync(path, 'utf-8'));
    expect(after.permissions.deny).not.toContain('Write(~/.ssh/**)');
    expect(after.permissions.deny).not.toContain('Write(~/.claude/settings.json)');
    // The actually-effective paired Edit(path) entries survive.
    expect(after.permissions.deny).toContain('Edit(~/.ssh/**)');
    expect(after.permissions.deny).toContain('Edit(~/.claude/settings.json)');
    expect(checkRoleSettings(tmpRoot, 'code-agent').status).toBe('PASS');
  });
});
