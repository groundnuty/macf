/**
 * The per-fleet control-plane repo (`<fleet>-control`) — DR-043 Amendment F,
 * groundnuty/macf#857. Provisioning step 0 of `macf bootstrap apply`: the
 * FIRST mutating action of an apply run, before any consent gate, before any
 * per-agent processing.
 *
 * **Why a dedicated custody boundary.** Amendment F's trigger: `fleet.yaml`
 * living in an AGENT's repo is a privilege inversion — the fleet's own
 * science agent has write access to the desired-state manifest it's
 * supposed to be reconciled AGAINST, and could clobber the sealed
 * `vault.age` sitting next to it. The fix is a repo NO fleet agent gets
 * write access to. Discovery is deterministic derivation
 * (`fleet-manifest.ts::deriveControlRepoName`) — no registry pointer, no
 * lookup, no drift surface.
 *
 * **Ownership — the confirm-before-create shape, applied to a repo.** A
 * derived name is a COLLISION SURFACE: `<fleet>-control` might already exist
 * as someone else's unrelated repo, or as a SAME-NAMED retired fleet's
 * leftover (Amendment F names both explicitly). Silently adopting either
 * would hand this apply run write access to a repo it doesn't actually own
 * the custody chain of. {@link classifyControlRepoOwnership} is the pure
 * decision core:
 *
 *   - **absent** → safe to create.
 *   - **present, ARCHIVED** → always `foreign`, unconditionally — this is
 *     the "retired fleet's leftover" case by construction: Amendment F's own
 *     retirement sequence archives (never deletes) a control repo, so an
 *     archived repo can NEVER be a live fleet's control repo. Deliberately
 *     checked BEFORE the content read below — a retired fleet's `fleet.yaml`
 *     would otherwise still have a byte-identical `metadata.name` (fleet
 *     names aren't reused casually, but nothing stops it), which would
 *     misclassify the exact case Amendment F warns about as `ours`.
 *   - **present, not archived, `fleet.yaml` unreadable/unparseable/
 *     name-mismatched** → `foreign` — someone else's repo, or a different
 *     fleet's control repo occupying this derived name coincidentally
 *     (`metadata.name` collisions are a schema-level uniqueness gap the
 *     manifest schema doesn't police across fleets, so this classifier is
 *     the actual guard).
 *   - **present, not archived, `fleet.yaml` parses with a matching
 *     `metadata.name`** → `ours` — a prior successful `apply` for THIS
 *     fleet. Reused, not recreated (idempotent re-run — see the module's
 *     `provisionControlRepo` doc).
 *   - **existence itself unconfirmable** (auth/network/rate-limit) →
 *     `unknown` — refuses BOTH create and reuse rather than guessing; same
 *     "honest-unknown over false-present" posture DR-043 Amendment A4
 *     establishes for the identity plane, applied here to the repo layer.
 *
 * **Ordering.** `provisionControlRepo` is called ONCE, before
 * `apply-fleet.ts`'s per-agent loop — see that module's "Bootstrap ordering"
 * doc section for the full step-0-before-any-gate sequence quoted from code.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import type { FleetManifest } from './fleet-manifest.js';
import { deriveControlRepoName, parseFleetManifest } from './fleet-manifest.js';
import type { Presence } from './plan.js';
import { getStderr } from './observer.js';
import type { CreateRepoFn } from './repo-create.js';

const execFileAsync = promisify(execFile);

// --- Naming ---

/** `owner/<fleet>-control` — the full name every I/O primitive in this module addresses. */
export function controlRepoFullName(manifest: FleetManifest): string {
  return `${manifest.owner.account}/${deriveControlRepoName(manifest.metadata.name)}`;
}

// --- Ownership classification (pure) ---

export interface ControlRepoMeta {
  readonly presence: Presence;
  /** Only meaningful when `presence === 'present'`. `undefined` if the archived bit itself couldn't be read (degrades to `'unknown'` in {@link classifyControlRepoOwnership} via the presence check — see that function). */
  readonly archived?: boolean;
}

export type ControlRepoOwnership =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ours' }
  | { readonly kind: 'foreign'; readonly reason: string }
  | { readonly kind: 'unknown' };

/** Pure — see the module doc for the full decision table this implements. */
export function classifyControlRepoOwnership(
  meta: ControlRepoMeta,
  manifestFileContent: string | undefined,
  desired: FleetManifest,
): ControlRepoOwnership {
  if (meta.presence === 'absent') return { kind: 'absent' };
  if (meta.presence === 'unknown') return { kind: 'unknown' };

  // presence === 'present' from here on.
  if (meta.archived === true) {
    return {
      kind: 'foreign',
      reason:
        'repo exists but is ARCHIVED — DR-043 Amendment F names this explicitly as the "retired fleet leftover" ' +
        'case: retirement archives (never deletes) a control repo, so an archived repo can never be the LIVE control ' +
        'repo for a fresh apply. Un-archive it manually first if this fleet is genuinely being revived, or pick a ' +
        'different fleet name.',
    };
  }

  if (manifestFileContent === undefined) {
    return {
      kind: 'foreign',
      reason:
        'repo exists but its fleet.yaml could not be read (missing, or the read failed) — does not look like a ' +
        'macf-bootstrap-managed control repo.',
    };
  }

  let parsed: FleetManifest;
  try {
    parsed = parseFleetManifest(manifestFileContent);
  } catch (err) {
    return {
      kind: 'foreign',
      reason: `repo exists and has a fleet.yaml, but it failed schema validation (${errMessage(err)}) — does not look like a macf-bootstrap-managed control repo.`,
    };
  }

  if (parsed.metadata.name !== desired.metadata.name) {
    return {
      kind: 'foreign',
      reason:
        `repo exists with a fleet.yaml declaring fleet "${parsed.metadata.name}", not "${desired.metadata.name}" ` +
        '— someone else\'s repo, or a different fleet\'s control repo occupying this derived name.',
    };
  }

  return { kind: 'ours' };
}

// --- I/O leaves (injectable) ---

/** Real `gh api repos/<repo> --jq {archived}`. A confident 404 is `'absent'`; any other failure (auth/network/rate-limit/`gh` missing) degrades to `'unknown'` — NEVER throws. Reads `.archived` in the SAME call as existence (one round trip, not two) so the archived-repo classification above is cheap. */
export async function checkControlRepoMeta(repo: string): Promise<ControlRepoMeta> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', `repos/${repo}`, '--jq', '{archived: .archived}'], { encoding: 'utf-8' });
    const parsed: unknown = JSON.parse(stdout);
    const archived =
      typeof parsed === 'object' && parsed !== null && 'archived' in parsed && typeof (parsed as { archived: unknown }).archived === 'boolean'
        ? (parsed as { archived: boolean }).archived
        : undefined;
    return { presence: 'present', archived };
  } catch (err) {
    const stderr = getStderr(err);
    if (/HTTP 404|Not Found/i.test(stderr)) return { presence: 'absent' };
    return { presence: 'unknown' };
  }
}

/** Real raw-content read of `fleet.yaml` off the repo's default branch via the GitHub raw media type (no base64 decode needed). `undefined` on ANY failure (missing file, private-repo-without-content-scope, network) — NEVER throws. */
export async function realReadControlManifestFile(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${repo}/contents/fleet.yaml`, '-H', 'Accept: application/vnd.github.raw'],
      { encoding: 'utf-8' },
    );
    return stdout;
  } catch {
    return undefined;
  }
}

export interface ControlRepoDeps {
  readonly checkMeta: (repo: string) => Promise<ControlRepoMeta>;
  readonly readManifestFile: (repo: string) => Promise<string | undefined>;
  readonly createRepo: CreateRepoFn;
  readonly cloneRepo: (url: string, destDir: string) => Promise<void>;
  readonly commitAndPush: (dir: string, message: string) => Promise<'pushed' | 'nothing-to-commit'>;
}

export interface ControlRepoOptions {
  readonly cloneUrl?: (repo: string) => string;
  readonly scratchDirPrefix?: string;
  readonly commitMessage?: (repo: string) => string;
  /** Injectable so tests get a deterministic checkout dir instead of a fresh `mkdtemp` each run. Defaults to `mkdtempSync(tmpdir(), prefix)`. */
  readonly makeScratchDir?: (prefix: string) => string;
}

export type ControlRepoOutcome =
  | { readonly status: 'created'; readonly repo: string; readonly localDir: string }
  | { readonly status: 'reused'; readonly repo: string; readonly localDir: string }
  | { readonly status: 'foreign'; readonly repo: string; readonly reason: string }
  | { readonly status: 'failed'; readonly repo: string; readonly reason: string };

function defaultCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

function defaultCommitMessage(repo: string): string {
  return `chore(bootstrap): commit fleet.yaml — control repo first act (DR-043 Amendment F, ${repo})`;
}

/**
 * Read the manifest's ORIGINAL source text (byte-identical — preserves
 * comments/formatting) from `manifestPath` for the control repo's first
 * commit. Falls back to re-serializing the already-PARSED `manifest` object
 * via `yaml.stringify` when the path isn't readable (e.g. a manifest built
 * in-memory for a test, never written to disk — the common shape across
 * this package's existing `apply-fleet.ts` test suite, which constructs
 * `FleetManifest` objects directly rather than round-tripping them through a
 * file). Production always hits the byte-identical path — `manifestPath` was
 * literally the file `runBootstrapApply` just read.
 */
function readManifestSourceOrFallback(manifest: FleetManifest, manifestPath: string): string {
  try {
    return readFileSync(manifestPath, 'utf-8');
  } catch {
    return stringifyYaml(manifest);
  }
}

/**
 * Provision `<fleet>-control` — the FIRST mutating step of an apply run (see
 * module doc). NEVER throws (the whole body is one try/catch — a throwing
 * `checkMeta`/`readManifestFile` resolves to `status: 'failed'` the same as
 * a throwing `createRepo`/`cloneRepo`/`commitAndPush`); every failure
 * resolves into a `foreign` or `failed` {@link ControlRepoOutcome} for the
 * caller to abort on.
 *
 * - `absent` → `gh repo create` (no template — see `repo-create.ts`'s doc:
 *   the control repo holds only GitOps state, never agent-workspace
 *   content) → clone the (empty) repo → write + commit + push `fleet.yaml`
 *   as the repo's first act (Amendment F: "commits the manifest into it as
 *   its first act ... the local file is bootstrap input; the committed copy
 *   is the GitOps record").
 * - `ours` → clone the EXISTING repo (brings back whatever a prior `apply`
 *   already committed — `fleet.lock`, `vault.age`, if this isn't the first
 *   run) → return `reused`. Does NOT re-commit `fleet.yaml` — day-2
 *   reconciliation of a changed local manifest against an already-live
 *   control repo is out of THIS increment's scope (Amendment D's phasing;
 *   see `apply-fleet.ts`'s module doc for the residual this leaves).
 * - `foreign` / `unknown` → no repo is created, nothing is cloned; the
 *   caller (`apply-fleet.ts`) aborts the ENTIRE run before any consent gate.
 */
export async function provisionControlRepo(
  manifest: FleetManifest,
  manifestPath: string,
  deps: ControlRepoDeps,
  opts?: ControlRepoOptions,
): Promise<ControlRepoOutcome> {
  const repo = controlRepoFullName(manifest);
  try {
    const meta = await deps.checkMeta(repo);
    const manifestFileContent = meta.presence === 'present' && meta.archived !== true ? await deps.readManifestFile(repo) : undefined;
    const ownership = classifyControlRepoOwnership(meta, manifestFileContent, manifest);

    if (ownership.kind === 'foreign') {
      return {
        status: 'foreign',
        repo,
        reason: `"${repo}" already exists but was not created by this apply for fleet "${manifest.metadata.name}" (DR-043 Amendment F — control repos are never silently adopted): ${ownership.reason}`,
      };
    }
    if (ownership.kind === 'unknown') {
      return {
        status: 'failed',
        repo,
        reason: `could not confirm whether "${repo}" already exists (auth / network / rate-limit) — refusing to create OR reuse a control repo without a confident existence read. Re-run once the check can complete.`,
      };
    }

    const cloneUrl = opts?.cloneUrl ?? defaultCloneUrl;
    const makeScratchDir = opts?.makeScratchDir ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)));
    const localDir = makeScratchDir(opts?.scratchDirPrefix ?? 'macf-bootstrap-control-');
    // `mkdtempSync` (the default `makeScratchDir`) already creates the dir;
    // this is defense for an injected fake that returns a not-yet-existing
    // path (idempotent — `recursive: true` no-ops on an existing dir).
    mkdirSync(localDir, { recursive: true });

    if (ownership.kind === 'absent') {
      await deps.createRepo(repo);
    }
    await deps.cloneRepo(cloneUrl(repo), localDir);

    if (ownership.kind === 'absent') {
      const manifestYaml = readManifestSourceOrFallback(manifest, manifestPath);
      writeFileSync(join(localDir, 'fleet.yaml'), manifestYaml, 'utf-8');
      await deps.commitAndPush(localDir, (opts?.commitMessage ?? defaultCommitMessage)(repo));
      return { status: 'created', repo, localDir };
    }
    return { status: 'reused', repo, localDir };
  } catch (err) {
    return { status: 'failed', repo, reason: errMessage(err) };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
