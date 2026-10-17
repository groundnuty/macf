import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchInnerCommand, ORCHESTRATOR_IDENTITY_ENV_KEYS, shellQuote } from '../../../src/cli/fleet/launch-command.js';

describe('launchInnerCommand', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('runs claude.sh with no inherited identity and with MACF_NO_TMUX_WRAP=1 (macf#763)', () => {
    dir = mkdtempSync(join(tmpdir(), 'launch-cmd-'));
    const out = join(dir, 'env.out');
    writeFileSync(join(dir, 'claude.sh'), `#!/bin/sh\nenv > "${out}"\n`);
    chmodSync(join(dir, 'claude.sh'), 0o755);
    const leaked: Record<string, string> = {};
    for (const k of ORCHESTRATOR_IDENTITY_ENV_KEYS) leaked[k] = `leaked-${k}`;
    execFileSync('sh', ['-c', launchInnerCommand(shellQuote(dir))], { env: { PATH: process.env['PATH'] ?? '', ...leaked } });
    const seen = execFileSync('cat', [out], { encoding: 'utf8' });
    for (const k of ORCHESTRATOR_IDENTITY_ENV_KEYS) expect(seen).not.toMatch(new RegExp(`^${k}=`, 'm'));
    expect(seen).toMatch(/^MACF_NO_TMUX_WRAP=1$/m);
  });

  it("keeps a workspace path literal: $, backticks and quotes are not expanded", () => {
    dir = mkdtempSync(join(tmpdir(), 'launch-cmd-'));
    const ws = join(dir, "it's $HOME `x`");
    mkdirSync(ws);
    const out = join(dir, 'ran');
    writeFileSync(join(ws, 'claude.sh'), `#!/bin/sh\necho ok > "${out}"\n`);
    chmodSync(join(ws, 'claude.sh'), 0o755);
    execFileSync('sh', ['-c', launchInnerCommand(shellQuote(ws))], { env: { PATH: process.env['PATH'] ?? '', HOME: '/nonexistent' } });
    expect(execFileSync('cat', [out], { encoding: 'utf8' }).trim()).toBe('ok');
  });
});
