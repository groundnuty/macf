/**
 * Drift check for design/fleet-deploy-agent-prompt.md against the walkthrough
 * (design/fleet-deployment-runbook.md) and the real CLI.
 *
 * The prompt points at the walkthrough by section number, names CLI flags, and
 * states a version floor. Each of those can drift without anyone noticing, so
 * this pins them. The prompt must not name the plan-approval word: the
 * walkthrough owns it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeBlockLines, loadCommandTree, macfCommand, unknownFlags, type CmdNode } from './helpers/command-tree.js';

const here = dirname(fileURLToPath(import.meta.url));
const designDir = resolve(here, '../../../../design');
const runbook = readFileSync(resolve(designDir, 'fleet-deployment-runbook.md'), 'utf-8');
const prompt = readFileSync(resolve(designDir, 'fleet-deploy-agent-prompt.md'), 'utf-8');
const runbookLines = runbook.split('\n');
const promptLines = prompt.split('\n');

const repoRoot = resolve(designDir, '..');
const packDir = resolve(designDir, 'onboarding-packs/paper-fleet');
const packReadme = readFileSync(resolve(packDir, 'README.md'), 'utf-8');

/** Repo paths under design/ that the text names in backticks. */
function designPaths(text: string): string[] {
  return [...text.matchAll(/`(design\/[^`\s]+)`/g)].map((m) => m[1] ?? '');
}

/** Names in the README fetch loop (`for f in a b c; do`), as .md file names. */
function packFiles(text: string): string[] {
  const m = /for f in ([^;]+);\s*do/.exec(text);
  return (m?.[1] ?? '').split(/\s+/).filter(Boolean).map((n) => `${n}.md`);
}

let tree: CmdNode;

beforeAll(async () => {
  tree = await loadCommandTree();
}, 120_000);

/** Every `macf …` command in the prompt: fenced code lines and inline backtick spans. */
function promptCommands(): { line: number; cmd: string }[] {
  const out: { line: number; cmd: string }[] = [];
  for (const { line, text } of codeBlockLines(promptLines)) {
    const cmd = macfCommand(text);
    if (cmd !== undefined) out.push({ line, cmd });
  }
  let inFence = false;
  promptLines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (inFence) return;
    for (const m of l.matchAll(/`([^`]+)`/g)) {
      const found = /(?:^|[\s'"&;])(macf\s[^'"]*)/.exec(m[1] ?? '');
      if (found?.[1] !== undefined) out.push({ line: i + 1, cmd: found[1].trim() });
    }
  });
  return out;
}

describe('fleet-deploy-agent-prompt.md claims', () => {
  it('only refers to walkthrough sections that exist', () => {
    const headings = new Set<string>();
    for (const l of runbookLines) {
      const h2 = /^## (\d+[a-z]?)\./.exec(l);
      const h3 = /^### (\d+[a-z]?\.\d+(?:\.\d+)?)\b/.exec(l);
      if (h2?.[1]) headings.add(h2[1]);
      if (h3?.[1]) headings.add(h3[1]);
    }
    const bad: string[] = [];
    let checked = 0;
    promptLines.forEach((l, i) => {
      for (const m of l.matchAll(/§(\d+[a-z]?(?:\.\d+)*)/g)) {
        const ref = (m[1] ?? '').replace(/\.$/, '');
        checked++;
        if (!headings.has(ref)) bad.push(`prompt line ${String(i + 1)}: §${ref} is not a heading in the walkthrough`);
      }
    });
    expect(checked).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });

  it('only uses flags that the command defines', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const { line, cmd } of promptCommands()) {
      const r = unknownFlags(tree, cmd);
      checked += r.checked;
      for (const f of r.bad) bad.push(`prompt line ${String(line)}: ${f} is not a flag of \`${r.path}\``);
    }
    expect(checked).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('states the same version floor as the walkthrough install line', () => {
    const floor = /\*\*(\d+\.\d+\.\d+) or later\*\*/.exec(prompt)?.[1];
    const install = /npm install -g @groundnuty\/macf@(\d+\.\d+\.\d+)/.exec(runbook)?.[1];
    expect(floor).toBeDefined();
    expect(install).toBeDefined();
    expect(floor).toBe(install);
  });

  it('does not say which word approves the plan', () => {
    const hits = promptLines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /approv\w*[^.\n]{0,60}`(?:y|yes)`/i.test(l) || /`(?:y|yes)`[^.\n]{0,60}approv/i.test(l) || /\b(?:type|answer|reply|enter)\b[^.\n]{0,30}`(?:y|yes)`/i.test(l))
      .map(({ n, l }) => `prompt line ${String(n)}: ${l.trim().slice(0, 100)}`);
    expect(hits).toEqual([]);
  });

  it('only names design/ paths that exist', () => {
    const paths = designPaths(prompt);
    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter((p) => !existsSync(resolve(repoRoot, p)));
    expect(missing).toEqual([]);
  });

  it('ships every file the pack README fetches', () => {
    const files = packFiles(packReadme);
    expect(files.length).toBeGreaterThan(0);
    const missing = files.filter((f) => !existsSync(resolve(packDir, f)));
    expect(missing).toEqual([]);
  });
});
