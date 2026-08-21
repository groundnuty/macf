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
import { randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { toVariableSegment } from '@groundnuty/macf-core';
import type { VaultEncryptFn, WriteVaultResult } from './vault-write.js';
import { VaultError, ageEncryptToFile, serializeVaultRawMap } from './vault-write.js';
import { secretFingerprint } from './fleet-lock.js';
import { deriveAppHandle } from './fleet-manifest.js';
import type { AppCredentials } from './manifest-exchange.js';
// groundnuty/macf#954 — the runner-ops App's vault namespace is keyed on
// `deriveRunnerOpsHandle` (== `deriveAppHandle(fleetName, RUNNER_OPS_ROLE)`),
// the SAME derivation `apply-fleet.ts`/`vault-write.ts::buildVaultPlaintext`
// already use to WRITE `MACF_RUNNER_OPS_<seg>_*` keys — imported from
// `apply-runner-ops.ts` (no import cycle: that module never reaches back
// into this one) rather than re-deriving the role string here, so the read
// side can never drift from the write side on what "runner-ops" means.
import { deriveRunnerOpsHandle } from './apply-runner-ops.js';

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

// --- Recovery-artifact READ (macf#988, DR-043 Amendment B consume side) ---
//
// The write side (`vault-write.ts::writeAgentRecoveryArtifact` +
// `operatorRecoveryArtifactPath`) is the DURABLE half of Amendment B; this
// is the CONSUME half — decrypt + parse a recovery artifact back into a
// typed `AppCredentials`, the same shape `manifest-exchange.ts::exchangeManifestCode`
// produces, so a caller (`apply-agent.ts::finishGate2FromCredentials`) can
// fold a recovered credential into the identical `status: 'created'` code
// path a fresh gate-1 exchange would produce. Reuses this module's own
// `ageDecryptFile` + `parseVaultPlaintext` primitives — the recovery
// artifact is written with the SAME `KEY='value'` shape `buildVaultPlaintext`
// uses (`vault-write.ts::buildRecoveryArtifactPlaintext`'s own `emitLine`
// reuse), just under a `MACF_RECOVERY_<SEG>_*` prefix instead of
// `MACF_AGENT_<SEG>_*`.

/**
 * Parse a decrypted recovery-artifact PLAINTEXT into a typed
 * {@link AppCredentials} — the read-side mirror of
 * `vault-write.ts::buildRecoveryArtifactPlaintext`. Pure — no I/O. Throws
 * {@link VaultError} `recovery_artifact_malformed` (mirrors
 * {@link parseVaultPlaintext}'s "throw rather than silently degrade"
 * posture — a data primitive feeding a credential the caller is about to
 * ACT on has no "must never die" constraint) when any expected
 * `MACF_RECOVERY_<SEG>_*` field is missing or empty — a wrong role, a wrong
 * fleet segment, or a corrupted/foreign file that happened to decrypt under
 * the given identity all surface as this, never as a partially-populated
 * `AppCredentials` with silently-empty fields.
 */
export function parseRecoveryArtifactPlaintext(plaintext: string, role: string): AppCredentials {
  const raw = parseVaultPlaintext(plaintext);
  const seg = toVariableSegment(role);
  const need = (suffix: string): string => {
    const key = `MACF_RECOVERY_${seg}_${suffix}`;
    const value = raw[key];
    if (value === undefined || value.length === 0) {
      throw new VaultError(
        'recovery_artifact_malformed',
        `decrypted recovery artifact is missing "${key}" — not a valid recovery artifact for role "${role}" ` +
          '(wrong role/fleet, or a corrupted file that still happened to decrypt under the given identity).',
      );
    }
    return value;
  };
  return {
    appId: need('APP_ID'),
    name: need('APP_NAME'),
    slug: need('APP_SLUG'),
    clientId: need('CLIENT_ID'),
    clientSecret: need('CLIENT_SECRET'),
    webhookSecret: need('WEBHOOK_SECRET'),
    pem: Buffer.from(need('PRIVATE_KEY_B64'), 'base64').toString('utf-8'),
  };
}

export interface ReadRecoveryArtifactDeps {
  readonly exists?: (path: string) => boolean;
  readonly decrypt?: VaultDecryptFn;
}

/**
 * Find + decrypt + parse a durable per-agent recovery artifact at
 * `artifactPath` (macf#988). `undefined` means "nothing there" — the
 * ORDINARY case (most roles never crash mid-gate) — checked via `exists`
 * BEFORE ever invoking `age`, so the common "no artifact" path costs one
 * `fs.existsSync` call, never a subprocess spawn. A file that DOES exist but
 * fails to decrypt or parse REJECTS (wrong identity, corrupt file, or a
 * `recovery_artifact_malformed` shape mismatch) — the caller
 * (`apply-fleet.ts::buildAgentDepsWithRecovery`) is expected to catch that
 * and log it, so an operator learns an artifact exists but couldn't be
 * consumed, rather than the failure silently degrading to "nothing to
 * recover."
 *
 * No plaintext ever touches disk (delegates to {@link ageDecryptFile}) —
 * same load-bearing §D5 property {@link readVault} already establishes.
 */
export async function readRecoveryArtifact(
  artifactPath: string,
  identityPath: string,
  role: string,
  deps?: ReadRecoveryArtifactDeps,
): Promise<AppCredentials | undefined> {
  const exists = deps?.exists ?? existsSync;
  if (!exists(artifactPath)) return undefined;
  const decrypt = deps?.decrypt ?? ((p: string, ip: string) => ageDecryptFile(p, ip));
  const plaintext = await decrypt(artifactPath, identityPath);
  return parseRecoveryArtifactPlaintext(plaintext, role);
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

// --- Runner-ops (groundnuty/macf#954) ---
//
// The runner-ops App (groundnuty/macf#943) is a FLEET-LEVEL identity, never
// declared in `manifest.agents[]` — so it has NO home in
// `queryVaultAgentPresence`/`vaultAgentPrivateKeyPem` above, both of which
// are keyed on a `role` the caller is expected to have pulled off
// `manifest.agents`. Before this pair of functions existed, NOTHING in this
// module could answer a vault-presence/PEM question for "runner-ops" at
// all — the fifth `queryVault*`/`vault*PrivateKeyPem` sibling the four
// existing ones (`queryVaultAgentPresence` / `vaultAgentPrivateKeyPem` /
// `queryVaultCaPresence` / `queryVaultRoutingPresence`) never grew, because
// every caller that WANTED to reach it (`commands/bootstrap-apply.ts`'s
// `resolveVaultAgentPems`) only ever iterated `manifest.agents[]` — which
// structurally cannot enumerate a role the manifest never declares (the same
// class of gap groundnuty/macf#953 found in teardown's App list). Same vault
// namespace `vault-write.ts::buildVaultPlaintext`'s `payload.runnerOps`
// branch writes (`MACF_RUNNER_OPS_<seg>_*`, distinct from `MACF_AGENT_<seg>_*`
// — see that branch's doc for why the trust-class separation matters), keyed
// the SAME forward way every other query in this module already is
// (`deriveRunnerOpsHandle` then `toVariableSegment` — never reverse-parsed).

export type VaultRunnerOpsPresence = VaultAgentPresence;

/**
 * Presence-only sibling of {@link queryVaultAgentPresence} for the
 * runner-ops App — same 6-field shape (this App's credential fields are
 * identical to an agent's; only the vault KEY PREFIX differs), never a raw
 * value. `fleetName` alone is enough to derive the key (no `role` parameter —
 * unlike `queryVaultAgentPresence`, there is exactly one runner-ops per
 * fleet, so there is nothing to disambiguate).
 */
export function queryVaultRunnerOpsPresence(raw: Readonly<Record<string, string>>, fleetName: string): VaultRunnerOpsPresence {
  const seg = toVariableSegment(deriveRunnerOpsHandle(fleetName));
  return {
    appId: fieldPresence(raw, `MACF_RUNNER_OPS_${seg}_APP_ID`, false),
    installId: fieldPresence(raw, `MACF_RUNNER_OPS_${seg}_INSTALL_ID`, false),
    clientId: fieldPresence(raw, `MACF_RUNNER_OPS_${seg}_CLIENT_ID`, false),
    clientSecret: fieldPresence(raw, `MACF_RUNNER_OPS_${seg}_CLIENT_SECRET`, false),
    webhookSecret: fieldPresence(raw, `MACF_RUNNER_OPS_${seg}_WEBHOOK_SECRET`, false),
    privateKey: fieldPresence(raw, `MACF_RUNNER_OPS_${seg}_PRIVATE_KEY_B64`, true),
  };
}

/** Presence-count sibling for {@link queryVaultRunnerOpsPresence} — mirrors `countVaultAgentPresence`/`countVaultCaPresence`/`countVaultRoutingPresence` below. */
export function countVaultRunnerOpsPresence(p: VaultRunnerOpsPresence): VaultPresenceCount {
  return countVaultPresence([p.appId, p.installId, p.clientId, p.clientSecret, p.webhookSecret, p.privateKey]);
}

/**
 * Decode the runner-ops App's PRIVATE KEY PEM out of an already-decrypted
 * vault raw map — the runner-ops sibling of {@link vaultAgentPrivateKeyPem}
 * (groundnuty/macf#954), the SECOND (and only other) raw-secret-returning
 * query in this module. Exists for the identical reason:
 * `macf bootstrap apply`'s vault-aware confirm-before-create guard
 * (DR-043 Amendment A) needs the ACTUAL PEM bytes to mint an App JWT — but
 * until this function existed, `commands/bootstrap-apply.ts`'s
 * `resolveVaultAgentPems` had no way to populate a `'runner-ops'` entry in
 * its role→PEM map (it only ever looped `manifest.agents`, which never
 * contains this role), so a vault-confirmable runner-ops App fell all the
 * way to `skip-unverified` even with both `--vault`/`--identity-key` given.
 *
 * Returns `undefined` when the field is absent or empty — same
 * never-fabricate-a-PEM contract as `vaultAgentPrivateKeyPem`.
 *
 * **Caller obligation — same as {@link vaultAgentPrivateKeyPem}.** The
 * returned string MUST NOT be logged, printed, or embedded in an
 * error/exception message; a caller writing it to a scratch file for a JWT
 * mint must treat that file exactly the way `apply-agent.ts`'s
 * `writeScratchPem`/`cleanupScratchPem` do: 0600, short-lived, deleted once
 * the confirm completes.
 */
export function vaultRunnerOpsPrivateKeyPem(raw: Readonly<Record<string, string>>, fleetName: string): string | undefined {
  const seg = toVariableSegment(deriveRunnerOpsHandle(fleetName));
  const b64 = raw[`MACF_RUNNER_OPS_${seg}_PRIVATE_KEY_B64`];
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

/**
 * Decode the per-project CA CERT PEM out of an already-decrypted vault raw
 * map — the revive-path counterpart to {@link queryVaultCaPresence}
 * (groundnuty/macf#978: `deactivate` deletes the registry `<SEG>_CA_CERT`
 * leg but never touches the vault or `fleet.lock`, so the cert this function
 * returns is the SAME bytes `apply-ca.ts::resolveCaCert` would otherwise
 * refuse to re-materialize). Keyed the SAME forward way
 * {@link queryVaultCaPresence} already uses (`toVariableSegment(project)`) —
 * never reverse-parsed off the vault's own key names.
 *
 * **Public material, still never logged.** Unlike {@link vaultAgentPrivateKeyPem}
 * / {@link vaultRunnerOpsPrivateKeyPem} (PRIVATE keys), a CA cert is public
 * by construction — but this module keeps the SAME never-log discipline for
 * it anyway: the only intended caller (`apply-ca.ts::resolveCaCert`'s
 * vault-restore path) threads the returned PEM straight into
 * `publishCaCertLegs` and its own `redactCaResolve` render boundary, never
 * into a log line or thrown message — see this module's doc's
 * redaction-boundary paragraph for why "public" doesn't mean "safe to
 * print here."
 *
 * Returns `undefined` when the field is absent or empty — never fabricates
 * a cert. The caller (`resolveCaCert`) degrades to its existing refusal in
 * that case, unchanged.
 */
export function vaultCaCertPem(raw: Readonly<Record<string, string>>, project: string): string | undefined {
  const seg = toVariableSegment(project);
  const b64 = raw[`MACF_${seg}_CA_CERT_B64`];
  if (b64 === undefined || b64.length === 0) return undefined;
  return Buffer.from(b64, 'base64').toString('utf-8');
}

export interface VaultRoutingPresence {
  readonly appId: VaultFieldPresence;
  readonly appKey: VaultFieldPresence;
  readonly clientCert: VaultFieldPresence;
  readonly clientKey: VaultFieldPresence;
  readonly tsOauthClientId: VaultFieldPresence;
  readonly tsOauthSecret: VaultFieldPresence;
}

/**
 * The 6-secret routing block's presence — fleet-level, not per-agent
 * (matches `VaultRoutingSecrets` in `vault-write.ts`). **Naming is STALE as
 * of groundnuty/macf#1074**: "shared `macf-routing` App" described an
 * unbuilt, account-wide-reuse design (`VaultRoutingSecrets`'s own doc); the
 * fields this function checks presence for are now populated by a
 * DEDICATED PER-FLEET router App instead (`apply-router-app.ts`) — see this
 * file's "Router App + Tailscale OAuth value decoders" section for the
 * actual read-side consumers.
 */
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

/**
 * Decode the routing-client CERT PEM out of an already-decrypted vault raw
 * map — the routing-client sibling of {@link vaultCaCertPem} (groundnuty/
 * macf#986: minting the routing-client cert is fleet-scoped, but PUBLISHING
 * it to a repo is per-repo — a repo added to the fleet AFTER the cert was
 * minted in a prior run needs its cert/key re-read from the vault, not a
 * re-mint). Fleet-level, not per-project — mirrors
 * {@link queryVaultRoutingPresence}'s own un-prefixed `ROUTING_CLIENT_CERT_B64`
 * key (see `vault-write.ts::VaultRoutingClientSecrets`'s doc for why: the
 * routing-client cert is ONE fleet-wide credential, `CN=routing-action`,
 * never per-agent or per-project, so there is no `project`/`fleetName`
 * parameter to key on here, unlike {@link vaultCaCertPem}).
 *
 * Public material (a cert) — same never-log discipline as
 * {@link vaultCaCertPem} anyway (see that function's doc for why "public"
 * doesn't mean "safe to print here"). Returns `undefined` when the field is
 * absent or empty — never fabricates a cert.
 */
export function vaultRoutingClientCertPem(raw: Readonly<Record<string, string>>): string | undefined {
  const b64 = raw['ROUTING_CLIENT_CERT_B64'];
  if (b64 === undefined || b64.length === 0) return undefined;
  return Buffer.from(b64, 'base64').toString('utf-8');
}

/**
 * Decode the routing-client PRIVATE KEY PEM out of an already-decrypted
 * vault raw map (groundnuty/macf#986) — the routing-client sibling of
 * {@link vaultAgentPrivateKeyPem}/{@link vaultRunnerOpsPrivateKeyPem} (a
 * THIRD raw-PRIVATE-KEY-secret-returning query in this module). Same
 * fleet-level keying as {@link vaultRoutingClientCertPem} — see that
 * function's doc.
 *
 * **Caller obligation — same as {@link vaultAgentPrivateKeyPem}.** The
 * returned string MUST NOT be logged, printed, or embedded in an
 * error/exception message. The only legitimate use is
 * `apply-routing-client.ts::realSetRepoSecret`'s STDIN pipe to `gh secret
 * set` — never a scratch file on disk (unlike an agent's App private key,
 * this credential never needs to mint a JWT, so it never needs the
 * `writeScratchPem`/`cleanupScratchPem` 0600-scratch-file treatment
 * {@link vaultAgentPrivateKeyPem}'s callers use).
 *
 * Returns `undefined` when the field is absent or empty — never fabricates
 * a key.
 */
export function vaultRoutingClientKeyPem(raw: Readonly<Record<string, string>>): string | undefined {
  const b64 = raw['ROUTING_CLIENT_KEY_B64'];
  if (b64 === undefined || b64.length === 0) return undefined;
  return Buffer.from(b64, 'base64').toString('utf-8');
}

// --- Router App + Tailscale OAuth value decoders (groundnuty/macf#1074) ---
//
// These read the SAME flat `MACF_ROUTING_APP_*`/`TS_OAUTH_*` vault keys
// {@link queryVaultRoutingPresence} already checks presence for (that
// function + `VaultRoutingSecrets` in `vault-write.ts` predate #1074 and
// modeled an unbuilt, account-wide SHARED App — see that type's doc for why
// it's stale). #1074's dedicated PER-FLEET router App reuses these SAME key
// names: one vault.age file per fleet means a flat (non-fleet-segmented)
// name is unambiguous within it, exactly like `ROUTING_CLIENT_CERT_B64`
// above already is for the fleet-wide routing-client cert.

/**
 * Decode the router App's ID out of an already-decrypted vault raw map — the
 * router-App sibling of {@link vaultRoutingClientCertPem}. Public-ish (a
 * numeric App ID, not secret material) but returned via the same
 * never-fabricate contract as every other query in this module: `undefined`
 * when absent or empty, never a fabricated value.
 */
export function vaultRouterAppId(raw: Readonly<Record<string, string>>): string | undefined {
  const value = raw['MACF_ROUTING_APP_ID'];
  if (value === undefined || value.length === 0) return undefined;
  return value;
}

/**
 * Decode the router App's PRIVATE KEY PEM out of an already-decrypted vault
 * raw map (groundnuty/macf#1074) — the router-App sibling of
 * {@link vaultRunnerOpsPrivateKeyPem}. Exists for the identical reason: a
 * re-run against a fleet whose router App was created in a PRIOR run has no
 * PEM in process memory (only a fresh gate-1 exchange ever does), so
 * `commands/bootstrap-apply.ts`'s `resolveVaultAgentPems` needs an EXPLICIT
 * `'router'` lookup alongside its `manifest.agents` loop, mirroring
 * `RUNNER_OPS_ROLE`'s own explicit entry — `manifest.agents[]` never
 * contains this role either (`apply-router-app.ts`'s module doc).
 *
 * **Caller obligation — same as {@link vaultAgentPrivateKeyPem}/
 * {@link vaultRunnerOpsPrivateKeyPem}.** The returned string MUST NOT be
 * logged, printed, or embedded in an error/exception message.
 *
 * Returns `undefined` when the field is absent or empty — never fabricates
 * a key.
 */
export function vaultRouterAppKeyPem(raw: Readonly<Record<string, string>>): string | undefined {
  const b64 = raw['MACF_ROUTING_APP_KEY_B64'];
  if (b64 === undefined || b64.length === 0) return undefined;
  return Buffer.from(b64, 'base64').toString('utf-8');
}

/**
 * Decode the operator-supplied Tailscale OAuth client ID out of an
 * already-decrypted vault raw map (groundnuty/macf#1074, Amendment C:
 * operator-provided, never tool-minted — `apply` only ever READS this
 * field, never writes it). RAW value, never base64 (`buildVaultPlaintext`'s
 * `payload.routing` branch emits it with a bare `emitLine`, not
 * `toBase64`). Returns `undefined` when absent or empty — never fabricates
 * a value.
 */
export function vaultTsOauthClientId(raw: Readonly<Record<string, string>>): string | undefined {
  const value = raw['TS_OAUTH_CLIENT_ID'];
  if (value === undefined || value.length === 0) return undefined;
  return value;
}

/**
 * Decode the operator-supplied Tailscale OAuth secret out of an
 * already-decrypted vault raw map — the sibling of
 * {@link vaultTsOauthClientId}, same RAW (non-base64) encoding, same
 * never-write / read-only contract, same never-fabricate return shape.
 *
 * **Caller obligation.** This IS secret material (unlike the client ID,
 * which GitHub/Tailscale treat as a public-ish identifier) — MUST NOT be
 * logged, printed, or embedded in an error/exception message.
 */
export function vaultTsOauthSecret(raw: Readonly<Record<string, string>>): string | undefined {
  const value = raw['TS_OAUTH_SECRET'];
  if (value === undefined || value.length === 0) return undefined;
  return value;
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

/**
 * Fleet-level sibling of {@link VaultCaObservation}, for the router App's
 * presence in THIS fleet's own vault (groundnuty/macf#1105) — a single
 * boolean, not a multi-field tally like the agent/CA siblings above, because
 * there is exactly one fact `plan.ts::routerAppItem` needs from the vault:
 * would `apply-router-app.ts::resolveSharedRouterAppReuse` find a credential
 * to reuse here, without spending a live GitHub call. `present` reflects
 * `MACF_ROUTING_APP_ID` only (`vaultRouterAppId`) — the same field the real
 * reuse decision reads first, before any live name-collision check.
 *
 * `'confirmed', present: false` is a genuine, DEFINITE absence — unlike the
 * GitHub-App-JWT case Amendment A4 forbids proving absent, a successfully
 * DECRYPTED vault either has `MACF_ROUTING_APP_ID` or it doesn't; there is no
 * live-API ambiguity here. `'unknown'` is reserved for "the vault itself
 * could not be read this run" (missing file, bad identity key, wrong key,
 * malformed content) — the same Amendment A4 floor {@link VaultCaObservation}
 * already establishes.
 */
export type VaultRouterAppObservation =
  | { readonly status: 'confirmed'; readonly present: boolean }
  | { readonly status: 'unknown'; readonly reason: string };

/**
 * Fleet-level sibling of {@link VaultRouterAppObservation}, for the
 * operator-supplied Tailscale OAuth pair's presence in THIS fleet's own
 * vault (groundnuty/macf#1109) — surfaced at PLAN time so the operator
 * learns whether `apply` will actually publish `TS_OAUTH_CLIENT_ID`/
 * `TS_OAUTH_SECRET` BEFORE approving the run, rather than from a trailing
 * "next steps" note after `apply` already read (or failed to find) the
 * values. `present` reflects BOTH fields (`vaultTsOauthClientId` AND
 * `vaultTsOauthSecret`) — the pair is published as a single
 * `RoutingSecretResolution` each (`apply-fleet.ts`'s doc), so a plan
 * reporting "one of two present" as `present: true` would be a false
 * all-clear. Same Amendment A4 floor as {@link VaultRouterAppObservation}:
 * `'unknown'` is reserved for "the vault itself could not be read this
 * run," never a false "absent."
 */
export type VaultTsOauthObservation =
  | { readonly status: 'confirmed'; readonly present: boolean }
  | { readonly status: 'unknown'; readonly reason: string };

// --- Recipient-set reconciliation — DR-043 §D5 (groundnuty/macf#957) ---
//
// The gap this closes: an operator adds a second `age_recipients` entry
// (e.g. the VM's key, alongside the operator's) so `macf fleet deploy` can
// decrypt the vault on the VM — but through this increment, NOTHING ever
// observed the recipient-set difference (`plan.ts` had no item for it) and
// `apply-fleet.ts::settleVault` early-returned `{status:'skipped'}` whenever
// no NEW secret was minted this run, which is the ordinary steady state for
// an already-provisioned fleet. The manifest change committed cleanly,
// `fleet.lock` looked healthy, and the vault kept decrypting under the OLD
// recipient set only — written-but-never-applied.
//
// **Detection needs no private key at all.** `age`'s multi-recipient file
// header carries one `-> X25519 <ephemeral-pubkey>` STANZA per recipient —
// verified empirically against the real `age` binary (v1.x) for this
// increment's report: 1 recipient -> 1 stanza, 2 recipients -> 2 stanzas,
// a DUPLICATE recipient passed twice -> 2 stanzas (age does not dedupe, it
// only warns) — so the stanza COUNT is exactly `recipients.length` at
// encrypt time, observable by reading the file's plaintext header bytes.
// What the header can NEVER reveal is WHICH public key a stanza targets:
// the stored value is an EPHEMERAL key generated fresh per recipient per
// encryption (anonymous X25519 ECDH), not the recipient's own `age1...`
// public key. So a stanza-count comparison is a CEILING on what's
// observable without holding every declared recipient's private key (which
// the operator does not, in general — the VM's key lives on the VM):
//   - `stanzaCount !== recipients.length` is a DEFINITE difference (this
//     module's own write path, `vault-write.ts::ageEncryptToFile`, always
//     passes ONE `-r` argument per manifest entry — count and length can
//     only diverge if the SET actually diverged since the last write).
//   - `stanzaCount === recipients.length` is only a COUNT match — never
//     claimed as a confirmed identity match (Amendment A4's honest-unknown
//     floor extends here: "never report a definite match you cannot
//     establish").
//
// **The actual re-encrypt needs an operator identity.** Amendment D: the
// vault is read-only-decryptable and whole-payload-writable, NEVER
// read-modify-written. Reconciling a recipient-set change is therefore a
// DECRYPT-then-WHOLE-REWRITE — {@link reencryptVault} decrypts the CURRENT
// vault (needs `--identity-key`), validates the plaintext still parses as a
// real vault, and re-encrypts the SAME, byte-for-byte UNCHANGED plaintext
// string to the new recipient set. Never a merge, never a partial update,
// never a parse-then-reserialize round trip that could silently reshape a
// value — the exact bytes {@link ageDecryptFile} returned are the exact
// bytes handed to {@link ageEncryptToFile}.

const AGE_MAGIC_LINE = 'age-encryption.org/v1';
const AGE_STANZA_PREFIX = '-> ';
const AGE_MAC_LINE_PREFIX = '---';
/**
 * Generous bound on how many header bytes to scan before giving up. A real
 * vault header is a few hundred bytes even at a dozen recipients (2 lines
 * per X25519 stanza, ~90 bytes each) — this only guards against treating an
 * entirely non-age file's whole (potentially large) content as "header."
 */
const AGE_HEADER_SCAN_LIMIT_BYTES = 65_536;

/**
 * Count the age-header recipient STANZAS in `bytes` — the file's declared
 * recipient CARDINALITY, observable WITHOUT any private key (see this
 * section's doc for why a stanza count can never name recipients, only
 * count them). Pure. Throws {@link VaultError} `vault_header_malformed` when
 * `bytes` doesn't start with the age magic line, or no `---` MAC line is
 * found within {@link AGE_HEADER_SCAN_LIMIT_BYTES} — the same "throw rather
 * than silently degrade" posture {@link parseVaultPlaintext} already takes
 * for a malformed plaintext (a query primitive has no "must never die"
 * constraint the way `vault.sh`'s sourced-shell reader does). The error
 * message never includes file content beyond the fixed magic-line/prefix
 * literals already in this source — nothing here can leak ciphertext bytes
 * (which are never secret in the confidentiality sense, but are also never
 * useful to echo).
 */
export function countVaultRecipientStanzas(bytes: Buffer): number {
  const scanBytes = bytes.subarray(0, Math.min(bytes.length, AGE_HEADER_SCAN_LIMIT_BYTES));
  const lines = scanBytes.toString('utf-8').split('\n');
  if (lines[0] !== AGE_MAGIC_LINE) {
    throw new VaultError(
      'vault_header_malformed',
      `file does not start with the age magic line ("${AGE_MAGIC_LINE}") — this does not look like an age-encrypted ` +
        'file (wrong path, or a vault damaged beyond its header).',
    );
  }
  let count = 0;
  let sawMacLine = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith(AGE_STANZA_PREFIX)) {
      count++;
      continue;
    }
    if (line.startsWith(AGE_MAC_LINE_PREFIX)) {
      sawMacLine = true;
      break;
    }
    // Any other line is a stanza BODY line (the wrapped file key) — not a
    // stanza of its own, so not counted. Standard base64 (age's alphabet)
    // never produces a leading '-', so a body line can never be mistaken
    // for a stanza/MAC line.
  }
  if (!sawMacLine) {
    throw new VaultError(
      'vault_header_malformed',
      `no "${AGE_MAC_LINE_PREFIX}" header-MAC line found within the first ${String(AGE_HEADER_SCAN_LIMIT_BYTES)} bytes ` +
        '— this does not look like a valid age-encrypted file (wrong file, or a vault damaged beyond its header).',
    );
  }
  return count;
}

export type VaultRecipientCountResult =
  | { readonly status: 'counted'; readonly count: number }
  /** No file at all at `vaultPath` — NOT an error: a fleet that has never been provisioned has no vault yet, so there is nothing to compare and no drift is possible. */
  | { readonly status: 'absent' };

export interface VaultRecipientCountDeps {
  readonly exists?: (path: string) => boolean;
  readonly readFile?: (path: string) => Buffer;
}

/**
 * Sync I/O leaf — no subprocess involved (a pure local-file header read, not
 * a decrypt), so unlike every other primitive in this module it needs no
 * `age` binary and no identity key. Throws {@link VaultError} only when the
 * file EXISTS but its header doesn't parse (see {@link countVaultRecipientStanzas});
 * a genuinely missing file is the non-error `{status:'absent'}` branch.
 */
export function readVaultRecipientCount(vaultPath: string, deps?: VaultRecipientCountDeps): VaultRecipientCountResult {
  const exists = deps?.exists ?? existsSync;
  if (!exists(vaultPath)) return { status: 'absent' };
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p));
  return { status: 'counted', count: countVaultRecipientStanzas(readFile(vaultPath)) };
}

/**
 * The plan-time recipient-set fact attached to `plan.ts`'s
 * `ObservedState.vaultRecipients` — sibling shape to {@link VaultAgentObservation}/
 * {@link VaultCaObservation}, extended with a THIRD state (`'no-vault'`)
 * because "no vault exists yet" is a normal, non-alarming lifecycle point
 * (the first successful apply will encrypt fresh to whatever is currently
 * declared — no drift is possible against a vault that doesn't exist),
 * distinct from `'unknown'` (a vault file IS present but its header could
 * not be read/parsed — a genuine problem worth surfacing).
 */
export type VaultRecipientsObservation =
  | { readonly status: 'confirmed'; readonly stanzaCount: number }
  | { readonly status: 'no-vault' }
  | { readonly status: 'unknown'; readonly reason: string };

export interface ReencryptVaultDeps {
  readonly decrypt?: VaultDecryptFn;
  readonly encrypt?: VaultEncryptFn;
  readonly rename?: (from: string, to: string) => void;
  readonly unlink?: (path: string) => void;
  /** Injectable randomness for a deterministic temp-file name in tests. Defaults to `crypto.randomBytes(6).toString('hex')`. */
  readonly tmpSuffix?: () => string;
}

/**
 * Decrypt-then-whole-rewrite `vaultPath` to `newRecipients` — the ONLY
 * mutating primitive in this READ module, existing here (not
 * `vault-write.ts`) because it needs BOTH the decrypt seam (this module)
 * and the encrypt seam (`vault-write.ts::ageEncryptToFile`); putting it in
 * `vault-write.ts` would require that module to import this one, which
 * already imports FROM `vault-write.ts` (`VaultError`) — a cycle.
 *
 * **Never a read-modify-write (Amendment D).** The plaintext returned by
 * {@link ageDecryptFile} is validated (via {@link parseVaultPlaintext} —
 * thrown away, never used to reconstruct a new payload) then re-encrypted
 * BYTE FOR BYTE UNCHANGED — no parse-then-reserialize round trip that could
 * silently reshape a value. Only the recipient set changes; the payload is
 * the exact bytes that decrypted, both before and after.
 *
 * **Crash-safe.** Encrypts to a TEMP path in the SAME directory as
 * `vaultPath` (so the final `rename` is atomic on one filesystem), then
 * atomically renames it over `vaultPath` — the live vault is never touched
 * until the NEW ciphertext is fully written and verified-openable-by-age.
 * A crash mid-encrypt leaves the temp file orphaned (best-effort-unlinked on
 * every failure path below) and the ORIGINAL vault untouched — unlike
 * `writeVault`'s own `-o vaultPath` direct-overwrite (safe for a FIRST
 * write, where there is nothing yet to protect), this function is used
 * exclusively against an ALREADY-LIVE vault, so leaving it correct-or-
 * untouched is the load-bearing property. The temp filename is never one of
 * `control-repo.ts`'s `CONTROL_REPO_COMMIT_ALLOWLIST` entries (an exact-path
 * list, not a glob) — an orphaned temp file is simply an untracked file, the
 * same "merely inert" property that allowlist's own doc establishes for any
 * other stray file in the checkout.
 */
export async function reencryptVault(
  vaultPath: string,
  identityPath: string,
  newRecipients: readonly string[],
  deps?: ReencryptVaultDeps,
): Promise<void> {
  if (newRecipients.length === 0) {
    throw new VaultError('vault_no_age_recipient', 'reencryptVault: no recipients supplied to re-encrypt to.');
  }
  const decrypt = deps?.decrypt ?? ((vp: string, ip: string) => ageDecryptFile(vp, ip));
  const encrypt = deps?.encrypt ?? ageEncryptToFile;
  const rename = deps?.rename ?? renameSync;
  const unlink =
    deps?.unlink ??
    ((p: string): void => {
      try {
        unlinkSync(p);
      } catch {
        /* best-effort — ENOENT (never created) or a permission issue; either way, nothing left to clean up here */
      }
    });
  const suffix = deps?.tmpSuffix?.() ?? randomBytes(6).toString('hex');

  const plaintext = await decrypt(vaultPath, identityPath);
  // Validate shape BEFORE ever re-encrypting — never reencrypt bytes that
  // don't even look like a vault. Parsed map is discarded on purpose: the
  // ORIGINAL `plaintext` string (never reconstructed) is what gets
  // re-encrypted below — see this function's doc.
  parseVaultPlaintext(plaintext);

  const tmpPath = `${vaultPath}.reencrypt-${suffix}.tmp`;
  try {
    await encrypt(plaintext, newRecipients, tmpPath);
  } catch (err) {
    unlink(tmpPath);
    throw err;
  }
  try {
    rename(tmpPath, vaultPath);
  } catch (err) {
    unlink(tmpPath);
    throw new VaultError(
      'vault_reencrypt_rename_failed',
      `re-encrypted vault written to a temp file but could not be renamed into place at "${vaultPath}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- Compose-and-write — DR-043 Amendment D "whole-payload, never
// read-modify-written" applied to ADDING a fresh credential to a vault that
// already has content (groundnuty/macf#989).
//
// The bug this closes: adding a second agent to a fleet that already had a
// vault reported the new App as CREATED (gate 1 + gate 2 both spent a real,
// irreversible consent click) and then `writeVault` REFUSED to overwrite the
// existing `vault.age` — discarding the just-minted credential entirely (no
// program can ever re-read a GitHub App's private key after the one-time
// manifest exchange). The refusal guarded the right INVARIANT (never clobber
// a vault that wasn't fully accounted for) but on the wrong AXIS: it refused
// on the file's EXISTENCE, when Amendment D's actual contract is about the
// PAYLOAD's PROVENANCE — a whole-payload rewrite composed from the vault's
// complete current contents plus this run's new receipts is exactly the
// sanctioned operation; a rewrite that would silently drop existing entries
// is what must be refused.

/**
 * Refuse a composed payload that would DROP a key present in the vault's
 * CURRENT contents — the provenance guard DR-043 Amendment D requires
 * (macf#989 "Refuse on provenance of the payload, not on existence of the
 * file"). Pure; never mutates either map.
 *
 * By construction, {@link composeAndWriteVault}'s own merge
 * (`{...existingRaw, ...newRaw}`) can never actually trigger this — an
 * object spread cannot omit a key it started with. This assertion exists as
 * an EXPLICIT, independently-testable statement of the invariant anyway
 * (not "dead code"): it is the one place a reader can see the safety
 * property stated directly rather than infer it from spread semantics, and
 * it keeps failing loud if a future refactor of the compose step (a filter,
 * a transform, a different merge strategy) ever stops preserving it.
 */
export function assertNoDroppedVaultKeys(
  existingRaw: Readonly<Record<string, string>>,
  composedRaw: Readonly<Record<string, string>>,
): void {
  const dropped = Object.keys(existingRaw).filter((k) => !(k in composedRaw));
  if (dropped.length > 0) {
    throw new VaultError(
      'vault_would_drop_keys',
      `composed payload is missing ${String(dropped.length)} key(s) present in the CURRENT vault (${dropped.join(', ')}) ` +
        '— refusing to write. A whole-payload vault rewrite must be composed from the vault\'s complete current ' +
        'contents; a payload that would drop existing entries is never written.',
    );
  }
}

export interface ComposeAndWriteVaultDeps {
  readonly exists?: (path: string) => boolean;
  readonly assertIdentityReadable?: (path: string) => void;
  readonly decrypt?: VaultDecryptFn;
  readonly encrypt?: VaultEncryptFn;
  readonly rename?: (from: string, to: string) => void;
  readonly unlink?: (path: string) => void;
  /** Injectable randomness for a deterministic temp-file name in tests. Defaults to `crypto.randomBytes(6).toString('hex')`. */
  readonly tmpSuffix?: () => string;
}

/**
 * Decrypt the CURRENT `vaultPath`, fold `newPlaintext` (this run's freshly
 * `buildVaultPlaintext`-built receipts) into it, and atomically rewrite the
 * SAME path — the compose-and-write primitive DR-043 Amendment D sanctions
 * for extending a vault that already has content (macf#989). Sibling to
 * {@link reencryptVault} (same decrypt-then-whole-rewrite shape, same
 * crash-safety posture, same reason it lives HERE rather than in
 * `vault-write.ts`: it needs both the decrypt seam this module owns and the
 * encrypt seam `vault-write.ts` owns) — the difference is WHAT gets
 * re-encrypted: `reencryptVault` re-encrypts the SAME bytes to a new
 * recipient set; this composes DIFFERENT (larger) bytes to the SAME
 * recipient set.
 *
 * **Never a read-modify-write of ciphertext (Amendment D).** The merge
 * happens entirely on DECRYPTED plaintext, in memory, as two raw
 * `KEY -> value` maps: `existingRaw` (from decrypting the CURRENT vault) and
 * `newRaw` (from parsing `newPlaintext`). `{...existingRaw, ...newRaw}` — a
 * key present in BOTH is won by `newRaw` (this run's fresher receipt for a
 * role it just processed supersedes whatever the vault held for that same
 * key). This is a DIFFERENT credential-lifecycle concern than #989's own
 * scope: if a role's App was re-created this run because a PRIOR one was
 * orphaned (the #969 dead end), the OLD App's now-stale entry is silently
 * overwritten by the NEW one under the same vault key — correct (a stale
 * key pointing at a now-abandoned App is not worth keeping), but named here
 * so it reads as a considered boundary, not an unexamined one.
 *
 * **Crash-safe.** Same atomic temp-file-in-the-same-directory + rename
 * pattern {@link reencryptVault} uses — the live vault is never touched
 * until the new ciphertext is fully written; a crash mid-encrypt leaves an
 * orphaned (best-effort-unlinked) temp file and the ORIGINAL vault
 * untouched, never a truncated live vault.
 *
 * Throws {@link VaultError} on every failure mode `readVault` already
 * distinguishes (`vault_not_found` / `vault_identity_unreadable` /
 * `vault_decrypt_failed` / `vault_malformed_plaintext`), plus
 * `vault_would_drop_keys` ({@link assertNoDroppedVaultKeys}) and
 * `vault_compose_rename_failed` (the atomic swap itself failed after a
 * successful encrypt). Never partially writes — either the FULL composed
 * vault lands at `vaultPath`, or `vaultPath` is byte-for-byte unchanged.
 */
export async function composeAndWriteVault(
  vaultPath: string,
  identityPath: string,
  newPlaintext: string,
  recipients: readonly string[],
  deps?: ComposeAndWriteVaultDeps,
): Promise<WriteVaultResult> {
  if (recipients.length === 0) {
    throw new VaultError('vault_no_recipients', 'composeAndWriteVault: at least one age recipient is required.');
  }
  const encrypt = deps?.encrypt ?? ageEncryptToFile;
  const rename = deps?.rename ?? renameSync;
  const unlink =
    deps?.unlink ??
    ((p: string): void => {
      try {
        unlinkSync(p);
      } catch {
        /* best-effort — ENOENT (never created) or a permission issue; either way, nothing left to clean up here */
      }
    });
  const suffix = deps?.tmpSuffix?.() ?? randomBytes(6).toString('hex');

  const existingRaw = await readVault(
    { vaultPath, identityPath },
    { exists: deps?.exists, assertIdentityReadable: deps?.assertIdentityReadable, decrypt: deps?.decrypt },
  );
  // Shape-validate the new receipts too (defense-in-depth — `newPlaintext`
  // is always `buildVaultPlaintext` output in production, already valid by
  // construction, but a caller driving this function directly could hand it
  // something else).
  const newRaw = parseVaultPlaintext(newPlaintext);
  const composedRaw: Record<string, string> = { ...existingRaw, ...newRaw };
  assertNoDroppedVaultKeys(existingRaw, composedRaw);
  const composedPlaintext = serializeVaultRawMap(composedRaw);

  const tmpPath = `${vaultPath}.compose-${suffix}.tmp`;
  try {
    await encrypt(composedPlaintext, recipients, tmpPath);
  } catch (err) {
    unlink(tmpPath);
    throw err;
  }
  try {
    rename(tmpPath, vaultPath);
  } catch (err) {
    unlink(tmpPath);
    throw new VaultError(
      'vault_compose_rename_failed',
      `composed vault written to a temp file but could not be renamed into place at "${vaultPath}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { path: vaultPath, versioned: false };
}
