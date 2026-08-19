/**
 * The `repo-init` step of `macf bootstrap apply` — DR-043 §D2/§D4, Slice 2b
 * increment 5a (groundnuty/macf#838).
 *
 * DR-043's D035-lesson table is explicit: "the routing plane must be `macf
 * repo-init`-generated, never hand-templated (macf#797/#805/#806) → `apply`
 * shells out to `repo-init` with the full fleet — born-correct configs."
 * This module is that shell-out: it REUSES `commands/repo-init.ts::repoInit`
 * verbatim (not reimplemented — the task brief is explicit about that) for
 * `.github/workflows/agent-router.yml` + `.github/agent-config.json` +
 * status/agent labels, run against a throwaway local clone of the agent's
 * OWN repo (`repoInit` operates on a local directory; there is no
 * `deploy_path`-shaped local checkout on the Mac side where `apply` runs —
 * DR-043 §D4's plane split keeps the VM-side clone/`macf init` out of
 * `bootstrap`'s job entirely, same as the DR-035 skill's "emits a command
 * list" posture for that half).
 *
 * Every git/subprocess touch (`cloneRepo` / `commitAndPush` / `repoInit`
 * itself) is behind {@link RepoInitStepDeps} so the ORCHESTRATION here —
 * mapping a `FleetAgent` + `FleetManifest` onto `RepoInitOptions`, scratch-dir
 * lifecycle, cleanup, the `local`-registry rejection — is fully unit-tested
 * with zero real git/network. The real `cloneRepo`/`commitAndPush`
 * implementations are thin `git` I/O leaves (same posture as
 * `manifest-exchange.ts`'s `gh` call) — exercised for real only via a
 * caller that supplies them, never faked-to-pass.
 *
 * **Repo creation (macf#857, DR-043 Amendment F / #854 §2):** the module
 * doc used to flag creating the repo from `defaults.role_template` as future
 * scope — {@link ensureAgentRepo} closes that gap. `apply-fleet.ts` calls it
 * for EVERY agent, BEFORE `applyAgentIdentity` (i.e. before either consent
 * gate) — not just before this module's `cloneRepo` step — because consent
 * gate 2's install page can't list a repo that doesn't exist yet (the
 * ordering bug the live provision #854 hit on the operator's first Install
 * click). `cloneRepo` below still FAILS LOUD if the repo is somehow still
 * missing by the time it runs (`ensureAgentRepo` failed, or a caller drives
 * this module directly without it) — defense-in-depth, not the primary path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegistryConfig, TokenSource } from '@groundnuty/macf-core';
import type { FleetAgent, FleetManifest } from './fleet-manifest.js';
import type { LabelsOutcome, RepoInitOptions } from '../commands/repo-init.js';
import { repoInit as realRepoInit } from '../commands/repo-init.js';
import type { CreateRepoFn } from './repo-create.js';
import type { RepoArchivedMeta } from './observer.js';

const execFileAsync = promisify(execFile);

/** The floating actions-workflow ref used when `fleet.yaml` doesn't declare `versions.actions` — `repoInit` itself resolves a floating v3+ ref to an immutable full tag (with a loud, non-fatal degrade if GitHub is unreachable). */
export const DEFAULT_ACTIONS_VERSION = 'v3';

export class RepoInitStepError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RepoInitStepError';
    this.code = code;
  }
}

/**
 * Map `fleet.yaml`'s `owner.registry` (`RegistryConfig`) onto the subset of
 * `RepoInitOptions` that steers the v3+ caller's `registry-api-path` input.
 * Mirrors `repo-init.ts`'s OWN `buildRoutingRegistry` (which builds the
 * reverse direction, CLI-flags → `RegistryConfig`) — `local` has no
 * GitHub-Actions routing path, same rejection `repo-init --registry-type
 * local` already gives.
 */
export function repoInitRegistryOptions(
  registry: RegistryConfig,
): Pick<RepoInitOptions, 'registryType' | 'registryOrg' | 'registryUser'> {
  switch (registry.type) {
    case 'org':
      return { registryType: 'org', registryOrg: registry.org };
    case 'profile':
      return { registryType: 'profile', registryUser: registry.user };
    case 'repo':
      return { registryType: 'repo' };
    case 'local':
      throw new RepoInitStepError(
        'repo_init_local_registry',
        'owner.registry.type is "local" — local registry has no GitHub-Actions routing path; macf-actions ' +
          'v3 routing requires a GitHub-backed registry (org, profile, or repo).',
      );
  }
}

export interface RepoInitStepOptions {
  /** Defaults to `https://github.com/<repo>.git`. Tests override to point at a local bare repo — no real network. */
  readonly cloneUrl?: (repo: string) => string;
  readonly scratchDirPrefix?: string;
  readonly commitMessage?: (repo: string) => string;
  /**
   * Explicit App credentials for `repoInit`'s label-creation token mint
   * (groundnuty/macf#920). `apply-fleet.ts` threads this from a freshly-CREATED
   * agent's in-memory credentials (appId/installId + a scratch-PEM keyPath it
   * writes/cleans up itself via `apply-agent.ts`'s `writeScratchPem`/
   * `cleanupScratchPem`) — a Mac-side `macf bootstrap apply` run has no
   * ambient `GH_TOKEN`/`APP_ID` env for the just-minted bot, so without this
   * `repoInit`'s own `generateToken()` call always degrades to
   * `labels: {status:'skipped'}` (macf#920's actual repro). Omitted for the
   * `reused`/`resumed-install` identity paths, which have no PEM in process
   * memory this run — see this module's doc + `applyRepoInitForAgent`'s
   * doc for how that case is scored (leniently — this run supplied nothing,
   * so nothing new is asserted about it).
   */
  readonly tokenSource?: TokenSource;
}

export interface RepoInitStepDeps {
  readonly cloneRepo: (url: string, destDir: string) => Promise<void>;
  readonly commitAndPush: (dir: string, message: string) => Promise<'pushed' | 'nothing-to-commit'>;
  /** Injectable so tests never write real files for a real network repo — defaults to the real `repoInit`. */
  readonly repoInit?: typeof realRepoInit;
}

/** Real `git clone --depth 1` — a thin I/O leaf, untested directly (same posture as the rest of this package's `gh`/`git` shell-outs). */
export async function realCloneRepo(url: string, destDir: string): Promise<void> {
  await execFileAsync('git', ['clone', '--depth', '1', url, destDir]);
}

/**
 * Real `git add -A && git commit && git push` — a thin I/O leaf. Detects
 * "nothing to commit" via `git diff --cached --quiet`'s exit code (0 =
 * clean) rather than string-matching git's stdout. Never `--force` (mirrors
 * `bootstrap-commit-vault.sh`'s non-destructive push discipline).
 *
 * **Agent-repo repo-init ONLY — do not wire this into `ControlRepoDeps`.**
 * `-A` is legitimate here because `repoInit()` is the sole writer of this
 * scratch checkout (`.github/workflows/agent-router.yml` +
 * `.github/agent-config.json` + labels), so staging everything it produced
 * is correct by construction. The control repo has a DIFFERENT
 * git-committed-content invariant (DR-043 Amendment F, "sealed-or-public
 * ONLY" — `secrets/recovery/<role>.age` must never be swept in) and uses
 * `control-repo.ts`'s explicit-allowlist `realControlRepoCommitAndPush`
 * instead — see that module's doc + groundnuty/macf#857's review.
 */
export async function realCommitAndPush(dir: string, message: string): Promise<'pushed' | 'nothing-to-commit'> {
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: dir });
    return 'nothing-to-commit';
  } catch {
    // Non-zero exit means there ARE staged changes — fall through to commit + push.
  }
  await execFileAsync('git', ['commit', '-m', message], { cwd: dir });
  await execFileAsync('git', ['push'], { cwd: dir });
  return 'pushed';
}

function defaultCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

function defaultCommitMessage(repo: string): string {
  return `chore(routing): macf repo-init — agent-router.yml + agent-config.json (DR-043 bootstrap apply, ${repo})`;
}

export type RepoInitStepOutcome =
  | { readonly repo: string; readonly role: string; readonly status: 'applied'; readonly pushed: boolean; readonly labels: LabelsOutcome }
  | { readonly repo: string; readonly role: string; readonly status: 'failed'; readonly reason: string };

/**
 * Whether a repo-init run's label outcome is good enough to report
 * `status: 'applied'` (groundnuty/macf#920). `'ok'` always is. A NON-'ok'
 * outcome (`'skipped'`/`'partial-failure'`) is only a HARD FAILURE when
 * `opts.tokenSource` was given — i.e. this run supplied everything
 * `repoInit` needed to succeed, so anything short of `'ok'` is a genuine
 * regression apply must not paper over ("green exit must not mean
 * unroutable fleet"). When no `tokenSource` was given (the `reused`/
 * `resumed-install` identity paths, which have no PEM in memory this run),
 * a non-'ok' outcome is the PRE-EXISTING, already-acknowledged gap this
 * increment does not close — see this module's + `apply-fleet.ts`'s doc.
 * Scoring it as a failure there would regress every already-provisioned
 * fleet's ordinary re-run apply, which is worse than the gap it would
 * "fix."
 */
function labelsAreGoodEnough(labels: LabelsOutcome, tokenSourceGiven: boolean): boolean {
  if (labels.status === 'ok') return true;
  return !tokenSourceGiven;
}

/**
 * Run the `repo-init` step for ONE agent: clone `agent.repo` into a scratch
 * dir, run the real `repoInit()` against it (workflow + agent-config.json +
 * labels — see `repo-init.ts`). `opts.tokenSource`, when given, is threaded
 * straight into `repoInit`'s own `tokenSource` option (groundnuty/macf#920) so
 * label creation can actually mint a token instead of degrading to
 * `labels: {status:'skipped'}` — see `RepoInitStepOptions.tokenSource`'s doc.
 * Commit + push ALWAYS runs regardless of the label outcome (the routing
 * workflow/config files are independently useful even when labels didn't
 * fully land), but the overall step outcome is `status: 'failed'` — never
 * silently `'applied'` — whenever {@link labelsAreGoodEnough} says the label
 * outcome doesn't meet this run's own bar. NEVER throws — every failure
 * resolves to `status: 'failed'`.
 */
export async function applyRepoInitForAgent(
  agent: FleetAgent,
  manifest: FleetManifest,
  deps: RepoInitStepDeps,
  opts?: RepoInitStepOptions,
): Promise<RepoInitStepOutcome> {
  const cloneUrl = opts?.cloneUrl ?? defaultCloneUrl;
  const runRepoInit = deps.repoInit ?? realRepoInit;
  const dir = mkdtempSync(join(tmpdir(), opts?.scratchDirPrefix ?? 'macf-bootstrap-repo-init-'));
  try {
    let registryOpts: Pick<RepoInitOptions, 'registryType' | 'registryOrg' | 'registryUser'>;
    try {
      registryOpts = repoInitRegistryOptions(manifest.owner.registry);
    } catch (err) {
      return { repo: agent.repo, role: agent.role, status: 'failed', reason: errMessage(err) };
    }

    await deps.cloneRepo(cloneUrl(agent.repo), dir);

    const result = await runRepoInit(dir, {
      repo: agent.repo,
      actionsVersion: manifest.versions?.actions ?? DEFAULT_ACTIONS_VERSION,
      // repo/role are unique-per-manifest (FleetManifestSchema's superRefine
      // rejects duplicate agents[].repo) — one agent per repo in v0, so the
      // routing config for THIS repo names exactly this agent's role.
      agents: agent.role,
      force: false,
      project: manifest.metadata.name,
      ...(opts?.tokenSource !== undefined ? { tokenSource: opts.tokenSource } : {}),
      ...registryOpts,
    });

    // Always commit+push what repoInit DID write (workflow/config land
    // regardless of the label outcome) — see this function's doc.
    const pushResult = await deps.commitAndPush(dir, (opts?.commitMessage ?? defaultCommitMessage)(agent.repo));

    if (!labelsAreGoodEnough(result.labels, opts?.tokenSource !== undefined)) {
      const labelReason =
        result.labels.status === 'skipped'
          ? `label creation was skipped — ${result.labels.reason}`
          : `label creation failed for: ${result.labels.status === 'partial-failure' ? result.labels.failed.join(', ') : ''}`;
      return {
        repo: agent.repo,
        role: agent.role,
        status: 'failed',
        reason:
          `${labelReason} (workflow/config were still ${pushResult === 'pushed' ? 'pushed' : 'unchanged'} to "${agent.repo}") — ` +
          'a fleet missing its role/status labels cannot route (groundnuty/macf#920).',
      };
    }

    return { repo: agent.repo, role: agent.role, status: 'applied', pushed: pushResult === 'pushed', labels: result.labels };
  } catch (err) {
    return { repo: agent.repo, role: agent.role, status: 'failed', reason: errMessage(err) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Agent repo creation (macf#857, DR-043 Amendment F / #854 §2) ---
// --- + agent repo revival (DR-043 Amendment G correction, groundnuty/macf#1034) ---

export interface AgentRepoDeps {
  /**
   * Presence + `archived` bit — the SAME shape `control-repo.ts`'s
   * `ControlRepoMeta` uses, here typed as `observer.ts::RepoArchivedMeta`
   * (structurally identical; kept as a separate alias because the two
   * domains — control repo vs. agent repo — are semantically distinct even
   * though the read is not). Production wires this to
   * `observer.ts::checkRepoArchivedState` — the EXACT function `plan.ts`'s
   * control-repo-archived observation already uses, reused verbatim rather
   * than adding a second `{archived}` reader (groundnuty/macf#1034, the
   * #1000 golden-path rule: one reader per fact).
   */
  readonly checkMeta: (repo: string) => Promise<RepoArchivedMeta>;
  readonly createRepo: CreateRepoFn;
  /**
   * DR-043 Amendment G revival primitive (groundnuty/macf#1034) —
   * `repo-archive.ts::realUnarchiveRepo` in production, the EXACT SAME
   * function `control-repo.ts::provisionControlRepo` already calls to
   * revive the control repo. Never a second un-archive primitive. Called
   * ONLY when `checkMeta` confirms `archived === true` AND
   * `opts.confirmUnarchive === true` — see {@link ensureAgentRepo}'s doc.
   */
  readonly unarchiveRepo: (repo: string) => Promise<void>;
}

export interface AgentRepoOptions {
  /**
   * DR-043 Amendment G revival confirm gate (groundnuty/macf#1034) — mirrors
   * `control-repo.ts`'s `ControlRepoOptions.confirmUnarchive` EXACTLY. The
   * SAME single plan-approve-once "yes" that authorizes the control repo's
   * revival (`apply-fleet.ts`'s `provisionControlRepo` call) ALSO authorizes
   * every declared agent repo's revival — one approval covers the whole
   * declared repo set (control + every `manifest.agents[].repo`), never a
   * second per-repo prompt (Amendment G's "one approval covering the set"
   * requirement — the SAME target-set symmetry `teardown.ts`'s
   * `computeArchiveRepoTargets` already establishes for the teardown
   * direction). `false`/absent (the safe default) means `ensureAgentRepo`
   * NEVER un-archives, no matter how the run got invoked — see
   * `provisionControlRepo`'s identical safe-default rationale.
   */
  readonly confirmUnarchive?: boolean;
}

export type AgentRepoOutcome =
  | { readonly repo: string; readonly role: string; readonly status: 'created' }
  | { readonly repo: string; readonly role: string; readonly status: 'present' }
  /** DR-043 Amendment G (groundnuty/macf#1034) — was archived, `opts.confirmUnarchive` was `true`, now un-archived. Distinct from `'present'` so a caller can log/render "this repo was just revived" rather than a silent ordinary presence. */
  | { readonly repo: string; readonly role: string; readonly status: 'revived' }
  /** DR-043 Amendment G (groundnuty/macf#1034) — `archived === true` but `opts.confirmUnarchive` was NOT `true`. `deps.unarchiveRepo` is NEVER called on this path — the whole point (un-archiving must never be silent). */
  | { readonly repo: string; readonly role: string; readonly status: 'archived'; readonly reason: string }
  /**
   * Amendment A's honest-unknown floor, applied here (groundnuty/macf#1034
   * requirement 4): the existence/archived read was inconclusive
   * (auth/network/rate-limit), OR existence was confirmed but the archived
   * bit itself could not be parsed from the response. EITHER sub-case is
   * reported `'unknown'`, never silently folded into `'present'` (which
   * would be the false-`present` Amendment A specifically forbids) — see
   * this function's doc for why `classifyControlRepoOwnership`'s existing
   * `meta.archived === true ? … : 'ours'` fallthrough is NOT mirrored here.
   */
  | { readonly repo: string; readonly role: string; readonly status: 'unknown'; readonly reason: string }
  | { readonly repo: string; readonly role: string; readonly status: 'failed'; readonly reason: string };

/**
 * Ensure `agent.repo` exists on GitHub (creating it if absent) and, when
 * archived, reviving it — DR-043 Amendment G (groundnuty/macf#1034 correcting
 * #867). Called by `apply-fleet.ts` for EVERY agent, BEFORE
 * `applyAgentIdentity` — i.e. before EITHER consent gate for that agent, not
 * merely before this module's own `cloneRepo` step (see this module's doc for
 * why the ordering matters: gate 2's install page can't list a repo that
 * doesn't exist, and `applyRepoInitForAgent`'s push needs a WRITABLE repo).
 *
 * `agent.provenance` steers WHAT gets created, mirroring the DR-035 field
 * lesson this schema field encodes (`fleet-manifest.ts`'s doc):
 *
 *   - `'template'` (default/undefined) — `gh repo create --template
 *     defaults.role_template` (the DR-035 skill's manual step, promoted to
 *     code — `repo-create.ts`'s doc).
 *   - `'mirror'` — a BLANK repo, no template. A mirror agent's real content
 *     comes from an existing local dir (e.g. an Overleaf-backed paper repo)
 *     being remote-added + pushed — that push is VM-side, out of `apply`'s
 *     job entirely per DR-043 §D4 (no `deploy_path` checkout exists on the
 *     Mac side `apply` runs on). This function only ensures the GitHub-side
 *     repo EXISTS for that later push to target; templating it would just
 *     mean the mirror push immediately overwrites template content anyway.
 *
 * An ALREADY-PRESENT, non-archived repo is left untouched regardless of
 * `provenance` (`status: 'present'`) — unlike the control repo
 * (`control-repo.ts`), an agent repo has no ownership-custody hazard the way
 * the vault-holding, DERIVED-name control repo does (its full name is
 * OPERATOR-DECLARED in `fleet.yaml`, not derived, so there is no collision
 * surface to classify against — the EXISTING `repoItem` plan item already
 * treats any present repo at the declared full name as `noop`, no ownership
 * check; `provenance: 'mirror'` explicitly EXPECTS a pre-existing repo in
 * some flows), so simple presence is sufficient for the create/reuse
 * decision. **Ownership for REVIVAL is established once, fleet-level, via
 * the control repo's `classifyControlRepoOwnership`** (reached this function
 * at all means `provisionControlRepo` already confirmed `ours`/
 * `ours-archived` — a `foreign` control repo aborts the entire run before
 * this function is ever called, per `apply-fleet.ts`'s doc) — this function
 * does NOT re-derive a second, per-agent-repo ownership classifier (the
 * #1000 golden-path rule); it trusts `agent.repo`'s EXACT declared name the
 * same way `teardown.ts::computeArchiveRepoTargets` already does for the
 * teardown direction.
 *
 * An ARCHIVED repo is revived only when `opts.confirmUnarchive === true`
 * (see {@link AgentRepoOptions.confirmUnarchive}'s doc) — `deps.unarchiveRepo`
 * is called BEFORE this function returns, so a caller's subsequent
 * `cloneRepo`/push against this repo lands on a writable target.
 *
 * NEVER throws — every failure resolves to `status: 'failed'`, including a
 * throwing `deps.checkMeta` (the whole body is one try/catch, not just the
 * `createRepo`/`unarchiveRepo` calls — the real `checkRepoArchivedState`
 * never throws by its own contract, but a caller-supplied fake shouldn't be
 * able to violate this function's own contract).
 */
export async function ensureAgentRepo(
  agent: FleetAgent,
  manifest: FleetManifest,
  deps: AgentRepoDeps,
  opts?: AgentRepoOptions,
): Promise<AgentRepoOutcome> {
  try {
    const meta = await deps.checkMeta(agent.repo);
    if (meta.presence === 'absent') {
      const template = agent.provenance === 'mirror' ? undefined : manifest.defaults.role_template;
      await deps.createRepo(agent.repo, template !== undefined ? { template } : undefined);
      return { repo: agent.repo, role: agent.role, status: 'created' };
    }
    if (meta.presence === 'unknown') {
      return {
        repo: agent.repo,
        role: agent.role,
        status: 'unknown',
        reason: `could not confirm whether "${agent.repo}" already exists (auth / network / rate-limit) — refusing to attempt creation or archived-state action without a confident existence read.`,
      };
    }
    // meta.presence === 'present' from here on.
    if (meta.archived === undefined) {
      // Existence is confirmed, but the archived bit itself could not be
      // read/parsed — Amendment A's honest-unknown floor: this must NOT
      // fall through to "present, not archived" (that would be the
      // false-`present` Amendment A forbids — see this function's doc for
      // why `classifyControlRepoOwnership`'s own `=== true ? … : 'ours'`
      // fallthrough is deliberately not mirrored here).
      return {
        repo: agent.repo,
        role: agent.role,
        status: 'unknown',
        reason: `"${agent.repo}" exists, but its archived state could not be confirmed (the read succeeded but did not report a boolean \`archived\` field) — refusing to guess whether it needs reviving.`,
      };
    }
    if (meta.archived === true) {
      if (opts?.confirmUnarchive !== true) {
        // Amendment G: un-archiving reverses a state the operator
        // DELIBERATELY set — never inferred, never flipped as a side effect.
        // `deps.unarchiveRepo` is NOT called on this path.
        return {
          repo: agent.repo,
          role: agent.role,
          status: 'archived',
          reason:
            `"${agent.repo}" is ARCHIVED (DR-043 Amendment G — a deliberate, reversible \`macf fleet archive\` ` +
            'state). Revival is free but NOT automatic: re-run with confirmation (the plan-approve-once "yes" ' +
            'that authorizes this apply run) to un-archive + resume normal reconcile.',
        };
      }
      await deps.unarchiveRepo(agent.repo);
      return { repo: agent.repo, role: agent.role, status: 'revived' };
    }
    return { repo: agent.repo, role: agent.role, status: 'present' };
  } catch (err) {
    return { repo: agent.repo, role: agent.role, status: 'failed', reason: errMessage(err) };
  }
}
