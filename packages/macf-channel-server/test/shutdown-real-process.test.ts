/**
 * Real-process regression coverage for macf#1035.
 *
 * `shutdown.test.ts` drives `registerShutdownHandler`'s returned `cleanup()`
 * function IN-PROCESS, with `process.exit` mocked to a no-op. That is
 * exactly the shape macf#1035 flagged as insufficient: "a test that asserts
 * the slot is gone after a graceful exit, driven through the real exit
 * path rather than by calling the handler directly (calling the handler
 * directly would pass today and prove nothing)". Concretely, mocking
 * `process.exit` hides the bug this file guards against — a premature
 * `process.exit()` call that abandons an in-flight async deregister races
 * ahead of a REAL `process.exit()` (which terminates synchronously,
 * immediately, and does not wait for pending promises), but is invisible
 * when `process.exit` is a spy that just records the call and lets
 * everything else keep running to completion regardless.
 *
 * Each test here spawns `fixtures/shutdown-real-process-harness.mts` as a
 * genuine, separate OS process (not an in-process import) running the REAL
 * `registerShutdownHandler` from `../src/shutdown.ts`, drives the actual
 * exit path (stdin EOF, POSIX signals), and asserts against a marker FILE
 * written by the fake registry only once its (artificially delayed)
 * `deregisterConditional` call genuinely resolves — i.e. asserts the
 * simulated registry slot is actually gone, not merely that a mock function
 * was called.
 *
 * Diagnosis recap (see shutdown.ts's module docblock for the fixed code):
 *   1. Once-guard stale-value race — Node's stdin 'end' is always
 *      immediately followed by 'close'; the pre-fix guard let the second
 *      event's `cleanup()` invocation return an uninitialized placeholder
 *      and exit early, abandoning the real deregister. Verified via a
 *      direct `child.stdin.end()` repro (this file's first test).
 *   2. SIGHUP unhandled — tmux teardown after a TUI `/exit` sends SIGHUP to
 *      the channel-server child (spawned by Claude Code without
 *      setsid/detach); unhandled, its default disposition kills the
 *      process before the graceful path runs at all. Verified via a
 *      tmux-topology repro during diagnosis (not reproduced here — CI
 *      portability; the signal-delivery mechanism itself is covered
 *      directly via `child.kill('SIGHUP')`, which is what the added
 *      `process.on('SIGHUP', ...)` handler responds to regardless of what
 *      delivered the signal).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = join(__dirname, 'fixtures', 'shutdown-real-process-harness.mts');
const IS_WIN = process.platform === 'win32';

interface Harness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly markerPath: string;
  readonly logPath: string;
  readonly dir: string;
}

const spawned: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];

afterEach(() => {
  // Belt-and-suspenders: every test drives the process to a natural exit,
  // but a failing assertion mid-test must never leak a live child.
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'macf-shutdown-1035-'));
  dirs.push(dir);
  const markerPath = join(dir, 'marker.json');
  const logPath = join(dir, 'log.jsonl');

  const child = spawn('node', [HARNESS_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MARKER_PATH: markerPath,
      LOG_PATH: logPath,
      INSTANCE_ID: 'inst-1035',
      DEREGISTER_DELAY_MS: '150',
      ...env,
    },
  });
  spawned.push(child);

  let stderrBuf = '';
  child.stderr.on('data', (c: Buffer) => { stderrBuf += c.toString(); });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`harness never signaled READY. stderr so far:\n${stderrBuf}`));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return { child, markerPath, logPath, dir };
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

describe('shutdown — real process boundary (macf#1035)', () => {
  it(
    'a graceful stdin close (the REAL "/exit" path) deregisters the slot before the process exits',
    async () => {
      const { child, markerPath } = await startHarness();

      // This is the decisive assertion. `child.stdin.end()` closes the
      // write end exactly like a departing parent would — Node then emits
      // 'end' immediately followed by 'close' on the child's process.stdin
      // (verified: this is deterministic stream behavior, not a rare
      // race). Pre-fix, the second event's stale-guard would call
      // `process.exit(0)` before the 150ms fake-registry delay elapsed,
      // and NO marker file would exist. Post-fix, both events await the
      // SAME in-flight promise, so exit only happens after the real
      // deregister resolves.
      child.stdin.end();

      const { code, signal } = await waitForExit(child);

      expect(signal).toBeNull();
      expect(code).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as { deregistered: boolean; expectedInstanceId: string };
      expect(marker.deregistered).toBe(true);
      expect(marker.expectedInstanceId).toBe('inst-1035');
    },
    15_000,
  );

  it.skipIf(IS_WIN)(
    'SIGHUP (the tmux-pty-teardown signal, macf#1035) also deregisters before exit',
    async () => {
      const { child, markerPath } = await startHarness();

      child.kill('SIGHUP');

      const { code } = await waitForExit(child);

      expect(code).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
    },
    15_000,
  );

  it.skipIf(IS_WIN)(
    'a stdin-close racing a real SIGTERM still deregisters exactly once before exit',
    async () => {
      // Real-process analogue of shutdown.test.ts's mocked
      // "a stdin-close racing a SIGTERM runs the deregister exactly once" —
      // that test passes today (and did before the fix) because it mocks
      // process.exit; this one can't pass by accident.
      const { child, markerPath, logPath } = await startHarness();

      child.stdin.end();
      child.kill('SIGTERM');

      const { code } = await waitForExit(child);

      expect(code).toBe(0);
      expect(existsSync(markerPath)).toBe(true);
      const log = readFileSync(logPath, 'utf-8');
      const deregisterCalls = log.split('\n').filter((l) => l.includes('"event":"deregister_called"')).length;
      expect(deregisterCalls).toBe(1);
    },
    15_000,
  );

  it(
    'the instance-id guard (DR-031) still refuses a successor\'s slot through the real exit path',
    async () => {
      // Complements shutdown.test.ts's mocked not-ours coverage: proves the
      // guard's correct behavior (skip, don't delete) ALSO survives the
      // real process-exit path this file's other tests fix — i.e. the
      // #1035 fix didn't accidentally make cleanup delete unconditionally.
      const { child, markerPath } = await startHarness({ DEREGISTER_NOT_OURS: '1' });

      child.stdin.end();

      const { code } = await waitForExit(child);

      expect(code).toBe(0); // not-ours is a clean outcome, not a failure
      expect(existsSync(markerPath)).toBe(false); // never deleted a peer's live slot
    },
    15_000,
  );
});
