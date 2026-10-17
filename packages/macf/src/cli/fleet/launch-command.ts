/**
 * The one shell command that starts an agent inside a fresh detached tmux
 * session. `fleet reconcile`'s cold start and `restart-self`'s relauncher both
 * use it, so they cannot drift.
 *
 * It must be `new-session -d` with `MACF_NO_TMUX_WRAP=1`: claude.sh's own
 * self-wrap runs `tmux new-session` without `-d`, which fails with "open
 * terminal failed: not a terminal" when nothing has a terminal.
 */

/** The command tmux runs inside the new session. `workspaceRef` is a path or a shell variable. */
export function launchInnerCommand(workspaceRef: string): string {
  return `MACF_NO_TMUX_WRAP=1 exec "${workspaceRef}/claude.sh"`;
}

/** The `tmux` arguments that create the detached session and start the agent in it. */
export function buildTmuxLaunchArgs(session: string, workspaceDir: string): readonly string[] {
  return ['new-session', '-d', '-s', session, '-c', workspaceDir, launchInnerCommand(workspaceDir)];
}
