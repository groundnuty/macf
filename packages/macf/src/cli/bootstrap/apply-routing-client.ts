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
 * doc), and a narrower reuse story (a routing-client cert minted in a PRIOR
 * run can never be re-published to a repo THIS run adds, because its private
 * key was never durable anywhere `apply` can read back from — DR-043
 * Amendment C: apply never decrypt-reads the vault in this increment).
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
 * `apply-fleet.ts` already uses for `lockHasCaKey`), skips with an explicit,
 * honest reason — never fabricated, never silently absent (Amendment A4).
 */
import { spawn } from 'node:child_process';
import type { Presence } from './plan.js';
import type { EnsureVariableDeps, EnsureVariableOutcome } from './ensure-variable.js';
import { ensureVariableCreated, skippedOutcomesFor } from './ensure-variable.js';
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
 * @param lockHasRoutingClientKey `fleet.lock.fingerprints.routing_client_key
 *   !== undefined` — a PRIOR successful apply already vaulted a routing-client
 *   key for this fleet. Mirrors `apply-fleet.ts`'s own `lockHasCaKey`.
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
        'routing_client_key fingerprint) — its private key is not in process memory this run (DR-043 Amendment ' +
        'C: apply does not decrypt-read the vault in this increment), so it cannot be re-derived to publish to any ' +
        'repo this run might add. Re-mint manually via `macf certs issue-routing-client` + `gh secret set` if a ' +
        'new agent repo needs it, or extend a future vault-aware apply increment.',
    };
  }
  if (!caMintedThisRun || caCertPem === undefined || caKeyPem === undefined) {
    return {
      status: 'skipped',
      reason:
        'no routing-client cert has been minted for this fleet yet, but this run\'s CA was not freshly minted ' +
        '(either it was REUSED — its private key is not in process memory, DR-043 Amendment D phase 3+ scope — or ' +
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

// --- Publish (create-only, per-repo GitHub Actions secrets) ---

export interface RoutingClientPublishDeps {
  readonly checkRepoSecretPresence: (repo: string, name: string) => Promise<Presence>;
  readonly setRepoSecret: (repo: string, name: string, value: string) => Promise<void>;
}

export interface RoutingClientPublishResult {
  readonly certLegs: Readonly<Record<string, EnsureVariableOutcome>>;
  readonly keyLegs: Readonly<Record<string, EnsureVariableOutcome>>;
}

/**
 * Create-only per-repo deploy of an ALREADY-MINTED routing-client cert/key
 * pair. Reuses `ensure-variable.ts::ensureVariableCreated` verbatim — its
 * `EnsureVariableDeps` shape (`checkPresence` + `create` returning
 * `'created'|'exists'`) is generic enough for a secret leg too: `create`
 * here NEVER returns `'exists'` (secrets have no distinguishable "the API
 * itself reported a duplicate" response the way a variable's 409 does — see
 * `observer.ts::checkRepoSecretPresence`'s doc), which is fine — `ensureVariableCreated`
 * only inspects that branch when `checkPresence` returned `'unknown'`, and
 * the un-atomicity between the presence check and the write is the SAME
 * accepted, documented gap `apply-ca.ts`/`ensure-variable.ts` already
 * carry for an operator-driven, non-concurrent bootstrap tool.
 *
 * `keyPem` is SECRET — this function never logs it, never includes it in a
 * thrown message (a `setRepoSecret` failure's error text comes from `gh`'s
 * OWN stderr, which never echoes stdin-piped input — see
 * `realSetRepoSecret`'s doc), and never returns it in `RoutingClientPublishResult`
 * (which carries only `EnsureVariableOutcome`s — status/reason strings, no
 * value field exists to leak into).
 */
export async function publishRoutingClientSecrets(
  secrets: { readonly certPem: string; readonly keyPem: string },
  repos: readonly string[],
  deps: RoutingClientPublishDeps,
): Promise<RoutingClientPublishResult> {
  const certLegs: Record<string, EnsureVariableOutcome> = {};
  const keyLegs: Record<string, EnsureVariableOutcome> = {};
  for (const repo of repos) {
    const certDeps: EnsureVariableDeps = {
      checkPresence: () => deps.checkRepoSecretPresence(repo, ROUTING_CLIENT_CERT_SECRET_NAME),
      create: async () => {
        await deps.setRepoSecret(repo, ROUTING_CLIENT_CERT_SECRET_NAME, secrets.certPem);
        return 'created';
      },
    };
    certLegs[repo] = await ensureVariableCreated(certDeps, `routing-client secret "${ROUTING_CLIENT_CERT_SECRET_NAME}" on "${repo}"`);

    const keyDeps: EnsureVariableDeps = {
      checkPresence: () => deps.checkRepoSecretPresence(repo, ROUTING_CLIENT_KEY_SECRET_NAME),
      create: async () => {
        await deps.setRepoSecret(repo, ROUTING_CLIENT_KEY_SECRET_NAME, secrets.keyPem);
        return 'created';
      },
    };
    keyLegs[repo] = await ensureVariableCreated(keyDeps, `routing-client secret "${ROUTING_CLIENT_KEY_SECRET_NAME}" on "${repo}"`);
  }
  return { certLegs, keyLegs };
}

/** The `RoutingClientPublishResult` shape for "never attempted this run" (mint skipped, or a fresh mint's vault write did not succeed) — mirrors `apply-ca.ts::skippedCaPublish`. Pure. */
export function skippedRoutingClientPublish(repos: readonly string[], reason: string): RoutingClientPublishResult {
  return { certLegs: skippedOutcomesFor(repos, reason), keyLegs: skippedOutcomesFor(repos, reason) };
}

// --- Combined deps (what `apply-fleet.ts` actually wires) ---

export interface RoutingClientApplyDeps extends RoutingClientMintDeps, RoutingClientPublishDeps {}

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
