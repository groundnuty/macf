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
 * (never touched again once present AND its fingerprint matches the vault's
 * — the key is operator-owned state past that point, same as
 * `init.ts::ingestAndResolveKeyPath`'s own "existing key preserved"
 * contract) → delegate to the REAL `initAgent` (`commands/
 * init.ts`) for everything else. This module never reimplements what
 * `initAgent` already owns (env files, hooks, plugin fetch, cert flow,
 * managed-vs-operator-owned config posture) — see the module's own doc for
 * that contract; `fleet deploy` only adds the two things `initAgent` does
 * NOT do: cloning the repo, and sourcing App credentials from the fleet
 * vault instead of the operator's command line.
 *
 * **A pre-existing on-disk key is trusted only when it matches the vault
 * (macf#975; the gap #970 flagged and shipped as "acceptable").** A fleet
 * rebuild rotates App identities by construction — GitHub offers no way to
 * reuse an App whose private key you no longer hold — so a key left on disk
 * by a PREVIOUS fleet belongs to an App that no longer exists. Minting with
 * it fails as a bare, unhelpful 401 naming nothing about the mismatch. This
 * module now compares the on-disk key's PUBLIC-KEY identity fingerprint
 * ({@link publicKeyFingerprint} — encoding-invariant, unlike a raw-PEM
 * byte-hash) against the vault's BEFORE ever attempting a mint: same
 * identity → `'skipped-existing'`, unchanged; different identity → refuses
 * loud (naming both fingerprints + two remedies), unless the caller opts
 * into `--force-key` ({@link FleetDeployDeps.forceKey}), which
 * re-materializes from the vault instead of requiring the operator to
 * hand-delete the stale file.
 *
 * **The per-project CA gets the SAME opt-in treatment, plus a combined
 * refusal when BOTH are stale (macf#982).** `materializeProjectCa`'s own
 * local-vs-vault mismatch refusal names its remedy and a `--force-ca` flag
 * ({@link FleetDeployDeps.forceCa}), mirroring `--force-key` exactly — see
 * {@link caFingerprintMismatchMessage}. A fleet rebuild rotates BOTH
 * identities at once, so an unwiped host commonly has BOTH stale;
 * {@link deployAgent} detects both BEFORE writing either and, when neither
 * is forced, raises ONE combined refusal naming all four fingerprints and
 * both flags together ({@link staleCaAndKeyMismatchMessage}) — never two
 * sequential dead-ends for the operator to discover one at a time.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import type { RegistryConfig, TokenSource } from '@groundnuty/macf-core';
import { toVariableSegment, generateToken, caCertFingerprint } from '@groundnuty/macf-core';
import type { FleetAgent, FleetManifest } from './fleet-manifest.js';
import { deriveAppHandle } from './fleet-manifest.js';
import type { VaultReadOptions } from './vault-read.js';
import { queryVaultAgentPresence, queryVaultCaPresence } from './vault-read.js';
import { secretFingerprint } from './fleet-lock.js';
import type { InitOptions } from '../commands/init.js';
import { defaultAgentKeyPath, legacyAgentKeyPath, legacyProjectAgentKeyPath } from '../commands/init.js';
import { caCertPath, caKeyPath, legacyProjectCaCertPath, legacyProjectCaKeyPath, agentCertPath, agentKeyPath } from '../config.js';
import type { VersionSet } from '../version-resolver.js';
import { resolveLockstepVersionsOrThrow } from '../version-resolver.js';

const execFileAsync = promisify(execFile);

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
 * The refusal message for a role that was PROVISIONED BY THIS SAME "macf
 * bootstrap apply" run but whose credential is still absent from whatever
 * vault THIS deploy attempt is reading (groundnuty/macf#1183). Deliberately
 * does NOT assert which of the two live causes applies — "the fresh write
 * hasn't reached the vault you pointed `--vault` at" (a pre-run snapshot;
 * see `commands/bootstrap-apply.ts::resolveDeployVaultPath`, the fix that
 * makes THIS message unreachable on apply's own happy path) or "the write
 * itself failed this run" (still genuinely missing everywhere) — because
 * BOTH remain reachable and naming the wrong one would be its own
 * silent-fallback-shaped lie. Keeps the ORIGINAL refusal clause verbatim
 * ("refusing to deploy a partially-materialized workspace") per #1183's own
 * "do not weaken the refusal" requirement — only the diagnosed CAUSE
 * differs from {@link vaultEntryMissingMessage}'s genuinely-unprovisioned
 * case, never the refusal itself. Exported so tests can assert its exact
 * shape without duplicating the prose inline, mirroring this file's own
 * `keyFingerprintMismatchMessage`/`caFingerprintMismatchMessage` convention.
 */
export function vaultEntryMissingProvisionedThisRunMessage(missing: readonly string[], role: string, fleetName: string): string {
  return (
    `vault has no ${missing.join('/')} for role "${role}" (fleet "${fleetName}") — refusing to deploy a ` +
    'partially-materialized workspace (that refusal stands; only the cause is different here). ' +
    `Role "${role}" WAS provisioned by this same "macf bootstrap apply" run — its GitHub identity was created ` +
    "and its credential was composed into a vault this run wrote — but the vault THIS deploy attempt is " +
    'reading still does not have it: either that write has not reached the vault you pointed --vault at, or ' +
    'the write itself failed (check the "Vault:" line earlier in this run\'s own output). Re-run ' +
    '`macf bootstrap apply` — its own deploy phase reads the vault it just composed — or run ' +
    `\`macf fleet deploy --agent ${role} ...\` once you have a local, decryptable copy of that vault.`
  );
}

/**
 * The refusal message for a role that has NO vault entry at all — the
 * genuine "never provisioned, or the vault the operator pointed at simply
 * doesn't hold it" case, unchanged since before #1183. Extracted (not
 * inlined) so {@link extractAgentVaultCredentials} chooses between this and
 * {@link vaultEntryMissingProvisionedThisRunMessage} without duplicating
 * either string.
 */
export function vaultEntryMissingMessage(missing: readonly string[], role: string, fleetName: string): string {
  return (
    `vault has no ${missing.join('/')} for role "${role}" (fleet "${fleetName}") — refusing to deploy a ` +
    'partially-materialized workspace. Confirm this agent was actually provisioned by `macf bootstrap apply` ' +
    'and its identity landed in this vault.'
  );
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
 *
 * `provisionedThisRun` (groundnuty/macf#1183) is the ONLY discriminator
 * between {@link vaultEntryMissingProvisionedThisRunMessage} and
 * {@link vaultEntryMissingMessage} — defaults to `false`, the honest-unknown
 * floor: a caller with no "was this created THIS run" signal (the standalone
 * `macf fleet deploy` command; any pre-#1183 call site) gets the ORIGINAL,
 * unchanged wording, never a guess. Only `apply`'s own embedded deploy phase
 * (`commands/bootstrap-apply.ts`, which tracks `AgentApplyOutcome.status ===
 * 'created'` per role from THIS run's `applyFleet` result) ever passes `true`.
 */
export function extractAgentVaultCredentials(
  raw: Readonly<Record<string, string>>,
  fleetName: string,
  role: string,
  provisionedThisRun = false,
): AgentVaultCredentials {
  const presence = queryVaultAgentPresence(raw, fleetName, role);
  const missing: string[] = [];
  if (!presence.appId.present) missing.push('app_id');
  if (!presence.installId.present) missing.push('install_id');
  if (!presence.privateKey.present) missing.push('private_key');
  if (missing.length > 0) {
    throw new FleetDeployError(
      'vault_entry_missing_for_role',
      provisionedThisRun
        ? vaultEntryMissingProvisionedThisRunMessage(missing, role, fleetName)
        : vaultEntryMissingMessage(missing, role, fleetName),
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
 * No plaintext ever touches disk anywhere else in the APP-KEY path (the
 * decrypted PEM otherwise lives only in {@link AgentVaultCredentials}, a
 * local variable). The per-project CA's PRIVATE key (macf#976, below) reuses
 * this exact function — same secret-material contract, same 0600 mode.
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

/**
 * Sibling of {@link writeAgentKeyAtomic0600} for the CA's PUBLIC cert
 * (mode `0644` — not secret; macf#976). Identical mkdtemp/chmod/rename
 * atomic-write dance (see that function's doc for the full crash-safety
 * rationale) — a second, hand-duplicated ~15-line copy rather than threading
 * a `mode` parameter through the existing, already-tested
 * `writeAgentKeyAtomic0600`: that function's 0600 contract is the one thing
 * in this module that must never regress, so it stays untouched and this
 * sibling carries the only other mode this module ever writes.
 */
export function writeCaCertAtomic0644(destPath: string, certPem: string): void {
  const dir = dirname(destPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const scratchDir = mkdtempSync(join(dir, '.macf-ca-cert-'));
  try {
    chmodSync(scratchDir, 0o700);
    const scratchFile = join(scratchDir, 'cert.pem');
    writeFileSync(scratchFile, certPem, { mode: 0o644 });
    chmodSync(scratchFile, 0o644);
    renameSync(scratchFile, destPath);
    chmodSync(destPath, 0o644);
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
 *
 * `cloneUrl` may be async (macf#968): {@link deployAgent} passes a builder
 * that mints a clone-auth token LAZILY, only when this function is actually
 * about to clone — never on the `'skipped-existing'` path, so a re-run
 * against an already-deployed workspace stays a zero-network no-op exactly
 * as it was before #968.
 */
export async function ensureAgentWorkspaceCloned(
  repo: string,
  destDir: string,
  cloneRepo: (url: string, destDir: string) => Promise<void>,
  cloneUrl: (repo: string) => string | Promise<string> = defaultCloneUrl,
): Promise<WorkspaceMaterializeOutcome> {
  if (existsSync(destDir) && !isEmptyDir(destDir)) {
    return 'skipped-existing';
  }
  mkdirSync(dirname(destDir), { recursive: true });
  await cloneRepo(await cloneUrl(repo), destDir);
  return 'cloned';
}

// --- Authenticated clone (macf#968) ---
//
// The first-ever live `fleet deploy` 401'd cloning a freshly-provisioned
// agent's (private, by construction) repo: `defaultCloneUrl` above is
// anonymous, and nothing authenticated it even though `deployAgent` had
// already decrypted this exact role's App credentials from the vault 60
// lines earlier. The fix mints a short-lived installation token from those
// SAME credentials and authenticates the clone with it — never a second
// on-disk credential, never a token that outlives this one clone.

const AUTHENTICATED_URL_PATTERN = /^https:\/\/x-access-token:([^@]+)@(.+)$/;

/**
 * The token alphabet this module is willing to embed in a `git -c
 * url.<X>.insteadOf=<Y>` config VALUE. Two silent-fallback shapes this
 * guards against (both would reproduce macf#968 in a new disguise if
 * unchecked): a token containing `=` would truncate at the FIRST `=` when
 * git parses `-c <name>=<value>` — the config name would still be dot-valid
 * (no parse error), the rewrite would just never match, and the clone would
 * silently fall through to authenticating as nobody; an EMPTY token would
 * make {@link parseAuthenticatedUrl} fail to recognize its own output as
 * authenticated (the `[^@]+` requires ≥1 char), same silent anonymous
 * result. GitHub's installation-token alphabet (base64url, unpadded) is a
 * subset of this — this is a defensive upper bound, not a format check.
 */
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;

/**
 * The clone-auth URL shape this module both builds ({@link authenticatedCloneUrl}) and parses ({@link parseAuthenticatedUrl}) — `x-access-token` is GitHub's documented username convention for authenticating over HTTPS with an installation token (no password).
 *
 * Refuses (never silently degrades) a token outside {@link SAFE_TOKEN_PATTERN}
 * — see that constant's doc for why. The refusal message never includes the
 * token itself, only that its SHAPE was rejected.
 */
export function authenticatedCloneUrl(repo: string, token: string): string {
  if (!SAFE_TOKEN_PATTERN.test(token)) {
    throw new FleetDeployError(
      'clone_token_unsafe_shape',
      'minted clone-auth token has an unexpected shape (contains a character outside [A-Za-z0-9._~-], or is empty) — ' +
        'refusing to embed it in a git-config value where it could silently break the insteadOf rewrite and fall back ' +
        'to an anonymous, unauthenticated clone. This message never includes the token itself.',
    );
  }
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/**
 * Inverse of {@link authenticatedCloneUrl} — given ANY url of that shape
 * (not just a `github.com` one; {@link realAuthenticatedCloneRepo}'s own
 * tests exercise other hosts so they never need real network), returns the
 * embedded token plus the CLEAN, credential-free counterpart. Returns
 * `undefined` for a url that doesn't carry the `x-access-token:` marker —
 * the caller's signal to fall back to a plain, unauthenticated clone
 * (macf#968 point 4's "anonymous stays a fallback" case).
 */
export function parseAuthenticatedUrl(url: string): { readonly token: string; readonly cleanUrl: string } | undefined {
  const m = AUTHENTICATED_URL_PATTERN.exec(url);
  if (!m) return undefined;
  const token = m[1];
  const rest = m[2];
  if (token === undefined || rest === undefined) return undefined;
  return { token, cleanUrl: `https://${rest}` };
}

/**
 * Replace every literal occurrence of `token` in `text` — used ONLY to keep
 * a minted clone-auth token out of a thrown error's message (macf#968 point
 * 3: `execFile`'s rejected-promise error ECHOES THE FULL COMMAND LINE it
 * ran, including any `-c` flag value, so an authenticated clone URL passed
 * straight through would leak the token into every failure log/reason/
 * outcome). A plain substring replace, not a regex over "anything
 * URL-shaped" — the exact token is known, so match it exactly rather than
 * risk over- or under-redacting adjacent text.
 */
function scrubToken(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join('<redacted>') : text;
}

/**
 * Build the `git` argv for cloning `cloneUrl` into `destDir`, but CONNECTING
 * via `connectUrl` instead when the two differ — `git -c
 * url.<connectUrl>.insteadOf=<cloneUrl>`, the SAME idiom `coordination.md
 * §Token & Git Hygiene` rule 4 mandates for `git push` ("never bake tokens
 * into a remote"), generalized here to `git clone`. Empirically verified
 * (macf#968's investigation) that `git clone` records the LITERAL argument
 * it was given (`cloneUrl`) into the new repo's `.git/config` — the
 * `insteadOf` rewrite happens only at the transport layer when git actually
 * opens the connection, never at what `git remote add` persists. So when
 * `connectUrl` carries a credential and `cloneUrl` doesn't, the token
 * authenticates the fetch WITHOUT ever touching disk in the cloned repo —
 * not even transiently.
 *
 * Pure — no subprocess. Exported so a test can assert the exact argv
 * WITHOUT running git, closing the specific gap a two-argument helper like
 * {@link cloneViaInsteadOf} leaves open: calling it with `(cloneUrl,
 * connectUrl)` swapped is a silent argument-order bug (the token would land
 * in `.git/config`) that no test exercising the two arguments EQUAL, or
 * exercising this function only through its own direct call, would catch.
 * {@link cloneArgsFor} pins the actual composition `realAuthenticatedCloneRepo`
 * uses so that inversion has a test that fails.
 */
export function insteadOfCloneArgs(cloneUrl: string, connectUrl: string, destDir: string): readonly string[] {
  const configArgs = connectUrl !== cloneUrl ? ['-c', `url.${connectUrl}.insteadOf=${cloneUrl}`] : [];
  return [...configArgs, 'clone', '--depth', '1', cloneUrl, destDir];
}

/**
 * The exact argv {@link realAuthenticatedCloneRepo} runs, pure and
 * subprocess-free — `url` is either the authenticated form ({@link
 * authenticatedCloneUrl}) or a plain anonymous url. THE decisive assertion
 * surface for macf#968: the clone-target argv element (index `-2`) and
 * `destDir` (index `-1`) never carry the token, while the `-c` value (when
 * present) does — asserting the full array pins the argument ORDER, not
 * just that a token appears somewhere.
 */
export function cloneArgsFor(url: string, destDir: string): readonly string[] {
  const parsed = parseAuthenticatedUrl(url);
  return insteadOfCloneArgs(parsed?.cleanUrl ?? url, url, destDir);
}

/**
 * Clone `cloneUrl` into `destDir`, connecting via `connectUrl` — the real
 * subprocess leaf behind {@link insteadOfCloneArgs}'s argv. Exported ONLY so
 * the test suite can prove the git MECHANISM against a real local fixture
 * (two arbitrary `file://` paths — no network, no real GitHub), asserting
 * the RESULTING `.git/config` directly. {@link realAuthenticatedCloneRepo}
 * is still the only production entry point.
 */
export async function cloneViaInsteadOf(cloneUrl: string, connectUrl: string, destDir: string): Promise<void> {
  await execFileAsync('git', insteadOfCloneArgs(cloneUrl, connectUrl, destDir));
}

/**
 * Real, authenticated `git clone --depth 1` — the production default for
 * {@link FleetDeployDeps.cloneRepo}. Runs exactly {@link cloneArgsFor}'s
 * argv, so the origin's stored remote ends up credential-free (see {@link
 * insteadOfCloneArgs}'s doc), and any failure's message has the token
 * scrubbed out before it propagates — `deployAgent`'s `reason` and, from
 * there, `macf fleet deploy`'s console/`--json` output would otherwise leak
 * it on every clone failure (macf#968, the exact shape the reported bug's
 * own error message demonstrated).
 */
export async function realAuthenticatedCloneRepo(url: string, destDir: string): Promise<void> {
  const parsed = parseAuthenticatedUrl(url);
  try {
    await execFileAsync('git', cloneArgsFor(url, destDir));
  } catch (err) {
    const msg = errMessage(err);
    // Deliberate deviation from this repo's usual `{ cause: err }`
    // convention: `err` itself (its `.message`, and `execFileException`'s
    // `.cmd`) carries the RAW, unredacted clone-auth token — `execFile`'s
    // rejected error echoes the full argv it ran, including the `-c
    // url....` flag value (macf#968 point 3). Attaching `err` as `cause`
    // would undo the entire point of this catch: Node's default Error
    // formatting prints a `.cause` chain, so a bare `console.error(err)`
    // downstream would still leak the token even with a scrubbed
    // top-level `.message`. Every field of the thrown error here is
    // deliberately fresh and secret-free — no cause chain.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(parsed !== undefined ? scrubToken(msg, parsed.token) : msg);
  }
}

/**
 * Real clone-auth token mint — the production default for {@link
 * FleetDeployDeps.mintCloneToken}. Reuses `@groundnuty/macf-core`'s
 * `generateToken` (the SAME helper every other `gh`-API path in this CLI
 * already shells through — never a second JWT/token-mint implementation,
 * per macf#968's own instruction). `forceMint: true` bypasses
 * `generateToken`'s ambient-`GH_TOKEN`-env shortcut (the macf#338 lesson,
 * applied at a new call site): whatever token the shell `fleet deploy` runs
 * from happens to have set — the OPERATOR's own, or nothing at all — is NOT
 * this role's identity; only the vault-derived {@link TokenSource} may
 * authenticate as this agent.
 */
export async function realMintCloneToken(source: TokenSource): Promise<string> {
  return generateToken(source, { forceMint: true });
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

// --- Per-project CA materialization from the vault (macf#976) ---
//
// The gap this closes: `deployAgent` decrypts the fleet vault (a few lines
// above) which — when the fleet's CA ceremony has run (`apply-ca.ts`) —
// holds the per-project CA's key+cert right alongside the App credentials
// this file already materializes. Nothing ever carried the CA the same 60
// bytes further: `deploy` finished and told the operator to "obtain it from
// the fleet vault" — the vault it had JUST decrypted and let go of. Third
// instance of this shape in this subsystem (#862, #968, now this) — the
// credential is decrypted, the consumer path (here: `initAgent`'s existing,
// unconditional "CA present locally -> issue agent cert" branch in
// `commands/init.ts`) was written independently, and nothing connected them.
//
// **Never a second CRYPTO implementation.** {@link materializeProjectCa}
// only decodes + writes bytes — it has no `generateAgentCert` (or
// `createCA`) call anywhere in its call graph. The agent's own leaf-cert
// issuance is NOT duplicated here either (macf#1000; a PRIOR version of
// this file had a second `generateAgentCert` call site,
// `issueAgentCertIfNeeded`, that ran immediately before `deployAgent`
// delegated to `initAgent` — whose own cert-flow branch is unconditional,
// so the two writers raced the SAME file every run and agreed only by
// luck). `deployAgent` now materializes the CA onto disk here and leaves
// ALL cert issuance to `initAgent`'s `commands/init.ts::
// issueGithubModeAgentCert` (the SAME `@groundnuty/macf-core`
// `loadCA`/`generateAgentCert` primitives `certs.ts::certsRotate` also
// reuses) — `deps.initAgent`'s `skipCertIfPresent: true` argument, set
// below in {@link deployAgent}, is what keeps that ONE call idempotent
// across re-runs.

export type CaMaterializeOutcome =
  | { readonly status: 'materialized'; readonly certFingerprint: string }
  | { readonly status: 'already-current'; readonly certFingerprint: string }
  /** The fleet vault has no per-project CA at all (this fleet's CA ceremony hasn't run, or predates it) — NOT a failure; `deployAgent` degrades gracefully, same as it always has. */
  | { readonly status: 'vault-absent' };

export interface CaPathDeps {
  /**
   * Resolves the OWNER-scoped conventional CA path for a fleet (macf#1277).
   * Takes `owner` explicitly — not captured in a closure — so a caller
   * (test override included) cannot accidentally vary only by `fleetName`
   * and silently reintroduce the cross-owner collision this issue reports:
   * the TYPE forces every call site to supply an owner.
   */
  readonly caCertPathFor: (owner: string, fleetName: string) => string;
  readonly caKeyPathFor: (owner: string, fleetName: string) => string;
}

/** The vault's decoded CA material, carried on {@link CaDetection}'s `'absent'`/`'mismatch'` variants — the only two that may need to WRITE it. Never carried on `'vault-absent'`/`'match'`, which never write. */
interface CaVaultMaterial {
  readonly certPem: string;
  readonly keyPem: string;
  readonly fingerprint: string;
}

/** Pure local-vs-vault CA comparison — never writes, never throws except {@link FleetDeployError} `vault_entry_missing_for_role` (an internal-inconsistency guard, not a genuine refusal path). */
type CaDetection =
  | { readonly kind: 'vault-absent' }
  | { readonly kind: 'absent'; readonly material: CaVaultMaterial }
  | { readonly kind: 'match'; readonly certFingerprint: string }
  | { readonly kind: 'mismatch'; readonly localFingerprint: string; readonly vaultFingerprint: string; readonly material: CaVaultMaterial };

/**
 * Decode the per-project CA out of an already-decrypted vault raw map and
 * compare it against whatever is on disk — no writes. Split out of
 * {@link materializeProjectCa} (macf#982) so {@link deployAgent} can PEEK at
 * the CA's status before EITHER this or {@link detectKeyStatus}'s sibling
 * peek performs any write — that ordering is what makes the combined
 * both-stale refusal possible; see {@link deployAgent}'s own doc.
 *
 * **Compares by PUBLIC-KEY (cert) fingerprint only — never raw key
 * material.** {@link caCertFingerprint} hashes the cert's DER bytes (a
 * public, non-secret value); the private key is never compared byte-for-byte
 * and never appears in any thrown message (both fingerprints named, neither
 * PEM echoed — see {@link caFingerprintMismatchMessage}).
 *
 * A local pair that is only PARTIALLY present (exactly one of cert/key on
 * disk) is treated the same as `'absent'`: a lone cert or lone key is not a
 * usable CA to protect, so the complete, vault-confirmed pair materializes
 * fresh over it.
 *
 * **macf#1277 owner-scoping read-old-write-new, ONE legacy tier
 * (fingerprint-gated).** When the owner-scoped conventional cert
 * (`deps.caCertPathFor(owner, fleetName)`) is absent, this ALSO checks the
 * pre-#1277 project-scoped, owner-less legacy path
 * ({@link legacyProjectCaCertPath}/{@link legacyProjectCaKeyPath}) — but
 * ONLY trusts it when its fingerprint matches THIS fleet's vault CA (the
 * SAME discipline `resolveDefaultKeyPath` applies to the App key one layer
 * up). A legacy CA that does NOT match is a DIFFERENT fleet's/owner's —
 * silently irrelevant, never adopted, never compared for a refusal; the
 * conventional owner-scoped path materializes fresh over it exactly as if
 * no legacy file existed. This is the ONLY legacy tier for the CA (unlike
 * the key's two): the CA path was already project-scoped before #1277 —
 * see `config.ts::legacyProjectCaDir`'s own doc for why there is no flatter
 * pre-project-scoped generation to fall through to.
 *
 * **`allowLegacyFallback` gates the legacy check — mirrors the App key's
 * ternary-level split.** `deployAgent` passes `true` ONLY when NEITHER
 * `deps.caCertPathFor` NOR `deps.caKeyPathFor` was overridden by the
 * caller (the genuine unoverridden default). An override "fully owns path
 * resolution and never sees the legacy fallback either" — same contract
 * `keyPathFor`'s own doc states for the App key, and for the identical
 * reason: `legacyProjectCaCertPath`/`legacyProjectCaKeyPath` are NOT
 * injectable (always the REAL homedir), so a scratch-directory test
 * override must never have this reached behind its back. Defaults to
 * `false` — every existing direct caller of {@link materializeProjectCa}
 * (this module's own unit tests) passes a scratch-dir override and
 * therefore gets NO legacy lookup unless it opts in explicitly.
 */
function detectCaStatus(
  raw: Readonly<Record<string, string>>,
  owner: string,
  fleetName: string,
  deps: CaPathDeps,
  allowLegacyFallback: boolean,
): CaDetection {
  const presence = queryVaultCaPresence(raw, fleetName);
  if (!(presence.caKey.present && presence.caCert.present)) {
    return { kind: 'vault-absent' };
  }

  const seg = toVariableSegment(fleetName);
  const vaultKeyB64 = raw[`MACF_${seg}_CA_KEY_B64`];
  const vaultCertB64 = raw[`MACF_${seg}_CA_CERT_B64`];
  // The presence check above already proved these are defined + non-empty;
  // this defensive re-check (never a `!` assertion) mirrors
  // `extractAgentVaultCredentials`'s own posture — a future drift between
  // `queryVaultCaPresence`'s field derivation and this read-back stays a
  // visible failure, not an unsafe cast.
  if (vaultKeyB64 === undefined || vaultCertB64 === undefined) {
    throw new FleetDeployError(
      'vault_entry_missing_for_role',
      `internal inconsistency: CA presence check reported complete for fleet "${fleetName}" but the raw fields ` +
        'read back undefined — this indicates a bug in the vault-key derivation, not a genuinely absent credential.',
    );
  }
  const certPem = Buffer.from(vaultCertB64, 'base64').toString('utf-8');
  const keyPem = Buffer.from(vaultKeyB64, 'base64').toString('utf-8');
  const material: CaVaultMaterial = { certPem, keyPem, fingerprint: caCertFingerprint(certPem) };

  const conventionalCertPath = deps.caCertPathFor(owner, fleetName);
  const conventionalKeyPath = deps.caKeyPathFor(owner, fleetName);
  let caCertFilePath = conventionalCertPath;
  let caKeyFilePath = conventionalKeyPath;
  if (allowLegacyFallback && !existsSync(conventionalCertPath)) {
    const legacyCertPath = legacyProjectCaCertPath(fleetName);
    const legacyKeyPath = legacyProjectCaKeyPath(fleetName);
    if (existsSync(legacyCertPath) && existsSync(legacyKeyPath)) {
      try {
        if (caCertFingerprint(readFileSync(legacyCertPath, 'utf-8')) === material.fingerprint) {
          caCertFilePath = legacyCertPath;
          caKeyFilePath = legacyKeyPath;
        }
      } catch {
        // Unparseable legacy CA — not this fleet's concern; fall through
        // to fresh materialization at the conventional path below, exactly
        // as if the legacy file didn't exist.
      }
    }
  }

  const localComplete = existsSync(caCertFilePath) && existsSync(caKeyFilePath);
  if (!localComplete) {
    return { kind: 'absent', material };
  }

  const localFingerprint = caCertFingerprint(readFileSync(caCertFilePath, 'utf-8'));
  if (localFingerprint === material.fingerprint) {
    return { kind: 'match', certFingerprint: localFingerprint };
  }
  return { kind: 'mismatch', localFingerprint, vaultFingerprint: material.fingerprint, material };
}

/**
 * The refusal message for a LOCAL-vs-vault CA fingerprint mismatch — names
 * BOTH fingerprints, BOTH remedies, plus the `--force-ca` opt-in (macf#982),
 * mirroring {@link keyFingerprintMismatchMessage}'s shape exactly so an
 * operator who has already internalized the App-key refusal recognizes this
 * one immediately. Exported so tests can assert its exact shape without
 * duplicating the prose inline.
 */
export function caFingerprintMismatchMessage(
  fleetName: string,
  caCertFilePath: string,
  caKeyFilePath: string,
  localFingerprint: string,
  vaultFingerprint: string,
): string {
  return (
    `local per-project CA at "${caCertFilePath}" (fingerprint ${localFingerprint}) does NOT match fleet ` +
    `"${fleetName}"'s vaulted CA (fingerprint ${vaultFingerprint}) — refusing to overwrite a CA that may be ` +
    'in independent use. This is expected after a fleet rebuild — a destroyed-and-rebuilt fleet mints a NEW CA ' +
    'by construction, so a CA left on disk by a PREVIOUS fleet of the same name is stale. ' +
    `Remedy 1: remove or rename ${caCertFilePath} and ${caKeyFilePath} so the next deploy re-materializes both ` +
    'from the vault. Remedy 2: if this CA was deliberately rotated locally without also updating the vault, ' +
    'reconcile it with the vault, then re-run. Or pass --force-ca to re-materialize from the vault now, without ' +
    'hand-deleting the files.'
  );
}

/**
 * Always writes to the OWNER-SCOPED conventional path — never the legacy
 * tier, even when `detectCaStatus`'s 'absent'/'mismatch' detection was
 * reached via a legacy candidate that failed to match. "No migration of
 * on-disk material" (macf#1157/#1214's own ruling, applied here): a fresh
 * materialize always lands at the CURRENT conventional generation.
 */
function writeCaMaterial(owner: string, fleetName: string, deps: CaPathDeps, material: CaVaultMaterial): CaMaterializeOutcome {
  writeAgentKeyAtomic0600(deps.caKeyPathFor(owner, fleetName), material.keyPem);
  writeCaCertAtomic0644(deps.caCertPathFor(owner, fleetName), material.certPem);
  return { status: 'materialized', certFingerprint: material.fingerprint };
}

/**
 * Make the per-project CA usable locally at the SAME owner-scoped
 * conventional path `certs.ts`/`commands/init.ts` already read from
 * ({@link caCertPath}/{@link caKeyPath} by default; macf#1277) — mint-or-
 * reuse, NEVER re-mint, mirroring `apply-ca.ts::resolveCaCert`'s own "never
 * mint twice" discipline one layer down (this function never mints
 * anything; it only ever writes what the vault already holds). `owner` is
 * REQUIRED (not optional) — see {@link CaPathDeps}'s own doc for why the
 * signature forces it rather than leaving it closure-captured.
 *
 * A LOCAL CA that exists but DIFFERS from the vault's refuses loudly by
 * default (never silently overwrites — same "orphan a real credential"
 * hazard `apply-ca.ts`'s own doc names for the mint side), UNLESS `forceCa`
 * is `true` (macf#982; CLI flag `--force-ca`), in which case it
 * re-materializes from the vault instead — the symmetric counterpart to
 * {@link materializeAgentKey}'s `forceKey`. Defaults to `false`, the SAFER
 * default: a mismatch refuses rather than silently overwriting a CA that
 * may be in independent use.
 *
 * `allowLegacyFallback` (macf#1277) — see {@link detectCaStatus}'s own doc.
 * Defaults to `false`: a direct caller of this exported function (every
 * existing unit test) gets NO pre-#1277 legacy-tier lookup against the
 * REAL homedir unless it opts in explicitly. `deployAgent` passes `true`
 * only for its own genuinely-unoverridden default `deps.caCertPathFor`/
 * `caKeyPathFor`.
 */
export async function materializeProjectCa(
  raw: Readonly<Record<string, string>>,
  owner: string,
  fleetName: string,
  deps: CaPathDeps,
  forceCa = false,
  allowLegacyFallback = false,
): Promise<CaMaterializeOutcome> {
  const detection = detectCaStatus(raw, owner, fleetName, deps, allowLegacyFallback);
  switch (detection.kind) {
    case 'vault-absent':
      return { status: 'vault-absent' };
    case 'match':
      return { status: 'already-current', certFingerprint: detection.certFingerprint };
    case 'absent':
      return writeCaMaterial(owner, fleetName, deps, detection.material);
    case 'mismatch':
      if (forceCa) {
        return writeCaMaterial(owner, fleetName, deps, detection.material);
      }
      throw new FleetDeployError(
        'ca_mismatch_local_vs_vault',
        caFingerprintMismatchMessage(
          fleetName,
          deps.caCertPathFor(owner, fleetName),
          deps.caKeyPathFor(owner, fleetName),
          detection.localFingerprint,
          detection.vaultFingerprint,
        ),
      );
  }
}

// --- Agent leaf-cert issuance (macf#976; delegated entirely to `initAgent`
// as of macf#1000 — see this module's doc "Never a second CRYPTO
// implementation" above) ---

/**
 * The final on-disk state of the agent's own mTLS leaf cert when a
 * `deployAgent` run ends (macf#1000 — renamed in spirit, not in shape, from
 * "what the removed `issueAgentCertIfNeeded` step did" to "what's actually
 * at `agentCertPath(destDir)`/`agentKeyPath(destDir)` now"). `deployAgent`
 * computes this by checking file existence immediately BEFORE and AFTER its
 * single `deps.initAgent(...)` call — never by asking `initAgent` what it
 * did (it returns `void`) and never by writing the cert itself.
 *
 * Existence-only, same as `initAgent`'s own `skipCertIfPresent` contract: a
 * `'skipped-existing'` result does NOT mean the pre-existing cert is still
 * signed by the CURRENT CA, only that a cert+key pair was already there and
 * `initAgent` left it alone.
 */
export type AgentCertIssueOutcome = 'issued' | 'skipped-existing';

function caMaterializeLogLine(role: string, ca: CaMaterializeOutcome): string {
  switch (ca.status) {
    case 'materialized':
      return `Role "${role}": per-project CA materialized from the fleet vault (cert fingerprint ${ca.certFingerprint}).`;
    case 'already-current':
      return `Role "${role}": per-project CA already present locally and matches the fleet vault — not re-issued.`;
    case 'vault-absent':
      return `Role "${role}": fleet vault has no per-project CA yet — skipping cert issuance (run \`macf bootstrap apply\` to mint one).`;
  }
}

// --- The per-agent orchestration ---

export interface FleetDeployDeps {
  readonly readVault: (opts: VaultReadOptions) => Promise<Readonly<Record<string, string>>>;
  /** Real, authenticated `git clone` — a thin network I/O leaf, injectable so tests never touch the network. Production default: {@link realAuthenticatedCloneRepo}. */
  readonly cloneRepo: (url: string, destDir: string) => Promise<void>;
  /** The REAL `initAgent` (`commands/init.ts`) in production; tests inject a recording fake so workspace-generation side effects (network version-resolution, plugin fetch, cert gen) never run in a unit test. */
  readonly initAgent: (projectDir: string, opts: InitOptions) => Promise<void>;
  /**
   * Mints a short-lived installation token from the SAME vault credentials
   * this run already decrypted for this role, used ONLY to authenticate the
   * clone above (macf#968 — a bootstrap-provisioned agent repo is private
   * by construction; an anonymous clone 401s). Production default:
   * {@link realMintCloneToken}. **Tests MUST override this** — the default
   * shells out to the real `gh` binary. Required (not optional, unlike
   * `keyPathFor`/`log` below) because a forgotten override here would be a
   * SILENT real-network call in what every caller of this module assumes is
   * an offline test — the exact silent-fallback shape `silent-fallback-
   * hazards.md` catalogs, not a risk worth taking for one fewer field.
   */
  readonly mintCloneToken: (source: TokenSource) => Promise<string>;
  /**
   * Resolves the destination App-key path for a role. Defaults to
   * {@link resolveDefaultKeyPath} — the owner+fleet-scoped conventional
   * `~/.macf/keys/<owner>/<fleet>/<role>.pem` (macf#1157 fleet-scoping;
   * macf#1214 added the `<owner>` segment — matches `initAgent`'s own
   * internal default when `--key-path` is omitted, see
   * `commands/init.ts::ingestAndResolveKeyPath`), falling back through TWO
   * older-generation candidates — the pre-#1214 fleet-scoped, owner-less
   * `~/.macf/keys/<fleet>/<role>.pem`, then the pre-#1157 flat
   * `~/.macf/keys/<role>.pem` — ONLY when a key already lives at that tier
   * AND its fingerprint matches this role's vault entry (see
   * {@link resolveDefaultKeyPath}'s own doc for the full "read-old-write-new"
   * rule). **Tests MUST override this to a scratch directory** — the
   * default resolves under the REAL operator's home directory, which may
   * hold a real, live fleet's key (and skips the legacy-path fallback
   * entirely — that fallback only ever runs for the unoverridden default,
   * see {@link deployAgent}'s call site).
   */
  readonly keyPathFor?: (role: string) => string;
  /**
   * Resolves the owner+project-scoped CA cert/key paths (macf#976;
   * owner-scoped as of macf#1277). Defaults to {@link caCertPath}/
   * {@link caKeyPath} (`~/.macf/certs/<owner>/<project>/ca-{cert,key}.pem`
   * — the SAME conventional path `certs.ts` and `commands/init.ts`'s
   * GitHub-mode cert-flow resolve to by default via
   * `config.ts::resolveExistingCaPaths`). **Tests MUST override both to
   * a scratch directory** — the default resolves under the REAL operator's
   * home directory, which may hold a real, live fleet's CA.
   *
   * **Overriding this while `deps.initAgent` is the REAL `initAgent`
   * (macf#1000) breaks agent-cert issuance silently.** `commands/init.ts`'s
   * GitHub-mode cert-flow has NO path-override seam of its own — it always
   * resolves via `config.ts::resolveExistingCaPaths(owner, project)`
   * directly. If this override points `deployAgent`'s OWN CA materialize
   * step somewhere else, `initAgent` looks for the CA at the conventional
   * (un-overridden) path, finds nothing, and silently takes its "No CA
   * found locally" branch — the agent cert is never issued, and nothing
   * throws. This override exists for tests that inject a FAKE `initAgent`
   * (which never reads any path itself); a test exercising the real
   * integration must leave this at its default. See
   * `fleet-deploy.test.ts`'s "REAL `initAgent` — the decisive seam-call-count
   * proof" block for the pattern that stays correct.
   */
  readonly caCertPathFor?: (owner: string, fleetName: string) => string;
  readonly caKeyPathFor?: (owner: string, fleetName: string) => string;
  readonly log?: (line: string) => void;
  /**
   * Opt-in (macf#975; CLI flag `--force-key`) to re-materialize the on-disk
   * App key from the vault when its fingerprint does NOT match the vault's —
   * the common case right after a fleet rebuild, where hand-deleting a
   * private key to unblock a redeploy is a hostile ask. Defaults to `false`
   * (undefined), which is the SAFER default: a mismatch refuses rather than
   * silently overwriting a key the operator may have rotated deliberately on
   * GitHub. Has NO effect when the on-disk key already matches the vault
   * (that path is always `'skipped-existing'`, force or not) or when no key
   * is present yet (always `'written'` either way).
   */
  readonly forceKey?: boolean;
  /**
   * Opt-in (macf#982; CLI flag `--force-ca`) to re-materialize the on-disk
   * per-project CA from the vault when its fingerprint does NOT match the
   * vault's — the symmetric counterpart to {@link forceKey}, for the SAME
   * post-rebuild shape: a destroyed-and-rebuilt fleet mints a NEW CA by
   * construction, so a CA left on disk by a previous fleet of the same name
   * is stale. Defaults to `false` (undefined), the SAFER default: a
   * mismatch refuses rather than silently overwriting a CA that may be in
   * independent use. Has NO effect when the on-disk CA already matches the
   * vault (always `'already-current'`, force or not) or when no local CA is
   * present yet (always `'materialized'` either way). Threaded straight
   * through to {@link materializeProjectCa}'s `forceCa` parameter.
   */
  readonly forceCa?: boolean;
  /**
   * Roles this SAME "macf bootstrap apply" run minted a fresh GitHub App
   * identity for (groundnuty/macf#1183) — `AgentApplyOutcome.status ===
   * 'created'` per role, per `applyFleet`'s own result. `undefined` for
   * every caller with no "this run" concept at all (the standalone
   * `macf fleet deploy` CLI command — `commands/fleet-deploy.ts::resolveDeps`
   * never sets this field), which is exactly the honest-unknown floor
   * {@link extractAgentVaultCredentials}'s `provisionedThisRun` default
   * relies on: no signal in, no guess out, original wording. Only
   * `commands/bootstrap-apply.ts`'s embedded deploy phase ever populates
   * this, via `provisionedThisRunRoles(result)`.
   */
  readonly rolesProvisionedThisApplyRun?: ReadonlySet<string>;
  /**
   * Resolves the `{cli, plugin, actions}` version triple to pass to
   * `initAgent` ONLY when `manifest.versions` is undeclared (macf#1406 —
   * "no opinion" per `version-target.ts`'s own doc, so this run resolves
   * "whatever the CLI currently latest-resolves to" rather than pinning
   * nothing). Defaults to the REAL {@link resolveLockstepVersionsOrThrow}
   * (network I/O — a genuine leaf, same shape as `mintCloneToken`/
   * `cloneRepo` above). **Tests SHOULD override this** whenever their
   * fixture manifest omits `versions:` — every existing test's fixture
   * declares `versions: { macf, actions }`, so this seam is unreached by
   * them and stays a real, uninjected network call only for a fixture that
   * deliberately exercises the undeclared-versions path.
   *
   * See {@link deployAgent}'s own call site for why `manifest.versions`
   * being declared bypasses this ENTIRELY (both `cliVersion` AND
   * `pluginVersion` are then derived straight from the manifest, in
   * lockstep, with zero network calls) — this seam only fires for the
   * "the manifest genuinely has no opinion" branch.
   */
  readonly resolveVersions?: () => Promise<VersionSet>;
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
      /**
       * Non-secret `sha256:<hex>` over the RAW PEM (`fleet-lock.ts::secretFingerprint`)
       * — proves "the same key that's in the vault" without ever carrying the
       * key itself. **Always describes the key that was ACTUALLY used**
       * (macf#975; #970 recorded this as a pre-existing inaccuracy): the
       * vault's own fingerprint when freshly written or force-re-materialized,
       * or the on-disk key's OWN (verified-matching) fingerprint when
       * `'skipped-existing'` — never assumed equal to the vault's without
       * checking. Deliberately a DIFFERENT fingerprint KIND than the one
       * {@link materializeAgentKey} compares on (see {@link
       * publicKeyFingerprint}'s doc) — this field stays a byte-hash of the
       * PEM for cross-surface comparability with `fleet.lock`'s §D5
       * fingerprint-pairing (`vault-read.ts`'s own doc pins this exact
       * shape as "directly comparable"); the mismatch CHECK instead uses a
       * public-key-derived, encoding-invariant identity fingerprint so a
       * same-key-different-encoding file is never falsely refused.
       */
      readonly keyFingerprint: string;
      /** Per-project CA materialize-or-reuse-or-refuse outcome (macf#976) — never carries key material, only a public cert fingerprint. */
      readonly ca: CaMaterializeOutcome;
      /**
       * The FINAL on-disk state of the agent's own mTLS leaf cert when this
       * `deployAgent` run ends (macf#1000). `'not-attempted'` covers TWO
       * cases, both meaning "no cert landed": {@link CaMaterializeOutcome.status}
       * is `'vault-absent'` (nothing to issue against — `initAgent`'s own
       * cert-flow takes its "No CA found" branch too), OR a CA WAS available
       * but `initAgent`'s cert generation failed internally (it warns +
       * degrades rather than throwing — see
       * `commands/init.ts::issueGithubModeAgentCert`'s catch block). Computed
       * by `deployAgent` checking `agentCertPath(destDir)`/
       * `agentKeyPath(destDir)` existence immediately before and after its
       * single `deps.initAgent(...)` call — never by asking what that call
       * did (it returns `void`) and never by issuing a cert itself. See
       * {@link AgentCertIssueOutcome}'s own doc for the existence-only
       * caveat (a stale-but-present cert reports `'skipped-existing'`, not
       * re-validated against the current CA).
       */
      readonly certIssue: AgentCertIssueOutcome | 'not-attempted';
    }
  | { readonly role: string; readonly status: 'failed'; readonly reason: string };

/** {@link materializeAgentKey}'s return — always describes the key that will actually be used past this point (never assumed). */
interface KeyMaterializeResult {
  readonly keyWrite: 'written' | 'skipped-existing';
  readonly keyFingerprint: string;
}

/**
 * SHA-256 fingerprint of the PUBLIC key derived from a private-key PEM —
 * `sha256:<hex>` over the SPKI DER encoding. **Deliberately NOT
 * {@link secretFingerprint}** (`fleet-lock.ts`), which hashes the raw PEM
 * BYTES: two PEMs encoding the IDENTICAL RSA key (PKCS1 vs PKCS8, different
 * line-wrap, a trailing newline) hash differently there, which would
 * falsely refuse a legitimately-matching on-disk key. Deriving the public
 * key makes the comparison encoding-invariant — the actual "is this the
 * same App identity" check macf#975 needs. This is also the SAME derivation
 * `gh-token-attribution-traps.md` failure-mode-1 already documents for
 * comparing a local key against the fingerprint GitHub itself displays on
 * the App's settings page (`openssl rsa -pubout -outform DER | openssl
 * dgst -sha256`) — so an operator acting on Remedy 2 below (reconcile
 * against GitHub) has a fingerprint that is actually comparable to what
 * GitHub shows, not an opaque hash of private bytes GitHub never exposes.
 * Throws on unparseable input — never returns a fingerprint for a key that
 * isn't one; the caller ({@link materializeAgentKey}) turns that into an
 * operator-actionable refusal, never a raw OpenSSL error string.
 */
export function publicKeyFingerprint(pem: string): string {
  const spkiDer = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(spkiDer).digest('hex')}`;
}

/**
 * {@link publicKeyFingerprint}, refusing loud (never a bare OpenSSL parse
 * error) when `pem` isn't a readable private key. `source` names WHICH side
 * failed to parse (on-disk vs vault) in the refusal — an unparseable
 * on-disk file is a much more common real-world shape (hand-edited,
 * truncated, wrong format) than an unparseable vault entry, but both are
 * refused the same way: loud, before any mint is attempted.
 */
function publicKeyFingerprintOrRefuse(role: string, keyPath: string, pem: string, source: 'on-disk' | 'vault'): string {
  try {
    return publicKeyFingerprint(pem);
  } catch (err) {
    const where = source === 'on-disk' ? `the App key on disk at ${keyPath}` : "this role's vault entry";
    throw new FleetDeployError(
      'agent_key_unparseable',
      `Role "${role}": ${where} is not a readable RSA private key (${errMessage(err)}) — refusing to compare or ` +
        'mint with it.',
    );
  }
}

/**
 * The refusal message for a fingerprint mismatch — names BOTH fingerprints
 * (never the key material itself) and BOTH remedies (macf#975 requirement
 * 2), plus the `--force-key` opt-in (requirement 3). Exported so tests can
 * assert its exact shape without duplicating the prose inline.
 */
export function keyFingerprintMismatchMessage(role: string, keyPath: string, onDiskFingerprint: string, vaultFingerprint: string): string {
  return (
    `Role "${role}": the App key on disk at ${keyPath} does not match this fleet's vault entry ` +
    `(on-disk ${onDiskFingerprint}, vault ${vaultFingerprint}). This is expected after a fleet rebuild — GitHub ` +
    'offers no way to reuse an App whose key you no longer hold, so the on-disk key likely belongs to an App ' +
    'that no longer exists; minting with it would only fail as a bare, unhelpful 401. ' +
    `Remedy 1: remove or rename ${keyPath} so the next deploy re-materializes it from the vault. ` +
    "Remedy 2: if this key was deliberately rotated on GitHub, reconcile the App's registered key with the " +
    'vault, then re-run. Or pass --force-key to re-materialize from the vault now, without hand-deleting the file.'
  );
}

/** Pure on-disk-vs-vault App-key comparison — never writes. */
type KeyDetection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'match'; readonly onDiskPem: string }
  | { readonly kind: 'mismatch'; readonly onDiskFingerprint: string; readonly vaultFingerprint: string };

/**
 * Split out of {@link materializeAgentKey} (macf#982) so {@link deployAgent}
 * can PEEK at the key's status before EITHER this or {@link detectCaStatus}'s
 * sibling peek performs any write — see {@link deployAgent}'s own doc for
 * why that ordering is what makes the combined both-stale refusal possible.
 * May throw {@link FleetDeployError} `agent_key_unparseable` via
 * {@link publicKeyFingerprintOrRefuse} — the SAME refusal this always
 * produced for an unparseable PEM, on either side of the comparison.
 */
function detectKeyStatus(role: string, keyPath: string, vaultPem: string): KeyDetection {
  if (!existsSync(keyPath)) {
    return { kind: 'absent' };
  }
  const onDiskPem = readFileSync(keyPath, 'utf-8');
  const onDiskIdentity = publicKeyFingerprintOrRefuse(role, keyPath, onDiskPem, 'on-disk');
  const vaultIdentity = publicKeyFingerprintOrRefuse(role, keyPath, vaultPem, 'vault');
  if (onDiskIdentity === vaultIdentity) {
    return { kind: 'match', onDiskPem };
  }
  return { kind: 'mismatch', onDiskFingerprint: onDiskIdentity, vaultFingerprint: vaultIdentity };
}

/**
 * Resolve the DEFAULT (no `deps.keyPathFor` override) on-disk App-key path
 * for a role, applying the macf#1157 / macf#1214 "read-old-write-new"
 * back-compat rule, now TWO legacy tiers deep.
 *
 * The owner+fleet-scoped conventional path ({@link defaultAgentKeyPath} —
 * `~/.macf/keys/<owner>/<fleet>/<role>.pem`, macf#1214) wins whenever
 * anything already lives there. Otherwise, TWO older-generation candidates
 * are tried in write-order (newest legacy first), each reused IN PLACE
 * when — and only when — its fingerprint matches THIS role's vault entry,
 * via the SAME {@link detectKeyStatus} comparison every other key-trust
 * decision in this module already makes:
 *
 *  1. the pre-#1214 fleet-scoped, OWNER-LESS path
 *     ({@link legacyProjectAgentKeyPath} — `~/.macf/keys/<fleet>/<role>.pem`,
 *     macf#1157's shape, no owner segment)
 *  2. the pre-#1157 FLAT path ({@link legacyAgentKeyPath} —
 *     `~/.macf/keys/<role>.pem`, no fleet OR owner segment)
 *
 * No new trust primitive, no weakening of the mismatch refusal at either
 * tier: each is strictly an additional CANDIDATE path, checked with the
 * identical rigor as the conventional one, and — critically — ANCHORED to
 * one exact, predictable location per tier, never a directory scan. A
 * candidate this fleet doesn't own (wrong fingerprint) is simply never
 * read as a source of truth; it is not a search over `~/.macf/keys/` that
 * could accidentally surface an unrelated identity (e.g. a substrate
 * agent's own flat-shaped key) — only the ONE path each tier's shape
 * predicts is ever even opened.
 *
 * A legacy key at either tier that does NOT match is simply irrelevant to
 * this fleet — most likely a DIFFERENT fleet's (or a different owner's)
 * key that happens to share this role name (the exact collision macf#1157,
 * and one level up, macf#1214, report). It is silently ignored, never
 * compared against for a refusal, and the conventional path materializes
 * fresh from the vault exactly as if no legacy file existed. A legacy file
 * that fails to PARSE at all is treated the same way (ignored, not
 * refused) — an unparseable stranger file at an older-generation path is
 * not this fleet's problem to diagnose; {@link detectKeyStatus} still
 * refuses loud the moment something actually needs the CONVENTIONAL
 * path's own content.
 *
 * Only ever called when `deps.keyPathFor` is undefined (the production
 * default) — see {@link deployAgent}'s call site. A caller-supplied
 * override takes full control of path resolution and never reaches this
 * function, so it never falls back to a real `homedir()`-rooted path
 * either.
 */
function resolveDefaultKeyPath(owner: string, fleetName: string, role: string, vaultPem: string): string {
  const conventional = defaultAgentKeyPath(owner, fleetName, role);
  if (existsSync(conventional)) return conventional;

  const legacyProject = legacyProjectAgentKeyPath(fleetName, role);
  if (existsSync(legacyProject)) {
    try {
      if (detectKeyStatus(role, legacyProject, vaultPem).kind === 'match') return legacyProject;
    } catch {
      // Unparseable legacy file — not this fleet's concern; fall through
      // to the next tier, exactly as if the legacy file didn't exist.
    }
  }

  const legacyFlat = legacyAgentKeyPath(role);
  if (existsSync(legacyFlat)) {
    try {
      if (detectKeyStatus(role, legacyFlat, vaultPem).kind === 'match') return legacyFlat;
    } catch {
      // Unparseable legacy file — not this fleet's concern; fall through
      // to fresh materialization at the conventional path below, exactly
      // as if the legacy file didn't exist.
    }
  }

  return conventional;
}

/**
 * Resolve `keyPath`'s materialization state against the vault's credential,
 * per macf#975: an ABSENT key is written fresh (unchanged from before this
 * fix). A PRESENT key is trusted only when its PUBLIC-KEY fingerprint
 * matches the vault's ({@link publicKeyFingerprint} — encoding-invariant,
 * NOT a byte-hash of the private PEM) — a match keeps `'skipped-existing'`'s
 * existing "operator-owned, never touched" contract; a MISMATCH throws a
 * {@link FleetDeployError} (`agent_key_fingerprint_mismatch`) BEFORE any
 * network call, unless `deps.forceKey` opts into overwriting it from the
 * vault. The REPORTED `keyFingerprint` on the result is a separate concern
 * (kept as {@link secretFingerprint} — see that field's own doc on
 * `FleetDeployOutcome` for why the two fingerprint KINDS are deliberately
 * different) and always describes the key bytes actually on disk / written,
 * never assumed equal to the vault's. Split out of {@link deployAgent} so
 * that function's own body stays within this repo's function-length
 * convention.
 */
function materializeAgentKey(
  role: string,
  keyPath: string,
  vaultPem: string,
  deps: Pick<FleetDeployDeps, 'forceKey'>,
  log: (line: string) => void,
): KeyMaterializeResult {
  const status = detectKeyStatus(role, keyPath, vaultPem);

  if (status.kind === 'absent') {
    writeAgentKeyAtomic0600(keyPath, vaultPem);
    log(`Role "${role}": App key materialized at ${keyPath} (0600).`);
    return { keyWrite: 'written', keyFingerprint: secretFingerprint(vaultPem) };
  }

  if (status.kind === 'match') {
    log(`Role "${role}": App key already present at ${keyPath} and matches the vault — not overwritten (operator-owned once materialized).`);
    return { keyWrite: 'skipped-existing', keyFingerprint: secretFingerprint(status.onDiskPem) };
  }

  if (deps.forceKey === true) {
    writeAgentKeyAtomic0600(keyPath, vaultPem);
    log(
      `Role "${role}": App key at ${keyPath} did not match the vault (on-disk ${status.onDiskFingerprint} vs vault ` +
        `${status.vaultFingerprint}) — re-materialized from the vault (--force-key).`,
    );
    return { keyWrite: 'written', keyFingerprint: secretFingerprint(vaultPem) };
  }

  throw new FleetDeployError(
    'agent_key_fingerprint_mismatch',
    keyFingerprintMismatchMessage(role, keyPath, status.onDiskFingerprint, status.vaultFingerprint),
  );
}

/**
 * The refusal message for BOTH the App key AND the per-project CA being
 * stale at once (macf#982) — the routine shape after a destroy -> rebuild
 * -> deploy cycle on an unwiped host: a rebuilt fleet mints a NEW CA and a
 * NEW App key by construction, so BOTH credentials left over from the
 * previous fleet of the same name are simultaneously invalid. Names all
 * four fingerprints (two mismatched pairs) and BOTH override flags together
 * (`--force-ca --force-key`) so the operator can recover in ONE re-run
 * instead of discovering the second refusal only after hand-fixing the
 * first — the exact discoverability gap {@link deployAgent}'s pre-check
 * (below) exists to close. Exported so tests can assert its exact shape
 * without duplicating the prose inline.
 */
export function staleCaAndKeyMismatchMessage(
  role: string,
  fleetName: string,
  caCertFilePath: string,
  caKeyFilePath: string,
  caLocalFingerprint: string,
  caVaultFingerprint: string,
  keyPath: string,
  keyOnDiskFingerprint: string,
  keyVaultFingerprint: string,
): string {
  return (
    `Role "${role}": this host holds STALE material from a previous fleet named "${fleetName}" — BOTH the ` +
    'per-project CA and the App key are left over and do not match the current vault. This is the routine shape ' +
    'after a destroy -> rebuild -> deploy cycle on the same host (a rebuilt fleet mints a NEW CA and a NEW App ' +
    'key by construction; nothing on GitHub lets either be reused, and neither CA identity is portable between ' +
    `fleets). CA at "${caCertFilePath}" (local fingerprint ${caLocalFingerprint}, vault ${caVaultFingerprint}). ` +
    `App key at "${keyPath}" (local fingerprint ${keyOnDiskFingerprint}, vault ${keyVaultFingerprint}). Remedy: ` +
    `remove or rename ${caCertFilePath}, ${caKeyFilePath}, and ${keyPath} so the next deploy re-materializes ` +
    'all three from the vault. Or re-run with --force-ca --force-key to re-materialize both from the vault now, ' +
    'without hand-deleting any file.'
  );
}

/**
 * Drive ONE agent through decrypt → extract → materialize CA → materialize
 * key → materialize workspace → delegate to `initAgent` (which — as of
 * macf#1000 — is ALSO where the agent's own leaf cert is issued;
 * `deployAgent` only observes the before/after on-disk state around that
 * one call to compute {@link FleetDeployOutcome.certIssue}, it never issues
 * a cert itself).
 * NEVER throws — every failure path (missing vault, bad identity, wrong key,
 * missing vault entry, an unsupported registry mode, a key-fingerprint
 * mismatch, a CA mismatch, a token-mint failure, a clone failure, an
 * `initAgent` throw) resolves to
 * `status: 'failed'` with an operator-actionable, secret-free `reason`.
 *
 * **Key materialization now runs BEFORE the clone (macf#968; was clone-then-
 * key)** — minting the clone-auth token below needs the PEM already on disk
 * at a path `gh token generate --key <path>` can read. The two steps are
 * otherwise independent (different destinations), so reordering them is
 * safe; every existing idempotency contract (pre-existing key/workspace left
 * untouched) is unchanged, just evaluated in the other order.
 *
 * **A pre-existing on-disk key is verified against the vault before being
 * trusted (macf#975), by PUBLIC-KEY identity, not raw-PEM bytes.** Same
 * identity → `'skipped-existing'`, unchanged. A different identity → refuses
 * with a `FleetDeployError` NAMED before
 * `ensureAgentWorkspaceCloned` (and therefore the lazy clone-auth mint) is
 * ever reached — a stale key from a destroyed fleet must never even attempt
 * a mint, since that mint would only 401 without explaining why. Unless
 * `deps.forceKey` is `true`, in which case the on-disk key is overwritten
 * from the vault (same atomic-0600 write as the absent-key path) and
 * deployment proceeds normally.
 *
 * **CA materialize runs before that, and the `initAgent` call that issues
 * the agent cert runs after the clone (macf#976; delegation shape per
 * macf#1000).** The CA is fleet-level (independent of `destDir`), so it can
 * — and, to fail fast on a mismatch before any other side effect runs,
 * should — resolve first. The agent's own leaf cert is written INTO
 * `destDir` (by `initAgent`, not by this function), so the `initAgent` call
 * MUST wait until the workspace is actually cloned (see the inline comment
 * at that call site for why the ordering is load-bearing, not stylistic).
 *
 * **Both the CA and the App key are PEEKED AT (read-only, no writes)
 * before either is materialized (macf#982).** A fleet rebuild rotates BOTH
 * identities at once, so an unwiped host commonly has BOTH stale. Without
 * this peek, the CA's own refusal would fire first (per the ordering
 * above) and hide the fact that the App key is ALSO stale — the operator
 * would hand-fix the CA, re-run, and only THEN discover the key refusal.
 * When BOTH would refuse unforced, {@link deployAgent} raises ONE combined
 * `FleetDeployError` ({@link staleCaAndKeyMismatchMessage}) naming all four
 * fingerprints and both override flags together, and NOTHING is written.
 * When only one would refuse, behavior is unchanged from before this fix:
 * that one refuses (nothing else touched) exactly as it always did.
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
    // groundnuty/macf#1183 — `false` (never `undefined`) for every caller
    // that never set `deps.rolesProvisionedThisApplyRun` at all: `?.has`
    // short-circuits to `undefined` on a missing Set, and `?? false`
    // normalizes that to the same honest-unknown default
    // `extractAgentVaultCredentials`'s own 4th parameter already assumes.
    const provisionedThisRun = deps.rolesProvisionedThisApplyRun?.has(role) ?? false;
    const creds = extractAgentVaultCredentials(raw, manifest.metadata.name, role, provisionedThisRun);

    const registryOpts = initRegistryOptionsFor(manifest.owner.registry);

    // macf#1277: `caPathDeps` itself resolves ONLY to the owner-scoped
    // conventional path (no fallback baked in here) — `owner` needs to
    // reach every call site through the deps' TYPE, not a closure (see
    // `CaPathDeps`'s own doc). The read-old legacy-tier fallback lives
    // inside `detectCaStatus`/`materializeProjectCa`, fingerprint-gated
    // AND additionally gated on `allowCaLegacyFallback` below — the SAME
    // "override fully owns resolution" ternary-level split the App key
    // applies, just expressed as an explicit boolean instead of a ternary
    // branch (the CA's vault-decode happens INSIDE `detectCaStatus`, so
    // the fallback can't be resolved before calling it the way the key's
    // `resolveDefaultKeyPath` is).
    const caPathDeps: CaPathDeps = {
      caCertPathFor: deps.caCertPathFor ?? caCertPath,
      caKeyPathFor: deps.caKeyPathFor ?? caKeyPath,
    };
    const allowCaLegacyFallback = deps.caCertPathFor === undefined && deps.caKeyPathFor === undefined;
    // macf#1157 / macf#1214: the owner+fleet-scoped default (with two-tier
    // legacy-path back-compat) ONLY applies when the caller hasn't
    // overridden resolution — an override (always used in tests, per
    // `keyPathFor`'s own doc) fully owns path resolution and never sees
    // the legacy fallback either.
    const keyPath = deps.keyPathFor
      ? deps.keyPathFor(role)
      : resolveDefaultKeyPath(manifest.owner.account, manifest.metadata.name, role, creds.privateKeyPem);

    // Combined-stale pre-check (macf#982) — see this function's own doc
    // "Both the CA and the App key are PEEKED AT" section. Read-only: ONLY
    // decides whether to raise the combined refusal below; the actual
    // materialize calls (which redo this comparison) are what write.
    const caDetection = detectCaStatus(raw, manifest.owner.account, manifest.metadata.name, caPathDeps, allowCaLegacyFallback);
    const keyDetection = detectKeyStatus(role, keyPath, creds.privateKeyPem);
    if (caDetection.kind === 'mismatch' && deps.forceCa !== true && keyDetection.kind === 'mismatch' && deps.forceKey !== true) {
      throw new FleetDeployError(
        'stale_material_ca_and_key',
        staleCaAndKeyMismatchMessage(
          role,
          manifest.metadata.name,
          caPathDeps.caCertPathFor(manifest.owner.account, manifest.metadata.name),
          caPathDeps.caKeyPathFor(manifest.owner.account, manifest.metadata.name),
          caDetection.localFingerprint,
          caDetection.vaultFingerprint,
          keyPath,
          keyDetection.onDiskFingerprint,
          keyDetection.vaultFingerprint,
        ),
      );
    }

    // CA materialize runs BEFORE any side effect below (macf#976) — a
    // mismatch (when not forced) refuses the ENTIRE deploy with NOTHING
    // else touched (no App key written, no clone, no `initAgent`) rather
    // than leaving a half-deployed workspace behind a loud error. The
    // combined pre-check above has already ruled out "both stale,
    // neither forced" reaching this point.
    const ca = await materializeProjectCa(
      raw,
      manifest.owner.account,
      manifest.metadata.name,
      caPathDeps,
      deps.forceCa === true,
      allowCaLegacyFallback,
    );
    log(caMaterializeLogLine(role, ca));

    const { keyWrite, keyFingerprint } = materializeAgentKey(role, keyPath, creds.privateKeyPem, deps, log);

    // The clone-auth token is minted LAZILY (only when `ensureAgentWorkspaceCloned`
    // is actually about to clone — see that function's doc) so a re-run
    // against an already-deployed workspace stays a zero-network no-op.
    // A mint failure propagates straight to the outer catch below — never a
    // silent fallback to an anonymous clone that would just reproduce
    // macf#968's original 401 in a new guise.
    const workspace = await ensureAgentWorkspaceCloned(agent.repo, destDir, deps.cloneRepo, async (repo) => {
      const token = await deps.mintCloneToken({ appId: creds.appId, installId: creds.installId, keyPath });
      return authenticatedCloneUrl(repo, token);
    });
    log(
      `Role "${role}": workspace ${workspace === 'cloned' ? `cloned into ${destDir}` : `already present at ${destDir} — not re-cloned`}.`,
    );

    // Agent leaf-cert issuance is now ENTIRELY `initAgent`'s job (macf#1000
    // — one cert-issuance path per run; see this module's own doc "Never a
    // second CRYPTO implementation"). `skipCertIfPresent: true` below is
    // what keeps that ONE call idempotent across re-runs — see
    // `commands/init.ts::issueGithubModeAgentCert`'s doc.
    //
    // The pre/post `existsSync` peek around the call is NOT a second
    // issuance path — it never writes, only OBSERVES the same conventional
    // `agentCertPath`/`agentKeyPath(destDir)` `initAgent` itself reads and
    // writes, so `certIssue` reflects the REAL on-disk state when this run
    // ends, not an intermediate step's belief about it. This MUST run
    // AFTER the clone above, never before: writing into `destDir/.macf/certs/`
    // before the clone would make `ensureAgentWorkspaceCloned`'s own
    // `isEmptyDir` check see a non-empty dir and skip cloning the real repo
    // content.
    const certDestPath = agentCertPath(destDir);
    const keyDestPath = agentKeyPath(destDir);
    const certPreExisted = ca.status !== 'vault-absent' && existsSync(certDestPath) && existsSync(keyDestPath);

    // macf#1406 — `pluginVersion` MUST always be passed in lockstep with
    // `cliVersion`, never left for `initAgent`'s own `resolveVersions()` to
    // fill in independently. `FleetVersionsSchema` has no `plugin` field
    // (both `macf` and `actions` are required together when `versions:` is
    // declared at all — see the schema's own doc), so lockstep IS the rule,
    // not a fallback for a missing manifest field.
    //
    // Declared `manifest.versions` → derive both from it directly, ZERO
    // network calls (this is the concrete #1406 bug: previously `cliVersion`
    // /`actionsVersion` were forwarded from here but `pluginVersion` was
    // not, so `initAgent`'s `allSet` check was false, it fell into its own
    // `resolveLatestVersions()`, THAT network call failed in this deploy
    // context — no token — and `plugin` silently landed on the hardcoded
    // `FALLBACK_VERSIONS.plugin` ('0.2.0', a plugin with zero PreToolUse
    // hooks) sitting next to a real, current `cliVersion`).
    //
    // Undeclared `manifest.versions` ("no opinion" — `version-target.ts`'s
    // own doc) → resolve `{cli, plugin, actions}` HERE, loud-fail on
    // network trouble ({@link resolveLockstepVersionsOrThrow}, DR-044
    // Decision 6), and pass all three explicit. This makes `initAgent`'s
    // OWN `allSet` check true unconditionally from this caller — its
    // internal warn-and-degrade `resolveVersions()` path is never reached
    // by a `fleet deploy` call, declared versions or not.
    const versions: VersionSet = manifest.versions
      ? { cli: manifest.versions.macf, plugin: manifest.versions.macf, actions: manifest.versions.actions }
      : await (deps.resolveVersions ?? resolveLockstepVersionsOrThrow)();

    await deps.initAgent(destDir, {
      project: manifest.metadata.name,
      role,
      appId: creds.appId,
      installId: creds.installId,
      keyPath,
      advertiseHost: manifest.network.advertise_host,
      skipCertIfPresent: true,
      // #897: `initAgent` now refuses (by default) to overwrite a
      // `claude.sh` that exists but lacks the macf managed-file header,
      // treating it as hand-authored and operator-owned. `fleet deploy`
      // is the fleet-management convergence loop, not an interactive
      // one-off — it is meant to be idempotent + safe to re-run, and a
      // fleet-deployed workspace's `claude.sh` is ALWAYS macf-owned by
      // this tool's contract (never an operator hand-edit the tool
      // should defer to). `force: true` here keeps re-deploys converging
      // rather than aborting the whole run on a stale/edited launcher —
      // the protection this option exists for is for a human re-running
      // `macf init` directly, not for this automated path.
      force: true,
      cliVersion: versions.cli,
      pluginVersion: versions.plugin,
      actionsVersion: versions.actions,
      ...registryOpts,
    });
    log(`Role "${role}": macf init completed at ${destDir}.`);

    const certIssue: AgentCertIssueOutcome | 'not-attempted' =
      ca.status === 'vault-absent'
        ? 'not-attempted'
        : certPreExisted
          ? 'skipped-existing'
          : existsSync(certDestPath) && existsSync(keyDestPath)
            ? 'issued'
            : 'not-attempted';
    log(
      `Role "${role}": agent mTLS cert ${
        certIssue === 'issued'
          ? 'issued'
          : certIssue === 'skipped-existing'
            ? 'already present — not re-issued'
            : ca.status === 'vault-absent'
              ? 'not attempted — no per-project CA'
              : 'NOT issued — check the `macf init` output above'
      }.`,
    );

    return {
      role,
      status: 'deployed',
      appId: creds.appId,
      installId: creds.installId,
      workspace,
      keyPath,
      keyWrite,
      keyFingerprint,
      ca,
      certIssue,
    };
  } catch (err) {
    return { role, status: 'failed', reason: errMessage(err) };
  }
}
