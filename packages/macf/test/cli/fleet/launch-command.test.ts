import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchInnerCommand, ORCHESTRATOR_IDENTITY_ENV_KEYS } from '../../../src/cli/fleet/launch-command.js';

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
    execFileSync('sh', ['-c', launchInnerCommand(dir)], { env: { PATH: process.env['PATH'] ?? '', ...leaked } });
    const seen = execFileSync('cat', [out], { encoding: 'utf8' });
    for (const k of ORCHESTRATOR_IDENTITY_ENV_KEYS) expect(seen).not.toMatch(new RegExp(`^${k}=`, 'm'));
    expect(seen).toMatch(/^MACF_NO_TMUX_WRAP=1$/m);
  });
});
