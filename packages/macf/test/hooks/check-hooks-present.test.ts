/**
 * Tests for `plugin/scripts/check-hooks-present.sh` — the SessionStart guard
 * that asserts (A) the token-minting helper scripts (`macf-gh-token.sh` +
 * `macf-whoami.sh`) the guards + `claude.sh` depend on but never register as
 * hooks themselves, and (B) every workspace-hosted PreToolUse hook script
 * THIS workspace's own `.claude/settings.json` (+ `settings.local.json`)
 * registers, are present on disk and executable — and warns LOUDLY into the
 * agent's context when any is not. groundnuty/macf#1401.
 *
 * Part B is the finer-grained companion to check-framework-surface.sh's
 * Check C (which only asserts "at least one check-*.sh exists", so it stays
 * silent on a partial loss — the exact shape the #1395 transition incident
 * produced: 8 of 17 files survived a pull that untracked them, and the
 * SPECIFIC script a live PreToolUse hook pointed at was among the missing
 * 9). Part A closes a gap Part B alone cannot see: `macf-gh-token.sh` is
 * invoked BY the guards + by `claude.sh`, never wired into a hook entry
 * itself — a workspace can have every registered guard script present
 * (Part B all-clear) while the token minter is the one file missing, which
 * leaves every guard installed and every `gh` call blocked.
 *
 * Hook contract (SessionStart): JSON on stdin; STDOUT is injected into the
 * agent's context. OBSERVATIONAL + NON-BLOCKING — the script ALWAYS exits 0
 * (fail open on missing jq — Part B only, Part A needs no dependency — an
 * unreadable/malformed settings file, or any internal error). Override:
 * MACF_SKIP_GUARD_PRESENCE_CHECK=1.
 *
 * Managed-workspace guard: both parts are skipped entirely, silently, for a
 * workspace with neither `.macf/` nor `.claude/settings.json` present (same
 * predicate check-framework-surface.sh uses) — otherwise Part A would
 * false-alarm "token minter missing" on any ordinary non-macf project.
 *
 * Part B scope: only `PreToolUse` `command` entries whose value references
 * the literal `$CLAUDE_PROJECT_DIR/.claude/scripts/<name>` (or braced
 * `${CLAUDE_PROJECT_DIR}/...`) form are evaluated. Hardcoded absolute paths
 * and `${CLAUDE_PLUGIN_ROOT}/...`-hosted hooks (the ones that do NOT vanish
 * on a workspace-local git operation) are out of scope and skipped silently
 * — they are not false passes, they are simply not this hook's business.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-hooks-present.sh');

// Resolved ONCE, absolute — so a test that deliberately sets a jq-less PATH
// (to exercise Part A's dependency-free fail-open path for Part B) doesn't
// ALSO make `spawnSync`'s own executable lookup for `bash` fail: Node
// resolves a bare command name via the CHILD env's PATH, the same PATH the
// script's internal `command -v jq` would consult — so overriding PATH for
// the latter purpose would silently break the former unless bash is
// invoked by absolute path instead.
const BASH_PATH = execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf-8' }).trim();

/**
 * A PATH dir carrying ONLY `cat` (real coreutils, symlinked) — no jq. The
 * hook's final warning is emitted via `cat <<WARN ... WARN`, same
 * convention every sibling hook (check-framework-surface.sh,
 * check-channel-alive.sh) uses, so `cat` genuinely is a hard runtime
 * dependency for producing OUTPUT even where the DETECTION logic (Part A's
 * `[ -e ]`/`[ -x ]` file tests) needs nothing external. A PATH that lacks
 * `cat` entirely (e.g. a bare "/nonexistent-dir") is not a realistic
 * "jq is missing" host — real hosts always carry coreutils — so this
 * fixture simulates the actually-relevant case: jq absent, everything else
 * present.
 */
function catOnlyPathDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-hookspresent-catonly-'));
  const catPath = execFileSync('/bin/sh', ['-c', 'command -v cat'], { encoding: 'utf-8' }).trim();
  symlinkSync(catPath, join(dir, 'cat'));
  return dir;
}

interface HookSpec {
  /** Basename registered in the PreToolUse command, e.g. "check-gh-token.sh". */
  readonly name: string;
  /** Registration form. Default 'project-dir' (the in-scope form). */
  readonly form?: 'project-dir' | 'project-dir-braced' | 'absolute' | 'plugin-root' | 'mcp-tool';
}

interface WorkspaceSpec {
  /** Hooks to register in .claude/settings.json's PreToolUse block. */
  readonly registered?: readonly HookSpec[];
  /** Same, but registered in .claude/settings.local.json instead. */
  readonly registeredLocal?: readonly HookSpec[];
  /** Script basenames (hook scripts AND/OR the two helper names) to actually create (present + executable) under .claude/scripts/. */
  readonly present?: readonly string[];
  /** Script basenames to create but WITHOUT the executable bit. */
  readonly presentNotExecutable?: readonly string[];
  /** Skip writing .claude/settings.json entirely. */
  readonly noSettingsJson?: boolean;
  /** Write a deliberately malformed (non-JSON) settings.json. */
  readonly malformedSettingsJson?: boolean;
  /** Create an empty `.macf/` directory — the OTHER managed-workspace signal, independent of settings.json. */
  readonly macfDir?: boolean;
}

function hookCommand(spec: HookSpec): { type: string; command?: string; server?: string; tool?: string } {
  const name = spec.name;
  switch (spec.form ?? 'project-dir') {
    case 'project-dir':
      return { type: 'command', command: `$CLAUDE_PROJECT_DIR/.claude/scripts/${name}` };
    case 'project-dir-braced':
      return { type: 'command', command: `\${CLAUDE_PROJECT_DIR}/.claude/scripts/${name}` };
    case 'absolute':
      return { type: 'command', command: `/some/other/absolute/path/.claude/scripts/${name}` };
    case 'plugin-root':
      return { type: 'command', command: `"\${CLAUDE_PLUGIN_ROOT}/scripts/${name}"` };
    case 'mcp-tool':
      return { type: 'mcp_tool', server: 'macf-agent', tool: name };
  }
}

function settingsJsonContent(hooks: readonly HookSpec[]): string {
  return JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: hooks.map(hookCommand),
          },
        ],
      },
    },
    null,
    2
  );
}

function buildWorkspace(spec: WorkspaceSpec): string {
  const {
    registered = [],
    registeredLocal = [],
    present = [],
    presentNotExecutable = [],
    noSettingsJson = false,
    malformedSettingsJson = false,
    macfDir = false,
  } = spec;

  const workspace = mkdtempSync(join(tmpdir(), 'macf-hookspresent-ws-'));
  mkdirSync(join(workspace, '.claude', 'scripts'), { recursive: true });

  if (macfDir) {
    mkdirSync(join(workspace, '.macf'), { recursive: true });
  }

  if (malformedSettingsJson) {
    writeFileSync(join(workspace, '.claude', 'settings.json'), '{ this is not valid json\n');
  } else if (!noSettingsJson) {
    writeFileSync(join(workspace, '.claude', 'settings.json'), settingsJsonContent(registered));
  }

  if (registeredLocal.length > 0) {
    writeFileSync(join(workspace, '.claude', 'settings.local.json'), settingsJsonContent(registeredLocal));
  }

  for (const name of present) {
    const p = join(workspace, '.claude', 'scripts', name);
    writeFileSync(p, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(p, 0o755);
  }
  for (const name of presentNotExecutable) {
    const p = join(workspace, '.claude', 'scripts', name);
    writeFileSync(p, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(p, 0o644);
  }

  return workspace;
}

/** The two Part-A helper names, present + executable — the "everything else is fine" baseline most Part-B-focused tests want. */
const BOTH_MINTERS = ['macf-gh-token.sh', 'macf-whoami.sh'];

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runHook(opts: { readonly workspace: string; readonly env?: Record<string, string | undefined> }): RunResult {
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
  const res = spawnSync(BASH_PATH, [HOOK_SCRIPT], {
    input: JSON.stringify({ session_id: 'sess-x', source: 'startup' }),
    env: cleanEnv,
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('check-hooks-present.sh (hook)', () => {
  describe('Part B decisive pair — registered hook scripts', () => {
    it('warns, naming the script, when a registered hook script is absent', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh' }],
        present: [...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('check-gh-token.sh');
        expect(r.stdout).toContain('groundnuty/macf#1401');
        expect(r.stdout).toContain('not found on disk');
        expect(r.stdout).toContain('macf rules refresh --dir .');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('stays completely silent when the registered hook script AND both minters are present + executable', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh' }],
        present: ['check-gh-token.sh', ...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('Part A decisive pair — the token-minting helpers', () => {
    it('warns, naming macf-gh-token.sh and citing the blocked-gh consequence, when it is absent', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh' }],
        present: ['check-gh-token.sh', 'macf-whoami.sh'],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('macf-gh-token.sh');
        expect(r.stdout).toContain('TOKEN MINTER missing');
        expect(r.stdout).toContain('every gh call will be blocked');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('warns, naming macf-whoami.sh, when it is absent', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh' }],
        present: ['check-gh-token.sh', 'macf-gh-token.sh'],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('macf-whoami.sh');
        expect(r.stdout).toContain('token-attribution sanity-check helper missing');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('warns when macf-gh-token.sh is present but NOT executable', () => {
      const ws = buildWorkspace({
        registered: [],
        present: ['macf-whoami.sh'],
        presentNotExecutable: ['macf-gh-token.sh'],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('macf-gh-token.sh');
        expect(r.stdout).toContain('present but NOT executable');
        expect(r.stdout).toContain('TOKEN MINTER missing');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('flags the missing token minter even with ZERO registered PreToolUse hooks at all (settings.json present, empty hooks)', () => {
      // This is the scenario the coordinator's finding named directly: a
      // workspace where the guard-registration scan (Part B) has nothing to
      // walk, or has already all-cleared, but macf-gh-token.sh itself never
      // made it back onto disk — every guard "present", every gh call
      // blocked.
      const ws = buildWorkspace({
        registered: [],
        present: [],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('macf-gh-token.sh');
        expect(r.stdout).toContain('macf-whoami.sh');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('managed via .macf/ alone (no settings.json) still checks + flags the missing minter', () => {
      const ws = buildWorkspace({
        noSettingsJson: true,
        macfDir: true,
        present: [],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('macf-gh-token.sh');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('additional required scenarios', () => {
    it('warns when a registered hook script is present but NOT executable', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-mention-routing.sh' }],
        present: [...BOTH_MINTERS],
        presentNotExecutable: ['check-mention-routing.sh'],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('check-mention-routing.sh');
        expect(r.stdout).toContain('NOT executable');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('stays silent on malformed (non-JSON) settings.json — fails open (Part B), Part A still runs on the managed-gate evidence but both minters are present here', () => {
      const ws = buildWorkspace({ malformedSettingsJson: true, present: [...BOTH_MINTERS] });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('stays silent when MACF_SKIP_GUARD_PRESENCE_CHECK=1 is set, even with real gaps in both parts', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh' }],
        present: [],
      });
      try {
        const r = runHook({ workspace: ws, env: { MACF_SKIP_GUARD_PRESENCE_CHECK: '1' } });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('partial loss — the case check-framework-surface.sh Check C misses', () => {
    it('warns even when OTHER check-*.sh files remain on disk (partial loss, not total)', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh' }, { name: 'check-mention-routing.sh' }],
        // check-mention-routing.sh survives; check-gh-token.sh (the one a
        // live PreToolUse hook is actually wired to) does not. A glob-any-
        // match check ("does .claude/scripts/check-*.sh match anything?")
        // would stay silent here — this hook must not.
        present: ['check-mention-routing.sh', ...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('check-gh-token.sh');
        expect(r.stdout).not.toContain('check-mention-routing.sh  (not found');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('lists every missing script when more than one is gone', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh' }, { name: 'check-lgtm-gate.sh' }, { name: 'check-close-keyword.sh' }],
        present: ['check-close-keyword.sh', ...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('check-gh-token.sh');
        expect(r.stdout).toContain('check-lgtm-gate.sh');
        expect(r.stdout).not.toContain('check-close-keyword.sh  (not found');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('out-of-scope registration forms — skipped silently (Part B)', () => {
    it('does not flag a hook registered by hardcoded absolute path', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'some-custom-hook.sh', form: 'absolute' }],
        present: [...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('does not flag a plugin-hosted hook registered via ${CLAUDE_PLUGIN_ROOT}', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-git-sweep.sh', form: 'plugin-root' }],
        present: [...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('does not flag an mcp_tool-kind hook entry (no command field at all)', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'notify_peer', form: 'mcp-tool' }],
        present: [...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('recognizes the braced ${CLAUDE_PROJECT_DIR} form as in-scope', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh', form: 'project-dir-braced' }],
        present: [...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('check-gh-token.sh');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('settings.local.json contributes to the merged hook set (Part B)', () => {
    it('flags a hook registered only in settings.local.json', () => {
      const ws = buildWorkspace({
        registered: [],
        registeredLocal: [{ name: 'check-lgtm-gate.sh' }],
        present: [...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('check-lgtm-gate.sh');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('de-dups a hook registered in BOTH settings.json and settings.local.json into one warning line', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh' }],
        registeredLocal: [{ name: 'check-gh-token.sh' }],
        present: [...BOTH_MINTERS],
      });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        const occurrences = r.stdout.split('check-gh-token.sh').length - 1;
        expect(occurrences).toBe(1);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('no hooks registered at all (Part B silent; Part A still applies)', () => {
    it('Part B silent, but Part A still flags missing minters, when .claude/settings.json has no PreToolUse hooks', () => {
      const ws = buildWorkspace({ registered: [], present: [] });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('macf-gh-token.sh');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('fully silent when .claude/settings.json has no PreToolUse hooks AND both minters are present', () => {
      const ws = buildWorkspace({ registered: [], present: [...BOTH_MINTERS] });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('non-managed workspace — both parts skipped, no false alarm', () => {
    it('stays silent when .claude/settings.json does not exist AND no .macf/ dir exists (bare, non-macf project)', () => {
      const ws = buildWorkspace({ noSettingsJson: true, macfDir: false, present: [] });
      try {
        const r = runHook({ workspace: ws });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('missing jq — Part B fails open, Part A is dependency-free and still runs', () => {
    it('Part A still flags the missing minter even when jq is not on PATH', () => {
      const ws = buildWorkspace({
        registered: [{ name: 'check-gh-token.sh' }],
        present: ['check-gh-token.sh'],
      });
      const pathDir = catOnlyPathDir();
      try {
        // A PATH carrying `cat` (needed for the hook's own output — see
        // catOnlyPathDir's doc comment) but NOT jq. Part A needs no
        // external binary at all for its DETECTION logic (pure bash
        // builtins: `case`, `[ -e ]`, `[ -x ]`, `printf`), so it must still
        // fire under this PATH.
        const r = runHook({ workspace: ws, env: { PATH: pathDir } });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('macf-whoami.sh');
        // And Part B — which DOES need jq — correctly stayed silent about
        // the registered-but-present check-gh-token.sh hook (no assertion
        // needed either way there since it's present; the point is Part A
        // alone produced output under a jq-less PATH).
      } finally {
        rmSync(ws, { recursive: true, force: true });
        rmSync(pathDir, { recursive: true, force: true });
      }
    });
  });
});
