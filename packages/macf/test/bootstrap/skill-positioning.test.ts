/**
 * Structural guard: the macf-bootstrap skill/README/recipe must not drift
 * back into describing the pre-DR-043 mechanism as the ACTIVE provisioning
 * path (groundnuty/macf#877).
 *
 * DR-043 (2026-08-11, operator-ratified) moved fleet provisioning from an
 * LLM driving the operator's Chrome via the Chrome DevTools MCP into a
 * deterministic CLI core (`macf bootstrap plan|apply`) reading a declarative
 * `fleet.yaml` manifest. The DR-035 skill was repositioned as an OPTIONAL
 * conversational front-end to that CLI, not retired. Three documents in
 * this repo describe the flow to an operator — `SKILL.md` (what an agent
 * following the skill does), `README.md` (how the workspace is used), and
 * the scientific-paper-fleet recipe's §2-bootstrap (what an operator
 * following the use-case is told to do) — and all three had drifted to
 * still present the superseded Chrome-driven mechanism as current, with no
 * tracking issue and no positioning note (#877's own finding).
 *
 * This is the same shape `silent-fallback-hazards-counts.test.ts` (#937)
 * pins for a different file: an unchecked claim about "what currently
 * happens" silently drifts from what the code actually does. Rather than
 * re-deriving the CLI's own behavior here (that's `apply-fleet.test.ts`'s
 * job), this test pins the CHEAP, MECHANICAL half of "the docs describe the
 * current mechanism, not the superseded one" — presence of the current
 * markers (fleet.yaml / macf bootstrap / DR-043) and absence of the
 * superseded markers (the skill actively driving `mcp__chrome-devtools__*`,
 * the "🤖 Recommended" + operator-dogfood-solicitation framing that steered
 * operators at the superseded path).
 *
 * Per `assert-the-wrong-path.md`: a test that only reads the current
 * (already-correct) prose and reports "matches" is unconvincing on its own.
 * Corrupting SKILL.md by re-inserting an `mcp__chrome-devtools__navigate_page`
 * tool reference, or the recipe by re-inserting the "🤖 **Recommended"
 * banner, is the decisive check — either corruption fails the corresponding
 * assertion below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const PKG_ROOT = findCliPackageRoot(); // packages/macf
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');

const SKILL_PATH = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'skills', 'macf-bootstrap', 'SKILL.md');
const README_PATH = join(REPO_ROOT, 'tools', 'macf-bootstrap', 'README.md');
const SAFETY_RULE_PATH = join(REPO_ROOT, 'tools', 'macf-bootstrap', '.claude', 'rules', 'macf-bootstrap-safety.md');
const RECIPE_PATH = join(REPO_ROOT, 'use-cases', 'scientific-paper-fleet.md');

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('macf-bootstrap SKILL.md — positioned as the DR-043 front-end, not the active driver', () => {
  const skill = read(SKILL_PATH);

  it('references fleet.yaml and macf bootstrap as the current mechanism', () => {
    expect(skill).toMatch(/fleet\.yaml/);
    expect(skill).toMatch(/macf bootstrap (plan|apply)/);
    expect(skill).toMatch(/DR-043/);
  });

  it('does NOT invoke any chrome-devtools MCP tool as part of the active procedure', () => {
    // The pre-DR-043 skill drove App creation/install via
    // mcp__chrome-devtools__navigate_page / click / evaluate_script / etc.
    // DR-043 §D2 moved that into the CLI's own localhost redirect + JWT
    // poll — the skill itself has no browser-automation tool call left.
    expect(skill).not.toMatch(/mcp__chrome-devtools__/);
  });

  it('does not declare chrome-devtools tools in its allowed-tools frontmatter', () => {
    const frontmatterEnd = skill.indexOf('\n---', 4);
    const frontmatter = skill.slice(0, frontmatterEnd === -1 ? undefined : frontmatterEnd);
    expect(frontmatter).not.toMatch(/chrome-devtools/);
  });
});

describe('macf-bootstrap README.md — describes the CLI as the current mechanism', () => {
  const readme = read(README_PATH);

  it('references DR-043 and fleet.yaml', () => {
    expect(readme).toMatch(/DR-043/);
    expect(readme).toMatch(/fleet\.yaml/);
  });

  it('marks the debug-Chrome instructions as legacy, not the default flow', () => {
    expect(readme).toMatch(/[Ll]egacy/);
  });
});

describe('macf-bootstrap-safety.md — carries a positioning note pointing at DR-043', () => {
  it('references DR-043 near the top of the file', () => {
    const rule = read(SAFETY_RULE_PATH);
    expect(rule).toMatch(/DR-043/);
  });
});

describe('scientific-paper-fleet.md §2-bootstrap — points at the CLI, not the skill, as primary', () => {
  const recipe = read(RECIPE_PATH);

  it('references macf bootstrap (the CLI) and DR-043', () => {
    expect(recipe).toMatch(/macf bootstrap (plan|apply)/);
    expect(recipe).toMatch(/DR-043/);
  });

  it('does not carry the superseded "Recommended" banner or dogfood solicitation', () => {
    // The pre-#877 recipe opened §2 with "🤖 **Recommended: ... `macf-bootstrap`**"
    // and tagged §2-bootstrap "`[OPERATOR DOGFOOD]`" — both steered an operator
    // at the Chrome-driven flow as the endorsed default. Neither should recur.
    expect(recipe).not.toMatch(/🤖 \*\*Recommended/);
    expect(recipe).not.toMatch(/OPERATOR DOGFOOD/);
  });

  it('warns about the App-install repository picker (groundnuty/macf#1128)', () => {
    // #1128 is open at the time of this rewrite — the recipe must not imply
    // the "Only select repositories" choice is verified automatically for
    // ordinary agent Apps yet.
    expect(recipe).toMatch(/#1128/);
  });
});
