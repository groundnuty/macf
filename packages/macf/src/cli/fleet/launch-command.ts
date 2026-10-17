/**
 * The one shell command that starts an agent inside a fresh detached tmux
 * session. `fleet reconcile`'s cold start and `restart-self`'s relauncher both
 * use it, so they cannot drift.
 *
 * It must be `new-session -d` with `MACF_NO_TMUX_WRAP=1`: claude.sh's own
 * self-wrap runs `tmux new-session` without `-d`, which fails with "open
 * terminal failed: not a terminal" when nothing has a terminal.
 */

/**
 * Identity variables a launched agent must never inherit (macf#763). A
 * detached session takes the tmux SERVER's global environment, not the
 * client's, and `env.identity` keeps an already-set value, so these are
 * removed inside the session itself.
 */
export const ORCHESTRATOR_IDENTITY_ENV_KEYS = [
  'MACF_WORKSPACE_DIR',
  'MACF_PROJECT',
  'MACF_ROUTING_LABEL',
  'MACF_AGENT_NAME',
  'CLAUDE_PROJECT_DIR',
] as const;

/** Quote a literal path as one shell word, so `$`, backticks and quotes in it stay literal. */
export function shellQuote(literal: string): string {
  return `'${literal.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command tmux runs inside the new session. `workspaceWord` is already a
 * shell word: `shellQuote(path)` for a literal path, or `"$WORKSPACE"` for the
 * relauncher's variable.
 */
export function launchInnerCommand(workspaceWord: string): string {
  const unset = ORCHESTRATOR_IDENTITY_ENV_KEYS.map((k) => `-u ${k}`).join(' ');
  return `exec env ${unset} MACF_NO_TMUX_WRAP=1 ${workspaceWord}/claude.sh`;
}

/** The `tmux` arguments that create the detached session and start the agent in it. */
export function buildTmuxLaunchArgs(session: string, workspaceDir: string): readonly string[] {
  return ['new-session', '-d', '-s', session, '-c', workspaceDir, launchInnerCommand(shellQuote(workspaceDir))];
}
