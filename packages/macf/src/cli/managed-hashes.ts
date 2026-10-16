/**
 * Record of what macf last wrote (groundnuty/macf#1476 item 1).
 *
 * The config-dirty gate compares a dirty file with what the *running* macf
 * would generate. A workspace deployed by an older macf holds that older
 * output, so the comparison calls macf's own output an operator edit. This
 * module records a SHA-256 of each macf-written file in
 * `<workspace>/.macf/managed-hashes.json` (git-ignored), so the gate can
 * recognise "content macf wrote, whatever version" and still object to any
 * file whose content has changed since.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeCanonicalRuleFile, computeCanonicalScriptFile } from './rules.js';

const RECORD_REL = join('.macf', 'managed-hashes.json');
const SETTINGS_REL = '.claude/settings.json';

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function readRecord(workspaceDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(resolve(workspaceDir), RECORD_REL), 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Hash every macf-managed file currently on disk and store the record. Never throws. */
export function recordManagedHashes(workspaceDir: string): void {
  try {
    const root = resolve(workspaceDir);
    // Only a macf-managed workspace (one that already has `.macf/`) keeps a record.
    if (!existsSync(join(root, '.macf'))) return;
    const record: Record<string, string> = {};
    const add = (rel: string): void => {
      const abs = join(root, rel);
      if (existsSync(abs)) record[rel] = sha256(readFileSync(abs));
    };
    const listDir = (rel: string): string[] => {
      try {
        return readdirSync(join(root, rel), { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);
      } catch {
        return [];
      }
    };
    for (const name of listDir('.claude/rules')) {
      if (name.endsWith('.md') && computeCanonicalRuleFile(name) !== null) add(`.claude/rules/${name}`);
    }
    for (const name of listDir('.claude/scripts')) {
      if (computeCanonicalScriptFile(name) !== null) add(`.claude/scripts/${name}`);
    }
    add(SETTINGS_REL);
    writeFileSync(join(root, RECORD_REL), JSON.stringify(record, null, 2) + '\n');
  } catch {
    // A failed bookkeeping write must never fail the update that called it:
    // the gate then falls back to comparing with the running macf's output.
  }
}

/** True when `content` is byte-identical to what macf last wrote to `relPath`. */
export function matchesLastWritten(workspaceDir: string, relPath: string, content: string | Buffer): boolean {
  const recorded = readRecord(workspaceDir)[relPath];
  return recorded !== undefined && recorded === sha256(content);
}
