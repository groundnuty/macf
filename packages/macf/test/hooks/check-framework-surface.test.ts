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
}

function buildWorkspace(spec: WorkspaceSpec): string {
  const {
    macfDir = true,
    pluginDir = true,
    pluginNonEmpty = true,
    agentConfig = true,
    settingsJson = true,
    checkScripts = ['check-gh-token.sh'],
  } = spec;

  const workspace = mkdtempSync(join(tmpdir(), 'macf-fwsurf-ws-'));

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
  });
});
