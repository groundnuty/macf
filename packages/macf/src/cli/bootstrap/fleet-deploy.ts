/**
 * `macf fleet deploy` — closes the provisioned-but-not-running gap DR-043
 * left after `macf bootstrap apply`: the GitHub side of a fleet (Apps,
 * installs, repos, CA, routing vars, `vault.age`) is fully provisioned, but
 * nothing turns a vault entry into a running agent workspace. Today an
 * operator hand-wires it (decrypt the vault, extract a PEM to a file, call
 * `macf init --app-id … --install-id … --app-key <pem> …` — see
 * `tools/macf-bootstrap/.claude/scripts/bootstrap-emit-commands.sh`'s emitted
 * command list, which is the exact sequence this module promotes to code,
 * same "mechanism promoted to code" posture `manifest-exchange.ts` /
 * `vault-write.ts` already established for their own shell-script
 * predecessors).
 *
 * {@link deployAgent} drives ONE agent through: decrypt the vault (Amendment
 * D phase 3's `readVault` — reused verbatim, never a second reader) →
 * extract ITS app_id/install_id/private-key (never guessed; missing any one
 * refuses loud, Amendment A) → materialize its workspace directory (`git
 * clone` when absent, left untouched when already present) → atomically
 * write the App private key to the conventional destination at `0600`
 * (never touched again once present — the key is operator-owned state past
 * this point, same as `init.ts::ingestAndResolveKeyPath`'s own "existing key
 * preserved" contract) → delegate to the REAL `initAgent` (`commands/
 * init.ts`) for everything else. This module never reimplements what
 * `initAgent` already owns (env files, hooks, plugin fetch, cert flow,
 * managed-vs-operator-owned config posture) — see the module's own doc for
 * that contract; `fleet deploy` only adds the two things `initAgent` does
 * NOT do: cloning the repo, and sourcing App credentials from the fleet
 * vault instead of the operator's command line.
 *
 * **Operator-privileged, same custody boundary as `vault-read.ts`.** This
 * module decrypts real fleet credentials — it is not a fleet-agent-safe
 * command. See `vault-read.ts`'s module doc §"Custody boundary" for the
 * enforcement shape (an explicit identity-key PATH argument, never read from
 * ambient env).
 *
 * **Never logs, echoes, or returns a raw secret.** The only credential this
 * module ever holds is the decrypted PEM + the vault's raw KEY=VALUE map,
 * both scoped to {@link deployAgent}'s local variables. {@link
 * FleetDeployOutcome} — the shape threaded to `--json` / the operator-facing
 * render — carries only `appId`/`installId`/paths/status/a `secretFingerprint`
 * (mirrors `apply-ca.ts`'s `redactCaResolve` precedent: a non-secret SHA-256
 * digest of the PEM lets an operator confirm "the same key that's in the
 * vault landed on disk" without ever seeing the key itself).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RegistryConfig } from '@groundnuty/macf-core';
import { toVariableSegment } from '@groundnuty/macf-core';
import type { FleetAgent, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle } from './fleet-manifest.js';
import type { VaultReadOptions } from './vault-read.js';
import { queryVaultAgentPresence } from './vault-read.js';
import { secretFingerprint } from './fleet-lock.js';
import type { InitOptions } from '../commands/init.js';
import { defaultAgentKeyPath } from '../commands/init.js';

/** Thrown by refusal paths in this module — mirrors `VaultError`/`ManifestExchangeError`'s shape. */
export class FleetDeployError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FleetDeployError';
    this.code = code;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Credential extraction (never guesses — Amendment A) ---

export interface AgentVaultCredentials {
  readonly appId: string;
  readonly installId: string;
  /** RAW PEM text, decoded from the vault's base64 field. Secret — never log; never place on {@link FleetDeployOutcome}. */
  readonly privateKeyPem: string;
}

/**
 * Extract ONE agent's app_id/install_id/private-key PEM from an
 * already-decrypted vault raw map (`vault-read.ts::readVault`'s return
 * value). Reuses {@link queryVaultAgentPresence} for the missing-field
 * check — the SAME presence primitive `plan.ts`'s vault-aware observer
 * already relies on — rather than re-deriving the missing/absent decision
 * from scratch. Refuses loud (never proceeds with a partial credential) when
 * ANY of the three required fields is absent; the message names WHICH
 * field(s) are missing, never a value (vault KEY names are never secret,
 * per `vault-read.ts`'s own posture — only the corresponding VALUE is).
 */
export function extractAgentVaultCredentials(
  raw: Readonly<Record<string, string>>,
  fleetName: string,
  role: string,
): AgentVaultCredentials {
  const presence = queryVaultAgentPresence(raw, fleetName, role);
  const missing: string[] = [];
  if (!presence.appId.present) missing.push('app_id');
  if (!presence.installId.present) missing.push('install_id');
  if (!presence.privateKey.present) missing.push('private_key');
  if (missing.length > 0) {
    throw new FleetDeployError(
      'vault_entry_missing_for_role',
      `vault has no ${missing.join('/')} for role "${role}" (fleet "${fleetName}") — refusing to deploy a ` +
        'partially-materialized workspace. Confirm this agent was actually provisioned by `macf bootstrap apply` ' +
        'and its identity landed in this vault.',
    );
  }

  const seg = toVariableSegment(deriveAppHandle(fleetName, role));
  const appId = raw[`MACF_AGENT_${seg}_APP_ID`];
  const installId = raw[`MACF_AGENT_${seg}_INSTALL_ID`];
  const privateKeyB64 = raw[`MACF_AGENT_${seg}_PRIVATE_KEY_B64`];
  // The presence check above already proved these three are defined +
  // non-empty; this defensive re-check (never a `!` assertion) keeps a
  // future drift between `queryVaultAgentPresence`'s field derivation and
  // this function's own a visible failure instead of an unsafe cast.
  if (appId === undefined || installId === undefined || privateKeyB64 === undefined) {
    throw new FleetDeployError(
      'vault_entry_missing_for_role',
      `internal inconsistency: presence check reported "${role}" complete but the raw field read back undefined — ` +
        'this indicates a bug in the vault-key derivation, not a genuinely absent credential. Do not retry blindly.',
    );
  }
  return { appId, installId, privateKeyPem: Buffer.from(privateKeyB64, 'base64').toString('utf-8') };
}

// --- Atomic 0600 key write ---

/**
 * Write `pem` to `destPath` ATOMICALLY at `0600` — never a truncate-then-
 * write that could leave a partial or world-readable file on an error path.
 * Mechanism: `mkdtemp` a scratch DIR in the SAME parent directory as
 * `destPath` (guarantees the same filesystem/mount, which is what makes the
 * final `renameSync` atomic) → write the plaintext into a file INSIDE that
 * scratch dir already at `0600` (the `writeFileSync` `mode` option, plus an
 * explicit `chmodSync` after for a umask-independent guarantee) → `renameSync`
 * it into place → `chmodSync` once more (belt-and-braces against a rename
 * across differently-configured filesystems that don't preserve mode) →
 * remove the scratch dir in `finally` regardless of outcome, so a `rename`
 * failure never leaves the plaintext lingering in the scratch dir.
 *
 * No plaintext ever touches disk anywhere else — this is the ONLY disk write
 * in this module's entire credential path (the decrypted PEM otherwise lives
 * only in {@link AgentVaultCredentials}, a local variable).
 */
export function writeAgentKeyAtomic0600(destPath: string, pem: string): void {
  const dir = dirname(destPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scratchDir = mkdtempSync(join(dir, '.macf-key-'));
  try {
    chmodSync(scratchDir, 0o700);
    const scratchFile = join(scratchDir, 'key.pem');
    writeFileSync(scratchFile, pem, { mode: 0o600 });
    chmodSync(scratchFile, 0o600);
    renameSync(scratchFile, destPath);
    chmodSync(destPath, 0o600);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

// --- Workspace materialization (clone-if-absent, never re-clone) ---

export type WorkspaceMaterializeOutcome = 'cloned' | 'skipped-existing';

function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    // Missing / not-a-directory / unreadable all read as "not an existing
    // populated dir" here — `cloneRepo` (or its own fs pre-check) surfaces
    // the real error if the path is genuinely unusable.
    return true;
  }
}

function defaultCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/**
 * Ensure `agent.repo` is cloned at `destDir`. Idempotent: an EXISTING,
 * non-empty `destDir` is left completely untouched (`'skipped-existing'`) —
 * this is the "must not clobber operator-modified files" contract at the
 * workspace-directory level (the sibling contract at the key-file level is
 * {@link writeAgentKeyAtomic0600}'s caller-side existence check — see
 * {@link deployAgent}). An absent OR empty `destDir` is cloned into.
 */
export async function ensureAgentWorkspaceCloned(
  repo: string,
  destDir: string,
  cloneRepo: (url: string, destDir: string) => Promise<void>,
  cloneUrl: (repo: string) => string = defaultCloneUrl,
): Promise<WorkspaceMaterializeOutcome> {
  if (existsSync(destDir) && !isEmptyDir(destDir)) {
    return 'skipped-existing';
  }
  mkdirSync(dirname(destDir), { recursive: true });
  await cloneRepo(cloneUrl(repo), destDir);
  return 'cloned';
}

// --- Registry-option mapping (fleet.yaml's RegistryConfig -> InitOptions) ---

/**
 * Map `fleet.yaml`'s `owner.registry` onto the subset of `InitOptions` that
 * steers `initAgent`'s registry wiring. Mirrors `apply-repo-init.ts`'s
 * `repoInitRegistryOptions` (same reasoning: `local` has no GitHub App/vault
 * of its own — a bootstrap-provisioned fleet is GitHub-backed by
 * construction, so a `local` registry here is a manifest/deploy mismatch,
 * refused rather than guessed at). Distinct return shape from that sibling
 * function because `initAgent`'s `repo`-type registry wants a single
 * `owner/repo` string (`registryRepo`), not separate org/user fields.
 */
export function initRegistryOptionsFor(
  registry: RegistryConfig,
): Pick<InitOptions, 'registryType' | 'registryOrg' | 'registryUser' | 'registryRepo'> {
  switch (registry.type) {
    case 'org':
      return { registryType: 'org', registryOrg: registry.org };
    case 'profile':
      return { registryType: 'profile', registryUser: registry.user };
    case 'repo':
      return { registryType: 'repo', registryRepo: `${registry.owner}/${registry.repo}` };
    case 'local':
      throw new FleetDeployError(
        'registry_local_unsupported',
        'owner.registry.type is "local" — a bootstrap-provisioned fleet always uses a GitHub-backed registry ' +
          '(org/profile/repo); local-registry mode has no App/vault of its own for `fleet deploy` to source from.',
      );
  }
}

// --- The per-agent orchestration ---

export interface FleetDeployDeps {
  readonly readVault: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>;
  /** Real `git clone` — a thin network I/O leaf, injectable so tests never touch the network. */
  readonly cloneRepo: (url: string, destDir: string) => Promise<void>;
  /** The REAL `initAgent` (`commands/init.ts`) in production; tests inject a recording fake so workspace-generation side effects (network version-resolution, plugin fetch, cert gen) never run in a unit test. */
  readonly initAgent: (projectDir: string, opts: InitOptions) => Promise<void>;
  /**
   * Resolves the destination App-key path for a role. Defaults to
   * `defaultAgentKeyPath` (the conventional `~/.macf/keys/<role>.pem`,
   * matching `bootstrap-emit-commands.sh`'s emitted `--app-key` path AND
   * `initAgent`'s own internal default when `--key-path` is omitted — see
   * `commands/init.ts::ingestAndResolveKeyPath`). **Tests MUST override this
   * to a scratch directory** — the default resolves under the REAL
   * operator's home directory, which may hold a real, live fleet's key.
   */
  readonly keyPathFor?: (role: string) => string;
  readonly log?: (line: string) => void;
}

export type FleetDeployOutcome =
  | {
      readonly role: string;
      readonly status: 'deployed';
      readonly appId: string;
      readonly installId: string;
      readonly workspace: WorkspaceMaterializeOutcome;
      readonly keyPath: string;
      readonly keyWrite: 'written' | 'skipped-existing';
      /** Non-secret `sha256:<hex>` over the RAW PEM (`fleet-lock.ts::secretFingerprint`) — proves "the vault's key" without ever carrying the key itself. Present regardless of whether the key was freshly written or already there (the vault was decrypted either way). */
      readonly keyFingerprint: string;
    }
  | { readonly role: string; readonly status: 'failed'; readonly reason: string };

/**
 * Drive ONE agent through decrypt → extract → materialize workspace →
 * materialize key → delegate to `initAgent`. NEVER throws — every failure
 * path (missing vault, bad identity, wrong key, missing vault entry, an
 * unsupported registry mode, a clone failure, an `initAgent` throw) resolves
 * to `status: 'failed'` with an operator-actionable, secret-free `reason`.
 */
export async function deployAgent(
  agent: FleetAgent,
  manifest: FleetManifest,
  destDir: string,
  vaultOpts: VaultReadOptions,
  deps: FleetDeployDeps,
): Promise<FleetDeployOutcome> {
  const log = deps.log ?? ((): void => {});
  const role = agent.role;

  try {
    const raw = await deps.readVault(vaultOpts);
    const creds = extractAgentVaultCredentials(raw, manifest.metadata.name, role);
    const keyFingerprint = secretFingerprint(creds.privateKeyPem);

    const registryOpts = initRegistryOptionsFor(manifest.owner.registry);

    const workspace = await ensureAgentWorkspaceCloned(agent.repo, destDir, deps.cloneRepo);
    log(
      `Role "${role}": workspace ${workspace === 'cloned' ? `cloned into ${destDir}` : `already present at ${destDir} — not re-cloned`}.`,
    );

    const keyPath = (deps.keyPathFor ?? defaultAgentKeyPath)(role);
    let keyWrite: 'written' | 'skipped-existing';
    if (existsSync(keyPath)) {
      keyWrite = 'skipped-existing';
      log(`Role "${role}": App key already present at ${keyPath} — not overwritten (operator-owned once materialized).`);
    } else {
      writeAgentKeyAtomic0600(keyPath, creds.privateKeyPem);
      keyWrite = 'written';
      log(`Role "${role}": App key materialized at ${keyPath} (0600).`);
    }

    await deps.initAgent(destDir, {
      project: manifest.metadata.name,
      role,
      appId: creds.appId,
      installId: creds.installId,
      keyPath,
      advertiseHost: manifest.network.advertise_host,
      ...(manifest.versions?.macf !== undefined ? { cliVersion: manifest.versions.macf } : {}),
      ...(manifest.versions?.actions !== undefined ? { actionsVersion: manifest.versions.actions } : {}),
      ...registryOpts,
    });
    log(`Role "${role}": macf init completed at ${destDir}.`);

    return { role, status: 'deployed', appId: creds.appId, installId: creds.installId, workspace, keyPath, keyWrite, keyFingerprint };
  } catch (err) {
    return { role, status: 'failed', reason: errMessage(err) };
  }
}
