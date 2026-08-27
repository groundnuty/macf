/**
 * Committed-manifest drift — does `<fleet>-control`'s COMMITTED `fleet.yaml`
 * still match the LOCAL manifest `macf bootstrap status`/`apply` was just
 * given (groundnuty/macf#1249)?
 *
 * **The gap this closes.** Amendment F's ordering rule (DR-043, `control-repo.ts`'s
 * module doc) says the control repo's `fleet.yaml` is committed as the
 * repo's FIRST act, and "subsequent runs read the committed copy" — the
 * committed file is meant to be the fleet's CURRENT record, not a one-time
 * snapshot. Before groundnuty/macf#1249's companion fix
 * (`apply-fleet.ts`'s "Final sync" section), `apply` never re-wrote
 * `fleet.yaml` on a `reused`/`revived` outcome — only `fleet.lock`/
 * `vault.age` got refreshed. A fleet scaled from 2 agents to 3, or one that
 * gained a `routing:` section, kept a committed manifest describing the
 * OLD shape indefinitely: a reader of the control repo (a human, or a
 * future tool reasoning FROM the committed copy — the live incident this
 * module exists to prevent recurring) sees a fossil next to a `fleet.lock`
 * that DID keep up. This module is the READ side of that fix: `status`
 * (and `apply`, if it wires this in) compares the two and reports the
 * mismatch by name, rather than leaving the divergence invisible until
 * someone manually diffs `fleet.yaml` against `fleet.lock` by hand.
 *
 * **Compares PARSED, defaulted manifests — not raw YAML bytes.** Both sides
 * go through {@link parseFleetManifest} (the same schema, with the same
 * Zod defaults applied — e.g. `routing.runner.warm` defaulting to `1`).
 * This means a committed manifest that OMITS `warm` and a local one that
 * explicitly declares `warm: 1` compare `'clean'` — correctly, since they
 * describe the identical desired state — never a spurious diff on a
 * formatting/omission difference that carries no semantic weight. A caller
 * that wants byte-level (comment/formatting) diffing needs a different
 * tool; this one answers "does the DECLARATION differ," not "do the bytes
 * differ."
 *
 * **No `--vault`/`--identity-key` gate, unlike `install-scope-coverage.ts`.**
 * Reading a committed `fleet.yaml` off a repo's default branch is a plain
 * `gh api repos/<repo>/contents/fleet.yaml` call under the operator's OWN
 * ambient `gh` auth (`control-repo.ts::realReadControlManifestFile` — the
 * SAME primitive `provisionControlRepo`'s ownership classification already
 * uses) — no App JWT, no vault decrypt. So this check runs on EVERY
 * `status` invocation, vault flags or not; `installScopeCoverage`'s
 * vault-gate exists because THAT check needs a per-App credential this one
 * never does.
 *
 * **Honest-unknown, at the same two independent points every sibling drift
 * module in this file establishes (Amendment A):** (1) the control repo
 * itself isn't confirmed `'present'` — nothing to compare against, and
 * absence must never read as "no declaration" (`silent-fallback-hazards.md`'s
 * discipline, applied here to a manifest instead of a token/secret); (2) the
 * committed `fleet.yaml` is present but unreadable or fails schema
 * validation — a foreign/malformed control repo, or a transient read
 * failure, neither of which this module can safely resolve into a
 * pass/fail verdict.
 */
import type { FleetManifest } from './fleet-manifest.js';
import { parseFleetManifest } from './fleet-manifest.js';
import type { Presence } from './plan.js';

// --- Pure structural diff (no I/O, no FleetManifest-specific knowledge) ---

/** One field where the committed and applied manifests disagree, named by its full path from the manifest root. */
export interface ManifestFieldDiff {
  /**
   * Dot/bracket path from the manifest root — e.g. `"network.advertise_host"`,
   * `"routing"` (the whole section added/removed), `"agents[2]"` (a whole
   * agent added/removed), `"agents[0].repo"` (one field of an existing
   * agent changed).
   */
  readonly path: string;
  /** `undefined` when the committed manifest has nothing at this path (the field/section/element is new in `applied`). */
  readonly committed: unknown;
  /** `undefined` when the applied manifest has nothing at this path (the field/section/element was removed). */
  readonly applied: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Order-independent structural equality over JSON-safe values (plain
 * objects, arrays, primitives — exactly what a parsed `FleetManifest`
 * contains; no `Date`/`Map`/function fields anywhere in that schema).
 */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqualJson(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqualJson(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Recursive path-diff between two JSON-safe values. Descends into an
 * object/object pair (union of keys) or an array/array pair (index-wise,
 * to `max(length)`) ONLY when BOTH sides are the same shape at that path —
 * the moment one side is `undefined`, a primitive, or a shape mismatch
 * against an object/array on the other side, this reports ONE diff entry
 * for that whole path and does NOT recurse further into it. This is
 * deliberate: a wholly-added `agents[2]` (committed has no 3rd agent at
 * all) becomes a single entry carrying the full added agent object, never
 * one entry per field of that agent — see the module doc's live-evidence
 * worked example (`routing` added wholesale reports as one `"routing"`
 * entry, not three).
 */
export function diffManifestFields(committed: unknown, applied: unknown, path = ''): readonly ManifestFieldDiff[] {
  if (deepEqualJson(committed, applied)) return [];
  if (isPlainObject(committed) && isPlainObject(applied)) {
    const keys = new Set([...Object.keys(committed), ...Object.keys(applied)]);
    const out: ManifestFieldDiff[] = [];
    for (const key of keys) {
      out.push(...diffManifestFields(committed[key], applied[key], path === '' ? key : `${path}.${key}`));
    }
    return out;
  }
  if (Array.isArray(committed) && Array.isArray(applied)) {
    const out: ManifestFieldDiff[] = [];
    const len = Math.max(committed.length, applied.length);
    for (let i = 0; i < len; i++) {
      out.push(...diffManifestFields(committed[i], applied[i], `${path}[${String(i)}]`));
    }
    return out;
  }
  return [{ path, committed, applied }];
}

// --- Orchestration ---

export type ControlRepoManifestDriftStatus = 'clean' | 'drift' | 'unknown';

export interface ControlRepoManifestDriftResult {
  readonly repo: string;
  readonly status: ControlRepoManifestDriftStatus;
  /** Non-empty exactly when `status === 'drift'`. */
  readonly fields: readonly ManifestFieldDiff[];
  /** Present for `'drift'`/`'unknown'`; omitted for `'clean'` (mirrors every sibling drift module's convention — only the problem is loud). */
  readonly reason?: string;
}

function renderFieldValue(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

/** One `path: committed vs applied` line per diff entry — the "naming the fields" contract groundnuty/macf#1249 asks for. */
export function formatManifestFieldDiffLines(fields: readonly ManifestFieldDiff[]): readonly string[] {
  return fields.map((f) => `${f.path}: committed=${renderFieldValue(f.committed)} vs applied=${renderFieldValue(f.applied)}`);
}

/**
 * Read + parse the committed `fleet.yaml`, then diff against `applied`
 * (the ALREADY-parsed local manifest this run was given). NEVER throws —
 * every failure resolves to `status: 'unknown'` with a reason naming what
 * could not be confirmed, same never-throws contract as this file's
 * sibling drift/coverage modules.
 */
export async function computeControlRepoManifestDrift(
  applied: FleetManifest,
  repo: string,
  controlRepoPresence: Presence,
  readManifestFile: (repo: string) => Promise<string | undefined>,
): Promise<ControlRepoManifestDriftResult> {
  if (controlRepoPresence !== 'present') {
    return {
      repo,
      status: 'unknown',
      fields: [],
      reason: `control repo "${repo}" is not confirmed present (observed: ${controlRepoPresence}) — nothing to compare the local manifest against.`,
    };
  }

  let text: string | undefined;
  try {
    text = await readManifestFile(repo);
  } catch (err) {
    return {
      repo,
      status: 'unknown',
      fields: [],
      reason: `could not read the committed fleet.yaml from "${repo}": ${errMessage(err)}.`,
    };
  }
  if (text === undefined) {
    return {
      repo,
      status: 'unknown',
      fields: [],
      reason: `could not read the committed fleet.yaml from "${repo}" (missing, or the read failed).`,
    };
  }

  let committed: FleetManifest;
  try {
    committed = parseFleetManifest(text);
  } catch (err) {
    return {
      repo,
      status: 'unknown',
      fields: [],
      reason: `the committed fleet.yaml in "${repo}" failed schema validation: ${errMessage(err)}.`,
    };
  }

  const fields = diffManifestFields(committed, applied);
  if (fields.length === 0) {
    return { repo, status: 'clean', fields: [] };
  }
  return {
    repo,
    status: 'drift',
    fields,
    reason:
      `the manifest committed in "${repo}" no longer matches the local fleet.yaml this run was given — ` +
      `${String(fields.length)} field(s) differ: ${fields.map((f) => f.path).join(', ')}.`,
  };
}

// --- Formatting / JSON ---

export function hasControlRepoManifestDrift(result: ControlRepoManifestDriftResult): boolean {
  return result.status === 'drift';
}

/** `[]` when `'clean'` — only the problem is loud, same convention as every sibling drift module. */
export function formatControlRepoManifestDriftLines(result: ControlRepoManifestDriftResult): readonly string[] {
  if (result.status === 'clean') return [];
  const label = result.status === 'drift' ? 'WARNING' : 'unknown';
  const lines = [`control-repo-manifest-drift: ${label} — ${result.reason ?? ''}`];
  if (result.status === 'drift') {
    lines.push(...formatManifestFieldDiffLines(result.fields).map((l) => `  ${l}`));
  }
  return lines;
}

export function controlRepoManifestDriftToJson(result: ControlRepoManifestDriftResult): unknown {
  return {
    repo: result.repo,
    status: result.status,
    fields: result.fields.map((f) => ({ path: f.path, committed: f.committed ?? null, applied: f.applied ?? null })),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
