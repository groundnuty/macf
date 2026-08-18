/**
 * `macf fleet deploy` CLI entry point — wires `bootstrap/fleet-deploy.ts`'s
 * `deployAgent` into a `--json`-safe command (macf#830 lesson: `--json`
 * always emits a valid, non-empty JSON object on stdout, even on failure).
 * See that module's doc for the full design; this file is presentation only
 * — manifest loading, the `--identity-key`/`--vault` flag resolution, the
 * agent-role lookup, and rendering (including the post-deploy "next step"
 * message, which deliberately never implies the agent is already running).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { FleetManifest } from '../bootstrap/fleet-manifest.js';
import { parseFleetManifest } from '../bootstrap/fleet-manifest.js';
import type { FleetDeployDeps, FleetDeployOutcome } from '../bootstrap/fleet-deploy.js';
import { deployAgent, realAuthenticatedCloneRepo, realMintCloneToken } from '../bootstrap/fleet-deploy.js';
import { readVault } from '../bootstrap/vault-read.js';
import { initAgent as realInitAgent } from './init.js';
import { caCertPath } from '../config.js';

export const FLEET_DEPLOY_JSON_SCHEMA_VERSION = 1;

export interface RunFleetDeployOptions {
  readonly file: string;
  readonly agent: string;
  /** Path to secrets/vault.age. Optional — defaults to `<dirname(file)>/secrets/vault.age` (the control-repo layout DR-043 Amendment F establishes: `fleet.yaml`/`fleet.lock`/`secrets/vault.age` are committed side by side — see `control-repo.ts`'s `CONTROL_REPO_COMMIT_ALLOWLIST`). Give explicitly when the vault isn't at that conventional location. */
  readonly vault?: string;
  /** age identity (private key) file to decrypt --vault with. REQUIRED — unlike --vault, no default exists anywhere in this codebase for an age identity path (`bootstrap destroy --age-identity` doesn't default one either); a wrong guess here would be a much worse failure mode than refusing. */
  readonly identityKey?: string;
  /** Workspace directory. Defaults to the agent's `deploy_path` from the manifest. */
  readonly dir?: string;
  /**
   * Re-materialize the on-disk App key from the vault when it does NOT
   * match (fingerprint mismatch) — the common case after a fleet rebuild
   * (macf#975). Without this, a mismatch REFUSES rather than silently
   * overwriting a key the operator may have rotated deliberately on GitHub.
   * Threaded straight through to {@link FleetDeployDeps.forceKey}.
   */
  readonly forceKey?: boolean;
  readonly json?: boolean;
}

/** Injectable seam so tests drive the command without touching the network / a real operator key / a real `macf init` run. */
export interface FleetDeployCommandDeps extends FleetDeployDeps {
  /**
   * Confirms a per-project CA is materialized locally — steers the
   * post-deploy "next step" message ONLY (never gates `deploy` itself;
   * `initAgent` already degrades gracefully — a warning, not a failure —
   * when no CA is present). Defaults to a real `existsSync(caCertPath(project))`
   * check. CA materialization is explicitly OUT OF SCOPE for this command
   * (see the PR/report for the reasoning) — this hook exists so the
   * operator-facing message is honest about that gap rather than silently
   * implying a cert-bearing, launch-ready workspace.
   */
  readonly checkCaPresent?: (project: string) => boolean;
}

interface DeployFailure {
  readonly code: string;
  readonly message: string;
}

function failureToJson(failure: DeployFailure): unknown {
  return { schema_version: FLEET_DEPLOY_JSON_SCHEMA_VERSION, error: failure };
}

function renderFailure(failure: DeployFailure, opts: RunFleetDeployOptions): number {
  console.error(failure.message);
  if (opts.json) {
    console.log(JSON.stringify(failureToJson(failure), null, 2));
  }
  return 1;
}

type ManifestLoad = { readonly manifestPath: string; readonly manifest: FleetManifest };

function loadManifest(opts: RunFleetDeployOptions): ManifestLoad | DeployFailure {
  const manifestPath = resolvePath(opts.file);
  if (!existsSync(manifestPath)) {
    return { code: 'manifest_not_found', message: `fleet manifest not found: ${manifestPath}` };
  }
  try {
    return { manifestPath, manifest: parseFleetManifest(readFileSync(manifestPath, 'utf-8')) };
  } catch (err) {
    return {
      code: 'manifest_invalid',
      message: `fleet manifest failed validation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function isFailure(x: ManifestLoad | DeployFailure): x is DeployFailure {
  return 'code' in x;
}

function resolveDeps(): FleetDeployCommandDeps {
  return {
    readVault,
    cloneRepo: realAuthenticatedCloneRepo,
    initAgent: realInitAgent,
    mintCloneToken: realMintCloneToken,
    checkCaPresent: (project) => existsSync(caCertPath(project)),
  };
}

function outcomeToJson(outcome: FleetDeployOutcome): unknown {
  switch (outcome.status) {
    case 'deployed':
      return {
        role: outcome.role,
        status: outcome.status,
        app_id: outcome.appId,
        install_id: outcome.installId,
        workspace: outcome.workspace,
        key_path: outcome.keyPath,
        key_write: outcome.keyWrite,
        key_fingerprint: outcome.keyFingerprint,
      };
    case 'failed':
      return { role: outcome.role, status: outcome.status, reason: outcome.reason };
  }
}

/**
 * The post-deploy operator-facing "what now" block. Requirement 5's whole
 * point: never imply the agent is already running. When no per-project CA
 * is materialized locally (out of `deploy`'s scope — see module doc), say so
 * explicitly and name the missing prerequisite BEFORE the launch command,
 * rather than printing a bare `./claude.sh` over a workspace with no mTLS
 * cert.
 */
function nextStepLines(manifest: FleetManifest, destDir: string, deps: FleetDeployCommandDeps): readonly string[] {
  const checkCaPresent = deps.checkCaPresent ?? ((project: string) => existsSync(caCertPath(project)));
  const caPresent = checkCaPresent(manifest.metadata.name);
  const lines: string[] = ['', `Workspace materialized at ${destDir} — the agent is NOT running yet.`];
  if (!caPresent) {
    lines.push(
      `⚠ No per-project CA found locally for fleet "${manifest.metadata.name}" — this workspace has no mTLS cert yet ` +
        '(CA materialization is out of scope for `fleet deploy`; obtain it from the fleet vault or an already-deployed ' +
        'agent host, then run):',
      `  macf certs rotate --dir ${destDir}`,
    );
  }
  lines.push(`Next step: cd ${destDir} && ./claude.sh`);
  return lines;
}

/**
 * `macf fleet deploy --agent <role> -f fleet.yaml --identity-key <path>
 * [--vault <path>] [--dir <workspace>] [--json]`. Returns the shell exit
 * code (0 on `status: 'deployed'`). NEVER exits the process directly.
 */
export async function runFleetDeploy(opts: RunFleetDeployOptions, deps?: FleetDeployCommandDeps): Promise<number> {
  // --identity-key has no default anywhere in this codebase (unlike
  // --vault, whose default is the control-repo layout below) — refuse loud
  // rather than guess at a private-key path. This single check covers BOTH
  // reachable "incomplete" states: neither flag given, and --vault given
  // without --identity-key. (--identity-key given alone is NOT incomplete —
  // --vault legitimately defaults; see the field doc above.)
  if (opts.identityKey === undefined) {
    return renderFailure(
      {
        code: 'vault_flags_incomplete',
        message:
          '--identity-key is required for `fleet deploy` (no vault-free mode exists — deploy materializes real ' +
          `credentials)${opts.vault !== undefined ? '; --vault alone is not enough' : ''}. Supply --identity-key ` +
          '(and --vault, only if the vault is not at the default <fleet.yaml dir>/secrets/vault.age).',
      },
      opts,
    );
  }

  const loaded = loadManifest(opts);
  if (isFailure(loaded)) return renderFailure(loaded, opts);
  const { manifestPath, manifest } = loaded;

  const agent = manifest.agents.find((a) => a.role === opts.agent);
  if (agent === undefined) {
    return renderFailure(
      {
        code: 'unknown_agent_role',
        message:
          `no agent with role "${opts.agent}" in fleet "${manifest.metadata.name}" — known roles: ` +
          `${manifest.agents.map((a) => a.role).join(', ') || '(none)'}.`,
      },
      opts,
    );
  }

  const vaultPath = opts.vault !== undefined ? resolvePath(opts.vault) : join(dirname(manifestPath), 'secrets', 'vault.age');
  const identityPath = resolvePath(opts.identityKey);
  const destDir = opts.dir !== undefined ? resolvePath(opts.dir) : resolvePath(agent.deploy_path);

  const resolved = deps ?? resolveDeps();
  process.stderr.write(`Deploying role "${agent.role}" for fleet "${manifest.metadata.name}" — vault: ${vaultPath}\n`);

  // --force-key (opts) wins when given; otherwise fall back to whatever the
  // resolved deps already carry (lets a test drive `deps.forceKey` directly
  // without going through the CLI-options layer at all).
  const outcome = await deployAgent(agent, manifest, destDir, { vaultPath, identityPath }, {
    ...resolved,
    forceKey: opts.forceKey ?? resolved.forceKey,
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        { schema_version: FLEET_DEPLOY_JSON_SCHEMA_VERSION, fleet: manifest.metadata.name, outcome: outcomeToJson(outcome) },
        null,
        2,
      ),
    );
  } else if (outcome.status === 'deployed') {
    console.log(
      `Role "${outcome.role}" deployed: app_id=${outcome.appId} install_id=${outcome.installId}\n` +
        `  Workspace: ${outcome.workspace === 'cloned' ? 'cloned' : 'already present (not re-cloned)'} at ${destDir}\n` +
        `  Key: ${outcome.keyPath} (${outcome.keyWrite === 'written' ? 'materialized' : 'already present, not overwritten'}, ` +
        `fingerprint ${outcome.keyFingerprint})`,
    );
    console.log(nextStepLines(manifest, destDir, resolved).join('\n'));
  } else {
    console.error(`Role "${outcome.role}" FAILED — ${outcome.reason}`);
  }

  return outcome.status === 'deployed' ? 0 : 1;
}
