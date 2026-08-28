/**
 * The routing-client mTLS identity ceremony — DR-043 §D5 "routing-client
 * re-mint" (groundnuty/macf#920, the second of the two gaps that issue
 * closes: "a freshly provisioned fleet cannot receive work"). Structurally
 * mirrors `apply-ca.ts`'s split between MINT (needs the CA private key, which
 * only ever lives in process memory on the SAME run that just minted the CA
 * — see `mintRoutingClient`'s doc) and PUBLISH (a create-only write, gated on
 * the vault write having durably captured the key FIRST — DR-043 §D5
 * "durable before deploy," the same ordering discipline `apply-ca.ts`'s
 * `certToPublish` gate already applies to a freshly-minted CA cert).
 *
 * **Why this is a SEPARATE module from `apply-ca.ts`, not a case added to
 * it.** The CA writes a GitHub Actions VARIABLE (public, readable back,
 * two-place: registry + repo). The routing client writes a GitHub Actions
 * SECRET (private key material, write-only, no registry leg, no readable-back
 * "reuse" path) — different API surface (`/actions/secrets/*`, sealed via
 * `gh secret set`'s own libsodium handling rather than this codebase's `gh
 * api --method POST` variable primitive), different create-only mechanics
 * (no 409-on-duplicate to lean on — see {@link checkRepoSecretPresence in observer.ts}'s
 * doc).
 *
 * **Mint gating (the fork the task brief's "reused CA" edge case forces):**
 * a routing-client cert can only be minted on a run where `apply-fleet.ts`'s
 * CA resolve is `'minted'` THIS run — the CA private key needed to SIGN the
 * client cert is only ever in process memory on that path (`resolveCaCert`'s
 * `'reused'` outcome carries the cert PEM only, never the key — vault-read
 * for a reused CA's key is DR-043 Amendment D phase 3+, deliberately not
 * built here). A fleet whose CA was minted in an EARLIER run, or whose
 * routing-client cert was ALREADY minted in a prior run (`fleet.lock`
 * recording a `routing_client_key` fingerprint — the SAME signal
 * `apply-fleet.ts` already uses for `lockHasCaKey`), skips MINTING with an
 * explicit, honest reason — never fabricated, never silently absent
 * (Amendment A4).
 *
 * **Minting is fleet-scoped; publishing is per-repo (groundnuty/macf#986).**
 * The paragraph this replaces used to end here: "...its private key was
 * never durable anywhere `apply` can read back from — DR-043 Amendment C:
 * apply never decrypt-reads the vault in this increment." That was true when
 * this module was first built (macf#920), but `vault-read.ts` (Amendment D
 * phase 3, macf#838) has since given `apply` exactly that read-back
 * capability, and `apply-ca.ts::resolveCaCert`'s `'restored'` outcome
 * (macf#978) already proves out the pattern for the CA cert. This module now
 * has the routing-client sibling: {@link resolveRoutingClientSecretsForPublish}
 * — called ONLY when {@link mintRoutingClient} itself did NOT mint this run
 * (i.e. `deps.mint` is never invoked on this path, see that function's own
 * "never re-mint" contract) — tries `deps.readVaultRoutingClient` (wired only
 * when the operator supplied BOTH `--vault`/`--identity-key`, mirroring
 * `CaMintDeps.readVaultCaCert`'s opt-in contract) to recover the ALREADY-
 * minted cert/key pair from the vault so the publish step (below) can
 * create-only-deploy it to a repo the fleet gained AFTER the original
 * mint — the exact "add a second agent" reproduction #986 reports. The bug
 * this fixes: the OLD code folded "no fresh key in process memory this run"
 * into "skip publishing to EVERY repo, including ones this run just
 * confirmed" — treating "already minted" as "already published everywhere,"
 * which are different facts.
 *
 * **The PUBLISH half moved to `apply-routing-secrets.ts` (groundnuty/
 * macf#1074).** This module used to also own `publishRoutingClientSecrets`
 * — a per-repo idempotent create-only loop for JUST
 * `ROUTING_CLIENT_CERT`/`ROUTING_CLIENT_KEY`, two of the six secrets
 * `agent-router.yml` actually requires (groundnuty/macf#1074: "the fleet
 * routes" needed all six through ONE publisher, never two). That function
 * is RETIRED; `resolveRoutingClientSecretsForPublish`'s result
 * (`RoutingClientSecretsForPublish`) now feeds one of the six
 * `RoutingSecretResolution` entries `apply-fleet.ts` assembles for
 * `apply-routing-secrets.ts::publishRoutingSecrets` — same per-repo
 * idempotent-loop contract (repos already holding a secret report
 * `'already-present'`; repos missing one whose resolution is
 * `'unavailable'` report a loud `'failed'`), just emitting all six names
 * instead of two. See that module's doc for the full publish contract —
 * including a live base64-encoding bug this move fixed.
 */
import { spawn } from 'node:child_process';
import { mintRoutingClientCert } from '../commands/certs.js';

/** `ROUTING_CLIENT_CERT` / `ROUTING_CLIENT_KEY` — the GitHub Actions secret names `certs.ts::issueRoutingClient` already documents pasting into a consumer repo's secrets (macf#800's blast-radius warning). Reused verbatim so the interactive-CLI and `apply`-driven paths deploy under the identical names. */
export const ROUTING_CLIENT_CERT_SECRET_NAME = 'ROUTING_CLIENT_CERT';
export const ROUTING_CLIENT_KEY_SECRET_NAME = 'ROUTING_CLIENT_KEY';

// --- Mint ---

export interface RoutingClientMintDeps {
  /** Injectable so tests never invoke real X.509 crypto — defaults to `mintRoutingClientCert` (`commands/certs.ts`, the SAME primitive `macf certs issue-routing-client` uses — task requirement: reuse, never a second issuer). */
  readonly mint: (caCertPem: string, caKeyPem: string) => Promise<{ readonly certPem: string; readonly keyPem: string }>;
}

export type RoutingClientMintOutcome =
  | { readonly status: 'minted'; readonly certPem: string; readonly keyPem: string }
  | { readonly status: 'skipped'; readonly reason: string }
  // groundnuty/macf#954 — a THIRD, distinct outcome from the two benign
  // 'skipped' causes above (already-vaulted from a prior run; CA reused, not
  // minted this run — both EXPECTED steady states, never operator-attention).
  // A `deps.mint` REJECTION (crypto/tmpdir/disk exception) used to collapse
  // into the SAME 'skipped' status+reason-string shape as those two benign
  // causes — `applyExitCode` (`commands/bootstrap-apply.ts`) treats every
  // 'skipped' mint as "nothing to action" and never fails the run on it, so a
  // transient mint exception on a FRESH fleet (the exact next live run after
  // a freshly-minted CA) made `apply` exit 0 while no routing-client cert
  // ever reached any repo — the credential every agent's channel-server needs
  // for the mTLS mesh. `'failed'` is the discriminated status for a genuine
  // exception; callers (this module's `apply-fleet.ts` caller, and
  // `applyExitCode`) must treat it the same operator-attention way `caBad`
  // already treats a CA resolve failure — never folded back into 'skipped'.
  | { readonly status: 'failed'; readonly reason: string };

/**
 * Decide mint-vs-skip-vs-fail — see the module doc's "mint gating" section
 * for the full decision table. NEVER throws — but a `deps.mint` REJECTION
 * (crypto/tmpdir/disk exception) resolves to the DISTINCT `status: 'failed'`
 * (groundnuty/macf#954), never folded into the two benign `'skipped'` causes
 * below (already-vaulted from a prior run; CA reused not minted this run) —
 * those two are the EXPECTED steady state on an ordinary re-run and must
 * never fail `apply`'s exit code; a genuine mint exception is an
 * operator-attention state and MUST (via `applyExitCode`).
 *
 * @param lockHasRoutingClientKey `effectiveFleetFingerprints(fleet.lock)?.routing_client_key
 *   !== undefined` (groundnuty/macf#1310 — reads `fleet_fingerprints`,
 *   falling back to the deprecated `fingerprints` key for a pre-rename
 *   lock) — a PRIOR successful apply already vaulted a routing-client key
 *   for this fleet. Mirrors `apply-fleet.ts`'s own `lockHasCaKey`.
 * @param caMintedThisRun Whether `apply-fleet.ts`'s CA resolve was
 *   `'minted'` THIS run (the only path with a CA private key in memory to
 *   sign the client cert with).
 */
export async function mintRoutingClient(
  caCertPem: string | undefined,
  caKeyPem: string | undefined,
  lockHasRoutingClientKey: boolean,
  caMintedThisRun: boolean,
  deps: RoutingClientMintDeps,
): Promise<RoutingClientMintOutcome> {
  if (lockHasRoutingClientKey) {
    return {
      status: 'skipped',
      reason:
        'a routing-client cert was already minted for this fleet in a PRIOR apply run (fleet.lock records a ' +
        'routing_client_key fingerprint) — its private key is not in process memory this run. Never re-minted ' +
        '(minting is fleet-scoped, so this is the expected steady state, not a problem) — ' +
        'publishing the already-minted cert/key to any repo this run confirms is handled SEPARATELY by ' +
        '`resolveRoutingClientSecretsForPublish`, which reads it back from the vault when `--vault`/`--identity-key` ' +
        'were both supplied.',
    };
  }
  if (!caMintedThisRun || caCertPem === undefined || caKeyPem === undefined) {
    return {
      status: 'skipped',
      reason:
        'no routing-client cert has been minted for this fleet yet, but this run\'s CA was not freshly minted ' +
        '(either it was REUSED — its private key is not in process memory — or ' +
        'CA resolution failed) — minting a routing-client cert requires the CA private key to sign it. Run apply ' +
        'once against a brand-new fleet (fresh CA + fresh routing-client mint together), or extend a future ' +
        'vault-aware apply increment.',
    };
  }
  try {
    const { certPem, keyPem } = await deps.mint(caCertPem, caKeyPem);
    return { status: 'minted', certPem, keyPem };
  } catch (err) {
    // groundnuty/macf#954 — DISTINCT from the two benign 'skipped' returns
    // above: this is a genuine mint exception (crypto/tmpdir/disk), not an
    // expected steady state. `'failed'`, never `'skipped'` — see this
    // function's + the type's doc.
    return { status: 'failed', reason: `routing-client cert mint failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// --- Vault-restore (publish-time secrets resolution, groundnuty/macf#986) ---

/**
 * The already-resolved cert/key PAIR a publish attempt needs — sourced
 * EITHER from a fresh {@link mintRoutingClient} `'minted'` result (in
 * process memory this run) OR from {@link resolveRoutingClientSecretsForPublish}'s
 * vault-restore (read back from a PRIOR run's mint). `'unavailable'` is a
 * genuine, honest gap (DR-043 Amendment A4) — never fabricated material —
 * and is NOT the same as "nothing to do": {@link publishRoutingClientSecrets}
 * still runs its per-repo presence check when `'unavailable'`, so a repo
 * that already has the secret still reports `'already-present'`; only a repo
 * actually MISSING it turns the gap into a loud per-leg `'failed'` (see that
 * function's doc).
 */
export type RoutingClientSecretsForPublish =
  | { readonly status: 'available'; readonly certPem: string; readonly keyPem: string }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface RoutingClientVaultRestoreDeps {
  /**
   * groundnuty/macf#986 — the vault-restore fallback for a routing-client
   * cert/key that was minted in a PRIOR run (`fleet.lock` records a
   * `routing_client_key` fingerprint) and therefore is NOT in process memory
   * this run. Mirrors `apply-ca.ts::CaMintDeps.readVaultCaCert`'s contract
   * exactly: `undefined` (the field omitted entirely — the default for every
   * existing caller/test) means "vault-aware routing-client restore is NOT
   * engaged this run," the byte-identical pre-#986 behaviour. Wired only by
   * `commands/bootstrap-apply.ts::resolveMutateDeps`, and only when the
   * operator supplied BOTH `--vault`/`--identity-key`.
   *
   * Unlike `readVaultCaCert` (cert PEM only — the CA's public material),
   * this returns BOTH `certPem` AND `keyPem`: the routing-client secret is a
   * GitHub Actions SECRET (write-only, no registry leg to reuse), so the
   * only way to (re-)publish it to a repo is to hold the actual key bytes,
   * never just a public fingerprint.
   *
   * **Contract: NEVER throws.** Any decrypt/parse failure (missing vault,
   * wrong identity, malformed plaintext, field absent) MUST resolve to
   * `undefined` — the same honest-unknown-over-false-present floor
   * `readVaultCaCert`'s own doc establishes.
   * {@link resolveRoutingClientSecretsForPublish} ALSO wraps this call in
   * its own try/catch as defense-in-depth, but a caller SHOULD NOT rely on
   * that as the primary safety net.
   *
   * **Contract: never logs.** Any diagnostic about WHY the read failed is
   * the wiring caller's responsibility (see `resolveMutateDeps`'s own
   * implementation) — this function returns only the PEMs or `undefined`,
   * never a side-channel.
   */
  readonly readVaultRoutingClient?: () => Promise<{ readonly certPem: string; readonly keyPem: string } | undefined>;
}

/**
 * Resolve what secrets (if any) a publish attempt has to work with, for the
 * case {@link mintRoutingClient} did NOT mint this run (`mint.status` is
 * `'skipped'` or `'failed'`) — a `'minted'` result is handled directly by
 * the caller (`apply-fleet.ts`), never routed through here (see this
 * function's own callers).
 *
 * **Never calls `deps.mint` (the crypto mint seam) — that is the whole
 * point.** This function only ever reads `deps.readVaultRoutingClient`, an
 * entirely separate dependency from {@link RoutingClientMintDeps.mint}; a
 * caller wiring vault-restore can verifiably never trigger a re-mint through
 * this path (groundnuty/macf#986's hard constraint).
 *
 * Vault-restore is attempted ONLY when `lockHasRoutingClientKey` is true
 * (there is something in the vault worth trying to read back — mirrors
 * `apply-ca.ts::resolveCaCert`'s own `lockHasCaKey`-gated vault-restore
 * attempt) AND `deps.readVaultRoutingClient` is wired (both `--vault`/
 * `--identity-key` were supplied). When `lockHasRoutingClientKey` is false,
 * NOTHING has ever been minted for this fleet — there is nothing in the
 * vault to restore either, so this degrades straight to `'unavailable'`
 * with `mint.reason` unchanged, byte-identical to pre-#986 behaviour for
 * that case.
 */
export async function resolveRoutingClientSecretsForPublish(
  mint: Extract<RoutingClientMintOutcome, { status: 'skipped' | 'failed' }>,
  lockHasRoutingClientKey: boolean,
  deps: RoutingClientVaultRestoreDeps,
): Promise<RoutingClientSecretsForPublish> {
  if (lockHasRoutingClientKey && deps.readVaultRoutingClient !== undefined) {
    let restored: { readonly certPem: string; readonly keyPem: string } | undefined;
    try {
      restored = await deps.readVaultRoutingClient();
    } catch {
      // Contract violation by the caller (readVaultRoutingClient must never
      // throw) — defense-in-depth only; degrade exactly like "vault had
      // nothing for this fleet" and fall through to the reason below.
      restored = undefined;
    }
    if (restored !== undefined) {
      return { status: 'available', certPem: restored.certPem, keyPem: restored.keyPem };
    }
    // Wired, but the vault read failed OR the vault simply doesn't have the
    // fields (an inconsistent-but-real state: fleet.lock says minted, the
    // vault says otherwise) — distinct hint from the "not wired at all" case
    // below, since telling an operator who ALREADY supplied both flags to
    // "supply both flags" would be actively misleading.
    return {
      status: 'unavailable',
      reason:
        `${mint.reason} A vault-restore was attempted (--vault/--identity-key were both supplied) but did not ` +
        'yield a routing-client cert/key — check the vault actually holds ROUTING_CLIENT_CERT_B64/' +
        'ROUTING_CLIENT_KEY_B64 for this fleet, or re-mint manually via `macf certs issue-routing-client`.',
    };
  }
  const vaultHint =
    lockHasRoutingClientKey && deps.readVaultRoutingClient === undefined
      ? ' Supply both --vault and --identity-key to `macf bootstrap apply` so this fleet\'s already-minted ' +
        'routing-client cert/key can be read back from the vault and published to any repo that does not yet have it.'
      : '';
  return { status: 'unavailable', reason: `${mint.reason}${vaultHint}` };
}

// --- Publish: RETIRED (groundnuty/macf#1074) ---
//
// `publishRoutingClientSecrets`/`skippedRoutingClientPublish`/
// `RoutingClientPublishDeps`/`RoutingClientPublishResult` used to live here,
// publishing ONLY `ROUTING_CLIENT_CERT`/`ROUTING_CLIENT_KEY` — two of the
// six secrets `agent-router.yml` actually requires. #1074 folds ALL SIX
// into ONE publisher (`apply-routing-secrets.ts::publishRoutingSecrets`,
// the task's explicit "not a second publisher" constraint) and — in the
// same move — fixes a live encoding bug: this module's old publish function
// passed raw PEM text where the router job's `base64 -d` expects base64
// (see `apply-routing-secrets.ts`'s module doc for the full incident).
// `RoutingClientSecretsForPublish` (the type this module's MINT/RESOLVE
// half still produces, below) is now consumed by `apply-fleet.ts` to build
// ONE OF the six `RoutingSecretResolution` entries it passes to
// `publishRoutingSecrets` — the resolution logic here is UNCHANGED; only
// the emission moved.

// --- Combined deps (what `apply-fleet.ts` actually wires) ---

export interface RoutingClientApplyDeps extends RoutingClientMintDeps, RoutingClientVaultRestoreDeps {}

// --- Real deps ---

const SECRET_SET_TIMEOUT_MS = 30_000;

/**
 * Pure — the exact `gh` argv for a secret set. NEVER contains `value` — the
 * value is piped on STDIN by {@link realSetRepoSecret}, never as an argv
 * element, which is the structural half of the "the key never appears in a
 * log/error/thrown message" hard constraint (groundnuty/macf#920): an
 * argv-passed secret is visible to `ps`/process-listing for the life of the
 * child process AND would appear verbatim in any tool that logs argv; stdin
 * has neither exposure. Pinned as a literal argv array (mirrors
 * `variable-write.ts::buildCreateVariableArgs`'s "pin the wire shape with a
 * pure args builder" precedent) so this property is verifiable without
 * spawning a real `gh` process.
 */
export function buildSetSecretArgs(repo: string, name: string): readonly string[] {
  return ['secret', 'set', name, '--repo', repo];
}

/**
 * Real `gh secret set <name> --repo <repo>` — pipes `value` on STDIN, NEVER
 * as a `--body` argv flag (see {@link buildSetSecretArgs}'s doc). Mirrors
 * `vault-write.ts::ageEncryptToFile`'s spawn skeleton (the
 * `child.stdin?.on('error')` no-op handler + the `finish()` once-only guard
 * exist for the identical reason that function's doc explains — a failed
 * spawn otherwise throws an unhandled stream 'error' event separate from the
 * child's own close/error).
 */
export function realSetRepoSecret(repo: string, name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', [...buildSetSecretArgs(repo, name)], { stdio: ['pipe', 'ignore', 'pipe'] });
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
        reject(new Error(`gh secret set "${name}" on "${repo}" did not exit within ${String(SECRET_SET_TIMEOUT_MS)}ms.`));
      });
    }, SECRET_SET_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.stdin?.on('error', () => {
      /* surfaced via the child 'error'/'close' handlers below instead */
    });
    child.on('error', (err) => {
      finish(() => reject(new Error(`Failed to spawn "gh secret set ${name}" — is gh on PATH? (${err.message})`)));
    });
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(`gh secret set "${name}" on "${repo}" exited ${String(code)}: ${stderr.trim()}`));
      });
    });

    child.stdin?.write(value, 'utf-8');
    child.stdin?.end();
  });
}

/** Real `mint` dep — thin pass-through to `commands/certs.ts::mintRoutingClientCert` (task requirement: reuse `issueRoutingClient`'s own primitive, never a second issuer). */
export async function realMintRoutingClient(caCertPem: string, caKeyPem: string): Promise<{ readonly certPem: string; readonly keyPem: string }> {
  return mintRoutingClientCert(caCertPem, caKeyPem);
}
