/**
 * Tests for `first-launch-guidance.ts` (groundnuty/macf#994) — the shared
 * helper `commands/fleet-deploy.ts::nextStepLines` and
 * `commands/bootstrap-apply.ts::launchNextStepLines` both consume for the
 * post-deploy "you'll need to answer these prompts by hand" block. Those two
 * command-level test files (`test/cli/fleet-deploy.test.ts`,
 * `test/cli/bootstrap-apply.test.ts`) cover the END-TO-END render through
 * each CLI surface; this file covers the shared helper directly, pure and
 * offline (real fs via scratch dirs, no CLI plumbing).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_REFUSE_SUBSTRINGS } from '@groundnuty/macf-core';
import {
  firstLaunchSessionName,
  firstLaunchGuidanceHeaderLines,
  firstLaunchAttachLine,
  DEV_CHANNELS_WATCH_WINDOW_SECS,
} from '../../../src/cli/bootstrap/first-launch-guidance.js';
import { writeAgentConfig, agentConfigPath } from '../../../src/cli/config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'macf-first-launch-guidance-test-'));
  dirs.push(d);
  return d;
}

describe('firstLaunchSessionName', () => {
  it('falls back to the passed role when no macf-agent.json exists at destDir', () => {
    const destDir = scratchDir();
    expect(firstLaunchSessionName('demo-fleet', destDir, 'code-agent')).toBe('demo-fleet@code-agent');
  });

  it('reads routing_label from the REAL on-disk config when present, even though it equals role/agent_name in this fixture', () => {
    const destDir = scratchDir();
    writeAgentConfig(destDir, {
      project: 'demo-fleet',
      agent_name: 'code-agent',
      agent_role: 'code-agent',
      routing_label: 'code-agent',
      agent_type: 'permanent',
      registry: { type: 'profile', user: 'groundnuty' },
    });
    expect(firstLaunchSessionName('demo-fleet', destDir, 'code-agent')).toBe('demo-fleet@code-agent');
  });

  it('DECISIVE: uses routing_label, NEVER agent_name AND NEVER the manifest role, when all three diverge (the macf#678 science-agent shape)', () => {
    const destDir = scratchDir();
    // All THREE candidate values differ — `role` (the manifest-declared,
    // caller-passed fallback), `agent_name` (the OTEL/attribution identity),
    // and `routing_label` (the correct answer). A fixture where any two of
    // these coincide would pass even with a WRONG field read (e.g.
    // `const label = role` ignoring config entirely, or reading
    // `agent_name` instead of `routing_label`) — this is the fixture that
    // only the correct precedence (`routing_label ?? agent_name ?? role`,
    // reading the REAL on-disk config) can pass.
    writeAgentConfig(destDir, {
      project: 'demo-fleet',
      agent_name: 'macf-science-agent',
      agent_role: 'science-agent',
      routing_label: 'totally-different-routing-label',
      agent_type: 'permanent',
      registry: { type: 'profile', user: 'groundnuty' },
    });
    const session = firstLaunchSessionName('demo-fleet', destDir, 'manifest-declared-role');
    expect(session).toBe('demo-fleet@totally-different-routing-label');
    expect(session).not.toBe('demo-fleet@macf-science-agent');
    expect(session).not.toBe('demo-fleet@manifest-declared-role');
  });

  it('falls back to agent_name when routing_label is unset (the code/devops/auditor shape, name == routing_label by omission)', () => {
    const destDir = scratchDir();
    writeAgentConfig(destDir, {
      project: 'demo-fleet',
      agent_name: 'macf-devops-agent',
      agent_role: 'devops-agent',
      // routing_label deliberately omitted.
      agent_type: 'permanent',
      registry: { type: 'profile', user: 'groundnuty' },
    });
    expect(firstLaunchSessionName('demo-fleet', destDir, 'devops-agent')).toBe('demo-fleet@macf-devops-agent');
  });

  it('macf#994 "must never crash the completion render": malformed JSON at macf-agent.json falls back to role, does NOT throw', () => {
    const destDir = scratchDir();
    mkdirSync(join(destDir, '.macf'), { recursive: true });
    writeFileSync(agentConfigPath(destDir), '{ not valid json');
    expect(() => firstLaunchSessionName('demo-fleet', destDir, 'code-agent')).not.toThrow();
    expect(firstLaunchSessionName('demo-fleet', destDir, 'code-agent')).toBe('demo-fleet@code-agent');
  });

  it('macf#994 "must never crash the completion render": a non-object JSON value at macf-agent.json falls back to role, does NOT throw', () => {
    const destDir = scratchDir();
    mkdirSync(join(destDir, '.macf'), { recursive: true });
    writeFileSync(agentConfigPath(destDir), '"just a string"');
    expect(() => firstLaunchSessionName('demo-fleet', destDir, 'code-agent')).not.toThrow();
    expect(firstLaunchSessionName('demo-fleet', destDir, 'code-agent')).toBe('demo-fleet@code-agent');
  });
});

describe('firstLaunchGuidanceHeaderLines + firstLaunchAttachLine', () => {
  it('the header names the trust dialog verbatim and words the channels confirmation conditionally, without prescribing a specific keystroke', () => {
    const header = firstLaunchGuidanceHeaderLines().join('\n');
    expect(header).toContain('Do you trust this folder?');
    // Conditional wording (macf#994: "word it conditionally rather than
    // asserting it always appears") — never a bare unconditional claim that
    // the channels prompt WILL show up.
    expect(header).toContain('Loading development channels');
    expect(header).toContain('may ALSO need a manual answer');
    expect(header).toContain(`~${String(DEV_CHANNELS_WATCH_WINDOW_SECS)}s`);
    // Describes the ANSWER conditionally too (a menu-option choice), not a
    // specific keystroke that may not match every Claude Code build's
    // rendering of the prompt.
    expect(header).toContain('select the local-development option');
    expect(header).not.toMatch(/press\s*1/i);
  });

  it('the header never claims the workspace is auto-trusted, or that this module answers either prompt', () => {
    const header = firstLaunchGuidanceHeaderLines().join('\n');
    expect(header).toContain('deliberately refuses to answer');
    expect(header).not.toMatch(/auto-?trust/i);
  });

  it('the attach line is the ONLY agent-specific piece — the exact tmux attach command, nothing else', () => {
    const destDir = scratchDir();
    const line = firstLaunchAttachLine('demo-fleet', destDir, 'code-agent');
    expect(line.trim()).toBe('tmux attach -t demo-fleet@code-agent');
  });
});

describe('macf#994 hard constraint — the prompt-watcher never gets the trust prompt on its allowlist', () => {
  it('"trust" remains a HARD-REFUSE substring in the shared allowlist matcher (@groundnuty/macf-core) — unchanged by this issue', () => {
    // This module (first-launch-guidance.ts) NAMES the trust prompt for a
    // human; it must never gain the power to ANSWER it. The structural
    // guarantee lives one layer down, in the allowlist matcher itself
    // (macf-prompt-watcher.sh's bash mirror + this TS source of truth) —
    // pinned here so a future edit to either can't silently loosen it
    // without this test (and macf-core's own `prompt-responses.test.ts`,
    // which this intentionally duplicates the pin of) failing.
    expect(PROMPT_REFUSE_SUBSTRINGS).toContain('trust');
  });
});
