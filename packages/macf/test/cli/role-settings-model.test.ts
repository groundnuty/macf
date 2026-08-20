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
  startupPickupAutoResumesByDefault,
} from '../../src/cli/role-settings-model.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

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
    it('blocks config/dotfile writes (incl. its own settings.json) via Edit(path), never Write(path)', () => {
      // groundnuty/macf#1067: Claude Code's file-permission check consults
      // only Edit(path) + Read(path) rules — a Write(path) deny entry is
      // accepted but never consulted, and Claude Code warns at startup that
      // it's ineffective. Edit(path) alone covers Write/NotebookEdit/Glob/
      // MultiEdit for that path, so it's both necessary and sufficient here.
      for (const d of ['Edit(~/.claude/settings.json)', 'Edit(~/.ssh/**)', 'Edit(~/.aws/**)']) {
        expect(ROLE_FLOOR_DENY).toContain(d);
      }
      // Regression guard: the ineffective Write(<path>) form must never
      // reappear in the canonical floor.
      for (const entry of ROLE_FLOOR_DENY) {
        expect(entry).not.toMatch(/^Write\(.+\)$/);
      }
    });
    it('blocks the dangerous commands', () => {
      for (const d of ['Bash(sudo *)', 'Bash(rm -rf /)', 'Bash(git commit --no-verify *)']) {
        expect(ROLE_FLOOR_DENY).toContain(d);
      }
      // some force-push variant is denied
      expect(ROLE_FLOOR_DENY.some((d) => /git push.*(--force|-f)/.test(d))).toBe(true);
    });

    it('DECISIVE (macf#1067): every entry is a form Claude Code actually consults for file-permission checks', () => {
      // Per Claude Code's permissions docs ("Configure permissions" §
      // "Read and Edit"): "Claude Code checks file permissions against
      // Edit(path) and Read(path) rules only. If you write a path rule
      // for Write, NotebookEdit, Glob, or the legacy MultiEdit tool
      // instead, Claude Code accepts the rule but never consults it" —
      // and warns at startup, on every launch, that the rule is dead.
      //
      // Assert over the WHOLE array, not a sample of known-bad entries:
      // the #1067 defect shipped specifically because a prior review only
      // checked a handful of paths (the ones quoted in the operator's
      // startup log) while 13 other Write(<path>) entries stayed broken
      // unexamined. A set-membership question needs a set-membership
      // test, not a spot-check.
      const INEFFECTIVE_PATH_SCOPED_FILE_RULE = /^(Write|NotebookEdit|Glob|MultiEdit)\(.+\)$/;
      for (const entry of ROLE_FLOOR_DENY) {
        expect(entry).not.toMatch(INEFFECTIVE_PATH_SCOPED_FILE_RULE);
      }

      // Positive half of the same assertion: every file-tool entry present
      // uses one of the two forms Claude Code's docs confirm ARE consulted.
      const fileToolEntries = ROLE_FLOOR_DENY.filter((e) => /^(Read|Edit|Write|NotebookEdit|Glob|MultiEdit)\(/.test(e));
      expect(fileToolEntries.length).toBeGreaterThan(0);
      for (const entry of fileToolEntries) {
        expect(entry).toMatch(/^(Read|Edit)\(.+\)$/);
      }

      // Bash entries are a DIFFERENT tool-rule family (fully supported —
      // Bash(<command-pattern>) rules ARE consulted per the same docs'
      // "Bash" section) — sanity-check none accidentally collapsed into
      // the file-tool shape being tested above, and that every Bash entry
      // is well-formed (non-empty command specifier).
      const bashEntries = ROLE_FLOOR_DENY.filter((e) => e.startsWith('Bash('));
      expect(bashEntries.length).toBeGreaterThan(0);
      for (const entry of bashEntries) {
        expect(entry).toMatch(/^Bash\(.+\)$/);
      }

      // Every entry falls into exactly one of the three known-good
      // families above — nothing unaccounted for.
      expect(fileToolEntries.length + bashEntries.length).toBe(ROLE_FLOOR_DENY.length);
    });
  });

  describe('universal floor — hooks', () => {
    // Per DR-039 Decision 2 (groundnuty/macf#731/#739), check-gh-token /
    // check-mention-routing / check-lgtm-gate / check-close-keyword /
    // check-gh-attribution / harvest-reflection / check-channel-alive
    // single-sourced into the plugin's hooks.json and are NO LONGER part of
    // this settings.json floor model — `installGhTokenHook` no longer writes
    // them, so the floor now only lists what stays hand-wired: the
    // turn-receipt hook (UserPromptSubmit) + the channels-enabled guard
    // (SessionStart). Their presence is still asserted overall by the
    // broader DR-039 `checkLoadBearingHooks` union-check in `doctor.ts`.
    it('includes the turn-receipt + channels-enabled + startup-pickup hooks post-DR-039-Decision-2, none REQUIRED', () => {
      const cmds = ROLE_FLOOR_HOOKS.map((h) => h.command);
      expect(cmds.some((c) => c.includes('emit-turn-receipt.sh'))).toBe(true);
      expect(cmds.some((c) => c.includes('check-channels-enabled.sh'))).toBe(true);
      // groundnuty/macf#768: the canonical SessionStart work-pickup hook —
      // written for EVERY role (including the auditor); the auditor's
      // DR-026 default-OFF is enforced by the script at runtime, not by
      // this expected-settings model.
      expect(cmds.some((c) => c.includes('macf-startup-pickup.sh'))).toBe(true);
      // The 7 hooks single-sourced into the plugin are NOT part of this floor.
      expect(cmds.some((c) => c.includes('check-gh-token.sh'))).toBe(false);
      expect(cmds.some((c) => c.includes('check-mention-routing.sh'))).toBe(false);
      expect(cmds.some((c) => c.includes('check-lgtm-gate.sh'))).toBe(false);
      expect(cmds.some((c) => c.includes('check-close-keyword.sh'))).toBe(false);
      expect(cmds.some((c) => c.includes('check-gh-attribution.sh'))).toBe(false);
      expect(cmds.some((c) => c.includes('harvest-reflection.sh'))).toBe(false);
      expect(cmds.some((c) => c.includes('check-channel-alive.sh'))).toBe(false);
      // The channels guard + the startup-pickup hook are both SessionStart
      // hooks (macf#633 / macf#768).
      expect(
        ROLE_FLOOR_HOOKS.some(
          (h) => h.event === 'SessionStart' && h.command.includes('check-channels-enabled.sh'),
        ),
      ).toBe(true);
      expect(
        ROLE_FLOOR_HOOKS.some(
          (h) => h.event === 'SessionStart' && h.command.includes('macf-startup-pickup.sh'),
        ),
      ).toBe(true);
      // No floor hook is REQUIRED (only the auditor's never-acts is).
      expect(ROLE_FLOOR_HOOKS.every((h) => h.required === false)).toBe(true);
    });
  });

  describe('startupPickupAutoResumesByDefault (DR-026 / macf#768)', () => {
    it('defaults ON for actuator roles (code/science/devops/writing + exp-*)', () => {
      for (const role of [
        'code-agent',
        'science-agent',
        'devops-agent',
        'writing-agent',
        'exp-code-agent',
        'exp-science-code-aware',
        'exp-science-domain-only',
        'exp-single-agent',
      ]) {
        expect(startupPickupAutoResumesByDefault(role)).toBe(true);
      }
    });

    it('defaults OFF for the auditor — a propose-only sensor/discussant, never an actuator', () => {
      expect(startupPickupAutoResumesByDefault('auditor')).toBe(false);
    });

    it('defaults ON for an unknown/custom role (auditor is the sole default-OFF role)', () => {
      expect(startupPickupAutoResumesByDefault('some-custom-role')).toBe(true);
    });

    // Lockstep: the bash hook script CANNOT import this TS module, so its
    // runtime role-gate duplicates the same 'auditor' sentinel by hand. This
    // test pins the two copies together — if either the TS predicate or the
    // script's gate string drifts off "auditor", this test catches it rather
    // than the two silently diverging.
    it('the script re-implements the identical policy (same auditor sentinel)', () => {
      const scriptPath = join(findCliPackageRoot(), 'scripts', 'macf-startup-pickup.sh');
      const script = readFileSync(scriptPath, 'utf-8');
      expect(script).toMatch(/MACF_AGENT_ROLE:-\}"\s*==\s*"auditor"/);
      // And the TS predicate agrees: false ONLY for 'auditor'.
      expect(startupPickupAutoResumesByDefault('auditor')).toBe(false);
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
