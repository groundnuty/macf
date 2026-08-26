/**
 * GitHub-plane I/O leaf for `macf routing doctor` (DR-030 phase-2, macf#568).
 *
 * Isolates the `gh` shell-outs the routing-infra checks need so the orchestration
 * in `routing-doctor.ts` stays PURE + offline-testable (production wires these;
 * tests inject fakes). Every call here is a READ:
 *
 *   - `listInstallRepos`     — the App INSTALL-SET (DR-030 Q3 repo-set source):
 *                              `gh api /installation/repositories`. NOT a new
 *                              `fleet.repos` config file (no parallel, drift-prone
 *                              surface) — derived from an existing GitHub surface.
 *   - `readCallerPin`        — a repo's `.github/workflows/agent-router.yml`
 *                              `uses: groundnuty/macf-actions/...@<pin>` line.
 *   - `readRoutingConfigGh`  — a repo's `.github/agent-config.json` (the router's
 *                              per-label config), via the GitHub contents API.
 *                              `createRoutingConfigGhReaderDetailed` (macf#1193)
 *                              is the primary implementation — a discriminated
 *                              `RoutingConfigReadResult` distinguishing absent
 *                              / malformed / read-failed, consumed by the
 *                              per-repo artifact sweep (`readRoutingConfigForRepo`);
 *                              `createRoutingConfigGhReader` is a thin wrapper
 *                              collapsing that back to `RoutingConfig | null`
 *                              for the two callers (the current-repo fallback,
 *                              `routing-e2e.ts`) that never needed the
 *                              distinction.
 *   - `readFleetMarker`      — a repo's `.github/macf-fleet.json` opt-OUT marker
 *                              (#614): a pinned repo declares itself non-fleet here so
 *                              it is excluded from `pins_consistent`. Self-declaration
 *                              that lives WITH the repo — no central allowlist.
 *   - `readFleetManifestYaml` — a repo's committed `fleet.yaml` raw text (macf#872),
 *                              read off whichever repo the caller has already
 *                              identified as the fleet's control repo (DR-043
 *                              Amendment F). Same raw-content-media-type shape as
 *                              `bootstrap/control-repo.ts::realReadControlManifestFile`,
 *                              but token-scoped to the MINTED registry token (not
 *                              ambient `GH_TOKEN`) for DI/testability consistency
 *                              with every other reader in this file — deliberately
 *                              NOT a re-export of that function.
 *   - `listRepoLabels`       — a repo's label names (macf#1191's assignment-label
 *                              routing-artifact check): `gh api repos/<repo>/labels`.
 *                              `null` on ANY failure. Deliberately does NOT try to
 *                              tell "this caller cannot see the repo" apart from
 *                              "the repo genuinely has none" — GitHub returns the
 *                              same 404 whether a repo is private-and-uninstalled,
 *                              nonexistent, or misnamed (private repos are not
 *                              enumerable, by design), so there is no status-code
 *                              or other discriminator to build here. The caller
 *                              (`routing-doctor.ts::evaluateRoutingArtifact`) reports
 *                              any `null` as `not-visible`, never as a confirmed
 *                              `missing` — collapsing them would reproduce, one
 *                              level down, the exact false-negative macf#1191 exists
 *                              to eliminate.
 *
 * The token is forwarded as `GH_TOKEN` in the subprocess env (the house auth
 * posture); none of these has a write path. `listRepoLabels` in particular is
 * READ-ONLY by design and must stay that way — see the WHY-comment on
 * `buildArtifactChecks` in `routing-doctor.ts` for why this command must never
 * gain a label-creation path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CallerPinResult, FleetMarker, RoutingConfig, RoutingConfigReadResult } from './routing-doctor.js';

const execFileAsync = promisify(execFile);

/** The macf-actions caller `uses:` reference we look for in agent-router.yml. */
const ACTIONS_USES_RE =
  /uses:\s*groundnuty\/macf-actions\/\.github\/workflows\/agent-router\.yml@(\S+)/;

/** Decode a GitHub contents-API `.content` base64 blob (newline-wrapped). */
function decodeGhContent(b64: string): string {
  return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf-8');
}

/**
 * Best-effort extraction of a caught `execFile` error's captured stderr — the
 * SAME 404-vs-other-failure discrimination `bootstrap/control-repo.ts::checkControlRepoMeta`
 * uses (macf#1193), duplicated locally rather than imported across the
 * `commands/` / `bootstrap/` subsystem boundary: a tiny pure helper, kept
 * per-subsystem, is the SAME precedent `bootstrap/manifest-exchange.ts` already
 * sets for this exact function (it has its own private copy rather than
 * importing `bootstrap/observer.ts`'s exported one).
 */
function getStderr(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const s = (err as { readonly stderr?: unknown }).stderr;
    if (typeof s === 'string') return s;
  }
  return '';
}

/**
 * List the App installation's repo-set (DR-030 Q3). Uses the installation token
 * we already mint for the registry reads — `/installation/repositories` returns
 * exactly the repos that token can act on, which IS the routing fleet (an agent
 * unreachable through GitHub can't be in the fleet). Returns `owner/repo` full
 * names. NEVER throws — an access/auth failure resolves to `[]` so the command
 * degrades to "0 fleet repos discovered" rather than crashing.
 */
export function createInstallRepoLister(token: string): () => Promise<readonly string[]> {
  const env = { ...process.env, GH_TOKEN: token };
  return async () => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', '--paginate', '/installation/repositories', '--jq', '.repositories[].full_name'],
        { encoding: 'utf-8', env, maxBuffer: 32 * 1024 * 1024 },
      );
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
  };
}

/**
 * Read one repo's caller-pin from `.github/workflows/agent-router.yml`. Returns a
 * tri-status result:
 *   - `pinned`      — the file exists AND references `groundnuty/macf-actions@<pin>`.
 *   - `no-workflow` — the file is absent OR has no macf-actions `uses:` (the repo
 *                     is App-installed but NOT a routing caller — e.g. the registry
 *                     owner-repo, or macf-actions itself). Excluded from the
 *                     consistency verdict (not a divergence).
 *   - `error`       — the read failed for another reason.
 * NEVER throws.
 */
export function createCallerPinReader(token: string): (repo: string) => Promise<CallerPinResult> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string): Promise<CallerPinResult> => {
    let content: string;
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${repo}/contents/.github/workflows/agent-router.yml`, '--jq', '.content'],
        { encoding: 'utf-8', env, maxBuffer: 8 * 1024 * 1024 },
      );
      content = decodeGhContent(stdout);
    } catch {
      // 404 (no workflow) is the overwhelmingly common case; treat any read
      // failure as "not a routing caller" rather than a hard error so a single
      // non-caller repo in the install-set doesn't poison the sweep.
      return { repo, pin: null, status: 'no-workflow' };
    }
    const m = ACTIONS_USES_RE.exec(content);
    if (!m) return { repo, pin: null, status: 'no-workflow' };
    return { repo, pin: m[1]!, status: 'pinned' };
  };
}

/**
 * Read one repo's `.github/agent-config.json` (the router's per-label config)
 * via the GitHub contents API, discriminating WHY a read didn't yield a
 * usable config (macf#1193). See `RoutingConfigReadResult`'s doc in
 * `routing-doctor.ts` for the full rationale behind the four states; in
 * short: `absent` (a confident 404 on this ALREADY known-visible repo) is
 * silently skipped by the caller, `malformed` (present but broken) is a
 * confirmed defect, `read-failed` (network/rate-limit/transient) is a
 * genuine unknown. NEVER throws.
 *
 * The `read-failed` / `malformed` `reason` is a SHORT FIXED phrase, never the
 * raw `gh` stderr — that text can be multi-line, and interpolating arbitrary
 * subprocess output into a `reason` that lands in a rendered table AND a
 * `--json` payload is exactly the kind of thing the "never log credential
 * material" discipline exists to keep out of user-facing surfaces, even
 * though a 404/network error is not itself expected to carry secrets.
 */
export function createRoutingConfigGhReaderDetailed(
  token: string,
): (repo: string) => Promise<RoutingConfigReadResult> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string): Promise<RoutingConfigReadResult> => {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${repo}/contents/.github/agent-config.json`, '--jq', '.content'],
        { encoding: 'utf-8', env, maxBuffer: 8 * 1024 * 1024 },
      ));
    } catch (err) {
      const stderr = getStderr(err);
      // WHY (macf#1193): `repo` here is always drawn from THIS run's App
      // install-set — already known-visible to this caller — so a confident
      // 404 unambiguously means "no such file," not "can't see this repo."
      // See `RoutingConfigReadResult`'s `absent` doc for the full argument.
      if (/HTTP 404|Not Found/i.test(stderr)) {
        return { status: 'absent' };
      }
      return { status: 'read-failed', reason: 'network, rate-limit, or a transient gh api failure' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeGhContent(stdout));
    } catch {
      return { status: 'malformed', reason: 'content is not valid JSON' };
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as RoutingConfig).agents !== 'object' ||
      (parsed as RoutingConfig).agents === null
    ) {
      return { status: 'malformed', reason: 'missing or invalid "agents" object' };
    }
    return { status: 'present', config: parsed as RoutingConfig };
  };
}

/**
 * Back-compat collapse of {@link createRoutingConfigGhReaderDetailed} to the
 * plain `RoutingConfig | null` contract `readRoutingConfig` (the CURRENT-repo
 * fallback, see `resolveDepsFromRegistry`) and `routing-e2e.ts` rely on —
 * neither of those callers needed the absent/malformed/read-failed
 * distinction macf#1193 introduced specifically for the artifact sweep
 * (`readRoutingConfigForRepo`); for them, all three collapse to "no usable
 * config," same as before.
 */
export function createRoutingConfigGhReader(
  token: string,
): (repo: string) => Promise<RoutingConfig | null> {
  const detailed = createRoutingConfigGhReaderDetailed(token);
  return async (repo: string): Promise<RoutingConfig | null> => {
    const result = await detailed(repo);
    return result.status === 'present' ? result.config : null;
  };
}

/**
 * Read one repo's `.github/macf-fleet.json` opt-OUT marker (#614) via the GitHub
 * contents API. Returns the parsed marker, or `null` (absent / unreadable / malformed
 * — all of which mean "no opt-out" → the repo stays a fleet member per `isFleetMember`,
 * the safe over-checking direction). A 404 (no marker file) is the overwhelmingly common
 * case. NEVER throws.
 */
export function createFleetMarkerReader(
  token: string,
): (repo: string) => Promise<FleetMarker | null> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string): Promise<FleetMarker | null> => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${repo}/contents/.github/macf-fleet.json`, '--jq', '.content'],
        { encoding: 'utf-8', env, maxBuffer: 1 * 1024 * 1024 },
      );
      const parsed = JSON.parse(decodeGhContent(stdout)) as FleetMarker;
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  };
}

/**
 * Read `fleet.yaml`'s raw text off a given repo's default branch (macf#872), via
 * the GitHub raw-content media type (no base64 decode needed — same wire shape as
 * `bootstrap/control-repo.ts::realReadControlManifestFile`). The caller (routing-
 * doctor-pin-correctness.ts) supplies the repo — this function does NOT derive or
 * discover which repo is the fleet's control repo, keeping the gh-shell-out leaf
 * ignorant of DR-043 naming conventions. `null` on ANY failure (missing file — the
 * overwhelmingly common case for a fleet with no control repo yet, or one not
 * bootstrapped via `macf bootstrap apply` at all — private-repo-without-content-
 * scope, network). NEVER throws.
 */
export function createFleetManifestReader(token: string): (repo: string) => Promise<string | null> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${repo}/contents/fleet.yaml`, '-H', 'Accept: application/vnd.github.raw'],
        { encoding: 'utf-8', env, maxBuffer: 1 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      return null;
    }
  };
}

/**
 * List a repo's label names (macf#1191's assignment-label routing-artifact
 * check). `null` on ANY read failure — inaccessible, deleted, network, or
 * anything else. This is a DELIBERATE non-decision: GitHub's API returns the
 * identical 404 whether a repo doesn't exist, is private with this caller's
 * App not installed there, or was simply misnamed (private repos must not be
 * enumerable, so the API cannot afford to distinguish "forbidden" from
 * "not found" without leaking existence) — there is no reliable signal here
 * to build a finer-grained discriminator on, and guessing one back in would
 * silently misreport a "cannot see" as a confirmed "missing," which is
 * exactly the false-negative macf#1191 exists to eliminate. An empty array
 * IS a meaningful, distinct result (the repo was read successfully and
 * genuinely has zero labels) — only a thrown/rejected read collapses to
 * `null`. NEVER throws.
 */
export function createRepoLabelLister(token: string): (repo: string) => Promise<readonly string[] | null> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string): Promise<readonly string[] | null> => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', '--paginate', `repos/${repo}/labels`, '--jq', '.[].name'],
        { encoding: 'utf-8', env, maxBuffer: 8 * 1024 * 1024 },
      );
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return null;
    }
  };
}
