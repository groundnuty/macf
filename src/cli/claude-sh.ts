/**
 * Generate and write the per-workspace `claude.sh` launcher. Extracted
 * from `init.ts` so `macf update` can regenerate it when the template
 * changes (see #63 — workspaces init'd on older CLI versions end up
 * with stale launchers and no way to refresh short of re-running init).
 *
 * The launcher carries a "managed file" header telling users not to
 * edit it — same pattern as the rules distribution (#54). `macf update`
 * overwrites unconditionally; user customizations are expected to live
 * elsewhere (e.g., `.claude/settings.local.json` for env tweaks).
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MacfAgentConfig } from './config.js';

const MANAGED_HEADER_LINES = [
  '# This file is managed by `macf`. Do not edit directly — edits are',
  '# overwritten on the next `macf update`. The template lives at',
  '# groundnuty/macf:src/cli/claude-sh.ts. To change the launcher, file',
  '# an issue or PR against that file, then run `macf update` here.',
];

/**
 * Build the full `claude.sh` content for a given agent config. Pure
 * function — no I/O. Used by both `macf init` (first write) and
 * `macf update` (refresh).
 */
export function generateClaudeSh(config: MacfAgentConfig): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `# MACF Agent Launcher: ${config.agent_name}`,
    ...MANAGED_HEADER_LINES,
    '',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'cd "$SCRIPT_DIR"',
    '',
    `export MACF_AGENT_NAME="${config.agent_name}"`,
    `export MACF_PROJECT="${config.project}"`,
    `export MACF_AGENT_TYPE="${config.agent_type}"`,
    `export MACF_AGENT_ROLE="${config.agent_role}"`,
    `export APP_ID="${config.github_app.app_id}"`,
    `export INSTALL_ID="${config.github_app.install_id}"`,
    `export KEY_PATH="${config.github_app.key_path}"`,
    `export MACF_CA_CERT="$HOME/.macf/certs/${config.project}/ca-cert.pem"`,
    'export MACF_AGENT_CERT="$SCRIPT_DIR/.macf/certs/agent-cert.pem"',
    'export MACF_AGENT_KEY="$SCRIPT_DIR/.macf/certs/agent-key.pem"',
    'export MACF_LOG_PATH="$SCRIPT_DIR/.macf/logs/channel.log"',
    'export MACF_DEBUG="${MACF_DEBUG:-false}"',
    '',
    '# Bot token generation — fail loud. The helper validates the ghs_ prefix',
    '# and surfaces diagnostics (clock drift, bad key, wrong App/install ID).',
    '# Do NOT inline the bare CLI here — without pipefail, a failed fetch piped',
    '# through jq would succeed, GH_TOKEN would become "null", and Claude Code',
    '# would silently fall back to stored `gh auth login` as the user. See the',
    '# attribution-trap section of coordination.md Token & Git Hygiene.',
    'GH_TOKEN=$("$SCRIPT_DIR/.claude/scripts/macf-gh-token.sh" \\',
    '    --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || {',
    '  echo "FATAL: bot token generation failed — see stderr above." >&2',
    '  exit 1',
    '}',
    'export GH_TOKEN',
    '',
    `export GIT_AUTHOR_NAME="${config.agent_name}[bot]"`,
    `export GIT_COMMITTER_NAME="${config.agent_name}[bot]"`,
    '',
    `echo "Starting ${config.agent_name} (${config.agent_role})..."`,
    // --plugin-dir loads the pinned macf-agent plugin from this workspace
    // (per DR-013). Additive — user-scope plugins still load alongside.
    'exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"',
    '',
  ].join('\n');
}

/**
 * Write `claude.sh` into the workspace at 0755. Overwrites any existing
 * content — the managed-file header warns users against hand-editing.
 */
export function writeClaudeSh(workspaceDir: string, config: MacfAgentConfig): string {
  const absDir = resolve(workspaceDir);
  const path = join(absDir, 'claude.sh');
  writeFileSync(path, generateClaudeSh(config), { mode: 0o755 });
  // writeFileSync's `mode` option only applies when creating a new file.
  // On overwrite, the existing mode (often 0o644 from a user's editor)
  // is kept — so we must explicitly chmod to make sure the launcher
  // stays executable after `macf update` rewrites it.
  chmodSync(path, 0o755);
  return path;
}
