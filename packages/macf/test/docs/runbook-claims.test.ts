/**
 * Drift check for design/fleet-deployment-runbook.md.
 *
 * The runbook is read by agents and humans who follow it literally, so a wrong
 * word or a flag that does not exist stalls them. This pins four claims to
 * source: the plan-approval word, every `--flag` in a `macf …` code line, the
 * name of the agent's role file, and the `claude` minimum.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLY_CONFIRM_WORD } from '../../src/cli/commands/bootstrap-apply.js';
import { MIN_NODE } from '../../src/cli/bootstrap/preflight.js';
import { AGENT_HOST_MINIMUMS } from '../../src/cli/bootstrap/preflight-agent-host.js';
import { codeBlockLines, loadCommandTree, macfCommand, resolveCommand, type CmdNode } from './helpers/command-tree.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../..');
const runbookPath = resolve(pkgRoot, '../../design/fleet-deployment-runbook.md');
const runbook = readFileSync(runbookPath, 'utf-8');
const runbookLines = runbook.split('\n');

let tree: CmdNode;

beforeAll(async () => {
  tree = await loadCommandTree();
}, 120_000);

describe('fleet-deployment-runbook.md claims', () => {
  it('names the plan-approval word the CLI asks for', () => {
    const start = runbookLines.findIndex((l) => /^### 3\.3\b/.test(l));
    const end = runbookLines.findIndex((l, i) => i > start && /^### 3\.4\b/.test(l));
    expect(start).toBeGreaterThan(-1);
    const section = runbookLines.slice(start, end).join('\n');
    expect(section).toContain(`\`${APPLY_CONFIRM_WORD}\``);
    expect(section).not.toContain('approve it once with `y`');
  });

  it('only uses flags that the command defines', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const { line, text } of codeBlockLines(runbookLines)) {
      const cmd = macfCommand(text);
      if (cmd === undefined) continue;
      const { node, path, flags } = resolveCommand(tree, cmd);
      for (const f of flags) {
        checked++;
        if (f === '--help' || f === '--version') continue;
        if (!node.flags.includes(f)) bad.push(`runbook line ${String(line)}: ${f} is not a flag of \`${path}\``);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });

  it('does not call the agent role file CLAUDE.md', () => {
    // Narrow on purpose: "the template ships no `CLAUDE.md`" is a true sentence and must pass.
    const roleFile = [
      /stub\s+`?CLAUDE\.md/i,
      /\b(its|agent's|each agent's|the agent's)\s+`?CLAUDE\.md/i,
      /\b(edit|fill in|put|write)\b[^.\n]{0,60}CLAUDE\.md/i,
      /`CLAUDE\.md`\s+(is|holds|carries)\b/i,
    ];
    const hits = runbookLines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => roleFile.some((re) => re.test(l)))
      .map(({ n, l }) => `runbook line ${String(n)}: ${l.trim().slice(0, 100)}`);
    expect(hits).toEqual([]);
  });

  it('requires a claude version at least as new as the one claude-sh gates channels on', () => {
    const claudeSh = readFileSync(resolve(pkgRoot, 'src/cli/claude-sh.ts'), 'utf-8');
    const gate = /GATED on Claude Code >= (\d+\.\d+\.\d+)/.exec(claudeSh)?.[1];
    const row = /`claude` (\d+\.\d+\.\d+) or later/.exec(runbook)?.[1];
    expect(gate).toBeDefined();
    expect(row).toBeDefined();
    const parts = (v: string): number[] => v.split('.').map(Number);
    const [a, b] = [parts(row ?? '0.0.0'), parts(gate ?? '999.0.0')];
    const atLeast = a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! !== b[1]! ? a[1]! > b[1]! : a[2]! >= b[2]!;
    expect(atLeast, `runbook says ${String(row)}, claude-sh gates on ${String(gate)}`).toBe(true);
  });

  it('states the node, bash and claude minimums that preflight enforces', () => {
    const pad = (v: string): string => [...v.split('.'), '0', '0'].slice(0, 3).join('.');
    const node = /Node\.js (\d+(?:\.\d+)*) or later/.exec(runbook)?.[1];
    const bash = /`bash` (\d+(?:\.\d+)*) or later/.exec(runbook)?.[1];
    const claude = /`claude` (\d+(?:\.\d+)*) or later/.exec(runbook)?.[1];
    expect(node).toBeDefined();
    expect(bash).toBeDefined();
    expect(claude).toBeDefined();
    expect(pad(node ?? '')).toBe(MIN_NODE);
    expect(pad(bash ?? '')).toBe(AGENT_HOST_MINIMUMS['bash']?.min);
    expect(pad(claude ?? '')).toBe(AGENT_HOST_MINIMUMS['claude']?.min);
  });
});
