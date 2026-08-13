/**
 * `vault.age` READ — DR-043 Amendment D (groundnuty/macf#838/#854), the
 * reconciliation keystone: "nothing can READ the vault." This module is the
 * read/decrypt half `vault-write.ts` deliberately never built.
 *
 * **The binding ruling (Amendment D, quoted):** *"the vault is
 * read-only-decryptable into memory and whole-payload-writable single-shot,
 * and is NEVER read-modify-written in place. There is deliberately no
 * decrypt-merge-reencrypt primitive."* This module adds ONLY the read half:
 * {@link readVault} decrypts an existing `vault.age` to an in-memory
 * `KEY -> value` map and returns it — nothing here ever re-encrypts, merges,
 * or writes anything back. A caller that wants to fold a freshly-read prior
 * vault into a NEW one does so on the typed plaintext (Amendment D: "the
 * merge is in the payload, never on ciphertext") via `vault-write.ts`'s
 * existing single-shot `writeVault` — this module supplies the READ side of
 * that payload, never a merge primitive of its own.
 *
 * **Scoped residual, named rather than fixed (phase 3 → phase 4 boundary).**
 * `readVault` returns a raw `Record<string, string>` (the "`KEY -> value`
 * map"), NOT a typed `VaultPayload` (`vault-write.ts`'s per-agent/routing/CA
 * struct). That is sufficient for THIS phase's job (presence/derivation
 * queries below) but Amendment D's phase-4 add-agent example needs the
 * TYPED struct — `{...priorAgentsReadFromVault, newAgent}` — to hand to
 * `writeVault`. Building that struct back from the raw map is deliberately
 * left to whoever builds phase 4, with one constraint stated now so it
 * cannot reach for the unsafe shortcut: derive each agent's vault keys
 * FORWARD from the manifest's known `(fleetName, role)` pairs (the same
 * `deriveAppHandle` + `toVariableSegment` composition
 * {@link queryVaultAgentPresence} already uses below), never REVERSE by
 * parsing the vault's own key names back into a role via
 * `@groundnuty/macf-core`'s `fromVariableSegment` — that function's own doc
 * calls this exact use lossy ("do NOT use it to reconstruct a registry
 * LOOKUP key"). A `toVaultPayload(raw, manifest)` builder over the forward
 * derivation is the safe shape for that future increment.
 *
 * **Custody boundary (Amendment C, extended by Amendment D).** The vault
 * decryptor is the operator-privileged bootstrap CLI holding the operator's
 * age key (§D4 Mac-side plane) — never an agent context. This module cannot
 * enforce that by itself (a function can't know who calls it), so the
 * enforcement is structural at the CALL SITE: {@link readVault} requires an
 * explicit identity-key PATH as an argument, never reads one from ambient
 * agent config or environment — a caller constructs the options only by
 * possessing the path to a real key on disk. Real-fleet vault reads are
 * therefore operator-gated by the same mechanism `apply` already relies on;
 * this module's own tests exercise the primitives against SYNTHETIC age
 * keys, never a real fleet's.
 *
 * **No plaintext ever touches disk** — the read-side mirror of
 * `vault-write.ts`'s load-bearing §D5 property. {@link ageDecryptFile} pipes
 * `age -d`'s STDOUT straight into a Node string in process memory; there is
 * no `vault.plain` file at any point, not even transiently, not even on an
 * error path (every failure mode below is a rejected `VaultError`, never a
 * partial file written anywhere).
 *
 * **Never logs, echoes, or includes secret material in a thrown message.**
 * Every {@link VaultError} thrown below carries only: a file PATH (not its
 * content), `age`'s own stderr prose (diagnostic text about the failure, not
 * vault content — same posture `ageEncryptToFile` already takes with its own
 * stderr), or a vault KEY NAME (never secret — vault keys are
 * `MACF_AGENT_<SEG>_APP_ID` shapes, not secret material; only the
 * corresponding VALUE is secret, and no thrown message here ever contains a
 * value). The presence/derivation queries below go further: they never
 * return a raw value AT ALL, only `{ present, fingerprint }` — the same
 * redaction-boundary shape `apply-ca.ts`'s `redactCaResolve` establishes for
 * the CA ceremony (a render-safe mirror is the ONLY thing that reaches
 * `ObservedState` / `--json`; the raw decrypted map stays local to whatever
 * called {@link readVault} and is never threaded through this module's own
 * return values beyond that one function).
 *
 * **Reuses the existing `KEY=VALUE` write contract, both quote eras
 * (macf#848).** `parseVaultPlaintext` accepts `KEY='value'` (the current
 * `buildVaultPlaintext` emission) AND the older `KEY="value"` form (a real
 * vault, written 2026-08-12 by the first live provision, still uses it) —
 * same `_vault_unquote` "strip exactly one layer of matching surrounding
 * quoting" contract `templates/vault.sh` already implements, ported here so
 * the TS reader and the shell reader never silently diverge on the
 * QUOTE/FORMAT contract (what a `KEY=VALUE` line MEANS once parsed). They
 * DO deliberately diverge on how a MALFORMED line is handled: `vault.sh`
 * warns-and-skips (a sourced interactive shell must never die on one bad
 * line); {@link parseVaultPlaintext} below throws instead (a data primitive
 * feeding presence answers into a plan has no such constraint, and a
 * skipped-but-present secret reading as silently absent would be its own
 * hazard — see that function's doc for the full reasoning).
 */
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { toVariableSegment } from '@groundnuty/macf-core';
import { VaultError } from './vault-write.js';
import { secretFingerprint } from './fleet-lock.js';
import { deriveAppHandle } from './fleet-manifest.js';

// --- Parse (pure) ---

/** Same shape as `vault-write.ts`'s `SHELL_IDENTIFIER_RE` — a vault KEY must be a valid shell identifier on both the write side and this read side, or the two readers (this module, `vault.sh`) could disagree about what a line even is. */
const VAULT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strip exactly one layer of matching surrounding `"..."` / `'...'` quoting
 * from a vault VALUE. Direct TS port of `templates/vault.sh`'s
 * `_vault_unquote` — same two-quote-era compat contract (macf#848). A value
 * with no surrounding quotes (or too short to carry a matching pair) passes
 * through unchanged. Plain string operation (prefix/suffix stripping) —
 * never a re-parse of the value's content, so it carries no shell-injection
 * surface of its own (nothing here ever `eval`s or interprets the value).
 */
function unquoteVaultValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

/**
 * Parse decrypted vault PLAINTEXT into its raw `KEY -> unquoted value` map —
 * the read-side mirror of `buildVaultPlaintext`'s write contract. Pure — no
 * I/O. Tolerates blank lines and `#`-comment lines (matching
 * `vault.template.txt`'s documented shape), unlike `vault.sh` this reader
 * does NOT silently skip a line that fails to parse: a query primitive
 * feeding presence answers into a plan needs to know its input is trustworthy,
 * not degrade some fraction of it invisibly (`vault.sh`'s skip-and-warn
 * posture is right for a sourced interactive shell that must never die; this
 * is a data primitive with no such constraint). Throws {@link VaultError}
 * `vault_malformed_plaintext` — NEVER including the offending VALUE (only a
 * KEY name, which is never secret, or a description of the shape violation)
 * — on:
 *   - a non-blank, non-comment line with no `=` at all;
 *   - a line whose KEY portion isn't a valid shell identifier;
 *   - a decrypted payload with ZERO content lines (every line blank/comment,
 *     or the payload is empty) — a successfully-decrypted-but-empty result
 *     is itself suspicious (an empty vault, or a non-vault file that
 *     happened to decrypt) and should not silently present as "0 secrets."
 */
export function parseVaultPlaintext(plaintext: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  let sawContentLine = false;

  for (const line of plaintext.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    sawContentLine = true;

    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new VaultError(
        'vault_malformed_plaintext',
        'decrypted vault content has a line with no "KEY=VALUE" shape (no "=" after a non-empty key position) — ' +
          'this does not look like a valid vault (wrong key producing non-vault-shaped output decrypts fine under ' +
          'age but is not what it claims to be; a hand-edited/corrupted vault is the other likely cause). The ' +
          'offending line is deliberately NOT included in this message — it may carry secret bytes.',
      );
    }
    const key = line.slice(0, eq);
    if (!VAULT_KEY_RE.test(key)) {
      throw new VaultError(
        'vault_malformed_plaintext',
        `decrypted vault content has a key that is not a valid shell identifier ("${key}") — vault key names are ` +
          'never secret (only the corresponding value is), so the offending KEY is shown; its value is not.',
      );
    }
    out[key] = unquoteVaultValue(line.slice(eq + 1));
  }

  if (!sawContentLine) {
    throw new VaultError(
      'vault_malformed_plaintext',
      'decrypted vault content has no KEY=VALUE lines at all (every line was blank or a comment, or the payload ' +
        'was empty) — an empty or non-vault file that still happened to decrypt under the given key.',
    );
  }
  return out;
}

// --- Decrypt (I/O leaf, injectable) ---

export type VaultDecryptFn = (vaultPath: string, identityPath: string) => Promise<string>;

const AGE_DECRYPT_TIMEOUT_MS = 30_000;

/**
 * Real `age -d` invocation — decrypts `vaultPath` with the identity at
 * `identityPath` and returns the PLAINTEXT captured from `age`'s STDOUT
 * directly into a Node string, in process memory. **No plaintext ever
 * touches disk** (§D5's load-bearing property, read-side mirror of
 * `ageEncryptToFile`): `age -d` (no `-o`) writes its decrypted output to its
 * own STDOUT pipe; this function reads that pipe into memory and nothing
 * else — no scratch file, no `-o` target, not even transiently.
 *
 * Thin I/O leaf — not unit-tested against a fake process (same posture as
 * `ageEncryptToFile` / `identity-confirm.ts`'s `confirmAppInstallation`);
 * exercised for real against the actual `age` binary where available
 * (`vault-read.test.ts`, skipped when `age`/`age-keygen` are not on PATH).
 *
 * On a non-zero exit, the rejection message carries `age`'s own stderr
 * (diagnostic prose about WHY the decrypt failed — wrong identity / corrupt
 * file — never the vault's content) but deliberately NEVER the captured
 * `stdout` buffer, which could in principle hold partial plaintext bytes
 * from a process that wrote before failing.
 */
export function ageDecryptFile(
  vaultPath: string,
  identityPath: string,
  timeoutMs: number = AGE_DECRYPT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('age', ['-d', '-i', identityPath, vaultPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(
          new VaultError(
            'vault_read_timeout',
            `age -d did not exit within ${String(timeoutMs)}ms decrypting "${vaultPath}".`,
          ),
        );
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    // A failed spawn can leave stdout/stderr streams in an odd state — this
    // no-op handler (mirrors `ageEncryptToFile`'s identical stdin guard)
    // just prevents an unhandled 'error' on the stream itself; the REAL
    // failure surfaces via the child's own 'error'/'close' handlers below.
    child.stdout?.on('error', () => {
      /* surfaced via the child 'error'/'close' handlers instead */
    });
    child.on('error', (err) => {
      finish(() => {
        reject(new VaultError('vault_read_spawn_failed', `Failed to spawn "age" — is it on PATH? (${err.message})`));
      });
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new VaultError(
              'vault_decrypt_failed',
              `age -d exited ${String(code)} decrypting "${vaultPath}" — wrong identity key, or a corrupted/` +
                `non-age file. age said: ${stderr.trim()}`,
            ),
          );
        }
      });
    });
  });
}

// --- readVault — the primitive (pre-flight + decrypt + parse) ---

export interface VaultReadOptions {
  readonly vaultPath: string;
  readonly identityPath: string;
  readonly timeoutMs?: number;
}

export interface ReadVaultDeps {
  readonly exists?: (path: string) => boolean;
  /** Throws on a missing/unreadable identity file; never returns a value. Defaults to a real `fs.accessSync(path, R_OK)` check. */
  readonly assertIdentityReadable?: (path: string) => void;
  readonly decrypt?: VaultDecryptFn;
}

function defaultAssertIdentityReadable(identityPath: string): void {
  try {
    accessSync(identityPath, fsConstants.R_OK);
  } catch {
    throw new VaultError(
      'vault_identity_unreadable',
      `age identity key not found or not readable at "${identityPath}" — supply the path to the operator's (or ` +
        'the VM\'s) age private-key file, e.g. via `age-keygen -o <path>`\'s output.',
    );
  }
}

/**
 * Decrypt + parse `opts.vaultPath` into its raw `KEY -> value` map — THE
 * vault-read primitive (DR-043 Amendment D phase 3). Pre-flight checks mirror
 * `templates/vault.sh`'s own ordering (vault file exists → identity readable →
 * decrypt) so a caller gets the SAME failure-mode discrimination the shell
 * accessor already gives an operator, rather than whatever undifferentiated
 * text `age` itself would produce for a missing input file.
 *
 * Every failure is a distinct, actionable {@link VaultError}:
 *   - `vault_not_found` — nothing at `vaultPath`.
 *   - `vault_identity_unreadable` — nothing (or unreadable) at `identityPath`.
 *   - `vault_read_spawn_failed` / `vault_read_timeout` — `age` itself
 *     couldn't run or hung (see {@link ageDecryptFile}).
 *   - `vault_decrypt_failed` — `age` ran and reported failure (wrong key /
 *     corrupt file).
 *   - `vault_malformed_plaintext` — `age` reported SUCCESS but the decrypted
 *     bytes don't parse as a vault (see {@link parseVaultPlaintext}).
 *
 * No plaintext ever touches disk (delegates to {@link ageDecryptFile}); the
 * returned map lives only in the caller's memory from here on.
 */
export async function readVault(
  opts: VaultReadOptions,
  deps?: ReadVaultDeps,
): Promise<Readonly<Record<string, string>>> {
  const exists = deps?.exists ?? existsSync;
  const assertIdentityReadable = deps?.assertIdentityReadable ?? defaultAssertIdentityReadable;
  const decrypt = deps?.decrypt ?? ((vaultPath: string, identityPath: string) => ageDecryptFile(vaultPath, identityPath, opts.timeoutMs));

  if (!exists(opts.vaultPath)) {
    throw new VaultError('vault_not_found', `vault file not found at "${opts.vaultPath}" — nothing to decrypt.`);
  }
  assertIdentityReadable(opts.identityPath);

  const plaintext = await decrypt(opts.vaultPath, opts.identityPath);
  return parseVaultPlaintext(plaintext);
}

// --- Presence / derivation queries (pure, never throw, never return a value) ---

export interface VaultFieldPresence {
  readonly present: boolean;
  /**
   * `sha256:<hex>` via `fleet-lock.ts`'s {@link secretFingerprint}, computed
   * over the SAME byte representation `fleet.lock`'s fingerprint-pairing
   * hashes (raw bytes for a plain field; base64-DECODED bytes for a `_B64`
   * field, since `buildVaultPlaintext` base64-encodes those before storage
   * but `vaultAgentSecretsForFingerprint` fingerprints the RAW PEM). A
   * `present` field's fingerprint is therefore directly comparable against a
   * `fleet.lock` entry for drift detection (Amendment D phase 3 → phase 4).
   * `undefined` when `present` is `false`. NEVER the value itself.
   */
  readonly fingerprint?: string;
}

/**
 * `raw[key]` → a redacted {@link VaultFieldPresence}. Never returns the
 * value; `base64Encoded` selects which byte representation is fingerprinted
 * (see that field's doc).
 *
 * **ASCII assumption, stated (not just implied).** `.toString('utf-8')` on
 * the base64-decoded bytes is only lossless because every `_B64` vault field
 * is ASCII PEM/cert text by construction (`buildVaultPlaintext`'s only
 * `toBase64` inputs are PEM strings). A `utf-8` decode of arbitrary BINARY
 * bytes would substitute replacement characters, producing a fingerprint
 * that could never match `fleet.lock`'s (computed over the true raw bytes)
 * — "a fingerprint you can't recompute detects nothing" (Amendment E). If a
 * future `_B64` field ever carries non-text binary, this needs to hash the
 * decoded `Buffer` directly rather than round-tripping through a string.
 */
function fieldPresence(raw: Readonly<Record<string, string>>, key: string, base64Encoded: boolean): VaultFieldPresence {
  const value = raw[key];
  if (value === undefined || value.length === 0) return { present: false };
  const forFingerprint = base64Encoded ? Buffer.from(value, 'base64').toString('utf-8') : value;
  return { present: true, fingerprint: secretFingerprint(forFingerprint) };
}

export interface VaultAgentPresence {
  readonly appId: VaultFieldPresence;
  readonly installId: VaultFieldPresence;
  readonly clientId: VaultFieldPresence;
  readonly clientSecret: VaultFieldPresence;
  readonly webhookSecret: VaultFieldPresence;
  readonly privateKey: VaultFieldPresence;
}

/**
 * Query one agent's secret-field presence in an ALREADY-DECRYPTED vault
 * payload (the `raw` map {@link readVault} returns). Keys are DERIVED the
 * same way `buildVaultPlaintext` emits them — `deriveAppHandle` then
 * `toVariableSegment` — never reverse-parsed off the vault's own key names.
 * `@groundnuty/macf-core`'s `fromVariableSegment` is explicitly documented
 * LOSSY for reconstructing a lookup key ("do NOT use it to reconstruct a
 * registry LOOKUP key — keep the original name for lookups"); deriving
 * forward from the caller's known `(fleetName, role)` sidesteps that
 * entirely — a vault entry under an unexpected key shape simply reads as
 * absent for the role being asked about, never silently misattributed to a
 * different one.
 */
export function queryVaultAgentPresence(
  raw: Readonly<Record<string, string>>,
  fleetName: string,
  role: string,
): VaultAgentPresence {
  const seg = toVariableSegment(deriveAppHandle(fleetName, role));
  return {
    appId: fieldPresence(raw, `MACF_AGENT_${seg}_APP_ID`, false),
    installId: fieldPresence(raw, `MACF_AGENT_${seg}_INSTALL_ID`, false),
    clientId: fieldPresence(raw, `MACF_AGENT_${seg}_CLIENT_ID`, false),
    clientSecret: fieldPresence(raw, `MACF_AGENT_${seg}_CLIENT_SECRET`, false),
    webhookSecret: fieldPresence(raw, `MACF_AGENT_${seg}_WEBHOOK_SECRET`, false),
    privateKey: fieldPresence(raw, `MACF_AGENT_${seg}_PRIVATE_KEY_B64`, true),
  };
}

/**
 * Decode one agent's PRIVATE KEY PEM out of an already-decrypted vault raw
 * map — the ONE function in this module that returns a raw secret VALUE
 * (every other exported query above deliberately returns only
 * `{present, fingerprint}` — see this module's doc's redaction-boundary
 * paragraph). Exists for exactly one purpose: `macf bootstrap apply`'s
 * vault-aware confirm-before-create guard (DR-043 Amendment A, macf#913)
 * needs the ACTUAL PEM bytes to mint an App JWT via
 * `identity-confirm.ts::confirmAppInstallation` — a presence-only answer
 * cannot do that. Keys are derived the SAME forward way
 * `queryVaultAgentPresence` already uses (`deriveAppHandle` then
 * `toVariableSegment`) — never reverse-parsed off the vault's own key names
 * (see that function's doc for why).
 *
 * Returns `undefined` when the field is absent or empty — the caller
 * degrades to the pre-vault-aware behaviour for that role (never a false
 * "confirmed"; see `apply-agent.ts`'s `CreateGuardDeps.resolveKeyPath`
 * contract, which this function's return value feeds).
 *
 * **Caller obligation — this is the ONE place in this module that returns
 * cleartext secret material.** The returned string MUST NOT be logged,
 * printed, or embedded in an error/exception message. A caller that writes
 * it to a scratch file for a JWT mint (the only legitimate use) must treat
 * that file the same way `apply-agent.ts`'s `writeScratchPem`/
 * `cleanupScratchPem` already do: 0600, short-lived, deleted once the confirm
 * completes — never the vault, never permanent.
 */
export function vaultAgentPrivateKeyPem(
  raw: Readonly<Record<string, string>>,
  fleetName: string,
  role: string,
): string | undefined {
  const seg = toVariableSegment(deriveAppHandle(fleetName, role));
  const b64 = raw[`MACF_AGENT_${seg}_PRIVATE_KEY_B64`];
  if (b64 === undefined || b64.length === 0) return undefined;
  return Buffer.from(b64, 'base64').toString('utf-8');
}

export interface VaultCaPresence {
  readonly caKey: VaultFieldPresence;
  readonly caCert: VaultFieldPresence;
}

/** The per-project CA key/cert presence in an already-decrypted vault payload — `project` is the fleet name (`MACF_<PROJECT>_CA_*`, matching `vault-write.ts`'s `VaultCaSecrets.project` / `apply-ca.ts`'s `caCertVariableName`). */
export function queryVaultCaPresence(raw: Readonly<Record<string, string>>, project: string): VaultCaPresence {
  const seg = toVariableSegment(project);
  return {
    caKey: fieldPresence(raw, `MACF_${seg}_CA_KEY_B64`, true),
    caCert: fieldPresence(raw, `MACF_${seg}_CA_CERT_B64`, true),
  };
}

export interface VaultRoutingPresence {
  readonly appId: VaultFieldPresence;
  readonly appKey: VaultFieldPresence;
  readonly clientCert: VaultFieldPresence;
  readonly clientKey: VaultFieldPresence;
  readonly tsOauthClientId: VaultFieldPresence;
  readonly tsOauthSecret: VaultFieldPresence;
}

/** The shared `macf-routing` App + 6-secret routing block's presence — fleet-level, not per-agent (matches `VaultRoutingSecrets` in `vault-write.ts`). */
export function queryVaultRoutingPresence(raw: Readonly<Record<string, string>>): VaultRoutingPresence {
  return {
    appId: fieldPresence(raw, 'MACF_ROUTING_APP_ID', false),
    appKey: fieldPresence(raw, 'MACF_ROUTING_APP_KEY_B64', true),
    clientCert: fieldPresence(raw, 'ROUTING_CLIENT_CERT_B64', true),
    clientKey: fieldPresence(raw, 'ROUTING_CLIENT_KEY_B64', true),
    tsOauthClientId: fieldPresence(raw, 'TS_OAUTH_CLIENT_ID', false),
    tsOauthSecret: fieldPresence(raw, 'TS_OAUTH_SECRET', false),
  };
}

export interface VaultPresenceCount {
  readonly present: number;
  readonly total: number;
}

/** Generic "how many of these fields are present" tally — the "count" half of the deliverable. Pure. */
export function countVaultPresence(fields: readonly VaultFieldPresence[]): VaultPresenceCount {
  return { present: fields.filter((f) => f.present).length, total: fields.length };
}

export function countVaultAgentPresence(p: VaultAgentPresence): VaultPresenceCount {
  return countVaultPresence([p.appId, p.installId, p.clientId, p.clientSecret, p.webhookSecret, p.privateKey]);
}

export function countVaultCaPresence(p: VaultCaPresence): VaultPresenceCount {
  return countVaultPresence([p.caKey, p.caCert]);
}

export function countVaultRoutingPresence(p: VaultRoutingPresence): VaultPresenceCount {
  return countVaultPresence([p.appId, p.appKey, p.clientCert, p.clientKey, p.tsOauthClientId, p.tsOauthSecret]);
}

// --- Observation shapes (consumed by observer.ts's vaultAwareObserver / plan.ts's ObservedState) ---

export type VaultObservationStatus = 'confirmed' | 'unknown';

/**
 * One agent's vault-derived secret-presence fact, as attached to
 * `plan.ts`'s `ObservedAgentState.vault` (DR-043 Amendment D phase 3 —
 * "lifts phase 2 into Amendment A's confirm tier"). `'unknown'` — NEVER
 * `'absent'` — is the Amendment A4 epistemic floor: a vault this run
 * couldn't decrypt (missing file, missing/unreadable identity, wrong key,
 * malformed content) is evidence of NOTHING about what the vault actually
 * contains. `reason` carries the causing {@link VaultError}'s message
 * verbatim — already scrubbed of secret material at the source (see this
 * module's doc), so it is safe to surface all the way to `--json`.
 */
export type VaultAgentObservation =
  | { readonly status: 'confirmed'; readonly presence: VaultAgentPresence }
  | { readonly status: 'unknown'; readonly reason: string };

/** Fleet-level sibling of {@link VaultAgentObservation}, for the per-project CA key/cert. */
export type VaultCaObservation =
  | { readonly status: 'confirmed'; readonly presence: VaultCaPresence }
  | { readonly status: 'unknown'; readonly reason: string };
