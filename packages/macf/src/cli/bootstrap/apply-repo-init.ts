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
import type { RegistryConfig } from '@groundnuty/macf-core';
import type { FleetAgent, FleetManifest } from './fleet-manifest.js';
import type { RepoInitOptions } from '../commands/repo-init.js';
import { repoInit as realRepoInit } from '../commands/repo-init.js';
import type { Presence } from './plan.js';
import type { CreateRepoFn } from './repo-create.js';

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

/** Real `git add -A && git commit && git push` — a thin I/O leaf. Detects "nothing to commit" via `git diff --cached --quiet`'s exit code (0 = clean) rather than string-matching git's stdout. Never `--force` (mirrors `bootstrap-commit-vault.sh`'s non-destructive push discipline). */
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
  | { readonly repo: string; readonly role: string; readonly status: 'applied'; readonly pushed: boolean }
  | { readonly repo: string; readonly role: string; readonly status: 'failed'; readonly reason: string };

/**
 * Run the `repo-init` step for ONE agent: clone `agent.repo` into a scratch
 * dir, run the real `repoInit()` against it (workflow + agent-config.json +
 * labels — see `repo-init.ts`; label creation itself degrades gracefully
 * without a token, per that module's own catch), commit + push, clean up the
 * scratch dir unconditionally. NEVER throws — every failure resolves to
 * `status: 'failed'`.
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

    await runRepoInit(dir, {
      repo: agent.repo,
      actionsVersion: manifest.versions?.actions ?? DEFAULT_ACTIONS_VERSION,
      // repo/role are unique-per-manifest (FleetManifestSchema's superRefine
      // rejects duplicate agents[].repo) — one agent per repo in v0, so the
      // routing config for THIS repo names exactly this agent's role.
      agents: agent.role,
      force: false,
      project: manifest.metadata.name,
      ...registryOpts,
    });

    const pushResult = await deps.commitAndPush(dir, (opts?.commitMessage ?? defaultCommitMessage)(agent.repo));
    return { repo: agent.repo, role: agent.role, status: 'applied', pushed: pushResult === 'pushed' };
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

export interface AgentRepoDeps {
  readonly checkExists: (repo: string) => Promise<Presence>;
  readonly createRepo: CreateRepoFn;
}

export type AgentRepoOutcome =
  | { readonly repo: string; readonly role: string; readonly status: 'created' }
  | { readonly repo: string; readonly role: string; readonly status: 'present' }
  | { readonly repo: string; readonly role: string; readonly status: 'failed'; readonly reason: string };

/**
 * Ensure `agent.repo` exists on GitHub, creating it if absent. Called by
 * `apply-fleet.ts` for EVERY agent, BEFORE `applyAgentIdentity` — i.e.
 * before EITHER consent gate for that agent, not merely before this
 * module's own `cloneRepo` step (see this module's doc for why the ordering
 * matters: gate 2's install page can't list a repo that doesn't exist).
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
 * An ALREADY-PRESENT repo is left untouched regardless of `provenance`
 * (`status: 'present'`) — unlike the control repo (`control-repo.ts`), an
 * agent repo has no ownership-custody hazard the way the vault-holding
 * control repo does (the EXISTING `repoItem` plan item already treats any
 * present repo at the declared full name as `noop`, no ownership check —
 * `provenance: 'mirror'` explicitly EXPECTS a pre-existing repo in some
 * flows), so simple presence is sufficient here.
 *
 * NEVER throws — every failure resolves to `status: 'failed'`, including a
 * throwing `deps.checkExists` (the whole body is one try/catch, not just the
 * `createRepo` call — the real `checkRepoExists` never throws by its own
 * contract, but a caller-supplied fake shouldn't be able to violate this
 * function's own contract).
 */
export async function ensureAgentRepo(agent: FleetAgent, manifest: FleetManifest, deps: AgentRepoDeps): Promise<AgentRepoOutcome> {
  try {
    const presence = await deps.checkExists(agent.repo);
    if (presence === 'present') return { repo: agent.repo, role: agent.role, status: 'present' };
    if (presence === 'unknown') {
      return {
        repo: agent.repo,
        role: agent.role,
        status: 'failed',
        reason: `could not confirm whether "${agent.repo}" already exists (auth / network / rate-limit) — refusing to attempt creation without a confident existence read.`,
      };
    }
    const template = agent.provenance === 'mirror' ? undefined : manifest.defaults.role_template;
    await deps.createRepo(agent.repo, template !== undefined ? { template } : undefined);
    return { repo: agent.repo, role: agent.role, status: 'created' };
  } catch (err) {
    return { repo: agent.repo, role: agent.role, status: 'failed', reason: errMessage(err) };
  }
}
