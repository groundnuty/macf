/**
 * Preflight looks tools up on the PATH the watchdog really has: the PATH its cron
 * script exports when one is installed, the login-shell PATH otherwise.
 * The first group runs the real probe script under sh with a temporary HOME.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentHostChecks, buildProbeScript } from '../../src/cli/bootstrap/preflight-agent-host.js';
import type { PreflightDeps } from '../../src/cli/bootstrap/preflight.js';

const FLEET = { owner: 'acme', project: 'demo' };
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function home(cronPath: string | undefined): string {
  const h = mkdtempSync(join(tmpdir(), 'wd-path-'));
  dirs.push(h);
  if (cronPath !== undefined) {
    mkdirSync(join(h, '.macf', 'cron'), { recursive: true });
    writeFileSync(join(h, '.macf', 'cron', 'acme__demo.sh'), `#!/bin/sh\n# marker\nPATH='${cronPath}'; export PATH\nexec macf\n`);
  }
  return h;
}

function probe(h: string): Map<string, string> {
  const r = spawnSync('sh', ['-s'], { input: buildProbeScript(FLEET), env: { ...process.env, HOME: h }, encoding: 'utf-8' });
  const out = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const [k, ...rest] = line.split('|');
    if (k) out.set(k, rest.join('|'));
  }
  return out;
}

describe('the probe script', () => {
  it('reports a tool missing when the cron script PATH lacks its directory, though the login shell has it', () => {
    const h = home('/nonexistent-dir');
    const out = probe(h);
    expect(out.get('source')).toContain('cron|');
    expect(out.get('git')).not.toMatch(/^login\|/);
  });

  it('uses the login shell when there is no cron script', () => {
    const out = probe(home(undefined));
    expect(out.get('source')).toBe('login|');
    expect(out.get('git')).toMatch(/^login\|git version/);
  });

  it('handles a PATH value with spaces', () => {
    const h = home(undefined);
    const bin = join(h, 'with space');
    mkdirSync(bin);
    writeFileSync(join(bin, 'jq'), '#!/bin/sh\necho jq-9.9\n');
    chmodSync(join(bin, 'jq'), 0o755);
    mkdirSync(join(h, '.macf', 'cron'), { recursive: true });
    writeFileSync(join(h, '.macf', 'cron', 'acme__demo.sh'), `#!/bin/sh\nPATH='${bin}:/usr/bin:/bin'; export PATH\n`);
    const out = probe(h);
    expect(out.get('jq')).toBe('login|jq-9.9');
  });
});

describe('the details name the PATH that was tested', () => {
  const run = async (stdout: string) => {
    const deps = { exec: async () => ({ code: 0, stdout, stderr: '' }) } as unknown as PreflightDeps;
    return agentHostChecks(deps, undefined, FLEET);
  };
  it('names the cron script when one was read', async () => {
    const checks = await run('source|cron|/home/u/.macf/cron/acme__demo.sh\ngit|login|git version 2.43.0\njq|none|\n');
    expect(checks.find((c) => c.id === 'agent-host-git')?.detail).toContain("on the watchdog's PATH (from /home/u/.macf/cron/acme__demo.sh)");
    expect(checks.find((c) => c.id === 'agent-host-jq')?.detail).toContain("not on the watchdog's PATH");
  });
  it('names the login shell when there is no script', async () => {
    const checks = await run('source|login|\ngit|login|git version 2.43.0\n');
    expect(checks.find((c) => c.id === 'agent-host-git')?.detail).toContain('on the login-shell PATH, which install-cron captures when run as §3.6 says');
  });
  it('still flags a tool found only by an interactive shell', async () => {
    const checks = await run('source|cron|/x.sh\nmacf|interactive|\n');
    expect(checks.find((c) => c.id === 'agent-host-macf')?.status).toBe('wrong');
  });
});
