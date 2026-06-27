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
 *   - `readFleetMarker`      — a repo's `.github/macf-fleet.json` opt-OUT marker
 *                              (#614): a pinned repo declares itself non-fleet here so
 *                              it is excluded from `pins_consistent`. Self-declaration
 *                              that lives WITH the repo — no central allowlist.
 *
 * The token is forwarded as `GH_TOKEN` in the subprocess env (the house auth
 * posture); none of these has a write path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CallerPinResult, FleetMarker, RoutingConfig } from './routing-doctor.js';

const execFileAsync = promisify(execFile);

/** The macf-actions caller `uses:` reference we look for in agent-router.yml. */
const ACTIONS_USES_RE =
  /uses:\s*groundnuty\/macf-actions\/\.github\/workflows\/agent-router\.yml@(\S+)/;

/** Decode a GitHub contents-API `.content` base64 blob (newline-wrapped). */
function decodeGhContent(b64: string): string {
  return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf-8');
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
 * Read one repo's `.github/agent-config.json` (the router's per-label config) via
 * the GitHub contents API. Returns the parsed config or `null` (absent / unreadable
 * / malformed). NEVER throws.
 */
export function createRoutingConfigGhReader(
  token: string,
): (repo: string) => Promise<RoutingConfig | null> {
  const env = { ...process.env, GH_TOKEN: token };
  return async (repo: string): Promise<RoutingConfig | null> => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${repo}/contents/.github/agent-config.json`, '--jq', '.content'],
        { encoding: 'utf-8', env, maxBuffer: 8 * 1024 * 1024 },
      );
      const parsed = JSON.parse(decodeGhContent(stdout)) as RoutingConfig;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.agents !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
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
