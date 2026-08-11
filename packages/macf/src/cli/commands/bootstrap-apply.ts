/**
 * `macf bootstrap apply` (DR-043 §D2/§D3, Slice 2b of groundnuty/macf#838).
 *
 * **Increment 1 — `--dry-run` only.** This lands the pre-consent surface: it
 * computes the same read-only plan `bootstrap plan` produces, then renders the
 * EXACT GitHub App-manifest documents that would be submitted at consent gate 1.
 * Mutation (the localhost manifest exchange, install-poll, vault write-through,
 * `fleet.lock`, repo-init) lands in the following increments.
 *
 * A non-`--dry-run` invocation FAILS LOUD rather than silently doing nothing —
 * "ran and changed nothing" while reporting success is the silent-fallback
 * shape this codebase exists to avoid.
 *
 * The dry-run render is also the DR-035 §4 **plan-approve-once** artifact: the
 * operator sees the full blast radius (which Apps, which permissions, which
 * repos) in one place BEFORE any browser consent gate opens.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { deriveAppHandle, parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { FleetObserverFn, FleetPlan, FleetPlanFailure } from '../bootstrap/plan.js';
import { computePlan, fleetPlanFailureToJson, fleetPlanToJson, formatPlanText } from '../bootstrap/plan.js';
import { githubRegistryObserver } from '../bootstrap/observer.js';
import type { GitHubAppManifest } from '../bootstrap/app-manifest.js';
import { buildAppManifest, repoHomepageUrl } from '../bootstrap/app-manifest.js';

/**
 * The redirect URL shown in a dry-run. The REAL one carries the ephemeral
 * listener's port, chosen at exchange time (increment 2) — a dry run binds
 * nothing, so it renders this placeholder rather than pretending to hold a port.
 */
export const DRY_RUN_REDIRECT_PLACEHOLDER = 'http://localhost:<port-chosen-at-apply-time>/callback';

export interface RunBootstrapApplyOptions {
  readonly file: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export interface BootstrapApplyDeps {
  readonly observe: FleetObserverFn;
}

/** One agent's would-be App creation, paired with the plan item that motivated it. */
export interface PlannedAppCreation {
  readonly role: string;
  readonly repo: string;
  readonly manifest: GitHubAppManifest;
}

/**
 * Which agents would get an App created, given a computed plan. Pure. An agent
 * whose `app` item is `noop` is NOT re-created — the confirm-before-create
 * guard (increment 3, reusing `confirmAppInstallation`) additionally re-checks
 * live before any create actually fires.
 */
export function plannedAppCreations(
  manifest: FleetManifest,
  plan: FleetPlan,
  redirectUrl: string,
): readonly PlannedAppCreation[] {
  const creating = new Set(
    plan.items.filter((i) => i.kind === 'app' && i.verb === 'create').map((i) => i.target),
  );
  const out: PlannedAppCreation[] = [];
  for (const agent of manifest.agents) {
    // Reconstruct `appItem`'s EXACT target (`agent:<role>:app:<handle>`) rather
    // than prefix-scanning: O(1), states the intent, and cannot rot if the
    // target shape ever grows a suffix (macf#842 review nit).
    const target = `agent:${agent.role}:app:${deriveAppHandle(manifest.metadata.name, agent.role)}`;
    if (!creating.has(target)) continue;
    out.push({
      role: agent.role,
      repo: agent.repo,
      manifest: buildAppManifest({
        fleetName: manifest.metadata.name,
        role: agent.role,
        redirectUrl,
        homepageUrl: repoHomepageUrl(agent.repo),
      }),
    });
  }
  return out;
}

/** Human render of the would-be App creations (pure — exported for tests). */
export function formatPlannedAppCreations(creations: readonly PlannedAppCreation[]): string {
  if (creations.length === 0) {
    return 'No GitHub Apps would be created (every declared agent already has one, or presence is confirmed).';
  }
  const parts: string[] = [
    `GitHub Apps that would be created (${String(creations.length)}) — consent gate 1 (§D2), one operator click each:`,
    '',
  ];
  for (const c of creations) {
    parts.push(`  • ${c.manifest.name}   (role: ${c.role}, home repo: ${c.repo})`);
    const perms = Object.entries(c.manifest.default_permissions)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    parts.push(`      permissions (DR-019): ${perms}`);
    parts.push(`      events: ${c.manifest.default_events.join(', ')}`);
    parts.push(`      public: ${String(c.manifest.public)}   webhook active: ${String(c.manifest.hook_attributes.active)}`);
  }
  return parts.join('\n');
}

function renderFailure(failure: FleetPlanFailure, opts: RunBootstrapApplyOptions): number {
  console.error(failure.message);
  if (opts.json) {
    console.log(JSON.stringify(fleetPlanFailureToJson(failure), null, 2));
  }
  return 1;
}

/**
 * `macf bootstrap apply -f fleet.yaml --dry-run [--json]`.
 *
 * Returns the shell exit code. Non-`--dry-run` returns 1 with an explicit
 * not-implemented diagnostic (never a silent success). NEVER exits the process
 * directly; every failure path renders through {@link renderFailure}.
 */
export async function runBootstrapApply(
  opts: RunBootstrapApplyOptions,
  deps?: BootstrapApplyDeps,
): Promise<number> {
  if (opts.dryRun !== true) {
    return renderFailure(
      {
        code: 'apply_not_implemented',
        message:
          'macf bootstrap apply: mutating apply is not implemented yet (DR-043 Slice 2b is landing ' +
          'incrementally — see groundnuty/macf#838). Re-run with --dry-run to see the full plan plus the ' +
          'exact GitHub App manifests that would be submitted. Refusing to exit 0 without doing anything.',
      },
      opts,
    );
  }

  const manifestPath = resolvePath(opts.file);
  if (!existsSync(manifestPath)) {
    return renderFailure({ code: 'manifest_not_found', message: `fleet manifest not found: ${manifestPath}` }, opts);
  }

  let manifest: FleetManifest;
  try {
    manifest = parseFleetManifest(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return renderFailure(
      {
        code: 'manifest_invalid',
        message: `fleet manifest failed validation: ${err instanceof Error ? err.message : String(err)}`,
      },
      opts,
    );
  }

  const resolved = deps ?? { observe: (m: FleetManifest) => githubRegistryObserver(m, manifestPath) };

  try {
    const observed = await resolved.observe(manifest);
    const plan = computePlan(manifest, observed);
    const creations = plannedAppCreations(manifest, plan, DRY_RUN_REDIRECT_PLACEHOLDER);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ...(fleetPlanToJson(plan) as Record<string, unknown>),
            dry_run: true,
            planned_app_creations: creations.map((c) => ({ ...c })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(formatPlanText(plan));
      console.log('');
      console.log(formatPlannedAppCreations(creations));
      console.log('');
      console.log('DRY RUN — nothing was created, changed, or submitted.');
    }
    return 0;
  } catch (err) {
    return renderFailure(
      { code: 'unexpected_error', message: err instanceof Error ? err.message : String(err) },
      opts,
    );
  }
}
