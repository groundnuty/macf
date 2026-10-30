/**
 * Preflight looks tools up on the PATH the watchdog really has: the PATH its cron
 * script exports when one is installed, the login-shell PATH otherwise.
 * The first group runs the real probe script under sh with a temporary HOME.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentHostChecks, buildProbeScript, CRON_ENV_EXTRACT_SH } from '../../src/cli/bootstrap/preflight-agent-host.js';
import { buildCronScript, cronEnvironmentLines } from '../../src/cli/commands/fleet-install-cron.js';
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

  it('keeps HOME under the watchdog PATH, as cron does', () => {
    const h = home(undefined);
    const bin = join(h, 'bin');
    mkdirSync(bin);
    writeFileSync(join(h, 'marker'), 'x');
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ -f "$HOME/marker" ] && echo gh-token\nexit 0\n');
    chmodSync(join(bin, 'gh'), 0o755);
    mkdirSync(join(h, '.macf', 'cron'), { recursive: true });
    writeFileSync(join(h, '.macf', 'cron', 'acme__demo.sh'), `#!/bin/sh\nPATH='${bin}:/usr/bin:/bin'; export PATH\n`);
    const out = probe(h);
    expect(out.get('source')).toContain('cron|');
    expect(out.get('gh-token')).toBe('login|installed');
  });
});

function writeScript(h: string, body: string): void {
  mkdirSync(join(h, '.macf', 'cron'), { recursive: true });
  writeFileSync(join(h, '.macf', 'cron', 'acme__demo.sh'), body);
}

describe('the probe replays the script environment lines', () => {
  it('sees a tool the prelude puts on PATH', () => {
    const h = home(undefined);
    const bin = join(h, 'pbin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'jq'), '#!/bin/sh\necho jq-7.7\n');
    chmodSync(join(bin, 'jq'), 0o755);
    const prelude = join(h, 'prelude.sh');
    writeFileSync(prelude, `PATH="${bin}:$PATH"; export PATH\n`);
    writeScript(h, buildCronScript({ macfPath: '/x/macf', installPath: '/usr/bin:/bin', preludePath: prelude, tokenPrefix: '', reconcileFlags: [], marker: '# m' }));
    const out = probe(h);
    expect(out.get('source')).toContain('cron|');
    expect(out.get('jq')).toBe('login|jq-7.7');
  });

  it('never runs the token line or the exec line', () => {
    const h = home(undefined);
    const marker = join(h, 'token-ran');
    const execMarker = join(h, 'exec-ran');
    const helper = join(h, 'helper.sh');
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\necho ghs_x\n`);
    chmodSync(helper, 0o755);
    const macf = join(h, 'macf');
    writeFileSync(macf, `#!/bin/sh\ntouch '${execMarker}'\n`);
    chmodSync(macf, 0o755);
    writeScript(h, buildCronScript({ macfPath: macf, installPath: '/usr/bin:/bin', preludePath: join(h, 'none.sh'), tokenPrefix: `GH_TOKEN=$('${helper}') || exit 1; export GH_TOKEN; `, reconcileFlags: [], marker: '# m' }));
    const out = probe(h);
    expect(out.get('source')).toContain('cron|');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(execMarker)).toBe(false);
  });

  it('extracts exactly the generator environment lines', () => {
    for (const tokenPrefix of ['', "GH_TOKEN=$('/h/macf-gh-token.sh') || exit 1; export GH_TOKEN; "]) {
      const parts = { macfPath: '/x/macf', installPath: '/usr/local/bin:/usr/bin', preludePath: '/p/prelude.sh', tokenPrefix, reconcileFlags: ['--yes'], marker: '# m' };
      const h = home(undefined);
      writeScript(h, buildCronScript(parts));
      const f = join(h, '.macf', 'cron', 'acme__demo.sh');
      const r = spawnSync('sh', ['-c', `f='${f}'\n${CRON_ENV_EXTRACT_SH}\nprintf '%s' "$cronenv"`], { encoding: 'utf-8' });
      expect(r.stdout).toBe(cronEnvironmentLines(parts).join('\n'));
      expect(r.stdout).not.toContain('GH_TOKEN');
      expect(r.stdout).not.toContain('exec');
    }
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
