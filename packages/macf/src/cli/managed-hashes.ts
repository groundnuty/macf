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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const RECORD_REL = join('.macf', 'managed-hashes.json');
export const SETTINGS_REL = '.claude/settings.json';

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

/**
 * Record the hash of each file macf wrote in THIS run.
 *
 * `written` lists only the paths a writer actually wrote (workspace-relative,
 * or absolute under the workspace). A path that was refused or preserved is
 * not listed, so its earlier hash is kept as it was: recording what is on
 * disk instead would relabel an operator edit as macf output. Entries are
 * merged into the existing record, never replaced wholesale. Never throws.
 */
export function recordManagedHashes(workspaceDir: string, written: Iterable<string>): void {
  try {
    const root = resolve(workspaceDir);
    // Only a macf-managed workspace (one that already has `.macf/`) keeps a record.
    if (!existsSync(join(root, '.macf'))) return;
    const record = readRecord(root);
    for (const entry of written) {
      const rel = (isAbsolute(entry) ? relative(root, entry) : entry).split(sep).join('/');
      if (rel === '' || rel.startsWith('..')) continue;
      const abs = join(root, rel);
      if (existsSync(abs)) record[rel] = sha256(readFileSync(abs));
    }
    writeFileSync(join(root, RECORD_REL), JSON.stringify(record, null, 2) + '\n');
  } catch {
    // A failed bookkeeping write must never fail the update that called it:
    // the gate then falls back to comparing with the running macf's output.
  }
}

/** Workspace-relative paths for the canonical rules and scripts a copy wrote. */
export function copiedAssetPaths(rules: readonly string[], scripts: readonly string[]): string[] {
  return [...rules.map((n) => `.claude/rules/${n}`), ...scripts.map((n) => `.claude/scripts/${n}`)];
}

/** Workspace-relative paths for files written under `.claude/.macf/`. */
export function macfDirPaths(names: readonly string[]): string[] {
  return names.map((n) => `.claude/.macf/${n}`);
}

/** True when `content` is byte-identical to what macf last wrote to `relPath`. */
export function matchesLastWritten(workspaceDir: string, relPath: string, content: string | Buffer): boolean {
  const recorded = readRecord(workspaceDir)[relPath];
  return recorded !== undefined && recorded === sha256(content);
}
