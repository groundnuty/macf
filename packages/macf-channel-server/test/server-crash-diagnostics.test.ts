/**
 * Source-shape TRIPWIRE for the channel-server crash-diagnostics wiring
 * (groundnuty/macf#642).
 *
 * The crash-diagnostics behavior lives in dedicated, unit-tested modules
 * (`forensic-log.ts`, `lifecycle.ts`, `crash-handlers.ts`, `alive-ticker.ts`).
 * What this file guards is the WIRING in `server.ts main()` — that those modules
 * are actually constructed + invoked, the cleanup is captured for the crash
 * handlers, and the lifecycle phase markers + exit logger are present. Same
 * source-shape approach as `server-bootstrap-abort-exit.test.ts` +
 * `server-collision-ordering.test.ts`: there is no server-startup harness to run
 * `main()`, so this asserts textual presence/order — a cheap regression tripwire
 * for the common refactor that drops a wiring line.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVER_SOURCE = readFileSync(resolve(__dirname, '../src/server.ts'), 'utf-8');

describe('server.ts crash-diagnostics wiring (macf#642)', () => {
  it('builds the guaranteed forensic logger instead of the bare createLogger', () => {
    expect(SERVER_SOURCE).toContain('createForensicLogger(');
    expect(SERVER_SOURCE).toContain('forensic_log_active');
  });

  it('registers top-level crash handlers wired to the captured shutdown cleanup', () => {
    expect(SERVER_SOURCE).toContain('registerCrashHandlers(');
    expect(SERVER_SOURCE).toContain('getCleanup: () => shutdownCleanup');
    // The cleanup must be CAPTURED from registerShutdownHandler for the crash
    // handlers to be able to deregister — not called for its side effects only.
    expect(SERVER_SOURCE).toContain('shutdownCleanup = registerShutdownHandler(');
  });

  it('crash handlers are registered EARLY — before the startup body runs', () => {
    // registerCrashHandlers must appear before runStartup is invoked so a crash
    // during boot is still caught.
    expect(SERVER_SOURCE.indexOf('registerCrashHandlers('))
      .toBeLessThan(SERVER_SOURCE.indexOf('await runStartup()'));
  });

  it('logs the process exit code via a process.on("exit") handler', () => {
    expect(SERVER_SOURCE).toContain("process.on('exit'");
    expect(SERVER_SOURCE).toContain('process_exit');
  });

  it('tracks lifecycle phases through startup', () => {
    expect(SERVER_SOURCE).toContain('createLifecycleTracker(');
    for (const phase of ['mcp-connected', 'port-bound', 'collision-checked', 'registered', 'serving']) {
      expect(SERVER_SOURCE).toContain(`lifecycle.set('${phase}')`);
    }
  });

  it('starts the periodic alive-tick to the forensic log', () => {
    expect(SERVER_SOURCE).toContain('createAliveTicker(');
    expect(SERVER_SOURCE).toContain('.start()');
  });

  it('wraps the /notify delivery path in a boundary catch that logs + re-throws', () => {
    expect(SERVER_SOURCE).toContain('deliverNotification(');
    expect(SERVER_SOURCE).toContain('notify_handler_error');
  });
});
