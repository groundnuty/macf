/**
 * Tests for `plugin/scripts/check-framework-surface.sh` — the SessionStart
 * guard that detects a swept/missing macf framework surface (the plugin
 * mount, the identity config, the guard-hook scripts) and warns LOUDLY into
 * the agent's context. groundnuty/macf#814 — the DETECT half of the
 * prevent+detect combination (the PREVENT half is check-git-sweep.sh).
 *
 * Hook contract (SessionStart): JSON on stdin; STDOUT is injected into the
 * agent's context. OBSERVATIONAL + NON-BLOCKING — the script ALWAYS exits 0
 * (fail open / silent on a healthy or non-managed workspace). Override:
 * MACF_SKIP_FRAMEWORK_CHECK=1.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-framework-surface.sh');

interface WorkspaceSpec {
  /** `.macf/` directory exists at all. Default true. */
  readonly macfDir?: boolean;
  /** `.macf/plugin/` exists. Default true. */
  readonly pluginDir?: boolean;
  /** `.macf/plugin/` has at least one entry (only meaningful if pluginDir). Default true. */
  readonly pluginNonEmpty?: boolean;
  /** `.macf/macf-agent.json` exists. Default true. */
  readonly agentConfig?: boolean;
  /** `.claude/settings.json` exists. Default true. */
  readonly settingsJson?: boolean;
  /** Names of `.claude/scripts/check-*.sh` files to create. Default one entry. */
  readonly checkScripts?: readonly string[];
  /**
   * Simulates the on-disk `.git` shape at the workspace root
   * (groundnuty/macf#1114 linked-worktree no-op — discriminator reused
   * verbatim from groundnuty/macf#1042 / #1113's `macf-startup-pickup.sh`).
   * Omitted (default) = no `.git` at all — indeterminate, falls through
   * unchanged (still evaluates + can still alarm).
   *   - `'worktree'`  → `.git` is a FILE containing a `gitdir: ...` pointer
   *                     (the real shape `git worktree add` produces) →
   *                     CONFIRMED worker → full no-op, no evaluation at all.
   *   - `'primary'`   → `.git` is a real DIRECTORY (the real shape a primary
   *                     checkout has) → indeterminate-by-shape but the
   *                     GENUINE non-worker case → evaluates normally.
   *   - `'malformed'` → `.git` is a FILE but does NOT match `^gitdir: ` →
   *                     indeterminate → falls through unchanged (still
   *                     evaluates + can still alarm — the fail-open-toward-
   *                     alarming floor, inverted from #1042's fail-open-
   *                     toward-inject).
   */
  readonly gitDotShape?: 'worktree' | 'primary' | 'malformed';
}

function buildWorkspace(spec: WorkspaceSpec): string {
  const {
    macfDir = true,
    pluginDir = true,
    pluginNonEmpty = true,
    agentConfig = true,
    settingsJson = true,
    checkScripts = ['check-gh-token.sh'],
    gitDotShape,
  } = spec;

  const workspace = mkdtempSync(join(tmpdir(), 'macf-fwsurf-ws-'));

  // groundnuty/macf#1114 linked-worktree no-op — see `gitDotShape`'s own doc
  // comment. Omitted entirely (the default) leaves NO `.git` at the
  // workspace root, matching every other test in this file pre-dating #1114.
  if (gitDotShape === 'worktree') {
    writeFileSync(join(workspace, '.git'), 'gitdir: /some/other/repo/.git/worktrees/agent-x\n');
  } else if (gitDotShape === 'primary') {
    mkdirSync(join(workspace, '.git'), { recursive: true });
  } else if (gitDotShape === 'malformed') {
    writeFileSync(join(workspace, '.git'), 'not a gitdir pointer\n');
  }

  if (macfDir) {
    mkdirSync(join(workspace, '.macf'), { recursive: true });
    if (pluginDir) {
      const pdir = join(workspace, '.macf', 'plugin');
      mkdirSync(pdir, { recursive: true });
      if (pluginNonEmpty) writeFileSync(join(pdir, 'hooks.json'), '{}');
    }
    if (agentConfig) {
      writeFileSync(join(workspace, '.macf', 'macf-agent.json'), '{}');
    }
  }

  if (settingsJson || checkScripts.length > 0) {
    mkdirSync(join(workspace, '.claude'), { recursive: true });
  }
  if (settingsJson) {
    writeFileSync(join(workspace, '.claude', 'settings.json'), '{}');
  }
  if (checkScripts.length > 0) {
    mkdirSync(join(workspace, '.claude', 'scripts'), { recursive: true });
    for (const name of checkScripts) {
      writeFileSync(join(workspace, '.claude', 'scripts', name), '#!/usr/bin/env bash\nexit 0\n');
    }
  }

  return workspace;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runHook(opts: {
  readonly workspace: string;
  readonly env?: Record<string, string | undefined>;
}): RunResult {
  const cleanEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    CLAUDE_PROJECT_DIR: opts.workspace,
  };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }
  const res = spawnSync('bash', [HOOK_SCRIPT], {
    input: JSON.stringify({ session_id: 'sess-x', source: 'startup' }),
    env: cleanEnv,
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('check-framework-surface.sh (hook)', () => {
  describe('healthy managed workspace', () => {
    it('stays silent (no stdout warning) when everything is present', () => {
      const ws = buildWorkspace({});
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('non-managed workspace (false-warn guard)', () => {
    it('stays silent when neither .macf/ nor .claude/settings.json exist (bare checkout)', () => {
      const ws = buildWorkspace({
        macfDir: false,
        agentConfig: false,
        settingsJson: false,
        checkScripts: [],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('treats .claude/settings.json alone as evidence of a managed workspace', () => {
      // A workspace with settings.json but no .macf/ dir at all (edge case) —
      // still evaluated (and flagged, since .macf/plugin and macf-agent.json
      // are both absent by construction here).
      const ws = buildWorkspace({
        macfDir: false,
        agentConfig: false,
        settingsJson: true,
        checkScripts: ['check-gh-token.sh'],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('MACF FRAMEWORK SURFACE IS DAMAGED');
        expect(r.stdout).toContain('.macf/plugin/');
        expect(r.stdout).toContain('macf-agent.json');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('damaged managed workspace — detection', () => {
    it('warns when .macf/plugin/ is entirely missing', () => {
      const ws = buildWorkspace({ pluginDir: false });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('MACF FRAMEWORK SURFACE IS DAMAGED');
        expect(r.stdout).toContain('groundnuty/macf#814');
        expect(r.stdout).toContain('.macf/plugin/');
        expect(r.stdout).toContain('macf update');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('warns when .macf/plugin/ exists but is empty', () => {
      const ws = buildWorkspace({ pluginDir: true, pluginNonEmpty: false });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('.macf/plugin/');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('warns when .macf/macf-agent.json is missing', () => {
      const ws = buildWorkspace({ agentConfig: false });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('macf-agent.json');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('warns when zero .claude/scripts/check-*.sh files are present', () => {
      const ws = buildWorkspace({ checkScripts: [] });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('check-*.sh');
        expect(r.stdout).toContain('UNGUARDED');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('does NOT warn about check-*.sh when at least one is present, even with an unrelated script alongside', () => {
      const ws = buildWorkspace({ checkScripts: ['check-lgtm-gate.sh'] });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('lists ALL missing surfaces together when multiple are gone (the #814 incident shape)', () => {
      const ws = buildWorkspace({ pluginDir: false, agentConfig: false, checkScripts: [] });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('.macf/plugin/');
        expect(r.stdout).toContain('macf-agent.json');
        expect(r.stdout).toContain('check-*.sh');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('linked-worktree no-op (groundnuty/macf#1114) — a worktree-spawned worker legitimately lacks `.macf/plugin` + `macf-agent.json` (gitignored, workspace-local); discriminator reused verbatim from groundnuty/macf#1042/#1113, fail-open direction INVERTED (alarm on ambiguity, not inject)', () => {
    // DECISIVE PAIR (assert-the-wrong-path.md): a worker workspace producing
    // empty stdout could mean "the new guard correctly suppressed" OR "the
    // hook is broken outright" — indistinguishable from the worker assertion
    // alone (a broken hook would satisfy (1) trivially and would be STRICTLY
    // WORSE than the false alarm being fixed, since it would silently disable
    // sweep-damage detection fleet-wide). The primary-checkout test below
    // rules that out: same damaged-surface fixture, only the `.git` shape
    // differs, and it STILL alarms — proving the detection pipeline isn't
    // globally broken and the empty result in the worker case is specifically
    // this guard, not a crash.
    it('(1) WORKER (`.git` is a `gitdir:` pointer file) + legitimately-absent surface (the real worktree shape — `.macf/plugin` + `macf-agent.json` gitignored/workspace-local) → does NOT alarm', () => {
      const ws = buildWorkspace({ gitDotShape: 'worktree', pluginDir: false, agentConfig: false });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('(2) PRIMARY checkout (`.git` is a real directory) + the SAME genuinely-damaged surface → still alarms (decisive pair\'s other half — sweep-damage detection is not weakened)', () => {
      const ws = buildWorkspace({ gitDotShape: 'primary', pluginDir: false, agentConfig: false });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('MACF FRAMEWORK SURFACE IS DAMAGED');
        expect(r.stdout).toContain('.macf/plugin/');
        expect(r.stdout).toContain('macf-agent.json');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('indeterminate: `.git` is a file but NOT a `gitdir:` pointer (malformed/unexpected shape) → falls through unchanged, still alarms on a genuinely-damaged surface (fail-open toward alarming, not skip)', () => {
      const ws = buildWorkspace({ gitDotShape: 'malformed', pluginDir: false, agentConfig: false });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('MACF FRAMEWORK SURFACE IS DAMAGED');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('indeterminate: `.git` absent entirely (documented default every pre-#1114 test in this file uses) → falls through unchanged, still alarms on a genuinely-damaged surface', () => {
      const ws = buildWorkspace({ pluginDir: false, agentConfig: false });
      // gitDotShape omitted — no .git at all.
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('MACF FRAMEWORK SURFACE IS DAMAGED');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('WORKER shape + a healthy-looking surface → also stays silent (no evaluation at all, not merely no missing entries)', () => {
      const ws = buildWorkspace({ gitDotShape: 'worktree' });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('WORKER shape suppresses ALL sub-checks uniformly, not just the headline verdict — check-*.sh absence (Check C) also produces no UNGUARDED warning', () => {
      // Guards against a fix that only gates the top-level MISSING-array
      // verdict while leaving an individual sub-check's false signal intact.
      const ws = buildWorkspace({ gitDotShape: 'worktree', pluginDir: false, agentConfig: false, checkScripts: [] });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.stdout).not.toContain('UNGUARDED');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('override', () => {
    it('MACF_SKIP_FRAMEWORK_CHECK=1 silences even a fully damaged workspace', () => {
      const ws = buildWorkspace({ pluginDir: false, agentConfig: false, checkScripts: [] });
      try {
        const r = runHook({ workspace: ws, env: { MACF_SKIP_FRAMEWORK_CHECK: '1' } });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('always exits 0 (observational, never blocking)', () => {
    it('exits 0 even with no CLAUDE_PROJECT_DIR and no PWD fallback available', () => {
      const res = spawnSync('bash', [HOOK_SCRIPT], {
        input: '{}',
        env: { PATH: process.env['PATH'] ?? '' },
        cwd: '/',
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0);
    });

    it('exits 0 on malformed (non-JSON) stdin against a damaged managed workspace — the hook never parses stdin, so garbage input must not change the verdict', () => {
      const ws = buildWorkspace({ pluginDir: false, agentConfig: false });
      try {
        const res = spawnSync('bash', [HOOK_SCRIPT], {
          input: 'not json at all {{{',
          env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: ws },
          encoding: 'utf-8',
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('MACF FRAMEWORK SURFACE IS DAMAGED');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
