/**
 * Drift check for design/fleet-deployment-runbook.md.
 *
 * The runbook is read by agents and humans who follow it literally, so a wrong
 * word or a flag that does not exist stalls them. This pins three claims to
 * source: the plan-approval word, every `--flag` in a `macf …` code line, and
 * the name of the agent's role file.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPLY_CONFIRM_WORD } from '../../src/cli/commands/bootstrap-apply.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../..');
const runbookPath = resolve(pkgRoot, '../../design/fleet-deployment-runbook.md');
const runbook = readFileSync(runbookPath, 'utf-8');
const runbookLines = runbook.split('\n');

interface CmdNode {
  readonly name: string;
  readonly flags: readonly string[];
  readonly commands: readonly CmdNode[];
}

let tree: CmdNode;

const walk = (c: Command): CmdNode => ({
  name: c.name(),
  flags: c.options.flatMap((o) => [o.long, o.short].filter((f): f is string => f !== undefined)),
  commands: c.commands.map(walk),
});

beforeAll(async () => {
  // Importing the CLI entry builds the real command tree and then parses argv.
  // Swap the parse for a capture of the tree, so no command runs.
  const spy = vi.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (this: Command) {
    tree = walk(this);
    return Promise.resolve(this);
  });
  try {
    await import('../../src/cli/index.js');
  } finally {
    spy.mockRestore();
  }
}, 120_000);

interface CodeLine {
  readonly line: number;
  readonly text: string;
}

/** Logical lines of fenced code blocks, with `\` continuations joined. */
function codeBlockLines(): CodeLine[] {
  const out: CodeLine[] = [];
  let inFence = false;
  let pending: CodeLine | undefined;
  runbookLines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      pending = undefined;
      return;
    }
    if (!inFence) return;
    const cont = raw.endsWith('\\');
    const piece = cont ? raw.slice(0, -1) : raw;
    if (pending) {
      pending = { line: pending.line, text: `${pending.text} ${piece.trim()}` };
    } else {
      pending = { line: i + 1, text: piece };
    }
    if (!cont) {
      out.push(pending);
      pending = undefined;
    }
  });
  return out;
}

/** The `macf …` command in a code line, or undefined. Strips `$ `, env assignments and comments. */
function macfCommand(text: string): string | undefined {
  let t = text.trim().replace(/^\$\s+/, '');
  t = t.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '');
  if (!/^macf\s/.test(t)) return undefined;
  return t.replace(/\s#\s.*$/, '').split(/\s(?:\||>|<|&&|;)\s?/)[0] ?? t;
}

/** Walk the subcommand path, then return the node reached and the flags that follow. */
function resolveCommand(cmd: string): { node: CmdNode; path: string; flags: string[] } {
  const tokens = cmd.split(/\s+/).slice(1);
  let node = tree;
  const path = ['macf'];
  let i = 0;
  for (; i < tokens.length; i++) {
    const next = node.commands.find((c) => c.name === tokens[i]);
    if (!next) break;
    node = next;
    path.push(next.name);
  }
  const flags = tokens
    .slice(i)
    .filter((t) => t.startsWith('--'))
    .map((t) => t.replace(/=.*$/, ''))
    .filter((t) => !t.includes('<'));
  return { node, path: path.join(' '), flags };
}

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
    for (const { line, text } of codeBlockLines()) {
      const cmd = macfCommand(text);
      if (cmd === undefined) continue;
      const { node, path, flags } = resolveCommand(cmd);
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
});
