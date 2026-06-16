/**
 * Read + parse F2 reflection JSONL ledgers for the auditor Monitor
 * (groundnuty/macf#502, DR-026 F4).
 *
 * Reads every `*.jsonl` file under the reflections directory, parses each line
 * with `ReflectionRecordSchema`, and skips malformed lines DEFENSIVELY — a
 * single bad line (truncated write, hand-edit, schema drift) must never make the
 * whole digest fatal. Skipped-line counts are surfaced in the result so the
 * digest can note them rather than hide them.
 *
 * This is a pure read: it only opens files for reading. No mutation.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ReflectionRecordSchema, type ReflectionRecord } from '@groundnuty/macf-core';

export interface ReflectionsReadResult {
  /** All successfully-parsed reflection records across every ledger file. */
  readonly records: readonly ReflectionRecord[];
  /** Count of JSONL lines that failed to parse (surfaced, never fatal). */
  readonly skipped: number;
  /** Number of `*.jsonl` ledger files read. */
  readonly files: number;
}

/**
 * Read all reflection records from the JSONL ledgers under `dir`.
 *
 * Returns an empty result (no throw) when `dir` doesn't exist or contains no
 * `*.jsonl` files — a project that hasn't compacted yet is a valid state, not
 * an error.
 */
export function readReflections(dir: string): ReflectionsReadResult {
  if (!existsSync(dir)) {
    return { records: [], skipped: 0, files: 0 };
  }

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { records: [], skipped: 0, files: 0 };
  }

  const records: ReflectionRecord[] = [];
  let skipped = 0;
  let files = 0;

  for (const entry of entries) {
    const path = join(dir, entry);
    let raw: string;
    try {
      if (!statSync(path).isFile()) continue;
      raw = readFileSync(path, 'utf-8');
    } catch {
      continue; // unreadable file — skip the whole file, not fatal
    }
    files += 1;

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue; // blank lines are not failures
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch {
        skipped += 1; // not valid JSON — skip defensively
        continue;
      }
      const result = ReflectionRecordSchema.safeParse(parsedJson);
      if (result.success) {
        records.push(result.data);
      } else {
        skipped += 1; // valid JSON but wrong shape — skip defensively
      }
    }
  }

  return { records, skipped, files };
}
