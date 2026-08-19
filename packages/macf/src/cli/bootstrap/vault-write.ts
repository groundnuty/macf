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
 * **Shell-injection / quoting posture (macf#848, supersedes the original
 * macf#846 review nit b):** `vault.sh` USED TO decrypt `vault.age` and source
 * the result via `eval "$_vault_plain"` on the VM — under the old
 * `KEY="value"` double-quoted form, `"`, `$`, backtick, and `\` all retained
 * shell meta-meaning inside `eval`, so a raw value containing `$(...)` or
 * `` `...` `` would EXECUTE at `source vault.sh` time. That made this file's
 * entire safety rest on an enumeration argument (the blocklist below) staying
 * exhaustive forever, across every future format/quoting/secret-set change —
 * a structural risk even though the enumeration was, at the time, correct.
 * **macf#848 fixed this at the root:** `vault.sh` no longer calls `eval` at
 * all — it PARSES `KEY=VALUE` lines directly (split on the first `=`, strip
 * one layer of matching quoting, `export` the literal bytes; see
 * `templates/vault.sh`'s export-loop comment for the full mechanism), so a
 * hostile value can no longer execute regardless of what ANY writer (this
 * one, a future one, or a hand-edited vault) emits. **This module's own
 * change in the same fix:** switched from double- to SINGLE-quoted
 * `KEY='value'` output. Under single quotes (unlike double quotes) `"`, `$`,
 * backtick, and `\` are ALL inert — the only byte single quotes cannot
 * represent at all is a literal `'` (there is no escape for it inside
 * `'...'`), so that's the one residual shell-meaning guard below. CR/LF stay
 * guarded too, independent of quote-character choice: a raw value containing
 * a line break would split one `KEY=VALUE` entry across two physical lines,
 * corrupting `vault.sh`'s line-oriented parse regardless of how the value is
 * quoted — a format-integrity concern, not a shell-injection one. Every raw
 * (non-base64) value is guarded against this before it is ever assembled
 * into a line; base64 output (the PEM/cert fields) is inherently safe
 * (`[A-Za-z0-9+/=]` only, single-line) and does not need the guard. The two
 * layers (this writer's guard + `vault.sh`'s no-eval parse) are now
 * independent: either one can be wrong without the other becoming
 * exploitable.
 *
 * **Per-agent recovery artifacts (§D5 "durable before gate 2," 2026-08-11
 * review of Slice 2b increment 5a, groundnuty/macf#838):** the FINAL vault
 * above is a batched, single-shot, whole-payload write — by design, it can
 * only be composed once every agent in a run has finished. But `apply`'s
 * per-agent flow (`apply-agent.ts`) parks a multi-minute OPERATOR-WAIT
 * (consent gate 2, the install click) between "gate 1 just minted a real,
 * irreversible GitHub App + its ONLY credential copy" and "that credential
 * is durable anywhere." A crash in that window loses the credential forever
 * even though the App exists on GitHub. {@link writeAgentRecoveryArtifact}
 * closes that hole WITHOUT waiting for the batched compose: it encrypts ONE
 * agent's just-exchanged credentials to their OWN path
 * ({@link operatorRecoveryArtifactPath}, distinct from `vault.age` — the
 * single-shot clobber guard above is therefore irrelevant to it) the moment
 * they're received, before gate 2 starts, and is deleted
 * ({@link removeAgentRecoveryArtifact}) once the SAME credential has landed
 * in the final `vault.age`. See `apply-agent.ts` / `apply-fleet.ts` module
 * docs for the call-site wiring.
 *
 * **Location, corrected (groundnuty/macf#988):** the artifact used to live
 * inside `apply-fleet.ts`'s per-run control-repo `mkdtemp` checkout
 * (`<secretsDir>/recovery/<role>.age`) — a directory that dies WITH the
 * process. A run killed in the exact window this mechanism exists to
 * survive (App created, credential durably written, then the process
 * itself lost before the batched vault compose) took the artifact down
 * with it, defeating the durability guarantee by its own location. The
 * artifact now lives at {@link operatorRecoveryArtifactPath} — an
 * operator-scoped, stable path OUTSIDE any per-run checkout — and, new in
 * the same fix, {@link readRecoveryArtifact} in `vault-read.ts` makes it
 * consumable: a LATER `apply` run finds + decrypts it and folds the
 * credential into the vault instead of refusing (see `apply-agent.ts`'s
 * `AgentApplyDeps.findRecoveryArtifact` doc for the consume-side wiring).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { toVariableSegment } from '@groundnuty/macf-core';
import type { AppCredentials } from './manifest-exchange.js';

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

/**
 * The macf-actions router's mTLS client identity (groundnuty/macf#920,
 * DR-043 "routing-client re-mint" — see this file's module doc's opening
 * paragraph). Deliberately NARROWER than {@link VaultRoutingSecrets} (which
 * models the separate, unbuilt "shared macf-routing App" 6-secret block) —
 * `apply-fleet.ts`'s routing-client ceremony only ever has the CA-signed
 * cert/key pair, never the other 4 `VaultRoutingSecrets` fields (a different,
 * future ceremony). Both types happen to target the SAME vault key names
 * (`ROUTING_CLIENT_CERT_B64`/`ROUTING_CLIENT_KEY_B64`) — see
 * {@link buildVaultPlaintext}'s guard against supplying both at once.
 */
export interface VaultRoutingClientSecrets {
  readonly clientCertPem: string;
  /** Secret — never log. */
  readonly clientKeyPem: string;
}

/**
 * The runner-ops App's credentials (groundnuty/macf#943) — deliberately
 * a SEPARATE type from {@link VaultAgentSecrets}, even though the field shape
 * is identical, because it emits into a DIFFERENT vault namespace (see
 * {@link buildVaultPlaintext}'s `payload.runnerOps` branch). This App's
 * key is EXPORT-CLASS (it leaves the fleet's normal trust boundary — handed
 * to the runner platform, stored in a cluster Secret) and its permission set
 * is a ONE-WAY RATCHET (`apply-runner-ops.ts::RUNNER_OPS_PERMISSIONS`'s
 * doc) — folding it through `payload.agents[]` would put an export-class
 * credential in the SAME `MACF_AGENT_*` namespace `vault.sh` exports on every
 * VM, exactly the conflation this separate type + namespace exists to avoid.
 */
export interface VaultRunnerOpsSecrets {
  readonly appHandle: string;
  readonly appId: string;
  readonly installId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookSecret: string;
  /** RAW PEM text (not base64 yet — {@link buildVaultPlaintext} encodes it). Secret — never log. */
  readonly pem: string;
}

export interface VaultPayload {
  readonly agents: readonly VaultAgentSecrets[];
  readonly routing?: VaultRoutingSecrets;
  readonly ca?: VaultCaSecrets;
  readonly routingClient?: VaultRoutingClientSecrets;
  /** The runner-ops App's credentials (groundnuty/macf#943), when freshly minted this run — see {@link VaultRunnerOpsSecrets}'s doc for why this is its own field, not folded into `agents`. */
  readonly runnerOps?: VaultRunnerOpsSecrets;
}

const SHELL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * `'` (unrepresentable inside single-quoted output) + CR/LF (would split one
 * `KEY=VALUE` line into two) — see module doc's shell-injection / quoting
 * posture (macf#848). `"`, `$`, backtick, `\` are deliberately NOT guarded
 * here anymore: they are inert under both this module's single-quoted output
 * and `vault.sh`'s no-eval parse.
 */
const SHELL_UNSAFE_VALUE_RE = /['\r\n]/;

function toBase64(raw: string): string {
  return Buffer.from(raw, 'utf-8').toString('base64');
}

/**
 * The emitted `KEY` itself must be a valid shell identifier — `vault.sh`
 * `export`s it as an assignment target (macf#848: no longer via `eval`, but
 * `export KEY=value` still requires `KEY` to be identifier-shaped or the
 * assignment fails). Defense-in-depth, not a fix for a reachable
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
      `"${key}" is not a valid shell variable name (^[A-Za-z_][A-Za-z0-9_]*$) — vault.sh \`export\`s the ` +
        'decrypted plaintext KEY by KEY, so every emitted KEY must be assignable.',
    );
  }
}

/** The RAW value must not carry the residual-dangerous byte (a literal `'`) or a CR/LF — see module doc. Never includes `value` in the thrown message (never log/print a secret). */
function assertShellSafeValue(key: string): (value: string) => void {
  return (value: string) => {
    if (value.length === 0) {
      throw new VaultError('vault_empty_value', `${key}: refusing to write an empty secret value into the vault.`);
    }
    if (SHELL_UNSAFE_VALUE_RE.test(value)) {
      throw new VaultError(
        'vault_unsafe_value',
        `${key}: value contains a single quote or a CR/LF. A literal ' cannot be represented inside vault.sh's ` +
          "single-quoted KEY='value' lines (there is no escape for ' inside '...'), and a line break would split " +
          'one KEY=VALUE entry across two physical lines. GitHub-issued client/webhook secrets have not been ' +
          'observed to contain these; if one legitimately does, base64-encode it upstream like the PEM fields.',
      );
    }
  };
}

function emitLine(lines: string[], key: string, value: string): void {
  assertValidShellIdentifier(key);
  assertShellSafeValue(key)(value);
  lines.push(`${key}='${value}'`);
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

  if (payload.runnerOps !== undefined) {
    // EXPORT-CLASS credential, ONE-WAY-RATCHET permission set (groundnuty/
    // macf#943 — see `apply-runner-ops.ts::RUNNER_OPS_PERMISSIONS`'s
    // doc for the full rationale). This key eventually leaves the fleet's
    // normal trust boundary entirely — handed to the runner platform, stored
    // in a cluster Secret, readable by more parties than an agent App's key
    // ever is. Kept under its OWN `MACF_RUNNER_OPS_*` prefix,
    // deliberately never folded into the `MACF_AGENT_*` block above — a
    // reader of vault.sh's exported names can tell at a glance this
    // credential is a different trust class from an agent's, and a future
    // change that widens this App's permissions must not be able to hide
    // behind the ordinary agent-credential emission path.
    assertNonEmptySegmentSource('runnerOps.appHandle', payload.runnerOps.appHandle);
    const rrSeg = toVariableSegment(payload.runnerOps.appHandle);
    emitLine(lines, `MACF_RUNNER_OPS_${rrSeg}_APP_ID`, payload.runnerOps.appId);
    emitLine(lines, `MACF_RUNNER_OPS_${rrSeg}_INSTALL_ID`, payload.runnerOps.installId);
    emitLine(lines, `MACF_RUNNER_OPS_${rrSeg}_CLIENT_ID`, payload.runnerOps.clientId);
    emitLine(lines, `MACF_RUNNER_OPS_${rrSeg}_CLIENT_SECRET`, payload.runnerOps.clientSecret);
    emitLine(lines, `MACF_RUNNER_OPS_${rrSeg}_WEBHOOK_SECRET`, payload.runnerOps.webhookSecret);
    emitLine(lines, `MACF_RUNNER_OPS_${rrSeg}_PRIVATE_KEY_B64`, toBase64(payload.runnerOps.pem));
  }

  if (payload.routingClient !== undefined) {
    if (payload.routing !== undefined) {
      // Defense-in-depth (groundnuty/macf#920) — both fields target the SAME
      // `ROUTING_CLIENT_*_B64` vault keys (see `VaultRoutingClientSecrets`'s
      // doc); nothing in this codebase populates BOTH today (`payload.routing`
      // is unused — the "shared macf-routing App" ceremony it models is
      // future scope), but a silent double-emit of the same key would have
      // `vault.sh`'s no-eval parse take whichever line landed LAST — never
      // ambiguous like that.
      throw new VaultError(
        'vault_conflicting_routing_client',
        'buildVaultPlaintext: both payload.routing and payload.routingClient were given — they write the same ' +
          'ROUTING_CLIENT_CERT_B64/ROUTING_CLIENT_KEY_B64 vault keys. Supply at most one.',
      );
    }
    emitLine(lines, 'ROUTING_CLIENT_CERT_B64', toBase64(payload.routingClient.clientCertPem));
    emitLine(lines, 'ROUTING_CLIENT_KEY_B64', toBase64(payload.routingClient.clientKeyPem));
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
 * Re-serialize an already-decrypted, already-merged raw `KEY -> value` map
 * back into vault plaintext — the write-side counterpart to
 * `vault-read.ts::parseVaultPlaintext` (macf#989: `composeAndWriteVault`
 * decrypts the CURRENT vault into a raw map, folds in this run's freshly
 * `buildVaultPlaintext`-built lines, and needs to turn the MERGED map back
 * into vault plaintext — `buildVaultPlaintext` itself only accepts a typed
 * {@link VaultPayload}, not a raw map, so it cannot serve this role).
 *
 * Reuses the SAME per-line guards {@link emitLine} already applies
 * (shell-identifier KEY, shell-safe VALUE) — belt-and-suspenders, not
 * redundant-in-principle: every value here was already validated once
 * (either by the ORIGINAL `buildVaultPlaintext` call that first wrote it,
 * or by THIS run's own call for the new entries), but re-validating on the
 * way back out means a hand-edited or format-drifted vault can never
 * silently carry an unsafe value forward through a compose — it fails loud
 * here instead.
 *
 * Keys are emitted in SORTED order — deterministic output regardless of
 * `Object.entries` iteration order or which of the two source maps
 * (existing vs new) a key came from, so two composes of the same logical
 * merged map always produce byte-identical plaintext (useful for tests
 * asserting exact output).
 */
export function serializeVaultRawMap(raw: Readonly<Record<string, string>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
    emitLine(lines, key, value);
  }
  if (lines.length === 0) {
    throw new VaultError('vault_empty_payload', 'serializeVaultRawMap: empty map — nothing to write.');
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

/**
 * Sibling of {@link vaultAgentSecretsForFingerprint} for the runner-ops
 * App (groundnuty/macf#943) — same three fingerprinted fields, feeding
 * `fleet.lock`'s `agents[role='runner-ops']` entry (the LOCK entry
 * stays in the generic `agents[]` array — only the VAULT payload uses a
 * separate namespace; see `VaultRunnerOpsSecrets`'s doc for why those
 * two decisions are independent).
 */
export function vaultRunnerOpsSecretsForFingerprint(rr: VaultRunnerOpsSecrets): Record<string, string> {
  return {
    client_secret: rr.clientSecret,
    webhook_secret: rr.webhookSecret,
    app_private_key: rr.pem,
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
  if (payload.routingClient !== undefined) {
    // Same fingerprint field names `payload.routing` would have used (see
    // `buildVaultPlaintext`'s guard — the two are mutually exclusive per
    // call, never both populated).
    out.routing_client_cert = payload.routingClient.clientCertPem;
    out.routing_client_key = payload.routingClient.clientKeyPem;
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
 * **Best-effort cleanup on every failure path (macf#847 review nit 1):** `age`
 * opens `outPath` via `-o` before it has consumed all of STDIN, so a failure
 * partway through (non-zero exit, a killed-on-timeout process, or the process
 * dying under SIGKILL) can leave a TRUNCATED, corrupt file at `outPath`. The
 * NEXT `writeVault` call's clobber guard (`WriteVaultOptions.allowVersion`
 * default-off) then sees `exists(outPath) === true` and refuses to
 * overwrite — trapping the operator into a `rm` of a file that was never a
 * real vault. `unlinkOutPath` runs on every reject path below so a failed
 * apply stays re-runnable without manual cleanup. Best-effort: the unlink
 * itself is wrapped so a SECOND failure (e.g. permission denied, or the file
 * was never created at all — `ENOENT`) never masks the ORIGINAL error this
 * function is already rejecting with.
 *
 * Thin I/O leaf — not unit-tested against a fake process (same posture as
 * `identity-confirm.ts`'s `confirmAppInstallation`); exercised for real
 * against the actual `age` binary where available (`vault-write.test.ts`,
 * skipped when `age` is not on PATH).
 *
 * `timeoutMs` defaults to {@link AGE_ENCRYPT_TIMEOUT_MS} (the production
 * budget); tests pass a short override to reproduce a genuine kill-mid-write
 * truncation (verified empirically: `age` opens `-o outPath` before it has
 * drained a large STDIN, so a SIGKILL partway through leaves real bytes on
 * disk) without waiting out the full 30s production timeout.
 */
export function ageEncryptToFile(
  plaintext: string,
  recipients: readonly string[],
  outPath: string,
  timeoutMs: number = AGE_ENCRYPT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];
    for (const r of recipients) args.push('-r', r);
    args.push('-o', outPath);

    const child = spawn('age', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;

    /** Best-effort — see the function doc. Never throws, never touched on the success path. */
    const unlinkOutPath = (): void => {
      try {
        unlinkSync(outPath);
      } catch {
        /* nothing to clean up (ENOENT), or cleanup itself failed — either way, don't mask the real error */
      }
    };

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        unlinkOutPath();
        reject(new VaultError('vault_encrypt_timeout', `age did not exit within ${String(timeoutMs)}ms.`));
      });
    }, timeoutMs);

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
        unlinkOutPath();
        reject(new VaultError('vault_encrypt_spawn_failed', `Failed to spawn "age" — is it on PATH? (${err.message})`));
      });
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve();
        } else {
          unlinkOutPath();
          reject(new VaultError('vault_encrypt_failed', `age exited ${String(code)}: ${stderr.trim()}`));
        }
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

// --- Per-agent recovery artifact (§D5 "durable before gate 2") ---

/**
 * The real, operator-scoped recovery-artifact ROOT directory (macf#988,
 * DR-043 Amendment B) — `~/.config/macf/recovery`, honoring `$XDG_CONFIG_HOME`
 * when set (the XDG base-directory spec's own override for `~/.config`).
 *
 * `MACF_RECOVERY_DIR` is an explicit escape hatch — same `MACF_*`-override
 * family as `MACF_BOOTSTRAP_VAULT_VERSION` / `MACF_OTEL_ENDPOINT`. Its real
 * purpose is TEST SAFETY: `apply-fleet.ts::FleetApplyDeps.recoveryRootDir`
 * is the preferred per-run injection seam (a test passes a tmpdir there
 * directly), but honoring the env var HERE too means a test literal that
 * forgets to set that field still cannot reach the real operator's home
 * directory, as long as the suite sets this env var once, centrally
 * (belt-and-suspenders — see `apply-fleet.test.ts`'s top-of-file setup).
 */
export function defaultOperatorRecoveryRootDir(): string {
  const override = process.env['MACF_RECOVERY_DIR'];
  if (override !== undefined && override.length > 0) return override;
  const xdgConfigHome = process.env['XDG_CONFIG_HOME'];
  const configHome = xdgConfigHome !== undefined && xdgConfigHome.length > 0 ? xdgConfigHome : join(homedir(), '.config');
  return join(configHome, 'macf', 'recovery');
}

/**
 * `<recoveryRootDir>/<fleet>/<role>.age` — the durable per-agent recovery-
 * artifact path (macf#988, DR-043 Amendment B's consume side). Pure
 * path-join; `recoveryRootDir` is always an explicit argument, resolved
 * ONCE by the caller (via {@link defaultOperatorRecoveryRootDir}, or a test
 * override) — this function never reads `homedir()`/env itself, the same DI
 * shape every other path-deriving function in this module already takes.
 * `fleetName` (`fleet-manifest.ts`'s `FLEET_NAME_RE`) and `role`
 * (`ROLE_CHARSET_RE`) are BOTH schema-restricted to `[a-z0-9-]` — neither
 * can ever contain a path-traversal segment (`..`, `/`), which matters more
 * now that this path lands under the operator's own `$HOME` rather than an
 * ephemeral checkout. Exported so `apply-fleet.ts` can compute the SAME
 * path on the write side (`apply-agent.ts`'s
 * `AgentApplyDeps.writeRecoveryArtifact` callback), the consume side
 * (`AgentApplyDeps.findRecoveryArtifact`, via `vault-read.ts`'s
 * `readRecoveryArtifact`), and the delete side (after a successful final
 * vault compose) without any of the three ever drifting apart.
 *
 * **Replaces the PRE-#988 location** this function used to derive
 * (`<secretsDir>/recovery/<role>.age`, inside the per-run `mkdtemp`
 * control-repo checkout — purged with the process, defeating Amendment B's
 * own "durable before gate 2" promise; see the module doc's "Location,
 * corrected" paragraph for the full incident).
 */
export function operatorRecoveryArtifactPath(recoveryRootDir: string, fleetName: string, role: string): string {
  return join(recoveryRootDir, fleetName, `${role}.age`);
}

/**
 * Assemble the recovery-artifact PLAINTEXT for one agent's just-exchanged
 * credentials. Deliberately a NARROWER shape than {@link VaultAgentSecrets}:
 * `installId` isn't knowable yet at the point this fires — it's the product
 * of gate 2, which hasn't run yet (see `apply-agent.ts`'s "gate 1→2 window"
 * doc). Reuses `buildVaultPlaintext`'s own safety primitives (`emitLine` —
 * shell-identifier + shell-metacharacter guards) so a recovery artifact is
 * exactly as safe to eventually fold into `vault.sh`'s `eval` sourcing as
 * the real vault is, even though nothing in this codebase does that folding
 * automatically yet (operator recovery is manual — see `apply-fleet.ts`'s
 * module doc).
 */
function buildRecoveryArtifactPlaintext(role: string, creds: AppCredentials): string {
  assertNonEmptySegmentSource('role', role);
  const seg = toVariableSegment(role);
  const lines: string[] = [];
  emitLine(lines, `MACF_RECOVERY_${seg}_APP_ID`, creds.appId);
  emitLine(lines, `MACF_RECOVERY_${seg}_APP_NAME`, creds.name);
  emitLine(lines, `MACF_RECOVERY_${seg}_APP_SLUG`, creds.slug);
  emitLine(lines, `MACF_RECOVERY_${seg}_CLIENT_ID`, creds.clientId);
  emitLine(lines, `MACF_RECOVERY_${seg}_CLIENT_SECRET`, creds.clientSecret);
  emitLine(lines, `MACF_RECOVERY_${seg}_WEBHOOK_SECRET`, creds.webhookSecret);
  emitLine(lines, `MACF_RECOVERY_${seg}_PRIVATE_KEY_B64`, toBase64(creds.pem));
  return `${lines.join('\n')}\n`;
}

/** Injectable seam for {@link writeAgentRecoveryArtifact}'s atomic-write tail (mirrors `vault-read.ts::ReencryptVaultDeps`'s identical shape). Production takes the real `fs` primitives; tests inject fakes for deterministic temp-file names / failure injection. */
export interface WriteRecoveryArtifactDeps {
  readonly rename?: (from: string, to: string) => void;
  readonly chmod?: (path: string, mode: number) => void;
  readonly unlink?: (path: string) => void;
  /** Injectable randomness for a deterministic temp-file name in tests. Defaults to `crypto.randomBytes(6).toString('hex')`. */
  readonly tmpSuffix?: () => string;
}

/**
 * Encrypt one agent's just-exchanged credentials to their own recovery-
 * artifact path — UNCONDITIONALLY (no `writeVault`-style exists/clobber
 * check: this file is write-only insurance on ITS OWN path, never the
 * store of record, so a stale leftover from an earlier interrupted run is
 * simply superseded). `mkdirSync(..., { recursive: true, mode: 0o700 })`
 * because the per-fleet recovery directory is new territory every time a
 * fleet is first provisioned, and this write is the one that MUST NOT fail
 * on a missing directory (that would defeat the entire "durable before
 * gate 2" invariant this function exists for).
 *
 * **Atomic + 0600 (macf#988 hard constraint — this artifact now lives under
 * the operator's own `$HOME`, not a throwaway checkout, so both properties
 * matter far more than they did at the old location):** encrypts to a
 * `.tmp-<random>` sibling in the SAME directory (so the final `rename` is
 * atomic on one filesystem — mirrors `vault-read.ts::reencryptVault`'s
 * identical crash-safety shape), `chmod`s it `0600` BEFORE the rename (so
 * the credential is never briefly world-readable at its final name), then
 * renames it into place. A failure at ANY step (encrypt, chmod, rename)
 * best-effort-unlinks the temp file and re-throws/rejects — never leaves a
 * partial temp artifact behind, and never leaves a wrongly-permissioned
 * file at `outPath` (either the atomic rename lands the fully-chmod'd file,
 * or `outPath` is untouched).
 *
 * `encrypt` defaults to the real `age` binary; tests inject a fake (same
 * seam `writeVault` uses) so no real `age`/keys are needed.
 */
export async function writeAgentRecoveryArtifact(
  role: string,
  creds: AppCredentials,
  recipients: readonly string[],
  outPath: string,
  encrypt: VaultEncryptFn = ageEncryptToFile,
  deps: WriteRecoveryArtifactDeps = {},
): Promise<void> {
  if (recipients.length === 0) {
    throw new VaultError(
      'vault_no_age_recipient',
      'writeAgentRecoveryArtifact: transport.age_recipients is empty — this agent\'s just-issued ' +
        'credential CANNOT be made durable (DR-043 §D5). Mint an age recipient and add it to transport.age_recipients ' +
        'in fleet.yaml before re-running apply.',
    );
  }
  const plaintext = buildRecoveryArtifactPlaintext(role, creds);
  const dir = dirname(outPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const rename = deps.rename ?? renameSync;
  const chmod = deps.chmod ?? chmodSync;
  const unlink =
    deps.unlink ??
    ((p: string): void => {
      try {
        unlinkSync(p);
      } catch {
        /* best-effort — ENOENT (never created) or a permission issue; either way, nothing left to clean up here */
      }
    });
  const suffix = deps.tmpSuffix?.() ?? randomBytes(6).toString('hex');
  const tmpPath = join(dir, `.${basename(outPath)}.tmp-${suffix}`);

  try {
    await encrypt(plaintext, recipients, tmpPath);
  } catch (err) {
    unlink(tmpPath);
    throw err;
  }
  try {
    chmod(tmpPath, 0o600);
    rename(tmpPath, outPath);
  } catch (err) {
    unlink(tmpPath);
    throw new VaultError(
      'vault_recovery_artifact_rename_failed',
      `recovery artifact encrypted to a temp file but could not be made 0600 + renamed into place at "${outPath}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Best-effort delete of a per-agent recovery artifact once its credential
 * is durably recorded in the FINAL `vault.age` — mirrors
 * {@link ageEncryptToFile}'s own best-effort-cleanup posture (never let a
 * SECOND failure, e.g. `ENOENT` because the artifact was already gone, mask
 * the caller's real success path). Never throws.
 */
export function removeAgentRecoveryArtifact(outPath: string): void {
  try {
    unlinkSync(outPath);
  } catch {
    /* best-effort — ENOENT (already gone) or a permission issue; either way, nothing left to clean up here */
  }
}
