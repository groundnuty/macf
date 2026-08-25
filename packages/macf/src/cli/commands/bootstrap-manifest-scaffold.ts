/**
 * `macf bootstrap manifest scaffold` CLI entry point (groundnuty/macf#1153).
 *
 * READ-ONLY end to end. Wires `manifest-scaffold.ts`'s pure-ish
 * `scaffoldManifest` into a `--json`-safe command: parse `--agent role=repo`
 * specs, run the observation, render to stdout (and optionally to a LOCAL
 * file via `--out` — never a repo; committing is `bootstrap control-repo
 * init`'s job, deliberately a different command per groundnuty/macf#1152).
 * Same `RunXOptions` / `Deps` / single `run*` shape `commands/bootstrap.ts`
 * / `commands/bootstrap-status.ts` already establish.
 */
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { FLEET_NAME_RE } from '../bootstrap/fleet-manifest.js';
import type { ManifestScaffoldDeps, ManifestScaffoldInput, ScaffoldAgentInput } from '../bootstrap/manifest-scaffold.js';
import { MANIFEST_SCAFFOLD_AUDIT_TABLE, REAL_MANIFEST_SCAFFOLD_DEPS, SCAFFOLD_LIMIT_STATEMENT, scaffoldManifest } from '../bootstrap/manifest-scaffold.js';
import { checkVaultFlagsComplete } from '../bootstrap/plan.js';

export interface RunManifestScaffoldOptions {
  readonly owner: string;
  readonly fleet: string;
  /** Raw `role=owner/repo` strings, one per `--agent` occurrence — parsed by {@link parseAgentSpec}. */
  readonly agent: readonly string[];
  readonly json?: boolean;
  /** LOCAL filesystem path only — never a repo path, never a `gh` write. */
  readonly out?: string;
  readonly vaultPath?: string;
  readonly identityKeyPath?: string;
}

/** One parsed `--agent role=owner/repo` spec. */
export function parseAgentSpec(raw: string): ScaffoldAgentInput | undefined {
  const idx = raw.indexOf('=');
  if (idx <= 0 || idx === raw.length - 1) return undefined;
  const role = raw.slice(0, idx).trim();
  const repo = raw.slice(idx + 1).trim();
  if (role.length === 0 || repo.length === 0 || !repo.includes('/')) return undefined;
  return { role, repo };
}

function renderFailure(message: string, opts: { readonly json?: boolean }): number {
  // Same macf#830 lesson every other bootstrap command follows: plain-text
  // to stderr ALWAYS; under --json ALSO a non-empty JSON {error} object to
  // stdout — never empty-stdout+exit-0, never empty-stdout+exit-nonzero.
  console.error(message);
  if (opts.json) {
    console.log(JSON.stringify({ error: { message } }, null, 2));
  }
  return 1;
}

/**
 * Validates + collects `--agent` specs. Returns either the parsed list or a
 * failure message naming the FIRST malformed spec — aggregate-fail would be
 * nicer but this option is typically small (one fleet's agent count), and a
 * single clear pointer is enough.
 */
function collectAgents(raw: readonly string[]): { readonly agents: readonly ScaffoldAgentInput[] } | { readonly error: string } {
  if (raw.length === 0) {
    return {
      error:
        'at least one --agent role=owner/repo is required — this command cannot discover role<->repo bindings on ' +
        'its own (enumerating an App installation\'s repos needs an install token this credential-free tool never ' +
        'holds); see --help.',
    };
  }
  const agents: ScaffoldAgentInput[] = [];
  for (const spec of raw) {
    const parsed = parseAgentSpec(spec);
    if (parsed === undefined) {
      return { error: `--agent "${spec}" is not of the form role=owner/repo` };
    }
    agents.push(parsed);
  }
  return { agents };
}

function renderText(yaml: string, todoCount: number, schemaIssuePaths: readonly string[], outPath: string | undefined): void {
  console.log(yaml);
  console.log('');
  console.log(SCAFFOLD_LIMIT_STATEMENT);
  console.log('');
  console.log(`TODO count: ${String(todoCount)}`);
  if (schemaIssuePaths.length > 0) {
    console.log(
      `This draft does NOT yet validate against FleetManifestSchema — ${String(schemaIssuePaths.length)} required ` +
        `field(s) still need a human decision: ${schemaIssuePaths.join(', ')}`,
    );
    console.log(
      'This list is ONLY the required fields still missing — cross-field checks (a duplicate role between two ' +
        'agents, a role already carrying the fleet-name prefix, a routing label mismatch) do not run while any ' +
        'required field is still empty, so they are not covered by this list. Read the draft, not just this count.',
    );
  } else {
    console.log('This draft validates against FleetManifestSchema as written — well-formedness only, review every field before committing.');
  }
  if (outPath !== undefined) {
    console.log(`Wrote draft to ${outPath} (local file only — nothing was written to any repo).`);
  }
}

/**
 * `macf bootstrap manifest scaffold --owner <org> --fleet <name> --agent
 * <role>=<owner/repo> [--agent ...] [--json] [--out <path>] [--vault <path>
 * --identity-key <path>]` entry point. READ-ONLY end to end: every read
 * goes through {@link ManifestScaffoldDeps}; the only local mutation is an
 * OPTIONAL write to `--out`, a plain local file — never `gh`, never `git
 * push`, never any repo.
 *
 * Returns the shell exit code. NEVER exits the process directly — every
 * failure path is caught and rendered via {@link renderFailure}.
 */
export async function runManifestScaffold(
  opts: RunManifestScaffoldOptions,
  deps: ManifestScaffoldDeps = REAL_MANIFEST_SCAFFOLD_DEPS,
): Promise<number> {
  const vaultFlagsFailure = checkVaultFlagsComplete(opts.vaultPath, opts.identityKeyPath);
  if (vaultFlagsFailure !== undefined) {
    return renderFailure(vaultFlagsFailure.message, opts);
  }

  if (!FLEET_NAME_RE.test(opts.fleet)) {
    return renderFailure(`--fleet "${opts.fleet}" is not lowercase kebab-case (^[a-z0-9][a-z0-9-]*$)`, opts);
  }

  const collected = collectAgents(opts.agent);
  if ('error' in collected) {
    return renderFailure(collected.error, opts);
  }

  const input: ManifestScaffoldInput = { owner: opts.owner, fleetName: opts.fleet, agents: collected.agents };
  const vault =
    opts.vaultPath !== undefined && opts.identityKeyPath !== undefined
      ? { vaultPath: opts.vaultPath, identityKeyPath: opts.identityKeyPath }
      : undefined;

  try {
    const result = await scaffoldManifest(input, deps, vault);

    const outPath = opts.out !== undefined ? resolvePath(opts.out) : undefined;
    if (outPath !== undefined) {
      writeFileSync(outPath, result.yaml, 'utf-8');
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            yaml: result.yaml,
            todo_count: result.todoCount,
            todos: result.todos,
            schema_issue_paths: result.schemaIssuePaths,
            limit_statement: SCAFFOLD_LIMIT_STATEMENT,
            audit_table: MANIFEST_SCAFFOLD_AUDIT_TABLE,
            ...(outPath !== undefined ? { wrote_to: outPath } : {}),
          },
          null,
          2,
        ),
      );
    } else {
      renderText(result.yaml, result.todoCount, result.schemaIssuePaths, outPath);
    }
    return 0;
  } catch (err) {
    return renderFailure(err instanceof Error ? err.message : String(err), opts);
  }
}
