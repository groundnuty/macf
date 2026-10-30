/**
 * Shared helpers for the docs drift tests: the real `macf` command tree, and
 * the flag check for a `macf …` command line found in a document.
 */
import { Command } from 'commander';
import { vi } from 'vitest';

export interface CmdNode {
  readonly name: string;
  readonly flags: readonly string[];
  readonly commands: readonly CmdNode[];
}

export interface CodeLine {
  readonly line: number;
  readonly text: string;
}

const walk = (c: Command): CmdNode => ({
  name: c.name(),
  flags: c.options.flatMap((o) => [o.long, o.short].filter((f): f is string => f !== undefined)),
  commands: c.commands.map(walk),
});

/** Build the real command tree. Importing the CLI entry parses argv, so swap that for a capture. */
export async function loadCommandTree(): Promise<CmdNode> {
  let tree: CmdNode | undefined;
  const spy = vi.spyOn(Command.prototype, 'parseAsync').mockImplementation(function (this: Command) {
    tree = walk(this);
    return Promise.resolve(this);
  });
  try {
    await import('../../../src/cli/index.js');
  } finally {
    spy.mockRestore();
  }
  if (tree === undefined) throw new Error('command tree was not captured');
  return tree;
}

/** Logical lines of fenced code blocks, with `\` continuations joined. */
export function codeBlockLines(lines: readonly string[]): CodeLine[] {
  const out: CodeLine[] = [];
  let inFence = false;
  let pending: CodeLine | undefined;
  lines.forEach((raw, i) => {
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
export function macfCommand(text: string): string | undefined {
  let t = text.trim().replace(/^\$\s+/, '');
  t = t.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '');
  if (!/^macf\s/.test(t)) return undefined;
  return t.replace(/\s#\s.*$/, '').split(/\s(?:\||>|<|&&|;)\s?/)[0] ?? t;
}

/** Walk the subcommand path, then return the node reached and the flags that follow. */
export function resolveCommand(
  tree: CmdNode,
  cmd: string,
): { node: CmdNode; path: string; flags: string[] } {
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

/** Flags in `cmd` that its command does not define. `--help` and `--version` are always allowed. */
export function unknownFlags(tree: CmdNode, cmd: string): { path: string; bad: string[]; checked: number } {
  const { node, path, flags } = resolveCommand(tree, cmd);
  const bad = flags.filter((f) => f !== '--help' && f !== '--version' && !node.flags.includes(f));
  return { path, bad, checked: flags.length };
}
