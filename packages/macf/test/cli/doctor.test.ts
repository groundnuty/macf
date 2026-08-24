/**
 * Tests for `macf doctor` — pure `diffPermissions` logic plus the
 * formatted-row helper. The full `runDoctor` integration test would
 * require mocking `execFileSync`, which is painful with vi.mock's
 * module semantics — we cover the business logic (diff + format)
 * directly and trust the wrapper.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  AUTONOMY_REQUIRED_TOOLS,
  DR039_LOAD_BEARING_HOOKS,
  MACF_REQUIRED_PERMISSIONS,
  checkBotLogin,
  checkCanonicalBranch,
  checkLoadBearingHooks,
  checkPermissionsAllow,
  checkRoutingLabelProjectPrefix,
  checkSandboxFdAllowRead,
  deriveBotLogin,
  describeNonAppSlugOutput,
  diffPermissions,
  formatPermissionRow,
  describeNonJwtOutput,
  getEffectiveHookConfig,
  hasToolDeny,
  isToolFullyAllowed,
  readCurrentBranch,
  resolvePluginDirFromClaudeSh,
  type RequiredPermission,
} from '../../src/cli/commands/doctor.js';
import { SANDBOX_FD_READ_PATTERN } from '../../src/cli/settings-writer.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

describe('MACF_REQUIRED_PERMISSIONS', () => {
  it('has exactly the seven DR-019 permissions (canonical API names)', () => {
    const names = MACF_REQUIRED_PERMISSIONS.map(p => p.name).sort();
    expect(names).toEqual([
      'actions', 'actions_variables', 'contents', 'issues', 'metadata',
      'pull_requests', 'workflows',
    ]);
  });

  it('uses canonical API name actions_variables, not UI label variables', () => {
    // Regression guard: GitHub's API returns actions_variables; the UI
    // shows "Variables". Using the UI label would give false negatives.
    const names = MACF_REQUIRED_PERMISSIONS.map(p => p.name);
    expect(names).toContain('actions_variables');
    expect(names).not.toContain('variables');
  });

  it('actions is read-level (coordinator self-debug)', () => {
    const actions = MACF_REQUIRED_PERMISSIONS.find(p => p.name === 'actions');
    expect(actions?.level).toBe('read');
  });

  it('every write-level permission has a rationale referencing a concrete use', () => {
    for (const p of MACF_REQUIRED_PERMISSIONS.filter(x => x.level === 'write')) {
      expect(p.why.length).toBeGreaterThan(10);
    }
  });
});

describe('diffPermissions', () => {
  function allOk(): Record<string, string> {
    return {
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      actions_variables: 'write',
      workflows: 'write',
      actions: 'read',
    };
  }

  it('finds no gaps when every required permission is granted at the required level', () => {
    const finding = diffPermissions(allOk());
    expect(finding.missing).toEqual([]);
    expect(finding.insufficient).toEqual([]);
  });

  it('flags missing permissions as missing', () => {
    const actual = allOk();
    delete actual.actions; // coordinator gap observed in the wild
    const finding = diffPermissions(actual);
    expect(finding.missing.map(p => p.name)).toEqual(['actions']);
    expect(finding.insufficient).toEqual([]);
  });

  it('flags write-required-but-read-granted as insufficient (not missing)', () => {
    const actual = allOk();
    actual.actions_variables = 'read'; // downgraded
    const finding = diffPermissions(actual);
    expect(finding.missing).toEqual([]);
    expect(finding.insufficient.map(x => x.required.name)).toEqual(['actions_variables']);
    expect(finding.insufficient[0]?.actual).toBe('read');
  });

  it('does NOT flag read-required-but-write-granted — user exceeds requirement', () => {
    const actual = allOk();
    actual.actions = 'write'; // more than we asked for
    const finding = diffPermissions(actual);
    expect(finding.missing).toEqual([]);
    expect(finding.insufficient).toEqual([]);
  });

  it('handles the observed real-world gap (no actions_variables, no actions)', () => {
    // This matches what `GET /app/installations/:id` returns for an App
    // created before the #72 doctrine added variables/actions.
    const actual: Record<string, string> = {
      contents: 'write',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
      workflows: 'write',
    };
    const finding = diffPermissions(actual);
    const missingNames = finding.missing.map(p => p.name).sort();
    expect(missingNames).toEqual(['actions', 'actions_variables']);
  });

  it('handles completely empty permission map (broken token)', () => {
    const finding = diffPermissions({});
    expect(finding.missing.length).toBe(7); // all seven missing
    expect(finding.insufficient).toEqual([]);
  });
});

describe('formatPermissionRow', () => {
  const req: RequiredPermission = {
    name: 'actions',
    level: 'read',
    why: 'gh run list for self-debug',
  };

  it('marks satisfied permissions with ✓', () => {
    const row = formatPermissionRow(req, 'read');
    expect(row).toMatch(/^✓ /);
    expect(row).toContain('actions');
    expect(row).toContain('required=read');
    expect(row).toContain('actual=read');
  });

  it('marks missing permissions with ✗ and includes rationale', () => {
    const row = formatPermissionRow(req, undefined);
    expect(row).toMatch(/^✗ /);
    expect(row).toContain('MISSING');
    expect(row).toContain('gh run list for self-debug');
  });

  it('marks insufficient (write-required, read-granted) with ⚠', () => {
    const writeReq: RequiredPermission = {
      name: 'actions_variables',
      level: 'write',
      why: 'Registry',
    };
    const row = formatPermissionRow(writeReq, 'read');
    expect(row).toMatch(/^⚠ /);
    expect(row).toContain('need write, have read');
  });
});

describe('describeNonJwtOutput (#86 — no JWT leak)', () => {
  it('reports at most the first 6 characters of non-JWT output', () => {
    // Simulate a genuinely-valid JWT that trips the startsWith check
    // due to e.g. a leading whitespace char. Must NOT leak beyond 6.
    const fakeJwt = ' eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const msg = describeNonJwtOutput(fakeJwt);
    // First 6 chars end at "eyJhbG" (after the leading space)... actually
    // the slice is on the raw string: " eyJhb" (leading space + 5 chars).
    // Length should match.
    expect(msg).toContain(`length=${fakeJwt.length}`);
    // Body of message should contain EXACTLY 6 characters of the input
    // and no more. Check that no fragment longer than 6 chars of the
    // original appears in the message.
    const longFragment = fakeJwt.slice(0, 20);
    expect(msg).not.toContain(longFragment);
    // And the payload segment must not be present.
    expect(msg).not.toContain('payload');
    expect(msg).not.toContain('signature');
  });

  it('handles empty output cleanly', () => {
    const msg = describeNonJwtOutput('');
    expect(msg).toContain('(empty)');
    expect(msg).toContain('length=0');
  });

  it('handles short error-message output (e.g. "401")', () => {
    const msg = describeNonJwtOutput('401');
    expect(msg).toContain("prefix='401'");
    expect(msg).toContain('length=3');
  });

  it('does not include the word "undefined" when input is an empty string', () => {
    // Guard against "prefix='undefined'" or similar drift
    const msg = describeNonJwtOutput('');
    expect(msg).not.toContain('undefined');
  });

  it('never exceeds 6 chars of raw input exposure, even for long inputs', () => {
    const secret = 'a'.repeat(400);
    const msg = describeNonJwtOutput(secret);
    // 7 consecutive 'a's would mean we leaked >6 chars
    expect(msg).not.toContain('aaaaaaa');
    expect(msg).toContain('length=400');
  });
});

describe('checkSandboxFdAllowRead (macf#202)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-sandbox-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSettings(obj: unknown): void {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(obj, null, 2));
  }

  it('PASS when allowRead contains the fd pattern', () => {
    writeSettings({
      sandbox: { filesystem: { allowRead: ['/etc/hosts', SANDBOX_FD_READ_PATTERN] } },
    });
    const result = checkSandboxFdAllowRead(tmpRoot);
    expect(result.status).toBe('PASS');
    expect(result.detail).toBe('');
  });

  it('FAIL when settings.json is absent (workspace never init\'d or refreshed)', () => {
    const result = checkSandboxFdAllowRead(tmpRoot);
    expect(result.status).toBe('FAIL');
    expect(result.detail).toContain(SANDBOX_FD_READ_PATTERN);
    expect(result.detail).toContain('macf update');
  });

  it('FAIL when sandbox key missing entirely', () => {
    writeSettings({ hooks: {} });
    const result = checkSandboxFdAllowRead(tmpRoot);
    expect(result.status).toBe('FAIL');
  });

  it('FAIL when allowRead exists but does not contain the fd pattern', () => {
    writeSettings({
      sandbox: { filesystem: { allowRead: ['/etc/hosts', '/var/lib/**'] } },
    });
    const result = checkSandboxFdAllowRead(tmpRoot);
    expect(result.status).toBe('FAIL');
    expect(result.detail).toContain(SANDBOX_FD_READ_PATTERN);
  });

  it('FAIL (surfacing parse error) when settings.json is malformed', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ not valid json');
    const result = checkSandboxFdAllowRead(tmpRoot);
    expect(result.status).toBe('FAIL');
    expect(result.detail).toMatch(/Refusing to overwrite malformed/);
  });

  it('PASS when operator has the pattern alongside other entries (operator-authored preserved)', () => {
    writeSettings({
      hooks: { PreToolUse: [] },
      sandbox: {
        filesystem: {
          allowRead: ['/etc/hosts', SANDBOX_FD_READ_PATTERN, '/custom/path/**'],
        },
      },
    });
    const result = checkSandboxFdAllowRead(tmpRoot);
    expect(result.status).toBe('PASS');
  });
});

describe('isToolFullyAllowed (macf#296)', () => {
  it('true for bare tool name', () => {
    expect(isToolFullyAllowed(['Write'], 'Write')).toBe(true);
  });

  it('true for glob form Tool(*)', () => {
    expect(isToolFullyAllowed(['Write(*)'], 'Write')).toBe(true);
  });

  it('false for scoped pattern Tool(/path)', () => {
    expect(isToolFullyAllowed(['Write(/etc/hosts)'], 'Write')).toBe(false);
  });

  it('false for unrelated entries', () => {
    expect(isToolFullyAllowed(['Read', 'Bash(git *)'], 'Write')).toBe(false);
  });

  it('false for empty allow list', () => {
    expect(isToolFullyAllowed([], 'Write')).toBe(false);
  });

  it('does not match a tool with overlapping prefix', () => {
    // "Edit" must not be matched by an entry "Edit2" or "EditCustom"
    expect(isToolFullyAllowed(['EditCustom'], 'Edit')).toBe(false);
  });
});

describe('hasToolDeny (macf#296)', () => {
  it('true for bare tool deny', () => {
    expect(hasToolDeny(['Write'], 'Write')).toBe(true);
  });

  it('true for scoped tool deny Tool(/path)', () => {
    expect(hasToolDeny(['Write(/etc/passwd)'], 'Write')).toBe(true);
  });

  it('false for unrelated deny entries', () => {
    expect(hasToolDeny(['Bash(rm -rf *)'], 'Write')).toBe(false);
  });

  it('false for empty deny list', () => {
    expect(hasToolDeny([], 'Write')).toBe(false);
  });
});

describe('checkPermissionsAllow (macf#296)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-perms-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSettings(obj: unknown): void {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(obj, null, 2));
  }

  it('lists Write and Edit as the canonical autonomy-required tools', () => {
    expect(AUTONOMY_REQUIRED_TOOLS).toEqual(['Write', 'Edit']);
  });

  it('PASS when allow contains both Write and Edit (bare)', () => {
    writeSettings({ permissions: { allow: ['Write', 'Edit', 'Bash(*)'] } });
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('PASS');
    expect(result.findings).toHaveLength(0);
  });

  it('PASS when allow contains both Write(*) and Edit(*) (glob form)', () => {
    writeSettings({ permissions: { allow: ['Write(*)', 'Edit(*)', 'Bash(*)'] } });
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('PASS');
    expect(result.findings).toHaveLength(0);
  });

  it('WARN with BLOCK severity when Write absent AND Bash absent', () => {
    writeSettings({ permissions: { allow: ['Edit'] } });
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('WARN');
    expect(result.findings).toHaveLength(1);
    const writeFinding = result.findings.find((f) => f.tool === 'Write');
    expect(writeFinding?.severity).toBe('BLOCK');
    expect(writeFinding?.hasBashFallback).toBe(false);
    expect(writeFinding?.message).toContain('autonomous file creation impossible');
  });

  it('WARN with WARN severity when Write absent BUT Bash present (degraded fallback)', () => {
    writeSettings({ permissions: { allow: ['Edit', 'Bash(*)'] } });
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('WARN');
    const writeFinding = result.findings.find((f) => f.tool === 'Write');
    expect(writeFinding?.severity).toBe('WARN');
    expect(writeFinding?.hasBashFallback).toBe(true);
    expect(writeFinding?.message).toContain('Bash fallback is present');
  });

  it('WARN when Edit absent (Bash fallback irrelevant — Edit gets WARN regardless)', () => {
    writeSettings({ permissions: { allow: ['Write', 'Bash(*)'] } });
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('WARN');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.tool).toBe('Edit');
    expect(result.findings[0]?.severity).toBe('WARN');
  });

  it('reports BOTH tools when both absent + no Bash (one BLOCK + one WARN)', () => {
    writeSettings({ permissions: { allow: ['Read'] } });
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('WARN');
    expect(result.findings).toHaveLength(2);
    const writeFinding = result.findings.find((f) => f.tool === 'Write');
    const editFinding = result.findings.find((f) => f.tool === 'Edit');
    expect(writeFinding?.severity).toBe('BLOCK');
    expect(editFinding?.severity).toBe('WARN');
  });

  it('INFO severity when Write absent AND deny rule present (deliberate scope)', () => {
    writeSettings({
      permissions: {
        allow: ['Edit', 'Bash(*)'],
        deny: ['Write(/etc/*)', 'Write(/root/*)'],
      },
    });
    const result = checkPermissionsAllow(tmpRoot);
    // Only Write is absent here (Edit IS present). With a deny rule for Write,
    // the lone finding is INFO-severity, so overall status is INFO.
    expect(result.status).toBe('INFO');
    const writeFinding = result.findings.find((f) => f.tool === 'Write');
    expect(writeFinding?.severity).toBe('INFO');
    expect(writeFinding?.hasDenyRule).toBe(true);
    expect(writeFinding?.message).toContain('likely deliberate scope');
  });

  it('overall status INFO when ALL findings are deny-rule deliberate', () => {
    writeSettings({
      permissions: {
        allow: ['Bash(*)'],
        deny: ['Write(/etc/*)', 'Edit(/etc/*)'],
      },
    });
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('INFO');
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.severity === 'INFO')).toBe(true);
  });

  it('does not treat scoped Write(/path) as fully present (still warns)', () => {
    // Write(/specific/path) doesn't cover other paths — agents still
    // prompt on writes elsewhere. Conservative: warn.
    writeSettings({ permissions: { allow: ['Write(/tmp/*)', 'Edit', 'Bash(*)'] } });
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('WARN');
    const writeFinding = result.findings.find((f) => f.tool === 'Write');
    expect(writeFinding).toBeDefined();
    // Bash IS present, no deny rule → severity is WARN (not BLOCK or INFO)
    expect(writeFinding?.severity).toBe('WARN');
  });

  it('PASS when Write(*) present plus scoped patterns (glob covers everything)', () => {
    writeSettings({
      permissions: {
        allow: ['Write(*)', 'Write(/specific)', 'Edit(*)', 'Bash(*)'],
      },
    });
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('PASS');
  });

  it('WARN with readError when settings.json is malformed', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ broken json');
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('WARN');
    expect(result.readError).toMatch(/Refusing to overwrite malformed/);
    expect(result.findings).toHaveLength(0);
  });

  it('reports BLOCK + WARN when settings.json absent entirely (empty allow)', () => {
    // No file → empty allow + empty deny → both Write and Edit missing,
    // no Bash fallback → Write=BLOCK, Edit=WARN.
    const result = checkPermissionsAllow(tmpRoot);
    expect(result.status).toBe('WARN');
    expect(result.findings).toHaveLength(2);
    const writeFinding = result.findings.find((f) => f.tool === 'Write');
    expect(writeFinding?.severity).toBe('BLOCK');
  });

  it('finding includes remediation snippet with concrete JSON shape hint', () => {
    writeSettings({ permissions: { allow: [] } });
    const result = checkPermissionsAllow(tmpRoot);
    const writeFinding = result.findings.find((f) => f.tool === 'Write');
    expect(writeFinding?.remediation).toContain('"Write"');
    expect(writeFinding?.remediation).toContain('"Write(*)"');
    expect(writeFinding?.remediation).toContain('permissions.allow');
  });
});

describe('deriveBotLogin (macf#707/#535)', () => {
  it('appends [bot] to a bare slug', () => {
    expect(deriveBotLogin('macf-auditor-agent')).toBe('macf-auditor-agent[bot]');
  });

  it('is idempotent — does not double-append [bot] when already present', () => {
    expect(deriveBotLogin('macf-auditor-agent[bot]')).toBe('macf-auditor-agent[bot]');
  });

  it('rejects an empty slug', () => {
    expect(() => deriveBotLogin('')).toThrow(/empty/i);
  });
});

describe('describeNonAppSlugOutput', () => {
  it('does not leak full unexpected output — only a short prefix + length', () => {
    const msg = describeNonAppSlugOutput('{"error":"some secret-bearing body"}');
    expect(msg).toContain('length=');
    expect(msg).not.toContain('secret-bearing');
  });

  it('reports (empty) for zero-length input', () => {
    expect(describeNonAppSlugOutput('')).toContain('(empty)');
  });
});

describe('checkBotLogin (macf#707/#535 — DR-028 attribution-hook detect+repair)', () => {
  function baseConfig(overrides: Partial<MacfAgentConfig> = {}): MacfAgentConfig {
    return {
      project: 'TEST',
      agent_name: 'test-agent',
      agent_role: 'code-agent',
      agent_type: 'permanent',
      registry: { type: 'repo', owner: 'o', repo: 'r' },
      github_app: { app_id: '1', install_id: '2', key_path: 'k.pem' },
      ...overrides,
    };
  }

  it('PASS when github_app.bot_login is already populated', () => {
    const result = checkBotLogin(baseConfig({
      github_app: { app_id: '1', install_id: '2', key_path: 'k.pem', bot_login: 'macf-code-agent[bot]' },
    }));
    expect(result.status).toBe('PASS');
  });

  it('WARN when github_app is present but bot_login is unset — attribution hook is inert', () => {
    const result = checkBotLogin(baseConfig());
    expect(result.status).toBe('WARN');
    expect(result.detail).toMatch(/attribution hook inert/i);
    expect(result.detail).toContain('bot_login');
  });

  it('WARN when bot_login is present but empty string', () => {
    const result = checkBotLogin(baseConfig({
      github_app: { app_id: '1', install_id: '2', key_path: 'k.pem', bot_login: '' },
    }));
    expect(result.status).toBe('WARN');
  });

  it('INFO (skip) when github_app is absent — local-registry mode (DR-024) has no App', () => {
    const { github_app, ...rest } = baseConfig();
    const result = checkBotLogin(rest as MacfAgentConfig);
    expect(result.status).toBe('INFO');
    expect(result.detail).toMatch(/local-registry|no github app/i);
  });
});

describe('checkCanonicalBranch (macf#755 — branch-guard DETECT half, Pattern A)', () => {
  function baseConfig(overrides: Partial<MacfAgentConfig> = {}): MacfAgentConfig {
    return {
      project: 'TEST',
      agent_name: 'test-agent',
      agent_role: 'code-agent',
      agent_type: 'permanent',
      registry: { type: 'repo', owner: 'o', repo: 'r' },
      ...overrides,
    };
  }

  it('PASS when the current branch matches the default canonical branch (main)', () => {
    const result = checkCanonicalBranch(baseConfig(), 'main');
    expect(result.status).toBe('PASS');
    expect(result.detail).toContain('main');
  });

  it('WARN when the current branch is a different branch than the default (main)', () => {
    const result = checkCanonicalBranch(baseConfig(), 'feat/some-branch');
    expect(result.status).toBe('WARN');
    expect(result.detail).toContain('feat/some-branch');
    expect(result.detail).toContain('main');
    expect(result.detail).toMatch(/mutate the wrong branch/i);
  });

  it('WARN with a detached-HEAD-specific message when currentBranch is null', () => {
    const result = checkCanonicalBranch(baseConfig(), null);
    expect(result.status).toBe('WARN');
    expect(result.detail).toMatch(/detached head/i);
  });

  it('respects a per-workspace canonicalBranch override — PASS when current matches the override', () => {
    const result = checkCanonicalBranch(baseConfig({ canonicalBranch: 'develop' }), 'develop');
    expect(result.status).toBe('PASS');
    expect(result.detail).toContain('develop');
  });

  it('WARN against the override when current does not match it', () => {
    const result = checkCanonicalBranch(baseConfig({ canonicalBranch: 'develop' }), 'main');
    expect(result.status).toBe('WARN');
    expect(result.detail).toContain('main');
    expect(result.detail).toContain('develop');
  });

  it('resolves the default (main) when config is null (unresolvable workspace)', () => {
    expect(checkCanonicalBranch(null, 'main').status).toBe('PASS');
    expect(checkCanonicalBranch(null, 'other').status).toBe('WARN');
  });
});

describe('checkRoutingLabelProjectPrefix (macf#1009 — DR-032 redundant-project-prefix identity lint)', () => {
  function baseConfig(overrides: Partial<MacfAgentConfig> = {}): MacfAgentConfig {
    return {
      project: 'icsoc-2026',
      agent_name: 'code-agent',
      agent_role: 'code-agent',
      agent_type: 'permanent',
      registry: { type: 'repo', owner: 'o', repo: 'r' },
      ...overrides,
    };
  }

  // --- Decisive pair (assert-the-wrong-path.md): a prefixed label must be
  // flagged BY VALUE (observed + expected named), and a correct label must
  // NOT be flagged — proving the check isn't a lint that fires on everything.

  it('WARNs when routing_label redundantly repeats the project, naming observed + expected', () => {
    const result = checkRoutingLabelProjectPrefix(baseConfig({
      routing_label: 'icsoc-2026-code-agent',
      agent_name: 'code-agent',
    }));
    expect(result.status).toBe('WARN');
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.field).toBe('routing_label');
    expect(finding?.severity).toBe('WARN');
    expect(finding?.observed).toBe('icsoc-2026-code-agent');
    expect(finding?.expected).toBe('code-agent');
    // Message must name the consequences, not just say "bad label".
    expect(finding?.message).toContain('icsoc-2026-code-agent');
    expect(finding?.message).toContain('code-agent');
    expect(finding?.message).toMatch(/registry variable/i);
    expect(finding?.message).toMatch(/tmux session/i);
    expect(finding?.message).toMatch(/silently dropped/i);
  });

  it('does NOT flag a bare (correct) routing_label', () => {
    const result = checkRoutingLabelProjectPrefix(baseConfig({
      routing_label: 'code-agent',
      agent_name: 'code-agent',
    }));
    expect(result.status).toBe('PASS');
    expect(result.findings).toEqual([]);
  });

  // --- agent_name at lower severity (AC #2) ---------------------------------

  it('flags a prefixed agent_name at INFO (not WARN) when routing_label is independently set and clean', () => {
    const result = checkRoutingLabelProjectPrefix(baseConfig({
      routing_label: 'code-agent',
      agent_name: 'icsoc-2026-code-agent',
    }));
    expect(result.status).toBe('INFO');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.field).toBe('agent_name');
    expect(result.findings[0]?.severity).toBe('INFO');
    expect(result.findings[0]?.observed).toBe('icsoc-2026-code-agent');
    expect(result.findings[0]?.expected).toBe('code-agent');
  });

  it('elevates a prefixed agent_name to WARN when routing_label is UNSET (agent_name IS the effective routing label)', () => {
    const { routing_label: _unused, ...rest } = baseConfig({ agent_name: 'icsoc-2026-code-agent' });
    const result = checkRoutingLabelProjectPrefix(rest as MacfAgentConfig);
    expect(result.status).toBe('WARN');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.field).toBe('agent_name');
    expect(result.findings[0]?.severity).toBe('WARN');
  });

  it('does NOT double-report when routing_label === agent_name and both are prefixed', () => {
    const result = checkRoutingLabelProjectPrefix(baseConfig({
      routing_label: 'icsoc-2026-code-agent',
      agent_name: 'icsoc-2026-code-agent',
    }));
    expect(result.status).toBe('WARN');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.field).toBe('routing_label');
  });

  // --- Independent-discriminator false-positive guard (the collision case a
  // blind `<project>-` string-prefix match would wrongly flag — see
  // `classifyProjectPrefix`'s doc for why `agent_role` is required here).
  // repo-init.ts's `normalizeDoublePrefixedKeys` documents the identical
  // trap on the repo-side agent-config.json key.

  it('does NOT confirm-WARN when the project coincidentally shares a stem with a CORRECT bare label', () => {
    // project "devops" + role "devops-agent" is a healthy, conventional
    // config — routing_label "devops-agent" is the bare form, not a doubled
    // prefix. A blind string-prefix match ("devops-agent".startsWith("devops-"))
    // would wrongly flag this and recommend renaming to "agent" — breaking a
    // working workspace. The check must not assert the confirmed,
    // routing-breaking claim here.
    const result = checkRoutingLabelProjectPrefix(baseConfig({
      project: 'devops',
      agent_role: 'devops-agent',
      routing_label: 'devops-agent',
      agent_name: 'devops-agent',
    }));
    expect(result.status).not.toBe('WARN');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('INFO');
    // Must NOT assert the confirmed routing-breaking mechanism it can't prove.
    expect(result.findings[0]?.message).not.toMatch(/silently dropped/i);
  });

  // --- Segment normalisation -------------------------------------------------

  it('flags a redundant prefix case/segment-insensitively (project stored SCREAMING_SNAKE)', () => {
    const result = checkRoutingLabelProjectPrefix(baseConfig({
      project: 'ICSOC_2026',
      routing_label: 'icsoc-2026-code-agent',
      agent_name: 'code-agent',
    }));
    expect(result.status).toBe('WARN');
    expect(result.findings[0]?.observed).toBe('icsoc-2026-code-agent');
    expect(result.findings[0]?.expected).toBe('code-agent');
  });

  it('derives "expected" from the canonical agent_role, not a raw slice of a SCREAMING_SNAKE label', () => {
    // Regression guard: an earlier implementation sliced the RAW observed
    // label to compute "expected", which produced a non-canonical
    // "CODE_AGENT" for a SCREAMING_SNAKE-cased routing_label. Deriving
    // "expected" from agent_role instead always yields the canonical kebab
    // form regardless of how the observed value happens to be cased.
    const result = checkRoutingLabelProjectPrefix(baseConfig({
      project: 'icsoc-2026',
      agent_role: 'code-agent',
      routing_label: 'ICSOC_2026_CODE_AGENT',
      agent_name: 'code-agent',
    }));
    expect(result.status).toBe('WARN');
    expect(result.findings[0]?.expected).toBe('code-agent');
  });

  // --- Degenerate edge: nothing left after the prefix — not a "redundant
  // prefix" finding (a different check's territory, if this ever occurs).

  it('does NOT flag a label that is exactly "<project>-" with nothing after it', () => {
    const result = checkRoutingLabelProjectPrefix(baseConfig({
      routing_label: 'icsoc-2026-',
      agent_name: 'code-agent',
    }));
    expect(result.status).toBe('PASS');
  });

  // --- Honest-unknown floor (house standard — macf#1078, #1096, #1117) -----

  it('reports UNKNOWN (never PASS) when config is null — macf-agent.json absent or unreadable', () => {
    const result = checkRoutingLabelProjectPrefix(null);
    expect(result.status).toBe('UNKNOWN');
    expect(result.findings).toEqual([]);
  });
});

describe('readCurrentBranch (macf#755 — real git)', () => {
  let repo: string;

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('returns the current branch name for a real git repo', () => {
    repo = mkdtempSync(join(tmpdir(), 'doctor-branch-'));
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    writeFileSync(join(repo, 'f.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
    expect(readCurrentBranch(repo)).toBe('main');
  });

  it('returns null on a detached HEAD', () => {
    repo = mkdtempSync(join(tmpdir(), 'doctor-branch-'));
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    writeFileSync(join(repo, 'f.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    execFileSync('git', ['checkout', sha], { cwd: repo, stdio: 'ignore' });
    expect(readCurrentBranch(repo)).toBeNull();
  });

  it('returns null when the directory is not a git repo', () => {
    repo = mkdtempSync(join(tmpdir(), 'doctor-branch-notgit-'));
    expect(readCurrentBranch(repo)).toBeNull();
  });
});

describe('checkLoadBearingHooks (DR-039 Decision 1)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-hooks-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSettingsJson(obj: unknown): void {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'settings.json'), JSON.stringify(obj, null, 2));
  }

  function writeClaudeSh(pluginDirExpr: string): void {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      [
        '#!/bin/bash',
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
        `exec claude --plugin-dir "${pluginDirExpr}" "$@"`,
        '',
      ].join('\n'),
    );
  }

  function writePluginHooksJson(pluginRelDir: string, obj: unknown): void {
    const dir = join(tmpRoot, pluginRelDir, 'hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify(obj, null, 2));
  }

  /** All 7 bash-command load-bearing hooks (everything except the
   *  mcp_tool-only, plugin-bound `checkpoint_to_memory`), in settings.json shape. */
  function allBashHooksSettings(): unknown {
    return {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-gh-token.sh' }] },
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-mention-routing.sh' }] },
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-lgtm-gate.sh' }] },
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-close-keyword.sh' }] },
        ],
        PostToolUse: [
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-gh-attribution.sh' }] },
        ],
        PreCompact: [
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/harvest-reflection.sh' }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-channel-alive.sh' }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-channel-alive.sh' }] },
        ],
      },
    };
  }

  function pluginHooksJsonWithCheckpoint(): unknown {
    return {
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'mcp_tool',
                server: 'plugin:macf-agent:macf-agent',
                tool: 'checkpoint_to_memory',
                input: { session_id: '${session_id}' },
              },
            ],
          },
        ],
      },
    };
  }

  it('has exactly the 8 DR-039 load-bearing hooks (7 bash + 1 mcp_tool)', () => {
    const names = DR039_LOAD_BEARING_HOOKS.map((h) => h.name).sort();
    expect(names).toEqual(
      [
        'check-channel-alive',
        'check-close-keyword',
        'check-gh-attribution',
        'check-gh-token',
        'check-lgtm-gate',
        'check-mention-routing',
        'checkpoint_to_memory',
        'harvest-reflection',
      ].sort(),
    );
    const mcpTools = DR039_LOAD_BEARING_HOOKS.filter((h) => h.kind === 'mcp_tool');
    expect(mcpTools).toHaveLength(1);
    expect(mcpTools[0]?.match).toBe('checkpoint_to_memory');
  });

  it('PASS: all hooks present — settings.json bash hooks + full plugin hooks.json (mounted via claude.sh)', () => {
    writeSettingsJson(allBashHooksSettings());
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin');
    writePluginHooksJson('.macf/plugin', pluginHooksJsonWithCheckpoint());
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });

    const result = checkLoadBearingHooks(tmpRoot);
    expect(result.status).toBe('PASS');
    expect(result.missing).toEqual([]);
    expect(result.presentCount).toBe(result.totalCount);
    expect(result.totalCount).toBe(DR039_LOAD_BEARING_HOOKS.length);
  });

  it('WARN: the plugin-cs case — claude.sh loads a hooks-less plugin variant, checkpoint_to_memory absent', () => {
    writeSettingsJson(allBashHooksSettings());
    // plugin-cs: mcpServers-only, no hooks/ dir at all (macf#533 / the DR-039 trigger shape).
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin-cs');
    mkdirSync(join(tmpRoot, '.macf', 'plugin-cs'), { recursive: true });
    // NOT writing hooks/hooks.json under plugin-cs — that's the whole point.

    const result = checkLoadBearingHooks(tmpRoot);
    expect(result.status).toBe('WARN');
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]?.name).toBe('checkpoint_to_memory');
    expect(result.presentCount).toBe(result.totalCount - 1);
    // The resolved (loaded) plugin dir shows up in the report detail, not a
    // silently-substituted default — the whole point of the assertion.
    expect(result.detail).toContain('plugin-cs');
  });

  it('WARN: names every missing hook when settings.json is entirely empty and the plugin has no hooks dir', () => {
    writeSettingsJson({});
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin-cs');
    mkdirSync(join(tmpRoot, '.macf', 'plugin-cs'), { recursive: true });

    const result = checkLoadBearingHooks(tmpRoot);
    expect(result.status).toBe('WARN');
    expect(result.missing).toHaveLength(DR039_LOAD_BEARING_HOOKS.length);
    const missingNames = result.missing.map((m) => m.name).sort();
    expect(missingNames).toEqual(DR039_LOAD_BEARING_HOOKS.map((h) => h.name).sort());
  });

  it('PASS: mixed sources — some hooks in settings.json, some in the plugin hooks.json — union covers all', () => {
    // Split: checkpoint_to_memory + check-gh-attribution live in the plugin's
    // hooks.json; everything else lives in settings.json.
    writeSettingsJson({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-gh-token.sh' }] },
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-mention-routing.sh' }] },
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-lgtm-gate.sh' }] },
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-close-keyword.sh' }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-channel-alive.sh' }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/scripts/check-channel-alive.sh' }] },
        ],
      },
    });
    writeClaudeSh('$SCRIPT_DIR/.macf/plugin');
    writePluginHooksJson('.macf/plugin', {
      hooks: {
        PreCompact: [
          {
            hooks: [
              { type: 'mcp_tool', server: 'plugin:macf-agent:macf-agent', tool: 'checkpoint_to_memory' },
            ],
          },
          {
            hooks: [
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/harvest-reflection.sh' },
            ],
          },
        ],
        PostToolUse: [
          { hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/check-gh-attribution.sh' }] },
        ],
      },
    });

    const result = checkLoadBearingHooks(tmpRoot);
    expect(result.status).toBe('PASS');
    expect(result.missing).toEqual([]);
  });

  it('INFO: no .macf/ directory — not a macf-init-managed workspace, no false WARN', () => {
    // Deliberately no .macf, no claude.sh, no settings.json — a bare/local dir.
    const result = checkLoadBearingHooks(tmpRoot);
    expect(result.status).toBe('INFO');
    expect(result.missing).toEqual([]);
    expect(result.detail).toMatch(/not a macf-init-managed workspace/i);
  });

  it('a missing hook produces WARN, not a hard-fail (this slice is detect+report, not exit-code-affecting)', () => {
    writeSettingsJson({});
    mkdirSync(join(tmpRoot, '.macf'), { recursive: true });
    const result = checkLoadBearingHooks(tmpRoot);
    expect(result.status).toBe('WARN');
  });
});

describe('resolvePluginDirFromClaudeSh (DR-039)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-plugindir-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('not determinable when claude.sh is absent', () => {
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(false);
    expect(result.dir).toBeNull();
    expect(result.detail).toMatch(/no claude\.sh/i);
  });

  it('resolves a single --plugin-dir "$SCRIPT_DIR/.macf/plugin" to the workspace-relative absolute path', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      'exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"\n',
    );
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(true);
    expect(result.dir).toBe(join(tmpRoot, '.macf', 'plugin'));
  });

  it('resolves a hand-edited launcher pointing at .macf/plugin-cs', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      'exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin-cs" "$@"\n',
    );
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(true);
    expect(result.dir).toBe(join(tmpRoot, '.macf', 'plugin-cs'));
  });

  // macf#739 follow-up hardening (science-agent review): the original regex
  // was double-quote-only, so a hand-authored launcher using an unquoted var
  // or single-quoted path was silently treated as "no --plugin-dir flag" —
  // masked by the default-fallback posture (getEffectiveHookConfig falls back
  // to `.macf/plugin`), hiding a hooks-less variant instead of surfacing it.
  it('resolves an UNQUOTED --plugin-dir value (macf#739 follow-up hardening)', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      'exec claude --plugin-dir $SCRIPT_DIR/.macf/plugin "$@"\n',
    );
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(true);
    expect(result.dir).toBe(join(tmpRoot, '.macf', 'plugin'));
  });

  it('resolves a SINGLE-QUOTED --plugin-dir absolute path (macf#739 follow-up hardening)', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      "exec claude --plugin-dir '$SCRIPT_DIR/.macf/plugin-cs' \"$@\"\n",
    );
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(true);
    expect(result.dir).toBe(join(tmpRoot, '.macf', 'plugin-cs'));
  });

  it('not determinable when claude.sh has no --plugin-dir flag at all', () => {
    writeFileSync(join(tmpRoot, 'claude.sh'), 'exec claude "$@"\n');
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(false);
    expect(result.dir).toBeNull();
  });

  it('not determinable when claude.sh has multiple distinct --plugin-dir values (ambiguous)', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      [
        'if [ -n "$FOO" ]; then',
        '  claude --plugin-dir "$SCRIPT_DIR/.macf/plugin-a" "$@"',
        'else',
        '  exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin-b" "$@"',
        'fi',
        '',
      ].join('\n'),
    );
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(false);
    expect(result.dir).toBeNull();
    expect(result.detail).toMatch(/multiple distinct/i);
  });

  it('is fine with the SAME --plugin-dir value repeated twice (the canonical resume-fallback claude.sh shape)', () => {
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      [
        'claude -c --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@" || ' +
          'exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"',
        '',
      ].join('\n'),
    );
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(true);
    expect(result.dir).toBe(join(tmpRoot, '.macf', 'plugin'));
  });

  it('IGNORES a --plugin-dir MENTIONED in a comment (macf#756) — the canonical claude.sh shape', () => {
    // The canonical launcher has a channels-enablement comment whose line ENDS
    // with the words "...the --plugin-dir" (documentation, not a flag). The old
    // `\s+`-spanning regex matched that trailing `--plugin-dir` and grabbed the
    // NEXT line's leading `#` as a spurious second value → false "multiple
    // distinct --plugin-dir values: #, ..." → macf doctor warned on EVERY
    // canonical workspace + `canPluginDeliverMigratedHooks` fell to the (safe)
    // defer path. The real flag lines are on the exec/resume lines below.
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      [
        '# The dev-flag form is required because the --plugin-dir',
        '# macf-agent plugin is not on the curated channel allowlist.',
        'claude -c --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@" || ' +
          'exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"',
        '',
      ].join('\n'),
    );
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(true);
    expect(result.dir).toBe(join(tmpRoot, '.macf', 'plugin'));
    expect(result.detail).not.toMatch(/multiple distinct/i);
  });

  it('does NOT let a trailing --plugin-dir on one line grab the next line’s token (macf#756 — same-line whitespace only)', () => {
    // Even for NON-comment lines: a `--plugin-dir` with no same-line argument
    // must not consume the following line's first token. (The `[^\S\r\n]+`
    // change makes the flag require a same-line value; here the only real,
    // resolvable flag is the exec line.)
    writeFileSync(
      join(tmpRoot, 'claude.sh'),
      [
        'echo "note: pass --plugin-dir"',
        'exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"',
        '',
      ].join('\n'),
    );
    const result = resolvePluginDirFromClaudeSh(tmpRoot);
    expect(result.determinable).toBe(true);
    expect(result.dir).toBe(join(tmpRoot, '.macf', 'plugin'));
  });
});

describe('getEffectiveHookConfig fallback (DR-039 "err toward not-false-alarming")', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'doctor-effective-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('falls back to the default .macf/plugin/hooks/hooks.json when claude.sh is absent/ambiguous', () => {
    // No claude.sh at all — plugin dir is NOT cleanly determinable.
    mkdirSync(join(tmpRoot, '.macf', 'plugin', 'hooks'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.macf', 'plugin', 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreCompact: [
            { hooks: [{ type: 'mcp_tool', server: 'plugin:macf-agent:macf-agent', tool: 'checkpoint_to_memory' }] },
          ],
        },
      }),
    );

    const config = getEffectiveHookConfig(tmpRoot);
    expect(config.usedDefaultFallback).toBe(true);
    expect(config.entries.some((e) => e.kind === 'mcp_tool' && e.value === 'checkpoint_to_memory')).toBe(true);
  });
});
