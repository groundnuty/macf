/**
 * `macf bootstrap apply`'s DR-043 §D2 "honest completion" report
 * (groundnuty/macf#1014) — split out of #1013 on review. Same family as
 * #979 (`deploy` printed "Next step" for an agent with no cert), #987
 * (`0 created, 0 already-present of 2 confirmed` and the run proceeded), and
 * #999 (a whole fleet provisioned whose registry no agent could read): each
 * reports success while the outcome is incomplete, with nothing surfacing
 * the gap. `apply` provisions every GitHub-side resource and exits 0 without
 * ever mentioning that **no agent has a workspace yet** — the fleet is
 * provisioned but inert until `macf fleet deploy` runs per agent. This
 * module computes that gap and the exact remedy command; it does NOT change
 * what `apply` provisions, its ordering, or its exit code (requirement 3 —
 * an un-deployed fleet is not an `apply` failure, this is honest reporting).
 *
 * **Deliberately cheap.** A filesystem existence check against each
 * declared agent's `deploy_path`, nothing more — no new GitHub probe, no
 * vault decrypt. Mirrors `commands/bootstrap-apply.ts::findAvailableRecoveryArtifacts`'s
 * existence-only posture (same file, same "existence, never decrypt"
 * discipline).
 *
 * **"not-deployed" vs "unknown" — a judgment call (macf#1014 explicitly
 * invites one; explicitly forbids a new manifest schema field for it).**
 * `apply` runs on ONE machine. In a multi-host fleet, a `deploy_path`
 * belonging to a DIFFERENT host is unknowable from here, not absent — the
 * same DR-043 Amendment A honest-`unknown` floor the GitHub-API surface
 * already applies ("the API can confirm present, never prove absent"),
 * generalized to the filesystem surface. A bare `existsSync(deploy_path) ===
 * false` cannot, by itself, distinguish "never deployed" from "deployed on
 * a different host" — both look identical to a local check, so reporting
 * every miss as "not deployed" would be exactly the kind of confident-but-
 * unverifiable claim `verify-before-claim.md` warns against.
 *
 * The signal used here: check `deploy_path`'s PARENT directory too.
 *   - Parent exists, leaf doesn't → this host's directory structure clearly
 *     matches where the fleet's workspaces live (the operator's own
 *     `workspaces/`-style tree is present) — confidently "not deployed
 *     HERE, and HERE is exactly where it would go."
 *   - Parent ALSO doesn't exist → no local corroborating evidence this path
 *     was ever meant for this host at all — `unknown`, never `not-deployed`.
 * This is a heuristic, not a proof — documented here rather than silently
 * assumed, per the issue's own invitation to state the choice and why. Even
 * on the `not-deployed` branch, the rendered text is host-scoped ("...on
 * this host") rather than a fleet-wide claim — on a homogeneous multi-host
 * fleet (every VM has the same `/home/<user>/...` layout) the parent-exists
 * signal is satisfied on EVERY host, so "not deployed" can only ever mean
 * "not deployed here"; it must never read as "not deployed anywhere."
 *
 * **The other-host note (review finding, macf#1014).** When `apply` was NOT
 * given `--vault`, the constructed `deploy` command omits it too, so `deploy`
 * defaults to `<dirname(-f)>/secrets/vault.age`. {@link vaultLocationNote}
 * tells the operator how to place `fleet.yaml` and the vault on another host.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { FleetManifest } from './fleet-manifest.js';

/**
 * Placeholder rendered in a deploy command's `--identity-key` when `apply`
 * itself was NOT given `--identity-key` (the common case for a first
 * provision — writing a fresh vault only needs the recipients' PUBLIC keys,
 * never a private identity, so `apply` frequently has no real path to echo).
 * Mirrors `commands/bootstrap-apply.ts::DRY_RUN_REDIRECT_PLACEHOLDER`'s
 * "render a placeholder rather than pretending to hold a value" convention.
 *
 * **Deliberately NOT angle-bracket-wrapped** (`<path-to-...>`) — this string
 * is pasted directly into a shell command the operator is meant to copy
 * verbatim; `<...>` is a bash input-redirection operator, so an
 * angle-bracketed placeholder silently redirects stdin from a nonexistent
 * file instead of producing the "supply a real value" failure a plain
 * missing-argument would. An UPPER_SNAKE_CASE token carries no shell
 * metacharacters and is unambiguous as "replace me."
 */
export const DEPLOY_IDENTITY_KEY_PLACEHOLDER = 'PATH_TO_YOUR_AGE_IDENTITY_KEY';

/** The `--vault`/`--identity-key` flags `apply` was itself invoked with — echoed verbatim into the constructed `fleet deploy` command (requirement 1), never re-derived from where a vault actually landed this run (that location is an ephemeral scratch checkout — see `apply-fleet.ts`'s module doc — not a stable path to hand an operator). */
export interface DeployFlagsEcho {
  readonly vaultPath?: string;
  readonly identityKeyPath?: string;
}

export type RemainingDeployPresence = 'not-deployed' | 'unknown';

export interface RemainingDeployStep {
  readonly role: string;
  /** Resolved absolute path (`path.resolve`) — the SAME resolution `commands/fleet-deploy.ts::runFleetDeploy` applies to `agent.deploy_path` when `--dir` is omitted, so this never disagrees with what `deploy` itself would target. */
  readonly deployPath: string;
  readonly presence: RemainingDeployPresence;
  /** Present only when `presence === 'unknown'` — never a credential value, only a path-shaped explanation. */
  readonly reason?: string;
  /** The exact, copy-pasteable `macf fleet deploy` invocation for this role. */
  readonly command: string;
}

/** {@link computeRemainingDeploy}'s full return — the per-agent steps plus the one-time (not per-agent) `--vault` precondition note. */
export interface RemainingDeployReport {
  readonly steps: readonly RemainingDeployStep[];
  /** See {@link vaultLocationNote}'s doc. `undefined` whenever `steps` is empty (nothing to precede) OR `flags.vaultPath` was given (the operator already supplied their own vault path — nothing to add). */
  readonly vaultLocationNote?: string;
}

/** One `<role>: <PATH>` line's remedy command — never a credential value (only paths + the role name ever appear). */
function buildDeployCommand(manifestPath: string, role: string, flags: DeployFlagsEcho): string {
  const parts = ['macf', 'fleet', 'deploy', '--agent', role, '-f', manifestPath];
  if (flags.vaultPath !== undefined) {
    parts.push('--vault', flags.vaultPath);
  }
  parts.push('--identity-key', flags.identityKeyPath ?? DEPLOY_IDENTITY_KEY_PLACEHOLDER);
  return parts.join(' ');
}

/**
 * The other-host guidance, shown once ahead of the per-agent lines when
 * `apply` was not given `--vault`. A VM that runs agents has no GitHub login
 * of its own, so it cannot clone the private control repo; the operator
 * copies `fleet.yaml` and `secrets/vault.age` over instead.
 */
function vaultLocationNote(): string {
  return (
    'On the host that will run it, put copies of the control repo\'s fleet.yaml and secrets/vault.age side ' +
    'by side as DIR/fleet.yaml and DIR/secrets/vault.age (for example with scp from a clone on this ' +
    'machine), then run:\n' +
    "      macf fleet deploy --agent ROLE -f DIR/fleet.yaml --identity-key PATH_TO_YOUR_AGE_IDENTITY_KEY"
  );
}

/**
 * Which declared agents have no local workspace yet, and the exact
 * `macf fleet deploy` command for each (requirement 1). `steps` is `[]` —
 * never anything else — when every agent's `deploy_path` already exists
 * (requirement 5: no nagging on a complete fleet); `vaultLocationNote` is
 * `undefined` in that same case (nothing to precede). `exists` defaults to a
 * real `existsSync`; tests inject a fake so the decisive scenarios don't
 * depend on real host filesystem state (mirrors
 * `findAvailableRecoveryArtifacts`'s own injectable-`exists` seam in
 * `commands/bootstrap-apply.ts`).
 */
export function computeRemainingDeploy(
  manifest: FleetManifest,
  manifestPath: string,
  flags: DeployFlagsEcho,
  exists: (path: string) => boolean = existsSync,
): RemainingDeployReport {
  const steps: RemainingDeployStep[] = [];
  for (const agent of manifest.agents) {
    const deployPath = resolvePath(agent.deploy_path);
    if (exists(deployPath)) continue;

    const parent = dirname(deployPath);
    const presence: RemainingDeployPresence = exists(parent) ? 'not-deployed' : 'unknown';
    const command = buildDeployCommand(manifestPath, agent.role, flags);

    steps.push({
      role: agent.role,
      deployPath,
      presence,
      ...(presence === 'unknown'
        ? {
            reason:
              `parent directory ${parent} does not exist on this host — deploy_path may belong to a ` +
              'different host in a multi-host fleet; absence cannot be confirmed from here (honest-unknown ' +
              'floor).',
          }
        : {}),
      command,
    });
  }
  return {
    steps,
    ...(steps.length > 0 && flags.vaultPath === undefined ? { vaultLocationNote: vaultLocationNote() } : {}),
  };
}

/**
 * Human render (requirement 1 + 5). An empty `report.steps` renders NO lines
 * at all — same "silent when nothing applies, never an empty-state
 * confirmation line" convention `plan.ts::formatRegistryScopeLines`
 * established for macf#999 (verified against that function + its
 * `formatPlanText` call site: BOTH text and `--json` stay silent for the
 * steady state, not just `--json`) — appending a "nothing remains" banner
 * every run would itself be the nagging requirement 5 rules out.
 */
export function formatRemainingDeployLines(report: RemainingDeployReport): readonly string[] {
  if (report.steps.length === 0) return [];
  // groundnuty/macf#1184 — dropped the bare "the fleet is provisioned" claim
  // (the operator's own correction: "I wouldn't be so bold to say that the
  // fleet is provisioned. The fleet is defined on GitHub and not yet
  // functional.") "apply succeeded at its own job" is UNCHANGED — #1184
  // explicitly protects that phrase; only the umbrella word next to it was
  // the over-reach.
  const lines: string[] = [
    `⚠ ${String(report.steps.length)} declared agent(s) have no local workspace yet — this fleet's GitHub-side ` +
      'resources are defined, but it is NOT running. apply succeeded at its own job; deploy each agent to bring ' +
      'the fleet up:',
  ];
  if (report.vaultLocationNote !== undefined) {
    lines.push(`  ⚠ ${report.vaultLocationNote}`);
  }
  for (const step of report.steps) {
    lines.push(
      step.presence === 'unknown'
        ? `  • ${step.role}: UNKNOWN whether deployed — ${step.deployPath} is not resolvable on this host (${String(step.reason)})`
        : `  • ${step.role}: NOT DEPLOYED — no workspace at ${step.deployPath} on this host`,
    );
    lines.push(`      ${step.command}`);
  }
  return lines;
}
