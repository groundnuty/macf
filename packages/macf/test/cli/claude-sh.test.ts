/**
 * Tests for the thin claude.sh launcher template (macf#342 PR-B).
 *
 * Pre-#342 the launcher was a monolithic 100+ line script with all
 * per-concern env exports inlined. PR-B moved those exports into
 * separate files under `.claude/.macf/env.*` and reduced claude.sh to
 * a thin source-then-exec template — see `env-files.test.ts` for the
 * per-concern export-shape coverage.
 *
 * What lives in claude.sh now (and is tested HERE):
 *   - shebang + `set -euo pipefail`
 *   - managed-file header
 *   - SCRIPT_DIR resolution
 *   - source-loop on `.claude/.macf/env.*` (alphabetical → env._helpers
 *     first → defines macf_settings_get → callable from sibling files)
 *   - MACF_HOST / MACF_ADVERTISE_HOST / MACF_DEBUG (channel-server runtime
 *     knobs that don't bucket cleanly into a single env.* concern)
 *   - tmux self-wrap block (macf#340 env-isolation preserved)
 *   - conditional `exec claude` (MACF_TEST + permanent-vs-worker -c)
 *
 * `otelTelemetryLines` stays exported from claude-sh.ts as the canonical
 * pre-migration reference shape (used by test fixtures). Its behavior is
 * still tested in this file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateClaudeSh, writeClaudeSh, otelTelemetryLines, hasManagedHeader } from '../../src/cli/claude-sh.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

const sampleConfig: MacfAgentConfig = {
  project: 'TEST',
  agent_name: 'code-agent',
  agent_role: 'code-agent',
  agent_type: 'permanent',
  registry: { type: 'repo', owner: 'o', repo: 'r' },
  github_app: {
    app_id: '12345',
    install_id: '67890',
    key_path: '.github-app-key.pem',
  },
  versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
};

describe('generateClaudeSh', () => {
  it('starts with a bash shebang and set -euo pipefail', () => {
    const output = generateClaudeSh(sampleConfig);
    const lines = output.split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env bash');
    expect(lines[1]).toBe('set -euo pipefail');
  });

  it('includes the managed-file header warning users not to edit', () => {
    const output = generateClaudeSh(sampleConfig);
    expect(output).toContain('managed by `macf`');
    expect(output).toContain('overwritten on the next `macf update`');
  });

  it('exports SCRIPT_DIR via cd $(dirname BASH_SOURCE) && pwd', () => {
    const output = generateClaudeSh(sampleConfig);
    expect(output).toContain('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
  });

  describe('source-loop on .claude/.macf/env.* (macf#342 PR-B)', () => {
    it('emits a for-loop that sources files matching env.* under .claude/.macf', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toMatch(/for f in "\$SCRIPT_DIR\/\.claude\/\.macf"\/env\.\*/);
      expect(output).toContain('source "$f"');
    });

    it('guards the loop with a directory existence check', () => {
      // Avoids set -euo pipefail tripping if the directory is missing
      // (e.g., partially-installed workspace; PR-C migration in flight).
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('if [ -d "$SCRIPT_DIR/.claude/.macf" ]; then');
    });

    it('canonical env files sort with env._helpers FIRST (alphabetical glob; _ < lowercase a-z)', () => {
      // Per macf#342 helper-strategy decision (option v): env._helpers
      // sorts before env.identity etc. via shell glob, so its
      // macf_settings_get definition is available when env.identity +
      // env.telemetry call it. Pin the invariant: if any canonical file
      // is renamed in a way that breaks this sort order, this test fails.
      const canonicalFiles = [
        'env._helpers',
        'env.certs',
        'env.github',
        'env.identity',
        'env.registry',
        'env.telemetry',
        'env.tmux',
      ];
      const sorted = [...canonicalFiles].sort();
      expect(sorted).toEqual(canonicalFiles);
      expect(sorted[0]).toBe('env._helpers');
    });

    it('docs the operator-custom-env-file convention to avoid the env.UPPERCASE trap (macf#342)', () => {
      // Bash glob sorts ASCII: uppercase A-Z (0x41-0x5A) BEFORE underscore
      // (0x5F) BEFORE lowercase a-z. So an operator-added file
      // `env.UPPERCASE_OVERRIDE` would sort BEFORE `env._helpers` and
      // source in a context without macf_settings_get defined yet.
      // Documented operator convention: env.local.* or env.zz.* prefix
      // (sort post-canonical). Verify the comment block in claude.sh
      // documents this so operators see it before falling into the trap.
      const output = generateClaudeSh(sampleConfig);
      expect(output).toMatch(/env\.local\./);
      expect(output).toMatch(/env\.zz\./);
      expect(output).toMatch(/UPPERCASE/);
    });

    it('source-loop happens BEFORE the tmux self-wrap (so AGENT_NAME is set in env captured by -e flags)', () => {
      const output = generateClaudeSh(sampleConfig);
      const sourcePos = output.indexOf('for f in "$SCRIPT_DIR/.claude/.macf"/env.*');
      const tmuxWrapPos = output.indexOf('if [ -z "${TMUX:-}" ]');
      expect(sourcePos).toBeGreaterThan(0);
      expect(tmuxWrapPos).toBeGreaterThan(0);
      expect(sourcePos).toBeLessThan(tmuxWrapPos);
    });

    it('source-loop happens BEFORE the final exec claude (so identity etc. are available to claude)', () => {
      const output = generateClaudeSh(sampleConfig);
      const sourcePos = output.indexOf('for f in "$SCRIPT_DIR/.claude/.macf"/env.*');
      const claudeExecPos = output.indexOf('exec claude');
      expect(sourcePos).toBeLessThan(claudeExecPos);
    });

    it('does NOT inline the per-concern exports (now in env-files)', () => {
      // Regression guard: pre-#342 these were embedded in claude.sh.
      // They moved to env.identity / env.github / env.registry / env.certs
      // / env.telemetry / env.tmux — see env-files.test.ts for the
      // per-concern coverage.
      const output = generateClaudeSh(sampleConfig);
      // env.identity owns these:
      expect(output).not.toContain('export MACF_PROJECT="TEST"');
      expect(output).not.toContain('export MACF_AGENT_TYPE="permanent"');
      expect(output).not.toContain('export MACF_AGENT_NAME');
      expect(output).not.toContain('export MACF_AGENT_ROLE');
      expect(output).not.toContain('export MACF_WORKSPACE_DIR="$SCRIPT_DIR"');
      // env.github owns these:
      expect(output).not.toContain('export APP_ID="12345"');
      expect(output).not.toContain('export INSTALL_ID="67890"');
      expect(output).not.toContain('export KEY_PATH=".github-app-key.pem"');
      expect(output).not.toContain('export GH_TOKEN');
      expect(output).not.toContain('export GIT_AUTHOR_NAME');
      // env.certs owns these:
      expect(output).not.toContain('MACF_CA_CERT');
      expect(output).not.toContain('MACF_CA_KEY');
      expect(output).not.toContain('MACF_AGENT_CERT');
      // NOTE: MACF_LOG_PATH is NOT in this not-inlined list anymore. env.certs
      // still owns the canonical value, but claude.sh now ALSO emits a
      // ${MACF_LOG_PATH:-default} fallback (macf#632) so a partial workspace
      // missing env.certs still gets a forensic log path. The `:-` form keeps
      // env.certs's value when present — see the dedicated MACF_LOG_PATH test.
      // env.registry owns these:
      expect(output).not.toContain('MACF_REGISTRY_TYPE');
      // env.telemetry owns these:
      expect(output).not.toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
      expect(output).not.toContain('OTEL_TRACES_EXPORTER');
      // env._helpers owns this:
      expect(output).not.toContain('macf_settings_get() {');
    });
  });

  describe('host-prelude source (DR-031 piece 4)', () => {
    it('emits a guarded source of .claude/.macf/host-prelude.sh', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain(
        '[ -f "$SCRIPT_DIR/.claude/.macf/host-prelude.sh" ] && source "$SCRIPT_DIR/.claude/.macf/host-prelude.sh"',
      );
    });

    it('sources host-prelude.sh BEFORE the env.* loop (toolchain on PATH for the env files)', () => {
      const output = generateClaudeSh(sampleConfig);
      const preludePos = output.indexOf(
        '[ -f "$SCRIPT_DIR/.claude/.macf/host-prelude.sh" ] && source',
      );
      const envLoopPos = output.indexOf('for f in "$SCRIPT_DIR/.claude/.macf"/env.*');
      expect(preludePos).toBeGreaterThan(0);
      expect(envLoopPos).toBeGreaterThan(0);
      expect(preludePos).toBeLessThan(envLoopPos);
    });

    it('sources host-prelude.sh AFTER cd $SCRIPT_DIR (path resolution) and BEFORE the tmux self-wrap', () => {
      const output = generateClaudeSh(sampleConfig);
      const cdPos = output.indexOf('cd "$SCRIPT_DIR"');
      const preludePos = output.indexOf(
        '[ -f "$SCRIPT_DIR/.claude/.macf/host-prelude.sh" ] && source',
      );
      const tmuxWrapPos = output.indexOf('if [ -z "${TMUX:-}" ]');
      expect(cdPos).toBeLessThan(preludePos);
      expect(preludePos).toBeLessThan(tmuxWrapPos);
    });
  });

  describe('channel-server runtime knobs (kept in claude.sh as orchestration)', () => {
    // MACF_HOST / MACF_ADVERTISE_HOST / MACF_DEBUG don't bucket cleanly
    // into a single env.* concern (network-transport-but-not-cert,
    // global-debug-gate). Kept inline in claude.sh post-PR-B.

    it('exports MACF_HOST=0.0.0.0 (listen on all interfaces)', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('export MACF_HOST="0.0.0.0"');
    });

    it('exports MACF_ADVERTISE_HOST from config when set (macf#178 Gap 2)', () => {
      const cfg: MacfAgentConfig = { ...sampleConfig, advertise_host: '100.124.163.105' };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_ADVERTISE_HOST="100.124.163.105"');
    });

    it('falls back to MACF_ADVERTISE_HOST=127.0.0.1 when config.advertise_host is unset', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('export MACF_ADVERTISE_HOST="127.0.0.1"');
    });

    it('accepts a DNS name as advertise-host', () => {
      const cfg: MacfAgentConfig = { ...sampleConfig, advertise_host: 'agent.tailnet.ts.net' };
      const output = generateClaudeSh(cfg);
      expect(output).toContain('export MACF_ADVERTISE_HOST="agent.tailnet.ts.net"');
    });

    it('exports MACF_DEBUG with default false', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('export MACF_DEBUG="${MACF_DEBUG:-false}"');
    });
  });

  describe('exec claude conditional (macf#178 Gap 5 + macf#189 sub-item 4)', () => {
    it('permanent agents resume with -c but fall back to a fresh session (no hard exec of -c)', () => {
      const output = generateClaudeSh(sampleConfig);
      // The resume attempt is NOT exec'd, so the `|| exec claude` fallback fires
      // when there's no resumable conversation (first launch / different path key).
      // macf#632: $MACF_CHANNELS_ARGS is word-split (unquoted) into each invocation.
      expect(output).toContain('claude -c --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@" || exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"');
      expect(output).not.toContain('exec claude -c');
    });

    it('omits -c for worker agents (each invocation is fresh by design)', () => {
      const workerConfig: MacfAgentConfig = { ...sampleConfig, agent_type: 'worker' };
      const output = generateClaudeSh(workerConfig);
      expect(output).toContain('exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"');
      expect(output).not.toContain('exec claude -c');
    });

    it('generates a conditional exec: MACF_TEST set → fresh exec, else → resume-with-fallback (permanent)', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('if [ -n "${MACF_TEST:-}" ]; then');
      // MACF_TEST branch: fresh session, no -c (channels flag word-split in)
      expect(output).toContain('exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"');
      // else branch: resume, falling back to a fresh session if nothing is resumable
      expect(output).toContain('claude -c --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@" || exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@"');
      expect(output).toMatch(/fi[\s\n]*$/);
    });

    it('worker agents get the same conditional shape (both branches have no -c)', () => {
      const workerConfig: MacfAgentConfig = { ...sampleConfig, agent_type: 'worker' };
      const output = generateClaudeSh(workerConfig);
      expect(output).toContain('if [ -n "${MACF_TEST:-}" ]; then');
    });
  });

  describe('tmux self-wrap (macf#313 + macf#340 env-isolation preserved)', () => {
    it('emits tmux self-wrap block with $TMUX guard + MACF_NO_TMUX_WRAP opt-out', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('if [ -z "${TMUX:-}" ] && [ "${MACF_NO_TMUX_WRAP:-}" != "1" ]; then');
    });

    it('emits canonical session name from MACF_PROJECT@MACF_ROUTING_LABEL (macf#678)', () => {
      // The session keys on the routing-label (registry key / cert CN /
      // DR-031 watchdog target), NOT the OTEL agent-name — so a name!=label
      // agent's session matches what the watchdog + reconcile/resume look for.
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('SESSION_NAME="${MACF_PROJECT}@${MACF_ROUTING_LABEL}"');
      expect(output).not.toContain('SESSION_NAME="${MACF_PROJECT}@${MACF_AGENT_NAME}"');
    });

    it('keys the session on the routing-label for a name != routing_label agent (macf#678)', () => {
      // Shell-variable expansion: the launcher emits the same `${MACF_ROUTING_LABEL}`
      // literal regardless of config, and env.identity resolves it to the
      // baked routing_label at runtime (covered in env-files.test.ts). This
      // pins that the session derivation is routing-label-driven, not
      // agent-name-interpolated — so science (name=macf-science-agent,
      // routing_label=science-agent) lands on `macf@science-agent`, not
      // `macf@macf-science-agent`.
      const nameNeLabel: MacfAgentConfig = {
        ...sampleConfig,
        agent_name: 'macf-science-agent',
        routing_label: 'science-agent',
      };
      const output = generateClaudeSh(nameNeLabel);
      const sessionLine = output
        .split('\n')
        .find((l) => l.includes('SESSION_NAME='));
      expect(sessionLine?.trim()).toBe('SESSION_NAME="${MACF_PROJECT}@${MACF_ROUTING_LABEL}"');
      // The session-name derivation must not bake either identity literal.
      expect(sessionLine).not.toContain('macf-science-agent');
      expect(sessionLine).not.toContain('science-agent"');
    });

    it('emits has-session re-attach path with stderr suppressed', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then');
      expect(output).toContain('exec tmux attach -t "$SESSION_NAME"');
    });

    it('emits tmux new-session create path with -c $SCRIPT_DIR + script re-exec', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toMatch(/exec tmux new-session\b/);
      expect(output).toContain('-s "$SESSION_NAME"');
      expect(output).toContain('-c "$SCRIPT_DIR"');
      expect(output).toMatch(/"\$0" "\$@"/);
    });

    it('builds MACF_TMUX_E_ARGS from env-pattern grep (macf#340 single source of truth)', () => {
      const output = generateClaudeSh(sampleConfig);
      // Pattern-driven rather than hard-coded list: future MACF_* additions
      // are picked up automatically; vars not set at wrap-time are absent.
      expect(output).toMatch(/MACF_TMUX_E_ARGS=\(\)/);
      expect(output).toMatch(/env\s*\|\s*grep -E "\^MACF_"/);
    });

    it('iterates the env-grep output with read -r and appends -e flags', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toMatch(/while IFS= read -r macf_env_line/);
      expect(output).toMatch(/MACF_TMUX_E_ARGS\+=\("-e"\s+"\$macf_env_line"\)/);
    });

    it('expands MACF_TMUX_E_ARGS into the tmux new-session invocation', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toMatch(/exec tmux new-session "\$\{MACF_TMUX_E_ARGS\[@\]\}" -s "\$SESSION_NAME" -c "\$SCRIPT_DIR"/);
    });

    it('preserves MACF_NO_TMUX_WRAP=1 opt-out gate', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toMatch(/MACF_NO_TMUX_WRAP/);
    });

    it('grep tolerates the no-match case via `|| true` (defensive)', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toMatch(/grep -E "\^MACF_" \|\| true/);
    });

    it('tmux wrap block comes BEFORE the final claude exec (re-exec hazard guard)', () => {
      const output = generateClaudeSh(sampleConfig);
      const tmuxWrapPos = output.indexOf('if [ -z "${TMUX:-}" ]');
      const claudeExecPos = output.indexOf('exec claude');
      expect(tmuxWrapPos).toBeGreaterThan(0);
      expect(claudeExecPos).toBeGreaterThan(0);
      expect(tmuxWrapPos).toBeLessThan(claudeExecPos);
    });
  });

  describe('channel-notifications enablement (macf#632)', () => {
    it('defaults MACF_CHANNELS_ARGS to the dev-flag form for the macf-agent server', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain(
        'MACF_CHANNELS_ARGS="--dangerously-load-development-channels server:macf-agent"',
      );
    });

    it('honors the MACF_CHANNELS_DISABLED=1 opt-out (empties the args)', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('if [ "${MACF_CHANNELS_DISABLED:-}" = "1" ]; then');
      expect(output).toMatch(/MACF_CHANNELS_DISABLED:-.*\n\s*MACF_CHANNELS_ARGS=""/);
    });

    it('respects a preset MACF_CHANNELS_ARGS override verbatim', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('elif [ -n "${MACF_CHANNELS_ARGS:-}" ]; then');
    });

    it('version-gates the flag on Claude Code >= 2.1.80 (parses claude --version)', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain("claude --version");
      expect(output).toContain('macf_channels_supported=1');
      // major.minor.patch numeric comparison against 2.1.80
      expect(output).toContain('[ "${macf_cc_major:-0}" -eq 2 ] && [ "${macf_cc_minor:-0}" -eq 1 ] && [ "${macf_cc_patch:-0}" -ge 80 ]');
    });

    it('warns LOUDLY to stderr when the version is older than 2.1.80 / unparseable', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain('older than 2.1.80');
      expect(output).toMatch(/echo "WARNING.*>&2/);
      expect(output).toContain('UNAVAILABLE this session');
    });

    it('runs the channels block AFTER the tmux self-wrap, BEFORE the exec', () => {
      const output = generateClaudeSh(sampleConfig);
      const tmuxPos = output.indexOf('if [ -z "${TMUX:-}" ]');
      const channelsPos = output.indexOf('macf_channels_supported=0');
      const execPos = output.indexOf('if [ -n "${MACF_TEST:-}" ]');
      expect(tmuxPos).toBeGreaterThan(0);
      expect(channelsPos).toBeGreaterThan(tmuxPos);
      expect(channelsPos).toBeLessThan(execPos);
    });

    it('expands $MACF_CHANNELS_ARGS UNQUOTED in every exec claude line (word-split)', () => {
      const output = generateClaudeSh(sampleConfig);
      // unquoted (no surrounding double-quotes) so the two-token flag splits
      expect(output).toMatch(/--plugin-dir "\$SCRIPT_DIR\/\.macf\/plugin" \$MACF_CHANNELS_ARGS "\$@"/);
      // shellcheck disable is documented for the intentional unquoting
      expect(output).toContain('# shellcheck disable=SC2086');
    });
  });

  describe('MACF_LOG_PATH forensic-log fallback (macf#632)', () => {
    it('exports MACF_LOG_PATH with a ${VAR:-default} fallback to the agent HOME / XDG state, not the repo (macf#642)', () => {
      const output = generateClaudeSh(sampleConfig);
      expect(output).toContain(
        'export MACF_LOG_PATH="${MACF_LOG_PATH:-${XDG_STATE_HOME:-$HOME/.local/state}/macf/TEST@code-agent/channel.log}"',
      );
      // The fallback must NOT land the log cluster inside the repo/workspace.
      expect(output).not.toContain('$SCRIPT_DIR/.claude/.macf/channel.log');
    });

    it('sets MACF_LOG_PATH AFTER the env.* source loop so env.certs wins when present', () => {
      const output = generateClaudeSh(sampleConfig);
      const sourceLoopPos = output.indexOf('for f in "$SCRIPT_DIR/.claude/.macf"/env.*');
      const logPathPos = output.indexOf('export MACF_LOG_PATH=');
      expect(sourceLoopPos).toBeGreaterThan(0);
      expect(logPathPos).toBeGreaterThan(sourceLoopPos);
    });
  });
});

describe('writeClaudeSh', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-claude-sh-test-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes claude.sh to <workspace>/claude.sh with mode 0755', () => {
    const path = writeClaudeSh(tmpRoot, sampleConfig);
    expect(path).toBe(join(tmpRoot, 'claude.sh'));
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('overwrites existing claude.sh (managed-file semantics)', () => {
    const path = join(tmpRoot, 'claude.sh');
    const { writeFileSync } = require('node:fs');
    writeFileSync(path, '# stale user edits\n', { mode: 0o644 });

    writeClaudeSh(tmpRoot, sampleConfig);

    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('stale user edits');
    expect(after).toContain('claude -c --plugin-dir "$SCRIPT_DIR/.macf/plugin" $MACF_CHANNELS_ARGS "$@" || exec claude');
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it('returns the absolute path to the written file', () => {
    const path = writeClaudeSh(tmpRoot, sampleConfig);
    expect(path.startsWith('/')).toBe(true);
    expect(path.endsWith('/claude.sh')).toBe(true);
  });
});

describe('otelTelemetryLines (kept exported as canonical pre-migration reference)', () => {
  // These tests preserve the `otelTelemetryLines` contract for any
  // downstream tooling that compared a legacy monolithic claude.sh
  // against the canonical shape. The function is no longer called from
  // generateClaudeSh; the equivalent live emission is in
  // generateEnvTelemetry (env-files.ts).

  it('emits all telemetry gates + per-signal exporters + OTLP endpoint env by default', () => {
    const lines = otelTelemetryLines(sampleConfig, {});
    const joined = lines.join('\n');
    expect(joined).toContain('export CLAUDE_CODE_ENABLE_TELEMETRY=1');
    expect(joined).toContain('export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1');
    expect(joined).toContain('export OTEL_TRACES_EXPORTER=otlp');
    expect(joined).toContain('export OTEL_METRICS_EXPORTER=otlp');
    expect(joined).toContain('export OTEL_LOGS_EXPORTER=otlp');
    expect(joined).toContain('MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-$(macf_settings_get MACF_OTEL_ENDPOINT)}"');
    expect(joined).toContain(
      'MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-http://orzech-dev-agents-monitoring.tail491af.ts.net:4318}"',
    );
    expect(joined).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-$MACF_OTEL_ENDPOINT}"');
    expect(joined).toContain('export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
    expect(joined).toContain('export OTEL_SERVICE_NAME="macf-agent-code-agent"');
    expect(joined).toContain(
      'export OTEL_RESOURCE_ATTRIBUTES="gen_ai.agent.name=code-agent,gen_ai.agent.role=code-agent,service.namespace=macf"',
    );
  });

  it('honors MACF_OTEL_ENDPOINT template-time override (bakes custom default)', () => {
    const lines = otelTelemetryLines(sampleConfig, {
      MACF_OTEL_ENDPOINT: 'http://obs.tailnet.ts.net:9999',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('MACF_OTEL_ENDPOINT="${MACF_OTEL_ENDPOINT:-http://obs.tailnet.ts.net:9999}"');
    expect(joined).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-$MACF_OTEL_ENDPOINT}"');
    // The override fully replaces the monitoring-VM default (macf#516).
    expect(joined).not.toContain('orzech-dev-agents-monitoring');
    expect(joined).not.toContain('localhost');
  });

  it('default endpoint is the dedicated monitoring VM over Tailscale on OTel-native :4318 (macf#516 — old k3d 127.0.0.1:14318 is DEAD)', () => {
    const lines = otelTelemetryLines(sampleConfig, {});
    const joined = lines.join('\n');
    expect(joined).toContain('http://orzech-dev-agents-monitoring.tail491af.ts.net:4318');
    expect(joined).not.toContain('localhost');
    expect(joined).not.toContain('127.0.0.1');
    expect(joined).not.toContain(':14318');
  });

  it('emits env-overridable form for run-time OTEL_EXPORTER_OTLP_ENDPOINT override', () => {
    const lines = otelTelemetryLines(sampleConfig, {});
    const joined = lines.join('\n');
    expect(joined).toMatch(/export OTEL_EXPORTER_OTLP_ENDPOINT="\$\{OTEL_EXPORTER_OTLP_ENDPOINT:-\$MACF_OTEL_ENDPOINT\}"/);
  });

  it('omits the block entirely when MACF_OTEL_DISABLED=1', () => {
    const lines = otelTelemetryLines(sampleConfig, { MACF_OTEL_DISABLED: '1' });
    expect(lines).toEqual([]);
  });

  it('omits the block when MACF_OTEL_DISABLED=true', () => {
    const lines = otelTelemetryLines(sampleConfig, { MACF_OTEL_DISABLED: 'true' });
    expect(lines).toEqual([]);
  });

  it('rejects shell-unsafe characters in MACF_OTEL_ENDPOINT', () => {
    const unsafe = [
      'http://host"; rm -rf /;"',
      'http://host:$(whoami)',
      'http://host:`whoami`',
      'http://host:\\n',
      'http://host\nexport MALICIOUS=1',
    ];
    for (const val of unsafe) {
      expect(() => otelTelemetryLines(sampleConfig, { MACF_OTEL_ENDPOINT: val }))
        .toThrow(/shell-unsafe/);
    }
  });
});

describe('hasManagedHeader (DR-029 / macf#623)', () => {
  it('returns true for a freshly generated launcher', () => {
    expect(hasManagedHeader(generateClaudeSh(sampleConfig))).toBe(true);
  });

  it('returns true for a worker-type generated launcher too', () => {
    const workerCfg: MacfAgentConfig = { ...sampleConfig, agent_type: 'worker' };
    expect(hasManagedHeader(generateClaudeSh(workerCfg))).toBe(true);
  });

  it('returns false for a hand-authored launcher (no managed-header)', () => {
    // Shape mirrors the framework repo's own hand-authored claude.sh:
    // bash shebang, "Launcher for ..." comment, custom -r flag, brew
    // shellenv — and crucially NO macf managed-header.
    const handAuthored = [
      '#!/bin/bash',
      '# Launcher for macf-code-agent',
      '# Generates a GitHub App token, starts tmux session, boots Claude Code.',
      'set -euo pipefail',
      'CLAUDE_BIN="${CLAUDE_BIN:-claude}"',
      'exec "$CLAUDE_BIN" "$@"',
      '',
    ].join('\n');
    expect(hasManagedHeader(handAuthored)).toBe(false);
  });

  it('returns false for empty content', () => {
    expect(hasManagedHeader('')).toBe(false);
  });

  it('detects the managed-header anywhere in the content (not only at the top)', () => {
    // The check is substring-based, so a managed launcher with extra
    // leading lines still detects as managed.
    const content = `#!/usr/bin/env bash\nset -euo pipefail\n# This file is managed by \`macf\`. Do not edit directly\n`;
    expect(hasManagedHeader(content)).toBe(true);
  });
});
