/**
 * Tests for `plugin/scripts/emit-agent-identity.sh` — the SessionStart hook
 * (groundnuty/macf#664) that surfaces THIS agent's own identity into context
 * on EVERY session start, including a `claude -c` RESUME — closing the gap
 * where a resumed session never had a fresh-start trigger to look its own
 * identity up at all.
 *
 * Hook contract (SessionStart): JSON on stdin (drained, unused — this hook
 * is deliberately matcher-less and does not discriminate by `source`).
 * STDOUT is injected into the agent's context on exit 0. NEVER blocks the
 * session. Override: MACF_SKIP_IDENTITY_CHECK=1.
 *
 * BINDING correction (per the #664 comment, live during the ppam-2026
 * promotion): `macf-whoami.sh` reports TOKEN attribution (bot vs user), not
 * agent identity — this hook must never invoke it. See the "does NOT invoke
 * macf-whoami.sh" describe block below (groundnuty/macf#1321's
 * assert-the-not-called pattern).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'emit-agent-identity.sh');

interface AgentJsonSpec {
  readonly project?: string;
  readonly agent_name?: string;
  readonly agent_role?: string;
  readonly routing_label?: string;
  readonly bot_login?: string;
  /** When true, write raw non-JSON garbage instead of a structured object. */
  readonly garbage?: boolean;
  /** When true, omit the file entirely. */
  readonly absent?: boolean;
}

function buildWorkspace(opts: {
  readonly dirPrefix?: string;
  readonly agentJson?: AgentJsonSpec;
}): string {
  const workspace = mkdtempSync(join(tmpdir(), opts.dirPrefix ?? 'macf-emit-identity-ws-'));
  const spec = opts.agentJson;
  if (spec && !spec.absent) {
    const macfDir = join(workspace, '.macf');
    mkdirSync(macfDir, { recursive: true });
    if (spec.garbage) {
      writeFileSync(join(macfDir, 'macf-agent.json'), 'not { valid json at all');
    } else {
      // Always 2-space pretty-printed, matching config.ts::writeAgentConfig —
      // the shape the hook's line-based extraction depends on.
      const obj: Record<string, unknown> = {};
      if (spec.project !== undefined) obj['project'] = spec.project;
      if (spec.agent_name !== undefined) obj['agent_name'] = spec.agent_name;
      if (spec.agent_role !== undefined) obj['agent_role'] = spec.agent_role;
      if (spec.routing_label !== undefined) obj['routing_label'] = spec.routing_label;
      obj['agent_type'] = 'permanent';
      obj['registry'] = { type: 'profile', user: 'groundnuty' };
      if (spec.bot_login !== undefined) {
        obj['github_app'] = { app_id: '1', install_id: '2', key_path: 'x.pem', bot_login: spec.bot_login };
      }
      writeFileSync(join(macfDir, 'macf-agent.json'), JSON.stringify(obj, null, 2) + '\n');
    }
  }
  return workspace;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Whether the PATH-stubbed macf-whoami.sh was invoked (groundnuty/macf#1321 assert-not-called pattern). */
  readonly whoamiInvoked: boolean;
}

function runHook(opts: {
  readonly workspace: string;
  readonly source?: string | null;
  readonly env?: Record<string, string | undefined>;
}): RunResult {
  // Stub macf-whoami.sh on PATH ahead of any real one — if the hook ever
  // shells out to it (directly, or via a `.claude/scripts/`-relative call
  // that resolves through PATH), the marker file below proves it.
  const stubBin = join(opts.workspace, 'stub-bin');
  mkdirSync(stubBin, { recursive: true });
  const whoamiMarker = join(opts.workspace, 'whoami-invoked.marker');
  writeFileSync(
    join(stubBin, 'macf-whoami.sh'),
    ['#!/usr/bin/env bash', `touch ${JSON.stringify(whoamiMarker)}`, 'echo "bot installation token"', ''].join('\n'),
  );
  chmodSync(join(stubBin, 'macf-whoami.sh'), 0o755);

  const cleanEnv: Record<string, string> = {
    PATH: `${stubBin}:${process.env['PATH'] ?? ''}`,
    CLAUDE_PROJECT_DIR: opts.workspace,
  };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }

  const payload: Record<string, unknown> = { session_id: 'sess-x' };
  if (opts.source !== null) payload['source'] = opts.source ?? 'resume';

  const res = spawnSync('bash', [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    env: cleanEnv,
    encoding: 'utf-8',
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    whoamiInvoked: existsSync(whoamiMarker),
  };
}

describe('emit-agent-identity.sh (hook)', () => {
  describe('decisive pair (1): a workspace WITH a readable macf-agent.json', () => {
    it('surfaces identity with the agent\'s OWN name/role/routing-label — on a RESUMED session, not just a fresh startup', () => {
      const ws = buildWorkspace({
        agentJson: {
          project: 'icsoc-2026',
          agent_name: 'icsoc-2026-science-agent',
          agent_role: 'science-agent',
          routing_label: 'science-agent',
          bot_login: 'icsoc-2026-science-agent[bot]',
        },
      });
      try {
        // source: 'resume' — the exact case #664 reports as broken pre-fix.
        const r = runHook({ workspace: ws, source: 'resume' });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('icsoc-2026-science-agent');
        expect(r.stdout).toContain('science-agent');
        expect(r.stdout).toContain('icsoc-2026');
        expect(r.stdout).toContain('icsoc-2026-science-agent[bot]');
        expect(r.stdout).toContain('groundnuty/macf#664');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('the emitted identity matches macf-agent.json\'s fields, not the workspace directory name', () => {
      // Directory name deliberately unrelated to the agent identity — proves
      // the hook reads the FILE, not the path it lives under.
      const ws = buildWorkspace({
        dirPrefix: 'totally-unrelated-dirname-',
        agentJson: {
          project: 'macf',
          agent_name: 'code-agent',
          agent_role: 'code-agent',
        },
      });
      try {
        const r = runHook({ workspace: ws, source: 'resume' });
        expect(r.stdout).toContain('code-agent');
        expect(r.stdout).not.toContain('totally-unrelated-dirname');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('fires identically across startup / resume / clear / compact / fork — deliberately matcher-less, unlike macf-startup-pickup.sh', () => {
      for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
        const ws = buildWorkspace({
          agentJson: { project: 'macf', agent_name: 'code-agent', agent_role: 'code-agent' },
        });
        try {
          const r = runHook({ workspace: ws, source });
          expect(r.stdout, `source=${source}`).toContain('code-agent');
        } finally {
          rmSync(ws, { recursive: true, force: true });
        }
      }
    });

    it('defaults the routing label to agent_name when routing_label is absent from the JSON (optional field) — regression guard: an absent OPTIONAL field must not silently blank the WHOLE output', () => {
      // groundnuty/macf#664 implementation note: a naive `grep | sed` field
      // extractor under `set -o pipefail` + a blanket `trap ERR: exit 0`
      // treats a no-match grep on this OPTIONAL field as a script fault and
      // short-circuits the entire hook (no identity, no honest-unknown
      // message either) — caught live while implementing this fix. This
      // fixture is the regression test for that specific failure mode.
      const ws = buildWorkspace({
        agentJson: { project: 'macf', agent_name: 'code-agent', agent_role: 'code-agent' },
      });
      try {
        const r = runHook({ workspace: ws, source: 'resume' });
        expect(r.stdout).not.toBe('');
        expect(r.stdout).toContain('code-agent');
        expect(r.stdout).toContain('Routing label: code-agent.');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('omits the GitHub bot identity line when github_app.bot_login is absent (optional field)', () => {
      const ws = buildWorkspace({
        agentJson: { project: 'macf', agent_name: 'code-agent', agent_role: 'code-agent' },
      });
      try {
        const r = runHook({ workspace: ws, source: 'resume' });
        expect(r.stdout).not.toContain('GitHub bot identity');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('a required field missing from the file (agent_role absent) does NOT emit a partial identity — falls through to the honest-unknown floor when no env is present either', () => {
      const ws = buildWorkspace({
        agentJson: { project: 'macf', agent_name: 'code-agent' /* agent_role omitted */ },
      });
      try {
        const r = runHook({
          workspace: ws,
          source: 'resume',
          env: { MACF_PROJECT: undefined, MACF_AGENT_NAME: undefined, MACF_AGENT_ROLE: undefined, MACF_ROUTING_LABEL: undefined },
        });
        expect(r.stdout).not.toContain('You are the MACF agent');
        expect(r.stdout.toLowerCase()).toContain('could not be determined');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('malformed (non-JSON) macf-agent.json does not crash the hook and does not fabricate an identity', () => {
      const ws = buildWorkspace({ agentJson: { garbage: true } });
      try {
        const r = runHook({
          workspace: ws,
          source: 'resume',
          env: { MACF_PROJECT: undefined, MACF_AGENT_NAME: undefined, MACF_AGENT_ROLE: undefined, MACF_ROUTING_LABEL: undefined },
        });
        expect(r.status).toBe(0);
        expect(r.stdout.toLowerCase()).toContain('could not be determined');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('the MACF_* environment as the second authoritative source (a linked-worktree worker: no macf-agent.json, but env IS present)', () => {
    it('surfaces identity from MACF_PROJECT / MACF_AGENT_NAME / MACF_AGENT_ROLE / MACF_ROUTING_LABEL when no macf-agent.json exists', () => {
      const ws = buildWorkspace({ agentJson: { absent: true } });
      try {
        const r = runHook({
          workspace: ws,
          source: 'resume',
          env: {
            MACF_PROJECT: 'macf',
            MACF_AGENT_NAME: 'code-agent',
            MACF_AGENT_ROLE: 'code-agent',
            MACF_ROUTING_LABEL: 'code-agent',
          },
        });
        expect(r.stdout).toContain('code-agent');
        expect(r.stdout).toContain('macf');
        expect(r.stdout).toContain('the MACF_* environment');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('macf-agent.json takes priority over env when BOTH are present and disagree', () => {
      const ws = buildWorkspace({
        agentJson: { project: 'from-file', agent_name: 'file-agent', agent_role: 'file-role' },
      });
      try {
        const r = runHook({
          workspace: ws,
          source: 'resume',
          env: { MACF_PROJECT: 'from-env', MACF_AGENT_NAME: 'env-agent', MACF_AGENT_ROLE: 'env-role' },
        });
        expect(r.stdout).toContain('file-agent');
        expect(r.stdout).not.toContain('env-agent');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('decisive pair (2): a workspace WITHOUT a readable macf-agent.json and WITHOUT identity env — honest-unknown', () => {
    it('says it does not know, and names no guessed identity', () => {
      const ws = buildWorkspace({ dirPrefix: 'code-agent-lookalike-dirname-', agentJson: { absent: true } });
      try {
        const r = runHook({
          workspace: ws,
          source: 'resume',
          env: { MACF_PROJECT: undefined, MACF_AGENT_NAME: undefined, MACF_AGENT_ROLE: undefined, MACF_ROUTING_LABEL: undefined },
        });
        expect(r.status).toBe(0);
        expect(r.stdout.toLowerCase()).toContain('could not be determined');
        expect(r.stdout.toLowerCase()).toContain('does not know');
        // No fabricated identity: neither a plausible agent name nor the
        // (deliberately identity-shaped) directory-name substring appears.
        expect(r.stdout).not.toContain('You are the MACF agent');
        expect(r.stdout).not.toContain('code-agent-lookalike-dirname');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('does NOT invoke macf-whoami.sh for identity (groundnuty/macf#1321 assert-not-called pattern) — binding per the #664 correction: whoami reports token attribution, not agent identity', () => {
    it('never shells out to macf-whoami.sh in the success path', () => {
      const ws = buildWorkspace({
        agentJson: { project: 'macf', agent_name: 'code-agent', agent_role: 'code-agent' },
      });
      try {
        const r = runHook({ workspace: ws, source: 'resume' });
        expect(r.whoamiInvoked).toBe(false);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });

    it('never shells out to macf-whoami.sh in the honest-unknown path either', () => {
      const ws = buildWorkspace({ agentJson: { absent: true } });
      try {
        const r = runHook({
          workspace: ws,
          source: 'resume',
          env: { MACF_PROJECT: undefined, MACF_AGENT_NAME: undefined, MACF_AGENT_ROLE: undefined, MACF_ROUTING_LABEL: undefined },
        });
        expect(r.whoamiInvoked).toBe(false);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('override', () => {
    it('MACF_SKIP_IDENTITY_CHECK=1 silences even a fully-resolvable identity', () => {
      const ws = buildWorkspace({
        agentJson: { project: 'macf', agent_name: 'code-agent', agent_role: 'code-agent' },
      });
      try {
        const r = runHook({ workspace: ws, source: 'resume', env: { MACF_SKIP_IDENTITY_CHECK: '1' } });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('always exits 0 (observational, never blocking)', () => {
    it('exits 0 with no CLAUDE_PROJECT_DIR and no PWD fallback available', () => {
      const stubBin = mkdtempSync(join(tmpdir(), 'macf-emit-identity-nostub-'));
      const res = spawnSync('bash', [HOOK_SCRIPT], {
        input: '{}',
        env: { PATH: process.env['PATH'] ?? '' },
        cwd: '/',
        encoding: 'utf-8',
      });
      rmSync(stubBin, { recursive: true, force: true });
      expect(res.status).toBe(0);
    });

    it('exits 0 on malformed (non-JSON) stdin — the hook never parses stdin, so garbage input must not change the verdict', () => {
      const ws = buildWorkspace({
        agentJson: { project: 'macf', agent_name: 'code-agent', agent_role: 'code-agent' },
      });
      try {
        const res = spawnSync('bash', [HOOK_SCRIPT], {
          input: 'not json at all {{{',
          env: { PATH: process.env['PATH'] ?? '', CLAUDE_PROJECT_DIR: ws },
          encoding: 'utf-8',
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('code-agent');
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
