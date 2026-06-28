/**
 * Lifecycle-phase tracker (groundnuty/macf#642).
 *
 * A tiny mutable holder for the channel-server's current startup/runtime phase
 * plus process uptime. The crash handlers and the periodic alive-tick read its
 * snapshot so the forensic log pinpoints WHERE the process was when it died —
 * the difference between "crashed mid-boot" and "crashed while serving" is the
 * first thing an operator needs.
 *
 * Free-form `phase` strings (not an enum) keep server.ts able to annotate any
 * step without a schema round-trip; the canonical phases server.ts uses are
 * boot → otel-bootstrapped → config-loaded → mcp-connected → port-bound →
 * collision-checked → registered → serving.
 */

export interface LifecycleSnapshot {
  readonly phase: string;
  readonly uptime_ms: number;
}

export interface LifecycleTracker {
  /** Advance the current phase. */
  readonly set: (phase: string) => void;
  /** Read the current phase + uptime (now − startedAt). */
  readonly snapshot: () => LifecycleSnapshot;
}

export function createLifecycleTracker(opts?: {
  readonly initial?: string;
  /** Injectable epoch-ms clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}): LifecycleTracker {
  const now = opts?.now ?? ((): number => Date.now());
  const startedAt = now();
  let phase = opts?.initial ?? 'boot';

  return {
    set(next: string): void {
      phase = next;
    },
    snapshot(): LifecycleSnapshot {
      return { phase, uptime_ms: now() - startedAt };
    },
  };
}
