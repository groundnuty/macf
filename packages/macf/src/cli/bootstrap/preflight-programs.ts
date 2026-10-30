/**
 * Every external program `macf bootstrap` and the agents run, and what preflight does about it.
 * The guard test (test/cli/bootstrap-preflight-programs.test.ts) fails when a spawned program or a
 * hook-script program is in none of the three lists, so a new dependency cannot slip past preflight.
 */

/** Programs the apply host runs (plan, apply, status) that preflight checks on this machine. */
export const APPLY_HOST_CHECKED = ['macf', 'gh', 'gh-token', 'age', 'age-keygen', 'git', 'tailscale', 'ssh', 'open', 'xdg-open'] as const;

/** Programs an agent workspace needs at runtime, probed on the agent host's non-interactive login PATH. */
export const AGENT_HOST_TOOLS = ['node', 'claude', 'tmux', 'crontab', 'gh', 'bash', 'macf', 'git', 'jq', 'openssl', 'curl'] as const;

/** Programs left unchecked on purpose, each with the reason. Names are exact. */
export const EXCLUDED_PROGRAMS: Readonly<Record<string, string>> = {
  sh: 'POSIX shell, present on every host',
  command: 'shell builtin',
  cmd: 'Windows launcher; apply does not run on Windows',
  ps: 'macOS system tool, used only by the macOS process scan',
  lsof: 'macOS system tool, used only by the macOS process scan',
  sha256sum: 'check-managed-drift.sh falls back to shasum, and one of them is on every host',
  shasum: 'check-managed-drift.sh falls back to sha256sum, and one of them is on every host',
  'otel-cli': 'optional span emitter in check-gh-token.sh, used only when installed; the script falls back to curl',
  npm: 'only `macf self-update` (npm-link dev installs), never apply or an agent',
  npx: 'only the channel-server mount in .mcp.json, which Claude Code runs with its own node',
};

/** Coreutils and POSIX tools the hook scripts and launcher use; present on every host. */
export const POSIX_UTILITIES = [
  'awk', 'cat', 'cut', 'date', 'dirname', 'basename', 'env', 'find', 'grep', 'head', 'ionice', 'ls',
  'mktemp', 'sed', 'sleep', 'sort', 'tail', 'tee', 'tr', 'uniq', 'wc', 'xargs', 'cksum', 'mkdir', 'rm', 'mv', 'cp', 'touch',
] as const;
