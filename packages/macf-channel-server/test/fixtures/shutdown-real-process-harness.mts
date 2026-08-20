/**
 * Standalone Node entry point — NOT a vitest test file (excluded from
 * vitest's `test/**\/*.test.ts` include pattern and from `tsc -b`'s
 * `src/**\/*.ts` include pattern; see the two tsconfig/vitest.config.ts
 * `include` globs).
 *
 * Spawned as a REAL, separate OS process by
 * `../shutdown-real-process.test.ts` so that test exercises the actual
 * process-boundary lifecycle (stdin EOF, POSIX signals, `process.exit`)
 * instead of calling `registerShutdownHandler`'s returned `cleanup()`
 * in-process — which is exactly the shape macf#1035 warned would "pass
 * today and prove nothing" (the pre-fix bug is a race between
 * `process.exit()` and an in-flight promise; calling the handler directly,
 * in the SAME process as the assertions, can never observe that race).
 *
 * Imports `registerShutdownHandler` straight from the TypeScript SOURCE
 * (`.ts` extension, not the project's usual `.js`-suffixed ESM convention)
 * because this file is executed directly via `node <this file>` relying on
 * Node's built-in TypeScript support (stable, unflagged, in the Node
 * version this repo targets) — no build step required, so the test doesn't
 * depend on `dist/` having been built first.
 *
 * Env vars (all required unless noted):
 *   MARKER_PATH          - written the instant the fake registry's
 *                           deregisterConditional() call RESOLVES (i.e. the
 *                           simulated GitHub Variables DELETE landed) — this
 *                           is the file the test asserts against, not a
 *                           call-count.
 *   LOG_PATH              - JSONL forensic log of every lifecycle event,
 *                            for debugging a failing run.
 *   INSTANCE_ID            - the instance id `registerShutdownHandler` is
 *                            configured with.
 *   DEREGISTER_DELAY_MS    - artificial latency for the fake registry call,
 *                            simulating a real GitHub API network round
 *                            trip. This is what makes the once-guard race
 *                            observable: 0ms would let a buggy build's
 *                            premature exit "accidentally" still complete
 *                            the real call first.
 *   DEREGISTER_NOT_OURS    - if "1", the fake registry reports
 *                            `{ deregistered: false, reason: 'not-ours' }`
 *                            instead of deleting — exercises the DR-031
 *                            instance-id guard through the SAME real
 *                            process boundary.
 */
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `pathToFileURL` (not a bare fs path) — dynamic `import()` requires a valid
// module specifier or URL; a bare absolute path is not portable across
// platforms.
const { registerShutdownHandler } = await import(
  pathToFileURL(join(__dirname, '..', '..', 'src', 'shutdown.ts')).href
);

const markerPath = process.env['MARKER_PATH'];
const logPath = process.env['LOG_PATH'];
const instanceId = process.env['INSTANCE_ID'] ?? 'test-instance-id';
const deregisterDelayMs = Number(process.env['DEREGISTER_DELAY_MS'] ?? '150');
const notOurs = process.env['DEREGISTER_NOT_OURS'] === '1';

if (markerPath === undefined || logPath === undefined) {
  throw new Error('MARKER_PATH and LOG_PATH env vars are required');
}

function log(event: string, extra: Record<string, unknown> = {}): void {
  fs.appendFileSync(logPath, JSON.stringify({ t: Date.now(), pid: process.pid, event, ...extra }) + '\n');
}

log('harness_boot');

const logger = {
  info: (event: string, fields?: Record<string, unknown>) => log('logger_info:' + event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log('logger_error:' + event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log('logger_warn:' + event, fields),
};

// Fake registry mirroring the real GitHubVariablesClient-backed one
// (deregisterConditional never throws) — WITH a real artificial delay so a
// signal/event arriving mid-call has genuine async work to race against,
// same as a real GitHub API DELETE round trip.
const registry = {
  async deregisterConditional(name: string, expectedInstanceId: string) {
    log('deregister_called', { name, expectedInstanceId });
    await new Promise((r) => setTimeout(r, deregisterDelayMs));
    if (notOurs) {
      log('deregister_resolved_not_ours');
      return { deregistered: false, reason: 'not-ours' as const };
    }
    fs.writeFileSync(markerPath, JSON.stringify({ deregistered: true, name, expectedInstanceId, at: Date.now() }));
    log('deregister_resolved');
    return { deregistered: true, reason: 'deleted' as const };
  },
};

// Real, bound TCP listener — mirrors the real channel-server's HTTPS server,
// which is what keeps the event loop alive during the async deregister per
// shutdown.ts's own doc comment (a fake/no-op "server" wouldn't exercise
// that keep-alive property honestly).
const httpServer = http.createServer((_req, res) => res.end('ok'));
await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
log('http_server_listening');

const httpsServerLike = {
  async stop() {
    log('https_stop_called');
    await new Promise<void>((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())));
    log('https_stop_resolved');
  },
};

// Mirrors mcp.ts's `StdioServerTransport.start()`, which attaches a 'data'
// listener to process.stdin (@modelcontextprotocol/sdk server/stdio.js).
// That attachment is what puts process.stdin into FLOWING mode in the real
// channel-server — WITHOUT it, process.stdin stays paused and 'end'/'close'
// never fire even after the write end closes. server.ts calls
// `mcp.connect()` BEFORE `registerShutdownHandler`, so replicate that order.
process.stdin.on('data', () => {
  /* no-op — presence alone is what flips stdin into flowing mode */
});

registerShutdownHandler({
  agentName: 'test-agent',
  registry,
  instanceId,
  httpsServer: httpsServerLike,
  logger,
});

log('shutdown_handler_registered');

// Signal readiness to whoever spawned us.
process.stdout.write('READY\n');
