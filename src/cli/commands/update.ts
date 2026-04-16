/**
 * macf update: read version pins from macf-agent.json, fetch latest available
 * for each component, show a diff, and bump selected pins.
 *
 * Replaces the earlier plugin-update placeholder (P4). With PR #4 adding
 * version pins, this command is the canonical bumper.
 */
import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import { readAgentConfig, writeAgentConfig, tokenSourceFromConfig } from '../config.js';
import { resolveLatestVersions } from '../version-resolver.js';
import { copyCanonicalRules, copyCanonicalScripts } from '../rules.js';
import { fetchPluginToWorkspace, workspacePluginDir } from '../plugin-fetcher.js';
import { writeClaudeSh } from '../claude-sh.js';
import { createClientFromConfig } from '../registry-helper.js';
import { generateToken } from '../../token.js';
import { promptPassword, PromptCancelled } from '../prompt.js';
import { migrateCaKeyToV2, formatMigrationResult } from './migrate-ca-key.js';
import type { VersionPins } from '../config.js';
import type { ResolvedVersions } from '../version-resolver.js';

export interface UpdateOptions {
  readonly all: boolean;
  readonly cli: boolean;
  readonly plugin: boolean;
  readonly actions: boolean;
  readonly yes: boolean;
  readonly dryRun: boolean;
}

type Component = 'cli' | 'plugin' | 'actions';
const ALL_COMPONENTS: readonly Component[] = ['cli', 'plugin', 'actions'];

function prompt(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

interface DiffRow {
  readonly component: Component;
  readonly current: string;
  readonly latest: string;
  // Mirror the FetchStatus variants for non-ok paths so operators
  // see the actual reason (not yet published vs network down vs
  // malformed response) — not_published was noise for normal
  // pre-release state when conflated with fetch_failed (#111 C2).
  readonly status: 'update' | 'same' | 'not_published' | 'network_error' | 'invalid_response';
}

export function buildDiff(
  current: VersionPins,
  resolved: ResolvedVersions,
): readonly DiffRow[] {
  return ALL_COMPONENTS.map(component => {
    const cur = current[component];
    const lat = resolved.versions[component];
    const source = resolved.sources[component];
    if (source !== 'ok') {
      return { component, current: cur, latest: lat, status: source };
    }
    return {
      component,
      current: cur,
      latest: lat,
      status: cur === lat ? ('same' as const) : ('update' as const),
    };
  });
}

/**
 * Does the .macf/plugin/ dir need a re-fetch? True if the dir doesn't
 * exist OR exists but is empty. `existsSync` alone returns true for an
 * empty dir, which misses the repair case (e.g. workspaces init'd before
 * #60 merged where the directory was created but never populated).
 */
function pluginDirNeedsRepair(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).length === 0;
}

function formatRow(row: DiffRow): string {
  const name = row.component.padEnd(10);
  const cur = row.current.padEnd(10);
  const lat = row.latest.padEnd(10);
  let statusText: string;
  switch (row.status) {
    case 'update': statusText = '⬆ update available'; break;
    case 'same': statusText = '✓ up to date'; break;
    // Distinct messages for each failure mode so operators don't
    // chase phantom network issues when the component simply hasn't
    // been published yet (#111 C2).
    case 'not_published': statusText = '· not yet published (using cached)'; break;
    case 'network_error': statusText = '? fetch failed (network) — using cached'; break;
    case 'invalid_response': statusText = '? unexpected response — using cached'; break;
  }
  return `${name}  ${cur}  ${lat}  ${statusText}`;
}

export function renderDiff(diff: readonly DiffRow[]): string {
  const lines: string[] = [];
  lines.push('Component   Current     Latest      Status');
  lines.push('----------  ----------  ----------  --------');
  for (const row of diff) lines.push(formatRow(row));
  return lines.join('\n');
}

function selectedComponents(opts: UpdateOptions): readonly Component[] {
  if (opts.all) return ALL_COMPONENTS;
  const selected: Component[] = [];
  if (opts.cli) selected.push('cli');
  if (opts.plugin) selected.push('plugin');
  if (opts.actions) selected.push('actions');
  return selected;
}

async function confirmBump(row: DiffRow, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  const answer = await prompt(
    `Update ${row.component} from ${row.current} to ${row.latest}? [y/N]: `,
  );
  return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
}

/**
 * Main entry. Returns exit code (0 success/noop, 1 failure).
 */
export async function update(
  projectDir: string,
  opts: UpdateOptions,
): Promise<number> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return 1;
  }

  // Refresh canonical assets (coordination rules + helper scripts) on
  // every `macf update`, regardless of version-pin state. These are tied
  // to the installed CLI binary, not to `versions.cli` in the config —
  // so a newer CLI version always wins, even when pins are unchanged.
  // Running before any short-circuit also repairs workspaces created
  // before these assets existed (otherwise they'd never get coordination.md
  // unless the user happened to bump a pin). See #52 follow-up.
  const refreshedRules = copyCanonicalRules(projectDir);
  if (refreshedRules.length > 0) {
    console.log(`Refreshed ${refreshedRules.length} canonical rule file(s) in .claude/rules/`);
  }
  const refreshedScripts = copyCanonicalScripts(projectDir);
  if (refreshedScripts.length > 0) {
    console.log(`Refreshed ${refreshedScripts.length} helper script(s) in .claude/scripts/`);
  }

  // Regenerate claude.sh unconditionally — the launcher template changes
  // over time (e.g., #60 added --plugin-dir) and workspaces need those
  // changes without having to re-run `macf init` from scratch. The
  // generated file carries a managed-file header warning users not to
  // edit it. See #63. Doesn't depend on config.versions, so it runs even
  // for legacy configs (before the error-exit for missing versions).
  writeClaudeSh(projectDir, config);
  console.log(`Refreshed claude.sh from current launcher template`);

  // DR-011 rev2 auto-migrate: check for legacy v1 CA key backup and
  // upgrade it to v2 (JSON envelope at 600k iters) if found. One-time
  // per project, silent no-op if already v2 or no backup exists.
  // Failures here do NOT block `macf update` — the migration is
  // independent of version bumps and the v1 blob stays decryptable
  // via the read-compat path. See #115.
  try {
    const token = await generateToken(tokenSourceFromConfig(projectDir, config));
    const client = createClientFromConfig(config.registry, token);
    const result = await migrateCaKeyToV2({
      project: config.project,
      client,
      prompt: async (message) => {
        try {
          return await promptPassword({ message });
        } catch (err) {
          if (err instanceof PromptCancelled) {
            return '';
          }
          throw err;
        }
      },
    });
    const summary = formatMigrationResult(result, config.project);
    if (summary) console.log(summary);
  } catch (err) {
    // Don't block update on migration failure (token/network/etc.).
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: CA key migration check failed: ${msg}`);
  }

  // Repair-case plugin fetch: if .macf/plugin/ is absent or empty, fetch
  // the currently-pinned version regardless of whether anything is being
  // bumped. Runs before every short-circuit so workspaces init'd before
  // #60 merged (empty .macf/plugin/) don't require `rm -rf + macf update`
  // to self-heal. See #62. We skip this if config.versions is missing —
  // legacy configs are handled by the error path below.
  if (config.versions && pluginDirNeedsRepair(workspacePluginDir(projectDir))) {
    try {
      fetchPluginToWorkspace(projectDir, config.versions.plugin);
      console.log(`Repaired .macf/plugin/ with macf-agent@v${config.versions.plugin}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: plugin repair fetch failed: ${msg}`);
    }
  }

  if (!config.versions) {
    console.error(
      'No "versions" section in macf-agent.json (legacy config).\n' +
      'Run `macf init --force` to migrate with resolved version pins.',
    );
    return 1;
  }

  console.log('Fetching latest versions...');
  const resolved = await resolveLatestVersions();

  const diff = buildDiff(config.versions, resolved);
  console.log('');
  console.log(renderDiff(diff));
  console.log('');

  // Exit 1 if every fetch failed (no current info to compare against).
  // Any non-'update' / non-'same' status counts as failed-to-fetch here.
  const FAIL_STATES: readonly DiffRow['status'][] = ['not_published', 'network_error', 'invalid_response'];
  const allFailed = diff.every(r => FAIL_STATES.includes(r.status));
  if (allFailed) {
    console.error('Error: could not fetch latest versions for any component. Network down?');
    return 1;
  }

  // Determine which components are candidates for bump.
  const explicitSelection = selectedComponents(opts);
  const candidates = diff.filter(row => {
    if (row.status !== 'update') return false;
    if (explicitSelection.length > 0) return explicitSelection.includes(row.component);
    return true;
  });

  if (candidates.length === 0) {
    console.log('Everything is up to date.');
    return 0;
  }

  // Ask per candidate (or auto-accept with --yes / --all / --<component>).
  const autoYes = opts.yes || opts.all || explicitSelection.length > 0;
  const toBump: DiffRow[] = [];
  for (const row of candidates) {
    if (await confirmBump(row, autoYes)) {
      toBump.push(row);
    }
  }

  if (toBump.length === 0) {
    console.log('No changes. Exiting.');
    return 0;
  }

  // Build new versions object.
  const newVersions: VersionPins = {
    cli: config.versions.cli,
    plugin: config.versions.plugin,
    actions: config.versions.actions,
  };
  for (const row of toBump) {
    (newVersions as { [k in Component]: string })[row.component] = row.latest;
  }

  if (opts.dryRun) {
    console.log('\n[dry-run] Would update:');
    for (const row of toBump) {
      console.log(`  ${row.component}: ${row.current} → ${row.latest}`);
    }
    return 0;
  }

  writeAgentConfig(projectDir, { ...config, versions: newVersions });

  // Re-fetch the plugin when versions.plugin was bumped. The separate
  // repair-case fetch runs earlier (before short-circuits) for empty/
  // missing dirs; this block handles the pin-bump case specifically.
  const pluginBumped = toBump.some(r => r.component === 'plugin');
  if (pluginBumped) {
    try {
      fetchPluginToWorkspace(projectDir, newVersions.plugin);
      console.log(`Refreshed .macf/plugin/ to macf-agent@v${newVersions.plugin}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: plugin re-fetch failed: ${msg}`);
    }
  }

  console.log('\nUpdated:');
  for (const row of toBump) {
    console.log(`  ✓ ${row.component}: ${row.current} → ${row.latest}`);
  }
  console.log('\nWritten to .macf/macf-agent.json.');
  return 0;
}
