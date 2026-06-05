/**
 * Source-shape TRIPWIRE for the bootstrap-abort clean-exit
 * (groundnuty/macf#449).
 *
 * On any fatal bootstrap abort — `CollisionError` or `RegisterRaceError`
 * (#447) — `main()` throws to the top-level `main().catch`. Setting
 * `process.exitCode = 1` alone does NOT terminate the process: the MCP stdio
 * transport holds stdin's readable stream open, so the event loop stays alive
 * and the process *hangs* instead of exiting 1 (a supervisor expecting a
 * non-zero exit then waits forever). The fix forces `process.exit(1)`.
 *
 * **Scope caveat (same as `server-collision-ordering.test.ts`):** this asserts
 * only the TEXTUAL presence of the force-exit in the catch handler, not the
 * runtime behavior — there is no server-startup harness to spawn a real
 * colliding instance with a held-open stdin and assert the exit code. It's a
 * cheap regression tripwire for the common refactor that drops the
 * `process.exit(1)` back to a bare `exitCode` assignment (the exact #449
 * regression). The runtime guarantee rests on the `process.exit(1)` at the
 * call site.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVER_SOURCE = readFileSync(resolve(__dirname, '../src/server.ts'), 'utf-8');

// The top-level fatal handler — slice from `main().catch` to EOF so the
// assertions are scoped to the catch body, not an incidental match elsewhere.
const CATCH_BLOCK = SERVER_SOURCE.slice(SERVER_SOURCE.indexOf('main().catch'));

describe('server.ts bootstrap-abort clean exit (macf#449)', () => {
  it('has a top-level main().catch fatal handler', () => {
    expect(SERVER_SOURCE).toContain('main().catch');
  });

  it('force-exits with process.exit(1) so a held-open stdin cannot hang the process', () => {
    expect(CATCH_BLOCK).toContain('process.exit(1)');
  });

  it('still sets process.exitCode = 1 as a fallback before exiting', () => {
    // Belt-and-suspenders: if the stderr-flush callback never fires, the
    // exit code is still correct.
    expect(CATCH_BLOCK).toContain('process.exitCode = 1');
    // exitCode set before the exit-on-flush write (so it's the fallback).
    expect(CATCH_BLOCK.indexOf('process.exitCode = 1'))
      .toBeLessThan(CATCH_BLOCK.indexOf('process.exit(1)'));
  });
});
