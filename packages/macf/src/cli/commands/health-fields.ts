/**
 * Shared, DEFENSIVE readers/formatters for not-yet-fully-typed `/health`
 * self-report fields (DR-030 §5 — `state` + `otel`). Extracted from
 * `fleet.ts` (groundnuty/macf#794) so BOTH the fleet MEMBERS table
 * (`fleet.ts`) and the GUEST block (`fleet-guests.ts`) render the same
 * `state`/`otel` fields the same way — a federated, live cross-fleet guest
 * should show its idle/busy turn-state exactly like a same-fleet peer does.
 *
 * `fleet.ts` re-exports everything here so existing imports
 * (`from './fleet.js'`) keep working unchanged.
 */
import type { HealthResponse } from '@groundnuty/macf-core';

/** Read an arbitrary (possibly not-yet-typed) field off a `/health` body. */
export function rawField(health: HealthResponse | null, key: string): unknown {
  return health ? (health as unknown as Record<string, unknown>)[key] : undefined;
}

/** Human-readable elapsed from whole seconds: `45s` / `18m` / `2h5m`. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/**
 * DR-030 sibling-increment `/health.state` object self-report — read
 * DEFENSIVELY (NOT yet in the `HealthResponse` type). All fields optional; the
 * field may also arrive as a plain `"idle"|"busy"` string (DR-030 §5).
 */
export interface AgentRunState {
  readonly status?: string;
  readonly turn_number?: number;
  readonly elapsed_ms?: number;
}

/** DR-030 sibling-increment `/health.otel` self-report — read DEFENSIVELY. */
export interface AgentOtelReport {
  readonly endpoint_reachable?: boolean;
}

/**
 * Render the `state` self-report. Tolerates the field being absent, a plain
 * `"idle"|"busy"` string (DR-030 §5), or a `{ status, turn_number, elapsed_ms }`
 * object (rendered like `busy 18m on turn 7`).
 */
export function formatRunState(raw: unknown): string {
  if (raw == null) return '—';
  if (typeof raw === 'string') return raw || '—';
  if (typeof raw === 'object') {
    const s = raw as AgentRunState;
    const parts: string[] = [];
    if (typeof s.status === 'string' && s.status) parts.push(s.status);
    if (typeof s.elapsed_ms === 'number') parts.push(formatUptime(Math.floor(s.elapsed_ms / 1000)));
    if (typeof s.turn_number === 'number') parts.push(`on turn ${s.turn_number}`);
    return parts.length ? parts.join(' ') : '—';
  }
  return '—';
}

/** Render the `otel` self-report's `endpoint_reachable` flag. */
export function formatOtel(raw: unknown): string {
  if (raw == null || typeof raw !== 'object') return '—';
  const o = raw as AgentOtelReport;
  if (typeof o.endpoint_reachable !== 'boolean') return '—';
  return o.endpoint_reachable ? 'reachable' : 'unreachable ✗';
}
