/**
 * SKILL.md presence + shape regression for `macf-notify-peer` (macf#350).
 *
 * The slash-command's runtime entry point is a SKILL.md file in
 * `packages/macf/plugin/skills/macf-notify-peer/`. Its frontmatter
 * binds the skill name (`macf-agent:macf-notify-peer`), the allowed-
 * tools surface (must include the `notify_peer` MCP tool), and the
 * argument hint exposed in autocomplete.
 *
 * If any of these drift, the skill silently fails at runtime: a wrong
 * `name` prevents Claude Code from registering it; missing the MCP-
 * tool entry in `allowed-tools` makes every invocation block on
 * interactive permission prompt; missing the `argument-hint` degrades
 * operator UX. None of these surfaces produce a unit-test failure
 * elsewhere — the test below pins them.
 *
 * Lockstep with `PLUGIN_SKILL_PERMISSIONS` in `settings-writer.ts`
 * (asserted in `cli/settings-writer.test.ts`); the two together
 * guarantee end-to-end pre-approval works.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillPath = join(repoRoot, 'plugin', 'skills', 'macf-notify-peer', 'SKILL.md');

describe('macf-notify-peer SKILL.md (macf#350)', () => {
  it('exists at packages/macf/plugin/skills/macf-notify-peer/SKILL.md', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  const content = readFileSync(skillPath, 'utf-8');

  it('has frontmatter with name=macf-notify-peer', () => {
    expect(content).toMatch(/^---\n(?:.*\n)*?name: macf-notify-peer\n(?:.*\n)*?---/);
  });

  it('declares the notify_peer MCP tool in allowed-tools', () => {
    // Required for the MCP tool invocation; without it, every call
    // would gate on interactive approval (sister to macf#349).
    expect(content).toMatch(/allowed-tools:.*mcp__macf-agent__notify_peer\b/);
  });

  it('names the same tool id that macf init pre-approves', () => {
    const writer = readFileSync(
      join(repoRoot, 'src', 'cli', 'settings-writer.ts'),
      'utf-8',
    );
    const allowed = /allowed-tools:\s*(\S+)/.exec(content)?.[1];
    expect(allowed).toBeDefined();
    expect(writer).toContain(`'${allowed}'`);
  });

  it('does not recommend a lifecycle event for a message', () => {
    expect(content).not.toMatch(/--event/);
    expect(content).not.toMatch(/use a non-`custom`/);
    expect(content).toMatch(/always `custom`.*only recorded, never seen/);
  });

  it('has an argument-hint covering peer + message', () => {
    // Operator UX: shows the expected positional shape in autocomplete.
    expect(content).toMatch(/argument-hint:.*<peer>.*<message>/);
  });

  it('directs the LLM to respond with one line by default (context-cost discipline)', () => {
    // Per macf#350 refined AC (science-agent comment 2026-05-04):
    // verbosity is a context-token concern, not aesthetics. The prompt
    // template MUST direct one-line response by default.
    expect(content).toMatch(/ONE LINE|one[-\s]line/i);
  });

  it('mentions the verbose opt-in flag for debug use', () => {
    expect(content).toMatch(/--verbose/);
  });

  // macf#355: source-level invariant — SKILL.md must NOT mention
  // `--no-wake` or pass a `wake` field. The receiver-side discriminator
  // keys off `event` alone (operator-driven `event: custom` wakes;
  // autonomous events skip wake / Pattern E). A re-introduction of the
  // wake flag would silently work against the architectural cleanup.
  it('does NOT mention --no-wake (macf#355 — receiver discriminates by event, not sender flag)', () => {
    expect(content).not.toMatch(/--no-wake/);
  });

  it('does NOT instruct passing `wake` field to notify_peer (macf#355)', () => {
    // The prompt template should call notify_peer with `to`, `event`,
    // `message` only — no `wake` field. Receiver decides from `event`.
    // Catches a future refactor that might re-introduce `wake: true`
    // as a "safer default" when in fact the architectural cleanup is
    // event-only discrimination.
    expect(content).not.toMatch(/\bwake:\s*(true|false)\b/);
  });
});
