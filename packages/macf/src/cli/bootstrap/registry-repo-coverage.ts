/**
 * Live post-gate-2 check: does THIS agent App's installation cover the
 * registry repo, when `registry.type === 'repo'` (groundnuty/macf#1012)?
 *
 * ## Why this exists
 *
 * `registry: { type: repo, owner, repo }` (#999's supported org-owned-fleet
 * shape) parses + provisions cleanly today with NO check that the repo is
 * actually reachable by every agent App's installation. #999's own live
 * fleet hit exactly this failure mode for `type: org` (a permission gap,
 * caught by `registry-scope-preflight.ts`'s pure manifest-only refusal);
 * `type: repo` has NO permission gap (DR-019's `actions_variables` is
 * repo-scoped and IS granted) — the equivalent failure mode here is purely
 * an INSTALLATION-SCOPE gap: an agent App installed with "Only select
 * repositories" that doesn't happen to include the registry repo. `apply`
 * would report success, the fleet would look provisioned, and the gap is
 * discovered only when an agent's OWN `GET /repos/{owner}/{registry-repo}/
 * actions/variables/{name}` 403s at runtime — the exact "green run, dead
 * fleet" shape DR-043 Amendment A exists to close. (The live
 * `macf-experiment` fleet, referenced in #1012's own issue body, was
 * provisioned into exactly this state and recovered only by a manual
 * operator installation edit — nothing had verified coverage.)
 *
 * ## Why this can only run POST gate 2, unlike #999's pre-gate-1 refusal
 *
 * `registry-scope-preflight.ts`'s `checkRegistryScopePreflight` is a PURE,
 * manifest-only check — it can run before ANY GitHub call because the fact
 * it asserts (no org-scoped permission in `MACF_REQUIRED_PERMISSIONS`) is
 * true independent of anything GitHub returns. THIS check asserts a LIVE
 * fact — "does App X's installation actually cover repo Y" — which does not
 * exist to be checked until the App exists AND is installed (consent gate 2
 * has resolved `confirmed`). There is no manifest-only proxy for it: an
 * operator's install-time repo selection is exactly the kind of live,
 * per-run state `identity-confirm.ts`'s module doc says cannot be known
 * before a JWT can be minted. `registry-scope-preflight.ts`'s
 * `checkRegistryRepoScopeNotice` (the pure, manifest-only SIBLING of this
 * check) states the REQUIREMENT ahead of time, at `plan` time; this module
 * VERIFIES it live, once there is something to verify.
 *
 * ## What is verified, and how (an App JWT, not an installation token)
 *
 * `GET /repos/{owner}/{repo}/installation` ("Get a repository installation
 * for the authenticated app") is authenticated with an App JWT — the SAME
 * credential shape `identity-confirm.ts::confirmAppInstallation` already
 * mints from `(appId, keyPath)` — and answers exactly the question this
 * check needs: is THIS App installed with access to THIS repo. Verified
 * against GitHub's REST reference, 2026-08 (`docs.github.com/en/rest/apps/
 * apps#get-a-repository-installation-for-the-authenticated-app`): "You must
 * use a JWT to access this endpoint," response codes 200 / 301 / 404.
 * `fetch` follows same-origin redirects by default, so a documented 301
 * resolves to a 200 or 404 before {@link mapRepoInstallationStatus} ever
 * sees it — the `else → 'unknown'` branch below is the honest-unknown floor
 * for whatever residual shape reaches it (a redirect `fetch` couldn't
 * follow, a future API change), not a dedicated 301 handler.
 *
 * This is deliberately NOT `GET /installation/repositories` (the paginated
 * list endpoint `apply-runner-ops.ts::validateRunnerOpsInstall`'s doc flags
 * as the still-unbuilt mechanism for verifying an EXACT repo set) — that
 * endpoint needs an INSTALLATION access token (a `ghs_`-shaped credential,
 * the same SHAPE as a fleet-agent's own runtime bot token, which this tool
 * has never minted for itself) plus pagination to check membership of one
 * specific repo. The single-repo JWT-authed lookup answers this check's
 * narrower question (is ONE named repo covered) in one call, with no
 * token-minting beyond what `apply` already does for consent-gate
 * confirmation.
 *
 * ## A 404 collapses two distinct causes — name both (waitForInstallTimeoutMessage's own lesson)
 *
 * `identity-confirm.ts`'s `waitForInstallTimeoutMessage` warns that "a
 * diagnostic that names the wrong cause is a small lie compounding with
 * every run." A 404 from this endpoint does NOT distinguish "the App is
 * installed but this repo isn't in its selected set" from "the repo itself
 * doesn't exist / was renamed" — GitHub returns the identical 404 for both.
 * The registry repo is, notably, NEVER `ensureAgentRepo`'d anywhere in
 * `apply-fleet.ts`'s per-agent loop (that only confirms each agent's OWN
 * home repo exists) — so "the registry repo doesn't exist" is a genuinely
 * reachable cause here, not a theoretical one. {@link registryRepoNotInstalledReason}
 * names BOTH branches and BOTH fixes in one message rather than asserting
 * only the installation-scope cause.
 *
 * ## Honest-unknown (DR-043 Amendment A)
 *
 * Mirrors `identity-confirm.ts::confirmAppInstallation`'s A4 floor exactly:
 * only a clean 200 or a clean 404 is DECISIVE. A JWT-mint failure, a
 * network error, a timeout, or any OTHER HTTP status (401 wrong key
 * pairing, 403, 5xx, a malformed body) means GitHub was never successfully
 * asked this specific question — `'unknown'`, never `'absent'`. Falsely
 * reporting `'absent'` on a read failure would refuse a run that might
 * actually be fine; falsely reporting `'present'` on a read failure would
 * silently reproduce #999's exact failure mode for repo scope. `'unknown'`
 * is the only floor that can't be wrong in either direction — the caller
 * (`buildRegistryRepoValidateInstall`) never blocks on it, only warns.
 *
 * ## Coverage scope — verified on create/resume-install AND reuse-confirmed
 *
 * `apply-agent.ts`'s `AgentApplyDeps.validateInstall` hook (the seam this
 * module's {@link buildRegistryRepoValidateInstall} plugs into) is invoked
 * on EVERY path that resolves a `ConfirmedInstall` — the CREATE path, the
 * `resume-install` path (both via `runGate2`), AND the `reuse-confirmed`
 * path (an already-provisioned role, re-confirmed live on a re-run — see
 * `apply-agent.ts`'s `confirmBeforeCreateGuard` / `applyIdentity` for the
 * `keyPath` threading that makes this possible, groundnuty/macf#1012). This
 * matters concretely: the live `macf-experiment` fleet #1012 cites was
 * ALREADY fully provisioned (every role `reused`) when its registry gap was
 * discovered — a guard that only fired on first-create would have been
 * silent on the exact re-run shape that incident was.
 *
 * ## The gap THAT coverage scope leaves open (groundnuty/macf#1016)
 *
 * `resume-install`/`reuse-confirmed` both require `confirmBeforeCreateGuard`
 * to hold a decryptable `keyPath` — i.e. `AgentApplyDeps.resolveKeyPath` was
 * wired for this run (`apply-agent.ts`'s own doc on that field: `undefined`
 * is "the production default … always"). `resolveKeyPath` is wired ONLY
 * when `apply` was invoked WITH BOTH `--vault`/`--identity-key`
 * (`commands/bootstrap-apply.ts::resolveMutateDeps`) — never per-check, a
 * single fleet-level switch for the whole run. A FLAGLESS re-run against a
 * role that already has a `fleet.lock` entry therefore lands on
 * `skip-unverified` — `confirmBeforeCreateGuard` returns before it ever
 * calls `confirmAppInstallation`, so `reuse-confirmed`/`resume-install` are
 * structurally unreachable, and this module's `validateInstall`/
 * `validateReuse` hooks are never invoked. The registry-repo coverage check
 * this module exists to run is silently absent on exactly the re-run shape
 * `apply-fleet.ts`'s own "Coverage scope" comment above calls out as the
 * concrete motivating incident.
 *
 * The CREATE path (a role with NO prior `fleet.lock` entry) is NOT affected
 * — its `keyPath` comes from the just-exchanged manifest credential
 * (`apply-agent.ts::finishGate2FromCredentials`'s `writeScratchPem`), never
 * from `resolveKeyPath`, so a first-time role is coverage-checked
 * regardless of vault flags.
 *
 * **Fix (macf#1016 requirement 1, the floor):** `apply-fleet.ts`'s per-agent
 * loop extends a `skip-unverified` outcome's `reason` with
 * {@link registryRepoCoverageUnverifiedOnSkipNote} whenever
 * `registry.type === 'repo'` AND `agentDeps.resolveKeyPath === undefined`
 * (this RUN never had a vault-aware resolver wired at all — the precise
 * "flagless" condition, not merely "this outcome happened to be
 * skip-unverified"). Gating on the run-level flag (not the per-role
 * outcome alone) deliberately leaves TWO adjacent skip-unverified shapes
 * untouched, both already carrying their own honest diagnostic from
 * `confirmBeforeCreateGuard`:
 *   - vault flags WERE given but `confirmAppInstallation` itself couldn't
 *     confirm the existing App live (`'unconfirmable'` — JWT mint failure /
 *     network / an unexpected HTTP status). Re-running with the SAME two
 *     flags would not fix this, so this note's "re-run with --vault
 *     --identity-key" advice would be actively wrong here.
 *   - vault flags WERE given but THIS role's PEM specifically isn't in the
 *     vault (`resolveVaultAgentPems`'s per-role `map.get(role)` miss).
 *     `confirmBeforeCreateGuard` produces the IDENTICAL generic reason text
 *     as the fully-flagless case (it has no way to distinguish "no resolver
 *     at all" from "resolver present, this role missing" once `keyPath` is
 *     `undefined`), so it gets no note either — the same residual, left as
 *     future work rather than silently claimed closed.
 *
 * **Requirement 2 (make the check runnable without the vault) — investigated,
 * a dead end for `apply` itself.** `GET /repos/{owner}/{repo}/installation`
 * needs an App JWT (see this module's "What is verified" section above) —
 * not a `ghs_` installation token, so there is no "read the ambient
 * `GH_TOKEN` instead" shortcut. An App JWT needs the App's PEM, and for an
 * ALREADY-PROVISIONED role (the exact shape this gap is about) the App's
 * PEM exists in exactly one durable place by design: the operator's vault
 * (DR-043 Amendment D — read-only-decryptable, never read-modify-written).
 * The per-role recovery artifact (DR-043 Amendment B, `vault-write.ts`) is
 * NOT an alternate source here — it is deleted once the credential reaches
 * the vault, so it never exists for a role this gap applies to (one already
 * fully provisioned). There is no PEM to mint a JWT from without decrypting
 * the vault; requirement 2 is confirmed a dead end for `bootstrap apply`.
 *
 * **Requirement 3 (fold the real check into `macf fleet doctor`) —
 * investigated, plausible but NOT wired today; not implemented this issue.**
 * Unlike `apply` (which runs on the OPERATOR's machine with no PEM outside
 * the vault), `macf fleet doctor` runs FROM a deployed agent's OWN
 * workspace — which already holds a decrypted copy of ITS OWN App PEM
 * on disk (`$KEY_PATH`, workspace-relative, the SAME credential
 * `macf-gh-token.sh` mints `GH_TOKEN` from; see `gh-token-refresh.md`).
 * Minting an App JWT from that PEM needs no vault access at all — a
 * genuinely different, already-available credential source, so requirement
 * 2's dead end does NOT apply to doctor. That said, `commands/fleet-doctor.ts`
 * as it stands today has NEITHER piece this would need: it resolves
 * `agentCertPath`/`agentKeyPath` (`config.ts`) — the mTLS ROUTING cert/key,
 * a different credential entirely from the App PEM — and it never reads
 * `fleet.yaml`'s `owner.registry` (its own "registry" means the MACF
 * coordination registry of peer agents, not DR-043's App-installation
 * registry-repo concept). Wiring requirement 3 for real needs BOTH a new
 * App-JWT-from-`$KEY_PATH` read AND a new `fleet.yaml` parse inside doctor
 * — real work, out of scope for this issue's floor. Recorded here as the
 * recommended future home, not claimed done.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConfirmedInstall } from './identity-confirm.js';
import type { Presence } from './plan.js';
import type { InstallRejection } from './apply-agent.js';

const execFileAsync = promisify(execFile);

/**
 * Bound, same rationale + same values as `identity-confirm.ts`'s own
 * `IDENTITY_EXEC_TIMEOUT_MS` / `IDENTITY_FETCH_TIMEOUT_MS` (macf#841 review
 * nit c) — an unbounded call here would hang `apply`'s per-agent gate-2
 * step, which the operator is actively watching complete.
 */
const REPO_COVERAGE_EXEC_TIMEOUT_MS = 10_000;
const REPO_COVERAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Mint an App JWT from `(appId, keyPath)`. Deliberately DUPLICATED from
 * `identity-confirm.ts::confirmAppInstallation`'s inline mint step (and
 * `commands/doctor.ts::fetchInstallationPermissions`'s own — a THIRD
 * instance of this same ~10-line pattern already exists in this package).
 * Refactoring `identity-confirm.ts` — a file with an extensively-documented,
 * heavily-reviewed A4 epistemic-floor contract — into a shared export is out
 * of scope for #1012; duplicating this mint step follows the SAME
 * precedent this codebase already established across those two files rather
 * than introducing a third, differently-shaped seam. Never throws.
 */
async function mintAppJwt(appId: string, keyPath: string): Promise<string | undefined> {
  let jwt: string;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['token', 'generate', '--app-id', appId, '--key', keyPath, '--jwt', '--token-only'],
      { encoding: 'utf-8', timeout: REPO_COVERAGE_EXEC_TIMEOUT_MS },
    );
    jwt = stdout.trim();
  } catch {
    return undefined;
  }
  // A malformed/empty JWT (e.g. an error string leaked to stdout) is unusable.
  return jwt.startsWith('eyJ') ? jwt : undefined;
}

/**
 * Pure status→{@link Presence} mapping for `GET /repos/{owner}/{repo}/
 * installation` — factored out of {@link checkRepoInAppInstallation} so the
 * exact contract this check's Acceptance Criteria depend on (200→present,
 * 404→absent, everything else→unknown) is directly unit-testable without a
 * real `gh`/`fetch` call, mirroring `identity-confirm.ts`'s own
 * pure-parse/untested-I/O-leaf split (`parseAppInstallations` tested,
 * `confirmAppInstallation`'s own fetch is not).
 */
export function mapRepoInstallationStatus(status: number): Presence {
  if (status === 200) return 'present';
  if (status === 404) return 'absent';
  return 'unknown';
}

/**
 * `GET /repos/{owner}/{repo}/installation` under an App JWT — see this
 * module's doc for why this endpoint, why 200/404 are decisive, and why
 * anything else degrades to `'unknown'`. NEVER throws (mirrors
 * `identity-confirm.ts::confirmAppInstallation`'s A4 contract). This is the
 * real, untested-by-design I/O leaf (see {@link mapRepoInstallationStatus}'s
 * doc) — production default for `buildRegistryRepoValidateInstall`'s
 * `checkFn` param.
 */
export async function checkRepoInAppInstallation(appId: string, keyPath: string, owner: string, repo: string): Promise<Presence> {
  const jwt = await mintAppJwt(appId, keyPath);
  if (jwt === undefined) return 'unknown';

  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REPO_COVERAGE_FETCH_TIMEOUT_MS),
    });
  } catch {
    return 'unknown';
  }
  return mapRepoInstallationStatus(response.status);
}

/**
 * The `apply` refusal text (#1012 requirement 1/2 — names the App AND the
 * repo, "so the fix is one installation edit rather than a search," quoted
 * verbatim from the acceptance criterion). Names BOTH causes a 404 collapses
 * (module doc's "A 404 collapses two distinct causes" section) rather than
 * asserting only one. `appHandle` is the bare handle (`deriveAppHandle`
 * output, no `[bot]` suffix — matches `fleet-manifest.ts::
 * buildTrustedActorsValue`'s convention of appending `[bot]` at the point of
 * use, not baking it into the handle).
 */
export function registryRepoNotInstalledReason(appHandle: string, owner: string, repo: string): string {
  return (
    `App "${appHandle}" is installed, but GET /repos/${owner}/${repo}/installation returned 404 under this App's ` +
    `own JWT — either (a) this App's installation does not include ${owner}/${repo} (fix: GitHub → Settings → ` +
    `Applications → ${appHandle} → Configure → Repository access → add the repo), or (b) ${owner}/${repo} itself ` +
    'does not exist or was renamed (fix: correct owner.registry in fleet.yaml, or create the repo). Either way, ' +
    "this agent would otherwise provision successfully and then be unable to read/write its own registry entry, " +
    `discovered only when it first tries (groundnuty/macf#999's exact failure mode, now guarded for ` +
    'registry.type: repo per #1012). Resolve one of the two causes above, then re-run apply.'
  );
}

/**
 * The plain-language companion to {@link registryRepoNotInstalledReason}
 * (groundnuty/macf#1063 requirement 2 — "say exactly what to click" — and
 * requirement 6 — "no internal references in user-facing text"). Shown ONLY
 * in the interactive "here's what to click" retry dialogue when a rejected
 * install is retried in place
 * (`apply-agent.ts::gate2RetryInstructionLines`) — `registryRepoNotInstalledReason`
 * itself still carries the full technical detail (the `GET …/installation`
 * 404, the `groundnuty/macf#999`/`#1012` cross-reference) into
 * `AgentApplyOutcome.reason` unchanged, exactly as #1012 shipped it. This
 * function states the SAME fact — App, repo, what to click — with neither.
 */
export function registryRepoRetryInstruction(appHandle: string, owner: string, repo: string): string {
  return `App "${appHandle}" is missing access to ${owner}/${repo}. On the page that opens, tick "${owner}/${repo}" under "Repository access," then click "Save."`;
}

/**
 * The non-blocking `apply` warning for `'unknown'` (#1012 requirement 3 —
 * honest-unknown never silently passes as confirmed-fine, but also never
 * refuses a possibly-healthy run on a mere read failure — the same floor
 * `confirmBeforeCreateGuard`'s own `'unconfirmable'` branch already applies
 * at the identity layer). Printed via the caller's `log`, never returned as
 * a `validateInstall` rejection — an `'unknown'` MUST NOT block.
 */
export function registryRepoCoverageUnknownWarning(appHandle: string, owner: string, repo: string): string {
  return (
    `WARNING: could not confirm whether App "${appHandle}"'s installation includes the registry repo ` +
    `${owner}/${repo} (GET /repos/${owner}/${repo}/installation could not be read — JWT mint failure / network / ` +
    'an unexpected HTTP status). This is UNKNOWN, never treated as confirmed-missing (DR-043 Amendment A) — but it ' +
    "also means #1012's guard could not verify this App. Check manually: GitHub → Settings → Applications → " +
    `${appHandle} → Configure → Repository access.`
  );
}

/**
 * The `skip-unverified` addendum for a FLAGLESS re-run against a
 * repo-scoped registry (groundnuty/macf#1016 — see this module's "The gap
 * THAT coverage scope leaves open" doc section for the full mechanism +
 * why this is gated on the run having NO vault-aware resolver at all,
 * never merely on the outcome shape). Appended to — never replacing —
 * `confirmBeforeCreateGuard`'s own `skip-unverified` reason
 * (`apply-agent.ts`'s generic "no private-key path is available to
 * live-reconfirm it" text), so both the identity-confirm gap AND this
 * check's own gap are named in one `reason` string. Amendment A's
 * honest-unknown floor applies here exactly as it does to
 * {@link registryRepoCoverageUnknownWarning}: this is `unknown`, never a
 * silent `ok` — the message states what's unverified AND how to verify it
 * (macf#1016 requirement's own two acceptance criteria), never just the
 * first half.
 */
export function registryRepoCoverageUnverifiedOnSkipNote(appHandle: string, owner: string, repo: string): string {
  return (
    `Registry-repo coverage for ${owner}/${repo} was ALSO not verified this run (groundnuty/macf#1016) — App ` +
    `"${appHandle}"'s installation was never live-checked against ${owner}/${repo} because this run has no ` +
    'vault-aware confirm wired (no --vault/--identity-key given). Re-run with "macf bootstrap apply --vault ' +
    '<path> --identity-key <path>" to verify it.'
  );
}

/**
 * Build the `AgentApplyDeps.validateInstall` closure for ONE agent App when
 * `registry.type === 'repo'` (groundnuty/macf#1012) — wired by
 * `apply-fleet.ts`'s per-agent loop, mirroring `apply-runner-ops.ts::
 * validateRunnerOpsInstall`'s "post-gate-2 verify-then-refuse" shape but
 * ASYNC (a live network call, not a field read off the already-observed
 * `ConfirmedInstall`) and PARAMETERIZED per agent (the rejection names THIS
 * agent's own App handle, never a generic "an App").
 *
 * `'absent'` → a rejection string (blocks this identity apply — see
 * `apply-agent.ts::runGate2` / `applyIdentity`'s `reuse-confirmed` branch,
 * both call sites for `AgentApplyDeps.validateInstall`). `'unknown'` → LOGS
 * a warning via `log` and returns `undefined` (does NOT block). `'present'`
 * → returns `undefined` silently.
 *
 * `checkFn` defaults to the real {@link checkRepoInAppInstallation} — tests
 * inject a fake so the suite never makes a real `gh`/`fetch` call, mirroring
 * every other injectable-I/O-seam convention in this package.
 */
export function buildRegistryRepoValidateInstall(
  registryOwner: string,
  registryRepo: string,
  appHandle: string,
  log: (line: string) => void,
  checkFn: (appId: string, keyPath: string, owner: string, repo: string) => Promise<Presence> = checkRepoInAppInstallation,
): (install: ConfirmedInstall, keyPath: string) => Promise<InstallRejection | undefined> {
  return async (install, keyPath) => {
    const presence = await checkFn(install.appId, keyPath, registryOwner, registryRepo);
    if (presence === 'absent') {
      // groundnuty/macf#1063 — structured rejection: `message` keeps
      // #1012's own technical text (unchanged) for `AgentApplyOutcome.reason`;
      // `retryInstruction` is the plain-language companion the interactive
      // retry dialogue shows instead (see that field's own doc).
      return {
        message: registryRepoNotInstalledReason(appHandle, registryOwner, registryRepo),
        retryInstruction: registryRepoRetryInstruction(appHandle, registryOwner, registryRepo),
      };
    }
    if (presence === 'unknown') {
      log(registryRepoCoverageUnknownWarning(appHandle, registryOwner, registryRepo));
    }
    return undefined;
  };
}
