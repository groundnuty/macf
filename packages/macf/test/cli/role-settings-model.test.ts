/**
 * DR-028 — `ROLE_SETTINGS_MODEL` data-model tests (the foundation; the
 * `macf init` emit + `macf doctor` validate/--fix wiring land as follow-ups).
 */
import { describe, it, expect } from 'vitest';
import {
  ROLE_FLOOR_ALLOW,
  ROLE_FLOOR_DENY,
  ROLE_FLOOR_HOOKS,
  ROLE_SETTINGS_DELTAS,
  KNOWN_ROLES,
  isKnownRole,
  expectedHooksForRole,
  expectedAllowForRole,
} from '../../src/cli/role-settings-model.js';

describe('DR-028 role-settings model', () => {
  describe('KNOWN_ROLES / isKnownRole (macf#551)', () => {
    it('recognizes the canonical roles incl. the exact "auditor" (no -agent suffix)', () => {
      for (const r of ['auditor', 'code-agent', 'science-agent', 'devops-agent', 'writing-agent']) {
        expect(isKnownRole(r)).toBe(true);
        expect(KNOWN_ROLES).toContain(r);
      }
    });
    it('does NOT recognize a near-miss on the safety-critical auditor role', () => {
      // The hazard: `auditor-agent` would silently skip the never-acts hook +
      // its doctor ERROR. isKnownRole(false) lets the doctor surface it.
      expect(isKnownRole('auditor-agent')).toBe(false);
      expect(isKnownRole('Auditor')).toBe(false);
      expect(isKnownRole('custom-role')).toBe(false);
    });
    it('every role with a delta is a known role (no orphan delta)', () => {
      for (const role of Object.keys(ROLE_SETTINGS_DELTAS)) {
        expect(isKnownRole(role)).toBe(true);
      }
    });
  });

  describe('universal floor — allow', () => {
    it('carries broad Bash(*) + the read/write/edit tools (the doctrine + the memory-edit fix)', () => {
      // Broad Bash(*) — narrow patterns are defeated by simple_expansion.
      expect(ROLE_FLOOR_ALLOW).toContain('Bash(*)');
      // Write/Edit close the memory-edit prompt (code/science lack them today).
      for (const tool of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent']) {
        expect(ROLE_FLOOR_ALLOW).toContain(tool);
      }
    });
  });

  describe('universal floor — deny (the real guardrail)', () => {
    it('blocks credential/secret reads', () => {
      for (const d of ['Read(~/.ssh/id_*)', 'Read(~/.ssh/*.pem)', 'Read(~/.aws/**)', 'Read(~/.gnupg/**)']) {
        expect(ROLE_FLOOR_DENY).toContain(d);
      }
    });
    it('blocks config/dotfile writes (incl. its own settings.json)', () => {
      for (const d of ['Write(~/.claude/settings.json)', 'Write(~/.ssh/**)', 'Write(~/.aws/**)']) {
        expect(ROLE_FLOOR_DENY).toContain(d);
      }
    });
    it('blocks the dangerous commands', () => {
      for (const d of ['Bash(sudo *)', 'Bash(rm -rf /)', 'Bash(git commit --no-verify *)']) {
        expect(ROLE_FLOOR_DENY).toContain(d);
      }
      // some force-push variant is denied
      expect(ROLE_FLOOR_DENY.some((d) => /git push.*(--force|-f)/.test(d))).toBe(true);
    });
  });

  describe('universal floor — hooks', () => {
    it('includes the gh-token + attribution + turn-receipt + reflection + channels hooks, none REQUIRED', () => {
      const cmds = ROLE_FLOOR_HOOKS.map((h) => h.command);
      expect(cmds.some((c) => c.includes('check-gh-token.sh'))).toBe(true);
      expect(cmds.some((c) => c.includes('check-gh-attribution.sh'))).toBe(true);
      expect(cmds.some((c) => c.includes('emit-turn-receipt.sh'))).toBe(true);
      expect(cmds.some((c) => c.includes('harvest-reflection.sh'))).toBe(true);
      expect(cmds.some((c) => c.includes('check-channels-enabled.sh'))).toBe(true);
      // The channels guard is a SessionStart hook (macf#633).
      expect(
        ROLE_FLOOR_HOOKS.some(
          (h) => h.event === 'SessionStart' && h.command.includes('check-channels-enabled.sh'),
        ),
      ).toBe(true);
      // No floor hook is REQUIRED (only the auditor's never-acts is).
      expect(ROLE_FLOOR_HOOKS.every((h) => h.required === false)).toBe(true);
    });
  });

  describe('per-role deltas', () => {
    it('auditor adds the never-acts hook as REQUIRED (a missing one is an error, not drift)', () => {
      const hooks = expectedHooksForRole('auditor');
      const neverActs = hooks.find((h) => h.command.includes('check-auditor-never-acts.sh'));
      expect(neverActs).toBeDefined();
      expect(neverActs!.required).toBe(true);
      // auditor still gets the floor (incl Write/Edit) — never-acts is hook-enforced, not permission-removed.
      expect(expectedAllowForRole('auditor')).toContain('Write');
      expect(expectedAllowForRole('auditor')).toContain('Edit');
    });

    it('code/science/devops get the floor as-is (no never-acts, no extra delta)', () => {
      for (const role of ['code-agent', 'science-agent', 'devops-agent']) {
        expect(ROLE_SETTINGS_DELTAS[role]).toBeUndefined();
        expect(expectedHooksForRole(role)).toEqual(ROLE_FLOOR_HOOKS);
        expect(expectedHooksForRole(role).some((h) => h.required)).toBe(false);
        expect(expectedAllowForRole(role)).toEqual(ROLE_FLOOR_ALLOW);
      }
    });
  });
});
