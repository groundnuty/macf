/**
 * `vault.age` write-through — DR-043 §D5 (the vault as store of record),
 * Slice 2b increment 4 (groundnuty/macf#838, macf#846 review).
 *
 * TypeScript port of `tools/macf-bootstrap/.claude/scripts/bootstrap-build-vault.sh`
 * — "mechanism promoted to code" per DR-043, same posture as `manifest-exchange.ts`
 * porting `bootstrap-exchange-manifest.sh`. Two hard-won guards carried over:
 *
 *   1. **No plaintext ever touches disk.** The assembled plaintext is piped
 *      to `age` on STDIN and `age` itself writes the encrypted output — there
 *      is no `vault.plain` file at any point (the shell's #659 secrets-on-disk
 *      review; §D5 Design invariant 5).
 *   2. **Never silently clobber an existing vault.** Mirrors
 *      `bootstrap-commit-vault.sh`'s fail-loud-unless-versioned guard (this
 *      module applies it to whatever local path a caller gives it — the
 *      GIT clone/commit machinery that shell script also does is NOT ported
 *      here; that is orchestration a future `apply` increment owns).
 *
 * **Multi-recipient (§D5, new 2026-08-11):** `writeVault` takes a LIST of age
 * recipients and encrypts to all of them in one `age -r <r1> -r <r2> ...`
 * invocation (age supports this natively) — this is what lets vault.age be
 * decrypted by EITHER the operator's key or the VM's key. **Scope note:**
 * this module does not decrypt-merge-reencrypt a PRIOR vault to fold in
 * secrets a caller didn't pass — deliverable 2's brief is explicitly "mirror
 * the shell's behavior" (fail-or-version), not build the read/reuse path;
 * see the module-level report on this increment for why that's a deliberate
 * boundary, not an oversight.
 *
 * **Shell-injection posture (macf#846 review nit b):** `vault.sh` decrypts
 * `vault.age` and sources the result via `eval "$_vault_plain"` on the VM.
 * Inside a `KEY="value"` line under `eval`, `"`, `$`, backtick, and `\` all
 * retain shell meta-meaning — a raw value containing `$(...)` or `` `...` ``
 * would EXECUTE on the VM at `source vault.sh` time. Every raw (non-base64)
 * value is guarded against this before it is ever assembled into a line;
 * base64 output (the PEM/cert fields) is inherently safe
 * (`[A-Za-z0-9+/=]` only) and does not need the guard.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { toVariableSegment } from '@groundnuty/macf-core';

/** Thrown by every failure mode in this module — mirrors `ManifestExchangeError`'s shape. */
export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

// --- Payload assembly (pure) ---

/** One agent's credentials as they land in the vault. `appHandle` MUST be `deriveAppHandle(fleet, role)` — the SAME handle the App was created under (`AppCredentials.name`), never the bare role (avoids cross-fleet key-name collisions in `~/.macf/keys/` on a shared VM — matches `bootstrap-emit-commands.sh`'s `key_path` convention). */
export interface VaultAgentSecrets {
  readonly appHandle: string;
  readonly appId: string;
  readonly installId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookSecret: string;
  /** RAW PEM text (not base64 yet — {@link buildVaultPlaintext} encodes it). Secret — never log. */
  readonly pem: string;
}

/** The shared `macf-routing` App + the 6 routing secrets (per `macf-consumer-onboarding.md`), fleet-level (one per fleet, not per agent). */
export interface VaultRoutingSecrets {
  readonly appId: string;
  readonly appKeyPem: string;
  readonly clientCertPem: string;
  readonly clientKeyPem: string;
  readonly tsOauthClientId: string;
  readonly tsOauthSecret: string;
}

/** The per-project CA key material (§D5: the vault is its durable store — `certs init`'s registry backup is skipped in the bootstrap flow for exactly this reason). */
export interface VaultCaSecrets {
  readonly project: string;
  readonly caKeyPem: string;
  readonly caCertPem: string;
}

export interface VaultPayload {
  readonly agents: readonly VaultAgentSecrets[];
  readonly routing?: VaultRoutingSecrets;
  readonly ca?: VaultCaSecrets;
}

const SHELL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `"` `$` backtick `\` CR LF — see module doc's shell-injection posture. */
const SHELL_UNSAFE_VALUE_RE = /["$`\\\r\n]/;

function toBase64(raw: string): string {
  return Buffer.from(raw, 'utf-8').toString('base64');
}

/**
 * The emitted `KEY` itself must be a valid shell identifier — `eval` sources
 * it as an assignment target. Defense-in-depth, not a fix for a reachable
 * bug: every `appHandle`/`project` this module is actually called with
 * originates from `fleet-manifest.ts`'s schema-validated `metadata.name`
 * (`FLEET_NAME_RE`) + `role` (`ROLE_CHARSET_RE`) charsets — both restricted
 * to `[a-z0-9-]`, so `toVariableSegment` can only ever produce `[A-Z0-9_]`,
 * and every emitted key additionally carries a static alphabetic prefix
 * (`MACF_AGENT_`, `MACF_`, `ROUTING_CLIENT_`, `TS_OAUTH_`) that keeps the
 * result identifier-shaped even for a segment starting with a digit. This
 * guard exists for a caller that hand-constructs a `VaultAgentSecrets`
 * bypassing that schema (e.g. a test, or a future caller with a different
 * source of truth) — not because the schema-validated path can trip it.
 */
function assertValidShellIdentifier(key: string): void {
  if (!SHELL_IDENTIFIER_RE.test(key)) {
    throw new VaultError(
      'vault_invalid_key',
      `"${key}" is not a valid shell variable name (^[A-Za-z_][A-Za-z0-9_]*$) — vault.sh sources the ` +
        'decrypted plaintext via `eval`, so every emitted KEY must be assignable.',
    );
  }
}

/** The RAW value must not carry shell metacharacters — see module doc. Never includes `value` in the thrown message (never log/print a secret). */
function assertShellSafeValue(key: string): (value: string) => void {
  return (value: string) => {
    if (value.length === 0) {
      throw new VaultError('vault_empty_value', `${key}: refusing to write an empty secret value into the vault.`);
    }
    if (SHELL_UNSAFE_VALUE_RE.test(value)) {
      throw new VaultError(
        'vault_unsafe_value',
        `${key}: value contains a shell metacharacter (one of " $ \` \\ or a CR/LF) that would not be inert ` +
          'under vault.sh\'s `eval "$_vault_plain"` on the VM. GitHub-issued client/webhook secrets have not ' +
          'been observed to contain these; if one legitimately does, base64-encode it upstream like the PEM fields.',
      );
    }
  };
}

function emitLine(lines: string[], key: string, value: string): void {
  assertValidShellIdentifier(key);
  assertShellSafeValue(key)(value);
  lines.push(`${key}="${value}"`);
}

/**
 * `toVariableSegment('')` is `''` — a segment source that is present but
 * EMPTY does not fail `assertValidShellIdentifier` (the surrounding
 * `MACF_AGENT_`/`MACF_` prefix alone is a valid identifier: `MACF_AGENT__APP_ID`
 * parses fine), so an empty `appHandle`/`project` would otherwise write a
 * silently-WRONG-but-well-formed vault entry that `vault.sh` can never map
 * back to a real key file — a silent-fallback shape, not a loud one. Guard
 * the segment SOURCE directly, before it is even turned into a segment.
 */
function assertNonEmptySegmentSource(fieldName: string, value: string): void {
  if (value.trim().length === 0) {
    throw new VaultError('vault_empty_segment_source', `${fieldName}: refusing to write a vault entry keyed on an empty value.`);
  }
}

/**
 * Assemble the vault PLAINTEXT (shell-sourceable env-file text, matching
 * `templates/vault.template.txt`'s shape exactly) from typed credentials.
 * Pure — no I/O, no clock, no randomness. Throws {@link VaultError} on an
 * empty payload, an empty/unsafe raw value, an invalid emitted key name, or
 * an empty `appHandle`/`project` (which would otherwise segment-derive to a
 * silently-wrong key) — never silently produces a truncated or corrupt
 * vault body.
 */
export function buildVaultPlaintext(payload: VaultPayload): string {
  const lines: string[] = [];

  for (const agent of payload.agents) {
    assertNonEmptySegmentSource('agent.appHandle', agent.appHandle);
    const seg = toVariableSegment(agent.appHandle);
    emitLine(lines, `MACF_AGENT_${seg}_APP_ID`, agent.appId);
    emitLine(lines, `MACF_AGENT_${seg}_INSTALL_ID`, agent.installId);
    emitLine(lines, `MACF_AGENT_${seg}_CLIENT_ID`, agent.clientId);
    emitLine(lines, `MACF_AGENT_${seg}_CLIENT_SECRET`, agent.clientSecret);
    emitLine(lines, `MACF_AGENT_${seg}_WEBHOOK_SECRET`, agent.webhookSecret);
    emitLine(lines, `MACF_AGENT_${seg}_PRIVATE_KEY_B64`, toBase64(agent.pem));
  }

  if (payload.routing !== undefined) {
    emitLine(lines, 'MACF_ROUTING_APP_ID', payload.routing.appId);
    emitLine(lines, 'MACF_ROUTING_APP_KEY_B64', toBase64(payload.routing.appKeyPem));
    emitLine(lines, 'ROUTING_CLIENT_CERT_B64', toBase64(payload.routing.clientCertPem));
    emitLine(lines, 'ROUTING_CLIENT_KEY_B64', toBase64(payload.routing.clientKeyPem));
    emitLine(lines, 'TS_OAUTH_CLIENT_ID', payload.routing.tsOauthClientId);
    emitLine(lines, 'TS_OAUTH_SECRET', payload.routing.tsOauthSecret);
  }

  if (payload.ca !== undefined) {
    assertNonEmptySegmentSource('ca.project', payload.ca.project);
    const proj = toVariableSegment(payload.ca.project);
    emitLine(lines, `MACF_${proj}_CA_KEY_B64`, toBase64(payload.ca.caKeyPem));
    emitLine(lines, `MACF_${proj}_CA_CERT_B64`, toBase64(payload.ca.caCertPem));
  }

  if (lines.length === 0) {
    throw new VaultError(
      'vault_empty_payload',
      'buildVaultPlaintext: payload has no agents, routing, or CA secrets — nothing to write.',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Derive the RAW secret-name → value map for one agent's fingerprint-pairing
 * (§D5) — the SAME field set {@link buildVaultPlaintext} writes into the
 * vault (`client_secret`, `webhook_secret`, `app_private_key`), named once
 * here so a caller assembling BOTH surfaces in one apply reads the mapping
 * off a single place rather than re-deriving the secret-name strings twice
 * and risking the vault + lock drifting apart on a rename. Feed the result
 * straight into `fleet-lock.ts`'s `ComposeFleetLockInput.agentUpdates[role].secrets`
 * — that function fingerprints it; this function does NOT (it hands back
 * raw values, on purpose, so this module never needs to import the hashing
 * primitive it has no other use for).
 */
export function vaultAgentSecretsForFingerprint(agent: VaultAgentSecrets): Record<string, string> {
  return {
    client_secret: agent.clientSecret,
    webhook_secret: agent.webhookSecret,
    app_private_key: agent.pem,
  };
}

/** Fleet-level sibling of {@link vaultAgentSecretsForFingerprint} — feeds `ComposeFleetLockInput.fleetSecrets`. */
export function vaultFleetSecretsForFingerprint(payload: VaultPayload): Record<string, string> {
  const out: Record<string, string> = {};
  if (payload.routing !== undefined) {
    out.routing_app_key = payload.routing.appKeyPem;
    out.routing_client_cert = payload.routing.clientCertPem;
    out.routing_client_key = payload.routing.clientKeyPem;
    out.ts_oauth_secret = payload.routing.tsOauthSecret;
    // routing.appId + tsOauthClientId are opaque PUBLIC identifiers, not
    // secrets — no fingerprint needed (day-2; not blocking §D5's core
    // write-through).
  }
  if (payload.ca !== undefined) {
    out.ca_key = payload.ca.caKeyPem;
  }
  return out;
}

// --- Encryption (I/O leaf, injectable) ---

const AGE_ENCRYPT_TIMEOUT_MS = 30_000;

/**
 * Real `age` invocation — streams `plaintext` to `age`'s STDIN and lets
 * `age` itself write the encrypted output straight to `outPath` via `-o`
 * (mirrors `bootstrap-build-vault.sh`'s
 * `printf '%s\n' "$plaintext" | age "${recip_args[@]}" -o "$OUT"` exactly).
 * No plaintext ever touches disk — the load-bearing §D5 property. One
 * `-r <recipient>` per entry (age supports multi-recipient natively).
 *
 * Thin I/O leaf — not unit-tested against a fake process (same posture as
 * `identity-confirm.ts`'s `confirmAppInstallation`); exercised for real
 * against the actual `age` binary where available (`vault-write.test.ts`,
 * skipped when `age` is not on PATH).
 */
export function ageEncryptToFile(plaintext: string, recipients: readonly string[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];
    for (const r of recipients) args.push('-r', r);
    args.push('-o', outPath);

    const child = spawn('age', args, { stdio: ['pipe', 'ignore', 'pipe'] });
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
        reject(new VaultError('vault_encrypt_timeout', `age did not exit within ${String(AGE_ENCRYPT_TIMEOUT_MS)}ms.`));
      });
    }, AGE_ENCRYPT_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    // A failed spawn (e.g. `age` missing) can leave stdin unusable — without
    // this handler, the write below throws an unhandled EPIPE-style 'error'
    // on the stream itself, separate from the child's own 'error' event.
    child.stdin?.on('error', () => {
      /* surfaced via the child 'error'/'close' handlers below instead */
    });
    child.on('error', (err) => {
      finish(() => {
        reject(new VaultError('vault_encrypt_spawn_failed', `Failed to spawn "age" — is it on PATH? (${err.message})`));
      });
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new VaultError('vault_encrypt_failed', `age exited ${String(code)}: ${stderr.trim()}`));
      });
    });

    child.stdin?.write(plaintext, 'utf-8');
    child.stdin?.end();
  });
}

export type VaultEncryptFn = (plaintext: string, recipients: readonly string[], outPath: string) => Promise<void>;

export interface WriteVaultOptions {
  readonly outPath: string;
  /** At least one age recipient (`age1...` public key) is required — §D5 multi-recipient is "operator key + VM key," but a single-recipient call is still valid (e.g. a v1-style vault). */
  readonly recipients: readonly string[];
  /** When `true` and `outPath` already exists, write a timestamped sibling instead of failing (mirrors `MACF_BOOTSTRAP_VAULT_VERSION=1`). Default: fail loud. */
  readonly allowVersion?: boolean;
  /** Injectable clock for deterministic version-suffix tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export interface WriteVaultDeps {
  readonly exists?: (path: string) => boolean;
  readonly encrypt?: VaultEncryptFn;
}

export interface WriteVaultResult {
  readonly path: string;
  readonly versioned: boolean;
}

/** `2026-08-11T12:34:56.789Z` → `20260811T123456Z` — matches `bootstrap-commit-vault.sh`'s `date -u +%Y%m%dT%H%M%SZ`. */
function utcCompactTimestamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** `secrets/vault.age` + `20260811T123456Z` → `secrets/vault.20260811T123456Z.age`. No extension → append (`vault-noext` → `vault-noext.<ts>`). */
function versionedSiblingPath(path: string, ts: string): string {
  const idx = path.lastIndexOf('.');
  if (idx <= 0) return `${path}.${ts}`;
  return `${path.slice(0, idx)}.${ts}${path.slice(idx)}`;
}

/**
 * Encrypt `plaintext` (from {@link buildVaultPlaintext}) to `opts.outPath`,
 * refusing to clobber an existing vault unless `opts.allowVersion` is set
 * (mirrors `bootstrap-commit-vault.sh`'s non-destructive guarantee — DR-043
 * §D5 / Design invariant 5). `deps` is the injectable seam: tests supply a
 * fake `exists`/`encrypt` so no real `age` binary or real age keys are
 * needed to exercise this orchestration logic.
 */
export async function writeVault(
  plaintext: string,
  opts: WriteVaultOptions,
  deps?: WriteVaultDeps,
): Promise<WriteVaultResult> {
  if (plaintext.trim().length === 0) {
    throw new VaultError(
      'vault_empty_plaintext',
      'writeVault: empty plaintext — nothing to encrypt (mirrors bootstrap-build-vault.sh\'s STDIN-empty guard).',
    );
  }
  if (opts.recipients.length === 0) {
    throw new VaultError(
      'vault_no_recipients',
      'writeVault: at least one age recipient is required (§D5 multi-recipient: operator key + VM key).',
    );
  }

  const exists = deps?.exists ?? existsSync;
  const encrypt = deps?.encrypt ?? ageEncryptToFile;

  let destPath = opts.outPath;
  let versioned = false;
  if (exists(destPath)) {
    if (opts.allowVersion !== true) {
      throw new VaultError(
        'vault_exists',
        `${destPath} already exists — refusing to overwrite an existing vault (DR-043 §D5 non-destructive ` +
          "guarantee; mirrors bootstrap-commit-vault.sh's fail-loud-on-clobber). Pass { allowVersion: true } " +
          'to version instead of overwrite (writes a timestamped sibling file, mirrors MACF_BOOTSTRAP_VAULT_VERSION=1).',
      );
    }
    destPath = versionedSiblingPath(destPath, utcCompactTimestamp(opts.now?.() ?? new Date()));
    versioned = true;
  }

  await encrypt(plaintext, opts.recipients, destPath);
  return { path: destPath, versioned };
}
