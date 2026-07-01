/**
 * Tests for `scripts/check-channel-alive.sh` — the SessionStart +
 * UserPromptSubmit guard that probes THIS agent's own channel-server
 * `/health` endpoint over mTLS and warns LOUDLY into the agent's context
 * when it does not respond. groundnuty/macf#734 (the missing detect-half:
 * check-channels-enabled.sh (#633) asserts native-push is ENABLED for the
 * session; this hook asserts the channel-server PROCESS is still alive).
 *
 * Hook contract: JSON on stdin; STDOUT is injected into the agent's context
 * on exit 0. OBSERVATIONAL + NON-BLOCKING — the script ALWAYS exits 0 (fail
 * open on a missing log, missing certs, missing curl, or any internal
 * error). Override: MACF_SKIP_CHANNEL_ALIVE_CHECK=1.
 *
 * The hook locates its own endpoint by reading the NEWEST `server_started`
 * JSONL line back from its own channel.log (host/port), then curls
 * `/health` over mTLS using MACF_CA_CERT/MACF_AGENT_CERT/MACF_AGENT_KEY.
 * These tests fake that layout under a temp HOME + temp workspace, and
 * stub `curl` via a PATH-prepended shim (mirrors check-close-keyword.test.ts
 * / check-lgtm-gate.test.ts's external-binary stubbing convention) so no
 * real network/TLS is involved.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'scripts', 'check-channel-alive.sh');

/**
 * Build a directory with a stub `curl` shim that mimics
 * `curl -sS -o <file> -w '%{http_code}' -m <t> --cacert ... --cert ... --key ... <url>`:
 * writes `body` to the `-o` target (if any) and prints `httpCode` to stdout
 * (curl's `-w` behavior, no trailing newline). When `fail` is set, exits
 * non-zero without printing anything (simulates connection refused/timeout/
 * TLS failure — real curl prints "000" in that case too, which the hook's
 * `|| echo "000"` fallback also covers).
 */
function makeStubCurlDir(opts: { readonly httpCode?: string; readonly body?: string; readonly fail?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'macf-chanalive-stub-curl-'));
  const httpCode = opts.httpCode ?? '200';
  const body = opts.body ?? '{}';
  const script = opts.fail
    ? `#!/usr/bin/env bash\nexit 7\n`
    : `#!/usr/bin/env bash
outfile=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then outfile="$arg"; fi
  prev="$arg"
done
if [ -n "$outfile" ]; then
  printf '%s' '${body}' > "$outfile"
fi
printf '%s' '${httpCode}'
exit 0
`;
  const curlPath = join(dir, 'curl');
  writeFileSync(curlPath, script);
  chmodSync(curlPath, 0o755);
  return dir;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runHook(opts: {
  /** Fields for a `server_started` JSONL line; `undefined` → no channel.log at all. */
  readonly serverStarted?: { readonly port: number; readonly host: string; readonly instanceId?: string };
  /** Curl stub behavior; `undefined` → no `curl` on PATH at all (simulates missing binary). */
  readonly curl?: { readonly httpCode?: string; readonly body?: string; readonly fail?: boolean };
  /** When false, certs are NOT created (simulates missing/unreadable cert paths). Default true. */
  readonly certsPresent?: boolean;
  /** Pre-seed the throttle timestamp file with this many seconds ago (epoch offset). */
  readonly throttleStampSecondsAgo?: number;
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: string;
}): RunResult {
  const fakeHome = mkdtempSync(join(tmpdir(), 'macf-chanalive-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'macf-chanalive-ws-'));

  let logPath: string | undefined;
  if (opts.serverStarted) {
    const chanDir = join(fakeHome, '.local', 'state', 'macf', 'testproj@test-agent');
    mkdirSync(chanDir, { recursive: true });
    logPath = join(chanDir, 'channel.log');
    const line = JSON.stringify({
      ts: '2026-07-01T09:00:01.000Z',
      level: 'info',
      event: 'server_started',
      port: opts.serverStarted.port,
      host: opts.serverStarted.host,
      agent: 'test-agent',
      type: 'permanent',
      instance_id: opts.serverStarted.instanceId ?? 'abc123',
      pid: 4242,
      version: '0.2.47',
    });
    writeFileSync(logPath, line + '\n');
  }

  const certsPresent = opts.certsPresent ?? true;
  const certDir = join(fakeHome, 'certs');
  let caCert: string | undefined;
  let agentCert: string | undefined;
  let agentKey: string | undefined;
  if (certsPresent) {
    mkdirSync(certDir, { recursive: true });
    caCert = join(certDir, 'ca.pem');
    agentCert = join(certDir, 'cert.pem');
    agentKey = join(certDir, 'key.pem');
    writeFileSync(caCert, 'fake-ca');
    writeFileSync(agentCert, 'fake-cert');
    writeFileSync(agentKey, 'fake-key');
  }

  if (opts.throttleStampSecondsAgo !== undefined) {
    const dir = join(workspace, '.claude', '.macf');
    mkdirSync(dir, { recursive: true });
    const stamp = Math.floor(Date.now() / 1000) - opts.throttleStampSecondsAgo;
    writeFileSync(join(dir, '.channel-alive-last-check'), String(stamp));
  }

  const basePath = process.env['PATH'] ?? '';
  let path = `/usr/bin:/bin:${basePath}`;
  let stubDir: string | undefined;
  if (opts.curl) {
    stubDir = makeStubCurlDir(opts.curl);
    path = `${stubDir}:${path}`;
  }

  const cleanEnv: Record<string, string> = {
    PATH: path,
    HOME: fakeHome,
    CLAUDE_PROJECT_DIR: workspace,
    MACF_CHANNEL_ALIVE_THROTTLE_SECS: '300',
  };
  if (logPath) cleanEnv['MACF_LOG_PATH'] = logPath;
  if (caCert) cleanEnv['MACF_CA_CERT'] = caCert;
  if (agentCert) cleanEnv['MACF_AGENT_CERT'] = agentCert;
  if (agentKey) cleanEnv['MACF_AGENT_KEY'] = agentKey;
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete cleanEnv[k];
      else cleanEnv[k] = v;
    }
  }

  try {
    const res = spawnSync('bash', [HOOK_SCRIPT], {
      input: opts.stdin ?? JSON.stringify({ session_id: 'sess-x', hook_event_name: 'SessionStart' }),
      env: cleanEnv,
      encoding: 'utf-8',
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe('check-channel-alive.sh (SessionStart + UserPromptSubmit guard)', () => {
  describe('(a) channel-server DEAD/unreachable → LOUD warning, exit 0', () => {
    it('curl reports connection failure (fail) → warns DEAD + exits 0', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { fail: true },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('YOUR CHANNEL-SERVER IS DEAD');
      expect(r.stdout).toContain('macf#734');
      expect(r.stdout).toContain('DEAF');
      expect(r.stdout).toContain('no pings = nothing to do');
      expect(r.stdout).toContain('TELL THE OPERATOR');
      expect(r.stdout).toContain('coordination.md');
    });

    it('curl responds with a non-2xx status (503) → warns DEAD + exits 0', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { httpCode: '503' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('YOUR CHANNEL-SERVER IS DEAD');
      expect(r.stdout).toContain('503');
    });
  });

  describe('(b) channel-server ALIVE (2xx) → silent, exit 0', () => {
    it('curl responds 200 → prints nothing + exits 0', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { httpCode: '200', body: JSON.stringify({ status: 'online', instance_id: 'abc123' }) },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('curl responds 204 → still counts as alive (2xx range) → silent', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { httpCode: '204' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('(c) throttle', () => {
    it('a RECENT throttle stamp on a non-SessionStart event → skips the probe entirely (silent, no curl)', () => {
      // curl is configured to FAIL if invoked — if the throttle didn't skip
      // the probe, this would produce a LOUD warning. Silence proves curl
      // was never called.
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { fail: true },
        throttleStampSecondsAgo: 10, // well within the 300s window
        stdin: JSON.stringify({ session_id: 'sess-x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('an EXPIRED throttle stamp on a non-SessionStart event → probes anyway', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { fail: true },
        throttleStampSecondsAgo: 10_000, // well past the 300s window
        stdin: JSON.stringify({ session_id: 'sess-x', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('YOUR CHANNEL-SERVER IS DEAD');
    });

    it('SessionStart ALWAYS probes even with a fresh throttle stamp', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { fail: true },
        throttleStampSecondsAgo: 10, // fresh — would normally throttle
        stdin: JSON.stringify({ session_id: 'sess-x', hook_event_name: 'SessionStart' }),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('YOUR CHANNEL-SERVER IS DEAD');
    });
  });

  describe('(d) fail-open paths → silent exit 0, never a false alarm', () => {
    it('no channel.log at all (endpoint undeterminable) → silent exit 0', () => {
      const r = runHook({ curl: { fail: true } }); // no serverStarted → no log created
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('channel.log present but no server_started line → silent exit 0', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'macf-chanalive-home2-'));
      const workspace = mkdtempSync(join(tmpdir(), 'macf-chanalive-ws2-'));
      const chanDir = join(fakeHome, '.local', 'state', 'macf', 'testproj@test-agent');
      mkdirSync(chanDir, { recursive: true });
      const logPath = join(chanDir, 'channel.log');
      writeFileSync(logPath, JSON.stringify({ ts: 'x', level: 'info', event: 'forensic_log_active' }) + '\n');
      const res = spawnSync('bash', [HOOK_SCRIPT], {
        input: JSON.stringify({ hook_event_name: 'SessionStart' }),
        env: {
          PATH: `/usr/bin:/bin:${process.env['PATH'] ?? ''}`,
          HOME: fakeHome,
          CLAUDE_PROJECT_DIR: workspace,
          MACF_LOG_PATH: logPath,
        },
        encoding: 'utf-8',
      });
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      expect(res.status).toBe(0);
      expect((res.stdout ?? '').trim()).toBe('');
    });

    it('certs missing/unreadable → silent exit 0 (never a false alarm)', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { fail: true },
        certsPresent: false,
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('curl binary missing entirely → silent exit 0', () => {
      // A naive PATH of "/usr/bin:/bin" is NOT sufficient to simulate "curl is
      // absent" — curl is commonly installed at /usr/bin/curl AND /bin/curl
      // directly (not just under a package-manager prefix), so this test
      // builds a PATH containing symlinks to every coreutil the hook needs
      // EXCEPT curl, proving `command -v curl` genuinely fails.
      const fakeHome = mkdtempSync(join(tmpdir(), 'macf-chanalive-home3-'));
      const workspace = mkdtempSync(join(tmpdir(), 'macf-chanalive-ws3-'));
      const chanDir = join(fakeHome, '.local', 'state', 'macf', 'testproj@test-agent');
      mkdirSync(chanDir, { recursive: true });
      const logPath = join(chanDir, 'channel.log');
      writeFileSync(
        logPath,
        JSON.stringify({ ts: 'x', level: 'info', event: 'server_started', port: 8899, host: '127.0.0.1' }) + '\n',
      );
      const certDir = join(fakeHome, 'certs');
      mkdirSync(certDir, { recursive: true });
      const caCert = join(certDir, 'ca.pem');
      const agentCert = join(certDir, 'cert.pem');
      const agentKey = join(certDir, 'key.pem');
      writeFileSync(caCert, 'fake-ca');
      writeFileSync(agentCert, 'fake-cert');
      writeFileSync(agentKey, 'fake-key');

      const noCurlDir = mkdtempSync(join(tmpdir(), 'macf-chanalive-nocurl-'));
      for (const bin of ['bash', 'sh', 'cat', 'sed', 'grep', 'tail', 'date', 'ls', 'mkdir', 'mktemp', 'rm']) {
        const resolved = spawnSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf-8' }).stdout.trim();
        if (resolved) {
          try {
            symlinkSync(resolved, join(noCurlDir, bin));
          } catch {
            // ignore duplicate-symlink races; not expected in a fresh temp dir
          }
        }
      }

      const res = spawnSync('bash', [HOOK_SCRIPT], {
        input: JSON.stringify({ hook_event_name: 'SessionStart' }),
        env: {
          PATH: noCurlDir,
          HOME: fakeHome,
          CLAUDE_PROJECT_DIR: workspace,
          MACF_LOG_PATH: logPath,
          MACF_CA_CERT: caCert,
          MACF_AGENT_CERT: agentCert,
          MACF_AGENT_KEY: agentKey,
        },
        encoding: 'utf-8',
      });
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(noCurlDir, { recursive: true, force: true });

      // Sanity-check the premise: curl must genuinely be unresolvable on
      // this PATH, or the test below would pass for the wrong reason.
      const curlCheck = spawnSync('bash', ['-c', 'command -v curl'], {
        env: { PATH: noCurlDir },
        encoding: 'utf-8',
      });
      expect(curlCheck.status).not.toBe(0);

      expect(res.status).toBe(0);
      expect((res.stdout ?? '').trim()).toBe('');
    });

    it('malformed / empty stdin → still exits 0 (never blocks the turn/session)', () => {
      const r1 = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { httpCode: '200' },
        stdin: 'not json {{{',
      });
      expect(r1.status).toBe(0);
      const r2 = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { httpCode: '200' },
        stdin: '',
      });
      expect(r2.status).toBe(0);
    });
  });

  describe('(e) MACF_SKIP_CHANNEL_ALIVE_CHECK=1 → no-op even when dead', () => {
    it('skips the check entirely (no warning) + exits 0', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { fail: true },
        env: { MACF_SKIP_CHANNEL_ALIVE_CHECK: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('(f) exit code is 0 in ALL cases', () => {
    it('exits 0 across dead / alive / fail-open / skip', () => {
      const cases: { readonly name: string; readonly opts: Parameters<typeof runHook>[0] }[] = [
        { name: 'dead', opts: { serverStarted: { port: 8899, host: '127.0.0.1' }, curl: { fail: true } } },
        { name: 'alive', opts: { serverStarted: { port: 8899, host: '127.0.0.1' }, curl: { httpCode: '200' } } },
        { name: 'no log', opts: {} },
        { name: 'skip', opts: { serverStarted: { port: 8899, host: '127.0.0.1' }, curl: { fail: true }, env: { MACF_SKIP_CHANNEL_ALIVE_CHECK: '1' } } },
        { name: 'no CLAUDE_PROJECT_DIR', opts: { env: { CLAUDE_PROJECT_DIR: undefined } } },
      ];
      for (const c of cases) {
        expect(runHook(c.opts).status, `case: ${c.name}`).toBe(0);
      }
    });
  });
});
