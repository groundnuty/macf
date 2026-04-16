/**
 * macf update auto-migrate for CA key encryption (DR-011 rev2, #115).
 *
 * Detects legacy v1-shaped `{PROJECT}_CA_KEY_ENCRYPTED` blobs in the
 * registry and upgrades them in place to v2 (JSON envelope at 600k
 * iters). One-time per project — subsequent `macf update` runs see
 * the v2 blob and no-op silently.
 *
 * Idempotent: re-running on a v2 blob is a no-op. Atomic: if the
 * passphrase is wrong or re-encryption fails, the v1 blob in the
 * registry is untouched — the only state change is the prompt. The
 * operator can retry.
 *
 * Isolation: this module has no hard dependency on the `macf update`
 * command shape. Callers provide the registry client + prompt
 * function, enabling headless tests and future `--passphrase-file`
 * extension (Future Work in DR-011 rev2).
 */
import { encryptCAKey, decryptCAKey, CaError } from '../../certs/ca.js';
import { toVariableSegment } from '../../registry/variable-name.js';
import type { GitHubVariablesClient } from '../../registry/types.js';

export type MigrationResult =
  | { readonly status: 'no_variable' }
  | { readonly status: 'already_v2' }
  | { readonly status: 'migrated' }
  | { readonly status: 'wrong_passphrase' }
  | { readonly status: 'error'; readonly message: string };

/**
 * Check if a registry-stored value is the legacy v1 (raw base64)
 * shape. v2 envelopes always start with `{` (JSON object); base64
 * alphabet excludes `{`, so this dispatch is safe by construction.
 */
export function isV1Blob(value: string): boolean {
  return !value.trimStart().startsWith('{');
}

/**
 * Run the migration for one project. Returns a result tag for the
 * caller to render to the operator. Does NOT log directly — the
 * caller owns stdout/stderr presentation so this is testable without
 * capturing output.
 */
export async function migrateCaKeyToV2(opts: {
  readonly project: string;
  readonly client: GitHubVariablesClient;
  readonly prompt: (message: string) => Promise<string>;
}): Promise<MigrationResult> {
  const { project, client, prompt } = opts;
  const varName = `${toVariableSegment(project)}_CA_KEY_ENCRYPTED`;

  const current = await client.readVariable(varName);
  if (current === null) {
    return { status: 'no_variable' };
  }

  if (!isV1Blob(current)) {
    // Already v2 (or v3+ future) — nothing to do. Silent no-op.
    return { status: 'already_v2' };
  }

  // DR-011 rev2 canonical prompt text. Keep verbatim — matches the
  // operator-facing doctrine in design/decisions/DR-011-ca-key-backup.md.
  const passphrase = await prompt(
    `Migrating CA key encryption: v1/iter=10000 → v2/iter=600000 for project ${project}.\n` +
    `This is a one-time passphrase prompt for this project; subsequent \`macf update\`\n` +
    `runs in this or any other workspace for the same project won't re-prompt.\n` +
    `Enter CA key passphrase: `,
  );

  let keyPem: string;
  try {
    keyPem = decryptCAKey(current, passphrase);
  } catch (err) {
    if (err instanceof CaError) {
      return { status: 'wrong_passphrase' };
    }
    throw err;
  }

  const v2Value = encryptCAKey(keyPem, passphrase);

  try {
    await client.writeVariable(varName, v2Value);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return { status: 'migrated' };
}

/**
 * Render a MigrationResult to the operator. Kept out of
 * `migrateCaKeyToV2` so tests don't need stdout capture.
 */
export function formatMigrationResult(result: MigrationResult, project: string): string {
  switch (result.status) {
    case 'no_variable':
      return ''; // No backup exists; silent no-op.
    case 'already_v2':
      return ''; // Already migrated; silent no-op.
    case 'migrated':
      return `Migration complete: ${toVariableSegment(project)}_CA_KEY_ENCRYPTED is now v2/600k.`;
    case 'wrong_passphrase':
      return `Migration aborted: wrong passphrase. Your v1 backup is untouched; re-run \`macf update\` to retry.`;
    case 'error':
      return `Migration failed: ${result.message}. Your v1 backup is untouched; re-run \`macf update\` to retry.`;
  }
}
