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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCliPackageRoot } from '../../src/cli/rules.js';

const HOOK_SCRIPT = join(findCliPackageRoot(), 'plugin', 'scripts', 'check-channel-alive.sh');

/** One stubbed curl response: either a `fail` (connection failure, exit 7,
 * mirrors what a real refused/timeout/TLS-error curl invocation does) or an
 * HTTP code + body. */
interface CurlResponseSpec {
  readonly httpCode?: string;
  readonly body?: string;
  readonly fail?: boolean;
}

/**
 * Spawn a long-lived, real OS process whose pid stays alive for the
 * duration of a test AND whose `/proc/<pid>/cmdline` contains
 * "macf-channel-server" — satisfying BOTH halves of the hook's live-pid
 * predicate (macf#760: `kill -0` succeeds AND, where `/proc` is readable
 * as it is on this Linux test host, the cmdline substring-matches).
 *
 * Spawns THIS test process's own `node` binary with an idle event-loop
 * keeper (`setInterval`) plus a trailing marker argument — `/proc/<pid>/
 * cmdline` reflects the raw execve argv regardless of whether node's own
 * arg-parsing "uses" that trailing argument, so the marker shows up
 * unconditionally. Deliberately NOT `bash -c 'exec -a NAME sleep infinity'`
 * (the first approach tried): under this repo's devbox/Nix toolchain,
 * `sleep` resolves to a multi-call coreutils binary that dispatches on
 * `argv[0]` — `exec -a` spoofing argv[0] away from "sleep" makes it print
 * `coreutils: unknown program 'NAME'` and exit immediately, so the
 * "alive" process was actually already dead by the time any test ran.
 * Spawning node directly sidesteps that class of problem entirely (node's
 * own binary isn't a multi-call dispatcher).
 */
function spawnFakeChannelServerProcess(): { readonly pid: number; readonly stop: () => void } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);', '--', 'macf-channel-server-marker'], {
    stdio: 'ignore',
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('failed to spawn fake channel-server stub process for test');
  }
  return {
    pid,
    stop: () => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already exited — fine, nothing to clean up
      }
    },
  };
}

/**
 * Spawn a real, alive OS process whose `/proc/<pid>/cmdline` does NOT
 * look like a channel-server — used to prove the pid-reuse guard (macf#760)
 * rejects an alive-but-wrong-shaped pid rather than trusting `kill -0` alone.
 */
function spawnPlainAliveProcess(): { readonly pid: number; readonly stop: () => void } {
  const child = spawn('sleep', ['infinity'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('failed to spawn plain alive process for test');
  }
  return {
    pid,
    stop: () => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already exited — fine
      }
    },
  };
}

// One shared fake-alive-and-channel-server-shaped pid for the whole file —
// used as the DEFAULT `pid` for any `server_started` fixture line that
// doesn't explicitly override it, so every pre-existing test in this file
// (which predates macf#760 and never specified a pid) keeps exercising the
// SAME branch it always did (a genuinely live, correctly-shaped pid) rather
// than tripping the NEW no-live-pid fail-open path by accident.
let fakeChannelServerProcess: { readonly pid: number; readonly stop: () => void };

beforeAll(() => {
  fakeChannelServerProcess = spawnFakeChannelServerProcess();
});

afterAll(() => {
  fakeChannelServerProcess?.stop();
});

/** A pid that is guaranteed to NOT exist (Linux default pid_max is far below this). */
const DEAD_PID = 2147480000;

/**
 * Build a directory with a stub `curl` shim that mimics
 * `curl -sS -o <file> -w '%{http_code}' -m <t> --cacert ... --cert ... --key ... <url>`:
 * writes `body` to the `-o` target (if any) and prints `httpCode` to stdout
 * (curl's `-w` behavior, no trailing newline). When `fail` is set, exits
 * non-zero without printing anything (simulates connection refused/timeout/
 * TLS failure — real curl prints "000" in that case too, which the hook's
 * `|| echo "000"` fallback also covers).
 *
 * `portOverrides` (macf#760 regression coverage): per-port entries override
 * the sequence-based behavior below for that specific port — used to prove
 * WHICH port the hook actually probed when several `server_started`
 * generations are in play. Unlisted ports fall through to the `responses`
 * sequence (or single fixed response) described next.
 *
 * `responses` (groundnuty/macf#765 retry-before-DEAD tests need to simulate
 * "fails N times then succeeds" / "fails exactly N times total"): each
 * invocation of the stub reads-and-increments a `.call-count` file to learn
 * its own call index, then serves the corresponding entry (clamping to the
 * last entry for any calls beyond the configured sequence, so a probe-count
 * higher than expected degrades to "keep returning the last configured
 * outcome" rather than crashing the stub). The single-response `{ httpCode,
 * body, fail }` shape (no `responses`) remains supported — it's sugar for a
 * one-element sequence repeated for every call.
 *
 * EVERY invocation — whether resolved via `portOverrides` or the `responses`
 * sequence — is logged to `<dir>/curl.calls.log` (one URL per line, always,
 * regardless of which path decided the response). That log is therefore the
 * single source of both the port-selection proof (macf#760's `curlUrls`) AND
 * the call-count proof (macf#765's `curlCallCount`, which the test harness
 * derives as `curlUrls.length`).
 */
function makeStubCurlDir(
  opts: CurlResponseSpec & {
    readonly portOverrides?: Readonly<Record<number, { readonly httpCode?: string; readonly fail?: boolean }>>;
    readonly responses?: readonly CurlResponseSpec[];
  },
): { readonly dir: string; readonly callsLogPath: string } {
  const responses: readonly CurlResponseSpec[] =
    opts.responses && opts.responses.length > 0 ? opts.responses : [{ httpCode: opts.httpCode, body: opts.body, fail: opts.fail }];
  const dir = mkdtempSync(join(tmpdir(), 'macf-chanalive-stub-curl-'));
  const callsLogPath = join(dir, 'curl.calls.log');
  const countFile = join(dir, '.call-count');
  writeFileSync(countFile, '0');
  responses.forEach((r, i) => {
    if (r.fail) {
      writeFileSync(join(dir, `fail-${i}`), '1');
    } else {
      writeFileSync(join(dir, `code-${i}`), r.httpCode ?? '200');
      writeFileSync(join(dir, `body-${i}`), r.body ?? '{}');
    }
  });
  const lastIndex = responses.length - 1;

  const overrideCases = Object.entries(opts.portOverrides ?? {})
    .map(([port, behavior]) =>
      behavior.fail
        ? `    ${port}) exit 7 ;;`
        : `    ${port}) printf '%s' '${behavior.httpCode ?? '200'}'; exit 0 ;;`,
    )
    .join('\n');

  const script = `#!/usr/bin/env bash
url="\${@: -1}"
printf '%s\\n' "$url" >> '${callsLogPath}'

n=$(cat "${countFile}" 2>/dev/null || echo 0)
idx=$n
if [ "$idx" -gt ${lastIndex} ]; then idx=${lastIndex}; fi
echo $((n + 1)) > "${countFile}"

port="$(printf '%s' "$url" | sed -n 's#.*:\\([0-9]*\\)/health#\\1#p')"
case "$port" in
${overrideCases}
esac

if [ -f "${dir}/fail-$idx" ]; then
  exit 7
fi

outfile=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then outfile="$arg"; fi
  prev="$arg"
done
if [ -n "$outfile" ] && [ -f "${dir}/body-$idx" ]; then
  cp "${dir}/body-$idx" "$outfile"
fi
if [ -f "${dir}/code-$idx" ]; then
  cat "${dir}/code-$idx"
else
  printf '%s' '200'
fi
exit 0
`;
  const curlPath = join(dir, 'curl');
  writeFileSync(curlPath, script);
  chmodSync(curlPath, 0o755);
  return { dir, callsLogPath };
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Every `/health` URL the stub `curl` was invoked with, in call order (macf#760 port-selection proof). Empty if `curl` was never invoked or wasn't stubbed. */
  readonly curlUrls: readonly string[];
  /** Number of times the stubbed curl was invoked — derived from `curlUrls.length` (groundnuty/macf#765 retry-count assertions). `undefined` when no stub was configured. */
  readonly curlCallCount?: number;
}

interface ServerStartedSpec {
  readonly port: number;
  readonly host: string;
  readonly instanceId?: string;
  /** Defaults to a real, alive, channel-server-shaped pid (see `fakeChannelServerProcess` above) — matching every pre-#760 test's implicit assumption that the hook actually probes. Override to test dead/pid-reuse scenarios. */
  readonly pid?: number;
}

function runHook(opts: {
  /** Fields for a SINGLE `server_started` JSONL line; `undefined` → no channel.log at all. Mutually exclusive with `serverStartedLines` (which wins if both given). */
  readonly serverStarted?: ServerStartedSpec;
  /** Fields for MULTIPLE `server_started` JSONL lines, written oldest → newest in array order — the shape of a channel.log spanning several relaunch generations (macf#760). */
  readonly serverStartedLines?: readonly ServerStartedSpec[];
  /** Curl stub behavior; `undefined` → no `curl` on PATH at all (simulates missing binary). Accepts a single fixed response, a per-port `portOverrides` map (macf#760 port-selection proof), and/or a `responses` SEQUENCE (groundnuty/macf#765 retry-before-DEAD tests) — see `makeStubCurlDir`. */
  readonly curl?: CurlResponseSpec & {
    readonly portOverrides?: Readonly<Record<number, { readonly httpCode?: string; readonly fail?: boolean }>>;
    readonly responses?: readonly CurlResponseSpec[];
  };
  /** When false, certs are NOT created (simulates missing/unreadable cert paths). Default true. */
  readonly certsPresent?: boolean;
  /** Pre-seed the throttle timestamp file with this many seconds ago (epoch offset). */
  readonly throttleStampSecondsAgo?: number;
  /** When a `server_started` fixture was written, whether to export
   *  MACF_LOG_PATH pointing at it (the primary locator). Default true. Set
   *  false to exercise the macf#887 identity-derivation fallback
   *  (MACF_PROJECT/MACF_AGENT_NAME) or the identity-unknown path instead. */
  readonly exportLogPathEnv?: boolean;
  /** MACF_PROJECT / MACF_AGENT_NAME to export — the identity pair the
   *  macf#887 fallback derives this agent's own log path from. `undefined` for
   *  either half → that half is left unset (both required to derive). */
  readonly identityEnv?: { readonly project?: string; readonly agentName?: string };
  /** Extra `server_started` channel.log fixtures under OTHER `<project>@<agent>`
   *  dirs — never this agent's own — used to prove the macf#887 fix does not
   *  fall back to probing a cross-agent glob's peer server. */
  readonly peerChannelLogs?: readonly { readonly dir: string; readonly spec: ServerStartedSpec }[];
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: string;
}): RunResult {
  const fakeHome = mkdtempSync(join(tmpdir(), 'macf-chanalive-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'macf-chanalive-ws-'));

  let logPath: string | undefined;
  const lineSpecs = opts.serverStartedLines ?? (opts.serverStarted ? [opts.serverStarted] : undefined);
  if (lineSpecs && lineSpecs.length > 0) {
    const chanDir = join(fakeHome, '.local', 'state', 'macf', 'testproj@test-agent');
    mkdirSync(chanDir, { recursive: true });
    logPath = join(chanDir, 'channel.log');
    const lines = lineSpecs.map((spec) =>
      JSON.stringify({
        ts: '2026-07-01T09:00:01.000Z',
        level: 'info',
        event: 'server_started',
        port: spec.port,
        host: spec.host,
        agent: 'test-agent',
        type: 'permanent',
        instance_id: spec.instanceId ?? 'abc123',
        pid: spec.pid ?? fakeChannelServerProcess.pid,
        version: '0.2.47',
      }),
    );
    writeFileSync(logPath, lines.join('\n') + '\n');
  }

  for (const peer of opts.peerChannelLogs ?? []) {
    const peerDir = join(fakeHome, '.local', 'state', 'macf', peer.dir);
    mkdirSync(peerDir, { recursive: true });
    const peerLine = JSON.stringify({
      ts: '2026-07-01T09:00:01.000Z',
      level: 'info',
      event: 'server_started',
      port: peer.spec.port,
      host: peer.spec.host,
      agent: 'peer-agent',
      type: 'permanent',
      instance_id: peer.spec.instanceId ?? 'peer123',
      pid: peer.spec.pid ?? fakeChannelServerProcess.pid,
      version: '0.2.47',
    });
    writeFileSync(join(peerDir, 'channel.log'), peerLine + '\n');
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
  let callsLogPath: string | undefined;
  if (opts.curl) {
    const stub = makeStubCurlDir(opts.curl);
    stubDir = stub.dir;
    callsLogPath = stub.callsLogPath;
    path = `${stubDir}:${path}`;
  }

  const cleanEnv: Record<string, string> = {
    PATH: path,
    HOME: fakeHome,
    CLAUDE_PROJECT_DIR: workspace,
    MACF_CHANNEL_ALIVE_THROTTLE_SECS: '300',
    // Retry spacing defaults to 0 in the test harness (groundnuty/macf#765
    // retry-before-DEAD adds a real delay between attempts in production;
    // tests exercise retry-COUNT semantics, not wall-clock spacing, so keep
    // the suite fast — override per-test via `env` when timing itself is
    // under test).
    MACF_CHANNEL_ALIVE_RETRY_DELAY_SECS: '0',
  };
  const exportLogPathEnv = opts.exportLogPathEnv ?? true;
  if (logPath && exportLogPathEnv) cleanEnv['MACF_LOG_PATH'] = logPath;
  if (opts.identityEnv?.project !== undefined) cleanEnv['MACF_PROJECT'] = opts.identityEnv.project;
  if (opts.identityEnv?.agentName !== undefined) cleanEnv['MACF_AGENT_NAME'] = opts.identityEnv.agentName;
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
    let curlUrls: string[] = [];
    if (callsLogPath) {
      try {
        curlUrls = readFileSync(callsLogPath, 'utf-8')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        curlUrls = [];
      }
    }
    const curlCallCount = opts.curl ? curlUrls.length : undefined;
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', curlUrls, curlCallCount };
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
    // macf#887: no serverStarted fixture AND no identity env means BOTH
    // MACF_LOG_PATH and the MACF_PROJECT/MACF_AGENT_NAME fallback are
    // unavailable — this agent's own log is genuinely unidentifiable, not
    // merely "not created yet". That distinct case now says so explicitly
    // (never silent) — see describe (i) below for the full macf#887 coverage,
    // including the sibling "identity known but file not yet present" case,
    // which DOES stay silent.
    it('no channel.log AND no identity available → identity-unknown message (not silent); still fail-open (exit 0), curl never invoked', () => {
      const r = runHook({ curl: { fail: true } }); // no serverStarted → no log created, no identityEnv
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Could not identify this agent's own channel-server log");
      expect(r.curlUrls).toHaveLength(0);
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
        // pid MUST be a genuinely live, channel-server-shaped pid (macf#760)
        // — otherwise the new live-pid selection logic fails open BEFORE
        // reaching the curl-missing check this test exists to exercise,
        // making the assertion below pass for the wrong reason.
        JSON.stringify({
          ts: 'x',
          level: 'info',
          event: 'server_started',
          port: 8899,
          host: '127.0.0.1',
          pid: fakeChannelServerProcess.pid,
        }) + '\n',
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
      // 'tr' + 'kill' added (macf#760): the new live-pid selection loop uses
      // `kill -0` (a bash builtin — doesn't need a PATH entry) and pipes
      // `/proc/<pid>/cmdline` through `tr` for the pid-reuse guard; without
      // `tr` on PATH that guard would spuriously reject a genuinely-alive,
      // correctly-shaped pid and fail open before this test's intended
      // curl-missing path is reached.
      for (const bin of ['bash', 'sh', 'cat', 'sed', 'grep', 'tail', 'date', 'ls', 'mkdir', 'mktemp', 'rm', 'tr']) {
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

  describe('(g) newest-LIVE-pid port selection — stale-newest-port trap (macf#760)', () => {
    it('LOAD-BEARING REGRESSION: selects the OLDER line whose pid is alive when the NEWEST line has a dead pid — does NOT false-alarm on the stale newest port', () => {
      // Pre-#760 behavior blindly trusted the newest `server_started` line's
      // port. Here the newest generation's pid is DEAD (relaunched away) and
      // its port would refuse the connection; the OLDER generation's pid is
      // still alive and its port answers 200. The port-aware curl stub
      // proves WHICH port was actually probed — this assertion would FAIL
      // under the pre-fix "tail -n1" heuristic (it would probe the dead
      // newest port, get refused, and print the DEAD warning).
      const OLD_PORT = 8899;
      const NEW_PORT = 8900;
      const r = runHook({
        serverStartedLines: [
          { port: OLD_PORT, host: '127.0.0.1' }, // oldest generation — alive pid (default)
          { port: NEW_PORT, host: '127.0.0.1', pid: DEAD_PID }, // newest generation — DEAD pid
        ],
        curl: {
          portOverrides: {
            [OLD_PORT]: { httpCode: '200' },
            [NEW_PORT]: { fail: true }, // would fire if the guard mistakenly probed the stale newest port
          },
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(''); // silent — proves the ALIVE (older) port was probed, not the dead newest one
      expect(r.curlUrls).toHaveLength(1);
      expect(r.curlUrls[0]).toContain(`:${OLD_PORT}/health`);
      expect(r.curlUrls[0]).not.toContain(`:${NEW_PORT}/health`);
    });

    it('selects the NEWEST line when its pid IS alive (no regression on the common/happy-path case)', () => {
      const OLD_PORT = 8901;
      const NEW_PORT = 8902;
      const r = runHook({
        serverStartedLines: [
          { port: OLD_PORT, host: '127.0.0.1', pid: DEAD_PID }, // old generation — already gone
          { port: NEW_PORT, host: '127.0.0.1' }, // current generation — alive (default)
        ],
        curl: {
          portOverrides: {
            [OLD_PORT]: { fail: true },
            [NEW_PORT]: { httpCode: '200' },
          },
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(r.curlUrls).toHaveLength(1);
      expect(r.curlUrls[0]).toContain(`:${NEW_PORT}/health`);
    });

    it('NO server_started line has a live pid → fails open silently (transient — the async MCP child hasn\'t logged yet), curl is NEVER invoked', () => {
      const r = runHook({
        serverStartedLines: [
          { port: 8903, host: '127.0.0.1', pid: DEAD_PID },
          { port: 8904, host: '127.0.0.1', pid: DEAD_PID + 1 },
        ],
        // portOverrides: {} forces the call-logging stub variant (rather
        // than the old bare-exit-7 variant) so ANY invocation — matched
        // port or not — would show up in curlUrls. Length 0 below proves
        // curl was never invoked at all, not merely that it "failed".
        curl: { portOverrides: {} },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(r.curlUrls).toHaveLength(0);
    });

    it('a LIVE-pid server that fails to answer /health STILL warns loudly (the true-positive hazard is preserved)', () => {
      const r = runHook({
        serverStartedLines: [{ port: 8905, host: '127.0.0.1' }], // alive pid (default)
        curl: { fail: true },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('YOUR CHANNEL-SERVER IS DEAD');
    });

    it('pid-reuse guard: an alive pid whose /proc cmdline does NOT look like a channel-server is rejected, falling back to an older properly-shaped alive line', () => {
      const plain = spawnPlainAliveProcess();
      try {
        const OLD_PORT = 8910;
        const NEWISH_PORT = 8911;
        const r = runHook({
          serverStartedLines: [
            { port: OLD_PORT, host: '127.0.0.1' }, // properly-shaped alive pid (default)
            { port: NEWISH_PORT, host: '127.0.0.1', pid: plain.pid }, // alive, but NOT a channel-server
          ],
          curl: {
            portOverrides: {
              [OLD_PORT]: { httpCode: '200' },
              [NEWISH_PORT]: { fail: true },
            },
          },
        });
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe('');
        expect(r.curlUrls).toHaveLength(1);
        expect(r.curlUrls[0]).toContain(`:${OLD_PORT}/health`);
        expect(r.curlUrls[0]).not.toContain(`:${NEWISH_PORT}/health`);
      } finally {
        plain.stop();
      }
    });
  });

  describe('(h) retry-before-DEAD (groundnuty/macf#765) — a single transient failure must NOT warn', () => {
    it('ALL probes fail (default retries=3) → warns DEAD exactly once, after exhausting all 3 attempts', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { responses: [{ fail: true }, { fail: true }, { fail: true }] },
      });
      expect(r.status).toBe(0);
      expect(r.curlCallCount).toBe(3);
      expect(r.stdout).toContain('YOUR CHANNEL-SERVER IS DEAD');
      // Exactly ONE banner — not one per failed attempt.
      expect(r.stdout.match(/YOUR CHANNEL-SERVER IS DEAD/g)?.length).toBe(1);
      expect(r.stdout).toContain('after 3 attempts');
    });

    it('ONE failure then a 2xx success → SILENT, and stops probing early (does not burn the remaining retries)', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { responses: [{ fail: true }, { httpCode: '200' }, { fail: true }] },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
      // Stopped at attempt 2 (the success) — attempt 3 (which would fail) never ran.
      expect(r.curlCallCount).toBe(2);
    });

    it('a single always-failing probe with MACF_CHANNEL_ALIVE_RETRIES=1 → warns after exactly 1 attempt', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { fail: true },
        env: { MACF_CHANNEL_ALIVE_RETRIES: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.curlCallCount).toBe(1);
      expect(r.stdout).toContain('YOUR CHANNEL-SERVER IS DEAD');
      expect(r.stdout).toContain('after 1 attempts');
    });

    it('a non-numeric MACF_CHANNEL_ALIVE_RETRIES falls back to the default (3)', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { fail: true },
        env: { MACF_CHANNEL_ALIVE_RETRIES: 'banana' },
      });
      expect(r.status).toBe(0);
      expect(r.curlCallCount).toBe(3);
      expect(r.stdout).toContain('YOUR CHANNEL-SERVER IS DEAD');
    });

    it('MACF_CHANNEL_ALIVE_RETRIES=0 is floored to the default (3) — never skips the loop into a false DEAD-with-zero-probes verdict', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { httpCode: '200' },
        env: { MACF_CHANNEL_ALIVE_RETRIES: '0' },
      });
      expect(r.status).toBe(0);
      // Alive on the very first (post-floor) attempt → silent, stops immediately.
      expect(r.stdout.trim()).toBe('');
      expect(r.curlCallCount).toBe(1);
    });

    it('a non-numeric MACF_CHANNEL_ALIVE_CURL_TIMEOUT_SECS falls back to the default without crashing the hook', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { httpCode: '200' },
        env: { MACF_CHANNEL_ALIVE_CURL_TIMEOUT_SECS: 'nope' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('an unexhausted-attempt failure sequence beyond the configured length repeats the LAST configured outcome (stub sanity, not hook behavior)', () => {
      // Regression guard for the stub itself: with only 2 responses configured
      // and RETRIES=3, the 3rd call clamps to the last entry (fail) rather than
      // crashing — so the hook still sees 3 real invocations and warns.
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { responses: [{ fail: true }, { fail: true }] },
      });
      expect(r.status).toBe(0);
      expect(r.curlCallCount).toBe(3);
      expect(r.stdout).toContain('YOUR CHANNEL-SERVER IS DEAD');
    });
  });

  describe("(i) macf#887 — own-log resolution never globs a peer's log", () => {
    it('MACF_LOG_PATH set + readable → used unchanged (regression pin)', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' },
        curl: { httpCode: '200' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(r.curlUrls).toHaveLength(1);
      expect(r.curlUrls[0]).toContain(':8899/health');
    });

    it('MACF_LOG_PATH unset but MACF_PROJECT/MACF_AGENT_NAME derivable → the reconstructed path is read + probed', () => {
      const r = runHook({
        serverStarted: { port: 8899, host: '127.0.0.1' }, // written under testproj@test-agent
        curl: { httpCode: '200' },
        exportLogPathEnv: false,
        identityEnv: { project: 'testproj', agentName: 'test-agent' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(r.curlUrls).toHaveLength(1);
      expect(r.curlUrls[0]).toContain(':8899/health');
    });

    it('MACF_LOG_PATH unset AND identity undeterminable, with a PEER server_started log present → skips with an honest message, NEVER probes the peer', () => {
      const r = runHook({
        // No serverStarted for THIS agent — own log genuinely absent/unknown.
        exportLogPathEnv: false,
        peerChannelLogs: [{ dir: 'otherproj@busy-peer', spec: { port: 9500, host: '127.0.0.1' } }],
        // portOverrides: {} forces the call-logging stub variant so ANY
        // invocation — matched port or not — would show up in curlUrls.
        curl: { portOverrides: {} },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Could not identify this agent's own channel-server log");
      expect(r.stdout).toContain('macf#887');
      // The regression that matters: curl must NEVER be invoked against the
      // peer's server — proves the peer log was not read, not merely that
      // the verdict happened to come out silent.
      expect(r.curlUrls).toHaveLength(0);
    });

    it('MACF_PROJECT set but MACF_AGENT_NAME missing (partial identity) → still undeterminable, never probes a peer', () => {
      const r = runHook({
        exportLogPathEnv: false,
        identityEnv: { project: 'testproj' }, // agentName omitted
        peerChannelLogs: [{ dir: 'otherproj@busy-peer', spec: { port: 9501, host: '127.0.0.1' } }],
        curl: { portOverrides: {} },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Could not identify');
      expect(r.curlUrls).toHaveLength(0);
    });

    it('derivable identity but no file at the reconstructed path → fails open SILENTLY like "no channel.log" (identity WAS known, so no "could not identify" claim)', () => {
      const r = runHook({
        exportLogPathEnv: false,
        identityEnv: { project: 'testproj', agentName: 'test-agent' },
        // no serverStarted → no file at testproj@test-agent/channel.log
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('MACF_SKIP_CHANNEL_ALIVE_CHECK=1 short-circuits before the identity-unknown message too', () => {
      const r = runHook({
        exportLogPathEnv: false,
        peerChannelLogs: [{ dir: 'otherproj@busy-peer', spec: { port: 9502, host: '127.0.0.1' } }],
        curl: { portOverrides: {} },
        env: { MACF_SKIP_CHANNEL_ALIVE_CHECK: '1' },
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(r.curlUrls).toHaveLength(0);
    });
  });
});
