/**
 * GitHub App-manifest generation for `macf bootstrap apply` (DR-043 §D2,
 * Slice 2b of groundnuty/macf#838).
 *
 * The App-manifest flow is the ONLY way to create a GitHub App programmatically
 * (there is no create-App REST endpoint): the CLI serves a self-submitting form
 * POSTing this manifest to GitHub, the operator clicks **Create** — consent gate
 * 1 of exactly two (§D2) — and GitHub redirects to `redirect_url` with a
 * temporary `code` the CLI exchanges for `app_id` + client id/secret + webhook
 * secret + **the private-key PEM**.
 *
 * **Permissions are DERIVED from {@link MACF_REQUIRED_PERMISSIONS}, never
 * re-listed here.** That constant is the DR-019 doctrine `macf doctor` verifies
 * a live installation against, so deriving the manifest from it makes
 * "created-with" and "verified-against" the same set by construction — a
 * third hand-maintained copy (alongside the DR + `templates/macf-app-manifest.json`)
 * could silently drift, and the failure mode is a fleet-wide 401-that-falls-back-
 * to-user-auth (the attribution trap, macf#72). Any DR-019 amendment now
 * reaches provisioning automatically.
 */
import { MACF_REQUIRED_PERMISSIONS } from '../commands/doctor.js';
import { deriveAppHandle } from './fleet-manifest.js';

/**
 * Coordination surfaces a MACF agent reacts to. Mirrors
 * `templates/macf-app-manifest.json`'s `default_events` — issues (labels are
 * the routing signal) + issue comments (the @mention surface) + PRs and PR
 * reviews (the review loop, incl. `route-by-pr-review-state`).
 */
export const MACF_APP_DEFAULT_EVENTS: readonly string[] = [
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
];

/** The GitHub App-manifest document POSTed to `/settings/apps/new`. */
export interface GitHubAppManifest {
  readonly name: string;
  readonly url: string;
  readonly hook_attributes: { readonly url: string; readonly active: boolean };
  readonly redirect_url: string;
  readonly public: boolean;
  readonly default_permissions: Readonly<Record<string, string>>;
  readonly default_events: readonly string[];
}

export interface BuildAppManifestOptions {
  /** `metadata.name` from fleet.yaml — the fleet/project name. */
  readonly fleetName: string;
  /** The agent's `role` (DR-032 name shape). The App handle is DERIVED from these two. */
  readonly role: string;
  /** Where GitHub sends the temporary `code` — the CLI's ephemeral localhost listener. */
  readonly redirectUrl: string;
  /** Homepage shown on the App page. Defaults to the agent's home repo URL when given. */
  readonly homepageUrl?: string;
  /**
   * Override {@link MACF_REQUIRED_PERMISSIONS} (groundnuty/macf#943) — the
   * ONLY caller that supplies this today is the runner-ops App
   * (`apply-runner-ops.ts`), whose permission set is deliberately
   * DR-019-DISJOINT (no coordination-agent permission includes
   * `administration`, and DR-019 was never widened to add it — see that
   * module's doc for why). Every ordinary agent App omits this and keeps
   * getting the derived-from-DR-019 set, byte-identical to before this field
   * existed.
   */
  readonly permissions?: Readonly<Record<string, string>>;
  /**
   * Override {@link MACF_APP_DEFAULT_EVENTS} (groundnuty/macf#943). The
   * runner-ops App subscribes to `[]` — it has none of the
   * `issues`/`pull_requests`/`contents` read permissions the default events
   * need, so declaring them would be a manifest inconsistency for an App that
   * never coordinates. Every ordinary agent App omits this.
   */
  readonly events?: readonly string[];
  /**
   * Override the derived `name` (groundnuty/macf#1082, owner-keyed per
   * groundnuty/macf#1088) — the ONLY caller that supplies this is the router
   * App's SHARED-scope path (`apply-router-app.ts::routerAppIdentityRequest`),
   * whose whole point is a name that is NOT fleet-prefixed (`deriveAppHandle`
   * always prepends `fleetName`, which can never produce the owner-scoped,
   * cross-fleet-recognizable name `apply-router-app.ts::deriveRouterAppHandle`
   * derives for the shared scope). `undefined` (every other caller — every
   * ordinary agent App, runner-ops, and the router App's own PER-FLEET
   * scope) keeps the derived `deriveAppHandle(fleetName, role)` name,
   * byte-identical to before this field existed.
   */
  readonly nameOverride?: string;
}

/**
 * Build the App manifest for one fleet agent. Pure — no I/O, no clock, no
 * randomness — so the exact document that will be submitted is renderable by
 * `apply --dry-run` before any consent gate is opened.
 *
 * The App `name` is `opts.nameOverride ?? deriveAppHandle(fleetName, role)` —
 * `deriveAppHandle` is still the single derivation point for every FLEET-
 * SCOPED handle (macf#791 double-prefix trap); `nameOverride` exists only for
 * an identity whose name must NOT be fleet-scoped (see that field's doc).
 * Webhooks are created INACTIVE: MACF routing is pull/dispatch-based via the
 * router workflow, not an inbound webhook receiver, so an active hook would
 * point at a placeholder URL and generate delivery failures.
 */
export function buildAppManifest(opts: BuildAppManifestOptions): GitHubAppManifest {
  const permissions: Record<string, string> = {};
  if (opts.permissions !== undefined) {
    Object.assign(permissions, opts.permissions);
  } else {
    for (const p of MACF_REQUIRED_PERMISSIONS) {
      permissions[p.name] = p.level;
    }
  }
  return {
    name: opts.nameOverride ?? deriveAppHandle(opts.fleetName, opts.role),
    url: opts.homepageUrl ?? 'https://github.com/groundnuty/macf',
    hook_attributes: { url: 'https://example.com/webhook', active: false },
    redirect_url: opts.redirectUrl,
    public: false,
    default_permissions: permissions,
    default_events: opts.events !== undefined ? [...opts.events] : [...MACF_APP_DEFAULT_EVENTS],
  };
}

/**
 * Convenience: the `https://github.com/<owner>/<repo>` homepage for an agent's
 * home repo (`agents[].repo` is already `owner/repo`).
 */
export function repoHomepageUrl(repo: string): string {
  return `https://github.com/${repo}`;
}
